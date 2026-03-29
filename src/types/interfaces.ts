import type {
  FunctionRecord, ParsedDocstring, VectorRow, SearchResult, RankedResult,
  SearchFilter, CallGraph, CallGraphEntry, TypeRelationGraph, TypeNode,
  ImportMap, RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship,
} from "./index.js";

// === Index: Read ===

export interface IFunctionIndexReader {
  getById(id: string): FunctionRecord | null;
  getByModule(module: string): FunctionRecord[];
  getByFile(filePath: string): FunctionRecord[];
  getByTags(tags: string[], matchMode: "all" | "any"): FunctionRecord[];
  findByName(name: string, module?: string): FunctionRecord[];
  findByExactName(name: string): FunctionRecord[];
  getAllModules(): string[];
  getAllFilePaths(): string[];
  getFileRecordIds(filePath: string): string[];
  getFileHashes(): Map<string, string>;
  getStats(): { files: number; functions: number; classes: number };
  getDocstringCoverage(): number;
  getLanguageStats(): Record<string, number>;
}

// === Index: Write ===

export interface IFunctionIndexWriter {
  buildFull(projectRoot: string): Promise<void>;
  updateFiles(files: string[]): Promise<string[]>;
  refreshStale(projectRoot: string): Promise<string[]>;
  loadFromDisk(): Promise<void>;
  saveToDisk(): Promise<void>;
}

// === Source Extraction ===

export interface ISourceExtractor {
  getFunctionSource(id: string, contextLines?: number): Promise<{
    source: string;
    lineStart: number;
    lineEnd: number;
    contextBefore?: string;
    contextAfter?: string;
  }>;
}

// === Embedding ===

export interface IEmbeddingProvider {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  isAvailable(): Promise<boolean>;
  readonly dimensions: number;
}

// === Vector Database ===

export interface IVectorDatabase {
  initialize(connectionString: string, tableName?: string): Promise<void>;
  upsert(records: VectorRow[]): Promise<void>;
  deleteByFile(filePath: string): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
  vectorSearch(query: Float32Array, topK: number, filter?: SearchFilter): Promise<RankedResult[]>;
  searchByExactName(name: string, scope?: string): Promise<RankedResult[]>;
  isEmpty(): Promise<boolean>;
  countRows(): Promise<number>;
  close?(): Promise<void>;
}

// === Full Text Search ===

export interface IFullTextSearch {
  ftsSearch(queryText: string, topK: number, filter?: SearchFilter): Promise<RankedResult[]>;
  readonly isAvailable: boolean;
}

// === Result Merging ===

export interface IResultMerger {
  merge(rankedLists: RankedResult[][], topK: number): SearchResult[];
}

// === Search Pipeline ===

export interface ISearchPipeline {
  search(
    query: { vector?: Float32Array; text: string },
    options: {
      topK: number;
      scope?: string;
      tagsFilter?: string[];
      sideEffectsFilter?: string[];
    }
  ): Promise<SearchResult[]>;
}

// === Call Graph ===

export interface ICallGraphReader {
  getEntry(id: string): CallGraphEntry | undefined;
  getTransitive(
    startId: string,
    direction: "downstream" | "upstream",
    maxDepth: number
  ): { nodes: Array<{ id: string; depth: number }>; cycles: string[][] };
  getStats(): { nodes: number; edges: number; cycles: number };
}

export interface ICallGraphWriter {
  build(index: IFunctionIndexReader, projectRoot: string): Promise<CallGraph>;
  buildForFiles(files: string[], index: IFunctionIndexReader, projectRoot: string): Promise<void>;
  removeByFile(filePath: string, index: IFunctionIndexReader): void;
  saveToDisk(cacheDir: string, index: IFunctionIndexReader): Promise<void>;
  loadFromDisk(cacheDir: string, index: IFunctionIndexReader): Promise<boolean>;
}

// === Type Graph ===

