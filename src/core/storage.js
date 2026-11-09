import { isAbsolute, posix, win32 } from "node:path";

const SFTP_TRANSPORT_FIELDS = Object.freeze([
  "host",
  "port",
  "user",
  "socksProxy",
  "knownHostsFile",
  "keyFile",
  "hostKeyFingerprint",
  "credentialRevision"
]);

export function describeStorageTarget(job = {}) {
  const storageBackend = job.storageBackend || "s3";
  if (storageBackend === "sftp") {
    return describeSftpStorageTarget(job);
  }
  if (storageBackend !== "s3") {
    throw new Error("Unsupported storage backend");
  }

  const remoteName = sanitizeRemoteName(job.remoteName || "home-minio");
  const bucketName = sanitizeBucketName(job.bucketName || job.bucket || "home-sync");
  const clientName = sanitizePathSegment(job.clientName || "default-client");
  const folder = sanitizeRemoteFolder(job.remoteFolder || job.serverSubdir || job.name || "sync");
  const namespace = job.serverSpace === "shared" ? "shared" : `devices/${clientName}`;
  const prefix = job.remotePrefix ? sanitizeRemoteFolder(job.remotePrefix) : `${namespace}/${folder}`;

  return {
    storageBackend,
    provider: "Minio",
    remoteName,
    bucketName,
    clientName,
    prefix,
    remotePath: `${remoteName}:${bucketName}/${prefix}`,
    endpoint: normalizeEndpoint(job.s3Endpoint || job.endpoint || "http://minio:9000"),
    region: String(job.s3Region || job.region || "us-east-1")
  };
}

function describeSftpStorageTarget(job) {
  assertNoSftpSecretMaterial(job);
  if (Object.hasOwn(job, "remotePath") || Object.hasOwn(job, "remotePrefix")) {
    throw new Error("SFTP jobs must use rootPath as the canonical remote root");
  }
  const remoteName = sanitizeRemoteName(job.remoteName);
  const rootPath = normalizeSftpRootPath(job.rootPath);
  const clientName = sanitizePathSegment(job.clientName || "default-client");
  return {
    storageBackend: "sftp",
    remoteName,
    clientName,
    rootPath,
    remotePath: `${remoteName}:${rootPath}`
  };
}

export function buildStorageRemotePath(job = {}) {
  return describeStorageTarget(job).remotePath;
}

export function sanitizeRemoteFolder(input) {
  const text = String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (!text) {
    throw new Error("Remote folder is required");
  }
  if (/^[A-Za-z]:/.test(text)) {
    throw new Error("Remote folder must be relative, not a Windows drive path");
  }

  return text.split("/").filter(Boolean).map(sanitizePathSegment).join("/");
}

export function normalizeSftpRootPath(input) {
  if (typeof input !== "string") {
    throw new Error("SFTP rootPath must be a canonical relative virtual path");
  }
  const text = input;
  if (text !== text.trim()
    || text.includes("\\")
    || text.startsWith("/")
    || /^[A-Za-z]:/.test(text)
    || /[:\u0000-\u001F\u007F]/.test(text)) {
    throw new Error("SFTP rootPath must be a canonical relative virtual path");
  }
  if (text === "") {
    return "";
  }
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("SFTP rootPath must be a canonical relative virtual path");
  }
  return parts.join("/");
}

export function normalizeSftpTransport(input) {
  if (!isPlainObject(input)) {
    throw new Error("SFTP transport options are required");
  }
  const expectedKeys = [...SFTP_TRANSPORT_FIELDS].sort();
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("SFTP transport options contain unsupported fields");
  }
  const host = normalizeSftpText(input.host, "SFTP host");
  const user = normalizeSftpText(input.user, "SFTP user");
  const port = normalizeSftpPort(input.port);
  const socksProxy = normalizeSftpSocksProxy(input.socksProxy);
  const knownHostsFile = normalizeAbsoluteSftpPath(input.knownHostsFile, "knownHostsFile");
  const keyFile = normalizeAbsoluteSftpPath(input.keyFile, "keyFile");
  const hostKeyFingerprint = String(input.hostKeyFingerprint || "").trim();
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint)) {
    throw new Error("SFTP hostKeyFingerprint must use SHA256 OpenSSH format");
  }
  const credentialRevision = normalizeSftpText(input.credentialRevision, "SFTP credentialRevision");
  return Object.freeze({
    host,
    port,
    user,
    socksProxy,
    knownHostsFile,
    keyFile,
    hostKeyFingerprint,
    credentialRevision
  });
}

export function assertNoSftpSecretMaterial(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(value)) {
      throw new Error("SFTP secret material must stay outside jobs and transport options");
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "pass"
      || normalized.includes("password")
      || normalized.includes("passphrase")
      || normalized === "keypem"
      || normalized.includes("privatekey")
      || normalized === "secret"
      || normalized.includes("secretaccesskey")
      || normalized.includes("sessiontoken")) {
      throw new Error("SFTP secret material must stay outside jobs and transport options");
    }
    assertNoSftpSecretMaterial(nested, seen);
  }
}

function normalizeSftpText(value, field) {
  const text = String(value || "");
  if (!text || text !== text.trim() || /[\u0000-\u001F\u007F]/.test(text) || /\s/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeSftpPort(value) {
  const port = typeof value === "number" ? value : Number(String(value || ""));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SFTP port is invalid");
  }
  return port;
}

function normalizeSftpSocksProxy(value) {
  const text = String(value || "");
  const bracketedMatch = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  const match = bracketedMatch || /^([^:]+):(\d+)$/.exec(text);
  if (!match
    || /[\/@?#\s\u0000-\u001F\u007F]/.test(text)
    || !isLoopbackHost(match[1])
    || (bracketedMatch && match[1].toLowerCase() !== "::1")) {
    throw new Error("SFTP socksProxy must be an explicit loopback host:port");
  }
  const host = bracketedMatch ? `[${match[1]}]` : match[1];
  return `${host}:${normalizeSftpPort(match[2])}`;
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizeAbsoluteSftpPath(value, field) {
  const text = String(value || "");
  if (!text
    || text !== text.trim()
    || /[\u0000-\u001F\u007F]/.test(text)
    || (!isAbsolute(text) && !win32.isAbsolute(text) && !posix.isAbsolute(text))) {
    throw new Error(`SFTP ${field} must be an absolute path`);
  }
  return text;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A remote name becomes the leading part of the positional `name:bucket/prefix`
// argument passed to rclone. rclone (cobra/pflag) parses any positional starting
// with `-` as flags, so a name like `-P` would inject CLI options into the
// client's own rclone invocation. Requiring an alphanumeric first character
// closes that off. Single source of truth for every caller that builds a remote.
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const REMOTE_NAME_MESSAGE = "Remote name must start with a letter or number and can only contain letters, numbers, _ and -";

export function sanitizeRemoteName(input, makeError = (message) => new Error(message)) {
  const text = String(input || "").trim();
  if (!REMOTE_NAME_PATTERN.test(text)) {
    throw makeError(REMOTE_NAME_MESSAGE);
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

function sanitizePathSegment(input) {
  const text = String(input || "").trim();
  if (!text || text === "." || text === "..") {
    throw new Error("Remote folder cannot contain empty, . or .. path segments");
  }
  if (/[<>:"|?*\u0000-\u001F]/.test(text)) {
    throw new Error(`Invalid path segment: ${text}`);
  }
  return text;
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
