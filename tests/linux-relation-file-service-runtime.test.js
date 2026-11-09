import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  SupervisorClient,
  createDefaultProbe,
  createLinuxRelationFileServiceRuntime,
  createLinuxSftpRelationFileServiceRuntime,
  parseTcpTableText,
  stableSerialize,
  tcpStateIsActiveSession
} from "../src/core/linuxRelationFileServiceRuntime.js";
import { open as openRelationFileServiceManager } from "../src/core/relationFileServiceManager.js";

const RUNNING_KEYS = [
  "capabilities",
  "children",
  "executable",
  "fenceDigest",
  "handleDigest",
  "listener",
  "namespace",
  "noNewPrivs",
  "observedAt",
  "parentDeathSignal",
  "process",
  "runtimeIdentityDigest",
  "schemaVersion",
  "sessions",
  "tokenSha256"
];

const CLEANUP_KEYS = [
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
];

const ZERO_CAPABILITIES = {
  ambient: "0000000000000000",
  bounding: "0000000000000000",
  effective: "0000000000000000",
  inheritable: "0000000000000000",
  permitted: "0000000000000000"
};

function startFence(relationId = "relation-runtime", generation = "1") {
  return {
    schemaVersion: "1",
    relationId,
    operationId: "operation-start",
    generation,
    attemptId: "attempt-start",
    expectedHandleDigest: "",
    protectionDigest: "1".repeat(64)
  };
}

function disableFence(relationId = "relation-runtime", generation = "1") {
  return {
    schemaVersion: "1",
    relationId,
    operationId: "operation-disable",
    generation,
    attemptId: "attempt-disable",
    expectedHandleDigest: null,
    protectionDigest: null
  };
}

function runtimePathOptions() {
  return {
    supervisorPath: path.resolve("fake-supervisor"),
    execServicePath: path.resolve("fake-exec-service"),
    signalServicePath: path.resolve("fake-signal-service"),
    rclonePath: path.resolve("fake-rclone"),
    rootPath: path.resolve("fake-root"),
    authorizedKeysPath: path.resolve("fake-authorized-keys"),
    hostKeyPath: path.resolve("fake-host-key"),
    cwd: path.resolve("."),
    requestTimeoutMs: 1000,
    releaseTimeoutMs: 1000,
    randomBytes: () => Buffer.alloc(16, 7),
    clock: () => new Date("2026-10-21T12:00:00.000Z")
  };
}

test("SFTP runtime uses explicit service flags while preserving V1 rclone flags", async () => {
  const v2Supervisor = new FakeSupervisor();
  let v2Args;
  const { rclonePath: _unusedRclonePath, ...v2PathOptions } = runtimePathOptions();
  const v2 = createLinuxSftpRelationFileServiceRuntime({
    ...v2PathOptions,
    servicePath: path.resolve("fake-sftp-service"),
    serviceUser: "sfsc",
    spawnSupervisor(options) {
      v2Args = options.args;
      return v2Supervisor;
    }
  });
  const prepared = await v2.prepare({
    launch: { listener: { host: "127.0.0.1", port: 42022 } }
  }, { fence: startFence("relation-v2") });
  assert.deepEqual(v2Args, [
    "--exec-service", path.resolve("fake-exec-service"),
    "--signal-service", path.resolve("fake-signal-service"),
    "--service", path.resolve("fake-sftp-service"),
    "--user", "sfsc",
    "--root", path.resolve("fake-root"),
    "--authorized-keys", path.resolve("fake-authorized-keys"),
    "--host-key", path.resolve("fake-host-key")
  ]);
  assert.equal(v2Args.includes("--rclone"), false);
  assert.equal(v2Supervisor.calls.prepare[0].version, 1);
  assert.equal(prepared.handle.relationId, "relation-v2");
  await v2.go(prepared.lease, { fence: startFence("relation-v2") });
  assert.equal(v2Supervisor.calls.go[0].version, 1);
  const observed = await v2.inspect(prepared.handle, {
    purpose: "running",
    fence: startFence("relation-v2")
  });
  assert.deepEqual(Object.keys(observed).sort(), RUNNING_KEYS.slice().sort());
  assert.equal(v2Supervisor.calls.inspect[0].token, prepared.handle.token);
  await v2.abort(prepared.lease, { fence: startFence("relation-v2") });
  assert.equal(v2Supervisor.calls.cleanup.length, 1);

  let v1Args;
  const v1 = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    spawnSupervisor(options) {
      v1Args = options.args;
      return new FakeSupervisor();
    }
  });
  const v1Prepared = await v1.prepare({
    launch: { listener: { host: "127.0.0.1", port: 42022 } }
  }, { fence: startFence("relation-v1") });
  assert.deepEqual(v1Args.slice(4, 6), ["--rclone", path.resolve("fake-rclone")]);
  assert.equal(v1Args.includes("--service"), false);
  await v1.abort(v1Prepared.lease, { fence: startFence("relation-v1") });
});

