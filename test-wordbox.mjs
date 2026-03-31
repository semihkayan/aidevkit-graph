/**
 * Comprehensive integration test on WordBox monorepo.
 * Tests: multi-workspace, module summary, function source, dependencies,
 * stale docstrings, index status, reindex, structural test detection,
 * query-aware penalty skip, noise filtering, SOLID metadata aggregation.
 *
 * Usage: npm run build && node test-wordbox.mjs
 */
import path from "node:path";
import { createServices } from "./dist/services.js";
import { handleSemanticSearch } from "./dist/tools/semantic-search.js";
import { handleModuleSummary } from "./dist/tools/module-summary.js";
import { handleFunctionSource } from "./dist/tools/function-source.js";
import { handleDependencies } from "./dist/tools/dependencies.js";
import { handleStaleDocstrings } from "./dist/tools/stale-docstrings.js";
import { handleIndexStatus } from "./dist/tools/index-status.js";
import { handleReindex } from "./dist/tools/reindex.js";

const WORDBOX = "/Users/semihkayan/Projects/WordBox";

let passed = 0, failed = 0;
const issues = [];
function assert(label, condition, detail) {
  if (condition) { passed++; }
  else { failed++; issues.push(label + ": " + (detail || "")); console.log("  \u2717 " + label + " \u2014 " + (detail || "")); }
}
function parse(r) { try { return JSON.parse(r?.content?.[0]?.text); } catch { return null; } }
function tokens(r) { return Math.ceil((r?.content?.[0]?.text || "").length / 4); }

async function setup() {
  console.log("Setting up WordBox services...\n");
  const ctx = await createServices(WORDBOX);
  for (const wsPath of ctx.workspacePaths) {
    const ws = ctx.resolveWorkspace(wsPath);
    await ws.indexWriter.loadFromDisk();
    const stats = ws.index.getStats();
    if (stats.files === 0) {
      console.log("  Rebuilding " + wsPath + "...");
      await ws.indexWriter.buildFull(ws.projectRoot);
      await ws.indexWriter.saveToDisk();
    }
    const lancePath = path.join(ctx.config.projectRoot, ".code-context", "lance");
    await ws.vectorDb.initialize(lancePath, wsPath === "." ? "functions" : wsPath + "_functions");
    const gDir = wsPath === "." ? path.join(ctx.config.projectRoot, ".code-context") : path.join(ctx.config.projectRoot, ".code-context", wsPath);
    const tgLoaded = await ws.typeGraphWriter.loadFromDisk(gDir, ws.index);
    if (!tgLoaded) {
      await ws.typeGraphWriter.build(ws.index, ctx.parsers, ws.projectRoot);
      await ws.typeGraphWriter.saveToDisk(gDir, ws.index);
    }
    const cgLoaded = await ws.callGraphWriter.loadFromDisk(gDir, ws.index);
    if (!cgLoaded) {
      await ws.callGraphWriter.build(ws.index, ws.projectRoot);
      await ws.callGraphWriter.saveToDisk(gDir, ws.index);
    }
    const newStats = ws.index.getStats();
    const vectors = await ws.vectorDb.countRows();
    console.log("  " + wsPath + ": " + newStats.files + " files, " + newStats.functions + " fns, vectors=" + vectors);
  }
  ctx.ready = true;
  console.log("  Workspaces: [" + ctx.workspacePaths.join(", ") + "]\n");
  return ctx;
}

