import http from "node:http";
import net from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { requestSingboxRestart } from "./core/singboxControl.js";
import { checkApplianceHealth } from "./core/applianceHealth.js";
import { summarizeSetupReadiness } from "./core/setupReadiness.js";
import { acquireServerStateLock } from "./core/serverStateLock.js";
import { ensureMinioClaimAccess, removeMinioDeviceAccess, setMinioDeviceAccessEnabled } from "./minioProvisioner.js";
import { createSftpRelationServiceStartup } from "./service/relationServiceStartup.js";
import { createEnrollmentService } from "./service/enrollmentService.js";
import { createEnrollmentBootstrapGateway } from "./service/enrollmentBootstrapGateway.js";
import { createEnrollmentBootstrapIssuer, applyEnrollmentBootstrapOverlay } from "./service/enrollmentBootstrapIssuer.js";
import { createSharedDirectoryService } from "./service/sharedDirectoryService.js";
import { createEnrollmentDataAuthorization } from "./service/enrollmentDataAuthorization.js";
import { createEnrollmentRevocationService } from "./service/enrollmentRevocationService.js";
import { createEnrollmentReconfigureService } from "./service/enrollmentReconfigure.js";
import { createRealityTransportProbe } from "./service/realityTransportProbe.js";
import { openRelationServiceBindingCatalog } from "./service/relationServiceBindingCatalog.js";
import { createEnrollmentIdentityId } from "./core/enrollmentProtocol.js";
import {
  buildClientSingboxConfig,
  buildRclonePreview,
  buildSingboxServerConfig,
  buildRuntimeDiagnostics,
  assertJsonWriteContentType,
  computeNextRun,
  createHeartbeatSecret,
  autoFillTunnelConfig,
  createClaim,
  createSyncSpace,
  createHttpError,
  createManagedUser,
  createStorageBucket,
  deleteManagedUser,
  compactAdminState,
  markStorageBucketCleared,
  markSingboxApplied,
  normalizeSchedule,
  normalizeImportProfile,
  normalizeAdminState,
  normalizeProfileDefaults,
  encodeImportProfile,
  describeSchedule,
  extractClaimCode,
  parseVlessUri,
  recordDeviceHeartbeat,
  redeemClaim,
  revealAdminDeviceVlessUri,
  removeStorageBucket,
  replaceStorageBuckets,
  setManagedUserEnabled,
  setStorageBucketEnabled,
  maskSecret,
  summarizeAdminState,
  DEFAULT_STORAGE_SECRET_PLACEHOLDER,
  summarizeAdminSyncSpace,
  summarizeClaim,
  summarizeDevice,
  normalizeHttpError,
  PROFILE_VERSION,
  parseProtocolRequest,
  updateStorageConfig,
  updateTunnelConfig,
  PROTOCOL_REQUESTS,
  readJson,
  summarizeImportProfile
} from "./core/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const dataDir = process.env.SERVER_DATA_ROOT || join(root, "server", "data", "app");
const statePath = join(dataDir, "sfsc-state.json");
const singboxConfigPath = process.env.SINGBOX_CONFIG_PATH || join(root, "server", "sing-box", "config.json");
const singboxControlDir = process.env.SINGBOX_CONTROL_DIR || "";
const PLACEHOLDER_ADMIN_TOKENS = new Set(["change-this-admin-token"]);
// CORE-4: the storage secret placeholder must never survive into a production
// start. Compose now refuses to interpolate without MINIO_ROOT_PASSWORD, and
// this guard catches direct/manual launches that bypass compose.
const PLACEHOLDER_STORAGE_SECRETS = new Set([DEFAULT_STORAGE_SECRET_PLACEHOLDER]);
const CLAIM_REDEEM_AUDIT_UNAVAILABLE = "unavailable";
const CLAIM_REDEEM_FAILURE_LIMIT = Number(process.env.SFSC_CLAIM_REDEEM_FAILURE_LIMIT || 8);
const CLAIM_REDEEM_FAILURE_WINDOW_MS = Number(process.env.SFSC_CLAIM_REDEEM_FAILURE_WINDOW_MS || 10 * 60 * 1000);
const CLAIM_REDEEM_RATE_LIMIT_MS = Number(process.env.SFSC_CLAIM_REDEEM_RATE_LIMIT_MS || 10 * 60 * 1000);
// The heartbeat limiter is deliberately in-memory only, unlike the claim redeem
// limiter above. Persisting it would hand an attacker a way to convert every
// probe into a state-file write under the global write lock, which is exactly
// the amplification S-6 is about. Losing the counters on restart is fine: the
// limiter only throttles guessing, it is not the authentication boundary.
const HEARTBEAT_FAILURE_LIMIT = Number(process.env.SFSC_HEARTBEAT_FAILURE_LIMIT || 60);
const HEARTBEAT_FAILURE_WINDOW_MS = Number(process.env.SFSC_HEARTBEAT_FAILURE_WINDOW_MS || 5 * 60 * 1000);
const HEARTBEAT_RATE_LIMIT_MS = Number(process.env.SFSC_HEARTBEAT_RATE_LIMIT_MS || 5 * 60 * 1000);
const heartbeatFailureWindows = new Map();
// Storage bucket routes run their MinIO/S3 requests while holding the global
// admin-state write lock, so a single hung connection used to freeze every POST
// on the appliance (heartbeats included) until the socket died on its own. The
// bound matches the 15s timeout minioProvisioner already applies to mc calls.
const S3_REQUEST_TIMEOUT_MS = Number(process.env.SFSC_S3_TIMEOUT_MS || 15_000);
let adminToken;
let trustProxyConfig;

// createHttpError stores the human-readable detail on publicMessage and leaves
// error.message as the bare code; plain Errors carry the detail on message.
function startupErrorDetail(error) {
  return error?.publicMessage || error?.message || "";
}

try {
  adminToken = resolveAdminToken(process.env);
  trustProxyConfig = resolveTrustProxyConfig(process.env);
  assertStorageSecretNotPlaceholder(process.env);
  if (process.env.SFSC_STORAGE_MODE === "directory" && !String(process.env.SFSC_DIRECTORY_ROOT || "").trim()) {
    throw new Error("SFSC_DIRECTORY_ROOT is required when SFSC_STORAGE_MODE=directory");
  }
} catch (error) {
  console.error(`[sfsc] server_config_invalid: ${error.message}`);
  process.exit(1);
}
const appVersion = await readAppVersion();
const diagnostics = buildRuntimeDiagnostics({
  role: "server",
  version: appVersion
});
let releaseStateLock;
try {
  releaseStateLock = acquireServerStateLock({
    dataDir,
    statePath,
    staleAfterMs: Number(process.env.SFSC_STATE_LOCK_STALE_MS || 30_000),
    onStaleLock: (owner) => {
      console.warn(`[sfsc] server_state_stale_lock_removed: previous owner ${owner?.hostname || "unknown"}:${owner?.pid || "unknown"}`);
    },
    onLockLost: (error) => {
      // Another instance reclaimed our lock, so it is now the state writer.
      // Continuing would mean two processes writing sfsc-state.json.
      console.error(`[sfsc] server_state_lock_lost: ${error.message}`);
      process.exit(1);
    }
  });
} catch (error) {
  const normalized = normalizeHttpError(error, "server_error");
  // Startup failures are written to the operator's own stderr, not to a remote
  // caller, so log the unsanitized detail: the sanitized public message
  // deliberately drops the absolute state/config path this operator needs.
  // createHttpError keeps that detail on publicMessage (error.message is the
  // bare code); plain Errors carry it on message.
  console.error(`[sfsc] ${normalized.code}: ${startupErrorDetail(error) || normalized.message}`);
  process.exit(1);
}
let adminState;
try {
  adminState = await loadAdminState();
} catch (error) {
  const normalized = normalizeHttpError(error, "server_error");
  console.error(`[sfsc] ${normalized.code}: ${startupErrorDetail(error) || normalized.message}`);
  process.exit(1);
}
adminState.appVersion = appVersion;
adminState.diagnostics = diagnostics;
const enrollmentService = createEnrollmentService({
  statePath: join(dataDir, "sfsc-enrollment-state.json"),
  signerPath: join(dataDir, "sfsc-enrollment-signer.json"),
  catalogPath: join(dataDir, "relation-service", "catalog.json"),
  activeChannelRevision: process.env.SFSC_ENROLLMENT_CHANNEL_REVISION || "",
  allowedBootstrapOrigins: String(process.env.SFSC_ENROLLMENT_BOOTSTRAP_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean)
});
const enrollmentBootstrapIssuer = createEnrollmentBootstrapIssuer({
  registryPath: join(dataDir, "sfsc-enrollment-bootstrap-registry.json"),
  enrollmentService
});
const verifyRealityTransport = createRealityTransportProbe();
const sharedDirectoryService = createSharedDirectoryService({
  catalogPath: join(dataDir, "relation-service", "catalog.json"),
  directoryRoot: process.env.SFSC_STORAGE_MODE === "directory" ? process.env.SFSC_DIRECTORY_ROOT : undefined
});
const enrollmentBootstrapGateway = createEnrollmentBootstrapGateway({
  enrollmentService,
  host: "127.0.0.1",
  port: Number(process.env.SFSC_ENROLLMENT_BOOTSTRAP_PORT || 18082)
});
let adminStateWriteQueue = Promise.resolve();
let singboxConfigMutationQueue = Promise.resolve();
let enrollmentBootstrapGatewayAddress = null;
let enrollmentBootstrapIdentity = null;
let enrollmentDataAuthorization = null;
let enrollmentDataAuthorizationInit = null;
let activeRelationService = null;
let activeRelationCatalog = null;
let enrollmentRevocationService = null;
let revocationRecoveryBlocked = false;
const enrollmentReconfigureService = createEnrollmentReconfigureService({
  journalDir: join(dataDir, "sfsc-enrollment-reconfigure"),
  getTunnel: () => adminState.tunnel,
  setTunnel: tunnel => { adminState.tunnel = structuredClone(tunnel); },
  readConfig: async () => readFile(singboxConfigPath).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  }),
  writeConfig: async () => writeSingboxConfigFile(adminState),
  restoreConfig: bytes => writeFileAtomic(singboxConfigPath, bytes),
  saveAdminState,
  requestRestart: configSha256 => requestSingboxRestart({
    controlDir: singboxControlDir,
    expectedConfigSha256: configSha256
  }),
  markDataApplied: (configSha256, restartResult) => enrollmentDataAuthorization?.markApplied({
    expectedConfigSha256: configSha256,
    restartResult
  }),
  markBootstrapApplied: (tunnel, configSha256, restartResult) => {
    if (!enrollmentBootstrapGatewayAddress) {
      throw createHttpError("enrollment_channel_not_ready", 503, "Enrollment bootstrap gateway is unavailable");
    }
    return enrollmentBootstrapIssuer.markApplied({
      tunnel,
      gatewayPort: enrollmentBootstrapGatewayAddress.port,
      expectedConfigSha256: configSha256,
      restartResult
    });
  },
  markSingboxApplied: () => markSingboxApplied(adminState, { confirmMarkApplied: true }),
  verifyTransport: async ({ tunnel }) => {
    if (tunnel?.protocol !== "vless-reality-tcp") return;
    if (!enrollmentBootstrapGatewayAddress) {
      throw createHttpError("enrollment_channel_not_ready", 503, "Enrollment bootstrap gateway is unavailable");
    }
    const bootstrapUser = await enrollmentBootstrapIssuer.current({
      tunnel,
      gatewayPort: enrollmentBootstrapGatewayAddress.port
    });
    await verifyRealityTransport({
      tunnel,
      bootstrapUser,
      gatewayPort: enrollmentBootstrapGatewayAddress.port
    });
  },
  snapshotBootstrap: () => enrollmentBootstrapIssuer.snapshot(),
  restoreBootstrap: snapshot => enrollmentBootstrapIssuer.restoreSnapshot(snapshot),
  issueCode: ({ tunnel, configSha256, issuedAt, expiresAt, onIssued }) => {
    if (!enrollmentBootstrapGatewayAddress) {
      throw createHttpError("enrollment_channel_not_ready", 503, "Enrollment bootstrap gateway is unavailable");
    }
    return enrollmentBootstrapIssuer.issue({
      tunnel,
      gatewayPort: enrollmentBootstrapGatewayAddress.port,
      configSha256,
      issuedAt,
      expiresAt,
      onIssued
    });
  },
  isCurrentConfigApplied: async (tunnel, bytes) => {
    if (!enrollmentBootstrapGatewayAddress || !singboxControlDir || !tunnel?.id || !bytes) return false;
    try {
      const config = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return Boolean(config && Array.isArray(config.inbounds)
        && config.inbounds.some(inbound => inbound?.tag === "vless-in" && inbound.type === "vless"));
    } catch {
      return false;
    }
  },
  makeTargetTunnel: (currentTunnel, input) => {
    const shadow = structuredClone(adminState);
    shadow.tunnel = structuredClone(currentTunnel);
    updateTunnelConfig(shadow, {
      publicHost: input.publicHost ?? currentTunnel.publicHost,
      publicPort: input.publicPort ?? currentTunnel.publicPort
    });
    return shadow.tunnel;
  },
  summarizeState: () => summarizeAdminState(adminState)
});

