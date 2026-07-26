import { sanitizeRemoteName } from "./storage.js";

export function buildServerFolderRemotePath(job) {
  const remoteName = sanitizeRemoteName(job.remoteName || "server-folder");
  const clientName = sanitizePathSegment(job.clientName || "default-client");
  const subdir = sanitizeServerSubdir(job.serverSubdir || job.name || "sync");
  const namespace = job.serverSpace === "shared" ? "shared" : `devices/${clientName}`;

  return `${remoteName}:${namespace}/${subdir}`;
}

export function sanitizeServerSubdir(input) {
  const text = String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (!text) {
    throw new Error("Server folder is required");
  }
  if (/^[A-Za-z]:/.test(text)) {
    throw new Error("Server folder must be relative, not a Windows drive path");
  }

  const parts = text.split("/").filter(Boolean).map(sanitizePathSegment);
  return parts.join("/");
}

function sanitizePathSegment(input) {
  const text = String(input || "").trim();
  if (!text || text === "." || text === "..") {
    throw new Error("Server folder cannot contain empty, . or .. path segments");
  }
  if (/[<>:"|?*\u0000-\u001F]/.test(text)) {
    throw new Error(`Invalid path segment: ${text}`);
  }
  return text;
}
