import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createHeartbeatAuth } from "../src/core/heartbeatAuth.js";
import {
  assertAdminClaimSummaryContract,
  assertAdminAuthCheckResponseContract,
  assertAdminStateSummaryContract,
  assertAdminSingboxConfigPreviewContract,
  assertAdminWriteStateResponseContract,
  assertClaimCreateResponseContract,
  assertClaimRedeemResponseContract,
  assertJobsPreviewResponseContract,
  assertProfileEncodeResponseContract,
  assertServerDeviceSummaryContract,
  assertServerHeartbeatResponseContract,
  assertServerHealthResponseContract,
  assertSingboxClientConfigResponseContract,
  assertVlessParseResponseContract
} from "./lib/runtimeContracts.mjs";
import { writeJsonReportSync } from "./lib/reportSecrets.mjs";

const baseUrl = normalizeBaseUrl(
  readArg("--base-url") || process.env.SFSC_SMOKE_BASE_URL || process.env.PUBLIC_SERVER_URL || "http://127.0.0.1:5177"
);
const adminToken = readArg("--admin-token") || process.env.SFSC_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";
const jsonReportPath = readArg("--json-report") || process.env.SFSC_SMOKE_JSON_REPORT || "";
const requestTimeoutMs = readPositiveInteger(
  readArg("--timeout-ms") || process.env.SFSC_SMOKE_TIMEOUT_MS,
  15000
);
const exerciseClaimLifecycle = readFlag("--exercise-claim-lifecycle")
  || readTruthy(process.env.SFSC_SMOKE_EXERCISE_CLAIM_LIFECYCLE);
const cleanupClaimLifecycle = readFlag("--cleanup-claim-lifecycle")
  || readTruthy(process.env.SFSC_SMOKE_CLEANUP_CLAIM_LIFECYCLE);
const claimLifecycleContext = {
  clientName: null,
  deviceName: null,
  cleanupRequested: cleanupClaimLifecycle,
  cleanupUserDeleted: false,
  cleanupClaimRetained: false,
  cleanupRestartRequired: null
};
const adminStateSummary = {
  appVersion: null,
  buildId: null,
  protocolsAligned: false,
  restartRequired: null,
  userCount: 0,
  deviceCount: 0,
  claimCount: 0
};
const knownSensitiveValues = [
  adminToken,
  process.env.S3_SECRET_ACCESS_KEY,
  process.env.MINIO_ROOT_PASSWORD,
  process.env.VLESS_PRIVATE_KEY,
  process.env.REALITY_PRIVATE_KEY
].map((value) => String(value || "").trim()).filter((value) => value.length >= 8);
const smokeTunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&security=none&type=tcp#sfsc-smoke";
const smokePreviewSecret = "sfsc-smoke-preview-secret";

const checks = [];
let currentCheck = "startup";
let smokeOk = false;
let smokeError = null;