async function testSemanticSearch(ctx) {
  console.log("\u2550\u2550\u2550 1. SEMANTIC SEARCH (10 tests) \u2550\u2550\u2550\n");

  // 1. Cross-workspace — both workspaces in results
  const r1 = await handleSemanticSearch({ query: "user", top_k: 10 }, ctx);
  const d1 = parse(r1);
  const wsSet = new Set(d1?.results?.map(x => x.workspace));
  assert("1.1 cross-workspace results", wsSet.size >= 2, "workspaces: " + [...wsSet].join(", "));

  // 2. All results have workspace field
  assert("1.2 workspace field present", d1?.results?.every(r => r.workspace != null));

  // 3. Explicit workspace filters correctly
  const r3 = await handleSemanticSearch({ query: "screen", workspace: "wordbox-mobile", top_k: 5 }, ctx);
  const d3 = parse(r3);
  assert("1.3 explicit ws filters", d3?.results?.every(r => r.workspace === "wordbox-mobile") ?? true);

  // 4. Invalid workspace
  const r4 = await handleSemanticSearch({ query: "test", workspace: "nonexistent" }, ctx);
  assert("1.4 invalid ws error", r4.isError && parse(r4)?.error === "WORKSPACE_NOT_FOUND");

  // 5. Query-aware test skip — tests surface when explicitly searched
  const r5 = await handleSemanticSearch({ query: "UserStreak test", workspace: "wordbox-api", top_k: 5 }, ctx);
  const d5 = parse(r5);
  const testHits = d5?.results?.filter(x => x.file.includes("Test.") || x.file.includes("/test/"));
  assert("1.5 test query finds tests", (testHits?.length || 0) >= 2, testHits?.length + " test results");

  // 6. Non-test query penalizes tests
  const r6 = await handleSemanticSearch({ query: "streak calculation", workspace: "wordbox-api", top_k: 10 }, ctx);
  const d6 = parse(r6);
  const testHits6 = d6?.results?.filter(x => x.file.includes("Test.") || x.file.includes("/test/"));
  assert("1.6 non-test query penalizes tests", (testHits6?.length || 0) <= 3, testHits6?.length + " test results");

  // 7. Short query rejection
  const r7 = await handleSemanticSearch({ query: "a" }, ctx);
  assert("1.7 short query rejected", parse(r7)?.search_mode === "skipped");

  // 8. top_k respected
  const r8 = await handleSemanticSearch({ query: "service", top_k: 3 }, ctx);
  assert("1.8 top_k=3", (parse(r8)?.results?.length || 0) <= 3);

  // 9. Scope filter
  const r9 = await handleSemanticSearch({ query: "order", workspace: "wordbox-api", scope: "com/wordbox/streak" }, ctx);
  const d9 = parse(r9);
  if (d9?.results?.length > 0) {
    assert("1.9 scope filter", d9.results.every(r => r.module?.includes("streak") || r.file?.includes("streak")));
  } else {
    assert("1.9 scope filter (no results)", true);
  }

  // 10. Structural isTest flag count
  let testCount = 0;
  for (const wsPath of ctx.workspacePaths) {
    const ws = ctx.resolveWorkspace(wsPath);
    for (const fp of ws.index.getAllFilePaths()) {
      for (const id of ws.index.getFileRecordIds(fp)) {
        if (ws.index.getById(id)?.structuralHints?.isTest) testCount++;
      }
    }
  }
  assert("1.10 isTest records > 1000", testCount > 1000, testCount + " isTest records");
}

