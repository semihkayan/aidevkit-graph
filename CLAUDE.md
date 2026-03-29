# CLAUDE.md

MCP server that provides codebase graph analysis tools to AI agents. Builds AST index, call graph, type graph, and hybrid semantic search (vector + BM25) for 7 languages.

## Build & Run

```bash
npm run build          # TypeScript → dist/
npm run dev            # Run with tsx (dev mode)
npm test               # vitest
```

The server communicates via MCP stdio protocol — stdout is reserved for MCP, never use console.log. All logging goes to `.code-context/server.log` via pino (see `src/utils/logger.ts`).

## Architecture

Single-process Node.js MCP server. Everything runs in one process — no microservices, no external databases.

### Startup sequence (index.ts)

1. `createServices()` — instantiate all components (composition root)
2. MCP `server.connect()` — establish stdio transport **immediately** (before heavy init)
3. Load AST index from disk cache, refresh stale files
4. Initialize LanceDB, embed if vectors empty
5. Load or build call graph + type graph (cached with fingerprint validation)
6. Start file watcher
7. Set `ready = true` — tools now accept calls

MCP connection happens BEFORE indexing so Claude Code doesn't timeout waiting for handshake.

### Layers

```
index.ts             → MCP shell: registerTool × 13, transport, shutdown
services.ts          → Composition root: ALL concrete instantiation here
tools/               → 13 tool handlers (read-only access via interfaces)
core/                → Business logic behind interfaces
parsers/             → 7 language parsers (tree-sitter wrappers)
utils/               → Config, file I/O, git, logging, SQL escape
scripts/             → CLI tools (init, reindex, setup, check-docstrings)
types/index.ts       → Data types (FunctionRecord, VectorRow, CallGraphEntry, etc.)
types/interfaces.ts  → All interfaces (IFunctionIndexReader, ISearchPipeline, etc.)
```

### Composition root pattern (services.ts)

All concrete class instantiation is in `createServices()`. Tool handlers never import concrete classes — they receive `AppContext` which exposes only interfaces. To swap a component (e.g., LanceDB → Qdrant): change 1 line in `services.ts`.

### Workspace isolation

Multi-workspace projects (monorepos) get separate per-workspace instances: AST index, call graph, type graph, LanceDB table. No cross-workspace relationships. Detection via manifest files (package.json, go.mod, etc.) in `core/workspace-detector.ts`.

## Key patterns

### Tool handler pattern

Every tool handler follows the same structure:

```typescript
export async function handleToolName(args: { ... }, ctx: AppContext) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;
  // ... tool logic using ws.index, ws.callGraph, ws.search, etc.
  return textResponse(result);
}
```

Shared utilities in `tools/tool-utils.ts`: `resolveWorkspaceOrError`, `resolveFunctionOrError`, `textResponse`, `errorResponse`.

### Parser pattern

Each language has a config file (e.g., `parsers/python.ts`) exporting a `TreeSitterLanguageConfig` with 5 extract functions:

- `extractFunctions(rootNode, filePath)` → `RawFunctionInfo[]`
- `extractCalls(rootNode, lineStart, lineEnd)` → `RawCallInfo[]`
- `extractImports(rootNode, filePath)` → `RawImportInfo[]`
- `extractTypeRelationships(rootNode, filePath)` → `RawTypeRelationship[]`
- `extractDocstring(node)` → `string | null`

AST walking uses `walkNodes(node, types)` from `parsers/ast-utils.ts`. All parsers use imperative tree walking, not tree-sitter query strings.

### Path conventions

- **FunctionRecord.id**: `"relative/path.ts::FunctionName"` (workspace-relative)
- **FunctionRecord.filePath**: workspace-relative (e.g., `"src/core/search.ts"`)
- **Module path**: directory part of filePath, sourceRoot stripped (e.g., `"core"` not `"src/core"`)
- **AST index keys**: always relative paths
- **File watcher / staleness checker**: work with absolute paths, converted at boundaries

### Index data flow

```
File change → FileWatcher (debounce 500ms, mutex, min 2s interval)
  → FunctionIndex.updateFiles() — parse files, update in-memory index
  → reembedFunctions() — embed changed functions via Ollama, upsert to LanceDB
  → CallGraphWriter.buildForFiles() — incremental call graph rebuild
  → TypeGraphWriter.buildForFiles() — incremental type graph rebuild
  → saveToDisk() — persist AST cache + graph cache
```

### Graph persistence

Call graph and type graph are cached as JSON in `.code-context/`. Cache validity is checked via index fingerprint (SHA-256 of all file hashes + file/function counts). If fingerprint mismatches → full rebuild. See `utils/graph-persistence.ts`.

### LanceDB specifics

- Dynamic import: `await import("@lancedb/lancedb")` — native module, lazy loaded
- Float32Array → regular arrays for storage (LanceDB doesn't accept typed arrays)
- FTS index on `chunkText` column — may fail in some versions, wrapped in try/catch
- Tag filtering uses delimiter format: `",tag1,tag2,"` with `LIKE '%,tag1,%'` for exact matching
- SQL values escaped via `utils/sql-escape.ts`

### tree-sitter specifics

- Loaded via `createRequire(import.meta.url)` — ESM project using CJS native modules
- All grammar packages pinned to `^0.23.0`, core to `^0.25.0`
- `SyntaxNode` typed as `any` — no TS types for native tree-sitter

## Adding a new language parser

1. Create `src/parsers/{language}.ts` implementing the 5 extract functions
2. Export a `TreeSitterLanguageConfig`
3. Add to `PARSER_CONFIGS` in `src/parsers/registry.ts`
4. Add extensions to default config in `src/utils/config.ts`
5. Add `tree-sitter-{language}` dependency + override in `package.json`

## Adding a new tool

1. Add Zod schema in `src/tools/schemas.ts`
2. Create handler in `src/tools/{name}.ts` following the handler pattern
3. Register in `src/index.ts` with `server.registerTool()`
4. Tool descriptions must tell the agent WHEN and WHY to use the tool, not just what it does

## Common gotchas

- **stdout is MCP protocol** — never `console.log()`, always use `logger` from `utils/logger.ts`
- **Relative vs absolute paths** — `FunctionIndex` stores relative, `globSourceFiles` returns absolute, `FileWatcher` receives absolute. Convert at boundaries.
- **tree-sitter CJS in ESM** — use `createRequire()`, never dynamic `import()` for tree-sitter
- **LanceDB FTS** — `Index.fts()` may throw in some versions. Always try/catch.
- **`ready` flag** — tools return `NOT_READY` error until initialization completes. Check via `tool-utils.ts:checkReady()`.
