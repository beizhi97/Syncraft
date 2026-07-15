import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildMinioPolicyName, buildMinioPrefixPolicy, createHttpError } from "./core/index.js";

const execFile = promisify(execFileCallback);
const MC_ALIAS = "sfsc";

export async function ensureMinioClaimAccess(state, claim, options = {}) {
  if (state.storage?.accessKeyMode !== "per-device-space") {
    return { mode: "shared", provisioned: false };
  }
  const user = state.users.find((item) => item.id === claim.userId && !item.deletedAt);
  const syncSpace = state.syncSpaces.find((item) => item.id === claim.syncSpaceId && item.status === "active");
  const membership = state.syncSpaceMemberships.find((item) => item.syncSpaceId === claim.syncSpaceId && item.deviceId === claim.userId && !item.revokedAt);
  if (!user || !syncSpace || !membership || !membership.accessKeyId || !membership.secretAccessKey) {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be provisioned");
  }

  const policyName = buildMinioPolicyName({ syncSpaceId: syncSpace.id, role: membership.role });
  const policy = buildMinioPrefixPolicy({
    bucket: syncSpace.storageTarget.bucket,
    prefix: syncSpace.storageTarget.prefix,
    role: membership.role,
    allowDelete: syncSpace.policy?.allowDelete === true
  });
  const mcBin = options.mcBin || process.env.SFSC_MINIO_MC_BIN || "mc";
  const configDir = options.configDir || join("/tmp", `sfsc-mc-${randomBytes(6).toString("hex")}`);
  const policyDir = options.policyDir || join("/tmp", "sfsc-minio-policies");
  const policyPath = join(policyDir, `${policyName}.json`);
  const run = options.run || ((args) => runMc(mcBin, args, { configDir }));

  try {
    await mkdir(policyDir, { recursive: true, mode: 0o700 });
    await writeFile(policyPath, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });
    await run(["alias", "set", MC_ALIAS, state.storage.internalEndpoint, state.storage.accessKeyId, state.storage.secretAccessKey]);
    if (!await canReadUser(run, membership.accessKeyId)) {
      await run(["admin", "user", "add", MC_ALIAS, membership.accessKeyId, membership.secretAccessKey]);
    }
    if (!await canReadPolicy(run, policyName)) {
      await run(["admin", "policy", "create", MC_ALIAS, policyName, policyPath]);
    }
    await run(["admin", "policy", "attach", MC_ALIAS, policyName, "--user", membership.accessKeyId]);
    return { mode: "per-device-space", provisioned: true, policyName };
  } catch {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be provisioned");
  } finally {
    await rm(policyPath, { force: true }).catch(() => {});
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function setMinioDeviceAccessEnabled(state, userId, enabled, options = {}) {
  if (state.storage?.accessKeyMode !== "per-device-space") {
    return { mode: "shared", changed: 0 };
  }
  const memberships = state.syncSpaceMemberships.filter((membership) =>
    membership.deviceId === userId && membership.accessKeyId && membership.secretAccessKey
  );
  if (!memberships.length) {
    return { mode: "per-device-space", changed: 0 };
  }
  const mcBin = options.mcBin || process.env.SFSC_MINIO_MC_BIN || "mc";
  const configDir = options.configDir || join("/tmp", `sfsc-mc-${randomBytes(6).toString("hex")}`);
  const run = options.run || ((args) => runMc(mcBin, args, { configDir }));
  try {
    await run(["alias", "set", MC_ALIAS, state.storage.internalEndpoint, state.storage.accessKeyId, state.storage.secretAccessKey]);
    for (const membership of memberships) {
      await run(["admin", "user", enabled ? "enable" : "disable", MC_ALIAS, membership.accessKeyId]);
    }
    return { mode: "per-device-space", changed: memberships.length };
  } catch {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be updated");
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function removeMinioDeviceAccess(state, userId, options = {}) {
  if (state.storage?.accessKeyMode !== "per-device-space") {
    return { mode: "shared", removed: 0 };
  }
  const memberships = state.syncSpaceMemberships.filter((membership) =>
    membership.deviceId === userId && membership.accessKeyId
  );
  if (!memberships.length) {
    return { mode: "per-device-space", removed: 0 };
  }
  const mcBin = options.mcBin || process.env.SFSC_MINIO_MC_BIN || "mc";
  const configDir = options.configDir || join("/tmp", `sfsc-mc-${randomBytes(6).toString("hex")}`);
  const run = options.run || ((args) => runMc(mcBin, args, { configDir }));
  try {
    await run(["alias", "set", MC_ALIAS, state.storage.internalEndpoint, state.storage.accessKeyId, state.storage.secretAccessKey]);
    for (const membership of memberships) {
      await run(["admin", "user", "remove", MC_ALIAS, membership.accessKeyId]);
    }
    return { mode: "per-device-space", removed: memberships.length };
  } catch {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be removed");
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function canReadUser(run, accessKeyId) {
  try {
    await run(["admin", "user", "info", MC_ALIAS, accessKeyId]);
    return true;
  } catch {
    return false;
  }
}

async function canReadPolicy(run, policyName) {
  try {
    await run(["admin", "policy", "info", MC_ALIAS, policyName]);
    return true;
  } catch {
    return false;
  }
}

async function runMc(mcBin, args, options) {
  const configDir = options.configDir || join("/tmp", `sfsc-mc-${randomBytes(6).toString("hex")}`);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await execFile(mcBin, ["--config-dir", configDir, ...args], {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true
  });
}
