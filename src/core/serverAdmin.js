import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeBandwidthLimit } from "./bandwidth.js";
import { CLAIM_CODE_ALPHABET, encodeClaimToken, extractClaimCode, normalizeClaimServer } from "./claimProtocol.js";
import { ADMIN_STATE_VERSION, buildRuntimeDiagnostics, compareRuntimeDiagnostics, normalizeRuntimeDiagnostics } from "./diagnostics.js";
import { HEARTBEAT_AUTH_MAX_SKEW_MS, createHeartbeatSecret, verifyHeartbeatAuth } from "./heartbeatAuth.js";
import { normalizeSchedule } from "./scheduler.js";
import { normalizeDeviceSync, summarizeDeviceSync } from "./syncRun.js";
import { isUuid, parseVlessUri } from "./vless.js";
import { createHttpError } from "./errors.js";
import { PROFILE_VERSION } from "./profileProtocol.js";
import { sanitizeRemoteName } from "./storage.js";
import {
  PRIVATE_SYNC_SPACE_MODE,
  deriveAuthorization,
  deriveSyncDirections,
  normalizeSyncSpaceMode,
  requireSyncSpaceMode
} from "./syncSpaceMode.js";

// 出厂占位口令。它同时是「管理员还没配过存储」的判定依据（见 setupReadiness.js），
// 和生产启动的 fail-closed 门槛（见 server.js 的 PLACEHOLDER_STORAGE_SECRETS）。
// 两处必须引用同一个常量：各写一份字面量就会改一处漏一处，而漏掉的那处要么放行
// 出厂口令上生产，要么把未配置的部署报成已就绪。
export const DEFAULT_STORAGE_SECRET_PLACEHOLDER = "change-this-minio-root-password";
export const DEFAULT_REALITY_SERVER_NAME = "www.apple.com";
const LEGACY_REALITY_DEFAULT_SERVER_NAME = "www.microsoft.com";

const DEFAULTS = {
  publicServerUrl: "https://pass.971223.xyz:2025",
  vlessPublicHost: "pass.971223.xyz",
  vlessPublicPort: 45678,
  vlessListenPort: 45678,
  s3Endpoint: "http://minio:9000",
  s3Bucket: "home-sync",
  s3RemoteName: "home-minio",
  localProxyPort: 18081
};
const CLAIM_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const EXPIRED_UNUSED_CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELETED_USER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function hasInputField(input, field) {
  return Object.hasOwn(input, field);
}

function inputFieldOrDefault(input, field, fallback) {
  return hasInputField(input, field) ? input[field] : fallback;
}

function firstInputFieldOrDefault(input, fields, fallback) {
  for (const field of fields) {
    if (hasInputField(input, field)) {
      return input[field];
    }
  }
  return fallback;
}

function hasAnyInputField(input, fields) {
  return fields.some((field) => hasInputField(input, field));
}

export function createDefaultAdminState(env = {}) {
  const now = new Date().toISOString();
  return {
    version: ADMIN_STATE_VERSION,
    updatedAt: now,
    settings: {
      publicServerUrl: cleanClaimServerOrigin(env.PUBLIC_SERVER_URL || env.CLAIM_SERVER_URL || DEFAULTS.publicServerUrl)
    },
    tunnel: {
      id: "vless-main",
      name: "N1 VLESS",
      protocol: "vless-tcp-none",
      listenHost: "0.0.0.0",
      listenPort: readPort(env.VLESS_LISTEN_PORT || env.VLESS_INTERNAL_PORT || env.VLESS_PORT || DEFAULTS.vlessListenPort),
      publicHost: cleanHost(env.VLESS_PUBLIC_HOST || env.PUBLIC_HOST || DEFAULTS.vlessPublicHost),
      publicPort: readPort(env.VLESS_PUBLIC_PORT || env.VLESS_PORT || DEFAULTS.vlessPublicPort),
      security: "none",
      transport: "tcp",
      transportPath: "",
      remark: "sfsc-home",
      reality: {
        serverName: env.REALITY_SERVER_NAME || DEFAULT_REALITY_SERVER_NAME,
        fingerprint: env.REALITY_FINGERPRINT || "chrome",
        publicKey: env.REALITY_PUBLIC_KEY || "",
        privateKey: env.REALITY_PRIVATE_KEY || "",
        shortId: env.REALITY_SHORT_ID || ""
      },
      lastConfigWrittenAt: null,
      lastAppliedAt: null,
      restartRequired: false
    },
    storage: {
      id: "home-minio",
      type: "s3",
      name: "Home MinIO",
      remoteName: cleanRemoteName(env.S3_REMOTE_NAME || DEFAULTS.s3RemoteName),
      endpoint: cleanUrl(env.S3_CLIENT_ENDPOINT || env.S3_ENDPOINT || DEFAULTS.s3Endpoint),
      internalEndpoint: cleanUrl(env.S3_ENDPOINT || DEFAULTS.s3Endpoint),
      bucket: cleanBucket(env.S3_BUCKET || DEFAULTS.s3Bucket),
      accessKeyMode: "shared",
      accessKeyId: String(env.S3_ACCESS_KEY_ID || env.MINIO_ROOT_USER || "syncadmin"),
      secretAccessKey: String(env.S3_SECRET_ACCESS_KEY || env.MINIO_ROOT_PASSWORD || DEFAULT_STORAGE_SECRET_PLACEHOLDER),
      prefixRoot: "devices",
      sharedPrefix: "shared",
      buckets: [
        {
          name: cleanBucket(env.S3_BUCKET || DEFAULTS.s3Bucket),
          createdAt: now,
          source: "configured"
        }
      ]
    },
    defaults: {
      localProxyPort: readPort(env.LOCAL_PROXY_PORT || DEFAULTS.localProxyPort),
      transfers: readPositiveInteger(env.RCLONE_TRANSFERS, 4),
      streams: readPositiveInteger(env.RCLONE_STREAMS, 8),
      checkers: readPositiveInteger(env.RCLONE_CHECKERS, 8),
      chunkSize: env.RCLONE_CHUNK_SIZE || "16M",
      retries: readPositiveInteger(env.RCLONE_RETRIES, 3),
      lowLevelRetries: readPositiveInteger(env.RCLONE_LOW_LEVEL_RETRIES, 10),
      bandwidthLimit: normalizeBandwidthLimit(env.RCLONE_BANDWIDTH_LIMIT || "off"),
      schedule: { mode: "manual" }
    },
    users: [],
    syncSpaces: [],
    syncSpaceMemberships: [],
    claims: [],
    claimRedeemFailures: {}
  };
}

export function normalizeAdminState(input = {}, env = {}) {
  const inputVersion = input.version == null ? ADMIN_STATE_VERSION : input.version;
  if (!Number.isInteger(inputVersion) || inputVersion < 1 || inputVersion > ADMIN_STATE_VERSION) {
    throw createHttpError("server_state_corrupt", 500, "Server state version is unsupported");
  }
  const fallback = createDefaultAdminState(env);
  const state = {
    ...fallback,
    ...input,
    settings: { ...fallback.settings, ...(input.settings || {}) },
    tunnel: { ...fallback.tunnel, ...(input.tunnel || {}) },
    storage: { ...fallback.storage, ...(input.storage || {}) },
    defaults: { ...fallback.defaults, ...(input.defaults || {}) },
    users: Array.isArray(input.users) ? input.users : [],
    syncSpaces: Array.isArray(input.syncSpaces) ? input.syncSpaces : [],
    syncSpaceMemberships: Array.isArray(input.syncSpaceMemberships) ? input.syncSpaceMemberships : [],
    claims: Array.isArray(input.claims) ? input.claims : [],
    claimRedeemFailures: normalizeClaimRedeemFailures(input.claimRedeemFailures)
  };
  state.version = ADMIN_STATE_VERSION;

  state.settings.publicServerUrl = cleanClaimServerOrigin(state.settings.publicServerUrl);
  state.tunnel.listenPort = readPort(state.tunnel.listenPort);
  state.tunnel.publicPort = readPort(state.tunnel.publicPort);
  state.tunnel.publicHost = cleanHost(state.tunnel.publicHost);
  state.storage.remoteName = cleanRemoteName(state.storage.remoteName);
  state.storage.endpoint = cleanUrl(state.storage.endpoint);
  const configuredInternalEndpoint = env.S3_ENDPOINT ? cleanUrl(env.S3_ENDPOINT) : "";
  state.storage.internalEndpoint = configuredInternalEndpoint
    || cleanUrl(state.storage.internalEndpoint || state.storage.endpoint);
  const configuredClientEndpoint = env.S3_CLIENT_ENDPOINT ? cleanUrl(env.S3_CLIENT_ENDPOINT) : "";
  if (configuredClientEndpoint && state.storage.endpoint === state.storage.internalEndpoint) {
    state.storage.endpoint = configuredClientEndpoint;
  }
  state.storage.bucket = cleanBucket(state.storage.bucket);
  state.storage.accessKeyMode = normalizeStorageAccessKeyMode(state.storage.accessKeyMode);
  state.storage.buckets = normalizeBuckets(state.storage.buckets, state.storage.bucket);
  state.users = normalizeAdminUsers(state.users, state);
  ({ syncSpaces: state.syncSpaces, memberships: state.syncSpaceMemberships } = normalizeSyncSpaceState(
    state.syncSpaces,
    state.syncSpaceMemberships,
    state.users
  ));
  state.defaults.localProxyPort = readPort(state.defaults.localProxyPort);
  state.defaults.transfers = readPositiveInteger(state.defaults.transfers, fallback.defaults.transfers);
  state.defaults.streams = readPositiveInteger(state.defaults.streams, fallback.defaults.streams);
  state.defaults.checkers = readPositiveInteger(state.defaults.checkers, fallback.defaults.checkers);
  state.defaults.chunkSize = typeof state.defaults.chunkSize === "string" && state.defaults.chunkSize.trim()
    ? state.defaults.chunkSize.trim()
    : fallback.defaults.chunkSize;
  state.defaults.retries = readPositiveInteger(state.defaults.retries, fallback.defaults.retries);
  state.defaults.lowLevelRetries = readPositiveInteger(state.defaults.lowLevelRetries, fallback.defaults.lowLevelRetries);
  state.defaults.bandwidthLimit = normalizeBandwidthLimit(state.defaults.bandwidthLimit || "off");
  state.defaults.schedule = normalizeSchedule(state.defaults.schedule || { mode: "manual" });
  return state;
}

