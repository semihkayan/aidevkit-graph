#!/usr/bin/env node

import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const OLLAMA_MODEL = "qwen3-embedding:0.6b";

const CLAUDE_MD_SNIPPET = `## CRITICAL: This project uses CodeWeave MCP

Always prefer codeweave tools over generic alternatives — they are faster, cheaper, and more accurate:
- Exploring a module → \`get_module_summary\` (not find/ls/Glob)
- Reading one function → \`get_function_source\` (not Read/cat)
- Searching by concept → \`semantic_search\` (not grep/rg)
- Tracing calls → \`get_dependencies\` (not grep)
- Change risk → \`get_impact_analysis\` (not grep for callers)

When you add or modify a function, you MUST add a docstring. Start with a one-line summary, then add annotations:
- \`@deps: functionA, ClassB.method\` — functions it calls (always include)
- \`@tags: auth, payments, api\` — domain/concern labels (always include)
- \`@side_effects: database_write, external_api_call\` — if the function has observable effects

Example:
\`\`\`
Validate order fields and check inventory.
@deps: validateFields, InventoryService.check
@tags: orders, validation
\`\`\`

These annotations power semantic search, call graph validation, and impact analysis — without them, codeweave tools degrade significantly.

When writing code, if you notice a docstring that is incorrect, misleading, outdated, or missing — fix it, even if it's not part of your current task. This keeps the index accurate over time.

After writing code, run \`get_stale_docstrings\` to find and fix missing or outdated annotations. If coverage is low, prioritize functions you touch — don't try to backfill the entire codebase at once.
`;
const DEBUG = process.argv.includes("--debug");
const AUTO_YES = process.argv.includes("--yes") || process.argv.includes("-y") || !process.stdin.isTTY;
const SKIP_OLLAMA = process.argv.includes("--skip-ollama");
const SKIP_INDEX = process.argv.includes("--skip-index");

// === Step Counter ===

let currentStep = 0;
const totalSteps = 5 - (SKIP_OLLAMA ? 2 : 0) - (SKIP_INDEX ? 1 : 0);
function nextStep(msg: string) { console.log(`\n> ${++currentStep}/${totalSteps} ${msg}`); }

// === Logging Helpers ===

const warnings: string[] = [];
function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); warnings.push(msg); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); }

// === Shell Helpers ===

function runOrNull(cmd: string, opts?: { stdio?: "inherit" | "ignore" | "pipe" }): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: opts?.stdio || "pipe", timeout: 300_000 }).trim();
  } catch (err: any) {
    if (DEBUG) {
      const stderr = err?.stderr?.toString?.().trim();
      if (stderr) console.error(`  [debug] ${cmd}: ${stderr}`);
    }
    return null;
  }
}

function resolveCommand(cmd: string): string | null {
  if (!/^[\w.@/-]+$/.test(cmd)) return null;
  const which = os.platform() === "win32" ? "where" : "which";
  return runOrNull(`${which} ${cmd}`)?.split(/\r?\n/)[0]?.trim() ?? null;
}

function commandExists(cmd: string): boolean {
  return resolveCommand(cmd) !== null;
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
  if (AUTO_YES) {
    log(`${question} (auto-yes)`);
    return true;
  }
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
  const norm = os.platform() === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const home = os.homedir();
  const dangerous = [home, "/", "/tmp", "/home", "/usr", "/var", "/etc", os.tmpdir()];
  if (os.platform() === "win32") {
    dangerous.push("C:\\", "C:\\Users", "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)");
  }
  return dangerous.some(d => norm(d) === norm(dir));
}

// === MCP Config Helpers ===

function resolvePackageScript(scriptRelPath: string): string | null {
  // Always use npm root -g — guaranteed global install path, never npx cache
  const npmRoot = runOrNull("npm root -g");
  if (!npmRoot) return null;
  const scriptPath = path.join(npmRoot, "@codeweave", "mcp", scriptRelPath);
  return existsSync(scriptPath) ? scriptPath : null;
}

function resolveServerScript(): string | null {
  return resolvePackageScript("dist/index.js");
}

function needsConfigUpdate(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = entry.command;
  if (typeof cmd !== "string") return false;
  // Bare command name (old format, PATH-dependent)
  if (!cmd.includes("/") && !cmd.includes("\\")) return true;
  // Node binary no longer exists (e.g., brew upgrade changed the path)
  if (!existsSync(cmd)) return true;
  // Server script no longer exists (e.g., npm uninstall/upgrade)
  const args = entry.args;
  if (Array.isArray(args) && typeof args[0] === "string" && !existsSync(args[0])) return true;
  return false;
}

