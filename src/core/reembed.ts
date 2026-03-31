import type { IFunctionIndexReader, IEmbeddingProvider, IVectorDatabase, ICallGraphReader, Config } from "../types/interfaces.js";
import type { FunctionRecord, VectorRow } from "../types/index.js";
import { buildChunk } from "./chunk-builder.js";

/**
 * Pre-compute class docstring summaries for method records.
 * Methods get their parent class's summary injected into their chunk,
 * giving the embedding model class-level domain context.
 */
function resolveClassContexts(
  records: FunctionRecord[],
  index: IFunctionIndexReader,
): Map<string, string> {
  const result = new Map<string, string>();
  const cache = new Map<string, string | null>();

  for (const record of records) {
    if (record.kind !== "method") continue;

    const className = record.name.split(".")[0];
    const cacheKey = `${record.filePath}::${className}`;

    if (!cache.has(cacheKey)) {
      const siblings = index.getByFile(record.filePath);
      const classRecord = siblings.find(r => r.kind === "class" && r.name === className);
      cache.set(cacheKey, classRecord?.docstring?.summary || null);
    }

    const summary = cache.get(cacheKey);
    if (summary) result.set(record.id, summary);
  }

  return result;
}

/**
 * Extract call target names from call graph for each function.
 * These serve as implicit dependencies when no docstring @deps exist,
 * enriching the embedding chunk with what the function actually does.
 */
function resolveCallTargets(
  records: FunctionRecord[],
  callGraph?: ICallGraphReader,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!callGraph) return result;

  for (const record of records) {
    if (record.kind === "class" || record.kind === "interface") continue;
    const entry = callGraph.getEntry(record.id);
    if (!entry || entry.calls.length === 0) continue;

    const targets = [...new Set(
      entry.calls
        .map(c => c.target)
        .filter(t => t.length > 2)
    )].slice(0, 10);

    if (targets.length > 0) result.set(record.id, targets);
  }

  return result;
}

export async function reembedFunctions(
  changedIds: string[],
  index: IFunctionIndexReader,
  embedding: IEmbeddingProvider,
  vectorDb: IVectorDatabase,
  config: Config,
  callGraph?: ICallGraphReader,
  returnTypePatterns?: readonly RegExp[],
): Promise<void> {
  const records = changedIds
    .map(id => index.getById(id))
    .filter((r): r is FunctionRecord => r !== null);

  if (records.length === 0) return;

  const chunkConfig = {
    expandCamelCase: config.search.expandCamelCase,
    maxChunkTokens: config.indexing.maxChunkTokens,
    returnTypePatterns,
  };

  // Resolve class context for methods, then build chunks
  const classContextMap = resolveClassContexts(records, index);
  const callTargetMap = resolveCallTargets(records, callGraph);
  const chunks = records.map(r =>
    buildChunk(r, chunkConfig, classContextMap.get(r.id) ?? null, callTargetMap.get(r.id) ?? null)
  );

  // Batch embed — skip failed batches instead of inserting zero vectors
  const batchSize = config.embedding.batchSize;
  const successIndices: number[] = [];
  const allVectors: Float32Array[] = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    try {
      const vectors = await embedding.embedDocuments(batch);
      for (let j = 0; j < vectors.length; j++) {
        allVectors.push(vectors[j]);
        successIndices.push(i + j);
      }
    } catch {
      // Skip failed batch — these records won't be embedded
      // They'll be retried on the next reindex or file change
    }
  }

  if (successIndices.length === 0) return;

  // Build VectorRows only for successfully embedded records
  const rows: VectorRow[] = successIndices.map((idx, i) => {
    const record = records[idx];
    return {
      id: record.id,
      vector: allVectors[i],
      filePath: record.filePath,
      module: record.module,
      name: record.name,
      signature: record.signature,
      summary: record.docstring?.summary || "",
      tags: record.docstring?.tags.length ? `,${record.docstring.tags.join(",")},` : "",
      sideEffects: record.docstring?.sideEffects.length ? `,${record.docstring.sideEffects.join(",")},` : "",
      chunkText: chunks[idx],
    };
  });

  await vectorDb.upsert(rows);
}