test("SFTP runtime rejects missing, invalid, or mixed service configuration", () => {
  const { rclonePath: _unusedRclonePath, ...base } = runtimePathOptions();
  assert.throws(() => createLinuxSftpRelationFileServiceRuntime(base), /runtime_servicePath_invalid/);
  assert.throws(() => createLinuxSftpRelationFileServiceRuntime({
    ...base, servicePath: path.resolve("service")
  }), /runtime_service_user_invalid/);
  assert.throws(() => createLinuxSftpRelationFileServiceRuntime({
    ...base, servicePath: "relative", serviceUser: "sfsc"
  }), /runtime_servicePath_invalid/);
  assert.throws(() => createLinuxSftpRelationFileServiceRuntime({
    ...base, servicePath: path.resolve("service"), serviceUser: "Bad User"
  }), /runtime_service_user_invalid/);
  assert.throws(() => createLinuxSftpRelationFileServiceRuntime({
    ...base, servicePath: path.resolve("service"), serviceUser: "sfsc", rclonePath: path.resolve("rclone")
  }), /runtime_service_mode_rclone_path_forbidden/);
  assert.doesNotThrow(() => createLinuxRelationFileServiceRuntime(runtimePathOptions()));
});

function managerIdentity(label) {
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

function managerStartRequest(relationId, operationId) {
  return {
    relationId,
    operationId,
    identity: managerIdentity(relationId),
    expectedHandleDigest: "",
    launch: {
      target: "rclone-serve-sftp",
      listener: {
        host: "127.0.0.1",
        port: 42022
      }
    }
  };
}

function makeManagerLockHarness() {
  const tails = new Map();
  return async function withExclusiveLock(scope, task) {
    const previous = tails.get(scope.lockPath) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    tails.set(scope.lockPath, current);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (tails.get(scope.lockPath) === current) {
        tails.delete(scope.lockPath);
      }
    }
  };
}

function makeManagerDurableWriter() {
  return {
    async write(request) {
      await writeFile(
        request.statePath,
        JSON.stringify(request.state, null, 2),
        "utf8"
      );
      return {
        outcome: "committed",
        stages: ["parent_fsync_returned"],
        expectedRevision: request.expectedRevision
      };
    }
  };
}

async function waitForManagerState(manager, relationId, expectedState) {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const snapshot = await manager.query({ relationId });
    if (snapshot.state === expectedState) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`manager did not reach ${expectedState}`);
}

async function captureSpawnEnvironment(options, relationId) {
  let spawnedEnvironment;
  const runtime = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    spawnSupervisor(spawnOptions) {
      spawnedEnvironment = spawnOptions.env;
      return new FakeSupervisor();
    },
    ...options
  });
  await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: startFence(relationId) }
  );
  assert.ok(spawnedEnvironment, "supervisor environment was not captured");
  return spawnedEnvironment;
}

function assertActualProcessEnvironmentCopy(environment) {
  assert.equal(Object.getPrototypeOf(environment), Object.prototype);
  assert.notEqual(environment, process.env);
  const keys = Object.keys(process.env);
  assert.equal(Object.keys(environment).length, keys.length);
  for (const key of keys) {
    assert.equal(
      Object.hasOwn(environment, key),
      true,
      `missing copied environment key ${key}`
    );
    assert.equal(
      typeof environment[key],
      "string",
      `non-string copied environment value for ${key}`
    );
    assert.equal(
      environment[key] === process.env[key],
      true,
      `environment copy mismatch for ${key}`
    );
  }
}

function fakeOptions(overrides = {}) {
  const supervisor = new FakeSupervisor(overrides.supervisorOptions);
  const calls = supervisor.calls;
  const runtime = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    env: {},
    spawnSupervisor: () => supervisor,
    probe: overrides.probe || {
      async processGone() {
        return true;
      },
      async listenerClosed() {
        return true;
      },
      async sessionsGone() {
        return true;
      }
    },
    ...overrides.runtime
  });
  return { runtime, supervisor, calls };
}

test("omitted env copies the actual process environment", async () => {
  const environment = await captureSpawnEnvironment(
    {},
    "relation-default-env-omitted"
  );
  assertActualProcessEnvironmentCopy(environment);
});

test("null env copies the actual process environment", async () => {
  const environment = await captureSpawnEnvironment(
    { env: null },
    "relation-default-env-null"
  );
  assertActualProcessEnvironmentCopy(environment);
});

test("explicit env remains strict while copies are defensive and stringified", async () => {
  const explicitEnvironment = {
    COUNT: 7,
    ENABLED: true
  };
  let spawnedEnvironment;
  const runtime = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    env: explicitEnvironment,
    spawnSupervisor(spawnOptions) {
      spawnedEnvironment = spawnOptions.env;
      return new FakeSupervisor();
    }
  });
  await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: startFence("relation-explicit-env") }
  );

  explicitEnvironment.COUNT = 9;
  explicitEnvironment.ADDED_LATE = "not-copied";
  assert.notEqual(spawnedEnvironment, explicitEnvironment);
  assert.deepEqual(spawnedEnvironment, {
    COUNT: "7",
    ENABLED: "true"
  });

  for (const env of [process.env, Object.create(null), []]) {
    assert.throws(
      () => createLinuxRelationFileServiceRuntime({
        ...runtimePathOptions(),
        env
      }),
      /runtime_env_invalid/
    );
  }
});

