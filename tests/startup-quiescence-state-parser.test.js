import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  evaluateManagerHistoryClosure,
  projectStartupRecoveryScope
} from "../src/service/startupQuiescenceStateParser.js";

const NOW = "2026-10-23T00:00:00.000Z";
const LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200000
});
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

test("canonical empty V1 is historically eligible but never fully admitted", () => {
  const result = evaluate(v1EmptyState());
  assert.equal(result.decision, "historical_closed");
  assert.equal(result.historicalClosureEligible, true);
  assert.equal(result.fullStartupAdmission, false);
  assert.equal(
    result.fullAdmissionCode,
    "startup_quiescence_runtime_provenance_required"
  );
  assert.equal(result.stateVersion, 1);
});

test("scope projection structurally binds complete V2 descriptor content", () => {
  const first = v2PendingCurrent({
    relationId: "rel-scope-content",
    operationId: "op-scope-content"
  });
  const second = v2PendingCurrent({
    relationId: "rel-scope-content",
    operationId: "op-scope-content"
  });
  second.operation.updatedAt = "2026-10-23T00:00:01.000Z";
  second.relation.updatedAt = "2026-10-23T00:00:02.000Z";

  const firstScope = projectScope(v2State(
    { [first.operation.operationId]: first.operation },
    { [first.relation.relationId]: first.relation }
  ));
  const secondScope = projectScope(v2State(
    { [second.operation.operationId]: second.operation },
    { [second.relation.relationId]: second.relation }
  ));

  assert.equal(firstScope.eligible, true);
  assert.equal(secondScope.eligible, true);
  assert.equal(firstScope.descriptors.length, secondScope.descriptors.length);
  assert.notEqual(
    firstScope.descriptors[0].operationRecordSha256,
    secondScope.descriptors[0].operationRecordSha256
  );
  assert.notEqual(
    firstScope.descriptors[0].relationRecordSha256,
    secondScope.descriptors[0].relationRecordSha256
  );
  assert.notEqual(
    firstScope.scopeProjectionSha256,
    secondScope.scopeProjectionSha256
  );
});

test("scope projection ignores JSON object key insertion order", () => {
  const pair = v2PendingCurrent({
    relationId: "rel-scope-order",
    operationId: "op-scope-order"
  });
  const canonical = v2State(
    { [pair.operation.operationId]: pair.operation },
    { [pair.relation.relationId]: pair.relation }
  );
  const reordered = reverseJsonObjectKeys(canonical);
  const canonicalScope = projectScope(canonical);
  const reorderedScope = projectScope(reordered);

  assert.equal(canonicalScope.eligible, true);
  assert.equal(reorderedScope.eligible, true);
  assert.notEqual(canonicalScope.rawSha256, reorderedScope.rawSha256);
  assert.deepEqual(canonicalScope.descriptors, reorderedScope.descriptors);
  assert.equal(
    canonicalScope.scopeProjectionSha256,
    reorderedScope.scopeProjectionSha256
  );
});

test("empty V1 scope uses the normalized structural digest", () => {
  const result = projectScope(v1EmptyState());
  assert.equal(result.eligible, true);
  assert.equal(result.descriptors.length, 0);
  assert.equal(result.scopeProjectionSha256, digestText("[]"));
});

test("V1 stopped accepts a noncanonical trim-stable generation", () => {
  const result = evaluate(v1StoppedState("01"));
  assert.equal(result.historicalClosureEligible, true);
  assert.equal(result.code, null);
  assert.equal(result.counts.currentRelations, 1);
});

test("V2 stopped is eligible and safe output omits handle token", () => {
  const pair = v2StoppedPair({
    relationId: "rel-stopped",
    operationId: "op-stopped",
    generation: "1",
    token: "secret-handle-token"
  });
  const result = evaluate(v2State(
    { [pair.operation.operationId]: pair.operation },
    { [pair.relation.relationId]: pair.relation }
  ));
  assert.equal(result.historicalClosureEligible, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-handle-token/);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.limits), true);
  assert.equal(Object.isFrozen(result.counts), true);
  assert.equal(Object.isFrozen(result.blockers), true);
});

