import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeImportProfile } from "../src/core/profileProtocol.js";
import { writeJsonReport as writeJsonReportFile } from "./lib/reportSecrets.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePackageRoot = resolve(readArg("--package-dir") || process.env.SFSC_ELECTRON_E2E_PACKAGE_DIR || join(projectRoot, "dist", "SyncraftDesktop"));
const jsonReportPath = readArg("--json-report") || process.env.SFSC_ELECTRON_E2E_JSON_REPORT || "";
const checks = [];
let currentCheck = "startup";
let context = {};

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Node.js WebSocket global is required for Electron E2E smoke.");
  }
  const manifest = await runCheck("release-manifest", () => readDesktopManifest(sourcePackageRoot));
  const clientPort = await getRandomPort();
  const debugPort = await getRandomPort();
  const dataRoot = await mkdtemp(join(tmpdir(), `sfsc-electron-e2e-data-${clientPort}-`));
  const localRoot = await mkdtemp(join(tmpdir(), `sfsc-electron-e2e-local-${clientPort}-`));
  const userDataRoot = await mkdtemp(join(tmpdir(), `sfsc-electron-e2e-user-${debugPort}-`));
  const packageTempRoot = await mkdtemp(join(tmpdir(), "sfsc-electron-e2e-package-"));
  const packageRoot = join(packageTempRoot, "SyncraftDesktop");
  const localFolder = join(localRoot, "SFSC 测试 A");
  const fakeToolLog = join(dataRoot, "fake-tools.jsonl");
  await runCheck("prepare-temporary-package", () => prepareTemporaryPackage(sourcePackageRoot, packageRoot));
  await mkdir(localFolder, { recursive: true });
  await writeFile(join(localFolder, "hello.txt"), "hello from electron e2e\n", "utf8");

  const fixture = buildProfileFixture(clientPort);
  const importCode = encodeImportProfile(fixture.profile, { format: "code" });
  const exePath = join(packageRoot, "Syncraft.exe");
  context = {
    sourcePackageRoot,
    packageRoot,
    packageName: manifest.package,
    manifestVersion: manifest.version,
    manifestBuiltAt: manifest.builtAt,
    manifestFileCount: manifest.files.length,
    clientPort,
    debugPort,
    dataRoot,
    localRoot,
    fakeToolLog
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
        SFSC_OPEN_BROWSER: "0",
        SFSC_HEARTBEAT_MS: "60000",
        SFSC_FAKE_TOOL_LOG: fakeToolLog,
        SFSC_FAKE_RAW_SECRET: fixture.secrets.storageSecret,
        SFSC_FAKE_TUNNEL_URI: fixture.profile.tunnel.uri,
        SFSC_FAKE_SYNC_EXIT_CODE: "0",
        SFSC_FAKE_SYNC_EXIT_DELAY_MS: "60000",
        SFSC_FAKE_SYNC_STOP_EXIT_CODE: "0",
        SFSC_FAKE_SYNC_STOP_DELAY_MS: "150"
      }
    });
    child.on("error", () => {});
    checks.push(`desktop exe launched: ${exePath}`);

    const page = await runCheck("window-ready", () => waitForInspectablePage(debugPort));
    cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await runCheck("window-ui", () => verifyWindowUi(cdp, clientPort));
    await runCheck("profile-import", () => importProfileThroughUi(cdp, clientPort, importCode, fixture));
    await runCheck("folder-job-save", () => saveJobThroughUi(cdp, clientPort, localFolder));
    await runCheck("sync-preview", () => previewThroughUi(cdp, fixture));
    await runCheck("sync-run-stop-history", () => runStopSyncThroughUi(cdp, clientPort, fakeToolLog, fixture));
    await runCheck("diagnostic-export-json", () => verifyDiagnosticExportJson(cdp, fixture));
    checks.push(`electron e2e smoke verified: port=${clientPort}, debug=${debugPort}`);
  } finally {
    if (cdp) {
      await cdp.close().catch(() => {});
    }
    await fetchJson(`http://127.0.0.1:${clientPort}/api/client/shutdown`, { method: "POST", timeoutMs: 800 }).catch(() => {});
    if (child && child.exitCode === null) {
      child.kill();
    }
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    await rm(localRoot, { recursive: true, force: true }).catch(() => {});
    await rm(userDataRoot, { recursive: true, force: true }).catch(() => {});
    await rm(packageTempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }

  console.log(`SFSC Electron E2E smoke passed: ${sourcePackageRoot}`);
  for (const check of checks) {
    console.log(`- ${check}`);
  }
}

