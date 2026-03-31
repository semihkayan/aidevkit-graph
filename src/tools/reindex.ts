import path from "node:path";
import type { AppContext } from "../types/interfaces.js";
import type { ReindexResult } from "../types/interfaces.js";
import { resolveWorkspaces, textResponse } from "./tool-utils.js";

export async function handleReindex(
  args: { workspace?: string; files?: string[]; force?: boolean },
  ctx: AppContext
) {
  const resolved = resolveWorkspaces(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;

  // If specific files provided without workspace, route files to correct workspace
  if (args.files && args.files.length > 0 && resolved.workspaces.length > 1) {
    const filesByWs = new Map<string, string[]>();
    for (const file of args.files) {
      const wsMatch = resolved.workspaces.find(({ wsPath }) =>
        wsPath === "." || file.startsWith(wsPath + "/")
      );
      const wsPath = wsMatch?.wsPath || ".";
      if (!filesByWs.has(wsPath)) filesByWs.set(wsPath, []);
      filesByWs.get(wsPath)!.push(file);
    }

    const results = [];
    for (const [wsPath, files] of filesByWs) {
      const target = resolved.workspaces.find(w => w.wsPath === wsPath);
      if (!target) continue;
      const result = await ctx.reindex.reindexFiles(target.ws, wsPath, files);
      const stats = target.ws.index.getStats();
      results.push({
        workspace: wsPath,
        status: "ok",
        mode: result.mode,
        ast_index: stats,
        embedded: result.embedded,
        vector_store_rows: await target.ws.vectorDb.countRows(),
        elapsed_ms: result.elapsedMs,
      });
    }

    return textResponse(results.length === 1 ? results[0] : { workspaces: results });
  }

  // Single workspace or full reindex across all
  if (resolved.workspaces.length === 1) {
    const { ws, wsPath } = resolved.workspaces[0];
    let result: ReindexResult;
    if (args.force) {
      result = await ctx.reindex.reindexFull(ws, wsPath);
    } else if (args.files && args.files.length > 0) {
      result = await ctx.reindex.reindexFiles(ws, wsPath, args.files);
    } else {
      result = await ctx.reindex.reindexIncremental(ws, wsPath);
    }

    const stats = ws.index.getStats();
    return textResponse({
      ...(ctx.isMultiWorkspace ? { workspace: wsPath } : {}),
      status: "ok",
      mode: result.mode,
      ast_index: stats,
      embedded: result.embedded,
      vector_store_rows: await ws.vectorDb.countRows(),
      elapsed_ms: result.elapsedMs,
    });
  }

  // Multi-workspace, no files — reindex all
  const results = [];
  for (const { ws, wsPath } of resolved.workspaces) {
    let result: ReindexResult;
    if (args.force) {
      result = await ctx.reindex.reindexFull(ws, wsPath);
    } else {
      result = await ctx.reindex.reindexIncremental(ws, wsPath);
    }
    const stats = ws.index.getStats();
    results.push({
      workspace: wsPath,
      status: "ok",
      mode: result.mode,
      ast_index: stats,
      embedded: result.embedded,
      vector_store_rows: await ws.vectorDb.countRows(),
      elapsed_ms: result.elapsedMs,
    });
  }

  return textResponse({ workspaces: results });
}
