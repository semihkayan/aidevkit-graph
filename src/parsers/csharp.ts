import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship, StructuralHints } from "../types/index.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";
import { walkNodes, findParent, type SyntaxNode } from "./ast-utils.js";



function getXmlDoc(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const idx = parent.children.indexOf(node);
  const comments: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const s = parent.children[i];
    if (s.type === "comment" && s.text.startsWith("///")) {
      comments.unshift(s.text.replace(/^\/\/\/\s?/, ""));
    } else break;
  }
  if (comments.length === 0) return null;
  return comments.join("\n")
    .replace(/<\/?summary>/g, "")
    .replace(/<param name="[^"]*">/g, "@param ")
    .replace(/<\/param>/g, "")
    .replace(/<returns>/g, "@returns ")
    .replace(/<\/returns>/g, "")
    .replace(/<\/?[^>]+>/g, "")
    .trim();
}

function getAttributes(node: SyntaxNode): string[] | undefined {
  const attrs = node.children
    .filter((c: SyntaxNode) => c.type === "attribute_list")
    .flatMap((al: SyntaxNode) => al.children
      .filter((c: SyntaxNode) => c.type === "attribute")
      .map((c: SyntaxNode) => `@${c.text}`));
  return attrs.length > 0 ? attrs : undefined;
}

function getVisibility(node: SyntaxNode): "public" | "private" | "protected" {
  for (let i = 0; i < node.childCount; i++) {
    const text = node.children[i].text;
    if (text === "private") return "private";
    if (text === "protected") return "protected";
    if (text === "public") return "public";
  }
  return "private"; // C# default is private
}