try {
  const health = await runCheck("health", () => getJson("/api/health", { auth: false }));
  adminStateSummary.buildId = health.diagnostics?.buildId || null;
  pass("health", `ok=${health.ok}, version=${health.version || "unknown"}, buildId=${adminStateSummary.buildId || "unknown"}, protocol=${health.diagnostics?.protocols?.profile || "unknown"}, adminAuth=${Boolean(health.adminAuth?.enabled)}, timeout=${requestTimeoutMs}ms`);
  assertServerHealthResponseContract(health);

  const adminAuthEnabled = health.adminAuth.enabled;
  if (cleanupClaimLifecycle && !exerciseClaimLifecycle) {
    throw new Error("Claim lifecycle cleanup requires --exercise-claim-lifecycle.");
  }
  if (adminAuthEnabled && !adminToken) {
    throw new Error("Admin auth is enabled; set SFSC_ADMIN_TOKEN or pass --admin-token to run management checks.");
  }

  {
    if (adminAuthEnabled) {
      await runCheck("admin-auth-required", () => expectJsonError("/api/admin/state", {
        auth: false,
        expectedStatus: 401,
        expectedCode: "admin_auth_required"
      }));
      pass("admin-auth-required", "management API rejects missing token");
    }

    const auth = await runCheck("admin-auth", () => getJson("/api/admin/auth/check", { auth: adminAuthEnabled }));
    assertAdminAuthCheckResponseContract(auth);
    requireField(auth.adminAuth, "enabled", adminAuthEnabled);
    pass("admin-auth", adminAuthEnabled ? "token accepted" : "auth disabled");

    const state = await runCheck("admin-state", () => getJson("/api/admin/state", { auth: adminAuthEnabled }));
    assertAdminStateSummaryContract(state, "adminState");
    requireProtocolMapMatch(health.diagnostics.protocols, state.diagnostics.protocols);
    rememberAdminStateSummary(state, { protocolsAligned: true });
    pass("admin-state", `version=${state.appVersion || "unknown"}, protocols=aligned, users=${state.users.length}, devices=${state.devices.length}, claims=${state.claims.length}, restartRequired=${state.tunnel.restartRequired}`);

    const config = await runCheck("singbox-config", () => getJson("/api/admin/singbox/config", { auth: adminAuthEnabled }));
    assertAdminSingboxConfigPreviewContract(config, state, "singboxConfig");
    pass("singbox-config", `inbounds=${config.config.inbounds.length}`);

    const encodedProfile = await runCheck("profile-encode", () => postJson("/api/profile/encode", {
      auth: adminAuthEnabled,
      body: {
        clientName: "smoke-pc",
        uri: smokeTunnelUri,
        endpoint: "http://minio:9000",
        bucket: "home-sync",
        accessKeyId: "smoke-pc",
        secretAccessKey: smokePreviewSecret,
        prefix: "devices/smoke-pc",
        localProxyPort: 18082
      }
    }));
    assertProfileEncodeResponseContract(encodedProfile, "profileEncode", {
      expectedClientName: "smoke-pc",
      expectedStorageSecretAccessKey: smokePreviewSecret
    });
    pass("profile-encode", `heartbeat=${encodedProfile.profile.heartbeat.scheme}, profile=encoded`);

    const parsedVless = await runCheck("vless-parse", () => postJson("/api/vless/parse", {
      auth: adminAuthEnabled,
      body: {
        uri: smokeTunnelUri
      }
    }));
    assertVlessParseResponseContract(parsedVless, "vlessParse");
    pass("vless-parse", `server=${parsedVless.profile.server}, security=${parsedVless.profile.security}`);

    const clientConfig = await runCheck("singbox-client-config", () => postJson("/api/singbox/client-config", {
      auth: adminAuthEnabled,
      body: {
        uri: smokeTunnelUri,
        options: {
          localProxyPort: 18082
        }
      }
    }));
    assertSingboxClientConfigResponseContract(clientConfig, "singboxClientConfig", { localProxyPort: 18082 });
    pass("singbox-client-config", `listen=${clientConfig.config.inbounds[0].listen}:${clientConfig.config.inbounds[0].listen_port}, mux=disabled`);

    const jobsPreview = await runCheck("jobs-preview", () => postJson("/api/jobs/preview", {
      auth: adminAuthEnabled,
      body: {
        uri: smokeTunnelUri,
        options: {
          localProxyPort: 18082
        },
        job: {
          direction: "upload",
          localPath: "D:\\Smoke",
          remoteName: "home-minio",
          bucketName: "home-sync",
          clientName: "smoke-pc",
          remoteFolder: "smoke",
          storageBackend: "s3",
          accessKeyId: "smoke-pc",
          secretAccessKey: smokePreviewSecret,
          schedule: { mode: "manual" }
        }
      }
    }));
    assertJobsPreviewResponseContract(jobsPreview, "jobsPreview", {
      rawSecrets: [smokePreviewSecret],
      remoteConfigSecret: smokePreviewSecret,
      localProxyPort: 18082
    });
    pass("jobs-preview", `action=${jobsPreview.rclone.args[0]}, display=redacted`);

    await runCheck("secret-masking", async () => {
      requireMaskedSecret(state.storage?.secretAccessKey, "state.storage.secretAccessKey");
      for (const [index, user] of (state.users || []).entries()) {
        requireMaskedSecret(user?.storage?.secretAccessKey, `state.users[${index}].storage.secretAccessKey`);
      }
      requireMaskedSecret(state.tunnel?.reality?.privateKey, "state.tunnel.reality.privateKey", { optional: true });
      requireMaskedSecret(
        config.config?.inbounds?.[0]?.tls?.reality?.private_key,
        "config.inbounds[0].tls.reality.private_key",
        { optional: true }
      );
      requireNoKnownSensitiveValues({ state, config });
    });
    pass("secret-masking", "management responses are safe to inspect");

    if (exerciseClaimLifecycle) {
      await exerciseRealClaimLifecycle(adminAuthEnabled);
    }
  }

  console.log(`\nSFSC server smoke passed: ${baseUrl}`);
  for (const check of checks) {
    console.log(`- ${check.name}: ${check.detail}`);
  }
  smokeOk = true;
} catch (error) {
  smokeError = error;
  console.error(`\nSFSC server smoke failed: ${baseUrl}`);
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

async function getJson(path, options = {}) {
  const { response, payload } = await fetchJson(path, options);
  if (!response.ok) {
    const code = payload?.errorCode || payload?.error || "";
    const message = payload?.message || payload?.error || response.statusText || "request failed";
    const error = new Error(`HTTP ${response.status} ${path}${code ? ` ${code}` : ""}: ${message}`);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload;
}

async function postJson(path, options = {}) {
  const { response, payload } = await fetchJson(path, {
    ...options,
    method: "POST"
  });
  if (!response.ok) {
    const code = payload?.errorCode || payload?.error || "";
    const message = payload?.message || payload?.error || response.statusText || "request failed";
    const error = new Error(`HTTP ${response.status} ${path}${code ? ` ${code}` : ""}: ${message}`);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload;
}

async function expectJsonError(path, options = {}) {
  const { response, payload } = await fetchJson(path, options);
  if (response.status !== options.expectedStatus) {
    const code = payload?.errorCode || payload?.error || "";
    throw new Error(`Expected ${path} to return HTTP ${options.expectedStatus}, got ${response.status}${code ? ` ${code}` : ""}`);
  }
  const code = payload?.errorCode || payload?.error || "";
  if (code !== options.expectedCode) {
    throw new Error(`Expected ${path} to return ${options.expectedCode}, got ${code || "(missing)"}`);
  }
  return payload;
}

async function fetchJson(path, options = {}) {
  const controller = typeof AbortController === "function" && requestTimeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), requestTimeoutMs)
    : null;
  try {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: buildHeaders(options),
      body,
      signal: controller?.signal
    });
    const payload = await readJson(response);
    return { response, payload };
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

function buildHeaders(options = {}) {
  const headers = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.auth === false || !adminToken) {
    return headers;
  }
  return {
    ...headers,
    authorization: `Bearer ${adminToken}`
  };
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

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: expected ${expected}, got ${actual}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object: ${label}`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array: ${label}`);
  }
}

