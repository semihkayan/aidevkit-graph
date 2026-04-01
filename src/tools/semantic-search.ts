import type { AppContext, WorkspaceServices, LanguageConventions } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaces, textResponse } from "./tool-utils.js";
import { applyDensityAdjustment, countParamsFromSignature } from "./density-scorer.js";
import { normalizeModuleQuery } from "../utils/file-utils.js";

const MIN_SCORE = 0.4;

/** Detect if the search query explicitly targets test code (e.g., "UserStreak test", "handler_test", "DailyActivityTest"). */
function queryTargetsTests(query: string): boolean {
  // \btest|_test: word-boundary or underscore prefix — covers "test auth", "handler_test", "test_payment"
  // [a-z]Test: camelCase suffix (case-sensitive to avoid "latest"→"atest") — covers "DailyActivityTest"
  return /\btest|_test/i.test(query) || /[a-z]Test/.test(query);
}

/**
 * Generate a brief summary from function metadata when no docstring exists.
 * Gives the agent enough context to triage search results without opening source.
 */
function buildAutoSummary(record: FunctionRecord, conventions?: LanguageConventions): string {
  // Class: show inheritance and method names so agent sees what the class offers
  if (record.kind === "class") {
    const methods = (record.classInfo?.methods || [])
      .filter(m => !conventions?.constructorNames?.has(m));
    const extendsInfo = record.classInfo?.inherits?.length
      ? ` extends ${record.classInfo.inherits.join(", ")}` : "";
    const implementsInfo = record.classInfo?.implements?.length
      ? ` implements ${record.classInfo.implements.join(", ")}` : "";
    const inheritsInfo = `${extendsInfo}${implementsInfo}`;
    const shown = methods.slice(0, 5).join(", ");
    const more = methods.length > 5 ? `, +${methods.length - 5} more` : "";
    return methods.length > 0
      ? `Class${inheritsInfo}, ${methods.length} methods: ${shown}${more}`
      : `Class${inheritsInfo}`;
  }

  if (record.kind === "interface") return `Interface declaration`;

  // Method/function: body size is the most informative signal for undocumented code
  const parts: string[] = [];
  const bodyLines = record.lineEnd - record.lineStart + 1;
  if (bodyLines > 1) parts.push(`${bodyLines}-line`);
  parts.push(record.kind);
  if (record.isAsync) parts.push("async");

  // Param count (handles nested parens like callback: (err: Error) => void)
  const paramCount = countParamsFromSignature(record.signature);
  if (paramCount > 0) parts.push(`${paramCount} param${paramCount !== 1 ? "s" : ""}`);

  // Return type — try convention patterns first, fallback to combined regex
  let retType: string | null = null;
  for (const pattern of conventions?.returnTypePatterns ?? []) {
    const m = record.signature.match(pattern);
    if (m) { retType = m[1].trim(); break; }
  }
  if (!retType) {
    const m = record.signature.match(/\)\s*(?:->|:)\s*(.+)$/);
    if (m) retType = m[1].trim();
  }
  if (retType) parts.push(`→ ${retType}`);

  // Visibility
  if (record.visibility === "private") parts.push("(private)");

  return parts.join(", ");
}

type EnrichedResult = {
  function: string;
  file: string;
  module: string;
  signature: string;
  summary: string;
  tags: string[];
  score: number;
  confidence?: "high" | "partial";
  line_start: number;
  line_end: number;
  workspace?: string;
  record: FunctionRecord; // Temporarily attached for density adjustments
};

/**
 * Merge results from multiple workspaces with balanced representation.
 * Guarantees each workspace minimum slots to prevent one workspace from dominating
 * when its vocabulary aligns better with the query (e.g., explicit "OAuth" in Java
 * vs implicit "useAuthStore" in mobile). Single-workspace searches skip balancing.
 */
