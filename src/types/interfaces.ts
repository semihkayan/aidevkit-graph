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
  findByClassAware(query: string): FunctionRecord[];
  getAllModules(): string[];
  getAllNames(): string[];
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
  clear(): void;
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
  clear(): void;
}

// === Type Graph ===

export interface ITypeGraphReader {
  getTypeNode(typeName: string): TypeNode | undefined;
  getImplementors(typeName: string): string[];
  getExtenders(typeName: string): string[];
  getUsages(typeName: string): string[];
  getTypeChain(typeName: string): string[];
  getMemberType(typeName: string, memberName: string): string | undefined;
  getAllTypes(): string[];
  getStats(): { types: number; relationships: number };
}

export interface ITypeGraphWriter {
  build(index: IFunctionIndexReader, parsers: ILanguageParser[], projectRoot: string): Promise<TypeRelationGraph>;
  buildForFiles(files: string[], index: IFunctionIndexReader, parsers: ILanguageParser[], projectRoot: string): Promise<void>;
  removeByFile(filePath: string): void;
  saveToDisk(cacheDir: string, index: IFunctionIndexReader): Promise<void>;
  loadFromDisk(cacheDir: string, index: IFunctionIndexReader): Promise<boolean>;
  clear(): void;
}

// === Language Parser ===

export interface ILanguageParser {
  readonly extensions: string[];
  canParse(filePath: string): boolean;
  parseFunctions(source: string, filePath: string): RawFunctionInfo[];
  parseCalls(source: string, lineStart: number, lineEnd: number): RawCallInfo[];
  parseImports(source: string, filePath: string): RawImportInfo[];
  parseTypeRelationships(source: string, filePath: string): RawTypeRelationship[];

  // Import resolution — languages that support path resolution implement these
  resolveImportPath(
    modulePath: string, fromFile: string, projectRoot: string,
    pathExists: (workspaceRelativePath: string) => boolean,
  ): string | null;
  isExternalImport(modulePath: string): boolean;
}

// === Import Resolver ===

export interface IImportResolver {
  resolveImports(source: string, filePath: string, projectRoot: string): ImportMap;
}

// === Docstring Parsing ===

export interface IDocstringParser {
  parse(raw: string, kind: "function" | "method" | "class"): ParsedDocstring;
}

// === Git Service ===

export interface IGitService {
  getChangedFiles(projectRoot: string, since?: string): Promise<Array<{ filePath: string; changeType: "added" | "modified" | "deleted" | "renamed" }>>;
  getRecentCommits(projectRoot: string, since?: string): Promise<Array<{ hash: string; message: string; date: string; author: string; files: string[] }>>;
  isGitRepo(projectRoot: string): Promise<boolean>;
}

// === Persistence ===

export interface IRecordStore {
  loadAll(): Promise<{ records: FunctionRecord[]; hashes: Map<string, string>; mtimes: Map<string, number> }>;
  saveFile(filePath: string, records: FunctionRecord[], hash: string, mtimeMs: number): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  getFileHash(filePath: string): Promise<string | null>;
  deleteOrphans?(activeFiles: Set<string>): Promise<void>;
}

// === Staleness ===

export interface IStalenessChecker {
  getChangedFiles(
    projectRoot: string,
    knownHashes: Map<string, string>,
    knownMtimes: Map<string, number>,
  ): Promise<{ changed: string[]; mtimes: Map<string, number> }>;
  computeHash(filePath: string): Promise<string>;
}

// === File Watcher ===

export interface IFileWatcher {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
  notifyChanges(filePaths: string[]): void;
}

// === Reindex Orchestrator ===

export interface ReindexResult {
  mode: string;
  changedFunctions: number;
  embedded: number;
  elapsedMs: number;
}

export interface IReindexOrchestrator {
  /** Full rebuild: re-parse all files, re-embed, rebuild graphs */
  reindexFull(ws: WorkspaceServices, wsPath: string): Promise<ReindexResult>;
  /** Incremental: check for stale files, update only changed */
  reindexIncremental(ws: WorkspaceServices, wsPath: string): Promise<ReindexResult>;
  /** Specific files only */
  reindexFiles(ws: WorkspaceServices, wsPath: string, files: string[]): Promise<ReindexResult>;
  /** Handle file watcher changes (optimized incremental path) */
  handleFileChanges(ws: WorkspaceServices, wsPath: string, changedFiles: string[]): Promise<void>;
}

// === Language Metadata (aggregated from parser configs at startup) ===

export interface TestDetectionMetadata {
  allTestDecorators: string[];
  testImportPrefixesByExtension: Map<string, string[]>;
}

export interface NoiseFilterMetadata {
  noiseTargets: Set<string>;
  builtinMethods: Set<string>;
  noisePatterns: RegExp[];
}

export interface LanguageConventions {
  readonly selfKeywords: ReadonlySet<string>;
  readonly constructorNames: ReadonlySet<string>;
  readonly returnTypePatterns: readonly RegExp[];
  readonly sourceRoots: readonly string[];
  readonly workspaceManifests: readonly string[];
  readonly workspaceManifestExtensions: readonly string[];
  readonly indexFileNames: readonly string[];
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
  embeddingAvailable: boolean;
  readonly parsers: ILanguageParser[];
  readonly conventions: LanguageConventions;
  readonly noiseFilter: NoiseFilterMetadata;
  readonly watcher: IFileWatcher;
  readonly git: IGitService;
  readonly reindex: IReindexOrchestrator;
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
    highConfidenceThreshold: number;
    rrfK: number;
    expandCamelCase: boolean;
    exactNameBoost: boolean;
    density: {
      enabled: boolean;
      floor: number;
      ceiling: number;
      accessorPenalty: number;
      constructorPenalty: number;
      testFilePenalty: number;
      weights: {
        bodySize: number;
        docstring: number;
        docstringRichness: number;
        paramCount: number;
        centrality: number;
        visibility: number;
        kind: number;
      };
    };
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
