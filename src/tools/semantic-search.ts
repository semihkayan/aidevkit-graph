import type { AppContext } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaceOrError, textResponse } from "./tool-utils.js";

/**
 * Generate a brief summary from function metadata when no docstring exists.
 * Gives the agent enough context to triage search results without opening source.
 */
function buildAutoSummary(record: FunctionRecord): string {
  const parts: string[] = [];

  // Kind + async indicator
  if (record.kind === "class") return `Class with ${record.classInfo?.methods.length ?? 0} methods`;
  if (record.kind === "interface") return `Interface declaration`;

  // For functions/methods, describe from signature
  if (record.isAsync) parts.push("async");

  // Extract param count and return type from signature
  const paramMatch = record.signature.match(/\(([^)]*)\)/);
  const params = paramMatch?.[1]?.trim();
  if (params) {
    const paramCount = params.split(",").filter(Boolean).length;
    parts.push(`${paramCount} param${paramCount !== 1 ? "s" : ""}`);
  }

  // Return type
  const retMatch = record.signature.match(/\)\s*(?:->|:)\s*(.+)$/);
  if (retMatch) {
    parts.push(`→ ${retMatch[1].trim()}`);
  }

  // Visibility
  if (record.visibility === "private") parts.push("(private)");

  return parts.join(", ") || record.kind;
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

  // Fetch extra to compensate for filtering, then trim
  const fetchK = topK + 5;
  const rawResults = await ws.search.search(
    { text: args.query },
    {
      topK: fetchK,
      scope: args.scope,
      tagsFilter: args.tags_filter,
      sideEffectsFilter: args.side_effects_filter,
    }
  );

  // Filter out build artifacts and declaration files (stale vectors or accidental indexing)
  const results = rawResults
    .filter(r => !r.filePath.startsWith("dist/") && !r.filePath.endsWith(".d.ts"))
    .slice(0, topK);

  // Enrich with line numbers and auto-summary from AST index
  const enriched = results.map(r => {
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
      score: Math.round(r.score * 1000) / 1000,
      line_start: record?.lineStart,
      line_end: record?.lineEnd,
    };
  });

  // Determine search mode
  const stats = ws.index.getStats();
  const embeddingAvailable = ctx.embeddingAvailable;
  const vectorCount = await ws.vectorDb.countRows();

  let searchMode: string;
  if (embeddingAvailable && vectorCount > 0) searchMode = "hybrid";
  else if (vectorCount > 0) searchMode = "vector_only"; // Vectors exist but Ollama down now
  else searchMode = "degraded";

  const response: Record<string, unknown> = {
    results: enriched,
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
