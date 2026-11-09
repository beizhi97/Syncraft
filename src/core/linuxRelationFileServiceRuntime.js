import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_READY_TIMEOUT_MS = 3000;
const DEFAULT_STARTUP_PROBE_INTERVAL_MS = 50;
const MAX_FRAME_BYTES = 1024 * 1024;
const STARTING_KEYS = Object.freeze([
  "manager",
  "namespace",
  "observedAt",
  "observedExecutable",
  "operation",
  "phase",
  "process",
  "reason"
]);
const RUNNING_OBSERVATION_KEYS = Object.freeze([
  "capabilities",
  "children",
  "launcher",
  "listener",
  "manager",
  "namespace",
  "noNewPrivs",
  "observedAt",
  "operation",
  "parentDeathSignal",
  "phase",
  "process",
  "sessions",
  "target"
]);
const MANAGER_PROCESS_KEYS = Object.freeze(["pid", "starttime"]);
const PARENT_PROCESS_KEYS = Object.freeze([
  "parentPid",
  "parentStarttime",
  "pid",
  "starttime"
]);
const FILE_IDENTITY_KEYS = Object.freeze(["dev", "ino", "sha256", "size"]);
const NAMESPACE_KEYS = Object.freeze(["bootId", "pidNamespaceId"]);
const LISTENER_OBSERVATION_KEYS = Object.freeze([
  "host",
  "open",
  "ownedByProcess",
  "port",
  "socketDev",
  "socketIno"
]);
const SESSION_OBSERVATION_KEYS = Object.freeze(["count", "tracked", "tuples"]);
const SESSION_TUPLE_KEYS = Object.freeze([
  "inode",
  "localAddress",
  "localPort",
  "remoteAddress",
  "remotePort"
]);
const CHILDREN_OBSERVATION_KEYS = Object.freeze(["allTracked"]);
const CAPABILITY_KEYS = Object.freeze([
  "ambient",
  "bounding",
  "effective",
  "inheritable",
  "permitted"
]);
const FENCE_KEYS = Object.freeze([
  "attemptId",
  "expectedHandleDigest",
  "generation",
  "operationId",
  "protectionDigest",
  "relationId",
  "schemaVersion"
]);
const ZERO_CAPABILITIES = Object.freeze({
  ambient: "0000000000000000",
  bounding: "0000000000000000",
  effective: "0000000000000000",
  inheritable: "0000000000000000",
  permitted: "0000000000000000"
});

/**
 * Create the isolated Linux runtime adapter for one relation per supervisor.
 *
 * The module has no product wiring. The manager remains the durable lifecycle
 * owner; this adapter owns transient supervisor channels and private session
 * tuples that are deliberately absent from the manager evidence schema.
 */
export function createLinuxRelationFileServiceRuntime(options = {}) {
  return createRuntime(options, "rclone");
}

/** Create the isolated Linux runtime adapter for the native SFTP service. */
export function createLinuxSftpRelationFileServiceRuntime(options = {}) {
  return createRuntime(options, "service");
}

