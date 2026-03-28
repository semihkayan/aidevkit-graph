#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PACKAGE_NAME = "@aidevkit/graph";
const OLLAMA_MODEL = "qwen3-embedding:0.6b";

function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  [OK] ${msg}`); }
function warn(msg: string) { console.log(`  [!!] ${msg}`); }
function step(msg: string) { console.log(`\n> ${msg}`); }

function commandExists(cmd: string): boolean {
  try {
    const flag = os.platform() === "win32" ? "where" : "which";
    execSync(`${flag} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function run(cmd: string, opts?: { stdio?: "inherit" | "ignore" | "pipe" }): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: opts?.stdio || "pipe" }).trim();
  } catch { return ""; }
}

async function main() {
  console.log("\n@aidevkit/graph — Setup\n");

  // === Step 1: Install package globally ===
  step("1/5 Checking @aidevkit/graph installation...");
  if (commandExists("aidevkit-server")) {
    ok("@aidevkit/graph is installed");
  } else {
    log("Installing @aidevkit/graph globally...");
    run("npm install -g @aidevkit/graph --legacy-peer-deps", { stdio: "inherit" });
    if (commandExists("aidevkit-server")) {
      ok("Installed successfully");
    } else {
      warn("Installation failed. Try manually: npm install -g @aidevkit/graph");
    }
  }

  // === Step 2: Install Ollama ===
  step("2/5 Checking Ollama...");
  if (commandExists("ollama")) {
    ok("Ollama is installed");
  } else {
    const platform = os.platform();
    log("Ollama not found. Installing...");

    if (platform === "darwin") {
      if (commandExists("brew")) {
        run("brew install ollama", { stdio: "inherit" });
      } else {
        warn("Homebrew not found. Install Ollama manually: https://ollama.com/download");
      }
    } else if (platform === "win32") {
      if (commandExists("winget")) {
        run("winget install -e --id Ollama.Ollama", { stdio: "inherit" });
      } else {
        warn("Install Ollama manually: https://ollama.com/download");
      }
    } else {
      // Linux
      log("Running Ollama install script...");
      run("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "inherit" });
    }

    if (commandExists("ollama")) {
      ok("Ollama installed");
    } else {
      warn("Could not install Ollama automatically. Visit: https://ollama.com/download");
    }
  }

  // === Step 3: Start Ollama & pull model ===
  step("3/5 Checking embedding model...");
  if (commandExists("ollama")) {
    // Ensure Ollama is running
    try {
      execSync("curl -s http://localhost:11434/api/tags", { stdio: "ignore", timeout: 3000 });
    } catch {
      log("Starting Ollama...");
      if (os.platform() === "darwin") {
        run("brew services start ollama 2>/dev/null || ollama serve &");
      } else {
        // Background start
        const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
        child.unref();
      }
      // Wait for startup
      for (let i = 0; i < 10; i++) {
        try {
          execSync("curl -s http://localhost:11434/api/tags", { stdio: "ignore", timeout: 2000 });
          break;
        } catch {
          run("sleep 1");
        }
      }
    }

    // Check if model is pulled
    const models = run("ollama list 2>/dev/null");
    if (models.includes("qwen3-embedding")) {
      ok(`${OLLAMA_MODEL} is ready`);
    } else {
      log(`Pulling ${OLLAMA_MODEL} (639 MB)...`);
      run(`ollama pull ${OLLAMA_MODEL}`, { stdio: "inherit" });
      ok("Model downloaded");
    }
  } else {
    warn("Ollama not available. Semantic search will work in degraded mode (keyword-only).");
  }

  // === Step 4: Configure Claude Code MCP ===
  step("4/5 Configuring Claude Code...");
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.mcpServers) settings.mcpServers = {};

  if (settings.mcpServers.aidevkit) {
    ok("MCP server already configured in Claude Code");
  } else {
    settings.mcpServers.aidevkit = {
      command: "aidevkit-server",
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    ok("Added aidevkit MCP server to ~/.claude/settings.json");
  }

  // === Step 5: Initialize current project ===
  step("5/5 Initializing project index...");
  const cwd = process.cwd();
  const codeContextDir = path.join(cwd, ".code-context");

  if (existsSync(path.join(codeContextDir, "ast-cache"))) {
    ok("Project already indexed. Run 'aidevkit-init --force' to rebuild.");
  } else {
    log("Indexing current project...");
    run("aidevkit-init", { stdio: "inherit" });
    ok("Project indexed");
  }

  // === Summary ===
  console.log("\n========================================");
  console.log("  Setup complete!");
  console.log("========================================\n");
  console.log("  Next steps:");
  console.log("  1. Open this project in Claude Code");
  console.log("  2. Claude will automatically use code intelligence tools");
  console.log("  3. Try: 'find the authentication code' or 'what calls this function?'\n");

  // .gitignore reminder
  const gitignorePath = path.join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".code-context")) {
      warn("Add to .gitignore: .code-context/ast-cache/  .code-context/lance/  .code-context/server.log");
    }
  }
}

main().catch(err => {
  console.error("\nSetup failed:", err.message || err);
  process.exit(1);
});
