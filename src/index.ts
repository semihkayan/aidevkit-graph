#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { createServices } from "./services.js";
import { reembedFunctions } from "./core/reembed.js";
import { logger } from "./utils/logger.js";

// Schemas
import {
  SemanticSearchSchema, ModuleSummarySchema, FunctionSourceSchema, FileStructureSchema,
  TagSearchSchema, IndexStatusSchema,
  DependenciesSchema, CallersSchema, DependencyGraphSchema, ImpactAnalysisSchema,
  RecentChangesSchema, StaleDocstringsSchema, ReindexSchema,
} from "./tools/schemas.js";

// Handlers
import { handleModuleSummary } from "./tools/module-summary.js";
import { handleFunctionSource } from "./tools/function-source.js";
import { handleFileStructure } from "./tools/file-structure.js";
import { handleTagSearch } from "./tools/tag-search.js";
import { handleIndexStatus } from "./tools/index-status.js";
import { handleSemanticSearch } from "./tools/semantic-search.js";
import { handleDependencies } from "./tools/dependencies.js";
import { handleCallers } from "./tools/callers.js";
import { handleDependencyGraph } from "./tools/dependency-graph.js";
import { handleImpactAnalysis } from "./tools/impact-analysis.js";
import { handleRecentChanges } from "./tools/recent-changes.js";
import { handleStaleDocstrings } from "./tools/stale-docstrings.js";
import { handleReindex } from "./tools/reindex.js";

async function main() {
  const services = await createServices();
  logger.info({ projectRoot: services.config.projectRoot }, "Code Intelligence MCP Server starting");

  // MCP Server — connect FIRST so Claude Code doesn't timeout
  const server = new McpServer({ name: "code-intelligence", version: "0.1.0" });
  const ctx = services;

  server.registerTool("semantic_search", {
    description: "Search the codebase by meaning. Use INSTEAD OF grep/glob when looking for code related to a concept, feature, or bug. Finds functions even when you don't know exact names. Returns ranked results with signatures and file locations.",
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

  server.registerTool("get_file_structure", {
    description: "Get the project directory tree with function/class counts per directory. Use to orient yourself in an unfamiliar codebase or understand project layout.",
    inputSchema: FileStructureSchema.shape,
  }, (args) => handleFileStructure(args as any, ctx));

  server.registerTool("search_by_tags", {
    description: "Find functions by their @tags annotations. Use when you know the domain concept (e.g., 'payment', 'auth', 'cache'). Returns empty if codebase has no @tags docstring annotations.",
    inputSchema: TagSearchSchema.shape,
  }, (args) => handleTagSearch(args as any, ctx));

  server.registerTool("get_dependencies", {
    description: "Show what a function calls — its forward dependencies. Cross-validates AST analysis with @deps docstring annotations. Categorizes each dependency as confirmed (AST+docstring), AST-only, docstring-only, or unresolved.",
    inputSchema: DependenciesSchema.shape,
  }, (args) => handleDependencies(args as any, ctx));

  server.registerTool("get_callers", {
    description: "Show where a function is called from — reverse call graph. Use this to understand impact before modifying a function. Essential for safe refactoring.",
    inputSchema: CallersSchema.shape,
  }, (args) => handleCallers(args as any, ctx));

  server.registerTool("get_dependency_graph", {
    description: "Visualize the full dependency tree of a function — what it calls, what those call, etc. Supports downstream (callees), upstream (callers), or both directions. Detects circular dependencies.",
    inputSchema: DependencyGraphSchema.shape,
  }, (args) => handleDependencyGraph(args as any, ctx));

  server.registerTool("get_impact_analysis", {
    description: "Assess the blast radius of changing a function. Use BEFORE refactoring or modifying signatures. Combines call graph + type graph to find all affected code. Returns risk levels: high (direct callers + signature change), medium (indirect), low (transitive).",
    inputSchema: ImpactAnalysisSchema.shape,
  }, (args) => handleImpactAnalysis(args as any, ctx));

  server.registerTool("get_recent_changes", {
    description: "Show recent git changes mapped to function level. See which functions were added, modified, or deleted in recent commits.",
    inputSchema: RecentChangesSchema.shape,
  }, (args) => handleRecentChanges(args as any, ctx));

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

  // Graceful shutdown with timeout
  const shutdown = () => {
    const forceExit = setTimeout(() => process.exit(1), 10000);
    services.shutdown().then(() => { clearTimeout(forceExit); process.exit(0); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

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
    if (stats.files === 0) {
      logger.info({ workspace: wsPath }, "Empty index, building...");
      await ws.indexWriter.buildFull(ws.projectRoot);
      await ws.indexWriter.saveToDisk();
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

    // Embed if Ollama available and vectors empty
    if (services.embeddingAvailable && vectorCount === 0) {
      logger.info({ workspace: wsPath }, "Embedding all functions...");
      const allIds = ws.index.getAllFilePaths().flatMap(fp => ws.index.getFileRecordIds(fp));
      await reembedFunctions(allIds, ws.index, services.embedding, ws.vectorDb, services.config);
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
        await reembedFunctions(changedIds, ws.index, services.embedding, ws.vectorDb, services.config);
      }
      logger.info({ workspace: wsPath, reembedded: changedIds.length, deleted: deletedIds.length }, "Stale vectors updated");
    }

    // Load or build call graph + type graph
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
