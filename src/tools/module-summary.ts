import type { AppContext } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaces, textResponse, errorResponse } from "./tool-utils.js";

export async function handleModuleSummary(
  args: { module: string; workspace?: string; file?: string; detail?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaces(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;

  // Collect records from all workspaces
  const wsRecords: Array<{ wsPath: string; records: FunctionRecord[] }> = [];
  for (const { ws, wsPath } of resolved.workspaces) {
    const records = ws.index.getByModule(args.module);
    if (records.length > 0) {
      wsRecords.push({ wsPath, records });
    }
  }

  if (wsRecords.length === 0) {
    // Suggest similar modules from all workspaces
    const allModules = new Set<string>();
    for (const { ws } of resolved.workspaces) {
      for (const m of ws.index.getAllModules()) {
        if (m.length > 0) allModules.add(m);
      }
    }
    const query = args.module.toLowerCase();
    const suggestions = Array.from(allModules)
      .filter(m => {
        const ml = m.toLowerCase();
        if (ml.includes(query) || query.includes(ml)) return true;
        // Also check each path segment (e.g., "strek" fuzzy-matches "streak" in "com/wordbox/streak/...")
        const segments = ml.split("/");
        for (const seg of segments) {
          if (seg.includes(query) || query.includes(seg)) return true;
          // Levenshtein-like: allow up to 2 char diffs for similar-length segments
          if (Math.abs(seg.length - query.length) <= 1) {
            let diff = 0;
            for (let i = 0; i < Math.max(seg.length, query.length); i++) {
              if (seg[i] !== query[i]) diff++;
            }
            if (diff <= 2) return true;
          }
        }
        return false;
      })
      .slice(0, 5);

    return errorResponse("MODULE_NOT_FOUND",
      `Module '${args.module}' not found${resolved.workspaces.length > 1 ? " in any workspace" : ""}.`,
      suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : undefined
    );
  }

  const showWorkspace = ctx.isMultiWorkspace;

  // Single workspace with results — standard output
  if (wsRecords.length === 1) {
    const { wsPath, records } = wsRecords[0];
    const result = buildModuleOutput(args.module, records, args.file, args.detail, ctx);
    if (showWorkspace) (result as any).workspace = wsPath;
    return textResponse(result);
  }

  // Multiple workspaces — combine with workspace labels
  const workspaceResults = wsRecords.map(({ wsPath, records }) => ({
    workspace: wsPath,
    ...buildModuleOutput(args.module, records, args.file, args.detail, ctx),
  }));

  return textResponse({
    module: args.module,
    workspaces: workspaceResults,
  });
}

function buildModuleOutput(
  module: string,
  records: FunctionRecord[],
  file?: string,
  requestedDetail?: string,
  ctx?: AppContext,
) {
  // Filter by file if specified
  let filtered = file
    ? records.filter(r => r.filePath.endsWith(file))
    : records;

  // Exclude test records by default — agent rarely needs tests when exploring a module's API.
  // If ≥80% of records are tests, this is a test module — keep them (user explicitly asked).
  const TEST_MODULE_THRESHOLD = 0.8;
  let testFilesExcluded = 0;
  if (!file) {
    const testCount = filtered.filter(r => r.structuralHints?.isTest).length;
    const moduleIsTestDir = testCount > 0 && testCount >= filtered.length * TEST_MODULE_THRESHOLD;
    if (!moduleIsTestDir) {
      const before = filtered.length;
      filtered = filtered.filter(r => !r.structuralHints?.isTest);
      testFilesExcluded = before - filtered.length;
    }
  }

  // Determine detail level
  const detail = requestedDetail || "auto";
  const showPrivate = detail === "full";

  // In auto/compact modes: hide private/protected and constructors
  if (!showPrivate) {
    filtered = filtered.filter(r =>
      r.visibility === "public" && !r.name.endsWith(".constructor")
    );
  }

  // Progressive disclosure based on filtered count
  const threshold = ctx?.config.moduleSummary || { compactThreshold: 20, filesOnlyThreshold: 50, maxTokenBudget: 4000 };
  let mode: string;
  if (detail === "auto") {
    if (filtered.length <= threshold.compactThreshold) mode = "full";
    else if (filtered.length <= threshold.filesOnlyThreshold) mode = "compact";
    else mode = "files_only";
  } else {
    mode = detail;
  }

  const result = mode === "files_only" ? buildFilesOnly(module, filtered)
    : mode === "compact" ? buildCompact(module, filtered)
    : buildFull(module, filtered);

  if (testFilesExcluded > 0) {
    (result as any).test_files_excluded = testFilesExcluded;
  }

  return result;
}

// === Output builders ===

function buildFilesOnly(module: string, records: FunctionRecord[]) {
  const fileMap = new Map<string, { classes: string[]; functions: number; methods: number }>();

  for (const r of records) {
    if (!fileMap.has(r.filePath)) fileMap.set(r.filePath, { classes: [], functions: 0, methods: 0 });
    const entry = fileMap.get(r.filePath)!;
    if (r.kind === "class" || r.kind === "interface") {
      entry.classes.push(r.name);
    } else if (r.kind === "method") {
      entry.methods++;
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
      ...(info.methods > 0 ? { methods: info.methods } : {}),
      functions: info.functions,
    })),
  };
}

function buildCompact(module: string, records: FunctionRecord[]) {
  const byFile = groupByFile(records);

  const files = Array.from(byFile.entries()).map(([file, recs]) => {
    const { classItems, standaloneItems } = splitByClass(recs);

    const items: Array<Record<string, unknown>> = [];

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

function buildFull(module: string, records: FunctionRecord[]) {
  const byFile = groupByFile(records);

  const files = Array.from(byFile.entries()).map(([file, recs]) => {
    const { classItems, standaloneItems } = splitByClass(recs);

    const items: Array<Record<string, unknown>> = [];

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
            name: m.name.split(".").pop()!,
            signature: flattenSignature(m.signature),
            line_start: m.lineStart,
          };
          addOptionalDocstring(method, m);
          return method;
        });
      }
      items.push(classEntry);
    }

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

  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.kind === "class" || r.kind === "interface") {
      classItems.set(r.name, { record: r, methods: [] });
    }
  }

  for (const r of records) {
    if (seen.has(r.id) && (r.kind === "class" || r.kind === "interface")) continue;
    if (r.kind === "method") {
      const className = r.name.split(".")[0];
      const cls = classItems.get(className);
      if (cls) {
        if (!cls.methods.some(m => m.name === r.name)) {
          cls.methods.push(r);
        }
        continue;
      }
    }
    if (!standaloneItems.some(s => s.id === r.id)) {
      standaloneItems.push(r);
    }
  }

  return { classItems, standaloneItems };
}

function addOptionalDocstring(entry: Record<string, unknown>, record: FunctionRecord): void {
  if (record.docstring?.summary) entry.summary = record.docstring.summary;
  if (record.docstring?.tags && record.docstring.tags.length > 0) entry.tags = record.docstring.tags;
}

function flattenSignature(sig: string): string {
  return sig.replace(/\s*\n\s*/g, " ").trim();
}