async function exerciseRealClaimLifecycle(adminAuthEnabled) {
  const clientName = createDisposableName("sfsc-smoke-client");
  const deviceName = createDisposableName("sfsc-smoke-device");
  const clientVersion = "server-smoke-lifecycle";
  claimLifecycleContext.clientName = clientName;
  claimLifecycleContext.deviceName = deviceName;

  const created = await runCheck("claim-lifecycle-create", () => postJson("/api/claims/create", {
    auth: adminAuthEnabled,
    body: {
      clientName,
      server: baseUrl,
      expiresInHours: 1
    }
  }));
  assertClaimCreateResponseContract(created, "claimLifecycle.create", {
    expectedClientName: clientName,
    expectedServer: baseUrl
  });
  rememberKnownSensitiveValue(created.tKey);
  rememberKnownSensitiveValue(created.tKeyUri);
  rememberProfileSecrets(created.profile);
  pass("claim-lifecycle-create", `client=${clientName}, claim=issued`);

  const redeemBinding = {
    clientRedeemId: `smoke-redeem-${clientName}`,
    clientInstallId: `smoke-install-${deviceName}`
  };
  const redeemed = await runCheck("claim-lifecycle-redeem", () => postJson("/api/claims/redeem", {
    auth: false,
    body: {
      tKey: created.tKey,
      ...redeemBinding
    }
  }));
  assertClaimRedeemResponseContract(redeemed, "claimLifecycle.redeemedProfile", { expectedClientName: clientName });
  requireProfilesMatch(created.profile, redeemed);
  rememberProfileSecrets(redeemed);
  pass("claim-lifecycle-redeem", `client=${clientName}, profile=redeemed`);

  const replayed = await runCheck("claim-lifecycle-bound-replay", () => postJson("/api/claims/redeem", {
    auth: false,
    body: {
      tKey: created.tKey,
      ...redeemBinding
    }
  }));
  assertClaimRedeemResponseContract(replayed, "claimLifecycle.replayedProfile", { expectedClientName: clientName });
  requireProfilesMatch(created.profile, replayed);
  rememberProfileSecrets(replayed);
  pass("claim-lifecycle-bound-replay", "same client binding replay accepted");

  await runCheck("claim-lifecycle-duplicate-redeem", () => expectJsonError("/api/claims/redeem", {
    method: "POST",
    auth: false,
    body: {
      tKey: created.tKey
    },
    expectedStatus: 409,
    expectedCode: "claim_already_used"
  }));
  pass("claim-lifecycle-duplicate-redeem", "reused SyncKey rejected");

  await runCheck("claim-lifecycle-different-binding-redeem", () => expectJsonError("/api/claims/redeem", {
    method: "POST",
    auth: false,
    body: {
      tKey: created.tKey,
      clientRedeemId: `${redeemBinding.clientRedeemId}-other`,
      clientInstallId: redeemBinding.clientInstallId
    },
    expectedStatus: 409,
    expectedCode: "claim_already_used"
  }));
  pass("claim-lifecycle-different-binding-redeem", "different client binding rejected");

  const heartbeatPayload = {
    clientName,
    deviceName,
    profileId: redeemed.profileId,
    clientVersion,
    diagnostics: {
      role: "client",
      version: clientVersion,
      buildId: "server-smoke",
      protocols: {
        claim: 1,
        profile: 1,
        adminState: 1,
        clientStatus: 1,
        heartbeat: 1
      }
    },
    sync: {
      syncState: "idle"
    }
  };
  const heartbeat = await runCheck("claim-lifecycle-heartbeat", () => postJson("/api/devices/heartbeat", {
    auth: false,
    body: signHeartbeatPayload(heartbeatPayload, redeemed)
  }));
  requireClaimLifecycleHeartbeatContract(heartbeat, {
    clientName,
    clientVersion
  });
  requireNoKnownSensitiveValues({ heartbeat });
  pass("claim-lifecycle-heartbeat", `client=${clientName}, online=${heartbeat.device.online}`);

  const state = await runCheck("claim-lifecycle-admin-state", () => getJson("/api/admin/state", {
    auth: adminAuthEnabled
  }));
  requireClaimLifecycleAdminState(state, {
    clientName,
    clientVersion,
    claimCode: created.code
  });
  requireNoKnownSensitiveValues({ state });
  rememberAdminStateSummary(state);
  pass("claim-lifecycle-admin-state", `client=${clientName}, device=visible, claim=used`);

  if (cleanupClaimLifecycle) {
    await cleanupRealClaimLifecycle(adminAuthEnabled, {
      state,
      clientName,
      claimCode: created.code
    });
  }
}

