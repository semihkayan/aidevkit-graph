import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Config } from "../types/interfaces.js";

const ConfigSchema = z.object({
  projectRoot: z.string().default("."),
  workspaces: z.array(z.string()).optional(),
  embedding: z.object({
    model: z.string().default("qwen3-embedding:0.6b"),
    ollamaUrl: z.string().default("http://localhost:11434"),
    dimensions: z.number().default(1024),
    batchSize: z.number().default(64),
    instruction: z.string().optional().default("Given a code search query, retrieve relevant code snippets that match the query"),
  }).default({}),
  parser: z.object({
    languages: z.record(z.array(z.string())).default({
      python: [".py"],
      typescript: [".ts", ".tsx"],
      javascript: [".js", ".jsx"],
      go: [".go"],
      rust: [".rs"],
      java: [".java"],
      csharp: [".cs"],
    }),
    ignore: z.array(z.string()).default([
      "node_modules/**",
      "**/__pycache__/**",
      "**/dist/**",
      "**/build/**",
      "**/*.min.js",
      "**/*.generated.*",
      "**/vendor/**",
      "**/.git/**",
    ]),
    sourceRoot: z.string().optional(),
  }).default({}),
  moduleSummary: z.object({
    compactThreshold: z.number().default(20),
    filesOnlyThreshold: z.number().default(50),
    maxTokenBudget: z.number().default(4000),
  }).default({}),
  search: z.object({
    rrfK: z.number().default(60),
    expandCamelCase: z.boolean().default(true),
    exactNameBoost: z.boolean().default(true),
    density: z.object({
      enabled: z.boolean().default(true),
      floor: z.number().min(0).max(1).default(0.65),
      ceiling: z.number().min(0.5).max(2).default(1.05),
      accessorPenalty: z.number().min(0).max(1).default(0.55),
      constructorPenalty: z.number().min(0).max(1).default(0.60),
      testFilePenalty: z.number().min(0).max(1).default(0.75),
      weights: z.object({
        bodySize: z.number().default(0.35),
        docstring: z.number().default(0.10),
        docstringRichness: z.number().default(0.10),
        paramCount: z.number().default(0.15),
        centrality: z.number().default(0.15),
        visibility: z.number().default(0.10),
        kind: z.number().default(0.05),
      }).default({}),
    }).default({}),
  }).default({}),
  indexing: z.object({
    parallelWorkers: z.number().default(4),
    maxFileSizeKb: z.number().default(500),
    maxChunkTokens: z.number().default(2000),
  }).default({}),
  watcher: z.object({
    debounceMs: z.number().default(500),
    minIntervalMs: z.number().default(2000),
  }).default({}),
});

export async function loadConfig(projectRoot?: string): Promise<Config> {
  const root = path.resolve(projectRoot || process.env.GRAPH_PROJECT_ROOT || process.cwd());
  const configPath = path.join(root, ".code-context", "config.yaml");

  let rawConfig: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, "utf-8");
      rawConfig = parseYaml(content) || {};
    } catch {
      // Invalid YAML — use defaults
    }
  }

  const parsed = ConfigSchema.parse({ ...rawConfig, projectRoot: root });
  const config = parsed as Config;

  // Auto-detect sourceRoot if not explicitly configured
  if (!config.parser.sourceRoot) {
    const commonRoots = ["src", "lib", "app"];
    for (const candidate of commonRoots) {
      if (existsSync(path.join(root, candidate))) {
        config.parser.sourceRoot = candidate;
        break;
      }
    }
  }

  // Merge .gitignore patterns into ignore list — if it's gitignored, the agent doesn't need it indexed
  const gitignorePath = path.join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = await readFile(gitignorePath, "utf-8");
      const patterns = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"));
      // Deduplicate: only add patterns not already in the ignore list
      const existing = new Set(config.parser.ignore);
      for (const pattern of patterns) {
        if (!existing.has(pattern)) {
          config.parser.ignore.push(pattern);
        }
      }
    } catch {
      // .gitignore unreadable — skip silently
    }
  }

  return config;
}
