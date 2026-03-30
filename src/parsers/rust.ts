import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";



function getRustAttributes(node: SyntaxNode): string[] | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const idx = parent.children.indexOf(node);
  const attrs: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const s = parent.children[i];
    if (s.type === "attribute_item") {
      attrs.unshift(s.text as string);
    } else if (s.type === "line_comment") {
      continue; // Skip doc comments between attributes
    } else break;
  }
  return attrs.length > 0 ? attrs : undefined;
}

function getDocComment(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const idx = parent.children.indexOf(node);
  const comments: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const s = parent.children[i];
    if (s.type === "line_comment" && s.text.startsWith("///")) {
      comments.unshift(s.text.replace(/^\/\/\/\s?/, ""));
    } else break;
  }
  return comments.length > 0 ? comments.join("\n").trim() : null;
}

function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];

  for (const node of walkNodes(rootNode, ["function_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    const retType = node.childForFieldName("return_type")?.text;
    const isPublic = node.children.some((c: SyntaxNode) => c.type === "visibility_modifier");

    // Check if inside impl block
    const implParent = findParent(node, "impl_item");
    const implType = implParent?.childForFieldName("type")?.text;
    const fullName = implType ? `${implType}.${name}` : name;

    results.push({
      name: fullName,
      kind: implType ? "method" : "function",
      signature: retType ? `fn ${name}${params} -> ${retType}` : `fn ${name}${params}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: isPublic ? "public" : "private",
      isAsync: node.children.some((c: SyntaxNode) => c.type === "async"),
      docstring: getDocComment(node) || undefined,
      decorators: getRustAttributes(node),
    });
  }

  // Structs + Enums
  for (const node of walkNodes(rootNode, ["struct_item", "enum_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    results.push({
      name,
      kind: "class",
      signature: `${node.type === "struct_item" ? "struct" : "enum"} ${name}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: node.children.some((c: SyntaxNode) => c.type === "visibility_modifier") ? "public" : "private",
      isAsync: false,
      docstring: getDocComment(node) || undefined,
      decorators: getRustAttributes(node),
      classInfo: { inherits: [], methods: [] },
    });
  }

  return results;
}


function extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[] {
  const results: RawCallInfo[] = [];
  for (const node of walkNodes(rootNode, ["call_expression"])) {
    const row = node.startPosition.row + 1;
    if (row < lineStart || row > lineEnd) continue;
    const func = node.childForFieldName("function");
    if (!func) continue;
    if (func.type === "identifier") {
      results.push({ name: func.text, line: row });
    } else if (func.type === "field_expression") {
      const obj = func.childForFieldName("value");
      const field = func.childForFieldName("field");
      if (field) results.push({ name: field.text, objectName: obj?.text, line: row });
    } else if (func.type === "scoped_identifier") {
      results.push({ name: func.text, line: row });
    }
  }
  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];
  for (const node of walkNodes(rootNode, ["use_declaration"])) {
    const arg = node.children.find((c: SyntaxNode) => c.type !== "use" && c.type !== ";");
    if (arg) {
      const path = arg.text;
      const name = path.split("::").pop() || path;
      results.push({ importedName: name, modulePath: path, isDefault: false });
    }
  }
  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];

  // impl Trait for Struct
  for (const node of walkNodes(rootNode, ["impl_item"])) {
    const traitNode = node.childForFieldName("trait");
    const typeNode = node.childForFieldName("type");
    if (traitNode && typeNode) {
      results.push({
        className: typeNode.text,
        kind: "struct",
        implements: [traitNode.text],
        extends: [],
        usesTypes: [],
        filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
    }
  }

  return results;
}

export const rustConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-rust"),
  extensions: [".rs"],
  extractFunctions, extractCalls, extractImports, extractDocstring: getDocComment, extractTypeRelationships,
};
