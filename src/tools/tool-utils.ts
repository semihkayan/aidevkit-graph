import type { AppContext, WorkspaceServices, LanguageConventions, NoiseFilterMetadata } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { findSimilar } from "../utils/string-similarity.js";

export type ResolvedWorkspace = { ws: WorkspaceServices; wsPath: string };

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

/**
 * Resolve one or all workspaces. When workspace is omitted, returns ALL workspaces
 * instead of erroring — enables transparent multi-workspace tool access.
 */
export function resolveWorkspaces(
  ctx: AppContext,
  workspace?: string
): { workspaces: ResolvedWorkspace[] } | { error: ReturnType<typeof errorResponse> } {
  const notReady = checkReady(ctx);
  if (notReady) return { error: notReady };

  if (workspace) {
    try {
      const ws = ctx.resolveWorkspace(workspace);
      return { workspaces: [{ ws, wsPath: workspace }] };
    } catch (err: any) {
      if (err?.error === "WORKSPACE_NOT_FOUND") {
        return { error: errorResponse(err.error, err.message, undefined, { workspaces: err.workspaces }) };
      }
      return { error: errorResponse("UNKNOWN_ERROR", String(err)) };
    }
  }

  // No workspace specified — return all (works for single and multi)
  const workspaces = ctx.workspacePaths.map(wsPath => ({
    ws: ctx.resolveWorkspace(wsPath),
    wsPath,
  }));
  return { workspaces };
}

/**
 * Find a function across all workspaces. Used by lookup tools (get_function_source,
 * get_dependencies, get_callers, get_impact_analysis).
 */
export function resolveFunctionAcrossWorkspaces(
  ctx: AppContext,
  name: string,
  module?: string,
  workspace?: string,
): { matches: Array<ResolvedWorkspace & { record: FunctionRecord }> } | { error: ReturnType<typeof errorResponse> } {
  const resolved = resolveWorkspaces(ctx, workspace);
  if ("error" in resolved) return resolved;

  const matches: Array<ResolvedWorkspace & { record: FunctionRecord }> = [];

  for (const { ws, wsPath } of resolved.workspaces) {
    const fn = resolveFunctionOrError(ws, name, module, {
      conventions: ctx.conventions,
      allExtensions: Object.values(ctx.config.parser.languages).flat(),
    });
    if ("error" in fn) {
      // Propagate AMBIGUOUS_FUNCTION immediately — agent needs to disambiguate
      const errText = fn.error.content[0]?.text || "";
      if (errText.includes("AMBIGUOUS_FUNCTION")) {
        // Add workspace context to the error
        const parsed = JSON.parse(errText);
        if (ctx.isMultiWorkspace) {
          parsed.message = `[${wsPath}] ${parsed.message}`;
        }
        return { error: { content: [{ type: "text" as const, text: JSON.stringify(parsed) }], isError: true } };
      }
      continue; // FUNCTION_NOT_FOUND in this workspace — try next
    }
    matches.push({ ws, wsPath, record: fn.record });
  }

  if (matches.length === 0) {
    const allNames = new Set<string>();
    for (const { ws } of resolved.workspaces) {
      for (const n of ws.index.getAllNames()) allNames.add(n);
    }
    const suggestions = findSimilar(name, allNames);

    return {
      error: errorResponse("FUNCTION_NOT_FOUND",
        `Function '${name}' not found${resolved.workspaces.length > 1 ? " in any workspace" : ""}.`,
        suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : undefined)
    };
  }

  return { matches };
}

export function textResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function isNoisyCall(target: string, noise: NoiseFilterMetadata): boolean {
  if (noise.noiseTargets.has(target)) return true;
  if (noise.noisePatterns.some(p => p.test(target))) return true;
  const method = target.split(".").pop();
  if (method && target.includes(".") && noise.builtinMethods.has(method)) return true;
  return false;
}

/**
 * Structural disambiguation: when multiple matches exist, filter out abstract
 * declarations and single-line interface stubs to prefer implementations.
 */
