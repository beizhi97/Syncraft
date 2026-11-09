import { createHash } from "node:crypto";

import {
  deepFreeze,
  normalizeStartupStateLimits,
  parseStrictStateJson,
  STARTUP_STATE_POLICY_LIMITS,
  StrictStateJsonError
} from "./strictStateJson.js";

const STATE_KIND = "relation-file-service-manager-state";
const V1_STORAGE_CONTRACT =
  "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1";
const V2_STORAGE_CONTRACT =
  "single-manager-owner+injected-scoped-locks+durable-json-replace-v2";

const STATE_KEYS = freezeKeys([
  "createdAt",
  "kind",
  "operations",
  "relations",
  "revision",
  "storageContract",
  "updatedAt",
  "version"
]);
const V1_OPERATION_KEYS = freezeKeys([
  "action",
  "createdAt",
  "generation",
  "handleDigest",
  "operationId",
  "phase",
  "reason",
  "relationId",
  "requestDigest",
  "updatedAt"
]);
const V1_RELATION_KEYS = freezeKeys([
  "desired",
  "generation",
  "handle",
  "handleDigest",
  "identityDigest",
  "operationId",
  "phase",
  "reason",
  "relationId",
  "requestDigest",
  "updatedAt"
]);
const V2_OPERATION_KEYS = freezeKeys([
  "action",
  "cleanupEvidence",
  "cleanupRequired",
  "commitUncertain",
  "createdAt",
  "expectedHandleDigest",
  "generation",
  "handleDigest",
  "operationId",
  "phase",
  "protectionDigest",
  "provisionalEvidence",
  "reason",
  "recordOrigin",
  "relationId",
  "requestDigest",
  "runningEvidenceDigest",
  "runtimeIdentity",
  "updatedAt"
]);
const V2_RELATION_KEYS = freezeKeys([
  "cleanupEvidence",
  "cleanupRequired",
  "commitUncertain",
  "desired",
  "expectedHandleDigest",
  "generation",
  "handle",
  "handleDigest",
  "identityDigest",
  "operationId",
  "phase",
  "protectionDigest",
  "provisionalEvidence",
  "reason",
  "recordOrigin",
  "relationId",
  "requestDigest",
  "runningEvidenceDigest",
  "runtimeIdentity",
  "updatedAt"
]);
const HANDLE_KEYS = freezeKeys(["generation", "relationId", "token"]);
const RUNTIME_IDENTITY_KEYS = freezeKeys([
  "executable",
  "listener",
  "manager",
  "namespace",
  "process",
  "schemaVersion",
  "tokenSha256"
]);
const RUNTIME_NAMESPACE_KEYS = freezeKeys(["bootId", "pidNamespaceId"]);
const RUNTIME_MANAGER_KEYS = freezeKeys(["pid", "starttime"]);
const RUNTIME_PROCESS_KEYS = freezeKeys([
  "parentPid",
  "parentStarttime",
  "pid",
  "starttime"
]);
const RUNTIME_EXECUTABLE_KEYS = freezeKeys(["launcher", "target"]);
const EXECUTABLE_IDENTITY_KEYS = freezeKeys(["dev", "ino", "sha256", "size"]);
const EXPECTED_LISTENER_KEYS = freezeKeys(["host", "port", "role"]);
const PROVISIONAL_EVIDENCE_KEYS = freezeKeys([
  "capabilitiesCleared",
  "executableMatches",
  "launcherReady",
  "listenerOpen",
  "noNewPrivs",
  "observedAt",
  "parentDeathSignal",
  "parentMatches",
  "preExecLauncherExeMatches",
  "preExecTokenMatches",
  "preparedTargetMatchesFd3",
  "processRunning",
  "schemaVersion",
  "tokenMatches"
]);
const CLEANUP_EVIDENCE_KEYS = freezeKeys([
  "abortCompleted",
  "abortRequested",
  "childrenExited",
  "containmentConfirmed",
  "continuationRegistered",
  "disposition",
  "exactHandleIdentity",
  "lastRuntimeCheckpoint",
  "lateGo",
  "latePrepare",
  "leaseReturned",
  "listenerClosed",
  "processExited",
  "reasonCode",
  "runtimeInvoked",
  "schemaVersion",
  "sessionsClosed"
]);
const CLEANUP_IDENTITY_KEYS = freezeKeys([
  "generation",
  "handleDigest",
  "relationId"
]);

const V1_PHASES = new Set(["pending", "stopping", "stopped"]);
const V2_PHASES = new Set([
  "pending",
  "stopping",
  "stopped",
  "starting",
  "prepared",
  "running",
  "start_failed",
  "cleanup_required",
  "commit_uncertain",
  "unknown"
]);
const CHECKPOINTS = new Set([
  "reservation",
  "protection",
  "prepare-pending",
  "prepare-ready",
  "provisional-durable",
  "go-pending",
  "go-returned",
  "inspect-pending",
  "inspect-ready",
  "finalize-pending"
]);
const LATE_PREPARE = new Set([
  "not-applicable",
  "pending",
  "lease-returned",
  "invalid",
  "rejected"
]);
const LATE_GO = new Set(["not-applicable", "pending", "returned"]);

const ERROR_CODES = Object.freeze({
  input: "startup_quiescence_input_invalid",
  tooLarge: "startup_quiescence_state_too_large",
  depth: "startup_quiescence_depth_exceeded",
  nodes: "startup_quiescence_node_limit_exceeded",
  json: "startup_quiescence_json_invalid",
  duplicate: "startup_quiescence_duplicate_key",
  schema: "startup_quiescence_schema_invalid",
  current: "startup_quiescence_current_unresolved",
  identity: "startup_quiescence_identity_missing",
  cleanup: "startup_quiescence_cleanup_unconfirmed",
  history: "startup_quiescence_history_unresolved",
  orphan: "startup_quiescence_orphan_unresolved"
});

