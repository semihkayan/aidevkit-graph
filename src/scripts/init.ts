#!/usr/bin/env node

import path from "node:path";
import { loadConfig } from "../utils/config.js";
import { createTreeSitterParsers, aggregateTestMetadata, aggregateLanguageConventions } from "../parsers/registry.js";
import { FunctionIndex } from "../core/function-index.js";
import { JsonFileRecordStore } from "../core/record-store-json.js";
import { HashBasedStalenessChecker } from "../core/staleness-hash.js";
import { DocstringParser } from "../core/docstring-parser.js";
import { OllamaEmbeddingProvider } from "../core/embedders/ollama.js";
import { LanceDBStore } from "../core/vector-db/lancedb.js";
import { reembedFunctions } from "../core/reembed.js";
import { detectWorkspaces } from "../core/workspace-detector.js";
import { ImportResolver } from "../core/import-resolver.js";
import { CallGraphManager } from "../core/call-graph.js";
import { TypeGraphManager } from "../core/type-graph/type-graph.js";
import { existsSync, readFileSync } from "node:fs";

/** Check if PID from lock file is still a running process */
function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const STALE_LOCK_MS = 24 * 60 * 60 * 1000; // 24 hours

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = args.find(a => !a.startsWith("--")) || ".";
  const force = args.includes("--force");
  const noEmbed = args.includes("--no-embed");

  const resolvedRoot = path.resolve(projectRoot);

  // Block if MCP server is running — concurrent access to LanceDB causes corruption
  if (force) {
    const lockPath = path.join(resolvedRoot, ".code-context", "server.pid");
    if (existsSync(lockPath)) {
      const lines = readFileSync(lockPath, "utf-8").trim().split("\n");
      const pid = parseInt(lines[0], 10);
      const timestamp = parseInt(lines[1], 10);
      const isStale = !isNaN(timestamp) && (Date.now() - timestamp > STALE_LOCK_MS);
      if (!isNaN(pid) && !isStale && isProcessRunning(pid)) {
        console.error("✗ MCP server is running (PID " + pid + "). Stop it before running --force.");
        console.error("  For live reindexing, use the 'reindex' MCP tool instead.");
        process.exit(1);
      }
    }
  }

  const config = await loadConfig(resolvedRoot);
  const parsers = createTreeSitterParsers(config.parser);
  const conventions = aggregateLanguageConventions(parsers);
  const docstringParser = new DocstringParser();
  const workspacePaths = await detectWorkspaces(resolvedRoot, config.workspaces, conventions.workspaceManifests, conventions.workspaceManifestExtensions);

  console.log(`Code Intelligence — Initializing ${resolvedRoot}`);
  console.log(`Workspaces: ${workspacePaths.join(", ")}`);
  console.log(`Languages: ${Object.keys(config.parser.languages).join(", ")}`);
  console.log(`Parsers loaded: ${parsers.length}`);
  console.log();

  // Force mode: clear both lance and AST cache for a truly clean rebuild
  if (force) {
    const { rmSync } = await import("node:fs");
    const lancePath = path.join(resolvedRoot, ".code-context", "lance");
    const astCachePath = path.join(resolvedRoot, ".code-context", "ast-cache");
    try { rmSync(lancePath, { recursive: true, force: true }); } catch { /* may not exist */ }
    try { rmSync(astCachePath, { recursive: true, force: true }); } catch { /* may not exist */ }
  }

  for (const wsPath of workspacePaths) {
    const wsRoot = wsPath === "." ? resolvedRoot : path.join(resolvedRoot, wsPath);
    const cacheDir = wsPath === "."
      ? path.join(resolvedRoot, ".code-context", "ast-cache")
      : path.join(resolvedRoot, ".code-context", "ast-cache", wsPath);

    const recordStore = new JsonFileRecordStore(cacheDir);
    const staleness = new HashBasedStalenessChecker(config);
    const index = new FunctionIndex(parsers, recordStore, staleness, docstringParser, config, wsRoot, aggregateTestMetadata(parsers), conventions);

    if (!force) await index.loadFromDisk();

    console.log(`[${wsPath}] Building AST index...`);
    const startAst = Date.now();
    await index.buildFull(wsRoot);
    await index.saveToDisk();
    const stats = index.getStats();
    console.log(`[${wsPath}] AST: ${stats.files} files, ${stats.functions} functions, ${stats.classes} classes (${Date.now() - startAst}ms)`);

    if (!noEmbed) {
      const embedding = new OllamaEmbeddingProvider(
        config.embedding.ollamaUrl, config.embedding.model,
        config.embedding.dimensions, config.embedding.instruction,
      );

      if (await embedding.isAvailable()) {
        const lancePath = path.join(resolvedRoot, ".code-context", "lance");
        const tableName = wsPath === "." ? "functions" : `${wsPath}_functions`;

        const lanceStore = new LanceDBStore();
        await lanceStore.initialize(lancePath, tableName);

        const allIds = index.getAllFilePaths().flatMap(fp => index.getFileRecordIds(fp));
        console.log(`[${wsPath}] Embedding ${allIds.length} functions...`);
        const startEmbed = Date.now();
        await reembedFunctions(allIds, index, embedding, lanceStore, config);
        console.log(`[${wsPath}] Embedded: ${await lanceStore.countRows()} vectors (${Date.now() - startEmbed}ms)`);
      } else {
        console.log(`[${wsPath}] Ollama not available. Skipping embedding. Run: ollama serve && ollama pull ${config.embedding.model}`);
      }
    }

    // Build and save call graph + type graph
    const importResolver = new ImportResolver(parsers);
    const typeGraph = new TypeGraphManager();
    const callGraph = new CallGraphManager(importResolver, parsers, typeGraph, conventions);

    console.log(`[${wsPath}] Building type graph + call graph...`);
    const startGraph = Date.now();
    // Type graph first — call graph uses it for interface-based resolution
    await typeGraph.build(index, parsers, wsRoot);
    await callGraph.build(index, wsRoot);

    const graphCacheDir = wsPath === "."
      ? path.join(resolvedRoot, ".code-context")
      : path.join(resolvedRoot, ".code-context", wsPath);
    await callGraph.saveToDisk(graphCacheDir, index);
    await typeGraph.saveToDisk(graphCacheDir, index);

    const cgStats = callGraph.getStats();
    const tgStats = typeGraph.getStats();
    console.log(`[${wsPath}] Graphs: ${cgStats.nodes} nodes, ${cgStats.edges} edges, ${tgStats.types} types (${Date.now() - startGraph}ms)`);

    console.log();
  }

  console.log("Done. Start the MCP server with: node dist/index.js");
}

main().catch(err => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
