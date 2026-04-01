import type {
  ICallGraphReader, ICallGraphWriter, IFunctionIndexReader, IImportResolver, ILanguageParser,
  ITypeGraphReader, LanguageConventions,
} from "../types/interfaces.js";
import type { CallGraph, CallGraphEntry } from "../types/index.js";
import { readFile } from "../utils/file-utils.js";
import { computeIndexFingerprint, saveGraphJson, loadGraphJson } from "../utils/graph-persistence.js";
import path from "node:path";

export class CallGraphManager implements ICallGraphReader, ICallGraphWriter {
  private graph: CallGraph = new Map();
  private selfKeywords: ReadonlySet<string>;
  private typeGraph?: ITypeGraphReader;
  // Populated by removeByFile(), consumed and cleared by buildForFiles().
  // Tracks callers whose forward edges were nullified so they can be re-resolved.
  private affectedCallerIds = new Set<string>();

  constructor(
    private importResolver: IImportResolver,
    private parsers: ILanguageParser[],
    typeGraph: ITypeGraphReader | undefined,
    private conventions: LanguageConventions,
  ) {
    this.typeGraph = typeGraph;
    this.selfKeywords = conventions.selfKeywords;
  }

  // === ICallGraphWriter ===

  async build(index: IFunctionIndexReader, projectRoot: string): Promise<CallGraph> {
    this.graph.clear();
    this.affectedCallerIds.clear();

    await this.processFiles(index.getAllFilePaths(), index, projectRoot);

    // Full scan — correct for full rebuild
    this.resolveTargetIds(index);
    this.buildReverseGraph(index);

    return this.graph;
  }

  async buildForFiles(files: string[], index: IFunctionIndexReader, projectRoot: string): Promise<void> {
    const newEntryIds = await this.processFiles(files, index, projectRoot);

    // Combine new entries + callers affected by removeByFile
    const toResolve = new Set([...newEntryIds, ...this.affectedCallerIds]);
    this.affectedCallerIds.clear();

    this.resolveTargetIds(index, toResolve);
    this.addReverseEdgesForEntries(toResolve, index);
  }

  removeByFile(filePath: string, _index: IFunctionIndexReader): void {
    // Find record IDs from the graph itself (not the index, which may already be cleared)
    // ID format: "filePath::functionName"
    const filePrefix = `${filePath}::`;
    const recordIds = Array.from(this.graph.keys()).filter(id => id.startsWith(filePrefix));

    for (const id of recordIds) {
      const entry = this.graph.get(id);
      if (entry) {
        // Clean forward edges from targets
        for (const call of entry.calls) {
          if (call.resolvedId) {
            const targetEntry = this.graph.get(call.resolvedId);
            if (targetEntry) {
              targetEntry.calledBy = targetEntry.calledBy.filter(c => c.caller !== id);
            }
          }
        }
        // Clean reverse edges from callers + track affected callers for re-resolution
        for (const caller of entry.calledBy) {
          this.affectedCallerIds.add(caller.caller);
          const callerEntry = this.graph.get(caller.caller);
          if (callerEntry) {
            for (const call of callerEntry.calls) {
              if (call.resolvedId === id) call.resolvedId = null;
            }
          }
        }
      }
      this.graph.delete(id);
    }
  }

  // === ICallGraphReader ===

  getEntry(id: string): CallGraphEntry | undefined {
    return this.graph.get(id);
  }

  getTransitive(
    startId: string,
    direction: "downstream" | "upstream",
    maxDepth: number,
    bridgeNode?: (id: string) => string[]
  ): { nodes: Array<{ id: string; depth: number }>; cycles: string[][] } {
    const visited = new Set<string>();
    const bridged = new Set<string>();
    const result: Array<{ id: string; depth: number }> = [];
    const cycles: string[][] = [];
    const parentMap = new Map<string, string | null>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    parentMap.set(startId, null);

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth > maxDepth) continue;

      if (visited.has(id)) {
        // Reconstruct cycle
        const cyclePath: string[] = [id];
        let current = parentMap.get(id) ?? null;
        while (current && current !== id) {
          cyclePath.unshift(current);
          current = parentMap.get(current) ?? null;
        }
        if (current === id) cyclePath.unshift(id);
        cycles.push(cyclePath);
        continue;
      }
      if (bridged.has(id)) continue;
      visited.add(id);
      if (depth > 0) result.push({ id, depth });