async function cleanupRealClaimLifecycle(adminAuthEnabled, options = {}) {
  const { state, clientName, claimCode } = options;
  const user = (state.users || []).find((item) => item.clientName === clientName && !item.deletedAt);
  if (!user) {
    throw new Error("Expected claim lifecycle smoke user to exist before cleanup.");
  }
  const cleaned = await runCheck("claim-lifecycle-cleanup-device", () => postJson("/api/admin/users/delete", {
    auth: adminAuthEnabled,
    body: {
      userId: user.id,
      confirmText: clientName
    }
  }));
  requireObject(cleaned, "claimLifecycle.cleanup");
  requireField(cleaned, "ok", true);
  requireString(cleaned.deletedUserId, "claimLifecycle.cleanup.deletedUserId");
  requireObject(cleaned.state, "claimLifecycle.cleanup.state");
  assertAdminWriteStateResponseContract(cleaned, "claimLifecycle.cleanup");
  requireArray(cleaned.state.devices, "claimLifecycle.cleanup.state.devices");
  requireArray(cleaned.state.claims, "claimLifecycle.cleanup.state.claims");
  if (cleaned.state.devices.some((item) => item.clientName === clientName)) {
    throw new Error("Expected claim lifecycle smoke device to be absent after cleanup.");
  }
  const retainedClaim = cleaned.state.claims.find((item) => item.code === claimCode);
  if (!retainedClaim) {
    throw new Error("Expected claim lifecycle smoke claim summary to be retained for audit.");
  }
  assertAdminClaimSummaryContract(retainedClaim, "claimLifecycle.cleanup.retainedClaim");
  requireNoKnownSensitiveValues({ cleanup: cleaned });
  rememberAdminStateSummary(cleaned.state);
  claimLifecycleContext.cleanupUserDeleted = true;
  claimLifecycleContext.cleanupClaimRetained = true;
  claimLifecycleContext.cleanupRestartRequired = Boolean(cleaned.state.tunnel?.restartRequired);
  pass("claim-lifecycle-cleanup-device", `client=${clientName}, device=deleted, claim=retained`);
}

