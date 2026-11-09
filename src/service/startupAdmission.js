import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { open as openRelationFileServiceManager } from "../core/relationFileServiceManager.js";
import {
  mintStartupRecoveryAuthority
} from "./startupRecoveryPermit.js";
import {
  projectStartupRecoveryScope
} from "./startupQuiescenceStateParser.js";
import { STARTUP_STATE_POLICY_LIMITS } from "./strictStateJson.js";

const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,256}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const EPOCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EPOCH_FILES = new Set([
  "epoch.json",
  "history-closure.json",
  "runtime-ready.json"
]);
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

function admissionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw admissionError(
      "startup_admission_manifest_invalid",
      `${label} must be a non-empty string`
    );
  }
}

function exactKeys(value, expected, label) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      `${label} must be a plain object`
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      `${label} has an invalid schema`
    );
  }
}

function validateBaseline(value, label) {
  exactKeys(value, ["rawSha256", "revision"], label);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      `${label}.revision must be a non-negative safe integer`
    );
  }
  requireDigest(value.rawSha256, `${label}.rawSha256`);
  return Object.freeze({
    revision: value.revision,
    rawSha256: value.rawSha256
  });
}

function validateSuccession(value) {
  exactKeys(value, SUCCESSION_KEYS, "epoch succession");
  if (value.schemaVersion !== "1"
    || !["reuse-after", "recover-current"].includes(value.mode)) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      "epoch succession schema or mode is invalid"
    );
  }
  requireDigest(value.previousOperationId, "succession.previousOperationId");
  if (!EPOCH.test(value.previousTargetEpoch)) {
    throw admissionError(
      "startup_admission_manifest_invalid",
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
    throw admissionError(
      "startup_admission_manifest_invalid",
      "succession.sourceStateRevision is invalid"
    );
  }
  for (const key of [
    "sourceTransactionId",
    "sourceScopeProjectionSha256",
    "sourceHistoryClosureSha256",
    "transactionEpochManifestSha256"
  ]) {
    if (value[key] !== null) {
      requireDigest(value[key], `succession.${key}`);
    }
  }
  if (value.mode === "reuse-after" && value.sourceTransactionId !== null) {
    if (value.sourceScopeProjectionSha256 === null
      || value.sourceHistoryClosureSha256 === null
      || value.transactionEpochManifestSha256 === null) {
      throw admissionError(
        "startup_admission_manifest_invalid",
        "reused recovery succession lacks exact journal identity"
      );
    }
  }
  if (value.mode === "recover-current"
    && value.transactionEpochManifestSha256 !== null) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      "fresh recovery cannot claim a prior journal epoch"
    );
  }
  return Object.freeze({ ...value });
}

