import path from "node:path";
import { performance } from "node:perf_hooks";
import { createServices, initializeWorkspaces } from "./services.js";
import type { AppContext, WorkspaceServices } from "./types/interfaces.js";

import { handleSemanticSearch } from "./tools/semantic-search.js";
import { handleModuleSummary } from "./tools/module-summary.js";
import { handleFunctionSource } from "./tools/function-source.js";
import { handleDependencies } from "./tools/dependencies.js";
import { handleImpactAnalysis } from "./tools/impact-analysis.js";
import { handleStaleDocstrings } from "./tools/stale-docstrings.js";
import { handleReindex } from "./tools/reindex.js";
import { handleIndexStatus } from "./tools/index-status.js";

// === Types ===

export interface TestCase {
  tool: string;
  args?: Record<string, unknown>;
  label?: string;
  assert?: (data: any) => true | string;
}

export interface TestResult {
  label: string;
  tool: string;
  status: "pass" | "fail" | "data" | "skip";
  elapsedMs: number;
  tokens: number;
  data: any;
  error?: string;
  detail: string;
}

export interface SuiteReport {
  project: string;
  results: TestResult[];
  passed: number;
  failed: number;
  dataOnly: number;
  skipped: number;
  totalMs: number;
}

// === Handler Registry ===

const HANDLERS: Record<string, (args: any, ctx: AppContext) => Promise<any>> = {
  semantic_search: handleSemanticSearch,
  get_module_summary: handleModuleSummary,
  get_function_source: handleFunctionSource,
  get_dependencies: handleDependencies,
  get_impact_analysis: handleImpactAnalysis,
  get_stale_docstrings: handleStaleDocstrings,
  reindex: handleReindex,
  get_index_status: handleIndexStatus,
};

// === TestHarness ===

export class TestHarness {
  readonly ctx: AppContext;
  private constructor(ctx: AppContext) { this.ctx = ctx; }

  static async setup(projectPath: string): Promise<TestHarness> {
    const absPath = path.resolve(projectPath);
    const start = performance.now();
    console.log(`Setting up: ${absPath}`);

    const ctx = await createServices(absPath);
    await initializeWorkspaces(ctx, { embed: false });

    for (const wsPath of ctx.workspacePaths) {
      const ws = ctx.resolveWorkspace(wsPath);
      const stats = ws.index.getStats();
      const vectors = await ws.vectorDb.countRows();
      console.log(`  ${wsPath}: ${stats.files} files, ${stats.functions} functions, ${vectors} vectors`);
    }
    console.log(`  Embeddings: ${ctx.embeddingAvailable ? "available" : "unavailable"}`);
    console.log(`Ready (${((performance.now() - start) / 1000).toFixed(1)}s)\n`);

    return new TestHarness(ctx);
  }

  // --- Mod 1: Built-in tests ---

  async testAll(): Promise<SuiteReport> {
    const discovery = await this.discover();
    const cases: TestCase[] = [
      ...buildIndexStatusTests(this.ctx, discovery),
      ...buildModuleSummaryTests(this.ctx, discovery),
      ...buildFunctionSourceTests(discovery),
      ...buildDependencyTests(this.ctx, discovery),
      ...buildImpactAnalysisTests(this.ctx, discovery),
      ...buildSemanticSearchTests(this.ctx, discovery),
      ...buildStaleDocstringTests(discovery),
      ...buildReindexTests(this.ctx, discovery),
    ];
    return this.run(cases);
  }

  async test(tool: string): Promise<SuiteReport> {
    const discovery = await this.discover();
    const builders: Record<string, () => TestCase[]> = {
      get_index_status: () => buildIndexStatusTests(this.ctx, discovery),
      get_module_summary: () => buildModuleSummaryTests(this.ctx, discovery),
      get_function_source: () => buildFunctionSourceTests(discovery),
      get_dependencies: () => buildDependencyTests(this.ctx, discovery),
      get_impact_analysis: () => buildImpactAnalysisTests(this.ctx, discovery),
      semantic_search: () => buildSemanticSearchTests(this.ctx, discovery),
      get_stale_docstrings: () => buildStaleDocstringTests(discovery),
      reindex: () => buildReindexTests(this.ctx, discovery),
    };
    const builder = builders[tool];
    if (!builder) throw new Error(`Unknown tool: ${tool}. Available: ${Object.keys(builders).join(", ")}`);
    return this.run(builder());
  }