function requireProfilesMatch(issued, redeemed) {
  for (const field of ["profileId", "clientName"]) {
    if (issued[field] !== redeemed[field]) {
      throw new Error(`Expected redeemed profile ${field} to match issued profile.`);
    }
  }
  if (issued.heartbeat?.scheme !== redeemed.heartbeat?.scheme || issued.heartbeat?.secret !== redeemed.heartbeat?.secret) {
    throw new Error("Expected redeemed profile heartbeat credentials to match issued profile.");
  }
  if (issued.storage?.bucket !== redeemed.storage?.bucket || issued.storage?.prefix !== redeemed.storage?.prefix) {
    throw new Error("Expected redeemed profile storage target to match issued profile.");
  }
}

function requireClaimLifecycleHeartbeatContract(value, expected) {
  assertServerHeartbeatResponseContract(value, "claimLifecycle.heartbeat");
  requireField(value.device, "clientName", expected.clientName);
  requireField(value.device, "enabled", true);
  requireField(value.device, "online", true);
  requireField(value.device, "status", "online");
  requireField(value.device, "clientVersion", expected.clientVersion);
  requireField(value.device, "syncState", "idle");
  requireField(value.device.sync, "state", "idle");
}

function requireClaimLifecycleAdminState(state, expected) {
  requireObject(state, "claimLifecycle.adminState");
  requireArray(state.devices, "claimLifecycle.adminState.devices");
  requireArray(state.claims, "claimLifecycle.adminState.claims");
  const device = state.devices.find((item) => item.clientName === expected.clientName);
  if (!device) {
    throw new Error("Expected admin state to include lifecycle smoke device summary.");
  }
  assertServerDeviceSummaryContract(device, "claimLifecycle.adminState.device");
  requireCompatibilitySummary(device.compatibility, "claimLifecycle.adminState.device.compatibility");
  requireField(device, "clientName", expected.clientName);
  requireField(device, "enabled", true);
  requireField(device, "online", true);
  requireField(device, "status", "online");
  requireField(device, "clientVersion", expected.clientVersion);
  requireString(device.lastSeenAt, "claimLifecycle.adminState.device.lastSeenAt");

  const claim = state.claims.find((item) => item.code === expected.claimCode);
  if (!claim) {
    throw new Error("Expected admin state to include lifecycle smoke claim summary.");
  }
  assertAdminClaimSummaryContract(claim, "claimLifecycle.adminState.claim");
  requireField(claim, "clientName", expected.clientName);
  requireField(claim, "used", true);
  requireString(claim.redeemedAt, "claimLifecycle.adminState.claim.redeemedAt");
}

function requireProtocolMapMatch(healthProtocols, stateProtocols) {
  for (const field of ["claim", "profile", "adminState", "clientStatus", "heartbeat"]) {
    if (healthProtocols[field] !== stateProtocols[field]) {
      throw new Error(`Server health/state diagnostics protocol mismatch: ${field} health=${healthProtocols[field]} state=${stateProtocols[field]}`);
    }
  }
}

function requireCompatibilitySummary(value, label) {
  requireObject(value, label);
  requireBoolean(value.ok, `${label}.ok`);
  requireString(value.status, `${label}.status`);
  requireString(value.action, `${label}.action`);
  requireString(value.severity, `${label}.severity`);
  requireObject(value.policy, `${label}.policy`);
  for (const field of ["heartbeat", "profileIssue", "syncRun", "adminActions", "reason"]) {
    requireString(value.policy[field], `${label}.policy.${field}`);
  }
  requireArray(value.issues, `${label}.issues`);
}

function requireNoRawUserSecrets(user, label) {
  for (const field of ["secretAccessKey", "privateKey", "heartbeatSecret", "heartbeatAuthNonces", "tKey", "claimCode", "token", "profile"]) {
    if (Object.hasOwn(user, field)) {
      throw new Error(`Expected ${label} to omit raw user field ${field}.`);
    }
  }
}