function upsertMcpConfig(
  configPath: string, serversKey: string, label: string,
  mcpEntry: Record<string, any>, ensureDir?: string,
): void {
  let config: Record<string, any> = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }
  if (typeof config[serversKey] !== "object" || config[serversKey] === null) {
    config[serversKey] = {};
  }
  const existing = config[serversKey].codeweave;
  if (existing && !needsConfigUpdate(existing)) {
    ok(`${label}: already configured`);
    return;
  }
  config[serversKey].codeweave = mcpEntry;
  try {
    if (ensureDir) mkdirSync(ensureDir, { recursive: true });
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, configPath);
    ok(`${label}: ${existing ? "updated" : "configured"}`);
  } catch (err: any) {
    warn(`${label}: failed to write — ${err.message}`);
  }
}

// === Step Functions ===

async function validateProjectDir(): Promise<string> {
  const cwd = process.cwd();

  if (isDangerousDir(cwd)) {
    fail(`Cannot run setup in ${cwd}`);
    fail("cd into your project directory first.\n");
    process.exit(1);
  }

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

  return cwd;
}

async function installOrUpdatePackage(): Promise<{ forceReindex: boolean; installFailed: boolean }> {
  let forceReindex = false;
  let installFailed = false;

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
          if (os.platform() === "win32") warn("On Windows, you may need to run as Administrator.");
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
      if (os.platform() === "win32") fail("On Windows, you may need to run as Administrator.");
      installFailed = true;
    }
  }

  return { forceReindex, installFailed };
}

function tryInstallOllama(method: string, installCmd: string): boolean {
  log(`Trying ${method}...`);
  runOrNull(installCmd, { stdio: "inherit" });
  return commandExists("ollama");
}

function fixOllamaPath(): boolean {
  const platform = os.platform();
  const binary = platform === "win32" ? "ollama.exe" : "ollama";
  const sep = path.delimiter;
  const knownPaths: string[] = [];

  if (platform === "darwin") {
    knownPaths.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (platform === "win32") {
    knownPaths.push(
      path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama"),
      "C:\\ProgramData\\chocolatey\\bin",
    );
  } else {
    knownPaths.push("/usr/local/bin", "/usr/bin", "/snap/bin");
  }

  for (const dir of knownPaths) {
    if (existsSync(path.join(dir, binary))) {
      const currentPath = process.env.PATH || "";
      if (!currentPath.split(sep).includes(dir)) {
        process.env.PATH = `${currentPath}${sep}${dir}`;
        log(`Found Ollama in ${dir}, added to PATH for this session`);
      }
      if (commandExists("ollama")) return true;
    }
  }
  return false;
}

function installOllama(): void {
  // Check PATH first, then known install locations
  if (commandExists("ollama") || fixOllamaPath()) {
    ok("Already installed");
    return;
  }

  const platform = os.platform();
  let installed = false;

  if (platform === "darwin") {
    if (!installed && commandExists("brew"))
      installed = tryInstallOllama("Homebrew", "brew install ollama") || fixOllamaPath();
    if (!installed && commandExists("curl"))
      installed = tryInstallOllama("install script", "curl -fsSL https://ollama.com/install.sh | sh") || fixOllamaPath();

  } else if (platform === "win32") {
    if (!installed && commandExists("winget"))
      installed = tryInstallOllama("winget", "winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements") || fixOllamaPath();
    if (!installed && commandExists("choco"))
      installed = tryInstallOllama("Chocolatey", "choco install ollama -y") || fixOllamaPath();

  } else {
    if (!installed && commandExists("curl"))
      installed = tryInstallOllama("install script", "curl -fsSL https://ollama.com/install.sh | sh") || fixOllamaPath();
    if (!installed && commandExists("wget"))
      installed = tryInstallOllama("install script (wget)", "wget -qO- https://ollama.com/install.sh | sh") || fixOllamaPath();
  }

  if (installed) ok("Installed");
  else { warn("Could not install Ollama. Semantic search will work in degraded mode."); warn("Install manually: https://ollama.com/download"); }
}

async function pullEmbeddingModel(): Promise<void> {
  if (!commandExists("ollama")) {
    warn("Ollama not available — skipping model download.");
    return;
  }

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
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) log("Retrying download...");
        try {
          execSync(`ollama pull ${OLLAMA_MODEL}`, { stdio: "inherit" });
          break;
        } catch { /* retry */ }
      }
      const modelsAfter = runOrNull("ollama list") || "";
      if (modelsAfter.includes(OLLAMA_MODEL.split(":")[0])) {
        ok("Model downloaded");
      } else {
        warn("Model download failed. Try manually: ollama pull " + OLLAMA_MODEL);
      }
    }
  }
}

