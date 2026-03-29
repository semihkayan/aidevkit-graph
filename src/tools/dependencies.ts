import type { AppContext } from "../types/interfaces.js";
import { resolveWorkspaceOrError, resolveFunctionOrError, textResponse } from "./tool-utils.js";

// Common utility calls that are noise in dependency analysis
const NOISE_TARGETS = new Set([
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "super", "type", "id", "hash",
  "console.log", "console.error", "console.warn", "console.info",
  "JSON.parse", "JSON.stringify", "Object.keys", "Object.values", "Object.entries",
  "Object.assign", "Array.from", "Array.isArray",
  "Math.floor", "Math.ceil", "Math.round", "Math.max", "Math.min",
  "fmt.Println", "fmt.Printf", "fmt.Sprintf", "fmt.Errorf",
]);

// Common JS/TS built-in methods that appear as unresolved calls
const BUILTIN_METHODS = new Set([
  "map", "filter", "reduce", "forEach", "find", "some", "every", "includes",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "flat", "flatMap",
  "join", "sort", "reverse", "indexOf", "lastIndexOf", "entries", "values", "keys",
  "has", "get", "set", "delete", "add", "clear", "size",
  "trim", "split", "replace", "match", "startsWith", "endsWith", "includes",
  "toString", "valueOf", "toJSON",
  "then", "catch", "finally",
  "assign", "create", "freeze", "from", "isArray",
]);

function isNoisyCall(target: string): boolean {
  if (NOISE_TARGETS.has(target)) return true;
  // logger.*, log.* calls
  if (/^(logger|log|logging|console)\.\w+$/.test(target)) return true;
  // Built-in method calls: x.map, x.filter, x.push, etc.
  const method = target.split(".").pop();
  if (method && target.includes(".") && BUILTIN_METHODS.has(method)) return true;
  return false;
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

export async function handleDependencies(
  args: { function: string; workspace?: string; module?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;

  const fn = resolveFunctionOrError(ws, args.function, args.module);
  if ("error" in fn) return fn.error;
  const record = fn.record;
  const entry = ws.callGraph.getEntry(record.id);
  const docDeps = record.docstring?.deps || [];

  const confirmed: any[] = [];
  const astOnly: any[] = [];
  const unresolvedCalls: any[] = [];
  const docstringOnly: string[] = [];

  if (entry) {
    for (const call of entry.calls) {
      // Filter noise
      if (isNoisyCall(call.target)) continue;

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
          } else {
            astOnly.push({ target: delegateTarget, line: call.line, resolved: false, note: "Delegation via injected dependency" });
          }
          continue;
        }

        // Check if this looks like a service delegation (obj.method pattern with 2+ segments)
        const parts = call.target.split(".");
        if (parts.length >= 2 && !isNoisyCall(call.target)) {
          astOnly.push({ target: call.target, line: call.line, resolved: false, note: "Unresolved delegation" });
        } else if (!isNoisyCall(call.target)) {
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

  return textResponse({
    function: record.name,
    file: record.filePath,
    calls: confirmed,
    ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
    ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
    ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
    caveat: "Static analysis only. Dynamic dispatch, callbacks, and inherited methods are not captured.",
  });
}
