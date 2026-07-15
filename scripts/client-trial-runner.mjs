import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const baseUrl = normalizeBaseUrl(readArg("--base-url") || process.env.SFSC_TRIAL_CLIENT_BASE_URL || "http://127.0.0.1:5188");
const tKey = readArg("--t-key") || process.env.SFSC_TRIAL_T_KEY || "";
const localPath = readArg("--local-path") || process.env.SFSC_TRIAL_LOCAL_PATH || "";
const direction = readArg("--direction") || process.env.SFSC_TRIAL_DIRECTION || "upload";
const remoteFolder = readArg("--remote-folder") || process.env.SFSC_TRIAL_REMOTE_FOLDER || `internal-trial-${timestampSlug()}`;
const jsonReportPath = readArg("--json-report") || process.env.SFSC_TRIAL_RUNNER_JSON_REPORT || "reports/internal-trial/client-trial-runner.json";
const requestTimeoutMs = readPositiveInteger(readArg("--timeout-ms") || process.env.SFSC_TRIAL_TIMEOUT_MS, 15000);
const waitTimeoutMs = readPositiveInteger(readArg("--wait-timeout-ms") || process.env.SFSC_TRIAL_WAIT_TIMEOUT_MS, 180000);
const stopAfterMs = readPositiveInteger(readArg("--stop-after-ms") || process.env.SFSC_TRIAL_STOP_AFTER_MS, 0);
const dryRun = hasArg("--dry-run");
const runSync = hasArg("--run-sync");
const understoodRealSync = hasArg("--i-understand-real-sync");
const confirmCompatibilityWarning = hasArg("--confirm-compatibility-warning");
const confirmDestructiveSync = hasArg("--confirm-destructive-sync");
const destructiveSync = hasArg("--destructive-sync");
const clientPackageType = readArg("--client-package-type") || process.env.SFSC_TRIAL_CLIENT_PACKAGE_TYPE || "";
const clientPackageManifestPath = readArg("--client-package-manifest") || process.env.SFSC_TRIAL_CLIENT_PACKAGE_MANIFEST || "";
const clientExecutablePath = readArg("--client-executable") || process.env.SFSC_TRIAL_CLIENT_EXECUTABLE || "";
const clientPackageZipPath = readArg("--client-package-zip") || process.env.SFSC_TRIAL_CLIENT_PACKAGE_ZIP || "";

const checks = [];
let currentCheck = "startup";
let context = {};

try {
  await main();
  await writeReport(true, null);
} catch (error) {
  console.error(`Client trial runner failed at ${error.check || currentCheck}: ${error.message || error}`);
  process.exitCode = 1;
  await writeReport(false, error);
}

