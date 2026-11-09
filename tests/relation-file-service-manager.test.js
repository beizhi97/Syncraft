import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createLinuxDurableWriter,
  RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT,
  RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT,
  open
} from "../src/core/relationFileServiceManager.js";

function identity(label) {
  return {
    baselineId: `baseline-${label}`,
    engine: {
      type: "rclone-bisync",
      semanticsVersion: 1
    },
    rootId: `root-${label}`,
    filters: {
      exclude: ["**/.syncraft-root.json"]
    }
  };
}

function handle(relationId, generation = "1") {
  return {
    relationId,
    generation,
    token: `token-${relationId}`
  };
}

function observation(state, runtimeHandle, overrides = {}) {
  const stopped = state === "stopped";
  return {
    ...runtimeHandle,
    state,
    owned: true,
    processExited: stopped,
    listenerClosed: stopped,
    sessionsClosed: stopped,
    ...overrides
  };
}

function makeLockHarness() {
  const tails = new Map();
  const scopes = [];
  let activeStateLocks = 0;
  let maxActiveStateLocks = 0;

  async function withKeyLock(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
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

  return {
    scopes,
    get activeStateLocks() {
      return activeStateLocks;
    },
    get maxActiveStateLocks() {
      return maxActiveStateLocks;
    },
    withExclusiveLock(scope, task) {
      scopes.push(scope.scope);
      if (scope.scope === "state") {
        return withKeyLock(scope.lockPath, async () => {
          activeStateLocks += 1;
          maxActiveStateLocks = Math.max(maxActiveStateLocks, activeStateLocks);
          try {
            return await task();
          } finally {
            activeStateLocks -= 1;
          }
        });
      }
      return withKeyLock(scope.lockPath, task);
    }
  };
}

function makeRuntime(inspections = [], options = {}) {
  const inspectCalls = [];
  const stopCalls = [];
  let index = 0;
  return {
    inspectCalls,
    stopCalls,
    runtime: {
      async inspect(runtimeHandle) {
        inspectCalls.push(structuredClone(runtimeHandle));
        const next = inspections[index];
        index += 1;
        if (next instanceof Error) {
          throw next;
        }
        if (typeof next === "function") {
          return next(runtimeHandle);
        }
        return next || observation("unknown", runtimeHandle);
      },
      async stop(runtimeHandle, details) {
        stopCalls.push({
          handle: structuredClone(runtimeHandle),
          details: structuredClone(details)
        });
        if (options.stopError) {
          throw options.stopError;
        }
        return { ok: true };
      }
    }
  };
}

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-relation-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function withTimeout(promise, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("disable persists desired state before a verified runtime stop", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-one";
  const runtimeHandle = handle(relationId);
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    async (observedHandle) => {
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(persisted.relations[relationId].desired, "disabled");
      assert.equal(persisted.relations[relationId].phase, "stopping");
      assert.equal(persisted.relations[relationId].operationId, "operation-one");
      return observation("running", observedHandle);
    },
    observation("stopped", runtimeHandle)
  ]);
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });

  const result = await manager.disable({
    relationId,
    identity: identity("one"),
    handle: runtimeHandle,
    operationId: "operation-one"
  });

  assert.equal(result.state, "stopped");
  assert.deepEqual(Object.keys(result).sort(), [
    "desired",
    "generation",
    "operationId",
    "reason",
    "relationId",
    "state"
  ]);
  assert.equal(inspectCalls.length, 2);
  assert.equal(stopCalls.length, 1);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.storageContract, RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT);
  assert.equal(state.relations[relationId].desired, "disabled");
  assert.equal(state.relations[relationId].phase, "stopped");
  assert.equal(state.operations["operation-one"].phase, "stopped");
});

test("ownership and closure evidence are required for running and stopped observations", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const noOwnerHandle = handle("relation-no-owner");
  const incompleteStopHandle = handle("relation-incomplete-stop");
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    observation("running", noOwnerHandle, { owned: false }),
    observation("stopped", incompleteStopHandle, {
      processExited: false,
      listenerClosed: false,
      sessionsClosed: false
    })
  ]);
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });

  const noOwner = await manager.disable({
    relationId: noOwnerHandle.relationId,
    identity: identity("no-owner"),
    handle: noOwnerHandle,
    operationId: "operation-no-owner"
  });
  assert.equal(noOwner.state, "pending");
  assert.equal(noOwner.reason, "runtime_ownership_unconfirmed");

  const incompleteStop = await manager.disable({
    relationId: incompleteStopHandle.relationId,
    identity: identity("incomplete-stop"),
    handle: incompleteStopHandle,
    operationId: "operation-incomplete-stop"
  });
  assert.equal(incompleteStop.state, "pending");
  assert.equal(incompleteStop.reason, "runtime_stop_evidence_incomplete");
  assert.equal(inspectCalls.length, 2);
  assert.equal(stopCalls.length, 0);
});

test("statePath must be absolute", async () => {
  const { runtime, inspectCalls, stopCalls } = makeRuntime();
  await assert.rejects(
    () => open({
      statePath: "relative-services.json",
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime
    }),
    (error) => error?.code === "relation_file_service_request_invalid"
  );
  assert.equal(inspectCalls.length, 0);
  assert.equal(stopCalls.length, 0);
});

test("reopen reconcile only stops a persisted disabled relation", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-reopen";
  const runtimeHandle = handle(relationId, "7");
  const first = makeRuntime([
    observation("running", runtimeHandle)
  ], {
    stopError: new Error("stop unavailable")
  });
  const firstManager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: first.runtime
  });
  const pending = await firstManager.disable({
    relationId,
    identity: identity("reopen"),
    handle: runtimeHandle,
    operationId: "operation-reopen"
  });
  assert.equal(pending.state, "pending");
  assert.equal(pending.reason, "runtime_stop_failed");

  const second = makeRuntime([
    observation("stopped", runtimeHandle)
  ]);
  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: second.runtime
  });
  const reconciled = await reopened.reconcile({ relationId });

  assert.equal(reconciled.state, "stopped");
  assert.equal(second.inspectCalls.length, 1);
  assert.equal(second.stopCalls.length, 0);
  assert.equal(typeof second.runtime.start, "undefined");
});

test("a different handle cannot replace the pending persisted handle", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-handle-conflict";
  const persistedHandle = handle(relationId, "1");
  const unknownHandle = {
    relationId,
    generation: "2",
    token: "unknown-new-token"
  };
  const first = makeRuntime([
    observation("running", persistedHandle)
  ], {
    stopError: new Error("stop unavailable")
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: first.runtime
  });
  const pending = await manager.disable({
    relationId,
    identity: identity("handle-conflict"),
    handle: persistedHandle,
    operationId: "operation-handle-conflict-first"
  });
  assert.equal(pending.state, "pending");
  assert.equal(pending.reason, "runtime_stop_failed");
  const original = await readFile(statePath, "utf8");

  await assert.rejects(
    () => manager.disable({
      relationId,
      identity: identity("handle-conflict"),
      handle: unknownHandle,
      operationId: "operation-handle-conflict-second"
    }),
    (error) => error?.code === "relation_file_service_handle_conflict"
  );

  assert.equal(await readFile(statePath, "utf8"), original);
  assert.equal(first.inspectCalls.length, 1);
  assert.equal(first.stopCalls.length, 1);

  const retry = makeRuntime([
    observation("stopped", persistedHandle)
  ]);
  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: retry.runtime
  });
  const reconciled = await reopened.reconcile({ relationId });

  assert.equal(reconciled.state, "stopped");
  assert.equal(reconciled.operationId, "operation-handle-conflict-first");
  assert.equal(retry.inspectCalls.length, 1);
  assert.equal(retry.inspectCalls[0].generation, persistedHandle.generation);
  assert.equal(retry.inspectCalls[0].token, persistedHandle.token);
  assert.equal(retry.stopCalls.length, 0);
});

test("corrupt JSON blocks open without overwriting the file", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const corrupt = "{not-json";
  await writeFile(statePath, corrupt, "utf8");
  const { runtime, inspectCalls, stopCalls } = makeRuntime();

  await assert.rejects(
    () => open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime
    }),
    (error) => error?.code === "relation_file_service_state_corrupt"
  );

  assert.equal(await readFile(statePath, "utf8"), corrupt);
  assert.equal(inspectCalls.length, 0);
  assert.equal(stopCalls.length, 0);
});

test("isolated operation schema corruption blocks open without overwriting the file", async (t) => {
  const root = await makeRoot(t);
  const seedPath = join(root, "seed.json");
  const { runtime: seedRuntime } = makeRuntime();
  await open({
    statePath: seedPath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: seedRuntime
  });
  const initialState = JSON.parse(await readFile(seedPath, "utf8"));
  const cases = [
    {
      name: "invalid operation id",
      operationId: "operation invalid",
      generation: "1",
      handleDigest: "a".repeat(64),
      phase: "pending"
    },
    {
      name: "invalid handle digest",
      operationId: "operation-invalid-digest",
      generation: "1",
      handleDigest: "not-a-digest",
      phase: "pending"
    },
    {
      name: "null generation with a digest",
      operationId: "operation-null-generation",
      generation: null,
      handleDigest: "a".repeat(64),
      phase: "pending"
    },
    {
      name: "generation without a digest",
      operationId: "operation-missing-digest",
      generation: "1",
      handleDigest: "",
      phase: "pending"
    },
    {
      name: "stopped without a handle",
      operationId: "operation-stopped-without-handle",
      generation: null,
      handleDigest: "",
      phase: "stopped"
    }
  ];

  for (const [index, invalidCase] of cases.entries()) {
    const statePath = join(root, `invalid-operation-${index}.json`);
    const state = structuredClone(initialState);
    state.operations[invalidCase.operationId] = {
      operationId: invalidCase.operationId,
      relationId: "relation-a",
      action: "disable",
      requestDigest: "b".repeat(64),
      phase: invalidCase.phase,
      reason: "",
      generation: invalidCase.generation,
      handleDigest: invalidCase.handleDigest,
      createdAt: initialState.createdAt,
      updatedAt: initialState.updatedAt
    };
    const raw = JSON.stringify(state, null, 2);
    await writeFile(statePath, raw, "utf8");
    const { runtime, inspectCalls, stopCalls } = makeRuntime();

    await assert.rejects(
      () => open({
        statePath,
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        runtime
      }),
      (error) => error?.code === "relation_file_service_state_invalid",
      invalidCase.name
    );

    assert.equal(await readFile(statePath, "utf8"), raw, invalidCase.name);
    assert.equal(inspectCalls.length, 0, invalidCase.name);
    assert.equal(stopCalls.length, 0, invalidCase.name);
  }
});

test("a valid persisted operation remains readable and reconcilable after reopen", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-historical-operation";
  const runtimeHandle = handle(relationId, "23");
  const first = makeRuntime([
    observation("running", runtimeHandle),
    observation("stopped", runtimeHandle)
  ]);
  const firstManager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: first.runtime
  });
  const stopped = await firstManager.disable({
    relationId,
    identity: identity("historical-operation"),
    handle: runtimeHandle,
    operationId: "operation-historical"
  });
  assert.equal(stopped.state, "stopped");

  const second = makeRuntime([
    observation("stopped", runtimeHandle)
  ]);
  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: second.runtime
  });
  const reconciled = await reopened.reconcile({ relationId });

  assert.equal(reconciled.state, "stopped");
  assert.equal(reconciled.operationId, "operation-historical");
  assert.equal(second.inspectCalls.length, 1);
  assert.equal(second.inspectCalls[0].token, runtimeHandle.token);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.operations["operation-historical"].phase, "stopped");
  assert.equal(state.relations[relationId].handle.token, runtimeHandle.token);
});

test("state write failure aborts disable before runtime stop", async (t) => {
  const root = await makeRoot(t);
  const sourcePath = join(root, "source.json");
  const { runtime: sourceRuntime } = makeRuntime();
  await open({
    statePath: sourcePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: sourceRuntime
  });
  const validState = await readFile(sourcePath, "utf8");

  const longStatePath = join(root, `${"s".repeat(235)}.json`);
  await writeFile(longStatePath, validState, "utf8");
  const relationId = "relation-write-failure";
  const runtimeHandle = handle(relationId);
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    observation("running", runtimeHandle)
  ]);
  const manager = await open({
    statePath: longStatePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });

  await assert.rejects(
    () => manager.disable({
      relationId,
      identity: identity("write-failure"),
      handle: runtimeHandle,
      operationId: "operation-write-failure"
    }),
    (error) => error?.code === "relation_file_service_state_write_failed"
  );

  assert.equal(inspectCalls.length, 0);
  assert.equal(stopCalls.length, 0);
  assert.equal(await readFile(longStatePath, "utf8"), validState);
});

test("missing and unknown runtime handles remain pending", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-unknown";
  const runtimeHandle = handle(relationId);
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    observation("unknown", runtimeHandle)
  ]);
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });

  const missing = await manager.disable({
    relationId: "relation-missing",
    identity: identity("missing"),
    operationId: "operation-missing"
  });
  assert.equal(missing.state, "pending");
  assert.equal(missing.reason, "runtime_handle_missing");

  const unknown = await manager.disable({
    relationId,
    identity: identity("unknown"),
    handle: runtimeHandle,
    operationId: "operation-unknown"
  });
  assert.equal(unknown.state, "pending");
  assert.equal(unknown.reason, "runtime_inspect_ambiguous");
  assert.equal(inspectCalls.length, 1);
  assert.equal(stopCalls.length, 0);
});

test("operationId is idempotent for identical parameters and rejects conflicts", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-idempotent";
  const runtimeHandle = handle(relationId);
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    observation("stopped", runtimeHandle)
  ]);
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });
  const request = {
    relationId,
    identity: identity("idempotent"),
    handle: runtimeHandle,
    operationId: "operation-idempotent"
  };

  const first = await manager.disable(request);
  const repeated = await manager.disable(request);
  assert.deepEqual(repeated, first);
  assert.equal(inspectCalls.length, 1);
  assert.equal(stopCalls.length, 0);

  await assert.rejects(
    () => manager.disable({
      ...request,
      handle: {
        ...runtimeHandle,
        token: "different-token"
      }
    }),
    (error) => error?.code === "relation_file_service_operation_conflict"
  );
});

test("a blocked relation does not hold the state lock while another relation proceeds", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const lock = makeLockHarness();
  const relationA = "relation-a";
  const relationB = "relation-b";
  const handleA = handle(relationA);
  const handleB = handle(relationB);
  let releaseA;
  let markAStarted;
  const aStarted = new Promise((resolve) => {
    markAStarted = resolve;
  });
  const aGate = new Promise((resolve) => {
    releaseA = resolve;
  });
  const runtime = {
    async inspect(runtimeHandle) {
      if (runtimeHandle.relationId === relationA) {
        markAStarted();
        await aGate;
      }
      return observation("stopped", runtimeHandle);
    },
    async stop() {
      return { ok: true };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: lock.withExclusiveLock,
    runtime
  });

  const pendingA = manager.disable({
    relationId: relationA,
    identity: identity("a"),
    handle: handleA,
    operationId: "operation-a"
  });
  await aStarted;
  assert.equal(lock.activeStateLocks, 0);

  const resultB = await manager.disable({
    relationId: relationB,
    identity: identity("b"),
    handle: handleB,
    operationId: "operation-b"
  });
  assert.equal(resultB.state, "stopped");
  assert.equal(lock.activeStateLocks, 0);

  releaseA();
  const resultA = await pendingA;
  assert.equal(resultA.state, "stopped");
  assert.equal(lock.maxActiveStateLocks, 1);
});

test("concurrent identical operationId for one relation performs one stop", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-concurrent-identical";
  const runtimeHandle = handle(relationId, "11");
  let releaseRunning;
  let markRunningStarted;
  const runningStarted = new Promise((resolve) => {
    markRunningStarted = resolve;
  });
  const runningGate = new Promise((resolve) => {
    releaseRunning = resolve;
  });
  let inspectCount = 0;
  let stopCount = 0;
  const runtime = {
    async inspect(observedHandle) {
      inspectCount += 1;
      if (inspectCount === 1) {
        markRunningStarted();
        await runningGate;
        return observation("running", observedHandle);
      }
      return observation("stopped", observedHandle);
    },
    async stop() {
      stopCount += 1;
      return { ok: true };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });
  const request = {
    relationId,
    identity: identity("concurrent-identical"),
    handle: runtimeHandle,
    operationId: "operation-concurrent-identical"
  };

  const first = manager.disable(request);
  await withTimeout(runningStarted);
  const second = manager.disable(request);
  await new Promise((resolve) => setImmediate(resolve));
  releaseRunning();
  const [firstResult, secondResult] = await withTimeout(Promise.all([first, second]));

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.state, "stopped");
  assert.equal(inspectCount, 2);
  assert.equal(stopCount, 1);
});

