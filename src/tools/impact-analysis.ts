import type { AppContext, WorkspaceServices } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveFunctionAcrossWorkspaces, textResponse } from "./tool-utils.js";

function analyzeImpact(ws: WorkspaceServices, record: FunctionRecord, changeType: "signature" | "behavior" | "removal") {
  // Call graph impact
  const upstream = ws.callGraph.getTransitive(record.id, "upstream", 5);
  const callImpact = upstream.nodes.map(n => {
    const r = ws.index.getById(n.id);
    let risk: "high" | "medium" | "low";
    if (n.depth === 1 && (changeType === "signature" || changeType === "removal")) risk = "high";
    else if (n.depth === 1) risk = "medium";
    else if (n.depth === 2) risk = "medium";
    else risk = "low";

    return {
      function: r?.name || n.id,
      file: r?.filePath || "",
      module: r?.module || "",
      depth: n.depth,
      risk,
    };
  });

  // Type graph impact
  const typeImpact: any[] = [];

  if (record.kind === "class" || record.kind === "interface") {
    const typeName = record.name.split(".").pop()!;

    const implementors = ws.typeGraph.getImplementors(typeName)
      .filter(id => id !== record.id);
    if (implementors.length > 0) {
      typeImpact.push({
        type: typeName,
        relationship: "implementors",
        affected: implementors.map(id => ws.index.getById(id)?.name || id),
        risk: changeType === "signature" ? "high" : "medium",
      });
    }

    const extenders = ws.typeGraph.getExtenders(typeName)
      .filter(id => id !== record.id);
    if (extenders.length > 0) {
      typeImpact.push({
        type: typeName,
        relationship: "extenders",
        affected: extenders.map(id => ws.index.getById(id)?.name || id),
        risk: changeType === "signature" ? "high" : "medium",
      });
    }

    const usages = ws.typeGraph.getUsages(typeName)
      .filter(id => id !== record.id);
    if (usages.length > 0) {
      typeImpact.push({
        type: typeName,
        relationship: "usedBy",
        affected: usages.map(id => ws.index.getById(id)?.name || id),
        risk: "medium",
      });
    }
  }

  return { callImpact, typeImpact };
}

export async function handleImpactAnalysis(
  args: { function: string; workspace?: string; module?: string; change_type?: string },
  ctx: AppContext
) {
  const resolved = resolveFunctionAcrossWorkspaces(ctx, args.function, args.module, args.workspace);
  if ("error" in resolved) return resolved.error;

  const changeType = (args.change_type || "behavior") as "signature" | "behavior" | "removal";
  const showWorkspace = ctx.isMultiWorkspace;

  if (resolved.matches.length === 1) {
    const { ws, wsPath, record } = resolved.matches[0];
    const { callImpact, typeImpact } = analyzeImpact(ws, record, changeType);

    return textResponse({
      function: record.name,
      file: record.filePath,
      ...(showWorkspace ? { workspace: wsPath } : {}),
      change_type: changeType,
      call_impact: callImpact,
      type_impact: typeImpact,
      total_affected: callImpact.length + typeImpact.reduce((sum, t) => sum + t.affected.length, 0),
      caveat: "Static analysis only. Dynamic dispatch, callbacks, and runtime type changes not captured.",
    });
  }

  // Multiple matches across workspaces
  const results = resolved.matches.map(({ ws, wsPath, record }) => {
    const { callImpact, typeImpact } = analyzeImpact(ws, record, changeType);
    return {
      function: record.name,
      file: record.filePath,
      workspace: wsPath,
      change_type: changeType,
      call_impact: callImpact,
      type_impact: typeImpact,
      total_affected: callImpact.length + typeImpact.reduce((sum, t) => sum + t.affected.length, 0),
    };
  });

  return textResponse({
    matches: results,
    note: `Function '${args.function}' found in ${results.length} workspaces. Use workspace parameter to target one.`,
    caveat: "Static analysis only. Dynamic dispatch, callbacks, and runtime type changes not captured.",
  });
}