function normalizeClaimRedeemFailures(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key) || !value || typeof value !== "object") {
      continue;
    }
    const failures = readNonNegativeInteger(value.failures, 0);
    const resetAt = readNonNegativeInteger(value.resetAt, 0);
    const limitedUntil = readNonNegativeInteger(value.limitedUntil, 0);
    if (failures <= 0 || Math.max(resetAt, limitedUntil) <= 0) {
      continue;
    }
    normalized[key] = { failures, resetAt, limitedUntil };
  }
  return normalized;
}

function normalizeAdminUsers(users, state) {
  const now = new Date().toISOString();
  const normalized = [];
  for (const user of users) {
    if (!user || typeof user !== "object") {
      continue;
    }
    const clientName = sanitizeClientName(user.clientName || user.name || "company-pc1");
    const storage = user.storage && typeof user.storage === "object" ? user.storage : {};
    const bucket = cleanBucket(storage.bucket || user.bucketName || user.bucket || state.storage.bucket);
    state.storage.buckets = ensureBucket(normalizeBuckets(state.storage.buckets, state.storage.bucket), bucket, {
      source: "legacy-user"
    });
    const migrated = {
      ...user,
      id: String(user.id || `user-${clientName}-${randomBytes(3).toString("hex")}`),
      clientName,
      uuid: isUuid(user.uuid) ? user.uuid : randomUUID(),
      diagnostics: normalizeLegacyUserDiagnostics(user.diagnostics),
      heartbeatSecret: String(user.heartbeatSecret || createHeartbeatSecret()),
      heartbeatAuthNonces: normalizeHeartbeatAuthNonces(user.heartbeatAuthNonces),
      enabled: user.enabled !== false,
      createdAt: String(user.createdAt || now),
      updatedAt: String(user.updatedAt || user.createdAt || now),
      storage: {
        accessKeyId: String(storage.accessKeyId || user.accessKeyId || state.storage.accessKeyId || clientName).trim(),
        secretAccessKey: String(storage.secretAccessKey || user.secretAccessKey || state.storage.secretAccessKey || randomBytes(24).toString("base64url")).trim(),
        bucket,
        prefix: cleanLegacyUserPrefix(storage.prefix || user.prefix, state, clientName)
      }
    };
    if (Object.hasOwn(user, "deletedAt")) {
      migrated.deletedAt = user.deletedAt == null ? null : String(user.deletedAt);
    }
    normalized.push(migrated);
  }
  return normalized;
}

function normalizeLegacyUserDiagnostics(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return normalizeRuntimeDiagnostics(input, "client");
}

function normalizeHeartbeatAuthNonces(input) {
  return Array.isArray(input)
    ? input
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          nonce: String(item.nonce || ""),
          timestamp: String(item.timestamp || ""),
          seenAt: String(item.seenAt || "")
        }))
    : [];
}

function cleanLegacyUserPrefix(input, state, clientName) {
  try {
    return cleanPrefix(input || `${state.storage.prefixRoot}/${clientName}`);
  } catch {
    return cleanPrefix(`${state.storage.prefixRoot}/${clientName}`);
  }
}

function normalizeSyncSpaceState(inputSpaces, inputMemberships, users) {
  const spaces = [];
  const spaceIds = new Set();
  const syncIds = new Set();
  const userById = new Map(users.map((user) => [user.id, user]));

  for (const source of inputSpaces) {
    if (!source || typeof source !== "object") {
      continue;
    }
    const id = normalizeSyncSpaceId(source.id);
    const syncId = normalizeSyncId(source.syncId);
    if (!id || !syncId || spaceIds.has(id) || syncIds.has(syncId)) {
      continue;
    }
    const storageTarget = source.storageTarget && typeof source.storageTarget === "object" ? source.storageTarget : {};
    try {
      spaces.push({
        id,
        syncId,
        storageTarget: {
          bucket: cleanBucket(storageTarget.bucket),
          prefix: cleanPrefix(storageTarget.prefix)
        },
        policy: { multiWriter: false },
        mode: normalizeSyncSpaceMode(source.mode),
        status: source.status === "disabled" ? "disabled" : "active",
        version: 1,
        createdAt: normalizeCreatedAt(source.createdAt)
      });
      spaceIds.add(id);
      syncIds.add(syncId);
    } catch {
      continue;
    }
  }

  const memberships = [];
  const membershipKeys = new Set();
  for (const source of inputMemberships) {
    if (!source || typeof source !== "object") {
      continue;
    }
    const syncSpaceId = normalizeSyncSpaceId(source.syncSpaceId);
    const deviceId = String(source.deviceId || "").trim();
    if (!syncSpaceId || !spaceIds.has(syncSpaceId) || !userById.has(deviceId)) {
      continue;
    }
    const key = `${syncSpaceId}:${deviceId}`;
    if (membershipKeys.has(key)) {
      continue;
    }
    memberships.push({
      syncSpaceId,
      deviceId,
      role: normalizeSyncSpaceRole(source.role),
      credentialId: normalizeCredentialId(source.credentialId),
      accessKeyId: normalizeOptionalCredential(source.accessKeyId),
      ["secretAccessKey"]: normalizeOptionalCredential(source.secretAccessKey),
      createdAt: normalizeCreatedAt(source.createdAt),
      revokedAt: source.revokedAt == null ? null : normalizeCreatedAt(source.revokedAt)
    });
    membershipKeys.add(key);
  }

  for (const user of users) {
    if (memberships.some((membership) => membership.deviceId === user.id)) {
      continue;
    }
    const id = uniqueSyncSpaceId(`space-${user.id}`, spaceIds);
    const syncId = uniqueSyncId(`legacy-${user.clientName}`, syncIds);
    spaces.push({
      id,
      syncId,
      storageTarget: {
        bucket: cleanBucket(user.storage.bucket),
        prefix: cleanPrefix(user.storage.prefix)
      },
      policy: { multiWriter: false },
      // 既有安装的设备私有空间：保留双向能力，见 syncSpaceMode.js 的 PRIVATE_SYNC_SPACE_MODE。
      mode: PRIVATE_SYNC_SPACE_MODE,
      status: user.deletedAt || user.enabled === false ? "disabled" : "active",
      version: 1,
      createdAt: user.createdAt
    });
    memberships.push({
      syncSpaceId: id,
      deviceId: user.id,
      role: "owner",
      credentialId: null,
      accessKeyId: null,
      secretAccessKey: null,
      createdAt: user.createdAt,
      revokedAt: user.deletedAt ? user.deletedAt : null
    });
    spaceIds.add(id);
    syncIds.add(syncId);
  }

  return { syncSpaces: spaces, memberships };
}

