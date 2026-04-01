import { createRequire } from "node:module";
import type { ILanguageParser } from "../types/interfaces.js";
import type { RawFunctionInfo, RawCallInfo, RawImportInfo, RawTypeRelationship } from "../types/index.js";

const require = createRequire(import.meta.url);

// tree-sitter types (native module, no TS types)
type SyntaxNode = any;
type Tree = any;
type Parser = any;

export interface TreeSitterLanguageConfig {
  grammar: any;
  extensions: string[];
  extractFunctions(rootNode: SyntaxNode, filePath: string): RawFunctionInfo[];
  extractCalls(rootNode: SyntaxNode, lineStart: number, lineEnd: number): RawCallInfo[];
  extractImports(rootNode: SyntaxNode, filePath: string): RawImportInfo[];
  extractDocstring(node: SyntaxNode): string | null;
  extractTypeRelationships(rootNode: SyntaxNode, filePath: string): RawTypeRelationship[];
  extractLocalVariables?(rootNode: SyntaxNode, lineStart: number, lineEnd: number): Array<{ name: string; type: string }>;

  // Language-specific metadata (optional — aggregated across all configs at startup)
  testDecorators?: string[];
  testImportPrefixes?: string[];
  noiseTargets?: string[];
  builtinMethods?: string[];
  noisePatterns?: RegExp[];

  // Language conventions (optional — aggregated into LanguageConventions at startup)
  selfKeywords?: string[];
  constructorNames?: string[];
  returnTypePattern?: RegExp;
  sourceRoots?: string[];
  workspaceManifests?: string[];
  workspaceManifestExtensions?: string[];
  indexFileNames?: string[];

  // Import resolution (optional — called by ImportResolver per-file)
  resolveImportPath?(
    modulePath: string,
    fromFile: string,
    projectRoot: string,
    pathExists: (workspaceRelativePath: string) => boolean,
  ): string | null;
  isExternalImport?(modulePath: string): boolean;
}

export class TreeSitterParser implements ILanguageParser {
  readonly extensions: string[];
  private parser: Parser;

  constructor(private config: TreeSitterLanguageConfig) {
    this.extensions = config.extensions;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ParserClass = require("tree-sitter");
    this.parser = new ParserClass();
    this.parser.setLanguage(config.grammar);
  }

  canParse(filePath: string): boolean {
    return this.extensions.some(ext => filePath.endsWith(ext));
  }

  private parse(source: string): Tree {
    return this.parser.parse(source);
  }

  parseFunctions(source: string, filePath: string): RawFunctionInfo[] {
    const tree = this.parse(source);
    return this.config.extractFunctions(tree.rootNode, filePath);
  }

  parseCalls(source: string, lineStart: number, lineEnd: number): RawCallInfo[] {
    const tree = this.parse(source);
    return this.config.extractCalls(tree.rootNode, lineStart, lineEnd);
  }

  parseImports(source: string, filePath: string): RawImportInfo[] {
    const tree = this.parse(source);
    return this.config.extractImports(tree.rootNode, filePath);
  }

  parseTypeRelationships(source: string, filePath: string): RawTypeRelationship[] {
    const tree = this.parse(source);
    return this.config.extractTypeRelationships(tree.rootNode, filePath);
  }

  parseLocalVariables(source: string, lineStart: number, lineEnd: number): Array<{ name: string; type: string }> {
    if (!this.config.extractLocalVariables) return [];
    const tree = this.parse(source);
    return this.config.extractLocalVariables(tree.rootNode, lineStart, lineEnd);
  }

  // Metadata getters — used by aggregation functions in registry.ts
  get testDecorators(): string[] { return this.config.testDecorators ?? []; }
  get testImportPrefixes(): string[] { return this.config.testImportPrefixes ?? []; }
  get noiseTargets(): string[] { return this.config.noiseTargets ?? []; }
  get builtinMethods(): string[] { return this.config.builtinMethods ?? []; }
  get noisePatterns(): RegExp[] { return this.config.noisePatterns ?? []; }

  // Convention getters — aggregated into LanguageConventions at startup
  get selfKeywords(): string[] { return this.config.selfKeywords ?? []; }
  get constructorNames(): string[] { return this.config.constructorNames ?? []; }
  get returnTypePattern(): RegExp | null { return this.config.returnTypePattern ?? null; }
  get sourceRoots(): string[] { return this.config.sourceRoots ?? []; }
  get workspaceManifests(): string[] { return this.config.workspaceManifests ?? []; }
  get workspaceManifestExtensions(): string[] { return this.config.workspaceManifestExtensions ?? []; }
  get indexFileNames(): string[] { return this.config.indexFileNames ?? []; }

  // Import resolution — pass-through to config
  resolveImportPath(
    modulePath: string, fromFile: string, projectRoot: string,
    pathExists: (workspaceRelativePath: string) => boolean,
  ): string | null {
    return this.config.resolveImportPath?.(modulePath, fromFile, projectRoot, pathExists) ?? null;
  }

  isExternalImport(modulePath: string): boolean {
    return this.config.isExternalImport?.(modulePath) ?? false;
  }
}