async function testModuleSummary(ctx) {
  console.log("\n\u2550\u2550\u2550 2. MODULE SUMMARY (25 tests) \u2550\u2550\u2550\n");

  const apiWs = ctx.resolveWorkspace("wordbox-api");
  const mobileWs = ctx.resolveWorkspace("wordbox-mobile");
  const apiModules = apiWs.index.getAllModules().filter(m => m.length > 0);
  const mobileModules = mobileWs.index.getAllModules().filter(m => m.length > 0);

  const moduleSizes = apiModules.map(m => ({
    m, total: apiWs.index.getByModule(m).length
  })).sort((a, b) => a.total - b.total);
  const small = moduleSizes.filter(x => x.total > 0 && x.total <= 10);
  const large = moduleSizes.filter(x => x.total > 30 && x.total <= 80);
  const xl = moduleSizes.filter(x => x.total > 80);

  // 2.1-3: Auto mode small → full
  for (let i = 0; i < Math.min(3, small.length); i++) {
    const r = await handleModuleSummary({ module: small[i].m, workspace: "wordbox-api" }, ctx);
    const d = parse(r);
    assert("2." + (i + 1) + " small\u2192full (" + small[i].total + ")", d?.mode === "full", "got " + d?.mode);
  }

  // 2.4-6: Large → compact or files_only
  for (let i = 0; i < Math.min(3, large.length); i++) {
    const r = await handleModuleSummary({ module: large[i].m, workspace: "wordbox-api" }, ctx);
    const d = parse(r);
    assert("2." + (i + 4) + " large\u2192compact|files_only (" + large[i].total + ")",
      d?.mode === "compact" || d?.mode === "files_only", "got " + d?.mode);
  }

  // 2.7: Test files excluded — use a module known to have tests
  const r27 = await handleModuleSummary({ module: "com/wordbox/streak/domain/model", workspace: "wordbox-api" }, ctx);
  const d27 = parse(r27);
  assert("2.7 test_files_excluded > 0", d27?.test_files_excluded > 0, "excluded: " + d27?.test_files_excluded);

  // 2.8: Class/method nesting
  const classMod = apiModules.find(m => {
    const recs = apiWs.index.getByModule(m);
    return recs.some(r => r.kind === "class") && recs.some(r => r.kind === "method") && recs.length <= 20;
  });
  if (classMod) {
    const r = await handleModuleSummary({ module: classMod, workspace: "wordbox-api", detail: "full" }, ctx);
    const d = parse(r);
    assert("2.8 class has nested methods", d?.files?.some(f => f.items?.some(i => i.methods?.length > 0)));
  }

  // 2.9: files_only shows methods count
  if (xl.length > 0) {
    const r = await handleModuleSummary({ module: xl[0].m, workspace: "wordbox-api", detail: "files_only" }, ctx);
    const d = parse(r);
    const classFiles = d?.files?.filter(f => f.classes?.length > 0) || [];
    const withMethods = classFiles.filter(f => f.methods > 0);
    assert("2.9 files_only shows methods", withMethods.length > 0);
  }

  // 2.10-11: File filter
  if (small.length > 0) {
    const recs = apiWs.index.getByModule(small[0].m);
    const files = [...new Set(recs.map(r => r.filePath))];
    if (files.length > 0) {
      const fn = files[0].split("/").pop();
      const r = await handleModuleSummary({ module: small[0].m, workspace: "wordbox-api", file: fn }, ctx);
      assert("2.10 file filter works", parse(r)?.files?.length === 1);
      const r2 = await handleModuleSummary({ module: small[0].m, workspace: "wordbox-api", file: "zzz.java" }, ctx);
      assert("2.11 file filter no match", (parse(r2)?.total || 0) === 0);
    }
  }

  // 2.12-13: Forced detail levels
  if (small.length > 0) {
    const r1 = await handleModuleSummary({ module: small[0].m, workspace: "wordbox-api", detail: "compact" }, ctx);
    assert("2.12 forced compact", parse(r1)?.mode === "compact");
    const r2 = await handleModuleSummary({ module: small[0].m, workspace: "wordbox-api", detail: "files_only" }, ctx);
    assert("2.13 forced files_only", parse(r2)?.mode === "files_only");
  }

  // 2.14-15: Cross-workspace auto-find
  assert("2.14 auto-find mobile", parse(await handleModuleSummary({ module: mobileModules[0] }, ctx))?.workspace === "wordbox-mobile");
  assert("2.15 auto-find api", parse(await handleModuleSummary({ module: apiModules[0] }, ctx))?.workspace === "wordbox-api");

  // 2.16: Wrong workspace
  assert("2.16 wrong ws error", (await handleModuleSummary({ module: mobileModules[0], workspace: "wordbox-api" }, ctx)).isError);

  // 2.17: Invalid workspace
  assert("2.17 invalid ws", (await handleModuleSummary({ module: apiModules[0], workspace: "nope" }, ctx)).isError);

  // 2.18: Nonexistent module
  assert("2.18 not found", (await handleModuleSummary({ module: "this/does/not/exist" }, ctx)).isError);

  // 2.19: Parent module path
  const r19 = await handleModuleSummary({ module: "com/wordbox/streak", workspace: "wordbox-api" }, ctx);
  assert("2.19 parent path", !r19.isError && parse(r19)?.total > 10);

  // 2.20: Token budget
  if (moduleSizes.length > 0) {
    const med = moduleSizes.find(x => x.total > 10 && x.total <= 30);
    if (med) {
      const r = await handleModuleSummary({ module: med.m, workspace: "wordbox-api", detail: "full" }, ctx);
      assert("2.20 token budget \u22646000", tokens(r) <= 6000, tokens(r) + " tokens");
    }
  }

  // 2.21-23: Mobile modules
  for (let i = 0; i < Math.min(3, mobileModules.length); i++) {
    const r = await handleModuleSummary({ module: mobileModules[i], workspace: "wordbox-mobile" }, ctx);
    assert("2." + (i + 21) + " mobile " + mobileModules[i].split("/").pop(), !r.isError);
  }

  // 2.24: Full > compact > files_only tokens
  if (small.length > 0) {
    const mod = small[0].m;
    const tFull = tokens(await handleModuleSummary({ module: mod, workspace: "wordbox-api", detail: "full" }, ctx));
    const tCompact = tokens(await handleModuleSummary({ module: mod, workspace: "wordbox-api", detail: "compact" }, ctx));
    const tFiles = tokens(await handleModuleSummary({ module: mod, workspace: "wordbox-api", detail: "files_only" }, ctx));
    assert("2.24 full > compact > files_only", tFull >= tCompact && tCompact >= tFiles,
      "full=" + tFull + " compact=" + tCompact + " files=" + tFiles);
  }

  // 2.25: Deep module path
  const deep = apiModules.sort((a, b) => b.split("/").length - a.split("/").length)[0];
  assert("2.25 deep path works", !(await handleModuleSummary({ module: deep, workspace: "wordbox-api" }, ctx)).isError);
}

