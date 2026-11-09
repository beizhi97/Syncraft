import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Exercise directory listing and a uniquely named write/read/delete cycle.
 * The remote file is removed only after its contents prove it is this probe's
 * file. In particular, a name collision or an unreadable file is never deleted.
 */
export async function probeSftpDirectory({
  rcloneBin,
  rcloneConfigPath = "",
  remoteRoot,
  env = {},
  runtimeRoot,
  runBuffered,
  timeoutMs = 15000,
  createProbeId = randomUUID,
  probeId: requestedProbeId,
  onProgress = async () => {},
  writeLocalProbe = writeProbeFile,
  removeLocalProbe = removeProbeFile
} = {}) {
  if (typeof rcloneBin !== "string" || !rcloneBin
    || typeof remoteRoot !== "string" || !remoteRoot
    || typeof runtimeRoot !== "string" || !runtimeRoot
    || typeof runBuffered !== "function") {
    throw repairError("connection_repair_invalid", "Connection repair probe inputs are incomplete");
  }

  const probeId = requestedProbeId || createProbeId();
  if (typeof probeId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(probeId)) {
    throw repairError("connection_repair_invalid", "Connection repair probe ID is invalid");
  }
  const filename = `.syncraft-connection-probe-${probeId}.tmp`;
  const remoteProbePath = appendRemotePath(remoteRoot, filename);
  const localProbePath = join(runtimeRoot, `connection-repair-${probeId}.tmp`);
  const contents = `syncraft-connection-probe-v1\n${probeId}\n`;
  const contentsSha256 = createHash("sha256").update(contents).digest("hex");
  const commonArgs = rcloneConfigPath ? ["--config", rcloneConfigPath] : [];
  let localProbeCreated = false;
  let remoteProbeOwned = false;

  try {
    const listed = await runBuffered(rcloneBin, [
      "lsjson", remoteRoot, "--max-depth", "1", "--no-mimetype", ...commonArgs
    ], { env, timeoutMs });
    if (!listed.ok) {
      throw commandFailure("connection_repair_list_failed", "Could not list the authorized directory", listed);
    }

    try {
      await writeLocalProbe(localProbePath, contents);
      localProbeCreated = true;
    } catch (error) {
      if (error?.code !== "EEXIST" || await readFile(localProbePath, "utf8").catch(() => null) !== contents) {
        throw repairError("connection_repair_probe_conflict", "The local probe path is occupied and was left untouched");
      }
      localProbeCreated = true;
    }
    await onProgress({ stage: "probe_write_started", remotePath: remoteProbePath, sha256: contentsSha256 });
    const copied = await runBuffered(rcloneBin, [
      "copyto", localProbePath, remoteProbePath,
      "--ignore-existing", "--immutable", ...commonArgs
    ], { env, timeoutMs });
    if (!copied.ok) {
      throw commandFailure("connection_repair_write_failed", "Could not write the connection probe file", copied);
    }
    await onProgress({ stage: "probe_written", remotePath: remoteProbePath, sha256: contentsSha256 });

    const readBack = await runProbeCommand(runBuffered, rcloneBin, [
      "cat", remoteProbePath, "--head", String(Buffer.byteLength(contents) + 1), ...commonArgs
    ], { env, timeoutMs });
    if (!readBack.ok) {
      throw commandFailure("connection_repair_read_failed", "Could not read back the connection probe file", readBack);
    }
    if (readBack.stdout !== contents) {
      throw repairError("connection_repair_probe_conflict", "The probe file contents do not match; it was left untouched");
    }
    remoteProbeOwned = true;
    await onProgress({ stage: "probe_verified", remotePath: remoteProbePath, sha256: contentsSha256 });

    await onProgress({ stage: "probe_cleanup_started", remotePath: remoteProbePath, sha256: contentsSha256 });
    const cleanupCheck = await runProbeCommand(runBuffered, rcloneBin, [
      "cat", remoteProbePath, "--head", String(Buffer.byteLength(contents) + 1), ...commonArgs
    ], { env, timeoutMs });
    if (!cleanupCheck.ok || cleanupCheck.stdout !== contents) {
      remoteProbeOwned = false;
      throw repairError("connection_repair_probe_conflict", "The probe file changed before cleanup and was left untouched");
    }
    const removed = await runBuffered(rcloneBin, [
      "deletefile", remoteProbePath, ...commonArgs
    ], { env, timeoutMs });
    if (!removed.ok) {
      throw commandFailure("connection_repair_cleanup_failed", "Could not remove the verified connection probe file", removed);
    }
    remoteProbeOwned = false;
    await onProgress({ stage: "probe_cleaned", remotePath: remoteProbePath, sha256: contentsSha256 });
    return { list: "passed", write: "passed", read: "passed", cleanup: "passed" };
  } catch (error) {
    // On interrupted or timed-out operations, try to identify the exact file
    // before cleanup. A random filename alone is never grounds for deletion.
    const stillOwned = error?.code === "connection_repair_cleanup_failed"
      ? false
      : await verifyRemoteProbeContents({
      runBuffered, rcloneBin, remoteProbePath, contents, commonArgs, env, timeoutMs
    });
    if (stillOwned) {
      await onProgress({ stage: "probe_cleanup_started", remotePath: remoteProbePath, sha256: contentsSha256 }).catch(() => {});
      const removed = await runBuffered(rcloneBin, [
        "deletefile", remoteProbePath, ...commonArgs
      ], { env, timeoutMs }).catch(() => ({ ok: false }));
      if (!removed.ok) {
        throw repairError("connection_repair_cleanup_failed", "The verified probe file could not be removed; administrator inspection is required");
      }
      await onProgress({ stage: "probe_cleaned", remotePath: remoteProbePath, sha256: contentsSha256 }).catch(() => {});
    }
    throw error;
  } finally {
    if (localProbeCreated) {
      await removeLocalProbe(localProbePath).catch(() => {
        throw repairError("connection_repair_cleanup_failed", "The local runtime probe file could not be removed");
      });
    }
  }
}

