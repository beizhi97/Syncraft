import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJobFromProfile,
  buildRuntimeDiagnostics,
  buildRclonePreview,
  encodeClaimToken,
  encodeImportProfile
} from "../src/core/index.js";
import { ensureClientDirs, getClientPaths } from "../client/src/paths.js";
import { buildDiagnosticBundle } from "../client/src/diagnosticBundle.js";
import { resolveProfileImport } from "../client/src/profileImport.js";
import { ManagedProcess, readRecentLogWithMeta, redactLogText, runBuffered } from "../client/src/processRunner.js";
import {
  appendRcloneOutputContext,
  mergeRcloneConflictSummary,
  mergeRcloneProgress,
  parseRcloneFailure,
  parseRcloneStats
} from "../client/src/rcloneStats.js";
import {
  assertDiagnosticBundleContract,
  assertDiagnosticLogMetaContract
} from "./helpers/contracts.js";
import {
  readJobs,
  readProfile,
  readSyncHistory,
  inspectSecretVault,
  inspectLocalState,
  clearClaimRecovery,
  prepareClaimRecovery,
  recordSyncRunFinished,
  recordSyncRunStarted,
  restoreProfileImportState,
  saveJob,
  saveJobs,
  saveProfile,
  snapshotProfileImportState,
  writeJsonFile
} from "../client/src/store.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&security=none&type=tcp#home-sync";

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

test("client paths point at bundled Windows binaries", () => {
  const paths = getClientPaths();
  assert.equal(paths.singboxExe.endsWith(join("resources", "bin", "win32", "sing-box.exe")), true);
  assert.equal(paths.rcloneExe.endsWith(join("resources", "bin", "win32", "rclone.exe")), true);
  assert.equal(paths.rcloneConfigFile.endsWith(join("data", "runtime", "rclone.conf")), true);
  assert.equal(paths.syncHistoryFile.endsWith(join("data", "sync-history.json")), true);
  assert.equal(paths.secretsFile.endsWith(join("data", "secrets.json")), true);
  assert.equal(paths.claimRecoveryFile.endsWith(join("data", "claim-recovery.json")), true);
  assert.equal(paths.heartbeatSnapshotFile.endsWith(join("data", "last-successful-heartbeat.json")), true);
  assert.equal(paths.releaseManifestFile.endsWith("release-manifest.json"), true);
  assert.equal(paths.electronLog.endsWith(join("data", "logs", "electron-main.log")), true);
  assert.equal(paths.singboxLog.endsWith(join("data", "logs", "sing-box.log")), true);
  assert.equal(paths.rcloneLog.endsWith(join("data", "logs", "rclone.log")), true);
});

test("client paths honor explicit data root and fallback when package data is not writable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-paths-"));
  const previous = {
    portableRoot: process.env.SFSC_PORTABLE_ROOT,
    dataRoot: process.env.SFSC_CLIENT_DATA_ROOT,
    legacyDataRoot: process.env.SFSC_DATA_ROOT,
    localAppData: process.env.LOCALAPPDATA
  };
  try {
    const configuredDataRoot = join(tempRoot, "configured-data");
    process.env.SFSC_CLIENT_DATA_ROOT = configuredDataRoot;
    delete process.env.SFSC_DATA_ROOT;
    let paths = getClientPaths();
    assert.equal(paths.dataRoot, configuredDataRoot);
    assert.equal(paths.profileFile, join(configuredDataRoot, "profile.json"));
    assert.equal(paths.rcloneConfigFile, join(configuredDataRoot, "runtime", "rclone.conf"));

    delete process.env.SFSC_CLIENT_DATA_ROOT;
    const legacyDataRoot = join(tempRoot, "legacy-data");
    process.env.SFSC_DATA_ROOT = legacyDataRoot;
    paths = getClientPaths();
    assert.equal(paths.dataRoot, legacyDataRoot);

    delete process.env.SFSC_DATA_ROOT;
    const portableRoot = join(tempRoot, "portable");
    await mkdir(portableRoot, { recursive: true });
    await mkdir(join(portableRoot, "data"), { recursive: true });
    await writeFile(join(portableRoot, "data", "profile.json"), '{"clientName":"legacy-client"}', "utf8");
    process.env.SFSC_PORTABLE_ROOT = portableRoot;
    process.env.LOCALAPPDATA = join(tempRoot, "LocalAppData");
    paths = getClientPaths();
    assert.equal(paths.dataRoot, join(tempRoot, "LocalAppData", "Syncraft", "data"));
    await ensureClientDirs(paths);
    assert.equal(paths.dataRoot, join(tempRoot, "LocalAppData", "Syncraft", "data"));
    assert.equal(paths.profileFile, join(paths.dataRoot, "profile.json"));
    assert.equal(paths.rcloneConfigFile, join(paths.dataRoot, "runtime", "rclone.conf"));
    assert.equal(await readFile(paths.profileFile, "utf8"), '{"clientName":"legacy-client"}');
    assert.equal(await readFile(join(portableRoot, "data", "profile.json"), "utf8"), '{"clientName":"legacy-client"}');
  } finally {
    restoreEnv("SFSC_PORTABLE_ROOT", previous.portableRoot);
    restoreEnv("SFSC_CLIENT_DATA_ROOT", previous.dataRoot);
    restoreEnv("SFSC_DATA_ROOT", previous.legacyDataRoot);
    restoreEnv("LOCALAPPDATA", previous.localAppData);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Electron desktop exposes a narrow native folder picker bridge", async () => {
  const main = await readFile(join(projectRoot, "client", "electron", "main.cjs"), "utf8");
  const preload = await readFile(join(projectRoot, "client", "electron", "preload.cjs"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /second-instance/);
  assert.match(main, /mainWindow\.focus\(\)/);
  assert.match(main, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
  assert.match(main, /ipcMain\.handle\("sfsc:pick-folder"/);
  assert.match(main, /showOpenDialog/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("sfscDesktop"/);
  assert.match(preload, /pickFolder: \(\) => ipcRenderer\.invoke\("sfsc:pick-folder"\)/);
  assert.match(app, /window\.sfscDesktop\?\.pickFolder/);
  assert.match(app, /当前模式无法读取真实文件夹路径，请粘贴完整本地路径。/);
  assert.match(app, /fields\.localPath\.focus\(\)/);
  assert.doesNotMatch(app, /fields\.folderPicker\.click\(\)/);
  assert.doesNotMatch(app, /webkitRelativePath\?\.split/);
});

test("Electron desktop shows a startup error window instead of silently quitting", async () => {
  const main = await readFile(join(projectRoot, "client", "electron", "main.cjs"), "utf8");

  assert.match(main, /function createStartupErrorWindow\(error\)/);
  assert.match(main, /title: "Syncraft 启动失败"/);
  assert.match(main, /function normalizeStartupError\(error\)/);
  assert.match(main, /client_port_in_use/);
  assert.match(main, /本地服务端口被占用/);
  assert.match(main, /function renderStartupErrorHtml\(error\)/);
  assert.match(main, /错误码：\$\{error\.code\}/);
  assert.match(main, /日志：\$\{error\.logFile\}/);
  assert.match(main, /navigator\.clipboard/);
  assert.match(main, /await startClientServer\(layout\)/);
  assert.match(main, /createStartupErrorWindow\(error\);\s+return;/);
  assert.match(main, /process\.env\.SFSC_PACKAGE_SMOKE === "1"[\s\S]*process\.exitCode = 1;[\s\S]*app\.quit\(\);/);
  assert.doesNotMatch(main, /await startClientServer\(layout\);\s+if \(process\.env\.SFSC_PACKAGE_SMOKE === "1"\)/);
});

test("Electron desktop blocks foreign navigation and popups, and both UIs ship a CSP", async () => {
  const main = await readFile(join(projectRoot, "client", "electron", "main.cjs"), "utf8");
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const clientIndex = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const serverIndex = await readFile(join(projectRoot, "public", "index.html"), "utf8");

  // E-1: window hardening in the Electron shell.
  assert.match(main, /function isTrustedShellUrl\(target\)/);
  assert.match(main, /url\.origin === `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.match(main, /function hardenWindowNavigation\(window\)/);
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?return \{ action: "deny" \};/);
  assert.match(main, /webContents\.on\("will-navigate", \(event, url\) => \{[\s\S]*?event\.preventDefault\(\);/);
  assert.match(main, /hardenWindowNavigation\(mainWindow\);/);
  // The startup error window denies everything (data: URL page).
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  // Nothing may be forwarded to the OS browser (comment mentions are fine,
  // actual calls are not).
  assert.doesNotMatch(main, /shell\.openExternal\(/);

  // E-2: both UIs serve a CSP on HTML documents plus nosniff everywhere.
  for (const [label, source] of [["client", clientServer], ["server", server]]) {
    assert.match(source, /const UI_CONTENT_SECURITY_POLICY = \[/, `${label} defines a CSP`);
    assert.match(source, /"default-src 'none'"/, `${label} default-src`);
    assert.match(source, /"script-src 'self'"/, `${label} script-src`);
    assert.match(source, /"connect-src 'self'"/, `${label} connect-src`);
    assert.match(source, /"frame-ancestors 'none'"/, `${label} frame-ancestors`);
    assert.match(source, /headers\["content-security-policy"\] = UI_CONTENT_SECURITY_POLICY;/, `${label} sends the CSP`);
    assert.match(source, /"x-content-type-options": "nosniff"/, `${label} nosniff`);
  }

  // script-src 'self' is only sound while the documents have no inline
  // scripts or inline event handlers; fail loudly if one is introduced.
  for (const [label, html] of [["client index", clientIndex], ["server index", serverIndex]]) {
    assert.doesNotMatch(html, /<script>[^<]/, `${label} must not use inline scripts`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${label} must not use inline event handlers`);
    assert.match(html, /<script src="\/app\.js"><\/script>/, `${label} loads app.js externally`);
  }
});

test("Electron desktop stays resident in the tray until the user explicitly quits", async () => {
  const main = await readFile(join(projectRoot, "client", "electron", "main.cjs"), "utf8");
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(main, /const \{ app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray \} = require\("electron"\)/);
  assert.match(main, /function createTray\(\)/);
  assert.match(main, /label: "打开主界面"/);
  assert.match(main, /label: "退出"/);
  assert.match(main, /mainWindow\.on\("close", \(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*mainWindow\.hide\(\);[\s\S]*\}\);/);
  assert.match(main, /tray\.on\("double-click", showMainWindow\)/);
  assert.match(main, /const http = require\("node:http"\)/);
  assert.match(main, /function shouldRequestClientShutdown\(\)/);
  assert.match(main, /clientServerStarted && process\.env\.SFSC_PACKAGE_SMOKE !== "1"/);
  assert.match(main, /function requestClientShutdown\(\)/);
  assert.match(main, /path: "\/api\/client\/shutdown"/);
  assert.match(main, /method: "POST"/);
  assert.match(main, /function shutdownClientAndQuit\(\)/);
  assert.match(main, /requestClientShutdown\(\)\.then/);
  assert.match(main, /app\.on\("before-quit", \(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*shutdownClientAndQuit\(\);[\s\S]*\}\);/);
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{[\s\S]*if \(tray && !isQuitting\)[\s\S]*return;[\s\S]*shutdownClientAndQuit\(\);[\s\S]*\}\);/);

  assert.match(clientServer, /function scheduleClientShutdown\(\)/);
  assert.match(clientServer, /function shutdownClientRuntime\(\)/);
  assert.match(clientServer, /scheduleClientShutdown\(\);[\s\S]*return;/);
  assert.match(clientServer, /clearInterval\(heartbeatTimer\);[\s\S]*clearInterval\(schedulerTimer\);/);
  assert.match(clientServer, /singboxProcess\.stopAndWait\(\{ timeoutMs: 2500 \}\)/);
  assert.match(clientServer, /syncProcess\.stopAndWait\(\{ timeoutMs: 2500 \}\)/);
  assert.match(clientServer, /await new Promise\(\(resolve\) => server\.close\(resolve\)\);[\s\S]*process\.exit\(0\);/);
});

test("client launchers avoid duplicate local runtime instances", async () => {
  const electronMain = await readFile(join(projectRoot, "client", "electron", "main.cjs"), "utf8");
  const csharpLauncher = await readFile(join(projectRoot, "client", "src", "Launcher.cs"), "utf8");
  const nodeLauncher = await readFile(join(projectRoot, "client", "src", "launcher.cjs"), "utf8");
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
  const errors = await readFile(join(projectRoot, "src", "core", "errors.js"), "utf8");

  assert.match(electronMain, /requestSingleInstanceLock\(\)/);
  assert.match(electronMain, /SFSC_PACKAGE_SMOKE/);
  assert.match(electronMain, /SFSC_CLIENT_DATA_ROOT \|\| process\.env\.SFSC_DATA_ROOT/);
  assert.match(csharpLauncher, /Global\\\\SyncraftClient-/);
  assert.match(csharpLauncher, /WaitForClient\(url, 8000\)/);
  assert.match(csharpLauncher, /SFSC_PACKAGE_SMOKE/);
  assert.match(csharpLauncher, /SFSC_OPEN_BROWSER/);
  assert.match(csharpLauncher, /SFSC_CLIENT_DATA_ROOT/);
  assert.match(csharpLauncher, /SFSC_DATA_ROOT/);
  assert.match(csharpLauncher, /api\/health/);
  assert.match(csharpLauncher, /IsSfscClientHealth/);
  assert.match(csharpLauncher, /client-exe-runtime/);
  assert.match(csharpLauncher, /HasJsonString\(body, "role", "client"\)/);
  assert.doesNotMatch(csharpLauncher, /api\/client\/status/);
  assert.match(nodeLauncher, /isClientReady\(\)/);
  assert.match(nodeLauncher, /waitForClient\(12000\)/);
  assert.match(nodeLauncher, /api\/health/);
  assert.match(nodeLauncher, /isSfscClientHealth/);
  assert.match(nodeLauncher, /payload\?\.mode === "client-exe-runtime"/);
  assert.match(nodeLauncher, /payload\?\.diagnostics\?\.role === "client"/);
  assert.doesNotMatch(nodeLauncher, /api\/client\/status/);
  assert.match(clientServer, /error\?\.code !== "EADDRINUSE"/);
  assert.match(clientServer, /isExistingClientReady/);
  assert.match(clientServer, /api\/health/);
  assert.match(clientServer, /isSfscClientHealth/);
  assert.match(clientServer, /payload\?\.mode === "client-exe-runtime"/);
  assert.match(clientServer, /payload\?\.diagnostics\?\.role === "client"/);
  assert.match(clientServer, /client_port_in_use/);
  assert.match(clientServer, /startBackgroundLoops/);
  assert.match(httpContract, /\/api\/client\/shutdown/);
  assert.match(httpContract, /stateBeforeShutdown/);
  assert.match(httpContract, /readClientStateFiles/);
  assert.match(errors, /client_port_in_use: 409/);
});