      const entry = this.graph.get(id);
      if (!entry) continue;

      const neighbors = direction === "downstream"
        ? entry.calls.filter(c => c.resolvedId).map(c => c.resolvedId!)
        : entry.calledBy.map(c => c.caller);

      if (bridgeNode) {
        for (const bridgeId of bridgeNode(id)) {
          if (visited.has(bridgeId) || bridged.has(bridgeId)) continue;
          bridged.add(bridgeId);
          const bridgeEntry = this.graph.get(bridgeId);
          if (!bridgeEntry) continue;
          const extra = direction === "downstream"
            ? bridgeEntry.calls.filter(c => c.resolvedId).map(c => c.resolvedId!)
            : bridgeEntry.calledBy.map(c => c.caller);
          neighbors.push(...extra);
        }
      }

      for (const neighborId of neighbors) {
        if (!parentMap.has(neighborId)) parentMap.set(neighborId, id);
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }

    return { nodes: result, cycles };
  }

  getStats(): { nodes: number; edges: number; cycles: number } {
    let resolvedEdges = 0;
    for (const entry of this.graph.values()) {
      resolvedEdges += entry.calls.filter(c => c.resolvedId).length;
    }
    return { nodes: this.graph.size, edges: resolvedEdges, cycles: 0 };
  }

  async saveToDisk(cacheDir: string, index: IFunctionIndexReader): Promise<void> {
    const fp = computeIndexFingerprint(index);
    await saveGraphJson(path.join(cacheDir, "call-graph.json"), fp, this.graph);
  }

  async loadFromDisk(cacheDir: string, index: IFunctionIndexReader): Promise<boolean> {
    const fp = computeIndexFingerprint(index);
    const loaded = await loadGraphJson(path.join(cacheDir, "call-graph.json"), fp);
    if (!loaded) return false;
    this.graph = loaded as CallGraph;
    this.affectedCallerIds.clear();
    return true;
  }

  // === Private ===

  /**
   * Parse files and create forward-edge entries in the graph.
   * Shared by build() and buildForFiles() to avoid duplication.
   */
  private async processFiles(
    files: string[],
    index: IFunctionIndexReader,
    projectRoot: string,
  ): Promise<string[]> {
    const processedIds: string[] = [];

    for (const filePath of files) {
      const parser = this.parsers.find(p => p.canParse(filePath));
      if (!parser) continue;

      const absPath = path.join(projectRoot, filePath);
      let source: string;
      try {
        source = await readFile(absPath);
      } catch {
        continue;
      }

      const imports = this.importResolver.resolveImports(source, filePath, projectRoot);

      for (const recordId of index.getFileRecordIds(filePath)) {
        const record = index.getById(recordId);
        if (!record || record.kind === "class") continue;

        const rawCalls = parser.parseCalls(source, record.lineStart, record.lineEnd);
        const resolvedCalls = rawCalls.map(call => {
          const target = call.objectName ? `${call.objectName}.${call.name}` : call.name;
          const resolvedFile = this.resolveCallTarget(call, imports, filePath);
          return { target, resolvedFile, resolvedId: null as string | null, line: call.line };
        });

        this.graph.set(recordId, { calls: resolvedCalls, calledBy: [] });
        processedIds.push(recordId);
      }
    }

    return processedIds;
  }

  private resolveCallTarget(
    call: { name: string; objectName?: string },
    imports: import("../types/index.js").ImportMap,
    _currentFile: string,
  ): string | null {
    if (call.objectName) {
      // obj.method() — check if obj is an imported name
      const imp = imports.get(call.objectName);
      if (imp?.resolvedPath) return imp.resolvedPath;

      // self.method() / this.method() — same file
      if (this.selfKeywords.has(call.objectName)) return null; // Resolved via function name matching
    } else {
      // Direct call: funcName() — check imports
      const imp = imports.get(call.name);
      if (imp?.resolvedPath) return imp.resolvedPath;
    }

    return null;
  }

  /**
   * Resolve call target IDs from file paths + names to concrete record IDs.
   * When scope is provided, only processes those entries (incremental path).
   * Without scope, processes the entire graph (full rebuild).
   */
  private resolveTargetIds(index: IFunctionIndexReader, scope?: Set<string>): void {
    const entries: Iterable<[string, CallGraphEntry]> = scope
      ? Array.from(scope)
          .map(id => [id, this.graph.get(id)] as [string, CallGraphEntry | undefined])
          .filter((pair): pair is [string, CallGraphEntry] => pair[1] !== undefined)
      : this.graph;

    for (const [callerId, entry] of entries) {
      for (const call of entry.calls) {
        if (call.resolvedFile) {
          // Find function in resolved file by name
          const targetName = call.target.split(".").pop()!;
          const fileRecords = index.getByFile(call.resolvedFile);
          const match = fileRecords.find(r =>
            r.name === targetName || r.name.endsWith(`.${targetName}`)
          );
          if (match) call.resolvedId = match.id;
        } else {
          const parts = call.target.split(".");
          if (this.selfKeywords.has(parts[0]) && parts.length === 2) {
            // this.method() — same-class method, search same file
            const methodName = parts[1];
            const callerRecord = index.getById(callerId);
            if (callerRecord) {
              const sameFileRecords = index.getByFile(callerRecord.filePath);
              const match = sameFileRecords.find(r =>
                r.name === methodName || r.name.endsWith(`.${methodName}`)
              );
              if (match) call.resolvedId = match.id;
            }
          } else if (parts.length === 1) {
            // Bare method name — same-file call without self keyword prefix
            const callerRecord = index.getById(callerId);
            if (callerRecord) {
              const sameFileRecords = index.getByFile(callerRecord.filePath);
              const match = sameFileRecords.find(r =>
                r.name === call.target || r.name.endsWith(`.${call.target}`)
              );
              if (match) call.resolvedId = match.id;
            }
          }
          // 3+ parts (this.field.method()) — skip same-file search,
          // let type-aware resolution handle it via resolveViaTypeGraph() below
        }

        // Type-aware resolution for still-unresolved calls
        if (!call.resolvedId && this.typeGraph) {
          const resolved = this.resolveViaTypeGraph(call.target, callerId, index);
          if (resolved) call.resolvedId = resolved;
        }
      }
    }
  }

  /**
   * Resolve interface-based calls using the type graph.
   * Pattern 1: this.field.method() — explicit self-reference (e.g., this.repo.save())
   * Pattern 2: param.method() — function parameter injection (e.g., repo.save() where repo is a param)
   * Pattern 3: field.method() — implicit this (e.g., Java's repo.save() where repo is a class field)
   */
  private resolveViaTypeGraph(
    target: string,
    callerId: string,
    index: IFunctionIndexReader,
  ): string | null {
    const parts = target.split(".");
    if (parts.length < 2 || !this.typeGraph) return null;

    const callerRecord = index.getById(callerId);
    if (!callerRecord) return null;

    // Pattern 1: this.field.method() — 3+ parts starting with self-reference keyword
    if (this.selfKeywords.has(parts[0])) {
      if (parts.length < 3) return null;

      // Find the caller's class name
      const className = callerRecord.name.split(".")[0];
      return this.resolveTypeChain(className, parts.slice(1), index);
    }

    // Pattern 2: param.method() — resolve via function parameter types
    if (callerRecord.paramTypes && parts.length >= 2) {
      const paramType = callerRecord.paramTypes.find(p => p.name === parts[0]);
      if (paramType) {
        return this.resolveTypeChain(paramType.type, parts.slice(1), index);
      }
    }

    // Pattern 3: field.method() — implicit this (Java/C# convention where this. is optional)
    // Check if the first part matches a known class member of the caller's class
    if (parts.length >= 2) {
      const className = callerRecord.name.split(".")[0];
      const memberType = this.typeGraph.getMemberType(className, parts[0]);
      if (memberType) {
        return this.resolveTypeChain(memberType, parts.slice(1), index);
      }
    }

    return null;
  }

  /**
   * Walk a chain of member accesses through the type graph.
   * E.g., for chain ["vectorDb", "vectorSearch"] starting from "HybridSearchPipeline":
   *   HybridSearchPipeline.members["vectorDb"] → "IVectorDatabase"
   *   findImplementorMethod("IVectorDatabase", "vectorSearch") → LanceDBStore.vectorSearch
   */
  private resolveTypeChain(
    startType: string,
    chain: string[],
    index: IFunctionIndexReader,
  ): string | null {
    if (!this.typeGraph || chain.length === 0) return null;

    let currentType = startType;
    // Walk intermediate fields (all but last element)
    for (let i = 0; i < chain.length - 1; i++) {
      const memberType = this.typeGraph.getMemberType(currentType, chain[i]);
      if (!memberType) return null;
      currentType = memberType;
    }

    // Last element is the method name — find it on the resolved type
    const methodName = chain[chain.length - 1];
    return this.findImplementorMethod(currentType, methodName, index);
  }

  /**
   * Find a method on a type or its implementors/extenders.
   */
  private findImplementorMethod(
    typeName: string,
    methodName: string,
    index: IFunctionIndexReader,
  ): string | null {
    if (!this.typeGraph) return null;

    // Try direct: the type itself might be a concrete class with the method
    const typeNode = this.typeGraph.getTypeNode(typeName);
    if (typeNode?.filePath) {
      const fileRecords = index.getByFile(typeNode.filePath);
      const match = fileRecords.find(r =>
        r.name === `${typeName}.${methodName}` || r.name.endsWith(`.${methodName}`)
      );
      if (match) return match.id;
    }

    // Try implementors
    const implementors = this.typeGraph.getImplementors(typeName);
    for (const implId of implementors) {
      const sep = implId.indexOf("::");
      if (sep === -1) continue;
      const filePath = implId.slice(0, sep);
      const implClassName = implId.slice(sep + 2);
      const fileRecords = index.getByFile(filePath);
      const match = fileRecords.find(r => r.name === `${implClassName}.${methodName}`);
      if (match) return match.id;
    }

    // Try extenders (for abstract base classes)
    const extenders = this.typeGraph.getExtenders(typeName);
    for (const extId of extenders) {
      const sep = extId.indexOf("::");
      if (sep === -1) continue;
      const filePath = extId.slice(0, sep);
      const extClassName = extId.slice(sep + 2);
      const fileRecords = index.getByFile(filePath);
      const match = fileRecords.find(r => r.name === `${extClassName}.${methodName}`);
      if (match) return match.id;
    }

    return null;
  }

  /**
   * Add reverse edges (calledBy) for specific entries only.
   * Used by incremental path — avoids clearing and rebuilding the entire reverse graph.
   * The alreadyTracked check prevents duplicates when processing affected callers
   * that already have reverse edges for their non-nullified calls.
   */
  private addReverseEdgesForEntries(entryIds: Set<string>, index: IFunctionIndexReader): void {
    for (const callerId of entryIds) {
      const entry = this.graph.get(callerId);
      if (!entry) continue;
      const callerRecord = index.getById(callerId);
      if (!callerRecord) continue;

      for (const call of entry.calls) {
        if (!call.resolvedId) continue;
        const targetEntry = this.graph.get(call.resolvedId);
        if (!targetEntry) continue;

        const alreadyTracked = targetEntry.calledBy.some(c => c.caller === callerId);
        if (!alreadyTracked) {
          targetEntry.calledBy.push({
            caller: callerId,
            callerName: callerRecord.name,
            file: callerRecord.filePath,
            line: call.line,
          });
        }
      }
    }
  }

  /**
   * Build the complete reverse graph from scratch.
   * Used by full rebuild only — clears all calledBy arrays and rebuilds from forward edges.
   */
  private buildReverseGraph(index: IFunctionIndexReader): void {
    // Clear all calledBy arrays first to avoid stale/duplicate entries
    for (const entry of this.graph.values()) {
      entry.calledBy = [];
    }

    for (const [callerId, entry] of this.graph) {
      for (const call of entry.calls) {
        if (call.resolvedId) {
          const callerRecord = index.getById(callerId);
          if (!callerRecord) continue;
          const targetEntry = this.graph.get(call.resolvedId);
          if (targetEntry) {
            // Deduplicate: one calledBy entry per unique caller (a function may call
            // the same target multiple times at different lines — only track the link once)
            const alreadyTracked = targetEntry.calledBy.some(c => c.caller === callerId);
            if (!alreadyTracked) {
              targetEntry.calledBy.push({
                caller: callerId,
                callerName: callerRecord.name,
                file: callerRecord.filePath,
                line: call.line,
              });
            }
          }
        }
      }
    }
  }

  clear(): void {
    this.graph.clear();
    this.affectedCallerIds.clear();
  }
}
