<p align="center">
  <h1 align="center">@codeweave/mcp</h1>
  <p align="center">
    <strong>Give your AI agent structured code understanding — not just file dumps.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@codeweave/mcp"><img src="https://img.shields.io/npm/v/@codeweave/mcp.svg" alt="npm version"></a>
    <a href="https://github.com/semihkayan/codeweave-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@codeweave/mcp.svg" alt="license"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node version">
    <img src="https://img.shields.io/badge/languages-7-blue" alt="supported languages">
    <img src="https://img.shields.io/badge/status-active%20development-orange" alt="status">
  </p>
</p>

---

CodeWeave is an MCP server that gives AI agents cheap, precise code intelligence. Instead of dumping entire files into context, your agent queries local indexes — AST, call graph, type graph, hybrid semantic search — and gets back only what it needs.

**Less tokens. More relevant context. Better decisions.**

The semantic search pipeline is the heart of the system: a 6-stage hybrid engine combining vector embeddings, full-text search, and structural density scoring. Tested extensively across large production codebases — Java monoliths, TypeScript monorepos, Python ML pipelines, Go microservices — with consistently strong retrieval accuracy.

> **Actively developed.** New tools and improvements ship regularly. Contributions and feedback are welcome.

## Quick Start

```bash
cd your-project
npx @codeweave/mcp
```

That's it. The setup wizard handles everything:

1. Installs `@codeweave/mcp` globally
2. Installs [Ollama](https://ollama.com) if needed
3. Downloads the embedding model
4. Configures your MCP client (Claude Code, VS Code)
5. Indexes your project

> **Note:** The first run requires a one-time download of Ollama and the embedding model. This takes a few minutes but only happens once.

Open your project in Claude Code or VS Code and start asking questions.

## Tools

8 tools organized around the code understanding workflow:

### Discover

| Tool | Purpose |
|------|---------|
| `semantic_search` | Search by meaning — finds functions even when you don't know exact names. Hybrid vector + keyword search with density-based reranking. |
| `get_module_summary` | Browse a directory's functions and classes with signatures. Auto-adapts detail level to module size. |

### Read

| Tool | Purpose |
|------|---------|
| `get_function_source` | Get a specific function's source code — no need to read entire files. Supports class context and surrounding lines. |

### Analyze

| Tool | Purpose |
|------|---------|
| `get_dependencies` | What does this function call? Cross-validates AST with docstring `@deps`. Categorizes: confirmed, AST-only, docstring-only, unresolved. |
| `get_impact_analysis` | Blast radius of a change. Combines call graph + type graph. Risk levels: high (direct callers), medium (indirect), low (transitive). |
| `get_stale_docstrings` | Find missing or outdated docstrings. Detects `@deps` drift, missing `@tags`, and undocumented functions. |

### Maintain

| Tool | Purpose |
|------|---------|
| `reindex` | Manually trigger index update. Usually unnecessary — file watcher auto-reindexes on changes. |
| `get_index_status` | Index health dashboard: file/function counts, embedding status, call graph stats, language breakdown. |

## How It Works

```
Source Code
    │
    ▼
tree-sitter AST  ───>  Function Index (in-memory)
                              │
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
              Call Graph  Type Graph  Embeddings
              (JSON)      (JSON)     (LanceDB)
                   │          │          │
                   └──────────┼──────────┘
                              ▼
                       8 MCP Tools  ───>  AI Agent
```

1. **Parse** — tree-sitter extracts every function, class, method, and interface across 7 languages
2. **Embed** — Qwen3-Embedding-0.6B generates vector embeddings for semantic search
3. **Index** — LanceDB stores vectors with BM25 full-text index alongside
4. **Graph** — Call graph tracks who-calls-whom with type-aware resolution; type graph tracks inheritance and implementations
5. **Watch** — File watcher detects changes and incrementally reindexes affected files
6. **Serve** — 8 tools exposed over MCP protocol (stdio), ready before indexing completes

## Semantic Search

The search pipeline is where CodeWeave really shines. It's not just vector similarity — it's a multi-stage system designed to surface the most *relevant* and *important* code:

**6-Stage Pipeline:**

1. **Exact name match** — Fast path for known function names (score 0.95+)
2. **Vector search** — Embed the query, find semantically similar functions (over-fetches 3x for reranking headroom)
3. **Full-text search** — BM25 keyword matching catches what embeddings miss
4. **RRF merge** — Reciprocal Rank Fusion combines both result lists without needing score calibration
5. **Exact match boost** — Functions whose name matches the query get priority
6. **Density reranking** — Structural signals determine information density, pushing trivial code down

**Density Scoring** uses 7 language-agnostic structural signals:

| Signal | What it measures |
|--------|-----------------|
| Body size | Larger functions carry more behavior (log-scaled) |
| Docstring presence | Documented code is more likely to be important |
| Docstring richness | Tags, deps, side effects indicate well-maintained code |
| Parameter count | More params = more complex behavior |
| Call graph centrality | Functions called by many others are architectural anchors |
| Visibility | Public > protected > private |
| Kind | Classes > methods/functions > interfaces |

**Penalties** prevent noise from dominating results:
- **Accessors** (getters/setters) — pure data access, no behavior
- **Constructors** — many params inflate scores, but they're just assignments
- **Test files** — large bodies don't mean important behavior (unless you're searching for tests)

**Graceful degradation:** If Ollama is unavailable, search falls back to full-text only. AST-based tools (dependencies, impact analysis, module summary) work without any embedding infrastructure.

## Why These Technologies

Every technology choice serves the core goal: **local, fast, zero-config code understanding.**

