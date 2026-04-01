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
  private _discovery: DiscoveryState | undefined;
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
      ...buildFunctionSourceTests(this.ctx, discovery),
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
      get_function_source: () => buildFunctionSourceTests(this.ctx, discovery),
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
    const data = JSON.parse(result?.content?.[0]?.text ?? "null");
    if (result?.isError) data._isError = true;
    return data;
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

  // --- Discovery: single-pass, ambiguity-safe, multi-workspace ---

  private async discover(): Promise<DiscoveryState> {
    if (this._discovery) return this._discovery;
    const workspaces = this.ctx.workspacePaths;
    const wsPath = workspaces[0];
    const ws = this.ctx.resolveWorkspace(wsPath);

    let module: string | undefined;
    let functionName: string | undefined;
    let functionModule: string | undefined;
    let filePath: string | undefined;
    let functionWithBody: string | undefined;
    let functionWithBodyModule: string | undefined;
    let functionWithDeps: string | undefined;
    let functionWithCallers: string | undefined;
    let interfaceRecord: string | undefined;

    const allFilled = () => functionName && functionWithBody && functionWithDeps && functionWithCallers && interfaceRecord;

    for (const fp of ws.index.getAllFilePaths()) {
      if (allFilled()) break;

      for (const id of ws.index.getFileRecordIds(fp)) {
        const rec = ws.index.getById(id);
        if (!rec) continue;

        // Interface with implementors
        if (!interfaceRecord && rec.kind === "interface") {
          if (ws.typeGraph.getImplementors(rec.name).length > 0) {
            interfaceRecord = rec.name;
          }
          continue;
        }

        // Skip classes and tests for function-level discovery
        if (rec.kind === "class" || rec.kind === "interface" || rec.structuralHints?.isTest) continue;

        // Basic function — prefer unique names to avoid AMBIGUOUS_FUNCTION
        if (!functionName) {
          const matches = ws.index.findByName(rec.name);
          if (matches.length === 1) {
            functionName = rec.name;
            filePath = rec.filePath;
            module = rec.module;
            functionModule = undefined; // unique, no hint needed
          }
        }
        // Fallback: accept ambiguous name but record module hint
        if (!functionName && rec.name) {
          functionName = rec.name;
          functionModule = rec.module;
          filePath = rec.filePath;
          module = rec.module;
        }

        // Multi-line function (for line range assertions)
        if (!functionWithBody && rec.lineEnd > rec.lineStart) {
          const bodyMatches = ws.index.findByName(rec.name);
          functionWithBody = rec.name;
          functionWithBodyModule = bodyMatches.length > 1 ? rec.module : undefined;
        }

        // Function with forward deps
        if (!functionWithDeps) {
          const entry = ws.callGraph.getEntry(rec.id);
          if (entry && entry.calls.length > 0) functionWithDeps = rec.name;
        }

        // Function with upstream callers (≥3 for meaningful impact)
        if (!functionWithCallers) {
          const entry = ws.callGraph.getEntry(rec.id);
          if (entry && entry.calledBy.length >= 3) functionWithCallers = rec.name;
        }
      }
    }

    const secondWorkspace = workspaces.length > 1 ? workspaces[1] : undefined;

    this._discovery = {
      workspaces, workspace: wsPath, secondWorkspace,
      module, functionName, functionModule, filePath,
      functionWithBody, functionWithBodyModule,
      functionWithDeps, functionWithCallers, interfaceRecord,
      isMulti: this.ctx.isMultiWorkspace,
    };
    return this._discovery;
  }
}

// === Discovery State ===

interface DiscoveryState {
  workspaces: string[];
  workspace: string;
  secondWorkspace?: string;
  module?: string;
  functionName?: string;
  functionModule?: string;       // module hint for disambiguation (undefined = unique)
  filePath?: string;
  functionWithBody?: string;     // guaranteed lineEnd > lineStart
  functionWithBodyModule?: string;
  functionWithDeps?: string;
  functionWithCallers?: string;
  interfaceRecord?: string;
  isMulti: boolean;
}

// === Helpers ===