function validateEpochManifest(value) {
  const baseKeys = [
    "schemaVersion",
    "deploymentId",
    "targetEpoch",
    "containerId",
    "imageDigest",
    "hostCgroupPath",
    "bootstrapNonceSha256",
    "stateBaseline",
    "recovery",
    "sealedAt"
  ];
  exactKeys(value, Object.hasOwn(value, "succession")
    ? [...baseKeys, "succession"]
    : baseKeys, "epoch manifest");
  if (value.schemaVersion !== "1"
    || !EPOCH.test(value.targetEpoch)
    || !FULL_CONTAINER_ID.test(value.containerId)) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      "epoch schema, targetEpoch, or complete container ID is invalid"
    );
  }
  requireText(value.deploymentId, "deploymentId");
  requireText(value.imageDigest, "imageDigest");
  requireText(value.hostCgroupPath, "hostCgroupPath");
  requireDigest(value.bootstrapNonceSha256, "bootstrapNonceSha256");
  if (!Number.isFinite(Date.parse(value.sealedAt))) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      "epoch sealedAt is not a timestamp"
    );
  }
  const stateBaseline = validateBaseline(value.stateBaseline, "stateBaseline");
  exactKeys(value.recovery, [
    "transactionId",
    "status",
    "closureProofSha256",
    "previousHistoryClosureSha256",
    "afterRevision",
    "afterRawSha256",
    "scopeProjectionSha256",
    "historyClosureSha256"
  ], "recovery manifest");
  const recovery = value.recovery;
  if (![null, "committed"].includes(recovery.status)) {
    throw admissionError(
      "startup_admission_recovery_incomplete",
      "the epoch recovery transaction is not committed"
    );
  }
  if (recovery.transactionId === null) {
    if (recovery.afterRevision !== stateBaseline.revision
      || recovery.afterRawSha256 !== stateBaseline.rawSha256
      || recovery.scopeProjectionSha256 !== null
      || recovery.historyClosureSha256 !== null) {
      throw admissionError(
        "startup_admission_manifest_invalid",
        "a no-recovery epoch cannot claim after bytes or a closure"
      );
    }
  } else {
    requireDigest(recovery.transactionId, "recovery.transactionId");
    if (recovery.status !== "committed"
      || recovery.afterRevision !== stateBaseline.revision
      || recovery.afterRawSha256 !== stateBaseline.rawSha256) {
      throw admissionError(
        "startup_admission_recovery_incomplete",
        "the static recovery transaction must match the exact state baseline"
      );
    }
  }
  for (const key of [
    "closureProofSha256",
    "previousHistoryClosureSha256",
    "afterRawSha256"
  ]) {
    requireDigest(recovery[key], `recovery.${key}`);
  }
  if (!Number.isSafeInteger(recovery.afterRevision)
    || recovery.afterRevision < 0) {
    throw admissionError(
      "startup_admission_manifest_invalid",
      "recovery.afterRevision must be a non-negative safe integer"
    );
  }
  for (const key of ["scopeProjectionSha256", "historyClosureSha256"]) {
    if (recovery[key] !== null) {
      requireDigest(recovery[key], `recovery.${key}`);
    }
  }
  let succession = null;
  if (Object.hasOwn(value, "succession")) {
    succession = validateSuccession(value.succession);
    if (succession.mode === "reuse-after"
      && (succession.sourceStateRevision !== stateBaseline.revision
        || succession.sourceStateRawSha256 !== stateBaseline.rawSha256)) {
      throw admissionError(
        "startup_admission_manifest_invalid",
        "reused succession source baseline differs from the epoch state baseline"
      );
    }
    if (succession.mode === "reuse-after"
      && succession.sourceTransactionId !== null
      && (recovery.transactionId !== succession.sourceTransactionId
        || recovery.scopeProjectionSha256
          !== succession.sourceScopeProjectionSha256
        || recovery.historyClosureSha256
          !== succession.sourceHistoryClosureSha256
        || recovery.afterRevision !== succession.sourceStateRevision
        || recovery.afterRawSha256 !== succession.sourceStateRawSha256)) {
      throw admissionError(
        "startup_admission_manifest_invalid",
        "reused succession is not bound to the static recovery transaction"
      );
    }
  }
  return Object.freeze({
    ...value,
    stateBaseline,
    recovery: Object.freeze({ ...recovery }),
    succession
  });
}

function validateRuntimeReady(value, epoch, epochManifestSha256) {
  exactKeys(value, [
    "schemaVersion",
    "targetEpoch",
    "containerId",
    "imageDigest",
    "hostCgroupPath",
    "bootstrapNonceSha256",
    "pidNamespaceId",
    "epochManifestSha256",
    "sealedAt"
  ], "runtime-ready manifest");
  if (value.schemaVersion !== "1"
    || value.targetEpoch !== epoch.targetEpoch
    || value.containerId !== epoch.containerId
    || value.imageDigest !== epoch.imageDigest
    || value.hostCgroupPath !== epoch.hostCgroupPath
    || value.bootstrapNonceSha256 !== epoch.bootstrapNonceSha256
    || value.epochManifestSha256 !== epochManifestSha256
    || !Number.isFinite(Date.parse(value.sealedAt))
    || typeof value.pidNamespaceId !== "string"
    || !/^pid:\[[0-9]+\]$/.test(value.pidNamespaceId)) {
    throw admissionError(
      "startup_admission_runtime_ready_invalid",
      "runtime-ready does not bind the exact static epoch"
    );
  }
  return Object.freeze({ ...value });
}