| Technology | Why |
|-----------|-----|
| **tree-sitter** | One parsing framework for all 7 languages. Mature, fast, battle-tested. Gives us full AST access without writing 7 different parsers from scratch. |
| **LanceDB** | Embedded vector database — no external server, no Docker, no configuration. Just a directory on disk. Supports both vector search and BM25 full-text search in a single engine. |
| **Qwen3-Embedding-0.6B** | The secret weapon. Just 0.6B parameters but delivers embedding quality that rivals models 10x its size for code understanding. Tested across large production codebases — Java enterprise monoliths, TypeScript monorepos, Python data pipelines — with consistently excellent retrieval accuracy. Runs locally via Ollama, fast enough for real-time reindexing, lightweight enough for any developer machine. |
| **RRF (Reciprocal Rank Fusion)** | Proven technique from information retrieval research. Merges ranked lists from different scoring systems (vector similarity vs. BM25 relevance) without needing score calibration. Simple, robust, effective. |
| **MCP Protocol** | Standard interface for AI tool integration. One server works with Claude Code, VS Code, Cursor, and any MCP-compatible client. |

## Supported Languages

| Language | Functions | Calls | Imports | Types | Test Detection |
|----------|-----------|-------|---------|-------|---------------|
| Python | functions, methods, classes | call sites | import/from-import | class inheritance, type hints | pytest, unittest |
| TypeScript | functions, arrows, methods, classes, interfaces | call sites | named/default/namespace imports | implements, extends, member types | jest, vitest, playwright |
| JavaScript | (same as TypeScript) | (same as TypeScript) | (same as TypeScript) | (same as TypeScript) | jest, vitest, mocha |
| Go | functions, methods (receiver), structs | call sites | import specs | implicit interfaces, structs | testing, testify |
| Rust | functions, methods (impl), structs, enums | call sites | use declarations | impl Trait for Type | #[test], #[cfg(test)] |
| Java | methods, constructors, classes, interfaces | method invocations | import declarations | extends, implements | JUnit, Mockito, AssertJ |
| C# | methods, constructors, classes, structs, interfaces, records | invocations | using directives | base types, interface impl | NUnit, xUnit, Moq |

Every language parser also provides:
- **Noise filtering** — built-in lists of standard library calls (e.g., `console.log`, `fmt.Println`, `System.out.println`) that get filtered from dependency analysis
- **Structural hints** — AST-confirmed classifications (constructor, abstract, getter/setter, test) that feed into density scoring

## Configuration

CodeWeave works zero-config out of the box. For customization, create `.code-context/config.yaml`:

```yaml
embedding:
  model: "qwen3-embedding:0.6b"     # Embedding model name
  ollamaUrl: "http://localhost:11434" # Ollama API endpoint
  dimensions: 1024                    # Vector dimensions
  batchSize: 50                       # Embedding batch size

parser:
  sourceRoot: "src"                   # Strip this prefix from module paths
  ignore:
    - "**/*.generated.*"              # Additional ignore patterns
    - "**/vendor/**"

search:
  rrfK: 60                           # RRF smoothing constant
  expandCamelCase: true               # Expand camelCase in search chunks
  density:
    enabled: true                     # Density-based reranking
    accessorPenalty: 0.6              # Penalty for getters/setters
    constructorPenalty: 0.7           # Penalty for constructors
    testFilePenalty: 0.5              # Penalty for test files

watcher:
  debounceMs: 500                     # File change debounce
  minIntervalMs: 2000                 # Minimum reindex interval

indexing:
  maxFileSizeKb: 500                  # Skip files larger than this
```

## CLI Tools

```bash
# Full project initialization (AST + embeddings + graphs)
codeweave-init [path] [--force] [--no-embed]

# Incremental reindex (only changed files)
codeweave-reindex [--all] [--files=path1,path2] [--stdin]

# Docstring coverage report
codeweave-check-docstrings [--strict] [files...]
```

## Manual Setup

If you prefer step-by-step instead of `npx @codeweave/mcp`:

```bash
# 1. Install globally
npm install -g @codeweave/mcp

# 2. Install Ollama and pull the embedding model
# macOS
brew install ollama
# Linux
curl -fsSL https://ollama.com/install.sh | sh

ollama pull qwen3-embedding:0.6b

# 3. Index your project
cd your-project
codeweave-init

# 4. Configure your MCP client
```

**Claude Code** — add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "codeweave": {
      "command": "codeweave-server"
    }
  }
}
```

**VS Code** — add `.vscode/mcp.json`:

```json
{
  "servers": {
    "codeweave": {
      "command": "codeweave-server"
    }
  }
}
```

## Monorepo Support

CodeWeave auto-detects workspaces in monorepos by scanning for manifest files (`package.json`, `build.gradle`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, etc.):

```
my-project/
├── backend/build.gradle    → workspace "backend"
├── mobile/package.json     → workspace "mobile"
└── shared/package.json     → workspace "shared"
```

Each workspace gets its own isolated index, call graph, type graph, and vector store. Tools accept an optional `workspace` parameter — omit it to search across all workspaces.

## Requirements

- **Node.js 20+**
- **Ollama** — for semantic search embeddings. Install via the setup wizard or manually from [ollama.com](https://ollama.com). AST-based tools work without Ollama.

## Status

CodeWeave is under **active development**. The core indexing pipeline and all 8 tools are stable and tested across production codebases in all 7 supported languages.

Feedback, bug reports, and contributions are welcome — open an issue at [github.com/semihkayan/codeweave-mcp](https://github.com/semihkayan/codeweave-mcp/issues).

## License

[Apache 2.0](LICENSE)
