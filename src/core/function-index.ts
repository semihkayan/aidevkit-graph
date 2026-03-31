import { existsSync } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import type {
  IFunctionIndexReader, IFunctionIndexWriter, ILanguageParser,
  IRecordStore, IStalenessChecker, IDocstringParser, Config,
  TestDetectionMetadata,
} from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { readFile, computeModule, detectLanguage } from "../utils/file-utils.js";
import { globSourceFiles } from "../utils/file-utils.js";

function decomposeIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1\0$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
    .replace(/_/g, "\0")
    .split("\0")
    .filter(s => s.length > 0);
}

/**
 * Detect whether a file contains test code using structural signals from parser metadata:
 * 1. Decorator check (free — already extracted): @Test, #[test], [Fact], etc.
 * 2. Import check (one parseImports call): junit, pytest, jest, testing, etc.
 */
function detectTestFile(
  fileRecords: FunctionRecord[],
  parser: ILanguageParser,
  source: string,
  filePath: string,
  testMetadata: TestDetectionMetadata,
): boolean {
  // Decorator check — free, already parsed
  const hasTestDecorator = fileRecords.some(r =>
    r.decorators?.some(d =>
      testMetadata.allTestDecorators.some(td => d.includes(td))
    )
  );
  if (hasTestDecorator) return true;

  // Import check — one parseImports call, lookup by file extension
  const ext = "." + filePath.split(".").pop();
  const prefixes = testMetadata.testImportPrefixesByExtension.get(ext);
  if (!prefixes || prefixes.length === 0) return false;

  const imports = parser.parseImports(source, filePath);
  return imports.some(imp => prefixes.some(prefix => imp.modulePath.startsWith(prefix)));
}

export class FunctionIndex implements IFunctionIndexReader, IFunctionIndexWriter {
  private records = new Map<string, FunctionRecord>();
  private fileIndex = new Map<string, string[]>();      // filePath → [record ids]
  private moduleIndex = new Map<string, string[]>();    // module → [record ids]
  private tagIndex = new Map<string, Set<string>>();    // tag → Set<record ids>
  private nameIndex = new Map<string, string[]>();      // name → [record ids] (for fast lookup)
  private fileHashes = new Map<string, string>();       // filePath → SHA-256

  constructor(
    private parsers: ILanguageParser[],
    private recordStore: IRecordStore,
    private stalenessChecker: IStalenessChecker,
    private docstringParser: IDocstringParser,
    private config: Config,
    public readonly projectRoot: string,
    private testMetadata: TestDetectionMetadata,
  ) {}

  // === IFunctionIndexReader ===

  getById(id: string): FunctionRecord | null {
    return this.records.get(id) ?? null;
  }

  getByModule(module: string): FunctionRecord[] {
    let results = this.getByModuleExact(module);

    // Fallback: if sourceRoot is configured and query doesn't include it, retry with prefix
    // Handles agent querying "core" when records are stored as "src/core"
    if (results.length === 0 && this.config.parser.sourceRoot) {
      const withPrefix = `${this.config.parser.sourceRoot}/${module}`;
      results = this.getByModuleExact(withPrefix);
    }

    // Reverse fallback: agent queries "src/core" but records stored as "core"
    if (results.length === 0 && this.config.parser.sourceRoot) {
      const prefix = this.config.parser.sourceRoot + "/";
      if (module.startsWith(prefix)) {
        results = this.getByModuleExact(module.slice(prefix.length));
      }
    }

    // Suffix fallback: agent queries "user" → matches "com/xxx/user" and sub-modules.
    if (results.length === 0) {
      const suffix = `/${module}`;
      for (const [mod, ids] of this.moduleIndex) {
        if (mod.endsWith(suffix) || mod.includes(`${suffix}/`)) {
          for (const id of ids) {
            const rec = this.records.get(id);
            if (rec) results.push(rec);
          }
        }
      }
    }

    return results;
  }

  private getByModuleExact(module: string): FunctionRecord[] {
    const results: FunctionRecord[] = [];
    for (const [mod, ids] of this.moduleIndex) {
      if (mod === module || mod.startsWith(`${module}/`)) {
        for (const id of ids) {
          const rec = this.records.get(id);
          if (rec) results.push(rec);
        }
      }
    }
    return results;
  }

