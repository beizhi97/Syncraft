import { parseVlessUri } from "./vless.js";
import { normalizeBandwidthLimit } from "./bandwidth.js";
import { normalizeSyncSafety } from "./syncSafety.js";
import { normalizeSchedule } from "./scheduler.js";
import { createHttpError } from "./errors.js";
import { sanitizeRemoteName } from "./storage.js";
import { normalizePositiveInteger, normalizeTcpPort } from "./numbers.js";
import { SYNC_SPACE_MODES, deriveAuthorization, normalizeSyncSpaceMode } from "./syncSpaceMode.js";

export const PROFILE_VERSION = 2;
// v2 新增 syncSpace 与 authorization 两块。仍接受 v1：离线导入的旧 profile 是真实用例，
// 而 v1 载荷根本不携带角色，服务端无从补出来，因此 v1 归一化后不带这两块。
export const SUPPORTED_PROFILE_VERSIONS = Object.freeze([1, 2]);
// 前缀标识信封编码，没有变；版本在载荷里自述。若前缀也改成 v2#，旧客户端会在解码阶段
// 报 import_code_invalid（「导入码格式不对」），而不是 unsupported_profile_version
// （「请升级客户端」）——后者才是可执行的提示。
export const PROFILE_URI_PREFIX = "sfsc://import/v1#";
export const PROFILE_CODE_PREFIX = "SFSC1-";

export function encodeImportProfile(input, options = {}) {
  const profile = normalizeImportProfile(input);
  const payload = base64UrlEncode(JSON.stringify(profile));
  return options.format === "code" ? `${PROFILE_CODE_PREFIX}${payload}` : `${PROFILE_URI_PREFIX}${payload}`;
}

export function decodeImportProfile(text) {
  return normalizeImportProfile(decodeImportProfilePayload(text));
}

export function decodeImportProfilePayload(text) {
  const raw = String(text || "").trim();
  let payload;

  if (raw.startsWith(PROFILE_URI_PREFIX)) {
    payload = raw.slice(PROFILE_URI_PREFIX.length);
  } else if (raw.startsWith(PROFILE_CODE_PREFIX)) {
    payload = raw.slice(PROFILE_CODE_PREFIX.length);
  } else {
    throw createHttpError("import_code_invalid", 400, "Import code must start with sfsc://import/v1# or SFSC1-");
  }

  let decoded;
  try {
    decoded = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw createHttpError("import_code_invalid", 400, "Import code payload is invalid");
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw createHttpError("import_code_invalid", 400, "Import code payload is invalid");
  }
  return decoded;
}