function createRuntime(options, serviceMode) {
  assertPlainObject(options, "runtime options");
  const config = normalizeOptions(options, serviceMode);
  const sessionsByToken = new Map();
  const random = config.randomBytes;
  const clock = config.clock;
  const spawnSupervisor = config.spawnSupervisor || defaultSpawnSupervisor;
  const probe = config.probe || createDefaultProbe();
  let sequence = 0;

  return Object.freeze({
    async prepare(request = {}, details = {}) {
      assertPlainObject(request, "prepare request");
      assertPlainObject(details, "prepare details");
      const fence = requireFence(details.fence);
      const listener = normalizeListener(request.launch?.listener);
      const token = createToken(random);
      if (sessionsByToken.has(token)) {
        throw runtimeError("runtime_token_collision");
      }

      const supervisor = spawnSupervisor({
        args: buildSupervisorArgs(config),
        command: config.supervisorPath,
        cwd: config.cwd,
        env: config.env,
        requestTimeoutMs: config.requestTimeoutMs
      });
      const requestId = `prepare-${++sequence}`;
      let prepared;
      try {
        prepared = await supervisor.request({
          version: PROTOCOL_VERSION,
          requestId,
          operation: "prepare",
          relationId: fence.relationId,
          generation: fence.generation,
          operationId: fence.operationId,
          token,
          fenceDigest: digestValue(fence),
          listener
        });
      } catch (error) {
        await supervisor.terminate().catch(() => {});
        throw runtimeError("runtime_prepare_failed", error);
      }

      try {
        assertSupervisorResult(prepared, "prepare");
        const runtimeIdentity = buildRuntimeIdentity(prepared, listener, token);
        if (prepared.listenerOpen !== false
          || prepared.capabilitiesCleared !== true
          || prepared.noNewPrivs !== true
          || prepared.parentDeathSignal !== "SIGKILL") {
          throw runtimeError("runtime_prepare_evidence_invalid");
        }
        const handle = Object.freeze({
          relationId: fence.relationId,
          generation: fence.generation,
          token
        });
        const lease = Object.freeze({
          schemaVersion: "1",
          leaseId: token,
          relationId: fence.relationId,
          generation: fence.generation
        });
        const provisionalEvidence = {
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
          observedAt: clock().toISOString()
        };
        const session = {
          abortCompleted: false,
          abortRequested: false,
          cleanupRequested: false,
          containmentConfirmed: false,
          disableOperationId: null,
          generation: fence.generation,
          goReturned: false,
          handle,
          lastCheckpoint: "prepare-ready",
          lastClosure: null,
          lease,
          listener,
          phase: "prepared",
          process: runtimeIdentity.process,
          relationId: fence.relationId,
          releasePromise: null,
          runtimeIdentity,
          sessionTuples: [],
          startOperationId: fence.operationId,
          supervisor,
          token
        };
        sessionsByToken.set(token, session);
        return {
          lease,
          handle: structuredClone(handle),
          runtimeIdentity: structuredClone(runtimeIdentity),
          provisionalEvidence,
          fence: structuredClone(fence)
        };
      } catch (error) {
        await supervisor.terminate().catch(() => {});
        throw runtimeError("runtime_prepare_evidence_invalid", error);
      }
    },

    async go(lease, details = {}) {
      const session = requireSessionForLease(sessionsByToken, lease);
      const fence = requireFence(details.fence);
      assertStartFenceBinding(fence, session);
      if (session.phase !== "prepared") {
        throw runtimeError("runtime_go_state_invalid");
      }
      try {
        const result = await session.supervisor.request({
          version: PROTOCOL_VERSION,
          requestId: `go-${++sequence}`,
          operation: "go",
          relationId: fence.relationId,
          generation: fence.generation,
          operationId: fence.operationId,
          token: session.token,
          fenceDigest: digestValue(fence)
        });
        assertSupervisorResult(result, "go");
        if (result.phase !== "go-returned") {
          throw runtimeError("runtime_go_evidence_invalid");
        }
        session.phase = "go-returned";
        session.goReturned = true;
        session.lastCheckpoint = "go-returned";
        return { ok: true };
      } catch (error) {
        throw runtimeError("runtime_go_failed", error);
      }
    },

    async inspect(handle, details = {}) {
      const purpose = normalizePurpose(details.purpose);
      const session = findSessionForHandle(sessionsByToken, handle);
      if (!session) {
        return purpose === "cleanup"
          ? createCleanupEvidence(null, null, false)
          : { owned: false, reason: "runtime_ownership_unconfirmed" };
      }
      if (!sameHandle(session.handle, handle)) {
        return purpose === "cleanup"
          ? createCleanupEvidence(handle, session, false)
          : { owned: false, reason: "runtime_handle_mismatch" };
      }
      if (purpose === "running") {
        return inspectRunning(
          session,
          details,
          probe,
          config.onObservation,
          config
        );
      }
      if (purpose === "disable") {
        return inspectDisable(session, details, probe, config);
      }
      return inspectCleanup(session, details, probe, config);
    },

    async stop(handle, details = {}) {
      const session = findSessionForHandle(sessionsByToken, handle);
      if (!session) {
        throw runtimeError("runtime_ownership_unconfirmed");
      }
      if (!sameHandle(session.handle, handle)) {
        throw runtimeError("runtime_handle_mismatch");
      }
      const fence = requireFence(details.fence);
      if (details.purpose !== "disable") {
        throw runtimeError("runtime_stop_purpose_invalid");
      }
      assertDisableFenceBinding(fence, session, true);
      const result = await cleanupSession(session, fence, "stop", config);
      if (!result.containmentConfirmed) {
        throw runtimeError("runtime_cleanup_unconfirmed");
      }
      return { ok: true, containmentConfirmed: true };
    },

    async abort(lease, details = {}) {
      const session = requireSessionForLease(sessionsByToken, lease);
      const fence = requireFence(details.fence);
      assertStartFenceBinding(fence, session);
      session.abortRequested = true;
      try {
        const result = await cleanupSession(session, fence, "abort", config);
        session.abortCompleted = true;
        session.containmentConfirmed = result.containmentConfirmed === true;
        return { containmentConfirmed: session.containmentConfirmed };
      } catch {
        session.abortCompleted = false;
        session.containmentConfirmed = false;
        return { containmentConfirmed: false };
      }
    }
  });
}

async function inspectRunning(session, details, probe, onObservation, config) {
  if (session.phase === "closed") {
    return { owned: false, reason: "runtime_stop_evidence_incomplete" };
  }
  const fence = requireFence(details.fence);
  assertStartFenceBinding(fence, session);
  const signal = details.signal;
  try {
    if (session.phase === "running") {
      if (signal?.aborted === true) {
        throw runtimeError("runtime_startup_aborted");
      }
      const observed = await requestRunningInspection(session, fence);
      if (signal?.aborted === true) {
        throw runtimeError("runtime_startup_aborted");
      }
      assertSupervisorResult(observed, "inspect");
      assertRunningObservation(observed, session);
      if (signal?.aborted === true) {
        throw runtimeError("runtime_startup_aborted");
      }
      commitRunningSession(session, observed, onObservation);
      return createRunningEvidence(session, observed, fence);
    }
    if (session.phase !== "go-returned") {
      throw runtimeError("runtime_go_state_invalid");
    }
    return await inspectInitialRunning(
      session,
      fence,
      signal,
      onObservation,
      config
    );
  } catch (error) {
    if (error?.code === "runtime_startup_aborted"
      || error?.code === "runtime_startup_timeout") {
      return { owned: false, reason: error.code };
    }
    return { owned: false, reason: "runtime_inspect_failed" };
  }
}

async function inspectInitialRunning(
  session,
  fence,
  signal,
  onObservation,
  config
) {
  const deadline = config.monotonicNow() + config.startupReadyTimeoutMs;
  while (true) {
    assertStartupActive(signal, deadline, config.monotonicNow);
    const observed = await requestRunningInspection(session, fence);
    assertStartupActive(signal, deadline, config.monotonicNow);
    assertSupervisorResult(observed, "inspect");
    if (observed.phase === "running") {
      assertRunningObservation(observed, session);
      assertStartupActive(signal, deadline, config.monotonicNow);
      commitRunningSession(session, observed, onObservation);
      return createRunningEvidence(session, observed, fence);
    }
    if (observed.phase !== "starting") {
      throw runtimeError("runtime_inspect_invalid");
    }
    assertStartingObservation(observed, session);
    assertStartupActive(signal, deadline, config.monotonicNow);
    const remaining = deadline - config.monotonicNow();
    if (remaining <= 0) {
      throw runtimeError("runtime_startup_timeout");
    }
    await waitForProbe(
      Math.min(config.startupProbeIntervalMs, remaining),
      signal
    );
  }
}

