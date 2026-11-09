import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireServerStateLock } from "../core/serverStateLock.js";
import { open as openRelationFileServiceManager } from "../core/relationFileServiceManager.js";
import { createOwnerStateSnapshotGate } from "./ownerStateSnapshot.js";
import {
  readCommittedHistoryDescriptors
} from "./runtimeRecoveryTransaction.js";
import { runStartupMaintenanceTransaction } from "./startupMaintenance.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIGEST = /^[a-f0-9]{64}$/;
const EPOCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONFIG_KEYS = [
  "schemaVersion",
  "statePath",
  "recoveryDir",
  "resultPath",
  "artifactPath",
  "manifestPath",
  "mode",
  "deploymentId",
  "policyVersion",
  "targetEpoch",
  "createdFromEpoch",
  "oldContainerId",
  "closureProofSha256",
  "previousHistoryClosureSha256",
  "previousHistoryClosurePath"
];
const SUCCESSION_KEYS = [
  "schemaVersion",
  "mode",
  "previousOperationId",
  "previousTargetEpoch",
  "previousEpochManifestSha256",
  "previousFailureCode",
  "closedProofSha256",
  "sourceStateRevision",
  "sourceStateRawSha256",
  "sourceTransactionId",
  "sourceScopeProjectionSha256",
  "sourceHistoryClosureSha256",
  "transactionEpochManifestSha256"
];

function maintenanceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      `${label} must be a non-empty string`
    );
  }
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
}

function optionalDigest(value, label) {
  if (value !== null) {
    requireDigest(value, label);
  }
}

function requireExactKeys(value, keys, label) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      `${label} must be a plain object`
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      `${label} has an invalid schema`
    );
  }
}

function requireOptionalDigest(value, label) {
  if (value !== null) {
    requireDigest(value, label);
  }
}

