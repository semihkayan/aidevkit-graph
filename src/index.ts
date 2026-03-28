#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { createServices } from "./services.js";
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

  server.tool("semantic_search", "Hybrid search: vector + BM25 with natural language",
    SemanticSearchSchema.shape, (args) => handleSemanticSearch(args as any, ctx));

  server.tool("get_module_summary", "Function/class metadata with progressive disclosure",
    ModuleSummarySchema.shape, (args) => handleModuleSummary(args as any, ctx));

  server.tool("get_function_source", "Source code of a single function",
    FunctionSourceSchema.shape, (args) => handleFunctionSource(args as any, ctx));

  server.tool("get_file_structure", "Project directory structure with AST stats",
    FileStructureSchema.shape, (args) => handleFileStructure(args as any, ctx));

  server.tool("search_by_tags", "Tag-based exact match search",
    TagSearchSchema.shape, (args) => handleTagSearch(args as any, ctx));

  server.tool("get_dependencies", "Forward call graph with cross-validation",
    DependenciesSchema.shape, (args) => handleDependencies(args as any, ctx));

  server.tool("get_callers", "Reverse call graph",
    CallersSchema.shape, (args) => handleCallers(args as any, ctx));

  server.tool("get_dependency_graph", "Transitive dependency tree",
    DependencyGraphSchema.shape, (args) => handleDependencyGraph(args as any, ctx));

  server.tool("get_impact_analysis", "Change impact analysis",
    ImpactAnalysisSchema.shape, (args) => handleImpactAnalysis(args as any, ctx));

  server.tool("get_recent_changes", "Recent git changes at function level",
    RecentChangesSchema.shape, (args) => handleRecentChanges(args as any, ctx));

  server.tool("get_stale_docstrings", "Detect outdated or missing docstrings",
    StaleDocstringsSchema.shape, (args) => handleStaleDocstrings(args as any, ctx));

  server.tool("reindex", "Manual index update with optional re-embedding",
    ReindexSchema.shape, (args) => handleReindex(args as any, ctx));

  server.tool("get_index_status", "Index health and statistics",
    IndexStatusSchema.shape, (args) => handleIndexStatus(args as any, ctx));

  // Graceful shutdown
  const shutdown = () => services.shutdown().then(() => process.exit(0));
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
      const { reembedFunctions } = await import("./core/reembed.js");
      await reembedFunctions(allIds, ws.index, services.embedding, ws.vectorDb, services.config);
      const newCount = await ws.vectorDb.countRows();
      logger.info({ workspace: wsPath, embedded: newCount }, "Embedding complete");
    }

    // Build call graph + type graph
    await ws.callGraphWriter.build(ws.index, ws.projectRoot);
    await ws.typeGraphWriter.build(ws.index, services.parsers, ws.projectRoot);
    const cgStats = ws.callGraph.getStats();
    const tgStats = ws.typeGraph.getStats();
    logger.info({ workspace: wsPath, ...cgStats, ...tgStats }, "Call graph + type graph built");
  }

  // Start file watcher — auto-reindex on file changes
  services.watcher.start();
  logger.info("File watcher started. Initialization complete.");
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