test("current start_failed confirmedStopped and notInvoked are eligible", () => {
  const confirmed = v2StartFailedCurrent({
    relationId: "rel-confirmed",
    operationId: "op-confirmed",
    generation: "2",
    token: "confirmed-token",
    disposition: "confirmedStopped"
  });
  const confirmedResult = evaluate(v2State(
    { [confirmed.operation.operationId]: confirmed.operation },
    { [confirmed.relation.relationId]: confirmed.relation }
  ));
  assert.equal(confirmedResult.historicalClosureEligible, true);

  const notInvoked = v2StartFailedCurrent({
    relationId: "rel-not-invoked",
    operationId: "op-not-invoked",
    generation: "3",
    token: "",
    disposition: "notInvoked"
  });
  const notInvokedResult = evaluate(v2State(
    { [notInvoked.operation.operationId]: notInvoked.operation },
    { [notInvoked.relation.relationId]: notInvoked.relation }
  ));
  assert.equal(notInvokedResult.historicalClosureEligible, true);
});

test("start_failed confirmedStopped binds every cleanup identity tuple field", () => {
  const mismatches = [
    ["relationId", "rel-cleanup-other"],
    ["generation", "999"],
    ["handleDigest", DIGEST_E]
  ];
  for (const [key, value] of mismatches) {
    const pair = v2StartFailedCurrent({
      relationId: "rel-cleanup-binding",
      operationId: "op-cleanup-binding",
      generation: "6",
      token: "cleanup-binding-token",
      disposition: "confirmedStopped"
    });
    const state = cloneJson(v2State(
      { [pair.operation.operationId]: pair.operation },
      { [pair.relation.relationId]: pair.relation }
    ));
    state.operations[pair.operation.operationId]
      .cleanupEvidence.exactHandleIdentity[key] = value;
    const result = evaluate(state);
    assert.equal(
      result.code,
      "startup_quiescence_schema_invalid",
      key
    );
  }
});

test("historical and orphan confirmedStopped proofs do not require a relation", () => {
  const operation = v2StartFailedOrphan({
    relationId: "rel-proof-only",
    operationId: "op-proof-only",
    generation: "4",
    token: "proof-token",
    disposition: "confirmedStopped"
  });
  const result = evaluate(v2State({ [operation.operationId]: operation }, {}));
  assert.equal(result.historicalClosureEligible, true);
  assert.equal(result.counts.operations, 1);
  assert.equal(result.counts.currentRelations, 0);
});

test("historical and orphan notInvoked generation may be non-null", () => {
  const operation = v2StartFailedOrphan({
    relationId: "rel-not-invoked-orphan",
    operationId: "op-not-invoked-orphan",
    generation: "5",
    token: "",
    disposition: "notInvoked"
  });
  const result = evaluate(v2State({ [operation.operationId]: operation }, {}));
  assert.equal(result.historicalClosureEligible, true);
});

test("old running history closes by a distinct same-tuple terminal operation", () => {
  const pair = v2StoppedPair({
    relationId: "rel-history",
    operationId: "op-current",
    generation: "7",
    token: "history-token"
  });
  const runningFive = v2RunningOperation({
    relationId: pair.relation.relationId,
    operationId: "op-old-running-five",
    generation: "5",
    token: pair.relation.handle.token
  });
  const proofFive = v2StoppedProof({
    relationId: pair.relation.relationId,
    operationId: "op-old-proof-five",
    generation: "5",
    token: pair.relation.handle.token
  });
  const runningSix = v2RunningOperation({
    relationId: pair.relation.relationId,
    operationId: "op-old-running-six",
    generation: "6",
    token: pair.relation.handle.token
  });
  const proofSix = v2StoppedProof({
    relationId: pair.relation.relationId,
    operationId: "op-old-proof-six",
    generation: "6",
    token: pair.relation.handle.token
  });
  const result = evaluate(v2State(
    {
      [runningFive.operationId]: runningFive,
      [proofFive.operationId]: proofFive,
      [runningSix.operationId]: runningSix,
      [proofSix.operationId]: proofSix,
      [pair.operation.operationId]: pair.operation
    },
    { [pair.relation.relationId]: pair.relation }
  ));
  assert.equal(result.historicalClosureEligible, true);
  assert.equal(result.counts.historicalOperations, 4);
  assert.equal(result.counts.closedHistoricalOperations, 4);
  assert.equal(result.counts.terminalProofs, 3);
});

