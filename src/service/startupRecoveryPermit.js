import { createHash } from "node:crypto";

const AUTHORITY = Symbol("startupRecoveryAuthority");
const INSTALLATIONS = new WeakMap();
const INSTALLED_AUTHORITIES = new WeakSet();
const DIGEST = /^[a-f0-9]{64}$/;

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      `${label} must be a non-empty string`
    );
  }
}

function stableSerialize(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortValue(value[key])])
    );
  }
  return value;
}

function digestValue(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeDescriptor(input) {
  if (!isPlainObject(input)) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "recovery descriptor must be a plain object"
    );
  }
  const descriptor = {
    schemaVersion: input.schemaVersion,
    relationId: input.relationId,
    oldOperationId: input.oldOperationId,
    oldGeneration: input.oldGeneration,
    handleDigest: input.handleDigest,
    identityDigest: input.identityDigest,
    requestDigest: input.requestDigest,
    relationRecordSha256: input.relationRecordSha256,
    operationRecordSha256: input.operationRecordSha256,
    historySha256: input.historySha256,
    history: input.history
  };
  if (descriptor.schemaVersion !== "1") {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "recovery descriptor schemaVersion must be 1"
    );
  }
  for (const key of [
    "relationId",
    "oldOperationId",
    "oldGeneration"
  ]) {
    requireText(descriptor[key], key);
  }
  for (const key of [
    "handleDigest",
    "identityDigest",
    "requestDigest",
    "relationRecordSha256",
    "operationRecordSha256",
    "historySha256"
  ]) {
    requireDigest(descriptor[key], key);
  }
  if (!Array.isArray(descriptor.history) || descriptor.history.length > 100_000) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "history must be a bounded array"
    );
  }
  const history = descriptor.history.map((entry) => {
    if (!isPlainObject(entry)) {
      throw recoveryError(
        "startup_recovery_authority_invalid",
        "history entry must be a plain object"
      );
    }
    const normalized = {
      operationId: entry.operationId,
      generation: entry.generation,
      handleDigest: entry.handleDigest,
      phase: entry.phase,
      action: entry.action,
      requestDigest: entry.requestDigest,
      recordSha256: entry.recordSha256
    };
    requireText(normalized.operationId, "history.operationId");
    if (normalized.generation !== null) {
      requireText(normalized.generation, "history.generation");
    }
    if (normalized.handleDigest !== "") {
      requireDigest(normalized.handleDigest, "history.handleDigest");
    }
    requireText(normalized.phase, "history.phase");
    requireText(normalized.action, "history.action");
    requireDigest(normalized.requestDigest, "history.requestDigest");
    requireDigest(normalized.recordSha256, "history.recordSha256");
    return Object.freeze(normalized);
  });
  history.sort((left, right) => left.operationId.localeCompare(right.operationId));
  if (digestValue(history) !== descriptor.historySha256) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "historySha256 does not match the exact generation history"
    );
  }
  descriptor.history = Object.freeze(history);
  return Object.freeze(descriptor);
}

export function mintStartupRecoveryAuthority(input = {}) {
  if (!isPlainObject(input)) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "batch authority input must be a plain object"
    );
  }
  requireText(input.deploymentId, "deploymentId");
  requireText(input.targetEpoch, "targetEpoch");
  requireText(input.transactionId, "transactionId");
  if (!Number.isSafeInteger(input.initialRevision) || input.initialRevision < 0) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "initialRevision must be a non-negative safe integer"
    );
  }
  for (const key of [
    "initialRawSha256",
    "scopeProjectionSha256",
    "closureProofSha256"
  ]) {
    requireDigest(input[key], key);
  }
  if (!Array.isArray(input.descriptors) || input.descriptors.length === 0) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "batch authority requires at least one recovered relation"
    );
  }
  const descriptors = input.descriptors.map(normalizeDescriptor);
  const relationIds = new Set();
  for (const descriptor of descriptors) {
    if (relationIds.has(descriptor.relationId)) {
      throw recoveryError(
        "startup_recovery_authority_invalid",
        "batch authority contains a duplicate relation"
      );
    }
    relationIds.add(descriptor.relationId);
  }
  descriptors.sort((left, right) => left.relationId.localeCompare(right.relationId));
  const authority = Object.freeze(Object.create(null, {
    [AUTHORITY]: {
      value: Object.freeze({
        deploymentId: input.deploymentId,
        targetEpoch: input.targetEpoch,
        transactionId: input.transactionId,
        initialRevision: input.initialRevision,
        initialRawSha256: input.initialRawSha256,
        scopeProjectionSha256: input.scopeProjectionSha256,
        closureProofSha256: input.closureProofSha256,
        descriptors: Object.freeze(descriptors)
      })
    }
  }));
  return authority;
}

