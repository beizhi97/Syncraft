import {
  ADMIN_STATE_VERSION,
  APP_ID,
  RUNTIME_PROTOCOL_FIELDS,
  compareRuntimeDiagnostics,
  normalizeRuntimeDiagnostics
} from "../../src/core/diagnostics.js";
import { PROFILE_VERSION } from "../../src/core/profileProtocol.js";

const SYNC_STATES = ["idle", "syncing", "error", "stopping", "offline"];
const DEVICE_STATUSES = ["online", "offline"];
const ADMIN_TUNNEL_PROTOCOLS = ["vless-tcp-none", "vless-reality-tcp", "vless-ws-tls"];
const ADMIN_TUNNEL_SECURITY = ["none", "reality", "tls"];
const ADMIN_USER_SUMMARY_KEYS = ["id", "clientName", "uuid", "enabled", "createdAt", "updatedAt", "storage", "vlessUriAvailable", "vlessUriRevealPath"];
const ADMIN_USER_STORAGE_KEYS = ["accessKeyId", "secretAccessKey", "bucket", "prefix"];
const DIAGNOSTIC_LOG_NAMES = ["electron", "singbox", "rclone"];
const COMPATIBILITY_STATUSES = ["compatible", "mismatch"];
const COMPATIBILITY_ACTIONS = ["diagnostics_missing", "manual_check", "none", "upgrade_local", "upgrade_remote"];
const COMPATIBILITY_SEVERITIES = ["ok", "warning"];
const COMPATIBILITY_POLICY_VALUES = ["allow", "warn"];
const COMPATIBILITY_ISSUE_FIELDS = ["adminState", "claim", "clientStatus", "heartbeat", "profile"];
const COMPATIBILITY_ISSUE_TYPES = ["local_missing", "remote_missing", "remote_newer", "remote_older"];

export function assertRuntimeDiagnosticsContract(diagnostics, role, label = "diagnostics") {
  assertObject(diagnostics, label);
  assertExactKeys(diagnostics, ["app", "buildId", "buildTime", "protocols", "role", "version"], label);
  assertEqual(diagnostics.app, APP_ID, `${label}.app`);
  assertEqual(diagnostics.role, role, `${label}.role`);
  assertNonEmptyString(diagnostics.version, `${label}.version`);
  assertEqual(typeof diagnostics.buildId, "string", `${label}.buildId`);
  assertNullableString(diagnostics.buildTime, `${label}.buildTime`);
  assertObject(diagnostics.protocols, `${label}.protocols`);
  assertExactKeys(diagnostics.protocols, RUNTIME_PROTOCOL_FIELDS, `${label}.protocols`);
  for (const field of RUNTIME_PROTOCOL_FIELDS) {
    assert(Number.isInteger(diagnostics.protocols[field]), `${label}.protocols.${field}`);
    assert(diagnostics.protocols[field] >= 1, `${label}.protocols.${field}`);
  }
  assert(normalizeRuntimeDiagnostics(diagnostics, role) !== null, label);
}

export function assertClientStatusContract(status, label = "clientStatus", options = {}) {
  assertObject(status, label);
  assertExactKeys(status, [
    "appVersion",
    "binaries",
    "clientVersion",
    "diagnostics",
    "heartbeat",
    "jobs",
    "lastSuccessfulHeartbeat",
    "lastSync",
    "mode",
    "ok",
    "paths",
    "processes",
    "profileImported",
    "profileSummary",
    "releaseManifest",
    "safeguards",
    "scheduler",
    "syncHistory"
  ], label);
  assertEqual(status.ok, true, `${label}.ok`);
  assertEqual(status.mode, "client-exe-runtime", `${label}.mode`);
  assertNonEmptyString(status.appVersion, `${label}.appVersion`);
  assertNonEmptyString(status.clientVersion, `${label}.clientVersion`);
  assertEqual(status.clientVersion, status.appVersion, `${label}.clientVersion`);
  assertRuntimeDiagnosticsContract(status.diagnostics, "client", `${label}.diagnostics`);
  assertEqual(status.diagnostics.version, status.clientVersion, `${label}.diagnostics.version`);
  assertReleaseManifestSummaryContract(status.releaseManifest, `${label}.releaseManifest`);
  assertObject(status.paths, `${label}.paths`);
  assertExactKeys(status.paths, ["binRoot", "dataRoot", "root"], `${label}.paths`);
  for (const field of ["binRoot", "dataRoot", "root"]) {
    assertNonEmptyString(status.paths[field], `${label}.paths.${field}`);
  }
  assertEqual(typeof status.profileImported, "boolean", `${label}.profileImported`);
  if (status.profileImported) {
    assertClientProfileSummaryContract(status.profileSummary, `${label}.profileSummary`);
  } else {
    assertEqual(status.profileSummary, null, `${label}.profileSummary`);
  }

  assertObject(status.safeguards, `${label}.safeguards`);
  assertExactKeys(status.safeguards, ["dnsMutation", "localState", "rcloneConfigScope", "routeMutation", "secretVault", "systemProxy", "tun"], `${label}.safeguards`);
  for (const field of ["tun", "systemProxy", "routeMutation", "dnsMutation"]) {
    assertEqual(status.safeguards[field], false, `${label}.safeguards.${field}`);
  }
  assertEqual(typeof status.safeguards.rcloneConfigScope, "string", `${label}.safeguards.rcloneConfigScope`);
  assertMatch(status.safeguards.rcloneConfigScope, /rclone\.conf$/, `${label}.safeguards.rcloneConfigScope`);
  assertObject(status.safeguards.localState, `${label}.safeguards.localState`);
  assertEqual(typeof status.safeguards.localState.ok, "boolean", `${label}.safeguards.localState.ok`);
  assertArray(status.safeguards.localState.files, `${label}.safeguards.localState.files`);
  assertDeepEqual(
    status.safeguards.localState.files.map((file) => file.name).sort(),
    ["claimRecovery", "jobs", "lastSuccessfulHeartbeat", "profile", "secrets", "syncHistory"],
    `${label}.safeguards.localState.files`
  );
  for (const file of status.safeguards.localState.files) {
    const fileLabel = `${label}.safeguards.localState.files.${file.name}`;
    assertEqual(typeof file.exists, "boolean", `${fileLabel}.exists`);
    assertEqual(typeof file.ok, "boolean", `${fileLabel}.ok`);
    if (file.ok === false) {
      assertEqual(file.errorCode, "local_state_corrupt", `${fileLabel}.errorCode`);
    }
  }
  assertObject(status.safeguards.secretVault, `${label}.safeguards.secretVault`);
  assertExactKeys(status.safeguards.secretVault, ["backend", "missingRefs", "ok", "path", "protected", "protection", "refs"], `${label}.safeguards.secretVault`);
  assertEqual(typeof status.safeguards.secretVault.ok, "boolean", `${label}.safeguards.secretVault.ok`);
  assertEqual(typeof status.safeguards.secretVault.protected, "boolean", `${label}.safeguards.secretVault.protected`);
  assertObject(status.safeguards.secretVault.protection, `${label}.safeguards.secretVault.protection`);
  assertEqual(status.safeguards.secretVault.protection.protected, status.safeguards.secretVault.protected, `${label}.safeguards.secretVault.protection.protected`);
  assertEqual(typeof status.safeguards.secretVault.protection.mode, "string", `${label}.safeguards.secretVault.protection.mode`);
  assertArray(status.safeguards.secretVault.missingRefs, `${label}.safeguards.secretVault.missingRefs`);
  assertArray(status.jobs, `${label}.jobs`);
  for (const [index, job] of status.jobs.entries()) {
    assertClientJobSummaryContract(job, `${label}.jobs[${index}]`);
  }
  assertClientSyncHistoryContract({ history: status.syncHistory }, `${label}.syncHistory`);
  if (status.syncHistory.length === 0) {
    assertEqual(status.lastSync, null, `${label}.lastSync`);
  } else {
    assertDeepEqual(status.lastSync, status.syncHistory[0], `${label}.lastSync`);
  }
  assertSchedulerContract(status.scheduler, `${label}.scheduler`);
  assertClientBinariesPresenceContract(status.binaries, `${label}.binaries`);
  assertObject(status.processes, `${label}.processes`);
  assertExactKeys(status.processes, ["singbox", "sync"], `${label}.processes`);
  assertClientProcessStatusContract(status.processes.singbox, `${label}.processes.singbox`, "sing-box", {
    exactKeys: ["lastExit", "name", "pid", "running", "startedAt"]
  });
  assertClientProcessStatusContract(status.processes.sync, `${label}.processes.sync`, "rclone-sync", {
    exactKeys: ["lastExit", "metrics", "name", "pid", "running", "startedAt"]
  });
  assertObject(status.processes.sync.metrics, `${label}.processes.sync.metrics`);
  assert(SYNC_STATES.includes(status.processes.sync.metrics.syncState), `${label}.processes.sync.metrics.syncState`);
  assertFiniteNumber(status.processes.sync.metrics.speedMbps, `${label}.processes.sync.metrics.speedMbps`);
  assertFiniteNumber(status.processes.sync.metrics.bytesPerSecond, `${label}.processes.sync.metrics.bytesPerSecond`);
  assertNullableNumber(status.processes.sync.metrics.progressPercent, `${label}.processes.sync.metrics.progressPercent`);
  assertEqual(typeof status.processes.sync.metrics.currentFile, "string", `${label}.processes.sync.metrics.currentFile`);
  if (status.heartbeat !== null) {
    assertHeartbeatContract(status.heartbeat, `${label}.heartbeat`);
  }
  if (status.lastSuccessfulHeartbeat !== null) {
    assertHeartbeatContract(status.lastSuccessfulHeartbeat, `${label}.lastSuccessfulHeartbeat`);
    assertEqual(status.lastSuccessfulHeartbeat.ok, true, `${label}.lastSuccessfulHeartbeat.ok`);
  }
  assertNoRawDiagnosticSecrets(status, label, options);
}