async function requestRunningInspection(session, fence) {
  session.inspectSequence = (session.inspectSequence || 0) + 1;
  return session.supervisor.request({
    version: PROTOCOL_VERSION,
    requestId: `inspect-running-${session.inspectSequence}`,
    operation: "inspect",
    purpose: "running",
    relationId: fence.relationId,
    generation: fence.generation,
    operationId: fence.operationId,
    token: session.token,
    fenceDigest: digestValue(fence)
  });
}

function assertStartupActive(signal, deadline, monotonicNow) {
  if (signal?.aborted === true) {
    throw runtimeError("runtime_startup_aborted");
  }
  if (monotonicNow() >= deadline) {
    throw runtimeError("runtime_startup_timeout");
  }
}

function waitForProbe(timeoutMs, signal) {
  if (signal?.aborted === true) {
    return Promise.reject(runtimeError("runtime_startup_aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(runtimeError("runtime_startup_aborted"));
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function commitRunningSession(session, observed, onObservation) {
  session.phase = "running";
  session.sessionTuples = structuredClone(observed.sessions.tuples);
  session.lastCheckpoint = "inspect-ready";
  if (typeof onObservation === "function") {
    onObservation({
      purpose: "running",
      sessions: structuredClone(observed.sessions),
      process: structuredClone(observed.process),
      listener: structuredClone(observed.listener)
    });
  }
}

function createRunningEvidence(session, observed, fence) {
  return {
    schemaVersion: "1",
    fenceDigest: digestValue(fence),
    handleDigest: digestValue(session.handle),
    runtimeIdentityDigest: digestValue(session.runtimeIdentity),
    namespace: structuredClone(observed.namespace),
    process: structuredClone(observed.process),
    executable: {
      launcher: structuredClone(observed.launcher),
      target: structuredClone(observed.target)
    },
    listener: {
      role: "observed",
      host: observed.listener.host,
      port: observed.listener.port,
      open: observed.listener.open,
      ownedByProcess: observed.listener.ownedByProcess,
      socketDev: observed.listener.socketDev,
      socketIno: observed.listener.socketIno
    },
    sessions: {
      count: observed.sessions.count,
      tracked: observed.sessions.tracked
    },
    children: {
      allTracked: observed.children.allTracked
    },
    capabilities: structuredClone(observed.capabilities),
    noNewPrivs: observed.noNewPrivs,
    parentDeathSignal: observed.parentDeathSignal,
    tokenSha256: session.runtimeIdentity.tokenSha256,
    observedAt: normalizeTimestamp(observed.observedAt)
  };
}

async function inspectDisable(session, details, probe, config) {
  const fence = requireFence(details.fence);
  assertDisableFenceBinding(fence, session, false);
  if (session.phase === "released" && session.containmentConfirmed === true) {
    return cachedStoppedObservation(session);
  }
  let observed;
  try {
    observed = await session.supervisor.request({
      version: PROTOCOL_VERSION,
      requestId: `inspect-disable-${Date.now()}-${session.token.slice(0, 8)}`,
      operation: "inspect",
      purpose: "disable",
      relationId: fence.relationId,
      generation: fence.generation,
      operationId: fence.operationId,
      token: session.token,
      fenceDigest: digestValue(fence)
    });
    assertSupervisorResult(observed, "inspect");
    if (session.disableOperationId === null) {
      session.disableOperationId = fence.operationId;
    }
  } catch {
    return { owned: false, reason: "runtime_inspect_failed" };
  }
  if (observed.phase === "running") {
    try {
      assertRunningObservation(observed, session);
      session.phase = "running";
      session.sessionTuples = structuredClone(observed.sessions.tuples);
      return {
        owned: true,
        handle: structuredClone(session.handle),
        phase: "running"
      };
    } catch {
      return { owned: false, reason: "runtime_inspect_invalid" };
    }
  }
  return finalizeStoppedObservation(session, observed, probe, config, false, fence);
}

async function inspectCleanup(session, details, probe, config) {
  const fence = requireFence(details.fence);
  assertStartFenceBinding(fence, session);
  if (session.phase === "released") {
    return createCleanupEvidence(
      session.handle,
      session,
      session.containmentConfirmed === true
    );
  }
  let observed;
  try {
    observed = await session.supervisor.request({
      version: PROTOCOL_VERSION,
      requestId: `inspect-cleanup-${Date.now()}-${session.token.slice(0, 8)}`,
      operation: "inspect",
      purpose: "cleanup",
      relationId: fence.relationId,
      generation: fence.generation,
      operationId: fence.operationId,
      token: session.token,
      fenceDigest: digestValue(fence)
    });
    assertSupervisorResult(observed, "inspect");
  } catch {
    return createCleanupEvidence(session.handle, session, false);
  }
  let finalized;
  try {
    finalized = await finalizeStoppedObservation(
      session,
      observed,
      probe,
      config,
      true,
      fence
    );
  } catch {
    return createCleanupEvidence(session.handle, session, false);
  }
  if (finalized.owned !== true) {
    return createCleanupEvidence(session.handle, session, false);
  }
  const confirmed = session.abortRequested === true
    && session.abortCompleted === true
    && session.containmentConfirmed === true
    && session.lastClosure?.processExited === true
    && session.lastClosure?.listenerClosed === true
    && session.lastClosure?.sessionsClosed === true
    && session.lastClosure?.childrenExited === true;
  return createCleanupEvidence(session.handle, session, confirmed);
}

async function finalizeStoppedObservation(session, observed, probe, config, cleanup, fence) {
  if (observed.phase !== "stopped") {
    return { owned: false, reason: "runtime_inspect_ambiguous" };
  }
  assertStoppedObservation(observed, session);
  if (cleanup && (session.abortRequested !== true || session.abortCompleted !== true)) {
    return { owned: false, reason: "runtime_cleanup_unconfirmed" };
  }
  const processGone = await safeProbe(
    () => probe.processGone(session.runtimeIdentity.process),
    false
  );
  const listenerClosed = await safeProbe(
    () => probe.listenerClosed(session.listener, session.runtimeIdentity.process),
    false
  );
  const sessionsGone = await safeProbe(
    () => probe.sessionsGone(session.sessionTuples, session.listener),
    false
  );
  if (!processGone || !listenerClosed || !sessionsGone) {
    return { owned: false, reason: "runtime_stop_evidence_incomplete" };
  }
  session.lastClosure = {
    childrenExited: observed.childrenExited === true,
    listenerClosed,
    processExited: processGone,
    sessionsClosed: sessionsGone
  };
  session.containmentConfirmed = session.lastClosure.childrenExited === true
    && processGone
    && listenerClosed
    && sessionsGone;
  if (!session.containmentConfirmed) {
    return { owned: false, reason: "runtime_children_unconfirmed" };
  }
  const released = await releaseSession(session, fence, probe, config);
  if (!released) {
    return { owned: false, reason: "runtime_release_unconfirmed" };
  }
  session.phase = "released";
  return {
    owned: true,
    handle: structuredClone(session.handle),
    phase: "stopped",
    processExited: true,
    listenerClosed: true,
    sessionsClosed: true,
    childrenExited: true,
    supervisorExited: true
  };
}

function cachedStoppedObservation(session) {
  return {
    owned: true,
    handle: structuredClone(session.handle),
    phase: "stopped",
    processExited: true,
    listenerClosed: true,
    sessionsClosed: true,
    childrenExited: true,
    supervisorExited: true
  };
}

async function cleanupSession(session, fence, mode, config) {
  if (session.phase === "closed" && session.lastClosure) {
    return { containmentConfirmed: session.containmentConfirmed };
  }
  if (session.phase === "released") {
    return { containmentConfirmed: session.containmentConfirmed };
  }
  if (session.cleanupRequested && session.lastClosure) {
    return { containmentConfirmed: session.containmentConfirmed };
  }
  session.cleanupRequested = true;
  session.lastCheckpoint = "inspect-pending";
  const result = await session.supervisor.request({
    version: PROTOCOL_VERSION,
    requestId: `${mode}-${Date.now()}-${session.token.slice(0, 8)}`,
    operation: "cleanup",
    mode,
    relationId: fence.relationId,
    generation: fence.generation,
    operationId: fence.operationId,
    token: session.token,
    fenceDigest: digestValue(fence)
  });
  assertSupervisorResult(result, "cleanup");
  if (result.phase !== "closed") {
    throw runtimeError("runtime_cleanup_state_invalid");
  }
  session.phase = "closed";
  session.lastClosure = {
    childrenExited: result.childrenExited === true,
    listenerClosed: result.listenerClosed === true,
    processExited: result.processExited === true,
    sessionsClosed: result.sessionsClosed === true
  };
  session.containmentConfirmed = session.lastClosure.childrenExited
    && session.lastClosure.listenerClosed
    && session.lastClosure.processExited
    && session.lastClosure.sessionsClosed;
  return { containmentConfirmed: session.containmentConfirmed };
}

async function releaseSession(session, fence, probe, config) {
  if (session.releasePromise) {
    return session.releasePromise;
  }
  session.releasePromise = (async () => {
    try {
      const result = await session.supervisor.request({
        version: PROTOCOL_VERSION,
        requestId: `release-${Date.now()}-${session.token.slice(0, 8)}`,
        operation: "release",
        relationId: fence.relationId,
        generation: fence.generation,
        operationId: fence.operationId,
        fenceDigest: digestValue(fence),
        token: session.token
      });
      assertSupervisorResult(result, "release");
      if (result.phase !== "releasing") {
        return false;
      }
      const exit = await session.supervisor.waitForExit(config.releaseTimeoutMs);
      if (exit?.code !== 0 || exit?.signal != null) {
        return false;
      }
      return safeProbe(
        () => probe.processGone(session.runtimeIdentity.manager),
        false
      );
    } catch {
      return false;
    }
  })();
  return session.releasePromise;
}

function createCleanupEvidence(handle, session, confirmed) {
  const exactHandleIdentity = handle && typeof handle === "object"
    ? {
      relationId: handle.relationId,
      generation: String(handle.generation),
      handleDigest: digestValue(handle)
    }
    : null;
  return {
    schemaVersion: "1",
    disposition: confirmed ? "confirmedStopped" : "unconfirmed",
    lastRuntimeCheckpoint: normalizeCheckpoint(session?.lastCheckpoint),
    runtimeInvoked: Boolean(session),
    leaseReturned: Boolean(session?.lease),
    continuationRegistered: false,
    latePrepare: "not-applicable",
    lateGo: session?.goReturned === true ? "returned" : "not-applicable",
    abortRequested: session?.abortRequested === true,
    abortCompleted: session?.abortCompleted === true,
    containmentConfirmed: confirmed,
    exactHandleIdentity,
    processExited: confirmed ? true : session?.lastClosure?.processExited ?? null,
    listenerClosed: confirmed ? true : session?.lastClosure?.listenerClosed ?? null,
    sessionsClosed: confirmed ? true : session?.lastClosure?.sessionsClosed ?? null,
    childrenExited: confirmed ? true : session?.lastClosure?.childrenExited ?? null,
    reasonCode: confirmed
      ? "cleanup_confirmed_stopped"
      : "relation_file_service_runtime_cleanup_unconfirmed"
  };
}

function normalizeCheckpoint(value) {
  return value === "inspect-ready" || value === "go-returned"
    ? value
    : "inspect-pending";
}

function buildRuntimeIdentity(prepared, listener, token) {
  const runtimeIdentity = {
    schemaVersion: "1",
    namespace: {
      bootId: prepared.namespace.bootId,
      pidNamespaceId: prepared.namespace.pidNamespaceId
    },
    manager: {
      pid: String(prepared.manager.pid),
      starttime: String(prepared.manager.starttime)
    },
    process: {
      parentPid: String(prepared.process.parentPid),
      parentStarttime: String(prepared.process.parentStarttime),
      pid: String(prepared.process.pid),
      starttime: String(prepared.process.starttime)
    },
    executable: {
      launcher: cloneFileIdentity(prepared.launcher),
      target: cloneFileIdentity(prepared.target)
    },
    listener: {
      host: listener.host,
      port: listener.port,
      role: "expected"
    },
    tokenSha256: digestText(token)
  };
  if (runtimeIdentity.manager.pid === runtimeIdentity.process.pid
    || runtimeIdentity.process.parentPid !== runtimeIdentity.manager.pid
    || runtimeIdentity.process.parentStarttime !== runtimeIdentity.manager.starttime) {
    throw runtimeError("runtime_parent_identity_invalid");
  }
  return runtimeIdentity;
}

function assertRunningObservation(observed, session) {
  assertPlainObject(observed, "running observation");
  assertExactKeys(observed, RUNNING_OBSERVATION_KEYS, "running observation");
  assertExactKeys(observed.manager, MANAGER_PROCESS_KEYS, "running observation manager");
  assertExactKeys(observed.namespace, NAMESPACE_KEYS, "running observation namespace");
  assertExactKeys(observed.process, PARENT_PROCESS_KEYS, "running observation process");
  assertExactKeys(observed.launcher, FILE_IDENTITY_KEYS, "running observation launcher");
  assertExactKeys(observed.target, FILE_IDENTITY_KEYS, "running observation target");
  assertExactKeys(observed.listener, LISTENER_OBSERVATION_KEYS, "running observation listener");
  assertExactKeys(observed.sessions, SESSION_OBSERVATION_KEYS, "running observation sessions");
  assertExactKeys(observed.children, CHILDREN_OBSERVATION_KEYS, "running observation children");
  assertExactKeys(observed.capabilities, CAPABILITY_KEYS, "running observation capabilities");
  if (observed.operation !== "inspect"
    || observed.phase !== "running"
    || !isManagerProcessIdentity(observed.manager)
    || !isNamespaceIdentity(observed.namespace)
    || !isParentProcessIdentity(observed.process)
    || !isFileIdentity(observed.launcher)
    || !isFileIdentity(observed.target)
    || stableSerialize(observed.manager) !== stableSerialize(session.runtimeIdentity.manager)
    || stableSerialize(observed.process) !== stableSerialize(session.process)
    || stableSerialize(observed.namespace) !== stableSerialize(session.runtimeIdentity.namespace)
    || stableSerialize(observed.launcher) !== stableSerialize(session.runtimeIdentity.executable.launcher)
    || stableSerialize(observed.target) !== stableSerialize(session.runtimeIdentity.executable.target)
    || observed.listener?.host !== session.listener.host
    || observed.listener?.port !== session.listener.port
    || observed.listener?.open !== true
    || observed.listener?.ownedByProcess !== true
    || !isCanonicalDecimal(observed.listener?.socketDev)
    || !isCanonicalDecimal(observed.listener?.socketIno)
    || observed.sessions?.tracked !== true
    || !Number.isSafeInteger(observed.sessions?.count)
    || observed.sessions.count < 0
    || !Array.isArray(observed.sessions?.tuples)
    || observed.sessions.tuples.length !== observed.sessions.count
    || !observed.sessions.tuples.every(isSessionTuple)
    || observed.children?.allTracked !== true
    || stableSerialize(observed.capabilities) !== stableSerialize(ZERO_CAPABILITIES)
    || observed.noNewPrivs !== true
    || observed.parentDeathSignal !== "SIGKILL"
    || !isTimestamp(observed.observedAt)) {
    throw runtimeError("runtime_inspect_invalid");
  }
}

function assertStartingObservation(observed, session) {
  assertPlainObject(observed, "starting observation");
  assertExactKeys(observed, STARTING_KEYS, "starting observation");
  assertExactKeys(observed.manager, MANAGER_PROCESS_KEYS, "starting observation manager");
  assertExactKeys(observed.namespace, NAMESPACE_KEYS, "starting observation namespace");
  assertExactKeys(observed.process, PARENT_PROCESS_KEYS, "starting observation process");
  assertExactKeys(
    observed.observedExecutable,
    FILE_IDENTITY_KEYS,
    "starting observation executable"
  );
  if (observed.operation !== "inspect"
    || observed.phase !== "starting"
    || !isManagerProcessIdentity(observed.manager)
    || !isNamespaceIdentity(observed.namespace)
    || !isParentProcessIdentity(observed.process)
    || !isFileIdentity(observed.observedExecutable)
    || stableSerialize(observed.manager) !== stableSerialize(session.runtimeIdentity.manager)
    || stableSerialize(observed.namespace) !== stableSerialize(session.runtimeIdentity.namespace)
    || stableSerialize(observed.process) !== stableSerialize(session.process)
    || !["launcher_exact", "listener_absent", "children_census_unstable"]
      .includes(observed.reason)
    || !isTimestamp(observed.observedAt)) {
    throw runtimeError("runtime_inspect_invalid");
  }
  const expectedExecutable = observed.reason === "launcher_exact"
    ? session.runtimeIdentity.executable.launcher
    : session.runtimeIdentity.executable.target;
  if (stableSerialize(observed.observedExecutable)
    !== stableSerialize(expectedExecutable)) {
    throw runtimeError("runtime_inspect_invalid");
  }
}

function isManagerProcessIdentity(value) {
  return value
    && isCanonicalDecimal(value.pid)
    && isCanonicalDecimal(value.starttime);
}

function isParentProcessIdentity(value) {
  return value
    && isCanonicalDecimal(value.parentPid)
    && isCanonicalDecimal(value.parentStarttime)
    && isCanonicalDecimal(value.pid)
    && isCanonicalDecimal(value.starttime);
}

function isNamespaceIdentity(value) {
  return value
    && typeof value.bootId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      .test(value.bootId)
    && typeof value.pidNamespaceId === "string"
    && /^pid:\[[1-9][0-9]*\]$/.test(value.pidNamespaceId);
}

function isFileIdentity(value) {
  return value
    && isCanonicalDecimal(value.dev)
    && isCanonicalDecimal(value.ino)
    && /^[0-9a-f]{64}$/.test(value.sha256)
    && isCanonicalDecimal(value.size);
}

function isSessionTuple(value) {
  return value
    && assertKeysOnly(value, SESSION_TUPLE_KEYS)
    && /^(?:[0-9A-F]{8}|[0-9A-F]{32})$/.test(value.localAddress)
    && Number.isInteger(value.localPort)
    && value.localPort >= 0
    && value.localPort <= 65535
    && /^(?:[0-9A-F]{8}|[0-9A-F]{32})$/.test(value.remoteAddress)
    && Number.isInteger(value.remotePort)
    && value.remotePort >= 0
    && value.remotePort <= 65535
    && isCanonicalDecimal(value.inode);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertStoppedObservation(observed, session) {
  if (observed.phase !== "stopped"
    || observed.processExited !== true
    || observed.listenerClosed !== true
    || observed.sessionsClosed !== true
    || observed.childrenExited !== true
    || stableSerialize(observed.manager) !== stableSerialize(session.runtimeIdentity.manager)
    || stableSerialize(observed.process) !== stableSerialize(session.process)) {
    throw runtimeError("runtime_stop_evidence_incomplete");
  }
}

function assertSupervisorResult(value, operation) {
  assertPlainObject(value, `${operation} result`);
  if (value.operation !== operation) {
    throw runtimeError("runtime_protocol_invalid");
  }
}

function normalizeOptions(options, serviceMode = "rclone") {
  const supervisorPath = absolutePath(options.supervisorPath, "supervisorPath");
  const execServicePath = absolutePath(options.execServicePath, "execServicePath");
  const signalServicePath = absolutePath(options.signalServicePath, "signalServicePath");
  let servicePath;
  let serviceUser;
  let rclonePath;
  if (serviceMode === "service") {
    if (Object.hasOwn(options, "rclonePath")) {
      throw runtimeError("runtime_service_mode_rclone_path_forbidden");
    }
    servicePath = absolutePath(options.servicePath, "servicePath");
    serviceUser = options.serviceUser;
    if (typeof serviceUser !== "string"
      || !/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(serviceUser)) {
      throw runtimeError("runtime_service_user_invalid");
    }
  } else {
    rclonePath = absolutePath(options.rclonePath, "rclonePath");
  }
  const rootPath = absolutePath(options.rootPath, "rootPath");
  const authorizedKeysPath = absolutePath(options.authorizedKeysPath, "authorizedKeysPath");
  const hostKeyPath = absolutePath(options.hostKeyPath, "hostKeyPath");
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs"
  );
  const releaseTimeoutMs = positiveInteger(
    options.releaseTimeoutMs,
    DEFAULT_RELEASE_TIMEOUT_MS,
    "releaseTimeoutMs"
  );
  const startupReadyTimeoutMs = positiveInteger(
    options.startupReadyTimeoutMs,
    DEFAULT_STARTUP_READY_TIMEOUT_MS,
    "startupReadyTimeoutMs"
  );
  const startupProbeIntervalMs = positiveInteger(
    options.startupProbeIntervalMs,
    DEFAULT_STARTUP_PROBE_INTERVAL_MS,
    "startupProbeIntervalMs"
  );
  const env = options.env == null
    ? Object.fromEntries(Object.entries(process.env))
    : options.env;
  assertPlainObject(env, "env");
  return {
    supervisorPath,
    execServicePath,
    signalServicePath,
    serviceMode,
    servicePath,
    serviceUser,
    rclonePath,
    rootPath,
    authorizedKeysPath,
    hostKeyPath,
    cwd: options.cwd == null ? path.dirname(supervisorPath) : absolutePath(options.cwd, "cwd"),
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
    requestTimeoutMs,
    releaseTimeoutMs,
    startupReadyTimeoutMs,
    startupProbeIntervalMs,
    randomBytes: options.randomBytes == null
      ? cryptoRandomBytes
      : requireFunction(options.randomBytes, "randomBytes"),
    clock: options.clock == null ? (() => new Date()) : requireFunction(options.clock, "clock"),
    monotonicNow: options.monotonicNow == null
      ? () => performance.now()
      : requireFunction(options.monotonicNow, "monotonicNow"),
    spawnSupervisor: options.spawnSupervisor,
    probe: options.probe,
    onObservation: options.onObservation
  };
}

function buildSupervisorArgs(config) {
  const args = [
    "--exec-service",
    config.execServicePath,
    "--signal-service",
    config.signalServicePath
  ];
  if (config.serviceMode === "service") {
    args.push("--service", config.servicePath, "--user", config.serviceUser);
  } else {
    args.push("--rclone", config.rclonePath);
  }
  args.push(
    "--root",
    config.rootPath,
    "--authorized-keys",
    config.authorizedKeysPath,
    "--host-key",
    config.hostKeyPath
  );
  return args;
}

function defaultSpawnSupervisor(options) {
  const child = spawnProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  return new SupervisorClient(child, options.requestTimeoutMs);
}

export class SupervisorClient {
  constructor(child, requestTimeoutMs) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map();
    this.stdout = "";
    this.stderr = "";
    this.channelFailure = null;
    this.exitResult = null;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const error = runtimeError(
          "runtime_supervisor_exited",
          new Error(`supervisor exited code=${code ?? "null"} signal=${signal ?? "null"}`)
        );
        this.exitResult = { code, signal };
        this.failChannel(error);
        resolve({ code, signal });
      });
    });
    child.once("error", (error) => {
      this.failChannel(runtimeError("runtime_supervisor_spawn_failed", error));
    });
    child.stdin?.once("error", (error) => {
      this.failChannel(runtimeError("runtime_supervisor_stdin_failed", error));
    });
    child.stdin?.once("close", () => {
      this.failChannel(runtimeError("runtime_supervisor_stdin_closed"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16384);
    });
  }

  async request(payload) {
    const requestId = payload.requestId;
    if (this.channelFailure
      || this.pending.has(requestId)
      || this.child.stdin == null
      || this.child.stdin.writable !== true
      || this.child.stdin.writableEnded === true
      || this.child.stdin.destroyed === true) {
      throw runtimeError("runtime_supervisor_unavailable");
    }
    const frame = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      throw runtimeError("runtime_protocol_frame_too_large");
    }
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(runtimeError("runtime_supervisor_timeout"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          this.failChannel(runtimeError("runtime_supervisor_stdin_failed", error));
        }
      });
    } catch (error) {
      this.failChannel(runtimeError("runtime_supervisor_stdin_failed", error));
    }
    const response = await promise;
    if (response?.version !== PROTOCOL_VERSION || response?.requestId !== requestId) {
      throw runtimeError("runtime_protocol_invalid");
    }
    if (response.ok !== true) {
      throw runtimeError(
        typeof response?.error?.code === "string"
          ? response.error.code
          : "runtime_supervisor_error"
      );
    }
    return response.result;
  }

  failChannel(error) {
    if (this.channelFailure) {
      return;
    }
    this.channelFailure = error;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  onStdout(chunk) {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > MAX_FRAME_BYTES && !this.stdout.includes("\n")) {
      this.child.kill("SIGKILL");
      return;
    }
    while (true) {
      const index = this.stdout.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = this.stdout.slice(0, index);
      this.stdout = this.stdout.slice(index + 1);
      if (!line) {
        continue;
      }
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.child.kill("SIGKILL");
        return;
      }
      const pending = this.pending.get(response?.requestId);
      if (!pending) {
        this.child.kill("SIGKILL");
        return;
      }
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  async waitForExit(timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(runtimeError("runtime_supervisor_release_timeout")),
            timeoutMs
          );
          timer.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async terminate() {
    if (!this.child.killed) {
      this.child.kill("SIGKILL");
    }
    await this.waitForExit(this.requestTimeoutMs).catch(() => {});
  }
}

