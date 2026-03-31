import type { FunctionRecord, CallGraphEntry } from "../types/index.js";
import type { WorkspaceServices, Config } from "../types/interfaces.js";

// === Normalizers (all return 0-1, all language-agnostic) ===

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Log-scale body size: 1 line→0.0, 10→0.50, 30→0.74, 100+→1.0 */
export function normalizeBodySize(record: FunctionRecord): number {
  const lines = record.lineEnd - record.lineStart + 1;
  if (lines <= 1) return 0;
  return clamp(Math.log2(lines) / Math.log2(100), 0, 1);
}

/** Binary: someone thought this function worth documenting */
export function normalizeDocstring(record: FunctionRecord): number {
  return record.docstring ? 1.0 : 0.0;
}

/** Structured metadata depth: tags + deps + sideEffects */
export function normalizeDocstringRichness(record: FunctionRecord): number {
  if (!record.docstring) return 0;
  const count =
    (record.docstring.tags?.length || 0) +
    (record.docstring.deps?.length || 0) +
    (record.docstring.sideEffects?.length || 0);
  return clamp(count / 4, 0, 1);
}

/**
 * Parameter count from paramTypes (preferred) or signature parsing (fallback).
 * Handles all languages: TS sets paramTypes, Java/Go only have signature.
 */
export function normalizeParamCount(record: FunctionRecord): number {
  let count = 0;
  if (record.paramTypes && record.paramTypes.length > 0) {
    count = record.paramTypes.length;
  } else {
    // Fallback: parse from signature by counting items in parentheses
    count = countParamsFromSignature(record.signature);
  }
  return clamp(count / 4, 0, 1);
}

export function countParamsFromSignature(signature: string): number {
  const openIdx = signature.indexOf("(");
  if (openIdx === -1) return 0;
  // Find matching close paren (handles nested generics)
  let depth = 0;
  for (let i = openIdx; i < signature.length; i++) {
    if (signature[i] === "(") depth++;
    else if (signature[i] === ")") {
      depth--;
      if (depth === 0) {
        const inner = signature.slice(openIdx + 1, i).trim();
        if (!inner) return 0;
        // Count top-level commas (not inside generics like Map<K, V>)
        let commaCount = 0;
        let nestDepth = 0;
        for (const ch of inner) {
          if (ch === "<" || ch === "(") nestDepth++;
          else if (ch === ">" || ch === ")") nestDepth--;
          else if (ch === "," && nestDepth === 0) commaCount++;
        }
        return commaCount + 1;
      }
    }
  }
  return 0;
}

/** Call graph in-degree: functions called by many others are architecturally central */
export function normalizeCentrality(entry: CallGraphEntry | undefined): number {
  if (!entry) return 0;
  return clamp(entry.calledBy.length / 5, 0, 1);
}

/** Public API surfaces are more navigational than private helpers */
export function normalizeVisibility(record: FunctionRecord): number {
  switch (record.visibility) {
    case "public": return 1.0;
    case "protected": return 0.7;
    case "private": return 0.4;
    default: return 0.5;
  }
}

/** Classes are dense information aggregates; interfaces define contracts */
export function normalizeKind(record: FunctionRecord): number {
  switch (record.kind) {
    case "class": return 1.0;
    case "method": return 0.8;
    case "function": return 0.8;
    case "struct": return 0.7;
    case "enum": return 0.7;
    case "record": return 0.7;
    case "interface": return 0.6;
    default: return 0.5;
  }
}

// === Density Score ===

type DensityWeights = Config["search"]["density"]["weights"];

export function computeDensityScore(
  record: FunctionRecord,
  callGraphEntry: CallGraphEntry | undefined,
  weights: DensityWeights,
): number {
  // Abstract methods have no body by design — neutral score instead of penalty
  const bodySize = record.structuralHints?.isAbstract
    ? 0.5
    : normalizeBodySize(record);

  return (
    weights.bodySize * bodySize +
    weights.docstring * normalizeDocstring(record) +
    weights.docstringRichness * normalizeDocstringRichness(record) +
    weights.paramCount * normalizeParamCount(record) +
    weights.centrality * normalizeCentrality(callGraphEntry) +
    weights.visibility * normalizeVisibility(record) +
    weights.kind * normalizeKind(record)
  );
}

// === Constructor Detection ===

/** Constructors declare dependencies but don't implement behavior */
function isConstructor(record: FunctionRecord): boolean {
  if (record.structuralHints?.isConstructor) return true;
  const name = record.name.split(".").pop() || record.name;
  return name === "constructor" || name === "__init__";
}

// === Accessor Detection (language-agnostic structural heuristic) ===

const NON_ACCESSOR_KINDS = new Set(["class", "interface", "enum", "struct", "record"]);

/**
 * Detect getter/setter methods using parser hints + structural fallback:
 * 1. Parser-confirmed: propertyAccess hint + small body (≤3 lines)
 * 2. Heuristic fallback: body ≤ 4 lines, 0-1 params, 0 total calls
 */
export function isAccessor(record: FunctionRecord, callEntry: CallGraphEntry | undefined): boolean {
  if (NON_ACCESSOR_KINDS.has(record.kind)) return false;
  if (isConstructor(record)) return false;
  if (record.structuralHints?.isAbstract) return false; // No body by design

  const bodyLines = record.lineEnd - record.lineStart + 1;

  // Parser-confirmed property access: trust it, but require small body
  // (@property with 10-line computation is NOT a trivial accessor)
  if (record.structuralHints?.propertyAccess) {
    return bodyLines <= 3;
  }

  // Heuristic fallback for languages without accessor syntax (Go, Java, Rust)
  if (bodyLines > 4) return false;

  const paramCount = record.paramTypes?.length ?? countParamsFromSignature(record.signature);
  if (paramCount > 1) return false;

  // Count ALL calls (resolved + unresolved), not just resolved.
  // Unresolved calls like this.field.method() still indicate real behavior.
  const totalCalls = callEntry?.calls.length ?? 0;
  if (totalCalls > 0) return false;

  return true;
}

// === Apply to Search Results ===

export function applyDensityAdjustment(
  results: Array<{ score: number; record: FunctionRecord | null; [key: string]: unknown }>,
  ws: WorkspaceServices,
  config: Config,
  options?: { skipTestPenalty?: boolean },
): void {
  const densityConfig = config.search.density;
  if (!densityConfig.enabled) return;

  const { floor, ceiling, accessorPenalty, constructorPenalty, testFilePenalty, weights } = densityConfig;
  const range = ceiling - floor;

  for (const r of results) {
    if (!r.record) continue;

    // Compute density score from structural signals
    const callEntry = ws.callGraph.getEntry(r.record.id);
    const density = computeDensityScore(r.record, callEntry, weights);

    // Apply: adjustedScore = rawScore × (floor + density × range)
    const factor = floor + density * range;
    r.score *= factor;

    // Orthogonal penalties for low-information-density categories

    // Accessors: short body, few params, no project calls → pure data access, no behavior.
    if (isAccessor(r.record, callEntry)) {
      r.score *= accessorPenalty;
    }

    // Constructors: many params → high density score, but behavior is just assignment.
    if (isConstructor(r.record)) {
      r.score *= constructorPenalty;
    }

    // Test files: large body → high density score, but shows verification not behavior.
    // Skip when caller signals a test-related query (agent explicitly looking for tests).
    if (r.record.structuralHints?.isTest && !options?.skipTestPenalty) {
      r.score *= testFilePenalty;
    }
  }
}