export function assertClientHealthContract(response, label = "clientHealth") {
  assertObject(response, label);
  assertExactKeys(response, ["clientVersion", "diagnostics", "mode", "ok", "version"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertEqual(response.mode, "client-exe-runtime", `${label}.mode`);
  assertNonEmptyString(response.version, `${label}.version`);
  assertEqual(response.clientVersion, response.version, `${label}.clientVersion`);
  assertRuntimeDiagnosticsContract(response.diagnostics, "client", `${label}.diagnostics`);
  assertEqual(response.diagnostics.version, response.clientVersion, `${label}.diagnostics.version`);
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertClientShutdownResponseContract(response, label = "clientShutdown") {
  assertObject(response, label);
  assertExactKeys(response, ["ok"], label);
  assertEqual(response.ok, true, `${label}.ok`);
}

export function assertHttpErrorResponseContract(response, label = "httpError", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["error", "errorCode", "message", "ok"], label);
  assertEqual(response.ok, false, `${label}.ok`);
  assertStableErrorCode(response.errorCode, `${label}.errorCode`);
  assert(response.errorCode !== "", `${label}.errorCode`);
  assertEqual(response.error, response.errorCode, `${label}.error`);
  assertNonEmptyString(response.message, `${label}.message`);
  if (options.errorCode !== undefined) {
    assertEqual(response.errorCode, options.errorCode, `${label}.errorCode`);
  }
  if (options.message !== undefined) {
    assertEqual(response.message, options.message, `${label}.message`);
  }
}

export function assertServerHealthResponseContract(response, label = "serverHealth") {
  assertObject(response, label);
  assertExactKeys(response, [
    "adminAuth",
    "app",
    "architecture",
    "diagnostics",
    "mode",
    "ok",
    "pathsConfigured",
    "safeguards",
    "serviceHealth",
    "version"
  ], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertEqual(response.app, "singbox-folder-sync", `${label}.app`);
  assertNonEmptyString(response.version, `${label}.version`);
  assertEqual(response.mode, "server-admin", `${label}.mode`);
  assertRuntimeDiagnosticsContract(response.diagnostics, "server", `${label}.diagnostics`);
  assertEqual(response.diagnostics.version, response.version, `${label}.diagnostics.version`);
  assertObject(response.pathsConfigured, `${label}.pathsConfigured`);
  assertExactKeys(response.pathsConfigured, ["serverDataRoot", "singboxConfigPath"], `${label}.pathsConfigured`);
  assertEqual(typeof response.pathsConfigured.serverDataRoot, "boolean", `${label}.pathsConfigured.serverDataRoot`);
  assertEqual(typeof response.pathsConfigured.singboxConfigPath, "boolean", `${label}.pathsConfigured.singboxConfigPath`);

  assertObject(response.architecture, `${label}.architecture`);
  assertExactKeys(response.architecture, ["clientKernel", "serverServices", "storageBackend", "syncEngine"], `${label}.architecture`);
  assertArray(response.architecture.serverServices, `${label}.architecture.serverServices`);
  assert(response.architecture.serverServices.includes("sync-server"), `${label}.architecture.serverServices`);
  assert(response.architecture.serverServices.includes("sing-box"), `${label}.architecture.serverServices`);
  assert(response.architecture.serverServices.includes("minio"), `${label}.architecture.serverServices`);
  assertEqual(response.architecture.clientKernel, "sing-box", `${label}.architecture.clientKernel`);
  assertEqual(response.architecture.syncEngine, "rclone", `${label}.architecture.syncEngine`);
  assertNonEmptyString(response.architecture.storageBackend, `${label}.architecture.storageBackend`);

  assertObject(response.safeguards, `${label}.safeguards`);
  assertExactKeys(response.safeguards, ["muxDefault", "routeMutation", "systemProxy", "tun"], `${label}.safeguards`);
  for (const field of ["tun", "systemProxy", "routeMutation", "muxDefault"]) {
    assertEqual(response.safeguards[field], false, `${label}.safeguards.${field}`);
  }

  assertAdminAuthCheckSummaryContract(response.adminAuth, `${label}.adminAuth`);
  assertServerServiceHealthContract(response.serviceHealth, `${label}.serviceHealth`);
  assertNoRawDiagnosticSecrets(response, label);
}

// The unauthenticated health probe must stay limited to liveness/readiness.
// Device and bucket counts are deliberately absent: exposing operational scale
// to anonymous callers is needless disclosure, and no consumer read them.
function assertServerServiceHealthContract(serviceHealth, label = "serviceHealth") {
  assertObject(serviceHealth, label);
  assertExactKeys(serviceHealth, [
    "apiReachable",
    "ok",
    "restartRequired"
  ], label);
  assertEqual(typeof serviceHealth.ok, "boolean", `${label}.ok`);
  assertEqual(serviceHealth.apiReachable, true, `${label}.apiReachable`);
  assertEqual(typeof serviceHealth.restartRequired, "boolean", `${label}.restartRequired`);
  assertEqual(serviceHealth.ok, !serviceHealth.restartRequired, `${label}.ok`);
}

export function assertAdminAuthCheckResponseContract(response, label = "adminAuthCheck") {
  assertObject(response, label);
  assertExactKeys(response, ["adminAuth", "ok"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertAdminAuthCheckSummaryContract(response.adminAuth, `${label}.adminAuth`);
}

export function assertClientBinariesCheckContract(response, label = "clientBinariesCheck") {
  assertObject(response, label);
  assertExactKeys(response, ["ok", "singbox", "rclone"], label);
  assertEqual(typeof response.ok, "boolean", `${label}.ok`);
  assertClientBinaryCheckContract(response.singbox, `${label}.singbox`, "missing_singbox_binary");
  assertClientBinaryCheckContract(response.rclone, `${label}.rclone`, "missing_rclone_binary");
  assertEqual(response.ok, Boolean(response.singbox.ok && response.rclone.ok), `${label}.ok`);
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertClientSingboxProcessResponseContract(response, label = "clientSingboxProcess") {
  assertObject(response, label);
  assertExactKeys(response, ["singbox"], label);
  assertClientProcessStatusContract(response.singbox, `${label}.singbox`, "sing-box", {
    exactKeys: ["lastExit", "name", "pid", "running", "startedAt"],
    optionalKeys: ["stopSignal", "stopTimedOut"]
  });
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertClientProfileSummaryContract(summary, label = "clientStatus.profileSummary") {
  assertObject(summary, label);
  for (const field of ["profileId", "clientName", "server", "storage", "endpoint"]) {
    assertEqual(typeof summary[field], "string", `${label}.${field}`);
  }
  assertEqual(typeof summary.localProxyPort, "number", `${label}.localProxyPort`);
  assertNoRawProfileSecrets(summary, label);
}

export function assertClientProfileReadContract(response, label = "clientProfile") {
  assertObject(response, label);
  assert(Object.hasOwn(response, "profile"), `${label}.profile`);
  if (response.profile === null) {
    return;
  }

  const profile = response.profile;
  assertObject(profile, `${label}.profile`);
  assert(Number.isInteger(profile.version), `${label}.profile.version`);
  for (const field of ["profileId", "clientName", "importMode"]) {
    assertEqual(typeof profile[field], "string", `${label}.profile.${field}`);
    assert(profile[field] !== "", `${label}.profile.${field}`);
  }
  if (profile.issuedAt !== undefined) {
    assertNullableString(profile.issuedAt, `${label}.profile.issuedAt`);
  }
  if (profile.expiresAt !== undefined) {
    assertNullableString(profile.expiresAt, `${label}.profile.expiresAt`);
  }
  if (profile.importedAt !== undefined) {
    assertNullableString(profile.importedAt, `${label}.profile.importedAt`);
  }
  if (profile.source !== undefined) {
    assertObject(profile.source, `${label}.profile.source`);
    for (const field of ["type", "server"]) {
      assertEqual(typeof profile.source[field], "string", `${label}.profile.source.${field}`);
    }
  }
  assertClientProfileSummaryContract(profile.summary, `${label}.profile.summary`);

  assertObject(profile.tunnel, `${label}.profile.tunnel`);
  assertEqual(typeof profile.tunnel.type, "string", `${label}.profile.tunnel.type`);
  if (profile.tunnel.parsed !== null && profile.tunnel.parsed !== undefined) {
    assertObject(profile.tunnel.parsed, `${label}.profile.tunnel.parsed`);
    assertEqual(typeof profile.tunnel.parsed.server, "string", `${label}.profile.tunnel.parsed.server`);
    assert(Number.isInteger(profile.tunnel.parsed.port), `${label}.profile.tunnel.parsed.port`);
  }

  if (profile.heartbeat !== null && profile.heartbeat !== undefined) {
    assertObject(profile.heartbeat, `${label}.profile.heartbeat`);
    assertEqual(typeof profile.heartbeat.scheme, "string", `${label}.profile.heartbeat.scheme`);
    assertEqual(typeof profile.heartbeat.configured, "boolean", `${label}.profile.heartbeat.configured`);
  }

  assertObject(profile.storage, `${label}.profile.storage`);
  for (const field of ["type", "remoteName", "endpoint", "bucket", "prefix"]) {
    assertEqual(typeof profile.storage[field], "string", `${label}.profile.storage.${field}`);
  }
  assertObject(profile.defaults, `${label}.profile.defaults`);
  assertNoRawProfileSecrets(profile, `${label}.profile`);
}

export function assertClientProfileImportResponseContract(response, label = "clientProfileImport") {
  assertObject(response, label);
  assertExactKeys(response, ["profile"], label);
  assertObject(response.profile, `${label}.profile`);
  assertClientProfileReadContract(response, label);
}

export function assertServerIssuedProfileContract(profile, label = "serverIssuedProfile", options = {}) {
  assertObject(profile, label);
  const expectedKeys = ["clientName", "defaults", "expiresAt", "heartbeat", "issuedAt", "profileId", "storage", "tunnel", "version"];
  if (options.allowSource === true && profile.source !== undefined) {
    expectedKeys.push("source");
  }
  assertExactKeys(profile, expectedKeys, label);
  assertEqual(profile.version, PROFILE_VERSION, `${label}.version`);
  assertNonEmptyString(profile.profileId, `${label}.profileId`);
  assertNonEmptyString(profile.clientName, `${label}.clientName`);
  if (options.expectedClientName !== undefined) {
    assertEqual(profile.clientName, options.expectedClientName, `${label}.clientName`);
  }
  assertNonEmptyString(profile.issuedAt, `${label}.issuedAt`);
  assertMatch(profile.issuedAt, /^\d{4}-\d{2}-\d{2}T/, `${label}.issuedAt`);
  assertNullableString(profile.expiresAt, `${label}.expiresAt`);

  assertObject(profile.tunnel, `${label}.tunnel`);
  const tunnelKeys = ["type", "uri"];
  if (profile.tunnel.parsed !== undefined) {
    tunnelKeys.push("parsed");
  }
  assertExactKeys(profile.tunnel, tunnelKeys, `${label}.tunnel`);
  assertEqual(profile.tunnel.type, "vless", `${label}.tunnel.type`);
  assertNonEmptyString(profile.tunnel.uri, `${label}.tunnel.uri`);
  assertMatch(profile.tunnel.uri, /^vless:\/\//, `${label}.tunnel.uri`);
  if (profile.tunnel.parsed !== undefined) {
    assertObject(profile.tunnel.parsed, `${label}.tunnel.parsed`);
  }

  assertObject(profile.heartbeat, `${label}.heartbeat`);
  assertExactKeys(profile.heartbeat, ["scheme", "secret"], `${label}.heartbeat`);
  assertEqual(profile.heartbeat.scheme, "sfsc-hmac-sha256-v1", `${label}.heartbeat.scheme`);
  assertNonEmptyString(profile.heartbeat.secret, `${label}.heartbeat.secret`);
  if (options.expectedHeartbeatSecret !== undefined) {
    assertEqual(profile.heartbeat.secret, options.expectedHeartbeatSecret, `${label}.heartbeat.secret`);
  }

  if (profile.source !== undefined) {
    assertObject(profile.source, `${label}.source`);
    assertExactKeys(profile.source, ["server", "type"], `${label}.source`);
    assertEqual(typeof profile.source.type, "string", `${label}.source.type`);
    assertHttpUrl(profile.source.server, `${label}.source.server`);
  }

  assertObject(profile.storage, `${label}.storage`);
  assertExactKeys(profile.storage, ["accessKeyId", "bucket", "endpoint", "prefix", "remoteName", "secretAccessKey", "type"], `${label}.storage`);
  assertEqual(profile.storage.type, "s3", `${label}.storage.type`);
  for (const field of ["remoteName", "endpoint", "bucket", "accessKeyId", "secretAccessKey", "prefix"]) {
    assertNonEmptyString(profile.storage[field], `${label}.storage.${field}`);
  }
  assertHttpUrl(profile.storage.endpoint, `${label}.storage.endpoint`);
  if (options.expectedStorageSecretAccessKey !== undefined) {
    assertEqual(profile.storage.secretAccessKey, options.expectedStorageSecretAccessKey, `${label}.storage.secretAccessKey`);
  }

  assertServerIssuedProfileDefaultsContract(profile.defaults, `${label}.defaults`);
  assertNoUnexpectedIssuedProfileSecrets(profile, label);
}

export function assertClaimCreateResponseContract(response, label = "claimCreate", options = {}) {
  assertObject(response, label);
  const expectedKeys = ["claim", "claimCode", "code", "compatibility", "profile", "state", "tKey", "tKeyUri", "uri"];
  assertExactKeys(response, expectedKeys, label);
  assertMatch(response.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, `${label}.code`);
  assertMatch(response.tKey, /^SFSC1-/, `${label}.tKey`);
  assertMatch(response.claimCode, /^SFSC1-/, `${label}.claimCode`);
  assertMatch(response.tKeyUri, /^sfsc:\/\/import\/v1#/, `${label}.tKeyUri`);
  assertMatch(response.uri, /^sfsc:\/\/import\/v1#/, `${label}.uri`);
  assertEqual(response.claimCode, response.tKey, `${label}.claimCode`);
  assertEqual(response.uri, response.tKeyUri, `${label}.uri`);

  assertAdminClaimSummaryContract(response.claim, `${label}.claim`);
  assertEqual(response.claim.code, response.code, `${label}.claim.code`);
  assertEqual(response.claim.used, false, `${label}.claim.used`);
  if (options.expectedClientName !== undefined) {
    assertEqual(response.claim.clientName, options.expectedClientName, `${label}.claim.clientName`);
  }
  if (options.expectedServer !== undefined) {
    assertEqual(response.claim.server, options.expectedServer, `${label}.claim.server`);
  }

  assertServerIssuedProfileContract(response.profile, `${label}.profile`, options);
  assertEqual(response.claim.profileId, response.profile.profileId, `${label}.claim.profileId`);
  assertCompatibilityContract(response.compatibility, `${label}.compatibility`);
  assertAdminStateSummaryContract(response.state, `${label}.state`, options);
  if (options.expectedServer !== undefined) {
    assertEqual(response.state.settings.publicServerUrl, options.expectedServer, `${label}.state.settings.publicServerUrl`);
  }
  assertClaimCreateConfigWriteState(response, label);
  const stateClaim = response.state.claims.find((claim) => claim.code === response.code);
  assertObject(stateClaim, `${label}.state.claims[code=${response.code}]`);
  assertEqual(stateClaim.id, response.claim.id, `${label}.state.claim.id`);
  assertEqual(stateClaim.profileId, response.profile.profileId, `${label}.state.claim.profileId`);
}

function assertClaimCreateConfigWriteState(response, label) {
  assertNonEmptyString(response.state.tunnel.lastConfigWrittenAt, `${label}.state.tunnel.lastConfigWrittenAt`);
}

export function assertClaimRedeemResponseContract(response, label = "claimRedeem", options = {}) {
  assertServerIssuedProfileContract(response, label, options);
}

export function assertProfileEncodeResponseContract(response, label = "profileEncode", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["code", "profile", "summary", "uri"], label);
  assertServerIssuedProfileContract(response.profile, `${label}.profile`, {
    ...options,
    allowSource: true
  });
  assertObject(response.profile.source, `${label}.profile.source`);
  assertEqual(response.profile.source.type, "profile", `${label}.profile.source.type`);
  assertHttpUrl(response.profile.source.server, `${label}.profile.source.server`);
  assertClientProfileSummaryContract(response.summary, `${label}.summary`);
  assertEqual(response.summary.profileId, response.profile.profileId, `${label}.summary.profileId`);
  assertEqual(response.summary.clientName, response.profile.clientName, `${label}.summary.clientName`);
  assertMatch(response.code, /^SFSC1-/, `${label}.code`);
  assertMatch(response.uri, /^sfsc:\/\/import\/v1#/, `${label}.uri`);
}

export function assertVlessParseResponseContract(response, label = "vlessParse") {
  assertObject(response, label);
  assertExactKeys(response, ["profile"], label);
  assertParsedVlessProfileContract(response.profile, `${label}.profile`);
}

export function assertSingboxClientConfigResponseContract(response, label = "singboxClientConfig", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["profile", "config"], label);
  assertParsedVlessProfileContract(response.profile, `${label}.profile`);
  assertClientSingboxConfigContract(response.config, `${label}.config`, {
    ...options,
    profile: response.profile
  });
}

export function assertJobsPreviewResponseContract(response, label = "jobsPreview", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["profile", "rclone", "schedule", "singbox"], label);
  assertSyncPreviewContract(response, label, options);
  if (response.profile === null) {
    assertEqual(response.singbox, null, `${label}.singbox`);
    return;
  }
  assertParsedVlessProfileContract(response.profile, `${label}.profile`);
  assertClientSingboxConfigContract(response.singbox, `${label}.singbox`, {
    ...options,
    profile: response.profile
  });
}

export function assertClientJobsReadContract(response, label = "clientJobs") {
  assertObject(response, label);
  assertArray(response.jobs, `${label}.jobs`);
  for (const [index, job] of response.jobs.entries()) {
    assertClientJobSummaryContract(job, `${label}.jobs[${index}]`);
  }
}

export function assertClientJobSaveResponseContract(response, label = "clientJobSave") {
  assertObject(response, label);
  assertExactKeys(response, ["job", "scheduler"], label);
  assertClientJobSummaryContract(response.job, `${label}.job`);
  assertSchedulerContract(response.scheduler, `${label}.scheduler`);
  assertNoRawClientJobSecrets(response, label);
}

export function assertClientJobSummaryContract(job, label = "clientJob") {
  assertObject(job, label);
  for (const field of [
    "id",
    "name",
    "localPath",
    "direction",
    "remoteFolder",
    "serverSpace",
    "bandwidthLimit",
    "s3ChunkSize",
    "chunkSize",
    "cutoff",
    "clientName",
    "remoteName",
    "bucketName",
    "remotePrefix"
  ]) {
    if (Object.hasOwn(job, field)) {
      assertEqual(typeof job[field], "string", `${label}.${field}`);
    }
  }
  if (Object.hasOwn(job, "s3Endpoint")) {
    assertHttpUrl(job.s3Endpoint, `${label}.s3Endpoint`);
  }
  for (const field of ["dryRun", "destructiveSync"]) {
    if (Object.hasOwn(job, field)) {
      assertEqual(typeof job[field], "boolean", `${label}.${field}`);
    }
  }
  for (const field of ["transfers", "streams", "checkers", "s3UploadConcurrency", "retries", "lowLevelRetries"]) {
    if (Object.hasOwn(job, field)) {
      assertPositiveInteger(job[field], `${label}.${field}`);
    }
  }
  if (Object.hasOwn(job, "localProxyPort")) {
    assertTcpPort(job.localProxyPort, `${label}.localProxyPort`);
  }
  if (Object.hasOwn(job, "schedule")) {
    assertScheduleContract(job.schedule, `${label}.schedule`);
  }
  assertNoRawClientJobSecrets(job, label);
}

export function assertClientStatusJobSummaryContract(job, label = "clientStatus.jobs[]") {
  assertClientJobSummaryContract(job, label);
}

export function assertHeartbeatContract(heartbeat, label = "heartbeat") {
  assertObject(heartbeat, label);
  assertEqual(typeof heartbeat.ok, "boolean", `${label}.ok`);
  assertEqual(typeof heartbeat.server, "string", `${label}.server`);
  assertMatch(heartbeat.sentAt, /^\d{4}-\d{2}-\d{2}T/, `${label}.sentAt`);
  if (heartbeat.status !== undefined) {
    assert(Number.isInteger(heartbeat.status), `${label}.status`);
  }
  if (!heartbeat.ok) {
    assertEqual(heartbeat.errorCode, "heartbeat_failed", `${label}.errorCode`);
    if (heartbeat.remoteErrorCode !== undefined) {
      assertStableErrorCode(heartbeat.remoteErrorCode, `${label}.remoteErrorCode`);
      assert(heartbeat.remoteErrorCode !== "", `${label}.remoteErrorCode`);
    }
    return;
  }
  assertRuntimeDiagnosticsContract(heartbeat.serverDiagnostics, "server", `${label}.serverDiagnostics`);
  assertCompatibilityContract(heartbeat.compatibility, `${label}.compatibility`);
  assertClientHeartbeatDeviceSummaryContract(heartbeat.device, `${label}.device`);
}

export function assertServerHeartbeatResponseContract(response, label = "serverHeartbeat") {
  assertObject(response, label);
  assertExactKeys(response, ["device", "diagnostics", "ok"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertRuntimeDiagnosticsContract(response.diagnostics, "server", `${label}.diagnostics`);
  assertClientHeartbeatDeviceSummaryContract(response.device, `${label}.device`);
  assertCompatibilityContract(response.device.compatibility, `${label}.device.compatibility`, {
    localDiagnostics: response.diagnostics,
    remoteDiagnostics: response.device.diagnostics || {}
  });
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertCompatibilityContract(compatibility, label = "compatibility", options = {}) {
  assertObject(compatibility, label);
  assertExactKeys(compatibility, ["action", "issues", "localRole", "ok", "policy", "remoteRole", "severity", "status"], label);
  assertEqual(typeof compatibility.ok, "boolean", `${label}.ok`);
  assert(COMPATIBILITY_STATUSES.includes(compatibility.status), `${label}.status`);
  assert(COMPATIBILITY_ACTIONS.includes(compatibility.action), `${label}.action`);
  assert(COMPATIBILITY_SEVERITIES.includes(compatibility.severity), `${label}.severity`);
  assertEqual(typeof compatibility.localRole, "string", `${label}.localRole`);
  assertEqual(typeof compatibility.remoteRole, "string", `${label}.remoteRole`);
  assertObject(compatibility.policy, `${label}.policy`);
  assertExactKeys(compatibility.policy, ["adminActions", "heartbeat", "profileIssue", "reason", "syncRun"], `${label}.policy`);
  for (const field of ["heartbeat", "profileIssue", "syncRun", "adminActions"]) {
    assert(COMPATIBILITY_POLICY_VALUES.includes(compatibility.policy[field]), `${label}.policy.${field}`);
  }
  assertEqual(compatibility.policy.reason, compatibility.action, `${label}.policy.reason`);
  assertArray(compatibility.issues, `${label}.issues`);
  assertEqual(compatibility.ok, compatibility.issues.length === 0, `${label}.ok`);
  assertEqual(compatibility.status, compatibility.ok ? "compatible" : "mismatch", `${label}.status`);
  assertEqual(compatibility.severity, compatibility.ok ? "ok" : "warning", `${label}.severity`);
  for (const [index, issue] of compatibility.issues.entries()) {
    const issueLabel = `${label}.issues[${index}]`;
    assertObject(issue, issueLabel);
    assertExactKeys(issue, ["field", "local", "message", "remote", "type"], issueLabel);
    assert(COMPATIBILITY_ISSUE_FIELDS.includes(issue.field), `${issueLabel}.field`);
    assert(COMPATIBILITY_ISSUE_TYPES.includes(issue.type), `${issueLabel}.type`);
    assertCompatibilityIssueVersion(issue.local, `${issueLabel}.local`);
    assertCompatibilityIssueVersion(issue.remote, `${issueLabel}.remote`);
    assertNonEmptyString(issue.message, `${issueLabel}.message`);
    if (issue.type === "local_missing") {
      assertEqual(issue.local, null, `${issueLabel}.local`);
      assertPositiveInteger(issue.remote, `${issueLabel}.remote`);
    } else if (issue.type === "remote_missing") {
      assertPositiveInteger(issue.local, `${issueLabel}.local`);
      assertEqual(issue.remote, null, `${issueLabel}.remote`);
    } else if (issue.type === "remote_older") {
      assertPositiveInteger(issue.local, `${issueLabel}.local`);
      assertPositiveInteger(issue.remote, `${issueLabel}.remote`);
      assert(issue.remote < issue.local, `${issueLabel}.remote`);
    } else if (issue.type === "remote_newer") {
      assertPositiveInteger(issue.local, `${issueLabel}.local`);
      assertPositiveInteger(issue.remote, `${issueLabel}.remote`);
      assert(issue.remote > issue.local, `${issueLabel}.remote`);
    }
  }
  const expectedAction = summarizeCompatibilityAction(compatibility.issues);
  assertEqual(compatibility.action, expectedAction, `${label}.action`);
  const mismatch = compatibility.issues.length > 0;
  assertEqual(compatibility.policy.heartbeat, "allow", `${label}.policy.heartbeat`);
  assertEqual(compatibility.policy.adminActions, "allow", `${label}.policy.adminActions`);
  assertEqual(compatibility.policy.profileIssue, mismatch ? "warn" : "allow", `${label}.policy.profileIssue`);
  assertEqual(compatibility.policy.syncRun, mismatch ? "warn" : "allow", `${label}.policy.syncRun`);
  if (options.localDiagnostics !== undefined && options.remoteDiagnostics !== undefined) {
    assertDeepEqual(
      compatibility,
      compareRuntimeDiagnostics(options.localDiagnostics, options.remoteDiagnostics, {
        localRole: "server",
        remoteRole: "client"
      }),
      label
    );
  }
}

export function assertServerDeviceSummaryContract(device, label = "device", options = {}) {
  assertObject(device, label);
  for (const field of ["id", "clientName", "bucket", "prefix", "clientVersion", "lastRemoteAddress"]) {
    assertEqual(typeof device[field], "string", `${label}.${field}`);
  }
  assertEqual(typeof device.enabled, "boolean", `${label}.enabled`);
  assertEqual(typeof device.online, "boolean", `${label}.online`);
  assert(DEVICE_STATUSES.includes(device.status), `${label}.status`);
  assertNullableString(device.lastSeenAt, `${label}.lastSeenAt`);
  assert(SYNC_STATES.includes(device.syncState), `${label}.syncState`);
  assertFiniteNumber(device.speedMbps, `${label}.speedMbps`);
  assertNoRawSecrets(device, label);
  if (options.forbidVlessUri === true) {
    assertEqual(Object.hasOwn(device, "vlessUri"), false, `${label} leaked raw vlessUri`);
  }

  if (device.diagnostics !== null && device.diagnostics !== undefined) {
    assertRuntimeDiagnosticsContract(device.diagnostics, "client", `${label}.diagnostics`);
  }
  if (device.compatibility !== null && device.compatibility !== undefined) {
    assertCompatibilityContract(device.compatibility, `${label}.compatibility`);
  }

  assertObject(device.sync, `${label}.sync`);
  assertEqual(device.syncState, device.sync.state, `${label}.syncState`);
  assertEqual(device.speedMbps, device.sync.speedMbps, `${label}.speedMbps`);
  assertDeviceSyncContract(device.sync, `${label}.sync`);
}

export function assertClientHeartbeatDeviceSummaryContract(device, label = "heartbeat.device") {
  assertServerDeviceSummaryContract(device, label, { forbidVlessUri: true });
}

export function assertAdminClaimSummaryContract(claim, label = "claim") {
  assertObject(claim, label);
  for (const field of ["id", "userId", "clientName", "bucketName", "profileId", "createdAt", "server"]) {
    assertEqual(typeof claim[field], "string", `${label}.${field}`);
  }
  assertMatch(claim.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, `${label}.code`);
  assertEqual(typeof claim.used, "boolean", `${label}.used`);
  assertNullableString(claim.expiresAt, `${label}.expiresAt`);
  assertNullableString(claim.redeemedAt, `${label}.redeemedAt`);
  assertHttpUrl(claim.server, `${label}.server`);
  assert(claim.syncSpaceId === undefined || claim.syncSpaceId === null || typeof claim.syncSpaceId === "string", `${label}.syncSpaceId`);
  assert(claim.requestedRole == null || ["owner", "writer", "reader"].includes(claim.requestedRole), `${label}.requestedRole`);
  if (claim.used) {
    assertEqual(typeof claim.redeemedAt, "string", `${label}.redeemedAt`);
    assert(claim.redeemedAt !== "", `${label}.redeemedAt`);
  }
  assertNoRawClaimSecrets(claim, label);
}

export function assertAdminUserSummaryContract(user, label = "user") {
  assertObject(user, label);
  const expectedKeys = [...ADMIN_USER_SUMMARY_KEYS];
  if (Object.hasOwn(user, "deletedAt")) {
    expectedKeys.push("deletedAt");
  }
  assertDeepEqual(Object.keys(user).sort(), expectedKeys.sort(), `${label} keys`);
  for (const field of ["id", "clientName", "uuid", "createdAt", "updatedAt", "vlessUriRevealPath"]) {
    assertEqual(typeof user[field], "string", `${label}.${field}`);
  }
  assertEqual(typeof user.enabled, "boolean", `${label}.enabled`);
  assertEqual(typeof user.vlessUriAvailable, "boolean", `${label}.vlessUriAvailable`);
  if (Object.hasOwn(user, "deletedAt")) {
    assertNullableString(user.deletedAt, `${label}.deletedAt`);
  }
  assertEqual(Object.hasOwn(user, "vlessUri"), false, `${label} leaked raw vlessUri`);
  if (user.vlessUriAvailable) {
    assertMatch(user.vlessUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/, `${label}.vlessUriRevealPath`);
  }
  assertObject(user.storage, `${label}.storage`);
  assertDeepEqual(Object.keys(user.storage).sort(), ADMIN_USER_STORAGE_KEYS.sort(), `${label}.storage keys`);
  for (const field of ["accessKeyId", "bucket", "prefix"]) {
    assertEqual(typeof user.storage[field], "string", `${label}.storage.${field}`);
  }
  assertMatch(user.storage.secretAccessKey, /\*\*\*/, `${label}.storage.secretAccessKey`);
  assertNoRawAdminUserSecrets(user, label);
}

export function assertAdminStateSummaryContract(state, label = "adminState", options = {}) {
  assertObject(state, label);
  assertExactKeys(state, [
    "appVersion",
    "claims",
    "defaults",
    "devices",
    "diagnostics",
    "settings",
    "storage",
    "syncSpaces",
    "tunnel",
    "updatedAt",
    "users",
    "version"
  ], label);
  assertEqual(state.version, ADMIN_STATE_VERSION, `${label}.version`);
  assertEqual(typeof state.appVersion, "string", `${label}.appVersion`);
  assertEqual(typeof state.updatedAt, "string", `${label}.updatedAt`);
  assertRuntimeDiagnosticsContract(state.diagnostics, options.diagnosticsRole || "server", `${label}.diagnostics`);
  assertAdminSettingsSummaryContract(state.settings, `${label}.settings`);
  assertAdminTunnelSummaryContract(state.tunnel, `${label}.tunnel`);
  assertAdminStorageSummaryContract(state.storage, `${label}.storage`);
  assertAdminDefaultsSummaryContract(state.defaults, `${label}.defaults`);

  assertArray(state.syncSpaces, `${label}.syncSpaces`);
  for (const [index, syncSpace] of state.syncSpaces.entries()) {
    assertAdminSyncSpaceSummaryContract(syncSpace, `${label}.syncSpaces[${index}]`);
  }

  assertArray(state.users, `${label}.users`);
  for (const [index, user] of state.users.entries()) {
    assertAdminUserSummaryContract(user, `${label}.users[${index}]`);
  }

  assertArray(state.devices, `${label}.devices`);
  for (const [index, device] of state.devices.entries()) {
    assertServerDeviceSummaryContract(device, `${label}.devices[${index}]`);
    assertEqual(Object.hasOwn(device, "vlessUri"), false, `${label}.devices[${index}] leaked raw vlessUri`);
    if (Object.hasOwn(device, "vlessUriAvailable")) {
      assertEqual(typeof device.vlessUriAvailable, "boolean", `${label}.devices[${index}].vlessUriAvailable`);
    }
    if (Object.hasOwn(device, "vlessUriRevealPath")) {
      assertMatch(device.vlessUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/, `${label}.devices[${index}].vlessUriRevealPath`);
    }
  }

  assertArray(state.claims, `${label}.claims`);
  for (const [index, claim] of state.claims.entries()) {
    assertAdminClaimSummaryContract(claim, `${label}.claims[${index}]`);
  }
}

export function assertAdminSyncSpaceSummaryContract(syncSpace, label = "adminSyncSpace") {
  assertObject(syncSpace, label);
  assertExactKeys(syncSpace, ["createdAt", "id", "memberCount", "policy", "status", "syncId", "version"], label);
  assertNonEmptyString(syncSpace.id, `${label}.id`);
  assertNonEmptyString(syncSpace.syncId, `${label}.syncId`);
  assert(["active", "disabled"].includes(syncSpace.status), `${label}.status`);
  assertObject(syncSpace.policy, `${label}.policy`);
  assertExactKeys(syncSpace.policy, ["multiWriter"], `${label}.policy`);
  assertEqual(typeof syncSpace.policy.multiWriter, "boolean", `${label}.policy.multiWriter`);
  assertPositiveInteger(syncSpace.version, `${label}.version`);
  assertNonEmptyString(syncSpace.createdAt, `${label}.createdAt`);
  assertNonNegativeInteger(syncSpace.memberCount, `${label}.memberCount`);
  assertEqual(Object.hasOwn(syncSpace, "storageTarget"), false, `${label} leaked storage target`);
  assertEqual(Object.hasOwn(syncSpace, "accessKeyId"), false, `${label} leaked storage credential`);
  assertEqual(Object.hasOwn(syncSpace, "secretAccessKey"), false, `${label} leaked storage credential`);
}

export function assertAdminWriteStateResponseContract(response, label = "adminWriteResponse", options = {}) {
  assertObject(response, label);
  assertAdminStateSummaryContract(response.state, `${label}.state`, options);
  assertNoRawAdminWriteResponseSecrets(response, label, options);
}

export function assertAdminStorageSaveResponseContract(response, label = "adminStorageSave", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["state", "storage"], label);
  assertAdminStorageSummaryContract(response.storage, `${label}.storage`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertDeepEqual(response.storage, response.state.storage, `${label}.storage`);
}

export function assertAdminSingboxConfigPreviewContract(response, state, label = "adminSingboxConfigPreview", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["config", "path"], label);
  assertNonEmptyString(response.path, `${label}.path`);
  if (state !== undefined && state !== null) {
    assertAdminStateSummaryContract(state, `${label}.state`, options);
  }
  assertServerSingboxConfigContract(response.config, state, `${label}.config`);
  assertNoRawAdminWriteResponseSecrets(response, label, options);
}

export function assertAdminTunnelAutofillResponseContract(response, label = "adminTunnelAutofill", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["state", "tunnel"], label);
  assertAdminTunnelSummaryContract(response.tunnel, `${label}.tunnel`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertDeepEqual(response.tunnel, response.state.tunnel, `${label}.tunnel`);
}

export function assertAdminTunnelGenerateResponseContract(response, label = "adminTunnelGenerate", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["config", "state", "tunnel"], label);
  assertAdminTunnelSummaryContract(response.tunnel, `${label}.tunnel`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertDeepEqual(response.tunnel, response.state.tunnel, `${label}.tunnel`);
  assertEqual(response.state.tunnel.restartRequired, true, `${label}.state.tunnel.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastConfigWrittenAt, `${label}.state.tunnel.lastConfigWrittenAt`);
  assertServerSingboxConfigContract(response.config, response.state, `${label}.config`);
}

export function assertAdminSingboxWriteResponseContract(response, label = "adminSingboxWrite", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["config", "path", "restartRequired", "state"], label);
  assertNonEmptyString(response.path, `${label}.path`);
  assertEqual(typeof response.restartRequired, "boolean", `${label}.restartRequired`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertEqual(response.restartRequired, response.state.tunnel.restartRequired, `${label}.restartRequired`);
  assertEqual(response.restartRequired, true, `${label}.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastConfigWrittenAt, `${label}.state.tunnel.lastConfigWrittenAt`);
  assertServerSingboxConfigContract(response.config, response.state, `${label}.config`);
}

export function assertAdminSingboxApplyResponseContract(response, label = "adminSingboxApply", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["restart", "state"], label);
  assertObject(response.restart, `${label}.restart`);
  assertExactKeys(response.restart, ["configSha256", "message", "ok", "restartedAt"], `${label}.restart`);
  assertEqual(response.restart.ok, true, `${label}.restart.ok`);
  assertNonEmptyString(response.restart.message, `${label}.restart.message`);
  assertMatch(response.restart.configSha256, /^[a-f0-9]{64}$/, `${label}.restart.configSha256`);
  assertNullableString(response.restart.restartedAt, `${label}.restart.restartedAt`);
  if (response.restart.restartedAt !== null) {
    assertMatch(response.restart.restartedAt, /^\d{4}-\d{2}-\d{2}T/, `${label}.restart.restartedAt`);
  }
  assertAdminWriteStateResponseContract(response, label, options);
  assertEqual(response.state.tunnel.restartRequired, false, `${label}.state.tunnel.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastAppliedAt, `${label}.state.tunnel.lastAppliedAt`);
}

export function assertAdminSingboxMarkAppliedResponseContract(response, label = "adminSingboxMarkApplied", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["state"], label);
  assertAdminWriteStateResponseContract(response, label, options);
  assertEqual(response.state.tunnel.restartRequired, false, `${label}.state.tunnel.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastAppliedAt, `${label}.state.tunnel.lastAppliedAt`);
}

export function assertAdminUserWriteResponseContract(response, label = "adminUserWrite", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["config", "state", "user"], label);
  assertAdminUserSummaryContract(response.user, `${label}.user`);
  assertAdminWriteStateResponseContract(response, label, options);
  const stateUser = assertStateContainsAdminUser(response.state, response.user.id, `${label}.state.users`);
  assertDeepEqual(response.user, stateUser, `${label}.user`);
  assertEqual(response.state.tunnel.restartRequired, true, `${label}.state.tunnel.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastConfigWrittenAt, `${label}.state.tunnel.lastConfigWrittenAt`);
  assertServerSingboxConfigContract(response.config, response.state, `${label}.config`);
}

export function assertAdminUserDeleteResponseContract(response, label = "adminUserDelete", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["config", "deletedUserId", "ok", "state"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertNonEmptyString(response.deletedUserId, `${label}.deletedUserId`);
  assertAdminWriteStateResponseContract(response, label, options);
  const stateUser = assertStateContainsAdminUser(response.state, response.deletedUserId, `${label}.state.users`);
  assertEqual(stateUser.enabled, false, `${label}.state.users.deleted.enabled`);
  assertNonEmptyString(stateUser.deletedAt, `${label}.state.users.deletedAt`);
  assertEqual(response.state.tunnel.restartRequired, true, `${label}.state.tunnel.restartRequired`);
  assertNonEmptyString(response.state.tunnel.lastConfigWrittenAt, `${label}.state.tunnel.lastConfigWrittenAt`);
  assert(
    !response.state.devices.some((device) => device.id === response.deletedUserId),
    `${label}.state.devices.deletedUserId`
  );
  assertServerSingboxConfigContract(response.config, response.state, `${label}.config`);
}

export function assertAdminStorageBucketsRefreshResponseContract(response, label = "adminStorageBucketsRefresh", options = {}) {
  assertObject(response, label);
  assertEqual(typeof response.ok, "boolean", `${label}.ok`);
  if (response.ok) {
    assertExactKeys(response, ["buckets", "ok", "state"], label);
  } else {
    assertExactKeys(response, ["buckets", "errorCode", "ok", "state", "warning"], label);
    assertEqual(response.errorCode, "storage_request_failed", `${label}.errorCode`);
    assertNonEmptyString(response.warning, `${label}.warning`);
  }
  assertArray(response.buckets, `${label}.buckets`);
  for (const [index, bucket] of response.buckets.entries()) {
    assertStorageBucketOperationSummaryContract(bucket, `${label}.buckets[${index}]`);
  }
  assertAdminWriteStateResponseContract(response, label, options);
}

export function assertAdminStorageBucketCreateResponseContract(response, label = "adminStorageBucketCreate", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["bucket", "provision", "state"], label);
  assertStorageBucketOperationSummaryContract(response.bucket, `${label}.bucket`);
  assertStorageBucketProvisionResultContract(response.provision, `${label}.provision`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertStateContainsStorageBucket(response.state, response.bucket.name, `${label}.state.storage.buckets`);
}

export function assertAdminStorageBucketToggleResponseContract(response, label = "adminStorageBucketToggle", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["bucket", "state"], label);
  assertStorageBucketOperationSummaryContract(response.bucket, `${label}.bucket`);
  assertAdminWriteStateResponseContract(response, label, options);
  const stateBucket = assertStateContainsStorageBucket(response.state, response.bucket.name, `${label}.state.storage.buckets`);
  assertEqual(stateBucket.disabledAt, response.bucket.disabledAt ?? null, `${label}.bucket.disabledAt`);
}

export function assertAdminStorageBucketClearResponseContract(response, label = "adminStorageBucketClear", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["bucket", "ok", "result", "state"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertStorageBucketOperationSummaryContract(response.bucket, `${label}.bucket`);
  assertObject(response.result, `${label}.result`);
  assertExactKeys(response.result, ["deleted", "rounds"], `${label}.result`);
  assertNonNegativeInteger(response.result.deleted, `${label}.result.deleted`);
  assertNonNegativeInteger(response.result.rounds, `${label}.result.rounds`);
  assertAdminWriteStateResponseContract(response, label, options);
  const stateBucket = assertStateContainsStorageBucket(response.state, response.bucket.name, `${label}.state.storage.buckets`);
  assertEqual(stateBucket.clearedAt, response.bucket.clearedAt ?? null, `${label}.bucket.clearedAt`);
}

export function assertAdminStorageBucketDeleteEmptyResponseContract(response, label = "adminStorageBucketDeleteEmpty", options = {}) {
  assertObject(response, label);
  assertExactKeys(response, ["ok", "result", "state", "storage"], label);
  assertEqual(response.ok, true, `${label}.ok`);
  assertObject(response.result, `${label}.result`);
  assertExactKeys(response.result, ["deletedBucket"], `${label}.result`);
  assertNonEmptyString(response.result.deletedBucket, `${label}.result.deletedBucket`);
  assertAdminStorageSummaryContract(response.storage, `${label}.storage`);
  assertAdminWriteStateResponseContract(response, label, options);
  assertDeepEqual(response.storage, response.state.storage, `${label}.storage`);
  assert(
    !response.state.storage.buckets.some((bucket) => bucket.name === response.result.deletedBucket),
    `${label}.state.storage.buckets`
  );
}

export function assertAdminSettingsSummaryContract(settings, label = "settings") {
  assertObject(settings, label);
  assertHttpUrl(settings.publicServerUrl, `${label}.publicServerUrl`);
  assert(!settings.publicServerUrl.endsWith("/"), `${label}.publicServerUrl`);
}

export function assertAdminTunnelSummaryContract(tunnel, label = "tunnel") {
  assertObject(tunnel, label);
  for (const field of ["id", "name", "listenHost", "publicHost", "remark"]) {
    assertEqual(typeof tunnel[field], "string", `${label}.${field}`);
  }
  assert(ADMIN_TUNNEL_PROTOCOLS.includes(tunnel.protocol), `${label}.protocol`);
  assertTcpPort(tunnel.listenPort, `${label}.listenPort`);
  assertTcpPort(tunnel.publicPort, `${label}.publicPort`);
  assert(ADMIN_TUNNEL_SECURITY.includes(tunnel.security), `${label}.security`);
  assertEqual(tunnel.security, tunnel.protocol === "vless-reality-tcp" ? "reality" : tunnel.protocol === "vless-ws-tls" ? "tls" : "none", `${label}.security`);
  assertEqual(tunnel.transport, tunnel.protocol === "vless-ws-tls" ? "ws" : "tcp", `${label}.transport`);
  if (tunnel.protocol === "vless-ws-tls") {
    assert(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,240}$/.test(tunnel.transportPath), `${label}.transportPath`);
  }

  assertObject(tunnel.reality, `${label}.reality`);
  for (const field of ["serverName", "fingerprint", "publicKey", "shortId"]) {
    assertEqual(typeof tunnel.reality[field], "string", `${label}.reality.${field}`);
  }
  assertMaskedSecret(tunnel.reality.privateKey, `${label}.reality.privateKey`);

  assertNullableString(tunnel.lastConfigWrittenAt, `${label}.lastConfigWrittenAt`);
  assertNullableString(tunnel.lastAppliedAt, `${label}.lastAppliedAt`);
  assertEqual(typeof tunnel.restartRequired, "boolean", `${label}.restartRequired`);
  assertNonNegativeInteger(tunnel.userCount, `${label}.userCount`);
  assertNullableString(tunnel.sampleUri, `${label}.sampleUri`);
  assertEqual(tunnel.sampleUri, null, `${label}.sampleUri`);
  if (Object.hasOwn(tunnel, "sampleUriAvailable")) {
    assertEqual(typeof tunnel.sampleUriAvailable, "boolean", `${label}.sampleUriAvailable`);
    assertEqual(tunnel.sampleUriAvailable, tunnel.userCount > 0, `${label}.sampleUriAvailable`);
  }
  if (Object.hasOwn(tunnel, "sampleUriRevealPath")) {
    assertEqual(typeof tunnel.sampleUriRevealPath, "string", `${label}.sampleUriRevealPath`);
    if (tunnel.userCount > 0) {
      assertMatch(tunnel.sampleUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/, `${label}.sampleUriRevealPath`);
    } else {
      assertEqual(tunnel.sampleUriRevealPath, "", `${label}.sampleUriRevealPath`);
    }
  }
}

export function assertAdminDeviceVlessUriRevealContract(response, state, label = "adminDeviceVlessUriReveal") {
  assertObject(response, label);
  assertExactKeys(response, ["device", "vlessUri"], label);
  assertObject(response.device, `${label}.device`);
  assertExactKeys(response.device, ["clientName", "id"], `${label}.device`);
  assertNonEmptyString(response.device.id, `${label}.device.id`);
  assertNonEmptyString(response.device.clientName, `${label}.device.clientName`);
  assertMatch(response.vlessUri, /^vless:\/\//, `${label}.vlessUri`);
  if (state) {
    assertAdminStateSummaryContract(state, `${label}.state`);
    assertVlessUriMatchesTunnel(response.vlessUri, state.tunnel, `${label}.vlessUri`);
  }
}

export function assertAdminStorageSummaryContract(storage, label = "storage") {
  assertObject(storage, label);
  for (const field of ["id", "type", "name", "remoteName", "bucket", "accessKeyMode", "accessKeyId", "prefixRoot", "sharedPrefix"]) {
    assertEqual(typeof storage[field], "string", `${label}.${field}`);
  }
  assertHttpUrl(storage.endpoint, `${label}.endpoint`);
  assertHttpUrl(storage.internalEndpoint, `${label}.internalEndpoint`);
  assertMaskedSecret(storage.secretAccessKey, `${label}.secretAccessKey`);

  assertArray(storage.buckets, `${label}.buckets`);
  assert(storage.buckets.some((bucket) => bucket?.name === storage.bucket), `${label}.buckets`);
  for (const [index, bucket] of storage.buckets.entries()) {
    const bucketLabel = `${label}.buckets[${index}]`;
    assertObject(bucket, bucketLabel);
    for (const field of ["name", "source", "remoteName"]) {
      assertEqual(typeof bucket[field], "string", `${bucketLabel}.${field}`);
    }
    assertNullableString(bucket.createdAt, `${bucketLabel}.createdAt`);
    assertNullableNumber(bucket.objectCount, `${bucketLabel}.objectCount`);
    assertNullableNumber(bucket.sizeBytes, `${bucketLabel}.sizeBytes`);
    assertNullableString(bucket.disabledAt, `${bucketLabel}.disabledAt`);
    assertNullableString(bucket.clearedAt, `${bucketLabel}.clearedAt`);
    assertHttpUrl(bucket.endpoint, `${bucketLabel}.endpoint`);
    assertArray(bucket.prefixes, `${bucketLabel}.prefixes`);
    for (const [prefixIndex, prefix] of bucket.prefixes.entries()) {
      assertEqual(typeof prefix, "string", `${bucketLabel}.prefixes[${prefixIndex}]`);
    }
    assert(bucket.prefixes.includes(`${storage.prefixRoot}/`), `${bucketLabel}.prefixes`);
    assert(bucket.prefixes.includes(`${storage.sharedPrefix}/`), `${bucketLabel}.prefixes`);
  }
}

export function assertAdminDefaultsSummaryContract(defaults, label = "defaults") {
  assertServerIssuedProfileDefaultsContract(defaults, label);
}

export function assertSyncPreviewContract(preview, label = "syncPreview", options = {}) {
  assertObject(preview, label);
  assertRclonePreviewContract(preview.rclone, `${label}.rclone`, options);
  assertObject(preview.schedule, `${label}.schedule`);
  assertNonEmptyString(preview.schedule.text, `${label}.schedule.text`);
  if (preview.schedule.nextRun !== null) {
    assertEqual(typeof preview.schedule.nextRun, "string", `${label}.schedule.nextRun`);
  }
}

export function assertClientSyncRunResponseContract(response, label = "syncRun") {
  assertObject(response, label);
  assertExactKeys(response, ["sync"], label);
  assertClientProcessStatusContract(response.sync, `${label}.sync`, "rclone-sync", {
    exactKeys: ["lastExit", "name", "pid", "running", "startedAt"],
    optionalKeys: ["stopSignal", "stopTimedOut"]
  });
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertRclonePreviewContract(rclone, label = "rclone", options = {}) {
  assertObject(rclone, label);
  assertNonEmptyString(rclone.executable, `${label}.executable`);
  assertArray(rclone.args, `${label}.args`);
  assertObject(rclone.env, `${label}.env`);
  assertNonEmptyString(rclone.displayCommand, `${label}.displayCommand`);
  assertPreviewDisplayTextIsSafe(rclone.displayCommand, `${label}.displayCommand`, options);
  assertObject(rclone.remoteConfig, `${label}.remoteConfig`);
  assertNonEmptyString(rclone.remoteConfig.executable, `${label}.remoteConfig.executable`);
  assertArray(rclone.remoteConfig.args, `${label}.remoteConfig.args`);
  assertObject(rclone.remoteConfig.env, `${label}.remoteConfig.env`);
  assertNonEmptyString(rclone.remoteConfig.displayCommand, `${label}.remoteConfig.displayCommand`);
  assertPreviewDisplayTextIsSafe(rclone.remoteConfig.displayCommand, `${label}.remoteConfig.displayCommand`, options);
  // The S3 secret must never reach process argv; it is injected through
  // RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY instead.
  assert(
    !rclone.remoteConfig.args.includes("secret_access_key"),
    `${label}.remoteConfig.args must not carry secret_access_key`
  );
  if (rclone.remoteConfig.displayCommand.includes("SECRET_ACCESS_KEY")) {
    assertMatch(
      rclone.remoteConfig.displayCommand,
      /SECRET_ACCESS_KEY="\S*\*{2,}\S*"/i,
      `${label}.remoteConfig.displayCommand`
    );
  }
  assertObject(rclone.storage, `${label}.storage`);
  assertNonEmptyString(rclone.remotePath, `${label}.remotePath`);
  assertObject(rclone.safety, `${label}.safety`);
  for (const field of ["usesProcessScopedProxy", "mutatesSystemProxy", "mutatesRoutes", "tunRequired", "muxRequired", "deleteProtection"]) {
    assertEqual(typeof rclone.safety[field], "boolean", `${label}.safety.${field}`);
  }
  if (options.remoteConfigSecret) {
    const secretEnvValues = Object.entries(rclone.remoteConfig.env)
      .filter(([key]) => /SECRET_ACCESS_KEY$/i.test(key))
      .map(([, value]) => value);
    assert(
      secretEnvValues.includes(options.remoteConfigSecret),
      `${label}.remoteConfig.env secret`
    );
    assert(
      !rclone.remoteConfig.args.includes(options.remoteConfigSecret),
      `${label}.remoteConfig.args must not leak the secret`
    );
  }
}

export function assertDiagnosticExportContract(payload, label = "diagnosticExport", options = {}) {
  assertObject(payload, label);
  assertExactKeys(payload, ["bundle", "filename", "ok"], label);
  assertEqual(payload.ok, true, `${label}.ok`);
  assertMatch(payload.filename, /^sfsc-client-diagnostics-.*\.json$/, `${label}.filename`);
  assertDiagnosticBundleContract(payload.bundle, `${label}.bundle`, {
    ...options,
    strictEnvironment: options.strictEnvironment ?? true,
    strictLogs: options.strictLogs ?? true
  });
}

export function assertClientLogsContract(payload, label = "clientLogs", options = {}) {
  assertObject(payload, label);
  assertExactKeys(payload, ["rclone", "singbox"], label);
  for (const field of ["singbox", "rclone"]) {
    assertEqual(typeof payload[field], "string", `${label}.${field}`);
    assertNoRawDiagnosticSecrets(payload[field], `${label}.${field}`, options);
  }
}

export function assertDiagnosticBundleContract(bundle, label = "diagnosticBundle", options = {}) {
  assertObject(bundle, label);
  assertExactKeys(bundle, ["app", "environment", "generatedAt", "logs", "role", "schemaVersion", "status", "summary"], label);
  assertEqual(bundle.schemaVersion, 1, `${label}.schemaVersion`);
  assertEqual(bundle.app, "singbox-folder-sync", `${label}.app`);
  assertEqual(bundle.role, "client", `${label}.role`);
  assertMatch(bundle.generatedAt, /^\d{4}-\d{2}-\d{2}T/, `${label}.generatedAt`);
  assertDiagnosticSummaryContract(bundle.summary, `${label}.summary`);
  assertDiagnosticStatusContract(bundle.status, `${label}.status`);
  assertDiagnosticEnvironmentContract(bundle.environment, `${label}.environment`, options);
  assertDiagnosticLogsContract(bundle.logs, `${label}.logs`, options);
  assertNoRawDiagnosticSecrets(bundle, label, options);
  assertNoLocalDiagnosticPaths(bundle, label);
  assertNoSupportPrivateDiagnosticValues(bundle, label);
}

export function assertDiagnosticSummaryContract(summary, label = "diagnosticBundle.summary") {
  assertObject(summary, label);
  for (const field of [
    "appVersion",
    "releaseManifestVersion",
    "releaseManifestErrorCode",
    "profileClientName",
    "serverUrl",
    "heartbeatErrorCode",
    "heartbeatRemoteErrorCode",
    "heartbeatDeviceStatus",
    "heartbeatDeviceBucket",
    "heartbeatDevicePrefix",
    "heartbeatDeviceCurrentFile",
    "heartbeatCompatibilityStatus",
    "heartbeatCompatibilityAction",
    "heartbeatCompatibilitySeverity",
    "heartbeatCompatibilitySyncRunPolicy",
    "lastSyncStatus",
    "lastSyncErrorCode"
  ]) {
    assertEqual(typeof summary[field], "string", `${label}.${field}`);
  }
  assertNullableString(summary.releaseManifestBuiltAt, `${label}.releaseManifestBuiltAt`);
  for (const field of ["releaseManifestOk", "releaseManifestSupportDocsOk", "releaseManifestRequiredFilesOk", "localStateOk", "secretVaultOk", "heartbeatOk", "heartbeatDeviceEnabled", "heartbeatDeviceOnline"]) {
    assertNullableBoolean(summary[field], `${label}.${field}`);
  }
  assertEqual(typeof summary.profileImported, "boolean", `${label}.profileImported`);
  assertEqual(typeof summary.portableRoot, "boolean", `${label}.portableRoot`);
  assertEqual(typeof summary.binariesOk, "boolean", `${label}.binariesOk`);
  assertFiniteNumber(summary.missingSecretRefs, `${label}.missingSecretRefs`);
  assertFiniteNumber(summary.conflictCount, `${label}.conflictCount`);
  if (summary.heartbeatServerProtocols === null) {
    assertEqual(summary.heartbeatServerProtocols, null, `${label}.heartbeatServerProtocols`);
  } else {
    assertObject(summary.heartbeatServerProtocols, `${label}.heartbeatServerProtocols`);
    for (const field of ["claim", "profile", "adminState", "clientStatus", "heartbeat"]) {
      assertPositiveInteger(summary.heartbeatServerProtocols[field], `${label}.heartbeatServerProtocols.${field}`);
    }
  }
  for (const field of ["releaseManifestSupportDocsMissing", "releaseManifestRequiredFilesMissing", "missingBinaries", "localStateErrors", "logsMissing", "logsTruncated"]) {
    assertArray(summary[field], `${label}.${field}`);
  }
  for (const [index, binary] of summary.missingBinaries.entries()) {
    assertObject(binary, `${label}.missingBinaries[${index}]`);
    for (const field of ["path", "errorCode", "message"]) {
      assertEqual(typeof binary[field], "string", `${label}.missingBinaries[${index}].${field}`);
    }
  }
  for (const [index, file] of summary.localStateErrors.entries()) {
    assertObject(file, `${label}.localStateErrors[${index}]`);
    for (const field of ["name", "errorCode", "message"]) {
      assertEqual(typeof file[field], "string", `${label}.localStateErrors[${index}].${field}`);
    }
  }
}

function assertDiagnosticStatusContract(status, label = "diagnosticBundle.status") {
  assertObject(status, label);
  assertExactKeys(status, [
    "appVersion",
    "binaries",
    "diagnostics",
    "heartbeat",
    "jobs",
    "lastSuccessfulHeartbeat",
    "lastSync",
    "profileImported",
    "profileSummary",
    "safeguards"
  ], label);
  assertEqual(typeof status.appVersion, "string", `${label}.appVersion`);
  assertEqual(typeof status.profileImported, "boolean", `${label}.profileImported`);
  if (status.diagnostics === null) {
    assertEqual(status.diagnostics, null, `${label}.diagnostics`);
  } else {
    assertRuntimeDiagnosticsContract(status.diagnostics, "client", `${label}.diagnostics`);
  }
  assertDiagnosticProfileSummaryContract(status.profileSummary, `${label}.profileSummary`);
  assertDiagnosticBinariesContract(status.binaries, `${label}.binaries`);
  assertNullableDiagnosticHeartbeatContract(status.heartbeat, `${label}.heartbeat`);
  assertNullableDiagnosticHeartbeatContract(status.lastSuccessfulHeartbeat, `${label}.lastSuccessfulHeartbeat`);
  assertObject(status.safeguards, `${label}.safeguards`);
  assertExactKeys(status.safeguards, ["localState", "secretVault"], `${label}.safeguards`);
  assertNullableDiagnosticLocalStateContract(status.safeguards.localState, `${label}.safeguards.localState`);
  assertNullableDiagnosticSecretVaultContract(status.safeguards.secretVault, `${label}.safeguards.secretVault`);
  assertNullableDiagnosticSyncRunContract(status.lastSync, `${label}.lastSync`);
  assertArray(status.jobs, `${label}.jobs`);
  status.jobs.forEach((job, index) => assertDiagnosticJobContract(job, `${label}.jobs[${index}]`));
}

function assertDiagnosticProfileSummaryContract(summary, label) {
  assertObject(summary, label);
  assertExactKeys(summary, ["clientName", "localProxyPort", "serverUrl", "storage"], label);
  for (const field of ["clientName", "serverUrl", "storage"]) {
    assertEqual(typeof summary[field], "string", `${label}.${field}`);
  }
  assertNullableNumber(summary.localProxyPort, `${label}.localProxyPort`);
}

function assertDiagnosticBinariesContract(binaries, label) {
  assertObject(binaries, label);
  assertExactKeys(binaries, ["rclone", "singbox"], label);
  assertDiagnosticBinaryContract(binaries.singbox, `${label}.singbox`);
  assertDiagnosticBinaryContract(binaries.rclone, `${label}.rclone`);
}

function assertDiagnosticBinaryContract(binary, label) {
  assertObject(binary, label);
  assertExactKeys(binary, ["errorCode", "exists", "message", "ok", "path"], label);
  for (const field of ["path", "errorCode", "message"]) {
    assertEqual(typeof binary[field], "string", `${label}.${field}`);
  }
  for (const field of ["exists", "ok"]) {
    assertEqual(typeof binary[field], "boolean", `${label}.${field}`);
  }
}

function assertNullableDiagnosticHeartbeatContract(heartbeat, label) {
  if (heartbeat === null) {
    assertEqual(heartbeat, null, label);
    return;
  }
  assertObject(heartbeat, label);
  assertExactKeys(heartbeat, [
    "compatibility",
    "device",
    "errorCode",
    "ok",
    "remoteErrorCode",
    "sentAt",
    "server",
    "serverDiagnostics",
    "status"
  ], label);
  assertEqual(typeof heartbeat.ok, "boolean", `${label}.ok`);
  for (const field of ["server", "sentAt", "errorCode", "remoteErrorCode"]) {
    assertEqual(typeof heartbeat[field], "string", `${label}.${field}`);
  }
  assertNullableNumber(heartbeat.status, `${label}.status`);
  if (heartbeat.serverDiagnostics === null) {
    assertEqual(heartbeat.serverDiagnostics, null, `${label}.serverDiagnostics`);
  } else {
    assertRuntimeDiagnosticsContract(heartbeat.serverDiagnostics, "server", `${label}.serverDiagnostics`);
  }
  assertNullableDiagnosticCompatibilityContract(heartbeat.compatibility, `${label}.compatibility`);
  assertNullableDiagnosticHeartbeatDeviceContract(heartbeat.device, `${label}.device`);
}

function assertNullableDiagnosticCompatibilityContract(compatibility, label) {
  if (compatibility === null) {
    assertEqual(compatibility, null, label);
    return;
  }
  assertCompatibilityContract(compatibility, label);
}

function summarizeCompatibilityAction(issues) {
  if (!issues.length) return "none";
  if (issues.some((issue) => issue.type === "local_missing" || issue.type === "remote_missing")) {
    return "diagnostics_missing";
  }
  const hasRemoteOlder = issues.some((issue) => issue.type === "remote_older");
  const hasRemoteNewer = issues.some((issue) => issue.type === "remote_newer");
  if (hasRemoteOlder && !hasRemoteNewer) return "upgrade_remote";
  if (hasRemoteNewer && !hasRemoteOlder) return "upgrade_local";
  return "manual_check";
}

function assertNullableDiagnosticHeartbeatDeviceContract(device, label) {
  if (device === null) {
    assertEqual(device, null, label);
    return;
  }
  assertObject(device, label);
  assertExactKeys(device, ["bucket", "enabled", "online", "prefix", "status", "sync"], label);
  for (const field of ["bucket", "prefix", "status"]) {
    assertEqual(typeof device[field], "string", `${label}.${field}`);
  }
  for (const field of ["enabled", "online"]) {
    assertEqual(typeof device[field], "boolean", `${label}.${field}`);
  }
  assertNullableDiagnosticDeviceSyncContract(device.sync, `${label}.sync`);
}

function assertNullableDiagnosticDeviceSyncContract(sync, label) {
  if (sync === null) {
    assertEqual(sync, null, label);
    return;
  }
  assertObject(sync, label);
  assertExactKeys(sync, ["currentFile", "lastRun", "scheduler", "speedMbps", "state", "syncState"], label);
  for (const field of ["currentFile", "state", "syncState"]) {
    assertEqual(typeof sync[field], "string", `${label}.${field}`);
  }
  assertNullableNumber(sync.speedMbps, `${label}.speedMbps`);
  assertNullableDiagnosticSyncRunContract(sync.lastRun, `${label}.lastRun`);
  assertNullableDiagnosticSchedulerContract(sync.scheduler, `${label}.scheduler`);
}

function assertNullableDiagnosticSchedulerContract(scheduler, label) {
  if (scheduler === null) {
    assertEqual(scheduler, null, label);
    return;
  }
  assertObject(scheduler, label);
  assertExactKeys(scheduler, ["enabled", "intervalMs", "jobs", "lastError", "lastTriggeredAt", "nextRun"], label);
  assertEqual(typeof scheduler.enabled, "boolean", `${label}.enabled`);
  assert(Number.isInteger(scheduler.intervalMs), `${label}.intervalMs`);
  assert(scheduler.intervalMs >= 0, `${label}.intervalMs`);
  for (const field of ["lastError", "lastTriggeredAt", "nextRun"]) {
    assertEqual(typeof scheduler[field], "string", `${label}.${field}`);
  }
  assertArray(scheduler.jobs, `${label}.jobs`);
  for (const [index, job] of scheduler.jobs.entries()) {
    const jobLabel = `${label}.jobs[${index}]`;
    assertObject(job, jobLabel);
    assertExactKeys(job, ["id", "lastError", "lastTriggeredAt", "name", "nextRun", "schedule", "scheduleText"], jobLabel);
    for (const field of ["id", "lastError", "lastTriggeredAt", "name", "nextRun", "scheduleText"]) {
      assertEqual(typeof job[field], "string", `${jobLabel}.${field}`);
    }
    assertObject(job.schedule, `${jobLabel}.schedule`);
  }
}

function assertNullableDiagnosticLocalStateContract(localState, label) {
  if (localState === null) {
    assertEqual(localState, null, label);
    return;
  }
  assertObject(localState, label);
  assertExactKeys(localState, ["files", "ok"], label);
  assertEqual(typeof localState.ok, "boolean", `${label}.ok`);
  assertArray(localState.files, `${label}.files`);
  localState.files.forEach((file, index) => {
    const fileLabel = `${label}.files[${index}]`;
    assertObject(file, fileLabel);
    assertExactKeys(file, ["errorCode", "exists", "message", "name", "ok"], fileLabel);
    for (const field of ["errorCode", "message", "name"]) {
      assertEqual(typeof file[field], "string", `${fileLabel}.${field}`);
    }
    for (const field of ["exists", "ok"]) {
      assertEqual(typeof file[field], "boolean", `${fileLabel}.${field}`);
    }
  });
}

function assertNullableDiagnosticSecretVaultContract(secretVault, label) {
  if (secretVault === null) {
    assertEqual(secretVault, null, label);
    return;
  }
  assertObject(secretVault, label);
  assertExactKeys(secretVault, ["backend", "missingRefs", "ok", "path", "protected", "protection", "refs"], label);
  for (const field of ["backend", "path"]) {
    assertEqual(typeof secretVault[field], "string", `${label}.${field}`);
  }
  for (const field of ["ok", "protected"]) {
    assertEqual(typeof secretVault[field], "boolean", `${label}.${field}`);
  }
  assertNullableNumber(secretVault.refs, `${label}.refs`);
  assertArray(secretVault.missingRefs, `${label}.missingRefs`);
  secretVault.missingRefs.forEach((ref, index) => assertEqual(typeof ref, "string", `${label}.missingRefs[${index}]`));
  assertObject(secretVault.protection, `${label}.protection`);
  assertExactKeys(secretVault.protection, ["exists", "mode", "protected"], `${label}.protection`);
  assertEqual(typeof secretVault.protection.exists, "boolean", `${label}.protection.exists`);
  assertEqual(typeof secretVault.protection.mode, "string", `${label}.protection.mode`);
  assertEqual(typeof secretVault.protection.protected, "boolean", `${label}.protection.protected`);
}

function assertNullableDiagnosticSyncRunContract(run, label) {
  if (run === null) {
    assertEqual(run, null, label);
    return;
  }
  assertObject(run, label);
  assertExactKeys(run, ["conflicts", "currentFile", "error", "errorCode", "finishedAt", "id", "localPath", "rawSpeed", "speedMbps", "startedAt", "status", "trigger"], label);
  for (const field of ["currentFile", "error", "errorCode", "finishedAt", "id", "localPath", "rawSpeed", "startedAt", "status", "trigger"]) {
    assertEqual(typeof run[field], "string", `${label}.${field}`);
  }
  assertNullableNumber(run.speedMbps, `${label}.speedMbps`);
  assertDiagnosticConflictsContract(run.conflicts, `${label}.conflicts`);
}

function assertDiagnosticConflictsContract(conflicts, label) {
  assertObject(conflicts, label);
  assertExactKeys(conflicts, ["count", "files", "truncated"], label);
  assertFiniteNumber(conflicts.count, `${label}.count`);
  assertArray(conflicts.files, `${label}.files`);
  conflicts.files.forEach((file, index) => assertEqual(typeof file, "string", `${label}.files[${index}]`));
  assertEqual(typeof conflicts.truncated, "boolean", `${label}.truncated`);
}

function assertDiagnosticJobContract(job, label) {
  assertObject(job, label);
  assertExactKeys(job, [
    "bandwidthLimit",
    "bucketName",
    "checkers",
    "chunkSize",
    "clientName",
    "cutoff",
    "destructiveSync",
    "direction",
    "dryRun",
    "id",
    "localPath",
    "localProxyPort",
    "lowLevelRetries",
    "name",
    "remoteFolder",
    "remoteName",
    "remotePrefix",
    "retries",
    "s3ChunkSize",
    "s3Endpoint",
    "s3UploadConcurrency",
    "schedule",
    "serverSpace",
    "streams",
    "transfers"
  ], label);
  for (const field of ["bandwidthLimit", "bucketName", "chunkSize", "clientName", "cutoff", "direction", "id", "localPath", "name", "remoteFolder", "remoteName", "remotePrefix", "s3ChunkSize", "s3Endpoint", "serverSpace"]) {
    assertEqual(typeof job[field], "string", `${label}.${field}`);
  }
  for (const field of ["destructiveSync", "dryRun"]) {
    assertEqual(typeof job[field], "boolean", `${label}.${field}`);
  }
  for (const field of ["checkers", "localProxyPort", "lowLevelRetries", "retries", "s3UploadConcurrency", "streams", "transfers"]) {
    assertNullableNumber(job[field], `${label}.${field}`);
  }
  assertNullableDiagnosticScheduleContract(job.schedule, `${label}.schedule`);
}

function assertNullableDiagnosticScheduleContract(schedule, label) {
  if (schedule === null) {
    assertEqual(schedule, null, label);
    return;
  }
  assertObject(schedule, label);
  assertExactKeys(schedule, ["intervalMinutes", "mode", "timeOfDay"], label);
  assertEqual(typeof schedule.mode, "string", `${label}.mode`);
  assertNullableNumber(schedule.intervalMinutes, `${label}.intervalMinutes`);
  assertEqual(typeof schedule.timeOfDay, "string", `${label}.timeOfDay`);
}

function assertDiagnosticEnvironmentContract(environment, label, options = {}) {
  assertObject(environment, label);
  if (options.strictEnvironment !== false) {
    for (const field of ["node", "platform", "arch", "cwd", "appRoot", "root", "dataRoot"]) {
      assertEqual(typeof environment[field], "string", `${label}.${field}`);
    }
    assertFiniteNumber(environment.pid, `${label}.pid`);
    assertFiniteNumber(environment.uptimeSeconds, `${label}.uptimeSeconds`);
    assertEqual(typeof environment.portableRoot, "boolean", `${label}.portableRoot`);
    assertObject(environment.binaries, `${label}.binaries`);
    for (const field of ["singbox", "rclone"]) {
      assertFileSummaryContract(environment.binaries[field], `${label}.binaries.${field}`);
      assertNoLocalDiagnosticPaths(environment.binaries[field].path, `${label}.binaries.${field}.path`);
    }
    assertObject(environment.stateFiles, `${label}.stateFiles`);
    for (const field of ["profile", "jobs", "secrets", "syncHistory", "claimRecovery", "lastSuccessfulHeartbeat"]) {
      assertFileSummaryContract(environment.stateFiles[field], `${label}.stateFiles.${field}`);
      assertNoLocalDiagnosticPaths(environment.stateFiles[field].path, `${label}.stateFiles.${field}.path`);
    }
    assertObject(environment.logFiles, `${label}.logFiles`);
    for (const field of DIAGNOSTIC_LOG_NAMES) {
      assertFileSummaryContract(environment.logFiles[field], `${label}.logFiles.${field}`);
      assertNoLocalDiagnosticPaths(environment.logFiles[field].path, `${label}.logFiles.${field}.path`);
    }
  }
  if (environment.releaseManifest !== undefined && environment.releaseManifest !== null) {
    assertReleaseManifestSummaryContract(environment.releaseManifest, `${label}.releaseManifest`);
  }
}

function assertReleaseManifestSummaryContract(manifest, label) {
  assertFileSummaryContract(manifest, label);
  assertEqual(typeof manifest.ok, "boolean", `${label}.ok`);
  assert(manifest.schemaVersion === null || Number.isInteger(manifest.schemaVersion), `${label}.schemaVersion`);
  for (const field of ["package", "version", "errorCode", "message"]) {
    assertEqual(typeof manifest[field], "string", `${label}.${field}`);
  }
  assertNullableString(manifest.builtAt, `${label}.builtAt`);
  assert(Number.isInteger(manifest.fileCount), `${label}.fileCount`);
  assertManifestFileGroupContract(manifest.supportDocuments, `${label}.supportDocuments`, { requirePackage: false });
  assertManifestFileGroupContract(manifest.requiredFiles, `${label}.requiredFiles`, { requirePackage: true });
}

function assertManifestFileGroupContract(group, label, options = {}) {
  assertObject(group, label);
  assertEqual(typeof group.ok, "boolean", `${label}.ok`);
  if (options.requirePackage && Object.hasOwn(group, "package")) {
    assertEqual(typeof group.package, "string", `${label}.package`);
  }
  assertArray(group.files, `${label}.files`);
  for (const [index, file] of group.files.entries()) {
    const fileLabel = `${label}.files[${index}]`;
    assertObject(file, fileLabel);
    for (const field of ["name", "path", "sha256"]) {
      assertEqual(typeof file[field], "string", `${fileLabel}.${field}`);
    }
    assertEqual(typeof file.present, "boolean", `${fileLabel}.present`);
    assertEqual(typeof file.valid, "boolean", `${fileLabel}.valid`);
    assertFiniteNumber(file.size, `${fileLabel}.size`);
  }
}

function assertDiagnosticLogsContract(logs, label, options = {}) {
  assertObject(logs, label);
  if (options.strictLogs !== false) {
    assertExactKeys(logs, DIAGNOSTIC_LOG_NAMES, label);
  }
  const names = options.strictLogs === false ? Object.keys(logs) : DIAGNOSTIC_LOG_NAMES;
  for (const name of names) {
    assertDiagnosticLogMetaContract(logs[name], `${label}.${name}`, options);
  }
}

export function assertDiagnosticLogMetaContract(log, label = "diagnosticLog", options = {}) {
  assertObject(log, label);
  assertExactKeys(log, ["exists", "maxChars", "modifiedAt", "path", "size", "text", "truncated"], label);
  assertEqual(typeof log.path, "string", `${label}.path`);
  assertEqual(typeof log.exists, "boolean", `${label}.exists`);
  assertFiniteNumber(log.size, `${label}.size`);
  assertNullableString(log.modifiedAt, `${label}.modifiedAt`);
  assertFiniteNumber(log.maxChars, `${label}.maxChars`);
  assertEqual(typeof log.truncated, "boolean", `${label}.truncated`);
  assertEqual(typeof log.text, "string", `${label}.text`);
  if (log.exists === false) {
    assertEqual(log.text, "", `${label}.text`);
  }
  assertNoRawDiagnosticSecrets(log.text, `${label}.text`, options);
  assertNoLocalDiagnosticPaths(log.text, `${label}.text`);
}

function assertFileSummaryContract(file, label) {
  assertObject(file, label);
  assertEqual(typeof file.path, "string", `${label}.path`);
  assertEqual(typeof file.exists, "boolean", `${label}.exists`);
  assertFiniteNumber(file.size, `${label}.size`);
  assertNullableString(file.modifiedAt, `${label}.modifiedAt`);
}

function assertNoLocalDiagnosticPaths(value, label = "diagnostic") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!/[A-Za-z]:\\/.test(text), `${label} contains a Windows local path`);
  assert(!/\/(?:Users|home|tmp|var|opt|Volumes)\//.test(text), `${label} contains a Unix local path`);
  assert(!/"(?:cwd|appRoot|root|dataRoot|binRoot|localPath|rcloneConfigScope|currentFile|heartbeatDeviceCurrentFile)":"(?!(?:redacted)?")/.test(text), `${label} contains an unredacted local path field`);
}

function assertNoSupportPrivateDiagnosticValues(value, label = "diagnostic") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!/"(?:id|userId|deviceId|profileId|server|serverUrl|sourceServer|clientName|profileClientName|accessKeyId|s3AccessKeyId|bucket|bucketName|prefix|remotePrefix|remotePath|serverSubdir|heartbeatDeviceBucket|heartbeatDevicePrefix|endpoint|internalEndpoint|s3Endpoint|storage)":"(?!(?:redacted)?")/.test(text), `${label} contains an unredacted support-private identifier field`);
}

function assertClientBinariesPresenceContract(binaries, label) {
  assertObject(binaries, label);
  assertExactKeys(binaries, ["rclone", "singbox"], label);
  assertClientBinaryPresenceContract(binaries.singbox, `${label}.singbox`, "missing_singbox_binary");
  assertClientBinaryPresenceContract(binaries.rclone, `${label}.rclone`, "missing_rclone_binary");
}

function assertClientBinaryPresenceContract(binary, label, missingCode) {
  assertObject(binary, label);
  for (const field of ["path", "errorCode", "message"]) {
    assertEqual(typeof binary[field], "string", `${label}.${field}`);
  }
  assertEqual(typeof binary.exists, "boolean", `${label}.exists`);
  assertEqual(typeof binary.ok, "boolean", `${label}.ok`);
  assertStableErrorCode(binary.errorCode, `${label}.errorCode`);
  if (binary.exists === false) {
    assertEqual(binary.ok, false, `${label}.ok`);
    assertEqual(binary.errorCode, missingCode, `${label}.errorCode`);
    assert(binary.message.length > 0, `${label}.message`);
  }
  if (binary.exists === true && binary.ok === true) {
    assertEqual(binary.errorCode, "", `${label}.errorCode`);
  }
}

function assertClientBinaryCheckContract(binary, label, missingCode) {
  assertObject(binary, label);
  assertExactKeys(binary, ["path", "exists", "ok", "errorCode", "message", "version"], label);
  assertClientBinaryPresenceContract(binary, label, missingCode);
  if (binary.exists === false) {
    assertEqual(binary.version, null, `${label}.version`);
    return;
  }
  assertObject(binary.version, `${label}.version`);
  assertEqual(typeof binary.version.executable, "string", `${label}.version.executable`);
  assertArray(binary.version.args, `${label}.version.args`);
  assertNullableString(binary.version.startedAt, `${label}.version.startedAt`);
  assertNullableString(binary.version.finishedAt, `${label}.version.finishedAt`);
  assertEqual(typeof binary.version.ok, "boolean", `${label}.version.ok`);
  assert(binary.version.exitCode === null || Number.isInteger(binary.version.exitCode), `${label}.version.exitCode`);
  assertEqual(binary.ok, binary.version.ok, `${label}.ok`);
  if (Object.hasOwn(binary.version, "stdout")) {
    assertEqual(typeof binary.version.stdout, "string", `${label}.version.stdout`);
  }
  if (Object.hasOwn(binary.version, "stderr")) {
    assertEqual(typeof binary.version.stderr, "string", `${label}.version.stderr`);
  }
  if (Object.hasOwn(binary.version, "error")) {
    assertEqual(typeof binary.version.error, "string", `${label}.version.error`);
  }
  if (Object.hasOwn(binary.version, "timedOut")) {
    assertEqual(typeof binary.version.timedOut, "boolean", `${label}.version.timedOut`);
  }
  if (binary.ok === false) {
    assert(binary.errorCode.length > 0, `${label}.errorCode`);
    assert(binary.message.length > 0, `${label}.message`);
  }
}

export function assertDeviceSyncContract(sync, label = "sync") {
  assertObject(sync, label);
  assert(SYNC_STATES.includes(sync.state), `${label}.state`);
  assertFiniteNumber(sync.speedMbps, `${label}.speedMbps`);
  assertNullableNumber(sync.progressPercent, `${label}.progressPercent`);
  assertEqual(typeof sync.currentFile, "string", `${label}.currentFile`);
  assertConflictsContract(sync.conflicts, `${label}.conflicts`);
  assert(Object.hasOwn(sync, "currentJob"), `${label}.currentJob`);
  assert(sync.currentJob === null || (typeof sync.currentJob === "object" && !Array.isArray(sync.currentJob)), `${label}.currentJob`);
  if (sync.currentJob !== null) {
    assertObject(sync.currentJob, `${label}.currentJob`);
    for (const field of ["name", "direction", "bucketName", "remotePrefix"]) {
      assertEqual(typeof sync.currentJob[field], "string", `${label}.currentJob.${field}`);
    }
  }
  assert(Object.hasOwn(sync, "lastRun"), `${label}.lastRun`);
  assert(sync.lastRun === null || (typeof sync.lastRun === "object" && !Array.isArray(sync.lastRun)), `${label}.lastRun`);
  if (sync.lastRun !== null) {
    assertSyncRunContract(sync.lastRun, `${label}.lastRun`);
  }
  assert(Object.hasOwn(sync, "scheduler"), `${label}.scheduler`);
  assert(sync.scheduler === null || (typeof sync.scheduler === "object" && !Array.isArray(sync.scheduler)), `${label}.scheduler`);
  if (sync.scheduler !== null) {
    assertSchedulerContract(sync.scheduler, `${label}.scheduler`);
  }
}

export function assertSyncRunContract(run, label = "sync.lastRun") {
  assertObject(run, label);
  assertExactKeys(run, [
    "conflicts",
    "currentFile",
    "error",
    "errorCode",
    "exitCode",
    "finishedAt",
    "id",
    "job",
    "localPath",
    "progressPercent",
    "rawSpeed",
    "speedMbps",
    "startedAt",
    "status",
    "transferredSizeText",
    "trigger"
  ], label);
  for (const field of ["id", "status", "trigger", "localPath", "errorCode", "error", "transferredSizeText", "currentFile", "rawSpeed"]) {
    assertEqual(typeof run[field], "string", `${label}.${field}`);
  }
  assert(["running", "success", "error", "stopped", "unknown"].includes(run.status), `${label}.status`);
  assert(["manual", "scheduler"].includes(run.trigger), `${label}.trigger`);
  assertNullableString(run.startedAt, `${label}.startedAt`);
  assertNullableString(run.finishedAt, `${label}.finishedAt`);
  if (run.job !== null && run.job !== undefined) {
    assertObject(run.job, `${label}.job`);
    for (const field of ["name", "direction", "bucketName", "remotePrefix"]) {
      assertEqual(typeof run.job[field], "string", `${label}.job.${field}`);
    }
  }
  assert(run.exitCode === null || Number.isInteger(run.exitCode), `${label}.exitCode`);
  assertNullableNumber(run.progressPercent, `${label}.progressPercent`);
  assertFiniteNumber(run.speedMbps, `${label}.speedMbps`);
  assertStableErrorCode(run.errorCode, `${label}.errorCode`);
  if (run.status !== "error") {
    assertEqual(run.errorCode, "", `${label}.errorCode`);
    assertEqual(run.error, "", `${label}.error`);
  }
  assertConflictsContract(run.conflicts, `${label}.conflicts`);
  assert(Object.hasOwn(run, "job"), `${label}.job`);
  assert(run.job === null || (typeof run.job === "object" && !Array.isArray(run.job)), `${label}.job`);
  assertNoRawDiagnosticSecrets(run, label);
}

export function assertClientSyncHistoryContract(response, label = "syncHistory") {
  assertObject(response, label);
  assertExactKeys(response, ["history"], label);
  assertArray(response.history, `${label}.history`);
  for (const [index, run] of response.history.entries()) {
    assertSyncRunContract(run, `${label}.history[${index}]`);
  }
  assertNoRawDiagnosticSecrets(response, label);
}

export function assertSchedulerContract(scheduler, label = "scheduler") {
  assertObject(scheduler, label);
  assertEqual(typeof scheduler.enabled, "boolean", `${label}.enabled`);
  assert(Number.isInteger(scheduler.intervalMs), `${label}.intervalMs`);
  assert(scheduler.intervalMs >= 0, `${label}.intervalMs`);
  if (Object.hasOwn(scheduler, "updatedAt")) {
    assertNullableString(scheduler.updatedAt, `${label}.updatedAt`);
  }
  assertNullableString(scheduler.nextRun, `${label}.nextRun`);
  assertNullableString(scheduler.lastTriggeredAt, `${label}.lastTriggeredAt`);
  assertStableErrorCode(scheduler.lastError, `${label}.lastError`);
  assertArray(scheduler.jobs, `${label}.jobs`);
  for (const [index, job] of scheduler.jobs.entries()) {
    const jobLabel = `${label}.jobs[${index}]`;
    assertObject(job, jobLabel);
    for (const field of ["id", "name", "scheduleText"]) {
      assertEqual(typeof job[field], "string", `${jobLabel}.${field}`);
      assert(job[field] !== "", `${jobLabel}.${field}`);
    }
    assertObject(job.schedule, `${jobLabel}.schedule`);
    assertNullableString(job.nextRun, `${jobLabel}.nextRun`);
    assertNullableString(job.lastTriggeredAt, `${jobLabel}.lastTriggeredAt`);
    assertStableErrorCode(job.lastError, `${jobLabel}.lastError`);
  }
}

export function assertNoRawSecrets(value, label = "value") {
  for (const field of ["secretAccessKey", "privateKey", "heartbeatSecret", "heartbeatAuthNonces", "tKey", "claimCode", "token", "profile"]) {
    assertEqual(Object.hasOwn(value, field), false, `${label} leaked raw ${field}`);
  }
}

function assertAdminAuthCheckSummaryContract(adminAuth, label) {
  assertObject(adminAuth, label);
  assertExactKeys(adminAuth, ["enabled"], label);
  assertEqual(typeof adminAuth.enabled, "boolean", `${label}.enabled`);
}

function assertServerSingboxConfigContract(config, state, label) {
  assertObject(config, label);
  assertExactKeys(config, ["inbounds", "log", "outbounds", "route"], label);

  assertObject(config.log, `${label}.log`);
  assertExactKeys(config.log, ["level", "timestamp"], `${label}.log`);
  assertEqual(typeof config.log.level, "string", `${label}.log.level`);
  assertEqual(config.log.timestamp, true, `${label}.log.timestamp`);

  assertArray(config.inbounds, `${label}.inbounds`);
  assert(config.inbounds.length >= 1, `${label}.inbounds`);
  const inbound = config.inbounds[0];
  assertObject(inbound, `${label}.inbounds[0]`);
  const expectedInboundKeys = ["listen", "listen_port", "tag", "type", "users"];
  const expectedSecurity = state?.tunnel?.security;
  if (expectedSecurity === "reality" || inbound.tls !== undefined) {
    expectedInboundKeys.push("tls");
  }
  if (state?.tunnel?.transport === "ws") {
    expectedInboundKeys.push("transport");
  }
  assertExactKeys(inbound, expectedInboundKeys, `${label}.inbounds[0]`);
  assertEqual(inbound.type, "vless", `${label}.inbounds[0].type`);
  assertEqual(inbound.tag, "vless-in", `${label}.inbounds[0].tag`);
  assertEqual(typeof inbound.listen, "string", `${label}.inbounds[0].listen`);
  assertTcpPort(inbound.listen_port, `${label}.inbounds[0].listen_port`);
  if (state) {
    assertEqual(inbound.listen, state.tunnel.listenHost, `${label}.inbounds[0].listen`);
    assertEqual(inbound.listen_port, state.tunnel.listenPort, `${label}.inbounds[0].listen_port`);
  }

  assertArray(inbound.users, `${label}.inbounds[0].users`);
  for (const [index, user] of inbound.users.entries()) {
    const userLabel = `${label}.inbounds[0].users[${index}]`;
    assertObject(user, userLabel);
    assertExactKeys(user, ["name", "uuid"], userLabel);
    assertNonEmptyString(user.name, `${userLabel}.name`);
    assertNonEmptyString(user.uuid, `${userLabel}.uuid`);
  }
  if (state) {
    const activeUsers = state.users.filter((user) => user.enabled !== false && !user.deletedAt);
    assertEqual(inbound.users.length, activeUsers.length, `${label}.inbounds[0].users.length`);
    for (const user of activeUsers) {
      assert(
        inbound.users.some((item) => item.name === user.clientName && item.uuid === user.uuid),
        `${label}.inbounds[0].users.${user.clientName}`
      );
    }
  }

  if (expectedSecurity === "reality" || inbound.tls !== undefined) {
    assertObject(inbound.tls, `${label}.inbounds[0].tls`);
    assertExactKeys(inbound.tls, ["enabled", "reality", "server_name"], `${label}.inbounds[0].tls`);
    assertEqual(inbound.tls.enabled, true, `${label}.inbounds[0].tls.enabled`);
    assertNonEmptyString(inbound.tls.server_name, `${label}.inbounds[0].tls.server_name`);
    if (state) {
      assertEqual(inbound.tls.server_name, state.tunnel.reality.serverName, `${label}.inbounds[0].tls.server_name`);
    }
    assertObject(inbound.tls.reality, `${label}.inbounds[0].tls.reality`);
    assertExactKeys(inbound.tls.reality, ["enabled", "handshake", "private_key", "short_id"], `${label}.inbounds[0].tls.reality`);
    assertEqual(inbound.tls.reality.enabled, true, `${label}.inbounds[0].tls.reality.enabled`);
    assertObject(inbound.tls.reality.handshake, `${label}.inbounds[0].tls.reality.handshake`);
    assertExactKeys(inbound.tls.reality.handshake, ["server", "server_port"], `${label}.inbounds[0].tls.reality.handshake`);
    assertNonEmptyString(inbound.tls.reality.handshake.server, `${label}.inbounds[0].tls.reality.handshake.server`);
    assertTcpPort(inbound.tls.reality.handshake.server_port, `${label}.inbounds[0].tls.reality.handshake.server_port`);
    if (state) {
      assertEqual(inbound.tls.reality.handshake.server, state.tunnel.reality.serverName, `${label}.inbounds[0].tls.reality.handshake.server`);
    }
    assertMaskedSecret(inbound.tls.reality.private_key, `${label}.inbounds[0].tls.reality.private_key`);
    assertArray(inbound.tls.reality.short_id, `${label}.inbounds[0].tls.reality.short_id`);
    for (const [index, shortId] of inbound.tls.reality.short_id.entries()) {
      assertEqual(typeof shortId, "string", `${label}.inbounds[0].tls.reality.short_id[${index}]`);
    }
    if (state?.tunnel?.reality?.shortId) {
      assert(inbound.tls.reality.short_id.includes(state.tunnel.reality.shortId), `${label}.inbounds[0].tls.reality.short_id`);
    }
  } else {
    assertEqual(Object.hasOwn(inbound, "tls"), false, `${label}.inbounds[0].tls`);
  }

  if (state?.tunnel?.transport === "ws") {
    assertObject(inbound.transport, `${label}.inbounds[0].transport`);
    assertExactKeys(inbound.transport, ["path", "type"], `${label}.inbounds[0].transport`);
    assertEqual(inbound.transport.type, "ws", `${label}.inbounds[0].transport.type`);
    assertEqual(inbound.transport.path, state.tunnel.transportPath, `${label}.inbounds[0].transport.path`);
    assertEqual(inbound.tls, undefined, `${label}.inbounds[0].tls`);
  }

  assertArray(config.outbounds, `${label}.outbounds`);
  assert(config.outbounds.length >= 1, `${label}.outbounds`);
  assertObject(config.outbounds[0], `${label}.outbounds[0]`);
  assertEqual(config.outbounds[0].type, "direct", `${label}.outbounds[0].type`);
  assertEqual(config.outbounds[0].tag, "direct", `${label}.outbounds[0].tag`);
  assertObject(config.route, `${label}.route`);
  assertEqual(config.route.final, "direct", `${label}.route.final`);
}

function assertStorageBucketOperationSummaryContract(bucket, label) {
  assertObject(bucket, label);
  assertExactKeys(bucket, ["clearedAt", "createdAt", "disabledAt", "name", "objectCount", "sizeBytes", "source"], label);
  for (const field of ["name", "source"]) {
    assertNonEmptyString(bucket[field], `${label}.${field}`);
  }
  assertNullableString(bucket.createdAt, `${label}.createdAt`);
  assertNullableString(bucket.disabledAt, `${label}.disabledAt`);
  assertNullableString(bucket.clearedAt, `${label}.clearedAt`);
  assertNullableNumber(bucket.objectCount, `${label}.objectCount`);
  assertNullableNumber(bucket.sizeBytes, `${label}.sizeBytes`);
}

function assertStorageBucketProvisionResultContract(provision, label) {
  assertObject(provision, label);
  assertEqual(typeof provision.ok, "boolean", `${label}.ok`);
  if (provision.ok) {
    assertExactKeys(provision, ["ok"], label);
    return;
  }
  assertExactKeys(provision, ["errorCode", "ok", "warning"], label);
  assertEqual(provision.errorCode, "storage_request_failed", `${label}.errorCode`);
  assertNonEmptyString(provision.warning, `${label}.warning`);
}

function assertStateContainsStorageBucket(state, bucketName, label) {
  assertObject(state, label.replace(/\.storage\.buckets$/, ""));
  assertObject(state.storage, `${label.replace(/\.buckets$/, "")}`);
  assertArray(state.storage.buckets, label);
  const bucket = state.storage.buckets.find((item) => item.name === bucketName);
  assert(Boolean(bucket), label);
  return bucket;
}

function assertStateContainsAdminUser(state, userId, label) {
  assertObject(state, label.replace(/\.users$/, ""));
  assertArray(state.users, label);
  const user = state.users.find((item) => item.id === userId);
  assert(Boolean(user), label);
  return user;
}

function assertNoRawProfileSecrets(value, label) {
  const forbiddenKeys = new Set([
    "accessKeyId",
    "secretAccessKey",
    "s3SecretAccessKey",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "secret",
    "uri",
    "vlessUri",
    "tunnelUri",
    "tKey",
    "tKeyUri",
    "claimCode",
    "token",
    "profile"
  ]);
  walkValue(value, label, (current, currentLabel) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const key of Object.keys(current)) {
        assert(!forbiddenKeys.has(key), `${currentLabel} leaked raw ${key}`);
      }
    }
    if (typeof current === "string") {
      assert(!current.includes("vless://"), `${currentLabel} leaked VLESS URI`);
      assert(!current.includes("SFSC1-"), `${currentLabel} leaked SyncKey`);
      assert(!current.includes("sfsc://import/v1#"), `${currentLabel} leaked SyncKey URI`);
    }
  });
}

function walkValue(value, label, visit) {
  visit(value, label);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValue(item, `${label}[${index}]`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkValue(child, `${label}.${key}`, visit);
    }
  }
}

function assertNoRawClaimSecrets(claim, label) {
  for (const field of ["profile", "tKey", "tKeyUri", "claimCode", "token", "uri", "secretAccessKey", "heartbeatSecret", "heartbeatAuthNonces", "vlessUri"]) {
    assertEqual(Object.hasOwn(claim, field), false, `${label} leaked raw ${field}`);
  }
  const text = JSON.stringify(claim);
  assert(!text.includes("SFSC1-"), `${label} leaked full SyncKey`);
  assert(!text.includes("sfsc://import/v1#"), `${label} leaked SyncKey URI`);
  assert(!text.includes("vless://"), `${label} leaked VLESS URI`);
}

function assertParsedVlessProfileContract(profile, label) {
  assertObject(profile, label);
  assertExactKeys(profile, [
    "alpn",
    "fingerprint",
    "flow",
    "host",
    "name",
    "params",
    "path",
    "port",
    "publicKey",
    "raw",
    "security",
    "server",
    "shortId",
    "sni",
    "transport",
    "uuid"
  ], label);
  for (const field of ["name", "raw", "uuid", "server", "security", "transport", "flow", "sni", "fingerprint", "publicKey", "shortId", "path", "host"]) {
    assertEqual(typeof profile[field], "string", `${label}.${field}`);
  }
  assertMatch(profile.raw, /^vless:\/\//, `${label}.raw`);
  assertMatch(profile.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${label}.uuid`);
  assertTcpPort(profile.port, `${label}.port`);
  assertEqual(profile.transport || "tcp", profile.transport, `${label}.transport`);
  assertArray(profile.alpn, `${label}.alpn`);
  for (const [index, value] of profile.alpn.entries()) {
    assertEqual(typeof value, "string", `${label}.alpn[${index}]`);
  }
  assertObject(profile.params, `${label}.params`);
  assert(!JSON.stringify(profile).includes("SFSC1-"), `${label} leaked SyncKey`);
  assert(!JSON.stringify(profile).includes("sfsc://import/v1#"), `${label} leaked import URI`);
}

function assertClientSingboxConfigContract(config, label, options = {}) {
  assertObject(config, label);
  assertObject(config.log, `${label}.log`);
  assertEqual(typeof config.log.level, "string", `${label}.log.level`);
  assertEqual(config.log.timestamp, true, `${label}.log.timestamp`);
  assertArray(config.inbounds, `${label}.inbounds`);
  assertArray(config.outbounds, `${label}.outbounds`);
  assertObject(config.route, `${label}.route`);
  assertEqual(config.route.final, "vless-out", `${label}.route.final`);

  const inbound = config.inbounds[0];
  assertObject(inbound, `${label}.inbounds[0]`);
  assertEqual(inbound.type, "mixed", `${label}.inbounds[0].type`);
  assertEqual(inbound.tag, "local-rclone-proxy", `${label}.inbounds[0].tag`);
  assertEqual(inbound.listen, "127.0.0.1", `${label}.inbounds[0].listen`);
  assertTcpPort(inbound.listen_port, `${label}.inbounds[0].listen_port`);
  if (options.localProxyPort !== undefined) {
    assertEqual(inbound.listen_port, options.localProxyPort, `${label}.inbounds[0].listen_port`);
  }
  assertEqual(inbound.sniff, false, `${label}.inbounds[0].sniff`);

  const outbound = config.outbounds[0];
  assertObject(outbound, `${label}.outbounds[0]`);
  assertEqual(outbound.type, "vless", `${label}.outbounds[0].type`);
  assertEqual(outbound.tag, "vless-out", `${label}.outbounds[0].tag`);
  assertEqual(outbound.packet_encoding, "", `${label}.outbounds[0].packet_encoding`);
  assertObject(outbound.multiplex, `${label}.outbounds[0].multiplex`);
  assertEqual(outbound.multiplex.enabled, false, `${label}.outbounds[0].multiplex.enabled`);
  assertObject(config.outbounds[1], `${label}.outbounds[1]`);
  assertEqual(config.outbounds[1].type, "direct", `${label}.outbounds[1].type`);
  assertEqual(config.outbounds[1].tag, "direct", `${label}.outbounds[1].tag`);

  if (options.profile) {
    assertEqual(outbound.server, options.profile.server, `${label}.outbounds[0].server`);
    assertEqual(outbound.server_port, options.profile.port, `${label}.outbounds[0].server_port`);
    assertEqual(outbound.uuid, options.profile.uuid, `${label}.outbounds[0].uuid`);
    if (options.profile.security === "none") {
      assertEqual(Object.hasOwn(outbound, "tls"), false, `${label}.outbounds[0].tls`);
    }
    if (options.profile.security === "reality") {
      assertObject(outbound.tls, `${label}.outbounds[0].tls`);
      assertEqual(outbound.tls.enabled, true, `${label}.outbounds[0].tls.enabled`);
      assertObject(outbound.tls.reality, `${label}.outbounds[0].tls.reality`);
      assertEqual(outbound.tls.reality.enabled, true, `${label}.outbounds[0].tls.reality.enabled`);
      assertEqual(outbound.tls.reality.public_key, options.profile.publicKey, `${label}.outbounds[0].tls.reality.public_key`);
      assertEqual(outbound.tls.reality.short_id, options.profile.shortId, `${label}.outbounds[0].tls.reality.short_id`);
    }
  }

  const text = JSON.stringify(config);
  assert(!text.includes('"tun"'), `${label} uses TUN`);
  assert(!text.includes("system_proxy"), `${label} mutates system proxy`);
  assert(!text.includes('"auto_route"'), `${label} mutates routes`);
  assert(!text.includes("SFSC1-"), `${label} leaked SyncKey`);
  assert(!text.includes("sfsc://import/v1#"), `${label} leaked import URI`);
}

function assertServerIssuedProfileDefaultsContract(defaults, label) {
  assertObject(defaults, label);
  assertExactKeys(defaults, ["bandwidthLimit", "checkers", "chunkSize", "localProxyPort", "lowLevelRetries", "retries", "schedule", "streams", "transfers"], label);
  assertTcpPort(defaults.localProxyPort, `${label}.localProxyPort`);
  for (const field of ["transfers", "streams", "checkers", "retries", "lowLevelRetries"]) {
    assertPositiveInteger(defaults[field], `${label}.${field}`);
  }
  assertNonEmptyString(defaults.chunkSize, `${label}.chunkSize`);
  assertBandwidthLimitContract(defaults.bandwidthLimit, `${label}.bandwidthLimit`);
  assertScheduleContract(defaults.schedule, `${label}.schedule`);
}

function assertBandwidthLimitContract(value, label) {
  assertEqual(typeof value, "string", label);
  assert(
    value === "off"
      || /^[1-9]\d*[kMG]$/.test(value)
      || /^\d{2}:\d{2},[1-9]\d*[kMG]\s+\d{2}:\d{2},off$/.test(value),
    label
  );
}

function assertScheduleContract(schedule, label) {
  assertObject(schedule, label);
  assert(["manual", "interval", "daily", "startup"].includes(schedule.mode), `${label}.mode`);
  if (schedule.mode === "interval") {
    assertPositiveInteger(schedule.intervalMinutes, `${label}.intervalMinutes`);
    assert(schedule.intervalMinutes <= 1440, `${label}.intervalMinutes`);
  }
  if (schedule.mode === "daily") {
    assertMatch(schedule.time, /^([01]\d|2[0-3]):[0-5]\d$/, `${label}.time`);
  }
}

function assertNoUnexpectedIssuedProfileSecrets(profile, label) {
  const forbiddenKeys = new Set([
    "privateKey",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "tKey",
    "tKeyUri",
    "claimCode",
    "token",
    "profile",
    "vlessUri"
  ]);
  walkValue(profile, label, (current, currentLabel) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const key of Object.keys(current)) {
        assert(!forbiddenKeys.has(key), `${currentLabel} leaked raw ${key}`);
      }
    }
    if (typeof current === "string") {
      assert(!current.includes("SFSC1-"), `${currentLabel} leaked SyncKey`);
      assert(!current.includes("sfsc://import/v1#"), `${currentLabel} leaked SyncKey URI`);
    }
  });
}

function assertNoRawClientJobSecrets(job, label) {
  const forbiddenKeys = new Set([
    "accessKeyId",
    "secret",
    "secretRef",
    "secretAccessKey",
    "s3SecretAccessKey",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "privateKey",
    "private_key",
    "vlessUri",
    "tunnelUri",
    "tKey",
    "tKeyUri",
    "claimCode",
    "token",
    "profile",
    "uri"
  ]);
  walkValue(job, label, (current, currentLabel) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const key of Object.keys(current)) {
        assert(!forbiddenKeys.has(key), `${currentLabel} leaked raw ${key}`);
      }
    }
    if (typeof current === "string") {
      assert(!current.includes("SFSC1-"), `${currentLabel} leaked SyncKey`);
      assert(!current.includes("sfsc://import/v1#"), `${currentLabel} leaked SyncKey URI`);
      assert(!/vless:\/\//i.test(current), `${currentLabel} leaked VLESS URI`);
    }
  });
}

function assertClientProcessStatusContract(status, label, expectedName, options = {}) {
  assertObject(status, label);
  if (options.exactKeys) {
    assertRequiredAndOptionalKeys(status, options.exactKeys, options.optionalKeys || [], label);
  }
  assertEqual(status.name, expectedName, `${label}.name`);
  assertEqual(typeof status.running, "boolean", `${label}.running`);
  assert(status.pid === null || Number.isInteger(status.pid), `${label}.pid`);
  assertNullableString(status.startedAt, `${label}.startedAt`);
  assert(status.lastExit === null || (typeof status.lastExit === "object" && !Array.isArray(status.lastExit)), `${label}.lastExit`);
  if (Object.hasOwn(status, "stopSignal")) {
    assertNullableString(status.stopSignal, `${label}.stopSignal`);
  }
  if (Object.hasOwn(status, "stopTimedOut")) {
    assertEqual(typeof status.stopTimedOut, "boolean", `${label}.stopTimedOut`);
  }
  if (status.lastExit !== null) {
    assertEqual(typeof status.lastExit.ok, "boolean", `${label}.lastExit.ok`);
    assertNullableString(status.lastExit.errorCode ?? null, `${label}.lastExit.errorCode`);
    assertNullableString(status.lastExit.error ?? null, `${label}.lastExit.error`);
    assertNullableString(status.lastExit.at ?? null, `${label}.lastExit.at`);
  }
  assertNoRawDiagnosticSecrets(status, label);
}

function assertNoRawAdminUserSecrets(user, label) {
  const forbiddenTopLevelKeys = [
    "secretAccessKey",
    "privateKey",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "tKey",
    "tKeyUri",
    "claimCode",
    "token",
    "profile",
    "uri"
  ];
  for (const field of forbiddenTopLevelKeys) {
    assertEqual(Object.hasOwn(user, field), false, `${label} leaked raw ${field}`);
  }
  const storageText = JSON.stringify(user.storage);
  assert(!storageText.includes("SFSC1-"), `${label}.storage leaked full SyncKey`);
  assert(!storageText.includes("sfsc://import/v1#"), `${label}.storage leaked SyncKey URI`);
  assert(!storageText.includes("vless://"), `${label}.storage leaked VLESS URI`);
}

function assertNoRawAdminWriteResponseSecrets(value, label, options = {}) {
  const sensitiveKeys = new Set([
    "secret",
    "secretAccessKey",
    "secret_access_key",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "password",
    "privateKey",
    "private_key",
    "authorization",
    "adminToken",
    "token",
    "tKey",
    "tKeyUri",
    "claimCode"
  ]);
  const rawSecrets = options.rawSecrets || [];
  walkValue(value, label, (current, currentLabel) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (sensitiveKeys.has(key)) {
          assert(child === null || child === undefined || child === "" || child === "****" || isMaskedSecretText(child), `${currentLabel}.${key} leaked raw ${key}`);
        }
      }
    }
    if (typeof current === "string") {
      assert(!current.includes("SFSC1-"), `${currentLabel} leaked SyncKey`);
      assert(!current.includes("sfsc://import/v1#"), `${currentLabel} leaked import URI`);
      for (const secret of rawSecrets) {
        const text = String(secret || "");
        if (text.length >= 4) {
          assert(!current.includes(text), `${currentLabel} leaked raw secret`);
        }
      }
    }
  });
}

