// === Core Data Types ===

export interface FunctionRecord {
  // Identity
  id: string;                    // "filePath::functionName" (workspace-relative)
  filePath: string;              // "domain/order/OrderService.java"
  module: string;                // "domain/order" (hierarchical, sourceRoot stripped)
  name: string;                  // "processOrder"
  kind: "function" | "method" | "class" | "interface" | "struct" | "enum" | "record";
  language: string;              // "python" | "typescript" | "go" | ...
  visibility: "public" | "private" | "protected";
  isAsync: boolean;

  // Structural
  signature: string;             // "processOrder(order: Order, code: str) -> OrderResult"
  lineStart: number;
  lineEnd: number;
  decorators?: string[];

  // Docstring (OPTIONAL — system works without)
  docstring: ParsedDocstring | null;

  // Class info
  classInfo?: {
    inherits: string[];
    state: string[];
    pattern: string[];
    methods: string[];
  };

  // Type relationships (all languages)
  typeRelationships?: {
    implements: string[];        // TS implements, Java implements, Go implicit, Rust impl Trait
    extends: string[];           // TS/Java/Python extends/inheritance
    usesTypes: string[];         // Signature types: ["Order", "Result"]
  };

  // Parameter types (for type-aware call resolution)
  paramTypes?: Array<{ name: string; type: string }>;

  // Parser-detected structural classification (overrides heuristics in density scorer)
  structuralHints?: StructuralHints;

  // Metadata
  fileHash: string;
  lastIndexedAt: number;
}

export interface StructuralHints {
  isConstructor?: boolean;   // AST-confirmed: constructor_declaration, __init__
  isAbstract?: boolean;      // AST-confirmed: abstract keyword, @abstractmethod
  propertyAccess?: boolean;  // AST-confirmed: get/set keyword, @property, C# property
  isTest?: boolean;          // AST-confirmed: test decorator (@Test, #[test]) or test framework import (junit, pytest, jest, etc.)
}

export interface ParsedDocstring {
  raw: string;
  summary: string;
  deps: string[];
  sideEffects: string[];
  tags: string[];
  complexity: string | null;
  // Class-specific
  inherits?: string[];
  state?: string[];
  pattern?: string[];
}

// === Vector DB Types ===

export interface VectorRow {
  id: string;
  vector: Float32Array;
  filePath: string;
  module: string;
  name: string;
  signature: string;
  summary: string;
  tags: string;                  // Delimited: ",coupon,discount,"
  sideEffects: string;           // Delimited: ",database_read,"
  chunkText: string;
}

// === Call Graph Types ===

export interface CallGraphEntry {
  calls: Array<{
    target: string;
    resolvedFile: string | null;
    resolvedId: string | null;
    line: number;
  }>;
  calledBy: Array<{
    caller: string;
    callerName: string;
    file: string;
    line: number;
  }>;
}

export type CallGraph = Map<string, CallGraphEntry>;

// === Type Graph Types ===

export interface TypeNode {
  name: string;
  kind: "interface" | "class" | "type_alias" | "trait" | "struct" | "protocol" | "record";
  filePath: string;
  lineStart: number;
  lineEnd: number;
  implementors: string[];
  extenders: string[];
  usedBy: string[];
  members: Record<string, string>;  // property/field name → type name
}

export type TypeRelationGraph = Map<string, TypeNode>;

// === Search Types ===

export interface SearchResult {
  id: string;
  name: string;
  filePath: string;
  module: string;
  signature: string;
  summary: string;
  tags: string[];
  score: number;
}

export interface RankedResult {
  id: string;
  row: VectorRow;
  score: number;
  distance?: number;  // Raw vector distance from LanceDB (lower = more similar)
}

export interface SearchFilter {
  scope?: string;
  tags?: string[];
  sideEffects?: string[];
}

// === Parser Types ===

export type ImportMap = Map<string, {
  module: string;
  resolvedPath: string | null;
}>;

export interface RawFunctionInfo {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "struct" | "enum" | "record";
  signature: string;
  lineStart: number;
  lineEnd: number;
  visibility: "public" | "private" | "protected";
  isAsync: boolean;
  decorators?: string[];
  docstring?: string;
  classInfo?: { inherits: string[]; methods: string[] };
  paramTypes?: Array<{ name: string; type: string }>;
  structuralHints?: StructuralHints;
}

export interface RawCallInfo {
  name: string;
  objectName?: string;
  line: number;
}

export interface RawImportInfo {
  importedName: string;
  modulePath: string;
  isDefault: boolean;
}

export interface RawTypeRelationship {
  className: string;
  kind: "class" | "interface" | "type_alias" | "trait" | "struct" | "record";
  implements: string[];
  extends: string[];
  usesTypes: string[];
  members?: Array<{ name: string; type: string }>;  // property/field → type
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

// === Workspace Types ===

export interface DetectedWorkspace {
  path: string;
  manifests: string[];
}

// === Error Types ===

export class EmbedderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedderError";
  }
}

export enum ErrorCode {
  OLLAMA_UNAVAILABLE = "OLLAMA_UNAVAILABLE",
  MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
  INDEX_EMPTY = "INDEX_EMPTY",
  MODULE_NOT_FOUND = "MODULE_NOT_FOUND",
  FUNCTION_NOT_FOUND = "FUNCTION_NOT_FOUND",
  AMBIGUOUS_FUNCTION = "AMBIGUOUS_FUNCTION",
  PARSE_ERROR = "PARSE_ERROR",
  CONFIG_ERROR = "CONFIG_ERROR",
  INDEX_CORRUPT = "INDEX_CORRUPT",
  EMBEDDING_DIMENSION_MISMATCH = "EMBEDDING_DIMENSION_MISMATCH",
  FTS_INDEX_FAILED = "FTS_INDEX_FAILED",
  WORKSPACE_REQUIRED = "WORKSPACE_REQUIRED",
  WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND",
}
