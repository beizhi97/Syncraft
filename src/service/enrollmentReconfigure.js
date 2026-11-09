import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson } from "../core/enrollmentProtocol.js";
import { createHttpError } from "../core/errors.js";

const JOURNAL_KIND = "sfsc-enrollment-reconfigure-operation";
const JOURNAL_VERSION = 1;
const STAGES = new Set([
  "prepared",
  "config-written",
  "restarting",
  "restarted",
  "applied",
  "complete",
  "rolled-back",
  "repair-needed"
]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message, status) {
  return createHttpError(code, status, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tunnelEndpointFingerprint(tunnel) {
  return sha256(Buffer.from(canonicalJson({
    id: tunnel.id,
    protocol: tunnel.protocol,
    publicHost: tunnel.publicHost,
    publicPort: tunnel.publicPort,
    listenHost: tunnel.listenHost,
    listenPort: tunnel.listenPort,
    security: tunnel.security,
    transport: tunnel.transport,
    transportPath: tunnel.transportPath,
    reality: tunnel.reality
  }), "utf8"));
}

function validateRecord(record, operationId) {
  const keys = [
    "beforeConfig",
    "beforeEndpointFingerprint",
    "beforeBootstrapRegistry",
    "beforeTunnel",
    "candidateConfigSha256",
    "createdAt",
    "expiresAt",
    "issuedAt",
    "input",
    "inputSha256",
    "kind",
    "lastErrorCode",
    "operationId",
    "result",
    "stage",
    "targetTunnel",
    "updatedAt",
    "version"
  ].filter(key => key !== "lastErrorCode" || Object.hasOwn(record || {}, key)).sort().join(",");
  if (!record || Object.getPrototypeOf(record) !== Object.getPrototypeOf({})
    || Object.keys(record).sort().join(",") !== keys
    || record.kind !== JOURNAL_KIND || record.version !== JOURNAL_VERSION
    || record.operationId !== operationId || !STAGES.has(record.stage)
    || !record.beforeTunnel || typeof record.beforeTunnel !== "object"
    || !(record.beforeBootstrapRegistry === null
      || (record.beforeBootstrapRegistry && typeof record.beforeBootstrapRegistry === "object"))
    || !record.beforeConfig || typeof record.beforeConfig !== "object"
    || typeof record.inputSha256 !== "string" || !SHA256.test(record.inputSha256)
    || !(record.candidateConfigSha256 === null || SHA256.test(record.candidateConfigSha256))) {
    throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration journal failed validation", 500);
  }
  if (record.beforeConfig.exists === true) {
    const bytes = Buffer.from(String(record.beforeConfig.base64 || ""), "base64");
    if (!bytes.length || bytes.toString("base64") !== record.beforeConfig.base64
      || sha256(bytes) !== record.beforeConfig.sha256) {
      throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration snapshot failed validation", 500);
    }
  } else if (record.beforeConfig.exists !== false || record.beforeConfig.base64 !== null || record.beforeConfig.sha256 !== null) {
    throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration snapshot failed validation", 500);
  }
  return record;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()
    || (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)) {
    throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration journal directory is not private", 500);
  }
}

async function writePrivateAtomic(path, value) {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  if (process.platform !== "win32") {
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function readPrivateRecord(path, operationId) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()
      || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)) {
      throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration journal file is not private", 500);
    }
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw);
    if (raw !== `${canonicalJson(record)}\n`) {
      throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration journal is not canonical", 500);
    }
    return validateRecord(record, operationId);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw fail("enrollment_reconfigure_state_invalid", "Tunnel reconfiguration journal is invalid", 500);
    }
    throw error;
  }
}

function operationInput(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.getPrototypeOf({})
    || Object.keys(input).some(key => !["operationId", "publicHost", "publicPort"].includes(key))
    || typeof input.operationId !== "string" || !/^op_[A-Za-z0-9_-]{16,128}$/.test(input.operationId)
    || (Object.hasOwn(input, "publicHost") && (typeof input.publicHost !== "string"
      || !input.publicHost.trim() || input.publicHost.trim().length > 253))
    || (Object.hasOwn(input, "publicPort") && (!Number.isInteger(input.publicPort)
      || input.publicPort < 1 || input.publicPort > 65535))) {
    throw fail("enrollment_reconfigure_invalid", "Tunnel reconfiguration operation ID or fields are invalid", 400);
  }
  return {
    operationId: input.operationId,
    ...(Object.hasOwn(input, "publicHost") ? { publicHost: input.publicHost.trim() } : {}),
    ...(Object.hasOwn(input, "publicPort") ? { publicPort: input.publicPort } : {})
  };
}

