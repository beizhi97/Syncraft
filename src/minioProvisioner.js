import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildMinioPolicyName, buildMinioPrefixPolicy, createHttpError } from "./core/index.js";

const execFile = promisify(execFileCallback);
const MC_ALIAS = "sfsc";

// `mc alias set <alias> <endpoint> <accessKey> <secretKey>` puts the MinIO root
// credentials into process argv, where any local account can read them from
// /proc/<pid>/cmdline (or tasklist/WMI on Windows). mc reads the same alias from
// MC_HOST_<alias>, so the credentials travel through the environment instead and
// no `alias set` call is needed at all.
function buildMcHostEnv(storage = {}) {
  const endpoint = String(storage.internalEndpoint || "").trim();
  const accessKeyId = String(storage.accessKeyId || "").trim();
  const secretAccessKey = String(storage.secretAccessKey || "");
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be provisioned");
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be provisioned");
  }
  const credentials = `${encodeURIComponent(accessKeyId)}:${encodeURIComponent(secretAccessKey)}`;
  return {
    [`MC_HOST_${MC_ALIAS}`]: `${parsed.protocol}//${credentials}@${parsed.host}`
  };
}

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
  const run = options.run || ((args, env) => runMc(mcBin, args, { configDir, env }));
  const mcEnv = buildMcHostEnv(state.storage);

  try {
    await mkdir(policyDir, { recursive: true, mode: 0o700 });
    await writeFile(policyPath, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });
    if (!await canReadUser(run, membership.accessKeyId, mcEnv)) {
      await run(["admin", "user", "add", MC_ALIAS, membership.accessKeyId, membership.secretAccessKey], mcEnv);
    }
    if (!await canReadPolicy(run, policyName, mcEnv)) {
      await run(["admin", "policy", "create", MC_ALIAS, policyName, policyPath], mcEnv);
    }
    await run(["admin", "policy", "attach", MC_ALIAS, policyName, "--user", membership.accessKeyId], mcEnv);
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
  const run = options.run || ((args, env) => runMc(mcBin, args, { configDir, env }));
  const mcEnv = buildMcHostEnv(state.storage);
  try {
    for (const membership of memberships) {
      await run(["admin", "user", enabled ? "enable" : "disable", MC_ALIAS, membership.accessKeyId], mcEnv);
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
  const run = options.run || ((args, env) => runMc(mcBin, args, { configDir, env }));
  const mcEnv = buildMcHostEnv(state.storage);
  try {
    for (const membership of memberships) {
      await run(["admin", "user", "remove", MC_ALIAS, membership.accessKeyId], mcEnv);
    }
    return { mode: "per-device-space", removed: memberships.length };
  } catch {
    throw createHttpError("storage_request_failed", 502, "Storage authorization could not be removed");
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function canReadUser(run, accessKeyId, env) {
  try {
    await run(["admin", "user", "info", MC_ALIAS, accessKeyId], env);
    return true;
  } catch {
    return false;
  }
}

async function canReadPolicy(run, policyName, env) {
  try {
    await run(["admin", "policy", "info", MC_ALIAS, policyName], env);
    return true;
  } catch {
    return false;
  }
}

async function runMc(mcBin, args, options = {}) {
  const configDir = options.configDir || join("/tmp", `sfsc-mc-${randomBytes(6).toString("hex")}`);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await execFile(mcBin, ["--config-dir", configDir, ...args], {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) }
  });
}
