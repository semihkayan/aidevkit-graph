import type { IVectorDatabase, IFullTextSearch } from "../../types/interfaces.js";
import type { VectorRow, RankedResult, SearchFilter } from "../../types/index.js";
import { escapeSql } from "../../utils/sql-escape.js";

// LanceDB types (native module)
type LanceConnection = any;
type LanceTable = any;

export class LanceDBStore implements IVectorDatabase, IFullTextSearch {
  private db!: LanceConnection;
  private table: LanceTable | null = null;
  private _ftsAvailable: boolean = false;
  private _tableName: string = "functions";

  get isAvailable(): boolean { return this._ftsAvailable; }

  async initialize(dbPath: string, tableName: string = "functions"): Promise<void> {
    this._tableName = tableName;
    const lancedb = await import("@lancedb/lancedb");
    this.db = await lancedb.connect(dbPath);
    try {
      this.table = await this.db.openTable(this._tableName);
      await this.validateFtsIndex();
    } catch {
      this.table = null;
    }
  }

  async upsert(records: VectorRow[]): Promise<void> {
    if (records.length === 0) return;

    // Convert Float32Array to regular arrays for LanceDB
    const rows = records.map(r => ({
      ...r,
      vector: Array.from(r.vector),
    }));

    if (!this.table) {
      this.table = await this.db.createTable(this._tableName, rows);
      await this.createFtsIndex();
      return;
    }

    // Delete existing, then add (LanceDB upsert pattern)
    const ids = records.map(r => `'${escapeSql(r.id)}'`).join(",");
    try {
      await this.table.delete(`id IN (${ids})`);
    } catch {
      // Table might be empty or ids don't exist
    }
    await this.table.add(rows);
  }

  async deleteByFile(filePath: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`filePath = '${escapeSql(filePath)}'`);
    } catch { /* may not exist */ }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize).map(id => `'${escapeSql(id)}'`).join(",");
      try {
        await this.table.delete(`id IN (${batch})`);
      } catch { /* may not exist */ }
    }
  }

  async vectorSearch(query: Float32Array, topK: number, filter?: SearchFilter): Promise<RankedResult[]> {
    if (!this.table) return [];
    try {
      let q = this.table.search(Array.from(query)).limit(topK);
      const where = this.buildWhereClause(filter);
      if (where) q = q.where(where);
      const rows = await q.toArray();
      return rows.map((row: any, rank: number) => ({
        id: row.id, row, score: rank,
        distance: row._distance as number | undefined,
      }));
    } catch {
      return [];
    }
  }

  async ftsSearch(queryText: string, topK: number, filter?: SearchFilter): Promise<RankedResult[]> {
    if (!this.table || !this._ftsAvailable) return [];
    try {
      let q = this.table.query().fullTextSearch(queryText).limit(topK);
      const where = this.buildWhereClause(filter);
      if (where) q = q.where(where);
      const rows = await q.toArray();
      return rows.map((row: any, rank: number) => ({
        id: row.id, row, score: rank,
        // distance intentionally omitted — FTS _score is BM25 relevance, not L2 distance
      }));
    } catch {
      return [];
    }
  }

  async searchByExactName(name: string, scope?: string): Promise<RankedResult[]> {
    if (!this.table) return [];
    try {
      const escaped = escapeSql(name);
      // Match both full name ("resolveViaTypeGraph") and class.method ("CallGraphManager.resolveViaTypeGraph")
      let where = `(name = '${escaped}' OR name LIKE '%.${escaped}')`;
      if (scope) {
        const s = escapeSql(scope);
        where += ` AND (module = '${s}' OR module LIKE '${s}/%' OR module LIKE '%/${s}' OR module LIKE '%/${s}/%')`;
      }
      const rows = await this.table.query().where(where).limit(10).toArray();
      return rows.map((row: any) => ({ id: row.id, row, score: 0 }));
    } catch {
      return [];
    }
  }

  async isEmpty(): Promise<boolean> {
    if (!this.table) return true;
    try {
      return (await this.table.countRows()) === 0;
    } catch {
      return true;
    }
  }

  async countRows(): Promise<number> {
    if (!this.table) return 0;
    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }

  async dropTable(): Promise<void> {
    if (!this.db || !this.table) return;
    try {
      await this.db.dropTable(this._tableName);
      this.table = null;
      this._ftsAvailable = false;
    } catch { /* table may not exist */ }
  }

  async close(): Promise<void> {
    this.table = null;
    this.db = null!;
  }

  // === Private ===

  private buildWhereClause(filter?: SearchFilter): string | undefined {
    if (!filter) return undefined;
    const conditions: string[] = [];
    if (filter.scope) {
      const s = escapeSql(filter.scope);
      // Exact match, prefix match, file path prefix, AND partial path match
      // Partial: scope="streak" matches module="com/wordbox/streak/domain/model"
      conditions.push(`(module = '${s}' OR module LIKE '${s}/%' OR filePath LIKE '${s}%' OR module LIKE '%/${s}' OR module LIKE '%/${s}/%')`);
    }
    if (filter.tags?.length) {
      conditions.push(filter.tags.map(t => `tags LIKE '%,${escapeSql(t)},%'`).join(" AND "));
    }
    if (filter.sideEffects?.length) {
      conditions.push("(" + filter.sideEffects.map(se => `sideEffects LIKE '%,${escapeSql(se)},%'`).join(" OR ") + ")");
    }
    return conditions.length > 0 ? conditions.join(" AND ") : undefined;
  }

  private async validateFtsIndex(): Promise<void> {
    try {
      await this.table!.query().fullTextSearch("__fts_probe__").limit(1).toArray();
      this._ftsAvailable = true;
    } catch {
      this._ftsAvailable = false;
      await this.createFtsIndex();
    }
  }

  private async createFtsIndex(): Promise<void> {
    if (!this.table) return;
    try {
      const lancedb = await import("@lancedb/lancedb");
      await this.table.createIndex("chunkText", { config: lancedb.Index.fts() });
      // Verify the index actually works (legacy indices may exist but fail at query time)
      await this.table.query().fullTextSearch("__fts_verify__").limit(1).toArray();
      this._ftsAvailable = true;
    } catch {
      this._ftsAvailable = false;
    }
  }
}
