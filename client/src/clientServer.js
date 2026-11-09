import http from "node:http";
import net from "node:net";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import {
  buildClientSingboxConfig,
  buildJobFromProfile,
  buildRclonePreview,
  toRcloneBisyncResyncMode,
  buildRuntimeDiagnostics,
  assertJsonWriteContentType,
  compareRuntimeDiagnostics,
  createHeartbeatAuth,
  computeNextRun,
  createHttpError,
  describeSchedule,
  isStableErrorCode,
  normalizeBandwidthLimit,
  normalizeSchedule,
  normalizeSyncSafety,
  normalizeSyncRun,
  normalizeHttpError,
  normalizeRuntimeDiagnostics,
  parseProtocolRequest,
  PROTOCOL_REQUESTS,
  readJson,
  summarizeImportProfile
} from "../../src/core/index.js";
import { ensureClientDirs, getClientPaths, getFirstBisyncConflictPathsForRelation, getSyncRecoveryPathsForRelation } from "./paths.js";
import { buildDiagnosticBundle } from "./diagnosticBundle.js";
import {
  normalizeEnrollmentDiagnosticError,
  runEnrollmentRefreshWithDiagnostics
} from "./enrollmentDiagnostics.js";
import { resolveClaimReference, resolveProfileImport } from "./profileImport.js";
import { fileExists, ManagedProcess, readRecentLog, readRecentLogWithMeta, redactLogText, runBuffered } from "./processRunner.js";
import {
  applySyncRelationToJob,
  buildSyncRelation,
  findBisyncStateEntry,
  findLegacyBisyncEntries,
  markBisyncInitializedState,
  resolveBisyncMigration,
  reuseMatchingSyncRelation,
  sameSyncRelationBaseline,
  summarizeSyncRelation,
  syncRelationConnectionChanged,
  syncRelationRuntimeId
} from "./syncRelation.js";
import {
  appendRcloneOutputContext,
  mergeRcloneConflictSummary,
  mergeRcloneProgress,
  parseRcloneFailure,
  parseRcloneStats
} from "./rcloneStats.js";
import {
  readJobs,
  readJsonFile,
  readProfile,
  readSyncHistory,
  readStoredJobs,
  readStoredProfile,
  inspectSecretVault,
  inspectLocalState,
  prepareClaimRecovery,
  protectLocalSecretFile,
  recordSyncRunFinished,
  recordSyncRunStarted,
  readLastSuccessfulHeartbeat,
  readEnrollmentSession,
  restoreProfileImportState,
  saveLastSuccessfulHeartbeat,
  clearClaimRecovery,
  clearLastSuccessfulHeartbeat,
  saveJob,
  saveJobs,
  saveEnrollmentSession,
  saveProfile,
  snapshotProfileImportState,
  writeJsonFile,
  writeProtectedJsonFile,
  writeProtectedTextFile,
  withClientStateLock
} from "./store.js";
import { createEnrollmentIdentity, consumeEnrollmentCode, enrollmentChannelNeedsRenewal, importEnrollmentChannel, revalidateEnrollmentChannel, revalidateEnrollmentChannelForRenewal, renewEnrollmentChannel, requestDataAuthorization, submitEnrollmentRequest, verifyPersistedEnrollmentReceipt } from "./enrollmentSession.js";
import { requestThroughSocks } from "./bootstrapTransport.js";
import { canonicalJson, publicKeyFingerprint } from "../../src/core/enrollmentProtocol.js";
import { verifyDataAuthorizationEnvelope } from "../../src/core/dataAuthorization.js";
import { normalizePositiveInteger, normalizeTcpPort } from "../../src/core/numbers.js";
import { ensureSftpAccessMarkers, sftpAccessMarkerContents } from "./sftpAccessMarker.js";
import {
  listFirstBisyncConflictOperations,
  previewFirstBisyncConflicts,
  resumeFirstBisyncConflictSave,
  saveFirstBisyncConflicts,
  verifyFirstBisyncConflictsSaved
} from "./firstBisyncConflict.js";
import {
  completeSyncRecoveryRun,
  cancelSyncRecoveryRestorePreview,
  inspectBisyncBaselineForSafety,
  isSyncRecoveryPristine,
  listSyncRecoveryVersions,
  markSyncRecoveryRunStarted,
  prepareSyncRecovery,
  previewSyncRecoveryRestore,
  restoreSyncRecoveryVersion,
  verifySyncRecoveryManifestOwnership,
  verifySyncRecoveryPreflight
} from "./syncRecovery.js";
import {
  normalizeConnectionRepairJournal,
  probeLocalDirectory,
  probeSftpDirectory,
  upsertConnectionRepairOperation
} from "./connectionRepair.js";

const paths = getClientPaths();
await ensureClientDirs(paths);

const port = Number(process.env.PORT || process.env.SFSC_CLIENT_PORT || 5188);
const host = "127.0.0.1";
const clientVersion = process.env.SFSC_CLIENT_VERSION || await readClientVersion(paths);
const claimRedeemTimeoutMs = Number(process.env.SFSC_CLAIM_REDEEM_TIMEOUT_MS || 15000);
const CLAIM_RECOVERY_TERMINAL_ERRORS = new Set([
  "claim_already_used",
  "claim_expired",
  "claim_not_found",
  "profile_heartbeat_required",
  "profile_storage_required",
  "profile_tunnel_required",
  "validation_failed"
]);
const COMPATIBILITY_STATUSES = new Set(["compatible", "mismatch"]);
const COMPATIBILITY_ACTIONS = new Set(["diagnostics_missing", "manual_check", "none", "upgrade_local", "upgrade_remote"]);
const COMPATIBILITY_SEVERITIES = new Set(["ok", "warning"]);
const COMPATIBILITY_POLICY_VALUES = new Set(["allow", "warn"]);
const COMPATIBILITY_ISSUE_FIELDS = new Set(["adminState", "claim", "clientStatus", "heartbeat", "profile"]);
const COMPATIBILITY_ISSUE_TYPES = new Set(["local_missing", "remote_missing", "remote_newer", "remote_older"]);
const COMPATIBILITY_KEYS = ["action", "issues", "localRole", "ok", "policy", "remoteRole", "severity", "status"];
const COMPATIBILITY_POLICY_KEYS = ["adminActions", "heartbeat", "profileIssue", "reason", "syncRun"];
const COMPATIBILITY_ISSUE_KEYS = ["field", "local", "message", "remote", "type"];
const diagnostics = buildRuntimeDiagnostics({
  role: "client",
  version: clientVersion
});
const requiredSupportDocuments = [
  {
    name: "INTERFACE_CONTRACT",
    path: "resources/app/docs/INTERFACE_CONTRACT.md"
  },
  {
    name: "API_MATRIX",
    path: "resources/app/docs/API_MATRIX.md"
  },
  {
    name: "DEPLOYMENT_AND_MIGRATION_GUIDE",
    path: "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md"
  },
  {
    name: "INTERNAL_TRIAL_CHECKLIST",
    path: "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md"
  },
  {
    name: "PILOT_RUNBOOK",
    path: "resources/app/docs/PILOT_RUNBOOK.md"
  },
  {
    name: "PILOT_ACCEPTANCE_CRITERIA",
    path: "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md"
  },
  {
    name: "PILOT_SUPPORT_GUIDE",
    path: "resources/app/docs/PILOT_SUPPORT_GUIDE.md"
  }
];
const requiredManifestFilesByPackage = {
  SyncraftDesktop: [
    ["client exe", "Syncraft.exe"],
    ["app package", "resources/app/package.json"],
    ["electron main", "resources/app/client/electron/main.cjs"],
    ["electron preload", "resources/app/client/electron/preload.cjs"],
    ["client local API", "resources/app/client/src/clientServer.js"],
    ["client paths", "resources/app/client/src/paths.js"],
    ["client local state store", "resources/app/client/src/store.js"],
    ["client enrollment session", "resources/app/client/src/enrollmentSession.js"],
    ["client enrollment diagnostics", "resources/app/client/src/enrollmentDiagnostics.js"],
    ["client SFTP access marker", "resources/app/client/src/sftpAccessMarker.js"],
    ["client connection repair", "resources/app/client/src/connectionRepair.js"],
    ["first bisync conflict safety", "resources/app/client/src/firstBisyncConflict.js"],
    ["sync recovery", "resources/app/client/src/syncRecovery.js"],
    ["data authorization", "resources/app/src/core/dataAuthorization.js"],
    ["client bootstrap transport", "resources/app/client/src/bootstrapTransport.js"],
    ["client diagnostic bundle", "resources/app/client/src/diagnosticBundle.js"],
    ["client process runner", "resources/app/client/src/processRunner.js"],
    ["client rclone stats parser", "resources/app/client/src/rcloneStats.js"],
    ["client profile import", "resources/app/client/src/profileImport.js"],
    ["client node launcher", "resources/app/client/src/launcher.cjs"],
    ["client Windows launcher source", "resources/app/client/src/Launcher.cs"],
    ["client UI html", "resources/app/client/public/index.html"],
    ["client UI app", "resources/app/client/public/app.js"],
    ["client UI styles", "resources/app/client/public/styles.css"],
    ["shared core", "resources/app/src/core/index.js"],
    ["channel import code", "resources/app/src/core/channelImportCode.js"],
    ["interface contract", "resources/app/docs/INTERFACE_CONTRACT.md"],
    ["API matrix", "resources/app/docs/API_MATRIX.md"],
    ["deployment and migration guide", "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md"],
    ["internal trial checklist", "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md"],
    ["pilot runbook", "resources/app/docs/PILOT_RUNBOOK.md"],
    ["pilot acceptance criteria", "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md"],
    ["pilot support guide", "resources/app/docs/PILOT_SUPPORT_GUIDE.md"],
    ["binary lock", "resources/bin/win32/binaries.lock.json"],
    ["sing-box binary", "resources/bin/win32/sing-box.exe"],
    ["rclone binary", "resources/bin/win32/rclone.exe"]
  ],
  SyncraftClient: [
    ["client exe", "Syncraft.exe"],
    ["app package", "app/package.json"],
    ["client local API", "app/client/src/clientServer.js"],
    ["client paths", "app/client/src/paths.js"],
    ["client local state store", "app/client/src/store.js"],
    ["client enrollment session", "app/client/src/enrollmentSession.js"],
    ["client enrollment diagnostics", "app/client/src/enrollmentDiagnostics.js"],
    ["client SFTP access marker", "app/client/src/sftpAccessMarker.js"],
    ["client connection repair", "app/client/src/connectionRepair.js"],
    ["first bisync conflict safety", "app/client/src/firstBisyncConflict.js"],
    ["sync recovery", "app/client/src/syncRecovery.js"],
    ["data authorization", "app/src/core/dataAuthorization.js"],
    ["client bootstrap transport", "app/client/src/bootstrapTransport.js"],
    ["client diagnostic bundle", "app/client/src/diagnosticBundle.js"],
    ["client process runner", "app/client/src/processRunner.js"],
    ["client rclone stats parser", "app/client/src/rcloneStats.js"],
    ["client profile import", "app/client/src/profileImport.js"],
    ["client node launcher", "app/client/src/launcher.cjs"],
    ["client Windows launcher source", "app/client/src/Launcher.cs"],
    ["client UI html", "app/client/public/index.html"],
    ["client UI app", "app/client/public/app.js"],
    ["client UI styles", "app/client/public/styles.css"],
    ["shared core", "app/src/core/index.js"],
    ["channel import code", "app/src/core/channelImportCode.js"],
    ["interface contract", "resources/app/docs/INTERFACE_CONTRACT.md"],
    ["API matrix", "resources/app/docs/API_MATRIX.md"],
    ["deployment and migration guide", "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md"],
    ["internal trial checklist", "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md"],
    ["pilot runbook", "resources/app/docs/PILOT_RUNBOOK.md"],
    ["pilot acceptance criteria", "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md"],
    ["pilot support guide", "resources/app/docs/PILOT_SUPPORT_GUIDE.md"],
    ["binary lock", "resources/bin/win32/binaries.lock.json"],
    ["sing-box binary", "resources/bin/win32/sing-box.exe"],
    ["rclone binary", "resources/bin/win32/rclone.exe"]
  ]
};
const heartbeatMs = Number(process.env.SFSC_HEARTBEAT_MS || 15000);
const heartbeatTimeoutMs = Number(process.env.SFSC_HEARTBEAT_TIMEOUT_MS || 10000);
const schedulerMs = Number(process.env.SFSC_SCHEDULER_MS || 15000);
const STOPPING_SYNC_REPLAY_MS = 2000;
const SFTP_DATA_SOCKS_PORT = 18082;
const DATA_AUTHORIZATION_RETRYABLE_CODES = new Set([
  "enrollment_transport_failed",
  "enrollment_proxy_unavailable",
  "enrollment_data_channel_not_ready",
  "enrollment_data_relation_not_ready"
]);
const HEARTBEAT_DEVICE_STATUSES = new Set(["online", "offline"]);
const HEARTBEAT_SYNC_STATES = new Set(["idle", "syncing", "error", "stopping", "offline"]);
const singboxProcess = new ManagedProcess("sing-box", paths.singboxLog);
const enrollmentSingboxProcess = new ManagedProcess("enrollment-sing-box", paths.singboxLog);
const dataSingboxProcess = new ManagedProcess("sftp-data-sing-box", paths.singboxLog);
const syncProcess = new ManagedProcess("rclone-sync", paths.rcloneLog);
let syncMetrics = createSyncMetrics();
let syncOutputContexts = {
  stdout: "",
  stderr: ""
};
let lastHeartbeat = null;
let lastSuccessfulHeartbeat = await readLastSuccessfulHeartbeat(paths).catch((error) => {
  if (error?.code === "local_state_corrupt") return null;
  throw error;
});
let heartbeatGeneration = 0;
let heartbeatInFlight = null;
let schedulerState = createSchedulerState();
let syncRunInFlight = null;
let syncRunInFlightJobFingerprint = "";
let syncRunPreparationPromise = null;
let syncRunPreparationFingerprint = "";
let syncRunPreparationJob = null;
let activeSyncJobFingerprint = "";
let activeSyncRequestFingerprint = "";
let activeSyncRequestJob = null;
let stoppingSyncReplay = null;
let syncRunPreparationCount = 0;
let connectionRepairInFlight = false;
let clientDataOperationInFlight = false;
let connectionRepairAdmissionInFlight = false;
let connectionRepairAdmissionPromise = Promise.resolve();
let connectionRepairTask = null;
const syncSafetyPlans = new Map();
const SYNC_SAFETY_PLAN_TTL_MS = 5 * 60 * 1000;
const SYNC_SAFETY_PLAN_LIMIT = 32;

