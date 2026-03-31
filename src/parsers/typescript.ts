import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship, StructuralHints } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";



function getTsDecorators(node: SyntaxNode): string[] | undefined {
  // Class decorators: direct children of class_declaration
  if (node.type === "class_declaration") {
    const decorators = node.children
      .filter((c: SyntaxNode) => c.type === "decorator")
      .map((c: SyntaxNode) => c.text as string);
    return decorators.length > 0 ? decorators : undefined;
  }
  // Method/property decorators: preceding siblings in class_body
  const parent = node.parent;
  if (!parent) return undefined;
  const idx = parent.children.indexOf(node);
  const decorators: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    if (parent.children[i].type === "decorator") {
      decorators.unshift(parent.children[i].text as string);
    } else break;
  }
  return decorators.length > 0 ? decorators : undefined;
}

function getJSDoc(node: SyntaxNode): string | null {
  // JSDoc is a comment sibling BEFORE the function/class node
  const parent = node.parent;
  if (!parent) return null;

  const idx = parent.children.indexOf(node);
  // Look at previous sibling
  for (let i = idx - 1; i >= 0; i--) {
    const sibling = parent.children[i];
    if (sibling.type === "comment" && sibling.text.startsWith("/**")) {
      return sibling.text
        .replace(/^\/\*\*\s*\n?/, "")
        .replace(/\n?\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
    }
    // Stop if we hit a non-comment node
    if (sibling.type !== "comment") break;
  }
  return null;
}

function getVisibility(node: SyntaxNode): "public" | "private" | "protected" {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.children[i];
    if (child.type === "accessibility_modifier") {
      const text = child.text;
      if (text === "private") return "private";
      if (text === "protected") return "protected";
    }
  }
  // Check name convention
  const name = node.childForFieldName("name")?.text ||
               node.children.find((c: SyntaxNode) => c.type === "property_identifier")?.text;
  if (name?.startsWith("_")) return "private";
  return "public";
}

function isAsync(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.children[i].type === "async") return true;
  }
  return false;
}

function getReturnType(node: SyntaxNode): string | null {
  const typeAnnotation = node.children?.find((c: SyntaxNode) => c.type === "type_annotation");
  if (!typeAnnotation) return null;
  // Skip the ":"
  for (let i = 0; i < typeAnnotation.childCount; i++) {
    const child = typeAnnotation.children[i];
    if (child.type !== ":") return child.text;
  }
  return null;
}

function getParams(node: SyntaxNode): string {
  const params = node.children?.find((c: SyntaxNode) => c.type === "formal_parameters");
  return params?.text || "()";
}

function extractParamTypes(node: SyntaxNode): Array<{ name: string; type: string }> | undefined {
  const params = node.children?.find((c: SyntaxNode) => c.type === "formal_parameters");
  if (!params) return undefined;
  const result: Array<{ name: string; type: string }> = [];
  for (let i = 0; i < params.childCount; i++) {
    const param = params.children[i];
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
    const name = param.children.find((c: SyntaxNode) => c.type === "identifier")?.text;
    const typeAnn = param.children.find((c: SyntaxNode) => c.type === "type_annotation");
    const typeName = typeAnn?.children.find((c: SyntaxNode) => c.type !== ":" && c.type !== "?")?.text;
    if (name && typeName) result.push({ name, type: typeName });
  }
  return result.length > 0 ? result : undefined;
}

