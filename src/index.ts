#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createServices, initializeWorkspaces, backgroundEmbed, seedCacheFromMainRepo } from "./services.js";
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
    description: "Search the codebase by meaning. Works across all workspaces automatically in monorepos.\n\nCRITICAL: Use this INSTEAD OF grep or rg when looking for code by concept, feature, or bug area. Unlike text search, this finds functions even when you don't know exact names, spellings, or which files to look in. Use as the FIRST STEP for any code exploration task. Results include workspace, signature, body size, summary, and file location to help you decide what to read next.",
    inputSchema: SemanticSearchSchema.shape,
  }, (args) => handleSemanticSearch(args as any, ctx));

  server.registerTool("get_module_summary", {
    description: "List all functions and classes in a directory with their signatures.\n\nCRITICAL: Use this INSTEAD OF find, ls, tree, or Glob to explore what a module contains. File listings only give you names — this gives you function signatures, summaries, and structure. Saves tokens by showing metadata without source code. Auto-adapts detail level: full for small modules, compact for large ones. Use group_by='submodule' for large modules with sub-directories to get per-submodule breakdown with independent detail scaling. For very large modules (200+ functions), auto mode returns an 'overview' with per-submodule statistics only — drill into specific submodules for details. Use module='.' to get a top-level overview of the entire project structure.",
    inputSchema: ModuleSummarySchema.shape,
  }, (args) => handleModuleSummary(args as any, ctx));

  server.registerTool("get_function_source", {
    description: "Get the source code of a specific function by name.\n\nCRITICAL: Use this INSTEAD OF Read or cat when you need a single function. Reading an entire file to extract one function wastes tokens and pollutes your context window. This returns only the function you need. Supports: plain name ('processOrder'), class.method ('PaymentProcessor.refund'), or partial match. Use context_lines parameter to include surrounding imports or related code.\n\nCRITICAL: When you add or modify a function, you MUST add a docstring with @deps (functions it calls) and @tags (e.g. critical, auth, payments). Docstrings feed semantic search, call graph validation, and impact analysis — without them, this tool suite loses most of its power.",
    inputSchema: FunctionSourceSchema.shape,
  }, (args) => handleFunctionSource(args as any, ctx));

  server.registerTool("get_dependencies", {
    description: "Show what a function calls — its forward dependencies.\n\nIMPORTANT: Use this INSTEAD OF grep or rg to trace what a function calls. Grep gives you text matches that include false positives — this gives you the actual AST-verified call graph. Cross-validates with @deps docstring annotations. Categorizes each dependency as confirmed (AST+docstring), AST-only, docstring-only, or unresolved.",
    inputSchema: DependenciesSchema.shape,
  }, (args) => handleDependencies(args as any, ctx));

  server.registerTool("get_impact_analysis", {
    description: "Assess the blast radius of changing a function.\n\nIMPORTANT: Use this INSTEAD OF grep or rg to find callers of a function. Grep misses indirect callers, interface implementations, and type relationships — this gives you the complete impact chain with risk levels. Use BEFORE refactoring or modifying function signatures. Combines call graph + type graph. Returns risk levels: high (direct callers + signature change), medium (indirect), low (transitive).",
    inputSchema: ImpactAnalysisSchema.shape,
  }, (args) => handleImpactAnalysis(args as any, ctx));

  server.registerTool("get_stale_docstrings", {
    description: "Find functions with missing or outdated docstrings. Detects: missing docstrings, @deps that don't match actual AST calls, missing @tags. Use for codebase hygiene.\n\nCRITICAL: Run this after writing code. Docstrings with @deps and @tags are what make semantic search, call graph, and impact analysis accurate — without them, the entire tool suite degrades. Fix what this tool reports.",
    inputSchema: StaleDocstringsSchema.shape,
  }, (args) => handleStaleDocstrings(args as any, ctx));

  server.registerTool("reindex", {
    description: "Manually update the code index. Usually not needed — the server auto-reindexes on file changes. Use after bulk operations or if index seems stale.",
    inputSchema: ReindexSchema.shape,
  }, (args) => handleReindex(args as any, ctx));

  server.registerTool("get_index_status", {
    description: "Check index health: how many files/functions are indexed, embedding status, call graph stats, docstring coverage, and language breakdown.\n\nCRITICAL: Call this FIRST at the start of a session to verify the index is ready and discover available workspaces. Once confirmed, prefer codeweave tools over generic alternatives:\n- Exploring a module → get_module_summary (not find/ls/Glob)\n- Reading one function → get_function_source (not Read/cat)\n- Searching by concept → semantic_search (not grep/rg)\n- Tracing calls → get_dependencies (not grep)\n- Change risk → get_impact_analysis (not grep for callers)",
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

  // In a worktree with no cache, seed from main repo for fast warm start
  await seedCacheFromMainRepo(services.config.projectRoot);

  // Initialize workspaces BEFORE connect — agent never sees NOT_READY.
  let embedPlans: Awaited<ReturnType<typeof initializeWorkspaces>>;
  try {
    embedPlans = await initializeWorkspaces(services);
  } catch (err) {
    logger.error({ err }, "Initialization failed — server alive, tools return NOT_READY");
    embedPlans = new Map();
  }

  // Connect transport — index + graphs loaded, tools ready.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected via stdio");

  // Start file watcher — auto-reindex on file changes
  try {
    services.watcher.start();
  } catch (err) {
    logger.error({ err }, "FileWatcher failed to start");
  }
  logger.info("Initialization complete.");

  // Background: check Ollama, embed if needed (does not block tools)
  backgroundEmbed(services, embedPlans).catch(err => {
    logger.error({ err }, "Background embedding failed");
  });
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