function requireNoRawDeviceSecrets(device, label) {
  for (const field of ["secretAccessKey", "privateKey", "heartbeatSecret", "heartbeatAuthNonces", "tKey", "claimCode"]) {
    if (Object.hasOwn(device, field)) {
      throw new Error(`Expected ${label} to omit raw secret field ${field}.`);
    }
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${label} to be a boolean.`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string.`);
  }
}

function requireNullableString(value, label) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected ${label} to be null or a string.`);
  }
}

function requireMaskedSecret(value, label, options = {}) {
  if ((value === null || value === undefined || value === "") && options.optional) {
    return;
  }
  if (typeof value !== "string" || !value.includes("***")) {
    throw new Error(`Expected ${label} to be masked.`);
  }
}

function requireNoKnownSensitiveValues(payload) {
  if (!knownSensitiveValues.length) {
    return;
  }
  const text = JSON.stringify(payload);
  for (const value of knownSensitiveValues) {
    if (text.includes(value)) {
      throw new Error("Management responses exposed a known secret value.");
    }
  }
}

function rememberProfileSecrets(profile) {
  rememberKnownSensitiveValue(profile?.heartbeat?.secret);
  rememberKnownSensitiveValue(profile?.storage?.secretAccessKey);
}

function rememberKnownSensitiveValue(value) {
  const text = String(value || "").trim();
  if (text.length >= 8 && !knownSensitiveValues.includes(text)) {
    knownSensitiveValues.push(text);
  }
}

function signHeartbeatPayload(payload, profile) {
  const secret = profile?.heartbeat?.secret;
  requireString(secret, "claimLifecycle.profile.heartbeat.secret");
  if (!secret.trim()) {
    throw new Error("Expected claim lifecycle heartbeat secret to be non-empty.");
  }
  return {
    ...payload,
    auth: createHeartbeatAuth(payload, secret)
  };
}

function createDisposableName(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function rememberAdminStateSummary(state, options = {}) {
  adminStateSummary.appVersion = state?.appVersion || adminStateSummary.appVersion;
  if (typeof options.protocolsAligned === "boolean") {
    adminStateSummary.protocolsAligned = options.protocolsAligned;
  }
  adminStateSummary.restartRequired = Boolean(state?.tunnel?.restartRequired);
  adminStateSummary.userCount = Array.isArray(state?.users) ? state.users.length : 0;
  adminStateSummary.deviceCount = Array.isArray(state?.devices) ? state.devices.length : 0;
  adminStateSummary.claimCount = Array.isArray(state?.claims) ? state.claims.length : 0;
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
    type: "server-smoke-report",
    ok,
    context: {
      generatedAt: new Date().toISOString(),
      baseUrl,
      requestTimeoutMs,
      adminAuthProvided: Boolean(adminToken),
      exerciseClaimLifecycle,
      claimLifecycleClientName: claimLifecycleContext.clientName,
      claimLifecycleDeviceName: claimLifecycleContext.deviceName,
      cleanupClaimLifecycle: claimLifecycleContext.cleanupRequested,
      cleanupClaimLifecycleUserDeleted: claimLifecycleContext.cleanupUserDeleted,
      cleanupClaimLifecycleClaimRetained: claimLifecycleContext.cleanupClaimRetained,
      cleanupClaimLifecycleRestartRequired: claimLifecycleContext.cleanupRestartRequired
    },
    summary: {
      passed: checks.length,
      failed: ok ? 0 : 1,
      appVersion: adminStateSummary.appVersion,
      buildId: adminStateSummary.buildId,
      protocolsAligned: adminStateSummary.protocolsAligned,
      restartRequired: adminStateSummary.restartRequired,
      userCount: adminStateSummary.userCount,
      deviceCount: adminStateSummary.deviceCount,
      claimCount: adminStateSummary.claimCount
    },
    checks,
    failure: ok ? null : {
      check: error?.check || currentCheck,
      message: error?.message || String(error || "unknown error"),
      code: error?.code || "",
      status: error?.status || null
    }
  };
  writeJsonReportSync(reportPath, payload, "server smoke report");
  console.log(`SFSC server smoke JSON report written: ${reportPath}`);
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

function readFlag(name) {
  return process.argv.includes(name);
}

function readTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