const CATEGORY_ORDER = Object.freeze({
  error: 0,
  global: 1,
  current: 2,
  history: 3,
  orphan: 4
});
const CODE_ORDER = Object.freeze({
  [ERROR_CODES.input]: 0,
  [ERROR_CODES.tooLarge]: 1,
  [ERROR_CODES.depth]: 2,
  [ERROR_CODES.nodes]: 3,
  [ERROR_CODES.json]: 4,
  [ERROR_CODES.duplicate]: 5,
  [ERROR_CODES.schema]: 6,
  [ERROR_CODES.cleanup]: 7,
  [ERROR_CODES.identity]: 8,
  [ERROR_CODES.current]: 9,
  [ERROR_CODES.history]: 10,
  [ERROR_CODES.orphan]: 11
});
const PHASE_ORDER = Object.freeze({
  pending: 0,
  stopping: 1,
  stopped: 2,
  starting: 3,
  prepared: 4,
  running: 5,
  start_failed: 6,
  cleanup_required: 7,
  commit_uncertain: 8,
  unknown: 9
});

export function evaluateManagerHistoryClosure(bytes, options) {
  let limits;
  try {
    limits = normalizeStartupStateLimits(options);
  } catch {
    return errorResult({
      code: ERROR_CODES.input,
      scope: "input",
      limits: null
    });
  }

  let parsed;
  try {
    parsed = parseStrictStateJson(bytes, limits);
  } catch (error) {
    if (!(error instanceof StrictStateJsonError)) {
      throw error;
    }
    return errorResult({
      code: error.code,
      scope: error.code === ERROR_CODES.tooLarge
        || error.code === ERROR_CODES.depth
        || error.code === ERROR_CODES.nodes
        ? "resource"
        : error.code === ERROR_CODES.input
          ? "input"
          : "json",
      limits,
      rawSha256: error.rawSha256,
      observedBytes: error.observedBytes,
      nodeCount: error.nodeCount
    });
  }

  let validated;
  try {
    validated = validateManagerState(parsed.value);
  } catch (error) {
    if (!(error instanceof SchemaFailure)) {
      throw error;
    }
    return errorResult({
      code: ERROR_CODES.schema,
      scope: "schema",
      limits,
      rawSha256: parsed.rawSha256,
      observedBytes: parsed.observedBytes,
      nodeCount: parsed.nodeCount
    });
  }

  return evaluateValidatedState(validated, parsed, limits);
}

/**
 * Private admission projection. The accepted public parser result above remains
 * aggregate-only and always keeps fullStartupAdmission=false. This projection is
 * imported only by the startup gate and maintenance transaction code.
 */
export function projectStartupRecoveryScope(bytes, options) {
  let limits;
  try {
    limits = options == null
      ? STARTUP_STATE_POLICY_LIMITS
      : normalizeStartupStateLimits(options);
  } catch {
    return privateProjectionFailure(ERROR_CODES.input, null);
  }

  let parsed;
  try {
    parsed = parseStrictStateJson(bytes, limits);
  } catch (error) {
    if (!(error instanceof StrictStateJsonError)) {
      throw error;
    }
    return privateProjectionFailure(error.code, error.rawSha256);
  }

  let validated;
  try {
    validated = validateManagerState(parsed.value);
  } catch (error) {
    if (!(error instanceof SchemaFailure)) {
      throw error;
    }
    return privateProjectionFailure(ERROR_CODES.schema, parsed.rawSha256);
  }

  const state = validated.state;
  if (validated.version === 1
    && (Object.keys(state.operations).length !== 0
      || Object.keys(state.relations).length !== 0)) {
    return privateProjectionFailure(
      ERROR_CODES.schema,
      parsed.rawSha256,
      state.revision
    );
  }
  if (validated.version === 1) {
    const descriptors = Object.freeze([]);
    return deepFreeze({
      schemaVersion: "1",
      eligible: true,
      code: null,
      stateVersion: 1,
      revision: state.revision,
      rawSha256: parsed.rawSha256,
      descriptors,
      authorityDescriptors: descriptors,
      scopeProjectionSha256: digestProjectionValue(descriptors)
    });
  }

  const operationEntries = Object.entries(state.operations);
  const relationEntries = Object.entries(state.relations);
  const currentOperationIds = new Set(
    relationEntries.map(([, relation]) => relation.operationId)
  );
  const terminalProofs = buildTerminalProofs(operationEntries);
  const historicalOperations = [];
  const orphanOperations = [];
  for (const [operationId, operation] of operationEntries) {
    if (currentOperationIds.has(operationId)) {
      continue;
    }
    if (Object.hasOwn(state.relations, operation.relationId)) {
      historicalOperations.push([operationId, operation]);
    } else {
      orphanOperations.push([operationId, operation]);
    }
  }

  const descriptors = [];
  for (const [relationId, relation] of relationEntries) {
    if (relation.phase === "stopped" || relation.phase === "start_failed") {
      continue;
    }
    const operation = state.operations[relation.operationId];
    if (!operation) {
      return privateProjectionFailure(
        ERROR_CODES.schema,
        parsed.rawSha256,
        state.revision
      );
    }
    const history = historicalOperations
      .filter(([, candidate]) => candidate.relationId === relationId)
      .map(([operationId, candidate]) => historyDescriptor(operationId, candidate))
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    descriptors.push({
      kind: "current",
      scope: "current",
      code: isUncertainRecord(relation)
        ? uncertaintyCode(relation, "current")
        : relation.phase === "starting"
          ? ERROR_CODES.identity
          : relation.phase === "cleanup_required"
            ? ERROR_CODES.cleanup
            : ERROR_CODES.current,
      relationId,
      oldOperationId: relation.operationId,
      oldGeneration: relation.generation,
      handleDigest: relation.handleDigest,
      identityDigest: relation.identityDigest,
      requestDigest: relation.requestDigest,
      desired: relation.desired,
      phase: relation.phase,
      action: operation.action,
      relationRecordSha256: digestProjectionValue(relation),
      operationRecordSha256: digestProjectionValue(operation),
      history,
      historySha256: digestProjectionValue(history)
    });
  }

  for (const [operationId, operation] of historicalOperations) {
    const closure = classifyOperationClosure(operationId, operation, terminalProofs);
    if (closure === "closed") {
      continue;
    }
    descriptors.push({
      kind: "history",
      scope: "history",
      code: closure === "identity_missing"
        ? ERROR_CODES.identity
        : isUncertainRecord(operation)
          ? uncertaintyCode(operation, "history")
          : ERROR_CODES.history,
      operationId,
      relationId: operation.relationId,
      generation: operation.generation,
      handleDigest: operation.handleDigest,
      requestDigest: operation.requestDigest,
      phase: operation.phase,
      action: operation.action,
      recordSha256: digestProjectionValue(operation)
    });
  }

  for (const [operationId, operation] of orphanOperations) {
    const closure = classifyOperationClosure(operationId, operation, terminalProofs);
    if (closure === "closed") {
      continue;
    }
    descriptors.push({
      kind: "orphan",
      scope: "orphan",
      code: closure === "identity_missing"
        ? ERROR_CODES.identity
        : isUncertainRecord(operation)
          ? uncertaintyCode(operation, "orphan")
          : ERROR_CODES.orphan,
      operationId,
      relationId: operation.relationId,
      generation: operation.generation,
      handleDigest: operation.handleDigest,
      requestDigest: operation.requestDigest,
      phase: operation.phase,
      action: operation.action,
      recordSha256: digestProjectionValue(operation)
    });
  }

  descriptors.sort(compareScopeDescriptors);
  const authorityDescriptors = descriptors
    .filter(descriptor => (
      descriptor.kind === "current"
      && descriptor.desired === "enabled"
      && descriptor.phase === "unknown"
      && descriptor.action === "start"
      && isDigest(descriptor.handleDigest)
      && typeof descriptor.oldGeneration === "string"
    ))
    .map(descriptor => ({
      schemaVersion: "1",
      relationId: descriptor.relationId,
      oldOperationId: descriptor.oldOperationId,
      oldGeneration: descriptor.oldGeneration,
      handleDigest: descriptor.handleDigest,
      identityDigest: descriptor.identityDigest,
      requestDigest: descriptor.requestDigest,
      relationRecordSha256: descriptor.relationRecordSha256,
      operationRecordSha256: descriptor.operationRecordSha256,
      historySha256: descriptor.historySha256,
      history: descriptor.history
    }))
    .sort((left, right) => left.relationId.localeCompare(right.relationId));

  const frozenDescriptors = Object.freeze(descriptors.map(value => (
    deepFreeze(value)
  )));
  const frozenAuthority = Object.freeze(authorityDescriptors.map(value => (
    deepFreeze(value)
  )));
  return deepFreeze({
    schemaVersion: "1",
    eligible: true,
    code: frozenDescriptors[0]?.code ?? null,
    stateVersion: 2,
    revision: state.revision,
    rawSha256: parsed.rawSha256,
    descriptors: frozenDescriptors,
    authorityDescriptors: frozenAuthority,
    scopeProjectionSha256: digestProjectionValue(frozenDescriptors)
  });
}