test("historical pending, stopping, and prepared phases remain unresolved", () => {
  const current = v2StoppedPair({
    relationId: "rel-history-phases",
    operationId: "op-history-current",
    generation: "30",
    token: "history-phases-token"
  });
  const pending = v2TransientPair("pending", {
    relationId: current.relation.relationId,
    operationId: "op-history-pending",
    generation: "27"
  }).operation;
  const stopping = v2TransientPair("stopping", {
    relationId: current.relation.relationId,
    operationId: "op-history-stopping",
    generation: "28"
  }).operation;
  const prepared = v2TransientPair("prepared", {
    relationId: current.relation.relationId,
    operationId: "op-history-prepared",
    generation: "29"
  }).operation;
  const result = evaluate(v2State(
    {
      [pending.operationId]: pending,
      [stopping.operationId]: stopping,
      [prepared.operationId]: prepared,
      [current.operation.operationId]: current.operation
    },
    { [current.relation.relationId]: current.relation }
  ));
  assert.equal(result.code, "startup_quiescence_history_unresolved");
  assert.equal(result.counts.historicalOperations, 3);
  assert.deepEqual(
    result.blockers.map(blocker => [blocker.code, blocker.phase]),
    [
      ["startup_quiescence_history_unresolved", "pending"],
      ["startup_quiescence_history_unresolved", "stopping"],
      ["startup_quiescence_history_unresolved", "prepared"]
    ]
  );
});

test("notInvoked never closes an old running handle", () => {
  const running = v2RunningOperation({
    relationId: "rel-unclosed",
    operationId: "op-running",
    generation: "7",
    token: "unclosed-token"
  });
  const notInvoked = v2StartFailedOrphan({
    relationId: "rel-unclosed",
    operationId: "op-not-invoked",
    generation: "7",
    token: "",
    disposition: "notInvoked"
  });
  const result = evaluate(v2State(
    {
      [running.operationId]: running,
      [notInvoked.operationId]: notInvoked
    },
    {}
  ));
  assert.equal(result.historicalClosureEligible, false);
  assert.equal(result.code, "startup_quiescence_orphan_unresolved");
  assert.equal(result.blockers[0].scope, "orphan");
});

test("unresolved orphan running operation is reported as orphan", () => {
  const running = v2RunningOperation({
    relationId: "rel-orphan-running",
    operationId: "op-orphan-running",
    generation: "8",
    token: "orphan-token"
  });
  const result = evaluate(v2State({ [running.operationId]: running }, {}));
  assert.equal(result.code, "startup_quiescence_orphan_unresolved");
  assert.equal(result.blockers[0].phase, "running");
});

test("current unresolved and starting blockers use fixed phase/code priority", () => {
  const pending = v2PendingCurrent({
    relationId: "rel-pending",
    operationId: "op-pending"
  });
  const starting = v2StartingCurrent({
    relationId: "rel-starting",
    operationId: "op-starting"
  });
  const result = evaluate(v2State(
    {
      [pending.operation.operationId]: pending.operation,
      [starting.operation.operationId]: starting.operation
    },
    {
      [pending.relation.relationId]: pending.relation,
      [starting.relation.relationId]: starting.relation
    }
  ));
  assert.equal(result.code, "startup_quiescence_identity_missing");
  assert.deepEqual(
    result.blockers.map(blocker => [blocker.code, blocker.phase]),
    [
      ["startup_quiescence_identity_missing", "starting"],
      ["startup_quiescence_current_unresolved", "pending"]
    ]
  );
});

test("every remaining current phase blocks with the fixed code", () => {
  for (const phase of [
    "stopping",
    "prepared",
    "running",
    "commit_uncertain",
    "unknown"
  ]) {
    const pair = v2TransientPair(phase, {
      relationId: `rel-current-${phase}`,
      operationId: `op-current-${phase}`,
      generation: "21"
    });
    const result = evaluate(v2State(
      { [pair.operation.operationId]: pair.operation },
      { [pair.relation.relationId]: pair.relation }
    ));
    assert.equal(
      result.code,
      "startup_quiescence_current_unresolved",
      phase
    );
    assert.deepEqual(
      result.blockers.map(blocker => [
        blocker.scope,
        blocker.code,
        blocker.phase
      ]),
      [["current", "startup_quiescence_current_unresolved", phase]],
      phase
    );
  }
});

