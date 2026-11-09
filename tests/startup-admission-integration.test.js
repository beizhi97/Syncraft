import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, createServer as createNetServer } from "node:net";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitStartup
} from "../src/service/startupAdmission.js";
import * as startupAdmissionModule from "../src/service/startupAdmission.js";
import {
  markRecoveryCommitted,
  prepareRecoveryTransaction,
  readRecoveryJournal,
  resumeRecoveryTransaction
} from "../src/service/runtimeRecoveryTransaction.js";
import {
  prepareStartupRecovery,
  runStartupMaintenanceTransaction
} from "../src/service/startupMaintenance.js";
import {
  projectStartupRecoveryScope
} from "../src/service/startupQuiescenceStateParser.js";

const NOW = "2026-10-23T00:00:00.000Z";
const LATER = "2026-10-23T00:00:01.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const FULL_CONTAINER_ID = "1".repeat(64);
const projectRoot = join(import.meta.dirname, "..");
const serverEntry = join(projectRoot, "src", "server.js");
const startupMainHarnessSource = `import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [serverEntry, mode] = process.argv.slice(2);
const epochRoot = process.env.HARNESS_EPOCH_ROOT;
const { main } = await import(pathToFileURL(serverEntry).href);
const fullContainerId = "1".repeat(64);
const explicitContainerId = "2".repeat(64);
let identityCalls = 0;
let admissionCalls = 0;
let listenCalls = 0;
let identityInput = null;
let admissionInput = null;

const readEpochIdentity = async input => {
  identityCalls += 1;
  identityInput = input;
  if (mode === "read-failure") {
    throw new Error("identity-read-failed");
  }
  return Object.freeze({ containerId: fullContainerId });
};
const startupAdmission = async input => {
  admissionCalls += 1;
  admissionInput = input;
  throw new Error("admission-observed");
};
const listen = () => {
  listenCalls += 1;
};
const ownerGateFactory = () => ({});
const relationCompositionFactory = async () => ({
  runtime: {
    async inspect() {},
    async stop() {},
    async abort() {}
  },
  protection: {
    async verify() {}
  },
  createFacade() {
    return {
      async start() {},
      async query() {},
      async disable() {},
      async reconcile() {}
    };
  }
});
const env = {
  SFSC_RUNTIME_ADMISSION_REQUIRED: "1",
  SFSC_RUNTIME_EPOCH_ROOT: epochRoot,
  SFSC_BOOTSTRAP_NONCE: "A".repeat(43)
};
if (mode === "explicit-env") {
  env.SFSC_CONTAINER_ID = explicitContainerId;
}

let rejection = null;
try {
  await main({
    env,
    startupAdmission,
    listen,
    readEpochIdentity,
    ownerGateFactory,
    relationCompositionFactory
  });
} catch (error) {
  rejection = error;
}
assert(rejection instanceof Error);

if (mode === "epoch-identity") {
  assert.equal(rejection.message, "admission-observed");
  assert.deepEqual(identityInput, { epochRoot });
  assert.equal(identityCalls, 1);
  assert.equal(admissionCalls, 1);
  assert.equal(admissionInput.containerId, fullContainerId);
  assert.equal(listenCalls, 0);
} else if (mode === "explicit-env") {
  assert.equal(rejection.message, "admission-observed");
  assert.equal(identityCalls, 0);
  assert.equal(admissionCalls, 1);
  assert.equal(admissionInput.containerId, explicitContainerId);
  assert.equal(listenCalls, 0);
} else if (mode === "read-failure") {
  assert.equal(rejection.message, "identity-read-failed");
  assert.equal(identityCalls, 1);
  assert.equal(admissionCalls, 0);
  assert.equal(listenCalls, 0);
} else {
  assert.fail(\`unknown startup main harness mode: \${mode}\`);
}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`;
}

function digest(value) {
  return sha256(Buffer.from(stableJson(value), "utf8"));
}

function recoveryIdentity(relationId) {
  return {
    baselineId: `baseline-${relationId}`,
    engine: {
      type: "rclone-bisync",
      semanticsVersion: 1
    },
    rootId: `root-${relationId}`,
    filters: {
      exclude: ["**/.syncraft-root.json"]
    }
  };
}

function recoveryHandle(relationId, generation) {
  return {
    relationId,
    generation,
    token: `token-${relationId}`
  };
}

function currentRecoveryPair(relationId, generation) {
  const identity = recoveryIdentity(relationId);
  const handle = recoveryHandle(relationId, generation);
  const handleDigest = digest(handle);
  const runtimeIdentity = recoveryRuntimeIdentity(handle, 41000);
  const operationId = `op-${relationId}`;
  const requestDigest = digest({ action: "start", relationId, old: true });
  const operation = {
    action: "start",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: NOW,
    expectedHandleDigest: "",
    generation,
    handleDigest,
    operationId,
    phase: "running",
    protectionDigest: DIGEST_F,
    provisionalEvidence: recoveryProvisionalEvidence(),
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest,
    runningEvidenceDigest: DIGEST_A,
    runtimeIdentity,
    updatedAt: NOW
  };
  const relation = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    desired: "enabled",
    expectedHandleDigest: "",
    generation,
    handle,
    handleDigest,
    identityDigest: digest(identity),
    operationId,
    phase: "running",
    protectionDigest: DIGEST_F,
    provisionalEvidence: recoveryProvisionalEvidence(),
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest,
    runningEvidenceDigest: DIGEST_A,
    runtimeIdentity,
    updatedAt: NOW
  };
  return {
    relationId,
    operationId,
    identity,
    handleDigest,
    operation,
    relation
  };
}