function privateProjectionFailure(code, rawSha256, revision = null) {
  return deepFreeze({
    schemaVersion: "1",
    eligible: false,
    code,
    stateVersion: null,
    revision,
    rawSha256,
    descriptors: Object.freeze([]),
    authorityDescriptors: Object.freeze([]),
    scopeProjectionSha256: null
  });
}

function historyDescriptor(operationId, operation) {
  return {
    operationId,
    generation: operation.generation,
    handleDigest: operation.handleDigest,
    phase: operation.phase,
    action: operation.action,
    requestDigest: operation.requestDigest,
    recordSha256: digestProjectionValue(operation)
  };
}

function compareScopeDescriptors(left, right) {
  const rank = { current: 0, history: 1, orphan: 2 };
  return rank[left.kind] - rank[right.kind]
    || String(left.relationId).localeCompare(String(right.relationId))
    || String(left.oldOperationId ?? left.operationId)
      .localeCompare(String(right.oldOperationId ?? right.operationId));
}

function evaluateValidatedState(validated, parsed, limits) {
  const state = validated.state;
  const operationEntries = Object.entries(state.operations);
  const relationEntries = Object.entries(state.relations);
  const currentOperationIds = new Set(
    relationEntries.map(([, relation]) => relation.operationId)
  );
  const blockers = new BlockerSet();

  const terminalProofs = buildTerminalProofs(operationEntries);
  const historicalOperations = [];
  const orphanOperations = [];

  for (const [operationId, operation] of operationEntries) {
    if (currentOperationIds.has(operationId)) {
      continue;
    }
    if (Object.hasOwn(state.relations, operation.relationId)) {
      historicalOperations.push([operationId, operation]);
    } else {
      orphanOperations.push([operationId, operation]);
    }
  }

  for (const [, relation] of relationEntries) {
    if (isUncertainRecord(relation)) {
      blockers.add(
        "global",
        "current",
        uncertaintyCode(relation, "current"),
        relation.phase
      );
    }
  }
  for (const [, operation] of [...historicalOperations, ...orphanOperations]) {
    if (!isUncertainRecord(operation)) {
      continue;
    }
    const scope = Object.hasOwn(state.relations, operation.relationId)
      ? "history"
      : "orphan";
    blockers.add(
      "global",
      scope,
      uncertaintyCode(operation, scope),
      operation.phase
    );
  }

  for (const [, relation] of relationEntries) {
    if (isUncertainRecord(relation)) {
      continue;
    }
    if (validated.version === 1) {
      if (relation.phase !== "stopped") {
        blockers.add(
          "current",
          "current",
          ERROR_CODES.current,
          relation.phase
        );
      }
      continue;
    }
    if (relation.phase === "stopped"
      || relation.phase === "start_failed") {
      continue;
    }
    blockers.add(
      "current",
      "current",
      relation.phase === "starting"
        ? ERROR_CODES.identity
        : relation.phase === "cleanup_required"
          ? ERROR_CODES.cleanup
          : ERROR_CODES.current,
      relation.phase
    );
  }

  let closedHistoricalOperations = 0;
  for (const [operationId, operation] of historicalOperations) {
    if (isUncertainRecord(operation)) {
      continue;
    }
    const closure = classifyOperationClosure(
      operationId,
      operation,
      terminalProofs
    );
    if (closure === "closed") {
      closedHistoricalOperations += 1;
      continue;
    }
    blockers.add(
      "history",
      "history",
      closure === "identity_missing"
        ? ERROR_CODES.identity
        : ERROR_CODES.history,
      operation.phase
    );
  }

  for (const [operationId, operation] of orphanOperations) {
    if (isUncertainRecord(operation)) {
      continue;
    }
    const closure = classifyOperationClosure(
      operationId,
      operation,
      terminalProofs
    );
    if (closure === "closed") {
      continue;
    }
    blockers.add(
      "orphan",
      "orphan",
      closure === "identity_missing"
        ? ERROR_CODES.identity
        : ERROR_CODES.orphan,
      operation.phase
    );
  }

  const frozenBlockers = blockers.freeze();
  const primary = blockers.primary();
  const blocked = frozenBlockers.length > 0;
  return deepFreeze({
    schemaVersion: "1",
    decision: blocked ? "blocked" : "historical_closed",
    historicalClosureEligible: !blocked,
    fullStartupAdmission: false,
    fullAdmissionCode:
      "startup_quiescence_runtime_provenance_required",
    code: primary?.code ?? null,
    stateVersion: validated.version,
    storageContract: state.storageContract,
    revision: state.revision,
    rawSha256: parsed.rawSha256,
    observedBytes: parsed.observedBytes,
    nodeCount: parsed.nodeCount,
    limits,
    counts: {
      operations: operationEntries.length,
      relations: relationEntries.length,
      currentRelations: relationEntries.length,
      historicalOperations: historicalOperations.length,
      terminalProofs: countTerminalProofs(terminalProofs),
      closedHistoricalOperations,
      blockers: frozenBlockers.reduce(
        (total, blocker) => total + blocker.count,
        0
      )
    },
    blockers: frozenBlockers
  });
}

