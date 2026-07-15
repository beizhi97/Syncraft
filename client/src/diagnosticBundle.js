import { redactLogText } from "./processRunner.js";
import { basename } from "node:path";

const SENSITIVE_KEY_RE = /^(secret|secretAccessKey|secret_access_key|heartbeatSecret|heartbeatAuthNonces|password|privateKey|private_key|authorization|adminToken|token|tKey|claimCode|vlessUri)$/i;
const LOCAL_PATH_KEY_RE = /^(cwd|appRoot|root|dataRoot|binRoot|localPath|rcloneConfigScope|currentFile|heartbeatDeviceCurrentFile)$/i;
const SUPPORT_PRIVATE_KEY_RE = /^(id|userId|deviceId|profileId|server|serverUrl|sourceServer|clientName|profileClientName|accessKeyId|s3AccessKeyId|bucket|bucketName|prefix|remotePrefix|remotePath|serverSubdir|heartbeatDeviceBucket|heartbeatDevicePrefix|endpoint|internalEndpoint|s3Endpoint|storage)$/i;

export function buildDiagnosticBundle(input = {}) {
  const status = input.status || null;
  const environment = input.environment || {};
  const logs = input.logs || {};
  const supportPrivateTerms = collectSupportPrivateTerms({ status, environment });
  const diagnosticStatus = buildDiagnosticStatus(status);
  const bundle = redactDiagnosticObject({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    role: "client",
    generatedAt: input.generatedAt || new Date().toISOString(),
    summary: buildDiagnosticSummary({ status, environment, logs }),
    status: diagnosticStatus,
    environment,
    logs
  });
  return redactSupportPrivateTerms(bundle, supportPrivateTerms);
}