export function createDefaultProbe(options = {}) {
  const readTables = options.readTcpTables == null
    ? readTcpTables
    : requireFunction(options.readTcpTables, "readTcpTables");
  return {
    async processGone(identity) {
      if (!identity
        || !isCanonicalDecimal(String(identity.pid))
        || !isCanonicalDecimal(String(identity.starttime))) {
        return false;
      }
      try {
        const stat = await readProcStat(Number(identity.pid));
        return stat.starttime !== String(identity.starttime)
          || stat.state === "Z"
          || stat.state === "X";
      } catch (error) {
        return error?.code === "ENOENT";
      }
    },

    async listenerClosed(listener, processIdentity) {
      if (!(await this.processGone(processIdentity))) {
        return false;
      }
      const tables = await readTcpTables();
      if (tables.some((entry) => entry.state === "0A"
        && entry.localPort === listener.port
        && isLoopbackHex(entry.localAddress))) {
        return false;
      }
      return probePortRefused(listener.host, listener.port);
    },

    async sessionsGone(_tuples, listener) {
      const tables = await readTables();
      return !listenerPortHasActiveSession(tables, listener);
    }
  };
}

async function readProcStat(pid) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = text.lastIndexOf(")");
  if (close < 0) {
    throw new Error("invalid proc stat");
  }
  const fields = text.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20) {
    throw new Error("short proc stat");
  }
  return {
    state: fields[0],
    ppid: fields[1],
    starttime: fields[19]
  };
}