function stateWithRecoveryScope() {
  const current = currentRecoveryPair("rel-current", "3");
  const currentOperation = current.operation;
  const currentRelation = current.relation;
  const historical = {
    ...structuredClone(currentOperation),
    generation: "2",
    operationId: "op-history",
    phase: "unknown",
    reason: "relation_file_service_start_blocked",
    expectedHandleDigest: null,
    handleDigest: "",
    protectionDigest: null,
    provisionalEvidence: null,
    runtimeIdentity: null,
    runningEvidenceDigest: null
  };
  const orphan = {
    ...structuredClone(currentOperation),
    generation: "1",
    operationId: "op-orphan",
    phase: "unknown",
    reason: "relation_file_service_start_blocked",
    relationId: "rel-orphan",
    expectedHandleDigest: null,
    handleDigest: "",
    protectionDigest: null,
    provisionalEvidence: null,
    runtimeIdentity: null,
    runningEvidenceDigest: null
  };
  return {
    version: 2,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
    revision: 7,
    createdAt: NOW,
    updatedAt: NOW,
    operations: {
      [currentOperation.operationId]: currentOperation,
      "op-history": historical,
      "op-orphan": orphan
    },
    relations: {
      [currentRelation.relationId]: currentRelation
    }
  };
}

function stateWithTwoRecoveryRelations() {
  const state = stateWithRecoveryScope();
  const second = currentRecoveryPair("rel-second", "5");
  state.operations[second.operationId] = second.operation;
  state.relations[second.relationId] = second.relation;
  return state;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-startup-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "relation-services.json");
  const recoveryDir = join(root, "recovery");
  const beforeBytes = Buffer.from(
    JSON.stringify(stateWithRecoveryScope(), null, 2),
    "utf8"
  );
  await writeFile(statePath, beforeBytes, { mode: 0o600 });
  const projection = projectStartupRecoveryScope(beforeBytes);
  const inheritedDescriptors = projection.descriptors.filter(descriptor => (
    descriptor.kind !== "current"
  ));
  const input = {
    recoveryDir,
    statePath,
    bytes: beforeBytes,
    beforeRawSha256: sha256(beforeBytes),
    closureProofSha256: DIGEST_D,
    deploymentId: "dep-synthetic",
    policyVersion: "policy-v1",
    oldContainerId: "old-container-0123456789abcdef",
    targetEpoch: "epoch-0001",
    createdFromEpoch: "epoch-0000",
    previousHistoryClosureSha256: DIGEST_E,
    inheritedDescriptors,
    now: new Date(NOW)
  };
  return {
    root,
    statePath,
    recoveryDir,
    beforeBytes,
    input,
    inheritedDescriptors
  };
}

async function fixtureWithState(t, state) {
  const context = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  await writeFile(context.statePath, bytes, { mode: 0o600 });
  const projection = projectStartupRecoveryScope(bytes);
  context.beforeBytes = bytes;
  context.input = {
    ...context.input,
    bytes,
    beforeRawSha256: sha256(bytes),
    inheritedDescriptors: projection.descriptors.filter(descriptor => (
      descriptor.kind !== "current"
    ))
  };
  context.inheritedDescriptors = context.input.inheritedDescriptors;
  return context;
}

async function pendingFiles(recoveryDir) {
  return (await readdir(recoveryDir)).sort();
}

function makeLockHarness() {
  const tails = new Map();
  return {
    async withExclusiveLock(request, task) {
      const key = `${request.scope}:${request.relationId || "state"}`;
      const previous = tails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const current = previous.catch(() => {}).then(() => gate);
      tails.set(key, current);
      await previous.catch(() => {});
      try {
        return await task();
      } finally {
        release();
        if (tails.get(key) === current) {
          tails.delete(key);
        }
      }
    }
  };
}