async function main() {
  if (runSync && !understoodRealSync) {
    throw new Error("Refusing to run real sync without --i-understand-real-sync.");
  }
  if (destructiveSync && !confirmDestructiveSync) {
    throw new Error("Refusing destructive sync without --confirm-destructive-sync.");
  }
  if (!dryRun) {
    if (!tKey) throw new Error("Missing --t-key or SFSC_TRIAL_T_KEY.");
    if (!localPath) throw new Error("Missing --local-path or SFSC_TRIAL_LOCAL_PATH.");
    requireLocalDirectory(localPath);
  }
  const clientPackage = readClientPackageEvidence();

  context = {
    baseUrl,
    dryRun,
    runSync,
    direction,
    remoteFolder,
    localPathProvided: Boolean(localPath),
    localPathExists: localPath ? existsSync(localPath) : false,
    tKeyProvided: Boolean(tKey),
    tKeySha256: tKey ? sha256Text(tKey) : "",
    tKeyLength: tKey.length,
    requestTimeoutMs,
    waitTimeoutMs,
    stopAfterMs,
    clientPackage
  };

  const health = await runCheck("health", () => getJson("/api/health"));
  pass("health", `clientVersion=${health.clientVersion || health.version || "unknown"}`);

  const initialStatus = await runCheck("initial-status", () => getJson("/api/client/status"));
  requireOk(initialStatus, "initial status");
  pass("initial-status", `profileImported=${Boolean(initialStatus.profileImported)}, jobs=${initialStatus.jobs?.length || 0}`);

  if (dryRun) {
    pass("dry-run", "No profile import, job save, sync run, or diagnostic export was performed.");
    return;
  }

  const importResult = await runCheck("profile-import", () => postJson("/api/profile/import", { code: tKey }));
  if (!importResult.profile?.clientName) {
    throw new Error("Profile import response did not include a clientName summary.");
  }
  pass("profile-import", `client=${importResult.profile.clientName}`);

  const importedStatus = await runCheck("imported-status", () => waitForJson("/api/client/status", (value) => value.profileImported === true));
  pass("imported-status", `profile=${importedStatus.profileSummary?.clientName || importResult.profile.clientName}`);

  const job = buildJob(importedStatus);
  const savePayload = await runCheck("job-save", () => postJson("/api/jobs/save", {
    job,
    confirmCompatibilityWarning,
    confirmDestructiveSync
  }));
  pass("job-save", `direction=${savePayload.job?.direction || job.direction}, remoteFolder=${savePayload.job?.remoteFolder || job.remoteFolder || "(profile-default)"}`);

  const preview = await runCheck("sync-preview", () => postJson("/api/sync/preview", { job }));
  const previewText = JSON.stringify(preview);
  assertNoSensitiveTrialValues(previewText, "sync preview");
  pass("sync-preview", `remotePath=${preview.rclone?.remotePath || "(missing)"}`);

  if (runSync) {
    await runRealSync(job);
  } else {
    pass("sync-run-skipped", "Real sync was not run; pass --run-sync --i-understand-real-sync to execute it.");
  }

  const diagnostics = await runCheck("diagnostic-export", () => getJson("/api/diagnostics/export"));
  assertNoSensitiveTrialValues(JSON.stringify(diagnostics), "diagnostic export");
  pass("diagnostic-export", `filename=${diagnostics.filename || "(missing)"}`);
}

async function runRealSync(job) {
  const runPayload = await runCheck("sync-run", () => postJson("/api/sync/run", {
    job,
    confirmCompatibilityWarning,
    confirmDestructiveSync
  }));
  pass("sync-run", `running=${Boolean(runPayload.sync?.running)}, pid=${runPayload.sync?.pid || "unknown"}`);

  if (stopAfterMs > 0) {
    await delay(stopAfterMs);
    const stopPayload = await runCheck("sync-stop", () => postJson("/api/sync/stop", {}));
    pass("sync-stop", `running=${Boolean(stopPayload.sync?.running)}, timedOut=${Boolean(stopPayload.sync?.stopTimedOut)}`);
    await runCheck("sync-history-after-stop", () => waitForJson("/api/sync/history", (value) => {
      const status = value.history?.[0]?.status || "";
      return ["stopped", "success", "error"].includes(status);
    }));
    pass("sync-history-after-stop", "history recorded a terminal sync status");
    return;
  }

  const history = await runCheck("sync-history-terminal", () => waitForJson("/api/sync/history", (value) => {
    const status = value.history?.[0]?.status || "";
    return ["success", "error", "stopped"].includes(status);
  }, waitTimeoutMs));
  const lastRun = history.history?.[0] || {};
  pass("sync-history-terminal", `status=${lastRun.status || "(missing)"}, errorCode=${lastRun.errorCode || ""}`);
  if (lastRun.status !== "success") {
    throw new Error(`Real sync did not finish successfully: status=${lastRun.status || "(missing)"} errorCode=${lastRun.errorCode || ""}`);
  }
}

function buildJob(status) {
  const base = Array.isArray(status.jobs) && status.jobs.length ? status.jobs[0] : {};
  return {
    ...base,
    localPath,
    direction,
    remoteFolder,
    destructiveSync,
    transfers: readPositiveInteger(readArg("--transfers") || process.env.SFSC_TRIAL_TRANSFERS, 2),
    streams: readPositiveInteger(readArg("--streams") || process.env.SFSC_TRIAL_STREAMS, 2),
    schedule: { mode: "manual" }
  };
}

async function runCheck(name, task) {
  currentCheck = name;
  try {
    return await task();
  } catch (error) {
    error.check = error.check || name;
    throw error;
  }
}

async function getJson(path) {
  return requestJson("GET", path);
}

async function postJson(path, body) {
  return requestJson("POST", path, body);
}