async function readTcpTables() {
  const entries = [];
  for (const name of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    let text;
    try {
      text = await readFile(name, "utf8");
    } catch (error) {
      throw runtimeError("runtime_tcp_table_unavailable", error);
    }
    entries.push(...parseTcpTableText(text, name));
  }
  return entries;
}

export function parseTcpTableText(text, tableName = "tcp") {
  if (typeof text !== "string" || !text) {
    throw runtimeError(`runtime_tcp_${tableName}_header_invalid`);
  }
  const lines = text.split("\n");
  const header = lines[0]?.trim().split(/\s+/);
  if (!header || header.length < 10
    || header[0] !== "sl"
    || header[1] !== "local_address"
    || !validRemoteAddressHeader(header[2])
    || header[3] !== "st"
    || header.at(-1) !== "inode") {
    throw runtimeError(`runtime_tcp_${tableName}_header_invalid`);
  }
  const entries = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") {
      if (index === lines.length - 1) {
        continue;
      }
      throw runtimeError(`runtime_tcp_${tableName}_row_invalid`);
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      throw runtimeError(`runtime_tcp_${tableName}_row_invalid`);
    }
    const local = parseTcpEndpoint(fields[1], tableName);
    const remote = parseTcpEndpoint(fields[2], tableName);
    if (!/^[0-9A-Fa-f]{2}$/.test(fields[3])) {
      throw runtimeError(`runtime_tcp_${tableName}_state_invalid`);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(fields[9])) {
      throw runtimeError(`runtime_tcp_${tableName}_inode_invalid`);
    }
    entries.push({
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      state: fields[3].toUpperCase(),
      inode: fields[9]
    });
  }
  return entries;
}