export function installStartupRecoveryAuthority(manager, authority) {
  if (!manager || typeof manager !== "object") {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "manager facade must be an object"
    );
  }
  const metadata = authority?.[AUTHORITY];
  if (!metadata) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "recovery authority is not an opaque minted capability"
    );
  }
  if (INSTALLED_AUTHORITIES.has(authority)) {
    throw recoveryError(
      "startup_recovery_authority_installed",
      "startup recovery authority has already been installed"
    );
  }
  if (INSTALLATIONS.has(manager)) {
    throw recoveryError(
      "startup_recovery_authority_installed",
      "manager already has a startup recovery authority"
    );
  }
  INSTALLATIONS.set(manager, {
    metadata,
    currentRevision: metadata.initialRevision,
    currentRawSha256: metadata.initialRawSha256,
    remaining: new Map(
      metadata.descriptors.map(descriptor => [descriptor.relationId, descriptor])
    ),
    reservedRelationId: null,
    invalidated: false
  });
  INSTALLED_AUTHORITIES.add(authority);
}

export function selectStartupRecoveryDescriptor(manager, {
  relationId,
  state,
  revision,
  rawSha256
} = {}) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation) {
    return null;
  }
  if (installation.invalidated) {
    throw recoveryError(
      "startup_recovery_authority_invalidated",
      "startup recovery authority was invalidated"
    );
  }
  if (installation.reservedRelationId !== null) {
    throw recoveryError(
      "startup_recovery_batch_busy",
      "another recovered relation still owns the sequential batch slot"
    );
  }
  const descriptor = installation.remaining.get(relationId);
  if (!descriptor) {
    return null;
  }
  if (revision !== installation.currentRevision
    || rawSha256 !== installation.currentRawSha256) {
    throw recoveryError(
      "startup_recovery_baseline_mismatch",
      "state revision and raw digest do not match the current manager recovery baseline"
    );
  }
  verifyDescriptor(descriptor, state);
  return descriptor;
}

export function reserveStartupRecoveryDescriptor(manager, descriptor) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation || installation.invalidated) {
    throw recoveryError(
      "startup_recovery_authority_invalidated",
      "startup recovery authority is unavailable"
    );
  }
  if (installation.reservedRelationId !== null) {
    throw recoveryError(
      "startup_recovery_batch_busy",
      "another recovered relation still owns the sequential batch slot"
    );
  }
  if (installation.remaining.get(descriptor.relationId) !== descriptor) {
    throw recoveryError(
      "startup_recovery_descriptor_mismatch",
      "recovery descriptor is no longer registered"
    );
  }
  installation.reservedRelationId = descriptor.relationId;
}

export function consumeStartupRecoveryReservation(manager, {
  relationId,
  revision,
  rawSha256
}) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation
    || installation.invalidated
    || installation.reservedRelationId !== relationId) {
    throw recoveryError(
      "startup_recovery_authority_invalidated",
      "recovery reservation is not active"
    );
  }
  if (!installation.remaining.delete(relationId)) {
    throw recoveryError(
      "startup_recovery_descriptor_mismatch",
      "recovery descriptor was already consumed"
    );
  }
  installation.currentRevision = revision;
  installation.currentRawSha256 = rawSha256;
}

