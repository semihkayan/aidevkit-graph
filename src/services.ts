import path from "node:path";
import type { AppContext, WorkspaceServices, IFileWatcher } from "./types/interfaces.js";
import { FunctionIndex } from "./core/function-index.js";
import { SourceExtractor } from "./core/source-extractor.js";
import { JsonFileRecordStore } from "./core/record-store-json.js";
import { HashBasedStalenessChecker } from "./core/staleness-hash.js";
import { DocstringParser } from "./core/docstring-parser.js";
import { createTreeSitterParsers } from "./parsers/registry.js";
import { ImportResolver } from "./core/import-resolver.js";
import { CallGraphManager } from "./core/call-graph.js";
import { OllamaEmbeddingProvider } from "./core/embedders/ollama.js";
import { LanceDBStore } from "./core/vector-db/lancedb.js";
import { RRFMerger } from "./core/search/rrf-merger.js";
import { HybridSearchPipeline } from "./core/search/hybrid-pipeline.js";
import { TypeGraphManager } from "./core/type-graph/type-graph.js";
import { FileWatcher } from "./core/watcher/file-watcher.js";
import { ReindexOrchestrator } from "./core/reindex-orchestrator.js";
import { detectWorkspaces } from "./core/workspace-detector.js";
import { loadConfig } from "./utils/config.js";
import { GitService } from "./utils/git-utils.js";
import { logger } from "./utils/logger.js";

export async function createServices(projectRoot?: string): Promise<AppContext> {
  const config = await loadConfig(projectRoot);

  // Workspace detection
  const workspacePaths = await detectWorkspaces(config.projectRoot, config.workspaces);
  const isMultiWorkspace = workspacePaths.length > 1;
  logger.info({ workspaces: workspacePaths }, `Detected ${workspacePaths.length} workspace(s)`);

  // Shared services
  const parsers = createTreeSitterParsers(config.parser);
  const docstringParser = new DocstringParser();
  const embedding = new OllamaEmbeddingProvider(
    config.embedding.ollamaUrl,
    config.embedding.model,
    config.embedding.dimensions,
    config.embedding.instruction,
  );
  const merger = new RRFMerger(config.search.rrfK);
  const reindexOrchestrator = new ReindexOrchestrator(embedding, parsers, config);

  // File watcher — routes files to correct workspace, delegates to orchestrator
  const watcher = new FileWatcher(config, async (changedFiles: string[]) => {
    const filesByWorkspace = new Map<string, string[]>();
    for (const file of changedFiles) {
      const relPath = path.relative(config.projectRoot, file);
      const wsPath = workspacePaths.find(ws => ws === "." || relPath.startsWith(ws + "/")) || ".";
      if (!filesByWorkspace.has(wsPath)) filesByWorkspace.set(wsPath, []);
      filesByWorkspace.get(wsPath)!.push(file);
    }

    for (const [wsPath, files] of filesByWorkspace) {
      const ws = workspaces.get(wsPath);
      if (!ws) continue;
      await reindexOrchestrator.handleFileChanges(ws, wsPath, files);
    }
  });

  // Per-workspace services
  const workspaces = new Map<string, WorkspaceServices>();

  for (const wsPath of workspacePaths) {
    const wsRoot = wsPath === "." ? config.projectRoot : path.join(config.projectRoot, wsPath);
    const cacheDir = wsPath === "."
      ? path.join(config.projectRoot, ".code-context", "ast-cache")
      : path.join(config.projectRoot, ".code-context", "ast-cache", wsPath);

    const recordStore = new JsonFileRecordStore(cacheDir);
    const staleness = new HashBasedStalenessChecker(config);
    const functionIndex = new FunctionIndex(parsers, recordStore, staleness, docstringParser, config, wsRoot);
    const sourceExtractor = new SourceExtractor(functionIndex, wsRoot);

    // Vector DB + Search pipeline — real implementation
    const lanceStore = new LanceDBStore();
    const searchPipeline = new HybridSearchPipeline(lanceStore, lanceStore, merger, embedding);

    // Call graph + type graph — real implementation
    const importResolver = new ImportResolver(parsers);
    const typeGraphManager = new TypeGraphManager();
    const callGraphManager = new CallGraphManager(importResolver, parsers, typeGraphManager);

    workspaces.set(wsPath, {
      index: functionIndex,
      indexWriter: functionIndex,
      source: sourceExtractor,
      search: searchPipeline,
      callGraph: callGraphManager,
      callGraphWriter: callGraphManager,
      typeGraph: typeGraphManager,
      typeGraphWriter: typeGraphManager,
      vectorDb: lanceStore,
      projectRoot: wsRoot,
    });
  }

  // Workspace resolver
  function resolveWorkspace(wsParam?: string): WorkspaceServices {
    if (workspaces.size === 1) return workspaces.values().next().value!;
    if (!wsParam) {
      const available = Array.from(workspaces.keys());
      throw { error: "WORKSPACE_REQUIRED", message: "Multiple workspaces detected. Specify workspace parameter.", workspaces: available };
    }
    const ws = workspaces.get(wsParam);
    if (!ws) {
      const available = Array.from(workspaces.keys());
      throw { error: "WORKSPACE_NOT_FOUND", message: `Workspace '${wsParam}' not found.`, workspaces: available };
    }
    return ws;
  }

  return {
    resolveWorkspace,
    workspacePaths,
    isMultiWorkspace,
    config,
    embedding,
    embeddingAvailable: await embedding.isAvailable(),
    parsers,
    watcher,
    git: new GitService(),
    reindex: reindexOrchestrator,
    ready: false,
    async shutdown() {
      logger.info("Shutting down...");
      watcher.stop();
      for (const [wsPath, ws] of workspaces) {
        try {
          await ws.indexWriter.saveToDisk();
          const graphCacheDir = wsPath === "."
            ? path.join(config.projectRoot, ".code-context")
            : path.join(config.projectRoot, ".code-context", wsPath);
          await ws.callGraphWriter.saveToDisk(graphCacheDir, ws.index);
          await ws.typeGraphWriter.saveToDisk(graphCacheDir, ws.index);
          await ws.vectorDb.close?.();
        } catch (err) {
          logger.error({ workspace: wsPath, err }, "Failed to save on shutdown");
        }
      }
    },
  };
}