test("a new operation without a handle reuses the persisted trusted handle", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-preserved-handle";
  const runtimeHandle = handle(relationId, "17");
  const { runtime, inspectCalls, stopCalls } = makeRuntime([
    observation("running", runtimeHandle),
    observation("stopped", runtimeHandle)
  ], {
    stopError: new Error("stop failed before retry")
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime
  });

  const pending = await withTimeout(manager.disable({
    relationId,
    identity: identity("preserved-handle"),
    handle: runtimeHandle,
    operationId: "operation-preserved-first"
  }));
  assert.equal(pending.state, "pending");
  assert.equal(pending.reason, "runtime_stop_failed");

  const stopped = await withTimeout(manager.disable({
    relationId,
    identity: identity("preserved-handle"),
    operationId: "operation-preserved-second"
  }));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopCalls.length, 1);
  assert.equal(inspectCalls.length, 2);
  assert.equal(inspectCalls[1].token, runtimeHandle.token);
  assert.equal(inspectCalls[1].generation, runtimeHandle.generation);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].handle.token, runtimeHandle.token);
  assert.equal(state.relations[relationId].generation, runtimeHandle.generation);
  assert.equal(state.relations[relationId].operationId, "operation-preserved-second");
  assert.equal(state.relations[relationId].phase, "stopped");
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  return sha256(stableJson(value));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeDurableWriter(options = {}) {
  const calls = [];
  return {
    calls,
    durableWriter: {
      async write(request) {
        calls.push(structuredClone({
          expectedRevision: request.expectedRevision,
          attemptId: request.attemptId,
          state: request.state
        }));
        if (request.expectedRawSha256 != null) {
          let current;
          try {
            current = await readFile(request.statePath);
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
            current = Buffer.alloc(0);
          }
          if (sha256Bytes(current) !== request.expectedRawSha256) {
            return {
              outcome: "not_committed",
              stages: [],
              expectedRevision: request.expectedRevision,
              currentRevision: request.expectedRevision
            };
          }
        }
        const injected = options.outcomes?.[calls.length - 1];
        if (injected && injected !== "committed") {
          if (injected === "write_then_uncertain") {
            await writeFile(request.statePath, JSON.stringify(request.state, null, 2), "utf8");
          }
          return {
            outcome: injected === "write_then_uncertain" ? "commit_uncertain" : injected,
            stages: [],
            expectedRevision: request.expectedRevision,
            currentRevision: request.expectedRevision
          };
        }
        await writeFile(request.statePath, JSON.stringify(request.state, null, 2), "utf8");
        return {
          outcome: "committed",
          stages: ["parent_fsync_returned"],
          expectedRevision: request.expectedRevision
        };
      }
    }
  };
}

function runtimeIdentityFor(runtimeHandle, port = 41001) {
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
    tokenSha256: sha256(runtimeHandle.token),
    listener: {
      role: "expected",
      host: "127.0.0.1",
      port
    }
  };
}

function provisionalEvidence(now = new Date().toISOString()) {
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
    observedAt: now
  };
}

function runningEvidenceFor(runtimeHandle, runtimeIdentity, fence) {
  return {
    schemaVersion: "1",
    fenceDigest: digest(fence),
    handleDigest: digest(runtimeHandle),
    runtimeIdentityDigest: digest(runtimeIdentity),
    namespace: structuredClone(runtimeIdentity.namespace),
    process: structuredClone(runtimeIdentity.process),
    executable: structuredClone(runtimeIdentity.executable),
    tokenSha256: runtimeIdentity.tokenSha256,
    listener: {
      role: "observed",
      host: "127.0.0.1",
      port: runtimeIdentity.listener.port,
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
    observedAt: new Date().toISOString()
  };
}

function cleanupEvidenceFor(runtimeHandle, checkpoint = "go-pending", overrides = {}) {
  return {
    schemaVersion: "1",
    disposition: "confirmedStopped",
    lastRuntimeCheckpoint: checkpoint,
    runtimeInvoked: true,
    leaseReturned: true,
    continuationRegistered: true,
    latePrepare: "not-applicable",
    lateGo: "not-applicable",
    abortRequested: true,
    abortCompleted: true,
    containmentConfirmed: true,
    exactHandleIdentity: {
      relationId: runtimeHandle.relationId,
      generation: runtimeHandle.generation,
      handleDigest: digest(runtimeHandle)
    },
    processExited: true,
    listenerClosed: true,
    sessionsClosed: true,
    childrenExited: true,
    reasonCode: "cleanup_confirmed_stopped",
    ...overrides
  };
}

function unconfirmedCleanupEvidenceFor(runtimeHandle, checkpoint = "finalize-pending") {
  return cleanupEvidenceFor(runtimeHandle, checkpoint, {
    disposition: "unconfirmed",
    abortRequested: false,
    abortCompleted: false,
    containmentConfirmed: false,
    processExited: null,
    listenerClosed: null,
    sessionsClosed: null,
    childrenExited: null,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
  });
}

async function seedConfirmedStoppedRetry(t, relationId) {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 31)
  });
  const operationId = `operation-${relationId}-first`;
  await manager.start(startRequest(relationId, operationId));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const cleanupEvidence = cleanupEvidenceFor(fixture.handle, "finalize-pending");
  for (const record of [state.operations[operationId], state.relations[relationId]]) {
    record.phase = "start_failed";
    record.reason = "";
    record.cleanupRequired = false;
    record.commitUncertain = false;
    record.cleanupEvidence = structuredClone(cleanupEvidence);
  }
  state.revision += 1;
  state.updatedAt = new Date(Date.parse(state.updatedAt) + 1).toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return {
    root,
    statePath,
    relationId,
    operationId,
    state,
    fixture,
    expectedHandleDigest: state.relations[relationId].handleDigest
  };
}

function supersedingDisableState(state, relationId) {
  const next = structuredClone(state);
  const currentRelation = next.relations[relationId];
  const operationId = `operation-${relationId}-supersede`;
  const now = new Date(Date.parse(next.updatedAt) + 1).toISOString();
  const runtimeHandle = structuredClone(currentRelation.handle);
  const handleDigest = digest(runtimeHandle);
  const common = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    expectedHandleDigest: null,
    generation: currentRelation.generation,
    handleDigest,
    operationId,
    phase: "stopping",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "runtime_handle_missing",
    recordOrigin: "v2",
    relationId,
    requestDigest: "f".repeat(64),
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: now
  };
  next.operations[operationId] = {
    ...structuredClone(common),
    action: "disable",
    createdAt: now
  };
  next.relations[relationId] = {
    ...structuredClone(common),
    desired: "disabled",
    handle: runtimeHandle,
    identityDigest: currentRelation.identityDigest
  };
  next.revision += 1;
  next.updatedAt = now;
  return { state: next, operationId };
}

function makeStartRuntime(options = {}) {
  const relationId = options.relationId || "relation-start";
  const runtimeHandle = handle(relationId, options.generation || "1");
  const runtimeIdentity = runtimeIdentityFor(runtimeHandle, options.port || 41001);
  const calls = {
    prepare: [],
    go: [],
    abort: [],
    inspect: [],
    stop: []
  };
  return {
    handle: runtimeHandle,
    runtimeIdentity,
    calls,
    runtime: {
      async prepare(request, details) {
        calls.prepare.push({ request, details });
        if (options.prepare) {
          return options.prepare({ request, details, runtimeHandle, runtimeIdentity });
        }
        return {
          lease: { id: "lease-one" },
          handle: runtimeHandle,
          runtimeIdentity,
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        };
      },
      async go(lease, details) {
        calls.go.push({ lease, details });
        if (options.go) {
          return options.go({ lease, details });
        }
        return { ok: true };
      },
      async abort(lease, details) {
        calls.abort.push({ lease, details });
        if (options.abort) {
          return options.abort({ lease, details });
        }
        return { containmentConfirmed: true };
      },
      async inspect(runtimeHandleValue, details = {}) {
        calls.inspect.push({ handle: runtimeHandleValue, details });
        if (options.inspect) {
          return options.inspect({
            handle: runtimeHandleValue,
            details,
            runtimeIdentity
          });
        }
        if (details.purpose === "running") {
          return runningEvidenceFor(runtimeHandleValue, runtimeIdentity, details.fence);
        }
        if (details.purpose === "cleanup") {
          return cleanupEvidenceFor(runtimeHandleValue);
        }
        return observation("stopped", runtimeHandleValue);
      },
      async stop(runtimeHandleValue, details) {
        calls.stop.push({ handle: runtimeHandleValue, details });
        return { ok: true };
      }
    }
  };
}

function startRequest(relationId, operationId, overrides = {}) {
  return {
    relationId,
    operationId,
    identity: identity(relationId),
    expectedHandleDigest: "",
    launch: {
      target: "rclone-serve-sftp",
      listener: {
        host: "127.0.0.1",
        port: 41001
      }
    },
    ...overrides
  };
}

function makeProtection(digestValue = "c".repeat(64)) {
  const calls = [];
  return {
    calls,
    protection: {
      async verify(request) {
        calls.push(structuredClone({
          relationId: request.relationId,
          operationId: request.operationId,
          generation: request.generation,
          fence: request.fence
        }));
        return { digest: digestValue };
      }
    }
  };
}

async function waitForQuery(manager, relationId, predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await manager.query({ relationId });
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("query condition timed out");
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

test("start migrates V1 and durably reaches running with exact V2 schema", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-start-success";
  const fixture = makeStartRuntime({ relationId });
  const durable = makeDurableWriter();
  const protection = makeProtection();
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: durable.durableWriter,
    protection: protection.protection,
    randomBytes: () => Buffer.alloc(16, 7)
  });

  const result = await manager.start(startRequest(relationId, "operation-start-success"));
  assert.equal(result.state, "running");
  assert.equal(result.desired, "enabled");
  assert.equal(result.generation, "1");
  assert.match(result.handleDigest, /^[a-f0-9]{64}$/);
  assert.equal(durable.calls.length, 3);
  assert.equal(protection.calls.length, 1);
  assert.equal(fixture.calls.prepare.length, 1);
  assert.equal(fixture.calls.go.length, 1);
  assert.equal(fixture.calls.inspect[0].details.purpose, "running");

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.storageContract, RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT);
  assert.equal(state.relations[relationId].phase, "running");
  assert.equal(state.relations[relationId].desired, "enabled");
  assert.match(state.relations[relationId].runningEvidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(state.operations["operation-start-success"].recordOrigin, "v2");

  const snapshot = await manager.query({ relationId });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.storageMode, "v2-durable");
  assert.equal(snapshot.handlePresent, true);
  assert.equal(snapshot.runtimeIdentityPresent, true);
  assert.equal(snapshot.runningEvidencePresent, true);
  assert.equal(snapshot.cleanupEvidencePresent, false);
  assert.equal(snapshot.source, "manager-state");
  assert.equal(JSON.stringify(snapshot).includes(fixture.handle.token), false);
  assert.equal(JSON.stringify(snapshot).includes("launch"), false);
});

test("disabled relation cannot be restarted and blocked start leaves its exact ledger unchanged", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-disabled-restart-blocked";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 73)
  });

  const started = await manager.start(startRequest(relationId, "operation-disabled-restart-first"));
  const disabled = await manager.disable({
    relationId,
    identity: identity(relationId),
    handle: fixture.handle,
    operationId: "operation-disabled-restart-disable"
  });
  assert.equal(disabled.state, "stopped");
  assert.equal(disabled.desired, "disabled");
  const beforeQuery = await manager.query({ relationId });
  const beforeBytes = await readFile(statePath);
  const beforeState = JSON.parse(beforeBytes.toString("utf8"));
  assert.equal(beforeQuery.handleDigest, started.handleDigest);
  assert.equal(beforeQuery.handlePresent, true);
  assert.equal(beforeQuery.runtimeIdentityPresent, false);

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-disabled-restart-attempt", {
      expectedHandleDigest: started.handleDigest
    })),
    error => error?.code === "relation_file_service_start_blocked"
  );

  const afterQuery = await manager.query({ relationId });
  const afterBytes = await readFile(statePath);
  const afterState = JSON.parse(afterBytes.toString("utf8"));
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(afterState.revision, beforeState.revision);
  assert.deepEqual(afterQuery, beforeQuery);
  assert.equal(afterQuery.state, "stopped");
  assert.equal(afterQuery.desired, "disabled");
  assert.equal(afterQuery.handlePresent, true);
  assert.equal(afterQuery.handleDigest, started.handleDigest);
  assert.equal(afterQuery.runtimeIdentityPresent, false);
});

test("start idempotency uses stable JSON and rejects ambiguous request values", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-stable-json";
  const fixture = makeStartRuntime({ relationId });
  const durable = makeDurableWriter();
  const protection = makeProtection();
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: durable.durableWriter,
    protection: protection.protection,
    randomBytes: () => Buffer.alloc(16, 3)
  });
  const request = startRequest(relationId, "operation-stable-json", {
    launch: {
      b: [2, 1],
      a: "多字节",
      listener: {
        host: "127.0.0.1",
        port: 41001
      }
    }
  });
  const first = await manager.start(request);
  const reordered = {
    ...request,
    launch: {
      a: "多字节",
      b: [2, 1],
      listener: {
        host: "127.0.0.1",
        port: 41001
      }
    }
  };
  assert.deepEqual(await manager.start(reordered), first);
  assert.equal(fixture.calls.prepare.length, 1);

  await assert.rejects(
    () => manager.start({
      ...request,
      launch: {
        a: "多字节",
        b: [1, 2],
        listener: {
          host: "127.0.0.1",
          port: 41001
        }
      }
    }),
    (error) => error?.code === "relation_file_service_operation_conflict"
  );

  const invalidValues = [
    { value: undefined, label: "undefined" },
    { value: () => "not-json", label: "function" },
    { value: Symbol("not-json"), label: "symbol" },
    { value: 1n, label: "bigint" },
    { value: -0, label: "negative zero" },
    { value: Number.POSITIVE_INFINITY, label: "nonfinite" },
    { value: String.fromCharCode(0xd800), label: "lone surrogate" }
  ];
  for (const [index, invalid] of invalidValues.entries()) {
    await assert.rejects(
      () => manager.start(startRequest(
        `relation-invalid-${index}`,
        `operation-invalid-${index}`,
        {
          launch: {
            listener: {
              host: "127.0.0.1",
              port: 41001
            },
            invalid: invalid.value
          }
        }
      )),
      (error) => error?.code === "relation_file_service_request_invalid",
      invalid.label
    );
  }
  const sparse = [];
  sparse.length = 1;
  await assert.rejects(
    () => manager.start(startRequest(
      "relation-invalid-sparse",
      "operation-invalid-sparse",
      {
        launch: {
          listener: {
            host: "127.0.0.1",
            port: 41001
          },
          sparse
        }
      }
    )),
    (error) => error?.code === "relation_file_service_request_invalid"
  );
  const cyclic = {
    listener: {
      host: "127.0.0.1",
      port: 41001
    }
  };
  cyclic.self = cyclic;
  await assert.rejects(
    () => manager.start(startRequest(
      "relation-invalid-cyclic",
      "operation-invalid-cyclic",
      { launch: cyclic }
    )),
    (error) => error?.code === "relation_file_service_request_invalid"
  );
});

test("generation allocation uses consumed BigInt history and blocks noncanonical history", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-generation";
  const initialFixture = makeStartRuntime({ relationId: "seed" });
  await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: initialFixture.runtime
  });
  const seeded = JSON.parse(await readFile(statePath, "utf8"));
  const historicalGeneration = "900719925474099312345";
  seeded.operations["operation-history"] = {
    operationId: "operation-history",
    relationId,
    action: "disable",
    requestDigest: "d".repeat(64),
    phase: "pending",
    reason: "runtime_handle_missing",
    generation: historicalGeneration,
    handleDigest: "e".repeat(64),
    createdAt: seeded.createdAt,
    updatedAt: seeded.updatedAt
  };
  await writeFile(statePath, JSON.stringify(seeded, null, 2), "utf8");

  const fixture = makeStartRuntime({
    relationId,
    generation: "900719925474099312346"
  });
  const durable = makeDurableWriter();
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: durable.durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 4)
  });
  const result = await manager.start(startRequest(relationId, "operation-generation"));
  assert.equal(result.generation, "900719925474099312346");

  const secondPath = join(root, "relation-noncanonical.json");
  const seed = JSON.parse(await readFile(statePath, "utf8"));
  const noncanonical = structuredClone(seed);
  noncanonical.version = 1;
  noncanonical.storageContract = RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT;
  noncanonical.relations = {};
  noncanonical.operations = {
    "operation-noncanonical": {
      operationId: "operation-noncanonical",
      relationId: "relation-noncanonical",
      action: "disable",
      requestDigest: "f".repeat(64),
      phase: "pending",
      reason: "runtime_handle_missing",
      generation: "01",
      handleDigest: "a".repeat(64),
      createdAt: seeded.createdAt,
      updatedAt: seeded.updatedAt
    }
  };
  await writeFile(secondPath, JSON.stringify(noncanonical, null, 2), "utf8");
  const blocked = await open({
    statePath: secondPath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: makeStartRuntime({ relationId: "relation-noncanonical" }).runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  await assert.rejects(
    () => blocked.start(startRequest("relation-noncanonical", "operation-blocked")),
    (error) => error?.code === "relation_file_service_generation_history_noncanonical"
  );
  const snapshot = await blocked.query({ relationId: "relation-noncanonical" });
  assert.equal(snapshot.generationAllocatable, false);
  const disabled = await blocked.disable({
    relationId: "relation-noncanonical",
    identity: identity("noncanonical"),
    handle: handle("relation-noncanonical", "2"),
    operationId: "operation-noncanonical-disable"
  });
  assert.equal(disabled.state, "stopped");
});

