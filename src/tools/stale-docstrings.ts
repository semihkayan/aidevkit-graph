import type { AppContext } from "../types/interfaces.js";
import { resolveWorkspaceOrError, textResponse } from "./tool-utils.js";

export async function handleStaleDocstrings(
  args: { workspace?: string; scope?: string; check_type?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;
  const checkType = args.check_type || "all";

  const issues: Array<{
    function: string; file: string; line: number; issue: string; severity: string;
  }> = [];

  for (const filePath of ws.index.getAllFilePaths()) {
    if (args.scope && !filePath.startsWith(args.scope)) continue;

    for (const id of ws.index.getFileRecordIds(filePath)) {
      const record = ws.index.getById(id);
      if (!record || record.kind === "class") continue;

      // Check: missing docstring entirely
      if ((checkType === "all" || checkType === "missing") && !record.docstring) {
        issues.push({
          function: record.name,
          file: record.filePath,
          line: record.lineStart,
          issue: "missing_docstring",
          severity: "info",
        });
        continue; // No point checking other fields if no docstring
      }

      if (!record.docstring) continue;

      // Check: missing @deps
      if (checkType === "all" || checkType === "deps") {
        const callEntry = ws.callGraph.getEntry(record.id);
        // Include both resolved and unresolved calls (self.x calls are real deps)
        const astCalls = callEntry?.calls || [];

        if (astCalls.length > 0 && record.docstring.deps.length === 0) {
          issues.push({
            function: record.name,
            file: record.filePath,
            line: record.lineStart,
            issue: "missing_deps",
            severity: "warning",
          });
        }

        // Check: @deps that don't match AST (fuzzy: match by last segment)
        for (const dep of record.docstring.deps) {
          const depMethod = dep.split(".").pop()!;
          const matchesAst = astCalls.some(c => {
            const callMethod = c.target.split(".").pop()!;
            return c.target.includes(dep) || dep.includes(callMethod) || callMethod === depMethod;
          });
          if (!matchesAst) {
            issues.push({
              function: record.name,
              file: record.filePath,
              line: record.lineStart,
              issue: `stale_dep: @deps mentions "${dep}" but not found in AST calls`,
              severity: "warning",
            });
          }
        }
      }

      // Check: missing @tags
      if ((checkType === "all" || checkType === "tags") && record.docstring.tags.length === 0) {
        issues.push({
          function: record.name,
          file: record.filePath,
          line: record.lineStart,
          issue: "missing_tags",
          severity: "info",
        });
      }
    }
  }

  // Prioritize: warnings first, then info. Cap at 20 to prevent huge responses.
  const warnings = issues.filter(i => i.severity === "warning");
  const infos = issues.filter(i => i.severity === "info");
  const MAX_ISSUES = 20;
  const shown = [...warnings, ...infos].slice(0, MAX_ISSUES);
  const truncated = issues.length > MAX_ISSUES;

  // Group missing_docstring count by directory for summary instead of listing each one
  const missingByDir: Record<string, number> = {};
  for (const i of issues.filter(x => x.issue === "missing_docstring")) {
    const dir = i.file.split("/").slice(0, -1).join("/") || ".";
    missingByDir[dir] = (missingByDir[dir] || 0) + 1;
  }

  return textResponse({
    total_issues: issues.length,
    by_severity: { warning: warnings.length, info: infos.length },
    ...(Object.keys(missingByDir).length > 0 ? {
      missing_docstrings_summary: missingByDir,
    } : {}),
    issues: shown.filter(i => i.issue !== "missing_docstring"),
    ...(truncated ? { note: `Showing ${MAX_ISSUES} of ${issues.length} issues. Use scope parameter to narrow down.` } : {}),
  });
}