function normalizeSyncSpaceId(input) {
  const value = String(input || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : "";
}

function normalizeSyncId(input) {
  const value = String(input || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : "";
}

function normalizeSyncSpaceRole(input) {
  return ["owner", "writer", "reader"].includes(input) ? input : "reader";
}

function normalizeStorageAccessKeyMode(input) {
  const value = String(input || "").trim();
  if (!["shared", "per-device-space"].includes(value)) {
    throw validationError("storage.accessKeyMode must be shared or per-device-space");
  }
  return value;
}

function normalizeCredentialId(input) {
  const value = String(input || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
}

function normalizeOptionalCredential(input) {
  const value = String(input || "").trim();
  return value && value.length <= 256 ? value : null;
}

function normalizeCreatedAt(input) {
  const value = String(input || "");
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : new Date(0).toISOString();
}

function uniqueSyncSpaceId(base, existing) {
  const normalized = normalizeSyncSpaceId(base) || `space-${randomBytes(6).toString("hex")}`;
  if (!existing.has(normalized)) {
    return normalized;
  }
  let index = 2;
  while (existing.has(`${normalized}-${index}`)) {
    index += 1;
  }
  return `${normalized}-${index}`;
}

function uniqueSyncId(base, existing) {
  const candidate = String(base || "legacy").slice(0, 64).replace(/[^A-Za-z0-9_-]/g, "-");
  const normalized = normalizeSyncId(candidate) || `legacy-${randomBytes(6).toString("hex")}`;
  if (!existing.has(normalized)) {
    return normalized;
  }
  let index = 2;
  while (true) {
    const suffix = `-${index}`;
    const next = `${normalized.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(next)) {
      return next;
    }
    index += 1;
  }
}

export function autoFillTunnelConfig(state, input = {}) {
  const protocol = inputFieldOrDefault(input, "protocol", state.tunnel.protocol || "vless-tcp-none");
  const patch = {
    protocol,
    remark: inputFieldOrDefault(input, "remark", state.tunnel.remark || "sfsc-home"),
    publicHost: inputFieldOrDefault(input, "publicHost", state.tunnel.publicHost),
    publicPort: inputFieldOrDefault(input, "publicPort", state.tunnel.publicPort),
    listenPort: inputFieldOrDefault(input, "listenPort", state.tunnel.listenPort)
  };

  if (protocol === "vless-reality-tcp") {
    const current = state.tunnel.reality || {};
    if (input.forceRealityKeys && current.publicKey && current.privateKey && input.confirmRotateRealityKeys !== true) {
      throwDangerConfirmationRequired("Confirm REALITY key rotation before generating new keys");
    }
    const keypair = input.forceRealityKeys || !current.publicKey || !current.privateKey
      ? generateRealityKeypair()
      : {
          publicKey: current.publicKey,
          privateKey: current.privateKey
        };
    const savedServerName = current.serverName === LEGACY_REALITY_DEFAULT_SERVER_NAME
      && !current.publicKey && !current.privateKey && !current.shortId
      ? DEFAULT_REALITY_SERVER_NAME
      : current.serverName || DEFAULT_REALITY_SERVER_NAME;
    patch.reality = {
      serverName: inputFieldOrDefault(input, "serverName", savedServerName),
      fingerprint: inputFieldOrDefault(input, "fingerprint", current.fingerprint || "chrome"),
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      shortId: inputFieldOrDefault(input, "shortId", current.shortId || randomBytes(8).toString("hex"))
    };
  }

  if (protocol === "vless-ws-tls") {
    patch.transportPath = inputFieldOrDefault(input, "transportPath", state.tunnel.transportPath || "/sfsc-vless");
  }

  return updateTunnelConfig(state, patch);
}

export function updateTunnelConfig(state, input = {}) {
  const protocol = inputFieldOrDefault(input, "protocol", state.tunnel.protocol || "vless-tcp-none");
  if (!["vless-tcp-none", "vless-reality-tcp", "vless-ws-tls"].includes(protocol)) {
    throw validationError("Unsupported VLESS protocol profile");
  }

  const realityPatch = preserveExistingMaskedRealitySecrets(input.reality || {});
  const nextReality = normalizeRealityConfig({
    ...state.tunnel.reality,
    ...realityPatch
  });
  if (protocol === "vless-reality-tcp") {
    validateRealityConfig(nextReality);
  }

  state.tunnel = {
    ...state.tunnel,
    protocol,
    publicHost: cleanHost(inputFieldOrDefault(input, "publicHost", state.tunnel.publicHost)),
    publicPort: readPort(inputFieldOrDefault(input, "publicPort", state.tunnel.publicPort)),
    listenPort: readPort(inputFieldOrDefault(input, "listenPort", state.tunnel.listenPort)),
    security: protocol === "vless-reality-tcp" ? "reality" : protocol === "vless-ws-tls" ? "tls" : "none",
    transport: protocol === "vless-ws-tls" ? "ws" : "tcp",
    transportPath: protocol === "vless-ws-tls"
      ? cleanTransportPath(inputFieldOrDefault(input, "transportPath", state.tunnel.transportPath || "/sfsc-vless"))
      : "",
    remark: String(inputFieldOrDefault(input, "remark", state.tunnel.remark || "sfsc-home")).trim(),
    reality: nextReality,
    restartRequired: true
  };
  touch(state);
  return state.tunnel;
}

export function updateStorageConfig(state, input = {}) {
  const patch = preserveExistingMaskedStorageSecrets(input);
  const bucket = cleanBucket(inputFieldOrDefault(input, "bucket", state.storage.bucket));
  const endpoint = cleanUrl(inputFieldOrDefault(patch, "endpoint", state.storage.endpoint));
  const internalEndpoint = cleanUrl(state.storage.internalEndpoint || state.storage.endpoint);
  state.storage = {
    ...state.storage,
    name: String(inputFieldOrDefault(patch, "name", state.storage.name || "Home MinIO")).trim(),
    remoteName: cleanRemoteName(inputFieldOrDefault(patch, "remoteName", state.storage.remoteName)),
    endpoint,
    internalEndpoint,
    bucket,
    accessKeyMode: normalizeStorageAccessKeyMode(inputFieldOrDefault(patch, "accessKeyMode", state.storage.accessKeyMode || "shared")),
    accessKeyId: cleanRequiredCredential(inputFieldOrDefault(patch, "accessKeyId", state.storage.accessKeyId), "storage.accessKeyId"),
    secretAccessKey: cleanRequiredCredential(inputFieldOrDefault(patch, "secretAccessKey", state.storage.secretAccessKey), "storage.secretAccessKey"),
    prefixRoot: cleanPrefix(inputFieldOrDefault(patch, "prefixRoot", state.storage.prefixRoot || "devices")),
    sharedPrefix: cleanPrefix(inputFieldOrDefault(patch, "sharedPrefix", state.storage.sharedPrefix || "shared")),
    buckets: ensureBucket(normalizeBuckets(state.storage.buckets, bucket), bucket)
  };
  touch(state);
  return state.storage;
}

export function createStorageBucket(state, input = {}) {
  const bucket = cleanBucket(input.bucket || input.name || "");
  state.storage.buckets = ensureBucket(normalizeBuckets(state.storage.buckets, state.storage.bucket), bucket, {
    createdAt: new Date().toISOString(),
    source: input.source || "managed",
    disabledAt: null
  });
  if (!state.storage.bucket) {
    state.storage.bucket = bucket;
  }
  touch(state);
  return state.storage.buckets.find((item) => item.name === bucket);
}

export function replaceStorageBuckets(state, buckets = []) {
  const existingByName = new Map(normalizeBuckets(state.storage.buckets, state.storage.bucket).map((bucket) => [bucket.name, bucket]));
  const normalized = normalizeBuckets(buckets, state.storage.bucket);
  state.storage.buckets = (normalized.length ? normalized : normalizeBuckets([], state.storage.bucket)).map((bucket) => ({
    ...bucket,
    disabledAt: bucket.disabledAt ?? existingByName.get(bucket.name)?.disabledAt ?? null
  }));
  if (!state.storage.buckets.some((bucket) => bucket.name === state.storage.bucket)) {
    state.storage.buckets.unshift({
      name: state.storage.bucket,
      createdAt: new Date().toISOString(),
      source: "configured",
      disabledAt: existingByName.get(state.storage.bucket)?.disabledAt ?? null
    });
  }
  touch(state);
  return state.storage.buckets;
}

export function setStorageBucketEnabled(state, input = {}) {
  const bucketName = cleanBucket(input.bucket || input.name || "");
  const bucket = requireStorageBucket(state, bucketName);
  if (input.enabled === false && !findNextActiveBucket(state, bucketName)) {
    throw createHttpError("last_active_bucket_disable_blocked", 409, "Cannot disable the last active storage bucket");
  }
  bucket.disabledAt = input.enabled === false ? new Date().toISOString() : null;
  if (bucket.disabledAt && state.storage.bucket === bucketName) {
    const next = findNextActiveBucket(state, bucketName);
    if (next) {
      state.storage.bucket = next.name;
    }
  }
  touch(state);
  return bucket;
}

export function markStorageBucketCleared(state, bucketName) {
  const bucket = requireStorageBucket(state, bucketName);
  bucket.objectCount = 0;
  bucket.sizeBytes = 0;
  bucket.clearedAt = new Date().toISOString();
  touch(state);
  return bucket;
}

export function removeStorageBucket(state, input = {}) {
  const bucketName = cleanBucket(input.bucket || input.name || "");
  const bucket = requireStorageBucket(state, bucketName);
  const remaining = normalizeBuckets(state.storage.buckets, state.storage.bucket)
    .filter((bucket) => bucket.name !== bucketName);
  if (!remaining.length) {
    throw createHttpError("last_bucket_delete_blocked", 409, "Cannot delete the last storage bucket");
  }
  const activeReplacement = remaining.find((bucket) => !bucket.disabledAt);
  if (!bucket.disabledAt && !activeReplacement) {
    throw createHttpError("last_active_bucket_disable_blocked", 409, "Cannot delete the last active storage bucket");
  }
  const replacement = activeReplacement || remaining[0];
  state.storage.buckets = remaining;
  if (state.storage.bucket === bucketName) {
    state.storage.bucket = replacement.name;
  }
  for (const user of state.users) {
    if (!user.deletedAt && user.storage?.bucket === bucketName) {
      user.storage.bucket = replacement.name;
      user.updatedAt = new Date().toISOString();
    }
  }
  for (const syncSpace of state.syncSpaces || []) {
    if (syncSpace.storageTarget?.bucket === bucketName) {
      syncSpace.storageTarget.bucket = replacement.name;
    }
  }
  touch(state);
  return state.storage;
}

export function createManagedUser(state, input = {}) {
  const clientName = sanitizeClientName(inputFieldOrDefault(input, "clientName", "company-pc1"));
  const hasSelectedBucket = hasAnyInputField(input, ["bucketName", "bucket"]);
  const selectedBucketName = firstInputFieldOrDefault(input, ["bucketName", "bucket"], state.storage.bucket);
  const existing = state.users.find((user) => user.clientName === clientName && !user.deletedAt);
  if (existing && !input.forceNew) {
    ensureUserEnabled(existing);
    if (hasSelectedBucket) {
      const bucket = requireActiveStorageBucket(state, selectedBucketName);
      existing.storage.bucket = bucket.name;
      existing.updatedAt = new Date().toISOString();
      touch(state);
    }
    ensureDevicePrivateSyncSpace(state, existing);
    return existing;
  }

  const now = new Date().toISOString();
  const uuid = input.uuid && isUuid(input.uuid) ? input.uuid : randomUUID();
  const bucket = requireActiveStorageBucket(state, selectedBucketName);
  const storageTarget = input.storageTarget && typeof input.storageTarget === "object"
    ? input.storageTarget
    : {};
  const user = {
    id: input.id || `user-${clientName}-${randomBytes(3).toString("hex")}`,
    clientName,
    uuid,
    heartbeatSecret: input.heartbeatSecret || createHeartbeatSecret(),
    heartbeatAuthNonces: [],
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    storage: {
      accessKeyId: cleanRequiredCredential(inputFieldOrDefault(input, "accessKeyId", state.storage.accessKeyId || clientName), "user.storage.accessKeyId"),
      secretAccessKey: cleanRequiredCredential(inputFieldOrDefault(input, "secretAccessKey", state.storage.secretAccessKey || randomBytes(24).toString("base64url")), "user.storage.secretAccessKey"),
      bucket: cleanBucket(storageTarget.bucket || bucket.name),
      prefix: cleanPrefix(storageTarget.prefix || inputFieldOrDefault(input, "prefix", `${state.storage.prefixRoot}/${clientName}`))
    }
  };

  state.users.push(user);
  if (!input.skipPrivateSyncSpace) {
    ensureDevicePrivateSyncSpace(state, user);
  }
  state.tunnel.restartRequired = true;
  touch(state);
  return user;
}

export function setManagedUserEnabled(state, input = {}) {
  const user = requireUser(state, input.userId || input.id);
  if (input.enabled !== false) {
    ensureDeviceEnableAllowed(state, user, input);
  }
  user.enabled = input.enabled !== false;
  user.updatedAt = new Date().toISOString();
  state.tunnel.restartRequired = true;
  touch(state);
  return user;
}

export function deleteManagedUser(state, input = {}) {
  const user = requireUser(state, input.userId || input.id);
  user.enabled = false;
  user.deletedAt = new Date().toISOString();
  user.updatedAt = user.deletedAt;
  state.tunnel.restartRequired = true;
  touch(state);
  return user;
}

export function createClaim(state, input = {}) {
  if (Object.hasOwn(input, "defaults")) {
    normalizeProfileDefaults(state.defaults, input.defaults);
  }
  const clientName = input.userId
    ? (hasInputField(input, "clientName") ? sanitizeClientName(input.clientName) : "")
    : sanitizeClientName(inputFieldOrDefault(input, "clientName", "company-pc1"));
  const hasSelectedBucket = hasAnyInputField(input, ["bucketName", "bucket"]);
  const selectedBucketName = firstInputFieldOrDefault(input, ["bucketName", "bucket"], undefined);
  const serverUrl = cleanClaimServerOrigin(inputFieldOrDefault(input, "server", state.settings.publicServerUrl));
  const now = new Date();
  const expiresAt = normalizeClaimExpiresAt(input, now);
  const profileExpiresAt = normalizeClaimProfileExpiresAt(input.profileExpiresAt);
  const requestedSyncSpaceId = hasInputField(input, "syncSpaceId") ? normalizeSyncSpaceId(input.syncSpaceId) : "";
  if (hasInputField(input, "syncSpaceId") && !requestedSyncSpaceId) {
    throw validationError("syncSpaceId must be a valid sync space identifier");
  }
  if (hasInputField(input, "requestedRole") && !["owner", "writer", "reader"].includes(input.requestedRole)) {
    throw validationError("requestedRole must be owner, writer, or reader");
  }
  const targetSyncSpace = requestedSyncSpaceId
    ? requireActiveSyncSpace(state, requestedSyncSpaceId)
    : null;
  // 在创建设备之前拦截。createManagedUser 在下面几行就会写入 state.users，
  // 若等到 addSyncSpaceMembership 才抛错，被拒绝的请求会留下一台幽灵设备。
  if (targetSyncSpace) {
    requireRoleAllowedInSyncSpace(targetSyncSpace, normalizeSyncSpaceRole(input.requestedRole));
  }
  if (targetSyncSpace && hasSelectedBucket && selectedBucketName !== targetSyncSpace.storageTarget.bucket) {
    throw validationError("bucketName must match the selected sync space storage target");
  }
  const existingUser = input.userId
    ? requireUser(state, input.userId)
    : state.users.find((user) => user.clientName === clientName && !user.deletedAt);
  if (existingUser) {
    ensureClaimIssueAllowed(state, existingUser, input);
  }
  const user = input.userId || existingUser
    ? existingUser
    : createManagedUser(state, {
        clientName,
        ...(hasSelectedBucket ? { bucketName: selectedBucketName } : {}),
        ...(targetSyncSpace ? {
          skipPrivateSyncSpace: true,
          storageTarget: targetSyncSpace.storageTarget
        } : {})
      });
  if (targetSyncSpace && !existingUser && !input.userId) {
    addSyncSpaceMembership(state, targetSyncSpace.id, user.id, input.requestedRole);
  }
  ensureUserEnabled(user);
  const syncSpace = resolveClaimSyncSpace(state, user, input);
  if (hasSelectedBucket && !targetSyncSpace) {
    const selectedBucket = requireActiveStorageBucket(state, selectedBucketName).name;
    user.storage.bucket = selectedBucket;
    user.updatedAt = new Date().toISOString();
    syncSpace.storageTarget.bucket = selectedBucket;
  }
  const bucketName = requireActiveStorageBucket(state, syncSpace.storageTarget.bucket).name;
  const { membership } = requireActiveSyncSpaceMembership(state, syncSpace.id, user.id);
  ensureMembershipStorageCredentials(state, membership);
  ensureHeartbeatSecret(user);
  if (hasSelectedBucket && user.storage.bucket !== bucketName) {
    user.storage.bucket = bucketName;
    user.updatedAt = new Date().toISOString();
  }
  const code = uniqueClaimCode(state);
  const profile = buildProfileForUser(state, user, {
    profileId: input.profileId,
    expiresAt: profileExpiresAt,
    bucketName,
    syncSpaceId: syncSpace.id,
    storageTarget: syncSpace.storageTarget,
    storageCredentials: membership,
    defaults: input.defaults
  });
  const tokenPayload = { server: serverUrl, code };
  const claim = {
    id: `claim-${code.toLowerCase().replace("-", "")}`,
    code,
    userId: user.id,
    clientName: user.clientName,
    bucketName,
    syncSpaceId: syncSpace.id,
    requestedRole: membership.role,
    profileId: profile.profileId,
    used: false,
    createdAt: now.toISOString(),
    expiresAt,
    redeemedAt: null,
    server: serverUrl,
    profile,
    profileIssuedFrom: {
      defaultsMode: Object.hasOwn(input, "defaults") ? "claim" : "state",
      materialHash: hashClaimProfileMaterial(profile)
    }
  };

  state.claims.unshift(claim);
  touch(state);

  return {
    claim,
    profile,
    compatibility: summarizeDevice(state, user).compatibility,
    token: encodeClaimToken(tokenPayload, { format: "code" }),
    uri: encodeClaimToken(tokenPayload, { format: "uri" })
  };
}

function ensureClaimIssueAllowed(state, user, input = {}) {
  ensureUserEnabled(user);
  if (!hasClientRuntimeSignal(user)) {
    return;
  }
  const compatibility = summarizeDevice(state, user).compatibility;
  if (compatibility?.policy?.profileIssue === "warn" && input.confirmCompatibilityWarning !== true) {
    throwDangerConfirmationRequired("This device has a protocol compatibility warning. Confirm compatibility warning before issuing a new SyncKey.");
  }
}

function ensureDeviceEnableAllowed(state, user, input = {}) {
  if (!hasClientRuntimeSignal(user)) {
    return;
  }
  const compatibility = summarizeDevice(state, user).compatibility;
  const policy = compatibility?.policy || {};
  if ((policy.profileIssue === "warn" || policy.syncRun === "warn") && input.confirmCompatibilityWarning !== true) {
    throwDangerConfirmationRequired("This device has a protocol compatibility warning. Confirm compatibility warning before enabling it.");
  }
}

function hasClientRuntimeSignal(user = {}) {
  return Boolean(user.lastSeenAt || user.lastHeartbeatAt || user.clientVersion || user.diagnostics);
}

function ensureHeartbeatSecret(user) {
  if (!user.heartbeatSecret) {
    user.heartbeatSecret = createHeartbeatSecret();
    user.updatedAt = new Date().toISOString();
  }
  if (!Array.isArray(user.heartbeatAuthNonces)) {
    user.heartbeatAuthNonces = [];
  }
  return user.heartbeatSecret;
}

// Bounds the per-device nonce set that gets persisted into sfsc-state.json. The
// default heartbeat interval (SFSC_HEARTBEAT_MS, 15s) puts ~20 entries in the
// skew window, so this leaves 25x headroom while capping worst-case state growth.
const HEARTBEAT_AUTH_NONCE_LIMIT = 512;

function rememberHeartbeatAuthNonce(user, auth, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nonce = String(auth?.nonce || "");
  pruneHeartbeatAuthNonces(user, nowMs);
  if (user.heartbeatAuthNonces.some((item) => item.nonce === nonce)) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication nonce was already used");
  }
  // Overflow must reject, not evict. Dropping the oldest entries while they are
  // still inside the skew window would silently reopen the replay hole this cache
  // exists to close, and only a client heartbeating far faster than any sane
  // interval can reach the limit. A 401 makes that misconfiguration visible
  // instead of trading it for a replay window.
  if (user.heartbeatAuthNonces.length >= HEARTBEAT_AUTH_NONCE_LIMIT) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication nonce window is saturated");
  }
  user.heartbeatAuthNonces.push({
    nonce,
    timestamp: String(auth?.timestamp || ""),
    seenAt: new Date(nowMs).toISOString()
  });
}

function pruneHeartbeatAuthNonces(user, nowMs = Date.now()) {
  const minMs = nowMs - HEARTBEAT_AUTH_MAX_SKEW_MS;
  user.heartbeatAuthNonces = (Array.isArray(user.heartbeatAuthNonces) ? user.heartbeatAuthNonces : [])
    .filter((item) => {
      const timestampMs = Date.parse(item?.timestamp || "");
      const seenAtMs = Date.parse(item?.seenAt || "");
      return (Number.isFinite(timestampMs) && timestampMs >= minMs)
        || (Number.isFinite(seenAtMs) && seenAtMs >= minMs);
    });
}

export function redeemClaim(state, input = {}) {
  const code = extractClaimCode(input.code || input.tKey || input.tkey || input.claimCode || input.token || "");
  const claim = findClaimByCode(state, code);
  if (!claim) {
    const error = new Error("claim_not_found");
    error.status = 404;
    throw error;
  }
  if (claim.used) {
    if (canReplayClaim(claim, input)) {
      assertClaimRedeemStillValid(state, claim);
      return claim.profile;
    }
    const error = new Error("claim_already_used");
    error.status = 409;
    throw error;
  }
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() <= Date.now()) {
    const error = new Error("claim_expired");
    error.status = 410;
    throw error;
  }

  assertClaimRedeemStillValid(state, claim);
  claim.used = true;
  claim.redeemedAt = new Date().toISOString();
  rememberClaimRedeemBinding(claim, input);
  touch(state);
  return claim.profile;
}

// Compares candidate codes with a fixed-time digest compare so redemption does
// not leak how many leading characters of a SyncKey were guessed correctly.
function findClaimByCode(state, code) {
  const claims = Array.isArray(state?.claims) ? state.claims : [];
  const target = createHash("sha256").update(String(code || "")).digest();
  let match = null;
  for (const item of claims) {
    const candidate = createHash("sha256").update(String(item?.code || "")).digest();
    if (timingSafeEqual(candidate, target)) {
      match = match || item;
    }
  }
  return match;
}

export function compactAdminState(state, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const expiredUnusedClaimRetentionMs = options.expiredUnusedClaimRetentionMs ?? EXPIRED_UNUSED_CLAIM_RETENTION_MS;
  const deletedUserRetentionMs = options.deletedUserRetentionMs ?? DELETED_USER_RETENTION_MS;
  const beforeClaims = Array.isArray(state.claims) ? state.claims.length : 0;
  const beforeUsers = Array.isArray(state.users) ? state.users.length : 0;

  if (!Array.isArray(state.claims)) {
    state.claims = [];
  }
  if (!Array.isArray(state.users)) {
    state.users = [];
  }

  state.claims = state.claims
    .filter((claim) => shouldRetainClaim(claim, nowMs, expiredUnusedClaimRetentionMs))
    .map((claim) => compactClaimReplayBinding(claim, nowMs));

  const referencedUserIds = new Set(state.claims.map((claim) => claim.userId).filter(Boolean));
  state.users = state.users.filter((user) => shouldRetainUser(user, referencedUserIds, nowMs, deletedUserRetentionMs));
  for (const user of state.users) {
    pruneHeartbeatAuthNonces(user, nowMs);
  }

  const prunedClaims = beforeClaims - state.claims.length;
  const prunedUsers = beforeUsers - state.users.length;
  const changed = prunedClaims > 0 || prunedUsers > 0;
  if (changed) {
    touch(state);
  }
  return {
    changed,
    prunedClaims,
    prunedUsers
  };
}

function shouldRetainClaim(claim, nowMs, retentionMs) {
  if (!claim || typeof claim !== "object") {
    return false;
  }
  if (claim.used || claim.redeemedAt) {
    return true;
  }
  const expiresAtMs = Date.parse(claim.expiresAt || "");
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }
  return expiresAtMs + retentionMs > nowMs;
}

function compactClaimReplayBinding(claim, nowMs) {
  if (!claim || typeof claim !== "object") {
    return claim;
  }
  const replayUntilMs = Date.parse(claim.replayUntil || "");
  if (Number.isFinite(replayUntilMs) && replayUntilMs <= nowMs) {
    const firstRedeemedAt = claim.redeemedBy?.firstRedeemedAt || claim.redeemedAt || null;
    if (firstRedeemedAt) {
      claim.redeemedBy = { firstRedeemedAt };
    } else {
      delete claim.redeemedBy;
    }
    delete claim.replayUntil;
  }
  return claim;
}

function shouldRetainUser(user, referencedUserIds, nowMs, retentionMs) {
  if (!user || typeof user !== "object") {
    return false;
  }
  if (!user.deletedAt) {
    return true;
  }
  if (referencedUserIds.has(user.id)) {
    return true;
  }
  const deletedAtMs = Date.parse(user.deletedAt || "");
  if (!Number.isFinite(deletedAtMs)) {
    return true;
  }
  return deletedAtMs + retentionMs > nowMs;
}

function assertClaimRedeemStillValid(state, claim) {
  const user = state.users.find((item) => item.id === claim.userId && !item.deletedAt);
  if (!user) {
    throw createHttpError("validation_failed", 400, "SyncKey claim device is no longer available");
  }
  if (user.enabled === false) {
    throw createHttpError("validation_failed", 400, "SyncKey claim device is disabled");
  }
  assertClaimSyncSpaceStillValid(state, user, claim);
  const bucketName = claim.bucketName || claim.profile?.storage?.bucket || user.storage?.bucket || state.storage.bucket;
  let bucket;
  try {
    bucket = requireStorageBucket(state, bucketName);
  } catch (error) {
    if (error?.code === "bucket_not_found") {
      throw createHttpError("validation_failed", 400, "SyncKey claim storage bucket is no longer available");
    }
    throw error;
  }
  if (bucket.disabledAt) {
    throw createHttpError("validation_failed", 400, "SyncKey claim storage bucket is disabled");
  }
  assertClaimProfileStillCurrent(state, user, claim, bucket.name);
}

function assertClaimSyncSpaceStillValid(state, user, claim) {
  if (!claim.syncSpaceId) {
    return;
  }
  const { membership } = requireActiveSyncSpaceMembership(state, claim.syncSpaceId, user.id);
  if (claim.requestedRole && membership.role !== claim.requestedRole) {
    throw createHttpError("validation_failed", 400, "SyncKey claim sync space role changed; regenerate SyncKey");
  }
}

function resolveClaimSyncSpace(state, user, input = {}) {
  ensureDevicePrivateSyncSpace(state, user);
  const requestedId = hasInputField(input, "syncSpaceId") ? normalizeSyncSpaceId(input.syncSpaceId) : "";
  if (hasInputField(input, "syncSpaceId") && !requestedId) {
    throw validationError("syncSpaceId must be a valid sync space identifier");
  }
  if (requestedId) {
    return requireActiveSyncSpaceMembership(state, requestedId, user.id).syncSpace;
  }
  const membership = state.syncSpaceMemberships.find((item) => item.deviceId === user.id && !item.revokedAt);
  if (!membership) {
    throw createHttpError("sync_space_access_denied", 403, "Sync space access is not available");
  }
  return requireActiveSyncSpaceMembership(state, membership.syncSpaceId, user.id).syncSpace;
}

export function createSyncSpace(state, input = {}) {
  const syncId = normalizeSyncId(input.syncId);
  if (!syncId) {
    throw validationError("syncId must be a valid sync identifier");
  }
  if ((state.syncSpaces || []).some((space) => space.syncId === syncId)) {
    throw createHttpError("sync_id_unavailable", 409, "Sync ID is not available");
  }
  const owner = requireUser(state, input.ownerUserId || input.userId);
  ensureUserEnabled(owner);
  const bucket = requireActiveStorageBucket(state, input.bucketName || owner.storage.bucket).name;
  const ids = new Set((state.syncSpaces || []).map((space) => space.id));
  const id = uniqueSyncSpaceId(input.id || `space-${randomBytes(6).toString("hex")}`, ids);
  const space = {
    id,
    syncId,
    storageTarget: {
      bucket,
      prefix: cleanPrefix(input.prefix || `${state.storage.sharedPrefix}/${id}`)
    },
    policy: { multiWriter: false },
    mode: requireSyncSpaceMode(input.mode),
    status: "active",
    version: 1,
    createdAt: new Date().toISOString()
  };
  state.syncSpaces.push(space);
  addSyncSpaceMembership(state, space.id, owner.id, "owner");
  touch(state);
  return space;
}

function requireActiveSyncSpace(state, syncSpaceId) {
  const syncSpace = (state.syncSpaces || []).find((item) => item.id === syncSpaceId && item.status === "active");
  if (!syncSpace) {
    throw createHttpError("sync_space_access_denied", 403, "Sync space access is not available");
  }
  return syncSpace;
}

function addSyncSpaceMembership(state, syncSpaceId, deviceId, role) {
  const existing = (state.syncSpaceMemberships || []).find((item) => item.syncSpaceId === syncSpaceId && item.deviceId === deviceId);
  if (existing && !existing.revokedAt) {
    throw createHttpError("sync_space_membership_exists", 409, "Device is already a sync space member");
  }
  const normalizedRole = normalizeSyncSpaceRole(role);
  // 单一入口的不变式：任何调用方都不能给成员留下一个空的合法方向集合。
  // createClaim 已在建设备之前先查一次，这里兜住其余调用方。
  const syncSpace = (state.syncSpaces || []).find((item) => item.id === syncSpaceId);
  if (syncSpace) {
    requireRoleAllowedInSyncSpace(syncSpace, normalizedRole);
  }
  const membership = {
    syncSpaceId,
    deviceId,
    role: normalizedRole,
    credentialId: null,
    accessKeyId: null,
    secretAccessKey: null,
    createdAt: new Date().toISOString(),
    revokedAt: null
  };
  if (existing) {
    Object.assign(existing, membership);
    return existing;
  }
  state.syncSpaceMemberships.push(membership);
  return membership;
}

// 备份用途的空间没有 reader 座位：deriveSyncDirections 对该组合返回空集合，
// 一个没有任何合法方向的成员是无法被界面表达的非法状态，因此在入座时就拒绝。
function requireRoleAllowedInSyncSpace(syncSpace, role) {
  const mode = normalizeSyncSpaceMode(syncSpace?.mode);
  if (deriveSyncDirections(mode, role).length === 0) {
    throw createHttpError(
      "sync_space_role_not_allowed",
      409,
      `Role ${role} is not allowed in a ${mode} sync space`
    );
  }
}

function requireActiveSyncSpaceMembership(state, syncSpaceId, deviceId) {
  const syncSpace = requireActiveSyncSpace(state, syncSpaceId);
  const membership = (state.syncSpaceMemberships || []).find((item) => item.syncSpaceId === syncSpaceId && item.deviceId === deviceId && !item.revokedAt);
  if (!syncSpace || !membership) {
    throw createHttpError("sync_space_access_denied", 403, "Sync space access is not available");
  }
  return { syncSpace, membership };
}

function ensureDevicePrivateSyncSpace(state, user) {
  state.syncSpaces = Array.isArray(state.syncSpaces) ? state.syncSpaces : [];
  state.syncSpaceMemberships = Array.isArray(state.syncSpaceMemberships) ? state.syncSpaceMemberships : [];
  if (state.syncSpaceMemberships.some((membership) => membership.deviceId === user.id)) {
    return;
  }
  const spaceIds = new Set(state.syncSpaces.map((space) => space.id));
  const syncIds = new Set(state.syncSpaces.map((space) => space.syncId));
  const id = uniqueSyncSpaceId(`space-${user.id}`, spaceIds);
  const syncId = uniqueSyncId(`legacy-${user.clientName}`, syncIds);
  state.syncSpaces.push({
    id,
    syncId,
    storageTarget: {
      bucket: cleanBucket(user.storage.bucket),
      prefix: cleanPrefix(user.storage.prefix)
    },
    policy: { multiWriter: false },
    mode: PRIVATE_SYNC_SPACE_MODE,
    status: user.deletedAt || user.enabled === false ? "disabled" : "active",
    version: 1,
    createdAt: user.createdAt
  });
  state.syncSpaceMemberships.push({
    syncSpaceId: id,
    deviceId: user.id,
    role: "owner",
    credentialId: null,
    accessKeyId: null,
    secretAccessKey: null,
    createdAt: user.createdAt,
    revokedAt: user.deletedAt ? user.deletedAt : null
  });
}

function ensureMembershipStorageCredentials(state, membership) {
  if (state.storage?.accessKeyMode !== "per-device-space") {
    return;
  }
  if (membership.accessKeyId && membership.secretAccessKey) {
    return;
  }
  membership.credentialId = `credential-${randomBytes(10).toString("hex")}`;
  membership.accessKeyId = `sfsc-${randomBytes(12).toString("hex")}`;
  membership.secretAccessKey = randomBytes(32).toString("base64url");
}

function assertClaimProfileStillCurrent(state, user, claim, bucketName) {
  if (!claim.profile || typeof claim.profile !== "object") {
    throw createHttpError("validation_failed", 400, "SyncKey claim profile is missing; regenerate SyncKey");
  }
  assertClaimProfileNotExpired(claim.profile);
  const expectedProfile = buildProfileForUser(state, user, {
    profileId: claim.profile.profileId || claim.profileId,
    expiresAt: claim.profile.expiresAt || null,
    bucketName,
    syncSpaceId: claim.syncSpaceId,
    storageTarget: claim.syncSpaceId
      ? requireActiveSyncSpace(state, claim.syncSpaceId).storageTarget
      : undefined,
    storageCredentials: claim.syncSpaceId
      ? requireActiveSyncSpaceMembership(state, claim.syncSpaceId, user.id).membership
      : undefined,
    defaults: claimProfileDefaultsMode(state, claim) === "claim" ? claim.profile.defaults : undefined
  });
  const expectedHash = hashClaimProfileMaterial(expectedProfile);
  const issuedHash = claim.profileIssuedFrom?.materialHash || hashClaimProfileMaterial(claim.profile);
  if (expectedHash !== issuedHash) {
    throw createHttpError("validation_failed", 400, "SyncKey claim profile is stale; regenerate SyncKey");
  }
}

function assertClaimProfileNotExpired(profile) {
  if (profile.expiresAt == null || profile.expiresAt === "") {
    return;
  }
  const expiresAtMs = Date.parse(profile.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw createHttpError("validation_failed", 400, "SyncKey claim profile expiry is invalid; regenerate SyncKey");
  }
  if (expiresAtMs <= Date.now()) {
    throw createHttpError("validation_failed", 400, "SyncKey claim profile is expired; regenerate SyncKey");
  }
}

function normalizeClaimProfileExpiresAt(input) {
  if (input == null || input === "") {
    return null;
  }
  const value = String(input).trim();
  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    throw validationError("profileExpiresAt must be a valid ISO date");
  }
  if (expiresAtMs <= Date.now()) {
    throw validationError("profileExpiresAt must be in the future");
  }
  return new Date(expiresAtMs).toISOString();
}

function normalizeClaimExpiresAt(input, now = new Date()) {
  if (hasInputField(input, "expiresAt")) {
    if (input.expiresAt === null) {
      return null;
    }
    if (typeof input.expiresAt !== "string" || !input.expiresAt.trim()) {
      throw validationError("expiresAt must be null or a valid future ISO date");
    }
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw validationError("expiresAt must be a valid future ISO date");
    }
    if (expiresAtMs <= now.getTime()) {
      throw validationError("expiresAt must be in the future");
    }
    return new Date(expiresAtMs).toISOString();
  }

  if (hasInputField(input, "expiresInHours")) {
    if (!["number", "string"].includes(typeof input.expiresInHours)) {
      throw validationError("expiresInHours must be a positive number");
    }
    const expiresInHours = Number(input.expiresInHours);
    if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
      throw validationError("expiresInHours must be a positive number");
    }
    return new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function claimProfileDefaultsMode(state, claim) {
  const mode = claim.profileIssuedFrom?.defaultsMode;
  if (mode === "claim" || mode === "state") {
    return mode;
  }
  const claimDefaultsHash = hashProfileDefaults(claim.profile?.defaults);
  const stateDefaultsHash = hashProfileDefaults(normalizeProfileDefaults(state.defaults));
  return claimDefaultsHash && claimDefaultsHash !== stateDefaultsHash ? "claim" : "state";
}

function hashClaimProfileMaterial(profile = {}) {
  return createHash("sha256")
    .update(JSON.stringify(claimProfileMaterial(profile)))
    .digest("hex");
}

function hashProfileDefaults(defaults = {}) {
  if (!defaults || typeof defaults !== "object") {
    return "";
  }
  return createHash("sha256")
    .update(JSON.stringify(profileDefaultsMaterial(defaults)))
    .digest("hex");
}

function claimProfileMaterial(profile = {}) {
  return {
    clientName: profile.clientName || null,
    tunnel: {
      type: profile.tunnel?.type || null,
      uri: profile.tunnel?.uri || null
    },
    heartbeat: {
      scheme: profile.heartbeat?.scheme || null,
      secret: profile.heartbeat?.secret || null
    },
    storage: {
      type: profile.storage?.type || null,
      remoteName: profile.storage?.remoteName || null,
      endpoint: profile.storage?.endpoint || null,
      bucket: profile.storage?.bucket || null,
      accessKeyId: profile.storage?.accessKeyId || null,
      secretAccessKey: profile.storage?.secretAccessKey || null,
      prefix: profile.storage?.prefix || null
    },
    defaults: profileDefaultsMaterial(profile.defaults)
  };
}

function profileDefaultsMaterial(defaults = {}) {
  return {
    localProxyPort: defaults.localProxyPort ?? null,
    transfers: defaults.transfers ?? null,
    streams: defaults.streams ?? null,
    checkers: defaults.checkers ?? null,
    chunkSize: defaults.chunkSize ?? null,
    retries: defaults.retries ?? null,
    lowLevelRetries: defaults.lowLevelRetries ?? null,
    bandwidthLimit: defaults.bandwidthLimit ?? null,
    schedule: defaults.schedule ?? null
  };
}

function rememberClaimRedeemBinding(claim, input = {}) {
  const clientRedeemId = normalizeRedeemBindingId(input.clientRedeemId);
  const clientInstallId = normalizeRedeemBindingId(input.clientInstallId || input.deviceBindingId);
  if (!clientRedeemId || !clientInstallId) {
    return;
  }
  claim.redeemedBy = {
    clientRedeemId,
    clientInstallIdHash: hashRedeemBinding(clientInstallId),
    firstRedeemedAt: claim.redeemedAt
  };
  claim.replayUntil = new Date(Date.now() + CLAIM_REPLAY_WINDOW_MS).toISOString();
}

function canReplayClaim(claim, input = {}) {
  const binding = claim.redeemedBy || {};
  const clientRedeemId = normalizeRedeemBindingId(input.clientRedeemId);
  const clientInstallId = normalizeRedeemBindingId(input.clientInstallId || input.deviceBindingId);
  if (!clientRedeemId || !clientInstallId || !binding.clientRedeemId || !binding.clientInstallIdHash || !claim.replayUntil) {
    return false;
  }
  if (Date.parse(claim.replayUntil) <= Date.now()) {
    return false;
  }
  return binding.clientRedeemId === clientRedeemId
    && binding.clientInstallIdHash === hashRedeemBinding(clientInstallId);
}

function normalizeRedeemBindingId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128) {
    return "";
  }
  return text;
}

function hashRedeemBinding(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function buildProfileForUser(state, user, options = {}) {
  const defaults = normalizeProfileDefaults(state.defaults, options.defaults);
  // 空间与角色此前在这里被整个丢弃，客户端因此既不知道自己在哪个空间，
  // 也不知道自己的角色，只能把方向当成用户的一次猜测。
  const syncSpace = options.syncSpaceId
    ? (state.syncSpaces || []).find((item) => item.id === options.syncSpaceId)
    : null;
  const role = options.storageCredentials?.role
    || (syncSpace
      ? (state.syncSpaceMemberships || []).find((item) => item.syncSpaceId === syncSpace.id && item.deviceId === user.id && !item.revokedAt)?.role
      : "");
  const profile = {
    version: PROFILE_VERSION,
    profileId: options.profileId || `profile-${user.clientName}-${randomBytes(3).toString("hex")}`,
    clientName: user.clientName,
    issuedAt: new Date().toISOString(),
    expiresAt: options.expiresAt || null,
    ...(syncSpace ? {
      syncSpace: {
        id: syncSpace.id,
        syncId: syncSpace.syncId,
        mode: normalizeSyncSpaceMode(syncSpace.mode)
      },
      authorization: deriveAuthorization({
        mode: syncSpace.mode,
        role,
        policy: syncSpace.policy
      })
    } : {}),
    tunnel: {
      type: "vless",
      uri: buildVlessUri(state.tunnel, user)
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: ensureHeartbeatSecret(user)
    },
    storage: {
      type: "s3",
      remoteName: state.storage.remoteName,
      endpoint: state.storage.endpoint,
      bucket: cleanBucket(options.storageTarget?.bucket || options.bucketName || user.storage.bucket || state.storage.bucket),
      accessKeyId: options.storageCredentials?.accessKeyId || user.storage.accessKeyId,
      secretAccessKey: options.storageCredentials?.secretAccessKey || user.storage.secretAccessKey,
      prefix: cleanPrefix(options.storageTarget?.prefix || user.storage.prefix)
    },
    defaults: {
      localProxyPort: defaults.localProxyPort,
      transfers: defaults.transfers,
      streams: defaults.streams,
      checkers: defaults.checkers,
      chunkSize: defaults.chunkSize,
      retries: defaults.retries,
      lowLevelRetries: defaults.lowLevelRetries,
      bandwidthLimit: normalizeBandwidthLimit(defaults.bandwidthLimit || "off"),
      schedule: normalizeSchedule(defaults.schedule || { mode: "manual" })
    }
  };

  parseVlessUri(profile.tunnel.uri);
  return profile;
}

export function recordDeviceHeartbeat(state, input = {}) {
  const clientName = sanitizeClientName(input.clientName || input.deviceName || "");
  const user = state.users.find((item) => item.clientName === clientName && !item.deletedAt);
  if (!user) {
    const error = new Error("device_not_found");
    error.status = 404;
    throw error;
  }
  ensureUserEnabled(user);
  if (user.heartbeatSecret) {
    const { remoteAddress: _remoteAddress, ...authPayload } = input;
    verifyHeartbeatAuth(authPayload, user.heartbeatSecret);
    rememberHeartbeatAuthNonce(user, authPayload.auth);
  }

  const now = new Date().toISOString();
  user.lastSeenAt = now;
  user.lastHeartbeatAt = now;
  user.clientVersion = input.clientVersion ? String(input.clientVersion) : user.clientVersion || "";
  user.diagnostics = input.diagnostics ? normalizeRuntimeDiagnostics(input.diagnostics, "client") : null;
  user.lastRemoteAddress = input.remoteAddress || user.lastRemoteAddress || "";
  user.sync = normalizeDeviceSync(input.sync || input, user.sync, now);
  touch(state);
  return user;
}

export function buildVlessUri(tunnel, user) {
  const params = new URLSearchParams();
  params.set("encryption", "none");
  params.set("security", tunnel.security || "none");
  params.set("type", tunnel.transport || "tcp");

  if (tunnel.transport === "ws") {
    params.set("path", cleanTransportPath(tunnel.transportPath || "/sfsc-vless"));
    params.set("host", tunnel.publicHost);
  }

  if (tunnel.security === "tls") {
    params.set("sni", tunnel.publicHost);
  }

  if (tunnel.security === "reality") {
    const reality = validateRealityConfig(normalizeRealityConfig(tunnel.reality || {}));
    params.set("sni", reality.serverName);
    params.set("fp", reality.fingerprint);
    params.set("pbk", reality.publicKey);
    params.set("sid", reality.shortId);
  }

  const remark = encodeURIComponent(`${tunnel.remark || "sfsc"}-${user.clientName}`);
  return `vless://${user.uuid}@${tunnel.publicHost}:${tunnel.publicPort}?${params.toString()}#${remark}`;
}

export function buildSingboxServerConfig(state) {
  const inbound = {
    type: "vless",
    tag: "vless-in",
    listen: state.tunnel.listenHost || "0.0.0.0",
    listen_port: readPort(state.tunnel.listenPort),
    users: state.users
      .filter((user) => user.enabled !== false && !user.deletedAt)
      .map((user) => ({
        name: user.clientName,
        uuid: user.uuid
      }))
  };

  if (state.tunnel.security === "reality") {
    const reality = normalizeRealityConfig(state.tunnel.reality || {});
    validateRealityConfig(reality);
    inbound.tls = {
      enabled: true,
      server_name: reality.serverName,
      reality: {
        enabled: true,
        handshake: {
          server: reality.serverName,
          server_port: 443
        },
        private_key: reality.privateKey,
        short_id: [reality.shortId]
      }
    };
  }

  if (state.tunnel.transport === "ws") {
    inbound.transport = {
      type: "ws",
      path: cleanTransportPath(state.tunnel.transportPath || "/sfsc-vless")
    };
  }

  return {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds: [inbound],
    outbounds: [
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      final: "direct"
    }
  };
}

export function summarizeAdminState(state) {
  const buckets = normalizeBuckets(state.storage.buckets, state.storage.bucket);
  const activeUsers = state.users.filter((user) => user.enabled !== false && !user.deletedAt);
  const sampleUser = activeUsers[0] || null;
  return {
    version: state.version,
    appVersion: state.appVersion || "",
    diagnostics: state.diagnostics || buildRuntimeDiagnostics({
      role: "server",
      version: state.appVersion || ""
    }),
    updatedAt: state.updatedAt,
    settings: state.settings,
    tunnel: {
      ...state.tunnel,
      reality: maskRealityConfig(state.tunnel.reality),
      userCount: activeUsers.length,
      sampleUri: null,
      sampleUriAvailable: Boolean(sampleUser),
      sampleUriRevealPath: sampleUser ? adminDeviceVlessUriRevealPath(sampleUser.id) : ""
    },
    storage: {
      ...state.storage,
      secretAccessKey: maskSecret(state.storage.secretAccessKey),
      buckets: buckets.map((bucket) => ({
        ...bucket,
        endpoint: state.storage.endpoint,
        remoteName: state.storage.remoteName,
        prefixes: [
          `${state.storage.prefixRoot}/`,
          `${state.storage.sharedPrefix}/`
        ]
      }))
    },
    defaults: state.defaults,
    syncSpaces: state.syncSpaces.map((syncSpace) => summarizeAdminSyncSpace(state, syncSpace)),
    users: state.users.map((user) => summarizeAdminUser(state, user)),
    devices: state.users
      .filter((user) => !user.deletedAt)
      .map((user) => summarizeDevice(state, user, { includeVlessReveal: true })),
    claims: state.claims.map((claim) => summarizeClaim(claim))
  };
}

export function summarizeAdminSyncSpace(state, syncSpace) {
  return {
    id: String(syncSpace.id || ""),
    syncId: String(syncSpace.syncId || ""),
    status: syncSpace.status === "disabled" ? "disabled" : "active",
    policy: { multiWriter: syncSpace.policy?.multiWriter === true },
    mode: normalizeSyncSpaceMode(syncSpace.mode),
    version: Number(syncSpace.version || 1),
    createdAt: String(syncSpace.createdAt || ""),
    memberCount: state.syncSpaceMemberships.filter((membership) => membership.syncSpaceId === syncSpace.id && !membership.revokedAt).length
  };
}

export function summarizeAdminUser(state, user) {
  const storage = user.storage || {};
  const summary = {
    id: String(user.id || ""),
    clientName: String(user.clientName || ""),
    uuid: String(user.uuid || ""),
    enabled: user.enabled !== false,
    createdAt: String(user.createdAt || ""),
    updatedAt: String(user.updatedAt || ""),
    storage: {
      accessKeyId: String(storage.accessKeyId || ""),
      secretAccessKey: maskSecret(storage.secretAccessKey),
      bucket: String(storage.bucket || ""),
      prefix: String(storage.prefix || "")
    },
    vlessUriAvailable: !user.deletedAt,
    vlessUriRevealPath: user.deletedAt ? "" : adminDeviceVlessUriRevealPath(user.id)
  };
  if (Object.hasOwn(user, "deletedAt")) {
    summary.deletedAt = user.deletedAt == null ? null : String(user.deletedAt);
  }
  return summary;
}

export function summarizeClaim(claim) {
  return {
    id: String(claim.id || ""),
    code: String(claim.code || ""),
    userId: String(claim.userId || ""),
    clientName: String(claim.clientName || ""),
    bucketName: String(claim.bucketName || ""),
    syncSpaceId: claim.syncSpaceId ? String(claim.syncSpaceId) : null,
    requestedRole: ["owner", "writer", "reader"].includes(claim.requestedRole) ? claim.requestedRole : null,
    profileId: String(claim.profileId || ""),
    used: Boolean(claim.used),
    createdAt: String(claim.createdAt || ""),
    expiresAt: claim.expiresAt == null ? null : String(claim.expiresAt),
    redeemedAt: claim.redeemedAt == null ? null : String(claim.redeemedAt),
    server: String(claim.server || "")
  };
}

export function summarizeDevice(state, user, options = {}) {
  const lastSeenAt = user.lastSeenAt || user.lastHeartbeatAt || null;
  const online = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() < 2 * 60 * 1000 : false;
  const sync = summarizeDeviceSync(user.sync, online);
  const diagnostics = user.diagnostics ? normalizeRuntimeDiagnostics(user.diagnostics, "client") : null;
  const serverDiagnostics = normalizeRuntimeDiagnostics(state.diagnostics, "server") || buildRuntimeDiagnostics({
    role: "server",
    version: state.appVersion || ""
  });
  const device = {
    id: user.id,
    clientName: user.clientName,
    enabled: user.enabled !== false,
    online,
    status: online ? "online" : "offline",
    lastSeenAt,
    bucket: user.storage.bucket || state.storage.bucket,
    prefix: user.storage.prefix,
    clientVersion: user.clientVersion || "",
    diagnostics,
    compatibility: compareRuntimeDiagnostics(serverDiagnostics, diagnostics || {}, {
      localRole: "server",
      remoteRole: "client"
    }),
    lastRemoteAddress: user.lastRemoteAddress || "",
    sync,
    syncState: sync.state,
    speedMbps: sync.speedMbps
  };
  if (options.includeVlessUri === true) {
    device.vlessUri = buildVlessUri(state.tunnel, user);
  }
  if (options.includeVlessReveal === true) {
    device.vlessUriAvailable = true;
    device.vlessUriRevealPath = adminDeviceVlessUriRevealPath(user.id);
  }
  return device;
}

export function revealAdminDeviceVlessUri(state, userId) {
  const user = state.users.find((item) => item.id === String(userId || "") && !item.deletedAt);
  if (!user) {
    throw createHttpError("device_not_found", 404, "Device not found");
  }
  return {
    device: {
      id: user.id,
      clientName: user.clientName
    },
    vlessUri: buildVlessUri(state.tunnel, user)
  };
}

function adminDeviceVlessUriRevealPath(userId) {
  return `/api/admin/devices/${encodeURIComponent(String(userId || ""))}/vless-uri`;
}

export function markSingboxApplied(state, input = {}) {
  if (input.confirmMarkApplied !== true) {
    throwDangerConfirmationRequired("Confirm sing-box has been restarted and loaded the latest config before marking it applied");
  }
  if (!state.tunnel.restartRequired) {
    const error = new Error("validation_failed");
    error.code = "validation_failed";
    error.status = 400;
    error.publicMessage = "No pending sing-box config change to mark as applied";
    throw error;
  }
  state.tunnel.lastAppliedAt = new Date().toISOString();
  state.tunnel.restartRequired = false;
  touch(state);
  return state.tunnel;
}

function uniqueClaimCode(state) {
  for (let i = 0; i < 20; i += 1) {
    const code = `${randomCodePart()}-${randomCodePart()}`;
    if (!state.claims.some((claim) => claim.code === code)) {
      return code;
    }
  }
  throw new Error("Could not allocate a unique SyncKey short code");
}

function randomCodePart() {
  let value = "";
  const bytes = randomBytes(4);
  for (let i = 0; i < 4; i += 1) {
    value += CLAIM_CODE_ALPHABET[bytes[i] % CLAIM_CODE_ALPHABET.length];
  }
  return value;
}

function generateRealityKeypair() {
  const pair = generateKeyPairSync("x25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  return {
    privateKey: privateJwk.d,
    publicKey: publicJwk.x
  };
}

function requireUser(state, userId) {
  const user = state.users.find((item) => item.id === userId && !item.deletedAt);
  if (!user) {
    throw createHttpError("user_not_found", 404, "User not found");
  }
  return user;
}

function ensureUserEnabled(user) {
  if (user.enabled === false) {
    throw createHttpError("device_disabled", 409, "Device is disabled");
  }
}

function sanitizeClientName(input) {
  const text = String(input || "").trim();
  if (!text) {
    throw validationError("Client name is required");
  }
  if (text.length > 63) {
    throw validationError("Client name must be 1-63 characters");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text)) {
    throw validationError("Client name can only contain letters, numbers, _ and -");
  }
  return text;
}

function cleanRemoteName(input) {
  return sanitizeRemoteName(input, validationError);
}

function cleanBucket(input) {
  const text = String(input || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text) || text.includes("..")) {
    throw validationError("Bucket name must be a valid lowercase S3 bucket name");
  }
  return text;
}

function normalizeBuckets(input, fallbackBucket) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set();
  const buckets = [];
  for (const item of values) {
    const name = cleanBucket(typeof item === "string" ? item : item.name);
    if (seen.has(name)) continue;
    seen.add(name);
    buckets.push({
      name,
      createdAt: item.createdAt || null,
      source: item.source || "configured",
      objectCount: item.objectCount ?? null,
      sizeBytes: item.sizeBytes ?? null,
      disabledAt: item.disabledAt || null,
      clearedAt: item.clearedAt || null
    });
  }
  if (fallbackBucket && !seen.has(fallbackBucket)) {
    buckets.unshift({
      name: cleanBucket(fallbackBucket),
      createdAt: null,
      source: "configured",
      objectCount: null,
      sizeBytes: null,
      disabledAt: null,
      clearedAt: null
    });
  }
  return buckets;
}

function ensureBucket(buckets, bucketName, extra = {}) {
  const name = cleanBucket(bucketName);
  if (buckets.some((bucket) => bucket.name === name)) {
    return buckets;
  }
  return [
    ...buckets,
    {
      name,
      createdAt: extra.createdAt || new Date().toISOString(),
      source: extra.source || "managed",
      objectCount: null,
      sizeBytes: null,
      disabledAt: extra.disabledAt || null,
      clearedAt: extra.clearedAt || null
    }
  ];
}

function requireStorageBucket(state, bucketName) {
  const name = cleanBucket(bucketName);
  const bucket = normalizeBuckets(state.storage.buckets, state.storage.bucket).find((item) => item.name === name);
  if (!bucket) {
    throw createHttpError("bucket_not_found", 404, "Storage bucket not found");
  }
  state.storage.buckets = ensureBucket(normalizeBuckets(state.storage.buckets, state.storage.bucket), name);
  return state.storage.buckets.find((item) => item.name === name);
}

function requireActiveStorageBucket(state, bucketName) {
  const bucket = requireStorageBucket(state, bucketName);
  if (bucket.disabledAt) {
    throw createHttpError("bucket_disabled", 409, "Storage bucket is disabled");
  }
  return bucket;
}

function findNextActiveBucket(state, currentBucketName) {
  return normalizeBuckets(state.storage.buckets, state.storage.bucket)
    .find((bucket) => bucket.name !== currentBucketName && !bucket.disabledAt);
}

function cleanPrefix(input) {
  const text = String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!text || /^[A-Za-z]:/.test(text)) {
    throw validationError("Storage prefix must be relative");
  }
  for (const part of text.split("/")) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001F]/.test(part)) {
      throw validationError("Storage prefix contains an invalid segment");
    }
  }
  return text;
}

