import { normalizeSchedule } from "./scheduler.js";

export function normalizeDeviceSync(input = {}, existing = null, now = new Date().toISOString()) {
  const hasSyncFields = Boolean(
    input.syncState ||
    input.state ||
    input.bytesPerSecond !== undefined ||
    input.speedMbps !== undefined ||
    input.rawSpeed ||
    input.progressPercent !== undefined ||
    input.currentFile ||
    input.currentJob ||
    input.lastRun ||
    input.scheduler ||
    input.lastSyncAt ||
    input.lastExit
  );
  if (!hasSyncFields && !existing) {
    return null;
  }

  const bytesPerSecond = readNonNegativeNumber(input.bytesPerSecond, existing?.bytesPerSecond || 0);
  const speedMbps = readNonNegativeNumber(
    input.speedMbps,
    bytesPerSecond ? bytesToMbps(bytesPerSecond) : existing?.speedMbps || 0
  );
  const currentJob = safeNormalizeHeartbeatJob(input.currentJob || existing?.currentJob || null);
  const lastRun = safeNormalizeSyncRun(input.lastRun || existing?.lastRun || null);

  return {
    state: normalizeSyncState(input.syncState || input.state || existing?.state || "idle"),
    bytesPerSecond,
    speedMbps,
    rawSpeed: input.rawSpeed ? cleanShortText(input.rawSpeed, 64) : existing?.rawSpeed || "",
    progressPercent: normalizePercent(input.progressPercent, existing?.progressPercent ?? null),
    currentFile: input.currentFile ? cleanShortText(input.currentFile, 160) : existing?.currentFile || "",
    currentJob,
    lastRun,
    conflicts: normalizeDirectionalConflictSummary(
      currentJob?.direction || lastRun?.job?.direction,
      input.conflicts || existing?.conflicts || null
    ),
    scheduler: normalizeSyncScheduler(input.scheduler || existing?.scheduler || null),
    startedAt: normalizeOptionalIso(input.startedAt) || existing?.startedAt || null,
    lastSyncAt: normalizeOptionalIso(input.lastSyncAt) || existing?.lastSyncAt || null,
    finishedAt: normalizeOptionalIso(input.finishedAt) || existing?.finishedAt || null,
    lastExit: normalizeLastExit(input.lastExit || existing?.lastExit || null),
    updatedAt: now
  };
}

function safeNormalizeSyncRun(input) {
  try {
    return normalizeSyncRun(input);
  } catch {
    if (!input || typeof input !== "object") {
      return null;
    }
    return normalizeSyncRun({
      ...input,
      job: clearHeartbeatJobPaths(input.job || input.currentJob)
    });
  }
}

function safeNormalizeHeartbeatJob(input) {
  try {
    return normalizeHeartbeatJob(input);
  } catch {
    return normalizeHeartbeatJob(clearHeartbeatJobPaths(input));
  }
}

function clearHeartbeatJobPaths(input) {
  if (!input || typeof input !== "object") {
    return input;
  }
  return {
    ...input,
    remotePrefix: "",
    remoteFolder: ""
  };
}

export function summarizeDeviceSync(input, online) {
  if (!input) {
    return {
      state: online ? "idle" : "offline",
      bytesPerSecond: 0,
      speedMbps: 0,
      rawSpeed: "",
      progressPercent: null,
      currentFile: "",
      currentJob: null,
      lastRun: null,
      conflicts: {
        count: 0,
        files: [],
        truncated: false
      },
      scheduler: null,
      startedAt: null,
      lastSyncAt: null,
      finishedAt: null,
      lastExit: null,
      updatedAt: null
    };
  }

  const normalized = normalizeDeviceSync(input, null, input.updatedAt || null);
  const state = online ? normalizeSyncState(normalized?.state || "idle") : "offline";
  const running = state === "syncing";
  return {
    ...normalized,
    state,
    bytesPerSecond: running ? readNonNegativeNumber(normalized?.bytesPerSecond, 0) : 0,
    speedMbps: running ? readNonNegativeNumber(normalized?.speedMbps, 0) : 0
  };
}

export function normalizeSyncRun(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const status = normalizeSyncRunStatus(input.status);
  const errorCode = status === "error" ? normalizeErrorCode(input.errorCode) : "";
  const job = normalizeHeartbeatJob(input.job || input.currentJob || null);
  return {
    id: cleanShortText(input.id || "", 80),
    status,
    trigger: normalizeSyncRunTrigger(input.trigger),
    startedAt: normalizeOptionalIso(input.startedAt),
    finishedAt: normalizeOptionalIso(input.finishedAt),
    job,
    localPath: input.localPath ? cleanShortText(input.localPath, 240) : "",
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
    errorCode,
    error: errorCode && input.error ? cleanShortText(input.error, 160) : "",
    progressPercent: normalizePercent(input.progressPercent, null),
    transferredSizeText: input.transferredSizeText ? cleanShortText(input.transferredSizeText, 80) : "",
    currentFile: input.currentFile ? cleanShortText(input.currentFile, 160) : "",
    rawSpeed: input.rawSpeed ? cleanShortText(input.rawSpeed, 64) : "",
    speedMbps: readNonNegativeNumber(input.speedMbps, 0),
    conflicts: normalizeDirectionalConflictSummary(
      job?.direction,
      input.conflicts || input.conflictSummary || {
        count: input.conflictCount,
        files: input.conflictFiles
      }
    )
  };
}

