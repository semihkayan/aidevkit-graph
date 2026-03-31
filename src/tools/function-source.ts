import type { AppContext } from "../types/interfaces.js";
import { resolveFunctionAcrossWorkspaces, textResponse, errorResponse } from "./tool-utils.js";

export async function handleFunctionSource(
  args: { function: string; workspace?: string; module?: string; context_lines?: number },
  ctx: AppContext
) {
  const resolved = resolveFunctionAcrossWorkspaces(ctx, args.function, args.module, args.workspace);
  if ("error" in resolved) return resolved.error;

  const contextLines = args.context_lines || 0;
  const showWorkspace = ctx.isMultiWorkspace;

  if (resolved.matches.length === 1) {
    const { ws, wsPath, record } = resolved.matches[0];
    try {
      const result = await ws.source.getFunctionSource(record.id, contextLines);
      return textResponse({
        function: record.name,
        file: record.filePath,
        ...(showWorkspace ? { workspace: wsPath } : {}),
        language: record.language,
        line_start: result.lineStart,
        line_end: result.lineEnd,
        source: result.source,
        context_before: result.contextBefore || undefined,
        context_after: result.contextAfter || undefined,
      });
    } catch (err) {
      return errorResponse("PARSE_ERROR", `Failed to read source: ${err}`);
    }
  }

  // Multiple matches across workspaces — return all
  const results = [];
  for (const { ws, wsPath, record } of resolved.matches) {
    try {
      const result = await ws.source.getFunctionSource(record.id, contextLines);
      results.push({
        function: record.name,
        file: record.filePath,
        workspace: wsPath,
        language: record.language,
        line_start: result.lineStart,
        line_end: result.lineEnd,
        source: result.source,
        context_before: result.contextBefore || undefined,
        context_after: result.contextAfter || undefined,
      });
    } catch {
      // Skip failed workspace
    }
  }

  return textResponse({
    matches: results,
    note: `Function '${args.function}' found in ${results.length} workspaces. Use workspace parameter to target one.`,
  });
}