async function readClientVersion(paths) {
  const candidates = [
    join(paths.appRoot, "package.json"),
    join(paths.root, "package.json"),
    join(paths.root, "app", "package.json"),
    join(paths.root, "resources", "app", "package.json"),
    join(process.cwd(), "package.json")
  ];

  for (const candidate of [...new Set(candidates)]) {
    try {
      const pkg = JSON.parse(await readFile(candidate, "utf8"));
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {}
  }

  return "0.0.0";
}

const server = http.createServer(async (req, res) => {
  try {
    // Guard every method (not just POST): a non-loopback Host header means the
    // request was routed here through some other name (DNS rebinding), so reject
    // it before any handler reads state.
    assertLocalHostHeader(req);
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "POST") {
      assertLocalWriteRequest(req);
    } else {
      assertLocalReadRequest(req);
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, buildHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/client/status") {
      return json(res, { ...(await buildStatus()), enrollment: await enrollmentStatus() });
    }

    if (req.method === "GET" && url.pathname === "/api/enrollment/session") {
      return json(res, await enrollmentStatus());
    }

    if (req.method === "POST" && url.pathname === "/api/enrollment/channel/import") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CHANNEL_IMPORT, await readJson(req));
      return await withClientStateLock(paths, async () => {
        const imported = importEnrollmentChannel(body.code);
        const session = await readEnrollmentSession(paths) || { version: 1, identity: null, servers: {} };
        const existing = session.servers?.[imported.pin.serverId];
        if (existing && (existing.pin?.keyId !== imported.pin.keyId
          || publicKeyFingerprint(existing.pin.publicKey) !== publicKeyFingerprint(imported.pin.publicKey))) {
          throw makeHttpError("enrollment_trust_failed", 409, "This server signing key changed; verify the new fingerprint with the administrator before importing");
        }
        session.servers ||= {};
        session.servers[imported.pin.serverId] = {
          ...(existing || {}),
          pin: imported.pin,
          channel: imported.channel,
          channelCode: imported.channelCode,
          bootstrapEndpoint: imported.bootstrapEndpoint,
          phase: existing?.phase || "channel-verified",
          trustFingerprint: publicKeyFingerprint(imported.pin.publicKey)
        };
        session.activeServerId = imported.pin.serverId;
        await saveEnrollmentSession(session, paths);
        return json(res, await enrollmentStatus());
      });
    }

    if (req.method === "POST" && url.pathname === "/api/enrollment/request") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_REQUEST, await readJson(req));
      return await withClientStateLock(paths, async () => {
        const session = await readEnrollmentSession(paths);
        const serverState = activeEnrollmentServer(session);
        if (!session.identity) session.identity = createEnrollmentIdentity();
        const requestState = serverState.request?.status === "consumed"
          ? { requestId: `req_${randomUUID().replace(/-/g, "")}`, status: "submitting" }
          : serverState.request || { requestId: `req_${randomUUID().replace(/-/g, "")}`, status: "submitting" };
        serverState.request = requestState;
        serverState.phase = "request-pending";
        await saveEnrollmentSession(session, paths);
        const result = await withEnrollmentTunnel(serverState, (proxy) => submitEnrollmentRequest({
          channel: serverState,
          identity: session.identity,
          requestState,
          sendRequest: (endpoint, target, bytes, headers) => requestThroughSocks(endpoint, target, bytes, headers, proxy)
        }));
        serverState.request = { ...result, status: "pending" };
        serverState.phase = "request-pending";
        await saveEnrollmentSession(session, paths);
        return json(res, await enrollmentStatus());
      });
    }

    if (req.method === "POST" && url.pathname === "/api/enrollment/consume") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CONSUME, await readJson(req));
      return await withClientStateLock(paths, async () => {
        const session = await readEnrollmentSession(paths);
        const serverState = activeEnrollmentServer(session);
        if (!session.identity || !serverState.request?.requestId || serverState.request?.status !== "pending") {
          throw makeHttpError("enrollment_request_invalid", 409, "Submit an enrollment request before entering the administrator code");
        }
        const result = await withEnrollmentTunnel(serverState, (proxy) => consumeEnrollmentCode({
          channel: serverState,
          identity: session.identity,
          requestState: serverState.request,
          code: body.code,
          sendRequest: (endpoint, target, bytes, headers) => requestThroughSocks(endpoint, target, bytes, headers, proxy)
        }));
        serverState.phase = result.status;
        serverState.receipt = result.receipt;
        serverState.request.status = "consumed";
        await saveEnrollmentSession(session, paths);
        return json(res, await enrollmentStatus());
      });
    }

    if (req.method === "POST" && url.pathname === "/api/enrollment/data-authorizations/refresh") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_DATA_AUTHORIZATIONS_REFRESH, await readJson(req));
      return json(res, await refreshDataAuthorizations());
    }

    if (req.method === "POST" && url.pathname === "/api/enrollment/connection/repair") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_CONNECTION_REPAIR, await readJson(req));
      return json(res, { operation: await startConnectionRepairOperation(body) });
    }

    const repairStatusMatch = url.pathname.match(/^\/api\/enrollment\/connection\/repair\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && repairStatusMatch) {
      return json(res, { operation: await getConnectionRepairOperation(repairStatusMatch[1]) });
    }

    if (req.method === "POST" && url.pathname === "/api/client/shutdown") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SHUTDOWN, await readJson(req));
      json(res, { ok: true });
      scheduleClientShutdown();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/binaries/check") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_BINARIES_CHECK, await readJson(req));
      return json(res, await checkBinaries());
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const profile = await readStoredProfile(paths);
      return json(res, { profile: profile ? summarizeClientProfile(profile) : null });
    }

    if (req.method === "POST" && url.pathname === "/api/profile/import") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT, await readJson(req));
      const profile = await importProfile(body);
      return json(res, { profile: summarizeClientProfile(profile) });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const jobs = await readStoredJobs(paths);
      return json(res, { jobs: jobs.map(summarizeClientJob) });
    }

    const recoveryRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/recovery(?:\/(restore-preview|restore|restore-cancel))?$/);
    if (recoveryRoute) {
      let jobId;
      try { jobId = decodeURIComponent(recoveryRoute[1]); } catch { throw createHttpError("validation_failed", 400, "Invalid job ID"); }
      const action = recoveryRoute[2] || "list";
      if (req.method === "GET" && action === "list") {
        return await withClientDataOperation(async () => {
          const context = await prepareSyncRecoveryContext(jobId);
          const versions = await listRecoveryVersionsForContext(context);
          return json(res, { jobId, versions });
        });
      }
      if (req.method === "POST" && action === "restore-preview") {
        const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE_PREVIEW, await readJson(req));
        return await withClientDataOperation(async () => {
          const context = await prepareSyncRecoveryContext(jobId);
          const preview = await withRecoveryContext(context, () => previewSyncRecoveryRestore({ ...recoveryOptions(context), ...body }));
          return json(res, { jobId, preview: {
            previewId: preview.previewId, runId: preview.runId, side: preview.side, path: preview.relativePath,
            destinationPath: relative(context.job.localPath, preview.destination).replace(/\\/g, "/"),
            sourceSha256: preview.sourceSha256,
            expiresAt: new Date(Date.parse(preview.createdAt) + 10 * 60 * 1000).toISOString()
          } });
        });
      }
      if (req.method === "POST" && action === "restore") {
        const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE, await readJson(req));
        return await withClientDataOperation(async () => {
          const context = await prepareSyncRecoveryContext(jobId);
          const result = await restoreSyncRecoveryVersion({ ...recoveryOptions(context), previewId: body.previewId });
          return json(res, { jobId, restored: result.restored,
            destinationPath: relative(context.job.localPath, result.destinationPath).replace(/\\/g, "/"),
            sourceSha256: result.sha256, runId: result.runId });
        });
      }
      if (req.method === "POST" && action === "restore-cancel") {
        const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE_CANCEL, await readJson(req));
        return await withClientDataOperation(async () => {
          const context = await prepareSyncRecoveryContext(jobId);
          return json(res, { jobId, cancelled: await cancelSyncRecoveryRestorePreview(body.previewId, {
            job: context.job, relation: context.job.syncRelation
          }) });
        });
      }
      throw createHttpError("not_found", 404, "Sync recovery endpoint was not found");
    }

    if (req.method === "GET" && url.pathname === "/api/sync/history") {
      return json(res, { history: await readSyncHistory(paths) });
    }

    if (req.method === "POST" && url.pathname === "/api/jobs/save") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      requireDestructiveSyncConfirmation(body);
      const payload = await withClientStateLock(paths, async () => {
        await ensureLocalStateWritable();
        await ensureSecretVaultReady();
        const normalizedJob = await normalizeJob(body.job || {});
        await requireManualScheduleForRiskySync(normalizedJob);
        const job = await saveJob(normalizedJob, paths);
        await refreshScheduler();
        return { job: summarizeClientJob(job), scheduler: buildSchedulerStatus() };
      });
      return json(res, payload);
    }

    if (req.method === "POST" && url.pathname === "/api/singbox/start") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SINGBOX_START, await readJson(req));
      return json(res, { singbox: await startSingboxFromImportedProfile() });
    }

    if (req.method === "POST" && url.pathname === "/api/singbox/stop") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SINGBOX_STOP, await readJson(req));
      return json(res, { singbox: await singboxProcess.stopAndWait({ timeoutMs: 2500 }) });
    }

    if (req.method === "POST" && url.pathname === "/api/sync/preview") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_PREVIEW, await readJson(req));
      return json(res, await buildSyncPreview(body.job || {}));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/safety-plan") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_SAFETY_PLAN, await readJson(req));
      return await withClientDataOperation(async () => json(res, { plan: await createSyncSafetyPlan(body.job || {}) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/conflicts/preview") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_PREVIEW, await readJson(req));
      return await withClientDataOperation(async () => json(res, { preview: await createFirstBisyncConflictPreview(body.job || {}) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/conflicts/save") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_SAVE, await readJson(req));
      return await withClientDataOperation(async () => json(res, { saved: await persistFirstBisyncConflictCopies(body.job || {}, body.previewId) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/conflicts/operations") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_OPERATIONS, await readJson(req));
      return await withClientDataOperation(async () => json(res, { operations: await readFirstBisyncConflictOperations(body.job || {}) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/conflicts/resume") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_RESUME, await readJson(req));
      return await withClientDataOperation(async () => json(res, { saved: await resumeFirstBisyncConflict(body.job || {}, body.operationId) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/initialize") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_INITIALIZE, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      return await withClientDataOperation(async () => json(res, { initialization: await initializeBidirectionalSync(body) }));
    }

    if (req.method === "POST" && url.pathname === "/api/sync/run") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RUN, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      requireDestructiveSyncConfirmation(body);
      return json(res, { sync: await runSync(body.job || {}, { trigger: "manual", safetyPlanId: body.safetyPlanId }) });
    }

    if (req.method === "POST" && url.pathname === "/api/sync/stop") {
      parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_STOP, await readJson(req));
      return json(res, { sync: await stopSync() });
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      return json(res, {
        singbox: await readRecentLog(paths.singboxLog),
        rclone: await readRecentLog(paths.rcloneLog)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/diagnostics/export") {
      return json(res, await buildDiagnosticExport());
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    jsonError(res, makeHttpError("not_found", 404));
  } catch (error) {
    jsonError(res, error);
  }
});

server.on("error", (error) => {
  handleListenError(error).catch((fatal) => {
    console.error(fatal && fatal.stack ? fatal.stack : fatal);
    process.exit(1);
  });
});

server.listen(port, host, () => {
  const url = clientUrl();
  console.log(`Syncraft Client: ${url}`);
  if (process.env.SFSC_OPEN_BROWSER === "1") {
    openBrowser(url);
  }
  installShutdownSignalHandlers();
  startBackgroundLoops();
});

let heartbeatTimer = null;
let schedulerTimer = null;
let shutdownStarted = false;

function startBackgroundLoops() {
  heartbeatTimer = setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  sendHeartbeat().catch(() => {});

  schedulerTimer = setInterval(() => {
    tickScheduler().catch(() => {});
  }, schedulerMs);
  schedulerTimer.unref?.();
  refreshScheduler({ triggerStartup: true }).catch(() => {});
  resumeSavedConnectionRepair().catch(() => {});
}

function scheduleClientShutdown() {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  setTimeout(() => {
    shutdownClientRuntime().catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
  }, 100);
}

async function shutdownClientRuntime() {
  clearInterval(heartbeatTimer);
  clearInterval(schedulerTimer);
  await Promise.all([
    syncProcess.stopAndWait({ timeoutMs: 2500 }),
    dataSingboxProcess.stopAndWait({ timeoutMs: 2500 }),
    singboxProcess.stopAndWait({ timeoutMs: 2500 })
  ]);
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

// Without these, terminating the client (Electron shell exit, taskkill, Ctrl+C)
// leaves sing-box.exe / rclone.exe running as orphans, holding the local proxy
// port and continuing transfers.
function installShutdownSignalHandlers() {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
  for (const signal of signals) {
    process.on(signal, () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      console.log(`Syncraft Client stopping on ${signal}`);
      shutdownClientRuntime().catch((error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
      });
    });
  }
}

async function handleListenError(error) {
  if (error?.code !== "EADDRINUSE") {
    throw error;
  }
  const url = clientUrl();
  if (await isExistingClientReady()) {
    console.log(`Syncraft Client already running: ${url}`);
    if (process.env.SFSC_OPEN_BROWSER === "1") {
      openBrowser(url);
    }
    process.exit(0);
  }
  throw createHttpError("client_port_in_use", 409, `Client port ${host}:${port} is already in use.`);
}

function clientUrl() {
  return `http://${host}:${port}/`;
}

function isExistingClientReady() {
  return new Promise((resolve) => {
    const req = http.get(`${clientUrl()}api/health`, { timeout: 800 }, (res) => {
      let body = "";
      let settled = false;
      const settle = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 32768) {
          req.destroy();
          settle(false);
        }
      });
      res.on("end", () => {
        settle(res.statusCode === 200 && isSfscClientHealth(body));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function isSfscClientHealth(body) {
  try {
    const payload = JSON.parse(body);
    return payload?.ok === true
      && payload?.mode === "client-exe-runtime"
      && payload?.diagnostics?.role === "client";
  } catch {
    return false;
  }
}

function buildHealth() {
  return {
    ok: true,
    mode: "client-exe-runtime",
    version: clientVersion,
    clientVersion,
    diagnostics
  };
}

async function enrollmentStatus() {
  const state = await readEnrollmentSession(paths).catch((error) => {
    if (error?.code === "local_state_corrupt") return { stateError: true };
    throw error;
  });
  if (state?.stateError) return { phase: "local-state-error", stateError: "local_state_corrupt" };
  const server = state?.servers?.[state.activeServerId] || null;
  if (server?.phase === "identity-verified-awaiting-directory-authorization"
    && !verifyPersistedEnrollmentReceipt(server, state.identity)) {
    return { phase: "local-state-error", stateError: "enrollment_trust_failed" };
  }
  const authorizedDirectories = [];
  if (state?.identity && server?.receipt && server?.dataAuthorizations) {
    for (const [relationId, envelope] of Object.entries(server.dataAuthorizations)) {
      try {
        const payload = verifyDataAuthorizationEnvelope(envelope, server.pin, {
          serverId: server.pin.serverId,
          deviceId: state.identity.deviceId,
          publicKey: state.identity.publicKey,
          relationId
        });
        authorizedDirectories.push({ relationId, displayName: payload.displayName, expiresAt: payload.expiresAt });
      } catch {}
    }
  }
  const enrollment = {
    phase: server?.phase || "not-started",
    serverId: server?.pin?.serverId || "",
    signingKeyId: server?.pin?.keyId || "",
    serverKeyFingerprint: server?.trustFingerprint || "",
    deviceId: state?.identity?.deviceId || "",
    requestId: server?.request?.requestId || "",
    status: server?.request?.status || "",
    directoryAuthorization: authorizedDirectories.length ? "granted" : "waiting",
    authorizedDirectories
  };
  const lastError = normalizeEnrollmentDiagnosticError(server?.lastEnrollmentError);
  if (lastError) enrollment.lastError = lastError;
  return enrollment;
}

async function refreshDataAuthorizations() {
  return withClientStateLock(paths, async () => {
    const session = await readEnrollmentSession(paths);
    const serverState = activeEnrollmentServer(session);
    const priorDataAuthorizations = structuredClone(serverState.dataAuthorizations || {});
    const outcome = await runEnrollmentRefreshWithDiagnostics(serverState, async () => {
      if (!session.identity || serverState.request?.status !== "consumed"
        || !verifyPersistedEnrollmentReceipt(serverState, session.identity)) {
        throw createHttpError("enrollment_trust_failed", 409, "A verified enrollment receipt is required before requesting directory access");
      }
      await ensureEnrollmentChannelFresh(session, serverState);
      const bindings = serverState.receipt.grant.bindings;
      serverState.dataAuthorizations ||= {};
      const pending = [];
      for (const binding of bindings) {
        try {
          const result = await issueDataAuthorization(serverState, session.identity, binding);
          serverState.dataAuthorizations[binding.identity.relationId] = result.envelope;
        } catch (error) {
          if (["enrollment_relation_denied", "enrollment_relation_revoked", "enrollment_data_authorization_denied"].includes(error?.code)) {
            pending.push(binding.identity.relationId);
            delete serverState.dataAuthorizations[binding.identity.relationId];
            continue;
          }
          throw error;
        }
      }
      return { pendingDirectories: pending.length };
    }, () => saveEnrollmentSession(session, paths), {
      onFailure: () => { serverState.dataAuthorizations = priorDataAuthorizations; }
    });
    return { ...(await enrollmentStatus()), pendingDirectories: outcome.pendingDirectories };
  });
}

async function issueDataAuthorization(serverState, identity, binding) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withEnrollmentTunnel(serverState, (proxy) => requestDataAuthorization({
        channel: serverState,
        identity,
        binding,
        nowMs: Date.now(),
        sendRequest: (endpoint, target, bytes, headers) => requestThroughSocks(endpoint, target, bytes, headers, proxy)
      }));
    } catch (error) {
      if (!DATA_AUTHORIZATION_RETRYABLE_CODES.has(error?.code) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw createHttpError("enrollment_transport_failed", 503, "Could not retrieve the signed directory authorization");
}

async function ensureEnrollmentChannelFresh(session, serverState) {
  if (!enrollmentChannelNeedsRenewal(serverState)) return false;
  if (!session.identity || serverState.request?.status !== "consumed"
    || !verifyPersistedEnrollmentReceipt(serverState, session.identity)) {
    throw createHttpError("enrollment_trust_failed", 409, "A verified enrollment receipt is required for channel renewal");
  }
  const renewed = await withEnrollmentTunnel(serverState, (proxy) => renewEnrollmentChannel({
    serverState,
    identity: session.identity,
    sendRequest: (endpoint, target, bytes, headers) => requestThroughSocks(endpoint, target, bytes, headers, proxy)
  }), { allowExpiredForRenewal: true });
  Object.assign(serverState, renewed);
  await saveEnrollmentSession(session, paths);
  return true;
}

function activeEnrollmentServer(session) {
  const server = session?.servers?.[session.activeServerId];
  if (!server) throw createHttpError("enrollment_channel_invalid", 409, "Import a channel code first");
  return server;
}

async function withEnrollmentTunnel(serverState, task, { allowExpiredForRenewal = false } = {}) {
  if (!serverState?.channel?.connection?.uri || !serverState.bootstrapEndpoint) {
    throw createHttpError("enrollment_channel_invalid", 409, "Enrollment channel is incomplete");
  }
  if (allowExpiredForRenewal) revalidateEnrollmentChannelForRenewal(serverState);
  else revalidateEnrollmentChannel(serverState);
  if (!await fileExists(paths.singboxExe)) throw missingBinaryError("sing-box", paths.singboxExe, "missing_singbox_binary");
  const localProxyPort = await allocateLocalPort();
  const config = buildClientSingboxConfig(serverState.channel.connection.uri, {
    localProxyHost: "127.0.0.1",
    localProxyPort
  });
  await writeProtectedJsonFile(paths.enrollmentSingboxConfigFile, config);
  const check = await runBuffered(paths.singboxExe, ["check", "-c", paths.enrollmentSingboxConfigFile], {
    cwd: paths.root,
    timeoutMs: 10000
  });
  if (!check.ok) throw createHttpError("singbox_start_failed", 503, "The enrollment tunnel configuration was rejected by sing-box");
  try {
    await enrollmentSingboxProcess.start(paths.singboxExe, ["run", "-c", paths.enrollmentSingboxConfigFile], {
      cwd: paths.root,
      errorCode: "singbox_start_failed",
      readyProbe: () => isTcpPortOpen("127.0.0.1", localProxyPort),
      readyTimeoutMs: 5000,
      readyIntervalMs: 100
    });
    return await task({ host: "127.0.0.1", port: localProxyPort });
  } finally {
    if (enrollmentSingboxProcess.isRunning()) await enrollmentSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
  }
}

async function allocateLocalPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function localPortCanBeBound(port) {
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") return false;
    throw error;
  }
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return true;
}

async function selectSftpLocalProxyPort(requestedPort) {
  const preferred = normalizeTcpPort(requestedPort, {
    field: "job.localProxyPort",
    defaultValue: SFTP_DATA_SOCKS_PORT
  });
  if (await localPortCanBeBound(preferred)) return preferred;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await allocateLocalPort();
    if (candidate !== preferred && await localPortCanBeBound(candidate)) return candidate;
  }
  throw createHttpError("singbox_start_failed", 503, "Could not select an available local SFTP proxy port after three attempts.");
}

async function buildStatus() {
  const binaries = await checkBinaryPresence();
  const releaseManifest = await readReleaseManifestSummary(paths.releaseManifestFile);
  const localState = await inspectLocalState(paths);
  const secretVault = await inspectSecretVault(paths).catch((error) => {
    if (error?.code === "local_state_corrupt") {
      return {
        backend: "file",
        path: paths.secretsFile,
        protected: false,
        protection: {
          protected: false,
          mode: process.platform === "win32" ? "windows-acl" : "not_applicable",
          exists: true
        },
        refs: 0,
        missingRefs: [],
        ok: false
      };
    }
    throw error;
  });
  const publicSecretVault = summarizeSecretVaultForStatus(secretVault);
  const profile = await readStoredProfile(paths).catch((error) => {
    if (error?.code === "local_state_corrupt") return null;
    throw error;
  });
  const jobs = await readStoredJobs(paths).catch((error) => {
    if (error?.code === "local_state_corrupt") return [];
    throw error;
  });
  const syncHistory = await readSyncHistory(paths);
  return {
    ok: true,
    mode: "client-exe-runtime",
    appVersion: clientVersion,
    clientVersion,
    diagnostics,
    releaseManifest,
    paths: {
      root: paths.root,
      binRoot: paths.binRoot,
      dataRoot: paths.dataRoot
    },
    binaries,
    profileImported: Boolean(profile),
    profileSummary: profile ? summarizeImportProfile(profile) : null,
    jobs: jobs.map(summarizeClientJob),
    scheduler: buildSchedulerStatus(),
    syncHistory,
    lastSync: syncHistory[0] || null,
    processes: {
      singbox: singboxProcess.status(),
      dataSingbox: dataSingboxProcess.status(),
      sync: {
        ...currentSyncProcessStatus(),
        metrics: currentSyncMetrics()
      }
    },
    heartbeat: lastHeartbeat,
    lastSuccessfulHeartbeat,
    safeguards: {
      tun: false,
      systemProxy: false,
      routeMutation: false,
      dnsMutation: false,
      rcloneConfigScope: paths.rcloneConfigFile,
      localState,
      secretVault: publicSecretVault
    }
  };
}

function summarizeSecretVaultForStatus(vault = {}) {
  const missingCount = Array.isArray(vault.missingRefs) ? vault.missingRefs.length : 0;
  return {
    ...vault,
    missingRefs: Array.from({ length: missingCount }, () => "redacted")
  };
}

function summarizeClientJob(job = {}) {
  return {
    id: job.id,
    name: job.name,
    localPath: job.localPath,
    direction: job.direction,
    storageBackend: job.storageBackend,
    relationId: job.relationId,
    directoryDisplayName: job.directoryDisplayName,
    remoteFolder: job.remoteFolder,
    serverSpace: job.serverSpace,
    transfers: job.transfers,
    streams: job.streams,
    dryRun: job.dryRun,
    destructiveSync: job.destructiveSync,
    safety: job.safety,
    bandwidthLimit: job.bandwidthLimit,
    schedule: job.schedule,
    checkers: job.checkers,
    s3UploadConcurrency: job.s3UploadConcurrency,
    s3ChunkSize: job.s3ChunkSize,
    chunkSize: job.chunkSize,
    cutoff: job.cutoff,
    retries: job.retries,
    lowLevelRetries: job.lowLevelRetries,
    localProxyPort: job.localProxyPort,
    clientName: job.clientName,
    remoteName: job.remoteName,
    bucketName: job.bucketName,
    remotePrefix: job.remotePrefix,
    s3Endpoint: job.s3Endpoint,
    syncRelation: summarizeSyncRelation(job.syncRelation)
  };
}

function summarizeClientProfile(profile = {}) {
  const summary = summarizeImportProfile(profile);
  return {
    version: profile.version,
    profileId: profile.profileId,
    clientName: profile.clientName,
    issuedAt: profile.issuedAt,
    expiresAt: profile.expiresAt,
    importedAt: profile.importedAt,
    importMode: profile.importMode,
    source: profile.source ? {
      type: profile.source.type,
      server: profile.source.server
    } : undefined,
    summary,
    tunnel: {
      type: profile.tunnel?.type || "vless",
      parsed: profile.tunnel?.parsed ? {
        server: profile.tunnel.parsed.server,
        port: profile.tunnel.parsed.port
      } : null
    },
    heartbeat: profile.heartbeat ? {
      scheme: profile.heartbeat.scheme,
      configured: true
    } : null,
    storage: {
      type: profile.storage?.type || "s3",
      remoteName: profile.storage?.remoteName,
      endpoint: profile.storage?.endpoint,
      bucket: profile.storage?.bucket,
      prefix: profile.storage?.prefix
    },
    // v2：把服务端已经算好的空间归属和授权透传给 UI。
    // UI 必须只读这两块来决定可选同步方向；它们不含任何密钥，展示安全。
    // legacy/离线 profile 没有这两块，此时为 null，UI 退回到「三个方向都可选」的旧行为。
    syncSpace: profile.syncSpace ? {
      id: profile.syncSpace.id,
      syncId: profile.syncSpace.syncId,
      mode: profile.syncSpace.mode
    } : null,
    authorization: profile.authorization ? {
      role: profile.authorization.role,
      directions: Array.isArray(profile.authorization.directions) ? [...profile.authorization.directions] : [],
      allowDelete: profile.authorization.allowDelete === true
    } : null,
    defaults: profile.defaults || {}
  };
}

async function buildDiagnosticExport() {
  const generatedAt = new Date().toISOString();
  const bundle = buildDiagnosticBundle({
    generatedAt,
    status: { ...(await buildStatus()), enrollment: await enrollmentStatus() },
    environment: await buildDiagnosticEnvironment(),
    logs: {
      electron: await readRecentLogWithMeta(paths.electronLog),
      singbox: await readRecentLogWithMeta(paths.singboxLog),
      rclone: await readRecentLogWithMeta(paths.rcloneLog)
    }
  });
  return {
    ok: true,
    filename: `sfsc-client-diagnostics-${generatedAt.replace(/[:.]/g, "-")}.json`,
    bundle
  };
}

async function buildDiagnosticEnvironment() {
  const [
    singboxFile,
    rcloneFile,
    releaseManifest,
    profileFile,
    jobsFile,
    secretsFile,
    syncHistoryFile,
    syncRecoveryDirectory,
    claimRecoveryFile,
    heartbeatSnapshotFile,
    electronLogFile,
    singboxLogFile,
    rcloneLogFile
  ] = await Promise.all([
    fileSummary(paths.singboxExe),
    fileSummary(paths.rcloneExe),
    readReleaseManifestSummary(paths.releaseManifestFile),
    fileSummary(paths.profileFile),
    fileSummary(paths.jobsFile),
    fileSummary(paths.secretsFile),
    fileSummary(paths.syncHistoryFile),
    fileSummary(paths.syncRecoveryRoot),
    fileSummary(paths.claimRecoveryFile),
    fileSummary(paths.heartbeatSnapshotFile),
    fileSummary(paths.electronLog),
    fileSummary(paths.singboxLog),
    fileSummary(paths.rcloneLog)
  ]);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    cwd: process.cwd(),
    portableRoot: Boolean(process.env.SFSC_PORTABLE_ROOT),
    appRoot: paths.appRoot,
    root: paths.root,
    dataRoot: paths.dataRoot,
    releaseManifest,
    binaries: {
      singbox: singboxFile,
      rclone: rcloneFile
    },
    stateFiles: {
      profile: profileFile,
      jobs: jobsFile,
      secrets: secretsFile,
      syncHistory: syncHistoryFile,
      syncRecovery: syncRecoveryDirectory,
      claimRecovery: claimRecoveryFile,
      lastSuccessfulHeartbeat: heartbeatSnapshotFile
    },
    logFiles: {
      electron: electronLogFile,
      singbox: singboxLogFile,
      rclone: rcloneLogFile
    }
  };
}

async function fileSummary(file) {
  try {
    const info = await stat(file);
    return {
      path: file,
      exists: true,
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: file,
        exists: false,
        size: 0,
        modifiedAt: null
      };
    }
    throw error;
  }
}

async function readReleaseManifestSummary(file) {
  const summary = await fileSummary(file);
  if (!summary.exists) {
    return {
      ...summary,
      ok: false,
      schemaVersion: null,
      package: "",
      version: "",
      builtAt: null,
      fileCount: 0,
      supportDocuments: summarizeManifestSupportDocuments([]),
      requiredFiles: summarizeManifestRequiredFiles("", []),
      errorCode: "release_manifest_missing",
      message: "release-manifest.json was not found in the client package root."
    };
  }

  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const fileCount = files.length;
    const supportDocuments = summarizeManifestSupportDocuments(files);
    const requiredFiles = summarizeManifestRequiredFiles(manifest.package, files);
    const builtAt = typeof manifest.builtAt === "string" && Number.isFinite(new Date(manifest.builtAt).getTime())
      ? manifest.builtAt
      : null;
    const validPackageNames = new Set(["SyncraftDesktop", "SyncraftClient"]);
    const schemaOk = manifest.schemaVersion === 1
      && validPackageNames.has(manifest.package)
      && typeof manifest.version === "string"
      && manifest.version.trim()
      && Boolean(builtAt)
      && Array.isArray(manifest.files);
    const ok = schemaOk && supportDocuments.ok && requiredFiles.ok;
    return {
      ...summary,
      ok: Boolean(ok),
      schemaVersion: Number.isInteger(manifest.schemaVersion) ? manifest.schemaVersion : null,
      package: typeof manifest.package === "string" ? manifest.package : "",
      version: typeof manifest.version === "string" ? manifest.version : "",
      builtAt,
      fileCount,
      supportDocuments,
      requiredFiles,
      errorCode: ok ? "" : "release_manifest_invalid",
      message: ok ? "" : "release-manifest.json is present but does not match the expected schema."
    };
  } catch (error) {
    return {
      ...summary,
      ok: false,
      schemaVersion: null,
      package: "",
      version: "",
      builtAt: null,
      fileCount: 0,
      supportDocuments: summarizeManifestSupportDocuments([]),
      requiredFiles: summarizeManifestRequiredFiles("", []),
      errorCode: "release_manifest_invalid",
      message: `release-manifest.json could not be parsed: ${error.message}`
    };
  }
}

function summarizeManifestSupportDocuments(files = []) {
  return {
    ok: requiredSupportDocuments.every((required) => {
      const entry = files.find((file) => file?.name === required.path);
      return isValidManifestFileEntry(entry);
    }),
    files: requiredSupportDocuments.map((required) => {
      const entry = files.find((file) => file?.name === required.path);
      return {
        name: required.name,
        path: required.path,
        present: Boolean(entry),
        valid: isValidManifestFileEntry(entry),
        size: Number(entry?.size || 0),
        sha256: typeof entry?.sha256 === "string" ? entry.sha256 : ""
      };
    })
  };
}

function isValidManifestFileEntry(entry) {
  return Boolean(
    entry
    && Number.isFinite(entry.size)
    && entry.size > 0
    && /^[a-f0-9]{64}$/.test(entry.sha256 || "")
  );
}

function summarizeManifestRequiredFiles(packageName, files = []) {
  const required = requiredManifestFilesByPackage[packageName] || [];
  return {
    ok: required.length > 0 && required.every(([, path]) => {
      const entry = files.find((file) => file?.name === path);
      return isValidManifestFileEntry(entry);
    }),
    package: required.length > 0 ? packageName : "",
    files: required.map(([name, path]) => {
      const entry = files.find((file) => file?.name === path);
      return {
        name,
        path,
        present: Boolean(entry),
        valid: isValidManifestFileEntry(entry),
        size: Number(entry?.size || 0),
        sha256: typeof entry?.sha256 === "string" ? entry.sha256 : ""
      };
    })
  };
}

async function importProfile(body = {}) {
  return withClientStateLock(paths, async () => {
    await ensureLocalStateWritable();
    const claimRecovery = await prepareClaimRecoveryForImport(body);
    const stateSnapshot = await snapshotProfileImportState(paths);
    try {
      const previousProfile = await readStoredProfile(paths);
      const resolvedProfile = await resolveProfileImport(body, {
        timeoutMs: claimRedeemTimeoutMs,
        clientRedeemId: claimRecovery?.clientRedeemId,
        clientInstallId: claimRecovery?.clientInstallId
      });
      const profile = await saveProfile(resolvedProfile, paths);
      await refreshJobsForProfile(profile, previousProfile);
      await refreshScheduler();
      await clearClaimRecovery(claimRecovery, paths);
      await resetHeartbeatState();
      sendHeartbeat().catch(() => {});
      return profile;
    } catch (error) {
      await restoreProfileImportState(stateSnapshot);
      await refreshScheduler();
      if (shouldClearClaimRecoveryAfterImportFailure(error)) {
        await clearClaimRecovery(claimRecovery, paths);
      }
      throw error;
    }
  });
}

function shouldClearClaimRecoveryAfterImportFailure(error) {
  return Boolean(error?.claimRedeemRemoteResponse)
    && CLAIM_RECOVERY_TERMINAL_ERRORS.has(normalizeHttpError(error, "client_error").code);
}

async function resetHeartbeatState() {
  heartbeatGeneration += 1;
  lastHeartbeat = null;
  lastSuccessfulHeartbeat = null;
  await clearLastSuccessfulHeartbeat(paths);
}

async function prepareClaimRecoveryForImport(body = {}) {
  let claim = null;
  try {
    claim = resolveClaimReference(body);
  } catch {
    return null;
  }
  if (!claim) return null;
  return prepareClaimRecovery(claim, paths);
}

async function ensureLocalStateWritable() {
  const localState = await inspectLocalState(paths);
  if (localState.ok) {
    return;
  }
  const failed = localState.files.find((file) => file.ok === false);
  throw createHttpError(
    "local_state_corrupt",
    409,
    failed?.message || "Local state file is not valid JSON"
  );
}

async function ensureSecretVaultReady() {
  const secretVault = await inspectSecretVault(paths);
  if (secretVault.ok) {
    return;
  }
  throw createHttpError(
    "secret_vault_missing",
    409,
    "Local secret vault is missing required entries. Re-import the SyncKey."
  );
}

async function refreshJobsForProfile(profile, previousProfile = null) {
  const existingJobs = await readStoredJobs(paths);
  if (!existingJobs.length) {
    return [];
  }
  const [bisyncState, runtimeDirectoryIds] = await Promise.all([
    readBisyncState(),
    readBisyncRuntimeDirectoryIds()
  ]);
  const refreshed = [];
  for (const job of existingJobs) {
    const userFields = pickUserJobFields(job);
    const candidateJob = {
      ...buildJobFromProfile(profile, userFields),
      exclude: Array.isArray(job.exclude) ? [...job.exclude] : [],
      id: job.id,
      createdAt: job.createdAt || job.updatedAt || new Date().toISOString()
    };
    if (candidateJob.direction !== "bidirectional") {
      refreshed.push(candidateJob);
      continue;
    }
    let relation = buildSyncRelation(profile, candidateJob);
    if (job.syncRelation) {
      if (!sameSyncRelationBaseline(relation, job.syncRelation)) {
        refreshed.push(markJobRelationForReview(job, job.syncRelation, "sync_relation_baseline_changed"));
        continue;
      }
      if (!job.syncRelation.serverIdentityProven
        && !relation.serverIdentityProven
        && syncRelationConnectionChanged(relation, job.syncRelation)) {
        refreshed.push(markJobRelationForReview(job, job.syncRelation, "server_identity_unproven_for_connection_change"));
        continue;
      }
      relation = reuseMatchingSyncRelation(relation, job.syncRelation);
      if (relation.migration.state === "review_required") {
        refreshed.push({
          ...candidateJob,
          syncRelation: relation
        });
        continue;
      }
    } else if (previousProfile) {
      const previousRelation = buildSyncRelation(previousProfile, job);
      if (!sameSyncRelationBaseline(relation, previousRelation)) {
        refreshed.push(markJobRelationForReview(job, previousRelation, "profile_sync_relation_changed"));
        continue;
      }
      if (!relation.serverIdentityProven
        && syncRelationConnectionChanged(relation, previousRelation)) {
        refreshed.push(markJobRelationForReview(job, previousRelation, "server_identity_unproven_for_connection_change"));
        continue;
      }
    }
    const legacyJob = !job.syncRelation || job.syncRelation.migration?.state === "legacy_compatible"
      ? {
          storedJob: job,
          candidateJob
        }
      : null;
    relation = resolveBisyncMigration(relation, bisyncState, {
      runtimeDirectoryIds,
      runtimeBisyncRoot: paths.runtimeRoot,
      legacyJob
    });
    refreshed.push(applySyncRelationToJob(candidateJob, relation));
  }
  return saveJobs(refreshed, paths);
}

function pickUserJobFields(job = {}) {
  return {
    name: job.name,
    localPath: job.localPath,
    direction: job.direction,
    serverSpace: job.serverSpace,
    remoteFolder: job.remoteFolder,
    transfers: job.transfers,
    streams: job.streams,
    checkers: job.checkers,
    s3UploadConcurrency: job.s3UploadConcurrency,
    s3ChunkSize: job.s3ChunkSize,
    chunkSize: job.chunkSize,
    cutoff: job.cutoff,
    retries: job.retries,
    lowLevelRetries: job.lowLevelRetries,
    exclude: Array.isArray(job.exclude) ? [...job.exclude] : [],
    dryRun: job.dryRun,
    destructiveSync: job.destructiveSync,
    safety: job.safety,
    bandwidthLimit: job.bandwidthLimit,
    schedule: job.schedule,
    localProxyPort: job.localProxyPort
  };
}

function markJobRelationForReview(job, relation, reason) {
  const reviewJob = { ...job };
  delete reviewJob.secretAccessKey;
  delete reviewJob.s3SecretAccessKey;
  return {
    ...reviewJob,
    syncRelation: {
      ...relation,
      migration: {
        state: "migration_required",
        reasons: [reason],
        legacyFingerprint: relation.migration?.legacyFingerprint || ""
      }
    }
  };
}

async function checkBinaryPresence() {
  const singboxExists = await fileExists(paths.singboxExe);
  const rcloneExists = await fileExists(paths.rcloneExe);
  return {
    singbox: binaryPresence("sing-box", paths.singboxExe, singboxExists, "missing_singbox_binary"),
    rclone: binaryPresence("rclone", paths.rcloneExe, rcloneExists, "missing_rclone_binary")
  };
}

function binaryPresence(name, path, exists, missingCode) {
  return {
    path,
    exists,
    ok: exists,
    errorCode: exists ? "" : missingCode,
    message: exists ? "" : `Missing bundled ${name}: ${path}`
  };
}

async function checkBinaries() {
  const binaries = await checkBinaryPresence();
  const singboxVersion = binaries.singbox.exists ? await runBuffered(paths.singboxExe, ["version"], { timeoutMs: 10000 }) : null;
  const rcloneVersion = binaries.rclone.exists ? await runBuffered(paths.rcloneExe, ["version"], { timeoutMs: 10000 }) : null;
  const singbox = binaryCheckResult(binaries.singbox, singboxVersion);
  const rclone = binaryCheckResult(binaries.rclone, rcloneVersion);
  return {
    ok: Boolean(singbox.ok && rclone.ok),
    singbox,
    rclone
  };
}

function binaryCheckResult(binary, version) {
  const ok = Boolean(binary.exists && version?.ok);
  return {
    ...binary,
    ok,
    errorCode: ok ? "" : binary.errorCode || "binary_version_check_failed",
    message: ok ? "" : binary.message || version?.error || "Binary version check failed",
    version
  };
}

async function startSingboxFromImportedProfile() {
  return startSingbox({ useStoredProfile: true });
}

async function startSingbox(options = {}) {
  if (singboxProcess.isRunning()) {
    return singboxProcess.status();
  }
  if (options.useStoredProfile) {
    await ensureSecretVaultReady();
  }
  const profile = options.useStoredProfile ? await readProfile(paths) : null;
  const uri = options.useStoredProfile ? getTunnelUri(profile) : options.uri;
  const localProxyPort = options.useStoredProfile
    ? profile?.defaults?.localProxyPort || profile?.options?.localProxyPort
    : options.localProxyPort;
  if (!uri) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before starting sing-box");
  }
  if (!await fileExists(paths.singboxExe)) {
    throw missingBinaryError("sing-box", paths.singboxExe, "missing_singbox_binary");
  }

  const config = buildClientSingboxConfig(uri, {
    localProxyHost: "127.0.0.1",
    localProxyPort: Number(localProxyPort || 18081)
  });
  try {
    await writeFile(paths.singboxConfigFile, JSON.stringify(config, null, 2), "utf8");
    // The generated config embeds the tunnel credential (VLESS UUID), so it gets
    // the same owner-only ACL as the secret vault.
    await protectLocalSecretFile(paths.singboxConfigFile);
    const check = await runBuffered(paths.singboxExe, ["check", "-c", paths.singboxConfigFile], {
      cwd: paths.root,
      timeoutMs: 10000
    });
    if (!check.ok) {
      const detail = redactLogText([check.stderr, check.stdout, check.error].filter(Boolean).join("\n") || "unknown error");
      throw new Error(`sing-box check failed: ${detail}`);
    }
    return await singboxProcess.start(paths.singboxExe, ["run", "-c", paths.singboxConfigFile], {
      cwd: paths.root,
      errorCode: "singbox_start_failed",
      readyProbe: () => isTcpPortOpen("127.0.0.1", config.inbounds[0].listen_port),
      readyTimeoutMs: 5000,
      readyIntervalMs: 100
    });
  } catch (error) {
    throw createHttpError("singbox_start_failed", 500, `Failed to start sing-box: ${error.message}`);
  }
}

async function startDataSingbox(uri, localProxyPort = SFTP_DATA_SOCKS_PORT) {
  if (dataSingboxProcess.isRunning()) {
    throw createHttpError("singbox_start_failed", 409, "The SFTP data tunnel is already in use");
  }
  if (!await fileExists(paths.singboxExe)) {
    throw missingBinaryError("sing-box", paths.singboxExe, "missing_singbox_binary");
  }
  const config = buildClientSingboxConfig(uri, {
    localProxyHost: "127.0.0.1",
    localProxyPort: Number(localProxyPort)
  });
  await writeProtectedJsonFile(paths.dataSingboxConfigFile, config);
  const check = await runBuffered(paths.singboxExe, ["check", "-c", paths.dataSingboxConfigFile], {
    cwd: paths.root,
    timeoutMs: 10000
  });
  if (!check.ok) {
    throw createHttpError("singbox_start_failed", 503, "The SFTP data tunnel configuration was rejected by sing-box");
  }
  return dataSingboxProcess.start(paths.singboxExe, ["run", "-c", paths.dataSingboxConfigFile], {
    cwd: paths.root,
    errorCode: "singbox_start_failed",
    readyProbe: () => isTcpPortOpen("127.0.0.1", Number(localProxyPort)),
    readyTimeoutMs: 5000,
    readyIntervalMs: 100
  });
}

function isTcpPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const settle = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function buildSyncPreview(job) {
  await ensureSecretVaultReady();
  const normalized = await normalizeJob(job);
  return buildSyncPreviewFromNormalizedJob(normalized);
}

async function buildSyncPreviewFromNormalizedJob(normalized, options = {}) {
  if (!await fileExists(paths.rcloneExe)) {
    throw missingBinaryError("rclone", paths.rcloneExe, "missing_rclone_binary");
  }
  const rclone = buildRclonePreview(normalized, {
    localProxyHost: "127.0.0.1",
    localProxyPort: Number(normalized.localProxyPort || 18081),
    rcloneBin: paths.rcloneExe,
    rcloneConfigPath: paths.rcloneConfigFile,
    sftpTransport: normalized.storageBackend === "sftp" ? normalized.sftpTransport : undefined,
    bisyncWorkdir: normalized.direction === "bidirectional" ? getBisyncWorkdir(normalized.syncRelation) : "",
    backupDir: options.backupDir || "",
    recoveryPreflight: options.recoveryPreflight
  });
  const nextRun = computeNextRun(normalized.schedule || {}, new Date());
  return {
    rclone,
    schedule: {
      text: describeSchedule(normalized.schedule || {}),
      nextRun: nextRun instanceof Date ? nextRun.toISOString() : nextRun
    }
  };
}

function createSchedulerState(overrides = {}) {
  return {
    enabled: schedulerMs > 0,
    jobs: [],
    updatedAt: null,
    lastTriggeredAt: null,
    lastError: "",
    ...overrides
  };
}

async function refreshScheduler(options = {}) {
  const jobs = await readJobs(paths);
  const now = new Date();
  schedulerState = {
    ...schedulerState,
    enabled: schedulerMs > 0,
    jobs: jobs.map((job) => buildScheduledJob(job, now, options)).filter(Boolean),
    updatedAt: now.toISOString()
  };
  if (options.triggerStartup) {
    tickScheduler(now).catch(() => {});
  }
  return buildSchedulerStatus();
}

function buildScheduledJob(job, now = new Date(), options = {}) {
  const schedule = normalizeSchedule(job.schedule || { mode: "manual" });
  if (schedule.mode === "manual") {
    return null;
  }
  const existing = schedulerState.jobs.find((item) => item.id === job.id);
  const nextRun = options.triggerStartup && schedule.mode === "startup"
    ? "on-startup"
    : existing?.nextRun || serializeNextRun(computeNextRun(schedule, now));
  return {
    id: job.id,
    name: job.name || "folder-sync",
    job,
    schedule,
    scheduleText: describeSchedule(schedule),
    nextRun,
    lastTriggeredAt: existing?.lastTriggeredAt || null,
    lastError: existing?.lastError || ""
  };
}

async function tickScheduler(now = new Date()) {
  if (!schedulerState.enabled || syncProcess.isRunning() || syncRunPreparationCount > 0 || clientDataOperationInFlight) {
    return null;
  }
  const due = schedulerState.jobs
    .filter((item) => isScheduledJobDue(item, now))
    .sort((a, b) => scheduledTime(a.nextRun) - scheduledTime(b.nextRun))[0];
  if (!due) {
    return null;
  }

  due.lastTriggeredAt = now.toISOString();
  due.nextRun = due.schedule.mode === "startup" ? null : serializeNextRun(computeNextRun(due.schedule, now));
  schedulerState.lastTriggeredAt = due.lastTriggeredAt;
  schedulerState.updatedAt = now.toISOString();
  try {
    await runSync(due.job, { trigger: "scheduler" });
    due.lastError = "";
    schedulerState.lastError = "";
  } catch (error) {
    due.lastError = normalizeHttpError(error, "client_error").code;
    schedulerState.lastError = due.lastError;
  }
  return due;
}

function buildSchedulerStatus() {
  const jobs = schedulerState.jobs.map((item) => ({
    id: item.id,
    name: item.name,
    schedule: item.schedule,
    scheduleText: item.scheduleText,
    nextRun: item.nextRun,
    lastTriggeredAt: item.lastTriggeredAt,
    lastError: normalizeSchedulerErrorCode(item.lastError)
  }));
  return {
    enabled: schedulerState.enabled,
    intervalMs: schedulerMs,
    updatedAt: schedulerState.updatedAt,
    nextRun: jobs
      .map((job) => job.nextRun)
      .filter(Boolean)
      .sort((a, b) => scheduledTime(a) - scheduledTime(b))[0] || null,
    lastTriggeredAt: schedulerState.lastTriggeredAt,
    lastError: normalizeSchedulerErrorCode(schedulerState.lastError),
    jobs
  };
}

function normalizeSchedulerErrorCode(input) {
  const value = String(input || "").trim();
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) ? value : "";
}

function isScheduledJobDue(item, now = new Date()) {
  if (!item.nextRun) {
    return false;
  }
  if (item.nextRun === "on-startup") {
    return true;
  }
  const at = new Date(item.nextRun).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

function scheduledTime(value) {
  if (value === "on-startup") return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function serializeNextRun(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

async function runSync(job, options = {}) {
  if (clientDataOperationInFlight) throw syncAlreadyRunningError();
  if (connectionRepairInFlight || connectionRepairAdmissionInFlight) throw connectionRepairBusyError();
  const requestFingerprint = syncJobFingerprint(job);
  if (syncRunPreparationPromise) {
    if (syncRunPreparationFingerprint === requestFingerprint
      || equivalentSyncRunRequests(syncRunPreparationJob, job)) return await syncRunPreparationPromise;
    throw syncAlreadyRunningError();
  }
  if (syncProcess.isRunning() || syncRunInFlight) {
    if (activeSyncRequestFingerprint === requestFingerprint || equivalentSyncRunRequests(activeSyncRequestJob, job)) {
      return syncRunInFlight || syncProcess.status();
    }
    throw syncAlreadyRunningError();
  }
  syncRunPreparationCount += 1;
  syncRunPreparationFingerprint = requestFingerprint;
  syncRunPreparationJob = job;
  const preparation = runSyncAfterAdmission(job, options, requestFingerprint);
  syncRunPreparationPromise = preparation;
  try {
    return await preparation;
  } finally {
    syncRunPreparationCount = Math.max(0, syncRunPreparationCount - 1);
    if (syncRunPreparationPromise === preparation) {
      syncRunPreparationPromise = null;
      syncRunPreparationFingerprint = "";
      syncRunPreparationJob = null;
    }
  }
}

async function runSyncAfterAdmission(job, options, requestFingerprint) {
  try {
    await ensureLocalStateWritable();
    const runPlan = await buildSyncRunPlan(job);
    if (options.trigger !== "scheduler" && !(Number(options.automaticRetryAttempt || 0) > 0)
      && requiresSyncSafetyPlan(runPlan.normalizedJob)) {
      await requireSyncSafetyPlan({ job: runPlan.normalizedJob, safetyPlanId: options.safetyPlanId });
    }
    if ((options.trigger === "scheduler" || options.automaticRetryAttempt > 0) && requiresSyncSafetyPlan(runPlan.normalizedJob)) {
      const current = await createSyncSafetyPlan(runPlan.normalizedJob);
      if (!current.deletions.allowed || current.bidirectional.initializationRequired) {
        throw createHttpError("danger_confirmation_required", 400, "The current automatic sync safety plan requires review; no sync was started.");
      }
      await requireSyncSafetyPlan({ job: runPlan.normalizedJob, safetyPlanId: current.id });
    }
    const jobFingerprint = syncJobFingerprint(runPlan.normalizedJob);
    const stoppingReplay = currentStoppingSyncReplay();
    if (stoppingReplay) {
      if (stoppingReplay.jobFingerprint === jobFingerprint) return stoppingReplay.status;
      throw syncAlreadyRunningError();
    }
    syncRunInFlightJobFingerprint = jobFingerprint;
    activeSyncRequestFingerprint = requestFingerprint;
    activeSyncRequestJob = runPlan.normalizedJob;
    stoppingSyncReplay = null;
    syncRunInFlight = runSyncExclusive(runPlan, options);
    try {
      return await syncRunInFlight;
    } finally {
      syncRunInFlight = null;
      syncRunInFlightJobFingerprint = "";
    }
  } catch (error) {
    if (!syncProcess.isRunning()) {
      activeSyncRequestFingerprint = "";
      activeSyncRequestJob = null;
    }
    throw error;
  }
}

async function withClientDataOperation(task) {
  if (clientDataOperationInFlight || syncRunPreparationCount > 0 || syncRunInFlight || syncProcess.isRunning()
    || connectionRepairInFlight || connectionRepairAdmissionInFlight || dataSingboxProcess.isRunning()) {
    throw syncAlreadyRunningError();
  }
  clientDataOperationInFlight = true;
  syncRunPreparationCount += 1;
  try {
    return await task();
  } finally {
    syncRunPreparationCount = Math.max(0, syncRunPreparationCount - 1);
    clientDataOperationInFlight = false;
  }
}

const CONNECTION_REPAIR_JOURNAL_FILE = join(paths.runtimeRoot, "connection-repair-operations.json");

async function startConnectionRepairOperation(input = {}) {
  if (connectionRepairAdmissionInFlight) {
    await connectionRepairAdmissionPromise;
    return startConnectionRepairOperation(input);
  }
  connectionRepairAdmissionInFlight = true;
  let releaseAdmission;
  connectionRepairAdmissionPromise = new Promise((resolve) => { releaseAdmission = resolve; });
  try {
    const operation = normalizeConnectionRepairRequest(input);
    const requestHash = createHash("sha256").update(canonicalJson({
      relationId: operation.relationId,
      jobId: operation.jobId || ""
    })).digest("hex");
    const journal = await readConnectionRepairJournal();
    const saved = journal.operations[operation.operationId];
    if (saved) {
      if (saved.requestHash !== requestHash) {
        throw createHttpError("connection_repair_invalid", 400, "This operation ID is already bound to different repair inputs");
      }
      if (isConnectionRepairTerminal(saved.status) || connectionRepairInFlight) return saved;
      void launchConnectionRepair(saved);
      return saved;
    }
    const active = journal.activeOperationId ? journal.operations[journal.activeOperationId] : null;
    if (active?.status === "running" || connectionRepairInFlight || syncRunPreparationCount > 0
      || syncRunInFlight || syncProcess.isRunning() || dataSingboxProcess.isRunning()) {
      throw connectionRepairBusyError();
    }

    const now = new Date().toISOString();
    const next = {
      version: 1,
      operationId: operation.operationId,
      requestHash,
      relationId: operation.relationId,
      ...(operation.jobId ? { jobId: operation.jobId } : {}),
      status: "running",
      stage: "queued",
      startedAt: now,
      updatedAt: now,
      events: [{ stage: "queued", at: now }],
      checks: {
        components: "pending",
        localDirectory: operation.jobId ? "pending" : "not_checked",
        entryAndAuthorization: "pending",
        fileServiceAndRootMarker: "pending",
        directoryAccess: "pending",
        syncBaseline: operation.jobId ? "pending" : "not_checked"
      },
      localProbe: null,
      probe: null,
      result: null,
      errorCode: ""
    };
    connectionRepairInFlight = true;
    journal.activeOperationId = operation.operationId;
    journal.operations[operation.operationId] = next;
    try {
      await persistConnectionRepairJournal(journal);
    } catch (error) {
      connectionRepairInFlight = false;
      throw error;
    }
    void executeClaimedConnectionRepair(next).catch(() => {});
    return next;
  } finally {
    connectionRepairAdmissionInFlight = false;
    releaseAdmission();
  }
}

function normalizeConnectionRepairRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["operationId", "relationId", "jobId"].includes(key))) {
    throw createHttpError("connection_repair_invalid", 400, "Connection repair request is invalid");
  }
  const operationId = typeof input.operationId === "string" ? input.operationId.trim().toLowerCase() : "";
  const relationId = typeof input.relationId === "string" ? input.relationId.trim() : "";
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
    || !relationId || (input.jobId != null && !jobId)) {
    throw createHttpError("connection_repair_invalid", 400, "Connection repair request is invalid");
  }
  return { operationId, relationId, jobId };
}

async function getConnectionRepairOperation(operationId) {
  if (connectionRepairAdmissionInFlight) {
    await connectionRepairAdmissionPromise;
    return getConnectionRepairOperation(operationId);
  }
  connectionRepairAdmissionInFlight = true;
  let releaseAdmission;
  connectionRepairAdmissionPromise = new Promise((resolve) => { releaseAdmission = resolve; });
  try {
    const journal = await readConnectionRepairJournal();
    const operation = journal.operations[String(operationId).toLowerCase()];
    if (!operation) throw createHttpError("not_found", 404, "Connection repair operation was not found");
    if (!isConnectionRepairTerminal(operation.status) && !connectionRepairInFlight) {
      void launchConnectionRepair(operation);
    }
    return operation;
  } finally {
    connectionRepairAdmissionInFlight = false;
    releaseAdmission();
  }
}

async function resumeSavedConnectionRepair() {
  if (connectionRepairAdmissionInFlight) return;
  connectionRepairAdmissionInFlight = true;
  let releaseAdmission;
  connectionRepairAdmissionPromise = new Promise((resolve) => { releaseAdmission = resolve; });
  try {
    const journal = await readConnectionRepairJournal();
    const operation = journal.activeOperationId ? journal.operations[journal.activeOperationId] : null;
    if (operation?.status === "running" && !connectionRepairInFlight) {
      void launchConnectionRepair(operation);
    }
  } finally {
    connectionRepairAdmissionInFlight = false;
    releaseAdmission();
  }
}

function launchConnectionRepair(operation) {
  if (connectionRepairInFlight) return Promise.resolve(operation);
  if (syncRunPreparationCount > 0 || syncRunInFlight || syncProcess.isRunning() || dataSingboxProcess.isRunning()) {
    return Promise.resolve(operation);
  }
  connectionRepairInFlight = true;
  const task = executeClaimedConnectionRepair(operation);
  connectionRepairTask = task;
  return task;
}

async function executeClaimedConnectionRepair(initial) {
  let operation = initial;
  const save = async (changes) => {
    const updatedAt = new Date().toISOString();
    operation = {
      ...operation,
      ...changes,
      updatedAt,
      ...(changes.stage && changes.stage !== operation.stage
        ? { events: [...(operation.events || []), { stage: changes.stage, at: updatedAt }].slice(-32) }
        : {})
    };
    await persistConnectionRepairOperation(operation);
    return operation;
  };
  try {
    await ensureLocalStateWritable();
    await ensureSecretVaultReady();
    await ensureSyncRunBinaries();
    await save({ stage: "components_checked", checks: { ...operation.checks, components: "passed" } });

    const savedJob = operation.jobId
      ? (await readStoredJobs(paths)).find((item) => item.id === operation.jobId)
      : null;
    if (operation.jobId && !savedJob) throw createHttpError("connection_repair_invalid", 400, "The selected local task was not found");
    if (savedJob && (savedJob.storageBackend !== "sftp" || savedJob.relationId !== operation.relationId)) {
      throw createHttpError("enrollment_binding_mismatch", 403, "The selected task does not belong to this authorized directory");
    }

    const taskProjection = savedJob
      ? { id: savedJob.id, relationId: operation.relationId, direction: "bidirectional", localPath: savedJob.localPath }
      : { relationId: operation.relationId, direction: "bidirectional", localPath: "" };
    const payload = await refreshRelationDataAuthorization(operation.relationId);
    const normalizedJob = await normalizeSftpJobWithAuthorization(taskProjection, payload, {
      validateLocalPath: Boolean(savedJob)
    });
    if (operation.localProbe) {
      const contents = "syncraft-local-connection-probe-v1\n" + operation.operationId + "\n";
      const expectedPath = join(normalizedJob.localPath, ".syncraft-connection-probe-" + operation.operationId + ".tmp");
      const expectedHash = createHash("sha256").update(contents).digest("hex");
      if (operation.localProbe.operationId !== operation.operationId
        || operation.localProbe.path !== expectedPath
        || operation.localProbe.sha256 !== expectedHash) {
        throw createHttpError("connection_repair_probe_conflict", 409, "The saved local probe ownership proof does not match this task directory");
      }
    }
    const localDirectory = savedJob
      ? await probeLocalDirectory({
          localRoot: normalizedJob.localPath,
          probeId: operation.operationId,
          onProgress: async ({ stage, path, sha256 }) => {
            await save({ stage, localProbe: { path, sha256, operationId: operation.operationId } });
          }
        })
      : "not_checked";
    await save({
      stage: "entry_authorized",
      checks: { ...operation.checks, components: "passed", localDirectory, entryAndAuthorization: "passed" }
    });

    const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
    const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
      cwd: paths.root,
      env: preview.remoteConfig.env || preview.env,
      timeoutMs: 15000
    });
    if (!remoteConfig.ok) throw createHttpError("connection_repair_list_failed", 502, "Could not prepare the authorized directory connection");
    await protectRcloneConfigFile();

    await startDataSingbox(payload.sftpDataChannel.connection.uri, normalizedJob.localProxyPort);
    let markerStatus = "not_initialized";
    try {
      const initialized = Boolean(savedJob && await isBisyncInitialized(normalizedJob.syncRelation));
      if (initialized) {
        if (!normalizedJob.localPath) throw createHttpError("sync_relation_migration_required", 409, "The existing task directory is unavailable");
        await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
        markerStatus = "verified";
      }
      if (operation.probe) {
        const probeContents = `syncraft-connection-probe-v1\n${operation.operationId}\n`;
        const probeName = `.syncraft-connection-probe-${operation.operationId}.tmp`;
        const expectedPath = preview.remotePath.endsWith(":")
          ? `${preview.remotePath}/${probeName}`
          : `${preview.remotePath.replace(/\/+$/, "")}/${probeName}`;
        const expectedHash = createHash("sha256").update(probeContents).digest("hex");
        if (operation.probe.operationId !== operation.operationId
          || operation.probe.remotePath !== expectedPath
          || operation.probe.sha256 !== expectedHash) {
          throw createHttpError("connection_repair_probe_conflict", 409, "The saved probe ownership proof does not match this authorized directory");
        }
      }
      await save({
        stage: "root_binding_checked",
        checks: {
          ...operation.checks,
          components: "passed",
          localDirectory,
          entryAndAuthorization: "passed",
          fileServiceAndRootMarker: markerStatus,
          syncBaseline: savedJob ? (initialized ? "preserved" : "not_initialized") : "not_checked"
        }
      });

      const directoryAccess = await probeSftpDirectory({
        rcloneBin: paths.rcloneExe,
        rcloneConfigPath: paths.rcloneConfigFile,
        remoteRoot: preview.remotePath,
        env: preview.env,
        runtimeRoot: paths.runtimeRoot,
        runBuffered,
        probeId: operation.operationId,
        onProgress: async ({ stage, remotePath, sha256 }) => {
          await save({ stage, probe: { remotePath, sha256, operationId: operation.operationId } });
        }
      });
      await save({
        stage: "directory_access_checked",
        checks: {
          ...operation.checks,
          components: "passed",
          localDirectory,
          entryAndAuthorization: "passed",
          fileServiceAndRootMarker: markerStatus,
          directoryAccess,
          syncBaseline: savedJob ? (initialized ? "preserved" : "not_initialized") : "not_checked"
        }
      });
      operation = await save({
        status: "succeeded",
        stage: "complete",
        finishedAt: new Date().toISOString(),
        result: { directoryName: payload.displayName },
        errorCode: ""
      });
    } finally {
      if (dataSingboxProcess.isRunning()) await dataSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
    }
  } catch (error) {
    const errorCode = String(error?.code || "connection_repair_list_failed");
    const status = errorCode === "connection_repair_cleanup_failed"
      || errorCode === "connection_repair_probe_conflict"
      || errorCode === "sftp_access_marker_missing"
      || errorCode === "sftp_access_marker_conflict"
      ? "needs_attention"
      : "failed";
    operation = await save({ status, stage: "stopped", finishedAt: new Date().toISOString(), errorCode });
  } finally {
    connectionRepairInFlight = false;
    connectionRepairTask = null;
  }
  return operation;
}

async function persistConnectionRepairOperation(operation) {
  const journal = await readConnectionRepairJournal();
  await persistConnectionRepairJournal(upsertConnectionRepairOperation(journal, operation));
}

async function readConnectionRepairJournal() {
  const value = await readJsonFile(CONNECTION_REPAIR_JOURNAL_FILE, null);
  return normalizeConnectionRepairJournal(value);
}

async function persistConnectionRepairJournal(journal) {
  await writeProtectedJsonFile(CONNECTION_REPAIR_JOURNAL_FILE, journal);
}

function isConnectionRepairTerminal(status) {
  return ["succeeded", "failed", "needs_attention"].includes(status);
}

function connectionRepairBusyError() {
  return createHttpError("connection_repair_busy", 409, "Connection repair cannot run while a sync or another repair is active");
}

async function createSyncSafetyPlan(job = {}) {
  const runPlan = await buildSyncRunPlan(job);
  const { normalizedJob } = runPlan;
  const fingerprint = syncSafetyFingerprint(normalizedJob);
  const riskRequired = requiresSyncSafetyPlan(normalizedJob);
  const summary = {
    version: 1,
    jobFingerprint: fingerprint,
    direction: normalizedJob.direction,
    destructiveSync: Boolean(normalizedJob.destructiveSync),
    requiresExecutionPlan: riskRequired,
    recoveryRetentionDays: normalizedJob.safety.recoveryRetentionDays,
    deleteLimit: normalizedJob.safety.deleteLimit,
    bidirectional: { initialized: false, initializationRequired: false },
    source: { files: null },
    target: { files: null },
    deletions: { files: 0, percent: 0, allowed: true }
  };

  if (riskRequired) {
    await ensureSyncRunBinaries();
    const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
    const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
      cwd: paths.root,
      env: preview.remoteConfig.env || preview.env,
      timeoutMs: 15000
    });
    if (!remoteConfig.ok) {
      const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
      throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
    }
    await protectRcloneConfigFile();
    const [sourcePaths, targetPaths] = await withSyncTunnel(runPlan, async () => {
      if (runPlan.dataTunnel && await isBisyncInitialized(normalizedJob.syncRelation)) {
        await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
      }
      return Promise.all([
        listSyncFiles(preview, preview.args[1]),
        listSyncFiles(preview, preview.args[2])
      ]);
    });
    summary.source.files = sourcePaths.size;
    summary.target.files = targetPaths.size;
    if (normalizedJob.direction === "bidirectional" && await isBisyncInitialized(normalizedJob.syncRelation)) {
      const baseline = await inspectBisyncBaselineForSafety({
        workdir: getBisyncWorkdir(normalizedJob.syncRelation), job: normalizedJob, relation: normalizedJob.syncRelation
      });
      const possibleDeletes = new Set();
      for (const path of new Set([...baseline.previousLocal, ...baseline.previousRemote])) {
        const missingLocal = !sourcePaths.has(path);
        const missingRemote = !targetPaths.has(path);
        if (missingLocal || missingRemote) possibleDeletes.add(path);
      }
      const baselineCount = new Set([...baseline.previousLocal, ...baseline.previousRemote]).size;
      const percent = baselineCount === 0 ? 0 : Math.round((possibleDeletes.size / baselineCount) * 10000) / 100;
      summary.deletions = {
        files: possibleDeletes.size,
        percent,
        allowed: possibleDeletes.size <= normalizedJob.safety.deleteLimit.maxFiles
          && percent <= normalizedJob.safety.deleteLimit.maxPercent
      };
    } else if (normalizedJob.direction !== "bidirectional" && normalizedJob.destructiveSync) {
      const deleteCount = [...targetPaths].filter((path) => !sourcePaths.has(path)).length;
      const percent = targetPaths.size === 0 ? 0 : Math.round((deleteCount / targetPaths.size) * 10000) / 100;
      summary.deletions = {
        files: deleteCount,
        percent,
        allowed: deleteCount <= normalizedJob.safety.deleteLimit.maxFiles && percent <= normalizedJob.safety.deleteLimit.maxPercent
      };
    }
  }
  summary.bidirectional.initialized = normalizedJob.direction === "bidirectional"
    ? await isBisyncInitialized(normalizedJob.syncRelation)
    : false;
  summary.bidirectional.initializationRequired = normalizedJob.direction === "bidirectional" && !summary.bidirectional.initialized;

  const now = Date.now();
  const plan = {
    id: randomUUID(),
    fingerprint,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SYNC_SAFETY_PLAN_TTL_MS).toISOString(),
    consumed: false,
    summary
  };
  pruneSyncSafetyPlans(now);
  syncSafetyPlans.set(plan.id, plan);
  return { id: plan.id, createdAt: plan.createdAt, expiresAt: plan.expiresAt, ...summary };
}

async function listSyncFiles(preview, path) {
  const args = ["lsjson", path, "--recursive", "--files-only", "--config", paths.rcloneConfigFile];
  const result = await runBuffered(paths.rcloneExe, args, {
    cwd: paths.root,
    env: preview.env,
    timeoutMs: 30000
  });
  if (!result.ok) {
    throw createHttpError("rclone_sync_failed", 500, "Failed to enumerate files for the sync safety plan");
  }
  let rows;
  try {
    rows = JSON.parse(result.stdout || "[]");
  } catch {
    throw createHttpError("rclone_sync_failed", 500, "Sync safety plan returned an invalid file listing");
  }
  if (!Array.isArray(rows)) {
    throw createHttpError("rclone_sync_failed", 500, "Sync safety plan returned an invalid file listing");
  }
  return new Set(rows.map((row) => String(row?.Path || "").replace(/\\/g, "/").replace(/^\/+/, "")).filter(Boolean));
}

async function requireSyncSafetyPlan(body = {}) {
  if (process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS === "1") return;
  const runPlan = await buildSyncRunPlan(body.job || {});
  if (!requiresSyncSafetyPlan(runPlan.normalizedJob)) return;
  const planId = String(body.safetyPlanId || "").trim();
  const plan = syncSafetyPlans.get(planId);
  if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || plan.fingerprint !== syncSafetyFingerprint(runPlan.normalizedJob)) {
    throw createHttpError("danger_confirmation_required", 400, "Generate a current sync safety plan before running this job.");
  }
  if (!plan.summary.deletions.allowed || plan.summary.bidirectional.initializationRequired) {
    throw createHttpError("danger_confirmation_required", 400, "This sync safety plan requires changes before it can run.");
  }
  plan.consumed = true;
}

async function initializeBidirectionalSync(body = {}) {
  if (body.confirmBidirectionalInitialization !== true) {
    throw createHttpError("danger_confirmation_required", 400, "Confirm bidirectional initialization before running bisync resync.");
  }
  const runPlan = await buildSyncRunPlan(body.job || {});
  const normalizedJob = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  await migrateLegacyFirstBisyncConflictState(normalizedJob);
  if (normalizedJob.direction !== "bidirectional") {
    throw createHttpError("validation_failed", 400, "Bidirectional initialization requires direction bidirectional.");
  }
  const fingerprint = syncSafetyFingerprint(normalizedJob);
  const plan = syncSafetyPlans.get(String(body.safetyPlanId || "").trim());
  if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || plan.fingerprint !== fingerprint || !plan.summary.bidirectional.initializationRequired) {
    throw createHttpError("danger_confirmation_required", 400, "Generate a current bidirectional safety plan before initialization.");
  }
  const conflictOperationId = String(body.conflictOperationId || "").trim();
  if (!conflictOperationId) {
    throw createHttpError("first_sync_conflict_save_required", 409, "Preview and save the two sides of every first-sync conflict before initialization.");
  }
  await ensureSyncRunBinaries();
  const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root,
    env: preview.remoteConfig.env || preview.env,
    timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  const mode = normalizedJob.safety.bidirectional.initialMode || "newer";
  const rcloneMode = toRcloneBisyncResyncMode(mode);
  const relation = normalizedJob.syncRelation;
  assertSyncRelationReady(relation);
  const workdir = getBisyncWorkdir(relation);
  await mkdir(workdir, { recursive: true });
  await withSyncTunnel(runPlan, async () => {
    if (runPlan.dataTunnel) await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: true });
    const initArgs = [...preview.args, "--resync", "--resync-mode", rcloneMode];
    const dryRun = await runBuffered(paths.rcloneExe, [...initArgs, "--dry-run"], {
      cwd: paths.root,
      env: preview.env,
      timeoutMs: 60000
    });
    if (!dryRun.ok) {
      throw createHttpError("rclone_sync_failed", 500, "Bidirectional initialization dry run failed");
    }
    await verifyFirstBisyncConflictsSaved(firstBisyncConflictOptions(normalizedJob, preview.env, {
      operationId: conflictOperationId
    }));
    const initialized = await runBuffered(paths.rcloneExe, initArgs, {
      cwd: paths.root,
      env: preview.env,
      timeoutMs: 120000
    });
    if (!initialized.ok) {
      throw createHttpError("rclone_sync_failed", 500, "Bidirectional initialization failed");
    }
    await markBisyncInitialized(relation, { mode, workdir });
  });
  plan.consumed = true;
  return {
    initialized: true,
    mode,
    initializedAt: new Date().toISOString()
  };
}