export function normalizeSyncRunStatus(input) {
  const value = String(input || "unknown").trim().toLowerCase();
  if (["running", "success", "error", "stopped", "unknown"].includes(value)) {
    return value;
  }
  return "unknown";
}

function normalizeSyncRunTrigger(input) {
  const value = String(input || "manual").trim().toLowerCase();
  if (["manual", "scheduler"].includes(value)) {
    return value;
  }
  return "manual";
}

export function normalizeSyncState(input) {
  const value = String(input || "idle").trim().toLowerCase();
  if (["syncing", "idle", "error", "stopping", "offline"].includes(value)) {
    return value;
  }
  return "idle";
}

export function normalizeHeartbeatJob(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    name: cleanShortText(input.name || "folder-sync", 80),
    direction: cleanShortText(input.direction || "upload", 24),
    bucketName: input.bucketName ? cleanShortText(input.bucketName, 80) : "",
    remotePrefix: input.remotePrefix ? cleanPrefix(input.remotePrefix) : "",
    remoteFolder: input.remoteFolder ? cleanPrefix(input.remoteFolder) : "",
    serverSpace: cleanShortText(input.serverSpace || "device", 24)
  };
}

function normalizeLastExit(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    ok: input.ok !== false,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
    errorCode: normalizeErrorCode(input.errorCode),
    error: input.error ? cleanShortText(input.error, 160) : "",
    at: normalizeOptionalIso(input.at)
  };
}

function normalizeConflictSummary(input) {
  if (!input || typeof input !== "object") {
    return {
      count: 0,
      files: [],
      truncated: false
    };
  }
  const files = Array.isArray(input.files)
    ? [...new Set(input.files.map(cleanConflictFile).filter(Boolean))].slice(0, 10)
    : [];
  const count = Math.max(0, Math.floor(readNonNegativeNumber(input.count, files.length)));
  return {
    count: Math.max(count, files.length),
    files,
    truncated: Boolean(input.truncated || count > files.length)
  };
}

function normalizeDirectionalConflictSummary(direction, input) {
  if (String(direction || "").trim().toLowerCase() !== "bidirectional") {
    return normalizeConflictSummary(null);
  }
  return normalizeConflictSummary(input);
}

function normalizeSyncScheduler(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    enabled: input.enabled !== false,
    intervalMs: Math.floor(readNonNegativeNumber(input.intervalMs, 0)),
    nextRun: normalizeScheduleRun(input.nextRun),
    lastTriggeredAt: normalizeOptionalIso(input.lastTriggeredAt),
    lastError: normalizeErrorCode(input.lastError),
    jobs: Array.isArray(input.jobs)
      ? input.jobs.map(normalizeScheduledJob).filter(Boolean).slice(0, 10)
      : []
  };
}

function normalizeScheduledJob(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    id: cleanShortText(input.id || "", 80),
    name: cleanShortText(input.name || "folder-sync", 80),
    schedule: normalizeScheduledJobSchedule(input.schedule),
    scheduleText: cleanShortText(input.scheduleText || "", 80),
    nextRun: normalizeScheduleRun(input.nextRun),
    lastTriggeredAt: normalizeOptionalIso(input.lastTriggeredAt),
    lastError: normalizeErrorCode(input.lastError)
  };
}

function normalizeScheduledJobSchedule(input) {
  if (!input || typeof input !== "object") {
    return { mode: "manual" };
  }
  try {
    return normalizeSchedule(input);
  } catch {
    return { mode: "manual" };
  }
}

function normalizeScheduleRun(input) {
  if (input === "on-startup") {
    return "on-startup";
  }
  return normalizeOptionalIso(input);
}

function normalizeErrorCode(input) {
  const value = String(input || "").trim();
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) ? value : "";
}

function cleanConflictFile(input) {
  return cleanShortText(String(input || "").replace(/\\/g, "/"), 180);
}

function normalizePercent(input, fallback) {
  if (input === null) {
    return null;
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, value));
}

function normalizeOptionalIso(input) {
  if (!input) {
    return null;
  }
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readNonNegativeNumber(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function bytesToMbps(bytesPerSecond) {
  return Number(((Number(bytesPerSecond || 0) * 8) / 1_000_000).toFixed(2));
}

function cleanShortText(input, maxLength) {
  return String(input || "").trim().slice(0, maxLength);
}

function cleanPrefix(input) {
  const text = String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!text || /^[A-Za-z]:/.test(text)) {
    throw new Error("Storage prefix must be relative");
  }
  for (const part of text.split("/")) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001F]/.test(part)) {
      throw new Error("Storage prefix contains an invalid segment");
    }
  }
  return text;
}