test("prepare timeout records late lease and internal recovery reaches start_failed", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-prepare";
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const fixture = makeStartRuntime({
    relationId,
    prepare: async ({ details, runtimeHandle, runtimeIdentity }) => {
      await prepareGate;
      return {
        lease: { id: "late-lease" },
        handle: runtimeHandle,
        runtimeIdentity,
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    }
  });
  const durable = makeDurableWriter();
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: durable.durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 5),
    runtimeTimeoutMs: 10
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-prepare")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  const blocked = await manager.query({ relationId });
  assert.equal(blocked.state, "cleanup_required");
  assert.equal(blocked.cleanupRequired, true);
  assert.equal(blocked.cleanupEvidencePresent, true);

  releasePrepare();
  const recovered = await waitForQuery(
    manager,
    relationId,
    (snapshot) => snapshot.state === "start_failed"
  );
  assert.equal(recovered.cleanupRequired, false);
  assert.equal(recovered.handlePresent, true);
  assert.equal(recovered.runningEvidencePresent, false);
  assert.equal(fixture.calls.abort.length, 1);
  assert.ok(fixture.calls.inspect.some((call) => call.details.purpose === "cleanup"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].cleanupEvidence.disposition, "confirmedStopped");
});

test("confirmed protection rejection persists retryable start_failed with no runtime invocation", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-protection-rejected";
  const fixture = makeStartRuntime({ relationId, generation: "2" });
  let protectionCalls = 0;
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      async verify() {
        protectionCalls += 1;
        if (protectionCalls === 1) {
          const error = new Error("Root protection helper rejected the operation");
          error.code = "root_protection_helper_failed";
          error.helperCode = "set_flags_failed";
          error.settlement = "confirmed";
          throw error;
        }
        return { digest: "c".repeat(64) };
      }
    }
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-protection-rejected")),
    error => error?.code === "relation_file_service_start_blocked"
  );
  const failed = await manager.query({ relationId });
  assert.equal(failed.state, "start_failed");
  assert.equal(failed.cleanupRequired, false);
  assert.equal(failed.cleanupEvidencePresent, true);
  let state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].cleanupEvidence.disposition, "notInvoked");
  assert.equal(fixture.calls.prepare.length, 0);

  const retried = await manager.start(startRequest(relationId, "operation-protection-retry"));
  assert.equal(retried.state, "running");
  assert.equal(protectionCalls, 2);
  assert.equal(fixture.calls.prepare.length, 1);
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].phase, "running");
});

test("prepared write failure reclaims the exact prepared handle", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-prepared-write-failure";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter({
      outcomes: ["committed", "failed"]
    }).durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 21)
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-prepared-write-failure")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  const recovered = await waitForQuery(
    manager,
    relationId,
    (snapshot) => snapshot.state === "start_failed"
  );
  assert.equal(recovered.handlePresent, true);
  assert.ok(fixture.calls.abort.length >= 1);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].handle.token, fixture.handle.token);
  assert.equal(
    state.relations[relationId].cleanupEvidence.exactHandleIdentity.handleDigest,
    digest(fixture.handle)
  );
});

test("late prepare recovery never overwrites a superseding disable operation", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-prepare-superseded";
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const fixture = makeStartRuntime({
    relationId,
    prepare: async ({ details, runtimeHandle, runtimeIdentity }) => {
      await prepareGate;
      return {
        lease: { id: "superseded-lease" },
        handle: runtimeHandle,
        runtimeIdentity,
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    }
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 15),
    runtimeTimeoutMs: 10
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-superseded-start")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  const disabled = await manager.disable({
    relationId,
    identity: identity(relationId),
    operationId: "operation-superseding-disable"
  });
  assert.equal(disabled.state, "pending");
  const before = JSON.parse(await readFile(statePath, "utf8"));

  releasePrepare();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(after.revision, before.revision);
  assert.equal(after.relations[relationId].operationId, "operation-superseding-disable");
  assert.equal(after.relations[relationId].desired, "disabled");
  assert.equal(after.relations[relationId].phase, "pending");
  assert.ok(fixture.calls.abort.length >= 1);
});

test("late go cannot publish running after timeout", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-go";
  let releaseGo;
  const goGate = new Promise((resolve) => {
    releaseGo = resolve;
  });
  const fixture = makeStartRuntime({
    relationId,
    go: async () => {
      await goGate;
      return { ok: true, listenerOpened: true };
    }
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 16),
    runtimeTimeoutMs: 10
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-go")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  releaseGo();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const snapshot = await manager.query({ relationId });
  assert.notEqual(snapshot.state, "running");
  assert.equal(snapshot.state, "start_failed");
  assert.equal(fixture.calls.go.length, 1);
  assert.ok(fixture.calls.abort.length >= 1);
});

test("late abort rejection keeps cleanup_required", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-abort";
  let releaseAbort;
  const abortGate = new Promise((resolve, reject) => {
    releaseAbort = reject;
  });
  const fixture = makeStartRuntime({
    relationId,
    go: async () => {
      throw new Error("go rejected before listener");
    },
    abort: async () => abortGate
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 17),
    runtimeTimeoutMs: 10
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-abort")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  releaseAbort(new Error("token secret /absolute/path late abort"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const snapshot = await manager.query({ relationId });
  assert.equal(snapshot.state, "cleanup_required");
  assert.equal(snapshot.cleanupRequired, true);
  assert.equal(JSON.stringify(snapshot).includes("token secret"), false);
  assert.equal(fixture.calls.abort.length, 1);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const evidence = state.relations[relationId].cleanupEvidence;
  assert.equal(evidence.abortRequested, true);
  assert.equal(evidence.abortCompleted, false);
  assert.equal(evidence.containmentConfirmed, false);
  assert.equal(evidence.continuationRegistered, true);
  assert.equal(evidence.reasonCode, "relation_file_service_runtime_cleanup_unconfirmed");
});

test("cleanup inspection rejects each incomplete containment field", async (t) => {
  const cases = [
    ["processExited", { processExited: false }],
    ["listenerClosed", { listenerClosed: false }],
    ["sessionsClosed", { sessionsClosed: false }],
    ["childrenExited", { childrenExited: false }],
    ["containmentConfirmed", { containmentConfirmed: false }],
    ["abortCompleted", { abortCompleted: false }],
    ["reasonCode", { reasonCode: "relation_file_service_runtime_cleanup_unconfirmed" }],
    ["handle generation", {
      exactHandleIdentity: {
        relationId: "relation-cleanup-field",
        generation: "2",
        handleDigest: "a".repeat(64)
      }
    }]
  ];
  for (const [name, overrides] of cases) {
    const root = await makeRoot(t);
    const statePath = join(root, `cleanup-${name.replaceAll(" ", "-")}.json`);
    const relationId = "relation-cleanup-field";
    let releasePrepare;
    const prepareGate = new Promise((resolve) => {
      releasePrepare = resolve;
    });
    const fixture = makeStartRuntime({
      relationId,
      prepare: async ({ details, runtimeHandle, runtimeIdentity }) => {
        await prepareGate;
        return {
          lease: { id: `lease-${name}` },
          handle: runtimeHandle,
          runtimeIdentity,
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        };
      },
      inspect: async ({ handle: observedHandle, details }) => (
        details.purpose === "cleanup"
          ? cleanupEvidenceFor(observedHandle, "prepare-pending", overrides)
          : observation("stopped", observedHandle)
      )
    });
    const manager = await open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      randomBytes: () => Buffer.alloc(16, 18),
      runtimeTimeoutMs: 10
    });
    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-${name.replaceAll(" ", "-")}`)),
      (error) => error?.code === "relation_file_service_runtime_timeout"
    );
    releasePrepare();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const snapshot = await manager.query({ relationId });
    assert.equal(snapshot.state, "cleanup_required", name);
    assert.equal(snapshot.cleanupRequired, true, name);
  }
});

test("late prepare rejection stays cleanup_required and never infers no process", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-prepare-rejected";
  let rejectPrepare;
  const prepareGate = new Promise((resolve, reject) => {
    rejectPrepare = reject;
  });
  const fixture = makeStartRuntime({
    relationId,
    prepare: async () => {
      await prepareGate;
    }
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 6),
    runtimeTimeoutMs: 10
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-prepare-rejected")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  rejectPrepare(new Error("token secret /absolute/path launch raw exception"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const snapshot = await manager.query({ relationId });
  assert.equal(snapshot.state, "cleanup_required");
  assert.equal(snapshot.cleanupRequired, true);
  assert.equal(snapshot.reason, "relation_file_service_late_prepare_rejected");
  assert.equal(JSON.stringify(snapshot).includes("token secret"), false);
});

test("query uses only the state lock and performs no runtime or protection calls", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const fixture = makeStartRuntime({ relationId: "relation-query" });
  const protection = makeProtection();
  const lock = makeLockHarness();
  const manager = await open({
    statePath,
    withExclusiveLock: lock.withExclusiveLock,
    runtime: fixture.runtime,
    protection: protection.protection
  });
  lock.scopes.length = 0;

  const snapshot = await manager.query({ relationId: "relation-query" });
  assert.equal(snapshot.state, "absent");
  assert.equal(snapshot.storageMode, "v1-legacy");
  assert.deepEqual(lock.scopes, ["state"]);
  assert.equal(Object.values(fixture.calls).every((calls) => calls.length === 0), true);
  assert.equal(protection.calls.length, 0);
});

test("query waits for atomic rename and returns one complete visible snapshot", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-query-rename";
  const fixture = makeStartRuntime({ relationId });
  let releaseRename;
  let renameStarted;
  const renameGate = new Promise((resolve) => {
    releaseRename = resolve;
  });
  const renameReached = new Promise((resolve) => {
    renameStarted = resolve;
  });
  let releaseProtection;
  const protectionGate = new Promise((resolve) => {
    releaseProtection = resolve;
  });
  const durableWriter = {
    async write(request) {
      const tempPath = `${request.statePath}.${request.attemptId}.probe.tmp`;
      await writeFile(tempPath, JSON.stringify(request.state, null, 2), "utf8");
      renameStarted();
      await renameGate;
      await rename(tempPath, request.statePath);
      return {
        outcome: "committed",
        stages: [
          "file_fsync_returned",
          "file_close_returned",
          "rename_returned",
          "parent_fsync_returned"
        ],
        expectedRevision: request.expectedRevision
      };
    }
  };
  const protection = {
    async verify() {
      await protectionGate;
      return { digest: "c".repeat(64) };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter,
    protection,
    randomBytes: () => Buffer.alloc(16, 20)
  });

  const startPromise = manager.start(startRequest(relationId, "operation-query-rename"));
  await renameReached;
  let querySettled = false;
  const queryPromise = manager.query({ relationId }).then((snapshot) => {
    querySettled = true;
    return snapshot;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(querySettled, false);
  releaseRename();
  const snapshot = await queryPromise;
  assert.equal(snapshot.state, "starting");
  assert.equal(snapshot.storageMode, "v2-durable");

  releaseProtection();
  const result = await startPromise;
  assert.equal(result.state, "running");
});

test("prepare listener mismatch aborts its returned lease and stays cleanup_required", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-listener-mismatch";
  const fixture = makeStartRuntime({ relationId, port: 41002 });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 8)
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-listener-mismatch")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  const snapshot = await manager.query({ relationId });
  assert.equal(snapshot.state, "cleanup_required");
  assert.equal(snapshot.cleanupRequired, true);
  assert.equal(snapshot.runtimeIdentityPresent, false);
  assert.equal(fixture.calls.go.length, 0);
  assert.equal(fixture.calls.abort.length, 1);
  assert.deepEqual(
    fixture.calls.abort[0].details.fence,
    fixture.calls.prepare[0].details.fence
  );
});

test("runtime identity must bind the target parent to the manager", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-parent-mismatch";
  const fixture = makeStartRuntime({ relationId });
  fixture.runtimeIdentity.process.parentPid = "999";
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 22)
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-parent-mismatch")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  const snapshot = await manager.query({ relationId });
  assert.equal(snapshot.state, "cleanup_required");
  assert.equal(fixture.calls.go.length, 0);
});

test("start_failed confirmedStopped may preserve only historical running evidence", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-historical-running";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 9)
  });
  await manager.start(startRequest(relationId, "operation-historical-running"));

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const operation = state.operations["operation-historical-running"];
  const relation = state.relations[relationId];
  const cleanupEvidence = cleanupEvidenceFor(fixture.handle, "finalize-pending");
  for (const record of [operation, relation]) {
    record.phase = "start_failed";
    record.reason = "";
    record.cleanupRequired = false;
    record.commitUncertain = false;
    record.cleanupEvidence = structuredClone(cleanupEvidence);
  }
  assert.match(relation.runningEvidenceDigest, /^[a-f0-9]{64}$/);
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  const snapshot = await reopened.query({ relationId });
  assert.equal(snapshot.state, "start_failed");
  assert.equal(snapshot.runningEvidencePresent, true);
  assert.equal(snapshot.cleanupEvidencePresent, true);

  const invalid = structuredClone(state);
  invalid.operations["operation-historical-running"].cleanupEvidence.disposition = "unconfirmed";
  invalid.relations[relationId].cleanupEvidence.disposition = "unconfirmed";
  await writeFile(statePath, JSON.stringify(invalid, null, 2), "utf8");
  await assert.rejects(
    () => open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection
    }),
    (error) => error?.code === "relation_file_service_state_invalid"
  );
});

test("confirmedStopped retry reserves the next generation after exact cleanup reinspection", async (t) => {
  const seeded = await seedConfirmedStoppedRetry(t, "relation-confirmed-retry");
  const lock = makeLockHarness();
  const retryFixture = makeStartRuntime({
    relationId: seeded.relationId,
    generation: "2"
  });
  const reopened = await open({
    statePath: seeded.statePath,
    withExclusiveLock: lock.withExclusiveLock,
    runtime: retryFixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 32)
  });
  const retryOperationId = "operation-confirmed-retry-second";
  const result = await reopened.start(startRequest(
    seeded.relationId,
    retryOperationId,
    { expectedHandleDigest: seeded.expectedHandleDigest }
  ));

  assert.equal(result.state, "running");
  assert.equal(result.generation, "2");
  assert.equal(retryFixture.calls.inspect.filter(
    (call) => call.details.purpose === "cleanup"
  ).length, 1);
  assert.equal(lock.activeStateLocks, 0);

  const state = JSON.parse(await readFile(seeded.statePath, "utf8"));
  assert.equal(state.operations[seeded.operationId].phase, "start_failed");
  assert.equal(state.operations[seeded.operationId].cleanupEvidence.disposition,
    "confirmedStopped");
  assert.equal(state.operations[retryOperationId].phase, "running");
  assert.equal(state.operations[retryOperationId].generation, "2");
  assert.equal(state.relations[seeded.relationId].operationId, retryOperationId);
  assert.equal(state.relations[seeded.relationId].generation, "2");
  assert.equal(state.relations[seeded.relationId].expectedHandleDigest,
    seeded.expectedHandleDigest);
});

test("confirmedStopped retry rejects incomplete cleanup reinspection without mutation", async (t) => {
  const seeded = await seedConfirmedStoppedRetry(t, "relation-rejected-reinspect");
  const retryFixture = makeStartRuntime({
    relationId: seeded.relationId,
    generation: "2",
    inspect: ({ handle: observedHandle, details }) => (
      details.purpose === "cleanup"
        ? cleanupEvidenceFor(observedHandle, "finalize-pending", {
          processExited: false
        })
        : observation("unknown", observedHandle)
    )
  });
  const reopened = await open({
    statePath: seeded.statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: retryFixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });

  await assert.rejects(
    () => reopened.start(startRequest(
      seeded.relationId,
      "operation-rejected-reinspect",
      { expectedHandleDigest: seeded.expectedHandleDigest }
    )),
    (error) => error?.code === "relation_file_service_start_blocked"
      && error.publicMessage === "Previous runtime cleanup could not be re-confirmed"
  );
  const state = JSON.parse(await readFile(seeded.statePath, "utf8"));
  assert.equal(state.operations["operation-rejected-reinspect"], undefined);
  assert.equal(state.relations[seeded.relationId].operationId, seeded.operationId);
  assert.equal(state.relations[seeded.relationId].phase, "start_failed");
  assert.equal(retryFixture.calls.prepare.length, 0);
});

test("confirmedStopped retry fails closed when external state bytes change before reservation", async (t) => {
  const seeded = await seedConfirmedStoppedRetry(t, "relation-changed-reinspect");
  const retryFixture = makeStartRuntime({
    relationId: seeded.relationId,
    generation: "2",
    inspect: async ({ handle: observedHandle, details }) => {
      const evidence = cleanupEvidenceFor(observedHandle, "finalize-pending");
      if (details.purpose === "cleanup") {
        const changed = structuredClone(seeded.state);
        for (const record of [
          changed.operations[seeded.operationId],
          changed.relations[seeded.relationId]
        ]) {
          record.cleanupEvidence.lastRuntimeCheckpoint = "inspect-ready";
        }
        changed.revision += 1;
        changed.updatedAt = new Date(Date.parse(changed.updatedAt) + 1).toISOString();
        await writeFile(seeded.statePath, JSON.stringify(changed, null, 2), "utf8");
      }
      return evidence;
    }
  });
  const reopened = await open({
    statePath: seeded.statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: retryFixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });

  await assert.rejects(
    () => reopened.start(startRequest(
      seeded.relationId,
      "operation-changed-reinspect",
      { expectedHandleDigest: seeded.expectedHandleDigest }
    )),
    (error) => error?.code === "relation_file_service_state_revision_conflict"
  );
  const state = JSON.parse(await readFile(seeded.statePath, "utf8"));
  assert.equal(state.operations["operation-changed-reinspect"], undefined);
  assert.equal(
    state.relations[seeded.relationId].cleanupEvidence.lastRuntimeCheckpoint,
    "inspect-ready"
  );
  assert.equal(retryFixture.calls.prepare.length, 0);
});

test("invalid prepare identity aborts the returned opaque lease outside the state lock", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-invalid-prepare";
  const lock = makeLockHarness();
  const fixture = makeStartRuntime({ relationId });
  fixture.runtimeIdentity.listener.port = 41099;
  const manager = await open({
    statePath,
    withExclusiveLock: lock.withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 33)
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-invalid-prepare")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  assert.equal(fixture.calls.go.length, 0);
  assert.equal(fixture.calls.inspect.length, 0);
  assert.equal(fixture.calls.abort.length, 1);
  assert.deepEqual(
    fixture.calls.abort[0].details.fence,
    fixture.calls.prepare[0].details.fence
  );
  assert.equal(lock.activeStateLocks, 0);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const record = state.relations[relationId];
  assert.equal(record.phase, "cleanup_required");
  assert.equal(record.cleanupRequired, true);
  assert.equal(record.cleanupEvidence.disposition, "unconfirmed");
  assert.equal(record.cleanupEvidence.leaseReturned, true);
  assert.equal(record.cleanupEvidence.abortRequested, true);
  assert.equal(record.cleanupEvidence.abortCompleted, true);
  assert.equal(record.cleanupEvidence.exactHandleIdentity, null);
});

test("falsy non-null opaque leases survive immediate invalid prepare abort exactly once", async (t) => {
  for (const [name, lease] of [
    ["zero", 0],
    ["false", false],
    ["empty-string", ""]
  ]) {
    const root = await makeRoot(t);
    const statePath = join(root, `invalid-prepare-${name}.json`);
    const relationId = `relation-invalid-prepare-${name}`;
    const lock = makeLockHarness();
    let abortStateLocks = null;
    const fixture = makeStartRuntime({
      relationId,
      prepare: ({ details, runtimeHandle, runtimeIdentity }) => {
        const invalidIdentity = structuredClone(runtimeIdentity);
        invalidIdentity.listener.port = 41099;
        return {
          lease,
          handle: runtimeHandle,
          runtimeIdentity: invalidIdentity,
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        };
      },
      abort: async () => {
        abortStateLocks = lock.activeStateLocks;
        return { containmentConfirmed: true };
      }
    });
    const manager = await open({
      statePath,
      withExclusiveLock: lock.withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      randomBytes: () => Buffer.alloc(16, 39)
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-invalid-${name}`)),
      (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
    );
    assert.equal(fixture.calls.abort.length, 1, name);
    assert.ok(Object.is(fixture.calls.abort[0].lease, lease), name);
    assert.deepEqual(
      fixture.calls.abort[0].details.fence,
      fixture.calls.prepare[0].details.fence,
      name
    );
    assert.equal(fixture.calls.inspect.length, 0, name);
    assert.equal(fixture.calls.go.length, 0, name);
    assert.equal(abortStateLocks, 0, name);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    const evidence = state.relations[relationId].cleanupEvidence;
    assert.equal(evidence.disposition, "unconfirmed", name);
    assert.equal(evidence.leaseReturned, true, name);
    assert.equal(evidence.abortRequested, true, name);
    assert.equal(evidence.abortCompleted, true, name);
    assert.equal(evidence.exactHandleIdentity, null, name);
  }
});

