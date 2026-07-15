import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJsonReport as writeJsonReportFile } from "./lib/reportSecrets.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(readArg("--package-dir") || process.env.SFSC_ELECTRON_SMOKE_PACKAGE_DIR || join(projectRoot, "dist", "SyncraftDesktop"));
const jsonReportPath = readArg("--json-report") || process.env.SFSC_ELECTRON_SMOKE_JSON_REPORT || "";
const checks = [];
let currentCheck = "startup";
let context = {};

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Node.js WebSocket global is required for Electron window smoke.");
  }
  const manifest = await runCheck("release-manifest", () => readDesktopManifest());
  const clientPort = await getRandomPort();
  const debugPort = await getRandomPort();
  const dataRoot = await mkdtemp(join(tmpdir(), `sfsc-electron-window-data-${clientPort}-`));
  const userDataRoot = await mkdtemp(join(tmpdir(), `sfsc-electron-window-user-${debugPort}-`));
  const exePath = join(packageRoot, "Syncraft.exe");
  context = {
    packageRoot,
    packageName: manifest.package,
    manifestVersion: manifest.version,
    manifestBuiltAt: manifest.builtAt,
    manifestFileCount: manifest.files.length,
    clientPort,
    debugPort,
    dataRoot
  };

  let child = null;
  let cdp = null;
  try {
    child = spawn(exePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataRoot}`,
      "--no-first-run",
      "--no-default-browser-check"
    ], {
      cwd: packageRoot,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SFSC_CLIENT_PORT: String(clientPort),
        SFSC_CLIENT_DATA_ROOT: dataRoot,
        SFSC_OPEN_BROWSER: "0"
      }
    });
    child.on("error", () => {});
    checks.push(`desktop exe launched: ${exePath}`);

    const page = await runCheck("window-ready", () => waitForInspectablePage(debugPort));
    cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await runCheck("window-ui", () => verifyWindowUi(cdp, clientPort));
    await runCheck("settings-drawer", () => verifySettingsDrawer(cdp));
    await runCheck("diagnostic-export", () => verifyDiagnosticExport(cdp));
    await runCheck("tray-residency", () => verifyTrayResidency(cdp, child, clientPort));
    checks.push(`electron window smoke verified: port=${clientPort}, debug=${debugPort}`);
  } finally {
    if (cdp) {
      await cdp.close().catch(() => {});
    }
    await fetchJson(`http://127.0.0.1:${clientPort}/api/client/shutdown`, { method: "POST", timeoutMs: 800 }).catch(() => {});
    if (child && child.exitCode === null) {
      child.kill();
    }
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    await rm(userDataRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`SFSC Electron window smoke passed: ${packageRoot}`);
  for (const check of checks) {
    console.log(`- ${check}`);
  }
}

async function readDesktopManifest() {
  const manifestPath = join(packageRoot, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.app !== "singbox-folder-sync" || manifest.package !== "SyncraftDesktop") {
    throw new Error(`Expected SyncraftDesktop release manifest, got ${manifest.package || "(missing)"}.`);
  }
  const exeEntry = manifest.files?.find((file) => file.name === "Syncraft.exe");
  if (!exeEntry) {
    throw new Error("Desktop release manifest is missing Syncraft.exe.");
  }
  const exeHash = createHash("sha256").update(await readFile(join(packageRoot, "Syncraft.exe"))).digest("hex");
  if (exeEntry.sha256 !== exeHash) {
    throw new Error("Desktop executable hash does not match release manifest.");
  }
  checks.push(`release manifest version=${manifest.version}, files=${manifest.files.length}`);
  return manifest;
}

async function verifyWindowUi(cdp, clientPort) {
  const result = await waitForEvaluate(cdp, `(() => {
    const text = (id) => document.getElementById(id)?.textContent?.trim() || "";
    return {
      readyState: document.readyState,
      title: document.title,
      url: location.href,
      hasDesktopBridge: typeof window.sfscDesktop?.pickFolder === "function",
      settingsButton: !!document.getElementById("settingsBtn"),
      exportButton: !!document.getElementById("exportDiagnosticsBtn"),
      localFolderInput: !!document.getElementById("localPath"),
      actionMessage: text("actionMessage")
    };
  })()`, (value) => value.readyState === "complete" && value.settingsButton && value.exportButton);
  if (result.title !== "Syncraft") {
    throw new Error(`Unexpected window title: ${result.title}`);
  }
  if (result.url !== `http://127.0.0.1:${clientPort}/`) {
    throw new Error(`Unexpected renderer URL: ${result.url}`);
  }
  if (result.hasDesktopBridge !== true) {
    throw new Error("Electron preload did not expose window.sfscDesktop.pickFolder.");
  }
  if (result.localFolderInput !== true) {
    throw new Error("Client UI did not render the local folder input.");
  }
  checks.push("window rendered client UI with native bridge");
}

