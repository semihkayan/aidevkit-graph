import type { AppContext, WorkspaceServices } from "../types/interfaces.js";
import { resolveWorkspaces, textResponse } from "./tool-utils.js";

function checkWorkspace(
  ws: WorkspaceServices,
  wsPath: string,
  scope: string | undefined,
  checkType: string,
  showWorkspace: boolean,
) {
  const issues: Array<{
    function: string; file: string; line: number; issue: string; severity: string; workspace?: string;
  }> = [];

  for (const filePath of ws.index.getAllFilePaths()) {
    if (scope && !filePath.startsWith(scope)) continue;

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
          ...(showWorkspace ? { workspace: wsPath } : {}),
        });
        continue;
      }

      if (!record.docstring) continue;

      // Check: missing @deps
      if (checkType === "all" || checkType === "deps") {
        const callEntry = ws.callGraph.getEntry(record.id);
        const astCalls = callEntry?.calls || [];

        if (astCalls.length > 0 && record.docstring.deps.length === 0) {
          issues.push({
            function: record.name,
            file: record.filePath,
            line: record.lineStart,
            issue: "missing_deps",
            severity: "warning",
            ...(showWorkspace ? { workspace: wsPath } : {}),
          });
        }

        // Check: @deps that don't match AST
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
              ...(showWorkspace ? { workspace: wsPath } : {}),
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
          ...(showWorkspace ? { workspace: wsPath } : {}),
        });
      }
    }
  }

  return issues;
}

export async function handleStaleDocstrings(
  args: { workspace?: string; scope?: string; check_type?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaces(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;

  const checkType = args.check_type || "all";
  const showWorkspace = ctx.isMultiWorkspace;

  // Collect issues from all workspaces
  const allIssues: Array<{
    function: string; file: string; line: number; issue: string; severity: string; workspace?: string;
  }> = [];

  for (const { ws, wsPath } of resolved.workspaces) {
    const issues = checkWorkspace(ws, wsPath, args.scope, checkType, showWorkspace);
    allIssues.push(...issues);
  }

  // Prioritize: warnings first, then info. Global cap at 20.
  const warnings = allIssues.filter(i => i.severity === "warning");
  const infos = allIssues.filter(i => i.severity === "info");
  const MAX_ISSUES = 20;
  const shown = [...warnings, ...infos].slice(0, MAX_ISSUES);
  const truncated = allIssues.length > MAX_ISSUES;

  // Group missing_docstring count by directory for summary
  const missingByDir: Record<string, number> = {};
  for (const i of allIssues.filter(x => x.issue === "missing_docstring")) {
    const dirKey = showWorkspace && i.workspace
      ? `[${i.workspace}] ${i.file.split("/").slice(0, -1).join("/") || "."}`
      : i.file.split("/").slice(0, -1).join("/") || ".";
    missingByDir[dirKey] = (missingByDir[dirKey] || 0) + 1;
  }

  return textResponse({
    total_issues: allIssues.length,
    by_severity: { warning: warnings.length, info: infos.length },
    ...(Object.keys(missingByDir).length > 0 ? {
      missing_docstrings_summary: missingByDir,
    } : {}),
    issues: shown.filter(i => i.issue !== "missing_docstring"),
    ...(truncated ? { note: `Showing ${MAX_ISSUES} of ${allIssues.length} issues. Use scope parameter to narrow down.` } : {}),
  });
}