function mergeWithWorkspaceBalance(
  allResults: EnrichedResult[],
  topK: number,
): EnrichedResult[] {
  const eligible = allResults.filter(r => r.score >= MIN_SCORE);
  eligible.sort((a, b) => b.score - a.score);

  // Group by workspace
  const byWorkspace = new Map<string, EnrichedResult[]>();
  for (const r of eligible) {
    const ws = r.workspace ?? "";
    let group = byWorkspace.get(ws);
    if (!group) { group = []; byWorkspace.set(ws, group); }
    group.push(r);
  }

  // Single workspace with results — no balancing needed
  if (byWorkspace.size <= 1) {
    return eligible.slice(0, topK);
  }

  // Minimum per workspace: ~half of equal share, capped to prevent over-allocation
  const wsCount = byWorkspace.size;
  const rawMin = Math.ceil(topK / wsCount / 2);
  const minPerWs = Math.max(1, Math.min(rawMin, Math.floor(topK / wsCount)));

  // Phase 1: Guaranteed slots — each group is already sorted (subset of sorted eligible)
  const placed = new Set<EnrichedResult>();
  for (const group of byWorkspace.values()) {
    const take = Math.min(minPerWs, group.length);
    for (let i = 0; i < take; i++) placed.add(group[i]);
  }

  // Phase 2: Fill remaining slots from global ranking (eligible is already sorted)
  const slotsLeft = topK - placed.size;
  let filled = 0;
  for (const r of eligible) {
    if (filled >= slotsLeft) break;
    if (!placed.has(r)) { placed.add(r); filled++; }
  }

  // Re-sort for display ordering
  const merged = Array.from(placed);
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Search a single workspace and return enriched, density-adjusted results.
 */
async function searchSingleWorkspace(
  ws: WorkspaceServices,
  wsPath: string,
  query: string,
  topK: number,
  options: { scope?: string; tags_filter?: string[]; side_effects_filter?: string[] },
  ctx: AppContext,
): Promise<{ results: EnrichedResult[]; desyncCount: number }> {
  // Over-fetch for density adjustment: constructors/accessors/tests get eliminated,
  // so we need a larger pool. Pipeline internally also over-fetches *2 for RRF merge.
  const rawResults = await ws.search.search(
    { text: query },
    {
      topK: topK * 3,
      scope: options.scope,
      tagsFilter: options.tags_filter,
      sideEffectsFilter: options.side_effects_filter,
    }
  );

  // Filter out build artifacts, test fixtures, declaration files, and low-relevance noise
  const candidates = rawResults
    .filter(r =>
      !r.filePath.startsWith("dist/") &&
      !r.filePath.startsWith("test/fixtures/") &&
      !r.filePath.endsWith(".d.ts")
    )
    .filter(r => r.score >= MIN_SCORE);

  // Enrich ALL candidates — density adjustment needs the full pool to rerank properly.
  let desyncCount = 0;
  const enriched: EnrichedResult[] = candidates
    .map(r => {
      const record = ws.index.getById(r.id);
      if (!record) { desyncCount++; return null; }
      const summary = r.summary || buildAutoSummary(record, ctx.conventions);
      return {
        function: r.name,
        file: r.filePath,
        module: r.module,
        signature: r.signature,
        summary,
        tags: r.tags,
        score: r.score,
        line_start: record.lineStart,
        line_end: record.lineEnd,
        workspace: wsPath,
        record,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Apply information density adjustments per-workspace (centrality is workspace-local).
  applyDensityAdjustment(enriched, ws, ctx.config, {
    skipTestPenalty: queryTargetsTests(query),
    constructorNames: ctx.conventions.constructorNames,
  });

  return { results: enriched, desyncCount };
}

export async function handleSemanticSearch(
  args: {
    query: string; workspace?: string; scope?: string;
    top_k?: number; tags_filter?: string[]; side_effects_filter?: string[];
  },
  ctx: AppContext
) {
  const resolved = resolveWorkspaces(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;

  const topK = args.top_k ?? 10;
  const query = args.query.trim();

  // Reject queries too short to be meaningful for semantic search
  if (query.length < 2) {
    return textResponse({ results: [], total_indexed: 0, search_mode: "skipped", note: "Query too short. Use at least 2 characters." });
  }

  // Normalize scope: strip source root prefixes, convert dot notation
  const scope = args.scope
    ? normalizeModuleQuery(args.scope, ctx.config.parser.sourceRoot, ctx.conventions.sourceRoots).pop()!
    : undefined;

  // Search all resolved workspaces and merge results
  const allResults: EnrichedResult[] = [];
  let totalDesync = 0;
  let totalIndexed = 0;
  let totalVectors = 0;

  for (const { ws, wsPath } of resolved.workspaces) {
    const { results, desyncCount } = await searchSingleWorkspace(
      ws, wsPath, query, topK,
      { scope, tags_filter: args.tags_filter, side_effects_filter: args.side_effects_filter },
      ctx,
    );
    allResults.push(...results);
    totalDesync += desyncCount;

    const stats = ws.index.getStats();
    totalIndexed += stats.functions + stats.classes;
    totalVectors += await ws.vectorDb.countRows();
  }

  // Merge results with workspace balance (prevents one workspace from dominating)
  const finalResults = mergeWithWorkspaceBalance(allResults, topK);

  // Clean up: remove internal record reference, round scores, assign confidence, handle workspace field
  const showWorkspace = ctx.isMultiWorkspace;
  const highThreshold = ctx.config.search.highConfidenceThreshold;
  for (const r of finalResults) {
    delete (r as any).record;
    r.score = Math.round(r.score * 1000) / 1000;
    r.confidence = r.score >= highThreshold ? "high" : "partial";
    if (!showWorkspace) delete r.workspace;
  }

  // Determine search mode
  const embeddingAvailable = ctx.embeddingAvailable;
  let searchMode: string;
  if (embeddingAvailable && totalVectors > 0) searchMode = "hybrid";
  else if (totalVectors > 0) searchMode = "vector_only";
  else searchMode = "degraded";

  const response: Record<string, unknown> = {
    results: finalResults,
    total_indexed: totalIndexed,
    search_mode: searchMode,
  };

  const warnings: string[] = [];
  if (!embeddingAvailable) {
    warnings.push("Ollama unavailable. Run: ollama serve && ollama pull " + ctx.config.embedding.model);
  }
  if (totalVectors === 0) {
    warnings.push("No vectors indexed. Run reindex with Ollama running.");
  }
  if (totalDesync > 0) {
    warnings.push(`${totalDesync} results skipped (index/vector desync). Run reindex to fix.`);
  }
  if (warnings.length > 0) {
    response.warning = warnings.join(" ");
  }

  return textResponse(response);
}