function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];

  // Regular functions (including exported)
  const funcDecls = walkNodes(rootNode, ["function_declaration"]);
  for (const node of funcDecls) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;

    const isExported = node.parent?.type === "export_statement";
    const docNode = isExported ? node.parent : node;
    results.push({
      name,
      kind: "function",
      signature: buildSignature(name, getParams(node), getReturnType(node)),
      lineStart: (docNode).startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: isExported ? "public" : "private",
      isAsync: isAsync(node),
      docstring: getJSDoc(docNode) || undefined,
      decorators: getTsDecorators(docNode),
      paramTypes: extractParamTypes(node),
    });
  }

  // Arrow functions: const name = (...) => { ... }
  // Also: factory-created hooks/components: const useStore = create<T>()((set) => {...})
  // Only module-level declarations — skip those nested inside function bodies.
  // A module-level lexical_declaration's parent is either "program" or "export_statement".
  const lexDecls = walkNodes(rootNode, ["lexical_declaration"])
    .filter(node => {
      const parentType = node.parent?.type;
      return parentType === "program" || parentType === "export_statement";
    });
  for (const decl of lexDecls) {
    // Direct children only — don't recurse into arrow function bodies
    const declarators = decl.children.filter((c: SyntaxNode) => c.type === "variable_declarator");
    for (const vd of declarators) {
      const nameNode = vd.childForFieldName("name");
      const valueNode = vd.childForFieldName("value");
      if (!nameNode || !valueNode) continue;

      const name = nameNode.text;
      const isExported = decl.parent?.type === "export_statement";
      const outerNode = isExported ? decl.parent : decl;

      if (valueNode.type === "arrow_function") {
        // Direct arrow function: const name = (...) => { ... }
        results.push({
          name,
          kind: "function",
          signature: buildSignature(name, getParams(valueNode), getReturnType(valueNode)),
          lineStart: outerNode.startPosition.row + 1,
          lineEnd: decl.endPosition.row + 1,
          visibility: isExported ? "public" : "private",
          isAsync: isAsync(valueNode),
          docstring: getJSDoc(outerNode) || undefined,
          paramTypes: extractParamTypes(valueNode),
        });
      } else if (valueNode.type === "call_expression" && isExported) {
        // Factory-created function: const useStore = create<T>()((set) => {...})
        // Covers: zustand stores, React.memo, forwardRef, styled-components, etc.
        // Only exported declarations — unexported call results are usually not callable.
        results.push({
          name,
          kind: "function",
          signature: `${name}()`,
          lineStart: outerNode.startPosition.row + 1,
          lineEnd: decl.endPosition.row + 1,
          visibility: "public",
          isAsync: false,
          docstring: getJSDoc(outerNode) || undefined,
        });
      }
    }
  }

  // Class methods
  const classDeclNodes = walkNodes(rootNode, ["class_declaration"]);
  for (const classNode of classDeclNodes) {
    const className = classNode.childForFieldName("name")?.text ||
                      classNode.children.find((c: SyntaxNode) => c.type === "type_identifier")?.text;
    if (!className) continue;

    // Heritage
    const heritage = classNode.children.find((c: SyntaxNode) => c.type === "class_heritage");
    const implementsList: string[] = [];
    const extendsList: string[] = [];
    if (heritage) {
      for (let i = 0; i < heritage.childCount; i++) {
        const clause = heritage.children[i];
        if (clause.type === "implements_clause") {
          const types = walkNodes(clause, ["type_identifier"]);
          implementsList.push(...types.map((t: SyntaxNode) => t.text));
        } else if (clause.type === "extends_clause") {
          const types = walkNodes(clause, ["type_identifier", "identifier"]);
          extendsList.push(...types.map((t: SyntaxNode) => t.text));
        }
      }
    }

    // Methods
    const body = classNode.children.find((c: SyntaxNode) => c.type === "class_body");
    if (!body) continue;

    const methodNames: string[] = [];
    const methods = walkNodes(body, ["method_definition"]);
    for (const method of methods) {
      const methodName = method.children.find((c: SyntaxNode) => c.type === "property_identifier")?.text;
      if (!methodName) continue;
      methodNames.push(methodName);

      const fullName = `${className}.${methodName}`;

      // Detect structural hints from AST
      const hints: StructuralHints = {};
      if (method.children.some((c: SyntaxNode) => c.type === "get" || c.type === "set")) {
        hints.propertyAccess = true;
      }
      if (methodName === "constructor") hints.isConstructor = true;
      if (method.children.some((c: SyntaxNode) => c.type === "abstract")) hints.isAbstract = true;

      results.push({
        name: fullName,
        kind: "method",
        signature: buildSignature(methodName, getParams(method), getReturnType(method)),
        lineStart: method.startPosition.row + 1,
        lineEnd: method.endPosition.row + 1,
        visibility: getVisibility(method),
        isAsync: isAsync(method),
        docstring: getJSDoc(method) || undefined,
        decorators: getTsDecorators(method),
        paramTypes: extractParamTypes(method),
        structuralHints: Object.keys(hints).length > 0 ? hints : undefined,
      });
    }

    // Class record
    const classOuterNode = classNode.parent?.type === "export_statement" ? classNode.parent : classNode;
    results.push({
      name: className,
      kind: "class",
      signature: `class ${className}${extendsList.length > 0 ? ` extends ${extendsList.join(", ")}` : ""}${implementsList.length > 0 ? ` implements ${implementsList.join(", ")}` : ""}`,
      lineStart: classOuterNode.startPosition.row + 1,
      lineEnd: classNode.endPosition.row + 1,
      visibility: "public",
      isAsync: false,
      docstring: getJSDoc(classOuterNode) || undefined,
      decorators: getTsDecorators(classNode),
      classInfo: { inherits: [...extendsList, ...implementsList], methods: methodNames },
    });
  }

  // Interface declarations — extract as records so they appear in the file index
  // and type graph can parse their member types from the file
  const interfaceNodes = walkNodes(rootNode, ["interface_declaration"]);
  for (const iface of interfaceNodes) {
    const name = iface.children.find((c: SyntaxNode) => c.type === "type_identifier")?.text;
    if (!name) continue;

    const isExported = iface.parent?.type === "export_statement";
    const outerNode = isExported ? iface.parent : iface;
    results.push({
      name,
      kind: "interface",
      signature: `interface ${name}`,
      lineStart: outerNode.startPosition.row + 1,
      lineEnd: iface.endPosition.row + 1,
      visibility: isExported ? "public" : "private",
      isAsync: false,
      docstring: getJSDoc(outerNode) || undefined,
    });
  }

  return results;
}

function extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[] {
  const results: RawCallInfo[] = [];
  const callNodes = walkNodes(rootNode, ["call_expression"]);

  for (const node of callNodes) {
    const row = node.startPosition.row + 1;
    if (row < lineStart || row > lineEnd) continue;

    const func = node.childForFieldName("function");
    if (!func) continue;

    if (func.type === "identifier") {
      results.push({ name: func.text, line: row });
    } else if (func.type === "member_expression") {
      const obj = func.childForFieldName("object");
      const prop = func.childForFieldName("property");
      if (prop) {
        results.push({ name: prop.text, objectName: obj?.text, line: row });
      }
    }
  }

  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];
  const importNodes = walkNodes(rootNode, ["import_statement"]);

  for (const node of importNodes) {
    const sourceNode = node.children.find((c: SyntaxNode) => c.type === "string");
    const modulePath = sourceNode?.text?.replace(/['"]/g, "") || "";

    const importClause = node.children.find((c: SyntaxNode) => c.type === "import_clause");
    if (!importClause) continue;

    for (let i = 0; i < importClause.childCount; i++) {
      const child = importClause.children[i];

      if (child.type === "identifier") {
        // Default import: import Foo from './foo'
        results.push({ importedName: child.text, modulePath, isDefault: true });
      } else if (child.type === "named_imports") {
        // Named imports: import { Foo, Bar } from './foo'
        const specifiers = walkNodes(child, ["import_specifier"]);
        for (const spec of specifiers) {
          const nameNode = spec.childForFieldName("name");
          results.push({ importedName: nameNode?.text || spec.text, modulePath, isDefault: false });
        }
      } else if (child.type === "namespace_import") {
        // Namespace: import * as Foo from './foo'
        const name = child.children.find((c: SyntaxNode) => c.type === "identifier");
        if (name) results.push({ importedName: name.text, modulePath, isDefault: false });
      }
    }
  }

  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];

  // Classes
  const classNodes = walkNodes(rootNode, ["class_declaration"]);
  for (const node of classNodes) {
    const name = node.children.find((c: SyntaxNode) => c.type === "type_identifier")?.text;
    if (!name) continue;

    const implementsList: string[] = [];
    const extendsList: string[] = [];
    const heritage = node.children.find((c: SyntaxNode) => c.type === "class_heritage");
    if (heritage) {
      for (let i = 0; i < heritage.childCount; i++) {
        const clause = heritage.children[i];
        if (clause.type === "implements_clause") {
          implementsList.push(...walkNodes(clause, ["type_identifier"]).map((t: SyntaxNode) => t.text));
        } else if (clause.type === "extends_clause") {
          extendsList.push(...walkNodes(clause, ["type_identifier", "identifier"]).map((t: SyntaxNode) => t.text));
        }
      }
    }

    // Collect type usages from method signatures
    const usesTypes: string[] = [];
    const methods = walkNodes(node, ["method_definition"]);
    for (const method of methods) {
      const typeAnnotations = walkNodes(method, ["type_annotation"]);
      for (const ta of typeAnnotations) {
        const typeIds = walkNodes(ta, ["type_identifier"]);
        for (const tid of typeIds) {
          const t = tid.text;
          if (!["string", "number", "boolean", "void", "any", "never", "unknown", "null", "undefined"].includes(t)) {
            if (!usesTypes.includes(t)) usesTypes.push(t);
          }
        }
      }
    }

    // Extract constructor field types (private/readonly params become class fields)
    const members: Array<{ name: string; type: string }> = [];
    for (const method of methods) {
      const methodName = method.children.find((c: SyntaxNode) => c.type === "property_identifier")?.text;
      if (methodName !== "constructor") continue;
      const params = method.children.find((c: SyntaxNode) => c.type === "formal_parameters");
      if (!params) continue;
      for (let i = 0; i < params.childCount; i++) {
        const param = params.children[i];
        if (param.type !== "required_parameter") continue;
        // Only params with accessibility_modifier (private/public/protected) or readonly become fields
        const hasAccessor = param.children.some((c: SyntaxNode) =>
          c.type === "accessibility_modifier" || c.text === "readonly"
        );
        if (!hasAccessor) continue;
        const paramName = param.children.find((c: SyntaxNode) => c.type === "identifier")?.text;
        const typeAnn = param.children.find((c: SyntaxNode) => c.type === "type_annotation");
        const typeName = typeAnn?.children.find((c: SyntaxNode) => c.type !== ":")?.text;
        if (paramName && typeName) members.push({ name: paramName, type: typeName });
      }
    }

    results.push({
      className: name,
      kind: "class",
      implements: implementsList,
      extends: extendsList,
      usesTypes,
      members: members.length > 0 ? members : undefined,
      filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  // Interfaces
  const interfaceNodes = walkNodes(rootNode, ["interface_declaration"]);
  for (const node of interfaceNodes) {
    const name = node.children.find((c: SyntaxNode) => c.type === "type_identifier")?.text;
    if (!name) continue;

    // Extract interface property types
    const members: Array<{ name: string; type: string }> = [];
    const ifaceBody = node.children.find((c: SyntaxNode) =>
      c.type === "interface_body" || c.type === "object_type"
    );
    if (ifaceBody) {
      for (let i = 0; i < ifaceBody.childCount; i++) {
        const child = ifaceBody.children[i];
        if (child.type === "property_signature") {
          const propName = child.children.find((c: SyntaxNode) => c.type === "property_identifier")?.text;
          const typeAnn = child.children.find((c: SyntaxNode) => c.type === "type_annotation");
          const typeName = typeAnn?.children.find((c: SyntaxNode) => c.type !== ":")?.text;
          if (propName && typeName) members.push({ name: propName, type: typeName });
        } else if (child.type === "method_signature") {
          const methodName = child.children.find((c: SyntaxNode) => c.type === "property_identifier")?.text;
          // For methods, the "type" is the return type (useful for chaining resolution)
          const typeAnn = child.children.find((c: SyntaxNode) => c.type === "type_annotation");
          const retType = typeAnn?.children.find((c: SyntaxNode) => c.type !== ":")?.text;
          if (methodName && retType) members.push({ name: methodName, type: retType });
        }
      }
    }

    results.push({
      className: name,
      kind: "interface",
      implements: [],
      extends: [],
      usesTypes: [],
      members: members.length > 0 ? members : undefined,
      filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  return results;
}

function buildSignature(name: string, params: string, returnType: string | null): string {
  return returnType ? `${name}${params}: ${returnType}` : `${name}${params}`;
}

export const typescriptConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-typescript").typescript,
  extensions: [".ts"],
  extractFunctions,
  extractCalls,
  extractImports,
  extractDocstring: getJSDoc,
  extractTypeRelationships,
};

export const tsxConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-typescript").tsx,
  extensions: [".tsx"],
  extractFunctions,
  extractCalls,
  extractImports,
  extractDocstring: getJSDoc,
  extractTypeRelationships,
};
