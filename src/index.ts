#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createServices } from "./services.js";
import { reembedFunctions } from "./core/reembed.js";
import { logger } from "./utils/logger.js";

// Schemas
import {
  SemanticSearchSchema, ModuleSummarySchema, FunctionSourceSchema,
  IndexStatusSchema,
  DependenciesSchema, ImpactAnalysisSchema,
  StaleDocstringsSchema, ReindexSchema,
} from "./tools/schemas.js";

// Handlers
import { handleModuleSummary } from "./tools/module-summary.js";
import { handleFunctionSource } from "./tools/function-source.js";
import { handleIndexStatus } from "./tools/index-status.js";
import { handleSemanticSearch } from "./tools/semantic-search.js";
import { handleDependencies } from "./tools/dependencies.js";
import { handleImpactAnalysis } from "./tools/impact-analysis.js";
import { handleStaleDocstrings } from "./tools/stale-docstrings.js";
import { handleReindex } from "./tools/reindex.js";

async function main() {
  const services = await createServices();
  logger.info({ projectRoot: services.config.projectRoot }, "Code Intelligence MCP Server starting");

  // MCP Server — connect FIRST so Claude Code doesn't timeout
  const server = new McpServer({ name: "code-intelligence", version: "0.1.0" });
  const ctx = services;

  server.registerTool("semantic_search", {
    description: "Search the codebase by meaning. Works across all workspaces automatically in monorepos. Use as the FIRST STEP when looking for code related to a concept, feature, or bug — before grep or reading files. Finds functions even when you don't know exact names. Results include workspace, signature, body size, summary, and file location to help you decide what to open.",
    inputSchema: SemanticSearchSchema.shape,
  }, (args) => handleSemanticSearch(args as any, ctx));

  server.registerTool("get_module_summary", {
    description: "List all functions and classes in a directory with their signatures. Use BEFORE reading files to understand what a module contains — saves tokens by showing metadata without source code. Auto-adapts detail level: full for small modules, compact for large ones.",
    inputSchema: ModuleSummarySchema.shape,
  }, (args) => handleModuleSummary(args as any, ctx));

  server.registerTool("get_function_source", {
    description: "Get the source code of a specific function by name. Use INSTEAD OF reading entire files — returns only the function you need, saving tokens. Supports surrounding context lines.",
    inputSchema: FunctionSourceSchema.shape,
  }, (args) => handleFunctionSource(args as any, ctx));

  server.registerTool("get_dependencies", {
    description: "Show what a function calls — its forward dependencies. Cross-validates AST analysis with @deps docstring annotations. Categorizes each dependency as confirmed (AST+docstring), AST-only, docstring-only, or unresolved.",
    inputSchema: DependenciesSchema.shape,
  }, (args) => handleDependencies(args as any, ctx));

  server.registerTool("get_impact_analysis", {
    description: "Assess the blast radius of changing a function. Use BEFORE refactoring or modifying signatures. Combines call graph + type graph to find all affected code. Returns risk levels: high (direct callers + signature change), medium (indirect), low (transitive).",
    inputSchema: ImpactAnalysisSchema.shape,
  }, (args) => handleImpactAnalysis(args as any, ctx));

  server.registerTool("get_stale_docstrings", {
    description: "Find functions with missing or outdated docstrings. Detects: missing docstrings, @deps that don't match actual AST calls, missing @tags. Use for codebase hygiene.",
    inputSchema: StaleDocstringsSchema.shape,
  }, (args) => handleStaleDocstrings(args as any, ctx));

  server.registerTool("reindex", {
    description: "Manually update the code index. Usually not needed — the server auto-reindexes on file changes. Use after bulk operations or if index seems stale.",
    inputSchema: ReindexSchema.shape,
  }, (args) => handleReindex(args as any, ctx));

  server.registerTool("get_index_status", {
    description: "Check index health: how many files/functions are indexed, embedding status, call graph stats, docstring coverage, and language breakdown.",
    inputSchema: IndexStatusSchema.shape,
  }, (args) => handleIndexStatus(args as any, ctx));

  // PID lock file — prevents codeweave-init --force from running while server is active
  const lockPath = path.join(services.config.projectRoot, ".code-context", "server.pid");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);
  const removeLock = () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };

  // Graceful shutdown with timeout
  const shutdown = () => {
    removeLock();
    const forceExit = setTimeout(() => process.exit(1), 10000);
    services.shutdown().then(() => { clearTimeout(forceExit); process.exit(0); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", removeLock);

  // Connect transport immediately — MCP handshake completes fast
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected via stdio");

  // Initialize index AFTER connection — heavy work in background
  for (const wsPath of services.workspacePaths) {
    const ws = services.resolveWorkspace(wsPath);
    await ws.indexWriter.loadFromDisk();

    const stats = ws.index.getStats();
    let staleIds: string[] = [];
    let freshBuild = false;
    if (stats.files === 0) {
      logger.info({ workspace: wsPath }, "Empty index, building...");
      await ws.indexWriter.buildFull(ws.projectRoot);
      await ws.indexWriter.saveToDisk();
      freshBuild = true;
      const newStats = ws.index.getStats();
      logger.info({ workspace: wsPath, ...newStats }, "Index built");
    } else {
      logger.info({ workspace: wsPath, ...stats }, "Index loaded from cache");
      // Check for files changed while server was offline
      staleIds = await ws.indexWriter.refreshStale(ws.projectRoot);
      if (staleIds.length > 0) {
        await ws.indexWriter.saveToDisk();
        logger.info({ workspace: wsPath, updated: staleIds.length }, "Stale files refreshed");
      }
    }

    // Initialize vector DB
    const lancePath = path.join(services.config.projectRoot, ".code-context", "lance");
    const tableName = wsPath === "." ? "functions" : `${wsPath}_functions`;
    await ws.vectorDb.initialize(lancePath, tableName);
    const vectorCount = await ws.vectorDb.countRows();
    logger.info({ workspace: wsPath, vectorCount }, "Vector DB initialized");

    // Graphs BEFORE embedding — call graph data enriches embedding chunks
    const graphCacheDir = wsPath === "."
      ? path.join(services.config.projectRoot, ".code-context")
      : path.join(services.config.projectRoot, ".code-context", wsPath);

    // Type graph FIRST — call graph uses it for interface-based resolution
    const tgLoaded = await ws.typeGraphWriter.loadFromDisk(graphCacheDir, ws.index);
    if (!tgLoaded) {
      await ws.typeGraphWriter.build(ws.index, services.parsers, ws.projectRoot);
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

    // Embed — now has call graph available for chunk enrichment
    // freshBuild: after cache version bump, old vectors are stale — rebuild all
    if (services.embeddingAvailable && (vectorCount === 0 || freshBuild)) {
      logger.info({ workspace: wsPath }, "Embedding all functions...");
      const allIds = ws.index.getAllFilePaths().flatMap(fp => ws.index.getFileRecordIds(fp));
      await reembedFunctions(allIds, ws.index, services.embedding, ws.vectorDb, services.config, ws.callGraph);
      const newCount = await ws.vectorDb.countRows();
      logger.info({ workspace: wsPath, embedded: newCount }, "Embedding complete");
    } else if (services.embeddingAvailable && staleIds.length > 0) {
      // Re-embed stale functions + clean orphan vectors for deleted ones
      const deletedIds = staleIds.filter(id => !ws.index.getById(id));
      const changedIds = staleIds.filter(id => ws.index.getById(id));
      if (deletedIds.length > 0) {
        await ws.vectorDb.deleteByIds(deletedIds);
      }
      if (changedIds.length > 0) {
        await reembedFunctions(changedIds, ws.index, services.embedding, ws.vectorDb, services.config, ws.callGraph);
      }
      logger.info({ workspace: wsPath, reembedded: changedIds.length, deleted: deletedIds.length }, "Stale vectors updated");
    }
  }

  // Start file watcher — auto-reindex on file changes
  services.watcher.start();
  services.ready = true;
  logger.info("Initialization complete.");
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
