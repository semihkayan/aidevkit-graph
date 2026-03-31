---
name: test-harness
description: >
  Test codeweave-mcp tools against any project using TestHarness.
  Use this whenever verifying tool behavior, testing a code change, or running
  custom assertions — e.g. "test the harness", "run tests against X project",
  "does semantic_search work correctly".
---

# codeweave-mcp Test Harness

`TestHarness` in `src/test-harness.ts`. Write a temp `.ts` file and run with `npx tsx <file>` from the project root.

## Modes

```typescript
import { TestHarness } from "./src/test-harness.js";

const h = await TestHarness.setup("/absolute/path/to/project");

// All built-in tests (~64 tests, all 8 tools)
await h.testAll();

// Single tool
await h.test("semantic_search");

// Custom assertions
await h.run([
  {
    tool: "semantic_search",
    args: { query: "user authentication", top_k: 5 },
    label: "search: auth",
    assert: d => d?.results?.length > 0 || "no results",
  },
]);

// Manual call — returns parsed JSON
const data = await h.call("get_index_status", { workspace: "wordbox-api" });

await h.close(); // always close
```

## Tool params & response shapes

### `semantic_search`
**Params:** `query` (string, required), `workspace?`, `scope?`, `top_k?` (default 10), `tags_filter?` (string[]), `side_effects_filter?` (string[])
**Response:** `{ results, total_indexed, search_mode, warning? }`
**Each result:** `{ function, file, module, signature, summary, tags, score, line_start, line_end, workspace? }`

### `get_module_summary`
**Params:** `module` (string, required), `workspace?`, `file?`, `detail?` ("auto"|"full"|"compact"|"files_only")
**Response:** `{ module, mode, total, files, test_files_excluded?, workspace? }` — or `{ module, workspaces[] }` for multi-workspace
**Error:** `{ error: "MODULE_NOT_FOUND", message, suggestion? }`

### `get_function_source`
**Params:** `function` (string, required), `workspace?`, `module?`, `context_lines?` (default 0)
**Single match:** `{ function, file, workspace?, language, line_start, line_end, source, context_before?, context_after?, class_context? }`
**Multi match:** `{ matches[], note }`
**Error:** `{ error: "FUNCTION_NOT_FOUND", message, suggestion? }`

### `get_dependencies`
**Params:** `function` (string, required), `workspace?`, `module?`
**Response:** `{ function, file, workspace?, calls[], ast_only?, docstring_only?, unresolved?, caveat }`
**Each call:** `{ target, file, line, source, resolved, note? }`
**Error:** `{ error: "FUNCTION_NOT_FOUND", message, suggestion? }`

### `get_impact_analysis`
**Params:** `function` (string, required), `workspace?`, `module?`, `change_type?` ("signature"|"behavior"|"removal")
**Response:** `{ function, file, workspace?, change_type, call_impact[], type_impact[], total_affected, caveat }`
**Error:** `{ error: "FUNCTION_NOT_FOUND", message, suggestion? }`

### `get_stale_docstrings`
**Params:** `workspace?`, `scope?`, `check_type?` ("all"|"deps"|"tags"|"missing"), `top_k?`
**Response:** `{ total_issues, by_severity: { warning, info }, missing_docstrings_summary?, issues[], note? }`
**Each issue:** `{ function, file, line, issue, severity, workspace? }`

### `reindex`
**Params:** `workspace?`, `files?` (string[]), `force?` (default false)
**Response:** `{ workspace?, status, mode, ast_index: { files, functions, classes }, embedded, vector_store_rows, elapsed_ms }`

### `get_index_status`
**Params:** `workspace?`
**Single:** `{ status, workspace, ast_index, vector_store, call_graph, type_graph, embedding_available, docstring_coverage, languages }`
**Multi:** `{ status, workspaces[], embedding_available, model }`

## assert

Receives parsed JSON response. Return `true` = pass, string = fail reason.

## Multi-workspace

Pass `workspace` as the short name (not full path): `{ workspace: "wordbox-api" }`

## Notes

- `setup()` loads from cache — fast after first run.
- `testAll()` includes a force-full reindex at the end — slow on large projects.
