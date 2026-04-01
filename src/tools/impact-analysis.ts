import type { AppContext, WorkspaceServices, LanguageConventions } from "../types/interfaces.js";
import type { FunctionRecord } from "../types/index.js";
import { resolveFunctionAcrossWorkspaces, textResponse } from "./tool-utils.js";

type Risk = "high" | "medium" | "low";
type TypeImpactRelationship = "implementors" | "extenders" | "usedBy" | "implementor_callers" | "interface_contract" | "implementor_methods";

interface TypeImpactEntry {
  type: string;
  relationship: TypeImpactRelationship;
  affected: Array<string | { function: string; file: string; line_start: number }>;
  risk: Risk;
  method?: string;
  via?: string;
}

/**
 * Find equivalent method IDs across interface↔implementation and class↔subclass boundaries.
 * Used for bridging BFS traversal across type hierarchy boundaries.
 */
function getMethodEquivalents(ws: WorkspaceServices, methodId: string): string[] {
  const record = ws.index.getById(methodId);
  if (!record || record.kind !== "method") return [];

  const dotIdx = record.name.indexOf(".");
  if (dotIdx <= 0) return [];
  const parentName = record.name.substring(0, dotIdx);
  const methodName = record.name.substring(dotIdx + 1);

  const parentRecord = ws.index.findByExactName(parentName)
    .find(r => r.kind === "class" || r.kind === "interface");
  if (!parentRecord) return [];

  const relatedTypeIds: string[] = [];

  if (parentRecord.typeRelationships) {
    for (const ifaceName of parentRecord.typeRelationships.implements ?? []) {
      const ifaceRecord = ws.index.findByExactName(ifaceName).find(r => r.kind === "interface");
      if (ifaceRecord) relatedTypeIds.push(ifaceRecord.id);
      relatedTypeIds.push(...ws.typeGraph.getImplementors(ifaceName).filter(id => id !== parentRecord.id));
    }
    for (const baseName of parentRecord.typeRelationships.extends ?? []) {
      const baseRecord = ws.index.findByExactName(baseName).find(r => r.kind === "class" || r.kind === "interface");
      if (baseRecord) relatedTypeIds.push(baseRecord.id);
      const siblings = ws.typeGraph.getTypeNode(baseName)?.kind === "interface"
        ? ws.typeGraph.getImplementors(baseName)
        : ws.typeGraph.getExtenders(baseName);
      if (siblings) relatedTypeIds.push(...siblings.filter(id => id !== parentRecord.id));
    }
  }

  relatedTypeIds.push(...ws.typeGraph.getImplementors(parentName));
  relatedTypeIds.push(...ws.typeGraph.getExtenders(parentName));

  const equivalents: string[] = [];
  const seen = new Set<string>();
  for (const typeId of relatedTypeIds) {
    const sep = typeId.indexOf("::");
    if (sep === -1) continue;
    const filePath = typeId.slice(0, sep);
    const typeName = typeId.slice(sep + 2);
    const candidateId = `${filePath}::${typeName}.${methodName}`;
    if (!seen.has(candidateId) && candidateId !== methodId && ws.index.getById(candidateId)) {
      seen.add(candidateId);
      equivalents.push(candidateId);
    }
  }
  return equivalents;
}

function analyzeImpact(
  ws: WorkspaceServices,
  record: FunctionRecord,
  changeType: "signature" | "behavior" | "removal",
  conventions?: LanguageConventions,
) {
  // Build call-line map for depth-1 callers, including equivalents (interface↔implementation)
  const callLineMap = new Map<string, number>();
  for (const targetId of [record.id, ...getMethodEquivalents(ws, record.id)]) {
    const entry = ws.callGraph.getEntry(targetId);
    if (entry) {
      for (const c of entry.calledBy) {
        if (!callLineMap.has(c.caller)) callLineMap.set(c.caller, c.line);
      }
    }
  }

  // Call graph impact (with interface↔implementation bridging)
  const bridgeFn = (id: string) => getMethodEquivalents(ws, id);
  const upstream = ws.callGraph.getTransitive(record.id, "upstream", 5, bridgeFn);
  const callImpact = upstream.nodes.map(n => {
    const r = ws.index.getById(n.id);
    let risk: Risk;
    if (n.depth === 1 && (changeType === "signature" || changeType === "removal")) risk = "high";
    else if (n.depth === 1) risk = "medium";
    else if (n.depth === 2) risk = "medium";
    else risk = "low";

    return {
      function: r?.name || n.id,
      file: r?.filePath || "",
      module: r?.module || "",
      line_start: r?.lineStart ?? 0,
      kind: r?.kind || "function",
      depth: n.depth,
      risk,
      ...(n.depth === 1 && callLineMap.has(n.id) ? { call_line: callLineMap.get(n.id) } : {}),
    };
  });

  // Type graph impact
  const typeImpact: TypeImpactEntry[] = [];

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
      typeImpact.push(...collectImplementorCallers(ws, typeName, implementors, changeType, conventions));
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
      typeImpact.push(...collectImplementorCallers(ws, typeName, extenders, changeType, conventions));
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
  } else if (record.kind === "method") {
    typeImpact.push(...collectInterfaceContract(ws, record, changeType));
    typeImpact.push(...collectInterfaceMethodImplementors(ws, record, changeType, conventions));
  }

  return { callImpact, typeImpact };
}

