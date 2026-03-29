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

  server.registerTool("semantic_search",
    { description: "Hybrid search: vector + BM25 with natural language", inputSchema: SemanticSearchSchema.shape },
    (args) => handleSemanticSearch(args as any, ctx));

  server.registerTool("get_module_summary",
    { description: "Function/class metadata with progressive disclosure", inputSchema: ModuleSummarySchema.shape },
    (args) => handleModuleSummary(args as any, ctx));

  server.registerTool("get_function_source",
    { description: "Source code of a single function", inputSchema: FunctionSourceSchema.shape },
    (args) => handleFunctionSource(args as any, ctx));

  server.registerTool("get_file_structure",
    { description: "Project directory structure with AST stats", inputSchema: FileStructureSchema.shape },
    (args) => handleFileStructure(args as any, ctx));

  server.registerTool("search_by_tags",
    { description: "Tag-based exact match search", inputSchema: TagSearchSchema.shape },
    (args) => handleTagSearch(args as any, ctx));

  server.registerTool("get_dependencies",
    { description: "Forward call graph with cross-validation", inputSchema: DependenciesSchema.shape },
    (args) => handleDependencies(args as any, ctx));

  server.registerTool("get_callers",
    { description: "Reverse call graph", inputSchema: CallersSchema.shape },
    (args) => handleCallers(args as any, ctx));

  server.registerTool("get_dependency_graph",
    { description: "Transitive dependency tree", inputSchema: DependencyGraphSchema.shape },
    (args) => handleDependencyGraph(args as any, ctx));

  server.registerTool("get_impact_analysis",
    { description: "Change impact analysis", inputSchema: ImpactAnalysisSchema.shape },
    (args) => handleImpactAnalysis(args as any, ctx));

  server.registerTool("get_recent_changes",
    { description: "Recent git changes at function level", inputSchema: RecentChangesSchema.shape },
    (args) => handleRecentChanges(args as any, ctx));

  server.registerTool("get_stale_docstrings",
    { description: "Detect outdated or missing docstrings", inputSchema: StaleDocstringsSchema.shape },
    (args) => handleStaleDocstrings(args as any, ctx));

  server.registerTool("reindex",
    { description: "Manual index update with optional re-embedding", inputSchema: ReindexSchema.shape },
    (args) => handleReindex(args as any, ctx));

  server.registerTool("get_index_status",
    { description: "Index health and statistics", inputSchema: IndexStatusSchema.shape },
    (args) => handleIndexStatus(args as any, ctx));

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
    if (stats.files === 0) {
      logger.info({ workspace: wsPath }, "Empty index, building...");
      await ws.indexWriter.buildFull(ws.projectRoot);
      await ws.indexWriter.saveToDisk();
      const newStats = ws.index.getStats();
      logger.info({ workspace: wsPath, ...newStats }, "Index built");
    } else {
      logger.info({ workspace: wsPath, ...stats }, "Index loaded from cache");
      // Check for files changed while server was offline
      const staleIds = await ws.indexWriter.refreshStale(ws.projectRoot);
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
    }

    // Load or build call graph + type graph
    const graphCacheDir = wsPath === "."
      ? path.join(services.config.projectRoot, ".code-context")
      : path.join(services.config.projectRoot, ".code-context", wsPath);

    const cgLoaded = await ws.callGraphWriter.loadFromDisk(graphCacheDir, ws.index);
    if (!cgLoaded) {
      await ws.callGraphWriter.build(ws.index, ws.projectRoot);
      await ws.callGraphWriter.saveToDisk(graphCacheDir, ws.index);
    }

    const tgLoaded = await ws.typeGraphWriter.loadFromDisk(graphCacheDir, ws.index);
    if (!tgLoaded) {
      await ws.typeGraphWriter.build(ws.index, services.parsers, ws.projectRoot);
      await ws.typeGraphWriter.saveToDisk(graphCacheDir, ws.index);
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