function extractFunctions(rootNode: SyntaxNode, _filePath: string): RawFunctionInfo[] {
  const results: RawFunctionInfo[] = [];

  // Methods
  for (const node of walkNodes(rootNode, ["method_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    const retType = node.childForFieldName("type")?.text || "void";
    const classNode = findParent(node, "class_declaration") || findParent(node, "struct_declaration");
    const className = classNode?.childForFieldName("name")?.text;
    const fullName = className ? `${className}.${name}` : name;
    const isAsync = node.children.some((c: SyntaxNode) => c.text === "async");

    const isAbstract = node.children.some((c: SyntaxNode) => c.type === "modifier" && c.text === "abstract");

    results.push({
      name: fullName, kind: "method",
      signature: `${retType} ${name}${params}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync,
      docstring: getXmlDoc(node) || undefined,
      decorators: getAttributes(node),
      structuralHints: isAbstract ? { isAbstract: true } : undefined,
    });
  }

  // Constructors
  for (const node of walkNodes(rootNode, ["constructor_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const params = node.childForFieldName("parameters")?.text || "()";
    results.push({
      name: `${name}.constructor`, kind: "method",
      signature: `${name}${params}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync: false,
      docstring: getXmlDoc(node) || undefined,
      decorators: getAttributes(node),
      structuralHints: { isConstructor: true },
    });
  }

  // Classes, structs, interfaces, records
  for (const node of walkNodes(rootNode, ["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const basesNode = node.children.find((c: SyntaxNode) => c.type === "base_list");
    const inherits: string[] = basesNode
      ? walkNodes(basesNode, ["identifier", "generic_name"]).map((t: SyntaxNode) => t.text)
      : [];
    // FunctionRecord.kind only supports "function" | "method" | "class"
    // But we use "class" for all type declarations — the actual type distinction
    // is captured in TypeGraphManager via extractTypeRelationships
    const kind = "class" as const;
    const methods = walkNodes(node, ["method_declaration"])
      .map((m: SyntaxNode) => m.childForFieldName("name")?.text).filter(Boolean) as string[];

    results.push({
      name, kind,
      signature: `${node.type.replace("_declaration", "")} ${name}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync: false,
      docstring: getXmlDoc(node) || undefined,
      decorators: getAttributes(node),
      classInfo: { inherits, methods },
    });
  }

  return results;
}


function extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[] {
  const results: RawCallInfo[] = [];
  for (const node of walkNodes(rootNode, ["invocation_expression"])) {
    const row = node.startPosition.row + 1;
    if (row < lineStart || row > lineEnd) continue;
    const func = node.childForFieldName("function");
    if (!func) continue;
    if (func.type === "identifier") {
      results.push({ name: func.text, line: row });
    } else if (func.type === "member_access_expression") {
      const obj = func.childForFieldName("expression");
      const name = func.childForFieldName("name");
      if (name) results.push({ name: name.text, objectName: obj?.text, line: row });
    }
  }
  return results;
}

function extractImports(rootNode: SyntaxNode, _filePath: string): RawImportInfo[] {
  const results: RawImportInfo[] = [];
  for (const node of walkNodes(rootNode, ["using_directive"])) {
    const ns = walkNodes(node, ["qualified_name", "identifier"]);
    if (ns.length > 0) {
      const fullPath = ns[0].text;
      const name = fullPath.split(".").pop() || fullPath;
      results.push({ importedName: name, modulePath: fullPath, isDefault: false });
    }
  }
  return results;
}

function extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[] {
  const results: RawTypeRelationship[] = [];
  for (const node of walkNodes(rootNode, ["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    // base_list may not have a field name — find by type
    const bases = node.children.find((c: SyntaxNode) => c.type === "base_list");
    const allBases = bases ? walkNodes(bases, ["identifier", "generic_name"]).map((t: SyntaxNode) => t.text) : [];
    // C# convention: interfaces start with I
    const impl = allBases.filter(b => b.startsWith("I") && b[1] === b[1]?.toUpperCase());
    const ext = allBases.filter(b => !impl.includes(b));
    const kind = node.type === "interface_declaration" ? "interface" as const :
                 node.type === "record_declaration" ? "record" as const : "class" as const;
    results.push({
      className: name, kind, implements: impl, extends: ext, usesTypes: [],
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  return results;
}

export const csharpConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-c-sharp"),
  extensions: [".cs"],
  extractFunctions, extractCalls, extractImports, extractDocstring: getXmlDoc, extractTypeRelationships,

  testDecorators: ["@[Test]", "@[TestMethod]", "@[Fact]", "@[Theory]", "@[TestFixture]", "@[SetUp]", "@[TearDown]"],
  testImportPrefixes: ["NUnit", "Xunit", "Microsoft.VisualStudio.TestTools", "Moq", "FluentAssertions"],
  noiseTargets: [
    "Console.WriteLine", "Console.Write", "Console.ReadLine",
    "Convert.ToInt32", "Convert.ToString", "Convert.ToDouble",
    "Guid.NewGuid", "Guid.Parse", "Guid.Empty",
    "DateTime.Now", "DateTime.UtcNow", "DateTime.Parse", "DateTime.TryParse",
    "TimeSpan.FromSeconds", "TimeSpan.FromMinutes", "TimeSpan.FromHours",
    "Task.Run", "Task.WhenAll", "Task.WhenAny", "Task.FromResult", "Task.CompletedTask",
    "string.IsNullOrEmpty", "string.IsNullOrWhiteSpace", "string.Join", "string.Format",
    "Path.Combine", "Path.GetExtension", "Path.GetFileName",
    "File.ReadAllText", "File.WriteAllText", "File.Exists",
    "Enum.Parse", "Enum.TryParse",
  ],
  builtinMethods: [
    "Any", "All", "Where", "Select", "SelectMany", "FirstOrDefault", "First",
    "SingleOrDefault", "Single", "Count", "Sum", "Average", "OrderBy", "OrderByDescending",
    "GroupBy", "Distinct", "Skip", "Take", "ToArray",
    "Add", "Remove", "Contains", "ContainsKey", "TryGetValue",
    "Append", "Insert", "RemoveAt", "AddRange",
    "GetAwaiter", "GetResult", "ConfigureAwait",
    "Dispose",
  ],
  noisePatterns: [
    /^(Console|Convert|Guid|DateTime|DateTimeOffset|TimeSpan|Task|Math|Enum|Path|File|Directory|Regex|StringBuilder|Activator|GC|Monitor|Interlocked|CancellationToken|JsonSerializer|Environment)\.\w+$/,
  ],

  // Language conventions
  selfKeywords: ["this"],
  constructorNames: ["constructor"],
  workspaceManifestExtensions: [".csproj", ".sln"],
};