test("client bandwidth limit UI uses safe structured controls", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(html, /id="bandwidthLimitEnabled"/);
  assert.match(html, /id="bandwidthLimitMode"/);
  assert.match(html, /id="bandwidthLimitValue" type="number" min="1"/);
  assert.match(html, /id="bandwidthLimitUnit"/);
  assert.match(html, /id="bandwidthLimitStart" type="time"/);
  assert.match(html, /id="bandwidthLimitEnd" type="time"/);
  assert.match(html, /<option value="k">KB\/s<\/option>/);
  assert.match(html, /<option value="M" selected>MB\/s<\/option>/);
  assert.doesNotMatch(html, /placeholder="off \/ 10M \/ 500k"/);
  assert.match(app, /function readBandwidthLimit/);
  assert.match(app, /function writeBandwidthLimit/);
  assert.match(app, /function syncBandwidthAvailability/);
  assert.match(app, /function isValidTime/);
  assert.match(app, /\`\$\{startTime\},\$\{fixed\} \$\{endTime\},off\`/);
  assert.match(app, /fields\.bandwidthLimitMode\.value = "schedule"/);
  assert.match(app, /带宽限制开始和结束时间不能相同/);
});

test("client schedule UI uses configurable interval, daily, and startup controls", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(html, /id="scheduleMode"/);
  assert.match(html, /<option value="interval">每隔<\/option>/);
  assert.match(html, /id="scheduleInterval" class="schedule-param" type="number" min="1" max="1440"/);
  assert.match(html, /id="scheduleTime" class="schedule-param" type="time" value="02:00"/);
  assert.match(html, /<option value="startup">启动时<\/option>/);
  assert.match(html, /id="schedulerValue"/);
  assert.doesNotMatch(html, /value="interval30"/);
  assert.match(app, /function syncScheduleControls/);
  assert.match(app, /function writeSchedule/);
  assert.match(app, /fields\.scheduleMode\.value === "startup"/);
  assert.match(app, /return \{ mode: "startup" \}/);
  assert.match(app, /function renderScheduler/);
  assert.match(app, /value === "on-startup"/);
  assert.match(app, /scheduler\.nextRun/);
  assert.match(server, /let schedulerTimer = null/);
  assert.match(server, /function startBackgroundLoops/);
  assert.match(server, /schedulerTimer = setInterval/);
  assert.match(server, /async function tickScheduler/);
  assert.match(server, /await runSync\(due\.job, \{ trigger: "scheduler" \}\)/);
  assert.match(server, /function normalizeSchedulerErrorCode/);
  assert.match(server, /lastError: normalizeSchedulerErrorCode\(schedulerState\.lastError\)/);
  assert.match(server, /lastError: normalizeSchedulerErrorCode\(item\.lastError\)/);
  assert.match(app, /intervalMinutes < 1 \|\| intervalMinutes > 1440/);
});

test("client UI preserves loaded job fields when reading the edit form without exposing storage routing", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const css = await readFile(join(projectRoot, "client", "public", "styles.css"), "utf8");

  assert.match(html, /id="remoteTargetSummary"/);
  assert.match(html, /授权与执行范围/);
  // 同步空间和远端子目录不再是本地表单项：服务端签发的 MinIO 策略只授权
  // ${prefix}/*，客户端再提供选择只会让用户选出一个服务端必拒的组合。
  assert.doesNotMatch(html, /id="remoteFolder"/);
  assert.doesNotMatch(html, /id="serverSpace"/);
  assert.match(html, /id="syncSpaceSummary"/);
  assert.match(html, /已授权同步内容/);
  assert.match(app, /let currentJobDraft = null/);
  assert.match(app, /const clientJobDraftFields = \[/);
  for (const field of [
    "id",
    "name",
    "checkers",
    "s3UploadConcurrency",
    "s3ChunkSize",
    "chunkSize",
    "cutoff",
    "retries",
    "lowLevelRetries",
    "dryRun",
    "localProxyPort"
  ]) {
    assert.match(app, new RegExp(`"${field}"`));
  }
  assert.match(app, /function toClientJobDraft\(job = \{\}\)/);
  assert.match(app, /currentJobDraft = toClientJobDraft\(job\)/);
  assert.match(app, /const base = currentJobDraft && typeof currentJobDraft === "object" \? currentJobDraft : \{\}/);
  assert.doesNotMatch(app, /function readRemoteFolderField\(\)/);
  assert.doesNotMatch(app, /error\.code = "remote_folder_required"/);
  // 这两个码只由已删除的 readRemoteFolderField 抛出，留在文案表里就是死条目。
  assert.doesNotMatch(app, /shared_remote_folder_required/);
  assert.doesNotMatch(app, /invalid_remote_folder/);
  assert.match(app, /function jobPreviewFingerprint\(job = \{\}\)/);
  assert.match(app, /lastPreviewJobFingerprint = jobPreviewFingerprint\(job\)/);
  assert.match(app, /title: "确认同步范围"/);
  // 确认框不再叫「远端目标」：客户端已经没有远端路由可选，能确认的只有同步范围。
  assert.doesNotMatch(app, /远端目标|远端目录/);
  assert.doesNotMatch(app, /function updateRemoteTargetDraft\(\)/);
  assert.match(app, /Object\.hasOwn\(job, field\)/);
  assert.match(app, /function renderRemoteTargetSummary\(job = \{\}, profileSummary = null\)/);
  assert.match(app, /renderRemoteTargetSummary\(status\.jobs\[status\.jobs\.length - 1\] \|\| currentJobDraft, status\.profileSummary\)/);
  // 摘要从「整个已授权同步内容」这一句占位，换成服务端实际签发的空间、角色与方向。
  // 仓库名和前缀仍然不能出现——不泄露存储路由这条约束没有放松。
  assert.match(app, /\["同步空间", formatSyncSpaceName\(summary\.syncSpace\)\]/);
  // 「未绑定同步空间」的兜底文案只能有一处来源，否则同一状态又会出现多种说法。
  assert.match(app, /function formatSyncSpaceName\(syncSpace\)/);
  assert.equal(app.match(/"未绑定同步空间（离线配置）"/g).length, 1);
  assert.match(app, /\["本设备角色", formatSyncSpaceRole\(summary\.authorization\?\.role\)\]/);
  assert.match(app, /\["授权方向", formatAuthorizedDirections\(summary\.authorization\?\.directions\)\]/);
  assert.doesNotMatch(app, /\["仓库", job\.bucketName \|\| "-"\]/);
  assert.doesNotMatch(app, /\["路径", job\.remotePrefix \|\| "-"\]/);
  assert.match(app, /function authorizationState\(heartbeat = null\)/);
  assert.match(app, /function renderAuthorizedContent\(authorization = "missing"\)/);
  assert.match(css, /\.target-summary/);
  assert.match(css, /\.summary-row code/);
  assert.doesNotMatch(app, /secretAccessKey"[\s\S]*clientJobDraftFields/);
});

test("client UI does not send transfers/streams so server defaults win", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");

  // The client is an appliance: parallelism is a server-issued default, never a
  // local form field. Removal is the fix — a fallback would silently re-shadow
  // the admin value, which is exactly the bug this replaced.
  assert.doesNotMatch(html, /id="transfers"/);
  assert.doesNotMatch(html, /id="streams"/);
  assert.doesNotMatch(html, /并行文件/);
  assert.doesNotMatch(html, /单文件线程/);
  assert.doesNotMatch(app, /fields\.transfers/);
  assert.doesNotMatch(app, /fields\.streams/);
  assert.doesNotMatch(app, /readPositiveIntegerField/);
  assert.doesNotMatch(app, /function numberField/);

  // clientJobDraftFields must not whitelist them either, or a saved job would
  // spread stale values back into the payload through `...base`.
  const draftFields = app.slice(app.indexOf("const clientJobDraftFields"), app.indexOf("];", app.indexOf("const clientJobDraftFields")));
  assert.doesNotMatch(draftFields, /"transfers"/);
  assert.doesNotMatch(draftFields, /"streams"/);

  // Behavioural: with the client silent, the admin default reaches the job.
  const profile = {
    clientName: "company-pc1",
    tunnel: { uri: tunnelUri },
    storage: {
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: "company-pc1",
      secretAccessKey: "secret",
      prefix: "devices/company-pc1"
    },
    defaults: { localProxyPort: 18081, transfers: 12, streams: 3, chunkSize: "16M" }
  };

  const job = buildJobFromProfile(profile, { remoteFolder: "", serverSpace: "device" });
  assert.equal(job.transfers, 12);
  assert.equal(job.streams, 3);
});

test("client empty state import action opens settings", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(html, /id="emptyImportBtn"/);
  assert.match(html, /<button id="emptyImportBtn">导入 SyncKey<\/button>/);
  assert.match(html, /首次使用清单/);
  assert.match(html, /校验 ZIP 旁边的 \.sha256 文件/);
  assert.match(html, /解压到桌面或文档等用户可写目录/);
  assert.match(html, /不要发送完整 SyncKey、sfsc:\/\/ 导入 URI 或 VLESS URI/);
  assert.match(app, /on\("emptyImportBtn", "click", openSettings\)/);
});

test("client static shell starts from a real empty state without demo data", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");

  assert.match(html, /组件检测中/);
  assert.match(html, /等待导入/);
  assert.match(html, /心跳未配置/);
  assert.match(html, /等待服务端心跳后确认协议兼容性/);
  assert.match(html, /暂无同步历史/);
  assert.match(html, /暂无日志/);
  assert.doesNotMatch(html, /value="D:\\/);
  assert.doesNotMatch(html, /D:\\Work/);
  assert.doesNotMatch(html, /company-pc1/);
  assert.doesNotMatch(html, /pass\.971223\.xyz/);
  assert.doesNotMatch(html, /2026-07-04T10:00:00Z/);
  assert.doesNotMatch(html, /sfsc-1\.0\.0-win/);
  assert.doesNotMatch(html, /协议兼容，客户端与服务端版本匹配/);
  assert.doesNotMatch(html, /成功 15 · 失败 3 · 停止 2/);
  assert.doesNotMatch(html, /VLESS REALITY connection established/);
});

test("client UI exposes the most recent sync result", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(html, /id="lastSyncValue"/);
  assert.match(app, /function formatLastSync/);
  assert.match(app, /有冲突 \$\{run\.conflicts\.count\} 项/);
  assert.match(app, /status\.lastSync/);
});

test("client UI exposes the recent sync history list", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(html, /id="syncHistoryList"/);
  assert.match(html, /id="refreshHistoryBtn"/);
  assert.match(html, /id="historyStatusFilter"/);
  for (const option of [
    '<option value="running">运行中</option>',
    '<option value="success">成功</option>',
    '<option value="error">失败</option>',
    '<option value="conflict">有冲突</option>',
    '<option value="stopped">已停止</option>',
    '<option value="unknown">未知</option>'
  ]) {
    assert.equal(html.includes(option), true);
  }
  assert.match(html, /id="historySearch"/);
  assert.match(html, /id="historySummary"/);
  assert.match(app, /function renderSyncHistory/);
  assert.match(app, /function renderHistorySummary/);
  assert.match(app, /function summarizeSyncHistory/);
  assert.match(app, /function formatSyncRunTrigger/);
  assert.equal(app.includes("formatSyncRunTrigger(run.trigger)"), true);
  assert.match(app, /formatSyncRunTrigger\(run\.trigger\)/);
  assert.match(app, /function syncRunSpeedMbps/);
  assert.match(app, /function parseSpeedMbps/);
  assert.match(app, /峰值 \$\{summary\.peakSpeed\}/);
  assert.match(app, /function filterSyncHistory/);
  assert.match(app, /function syncRunSearchText/);
  assert.match(app, /function syncRunPresentationClass/);
  assert.match(app, /function syncRunBadgeText/);
  assert.match(app, /status === "conflict"/);
  assert.match(app, /running: "运行中"/);
  assert.match(app, /return \["running", "success", "error", "stopped"\]\.includes\(status\) \? status : "unknown";/);
  assert.match(app, /没有匹配的同步历史/);
  assert.match(app, /function refreshSyncHistory/);
  assert.match(app, /latestSyncHistory/);
  assert.match(app, /historyStatusFilter/);
  assert.match(app, /historySearch/);
  assert.match(app, /status\.syncHistory/);
  assert.match(app, /\/api\/sync\/history/);
  const css = await readFile(join(projectRoot, "client", "public", "styles.css"), "utf8");
  assert.match(css, /\.history-summary/);
  assert.match(css, /\.history-item\.conflict/);
  assert.match(css, /\.history-status\.conflict/);
});

test("client UI exposes a redacted diagnostic export", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(html, /id="exportDiagnosticsBtn"/);
  assert.match(html, /id="copySupportSummaryBtn"/);
  assert.match(html, /诊断包默认脱敏设备名、服务地址、仓库和本地路径。/);
  assert.match(app, /on\("copySupportSummaryBtn", "click", copySupportSummary\)/);
  assert.match(app, /function buildSupportSummary/);
  assert.match(app, /function exportDiagnostics/);
  assert.match(app, /function downloadJson/);
  assert.match(app, /\/api\/diagnostics\/export/);
  assert.match(app, /脱敏诊断包已导出。/);
  assert.match(server, /buildDiagnosticExport/);
  assert.match(server, /buildDiagnosticEnvironment/);
  assert.match(server, /stateFiles/);
  assert.match(server, /logFiles/);
  assert.match(server, /readRecentLogWithMeta/);
  assert.match(server, /electronLog/);
  assert.match(server, /fileSummary/);
  assert.match(server, /buildDiagnosticBundle/);
});

test("client support summary copies only safe operational fields", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildSupportSummaryContext(app);

  context.latestStatus = {
    appVersion: "0.3.0-rc.1",
    diagnostics: {
      buildId: "sfsc-test-build",
      buildTime: "2026-07-09T12:00:00.000Z"
    },
    releaseManifest: {
      ok: true,
      version: "0.3.0-rc.1",
      builtAt: "2026-07-09T12:05:00.000Z"
    },
    safeguards: {
      localState: { ok: true },
      secretVault: { ok: true }
    },
    binaries: {
      singbox: { exists: true, path: "C:\\Users\\demo\\sing-box.exe" },
      rclone: { exists: true, path: "C:\\Users\\demo\\rclone.exe" }
    },
    profileSummary: {
      clientName: "company-pc1",
      server: "https://server.example.test",
      bucket: "private-bucket",
      remotePrefix: "devices/company-pc1"
    },
    profile: {
      tunnel: { uri: tunnelUri },
      storage: { secretAccessKey: "top-secret", endpoint: "http://minio:9000" }
    },
    heartbeat: {
      ok: false,
      errorCode: "heartbeat_failed",
      server: "https://server.example.test"
    },
    processes: {
      sync: {
        metrics: { syncState: "idle" }
      }
    },
    lastSync: {
      status: "error",
      errorCode: "storage_request_failed",
      localPath: "D:\\Private",
      remoteFolder: "customer-files"
    }
  };
  context.latestSyncHistory = [{
    status: "success",
    localPath: "D:\\OlderPrivate"
  }];

  const copied = await context.copySupportSummary();
  assert.equal(copied, context.clipboardText);
  assert.match(copied, /SFSC support summary/);
  assert.match(copied, /appVersion=0\.3\.0-rc\.1/);
  assert.match(copied, /buildId=sfsc-test-build/);
  assert.match(copied, /releaseManifest=ok/);
  assert.match(copied, /localState=ok/);
  assert.match(copied, /secretVault=ok/);
  assert.match(copied, /binaries=ok/);
  assert.match(copied, /profileImported=true/);
  assert.match(copied, /heartbeat=error:heartbeat_failed/);
  assert.match(copied, /lastSyncErrorCode=storage_request_failed/);
  assert.equal(context.actions.at(-1).text, "支持摘要已复制，可直接发给支持人员。");

  for (const unsafe of [
    "https://server.example.test",
    "private-bucket",
    "devices/company-pc1",
    "company-pc1",
    tunnelUri,
    "top-secret",
    "http://minio:9000",
    "D:\\Private",
    "customer-files",
    "C:\\Users\\demo"
  ]) {
    assert.equal(copied.includes(unsafe), false, `support summary leaked ${unsafe}`);
  }
});

test("client diagnostic log reader includes metadata, truncation, and redaction", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-log-"));
  try {
    const logFile = join(tempRoot, "rclone.log");
    await writeFile(logFile, [
      "line before secret",
      "secret_access_key top-secret-value",
      "S3_SECRET_ACCESS_KEY=another-secret",
      "Transferred: C:\\Users\\Tong_hp\\Documents\\private.txt",
      "Unix path: /home/tong/private/file.txt",
      "tail"
    ].join("\n"), "utf8");

    const meta = await readRecentLogWithMeta(logFile, 512);
    assertDiagnosticLogMetaContract(meta, "meta", {
      rawSecrets: ["top-secret-value", "another-secret"]
    });
    assert.equal(meta.path, logFile);
    assert.equal(meta.exists, true);
    assert.equal(typeof meta.size, "number");
    assert.equal(typeof meta.modifiedAt, "string");
    assert.equal(meta.maxChars, 512);
    assert.equal(meta.truncated, false);
    assert.equal(meta.text.includes("top-secret-value"), false);
    assert.equal(meta.text.includes("another-secret"), false);
    assert.equal(meta.text.includes("C:\\Users"), false);
    assert.equal(meta.text.includes("/home/tong"), false);
    assert.match(meta.text, /\*\*\*\*/);
    assert.match(meta.text, /<local-path>/);

    const missing = await readRecentLogWithMeta(join(tempRoot, "missing.log"), 48);
    assertDiagnosticLogMetaContract(missing, "missing");
    assert.equal(missing.exists, false);
    assert.equal(missing.text, "");
    assert.equal(missing.truncated, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client diagnostic bundle redacts secrets and support-private identifiers from structured status and logs", () => {
  const bundle = buildDiagnosticBundle({
    generatedAt: "2026-07-04T00:00:00.000Z",
    status: {
      diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
      appVersion: "0.3.0-rc.1",
      profileImported: true,
      futurePrivateDebugPayload: "new-sensitive-field-that-must-not-leak",
      profileSummary: {
        clientName: "company-pc1",
        serverUrl: "https://sync.example.com"
      },
      profile: {
        tunnel: {
          uri: tunnelUri
        }
      },
      binaries: {
        singbox: { path: "C:\\Tools\\sing-box.exe", exists: true, ok: true, errorCode: "", message: "" },
        rclone: {
          path: "C:\\Tools\\rclone.exe",
          exists: false,
          ok: false,
          errorCode: "missing_rclone_binary",
          message: "Missing bundled rclone: C:\\Tools\\rclone.exe"
        }
      },
      heartbeat: {
        ok: false,
        server: "https://sync.example.com",
        errorCode: "heartbeat_failed",
        remoteErrorCode: "device_not_found"
      },
      lastSuccessfulHeartbeat: {
        ok: true,
        server: "https://sync.example.com",
        sentAt: "2026-07-04T00:00:00.000Z",
        status: 200,
        serverDiagnostics: {
          app: "singbox-folder-sync",
          role: "server",
          version: "0.3.0-rc.1",
          buildId: "",
          buildTime: null,
          protocols: {
            claim: 1,
            profile: 1,
            adminState: 1,
            clientStatus: 1,
            heartbeat: 1
          }
        },
        compatibility: {
          ok: false,
          status: "mismatch",
          action: "upgrade_remote",
          severity: "warning",
          policy: {
            heartbeat: "allow",
            profileIssue: "warn",
            syncRun: "warn",
            adminActions: "allow",
            reason: "upgrade_remote"
          },
          localRole: "server",
          remoteRole: "client",
          issues: [{
            field: "profile",
            type: "remote_older",
            local: 2,
            remote: 1,
            message: "profile protocol mismatch: local v2, remote v1"
          }]
        },
        device: {
          status: "online",
          enabled: true,
          online: true,
          bucket: "home-sync",
          prefix: "devices/company-pc1",
          sync: {
            currentFile: "projects/fallback.iso",
            lastRun: {
              currentFile: "projects/video.iso"
            }
          }
        }
      },
      safeguards: {
        localState: {
          ok: false,
          files: [{ name: "jobs", ok: false, errorCode: "local_state_corrupt", message: "bad json" }]
        },
        secretVault: {
          backend: "file",
          path: "C:\\SFSC\\data\\secrets.json",
          ok: false,
          protected: false,
          protection: {
            protected: false,
            mode: "windows-acl",
            exists: false
          },
          refs: 1,
          missingRefs: ["secret-a"]
        }
      },
      lastSync: {
        status: "error",
        errorCode: "rclone_sync_failed",
        conflicts: { count: 2 }
      },
      jobs: [{
        name: "folder-sync",
        secretAccessKey: "top-secret-value",
        heartbeatSecret: "heartbeat-raw-secret",
        heartbeatAuthNonces: [{ nonce: "nonce-secret" }],
        vlessUri: tunnelUri
      }]
    },
    environment: {
      platform: "win32",
      releaseManifest: {
        path: "C:\\App\\release-manifest.json",
        exists: true,
        size: 4096,
        modifiedAt: "2026-07-04T00:00:00.000Z",
        ok: true,
        schemaVersion: 1,
        package: "SyncraftDesktop",
        version: "0.3.0-rc.1",
        builtAt: "2026-07-04T00:00:00.000Z",
        fileCount: 8,
        supportDocuments: {
          ok: false,
          files: [
            {
              name: "INTERFACE_CONTRACT",
              path: "resources/app/docs/INTERFACE_CONTRACT.md",
              present: true,
              valid: false,
              size: 1024,
              sha256: "not-a-sha"
            },
            {
              name: "API_MATRIX",
              path: "resources/app/docs/API_MATRIX.md",
              present: true,
              valid: true,
              size: 512,
              sha256: "c".repeat(64)
            }
          ]
        },
        requiredFiles: {
          ok: false,
          files: [
            {
              name: "client UI app",
              path: "resources/app/client/public/app.js",
              present: false,
              valid: false,
              size: 0,
              sha256: ""
            },
            {
              name: "client local API",
              path: "resources/app/client/src/clientServer.js",
              present: true,
              valid: true,
              size: 2048,
              sha256: "d".repeat(64)
            }
          ]
        },
        errorCode: "",
        message: ""
      },
      binaries: {
        rclone: { path: "C:\\Tools\\rclone.exe", exists: true, size: 1234 }
      },
      privateKey: "SERVER_PRIVATE_KEY"
    },
    logs: {
      electron: {
        path: "C:\\Logs\\electron-main.log",
        exists: false,
        size: 0,
        modifiedAt: null,
        maxChars: 20000,
        truncated: false,
        text: ""
      },
      rclone: {
        path: "C:\\Logs\\rclone.log",
        exists: true,
        size: 123,
        modifiedAt: "2026-07-04T00:00:00.000Z",
        maxChars: 20000,
        truncated: true,
        text: "secret_access_key top-secret-value\nS3_SECRET_ACCESS_KEY=another-secret"
      }
    }
  });
  assertDiagnosticBundleContract(bundle, "bundle", {
    strictEnvironment: false,
    strictLogs: false,
    rawSecrets: ["top-secret-value", "another-secret", "heartbeat-raw-secret", "nonce-secret", tunnelUri, "SERVER_PRIVATE_KEY"]
  });
  const text = JSON.stringify(bundle);
  assert.equal(text.includes("top-secret-value"), false);
  assert.equal(text.includes("heartbeat-raw-secret"), false);
  assert.equal(text.includes("nonce-secret"), false);
  assert.equal(text.includes("another-secret"), false);
  assert.equal(text.includes(tunnelUri), false);
  assert.equal(text.includes("C:\\Logs"), false);
  assert.equal(text.includes("projects/fallback.iso"), false);
  assert.equal(text.includes("job:missing-secret"), false);
  assert.equal(text.includes("new-sensitive-field-that-must-not-leak"), false);
  assert.equal(text.includes("https://sync.example.com"), false);
  assert.equal(text.includes("company-pc1"), false);
  assert.equal(text.includes("home-sync"), false);
  assert.equal(text.includes("devices/company-pc1"), false);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.summary.appVersion, "0.3.0-rc.1");
  assert.equal(bundle.summary.releaseManifestOk, true);
  assert.equal(bundle.summary.releaseManifestVersion, "0.3.0-rc.1");
  assert.equal(bundle.summary.releaseManifestBuiltAt, "2026-07-04T00:00:00.000Z");
  assert.equal(bundle.summary.releaseManifestErrorCode, "");
  assert.equal(bundle.summary.releaseManifestSupportDocsOk, false);
  assert.deepEqual(bundle.summary.releaseManifestSupportDocsMissing, ["INTERFACE_CONTRACT"]);
  assert.equal(bundle.summary.releaseManifestRequiredFilesOk, false);
  assert.deepEqual(bundle.summary.releaseManifestRequiredFilesMissing, ["client UI app"]);
  assert.equal(bundle.summary.profileImported, true);
  assert.equal(bundle.summary.profileClientName, "redacted");
  assert.equal(bundle.summary.serverUrl, "redacted");
  assert.equal(bundle.summary.binariesOk, false);
  assert.equal(bundle.summary.missingBinaries[0].errorCode, "missing_rclone_binary");
  assert.equal(bundle.summary.localStateOk, false);
  assert.equal(bundle.summary.localStateErrors[0].errorCode, "local_state_corrupt");
  assert.equal(bundle.summary.secretVaultOk, false);
  assert.equal(bundle.summary.missingSecretRefs, 1);
  assert.equal(bundle.summary.heartbeatOk, false);
  assert.equal(bundle.summary.heartbeatErrorCode, "heartbeat_failed");
  assert.equal(bundle.summary.heartbeatRemoteErrorCode, "device_not_found");
  assert.equal(bundle.summary.heartbeatDeviceStatus, "online");
  assert.equal(bundle.summary.heartbeatDeviceEnabled, true);
  assert.equal(bundle.summary.heartbeatDeviceOnline, true);
  assert.equal(bundle.summary.heartbeatDeviceBucket, "redacted");
  assert.equal(bundle.summary.heartbeatDevicePrefix, "redacted");
  assert.equal(bundle.summary.heartbeatDeviceCurrentFile, "redacted");
  assert.deepEqual(bundle.summary.heartbeatServerProtocols, {
    claim: 1,
    profile: 1,
    adminState: 1,
    clientStatus: 1,
    heartbeat: 1
  });
  assert.equal(bundle.summary.heartbeatCompatibilityStatus, "mismatch");
  assert.equal(bundle.summary.heartbeatCompatibilityAction, "upgrade_remote");
  assert.equal(bundle.summary.heartbeatCompatibilitySeverity, "warning");
  assert.equal(bundle.summary.heartbeatCompatibilitySyncRunPolicy, "warn");
  assert.equal(bundle.summary.lastSyncStatus, "error");
  assert.equal(bundle.summary.lastSyncErrorCode, "rclone_sync_failed");
  assert.equal(bundle.summary.conflictCount, 2);
  assert.deepEqual(bundle.summary.logsMissing, ["electron"]);
  assert.deepEqual(bundle.summary.logsTruncated, ["rclone"]);
  assert.equal(Object.hasOwn(bundle.status, "futurePrivateDebugPayload"), false);
  assert.equal(Object.hasOwn(bundle.status.jobs[0], "secretAccessKey"), false);
  assert.equal(Object.hasOwn(bundle.status.jobs[0], "heartbeatSecret"), false);
  assert.equal(Object.hasOwn(bundle.status.jobs[0], "heartbeatAuthNonces"), false);
  assert.equal(Object.hasOwn(bundle.status.jobs[0], "vlessUri"), false);
  assert.equal(bundle.status.profileSummary.clientName, "redacted");
  assert.equal(bundle.status.profileSummary.serverUrl, "redacted");
  assert.equal(bundle.status.lastSuccessfulHeartbeat.server, "redacted");
  assert.equal(bundle.status.lastSuccessfulHeartbeat.device.bucket, "redacted");
  assert.equal(bundle.status.lastSuccessfulHeartbeat.device.prefix, "redacted");
  assert.equal(Object.hasOwn(bundle.status, "profile"), false);
  assert.equal(bundle.environment.platform, "win32");
  assert.equal(bundle.environment.binaries.rclone.size, 1234);
  assert.equal(bundle.environment.privateKey, "****");
  assert.equal(bundle.logs.rclone.size, 123);
  assert.equal(bundle.logs.rclone.truncated, true);
  assert.match(bundle.logs.rclone.text, /secret_access_key \*\*\*\*/);
});

test("client diagnostic export remains available when local state is corrupt", async () => {
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");

  assert.match(httpContract, /corruptStateDiagnosticExport/);
  assert.match(httpContract, /bundle\.summary\.localStateOk, false/);
  assert.match(httpContract, /localStateErrors\.find\(\(file\) => file\.name === "jobs"\)\.errorCode/);
  assert.match(httpContract, /localStateErrors\.find\(\(file\) => file\.name === "claimRecovery"\)\.errorCode/);
});

test("client status jobs are display-safe summaries", async () => {
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
  const runtimeContracts = await readFile(join(projectRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");

  assert.match(clientServer, /jobs:\s*jobs\.map\(summarizeClientJob\)/);
  assert.match(clientServer, /return json\(res, \{ jobs: jobs\.map\(summarizeClientJob\) \}\)/);
  assert.match(clientServer, /const payload = await withClientStateLock\(paths, async \(\) => \{[\s\S]*?return \{ job: summarizeClientJob\(job\), scheduler: buildSchedulerStatus\(\) \};[\s\S]*?return json\(res, payload\);/);
  assert.match(clientServer, /function summarizeClientJob\(job = \{\}\)/);
  assert.doesNotMatch(clientServer.match(/function summarizeClientJob[\s\S]*?\n\}/)?.[0] || "", /secretAccessKey|s3SecretAccessKey|heartbeatSecret|heartbeatAuthNonces|vlessUri|accessKeyId/);
  assert.match(httpContract, /Object\.hasOwn\(statusAfterSavePayload\.jobs\[0\], "secretAccessKey"\), false/);
  assert.match(httpContract, /Object\.hasOwn\(listedSavedJob, "secretAccessKey"\), false/);
  assert.match(httpContract, /Object\.hasOwn\(savedJobPayload\.job, "secretAccessKey"\), false/);
  assert.match(httpContract, /assertClientJobSummaryContract\(savedJobPayload\.job, "savedJob\.job"\)/);
  assert.match(httpContract, /assertClientJobsReadContract\(jobsReadPayload, "jobsRead"\)/);
  assert.match(runtimeContracts, /assertClientStatusJobSummaryContract/);
  assert.match(runtimeContracts, /assertClientJobSummaryContract/);
  assert.match(runtimeContracts, /assertClientJobsReadContract/);
  assert.match(runtimeContracts, /s3SecretAccessKey/);
  assert.match(runtimeContracts, /assertNoRawClientJobSecrets/);
});

test("client profile HTTP responses are display-safe summaries", async () => {
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");

  assert.match(clientServer, /return json\(res, \{ profile: profile \? summarizeClientProfile\(profile\) : null \}\)/);
  assert.match(clientServer, /return json\(res, \{ profile: summarizeClientProfile\(profile\) \}\)/);
  assert.match(clientServer, /function summarizeClientProfile\(profile = \{\}\)/);
  assert.doesNotMatch(clientServer.match(/function summarizeClientProfile[\s\S]*?\n\}/)?.[0] || "", /secretAccessKey|accessKeyId|heartbeatSecret|vlessUri|claimCode|token/);
  assert.match(httpContract, /Object\.hasOwn\(profileReadPayload\.profile\.storage, "secretAccessKey"\), false/);
  assert.match(httpContract, /Object\.hasOwn\(profileReadPayload\.profile\.tunnel, "uri"\), false/);
  assert.match(httpContract, /Object\.hasOwn\(imported\.profile\.heartbeat, "secret"\), false/);
});

test("client UI surfaces heartbeat status from local runtime state", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(html, /id="clientVersion"/);
  assert.match(html, /id="clientProtocols"/);
  assert.match(html, /id="serverProtocols"/);
  assert.match(html, /id="protocolCompatibility"/);
  assert.match(html, /id="compatibilityPolicy"/);
  assert.match(html, /id="clientBuildId"/);
  assert.match(html, /id="clientBuildTime"/);
  assert.match(html, /id="releaseManifestStatus"/);
  assert.match(html, /id="releaseManifestBuiltAt"/);
  assert.match(html, /id="localStateStatus"/);
  assert.match(html, /id="secretVaultStatus"/);
  assert.match(app, /status\.appVersion \|\| status\.clientVersion/);
  assert.match(app, /const successfulHeartbeat = currentSuccessfulHeartbeat\(status\)/);
  assert.match(app, /formatProtocols\(status\.diagnostics\?\.protocols\)/);
  assert.match(app, /formatProtocols\(successfulHeartbeat\?\.serverDiagnostics\?\.protocols\)/);
  assert.match(app, /formatCompatibility\(successfulHeartbeat\?\.compatibility\)/);
  assert.match(app, /formatCompatibilityPolicy\(successfulHeartbeat\?\.compatibility\?\.policy\)/);
  assert.match(app, /let latestStatus = null/);
  assert.match(app, /latestStatus = status/);
  assert.match(app, /status\.diagnostics\?\.buildId/);
  assert.match(app, /status\.diagnostics\?\.buildTime/);
  assert.match(app, /formatReleaseManifest\(status\.releaseManifest\)/);
  assert.match(app, /status\.releaseManifest\?\.builtAt/);
  assert.match(app, /function formatReleaseManifest\(manifest\)/);
  assert.match(app, /function formatReleaseManifestSupportDocuments\(supportDocuments\)/);
  assert.match(app, /function formatReleaseManifestRequiredFiles\(requiredFiles\)/);
  assert.match(app, /合同文档已登记/);
  assert.match(app, /合同文档缺失或无效：/);
  assert.match(app, /关键文件已登记/);
  assert.match(app, /关键文件未登记：/);
  assert.match(app, /release_manifest_missing: "未找到发布包 manifest/);
  assert.match(app, /release_manifest_invalid: "发布包 manifest 无法解析/);
  assert.match(app, /function formatProtocols\(protocols = \{\}\)/);
  assert.match(app, /\["admin", protocols\.adminState\]/);
  assert.match(app, /function currentSuccessfulHeartbeat\(status = latestStatus\)/);
  assert.match(app, /status\?\.heartbeat\?\.ok\s+\? status\.heartbeat\s+:\s+status\?\.lastSuccessfulHeartbeat\?\.ok/);
  assert.match(app, /function formatCompatibility\(compatibility\)/);
  assert.match(app, /function formatCompatibilityPolicy\(policy = \{\}\)/);
  assert.match(app, /function formatLocalState\(localState\)/);
  assert.match(app, /function formatSecretVault\(vault\)/);
  assert.match(app, /binary\.errorCode \? formatError/);
  assert.match(app, /status\.safeguards\?\.localState/);
  assert.match(app, /status\.safeguards\?\.secretVault/);
  assert.match(app, /local_state_corrupt: "本地状态文件损坏，请先导出诊断包，备份并修复或隔离损坏 JSON 后再按需重新导入 SyncKey。"/);
  assert.match(app, /server_singbox_config_write_failed: "服务端 sing-box 配置写入失败，请联系管理员检查路径和权限。"/);
  assert.match(app, /server_state_corrupt: "服务端状态文件损坏，请联系管理员备份并修复 sfsc-state\.json。"/);
  assert.match(app, /server_state_locked: "服务端数据目录已有运行中的写入者，请联系管理员检查是否重复启动 sync-server。"/);
  assert.match(app, /server_state_write_failed: "服务端状态文件写入失败，请联系管理员检查数据目录权限和磁盘空间。"/);
  assert.match(app, /secret_vault_missing: "本地密钥库缺少同步密钥，请重新导入 SyncKey。"/);
  assert.match(app, /missing_singbox_binary: "客户端缺少 sing-box 组件/);
  assert.match(app, /missing_rclone_binary: "客户端缺少 rclone 组件/);
  assert.match(app, /function formatSyncCompatibilityWarning\(compatibility = \{\}\)/);
  assert.match(app, /upgrade_remote: `客户端过旧/);
  assert.match(app, /upgrade_local: `服务端过旧/);
  assert.match(app, /diagnostics_missing: `诊断信息缺失/);
  assert.match(html, /id="heartbeatStatus"/);
  assert.match(html, /id="heartbeatHealth"/);
  assert.match(html, /id="deviceRecoveryNotice"/);
  assert.match(app, /renderHeartbeat\(status\.heartbeat, status\.profileImported\)/);
  assert.match(app, /renderDeviceRecovery\(status\.profileImported, status\.heartbeat\)/);
  assert.match(app, /profileStatusDisplay\(status\.profileImported, status\.heartbeat\)/);
  assert.match(app, /function heartbeatDisplay/);
  assert.match(app, /function formatHeartbeatDevice\(device\)/);
  assert.match(app, /device\.sync\?\.currentFile \|\| device\.sync\?\.lastRun\?\.currentFile/);
  assert.match(app, /当前文件：\$\{currentFile\}/);
  assert.match(app, /function deviceRecoveryMessage/);
  assert.match(app, /function profileStatusDisplay/);
  assert.match(app, /heartbeat_failed: "无法向服务端上报在线状态，同步可继续。"/);
  assert.match(app, /device_not_found: "当前客户端未在服务端登记，请重新生成并导入 SyncKey。"/);
  assert.match(app, /pill: "设备已停用"/);
  assert.match(app, /pill: "设备未登记"/);
  assert.match(app, /请在服务端控制台重新启用此设备/);
  assert.match(app, /请在服务端重新生成 SyncKey/);
  assert.match(app, /formatError\(\{ code: heartbeat\.remoteErrorCode/);
  assert.match(app, /details\.push\(`服务端：\$\{remoteMessage\}`\)/);
});

test("client release manifest support documents report invalid document names", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const formatReleaseManifestSupportDocuments = buildReleaseManifestSupportDocumentsFormatter(app);

  const message = formatReleaseManifestSupportDocuments({
    ok: false,
    files: [
      {
        name: "INTERFACE_CONTRACT",
        path: "resources/app/docs/INTERFACE_CONTRACT.md",
        present: true,
        valid: false
      },
      {
        name: "API_MATRIX",
        path: "resources/app/docs/API_MATRIX.md",
        present: true,
        valid: true
      }
    ]
  });

  assert.equal(message, "合同文档缺失或无效：INTERFACE_CONTRACT");
  assert.match(message, /INTERFACE_CONTRACT/);
  assert.doesNotMatch(message, /API_MATRIX/);
});