function makeDurableWriter() {
  return {
    async write(request) {
      let current;
      try {
        current = await readFile(request.statePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        current = Buffer.alloc(0);
      }
      if (sha256(current) !== request.expectedRawSha256) {
        return {
          outcome: "not_committed",
          expectedRevision: request.expectedRevision,
          currentRevision: request.expectedRevision
        };
      }
      await writeFile(
        request.statePath,
        JSON.stringify(request.state, null, 2),
        "utf8"
      );
      return {
        outcome: "committed",
        expectedRevision: request.expectedRevision
      };
    }
  };
}

function recoveryRuntimeIdentity(handle, port) {
  return {
    schemaVersion: "1",
    namespace: {
      bootId: "11111111-2222-4333-8444-555555555555",
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
      launcher: {
        dev: "1",
        ino: "2",
        size: "3",
        sha256: "a".repeat(64)
      },
      target: {
        dev: "4",
        ino: "5",
        size: "6",
        sha256: "b".repeat(64)
      }
    },
    tokenSha256: sha256(handle.token),
    listener: {
      role: "expected",
      host: "127.0.0.1",
      port
    }
  };
}

function recoveryProvisionalEvidence() {
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

function recoveryRunningEvidence(handle, identity, fence) {
  return {
    schemaVersion: "1",
    fenceDigest: digest(fence),
    handleDigest: digest(handle),
    runtimeIdentityDigest: digest(identity),
    namespace: structuredClone(identity.namespace),
    process: structuredClone(identity.process),
    executable: structuredClone(identity.executable),
    tokenSha256: identity.tokenSha256,
    listener: {
      role: "observed",
      host: "127.0.0.1",
      port: identity.listener.port,
      open: true,
      ownedByProcess: true,
      socketDev: "7",
      socketIno: "8"
    },
    sessions: {
      tracked: true,
      count: 0
    },
    children: {
      allTracked: true
    },
    capabilities: {
      effective: "0000000000000000",
      permitted: "0000000000000000",
      inheritable: "0000000000000000",
      bounding: "0000000000000000",
      ambient: "0000000000000000"
    },
    noNewPrivs: true,
    parentDeathSignal: "SIGKILL",
    observedAt: NOW
  };
}

function makeRecoveryStartRuntime() {
  const calls = {
    prepare: [],
    go: [],
    inspect: [],
    stop: [],
    abort: []
  };
  const identities = new Map();
  return {
    calls,
    runtime: {
      async prepare(request, details) {
        const handle = recoveryHandle(
          details.fence.relationId,
          details.fence.generation
        );
        const runtimeIdentity = recoveryRuntimeIdentity(
          handle,
          41000
        );
        identities.set(handle.relationId, runtimeIdentity);
        calls.prepare.push({ request, details });
        return {
          lease: { id: `lease-${calls.prepare.length}` },
          handle,
          runtimeIdentity,
          provisionalEvidence: recoveryProvisionalEvidence(),
          fence: details.fence
        };
      },
      async go(lease, details) {
        calls.go.push({ lease, details });
        return { ok: true };
      },
      async inspect(handle, details) {
        calls.inspect.push({ handle, details });
        const identity = identities.get(handle.relationId);
        if (!identity) {
          throw new Error("recovered old handle must not be inspected");
        }
        if (details.purpose === "running") {
          return recoveryRunningEvidence(handle, identity, details.fence);
        }
        throw new Error("recovered old handle must not be inspected");
      },
      async stop() {
        calls.stop.push(structuredClone(Array.from(arguments)));
        throw new Error("recovered old handle must not be stopped");
      },
      async abort() {
        calls.abort.push(structuredClone(Array.from(arguments)));
        return { containmentConfirmed: true };
      }
    }
  };
}

function recoveryProtection() {
  return {
    async verify() {
      return { digest: DIGEST_F };
    }
  };
}

function recoveryStartRequest(relationId, operationId, identity, handleDigest) {
  return {
    relationId,
    operationId,
    identity,
    expectedHandleDigest: handleDigest,
    launch: {
      target: "rclone-serve-sftp",
      listener: {
        host: "127.0.0.1",
        port: 41000
      }
    }
  };
}

function makeOwnerGate(baseline, statePath, overrideSnapshot = null) {
  const lease = Object.freeze({});
  const leaseState = { valid: true };
  const calls = { acquire: 0, evaluate: 0, assert: 0 };
  return {
    calls,
    leaseState,
    lease,
    gate: {
      acquireOwnerLease() {
        calls.acquire += 1;
        return lease;
      },
      evaluateStartupState(receivedLease) {
        assert.equal(receivedLease, lease);
        calls.evaluate += 1;
        return overrideSnapshot || {
          fullStartupAdmission: false,
          revision: baseline.revision,
          rawSha256: baseline.rawSha256
        };
      },
      async assertOwnerLease(receivedLease) {
        assert.equal(receivedLease, lease);
        calls.assert += 1;
        if (!leaseState.valid) {
          return { valid: false };
        }
        const info = await import("node:fs/promises").then(({ lstat }) => (
          lstat(join(statePath, ".."))
        ));
        return {
          valid: true,
          parentDev: String(info.dev),
          parentIno: String(info.ino)
        };
      }
    }
  };
}

async function sealRecoveredEpoch(context, options = {}) {
  const prepared = await prepareRecoveryTransaction(context.input);
  await resumeRecoveryTransaction(context);
  const journal = await readRecoveryJournal(
    context.recoveryDir,
    prepared.journal.transactionId
  );
  const epochRoot = join(context.root, "epoch");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(epochRoot));
  await copyFile(
    join(context.recoveryDir, `${journal.transactionId}.history-closure.json`),
    join(epochRoot, "history-closure.json")
  );
  const nonce = options.nonce || "synthetic-bootstrap-nonce-0000000000000000";
  const containerId = options.containerId || "1".repeat(64);
  const epoch = {
    schemaVersion: "1",
    deploymentId: "dep-synthetic",
    targetEpoch: "epoch-0001",
    containerId,
    imageDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    hostCgroupPath:
      `/system.slice/docker-${containerId}.scope`,
    bootstrapNonceSha256: sha256(Buffer.from(nonce, "utf8")),
    stateBaseline: {
      revision: journal.afterRevision,
      rawSha256: journal.afterRawSha256
    },
    recovery: {
      transactionId: journal.transactionId,
      status: "committed",
      closureProofSha256: journal.closureProofSha256,
      previousHistoryClosureSha256:
        journal.previousHistoryClosureSha256,
      afterRevision: journal.afterRevision,
      afterRawSha256: journal.afterRawSha256,
      scopeProjectionSha256: journal.scopeProjectionSha256,
      historyClosureSha256: journal.historyClosureSha256
    },
    sealedAt: LATER
  };
  const epochBytes = Buffer.from(JSON.stringify(epoch, null, 2), "utf8");
  await writeFile(join(epochRoot, "epoch.json"), epochBytes, { mode: 0o444 });
  const ready = {
    schemaVersion: "1",
    targetEpoch: epoch.targetEpoch,
    containerId,
    imageDigest: epoch.imageDigest,
    hostCgroupPath: epoch.hostCgroupPath,
    bootstrapNonceSha256: epoch.bootstrapNonceSha256,
    pidNamespaceId: "pid:[4026532000]",
    epochManifestSha256: sha256(epochBytes),
    sealedAt: LATER
  };
  await writeFile(
    join(epochRoot, "runtime-ready.json"),
    JSON.stringify(ready, null, 2),
    { mode: 0o444 }
  );
  await markRecoveryCommitted({
    recoveryDir: context.recoveryDir,
    transactionId: journal.transactionId,
    epochManifestSha256: sha256(epochBytes)
  });
  return {
    epochRoot,
    epoch,
    ready,
    nonce,
    containerId,
    epochManifestSha256: sha256(epochBytes)
  };
}

async function admissionOptions(context, sealed, overrides = {}) {
  const baseline = {
    revision: sealed.epoch.stateBaseline.revision,
    rawSha256: sealed.epoch.stateBaseline.rawSha256
  };
  const owner = makeOwnerGate(
    baseline,
    context.statePath,
    overrides.ownerSnapshot
  );
  return {
    epochRoot: sealed.epochRoot,
    statePath: context.statePath,
    ownerGate: owner.gate,
    ownerGateObject: owner.gate,
    ownerLeaseState: owner.leaseState,
    ownerCalls: owner.calls,
    containerId: sealed.containerId,
    bootstrapNonce: sealed.nonce,
    readPidNamespace: async () => "pid:[4026532000]",
    runtimeReadyTimeoutMs: 100,
    managerOptions: {
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      durableWriter: makeDurableWriter(),
      runtime: {
        async inspect() {
          throw new Error("runtime must not be inspected at admission");
        },
        async stop() {
          throw new Error("runtime must not be stopped at admission");
        }
      }
    },
    ...overrides
  };
}

test("recovery preparation replays deterministically after a pre-journal crash", async t => {
  for (const boundary of ["history-closure", "after-bytes"]) {
    const context = await fixture(t);
    await assert.rejects(
      prepareRecoveryTransaction({
        ...context.input,
        onBoundary: async value => {
          if (value === boundary) {
            throw new Error("simulated power loss");
          }
        }
      }),
      /simulated power loss/
    );
    assert.equal(
      (await readdir(context.recoveryDir)).some(name => /^[a-f0-9]{64}\.json$/.test(name)),
      false
    );
    const prepared = await prepareRecoveryTransaction(context.input);
    const resumed = await resumeRecoveryTransaction(context);
    assert.equal(resumed.stateWritten, true);
    assert.equal(resumed.journal.status, "after-verified");
    assert.equal(resumed.journal.transactionId, prepared.journal.transactionId);
    assert.equal(resumed.journal.afterRevision, 8);
    const bytes = await readFile(context.statePath);
    assert.equal(sha256(bytes), prepared.journal.afterRawSha256);
  }
});

test("resume reconstructs missing after bytes and advances revision exactly once", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  await rm(join(context.recoveryDir, `${prepared.journal.transactionId}.after.json`));
  const first = await resumeRecoveryTransaction(context);
  const second = await resumeRecoveryTransaction(context);
  assert.equal(first.stateWritten, true);
  assert.equal(second.stateWritten, false);
  assert.equal(first.journal.afterRevision, 8);
  const state = JSON.parse(await readFile(context.statePath, "utf8"));
  assert.equal(state.revision, 8);
  const after = await readFile(
    join(context.recoveryDir, `${prepared.journal.transactionId}.after.json`)
  );
  assert.equal(sha256(after), prepared.journal.afterRawSha256);
});

