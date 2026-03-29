# @aidevkit/graph

Codebase graph analysis for AI agents. Goes beyond simple RAG — builds call graphs, type graphs, and dependency trees so AI actually understands your code structure.

## What it does

13 tools that help AI agents understand and navigate codebases:

| Tool | What it does |
|------|-------------|
| `semantic_search` | Natural language code search (vector + BM25 hybrid) |
| `get_module_summary` | Browse modules with progressive disclosure |
| `get_function_source` | Read specific function source code |
| `get_dependencies` | What a function calls (AST + docstring cross-validation) |
| `get_callers` | Who calls a function (reverse call graph) |
| `get_dependency_graph` | Transitive dependency tree with cycle detection |
| `get_impact_analysis` | Risk assessment when changing a function |
| `search_by_tags` | Find functions by docstring tags |
| `get_file_structure` | Project directory tree with function counts |
| `get_recent_changes` | Git changes at function level |
| `get_stale_docstrings` | Find outdated or missing documentation |
| `reindex` | Manual index update |
| `get_index_status` | Index health and statistics |

## Features

- **7 languages**: Python, TypeScript, JavaScript, Java, Go, Rust, C#
- **Hybrid search**: Vector embeddings (Qwen3-Embedding-0.6B via Ollama) + BM25 full-text search, merged with RRF
- **Call graph**: Forward and reverse call tracking with import resolution
- **Type graph**: Interface/class inheritance and implementation tracking
- **Auto-reindex**: File watcher with debounce detects changes automatically
- **Multi-workspace**: Auto-detects monorepo workspaces (backend + mobile, etc.)
- **Zero-config**: Works on any codebase without docstrings or annotations
- **SOLID architecture**: Every component is behind an interface, swappable via composition root

## Quick Start

```bash
cd your-project
npx @aidevkit/graph
```

That's it. This single command:
1. Installs `@aidevkit/graph` globally
2. Installs Ollama if needed (brew/winget/curl)
3. Downloads the embedding model (639 MB)
4. Configures Claude Code to use the MCP server
5. Indexes your project

Open the project in Claude Code and start asking questions.

### Manual Install

If you prefer step-by-step:

```bash
npm install -g @aidevkit/graph
ollama pull qwen3-embedding:0.6b
graph-init
```

Add `.mcp.json` to your project root (or run `npx @aidevkit/graph` which does this automatically):

```json
{
  "mcpServers": {
    "aidevkit": {
      "command": "graph-server"
    }
  }
}
```

## How it works

```
Your Code  ──>  tree-sitter AST  ──>  Function Index (in-memory)
                                           │
                     Ollama  ──>  Embeddings  ──>  LanceDB (vector + FTS)
                                           │
                                      Call Graph + Type Graph
                                           │
                                    13 MCP Tools  ──>  AI Agent
```

1. **Parses** your code with tree-sitter into function records
2. **Embeds** each function (name + signature + docstring) via Qwen3-Embedding-0.6B
3. **Stores** vectors in LanceDB with BM25 full-text index
4. **Builds** call graph (who calls whom) and type graph (who implements what)
5. **Watches** for file changes and auto-reindexes
6. **Serves** 13 tools over MCP protocol (stdio)

## Workspace Support

For monorepos with multiple sub-projects:

```
my-project/
├── backend/build.gradle    → auto-detected workspace
├── mobile/package.json     → auto-detected workspace
```

Tools require `workspace` parameter when multiple workspaces are detected:

```json
{ "query": "user authentication", "workspace": "backend" }
```

## CLI Tools

```bash
# Initialize index + embeddings
graph-init [path] [--force] [--no-embed]

# Incremental reindex
graph-reindex [--all] [--files=a.py,b.ts] [--stdin]

# Check docstring coverage
graph-check-docstrings [--strict] [files...]
```

## Configuration

Optional `.code-context/config.yaml`:

```yaml
embedding:
  model: "qwen3-embedding:0.6b"
  dimensions: 1024

parser:
  sourceRoot: "src"
  ignore:
    - "**/*.generated.*"

search:
  rrfK: 60
  expandCamelCase: true

watcher:
  debounceMs: 500
  minIntervalMs: 2000
```

## Requirements

- Node.js 20+
- Ollama (for semantic search — structural tools work without it)

## License

Apache 2.0