test("global cleanup uncertainty takes precedence over current blockers", () => {
  const cleanup = v2CleanupRequiredCurrent({
    relationId: "rel-cleanup",
    operationId: "op-cleanup"
  });
  const pending = v2PendingCurrent({
    relationId: "rel-pending-2",
    operationId: "op-pending-2"
  });
  const result = evaluate(v2State(
    {
      [cleanup.operation.operationId]: cleanup.operation,
      [pending.operation.operationId]: pending.operation
    },
    {
      [cleanup.relation.relationId]: cleanup.relation,
      [pending.relation.relationId]: pending.relation
    }
  ));
  assert.equal(result.code, "startup_quiescence_cleanup_unconfirmed");
  assert.equal(result.blockers[0].scope, "current");
});

test("invalid options return blocked with null limits and no option echo", () => {
  const secret = "unsafe-option-secret";
  const result = evaluateManagerHistoryClosure(
    Buffer.from("{}", "utf8"),
    {
      ...LIMITS,
      extra: secret
    }
  );
  assert.equal(result.decision, "blocked");
  assert.equal(result.code, "startup_quiescence_input_invalid");
  assert.equal(result.limits, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.equal(result.stateVersion, null);
  assert.equal(result.storageContract, null);
  assert.equal(result.revision, null);
});

test("throwing option proxy returns blocked without raw exception text", () => {
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("proxy-error-secret");
    }
  });
  const result = evaluateManagerHistoryClosure(
    Buffer.from("{}", "utf8"),
    proxy
  );
  assert.equal(result.code, "startup_quiescence_input_invalid");
  assert.equal(result.limits, null);
  assert.doesNotMatch(JSON.stringify(result), /proxy-error-secret/);
});

test("schema and binding failures suppress untrusted metadata", () => {
  const state = v1StoppedState("9");
  state.extra = "untrusted";
  state.revision = "999";
  const result = evaluate(state);
  assert.equal(result.code, "startup_quiescence_schema_invalid");
  assert.equal(result.stateVersion, null);
  assert.equal(result.storageContract, null);
  assert.equal(result.revision, null);
  assert.equal(result.rawSha256.length, 64);
});

test("unknown and missing keys fail closed at state and record levels", () => {
  const pair = v2StoppedPair({
    relationId: "rel-key-matrix",
    operationId: "op-key-matrix",
    generation: "22",
    token: "key-matrix-token"
  });
  const base = v2State(
    { [pair.operation.operationId]: pair.operation },
    { [pair.relation.relationId]: pair.relation }
  );
  const cases = [
    ["state unknown key", state => {
      state.extra = true;
    }],
    ["state missing key", state => {
      delete state.kind;
    }],
    ["operation unknown key", state => {
      state.operations[pair.operation.operationId].extra = true;
    }],
    ["operation missing key", state => {
      delete state.operations[pair.operation.operationId].handleDigest;
    }],
    ["relation unknown key", state => {
      state.relations[pair.relation.relationId].extra = true;
    }],
    ["relation missing key", state => {
      delete state.relations[pair.relation.relationId].updatedAt;
    }]
  ];
  for (const [name, mutate] of cases) {
    const state = cloneJson(base);
    mutate(state);
    const result = evaluate(state);
    assert.equal(
      result.code,
      "startup_quiescence_schema_invalid",
      name
    );
  }
});

test("nested runtime, provisional, and current bindings fail closed", () => {
  const pair = v2TransientPair("running", {
    relationId: "rel-nested-shape",
    operationId: "op-nested-shape",
    generation: "23",
    token: "nested-shape-token"
  });
  const base = v2State(
    { [pair.operation.operationId]: pair.operation },
    { [pair.relation.relationId]: pair.relation }
  );
  const cases = [
    ["runtime nested missing key", state => {
      delete state.operations[pair.operation.operationId]
        .runtimeIdentity.listener.host;
    }],
    ["runtime nested unknown key", state => {
      state.operations[pair.operation.operationId]
        .runtimeIdentity.namespace.extra = true;
    }],
    ["provisional fixed value", state => {
      state.operations[pair.operation.operationId]
        .provisionalEvidence.parentDeathSignal = "SIGTERM";
    }],
    ["runtime provisional pairing", state => {
      state.operations[pair.operation.operationId].provisionalEvidence = null;
    }],
    ["runtime current binding", state => {
      state.relations[pair.relation.relationId]
        .runtimeIdentity.listener.port = 1081;
    }],
    ["provisional current binding", state => {
      state.relations[pair.relation.relationId]
        .provisionalEvidence.observedAt = "2026-10-23T00:00:01.000Z";
    }]
  ];
  for (const [name, mutate] of cases) {
    const state = cloneJson(base);
    mutate(state);
    const result = evaluate(state);
    assert.equal(
      result.code,
      "startup_quiescence_schema_invalid",
      name
    );
  }
});