function buildProfileFixture(clientPort) {
  const secrets = {
    storageSecret: "e2e-storage-secret-do-not-leak",
    heartbeatSecret: "e2e-heartbeat-secret-do-not-leak",
    vlessId: "8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21"
  };
  const profile = {
    version: 1,
    profileId: `profile-electron-e2e-${clientPort}`,
    clientName: `e2e-pc-${clientPort}`,
    issuedAt: new Date(0).toISOString(),
    expiresAt: null,
    source: {
      type: "profile",
      server: `http://127.0.0.1:${clientPort}`
    },
    tunnel: {
      type: "vless",
      uri: `vless://${secrets.vlessId}@example.invalid:45678?encryption=none&security=none&type=tcp#electron-e2e`
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: secrets.heartbeatSecret
    },
    storage: {
      type: "s3",
      remoteName: "e2e-minio",
      endpoint: "http://127.0.0.1:19000",
      bucket: "sfsc-e2e-bucket",
      accessKeyId: "e2e-access-key",
      secretAccessKey: secrets.storageSecret,
      prefix: `devices/e2e-pc-${clientPort}`
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 2,
      streams: 2,
      checkers: 2,
      chunkSize: "8M",
      retries: 1,
      lowLevelRetries: 1,
      bandwidthLimit: "off",
      schedule: { mode: "manual" }
    }
  };
  return { profile, secrets };
}

async function readDesktopManifest(root) {
  const manifestPath = join(root, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.app !== "singbox-folder-sync" || manifest.package !== "SyncraftDesktop") {
    throw new Error(`Expected SyncraftDesktop release manifest, got ${manifest.package || "(missing)"}.`);
  }
  const exeEntry = manifest.files?.find((file) => file.name === "Syncraft.exe");
  if (!exeEntry) {
    throw new Error("Desktop release manifest is missing Syncraft.exe.");
  }
  const exeHash = createHash("sha256").update(await readFile(join(root, "Syncraft.exe"))).digest("hex");
  if (exeEntry.sha256 !== exeHash) {
    throw new Error("Desktop executable hash does not match release manifest.");
  }
  checks.push(`release manifest version=${manifest.version}, files=${manifest.files.length}`);
  return manifest;
}

async function prepareTemporaryPackage(fromRoot, toRoot) {
  await cp(fromRoot, toRoot, { recursive: true });
  await installFakeSyncTools(toRoot);
  checks.push(`temporary desktop package prepared with fake sync tools: ${toRoot}`);
}