test("null and undefined leases remain no-lease for immediate and late invalid prepare", async (t) => {
  for (const timing of ["immediate", "late"]) {
    for (const [name, lease] of [
      ["null", null],
      ["undefined", undefined]
    ]) {
      const root = await makeRoot(t);
      const statePath = join(root, `${timing}-${name}.json`);
      const relationId = `relation-invalid-${timing}-${name}`;
      let deliverPrepare;
      const fixture = makeStartRuntime({
        relationId,
        prepare: ({ details, runtimeHandle, runtimeIdentity }) => {
          const invalidIdentity = structuredClone(runtimeIdentity);
          invalidIdentity.listener.port = 41099;
          const prepared = {
            lease,
            handle: runtimeHandle,
            runtimeIdentity: invalidIdentity,
            provisionalEvidence: provisionalEvidence(),
            fence: details.fence
          };
          if (timing === "immediate") {
            return prepared;
          }
          return new Promise((resolve) => {
            deliverPrepare = () => resolve(prepared);
          });
        }
      });
      const manager = await open({
        statePath,
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        runtime: fixture.runtime,
        durableWriter: makeDurableWriter().durableWriter,
        protection: makeProtection().protection,
        runtimeTimeoutMs: 10
      });

      if (timing === "immediate") {
        await assert.rejects(
          () => manager.start(startRequest(relationId, `operation-${timing}-${name}`)),
          (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
        );
      } else {
        await assert.rejects(
          () => manager.start(startRequest(relationId, `operation-${timing}-${name}`)),
          (error) => error?.code === "relation_file_service_runtime_timeout"
        );
        deliverPrepare();
        await waitForQuery(
          manager,
          relationId,
          (value) => value.reason === "relation_file_service_late_prepare_invalid"
        );
      }

      assert.equal(fixture.calls.abort.length, 0, `${timing}-${name}`);
      assert.equal(fixture.calls.inspect.length, 0, `${timing}-${name}`);
      assert.equal(fixture.calls.go.length, 0, `${timing}-${name}`);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const evidence = state.relations[relationId].cleanupEvidence;
      assert.equal(evidence.leaseReturned, false, `${timing}-${name}`);
      assert.equal(evidence.abortRequested, false, `${timing}-${name}`);
      assert.equal(evidence.abortCompleted, false, `${timing}-${name}`);
    }
  }
});

test("invalid prepare opaque lease abort rejection and timeout remain cleanup_required", async (t) => {
  for (const [name, abort] of [
    ["rejected", async () => {
      throw new Error("opaque lease abort rejected");
    }],
    ["timeout-fulfilled", null],
    ["timeout-rejected", null]
  ]) {
    const isTimeout = name.startsWith("timeout");
    let settleAbort;
    const root = await makeRoot(t);
    const statePath = join(root, `invalid-prepare-${name}.json`);
    const relationId = `relation-invalid-prepare-${name}`;
    const lock = makeLockHarness();
    let abortStateLocks = null;
    const fixture = makeStartRuntime({
      relationId,
      abort: async () => {
        abortStateLocks = lock.activeStateLocks;
        if (isTimeout) {
          return new Promise((resolve, reject) => {
            settleAbort = { resolve, reject };
          });
        }
        return abort();
      }
    });
    fixture.runtimeIdentity.listener.port = 41099;
    const manager = await open({
      statePath,
      withExclusiveLock: lock.withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      runtimeTimeoutMs: 20
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-invalid-${name}`)),
      (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
    );
    assert.equal(fixture.calls.abort.length, 1, name);
    assert.equal(abortStateLocks, 0, name);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const record = state.relations[relationId];
    assert.equal(record.phase, "cleanup_required", name);
    assert.equal(record.cleanupRequired, true, name);
    assert.equal(record.cleanupEvidence.continuationRegistered, isTimeout, name);
    if (isTimeout) {
      if (name === "timeout-fulfilled") {
        settleAbort.resolve({ containmentConfirmed: true });
      } else {
        settleAbort.reject(new Error("invalid prepare timeout rejected"));
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(fixture.calls.abort.length, 1, name);
      const settledState = JSON.parse(await readFile(statePath, "utf8"));
      const settledEvidence = settledState.relations[relationId].cleanupEvidence;
      assert.equal(
        settledEvidence.abortCompleted,
        name === "timeout-fulfilled",
        name
      );
      assert.equal(
        settledEvidence.containmentConfirmed,
        name === "timeout-fulfilled",
        name
      );
      assert.equal(
        settledEvidence.reasonCode,
        "relation_file_service_runtime_cleanup_unconfirmed",
        name
      );
    }
  }
});

test("late invalid prepare aborts its opaque lease for success rejection and timeout", async (t) => {
  for (const [name, abort] of [
    ["fulfilled", async () => ({ containmentConfirmed: true })],
    ["rejected", async () => {
      throw new Error("late invalid prepare abort rejected");
    }],
    ["timeout-fulfilled", null],
    ["timeout-rejected", null]
  ]) {
    const isTimeout = name.startsWith("timeout");
    let settleAbort;
    const root = await makeRoot(t);
    const statePath = join(root, `late-invalid-prepare-${name}.json`);
    const relationId = `relation-late-invalid-prepare-${name}`;
    const lock = makeLockHarness();
    let deliverPrepare;
    let abortStateLocks = null;
    const fixture = makeStartRuntime({
      relationId,
      prepare: ({ details, runtimeHandle, runtimeIdentity }) => new Promise((resolve) => {
        const invalidIdentity = structuredClone(runtimeIdentity);
        invalidIdentity.listener.port = 41099;
        deliverPrepare = () => resolve({
          lease: { id: `late-invalid-${name}` },
          handle: runtimeHandle,
          runtimeIdentity: invalidIdentity,
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        });
      }),
      abort: async () => {
        abortStateLocks = lock.activeStateLocks;
        if (isTimeout) {
          return new Promise((resolve, reject) => {
            settleAbort = { resolve, reject };
          });
        }
        return abort();
      }
    });
    const manager = await open({
      statePath,
      withExclusiveLock: lock.withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      runtimeTimeoutMs: 10
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-late-invalid-${name}`)),
      (error) => error?.code === "relation_file_service_runtime_timeout"
    );
    deliverPrepare();
    const snapshot = await waitForQuery(
      manager,
      relationId,
      (value) => value.reason === "relation_file_service_late_prepare_invalid"
    );
    assert.equal(snapshot.state, "cleanup_required", name);
    assert.equal(snapshot.cleanupRequired, true, name);
    assert.equal(fixture.calls.go.length, 0, name);
    assert.equal(fixture.calls.inspect.length, 0, name);
    assert.equal(fixture.calls.abort.length, 1, name);
    assert.equal(abortStateLocks, 0, name);
    assert.deepEqual(
      fixture.calls.abort[0].details.fence,
      fixture.calls.prepare[0].details.fence,
      name
    );

    const state = JSON.parse(await readFile(statePath, "utf8"));
    const evidence = state.relations[relationId].cleanupEvidence;
    assert.equal(evidence.disposition, "unconfirmed", name);
    assert.equal(evidence.latePrepare, "invalid", name);
    assert.equal(evidence.leaseReturned, true, name);
    assert.equal(evidence.exactHandleIdentity, null, name);
    assert.equal(evidence.abortRequested, true, name);
    assert.equal(evidence.abortCompleted, name === "fulfilled", name);
    assert.equal(evidence.containmentConfirmed, name === "fulfilled", name);
    assert.equal(evidence.continuationRegistered, isTimeout, name);
    if (isTimeout) {
      if (name === "timeout-fulfilled") {
        settleAbort.resolve({ containmentConfirmed: true });
      } else {
        settleAbort.reject(new Error("late invalid prepare timeout rejected"));
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(fixture.calls.abort.length, 1, name);
      assert.equal(fixture.calls.inspect.length, 0, name);
      const settledState = JSON.parse(await readFile(statePath, "utf8"));
      const settledEvidence = settledState.relations[relationId].cleanupEvidence;
      assert.equal(
        settledEvidence.abortCompleted,
        name === "timeout-fulfilled",
        name
      );
      assert.equal(
        settledEvidence.containmentConfirmed,
        name === "timeout-fulfilled",
        name
      );
      assert.equal(
        settledEvidence.reasonCode,
        "relation_file_service_runtime_cleanup_unconfirmed",
        name
      );
    }
  }
});

test("falsy non-null opaque leases survive late invalid prepare recovery exactly once", async (t) => {
  for (const [name, lease] of [
    ["zero", 0],
    ["false", false],
    ["empty-string", ""]
  ]) {
    const root = await makeRoot(t);
    const statePath = join(root, `late-invalid-${name}.json`);
    const relationId = `relation-late-invalid-${name}`;
    const lock = makeLockHarness();
    let deliverPrepare;
    let settleAbort;
    let abortStateLocks = null;
    const fixture = makeStartRuntime({
      relationId,
      prepare: ({ details, runtimeHandle, runtimeIdentity }) => new Promise((resolve) => {
        const invalidIdentity = structuredClone(runtimeIdentity);
        invalidIdentity.listener.port = 41099;
        deliverPrepare = () => resolve({
          lease,
          handle: runtimeHandle,
          runtimeIdentity: invalidIdentity,
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        });
      }),
      abort: async () => {
        abortStateLocks = lock.activeStateLocks;
        return new Promise((resolve) => {
          settleAbort = resolve;
        });
      }
    });
    const manager = await open({
      statePath,
      withExclusiveLock: lock.withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      runtimeTimeoutMs: 10
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-late-invalid-${name}`)),
      (error) => error?.code === "relation_file_service_runtime_timeout"
    );
    deliverPrepare();
    await waitForQuery(
      manager,
      relationId,
      (value) => value.reason === "relation_file_service_late_prepare_invalid"
    );
    assert.equal(fixture.calls.abort.length, 1, name);
    assert.ok(Object.is(fixture.calls.abort[0].lease, lease), name);
    assert.deepEqual(
      fixture.calls.abort[0].details.fence,
      fixture.calls.prepare[0].details.fence,
      name
    );
    assert.equal(fixture.calls.inspect.length, 0, name);
    assert.equal(fixture.calls.go.length, 0, name);
    assert.equal(abortStateLocks, 0, name);

    const pendingState = JSON.parse(await readFile(statePath, "utf8"));
    const pendingEvidence = pendingState.relations[relationId].cleanupEvidence;
    assert.equal(pendingEvidence.leaseReturned, true, name);
    assert.equal(pendingEvidence.abortRequested, true, name);
    assert.equal(pendingEvidence.continuationRegistered, true, name);

    settleAbort({ containmentConfirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fixture.calls.abort.length, 1, name);
    const settledState = JSON.parse(await readFile(statePath, "utf8"));
    const settledEvidence = settledState.relations[relationId].cleanupEvidence;
    assert.equal(settledState.relations[relationId].phase, "cleanup_required", name);
    assert.equal(settledEvidence.abortCompleted, true, name);
    assert.equal(settledEvidence.containmentConfirmed, true, name);
    assert.equal(settledEvidence.reasonCode, "relation_file_service_runtime_cleanup_unconfirmed");
  }
});

test("late prepare settled before subscription is replayed exactly once", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-prepare-subscription";
  let releasePrepare;
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  const fixture = makeStartRuntime({
    relationId,
    prepare: async ({ details, runtimeHandle, runtimeIdentity }) => {
      await prepareGate;
      return {
        lease: { id: "late-prepare-subscription-lease" },
        handle: runtimeHandle,
        runtimeIdentity,
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    }
  });
  const base = makeDurableWriter().durableWriter;
  let releasedDuringCleanupCheckpoint = false;
  const writer = {
    async write(request) {
      if (!releasedDuringCleanupCheckpoint
        && request.state.relations[relationId]?.cleanupRequired === true) {
        releasedDuringCleanupCheckpoint = true;
        releasePrepare();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return base.write(request);
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: writer,
    protection: makeProtection().protection,
    runtimeTimeoutMs: 10
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-prepare-subscription")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  await waitForQuery(manager, relationId, (snapshot) => snapshot.state === "start_failed");
  assert.equal(releasedDuringCleanupCheckpoint, true);
  assert.equal(fixture.calls.abort.length, 1);
  assert.equal(fixture.calls.go.length, 0);
});

test("late go settled before subscription is replayed exactly once", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-go-subscription";
  const fixture = makeStartRuntime({
    relationId,
    go: ({ details }) => new Promise((resolve) => {
      details.signal.addEventListener(
        "abort",
        () => resolve({ ok: true }),
        { once: true }
      );
    })
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    runtimeTimeoutMs: 10
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-go-subscription")),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  await waitForCondition(() => fixture.calls.abort.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.calls.abort.length, 2);
  assert.equal(fixture.calls.go.length, 1);
});

test("late abort settled before subscription is replayed exactly once", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-late-abort-subscription";
  let abortCalls = 0;
  const fixture = makeStartRuntime({
    relationId,
    go: async () => {
      throw new Error("go rejected before listener");
    },
    abort: ({ details }) => {
      abortCalls += 1;
      if (abortCalls > 1) {
        return { containmentConfirmed: true };
      }
      return new Promise((resolve) => {
        details.signal.addEventListener(
          "abort",
          () => resolve({ containmentConfirmed: true }),
          { once: true }
        );
      });
    }
  });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    runtimeTimeoutMs: 10
  });

  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-late-abort-subscription")),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  const snapshot = await waitForQuery(
    manager,
    relationId,
    (value) => value.state === "start_failed"
  );
  assert.equal(snapshot.cleanupRequired, false);
  assert.equal(fixture.calls.abort.length, 1);
  assert.equal(fixture.calls.inspect.length, 2);
});

test("external state replacement during running inspection fails closed without overwriting it", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-finalize-superseded";
  const otherRelationId = "relation-finalize-progress";
  const lock = makeLockHarness();
  let supersededState;
  let supersedingOperationId;
  const fixture = makeStartRuntime({
    relationId,
    prepare: ({ request, details }) => {
      const runtimeHandle = handle(details.fence.relationId, details.fence.generation);
      return {
        lease: { id: `lease-${details.fence.relationId}` },
        handle: runtimeHandle,
        runtimeIdentity: runtimeIdentityFor(
          runtimeHandle,
          request.launch.listener.port
        ),
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    },
    inspect: async ({ handle: observedHandle, details }) => {
      if (details.purpose === "running") {
        if (observedHandle.relationId === relationId && !supersededState) {
          const current = JSON.parse(await readFile(statePath, "utf8"));
          const superseded = supersedingDisableState(current, relationId);
          supersededState = superseded.state;
          supersedingOperationId = superseded.operationId;
          await writeFile(
            statePath,
            JSON.stringify(supersededState, null, 2),
            "utf8"
          );
        }
        return runningEvidenceFor(
          observedHandle,
          runtimeIdentityFor(
            observedHandle,
            observedHandle.relationId === relationId ? 41001 : 42002
          ),
          details.fence
        );
      }
      return observation("unknown", observedHandle);
    },
    abort: async () => {
      return { containmentConfirmed: true };
    }
  });
  const manager = await open({
    statePath,
    withExclusiveLock: lock.withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    runtimeTimeoutMs: 250,
    randomBytes: () => Buffer.alloc(16, 34)
  });

  const startPromise = manager.start(
    startRequest(relationId, "operation-finalize-superseded")
  );
  await assert.rejects(
    startPromise,
    (error) => error?.code === "relation_file_service_state_revision_conflict"
  );
  await assert.rejects(
    () => manager.query({ relationId: otherRelationId }),
    (error) => error?.code === "relation_file_service_state_revision_conflict"
  );
  await assert.rejects(
    () => manager.start(startRequest(otherRelationId, "operation-finalize-progress")),
    (error) => error?.code === "relation_file_service_state_revision_conflict"
  );

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(
    state.operations[supersedingOperationId],
    supersededState.operations[supersedingOperationId]
  );
  assert.deepEqual(
    state.relations[relationId],
    supersededState.relations[relationId]
  );
  assert.equal(state.relations[otherRelationId], undefined);
  assert.equal(lock.activeStateLocks, 0);
});

test("falsy non-null opaque leases are cleaned once after external state replacement", async (t) => {
  for (const [name, lease] of [
    ["zero", 0],
    ["false", false],
    ["empty-string", ""]
  ]) {
    const root = await makeRoot(t);
    const statePath = join(root, `superseded-${name}.json`);
    const relationId = `relation-superseded-${name}`;
    const lock = makeLockHarness();
    let supersededState;
    let supersedingOperationId;
    let abortStateLocks = null;
    const fixture = makeStartRuntime({
      relationId,
      prepare: ({ request, details }) => {
        const runtimeHandle = handle(details.fence.relationId, details.fence.generation);
        return {
          lease,
          handle: runtimeHandle,
          runtimeIdentity: runtimeIdentityFor(
            runtimeHandle,
            request.launch.listener.port
          ),
          provisionalEvidence: provisionalEvidence(),
          fence: details.fence
        };
      },
      inspect: async ({ handle: observedHandle, details }) => {
        if (details.purpose === "running") {
          const current = JSON.parse(await readFile(statePath, "utf8"));
          const superseded = supersedingDisableState(current, relationId);
          supersededState = superseded.state;
          supersedingOperationId = superseded.operationId;
          await writeFile(
            statePath,
            JSON.stringify(supersededState, null, 2),
            "utf8"
          );
          return runningEvidenceFor(
            observedHandle,
            runtimeIdentityFor(observedHandle, 41001),
            details.fence
          );
        }
        return observation("unknown", observedHandle);
      },
      abort: async () => {
        abortStateLocks = lock.activeStateLocks;
        return { containmentConfirmed: true };
      }
    });
    const manager = await open({
      statePath,
      withExclusiveLock: lock.withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      randomBytes: () => Buffer.alloc(16, 40)
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-superseded-${name}`)),
      (error) => error?.code === "relation_file_service_state_revision_conflict"
    );
    assert.equal(fixture.calls.go.length, 1, name);
    assert.ok(Object.is(fixture.calls.go[0].lease, lease), name);
    assert.equal(fixture.calls.abort.length, 1, name);
    assert.ok(Object.is(fixture.calls.abort[0].lease, lease), name);
    assert.equal(abortStateLocks, 0, name);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(
      state.operations[supersedingOperationId],
      supersededState.operations[supersedingOperationId],
      name
    );
    assert.deepEqual(
      state.relations[relationId],
      supersededState.relations[relationId],
      name
    );
  }
});