function errorResult({
  code,
  scope,
  limits,
  rawSha256 = null,
  observedBytes = null,
  nodeCount = 0
}) {
  const blockers = Object.freeze([
    Object.freeze({
      scope,
      code,
      phase: null,
      count: 1
    })
  ]);
  return deepFreeze({
    schemaVersion: "1",
    decision: "blocked",
    historicalClosureEligible: false,
    fullStartupAdmission: false,
    fullAdmissionCode:
      "startup_quiescence_runtime_provenance_required",
    code,
    stateVersion: null,
    storageContract: null,
    revision: null,
    rawSha256,
    observedBytes,
    nodeCount,
    limits,
    counts: {
      operations: 0,
      relations: 0,
      currentRelations: 0,
      historicalOperations: 0,
      terminalProofs: 0,
      closedHistoricalOperations: 0,
      blockers: 1
    },
    blockers
  });
}

class BlockerSet {
  constructor() {
    this.entries = new Map();
  }

  add(category, scope, code, phase) {
    let byScope = this.entries.get(scope);
    if (!byScope) {
      byScope = new Map();
      this.entries.set(scope, byScope);
    }
    let byCode = byScope.get(code);
    if (!byCode) {
      byCode = new Map();
      byScope.set(code, byCode);
    }
    const existing = byCode.get(phase);
    if (existing) {
      existing.count += 1;
      if (CATEGORY_ORDER[category] < CATEGORY_ORDER[existing.category]) {
        existing.category = category;
      }
      return;
    }
    byCode.set(phase, {
      category,
      scope,
      code,
      phase,
      count: 1
    });
  }

  freeze() {
    const entries = [];
    for (const byScope of this.entries.values()) {
      for (const byCode of byScope.values()) {
        for (const entry of byCode.values()) {
          entries.push(entry);
        }
      }
    }
    entries.sort(compareBlockers);
    return Object.freeze(entries.map(entry => Object.freeze({
      scope: entry.scope,
      code: entry.code,
      phase: entry.phase,
      count: entry.count
    })));
  }

  primary() {
    const entries = [];
    for (const byScope of this.entries.values()) {
      for (const byCode of byScope.values()) {
        for (const entry of byCode.values()) {
          entries.push(entry);
        }
      }
    }
    entries.sort(compareBlockers);
    return entries[0] ?? null;
  }
}

function compareBlockers(left, right) {
  return (CATEGORY_ORDER[left.category] ?? 99)
    - (CATEGORY_ORDER[right.category] ?? 99)
    || (CODE_ORDER[left.code] ?? 99) - (CODE_ORDER[right.code] ?? 99)
    || phaseRank(left.phase) - phaseRank(right.phase)
    || left.scope.localeCompare(right.scope);
}

function phaseRank(phase) {
  return phase === null ? -1 : PHASE_ORDER[phase] ?? 99;
}

function uncertaintyCode(record, scope) {
  if (record.cleanupRequired
    || record.phase === "cleanup_required"
    || record.cleanupEvidence?.disposition === "unconfirmed") {
    return ERROR_CODES.cleanup;
  }
  return record.commitUncertain || record.phase === "commit_uncertain"
    ? scope === "current"
      ? ERROR_CODES.current
      : scope === "history"
        ? ERROR_CODES.history
        : ERROR_CODES.orphan
    : record.phase === "unknown"
      ? scope === "current"
        ? ERROR_CODES.current
        : scope === "history"
          ? ERROR_CODES.history
          : ERROR_CODES.orphan
      : ERROR_CODES.cleanup;
}

function isUncertainRecord(record) {
  return record.cleanupRequired === true
    || record.commitUncertain === true
    || record.phase === "cleanup_required"
    || record.phase === "commit_uncertain"
    || record.phase === "unknown"
    || record.cleanupEvidence?.disposition === "unconfirmed";
}

