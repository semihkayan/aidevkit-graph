import type { AppContext, WorkspaceServices, NoiseFilterMetadata, LanguageConventions } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveFunctionAcrossWorkspaces, textResponse, isNoisyCall } from "./tool-utils.js";
import { isAccessor } from "./density-scorer.js";

/**
 * Collapse fluent method chains into one entry per chain.
 * Java/TS chains like Jwts.builder().subject().claim() produce a separate
 * call_expression for each .method(). Keep only the outermost per root per line.
 */
function deduplicateChains<T extends { target: string; line: number }>(calls: T[]): T[] {
  // Group by line + root object (first segment before "." or "(")
  const byLineAndRoot = new Map<string, T>();
  for (const c of calls) {
    const root = c.target.split(".")[0].split("(")[0];
    const key = `${c.line}:${root}`;
    const existing = byLineAndRoot.get(key);
    // Keep the longest target (outermost chain call)
    if (!existing || c.target.length > existing.target.length) {
      byLineAndRoot.set(key, c);
    }
  }

  const result = Array.from(byLineAndRoot.values());

  // Simplify long chain targets: "Jwts.builder().subject()...compact" → "Jwts.compact"
  for (const c of result) {
    if (c.target.includes("(")) {
      const firstObj = c.target.split(".")[0].split("(")[0];
      const parts = c.target.split(".");
      const lastMethod = parts[parts.length - 1].split("(")[0];
      if (firstObj && lastMethod && firstObj !== lastMethod) {
        c.target = `${firstObj}.${lastMethod}`;
      }
    }
  }

  return result;
}

/**
 * Check if an unresolved call target is likely an accessor by looking up
 * all definitions of the method name in the index. If every definition is
 * a trivial accessor (small body, 0-1 params, 0 calls), the call is noise.
 */
function isLikelyAccessorCall(
  target: string,
  ws: WorkspaceServices,
  constructorNames: ReadonlySet<string>,
  noise: NoiseFilterMetadata,
): boolean {
  const method = target.split(".").pop();
  if (!method) return false;

  const candidates = ws.index.findByName(method);
  if (candidates.length === 0) return false;

  const noiseCheck = (t: string) => isNoisyCall(t, noise);
  return candidates.every(record => {
    const callEntry = ws.callGraph.getEntry(record.id);
    return isAccessor(record, callEntry, constructorNames, noiseCheck);
  });
}

function matchesDep(target: string, dep: string): boolean {
  // Direct match
  if (target.includes(dep) || dep.includes(target)) return true;
  // self.x.method matches module.method (e.g., self.repository.find_by_code ~ coupon_repository.find_by_code)
  const targetMethod = target.split(".").pop();
  const depMethod = dep.split(".").pop();
  if (targetMethod && depMethod && targetMethod === depMethod) return true;
  return false;
}

function analyzeDependencies(ws: WorkspaceServices, record: FunctionRecord, noise: NoiseFilterMetadata, constructorNames: ReadonlySet<string>) {
  const entry = ws.callGraph.getEntry(record.id);
  const docDeps = record.docstring?.deps || [];

  const confirmed: any[] = [];
  const astOnly: any[] = [];
  const unresolvedCalls: any[] = [];
  const docstringOnly: string[] = [];
  let accessorsFiltered = 0;

  if (entry) {
    // Pre-filter noise and collapse fluent chains before categorization
    const calls = deduplicateChains(
      entry.calls.filter(c => !isNoisyCall(c.target, noise))
    );

    for (const call of calls) {

      if (call.resolvedId) {
        const targetRecord = ws.index.getById(call.resolvedId);
        const inDocDeps = docDeps.some(d => matchesDep(call.target, d));

        if (inDocDeps) {
          confirmed.push({
            target: call.target,
            file: targetRecord?.filePath || call.resolvedFile,
            line: call.line,
            source: "confirmed",
          });
        } else {
          astOnly.push({
            target: call.target,
            file: targetRecord?.filePath || call.resolvedFile,
            line: call.line,
            resolved: true,
          });
        }
      } else {
        const isSelfDirect = call.target.startsWith("self.") || call.target.startsWith("this.");

        if (isSelfDirect) {
          // Distinguish: this.method() (own method) vs this.field.method() (delegation)
          const parts = call.target.split(".");
          if (parts.length === 2) {
            // this.method() — own method, skip unless in @deps
            const inDocDeps = docDeps.some(d => matchesDep(call.target, d));
            if (inDocDeps) {
              confirmed.push({ target: call.target, file: record.filePath, line: call.line, source: "confirmed" });
            }
            continue;
          }
          // this.field.method() (3+ parts) — delegation to injected service, show it
          const delegateTarget = parts.slice(1).join(".");  // "vectorDb.vectorSearch"
          const inDocDeps = docDeps.some(d => matchesDep(delegateTarget, d));
          if (inDocDeps) {
            confirmed.push({ target: delegateTarget, file: null, line: call.line, source: "confirmed" });
          } else if (isLikelyAccessorCall(delegateTarget, ws, constructorNames, noise)) {
            accessorsFiltered++;
          } else {
            astOnly.push({ target: delegateTarget, line: call.line, resolved: false, note: "Delegation via injected dependency" });
          }
          continue;
        }

        // Check if this looks like a service delegation (obj.method pattern with 2+ segments)
        const parts = call.target.split(".");
        if (parts.length >= 2 && !isNoisyCall(call.target, noise)) {
          if (isLikelyAccessorCall(call.target, ws, constructorNames, noise)) {
            accessorsFiltered++;
          } else {
            astOnly.push({ target: call.target, line: call.line, resolved: false, note: "Unresolved delegation" });
          }
        } else if (!isNoisyCall(call.target, noise)) {
          unresolvedCalls.push({
            target: call.target,
            line: call.line,
            note: "Could not resolve. May be dynamic dispatch or external call.",
          });
        }
      }
    }

    // @deps not found in AST
    for (const dep of docDeps) {
      const foundInAst = entry.calls.some(c => matchesDep(c.target, dep));
      if (!foundInAst) docstringOnly.push(dep);
    }
  }

  return { confirmed, astOnly, unresolvedCalls, docstringOnly, accessorsFiltered };
}