test("V1 migration preserves historical operation values and insertion order", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const now = new Date().toISOString();
  const historical = {
    operationId: "operation-history",
    relationId: "relation-history",
    action: "disable",
    requestDigest: "a".repeat(64),
    phase: "pending",
    reason: "runtime_handle_missing",
    generation: "8",
    handleDigest: "b".repeat(64),
    createdAt: now,
    updatedAt: now
  };
  await writeFile(statePath, JSON.stringify({
    version: 1,
    kind: "relation-file-service-manager-state",
    storageContract: RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT,
    revision: 5,
    createdAt: now,
    updatedAt: now,
    operations: { "operation-history": historical },
    relations: {}
  }, null, 2), "utf8");

  const relationId = "relation-new-after-history";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 10)
  });
  await manager.start(startRequest(relationId, "operation-new-after-history"));

  const migrated = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(
    Object.keys(migrated.operations),
    ["operation-history", "operation-new-after-history"]
  );
  for (const [key, value] of Object.entries(historical)) {
    assert.equal(migrated.operations["operation-history"][key], value, key);
  }
  assert.equal(migrated.operations["operation-history"].recordOrigin, "v1-migrated");
});

test("reopen checkpoint matrix rejects unresolved states and retries only exact confirmed cleanup", async (t) => {
  const baseRoot = await makeRoot(t);
  const baseStatePath = join(baseRoot, "relation-services.json");
  const relationId = "relation-reopen-matrix";
  const operationId = "operation-reopen-matrix";
  const baseFixture = makeStartRuntime({ relationId });
  const baseManager = await open({
    statePath: baseStatePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: baseFixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 35)
  });
  await baseManager.start(startRequest(relationId, operationId));
  const running = JSON.parse(await readFile(baseStatePath, "utf8"));
  const runtimeHandle = running.relations[relationId].handle;

  const mutate = (name, change) => {
    const state = structuredClone(running);
    change(state, state.operations[operationId], state.relations[relationId]);
    state.revision += 1;
    state.updatedAt = new Date(Date.parse(state.updatedAt) + 1).toISOString();
    return { name, state };
  };
  const commonPhase = (operation, relation, phase) => {
    operation.phase = phase;
    relation.phase = phase;
    operation.cleanupEvidence = null;
    relation.cleanupEvidence = null;
    operation.cleanupRequired = false;
    relation.cleanupRequired = false;
    operation.commitUncertain = false;
    relation.commitUncertain = false;
  };
  const cases = [
    mutate("starting", (state, operation, relation) => {
      commonPhase(operation, relation, "starting");
      operation.reason = "";
      relation.reason = "";
      operation.handleDigest = "";
      relation.handleDigest = "";
      operation.protectionDigest = null;
      relation.protectionDigest = null;
      operation.runtimeIdentity = null;
      relation.runtimeIdentity = null;
      operation.provisionalEvidence = null;
      relation.provisionalEvidence = null;
      operation.runningEvidenceDigest = null;
      relation.runningEvidenceDigest = null;
      relation.handle = null;
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("prepared", (state, operation, relation) => {
      commonPhase(operation, relation, "prepared");
      operation.reason = "";
      relation.reason = "";
      operation.runningEvidenceDigest = null;
      relation.runningEvidenceDigest = null;
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("running", (state, operation, relation) => {
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("unknown", (state, operation, relation) => {
      commonPhase(operation, relation, "unknown");
      operation.reason = "relation_file_service_state_corrupt";
      relation.reason = operation.reason;
      relation.desired = "unknown";
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("cleanup_required", (state, operation, relation) => {
      commonPhase(operation, relation, "cleanup_required");
      operation.reason = "relation_file_service_runtime_cleanup_unconfirmed";
      relation.reason = operation.reason;
      operation.cleanupRequired = true;
      relation.cleanupRequired = true;
      operation.cleanupEvidence = unconfirmedCleanupEvidenceFor(runtimeHandle);
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("cleanup_required+commit_uncertain", (state, operation, relation) => {
      commonPhase(operation, relation, "cleanup_required");
      operation.reason = "relation_file_service_runtime_cleanup_unconfirmed";
      relation.reason = operation.reason;
      operation.cleanupRequired = true;
      relation.cleanupRequired = true;
      operation.commitUncertain = true;
      relation.commitUncertain = true;
      operation.cleanupEvidence = unconfirmedCleanupEvidenceFor(runtimeHandle);
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("commit_uncertain", (state, operation, relation) => {
      commonPhase(operation, relation, "commit_uncertain");
      operation.reason = "relation_file_service_commit_uncertain";
      relation.reason = operation.reason;
      operation.commitUncertain = true;
      relation.commitUncertain = true;
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("running+commit_uncertain", (state, operation, relation) => {
      operation.phase = "running";
      relation.phase = "running";
      operation.reason = "relation_file_service_commit_uncertain";
      relation.reason = operation.reason;
      operation.commitUncertain = true;
      relation.commitUncertain = true;
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("start_failed confirmedStopped", (state, operation, relation) => {
      commonPhase(operation, relation, "start_failed");
      operation.reason = "";
      relation.reason = "";
      operation.cleanupEvidence = cleanupEvidenceFor(runtimeHandle, "finalize-pending");
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("start_failed unconfirmed", (state, operation, relation) => {
      commonPhase(operation, relation, "start_failed");
      operation.reason = "";
      relation.reason = "";
      operation.cleanupEvidence = unconfirmedCleanupEvidenceFor(runtimeHandle);
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("start_failed commitUncertain", (state, operation, relation) => {
      commonPhase(operation, relation, "start_failed");
      operation.reason = "";
      relation.reason = "";
      operation.commitUncertain = true;
      relation.commitUncertain = true;
      operation.cleanupEvidence = cleanupEvidenceFor(runtimeHandle, "finalize-pending");
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    }),
    mutate("start_failed cleanupRequired", (state, operation, relation) => {
      commonPhase(operation, relation, "start_failed");
      operation.reason = "";
      relation.reason = "";
      operation.cleanupRequired = true;
      relation.cleanupRequired = true;
      operation.cleanupEvidence = unconfirmedCleanupEvidenceFor(runtimeHandle);
      relation.cleanupEvidence = structuredClone(operation.cleanupEvidence);
      state.operations[operationId] = operation;
      state.relations[relationId] = relation;
    })
  ];
  const expected = new Map([
    ["starting", { code: "relation_file_service_start_blocked" }],
    ["prepared", { code: "relation_file_service_start_blocked" }],
    ["running", { code: "relation_file_service_start_blocked" }],
    ["unknown", { code: "relation_file_service_start_blocked" }],
    ["cleanup_required", { code: "relation_file_service_cleanup_required" }],
    ["cleanup_required+commit_uncertain", { code: "relation_file_service_commit_uncertain" }],
    ["commit_uncertain", { code: "relation_file_service_commit_uncertain" }],
    ["running+commit_uncertain", { code: "relation_file_service_commit_uncertain" }],
    ["start_failed confirmedStopped", { result: "running" }],
    ["start_failed unconfirmed", { open: "relation_file_service_state_invalid" }],
    ["start_failed commitUncertain", { open: "relation_file_service_state_invalid" }],
    ["start_failed cleanupRequired", { open: "relation_file_service_state_invalid" }]
  ]);

  for (const matrixCase of cases) {
    const expectedCase = expected.get(matrixCase.name);
    const caseRoot = await makeRoot(t);
    const statePath = join(caseRoot, `${matrixCase.name.replaceAll(/[^a-z0-9]+/gi, "-")}.json`);
    await writeFile(statePath, JSON.stringify(matrixCase.state, null, 2), "utf8");
    const retryFixture = makeStartRuntime({ relationId, generation: "2" });
    if (expectedCase.open) {
      await assert.rejects(
        () => open({
          statePath,
          withExclusiveLock: makeLockHarness().withExclusiveLock,
          runtime: retryFixture.runtime,
          durableWriter: makeDurableWriter().durableWriter,
          protection: makeProtection().protection
        }),
        (error) => error?.code === expectedCase.open,
        matrixCase.name
      );
      continue;
    }
    const reopened = await open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: retryFixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection,
      randomBytes: () => Buffer.alloc(16, 36)
    });
    const expectedHandleDigest = matrixCase.state.relations[relationId].handleDigest;
    if (expectedCase.result) {
      const result = await reopened.start(startRequest(
        relationId,
        `operation-${matrixCase.name.replaceAll(/[^a-z0-9]+/gi, "-")}-next`,
        { expectedHandleDigest }
      ));
      assert.equal(result.state, expectedCase.result, matrixCase.name);
      assert.equal(result.generation, "2", matrixCase.name);
    } else {
      await assert.rejects(
        () => reopened.start(startRequest(
          relationId,
          `operation-${matrixCase.name.replaceAll(/[^a-z0-9]+/gi, "-")}-next`,
          { expectedHandleDigest }
        )),
        (error) => error?.code === expectedCase.code,
        matrixCase.name
      );
      assert.equal(retryFixture.calls.prepare.length, 0, matrixCase.name);
    }
  }

  const v1Root = await makeRoot(t);
  const v1StatePath = join(v1Root, "relation-services.json");
  const v1RelationId = "relation-v1-reopen";
  await open({
    statePath: v1StatePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: makeStartRuntime({ relationId: v1RelationId }).runtime
  });
  const v1Fixture = makeStartRuntime({ relationId: v1RelationId });
  const v1Manager = await open({
    statePath: v1StatePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: v1Fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 37)
  });
  const v1Result = await v1Manager.start(
    startRequest(v1RelationId, "operation-v1-reopen")
  );
  assert.equal(v1Result.state, "running");
  assert.equal(v1Result.generation, "1");
});

test("V2 phase overlays preserve cleanup and commit uncertainty independently", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-overlay";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 11)
  });
  await manager.start(startRequest(relationId, "operation-overlay"));
  const running = JSON.parse(await readFile(statePath, "utf8"));
  const operationId = "operation-overlay";

  const cleanupAndCommit = structuredClone(running);
  for (const record of [
    cleanupAndCommit.operations[operationId],
    cleanupAndCommit.relations[relationId]
  ]) {
    record.phase = "cleanup_required";
    record.reason = "relation_file_service_runtime_cleanup_unconfirmed";
    record.cleanupRequired = true;
    record.commitUncertain = true;
    record.cleanupEvidence = unconfirmedCleanupEvidenceFor(fixture.handle);
  }
  await writeFile(statePath, JSON.stringify(cleanupAndCommit, null, 2), "utf8");
  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  const snapshot = await reopened.query({ relationId });
  assert.equal(snapshot.state, "cleanup_required");
  assert.equal(snapshot.cleanupRequired, true);
  assert.equal(snapshot.commitUncertain, true);
  assert.equal(snapshot.runningEvidencePresent, true);

  const unknown = structuredClone(running);
  for (const record of [
    unknown.operations[operationId],
    unknown.relations[relationId]
  ]) {
    record.phase = "unknown";
    record.reason = "relation_file_service_state_corrupt";
    record.cleanupRequired = false;
    record.commitUncertain = false;
    record.cleanupEvidence = null;
  }
  unknown.relations[relationId].desired = "unknown";
  const unknownPath = join(root, "valid-unknown-phase.json");
  await writeFile(unknownPath, JSON.stringify(unknown, null, 2), "utf8");
  const unknownManager = await open({
    statePath: unknownPath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  const unknownSnapshot = await unknownManager.query({ relationId });
  assert.equal(unknownSnapshot.state, "unknown");
  assert.equal(unknownSnapshot.desired, "unknown");

  const invalidCases = [
    ["starting with runtime identity", (state) => {
      for (const record of [state.operations[operationId], state.relations[relationId]]) {
        record.phase = "starting";
        record.runningEvidenceDigest = null;
        record.cleanupEvidence = null;
        record.cleanupRequired = false;
        record.commitUncertain = false;
      }
    }],
    ["prepared without protection", (state) => {
      for (const record of [state.operations[operationId], state.relations[relationId]]) {
        record.phase = "prepared";
        record.protectionDigest = null;
        record.runningEvidenceDigest = null;
        record.cleanupEvidence = null;
        record.cleanupRequired = false;
        record.commitUncertain = false;
      }
    }],
    ["cleanup required without evidence", (state) => {
      for (const record of [state.operations[operationId], state.relations[relationId]]) {
        record.phase = "cleanup_required";
        record.cleanupRequired = true;
        record.cleanupEvidence = null;
        record.commitUncertain = false;
      }
    }]
  ];
  for (const [name, mutate] of invalidCases) {
    const invalid = structuredClone(running);
    mutate(invalid);
    const invalidPath = join(root, `invalid-overlay-${name.replaceAll(" ", "-")}.json`);
    await writeFile(invalidPath, JSON.stringify(invalid, null, 2), "utf8");
    await assert.rejects(
      () => open({
        statePath: invalidPath,
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        runtime: fixture.runtime,
        durableWriter: makeDurableWriter().durableWriter,
        protection: makeProtection().protection
      }),
      (error) => error?.code === "relation_file_service_state_invalid",
      name
    );
  }
});

test("V2 exact schema rejects field, identity and cross-record inconsistencies", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-schema-matrix";
  const operationId = "operation-schema-matrix";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 19)
  });
  await manager.start(startRequest(relationId, operationId));
  const valid = JSON.parse(await readFile(statePath, "utf8"));
  const cases = [
    ["extra operation field", (state) => {
      state.operations[operationId].unexpected = true;
    }],
    ["missing relation field", (state) => {
      delete state.relations[relationId].expectedHandleDigest;
    }],
    ["runtime token mismatch", (state) => {
      const identityValue = state.relations[relationId].runtimeIdentity;
      identityValue.tokenSha256 = sha256("different-token");
      state.operations[operationId].runtimeIdentity = structuredClone(identityValue);
    }],
    ["cross-record phase mismatch", (state) => {
      state.operations[operationId].phase = "prepared";
    }],
    ["cleanup handle mismatch", (state) => {
      const cleanup = cleanupEvidenceFor(fixture.handle, "finalize-pending", {
        exactHandleIdentity: {
          relationId,
          generation: "2",
          handleDigest: "f".repeat(64)
        }
      });
      for (const record of [state.operations[operationId], state.relations[relationId]]) {
        record.phase = "start_failed";
        record.reason = "";
        record.cleanupRequired = false;
        record.commitUncertain = false;
        record.cleanupEvidence = structuredClone(cleanup);
      }
    }]
  ];
  for (const [name, mutate] of cases) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const invalidPath = join(root, `invalid-schema-${name.replaceAll(" ", "-")}.json`);
    await writeFile(invalidPath, JSON.stringify(invalid, null, 2), "utf8");
    await assert.rejects(
      () => open({
        statePath: invalidPath,
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        runtime: fixture.runtime,
        durableWriter: makeDurableWriter().durableWriter,
        protection: makeProtection().protection
      }),
      (error) => error?.code === "relation_file_service_state_invalid",
      name
    );
  }
});

test("commit uncertainty marker targets only the attempted relation", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationA = "relation-marker-a";
  const relationB = "relation-marker-b";
  const fixtureB = makeStartRuntime({ relationId: relationB, port: 41002 });
  const durable = makeDurableWriter({
    outcomes: [null, null, null, "write_then_uncertain", "committed"]
  });
  const managerB = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixtureB.runtime,
    durableWriter: durable.durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 12)
  });
  await managerB.start(startRequest(relationB, "operation-marker-b", {
    launch: {
      target: "rclone-serve-sftp",
      listener: { host: "127.0.0.1", port: 41002 }
    }
  }));

  const fixtureA = makeStartRuntime({ relationId: relationA, port: 41001 });
  const managerA = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixtureA.runtime,
    durableWriter: durable.durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 13)
  });
  await assert.rejects(
    () => managerA.start(startRequest(relationA, "operation-marker-a")),
    (error) => error?.code === "relation_file_service_commit_uncertain"
  );
  await assert.rejects(
    () => managerA.start(startRequest(relationA, "operation-marker-a-retry")),
    (error) => error?.code === "relation_file_service_volatile_quarantine"
  );

  const snapshotA = await managerA.query({ relationId: relationA });
  const snapshotB = await managerA.query({ relationId: relationB });
  assert.equal(snapshotA.state, "commit_uncertain");
  assert.equal(snapshotA.commitUncertain, true);
  assert.equal(snapshotB.state, "running");
  assert.equal(snapshotB.commitUncertain, false);

  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixtureA.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  await assert.rejects(
    () => reopened.start(startRequest(relationA, "operation-marker-a-reopen")),
    (error) => error?.code === "relation_file_service_commit_uncertain"
  );
});

test("failed commit marker leaves the visible checkpoint quarantined until reopen", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-marker-failed";
  const fixture = makeStartRuntime({ relationId });
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter({
      outcomes: ["write_then_uncertain", "failed"]
    }).durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 14)
  });
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-marker-failed")),
    (error) => error?.code === "relation_file_service_commit_uncertain"
  );
  const visible = await manager.query({ relationId });
  assert.equal(visible.state, "starting");
  assert.equal(visible.commitUncertain, false);
  await assert.rejects(
    () => manager.start(startRequest(relationId, "operation-marker-failed-retry")),
    (error) => error?.code === "relation_file_service_volatile_quarantine"
  );

  const reopened = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: makeProtection().protection
  });
  await assert.rejects(
    () => reopened.start(startRequest(relationId, "operation-marker-failed-reopen")),
    (error) => error?.code === "relation_file_service_start_blocked"
  );
  await assert.rejects(
    () => manager.disable({
      relationId,
      identity: identity(relationId),
      operationId: "operation-marker-failed-disable"
    }),
    (error) => error?.code === "relation_file_service_volatile_quarantine"
  );
  await assert.rejects(
    () => manager.reconcile({ relationId }),
    (error) => error?.code === "relation_file_service_volatile_quarantine"
  );
});