function buildTerminalProofs(operationEntries) {
  const proofs = new Map();
  for (const [operationId, operation] of operationEntries) {
    if (operation.phase !== "stopped"
      && !(operation.phase === "start_failed"
        && operation.cleanupEvidence?.disposition === "confirmedStopped")) {
      continue;
    }
    const key = operationKey(operation);
    if (!isCompleteOperationKey(key)) {
      continue;
    }
    addProof(proofs, key, operationId);
  }
  return proofs;
}

function addProof(proofs, key, operationId) {
  let byGeneration = proofs.get(key.relationId);
  if (!byGeneration) {
    byGeneration = new Map();
    proofs.set(key.relationId, byGeneration);
  }
  let byDigest = byGeneration.get(key.generation);
  if (!byDigest) {
    byDigest = new Map();
    byGeneration.set(key.generation, byDigest);
  }
  let operationIds = byDigest.get(key.handleDigest);
  if (!operationIds) {
    operationIds = new Set();
    byDigest.set(key.handleDigest, operationIds);
  }
  operationIds.add(operationId);
}

function countTerminalProofs(proofs) {
  let count = 0;
  for (const byGeneration of proofs.values()) {
    for (const byDigest of byGeneration.values()) {
      for (const operationIds of byDigest.values()) {
        count += operationIds.size;
      }
    }
  }
  return count;
}

function classifyOperationClosure(operationId, operation, proofs) {
  if (operation.phase === "stopped") {
    return isCompleteOperationKey(operationKey(operation))
      ? "closed"
      : "unresolved";
  }
  if (operation.phase === "start_failed"
    && ["confirmedStopped", "notInvoked"].includes(
      operation.cleanupEvidence?.disposition
    )) {
    return "closed";
  }
  if (operation.phase === "starting") {
    return "identity_missing";
  }
  if (operation.phase !== "running") {
    return "unresolved";
  }
  const key = operationKey(operation);
  if (!key.generation || !key.handleDigest) {
    return "unresolved";
  }
  const operationIds = proofs
    .get(key.relationId)
    ?.get(key.generation)
    ?.get(key.handleDigest);
  if (!operationIds) {
    return "unresolved";
  }
  for (const proofId of operationIds) {
    if (proofId !== operationId) {
      return "closed";
    }
  }
  return "unresolved";
}

function operationKey(operation) {
  return {
    relationId: operation.relationId,
    generation: operation.generation,
    handleDigest: operation.handleDigest
  };
}

function isCompleteOperationKey(key) {
  return typeof key.relationId === "string"
    && key.relationId.trim() !== ""
    && typeof key.generation === "string"
    && key.generation.trim() !== ""
    && isDigest(key.handleDigest);
}

function validateManagerState(state) {
  assertPlainObject(state);
  assertExactKeys(state, STATE_KEYS);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    schemaFail();
  }
  if (!isTimestamp(state.createdAt) || !isTimestamp(state.updatedAt)) {
    schemaFail();
  }
  assertPlainObject(state.operations);
  assertPlainObject(state.relations);
  if (state.kind !== STATE_KIND) {
    schemaFail();
  }
  if (state.version === 1) {
    if (state.storageContract !== V1_STORAGE_CONTRACT) {
      schemaFail();
    }
    validateV1State(state);
    validateCanonicalEmptyV1(state);
    return Object.freeze({ state, version: 1 });
  }
  if (state.version === 2) {
    if (state.storageContract !== V2_STORAGE_CONTRACT) {
      schemaFail();
    }
    validateV2State(state);
    if (Object.keys(state.operations).length === 0
      && Object.keys(state.relations).length === 0) {
      schemaFail();
    }
    return Object.freeze({ state, version: 2 });
  }
  schemaFail();
}

function validateCanonicalEmptyV1(state) {
  if (Object.keys(state.operations).length !== 0
    || Object.keys(state.relations).length !== 0) {
    return;
  }
  if (state.revision !== 0 || state.createdAt !== state.updatedAt) {
    schemaFail();
  }
}

function validateV1State(state) {
  for (const [operationId, operation] of Object.entries(state.operations)) {
    assertPlainObject(operation);
    assertExactKeys(operation, V1_OPERATION_KEYS);
    if (operation.operationId !== operationId
      || operation.action !== "disable"
      || !V1_PHASES.has(operation.phase)
      || !isTimestamp(operation.createdAt)
      || !isTimestamp(operation.updatedAt)
      || typeof operation.reason !== "string"
      || !isNullableString(operation.generation)
      || typeof operation.handleDigest !== "string") {
      schemaFail();
    }
    requireIdentity(operation.operationId);
    requireIdentity(operation.relationId);
    requireDigest(operation.requestDigest);
    assertV1OperationHandleState(operation);
  }

  for (const [relationId, relation] of Object.entries(state.relations)) {
    assertPlainObject(relation);
    assertExactKeys(relation, V1_RELATION_KEYS);
    if (relation.relationId !== relationId
      || relation.desired !== "disabled"
      || !V1_PHASES.has(relation.phase)
      || !isTimestamp(relation.updatedAt)
      || typeof relation.reason !== "string"
      || !isNullableString(relation.generation)
      || typeof relation.handleDigest !== "string") {
      schemaFail();
    }
    requireIdentity(relation.operationId);
    requireDigest(relation.identityDigest);
    requireDigest(relation.requestDigest);
    if (relation.handle !== null) {
      assertRuntimeHandle(relation.handle, relationId);
      if (relation.handle.generation !== relation.generation
        || digestValue(relation.handle) !== relation.handleDigest) {
        schemaFail();
      }
    } else if (relation.generation !== null || relation.handleDigest !== "") {
      schemaFail();
    }
    const operation = state.operations[relation.operationId];
    if (!operation
      || operation.relationId !== relationId
      || operation.requestDigest !== relation.requestDigest
      || operation.phase !== relation.phase
      || operation.reason !== relation.reason
      || operation.generation !== relation.generation
      || operation.handleDigest !== relation.handleDigest) {
      schemaFail();
    }
  }
}

