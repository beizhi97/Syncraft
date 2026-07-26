export function describeStorageTarget(job = {}) {
  const storageBackend = job.storageBackend || "s3";
  if (storageBackend !== "s3") {
    throw new Error("Only S3-compatible MinIO storage is supported");
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