test("resume recognizes exact after bytes without a second state write", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  await writeFile(context.statePath, prepared.afterBytes, { mode: 0o600 });
  const beforeStat = await readFile(context.statePath);
  const resumed = await resumeRecoveryTransaction(context);
  assert.equal(resumed.stateWritten, false);
  assert.equal(sha256(await readFile(context.statePath)), sha256(beforeStat));
  assert.equal(resumed.journal.afterRevision, 8);
});

test("resume refuses the state write when the owner lease is lost", async t => {
  const context = await fixture(t);
  await prepareRecoveryTransaction(context.input);
  await assert.rejects(
    resumeRecoveryTransaction({
      ...context,
      assertOwnerLease: async () => {
        const error = new Error("owner lease was replaced");
        error.code = "owner_lease_lost";
        throw error;
      }
    }),
    { code: "owner_lease_lost" }
  );
  assert.deepEqual(await readFile(context.statePath), context.beforeBytes);
  const journalNames = (await readdir(context.recoveryDir)).filter(name => (
    /^[a-f0-9]{64}\.json$/.test(name)
  ));
  assert.equal(journalNames.length, 1);
  const journal = JSON.parse(await readFile(
    join(context.recoveryDir, journalNames[0]),
    "utf8"
  ));
  assert.equal(journal.status, "prepared");
});

test("maintenance orchestration resumes the same after-verified transaction", async t => {
  const context = await fixture(t);
  const lease = Object.freeze({});
  const assertOwnerLease = async received => {
    assert.equal(received, lease);
    return { valid: true };
  };
  const first = await runStartupMaintenanceTransaction({
    recoveryDir: context.recoveryDir,
    statePath: context.statePath,
    ownerLease: lease,
    assertOwnerLease,
    transaction: context.input
  });
  const second = await runStartupMaintenanceTransaction({
    recoveryDir: context.recoveryDir,
    statePath: context.statePath,
    ownerLease: lease,
    assertOwnerLease,
    transaction: null
  });
  assert.equal(first.required, true);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(second.revision, 8);
  const state = JSON.parse(await readFile(context.statePath, "utf8"));
  assert.equal(state.revision, 8);
});