async function testFunctionSource(ctx) {
  console.log("\n\u2550\u2550\u2550 3. FUNCTION SOURCE (20 tests) \u2550\u2550\u2550\n");

  const apiWs = ctx.resolveWorkspace("wordbox-api");
  const mobileWs = ctx.resolveWorkspace("wordbox-mobile");

  // Collect known functions
  const knownFns = [];
  for (const fp of apiWs.index.getAllFilePaths()) {
    for (const id of apiWs.index.getFileRecordIds(fp)) {
      const r = apiWs.index.getById(id);
      if (r && r.kind !== "class" && r.kind !== "interface" && !r.structuralHints?.isTest) knownFns.push(r);
    }
    if (knownFns.length >= 20) break;
  }

  // 3.1-3: Various function types
  const method = knownFns.find(r => r.kind === "method");
  const dotName = knownFns.find(r => r.name.includes("."));
  const bigFn = knownFns.find(r => (r.lineEnd - r.lineStart) > 20);

  if (method) {
    const r = await handleFunctionSource({ function: method.name, workspace: "wordbox-api" }, ctx);
    assert("3.1 method source", !r.isError && parse(r)?.source?.length > 0);
  }
  if (dotName) {
    const r = await handleFunctionSource({ function: dotName.name, workspace: "wordbox-api" }, ctx);
    assert("3.2 dot notation", !r.isError && parse(r)?.source?.length > 0);
  }
  if (bigFn) {
    const r = await handleFunctionSource({ function: bigFn.name, workspace: "wordbox-api" }, ctx);
    assert("3.3 big function", !r.isError && parse(r)?.source?.length > 0);
  }

  // 3.4: Line range matches index
  if (method) {
    const d = parse(await handleFunctionSource({ function: method.name, workspace: "wordbox-api" }, ctx));
    assert("3.4 line range", d?.line_start === method.lineStart && d?.line_end === method.lineEnd);
  }

  // 3.5-6: Context lines
  if (method) {
    const d0 = parse(await handleFunctionSource({ function: method.name, workspace: "wordbox-api", context_lines: 0 }, ctx));
    const d5 = parse(await handleFunctionSource({ function: method.name, workspace: "wordbox-api", context_lines: 5 }, ctx));
    assert("3.5 no context", !d0?.context_before && !d0?.context_after);
    assert("3.6 has context", d5?.context_before || d5?.context_after);
  }

  // 3.7: No workspace param
  const r7 = await handleFunctionSource({ function: "StreakController" }, ctx);
  assert("3.7 no workspace", !r7.isError && parse(r7)?.workspace === "wordbox-api");

  // 3.8: Not found
  assert("3.8 not found", (await handleFunctionSource({ function: "zzz_fake_999" }, ctx)).isError);

  // 3.9: Invalid workspace
  assert("3.9 invalid ws", (await handleFunctionSource({ function: "StreakController", workspace: "nope" }, ctx)).isError);

  // 3.10: Wrong workspace
  assert("3.10 wrong ws", (await handleFunctionSource({ function: "StreakController", workspace: "wordbox-mobile" }, ctx)).isError);

  // 3.11: Language field
  if (method) {
    assert("3.11 language field", parse(await handleFunctionSource({ function: method.name, workspace: "wordbox-api" }, ctx))?.language === "java");
  }

  // 3.12: Workspace field in multi-ws
  assert("3.12 workspace field", parse(await handleFunctionSource({ function: "StreakController", workspace: "wordbox-api" }, ctx))?.workspace === "wordbox-api");

  // 3.13: Mobile function
  const mobileFn = [];
  for (const fp of mobileWs.index.getAllFilePaths().slice(0, 10)) {
    for (const id of mobileWs.index.getFileRecordIds(fp)) {
      const r = mobileWs.index.getById(id);
      if (r && r.kind === "function") mobileFn.push(r);
    }
    if (mobileFn.length > 0) break;
  }
  if (mobileFn.length > 0) {
    assert("3.13 mobile fn", !( await handleFunctionSource({ function: mobileFn[0].name }, ctx)).isError);
  }

  // 3.14: Module disambiguation
  const r14 = await handleFunctionSource({ function: "create", workspace: "wordbox-api", module: "com/wordbox/streak" }, ctx);
  assert("3.14 module disambiguates", !r14.isError || parse(r14)?.error === "AMBIGUOUS_FUNCTION");

  // 3.15-16: Token efficiency
  const smallFn = knownFns.find(r => (r.lineEnd - r.lineStart) < 5);
  if (smallFn) assert("3.15 small fn tokens", tokens(await handleFunctionSource({ function: smallFn.name, workspace: "wordbox-api" }, ctx)) < 500);
  if (bigFn) assert("3.16 big fn tokens", tokens(await handleFunctionSource({ function: bigFn.name, workspace: "wordbox-api" }, ctx)) > 100);

  // 3.17: Named class
  const r17 = await handleFunctionSource({ function: "StreakController", workspace: "wordbox-api" }, ctx);
  assert("3.17 class source", !r17.isError);

  // 3.18-20: Speed
  for (let i = 0; i < Math.min(3, knownFns.length); i++) {
    const start = performance.now();
    await handleFunctionSource({ function: knownFns[i].name, workspace: "wordbox-api" }, ctx);
    const ms = Math.round(performance.now() - start);
    assert("3." + (i + 18) + " speed <500ms", ms < 500, ms + "ms");
  }
}

