import { createRequire } from "node:module";
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship, StructuralHints } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";

const require = createRequire(import.meta.url);


function getDocstring(node: SyntaxNode): string | null {
  // Python docstring: first statement in body is expression_statement > string
  const body = node.childForFieldName("body");
  if (!body || body.childCount === 0) return null;
  const firstStmt = body.children[0];
  if (firstStmt?.type !== "expression_statement") return null;
  const strNode = firstStmt.children[0];
  if (strNode?.type !== "string") return null;
  const text = strNode.text as string;
  return text.replace(/^("""|''')\n?/, "").replace(/\n?("""|''')$/, "").trim();
}

function getDecorators(node: SyntaxNode): string[] {
  // decorated_definition wraps function_definition
  const parent = node.parent;
  if (parent?.type !== "decorated_definition") return [];
  return parent.children
    .filter((c: SyntaxNode) => c.type === "decorator")
    .map((c: SyntaxNode) => c.text as string);
}

function buildSignature(node: SyntaxNode): string {
  const name = node.childForFieldName("name")?.text || "";
  const params = node.childForFieldName("parameters")?.text || "()";
  const retType = node.childForFieldName("return_type");
  return retType ? `${name}${params} -> ${retType.text}` : `${name}${params}`;
}

function isAsync(node: SyntaxNode): boolean {
  // Check if "async" keyword precedes "def"
  for (let i = 0; i < node.childCount; i++) {
    const child = node.children[i];
    if (child.type === "async") return true;
    if (child.type === "def") break;
  }
  return false;
}

function getVisibility(name: string): "public" | "private" | "protected" {
  if (name.startsWith("__") && !name.endsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return "public";
}


function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];
  const funcNodes = walkNodes(rootNode, ["function_definition"]);

  for (const node of funcNodes) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;

    // Determine if method (inside class body)
    // Walk up: function_definition → block → class_definition (normal)
    // Or: function_definition → decorated_definition → block → class_definition (decorated)
    const classParent = findParent(node, "class_definition");
    const isMethod = classParent !== null;
    const className = isMethod
      ? classParent.childForFieldName("name")?.text
      : null;

    // Detect structural hints from decorators
    const decorators = getDecorators(node);
    const hints: StructuralHints = {};
    if (decorators.some(d => d === "@property" || d.endsWith(".setter"))) {
      hints.propertyAccess = true;
    }
    if (decorators.some(d => d === "@abstractmethod")) hints.isAbstract = true;
    if (name === "__init__") hints.isConstructor = true;

    results.push({
      name: className ? `${className}.${name}` : name,
      kind: isMethod ? "method" : "function",
      signature: buildSignature(node),
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(name),
      isAsync: isAsync(node),
      decorators,
      docstring: getDocstring(node) || undefined,
      structuralHints: Object.keys(hints).length > 0 ? hints : undefined,
    });
  }

  // Classes themselves
  const classNodes = walkNodes(rootNode, ["class_definition"]);
  for (const node of classNodes) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const bases = node.childForFieldName("superclasses");
    const inherits = bases
      ? bases.children.filter((c: SyntaxNode) => c.type === "identifier").map((c: SyntaxNode) => c.text as string)
      : [];
    const methods = walkNodes(node, ["function_definition"])
      .map((fn: SyntaxNode) => fn.childForFieldName("name")?.text)
      .filter(Boolean) as string[];

    results.push({
      name,
      kind: "class",
      signature: `class ${name}${inherits.length > 0 ? `(${inherits.join(", ")})` : ""}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(name),
      isAsync: false,
      docstring: getDocstring(node) || undefined,
      classInfo: { inherits, methods },
    });
  }

  return results;
}

function extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[] {
  const results: RawCallInfo[] = [];
  const callNodes = walkNodes(rootNode, ["call"]);

  for (const node of callNodes) {
    const row = node.startPosition.row + 1;
    if (row < lineStart || row > lineEnd) continue;

    const func = node.childForFieldName("function");
    if (!func) continue;

    if (func.type === "identifier") {
      results.push({ name: func.text, line: row });
    } else if (func.type === "attribute") {
      const obj = func.childForFieldName("object");
      const attr = func.childForFieldName("attribute");
      if (attr) {
        results.push({
          name: attr.text,
          objectName: obj?.text,
          line: row,
        });
      }
    }
  }

  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.children[i];

    if (node.type === "import_statement") {
      // import logging
      const name = node.childForFieldName("name");
      if (name) {
        results.push({
          importedName: name.text,
          modulePath: name.text,
          isDefault: true,
        });
      }
    } else if (node.type === "import_from_statement") {
      // from payments.stripe_client import charge
      const moduleName = node.childForFieldName("module_name");
      const modulePath = moduleName?.text || "";

      // Imported names
      for (let j = 0; j < node.childCount; j++) {
        const child = node.children[j];
        if (child.type === "dotted_name" && child !== moduleName) {
          results.push({
            importedName: child.text,
            modulePath,
            isDefault: false,
          });
        } else if (child.type === "aliased_import") {
          const origName = child.childForFieldName("name");
          results.push({
            importedName: origName?.text || child.text,
            modulePath,
            isDefault: false,
          });
        }
      }
    }
  }

  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];
  const classNodes = walkNodes(rootNode, ["class_definition"]);

  for (const node of classNodes) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;

    const bases = node.childForFieldName("superclasses");
    const extendsArr: string[] = [];
    if (bases) {
      for (let i = 0; i < bases.childCount; i++) {
        const child = bases.children[i];
        if (child.type === "identifier") extendsArr.push(child.text);
      }
    }

    // Extract type hints from method signatures
    const usesTypes: string[] = [];
    const methods = walkNodes(node, ["function_definition"]);
    for (const method of methods) {
      const params = method.childForFieldName("parameters");
      if (params) {
        const typeNodes = walkNodes(params, ["type"]);
        for (const t of typeNodes) {
          const typeName = t.text?.trim();
          if (typeName && !["str", "int", "float", "bool", "None", "list", "dict", "tuple", "set"].includes(typeName)) {
            if (!usesTypes.includes(typeName)) usesTypes.push(typeName);
          }
        }
      }
      const retType = method.childForFieldName("return_type");
      if (retType) {
        const typeName = retType.text?.trim();
        if (typeName && !["str", "int", "float", "bool", "None", "list", "dict", "tuple", "set"].includes(typeName)) {
          if (!usesTypes.includes(typeName)) usesTypes.push(typeName);
        }
      }
    }

    results.push({
      className: name,
      kind: "class",
      implements: [],  // Python has no explicit implements
      extends: extendsArr,
      usesTypes,
      filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  return results;
}

export const pythonConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-python"),
  extensions: [".py"],
  extractFunctions,
  extractCalls,
  extractImports,
  extractDocstring: getDocstring,
  extractTypeRelationships,
};