async function installFakeSyncTools(root) {
  const binRoot = join(root, "resources", "bin", "win32");
  await mkdir(binRoot, { recursive: true });
  for (const name of ["sing-box.exe", "rclone.exe"]) {
    const target = join(binRoot, name);
    await copyFile(process.execPath, target);
    await chmod(target, 0o755).catch(() => {});
  }

  const prelude = String.raw`
const fs = require("node:fs");
const path = require("node:path");
function recordFakeTool(tool, extra = {}) {
  const log = process.env.SFSC_FAKE_TOOL_LOG;
  if (!log) return;
  const event = { tool, argv: process.argv.slice(2), ...extra };
  fs.appendFileSync(log, JSON.stringify(event) + "\n");
}
`;

  await writeFile(join(root, "run"), `${prelude}
const net = require("node:net");
recordFakeTool("singbox-run");
const configIndex = process.argv.indexOf("-c");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : "";
const config = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const inbound = Array.isArray(config.inbounds) ? config.inbounds[0] || {} : {};
const listen = inbound.listen || "127.0.0.1";
const port = Number(inbound.listen_port || 18081);
const server = net.createServer((socket) => socket.end());
server.listen(port, listen);
setInterval(() => {}, 1000);
`, "utf8");

  await writeFile(join(root, "check"), `${prelude}
recordFakeTool("singbox-check");
const exitCode = Number(process.env.SFSC_FAKE_SINGBOX_CHECK_EXIT_CODE || 0);
if (exitCode !== 0) {
  process.stderr.write("sing-box check failed\\n");
  process.exit(exitCode);
}
process.stdout.write("sing-box check ok\\n");
`, "utf8");

  await writeFile(join(root, "version"), `${prelude}
const executableName = path.basename(process.execPath).toLowerCase();
if (executableName.includes("rclone")) {
  recordFakeTool("rclone-version");
  process.stdout.write("rclone v1.74.3\\n");
} else {
  recordFakeTool("singbox-version");
  process.stdout.write("sing-box version 1.13.14\\n");
}
`, "utf8");

  await writeFile(join(root, "config"), `${prelude}
recordFakeTool("rclone-config");
function finishConfig() {
  const raw = process.env.SFSC_FAKE_RAW_SECRET || "";
  const tunnel = process.env.SFSC_FAKE_TUNNEL_URI || "";
  if (process.env.SFSC_FAKE_CONFIG_STDERR_SECRET === "1") {
    process.stderr.write("secret_access_key " + raw + "\\n");
    process.stderr.write("S3_SECRET_ACCESS_KEY=" + raw + "\\n");
    process.stderr.write("{\\"secretAccessKey\\":\\"" + raw + "\\"}\\n");
    process.stderr.write("bare-secret " + raw + "\\n");
    if (tunnel) process.stderr.write(tunnel + "\\n");
  }
  if (process.env.SFSC_FAKE_CONFIG_STDOUT_SECRET === "1") {
    process.stdout.write("stdout-secret " + raw + "\\n");
  }
  const exitCode = Number(process.env.SFSC_FAKE_CONFIG_EXIT_CODE || 0);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  const configIndex = process.argv.indexOf("--config");
  if (configIndex >= 0 && process.argv[configIndex + 1]) {
    const configPath = process.argv[configIndex + 1];
    if (process.env.SFSC_FAKE_CONFIG_SKIP_WRITE !== "1") {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "# fake rclone config\\n", "utf8");
    }
  }
  process.stdout.write("rclone config ok\\n");
}
const configDelayMs = Number(process.env.SFSC_FAKE_CONFIG_DELAY_MS || 0);
if (configDelayMs > 0) {
  setTimeout(finishConfig, configDelayMs);
} else {
  finishConfig();
}
`, "utf8");

  const syncScript = `${prelude}
recordFakeTool("rclone-sync", { allProxy: process.env.ALL_PROXY || "" });
const raw = process.env.SFSC_FAKE_RAW_SECRET || "";
process.stdout.write("Transferred: 1 MiB / 2 MiB, 50%, 1 MiB/s, ETA 1s\\n");
process.stderr.write("secret_access_key " + raw + "\\n");
process.stderr.write("S3_SECRET_ACCESS_KEY=" + raw + "\\n");
process.stderr.write("{\\"secretAccessKey\\":\\"" + raw + "\\"}\\n");
let exiting = false;
function exitAfterStop(signal) {
  if (exiting) return;
  exiting = true;
  recordFakeTool("rclone-sync-stop-signal", { signal });
  setTimeout(
    () => process.exit(Number(process.env.SFSC_FAKE_SYNC_STOP_EXIT_CODE || 0)),
    Number(process.env.SFSC_FAKE_SYNC_STOP_DELAY_MS || 500)
  );
}
process.on("SIGTERM", () => exitAfterStop("SIGTERM"));
process.on("SIGINT", () => exitAfterStop("SIGINT"));
setTimeout(
  () => process.exit(Number(process.env.SFSC_FAKE_SYNC_EXIT_CODE || 7)),
  Number(process.env.SFSC_FAKE_SYNC_EXIT_DELAY_MS || 100)
);
`;
  for (const action of ["copy", "sync", "bisync"]) {
    await writeFile(join(root, action), syncScript, "utf8");
  }
}