  // --- Mod 2: Agent-defined cases ---

  async run(cases: TestCase[]): Promise<SuiteReport> {
    const suiteStart = performance.now();
    const results: TestResult[] = [];

    for (const c of cases) {
      const label = c.label ?? autoLabel(c);
      try {
        const { data, isError, tokens, elapsedMs } = await this.callRaw(c.tool, c.args);
        const detail = summarize(c.tool, data);

        if (!c.assert) {
          results.push({ label, tool: c.tool, status: "data", elapsedMs, tokens, data, detail });
        } else {
          const verdict = c.assert(data);
          if (verdict === true) {
            results.push({ label, tool: c.tool, status: "pass", elapsedMs, tokens, data, detail });
          } else {
            const error = typeof verdict === "string" ? verdict : "assertion failed";
            results.push({ label, tool: c.tool, status: "fail", elapsedMs, tokens, data, error, detail });
          }
        }
      } catch (err) {
        results.push({
          label, tool: c.tool, status: "fail", elapsedMs: 0, tokens: 0, data: null,
          error: err instanceof Error ? err.message : String(err), detail: "exception",
        });
      }
    }

    const report = buildReport(this.ctx.config.projectRoot, results, performance.now() - suiteStart);
    printReport(report);
    return report;
  }

  // --- Mod 3: Manual calls ---

  async call(tool: string, args?: Record<string, unknown>): Promise<any> {
    const handler = HANDLERS[tool];
    if (!handler) throw new Error(`Unknown tool: ${tool}`);
    const result = await handler(args ?? {}, this.ctx);
    return JSON.parse(result?.content?.[0]?.text ?? "null");
  }

  async callRaw(tool: string, args?: Record<string, unknown>): Promise<{
    data: any; isError: boolean; tokens: number; elapsedMs: number;
  }> {
    const handler = HANDLERS[tool];
    if (!handler) throw new Error(`Unknown tool: ${tool}`);
    const start = performance.now();
    const result = await handler(args ?? {}, this.ctx);
    const text = result?.content?.[0]?.text ?? "";
    return {
      data: JSON.parse(text || "null"),
      isError: result?.isError ?? false,
      tokens: Math.ceil(text.length / 4),
      elapsedMs: Math.round(performance.now() - start),
    };
  }

  // --- Internals ---

  ws(name?: string): WorkspaceServices {
    return this.ctx.resolveWorkspace(name);
  }

  async close(): Promise<void> {
    await this.ctx.shutdown();
    for (const wsPath of this.ctx.workspacePaths) {
      const ws = this.ctx.resolveWorkspace(wsPath);
      ws.indexWriter.clear();
      ws.callGraphWriter.clear();
      ws.typeGraphWriter.clear();
    }
  }

  // --- Discovery (internals-based, fast) ---