async function createFirstBisyncConflictPreview(job = {}) {
  const runPlan = await buildSyncRunPlan(job);
  const normalizedJob = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  if (normalizedJob.direction !== "bidirectional") throw createHttpError("validation_failed", 400, "First-sync conflict preview requires bidirectional sync.");
  assertSyncRelationReady(normalizedJob.syncRelation);
  await migrateLegacyFirstBisyncConflictState(normalizedJob);
  if (await isBisyncInitialized(normalizedJob.syncRelation)) {
    throw createHttpError("first_sync_conflict_review_required", 409, "This relation is already initialized; first-sync conflict preservation is unavailable.");
  }
  await ensureSyncRunBinaries();
  const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root, env: preview.remoteConfig.env || preview.env, timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  return withSyncTunnel(runPlan, async () => {
    if (runPlan.dataTunnel) await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: true });
    return previewFirstBisyncConflicts({
      ...firstBisyncConflictOptions(normalizedJob, preview.env),
      baselineEntry: findBisyncStateEntry(await readBisyncState(), normalizedJob.syncRelation)
    });
  });
}

async function persistFirstBisyncConflictCopies(job = {}, previewId) {
  const runPlan = await buildSyncRunPlan(job);
  const normalizedJob = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  if (normalizedJob.direction !== "bidirectional") throw createHttpError("validation_failed", 400, "First-sync conflict saving requires bidirectional sync.");
  assertSyncRelationReady(normalizedJob.syncRelation);
  await migrateLegacyFirstBisyncConflictState(normalizedJob);
  if (await isBisyncInitialized(normalizedJob.syncRelation)) {
    throw createHttpError("first_sync_conflict_review_required", 409, "This relation is already initialized; saved conflict copies were not changed.");
  }
  await ensureSyncRunBinaries();
  const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root, env: preview.remoteConfig.env || preview.env, timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  return withSyncTunnel(runPlan, async () => {
    if (runPlan.dataTunnel) await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
    return saveFirstBisyncConflicts({ ...firstBisyncConflictOptions(normalizedJob, preview.env), previewId });
  });
}