async function verifyWindowUi(cdp, clientPort) {
  const result = await waitForEvaluate(cdp, `(() => ({
    readyState: document.readyState,
    title: document.title,
    url: location.href,
    hasDesktopBridge: typeof window.sfscDesktop?.pickFolder === "function",
    settingsButton: !!document.getElementById("settingsBtn"),
    claimCode: !!document.getElementById("claimCode"),
    saveProfileButton: !!document.getElementById("saveProfileBtn"),
    saveJobButton: !!document.getElementById("saveJobBtn"),
    previewButton: !!document.getElementById("previewBtn"),
    exportButton: !!document.getElementById("exportDiagnosticsBtn")
  }))()`, (value) => value.readyState === "complete" && value.settingsButton && value.claimCode && value.saveJobButton);
  if (result.url !== `http://127.0.0.1:${clientPort}/`) {
    throw new Error(`Unexpected renderer URL: ${result.url}`);
  }
  if (result.hasDesktopBridge !== true) {
    throw new Error("Electron preload did not expose window.sfscDesktop.pickFolder.");
  }
  checks.push("window rendered E2E controls with native bridge");
}

async function importProfileThroughUi(cdp, clientPort, importCode, fixture) {
  await cdp.evaluate(`document.getElementById("settingsBtn").click()`);
  await waitForEvaluate(cdp, `(() => ({ hidden: document.getElementById("settingsPanel").hidden }))()`, (value) => value.hidden === false);
  await cdp.evaluate(`(() => {
    const field = document.getElementById("claimCode");
    field.value = ${JSON.stringify(importCode)};
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("saveProfileBtn").click();
  })()`);
  const status = await waitForFetchJson(clientPort, "/api/client/status", (value) => value.profileImported === true, 15000);
  if (!status.profileSummary?.clientName?.includes(fixture.profile.clientName)) {
    throw new Error(`Imported profile summary did not include expected client name ${fixture.profile.clientName}.`);
  }
  const profile = await fetchJson(`http://127.0.0.1:${clientPort}/api/profile`);
  const profileText = JSON.stringify(profile);
  assertDoesNotContainSecrets(profileText, fixture, "profile read response");
  checks.push(`profile imported through UI: ${fixture.profile.clientName}`);
}

async function saveJobThroughUi(cdp, clientPort, localFolder) {
  await cdp.evaluate(`(() => {
    const localPath = document.getElementById("localPath");
    localPath.value = ${JSON.stringify(localFolder)};
    localPath.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("direction").value = "upload";
    document.getElementById("direction").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("transfers").value = "2";
    document.getElementById("streams").value = "2";
    document.getElementById("saveJobBtn").click();
  })()`);
  await waitForEvaluate(cdp, `(() => ({
    action: document.getElementById("actionMessage")?.textContent?.trim() || ""
  }))()`, (value) => value.action.includes("同步任务已保存"), 15000);
  const jobs = await waitForFetchJson(clientPort, "/api/jobs", (value) => Array.isArray(value.jobs) && value.jobs.length === 1, 10000);
  if (jobs.jobs[0].localPath !== localFolder) {
    throw new Error("Saved job localPath did not match the UI input.");
  }
  checks.push("job saved through UI with imported profile defaults");
}

async function previewThroughUi(cdp, fixture) {
  await cdp.evaluate(`document.getElementById("previewBtn").click()`);
  const preview = await waitForEvaluate(cdp, `(() => ({
    text: document.getElementById("previewOutput")?.textContent || ""
  }))()`, (value) => value.text.includes("# rclone sync command") && value.text.includes("sfsc-e2e-bucket"), 15000);
  assertDoesNotContainSecrets(preview.text, fixture, "preview output");
  if (!preview.text.includes("# rclone remote config") || !preview.text.includes("# Remote path:")) {
    throw new Error("Preview output did not include the expected rclone preview sections.");
  }
  checks.push("sync preview generated through UI without leaking fixture secrets");
}