  private async discover(): Promise<DiscoveryState> {
    const workspaces = this.ctx.workspacePaths;
    const wsPath = workspaces[0];
    const ws = this.ctx.resolveWorkspace(wsPath);

    const modules = ws.index.getAllModules().filter(m => m.length > 0);
    let module = modules[0];

    let functionName: string | undefined;
    let filePath: string | undefined;
    let functionWithDeps: string | undefined;

    // Search across all modules for a non-test function (first module may be test-only)
    for (const mod of modules) {
      if (functionName) break;
      const recs = ws.index.getByModule(mod);
      const fn = recs.find(r => r.kind !== "class" && r.kind !== "interface" && !r.structuralHints?.isTest);
      if (fn) {
        module = mod;
        functionName = fn.name;
        filePath = fn.filePath;
      }
    }

    // Find a function with deps for dependency tests
    for (const fp of ws.index.getAllFilePaths()) {
      if (functionWithDeps) break;
      for (const id of ws.index.getFileRecordIds(fp)) {
        const rec = ws.index.getById(id);
        if (!rec || rec.kind === "class" || rec.kind === "interface" || rec.structuralHints?.isTest) continue;
        const entry = ws.callGraph.getEntry(rec.id);
        if (entry && entry.calls.length > 0) {
          functionWithDeps = rec.name;
          break;
        }
      }
    }

    // Find a function with upstream callers (for impact analysis tests)
    let functionWithCallers: string | undefined;
    for (const fp of ws.index.getAllFilePaths()) {
      if (functionWithCallers) break;
      for (const id of ws.index.getFileRecordIds(fp)) {
        const rec = ws.index.getById(id);
        if (!rec || rec.kind === "class" || rec.kind === "interface" || rec.structuralHints?.isTest) continue;
        const entry = ws.callGraph.getEntry(rec.id);
        if (entry && entry.calledBy.length >= 3) {
          functionWithCallers = rec.name;
          break;
        }
      }
    }

    // Find an interface with implementors (for type impact tests)
    let interfaceRecord: string | undefined;
    for (const fp of ws.index.getAllFilePaths()) {
      if (interfaceRecord) break;
      for (const id of ws.index.getFileRecordIds(fp)) {
        const rec = ws.index.getById(id);
        if (rec?.kind === "interface" && ws.typeGraph.getImplementors(rec.name).length > 0) {
          interfaceRecord = rec.name;
          break;
        }
      }
    }

    return { workspaces, workspace: wsPath, module, functionName, filePath, functionWithDeps, functionWithCallers, interfaceRecord, isMulti: this.ctx.isMultiWorkspace };
  }
}

// === Discovery State ===

interface DiscoveryState {
  workspaces: string[];
  workspace: string;
  module?: string;
  functionName?: string;
  filePath?: string;
  functionWithDeps?: string;
  functionWithCallers?: string;
  interfaceRecord?: string;
  isMulti: boolean;
}

// === Built-in Test Suites ===

function skip(label: string, reason: string): TestCase {
  return { tool: "get_index_status", label, assert: () => `SKIP: ${reason}` };
}

function invalidWsTest(tool: string, ds: DiscoveryState, extraArgs?: Record<string, unknown>): TestCase[] {
  if (!ds.isMulti) return [];  // single-ws projects ignore workspace param
  return [{
    tool, args: { ...extraArgs, workspace: "___invalid___" },
    label: `${tool.replace("get_", "")}: invalid ws`,
    assert: d => d?.error === "WORKSPACE_NOT_FOUND" || `expected WORKSPACE_NOT_FOUND, got ${d?.error}`,
  }];
}

function buildIndexStatusTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  const cases: TestCase[] = [];

  if (ctx.isMultiWorkspace) {
    // Multi-workspace without param → overview format (workspaces array, no top-level ast_index)
    cases.push(
      { tool: "get_index_status", label: "index_status: multi-ws overview",
        assert: d => (d?.workspaces?.length >= 2) || `expected >=2 workspaces, got ${d?.workspaces?.length}` },
      { tool: "get_index_status", label: "index_status: each ws has ast_index",
        assert: d => {
          for (const w of d?.workspaces ?? []) {
            if (!(w.ast_index?.files > 0)) return `ws ${w.workspace}: files=${w.ast_index?.files}`;
          }
          return true;
        } },
    );
    // Single workspace query → detailed format
    cases.push(
      { tool: "get_index_status", args: { workspace: ds.workspace }, label: "index_status: single ws valid",
        assert: d => (d?.ast_index?.files > 0 && d?.ast_index?.functions > 0) || `files=${d?.ast_index?.files} fns=${d?.ast_index?.functions}` },
      { tool: "get_index_status", args: { workspace: ds.workspace }, label: "index_status: single ws has fields",
        assert: d => (d?.languages !== undefined && d?.call_graph !== undefined && d?.type_graph !== undefined) || "missing expected fields" },
    );
  } else {
    cases.push(
      { tool: "get_index_status", label: "index_status: valid",
        assert: d => (d?.ast_index?.files > 0 && d?.ast_index?.functions > 0) || `files=${d?.ast_index?.files} fns=${d?.ast_index?.functions}` },
      { tool: "get_index_status", label: "index_status: has fields",
        assert: d => (d?.languages !== undefined && d?.call_graph !== undefined && d?.type_graph !== undefined) || "missing expected fields" },
    );
  }

  cases.push(...invalidWsTest("get_index_status", ds));
  return cases;
}

function buildModuleSummaryTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.module) return [skip("module_summary: discover", "no modules found")];

  const ws = ctx.resolveWorkspace(ds.workspace);
  const modules = ws.index.getAllModules().filter(m => m.length > 0);
  const moduleSizes = modules.map(m => ({ m, total: ws.index.getByModule(m).length })).sort((a, b) => a.total - b.total);
  const small = moduleSizes.find(x => x.total > 0 && x.total <= 10);
  const large = moduleSizes.find(x => x.total > 30);

  const cases: TestCase[] = [
    { tool: "get_module_summary", args: { module: ds.module, workspace: ds.workspace },
      label: "module_summary: discover",
      assert: d => d?.total > 0 || `total=${d?.total}` },
    { tool: "get_module_summary", args: { module: "___nonexistent___" },
      label: "module_summary: not found → suggestions",
      assert: d => d?.error === "MODULE_NOT_FOUND" || `expected MODULE_NOT_FOUND` },
    ...invalidWsTest("get_module_summary", ds, { module: ds.module }),
  ];

  if (small) {
    cases.push(
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace },
        label: `module_summary: small(${small.total})→full`,
        assert: d => d?.mode === "full" || `expected full, got ${d?.mode}` },
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace, detail: "compact" },
        label: "module_summary: forced compact",
        assert: d => d?.mode === "compact" || `expected compact, got ${d?.mode}` },
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace, detail: "files_only" },
        label: "module_summary: forced files_only",
        assert: d => d?.mode === "files_only" || `expected files_only, got ${d?.mode}` },
    );
  }

  if (large) {
    cases.push(
      { tool: "get_module_summary", args: { module: large.m, workspace: ds.workspace },
        label: `module_summary: large(${large.total})→compact/files`,
        assert: d => (d?.mode === "compact" || d?.mode === "files_only") || `expected compact/files_only, got ${d?.mode}` },
    );
  }

  return cases;
}

function buildFunctionSourceTests(ds: DiscoveryState): TestCase[] {
  if (!ds.functionName) return [skip("function_source: discover", "no function discovered")];

  return [
    { tool: "get_function_source", args: { function: ds.functionName, workspace: ds.workspace },
      label: "function_source: get source",
      assert: d => (d?.source?.length > 0) || "empty source" },
    { tool: "get_function_source", args: { function: ds.functionName, workspace: ds.workspace },
      label: "function_source: line range",
      assert: d => (d?.line_end > d?.line_start) || `start=${d?.line_start} end=${d?.line_end}` },
    { tool: "get_function_source", args: { function: ds.functionName, workspace: ds.workspace },
      label: "function_source: language field",
      assert: d => (typeof d?.language === "string" && d.language.length > 0) || `language=${d?.language}` },
    { tool: "get_function_source", args: { function: ds.functionName, workspace: ds.workspace, context_lines: 0 },
      label: "function_source: no context",
      assert: d => (!d?.context_before && !d?.context_after) || "unexpected context" },
    { tool: "get_function_source", args: { function: ds.functionName, workspace: ds.workspace, context_lines: 5 },
      label: "function_source: with context",
      assert: d => (d?.context_before || d?.context_after) ? true : "no context returned" },
    { tool: "get_function_source", args: { function: "___nonexistent___" },
      label: "function_source: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_function_source", ds, { function: ds.functionName }),
  ];
}

function buildDependencyTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.functionName) return [skip("dependencies: discover", "no function discovered")];

  const cases: TestCase[] = [
    { tool: "get_dependencies", args: { function: "___nonexistent___" },
      label: "dependencies: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_dependencies", ds, { function: ds.functionName }),
    { tool: "get_dependencies", args: { function: ds.functionName, workspace: ds.workspace },
      label: "dependencies: has caveat",
      assert: d => (typeof d?.caveat === "string") || "missing caveat" },
  ];

  if (ds.functionWithDeps) {
    cases.push(
      { tool: "get_dependencies", args: { function: ds.functionWithDeps, workspace: ds.workspace },
        label: `dependencies: ${ds.functionWithDeps.slice(0, 25)} has deps`,
        assert: d => {
          const total = (d?.calls?.length ?? 0) + (d?.ast_only?.length ?? 0);
          return total > 0 || `got ${total} deps`;
        } },
      { tool: "get_dependencies", args: { function: ds.functionWithDeps, workspace: ds.workspace },
        label: "dependencies: noise filtered",
        assert: d => {
          const targets = [...(d?.calls ?? []), ...(d?.ast_only ?? [])].map((c: any) => c.target);
          const noisy = targets.filter((t: string) =>
            ctx.noiseFilter.noiseTargets.has(t) ||
            (t.includes(".") && ctx.noiseFilter.builtinMethods.has(t.split(".").pop()!))
          );
          return noisy.length === 0 || `noise found: ${noisy.join(", ")}`;
        } },
    );
  }

  return cases;
}

function buildImpactAnalysisTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.functionName) return [skip("impact_analysis: discover", "no function discovered")];

  const cases: TestCase[] = [
    // Error handling
    { tool: "get_impact_analysis", args: { function: "___nonexistent___" },
      label: "impact: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_impact_analysis", ds, { function: ds.functionName }),

    // Response structure
    { tool: "get_impact_analysis", args: { function: ds.functionName, workspace: ds.workspace },
      label: "impact: has caveat",
      assert: d => typeof d?.caveat === "string" || "missing caveat" },
    { tool: "get_impact_analysis", args: { function: ds.functionName, workspace: ds.workspace },
      label: "impact: required fields",
      assert: d => {
        const required = ["function", "file", "change_type", "call_impact", "type_impact", "total_affected", "caveat"];
        const missing = required.filter(f => d?.[f] === undefined);
        return missing.length === 0 || `missing: ${missing.join(", ")}`;
      } },
    { tool: "get_impact_analysis", args: { function: ds.functionName, workspace: ds.workspace },
      label: "impact: default change_type=behavior",
      assert: d => d?.change_type === "behavior" || `expected behavior, got ${d?.change_type}` },
    { tool: "get_impact_analysis", args: { function: ds.functionName, workspace: ds.workspace },
      label: "impact: total_affected consistent",
      assert: d => {
        if (d?.error) return `error: ${d.error}`;
        const callCount = d.call_impact?.length ?? 0;
        const typeCount = (d.type_impact ?? []).reduce((s: number, t: any) => s + (t.affected?.length ?? 0), 0);
        return d.total_affected === callCount + typeCount || `total=${d.total_affected} != call(${callCount})+type(${typeCount})`;
      } },
  ];

  // Upstream callers & change_type matrix (conditional: functionWithCallers)
  if (ds.functionWithCallers) {
    cases.push(
      { tool: "get_impact_analysis", args: { function: ds.functionWithCallers, workspace: ds.workspace, change_type: "signature" },
        label: "impact: callers → call_impact > 0",
        assert: d => (d?.call_impact?.length > 0) || `expected callers, got ${d?.call_impact?.length}` },
      { tool: "get_impact_analysis", args: { function: ds.functionWithCallers, workspace: ds.workspace, change_type: "signature" },
        label: "impact: call_impact item fields",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          for (const item of d.call_impact ?? []) {
            const fields = ["function", "file", "module", "line_start", "kind", "depth", "risk"];
            const missing = fields.filter(f => item[f] === undefined);
            if (missing.length > 0) return `item missing: ${missing.join(", ")}`;
          }
          return true;
        } },
      // change_type → expected depth-1 risk matrix
      ...(([["signature", "high"], ["behavior", "medium"], ["removal", "high"]] as const).map(([ct, expectedRisk]) => ({
        tool: "get_impact_analysis" as const,
        args: { function: ds.functionWithCallers!, workspace: ds.workspace, change_type: ct },
        label: `impact: ${ct} → depth-1 ${expectedRisk} risk`,
        assert: (d: any) => {
          if (d?.error) return `error: ${d.error}`;
          const depth1 = (d.call_impact ?? []).filter((c: any) => c.depth === 1);
          if (depth1.length === 0) return "no depth-1 callers";
          const bad = depth1.filter((c: any) => c.risk !== expectedRisk);
          return bad.length === 0 || `depth-1 should be ${expectedRisk}, got: ${bad.map((c: any) => c.risk).join(",")}`;
        },
      }))),
      { tool: "get_impact_analysis", args: { function: ds.functionWithCallers, workspace: ds.workspace },
        label: "impact: depth capped at 5",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const max = Math.max(...(d.call_impact ?? []).map((c: any) => c.depth), 0);
          return max <= 5 || `max depth=${max}`;
        } },
      { tool: "get_impact_analysis", args: { function: ds.functionWithCallers, workspace: ds.workspace },
        label: "impact: no duplicate callers",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const keys = (d.call_impact ?? []).map((c: any) => `${c.function}::${c.file}`);
          const dupes = keys.filter((k: string, i: number) => keys.indexOf(k) !== i);
          return dupes.length === 0 || `duplicates: ${dupes.join(", ")}`;
        } },
      { tool: "get_impact_analysis", args: { function: ds.functionWithCallers, workspace: ds.workspace, change_type: "signature" },
        label: "impact: call_line on depth-1 only",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          for (const item of d.call_impact ?? []) {
            if (item.depth === 1 && item.call_line === undefined) return `depth-1 caller ${item.function} missing call_line`;
            if (item.depth > 1 && item.call_line !== undefined) return `depth-${item.depth} caller ${item.function} should not have call_line`;
          }
          return true;
        } },
    );
  } else {
    cases.push(skip("impact: callers", "no function with >=3 callers found"));
  }

  // Type impact (conditional: interfaceRecord)
  if (ds.interfaceRecord) {
    cases.push(
      { tool: "get_impact_analysis", args: { function: ds.interfaceRecord, workspace: ds.workspace, change_type: "signature" },
        label: "impact: interface → implementors type_impact",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const implGroup = (d.type_impact ?? []).find((t: any) => t.relationship === "implementors");
          return implGroup ? true : "no implementors group in type_impact";
        } },
      { tool: "get_impact_analysis", args: { function: ds.interfaceRecord, workspace: ds.workspace, change_type: "signature" },
        label: "impact: interface → implementor_callers bridge",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const bridge = (d.type_impact ?? []).find((t: any) => t.relationship === "implementor_callers");
          return bridge ? true : "no implementor_callers in type_impact";
        } },
    );
  } else {
    cases.push(skip("impact: type_impact", "no interface with implementors found"));
  }

  return cases;
}

function buildSemanticSearchTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  const cases: TestCase[] = [
    { tool: "semantic_search", args: { query: "a" },
      label: "semantic_search: short query",
      assert: d => (d?.search_mode === "skipped" || d?.results?.length === 0 || d?.error) ? true : "short query not handled" },
    ...invalidWsTest("semantic_search", ds, { query: "test" }),
  ];

  if (ds.functionName) {
    cases.push(
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
        label: `semantic_search: by name "${ds.functionName.slice(0, 20)}"`,
        assert: d => (d?.results?.length > 0) || "no results" },
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 3 },
        label: "semantic_search: top_k=3 respected",
        assert: d => (d?.results?.length ?? 0) <= 3 || `got ${d?.results?.length} results` },
    );

    if (ctx.isMultiWorkspace) {
      cases.push(
        { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
          label: "semantic_search: ws field present",
          assert: d => d?.results?.every((r: any) => r.workspace != null) || "missing workspace field" },
      );
    }
  }

  return cases;
}

function buildStaleDocstringTests(ds: DiscoveryState): TestCase[] {
  return [
    { tool: "get_stale_docstrings", label: "stale_docstrings: all",
      assert: d => (typeof d?.total_issues === "number" && d?.by_severity !== undefined) || "missing fields" },
    { tool: "get_stale_docstrings", args: { check_type: "missing" },
      label: "stale_docstrings: check_type=missing",
      assert: d => !d?.error || `error: ${d.error}` },
    { tool: "get_stale_docstrings", args: { check_type: "deps" },
      label: "stale_docstrings: check_type=deps",
      assert: d => !d?.error || `error: ${d.error}` },
    ...invalidWsTest("get_stale_docstrings", ds),
  ];
}

function buildReindexTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  const cases: TestCase[] = [
    { tool: "reindex", args: { workspace: ds.workspace },
      label: "reindex: incremental",
      assert: d => d?.status === "ok" || `status=${d?.status}` },
    ...invalidWsTest("reindex", ds),
  ];

  if (ds.filePath) {
    cases.push(
      { tool: "reindex", args: { workspace: ds.workspace, files: [ds.filePath] },
        label: "reindex: single file",
        assert: d => d?.status === "ok" || `status=${d?.status}` },
    );
  }

  return cases;
}

// === Output ===

function autoLabel(c: TestCase): string {
  const firstVal = c.args ? Object.values(c.args)[0] : "";
  const valStr = typeof firstVal === "string" ? firstVal.slice(0, 30) : String(firstVal ?? "");
  return `${c.tool} ${valStr}`.trim();
}

function summarize(tool: string, data: any): string {
  if (!data) return "null response";
  if (data.error) return String(data.error);
  switch (tool) {
    case "semantic_search": {
      const n = data.results?.length ?? 0;
      const top = data.results?.[0];
      return `${n} results${top ? `, top: ${top.function} (${top.score?.toFixed(2)})` : ""}`;
    }
    case "get_module_summary":
      return `${data.total ?? 0} functions, ${data.files?.length ?? 0} files, mode=${data.mode ?? "?"}`;
    case "get_function_source":
      return `${data.name ?? data.function ?? "?"}: ${(data.line_end ?? 0) - (data.line_start ?? 0)} lines`;
    case "get_dependencies": {
      const deps = (data.calls?.length ?? 0) + (data.ast_only?.length ?? 0);
      return `${deps} deps, ${data.unresolved?.length ?? 0} unresolved`;
    }
    case "get_impact_analysis":
      return `${data.total_affected ?? 0} affected`;
    case "get_stale_docstrings":
      return `${data.total_issues ?? 0} issues`;
    case "get_index_status":
      return `${data.ast_index?.files ?? data.workspaces?.length ?? 0} files, ${data.ast_index?.functions ?? "?"} functions`;
    case "reindex":
      return `${data.mode ?? "?"}, ${data.changedFunctions ?? data.ast_index?.functions ?? 0} changed`;
    default:
      return JSON.stringify(data).slice(0, 80);
  }
}

function buildReport(project: string, results: TestResult[], totalMs: number): SuiteReport {
  return {
    project,
    results,
    passed: results.filter(r => r.status === "pass").length,
    failed: results.filter(r => r.status === "fail").length,
    dataOnly: results.filter(r => r.status === "data").length,
    skipped: results.filter(r => r.status === "skip").length,
    totalMs: Math.round(totalMs),
  };
}

function printReport(report: SuiteReport): void {
  for (const r of report.results) {
    const tag = r.status.toUpperCase().padEnd(4);
    const time = r.elapsedMs > 0 ? `${r.elapsedMs}ms` : "";
    const tokens = r.tokens > 0 ? `${r.tokens} tokens` : "";
    const meta = [time, tokens].filter(Boolean).join(" | ");

    console.log(`${tag}  ${r.label}`);

    if (r.status === "pass") {
      console.log(`      ${meta} | ${r.detail}`);
    } else if (r.status === "fail") {
      console.log(`      ${meta}`);
      console.log(`      assert: ${r.error}`);
      if (r.data != null) {
        console.log(`      data: ${JSON.stringify(r.data).slice(0, 200)}`);
      }
    } else if (r.status === "data") {
      console.log(`      ${meta} | ${r.detail}`);
      if (r.data != null) {
        console.log(`      data: ${JSON.stringify(r.data).slice(0, 200)}`);
      }
    } else if (r.status === "skip") {
      console.log(`      ${r.error ?? r.detail}`);
    }
    console.log();
  }

  console.log("═".repeat(50));
  const parts = [`${report.passed} passed`, `${report.failed} failed`];
  if (report.dataOnly > 0) parts.push(`${report.dataOnly} data-only`);
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  parts.push(`${(report.totalMs / 1000).toFixed(1)}s`);
  console.log(`  ${parts.join(" | ")}`);
  console.log("═".repeat(50));
}