test("empty V2 and non-string handle tokens fail closed", () => {
  const emptyV2 = evaluate(v2State({}, {}));
  assert.equal(emptyV2.code, "startup_quiescence_schema_invalid");

  const v1 = v1StoppedState("10");
  v1.relations["rel-1"].handle.token = 123;
  const nonStringToken = evaluate(v1);
  assert.equal(nonStringToken.code, "startup_quiescence_schema_invalid");
});

test("orphan stopped operations require a complete trim-stable K", () => {
  for (const generation of ["", "   "]) {
    const proof = v2StoppedProof({
      relationId: "rel-incomplete-k",
      operationId: "op-incomplete-k",
      generation,
      token: "incomplete-k-token"
    });
    const result = evaluate(v2State({ [proof.operationId]: proof }, {}));
    assert.equal(result.code, "startup_quiescence_schema_invalid");
    assert.equal(result.stateVersion, null);
  }
});

test("running requires a distinct matching terminal proof", () => {
  const current = v2StoppedPair({
    relationId: "rel-no-proof",
    operationId: "op-current-no-proof",
    generation: "12",
    token: "no-proof-token"
  });
  const running = v2RunningOperation({
    relationId: current.relation.relationId,
    operationId: "op-running-no-proof",
    generation: "11",
    token: current.relation.handle.token
  });
  const result = evaluate(v2State(
    {
      [running.operationId]: running,
      [current.operation.operationId]: current.operation
    },
    { [current.relation.relationId]: current.relation }
  ));
  assert.equal(result.historicalClosureEligible, false);
  assert.equal(result.code, "startup_quiescence_history_unresolved");
  assert.equal(result.counts.historicalOperations, 1);
  assert.equal(result.counts.closedHistoricalOperations, 0);
  assert.equal(result.blockers[0].phase, "running");
});

test("synthetic large input can use tightened byte and node limits", () => {
  const state = v1StoppedState("12");
  const result = evaluateManagerHistoryClosure(
    Buffer.from(JSON.stringify(state), "utf8"),
    {
      maxBytes: 32,
      maxDepth: 64,
      maxNodes: 200000
    }
  );
  assert.equal(result.code, "startup_quiescence_state_too_large");
  assert.deepEqual(result.limits, {
    maxBytes: 32,
    maxDepth: 64,
    maxNodes: 200000
  });
});

function evaluate(state) {
  return evaluateManagerHistoryClosure(
    Buffer.from(JSON.stringify(state), "utf8"),
    LIMITS
  );
}

function projectScope(state) {
  return projectStartupRecoveryScope(
    Buffer.from(JSON.stringify(state), "utf8"),
    LIMITS
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseJsonObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(reverseJsonObjectKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseJsonObjectKeys(entry)])
  );
}

function v1EmptyState() {
  return {
    version: 1,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1",
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    operations: {},
    relations: {}
  };
}

function v1StoppedState(generation) {
  const relationId = "rel-1";
  const operationId = "op-1";
  const handle = {
    generation,
    relationId,
    token: "v1-token"
  };
  return {
    version: 1,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    operations: {
      [operationId]: {
        action: "disable",
        createdAt: NOW,
        generation,
        handleDigest: digestValue(handle),
        operationId,
        phase: "stopped",
        reason: "",
        relationId,
        requestDigest: DIGEST_A,
        updatedAt: NOW
      }
    },
    relations: {
      [relationId]: {
        desired: "disabled",
        generation,
        handle,
        handleDigest: digestValue(handle),
        identityDigest: DIGEST_B,
        operationId,
        phase: "stopped",
        reason: "",
        relationId,
        requestDigest: DIGEST_A,
        updatedAt: NOW
      }
    }
  };
}

function v2State(operations, relations) {
  return {
    version: 2,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    operations,
    relations
  };
}