export function normalizeImportProfile(input = {}) {
  if (input.version != null && !SUPPORTED_PROFILE_VERSIONS.includes(input.version)) {
    throw createHttpError("unsupported_profile_version", 400, "Profile or SyncKey version is unsupported");
  }
  const version = input.version == null ? PROFILE_VERSION : input.version;
  if (input.type === "claim") {
    throw createHttpError("import_code_invalid", 400, "SyncKey payload is invalid for offline profile import");
  }
  const clientName = sanitizeName(input.clientName || "company-pc1");
  const tunnelUri = input.tunnel?.uri || input.vlessUri || input.uri;
  if (!tunnelUri) {
    throw createHttpError("profile_tunnel_required", 400, "Profile tunnel.uri is required");
  }
  const parsed = parseVlessUri(tunnelUri);

  const storage = input.storage || {};
  const defaults = input.defaults || {};
  const prefix = sanitizeRemotePrefix(storage.prefix || `devices/${clientName}`);
  const source = normalizeProfileSource(input.source);
  const syncSpace = normalizeProfileSyncSpace(input.syncSpace);
  // 方向在这里重新推导，不采信载荷里的数组：导入码经过用户之手，
  // 改一个 JSON 字段就能给自己加上写权限的协议是不能接受的。
  // 存储层（minioPolicy）仍是最终权威，这一层负责让界面表达不出非法状态。
  const authorization = syncSpace
    ? deriveAuthorization({
        mode: syncSpace.mode,
        role: input.authorization?.role,
        policy: { allowDelete: input.authorization?.allowDelete === true }
      })
    : null;

  return {
    version,
    profileId: String(input.profileId || `profile-${clientName}`).trim(),
    clientName,
    issuedAt: input.issuedAt || new Date(0).toISOString(),
    expiresAt: input.expiresAt || null,
    ...(source ? { source } : {}),
    ...(syncSpace ? { syncSpace } : {}),
    ...(authorization ? { authorization } : {}),
    tunnel: {
      type: "vless",
      uri: tunnelUri,
      parsed
    },
    heartbeat: normalizeHeartbeatProfile(input.heartbeat),
    storage: {
      type: "s3",
      remoteName: sanitizeRemoteName(storage.remoteName || "home-minio"),
      // The http endpoint default is container-internal by architecture: the
      // client only reaches it through the encrypted VLESS tunnel (rclone runs
      // with a process-scoped SOCKS5 proxy) and compose binds MinIO to
      // loopback on the host, so plaintext http never crosses a public network.
      endpoint: normalizeEndpoint(storage.endpoint || "http://minio:9000"),
      bucket: sanitizeBucketName(storage.bucket || "home-sync"),
      accessKeyId: String(storage.accessKeyId || clientName).trim(),
      // CHANGE_ME_CLIENT_SECRET is a contract-registered compatibility fill for
      // manual/legacy offline profiles only (INTERFACE_CONTRACT.md offline
      // profile rules): it can never authenticate against a provisioned MinIO.
      // Server-issued profiles (claim redeem, offline with source.server) are
      // validated fail-closed in client/src/profileImport.js and must return
      // profile_storage_required instead of ever reaching this default.
      secretAccessKey: String(storage.secretAccessKey || "CHANGE_ME_CLIENT_SECRET").trim(),
      prefix
    },
    defaults: {
      localProxyPort: normalizeTcpPort(defaults.localProxyPort, { field: "defaults.localProxyPort", defaultValue: 18081 }),
      transfers: normalizePositiveInteger(defaults.transfers, { field: "defaults.transfers", defaultValue: 4 }),
      streams: normalizePositiveInteger(defaults.streams, { field: "defaults.streams", defaultValue: 8 }),
      checkers: normalizePositiveInteger(defaults.checkers, { field: "defaults.checkers", defaultValue: 8 }),
      chunkSize: String(defaults.chunkSize || "16M"),
      retries: normalizePositiveInteger(defaults.retries, { field: "defaults.retries", defaultValue: 3 }),
      lowLevelRetries: normalizePositiveInteger(defaults.lowLevelRetries, { field: "defaults.lowLevelRetries", defaultValue: 10 }),
      bandwidthLimit: normalizeBandwidthLimit(defaults.bandwidthLimit || "off"),
      schedule: normalizeSchedule(defaults.schedule || { mode: "manual" })
    }
  };
}

function normalizeProfileSource(input = null) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const server = String(input.server || "").trim();
  if (!server) {
    return null;
  }
  return {
    type: sanitizeSourceType(input.type || "profile"),
    server: normalizeSourceServer(server)
  };
}

// 空间标识与用途。displayName 不在协议里：syncId 已经是面向用户的名称
// （docs/SYNC_ID_PRODUCT_REQUIREMENT.md），再给同一事物第二个名字正是本轮要消除的东西。
function normalizeProfileSyncSpace(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const id = String(input.id || "").trim();
  const syncId = String(input.syncId || "").trim();
  if (!id || !syncId) {
    return null;
  }
  const mode = String(input.mode || "").trim().toLowerCase();
  // 未知用途不静默退回默认值：默认值是分发，会把只能上传的成员显示成可下载。
  if (!SYNC_SPACE_MODES.includes(mode)) {
    throw createHttpError("unsupported_profile_version", 400, "Profile syncSpace.mode is unsupported");
  }
  return { id, syncId, mode: normalizeSyncSpaceMode(mode) };
}

function sanitizeSourceType(input) {
  const text = String(input || "").trim();
  return /^[a-z][a-z0-9-]{0,31}$/.test(text) ? text : "profile";
}

function normalizeSourceServer(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Profile source server must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Profile source server must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeHeartbeatProfile(input = null) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const secret = String(input.secret || "").trim();
  if (!secret) {
    return null;
  }
  return {
    scheme: String(input.scheme || "sfsc-hmac-sha256-v1").trim(),
    secret
  };
}

