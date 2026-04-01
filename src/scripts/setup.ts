#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const OLLAMA_MODEL = "qwen3-embedding:0.6b";

// === Helpers ===

const warnings: string[] = [];
function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); warnings.push(msg); }
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
    return execSync(cmd, { encoding: "utf-8", stdio: opts?.stdio || "pipe", timeout: 300_000 }).trim();
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

// === Version Helpers ===

function getInstalledVersion(): string | null {
  const raw = runOrNull("npm list -g @codeweave/mcp --depth=0 --json");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data.dependencies?.["@codeweave/mcp"]?.version ?? null;
  } catch { return null; }
}

function getLatestVersion(): string | null {
  return runOrNull("npm view @codeweave/mcp version");
}

function isNewerVersion(latest: string, installed: string): boolean {
  const a = latest.split(".").map(Number);
  const b = installed.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
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
  console.log("\n@codeweave/mcp — Setup\n");

  const cwd = process.cwd();

  // Windows download size warning
  if (os.platform() === "win32" && !commandExists("ollama")) {
    log("Note: Setup will download ~2.5 GB (Ollama + embedding model).");
  }

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

  // === Step 1: Install or update package globally ===
  step("1/5 Installing @codeweave/mcp...");
  let forceReindex = false;
  const installedVersion = getInstalledVersion();
  if (installedVersion) {
    const latestVersion = getLatestVersion();
    if (latestVersion && isNewerVersion(latestVersion, installedVersion)) {
      log(`Installed: ${installedVersion}, Latest: ${latestVersion}`);
      if (await confirm(`Update to ${latestVersion}?`)) {
        runOrNull("npm install -g @codeweave/mcp@latest", { stdio: "inherit" });
        const newVersion = getInstalledVersion();
        if (newVersion && isNewerVersion(newVersion, installedVersion)) {
          ok(`Updated to ${newVersion}`);
          forceReindex = true;
        } else {
          warn("Update failed. Try manually: npm install -g @codeweave/mcp@latest");
        }
      } else {
        ok(`Keeping ${installedVersion}`);
      }
    } else {
      ok(`Up to date (${installedVersion})`);
    }
  } else {
    runOrNull("npm install -g @codeweave/mcp", { stdio: "inherit" });
    if (runOrNull("npm list -g @codeweave/mcp --depth=0") !== null) {
      ok("Installed");
    } else {
      fail("Installation failed. Try manually: npm install -g @codeweave/mcp");
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

    // On Windows, winget installs Ollama but doesn't always add it to PATH
    if (!commandExists("ollama") && platform === "win32") {
      const ollamaDir = path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama");
      if (existsSync(path.join(ollamaDir, "ollama.exe"))) {
        const currentPath = process.env.PATH || "";
        if (!currentPath.includes(ollamaDir)) {
          process.env.PATH = `${currentPath};${ollamaDir}`;
          log("Added Ollama to PATH for this session");
          log("To make permanent, add to your PATH: " + ollamaDir);
        }
      }
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
        if (await ollamaHealthCheck() && runOrNull("ollama list") !== null) { started = true; break; }
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
        try {
          execSync(`ollama pull ${OLLAMA_MODEL}`, {
            stdio: "inherit",
            env: { ...process.env, OLLAMA_INSECURE: "true" },
          });
        } catch { /* handled below */ }
        const modelsAfter = runOrNull("ollama list") || "";
        if (modelsAfter.includes(OLLAMA_MODEL.split(":")[0])) {
          ok("Model downloaded");
        } else {
          warn("Model download failed. Try manually: ollama pull " + OLLAMA_MODEL);
        }
      }
    }
  }

  // === Step 4: Configure MCP clients ===
  step("4/5 Configuring MCP clients...");
  const mcpConfigPath = path.join(cwd, ".mcp.json");

  let mcpConfig: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { mcpConfig = {}; }
  }

  if (mcpConfig.mcpServers?.codeweave) {
    ok("Claude Code: already configured");
  } else {
    if (typeof mcpConfig.mcpServers !== "object" || mcpConfig.mcpServers === null) {
      mcpConfig.mcpServers = {};
    }
    mcpConfig.mcpServers.codeweave = { command: "codeweave-server" };
    const tmpPath = mcpConfigPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2));
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, mcpConfigPath);
    ok("Claude Code: added to .mcp.json");
  }

  // 4b: VS Code Copilot — .vscode/mcp.json
  const vscodeMcpPath = path.join(cwd, ".vscode", "mcp.json");

  let vscodeMcpConfig: Record<string, any> = {};
  if (existsSync(vscodeMcpPath)) {
    try { vscodeMcpConfig = JSON.parse(readFileSync(vscodeMcpPath, "utf-8")); } catch { vscodeMcpConfig = {}; }
  }

  if (vscodeMcpConfig.servers?.["codeweave"]) {
    ok("VS Code: already configured");
  } else {
    if (typeof vscodeMcpConfig.servers !== "object" || vscodeMcpConfig.servers === null) {
      vscodeMcpConfig.servers = {};
    }
    vscodeMcpConfig.servers["codeweave"] = { command: "codeweave-server" };
    mkdirSync(path.join(cwd, ".vscode"), { recursive: true });
    const tmpPath2 = vscodeMcpPath + ".tmp";
    writeFileSync(tmpPath2, JSON.stringify(vscodeMcpConfig, null, 2));
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath2, vscodeMcpPath);
    ok("VS Code: added to .vscode/mcp.json");
  }

  // === Step 5: Index project ===
  step("5/5 Indexing project...");
  const codeContextDir = path.join(cwd, ".code-context");

  const hasAstCache = existsSync(path.join(codeContextDir, "ast-cache"));
  const hasVectors = existsSync(path.join(codeContextDir, "lance"));

  if (hasAstCache && hasVectors && !forceReindex) {
    ok("Already indexed. Run 'codeweave-init --force' to rebuild.");
  } else if (commandExists("codeweave-init")) {
    try {
      execSync(`codeweave-init${forceReindex ? " --force" : ""}`, { stdio: "inherit", cwd });
      ok("Project indexed");
    } catch {
      warn("Indexing failed. Try manually: codeweave-init");
    }
  } else {
    warn("codeweave-init not found. Run 'npm install -g @codeweave/mcp' then 'codeweave-init'");
  }

  // === Done ===
  console.log("\n========================================");
  console.log("  Setup complete!");
  console.log("========================================\n");
  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) console.log(`    ⚠ ${w}`);
    console.log();
  }
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