async function readStrictFile(path, maximumBytes, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw admissionError(
      "startup_admission_input_invalid",
      `${label} must be a bounded regular file`
    );
  }
  const bytes = await readFile(path);
  if (bytes.length > maximumBytes) {
    bytes.fill(0);
    throw admissionError(
      "startup_admission_input_invalid",
      `${label} exceeds its byte limit`
    );
  }
  return bytes;
}

async function readJsonFile(path, maximumBytes, label) {
  const bytes = await readStrictFile(path, maximumBytes, label);
  try {
    return Object.freeze({
      value: JSON.parse(bytes.toString("utf8")),
      bytes,
      sha256: sha256(bytes)
    });
  } catch {
    throw admissionError(
      "startup_admission_input_invalid",
      `${label} is not valid JSON`
    );
  }
}

async function waitForRuntimeReady(epochRoot, timeoutMs) {
  const readyPath = resolve(epochRoot, "runtime-ready.json");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readJsonFile(readyPath, 64 * 1024, "runtime-ready.json");
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadline) {
        throw error?.code === "ENOENT"
          ? admissionError(
            "startup_admission_runtime_ready_timeout",
            "runtime-ready was not sealed before the admission deadline"
          )
          : error;
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
}

async function validateEpochDirectory(epochRoot) {
  const canonical = resolve(epochRoot);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw admissionError(
      "startup_admission_epoch_invalid",
      "epoch root must be one non-symlink directory"
    );
  }
  const entries = await readdir(canonical, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !EPOCH_FILES.has(entry.name))) {
    throw admissionError(
      "startup_admission_epoch_invalid",
      "epoch root contains a stale or unexpected entry"
    );
  }
  return canonical;
}

async function readPrivateStateBytes(statePath, ownerGate, lease) {
  const absolute = resolve(statePath);
  if (!isAbsolute(statePath)
    || absolute !== statePath
    || basename(statePath) !== "relation-services.json") {
    throw admissionError(
      "startup_admission_state_invalid",
      "statePath must be an absolute relation-services.json path"
    );
  }
  const parentPath = dirname(statePath);
  await ownerGate.assertOwnerLease(lease);
  const parentInfo = await lstat(parentPath);
  const canonicalParent = await realpath(parentPath);
  const info = await lstat(statePath);
  if (!parentInfo.isDirectory()
    || resolve(canonicalParent) !== resolve(parentPath)
    || !info.isFile()
    || info.isSymbolicLink()
    || info.size > STARTUP_STATE_POLICY_LIMITS.maxBytes) {
    throw admissionError(
      "startup_admission_state_invalid",
      "state file or parent is not the exact bounded regular input"
    );
  }
  const bytes = await readFile(statePath);
  await ownerGate.assertOwnerLease(lease);
  return bytes;
}