async function readFirstBisyncConflictOperations(job = {}) {
  const runPlan = await buildSyncRunPlan(job);
  const normalizedJob = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  if (normalizedJob.direction !== "bidirectional") throw createHttpError("validation_failed", 400, "First-sync conflict operations require bidirectional sync.");
  assertSyncRelationReady(normalizedJob.syncRelation);
  if (await isBisyncInitialized(normalizedJob.syncRelation)) return [];
  await migrateLegacyFirstBisyncConflictState(normalizedJob);
  return listFirstBisyncConflictOperations(firstBisyncConflictOptions(normalizedJob, {}));
}

async function resumeFirstBisyncConflict(job = {}, operationId) {
  const runPlan = await buildSyncRunPlan(job);
  const normalizedJob = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  if (normalizedJob.direction !== "bidirectional") throw createHttpError("validation_failed", 400, "First-sync conflict saving requires bidirectional sync.");
  assertSyncRelationReady(normalizedJob.syncRelation);
  if (await isBisyncInitialized(normalizedJob.syncRelation)) {
    throw createHttpError("first_sync_conflict_review_required", 409, "This relation is already initialized; saved conflict copies were not changed.");
  }
  await migrateLegacyFirstBisyncConflictState(normalizedJob);
  await ensureSyncRunBinaries();
  const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob)).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root, env: preview.remoteConfig.env || preview.env, timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  return withSyncTunnel(runPlan, async () => {
    if (runPlan.dataTunnel) await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
    return resumeFirstBisyncConflictSave({ ...firstBisyncConflictOptions(normalizedJob, preview.env), operationId });
  });
}

