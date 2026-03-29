import type {
  ICallGraphReader, ICallGraphWriter, IFunctionIndexReader, IImportResolver, ILanguageParser,
} from "../types/interfaces.js";
import type { CallGraph, CallGraphEntry } from "../types/index.js";
import { readFile } from "../utils/file-utils.js";
import { computeIndexFingerprint, saveGraphJson, loadGraphJson } from "../utils/graph-persistence.js";
import path from "node:path";

export class CallGraphManager implements ICallGraphReader, ICallGraphWriter {
  private graph: CallGraph = new Map();

  constructor(
    private importResolver: IImportResolver,
    private parsers: ILanguageParser[],
  ) {}

  // === ICallGraphWriter ===

  async build(index: IFunctionIndexReader, projectRoot: string): Promise<CallGraph> {
    this.graph.clear();

    for (const filePath of index.getAllFilePaths()) {
      const parser = this.parsers.find(p => p.canParse(filePath));
      if (!parser) continue;

      const absPath = path.join(projectRoot, filePath);
      let source: string;
      try {
        source = await readFile(absPath);
      } catch {
        continue; // File may have been deleted
      }

      const imports = this.importResolver.resolveImports(source, filePath, projectRoot);
      const recordIds = index.getFileRecordIds(filePath);

      for (const recordId of recordIds) {
        const record = index.getById(recordId);
        if (!record || record.kind === "class") continue; // Skip class records, process methods

        const rawCalls = parser.parseCalls(source, record.lineStart, record.lineEnd);

        const resolvedCalls = rawCalls.map(call => {
          const target = call.objectName ? `${call.objectName}.${call.name}` : call.name;
          const resolvedFile = this.resolveCallTarget(call, imports, filePath);
          return {
            target,
            resolvedFile,
            resolvedId: null as string | null,
            line: call.line,
          };
        });

        this.graph.set(recordId, { calls: resolvedCalls, calledBy: [] });
      }
    }

    // Resolve target IDs + build reverse graph
    this.resolveTargetIds(index);
    this.buildReverseGraph(index);

    return this.graph;
  }

  removeByFile(filePath: string, index: IFunctionIndexReader): void {
    const recordIds = index.getByFile(filePath).map(r => r.id);
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
        // Clean reverse edges from callers
        for (const caller of entry.calledBy) {
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
    maxDepth: number
  ): { nodes: Array<{ id: string; depth: number }>; cycles: string[][] } {
    const visited = new Set<string>();
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
      visited.add(id);
      if (depth > 0) result.push({ id, depth });

      const entry = this.graph.get(id);
      if (!entry) continue;

      const neighbors = direction === "downstream"
        ? entry.calls.filter(c => c.resolvedId).map(c => c.resolvedId!)
        : entry.calledBy.map(c => c.caller);

      for (const neighborId of neighbors) {
        if (!parentMap.has(neighborId)) parentMap.set(neighborId, id);
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }

    return { nodes: result, cycles };
  }

  getStats(): { nodes: number; edges: number; cycles: number } {
    let totalEdges = 0;
    let resolvedEdges = 0;
    for (const entry of this.graph.values()) {
      totalEdges += entry.calls.length;
      resolvedEdges += entry.calls.filter(c => c.resolvedId).length;
    }
    return { nodes: this.graph.size, edges: resolvedEdges, totalEdges, cycles: 0 } as any;
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
    return true;
  }

  // === Private ===

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
      if (call.objectName === "self" || call.objectName === "this") return null; // Resolved via function name matching
    } else {
      // Direct call: funcName() — check imports
      const imp = imports.get(call.name);
      if (imp?.resolvedPath) return imp.resolvedPath;
    }

    return null;
  }

  private resolveTargetIds(index: IFunctionIndexReader): void {
    for (const [_callerId, entry] of this.graph) {
      for (const call of entry.calls) {
        if (call.resolvedFile) {
          // Find function in resolved file by name
          const targetName = call.target.split(".").pop()!;
          const fileRecords = index.getByFile(call.resolvedFile);
          const match = fileRecords.find(r =>
            r.name === targetName || r.name.endsWith(`.${targetName}`)
          );
          if (match) call.resolvedId = match.id;
        } else if (call.target.startsWith("self.") || call.target.startsWith("this.")) {
          // self.method() or this.method() — find in same file only
          const methodName = call.target.split(".").pop()!;
          const callerRecord = index.getById(_callerId);
          if (callerRecord) {
            const sameFileRecords = index.getByFile(callerRecord.filePath);
            const match = sameFileRecords.find(r =>
              r.name === methodName || r.name.endsWith(`.${methodName}`)
            );
            if (match) call.resolvedId = match.id;
          }
        }
      }
    }
  }

  private buildReverseGraph(index: IFunctionIndexReader): void {
    for (const [callerId, entry] of this.graph) {
      for (const call of entry.calls) {
        if (call.resolvedId) {
          const callerRecord = index.getById(callerId);
          if (!callerRecord) continue;
          const targetEntry = this.graph.get(call.resolvedId);
          if (targetEntry) {
            // Avoid duplicates
            if (!targetEntry.calledBy.some(c => c.caller === callerId && c.line === call.line)) {
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
}
