import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(process.env.SFSC_CLIENT_PACKAGE_DIR || join(projectRoot, "dist", "SyncraftDesktop"));
const jsonReportPath = readArg("--json-report") || process.env.SFSC_CLIENT_PACKAGE_JSON_REPORT || "";
const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const checks = [];
let releaseManifestSummary = null;
let packageLaunchSummary = null;
let currentCheck = "startup";
let smokeOk = false;
let smokeError = null;

try {
  await main();
  smokeOk = true;
} catch (error) {
  smokeError = error;
  console.error(`Failed check: ${error?.check || currentCheck}`);
  console.error(error?.message || error);
  process.exitCode = 1;
} finally {
  writeClientPackageJsonReport(smokeOk, smokeError);
}

async function main() {
  await runCheck("package-root", () => requireDirectory(packageRoot, "package root"));
  await runCheck("client-exe", () => requireFile(join(packageRoot, "Syncraft.exe"), "client exe", { nonEmpty: true }));
  const manifest = await runCheck("release-manifest", () => requireReleaseManifest(packageRoot));
  const isPortablePackage = manifest.package === "SyncraftClient";
  const isDesktopPackage = manifest.package === "SyncraftDesktop";

  const appRoot = isPortablePackage ? join(packageRoot, "app") : join(packageRoot, "resources", "app");
  await runCheck("resources-app", () => requireDirectory(appRoot, "resources app"));
  await runCheck("package-json", () => requirePackageJson(appRoot, manifest.package));

  const requiredAppFiles = [
    ["client local API", "client/src/clientServer.js"],
    ["client paths", "client/src/paths.js"],
    ["client local state store", "client/src/store.js"],
    ["client enrollment session", "client/src/enrollmentSession.js"],
    ["client enrollment diagnostics", "client/src/enrollmentDiagnostics.js"],
    ["client SFTP access marker", "client/src/sftpAccessMarker.js"],
    ["client bootstrap transport", "client/src/bootstrapTransport.js"],
    ["client diagnostic bundle", "client/src/diagnosticBundle.js"],
    ["client process runner", "client/src/processRunner.js"],
    ["client rclone stats parser", "client/src/rcloneStats.js"],
    ["client profile import", "client/src/profileImport.js"],
    ["client node launcher", "client/src/launcher.cjs"],
    ["client Windows launcher source", "client/src/Launcher.cs"],
    ["client UI html", "client/public/index.html"],
    ["client UI app", "client/public/app.js"],
    ["client UI styles", "client/public/styles.css"],
    ["shared core", "src/core/index.js"],
    ["channel import code", "src/core/channelImportCode.js"]
  ];
  if (isDesktopPackage) {
    requiredAppFiles.unshift(
      ["electron main", "client/electron/main.cjs"],
      ["electron preload", "client/electron/preload.cjs"]
    );
  }
  await runCheck("app-files", async () => {
    for (const [label, path] of requiredAppFiles) {
      await requireFile(join(appRoot, ...path.split("/")), label, { nonEmpty: true });
    }
  });
  await runCheck("health-readiness", () => requireHealthReadiness(appRoot));

  const supportRoot = isPortablePackage ? join(packageRoot, "resources", "app", "docs") : join(appRoot, "docs");
  await runCheck("support-docs", async () => {
    for (const [label, filename] of [
      ["interface contract", "INTERFACE_CONTRACT.md"],
      ["API matrix", "API_MATRIX.md"],
      ["deployment and migration guide", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"],
      ["internal trial checklist", "INTERNAL_TRIAL_CHECKLIST.md"],
      ["pilot runbook", "PILOT_RUNBOOK.md"],
      ["pilot acceptance criteria", "PILOT_ACCEPTANCE_CRITERIA.md"],
      ["pilot support guide", "PILOT_SUPPORT_GUIDE.md"]
    ]) {
      await requireFile(join(supportRoot, filename), label, { nonEmpty: true });
    }
  });

  if (isDesktopPackage) {
    await runCheck("electron-bridge", () => requireElectronBridge(appRoot));
  } else {
    await runCheck("portable-node-runtime", () => requireFile(join(packageRoot, "runtime", "node.exe"), "portable node runtime", { nonEmpty: true }));
  }

  await runCheck("bundled-binaries", async () => {
    for (const binary of ["sing-box.exe", "rclone.exe"]) {
      await requireFile(join(packageRoot, "resources", "bin", "win32", binary), binary, { nonEmpty: true });
    }
    await requireBinaryLockContract(packageRoot);
  });

  await runCheck("runtime-state-absent", async () => {
    for (const blocked of [
      "data",
      "resources/app/data",
      "resources/app/client/data",
      "resources/app/server/data",
      "resources/app/server/.env",
      "resources/app/.env"
    ]) {
      await requireMissing(join(packageRoot, ...blocked.split("/")), blocked);
    }
  });
  if (process.env.SFSC_CLIENT_PACKAGE_SKIP_LAUNCH === "1") {
    checks.push("package launch skipped by SFSC_CLIENT_PACKAGE_SKIP_LAUNCH=1");
  } else {
    await runCheck("package-launch", () => requirePackageLaunch(packageRoot, manifest.package));
  }

  if (checks.length) {
    console.log(`SFSC client package smoke passed: ${packageRoot}`);
    for (const check of checks) {
      console.log(`- ${check}`);
    }
  }
}

async function runCheck(name, task) {
  currentCheck = name;
  try {
    return await task();
  } catch (error) {
    if (error && typeof error === "object" && !error.check) {
      error.check = name;
    }
    throw error;
  }
}

async function requirePackageJson(appRoot, packageName) {
  const packageJsonPath = join(appRoot, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageName === "SyncraftDesktop" && pkg.name !== "syncraft-desktop") {
    throw new Error(`Expected packaged app name syncraft-desktop, got ${pkg.name || "(missing)"}.`);
  }
  if (pkg.version !== rootPackage.version) {
    throw new Error(`Expected packaged app version ${rootPackage.version}, got ${pkg.version || "(missing)"}.`);
  }
  if (pkg.type !== "module") {
    throw new Error(`Expected packaged app type=module, got ${pkg.type || "(missing)"}.`);
  }
  if (packageName === "SyncraftDesktop" && pkg.main !== "client/electron/main.cjs") {
    throw new Error(`Expected packaged app main=client/electron/main.cjs, got ${pkg.main || "(missing)"}.`);
  }
  checks.push(`app package version=${pkg.version}`);
}

async function requireReleaseManifest(packageRoot) {
  const manifestPath = join(packageRoot, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Expected release manifest schemaVersion=1, got ${manifest.schemaVersion || "(missing)"}.`);
  }
  if (manifest.app !== "singbox-folder-sync") {
    throw new Error(`Expected release manifest app=singbox-folder-sync, got ${manifest.app || "(missing)"}.`);
  }
  if (!["SyncraftDesktop", "SyncraftClient"].includes(manifest.package)) {
    throw new Error(`Expected release manifest package=SyncraftDesktop or SyncraftClient, got ${manifest.package || "(missing)"}.`);
  }
  if (manifest.version !== rootPackage.version) {
    throw new Error(`Expected release manifest version ${rootPackage.version}, got ${manifest.version || "(missing)"}.`);
  }
  if (typeof manifest.builtAt !== "string" || !Number.isFinite(new Date(manifest.builtAt).getTime())) {
    throw new Error(`Expected release manifest builtAt to be an ISO timestamp, got ${manifest.builtAt || "(missing)"}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceTreeHash || "")) {
    throw new Error("Expected release manifest sourceTreeHash to be a SHA256 hash.");
  }
  if (manifest.buildId !== `sfsc-${manifest.sourceTreeHash.slice(0, 12)}`) {
    throw new Error("Expected release manifest buildId to match sourceTreeHash.");
  }
  if (!manifest.sourceFingerprint || manifest.sourceFingerprint.hash !== manifest.sourceTreeHash || manifest.sourceFingerprint.buildId !== manifest.buildId) {
    throw new Error("Expected release manifest sourceFingerprint to match sourceTreeHash and buildId.");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Expected release manifest to include file checksums.");
  }
  releaseManifestSummary = {
    package: manifest.package,
    version: manifest.version,
    builtAt: manifest.builtAt,
    sourceTreeHash: manifest.sourceTreeHash,
    buildId: manifest.buildId,
    fileCount: manifest.files.length
  };
  validateManifestFileList(manifest.files);
  const requiredFiles = manifest.package === "SyncraftClient" ? [
    "Syncraft.exe",
    "app/package.json",
    "app/client/src/clientServer.js",
    "app/client/src/paths.js",
    "app/client/src/store.js",
    "app/client/src/enrollmentSession.js",
    "app/client/src/enrollmentDiagnostics.js",
    "app/client/src/sftpAccessMarker.js",
    "app/client/src/connectionRepair.js",
    "app/client/src/firstBisyncConflict.js",
    "app/client/src/syncRecovery.js",
    "app/src/core/dataAuthorization.js",
    "app/client/src/bootstrapTransport.js",
    "app/client/src/diagnosticBundle.js",
    "app/client/src/processRunner.js",
    "app/client/src/rcloneStats.js",
    "app/client/src/profileImport.js",
    "app/client/src/launcher.cjs",
    "app/client/src/Launcher.cs",
    "app/client/public/index.html",
    "app/client/public/app.js",
    "app/client/public/styles.css",
    "app/src/core/index.js",
    "app/src/core/channelImportCode.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ] : [
    "Syncraft.exe",
    "resources/app/package.json",
    "resources/app/client/electron/main.cjs",
    "resources/app/client/electron/preload.cjs",
    "resources/app/client/src/clientServer.js",
    "resources/app/client/src/paths.js",
    "resources/app/client/src/store.js",
    "resources/app/client/src/enrollmentSession.js",
    "resources/app/client/src/enrollmentDiagnostics.js",
    "resources/app/client/src/sftpAccessMarker.js",
    "resources/app/client/src/connectionRepair.js",
    "resources/app/client/src/firstBisyncConflict.js",
    "resources/app/client/src/syncRecovery.js",
    "resources/app/src/core/dataAuthorization.js",
    "resources/app/client/src/bootstrapTransport.js",
    "resources/app/client/src/diagnosticBundle.js",
    "resources/app/client/src/processRunner.js",
    "resources/app/client/src/rcloneStats.js",
    "resources/app/client/src/profileImport.js",
    "resources/app/client/src/launcher.cjs",
    "resources/app/client/src/Launcher.cs",
    "resources/app/client/public/index.html",
    "resources/app/client/public/app.js",
    "resources/app/client/public/styles.css",
    "resources/app/src/core/index.js",
    "resources/app/src/core/channelImportCode.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ];
  for (const required of requiredFiles) {
    const entry = manifest.files.find((file) => file?.name === required);
    if (!entry) {
      throw new Error(`Release manifest missing file entry: ${required}`);
    }
    if (!Number.isFinite(entry.size) || entry.size <= 0) {
      throw new Error(`Release manifest has invalid size for ${required}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      throw new Error(`Release manifest has invalid sha256 for ${required}.`);
    }
    const actualPath = join(packageRoot, ...required.split("/"));
    const data = await readFile(actualPath);
    const actualHash = createHash("sha256").update(data).digest("hex");
    if (entry.size !== data.length) {
      throw new Error(`Release manifest size mismatch for ${required}.`);
    }
    if (entry.sha256 !== actualHash) {
      throw new Error(`Release manifest sha256 mismatch for ${required}.`);
    }
  }
  checks.push(`release manifest version=${manifest.version}, files=${manifest.files.length}`);
  return manifest;
}

function validateManifestFileList(files) {
  const seen = new Set();
  for (const file of files) {
    const name = normalizeManifestFileName(file?.name);
    if (!name) {
      throw new Error("Release manifest contains a file entry without a valid name.");
    }
    if (seen.has(name)) {
      throw new Error(`Release manifest contains duplicate file entry: ${name}`);
    }
    seen.add(name);
    if (isBlockedManifestFileName(name)) {
      throw new Error(`Release manifest contains runtime state or secret file entry: ${name}`);
    }
  }
}

function normalizeManifestFileName(name) {
  if (typeof name !== "string") {
    return "";
  }
  const normalized = name.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return "";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return "";
  }
  return parts.join("/");
}

function isBlockedManifestFileName(name) {
  return name === ".env"
    || name === "data"
    || name.startsWith("data/")
    || name === "resources/app/.env"
    || name === "resources/app/data"
    || name.startsWith("resources/app/data/")
    || name === "resources/app/client/data"
    || name.startsWith("resources/app/client/data/")
    || name === "resources/app/server/.env"
    || name === "resources/app/server/data"
    || name.startsWith("resources/app/server/data/");
}

async function requireBinaryLockContract(packageRoot) {
  const binRoot = join(packageRoot, "resources", "bin", "win32");
  const lockPath = join(binRoot, "binaries.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !lock.tools || typeof lock.tools !== "object") {
    throw new Error("Expected binaries.lock.json schemaVersion=1 with tools.");
  }
  for (const [toolName, exeName] of [["sing-box", "sing-box.exe"], ["rclone", "rclone.exe"]]) {
    const tool = lock.tools[toolName];
    if (!tool || typeof tool !== "object") {
      throw new Error(`Expected binaries.lock.json to include tool ${toolName}.`);
    }
    if (tool.exe !== exeName) {
      throw new Error(`Expected binaries.lock.json ${toolName}.exe to be ${exeName}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(tool.sha256 || "")) {
      throw new Error(`Expected binaries.lock.json ${toolName}.sha256 to be a SHA256 hash.`);
    }
    const actual = createHash("sha256").update(await readFile(join(binRoot, exeName))).digest("hex");
    if (actual !== tool.sha256) {
      throw new Error(`${exeName} does not match binaries.lock.json SHA256.`);
    }
  }
  checks.push("binary lock hashes verified");
}

async function requireElectronBridge(appRoot) {
  const main = await readFile(join(appRoot, "client", "electron", "main.cjs"), "utf8");
  const preload = await readFile(join(appRoot, "client", "electron", "preload.cjs"), "utf8");

  requirePattern(main, /ipcMain\.handle\(["']sfsc:pick-folder["']/, "Electron main must register the native folder picker IPC handler.");
  requirePattern(main, /showOpenDialog/, "Electron main must use the native open-directory dialog.");
  requirePattern(main, /openDirectory/, "Electron native picker must allow directory selection.");
  requirePattern(main, /createDirectory/, "Electron native picker must allow creating a directory.");
  requirePattern(main, /contextIsolation:\s*true/, "Electron window must keep contextIsolation enabled.");
  requirePattern(main, /nodeIntegration:\s*false/, "Electron renderer must keep nodeIntegration disabled.");
  requirePattern(main, /sandbox:\s*true/, "Electron renderer must keep sandbox enabled.");
  requirePattern(main, /app\.commandLine\.appendSwitch\(["']disable-gpu-sandbox["']\)/, "Electron must apply the Windows GPU sandbox crash workaround.");
  if (/appendSwitch\(["']no-sandbox["']\)/.test(main)) {
    throw new Error("Electron must not disable the renderer sandbox globally.");
  }
  requirePattern(main, /preload:\s*path\.join\(__dirname,\s*["']preload\.cjs["']\)/, "Electron window must load the packaged preload bridge.");

  requirePattern(preload, /contextBridge\.exposeInMainWorld\(["']sfscDesktop["']/, "Preload must expose the sfscDesktop bridge.");
  requirePattern(preload, /pickFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(["']sfsc:pick-folder["']\)/, "Preload must expose only the folder picker IPC call.");
  checks.push("native folder picker bridge verified");
}

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

async function requireHealthReadiness(appRoot) {
  const clientServer = await readFile(join(appRoot, "client", "src", "clientServer.js"), "utf8");
  const pathsSource = await readFile(join(appRoot, "client", "src", "paths.js"), "utf8");
  const storeSource = await readFile(join(appRoot, "client", "src", "store.js"), "utf8");
  const nodeLauncher = await readFile(join(appRoot, "client", "src", "launcher.cjs"), "utf8");
  const csharpLauncher = await readFile(join(appRoot, "client", "src", "Launcher.cs"), "utf8");

  requirePattern(clientServer, /url\.pathname === ["']\/api\/health["']/, "Client runtime must expose the lightweight local health endpoint.");
  requirePattern(clientServer, /api\/health/, "Client runtime readiness checks must use the lightweight local health endpoint.");
  requirePattern(clientServer, /isSfscClientHealth/, "Client runtime must validate that occupied-port health belongs to an SFSC client.");
  requirePattern(clientServer, /mode === ["']client-exe-runtime["']/, "Client runtime readiness must require client-exe-runtime mode.");
  requirePattern(clientServer, /diagnostics\?\.role === ["']client["']/, "Client runtime readiness must require client diagnostics role.");
  requirePattern(nodeLauncher, /api\/health/, "Portable Node launcher must use the lightweight local health endpoint.");
  requirePattern(nodeLauncher, /isSfscClientHealth/, "Portable Node launcher must validate SFSC client health, not only HTTP 200.");
  requirePattern(nodeLauncher, /mode === ["']client-exe-runtime["']/, "Portable Node launcher readiness must require client-exe-runtime mode.");
  requirePattern(nodeLauncher, /diagnostics\?\.role === ["']client["']/, "Portable Node launcher readiness must require client diagnostics role.");
  requirePattern(csharpLauncher, /api\/health/, "Windows launcher must use the lightweight local health endpoint.");
  requirePattern(csharpLauncher, /IsSfscClientHealth/, "Windows launcher must validate SFSC client health, not only HTTP 200.");
  requirePattern(csharpLauncher, /client-exe-runtime/, "Windows launcher readiness must require client-exe-runtime mode.");
  requirePattern(csharpLauncher, /HasJsonString\(body,\s*["']role["'],\s*["']client["']\)/, "Windows launcher readiness must require client diagnostics role.");
  if (/api\/client\/status/.test(nodeLauncher) || /api\/client\/status/.test(csharpLauncher)) {
    throw new Error("Client launchers must not use /api/client/status for readiness checks.");
  }
  requirePattern(pathsSource, /SFSC_CLIENT_DATA_ROOT[\s\S]*SFSC_DATA_ROOT/, "Client paths must support explicit data root environment overrides.");
  requirePattern(pathsSource, /LOCALAPPDATA/, "Client paths must fall back to the current user's LocalAppData directory.");
  requirePattern(pathsSource, /ensureWritableDataRoot/, "Client startup must probe data root writability before using package data.");
  requirePattern(pathsSource, /applyDataRoot/, "Client startup must rewrite runtime file paths after data root fallback.");
  requirePattern(storeSource, /protectSecretVaultFile/, "Client secret vault writes must apply local file protection.");
  requirePattern(storeSource, /icacls\.exe/, "Windows client secret vault must use ACL protection for the file backend.");
  requirePattern(storeSource, /protected:\s*protection\.protected/, "Client secret vault status must expose protection state.");
  checks.push("local health readiness endpoint verified");
}

async function requirePackageLaunch(packageRoot, packageName) {
  const port = await getRandomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Keep launch state beneath the repository so constrained build agents can
  // grant the packaged process write access without opening the system temp
  // directory. The directory is unique and removed in the finally block.
  const smokeTempRoot = join(projectRoot, ".tmp", "client-package-smoke");
  mkdirSync(smokeTempRoot, { recursive: true });
  const dataRoot = await mkdtemp(join(smokeTempRoot, `${packageName}-${port}-`));
  const exePath = join(packageRoot, "Syncraft.exe");
  let child = null;
  const startedAt = Date.now();
  try {
    child = spawn(exePath, [], {
      cwd: packageRoot,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SFSC_CLIENT_PORT: String(port),
        SFSC_CLIENT_DATA_ROOT: dataRoot,
        SFSC_OPEN_BROWSER: "0",
        SFSC_PACKAGE_SMOKE: "1"
      }
    });
    child.on("error", () => {});
    const health = await waitForJson(`${baseUrl}/api/health`, {
      timeoutMs: 20000,
      expectDown: false
    });
    requirePackageHealth(health);
    const status = await fetchJson(`${baseUrl}/api/client/status`);
    requirePackageStatus(status, dataRoot);
    const shutdown = await fetchJson(`${baseUrl}/api/client/shutdown`, { method: "POST" });
    if (shutdown?.ok !== true || Object.keys(shutdown || {}).length !== 1) {
      throw new Error("Packaged client shutdown response did not match { ok: true }.");
    }
    await waitForJson(`${baseUrl}/api/health`, {
      timeoutMs: 8000,
      expectDown: true
    });
    packageLaunchSummary = {
      packageName,
      port,
      dataRoot,
      elapsedMs: Date.now() - startedAt
    };
    checks.push(`package launch verified: ${packageName} port=${port}`);
  } finally {
    await fetchJson(`${baseUrl}/api/client/shutdown`, { method: "POST", timeoutMs: 800 }).catch(() => {});
    if (child && child.exitCode === null) {
      child.kill();
    }
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function requirePackageHealth(health) {
  if (health?.ok !== true) {
    throw new Error("Packaged client /api/health did not return ok=true.");
  }
  if (health.mode !== "client-exe-runtime") {
    throw new Error(`Packaged client /api/health mode mismatch: ${health.mode || "(missing)"}.`);
  }
  if (health.diagnostics?.role !== "client") {
    throw new Error("Packaged client /api/health diagnostics.role must be client.");
  }
}

function requirePackageStatus(status, dataRoot) {
  if (status?.ok !== true || status.mode !== "client-exe-runtime") {
    throw new Error("Packaged client /api/client/status did not return the client runtime status.");
  }
  if (status.releaseManifest?.ok !== true) {
    throw new Error("Packaged client status releaseManifest.ok must be true.");
  }
  if (resolve(status.paths?.dataRoot || "") !== resolve(dataRoot)) {
    throw new Error(`Packaged client used unexpected data root: ${status.paths?.dataRoot || "(missing)"}.`);
  }
  if (status.safeguards?.secretVault?.protected !== false || status.safeguards?.secretVault?.protection?.exists !== false) {
    throw new Error("Fresh packaged client secret vault should report missing/unprotected until secrets are imported.");
  }
}

async function getRandomPort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

async function waitForJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const expectDown = options.expectDown === true;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const body = await fetchJson(url);
      if (expectDown) {
        lastError = new Error("endpoint still responds");
      } else {
        return body;
      }
    } catch (error) {
      if (expectDown) {
        return null;
      }
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(expectDown
    ? `Timed out waiting for packaged client to stop: ${url}`
    : `Timed out waiting for packaged client readiness: ${url}; last error: ${lastError?.message || "unknown"}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.method === "POST" ? { "content-type": "application/json" } : undefined,
    body: options.method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 1500)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return body;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function requireDirectory(path, label) {
  const info = await stat(path).catch((error) => {
    throw new Error(`Missing ${label}: ${path} (${error.code || error.message})`);
  });
  if (!info.isDirectory()) {
    throw new Error(`Expected ${label} to be a directory: ${path}`);
  }
  checks.push(`${label}: ${path}`);
}

async function requireFile(path, label, options = {}) {
  const info = await stat(path).catch((error) => {
    throw new Error(`Missing ${label}: ${path} (${error.code || error.message})`);
  });
  if (!info.isFile()) {
    throw new Error(`Expected ${label} to be a file: ${path}`);
  }
  if (options.nonEmpty && info.size <= 0) {
    throw new Error(`Expected ${label} to be non-empty: ${path}`);
  }
  checks.push(`${label}: ${info.size} bytes`);
}

async function requireMissing(path, label) {
  const info = await stat(path).catch((error) => {
    if (error.code === "ENOENT") {
      checks.push(`runtime state absent: ${label}`);
      return null;
    }
    throw error;
  });
  if (!info) return;
  const children = info.isDirectory() ? await readdir(path).catch(() => []) : [];
  throw new Error(`Packaged client must not include runtime state or secrets: ${label}${children.length ? ` (${children.join(", ")})` : ""}`);
}

function writeClientPackageJsonReport(ok, error) {
  if (!jsonReportPath) {
    return;
  }
  const reportPath = resolve(jsonReportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "client-package-smoke-report",
    ok,
    context: {
      generatedAt: new Date().toISOString(),
      packageRoot,
      rootPackageVersion: rootPackage.version,
      packageName: releaseManifestSummary?.package || "",
      manifestVersion: releaseManifestSummary?.version || "",
      manifestBuiltAt: releaseManifestSummary?.builtAt || null,
      sourceTreeHash: releaseManifestSummary?.sourceTreeHash || "",
      buildId: releaseManifestSummary?.buildId || "",
      manifestFileCount: releaseManifestSummary?.fileCount || 0,
      launch: packageLaunchSummary
    },
    summary: {
      passed: checks.length,
      failed: ok ? 0 : 1
    },
    checks,
    failure: ok ? null : {
      check: error?.check || currentCheck,
      message: error?.message || String(error || "unknown error")
    }
  };
  writeJsonReportSync(reportPath, payload, "client package smoke report");
  console.log(`SFSC client package smoke JSON report written: ${reportPath}`);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}