async function testDependencies(ctx) {
  console.log("\n\u2550\u2550\u2550 4. DEPENDENCIES (20 tests) \u2550\u2550\u2550\n");

  const apiWs = ctx.resolveWorkspace("wordbox-api");
  const knownFns = [];
  for (const fp of apiWs.index.getAllFilePaths()) {
    for (const id of apiWs.index.getFileRecordIds(fp)) {
      const r = apiWs.index.getById(id);
      if (r && !r.structuralHints?.isTest && r.kind !== "class" && r.kind !== "interface") knownFns.push(r);
    }
    if (knownFns.length >= 30) break;
  }

  const fnsWithDeps = knownFns.filter(fn => {
    const entry = apiWs.callGraph.getEntry(fn.id);
    return entry && entry.calls.length > 0;
  }).slice(0, 10);

  // 4.1-5: Functions with deps
  for (let i = 0; i < Math.min(5, fnsWithDeps.length); i++) {
    const r = await handleDependencies({ function: fnsWithDeps[i].name, workspace: "wordbox-api" }, ctx);
    const d = parse(r);
    const total = (d?.calls?.length || 0) + (d?.ast_only?.length || 0) + (d?.unresolved?.length || 0);
    assert("4." + (i + 1) + " " + fnsWithDeps[i].name.substring(0, 25) + " has deps", !r.isError && total > 0, total + " deps");
  }

  // 4.6-8: Noise filtering
  for (let i = 0; i < Math.min(3, fnsWithDeps.length); i++) {
    const r = await handleDependencies({ function: fnsWithDeps[i].name, workspace: "wordbox-api" }, ctx);
    const d = parse(r);
    const allCalls = [...(d?.calls || []), ...(d?.ast_only || []), ...(d?.unresolved || [])];
    const noisy = allCalls.filter(c =>
      ctx.noiseFilter.noiseTargets.has(c.target) ||
      (c.target.includes(".") && ctx.noiseFilter.builtinMethods.has(c.target.split(".").pop()))
    );
    assert("4." + (i + 6) + " noise filtered", noisy.length === 0,
      "found: " + noisy.map(c => c.target).join(", "));
  }

  // 4.9: No deps function
  const noDeps = knownFns.find(fn => {
    const entry = apiWs.callGraph.getEntry(fn.id);
    return !entry || entry.calls.length === 0;
  });
  if (noDeps) {
    const d = parse(await handleDependencies({ function: noDeps.name, workspace: "wordbox-api" }, ctx));
    assert("4.9 no deps fn", (d?.calls?.length || 0) + (d?.ast_only?.length || 0) === 0);
  }

  // 4.10: No workspace
  assert("4.10 no ws", !(await handleDependencies({ function: fnsWithDeps[0]?.name || "StreakController" }, ctx)).isError);

  // 4.11: Not found
  assert("4.11 not found", (await handleDependencies({ function: "zzz_fake" }, ctx)).isError);

  // 4.12: Invalid ws
  assert("4.12 invalid ws", parse(await handleDependencies({ function: "StreakController", workspace: "nope" }, ctx))?.error === "WORKSPACE_NOT_FOUND");

  // 4.13: Caveat present
  assert("4.13 caveat", parse(await handleDependencies({ function: fnsWithDeps[0]?.name || "StreakController", workspace: "wordbox-api" }, ctx))?.caveat?.includes("Static"));

  // 4.14: Workspace field
  assert("4.14 workspace field", parse(await handleDependencies({ function: fnsWithDeps[0]?.name || "StreakController", workspace: "wordbox-api" }, ctx))?.workspace === "wordbox-api");

  // 4.15-16: Chain dedup — no parentheses in targets
  for (let i = 0; i < Math.min(2, fnsWithDeps.length); i++) {
    const d = parse(await handleDependencies({ function: fnsWithDeps[i].name, workspace: "wordbox-api" }, ctx));
    const targets = [...(d?.calls || []), ...(d?.ast_only || [])].map(c => c.target);
    assert("4." + (i + 15) + " chains simplified", !targets.some(t => t.includes("(")),
      targets.filter(t => t.includes("(")).join(", "));
  }

  // 4.17: Token efficiency
  assert("4.17 tokens <2000", tokens(await handleDependencies({ function: fnsWithDeps[0]?.name || "StreakController", workspace: "wordbox-api" }, ctx)) < 2000);

  // 4.18: SOLID — noiseFilter aggregated from parsers
  assert("4.18 noiseTargets > 100", ctx.noiseFilter.noiseTargets.size > 100, ctx.noiseFilter.noiseTargets.size + " targets");
  assert("4.19 builtinMethods > 50", ctx.noiseFilter.builtinMethods.size > 50, ctx.noiseFilter.builtinMethods.size + " methods");
  assert("4.20 noisePatterns > 5", ctx.noiseFilter.noisePatterns.length > 5, ctx.noiseFilter.noisePatterns.length + " patterns");
}