export function buildDiagnosticSummary({ status = null, environment = {}, logs = {} } = {}) {
  const binaries = status?.binaries || {};
  const localState = status?.safeguards?.localState || null;
  const secretVault = status?.safeguards?.secretVault || null;
  const heartbeat = status?.heartbeat || null;
  const successfulHeartbeat = currentSuccessfulHeartbeat(status);
  const heartbeatDevice = successfulHeartbeat?.device || heartbeat?.device || null;
  const heartbeatServerDiagnostics = successfulHeartbeat?.serverDiagnostics || null;
  const heartbeatCompatibility = successfulHeartbeat?.compatibility || null;
  const lastSync = status?.lastSync || null;
  const releaseManifest = environment?.releaseManifest || null;
  const logSummary = summarizeLogs(logs);
  return {
    appVersion: status?.appVersion || status?.clientVersion || status?.diagnostics?.version || "",
    releaseManifestOk: releaseManifest ? Boolean(releaseManifest.ok) : null,
    releaseManifestVersion: releaseManifest?.version || "",
    releaseManifestBuiltAt: releaseManifest?.builtAt || null,
    releaseManifestErrorCode: releaseManifest?.errorCode || "",
    releaseManifestSupportDocsOk: releaseManifest?.supportDocuments ? Boolean(releaseManifest.supportDocuments.ok) : null,
    releaseManifestSupportDocsMissing: Array.isArray(releaseManifest?.supportDocuments?.files)
      ? releaseManifest.supportDocuments.files
        .filter((file) => file && (file.present === false || file.valid === false))
        .map((file) => file.name || file.path || "")
        .filter(Boolean)
      : [],
    releaseManifestRequiredFilesOk: releaseManifest?.requiredFiles ? Boolean(releaseManifest.requiredFiles.ok) : null,
    releaseManifestRequiredFilesMissing: Array.isArray(releaseManifest?.requiredFiles?.files)
      ? releaseManifest.requiredFiles.files
        .filter((file) => file && (file.present === false || file.valid === false))
        .map((file) => file.name || file.path || "")
        .filter(Boolean)
      : [],
    profileImported: Boolean(status?.profileImported),
    profileClientName: status?.profileSummary?.clientName || "",
    serverUrl: heartbeat?.server || status?.profileSummary?.serverUrl || "",
    portableRoot: Boolean(environment?.portableRoot),
    binariesOk: Boolean(binaries?.singbox?.ok && binaries?.rclone?.ok),
    missingBinaries: [binaries?.singbox, binaries?.rclone]
      .filter((binary) => binary && binary.ok === false)
      .map((binary) => ({
        path: binary.path || "",
        errorCode: binary.errorCode || "",
        message: binary.message || ""
      })),
    localStateOk: localState ? Boolean(localState.ok) : null,
    localStateErrors: Array.isArray(localState?.files)
      ? localState.files
        .filter((file) => file && file.ok === false)
        .map((file) => ({ name: file.name || "", errorCode: file.errorCode || "", message: file.message || "" }))
      : [],
    secretVaultOk: secretVault ? Boolean(secretVault.ok) : null,
    missingSecretRefs: Array.isArray(secretVault?.missingRefs) ? secretVault.missingRefs.length : 0,
    heartbeatOk: heartbeat ? Boolean(heartbeat.ok) : null,
    heartbeatErrorCode: heartbeat?.errorCode || "",
    heartbeatRemoteErrorCode: heartbeat?.remoteErrorCode || "",
    heartbeatDeviceStatus: heartbeatDevice?.status || "",
    heartbeatDeviceEnabled: heartbeatDevice ? Boolean(heartbeatDevice.enabled) : null,
    heartbeatDeviceOnline: heartbeatDevice ? Boolean(heartbeatDevice.online) : null,
    heartbeatDeviceBucket: heartbeatDevice?.bucket || "",
    heartbeatDevicePrefix: heartbeatDevice?.prefix || "",
    heartbeatDeviceCurrentFile: heartbeatDevice?.sync?.currentFile || heartbeatDevice?.sync?.lastRun?.currentFile || "",
    heartbeatServerProtocols: heartbeatServerDiagnostics?.protocols || null,
    heartbeatCompatibilityStatus: heartbeatCompatibility?.status || "",
    heartbeatCompatibilityAction: heartbeatCompatibility?.action || "",
    heartbeatCompatibilitySeverity: heartbeatCompatibility?.severity || "",
    heartbeatCompatibilitySyncRunPolicy: heartbeatCompatibility?.policy?.syncRun || "",
    lastSyncStatus: lastSync?.status || "",
    lastSyncErrorCode: lastSync?.errorCode || "",
    conflictCount: Number(lastSync?.conflicts?.count || 0),
    logsMissing: logSummary.missing,
    logsTruncated: logSummary.truncated
  };
}

function currentSuccessfulHeartbeat(status = null) {
  if (status?.heartbeat?.ok) {
    return status.heartbeat;
  }
  if (status?.lastSuccessfulHeartbeat?.ok) {
    return status.lastSuccessfulHeartbeat;
  }
  return null;
}

function summarizeLogs(logs = {}) {
  const entries = Object.entries(logs || {});
  return {
    missing: entries.filter(([, log]) => log && log.exists === false).map(([name]) => name),
    truncated: entries.filter(([, log]) => log && log.truncated === true).map(([name]) => name)
  };
}

function buildDiagnosticStatus(status = null) {
  const input = status && typeof status === "object" ? status : {};
  return {
    diagnostics: input.diagnostics || null,
    appVersion: stringField(input.appVersion || input.clientVersion || input.diagnostics?.version),
    profileImported: Boolean(input.profileImported),
    profileSummary: summarizeDiagnosticProfileSummary(input.profileSummary),
    binaries: summarizeDiagnosticBinaries(input.binaries),
    heartbeat: summarizeDiagnosticHeartbeat(input.heartbeat),
    lastSuccessfulHeartbeat: summarizeDiagnosticHeartbeat(input.lastSuccessfulHeartbeat),
    safeguards: {
      localState: summarizeDiagnosticLocalState(input.safeguards?.localState),
      secretVault: summarizeDiagnosticSecretVault(input.safeguards?.secretVault)
    },
    lastSync: summarizeDiagnosticSyncRun(input.lastSync),
    jobs: Array.isArray(input.jobs) ? input.jobs.map(summarizeDiagnosticJob) : []
  };
}