test("running inspect returns the manager exact evidence shape and private tuples", async () => {
  const { runtime, calls } = fakeOptions();
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  assert.deepEqual(await runtime.go(prepared.lease, { fence }), { ok: true });

  const evidence = await runtime.inspect(prepared.handle, { fence, purpose: "running" });

  assert.deepEqual(Object.keys(evidence).sort(), RUNNING_KEYS.slice().sort());
  assert.equal(evidence.process.pid, "310");
  assert.equal(evidence.process.parentPid, "300");
  assert.equal(evidence.listener.role, "observed");
  assert.equal(evidence.sessions.count, 1);
  assert.equal(evidence.sessions.tracked, true);
  assert.equal(evidence.children.allTracked, true);
  assert.deepEqual(evidence.capabilities, ZERO_CAPABILITIES);
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.go.length, 1);
  assert.equal(calls.inspect.at(-1).purpose, "running");
});

test("initial startup accepts only the reviewed transients and commits once", async () => {
  const observations = [];
  const { runtime, calls } = fakeOptions({
    supervisorOptions: {
      inspectResponses: [
        startingObservation("launcher_exact"),
        startingObservation("listener_absent"),
        startingObservation("children_census_unstable"),
        runningObservation("running")
      ]
    },
    runtime: {
      startupProbeIntervalMs: 1,
      onObservation(value) {
        observations.push(value);
      }
    }
  });
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });

  const evidence = await runtime.inspect(prepared.handle, {
    fence,
    purpose: "running"
  });

  assert.equal(evidence.schemaVersion, "1");
  assert.equal(calls.inspect.length, 4);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].sessions, runningObservation("running").sessions);
});

test("persistent starting reaches the internal startup deadline", async () => {
  const { runtime, calls } = fakeOptions({
    supervisorOptions: {
      inspectHandler: async () => startingObservation("listener_absent")
    },
    runtime: {
      startupProbeIntervalMs: 1,
      startupReadyTimeoutMs: 8
    }
  });
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });

  const result = await runtime.inspect(prepared.handle, {
    fence,
    purpose: "running"
  });

  assert.deepEqual(result, {
    owned: false,
    reason: "runtime_startup_timeout"
  });
  assert.ok(calls.inspect.length >= 1);
});

test("late starting after abort cannot continue polling", async () => {
  const pending = deferred();
  const { runtime, calls } = fakeOptions({
    supervisorOptions: {
      inspectHandler: async () => pending.promise
    }
  });
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });
  const controller = new AbortController();
  const inspection = runtime.inspect(prepared.handle, {
    fence,
    purpose: "running",
    signal: controller.signal
  });
  await flushMicrotasks();
  controller.abort();
  pending.resolve(startingObservation("launcher_exact"));

  assert.deepEqual(await inspection, {
    owned: false,
    reason: "runtime_startup_aborted"
  });
  assert.equal(calls.inspect.length, 1);
});

test("late running after abort or deadline is never published", async (t) => {
  for (const mode of ["abort", "deadline"]) {
    await t.test(mode, async () => {
      const pending = deferred();
      const observations = [];
      let monotonic = 0;
      const { runtime, supervisor } = fakeOptions({
        supervisorOptions: {
          inspectHandler: async () => pending.promise
        },
        runtime: {
          monotonicNow: () => monotonic,
          startupProbeIntervalMs: 1,
          startupReadyTimeoutMs: 10,
          onObservation(value) {
            observations.push(value);
          }
        }
      });
      const fence = startFence();
      const prepared = await runtime.prepare(
        { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
        { fence }
      );
      await runtime.go(prepared.lease, { fence });
      const controller = new AbortController();
      const inspection = runtime.inspect(prepared.handle, {
        fence,
        purpose: "running",
        signal: controller.signal
      });
      await flushMicrotasks();
      if (mode === "abort") {
        controller.abort();
      } else {
        monotonic = 10;
      }
      pending.resolve(runningObservation("running"));

      assert.deepEqual(await inspection, {
        owned: false,
        reason: mode === "abort"
          ? "runtime_startup_aborted"
          : "runtime_startup_timeout"
      });
      assert.equal(observations.length, 0);

      supervisor.closed = true;
      const cleanup = await runtime.inspect(prepared.handle, {
        fence,
        purpose: "cleanup"
      });
      assert.equal(cleanup.lastRuntimeCheckpoint, "go-returned");
    });
  }
});

test("malformed starting, reason mismatch and hard errors never retry", async (t) => {
  const cases = {
    "extra field": () => ({
      ...startingObservation("launcher_exact"),
      unexpected: true
    }),
    "reason mismatch": () => ({
      ...startingObservation("launcher_exact"),
      observedExecutable: fileIdentity("22")
    }),
    "hard error": () => {
      const error = new Error("target_executable_mismatch");
      error.code = "target_executable_mismatch";
      throw error;
    }
  };
  for (const [name, response] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { runtime, calls } = fakeOptions({
        supervisorOptions: {
          inspectHandler: async () => response()
        }
      });
      const fence = startFence();
      const prepared = await runtime.prepare(
        { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
        { fence }
      );
      await runtime.go(prepared.lease, { fence });

      assert.deepEqual(
        await runtime.inspect(prepared.handle, {
          fence,
          purpose: "running"
        }),
        { owned: false, reason: "runtime_inspect_failed" }
      );
      assert.equal(calls.inspect.length, 1);
    });
  }
});