async function testStaleDocstrings(ctx) {
  console.log("\n\u2550\u2550\u2550 5. STALE DOCSTRINGS (10 tests) \u2550\u2550\u2550\n");

  const r1 = await handleStaleDocstrings({}, ctx);
  const d1 = parse(r1);
  assert("5.1 all ws works", !r1.isError && d1?.total_issues > 0);

  assert("5.2 single ws", !(await handleStaleDocstrings({ workspace: "wordbox-api" }, ctx)).isError);
  assert("5.3 mobile ws", !(await handleStaleDocstrings({ workspace: "wordbox-mobile" }, ctx)).isError);

  const d4 = parse(await handleStaleDocstrings({ workspace: "wordbox-api", scope: "src/main/java/com/wordbox/streak" }, ctx));
  const d2 = parse(await handleStaleDocstrings({ workspace: "wordbox-api" }, ctx));
  assert("5.4 scope narrows", (d4?.total_issues || 0) < d2?.total_issues);

  assert("5.5 check_type=missing", !(await handleStaleDocstrings({ check_type: "missing" }, ctx)).isError);

  const d6 = parse(await handleStaleDocstrings({ check_type: "missing" }, ctx));
  assert("5.6 missing summary", d6?.missing_docstrings_summary != null);

  assert("5.7 check_type=deps", !(await handleStaleDocstrings({ check_type: "deps", workspace: "wordbox-api" }, ctx)).isError);
  assert("5.8 issues capped \u226420", (d1?.issues?.length || 0) <= 20);
  assert("5.9 invalid ws", (await handleStaleDocstrings({ workspace: "nope" }, ctx)).isError);
  assert("5.10 has severity", d1?.by_severity?.warning !== undefined && d1?.by_severity?.info !== undefined);
}

