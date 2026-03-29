import path from "node:path";
import type {
  IReindexOrchestrator, IEmbeddingProvider, ILanguageParser,
  WorkspaceServices, Config, ReindexResult,
} from "../types/interfaces.js";
import { reembedFunctions } from "./reembed.js";
import { logger } from "../utils/logger.js";

export class ReindexOrchestrator implements IReindexOrchestrator {
  constructor(
    private embedding: IEmbeddingProvider,
    private parsers: ILanguageParser[],
    private config: Config,
  ) {}

  async reindexFull(ws: WorkspaceServices, wsPath: string): Promise<ReindexResult> {
    const start = Date.now();
    await ws.indexWriter.buildFull(ws.projectRoot);

    const allIds = ws.index.getAllFilePaths().flatMap(fp => ws.index.getFileRecordIds(fp));
    const embedded = await this.embedIfAvailable(allIds, ws);

    await this.rebuildGraphs(ws, wsPath);
    await ws.indexWriter.saveToDisk();

    return { mode: "full_rebuild", changedFunctions: allIds.length, embedded, elapsedMs: Date.now() - start };
  }

  async reindexIncremental(ws: WorkspaceServices, wsPath: string): Promise<ReindexResult> {
    const start = Date.now();
    const changedIds = await ws.indexWriter.refreshStale(ws.projectRoot);

    const embedded = changedIds.length > 0
      ? await this.embedIfAvailable(changedIds, ws)
      : 0;

    if (changedIds.length > 0) {
      await this.rebuildGraphs(ws, wsPath);
      await ws.indexWriter.saveToDisk();
    }

    return { mode: "incremental", changedFunctions: changedIds.length, embedded, elapsedMs: Date.now() - start };
  }

  async reindexFiles(ws: WorkspaceServices, wsPath: string, files: string[]): Promise<ReindexResult> {
    const start = Date.now();
    const changedIds = await ws.indexWriter.updateFiles(files);

    const embedded = changedIds.length > 0
      ? await this.embedIfAvailable(changedIds, ws)
      : 0;

    if (changedIds.length > 0) {
      await this.rebuildGraphs(ws, wsPath);
      await ws.indexWriter.saveToDisk();
    }

    return { mode: "specific_files", changedFunctions: changedIds.length, embedded, elapsedMs: Date.now() - start };
  }

  async handleFileChanges(ws: WorkspaceServices, wsPath: string, changedFiles: string[]): Promise<void> {
    // Capture old IDs before update (for cleanup of deleted functions)
    const oldIds: string[] = [];
    for (const file of changedFiles) {
      const relPath = path.relative(ws.projectRoot, file);
      oldIds.push(...ws.index.getFileRecordIds(relPath));
    }

    const changedIds = await ws.indexWriter.updateFiles(changedFiles);
    if (changedIds.length === 0 && oldIds.length === 0) return;

    // Clean up vectors for deleted functions
    const deletedIds = oldIds.filter(id => !changedIds.includes(id) && !ws.index.getById(id));
    if (deletedIds.length > 0) {
      await ws.vectorDb.deleteByIds(deletedIds);
    }

    // Re-embed changed functions
    try {
      if (await this.embedding.isAvailable()) {
        await reembedFunctions(changedIds, ws.index, this.embedding, ws.vectorDb, this.config);
      }
    } catch (err) {
      logger.warn({ err }, "Watcher re-embed failed");
    }

    // Incremental graph rebuild for affected files
    const changedFilePaths = Array.from(new Set(
      changedIds.map(id => ws.index.getById(id)?.filePath).filter(Boolean) as string[]
    ));
    const deletedFilePaths = Array.from(new Set(
      deletedIds.map(id => {
        const sep = id.indexOf("::");
        return sep !== -1 ? id.slice(0, sep) : null;
      }).filter(Boolean) as string[]
    ));
    const allAffectedFiles = Array.from(new Set([...changedFilePaths, ...deletedFilePaths]));

    for (const f of allAffectedFiles) {
      ws.typeGraphWriter.removeByFile(f);
      ws.callGraphWriter.removeByFile(f, ws.index);
    }
    // Type graph first — call graph uses it for interface-based resolution
    await ws.typeGraphWriter.buildForFiles(changedFilePaths, ws.index, this.parsers, ws.projectRoot);
    await ws.callGraphWriter.buildForFiles(changedFilePaths, ws.index, ws.projectRoot);
    await ws.indexWriter.saveToDisk();
    await this.saveGraphs(ws, wsPath);

    logger.info({ workspace: wsPath, functions: changedIds.length, files: changedFiles.length }, "Reindex complete");
  }

  // === Private ===

  private async embedIfAvailable(ids: string[], ws: WorkspaceServices): Promise<number> {
    try {
      if (await this.embedding.isAvailable()) {
        await reembedFunctions(ids, ws.index, this.embedding, ws.vectorDb, this.config);
        return ids.length;
      }
    } catch (err) {
      logger.warn({ err }, "Embedding failed");
    }
    return 0;
  }

  private async rebuildGraphs(ws: WorkspaceServices, wsPath: string): Promise<void> {
    // Type graph first — call graph uses it for interface-based resolution
    await ws.typeGraphWriter.build(ws.index, this.parsers, ws.projectRoot);
    await ws.callGraphWriter.build(ws.index, ws.projectRoot);
    await this.saveGraphs(ws, wsPath);
  }

  private async saveGraphs(ws: WorkspaceServices, wsPath: string): Promise<void> {
    const graphCacheDir = this.getGraphCacheDir(wsPath);
    await ws.callGraphWriter.saveToDisk(graphCacheDir, ws.index);
    await ws.typeGraphWriter.saveToDisk(graphCacheDir, ws.index);
  }

  private getGraphCacheDir(wsPath: string): string {
    return wsPath === "."
      ? path.join(this.config.projectRoot, ".code-context")
      : path.join(this.config.projectRoot, ".code-context", wsPath);
  }
}
