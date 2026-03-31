import { existsSync } from "node:fs";
import path from "node:path";
import type { IImportResolver, ILanguageParser } from "../types/interfaces.js";
import type { ImportMap } from "../types/index.js";

export class ImportResolver implements IImportResolver {
  constructor(private parsers: ILanguageParser[]) {}

  resolveImports(source: string, filePath: string, projectRoot: string): ImportMap {
    const parser = this.parsers.find(p => p.canParse(filePath));
    if (!parser) return new Map();

    const rawImports = parser.parseImports(source, filePath);
    const result: ImportMap = new Map();

    for (const imp of rawImports) {
      const resolved = this.resolveImportPath(parser, imp.modulePath, filePath, projectRoot);
      result.set(imp.importedName, { module: imp.modulePath, resolvedPath: resolved });
    }

    return result;
  }

  private resolveImportPath(
    parser: ILanguageParser,
    modulePath: string,
    fromFile: string,
    projectRoot: string,
  ): string | null {
    // Parser says external → skip
    if (parser.isExternalImport(modulePath)) return null;

    // Delegate to parser's language-specific resolver
    const pathExists = (wsRelPath: string) =>
      existsSync(path.join(projectRoot, wsRelPath));
    return parser.resolveImportPath(modulePath, fromFile, projectRoot, pathExists);
  }
}