function structuralDisambiguate(matches: FunctionRecord[]): FunctionRecord[] {
  const filtered = matches.filter(r =>
    !r.structuralHints?.isAbstract && (r.lineEnd - r.lineStart) > 0
  );
  return filtered.length > 0 ? filtered : matches;
}

// Resolve function by name — shared pattern for 5+ tool handlers
export function resolveFunctionOrError(
  ws: WorkspaceServices,
  name: string,
  module?: string,
  options?: { conventions?: LanguageConventions; allExtensions?: string[] },
): { record: import("../types/index.js").FunctionRecord } | { error: ReturnType<typeof errorResponse> } {
  const exts = options?.allExtensions ?? [];
  let matches = ws.index.findByName(name, module);

  // If module didn't match as a module path, try it as a file path hint
  if (matches.length === 0 && module) {
    const allMatches = ws.index.findByName(name);
    const byFile = allMatches.filter(r =>
      r.filePath.includes(module) || exts.some(ext => r.filePath.endsWith(module + ext))
    );
    if (byFile.length > 0) matches = byFile;
  }

  // Fallback: dot-notation decomposition (ClassName.wrongMethodName → ClassName.realMethod)
  if (matches.length === 0 && name.includes(".")) {
    const dotIdx = name.indexOf(".");
    const className = name.substring(0, dotIdx);
    const methodAttempt = name.substring(dotIdx + 1).toLowerCase();
    const classRecords = ws.index.findByExactName(className);
    const classRec = classRecords.find(r => r.kind === "class" || r.kind === "interface");
    if (classRec?.classInfo?.methods) {
      for (const methodName of classRec.classInfo.methods) {
        if (options?.conventions?.constructorNames?.has(methodName)) continue;
        const mLower = methodName.toLowerCase();
        if (mLower === methodAttempt || methodAttempt.startsWith(mLower) || mLower.startsWith(methodAttempt)) {
          matches.push(...ws.index.findByExactName(`${className}.${methodName}`));
          break;  // First match wins — avoid ambiguity from multiple partial matches
        }
      }
    }
  }

  // Fallback: class-aware camelCase decomposition (recordDailyActivity → RecordDailyActivityService.record)
  if (matches.length === 0) {
    matches = ws.index.findByClassAware(name);
    if (matches.length > 0 && module) {
      // Module param may be a module path OR a class/file name hint
      const byModule = matches.filter(r => r.module === module || r.module.startsWith(`${module}/`));
      const byFileHint = byModule.length === 0
        ? matches.filter(r => r.filePath.includes(module) || r.name.startsWith(module + "."))
        : [];
      matches = byModule.length > 0 ? byModule : byFileHint.length > 0 ? byFileHint : matches;
    }
  }

  if (matches.length === 0) {
    const suggestions = findSimilar(name, ws.index.getAllNames());

    return {
      error: errorResponse("FUNCTION_NOT_FOUND",
        `Function '${name}' not found.`,
        suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : undefined)
    };
  }

  if (matches.length > 1) {
    // Structural disambiguation: filter abstract/interface stubs
    const disambiguated = structuralDisambiguate(matches);
    if (disambiguated.length === 1) return { record: disambiguated[0] };

    // If module was given but still ambiguous, check if module is a file path hint
    if (module) {
      const fileMatch = disambiguated.find(r =>
        r.filePath.includes(module) || exts.some(ext => r.filePath.endsWith(module + ext))
      );
      if (fileMatch) return { record: fileMatch };
    }

    return {
      error: errorResponse("AMBIGUOUS_FUNCTION",
        `Multiple functions named '${name}'.${module ? ` Module '${module}' still matches ${disambiguated.length}.` : ""} Use module parameter with a file path hint to disambiguate.`,
        `Example: module: '${disambiguated[0].filePath.replace(/\.[^.]+$/, "").split("/").pop()}'`,
        { matches: disambiguated.map(r => ({ name: r.name, module: r.module, file: r.filePath })) })
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
