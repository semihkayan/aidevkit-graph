import type { FunctionRecord } from "../types/index.js";
import { truncateToTokens } from "../utils/token-estimator.js";

const BODY_REPEAT_MAX_CHARS = 250;

export interface ChunkConfig {
  expandCamelCase: boolean;
  maxChunkTokens?: number;
  returnTypePatterns?: readonly RegExp[];
}

/**
 * Build a text chunk for embedding. Every token should carry semantic meaning.
 * No labels, no file paths, no redundancy — just identity, signature, and content.
 *
 * @param classContext - Parent class docstring summary for method records.
 *   Caller resolves this from the index; chunk-builder stays index-agnostic.
 */
export function buildChunk(
  record: FunctionRecord,
  config: ChunkConfig,
  classContext?: string | null,
  callTargets?: string[] | null,
): string {
  const expand = config.expandCamelCase ? expandIdentifiers : (s: string) => s;
  const parts: string[] = [];

  if (record.kind === "class") {
    // Class: name, inheritance, method names (expanded for keyword matching)
    let classLine = `class ${expand(record.name)}`;
    if (record.classInfo?.inherits?.length) {
      classLine += `, extends ${record.classInfo.inherits.join(", ")}`;
    }
    if (record.classInfo?.implements?.length) {
      classLine += `, implements ${record.classInfo.implements.join(", ")}`;
    }
    if (record.classInfo?.methods?.length) {
      const methods = record.classInfo.methods.map(m => expand(m)).join(", ");
      classLine += `, ${record.classInfo.methods.length} methods: ${methods}`;
    }
    parts.push(classLine);
  } else if (record.kind === "interface") {
    parts.push(`interface ${expand(record.name)}`);
  } else {
    // Function/method: expanded qualified name + class context + raw signature
    parts.push(expand(record.name));
    if (classContext && record.kind === "method") {
      parts.push(classContext);
    }
    parts.push(record.signature);
  }

  // Decorators/annotations: human-written semantic labels (@RestController, @EventListener, etc.)
  if (record.decorators?.length) {
    parts.push(record.decorators.join(" "));
  }

  // Docstring content (no labels — the content speaks for itself)
  if (record.docstring) {
    if (record.docstring.body) {
      parts.push(record.docstring.body);
    }
    if (record.docstring.tags.length > 0) {
      parts.push(record.docstring.tags.join(", "));
    }
    if (record.docstring.deps.length > 0) {
      parts.push(`depends on: ${record.docstring.deps.join(", ")}`);
    }
    if (record.docstring.sideEffects.length > 0) {
      parts.push(`effects: ${record.docstring.sideEffects.join(", ")}`);
    }
  } else if (record.kind !== "class" && record.kind !== "interface") {
    // Docstring-free: extract param/return info from signature (no labels)
    const paramInfo = extractParamInfo(record.signature);
    if (paramInfo) parts.push(paramInfo);
    const returnInfo = extractReturnType(record.signature, config.returnTypePatterns);
    if (returnInfo) parts.push(returnInfo);
  }

  // Call targets as implicit deps — only when docstring doesn't have curated @deps
  if (!record.docstring?.deps?.length && callTargets?.length) {
    parts.push(`depends on: ${callTargets.join(", ")}`);
  }

  // Reinforcement: repeat key semantic signals for embedding emphasis.
  // Placed last so truncation cuts these first, preserving original content.
  parts.push(expand(record.name));
  if (record.docstring?.tags.length) {
    parts.push(record.docstring.tags.join(", "));
  }
  if (record.docstring?.body && record.docstring.body.length < BODY_REPEAT_MAX_CHARS) {
    parts.push(record.docstring.body);
  }

  let chunk = parts.join("\n");
  if (config.maxChunkTokens && config.maxChunkTokens > 0) {
    chunk = truncateToTokens(chunk, config.maxChunkTokens);
  }
  return chunk;
}

function extractParamInfo(signature: string): string | null {
  const openIdx = signature.indexOf("(");
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < signature.length; i++) {
    if (signature[i] === "(") depth++;
    else if (signature[i] === ")") {
      depth--;
      if (depth === 0) {
        const params = signature.slice(openIdx + 1, i).trim();
        return params || null;
      }
    }
  }
  return null;
}

function extractReturnType(signature: string, patterns?: readonly RegExp[]): string | null {
  if (patterns && patterns.length > 0) {
    for (const pattern of patterns) {
      const match = signature.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }
  // Fallback when no patterns provided
  const match = signature.match(/\)\s*(?:->|:)\s*(.+)$/);
  return match ? match[1].trim() : null;
}

export function expandIdentifiers(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ");
}
