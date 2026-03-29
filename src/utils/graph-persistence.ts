import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { IFunctionIndexReader } from "../types/interfaces.js";
import { logger } from "./logger.js";

const GRAPH_VERSION = 2;

export function computeIndexFingerprint(index: IFunctionIndexReader): string {
  const stats = index.getStats();
  const hashes = index.getFileHashes();
  const sorted = Array.from(hashes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const input = sorted.map(([p, h]) => `${p}:${h}`).join("\n");
  const contentHash = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `v${GRAPH_VERSION}|files:${stats.files}|funcs:${stats.functions}|hash:${contentHash}`;
}

export async function saveGraphJson(filePath: string, fingerprint: string, graph: Map<string, unknown>): Promise<void> {
  const data = { version: GRAPH_VERSION, fingerprint, graph: Object.fromEntries(graph) };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data));
}

export async function loadGraphJson(filePath: string, expectedFingerprint: string): Promise<Map<string, any> | null> {
  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data.version !== GRAPH_VERSION) return null;
    if (data.fingerprint !== expectedFingerprint) return null;
    return new Map(Object.entries(data.graph));
  } catch (err) {
    logger.warn({ err, filePath }, "Failed to load graph cache, will rebuild");
    return null;
  }
}
