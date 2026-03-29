import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { IImportResolver, ILanguageParser } from "../types/interfaces.js";
import type { ImportMap } from "../types/index.js";

export class ImportResolver implements IImportResolver {
  private maxBarrelDepth = 5;
  private javaSourceRootsCache = new Map<string, string[]>(); // Keyed by projectRoot

  constructor(private parsers: ILanguageParser[]) {}

  resolveImports(source: string, filePath: string, projectRoot: string): ImportMap {
    const parser = this.parsers.find(p => p.canParse(filePath));
    if (!parser) return new Map();

    const rawImports = parser.parseImports(source, filePath);
    const result: ImportMap = new Map();

    for (const imp of rawImports) {
      const resolved = this.resolveImportPath(imp.modulePath, filePath, projectRoot);
      result.set(imp.importedName, { module: imp.modulePath, resolvedPath: resolved });
    }

    return result;
  }

  private resolveImportPath(modulePath: string, fromFile: string, projectRoot: string): string | null {
    // 1. Relative path (./foo, ../bar) — TS/JS
    if (modulePath.startsWith(".")) {
      const dir = path.dirname(path.join(projectRoot, fromFile));
      return this.resolveRelative(dir, modulePath, projectRoot);
    }

    // 2. Python dot-notation
    if (fromFile.endsWith(".py") && !modulePath.startsWith(".")) {
      return this.resolvePythonImport(modulePath, projectRoot);
    }

    // 3. Java fully-qualified import (com.wordbox.streak.domain.model.UserStreak)
    if (fromFile.endsWith(".java") && modulePath.includes(".") && !modulePath.startsWith("java.") && !modulePath.startsWith("javax.") && !modulePath.startsWith("org.springframework") && !modulePath.startsWith("org.junit") && !modulePath.startsWith("org.mockito") && !modulePath.startsWith("org.slf4j") && !modulePath.startsWith("org.hibernate") && !modulePath.startsWith("jakarta.")) {
      return this.resolveJavaImport(modulePath, projectRoot);
    }

    // 4. C# using — namespace-based, no direct file mapping
    // 5. Go — package path
    // 6. Rust — crate path

    return null;
  }

  // === Java: com.wordbox.streak.domain.model.UserStreak → src/main/java/.../UserStreak.java ===
  private resolveJavaImport(fqcn: string, projectRoot: string): string | null {
    // Convert dots to path separators
    const javaPath = fqcn.replace(/\./g, "/") + ".java";

    // Try common Java source roots
    const sourceRoots = this.getJavaSourceRoots(projectRoot);
    for (const srcRoot of sourceRoots) {
      const candidate = path.join(srcRoot, javaPath);
      if (existsSync(candidate)) {
        return path.relative(projectRoot, candidate);
      }
    }

    // Direct path from project root
    const direct = path.join(projectRoot, javaPath);
    if (existsSync(direct)) return javaPath;

    return null;
  }

  private getJavaSourceRoots(projectRoot: string): string[] {
    const cached = this.javaSourceRootsCache.get(projectRoot);
    if (cached) return cached;

    const candidates = [
      path.join(projectRoot, "src/main/java"),
      path.join(projectRoot, "src/test/java"),
      path.join(projectRoot, "src"),
    ];

    const roots = candidates.filter(d => existsSync(d));
    this.javaSourceRootsCache.set(projectRoot, roots);
    return roots;
  }

  // === Python: payments.stripe_client → payments/stripe_client.py ===
  private resolvePythonImport(modulePath: string, projectRoot: string): string | null {
    const pyPath = modulePath.replace(/\./g, "/");
    const candidates = [
      pyPath + ".py",
      pyPath + "/__init__.py",
    ];
    for (const c of candidates) {
      if (existsSync(path.join(projectRoot, c))) return c;
    }
    return null;
  }

  // === Relative path resolution (TS/JS) ===
  private resolveRelative(fromDir: string, modulePath: string, projectRoot: string): string | null {
    const base = path.resolve(fromDir, modulePath);

    // Direct file exists (e.g., importing a .json or exact path)
    if (existsSync(base)) return path.relative(projectRoot, base);

    // ESM convention: TS files import with .js extension but actual file is .ts
    // e.g., import from "./tool-utils.js" → actual file is ./tool-utils.ts
    if (base.endsWith(".js") || base.endsWith(".jsx")) {
      const tsBase = base.replace(/\.jsx?$/, "");
      const tsExtensions = [".ts", ".tsx", ".js", ".jsx"];
      for (const ext of tsExtensions) {
        const candidate = tsBase + ext;
        if (existsSync(candidate)) return path.relative(projectRoot, candidate);
      }
    }

    // No extension — try appending common extensions
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs"];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (existsSync(candidate)) return path.relative(projectRoot, candidate);
    }

    // Barrel/index resolution
    return this.resolveBarrel(base, projectRoot, new Set(), 0);
  }

  private resolveBarrel(
    dirPath: string, projectRoot: string,
    visited: Set<string>, depth: number
  ): string | null {
    if (depth >= this.maxBarrelDepth) return null;
    if (visited.has(dirPath)) return null;
    visited.add(dirPath);

    const indexFiles = ["index.ts", "index.tsx", "index.js", "index.jsx"];
    for (const indexFile of indexFiles) {
      const candidate = path.join(dirPath, indexFile);
      if (existsSync(candidate)) return path.relative(projectRoot, candidate);
    }

    return null;
  }
}