  getByFile(filePath: string): FunctionRecord[] {
    return (this.fileIndex.get(filePath) || [])
      .map(id => this.records.get(id)!)
      .filter(Boolean);
  }

  getByTags(tags: string[], matchMode: "all" | "any"): FunctionRecord[] {
    if (tags.length === 0) return [];

    const tagSets = tags.map(t => this.tagIndex.get(t.toLowerCase()) || new Set<string>());

    let matchingIds: Set<string>;
    if (matchMode === "all") {
      matchingIds = new Set(tagSets[0]);
      for (let i = 1; i < tagSets.length; i++) {
        for (const id of matchingIds) {
          if (!tagSets[i].has(id)) matchingIds.delete(id);
        }
      }
    } else {
      matchingIds = new Set<string>();
      for (const s of tagSets) {
        for (const id of s) matchingIds.add(id);
      }
    }

    return Array.from(matchingIds)
      .map(id => this.records.get(id)!)
      .filter(Boolean);
  }

  findByName(name: string, module?: string): FunctionRecord[] {
    // Fast path: exact name match via nameIndex
    const directIds = this.nameIndex.get(name) || [];
    // Also check "ClassName.methodName" pattern
    const dotSuffix = `.${name}`;
    const suffixIds: string[] = [];
    for (const [n, ids] of this.nameIndex) {
      if (n.endsWith(dotSuffix)) suffixIds.push(...ids);
    }
    const allIds = [...new Set([...directIds, ...suffixIds])];
    return allIds
      .map(id => this.records.get(id)!)
      .filter(rec => rec && (!module || rec.module === module || rec.module.startsWith(`${module}/`)));
  }

  findByExactName(name: string): FunctionRecord[] {
    return (this.nameIndex.get(name) || [])
      .map(id => this.records.get(id)!)
      .filter(Boolean);
  }

  findByClassAware(query: string): FunctionRecord[] {
    const segments = decomposeIdentifier(query);
    if (segments.length < 2) return [];

    const verb = segments[0].toLowerCase();
    const context = segments.slice(1).filter(s => s.length > 2).map(s => s.toLowerCase());
    if (context.length === 0) return [];

    // Score each class/interface record by context + verb match
    const candidates: Array<{ record: FunctionRecord; score: number }> = [];
    for (const rec of this.records.values()) {
      if (rec.kind !== "class" && rec.kind !== "interface") continue;

      const nameLower = rec.name.toLowerCase();
      if (!context.every(seg => nameLower.includes(seg))) continue;

      let score = context.length;
      if (nameLower.includes(verb)) score += 2;
      if (rec.structuralHints?.isTest) score -= 3;

      candidates.push({ record: rec, score });
    }

    if (candidates.length === 0) return [];
    candidates.sort((a, b) => b.score - a.score);

    // For top-scoring class(es), find methods matching verb
    const topScore = candidates[0].score;
    const seen = new Set<string>();
    const results: FunctionRecord[] = [];

    for (const { record: classRec, score } of candidates) {
      if (score < topScore - 1) break;
      for (const methodName of classRec.classInfo?.methods || []) {
        if (methodName === "constructor" || methodName === "__init__") continue;
        const mLower = methodName.toLowerCase();
        if (mLower === verb || verb.startsWith(mLower) || mLower.startsWith(verb)) {
          const fullName = `${classRec.name}.${methodName}`;
          if (seen.has(fullName)) continue;
          seen.add(fullName);
          results.push(...this.findByExactName(fullName));
        }
      }
    }

    return results;
  }

  getAllModules(): string[] {
    const raw = Array.from(this.moduleIndex.keys());
    // Strip sourceRoot prefix for cleaner display (agent sees "core" not "src/core")
    const prefix = this.config.parser.sourceRoot ? this.config.parser.sourceRoot + "/" : null;
    if (!prefix) return raw;
    return raw.map(m => m.startsWith(prefix) ? m.slice(prefix.length) : m);
  }

  getAllFilePaths(): string[] {
    return Array.from(this.fileIndex.keys());
  }

  getFileRecordIds(filePath: string): string[] {
    return this.fileIndex.get(filePath) || [];
  }

  getFileHashes(): Map<string, string> {
    return this.fileHashes;
  }

  getStats(): { files: number; functions: number; classes: number } {
    let functions = 0;
    let classes = 0;
    for (const rec of this.records.values()) {
      if (rec.kind === "class") classes++;
      else functions++;
    }
    return { files: this.fileIndex.size, functions, classes };
  }