test("history closure persists a nonzero parent hash and complete exact scope", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  assert.equal(
    prepared.journal.previousHistoryClosureSha256,
    DIGEST_E
  );
  assert.deepEqual(
    prepared.journal.descriptors,
    [...prepared.journal.descriptors].sort((left, right) => (
      String(left.kind).localeCompare(String(right.kind))
      || String(left.relationId).localeCompare(String(right.relationId))
      || String(left.oldOperationId ?? left.operationId)
        .localeCompare(String(right.oldOperationId ?? right.operationId))
    ))
  );
  assert.deepEqual(
    new Set(prepared.journal.descriptors.map(value => value.kind)),
    new Set(["current", "history", "orphan"])
  );
  const resumed = await resumeRecoveryTransaction(context);
  assert.equal(resumed.journal.status, "after-verified");
});

test("history closure rejects missing or extra descriptors before state write", async t => {
  for (const mutation of ["missing", "extra"]) {
    const context = await fixture(t);
    const prepared = await prepareRecoveryTransaction(context.input);
    const closurePath = join(
      context.recoveryDir,
      `${prepared.journal.transactionId}.history-closure.json`
    );
    const journalPath = join(
      context.recoveryDir,
      `${prepared.journal.transactionId}.json`
    );
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    if (mutation === "missing") {
      closure.descriptors.pop();
    } else {
      closure.descriptors.push({
        kind: "orphan",
        operationId: "op-injected",
        relationId: "rel-injected",
        recordSha256: DIGEST_F
      });
    }
    const closureBytes = Buffer.from(JSON.stringify(closure, null, 2), "utf8");
    await chmod(closurePath, 0o600);
    await writeFile(closurePath, closureBytes, { mode: 0o600 });
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.descriptors = closure.descriptors;
    journal.historyClosureSha256 = sha256(closureBytes);
    await chmod(journalPath, 0o600);
    await writeFile(journalPath, JSON.stringify(journal, null, 2), {
      mode: 0o600
    });
    await assert.rejects(
      resumeRecoveryTransaction(context),
      { code: "runtime_recovery_history_scope_mismatch" }
    );
    assert.deepEqual(await readFile(context.statePath), context.beforeBytes);
  }
});

test("committed mark is idempotent and remains bound to one epoch", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  await resumeRecoveryTransaction(context);
  const first = await markRecoveryCommitted({
    recoveryDir: context.recoveryDir,
    transactionId: prepared.journal.transactionId,
    epochManifestSha256: DIGEST_F
  });
  const retry = await markRecoveryCommitted({
    recoveryDir: context.recoveryDir,
    transactionId: prepared.journal.transactionId,
    epochManifestSha256: DIGEST_F
  });
  assert.deepEqual(retry, first);
  await assert.rejects(
    markRecoveryCommitted({
      recoveryDir: context.recoveryDir,
      transactionId: prepared.journal.transactionId,
      epochManifestSha256: DIGEST_A
    }),
    { code: "runtime_recovery_transaction_state_invalid" }
  );
  assert.deepEqual(
    await readRecoveryJournal(context.recoveryDir, prepared.journal.transactionId),
    first
  );
});

test("multiple pending journals fail closed", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  const journalPath = join(
    context.recoveryDir,
    `${prepared.journal.transactionId}.json`
  );
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const secondId = DIGEST_A;
  journal.transactionId = secondId;
  await writeFile(
    join(context.recoveryDir, `${secondId}.json`),
    JSON.stringify(journal, null, 2),
    { mode: 0o600 }
  );
  await assert.rejects(
    resumeRecoveryTransaction(context),
    { code: "runtime_recovery_multiple_pending" }
  );
});

test("initial recovery preparation exposes no serializable recovery capability", async t => {
  const context = await fixture(t);
  const prepared = await prepareRecoveryTransaction(context.input);
  const projection = JSON.parse(JSON.stringify(prepared.scopeProjection));
  assert.equal(projection.fullStartupAdmission, undefined);
  assert.equal(JSON.stringify(prepared).includes("rawBytes"), false);
  assert.equal(JSON.stringify(prepared).includes("permit"), false);
});

test("single admission binds static epoch, ready proof, snapshot, private read, and manager", async t => {
  const context = await fixture(t);
  const sealed = await sealRecoveredEpoch(context);
  const options = await admissionOptions(context, sealed);
  const result = await admitStartup(options);
  assert.equal(result.publicSummary.recoveryApplied, true);
  assert.equal(result.publicSummary.revision, 8);
  assert.equal(options.ownerCalls.acquire, 1);
  assert.equal(options.ownerCalls.evaluate, 1);
  assert.ok(options.ownerCalls.assert >= 3);
  assert.equal(JSON.stringify(result.publicSummary).includes("permit"), false);
  assert.equal(JSON.stringify(result.publicSummary).includes("descriptor"), false);
  const queried = await result.manager.query({ relationId: "rel-current" });
  assert.equal(queried.relationId, "rel-current");
});