function validateV2State(state) {
  for (const [operationId, operation] of Object.entries(state.operations)) {
    assertPlainObject(operation);
    assertExactKeys(operation, V2_OPERATION_KEYS);
    if (operation.operationId !== operationId
      || !["disable", "start"].includes(operation.action)
      || !V2_PHASES.has(operation.phase)
      || !isTimestamp(operation.createdAt)
      || !isTimestamp(operation.updatedAt)
      || typeof operation.reason !== "string"
      || !isNullableString(operation.generation)
      || (operation.handleDigest !== ""
        && !isDigest(operation.handleDigest))
      || typeof operation.cleanupRequired !== "boolean"
      || typeof operation.commitUncertain !== "boolean"
      || !["v1-migrated", "v2"].includes(operation.recordOrigin)) {
      schemaFail();
    }
    requireIdentity(operation.operationId);
    requireIdentity(operation.relationId);
    requireDigest(operation.requestDigest);
    if (operation.recordOrigin === "v2"
      && !isStoredReason(operation.reason)) {
      schemaFail();
    }
    assertCommonV2Fields(operation);
    assertPhaseSpecificV2Shape(operation);
    assertStartFailedOperationProof(operation);
  }

  for (const [relationId, relation] of Object.entries(state.relations)) {
    assertPlainObject(relation);
    assertExactKeys(relation, V2_RELATION_KEYS);
    if (relation.relationId !== relationId
      || !["disabled", "enabled", "unknown"].includes(relation.desired)
      || !V2_PHASES.has(relation.phase)
      || !isTimestamp(relation.updatedAt)
      || typeof relation.reason !== "string"
      || !isNullableString(relation.generation)
      || typeof relation.handleDigest !== "string"
      || typeof relation.cleanupRequired !== "boolean"
      || typeof relation.commitUncertain !== "boolean"
      || !["v1-migrated", "v2"].includes(relation.recordOrigin)) {
      schemaFail();
    }
    requireIdentity(relation.operationId);
    requireDigest(relation.identityDigest);
    requireDigest(relation.requestDigest);
    if (relation.recordOrigin === "v2"
      && !isStoredReason(relation.reason)) {
      schemaFail();
    }
    assertCommonV2Fields(relation);
    assertPhaseSpecificV2Shape(relation);
    if (relation.handle !== null) {
      assertRuntimeHandle(relation.handle, relationId);
      if (relation.handle.generation !== relation.generation
        || digestValue(relation.handle) !== relation.handleDigest) {
        schemaFail();
      }
    } else if (relation.handleDigest !== "") {
      schemaFail();
    }
    if (["prepared", "running"].includes(relation.phase)
      && (relation.handle === null || relation.handleDigest === "")) {
      schemaFail();
    }
    if (relation.phase === "starting"
      && (relation.handle !== null || relation.handleDigest !== "")) {
      schemaFail();
    }
    if (["pending", "starting"].includes(relation.phase)
      && relation.handle !== null) {
      schemaFail();
    }
    if (["stopping", "stopped"].includes(relation.phase)
      && relation.handle === null) {
      schemaFail();
    }
    if (relation.phase === "running"
      && relation.runningEvidenceDigest === null) {
      schemaFail();
    }
    if (["pending", "stopping", "stopped", "starting", "prepared"].includes(
      relation.phase
    ) && relation.runningEvidenceDigest !== null) {
      schemaFail();
    }
    if (relation.phase === "start_failed"
      && relation.runningEvidenceDigest !== null
      && relation.cleanupEvidence?.disposition !== "confirmedStopped") {
      schemaFail();
    }
    if (relation.runtimeIdentity !== null
      && (relation.handle === null
        || relation.runtimeIdentity.tokenSha256
          !== digestText(relation.handle.token))) {
      schemaFail();
    }
    const cleanupIdentity = relation.cleanupEvidence?.exactHandleIdentity;
    if (cleanupIdentity
      && (relation.handle === null
        || cleanupIdentity.relationId !== relation.relationId
        || cleanupIdentity.generation !== relation.handle.generation
        || cleanupIdentity.handleDigest !== digestValue(relation.handle))) {
      schemaFail();
    }
    const operation = state.operations[relation.operationId];
    if (!operation
      || operation.relationId !== relationId
      || !v2RecordsShareCommonState(operation, relation)) {
      schemaFail();
    }
  }
}

function assertStartFailedOperationProof(operation) {
  if (operation.phase === "stopped"
    && (typeof operation.generation !== "string"
      || operation.generation.trim() === ""
      || !isDigest(operation.handleDigest))) {
    schemaFail();
  }
  if (operation.phase !== "start_failed") {
    return;
  }
  const disposition = operation.cleanupEvidence?.disposition;
  if (disposition === "confirmedStopped") {
    const identity = operation.cleanupEvidence.exactHandleIdentity;
    if (!identity
      || identity.relationId !== operation.relationId
      || identity.generation !== operation.generation
      || identity.handleDigest !== operation.handleDigest
      || !isDigest(operation.handleDigest)) {
      schemaFail();
    }
  }
  if (disposition === "notInvoked"
    && (operation.handleDigest !== ""
      || operation.runtimeIdentity !== null
      || operation.provisionalEvidence !== null)) {
    schemaFail();
  }
}