test("real request timeout preempts initial startup without retry", async () => {
  const harness = framedSupervisorClient({
    requestTimeoutMs: 10,
    inspectHandler: async () => new Promise(() => {})
  });
  const observations = [];
  const runtime = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    env: {},
    requestTimeoutMs: 10,
    startupProbeIntervalMs: 1,
    startupReadyTimeoutMs: 200,
    spawnSupervisor: () => harness.client,
    onObservation(value) {
      observations.push(value);
    }
  });
  const fence = startFence("relation-real-request-timeout");
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });

  assert.deepEqual(
    await runtime.inspect(prepared.handle, {
      fence,
      purpose: "running"
    }),
    { owned: false, reason: "runtime_inspect_failed" }
  );
  assert.equal(harness.calls.inspect.length, 1);
  assert.equal(observations.length, 0);
  harness.close();
});

test("request timeout beyond the startup budget cannot delay internal timeout", async () => {
  const harness = framedSupervisorClient({
    requestTimeoutMs: 3100,
    inspectHandler: async () => startingObservation("listener_absent")
  });
  const runtime = createLinuxRelationFileServiceRuntime({
    ...runtimePathOptions(),
    env: {},
    requestTimeoutMs: 3100,
    startupProbeIntervalMs: 50,
    startupReadyTimeoutMs: 20,
    spawnSupervisor: () => harness.client
  });
  const fence = startFence("relation-request-beyond-startup");
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });

  assert.deepEqual(
    await runtime.inspect(prepared.handle, {
      fence,
      purpose: "running"
    }),
    { owned: false, reason: "runtime_startup_timeout" }
  );
  assert.equal(harness.calls.inspect.length, 1);
  harness.close();
});

test("manager outer timeout keeps a late running continuation non-running", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sfsc-r8-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "relation-services.json");
  const relationId = "relation-manager-outer-timeout";
  const pending = deferred();
  const observations = [];
  const { runtime, supervisor, calls } = fakeOptions({
    supervisorOptions: {
      inspectHandler: async (payload) => (
        payload.purpose === "running"
          ? pending.promise
          : runningObservation(payload.purpose)
      )
    },
    runtime: {
      startupProbeIntervalMs: 1,
      startupReadyTimeoutMs: 200,
      onObservation(value) {
        observations.push(value);
      }
    }
  });
  const manager = await openRelationFileServiceManager({
    statePath,
    withExclusiveLock: makeManagerLockHarness(),
    runtime,
    durableWriter: makeManagerDurableWriter(),
    protection: {
      async verify() {
        return { digest: "c".repeat(64) };
      }
    },
    runtimeTimeoutMs: 20
  });

  await assert.rejects(
    () => manager.start(managerStartRequest(
      relationId,
      "operation-manager-outer-timeout"
    )),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  const blockedState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(
    blockedState.relations[relationId].cleanupEvidence.continuationRegistered,
    true
  );
  pending.resolve(runningObservation("running"));
  const snapshot = await waitForManagerState(manager, relationId, "start_failed");

  assert.equal(snapshot.runningEvidencePresent, false);
  assert.equal(observations.length, 0);
  assert.equal(
    calls.inspect.filter((call) => call.purpose === "running").length,
    1
  );
  assert.ok(calls.inspect.some((call) => call.purpose === "cleanup"));

  supervisor.closed = true;
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.relations[relationId].phase, "start_failed");
});

test("manager timeout beyond 3000 ms yields to the adapter startup budget", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sfsc-r8-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "relation-services.json");
  const relationId = "relation-manager-inner-timeout";
  const observations = [];
  const { runtime, calls } = fakeOptions({
    supervisorOptions: {
      inspectHandler: async () => startingObservation("listener_absent")
    },
    runtime: {
      startupProbeIntervalMs: 1,
      startupReadyTimeoutMs: 20,
      onObservation(value) {
        observations.push(value);
      }
    }
  });
  const manager = await openRelationFileServiceManager({
    statePath,
    withExclusiveLock: makeManagerLockHarness(),
    runtime,
    durableWriter: makeManagerDurableWriter(),
    protection: {
      async verify() {
        return { digest: "c".repeat(64) };
      }
    },
    runtimeTimeoutMs: 3100
  });
  const started = Date.now();

  await assert.rejects(
    () => manager.start(managerStartRequest(
      relationId,
      "operation-manager-inner-timeout"
    )),
    (error) => error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
  );
  assert.ok(Date.now() - started < 1000);
  const snapshot = await waitForManagerState(manager, relationId, "start_failed");

  assert.equal(snapshot.runningEvidencePresent, false);
  assert.equal(observations.length, 0);
  assert.ok(calls.inspect.some((call) => call.purpose === "running"));
  assert.ok(calls.inspect.some((call) => call.purpose === "cleanup"));
});

test("running state performs one strict inspect and never retries", async () => {
  const { runtime, supervisor, calls } = fakeOptions();
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });
  await runtime.inspect(prepared.handle, { fence, purpose: "running" });
  supervisor.options.inspectHandler = async () => {
    const error = new Error("runtime_supervisor_timeout");
    error.code = "runtime_supervisor_timeout";
    throw error;
  };
  const before = calls.inspect.length;

  assert.deepEqual(
    await runtime.inspect(prepared.handle, {
      fence,
      purpose: "running"
    }),
    { owned: false, reason: "runtime_inspect_failed" }
  );
  assert.equal(calls.inspect.length, before + 1);
});

