import type { AppContext } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaceOrError, textResponse, errorResponse } from "./tool-utils.js";

export async function handleModuleSummary(
  args: { module: string; workspace?: string; file?: string; detail?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;
  const records = ws.index.getByModule(args.module);

  if (records.length === 0) {
    // Suggest similar modules
    const allModules = ws.index.getAllModules().filter(m => m.length > 0);
    const query = args.module.toLowerCase();
    const suggestions = allModules
      .filter(m => {
        const ml = m.toLowerCase();
        if (ml.includes(query) || query.includes(ml)) return true;
        if (Math.abs(ml.length - query.length) <= 1) {
          let diff = 0;
          for (let i = 0; i < Math.max(ml.length, query.length); i++) {
            if (ml[i] !== query[i]) diff++;
          }
          if (diff <= 2) return true;
        }
        return false;
      })
      .slice(0, 5);

    return errorResponse("MODULE_NOT_FOUND",
      `Module '${args.module}' not found.`,
      suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : undefined
    );
  }

  // Filter by file if specified
  let filtered = args.file
    ? records.filter(r => r.filePath.endsWith(args.file!))
    : records;

  // Determine detail level
  const requestedDetail = args.detail || "auto";
  const showPrivate = requestedDetail === "full";

  // In auto/compact modes: hide private/protected and constructors
  if (!showPrivate) {
    filtered = filtered.filter(r =>
      r.visibility === "public" && !r.name.endsWith(".constructor")
    );
  }

  // Progressive disclosure based on filtered count
  const threshold = ctx.config.moduleSummary;
  let mode: string;
  if (requestedDetail === "auto") {
    if (filtered.length <= threshold.compactThreshold) mode = "full";
    else if (filtered.length <= threshold.filesOnlyThreshold) mode = "compact";
    else mode = "files_only";
  } else {
    mode = requestedDetail;
  }

  let result: unknown;

  if (mode === "files_only") {
    result = buildFilesOnly(args.module, filtered);
  } else if (mode === "compact") {
    result = buildCompact(args.module, filtered);
  } else {
    result = buildFull(args.module, filtered);
  }

  return textResponse(result);
}

// === Output builders ===

/**
 * files_only: file list with class names + function counts.
 * Agent can see which files and classes exist without opening anything.
 */
function buildFilesOnly(module: string, records: FunctionRecord[]) {
  const fileMap = new Map<string, { classes: string[]; functions: number }>();

  for (const r of records) {
    if (!fileMap.has(r.filePath)) fileMap.set(r.filePath, { classes: [], functions: 0 });
    const entry = fileMap.get(r.filePath)!;
    if (r.kind === "class" || r.kind === "interface") {
      entry.classes.push(r.name);
    } else {
      entry.functions++;
    }
  }

  return {
    module,
    mode: "files_only",
    total: records.length,
    files: Array.from(fileMap.entries()).map(([file, info]) => ({
      file,
      ...(info.classes.length > 0 ? { classes: info.classes } : {}),
      functions: info.functions,
    })),
  };
}

/**
 * compact: grouped by file. Classes show method names inline.
 * Standalone functions show signature. No line numbers, no metadata.
 */
function buildCompact(module: string, records: FunctionRecord[]) {
  const byFile = groupByFile(records);

  const files = Array.from(byFile.entries()).map(([file, recs]) => {
    const { classItems, standaloneItems } = splitByClass(recs);

    const items: Array<Record<string, unknown>> = [];

    // Classes with method names
    for (const [className, cls] of classItems) {
      const entry: Record<string, unknown> = {
        name: className,
        kind: cls.record.kind,
        signature: flattenSignature(cls.record.signature),
      };
      if (cls.methods.length > 0) {
        entry.methods = cls.methods.map(m => flattenSignature(m.signature));
      }
      items.push(entry);
    }

    // Standalone functions
    for (const r of standaloneItems) {
      items.push({
        name: r.name,
        kind: r.kind,
        signature: flattenSignature(r.signature),
      });
    }

    return { file, items };
  });

  return { module, mode: "compact", total: records.length, files };
}

/**
 * full: grouped by file, classes with methods nested.
 * Includes summary, tags, line numbers — only when present.
 */
function buildFull(module: string, records: FunctionRecord[]) {
  const byFile = groupByFile(records);

  const files = Array.from(byFile.entries()).map(([file, recs]) => {
    const { classItems, standaloneItems } = splitByClass(recs);

    const items: Array<Record<string, unknown>> = [];

    // Classes with nested methods
    for (const [className, cls] of classItems) {
      const classEntry: Record<string, unknown> = {
        name: className,
        kind: cls.record.kind,
        signature: flattenSignature(cls.record.signature),
        line_start: cls.record.lineStart,
      };
      addOptionalDocstring(classEntry, cls.record);

      if (cls.methods.length > 0) {
        classEntry.methods = cls.methods.map(m => {
          const method: Record<string, unknown> = {
            name: m.name.split(".").pop()!, // "Class.method" → "method"
            signature: flattenSignature(m.signature),
            line_start: m.lineStart,
          };
          addOptionalDocstring(method, m);
          return method;
        });
      }
      items.push(classEntry);
    }

    // Standalone functions/interfaces
    for (const r of standaloneItems) {
      const entry: Record<string, unknown> = {
        name: r.name,
        kind: r.kind,
        signature: flattenSignature(r.signature),
        line_start: r.lineStart,
      };
      addOptionalDocstring(entry, r);
      items.push(entry);
    }

    return { file, items };
  });

  return { module, mode: "full", total: records.length, files };
}

// === Helpers ===

function groupByFile(records: FunctionRecord[]): Map<string, FunctionRecord[]> {
  const map = new Map<string, FunctionRecord[]>();
  for (const r of records) {
    if (!map.has(r.filePath)) map.set(r.filePath, []);
    map.get(r.filePath)!.push(r);
  }
  return map;
}

function splitByClass(records: FunctionRecord[]) {
  const classItems = new Map<string, { record: FunctionRecord; methods: FunctionRecord[] }>();
  const standaloneItems: FunctionRecord[] = [];
  const seen = new Set<string>();

  // First pass: find class/interface records
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.kind === "class" || r.kind === "interface") {
      classItems.set(r.name, { record: r, methods: [] });
    }
  }

  // Second pass: attach methods to classes, collect standalone
  for (const r of records) {
    if (seen.has(r.id) && (r.kind === "class" || r.kind === "interface")) continue;
    if (r.kind === "method") {
      const className = r.name.split(".")[0];
      const cls = classItems.get(className);
      if (cls) {
        // Deduplicate methods by name
        if (!cls.methods.some(m => m.name === r.name)) {
          cls.methods.push(r);
        }
        continue;
      }
    }
    // Deduplicate standalone items
    if (!standaloneItems.some(s => s.id === r.id)) {
      standaloneItems.push(r);
    }
  }

  return { classItems, standaloneItems };
}

/** Only add summary/tags when they carry information. Never emit null or empty. */
function addOptionalDocstring(entry: Record<string, unknown>, record: FunctionRecord): void {
  if (record.docstring?.summary) entry.summary = record.docstring.summary;
  if (record.docstring?.tags && record.docstring.tags.length > 0) entry.tags = record.docstring.tags;
}

/** Collapse multi-line signatures to single line. */
function flattenSignature(sig: string): string {
  return sig.replace(/\s*\n\s*/g, " ").trim();
}