function v2StoppedPair({
  relationId,
  operationId,
  generation,
  token
}) {
  const handle = { generation, relationId, token };
  const handleDigest = digestValue(handle);
  const operation = {
    action: "disable",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: NOW,
    expectedHandleDigest: null,
    generation,
    handleDigest,
    operationId,
    phase: "stopped",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: NOW
  };
  const relation = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    desired: "disabled",
    expectedHandleDigest: null,
    generation,
    handle,
    handleDigest,
    identityDigest: DIGEST_B,
    operationId,
    phase: "stopped",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: NOW
  };
  return { operation, relation };
}

function v2StoppedProof({
  relationId,
  operationId,
  generation,
  token
}) {
  const handle = { generation, relationId, token };
  return {
    action: "disable",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: NOW,
    expectedHandleDigest: null,
    generation,
    handleDigest: digestValue(handle),
    operationId,
    phase: "stopped",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: NOW
  };
}

function v2RunningOperation({
  relationId,
  operationId,
  generation,
  token
}) {
  const handle = { generation, relationId, token };
  return {
    action: "start",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: NOW,
    expectedHandleDigest: DIGEST_C,
    generation,
    handleDigest: digestValue(handle),
    operationId,
    phase: "running",
    protectionDigest: DIGEST_D,
    provisionalEvidence: provisionalEvidence(),
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest: DIGEST_A,
    runningEvidenceDigest: DIGEST_E,
    runtimeIdentity: runtimeIdentity(handle),
    updatedAt: NOW
  };
}

function v2StartFailedCurrent({
  relationId,
  operationId,
  generation,
  token,
  disposition
}) {
  const notInvoked = disposition === "notInvoked";
  const handle = notInvoked ? null : { generation, relationId, token };
  const handleDigest = handle ? digestValue(handle) : "";
  const cleanupEvidence = notInvoked
    ? cleanupNotInvoked()
    : cleanupConfirmed({
      relationId,
      generation,
      handleDigest
    });
  const common = {
    cleanupEvidence,
    cleanupRequired: false,
    commitUncertain: false,
    expectedHandleDigest: notInvoked ? "" : DIGEST_C,
    generation,
    handleDigest,
    phase: "start_failed",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null
  };
  const operation = {
    action: "start",
    createdAt: NOW,
    operationId,
    relationId,
    updatedAt: NOW,
    ...common
  };
  const relation = {
    desired: "enabled",
    handle,
    identityDigest: DIGEST_B,
    operationId,
    relationId,
    updatedAt: NOW,
    ...common
  };
  return { operation, relation };
}

function v2StartFailedOrphan({
  relationId,
  operationId,
  generation,
  token,
  disposition
}) {
  const notInvoked = disposition === "notInvoked";
  const handle = notInvoked ? null : { generation, relationId, token };
  const handleDigest = handle ? digestValue(handle) : "";
  return {
    action: "start",
    cleanupEvidence: notInvoked
      ? cleanupNotInvoked()
      : cleanupConfirmed({ relationId, generation, handleDigest }),
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: NOW,
    expectedHandleDigest: notInvoked ? "" : DIGEST_C,
    generation,
    handleDigest,
    operationId,
    phase: "start_failed",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: NOW
  };
}

function v2PendingCurrent({ relationId, operationId }) {
  const common = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    expectedHandleDigest: null,
    generation: null,
    handleDigest: "",
    phase: "pending",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null
  };
  return {
    operation: {
      action: "disable",
      createdAt: NOW,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    },
    relation: {
      desired: "disabled",
      handle: null,
      identityDigest: DIGEST_B,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    }
  };
}

function v2StartingCurrent({ relationId, operationId }) {
  const common = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    expectedHandleDigest: "",
    generation: null,
    handleDigest: "",
    phase: "starting",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null
  };
  return {
    operation: {
      action: "start",
      createdAt: NOW,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    },
    relation: {
      desired: "enabled",
      handle: null,
      identityDigest: DIGEST_B,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    }
  };
}