async function runStopSyncThroughUi(cdp, clientPort, fakeToolLog, fixture) {
  await cdp.evaluate(`document.getElementById("runSyncBtn").click()`);
  await acceptPreviewConfirmationIfVisible(cdp);
  try {
    await waitForFetchJson(clientPort, "/api/client/status", (value) => {
      return value.processes?.sync?.running === true
        || value.processes?.sync?.metrics?.syncState === "syncing";
    }, 20000);
  } catch (error) {
    const ui = await cdp.evaluate(`(() => ({
      action: document.getElementById("actionMessage")?.textContent?.trim() || "",
      runDisabled: Boolean(document.getElementById("runSyncBtn")?.disabled),
      confirmationVisible: document.getElementById("confirmGate")?.hidden === false,
      confirmationTitle: document.getElementById("confirmTitle")?.textContent?.trim() || ""
    }))()`);
    throw new Error(`${error.message}\nUI state: ${JSON.stringify(ui)}`);
  }
  const syncEvents = await waitForFakeToolEvent(fakeToolLog, "rclone-sync", 10000);
  if (!syncEvents.some((event) => event.tool === "singbox-run")) {
    throw new Error("Fake sing-box was not started before rclone sync.");
  }
  const syncEvent = syncEvents.find((event) => event.tool === "rclone-sync");
  if (!String(syncEvent?.allProxy || "").includes("127.0.0.1")) {
    throw new Error(`Fake rclone sync did not receive a local ALL_PROXY value: ${syncEvent?.allProxy || "(missing)"}`);
  }
  const runningUi = await cdp.evaluate(`(() => ({
    action: document.getElementById("actionMessage")?.textContent?.trim() || "",
    status: document.getElementById("syncStatus")?.textContent || ""
  }))()`);

  await cdp.evaluate(`document.getElementById("stopSyncBtn").click()`);
  const stoppedStatus = await waitForFetchJson(clientPort, "/api/client/status", (value) => {
    return value.processes?.sync?.running === false
      && ["idle", "error"].includes(value.processes?.sync?.metrics?.syncState);
  }, 20000);
  if (stoppedStatus.processes?.sync?.metrics?.lastRun?.status && stoppedStatus.processes.sync.metrics.lastRun.status !== "stopped") {
    throw new Error(`Expected stopped lastRun status after UI stop, got ${stoppedStatus.processes.sync.metrics.lastRun.status}.`);
  }
  const history = await waitForFetchJson(clientPort, "/api/sync/history", (value) => value.history?.[0]?.status === "stopped", 20000);
  const historyText = JSON.stringify(history);
  assertDoesNotContainSecrets(historyText, fixture, "sync history response");
  await waitForEvaluate(cdp, `(() => ({
    action: document.getElementById("actionMessage")?.textContent?.trim() || "",
    history: document.getElementById("syncHistoryList")?.textContent || ""
  }))()`, (value) => value.action.includes("同步已停止") || value.history.includes("已停止"), 10000);
  const stopSignalEvents = await readFakeToolEvents(fakeToolLog).catch(() => []);
  if (stopSignalEvents.some((event) => event.tool === "rclone-sync-stop-signal")) {
    checks.push("fake rclone observed stop signal before exit");
  } else {
    checks.push("fake rclone process stopped without signal handler log, as expected on some Windows process terminations");
  }
  if (!runningUi.action.includes("同步已开始") && !runningUi.status.includes("同步")) {
    checks.push(`sync run UI text was still settling before stop: action=${runningUi.action || "(empty)"}`);
  }
  checks.push(`sync run/stop/history verified through UI with fake rclone: ${history.history[0].id}`);
}

async function acceptPreviewConfirmationIfVisible(cdp) {
  await delay(100);
  const confirmation = await cdp.evaluate(`(() => ({
    visible: document.getElementById("confirmGate")?.hidden === false,
    title: document.getElementById("confirmTitle")?.textContent?.trim() || "",
    requiredText: document.getElementById("confirmTextInput")?.placeholder || ""
  }))()`);
  if (!confirmation.visible) return;
  if (confirmation.requiredText) {
    throw new Error(`Unexpected required-text confirmation before fake sync: ${confirmation.title || "unknown"}.`);
  }
  await cdp.evaluate(`document.getElementById("confirmSubmitBtn").click()`);
  checks.push(`accepted optional sync confirmation: ${confirmation.title || "unknown"}`);
}