function configureMcpClients(cwd: string, installFailed: boolean): void {
  // Resolve absolute paths so MCP clients don't depend on PATH
  // Prefer symlink paths (survive upgrades), fall back to process.execPath
  const nodePath = process.execPath;
  const serverPath = resolveServerScript();

  let mcpEntry: Record<string, any> | null = null;
  if (serverPath) {
    mcpEntry = { command: nodePath, args: [serverPath] };
  } else if (!installFailed) {
    mcpEntry = { command: "codeweave-server" };
    warn("Could not resolve codeweave-server path. MCP config may not work in all environments.");
  } else {
    warn("Skipping MCP client config — global install failed.");
  }

  if (mcpEntry) {
    const mcpConfigPath = path.join(cwd, ".mcp.json");
    const vscodeMcpPath = path.join(cwd, ".vscode", "mcp.json");
    upsertMcpConfig(mcpConfigPath, "mcpServers", "Claude Code", mcpEntry);
    upsertMcpConfig(vscodeMcpPath, "servers", "VS Code", mcpEntry, path.join(cwd, ".vscode"));
  }
}

function indexProject(cwd: string, forceReindex: boolean): void {
  const codeContextDir = path.join(cwd, ".code-context");
  const hasAstCache = existsSync(path.join(codeContextDir, "ast-cache"));
  const hasVectors = existsSync(path.join(codeContextDir, "lance"));

  if (hasAstCache && hasVectors && !forceReindex) {
    ok("Already indexed. Run 'codeweave-init --force' to rebuild.");
    return;
  }

  const initScript = resolvePackageScript("dist/scripts/init.js");
  if (initScript) {
    const nodePath = process.execPath;
    try {
      execFileSync(nodePath, [initScript, ...(forceReindex ? ["--force"] : [])], { stdio: "inherit", cwd });
      ok("Project indexed");
    } catch {
      warn("Indexing failed. Try manually: codeweave-init");
    }
  } else {
    warn("codeweave-init not found. Run 'npm install -g @codeweave/mcp' then 'codeweave-init'");
  }
}

async function injectClaudeMd(cwd: string): Promise<void> {
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  let existing = "";
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, "utf-8");
    if (existing.includes("This project uses CodeWeave MCP")) {
      ok("CLAUDE.md: already configured");
      return;
    }
  }
  if (!(await confirm("Add CodeWeave instructions to CLAUDE.md?"))) return;
  const hasContent = existing.trim().length > 0;
  let content: string;
  if (hasContent) {
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    content = existing + separator + CLAUDE_MD_SNIPPET;
  } else {
    content = CLAUDE_MD_SNIPPET;
  }
  try {
    const tmpPath = claudeMdPath + ".tmp";
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, claudeMdPath);
    ok(hasContent ? "Added CodeWeave instructions to CLAUDE.md" : "Created CLAUDE.md with CodeWeave instructions");
  } catch (err: any) {
    warn(`CLAUDE.md: failed to write — ${err.message}`);
  }
}

function updateGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, "utf-8");
  if (content.includes(".code-context")) return;
  const separator = content.endsWith("\n") ? "" : "\n";
  try {
    const tmpPath = gitignorePath + ".tmp";
    writeFileSync(tmpPath, content + separator + ".code-context/\n");
    renameSync(tmpPath, gitignorePath);
    ok("Added .code-context/ to .gitignore");
  } catch { /* non-critical */ }
}

function printSummary(installFailed: boolean): void {
  console.log("\n========================================");
  console.log(installFailed ? "  Setup incomplete — see warnings above" : "  Setup complete!");
  console.log("========================================\n");
  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) console.log(`    ⚠ ${w}`);
    console.log();
  }
  console.log("  Open this project in Claude Code.");
  console.log("  Try: 'find the authentication code'");
  console.log("  Or:  'what calls this function?'\n");
}

// === Main ===

async function main() {
  console.log("\n@codeweave/mcp — Setup\n");

  if (os.platform() === "win32" && !SKIP_OLLAMA && !commandExists("ollama")) {
    log("Note: Setup will download ~2.5 GB (Ollama + embedding model).");
  }

  const cwd = await validateProjectDir();

  nextStep("Installing @codeweave/mcp...");
  const { forceReindex, installFailed } = await installOrUpdatePackage();

  if (!SKIP_OLLAMA) {
    nextStep("Installing Ollama...");
    installOllama();
    nextStep("Downloading embedding model...");
    await pullEmbeddingModel();
  }

  nextStep("Configuring MCP clients...");
  configureMcpClients(cwd, installFailed);

  if (!SKIP_INDEX) {
    nextStep("Indexing project...");
    indexProject(cwd, forceReindex);
  }

  updateGitignore(cwd);
  await injectClaudeMd(cwd);
  printSummary(installFailed);
}

main().catch(err => {
  fail(`Setup failed: ${err.message || err}`);
  process.exit(1);
});
