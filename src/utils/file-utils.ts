import { readFile as fsReadFile, readdir, stat as fsStat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import ignore from "ignore";
import type { Config } from "../types/interfaces.js";

export { existsSync };

export async function readFile(filePath: string, encoding: BufferEncoding = "utf-8"): Promise<string> {
  return fsReadFile(filePath, { encoding });
}

export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return fsReadFile(filePath);
}

export async function globSourceFiles(projectRoot: string, config: Config): Promise<string[]> {
  const allExtensions = Object.values(config.parser.languages).flat();
  const pattern = `**/*{${allExtensions.join(",")}}`;

  const ig = ignore.default().add(config.parser.ignore);

  const files = await glob(pattern, {
    cwd: projectRoot,
    absolute: false,
    nodir: true,
    dot: false,
  });

  const filtered = files.filter(f => !ig.ignores(f));

  // File size check
  const maxBytes = (config.indexing?.maxFileSizeKb || 500) * 1024;
  const valid: string[] = [];
  for (const f of filtered) {
    const fullPath = path.join(projectRoot, f);
    try {
      const stats = await fsStat(fullPath);
      if (stats.size <= maxBytes) valid.push(fullPath);
    } catch {
      // File disappeared — skip
    }
  }
  return valid;
}

// Generic source root prefixes (language-specific roots come from LanguageConventions)
const GENERIC_SOURCE_ROOTS = [
  "src/",
  "lib/",
  "app/",
];

// Compute module path from file path
export function computeModule(filePath: string, projectRoot: string, sourceRoot?: string, languageSourceRoots?: readonly string[]): string {
  let relative = projectRoot ? path.relative(projectRoot, filePath) : filePath;
  // Normalize to forward slashes for consistent matching
  relative = relative.replace(/\\/g, "/");

  // Strip explicit sourceRoot if configured
  if (sourceRoot && relative.startsWith(sourceRoot + "/")) {
    relative = relative.slice(sourceRoot.length + 1);
  } else if (!sourceRoot) {
    // Auto-detect: strip source root prefixes (language-specific first, then generic)
    const allRoots = [...(languageSourceRoots || []), ...GENERIC_SOURCE_ROOTS];
    for (const prefix of allRoots) {
      if (relative.startsWith(prefix)) {
        relative = relative.slice(prefix.length);
        break;
      }
    }
  }

  // Module = directory path (without filename)
  const dir = path.dirname(relative);
  return dir === "." ? "" : dir.replace(/\\/g, "/");
}

// Detect language from file extension
export function detectLanguage(filePath: string, languages: Record<string, string[]>): string | null {
  for (const [lang, exts] of Object.entries(languages)) {
    if (exts.some(ext => filePath.endsWith(ext))) return lang;
  }
  return null;
}
