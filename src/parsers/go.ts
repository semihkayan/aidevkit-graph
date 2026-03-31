import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";

function getDocComment(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const idx = parent.children.indexOf(node);
  const comments: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const s = parent.children[i];
    if (s.type === "comment" && s.text.startsWith("//")) {
      comments.unshift(s.text.replace(/^\/\/\s?/, ""));
    } else break;
  }
  return comments.length > 0 ? comments.join("\n").trim() : null;
}

function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];

  // Regular functions
  for (const node of walkNodes(rootNode, ["function_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    const result = node.childForFieldName("result")?.text;
    results.push({
      name,
      kind: "function",
      signature: result ? `${name}${params} ${result}` : `${name}${params}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: name[0] === name[0].toUpperCase() ? "public" : "private",
      isAsync: false,
      docstring: getDocComment(node) || undefined,
    });
  }

  // Methods (method_declaration has receiver)
  for (const node of walkNodes(rootNode, ["method_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    const receiver = node.childForFieldName("receiver")?.text || "";
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    const result = node.childForFieldName("result")?.text;
    // Extract receiver type
    // Extract receiver type: "(s *Server)" → "Server"
    const receiverMatch = receiver.match(/\*?(\w+)\s*\)/);
    const receiverType = receiverMatch?.[1] || "";
    const fullName = receiverType ? `${receiverType}.${name}` : name;
    results.push({
      name: fullName,
      kind: "method",
      signature: result ? `${name}${params} ${result}` : `${name}${params}`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: name[0] === name[0].toUpperCase() ? "public" : "private",
      isAsync: false,
      docstring: getDocComment(node) || undefined,
    });
  }

  // Structs
  for (const node of walkNodes(rootNode, ["type_declaration"])) {
    const spec = node.children.find((c: SyntaxNode) => c.type === "type_spec");
    if (!spec) continue;
    const name = spec.childForFieldName("name")?.text;
    const typeNode = spec.childForFieldName("type");
    if (!name || typeNode?.type !== "struct_type") continue;
    results.push({
      name,
      kind: "class",
      signature: `type ${name} struct`,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      visibility: name[0] === name[0].toUpperCase() ? "public" : "private",
      isAsync: false,
      docstring: getDocComment(node) || undefined,
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
    } else if (func.type === "selector_expression") {
      const obj = func.childForFieldName("operand");
      const field = func.childForFieldName("field");
      if (field) results.push({ name: field.text, objectName: obj?.text, line: row });
    }
  }
  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];
  for (const node of walkNodes(rootNode, ["import_declaration"])) {
    for (const spec of walkNodes(node, ["import_spec"])) {
      const pathNode = spec.childForFieldName("path");
      if (pathNode) {
        const modulePath = pathNode.text.replace(/"/g, "");
        const name = modulePath.split("/").pop() || modulePath;
        results.push({ importedName: name, modulePath, isDefault: false });
      }
    }
  }
  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];
  // Go has implicit interfaces — no explicit implements/extends
  for (const node of walkNodes(rootNode, ["type_declaration"])) {
    const spec = node.children.find((c: SyntaxNode) => c.type === "type_spec");
    if (!spec) continue;
    const name = spec.childForFieldName("name")?.text;
    if (!name) continue;
    const typeNode = spec.childForFieldName("type");
    const kind = typeNode?.type === "interface_type" ? "interface" as const : "struct" as const;
    results.push({
      className: name, kind, implements: [], extends: [], usesTypes: [],
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  return results;
}

export const goConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-go"),
  extensions: [".go"],
  extractFunctions, extractCalls, extractImports, extractDocstring: getDocComment, extractTypeRelationships,

  testImportPrefixes: ["testing", "github.com/stretchr/testify"],
  noiseTargets: [
    "fmt.Println", "fmt.Printf", "fmt.Sprintf", "fmt.Errorf", "fmt.Fprintf",
    "errors.New", "errors.Is", "errors.As", "errors.Unwrap",
    "context.Background", "context.TODO", "context.WithCancel", "context.WithTimeout",
    "strings.Contains", "strings.HasPrefix", "strings.HasSuffix", "strings.TrimSpace",
    "strings.Split", "strings.Join", "strings.Replace", "strings.ToLower", "strings.ToUpper",
    "strconv.Itoa", "strconv.Atoi", "strconv.FormatInt", "strconv.ParseInt",
    "filepath.Join", "filepath.Dir", "filepath.Base", "filepath.Ext",
    "sync.WaitGroup", "sync.Mutex", "sync.Once",
    "log.Println", "log.Printf", "log.Fatal", "log.Fatalf",
    "math.Max", "math.Min", "math.Abs",
  ],
  builtinMethods: [
    "Error", "String", "Close", "Read", "Write", "Len", "Cap",
    "Lock", "Unlock", "RLock", "RUnlock", "Wait", "Signal", "Broadcast",
    "Done", "Err", "Value", "Deadline",
  ],
  noisePatterns: [
    /^(fmt|errors|context|strings|strconv|filepath|sync|log|math|sort|io|bytes|os|time|reflect|regexp|testing|net|http|encoding)\.\w+$/,
  ],

  // Language conventions
  selfKeywords: [],
  constructorNames: [],
  workspaceManifests: ["go.mod"],
};