async function migrateLegacyFirstBisyncConflictState(job) {
  const relation = job.syncRelation;
  const derived = getFirstBisyncConflictPathsForRelation(relation, paths);
  if (await fileExists(derived.stateFile) || !await fileExists(paths.firstBisyncConflictFile)) return derived;
  const legacy = await readJsonFile(paths.firstBisyncConflictFile, null);
  const owner = `${relation.relationId}:${relation.baselineId}:${relation.rootId}`;
  if (legacy?.type === "sync-first-bisync-conflicts" && legacy.version === 1 && legacy.owner === owner
    && legacy.relationId === relation.relationId && legacy.baselineId === relation.baselineId && legacy.rootId === relation.rootId
    && Array.isArray(legacy.operations)) {
    await writeProtectedJsonFile(derived.stateFile, legacy);
  }
  return derived;
}

async function prepareSyncRecoveryContext(jobId) {
  if (syncProcess.isRunning() || syncRunInFlight) throw syncAlreadyRunningError();
  await ensureSecretVaultReady();
  const savedJobs = await readStoredJobs(paths);
  const saved = savedJobs.find((job) => String(job.id) === String(jobId));
  if (!saved) throw createHttpError("not_found", 404, "Sync job was not found");
  const runPlan = await buildSyncRunPlan(saved);
  const job = withTrustedBisyncRuntimeWorkdir(runPlan.normalizedJob);
  if (job.direction !== "bidirectional") throw createHttpError("validation_failed", 400, "Recovery versions are available for bidirectional sync jobs only");
  assertSyncRelationReady(job.syncRelation);
  await ensureSyncRunBinaries();
  const preview = (await buildSyncPreviewFromNormalizedJob(job)).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root, env: preview.remoteConfig.env || preview.env, timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, job, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  const recoveryPaths = await resolveSyncRecoveryPaths(job);
  return { job, runPlan, preview, recoveryPaths };
}

async function resolveSyncRecoveryPaths(job) {
  const recoveryPaths = getSyncRecoveryPathsForRelation(job.syncRelation, paths);
  if (await fileExists(recoveryPaths.stateFile)) return recoveryPaths;
  const legacy = await readJsonFile(paths.syncRecoveryStateFile, null);
  const legacyOwner = `${job.syncRelation.relationId}:${job.syncRelation.baselineId}:${job.syncRelation.rootId}`;
  if (legacy && legacy.type === "sync-recovery-owner" && legacy.version === 1
    && legacy.ownerRecordId === legacyOwner
    && legacy.relationId === job.syncRelation.relationId
    && legacy.baselineId === job.syncRelation.baselineId
    && legacy.rootId === job.syncRelation.rootId) {
    try {
      verifySyncRecoveryManifestOwnership(legacy, job.syncRelation);
      await writeProtectedJsonFile(recoveryPaths.stateFile, legacy);
    } catch {}
  }
  return recoveryPaths;
}

async function closeInterruptedRecoveryRuns(job, recoveryPaths = getSyncRecoveryPathsForRelation(job.syncRelation, paths)) {
  const manifest = await readJsonFile(recoveryPaths.stateFile, null);
  if (!manifest || !Array.isArray(manifest.runs)) return;
  for (const run of manifest.runs) {
    if (run.status === "running") {
      await completeSyncRecoveryRun({
        job,
        relation: job.syncRelation,
        recoveryStateFile: recoveryPaths.stateFile,
        readProtected: (file, fallback) => readJsonFile(file, fallback),
        writeProtected: writeProtectedJsonFile,
        runId: run.runId,
        succeeded: false
      });
    }
  }
}

function recoveryOptions(context) {
  return {
    job: context.job,
    relation: context.job.syncRelation,
    recoveryStateFile: context.recoveryPaths.stateFile,
    stagingRoot: context.recoveryPaths.stagingRoot,
    readProtected: (file, fallback) => readJsonFile(file, fallback),
    writeProtected: writeProtectedJsonFile,
    protectStagingFile: protectLocalSecretFile,
    runBuffered,
    rcloneExe: paths.rcloneExe,
    rcloneConfigFile: paths.rcloneConfigFile,
    env: context.preview.env,
    cwd: paths.root
  };
}

async function withRecoveryContext(context, task) {
  const options = recoveryOptions(context);
  return withSyncTunnel(context.runPlan, async () => {
    if (context.runPlan.dataTunnel) await verifySftpAccessMarkers(context.preview, context.job, { createMissing: false });
    await closeInterruptedRecoveryRuns(context.job, context.recoveryPaths);
    return task(options);
  });
}

async function listRecoveryVersionsForContext(context) {
  const options = recoveryOptions(context);
  const listVersions = () => listSyncRecoveryVersions(options);
  if (!context.runPlan.dataTunnel || await isBisyncInitialized(context.job.syncRelation)) {
    return withRecoveryContext(context, listVersions);
  }

  // A missing marker is expected before first initialization only when both
  // recovery namespaces and the protected owner manifest are absent. This path
  // remains read-only; every non-pristine relation follows the strict marker gate.
  const pristineListing = await withSyncTunnel(context.runPlan, async () => {
    if (!await isSyncRecoveryPristine(options)) return null;
    const versions = await listVersions();
    if (versions.length === 0 && await isSyncRecoveryPristine(options)) return versions;
    return null;
  });
  if (pristineListing) return pristineListing;
  return withRecoveryContext(context, listVersions);
}

function firstBisyncConflictOptions(job, env, extra = {}) {
  const conflictPaths = getFirstBisyncConflictPathsForRelation(job.syncRelation, paths);
  return {
    job,
    relation: job.syncRelation,
    conflictStateFile: conflictPaths.stateFile,
    stagingRoot: conflictPaths.stagingRoot,
    readProtected: file => readJsonFile(file, null),
    writeProtected: writeProtectedJsonFile,
    protectStagingFile: protectLocalSecretFile,
    runBuffered,
    rcloneExe: paths.rcloneExe,
    rcloneConfigFile: paths.rcloneConfigFile,
    env: env || {},
    cwd: paths.root,
    ...extra
  };
}

async function isBisyncInitialized(relation) {
  if (!relation) {
    return false;
  }
  const state = await readBisyncState();
  if (findBisyncStateEntry(state, relation)) {
    return true;
  }
  const legacyFingerprint = relation.migration?.legacyFingerprint;
  return Boolean(legacyFingerprint
    && state?.[legacyFingerprint]?.initializedAt
    && relation.migration?.state === "legacy_compatible");
}

async function markBisyncInitialized(relation, details) {
  const state = await readBisyncState();
  await writeJsonFile(paths.bisyncStateFile, markBisyncInitializedState(state, relation, details));
}

function getBisyncWorkdir(relation) {
  if (relation?.migration?.state === "legacy_compatible" && relation?.rclone?.workdir) {
    // resolveLegacyBisyncCompatibility has already matched this exact path to
    // the legacy fingerprint and verified the directory exists.
    return relation.rclone.workdir;
  }
  const id = syncRelationRuntimeId(relation);
  if (!id) throw createHttpError("sync_recovery_trusted_relation_required", 409, "A trusted relation is required for bisync runtime state.");
  // Runtime state is always rooted under the application data directory. A saved
  // job or HTTP request must not be able to redirect rclone's bisync workdir.
  return join(paths.runtimeRoot, "bisync", id);
}

function withTrustedBisyncRuntimeWorkdir(job) {
  const relation = job?.syncRelation;
  if (!relation || relation.direction !== "bidirectional") return job;
  const workdir = getBisyncWorkdir(relation);
  return {
    ...job,
    syncRelation: {
      ...relation,
      rclone: { ...relation.rclone, workdir }
    }
  };
}