export function advanceStartupRecoveryBaseline(manager, {
  revision,
  rawSha256
} = {}) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation || installation.invalidated) {
    return;
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw recoveryError(
      "startup_recovery_authority_invalid",
      "advanced recovery revision must be a non-negative safe integer"
    );
  }
  requireDigest(rawSha256, "rawSha256");
  if (revision < installation.currentRevision) {
    throw recoveryError(
      "startup_recovery_baseline_mismatch",
      "recovery authority revision cannot move backwards"
    );
  }
  installation.currentRevision = revision;
  installation.currentRawSha256 = rawSha256;
}

export function completeStartupRecoveryStart(manager, relationId) {
  const installation = INSTALLATIONS.get(manager);
  if (installation?.reservedRelationId === relationId) {
    installation.reservedRelationId = null;
  }
}

export function releaseStartupRecoveryReservation(manager, {
  relationId,
  outcome
}) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation || installation.reservedRelationId !== relationId) {
    return;
  }
  if (outcome === "uncertain") {
    installation.invalidated = true;
    installation.remaining.clear();
    installation.reservedRelationId = null;
    return;
  }
  if (outcome === "not_committed") {
    installation.reservedRelationId = null;
  }
}

export function startupRecoveryAuthorityState(manager) {
  const installation = INSTALLATIONS.get(manager);
  if (!installation) {
    return null;
  }
  return Object.freeze({
    invalidated: installation.invalidated,
    reservedRelationId: installation.reservedRelationId,
    remainingRelationIds: Object.freeze(
      [...installation.remaining.keys()].sort()
    )
  });
}

function verifyDescriptor(descriptor, state) {
  const relation = state?.relations?.[descriptor.relationId];
  const operation = state?.operations?.[descriptor.oldOperationId];
  if (!relation || !operation) {
    throw recoveryError(
      "startup_recovery_descriptor_mismatch",
      "the exact old relation or operation no longer exists"
    );
  }
  if (relation.desired !== "enabled"
    || relation.phase !== "unknown"
    || operation.phase !== "unknown"
    || relation.operationId !== descriptor.oldOperationId
    || operation.relationId !== descriptor.relationId
    || operation.operationId !== descriptor.oldOperationId
    || relation.generation !== descriptor.oldGeneration
    || operation.generation !== descriptor.oldGeneration
    || relation.handleDigest !== descriptor.handleDigest
    || operation.handleDigest !== descriptor.handleDigest
    || relation.identityDigest !== descriptor.identityDigest
    || relation.requestDigest !== descriptor.requestDigest
    || operation.requestDigest !== descriptor.requestDigest) {
    throw recoveryError(
      "startup_recovery_descriptor_mismatch",
      "the exact old recovery descriptor changed"
    );
  }
  if (digestValue(relation) !== descriptor.relationRecordSha256
    || digestValue(operation) !== descriptor.operationRecordSha256) {
    throw recoveryError(
      "startup_recovery_descriptor_mismatch",
      "an old recovery record digest changed"
    );
  }
  const currentOperationIds = new Set(
    Object.values(state.relations).map(record => record.operationId)
  );
  const history = Object.entries(state.operations)
    .filter(([operationId, record]) => (
      record.relationId === descriptor.relationId
      && operationId !== descriptor.oldOperationId
      && !currentOperationIds.has(operationId)
    ))
    .map(([operationId, record]) => ({
      operationId,
      generation: record.generation,
      handleDigest: record.handleDigest,
      phase: record.phase,
      action: record.action,
      requestDigest: record.requestDigest,
      recordSha256: digestValue(record)
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  if (digestValue(history) !== descriptor.historySha256
    || stableSerialize(history) !== stableSerialize(descriptor.history)) {
    throw recoveryError(
      "startup_recovery_history_mismatch",
      "the exact generation history changed"
    );
  }
}

export function digestRecoveryValue(value) {
  return digestValue(value);
}