export function createEnrollmentReconfigureService({
  journalDir,
  getTunnel,
  setTunnel,
  readConfig,
  writeConfig,
  restoreConfig,
  saveAdminState,
  requestRestart,
  markDataApplied,
  markBootstrapApplied,
  markSingboxApplied,
  verifyTransport,
  issueCode,
  snapshotBootstrap,
  restoreBootstrap,
  isCurrentConfigApplied,
  makeTargetTunnel,
  summarizeState,
  now = () => Date.now(),
  maxCodeTtlMs = 24 * 60 * 60 * 1000
} = {}) {
  for (const [name, value] of Object.entries({
    journalDir, getTunnel, setTunnel, readConfig, writeConfig, restoreConfig,
    saveAdminState, requestRestart, markDataApplied, markBootstrapApplied,
    markSingboxApplied, issueCode, snapshotBootstrap, restoreBootstrap,
    isCurrentConfigApplied, makeTargetTunnel,
    summarizeState
  })) {
    if (typeof value !== "function" && name !== "journalDir") throw new TypeError(`${name} is required`);
  }
  if (verifyTransport !== undefined && typeof verifyTransport !== "function") {
    throw new TypeError("verifyTransport must be a function when provided");
  }
  if (typeof journalDir !== "string" || !journalDir) throw new TypeError("journalDir is required");

  let queue = Promise.resolve();
  const fileFor = operationId => join(journalDir, `${operationId}.json`);
  const serialized = async task => {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  };

  async function save(record) {
    record.updatedAt = new Date(now()).toISOString();
    validateRecord(record, record.operationId);
    await writePrivateAtomic(fileFor(record.operationId), record);
  }

  async function get(operationId) {
    if (typeof operationId !== "string" || !/^op_[A-Za-z0-9_-]{16,128}$/.test(operationId)) {
      throw fail("enrollment_reconfigure_invalid", "Tunnel reconfiguration operation ID is invalid", 400);
    }
    const record = await readPrivateRecord(fileFor(operationId), operationId);
    if (!record) throw fail("enrollment_reconfigure_not_found", "Tunnel reconfiguration operation was not found", 404);
    return publicOperation(record);
  }

  async function run(input) {
    return serialized(async () => {
      const normalized = operationInput(input);
      const operationId = normalized.operationId;
      const inputSha256 = sha256(Buffer.from(canonicalJson(normalized), "utf8"));
      let record = await readPrivateRecord(fileFor(operationId), operationId);
      if (record && record.inputSha256 !== inputSha256) {
        throw fail("enrollment_reconfigure_conflict", "This operation ID was used with different tunnel settings", 409);
      }
      if (!record) {
        const beforeTunnel = structuredClone(await getTunnel());
        const beforeBytes = await readConfig();
        if (!await isCurrentConfigApplied(beforeTunnel, beforeBytes)) {
          throw fail("enrollment_channel_not_ready", "An existing server tunnel and readable configuration are required", 503);
        }
        const targetTunnel = await makeTargetTunnel(beforeTunnel, normalized);
        record = {
          kind: JOURNAL_KIND,
          version: JOURNAL_VERSION,
          operationId,
          input: normalized,
          inputSha256,
          stage: "prepared",
          createdAt: new Date(now()).toISOString(),
          updatedAt: new Date(now()).toISOString(),
          expiresAt: new Date(now() + maxCodeTtlMs).toISOString(),
          issuedAt: new Date(now()).toISOString(),
          beforeTunnel,
          beforeBootstrapRegistry: await snapshotBootstrap(),
          beforeEndpointFingerprint: tunnelEndpointFingerprint(beforeTunnel),
          beforeConfig: beforeBytes === null ? { exists: false, base64: null, sha256: null } : {
            exists: true,
            base64: Buffer.from(beforeBytes).toString("base64"),
            sha256: sha256(beforeBytes)
          },
          candidateConfigSha256: null,
          result: null
        };
        record.targetTunnel = targetTunnel;
        // Keep operation-owned proposed tunnel fields in the journal only after validation.
        await save(record);
      }

      if (["complete", "rolled-back", "repair-needed"].includes(record.stage)) return publicOperation(record);
      if (["prepared", "config-written", "restarting", "restarted"].includes(record.stage)) {
        try {
          const currentTunnel = await getTunnel();
          const currentFingerprint = tunnelEndpointFingerprint(currentTunnel);
          const targetFingerprint = tunnelEndpointFingerprint(record.targetTunnel);
          if (currentFingerprint !== record.beforeEndpointFingerprint && currentFingerprint !== targetFingerprint) {
            return await setRepairNeeded(record, "current tunnel changed outside this operation");
          }
          if (currentFingerprint === record.beforeEndpointFingerprint) await setTunnel(record.targetTunnel);
          await writeConfig();
          await saveAdminState();
          const candidateBytes = await readConfig();
          if (candidateBytes === null) throw fail("server_singbox_config_write_failed", "Candidate tunnel config is missing", 500);
          const candidateDigest = sha256(candidateBytes);
          record.candidateConfigSha256 = candidateDigest;
          record.stage = "config-written";
          await save(record);
          record.stage = "restarting";
          await save(record);
          const restart = await requestRestart(candidateDigest);
          if (restart?.ok !== true || restart.configSha256 !== candidateDigest) {
            throw fail("singbox_restart_failed", "Supervisor did not confirm the candidate configuration digest", 502);
          }
          record.stage = "restarted";
          await save(record);
          await markDataApplied(candidateDigest, restart);
          await markBootstrapApplied(await getTunnel(), candidateDigest, restart);
          await markSingboxApplied();
          if (verifyTransport) await verifyTransport({ tunnel: await getTunnel() });
          await saveAdminState();
          record.stage = "applied";
          await save(record);
        } catch (error) {
          return await rollbackOrRepair(record, error);
        }
      }

      if (record.stage === "applied") {
        const currentTunnel = await getTunnel();
        const currentBytes = await readConfig();
        if (tunnelEndpointFingerprint(currentTunnel) !== tunnelEndpointFingerprint(record.targetTunnel)
          || currentBytes === null || sha256(currentBytes) !== record.candidateConfigSha256) {
          return await setRepairNeeded(record, "applied tunnel or exact config digest changed before channel issuance");
        }
        if (!record.result) {
          try {
            if (Date.parse(record.expiresAt) <= now()) {
              record.issuedAt = new Date(now()).toISOString();
              record.expiresAt = new Date(now() + maxCodeTtlMs).toISOString();
              await save(record);
            }
            const issued = await issueCode({
              tunnel: currentTunnel,
              configSha256: record.candidateConfigSha256,
              issuedAt: record.issuedAt,
              expiresAt: record.expiresAt,
              onIssued: async result => {
                record.result = {
                  wrappedCode: result.wrappedCode,
                  channelRevision: result.channelRevision,
                  expiresAt: result.expiresAt,
                  state: await summarizeState()
                };
                record.stage = "complete";
                await save(record);
              }
            });
            if (!record.result) {
              record.result = {
                wrappedCode: issued.wrappedCode,
                channelRevision: issued.channelRevision,
                expiresAt: issued.expiresAt,
                state: await summarizeState()
              };
              record.stage = "complete";
              await save(record);
            }
          } catch (error) {
            // The configuration has been applied. Preserve it for an idempotent retry;
            // returning an error must not revert the in-memory admin state.
            record.lastErrorCode = String(error?.code || "server_error");
            await save(record);
            return { ...publicOperation(record), errorCode: record.lastErrorCode };
          }
        }
      }
      return publicOperation(record);
    });
  }

  async function rollbackOrRepair(record, cause) {
    try {
      const currentTunnel = await getTunnel();
      const currentBytes = await readConfig();
      const ownsTunnel = tunnelEndpointFingerprint(currentTunnel) === tunnelEndpointFingerprint(record.targetTunnel);
      const ownsConfig = currentBytes !== null && record.candidateConfigSha256
        && sha256(currentBytes) === record.candidateConfigSha256;
      if (!ownsTunnel || !ownsConfig || record.beforeConfig.exists !== true) {
        return await setRepairNeeded(record, "current tunnel/config cannot be proven to belong to this operation");
      }
      await setTunnel({
        ...currentTunnel,
        publicHost: record.beforeTunnel.publicHost,
        publicPort: record.beforeTunnel.publicPort,
        restartRequired: true
      });
      await restoreBootstrap(record.beforeBootstrapRegistry);
      await writeConfig();
      const regeneratedBytes = await readConfig();
      if (regeneratedBytes === null || sha256(regeneratedBytes) !== record.beforeConfig.sha256) {
        await restoreConfig(Buffer.from(record.beforeConfig.base64, "base64"));
        return await setRepairNeeded(record, "restored tunnel no longer builds the exact prior config snapshot");
      }
      await restoreConfig(Buffer.from(record.beforeConfig.base64, "base64"));
      await saveAdminState();
      const restart = await requestRestart(record.beforeConfig.sha256);
      if (restart?.ok !== true || restart.configSha256 !== record.beforeConfig.sha256) {
        return await setRepairNeeded(record, "supervisor did not confirm the restored config digest");
      }
      await markDataApplied(record.beforeConfig.sha256, restart);
      await markBootstrapApplied(await getTunnel(), record.beforeConfig.sha256, restart);
      await markSingboxApplied();
      await saveAdminState();
      record.stage = "rolled-back";
      record.lastErrorCode = String(cause?.code || "server_error");
      await save(record);
      return publicOperation(record);
    } catch (error) {
      return await setRepairNeeded(record, String(error?.code || "rollback_failed"));
    }
  }

  async function setRepairNeeded(record, reasonCode) {
    record.stage = "repair-needed";
    record.lastErrorCode = String(reasonCode || "repair_required").slice(0, 80);
    await save(record).catch(() => {});
    return publicOperation(record);
  }

  function publicOperation(record) {
    const result = record.result ? structuredClone(record.result) : null;
    return {
      operationId: record.operationId,
      stage: record.stage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastErrorCode ? { errorCode: record.lastErrorCode } : {}),
      ...(result || {})
    };
  }

  return Object.freeze({ run, get });
}
