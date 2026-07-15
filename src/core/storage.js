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

function sanitizeRemoteName(input) {
  const text = String(input || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("Remote name can only contain letters, numbers, _ and -");
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
