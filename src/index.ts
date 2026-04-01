#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createServices, initializeWorkspaces } from "./services.js";
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
  // Global error handlers — prevent unhandled errors from killing the server process.
  // "Not connected" is always worse than a degraded server.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, "Unhandled rejection (server staying alive)");
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, "Uncaught exception (server staying alive)");
  });

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

  // Prevent stdout write errors (client pipe closed) from becoming uncaught exceptions.
  // StdioServerTransport.send() writes to stdout — if the client dies, the write emits 'error'.
  process.stdout.on('error', () => { /* pipe closed by MCP client */ });

  // Connect transport immediately — MCP handshake completes fast
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected via stdio");

  // Initialize all workspaces — heavy work after MCP connection is live.
  // Catch so that init failure doesn't kill the connected server (tools return NOT_READY).
  try {
    await initializeWorkspaces(services);
  } catch (err) {
    logger.error({ err }, "Initialization failed — server alive, tools return NOT_READY");
  }

  // Start file watcher — auto-reindex on file changes
  try {
    services.watcher.start();
  } catch (err) {
    logger.error({ err }, "FileWatcher failed to start");
  }
  logger.info("Initialization complete.");
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