function summarizeDiagnosticProfileSummary(summary = null) {
  return {
    clientName: stringField(summary?.clientName),
    serverUrl: stringField(summary?.serverUrl || summary?.server),
    storage: stringField(summary?.storage),
    localProxyPort: numberOrNull(summary?.localProxyPort)
  };
}

function summarizeDiagnosticBinaries(binaries = null) {
  return {
    singbox: summarizeDiagnosticBinary(binaries?.singbox),
    rclone: summarizeDiagnosticBinary(binaries?.rclone)
  };
}

function summarizeDiagnosticBinary(binary = null) {
  return {
    path: stringField(binary?.path),
    exists: Boolean(binary?.exists),
    ok: Boolean(binary?.ok),
    errorCode: stringField(binary?.errorCode),
    message: stringField(binary?.message)
  };
}

function summarizeDiagnosticHeartbeat(heartbeat = null) {
  if (!heartbeat || typeof heartbeat !== "object") {
    return null;
  }
  return {
    ok: Boolean(heartbeat.ok),
    server: stringField(heartbeat.server),
    sentAt: stringField(heartbeat.sentAt),
    status: numberOrNull(heartbeat.status),
    errorCode: stringField(heartbeat.errorCode),
    remoteErrorCode: stringField(heartbeat.remoteErrorCode),
    serverDiagnostics: heartbeat.serverDiagnostics || null,
    compatibility: summarizeDiagnosticCompatibility(heartbeat.compatibility),
    device: summarizeDiagnosticHeartbeatDevice(heartbeat.device)
  };
}

function summarizeDiagnosticCompatibility(compatibility = null) {
  if (!compatibility || typeof compatibility !== "object") {
    return null;
  }
  return {
    ok: Boolean(compatibility.ok),
    status: stringField(compatibility.status),
    action: stringField(compatibility.action),
    severity: stringField(compatibility.severity),
    policy: {
      heartbeat: stringField(compatibility.policy?.heartbeat),
      profileIssue: stringField(compatibility.policy?.profileIssue),
      syncRun: stringField(compatibility.policy?.syncRun),
      adminActions: stringField(compatibility.policy?.adminActions),
      reason: stringField(compatibility.policy?.reason)
    },
    localRole: stringField(compatibility.localRole),
    remoteRole: stringField(compatibility.remoteRole),
    issues: Array.isArray(compatibility.issues)
      ? compatibility.issues.map((issue) => ({
        field: stringField(issue?.field),
        type: stringField(issue?.type),
        local: numberOrNull(issue?.local),
        remote: numberOrNull(issue?.remote),
        message: stringField(issue?.message)
      }))
      : []
  };
}

function summarizeDiagnosticHeartbeatDevice(device = null) {
  if (!device || typeof device !== "object") {
    return null;
  }
  return {
    status: stringField(device.status),
    enabled: Boolean(device.enabled),
    online: Boolean(device.online),
    bucket: stringField(device.bucket),
    prefix: stringField(device.prefix),
    sync: summarizeDiagnosticDeviceSync(device.sync)
  };
}

function summarizeDiagnosticDeviceSync(sync = null) {
  if (!sync || typeof sync !== "object") {
    return null;
  }
  return {
    state: stringField(sync.state || sync.syncState),
    syncState: stringField(sync.syncState || sync.state),
    speedMbps: numberOrNull(sync.speedMbps),
    currentFile: stringField(sync.currentFile),
    lastRun: summarizeDiagnosticSyncRun(sync.lastRun),
    scheduler: summarizeDiagnosticScheduler(sync.scheduler)
  };
}