export function buildJobFromProfile(profile, job = {}) {
  const normalized = normalizeImportProfile(profile);
  const defaults = normalized.defaults;
  const direction = job.direction || "upload";
  const remoteFolder = job.remoteFolder ? sanitizeRemotePrefix(job.remoteFolder) : "";
  const serverSpace = job.serverSpace === "shared" ? "shared" : "device";
  const transfers = normalizePositiveInteger(job.transfers, { field: "job.transfers", defaultValue: defaults.transfers });
  const streams = normalizePositiveInteger(job.streams, { field: "job.streams", defaultValue: defaults.streams });
  const checkers = normalizePositiveInteger(job.checkers, { field: "job.checkers", defaultValue: defaults.checkers });
  const retries = normalizePositiveInteger(job.retries, { field: "job.retries", defaultValue: defaults.retries });
  const lowLevelRetries = normalizePositiveInteger(job.lowLevelRetries, {
    field: "job.lowLevelRetries",
    defaultValue: defaults.lowLevelRetries
  });
  const s3UploadConcurrency = normalizePositiveInteger(job.s3UploadConcurrency, {
    field: "job.s3UploadConcurrency",
    defaultValue: streams
  });
  return {
    name: job.name || `${normalized.clientName}-sync`,
    direction,
    localPath: job.localPath || "",
    clientName: normalized.clientName,
    remoteName: normalized.storage.remoteName,
    bucketName: normalized.storage.bucket,
    remotePrefix: deriveJobRemotePrefix(normalized.storage.prefix, remoteFolder, serverSpace),
    remoteFolder,
    serverSpace,
    storageBackend: "s3",
    s3Endpoint: normalized.storage.endpoint,
    accessKeyId: normalized.storage.accessKeyId,
    secretAccessKey: normalized.storage.secretAccessKey,
    transfers,
    streams,
    checkers,
    s3UploadConcurrency,
    s3ChunkSize: job.s3ChunkSize || job.chunkSize || defaults.chunkSize,
    cutoff: job.cutoff || defaults.chunkSize,
    retries,
    lowLevelRetries,
    dryRun: Boolean(job.dryRun),
    destructiveSync: direction !== "bidirectional" && Boolean(job.destructiveSync),
    safety: normalizeSyncSafety(job.safety, direction),
    bandwidthLimit: normalizeBandwidthLimit(job.bandwidthLimit || defaults.bandwidthLimit),
    schedule: normalizeSchedule(job.schedule || defaults.schedule),
    localProxyPort: normalizeTcpPort(job.localProxyPort, { field: "job.localProxyPort", defaultValue: defaults.localProxyPort })
  };
}

function deriveJobRemotePrefix(profilePrefix, remoteFolder, serverSpace) {
  if (!remoteFolder) {
    return profilePrefix;
  }
  if (serverSpace === "shared") {
    return `shared/${remoteFolder}`;
  }
  return `${profilePrefix}/${remoteFolder}`;
}

export function summarizeImportProfile(profile) {
  const normalized = normalizeImportProfile(profile);
  return {
    profileId: normalized.profileId,
    clientName: normalized.clientName,
    server: `${normalized.tunnel.parsed.server}:${normalized.tunnel.parsed.port}`,
    storage: `${normalized.storage.bucket}/${normalized.storage.prefix}`,
    endpoint: normalized.storage.endpoint,
    localProxyPort: normalized.defaults.localProxyPort,
    // v2：UI 用这两块决定可选同步方向和显示空间真名。两者都不含密钥。
    // legacy/离线 profile 没有它们，为 null 时 UI 退回旧的「三个方向都可选」行为。
    syncSpace: normalized.syncSpace ? { ...normalized.syncSpace } : null,
    authorization: normalized.authorization
      ? { ...normalized.authorization, directions: [...normalized.authorization.directions] }
      : null
  };
}

function sanitizeName(input) {
  const text = String(input || "").trim();
  if (!text) {
    throw new Error("Client name is required");
  }
  if (text.length > 63) {
    throw new Error("Client name must be 1-63 characters");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("Client name can only contain letters, numbers, _ and -");
  }
  return text;
}

function sanitizeBucketName(input) {
  const text = String(input || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text) || text.includes("..")) {
    throw new Error("Bucket name must be a valid lowercase S3 bucket name");
  }
  return text;
}

function sanitizeRemotePrefix(input) {
  const text = String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!text) {
    throw new Error("Storage prefix is required");
  }
  if (/^[A-Za-z]:/.test(text)) {
    throw new Error("Storage prefix must be relative");
  }
  const parts = text.split("/").filter(Boolean);
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001F]/.test(part)) {
      throw new Error("Storage prefix contains an invalid segment");
    }
  }
  return parts.join("/");
}

function normalizeEndpoint(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("S3 endpoint must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("S3 endpoint must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const normalized = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}
