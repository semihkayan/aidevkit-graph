import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a relative import path (./foo, ../bar) to a workspace-relative file path.
 * Shared by TS/JS parser configs. Handles ESM .js→.ts remapping and barrel/index resolution.
 */
export function resolveRelativeImport(
  modulePath: string,
  fromFile: string,
  projectRoot: string,
  extensions: string[],
  indexFileNames: string[],
  pathExists: (workspaceRelativePath: string) => boolean,
  maxBarrelDepth = 5,
): string | null {
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const base = path.resolve(fromDir, modulePath);

  // Direct file exists (e.g., importing a .json or exact path)
  if (existsSync(base)) return path.relative(projectRoot, base);

  // ESM convention: TS files import with .js extension but actual file is .ts
  if (base.endsWith(".js") || base.endsWith(".jsx")) {
    const tsBase = base.replace(/\.jsx?$/, "");
    for (const ext of extensions) {
      const candidate = tsBase + ext;
      if (existsSync(candidate)) return path.relative(projectRoot, candidate);
    }
  }

  // No extension — try appending configured extensions
  for (const ext of extensions) {
    const candidate = base + ext;
    if (existsSync(candidate)) return path.relative(projectRoot, candidate);
  }

  // Barrel/index resolution
  return resolveBarrel(base, projectRoot, indexFileNames, new Set(), 0, maxBarrelDepth);
}

function resolveBarrel(
  dirPath: string,
  projectRoot: string,
  indexFileNames: string[],
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): string | null {
  if (depth >= maxDepth) return null;
  if (visited.has(dirPath)) return null;
  visited.add(dirPath);

  for (const indexFile of indexFileNames) {
    const candidate = path.join(dirPath, indexFile);
    if (existsSync(candidate)) return path.relative(projectRoot, candidate);
  }

  return null;
}
