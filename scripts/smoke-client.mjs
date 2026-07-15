import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertClientHealthContract,
  assertClientJobsReadContract,
  assertClientLogsContract,
  assertClientProfileReadContract,
  assertClientStatusContract,
  assertClientSyncHistoryContract,
  assertDiagnosticExportContract,
  assertHeartbeatContract,
  assertRuntimeDiagnosticsContract
} from "./lib/runtimeContracts.mjs";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const baseUrl = normalizeBaseUrl(
  readArg("--base-url") || process.env.SFSC_CLIENT_SMOKE_BASE_URL || "http://127.0.0.1:5188"
);
const jsonReportPath = readArg("--json-report") || process.env.SFSC_CLIENT_SMOKE_JSON_REPORT || "";
const requestTimeoutMs = readPositiveInteger(
  readArg("--timeout-ms") || process.env.SFSC_CLIENT_SMOKE_TIMEOUT_MS,
  10000
);

const checks = [];
let currentCheck = "startup";
let smokeOk = false;
let smokeError = null;

try {
  const health = await runCheck("health", () => getJson("/api/health"));
  assertClientHealthContract(health);
  pass("health", `version=${health.version || health.clientVersion || "unknown"}, protocol=${health.diagnostics?.protocols?.clientStatus || "unknown"}, timeout=${requestTimeoutMs}ms`);

  const status = await runCheck("client-status", () => getJson("/api/client/status"));
  requireField(status, "ok", true);
  requireField(status, "mode", "client-exe-runtime");
  assertRuntimeDiagnosticsContract(status.diagnostics, "client");
  requireHealthDoesNotExposeFullState(health);
  requireProtocolMapMatch(health.diagnostics.protocols, status.diagnostics.protocols);
  assertClientStatusContract(status);
  requireReleaseManifestContract(status.releaseManifest);
  requireObject(status.binaries, "binaries");
  requireProcessesContract(status.processes);
  if (status.heartbeat !== null) {
    assertHeartbeatContract(status.heartbeat);
  }
  pass("client-status", `version=${status.clientVersion || status.appVersion || "unknown"}, protocols=aligned, profileImported=${status.profileImported}, manifest=${status.releaseManifest?.errorCode || (status.releaseManifest?.ok ? "ok" : "unknown")}`);

  const profileRead = await runCheck("client-profile", () => getJson("/api/profile"));
  assertClientProfileReadContract(profileRead, "clientProfile");
  if (status.profileImported && profileRead.profile === null) {
    throw new Error("Expected /api/profile to return a profile when /api/client/status reports profileImported=true.");
  }
  if (!status.profileImported && profileRead.profile !== null) {
    throw new Error("Expected /api/profile to return null when /api/client/status reports profileImported=false.");
  }
  pass("client-profile", profileRead.profile ? `client=${profileRead.profile.clientName}` : "profile=not-imported");

  const jobsRead = await runCheck("client-jobs", () => getJson("/api/jobs"));
  assertClientJobsReadContract(jobsRead, "clientJobs");
  if (jobsRead.jobs.length !== status.jobs.length) {
    throw new Error("Expected /api/jobs count to match /api/client/status.jobs count.");
  }
  pass("client-jobs", `jobs=${jobsRead.jobs.length}`);

  const syncHistory = await runCheck("client-sync-history", () => getJson("/api/sync/history"));
  assertClientSyncHistoryContract(syncHistory, "syncHistory");
  if (syncHistory.history.length !== status.syncHistory.length) {
    throw new Error("Expected /api/sync/history count to match /api/client/status.syncHistory count.");
  }
  pass("client-sync-history", `runs=${syncHistory.history.length}`);

  const logs = await runCheck("client-logs", () => getJson("/api/logs"));
  assertClientLogsContract(logs, "clientLogs");
  pass("client-logs", `singboxChars=${logs.singbox.length}, rcloneChars=${logs.rclone.length}`);

  const diagnosticExport = await runCheck("diagnostic-export", () => getJson("/api/diagnostics/export"));
  assertDiagnosticExportContract(diagnosticExport, "diagnosticExport");
  pass("diagnostic-export", `filename=${diagnosticExport.filename}, logs=${Object.keys(diagnosticExport.bundle.logs).length}`);

  console.log(`\nSFSC client smoke passed: ${baseUrl}`);
  for (const check of checks) {
    console.log(`- ${check.name}: ${check.detail}`);
  }
  smokeOk = true;
} catch (error) {
  smokeError = error;
  console.error(`\nSFSC client smoke failed: ${baseUrl}`);
  console.error(`Failed check: ${error.check || currentCheck}`);
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  writeSmokeJsonReport(smokeOk, smokeError);
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
  const controller = typeof AbortController === "function" && requestTimeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), requestTimeoutMs)
    : null;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller?.signal
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const code = payload?.errorCode || payload?.error || "";
      const message = payload?.message || payload?.error || response.statusText || "request failed";
      const error = new Error(`HTTP ${response.status} ${path}${code ? ` ${code}` : ""}: ${message}`);
      error.status = response.status;
      error.code = code;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${requestTimeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 120)}`);
  }
}

function requireField(object, field, expected) {
  if (!Object.hasOwn(object || {}, field)) {
    throw new Error(`Missing field: ${field}`);
  }
  if (object[field] !== expected) {
    throw new Error(`Unexpected ${field}: expected ${expected}, got ${object[field]}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object: ${label}`);
  }
}

function requireHealthDoesNotExposeFullState(health) {
  const forbiddenFields = [
    "paths",
    "profileSummary",
    "jobs",
    "safeguards",
    "heartbeat",
    "releaseManifest"
  ];
  const exposed = forbiddenFields.filter((field) => Object.hasOwn(health || {}, field));
  if (exposed.length) {
    throw new Error(`Client health endpoint exposed full local state fields: ${exposed.join(", ")}`);
  }
}

function requireProtocolMapMatch(healthProtocols, statusProtocols) {
  for (const field of ["claim", "profile", "adminState", "clientStatus", "heartbeat"]) {
    if (healthProtocols[field] !== statusProtocols[field]) {
      throw new Error(`Client health/status diagnostics protocol mismatch: ${field} health=${healthProtocols[field]} status=${statusProtocols[field]}`);
    }
  }
}

function requireProcessesContract(value) {
  requireObject(value, "processes");
  requireProcessStatus(value.singbox, "processes.singbox", "sing-box");
  requireProcessStatus(value.sync, "processes.sync", "rclone-sync");
  requireObject(value.sync.metrics, "processes.sync.metrics");
  const syncState = value.sync.metrics.syncState;
  if (!["idle", "syncing", "error", "stopping", "offline"].includes(syncState)) {
    throw new Error(`Expected processes.sync.metrics.syncState to be a known state, got ${syncState || "(missing)"}.`);
  }
}

function requireProcessStatus(value, label, expectedName) {
  requireObject(value, label);
  if (value.name !== expectedName) {
    throw new Error(`Expected ${label}.name to be ${expectedName}.`);
  }
  if (typeof value.running !== "boolean") {
    throw new Error(`Expected ${label}.running to be a boolean.`);
  }
  if (value.pid !== null && !Number.isInteger(value.pid)) {
    throw new Error(`Expected ${label}.pid to be null or an integer.`);
  }
  if (value.startedAt !== null && typeof value.startedAt !== "string") {
    throw new Error(`Expected ${label}.startedAt to be null or a string.`);
  }
  if (!value.running && value.pid !== null) {
    throw new Error(`Expected ${label}.pid to be null when not running.`);
  }
}

function requireReleaseManifestContract(value) {
  requireObject(value, "releaseManifest");
  for (const field of ["exists", "ok"]) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`Expected releaseManifest.${field} to be a boolean.`);
    }
  }
  for (const field of ["path", "errorCode", "message"]) {
    if (typeof value[field] !== "string") {
      throw new Error(`Expected releaseManifest.${field} to be a string.`);
    }
  }
  if (!value.exists && value.errorCode !== "release_manifest_missing") {
    throw new Error(`Expected missing releaseManifest to use release_manifest_missing, got ${value.errorCode || "(missing)"}.`);
  }
  requireManifestFileGroup(value.supportDocuments, "releaseManifest.supportDocuments");
  requireManifestFileGroup(value.requiredFiles, "releaseManifest.requiredFiles");
}

function requireManifestFileGroup(value, label) {
  requireObject(value, label);
  if (typeof value.ok !== "boolean") {
    throw new Error(`Expected ${label}.ok to be a boolean.`);
  }
  if (!Array.isArray(value.files)) {
    throw new Error(`Expected ${label}.files to be an array.`);
  }
  for (const [index, file] of value.files.entries()) {
    requireObject(file, `${label}.files[${index}]`);
    for (const field of ["name", "path"]) {
      if (typeof file[field] !== "string") {
        throw new Error(`Expected ${label}.files[${index}].${field} to be a string.`);
      }
    }
    for (const field of ["present", "valid"]) {
      if (typeof file[field] !== "boolean") {
        throw new Error(`Expected ${label}.files[${index}].${field} to be a boolean.`);
      }
    }
  }
}

function pass(name, detail) {
  checks.push({ name, detail });
}

function writeSmokeJsonReport(ok, error) {
  if (!jsonReportPath) {
    return;
  }
  const reportPath = resolve(jsonReportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "client-smoke-report",
    ok,
    context: {
      generatedAt: new Date().toISOString(),
      baseUrl,
      requestTimeoutMs
    },
    summary: {
      passed: checks.length,
      failed: ok ? 0 : 1
    },
    checks,
    failure: ok ? null : {
      check: error?.check || currentCheck,
      message: error?.message || String(error || "unknown error"),
      code: error?.code || "",
      status: error?.status || null
    }
  };
  writeJsonReportSync(reportPath, payload, "client smoke report");
  console.log(`SFSC client smoke JSON report written: ${reportPath}`);
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
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