function summarizeDiagnosticScheduler(scheduler = null) {
  if (!scheduler || typeof scheduler !== "object") {
    return null;
  }
  return {
    enabled: Boolean(scheduler.enabled),
    intervalMs: numberOrZero(scheduler.intervalMs),
    nextRun: stringField(scheduler.nextRun),
    lastTriggeredAt: stringField(scheduler.lastTriggeredAt),
    lastError: stringField(scheduler.lastError),
    jobs: Array.isArray(scheduler.jobs) ? scheduler.jobs.map(summarizeDiagnosticSchedulerJob) : []
  };
}

function summarizeDiagnosticSchedulerJob(job = null) {
  return {
    id: stringField(job?.id),
    name: stringField(job?.name),
    schedule: summarizeDiagnosticSchedule(job?.schedule) || {},
    scheduleText: stringField(job?.scheduleText),
    nextRun: stringField(job?.nextRun),
    lastTriggeredAt: stringField(job?.lastTriggeredAt),
    lastError: stringField(job?.lastError)
  };
}

function summarizeDiagnosticLocalState(localState = null) {
  if (!localState || typeof localState !== "object") {
    return null;
  }
  return {
    ok: Boolean(localState.ok),
    files: Array.isArray(localState.files)
      ? localState.files.map((file) => ({
        name: stringField(file?.name),
        exists: Boolean(file?.exists),
        ok: Boolean(file?.ok),
        errorCode: stringField(file?.errorCode),
        message: stringField(file?.message)
      }))
      : []
  };
}

function summarizeDiagnosticSecretVault(secretVault = null) {
  if (!secretVault || typeof secretVault !== "object") {
    return null;
  }
  return {
    backend: stringField(secretVault.backend),
    path: stringField(secretVault.path),
    ok: Boolean(secretVault.ok),
    protected: Boolean(secretVault.protected),
    protection: {
      protected: Boolean(secretVault.protection?.protected),
      mode: stringField(secretVault.protection?.mode),
      exists: Boolean(secretVault.protection?.exists)
    },
    refs: numberOrNull(secretVault.refs),
    missingRefs: Array.isArray(secretVault.missingRefs) ? secretVault.missingRefs.map(stringField) : []
  };
}

function summarizeDiagnosticSyncRun(run = null) {
  if (!run || typeof run !== "object") {
    return null;
  }
  return {
    id: stringField(run.id),
    status: stringField(run.status),
    trigger: stringField(run.trigger),
    startedAt: stringField(run.startedAt),
    finishedAt: stringField(run.finishedAt),
    localPath: stringField(run.localPath),
    errorCode: stringField(run.errorCode),
    error: stringField(run.error),
    speedMbps: numberOrNull(run.speedMbps),
    rawSpeed: stringField(run.rawSpeed),
    currentFile: stringField(run.currentFile),
    conflicts: summarizeDiagnosticConflicts(run.conflicts)
  };
}

function summarizeDiagnosticConflicts(conflicts = null) {
  return {
    count: Number(conflicts?.count || 0),
    files: Array.isArray(conflicts?.files) ? conflicts.files.map(stringField) : [],
    truncated: Boolean(conflicts?.truncated)
  };
}

function summarizeDiagnosticJob(job = null) {
  return {
    id: stringField(job?.id),
    name: stringField(job?.name),
    localPath: stringField(job?.localPath),
    direction: stringField(job?.direction),
    remoteFolder: stringField(job?.remoteFolder),
    serverSpace: stringField(job?.serverSpace),
    dryRun: Boolean(job?.dryRun),
    destructiveSync: Boolean(job?.destructiveSync),
    bandwidthLimit: stringField(job?.bandwidthLimit),
    schedule: summarizeDiagnosticSchedule(job?.schedule),
    localProxyPort: numberOrNull(job?.localProxyPort),
    transfers: numberOrNull(job?.transfers),
    streams: numberOrNull(job?.streams),
    checkers: numberOrNull(job?.checkers),
    s3UploadConcurrency: numberOrNull(job?.s3UploadConcurrency),
    s3ChunkSize: stringField(job?.s3ChunkSize),
    chunkSize: stringField(job?.chunkSize),
    cutoff: stringField(job?.cutoff),
    retries: numberOrNull(job?.retries),
    lowLevelRetries: numberOrNull(job?.lowLevelRetries),
    clientName: stringField(job?.clientName),
    remoteName: stringField(job?.remoteName),
    bucketName: stringField(job?.bucketName),
    remotePrefix: stringField(job?.remotePrefix),
    s3Endpoint: stringField(job?.s3Endpoint)
  };
}