function validRemoteAddressHeader(value) {
  return value === "rem_address" || value === "remote_address";
}

function parseTcpEndpoint(value, tableName) {
  if (typeof value !== "string") {
    throw runtimeError(`runtime_tcp_${tableName}_address_invalid`);
  }
  const separator = value.lastIndexOf(":");
  const address = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (separator < 0
    || !/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32})$/.test(address)
    || !/^[0-9A-Fa-f]{4}$/.test(portText)) {
    throw runtimeError(`runtime_tcp_${tableName}_address_invalid`);
  }
  const port = Number.parseInt(portText, 16);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw runtimeError(`runtime_tcp_${tableName}_address_invalid`);
  }
  return { address: address.toUpperCase(), port };
}

export function tcpStateIsActiveSession(state) {
  return state === "01";
}

function listenerPortHasActiveSession(entries, listener) {
  return entries.some((entry) => (
    entry.localPort === listener.port
    && isLoopbackHex(entry.localAddress)
    && tcpStateIsActiveSession(entry.state)
  ));
}

function probePortRefused(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED"));
  });
}

function isLoopbackHex(value) {
  return value === "0100007F"
    || value === "00000000000000000000000001000000";
}

function findSessionForHandle(sessions, handle) {
  if (!handle || typeof handle.token !== "string") {
    return null;
  }
  return sessions.get(handle.token) || null;
}

