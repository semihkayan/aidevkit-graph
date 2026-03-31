import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IStalenessChecker } from "../types/interfaces.js";
import { globSourceFiles } from "../utils/file-utils.js";
import type { Config } from "../types/interfaces.js";

export class HashBasedStalenessChecker implements IStalenessChecker {
  constructor(private config: Config) {}

  async getChangedFiles(
    projectRoot: string,
    knownHashes: Map<string, string>,
    knownMtimes: Map<string, number>,
  ): Promise<{ changed: string[]; mtimes: Map<string, number> }> {
    // globSourceFiles returns ABSOLUTE paths
    const allAbsFiles = await globSourceFiles(projectRoot, this.config);
    const changed: string[] = [];
    const updatedMtimes = new Map<string, number>();

    // Convert known data (relative keys) to absolute for comparison
    const knownAbsolute = new Map<string, string>();
    const mtimeAbsolute = new Map<string, number>();
    for (const [relPath, hash] of knownHashes) {
      const abs = path.join(projectRoot, relPath);
      knownAbsolute.set(abs, hash);
      const mt = knownMtimes.get(relPath);
      if (mt != null) mtimeAbsolute.set(abs, mt);
    }

    // Detect changed/new files
    for (const absPath of allAbsFiles) {
      const known = knownAbsolute.get(absPath);
      if (!known) {
        // New file
        changed.push(absPath);
        continue;
      }

      // mtime early exit: if mtime unchanged, content is definitely unchanged
      const fileStat = await stat(absPath);
      const currentMtime = fileStat.mtimeMs;
      const knownMtime = mtimeAbsolute.get(absPath);
      if (knownMtime != null && currentMtime === knownMtime) continue;

      // mtime changed — verify with hash
      const newHash = await this.computeHash(absPath);
      if (known !== newHash) {
        changed.push(absPath);
      }
      // Store updated mtime regardless (even if hash matches, mtime was different)
      updatedMtimes.set(absPath, currentMtime);
    }

    // Detect deleted files
    const allAbsSet = new Set(allAbsFiles);
    for (const absPath of knownAbsolute.keys()) {
      if (!allAbsSet.has(absPath)) {
        changed.push(absPath); // FunctionIndex.updateFiles handles deletion
      }
    }

    return { changed, mtimes: updatedMtimes };
  }

  async computeHash(filePath: string): Promise<string> {
    if (!existsSync(filePath)) return "";
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  }
}