async function verifySettingsDrawer(cdp) {
  await cdp.evaluate(`document.getElementById("settingsBtn").click()`);
  const state = await waitForEvaluate(cdp, `(() => ({
    panelHidden: document.getElementById("settingsPanel").hidden,
    scrimHidden: document.getElementById("settingsScrim").hidden,
    clientVersionText: document.getElementById("clientVersion")?.textContent?.trim() || "",
    releaseManifestText: document.getElementById("releaseManifestStatus")?.textContent?.trim() || ""
  }))()`, (value) => value.panelHidden === false && value.scrimHidden === false);
  if (!state.clientVersionText) {
    throw new Error("Settings drawer did not expose client version text.");
  }
  checks.push(`settings drawer opened: clientVersion=${state.clientVersionText}`);
}

async function verifyDiagnosticExport(cdp) {
  await cdp.evaluate(`(() => {
    window.__sfscDownloadTriggered = null;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick() {
      window.__sfscDownloadTriggered = {
        download: this.download || "",
        hrefPrefix: String(this.href || "").slice(0, 32)
      };
      return undefined;
    };
    window.__sfscRestoreAnchorClick = () => {
      HTMLAnchorElement.prototype.click = originalClick;
    };
  })()`);
  await cdp.evaluate(`document.getElementById("exportDiagnosticsBtn").click()`);
  const result = await waitForEvaluate(cdp, `(() => ({
    action: document.getElementById("actionMessage")?.textContent?.trim() || "",
    download: window.__sfscDownloadTriggered
  }))()`, (value) => Boolean(value.download?.download) && value.action.includes("脱敏诊断包已导出"));
  await cdp.evaluate(`window.__sfscRestoreAnchorClick && window.__sfscRestoreAnchorClick()`).catch(() => {});
  if (!/^sfsc-client-diagnostics-.*\.json$/.test(result.download.download)) {
    throw new Error(`Unexpected diagnostic download filename: ${result.download.download}`);
  }
  if (!String(result.download.hrefPrefix).startsWith("blob:")) {
    throw new Error("Diagnostic export did not create a blob download URL.");
  }
  checks.push(`diagnostic export button triggered: ${result.download.download}`);
}

async function verifyTrayResidency(cdp, child, clientPort) {
  await cdp.send("Page.close");
  await delay(500);
  if (child.exitCode !== null) {
    throw new Error(`Desktop process exited after its window was closed: ${child.exitCode}`);
  }
  const health = await fetchJson(`http://127.0.0.1:${clientPort}/api/health`, { timeoutMs: 1500 });
  if (health?.ok !== true || health?.mode !== "client-exe-runtime" || health?.diagnostics?.role !== "client") {
    throw new Error("Local client runtime stopped after the desktop window was closed.");
  }
  checks.push("window close kept the desktop process and local runtime resident");
}

async function waitForInspectablePage(debugPort) {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron inspectable page; last error: ${lastError?.message || "unknown"}`);
}

async function waitForEvaluate(cdp, expression, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await cdp.evaluate(expression);
    if (!predicate || predicate(lastValue)) {
      return lastValue;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for renderer condition. Last value: ${JSON.stringify(lastValue)}`);
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("error", () => {});
  }

  static connect(url) {
    return new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolveConnect(new CdpSession(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Failed to connect to Electron DevTools WebSocket.")), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(payload);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Renderer evaluation failed.");
    }
    return result.result?.value;
  }

  async close() {
    this.socket.close();
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

async function getRandomPort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
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

async function writeJsonReport(ok, error) {
  if (!jsonReportPath) return;
  const reportPath = resolve(jsonReportPath);
  const payload = {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "electron-window-smoke-report",
    ok,
    context: {
      generatedAt: new Date().toISOString(),
      ...context
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
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dirname(reportPath), { recursive: true })
      .then(() => writeJsonReportFile(reportPath, payload, "electron window smoke report"))
  );
  console.log(`SFSC Electron window smoke JSON report written: ${reportPath}`);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

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
  await writeJsonReport(smokeOk, smokeError);
}