function requireSessionForLease(sessions, lease) {
  if (!lease || typeof lease !== "object" || typeof lease.leaseId !== "string") {
    throw runtimeError("runtime_lease_unknown");
  }
  const session = sessions.get(lease.leaseId);
  if (!session
    || lease.relationId !== session.relationId
    || String(lease.generation) !== String(session.generation)) {
    throw runtimeError("runtime_lease_unknown");
  }
  return session;
}

function sameHandle(left, right) {
  return Boolean(left && right
    && left.relationId === right.relationId
    && String(left.generation) === String(right.generation)
    && left.token === right.token);
}

function assertFenceBinding(fence, session) {
  if (fence.relationId !== session.relationId
    || String(fence.generation) !== String(session.generation)) {
    throw runtimeError("runtime_fence_mismatch");
  }
}

function assertStartFenceBinding(fence, session) {
  assertFenceBinding(fence, session);
  if (fence.operationId !== session.startOperationId) {
    throw runtimeError("runtime_fence_mismatch");
  }
}

function assertDisableFenceBinding(fence, session, requireBound) {
  assertFenceBinding(fence, session);
  if (fence.expectedHandleDigest !== null || fence.protectionDigest !== null) {
    throw runtimeError("runtime_disable_fence_invalid");
  }
  if (session.disableOperationId !== null
    && session.disableOperationId !== fence.operationId) {
    throw runtimeError("runtime_fence_mismatch");
  }
  if (requireBound && session.disableOperationId === null) {
    throw runtimeError("runtime_disable_fence_unbound");
  }
}