async function requestJson(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${path}, got: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const code = payload.errorCode || payload.error || "";
    const message = payload.message || payload.error || response.statusText;
    const error = new Error(`HTTP ${response.status} ${path}${code ? ` ${code}` : ""}: ${message}`);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload;
}

async function waitForJson(path, predicate, timeoutMs = waitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await getJson(path).catch((error) => ({ error: error.message }));
    if (predicate(lastValue)) return lastValue;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${path}. Last value: ${JSON.stringify(lastValue).slice(0, 500)}`);
}

function requireOk(value, label) {
  if (value?.ok !== true) {
    throw new Error(`${label} did not return ok=true.`);
  }
}

function requireLocalDirectory(path) {
  if (!existsSync(path)) {
    throw new Error(`Local path does not exist: ${path}`);
  }
  const info = statSync(path);
  if (!info.isDirectory()) {
    throw new Error(`Local path is not a directory: ${path}`);
  }
}

function readClientPackageEvidence() {
  const provided = [clientPackageManifestPath, clientExecutablePath, clientPackageZipPath].filter(Boolean);
  if (provided.length === 0) return null;
  if (provided.length !== 3) {
    throw new Error("Client package evidence requires --client-package-manifest, --client-executable, and --client-package-zip together.");
  }
  for (const [label, path] of [
    ["client package manifest", clientPackageManifestPath],
    ["client executable", clientExecutablePath],
    ["client package ZIP", clientPackageZipPath]
  ]) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`${label} was not found.`);
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(clientPackageManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Client package manifest could not be parsed: ${error.message}`);
  }
  if (!manifest.package || !manifest.version || !manifest.buildId || !manifest.sourceTreeHash) {
    throw new Error("Client package manifest is missing package, version, buildId, or sourceTreeHash.");
  }
  if (manifest.buildId !== `sfsc-${String(manifest.sourceTreeHash).slice(0, 12)}`) {
    throw new Error("Client package manifest buildId does not match sourceTreeHash.");
  }
  return {
    packageType: clientPackageType,
    package: String(manifest.package),
    version: String(manifest.version),
    buildId: String(manifest.buildId),
    sourceTreeHash: String(manifest.sourceTreeHash),
    executableSha256: sha256File(clientExecutablePath),
    releaseManifestSha256: sha256File(clientPackageManifestPath),
    packageZipSha256: sha256File(clientPackageZipPath)
  };
}

function assertNoSensitiveTrialValues(text, label) {
  const sensitiveValues = [
    tKey
  ].filter(Boolean);
  for (const value of sensitiveValues) {
    if (text.includes(value)) {
      throw new Error(`${label} leaked the provided SyncKey.`);
    }
  }
  for (const [name, pattern] of [
    ["SyncKey", /SFSC1-[A-Za-z0-9_-]+/],
    ["VLESS URI", /vless:\/\/[^\s"']+/i],
    ["secret access key", /secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[^"'\s,*]{6,}/i],
    ["heartbeat secret", /heartbeatSecret["']?\s*[:=]\s*["']?[^"'\s,*]{6,}/i]
  ]) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive-looking ${name} content.`);
    }
  }
}

function pass(name, detail) {
  checks.push({ name, detail });
  console.log(`- ${name}: ${detail}`);
}

async function writeReport(ok, error) {
  if (!jsonReportPath) return;
  const reportPath = resolve(jsonReportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "client-trial-runner-report",
    ok,
    mode: dryRun ? "dry-run" : runSync ? "real-sync" : "profile-preview",
    generatedAt: new Date().toISOString(),
    context,
    summary: {
      passed: checks.length,
      failed: ok ? 0 : 1
    },
    checks,
    manualVerificationRequired: [
      "Confirm the SyncKey was generated by the intended server/admin workflow.",
      "Confirm uploaded or synchronized test files in the target object storage bucket/prefix.",
      "Confirm the UI experience, folder picker behavior, and visible progress on the trial Windows machine.",
      "Attach this report and any exported diagnostics to internal-trial-record.json manually."
    ],
    failure: ok ? null : {
      check: error?.check || currentCheck,
      message: error?.message || String(error || "unknown error"),
      code: error?.code || "",
      status: error?.status || null
    }
  };
  writeJsonReportSync(reportPath, payload, "client trial runner report");
  console.log(`Client trial runner JSON report written: ${reportPath}`);
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
