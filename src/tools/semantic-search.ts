import type { AppContext, WorkspaceServices } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaces, textResponse } from "./tool-utils.js";
import { applyDensityAdjustment, countParamsFromSignature } from "./density-scorer.js";

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
function buildAutoSummary(record: FunctionRecord): string {
  // Class: show inheritance and method names so agent sees what the class offers
  if (record.kind === "class") {
    const methods = (record.classInfo?.methods || [])
      .filter(m => m !== "constructor" && m !== "__init__");
    const inheritsInfo = record.classInfo?.inherits?.length
      ? ` extends ${record.classInfo.inherits.join(", ")}` : "";
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

  // Return type
  const retMatch = record.signature.match(/\)\s*(?:->|:)\s*(.+)$/);
  if (retMatch) parts.push(`→ ${retMatch[1].trim()}`);

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
  line_start: number;
  line_end: number;
  workspace?: string;
  record: FunctionRecord; // Temporarily attached for density adjustments
};

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
      const summary = r.summary || buildAutoSummary(record);
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
  applyDensityAdjustment(enriched, ws, ctx.config, { skipTestPenalty: queryTargetsTests(query) });

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

  // Search all resolved workspaces and merge results
  const allResults: EnrichedResult[] = [];
  let totalDesync = 0;
  let totalIndexed = 0;
  let totalVectors = 0;

  for (const { ws, wsPath } of resolved.workspaces) {
    const { results, desyncCount } = await searchSingleWorkspace(
      ws, wsPath, query, topK,
      { scope: args.scope, tags_filter: args.tags_filter, side_effects_filter: args.side_effects_filter },
      ctx,
    );
    allResults.push(...results);
    totalDesync += desyncCount;

    const stats = ws.index.getStats();
    totalIndexed += stats.functions + stats.classes;
    totalVectors += await ws.vectorDb.countRows();
  }

  // Re-sort by adjusted score across all workspaces, filter and cut
  allResults.sort((a, b) => b.score - a.score);
  const finalResults = allResults.filter(r => r.score >= MIN_SCORE).slice(0, topK);

  // Clean up: remove internal record reference, round scores, handle workspace field
  const showWorkspace = ctx.isMultiWorkspace;
  for (const r of finalResults) {
    delete (r as any).record;
    r.score = Math.round(r.score * 1000) / 1000;
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