test("disable accepts a new fence and releases only after closure plus independent probes", async () => {
  const { runtime, supervisor, calls } = fakeOptions();
  const start = startFence();
  const disable = disableFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: start }
  );
  await runtime.go(prepared.lease, { fence: start });
  await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });

  const first = await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });
  assert.equal(first.phase, "running");
  await runtime.stop(prepared.handle, { fence: disable, purpose: "disable" });
  const stopped = await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });

  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.childrenExited, true);
  assert.equal(stopped.supervisorExited, true);
  assert.equal(supervisor.released, true);
  assert.equal(calls.cleanup.at(-1).mode, "stop");
  assert.equal(calls.inspect.at(-1).purpose, "disable");

  const inspectCount = calls.inspect.length;
  const cached = await runtime.inspect(prepared.handle, {
    fence: disable,
    purpose: "disable"
  });
  assert.deepEqual(cached, stopped);
  assert.equal(calls.inspect.length, inspectCount);
});

test("abort and stop share cleanup and cleanup inspect returns exact confirmed evidence", async () => {
  const { runtime, supervisor, calls } = fakeOptions();
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });
  await runtime.inspect(prepared.handle, { fence, purpose: "running" });

  assert.deepEqual(
    await runtime.abort(prepared.lease, { fence }),
    { containmentConfirmed: true }
  );
  const cleanup = await runtime.inspect(prepared.handle, { fence, purpose: "cleanup" });

  assert.deepEqual(Object.keys(cleanup).sort(), CLEANUP_KEYS.slice().sort());
  assert.equal(cleanup.disposition, "confirmedStopped");
  assert.equal(cleanup.abortRequested, true);
  assert.equal(cleanup.abortCompleted, true);
  assert.equal(cleanup.containmentConfirmed, true);
  assert.equal(cleanup.childrenExited, true);
  assert.equal(cleanup.reasonCode, "cleanup_confirmed_stopped");
  assert.equal(supervisor.released, true);
  assert.equal(calls.cleanup.at(-1).mode, "abort");

  const cached = await runtime.inspect(prepared.handle, { fence, purpose: "cleanup" });
  assert.deepEqual(cached, cleanup);
});

test("failed cleanup session census remains unconfirmed and does not release", async () => {
  const { runtime, supervisor } = fakeOptions({
    supervisorOptions: {
      cleanupSessionsClosed: false
    }
  });
  const fence = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence }
  );
  await runtime.go(prepared.lease, { fence });
  await runtime.inspect(prepared.handle, { fence, purpose: "running" });

  assert.deepEqual(
    await runtime.abort(prepared.lease, { fence }),
    { containmentConfirmed: false }
  );
  const cleanup = await runtime.inspect(prepared.handle, {
    fence,
    purpose: "cleanup"
  });

  assert.equal(cleanup.disposition, "unconfirmed");
  assert.equal(cleanup.containmentConfirmed, false);
  assert.equal(cleanup.sessionsClosed, false);
  assert.equal(supervisor.released, false);
});

test("independent process probe failure prevents release and stopped evidence", async () => {
  let released = false;
  const { runtime, supervisor } = fakeOptions({
    probe: {
      async processGone() {
        return false;
      },
      async listenerClosed() {
        return true;
      },
      async sessionsGone() {
        return true;
      }
    }
  });
  const start = startFence();
  const disable = disableFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: start }
  );
  await runtime.go(prepared.lease, { fence: start });
  await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });
  await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });
  await runtime.stop(prepared.handle, { fence: disable, purpose: "disable" });

  const observed = await runtime.inspect(prepared.handle, {
    fence: disable,
    purpose: "disable"
  });

  assert.equal(observed.owned, false);
  assert.equal(observed.reason, "runtime_stop_evidence_incomplete");
  assert.equal(supervisor.released, false);
  assert.equal(released, false);
});

test("unknown lease and mismatched fence fail closed", async () => {
  const { runtime } = fakeOptions();
  await assert.rejects(
    () => runtime.go({ leaseId: "unknown" }, { fence: startFence() }),
    /runtime_lease_unknown/
  );

  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: startFence() }
  );
  await assert.rejects(
    () => runtime.go(prepared.lease, {
      fence: startFence("relation-other")
    }),
    /runtime_fence_mismatch/
  );
});

test("start and disable operation IDs are bound to their exact operations", async () => {
  const { runtime } = fakeOptions();
  const start = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: start }
  );
  await assert.rejects(
    () => runtime.go(prepared.lease, {
      fence: { ...start, operationId: "operation-start-other" }
    }),
    /runtime_fence_mismatch/
  );
  await runtime.go(prepared.lease, { fence: start });
  await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });

  const disable = disableFence();
  await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });
  await assert.rejects(
    () => runtime.inspect(prepared.handle, {
      fence: { ...disable, operationId: "operation-disable-other" },
      purpose: "disable"
    }),
    /runtime_fence_mismatch/
  );
});

test("disable rejects fences that still carry start authority digests", async () => {
  const { runtime } = fakeOptions();
  const start = startFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: start }
  );
  await runtime.go(prepared.lease, { fence: start });
  await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });

  await assert.rejects(
    () => runtime.inspect(prepared.handle, {
      fence: { ...disableFence(), expectedHandleDigest: "a".repeat(64) },
      purpose: "disable"
    }),
    /runtime_disable_fence_invalid/
  );
  await assert.rejects(
    () => runtime.inspect(prepared.handle, {
      fence: { ...disableFence(), protectionDigest: "b".repeat(64) },
      purpose: "disable"
    }),
    /runtime_disable_fence_invalid/
  );
});

