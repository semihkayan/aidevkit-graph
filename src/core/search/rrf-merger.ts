import type { IResultMerger } from "../../types/interfaces.js";
import type { RankedResult, SearchResult, VectorRow } from "../../types/index.js";

export class RRFMerger implements IResultMerger {
  constructor(private k: number = 60) {}

  merge(rankedLists: RankedResult[][], topK: number): SearchResult[] {
    const scoreMap = new Map<string, { score: number; row: VectorRow; listCount: number }>();

    for (const list of rankedLists) {
      for (let rank = 0; rank < list.length; rank++) {
        const item = list[rank];
        const rrfScore = 1 / (this.k + rank + 1);
        const existing = scoreMap.get(item.id);
        if (existing) {
          existing.score += rrfScore;
          existing.listCount++;
        } else {
          scoreMap.set(item.id, { score: rrfScore, row: item.row, listCount: 1 });
        }
      }
    }

    const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    if (sorted.length === 0) return [];

    // RRF scores: use raw scores (higher = better match).
    // Max possible per-list score is 1/(k+1). With 2 lists, max = 2/(k+1).
    // Normalize relative to theoretical max, not relative to best result.
    // This way, weak results get low scores even if they're the "best" in a bad set.
    const theoreticalMax = rankedLists.length / (this.k + 1);

    return sorted
      .slice(0, topK)
      .map(entry => {
        const normalized = Math.min(1, entry.score / theoreticalMax);
        // Bonus for appearing in multiple search sources (vector + FTS agree)
        const listBonus = entry.listCount > 1 ? 0.05 : 0;
        const finalScore = Math.min(1, normalized + listBonus);

        return this.toSearchResult(entry.row, Math.round(finalScore * 1000) / 1000);
      });
  }

  private toSearchResult(row: VectorRow, score: number): SearchResult {
    return {
      id: row.id,
      name: row.name,
      filePath: row.filePath,
      module: row.module,
      signature: row.signature,
      summary: row.summary,
      tags: row.tags
        ? String(row.tags).replace(/^,|,$/g, "").split(",").filter(Boolean)
        : [],
      score,
    };
  }
}
