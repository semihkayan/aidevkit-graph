import type { Config, TestDetectionMetadata, NoiseFilterMetadata, LanguageConventions } from "../types/interfaces.js";
import { TreeSitterParser } from "./tree-sitter-parser.js";
import { logger } from "../utils/logger.js";
import { pythonConfig } from "./python.js";
import { typescriptConfig, tsxConfig } from "./typescript.js";
import { javascriptConfig } from "./javascript.js";
import { goConfig } from "./go.js";
import { rustConfig } from "./rust.js";
import { javaConfig } from "./java.js";
import { csharpConfig } from "./csharp.js";

const PARSER_CONFIGS: Record<string, () => import("./tree-sitter-parser.js").TreeSitterLanguageConfig> = {
  python: () => pythonConfig,
  typescript: () => typescriptConfig,
  javascript: () => javascriptConfig,
  go: () => goConfig,
  rust: () => rustConfig,
  java: () => javaConfig,
  csharp: () => csharpConfig,
};

export function createTreeSitterParsers(parserConfig: Config["parser"]): TreeSitterParser[] {
  const parsers: TreeSitterParser[] = [];

  for (const lang of Object.keys(parserConfig.languages)) {
    const configFactory = PARSER_CONFIGS[lang];
    if (configFactory) {
      try {
        parsers.push(new TreeSitterParser(configFactory()));
      } catch (err) {
        logger.warn({ lang, err }, `Failed to initialize parser for ${lang}`);
      }
    }

    // TSX uses a separate grammar from TS — register automatically when typescript is enabled
    if (lang === "typescript") {
      try {
        parsers.push(new TreeSitterParser(tsxConfig));
      } catch (err) {
        logger.warn({ lang: "tsx", err }, "Failed to initialize TSX parser");
      }
    }
  }

  return parsers;
}

// === Metadata Aggregation ===
// Merges per-language metadata from parser configs into unified lookup structures.
// Called once at startup by services.ts.

// Cross-language noise patterns — not language-specific, structural heuristics
const SHARED_NOISE_PATTERNS: RegExp[] = [
  /^(logger|log|logging|console|slog|zap|logrus|Log|_logger|_log|ILogger)\.\w+$/i,
  /^(Assert|Assertions|Expect|expect|assert|assertThat|verify|mock|when|given)\.\w+$/i,
];

export function aggregateTestMetadata(parsers: TreeSitterParser[]): TestDetectionMetadata {
  const allTestDecorators: string[] = [];
  const testImportPrefixesByExtension = new Map<string, string[]>();

  for (const p of parsers) {
    allTestDecorators.push(...p.testDecorators);
    for (const ext of p.extensions) {
      testImportPrefixesByExtension.set(ext, p.testImportPrefixes);
    }
  }

  return { allTestDecorators, testImportPrefixesByExtension };
}

export function aggregateNoiseMetadata(parsers: TreeSitterParser[]): NoiseFilterMetadata {
  const noiseTargets = new Set<string>();
  const builtinMethods = new Set<string>();
  const noisePatterns: RegExp[] = [...SHARED_NOISE_PATTERNS];

  for (const p of parsers) {
    for (const t of p.noiseTargets) noiseTargets.add(t);
    for (const m of p.builtinMethods) builtinMethods.add(m);
    noisePatterns.push(...p.noisePatterns);
  }

  return { noiseTargets, builtinMethods, noisePatterns };
}

export function aggregateLanguageConventions(parsers: TreeSitterParser[]): LanguageConventions {
  const selfKeywords = new Set<string>();
  const constructorNames = new Set<string>();
  const returnTypePatterns: RegExp[] = [];
  const sourceRoots: string[] = [];
  const workspaceManifests: string[] = [];
  const workspaceManifestExtensions: string[] = [];
  const indexFileNames: string[] = [];

  for (const p of parsers) {
    for (const k of p.selfKeywords) selfKeywords.add(k);
    for (const n of p.constructorNames) constructorNames.add(n);
    if (p.returnTypePattern) returnTypePatterns.push(p.returnTypePattern);
    for (const r of p.sourceRoots) { if (!sourceRoots.includes(r)) sourceRoots.push(r); }
    for (const m of p.workspaceManifests) { if (!workspaceManifests.includes(m)) workspaceManifests.push(m); }
    for (const e of p.workspaceManifestExtensions) { if (!workspaceManifestExtensions.includes(e)) workspaceManifestExtensions.push(e); }
    for (const i of p.indexFileNames) { if (!indexFileNames.includes(i)) indexFileNames.push(i); }
  }

  // Sort sourceRoots longest-first for correct prefix stripping
  sourceRoots.sort((a, b) => b.length - a.length);

  return {
    selfKeywords, constructorNames, returnTypePatterns, sourceRoots,
    workspaceManifests, workspaceManifestExtensions, indexFileNames,
  };
}