async function readHistoryClosure(epochRoot, epoch, epochManifestSha256) {
  if (epoch.recovery.transactionId === null) {
    try {
      await lstat(resolve(epochRoot, "history-closure.json"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    throw admissionError(
      "startup_admission_epoch_invalid",
      "a no-recovery epoch must not carry a history closure"
    );
  }
  const closureFile = await readJsonFile(
    resolve(epochRoot, "history-closure.json"),
    16 * 1024 * 1024,
    "history-closure.json"
  );
  if (closureFile.sha256 !== epoch.recovery.historyClosureSha256) {
    throw admissionError(
      "startup_admission_history_invalid",
      "history closure hash does not match the static epoch"
    );
  }
  const closure = closureFile.value;
  exactKeys(closure, [
    "schemaVersion",
    "transactionId",
    "previousHistoryClosureSha256",
    "scopeProjectionSha256",
    "descriptors"
  ], "history closure");
  if (closure.schemaVersion !== "1"
    || closure.transactionId !== epoch.recovery.transactionId
    || closure.previousHistoryClosureSha256
      !== epoch.recovery.previousHistoryClosureSha256
    || closure.scopeProjectionSha256 !== epoch.recovery.scopeProjectionSha256
    || !Array.isArray(closure.descriptors)
    || closure.descriptors.length > 100_000) {
    throw admissionError(
      "startup_admission_history_invalid",
      "history closure is not bound to the static recovery transaction"
    );
  }
  return Object.freeze({ closure, sha256: closureFile.sha256 });
}

function assertClosureCoversProjection(closure, projection) {
  const persisted = new Set(closure.descriptors.map(stableJson));
  if (!projection.descriptors.every(descriptor => (
    persisted.has(stableJson(descriptor))
  ))) {
    throw admissionError(
      "startup_admission_history_invalid",
      "history closure does not include the complete current recovery scope"
    );
  }
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

export async function admitStartup({
  epochRoot,
  statePath,
  ownerGate,
  containerId,
  bootstrapNonce,
  managerOptions = {},
  readPidNamespace = async () => readlink("/proc/self/ns/pid"),
  runtimeReadyTimeoutMs = 15_000,
  now = new Date()
} = {}) {
  if (typeof epochRoot !== "string"
    || typeof statePath !== "string"
    || typeof containerId !== "string"
    || !CONTAINER_ID.test(containerId)
    || typeof bootstrapNonce !== "string"
    || !NONCE.test(bootstrapNonce)
    || !ownerGate
    || typeof ownerGate.acquireOwnerLease !== "function"
    || typeof ownerGate.evaluateStartupState !== "function"
    || typeof ownerGate.assertOwnerLease !== "function") {
    throw admissionError(
      "startup_admission_input_invalid",
      "startup admission requires the exact epoch, state, owner gate, container, and nonce"
    );
  }
  if (!Number.isSafeInteger(runtimeReadyTimeoutMs)
    || runtimeReadyTimeoutMs < 1
    || runtimeReadyTimeoutMs > 120_000) {
    throw admissionError(
      "startup_admission_input_invalid",
      "runtimeReadyTimeoutMs is invalid"
    );
  }
  const canonicalEpochRoot = await validateEpochDirectory(epochRoot);
  const epochFile = await readJsonFile(
    resolve(canonicalEpochRoot, "epoch.json"),
    256 * 1024,
    "epoch.json"
  );
  const epoch = validateEpochManifest(epochFile.value);
  if ((epoch.containerId !== containerId
      && !(containerId.length >= 12
        && epoch.containerId.startsWith(containerId)))
    || epoch.bootstrapNonceSha256
      !== sha256(Buffer.from(bootstrapNonce, "utf8"))) {
    throw admissionError(
      "startup_admission_epoch_identity_mismatch",
      "epoch container or bootstrap nonce does not match this process"
    );
  }
  const readyFile = await waitForRuntimeReady(
    canonicalEpochRoot,
    runtimeReadyTimeoutMs
  );
  const ready = validateRuntimeReady(
    readyFile.value,
    epoch,
    epochFile.sha256
  );
  const observedPidNamespace = await readPidNamespace();
  if (observedPidNamespace !== ready.pidNamespaceId) {
    throw admissionError(
      "startup_admission_namespace_mismatch",
      "runtime-ready PID namespace does not match this process"
    );
  }

  const lease = ownerGate.acquireOwnerLease({ statePath });
  const ownerSnapshot = ownerGate.evaluateStartupState(lease);
  if (ownerSnapshot?.fullStartupAdmission !== false
    || ownerSnapshot.revision !== epoch.stateBaseline.revision
    || ownerSnapshot.rawSha256 !== epoch.stateBaseline.rawSha256) {
    throw admissionError(
      "startup_admission_owner_snapshot_mismatch",
      "owner snapshot does not match the exact static state baseline"
    );
  }

  const bytes = await readPrivateStateBytes(statePath, ownerGate, lease);
  const rawSha256 = sha256(bytes);
  if (rawSha256 !== epoch.stateBaseline.rawSha256) {
    bytes.fill(0);
    throw admissionError(
      "startup_admission_state_baseline_mismatch",
      "private state read does not match the static epoch baseline"
    );
  }
  const projection = projectStartupRecoveryScope(bytes);
  bytes.fill(0);
  if (!projection.eligible
    || projection.revision !== epoch.stateBaseline.revision
    || projection.rawSha256 !== epoch.stateBaseline.rawSha256) {
    throw admissionError(
      "startup_admission_state_projection_invalid",
      "private state read is not an eligible exact recovery projection"
    );
  }

  let closure = null;
  let startupRecoveryAuthority = null;
  if (epoch.recovery.transactionId !== null) {
    if (projection.scopeProjectionSha256
      !== epoch.recovery.scopeProjectionSha256) {
      throw admissionError(
        "startup_admission_scope_mismatch",
        "recovered state scope does not match the static epoch"
      );
    }
    closure = await readHistoryClosure(
      canonicalEpochRoot,
      epoch,
      epochFile.sha256
    );
    assertClosureCoversProjection(closure.closure, projection);
    if (projection.authorityDescriptors.length !== 0) {
      startupRecoveryAuthority = mintStartupRecoveryAuthority({
        deploymentId: epoch.deploymentId,
        targetEpoch: epoch.targetEpoch,
        transactionId: epoch.recovery.transactionId,
        initialRevision: epoch.stateBaseline.revision,
        initialRawSha256: epoch.stateBaseline.rawSha256,
        scopeProjectionSha256: epoch.recovery.scopeProjectionSha256,
        closureProofSha256: epoch.recovery.closureProofSha256,
        descriptors: projection.authorityDescriptors
      });
    }
  } else if (projection.descriptors.length !== 0) {
    throw admissionError(
      "startup_admission_recovery_required",
      "the static epoch has unresolved recovery scope without a committed transaction"
    );
  }

  if (managerOptions.startupRecoveryAuthority != null) {
    throw admissionError(
      "startup_admission_input_invalid",
      "callers cannot inject a startup recovery authority"
    );
  }
  const manager = await openRelationFileServiceManager({
    ...managerOptions,
    statePath,
    mode: "require-existing",
    expectedBaseline: epoch.stateBaseline,
    ownerLease: lease,
    assertOwnerLease: ownerGate.assertOwnerLease,
    startupRecoveryAuthority
  });
  await ownerGate.assertOwnerLease(lease);
  return Object.freeze({
    manager,
    ownerLease: lease,
    publicSummary: Object.freeze({
      deploymentId: epoch.deploymentId,
      targetEpoch: epoch.targetEpoch,
      stateVersion: projection.stateVersion,
      revision: epoch.stateBaseline.revision,
      rawSha256: epoch.stateBaseline.rawSha256,
      recoveryTransactionId: epoch.recovery.transactionId,
      recoveryApplied: epoch.recovery.transactionId !== null,
      admitTime: now instanceof Date
        ? now.toISOString()
        : new Date(now).toISOString()
    })
  });
}

export async function readStartupEpochIdentity({ epochRoot } = {}) {
  if (typeof epochRoot !== "string") {
    throw admissionError(
      "startup_admission_input_invalid",
      "startup epoch root must be a string"
    );
  }
  const canonicalEpochRoot = await validateEpochDirectory(epochRoot);
  const epochFile = await readJsonFile(
    resolve(canonicalEpochRoot, "epoch.json"),
    256 * 1024,
    "epoch.json"
  );
  const epoch = validateEpochManifest(epochFile.value);
  return Object.freeze({
    containerId: epoch.containerId
  });
}

export function startupAdmissionEnvironment(environment = process.env) {
  return Object.freeze({
    epochRoot: environment.SFSC_RUNTIME_EPOCH_ROOT || "/run/sfsc-runtime",
    statePath: environment.SFSC_RELATION_STATE_PATH
      || "/data/app/relation-services.json",
    containerId: environment.SFSC_CONTAINER_ID || "",
    bootstrapNonce: environment.SFSC_BOOTSTRAP_NONCE || ""
  });
}