/**
 * For each implementor/extender class, find callers of their methods
 * so the agent knows the full blast radius of an interface/class change.
 */
function collectImplementorCallers(
  ws: WorkspaceServices,
  typeName: string,
  classIds: string[],
  changeType: "signature" | "behavior" | "removal",
  conventions?: LanguageConventions,
): TypeImpactEntry[] {
  const risk: Risk = changeType === "behavior" ? "medium" : "high";
  const entries: TypeImpactEntry[] = [];

  for (const classId of classIds) {
    const classRecord = ws.index.getById(classId);
    if (!classRecord?.classInfo?.methods) continue;

    const sep = classId.indexOf("::");
    if (sep === -1) continue;
    const filePath = classId.slice(0, sep);
    const className = classId.slice(sep + 2);

    for (const methodName of classRecord.classInfo.methods) {
      if (conventions?.constructorNames?.has(methodName)) continue;

      const methodId = `${filePath}::${className}.${methodName}`;
      const callEntry = ws.callGraph.getEntry(methodId);
      if (!callEntry || callEntry.calledBy.length === 0) continue;

      const callers = callEntry.calledBy.map(c => {
        const r = ws.index.getById(c.caller);
        return { function: r?.name || c.caller, file: r?.filePath || "", line_start: r?.lineStart ?? 0 };
      });

      entries.push({ type: typeName, relationship: "implementor_callers", method: methodName, via: className, affected: callers, risk });
    }
  }

  return entries;
}

/**
 * When a method changes, check if its parent class implements interfaces.
 * Reports co-implementors so the agent knows this change may need mirroring.
 */
function collectInterfaceContract(
  ws: WorkspaceServices,
  record: FunctionRecord,
  changeType: "signature" | "behavior" | "removal",
): TypeImpactEntry[] {
  const dotIdx = record.name.indexOf(".");
  if (dotIdx <= 0) return [];

  const className = record.name.substring(0, dotIdx);
  const classRecord = ws.index.findByExactName(className).find(r => r.kind === "class");
  if (!classRecord) return [];

  // Check both implements and extends — TS parser stores interfaces in extends
  const parentTypes = [
    ...(classRecord.typeRelationships?.implements ?? []),
    ...(classRecord.typeRelationships?.extends ?? []),
  ];

  const entries: TypeImpactEntry[] = [];
  for (const parentType of parentTypes) {
    const typeNode = ws.typeGraph.getTypeNode(parentType);
    if (!typeNode || typeNode.kind !== "interface") continue;

    const otherImplementors = ws.typeGraph.getImplementors(parentType)
      .filter(id => id !== classRecord.id);

    if (otherImplementors.length > 0) {
      entries.push({
        type: parentType,
        relationship: "interface_contract",
        affected: otherImplementors.map(id => ws.index.getById(id)?.name || id),
        risk: changeType === "signature" ? "high" : "medium",
      });
    }
  }
  return entries;
}

/**
 * When a method on an INTERFACE changes, find all implementing class methods.
 * Reports which concrete implementations must be updated and who calls them.
 */
function collectInterfaceMethodImplementors(
  ws: WorkspaceServices,
  record: FunctionRecord,
  changeType: "signature" | "behavior" | "removal",
  conventions?: LanguageConventions,
): TypeImpactEntry[] {
  const dotIdx = record.name.indexOf(".");
  if (dotIdx <= 0) return [];

  const parentName = record.name.substring(0, dotIdx);
  const methodName = record.name.substring(dotIdx + 1);

  const parentRecord = ws.index.findByExactName(parentName).find(r => r.kind === "interface");
  if (!parentRecord) return [];

  const implementorIds = ws.typeGraph.getImplementors(parentName);
  if (implementorIds.length === 0) return [];

  const entries: TypeImpactEntry[] = [];
  const implMethodRecords: Array<{ function: string; file: string; line_start: number }> = [];
  const implClassIds: string[] = [];

  for (const implId of implementorIds) {
    const sep = implId.indexOf("::");
    if (sep === -1) continue;
    const filePath = implId.slice(0, sep);
    const implClassName = implId.slice(sep + 2);
    const implMethodId = `${filePath}::${implClassName}.${methodName}`;
    const methodRecord = ws.index.getById(implMethodId);
    if (methodRecord) {
      implMethodRecords.push({
        function: methodRecord.name,
        file: methodRecord.filePath,
        line_start: methodRecord.lineStart,
      });
      implClassIds.push(implId);
    }
  }

  if (implMethodRecords.length > 0) {
    entries.push({
      type: parentName,
      relationship: "implementor_methods",
      affected: implMethodRecords,
      risk: changeType === "signature" || changeType === "removal" ? "high" : "medium",
    });
    entries.push(...collectImplementorCallers(ws, parentName, implClassIds, changeType, conventions));
  }

  return entries;
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
    const { callImpact, typeImpact } = analyzeImpact(ws, record, changeType, ctx.conventions);

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
    const { callImpact, typeImpact } = analyzeImpact(ws, record, changeType, ctx.conventions);
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