function analyzeClassDependencies(
  ws: WorkspaceServices,
  record: FunctionRecord,
  noise: NoiseFilterMetadata,
  conventions: LanguageConventions,
) {
  const methods = (record.classInfo?.methods ?? [])
    .filter(m => !conventions.constructorNames.has(m));

  const confirmed: any[] = [];
  const astOnly: any[] = [];
  const unresolvedCalls: any[] = [];
  const docstringOnly: string[] = [];
  let accessorsFiltered = 0;

  for (const methodName of methods) {
    const methodId = `${record.filePath}::${record.name}.${methodName}`;
    const methodRecord = ws.index.getById(methodId);
    if (!methodRecord) continue;

    const result = analyzeDependencies(ws, methodRecord, noise, conventions.constructorNames);
    for (const e of result.confirmed) confirmed.push({ ...e, via: methodName });
    for (const e of result.astOnly) astOnly.push({ ...e, via: methodName });
    for (const e of result.unresolvedCalls) unresolvedCalls.push({ ...e, via: methodName });
    for (const e of result.docstringOnly) docstringOnly.push(e);
    accessorsFiltered += result.accessorsFiltered;
  }

  return { confirmed, astOnly, unresolvedCalls, docstringOnly, methods, accessorsFiltered };
}

export async function handleDependencies(
  args: { function: string; workspace?: string; module?: string },
  ctx: AppContext
) {
  const resolved = resolveFunctionAcrossWorkspaces(ctx, args.function, args.module, args.workspace);
  if ("error" in resolved) return resolved.error;

  const showWorkspace = ctx.isMultiWorkspace;

  if (resolved.matches.length === 1) {
    const { ws, wsPath, record } = resolved.matches[0];

    if (record.kind === "class") {
      const { confirmed, astOnly, unresolvedCalls, docstringOnly, methods, accessorsFiltered } =
        analyzeClassDependencies(ws, record, ctx.noiseFilter, ctx.conventions);
      return textResponse({
        function: record.name,
        file: record.filePath,
        ...(showWorkspace ? { workspace: wsPath } : {}),
        kind: "class",
        methods_analyzed: methods,
        calls: confirmed,
        ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
        ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
        ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
        ...(accessorsFiltered > 0 ? { accessors_filtered: accessorsFiltered } : {}),
        caveat: "Static analysis only. Dynamic dispatch, callbacks, and inherited methods are not captured.",
      });
    }

    const { confirmed, astOnly, unresolvedCalls, docstringOnly, accessorsFiltered } =
      analyzeDependencies(ws, record, ctx.noiseFilter, ctx.conventions.constructorNames);

    return textResponse({
      function: record.name,
      file: record.filePath,
      ...(showWorkspace ? { workspace: wsPath } : {}),
      calls: confirmed,
      ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
      ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
      ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
      ...(accessorsFiltered > 0 ? { accessors_filtered: accessorsFiltered } : {}),
      caveat: "Static analysis only. Dynamic dispatch, callbacks, and inherited methods are not captured.",
    });
  }

  // Multiple matches across workspaces
  const results = resolved.matches.map(({ ws, wsPath, record }) => {
    if (record.kind === "class") {
      const { confirmed, astOnly, unresolvedCalls, docstringOnly, methods, accessorsFiltered } =
        analyzeClassDependencies(ws, record, ctx.noiseFilter, ctx.conventions);
      return {
        function: record.name,
        file: record.filePath,
        workspace: wsPath,
        kind: "class" as const,
        methods_analyzed: methods,
        calls: confirmed,
        ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
        ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
        ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
        ...(accessorsFiltered > 0 ? { accessors_filtered: accessorsFiltered } : {}),
      };
    }
    const { confirmed, astOnly, unresolvedCalls, docstringOnly, accessorsFiltered } =
      analyzeDependencies(ws, record, ctx.noiseFilter, ctx.conventions.constructorNames);
    return {
      function: record.name,
      file: record.filePath,
      workspace: wsPath,
      calls: confirmed,
      ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
      ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
      ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
      ...(accessorsFiltered > 0 ? { accessors_filtered: accessorsFiltered } : {}),
    };
  });

  return textResponse({
    matches: results,
    note: `Function '${args.function}' found in ${results.length} workspaces. Use workspace parameter to target one.`,
    caveat: "Static analysis only. Dynamic dispatch, callbacks, and inherited methods are not captured.",
  });
}
