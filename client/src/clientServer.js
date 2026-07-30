import http from "node:http";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import {
  buildClientSingboxConfig,
  buildJobFromProfile,
  buildRclonePreview,
  buildRuntimeDiagnostics,
  assertJsonWriteContentType,
  compareRuntimeDiagnostics,
  createHeartbeatAuth,
  computeNextRun,
  createHttpError,
  decodeClaimToken,
  describeSchedule,
  isStableErrorCode,
  normalizeSchedule,
  normalizeSyncRun,
  normalizeHttpError,
  normalizeRuntimeDiagnostics,
  parseProtocolRequest,
  PROTOCOL_REQUESTS,
  readJson,
  summarizeImportProfile
} from "../../src/core/index.js";
import { ensureClientDirs, getClientPaths } from "./paths.js";
import { buildDiagnosticBundle } from "./diagnosticBundle.js";
import { resolveProfileImport } from "./profileImport.js";
import { fileExists, ManagedProcess, readRecentLog, readRecentLogWithMeta, redactLogText, runBuffered } from "./processRunner.js";
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
  restoreProfileImportState,
  saveLastSuccessfulHeartbeat,
  clearClaimRecovery,
  clearLastSuccessfulHeartbeat,
  saveJob,
  saveJobs,
  saveProfile,
  snapshotProfileImportState,
  writeJsonFile,
  withClientStateLock
} from "./store.js";

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
const HEARTBEAT_DEVICE_STATUSES = new Set(["online", "offline"]);
const HEARTBEAT_SYNC_STATES = new Set(["idle", "syncing", "error", "stopping", "offline"]);
const singboxProcess = new ManagedProcess("sing-box", paths.singboxLog);
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
let activeSyncJobFingerprint = "";
let stoppingSyncReplay = null;
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
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, buildHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/client/status") {
      return json(res, await buildStatus());
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

    if (req.method === "GET" && url.pathname === "/api/sync/history") {
      return json(res, { history: await readSyncHistory(paths) });
    }

    if (req.method === "POST" && url.pathname === "/api/jobs/save") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      requireDestructiveSyncConfirmation(body);
      requireManualScheduleForRiskySync(body.job || {});
      const payload = await withClientStateLock(paths, async () => {
        await ensureLocalStateWritable();
        await ensureSecretVaultReady();
        const job = await saveJob(await normalizeJob(body.job || {}), paths);
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
      return json(res, { plan: await createSyncSafetyPlan(body.job || {}) });
    }

    if (req.method === "POST" && url.pathname === "/api/sync/bisync/initialize") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_INITIALIZE, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      return json(res, { initialization: await initializeBidirectionalSync(body) });
    }

    if (req.method === "POST" && url.pathname === "/api/sync/run") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RUN, await readJson(req));
      requireSyncCompatibilityConfirmation(body);
      requireDestructiveSyncConfirmation(body);
      await requireSyncSafetyPlan(body);
      return json(res, { sync: await runSync(body.job || {}, { trigger: "manual" }) });
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
    singboxProcess.stopAndWait({ timeoutMs: 2500 }),
    syncProcess.stopAndWait({ timeoutMs: 2500 })
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
    s3Endpoint: job.s3Endpoint
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
    defaults: profile.defaults || {}
  };
}