test("durable writer not-committed outcomes distinguish rename failure from revision conflict", async (t) => {
  const root = await makeRoot(t);
  const relationId = "relation-not-committed";
  const fixture = makeStartRuntime({ relationId });
  const writeFailurePath = join(root, "write-failure.json");
  const writeFailure = await open({
    statePath: writeFailurePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter({
      outcomes: ["not_committed"]
    }).durableWriter,
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 23)
  });
  await assert.rejects(
    () => writeFailure.start(startRequest(relationId, "operation-write-failure")),
    (error) => error?.code === "relation_file_service_state_write_failed"
  );

  const conflictPath = join(root, "revision-conflict.json");
  const conflict = await open({
    statePath: conflictPath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: {
      async write(request) {
        return {
          outcome: "not_committed",
          stages: [],
          expectedRevision: request.expectedRevision,
          currentRevision: request.expectedRevision + 1
        };
      }
    },
    protection: makeProtection().protection,
    randomBytes: () => Buffer.alloc(16, 24)
  });
  await assert.rejects(
    () => conflict.start(startRequest(relationId, "operation-revision-conflict")),
    (error) => error?.code === "relation_file_service_state_revision_conflict"
  );
});

function makeWriterState() {
  const now = new Date().toISOString();
  return {
    version: 2,
    kind: "relation-file-service-manager-state",
    storageContract: RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    operations: {},
    relations: {}
  };
}

function makeFakeWriterFs(options = {}) {
  const statePath = options.statePath || join(tmpdir(), "fake-writer-state.json");
  const parentPath = join(statePath, "..");
  let currentState = structuredClone(options.currentState || makeWriterState());
  const calls = [];
  let tempOpenCalls = 0;
  let parentOpenCalls = 0;
  let tempCloseCalls = 0;
  let parentCloseCalls = 0;
  let tempStatCalls = 0;
  let readCalls = 0;
  const tempIdentity = options.tempIdentity || { dev: "10", ino: "11" };

  const parentHandle = {
    async stat() {
      return {
        dev: 1,
        ino: 2,
        uid: options.parentUid ?? 1000,
        mode: 0o40700,
        isDirectory: () => true,
        isFile: () => false
      };
    },
    async sync() {
      calls.push("parent_sync");
      if (options.failParentSync) {
        throw Object.assign(new Error("parent sync failed"), { code: "EIO" });
      }
    },
    async close() {
      parentCloseCalls += 1;
      calls.push(`parent_close_${parentCloseCalls}`);
      if (options.failParentClose) {
        throw Object.assign(new Error("parent close failed"), { code: "EIO" });
      }
    }
  };
  const tempHandle = {
    mode: options.initialMode ?? 0o600,
    uid: options.tempUid ?? 1000,
    async stat() {
      tempStatCalls += 1;
      if (options.failFirstTempStat && tempStatCalls === 1) {
        throw Object.assign(new Error("temp stat failed"), { code: "EIO" });
      }
      return {
        dev: Number(tempIdentity.dev),
        ino: Number(tempIdentity.ino),
        uid: this.uid,
        mode: this.mode,
        isFile: () => true,
        isDirectory: () => false
      };
    },
    async chmod(mode) {
      calls.push("temp_chmod");
      if (options.failChmod) {
        throw Object.assign(new Error("chmod failed"), { code: "EPERM" });
      }
      this.mode = options.preserveSetidAfterChmod
        ? (this.mode & 0o7000) | mode
        : mode;
    },
    async writeFile() {
      calls.push("temp_write");
      if (options.failWrite) {
        throw Object.assign(new Error("write failed"), { code: "EIO" });
      }
    },
    async sync() {
      calls.push("temp_sync");
      if (options.failFileSync) {
        throw Object.assign(new Error("file sync failed"), { code: "EIO" });
      }
    },
    async close() {
      tempCloseCalls += 1;
      calls.push(`temp_close_${tempCloseCalls}`);
      if (options.failTempClose && tempCloseCalls === 1) {
        throw Object.assign(new Error("temp close failed"), { code: "EIO" });
      }
    }
  };

  return {
    calls,
    get currentState() {
      return currentState;
    },
    fileSystem: {
      constants: {
        O_RDONLY: 1,
        O_WRONLY: 2,
        O_CREAT: 4,
        O_EXCL: 8,
        O_NOFOLLOW: 16,
        O_CLOEXEC: 32,
        O_DIRECTORY: 64
      },
      async realpath(path) {
        calls.push("realpath");
        return options.realpathMismatch ? `${path}-different` : path;
      },
      async open(path, flags, mode) {
        if (path === parentPath) {
          parentOpenCalls += 1;
          calls.push("parent_open");
          if (options.failParentOpen) {
            throw Object.assign(new Error("parent open failed"), { code: "ELOOP" });
          }
          return parentHandle;
        }
        tempOpenCalls += 1;
        calls.push("temp_open");
        if (options.foreignTempConflict && tempOpenCalls === 1) {
          throw Object.assign(new Error("temp exists"), { code: "EEXIST" });
        }
        if (options.failTempOpen) {
          throw Object.assign(new Error("temp open failed"), { code: "ELOOP" });
        }
        assert.equal(flags & 8, 8);
        assert.equal(mode, 0o600);
        return tempHandle;
      },
      async readFile() {
        readCalls += 1;
        calls.push(`read_${readCalls}`);
        if (options.beforeRenameState && readCalls === 2) {
          return JSON.stringify(options.beforeRenameState, null, 2);
        }
        return JSON.stringify(currentState, null, 2);
      },
      async rename(from, to) {
        calls.push("rename");
        if (options.failRename) {
          throw Object.assign(new Error("rename failed"), { code: "EIO" });
        }
        assert.equal(to, statePath);
        assert.match(from, /\.tmp$/);
        currentState = structuredClone(options.nextState);
      },
      async lstat(path) {
        calls.push("lstat_temp");
        if (options.symlinkTemp) {
          return {
            dev: Number(tempIdentity.dev),
            ino: Number(tempIdentity.ino),
            isSymbolicLink: () => true
          };
        }
        return {
          dev: Number(options.cleanupDev ?? tempIdentity.dev),
          ino: Number(options.cleanupIno ?? tempIdentity.ino),
          isSymbolicLink: () => false
        };
      },
      async unlink(path) {
        calls.push("unlink_temp");
        if (options.failCleanup) {
          throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
        }
      }
    }
  };
}

test("durable writer follows exact stage order and enforces owner/mode identity", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "writer.json");
  const currentState = makeWriterState();
  const nextState = {
    ...structuredClone(currentState),
    revision: 1,
    updatedAt: new Date().toISOString()
  };
  const fake = makeFakeWriterFs({ statePath, currentState, nextState });
  const writer = createLinuxDurableWriter({
    fileSystem: fake.fileSystem,
    expectedUid: 1000
  });
  const receipt = await writer.write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "attempt-one"
  });
  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.temp.dev, "10");
  assert.equal(receipt.temp.ino, "11");
  assert.ok(receipt.stages.indexOf("rename_returned") < receipt.stages.indexOf("parent_fsync_returned"));
  assert.ok(receipt.stages.indexOf("parent_fsync_returned") < receipt.stages.indexOf("parent_close_returned"));
  assert.deepEqual(receipt.stageErrors, []);
});

test("durable writer never deletes a foreign O_EXCL temp and leaves identity-less temps", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "foreign-temp.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };
  const fake = makeFakeWriterFs({
    statePath,
    currentState,
    nextState,
    foreignTempConflict: true
  });
  const writer = createLinuxDurableWriter({
    fileSystem: fake.fileSystem,
    expectedUid: 1000
  });
  const receipt = await writer.write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "foreign"
  });
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.temp, null);
  assert.equal(receipt.cleanup.attempted, false);
  assert.equal(fake.calls.includes("lstat_temp"), false);
  assert.equal(fake.calls.includes("unlink_temp"), false);
});

test("durable writer leaves a temp without identity and never unlinks it", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "identity-less.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };
  const fake = makeFakeWriterFs({
    statePath,
    currentState,
    nextState,
    failFirstTempStat: true
  });
  const receipt = await createLinuxDurableWriter({
    fileSystem: fake.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "identity-less"
  });

  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.temp, null);
  assert.equal(receipt.cleanup.status, "left-without-identity");
  assert.equal(fake.calls.includes("lstat_temp"), false);
  assert.equal(fake.calls.includes("unlink_temp"), false);
  assert.equal(fake.calls.includes("rename"), false);
});