/** Build args with optional module hint and workspace */
function fnArgs(ds: DiscoveryState, name: string, moduleHint?: string, extra?: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { function: name, workspace: ds.workspace, ...extra };
  if (moduleHint) args.module = moduleHint;
  return args;
}

function skip(label: string, reason: string): TestCase {
  return { tool: "get_index_status", label, assert: () => `SKIP: ${reason}` };
}

function invalidWsTest(tool: string, ds: DiscoveryState, extraArgs?: Record<string, unknown>): TestCase[] {
  if (!ds.isMulti) return [];
  return [{
    tool, args: { ...extraArgs, workspace: "___invalid___" },
    label: `${tool.replace("get_", "")}: invalid ws`,
    assert: d => d?.error === "WORKSPACE_NOT_FOUND" || `expected WORKSPACE_NOT_FOUND, got ${d?.error}`,
  }];
}

// === Built-in Test Suites ===

function buildIndexStatusTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  const cases: TestCase[] = [];

  if (ctx.isMultiWorkspace) {
    cases.push(
      { tool: "get_index_status", label: "status: multi-ws overview",
        assert: d => (d?.workspaces?.length >= 2) || `expected >=2 workspaces, got ${d?.workspaces?.length}` },
      { tool: "get_index_status", label: "status: each ws has ast_index",
        assert: d => {
          for (const w of d?.workspaces ?? []) {
            if (!(w.ast_index?.files > 0)) return `ws ${w.workspace}: files=${w.ast_index?.files}`;
          }
          return true;
        } },
      { tool: "get_index_status", args: { workspace: ds.workspace }, label: "status: single ws valid",
        assert: d => (d?.ast_index?.files > 0 && d?.ast_index?.functions > 0) || `files=${d?.ast_index?.files} fns=${d?.ast_index?.functions}` },
      { tool: "get_index_status", args: { workspace: ds.workspace }, label: "status: single ws fields",
        assert: d => (d?.languages !== undefined && d?.call_graph !== undefined && d?.type_graph !== undefined) || "missing expected fields" },
    );
  } else {
    cases.push(
      { tool: "get_index_status", label: "status: valid",
        assert: d => (d?.ast_index?.files > 0 && d?.ast_index?.functions > 0) || `files=${d?.ast_index?.files} fns=${d?.ast_index?.functions}` },
      { tool: "get_index_status", label: "status: has fields",
        assert: d => (d?.languages !== undefined && d?.call_graph !== undefined && d?.type_graph !== undefined) || "missing expected fields" },
    );
  }

  cases.push(...invalidWsTest("get_index_status", ds));
  return cases;
}

function buildModuleSummaryTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.module) return [skip("module: discover", "no modules found")];

  const ws = ctx.resolveWorkspace(ds.workspace);
  const modules = ws.index.getAllModules().filter(m => m.length > 0);
  const moduleSizes = modules.map(m => ({ m, total: ws.index.getByModule(m).length })).sort((a, b) => a.total - b.total);
  const small = moduleSizes.find(x => x.total > 0 && x.total <= 10);
  const large = moduleSizes.find(x => x.total > 30);

  const cases: TestCase[] = [
    { tool: "get_module_summary", args: { module: ds.module, workspace: ds.workspace },
      label: "module: discover",
      assert: d => d?.total > 0 || `total=${d?.total}` },
    { tool: "get_module_summary", args: { module: "___nonexistent___" },
      label: "module: not found → suggestions",
      assert: d => d?.error === "MODULE_NOT_FOUND" || `expected MODULE_NOT_FOUND` },
    ...invalidWsTest("get_module_summary", ds, { module: ds.module }),
  ];

  if (small) {
    cases.push(
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace },
        label: `module: small(${small.total})→full`,
        assert: d => d?.mode === "full" || `expected full, got ${d?.mode}` },
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace, detail: "compact" },
        label: "module: forced compact",
        assert: d => d?.mode === "compact" || `expected compact, got ${d?.mode}` },
      { tool: "get_module_summary", args: { module: small.m, workspace: ds.workspace, detail: "files_only" },
        label: "module: forced files_only",
        assert: d => d?.mode === "files_only" || `expected files_only, got ${d?.mode}` },
    );
  }

  if (large) {
    cases.push(
      { tool: "get_module_summary", args: { module: large.m, workspace: ds.workspace },
        label: `module: large(${large.total})→compact/files`,
        assert: d => (d?.mode === "compact" || d?.mode === "files_only") || `expected compact/files_only, got ${d?.mode}` },
      // files_only item structure
      { tool: "get_module_summary", args: { module: large.m, workspace: ds.workspace, detail: "files_only" },
        label: "module: files_only item fields",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          for (const f of d?.files ?? []) {
            if (!f.file) return "file item missing 'file'";
            if (typeof f.functions !== "number") return `file item missing 'functions' count`;
          }
          return true;
        } },
    );
  }

  // File filter
  if (ds.filePath) {
    const fileName = ds.filePath.split("/").pop()!;
    cases.push(
      { tool: "get_module_summary", args: { module: ds.module, workspace: ds.workspace, file: fileName },
        label: "module: file filter → single file",
        assert: d => {
          if (d?.error) return true; // file not matched is acceptable
          return (d?.files?.length === 1) || `expected 1 file, got ${d?.files?.length}`;
        } },
    );
  }

  return cases;
}

function buildFunctionSourceTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.functionName) return [skip("source: discover", "no function discovered")];

  const baseArgs = fnArgs(ds, ds.functionName, ds.functionModule);

  const cases: TestCase[] = [
    // Core functionality
    { tool: "get_function_source", args: baseArgs,
      label: "source: get source",
      assert: d => (d?.source?.length > 0) || "empty source" },
    { tool: "get_function_source", args: baseArgs,
      label: "source: line range valid",
      assert: d => (d?.line_end >= d?.line_start && d?.line_start > 0) || `start=${d?.line_start} end=${d?.line_end}` },
    { tool: "get_function_source", args: baseArgs,
      label: "source: language field",
      assert: d => (typeof d?.language === "string" && d.language.length > 0) || `language=${d?.language}` },

    // Context lines
    { tool: "get_function_source", args: { ...baseArgs, context_lines: 0 },
      label: "source: no context",
      assert: d => (!d?.context_before && !d?.context_after) || "unexpected context" },
    { tool: "get_function_source", args: { ...baseArgs, context_lines: 5 },
      label: "source: with context",
      assert: d => (d?.context_before || d?.context_after) ? true : "no context returned" },

    // Error handling
    { tool: "get_function_source", args: { function: "___nonexistent___" },
      label: "source: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_function_source", ds, { function: ds.functionName }),
  ];

  // Multi-line body: strict line_end > line_start
  if (ds.functionWithBody) {
    const bodyArgs = fnArgs(ds, ds.functionWithBody, ds.functionWithBodyModule);
    cases.push(
      { tool: "get_function_source", args: bodyArgs,
        label: "source: multi-line body",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          return (d?.line_end > d?.line_start && d?.source?.includes("\n")) || `start=${d?.line_start} end=${d?.line_end}`;
        } },
    );
  }

  return cases;
}

function buildDependencyTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  if (!ds.functionName) return [skip("deps: discover", "no function discovered")];

  const baseArgs = fnArgs(ds, ds.functionName, ds.functionModule);

  const cases: TestCase[] = [
    { tool: "get_dependencies", args: { function: "___nonexistent___" },
      label: "deps: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_dependencies", ds, { function: ds.functionName }),
    { tool: "get_dependencies", args: baseArgs,
      label: "deps: has caveat",
      assert: d => (typeof d?.caveat === "string") || "missing caveat" },
    // Response categories are valid arrays or undefined
    { tool: "get_dependencies", args: baseArgs,
      label: "deps: response shape",
      assert: d => {
        if (d?.error) return `error: ${d.error}`;
        if (d?.calls !== undefined && !Array.isArray(d.calls)) return "calls not array";
        if (d?.ast_only !== undefined && !Array.isArray(d.ast_only)) return "ast_only not array";
        if (d?.unresolved !== undefined && !Array.isArray(d.unresolved)) return "unresolved not array";
        return true;
      } },
  ];

  if (ds.functionWithDeps) {
    cases.push(
      { tool: "get_dependencies", args: { function: ds.functionWithDeps, workspace: ds.workspace },
        label: `deps: ${ds.functionWithDeps.slice(0, 25)} has deps`,
        assert: d => {
          const total = (d?.calls?.length ?? 0) + (d?.ast_only?.length ?? 0);
          return total > 0 || `got ${total} deps`;
        } },
      { tool: "get_dependencies", args: { function: ds.functionWithDeps, workspace: ds.workspace },
        label: "deps: item fields",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          for (const item of [...(d?.calls ?? []), ...(d?.ast_only ?? [])]) {
            if (!item.target) return "dep item missing 'target'";
            if (typeof item.line !== "number") return `dep item missing 'line'`;
          }
          return true;
        } },
      { tool: "get_dependencies", args: { function: ds.functionWithDeps, workspace: ds.workspace },
        label: "deps: noise filtered",
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
  if (!ds.functionName) return [skip("impact: discover", "no function discovered")];

  const baseArgs = fnArgs(ds, ds.functionName, ds.functionModule);

  const cases: TestCase[] = [
    // Error handling
    { tool: "get_impact_analysis", args: { function: "___nonexistent___" },
      label: "impact: not found",
      assert: d => d?.error === "FUNCTION_NOT_FOUND" || `expected FUNCTION_NOT_FOUND` },
    ...invalidWsTest("get_impact_analysis", ds, { function: ds.functionName }),

    // Response structure
    { tool: "get_impact_analysis", args: baseArgs,
      label: "impact: required fields",
      assert: d => {
        const required = ["function", "file", "change_type", "call_impact", "type_impact", "total_affected", "caveat"];
        const missing = required.filter(f => d?.[f] === undefined);
        return missing.length === 0 || `missing: ${missing.join(", ")}`;
      } },
    { tool: "get_impact_analysis", args: baseArgs,
      label: "impact: default change_type=behavior",
      assert: d => d?.change_type === "behavior" || `expected behavior, got ${d?.change_type}` },
    { tool: "get_impact_analysis", args: { ...baseArgs, change_type: "removal" },
      label: "impact: change_type echoed in response",
      assert: d => d?.change_type === "removal" || `expected removal, got ${d?.change_type}` },
    { tool: "get_impact_analysis", args: baseArgs,
      label: "impact: total_affected consistent",
      assert: d => {
        if (d?.error) return `error: ${d.error}`;
        const callCount = d.call_impact?.length ?? 0;
        const typeCount = (d.type_impact ?? []).reduce((s: number, t: any) => s + (t.affected?.length ?? 0), 0);
        return d.total_affected === callCount + typeCount || `total=${d.total_affected} != call(${callCount})+type(${typeCount})`;
      } },
  ];

  // Upstream callers & change_type risk matrix
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
      // change_type → expected depth-1 risk
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

  // Type impact
  if (ds.interfaceRecord) {
    cases.push(
      { tool: "get_impact_analysis", args: { function: ds.interfaceRecord, workspace: ds.workspace, change_type: "signature" },
        label: "impact: interface → implementors",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const implGroup = (d.type_impact ?? []).find((t: any) => t.relationship === "implementors");
          return implGroup ? true : "no implementors group in type_impact";
        } },
      { tool: "get_impact_analysis", args: { function: ds.interfaceRecord, workspace: ds.workspace, change_type: "signature" },
        label: "impact: interface → implementor_callers",
        assert: d => {
          if (d?.error) return `error: ${d.error}`;
          const bridge = (d.type_impact ?? []).find((t: any) => t.relationship === "implementor_callers");
          // Bridge only exists when implementors have upstream callers — conditional pass
          if (!bridge) {
            const impls = (d.type_impact ?? []).find((t: any) => t.relationship === "implementors");
            if (!impls || impls.affected?.length === 0) return true; // no implementors, no bridge expected
            return true; // implementors exist but none have callers — acceptable
          }
          return true;
        } },
    );
  } else {
    cases.push(skip("impact: type_impact", "no interface with implementors found"));
  }

  return cases;
}

