import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { projectStartupRecoveryScope } from "./startupQuiescenceStateParser.js";

const RECOVERY_REASON = "relation_file_service_start_blocked";
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

function maintenanceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      `${label} must be a non-empty string`
    );
  }
}

export function prepareStartupRecovery({
  bytes,
  beforeRawSha256,
  closureProofSha256,
  deploymentId,
  policyVersion,
  oldContainerId,
  targetEpoch,
  createdFromEpoch,
  previousHistoryClosureSha256 = "0".repeat(64),
  inheritedDescriptors = [],
  now = new Date()
}) {
  const beforeBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (beforeBytes.length === 0) {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      "state bytes must not be empty"
    );
  }
  if (sha256(beforeBytes) !== beforeRawSha256) {
    throw maintenanceError(
      "startup_recovery_baseline_mismatch",
      "beforeRawSha256 does not match the exact before bytes"
    );
  }
  for (const [value, label] of [
    [beforeRawSha256, "beforeRawSha256"],
    [closureProofSha256, "closureProofSha256"],
    [previousHistoryClosureSha256, "previousHistoryClosureSha256"]
  ]) {
    requireDigest(value, label);
  }
  if (!Array.isArray(inheritedDescriptors)
    || inheritedDescriptors.length > 100_000) {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      "inheritedDescriptors must be a bounded array"
    );
  }
  for (const [value, label] of [
    [deploymentId, "deploymentId"],
    [policyVersion, "policyVersion"],
    [oldContainerId, "oldContainerId"],
    [targetEpoch, "targetEpoch"],
    [createdFromEpoch, "createdFromEpoch"]
  ]) {
    requireText(value, label);
  }
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      "now must produce a valid ISO timestamp"
    );
  }

  const beforeProjection = projectStartupRecoveryScope(beforeBytes);
  if (!beforeProjection.eligible) {
    throw maintenanceError(
      beforeProjection.code || "startup_recovery_state_invalid",
      "the before state cannot be projected into an exact recovery scope"
    );
  }
  if (beforeProjection.stateVersion === 1) {
    return Object.freeze({
      required: false,
      beforeRevision: beforeProjection.revision,
      beforeRawSha256,
      afterRevision: beforeProjection.revision,
      afterRawSha256: beforeRawSha256,
      afterBytes: Buffer.from(beforeBytes),
      scopeProjection: beforeProjection
    });
  }

  if (beforeProjection.descriptors.length === 0) {
    return Object.freeze({
      required: false,
      beforeRevision: beforeProjection.revision,
      beforeRawSha256,
      afterRevision: beforeProjection.revision,
      afterRawSha256: beforeRawSha256,
      afterBytes: Buffer.from(beforeBytes),
      scopeProjection: beforeProjection
    });
  }

  const inherited = inheritedDescriptors
    .map(descriptor => structuredClone(descriptor))
    .sort(compareDescriptorIdentity);
  const inheritedSet = new Set(inherited.map(stableJson));
  for (const descriptor of beforeProjection.descriptors) {
    const inheritedExactly = inheritedSet.has(stableJson(descriptor));
    if (descriptor.kind === "current") {
      if (["cleanup_required", "commit_uncertain", "pending", "stopping"]
        .includes(descriptor.phase)
        || (descriptor.phase === "unknown" && !inheritedExactly)) {
        throw maintenanceError(
          "startup_recovery_ordinary_uncertainty",
          "an uncertain current relation is not carried by the exact history chain"
        );
      }
      continue;
    }
    if (["unknown", "cleanup_required", "commit_uncertain"]
      .includes(descriptor.phase)
      && !inheritedExactly) {
      throw maintenanceError(
        "startup_recovery_ordinary_uncertainty",
        "an uncertain historical or orphan operation is not carried by the exact history chain"
      );
    }
  }

  const state = JSON.parse(beforeBytes.toString("utf8"));
  const after = structuredClone(state);
  const currentRelationIds = new Set();
  const operationIds = new Set();
  const newRecoveryDescriptors = beforeProjection.descriptors.filter(
    descriptor => !inheritedSet.has(stableJson(descriptor))
  );
  for (const descriptor of newRecoveryDescriptors) {
    if (descriptor.kind === "current") {
      currentRelationIds.add(descriptor.relationId);
      operationIds.add(descriptor.oldOperationId);
    } else {
      operationIds.add(descriptor.operationId);
    }
  }

  for (const operationId of operationIds) {
    const operation = after.operations[operationId];
    if (!operation) {
      throw maintenanceError(
        "startup_recovery_projection_mismatch",
        `operation ${operationId} disappeared while preparing recovery`
      );
    }
    recoverRecord(operation, timestamp);
  }
  for (const relationId of currentRelationIds) {
    const relation = after.relations[relationId];
    if (!relation) {
      throw maintenanceError(
        "startup_recovery_projection_mismatch",
        `relation ${relationId} disappeared while preparing recovery`
      );
    }
    recoverRecord(relation, timestamp);
    const operation = after.operations[relation.operationId];
    if (!operation
      || operation.relationId !== relationId
      || operation.phase !== relation.phase
      || operation.reason !== relation.reason) {
      throw maintenanceError(
        "startup_recovery_projection_mismatch",
        `relation ${relationId} and its operation did not remain paired`
      );
    }
  }
  after.revision = state.revision + 1;
  after.updatedAt = timestamp;

  const afterBytes = Buffer.from(JSON.stringify(after, null, 2), "utf8");
  const afterRawSha256 = sha256(afterBytes);
  const scopeProjection = projectStartupRecoveryScope(afterBytes);
  if (!scopeProjection.eligible || scopeProjection.stateVersion !== 2) {
    throw maintenanceError(
      "startup_recovery_after_invalid",
      "the exact after state is not an eligible V2 recovery projection"
    );
  }
  const transactionId = sha256([
    policyVersion,
    deploymentId,
    oldContainerId,
    String(beforeProjection.revision),
    beforeRawSha256,
    closureProofSha256,
    scopeProjection.scopeProjectionSha256
  ].join("|"));
  const carriedDescriptors = [...inherited, ...scopeProjection.descriptors]
    .map(descriptor => structuredClone(descriptor))
    .sort(compareDescriptorIdentity);
  const uniqueDescriptors = carriedDescriptors.filter((descriptor, index) => (
    index === 0
    || stableJson(descriptor) !== stableJson(carriedDescriptors[index - 1])
  ));
  const historyClosure = Object.freeze({
    schemaVersion: "1",
    transactionId,
    previousHistoryClosureSha256,
    scopeProjectionSha256: scopeProjection.scopeProjectionSha256,
    descriptors: Object.freeze(uniqueDescriptors.map(deepFreeze))
  });
  const historyClosureBytes = Buffer.from(
    JSON.stringify(historyClosure, null, 2),
    "utf8"
  );
  const historyClosureSha256 = sha256(historyClosureBytes);

  return Object.freeze({
    required: true,
    transactionId,
    deploymentId,
    policyVersion,
    oldContainerId,
    targetEpoch,
    createdFromEpoch,
    createdAt: timestamp,
    beforeRevision: beforeProjection.revision,
    beforeRawSha256,
    afterRevision: after.revision,
    afterRawSha256,
    afterBytesSha256: afterRawSha256,
    afterBytes,
    closureProofSha256,
    scopeProjection,
    scopeProjectionSha256: scopeProjection.scopeProjectionSha256,
    historyClosure,
    historyClosureBytes,
    historyClosureSha256,
    inheritedDescriptors: Object.freeze(inherited.map(deepFreeze))
  });
}

