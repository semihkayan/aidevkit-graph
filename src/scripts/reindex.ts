#!/usr/bin/env node

import path from "node:path";
import { loadConfig } from "../utils/config.js";
import { createTreeSitterParsers } from "../parsers/registry.js";
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

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const filesArg = args.find(a => a.startsWith("--files="));
  const useStdin = args.includes("--stdin");

  const resolvedRoot = path.resolve(".");
  const config = await loadConfig(resolvedRoot);
  const parsers = createTreeSitterParsers(config.parser);
  const docstringParser = new DocstringParser();
  const workspacePaths = await detectWorkspaces(resolvedRoot, config.workspaces);

  // Determine files to reindex
  let targetFiles: string[] | null = null;
  if (filesArg) {
    targetFiles = filesArg.slice("--files=".length).split(",").map(f => path.resolve(f));
  } else if (useStdin) {
    const input = await readStdin();
    targetFiles = input.split("\n").filter(Boolean).map(f => path.resolve(f.trim()));
  }
  // null means incremental (all = full rebuild)

  for (const wsPath of workspacePaths) {
    const wsRoot = wsPath === "." ? resolvedRoot : path.join(resolvedRoot, wsPath);
    const cacheDir = wsPath === "."
      ? path.join(resolvedRoot, ".code-context", "ast-cache")
      : path.join(resolvedRoot, ".code-context", "ast-cache", wsPath);

    const recordStore = new JsonFileRecordStore(cacheDir);
    const staleness = new HashBasedStalenessChecker(config);
    const index = new FunctionIndex(parsers, recordStore, staleness, docstringParser, config, wsRoot);
    await index.loadFromDisk();

    let changedIds: string[];
    if (all) {
      console.log(`[${wsPath}] Full rebuild...`);
      await index.buildFull(wsRoot);
      changedIds = index.getAllFilePaths().flatMap(fp => index.getFileRecordIds(fp));
    } else if (targetFiles) {
      const wsFiles = targetFiles.filter(f => f.startsWith(wsRoot));
      console.log(`[${wsPath}] Reindexing ${wsFiles.length} files...`);
      changedIds = await index.updateFiles(wsFiles);
    } else {
      console.log(`[${wsPath}] Incremental reindex...`);
      changedIds = await index.refreshStale(wsRoot);
    }

    await index.saveToDisk();
    const stats = index.getStats();
    console.log(`[${wsPath}] ${changedIds.length} functions updated. Total: ${stats.files} files, ${stats.functions} functions`);

    // Re-embed
    if (changedIds.length > 0) {
      const embedding = new OllamaEmbeddingProvider(
        config.embedding.ollamaUrl, config.embedding.model,
        config.embedding.dimensions, config.embedding.instruction,
      );
      if (await embedding.isAvailable()) {
        const lancePath = path.join(resolvedRoot, ".code-context", "lance");
        const tableName = wsPath === "." ? "functions" : `${wsPath}_functions`;
        const lanceStore = new LanceDBStore();
        await lanceStore.initialize(lancePath, tableName);
        await reembedFunctions(changedIds, index, embedding, lanceStore, config);
        console.log(`[${wsPath}] Re-embedded ${changedIds.length} functions`);
      }
    }

    // Rebuild and save call graph + type graph
    const importResolver = new ImportResolver(parsers);
    const typeGraph = new TypeGraphManager();
    const callGraph = new CallGraphManager(importResolver, parsers, typeGraph);

    // Type graph first — call graph uses it for interface-based resolution
    await typeGraph.build(index, parsers, wsRoot);
    await callGraph.build(index, wsRoot);

    const graphCacheDir = wsPath === "."
      ? path.join(resolvedRoot, ".code-context")
      : path.join(resolvedRoot, ".code-context", wsPath);
    await callGraph.saveToDisk(graphCacheDir, index);
    await typeGraph.saveToDisk(graphCacheDir, index);
    console.log(`[${wsPath}] Graphs rebuilt and saved`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", chunk => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}

main().catch(err => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
