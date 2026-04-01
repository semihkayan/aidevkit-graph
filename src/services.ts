import path from "node:path";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { execSync } from "node:child_process";
import type { AppContext, WorkspaceServices } from "./types/interfaces.js";
import { reembedFunctions } from "./core/reembed.js";
import { FunctionIndex } from "./core/function-index.js";
import { SourceExtractor } from "./core/source-extractor.js";
import { JsonFileRecordStore } from "./core/record-store-json.js";
import { HashBasedStalenessChecker } from "./core/staleness-hash.js";
import { DocstringParser } from "./core/docstring-parser.js";
import { createTreeSitterParsers, aggregateTestMetadata, aggregateNoiseMetadata, aggregateLanguageConventions } from "./parsers/registry.js";
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
import { normalizeModuleQuery } from "./utils/file-utils.js";
import { GitService } from "./utils/git-utils.js";
import { logger } from "./utils/logger.js";

export async function createServices(projectRoot?: string): Promise<AppContext> {
  const config = await loadConfig(projectRoot);

  // Shared services — parsers first (needed for workspace detection via conventions)
  const parsers = createTreeSitterParsers(config.parser);
  const testMetadata = aggregateTestMetadata(parsers);
  const noiseFilter = aggregateNoiseMetadata(parsers);
  const conventions = aggregateLanguageConventions(parsers);

  // Workspace detection — uses manifests from parser conventions
  const workspacePaths = await detectWorkspaces(
    config.projectRoot, config.workspaces,
    conventions.workspaceManifests, conventions.workspaceManifestExtensions,
  );
  const isMultiWorkspace = workspacePaths.length > 1;
  logger.info({ workspaces: workspacePaths }, `Detected ${workspacePaths.length} workspace(s)`);
  const docstringParser = new DocstringParser();
  const embedding = new OllamaEmbeddingProvider(
    config.embedding.ollamaUrl,
    config.embedding.model,
    config.embedding.dimensions,
    config.embedding.instruction,
  );
  const merger = new RRFMerger(config.search.rrfK);
  const reindexOrchestrator = new ReindexOrchestrator(embedding, parsers, config, conventions);

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
    const functionIndex = new FunctionIndex(parsers, recordStore, staleness, docstringParser, config, wsRoot, testMetadata, conventions);
    const sourceExtractor = new SourceExtractor(functionIndex, wsRoot);

    // Vector DB + Search pipeline — real implementation
    const lanceStore = new LanceDBStore();
    const searchPipeline = new HybridSearchPipeline(lanceStore, lanceStore, merger, embedding);

    // Call graph + type graph — real implementation
    const importResolver = new ImportResolver(parsers);
    const typeGraphManager = new TypeGraphManager();
    const callGraphManager = new CallGraphManager(importResolver, parsers, typeGraphManager, conventions);

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
    normalizeModuleQuery: (query: string) => normalizeModuleQuery(query, config.parser.sourceRoot, conventions.sourceRoots),
    workspacePaths,
    isMultiWorkspace,
    config,
    embedding,
    embeddingAvailable: false,
    parsers,
    conventions,
    noiseFilter,
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

export interface WorkspaceEmbedPlan {
  freshBuild: boolean;
  staleIds: string[];
  vectorCount: number;
}

/**
 * Initialize all workspaces: load/build AST index, vector DB, type graph, call graph.
 * Returns per-workspace embed metadata for backgroundEmbed().
 * Shared between MCP server (index.ts) and test harness.
 */
export async function initializeWorkspaces(ctx: AppContext, opts?: {
  refreshStale?: boolean;
}): Promise<Map<string, WorkspaceEmbedPlan>> {
  const refreshStale = opts?.refreshStale !== false;
  const embedPlans = new Map<string, WorkspaceEmbedPlan>();

  for (const wsPath of ctx.workspacePaths) {
    try {
      const ws = ctx.resolveWorkspace(wsPath);
      await ws.indexWriter.loadFromDisk();

      const stats = ws.index.getStats();
      let staleIds: string[] = [];
      let freshBuild = false;
      if (stats.files === 0) {
        logger.info({ workspace: wsPath }, "Empty index, building...");
        await ws.indexWriter.buildFull(ws.projectRoot);
        await ws.indexWriter.saveToDisk();
        freshBuild = true;
        logger.info({ workspace: wsPath, ...ws.index.getStats() }, "Index built");
      } else {
        logger.info({ workspace: wsPath, ...stats }, "Index loaded from cache");
        if (refreshStale) {
          staleIds = await ws.indexWriter.refreshStale(ws.projectRoot);
          if (staleIds.length > 0) {
            await ws.indexWriter.saveToDisk();
            logger.info({ workspace: wsPath, updated: staleIds.length }, "Stale files refreshed");
          }
        }
      }

      // Vector DB
      const lancePath = path.join(ctx.config.projectRoot, ".code-context", "lance");
      const tableName = wsPath === "." ? "functions" : `${wsPath}_functions`;
      await ws.vectorDb.initialize(lancePath, tableName);
      const vectorCount = await ws.vectorDb.countRows();
      logger.info({ workspace: wsPath, vectorCount }, "Vector DB initialized");

      // Graphs — type graph first (call graph uses it for interface resolution)
      const graphCacheDir = wsPath === "."
        ? path.join(ctx.config.projectRoot, ".code-context")
        : path.join(ctx.config.projectRoot, ".code-context", wsPath);

      const tgLoaded = await ws.typeGraphWriter.loadFromDisk(graphCacheDir, ws.index);
      if (!tgLoaded) {
        await ws.typeGraphWriter.build(ws.index, ctx.parsers, ws.projectRoot);
        await ws.typeGraphWriter.saveToDisk(graphCacheDir, ws.index);
      }

      const cgLoaded = await ws.callGraphWriter.loadFromDisk(graphCacheDir, ws.index);
      if (!cgLoaded) {
        await ws.callGraphWriter.build(ws.index, ws.projectRoot);
        await ws.callGraphWriter.saveToDisk(graphCacheDir, ws.index);
      }

      const cgStats = ws.callGraph.getStats();
      const tgStats = ws.typeGraph.getStats();
      logger.info({ workspace: wsPath, ...cgStats, ...tgStats, fromCache: cgLoaded && tgLoaded },
        cgLoaded && tgLoaded ? "Graphs loaded from cache" : "Graphs built");

      embedPlans.set(wsPath, { freshBuild, staleIds, vectorCount });
    } catch (err) {
      logger.error({ workspace: wsPath, err }, "Workspace initialization failed, skipping");
    }
  }

  ctx.ready = true;
  return embedPlans;
}

/**
 * Background embedding: check Ollama, then embed based on the plan from
 * initializeWorkspaces. Sets ctx.embeddingAvailable as a side effect.
 * Fire-and-forget after server.connect().
 */
export async function backgroundEmbed(
  ctx: AppContext,
  plans: Map<string, WorkspaceEmbedPlan>,
): Promise<void> {
  ctx.embeddingAvailable = await ctx.embedding.isAvailable();
  if (!ctx.embeddingAvailable) {
    logger.info("Embedding unavailable (Ollama not running), skipping background embed");
    return;
  }

  for (const [wsPath, plan] of plans) {
    try {
      const ws = ctx.resolveWorkspace(wsPath);
      if (plan.vectorCount === 0 || plan.freshBuild) {
        const allIds = ws.index.getAllFilePaths().flatMap(fp => ws.index.getFileRecordIds(fp));
        if (allIds.length === 0) continue;
        logger.info({ workspace: wsPath, functions: allIds.length }, "Embedding all functions...");
        await reembedFunctions(allIds, ws.index, ctx.embedding, ws.vectorDb, ctx.config, ws.callGraph);
        logger.info({ workspace: wsPath, embedded: await ws.vectorDb.countRows() }, "Background embedding complete");
      } else if (plan.staleIds.length > 0) {
        const deletedIds = plan.staleIds.filter(id => !ws.index.getById(id));
        const changedIds = plan.staleIds.filter(id => ws.index.getById(id));
        if (deletedIds.length > 0) await ws.vectorDb.deleteByIds(deletedIds);
        if (changedIds.length > 0) {
          await reembedFunctions(changedIds, ws.index, ctx.embedding, ws.vectorDb, ctx.config, ws.callGraph);
        }
        logger.info({ workspace: wsPath, reembedded: changedIds.length, deleted: deletedIds.length }, "Stale vectors updated");
      }
    } catch (err) {
      logger.error({ workspace: wsPath, err }, "Background embedding failed for workspace");
    }
  }
}

/**
 * In a git worktree with no cache, copy the main repo's .code-context/
 * for a fast warm start. Worktree is fully isolated after the copy.
 */
export async function seedCacheFromMainRepo(projectRoot: string): Promise<boolean> {
  const cacheDir = path.join(projectRoot, ".code-context");

  // Already has cache? Nothing to seed.
  if (existsSync(path.join(cacheDir, "ast-cache"))) return false;

  // Detect git worktree — git-common-dir differs from ".git" only in worktrees
  let mainRepoRoot: string;
  try {
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: projectRoot, encoding: "utf-8", timeout: 5000,
    }).trim();
    if (gitCommonDir === ".git" || gitCommonDir === path.join(projectRoot, ".git")) {
      return false; // main checkout, not a worktree
    }
    mainRepoRoot = path.dirname(gitCommonDir);
  } catch {
    return false; // not a git repo or git not available
  }

  // Check if main repo has cache
  const mainCache = path.join(mainRepoRoot, ".code-context");
  if (!existsSync(path.join(mainCache, "ast-cache"))) return false;

  // Copy cache, excluding per-process files
  const skipFiles = new Set(["server.log", "server.pid"]);
  try {
    await cp(mainCache, cacheDir, {
      recursive: true,
      filter: (src) => !skipFiles.has(path.basename(src)),
    });
    logger.info({ from: mainCache, to: cacheDir }, "Seeded cache from main repo");
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to seed cache from main repo, will cold start");
    return false;
  }
}
