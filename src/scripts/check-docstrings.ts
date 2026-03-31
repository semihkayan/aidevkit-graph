#!/usr/bin/env node

import path from "node:path";
import { loadConfig } from "../utils/config.js";
import { createTreeSitterParsers, aggregateTestMetadata, aggregateLanguageConventions } from "../parsers/registry.js";
import { FunctionIndex } from "../core/function-index.js";
import { JsonFileRecordStore } from "../core/record-store-json.js";
import { HashBasedStalenessChecker } from "../core/staleness-hash.js";
import { DocstringParser } from "../core/docstring-parser.js";

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const fileArgs = args.filter(a => !a.startsWith("--"));

  const resolvedRoot = path.resolve(".");
  const config = await loadConfig(resolvedRoot);
  const parsers = createTreeSitterParsers(config.parser);
  const conventions = aggregateLanguageConventions(parsers);
  const docstringParser = new DocstringParser();
  const { detectWorkspaces } = await import("../core/workspace-detector.js");
  const workspacePaths = await detectWorkspaces(resolvedRoot, config.workspaces, conventions.workspaceManifests, conventions.workspaceManifestExtensions);

  let issues = 0;

  for (const wsPath of workspacePaths) {
    const wsRoot = wsPath === "." ? resolvedRoot : path.join(resolvedRoot, wsPath);
    const cacheDir = wsPath === "."
      ? path.join(resolvedRoot, ".code-context", "ast-cache")
      : path.join(resolvedRoot, ".code-context", "ast-cache", wsPath);

    const recordStore = new JsonFileRecordStore(cacheDir);
    const staleness = new HashBasedStalenessChecker(config);
    const index = new FunctionIndex(parsers, recordStore, staleness, docstringParser, config, wsRoot, aggregateTestMetadata(parsers), conventions);
    await index.loadFromDisk();

    if (index.getStats().files === 0) {
      await index.buildFull(wsRoot);
    }

    const filesToCheck = fileArgs.length > 0
      ? fileArgs.map(f => path.relative(wsRoot, path.resolve(f))).filter(f => !f.startsWith(".."))
      : index.getAllFilePaths();

    if (workspacePaths.length > 1) console.log(`\n[${wsPath}]`);

  for (const filePath of filesToCheck) {
    for (const id of index.getFileRecordIds(filePath)) {
      const rec = index.getById(id);
      if (!rec || rec.kind === "class") continue;

      if (!rec.docstring) {
        console.log(`${rec.filePath}:${rec.lineStart} ${rec.name} — missing docstring`);
        issues++;
        continue;
      }

      if (strict) {
        if (rec.docstring.deps.length === 0) {
          console.log(`${rec.filePath}:${rec.lineStart} ${rec.name} — missing @deps`);
          issues++;
        }
        if (rec.docstring.tags.length === 0) {
          console.log(`${rec.filePath}:${rec.lineStart} ${rec.name} — missing @tags`);
          issues++;
        }
        if (rec.docstring.sideEffects.length === 0) {
          console.log(`${rec.filePath}:${rec.lineStart} ${rec.name} — missing @side_effects`);
          issues++;
        }
      }
    }
  }
  } // end workspace loop

  if (issues > 0) {
    console.log(`\n${issues} issue(s) found.`);
    process.exit(1);
  } else {
    console.log("All docstrings OK.");
  }
}

main().catch(err => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