function recoverRecord(record, timestamp) {
  record.phase = "unknown";
  record.reason = RECOVERY_REASON;
  record.cleanupRequired = false;
  record.commitUncertain = false;
  record.cleanupEvidence = null;
  record.protectionDigest = null;
  record.provisionalEvidence = null;
  record.runtimeIdentity = null;
  record.runningEvidenceDigest = null;
  record.updatedAt = timestamp;
}

function compareDescriptorIdentity(left, right) {
  return String(left.kind).localeCompare(String(right.kind))
    || String(left.relationId).localeCompare(String(right.relationId))
    || String(left.oldOperationId ?? left.operationId)
      .localeCompare(String(right.oldOperationId ?? right.operationId));
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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function recoveryJournalRecord(recovery) {
  if (!recovery?.required) {
    return null;
  }
  return Object.freeze({
    schemaVersion: "1",
    transactionId: recovery.transactionId,
    status: "prepared",
    deploymentId: recovery.deploymentId,
    policyVersion: recovery.policyVersion,
    oldContainerId: recovery.oldContainerId,
    targetEpoch: recovery.targetEpoch,
    createdFromEpoch: recovery.createdFromEpoch,
    createdAt: recovery.createdAt,
    beforeRevision: recovery.beforeRevision,
    beforeRawSha256: recovery.beforeRawSha256,
    afterRevision: recovery.afterRevision,
    afterRawSha256: recovery.afterRawSha256,
    afterBytesSha256: recovery.afterBytesSha256,
    closureProofSha256: recovery.closureProofSha256,
    scopeProjectionSha256: recovery.scopeProjectionSha256,
    historyClosureSha256: recovery.historyClosureSha256,
    previousHistoryClosureSha256:
      recovery.historyClosure.previousHistoryClosureSha256,
    inheritedDescriptors: recovery.inheritedDescriptors,
    descriptors: recovery.historyClosure.descriptors
  });
}

export async function runStartupMaintenanceTransaction({
  recoveryDir,
  statePath,
  ownerLease,
  assertOwnerLease,
  transaction,
  readStateBytes = readStateBytesExact,
  onBoundary = async () => {}
} = {}) {
  if (typeof recoveryDir !== "string"
    || !isAbsolute(recoveryDir)
    || typeof statePath !== "string"
    || !isAbsolute(statePath)
    || basename(statePath) !== "relation-services.json"
    || typeof assertOwnerLease !== "function"
    || typeof readStateBytes !== "function"
    || typeof onBoundary !== "function") {
    throw maintenanceError(
      "startup_recovery_input_invalid",
      "maintenance requires exact recovery, state, owner, and reader inputs"
    );
  }
  await assertOwnerLease(ownerLease);
  const {
    prepareRecoveryTransaction,
    resumeRecoveryTransaction,
    reuseCommittedRecoveryTransaction
  } = await import(
    "./runtimeRecoveryTransaction.js"
  );
  const leaseCheckpoint = async () => assertOwnerLease(ownerLease);
  if (transaction?.succession?.mode === "reuse-after"
    && transaction.succession.sourceTransactionId !== null) {
    const bytes = await readStateBytes(statePath, ownerLease, assertOwnerLease);
    try {
      return await reuseCommittedRecoveryTransaction({
        recoveryDir,
        statePath,
        bytes,
        beforeRawSha256: transaction.beforeRawSha256,
        succession: transaction.succession,
        assertOwnerLease: leaseCheckpoint
      });
    } finally {
      bytes.fill(0);
    }
  }
  let resumed = await resumeRecoveryTransaction({
    recoveryDir,
    statePath,
    assertOwnerLease: leaseCheckpoint
  });
  if (resumed === null) {
    if (transaction === null || typeof transaction !== "object") {
      throw maintenanceError(
        "startup_recovery_input_invalid",
        "a new recovery transaction requires exact maintenance input"
      );
    }
    const bytes = await readStateBytes(statePath, ownerLease, assertOwnerLease);
    const prepared = await prepareRecoveryTransaction({
      ...transaction,
      recoveryDir,
      statePath,
      bytes,
      onBoundary,
      assertOwnerLease: leaseCheckpoint
    });
    bytes.fill(0);
    if (!prepared.required) {
      return Object.freeze({
        required: false,
        revision: prepared.afterRevision,
        rawSha256: prepared.afterRawSha256
      });
    }
    resumed = await resumeRecoveryTransaction({
      recoveryDir,
      statePath,
      assertOwnerLease: leaseCheckpoint
    });
  }
  await assertOwnerLease(ownerLease);
  if (resumed === null || resumed.journal.status !== "after-verified") {
    throw maintenanceError(
      "startup_recovery_incomplete",
      "maintenance did not reach one exact after-verified transaction"
    );
  }
  return Object.freeze({
    required: true,
    transactionId: resumed.transactionId,
    revision: resumed.journal.afterRevision,
    rawSha256: resumed.journal.afterRawSha256,
    afterRawSha256: resumed.journal.afterRawSha256,
    scopeProjectionSha256: resumed.journal.scopeProjectionSha256,
    historyClosureSha256: resumed.journal.historyClosureSha256,
    previousHistoryClosureSha256:
      resumed.journal.previousHistoryClosureSha256,
    closureProofSha256: resumed.journal.closureProofSha256,
    targetEpoch: resumed.journal.targetEpoch
  });
}

async function readStateBytesExact(statePath, ownerLease, assertOwnerLease) {
  await assertOwnerLease(ownerLease);
  const parent = dirname(statePath);
  const parentInfo = await lstat(parent);
  const canonicalParent = await realpath(parent);
  const info = await lstat(statePath);
  if (!parentInfo.isDirectory()
    || resolve(canonicalParent) !== resolve(parent)
    || !info.isFile()
    || info.isSymbolicLink()
    || info.size > MAX_STATE_BYTES) {
    throw maintenanceError(
      "startup_recovery_state_invalid",
      "state input must be one bounded regular file in its canonical parent"
    );
  }
  const bytes = await readFile(statePath);
  await assertOwnerLease(ownerLease);
  return bytes;
}