test("durable writer rejects parent symlink, wrong owner, setid mode and close failures", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "writer-failures.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };

  const symlink = makeFakeWriterFs({
    statePath,
    currentState,
    nextState,
    realpathMismatch: true
  });
  const symlinkReceipt = await createLinuxDurableWriter({
    fileSystem: symlink.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "symlink"
  });
  assert.equal(symlinkReceipt.outcome, "failed");
  assert.equal(symlink.calls.includes("parent_open"), false);

  for (const [name, options] of [
    ["parent-owner", { parentUid: 2000 }],
    ["temp-owner", { tempUid: 2000 }],
    ["setid-mode", { initialMode: 0o4600, preserveSetidAfterChmod: true }]
  ]) {
    const fake = makeFakeWriterFs({
      statePath,
      currentState,
      nextState,
      ...options
    });
    const receipt = await createLinuxDurableWriter({
      fileSystem: fake.fileSystem,
      expectedUid: 1000
    }).write({
      statePath,
      expectedRevision: 0,
      state: nextState,
      attemptId: name
    });
    assert.equal(receipt.outcome, "failed", name);
    assert.equal(fake.calls.includes("rename"), false, name);
  }

  const closeFailure = makeFakeWriterFs({
    statePath,
    currentState,
    nextState,
    failTempClose: true
  });
  const closeReceipt = await createLinuxDurableWriter({
    fileSystem: closeFailure.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "close-failure"
  });
  assert.equal(closeReceipt.outcome, "failed");
  assert.equal(closeFailure.calls.includes("rename"), false);
  assert.ok(closeReceipt.stageErrors.some((entry) => entry.stage === "file_close_started"));
});

test("durable writer reports commit uncertainty for parent fsync or post-fsync close failure", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "uncertain.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };

  for (const [name, options] of [
    ["parent-fsync", { failParentSync: true }],
    ["parent-close", { failParentClose: true }]
  ]) {
    const fake = makeFakeWriterFs({
      statePath,
      currentState,
      nextState,
      ...options
    });
    const receipt = await createLinuxDurableWriter({
      fileSystem: fake.fileSystem,
      expectedUid: 1000
    }).write({
      statePath,
      expectedRevision: 0,
      state: nextState,
      attemptId: name
    });
    assert.equal(receipt.outcome, "commit_uncertain", name);
    assert.equal(fake.calls.includes("rename"), true, name);
    assert.ok(receipt.stageErrors.length > 0, name);
  }
});

test("durable writer records exact temp cleanup mismatch and cleanup failure", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "cleanup.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };

  for (const [name, options, expectedStatus] of [
    ["mismatch", { cleanupIno: "99" }, "left-identity-mismatch"],
    ["failure", { failCleanup: true }, "failed"],
    ["symlink", { symlinkTemp: true }, "left-identity-mismatch"]
  ]) {
    const fake = makeFakeWriterFs({
      statePath,
      currentState,
      nextState,
      failFileSync: true,
      ...options
    });
    const receipt = await createLinuxDurableWriter({
      fileSystem: fake.fileSystem,
      expectedUid: 1000
    }).write({
      statePath,
      expectedRevision: 0,
      state: nextState,
      attemptId: name
    });
    assert.equal(receipt.outcome, "failed", name);
    assert.equal(receipt.cleanup.status, expectedStatus, name);
    assert.equal(fake.calls.includes("rename"), false, name);
    if (name === "failure") {
      assert.ok(receipt.stageErrors.some((entry) => entry.stage === "temp_cleanup"));
    } else {
      assert.equal(fake.calls.includes("unlink_temp"), false, name);
    }
  }
});

test("durable writer checks revision and full schema before rename", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "schema-check.json");
  const currentState = makeWriterState();
  const invalidNext = {
    ...structuredClone(currentState),
    revision: 1,
    unexpected: true
  };
  const fake = makeFakeWriterFs({
    statePath,
    currentState,
    nextState: invalidNext
  });
  const receipt = await createLinuxDurableWriter({
    fileSystem: fake.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: invalidNext,
    attemptId: "schema"
  });
  assert.equal(receipt.outcome, "failed");
  assert.equal(fake.calls.includes("rename"), false);
  assert.ok(receipt.stages.includes("revision_checked"));
  assert.equal(receipt.stages.includes("temp_open_started"), false);
});

test("durable writer rejects corrupt same-revision destinations before and after temp", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "corrupt-destination.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };

  const initiallyCorrupt = {
    ...structuredClone(currentState),
    unexpected: true
  };
  const first = makeFakeWriterFs({
    statePath,
    currentState: initiallyCorrupt,
    nextState
  });
  const firstReceipt = await createLinuxDurableWriter({
    fileSystem: first.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "corrupt-current"
  });
  assert.equal(firstReceipt.outcome, "failed");
  assert.equal(firstReceipt.stages.includes("current_schema_checked"), false);
  assert.equal(firstReceipt.stages.includes("temp_open_started"), false);
  assert.equal(first.calls.includes("rename"), false);

  const beforeRenameCorrupt = {
    ...structuredClone(currentState),
    unexpected: true
  };
  const second = makeFakeWriterFs({
    statePath,
    currentState,
    nextState,
    beforeRenameState: beforeRenameCorrupt
  });
  const secondReceipt = await createLinuxDurableWriter({
    fileSystem: second.fileSystem,
    expectedUid: 1000
  }).write({
    statePath,
    expectedRevision: 0,
    state: nextState,
    attemptId: "corrupt-before-rename"
  });
  assert.equal(secondReceipt.outcome, "failed");
  assert.equal(secondReceipt.stages.includes("temp_open_started"), true);
  assert.equal(secondReceipt.stages.includes("rename_destination_schema_checked"), false);
  assert.equal(secondReceipt.stages.includes("rename_started"), false);
  assert.equal(second.calls.includes("rename"), false);
  assert.equal(second.currentState.revision, 0);
});

test("durable writer stage failures fail closed before commit", async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "writer-stage-failures.json");
  const currentState = makeWriterState();
  const nextState = { ...structuredClone(currentState), revision: 1 };
  const cases = [
    ["parent-open", { failParentOpen: true }, "parent_open_started", false, "failed"],
    ["temp-open", { failTempOpen: true }, "temp_open_started", false, "failed"],
    ["chmod", { failChmod: true }, "temp_fchmod_started", true, "failed"],
    ["write", { failWrite: true }, "write_started", true, "failed"],
    ["file-fsync", { failFileSync: true }, "file_fsync_started", true, "failed"],
    ["temp-close", { failTempClose: true }, "file_close_started", true, "failed"],
    ["rename", { failRename: true }, "rename_started", true, "not_committed"]
  ];
  for (const [name, options, failedStage, tempCreated, expectedOutcome] of cases) {
    const fake = makeFakeWriterFs({
      statePath,
      currentState,
      nextState,
      ...options
    });
    const receipt = await createLinuxDurableWriter({
      fileSystem: fake.fileSystem,
      expectedUid: 1000
    }).write({
      statePath,
      expectedRevision: 0,
      state: nextState,
      attemptId: name
    });
    assert.equal(receipt.outcome, expectedOutcome, name);
    assert.ok(receipt.stageErrors.some((entry) => entry.stage === failedStage), name);
    assert.equal(fake.currentState.revision, 0, name);
    if (tempCreated) {
      assert.equal(receipt.cleanup.attempted, true, name);
      assert.equal(receipt.cleanup.status, "removed", name);
    } else {
      assert.equal(receipt.cleanup.attempted, false, name);
    }
  }
});

