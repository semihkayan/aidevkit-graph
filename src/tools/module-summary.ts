import type { AppContext } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveWorkspaces, textResponse, errorResponse } from "./tool-utils.js";
import { findSimilar } from "../utils/string-similarity.js";

export async function handleModuleSummary(
  args: { module: string; workspace?: string; file?: string; detail?: string; group_by?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaces(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;

  // Collect records from all workspaces
  const isRootQuery = args.module === ".";
  const wsRecords: Array<{ wsPath: string; records: FunctionRecord[] }> = [];
  for (const { ws, wsPath } of resolved.workspaces) {
    const records = isRootQuery
      ? ws.index.getAll()
      : ws.index.getByModule(args.module);
    if (records.length > 0) {
      wsRecords.push({ wsPath, records });
    }
  }

  if (wsRecords.length === 0) {
    if (isRootQuery) {
      return errorResponse("MODULE_NOT_FOUND", "No indexed functions found.");
    }

    // Suggest similar modules from all workspaces
    const allModules = new Set<string>();
    for (const { ws } of resolved.workspaces) {
      for (const m of ws.index.getAllModules()) {
        if (m.length > 0) allModules.add(m);
      }
    }
    const suggestions = findSimilar(args.module, allModules, { mode: "path" });
    const examples = Array.from(allModules).slice(0, 5);

    const hints: string[] = [];
    if (suggestions.length > 0) hints.push(`Did you mean: ${suggestions.join(", ")}?`);
    if (examples.length > 0) hints.push(`Available modules include: ${examples.join(", ")}`);
    if (looksLikeSourceRoot(args.module, ctx)) {
      hints.push("This looks like a source root (stripped from module paths). Use module '.' for a top-level project overview.");
    }

    return errorResponse("MODULE_NOT_FOUND",
      `Module '${args.module}' not found${resolved.workspaces.length > 1 ? " in any workspace" : ""}.`,
      hints.length > 0 ? hints.join(" ") : undefined,
    );
  }

  const showWorkspace = ctx.isMultiWorkspace;

  // Single workspace with results — standard output
  if (wsRecords.length === 1) {
    const { wsPath, records } = wsRecords[0];
    const result = buildModuleOutput(args.module, records, args.file, args.detail, args.group_by, ctx);
    if (showWorkspace) (result as any).workspace = wsPath;
    return textResponse(result);
  }

  // Multiple workspaces — combine with workspace labels
  const workspaceResults = wsRecords.map(({ wsPath, records }) => ({
    workspace: wsPath,
    ...buildModuleOutput(args.module, records, args.file, args.detail, args.group_by, ctx),
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
  requestedGroupBy?: string,
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

  const threshold = ctx?.config.moduleSummary || { compactThreshold: 20, filesOnlyThreshold: 50, overviewThreshold: 200, maxTokenBudget: 50000 };
  const groupBy = requestedGroupBy || "auto";

  // Resolve mode for total record set
  const totalMode = resolveDetailMode(detail, filtered.length, threshold);

  // Overview: counts-only per-submodule output for very large scopes.
  // Short-circuits before submodule grouping — fundamentally different output level.
  if (totalMode === "overview" && !file) {
    const result = buildOverview(module, filtered);
    if (testFilesExcluded > 0) result.test_files_excluded = testFilesExcluded;
    return applyBudgetGuard(result, threshold.maxTokenBudget);
  }

  // Determine if submodule grouping should activate
  const submoduleGroups = groupBySubmodule(filtered);
  const hasMultipleSubmodules = submoduleGroups.size > 1;
  const useSubmoduleGrouping = file
    ? false  // file param overrides — focusing on a single file
    : groupBy === "submodule"
      ? hasMultipleSubmodules  // explicit submodule — use if possible, fallback to file if flat
      : groupBy === "auto"
        ? hasMultipleSubmodules && filtered.length > threshold.compactThreshold
        : false;  // group_by=file — always file-based

  if (useSubmoduleGrouping) {
    // Per-submodule output with independent auto-scaling
    const submodules = Array.from(submoduleGroups.entries())
      .sort(([a], [b]) => a === "(root)" ? -1 : b === "(root)" ? 1 : a.localeCompare(b))
      .map(([submodule, recs]) => {
        const mode = resolveDetailMode(detail, recs.length, threshold);
        // Cap at files_only — overview is a module-level concept, not per-submodule
        const effectiveMode = mode === "overview" ? "files_only" : mode;
        const built = buildForMode(module, recs, effectiveMode);
        return { submodule, mode: effectiveMode, total: recs.length, files: (built as any).files };
      });

    const result: Record<string, unknown> = {
      module,
      group_by: "submodule",
      total: filtered.length,
      submodules,
    };
    if (testFilesExcluded > 0) result.test_files_excluded = testFilesExcluded;
    return applyBudgetGuard(result, threshold.maxTokenBudget);
  }

  // File-based grouping (current behavior)
  // Cap at files_only if overview resolved outside of short-circuit path (e.g., file param set)
  const mode = totalMode === "overview" ? "files_only" : totalMode;
  const result = buildForMode(module, filtered, mode);

  if (testFilesExcluded > 0) {
    (result as any).test_files_excluded = testFilesExcluded;
  }

  return applyBudgetGuard(result as Record<string, unknown>, threshold.maxTokenBudget);
}

function resolveDetailMode(
  detail: string,
  count: number,
  threshold: { compactThreshold: number; filesOnlyThreshold: number; overviewThreshold?: number },
): string {
  if (detail !== "auto") return detail;
  if (count <= threshold.compactThreshold) return "full";
  if (count <= threshold.filesOnlyThreshold) return "compact";
  if (count <= (threshold.overviewThreshold ?? 200)) return "files_only";
  return "overview";
}

function buildForMode(module: string, records: FunctionRecord[], mode: string) {
  if (mode === "overview") return buildOverview(module, records);
  if (mode === "files_only") return buildFilesOnly(module, records);
  if (mode === "compact") return buildCompact(module, records);
  return buildFull(module, records);
}

// === Output builders ===

function buildOverview(module: string, records: FunctionRecord[]): Record<string, unknown> {
  const subGroups = groupBySubmodule(records);
  const hasSubmodules = subGroups.size > 1 || !subGroups.has("(root)");

  const submodules = Array.from(subGroups.entries())
    .sort(([a], [b]) => a === "(root)" ? -1 : b === "(root)" ? 1 : a.localeCompare(b))
    .map(([name, recs]) => {
      const files = new Set(recs.map(r => r.filePath)).size;
      let classes = 0, functions = 0, methods = 0;
      for (const r of recs) {
        if (r.kind === "class" || r.kind === "interface") classes++;
        else if (r.kind === "method") methods++;
        else functions++;
      }
      return { submodule: name, files, classes, functions, methods };
    });

  const exampleSub = submodules.find(s => s.submodule !== "(root)")?.submodule;
  const isRoot = module === ".";
  const hint = hasSubmodules
    ? isRoot
      ? `Query specific submodules for details (e.g., module: '${exampleSub}')`
      : `Query specific submodules for details (e.g., module: '${module}/${exampleSub}')`
    : "Use the file: parameter to explore specific files, or try a more specific module path.";

  const result: Record<string, unknown> = {
    module,
    mode: "overview",
    total: records.length,
    submodules,
    hint,
  };

  if (isRoot) {
    const base = findCommonModuleBase(records);
    if (base) result.common_base = base;
  }

  return result;
}

function applyBudgetGuard(
  output: Record<string, unknown>,
  budget: number,
): Record<string, unknown> {
  const serialized = JSON.stringify(output);
  if (serialized.length <= budget) return output;

  const arrayKey = output.submodules ? "submodules" : "files";
  const arr = output[arrayKey] as unknown[] | undefined;
  if (!arr?.length || arr.length <= 1) return output;

  // Ratio-based estimation: how many items fit within budget
  const arrSerialized = JSON.stringify(arr);
  const overhead = serialized.length - arrSerialized.length;
  const perItem = arrSerialized.length / arr.length;
  const targetCount = Math.max(1, Math.floor((budget - overhead) / perItem * 0.9));
  const kept = Math.min(targetCount, arr.length);

  return {
    ...output,
    [arrayKey]: arr.slice(0, kept),
    truncated: true,
    truncated_count: arr.length - kept,
    hint: output.hint || "Output truncated due to size. Use a more specific module path.",
  };
}

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

    for (const { record, methods } of sortByKind(Array.from(classItems.values()))) {
      const entry: Record<string, unknown> = {
        name: record.name,
        kind: record.kind,
        signature: flattenSignature(record.signature),
      };
      addTypeRelationships(entry, record);
      if (methods.length > 0) {
        entry.methods = methods.map(m => flattenSignature(m.signature));
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

    for (const { record, methods } of sortByKind(Array.from(classItems.values()))) {
      const classEntry: Record<string, unknown> = {
        name: record.name,
        kind: record.kind,
        signature: flattenSignature(record.signature),
        line_start: record.lineStart,
      };
      addOptionalDocstring(classEntry, record);
      addTypeRelationships(classEntry, record);

      if (methods.length > 0) {
        classEntry.methods = methods.map(m => {
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

function addTypeRelationships(entry: Record<string, unknown>, record: FunctionRecord): void {
  if (record.typeRelationships?.implements?.length) entry.implements = record.typeRelationships.implements;
  if (record.typeRelationships?.extends?.length) entry.extends = record.typeRelationships.extends;
}

function flattenSignature(sig: string): string {
  return sig.replace(/\s*\n\s*/g, " ").trim();
}

// === Sub-module grouping ===

function findCommonModuleBase(records: FunctionRecord[]): string {
  const modules = [...new Set(records.map(r => r.module))];
  if (modules.length <= 1) return modules[0] ?? "";
  let base = modules[0];
  for (let i = 1; i < modules.length; i++) {
    while (base.length > 0 && modules[i] !== base && !modules[i].startsWith(base + "/")) {
      const lastSlash = base.lastIndexOf("/");
      base = lastSlash === -1 ? "" : base.slice(0, lastSlash);
    }
  }
  return base;
}

function groupBySubmodule(records: FunctionRecord[]): Map<string, FunctionRecord[]> {
  const base = findCommonModuleBase(records);
  const map = new Map<string, FunctionRecord[]>();
  for (const r of records) {
    let key: string;
    if (r.module === base || !r.module.startsWith(base + "/")) {
      key = "(root)";
    } else {
      const relative = r.module.slice(base.length + 1);
      const slash = relative.indexOf("/");
      key = slash === -1 ? relative : relative.slice(0, slash);
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}

// === Kind-based sorting ===

const KIND_ORDER: Record<string, number> = {
  interface: 0, class: 2, struct: 3, enum: 4, record: 5, function: 6, method: 7,
};

function kindSortOrder(r: FunctionRecord): number {
  if (r.structuralHints?.isAbstract) return 1; // abstract classes between interface and concrete
  return KIND_ORDER[r.kind] ?? 99;
}

function sortByKind<T extends { record: FunctionRecord }>(items: T[]): T[] {
  return [...items].sort((a, b) => kindSortOrder(a.record) - kindSortOrder(b.record));
}

// === Source root detection ===

function looksLikeSourceRoot(query: string, ctx: AppContext): boolean {
  const roots: string[] = [];
  if (ctx.config.parser.sourceRoot) roots.push(ctx.config.parser.sourceRoot);
  for (const r of ctx.conventions.sourceRoots) {
    roots.push(r.replace(/\/+$/, ""));
  }
  const q = query.replace(/\/+$/, "");
  return roots.some(r => r === q || r.startsWith(q + "/"));
}
