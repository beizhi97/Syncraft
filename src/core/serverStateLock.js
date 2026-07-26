import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname as readHostname } from "node:os";
import { join } from "node:path";
import { createHttpError } from "./errors.js";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const START_TIME_TOLERANCE_MS = 1_000;

export function acquireServerStateLock(options = {}) {
  const dataDir = String(options.dataDir || "");
  const statePath = String(options.statePath || "");
  const lockPath = options.lockPath || join(dataDir, "sfsc-state.lock");
  const ownerPath = join(lockPath, "owner.json");
  const heartbeatMs = positiveNumber(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const staleAfterMs = positiveNumber(options.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const currentHostname = readHostname();
  const owner = {
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: currentHostname,
    instanceId: process.env.SFSC_INSTANCE_ID || `local:${currentHostname}`,
    startedAt: new Date().toISOString(),
    processStartedAt,
    heartbeatAt: new Date().toISOString(),
    statePath
  };

  mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      try {
        writeOwner(ownerPath, owner);
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw createHttpError("server_state_write_failed", 500, `Failed to write server state lock owner: ${error.message}`);
      }
      // mkdir only proves nobody held the directory at creation time. Re-read the
      // owner file so a concurrent stale-lock reclaim that moved this directory
      // away is detected here instead of producing a second live writer.
      if (!isCurrentOwner(ownerPath, owner)) {
        throw createHttpError("server_state_locked", 409, `Server state lock was taken over during acquisition: ${lockPath}`);
      }
      return registerRelease({ lockPath, ownerPath, owner, heartbeatMs, onLockLost: options.onLockLost });
    } catch (error) {
      if (error?.code === "EEXIST" && attempt === 0) {
        const existing = readOwner(ownerPath);
        const stale = isServerStateLockOwnerStale(existing, {
          hostname: owner.hostname,
          instanceId: owner.instanceId,
          pid: owner.pid,
          processStartedAt,
          now: new Date(),
          staleAfterMs,
          isProcessAlive
        });
        if (stale) {
          options.onStaleLock?.(existing);
          reclaimStaleLock({ lockPath, ownerPath, existing, owner });
          continue;
        }
      }
      if (error?.code === "EEXIST") {
        throw createHttpError("server_state_locked", 409, `Server state directory is already locked: ${lockPath}`);
      }
      if (error?.code && error?.publicMessage) throw error;
      throw createHttpError("server_state_write_failed", 500, `Failed to create server state lock: ${error.message}`);
    }
  }
  throw createHttpError("server_state_locked", 409, `Server state directory is already locked: ${lockPath}`);
}

// Removing a stale lock with rmSync is not safe: two processes can both read the
// same stale owner, both delete, and both then believe they hold the lock — one
// of them deleting the *live* directory the other just created. rename is atomic
// and single-winner, so exactly one process moves the stale directory aside; the
// loser sees ENOENT and simply retries mkdir.
function reclaimStaleLock({ lockPath, ownerPath, existing, owner }) {
  const reclaimPath = `${lockPath}.reclaim.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, reclaimPath);
  } catch (error) {
    // ENOENT/EEXIST/EPERM/EACCES/ENOTEMPTY all mean another process got there
    // first. The retry re-reads whatever owner now holds the lock.
    if (["ENOENT", "EEXIST", "EPERM", "EACCES", "ENOTEMPTY", "EBUSY"].includes(error?.code)) return;
    throw createHttpError("server_state_write_failed", 500, `Failed to reclaim stale server state lock: ${error.message}`);
  }

  // We won the rename, but the directory we moved may no longer be the stale one
  // we judged: another process could have reclaimed it and written a live owner
  // between our read and our rename. Put it back if so.
  const moved = readOwner(join(reclaimPath, "owner.json"));
  if (!sameLockOwner(moved, existing)) {
    try {
      renameSync(reclaimPath, lockPath);
      return;
    } catch {
      // A third process already created a fresh lock at lockPath, so the
      // directory we hold is an orphan. Whoever owned it will notice via the
      // heartbeat ownership check and exit rather than keep writing state.
      rmSync(reclaimPath, { recursive: true, force: true });
      throw createHttpError("server_state_locked", 409, `Server state directory is already locked: ${lockPath}`);
    }
  }
  rmSync(reclaimPath, { recursive: true, force: true });
}

function sameLockOwner(left, right) {
  if (!left || !right) return left === right || (!left && !right);
  return left.token === right.token && left.pid === right.pid && left.hostname === right.hostname && left.instanceId === right.instanceId;
}

export function isServerStateLockOwnerStale(owner, current = {}) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.hostname) return false;

  const nowMs = dateMs(current.now || new Date());
  const staleAfterMs = positiveNumber(current.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const heartbeatMs = dateMs(owner.heartbeatAt || owner.startedAt);
  if (owner.instanceId && current.instanceId && owner.instanceId !== current.instanceId) {
    return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > staleAfterMs;
  }
  if (owner.hostname !== current.hostname) {
    return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > staleAfterMs;
  }

  if (owner.pid === current.pid) {
    if (owner.processStartedAt && current.processStartedAt) {
      return Math.abs(dateMs(owner.processStartedAt) - dateMs(current.processStartedAt)) > START_TIME_TOLERANCE_MS;
    }
    const ownerStartedMs = dateMs(owner.startedAt);
    const currentStartedMs = dateMs(current.processStartedAt);
    return Number.isFinite(ownerStartedMs) && Number.isFinite(currentStartedMs) && ownerStartedMs < currentStartedMs - START_TIME_TOLERANCE_MS;
  }

  return !(current.isProcessAlive || isProcessAlive)(owner.pid);
}

function registerRelease({ lockPath, ownerPath, owner, heartbeatMs, onLockLost }) {
  let released = false;
  const heartbeat = setInterval(() => {
    // Losing ownership means another process reclaimed the lock and is now also
    // writing the same state file. Silently skipping the heartbeat used to leave
    // both writers running; surface it so the caller can stop this one.
    if (!isCurrentOwner(ownerPath, owner)) {
      clearInterval(heartbeat);
      released = true;
      const lost = createHttpError("server_state_locked", 409, `Server state lock ownership was lost: ${lockPath}`);
      if (onLockLost) {
        onLockLost(lost);
        return;
      }
      console.error(`[sfsc] server_state_lock_lost: ${lost.message}`);
      process.exit(1);
    }
    owner.heartbeatAt = new Date().toISOString();
    try {
      writeOwner(ownerPath, owner);
    } catch (error) {
      console.error(`[sfsc] server_state_lock_heartbeat_failed: ${error.message}`);
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (isCurrentOwner(ownerPath, owner)) rmSync(lockPath, { recursive: true, force: true });
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }
  return release;
}

function writeOwner(ownerPath, owner) {
  const tempPath = `${ownerPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(owner, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, ownerPath);
}

function readOwner(ownerPath) {
  try {
    return JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function isCurrentOwner(ownerPath, owner) {
  const current = readOwner(ownerPath);
  return Boolean(current && current.token === owner.token && current.pid === owner.pid && current.hostname === owner.hostname && current.instanceId === owner.instanceId && current.statePath === owner.statePath);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function dateMs(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : Number.NaN;
}