async function readBisyncState() {
  const state = await readJsonFile(paths.bisyncStateFile, {});
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

async function readBisyncRuntimeDirectoryIds() {
  try {
    const entries = await readdir(join(paths.runtimeRoot, "bisync"), { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

function getSyncRecoveryPaths(job = {}) {
  if (!job.destructiveSync || job.direction === "bidirectional") {
    return null;
  }
  const id = createHash("sha256").update(syncJobFingerprint(job)).digest("hex").slice(0, 24);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (job.direction === "download") {
    const root = join(paths.dataRoot, "recovery", id);
    return { root, current: join(root, stamp), local: true };
  }
  const root = `${job.remoteName}:${job.bucketName}/.sfsc-recovery/${job.clientName}/${id}`;
  return { root, current: `${root}/${stamp}`, local: false };
}

async function pruneSyncRecovery(preview, recovery, retentionDays) {
  const result = await runBuffered(paths.rcloneExe, [
    "delete",
    recovery.root,
    "--min-age",
    `${retentionDays}d`,
    "--config",
    paths.rcloneConfigFile
  ], {
    cwd: paths.root,
    env: preview.env,
    timeoutMs: 30000
  });
  if (!result.ok) {
    await writeFile(paths.rcloneLog, `${redactLogText(result.stderr || result.error || "recovery cleanup failed")}\n`, { flag: "a" }).catch(() => {});
  }
}

function requiresSyncSafetyPlan(job = {}) {
  return job.direction === "bidirectional" || Boolean(job.destructiveSync);
}

function isTransientTunnelDisconnect(logText) {
  return /(?:connection\s+reset|connection\s+refused|connection\s+timed\s+out|network\s+is\s+unreachable|no\s+route\s+to\s+host|i\/o\s+timeout|tls\s+handshake\s+timeout|unexpected\s+eof|proxyconnect\s+tcp|dial\s+tcp|read\s+tcp|write\s+tcp|temporary\s+failure\s+in\s+name\s+resolution|lookup\s+.+no\s+such\s+host)/i.test(String(logText || ""));
}

function isNonRetryableDataRootFailure(logText) {
  return /(?:sftp_access_marker|directory[_ -]root|permission\s+denied|access\s+denied|authentication\s+failed|host\s+key\s+verification\s+failed|no\s+such\s+file\s+or\s+directory|not\s+authorized|revoked|marker\s+(?:missing|mismatch)|root\s+(?:missing|changed|replaced))/i.test(String(logText || ""));
}

function setScheduledJobFailure(job, options, errorCode) {
  if (options.trigger !== "scheduler") return;
  const code = normalizeSchedulerErrorCode(errorCode) || "rclone_sync_failed";
  schedulerState.lastError = code;
  const scheduled = schedulerState.jobs.find((item) => item.id === job.id);
  if (scheduled) scheduled.lastError = code;
}

function clearScheduledJobFailure(job, options) {
  if (options.trigger !== "scheduler") return;
  schedulerState.lastError = "";
  const scheduled = schedulerState.jobs.find((item) => item.id === job.id);
  if (scheduled) scheduled.lastError = "";
}

async function requireManualScheduleForRiskySync(job = {}) {
  if (process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS === "1") return;
  const direction = job.direction || "upload";
  const risky = direction === "bidirectional" || Boolean(job.destructiveSync);
  const scheduleMode = job.schedule?.mode || "manual";
  if (risky && scheduleMode !== "manual") {
    const authorizedInitializedSftpBisync = job.storageBackend === "sftp"
      && direction === "bidirectional"
      && Boolean(job.syncRelation)
      && await isBisyncInitialized(job.syncRelation);
    if (authorizedInitializedSftpBisync) return;
    throw createHttpError("validation_failed", 400, "Scheduled bidirectional sync requires a verified initialized SFTP baseline; other risky sync jobs must use a manual schedule.");
  }
}

function pruneSyncSafetyPlans(now = Date.now()) {
  for (const [id, plan] of syncSafetyPlans) {
    if (plan.consumed || Date.parse(plan.expiresAt) <= now) syncSafetyPlans.delete(id);
  }
  while (syncSafetyPlans.size >= SYNC_SAFETY_PLAN_LIMIT) {
    const oldest = syncSafetyPlans.keys().next().value;
    if (!oldest) break;
    syncSafetyPlans.delete(oldest);
  }
}

async function runSyncExclusive(runPlan, options = {}) {
  const { normalizedJob, tunnelUri, dataTunnel = false } = runPlan;
  await ensureLocalStateWritable();
  await ensureSecretVaultReady();
  await ensureSyncRunBinaries();
  if (syncProcess.isRunning()) {
    return syncProcess.status();
  }

  if (normalizedJob.direction === "bidirectional") {
    assertSyncRelationReady(normalizedJob.syncRelation);
    await mkdir(getBisyncWorkdir(normalizedJob.syncRelation), { recursive: true });
  }
  const legacyCompatibleBisync = normalizedJob.direction === "bidirectional"
    && normalizedJob.storageBackend !== "sftp"
    && normalizedJob.syncRelation?.migration?.state === "legacy_compatible";
  const recoveryPaths = normalizedJob.direction === "bidirectional" && !legacyCompatibleBisync
    ? await resolveSyncRecoveryPaths(normalizedJob)
    : null;

  const singleDirectionRecovery = getSyncRecoveryPaths(normalizedJob);
  if (singleDirectionRecovery?.local) await mkdir(singleDirectionRecovery.current, { recursive: true });
  let recoveryRun = null;
  let preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob, {
    backupDir: singleDirectionRecovery?.current || ""
  })).rclone;
  const remoteConfig = await runBuffered(paths.rcloneExe, preview.remoteConfig.args, {
    cwd: paths.root,
    env: preview.remoteConfig.env || preview.env,
    timeoutMs: 15000
  });
  if (!remoteConfig.ok) {
    const detail = redactRcloneConfigFailureDetail(remoteConfig, normalizedJob, preview);
    throw createHttpError("rclone_config_failed", 500, `Failed to write rclone remote config: ${detail}`);
  }
  await protectRcloneConfigFile();
  if (dataTunnel) {
    await startDataSingbox(tunnelUri, normalizedJob.localProxyPort || SFTP_DATA_SOCKS_PORT);
    try {
      await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
    } catch (error) {
      if (dataSingboxProcess.isRunning()) await dataSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
      throw error;
    }
  } else if (!singboxProcess.isRunning()) {
    await startSingbox({ uri: tunnelUri, localProxyPort: normalizedJob.localProxyPort || 18081 });
  }
  try {
    if (normalizedJob.direction === "bidirectional" && !legacyCompatibleBisync) {
      await closeInterruptedRecoveryRuns(normalizedJob, recoveryPaths);
      const preflight = await (async () => {
        if (dataTunnel) await verifySftpAccessMarkers(preview, normalizedJob, { createMissing: false });
        return prepareSyncRecovery({
          ...recoveryOptions({ job: normalizedJob, runPlan, preview, recoveryPaths }),
          baselineEntry: findBisyncStateEntry(await readBisyncState(), normalizedJob.syncRelation)
        });
      })();
      recoveryRun = preflight.recoveryPreflight;
      const baselineEntry = findBisyncStateEntry(await readBisyncState(), normalizedJob.syncRelation);
      await (async () => verifySyncRecoveryPreflight({
        ...recoveryOptions({ job: normalizedJob, runPlan, preview, recoveryPaths }), baselineEntry, receipt: recoveryRun
      }))();
      preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob, { recoveryPreflight: recoveryRun })).rclone;
    }
    if (recoveryRun) {
      await markSyncRecoveryRunStarted({
        job: normalizedJob, relation: normalizedJob.syncRelation, recoveryStateFile: recoveryPaths.stateFile,
        readProtected: (file, fallback) => readJsonFile(file, fallback), writeProtected: writeProtectedJsonFile,
        runId: recoveryRun.runId
      });
    }
    return await syncProcess.start(paths.rcloneExe, preview.args, {
      cwd: paths.root,
      env: preview.env,
      // Test-only fault injection avoids relying on a platform-specific rename
      // of an executable that is still open by the config subprocess.
      testSpawnFailure: process.env.SFSC_TEST_RCLONE_SYNC_SPAWN_FAILURE === "1",
      errorCode: "rclone_sync_failed",
      onStarted: async () => {
        const run = createSyncRunStart(normalizedJob, options);
        markSyncStarting(normalizedJob, run);
        await recordSyncRunStarted(run, paths);
      },
      onOutput: updateSyncMetricsFromOutput,
      onExit: async (exit) => {
        const userRequestedStop = syncMetrics.syncState === "stopping";
        const retryAttempt = Number(options.automaticRetryAttempt || 0);
        const ownTunnelExited = dataTunnel && !dataSingboxProcess.isRunning();
        const recentFailureLog = !exit.ok && !userRequestedStop && dataTunnel
          && retryAttempt < 3 ? await readRecentLog(paths.rcloneLog, 8000).catch(() => "") : "";
        const retryTransientDisconnect = isTransientTunnelDisconnect(recentFailureLog);
        const retryOwnTunnelExit = !exit.ok && !userRequestedStop && dataTunnel && ownTunnelExited && retryAttempt < 3;
        const retryTunnelFailure = !isNonRetryableDataRootFailure(recentFailureLog)
          && (retryOwnTunnelExit || (!exit.ok && !userRequestedStop && dataTunnel
            && options.trigger === "scheduler" && retryTransientDisconnect && retryAttempt < 3));
        let settledExit = exit;
        try {
          if (recoveryRun) {
            await completeSyncRecoveryRun({
              job: normalizedJob, relation: normalizedJob.syncRelation, recoveryStateFile: recoveryPaths.stateFile,
              readProtected: (file, fallback) => readJsonFile(file, fallback), writeProtected: writeProtectedJsonFile,
              runId: recoveryRun.runId, succeeded: exit.ok !== false
            });
          }
        } catch (error) {
          settledExit = { ...exit, ok: false, errorCode: error.code || "sync_recovery_preflight_failed", error: error.message };
        } finally {
          await markSyncExited(settledExit);
          if (dataTunnel && dataSingboxProcess.isRunning()) {
            await dataSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
          }
        }
        if (settledExit.ok && singleDirectionRecovery) {
          pruneSyncRecovery(preview, singleDirectionRecovery, normalizedJob.safety.recoveryRetentionDays).catch(() => {});
        }
        if (settledExit.ok) clearScheduledJobFailure(normalizedJob, options);
        if (retryTunnelFailure) {
          const attempt = retryAttempt + 1;
          setTimeout(() => {
            runSync(normalizedJob, { ...options, automaticRetryAttempt: attempt }).catch((error) => {
              const errorCode = normalizeHttpError(error, "client_error").code;
              syncMetrics = { ...syncMetrics, lastRun: { ...(syncMetrics.lastRun || {}), errorCode } };
              setScheduledJobFailure(normalizedJob, options, errorCode);
              sendHeartbeat().catch(() => {});
            });
          }, 250);
        } else if (!settledExit.ok && options.trigger === "scheduler") {
          setScheduledJobFailure(normalizedJob, options, settledExit.errorCode || syncMetrics.lastRun?.errorCode || "rclone_sync_failed");
        }
      }
    });
  } catch (error) {
    if (recoveryRun) {
      await completeSyncRecoveryRun({
        job: normalizedJob, relation: normalizedJob.syncRelation, recoveryStateFile: recoveryPaths.stateFile,
        readProtected: (file, fallback) => readJsonFile(file, fallback), writeProtected: writeProtectedJsonFile,
        runId: recoveryRun.runId, succeeded: false
      }).catch(() => {});
    }
    if (dataTunnel && dataSingboxProcess.isRunning()) {
      await dataSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
    }
    throw createHttpError("rclone_sync_failed", 500, `Failed to start rclone sync: ${error.message}`);
  }
}

async function ensureSyncRunBinaries() {
  if (!await fileExists(paths.rcloneExe)) {
    throw missingBinaryError("rclone", paths.rcloneExe, "missing_rclone_binary");
  }
  if (!await fileExists(paths.singboxExe)) {
    throw missingBinaryError("sing-box", paths.singboxExe, "missing_singbox_binary");
  }
}

function redactRcloneConfigFailureDetail(result = {}, job = {}, preview = {}) {
  const detail = [
    result.stderr,
    result.stdout,
    result.error
  ].filter(Boolean).join("\n") || "unknown error";
  return redactKnownSecretValues(redactLogText(detail), collectRcloneConfigSecrets(job, preview));
}

// rclone writes the remote's access key into rclone.conf in cleartext, so the
// file is locked down to the current account right after every config create.
async function protectRcloneConfigFile() {
  try {
    await protectLocalSecretFile(paths.rcloneConfigFile);
  } catch {
    // Never let ACL hardening abort a sync; the vault inspection surfaces state.
  }
}

function collectRcloneConfigSecrets(job = {}, preview = {}) {
  const values = [
    job.secretAccessKey,
    job.s3SecretAccessKey
  ];
  // Prefer env-injected secrets (current path). Fall back to legacy argv
  // layout so older previews / diagnostics still redact correctly.
  for (const env of [preview?.remoteConfig?.env, preview?.env]) {
    if (!env || typeof env !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(env)) {
      if (/SECRET_ACCESS_KEY$/i.test(key) || /SECRET|PASSWORD|TOKEN/i.test(key)) {
        values.push(value);
      }
    }
  }
  const args = Array.isArray(preview?.remoteConfig?.args) ? preview.remoteConfig.args : [];
  const secretIndex = args.indexOf("secret_access_key");
  if (secretIndex >= 0 && secretIndex + 1 < args.length) {
    values.push(args[secretIndex + 1]);
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function redactKnownSecretValues(text, values = []) {
  let redacted = String(text || "");
  for (const value of values) {
    redacted = redacted.split(value).join("****");
  }
  return redacted;
}

function createSyncMetrics(overrides = {}) {
  return {
    syncState: "idle",
    phase: "idle",
    bytesPerSecond: 0,
    speedMbps: 0,
    rawSpeed: "",
    progressPercent: null,
    transferredText: "",
    transferredSizeText: "",
    transferredBytes: null,
    totalBytes: null,
    transferredObjects: null,
    totalObjects: null,
    currentFile: "",
    currentFileProgressPercent: null,
    currentFileSizeText: "",
    eta: "",
    errorCode: "",
    error: "",
    conflicts: {
      count: 0,
      files: [],
      truncated: false
    },
    currentJob: null,
    startedAt: null,
    lastSyncAt: null,
    finishedAt: null,
    lastExit: null,
    historyRunId: null,
    lastRun: null,
    ...overrides
  };
}

function markSyncStarting(job, run = {}) {
  const now = run.startedAt || new Date().toISOString();
  activeSyncJobFingerprint = syncJobFingerprint(job);
  stoppingSyncReplay = null;
  syncOutputContexts = {
    stdout: "",
    stderr: ""
  };
  syncMetrics = createSyncMetrics({
    syncState: "syncing",
    phase: "scanning",
    currentJob: summarizeHeartbeatJob(job),
    historyRunId: run.id || null,
    lastRun: run || null,
    startedAt: now,
    lastSyncAt: now
  });
}

async function stopSync() {
  const status = syncProcess.status();
  if (!status.running) {
    stoppingSyncReplay = null;
    return {
      ...status,
      stopSignal: null,
      stopTimedOut: false
    };
  }
  markSyncStopping();
  if (activeSyncJobFingerprint) {
    stoppingSyncReplay = {
      jobFingerprint: activeSyncJobFingerprint,
      status,
      expiresAt: Date.now() + STOPPING_SYNC_REPLAY_MS
    };
  }
  const stopped = await syncProcess.stopAndWait({ timeoutMs: 2500 });
  if (!stopped.running) {
    stoppingSyncReplay = null;
  }
  return stopped;
}

function markSyncStopping() {
  if (syncProcess.isRunning()) {
    syncMetrics = {
      ...syncMetrics,
      syncState: "stopping",
      bytesPerSecond: 0,
      speedMbps: 0
    };
  }
}

function currentStoppingSyncReplay(now = Date.now()) {
  if (!stoppingSyncReplay) {
    return null;
  }
  if (stoppingSyncReplay.expiresAt <= now) {
    stoppingSyncReplay = null;
    return null;
  }
  return stoppingSyncReplay;
}

function updateSyncMetricsFromOutput(output = {}) {
  const stream = output.stream === "stderr" ? "stderr" : "stdout";
  // stdout and stderr are independent byte streams. Joining their chunks into
  // one buffer can splice a stderr diagnostic into the middle of a stdout
  // line when writes are split across pipes, destroying a real bisync conflict
  // record before rcloneStats gets to parse it. Keep a bounded context per
  // stream and combine parsed metrics only after each stream is decoded.
  syncOutputContexts[stream] = appendRcloneOutputContext(syncOutputContexts[stream], output.text);
  const outputStats = parseRcloneStats(syncOutputContexts[stream], {
    direction: syncMetrics.currentJob?.direction
  });
  const failure = parseRcloneFailure(syncOutputContexts[stream]);
  const parsed = outputStats || failure
    ? {
        ...(outputStats || {}),
        ...(failure || {}),
        updatedAt: outputStats?.updatedAt || new Date().toISOString()
      }
    : null;
  if (!parsed) {
    return;
  }
  const progress = mergeRcloneProgress(syncMetrics, parsed);

  syncMetrics = {
    ...syncMetrics,
    ...progress,
    syncState: syncMetrics.syncState === "stopping" ? "stopping" : "syncing",
    conflicts: mergeRcloneConflictSummary(syncMetrics.conflicts, parsed.conflicts),
    lastSyncAt: parsed.updatedAt
  };
}

function markSyncExited(exit = {}) {
  const ok = exit.ok !== false;
  const previousState = syncMetrics.syncState;
  const finishedAt = exit.at || new Date().toISOString();
  const status = previousState === "stopping" ? "stopped" : ok ? "success" : "error";
  const historyRunId = syncMetrics.historyRunId;
  const finishPatch = buildSyncRunFinishPatch(status, exit, finishedAt, syncMetrics);
  syncMetrics = {
    ...syncMetrics,
    syncState: status === "error" ? "error" : "idle",
    phase: status === "success" ? "completed" : status,
    bytesPerSecond: 0,
    speedMbps: 0,
    finishedAt,
    lastExit: finishPatch.lastExit,
    lastRun: {
      ...(syncMetrics.lastRun || {}),
      ...finishPatch
    }
  };
  syncOutputContexts = {
    stdout: "",
    stderr: ""
  };
  activeSyncJobFingerprint = "";
  activeSyncRequestFingerprint = "";
  activeSyncRequestJob = null;
  if (historyRunId) {
    return recordSyncRunFinished(historyRunId, finishPatch, paths)
      .then((run) => {
        syncMetrics = {
          ...syncMetrics,
          lastRun: run
        };
      })
      .catch(() => {})
      .finally(() => {
        sendHeartbeat().catch(() => {});
      });
  } else {
    sendHeartbeat().catch(() => {});
  }
  return undefined;
}

function syncAlreadyRunningError() {
  return createHttpError(
    "sync_already_running",
    409,
    "A sync is already running for a different job"
  );
}

function syncJobFingerprint(job = {}) {
  const fingerprint = {};
  for (const field of [
    "localPath",
    "direction",
    "remoteFolder",
    "serverSpace",
    "clientName",
    "remoteName",
    "bucketName",
    "remotePrefix",
    "s3Endpoint",
    "localProxyPort",
    "transfers",
    "streams",
    "checkers",
    "s3UploadConcurrency",
    "s3ChunkSize",
    "chunkSize",
    "cutoff",
    "retries",
    "lowLevelRetries",
    "exclude",
    "dryRun",
    "destructiveSync",
    "bandwidthLimit",
    "safety"
  ]) {
    fingerprint[field] = job[field] ?? null;
  }
  fingerprint.syncRelation = summarizeSyncRelation(job.syncRelation);
  return JSON.stringify(fingerprint);
}

function syncSafetyFingerprint(job = {}) {
  if (job.storageBackend !== "sftp") return syncJobFingerprint(job);
  // The local SOCKS listener is allocated per trusted run operation. It does
  // not change the relation, remote target, or deletion set being confirmed.
  return syncJobFingerprint({ ...job, localProxyPort: null });
}

function equivalentSyncRunRequests(left = {}, right = {}) {
  for (const field of ["localPath", "direction", "remoteFolder"]) {
    if (!left[field] || !right[field] || String(left[field]) !== String(right[field])) return false;
  }
  if ((left.relationId || right.relationId)
    && String(left.relationId || "") !== String(right.relationId || "")) return false;
  for (const field of ["rootPath", "storageBackend"]) {
    if (left[field] !== undefined && right[field] !== undefined
      && String(left[field] || "") !== String(right[field] || "")) return false;
  }
  const optionalFields = [
    "serverSpace", "clientName", "remoteName", "bucketName", "remotePrefix", "s3Endpoint",
    "localProxyPort", "transfers", "streams", "checkers", "s3UploadConcurrency", "s3ChunkSize",
    "chunkSize", "cutoff", "retries", "lowLevelRetries", "exclude", "dryRun", "destructiveSync",
    "bandwidthLimit", "safety"
  ];
  for (const field of optionalFields) {
    if (left[field] !== undefined && right[field] !== undefined
      && JSON.stringify(left[field]) !== JSON.stringify(right[field])) return false;
  }
  const leftRelation = summarizeSyncRelation(left.syncRelation);
  const rightRelation = summarizeSyncRelation(right.syncRelation);
  if (Boolean(leftRelation) !== Boolean(rightRelation)) return false;
  return !leftRelation || JSON.stringify(leftRelation) === JSON.stringify(rightRelation);
}

function currentSyncProcessStatus() {
  const replay = currentStoppingSyncReplay();
  if (replay && !syncProcess.isRunning()) {
    return replay.status;
  }
  return syncProcess.status();
}

function currentSyncMetrics() {
  const replay = currentStoppingSyncReplay();
  const running = syncProcess.isRunning() || Boolean(replay);
  const state = running
    ? syncMetrics.syncState === "stopping" || replay ? "stopping" : "syncing"
    : syncMetrics.syncState === "error"
      ? "error"
      : syncMetrics.syncState === "stopping"
        ? "stopping"
        : "idle";
  return {
    ...syncMetrics,
    syncState: state,
    bytesPerSecond: running ? syncMetrics.bytesPerSecond : 0,
    speedMbps: running ? syncMetrics.speedMbps : 0
  };
}

function buildHeartbeatSyncV1(sync = {}, scheduler = null, lastRun = null) {
  const heartbeatSync = { ...sync };
  delete heartbeatSync.phase;
  return {
    ...heartbeatSync,
    scheduler,
    lastRun
  };
}

function sendHeartbeat() {
  // A periodic tick, import reset, and sync completion can coincide. Do not
  // let them create overlapping requests whose response order is unrelated to
  // request order; one in-flight heartbeat is sufficient to report current
  // client state and keeps the successful snapshot deterministic.
  if (heartbeatInFlight) {
    return heartbeatInFlight;
  }
  heartbeatInFlight = sendHeartbeatOnce().finally(() => {
    heartbeatInFlight = null;
  });
  return heartbeatInFlight;
}

async function sendHeartbeatOnce() {
  const generation = heartbeatGeneration;
  const profile = await readProfile(paths);
  const serverUrl = profile?.source?.server;
  const heartbeatSecret = typeof profile?.heartbeat?.secret === "string" ? profile.heartbeat.secret.trim() : "";
  if (!profile?.clientName || !serverUrl || !heartbeatSecret || typeof fetch !== "function") {
    return null;
  }
  const syncHistory = await readSyncHistory(paths);
  const sync = currentSyncMetrics();
  const lastRun = normalizeSyncRun(syncHistory[0] || sync.lastRun || null);

  const payload = {
    clientName: profile.clientName,
    profileId: profile.profileId || "",
    clientVersion,
    diagnostics,
    storage: {
      bucket: profile.storage?.bucket || "",
      prefix: profile.storage?.prefix || ""
    },
    sync: buildHeartbeatSyncV1(sync, buildSchedulerStatus(), lastRun)
  };
  payload.auth = createHeartbeatAuth(payload, heartbeatSecret);

  const sentAt = new Date().toISOString();
  const controller = typeof AbortController === "function" && heartbeatTimeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), heartbeatTimeoutMs)
    : null;
  try {
    const response = await fetch(`${serverUrl}/api/devices/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
    const baseHeartbeat = {
      ok: response.ok,
      server: serverUrl,
      sentAt,
      status: response.status
    };
    const responseBody = await readHeartbeatBody(response);
    if (generation !== heartbeatGeneration) {
      return null;
    }
    if (response.ok) {
      const validation = validateHeartbeatSuccessResponse(responseBody);
      if (!validation.ok) {
        lastHeartbeat = {
          ...baseHeartbeat,
          ok: false,
          errorCode: "heartbeat_failed",
          error: validation.message,
          message: `Heartbeat failed: ${validation.message}`
        };
        return lastHeartbeat;
      }
      const successfulHeartbeat = {
        ...baseHeartbeat,
        serverDiagnostics: responseBody.diagnostics,
        device: summarizeHeartbeatDevice(responseBody.device),
        compatibility: responseBody.device.compatibility
      };
      // Persist before publishing: /api/client/status and the compatibility
      // gate must never observe a successful heartbeat whose snapshot a restart
      // could not recover from disk, so both become visible together only after
      // the durable write succeeds.
      await saveLastSuccessfulHeartbeat(successfulHeartbeat, paths);
      lastHeartbeat = successfulHeartbeat;
      lastSuccessfulHeartbeat = successfulHeartbeat;
    } else {
      const remoteError = readHeartbeatError(response, responseBody);
      lastHeartbeat = {
        ...baseHeartbeat,
        errorCode: "heartbeat_failed",
        ...(remoteError.errorCode ? { remoteErrorCode: remoteError.errorCode } : {}),
        error: remoteError.message,
        message: `Heartbeat failed: ${remoteError.message}`
      };
    }
    return lastHeartbeat;
  } catch (error) {
    if (generation !== heartbeatGeneration) {
      return null;
    }
    const timedOut = error?.name === "AbortError";
    lastHeartbeat = {
      ok: false,
      server: serverUrl,
      sentAt,
      errorCode: "heartbeat_failed",
      error: timedOut ? `Timed out after ${heartbeatTimeoutMs}ms` : error.message,
      message: timedOut
        ? `Heartbeat failed: timed out after ${heartbeatTimeoutMs}ms`
        : `Heartbeat failed: ${error.message || "network error"}`
    };
    return lastHeartbeat;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function summarizeHeartbeatDevice(device = null) {
  if (!device || typeof device !== "object") {
    return null;
  }
  return {
    id: typeof device.id === "string" ? device.id : "",
    clientName: typeof device.clientName === "string" ? device.clientName : "",
    enabled: device.enabled !== false,
    online: Boolean(device.online),
    status: typeof device.status === "string" ? device.status : "",
    lastSeenAt: typeof device.lastSeenAt === "string" ? device.lastSeenAt : null,
    bucket: typeof device.bucket === "string" ? device.bucket : "",
    prefix: typeof device.prefix === "string" ? device.prefix : "",
    clientVersion: typeof device.clientVersion === "string" ? device.clientVersion : "",
    lastRemoteAddress: typeof device.lastRemoteAddress === "string" ? device.lastRemoteAddress : "",
    syncState: typeof device.syncState === "string" ? device.syncState : "",
    speedMbps: Number.isFinite(device.speedMbps) ? device.speedMbps : 0,
    sync: summarizeHeartbeatDeviceSync(device.sync)
  };
}

function summarizeHeartbeatDeviceSync(sync = null) {
  if (!sync || typeof sync !== "object") {
    return null;
  }
  return {
    state: typeof sync.state === "string" ? sync.state : "",
    speedMbps: Number.isFinite(sync.speedMbps) ? sync.speedMbps : 0,
    progressPercent: Number.isFinite(sync.progressPercent) ? sync.progressPercent : null,
    currentFile: typeof sync.currentFile === "string" ? sync.currentFile : "",
    currentJob: summarizeHeartbeatDeviceJob(sync.currentJob),
    lastRun: summarizeHeartbeatSyncRun(sync.lastRun),
    conflicts: summarizeHeartbeatConflicts(sync.conflicts),
    scheduler: summarizeHeartbeatScheduler(sync.scheduler)
  };
}

function summarizeHeartbeatSyncRun(run = null) {
  if (!run || typeof run !== "object") {
    return null;
  }
  return {
    id: typeof run.id === "string" ? run.id : "",
    status: typeof run.status === "string" ? run.status : "",
    trigger: normalizeSyncRunTrigger(run.trigger),
    startedAt: typeof run.startedAt === "string" ? run.startedAt : null,
    finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : null,
    job: summarizeHeartbeatDeviceJob(run.job),
    localPath: typeof run.localPath === "string" ? run.localPath : "",
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
    errorCode: typeof run.errorCode === "string" ? run.errorCode : "",
    error: typeof run.error === "string" ? run.error : "",
    progressPercent: Number.isFinite(run.progressPercent) ? run.progressPercent : null,
    transferredSizeText: typeof run.transferredSizeText === "string" ? run.transferredSizeText : "",
    currentFile: typeof run.currentFile === "string" ? run.currentFile : "",
    rawSpeed: typeof run.rawSpeed === "string" ? run.rawSpeed : "",
    speedMbps: Number.isFinite(run.speedMbps) ? run.speedMbps : 0,
    conflicts: summarizeHeartbeatConflicts(run.conflicts)
  };
}

function summarizeHeartbeatDeviceJob(job = null) {
  if (!job || typeof job !== "object") {
    return null;
  }
  return {
    name: typeof job.name === "string" ? job.name : "",
    direction: typeof job.direction === "string" ? job.direction : "",
    bucketName: typeof job.bucketName === "string" ? job.bucketName : "",
    remotePrefix: typeof job.remotePrefix === "string" ? job.remotePrefix : "",
    remoteFolder: typeof job.remoteFolder === "string" ? job.remoteFolder : "",
    serverSpace: typeof job.serverSpace === "string" ? job.serverSpace : ""
  };
}

function summarizeHeartbeatConflicts(conflicts = null) {
  if (!conflicts || typeof conflicts !== "object") {
    return { count: 0, files: [], truncated: false };
  }
  return {
    count: Number.isFinite(conflicts.count) ? conflicts.count : 0,
    files: Array.isArray(conflicts.files)
      ? conflicts.files.filter((file) => typeof file === "string").slice(0, 10)
      : [],
    truncated: Boolean(conflicts.truncated)
  };
}

function summarizeHeartbeatScheduler(scheduler = null) {
  if (!scheduler || typeof scheduler !== "object") {
    return null;
  }
  return {
    enabled: scheduler.enabled !== false,
    intervalMs: Number.isFinite(scheduler.intervalMs) ? Math.max(0, Math.floor(scheduler.intervalMs)) : 0,
    nextRun: typeof scheduler.nextRun === "string" ? scheduler.nextRun : null,
    lastTriggeredAt: typeof scheduler.lastTriggeredAt === "string" ? scheduler.lastTriggeredAt : null,
    lastError: typeof scheduler.lastError === "string" ? scheduler.lastError : "",
    jobs: Array.isArray(scheduler.jobs)
      ? scheduler.jobs.map(summarizeHeartbeatScheduledJob).filter(Boolean).slice(0, 10)
      : []
  };
}

function summarizeHeartbeatScheduledJob(job = null) {
  if (!job || typeof job !== "object") {
    return null;
  }
  return {
    id: typeof job.id === "string" ? job.id : "",
    name: typeof job.name === "string" ? job.name : "",
    schedule: summarizeHeartbeatSchedule(job.schedule),
    scheduleText: typeof job.scheduleText === "string" ? job.scheduleText : "",
    nextRun: typeof job.nextRun === "string" ? job.nextRun : null,
    lastTriggeredAt: typeof job.lastTriggeredAt === "string" ? job.lastTriggeredAt : null,
    lastError: typeof job.lastError === "string" ? job.lastError : ""
  };
}

function summarizeHeartbeatSchedule(schedule = null) {
  if (!schedule || typeof schedule !== "object") {
    return { mode: "manual" };
  }
  const mode = typeof schedule.mode === "string" ? schedule.mode : "manual";
  if (mode === "interval") {
    const intervalMinutes = Number(schedule.intervalMinutes);
    return {
      mode,
      intervalMinutes: Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 30
    };
  }
  if (mode === "daily") {
    return {
      mode,
      time: typeof schedule.time === "string" ? schedule.time : "02:00"
    };
  }
  if (mode === "startup") {
    return { mode };
  }
  return { mode: "manual" };
}

async function readHeartbeatBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function validateHeartbeatSuccessResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidHeartbeatSuccessResponse("body must be a JSON object");
  }
  if (body.ok !== true) {
    return invalidHeartbeatSuccessResponse("ok must be true");
  }
  const diagnosticsValidation = validateHeartbeatDiagnostics(body.diagnostics);
  if (!diagnosticsValidation.ok) return diagnosticsValidation;
  const expectedCompatibility = compareRuntimeDiagnostics(diagnosticsValidation.diagnostics, diagnostics, {
    localRole: "server",
    remoteRole: "client"
  });
  const deviceValidation = validateHeartbeatDevice(body.device, expectedCompatibility);
  if (!deviceValidation.ok) return deviceValidation;
  return { ok: true, message: "" };
}

function validateHeartbeatDiagnostics(diagnostics) {
  const normalized = normalizeRuntimeDiagnostics(diagnostics, "server");
  return normalized
    ? { ok: true, message: "", diagnostics: normalized }
    : invalidHeartbeatSuccessResponse("diagnostics must match the server runtime diagnostics contract");
}

function validateHeartbeatDevice(device, expectedCompatibility) {
  if (!isPlainObject(device)) {
    return invalidHeartbeatSuccessResponse("device must be an object");
  }
  for (const field of ["id", "clientName", "bucket", "prefix", "clientVersion", "lastRemoteAddress"]) {
    if (typeof device[field] !== "string") {
      return invalidHeartbeatSuccessResponse(`device.${field} must be a string`);
    }
  }
  for (const field of ["enabled", "online"]) {
    if (typeof device[field] !== "boolean") {
      return invalidHeartbeatSuccessResponse(`device.${field} must be a boolean`);
    }
  }
  if (!HEARTBEAT_DEVICE_STATUSES.has(device.status)) {
    return invalidHeartbeatSuccessResponse("device.status must be online or offline");
  }
  if (device.lastSeenAt !== null && typeof device.lastSeenAt !== "string") {
    return invalidHeartbeatSuccessResponse("device.lastSeenAt must be null or a string");
  }
  if (!HEARTBEAT_SYNC_STATES.has(device.syncState)) {
    return invalidHeartbeatSuccessResponse("device.syncState must be a known sync state");
  }
  if (!Number.isFinite(device.speedMbps)) {
    return invalidHeartbeatSuccessResponse("device.speedMbps must be a finite number");
  }
  const compatibilityValidation = validateHeartbeatCompatibility(device.compatibility, expectedCompatibility);
  if (!compatibilityValidation.ok) return compatibilityValidation;
  const syncValidation = validateHeartbeatDeviceSync(device.sync);
  if (!syncValidation.ok) return syncValidation;
  if (device.syncState !== device.sync.state) {
    return invalidHeartbeatSuccessResponse("device.syncState must match device.sync.state");
  }
  if (device.speedMbps !== device.sync.speedMbps) {
    return invalidHeartbeatSuccessResponse("device.speedMbps must match device.sync.speedMbps");
  }
  return { ok: true, message: "" };
}

function validateHeartbeatCompatibility(compatibility, expectedCompatibility) {
  if (!isPlainObject(compatibility)) {
    return invalidHeartbeatSuccessResponse("device.compatibility must be an object");
  }
  const keysValidation = validateExactObjectKeys(compatibility, COMPATIBILITY_KEYS, "device.compatibility");
  if (!keysValidation.ok) return keysValidation;
  if (typeof compatibility.ok !== "boolean") {
    return invalidHeartbeatSuccessResponse("device.compatibility.ok must be a boolean");
  }
  if (!COMPATIBILITY_STATUSES.has(compatibility.status)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.status must be compatible or mismatch");
  }
  if (!COMPATIBILITY_ACTIONS.has(compatibility.action)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.action must be a known action");
  }
  if (!COMPATIBILITY_SEVERITIES.has(compatibility.severity)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.severity must be ok or warning");
  }
  if (typeof compatibility.localRole !== "string") {
    return invalidHeartbeatSuccessResponse("device.compatibility.localRole must be a string");
  }
  if (typeof compatibility.remoteRole !== "string") {
    return invalidHeartbeatSuccessResponse("device.compatibility.remoteRole must be a string");
  }
  const policy = compatibility.policy;
  if (!isPlainObject(policy)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.policy must be an object");
  }
  const policyKeysValidation = validateExactObjectKeys(policy, COMPATIBILITY_POLICY_KEYS, "device.compatibility.policy");
  if (!policyKeysValidation.ok) return policyKeysValidation;
  for (const field of ["heartbeat", "profileIssue", "syncRun", "adminActions"]) {
    if (!COMPATIBILITY_POLICY_VALUES.has(policy[field])) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.policy.${field} must be allow or warn`);
    }
  }
  if (policy.reason !== compatibility.action) {
    return invalidHeartbeatSuccessResponse("device.compatibility.policy.reason must match action");
  }
  if (!Array.isArray(compatibility.issues)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.issues must be an array");
  }
  if (compatibility.ok !== (compatibility.issues.length === 0)) {
    return invalidHeartbeatSuccessResponse("device.compatibility.ok must match issues");
  }
  if (compatibility.status !== (compatibility.ok ? "compatible" : "mismatch")) {
    return invalidHeartbeatSuccessResponse("device.compatibility.status must match ok");
  }
  if (compatibility.severity !== (compatibility.ok ? "ok" : "warning")) {
    return invalidHeartbeatSuccessResponse("device.compatibility.severity must match ok");
  }
  for (const [index, issue] of compatibility.issues.entries()) {
    if (!isPlainObject(issue)) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}] must be an object`);
    }
    const issueKeysValidation = validateExactObjectKeys(issue, COMPATIBILITY_ISSUE_KEYS, `device.compatibility.issues[${index}]`);
    if (!issueKeysValidation.ok) return issueKeysValidation;
    if (!COMPATIBILITY_ISSUE_FIELDS.has(issue.field)) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}].field must be a known protocol`);
    }
    if (!COMPATIBILITY_ISSUE_TYPES.has(issue.type)) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}].type must be a known type`);
    }
    if (!isCompatibilityIssueVersion(issue.local)) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}].local must be a positive integer or null`);
    }
    if (!isCompatibilityIssueVersion(issue.remote)) {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}].remote must be a positive integer or null`);
    }
    if (typeof issue.message !== "string" || issue.message.trim() === "") {
      return invalidHeartbeatSuccessResponse(`device.compatibility.issues[${index}].message must be a non-empty string`);
    }
  }
  if (!isDeepStrictEqual(compatibility, expectedCompatibility)) {
    return invalidHeartbeatSuccessResponse("device.compatibility must match runtime diagnostics");
  }
  return { ok: true, message: "" };
}

function isCompatibilityIssueVersion(value) {
  return value === null || (Number.isInteger(value) && value >= 1);
}

function validateHeartbeatDeviceSync(sync) {
  if (!isPlainObject(sync)) {
    return invalidHeartbeatSuccessResponse("device.sync must be an object");
  }
  if (!HEARTBEAT_SYNC_STATES.has(sync.state)) {
    return invalidHeartbeatSuccessResponse("device.sync.state must be a known sync state");
  }
  if (!Number.isFinite(sync.speedMbps)) {
    return invalidHeartbeatSuccessResponse("device.sync.speedMbps must be a finite number");
  }
  if (sync.progressPercent !== null && !Number.isFinite(sync.progressPercent)) {
    return invalidHeartbeatSuccessResponse("device.sync.progressPercent must be null or a finite number");
  }
  if (typeof sync.currentFile !== "string") {
    return invalidHeartbeatSuccessResponse("device.sync.currentFile must be a string");
  }
  if (!Object.hasOwn(sync, "currentJob") || (sync.currentJob !== null && !isPlainObject(sync.currentJob))) {
    return invalidHeartbeatSuccessResponse("device.sync.currentJob must be null or an object");
  }
  if (!Object.hasOwn(sync, "lastRun") || (sync.lastRun !== null && !isPlainObject(sync.lastRun))) {
    return invalidHeartbeatSuccessResponse("device.sync.lastRun must be null or an object");
  }
  const conflictsValidation = validateHeartbeatConflicts(sync.conflicts, "device.sync.conflicts");
  if (!conflictsValidation.ok) return conflictsValidation;
  if (!Object.hasOwn(sync, "scheduler") || (sync.scheduler !== null && !isPlainObject(sync.scheduler))) {
    return invalidHeartbeatSuccessResponse("device.sync.scheduler must be null or an object");
  }
  if (sync.scheduler) {
    const schedulerValidation = validateHeartbeatScheduler(sync.scheduler);
    if (!schedulerValidation.ok) return schedulerValidation;
  }
  if (sync.lastRun) {
    const lastRunValidation = validateHeartbeatLastRun(sync.lastRun);
    if (!lastRunValidation.ok) return lastRunValidation;
  }
  return { ok: true, message: "" };
}

function validateHeartbeatConflicts(conflicts, label) {
  if (!isPlainObject(conflicts)) {
    return invalidHeartbeatSuccessResponse(`${label} must be an object`);
  }
  if (!Number.isFinite(conflicts.count)) {
    return invalidHeartbeatSuccessResponse(`${label}.count must be a finite number`);
  }
  if (!Array.isArray(conflicts.files) || !conflicts.files.every((file) => typeof file === "string")) {
    return invalidHeartbeatSuccessResponse(`${label}.files must be a string array`);
  }
  if (typeof conflicts.truncated !== "boolean") {
    return invalidHeartbeatSuccessResponse(`${label}.truncated must be a boolean`);
  }
  return { ok: true, message: "" };
}

function validateHeartbeatScheduler(scheduler) {
  if (typeof scheduler.enabled !== "boolean") {
    return invalidHeartbeatSuccessResponse("device.sync.scheduler.enabled must be a boolean");
  }
  if (!Number.isInteger(scheduler.intervalMs) || scheduler.intervalMs < 0) {
    return invalidHeartbeatSuccessResponse("device.sync.scheduler.intervalMs must be a non-negative integer");
  }
  for (const field of ["nextRun", "lastTriggeredAt"]) {
    if (scheduler[field] !== null && typeof scheduler[field] !== "string") {
      return invalidHeartbeatSuccessResponse(`device.sync.scheduler.${field} must be null or a string`);
    }
  }
  if (typeof scheduler.lastError !== "string") {
    return invalidHeartbeatSuccessResponse("device.sync.scheduler.lastError must be a string");
  }
  if (!Array.isArray(scheduler.jobs)) {
    return invalidHeartbeatSuccessResponse("device.sync.scheduler.jobs must be an array");
  }
  return { ok: true, message: "" };
}

function validateHeartbeatLastRun(run) {
  if (!["running", "success", "error", "stopped", "unknown"].includes(run.status)) {
    return invalidHeartbeatSuccessResponse("device.sync.lastRun.status must be a known run status");
  }
  if (!["manual", "scheduler"].includes(run.trigger)) {
    return invalidHeartbeatSuccessResponse("device.sync.lastRun.trigger must be manual or scheduler");
  }
  if (!Number.isFinite(run.speedMbps)) {
    return invalidHeartbeatSuccessResponse("device.sync.lastRun.speedMbps must be a finite number");
  }
  const conflictsValidation = validateHeartbeatConflicts(run.conflicts, "device.sync.lastRun.conflicts");
  if (!conflictsValidation.ok) return conflictsValidation;
  return { ok: true, message: "" };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateExactObjectKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalidHeartbeatSuccessResponse(`${label} must contain exact keys ${expectedKeys.join(", ")}`);
  }
  return { ok: true, message: "" };
}

function invalidHeartbeatSuccessResponse(reason) {
  return {
    ok: false,
    message: `Malformed heartbeat response: ${reason}`
  };
}

function readHeartbeatError(response, body) {
  const fallback = response.statusText || `HTTP ${response.status}`;
  return parseHeartbeatErrorBody(body, fallback);
}

function parseHeartbeatErrorBody(body, fallback) {
  const rawErrorCode = typeof body?.errorCode === "string"
    ? body.errorCode
    : typeof body?.error === "string"
      ? body.error
      : "";
  return {
    errorCode: normalizeHeartbeatRemoteErrorCode(rawErrorCode),
    message: body?.message || rawErrorCode || fallback
  };
}

function normalizeHeartbeatRemoteErrorCode(value) {
  const code = String(value || "").trim();
  return isStableErrorCode(code) ? code : "";
}

function createSyncRunStart(job = {}, options = {}) {
  const startedAt = new Date().toISOString();
  return {
    id: `sync-${Date.now()}`,
    status: "running",
    trigger: normalizeSyncRunTrigger(options.trigger),
    startedAt,
    finishedAt: null,
    job: summarizeHeartbeatJob(job),
    localPath: job.localPath || "",
    schedule: job.schedule || { mode: "manual" },
    destructiveSync: Boolean(job.destructiveSync),
    bandwidthLimit: job.bandwidthLimit || "off",
    transfers: Number(job.transfers || 4),
    streams: Number(job.streams || 8)
  };
}

function normalizeSyncRunTrigger(value) {
  return value === "scheduler" ? "scheduler" : "manual";
}

function buildSyncRunFinishPatch(status, exit, finishedAt, metrics = {}) {
  const errorCode = status === "error"
    ? metrics.errorCode || exit.errorCode || "rclone_sync_failed"
    : "";
  const error = metrics.error || exit.error || (errorCode === "rclone_sync_failed" && Number.isInteger(exit.exitCode)
    ? `rclone exited with code ${exit.exitCode}`
    : "");
  const lastExit = exit && typeof exit === "object"
    ? { ...exit, errorCode, error }
    : null;
  return {
    status,
    finishedAt,
    exitCode: Number.isInteger(exit.exitCode) ? exit.exitCode : null,
    errorCode,
    error,
    progressPercent: metrics.progressPercent,
    transferredSizeText: metrics.transferredSizeText || metrics.transferredText || "",
    currentFile: metrics.currentFile || "",
    rawSpeed: metrics.rawSpeed || "",
    speedMbps: Number(metrics.speedMbps || 0),
    conflicts: metrics.conflicts || { count: 0, files: [], truncated: false },
    lastExit
  };
}

function summarizeHeartbeatJob(job = {}) {
  return {
    name: job.name || "folder-sync",
    direction: job.direction || "upload",
    bucketName: job.bucketName || "",
    remotePrefix: job.remotePrefix || "",
    remoteFolder: job.remoteFolder || "",
    serverSpace: job.serverSpace || "device"
  };
}

function requireSyncCompatibilityConfirmation(body = {}) {
  if (lastSuccessfulHeartbeat?.ok && lastSuccessfulHeartbeat?.compatibility?.policy?.syncRun === "warn" && body.confirmCompatibilityWarning !== true) {
    throw createHttpError(
      "danger_confirmation_required",
      400,
      "Confirm protocol compatibility warning before saving or running sync."
    );
  }
}

function requireDestructiveSyncConfirmation(body = {}) {
  const job = body.job || {};
  const direction = job.direction || "upload";
  if (direction !== "bidirectional" && Boolean(job.destructiveSync) && body.confirmDestructiveSync !== true) {
    throw createHttpError(
      "danger_confirmation_required",
      400,
      "Confirm mirror sync before saving or running sync."
    );
  }
}

async function normalizeJob(job = {}) {
  if (job.storageBackend === "sftp") {
    const payload = await refreshRelationDataAuthorization(job.relationId);
    return normalizeSftpJobWithAuthorization(job, payload);
  }
  const profile = await readProfile(paths);
  if (!profile) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before saving or previewing sync jobs");
  }
  return normalizeJobWithProfile(profile, job);
}

async function refreshRelationDataAuthorization(relationId) {
  const session = await readEnrollmentSession(paths);
  const serverState = activeEnrollmentServer(session);
  if (!session.identity || serverState.request?.status !== "consumed"
    || !verifyPersistedEnrollmentReceipt(serverState, session.identity)) {
    throw createHttpError("enrollment_trust_failed", 409, "A verified enrollment receipt is required before creating an SFTP task");
  }
  const binding = serverState.receipt.grant.bindings.find((item) => item.identity.relationId === relationId);
  if (!binding) throw createHttpError("enrollment_binding_mismatch", 403, "The selected directory is not part of this consumed enrollment grant");
  await ensureEnrollmentChannelFresh(session, serverState);
  serverState.dataAuthorizations ||= {};
  try {
    const result = await issueDataAuthorization(serverState, session.identity, binding);
    serverState.dataAuthorizations[relationId] = result.envelope;
    await saveEnrollmentSession(session, paths);
    return result.payload;
  } catch (error) {
    if (["enrollment_relation_denied", "enrollment_relation_revoked", "enrollment_data_authorization_denied"].includes(error?.code)) {
      delete serverState.dataAuthorizations[relationId];
      await saveEnrollmentSession(session, paths);
    }
    throw error;
  }
}

async function normalizeSftpJobWithAuthorization(job = {}, payload, options = {}) {
  if (job.direction && job.direction !== "bidirectional") {
    throw createHttpError("enrollment_relation_denied", 403, "This authorized SFTP directory supports bidirectional sync only");
  }
  if (job.relationId !== payload.binding.identity.relationId) {
    throw createHttpError("enrollment_binding_mismatch", 403, "The signed directory authorization does not match the selected directory");
  }
  const relationId = payload.binding.identity.relationId;
  const relationFiles = join(paths.sftpRoot, relationId);
  const keyFile = join(relationFiles, "device_ed25519.pem");
  const knownHostsFile = join(relationFiles, "known_hosts");
  const session = await readEnrollmentSession(paths);
  const identity = session?.identity;
  if (!identity || identity.deviceId !== payload.deviceId
    || publicKeyFingerprint(identity.publicKey) !== payload.publicKeyFingerprint) {
    throw createHttpError("enrollment_binding_mismatch", 403, "The signed directory authorization does not match the local device key");
  }
  const privateKey = createPrivateKey({ key: identity.privateKey, format: "jwk" });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await writeProtectedTextFile(keyFile, privateKeyPem);
  const [keyType, keyBytes] = payload.serverHostKey.publicKey.split(/\s+/);
  const knownHostLine = `[${payload.sftp.host}]:${payload.sftp.port} ${keyType} ${keyBytes}\n`;
  await writeProtectedTextFile(knownHostsFile, knownHostLine);
  const localProxyPort = await selectSftpLocalProxyPort(job.localProxyPort);
  const sftpTransport = {
    host: payload.sftp.host,
    port: payload.sftp.port,
    user: payload.sftp.user,
    socksProxy: `127.0.0.1:${localProxyPort}`,
    knownHostsFile,
    keyFile,
    hostKeyFingerprint: payload.serverHostKey.fingerprint,
    credentialRevision: `${payload.binding.credentialRevision}-${payload.sftpDataChannel.channelRevision}`
  };
  const normalized = {
    ...(job.id ? { id: String(job.id).trim() } : {}),
    name: job.name || `${payload.displayName} 同步`,
    localPath: options.validateLocalPath ? await validateSyncLocalPath(job.localPath) : String(job.localPath || ""),
    direction: "bidirectional",
    storageBackend: "sftp",
    rootPath: "",
    relationId,
    directoryDisplayName: payload.displayName,
    clientName: `device-${payload.deviceId.slice(-12)}`,
    remoteName: "sfsc-data",
    exclude: Array.isArray(job.exclude) ? job.exclude.filter((item) => typeof item === "string") : [],
    transfers: normalizePositiveInteger(job.transfers, { field: "job.transfers", defaultValue: 4 }),
    streams: normalizePositiveInteger(job.streams, { field: "job.streams", defaultValue: 8 }),
    checkers: normalizePositiveInteger(job.checkers, { field: "job.checkers", defaultValue: 8 }),
    retries: normalizePositiveInteger(job.retries, { field: "job.retries", defaultValue: 3 }),
    lowLevelRetries: normalizePositiveInteger(job.lowLevelRetries, { field: "job.lowLevelRetries", defaultValue: 10 }),
    cutoff: normalizeSftpChunkParameter(job.cutoff ?? job.chunkSize ?? "16M", "job.cutoff"),
    localProxyPort,
    dryRun: Boolean(job.dryRun),
    destructiveSync: false,
    safety: normalizeSyncSafety(job.safety, "bidirectional"),
    bandwidthLimit: normalizeBandwidthLimit(job.bandwidthLimit || "off"),
    schedule: normalizeSchedule(job.schedule || { mode: "manual" }),
    sftpTransport
  };
  const binding = payload.binding;
  const trustedBinding = {
    serverId: payload.serverId,
    deviceId: payload.deviceId,
    shareId: binding.identity.shareId,
    rootId: binding.identity.rootId,
    relationId,
    baselineEpoch: binding.baselineEpoch,
    channelRevision: binding.channelRevision,
    credentialRevision: binding.credentialRevision,
    rootAttestation: canonicalJson(binding.rootAttestation),
    scope: "device",
    authorization: payload.authorization,
    // The SFTP user's chroot is the physical directory boundary. The client
    // addresses that chroot root as rclone's empty virtual relative path.
    root: { backend: "sftp", bucketName: "", path: "" }
  };
  const storedJob = normalized.id
    ? (await readStoredJobs(paths)).find((item) => item.id === normalized.id) || null
    : null;
  let relation = buildSyncRelation({}, normalized, { trustedBinding, sftpTransport });
  if (storedJob?.syncRelation) {
    if (!sameSyncRelationBaseline(relation, storedJob.syncRelation)) {
      throw syncRelationMigrationError(storedJob.syncRelation, "sync_relation_baseline_changed");
    }
    if (!storedJob.syncRelation.serverIdentityProven
      && !relation.serverIdentityProven
      && syncRelationConnectionChanged(relation, storedJob.syncRelation)) {
      throw syncRelationMigrationError(storedJob.syncRelation, "server_identity_unproven_for_connection_change");
    }
    relation = reuseMatchingSyncRelation(relation, storedJob.syncRelation);
  }
  const [bisyncState, runtimeDirectoryIds] = await Promise.all([readBisyncState(), readBisyncRuntimeDirectoryIds()]);
  relation = resolveBisyncMigration(relation, bisyncState, {
    runtimeDirectoryIds,
    runtimeBisyncRoot: paths.runtimeRoot,
    legacyJob: storedJob && !storedJob.syncRelation ? { storedJob, candidateJob: normalized } : null
  });
  assertSyncRelationReady(relation);
  return applySyncRelationToJob(normalized, relation);
}

function normalizeSftpChunkParameter(input, field) {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 64) {
    throw createHttpError("validation_failed", 400, `${field} must be a non-empty string of at most 64 characters`);
  }
  return input.trim();
}

async function normalizeJobWithProfile(profile, job = {}, options = {}) {
  const normalized = buildJobFromProfile(profile, job);
  if (typeof job.id === "string" && job.id.trim()) {
    normalized.id = job.id.trim();
  }
  normalized.exclude = Array.isArray(job.exclude) ? [...job.exclude] : [];
  if (options.validateLocalPath) {
    normalized.localPath = await validateSyncLocalPath(normalized.localPath);
  }
  if (normalized.direction !== "bidirectional") {
    return normalized;
  }

  const storedJob = normalized.id
    ? (await readStoredJobs(paths)).find((item) => item.id === normalized.id) || null
    : null;
  let relation = buildSyncRelation(profile, normalized, {
    trustedBinding: options.trustedBinding
  });
  if (storedJob?.syncRelation) {
    if (!sameSyncRelationBaseline(relation, storedJob.syncRelation)) {
      throw syncRelationMigrationError(storedJob.syncRelation, "sync_relation_baseline_changed");
    }
    if (!storedJob.syncRelation.serverIdentityProven
      && !relation.serverIdentityProven
      && syncRelationConnectionChanged(relation, storedJob.syncRelation)) {
      throw syncRelationMigrationError(
        storedJob.syncRelation,
        "server_identity_unproven_for_connection_change"
      );
    }
    relation = reuseMatchingSyncRelation(relation, storedJob.syncRelation);
  }
  const [bisyncState, runtimeDirectoryIds] = await Promise.all([
    readBisyncState(),
    readBisyncRuntimeDirectoryIds()
  ]);
  const legacyJob = !storedJob?.syncRelation
    || storedJob.syncRelation.migration?.state === "legacy_compatible"
    ? storedJob ? {
        storedJob,
        candidateJob: normalized
      } : null
    : null;
  relation = resolveBisyncMigration(relation, bisyncState, {
    runtimeDirectoryIds,
    runtimeBisyncRoot: paths.runtimeRoot,
    legacyJob
  });
  assertSyncRelationReady(relation);
  return applySyncRelationToJob(normalized, relation);
}

async function buildSyncRunPlan(job = {}) {
  if (job.storageBackend === "sftp") {
    const tunnelPayload = await refreshRelationDataAuthorization(job.relationId);
    const normalizedJob = await normalizeSftpJobWithAuthorization(job, tunnelPayload, { validateLocalPath: true });
    return { normalizedJob, tunnelUri: tunnelPayload.sftpDataChannel.connection.uri, dataTunnel: true };
  }
  const profile = await readProfile(paths);
  if (!profile) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before running sync jobs");
  }
  const tunnelUri = getTunnelUri(profile);
  if (!tunnelUri) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before running sync jobs");
  }
  const normalizedJob = await normalizeJobWithProfile(profile, job, {
    validateLocalPath: true
  });
  return {
    normalizedJob,
    tunnelUri
  };
}

async function withSyncTunnel(runPlan, task) {
  const { normalizedJob, tunnelUri, dataTunnel = false } = runPlan;
  if (dataTunnel) {
    await startDataSingbox(tunnelUri, normalizedJob.localProxyPort || SFTP_DATA_SOCKS_PORT);
    try {
      return await task();
    } finally {
      if (dataSingboxProcess.isRunning()) await dataSingboxProcess.stopAndWait({ timeoutMs: 3000 }).catch(() => {});
    }
  }
  if (!singboxProcess.isRunning()) {
    await startSingbox({ uri: tunnelUri, localProxyPort: normalizedJob.localProxyPort || 18081 });
  }
  return task();
}

async function verifySftpAccessMarkers(preview, job, { createMissing = false } = {}) {
  const rootId = job.syncRelation?.rootId;
  const contents = sftpAccessMarkerContents(rootId);
  const markerSourceFile = join(paths.runtimeRoot, `sftp-access-${randomUUID()}.marker`);
  try {
    if (createMissing) await writeFile(markerSourceFile, contents, { flag: "wx" });
    return await ensureSftpAccessMarkers({
      localRoot: job.localPath,
      remoteRoot: preview.args[2],
      rootId,
      createMissing,
      markerSourceFile: createMissing ? markerSourceFile : undefined,
      rcloneBin: paths.rcloneExe,
      rcloneConfigPath: paths.rcloneConfigFile,
      env: preview.env,
      runBuffered
    });
  } finally {
    if (createMissing) await rm(markerSourceFile, { force: true }).catch(() => {});
  }
}

function assertSyncRelationReady(relation) {
  if (["ready", "legacy_compatible"].includes(relation?.migration?.state)) {
    return;
  }
  throw syncRelationMigrationError(relation, relation.migration.reasons?.[0] || "sync_relation_review_required");
}

function syncRelationMigrationError(relation, reason) {
  const error = createHttpError(
    "sync_relation_migration_required",
    409,
    "This sync relation needs review before Syncraft can reuse or initialize its baseline."
  );
  error.syncRelation = summarizeSyncRelation(relation);
  error.reason = reason;
  return error;
}

async function validateSyncLocalPath(input) {
  const requested = String(input || "").trim();
  if (process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS === "1") {
    return requested;
  }
  if (!requested || !isAbsolute(requested)) {
    throw createHttpError("invalid_path", 400, "Sync local path must be an absolute directory");
  }
  const localPath = resolve(requested);
  if (parse(localPath).root === localPath) {
    throw createHttpError("invalid_path", 400, "Sync local path cannot be a filesystem root");
  }
  for (const protectedPath of [paths.root, paths.dataRoot, paths.runtimeRoot, paths.logRoot]) {
    if (isInsideOrEqual(localPath, protectedPath)) {
      throw createHttpError("invalid_path", 400, "Sync local path cannot be inside the application data or package directory");
    }
  }
  try {
    const info = await stat(localPath);
    if (!info.isDirectory()) {
      throw createHttpError("invalid_path", 400, "Sync local path must be a directory");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createHttpError("invalid_path", 400, "Sync local path does not exist");
    }
    throw error;
  }
  return localPath;
}

function isInsideOrEqual(target, container) {
  const diff = relative(resolve(container), resolve(target));
  return diff === "" || (!diff.startsWith(`..${sep}`) && diff !== ".." && !isAbsolute(diff));
}

function getTunnelUri(profile) {
  return profile?.tunnel?.uri || profile?.uri || null;
}

// E-2: served with every HTML document. default-src 'none' + explicit allows;
// no remote origin appears anywhere, so injected markup can neither run
// foreign script nor phone home. Keep in sync with src/server.js.
const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join("; ");

async function serveStatic(pathname, res) {
  let fullPath;
  try {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const decoded = decodeURIComponent(requested);
    // `\` is a path separator on Windows but a literal character elsewhere, so an
    // encoded backslash (%5c) would only be caught by the traversal check on one
    // platform. No static asset URL contains one, so reject it outright.
    if (decoded.includes("\\")) {
      return jsonError(res, makeHttpError("invalid_path", 400));
    }
    fullPath = normalize(join(paths.publicDir, decoded));
  } catch {
    return jsonError(res, makeHttpError("invalid_path", 400));
  }
  if (!isPathInside(paths.publicDir, fullPath)) {
    return jsonError(res, makeHttpError("invalid_path", 400));
  }

  try {
    const body = await readFile(fullPath);
    const type = contentType(fullPath);
    const headers = {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    if (type.startsWith("text/html")) {
      // E-2: the UI has no inline scripts or event-handler attributes, so
      // script-src 'self' is enforceable; 'unsafe-inline' is scoped to styles
      // because index.html uses inline style attributes. connect-src 'self'
      // keeps injected markup from exfiltrating to remote origins.
      headers["content-security-policy"] = UI_CONTENT_SECURITY_POLICY;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    jsonError(res, makeHttpError("not_found", 404));
  }
}

function isPathInside(baseDir, targetPath) {
  const base = normalize(baseDir);
  const target = normalize(targetPath);
  return target === base || target.startsWith(`${base}${sep}`);
}

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function assertLocalWriteRequest(req) {
  assertBrowserWriteOrigin(req);
  assertJsonWriteContentType(req);
}

// C-5: the Host allowlist above blocks DNS rebinding, but a malicious page can
// still issue a plain cross-site GET to a known loopback port and read sync
// configuration, bucket names, and the VLESS server address. Writes already
// refuse cross-site requests; reads must refuse them too, otherwise the
// browser-reachable read surface stays wider than the write surface.
//
// This deliberately does not add a bearer token. A token cannot defend against
// a local process that already executes code (it would simply read
// secrets.json / profile.json directly), so the threat it would actually
// mitigate is the browser one — which origin checks address without forcing
// every local tool and test to carry credentials.
function assertLocalReadRequest(req) {
  const secFetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    throw createHttpError("local_read_forbidden", 403, "Cross-site local reads are forbidden");
  }
}

// Rejects requests whose Host header is not this loopback listener. Blocks DNS
// rebinding, where a browser resolves an attacker-controlled name to 127.0.0.1
// and would otherwise be treated as same-origin for reads.
function assertLocalHostHeader(req) {
  const rawHost = String(req.headers.host || "").trim();
  const localPort = String(req.socket?.localPort || port);
  if (!rawHost) {
    // HTTP/1.0 clients may omit Host; the loopback bind still constrains reach.
    return;
  }

  let parsed;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    throw createHttpError("local_host_forbidden", 403, "Request Host header is not a loopback address");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopbackHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const hostPort = parsed.port || "80";
  if (!isLoopbackHost || hostPort !== localPort) {
    throw createHttpError("local_host_forbidden", 403, "Request Host header is not a loopback address");
  }
}

function assertBrowserWriteOrigin(req) {
  const secFetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    throw createHttpError("local_write_forbidden", 403, "Cross-site local writes are forbidden");
  }

  const origin = String(req.headers.origin || "").trim();
  if (!origin) {
    return;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw createHttpError("local_write_forbidden", 403, "Cross-site local writes are forbidden");
  }

  const hostname = parsed.hostname.toLowerCase();
  const localPort = String(req.socket.localPort || port);
  const isLoopbackOrigin = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol !== "http:" || !isLoopbackOrigin || parsed.port !== localPort) {
    throw createHttpError("local_write_forbidden", 403, "Cross-site local writes are forbidden");
  }
}
function json(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function jsonError(res, error) {
  const normalized = normalizeHttpError(error, "client_error");
  json(res, {
    ok: false,
    error: normalized.code,
    errorCode: normalized.code,
    message: normalized.message
  }, normalized.status);
}

function makeHttpError(code, status, message) {
  return createHttpError(code, status, message);
}

function missingBinaryError(name, path, code) {
  return createHttpError(code, 503, `Missing bundled ${name}: ${path}`);
}

function openBrowser(url) {
  execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, () => {});
}