export interface ITypeGraphReader {
  getTypeNode(typeName: string): TypeNode | undefined;
  getImplementors(typeName: string): string[];
  getExtenders(typeName: string): string[];
  getUsages(typeName: string): string[];
  getTypeChain(typeName: string): string[];
  getAllTypes(): string[];
  getStats(): { types: number; relationships: number };
}

export interface ITypeGraphWriter {
  build(index: IFunctionIndexReader, parsers: ILanguageParser[], projectRoot: string): Promise<TypeRelationGraph>;
  buildForFiles(files: string[], index: IFunctionIndexReader, parsers: ILanguageParser[], projectRoot: string): Promise<void>;
  removeByFile(filePath: string): void;
  saveToDisk(cacheDir: string, index: IFunctionIndexReader): Promise<void>;
  loadFromDisk(cacheDir: string, index: IFunctionIndexReader): Promise<boolean>;
}

// === Language Parser ===

export interface ILanguageParser {
  readonly extensions: string[];
  canParse(filePath: string): boolean;
  parseFunctions(source: string, filePath: string): RawFunctionInfo[];
  parseCalls(source: string, lineStart: number, lineEnd: number): RawCallInfo[];
  parseImports(source: string, filePath: string): RawImportInfo[];
  parseTypeRelationships(source: string, filePath: string): RawTypeRelationship[];
}

// === Import Resolver ===

export interface IImportResolver {
  resolveImports(source: string, filePath: string, projectRoot: string): ImportMap;
}

// === Persistence ===

export interface IRecordStore {
  loadAll(): Promise<{ records: FunctionRecord[]; hashes: Map<string, string> }>;
  saveFile(filePath: string, records: FunctionRecord[], hash: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  getFileHash(filePath: string): Promise<string | null>;
}

// === Staleness ===

export interface IStalenessChecker {
  getChangedFiles(projectRoot: string, knownHashes: Map<string, string>): Promise<string[]>;
  computeHash(filePath: string): Promise<string>;
}

// === File Watcher ===

export interface IFileWatcher {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
  notifyChanges(filePaths: string[]): void;
}

// === Workspace Services (per-workspace isolated) ===

export interface WorkspaceServices {
  readonly index: IFunctionIndexReader;
  readonly indexWriter: IFunctionIndexWriter;
  readonly source: ISourceExtractor;
  readonly search: ISearchPipeline;
  readonly callGraph: ICallGraphReader;
  readonly callGraphWriter: ICallGraphWriter;
  readonly typeGraph: ITypeGraphReader;
  readonly typeGraphWriter: ITypeGraphWriter;
  readonly vectorDb: IVectorDatabase;
  readonly projectRoot: string;
}

// === App Context (tool handlers receive this) ===

export interface AppContext {
  resolveWorkspace(wsPath?: string): WorkspaceServices;
  readonly workspacePaths: string[];
  readonly isMultiWorkspace: boolean;
  readonly config: Readonly<Config>;
  readonly embedding: IEmbeddingProvider;
  readonly embeddingAvailable: boolean;
  readonly parsers: ILanguageParser[];
  readonly watcher: IFileWatcher;
  ready: boolean;
  shutdown(): Promise<void>;
}

// === Config ===

export interface Config {
  projectRoot: string;
  workspaces?: string[];
  embedding: {
    model: string;
    ollamaUrl: string;
    dimensions: number;
    batchSize: number;
    instruction?: string;
  };
  parser: {
    languages: Record<string, string[]>;
    ignore: string[];
    sourceRoot?: string;
  };
  moduleSummary: {
    compactThreshold: number;
    filesOnlyThreshold: number;
    maxTokenBudget: number;
  };
  search: {
    rrfK: number;
    expandCamelCase: boolean;
    exactNameBoost: boolean;
  };
  indexing: {
    parallelWorkers: number;
    maxFileSizeKb: number;
    maxChunkTokens: number;
  };
  watcher: {
    debounceMs: number;
    minIntervalMs: number;
  };
}