test("release exit code or signal failure prevents stopped evidence", async (t) => {
  for (const releaseExit of [
    { code: 1, signal: null },
    { code: null, signal: "SIGKILL" }
  ]) {
    await t.test(JSON.stringify(releaseExit), async () => {
      const { runtime } = fakeOptions({
        supervisorOptions: { releaseExit }
      });
      const start = startFence();
      const disable = disableFence();
      const prepared = await runtime.prepare(
        { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
        { fence: start }
      );
      await runtime.go(prepared.lease, { fence: start });
      await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });
      await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });
      await runtime.stop(prepared.handle, { fence: disable, purpose: "disable" });

      const observed = await runtime.inspect(prepared.handle, {
        fence: disable,
        purpose: "disable"
      });
      assert.equal(observed.owned, false);
      assert.equal(observed.reason, "runtime_release_unconfirmed");
    });
  }
});

test("manager PID probe failure prevents release confirmation", async () => {
  const { runtime, supervisor } = fakeOptions({
    probe: {
      async processGone(identity) {
        return identity.pid === "310";
      },
      async listenerClosed() {
        return true;
      },
      async sessionsGone() {
        return true;
      }
    }
  });
  const start = startFence();
  const disable = disableFence();
  const prepared = await runtime.prepare(
    { launch: { listener: { host: "127.0.0.1", port: 42022 } } },
    { fence: start }
  );
  await runtime.go(prepared.lease, { fence: start });
  await runtime.inspect(prepared.handle, { fence: start, purpose: "running" });
  await runtime.inspect(prepared.handle, { fence: disable, purpose: "disable" });
  await runtime.stop(prepared.handle, { fence: disable, purpose: "disable" });

  const observed = await runtime.inspect(prepared.handle, {
    fence: disable,
    purpose: "disable"
  });
  assert.equal(observed.owned, false);
  assert.equal(observed.reason, "runtime_release_unconfirmed");
  assert.equal(supervisor.released, true);
});

test("TCP table parsing is strict and only ESTABLISHED counts as a session", () => {
  const header = [
    "sl",
    "local_address",
    "rem_address",
    "st",
    "tx_queue",
    "rx_queue",
    "tr",
    "tm->when",
    "retrnsmt",
    "uid",
    "timeout",
    "inode"
  ].join(" ");
  const entries = parseTcpTableText([
    header,
    "0: 0100007F:1F90 0100007F:C350 01 0:0 00:0 0 0 0 61",
    "1: 0100007F:1F90 0100007F:C351 06 0:0 00:0 0 0 0 62",
    ""
  ].join("\n"), "tcp");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].localAddress, "0100007F");
  assert.equal(entries[0].state, "01");
  assert.equal(tcpStateIsActiveSession(entries[0].state), true);
  assert.equal(tcpStateIsActiveSession(entries[1].state), false);

  for (const malformed of [
    "",
    `${header}\n0: short`,
    `${header}\n0: nothex:1F90 0100007F:C350 01 0:0 00:0 0 0 0 61`,
    `${header}\n0: 0100007F:1F90 0100007F:C350 1 0:0 00:0 0 0 0 61`,
    `${header}\n0: 0100007F:1F90 0100007F:C350 01 0:0 00:0 0 0 0 inode`
  ]) {
    assert.throws(() => parseTcpTableText(malformed, "tcp"), /runtime_tcp_tcp_/);
  }
});

test("TCP6 parsing accepts the captured N1 header and preserves strict labels", () => {
  const capturedHeader =
    "  sl  local_address                         remote_address                        " +
    "st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const establishedRow =
    "0: 00000000000000000000000001000000:1F90 " +
    "00000000000000000000000001000000:C350 " +
    "01 0:0 00:0 0 0 0 61";
  const entries = parseTcpTableText(
    `${capturedHeader}\n${establishedRow}\n`,
    "/proc/self/net/tcp6"
  );
  assert.deepEqual(entries, [{
    localAddress: "00000000000000000000000001000000",
    localPort: 8080,
    remoteAddress: "00000000000000000000000001000000",
    remotePort: 50000,
    state: "01",
    inode: "61"
  }]);
  assert.equal(tcpStateIsActiveSession(entries[0].state), true);

  const legacyHeader = capturedHeader.replace(
    "remote_address",
    "rem_address"
  );
  assert.equal(parseTcpTableText(`${legacyHeader}\n${establishedRow}\n`).length, 1);

  for (const label of [
    "remote-address",
    "remoteaddr",
    "Remote_address",
    "remote_addresses"
  ]) {
    const nearMiss = capturedHeader.replace("remote_address", label);
    assert.throws(
      () => parseTcpTableText(`${nearMiss}\n${establishedRow}\n`, "tcp6"),
      /runtime_tcp_tcp6_header_invalid/
    );
  }
});

test("empty cached tuples cannot mask a current listener-port transport", async () => {
  const listener = { host: "127.0.0.1", port: 42022 };
  const entries = [{
    localAddress: "0100007F",
    localPort: 42022,
    remoteAddress: "0100007F",
    remotePort: 51001,
    state: "01",
    inode: "62"
  }];
  const probe = createDefaultProbe({
    async readTcpTables() {
      return entries;
    }
  });

  assert.equal(await probe.sessionsGone([], listener), false);
  const wrongPortProbe = createDefaultProbe({
    async readTcpTables() {
      return [{ ...entries[0], localPort: 42023 }];
    }
  });
  assert.equal(await wrongPortProbe.sessionsGone([], listener), true);
  const residualProbe = createDefaultProbe({
    async readTcpTables() {
      return [{ ...entries[0], state: "06" }];
    }
  });
  assert.equal(await residualProbe.sessionsGone([], listener), true);
  const failedProbe = createDefaultProbe({
    async readTcpTables() {
      throw new Error("tcp table unavailable");
    }
  });
  await assert.rejects(
    failedProbe.sessionsGone([], listener),
    /tcp table unavailable/
  );
});

