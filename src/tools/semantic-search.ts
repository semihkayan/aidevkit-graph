import type { AppContext } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaceOrError, textResponse } from "./tool-utils.js";
import { applyDensityAdjustment } from "./density-scorer.js";

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

  // Param count
  const paramMatch = record.signature.match(/\(([^)]*)\)/);
  const params = paramMatch?.[1]?.trim();
  if (params) {
    const paramCount = params.split(",").filter(Boolean).length;
    if (paramCount > 0) parts.push(`${paramCount} param${paramCount !== 1 ? "s" : ""}`);
  }

  // Return type
  const retMatch = record.signature.match(/\)\s*(?:->|:)\s*(.+)$/);
  if (retMatch) parts.push(`→ ${retMatch[1].trim()}`);

  // Visibility
  if (record.visibility === "private") parts.push("(private)");

  return parts.join(", ");
}

export async function handleSemanticSearch(
  args: {
    query: string; workspace?: string; scope?: string;
    top_k?: number; tags_filter?: string[]; side_effects_filter?: string[];
  },
  ctx: AppContext
) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;

  const topK = args.top_k ?? 10;
  const query = args.query.trim();

  // Reject queries too short to be meaningful for semantic search
  if (query.length < 2) {
    return textResponse({ results: [], total_indexed: 0, search_mode: "skipped", note: "Query too short. Use at least 2 characters." });
  }

  // Over-fetch for density adjustment: constructors/accessors/tests get eliminated,
  // so we need a larger pool. Pipeline internally also over-fetches *2 for RRF merge.
  const rawResults = await ws.search.search(
    { text: query },
    {
      topK: topK * 3,
      scope: args.scope,
      tagsFilter: args.tags_filter,
      sideEffectsFilter: args.side_effects_filter,
    }
  );

  // Filter out build artifacts, test fixtures, declaration files, and low-relevance noise
  const MIN_SCORE = 0.4;
  const candidates = rawResults
    .filter(r =>
      !r.filePath.startsWith("dist/") &&
      !r.filePath.startsWith("test/fixtures/") &&
      !r.filePath.endsWith(".d.ts")
    )
    .filter(r => r.score >= MIN_SCORE);

  // Enrich ALL candidates — density adjustment needs the full pool to rerank properly.
  // Premature .slice(topK) here would let constructors/accessors occupy slots that
  // density would eliminate, cutting off better results at lower raw positions.
  const enriched = candidates.map(r => {
    const record = ws.index.getById(r.id);
    // Auto-summary: use docstring summary if available, else build from signature
    let summary = r.summary;
    if (!summary && record) {
      summary = buildAutoSummary(record);
    }
    return {
      function: r.name,
      file: r.filePath,
      module: r.module,
      signature: r.signature,
      summary,
      tags: r.tags,
      score: r.score,
      line_start: record?.lineStart,
      line_end: record?.lineEnd,
      record, // Temporarily attach for relevance adjustments
    };
  });

  // Apply information density adjustments: demote low-info functions, boost high-info ones
  applyDensityAdjustment(enriched, ws, ctx.config);

  // Re-sort by adjusted score, drop results that fell below threshold, then final cut
  enriched.sort((a, b) => b.score - a.score);
  const finalResults = enriched.filter(r => r.score >= MIN_SCORE).slice(0, topK);

  // Clean up: remove internal record reference and round scores
  for (const r of finalResults) {
    delete (r as any).record;
    r.score = Math.round(r.score * 1000) / 1000;
  }

  // Determine search mode
  const stats = ws.index.getStats();
  const embeddingAvailable = ctx.embeddingAvailable;
  const vectorCount = await ws.vectorDb.countRows();

  let searchMode: string;
  if (embeddingAvailable && vectorCount > 0) searchMode = "hybrid";
  else if (vectorCount > 0) searchMode = "vector_only"; // Vectors exist but Ollama down now
  else searchMode = "degraded";

  const response: Record<string, unknown> = {
    results: finalResults,
    total_indexed: stats.functions + stats.classes,
    search_mode: searchMode,
  };

  if (!embeddingAvailable) {
    response.warning = "Ollama unavailable. Run: ollama serve && ollama pull " + ctx.config.embedding.model;
  }
  if (vectorCount === 0) {
    response.warning = (response.warning || "") + " No vectors indexed. Run reindex with Ollama running.";
  }

  return textResponse(response);
}