function cleanHost(input) {
  const text = String(input || "").trim();
  if (!text || /[/:?#\s]/.test(text)) {
    throw validationError("Public host must be a host name or IP without scheme or port");
  }
  return text;
}

function cleanTransportPath(input) {
  const text = String(input || "").trim();
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,240}$/.test(text) || text.includes("//") || text.includes("..")) {
    throw validationError("Tunnel WebSocket path must be an absolute safe URL path");
  }
  return text;
}

function cleanUrl(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw validationError("URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw validationError("URL must use http or https");
  }
  return url.toString().replace(/\/$/g, "");
}

function cleanClaimServerOrigin(input) {
  try {
    return normalizeClaimServer(input);
  } catch (error) {
    throw validationError(error.message);
  }
}

function normalizeRealityConfig(input = {}) {
  return {
    serverName: cleanServerName(input.serverName || DEFAULT_REALITY_SERVER_NAME),
    fingerprint: String(input.fingerprint || "chrome").trim(),
    publicKey: String(input.publicKey || "").trim(),
    privateKey: String(input.privateKey || "").trim(),
    shortId: String(input.shortId || "").trim().toLowerCase()
  };
}

function validateRealityConfig(reality = {}) {
  if (!reality.fingerprint || !/^[A-Za-z0-9_-]+$/.test(reality.fingerprint)) {
    throw validationError("REALITY fingerprint must be a non-empty uTLS fingerprint name");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(reality.publicKey || "")) {
    throw validationError("REALITY public key must be a 43 character base64url X25519 key");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(reality.privateKey || "")) {
    throw validationError("REALITY private key must be a 43 character base64url X25519 key");
  }
  if (!/^[0-9a-f]{2,16}$/.test(reality.shortId || "") || reality.shortId.length % 2 !== 0) {
    throw validationError("REALITY short id must be 1-8 bytes of hexadecimal text");
  }
  return reality;
}