function assertCommonV2Fields(record) {
  assertNullableDigestOrEmpty(record.expectedHandleDigest);
  assertNullableDigest(record.protectionDigest);
  assertNullableDigest(record.runningEvidenceDigest);
  if (record.generation === null && record.handleDigest !== "") {
    schemaFail();
  }
  if (record.runtimeIdentity !== null) {
    assertRuntimeIdentityShape(record.runtimeIdentity);
  }
  if (record.provisionalEvidence !== null) {
    assertProvisionalEvidence(record.provisionalEvidence);
  }
  if ((record.runtimeIdentity === null)
    !== (record.provisionalEvidence === null)) {
    schemaFail();
  }
  if (record.cleanupEvidence !== null
    && !validateCleanupEvidence(record.cleanupEvidence)) {
    schemaFail();
  }
  if (record.cleanupRequired
    && (!record.cleanupEvidence
      || record.cleanupEvidence.disposition !== "unconfirmed")) {
    schemaFail();
  }
  if (record.phase === "cleanup_required" && !record.cleanupRequired) {
    schemaFail();
  }
  if (record.phase === "commit_uncertain" && !record.commitUncertain) {
    schemaFail();
  }
  if (record.phase === "start_failed"
    && (record.commitUncertain
      || record.cleanupRequired
      || !record.cleanupEvidence
      || !["confirmedStopped", "notInvoked"].includes(
        record.cleanupEvidence.disposition
      ))) {
    schemaFail();
  }
  if (record.phase === "stopped"
    && (record.generation === null || record.handleDigest === "")) {
    schemaFail();
  }
}

function assertPhaseSpecificV2Shape(record) {
  if (["pending", "stopping", "stopped"].includes(record.phase)) {
    if (record.expectedHandleDigest !== null
      || record.protectionDigest !== null
      || record.runtimeIdentity !== null
      || record.cleanupEvidence !== null
      || record.commitUncertain
      || record.cleanupRequired) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "starting") {
    if (typeof record.expectedHandleDigest !== "string"
      || record.protectionDigest !== null
      || record.runtimeIdentity !== null
      || record.cleanupEvidence !== null
      || record.commitUncertain
      || record.cleanupRequired) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "prepared") {
    if (typeof record.expectedHandleDigest !== "string"
      || record.protectionDigest === null
      || record.runtimeIdentity === null
      || record.cleanupEvidence !== null
      || record.commitUncertain
      || record.cleanupRequired) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "running") {
    if (typeof record.expectedHandleDigest !== "string"
      || record.protectionDigest === null
      || record.runtimeIdentity === null
      || record.cleanupEvidence !== null
      || record.cleanupRequired) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "start_failed") {
    if (typeof record.expectedHandleDigest !== "string"
      || (record.runtimeIdentity !== null
        && record.protectionDigest === null)) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "cleanup_required") {
    if ((record.runtimeIdentity !== null
      && record.protectionDigest === null)
      || (record.cleanupEvidence !== null
        && record.cleanupEvidence.disposition !== "unconfirmed")) {
      schemaFail();
    }
    return;
  }
  if (record.phase === "commit_uncertain"
    && ((record.runtimeIdentity !== null
      && record.protectionDigest === null)
      || (record.cleanupEvidence !== null
        && record.cleanupEvidence.disposition !== "unconfirmed"))) {
    schemaFail();
  }
}

function v2RecordsShareCommonState(operation, relation) {
  const common = [
    "phase",
    "reason",
    "generation",
    "handleDigest",
    "requestDigest",
    "expectedHandleDigest",
    "protectionDigest",
    "runtimeIdentity",
    "provisionalEvidence",
    "runningEvidenceDigest",
    "cleanupEvidence",
    "commitUncertain",
    "cleanupRequired",
    "recordOrigin"
  ];
  for (const key of common) {
    if (stableSerialize(operation[key]) !== stableSerialize(relation[key])) {
      return false;
    }
  }
  const derived = derivedActionDesired(operation.phase, operation.action);
  return derived.action === operation.action
    && (derived.desired === relation.desired
      || (operation.phase === "unknown"
        && relation.desired === "unknown"));
}

function derivedActionDesired(phase, operationAction) {
  if (["pending", "stopping", "stopped"].includes(phase)) {
    return { action: "disable", desired: "disabled" };
  }
  if (["starting", "prepared", "running", "start_failed"].includes(phase)) {
    return { action: "start", desired: "enabled" };
  }
  return {
    action: operationAction,
    desired: operationAction === "disable" ? "disabled" : "enabled"
  };
}

function assertV1OperationHandleState(operation) {
  if (operation.generation !== null) {
    if (!operation.generation
      || operation.generation.trim() !== operation.generation) {
      schemaFail();
    }
    requireDigest(operation.handleDigest);
  } else if (operation.handleDigest !== "") {
    schemaFail();
  }
  if (operation.phase === "stopped" && operation.generation === null) {
    schemaFail();
  }
}

function assertRuntimeHandle(handle, relationId) {
  assertPlainObject(handle);
  assertExactKeys(handle, HANDLE_KEYS);
  if (handle.relationId !== relationId
    || typeof handle.generation !== "string"
    || handle.generation.trim() === ""
    || typeof handle.token !== "string"
    || handle.token.trim() === "") {
    schemaFail();
  }
}

function assertRuntimeIdentityShape(value) {
  assertPlainObject(value);
  assertExactKeys(value, RUNTIME_IDENTITY_KEYS);
  assertPlainObject(value.namespace);
  assertExactKeys(value.namespace, RUNTIME_NAMESPACE_KEYS);
  assertPlainObject(value.manager);
  assertExactKeys(value.manager, RUNTIME_MANAGER_KEYS);
  assertPlainObject(value.process);
  assertExactKeys(value.process, RUNTIME_PROCESS_KEYS);
  assertPlainObject(value.executable);
  assertExactKeys(value.executable, RUNTIME_EXECUTABLE_KEYS);
  assertExecutableIdentity(value.executable.launcher);
  assertExecutableIdentity(value.executable.target);
  assertPlainObject(value.listener);
  assertExactKeys(value.listener, EXPECTED_LISTENER_KEYS);
  if (value.schemaVersion !== "1"
    || !isLowerUuid(value.namespace.bootId)
    || !/^pid:\[[0-9]+\]$/.test(value.namespace.pidNamespaceId)
    || !isCanonicalDecimal(value.manager.pid)
    || !isCanonicalDecimal(value.manager.starttime)
    || !isCanonicalDecimal(value.process.pid)
    || !isCanonicalDecimal(value.process.starttime)
    || !isCanonicalDecimal(value.process.parentPid)
    || !isCanonicalDecimal(value.process.parentStarttime)
    || value.process.pid === value.manager.pid
    || value.process.parentPid !== value.manager.pid
    || value.process.parentStarttime !== value.manager.starttime
    || !isDigest(value.tokenSha256)
    || value.listener.role !== "expected"
    || value.listener.host !== "127.0.0.1"
    || !Number.isInteger(value.listener.port)
    || value.listener.port < 1
    || value.listener.port > 65535) {
    schemaFail();
  }
}

