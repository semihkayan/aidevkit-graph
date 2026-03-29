# CLAUDE.md

## What this project is

MCP server that gives AI agents cheap, precise code understanding. Instead of dumping entire files into context, the agent queries local indexes (AST, call graph, type graph, vector search) and gets back only what it needs. All indexing is local and live — file watcher keeps everything current as code changes.

Goal: agents work with code at lower token cost and higher quality. Every feature serves this.

## Build & Run

```bash
npm run build          # TypeScript → dist/
npm run dev            # Run with tsx (dev mode)
npm test               # vitest
```

## Architecture

Single-process Node.js MCP server. stdout is reserved for MCP protocol — never `console.log()`, use `logger` from `utils/logger.ts` (writes to `.code-context/server.log`).

### Layers

```
index.ts             → MCP shell: registerTool × 13, transport, shutdown
services.ts          → Composition root: ALL concrete instantiation here
tools/               → 13 tool handlers (thin orchestrators, interface-only deps)
core/                → Business logic behind interfaces
parsers/             → 7 language parsers (tree-sitter wrappers)
utils/               → Config, file I/O, git, logging, SQL escape
scripts/             → CLI tools (init, reindex, setup, check-docstrings)
types/index.ts       → Data types (FunctionRecord, VectorRow, CallGraphEntry, etc.)
types/interfaces.ts  → All interfaces
```

### Key design decisions

- **MCP connects before indexing** — `server.connect()` happens first, heavy init runs after. Otherwise Claude Code times out waiting for MCP handshake.
- **`ready` flag** — tools return `NOT_READY` error until init completes (`tool-utils.ts:checkReady()`).
- **ReindexOrchestrator** (`core/reindex-orchestrator.ts`) — single place for all reindex workflows (full, incremental, file-level, watcher). Tool handler and watcher both delegate to it.
- **Graph persistence** — call graph and type graph cached as JSON in `.code-context/`. Validated via index fingerprint (SHA-256 of file hashes). Mismatch → full rebuild.
- **Workspace isolation** — monorepo workspaces get separate AST index, call graph, type graph, LanceDB table. No cross-workspace relationships.

### Composition root (services.ts)

All concrete class instantiation is in `createServices()`. Tool handlers never import concrete classes — they receive `AppContext` which exposes only interfaces. To swap a component (e.g., LanceDB → Qdrant): change 1 line in `services.ts`.

## Rules

### Tool handlers

- **Never import from `core/` or `utils/`** — depend only on `AppContext` and `WorkspaceServices` interfaces
- **Keep thin** — orchestration logic belongs in services (e.g., `ReindexOrchestrator`), not handlers
- **Always use `textResponse()`** for responses
- **Follow the pattern:**

```typescript
export async function handleToolName(args: { ... }, ctx: AppContext) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;
  // ... use ws.index, ws.callGraph, ctx.reindex, ctx.git, etc.
  return textResponse(result);
}
```

### Path conventions

- **FunctionRecord.id**: `"filePath::functionName"` (workspace-relative). `call-graph.ts:removeByFile` relies on this prefix format — don't change without updating graph cleanup.
- **FunctionRecord.filePath**: workspace-relative (e.g., `"src/core/search.ts"`)
- **Module path**: directory part of filePath, sourceRoot stripped (e.g., `"core"` not `"src/core"`)
- **Boundary rule**: `FunctionIndex` stores relative, `globSourceFiles` returns absolute, `FileWatcher` receives absolute. Convert at boundaries.

## Adding things

### New language parser

1. Create `src/parsers/{language}.ts` — implement 5 extract functions (`extractFunctions`, `extractCalls`, `extractImports`, `extractTypeRelationships`, `extractDocstring`)
2. Export a `TreeSitterLanguageConfig`
3. Add to `PARSER_CONFIGS` in `src/parsers/registry.ts`
4. Add extensions to default config in `src/utils/config.ts`
5. Add `tree-sitter-{language}` dependency + override in `package.json`

### New tool

1. Add Zod schema in `src/tools/schemas.ts` — every param needs `.describe()` with examples
2. Create handler in `src/tools/{name}.ts` following the handler pattern
3. Register in `src/index.ts` — description must say WHEN and WHY to use the tool
4. Business logic goes in a service, not the handler

### New service

1. Define interface in `src/types/interfaces.ts`
2. Create implementation in `src/core/{name}.ts`
3. Add to `AppContext` or `WorkspaceServices` in `interfaces.ts`
4. Wire concrete class in `src/services.ts`

## Gotchas

- **tree-sitter CJS in ESM** — use `createRequire(import.meta.url)`, never dynamic `import()` for tree-sitter
- **LanceDB FTS** — `Index.fts()` may throw in some versions. Always try/catch.
- **LanceDB tag filtering** — delimiter format `",tag1,tag2,"` with `LIKE '%,tag1,%'` for exact match. Without leading/trailing commas, `LIKE '%pay%'` false-matches `payment`.
- **LanceDB vectors** — `Float32Array` must be converted to regular arrays before storage.
- **Embedding failures** — failed batches are skipped (not zero-filled). Unembedded functions get retried on next reindex.