function cleanServerName(input) {
  const text = String(input || "").trim();
  if (!text || /[/:?#\s]/.test(text)) {
    throw validationError("REALITY SNI must be a host name without scheme or port");
  }
  return text;
}

function readPort(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw validationError("Port must be between 1 and 65535");
  }
  return value;
}

export function normalizeProfileDefaults(baseDefaults = {}, overrideDefaults = undefined) {
  if (
    overrideDefaults !== undefined
    && overrideDefaults !== null
    && (typeof overrideDefaults !== "object" || Array.isArray(overrideDefaults))
  ) {
    throw validationError("defaults must be an object");
  }
  const defaults = {
    ...baseDefaults,
    ...(overrideDefaults || {})
  };
  return {
    ...defaults,
    localProxyPort: normalizeProfilePort(defaults.localProxyPort, DEFAULTS.localProxyPort, "defaults.localProxyPort"),
    transfers: normalizeProfilePositiveInteger(defaults.transfers, 4, "defaults.transfers"),
    streams: normalizeProfilePositiveInteger(defaults.streams, 8, "defaults.streams"),
    checkers: normalizeProfilePositiveInteger(defaults.checkers, 8, "defaults.checkers"),
    chunkSize: normalizeProfileChunkSize(defaults.chunkSize, "16M"),
    retries: normalizeProfilePositiveInteger(defaults.retries, 3, "defaults.retries"),
    lowLevelRetries: normalizeProfilePositiveInteger(defaults.lowLevelRetries, 10, "defaults.lowLevelRetries")
  };
}