function v2TransientPair(phase, {
  relationId,
  operationId,
  generation,
  token = `${phase}-token`
}) {
  const hasHandle = ["stopping", "prepared", "running"].includes(phase);
  const handle = hasHandle ? { generation, relationId, token } : null;
  const action = ["pending", "stopping"].includes(phase)
    ? "disable"
    : "start";
  const common = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: phase === "commit_uncertain",
    expectedHandleDigest: ["prepared", "running"].includes(phase)
      ? DIGEST_C
      : null,
    generation: hasHandle ? generation : null,
    handleDigest: handle ? digestValue(handle) : "",
    phase,
    protectionDigest: ["prepared", "running"].includes(phase)
      ? DIGEST_D
      : null,
    provisionalEvidence: ["prepared", "running"].includes(phase)
      ? provisionalEvidence()
      : null,
    reason: "",
    recordOrigin: "v2",
    requestDigest: DIGEST_A,
    runningEvidenceDigest: phase === "running" ? DIGEST_E : null,
    runtimeIdentity: ["prepared", "running"].includes(phase)
      ? runtimeIdentity(handle)
      : null
  };
  return {
    operation: {
      action,
      createdAt: NOW,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    },
    relation: {
      desired: action === "disable" ? "disabled" : "enabled",
      handle,
      identityDigest: DIGEST_B,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    }
  };
}

function v2CleanupRequiredCurrent({ relationId, operationId }) {
  const common = {
    cleanupEvidence: cleanupUnconfirmed(),
    cleanupRequired: true,
    commitUncertain: false,
    expectedHandleDigest: "",
    generation: null,
    handleDigest: "",
    phase: "cleanup_required",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "relation_file_service_cleanup_required",
    recordOrigin: "v2",
    requestDigest: DIGEST_A,
    runningEvidenceDigest: null,
    runtimeIdentity: null
  };
  return {
    operation: {
      action: "start",
      createdAt: NOW,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    },
    relation: {
      desired: "enabled",
      handle: null,
      identityDigest: DIGEST_B,
      operationId,
      relationId,
      updatedAt: NOW,
      ...common
    }
  };
}

function cleanupConfirmed(identity) {
  return {
    schemaVersion: "1",
    disposition: "confirmedStopped",
    lastRuntimeCheckpoint: "inspect-ready",
    runtimeInvoked: true,
    leaseReturned: true,
    continuationRegistered: false,
    latePrepare: "not-applicable",
    lateGo: "returned",
    abortRequested: true,
    abortCompleted: true,
    containmentConfirmed: true,
    exactHandleIdentity: identity,
    processExited: true,
    listenerClosed: true,
    sessionsClosed: true,
    childrenExited: true,
    reasonCode: "cleanup_confirmed_stopped"
  };
}

function cleanupNotInvoked() {
  return {
    schemaVersion: "1",
    disposition: "notInvoked",
    lastRuntimeCheckpoint: "reservation",
    runtimeInvoked: false,
    leaseReturned: false,
    continuationRegistered: false,
    latePrepare: "not-applicable",
    lateGo: "not-applicable",
    abortRequested: false,
    abortCompleted: false,
    containmentConfirmed: false,
    exactHandleIdentity: null,
    processExited: null,
    listenerClosed: null,
    sessionsClosed: null,
    childrenExited: null,
    reasonCode: "runtime_not_invoked"
  };
}

function cleanupUnconfirmed() {
  return {
    schemaVersion: "1",
    disposition: "unconfirmed",
    lastRuntimeCheckpoint: "prepare-pending",
    runtimeInvoked: true,
    leaseReturned: false,
    continuationRegistered: false,
    latePrepare: "pending",
    lateGo: "not-applicable",
    abortRequested: false,
    abortCompleted: false,
    containmentConfirmed: false,
    exactHandleIdentity: null,
    processExited: null,
    listenerClosed: null,
    sessionsClosed: null,
    childrenExited: null,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
  };
}

function provisionalEvidence() {
  return {
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
    listenerOpen: false,
    observedAt: NOW
  };
}

function runtimeIdentity(handle) {
  return {
    schemaVersion: "1",
    namespace: {
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      pidNamespaceId: "pid:[4026532000]"
    },
    manager: {
      pid: "100",
      starttime: "200"
    },
    process: {
      pid: "101",
      starttime: "201",
      parentPid: "100",
      parentStarttime: "200"
    },
    executable: {
      launcher: executableIdentity("1"),
      target: executableIdentity("2")
    },
    listener: {
      role: "expected",
      host: "127.0.0.1",
      port: 1080
    },
    tokenSha256: digestText(handle.token)
  };
}

function executableIdentity(suffix) {
  return {
    dev: "10",
    ino: `20${suffix}`,
    size: `30${suffix}`,
    sha256: DIGEST_A
  };
}

function digestValue(value) {
  return digestText(stableSerialize(value));
}

function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableSerialize(value) {
  if (value === null
    || typeof value === "boolean"
    || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(",")}}`;
}
