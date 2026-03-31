import type { AppContext, WorkspaceServices } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveFunctionAcrossWorkspaces, textResponse, errorResponse } from "./tool-utils.js";

function buildClassContext(ws: WorkspaceServices, record: FunctionRecord): Record<string, unknown> | undefined {
  if (record.kind !== "method") return undefined;
  const className = record.name.split(".")[0];
  const classRec = ws.index.findByExactName(className)
    .find(r => (r.kind === "class" || r.kind === "interface") && r.filePath === record.filePath);
  if (!classRec) return undefined;

  const ctx: Record<string, unknown> = {
    name: classRec.name,
    signature: classRec.signature,
  };
  if (classRec.decorators?.length) ctx.decorators = classRec.decorators;
  const ctorRec = ws.index.findByExactName(`${className}.constructor`)
    .find(r => r.filePath === record.filePath);
  if (ctorRec?.paramTypes?.length) {
    ctx.dependencies = ctorRec.paramTypes.map(p => p.type);
  }
  return ctx;
}

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
      const response: Record<string, unknown> = {
        function: record.name,
        file: record.filePath,
        ...(showWorkspace ? { workspace: wsPath } : {}),
        language: record.language,
        line_start: result.lineStart,
        line_end: result.lineEnd,
        source: result.source,
        context_before: result.contextBefore || undefined,
        context_after: result.contextAfter || undefined,
      };

      const classCtx = buildClassContext(ws, record);
      if (classCtx) response.class_context = classCtx;

      return textResponse(response);
    } catch (err) {
      return errorResponse("PARSE_ERROR", `Failed to read source: ${err}`);
    }
  }

  // Multiple matches across workspaces — return all
  const results = [];
  for (const { ws, wsPath, record } of resolved.matches) {
    try {
      const result = await ws.source.getFunctionSource(record.id, contextLines);
      const entry: Record<string, unknown> = {
        function: record.name,
        file: record.filePath,
        workspace: wsPath,
        language: record.language,
        line_start: result.lineStart,
        line_end: result.lineEnd,
        source: result.source,
        context_before: result.contextBefore || undefined,
        context_after: result.contextAfter || undefined,
      };
      const classCtx = buildClassContext(ws, record);
      if (classCtx) entry.class_context = classCtx;
      results.push(entry);
    } catch {
      // Skip failed workspace
    }
  }

  return textResponse({
    matches: results,
    note: `Function '${args.function}' found in ${results.length} workspaces. Use workspace parameter to target one.`,
  });
}