function summarizeDiagnosticSchedule(schedule = null) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return null;
  }
  return {
    mode: stringField(schedule.mode),
    intervalMinutes: numberOrNull(schedule.intervalMinutes),
    timeOfDay: stringField(schedule.timeOfDay)
  };
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function redactDiagnosticObject(value) {
  if (Array.isArray(value)) {
    return value.map(redactDiagnosticObject);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactDiagnosticField(key, item)
    ]));
  }
  if (typeof value === "string") {
    return redactLocalText(redactLogText(value));
  }
  return value;
}

function redactDiagnosticField(key, value) {
  if (SENSITIVE_KEY_RE.test(key)) {
    return maskValue(value);
  }
  if (SUPPORT_PRIVATE_KEY_RE.test(key)) {
    return redactSupportPrivateValue(value);
  }
  if (key === "path") {
    return typeof value === "string" && value ? basename(value) : value;
  }
  if (LOCAL_PATH_KEY_RE.test(key)) {
    return typeof value === "string" && value ? "redacted" : value;
  }
  if (key === "missingRefs" && Array.isArray(value)) {
    return Array.from({ length: value.length }, () => "redacted");
  }
  if (key === "conflicts" && value && typeof value === "object" && !Array.isArray(value)) {
    const redacted = redactDiagnosticObject(value);
    if (Array.isArray(redacted.files)) {
      redacted.files = Array.from({ length: redacted.files.length }, () => "redacted");
    }
    return redacted;
  }
  return redactDiagnosticObject(value);
}

function redactLocalText(text) {
  return String(text || "")
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g, "[local-path]")
    .replace(/\/(?:Users|home|tmp|var|opt|Volumes)\/[^\s"'<>]*/g, "[local-path]");
}

function maskValue(value) {
  if (value === null || value === undefined || value === "") {
    return value;
  }
  return "****";
}

function redactSupportPrivateValue(value) {
  if (value === null || value === undefined || value === "") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactSupportPrivateValue);
  }
  return "redacted";
}

function collectSupportPrivateTerms(value, key = "", terms = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSupportPrivateTerms(item, key, terms);
    }
    return terms;
  }
  if (value && typeof value === "object") {
    if (SUPPORT_PRIVATE_KEY_RE.test(key)) {
      collectAllStringTerms(value, terms);
      return terms;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      collectSupportPrivateTerms(childValue, childKey, terms);
    }
    return terms;
  }
  if (typeof value === "string" && SUPPORT_PRIVATE_KEY_RE.test(key)) {
    addSupportPrivateTerm(terms, value);
  }
  return terms;
}

function collectAllStringTerms(value, terms) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllStringTerms(item, terms);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectAllStringTerms(item, terms);
    }
    return;
  }
  if (typeof value === "string") {
    addSupportPrivateTerm(terms, value);
  }
}

function addSupportPrivateTerm(terms, value) {
  const text = String(value || "").trim();
  if (text.length >= 3 && text !== "redacted" && text !== "****") {
    terms.add(text);
  }
}

function redactSupportPrivateTerms(value, terms) {
  if (!terms?.size) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSupportPrivateTerms(item, terms));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactSupportPrivateTerms(item, terms)
    ]));
  }
  if (typeof value !== "string" || !value) {
    return value;
  }
  let text = value;
  for (const term of terms) {
    text = text.replace(new RegExp(escapeRegExp(term), "g"), "redacted");
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