function requireFence(value) {
  assertPlainObject(value, "fence");
  if (Object.keys(value).sort().join("\0") !== FENCE_KEYS.join("\0")
    || value.schemaVersion !== "1"
    || typeof value.relationId !== "string"
    || !value.relationId
    || typeof value.operationId !== "string"
    || !value.operationId
    || !isCanonicalDecimal(String(value.generation))
    || typeof value.attemptId !== "string"
    || !value.attemptId
    || (value.expectedHandleDigest !== null
      && typeof value.expectedHandleDigest !== "string")
    || (value.expectedHandleDigest !== null
      && value.expectedHandleDigest !== ""
      && !/^[0-9a-f]{64}$/.test(value.expectedHandleDigest))
    || (value.protectionDigest !== null
      && (typeof value.protectionDigest !== "string"
        || !/^[0-9a-f]{64}$/.test(value.protectionDigest)))) {
    throw runtimeError("runtime_fence_invalid");
  }
  return value;
}

function normalizePurpose(value) {
  if (value === "running" || value === "disable" || value === "cleanup") {
    return value;
  }
  throw runtimeError("runtime_inspect_purpose_invalid");
}

function normalizeListener(value) {
  assertPlainObject(value, "listener");
  if (value.host !== "127.0.0.1"
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65535) {
    throw runtimeError("runtime_listener_invalid");
  }
  return { host: value.host, port: value.port };
}

function cloneFileIdentity(value) {
  if (!value || typeof value !== "object") {
    throw runtimeError("runtime_executable_invalid");
  }
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    sha256: String(value.sha256),
    size: String(value.size)
  };
}

function createToken(random) {
  const value = random(16);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw runtimeError("runtime_random_invalid");
  }
  const token = Buffer.from(value).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(token)) {
    throw runtimeError("runtime_random_invalid");
  }
  return token;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw runtimeError("runtime_timestamp_invalid");
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string"
    || !value
    || value.trim() !== value
    || !path.isAbsolute(value)) {
    throw runtimeError(`runtime_${label}_invalid`);
  }
  return path.normalize(value);
}

function positiveInteger(value, fallback, label) {
  const selected = value == null ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw runtimeError(`runtime_${label}_invalid`);
  }
  return selected;
}

function assertPlainObject(value, label) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw runtimeError(`runtime_${label.replaceAll(" ", "_")}_invalid`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw runtimeError(`runtime_${label.replaceAll(" ", "_")}_invalid`);
  }
}

function assertKeysOnly(value, expected) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw runtimeError(`runtime_${label}_invalid`);
  }
  return value;
}

function isCanonicalDecimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

async function safeProbe(task, fallback) {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

function runtimeError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function stableSerialize(value) {
  return stableSerializeInner(value, new Set());
}

function stableSerializeInner(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw runtimeError("runtime_serialize_invalid");
    }
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    throw runtimeError("runtime_serialize_invalid");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerializeInner(item, ancestors)).join(",")}]`;
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerializeInner(value[key], ancestors)}`
    )).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function digestValue(value) {
  return digestText(stableSerialize(value));
}

function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