function assertExecutableIdentity(value) {
  assertPlainObject(value);
  assertExactKeys(value, EXECUTABLE_IDENTITY_KEYS);
  if (!isCanonicalDecimal(value.dev)
    || !isCanonicalDecimal(value.ino)
    || !isCanonicalDecimal(value.size)
    || !isDigest(value.sha256)) {
    schemaFail();
  }
}

function assertProvisionalEvidence(value) {
  assertPlainObject(value);
  assertExactKeys(value, PROVISIONAL_EVIDENCE_KEYS);
  const expected = {
    schemaVersion: "1",
    launcherReady: true,
    processRunning: true,
    preExecLauncherExeMatches: true,
    preExecTokenMatches: true,
    preparedTargetMatchesFd3: true,
    capabilitiesCleared: true,
    noNewPrivs: true,
    parentDeathSignal: "SIGKILL",
    parentMatches: true,
    executableMatches: true,
    tokenMatches: true,
    listenerOpen: false
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      schemaFail();
    }
  }
  if (!isTimestamp(value.observedAt)) {
    schemaFail();
  }
}

function validateCleanupEvidence(value) {
  try {
    assertPlainObject(value);
    assertExactKeys(value, CLEANUP_EVIDENCE_KEYS);
    if (value.schemaVersion !== "1"
      || !["confirmedStopped", "notInvoked", "unconfirmed"].includes(
        value.disposition
      )
      || !CHECKPOINTS.has(value.lastRuntimeCheckpoint)
      || typeof value.runtimeInvoked !== "boolean"
      || typeof value.leaseReturned !== "boolean"
      || typeof value.continuationRegistered !== "boolean"
      || !LATE_PREPARE.has(value.latePrepare)
      || !LATE_GO.has(value.lateGo)
      || typeof value.abortRequested !== "boolean"
      || typeof value.abortCompleted !== "boolean"
      || typeof value.containmentConfirmed !== "boolean"
      || !isNullableBoolean(value.processExited)
      || !isNullableBoolean(value.listenerClosed)
      || !isNullableBoolean(value.sessionsClosed)
      || !isNullableBoolean(value.childrenExited)
      || !isStableReason(value.reasonCode)) {
      return false;
    }
    if (value.exactHandleIdentity !== null) {
      assertPlainObject(value.exactHandleIdentity);
      assertExactKeys(value.exactHandleIdentity, CLEANUP_IDENTITY_KEYS);
      if (typeof value.exactHandleIdentity.relationId !== "string"
        || value.exactHandleIdentity.relationId.trim() === ""
        || !isCanonicalDecimal(value.exactHandleIdentity.generation)
        || !isDigest(value.exactHandleIdentity.handleDigest)) {
        return false;
      }
    }
    if (value.disposition === "confirmedStopped") {
      return value.runtimeInvoked === true
        && value.leaseReturned === true
        && value.abortRequested === true
        && value.abortCompleted === true
        && value.containmentConfirmed === true
        && value.exactHandleIdentity !== null
        && value.processExited === true
        && value.listenerClosed === true
        && value.sessionsClosed === true
        && value.childrenExited === true
        && value.reasonCode === "cleanup_confirmed_stopped";
    }
    if (value.disposition === "notInvoked") {
      return value.runtimeInvoked === false
        && value.leaseReturned === false
        && value.continuationRegistered === false
        && value.abortRequested === false
        && value.abortCompleted === false
        && value.containmentConfirmed === false
        && value.exactHandleIdentity === null
        && value.processExited === null
        && value.listenerClosed === null
        && value.sessionsClosed === null
        && value.childrenExited === null
        && value.reasonCode === "runtime_not_invoked";
    }
    return value.disposition === "unconfirmed";
  } catch {
    return false;
  }
}

function stableSerialize(value) {
  if (value === null
    || typeof value === "boolean"
    || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError("unambiguous JSON number required");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  assertPlainObject(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) {
    throw new TypeError("string keys required");
  }
  keys.sort();
  return `{${keys.map(key => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(",")}}`;
}

function digestValue(value) {
  return digestText(stableSerialize(value));
}

function digestProjectionValue(value) {
  return digestText(serializeProjectionValue(value));
}

function serializeProjectionValue(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeProjectionValue).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${serializeProjectionValue(value[key])}`
  )).join(",")}}`;
}

function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertPlainObject(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== null) {
    schemaFail();
  }
}

function assertExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some(key => typeof key !== "string")
    || expected.some(key => !Object.hasOwn(value, key))) {
    schemaFail();
  }
}

function requireIdentity(value) {
  if (typeof value !== "string"
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    schemaFail();
  }
}

function requireDigest(value) {
  if (!isDigest(value)) {
    schemaFail();
  }
}

function assertNullableDigest(value) {
  if (value !== null && !isDigest(value)) {
    schemaFail();
  }
}

function assertNullableDigestOrEmpty(value) {
  if (value !== null && value !== "" && !isDigest(value)) {
    schemaFail();
  }
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isStableReason(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value);
}

function isStoredReason(value) {
  return value === "" || isStableReason(value);
}

function isCanonicalDecimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isLowerUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value
    );
}

function isNullableBoolean(value) {
  return value === null || typeof value === "boolean";
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function freezeKeys(keys) {
  return Object.freeze(keys);
}

function schemaFail() {
  throw new SchemaFailure();
}

class SchemaFailure extends Error {
  constructor() {
    super("state schema invalid");
    this.name = "SchemaFailure";
  }
}