async function verifyDiagnosticExportJson(cdp, fixture) {
  await cdp.evaluate(`(() => {
    window.__sfscE2eDownload = null;
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function patchedCreateObjectURL(blob) {
      const capture = { href: "blob:sfsc-electron-e2e", size: blob.size, type: blob.type, text: "" };
      window.__sfscE2eDownload = capture;
      blob.text().then((text) => { capture.text = text; }).catch((error) => { capture.error = String(error?.message || error); });
      return capture.href;
    };
    URL.revokeObjectURL = function patchedRevokeObjectURL() {};
    HTMLAnchorElement.prototype.click = function patchedClick() {
      if (window.__sfscE2eDownload) {
        window.__sfscE2eDownload.download = this.download || "";
      }
    };
    window.__sfscE2eRestoreDownload = () => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalClick;
    };
  })()`);
  await cdp.evaluate(`document.getElementById("exportDiagnosticsBtn").click()`);
  const capture = await waitForEvaluate(cdp, `(() => window.__sfscE2eDownload || null)()`, (value) => Boolean(value?.download && value?.text), 15000);
  await cdp.evaluate(`window.__sfscE2eRestoreDownload && window.__sfscE2eRestoreDownload()`).catch(() => {});
  if (!/^sfsc-client-diagnostics-.*\.json$/.test(capture.download)) {
    throw new Error(`Unexpected diagnostic download filename: ${capture.download || "(missing)"}.`);
  }
  const bundle = JSON.parse(capture.text);
  if (bundle.app !== "singbox-folder-sync") {
    throw new Error("Diagnostic bundle app id mismatch.");
  }
  if (bundle.summary?.releaseManifestOk !== true) {
    throw new Error("Diagnostic bundle did not report releaseManifestOk=true.");
  }
  if (!bundle.status?.diagnostics?.protocols?.clientStatus) {
    throw new Error("Diagnostic bundle did not include client diagnostics protocols.");
  }
  assertDoesNotContainSecrets(capture.text, fixture, "diagnostic bundle");
  checks.push(`diagnostic JSON exported and parsed: ${capture.download}`);
}

function assertDoesNotContainSecrets(text, fixture, label) {
  for (const secret of [
    fixture.secrets.storageSecret,
    fixture.secrets.heartbeatSecret,
    fixture.profile.tunnel.uri,
    fixture.secrets.vlessId,
    "SFSC1-"
  ]) {
    if (text.includes(secret)) {
      throw new Error(`${label} leaked sensitive fixture value: ${secret.slice(0, 16)}...`);
    }
  }
}

async function waitForInspectablePage(debugPort) {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) return page;
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
    if (!predicate || predicate(lastValue)) return lastValue;
    await delay(200);
  }
  throw new Error(`Timed out waiting for renderer condition. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForFetchJson(clientPort, path, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await fetchJson(`http://127.0.0.1:${clientPort}${path}`).catch((error) => ({ error: error.message }));
    if (predicate(lastValue)) return lastValue;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${path}. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForFakeToolEvent(file, tool, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    events = await readFakeToolEvents(file).catch(() => []);
    if (events.some((event) => event.tool === tool)) {
      return events;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for fake tool event ${tool}. Last events: ${JSON.stringify(events)}`);
}

async function readFakeToolEvents(file) {
  const text = await readFile(file, "utf8");
  return text.trim()
    ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    : [];
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
    signal: AbortSignal.timeout(options.timeoutMs || 2000)
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
    type: "electron-e2e-smoke-report",
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
  await mkdir(dirname(reportPath), { recursive: true });
  await writeJsonReportFile(reportPath, payload, "electron e2e smoke report");
  console.log(`SFSC Electron E2E smoke JSON report written: ${reportPath}`);
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