  getDocstringCoverage(): number {
    if (this.records.size === 0) return 0;
    let withDocstring = 0;
    for (const rec of this.records.values()) {
      if (rec.docstring) withDocstring++;
    }
    return withDocstring / this.records.size;
  }

  getLanguageStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const rec of this.records.values()) {
      stats[rec.language] = (stats[rec.language] || 0) + 1;
    }
    return stats;
  }

  // === IFunctionIndexWriter ===

  async loadFromDisk(): Promise<void> {
    const { records, hashes } = await this.recordStore.loadAll();

    // Filter out records from ignored files (e.g., dist/ cached before ignore was added)
    const ig = ignore.default().add(this.config.parser.ignore);
    let ignoredCount = 0;

    // Deduplicate by ID and re-normalize module paths to match current sourceRoot config.
    // Cache may contain records from different config eras (e.g., before sourceRoot auto-detection).
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);

      // Skip records from ignored files
      if (ig.ignores(record.filePath)) {
        ignoredCount++;
        continue;
      }

      // Re-compute module to match current sourceRoot config
      const correctModule = computeModule(record.filePath, "", this.config.parser.sourceRoot);
      if (record.module !== correctModule) {
        record.module = correctModule;
      }

      this.addRecord(record);
    }

    // Clean hashes for ignored files so refreshStale doesn't process them
    for (const [filePath] of hashes) {
      if (ig.ignores(filePath)) {
        hashes.delete(filePath);
      }
    }

    this.fileHashes = hashes;
  }

  async saveToDisk(): Promise<void> {
    // Save current records
    const saves = [];
    const activeFiles = new Set<string>();
    for (const [relPath, ids] of this.fileIndex) {
      activeFiles.add(relPath);
      const records = ids.map(id => this.records.get(id)!).filter(Boolean);
      const hash = this.fileHashes.get(relPath) || "";
      saves.push(this.recordStore.saveFile(relPath, records, hash));
    }
    await Promise.all(saves);

    // Clean up orphan cache files (from deleted/ignored files)
    await this.recordStore.deleteOrphans?.(activeFiles);
  }

  async buildFull(projectRoot: string): Promise<void> {
    const files = await globSourceFiles(projectRoot, this.config);
    await this.updateFiles(files);
  }

  async updateFiles(changedFiles: string[]): Promise<string[]> {
    const changedFunctionIds: string[] = [];

    for (const absolutePath of changedFiles) {
      // Normalize to absolute
      const absPath = path.isAbsolute(absolutePath) ? absolutePath : path.join(this.projectRoot, absolutePath);
      const relPath = this.toRelativePath(absPath);

      // Handle deleted files
      if (!existsSync(absPath)) {
        const oldIds = this.fileIndex.get(relPath) || [];
        for (const id of oldIds) this.removeRecord(id);
        this.fileHashes.delete(relPath);
        await this.recordStore.deleteFile(relPath);
        changedFunctionIds.push(...oldIds);
        continue;
      }

      // Skip if hash unchanged — always compare by relative path
      const newHash = await this.stalenessChecker.computeHash(absPath);
      if (this.fileHashes.get(relPath) === newHash) continue;

      // Delete old records and track their IDs for vector cleanup
      const oldIds = this.fileIndex.get(relPath) || [];
      for (const id of oldIds) this.removeRecord(id);
      changedFunctionIds.push(...oldIds);

      // Find parser
      const parser = this.parsers.find(p => p.canParse(absPath));
      if (!parser) continue;

      // Parse
      const source = await readFile(absPath);
      const rawFunctions = parser.parseFunctions(source, absPath);

      // Build records
      const fileRecords: FunctionRecord[] = [];
      for (const raw of rawFunctions) {
        fileRecords.push(this.toFunctionRecord(raw, relPath, newHash));
      }

      // Mark test files structurally (decorator + import analysis)
      if (detectTestFile(fileRecords, parser, source, relPath, this.testMetadata)) {
        for (const record of fileRecords) {
          record.structuralHints = { ...record.structuralHints, isTest: true };
        }
      }

      for (const record of fileRecords) {
        this.addRecord(record);
        changedFunctionIds.push(record.id);
      }

      // Always store hashes by relative path
      this.fileHashes.set(relPath, newHash);
    }

    return changedFunctionIds;
  }

  async refreshStale(projectRoot: string): Promise<string[]> {
    const changedFiles = await this.stalenessChecker.getChangedFiles(
      projectRoot, this.fileHashes
    );
    if (changedFiles.length === 0) return [];
    return this.updateFiles(changedFiles);
  }

  // === Private ===

  private addRecord(record: FunctionRecord): void {
    // If this ID already exists, remove old index entries first to prevent duplicates
    if (this.records.has(record.id)) {
      this.removeRecord(record.id);
    }

    this.records.set(record.id, record);

    // File index
    if (!this.fileIndex.has(record.filePath)) this.fileIndex.set(record.filePath, []);
    this.fileIndex.get(record.filePath)!.push(record.id);

    // Module index
    if (!this.moduleIndex.has(record.module)) this.moduleIndex.set(record.module, []);
    this.moduleIndex.get(record.module)!.push(record.id);

    // Tag index
    if (record.docstring?.tags) {
      for (const tag of record.docstring.tags) {
        const key = tag.toLowerCase();
        if (!this.tagIndex.has(key)) this.tagIndex.set(key, new Set());
        this.tagIndex.get(key)!.add(record.id);
      }
    }

    // Name index
    if (!this.nameIndex.has(record.name)) this.nameIndex.set(record.name, []);
    this.nameIndex.get(record.name)!.push(record.id);
  }

  private removeRecord(id: string): void {
    const record = this.records.get(id);
    if (!record) return;

    // File index
    const fileIds = this.fileIndex.get(record.filePath);
    if (fileIds) {
      const idx = fileIds.indexOf(id);
      if (idx !== -1) fileIds.splice(idx, 1);
      if (fileIds.length === 0) this.fileIndex.delete(record.filePath);
    }

    // Module index
    const modIds = this.moduleIndex.get(record.module);
    if (modIds) {
      const idx = modIds.indexOf(id);
      if (idx !== -1) modIds.splice(idx, 1);
      if (modIds.length === 0) this.moduleIndex.delete(record.module);
    }

    // Tag index
    if (record.docstring?.tags) {
      for (const tag of record.docstring.tags) {
        this.tagIndex.get(tag.toLowerCase())?.delete(id);
      }
    }

    // Name index
    const nameIds = this.nameIndex.get(record.name);
    if (nameIds) {
      const idx = nameIds.indexOf(id);
      if (idx !== -1) nameIds.splice(idx, 1);
      if (nameIds.length === 0) this.nameIndex.delete(record.name);
    }

    this.records.delete(id);
  }

  private toFunctionRecord(raw: import("../types/index.js").RawFunctionInfo, filePath: string, hash: string): FunctionRecord {
    const docstring = raw.docstring
      ? this.docstringParser.parse(raw.docstring, raw.kind === "class" ? "class" : "function")
      : null;
    // filePath is already relative — computeModule needs "." as base since path is relative
    const module = computeModule(filePath, "", this.config.parser.sourceRoot);
    const language = detectLanguage(filePath, this.config.parser.languages) || "unknown";

    return {
      id: `${filePath}::${raw.name}`,
      filePath,
      module,
      name: raw.name,
      kind: raw.kind,
      language,
      visibility: raw.visibility,
      isAsync: raw.isAsync,
      signature: raw.signature,
      lineStart: raw.lineStart,
      lineEnd: raw.lineEnd,
      decorators: raw.decorators,
      docstring,
      classInfo: raw.classInfo ? {
        ...raw.classInfo,
        state: docstring?.state ?? [],
        pattern: docstring?.pattern ?? [],
        inherits: docstring?.inherits ?? raw.classInfo.inherits,
      } : undefined,
      // Type relationships from classInfo (implements/extends come from parser)
      typeRelationships: raw.classInfo ? {
        implements: [], // Filled by TypeGraph from parser's extractTypeRelationships
        extends: raw.classInfo.inherits || [],
        usesTypes: [],
      } : undefined,
      paramTypes: raw.paramTypes,
      structuralHints: raw.structuralHints,
      fileHash: hash,
      lastIndexedAt: Date.now(),
    };
  }

  private toRelativePath(absolutePath: string): string {
    return path.relative(this.projectRoot, absolutePath);
  }
}