export function normalizeConnectionRepairJournal(value) {
  if (value == null) return { version: 1, activeOperationId: null, operations: {} };
  if (value.version !== 1 || !value.operations || typeof value.operations !== "object" || Array.isArray(value.operations)) {
    throw repairError("local_state_corrupt", "Connection repair operation state is invalid");
  }
  return value;
}

export function upsertConnectionRepairOperation(journal, operation) {
  const current = normalizeConnectionRepairJournal(journal);
  const operations = { ...current.operations, [operation.operationId]: operation };
  const activeOperationId = operation.status === "running"
    ? operation.operationId
    : current.activeOperationId === operation.operationId ? null : current.activeOperationId;
  return { ...current, version: 1, activeOperationId, operations };
}

/** Read/write/delete check for a selected local task directory. */
export async function probeLocalDirectory({
  localRoot,
  createProbeId = randomUUID,
  probeId: requestedProbeId,
  onProgress = async () => {}
} = {}) {
  if (typeof localRoot !== "string" || !localRoot) {
    throw repairError("invalid_path", "Select an existing local directory before repairing this task");
  }
  const probeId = requestedProbeId || createProbeId();
  if (typeof probeId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(probeId)) {
    throw repairError("connection_repair_invalid", "Connection repair probe ID is invalid");
  }
  const path = join(localRoot, `.syncraft-connection-probe-${probeId}.tmp`);
  const contents = `syncraft-local-connection-probe-v1\n${probeId}\n`;
  const sha256 = createHash("sha256").update(contents).digest("hex");
  let created = false;
  try {
    await onProgress({ stage: "local_probe_write_started", path, sha256 });
    try {
      await writeProbeFile(path, contents);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST" || await readFile(path, "utf8").catch(() => null) !== contents) {
        throw repairError("connection_repair_probe_conflict", "The local probe path is occupied and was left untouched");
      }
      created = true;
    }
    const readBack = await readFile(path, "utf8");
    if (readBack !== contents) {
      throw repairError("connection_repair_read_failed", "The local connection probe contents do not match");
    }
  } finally {
    if (created) {
      let current;
      try {
        current = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw repairError("connection_repair_cleanup_failed", "The local probe file could not be verified for cleanup");
        }
        current = null;
      }
      if (current != null && current !== contents) {
        throw repairError("connection_repair_probe_conflict", "The local probe file changed and was left untouched");
      }
      if (current === contents) {
        await rm(path, { force: true }).catch(() => {
          throw repairError("connection_repair_cleanup_failed", "The local probe file could not be removed");
        });
        await onProgress({ stage: "local_probe_cleaned", path, sha256 });
      }
    }
  }
  return "passed";
}

async function writeProbeFile(path, contents) {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function removeProbeFile(path) {
  await rm(path, { force: true });
}

async function verifyRemoteProbeContents({ runBuffered, rcloneBin, remoteProbePath, contents, commonArgs, env, timeoutMs }) {
  const result = await runProbeCommand(runBuffered, rcloneBin, [
    "cat", remoteProbePath, "--head", String(Buffer.byteLength(contents) + 1), ...commonArgs
  ], { env, timeoutMs }).catch(() => null);
  return result?.ok === true && result.stdout === contents;
}

async function runProbeCommand(runBuffered, rcloneBin, args, options) {
  let result = await runBuffered(rcloneBin, args, options);
  // Listing and reading are idempotent. Retry a timeout once; writes and
  // deletes are never blindly replayed.
  if (!result.ok && result.timedOut) result = await runBuffered(rcloneBin, args, options);
  return result;
}

function appendRemotePath(root, relative) {
  return root.endsWith(":") ? `${root}/${relative}` : `${root.replace(/\/+$/, "")}/${relative}`;
}

function commandFailure(code, message, result = {}) {
  const error = repairError(code, message);
  error.retryable = Boolean(result.timedOut);
  return error;
}

function repairError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
