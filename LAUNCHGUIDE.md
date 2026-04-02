# CodeWeave

## Tagline
Save tokens while coding — your AI agent gets structured code context, not file dumps.

## Description
CodeWeave is an MCP server that gives AI agents structured code intelligence instead of dumping entire files into context. Your agent queries local indexes — AST, call graph, type graph, and hybrid semantic search — and gets back only what it needs. The result: less token waste, more relevant context, better coding decisions.

It supports 7 languages (Python, TypeScript, JavaScript, Go, Rust, Java, C#) with a 6-stage hybrid search pipeline combining vector embeddings, full-text search, and structural density scoring. Everything runs locally with zero external dependencies beyond Ollama for embeddings. Monorepo and git worktree support included. A file watcher keeps indexes current as code changes — no manual reindexing needed.

ATTENTION: Run "npx @codeweave/mcp" in your project directory. The setup wizard will handle everything for you. At first, it may take some time.

INFO: Exhaustively tested on large Java, C#, JavaScript, TypeScript, React codebases. Contributions and feedback are welcome.

## Category
Developer Tools

## Use Cases
Relevant Context, Token Efficiency, Codebase Indexing

## Features
- 6-stage hybrid semantic search — vector embeddings + BM25 full-text search + structural density reranking
- AST-based function indexing — tree-sitter extracts every function, class, method, and interface
- Call graph analysis — who-calls-whom with type-aware resolution and transitive traversal
- Type graph tracking — inheritance chains, interface implementations, type usages
- Change impact analysis — blast radius assessment with risk levels before refactoring
- 7 language support — Python, TypeScript, JavaScript, Go, Rust, Java, C#
- Monorepo & git worktree support — isolated indexes per workspace with automatic detection
- Live file watching — auto-reindexes on code changes, no manual intervention
- Zero-config setup — single npx command installs everything including Ollama and embedding model
- Graceful degradation — AST tools work without embeddings; search falls back to keyword-only if Ollama unavailable

## Getting Started
- "What's the blast radius if I change the DatabaseConnection class?"
- "Find all functions that handle user authentication"
- "Which docstrings are stale or missing in the API layer?"
- Tool: semantic_search — Find functions by meaning, not just name. Hybrid vector + keyword search.
- Tool: get_function_source — Read a specific function's source code without loading entire files.
- Tool: get_module_summary — Browse a directory's functions, classes, and signatures at a glance.
- Tool: get_dependencies — See what a function calls, cross-validated against docstrings.
- Tool: get_impact_analysis — Assess blast radius before changing a function or type.
- Tool: get_stale_docstrings — Find missing or outdated docstrings and @deps drift.
- Tool: reindex — Manually refresh the index (usually unnecessary — file watcher auto-updates).
- Tool: get_index_status — Check index health: file counts, embedding progress, language breakdown.

## Tags
code-intelligence, semantic-search, ast, call-graph, type-graph, tree-sitter, embeddings, code-understanding, refactoring, impact-analysis, monorepo, mcp, lancedb, ollama, code-navigation, dependency-analysis

## Documentation URL
https://github.com/semihkayan/codeweave-mcp