async function buildDiagnosticExport() {
  const generatedAt = new Date().toISOString();
  const bundle = buildDiagnosticBundle({
    generatedAt,
    status: await buildStatus(),
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
      const profile = await saveProfile(await resolveProfileImport(body, {
        timeoutMs: claimRedeemTimeoutMs,
        clientRedeemId: claimRecovery?.clientRedeemId,
        clientInstallId: claimRecovery?.clientInstallId
      }), paths);
      await refreshJobsForProfile(profile);
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
  const importCode = body.code || body.tKey || body.tkey || body.claimCode || body.token;
  if (!importCode) {
    return null;
  }
  let claim = null;
  try {
    claim = decodeClaimToken(String(importCode).trim());
  } catch {
    return null;
  }
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

async function refreshJobsForProfile(profile) {
  const existingJobs = await readStoredJobs(paths);
  if (!existingJobs.length) {
    return [];
  }
  const refreshed = existingJobs.map((job) => ({
    ...buildJobFromProfile(profile, pickUserJobFields(job)),
    id: job.id,
    createdAt: job.createdAt || job.updatedAt || new Date().toISOString()
  }));
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
    dryRun: job.dryRun,
    destructiveSync: job.destructiveSync,
    safety: job.safety,
    bandwidthLimit: job.bandwidthLimit,
    schedule: job.schedule,
    localProxyPort: job.localProxyPort
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
    bisyncWorkdir: normalized.direction === "bidirectional" ? getBisyncWorkdir(syncJobFingerprint(normalized)) : "",
    backupDir: options.backupDir || ""
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
  if (!schedulerState.enabled || syncProcess.isRunning()) {
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
  await ensureLocalStateWritable();
  const runPlan = await buildSyncRunPlan(job);
  if (options.trigger === "scheduler" && requiresSyncSafetyPlan(runPlan.normalizedJob)) {
    throw createHttpError("danger_confirmation_required", 400, "Risky sync jobs require a fresh manual safety plan.");
  }
  const jobFingerprint = syncJobFingerprint(runPlan.normalizedJob);
  if (syncRunInFlight) {
    if (syncRunInFlightJobFingerprint !== jobFingerprint) {
      throw syncAlreadyRunningError();
    }
    return syncRunInFlight;
  }
  const stoppingReplay = currentStoppingSyncReplay();
  if (stoppingReplay) {
    if (stoppingReplay.jobFingerprint === jobFingerprint) {
      return stoppingReplay.status;
    }
    throw syncAlreadyRunningError();
  }
  if (syncProcess.isRunning()) {
    if (activeSyncJobFingerprint && activeSyncJobFingerprint === jobFingerprint) {
      return syncProcess.status();
    }
    throw syncAlreadyRunningError();
  }
  syncRunInFlightJobFingerprint = jobFingerprint;
  stoppingSyncReplay = null;
  syncRunInFlight = runSyncExclusive(runPlan, options);
  try {
    return await syncRunInFlight;
  } finally {
    syncRunInFlight = null;
    syncRunInFlightJobFingerprint = "";
  }
}

async function createSyncSafetyPlan(job = {}) {
  const runPlan = await buildSyncRunPlan(job);
  const { normalizedJob, tunnelUri } = runPlan;
  const fingerprint = syncJobFingerprint(normalizedJob);
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
    if (!singboxProcess.isRunning()) {
      await startSingbox({ uri: tunnelUri, localProxyPort: normalizedJob.localProxyPort || 18081 });
    }
    const [sourcePaths, targetPaths] = await Promise.all([
      listSyncFiles(preview, preview.args[1]),
      listSyncFiles(preview, preview.args[2])
    ]);
    summary.source.files = sourcePaths.size;
    summary.target.files = targetPaths.size;
    if (normalizedJob.direction !== "bidirectional" && normalizedJob.destructiveSync) {
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
    ? await isBisyncInitialized(fingerprint)
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
  if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || plan.fingerprint !== syncJobFingerprint(runPlan.normalizedJob)) {
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
  const { normalizedJob, tunnelUri } = runPlan;
  if (normalizedJob.direction !== "bidirectional") {
    throw createHttpError("validation_failed", 400, "Bidirectional initialization requires direction bidirectional.");
  }
  const fingerprint = syncJobFingerprint(normalizedJob);
  const plan = syncSafetyPlans.get(String(body.safetyPlanId || "").trim());
  if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || plan.fingerprint !== fingerprint || !plan.summary.bidirectional.initializationRequired) {
    throw createHttpError("danger_confirmation_required", 400, "Generate a current bidirectional safety plan before initialization.");
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
  if (!singboxProcess.isRunning()) {
    await startSingbox({ uri: tunnelUri, localProxyPort: normalizedJob.localProxyPort || 18081 });
  }
  const mode = normalizedJob.safety.bidirectional.initialMode || "newer";
  const workdir = getBisyncWorkdir(fingerprint);
  await mkdir(workdir, { recursive: true });
  const initArgs = [...preview.args, "--resync", "--resync-mode", mode];
  const dryRun = await runBuffered(paths.rcloneExe, [...initArgs, "--dry-run"], {
    cwd: paths.root,
    env: preview.env,
    timeoutMs: 60000
  });
  if (!dryRun.ok) {
    throw createHttpError("rclone_sync_failed", 500, "Bidirectional initialization dry run failed");
  }
  const initialized = await runBuffered(paths.rcloneExe, initArgs, {
    cwd: paths.root,
    env: preview.env,
    timeoutMs: 120000
  });
  if (!initialized.ok) {
    throw createHttpError("rclone_sync_failed", 500, "Bidirectional initialization failed");
  }
  await markBisyncInitialized(fingerprint, { mode, workdir });
  plan.consumed = true;
  return {
    initialized: true,
    mode,
    initializedAt: new Date().toISOString()
  };
}

async function isBisyncInitialized(fingerprint) {
  const state = await readJsonFile(paths.bisyncStateFile, {});
  return Boolean(state?.[fingerprint]?.initializedAt);
}

async function markBisyncInitialized(fingerprint, details) {
  const state = await readJsonFile(paths.bisyncStateFile, {});
  const next = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  next[fingerprint] = { initializedAt: new Date().toISOString(), ...details };
  await writeJsonFile(paths.bisyncStateFile, next);
}

function getBisyncWorkdir(fingerprint) {
  const id = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  return join(paths.runtimeRoot, "bisync", id);
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

function requireManualScheduleForRiskySync(job = {}) {
  if (process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS === "1") return;
  const direction = job.direction || "upload";
  const risky = direction === "bidirectional" || Boolean(job.destructiveSync);
  const scheduleMode = job.schedule?.mode || "manual";
  if (risky && scheduleMode !== "manual") {
    throw createHttpError("validation_failed", 400, "Mirror and bidirectional sync jobs must use a manual schedule until unattended safety plans are available.");
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
  const { normalizedJob, tunnelUri } = runPlan;
  await ensureLocalStateWritable();
  await ensureSecretVaultReady();
  await ensureSyncRunBinaries();
  if (syncProcess.isRunning()) {
    return syncProcess.status();
  }

  if (normalizedJob.direction === "bidirectional") {
    await mkdir(getBisyncWorkdir(syncJobFingerprint(normalizedJob)), { recursive: true });
  }

  const recovery = getSyncRecoveryPaths(normalizedJob);
  if (recovery?.local) {
    await mkdir(recovery.current, { recursive: true });
  }
  const preview = (await buildSyncPreviewFromNormalizedJob(normalizedJob, {
    backupDir: recovery?.current || ""
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
  if (!singboxProcess.isRunning()) {
    await startSingbox({
      uri: tunnelUri,
      localProxyPort: normalizedJob.localProxyPort || 18081
    });
  }
  try {
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
        await markSyncExited(exit);
        if (exit.ok && recovery) {
          pruneSyncRecovery(preview, recovery, normalizedJob.safety.recoveryRetentionDays).catch(() => {});
        }
      }
    });
  } catch (error) {
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
    "dryRun",
    "destructiveSync",
    "bandwidthLimit",
    "safety"
  ]) {
    fingerprint[field] = job[field] ?? null;
  }
  return JSON.stringify(fingerprint);
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
  const profile = await readProfile(paths);
  if (profile) {
    const normalized = buildJobFromProfile(profile, job);
    if (typeof job.id === "string" && job.id.trim()) {
      normalized.id = job.id.trim();
    }
    return normalized;
  }

  throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before saving or previewing sync jobs");
}

async function buildSyncRunPlan(job = {}) {
  const profile = await readProfile(paths);
  if (!profile) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before running sync jobs");
  }
  const tunnelUri = getTunnelUri(profile);
  if (!tunnelUri) {
    throw createHttpError("profile_not_imported", 409, "Import a server SyncKey before running sync jobs");
  }
  const normalizedJob = buildJobFromProfile(profile, job);
  normalizedJob.localPath = await validateSyncLocalPath(normalizedJob.localPath);
  return {
    normalizedJob,
    tunnelUri
  };
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

function makeHttpError(code, status) {
  return createHttpError(code, status);
}

function missingBinaryError(name, path, code) {
  return createHttpError(code, 503, `Missing bundled ${name}: ${path}`);
}

function openBrowser(url) {
  execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, () => {});
}