test("SupervisorClient stdin error, close and exit reject pending once", async () => {
  const child = fakeSupervisorChild();
  const client = new SupervisorClient(child, 1000);
  let rejectionCount = 0;
  const request = client.request({ requestId: "request-race" }).catch((error) => {
    rejectionCount += 1;
    throw error;
  });

  assert.equal(client.pending.size, 1);
  child.stdin.emit("error", new Error("stdin failed"));
  child.stdin.emit("close");
  child.emit("exit", 1, null);

  await assert.rejects(request, /runtime_supervisor_stdin_failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectionCount, 1);
  assert.equal(client.pending.size, 0);
  const bytesWritten = child.stdin.bytesWritten;
  await assert.rejects(
    client.request({ requestId: "after-failure" }),
    /runtime_supervisor_unavailable/
  );
  assert.equal(child.stdin.bytesWritten, bytesWritten);
});

test("SupervisorClient child exit rejects pending and blocks later writes", async () => {
  const child = fakeSupervisorChild();
  const client = new SupervisorClient(child, 1000);
  const request = client.request({ requestId: "exit-only" });

  child.emit("exit", 1, null);
  await assert.rejects(request, /runtime_supervisor_exited/);
  assert.equal(client.pending.size, 0);
  await assert.rejects(
    client.request({ requestId: "after-exit" }),
    /runtime_supervisor_unavailable/
  );
});

test("SupervisorClient stdin close rejects pending and blocks later writes", async () => {
  const child = fakeSupervisorChild();
  const client = new SupervisorClient(child, 1000);
  const request = client.request({ requestId: "close-only" });

  child.stdin.emit("close");
  await assert.rejects(request, /runtime_supervisor_stdin_closed/);
  assert.equal(client.pending.size, 0);
  await assert.rejects(
    client.request({ requestId: "after-close" }),
    /runtime_supervisor_unavailable/
  );
});

test("SupervisorClient rejects synchronous stdin write failures", async () => {
  const stdin = new EventEmitter();
  Object.assign(stdin, {
    destroyed: false,
    writable: true,
    writableEnded: false,
    write() {
      throw new Error("synchronous write failure");
    }
  });
  const child = fakeSupervisorChild({ stdin });
  const client = new SupervisorClient(child, 1000);

  await assert.rejects(
    client.request({ requestId: "sync-write" }),
    /runtime_supervisor_stdin_failed/
  );
  assert.equal(client.pending.size, 0);
  await assert.rejects(
    client.request({ requestId: "after-sync-write" }),
    /runtime_supervisor_unavailable/
  );
});

test("SupervisorClient rejects asynchronous stdin write failures", async () => {
  const stdin = new EventEmitter();
  Object.assign(stdin, {
    destroyed: false,
    writable: true,
    writableEnded: false,
    write(_frame, callback) {
      queueMicrotask(() => callback(new Error("asynchronous write failure")));
      return false;
    }
  });
  const child = fakeSupervisorChild({ stdin });
  const client = new SupervisorClient(child, 1000);

  await assert.rejects(
    client.request({ requestId: "async-write" }),
    /runtime_supervisor_stdin_failed/
  );
  assert.equal(client.pending.size, 0);
  await assert.rejects(
    client.request({ requestId: "after-async-write" }),
    /runtime_supervisor_unavailable/
  );
});

test("stable serialization is deterministic and matches digest ordering expectations", () => {
  assert.equal(
    stableSerialize({ z: 1, a: { y: 2, x: 3 } }),
    '{"a":{"x":3,"y":2},"z":1}'
  );
});

class FakeSupervisor {
  constructor(options = {}) {
    this.calls = {
      prepare: [],
      go: [],
      inspect: [],
      cleanup: [],
      release: []
    };
    this.closed = false;
    this.released = false;
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.options = options;
  }