function validateSuccession(value) {
  requireExactKeys(value, SUCCESSION_KEYS, "succession");
  if (value.schemaVersion !== "1"
    || !["reuse-after", "recover-current"].includes(value.mode)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "succession schema or mode is invalid"
    );
  }
  requireDigest(value.previousOperationId, "succession.previousOperationId");
  if (!EPOCH.test(value.previousTargetEpoch)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "succession.previousTargetEpoch is invalid"
    );
  }
  for (const key of [
    "previousEpochManifestSha256",
    "closedProofSha256",
    "sourceStateRawSha256"
  ]) {
    requireDigest(value[key], `succession.${key}`);
  }
  requireText(value.previousFailureCode, "succession.previousFailureCode");
  if (!Number.isSafeInteger(value.sourceStateRevision)
    || value.sourceStateRevision < 0) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "succession.sourceStateRevision is invalid"
    );
  }
  for (const key of [
    "sourceTransactionId",
    "sourceScopeProjectionSha256",
    "sourceHistoryClosureSha256",
    "transactionEpochManifestSha256"
  ]) {
    requireOptionalDigest(value[key], `succession.${key}`);
  }
  if (value.mode === "reuse-after" && value.sourceTransactionId !== null) {
    if (value.sourceScopeProjectionSha256 === null
      || value.sourceHistoryClosureSha256 === null
      || value.transactionEpochManifestSha256 === null) {
      throw maintenanceError(
        "startup_maintenance_input_invalid",
        "reused recovery succession lacks exact journal identity"
      );
    }
  }
  if (value.mode === "recover-current"
    && value.transactionEpochManifestSha256 !== null) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "fresh recovery cannot claim a prior journal epoch"
    );
  }
  return Object.freeze({ ...value });
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`;
}

function validateInheritedDescriptor(descriptor) {
  const historyKeys = [
    "kind",
    "scope",
    "code",
    "operationId",
    "relationId",
    "generation",
    "handleDigest",
    "requestDigest",
    "phase",
    "action",
    "recordSha256"
  ];
  if (descriptor?.kind === "current") {
    requireExactKeys(descriptor, [
      "kind",
      "scope",
      "code",
      "relationId",
      "oldOperationId",
      "oldGeneration",
      "handleDigest",
      "identityDigest",
      "requestDigest",
      "desired",
      "phase",
      "action",
      "relationRecordSha256",
      "operationRecordSha256",
      "history",
      "historySha256"
    ], "current history descriptor");
    if (descriptor.scope !== "current"
      || !["enabled", "disabled"].includes(descriptor.desired)
      || !Array.isArray(descriptor.history)
      || descriptor.history.length > 100_000) {
      throw maintenanceError(
        "startup_maintenance_previous_history_invalid",
        "current history descriptor identity is invalid"
      );
    }
    for (const key of ["handleDigest", "identityDigest", "requestDigest"]) {
      optionalDigest(descriptor[key], key);
    }
    for (const key of [
      "relationRecordSha256",
      "operationRecordSha256",
      "historySha256"
    ]) {
      requireDigest(descriptor[key], key);
    }
    for (const history of descriptor.history) {
      requireExactKeys(history, [
        "operationId",
        "generation",
        "handleDigest",
        "phase",
        "action",
        "requestDigest",
        "recordSha256"
      ], "nested history descriptor");
      optionalDigest(history.handleDigest, "history.handleDigest");
      optionalDigest(history.requestDigest, "history.requestDigest");
      requireDigest(history.recordSha256, "history.recordSha256");
    }
    return stableJson(descriptor);
  }
  if (descriptor?.kind === "history" || descriptor?.kind === "orphan") {
    requireExactKeys(descriptor, historyKeys, "historical history descriptor");
    if (descriptor.scope !== descriptor.kind) {
      throw maintenanceError(
        "startup_maintenance_previous_history_invalid",
        "historical descriptor scope does not match its kind"
      );
    }
    optionalDigest(descriptor.handleDigest, "history.handleDigest");
    optionalDigest(descriptor.requestDigest, "history.requestDigest");
    requireDigest(descriptor.recordSha256, "history.recordSha256");
    return stableJson(descriptor);
  }
  throw maintenanceError(
    "startup_maintenance_previous_history_invalid",
    "history descriptor kind is invalid"
  );
}

function requireAbsolute(value, label, expectedBasename = null) {
  requireText(value, label);
  if (!isAbsolute(value)
    || resolve(value) !== value
    || (expectedBasename && basename(value) !== expectedBasename)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      `${label} must be a canonical absolute path`
    );
  }
}

function normalizeConfig(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance configuration must be a plain object"
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [
    ...CONFIG_KEYS,
    ...(Object.hasOwn(value, "succession") ? ["succession"] : [])
  ].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance configuration has an invalid schema"
    );
  }
  if (value.schemaVersion !== "1") {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance schemaVersion must be 1"
    );
  }
  requireAbsolute(value.statePath, "statePath", "relation-services.json");
  requireAbsolute(value.recoveryDir, "recoveryDir");
  requireAbsolute(value.resultPath, "resultPath", "maintenance-result.json");
  requireAbsolute(value.artifactPath, "artifactPath", "sfsc_owner_lock.node");
  requireAbsolute(value.manifestPath, "manifestPath", "manifest.json");
  if (!["initialize-if-missing", "require-existing"].includes(value.mode)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance mode is invalid"
    );
  }
  for (const key of [
    "deploymentId",
    "policyVersion",
    "createdFromEpoch",
    "oldContainerId"
  ]) {
    requireText(value[key], key);
  }
  if (!EPOCH.test(value.targetEpoch)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "targetEpoch is invalid"
    );
  }
  requireDigest(value.closureProofSha256, "closureProofSha256");
  requireDigest(
    value.previousHistoryClosureSha256,
    "previousHistoryClosureSha256"
  );
  if (value.previousHistoryClosurePath !== null) {
    requireAbsolute(
      value.previousHistoryClosurePath,
      "previousHistoryClosurePath",
      "history-closure.json"
    );
  }
  if ((value.previousHistoryClosureSha256 === "0".repeat(64))
    !== (value.previousHistoryClosurePath === null)) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "previous history closure hash and path must be either both absent or both present"
    );
  }
  if (Object.hasOwn(value, "succession") && value.succession !== null) {
    validateSuccession(value.succession);
  }
  return Object.freeze({ ...value });
}

async function readConfig(path) {
  requireAbsolute(path, "configPath", "config.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance config must be one bounded regular file"
    );
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw maintenanceError(
      "startup_maintenance_input_invalid",
      "maintenance config is not valid JSON"
    );
  }
  return normalizeConfig(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function recoveryDirectoryHasTransaction(recoveryDir) {
  let entries;
  try {
    entries = await readdir(recoveryDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return entries.some(entry => (
    entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)
  ));
}

async function readInheritedHistoryDescriptors(config) {
  if (config.previousHistoryClosurePath === null) {
    return [];
  }
  let info;
  let bytes;
  try {
    info = await lstat(config.previousHistoryClosurePath);
    bytes = await readFile(config.previousHistoryClosurePath);
  } catch (error) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      `previous history closure is unavailable: ${error.code || error.message}`
    );
  }
  if (!info.isFile()
    || info.isSymbolicLink()
    || info.size > 16 * 1024 * 1024
    || sha256(bytes) !== config.previousHistoryClosureSha256) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history closure is not the exact bounded input"
    );
  }
  let closure;
  try {
    closure = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history closure is not valid JSON"
    );
  }
  if (closure?.schemaVersion !== "1"
    || typeof closure.transactionId !== "string"
    || !DIGEST.test(closure.transactionId)
    || typeof closure.previousHistoryClosureSha256 !== "string"
    || !DIGEST.test(closure.previousHistoryClosureSha256)
    || typeof closure.scopeProjectionSha256 !== "string"
    || !DIGEST.test(closure.scopeProjectionSha256)
    || !Array.isArray(closure.descriptors)
    || closure.descriptors.length > 100_000) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history closure has an invalid schema"
    );
  }
  requireExactKeys(closure, [
    "schemaVersion",
    "transactionId",
    "previousHistoryClosureSha256",
    "scopeProjectionSha256",
    "descriptors"
  ], "previous history closure");
  const serialized = closure.descriptors.map(validateInheritedDescriptor);
  if (new Set(serialized).size !== serialized.length) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history descriptors are duplicated"
    );
  }
  let committedDescriptors;
  try {
    committedDescriptors = await readCommittedHistoryDescriptors({
      recoveryDir: config.recoveryDir,
      transactionId: closure.transactionId,
      historyClosureSha256: config.previousHistoryClosureSha256,
      deploymentId: config.deploymentId,
      policyVersion: config.policyVersion
    });
  } catch {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history closure does not identify the exact committed source"
    );
  }
  if (stableJson(committedDescriptors) !== stableJson(closure.descriptors)) {
    throw maintenanceError(
      "startup_maintenance_previous_history_invalid",
      "previous history descriptors do not match the committed source"
    );
  }
  return committedDescriptors.map(value => structuredClone(value));
}

async function writePrivateAtomic(path, bytes) {
  const parent = dirname(path);
  await import("node:fs/promises").then(({ mkdir }) => (
    mkdir(parent, { recursive: true, mode: 0o700 })
  ));
  const temp = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, 0o600);
    await rename(temp, path);
    if (process.platform === "linux") {
      const parentHandle = await open(parent, "r");
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temp, { force: true }).catch(() => {});
    throw maintenanceError(
      "startup_maintenance_result_write_failed",
      `failed to persist maintenance result: ${error.code || error.message}`
    );
  }
}

const unavailableRuntime = Object.freeze({
  async inspect() {
    throw maintenanceError(
      "startup_maintenance_runtime_unavailable",
      "maintenance must not invoke relation runtime operations"
    );
  },
  async stop() {
    throw maintenanceError(
      "startup_maintenance_runtime_unavailable",
      "maintenance must not invoke relation runtime operations"
    );
  }
});

export async function runStartupMaintenanceEntry({
  config,
  createGate = createOwnerStateSnapshotGate,
  acquireStateLock = acquireServerStateLock,
  openManager = openRelationFileServiceManager,
  runTransaction = runStartupMaintenanceTransaction
} = {}) {
  const normalized = normalizeConfig(config);
  const gate = createGate({
    artifactPath: normalized.artifactPath,
    manifestPath: normalized.manifestPath
  });
  const ownerLease = gate.acquireOwnerLease({
    statePath: normalized.statePath
  });
  const releaseStateLock = acquireStateLock({
    dataDir: dirname(normalized.statePath),
    statePath: normalized.statePath,
    lockPath: `${normalized.statePath}.storage.lock`,
    onStaleLock: owner => {
      console.error(
        `[sfsc] maintenance_stale_state_lock_removed: ${owner?.pid || "unknown"}`
      );
    },
    onLockLost: error => {
      throw maintenanceError(
        "startup_maintenance_state_lock_lost",
        error.message
      );
    }
  });
  let result;
  try {
    const stateExists = await pathExists(normalized.statePath);
    if (!stateExists) {
      if (normalized.mode !== "initialize-if-missing") {
        throw maintenanceError(
          "startup_maintenance_state_missing",
          "maintenance require-existing mode found no relation state"
        );
      }
      if (await recoveryDirectoryHasTransaction(normalized.recoveryDir)) {
        throw maintenanceError(
          "startup_maintenance_state_missing_with_recovery",
          "a recovery transaction remains without its relation state"
        );
      }
      await openManager({
        mode: "auto",
        statePath: normalized.statePath,
        ownerLease,
        assertOwnerLease: gate.assertOwnerLease,
        withExclusiveLock: async (_request, task) => task(),
        runtime: unavailableRuntime
      });
    }

    const snapshot = gate.evaluateStartupState(ownerLease);
    if (snapshot?.fullStartupAdmission !== false
      || !Number.isSafeInteger(snapshot.revision)
      || !DIGEST.test(snapshot.rawSha256)) {
      throw maintenanceError(
        "startup_maintenance_snapshot_invalid",
        "native owner snapshot did not return an exact public baseline"
      );
    }

    const inheritedDescriptors = await readInheritedHistoryDescriptors(
      normalized
    );

    const transactionResult = await runTransaction({
      recoveryDir: normalized.recoveryDir,
      statePath: normalized.statePath,
      ownerLease,
      assertOwnerLease: gate.assertOwnerLease,
      transaction: {
        beforeRawSha256: snapshot.rawSha256,
        closureProofSha256: normalized.closureProofSha256,
        deploymentId: normalized.deploymentId,
        policyVersion: normalized.policyVersion,
        oldContainerId: normalized.oldContainerId,
        targetEpoch: normalized.targetEpoch,
        createdFromEpoch: normalized.createdFromEpoch,
        previousHistoryClosureSha256:
          normalized.previousHistoryClosureSha256,
        inheritedDescriptors,
        succession: normalized.succession ?? null
      }
    });
    await gate.assertOwnerLease(ownerLease);
    const currentBytes = await readFile(normalized.statePath);
    result = Object.freeze({
      schemaVersion: "1",
      status: "ok",
      deploymentId: normalized.deploymentId,
      targetEpoch: normalized.targetEpoch,
      initialized: !stateExists,
      required: transactionResult?.required === true,
      transactionId: transactionResult?.transactionId ?? null,
      revision: Number.isSafeInteger(transactionResult?.revision)
        ? transactionResult.revision
        : snapshot.revision,
      rawSha256: DIGEST.test(transactionResult?.rawSha256)
        ? transactionResult.rawSha256
        : sha256(currentBytes),
      scopeProjectionSha256:
        transactionResult?.scopeProjectionSha256 ?? null,
      historyClosureSha256:
        transactionResult?.historyClosureSha256 ?? null,
      previousHistoryClosureSha256:
        transactionResult?.previousHistoryClosureSha256 ?? null,
      closureProofSha256: normalized.closureProofSha256,
      completedAt: new Date().toISOString()
    });
    if (result.rawSha256 !== sha256(currentBytes)) {
      throw maintenanceError(
        "startup_maintenance_state_readback_mismatch",
        "maintenance result does not match the final exact state bytes"
      );
    }
    await writePrivateAtomic(
      normalized.resultPath,
      Buffer.from(JSON.stringify(result, null, 2), "utf8")
    );
  } finally {
    releaseStateLock();
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== "--config") {
      throw maintenanceError(
        "startup_maintenance_input_invalid",
        "usage: startupMaintenanceCli.js --config <absolute-path>"
      );
    }
    await runStartupMaintenanceEntry({ config: await readConfig(argv[1]) });
    return 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || "startup_maintenance_failed",
      message: error?.message || "startup maintenance failed"
    }));
    return 1;
  }
}

if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}

export { normalizeConfig as normalizeStartupMaintenanceConfig };