function isMaskedSecretText(value) {
  return typeof value === "string" && value.includes("***");
}

function assertPreviewDisplayTextIsSafe(text, label, options = {}) {
  assert(!text.includes("SFSC1-"), `${label} leaked SyncKey`);
  assert(!text.includes("sfsc://import/v1#"), `${label} leaked import URI`);
  assert(!/vless:\/\//i.test(text), `${label} leaked VLESS URI`);
  const rawSecrets = [...(options.rawSecrets || []), options.remoteConfigSecret];
  for (const secret of rawSecrets) {
    const value = String(secret || "");
    if (value.length >= 4) {
      assert(!text.includes(value), `${label} leaked raw secret`);
    }
  }
}

function assertNoRawDiagnosticSecrets(value, label, options = {}) {
  const sensitiveKeys = new Set([
    "secret",
    "secretAccessKey",
    "secret_access_key",
    "heartbeatSecret",
    "heartbeatAuthNonces",
    "password",
    "privateKey",
    "private_key",
    "authorization",
    "adminToken",
    "token",
    "tKey",
    "claimCode",
    "vlessUri"
  ]);
  const rawSecrets = options.rawSecrets || [];
  walkValue(value, label, (current, currentLabel) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (sensitiveKeys.has(key)) {
          assert(child === null || child === undefined || child === "" || child === "****", `${currentLabel}.${key} leaked raw ${key}`);
        }
      }
    }
    if (typeof current === "string") {
      assert(!current.includes("SFSC1-"), `${currentLabel} leaked SyncKey`);
      assert(!current.includes("sfsc://import/v1#"), `${currentLabel} leaked import URI`);
      assert(!/vless:\/\/(?!\*{4})/i.test(current), `${currentLabel} leaked VLESS URI`);
      for (const secret of rawSecrets) {
        const text = String(secret || "");
        if (text.length >= 4) {
          assert(!current.includes(text), `${currentLabel} leaked raw secret`);
        }
      }
    }
  });
}

