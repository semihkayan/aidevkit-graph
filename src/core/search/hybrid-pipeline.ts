import type {
  ISearchPipeline, IVectorDatabase, IFullTextSearch, IResultMerger,
  IEmbeddingProvider,
} from "../../types/interfaces.js";
import type { SearchResult, SearchFilter, RankedResult } from "../../types/index.js";

export class HybridSearchPipeline implements ISearchPipeline {
  private embeddingAvailableCache: boolean | null = null;
  private embeddingCacheTime: number = 0;
  private readonly CACHE_TTL = 30_000; // 30s cache

  constructor(
    private vectorDb: IVectorDatabase,
    private fts: IFullTextSearch,
    private merger: IResultMerger,
    private embedding: IEmbeddingProvider,
  ) {}

  private async isEmbeddingAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.embeddingAvailableCache !== null && now - this.embeddingCacheTime < this.CACHE_TTL) {
      return this.embeddingAvailableCache;
    }
    this.embeddingAvailableCache = await this.embedding.isAvailable();
    this.embeddingCacheTime = now;
    return this.embeddingAvailableCache;
  }

  async search(
    query: { vector?: Float32Array; text: string },
    options: { topK: number; scope?: string; tagsFilter?: string[]; sideEffectsFilter?: string[] }
  ): Promise<SearchResult[]> {
    const { topK, scope, tagsFilter, sideEffectsFilter } = options;
    const filter: SearchFilter = { scope, tags: tagsFilter, sideEffects: sideEffectsFilter };
    const fetchK = topK * 3;

    // Step 1: Exact name match fast path
    const exactMatches = await this.vectorDb.searchByExactName(query.text, scope);

    // Step 2: Get query vector (embed if not provided)
    let queryVector = query.vector;
    if (!queryVector) {
      try {
        if (await this.isEmbeddingAvailable()) {
          queryVector = await this.embedding.embedQuery(query.text);
        }
      } catch {
        // Embedding failed — continue with FTS only
      }
    }

    // Step 3: Vector search
    let vectorResults: RankedResult[] = [];
    if (queryVector) {
      vectorResults = await this.vectorDb.vectorSearch(queryVector, fetchK, filter);
    }

    // Step 4: FTS search
    let ftsResults: RankedResult[] = [];
    if (this.fts.isAvailable) {
      ftsResults = await this.fts.ftsSearch(query.text, fetchK, filter);
    }

    // Step 5: Merge
    const rankedLists = [vectorResults, ftsResults].filter(l => l.length > 0);
    if (rankedLists.length === 0 && exactMatches.length === 0) return [];

    const merged = rankedLists.length > 0
      ? this.merger.merge(rankedLists, topK)
      : [];

    // Step 6: Boost exact matches — whether they're already in merged or not
    const exactIds = new Set(exactMatches.map(r => r.id));

    // Boost merged results that are exact name matches (ensure they rise to the top)
    for (const r of merged) {
      if (exactIds.has(r.id)) {
        r.score = Math.max(r.score, 0.95);
      }
    }

    // Add exact matches not in merged results (FTS/vector didn't find them)
    const mergedIds = new Set(merged.map(r => r.id));
    const exactToAdd: SearchResult[] = exactMatches
      .filter(r => !mergedIds.has(r.id))
      .map(r => ({
        id: r.id,
        name: r.row.name,
        filePath: r.row.filePath,
        module: r.row.module,
        signature: r.row.signature,
        summary: r.row.summary,
        tags: r.row.tags ? String(r.row.tags).replace(/^,|,$/g, "").split(",").filter(Boolean) : [],
        score: 1.0,
      }));

    // Re-sort: exact matches first, then by score
    const combined = [...exactToAdd, ...merged];
    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, topK);
  }
}