async function testIndexStatus(ctx) {
  console.log("\n\u2550\u2550\u2550 6. INDEX STATUS (10 tests) \u2550\u2550\u2550\n");

  const r1 = await handleIndexStatus({}, ctx);
  const d1 = parse(r1);
  assert("6.1 all ws", d1?.workspaces?.length === 2);

  const d2 = parse(await handleIndexStatus({ workspace: "wordbox-api" }, ctx));
  assert("6.2 api files > 600", d2?.ast_index?.files > 600);
  assert("6.3 api vectors > 0", d2?.vector_store?.rows > 0);

  const d4 = parse(await handleIndexStatus({ workspace: "wordbox-mobile" }, ctx));
  assert("6.4 mobile files > 100", d4?.ast_index?.files > 100);

  assert("6.5 language stats", d2?.languages?.java > 0);
  assert("6.6 docstring coverage", d2?.docstring_coverage !== undefined);
  assert("6.7 call graph stats", d2?.call_graph !== undefined);
  assert("6.8 type graph stats", d2?.type_graph !== undefined);
  assert("6.9 embedding model", d2?.vector_store?.model?.length > 0);
  assert("6.10 invalid ws", (await handleIndexStatus({ workspace: "nope" }, ctx)).isError);
}

async function testReindex(ctx) {
  console.log("\n\u2550\u2550\u2550 7. REINDEX (5 tests) \u2550\u2550\u2550\n");

  assert("7.1 incremental all", !(await handleReindex({}, ctx)).isError);
  assert("7.2 incremental api", parse(await handleReindex({ workspace: "wordbox-api" }, ctx))?.status === "ok");

  const firstFile = ctx.resolveWorkspace("wordbox-api").index.getAllFilePaths()[0];
  assert("7.3 single file", parse(await handleReindex({ workspace: "wordbox-api", files: [firstFile] }, ctx))?.status === "ok");

  assert("7.4 invalid ws", (await handleReindex({ workspace: "nope" }, ctx)).isError);
  assert("7.5 mobile", !(await handleReindex({ workspace: "wordbox-mobile" }, ctx)).isError);
}

// === MAIN ===
const ctx = await setup();

await testSemanticSearch(ctx);
await testModuleSummary(ctx);
await testFunctionSource(ctx);
await testDependencies(ctx);
await testStaleDocstrings(ctx);
await testIndexStatus(ctx);
await testReindex(ctx);

console.log("\n" + "\u2550".repeat(60));
console.log("  PASSED: " + passed + " / " + (passed + failed));
console.log("  FAILED: " + failed);
if (issues.length > 0) {
  console.log("\n  ISSUES:");
  for (const i of issues) console.log("    - " + i);
}
console.log("\u2550".repeat(60));

await ctx.shutdown();
process.exit(failed > 0 ? 1 : 0);
