import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export function sftpAccessMarkerName(rootId) {
  if (typeof rootId !== "string" || !/^root_[A-Za-z0-9_-]{16,128}$/.test(rootId)) {
    throw accessMarkerError("sftp_access_marker_invalid", "SFTP access marker requires a verified root ID");
  }
  return `.syncraft-access-${rootId}`;
}

export function sftpAccessMarkerContents(rootId) {
  sftpAccessMarkerName(rootId);
  return `syncraft-sftp-access-v1\nrootId=${rootId}\n`;
}

/** Create or validate the local and remote bisync access marker without replacing existing files. */
export async function ensureSftpAccessMarkers({
  localRoot,
  remoteRoot,
  rootId,
  createMissing = false,
  markerSourceFile,
  rcloneBin,
  rcloneConfigPath,
  env,
  runBuffered,
  timeoutMs = 15000
} = {}) {
  const markerName = sftpAccessMarkerName(rootId);
  const contents = sftpAccessMarkerContents(rootId);
  if (typeof localRoot !== "string" || !localRoot || typeof remoteRoot !== "string" || !remoteRoot
    || typeof runBuffered !== "function" || typeof rcloneBin !== "string" || !rcloneBin) {
    throw accessMarkerError("sftp_access_marker_invalid", "SFTP access marker inputs are incomplete");
  }
  if (createMissing && (!markerSourceFile || typeof markerSourceFile !== "string")) {
    throw accessMarkerError("sftp_access_marker_invalid", "SFTP marker creation requires a temporary marker file");
  }

  await ensureLocalMarker(localRoot, markerName, contents, createMissing);
  const remoteMarkerPath = appendRemotePath(remoteRoot, markerName);
  if (createMissing) {
    const copied = await runBuffered(rcloneBin, [
      "copyto", markerSourceFile, remoteMarkerPath,
      "--ignore-existing", "--immutable",
      ...(rcloneConfigPath ? ["--config", rcloneConfigPath] : [])
    ], { env, timeoutMs });
    if (!copied.ok) {
      throw accessMarkerError("sftp_access_marker_write_failed", "Could not create the SFTP access marker without replacing an existing file");
    }
  }
  const readBack = await runBuffered(rcloneBin, [
    "cat", remoteMarkerPath, "--head", String(contents.length + 1),
    ...(rcloneConfigPath ? ["--config", rcloneConfigPath] : [])
  ], { env, timeoutMs });
  if (!readBack.ok) {
    throw accessMarkerError(createMissing ? "sftp_access_marker_conflict" : "sftp_access_marker_missing",
      createMissing ? "An existing SFTP access marker does not match this authorized root" : "The initialized SFTP access marker is missing");
  }
  if (readBack.stdout !== contents) {
    throw accessMarkerError("sftp_access_marker_conflict", "The SFTP access marker does not match this authorized root");
  }
  return { markerName, remoteMarkerPath, contents };
}

async function ensureLocalMarker(localRoot, markerName, contents, createMissing) {
  const markerPath = join(localRoot, markerName);
  const current = await readLocalMarker(markerPath, contents.length);
  if (current === "missing") {
    if (!createMissing) throw accessMarkerError("sftp_access_marker_missing", "The initialized local SFTP access marker is missing");
    let handle;
    try {
      handle = await open(markerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } catch (error) {
      if (error?.code !== "EEXIST") throw accessMarkerError("sftp_access_marker_write_failed", "Could not create the local SFTP access marker");
    } finally {
      await handle?.close().catch(() => {});
    }
    const created = await readLocalMarker(markerPath, contents.length);
    if (created !== contents) throw accessMarkerError("sftp_access_marker_conflict", "The local SFTP access marker does not match this authorized root");
    return;
  }
  if (current !== contents) throw accessMarkerError("sftp_access_marker_conflict", "An existing local file conflicts with the SFTP access marker");
}

async function readLocalMarker(markerPath, maxBytes) {
  const info = await lstat(markerPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return "missing";
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
    throw accessMarkerError("sftp_access_marker_conflict", "An existing local file conflicts with the SFTP access marker");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(markerPath, flags);
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.size > maxBytes) {
      throw accessMarkerError("sftp_access_marker_conflict", "An existing local file conflicts with the SFTP access marker");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function appendRemotePath(root, relative) {
  return root.endsWith(":") ? `${root}/${relative}` : `${root.replace(/\/+$/, "")}/${relative}`;
}

function accessMarkerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