function normalizeProfilePort(input, fallback, field) {
  const value = input === undefined || input === null ? fallback : input;
  if (typeof value === "boolean" || typeof value === "object") {
    throw validationError(`${field} must be an integer between 1 and 65535`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw validationError(`${field} must be an integer between 1 and 65535`);
  }
  return number;
}

function normalizeProfilePositiveInteger(input, fallback, field) {
  const value = input === undefined || input === null ? fallback : input;
  if (typeof value === "boolean" || typeof value === "object") {
    throw validationError(`${field} must be an integer between 1 and 1024`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1024) {
    throw validationError(`${field} must be an integer between 1 and 1024`);
  }
  return number;
}

function normalizeProfileChunkSize(input, fallback) {
  const value = input === undefined || input === null ? fallback : input;
  if (typeof value !== "string" || !value.trim()) {
    throw validationError("defaults.chunkSize must be a non-empty string");
  }
  return value.trim();
}

function readNumber(input, fallback) {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveInteger(input, fallback) {
  const value = Number(input);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(input, fallback) {
  const value = Number(input);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function cleanRequiredCredential(input, field) {
  if (typeof input !== "string" || !input.trim()) {
    throw validationError(`${field} must be a non-empty string`);
  }
  return input.trim();
}

// Masked secrets must not leak any plaintext. The previous form kept the first
// and last three characters, which is a meaningful disclosure for short or
// low-entropy secrets and lets an observer confirm a guessed value. The mask is
// always the literal "***": it is the documented sentinel meaning "keep the
// existing secret" on write paths (see preserveExistingMasked* below and
// docs/INTERFACE_CONTRACT.md), it satisfies the masked-secret contract for
// absent values too, and a fixed width hides the real secret length.
export function maskSecret() {
  return "***";
}

function maskRealityConfig(reality = {}) {
  return {
    ...reality,
    privateKey: maskSecret(reality.privateKey)
  };
}

function preserveExistingMaskedRealitySecrets(reality = {}) {
  const patch = { ...reality };
  const privateKey = String(patch.privateKey || "").trim();
  if (!privateKey || privateKey.includes("***")) {
    delete patch.privateKey;
  }
  return patch;
}

function preserveExistingMaskedStorageSecrets(input = {}) {
  const patch = { ...input };
  const secretAccessKey = String(patch.secretAccessKey || "").trim();
  if (!secretAccessKey || secretAccessKey.includes("***")) {
    delete patch.secretAccessKey;
  }
  return patch;
}

function throwDangerConfirmationRequired(message) {
  const error = new Error("danger_confirmation_required");
  error.code = "danger_confirmation_required";
  error.status = 400;
  error.publicMessage = message;
  throw error;
}

function validationError(message) {
  return createHttpError("validation_failed", 400, message);
}

function touch(state) {
  state.updatedAt = new Date().toISOString();
}
