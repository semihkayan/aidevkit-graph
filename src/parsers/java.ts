import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import path from "node:path";
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship, StructuralHints } from "../types/index.js";
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

const JAVA_PRIMITIVE_TYPES = new Set([
  "int", "long", "double", "float", "boolean", "byte", "char", "short", "void",
  "String", "Integer", "Long", "Double", "Float", "Boolean", "Byte", "Character", "Short",
  "Object", "Void", "Number",
]);

function extractPrimaryTypeName(typeNode: SyntaxNode): string {
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type") {
    const primary = typeNode.children.find((c: SyntaxNode) => c.type === "type_identifier");
    if (primary) return primary.text;
  }
  if (typeNode.type === "array_type") {
    const element = typeNode.childForFieldName("element") || typeNode.children[0];
    if (element) return extractPrimaryTypeName(element);
  }
  return typeNode.text;
}

function extractParamTypes(node: SyntaxNode): Array<{ name: string; type: string }> | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  const result: Array<{ name: string; type: string }> = [];
  for (let i = 0; i < params.childCount; i++) {
    const param = params.children[i];
    if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
    const typeNode = param.childForFieldName("type");
    const nameNode = param.childForFieldName("name");
    if (typeNode && nameNode) {
      result.push({ name: nameNode.text, type: extractPrimaryTypeName(typeNode) });
    }
  }
  return result.length > 0 ? result : undefined;
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

    // Parent class or interface
    const classNode = findParent(node, "class_declaration") || findParent(node, "interface_declaration");
    const className = classNode?.childForFieldName("name")?.text;
    const fullName = className ? `${className}.${name}` : name;

    // Detect abstract modifier
    const modifiersNode = node.children.find((c: SyntaxNode) => c.type === "modifiers");
    const isAbstract = modifiersNode?.children?.some((c: SyntaxNode) => c.text === "abstract") ?? false;

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
      paramTypes: extractParamTypes(node),
      structuralHints: isAbstract ? { isAbstract: true } : undefined,
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
      paramTypes: extractParamTypes(node),
      structuralHints: { isConstructor: true },
    });
  }

  // Classes
  for (const node of walkNodes(rootNode, ["class_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const superclass = node.childForFieldName("superclass");
    const interfacesNode = node.childForFieldName("interfaces");
    const inherits: string[] = superclass ? walkNodes(superclass, ["type_identifier"]).map((t: SyntaxNode) => t.text) : [];
    const impl: string[] = interfacesNode ? walkNodes(interfacesNode, ["type_identifier"]).map((t: SyntaxNode) => t.text) : [];
    // Only direct methods (not from nested classes)
    const body = node.childForFieldName("body");
    const methods = body ? body.children
      .filter((c: SyntaxNode) => c.type === "method_declaration")
      .map((m: SyntaxNode) => m.childForFieldName("name")?.text)
      .filter(Boolean) as string[] : [];

    const allParents = [...inherits, ...impl];
    results.push({
      name, kind: "class",
      signature: `class ${name}${allParents.length > 0 ? ` extends/implements ${allParents.join(", ")}` : ""}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync: false,
      docstring: getJavadoc(node) || undefined,
      classInfo: { inherits, implements: impl, methods },
      decorators: getAnnotations(node),
    });
  }

  // Interfaces
  for (const node of walkNodes(rootNode, ["interface_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;

    // Java interfaces use "extends_interfaces" node (not "interfaces" which is for class implements)
    const extendsNode = node.children.find((c: SyntaxNode) => c.type === "extends_interfaces");
    const inherits: string[] = extendsNode
      ? walkNodes(extendsNode, ["type_identifier"]).map((t: SyntaxNode) => t.text)
      : [];

    const body = node.childForFieldName("body");
    const methods = body ? body.children
      .filter((c: SyntaxNode) => c.type === "method_declaration")
      .map((m: SyntaxNode) => m.childForFieldName("name")?.text)
      .filter(Boolean) as string[] : [];

    results.push({
      name, kind: "interface",
      signature: `interface ${name}${inherits.length > 0 ? ` extends ${inherits.join(", ")}` : ""}`,
      lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
      visibility: getVisibility(node), isAsync: false,
      docstring: getJavadoc(node) || undefined,
      classInfo: { inherits, methods },
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

    // Extract field types as class members + collect all referenced types
    const members: Array<{ name: string; type: string }> = [];
    const usesTypesSet = new Set<string>();
    const body = node.childForFieldName("body");
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.children[i];
        if (child.type !== "field_declaration") continue;
        // Skip static fields — not instance dispatch targets
        const mods = child.children.find((c: SyntaxNode) => c.type === "modifiers");
        if (mods?.children?.some((c: SyntaxNode) => c.text === "static")) continue;

        const typeNode = child.childForFieldName("type");
        if (!typeNode) continue;
        const typeName = extractPrimaryTypeName(typeNode);

        // Collect field names (handles multi-declaration: int x, y;)
        for (const decl of walkNodes(child, ["variable_declarator"])) {
          const fieldName = decl.childForFieldName("name")?.text;
          if (fieldName) members.push({ name: fieldName, type: typeName });
        }

        // Track all type identifiers including generic args (e.g., List<UserRepository> → both List and UserRepository)
        for (const tid of walkNodes(typeNode, ["type_identifier"])) {
          if (!JAVA_PRIMITIVE_TYPES.has(tid.text)) usesTypesSet.add(tid.text);
        }
      }

      // Also collect types from method/constructor signatures
      for (let i = 0; i < body.childCount; i++) {
        const child = body.children[i];
        if (child.type !== "method_declaration" && child.type !== "constructor_declaration") continue;
        // Return type (methods only)
        const retType = child.childForFieldName("type");
        if (retType) {
          for (const tid of walkNodes(retType, ["type_identifier"])) {
            if (!JAVA_PRIMITIVE_TYPES.has(tid.text)) usesTypesSet.add(tid.text);
          }
        }
        // Parameter types
        const params = child.childForFieldName("parameters");
        if (params) {
          for (const tid of walkNodes(params, ["type_identifier"])) {
            if (!JAVA_PRIMITIVE_TYPES.has(tid.text)) usesTypesSet.add(tid.text);
          }
        }
      }
    }
    const usesTypes = Array.from(usesTypesSet);

    results.push({
      className: name, kind: "class", implements: impl, extends: ext, usesTypes,
      members: members.length > 0 ? members : undefined,
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  for (const node of walkNodes(rootNode, ["interface_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;

    // Extract interface extends
    const extendsNode = node.children.find((c: SyntaxNode) => c.type === "extends_interfaces");
    const ext: string[] = extendsNode
      ? walkNodes(extendsNode, ["type_identifier"]).map((t: SyntaxNode) => t.text)
      : [];

    // Extract interface method signatures as members (method name → return type)
    const members: Array<{ name: string; type: string }> = [];
    const ifaceBody = node.childForFieldName("body");
    if (ifaceBody) {
      for (let i = 0; i < ifaceBody.childCount; i++) {
        const child = ifaceBody.children[i];
        if (child.type !== "method_declaration") continue;
        const methodName = child.childForFieldName("name")?.text;
        const retType = child.childForFieldName("type");
        if (methodName && retType) {
          members.push({ name: methodName, type: extractPrimaryTypeName(retType) });
        }
      }
    }

    results.push({
      className: name, kind: "interface", implements: [], extends: ext, usesTypes: [],
      members: members.length > 0 ? members : undefined,
      filePath, lineStart: node.startPosition.row + 1, lineEnd: node.endPosition.row + 1,
    });
  }
  return results;
}

function extractLocalVariables(rootNode: SyntaxNode, lineStart: number, lineEnd: number): Array<{ name: string; type: string }> {
  const vars: Array<{ name: string; type: string }> = [];

  // Standard local variable declarations: User user = ...;
  for (const node of walkNodes(rootNode, ["local_variable_declaration"])) {
    if (node.startPosition.row < lineStart || node.endPosition.row > lineEnd) continue;
    const typeNode = node.childForFieldName("type");
    if (!typeNode || typeNode.text === "var") continue;
    const typeName = extractPrimaryTypeName(typeNode);
    if (JAVA_PRIMITIVE_TYPES.has(typeName)) continue;
    for (const decl of walkNodes(node, ["variable_declarator"])) {
      const nameNode = decl.childForFieldName("name");
      if (nameNode) vars.push({ name: nameNode.text, type: typeName });
    }
  }

  // Enhanced for loop variables: for (User user : users) { ... }
  for (const node of walkNodes(rootNode, ["enhanced_for_statement"])) {
    if (node.startPosition.row < lineStart || node.endPosition.row > lineEnd) continue;
    const typeNode = node.childForFieldName("type");
    const nameNode = node.childForFieldName("name");
    if (!typeNode || !nameNode || typeNode.text === "var") continue;
    const typeName = extractPrimaryTypeName(typeNode);
    if (!JAVA_PRIMITIVE_TYPES.has(typeName)) {
      vars.push({ name: nameNode.text, type: typeName });
    }
  }

  return vars;
}

export const javaConfig: TreeSitterLanguageConfig = {
  grammar: require("tree-sitter-java"),
  extensions: [".java"],
  extractFunctions, extractCalls, extractImports, extractDocstring: getJavadoc, extractTypeRelationships, extractLocalVariables,

  testDecorators: [
    "@Test", "@ParameterizedTest", "@RepeatedTest", "@BeforeEach", "@AfterEach",
    "@BeforeAll", "@AfterAll", "@Nested", "@ExtendWith",
  ],
  testImportPrefixes: [
    "org.junit", "org.mockito", "org.assertj",
    "org.springframework.boot.test", "org.springframework.test", "org.testng",
  ],
  noiseTargets: [
    "Instant.now", "Objects.requireNonNull", "Objects.hash", "Objects.equals",
    "UUID.randomUUID", "Duration.between", "Duration.ofSeconds", "Duration.ofMinutes",
    "Date.from", "BigDecimal.valueOf", "Optional.of", "Optional.ofNullable", "Optional.empty",
    "Collections.unmodifiableList", "Collections.singletonList",
    "Collections.emptyList", "Collections.emptyMap", "Stream.of",
    "ResponseEntity.ok", "ResponseEntity.status", "ResponseEntity.notFound",
    "Arrays.asList", "Arrays.stream", "Arrays.sort",
    "Integer.parseInt", "Integer.valueOf", "Long.parseLong", "Long.valueOf",
    "String.format", "String.valueOf", "Boolean.parseBoolean",
  ],
  builtinMethods: [
    "orElse", "orElseGet", "orElseThrow", "isPresent", "ifPresent",
    "stream", "collect", "toList", "of", "copyOf",
    "equals", "hashCode", "compareTo", "toString", "valueOf", "getClass",
    "intValue", "longValue", "doubleValue", "floatValue",
    "name", "ordinal",
  ],
  noisePatterns: [
    /^(System|Math|Arrays|Collections|Objects|Optional|Stream|Collectors|Integer|Long|Double|Float|String|Boolean|Character|BigDecimal|BigInteger|UUID|Instant|Duration|LocalDate|LocalDateTime|ZonedDateTime|Date|TimeUnit|Pattern|Matcher|StringBuilder|StringBuffer|Thread|Executors|CompletableFuture|AtomicInteger|AtomicLong|ResponseEntity|HttpStatus)\.\w+$/,
  ],

  // Language conventions
  selfKeywords: ["this"],
  constructorNames: ["constructor"],
  sourceRoots: ["src/main/java/", "src/test/java/", "src/main/kotlin/", "src/test/kotlin/"],
  workspaceManifests: ["build.gradle", "build.gradle.kts", "pom.xml"],

  // Import resolution
  isExternalImport: (modulePath) =>
    /^(java|javax|org\.springframework|org\.junit|org\.mockito|org\.slf4j|org\.hibernate|jakarta)\./.test(modulePath),
  resolveImportPath: (modulePath, _fromFile, _projectRoot, pathExists) => {
    const javaPath = modulePath.replace(/\./g, "/") + ".java";
    for (const srcRoot of ["src/main/java", "src/test/java", "src"]) {
      const candidate = path.join(srcRoot, javaPath).replace(/\\/g, "/");
      if (pathExists(candidate)) return candidate;
    }
    if (pathExists(javaPath)) return javaPath;
    return null;
  },
};