const server = http.createServer(async (req, res) => {
  let adminStateSnapshot = null;
  let releaseAdminStateWriteLock = null;
  let releaseSingboxConfigMutationLock = null;
  let claimRedeemAudit = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "POST") {
      assertJsonWriteContentType(req);
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      const health = await checkApplianceHealth({
        dataDir,
        singboxControlDir,
        singboxHost: process.env.SINGBOX_PROBE_HOST,
        singboxPort: Number(process.env.SINGBOX_LISTEN_PORT || process.env.VLESS_PORT || 45678),
        rcloneBin: process.env.RCLONE_BIN,
        storageEndpoint: process.env.S3_ENDPOINT
      });
      const pendingRevocationRecovery = await isEnrollmentRevocationRecoveryPending();
      const ready = health.ok && !pendingRevocationRecovery;
      return json(res, {
        ...health,
        ok: ready,
        enrollmentRevocations: {
          ready: !pendingRevocationRecovery,
          pendingRecovery: pendingRevocationRecovery
        }
      }, ready ? 200 : 503);
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, {
        ok: true,
        app: "singbox-folder-sync",
        version: appVersion,
        diagnostics,
        mode: "server-admin",
        pathsConfigured: {
          serverDataRoot: Boolean(dataDir),
          singboxConfigPath: Boolean(singboxConfigPath)
        },
        architecture: {
          serverServices: ["sync-server", "sing-box", "minio"],
          clientKernel: "sing-box",
          syncEngine: "rclone",
          storageBackend: "MinIO/S3"
        },
        safeguards: {
          tun: false,
          systemProxy: false,
          routeMutation: false,
          muxDefault: false
        },
        serviceHealth: buildServiceHealthSummary(adminState),
        adminAuth: {
          enabled: Boolean(adminToken)
        }
      });
    }

    if (isAdminPath(url.pathname)) {
      assertAdminAuthorized(req);
    }
    if (shouldSerializeAdminStateWrite(req, url)) {
      releaseAdminStateWriteLock = await acquireAdminStateWriteLock();
    }
    if (shouldSerializeSingboxConfigMutation(req, url)) {
      releaseSingboxConfigMutationLock = await acquireSingboxConfigMutationLock();
    }
    if (shouldRollbackAdminStateOnError(req, url)) {
      adminStateSnapshot = structuredClone(adminState);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/enrollment/v1/requests") {
      return json(res, { requests: await enrollmentService.listRequests() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/enrollment/v1/relations") {
      if (!activeRelationCatalog) {
        try { await getEnrollmentDataAuthorization(); }
        catch (error) {
          if (error?.code !== "enrollment_catalog_not_ready"
            && error?.code !== "enrollment_data_authorization_denied") throw error;
        }
      }
      let catalog = activeRelationCatalog;
      if (!catalog) {
        try {
          catalog = await openRelationServiceBindingCatalog({
            path: join(dataDir, "relation-service", "catalog.json"),
            mode: "require-existing"
          });
        } catch (error) {
          const absent = error?.code === "relation_service_binding_catalog_missing"
            || (error?.code === "relation_service_binding_catalog_file_invalid" && error?.cause?.code === "ENOENT");
          if (!absent) throw error;
        }
      }
      if (!catalog) return json(res, { relations: [] });
      const snapshot = await catalog.read();
      const relations = Object.entries(snapshot.authority.relationGrants || {})
        .map(([relationId, grant]) => {
          const binding = grant.binding;
          const deviceId = binding.identity.deviceId;
          const device = snapshot.authority.devices[deviceId];
          const root = snapshot.roots[binding.identity.rootId];
          return {
            relationId,
            deviceId,
            rootId: binding.identity.rootId,
            directory: root?.canonicalRoot || "",
            status: grant.revokedAt !== null || device?.revokedAt !== null ? "revoked" : "active"
          };
        })
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId)
          || left.directory.localeCompare(right.directory)
          || left.relationId.localeCompare(right.relationId));
      return json(res, { relations });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/enrollment/v1/revocations") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_REVOKE, await readJson(req));
      const revocations = await getEnrollmentRevocationService();
      const result = await revocations.revoke(body);
      revocationRecoveryBlocked = await revocations.hasPending();
      return json(res, result, result.status === "complete" ? 200 : 503);
    }

    const enrollmentOperationMatch = url.pathname.match(/^\/api\/admin\/enrollment\/v1\/operations\/([^/]+)$/);
    if (req.method === "GET" && enrollmentOperationMatch) {
      const revocations = await getEnrollmentRevocationService();
      const result = await revocations.get(decodeURIComponent(enrollmentOperationMatch[1]));
      if (!result) throw createHttpError("enrollment_revocation_operation_not_found", 404, "Revocation operation does not exist");
      return json(res, result);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/enrollment/v1/directories") {
      return json(res, { directories: await sharedDirectoryService.list() });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/enrollment/v1/directories") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_DIRECTORY_REGISTER, await readJson(req));
      return json(res, { directory: await sharedDirectoryService.register(body) }, 201);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/enrollment/v1/trust") {
      const signer = await enrollmentService.getTrustMaterial();
      const origin = enrollmentBootstrapGatewayAddress
        ? `http://127.0.0.1:${enrollmentBootstrapGatewayAddress.port}`
        : "";
      if (!origin) {
        throw createHttpError("enrollment_channel_not_ready", 503, "Enrollment bootstrap origins are not configured");
      }
      const allowedBootstrapOrigins = [origin];
      enrollmentService.setAllowedBootstrapOrigins(allowedBootstrapOrigins);
      return json(res, { pin: {
        serverId: signer.serverId,
        keyId: signer.keyId,
        publicKey: signer.publicKey,
        allowedBootstrapOrigins,
        bootstrapPathPrefix: "/api/enrollment/v1"
      } });
    }

    const enrollmentReconfigureMatch = url.pathname.match(/^\/api\/admin\/enrollment\/v1\/reconfigure\/([^/]+)$/);
    if (req.method === "GET" && enrollmentReconfigureMatch) {
      return json(res, await enrollmentReconfigureService.get(decodeURIComponent(enrollmentReconfigureMatch[1])));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/enrollment/v1/reconfigure") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_RECONFIGURE, await readJson(req));
      // A caller may register a directory and invoke reconfigure directly,
      // without first reading setup readiness. Initialize the data overlay
      // writer here so the coordinator cannot issue a code with a skipped receipt.
      await getEnrollmentDataAuthorization();
      const result = await enrollmentReconfigureService.run(body);
      return json(res, result, result.stage === "applied" ? 202 : 200);
    }

    const enrollmentIssueMatch = url.pathname.match(/^\/api\/admin\/enrollment\/v1\/requests\/([^/]+)\/issue$/);
    if (req.method === "POST" && enrollmentIssueMatch) {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_ISSUE, await readJson(req));
      if (process.env.SFSC_STORAGE_MODE === "directory") {
        const directoryReadiness = await sharedDirectoryService.inspectActiveRoots();
        const selectedRootIds = body.rootIds || [body.rootId];
        if (selectedRootIds.some(rootId => !directoryReadiness.verifiedRootIds.includes(rootId))) {
          throw createHttpError("directory_root_input_invalid", 400, "Selected directory is outside the configured shared directory or is unavailable");
        }
      }
      return json(res, await enrollmentService.issueCode(decodeURIComponent(enrollmentIssueMatch[1]), body), 201);
    }

    if (req.method === "POST" && url.pathname === "/api/admin/enrollment/v1/channel-code") {
      parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_CHANNEL_CODE, await readJson(req));
      if (!enrollmentBootstrapGatewayAddress) throw createHttpError("enrollment_channel_not_ready", 503, "Enrollment bootstrap gateway is unavailable");
      if (!adminState.tunnel?.id || !adminState.tunnel?.lastAppliedAt || !singboxControlDir) {
        throw createHttpError("enrollment_channel_not_ready", 503, "Configure the VLESS tunnel and restart supervisor before issuing a channel");
      }
      adminState.tunnel.restartRequired = true;
      await saveAdminState();
      await writeSingboxConfigFile(adminState);
      await saveAdminState();
      const configBytes = await readFile(singboxConfigPath);
      const expectedConfigSha256 = createHash("sha256").update(configBytes).digest("hex");
      const restart = await requestSingboxRestart({ controlDir: singboxControlDir, expectedConfigSha256 });
      await enrollmentDataAuthorization?.markApplied({ expectedConfigSha256, restartResult: restart });
      await enrollmentBootstrapIssuer.markApplied({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        expectedConfigSha256,
        restartResult: restart
      });
      markSingboxApplied(adminState, { confirmMarkApplied: true });
      await saveAdminState();
      return json(res, await enrollmentBootstrapIssuer.issue({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        configSha256: expectedConfigSha256
      }), 201);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/auth/check") {
      return json(res, {
        ok: true,
        adminAuth: {
          enabled: Boolean(adminToken)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/state") {
      return json(res, summarizeAdminState(adminState));
    }

    // 首次运行就绪度单独成端点，不并入 /api/admin/state：它需要实时探针
    // （MinIO 健康端点带 1.5s 超时、sing-box 端口与 PID），而 summarizeAdminState
    // 是同步纯函数、被控制台高频轮询。合并会把网络 I/O 的延迟摊到每次状态刷新上。
    if (req.method === "GET" && url.pathname === "/api/admin/setup") {
      const health = await checkApplianceHealth({
        dataDir,
        singboxControlDir,
        singboxHost: process.env.SINGBOX_PROBE_HOST,
        singboxPort: Number(process.env.SINGBOX_LISTEN_PORT || process.env.VLESS_PORT || 45678),
        rcloneBin: process.env.RCLONE_BIN,
        storageEndpoint: process.env.S3_ENDPOINT
      }).catch(() => null);
      // S3 is an optional compatibility path. Ordinary first use is judged by
      // verified server roots, exact applied overlay receipts, and live grants.
      const enrollmentEvidence = await collectSetupEnrollmentEvidence();
      const summary = summarizeSetupReadiness(adminState, health, enrollmentEvidence);
      if (await isEnrollmentRevocationRecoveryPending()) {
        summary.ok = false;
        summary.ready = false;
        summary.enrollmentRevocations = { ready: false, pendingRecovery: true };
      } else {
        summary.enrollmentRevocations = { ready: true, pendingRecovery: false };
      }
      return json(res, summary);
    }

    const deviceVlessUriMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/vless-uri$/);
    if (req.method === "GET" && deviceVlessUriMatch) {
      return json(res, revealAdminDeviceVlessUri(adminState, decodeURIComponent(deviceVlessUriMatch[1])));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/tunnel/generate") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, await readJson(req));
      requireDangerFlag(body, {
        field: "confirmGenerateTunnel",
        action: "generate-tunnel"
      });
      updateTunnelConfig(adminState, body);
      const config = await saveAdminStateWithSingboxConfig();
      return json(res, {
        tunnel: summarizeAdminState(adminState).tunnel,
        config: maskSingboxConfig(config),
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/tunnel/autofill") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_AUTOFILL, await readJson(req));
      const autofillInput = !Object.hasOwn(body, "serverName") && process.env.REALITY_SERVER_NAME
        ? { ...body, serverName: process.env.REALITY_SERVER_NAME }
        : body;
      autoFillTunnelConfig(adminState, autofillInput);
      await saveAdminState();
      return json(res, {
        tunnel: summarizeAdminState(adminState).tunnel,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/save") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_SAVE, await readJson(req));
      updateStorageConfig(adminState, body);
      await saveAdminState();
      const state = summarizeAdminState(adminState);
      return json(res, {
        storage: state.storage,
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/sync-spaces/create") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SYNC_SPACE_CREATE, await readJson(req));
      const syncSpace = createSyncSpace(adminState, body);
      await saveAdminState();
      return json(res, {
        syncSpace: summarizeAdminSyncSpace(adminState, syncSpace),
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/refresh") {
      parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_REFRESH, await readJson(req));
      const result = await refreshMinioBuckets(adminState);
      await saveAdminState();
      return json(res, {
        ...result,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/create") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CREATE, await readJson(req));
      const bucket = createStorageBucket(adminState, body);
      const provision = await provisionMinioBucket(adminState, bucket.name);
      await saveAdminState();
      return json(res, {
        bucket,
        provision,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/enable") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_ENABLE, await readJson(req));
      const bucket = setStorageBucketEnabled(adminState, {
        bucket: body.bucket,
        enabled: true
      });
      await saveAdminState();
      return json(res, {
        bucket,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/disable") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DISABLE, await readJson(req));
      const bucket = setStorageBucketEnabled(adminState, {
        bucket: body.bucket,
        enabled: false
      });
      await saveAdminState();
      return json(res, {
        bucket,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/clear") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CLEAR, await readJson(req));
      const bucketName = normalizeBucketName(body.bucket);
      ensureStorageBucketActive(adminState, bucketName);
      requireDangerConfirmation(body, {
        expected: bucketName,
        action: "clear-bucket"
      });
      const result = await clearMinioBucket(adminState, bucketName);
      const bucket = markStorageBucketCleared(adminState, bucketName);
      await saveAdminState();
      return json(res, {
        ok: true,
        bucket,
        result,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/storage/buckets/delete-empty") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY, await readJson(req));
      const bucketName = normalizeBucketName(body.bucket);
      ensureStorageBucketActive(adminState, bucketName);
      requireDangerConfirmation(body, {
        expected: bucketName,
        action: "delete-bucket"
      });
      ensureStorageBucketCanBeRemoved(adminState, bucketName);
      const result = await deleteEmptyMinioBucket(adminState, bucketName);
      removeStorageBucket(adminState, { bucket: bucketName });
      await saveAdminState();
      const state = summarizeAdminState(adminState);
      return json(res, {
        ok: true,
        storage: state.storage,
        result,
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/create") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_CREATE, await readJson(req));
      const user = createManagedUser(adminState, body);
      const config = await saveAdminStateWithSingboxConfig();
      const state = summarizeAdminState(adminState);
      return json(res, {
        user: state.users.find((item) => item.id === user.id),
        config: maskSingboxConfig(config),
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/enable") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_ENABLE, await readJson(req));
      const user = setManagedUserEnabled(adminState, {
        userId: body.userId || body.id,
        enabled: true,
        confirmCompatibilityWarning: body.confirmCompatibilityWarning === true
      });
      await setMinioDeviceAccessEnabled(adminState, user.id, true, { dataDir });
      const config = await saveAdminStateWithSingboxConfig();
      const state = summarizeAdminState(adminState);
      return json(res, {
        user: state.users.find((item) => item.id === user.id),
        config: maskSingboxConfig(config),
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/disable") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DISABLE, await readJson(req));
      const user = setManagedUserEnabled(adminState, {
        userId: body.userId || body.id,
        enabled: false
      });
      await setMinioDeviceAccessEnabled(adminState, user.id, false, { dataDir });
      const config = await saveAdminStateWithSingboxConfig();
      const state = summarizeAdminState(adminState);
      return json(res, {
        user: state.users.find((item) => item.id === user.id),
        config: maskSingboxConfig(config),
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/delete") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DELETE, await readJson(req));
      const user = adminState.users.find((item) => item.id === (body.userId || body.id) && !item.deletedAt);
      if (!user) {
        throw createHttpError("user_not_found", 404, "User not found");
      }
      requireDangerConfirmation(body, {
        expected: user.clientName,
        action: "delete-device"
      });
      deleteManagedUser(adminState, { userId: user.id });
      await removeMinioDeviceAccess(adminState, user.id, { dataDir });
      const config = await saveAdminStateWithSingboxConfig();
      return json(res, {
        ok: true,
        deletedUserId: user.id,
        config: maskSingboxConfig(config),
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/singbox/config") {
      return json(res, {
        path: singboxConfigPath,
        config: maskSingboxConfig(await buildManagedSingboxConfig(adminState))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/singbox/write") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_WRITE, await readJson(req));
      requireDangerFlag(body, {
        field: "confirmWriteSingbox",
        action: "write-singbox-config"
      });
      adminState.tunnel.restartRequired = true;
      const config = await saveAdminStateWithSingboxConfig();
      const state = summarizeAdminState(adminState);
      return json(res, {
        path: singboxConfigPath,
        restartRequired: state.tunnel.restartRequired,
        config: maskSingboxConfig(config),
        state
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/singbox/mark-applied") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_MARK_APPLIED, await readJson(req));
      markSingboxApplied(adminState, {
        confirmMarkApplied: body.confirmMarkApplied === true
      });
      await saveAdminState();
      return json(res, {
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/singbox/apply") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_APPLY, await readJson(req));
      requireDangerFlag(body, {
        field: "confirmApplySingbox",
        action: "apply-singbox-config"
      });
      if (!adminState.tunnel.restartRequired) {
        throw createHttpError("validation_failed", 400, "No pending sing-box config change to apply");
      }
      // Once ordinary directories have been registered, initialize their
      // data-overlay writer before applying the first tunnel config. Without
      // this, the supervisor could accept the config while setup readiness
      // still lacks the data overlay receipt.
      try {
        await readFile(join(dataDir, "relation-service", "catalog.json"));
        await getEnrollmentDataAuthorization();
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await writeSingboxConfigFile(adminState);
      await saveAdminState();
      const configBytes = await readFile(singboxConfigPath);
      const expectedConfigSha256 = createHash("sha256").update(configBytes).digest("hex");
      const restart = await requestSingboxRestart({
        controlDir: singboxControlDir,
        expectedConfigSha256
      });
      await enrollmentDataAuthorization?.markApplied({ expectedConfigSha256, restartResult: restart });
      await enrollmentBootstrapIssuer.markApplied({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        expectedConfigSha256,
        restartResult: restart
      });
      markSingboxApplied(adminState, { confirmMarkApplied: true });
      await saveAdminState();
      return json(res, {
        restart,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/claims/create") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, await readJson(req));
      if (body.server) {
        adminState.settings.publicServerUrl = normalizeHttpUrl(body.server);
      }
      const result = createClaim(adminState, body);
      await ensureMinioClaimAccess(adminState, result.claim, { dataDir });
      await saveAdminStateWithSingboxConfig();
      return json(res, {
        code: result.claim.code,
        tKey: result.token,
        tKeyUri: result.uri,
        claimCode: result.token,
        uri: result.uri,
        claim: summarizeClaim(result.claim),
        profile: result.profile,
        compatibility: result.compatibility,
        state: summarizeAdminState(adminState)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/claims/redeem") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_REDEEM, await readJson(req));
      claimRedeemAudit = buildClaimRedeemAudit(req, body);
      assertClaimRedeemRateLimit(claimRedeemAudit);
      const profile = redeemClaim(adminState, body);
      clearClaimRedeemFailures(claimRedeemAudit);
      await saveAdminState();
      claimRedeemAudit = null;
      return json(res, profile);
    }

    if (req.method === "POST" && url.pathname === "/api/devices/heartbeat") {
      const heartbeatRemoteAddress = readRemoteAddress(req);
      assertHeartbeatRateLimit(heartbeatRemoteAddress);
      try {
        const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_DEVICE_HEARTBEAT, await readJson(req));
        const user = recordDeviceHeartbeat(adminState, {
          ...body,
          remoteAddress: req.socket.remoteAddress
        });
        await saveAdminState();
        clearHeartbeatFailures(heartbeatRemoteAddress);
        return json(res, {
          ok: true,
          diagnostics,
          device: summarizeDevice(adminState, user, { includeVlessUri: false })
        });
      } catch (error) {
        recordHeartbeatFailure(heartbeatRemoteAddress, error);
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/vless/parse") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_VLESS_PARSE, await readJson(req));
      const profile = parseVlessUri(body.uri);
      return json(res, { profile });
    }

    if (req.method === "POST" && url.pathname === "/api/singbox/client-config") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_SINGBOX_CLIENT_CONFIG, await readJson(req));
      const profile = parseVlessUri(body.uri);
      const config = buildClientSingboxConfig(profile, body.options || {});
      return json(res, { profile, config });
    }

    if (req.method === "POST" && url.pathname === "/api/profile/encode") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, await readJson(req));
      const profile = buildServerIssuedProfile(body);
      return json(res, {
        profile,
        summary: summarizeImportProfile(profile),
        code: encodeImportProfile(profile, { format: "code" }),
        uri: encodeImportProfile(profile, { format: "uri" })
      });
    }

    if (req.method === "POST" && url.pathname === "/api/jobs/preview") {
      const body = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW, await readJson(req));
      const profile = body.uri ? parseVlessUri(body.uri) : null;
      const singbox = profile ? buildClientSingboxConfig(profile, body.options || {}) : null;
      const rclone = buildRclonePreview(body.job || {}, body.options || {});
      const schedule = normalizeSchedule((body.job && body.job.schedule) || {});
      const nextRun = computeNextRun(schedule, new Date());
      const scheduleText = describeSchedule(schedule);
      return json(res, {
        profile,
        singbox,
        rclone,
        schedule: {
          text: scheduleText,
          nextRun: nextRun instanceof Date ? nextRun.toISOString() : nextRun
        }
      });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    jsonError(res, createHttpError("not_found", 404, "Not found"));
  } catch (error) {
    if (adminStateSnapshot) {
      adminState = adminStateSnapshot;
    }
    let responseError = error;
    if (claimRedeemAudit) {
      logClaimRedeemAudit(claimRedeemAudit, error);
      try {
        await recordClaimRedeemFailure(claimRedeemAudit, error);
      } catch (auditError) {
        responseError = auditError;
      }
    }
    jsonError(res, responseError);
  } finally {
    if (releaseSingboxConfigMutationLock) {
      releaseSingboxConfigMutationLock();
    }
    if (releaseAdminStateWriteLock) {
      releaseAdminStateWriteLock();
    }
  }
});

async function isEnrollmentRevocationRecoveryPending() {
  if (revocationRecoveryBlocked) return true;
  if (!enrollmentRevocationService) return false;
  try {
    const pending = await enrollmentRevocationService.hasPending();
    if (pending) revocationRecoveryBlocked = true;
    return pending;
  } catch {
    // Readiness fails closed when the persisted revocation journal cannot be read.
    revocationRecoveryBlocked = true;
    return true;
  }
}

// Older callers close the management listener directly. Keep that lifecycle
// compatible by closing the enrollment listener whenever the HTTP server closes.
server.once("close", () => {
  enrollmentBootstrapGateway.close().catch(error => {
    console.error(`[sfsc] enrollment_bootstrap_close_failed: ${error?.message || error}`);
  });
});

let activeRuntimeAdmission = null;

export async function main({
  env = process.env,
  startupAdmission = null,
  listen = null,
  readEpochIdentity = null,
  ownerGateFactory = null,
  relationCompositionFactory = null,
  // Product starts omit this test seam, so the V2 startup uses its fixed,
  // pinned package loader by default.
  relationRuntimePackageLoaderForTest = null
} = {}) {
  activeRelationService = null;
  activeRelationCatalog = null;
  enrollmentRevocationService = null;
  revocationRecoveryBlocked = false;
  await enrollmentService.initialize();
  if (env.SFSC_RUNTIME_ADMISSION_REQUIRED === "1") {
    const {
      admitStartup,
      readStartupEpochIdentity,
      startupAdmissionEnvironment
    } = await import("./service/startupAdmission.js");
    const admissionEnvironment = startupAdmissionEnvironment(env);
    const resolveEpochIdentity =
      readEpochIdentity || readStartupEpochIdentity;
    const containerId = admissionEnvironment.containerId
      || (await resolveEpochIdentity({
        epochRoot: admissionEnvironment.epochRoot
      })).containerId;
    const createOwnerStateSnapshotGate = ownerGateFactory
      || (await import("./service/ownerStateSnapshot.js"))
        .createOwnerStateSnapshotGate;
    const ownerGate = createOwnerStateSnapshotGate({
      artifactPath: join(
        root,
        "server",
        "runtime",
        "native",
        `${process.platform}-${process.arch}`,
        "sfsc_owner_lock.node"
      ),
      manifestPath: join(
        root,
        "server",
        "runtime",
        "native",
        `${process.platform}-${process.arch}`,
        "manifest.json"
      )
    });
    const relationStatePath = env.SFSC_RELATION_STATE_PATH
      || join(dataDir, "relation-services.json");
    const composeRelationService = relationCompositionFactory
      || createSftpRelationServiceStartup;
    const relationCompositionOptions = {
      root,
      managerStatePath: relationStatePath
    };
    if (relationRuntimePackageLoaderForTest) {
      relationCompositionOptions.runtimePackageLoader = relationRuntimePackageLoaderForTest;
    }
    const relationComposition = await composeRelationService(
      relationCompositionOptions
    );
    const admit = startupAdmission || admitStartup;
    activeRuntimeAdmission = await admit({
      epochRoot: admissionEnvironment.epochRoot,
      statePath: relationStatePath,
      ownerGate,
      containerId,
      bootstrapNonce: admissionEnvironment.bootstrapNonce,
      managerOptions: {
        withExclusiveLock: async (request, task) => {
          const release = acquireServerStateLock({
            dataDir: dirname(request.lockPath),
            statePath: request.statePath,
            lockPath: request.lockPath,
            onLockLost: (error) => {
              console.error(`[sfsc] relation_state_lock_lost: ${error.message}`);
              process.exit(1);
            }
          });
          try {
            return await task();
          } finally {
            release();
          }
        },
        runtime: relationComposition.runtime,
        protection: relationComposition.protection,
        runtimeTimeoutMs: 30_000,
        protectionTimeoutMs: 10_000
      }
    });
    activeRelationService = relationComposition.createFacade(
      activeRuntimeAdmission.manager
    );
    revocationRecoveryBlocked = true;
  }

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (listen) {
      listen(port, host);
    } else {
      server.listen(port, host);
    }
  });
  let bootstrapGatewayAddress;
  try {
    bootstrapGatewayAddress = await enrollmentBootstrapGateway.start();
    enrollmentBootstrapGatewayAddress = bootstrapGatewayAddress;
    enrollmentService.setAllowedBootstrapOrigins([`http://127.0.0.1:${bootstrapGatewayAddress.port}`]);
    enrollmentBootstrapIdentity = await enrollmentBootstrapIssuer.initialize({
      tunnel: adminState.tunnel,
      gatewayPort: bootstrapGatewayAddress.port
    });
    if (activeRelationService) {
      try {
        await getEnrollmentDataAuthorization();
      } catch (error) {
        if (error?.code !== "enrollment_catalog_not_ready") {
          revocationRecoveryBlocked = true;
          console.error(`[sfsc] enrollment_revocation_recovery_blocked: ${error?.code || "enrollment_data_authorization_init_failed"}`);
        }
      }
    }
    if (activeRelationService && activeRelationCatalog) {
      enrollmentRevocationService = createEnrollmentRevocationService({
        catalog: activeRelationCatalog,
        relationService: activeRelationService,
        applyOverlay: applyEnrollmentRevocationOverlay
      });
      try {
        await withAdminStateWrite(() => withSingboxConfigMutation(async () => {
          await enrollmentRevocationService.resumePending();
        }));
        revocationRecoveryBlocked = await enrollmentRevocationService.hasPending();
      } catch (error) {
        revocationRecoveryBlocked = true;
        console.error(`[sfsc] enrollment_revocation_recovery_blocked: ${error?.code || "enrollment_revocation_recovery_failed"}`);
      }
    } else {
      revocationRecoveryBlocked = false;
    }
    if (activeRelationService) enrollmentService.setDataAuthorizationProvider(async ({ deviceId, relationId }) => withAdminStateWrite(async () => withSingboxConfigMutation(async () => {
      if (revocationRecoveryBlocked || await enrollmentRevocationService?.hasPending()) {
        revocationRecoveryBlocked = true;
        throw createHttpError("enrollment_revocation_recovery_pending", 503, "Enrollment revocation recovery must finish before data authorization can continue");
      }
      const dataAuthorization = await getEnrollmentDataAuthorization();
      await dataAuthorization.materialize({ deviceId, relationId });
      const current = await activeRelationService.query({ relationId });
      if (!relationIsRunning(current)) {
        await activeRelationService.start({
          relationId,
            operationId: `rootop_${randomBytes(18).toString("base64url")}`,
          expectedHandleDigest: ""
        });
      }
      const running = await activeRelationService.query({ relationId });
      if (!relationIsRunning(running)) {
        throw createHttpError("enrollment_data_relation_not_ready", 503, "SFTP relation did not become ready");
      }
      if (!adminState.tunnel?.id || !adminState.tunnel?.lastAppliedAt || !singboxControlDir) {
        throw createHttpError("enrollment_data_channel_not_ready", 503, "Configure and apply the server VLESS tunnel before requesting directory authorization");
      }

      await writeSingboxConfigFile(adminState);
      await saveAdminState();
      const configBytes = await readFile(singboxConfigPath);
      const expectedConfigSha256 = createHash("sha256").update(configBytes).digest("hex");
      const bootstrapApplied = await enrollmentBootstrapIssuer.isApplied({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        configSha256: expectedConfigSha256
      });
      const dataOverlayApplied = await dataAuthorization.isApplied({ expectedConfigSha256 });
      if (adminState.tunnel.restartRequired === true || !bootstrapApplied || !dataOverlayApplied) {
        adminState.tunnel.restartRequired = true;
        await saveAdminState();
        const restart = await requestSingboxRestart({ controlDir: singboxControlDir, expectedConfigSha256 });
        await dataAuthorization.markApplied({ expectedConfigSha256, restartResult: restart });
        await enrollmentBootstrapIssuer.markApplied({
          tunnel: adminState.tunnel,
          gatewayPort: enrollmentBootstrapGatewayAddress.port,
          expectedConfigSha256,
          restartResult: restart
        });
        markSingboxApplied(adminState, { confirmMarkApplied: true });
        await saveAdminState();
      }
      return (await dataAuthorization.prepareDataAuthorization({ deviceId, relationId })).payload;
    })));
    enrollmentService.setChannelRenewalProvider(async ({ channelRevision }) => withSingboxConfigMutation(async () => {
      if (!enrollmentBootstrapGatewayAddress || !adminState.tunnel?.id || !adminState.tunnel?.lastAppliedAt) {
        throw createHttpError("enrollment_channel_not_ready", 503, "Configure and apply the server VLESS tunnel before renewing a channel");
      }
      const current = await enrollmentBootstrapIssuer.current({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port
      });
      if (current.channelRevision !== channelRevision) {
        throw createHttpError("enrollment_channel_stale", 409, "Requested channel revision is no longer current");
      }
      if (adminState.tunnel.restartRequired === true || !singboxControlDir) {
        throw createHttpError("enrollment_channel_not_ready", 503, "Apply the current server VLESS tunnel before renewing a channel");
      }
      const configBytes = await readFile(singboxConfigPath).catch(() => null);
      if (!configBytes) throw createHttpError("enrollment_channel_not_ready", 503, "Current sing-box config is unavailable for channel renewal");
      const configSha256 = createHash("sha256").update(configBytes).digest("hex");
      const applied = await enrollmentBootstrapIssuer.isApplied({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        configSha256
      });
      if (!applied) throw createHttpError("enrollment_channel_not_ready", 503, "Current bootstrap transport has not been applied");
      const issued = await enrollmentBootstrapIssuer.issue({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        configSha256
      });
      return { channelRevision: issued.channelRevision, wrappedCode: issued.wrappedCode };
    }));
  } catch (error) {
    await enrollmentBootstrapGateway.close().catch(() => {});
    await new Promise(resolveClose => server.close(() => resolveClose())).catch(() => {});
    enrollmentService.close();
    releaseStateLock?.();
    throw error;
  }
  console.log(`Syncraft server: http://${host}:${port}/`);
  if (!adminToken) {
    console.warn("[sfsc] admin_auth_disabled: management API is UNAUTHENTICATED (SFSC_ALLOW_NO_ADMIN_TOKEN). Never expose this beyond loopback.");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      console.warn(`[sfsc] admin_auth_disabled_non_loopback: HOST=${host} with no admin token exposes full management access on the network.`);
    }
  }
  return Object.freeze({
    server,
    runtimeAdmission: activeRuntimeAdmission,
    relationService: activeRelationService,
    bootstrapGatewayAddress,
    async close() {
      enrollmentDataAuthorization?.close();
      enrollmentDataAuthorization = null;
        activeRelationCatalog = null;
        enrollmentRevocationService = null;
      await enrollmentBootstrapGateway.close();
      if (server.listening) {
        await new Promise((resolveClose, rejectClose) => {
          server.close(error => error ? rejectClose(error) : resolveClose());
        });
      }
      enrollmentService.close();
      releaseStateLock?.();
    }
  });
}

async function getEnrollmentDataAuthorization() {
  if (!activeRelationService) {
    throw createHttpError("enrollment_data_authorization_denied", 503, "Relation service is unavailable");
  }
  if (enrollmentDataAuthorization) return enrollmentDataAuthorization;
  if (!enrollmentDataAuthorizationInit) {
    enrollmentDataAuthorizationInit = (async () => {
      let catalog;
      try {
        catalog = await openRelationServiceBindingCatalog({
          path: join(dataDir, "relation-service", "catalog.json"),
          mode: "require-existing"
        });
      } catch (error) {
        const absent = error?.code === "relation_service_binding_catalog_missing"
          || (error?.code === "relation_service_binding_catalog_file_invalid" && error?.cause?.code === "ENOENT");
        if (absent) throw createHttpError("enrollment_catalog_not_ready", 503, "Relation catalog is not ready for data authorization");
        throw error;
      }
      activeRelationCatalog = catalog;
      const authorizer = createEnrollmentDataAuthorization({
        catalog,
        enrollmentService,
        facade: activeRelationService,
        registryPath: join(dataDir, "sfsc-enrollment-data-registry.json"),
        authorizedKeysDir: join(dataDir, "relation-service", "authorized-keys"),
        getTunnel: () => adminState.tunnel,
        getBootstrapUuid: () => enrollmentBootstrapIdentity?.uuid,
        getCurrentConfigSha256: async () => createHash("sha256")
          .update(JSON.stringify(await buildManagedSingboxConfig(adminState), null, 2))
          .digest("hex")
      });
      try {
        await authorizer.initialize();
      } catch (error) {
        authorizer.close();
        throw error;
      }
      enrollmentDataAuthorization = authorizer;
      return authorizer;
    })();
  }
  try {
    return await enrollmentDataAuthorizationInit;
  } finally {
    enrollmentDataAuthorizationInit = null;
  }
}

async function getEnrollmentRevocationService() {
  if (!activeRelationService) {
    throw createHttpError("enrollment_revocation_not_ready", 503, "Relation service is unavailable");
  }
  if (!activeRelationCatalog) {
    try {
      await getEnrollmentDataAuthorization();
    } catch (error) {
      if (!activeRelationCatalog || error?.code === "enrollment_catalog_not_ready") {
        throw createHttpError("enrollment_revocation_not_ready", 503, "Enrollment relation catalog is not ready");
      }
    }
  }
  if (!enrollmentRevocationService) {
    enrollmentRevocationService = createEnrollmentRevocationService({
      catalog: activeRelationCatalog,
      relationService: activeRelationService,
      applyOverlay: applyEnrollmentRevocationOverlay
    });
  }
  return enrollmentRevocationService;
}

async function applyEnrollmentRevocationOverlay() {
  const dataAuthorization = await getEnrollmentDataAuthorization();
  if (!adminState.tunnel?.id || !adminState.tunnel?.lastAppliedAt
    || !singboxControlDir || !enrollmentBootstrapGatewayAddress) {
    throw createHttpError("enrollment_revocation_overlay_not_applied", 503, "The revoked data overlay cannot be applied until the enrollment channel is ready");
  }
  await writeSingboxConfigFile(adminState);
  await saveAdminState();
  const configBytes = await readFile(singboxConfigPath);
  const expectedConfigSha256 = createHash("sha256").update(configBytes).digest("hex");
  const bootstrapApplied = await enrollmentBootstrapIssuer.isApplied({
    tunnel: adminState.tunnel,
    gatewayPort: enrollmentBootstrapGatewayAddress.port,
    configSha256: expectedConfigSha256
  });
  const dataOverlayApplied = await dataAuthorization.isApplied({ expectedConfigSha256 });
  if (adminState.tunnel.restartRequired === true || !bootstrapApplied || !dataOverlayApplied) {
    adminState.tunnel.restartRequired = true;
    await saveAdminState();
    const restart = await requestSingboxRestart({ controlDir: singboxControlDir, expectedConfigSha256 });
    if (restart?.ok !== true || restart.configSha256 !== expectedConfigSha256) {
      throw createHttpError("enrollment_revocation_overlay_not_applied", 503, "The revoked data overlay restart was not confirmed");
    }
    await dataAuthorization.markApplied({ expectedConfigSha256, restartResult: restart });
    await enrollmentBootstrapIssuer.markApplied({
      tunnel: adminState.tunnel,
      gatewayPort: enrollmentBootstrapGatewayAddress.port,
      expectedConfigSha256,
      restartResult: restart
    });
    markSingboxApplied(adminState, { confirmMarkApplied: true });
    await saveAdminState();
  }
  if (!await dataAuthorization.isApplied({ expectedConfigSha256 })) {
    throw createHttpError("enrollment_revocation_overlay_not_applied", 503, "The revoked data overlay receipt is incomplete");
  }
  return { applied: true, configSha256: expectedConfigSha256 };
}

async function collectSetupEnrollmentEvidence() {
  const evidence = {
    directoryEvidenceAvailable: false,
    activeRootCount: 0,
    verifiedRootIds: [],
    unverifiedRootCount: 0,
    configDigestAvailable: false,
    bootstrapApplyReceipt: false,
    dataOverlayApplyReceipt: false,
    authorizationEvidenceAvailable: false,
    authorizedRelationRootIds: []
  };

  try {
    const roots = await sharedDirectoryService.inspectActiveRoots();
    evidence.directoryEvidenceAvailable = true;
    evidence.activeRootCount = roots.activeRootCount;
    evidence.verifiedRootIds = roots.verifiedRootIds;
    evidence.unverifiedRootCount = roots.unverifiedRootCount;
  } catch {
    // Unavailable catalog or filesystem state remains unverified.
  }

  let configBytes = null;
  try {
    configBytes = await readFile(singboxConfigPath);
    evidence.configDigestAvailable = configBytes.length > 0;
  } catch {
    // Missing or unreadable config cannot produce an applied receipt.
  }
  if (configBytes && evidence.configDigestAvailable && enrollmentBootstrapGatewayAddress) {
    const configSha256 = createHash("sha256").update(configBytes).digest("hex");
    try {
      evidence.bootstrapApplyReceipt = await enrollmentBootstrapIssuer.isApplied({
        tunnel: adminState.tunnel,
        gatewayPort: enrollmentBootstrapGatewayAddress.port,
        configSha256
      });
    } catch {
      evidence.bootstrapApplyReceipt = false;
    }
    try {
      // Keep GET /api/admin/setup read-only. Startup and the mutating reconfigure
      // path own authorizer initialization; an absent in-memory inspector is
      // reported as unverified until one of those paths initializes it.
      if (enrollmentDataAuthorization) {
        evidence.dataOverlayApplyReceipt = await enrollmentDataAuthorization.isApplied({ expectedConfigSha256: configSha256 });
      }
    } catch {
      evidence.dataOverlayApplyReceipt = false;
    }
  }

  try {
    const grants = await enrollmentService.listConsumedGrants();
    const verified = new Set(evidence.verifiedRootIds);
    evidence.authorizationEvidenceAvailable = true;
    evidence.authorizedRelationRootIds = grants.flatMap(grant => grant.bindings
      .map(binding => binding.identity.rootId)
      .filter(rootId => verified.has(rootId)));
  } catch {
    // A missing or invalid catalog is not evidence that devices are authorized.
  }
  return evidence;
}

if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const normalized = normalizeHttpError(error, "server_error");
    console.error(`[sfsc] ${normalized.code}: ${startupErrorDetail(error) || normalized.message}`);
    process.exitCode = 1;
  });
}

// E-2: served with every HTML document. Keep in sync with the client copy in
// client/src/clientServer.js.
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
    // See the client note: an encoded backslash is only a separator on Windows.
    if (decoded.includes("\\")) {
      return jsonError(res, createHttpError("invalid_path", 400, "Invalid path"));
    }
    fullPath = normalize(join(publicDir, decoded));
  } catch {
    return jsonError(res, createHttpError("invalid_path", 400, "Invalid path"));
  }
  if (!isPathInside(publicDir, fullPath)) {
    return jsonError(res, createHttpError("invalid_path", 400, "Invalid path"));
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
      // E-2: admin console CSP; see UI_CONTENT_SECURITY_POLICY. The console
      // renders untrusted admin-state strings (device names, remarks) via
      // innerHTML templates, so blocking foreign script/connect origins is the
      // backstop if an escaping bug slips in.
      headers["content-security-policy"] = UI_CONTENT_SECURITY_POLICY;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    jsonError(res, createHttpError("not_found", 404, "Not found"));
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

function json(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function jsonError(res, error) {
  const normalized = normalizeHttpError(error, "server_error");
  json(res, {
    ok: false,
    error: normalized.code,
    errorCode: normalized.code,
    message: normalized.message
  }, normalized.status);
}

function isAdminPath(pathname) {
  if (pathname.startsWith("/api/admin/")) {
    return true;
  }
  return [
    "/api/claims/create",
    "/api/vless/parse",
    "/api/singbox/client-config",
    "/api/profile/encode",
    "/api/jobs/preview"
  ].includes(pathname);
}

function shouldRollbackAdminStateOnError(req, url) {
  if (req.method !== "POST") {
    return false;
  }
  // Reconfiguration owns its recovery through the private operation journal.
  // Keep the admin write lock for serialization, but never restore a generic
  // whole-state snapshot after this coordinator may have applied the config.
  if (url.pathname === "/api/admin/enrollment/v1/reconfigure") {
    return false;
  }
  if (url.pathname === "/api/admin/enrollment/v1/revocations") {
    return false;
  }
  return url.pathname.startsWith("/api/admin/")
    || url.pathname === "/api/claims/create"
    || url.pathname === "/api/claims/redeem"
    || url.pathname === "/api/devices/heartbeat";
}

function shouldSerializeAdminStateWrite(req, url) {
  if (req.method === "POST" && [
    "/api/admin/enrollment/v1/reconfigure",
    "/api/admin/enrollment/v1/revocations"
  ].includes(url.pathname)) {
    return true;
  }
  return shouldRollbackAdminStateOnError(req, url);
}

async function acquireAdminStateWriteLock() {
  let releaseNext;
  const previous = adminStateWriteQueue;
  adminStateWriteQueue = new Promise((resolve) => {
    releaseNext = resolve;
  });
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext();
  };
}

async function withSingboxConfigMutation(task) {
  const release = await acquireSingboxConfigMutationLock();
  try {
    return await task();
  } finally {
    release();
  }
}

async function withAdminStateWrite(task) {
  const release = await acquireAdminStateWriteLock();
  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireSingboxConfigMutationLock() {
  const previous = singboxConfigMutationQueue;
  let releaseNext;
  singboxConfigMutationQueue = new Promise(resolve => { releaseNext = resolve; });
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext();
  };
}

function shouldSerializeSingboxConfigMutation(req, url) {
  if (url.pathname === "/api/admin/singbox/config" && req.method === "GET") return true;
  if (req.method !== "POST") return false;
  return url.pathname === "/api/admin/enrollment/v1/reconfigure"
    || url.pathname === "/api/admin/enrollment/v1/revocations"
    || url.pathname === "/api/admin/enrollment/v1/channel-code"
    || url.pathname === "/api/admin/tunnel/generate"
    || url.pathname === "/api/admin/tunnel/autofill"
    || url.pathname === "/api/admin/singbox/write"
    || url.pathname === "/api/admin/singbox/apply"
    || url.pathname === "/api/admin/singbox/mark-applied"
    || url.pathname === "/api/admin/users/create"
    || url.pathname === "/api/admin/users/enable"
    || url.pathname === "/api/admin/users/disable"
    || url.pathname === "/api/admin/users/delete"
    || url.pathname === "/api/claims/create";
}

// This summary is returned by the unauthenticated /api/health probe, so it is
// limited to liveness/readiness. Device and bucket counts used to be included
// here, which handed an unauthenticated observer the deployment's operational
// scale (how many devices exist, how many are online) for no functional gain:
// nothing consumed those fields. The admin console derives any counts it needs
// from the authenticated /api/admin/state, which already returns the full
// devices[] and storage.buckets[] lists.
function buildServiceHealthSummary(state) {
  const summary = summarizeAdminState(state);
  const restartRequired = Boolean(summary.tunnel?.restartRequired);
  return {
    ok: !restartRequired,
    apiReachable: true,
    restartRequired
  };
}

function assertAdminAuthorized(req) {
  if (!adminToken) {
    // No-auth mode is opt-in only (see resolveAdminToken) and is intended for
    // local development. The startup banner warns operators loudly.
    return;
  }
  const supplied = readAdminToken(req);
  if (!constantTimeEqual(supplied, adminToken)) {
    throw httpError("admin_auth_required", 401, "Admin token is required");
  }
}

function resolveAdminToken(env = {}) {
  const token = String(env.SFSC_ADMIN_TOKEN || env.ADMIN_TOKEN || "").trim();
  // Fail closed by default. Opt out only via explicit SFSC_ALLOW_NO_ADMIN_TOKEN=1
  // or SFSC_REQUIRE_ADMIN_TOKEN=0. SFSC_REQUIRE_ADMIN_TOKEN=1 always forces a token
  // (and wins over ALLOW), preserving production compose semantics.
  const requireFlag = String(env.SFSC_REQUIRE_ADMIN_TOKEN || "").trim();
  const forceRequire = requireFlag === "1";
  const forceAllow = !forceRequire && (requireFlag === "0" || isTruthyEnv(env.SFSC_ALLOW_NO_ADMIN_TOKEN));
  if (!token) {
    if (forceAllow) {
      return "";
    }
    throw new Error("SFSC_ADMIN_TOKEN or ADMIN_TOKEN is required. Set SFSC_ALLOW_NO_ADMIN_TOKEN=1 only for local no-auth development.");
  }
  if (PLACEHOLDER_ADMIN_TOKENS.has(token)) {
    throw new Error("SFSC_ADMIN_TOKEN must be changed from the placeholder before production startup.");
  }
  return token;
}

// Placeholder storage secrets are rejected under the same conditions that
// force an admin token (SFSC_REQUIRE_ADMIN_TOKEN=1, i.e. production compose):
// local no-auth development keeps working, production cannot boot with the
// well-known MinIO root password baked into old .env files.
function assertStorageSecretNotPlaceholder(env = {}) {
  if (String(env.SFSC_REQUIRE_ADMIN_TOKEN || "").trim() !== "1") {
    return;
  }
  const secret = String(env.S3_SECRET_ACCESS_KEY || env.MINIO_ROOT_PASSWORD || "").trim();
  if (PLACEHOLDER_STORAGE_SECRETS.has(secret)) {
    throw new Error("S3_SECRET_ACCESS_KEY / MINIO_ROOT_PASSWORD must be changed from the placeholder before production startup.");
  }
}

function resolveTrustProxyConfig(env = {}) {
  const enabled = isTruthyEnv(env.SFSC_TRUST_PROXY);
  if (!enabled) {
    return {
      enabled: false,
      exactIps: new Set(),
      ipv4Cidrs: []
    };
  }

  const entries = String(env.SFSC_TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const exactIps = new Set(["127.0.0.1", "::1"]);
  const ipv4Cidrs = [{ base: ipv4ToInt("127.0.0.0"), mask: cidrMask(8), raw: "127.0.0.0/8" }];

  for (const entry of entries) {
    if (entry.includes("/")) {
      ipv4Cidrs.push(parseIpv4Cidr(entry));
      continue;
    }
    const normalized = normalizeIpAddress(entry);
    if (!normalized) {
      throw new Error(`SFSC_TRUSTED_PROXY_IPS contains invalid IP address: ${entry}`);
    }
    exactIps.add(normalized);
  }

  return {
    enabled,
    exactIps,
    ipv4Cidrs
  };
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readAdminToken(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1].trim();
  }
  return String(req.headers["x-sfsc-admin-token"] || "").trim();
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildClaimRedeemAudit(req, body = {}) {
  return {
    codeHash: hashClaimRedeemAuditCode(body),
    remoteAddress: readRemoteAddress(req)
  };
}

function assertHeartbeatRateLimit(remoteAddress) {
  pruneHeartbeatFailureWindows(Date.now());
  const window = heartbeatFailureWindows.get(remoteAddress);
  if (window?.limitedUntil && window.limitedUntil > Date.now()) {
    throw httpError("heartbeat_rate_limited", 429, "Too many failed heartbeat attempts from this address; try again later");
  }
}

function recordHeartbeatFailure(remoteAddress, error) {
  const normalized = normalizeHttpError(error, "server_error");
  // device_disabled is excluded on purpose: a disabled device keeps heartbeating
  // on its normal interval, and the contract requires it to keep receiving 409
  // device_disabled so the client UI can show the disabled state. Counting it
  // would convert that documented behaviour into a 429 within minutes. 5xx are
  // the server's own failures, not evidence of guessing.
  if (normalized.code === "heartbeat_rate_limited" || normalized.code === "device_disabled" || normalized.status >= 500) {
    return;
  }
  const now = Date.now();
  pruneHeartbeatFailureWindows(now);
  const current = heartbeatFailureWindows.get(remoteAddress);
  const windowActive = Boolean(current?.resetAt && current.resetAt > now);
  const failures = windowActive ? current.failures + 1 : 1;
  heartbeatFailureWindows.set(remoteAddress, {
    failures,
    resetAt: windowActive ? current.resetAt : now + HEARTBEAT_FAILURE_WINDOW_MS,
    limitedUntil: failures >= HEARTBEAT_FAILURE_LIMIT
      ? now + HEARTBEAT_RATE_LIMIT_MS
      : (windowActive && current.limitedUntil) || 0
  });
}

function clearHeartbeatFailures(remoteAddress) {
  heartbeatFailureWindows.delete(remoteAddress);
}

function pruneHeartbeatFailureWindows(nowMs) {
  for (const [key, window] of heartbeatFailureWindows) {
    if ((window?.resetAt || 0) <= nowMs && (window?.limitedUntil || 0) <= nowMs) {
      heartbeatFailureWindows.delete(key);
    }
  }
}

function assertClaimRedeemRateLimit(audit = {}) {
  pruneClaimRedeemFailureWindows(Date.now());
  const key = claimRedeemFailureKey(audit);
  const window = adminState.claimRedeemFailures?.[key];
  if (window?.limitedUntil && window.limitedUntil > Date.now()) {
    throw httpError("claim_redeem_rate_limited", 429, "Too many failed SyncKey redemption attempts; try again later");
  }
}

async function recordClaimRedeemFailure(audit = {}, error) {
  const normalized = normalizeHttpError(error, "server_error");
  if (normalized.code === "claim_redeem_rate_limited" || normalized.status >= 500) {
    return;
  }

  const now = Date.now();
  const adminStateBeforeAudit = structuredClone(adminState);
  pruneClaimRedeemFailureWindows(now);
  const key = claimRedeemFailureKey(audit);
  const current = adminState.claimRedeemFailures?.[key];
  const resetAt = current?.resetAt && current.resetAt > now
    ? current.resetAt
    : now + CLAIM_REDEEM_FAILURE_WINDOW_MS;
  const failures = current?.resetAt && current.resetAt > now
    ? current.failures + 1
    : 1;
  adminState.claimRedeemFailures = {
    ...(adminState.claimRedeemFailures || {}),
    [key]: {
      failures,
      resetAt,
      limitedUntil: failures >= CLAIM_REDEEM_FAILURE_LIMIT ? now + CLAIM_REDEEM_RATE_LIMIT_MS : 0
    }
  };
  adminState.updatedAt = new Date(now).toISOString();
  try {
    await saveAdminState();
  } catch (writeError) {
    const writeFailure = normalizeHttpError(writeError, "server_error");
    console.warn(`[sfsc] claim_redeem_audit_persist_failed error=${writeFailure.code}`);
    adminState = adminStateBeforeAudit;
    throw httpError("server_state_write_failed", 500, "Failed to persist SyncKey redemption failure audit state");
  }
}

function clearClaimRedeemFailures(audit = {}) {
  if (!adminState.claimRedeemFailures) {
    return;
  }
  delete adminState.claimRedeemFailures[claimRedeemFailureKey(audit)];
}

function pruneClaimRedeemFailureWindows(now) {
  const windows = adminState.claimRedeemFailures || {};
  for (const [key, window] of Object.entries(windows)) {
    const expiry = Math.max(window.resetAt || 0, window.limitedUntil || 0);
    if (expiry <= now) {
      delete windows[key];
    }
  }
  adminState.claimRedeemFailures = windows;
}

function claimRedeemFailureKey(audit = {}) {
  // Intentionally keyed on the client address only. Including a per-code hash
  // would give every guessed code its own counter, so a brute-force attacker
  // rotating codes would never reach the failure limit.
  return String(audit.remoteAddress || CLAIM_REDEEM_AUDIT_UNAVAILABLE);
}

function hashClaimRedeemAuditCode(body = {}) {
  try {
    const code = extractClaimCode(body.code || body.tKey || body.tkey || body.claimCode || body.token || "");
    return createHash("sha256").update(code).digest("hex").slice(0, 16);
  } catch {
    return CLAIM_REDEEM_AUDIT_UNAVAILABLE;
  }
}

function readRemoteAddress(req) {
  const socketAddress = normalizeIpAddress(req.socket?.remoteAddress);
  if (trustProxyConfig?.enabled && isTrustedProxyAddress(socketAddress)) {
    const forwardedClientIp = readForwardedForClientIp(req.headers["x-forwarded-for"]);
    if (forwardedClientIp) {
      return forwardedClientIp;
    }
  }
  return socketAddress || CLAIM_REDEEM_AUDIT_UNAVAILABLE;
}

function readForwardedForClientIp(value) {
  const header = Array.isArray(value) ? value.join(",") : String(value || "");
  for (const part of header.split(",")) {
    const normalized = normalizeIpAddress(part);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeIpAddress(value) {
  let text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  if (text.toLowerCase().startsWith("::ffff:")) {
    text = text.slice(7);
  }
  return net.isIP(text) ? text.toLowerCase() : "";
}

function isTrustedProxyAddress(ip) {
  if (!ip) {
    return false;
  }
  if (trustProxyConfig.exactIps.has(ip)) {
    return true;
  }
  if (!net.isIPv4(ip)) {
    return false;
  }
  const value = ipv4ToInt(ip);
  return trustProxyConfig.ipv4Cidrs.some((range) => (value & range.mask) === (range.base & range.mask));
}

function parseIpv4Cidr(entry) {
  const [address, bitsText] = String(entry || "").split("/");
  const bits = Number(bitsText);
  if (!net.isIPv4(address) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`SFSC_TRUSTED_PROXY_IPS contains invalid IPv4 CIDR: ${entry}`);
  }
  return {
    base: ipv4ToInt(address),
    mask: cidrMask(bits),
    raw: entry
  };
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function cidrMask(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function logClaimRedeemAudit(audit, error) {
  const normalized = normalizeHttpError(error, "server_error");
  console.warn([
    "[sfsc] claim_redeem_audit",
    `status=${normalized.status}`,
    `error=${normalized.code}`,
    `codeHash=${audit.codeHash || CLAIM_REDEEM_AUDIT_UNAVAILABLE}`,
    `remote=${audit.remoteAddress || CLAIM_REDEEM_AUDIT_UNAVAILABLE}`
  ].join(" "));
}

function httpError(code, status, publicMessage = code) {
  return createHttpError(code, status, publicMessage);
}

function requireDangerConfirmation(body = {}, options = {}) {
  const expected = String(options.expected || "").trim();
  const actual = String(body.confirmBucket || body.confirmText || "").trim();
  if (!expected || actual !== expected) {
    throw httpError("danger_confirmation_required", 400, `Type ${expected} to confirm ${options.action || "dangerous action"}`);
  }
}

function requireDangerFlag(body = {}, options = {}) {
  if (body[options.field] !== true) {
    throw httpError("danger_confirmation_required", 400, `Confirm ${options.action || "dangerous action"}`);
  }
}

// Only the REALITY private key is masked here. Inbound user uuids are
// deliberately returned in full: docs/INTERFACE_CONTRACT.md requires the config
// preview to map state.users[] onto sing-box users by clientName/uuid, the admin
// state summary already exposes uuid, and the admin surface can reveal the whole
// VLESS URI via GET /api/admin/devices/{id}/vless-uri. All of those routes sit
// behind the admin token, so masking uuid in this one spot would break the
// documented contract without closing any unauthenticated exposure.
function maskSingboxConfig(config) {
  const masked = JSON.parse(JSON.stringify(config || {}));
  for (const inbound of masked.inbounds || []) {
    const reality = inbound?.tls?.reality;
    if (reality?.private_key) {
      reality.private_key = maskSecret(reality.private_key);
    }
  }
  return masked;
}

async function loadAdminState() {
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizeAdminState(JSON.parse(raw), process.env);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw createHttpError("server_state_corrupt", 500, `Server state file is not valid JSON: ${statePath}`);
      }
      throw error;
    }
    const state = normalizeAdminState({}, process.env);
    await mkdir(dataDir, { recursive: true });
    await writeJsonFileAtomic(statePath, state);
    return state;
  }
}

async function readAppVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

async function saveAdminState() {
  try {
    await mkdir(dataDir, { recursive: true });
    await maybeDelayStateWriteForTest();
    compactAdminState(adminState, adminStateCompactionOptions());
    await writeJsonFileAtomic(statePath, adminState);
  } catch (error) {
    throw createHttpError(
      "server_state_write_failed",
      500,
      `Failed to write server state: ${error.message}`
    );
  }
}

function adminStateCompactionOptions() {
  const nowMs = process.env.NODE_ENV === "test"
    ? Number(process.env.SFSC_TEST_ADMIN_COMPACT_NOW_MS || 0)
    : 0;
  return Number.isFinite(nowMs) && nowMs > 0 ? { nowMs } : {};
}

async function maybeDelayStateWriteForTest() {
  const delayMs = process.env.NODE_ENV === "test"
    ? Number(process.env.SFSC_TEST_STATE_WRITE_DELAY_MS || 0)
    : 0;
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5000)));
}

async function saveAdminStateWithSingboxConfig() {
  const previousConfig = await readExistingSingboxConfigFile();
  const config = await writeSingboxConfigFile(adminState);
  try {
    await saveAdminState();
  } catch (error) {
    await restoreSingboxConfigFile(previousConfig).catch((restoreError) => {
      error.restoreSingboxConfigFailed = restoreError.message;
    });
    throw error;
  }
  return config;
}

async function readExistingSingboxConfigFile() {
  try {
    return {
      exists: true,
      body: await readFile(singboxConfigPath)
    };
  } catch {
    return { exists: false, body: null };
  }
}

async function restoreSingboxConfigFile(previousConfig) {
  if (previousConfig.exists) {
    await writeFileAtomic(singboxConfigPath, previousConfig.body);
    return;
  }
  await rm(singboxConfigPath, { force: true });
}

async function writeJsonFileAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2), "utf8");
}

async function writeFileAtomic(file, body, encoding) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempFile, body, encoding ? { encoding, mode: 0o600 } : { mode: 0o600 });
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeSingboxConfigFile(state) {
  const config = await buildManagedSingboxConfig(state);
  try {
    await writeJsonFileAtomic(singboxConfigPath, config);
  } catch (error) {
    throw createHttpError(
      "server_singbox_config_write_failed",
      500,
      `Failed to write server sing-box config: ${error.message}`
    );
  }
  state.tunnel.lastConfigWrittenAt = new Date().toISOString();
  return config;
}

async function buildManagedSingboxConfig(state) {
  if (!enrollmentBootstrapGatewayAddress) return buildSingboxServerConfig(state);
  enrollmentBootstrapIdentity = await enrollmentBootstrapIssuer.current({
    tunnel: state.tunnel,
    gatewayPort: enrollmentBootstrapGatewayAddress.port
  });
  let config = applyEnrollmentBootstrapOverlay(buildSingboxServerConfig(state), {
    bootstrapUser: enrollmentBootstrapIdentity,
    gatewayPort: enrollmentBootstrapGatewayAddress.port
  });
  if (enrollmentDataAuthorization) config = await enrollmentDataAuthorization.applyOverlay(config);
  return config;
}

function relationIsRunning(value) {
  return value?.state === "running" || value?.status === "running" || value?.relation?.state === "running";
}

async function refreshMinioBuckets(state) {
  try {
    const xml = await s3RequestWithFallback(state, "GET", "/");
    const buckets = parseBucketListXml(xml).map((bucket) => ({
      ...bucket,
      source: "minio"
    }));
    replaceStorageBuckets(state, buckets);
    return { ok: true, buckets: state.storage.buckets || [] };
  } catch (error) {
    return {
      ok: false,
      errorCode: "storage_request_failed",
      warning: error.message,
      buckets: state.storage.buckets || []
    };
  }
}

async function provisionMinioBucket(state, bucketName) {
  try {
    await s3RequestWithFallback(state, "PUT", `/${encodeURIComponent(bucketName)}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errorCode: "storage_request_failed",
      warning: error.message
    };
  }
}

async function clearMinioBucket(state, bucketName) {
  let deleted = 0;
  let rounds = 0;
  while (rounds < 100) {
    rounds += 1;
    const listed = await listMinioObjects(state, bucketName);
    if (!listed.objects.length) {
      return { deleted, rounds };
    }
    for (const chunk of chunkArray(listed.objects, 20)) {
      await Promise.all(chunk.map((object) => deleteMinioObject(state, bucketName, object.key)));
      deleted += chunk.length;
    }
  }
  throw new Error("Bucket clear stopped after too many pages");
}

async function deleteEmptyMinioBucket(state, bucketName) {
  const listed = await listMinioObjects(state, bucketName, { maxKeys: 1 });
  if (listed.objects.length) {
    throw createHttpError("bucket_not_empty", 409, "Bucket is not empty; clear data before deleting it");
  }
  await s3RequestWithFallback(state, "DELETE", `/${encodeURIComponent(bucketName)}`);
  return { deletedBucket: bucketName };
}

async function listMinioObjects(state, bucketName, options = {}) {
  const maxKeys = Number(options.maxKeys || 1000);
  const objects = [];
  let continuationToken = "";
  let isTruncated = true;
  let pages = 0;

  while (isTruncated && pages < 20) {
    pages += 1;
    const query = buildS3Query({
      "list-type": "2",
      "max-keys": String(maxKeys),
      ...(continuationToken ? { "continuation-token": continuationToken } : {})
    });
    const xml = await s3RequestWithFallback(state, "GET", `/${encodeURIComponent(bucketName)}?${query}`);
    const page = parseObjectListXml(xml);
    objects.push(...page.objects);
    isTruncated = page.isTruncated && objects.length < maxKeys;
    continuationToken = page.nextContinuationToken || "";
  }

  return { objects, pages };
}

async function deleteMinioObject(state, bucketName, key) {
  await s3RequestWithFallback(state, "DELETE", `/${encodeURIComponent(bucketName)}/${encodeS3Key(key)}`);
}

async function s3RequestWithFallback(state, method, path) {
  const endpoint = state.storage.internalEndpoint;
  if (!endpoint) {
    throw new Error("Internal S3 endpoint is not configured");
  }
  try {
    return await signedS3Request({
      endpoint,
      method,
      path,
      accessKeyId: state.storage.accessKeyId,
      secretAccessKey: state.storage.secretAccessKey
    });
  } catch (error) {
    // Keep the endpoint in the server-side error chain for operators, but mark a
    // stable code so normalizeHttpError returns a sanitized public message
    // instead of echoing the internal MinIO/S3 host back to the caller.
    const wrapped = new Error(`${endpoint}: ${error.message}`);
    wrapped.code = "storage_request_failed";
    wrapped.cause = error;
    throw wrapped;
  }
}

async function signedS3Request({ endpoint, method, path, accessKeyId, secretAccessKey }) {
  const endpointUrl = new URL(endpoint);
  const target = new URL(path, endpointUrl);
  const payloadHash = sha256Hex("");
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const region = "us-east-1";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalHeaders = [
    `host:${target.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    ""
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    target.pathname,
    canonicalS3Query(target.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(", ");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), S3_REQUEST_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetch(target, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization,
        host: target.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate
      }
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`MinIO ${method} ${path} timed out after ${S3_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`MinIO ${method} ${path} failed: ${response.status} ${text.slice(0, 160)}`);
  }
  return text;
}

function parseBucketListXml(xml) {
  const buckets = [];
  const bucketBlocks = String(xml || "").match(/<Bucket>[\s\S]*?<\/Bucket>/g) || [];
  for (const block of bucketBlocks) {
    const name = readXmlTag(block, "Name");
    if (!name) continue;
    buckets.push({
      name,
      createdAt: readXmlTag(block, "CreationDate") || null
    });
  }
  return buckets;
}

function parseObjectListXml(xml) {
  const objects = [];
  const objectBlocks = String(xml || "").match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
  for (const block of objectBlocks) {
    const key = readXmlTag(block, "Key");
    if (!key) continue;
    objects.push({
      key,
      size: Number(readXmlTag(block, "Size") || 0)
    });
  }
  return {
    objects,
    isTruncated: readXmlTag(xml, "IsTruncated") === "true",
    nextContinuationToken: readXmlTag(xml, "NextContinuationToken")
  };
}

function readXmlTag(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`));
  return match ? decodeXml(match[1]) : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeS3Key(key) {
  return String(key || "").split("/").map((part) => encodeURIComponent(part)).join("/");
}

function buildS3Query(params) {
  return canonicalS3Query(new URLSearchParams(params));
}

function canonicalS3Query(searchParams) {
  return Array.from(searchParams.entries())
    .map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }
      return leftKey.localeCompare(rightKey);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function awsUriEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeBucketName(input) {
  const text = String(input || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text) || text.includes("..")) {
    throw new Error("Bucket name must be a valid lowercase S3 bucket name");
  }
  return text;
}

function ensureStorageBucketCanBeRemoved(state, bucketName) {
  const bucket = ensureStorageBucketActive(state, bucketName);
  const buckets = Array.isArray(state.storage.buckets) ? state.storage.buckets : [];
  const remaining = buckets.filter((item) => item.name !== bucketName);
  if (!remaining.length) {
    throw createHttpError("last_bucket_delete_blocked", 409, "Cannot delete the last storage bucket");
  }
  if (!bucket.disabledAt && !remaining.some((item) => !item.disabledAt)) {
    throw createHttpError("last_active_bucket_disable_blocked", 409, "Cannot delete the last active storage bucket");
  }
  return bucket;
}

function ensureStorageBucketActive(state, bucketName) {
  const buckets = Array.isArray(state.storage.buckets) ? state.storage.buckets : [];
  const bucket = buckets.find((item) => item.name === bucketName);
  if (!bucket) {
    throw createHttpError("bucket_not_found", 404, "Storage bucket not found");
  }
  if (bucket.disabledAt) {
    throw createHttpError("bucket_disabled", 409, "Storage bucket is disabled");
  }
  return bucket;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function normalizeHttpUrl(input) {
  const url = new URL(String(input || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Server URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function buildServerIssuedProfile(body = {}) {
  const clientName = body.clientName || "company-pc1";
  const vlessUri = body.vlessUri || body.uri;
  if (!vlessUri) {
    throw createHttpError("profile_tunnel_required", 400, "Profile tunnel.uri is required");
  }
  const defaults = normalizeProfileDefaults(adminState.defaults || {}, body.defaults);
  const defaultValue = (key, fallback) => {
    if (Object.hasOwn(body, key)) return body[key];
    if (Object.hasOwn(defaults, key)) return defaults[key];
    return fallback;
  };
  const storageDefaults = adminState.storage || {};

  return normalizeImportProfile({
    version: PROFILE_VERSION,
    profileId: body.profileId || `profile-${clientName}-${randomBytes(4).toString("hex")}`,
    clientName,
    issuedAt: new Date().toISOString(),
    expiresAt: body.expiresAt || null,
    source: {
      type: "profile",
      server: normalizeHttpUrl(body.server || adminState.settings?.publicServerUrl || DEFAULTS.publicServerUrl)
    },
    tunnel: {
      type: "vless",
      uri: vlessUri
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: firstNonEmptyBodyStringOrDefault(body, [
        ["heartbeat", "secret"],
        ["heartbeatSecret"]
      ], createHeartbeatSecret())
    },
    storage: {
      type: "s3",
      remoteName: bodyStringOrDefault(body, "remoteName", storageDefaults.remoteName || "home-minio"),
      endpoint: bodyStringOrDefault(body, "endpoint", storageDefaults.endpoint || "http://minio:9000"),
      bucket: bodyStringOrDefault(body, "bucket", storageDefaults.bucket || "home-sync"),
      accessKeyId: bodyStringOrDefault(body, "accessKeyId", storageDefaults.accessKeyId || clientName),
      secretAccessKey: bodyStringOrDefault(body, "secretAccessKey", randomBytes(24).toString("base64url")),
      prefix: bodyStringOrDefault(body, "prefix", `${storageDefaults.prefixRoot || "devices"}/${clientName}`)
    },
    defaults: {
      localProxyPort: defaultValue("localProxyPort", adminState.defaults?.localProxyPort || 18081),
      transfers: defaultValue("transfers", adminState.defaults?.transfers || 4),
      streams: defaultValue("streams", adminState.defaults?.streams || 8),
      checkers: defaultValue("checkers", adminState.defaults?.checkers || 8),
      chunkSize: defaultValue("chunkSize", adminState.defaults?.chunkSize || "16M"),
      retries: defaultValue("retries", adminState.defaults?.retries || 3),
      lowLevelRetries: defaultValue("lowLevelRetries", adminState.defaults?.lowLevelRetries || 10),
      bandwidthLimit: defaultValue("bandwidthLimit", "off"),
      schedule: defaultValue("schedule", { mode: "manual" })
    }
  });
}

function bodyStringOrDefault(body, field, fallback) {
  if (!Object.hasOwn(body, field)) {
    return fallback;
  }
  if (typeof body[field] !== "string" || !body[field].trim()) {
    throw createHttpError("validation_failed", 400, `${field} must be a non-empty string`);
  }
  return body[field].trim();
}

function firstNonEmptyBodyStringOrDefault(body, paths, fallback) {
  for (const [field, nestedField] of paths) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    if (nestedField) {
      const container = body[field];
      if (!Object.hasOwn(container, nestedField)) {
        continue;
      }
      if (typeof container[nestedField] !== "string" || !container[nestedField].trim()) {
        throw createHttpError("validation_failed", 400, `${field}.${nestedField} must be a non-empty string`);
      }
      return container[nestedField].trim();
    }
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw createHttpError("validation_failed", 400, `${field} must be a non-empty string`);
    }
    return body[field].trim();
  }
  return fallback;
}
