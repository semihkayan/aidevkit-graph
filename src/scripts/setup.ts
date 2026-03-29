#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PACKAGE_NAME = "@aidevkit/graph";
const OLLAMA_MODEL = "qwen3-embedding:0.6b";

// === Helpers ===

function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); }
function step(msg: string) { console.log(`\n> ${msg}`); }

function commandExists(cmd: string): boolean {
  if (!/^[\w.@/-]+$/.test(cmd)) return false;
  try {
    const flag = os.platform() === "win32" ? "where" : "which";
    execSync(`${flag} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function runOrNull(cmd: string, opts?: { stdio?: "inherit" | "ignore" | "pipe" }): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: opts?.stdio || "pipe", timeout: 60_000 }).trim();
  } catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function ollamaHealthCheck(): Promise<boolean> {
  try {
    const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

async function confirm(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  ${question} (y/n) `, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// === Project Detection ===

const MANIFESTS = ["package.json", "build.gradle", "build.gradle.kts", "pom.xml",
  "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "setup.py"];
const MANIFEST_EXTENSIONS = [".csproj", ".sln"];

function hasManifest(dir: string): boolean {
  try {
    const files = readdirSync(dir);
    return MANIFESTS.some(m => files.includes(m)) ||
           MANIFEST_EXTENSIONS.some(ext => files.some(f => f.endsWith(ext)));
  } catch { return false; }
}

function findSubWorkspaces(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .filter(e => hasManifest(path.join(dir, e.name)))
      .map(e => e.name);
  } catch { return []; }
}

function isDangerousDir(dir: string): boolean {
  const home = os.homedir();
  const dangerous = [home, "/", "/tmp", "/home", "/usr", "/var", "/etc", os.tmpdir()];
  if (os.platform() === "win32") {
    dangerous.push("C:\\", "C:\\Users", "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)");
  }
  return dangerous.includes(dir);
}

// === Main ===

async function main() {
  console.log("\n@aidevkit/graph — Setup\n");

  const cwd = process.cwd();

  // Safety check
  if (isDangerousDir(cwd)) {
    fail(`Cannot run setup in ${cwd}`);
    fail("cd into your project directory first.\n");
    process.exit(1);
  }

  // Project detection
  const hasGit = existsSync(path.join(cwd, ".git"));
  const rootHasManifest = hasManifest(cwd);
  const subWorkspaces = findSubWorkspaces(cwd);

  if (hasGit || rootHasManifest) {
    if (subWorkspaces.length > 0) {
      ok(`Project detected with ${subWorkspaces.length} workspace(s): ${subWorkspaces.join(", ")}`);
    } else {
      ok("Project detected");
    }
  } else if (subWorkspaces.length > 0) {
    log(`No .git or project file at root, but found sub-projects: ${subWorkspaces.join(", ")}`);
    if (!(await confirm("Index these workspaces?"))) {
      console.log("  Cancelled.\n");
      process.exit(0);
    }
  } else {
    fail("This doesn't look like a project directory.");
    fail("No .git, package.json, build.gradle, go.mod, or similar found.");
    fail(`Current directory: ${cwd}`);
    fail("cd into your project directory first.\n");
    process.exit(1);
  }

  // === Step 1: Install package globally ===
  step("1/5 Installing @aidevkit/graph...");
  if (commandExists("graph-server")) {
    ok("Already installed");
  } else {
    const result = runOrNull("npm install -g @aidevkit/graph", { stdio: "inherit" });
    if (commandExists("graph-server")) {
      ok("Installed");
    } else {
      fail("Installation failed. Try manually: npm install -g @aidevkit/graph");
      fail("Continuing without global install — some features may not work.");
    }
  }

  // === Step 2: Install Ollama ===
  step("2/5 Installing Ollama...");
  if (commandExists("ollama")) {
    ok("Already installed");
  } else {
    const platform = os.platform();

    if (platform === "darwin") {
      if (commandExists("brew")) {
        runOrNull("brew install ollama", { stdio: "inherit" });
      } else {
        warn("Homebrew not found. Install Ollama manually: https://ollama.com/download");
      }
    } else if (platform === "win32") {
      if (commandExists("winget")) {
        log("Installing via winget (may require admin)...");
        runOrNull("winget install -e --id Ollama.Ollama", { stdio: "inherit" });
      } else {
        warn("Install Ollama manually: https://ollama.com/download");
      }
    } else {
      log("Installing via official script...");
      runOrNull("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "inherit" });
    }

    if (commandExists("ollama")) {
      ok("Installed");
    } else {
      warn("Could not install Ollama. Semantic search will work in degraded mode.");
      warn("Install manually: https://ollama.com/download");
    }
  }

  // === Step 3: Pull embedding model ===
  step("3/5 Downloading embedding model...");
  if (!commandExists("ollama")) {
    warn("Ollama not available — skipping model download.");
  } else {
    // Ensure Ollama is running
    if (!(await ollamaHealthCheck())) {
      log("Starting Ollama...");
      const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
      child.unref();

      let started = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if (await ollamaHealthCheck()) { started = true; break; }
      }
      if (!started) {
        warn("Could not start Ollama. Start it manually: ollama serve");
      }
    }

    // Check if model exists
    if (await ollamaHealthCheck()) {
      const models = runOrNull("ollama list") || "";
      if (models.includes(OLLAMA_MODEL.split(":")[0])) {
        ok(`${OLLAMA_MODEL} ready`);
      } else {
        log(`Pulling ${OLLAMA_MODEL}...`);
        runOrNull(`ollama pull ${OLLAMA_MODEL}`, { stdio: "inherit" });
        ok("Model downloaded");
      }
    }
  }

  // === Step 4: Configure Claude Code ===
  step("4/5 Configuring Claude Code...");
  const mcpConfigPath = path.join(cwd, ".mcp.json");

  let mcpConfig: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { mcpConfig = {}; }
  }

  if (mcpConfig.mcpServers?.aidevkit) {
    ok("Already configured");
  } else {
    if (typeof mcpConfig.mcpServers !== "object" || mcpConfig.mcpServers === null) {
      mcpConfig.mcpServers = {};
    }
    mcpConfig.mcpServers.aidevkit = { command: "graph-server" };
    const tmpPath = mcpConfigPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2));
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, mcpConfigPath);
    ok("Added to .mcp.json");
  }

  // === Step 5: Index project ===
  step("5/5 Indexing project...");
  const codeContextDir = path.join(cwd, ".code-context");

  if (existsSync(path.join(codeContextDir, "ast-cache"))) {
    ok("Already indexed. Run 'graph-init --force' to rebuild.");
  } else if (commandExists("graph-init")) {
    try {
      execSync("graph-init", { stdio: "inherit", cwd });
      ok("Project indexed");
    } catch {
      warn("Indexing failed. Try manually: graph-init");
    }
  } else {
    warn("graph-init not found. Run 'npm install -g @aidevkit/graph' then 'graph-init'");
  }

  // === Done ===
  console.log("\n========================================");
  console.log("  Setup complete!");
  console.log("========================================\n");
  console.log("  Open this project in Claude Code.");
  console.log("  Try: 'find the authentication code'");
  console.log("  Or:  'what calls this function?'\n");

  // .gitignore — add .code-context/ if .gitignore exists
  const gitignorePath = path.join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".code-context")) {
      const separator = content.endsWith("\n") ? "" : "\n";
      writeFileSync(gitignorePath, content + separator + ".code-context/\n");
      ok("Added .code-context/ to .gitignore");
    }
  }
}

main().catch(err => {
  fail(`Setup failed: ${err.message || err}`);
  process.exit(1);
});