  async request(payload) {
    this.calls[payload.operation]?.push(structuredClone(payload));
    if (payload.operation === "prepare") {
      return {
        operation: "prepare",
        phase: "prepared",
        namespace: {
          bootId: "12345678-1234-1234-1234-123456789abc",
          pidNamespaceId: "pid:[4026532000]"
        },
        manager: { pid: "300", starttime: "200" },
        process: {
          parentPid: "300",
          parentStarttime: "200",
          pid: "310",
          starttime: "210"
        },
        launcher: fileIdentity("11"),
        target: fileIdentity("22"),
        listener: payload.listener,
        listenerOpen: false,
        capabilitiesCleared: true,
        noNewPrivs: true,
        parentDeathSignal: "SIGKILL"
      };
    }
    if (payload.operation === "go") {
      return { operation: "go", phase: "go-returned" };
    }
    if (payload.operation === "cleanup") {
      this.closed = true;
      const sessionsClosed = this.options.cleanupSessionsClosed !== false;
      return {
        operation: "cleanup",
        phase: "closed",
        processExited: true,
        listenerClosed: true,
        sessionsClosed,
        childrenExited: true,
        containmentConfirmed: sessionsClosed
      };
    }
    if (payload.operation === "inspect") {
      if (this.closed) {
        const sessionsClosed = this.options.cleanupSessionsClosed !== false;
        return {
          operation: "inspect",
          phase: "stopped",
          manager: { pid: "300", starttime: "200" },
          process: {
            parentPid: "300",
            parentStarttime: "200",
            pid: "310",
            starttime: "210"
          },
          processExited: true,
          listenerClosed: true,
          sessionsClosed,
          childrenExited: true,
          observedAt: "2026-10-21T12:00:01.000Z"
        };
      }
      if (typeof this.options.inspectHandler === "function") {
        return await this.options.inspectHandler(payload, this);
      }
      if (Array.isArray(this.options.inspectResponses)
        && this.options.inspectResponses.length > 0) {
        const response = this.options.inspectResponses.shift();
        return typeof response === "function"
          ? await response(payload, this)
          : structuredClone(response);
      }
      return runningObservation(payload.purpose);
    }
    if (payload.operation === "release") {
      this.released = true;
      queueMicrotask(() => this.resolveExit(
        this.options.releaseExit || { code: 0, signal: null }
      ));
      return { operation: "release", phase: "releasing" };
    }
    throw new Error("unexpected operation");
  }

  async waitForExit() {
    return this.exit;
  }

  async terminate() {
    this.resolveExit({ code: 137, signal: "SIGKILL" });
  }
}

function fakeSupervisorChild(overrides = {}) {
  const child = new EventEmitter();
  child.stdin = overrides.stdin || new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function framedSupervisorClient(options) {
  const child = fakeSupervisorChild();
  const calls = {
    prepare: [],
    go: [],
    inspect: [],
    cleanup: []
  };
  let buffered = "";
  const respond = (request, result) => {
    child.stdout.write(`${JSON.stringify({
      version: 1,
      requestId: request.requestId,
      ok: true,
      result
    })}\n`);
  };
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const frame = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!frame) {
        continue;
      }
      const request = JSON.parse(frame);
      calls[request.operation].push(structuredClone(request));
      if (request.operation === "prepare") {
        respond(request, {
          operation: "prepare",
          phase: "prepared",
          namespace: {
            bootId: "12345678-1234-1234-1234-123456789abc",
            pidNamespaceId: "pid:[4026532000]"
          },
          manager: { pid: "300", starttime: "200" },
          process: {
            parentPid: "300",
            parentStarttime: "200",
            pid: "310",
            starttime: "210"
          },
          launcher: fileIdentity("11"),
          target: fileIdentity("22"),
          listener: request.listener,
          listenerOpen: false,
          capabilitiesCleared: true,
          noNewPrivs: true,
          parentDeathSignal: "SIGKILL"
        });
      } else if (request.operation === "go") {
        respond(request, { operation: "go", phase: "go-returned" });
      } else if (request.operation === "inspect") {
        Promise.resolve(options.inspectHandler(request))
          .then((result) => {
            if (result !== undefined) {
              respond(request, result);
            }
          });
      } else {
        throw new Error(`unexpected framed request: ${request.operation}`);
      }
    }
  });
  return {
    calls,
    client: new SupervisorClient(child, options.requestTimeoutMs),
    close() {
      child.stdout.end();
      child.stdin.end();
      child.emit("exit", 0, null);
    }
  };
}

function runningObservation(purpose) {
  return {
    operation: "inspect",
    phase: "running",
    namespace: {
      bootId: "12345678-1234-1234-1234-123456789abc",
      pidNamespaceId: "pid:[4026532000]"
    },
    manager: { pid: "300", starttime: "200" },
    process: {
      parentPid: "300",
      parentStarttime: "200",
      pid: "310",
      starttime: "210"
    },
    launcher: fileIdentity("11"),
    target: fileIdentity("22"),
    listener: {
      host: "127.0.0.1",
      port: 42022,
      open: true,
      ownedByProcess: true,
      socketDev: "50",
      socketIno: "60"
    },
    sessions: {
      count: 1,
      tracked: true,
      tuples: [{
        localAddress: "0100007F",
        localPort: 42022,
        remoteAddress: "0100007F",
        remotePort: 51000,
        inode: "61"
      }]
    },
    children: { allTracked: true },
    capabilities: structuredClone(ZERO_CAPABILITIES),
    noNewPrivs: true,
    parentDeathSignal: "SIGKILL",
    observedAt: purpose === "running"
      ? "2026-10-21T12:00:01.000Z"
      : "2026-10-21T12:00:02.000Z"
  };
}

function startingObservation(reason) {
  return {
    operation: "inspect",
    phase: "starting",
    manager: { pid: "300", starttime: "200" },
    namespace: {
      bootId: "12345678-1234-1234-1234-123456789abc",
      pidNamespaceId: "pid:[4026532000]"
    },
    process: {
      parentPid: "300",
      parentStarttime: "200",
      pid: "310",
      starttime: "210"
    },
    observedExecutable: reason === "launcher_exact"
      ? fileIdentity("11")
      : fileIdentity("22"),
    reason,
    observedAt: "2026-10-21T12:00:00.500Z"
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fileIdentity(seed) {
  return {
    dev: seed,
    ino: `${seed}0`,
    sha256: seed.repeat(32),
    size: `${seed}00`
  };
}
