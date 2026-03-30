import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";



function getJavadoc(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const idx = parent.children.indexOf(node);
  for (let i = idx - 1; i >= 0; i--) {
    const s = parent.children[i];
    if (s.type === "block_comment" && s.text.startsWith("/**")) {
      let doc = s.text
        .replace(/^\/\*\*\s*\n?/, "")
        .replace(/\n?\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
      // Convert Javadoc tags to our format for better embedding
      doc = doc
        .replace(/@param\s+(\w+)\s+/g, "Parameter $1: ")
        .replace(/@return\s+/g, "Returns: ")
        .replace(/@throws\s+(\w+)\s+/g, "Throws $1: ")
        .replace(/@see\s+/g, "See: ");
      return doc;
    }
    if (s.type !== "block_comment" && s.type !== "line_comment") break;
  }
  return null;
}

function getAnnotations(node: SyntaxNode): string[] | undefined {
  for (let i = 0; i < node.childCount; i++) {
    if (node.children[i].type === "modifiers") {
      const annotations = node.children[i].children
        .filter((c: SyntaxNode) => c.type === "marker_annotation" || c.type === "annotation")
        .map((c: SyntaxNode) => c.text as string);
      return annotations.length > 0 ? annotations : undefined;
    }
  }
  return undefined;
}

function getVisibility(node: SyntaxNode): "public" | "private" | "protected" {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.children[i];
    if (c.type === "modifiers") {
      if (c.text.includes("private")) return "private";
      if (c.text.includes("protected")) return "protected";
      if (c.text.includes("public")) return "public";
    }
  }
  return "public"; // Java default package-private → treat as public
}

function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];

  // Methods
  for (const node of walkNodes(rootNode, ["method_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    const retType = node.childForFieldName("type")?.text || "void";

    // Parent class
    const classNode = findParent(node, "class_declaration");
    const className = classNode?.childForFieldName("name")?.text;
    const fullName = className ? `${className}.${name}` : name;

    results.push({
      name: fullName,
      kind: "method",
      signature: `${retType} ${name}${params}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node),
      isAsync: false,
      docstring: getJavadoc(node) || undefined,
      decorators: getAnnotations(node),
    });
  }

  // Constructors
  for (const node of walkNodes(rootNode, ["constructor_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    results.push({
      name: `${name}.constructor`,
      kind: "method",
      signature: `${name}${params}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node),
      isAsync: false,
      docstring: getJavadoc(node) || undefined,
      decorators: getAnnotations(node),
    });
  }

  // Classes
  for (const node of walkNodes(rootNode, ["class_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const superclass = node.childForFieldName("superclass");
    const interfaces = node.childForFieldName("interfaces");
    const inherits: string[] = [];
    if (superclass) inherits.push(...walkNodes(superclass, ["type_identifier"]).map((t: SyntaxNode) => t.text));
    if (interfaces) inherits.push(...walkNodes(interfaces, ["type_identifier"]).map((t: SyntaxNode) => t.text));
    // Only direct methods (not from nested classes)
    const body = node.childForFieldName("body");
    const methods = body ? body.children
      .filter((c: SyntaxNode) => c.type === "method_declaration")
      .map((m: SyntaxNode) => m.childForFieldName("name")?.text)
      .filter(Boolean) as string[] : [];

    results.push({
      name, kind: "class",
      signature: `class ${name}${inherits.length > 0 ? ` extends/implements ${inherits.join(", ")}` : ""}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync: false,
      docstring: getJavadoc(node) || undefined,
      classInfo: { inherits, methods },
      decorators: getAnnotations(node),
    });
  }

  return results;
}


function extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[] {
  const results: RawCallInfo[] = [];
  for (const node of walkNodes(rootNode, ["method_invocation"])) {
    const row = node.startPosition.row + 1;
    if (row < lineStart || row > lineEnd) continue;
    const obj = node.childForFieldName("object");
    const name = node.childForFieldName("name");
    if (name) results.push({ name: name.text, objectName: obj?.text, line: row });
  }
  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];
  for (const node of walkNodes(rootNode, ["import_declaration"])) {
    const path = walkNodes(node, ["scoped_identifier"]);
    if (path.length > 0) {
      const fullPath = path[0].text;
      const name = fullPath.split(".").pop() || fullPath;
      results.push({ importedName: name, modulePath: fullPath, isDefault: false });
    }
  }
  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];
  for (const node of walkNodes(rootNode, ["class_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const superclass = node.childForFieldName("superclass");
    const interfaces = node.childForFieldName("interfaces");
    const ext: string[] = superclass ? walkNodes(superclass, ["type_identifier"]).map((t: SyntaxNode) => t.text) : [];
    const impl: string[] = interfaces ? walkNodes(interfaces, ["type_identifier"]).map((t: SyntaxNode) => t.text) : [];
    results.push({
      className: name, kind: "class", implements: impl, extends: ext, usesTypes: [],
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  for (const node of walkNodes(rootNode, ["interface_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    results.push({
      className: name, kind: "interface", implements: [], extends: [], usesTypes: [],
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  return results;
}

export const javaConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-java"),
  extensions: [".java"],
  extractFunctions, extractCalls, extractImports, extractDocstring: getJavadoc, extractTypeRelationships,
};