test("commit marker failure matrix preserves quarantine and reopen fail-closed behavior", async (t) => {
  const cases = [
    ["temp-open", { failTempOpen: true }, "temp_open_started", "failed"],
    ["write", { failWrite: true }, "write_started", "failed"],
    ["file-fsync", { failFileSync: true }, "file_fsync_started", "failed"],
    ["temp-close", { failTempClose: true }, "file_close_started", "failed"],
    ["rename", { failRename: true }, "rename_started", "not_committed"],
    ["parent-fsync", { failParentSync: true }, "parent_fsync_started", "commit_uncertain"]
  ];
  for (const [name, markerOptions, failedStage, markerOutcome] of cases) {
    const root = await makeRoot(t);
    const statePath = join(root, `marker-${name}.json`);
    const relationId = `relation-marker-${name}`;
    const baseWriter = makeDurableWriter({
      outcomes: ["write_then_uncertain"]
    }).durableWriter;
    let writeCount = 0;
    let markerReceipt;
    const durableWriter = {
      async write(request) {
        writeCount += 1;
        if (writeCount === 1) {
          return baseWriter.write(request);
        }
        const visible = JSON.parse(await readFile(request.statePath, "utf8"));
        const fake = makeFakeWriterFs({
          statePath: request.statePath,
          currentState: visible,
          nextState: request.state,
          ...markerOptions
        });
        markerReceipt = await createLinuxDurableWriter({
          fileSystem: fake.fileSystem,
          expectedUid: 1000
        }).write(request);
        if (markerReceipt.outcome === "commit_uncertain"
          && markerReceipt.stages.includes("rename_returned")) {
          await writeFile(
            request.statePath,
            JSON.stringify(request.state, null, 2),
            "utf8"
          );
        }
        return markerReceipt;
      }
    };
    const fixture = makeStartRuntime({ relationId });
    const manager = await open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter,
      protection: makeProtection().protection,
      randomBytes: () => Buffer.alloc(16, 38)
    });

    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-marker-${name}`)),
      (error) => error?.code === "relation_file_service_commit_uncertain",
      name
    );
    assert.equal(writeCount, 2, name);
    assert.ok(
      markerReceipt.stageErrors.some((entry) => entry.stage === failedStage),
      name
    );
    assert.equal(markerReceipt.outcome, markerOutcome, name);
    assert.equal(fixture.calls.prepare.length, 0, name);

    const snapshot = await manager.query({ relationId });
    if (name === "parent-fsync") {
      assert.equal(snapshot.state, "commit_uncertain", name);
      assert.equal(snapshot.commitUncertain, true, name);
    } else {
      assert.equal(snapshot.state, "starting", name);
      assert.equal(snapshot.commitUncertain, false, name);
    }
    await assert.rejects(
      () => manager.start(startRequest(relationId, `operation-marker-${name}-again`)),
      (error) => error?.code === "relation_file_service_volatile_quarantine",
      name
    );
    await assert.rejects(
      () => manager.disable({
        relationId,
        identity: identity(relationId),
        operationId: `operation-marker-${name}-disable`
      }),
      (error) => error?.code === "relation_file_service_volatile_quarantine",
      name
    );
    await assert.rejects(
      () => manager.reconcile({ relationId }),
      (error) => error?.code === "relation_file_service_volatile_quarantine",
      name
    );

    const reopened = await open({
      statePath,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: makeStartRuntime({ relationId }).runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: makeProtection().protection
    });
    await assert.rejects(
      () => reopened.start(startRequest(
        relationId,
        `operation-marker-${name}-reopen`
      )),
      (error) => error?.code === (
        name === "parent-fsync"
          ? "relation_file_service_commit_uncertain"
          : "relation_file_service_start_blocked"
      ),
      name
    );
  }
});

test("all manager timeouts reject values above the platform timer limit", async (t) => {
  const root = await makeRoot(t);
  const fixture = makeStartRuntime({ relationId: "relation-timeout-limit" });
  for (const field of [
    "runtimeTimeoutMs",
    "protectionTimeoutMs",
    "protectionSettlementWatchdogMs"
  ]) {
    await assert.rejects(
      () => open({
        statePath: join(root, `${field}.json`),
        withExclusiveLock: makeLockHarness().withExclusiveLock,
        runtime: fixture.runtime,
        [field]: 2_147_483_648
      }),
      (error) => error?.code === "relation_file_service_request_invalid",
      field
    );
  }
});

test("watchdog isolates the owner until a late confirmed settlement releases scope", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationId = "relation-watchdog-confirmed";
  const fixture = makeStartRuntime({ relationId });
  let releaseVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let relationHeld = false;
  let startSettled = false;
  const manager = await open({
    statePath,
    runtimeTimeoutMs: 10,
    protectionTimeoutMs: 10,
    protectionSettlementWatchdogMs: 10,
    withExclusiveLock: async (scope, task) => {
      if (scope.scope === "relation") {
        relationHeld = true;
        try {
          return await task();
        } finally {
          relationHeld = false;
        }
      }
      return task();
    },
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify() {
        markVerificationStarted();
        return new Promise((resolve) => {
          releaseVerification = resolve;
        });
      }
    },
    onOwnerFatal(details) {
      markFatal(details);
    }
  });
  const start = manager.start(startRequest(
    relationId,
    "operation-watchdog-confirmed"
  )).then(
    (value) => {
      startSettled = true;
      return { value };
    },
    (error) => {
      startSettled = true;
      return { error };
    }
  );

  await withTimeout(verificationStarted);
  const fatal = await withTimeout(fatalSeen);
  assert.equal(fatal.reasonCode, "relation_file_service_protection_settlement_unconfirmed");
  assert.equal(fatal.settlementCode, "settlement_deadline_elapsed");
  assert.equal(startSettled, false);
  assert.equal(relationHeld, true);
  assert.equal((await manager.query({ relationId })).state, "starting");

  releaseVerification({ digest: "a".repeat(64) });
  const result = await withTimeout(start);
  assert.equal(result.error.code, "relation_file_service_owner_fatal");
  assert.equal(startSettled, true);
  assert.equal(relationHeld, false);
  assert.equal(fixture.calls.prepare.length, 0);
  const visible = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(visible.relations[relationId].phase, "starting");
});

test("late or same-code protection failures keep uncertain scope pending", {
  timeout: 10000
}, async (t) => {
  const root = await makeRoot(t);
  const cases = [
    "late reject",
    "late close rejection",
    "late throw",
    "late same-code rejection",
    "same-code throw",
    "never settle"
  ];
  for (const name of cases) {
    const relationId = `relation-uncertain-${name.replaceAll(" ", "-")}`;
    const fixture = makeStartRuntime({ relationId });
    let releaseFailure;
    let markVerificationStarted;
    const verificationStarted = new Promise((resolve) => {
      markVerificationStarted = resolve;
    });
    let markFatal;
    const fatalSeen = new Promise((resolve) => {
      markFatal = resolve;
    });
    let relationHeld = false;
    let settled = false;
    const manager = await open({
      statePath: join(root, `${relationId}.json`),
      runtimeTimeoutMs: 10,
      protectionTimeoutMs: 10,
      protectionSettlementWatchdogMs: 10,
      withExclusiveLock: async (scope, task) => {
        if (scope.scope === "relation") {
          relationHeld = true;
          try {
            return await task();
          } finally {
            relationHeld = false;
          }
        }
        return task();
      },
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: {
        verify() {
          markVerificationStarted();
          if (name === "same-code throw") {
            throw Object.assign(new Error("verifier failed after invocation"), {
              code: "relation_file_service_owner_fatal"
            });
          }
          return new Promise((resolve, reject) => {
            releaseFailure = { reject, resolve };
          });
        }
      },
      onOwnerFatal() {
        markFatal();
      }
    });
    manager.start(startRequest(
      relationId,
      `operation-uncertain-${name.replaceAll(" ", "-")}`
    )).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await withTimeout(verificationStarted);
    if (name === "same-code throw") {
      await withTimeout(fatalSeen);
    } else {
      await withTimeout(fatalSeen);
      if (name === "late reject" || name === "late close rejection") {
        releaseFailure.reject(Object.assign(
          new Error("late verifier rejection"),
          {
            settlement: name === "late close rejection" ? "uncertain" : "unconfirmed",
            settlementCode: "handle_close_failed"
          }
        ));
      }
      if (name === "late throw") {
        releaseFailure.reject(new Error("late verifier throw"));
      }
      if (name === "late same-code rejection") {
        releaseFailure.reject(Object.assign(
          new Error("late verifier rejection with manager error code"),
          { code: "relation_file_service_owner_fatal" }
        ));
      }
    }
    await delay(25);
    assert.equal(settled, false, name);
    assert.equal(relationHeld, true, name);
    assert.equal((await manager.query({ relationId })).state, "starting", name);
    assert.equal(fixture.calls.prepare.length, 0, name);
  }
});

test("fatal latch rejects queued mutations and keeps query read-only", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const relationA = "relation-fatal-a";
  const relationB = "relation-fatal-b";
  const fixture = makeStartRuntime({ relationId: relationA });
  let releaseVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let releaseRelationB;
  let markRelationB;
  const relationBLocked = new Promise((resolve) => {
    markRelationB = resolve;
  });
  const relationBGate = new Promise((resolve) => {
    releaseRelationB = resolve;
  });
  const manager = await open({
    statePath: join(root, "relation-services.json"),
    withExclusiveLock: async (scope, task) => {
      if (scope.scope === "relation" && scope.relationId === relationB) {
        markRelationB();
        await relationBGate;
      }
      return task();
    },
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify() {
        markVerificationStarted();
        return new Promise((resolve) => {
          releaseVerification = resolve;
        });
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-fatal-a"));
  const startB = manager.start(startRequest(relationB, "operation-fatal-b"));
  await relationBLocked;
  await withTimeout(verificationStarted);
  releaseVerification(Promise.reject(Object.assign(
    new Error("unknown protection settlement"),
    { settlement: "unconfirmed" }
  )));
  await withTimeout(fatalSeen);
  releaseRelationB();

  const outcomeB = await withTimeout(startB).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  assert.equal(outcomeB.error.code, "relation_file_service_owner_fatal");
  await assert.rejects(
    () => manager.start(startRequest("relation-fatal-c", "operation-fatal-c")),
    (error) => error?.code === "relation_file_service_owner_fatal"
  );
  await assert.rejects(
    () => manager.disable({
      relationId: relationB,
      identity: identity(relationB),
      operationId: "operation-fatal-b-disable"
    }),
    (error) => error?.code === "relation_file_service_owner_fatal"
  );
  assert.equal((await manager.query({ relationId: relationA })).state, "starting");
  assert.equal(fixture.calls.prepare.length, 0);
  startA.catch(() => {});
});

test("fatal during a durable commit blocks runtime continuation after the issued write", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationA = "relation-commit-fatal-a";
  const relationB = "relation-commit-fatal-b";
  const fixture = makeStartRuntime({ relationId: relationB, port: 41002 });
  let releaseVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let releaseWrite;
  let markWrite;
  const writeStarted = new Promise((resolve) => {
    markWrite = resolve;
  });
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const durableWriter = {
    async write(request) {
      if (request.state.relations[relationB]) {
        markWrite();
        await writeGate;
      }
      await writeFile(request.statePath, JSON.stringify(request.state, null, 2), "utf8");
      return { outcome: "committed" };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter,
    protection: {
      verify({ relationId }) {
        if (relationId === relationA) {
          markVerificationStarted();
          return new Promise((resolve) => {
            releaseVerification = resolve;
          });
        }
        return { digest: "b".repeat(64) };
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-commit-fatal-a"));
  const startB = manager.start(startRequest(
    relationB,
    "operation-commit-fatal-b",
    { launch: { listener: { host: "127.0.0.1", port: 41002 } } }
  ));
  await withTimeout(verificationStarted);
  await withTimeout(writeStarted);
  releaseVerification(Promise.reject(Object.assign(
    new Error("unknown protection settlement"),
    { settlement: "unconfirmed" }
  )));
  await withTimeout(fatalSeen);
  releaseWrite();

  const outcomeB = await withTimeout(startB).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  assert.equal(outcomeB.error.code, "relation_file_service_owner_fatal");
  assert.equal(fixture.calls.prepare.length, 0);
  const visible = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(visible.relations[relationB].phase, "starting");
  startA.catch(() => {});
});

test("fatal during commit-uncertain read blocks the marker writer", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationA = "relation-marker-fatal-a";
  const relationB = "relation-marker-fatal-b";
  const fixture = makeStartRuntime({ relationId: relationB, port: 41002 });
  let rejectVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let relationBWrites = 0;
  const durableWriter = {
    async write(request) {
      if (request.state.relations[relationB]) {
        relationBWrites += 1;
        await writeFile(request.statePath, JSON.stringify(request.state, null, 2), "utf8");
        queueMicrotask(() => {
          queueMicrotask(() => {
            rejectVerification(Object.assign(
              new Error("unknown protection settlement"),
              { settlement: "unconfirmed" }
            ));
          });
        });
        return { outcome: "commit_uncertain" };
      }
      await writeFile(request.statePath, JSON.stringify(request.state, null, 2), "utf8");
      return { outcome: "committed" };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter,
    protection: {
      verify({ relationId }) {
        if (relationId === relationA) {
          markVerificationStarted();
          return new Promise((_resolve, reject) => {
            rejectVerification = reject;
          });
        }
        return { digest: "c".repeat(64) };
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-marker-fatal-a"));
  await withTimeout(verificationStarted);
  const outcomeB = await withTimeout(manager.start(startRequest(
    relationB,
    "operation-marker-fatal-b",
    { launch: { listener: { host: "127.0.0.1", port: 41002 } } }
  ))).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await withTimeout(fatalSeen);

  assert.equal(outcomeB.error.code, "relation_file_service_owner_fatal");
  assert.equal(relationBWrites, 1);
  assert.equal(fixture.calls.prepare.length, 0);
  const visible = await manager.query({ relationId: relationB });
  assert.equal(visible.state, "starting");
  assert.equal(visible.commitUncertain, false);
  startA.catch(() => {});
});

test("allowAfterFatal is limited to exact abort and cleanup inspection", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationA = "relation-cleanup-fatal-a";
  const relationB = "relation-cleanup-fatal-b";
  const runtimeHandle = handle(relationB);
  const runtimeIdentity = runtimeIdentityFor(runtimeHandle, 41002);
  let rejectVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let releasePrepare;
  let markPrepare;
  const prepareStarted = new Promise((resolve) => {
    markPrepare = resolve;
  });
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  let prepareSignal;
  let abortCalls = 0;
  let goCalls = 0;
  let cleanupInspectCalls = 0;
  const runtime = {
    async prepare(_request, details) {
      prepareSignal = details.signal;
      markPrepare();
      await prepareGate;
      return {
        lease: { id: "fatal-cleanup-lease" },
        handle: runtimeHandle,
        runtimeIdentity,
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    },
    async go() {
      goCalls += 1;
      return { ok: true };
    },
    async abort() {
      abortCalls += 1;
      return { containmentConfirmed: true };
    },
    async inspect(observedHandle, details) {
      if (details?.purpose === "cleanup") {
        cleanupInspectCalls += 1;
        return cleanupEvidenceFor(observedHandle);
      }
      return runningEvidenceFor(observedHandle, runtimeIdentity, details?.fence);
    },
    async stop() {
      return { ok: true };
    }
  };
  const manager = await open({
    statePath,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify({ relationId }) {
        if (relationId === relationA) {
          markVerificationStarted();
          return new Promise((_resolve, reject) => {
            rejectVerification = reject;
          });
        }
        return { digest: "d".repeat(64) };
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-cleanup-fatal-a"));
  const startB = manager.start(startRequest(
    relationB,
    "operation-cleanup-fatal-b",
    { launch: { listener: { host: "127.0.0.1", port: 41002 } } }
  ));
  await withTimeout(verificationStarted);
  await withTimeout(prepareStarted);
  rejectVerification(Object.assign(
    new Error("unknown protection settlement"),
    { settlement: "unconfirmed" }
  ));
  await withTimeout(fatalSeen);
  await withTimeout(new Promise((resolve) => {
    const check = () => {
      if (prepareSignal?.aborted) {
        resolve();
        return;
      }
      setTimeout(check, 5);
    };
    check();
  }));
  releasePrepare();

  const outcomeB = await withTimeout(startB).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  assert.equal(outcomeB.error.code, "relation_file_service_owner_fatal");
  assert.equal(abortCalls, 1);
  assert.equal(cleanupInspectCalls, 1);
  assert.equal(goCalls, 0);
  startA.catch(() => {});
});

test("queued late recovery switches to exact cleanup when fatal is already latched", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const relationA = "relation-recovery-fatal-a";
  const relationB = "relation-recovery-fatal-b";
  const runtimeHandle = handle(relationB);
  const runtimeIdentity = runtimeIdentityFor(runtimeHandle, 41003);
  let rejectVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let releasePrepare;
  let markPrepare;
  const prepareStarted = new Promise((resolve) => {
    markPrepare = resolve;
  });
  const prepareGate = new Promise((resolve) => {
    releasePrepare = resolve;
  });
  let relationBLocks = 0;
  let abortCalls = 0;
  let cleanupInspectCalls = 0;
  const cleanupObservations = [];
  const runtime = {
    async prepare(_request, details) {
      markPrepare();
      await prepareGate;
      return {
        lease: { id: "recovery-fatal-lease" },
        handle: runtimeHandle,
        runtimeIdentity,
        provisionalEvidence: provisionalEvidence(),
        fence: details.fence
      };
    },
    async go() {
      throw new Error("go must not run");
    },
    async abort() {
      abortCalls += 1;
      return { containmentConfirmed: true };
    },
    async inspect(observedHandle, details) {
      if (details?.purpose === "cleanup") {
        cleanupInspectCalls += 1;
        cleanupObservations.push({
          handle: observedHandle,
          attemptId: details?.fence?.attemptId
        });
        return unconfirmedCleanupEvidenceFor(observedHandle, "prepare-pending");
      }
      return observation("stopped", observedHandle);
    },
    async stop() {
      return { ok: true };
    }
  };
  const manager = await open({
    statePath: join(root, "relation-services.json"),
    runtimeTimeoutMs: 15,
    protectionTimeoutMs: 1000,
    protectionSettlementWatchdogMs: 1000,
    withExclusiveLock: async (scope, task) => {
      if (scope.scope === "relation" && scope.relationId === relationB) {
        relationBLocks += 1;
      }
      return task();
    },
    runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify({ relationId }) {
        if (relationId === relationA) {
          markVerificationStarted();
          return new Promise((_resolve, reject) => {
            rejectVerification = reject;
          });
        }
        return { digest: "e".repeat(64) };
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-recovery-fatal-a"));
  await withTimeout(verificationStarted);
  await assert.rejects(
    () => manager.start(startRequest(
      relationB,
      "operation-recovery-fatal-b",
      { launch: { listener: { host: "127.0.0.1", port: 41003 } } }
    )),
    (error) => error?.code === "relation_file_service_runtime_timeout"
  );
  await withTimeout(prepareStarted);
  const abortsBeforeRecovery = abortCalls;
  releasePrepare();
  await Promise.resolve();
  await Promise.resolve();
  rejectVerification(Object.assign(
    new Error("unknown protection settlement"),
    { settlement: "unconfirmed" }
  ));
  await withTimeout(fatalSeen);
  await delay(20);

  assert.equal(relationBLocks, 1);
  assert.equal(abortCalls, abortsBeforeRecovery + 1);
  assert.equal(cleanupInspectCalls, 1);
  assert.deepEqual(cleanupObservations[0].handle, runtimeHandle);
  startA.catch(() => {});
});

test("protection applies the monotonic deadline after synchronous digest work", {
  timeout: 5000
}, async (t) => {
  for (const testCase of [
    { name: "just before deadline", completionTime: 109, succeeds: true },
    { name: "at deadline", completionTime: 110, succeeds: false }
  ]) {
    const root = await makeRoot(t);
    const relationId = `relation-deadline-${testCase.name.replaceAll(" ", "-")}`;
    const fixture = makeStartRuntime({ relationId });
    let now = 100;
    let digestObserved = false;
    const manager = await open({
      statePath: join(root, "relation-services.json"),
      protectionTimeoutMs: 10,
      protectionSettlementWatchdogMs: 10,
      monotonicNow: () => now,
      withExclusiveLock: makeLockHarness().withExclusiveLock,
      runtime: fixture.runtime,
      durableWriter: makeDurableWriter().durableWriter,
      protection: {
        verify() {
          return {
            get digest() {
              now = testCase.completionTime;
              digestObserved = true;
              return "a".repeat(64);
            }
          };
        }
      },
      randomBytes: () => Buffer.alloc(16, 44)
    });

    const outcome = await manager.start(startRequest(
      relationId,
      `operation-deadline-${testCase.name.replaceAll(" ", "-")}`
    )).then(
      (value) => ({ value }),
      (error) => ({ error })
    );

    assert.equal(digestObserved, true, testCase.name);
    if (testCase.succeeds) {
      assert.equal(outcome.value.state, "running", testCase.name);
      assert.equal(fixture.calls.prepare.length, 1, testCase.name);
    } else {
      assert.equal(
        outcome.error.code,
        "relation_file_service_start_blocked",
        testCase.name
      );
      assert.equal(fixture.calls.prepare.length, 0, testCase.name);
    }
  }
});

test("protection cancellation remains irreversible when confirmation arrives late", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const relationId = "relation-cancellation-irreversible";
  const fixture = makeStartRuntime({ relationId });
  let protectionSignal;
  let releaseVerification;
  const manager = await open({
    statePath: join(root, "relation-services.json"),
    protectionTimeoutMs: 10,
    protectionSettlementWatchdogMs: 1000,
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify({ signal }) {
        protectionSignal = signal;
        return new Promise((resolve) => {
          releaseVerification = resolve;
        });
      }
    }
  });
  const start = manager.start(startRequest(
    relationId,
    "operation-cancellation-irreversible"
  ));

  await withTimeout(waitForCondition(() => protectionSignal?.aborted === true));
  releaseVerification({ digest: "b".repeat(64) });
  await assert.rejects(
    start,
    (error) => error?.code === "relation_file_service_start_blocked"
  );
  assert.equal(fixture.calls.prepare.length, 0);
});

test("fatal before the bounded operation microtask prevents true invocation", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const relationA = "relation-microtask-fatal-a";
  const relationB = "relation-microtask-fatal-b";
  const fixture = makeStartRuntime({ relationId: relationB });
  let rejectVerificationA;
  let markVerificationAStarted;
  const verificationAStarted = new Promise((resolve) => {
    markVerificationAStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  let armFatalBeforeOperation = false;
  const manager = await open({
    statePath: join(root, "relation-services.json"),
    withExclusiveLock: makeLockHarness().withExclusiveLock,
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify({ relationId }) {
        if (relationId === relationA) {
          markVerificationAStarted();
          return new Promise((_resolve, reject) => {
            rejectVerificationA = reject;
          });
        }
        armFatalBeforeOperation = true;
        return { digest: "c".repeat(64) };
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-microtask-fatal-a"));
  await withTimeout(verificationAStarted);
  const originalPromiseResolve = Promise.resolve;
  Promise.resolve = function resolve(value) {
    if (!armFatalBeforeOperation) {
      return originalPromiseResolve.call(this, value);
    }
    armFatalBeforeOperation = false;
    let releaseOperation;
    const delayedResolution = new Promise((resolve) => {
      releaseOperation = resolve;
    });
    rejectVerificationA(Object.assign(
      new Error("unknown protection settlement"),
      { settlement: "unconfirmed" }
    ));
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      releaseOperation();
    })));
    return delayedResolution;
  };

  let outcomeB;
  try {
    outcomeB = await withTimeout(manager.start(startRequest(
      relationB,
      "operation-microtask-fatal-b"
    ))).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await withTimeout(fatalSeen);
  } finally {
    Promise.resolve = originalPromiseResolve;
  }

  assert.equal(outcomeB.error.code, "relation_file_service_owner_fatal");
  assert.equal(fixture.calls.prepare.length, 0);
  assert.equal(fixture.calls.go.length, 0);
  startA.catch(() => {});
});

test("fatal after relation and state lock acquisition blocks the mutation read", {
  timeout: 5000
}, async (t) => {
  const root = await makeRoot(t);
  const statePath = join(root, "relation-services.json");
  const relationA = "relation-lock-read-fatal-a";
  const relationB = "relation-lock-read-fatal-b";
  const fixture = makeStartRuntime({ relationId: relationA });
  const lock = makeLockHarness();
  let armStateTaskGate = false;
  let releaseStateTask;
  let markStateTaskReached;
  const stateTaskReached = new Promise((resolve) => {
    markStateTaskReached = resolve;
  });
  const stateTaskGate = new Promise((resolve) => {
    releaseStateTask = resolve;
  });
  let rejectVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise((resolve) => {
    markVerificationStarted = resolve;
  });
  let markFatal;
  const fatalSeen = new Promise((resolve) => {
    markFatal = resolve;
  });
  const manager = await open({
    statePath,
    withExclusiveLock(scope, task) {
      const wrappedTask = scope.scope === "state" && armStateTaskGate
        ? async () => {
          armStateTaskGate = false;
          markStateTaskReached();
          await stateTaskGate;
          return task();
        }
        : task;
      return lock.withExclusiveLock(scope, wrappedTask);
    },
    runtime: fixture.runtime,
    durableWriter: makeDurableWriter().durableWriter,
    protection: {
      verify() {
        markVerificationStarted();
        return new Promise((_resolve, reject) => {
          rejectVerification = reject;
        });
      }
    },
    onOwnerFatal() {
      markFatal();
    }
  });
  const startA = manager.start(startRequest(relationA, "operation-lock-read-fatal-a"));
  await withTimeout(verificationStarted);
  armStateTaskGate = true;
  const disableB = manager.disable({
    relationId: relationB,
    identity: identity(relationB),
    operationId: "operation-lock-read-fatal-b"
  });
  await withTimeout(stateTaskReached);

  rejectVerification(Object.assign(
    new Error("unknown protection settlement"),
    { settlement: "unconfirmed" }
  ));
  await withTimeout(fatalSeen);
  await writeFile(statePath, "{invalid after fatal", "utf8");
  releaseStateTask();

  await assert.rejects(
    disableB,
    (error) => error?.code === "relation_file_service_owner_fatal"
  );
  assert.equal(await readFile(statePath, "utf8"), "{invalid after fatal");
  startA.catch(() => {});
});