function assertObject(value, label) {
  assert(Boolean(value && typeof value === "object" && !Array.isArray(value)), label);
}

function assertExactKeys(value, expectedKeys, label) {
  assertDeepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${label} keys`);
}

function assertRequiredAndOptionalKeys(value, requiredKeys, optionalKeys, label) {
  const actual = Object.keys(value).sort();
  const required = [...requiredKeys].sort();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of required) {
    assert(Object.hasOwn(value, key), `${label} missing required key ${key}`);
  }
  for (const key of actual) {
    assert(allowed.has(key), `${label} unexpected key ${key}`);
  }
}

function assertArray(value, label) {
  assert(Array.isArray(value), label);
}

function assertNullableString(value, label) {
  assert(value === null || typeof value === "string", label);
}

function assertNonEmptyString(value, label) {
  assertEqual(typeof value, "string", label);
  assert(value.trim() !== "", label);
}

function assertNullableNumber(value, label) {
  assert(value === null || typeof value === "number", label);
}

function assertCompatibilityIssueVersion(value, label) {
  assert(value === null || (Number.isInteger(value) && value >= 1), label);
}

function assertNullableBoolean(value, label) {
  assert(value === null || typeof value === "boolean", label);
}

function assertFiniteNumber(value, label) {
  assertEqual(typeof value, "number", label);
  assert(Number.isFinite(value), label);
}

function assertPositiveInteger(value, label) {
  assert(Number.isInteger(value), label);
  assert(value >= 1, label);
}

function assertNonNegativeInteger(value, label) {
  assert(Number.isInteger(value), label);
  assert(value >= 0, label);
}

function assertTcpPort(value, label) {
  assert(Number.isInteger(value), label);
  assert(value >= 1 && value <= 65535, label);
}

function assertStableErrorCode(value, label) {
  assertEqual(typeof value, "string", label);
  assertMatch(value, /^$|^[a-z][a-z0-9_]*$/, label);
}

function assertHttpUrl(value, label) {
  assertEqual(typeof value, "string", label);
  try {
    const url = new URL(value);
    assert(["http:", "https:"].includes(url.protocol), label);
  } catch {
    throw new Error(`Contract assertion failed: ${label}`);
  }
}

function assertVlessUriMatchesTunnel(uri, tunnel, label) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Contract assertion failed: ${label}`);
  }
  assertEqual(parsed.protocol, "vless:", label);
  const port = parsed.port ? Number(parsed.port) : 443;
  const security = parsed.searchParams.get("security") || "none";
  const transport = parsed.searchParams.get("type") || "tcp";
  assertEqual(parsed.hostname, tunnel.publicHost, `${label}.host`);
  assertEqual(port, tunnel.publicPort, `${label}.port`);
  assertEqual(security, tunnel.security, `${label}.security`);
  assertEqual(transport, tunnel.transport, `${label}.transport`);
}

function assertMaskedSecret(value, label, options = {}) {
  if ((value === null || value === undefined || value === "") && options.optional) {
    return;
  }
  assertEqual(typeof value, "string", label);
  assertMatch(value, /\*\*\*/, label);
}

function assertConflictsContract(conflicts, label) {
  assertObject(conflicts, label);
  assert(Number.isInteger(conflicts.count), `${label}.count`);
  assert(conflicts.count >= 0, `${label}.count`);
  assertArray(conflicts.files, `${label}.files`);
  assertEqual(typeof conflicts.truncated, "boolean", `${label}.truncated`);
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(`Contract assertion failed: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Contract assertion failed: ${label} expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Contract assertion failed: ${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Contract assertion failed: ${label}`);
  }
}