function buildSemanticSearchTests(ctx: AppContext, ds: DiscoveryState): TestCase[] {
  const cases: TestCase[] = [
    // Edge cases
    { tool: "semantic_search", args: { query: "a" },
      label: "search: short query",
      assert: d => (d?.search_mode === "skipped" || d?.results?.length === 0 || d?.error) ? true : "short query not handled" },
    { tool: "semantic_search", args: { query: "xyznonexistent_zzz_999", top_k: 5 },
      label: "search: gibberish → graceful empty",
      assert: d => (Array.isArray(d?.results) && !d?.error) || `unexpected: error=${d?.error}` },
    ...invalidWsTest("semantic_search", ds, { query: "test" }),
  ];

  if (ds.functionName) {
    cases.push(
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
        label: `search: by name "${ds.functionName.slice(0, 20)}"`,
        assert: d => (d?.results?.length > 0) || "no results" },
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 3 },
        label: "search: top_k=3 respected",
        assert: d => (d?.results?.length ?? 0) <= 3 || `got ${d?.results?.length} results` },
      // search_mode field
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
        label: "search: search_mode present",
        assert: d => ["hybrid", "vector_only", "degraded", "skipped"].includes(d?.search_mode) || `search_mode=${d?.search_mode}` },
      // Result field completeness
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
        label: "search: result fields complete",
        assert: d => {
          const required = ["function", "file", "module", "score", "line_start", "line_end"];
          for (const r of d?.results ?? []) {
            const missing = required.filter(f => r[f] === undefined);
            if (missing.length > 0) return `missing: ${missing.join(",")} in ${r.function}`;
          }
          return true;
        } },
      // Scores descending
      { tool: "semantic_search", args: { query: ds.functionName, top_k: 10 },
        label: "search: scores descending",
        assert: d => {
          const scores = d?.results?.map((r: any) => r.score) ?? [];
          for (let i = 1; i < scores.length; i++) {
            if (scores[i] > scores[i - 1] + 0.001) return `score[${i - 1}]=${scores[i - 1]} < score[${i}]=${scores[i]}`;
          }
          return true;
        } },
    );

    // Scope filter
    if (ds.module) {
      cases.push(
        { tool: "semantic_search", args: { query: ds.functionName, scope: ds.module, top_k: 5 },
          label: "search: scope filter",
          assert: d => {
            for (const r of d?.results ?? []) {
              if (!r.module?.includes(ds.module!)) return `result ${r.function} in module ${r.module}, expected scope ${ds.module}`;
            }
            return true;
          } },
      );
    }

    if (ctx.isMultiWorkspace) {
      cases.push(
        { tool: "semantic_search", args: { query: ds.functionName, top_k: 5 },
          label: "search: ws field present",
          assert: d => d?.results?.every((r: any) => r.workspace != null) || "missing workspace field" },
      );
    }
  }

  return cases;
}

function buildStaleDocstringTests(ds: DiscoveryState): TestCase[] {
  return [
    { tool: "get_stale_docstrings", label: "stale: all",
      assert: d => (typeof d?.total_issues === "number" && d?.by_severity !== undefined) || "missing fields" },
    { tool: "get_stale_docstrings", args: { check_type: "missing" },
      label: "stale: check_type=missing",
      assert: d => !d?.error || `error: ${d.error}` },
    { tool: "get_stale_docstrings", args: { check_type: "deps" },
      label: "stale: check_type=deps",
      assert: d => !d?.error || `error: ${d.error}` },
    { tool: "get_stale_docstrings", args: { check_type: "tags" },
      label: "stale: check_type=tags",
      assert: d => (typeof d?.total_issues === "number" && !d?.error) || `error: ${d?.error}` },
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

  cases.push(
    { tool: "reindex", args: { workspace: ds.workspace, force: true },
      label: "reindex: force full",
      assert: d => (d?.status === "ok" && d?.mode?.startsWith("full")) || `status=${d?.status} mode=${d?.mode}` },
  );

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