test("admission blocks stale extra epoch input and wrong ready identity", async t => {
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    await writeFile(join(sealed.epochRoot, "other-epoch.json"), "{}", {
      mode: 0o444
    });
    await assert.rejects(
      admitStartup(await admissionOptions(context, sealed)),
      { code: "startup_admission_epoch_invalid" }
    );
  }
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    const ready = { ...sealed.ready, containerId: "2".repeat(64) };
    await chmod(join(sealed.epochRoot, "runtime-ready.json"), 0o600);
    await writeFile(
      join(sealed.epochRoot, "runtime-ready.json"),
      JSON.stringify(ready, null, 2),
      { mode: 0o444 }
    );
    await assert.rejects(
      admitStartup(await admissionOptions(context, sealed)),
      { code: "startup_admission_runtime_ready_invalid" }
    );
  }
});

test("admission rejects nonce, namespace, and owner snapshot drift", async t => {
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    await assert.rejects(
      admitStartup({
        ...await admissionOptions(context, sealed),
        bootstrapNonce: "synthetic-bootstrap-nonce-1111111111111111"
      }),
      { code: "startup_admission_epoch_identity_mismatch" }
    );
  }
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    await assert.rejects(
      admitStartup({
        ...await admissionOptions(context, sealed),
        readPidNamespace: async () => "pid:[999]"
      }),
      { code: "startup_admission_namespace_mismatch" }
    );
  }
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    await assert.rejects(
      admitStartup(await admissionOptions(context, sealed, {
        ownerSnapshot: {
          fullStartupAdmission: false,
          revision: 7,
          rawSha256: DIGEST_A
        }
      })),
      { code: "startup_admission_owner_snapshot_mismatch" }
    );
  }
});

test("admission rejects same-revision byte drift before manager facade exists", async t => {
  const context = await fixture(t);
  const sealed = await sealRecoveredEpoch(context);
  const state = JSON.parse(await readFile(context.statePath, "utf8"));
  await writeFile(context.statePath, JSON.stringify(state, null, 4), {
    mode: 0o600
  });
  await assert.rejects(
    admitStartup(await admissionOptions(context, sealed)),
    { code: "startup_admission_state_baseline_mismatch" }
  );
});