test("client profile import errors show retry guidance for SyncKey recovery", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /function formatProfileImportError\(error\)/);
  assert.match(app, /function profileImportErrorGuidance\(code\)/);
  assert.match(app, /const message = formatProfileImportError\(error\)/);
  assert.match(app, /\$\("profileSummary"\)\.textContent = message/);
  assert.match(app, /setAction\(message, "bad"\)/);
  assert.match(app, /return `导入失败：\$\{item\.message\} \$\{item\.action\}`/);
  assert.doesNotMatch(app, /\$\("profileSummary"\)\.textContent = `导入失败：\$\{formatError\(error\)\}`/);

  for (const code of [
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "validation_failed"
  ]) {
    assert.match(app, new RegExp(`${code}: \\{[\\s\\S]*?retryable: false`));
  }
  assert.match(app, /不可重试当前 SyncKey：请在服务端重新生成后导入。/);
  assert.match(app, /不可重试当前内容：请重新复制完整 SyncKey/);
  assert.match(app, /不要粘贴短码/);

  for (const code of [
    "server_state_write_failed",
    "claim_redeem_failed",
    "request_timeout",
    "network_error"
  ]) {
    assert.match(app, new RegExp(`${code}: \\{[\\s\\S]*?retryable: true`));
  }
  assert.match(app, /用同一个 SyncKey 再试/);
  assert.match(app, /服务端数据目录权限和磁盘空间/);
  assert.match(app, /网络、服务端地址和服务端进程/);

  assert.match(app, /profile_heartbeat_required: \{[\s\S]*?服务端下发配置缺少心跳密钥/);
  assert.match(app, /profile_storage_required: \{[\s\S]*?服务端下发配置缺少存储凭据/);
  assert.match(app, /profile_tunnel_required: \{[\s\S]*?服务端下发配置缺少隧道信息/);
  assert.match(app, /profile_heartbeat_required: \{[\s\S]*?不可重试当前 SyncKey/);
  assert.match(app, /profile_storage_required: \{[\s\S]*?不可重试当前 SyncKey/);
  assert.match(app, /profile_tunnel_required: \{[\s\S]*?不可重试当前 SyncKey/);
});

test("client heartbeat normalizes last run summaries through the shared contract", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(server, /normalizeSyncRun/);
  assert.match(server, /const lastRun = normalizeSyncRun\(syncHistory\[0\] \|\| sync\.lastRun \|\| null\)/);
  assert.match(server, /scheduler: buildSchedulerStatus\(\)/);
  assert.match(server, /runSync\(body\.job \|\| \{\}, \{ trigger: "manual" \}\)/);
  assert.match(server, /runSync\(due\.job, \{ trigger: "scheduler" \}\)/);
  assert.match(server, /trigger: normalizeSyncRunTrigger\(run\.trigger\)/);
  assert.match(server, /metrics\.errorCode \|\| exit\.errorCode \|\| "rclone_sync_failed"/);
  assert.match(server, /syncState: status === "error" \? "error" : "idle"/);
});

test("client heartbeat v1 omits local phase without mutating local sync state", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const context = {
    sync: {
      syncState: "syncing",
      phase: "scanning",
      speedMbps: 2.5
    },
    scheduler: { enabled: true },
    lastRun: { status: "running" }
  };
  runInNewContext([
    extractBrowserFunctionRange(server, "function buildHeartbeatSyncV1", "async function sendHeartbeat"),
    "this.heartbeatSync = buildHeartbeatSyncV1(sync, scheduler, lastRun);"
  ].join("\n"), context);

  assert.equal(Object.hasOwn(context.heartbeatSync, "phase"), false);
  assert.equal(context.heartbeatSync.syncState, "syncing");
  assert.equal(context.heartbeatSync.speedMbps, 2.5);
  assert.deepEqual(context.heartbeatSync.scheduler, context.scheduler);
  assert.deepEqual(context.heartbeatSync.lastRun, context.lastRun);
  assert.equal(context.sync.phase, "scanning");
  assert.match(server, /sync: buildHeartbeatSyncV1\(sync, buildSchedulerStatus\(\), lastRun\)/);
});

test("client sync run uses one profile and job snapshot for fingerprint and execution", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const runSyncExclusiveSource = server.slice(
    server.indexOf("async function runSyncExclusive"),
    server.indexOf("async function ensureSyncRunBinaries")
  );

  assert.match(server, /const runPlan = await buildSyncRunPlan\(job\)/);
  assert.match(server, /function getTunnelUri\(profile\)/);
  assert.match(server, /async function buildSyncRunPlan\(job = \{\}\)/);
  assert.match(server, /const normalizedJob = buildJobFromProfile\(profile, job\)/);
  assert.match(server, /tunnelUri/);
  assert.match(server, /return buildSyncPreviewFromNormalizedJob\(normalized\)/);
  assert.match(server, /async function runSyncExclusive\(runPlan, options = \{\}\)/);
  assert.match(runSyncExclusiveSource, /const \{ normalizedJob, tunnelUri \} = runPlan/);
  assert.match(runSyncExclusiveSource, /const recovery = getSyncRecoveryPaths\(normalizedJob\)/);
  assert.match(runSyncExclusiveSource, /const preview = \(await buildSyncPreviewFromNormalizedJob\(normalizedJob, \{/);
  assert.match(runSyncExclusiveSource, /backupDir: recovery\?\.current \|\| ""/);
  assert.match(runSyncExclusiveSource, /pruneSyncRecovery\(preview, recovery, normalizedJob\.safety\.recoveryRetentionDays\)/);
  assert.doesNotMatch(runSyncExclusiveSource, /normalizeJob/);
  assert.doesNotMatch(runSyncExclusiveSource, /readProfile/);
  assert.doesNotMatch(runSyncExclusiveSource, /readStoredProfile/);
  assert.doesNotMatch(server, /runSync\(await normalizeJob\(body\.job \|\| \{\}\), \{ trigger: "manual" \}\)/);
  assert.doesNotMatch(runSyncExclusiveSource, /buildSyncPreview\(normalizedJob\)/);
});

test("client sync stop waits for rclone exit and keeps diagnostics stable", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const processRunner = await readFile(join(projectRoot, "client", "src", "processRunner.js"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");

  assert.match(processRunner, /this\.child && this\.child\.exitCode == null && this\.child\.signalCode == null/);
  assert.doesNotMatch(processRunner, /this\.child\.exitCode == null && !this\.child\.killed/);
  assert.match(processRunner, /signalCode: signalCode \|\| null/);
  assert.match(processRunner, /this\.child = null/);
  assert.match(server, /const STOPPING_SYNC_REPLAY_MS = 2000/);
  assert.match(server, /let stoppingSyncReplay = null/);
  assert.match(server, /async function stopSync\(\)/);
  assert.match(server, /await syncProcess\.stopAndWait\(\{ timeoutMs: 2500 \}\)/);
  assert.match(server, /stopTimedOut/);
  assert.match(server, /function currentStoppingSyncReplay/);
  assert.match(server, /function currentSyncProcessStatus\(\)/);
  assert.match(server, /function markSyncStopping\(\)/);
  assert.match(server, /syncState: "stopping"/);
  assert.match(server, /syncState: syncMetrics\.syncState === "stopping" \? "stopping" : "syncing"/);
  assert.match(server, /\? syncMetrics\.syncState === "stopping" \|\| replay \? "stopping" : "syncing"/);
  assert.match(server, /const lastExit = exit && typeof exit === "object"[\s\S]*\? \{ \.\.\.exit, errorCode, error \}/);
  assert.match(app, /function syncStatusPill/);
  assert.match(app, /function currentProcessSyncState\(sync = \{\}\)/);
  assert.match(app, /const state = currentProcessSyncState\(sync\);/);
  assert.match(app, /const syncState = currentProcessSyncState\(sync\);/);
  assert.match(app, /state === "stopping"/);
  assert.match(app, /return \{ text: "正在停止", state: "warn" \}/);
  assert.match(app, /if \(sync\.running \|\| state === "syncing"\)/);
  assert.match(app, /const syncPill = syncStatusPill\(status\.processes\.sync \|\| \{\}\)/);
  assert.match(httpContract, /client sync stop waits through delayed rclone exit before accepting a new run/);
  assert.match(httpContract, /stopActive\.secondRunAfterStop/);
  assert.match(httpContract, /historyAfterIdleStop/);
  assert.match(httpContract, /statusAfterIdleStop\.processes\.sync\.metrics\.syncState, "idle"/);
  assert.match(httpContract, /statusAfterIdleStop\.lastSync, null/);
});

test("client confirms sync compatibility warnings before saving or running sync", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(html, /<form id="confirmForm" class="modal-card">/);
  assert.match(html, /id="confirmCancelBtn" type="button"/);
  assert.match(html, /id="confirmSubmitBtn" type="submit"/);
  assert.match(server, /function requireSyncCompatibilityConfirmation\(body = \{\}\)/);
  assert.match(server, /let lastSuccessfulHeartbeat = await readLastSuccessfulHeartbeat\(paths\)/);
  assert.match(server, /let heartbeatGeneration = 0/);
  assert.match(server, /let heartbeatInFlight = null/);
  assert.match(server, /function sendHeartbeat\(\) \{[\s\S]*?if \(heartbeatInFlight\) \{[\s\S]*?return heartbeatInFlight;/);
  assert.match(server, /heartbeatInFlight = sendHeartbeatOnce\(\)\.finally\(\(\) => \{\s*heartbeatInFlight = null;/);
  assert.match(server, /async function sendHeartbeatOnce\(\)/);
  assert.match(server, /async function resetHeartbeatState\(\)/);
  assert.match(server, /await resetHeartbeatState\(\);\s+sendHeartbeat\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(server, /lastSuccessfulHeartbeat = successfulHeartbeat/);
  assert.match(server, /await saveLastSuccessfulHeartbeat\(successfulHeartbeat, paths\);\s*\n\s*lastHeartbeat = successfulHeartbeat;\s*\n\s*lastSuccessfulHeartbeat = successfulHeartbeat;/);
  assert.match(server, /clearLastSuccessfulHeartbeat\(paths\)/);
  assert.match(server, /lastSuccessfulHeartbeat\?\.ok && lastSuccessfulHeartbeat\?\.compatibility\?\.policy\?\.syncRun === "warn"/);
  assert.match(server, /body\.confirmCompatibilityWarning !== true/);
  assert.match(server, /"danger_confirmation_required"/);
  assert.match(server, /Confirm protocol compatibility warning before saving or running sync/);
  assert.match(server, /requireSyncCompatibilityConfirmation\(body\)/);
  assert.match(server, /lastSuccessfulHeartbeat,/);
  assert.match(app, /function currentSyncCompatibility\(\)/);
  assert.match(app, /const compatibility = currentSyncCompatibility\(\);/);
  assert.match(app, /return currentSuccessfulHeartbeat\(\)\?\.compatibility \|\| null/);
  assert.match(app, /\["save", "run"\]\.includes\(action\) && compatibility\?\.policy\?\.syncRun === "warn"/);
  assert.match(app, /title: "确认协议兼容性风险"/);
  assert.match(app, /formatSyncCompatibilityWarning\(compatibility\)/);
  assert.match(app, /submitText: action === "save" \? "继续保存" : "继续同步"/);
  assert.match(app, /if \(!confirmedCompatibility\) \{/);
  assert.match(app, /confirmCompatibilityWarning = true/);
  assert.match(app, /confirmed = await readConfirmedJob\("save"\)/);
  assert.match(app, /confirmed = await readConfirmedJob\("run"\)/);
  assert.match(app, /confirmCompatibilityWarning: confirmed\.confirmCompatibilityWarning/);
  assert.match(app, /function destructiveSyncConfirmationBody\(job = \{\}\)/);
  assert.match(app, /`本地：\$\{job\.localPath \|\| "未选择"\}`/);
  assert.match(app, /`方向：\$\{formatDirection\(job\.direction\)\}`/);
  assert.match(app, /"同步内容：当前 SyncKey 已授权内容"/);
  // formatRemoteTarget/formatServerSpace 已随本地路由控件一起删除：前者返回常量、
  // 后者翻译的正是被废除的「共享空间/设备空间」二分，留着就等着被重新接上。
  assert.doesNotMatch(app, /function formatRemoteTarget/);
  assert.doesNotMatch(app, /function formatServerSpace/);
  assert.doesNotMatch(app, /共享空间|设备空间/);
  assert.match(app, /const job = readJob\(\);\s+const result = await clientApi\.previewSync\(\{ job \}\);\s+lastPreviewJobFingerprint = jobPreviewFingerprint\(job\)/);
  assert.match(app, /clientApi\.saveJob\(\{\s+job: confirmed\.job,\s+confirmCompatibilityWarning: confirmed\.confirmCompatibilityWarning,\s+confirmDestructiveSync: confirmed\.confirmDestructiveSync\s+\}\)/);
  assert.match(app, /createSyncSafetyPlan\(\{ job: confirmed\.job \}\)/);
  assert.match(app, /safetyPlanId/);
});

test("client confirmation modal resolves only valid user decisions", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildConfirmationContext(app);

  const requiredDecision = context.requestConfirmation({
    title: "确认危险同步",
    body: "该操作会修改目标文件。",
    requiredText: "确认同步",
    submitText: "继续同步"
  });
  assert.equal(context.elements.confirmGate.hidden, false);
  assert.equal(context.elements.confirmGate.classList.contains("open"), true);
  assert.equal(context.elements.confirmTitle.textContent, "确认危险同步");
  assert.equal(context.elements.confirmBody.textContent, "该操作会修改目标文件。");
  assert.equal(context.elements.confirmTextLabel.hidden, false);
  assert.equal(context.elements.confirmTextInput.placeholder, "输入 确认同步");
  assert.equal(context.elements.confirmTextInput.focused, true);
  assert.equal(context.elements.confirmSubmitBtn.textContent, "继续同步");

  let submitPrevented = false;
  let resolved = false;
  requiredDecision.then(() => {
    resolved = true;
  });
  context.elements.confirmTextInput.value = "确认";
  context.submitConfirmation({
    preventDefault: () => {
      submitPrevented = true;
    }
  });
  await Promise.resolve();
  assert.equal(submitPrevented, true);
  assert.equal(resolved, false);
  assert.equal(context.elements.confirmGate.hidden, false);
  assert.equal(context.elements.confirmMessage.hidden, false);
  assert.equal(context.elements.confirmMessage.textContent, "请输入 确认同步 以确认。");

  context.elements.confirmTextInput.value = "确认同步";
  context.submitConfirmation({ preventDefault: () => {} });
  const confirmedDecision = await requiredDecision;
  assert.equal(confirmedDecision.confirmed, true);
  assert.equal(confirmedDecision.text, "确认同步");
  assert.equal(context.elements.confirmGate.hidden, true);
  assert.equal(context.elements.confirmGate.classList.contains("open"), false);
  assert.equal(context.elements.confirmMessage.hidden, true);

  const cancelDecision = context.requestConfirmation({
    title: "确认协议兼容性风险",
    body: "服务端建议升级。",
    submitText: "继续保存"
  });
  assert.equal(context.elements.confirmTextLabel.hidden, true);
  assert.equal(context.elements.confirmTextInput.placeholder, "");
  assert.equal(context.elements.confirmSubmitBtn.focused, true);
  context.cancelConfirmation();
  assert.equal(await cancelDecision, null);
  assert.equal(context.elements.confirmGate.hidden, true);

  const supersededDecision = context.requestConfirmation({ requiredText: "旧确认" });
  let supersededValue = "pending";
  supersededDecision.then((value) => {
    supersededValue = value;
  });
  const latestDecision = context.requestConfirmation({ requiredText: "新确认" });
  await Promise.resolve();
  assert.equal(supersededValue, null);
  context.cancelConfirmation();
  assert.equal(await latestDecision, null);
});

test("client confirmed job flow sequences compatibility and destructive sync confirmations", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildConfirmedJobContext(app, {
    compatibility: {
      status: "warning",
      action: "upgrade_remote",
      policy: { syncRun: "warn" },
      issues: [{ field: "clientStatus", local: 2, remote: 1 }]
    },
    job: { destructiveSync: true, direction: "upload" }
  });

  context.confirmationQueue.push({ confirmed: true }, { confirmed: true, text: "镜像同步" });
  const confirmedRun = await context.readConfirmedJob("run");
  assert.equal(context.confirmations.length, 2);
  assert.equal(context.confirmations[0].title, "确认协议兼容性风险");
  assert.equal(context.confirmations[0].submitText, "继续同步");
  assert.match(context.confirmations[0].body, /客户端协议过旧/);
  assert.equal(context.confirmations[1].title, "启动镜像同步");
  assert.equal(context.confirmations[1].requiredText, "镜像同步");
  assert.equal(context.confirmations[1].submitText, "开始同步");
  assert.match(context.confirmations[1].body, /镜像同步会删除目标端多余文件/);
  assert.match(context.confirmations[1].body, /本地：D:\\Work/);
  assert.match(context.confirmations[1].body, /当前 SyncKey 已授权内容/);
  // 确认框绝不能泄露存储路由。草稿里带着仓库名和前缀，正是可能被顺手拼进去的两个值。
  assert.doesNotMatch(context.confirmations[1].body, /home-sync|devices\/company-pc1/);
  assert.equal(confirmedRun.confirmCompatibilityWarning, true);
  assert.equal(confirmedRun.confirmDestructiveSync, true);
  assert.equal(confirmedRun.job.destructiveSync, true);

  const saveContext = buildConfirmedJobContext(app, {
    compatibility: { policy: { syncRun: "warn" } },
    job: { destructiveSync: true }
  });
  saveContext.confirmationQueue.push(null);
  assert.equal(await saveContext.readConfirmedJob("save"), null);
  assert.equal(saveContext.confirmations.length, 1);
  assert.equal(saveContext.confirmations[0].title, "确认协议兼容性风险");

  const destructiveCancelContext = buildConfirmedJobContext(app, {
    compatibility: { policy: { syncRun: "warn" } },
    job: { destructiveSync: true }
  });
  destructiveCancelContext.confirmationQueue.push({ confirmed: true }, null);
  assert.equal(await destructiveCancelContext.readConfirmedJob("run"), null);
  assert.equal(destructiveCancelContext.confirmations.length, 2);

  const noDestructiveContext = buildConfirmedJobContext(app, {
    compatibility: { policy: { syncRun: "warn" } },
    job: { destructiveSync: false }
  });
  noDestructiveContext.confirmationQueue.push({ confirmed: true });
  const confirmedSave = await noDestructiveContext.readConfirmedJob("save");
  assert.equal(noDestructiveContext.confirmations.length, 1);
  assert.equal(noDestructiveContext.confirmations[0].submitText, "继续保存");
  assert.equal(confirmedSave.confirmCompatibilityWarning, true);
  assert.equal(confirmedSave.confirmDestructiveSync, false);
});

test("client confirmed job carries no local storage routing, so the SyncKey prefix is the only target", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  // 旧行为是用户自己填远端子目录并在共享空间下必填。两者都已删除：MinIO 策略只
  // 授权 ${prefix}/*，客户端能提供的任何路由选择都是一个服务端必拒的组合。
  // 这里断言 job 里连字段都不再出现，而不是断言它等于某个默认值——留一个默认值
  // 就等于留一条重新接上本地路由的缝。
  const context = buildConfirmedJobContext(app, {
    job: { direction: "upload", localPath: "D:\\Work" }
  });
  const confirmed = await context.readConfirmedJob("save");
  assert.equal(Object.hasOwn(confirmed.job, "remoteFolder"), false);
  assert.equal(Object.hasOwn(confirmed.job, "serverSpace"), false);
  assert.equal(confirmed.job.localPath, "D:\\Work");
  assert.equal(confirmed.job.direction, "upload");

  // 草稿里带着历史遗留的 serverSpace 时也不能被读回 job：老任务能继续跑靠的是
  // 服务端 buildJobFromProfile 仍然接受这些字段，不是客户端再把它们发出去。
  assert.doesNotMatch(app, /serverSpace: fields\./);
  assert.doesNotMatch(app, /remoteFolder: fields\./);
});

test("client save and run send confirmed job payload flags to local API", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildSaveRunContext(app);

  context.confirmedJob = {
    job: { localPath: "D:\\Work", direction: "upload", destructiveSync: true },
    confirmCompatibilityWarning: true,
    confirmDestructiveSync: true
  };
  await context.saveJob();
  assert.equal(context.apiCalls.length, 1);
  assert.equal(context.apiCalls[0].name, "saveJob");
  assert.equal(context.apiCalls[0].payload.confirmCompatibilityWarning, true);
  assert.equal(context.apiCalls[0].payload.confirmDestructiveSync, true);
  assert.equal(context.apiCalls[0].payload.job.localPath, "D:\\Work");
  assert.equal(context.actions.at(-1).text, "同步任务已保存。");
  assert.equal(context.loadStatusCalls, 1);

  context.confirmedJob = {
    job: { localPath: "D:\\Work", direction: "download", destructiveSync: false },
    confirmCompatibilityWarning: true,
    confirmDestructiveSync: true
  };
  await context.runSync();
  assert.equal(context.apiCalls.length, 2);
  assert.equal(context.apiCalls[1].name, "runSync");
  assert.equal(context.apiCalls[1].payload.confirmCompatibilityWarning, true);
  assert.equal(context.apiCalls[1].payload.confirmDestructiveSync, true);
  assert.equal(context.actions.at(-1).text, "同步已开始。");
  assert.equal(context.loadStatusCalls, 2);
  assert.equal(context.refreshLogsCalls, 1);

  context.confirmedJob = null;
  await context.saveJob();
  assert.equal(context.apiCalls.length, 2);
});

test("client forwards compatibility confirmation to bidirectional initialization", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildSaveRunContext(app);
  context.confirmedJob = {
    job: {
      localPath: "D:\\Work",
      direction: "bidirectional",
      safety: { bidirectional: { initialMode: "newer" } }
    },
    confirmCompatibilityWarning: true,
    confirmDestructiveSync: false
  };
  context.safetyPlans.push(
    { id: "before-init", deletions: { allowed: true }, bidirectional: { initializationRequired: true } },
    { id: "after-init", deletions: { allowed: true }, bidirectional: { initializationRequired: false } }
  );

  await context.runSync();

  const initialization = context.apiCalls.find((call) => call.name === "initializeBidirectionalSync");
  assert.equal(initialization.payload.confirmCompatibilityWarning, true);
  assert.equal(initialization.payload.confirmBidirectionalInitialization, true);
});

test("client reports a pending stop when the sync process outlives the stop timeout", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildStopSyncContext(app, { running: true, stopTimedOut: true });

  await context.stopSync();

  assert.equal(context.actions.at(-1).text, "停止请求已发送，同步仍在停止中。");
  assert.equal(context.actions.at(-1).state, "warn");
  assert.equal(context.loadStatusCalls, 1);
  assert.equal(context.refreshLogsCalls, 1);
});

test("client derives authorization and heartbeat summaries from current heartbeat state", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const elements = {
    authorizedContentState: makeFakeElement(),
    authorizedContentValue: makeFakeElement()
  };
  const context = {
    document: { getElementById: (id) => elements[id] }
  };
  const source = extractBrowserFunctionRange(
    app,
    "function profileHeartbeatSummary",
    "function destructiveSyncConfirmationBody"
  );
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    source,
    "this.profileHeartbeatSummary = profileHeartbeatSummary;",
    "this.authorizationState = authorizationState;",
    "this.renderAuthorizedContent = renderAuthorizedContent;"
  ].join("\n"), context);

  assert.equal(context.profileHeartbeatSummary({ ok: true }), "正常");
  assert.equal(context.profileHeartbeatSummary({ remoteErrorCode: "device_disabled" }), "不可用");
  assert.equal(context.authorizationState({ remoteErrorCode: "device_disabled" }), "disabled");
  context.renderAuthorizedContent("disabled");
  assert.equal(elements.authorizedContentState.textContent, "设备已停用");
  assert.equal(elements.authorizedContentValue.textContent, "服务端已停用此设备。重新启用后才能继续同步。");
});

test("client exposes stable heartbeat and request timeout transport codes", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const profileImport = await readFile(join(projectRoot, "client", "src", "profileImport.js"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(server, /errorCode: "heartbeat_failed"/);
  assert.match(server, /remoteErrorCode/);
  assert.match(server, /function normalizeHeartbeatRemoteErrorCode\(value\)/);
  assert.match(server, /isStableErrorCode\(code\)/);
  assert.match(server, /\.\.\.\(remoteError\.errorCode \? \{ remoteErrorCode: remoteError\.errorCode \} : \{\}\)/);
  assert.match(server, /function validateHeartbeatSuccessResponse\(body\)/);
  assert.match(server, /validateHeartbeatSuccessResponse\(responseBody\)/);
  assert.match(server, /serverDiagnostics: responseBody\.diagnostics/);
  assert.match(server, /device: summarizeHeartbeatDevice\(responseBody\.device\)/);
  assert.match(server, /compatibility: responseBody\.device\.compatibility/);
  assert.match(server, /Malformed heartbeat response/);
  assert.match(server, /message: `Heartbeat failed:/);
  assert.match(server, /const heartbeatTimeoutMs = Number\(process\.env\.SFSC_HEARTBEAT_TIMEOUT_MS \|\| 10000\)/);
  assert.match(server, /const claimRedeemTimeoutMs = Number\(process\.env\.SFSC_CLAIM_REDEEM_TIMEOUT_MS \|\| 15000\)/);
  assert.match(server, /const claimRecovery = await prepareClaimRecoveryForImport\(body\)/);
  assert.match(server, /const stateSnapshot = await snapshotProfileImportState\(paths\)/);
  assert.match(server, /resolveProfileImport\(body, \{\s*timeoutMs: claimRedeemTimeoutMs,\s*clientRedeemId: claimRecovery\?\.clientRedeemId,\s*clientInstallId: claimRecovery\?\.clientInstallId\s*\}\)/);
  assert.match(server, /await restoreProfileImportState\(stateSnapshot\)/);
  assert.match(server, /await clearClaimRecovery\(claimRecovery, paths\)/);
  assert.match(server, /function summarizeHeartbeatDevice\(device = null\)/);
  assert.match(server, /sync: summarizeHeartbeatDeviceSync\(device\.sync\)/);
  assert.match(server, /function summarizeHeartbeatDeviceSync\(sync = null\)/);
  assert.match(server, /currentFile: typeof sync\.currentFile === "string" \? sync\.currentFile : ""/);
  assert.match(server, /currentJob: summarizeHeartbeatDeviceJob\(sync\.currentJob\)/);
  assert.match(server, /function summarizeHeartbeatSyncRun\(run = null\)/);
  assert.match(server, /function summarizeHeartbeatConflicts\(conflicts = null\)/);
  assert.match(server, /function summarizeHeartbeatScheduler\(scheduler = null\)/);
  assert.match(server, /signal: controller\?\.signal/);
  assert.match(server, /timed out after \$\{heartbeatTimeoutMs\}ms/);
  assert.match(profileImport, /DEFAULT_CLAIM_REDEEM_TIMEOUT_MS = Number\(process\.env\.SFSC_CLAIM_REDEEM_TIMEOUT_MS \|\| 15000\)/);
  assert.match(profileImport, /isClaimRedeemErrorCode/);
  assert.match(profileImport, /function normalizeClaimRedeemErrorCode/);
  assert.match(profileImport, /const controller = typeof AbortController === "function" && timeoutMs > 0/);
  assert.match(profileImport, /signal: controller\?\.signal/);
  assert.match(profileImport, /SyncKey redemption request timed out after \$\{timeoutMs\}ms/);
  assert.match(app, /const defaultRequestTimeoutMs = 15000/);
  assert.match(app, /const profileImportRequestTimeoutMs = 60000/);
  assert.match(app, /const syncRunRequestTimeoutMs = 120000/);
  assert.match(app, /const syncPreparationRequestTimeoutMs = 120000/);
  assert.match(app, /const bidirectionalInitializationRequestTimeoutMs = 240000/);
  assert.match(app, /clientApi\.importProfile\(\{ code \}, \{ timeoutMs: profileImportRequestTimeoutMs \}\)/);
  assert.match(app, /const clientApi = Object\.freeze\(\{/);
  assert.match(app, /getStatus: \(\) => requestJson\(\{ method: "GET", path: "\/api\/client\/status" \}\)/);
  assert.match(app, /stopSync: \(\) => requestJson\(\{ method: "POST", path: "\/api\/sync\/stop", body: \{\} \}\)/);
  assert.match(app, /runSync: \(body\) => requestJson\(\{ method: "POST", path: "\/api\/sync\/run", body, timeoutMs: syncRunRequestTimeoutMs \}\)/);
  assert.match(app, /createSyncSafetyPlan: \(body\) => requestJson\(\{ method: "POST", path: "\/api\/sync\/safety-plan", body, timeoutMs: syncPreparationRequestTimeoutMs \}\)/);
  assert.match(app, /initializeBidirectionalSync: \(body\) => requestJson\(\{ method: "POST", path: "\/api\/sync\/bisync\/initialize", body, timeoutMs: bidirectionalInitializationRequestTimeoutMs \}\)/);
  assert.match(app, /body: body === undefined \? undefined : JSON\.stringify\(body\)/);
  assert.doesNotMatch(app, /\bapi\("\/api\//);
  assert.match(app, /AbortController/);
  assert.match(app, /timedOut \? "request_timeout" : "network_error"/);
  assert.match(app, /request_timeout: "客户端操作等待超时，请刷新状态后确认结果。"/);
  assert.match(app, /同步启动等待超时：客户端仍可能在后台准备任务，请稍后刷新同步状态。/);
  assert.match(app, /error\.code === "request_timeout"[\s\S]*Promise\.allSettled\(\[loadStatus\(\), refreshLogs\(\)\]\)/);
});

test("client status polling avoids overlapping background requests and stale updates", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /let statusRequestInFlight = null/);
  assert.match(app, /let latestStatusRequestId = 0/);
  assert.match(app, /let latestAppliedStatusRequestId = 0/);
  assert.match(app, /setInterval\(\(\) => loadStatus\(\{ background: true \}\), 1000\)/);
  assert.match(app, /if \(options\.background && statusRequestInFlight\) \{/);
  assert.match(app, /return statusRequestInFlight/);
  assert.match(app, /if \(requestId < latestAppliedStatusRequestId\) \{/);
  assert.match(app, /if \(requestId < latestStatusRequestId\) \{/);
});

test("client status polling reuses in-flight background requests and ignores stale results", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildStatusPollingContext(app);
  const first = deferred();
  const second = deferred();
  const statuses = [
    makeClientStatus({ appVersion: "old-status", singboxRunning: false }),
    makeClientStatus({ appVersion: "new-status", singboxRunning: true })
  ];
  context.getStatusQueue.push(first.promise, second.promise);

  const firstLoad = context.loadStatus();
  const secondLoad = context.loadStatus();
  assert.equal(context.getStatusCalls, 2);
  second.resolve(statuses[1]);
  assert.equal((await secondLoad).appVersion, "new-status");
  assert.equal(context.elements.clientVersion.textContent, "new-status");
  assert.equal(context.elements.tunnelStatus.textContent, "隧道运行中");

  first.resolve(statuses[0]);
  assert.equal((await firstLoad).appVersion, "old-status");
  assert.equal(context.elements.clientVersion.textContent, "new-status");
  assert.equal(context.elements.tunnelStatus.textContent, "隧道运行中");

  const background = deferred();
  context.getStatusQueue.push(background.promise);
  const backgroundLoad = context.loadStatus({ background: true });
  const reusedBackgroundLoad = context.loadStatus({ background: true });
  assert.equal(context.getStatusCalls, 3);
  background.resolve(makeClientStatus({ appVersion: "background-status" }));
  assert.equal((await backgroundLoad).appVersion, "background-status");
  assert.equal((await reusedBackgroundLoad).appVersion, "background-status");
  assert.equal(context.elements.clientVersion.textContent, "background-status");
});

test("client long-running UI actions disable buttons and show shutdown failures", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /async function withBusyAction\(buttonId, action\)/);
  assert.match(app, /button\?\.dataset\.busy === "1"/);
  assert.match(app, /button\.disabled = true/);
  assert.match(app, /button\.setAttribute\("aria-busy", "true"\)/);
  assert.match(app, /button\.disabled = false/);
  assert.match(app, /button\.removeAttribute\("aria-busy"\)/);
  assert.match(app, /delete button\.dataset\.busy/);

  for (const buttonId of [
    "checkBinsBtn",
    "saveProfileBtn",
    "startTunnelBtn",
    "stopTunnelBtn",
    "saveJobBtn",
    "previewBtn",
    "runSyncBtn",
    "stopSyncBtn",
    "refreshHistoryBtn",
    "refreshLogsBtn",
    "exportDiagnosticsBtn",
    "shutdownBtn"
  ]) {
    assert.match(app, new RegExp(`withBusyAction\\("${buttonId}"`));
  }

  assert.match(app, /async function shutdownClient\(\)/);
  assert.match(app, /await clientApi\.shutdown\(\)/);
  assert.match(app, /setAction\("客户端已退出。", "good"\)/);
  assert.match(app, /setAction\(`退出客户端失败：\$\{formatError\(error\)\}`, "bad"\)/);
});

test("client busy action ignores duplicate clicks and always restores button state", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildBusyActionContext(app);
  const first = deferred();
  let callCount = 0;

  const firstResult = context.withBusyAction("runSyncBtn", async () => {
    callCount += 1;
    return first.promise;
  });
  assert.equal(context.elements.runSyncBtn.disabled, true);
  assert.equal(context.elements.runSyncBtn.dataset.busy, "1");
  assert.equal(context.elements.runSyncBtn.attributes["aria-busy"], "true");

  const duplicateResult = await context.withBusyAction("runSyncBtn", async () => {
    callCount += 1;
    return "duplicate";
  });
  assert.equal(duplicateResult, null);
  assert.equal(callCount, 1);

  first.resolve("done");
  assert.equal(await firstResult, "done");
  assert.equal(context.elements.runSyncBtn.disabled, false);
  assert.equal(context.elements.runSyncBtn.dataset.busy, undefined);
  assert.equal(context.elements.runSyncBtn.attributes["aria-busy"], undefined);

  await assert.rejects(
    () => context.withBusyAction("runSyncBtn", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(context.elements.runSyncBtn.disabled, false);
  assert.equal(context.elements.runSyncBtn.dataset.busy, undefined);
  assert.equal(context.elements.runSyncBtn.attributes["aria-busy"], undefined);
});

test("client folder picker uses Electron path and falls back to manual paste", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildFolderPickerContext(app);

  context.window.sfscDesktop = {
    pickFolder: async () => ({ path: "D:\\Work\\Sync" })
  };
  await context.chooseLocalFolder();
  assert.equal(context.fields.localPath.value, "D:\\Work\\Sync");
  assert.equal(context.actions.at(-1).text, "已选择本地文件夹。");
  assert.equal(context.actions.at(-1).state, "good");

  context.fields.localPath.value = "D:\\Previous";
  context.window.sfscDesktop = {
    pickFolder: async () => ({ canceled: true })
  };
  await context.chooseLocalFolder();
  assert.equal(context.fields.localPath.value, "D:\\Previous");
  assert.equal(context.actions.at(-1).text, "已选择本地文件夹。");
  assert.equal(context.actions.at(-1).state, "good");

  context.window.sfscDesktop = null;
  await context.chooseLocalFolder();
  assert.equal(context.fields.localPath.focused, true);
  assert.equal(context.actions.at(-1).text, "当前模式无法读取真实文件夹路径，请粘贴完整本地路径。");
  assert.equal(context.actions.at(-1).state, "bad");

  context.fields.localPath.focused = false;
  context.window.sfscDesktop = {
    pickFolder: async () => {
      throw new Error("dialog failed");
    }
  };
  await context.chooseLocalFolder();
  assert.equal(context.fields.localPath.focused, true);
  assert.equal(context.actions.at(-2).text, "选择文件夹失败：dialog failed");
  assert.equal(context.actions.at(-2).state, "bad");
  assert.equal(context.actions.at(-1).text, "当前模式无法读取真实文件夹路径，请粘贴完整本地路径。");

  context.fields.folderPicker.files = [{ path: "E:\\Legacy" }];
  context.pickFolder();
  assert.equal(context.fields.localPath.value, "E:\\Legacy");
  assert.equal(context.actions.at(-1).text, "已选择本地文件夹。");
  assert.equal(context.actions.at(-1).state, "good");
});

test("client UI API wraps non-JSON responses in stable request errors", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /async function readJsonOrFallback\(response\)/);
  assert.match(app, /JSON\.parse\(text\)/);
  assert.match(app, /buildNonJsonApiResponse\(response, text\)/);
  assert.match(app, /errorCode: "client_error"/);
  assert.doesNotMatch(app, /["']request_failed["']/);
  assert.match(app, /nonJson: true/);
  assert.match(app, /const result = await readJsonOrFallback\(response\)/);
  assert.match(app, /result\?\.nonJson === true/);
  assert.doesNotMatch(app, /await response\.json\(\)/);

  const context = buildBrowserApiContext(app);
  const parsed = await context.readJsonOrFallback({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "{\"ok\":true,\"value\":42}"
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, 42);

  const fallback = await context.readJsonOrFallback({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    text: async () => "<!doctype html><html><body><script>secret()</script><h1>Bad Gateway</h1><p>proxy exploded</p></body></html>"
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.status, 502);
  assert.equal(fallback.errorCode, "client_error");
  assert.equal(fallback.code, "client_error");
  assert.equal(fallback.nonJson, true);
  assert.match(fallback.message, /HTTP 502 Bad Gateway: Bad Gateway proxy exploded/);
  assert.equal(fallback.message.includes("<html"), false);
  assert.equal(fallback.message.includes("secret"), false);
  assert.equal(fallback.message.length < 240, true);

  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "plain text from a local runtime error page"
  });
  await assert.rejects(
    () => context.clientApi.getStatus(),
    (error) => {
      assert.equal(error.code, "client_error");
      assert.equal(error.status, 200);
      assert.match(error.message, /HTTP 200 OK: plain text from a local runtime error page/);
      return true;
    }
  );
});

test("client UI API rejects 2xx error envelopes except status-style endpoints", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /allowOkFalse = false/);
  assert.match(app, /result\?\.ok === false && !allowOkFalse/);
  assert.match(app, /checkBinaries: \(\) => requestJson\(\{ method: "POST", path: "\/api\/binaries\/check", body: \{\}, allowOkFalse: true \}\)/);

  const context = buildBrowserApiContext(app);
  context.fetch = async (path) => {
    if (path === "/api/binaries/check") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          ok: false,
          errorCode: "binary_missing",
          message: "rclone missing",
          singbox: { ok: true },
          rclone: { ok: false, errorCode: "binary_missing", message: "rclone missing" }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        ok: false,
        errorCode: "server_state_write_failed",
        message: "state write failed"
      })
    };
  };

  await assert.rejects(
    () => context.clientApi.saveJob({
      job: {
        name: "folder-sync",
        localPath: "D:\\Work",
        remotePath: "device/work",
        direction: "upload",
        mode: "copy",
        schedule: { mode: "manual" }
      }
    }),
    (error) => {
      assert.equal(error.code, "server_state_write_failed");
      assert.equal(error.status, 200);
      assert.match(error.message, /state write failed/);
      return true;
    }
  );

  const binaryStatus = await context.clientApi.checkBinaries();
  assert.equal(binaryStatus.ok, false);
  assert.equal(binaryStatus.errorCode, "binary_missing");
});

test("client UI API maps fetch failures to stable transport codes", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildBrowserApiContext(app);

  context.fetch = async () => {
    throw new Error("socket closed");
  };
  await assert.rejects(
    () => context.clientApi.getStatus(),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.match(error.message, /socket closed/);
      return true;
    }
  );

  context.fetch = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  await assert.rejects(
    () => context.clientApi.getStatus(),
    (error) => {
      assert.equal(error.code, "request_timeout");
      assert.match(error.message, /Request timed out/);
      return true;
    }
  );
});

test("client UI gives sync startup a longer timeout than ordinary local API calls", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const context = buildBrowserApiContext(app);
  const delays = [];
  context.AbortController = class {
    signal = {};
    abort() {}
  };
  context.setTimeout = (_callback, delay) => {
    delays.push(delay);
    return delays.length;
  };
  context.clearTimeout = () => {};
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({ ok: true, sync: { running: true } })
  });

  await context.clientApi.getStatus();
  await context.clientApi.runSync({ job: {} });

  assert.deepEqual(delays, [15000, 120000]);
});

test("client local status exposes runtime app version", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(server, /const clientVersion = process\.env\.SFSC_CLIENT_VERSION \|\| await readClientVersion\(paths\)/);
  assert.match(server, /async function readClientVersion\(paths\)/);
  assert.match(server, /join\(paths\.root, "resources", "app", "package\.json"\)/);
  assert.match(server, /return "0\.0\.0"/);
  assert.match(server, /appVersion: clientVersion/);
  assert.match(server, /clientVersion/);
  assert.match(server, /const diagnostics = buildRuntimeDiagnostics\(\{/);
  assert.match(server, /role: "client"/);
  assert.match(server, /diagnostics,/);
  assert.match(server, /const requiredSupportDocuments = \[/);
  assert.match(server, /const requiredManifestFilesByPackage = \{/);
  assert.match(server, /supportDocuments: summarizeManifestSupportDocuments/);
  assert.match(server, /requiredFiles: summarizeManifestRequiredFiles/);
  assert.match(server, /function summarizeManifestSupportDocuments\(files = \[\]\)/);
  assert.match(server, /function summarizeManifestRequiredFiles\(packageName, files = \[\]\)/);
  assert.match(server, /new Set\(\["SyncraftDesktop", "SyncraftClient"\]\)/);
});

test("client package scripts inject the root package version", async () => {
  const portable = await readFile(join(projectRoot, "client", "scripts", "build-client.ps1"), "utf8");
  const desktop = await readFile(join(projectRoot, "client", "scripts", "build-desktop.ps1"), "utf8");

  for (const script of [portable, desktop]) {
    assert.match(script, /Get-Content -LiteralPath \(Join-Path \$projectRoot "package\.json"\) -Raw \| ConvertFrom-Json/);
    assert.match(script, /\$appVersion = \$rootPackage\.version/);
    assert.match(script, /\$appPackageJson\.Replace\("__APP_VERSION__", \$appVersion\)/);
    assert.match(script, /docs\\INTERFACE_CONTRACT\.md/);
    assert.match(script, /docs\\API_MATRIX\.md/);
    assert.match(script, /resources\/app\/docs\/INTERFACE_CONTRACT\.md/);
    assert.match(script, /\$releaseManifest/);
    assert.match(script, /release-manifest\.json/);
    assert.match(script, /Get-Sha256HexFromFile \$_.path/);
    assert.match(script, /Compress-Archive/);
    assert.match(script, /Get-Sha256HexFromFile \$zipPathFull/);
    assert.match(script, /Set-Content -LiteralPath \$checksumPathFull -Encoding ASCII/);
    assert.match(script, /Remove-Item -LiteralPath \$zipPathFull -Force/);
    assert.match(script, /Remove-Item -LiteralPath \$checksumPathFull -Force/);
    assert.doesNotMatch(script, /"version": "0\.1\.0"/);
  }

  assert.match(portable, /resources\\app\\docs\\INTERFACE_CONTRACT\.md/);
  assert.match(portable, /SyncraftClient\.zip/);
  assert.match(portable, /SyncraftClient\.zip\.sha256/);
  assert.match(desktop, /Join-Path \$appRoot "docs\\INTERFACE_CONTRACT\.md"/);
  assert.match(desktop, /SyncraftDesktop\.zip/);
  assert.match(desktop, /SyncraftDesktop\.zip\.sha256/);
});

test("client local API uses explicit startup-stage error codes", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const runner = await readFile(join(projectRoot, "client", "src", "processRunner.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");

  assert.match(server, /createHttpError\("singbox_start_failed"/);
  assert.match(server, /errorCode: "singbox_start_failed"/);
  assert.match(server, /createHttpError\("rclone_config_failed"/);
  assert.match(server, /redactLogText/);
  assert.match(server, /const runPlan = await buildSyncRunPlan\(job\)/);
  assert.match(server, /const \{ normalizedJob, tunnelUri \} = runPlan/);
  assert.match(server, /const detail = redactRcloneConfigFailureDetail\(remoteConfig, normalizedJob, preview\)/);
  assert.match(server, /parseProtocolRequest\(PROTOCOL_REQUESTS\.CLIENT_SINGBOX_START, await readJson\(req\)\);\s+return json\(res, \{ singbox: await startSingboxFromImportedProfile\(\) \}\)/);
  assert.match(server, /async function startSingboxFromImportedProfile\(\)\s+\{\s+return startSingbox\(\{ useStoredProfile: true \}\);/);
  assert.match(server, /if \(options\.useStoredProfile\) \{\s+await ensureSecretVaultReady\(\);\s+\}/);
  assert.match(server, /const profile = options\.useStoredProfile \? await readProfile\(paths\) : null/);
  assert.doesNotMatch(server, /const profile = options\.useStoredProfile \? await readStoredProfile\(paths\) : null/);
  assert.doesNotMatch(server, /startSingbox\(await readJson\(req\)\)/);
  assert.match(server, /await startSingbox\(\{\s+uri: tunnelUri,\s+localProxyPort: normalizedJob\.localProxyPort \|\| 18081\s+\}\)/);
  assert.match(server, /runBuffered\(paths\.singboxExe, \["check", "-c", paths\.singboxConfigFile\]/);
  assert.match(server, /readyProbe: \(\) => isTcpPortOpen\("127\.0\.0\.1", config\.inbounds\[0\]\.listen_port\)/);
  assert.match(server, /function isTcpPortOpen/);
  assert.match(server, /singboxProcess\.stopAndWait/);
  assert.match(server, /syncProcess\.stopAndWait/);
  assert.match(server, /function redactRcloneConfigFailureDetail/);
  assert.match(server, /function collectRcloneConfigSecrets/);
  assert.match(server, /function redactKnownSecretValues/);
  assert.match(server, /createHttpError\("profile_not_imported", 409, "Import a server SyncKey before starting sing-box"\)/);
  assert.match(server, /parseProtocolRequest\(PROTOCOL_REQUESTS\.CLIENT_PROFILE_IMPORT, await readJson\(req\)\)/);
  assert.match(httpContract, /errorCode: "request_body_too_large"/);
  assert.match(httpContract, /message: "Request body too large"/);
  assert.match(server, /missingBinaryError\("sing-box", paths\.singboxExe, "missing_singbox_binary"\)/);
  assert.match(server, /missingBinaryError\("rclone", paths\.rcloneExe, "missing_rclone_binary"\)/);
  assert.match(server, /function binaryPresence/);
  assert.match(server, /function binaryCheckResult/);
  assert.match(server, /binary\.errorCode \|\| "binary_version_check_failed"/);
  assert.match(server, /function missingBinaryError/);
  assert.match(server, /missing_singbox_binary/);
  assert.match(server, /missing_rclone_binary/);
  assert.match(app, /binary_version_check_failed: "组件存在但无法运行版本检测/);
  assert.match(app, /setPill\("binStatus", result\.ok \? "组件检测通过" : "组件检测失败"/);
  assert.match(app, /function formatBinaryCheckSummary\(result = \{\}\)/);
  assert.match(app, /return result\.ok \? "组件检测通过" : "组件检测失败"/);
  assert.match(app, /Boolean\(result\.singbox\.ok\)/);
  assert.match(app, /Boolean\(result\.rclone\.ok\)/);
  assert.match(runner, /errorCode: exitCode === 0 \? "" : errorCode/);
  assert.match(runner, /readyProbe/);
  assert.match(runner, /stopAndWait/);
  assert.match(runner, /waitForExit/);
  assert.match(httpContract, /\/api\/binaries\/check/);
  assert.match(httpContract, /assertBinaryCheckContract/);
  assert.match(httpContract, /binary_version_check_failed/);
});

test("client history renders stable sync failure error codes", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");

  assert.match(app, /run\.errorCode/);
  assert.match(app, /singbox_start_failed: "隧道启动失败，请查看诊断日志。"/);
  assert.match(app, /unsupported_profile_version: "当前客户端不支持这个配置版本，请升级客户端。"/);
  assert.match(app, /profile_heartbeat_required: "服务端下发配置缺少心跳密钥，请重新生成 SyncKey。"/);
  assert.match(app, /profile_storage_required: "服务端下发配置缺少存储凭据，请重新生成 SyncKey。"/);
  assert.match(app, /profile_tunnel_required: "服务端下发配置不完整，请重新生成 SyncKey。"/);
  assert.match(app, /invalid_vless_uri: "隧道配置格式不正确，请检查服务端 VLESS 参数。"/);
  assert.match(app, /device_disabled: "当前客户端已在服务端停用，请联系管理员重新启用。"/);
  assert.match(app, /rclone_sync_failed: "同步失败，请查看日志中的 rclone 错误。"/);
  assert.match(app, /function formatConflictSummary/);
  assert.match(app, /function conflictResolutionHint/);
  assert.match(app, /检测到 \$\{Number\(conflicts\.count \|\| files\.length\)\} 项同步冲突/);
  assert.match(app, /请暂停继续双向同步，先手动比对示例文件/);
});

test("client sync history records started and finished runs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-sync-history-"));
  const paths = {
    syncHistoryFile: join(tempRoot, "sync-history.json")
  };

  try {
    const started = await recordSyncRunStarted({
      id: "sync-test",
      trigger: "scheduler",
      job: { name: "folder-sync", direction: "upload" },
      localPath: "D:\\Work"
    }, paths);
    assert.equal(started.status, "running");
    assert.equal(started.trigger, "scheduler");

    const finished = await recordSyncRunFinished("sync-test", {
      status: "error",
      exitCode: 1,
      errorCode: "rclone_sync_failed",
      progressPercent: 100,
      conflicts: {
        count: 1,
        files: ["projects/conflict.txt"]
      }
    }, paths);
    assert.equal(finished.status, "error");
    assert.equal(finished.exitCode, 1);
    assert.equal(finished.errorCode, "rclone_sync_failed");

    const history = await readSyncHistory(paths);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, "sync-test");
    assert.equal(history[0].trigger, "scheduler");
    assert.equal(history[0].progressPercent, 100);
    assert.equal(history[0].errorCode, "rclone_sync_failed");
    assert.equal(history[0].conflicts.count, 0);
    assert.deepEqual(history[0].conflicts.files, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client sync history normalizes stored records without exposing extensions", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-sync-history-normalize-"));
  const paths = {
    syncHistoryFile: join(tempRoot, "sync-history.json")
  };

  try {
    await writeFile(paths.syncHistoryFile, JSON.stringify([
      {
        id: "sync-dirty",
        status: "weird",
        startedAt: "2026-07-03T10:00:00.000Z",
        finishedAt: "not-a-date",
        job: {
          name: "folder-sync",
          direction: "upload",
          remotePrefix: "../bad"
        },
        trigger: "daemon",
        errorCode: "Bad Code",
        progressPercent: 150,
        conflicts: {
          count: 3,
          files: ["bad\\name.txt"]
        },
        bandwidthLimit: "20M",
        secretAccessKey: "raw-secret",
        debug: {
          tKey: "SFSC1-secret"
        }
      },
      null
    ]), "utf8");

    const history = await readSyncHistory(paths);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, "sync-dirty");
    assert.equal(history[0].status, "unknown");
    assert.equal(history[0].trigger, "manual");
    assert.equal(history[0].finishedAt, null);
    assert.equal(history[0].errorCode, "");
    assert.equal(history[0].progressPercent, 100);
    assert.equal(history[0].job.remotePrefix, "");
    assert.equal(history[0].conflicts.count, 0);
    assert.deepEqual(history[0].conflicts.files, []);
    assert.equal(history[0].bandwidthLimit, undefined);
    assert.equal(history[0].secretAccessKey, undefined);
    assert.equal(history[0].debug, undefined);
    assert.equal(JSON.stringify(history).includes("raw-secret"), false);
    assert.equal(JSON.stringify(history).includes("SFSC1-"), false);

    const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
    assert.match(httpContract, /history-dirty-paths/);
    assert.match(httpContract, /statusAfterNormalizedHistory\.syncHistory/);
    assert.match(httpContract, /statusAfterNormalizedHistory\.lastSync\.id/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client sync history keeps the most recent 20 runs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-sync-history-cap-"));
  const paths = {
    syncHistoryFile: join(tempRoot, "sync-history.json")
  };

  try {
    for (let index = 0; index < 25; index += 1) {
      await recordSyncRunStarted({
        id: `sync-${index}`,
        job: { name: "folder-sync", direction: "upload" },
        localPath: `D:\\Work\\${index}`
      }, paths);
    }

    const history = await readSyncHistory(paths);
    assert.equal(history.length, 20);
    assert.equal(history[0].id, "sync-24");
    assert.equal(history.at(-1).id, "sync-5");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rclone preview uses app-scoped config path", async () => {
  const preview = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    remoteFolder: "projects",
    streams: 8,
    transfers: 4
  }, {
    rcloneBin: "C:\\App\\resources\\bin\\win32\\rclone.exe",
    rcloneConfigPath: "C:\\App\\data\\runtime\\rclone.conf"
  });

  assert.ok(preview.args.includes("--config"));
  assert.ok(preview.args.includes("C:\\App\\data\\runtime\\rclone.conf"));
  assert.ok(preview.args.includes("--stats=1s"));
  assert.equal(preview.args.includes("--stats-one-line"), false);
  assert.ok(preview.remoteConfig.args.includes("--config"));
  assert.ok(preview.displayCommand.includes("C:\\App\\resources\\bin\\win32\\rclone.exe"));

  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
  assert.match(httpContract, /pathExists\(join\(tempRoot, "data", "runtime", "rclone\.conf"\)\)/);
  assert.match(httpContract, /historyAfterPreview/);
  assert.match(httpContract, /processes\.singbox\.running, false/);
});

test("runBuffered captures stdout from a child process", async () => {
  const result = await runBuffered(process.execPath, ["-e", "console.log('runner-ok')"]);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /runner-ok/);
});

test("managed processes preserve startup error codes on non-zero exits", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-"));
  const managed = new ManagedProcess("failing-process", join(tempRoot, "process.log"));

  try {
    const exit = new Promise((resolve) => {
      managed.start(globalThis.process.execPath, ["-e", "process.exit(7)"], {
        errorCode: "singbox_start_failed",
        onExit: resolve
      });
    });
    const result = await exit;
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.errorCode, "singbox_start_failed");
    assert.equal(managed.status().lastExit.errorCode, "singbox_start_failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed processes reject explicit test spawn failure before starting a child", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-test-spawn-fail-"));
  const managed = new ManagedProcess("test-spawn-fail-process", join(tempRoot, "process.log"));

  try {
    await assert.rejects(
      () => managed.start(globalThis.process.execPath, ["-e", "process.exit(0)"], {
        errorCode: "rclone_sync_failed",
        testSpawnFailure: true
      }),
      /test-spawn-fail-process test spawn failure/
    );
    assert.equal(managed.status().running, false);
    assert.equal(managed.status().lastExit.errorCode, "rclone_sync_failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed processes buffer output until asynchronous startup bookkeeping finishes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-buffered-output-"));
  const managed = new ManagedProcess("buffered-output-process", join(tempRoot, "process.log"));

  try {
    const output = [];
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const started = managed.start(globalThis.process.execPath, ["-e", "process.stdout.write('early-output\\n'); setTimeout(() => process.exit(0), 25)"], {
      onStarted: async () => new Promise((resolve) => setTimeout(resolve, 100)),
      onOutput: (item) => output.push(item.text),
      onExit: resolveExit
    });

    await started;
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("buffered output exit timed out")), 1000))
    ]);
    assert.deepEqual(output, ["early-output\n"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed processes report a fast exit after asynchronous startup bookkeeping", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-fast-exit-"));
  const managed = new ManagedProcess("fast-exit-process", join(tempRoot, "process.log"));

  try {
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const started = managed.start(globalThis.process.execPath, ["-e", "process.exit(7)"], {
      errorCode: "rclone_sync_failed",
      onStarted: async () => new Promise((resolve) => setTimeout(resolve, 100)),
      onExit: resolveExit
    });

    await started;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("fast exit callback timed out")), 1000))
    ]);
    assert.equal(result.exitCode, 7);
    assert.equal(result.errorCode, "rclone_sync_failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed processes stop reporting signal-closed children as running", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-stop-"));
  const managed = new ManagedProcess("stoppable-process", join(tempRoot, "process.log"));

  try {
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const started = await managed.start(globalThis.process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      errorCode: "rclone_sync_failed",
      onExit: resolveExit
    });

    assert.equal(started.running, true);
    const stopping = managed.stop();
    assert.equal(stopping.running, true);

    const result = await Promise.race([
      exit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("process stop timed out")), 3000))
    ]);
    assert.equal(result.ok, false);
    assert.equal(managed.status().running, false);
    assert.equal(managed.status().pid, null);
    assert.equal(managed.status().lastExit.errorCode, "rclone_sync_failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed processes can stop and wait for child exit", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-managed-process-stop-wait-"));
  const managed = new ManagedProcess("waitable-process", join(tempRoot, "process.log"));

  try {
    await managed.start(globalThis.process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      errorCode: "rclone_sync_failed"
    });
    assert.equal(managed.status().running, true);

    const stopped = await managed.stopAndWait({ timeoutMs: 3000 });
    assert.equal(stopped.running, false);
    assert.equal(stopped.pid, null);
    assert.equal(stopped.lastExit.errorCode, "rclone_sync_failed");
    assert.equal(stopped.stopSignal, "SIGTERM");
    assert.equal(stopped.stopTimedOut, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client diagnostic logs redact storage secrets", () => {
  const redacted = redactLogText([
    "rclone config create remote s3 secret_access_key top-secret-value endpoint http://minio:9000",
    "S3_SECRET_ACCESS_KEY=another-secret",
    "SFSC1-eyJjb2RlIjoiQUJDIn0",
    "sfsc://import/v1#eyJjb2RlIjoiQUJDIn0",
    tunnelUri,
    "{\"secretAccessKey\":\"json-secret\"}",
    "AWS_SECRET_ACCESS_KEY = spaced-secret",
    "Transferred: C:\\Users\\Tong_hp\\Documents\\private.txt",
    "Unix path: /home/tong/private/file.txt"
  ].join("\n"));

  assert.equal(redacted.includes("top-secret-value"), false);
  assert.equal(redacted.includes("another-secret"), false);
  assert.equal(redacted.includes("json-secret"), false);
  assert.equal(redacted.includes("spaced-secret"), false);
  assert.equal(redacted.includes(tunnelUri), false);
  assert.equal(redacted.includes("C:\\Users"), false);
  assert.equal(redacted.includes("/home/tong"), false);
  assert.match(redacted, /secret_access_key \*\*\*\*/);
  assert.match(redacted, /S3_SECRET_ACCESS_KEY=\*\*\*\*/);
  assert.match(redacted, /SFSC1-\*\*\*\*/);
  assert.match(redacted, /sfsc:\/\/import\/v1#\*\*\*\*/);
  assert.match(redacted, /vless:\/\/\*\*\*\*/);
  assert.match(redacted, /"secretAccessKey":"\*\*\*\*"/);
  assert.match(redacted, /<local-path>/);
});

test("client store writes local JSON state atomically", async () => {
  const store = await readFile(join(projectRoot, "client", "src", "store.js"), "utf8");
  assert.match(store, /const fileWriteQueues = new Map\(\)/);
  assert.match(store, /function withFileWriteLock/);
  assert.match(store, /async function writeJsonFileUnlocked/);
  assert.match(store, /await writeFile\(tempFile, JSON\.stringify\(value, null, 2\), "utf8"\)/);
  assert.match(store, /await rename\(tempFile, file\)/);
  assert.match(store, /return withFileWriteLock\(file, async \(\) =>/);
  // Secret vault writes go through the ACL-first protected path, not the generic
  // JSON writer: the temp file must be locked down while still empty so the
  // rename never publishes cleartext secrets under default permissions.
  assert.match(store, /await writeProtectedTextFileUnlocked\(file, JSON\.stringify\(secrets, null, 2\), \{ failClosed: true \}\)/);
  assert.match(store, /await writeFile\(tempFile, "", \{ mode: 0o600 \}\)/);
  assert.match(store, /"secret_vault_unprotected",\s*\n\s*503/);
});

test("client store write queues continue after a failed JSON write", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-write-queue-failure-"));
  const stateFile = join(tempRoot, "state.json");
  try {
    await mkdir(stateFile, { recursive: true });
    await assert.rejects(() => writeJsonFile(stateFile, { failed: true }));

    await rm(stateFile, { recursive: true, force: true });
    await writeJsonFile(stateFile, { ok: true });

    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { ok: true });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client store serializes concurrent job saves without dropping writes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-concurrent-job-save-"));
  const paths = {
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json")
  };
  try {
    const names = Array.from({ length: 12 }, (_value, index) => `job-${index}`);
    const saved = await Promise.all(names.map((name, index) => saveJob({
      name,
      localPath: `D:\\Work${index}`,
      secretAccessKey: `job-secret-${index}`
    }, paths)));

    assert.equal(new Set(saved.map((job) => job.id)).size, names.length);
    const jobs = await readJobs(paths);
    assert.equal(jobs.length, names.length);
    assert.deepEqual(jobs.map((job) => job.name).sort(), [...names].sort());
    assert.deepEqual(jobs.map((job) => job.secretAccessKey).sort(), names.map((_name, index) => `job-secret-${index}`).sort());
    assert.equal((await readFile(paths.jobsFile, "utf8")).includes("job-secret-"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client job secret updates use immutable vault references", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-immutable-job-secret-"));
  const paths = {
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json")
  };
  try {
    await saveJob({
      id: "job-immutable",
      name: "immutable",
      secretAccessKey: "old-job-secret"
    }, paths);
    const oldJobsRaw = await readFile(paths.jobsFile, "utf8");
    const oldSecretRef = JSON.parse(oldJobsRaw)[0].secretAccessKey.secretRef;

    await saveJob({
      id: "job-immutable",
      name: "immutable",
      secretAccessKey: "new-job-secret"
    }, paths);
    const updatedJob = JSON.parse(await readFile(paths.jobsFile, "utf8"))[0];
    const newSecretRef = updatedJob.secretAccessKey.secretRef;
    const secrets = JSON.parse(await readFile(paths.secretsFile, "utf8"));

    assert.match(oldSecretRef, /^job:job-immutable:secretAccessKey:/);
    assert.match(newSecretRef, /^job:job-immutable:secretAccessKey:/);
    assert.notEqual(newSecretRef, oldSecretRef);
    assert.equal(secrets[oldSecretRef], "old-job-secret");
    assert.equal(secrets[newSecretRef], "new-job-secret");

    await writeFile(paths.jobsFile, oldJobsRaw, "utf8");
    assert.equal((await readJobs(paths))[0].secretAccessKey, "old-job-secret");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client store snapshots and restores profile import state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-profile-import-snapshot-"));
  const paths = {
    profileFile: join(tempRoot, "profile.json"),
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json")
  };
  try {
    const oldProfile = "{ \"clientName\": \"old-pc\" }\n";
    const oldJobs = "[{ \"id\": \"job-old\" }]\n";
    await writeFile(paths.profileFile, oldProfile, "utf8");
    await writeFile(paths.jobsFile, oldJobs, "utf8");

    const snapshot = await snapshotProfileImportState(paths);
    await writeFile(paths.profileFile, "{ \"clientName\": \"new-pc\" }\n", "utf8");
    await writeFile(paths.jobsFile, "[{ \"id\": \"job-new\" }]\n", "utf8");
    await writeFile(paths.secretsFile, "{ \"new\": \"secret\" }\n", "utf8");

    await restoreProfileImportState(snapshot);

    assert.equal(await readFile(paths.profileFile, "utf8"), oldProfile);
    assert.equal(await readFile(paths.jobsFile, "utf8"), oldJobs);
    await assert.rejects(() => readFile(paths.secretsFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client secret vault writes are owner-only before any secret content lands on disk", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-secret-vault-acl-"));
  const paths = {
    profileFile: join(tempRoot, "profile.json"),
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json")
  };
  try {
    await saveJob({ id: "job-acl", secretAccessKey: "acl-secret" }, paths);
    if (process.platform !== "win32") {
      // The temp file is created empty with mode 0600 and the rename carries it
      // over; the old path created the temp with default permissions and only
      // protected the vault after the rename.
      assert.equal((await stat(paths.secretsFile)).mode & 0o777, 0o600);
    }

    // The import snapshot must mark the vault file — and only the vault file —
    // so a rollback also goes through the ACL-first write path.
    const snapshot = await snapshotProfileImportState(paths);
    assert.deepEqual(
      snapshot.files.filter((entry) => entry.protect).map((entry) => entry.file),
      [paths.secretsFile]
    );

    await writeFile(paths.secretsFile, "{}", "utf8");
    await restoreProfileImportState(snapshot);
    assert.equal((await readJobs(paths))[0].secretAccessKey, "acl-secret");
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.secretsFile)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client claim recovery stores only a one-time code hash", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-recovery-store-"));
  const paths = {
    claimRecoveryFile: join(tempRoot, "claim-recovery.json")
  };
  const claim = {
    server: "https://resolver.example.com",
    code: "RCVY-0001"
  };
  try {
    const [first, concurrent] = await Promise.all([
      prepareClaimRecovery(claim, paths),
      prepareClaimRecovery(claim, paths)
    ]);
    assert.equal(concurrent.clientRedeemId, first.clientRedeemId);
    assert.equal(concurrent.clientInstallId, first.clientInstallId);
    const stored = JSON.parse(await readFile(paths.claimRecoveryFile, "utf8"));

    assert.equal(stored.claim.server, claim.server);
    assert.equal(stored.claim.code, undefined);
    assert.match(stored.claim.codeHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes(claim.code), false);

    const second = await prepareClaimRecovery(claim, paths);
    assert.equal(second.clientRedeemId, first.clientRedeemId);
    assert.equal(second.clientInstallId, first.clientInstallId);

    await writeFile(paths.claimRecoveryFile, JSON.stringify({
      schemaVersion: 1,
      type: "claim-import-recovery",
      claim: { server: claim.server, code: claim.code },
      clientRedeemId: "legacy-redeem",
      clientInstallId: "legacy-install",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    }), "utf8");

    const migrated = await prepareClaimRecovery(claim, paths);
    const migratedStored = JSON.parse(await readFile(paths.claimRecoveryFile, "utf8"));
    assert.equal(migrated.clientRedeemId, "legacy-redeem");
    assert.equal(migrated.clientInstallId, "legacy-install");
    assert.equal(migratedStored.claim.code, undefined);
    assert.match(migratedStored.claim.codeHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(migratedStored).includes(claim.code), false);

    await writeFile(paths.claimRecoveryFile, JSON.stringify({
      ...migratedStored,
      clientRedeemId: migrated.clientRedeemId,
      clientInstallId: "different-install"
    }), "utf8");
    await clearClaimRecovery(migrated, paths);
    assert.equal(JSON.parse(await readFile(paths.claimRecoveryFile, "utf8")).clientInstallId, "different-install");

    await writeFile(paths.claimRecoveryFile, JSON.stringify(migratedStored), "utf8");
    await clearClaimRecovery(migrated, paths);
    await assert.rejects(() => readFile(paths.claimRecoveryFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client store reports corrupt local JSON state without breaking history reads", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-corrupt-state-"));
  const paths = {
    profileFile: join(tempRoot, "profile.json"),
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json"),
    syncHistoryFile: join(tempRoot, "sync-history.json"),
    claimRecoveryFile: join(tempRoot, "claim-recovery.json"),
    heartbeatSnapshotFile: join(tempRoot, "last-successful-heartbeat.json")
  };
  try {
    await writeFile(paths.profileFile, "{ bad json", "utf8");
    await writeFile(paths.jobsFile, "[]", "utf8");
    await writeFile(paths.secretsFile, "{}", "utf8");
    await writeFile(paths.syncHistoryFile, "{ bad history", "utf8");
    await writeFile(paths.claimRecoveryFile, "{ bad claim recovery", "utf8");
    await writeFile(paths.heartbeatSnapshotFile, "{ bad heartbeat", "utf8");

    await assert.rejects(() => readProfile(paths), { code: "local_state_corrupt" });
    assert.deepEqual(await readSyncHistory(paths), []);

    const localState = await inspectLocalState(paths);
    assert.equal(localState.ok, false);
    assert.deepEqual(
      localState.files.filter((file) => file.ok === false).map((file) => file.name),
      ["profile", "syncHistory", "claimRecovery", "lastSuccessfulHeartbeat"]
    );
    assert.equal(localState.files.find((file) => file.name === "profile").errorCode, "local_state_corrupt");
    assert.equal(localState.files.find((file) => file.name === "claimRecovery").errorCode, "local_state_corrupt");
    assert.equal(localState.files.find((file) => file.name === "lastSuccessfulHeartbeat").errorCode, "local_state_corrupt");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client store does not overwrite corrupt sync history when recording runs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-corrupt-history-"));
  const paths = {
    syncHistoryFile: join(tempRoot, "sync-history.json")
  };
  try {
    await writeFile(paths.syncHistoryFile, "{ bad history", "utf8");

    assert.deepEqual(await readSyncHistory(paths), []);
    await assert.rejects(
      () => recordSyncRunStarted({ id: "sync-1", job: { name: "demo" } }, paths),
      { code: "local_state_corrupt" }
    );
    assert.equal(await readFile(paths.syncHistoryFile, "utf8"), "{ bad history");

    await assert.rejects(
      () => recordSyncRunFinished("sync-1", { status: "success" }, paths),
      { code: "local_state_corrupt" }
    );
    assert.equal(await readFile(paths.syncHistoryFile, "utf8"), "{ bad history");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client profile and jobs store secrets through a local vault reference", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-secret-vault-"));
  const paths = {
    profileFile: join(tempRoot, "profile.json"),
    jobsFile: join(tempRoot, "jobs.json"),
    secretsFile: join(tempRoot, "secrets.json")
  };
  try {
    await saveProfile({
      profileId: "profile-company-pc1",
      clientName: "company-pc1",
      tunnel: { uri: tunnelUri },
      heartbeat: {
        scheme: "sfsc-hmac-sha256-v1",
        secret: "heartbeat-secret"
      },
      storage: {
        endpoint: "http://minio:9000",
        bucket: "home-sync",
        accessKeyId: "company-pc1",
        secretAccessKey: "profile-secret",
        prefix: "devices/company-pc1"
      },
      defaults: {}
    }, paths);

    const storedProfile = await readFile(paths.profileFile, "utf8");
    const storedSecrets = await readFile(paths.secretsFile, "utf8");
    assert.equal(storedProfile.includes("profile-secret"), false);
    assert.equal(storedProfile.includes("heartbeat-secret"), false);
    assert.match(storedProfile, /"secretRef"/);
    assert.equal(storedSecrets.includes("profile-secret"), true);
    assert.equal(storedSecrets.includes("heartbeat-secret"), true);
    assert.equal((await readProfile(paths)).storage.secretAccessKey, "profile-secret");
    assert.equal((await readProfile(paths)).heartbeat.secret, "heartbeat-secret");

    const savedJob = await saveJob({
      id: "job-1",
      name: "folder-sync",
      secretAccessKey: "job-secret",
      s3SecretAccessKey: "job-secret-2"
    }, paths);
    assert.equal(savedJob.secretAccessKey, "job-secret");
    assert.equal(savedJob.s3SecretAccessKey, "job-secret-2");
    const storedJobs = await readFile(paths.jobsFile, "utf8");
    assert.equal(storedJobs.includes("job-secret"), false);
    assert.match(storedJobs, /"secretRef"/);
    assert.equal((await readJobs(paths))[0].secretAccessKey, "job-secret");

    const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
    assert.match(httpContract, /fetch\(`\$\{baseUrl\}\/api\/profile`\)/);
    assert.match(httpContract, /Object\.hasOwn\(profileReadPayload\.profile\.storage, "secretAccessKey"\), false/);
    assert.match(httpContract, /JSON\.stringify\(profileReadPayload\.profile\)\.includes\("top-secret-value"\), false/);
    assert.match(httpContract, /JSON\.stringify\(profileReadPayload\.profile\)\.includes\(tunnelUri\), false/);
    assert.match(httpContract, /fetch\(`\$\{baseUrl\}\/api\/jobs`\)/);
    assert.match(httpContract, /Object\.hasOwn\(listedSavedJob, "secretAccessKey"\), false/);
    assert.match(httpContract, /storedProfile\.storage\.secretAccessKey\.secretRef/);

    const savedJobs = await saveJobs([{ id: "job-2", secretAccessKey: "bulk-secret" }], paths);
    assert.equal(savedJobs[0].secretAccessKey, "bulk-secret");
    assert.equal((await readJobs(paths))[0].secretAccessKey, "bulk-secret");
    assert.equal((await readFile(paths.jobsFile, "utf8")).includes("bulk-secret"), false);

    const vault = await inspectSecretVault(paths);
    assert.equal(vault.ok, true);
    assert.equal(vault.refs, 3);
    assert.equal(vault.protected, true);
    assert.equal(vault.protection.exists, true);
    assert.equal(typeof vault.protection.mode, "string");
    await rm(paths.secretsFile, { force: true });
    const missingVault = await inspectSecretVault(paths);
    assert.equal(missingVault.ok, false);
    assert.equal(missingVault.protected, false);
    assert.equal(missingVault.protection.exists, false);
    assert.equal(missingVault.missingRefs.length, 3);
    await assert.rejects(() => readProfile(paths), { code: "secret_vault_missing" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rclone stats parser extracts the latest transfer speed", () => {
  const stats = parseRcloneStats([
    "Transferred:    50 MiB / 100 MiB, 50%, 2.5 MiB/s, ETA 20s",
    "\rTransferred:    70 MiB / 100 MiB, 70%, 3 MiB/s, ETA 10s"
  ].join(""));

  assert.equal(stats.rawSpeed, "3 MiB/s");
  assert.equal(stats.speedMbps, 25.17);
  assert.equal(stats.progressPercent, 70);
});

test("client job from imported profile hides storage details from the UI job", () => {
  const job = buildJobFromProfile({
    clientName: "company-pc1",
    tunnel: {
      uri: tunnelUri
    },
    storage: {
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: "company-pc1",
      secretAccessKey: "secret",
      prefix: "devices/company-pc1"
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      chunkSize: "16M"
    }
  }, {
    localPath: "D:\\Work",
    direction: "download",
    schedule: { mode: "daily", time: "02:00" }
  });

  assert.equal(job.localPath, "D:\\Work");
  assert.equal(job.direction, "download");
  assert.equal(job.remotePrefix, "devices/company-pc1");
  assert.equal(job.secretAccessKey, "secret");
});

test("client job preserves remote folder while deriving prefix from profile", () => {
  const profile = {
    clientName: "company-pc1",
    tunnel: {
      uri: tunnelUri
    },
    storage: {
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: "company-pc1",
      secretAccessKey: "secret",
      prefix: "devices/company-pc1"
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      chunkSize: "16M"
    }
  };

  const deviceJob = buildJobFromProfile(profile, {
    remoteFolder: "projects",
    serverSpace: "device"
  });
  assert.equal(deviceJob.remoteFolder, "projects");
  assert.equal(deviceJob.serverSpace, "device");
  assert.equal(deviceJob.remotePrefix, "devices/company-pc1/projects");

  const sharedJob = buildJobFromProfile(profile, {
    remoteFolder: "team/reports",
    serverSpace: "shared"
  });
  assert.equal(sharedJob.remoteFolder, "team/reports");
  assert.equal(sharedJob.serverSpace, "shared");
  assert.equal(sharedJob.remotePrefix, "shared/team/reports");
});

test("client refreshes saved jobs when importing a new profile", async () => {
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const store = await readFile(join(projectRoot, "client", "src", "store.js"), "utf8");
  const httpContract = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");

  assert.match(server, /await refreshJobsForProfile\(profile\)/);
  assert.match(server, /function pickUserJobFields/);
  assert.match(server, /buildJobFromProfile\(profile, pickUserJobFields\(job\)\)/);
  assert.match(server, /saveJobs\(refreshed, paths\)/);
  assert.match(store, /export async function saveJobs/);
  assert.match(httpContract, /previewFromMinimalJob/);
  assert.match(httpContract, /--checkers/);
  assert.match(httpContract, /--s3-chunk-size/);
  assert.match(httpContract, /socks5:\/\/127\.0\.0\.1:18082/);
});

test("client redeems a claim token into a complete profile", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025/",
    code: "C7KD-92PQ"
  });
  const calls = [];

  const profile = await resolveProfileImport({ code: token }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        profile: makeServerProfile({
          profileId: "profile-company-pc1-001",
          clientName: "company-pc1"
        })
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pass.971223.xyz:2025/api/claims/redeem");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: "C7KD-92PQ" });
  assert.equal(profile.importMode, "claim-redeem");
  assert.deepEqual(profile.source, {
    type: "claim",
    server: "https://pass.971223.xyz:2025"
  });
  assert.equal(profile.profileId, "profile-company-pc1-001");
  assert.equal(profile.tunnel.uri, tunnelUri);
  assert.equal(profile.storage.prefix, "devices/company-pc1");
  assert.equal(profile.claim, undefined);
});

test("client sends claim recovery binding when redeeming a pending SyncKey", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025/",
    code: "C7KD-92PQ"
  });
  const calls = [];

  const profile = await resolveProfileImport({ code: token }, {
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        profile: makeServerProfile({
          profileId: "profile-company-pc1-replay",
          clientName: "company-pc1"
        })
      });
    }
  });

  assert.equal(profile.importMode, "claim-redeem");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    code: "C7KD-92PQ",
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-1"
  });
});

test("client surfaces claim redemption errors from the resolver server", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({ error: "claim_expired" }, { ok: false, status: 410 })
    }),
    (error) => {
      assert.equal(error.code, "claim_expired");
      assert.equal(error.status, 410);
      assert.equal(error.publicMessage, "claim_expired");
      return true;
    }
  );
});

test("client prefers structured claim redemption errorCode from the resolver server", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({
        ok: false,
        error: "legacy_message",
        errorCode: "claim_already_used",
        message: "This SyncKey has already been used"
      }, { ok: false, status: 409 })
    }),
    (error) => {
      assert.equal(error.code, "claim_already_used");
      assert.equal(error.status, 409);
      assert.equal(error.publicMessage, "This SyncKey has already been used");
      return true;
    }
  );
});

test("client preserves documented claim redemption write failures from the resolver server", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({
        ok: false,
        errorCode: "server_state_write_failed",
        message: "Failed to persist claim redemption"
      }, { ok: false, status: 500 })
    }),
    (error) => {
      assert.equal(error.code, "server_state_write_failed");
      assert.equal(error.status, 500);
      assert.equal(error.publicMessage, "Failed to persist claim redemption");
      return true;
    }
  );
});

test("client rejects claim redemption profiles without heartbeat credentials", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });
  const { heartbeat: _heartbeat, ...profileWithoutHeartbeat } = makeServerProfile({
    clientName: "company-pc1"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({
        profile: profileWithoutHeartbeat
      })
    }),
    (error) => {
      assert.equal(error.code, "profile_heartbeat_required");
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, /heartbeat credentials/);
      return true;
    }
  );
});

test("client rejects claim redemption profiles without storage credentials", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  const missingStorageCases = [
    {
      name: "missing storage",
      profile: (() => {
        const { storage: _storage, ...profileWithoutStorage } = makeServerProfile({
          clientName: "company-pc1"
        });
        return profileWithoutStorage;
      })()
    },
    {
      name: "missing storage.secretAccessKey",
      profile: (() => {
        const profile = makeServerProfile({
          clientName: "company-pc1"
        });
        delete profile.storage.secretAccessKey;
        return profile;
      })()
    }
  ];

  for (const { name, profile } of missingStorageCases) {
    await assert.rejects(
      () => resolveProfileImport({ code: token }, {
        fetchImpl: async () => jsonResponse({
          profile
        })
      }),
      (error) => {
        assert.equal(error.code, "profile_storage_required", name);
        assert.equal(error.status, 400, name);
        assert.match(error.publicMessage, /storage credentials/, name);
        return true;
      }
    );
  }
});

test("client uses a stable fallback code when claim redemption is unstructured", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({ message: "bad gateway" }, { ok: false, status: 502 })
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.equal(error.publicMessage, "bad gateway");
      return true;
    }
  );

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({ error: "bad_gateway", message: "bad gateway" }, { ok: false, status: 502 })
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.equal(error.publicMessage, "bad gateway");
      return true;
    }
  );

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        }
      })
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.match(error.publicMessage, /not valid JSON/);
      return true;
    }
  );

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => jsonResponse({
        ok: false,
        message: "resolver returned an error envelope with HTTP 2xx"
      }, { ok: true, status: 200 })
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.equal(error.publicMessage, "resolver returned an error envelope with HTTP 2xx");
      return true;
    }
  );

  for (const [name, payload] of [
    ["success envelope without profile", { ok: true }],
    ["message envelope without profile", { message: "ok" }],
    ["null profile wrapper", { profile: null }]
  ]) {
    await assert.rejects(
      () => resolveProfileImport({ code: token }, {
        fetchImpl: async () => jsonResponse(payload, { ok: true, status: 200 })
      }),
      (error) => {
        assert.equal(error.code, "claim_redeem_failed", name);
        assert.equal(error.status, 502, name);
        assert.notEqual(error.code, "profile_storage_required", name);
        assert.notEqual(error.code, "profile_heartbeat_required", name);
        assert.notEqual(error.code, "profile_tunnel_required", name);
        return true;
      }
    );
  }
});

test("client maps claim redemption network failures to a stable code", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      }
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.match(error.publicMessage, /SyncKey redemption request failed/);
      assert.match(error.publicMessage, /ECONNREFUSED/);
      return true;
    }
  );
});

test("client maps claim redemption timeouts to a stable code", async () => {
  const token = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });

  await assert.rejects(
    () => resolveProfileImport({ code: token }, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
    }),
    (error) => {
      assert.equal(error.code, "claim_redeem_failed");
      assert.equal(error.status, 502);
      assert.match(error.publicMessage, /timed out after 5ms/);
      return true;
    }
  );
});

test("client still imports an offline full profile code without network redemption", async () => {
  const offlineCode = encodeImportProfile(makeServerProfile(), { format: "code" });
  const profile = await resolveProfileImport({ code: offlineCode }, {
    fetchImpl: async () => {
      throw new Error("fetch should not be called for offline profiles");
    }
  });

  assert.equal(profile.importMode, "offline-profile");
  assert.equal(profile.clientName, "company-pc1");
  assert.equal(profile.source.server, "https://pass.971223.xyz:2025");
  assert.equal(profile.heartbeat.scheme, "sfsc-hmac-sha256-v1");
  assert.equal(profile.storage.bucket, "home-sync");
});

test("client rejects server-issued offline profiles without heartbeat or storage credentials", async () => {
  const serverIssuedProfile = makeServerProfile({ clientName: "offline-strict-pc" });

  const missingHeartbeat = {
    ...serverIssuedProfile,
    heartbeat: undefined
  };
  await assert.rejects(
    () => resolveProfileImport({ code: `SFSC1-${base64UrlJson(missingHeartbeat)}` }),
    (error) => {
      assert.equal(error.code, "profile_heartbeat_required");
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, /offline profile must include heartbeat credentials/);
      return true;
    }
  );

  for (const [name, mutate] of [
    ["missing storage", (profile) => {
      delete profile.storage;
    }],
    ["missing storage.secretAccessKey", (profile) => {
      delete profile.storage.secretAccessKey;
    }],
    ["empty storage.prefix", (profile) => {
      profile.storage.prefix = "";
    }]
  ]) {
    const profile = JSON.parse(JSON.stringify(serverIssuedProfile));
    mutate(profile);
    await assert.rejects(
      () => resolveProfileImport({ code: `SFSC1-${base64UrlJson(profile)}` }),
      (error) => {
        assert.equal(error.code, "profile_storage_required", name);
        assert.equal(error.status, 400, name);
        assert.match(error.publicMessage, /storage credentials/, name);
        return true;
      }
    );
  }
});

test("client keeps legacy offline profile compatibility when source server is absent", async () => {
  const legacyOfflineCode = `SFSC1-${base64UrlJson({
    version: 1,
    clientName: "legacy-offline-pc",
    tunnel: {
      type: "vless",
      uri: tunnelUri
    }
  })}`;

  const profile = await resolveProfileImport({ code: legacyOfflineCode });
  assert.equal(profile.importMode, "offline-profile");
  assert.equal(profile.clientName, "legacy-offline-pc");
  assert.equal(profile.source, undefined);
  assert.equal(profile.heartbeat, null);
  assert.equal(profile.storage.secretAccessKey, "CHANGE_ME_CLIENT_SECRET");
});

test("client parses rclone speed, transferred bytes, and current file progress", () => {
  const stats = parseRcloneStats([
    "Transferred:      512 MiB / 2 GiB, 25%, 8 MiB/s, ETA 3m0s",
    "Transferred:            3 / 12, 25%",
    "Transferring:",
    " * projects/video.iso: 42% /1.2 GiB, 8 MiB/s, 1m20s"
  ].join("\n"));

  assert.equal(stats.speedMbps, 67.11);
  assert.equal(stats.progressPercent, 25);
  assert.equal(stats.transferredSizeText, "512 MiB / 2 GiB");
  assert.equal(stats.transferredObjects, 3);
  assert.equal(stats.totalObjects, 12);
  assert.equal(stats.currentFile, "projects/video.iso");
  assert.equal(stats.currentFileProgressPercent, 42);
  assert.equal(stats.currentFileSizeText, "1.2 GiB");
});

test("client keeps scanning totals provisional and transfer progress monotonic", () => {
  let metrics = {
    phase: "scanning",
    progressPercent: null,
    transferredSizeText: "",
    transferredBytes: null,
    totalBytes: null
  };

  metrics = mergeRcloneProgress(metrics, parseRcloneStats([
    "Checks:              30 / 120, 25%",
    "Transferred:      128 MiB / 1 GiB, 12%, 0 B/s, ETA -"
  ].join("\n")));
  assert.equal(metrics.phase, "scanning");
  assert.equal(metrics.progressPercent, null);
  assert.equal(metrics.totalBytes, null);
  assert.equal(metrics.transferredSizeText, "");

  metrics = mergeRcloneProgress(metrics, parseRcloneStats([
    "Transferring:",
    "Transferred:      512 MiB / 2 GiB, 25%, 8 MiB/s, ETA 3m0s"
  ].join("\n")));
  assert.equal(metrics.phase, "transferring");
  assert.equal(metrics.progressPercent, 25);
  assert.equal(metrics.totalBytes, 2 * 1024 ** 3);
  assert.equal(metrics.transferredSizeText, "512 MiB / 2 GiB");

  metrics = mergeRcloneProgress(metrics, parseRcloneStats(
    "Transferred:      768 MiB / 3 GiB, 20%, 6 MiB/s, ETA 4m0s"
  ));
  assert.equal(metrics.phase, "transferring");
  assert.equal(metrics.progressPercent, 25);
  assert.equal(metrics.totalBytes, 2 * 1024 ** 3);
  assert.equal(metrics.transferredSizeText, "768 MiB / 2 GiB");
});

test("client exposes a distinct scanning phase before transfer progress", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const source = extractBrowserFunctionRange(
    app,
    "function renderSyncProgress",
    "function renderScheduler"
  );
  const elements = Object.fromEntries([
    "speedValue",
    "progressFill",
    "progressValue",
    "transferredValue",
    "lastSyncValue",
    "currentFileValue"
  ].map((id) => [id, makeFakeElement()]));
  elements.progressFill.style = {};
  const context = {
    document: { getElementById: (id) => elements[id] }
  };
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    "const clampPercent = (value) => value == null ? null : Math.max(0, Math.min(100, Number(value)));",
    "const formatPercent = (value) => `${Number(value).toFixed(0)}%`;",
    "const statusText = (state) => state === 'syncing' ? '同步中' : '等待开始';",
    "const formatLastSync = () => '-';",
    source,
    "this.renderSyncProgress = renderSyncProgress;"
  ].join("\n"), context);

  context.renderSyncProgress({
    syncState: "syncing",
    phase: "scanning",
    progressPercent: 30,
    transferredSizeText: "300 MiB / 1 GiB"
  });

  assert.equal(elements.progressValue.textContent, "正在扫描并计算总量");
  assert.equal(elements.progressFill.style.width, "0%");
  assert.equal(elements.transferredValue.textContent, "-");
  assert.match(server, /mergeRcloneProgress\(syncMetrics, parsed\)/);
  assert.match(server, /phase: "scanning"/);
});

test("client parses rclone conflict lines into a stable summary", () => {
  const stats = parseRcloneStats([
    "2026/07/04 10:00:00 ERROR : projects/a.txt: file changed on both sides - conflict",
    "ERROR : projects/b.txt: bisync conflict detected",
    "ERROR : projects/a.txt: file changed on both sides - conflict"
  ].join("\n"), { direction: "bidirectional" });

  assert.equal(stats.conflicts.count, 2);
  assert.deepEqual(stats.conflicts.files, ["projects/a.txt", "projects/b.txt"]);
});

test("client recognizes real rclone bisync conflict rename output", () => {
  const stats = parseRcloneStats([
    "2026/07/13 15:45:23 NOTICE: - Path1             Renaming Path1 copy                        - Path1/projects/a.conflict1.txt",
    "2026/07/13 15:45:23 NOTICE: - Path2             Renaming Path2 copy                        - Path2/projects/a.conflict2.txt"
  ].join("\n"), { direction: "bidirectional" });

  assert.equal(stats.conflicts.count, 2);
  assert.deepEqual(stats.conflicts.files, [
    "projects/a.conflict1.txt",
    "projects/a.conflict2.txt"
  ]);
});

test("client ignores conflict-looking paths and HTTP status outside reliable bisync conflicts", () => {
  const falsePositive = parseRcloneStats([
    "INFO  : projects/report.sync-conflict-20260713.docx: Copied (new)",
    "ERROR : storage request failed: HTTP 409 Conflict",
    "Transferred:      512 MiB / 2 GiB, 25%, 8 MiB/s, ETA 3m0s"
  ].join("\n"), { direction: "bidirectional" });
  assert.equal(falsePositive.conflicts, undefined);

  const oneWay = parseRcloneStats(
    "ERROR : projects/a.txt: file changed on both sides - conflict",
    { direction: "upload" }
  );
  assert.equal(oneWay?.conflicts, undefined);
});

test("client deduplicates the same reliable bisync conflict across output chunks", () => {
  const parsed = parseRcloneStats(
    "ERROR : projects/a.txt: file changed on both sides - conflict",
    { direction: "bidirectional" }
  );
  let conflicts = mergeRcloneConflictSummary(null, parsed.conflicts);
  conflicts = mergeRcloneConflictSummary(conflicts, parsed.conflicts);

  assert.equal(conflicts.count, 1);
  assert.deepEqual(conflicts.files, ["projects/a.txt"]);
  assert.equal(conflicts.truncated, false);
});

test("client counts unique bisync conflicts beyond the displayed file limit", () => {
  const conflictLines = Array.from(
    { length: 12 },
    (_, index) => `ERROR : projects/conflict-${index + 1}.txt: file changed on both sides - conflict`
  );
  conflictLines.push(conflictLines[10]);

  const stats = parseRcloneStats(conflictLines.join("\n"), { direction: "bidirectional" });

  assert.equal(stats.conflicts.count, 12);
  assert.equal(stats.conflicts.files.length, 10);
  assert.equal(stats.conflicts.truncated, true);
});

test("client maps rclone MinIO HTTP 507 failures to stable storage_full", async () => {
  const stats = parseRcloneStats(
    "2026/07/13 07:35:30 ERROR : upload failed: HTTP 507 XMinioStorageFull: Storage backend has reached its minimum free drive threshold"
  );
  assert.equal(stats.errorCode, "storage_full");
  assert.equal(stats.error, "服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。");

  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  assert.match(server, /metrics\.errorCode \|\| exit\.errorCode \|\| "rclone_sync_failed"/);
  assert.match(server, /metrics\.error \|\| exit\.error/);
});

test("client maps MinIO storage-full failures split across output chunks", async () => {
  let context = "";
  context = appendRcloneOutputContext(context, "ERROR : upload failed: HTTP 507 ");
  assert.equal(parseRcloneFailure(context), null);

  context = appendRcloneOutputContext(
    context,
    "XMinioStorageFull: Storage backend has reached its minimum free drive threshold"
  );
  const failure = parseRcloneFailure(context);
  assert.equal(failure.errorCode, "storage_full");

  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  // stdout/stderr are independent streams. Assert their isolated rolling
  // contexts instead of pinning the obsolete shared buffer: joining streams
  // could splice stderr into a partial stdout failure/conflict line.
  assert.match(server, /let syncOutputContexts = \{\s*stdout: "",\s*stderr: ""\s*\}/);
  assert.match(server, /const stream = output\.stream === "stderr" \? "stderr" : "stdout"/);
  assert.match(server, /syncOutputContexts\[stream\] = appendRcloneOutputContext\(syncOutputContexts\[stream\], output\.text\)/);
  assert.match(server, /parseRcloneStats\(syncOutputContexts\[stream\]/);
  assert.match(server, /parseRcloneFailure\(syncOutputContexts\[stream\]\)/);
});

test("client UI treats a successful zero-transfer run as already up to date", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const server = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const source = extractBrowserFunctionRange(
    app,
    "function renderSyncProgress",
    "function renderScheduler"
  );
  const elements = Object.fromEntries([
    "speedValue",
    "progressFill",
    "progressValue",
    "transferredValue",
    "lastSyncValue",
    "currentFileValue"
  ].map((id) => [id, makeFakeElement()]));
  elements.progressFill.style = {};
  const context = {
    document: { getElementById: (id) => elements[id] }
  };
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    "const clampPercent = (value) => value == null ? null : Math.max(0, Math.min(100, Number(value)));",
    "const formatPercent = (value) => `${Number(value).toFixed(0)}%`;",
    "const statusText = () => '等待开始';",
    "const formatLastSync = () => '成功';",
    source,
    "this.renderSyncProgress = renderSyncProgress;"
  ].join("\n"), context);

  context.renderSyncProgress({
    syncState: "idle",
    phase: "completed",
    progressPercent: null,
    transferredSizeText: "",
    transferredText: ""
  }, { status: "success" });

  assert.equal(elements.progressValue.textContent, "内容已是最新");
  assert.equal(elements.progressFill.style.width, "100%");
  assert.equal(elements.transferredValue.textContent, "0 B / 0 B");
  assert.match(server, /phase: status === "success" \? "completed"/);
});

test("client UI ignores impossible legacy conflicts on one-way runs", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const run = {
    status: "success",
    job: { direction: "upload" },
    conflicts: { count: 297, files: ["projects/a.txt"] }
  };
  const context = { run };
  runInNewContext([
    "const syncRunStatusClass = (status) => status;",
    "const syncRunStatusText = (status) => status === 'success' ? '成功' : status;",
    extractBrowserFunctionRange(app, "function hasDisplayableConflicts", "function formatSyncRunTitle"),
    "this.hasConflicts = hasDisplayableConflicts(run);",
    "this.presentationClass = syncRunPresentationClass(run);",
    "this.badgeText = syncRunBadgeText(run);"
  ].join("\n"), context);

  assert.equal(context.hasConflicts, false);
  assert.equal(context.presentationClass, "success");
  assert.equal(context.badgeText, "成功");
  assert.match(app, /if \(hasDisplayableConflicts\(run\)\) summary\.conflict \+= 1/);
  assert.match(app, /const conflict = hasDisplayableConflicts\(run\)/);
  assert.match(app, /const conflicts = hasDisplayableConflicts\(run\)/);
});

test("client UI prioritizes storage failure over conflict presentation", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const run = {
    status: "error",
    errorCode: "storage_full",
    error: "服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。",
    conflicts: { count: 9, files: ["projects/a.txt"] }
  };

  const presentationContext = { run };
  runInNewContext([
    "const syncRunStatusClass = (status) => status;",
    "const syncRunStatusText = (status) => status === 'error' ? '失败' : status;",
    extractBrowserFunctionRange(app, "function syncRunPresentationClass", "function formatSyncRunTitle"),
    "this.presentationClass = syncRunPresentationClass(run);",
    "this.badgeText = syncRunBadgeText(run);"
  ].join("\n"), presentationContext);
  assert.equal(presentationContext.presentationClass, "error");
  assert.equal(presentationContext.badgeText, "失败");

  const detailContext = { run };
  runInNewContext([
    "const formatError = ({ code }) => code === 'storage_full' ? '服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。' : code;",
    "const formatConflictSummary = () => '冲突';",
    "const conflictResolutionHint = () => '处理冲突';",
    extractBrowserFunctionRange(app, "function syncRunDetail", "function formatConflictSummary"),
    "this.detail = syncRunDetail(run);"
  ].join("\n"), detailContext);
  assert.match(detailContext.detail, /^错误：服务器存储空间不足/);
  assert.doesNotMatch(detailContext.detail, /冲突/);

  assert.match(app, /storage_full: "服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。"/);
});

function makeServerProfile(overrides = {}) {
  const clientName = overrides.clientName || "company-pc1";
  return {
    version: 1,
    profileId: overrides.profileId || `profile-${clientName}`,
    clientName,
    issuedAt: "2026-07-03T00:00:00.000Z",
    expiresAt: null,
    source: {
      type: "profile",
      server: overrides.server || "https://pass.971223.xyz:2025"
    },
    tunnel: {
      type: "vless",
      uri: tunnelUri
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: overrides.heartbeatSecret || "heartbeat-secret"
    },
    storage: {
      type: "s3",
      remoteName: "home-minio",
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: clientName,
      secretAccessKey: "secret",
      prefix: `devices/${clientName}`
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      checkers: 8,
      chunkSize: "16M",
      retries: 3,
      lowLevelRetries: 10,
      bandwidthLimit: "off",
      schedule: { mode: "manual" }
    }
  };
}

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status || 200,
    json: async () => payload
  };
}

function buildBrowserApiContext(app) {
  const source = extractBrowserApiSource(app);
  const context = {
    fetch: async () => {
      throw new Error("fetch was not stubbed");
    }
  };
  runInNewContext([
    "const defaultRequestTimeoutMs = 15000;",
    "const syncPreparationRequestTimeoutMs = 120000;",
    "const syncRunRequestTimeoutMs = 120000;",
    "const bidirectionalInitializationRequestTimeoutMs = 240000;",
    source,
    "this.readJsonOrFallback = readJsonOrFallback;",
    "this.requestJson = requestJson;",
    "this.clientApi = clientApi;"
  ].join("\n"), context);
  return context;
}

function buildConfirmationContext(app) {
  const source = extractBrowserFunctionRange(
    app,
    "function requestConfirmation",
    "function formatError"
  );
  const elements = Object.fromEntries(
    [
      "confirmGate",
      "confirmTextLabel",
      "confirmTextInput",
      "confirmSubmitBtn",
      "confirmTitle",
      "confirmBody",
      "confirmMessage"
    ].map((id) => [id, makeFakeElement()])
  );
  const context = {
    elements,
    setTimeout: (callback) => callback(),
    document: {
      getElementById: (id) => {
        const element = elements[id];
        assert.ok(element, `missing fake element ${id}`);
        return element;
      }
    }
  };
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    "let pendingConfirmation = null;",
    source,
    "this.requestConfirmation = requestConfirmation;",
    "this.submitConfirmation = submitConfirmation;",
    "this.cancelConfirmation = cancelConfirmation;"
  ].join("\n"), context);
  return context;
}

function buildConfirmedJobContext(app, options = {}) {
  const confirmedJobSource = extractBrowserFunctionRange(
    app,
    "function readJob",
    "function readSchedule"
  );
  const destructiveSource = extractBrowserFunctionRange(
    app,
    "function destructiveSyncConfirmationBody",
    "function formatDirection"
  ) + extractBrowserFunctionRange(
    app,
    "function formatDirection(value)",
    "function renderSummaryRows"
  );
  const compatibilityWarningSource = extractBrowserFunctionRange(
    app,
    "function formatSyncCompatibilityWarning",
    "function syncRunStatusText"
  );
  const jobOptions = options.job || {};
  const compatibility = options.compatibility || null;
  const fields = {
    direction: { value: jobOptions.direction || "upload" },
    localPath: { value: jobOptions.localPath || "D:\\Work" },
    transfers: { value: String(jobOptions.transfers || 4) },
    streams: { value: String(jobOptions.streams || 8) },
    destructiveSync: { checked: Boolean(jobOptions.destructiveSync) }
  };
  const context = {
    fields,
    confirmations: [],
    confirmationQueue: [],
    latestStatus: compatibility ? { heartbeat: { ok: true, compatibility } } : {},
    currentJobDraft: {
      name: "Home Sync",
      bucketName: "home-sync",
      remotePrefix: "devices/company-pc1"
    }
  };
  runInNewContext([
    "function readPositiveIntegerField(field) { return Number(field.value); }",
    "function readBandwidthLimit() { return 'off'; }",
    "function readSchedule() { return { mode: 'manual' }; }",
    // 方向授权在 readDirectionField 里校验；确认流程测的是确认顺序，
    // 未知授权（null）时不施加额外限制，与 legacy profile 的行为一致。
    "function allowedSyncDirections() { return null; }",
    "async function requestConfirmation(options) { confirmations.push(options); return confirmationQueue.shift() ?? null; }",
    "function formatCompatibility(compatibility) { return compatibility?.status || 'warning'; }",
    destructiveSource,
    compatibilityWarningSource,
    confirmedJobSource,
    "this.readConfirmedJob = readConfirmedJob;"
  ].join("\n"), context);
  return context;
}

function buildSaveRunContext(app) {
  const source = extractBrowserFunctionRange(
    app,
    "async function saveJob",
    "async function stopSync"
  );
  const context = {
    confirmedJob: null,
    apiCalls: [],
    safetyPlans: [],
    actions: [],
    loadStatusCalls: 0,
    refreshLogsCalls: 0,
    lastPreviewJobFingerprint: "same"
  };
  runInNewContext([
    "async function withBusyAction(buttonId, action) { return action(); }",
    "async function readConfirmedJob() { return this.confirmedJob; }",
    "function setAction(text, state) { actions.push({ text, state }); }",
    "function formatError(error) { return error?.message || String(error); }",
    "function formatDirection(value) { return value || ''; }",
    "function formatBisyncInitialMode(value) { return value || ''; }",
    "function jobPreviewFingerprint() { return 'same'; }",
    "async function requestConfirmation() { return { confirmed: true }; }",
    "async function loadStatus() { this.loadStatusCalls += 1; }",
    "async function refreshLogs() { this.refreshLogsCalls += 1; }",
    "const clientApi = {",
    "  saveJob: async (payload) => { apiCalls.push({ name: 'saveJob', payload }); return { ok: true }; },",
    "  createSyncSafetyPlan: async (payload) => { apiCalls.push({ name: 'createSyncSafetyPlan', payload }); return this.safetyPlans.shift(); },",
    "  initializeBidirectionalSync: async (payload) => { apiCalls.push({ name: 'initializeBidirectionalSync', payload }); return { ok: true }; },",
    "  runSync: async (payload) => { apiCalls.push({ name: 'runSync', payload }); return { ok: true}; }",
    "};",
    source,
    "this.saveJob = saveJob;",
    "this.runSync = runSync;"
  ].join("\n"), context);
  return context;
}

function buildStopSyncContext(app, stopResponse) {
  const source = extractBrowserFunctionRange(
    app,
    "async function stopSync",
    "async function refreshLogs"
  );
  const context = {
    actions: [],
    loadStatusCalls: 0,
    refreshLogsCalls: 0
  };
  runInNewContext([
    "async function withBusyAction(buttonId, action) { return action(); }",
    "function setAction(text, state) { actions.push({ text, state }); }",
    "function formatError(error) { return error?.message || String(error); }",
    `const clientApi = { stopSync: async () => (${JSON.stringify(stopResponse)}) };`,
    "async function loadStatus() { this.loadStatusCalls += 1; }",
    "async function refreshLogs() { this.refreshLogsCalls += 1; }",
    source,
    "this.stopSync = stopSync;"
  ].join("\n"), context);
  return context;
}

function buildStatusPollingContext(app) {
  const source = extractBrowserFunctionRange(
    app,
    "async function loadStatus",
    "async function checkBinaries"
  );
  const elements = Object.fromEntries(
    [
      "clientVersion",
      "clientProtocols",
      "serverProtocols",
      "protocolCompatibility",
      "compatibilityPolicy",
      "clientBuildId",
      "clientBuildTime",
      "releaseManifestStatus",
      "releaseManifestBuiltAt",
      "singboxPath",
      "rclonePath",
      "dataRoot",
      "localStateStatus",
      "secretVaultStatus",
      "binStatus",
      "profileStatus",
      "tunnelStatus",
      "syncStatus",
      "singboxHealth",
      "rcloneHealth",
      "heartbeatHealth",
      "localPath"
    ].map((id) => [id, makeFakeElement()])
  );
  const getStatusQueue = [];
  const context = {
    elements,
    getStatusQueue,
    getStatusCalls: 0,
    document: {
      getElementById: (id) => {
        const element = elements[id] || makeFakeElement();
        elements[id] = element;
        return element;
      }
    }
  };
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    "let statusRequestInFlight = null;",
    "let latestStatus = null;",
    "let latestSyncHistory = [];",
    "let currentJobDraft = null;",
    "let latestStatusRequestId = 0;",
    "let latestAppliedStatusRequestId = 0;",
    "const clientApi = { getStatus: () => { this.getStatusCalls += 1; return this.getStatusQueue.shift(); } };",
    "function updateBodyState() {}",
    "function currentSuccessfulHeartbeat(status) { return status.lastSuccessfulHeartbeat || status.heartbeat || null; }",
    "function formatProtocols(value) { return value ? 'protocols' : '-'; }",
    "function formatCompatibility(value) { return value?.status || '-'; }",
    "function formatCompatibilityPolicy(value) { return value?.syncRun || '-'; }",
    "function formatShortTime(value) { return value || '-'; }",
    "function formatReleaseManifest(value) { return value?.ok ? 'ok' : '-'; }",
    "function formatLocalState(value) { return value?.ok ? 'ok' : '-'; }",
    "function formatSecretVault(value) { return value?.ok ? 'ok' : '-'; }",
    "function profileStatusDisplay() { return { pill: 'profile', state: '' }; }",
    "function renderDeviceRecovery() {}",
    "function syncStatusPill(sync) { return { text: sync.running ? '同步中' : '空闲', state: sync.running ? 'good' : '' }; }",
    "function setPill(id, text, state) { const el = $(id); el.textContent = text; el.state = state || ''; }",
    "function setHealth(id, name, ok, detail) { const el = $(id); el.textContent = ok ? `${name}:ok` : `${name}:bad`; el.detail = detail || ''; }",
    "function renderHeartbeat() {}",
    "function renderSyncProgress() {}",
    "function renderScheduler() {}",
    "function renderSyncHistory() {}",
    "function renderProfileSummary() {}",
    "function renderRemoteTargetSummary() {}",
    // 方向授权改选择器可选项，与状态轮询的去重/丢弃逻辑无关，这里存根即可。
    "function applySyncDirectionAuthorization() {}",
    "function writeJob(job) { $('localPath').value = job.localPath || ''; }",
    source,
    "this.loadStatus = loadStatus;"
  ].join("\n"), context);
  return context;
}

function buildBusyActionContext(app) {
  const source = extractBrowserFunctionRange(
    app,
    "async function withBusyAction",
    "function setVisibility"
  );
  const elements = {
    runSyncBtn: makeFakeElement()
  };
  const context = {
    elements,
    document: {
      getElementById: (id) => elements[id] || null
    }
  };
  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    source,
    "this.withBusyAction = withBusyAction;"
  ].join("\n"), context);
  return context;
}

function buildFolderPickerContext(app) {
  const chooseSource = extractBrowserFunctionRange(
    app,
    "async function chooseLocalFolder",
    "function readJob"
  );
  const pickSource = extractBrowserFunctionRange(
    app,
    "function pickFolder",
    "function renderProfileSummary"
  );
  const fields = {
    localPath: makeFakeElement(),
    folderPicker: makeFakeElement()
  };
  fields.folderPicker.files = [];
  const actions = [];
  const context = {
    fields,
    actions,
    window: {},
    Error
  };
  runInNewContext([
    "function setAction(text, state) { actions.push({ text, state }); }",
    "function formatError(error) { return error?.message || String(error); }",
    chooseSource,
    pickSource,
    "this.chooseLocalFolder = chooseLocalFolder;",
    "this.pickFolder = pickFolder;"
  ].join("\n"), context);
  return context;
}

function buildSupportSummaryContext(app) {
  const source = extractBrowserFunctionRange(
    app,
    "async function copySupportSummary",
    "async function shutdownClient"
  );
  const actions = [];
  const context = {
    actions,
    latestStatus: null,
    latestSyncHistory: [],
    clipboardText: "",
    navigator: {
      clipboard: {
        writeText: async (text) => {
          context.clipboardText = text;
        }
      }
    }
  };
  runInNewContext([
    "function setAction(text, state) { actions.push({ text, state }); }",
    source,
    "this.copySupportSummary = copySupportSummary;",
    "this.buildSupportSummary = buildSupportSummary;"
  ].join("\n"), context);
  return context;
}

function makeClientStatus(overrides = {}) {
  return {
    appVersion: overrides.appVersion || "0.3.0-rc.1",
    clientVersion: overrides.appVersion || "0.3.0-rc.1",
    diagnostics: { protocols: { claim: 1, profile: 1, adminState: 1, clientStatus: 1, heartbeat: 1 } },
    releaseManifest: { ok: true, builtAt: "2026-07-08T00:00:00.000Z" },
    binaries: {
      singbox: { path: "sing-box.exe", exists: true },
      rclone: { path: "rclone.exe", exists: true }
    },
    paths: { dataRoot: "C:\\Data" },
    safeguards: {
      localState: { ok: true },
      secretVault: { ok: true }
    },
    profileImported: true,
    heartbeat: { ok: true },
    processes: {
      singbox: { running: Boolean(overrides.singboxRunning) },
      sync: { running: false, metrics: { syncState: "idle" } }
    },
    lastSync: null,
    scheduler: {},
    syncHistory: [],
    profileSummary: null,
    jobs: []
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeFakeElement() {
  const classes = new Set();
  const attributes = {};
  return {
    hidden: true,
    textContent: "",
    value: "",
    placeholder: "",
    focused: false,
    disabled: false,
    dataset: {},
    attributes,
    focus() {
      this.focused = true;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name)
    }
  };
}

function buildReleaseManifestSupportDocumentsFormatter(app) {
  const source = extractBrowserFunctionRange(
    app,
    "function formatReleaseManifestSupportDocuments",
    "function formatReleaseManifestRequiredFiles"
  );
  const context = {};
  runInNewContext([
    source,
    "this.formatReleaseManifestSupportDocuments = formatReleaseManifestSupportDocuments;"
  ].join("\n"), context);
  return context.formatReleaseManifestSupportDocuments;
}

function extractBrowserFunctionRange(app, startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return app.slice(start, end);
}

function extractBrowserApiSource(app) {
  const start = app.indexOf("function summarizeResponseText");
  assert.notEqual(start, -1);
  return app.slice(start);
}
