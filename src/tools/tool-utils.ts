import type { AppContext, WorkspaceServices } from "../types/interfaces.js";

export function checkReady(ctx: AppContext): ReturnType<typeof errorResponse> | null {
  if (!ctx.ready) {
    return errorResponse("NOT_READY", "Index is still initializing. Please try again in a few seconds.");
  }
  return null;
}

// Safely resolve workspace — returns MCP error response instead of throwing
export function resolveWorkspaceOrError(
  ctx: AppContext,
  workspace?: string
): { ws: WorkspaceServices } | { error: ReturnType<typeof errorResponse> } {
  const notReady = checkReady(ctx);
  if (notReady) return { error: notReady };

  try {
    const ws = ctx.resolveWorkspace(workspace);
    return { ws };
  } catch (err: any) {
    if (err?.error === "WORKSPACE_REQUIRED" || err?.error === "WORKSPACE_NOT_FOUND") {
      return { error: errorResponse(err.error, err.message, undefined, { workspaces: err.workspaces }) };
    }
    return { error: errorResponse("UNKNOWN_ERROR", String(err)) };
  }
}

export function textResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Resolve function by name — shared pattern for 5+ tool handlers
export function resolveFunctionOrError(
  ws: WorkspaceServices,
  name: string,
  module?: string,
): { record: import("../types/index.js").FunctionRecord } | { error: ReturnType<typeof errorResponse> } {
  let matches = ws.index.findByName(name, module);

  // If module didn't match as a module path, try it as a file path hint
  if (matches.length === 0 && module) {
    const allMatches = ws.index.findByName(name);
    const byFile = allMatches.filter(r =>
      r.filePath.includes(module) || r.filePath.endsWith(module + ".ts") ||
      r.filePath.endsWith(module + ".py") || r.filePath.endsWith(module + ".js") ||
      r.filePath.endsWith(module + ".java") || r.filePath.endsWith(module + ".go") ||
      r.filePath.endsWith(module + ".rs") || r.filePath.endsWith(module + ".cs")
    );
    if (byFile.length > 0) matches = byFile;
  }

  if (matches.length === 0) {
    // Suggest similar names
    const allNames = new Set<string>();
    for (const fp of ws.index.getAllFilePaths()) {
      for (const id of ws.index.getFileRecordIds(fp)) {
        const rec = ws.index.getById(id);
        if (rec) allNames.add(rec.name);
      }
    }
    const suggestions = Array.from(allNames)
      .filter(n => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase()))
      .slice(0, 5);

    return {
      error: errorResponse("FUNCTION_NOT_FOUND",
        `Function '${name}' not found.`,
        suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : undefined)
    };
  }

  if (matches.length > 1) {
    // If module was given but still ambiguous (same module, different files),
    // check if module is actually a file path hint
    if (module) {
      const fileMatch = matches.find(r =>
        r.filePath.includes(module) || r.filePath.endsWith(module + ".ts") || r.filePath.endsWith(module + ".py") || r.filePath.endsWith(module + ".js")
      );
      if (fileMatch) return { record: fileMatch };
    }

    return {
      error: errorResponse("AMBIGUOUS_FUNCTION",
        `Multiple functions named '${name}'.${module ? ` Module '${module}' still matches ${matches.length}.` : ""} Use module parameter with a file path hint to disambiguate.`,
        `Example: module: '${matches[0].filePath.replace(/\.[^.]+$/, "").split("/").pop()}'`,
        { matches: matches.map(r => ({ name: r.name, module: r.module, file: r.filePath })) })
    };
  }

  return { record: matches[0] };
}

export function errorResponse(code: string, message: string, suggestion?: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(Object.assign({ error: code, message, suggestion }, details ? { details } : {})) }],
    isError: true,
  };
}