test("ordinary unknown cannot become a recovery transaction without exact history", async t => {
  const context = await fixture(t);
  const state = stateWithRecoveryScope();
  state.relations["rel-current"].phase = "unknown";
  state.operations["op-rel-current"].phase = "unknown";
  const bytes = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  let failure;
  try {
    prepareStartupRecovery({
      ...fixtureInput(bytes),
      inheritedDescriptors: context.inheritedDescriptors
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "startup_recovery_ordinary_uncertainty");
});

test("two recovered relations continue sequentially through full lifecycle commits", async t => {
  const context = await fixtureWithState(t, stateWithTwoRecoveryRelations());
  const sealed = await sealRecoveredEpoch(context);
  const starts = makeRecoveryStartRuntime();
  const options = await admissionOptions(context, sealed, {
    managerOptions: {
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      durableWriter: makeDurableWriter(),
      runtime: starts.runtime,
      protection: recoveryProtection()
    }
  });
  const admitted = await admitStartup(options);
  const recovered = JSON.parse(await readFile(context.statePath, "utf8"));
  const first = recovered.relations["rel-current"];
  const second = recovered.relations["rel-second"];

  const firstResult = await admitted.manager.start(recoveryStartRequest(
    "rel-current",
    "operation-recovered-current",
    recoveryIdentity("rel-current"),
    first.handleDigest
  ));
  const afterFirst = JSON.parse(await readFile(context.statePath, "utf8"));
  assert.equal(afterFirst.revision, recovered.revision + 3);
  assert.equal(afterFirst.operations[first.operationId].phase, "unknown");
  assert.equal(afterFirst.relations["rel-current"].generation, "4");
  assert.equal(firstResult.state, "running");

  const secondResult = await admitted.manager.start(recoveryStartRequest(
    "rel-second",
    "operation-recovered-second",
    recoveryIdentity("rel-second"),
    second.handleDigest
  ));
  const finalState = JSON.parse(await readFile(context.statePath, "utf8"));
  assert.equal(finalState.revision, recovered.revision + 6);
  assert.equal(finalState.operations[second.operationId].phase, "unknown");
  assert.equal(finalState.relations["rel-second"].generation, "6");
  assert.equal(secondResult.state, "running");
  assert.equal(starts.calls.prepare.length, 2);
  assert.equal(starts.calls.go.length, 2);
  assert.equal(starts.calls.inspect.length, 2);
  assert.equal(starts.calls.stop.length, 0);
  assert.equal(starts.calls.abort.length, 0);
  assert.ok(starts.calls.inspect.every(call => call.details.purpose === "running"));
  assert.deepEqual(
    starts.calls.inspect.map(call => call.handle.generation).sort(),
    ["4", "6"]
  );
});

test("disabled recovery scope is committed but never becomes start authority", async t => {
  const state = stateWithRecoveryScope();
  const disabled = currentRecoveryPair("rel-disabled", "7");
  disabled.operation.action = "disable";
  disabled.operation.phase = "unknown";
  disabled.operation.expectedHandleDigest = null;
  disabled.operation.handleDigest = "";
  disabled.operation.protectionDigest = null;
  disabled.operation.provisionalEvidence = null;
  disabled.operation.runtimeIdentity = null;
  disabled.operation.runningEvidenceDigest = null;
  disabled.relation.desired = "disabled";
  disabled.relation.phase = "unknown";
  disabled.relation.expectedHandleDigest = null;
  disabled.relation.handle = null;
  disabled.relation.handleDigest = "";
  disabled.relation.protectionDigest = null;
  disabled.relation.provisionalEvidence = null;
  disabled.relation.runtimeIdentity = null;
  disabled.relation.runningEvidenceDigest = null;
  state.operations[disabled.operationId] = disabled.operation;
  state.relations[disabled.relationId] = disabled.relation;

  const context = await fixtureWithState(t, state);
  const projection = projectStartupRecoveryScope(
    Buffer.from(JSON.stringify(state, null, 2), "utf8")
  );
  context.input.inheritedDescriptors = projection.descriptors.filter(descriptor => (
    descriptor.kind !== "current" || descriptor.relationId === "rel-disabled"
  ));
  const sealed = await sealRecoveredEpoch(context);
  const starts = makeRecoveryStartRuntime();
  const admitted = await admitStartup(await admissionOptions(context, sealed, {
    managerOptions: {
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      durableWriter: makeDurableWriter(),
      runtime: starts.runtime,
      protection: recoveryProtection()
    }
  }));

  await assert.rejects(
    admitted.manager.start(recoveryStartRequest(
      "rel-disabled",
      "operation-disabled-start",
      recoveryIdentity("rel-disabled"),
      ""
    )),
    { code: "relation_file_service_start_blocked" }
  );
  const persisted = JSON.parse(await readFile(context.statePath, "utf8"));
  assert.equal(persisted.relations["rel-disabled"].desired, "disabled");
  assert.equal(persisted.relations["rel-disabled"].operationId,
    disabled.operationId);
  assert.equal(starts.calls.prepare.length, 0);
});

test("recovery authority is consumed once and same-operation replay is idempotent", async t => {
  const context = await fixture(t);
  const sealed = await sealRecoveredEpoch(context);
  const starts = makeRecoveryStartRuntime();
  const admitted = await admitStartup(await admissionOptions(context, sealed, {
    managerOptions: {
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      durableWriter: makeDurableWriter(),
      runtime: starts.runtime,
      protection: recoveryProtection()
    }
  }));
  const recovered = JSON.parse(await readFile(context.statePath, "utf8"));
  const old = recovered.relations["rel-current"];
  const request = recoveryStartRequest(
    "rel-current",
    "operation-recovery-once",
    recoveryIdentity("rel-current"),
    old.handleDigest
  );
  const first = await admitted.manager.start(request);
  const replay = await admitted.manager.start(request);
  assert.deepEqual(replay, first);
  assert.equal(starts.calls.prepare.length, 1);
  const started = JSON.parse(await readFile(context.statePath, "utf8"));

  await assert.rejects(
    admitted.manager.start({
      ...request,
      operationId: "operation-recovery-second-grant",
      expectedHandleDigest: started.relations["rel-current"].handleDigest
    }),
    { code: "relation_file_service_start_blocked" }
  );
  assert.equal(starts.calls.prepare.length, 1);
});

test("post-admission lease loss and same-revision drift stop before runtime work", async t => {
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    const starts = makeRecoveryStartRuntime();
    const options = await admissionOptions(context, sealed, {
      managerOptions: {
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        durableWriter: makeDurableWriter(),
        runtime: starts.runtime,
        protection: recoveryProtection()
      }
    });
    const admitted = await admitStartup(options);
    options.ownerLeaseState.valid = false;
    const recovered = JSON.parse(await readFile(context.statePath, "utf8"));
    await assert.rejects(
      admitted.manager.start(recoveryStartRequest(
        "rel-current",
        "operation-lease-lost",
        recoveryIdentity("rel-current"),
        recovered.relations["rel-current"].handleDigest
      )),
      { code: "relation_file_service_owner_lease_invalid" }
    );
    assert.equal(starts.calls.prepare.length, 0);
  }
  {
    const context = await fixture(t);
    const sealed = await sealRecoveredEpoch(context);
    const starts = makeRecoveryStartRuntime();
    const admitted = await admitStartup(await admissionOptions(context, sealed, {
      managerOptions: {
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        durableWriter: makeDurableWriter(),
        runtime: starts.runtime,
        protection: recoveryProtection()
      }
    }));
    const state = JSON.parse(await readFile(context.statePath, "utf8"));
    const drifted = Buffer.from(JSON.stringify(state, null, 4), "utf8");
    await writeFile(context.statePath, drifted, { mode: 0o600 });
    await assert.rejects(
      admitted.manager.start(recoveryStartRequest(
        "rel-current",
        "operation-byte-drift",
        recoveryIdentity("rel-current"),
        state.relations["rel-current"].handleDigest
      )),
      { code: "relation_file_service_state_revision_conflict" }
    );
    assert.equal(starts.calls.prepare.length, 0);
  }
});

test("pure preparation keeps the accepted public parser full-admission block", () => {
  const bytes = Buffer.from(JSON.stringify(stateWithRecoveryScope(), null, 2));
  const prepared = prepareStartupRecovery({
    ...fixtureInput(bytes),
    now: new Date(NOW)
  });
  assert.equal(prepared.required, true);
  assert.equal(prepared.scopeProjection.fullStartupAdmission, undefined);
  assert.match(
    JSON.stringify(prepared.scopeProjection),
    /startup_quiescence_current_unresolved/
  );
});

async function writeStaticEpochIdentity(root, overrides = {}) {
  const epochRoot = join(root, "epoch");
  await mkdir(epochRoot);
  const epoch = {
    schemaVersion: "1",
    deploymentId: "dep-static",
    targetEpoch: "epoch-0001",
    containerId: FULL_CONTAINER_ID,
    imageDigest:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    hostCgroupPath: `/system.slice/docker-${FULL_CONTAINER_ID}.scope`,
    bootstrapNonceSha256: DIGEST_A,
    stateBaseline: {
      revision: 0,
      rawSha256: DIGEST_B
    },
    recovery: {
      transactionId: null,
      status: null,
      closureProofSha256: DIGEST_C,
      previousHistoryClosureSha256: DIGEST_D,
      afterRevision: 0,
      afterRawSha256: DIGEST_B,
      scopeProjectionSha256: null,
      historyClosureSha256: null
    },
    sealedAt: NOW,
    ...overrides
  };
  await writeFile(
    join(epochRoot, "epoch.json"),
    JSON.stringify(epoch, null, 2)
  );
  return { epochRoot, epoch };
}

test("static startup epoch identity returns only its validated complete container ID", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-static-epoch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { epochRoot } = await writeStaticEpochIdentity(root);

  const identity = await startupAdmissionModule.readStartupEpochIdentity({
    epochRoot
  });

  assert.deepEqual(identity, { containerId: FULL_CONTAINER_ID });
  assert.equal(Object.isFrozen(identity), true);
});

test("static startup epoch identity rejects an incomplete container manifest", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-invalid-epoch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { epochRoot } = await writeStaticEpochIdentity(root, {
    containerId: "1".repeat(12)
  });

  await assert.rejects(
    startupAdmissionModule.readStartupEpochIdentity({ epochRoot }),
    error => error?.code === "startup_admission_manifest_invalid"
  );
});

async function runStartupMainHarness(t, mode) {
  const root = await mkdtemp(join(tmpdir(), `sfsc-main-${mode}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epochRoot = join(root, "epoch");
  await mkdir(epochRoot);
  const harnessPath = join(root, "startup-main-harness.mjs");
  await writeFile(harnessPath, startupMainHarnessSource);
  const childEnvironment = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "5177",
    SERVER_DATA_ROOT: root,
    SFSC_ALLOW_NO_ADMIN_TOKEN: "1",
    HARNESS_EPOCH_ROOT: epochRoot
  };
  for (const key of [
    "SFSC_RUNTIME_ADMISSION_REQUIRED",
    "SFSC_RUNTIME_EPOCH_ROOT",
    "SFSC_RELATION_STATE_PATH",
    "SFSC_CONTAINER_ID",
    "SFSC_BOOTSTRAP_NONCE"
  ]) {
    delete childEnvironment[key];
  }
  const child = spawn(
    process.execPath,
    [harnessPath, serverEntry, mode],
    {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  const exit = await waitForChildExit(child, 15_000);
  assert.equal(
    exit.code,
    0,
    `startup main harness failed\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}

test("server main derives a complete container ID from the static epoch", {
  timeout: 20_000
}, async t => {
  await runStartupMainHarness(t, "epoch-identity");
});

test("server main keeps an explicit container ID ahead of epoch identity", {
  timeout: 20_000
}, async t => {
  await runStartupMainHarness(t, "explicit-env");
});

test("server main exits before admission and listen when epoch identity fails", {
  timeout: 20_000
}, async t => {
  await runStartupMainHarness(t, "read-failure");
});

test("real server child without valid startup admission exits before binding", {
  timeout: 20_000
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-blocked-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await findFreePort();
  const childEnvironment = {
    HOST: "127.0.0.1",
    PORT: String(port),
    SERVER_DATA_ROOT: root,
    SFSC_ALLOW_NO_ADMIN_TOKEN: "1",
    SFSC_RUNTIME_ADMISSION_REQUIRED: "1",
    SFSC_RUNTIME_EPOCH_ROOT: join(root, "missing-epoch"),
    SFSC_RELATION_STATE_PATH: join(root, "relation-services.json"),
    SFSC_CONTAINER_ID: "1".repeat(64),
    SFSC_BOOTSTRAP_NONCE: "A".repeat(43)
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]) {
    if (process.env[key]) {
      childEnvironment[key] = process.env[key];
    }
  }
  let child;
  try {
    child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    if (error?.code === "EPERM" && process.platform === "win32") {
      t.skip("Windows sandbox blocks the Node child-process proof");
      return;
    }
    throw error;
  }
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  let exit;
  try {
    exit = await waitForChildExit(child, 15_000);
  } catch (error) {
    if (error?.code === "EPERM" && process.platform === "win32") {
      t.skip("Windows sandbox blocks the Node child-process proof");
      return;
    }
    throw error;
  }
  assert.notEqual(exit.code, 0, `blocked server unexpectedly exited cleanly\n${stdout}`);
  assert.match(stderr, /\[sfsc\] (?:server_error|startup_admission_[a-z_]+):/);
  assert.equal(await connectionOutcome(port), "ECONNREFUSED");
});

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("blocked server child did not exit"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function connectionOutcome(port) {
  return new Promise((resolveOutcome) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port
    });
    const finish = outcome => {
      socket.destroy();
      resolveOutcome(outcome);
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", error => finish(error?.code || "error"));
    socket.setTimeout(1_000, () => finish("timeout"));
  });
}

function fixtureInput(bytes) {
  const projection = projectStartupRecoveryScope(bytes);
  return {
    bytes,
    beforeRawSha256: sha256(bytes),
    closureProofSha256: DIGEST_D,
    deploymentId: "dep-synthetic",
    policyVersion: "policy-v1",
    oldContainerId: "old-container-0123456789abcdef",
    targetEpoch: "epoch-0001",
    createdFromEpoch: "epoch-0000",
    previousHistoryClosureSha256: DIGEST_E,
    inheritedDescriptors: projection.descriptors.filter(descriptor => (
      descriptor.kind !== "current"
    ))
  };
}
