import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open as openFile,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { createHttpError } from "./errors.js";
import {
  advanceStartupRecoveryBaseline,
  completeStartupRecoveryStart,
  consumeStartupRecoveryReservation,
  installStartupRecoveryAuthority,
  releaseStartupRecoveryReservation,
  reserveStartupRecoveryDescriptor,
  selectStartupRecoveryDescriptor
} from "../service/startupRecoveryPermit.js";

export const RELATION_FILE_SERVICE_MANAGER_STATE_VERSION = 2;
export const RELATION_FILE_SERVICE_MANAGER_V1_STATE_VERSION = 1;
export const RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT =
  "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1";
export const RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT =
  "single-manager-owner+injected-scoped-locks+durable-json-replace-v2";

const STATE_KIND = "relation-file-service-manager-state";
const MAX_TIMEOUT_MS = 2_147_483_647;
const OWNER_FATAL_PREINVOCATION = Symbol("ownerFatalPreinvocation");
const STATE_READ_METADATA = new WeakMap();
const STATE_KEYS = [
  "createdAt",
  "kind",
  "operations",
  "relations",
  "revision",
  "storageContract",
  "updatedAt",
  "version"
];
const V1_OPERATION_KEYS = [
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
];
const V1_RELATION_KEYS = [
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
];
const OPERATION_KEYS = [
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
];
const RELATION_KEYS = [
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
];
const HANDLE_KEYS = ["generation", "relationId", "token"];
const FENCE_KEYS = [
  "attemptId",
  "expectedHandleDigest",
  "generation",
  "operationId",
  "protectionDigest",
  "relationId",
  "schemaVersion"
];
const RUNTIME_IDENTITY_KEYS = [
  "executable",
  "listener",
  "manager",
  "namespace",
  "process",
  "schemaVersion",
  "tokenSha256"
];
const RUNTIME_NAMESPACE_KEYS = ["bootId", "pidNamespaceId"];
const RUNTIME_MANAGER_KEYS = ["pid", "starttime"];
const RUNTIME_PROCESS_KEYS = ["parentPid", "parentStarttime", "pid", "starttime"];
const RUNTIME_EXECUTABLE_KEYS = ["launcher", "target"];
const EXECUTABLE_IDENTITY_KEYS = ["dev", "ino", "sha256", "size"];
const EXPECTED_LISTENER_KEYS = ["host", "port", "role"];
const PROVISIONAL_EVIDENCE_KEYS = [
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
];
const RUNNING_EVIDENCE_KEYS = [
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
const RUNNING_LISTENER_KEYS = [
  "host",
  "open",
  "ownedByProcess",
  "port",
  "role",
  "socketDev",
  "socketIno"
];
const SESSION_KEYS = ["count", "tracked"];
const CHILDREN_KEYS = ["allTracked"];
const CAPABILITIES_KEYS = [
  "ambient",
  "bounding",
  "effective",
  "inheritable",
  "permitted"
];
const CLEANUP_EVIDENCE_KEYS = [
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
const CLEANUP_IDENTITY_KEYS = ["generation", "handleDigest", "relationId"];
const V1_PHASES = new Set(["pending", "stopping", "stopped"]);
const PHASES = new Set([
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
const ZERO_CAPABILITIES = {
  ambient: "0000000000000000",
  bounding: "0000000000000000",
  effective: "0000000000000000",
  inheritable: "0000000000000000",
  permitted: "0000000000000000"
};
const ALLOWED_REASONS = new Set([
  "",
  "cleanup_confirmed_stopped",
  "desired_not_disabled",
  "relation_file_service_cleanup_required",
  "relation_file_service_commit_uncertain",
  "relation_file_service_durable_writer_unsupported",
  "relation_file_service_expected_handle_mismatch",
  "relation_file_service_generation_history_noncanonical",
  "relation_file_service_handle_conflict",
  "relation_file_service_identity_conflict",
  "relation_file_service_late_go_returned",
  "relation_file_service_late_prepare_invalid",
  "relation_file_service_late_prepare_rejected",
  "relation_file_service_operation_conflict",
  "relation_file_service_reason_redacted",
  "relation_file_service_request_invalid",
  "relation_file_service_runtime_cleanup_unconfirmed",
  "relation_file_service_runtime_timeout",
  "relation_file_service_start_blocked",
  "relation_file_service_state_corrupt",
  "relation_file_service_state_invalid",
  "relation_file_service_state_missing",
  "relation_file_service_state_revision_conflict",
  "relation_file_service_state_write_failed",
  "relation_file_service_volatile_quarantine",
  "relation_not_found",
  "relation_operation_superseded",
  "runtime_cleanup_unconfirmed",
  "runtime_handle_mismatch",
  "runtime_handle_missing",
  "runtime_inspect_ambiguous",
  "runtime_inspect_failed",
  "runtime_inspect_invalid",
  "runtime_not_invoked",
  "runtime_ownership_unconfirmed",
  "runtime_stop_evidence_incomplete",
  "runtime_stop_failed",
  "runtime_stop_not_confirmed",
  "runtime_timeout"
]);

/**
 * V1 remains available through the frozen weak writer when durableWriter is
 * absent. V2 start and all V2 lifecycle writes require a durable writer. On
 * Linux the default writer uses the real file-system API; on other platforms
 * callers must inject a mock for manager-only tests.
 */
export async function open(options = {}) {
  assertPlainObject(options, "relation file service manager options");
  const statePath = normalizeStatePath(options.statePath);
  const mode = options.mode == null ? "auto" : options.mode;
  if (!["auto", "require-existing"].includes(mode)) {
    throw managerError(
      "relation_file_service_state_invalid",
      "manager mode must be auto or require-existing"
    );
  }
  const expectedBaseline = options.expectedBaseline == null
    ? null
    : normalizeExpectedBaseline(options.expectedBaseline);
  if (mode === "require-existing" && !expectedBaseline) {
    throw managerError(
      "relation_file_service_state_invalid",
      "require-existing mode requires an exact expectedBaseline"
    );
  }
  const withExclusiveLock = requireFunction(options.withExclusiveLock, "withExclusiveLock");
  const runtime = normalizeRuntime(options.runtime);
  const durableWriter = options.durableWriter == null
    ? (process.platform === "linux" ? createLinuxDurableWriter() : null)
    : normalizeDurableWriter(options.durableWriter);
  const protection = options.protection == null ? null : normalizeProtection(options.protection);
  const clock = options.clock == null ? (() => new Date()) : normalizeClock(options.clock);
  const random = options.randomBytes == null
    ? cryptoRandomBytes
    : requireFunction(options.randomBytes, "randomBytes");
  const runtimeTimeoutMs = options.runtimeTimeoutMs == null
    ? 5000
    : normalizeTimeout(options.runtimeTimeoutMs, "runtimeTimeoutMs");
  const protectionTimeoutMs = options.protectionTimeoutMs == null
    ? runtimeTimeoutMs
    : normalizeTimeout(options.protectionTimeoutMs, "protectionTimeoutMs");
  const protectionSettlementWatchdogMs =
    options.protectionSettlementWatchdogMs == null
      ? runtimeTimeoutMs
      : normalizeTimeout(
        options.protectionSettlementWatchdogMs,
        "protectionSettlementWatchdogMs"
      );
  const monotonicNow = options.monotonicNow == null
    ? () => performance.now()
    : requireFunction(options.monotonicNow, "monotonicNow");
  const onOwnerFatal = options.onOwnerFatal == null
    ? () => {}
    : requireFunction(options.onOwnerFatal, "onOwnerFatal");
  const ownerLease = options.ownerLease ?? null;
  const assertOwnerLease = options.assertOwnerLease == null
    ? null
    : requireFunction(options.assertOwnerLease, "assertOwnerLease");
  if ((ownerLease === null) !== (assertOwnerLease === null)) {
    throw managerError(
      "relation_file_service_state_invalid",
      "ownerLease and assertOwnerLease must be provided together"
    );
  }
  if (mode === "require-existing" && ownerLease === null) {
    throw managerError(
      "relation_file_service_state_invalid",
      "require-existing mode requires the active owner lease"
    );
  }
  const context = {
    statePath,
    mode,
    expectedBaseline,
    expected: null,
    stateParentIdentity: null,
    ownerLease,
    assertOwnerLease,
    withExclusiveLock,
    runtime,
    durableWriter,
    protection,
    clock,
    random,
    runtimeTimeoutMs,
    protectionTimeoutMs,
    protectionSettlementWatchdogMs,
    monotonicNow,
    onOwnerFatal,
    ownerFatal: null,
    ownerFatalController: new AbortController(),
    relationQueues: new Map(),
    continuations: new Map(),
    volatileQuarantine: null,
    managerFacade: null
  };

  await withStateLock(context, async () => {
    await assertOwnerCheckpoint(context);
    const snapshot = await readStateFileWithMeta(statePath);
    if (!snapshot) {
      if (mode === "require-existing") {
        throw managerError(
          "relation_file_service_state_missing",
          "relation file service state is missing in require-existing mode",
          500
        );
      }
      await writeStateFileAtomic(context, createInitialV1State(context));
      const initial = await readStateFileWithMeta(statePath);
      context.stateParentIdentity = initial.parentIdentity;
      context.expected = baselineFromSnapshot(initial);
    } else {
      context.stateParentIdentity = snapshot.parentIdentity;
      if (expectedBaseline
        && (snapshot.revision !== expectedBaseline.revision
          || snapshot.rawSha256 !== expectedBaseline.rawSha256)) {
        throw managerError(
          "relation_file_service_state_revision_conflict",
          "manager startup baseline does not match the exact state bytes",
          500
        );
      }
      context.expected = baselineFromSnapshot(snapshot);
    }
    await assertOwnerCheckpoint(context);
  });

  let facade;
  facade = Object.freeze({
    async start(input = {}) {
      const request = normalizeStartRequest(input);
      assertMutationAllowed(context);
      const recoveryMarker = { relationId: null };
      let failure = null;
      try {
        return await enqueueRelation(context.relationQueues, request.relationId, async () => {
          assertMutationAllowed(context);
          return withRelationLock(context, request.relationId, async () => {
            assertMutationAllowed(context);
            return startRelation(context, request, facade, recoveryMarker);
          });
        });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (recoveryMarker.relationId) {
          if (failure?.code === "relation_file_service_commit_uncertain"
            || context.volatileQuarantine) {
            releaseStartupRecoveryReservation(facade, {
              relationId: recoveryMarker.relationId,
              outcome: "uncertain"
            });
          } else {
            releaseStartupRecoveryReservation(facade, {
              relationId: recoveryMarker.relationId,
              outcome: "not_committed"
            });
            completeStartupRecoveryStart(facade, recoveryMarker.relationId);
          }
        }
      }
    },
    async query(input = {}) {
      assertPlainObject(input, "query request");
      assertAllowedKeys(input, ["relationId"], "query request");
      const relationId = normalizeIdentity(input.relationId, "relationId");
      return withStateLock(context, async () => {
        const state = (context.ownerFatal || context.volatileQuarantine)
          ? await readVisibleStateForQuery(context)
          : await readRequiredState(context);
        return querySnapshot(state, relationId);
      });
    },
    async disable(input = {}) {
      const request = normalizeDisableRequest(input);
      assertMutationAllowed(context);
      return enqueueRelation(context.relationQueues, request.relationId, async () => {
        assertMutationAllowed(context);
        return withRelationLock(context, request.relationId, async () => {
          assertMutationAllowed(context);
          return disableRelation(context, request);
        });
      });
    },
    async reconcile(input = {}) {
      assertPlainObject(input, "reconcile request");
      assertAllowedKeys(input, ["relationId"], "reconcile request");
      const relationId = normalizeIdentity(input.relationId, "relationId");
      assertMutationAllowed(context);
      return enqueueRelation(context.relationQueues, relationId, async () => {
        assertMutationAllowed(context);
        return withRelationLock(context, relationId, async () => {
          assertMutationAllowed(context);
          return reconcileRelation(context, relationId);
        });
      });
    }
  });
  context.managerFacade = facade;
  if (options.startupRecoveryAuthority != null) {
    installStartupRecoveryAuthority(facade, options.startupRecoveryAuthority);
  }
  return facade;
}

async function startRelation(context, request, managerFacade, recoveryMarker) {
  assertMutationAllowed(context);
  assertStartCapabilities(context);
  const preflight = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const state = await readRequiredState(context);
    assertOwnerNotFatal(context);
    try {
      return prepareStartPreflight(state, request);
    } catch (error) {
      if (error?.code !== "relation_file_service_start_blocked") {
        throw error;
      }
      const metadata = STATE_READ_METADATA.get(state);
      const descriptor = selectStartupRecoveryDescriptor(managerFacade, {
        relationId: request.relationId,
        state,
        revision: metadata.revision,
        rawSha256: metadata.rawSha256
      });
      if (!descriptor) {
        throw error;
      }
      recoveryMarker.relationId = request.relationId;
      return { recoveryDescriptor: descriptor };
    }
  });
  assertOwnerWritable(context);
  if (preflight.returnValue !== undefined) {
    return preflight.returnValue;
  }
  if (preflight.retryBinding) {
    const retryBinding = preflight.retryBinding;
    const retryFence = createFence({
      relationId: request.relationId,
      operationId: retryBinding.operationId,
      generation: retryBinding.generation,
      attemptId: randomAttemptId(context),
      expectedHandleDigest: retryBinding.expectedHandleDigest,
      protectionDigest: retryBinding.protectionDigest
    });
    assertOwnerWritable(context);
    const retryInspection = await boundedInvoke(context, {
      phase: "retry-cleanup",
      fence: retryFence,
      operation: (signal, fence) => context.runtime.inspect(
        structuredClone(retryBinding.handle),
        { signal, fence, purpose: "cleanup" }
      )
    });
    assertOwnerWritable(context);
    if (retryInspection.kind !== "fulfilled"
      || !validateCleanupEvidence(
        retryInspection.value,
        retryBinding.handle,
        retryFence,
        "confirmedStopped"
      )) {
      throw managerError(
        "relation_file_service_start_blocked",
        "Previous runtime cleanup could not be re-confirmed"
      );
    }
  }

  assertOwnerWritable(context);
  const reservation = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    let generation;
    if (preflight.retryBinding) {
      assertRetryBindingUnchanged(current, preflight.retryBinding, request);
      generation = preflight.retryBinding.nextGeneration;
    } else if (preflight.recoveryDescriptor) {
      const metadata = STATE_READ_METADATA.get(current);
      const repeated = selectStartupRecoveryDescriptor(managerFacade, {
        relationId: request.relationId,
        state: current,
        revision: metadata.revision,
        rawSha256: metadata.rawSha256
      });
      if (!repeated
        || repeated.relationRecordSha256
          !== preflight.recoveryDescriptor.relationRecordSha256
        || repeated.operationRecordSha256
          !== preflight.recoveryDescriptor.operationRecordSha256
        || repeated.historySha256 !== preflight.recoveryDescriptor.historySha256) {
        throw managerError(
          "relation_file_service_start_blocked",
          "Recovery descriptor changed before reservation"
        );
      }
      reserveStartupRecoveryDescriptor(managerFacade, repeated);
      generation = allocateGeneration(current, request.relationId);
    } else {
      const repeated = prepareStartPreflight(current, request);
      if (repeated.returnValue !== undefined) {
        return { returnValue: repeated.returnValue };
      }
      if (repeated.retryBinding) {
        throw managerError(
          "relation_file_service_start_blocked",
          "Previous runtime cleanup state changed before reservation"
        );
      }
      generation = allocateGeneration(current, request.relationId);
    }
    const now = nowIso(context);
    const attemptId = randomAttemptId(context);
    const expectedHandleDigest = current.relations[request.relationId]?.handleDigest ?? "";
    const base = current.version === 1
      ? migrateV1State(current, context)
      : structuredClone(current);
    base.operations[request.operationId] = createStartOperation({
      request,
      relationId: request.relationId,
      operationId: request.operationId,
      generation,
      expectedHandleDigest,
      now
    });
    base.relations[request.relationId] = createStartRelation({
      request,
      generation,
      expectedHandleDigest,
      now
    });
    base.revision = current.revision + 1;
    base.updatedAt = now;
    assertManagerState(base);
    try {
      await commitState(context, current, base, attemptId);
    } catch (error) {
      if (preflight.recoveryDescriptor) {
        releaseStartupRecoveryReservation(managerFacade, {
          relationId: request.relationId,
          outcome: error?.code === "relation_file_service_commit_uncertain"
            ? "uncertain"
            : "not_committed"
        });
      }
      throw error;
    }
    if (preflight.recoveryDescriptor) {
      consumeStartupRecoveryReservation(managerFacade, {
        relationId: request.relationId,
        revision: context.expected.revision,
        rawSha256: context.expected.rawSha256
      });
    }
    return {
      record: structuredClone(base.relations[request.relationId]),
      attemptId
    };
  });
  assertOwnerWritable(context);
  if (reservation.returnValue !== undefined) {
    return reservation.returnValue;
  }

  let fence = createFence({
    relationId: request.relationId,
    operationId: request.operationId,
    generation: reservation.record.generation,
    attemptId: reservation.attemptId,
    expectedHandleDigest: request.expectedHandleDigest,
    protectionDigest: null
  });
  let protectionDigest;
  const protectionOutcome = await invokeProtectionSettlement(context, {
    fence,
    operation: (signal, observedFence) => context.protection.verify({
      relationId: request.relationId,
      operationId: request.operationId,
      generation: reservation.record.generation,
      fence: observedFence,
      signal
    })
  });
  if (context.ownerFatal || protectionOutcome.kind === "fatal_late_confirmed") {
    throw ownerFatalError(context);
  }
  if (protectionOutcome.kind === "failed_settled") {
    assertOwnerWritable(context);
    await persistNotInvokedFailure(context, reservation.record, "protection");
    throw managerError(
      "relation_file_service_start_blocked",
      "Runtime protection verification failed"
    );
  }
  if (protectionOutcome.kind !== "verified") {
    throw managerError(
      "relation_file_service_start_blocked",
      "Runtime protection returned an unsupported settlement"
    );
  }
  assertOwnerWritable(context);
  protectionDigest = protectionOutcome.protectionDigest;
  fence = createFence({ ...fence, protectionDigest });

  assertOwnerWritable(context);
  const prepareOutcome = await boundedInvoke(context, {
    phase: "prepare",
    fence,
    operation: (signal, observedFence) => context.runtime.prepare(
      { launch: request.launch },
      { signal, fence: observedFence }
    )
  });
  if (context.ownerFatal) {
    if (prepareOutcome.kind === "timeout") {
      registerLatePrepareContinuation(context, {
        fence,
        record: reservation.record,
        continuation: prepareOutcome.continuation,
        launch: request.launch
      });
    }
    await cleanupExactAttemptAfterOwnerFatal(context, {
      fence,
      lease: prepareOutcome.kind === "fulfilled"
        ? prepareOutcome.value?.lease
        : null,
      handle: prepareOutcome.kind === "fulfilled"
        ? prepareOutcome.value?.handle
        : null
    });
    throw ownerFatalError(context);
  }
  assertOwnerWritable(context);
  if (prepareOutcome.kind !== "fulfilled") {
    if (prepareOutcome.kind === "timeout") {
      await persistCleanupRequired(context, reservation.record, {
        checkpoint: "prepare-pending",
        continuationRegistered: true,
        latePrepare: "pending",
        runtimeInvoked: true,
        leaseReturned: false,
        reasonCode: "relation_file_service_runtime_timeout"
      });
      registerLatePrepareContinuation(context, {
        fence,
        record: reservation.record,
        continuation: prepareOutcome.continuation,
        launch: request.launch
      });
      throw managerError(
        "relation_file_service_runtime_timeout",
        "Runtime prepare timed out"
      );
    }
    const cleanupEvidence = cleanupEvidenceFromRejection(prepareOutcome.error);
    if (cleanupEvidence
      && validateCleanupEvidence(cleanupEvidence, reservation.record.handle, fence, "notInvoked")) {
      await persistStartFailed(context, reservation.record, cleanupEvidence);
      throw managerError(
        "relation_file_service_start_blocked",
        "Runtime prepare was rejected before invocation"
      );
    }
    await persistCleanupRequired(context, reservation.record, {
      checkpoint: "prepare-pending",
      continuationRegistered: true,
      latePrepare: "rejected",
      runtimeInvoked: true,
      leaseReturned: false,
      reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Runtime prepare failed without complete cleanup evidence"
    );
  }

  let prepared;
  try {
    prepared = validatePrepareResult(
      prepareOutcome.value,
      request,
      reservation.record,
      fence
    );
  } catch {
    const returnedLease = prepareOutcome.value?.lease ?? null;
    let invalidPrepareAbort = null;
    if (hasOpaqueLease(returnedLease)) {
      invalidPrepareAbort = await boundedInvoke(context, {
        phase: "abort",
        fence,
        operation: (signal, observedFence) => context.runtime.abort(
          returnedLease,
          { signal, fence: observedFence }
        )
      });
    }
    const continuationRegistered = invalidPrepareAbort?.kind === "timeout";
    const evidence = createUnconfirmedCleanupEvidence({
      handle: null,
      checkpoint: "prepare-ready",
      continuationRegistered,
      latePrepare: "not-applicable",
      lateGo: "not-applicable",
      runtimeInvoked: true,
      leaseReturned: hasOpaqueLease(returnedLease),
      reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
    });
    evidence.abortRequested = hasOpaqueLease(returnedLease);
    evidence.abortCompleted = invalidPrepareAbort?.kind === "fulfilled";
    evidence.containmentConfirmed = invalidPrepareAbort?.kind === "fulfilled"
      && invalidPrepareAbort.value?.containmentConfirmed === true;
    if (continuationRegistered) {
      registerLateSimpleContinuation(context, {
        fence,
        record: reservation.record,
        lease: returnedLease,
        phase: "abort",
        continuation: invalidPrepareAbort.continuation
      });
    }
    await persistCleanupRequired(context, reservation.record, {
      evidence,
      checkpoint: "prepare-ready",
      continuationRegistered,
      latePrepare: "not-applicable",
      lateGo: "not-applicable",
      runtimeInvoked: true,
      leaseReturned: hasOpaqueLease(returnedLease),
      reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Runtime prepare result was invalid"
    );
  }
  const lease = prepared.lease;
  let preparedRecord;
  try {
    assertOwnerWritable(context);
    preparedRecord = await withStateLock(context, async () => {
      assertOwnerNotFatal(context);
      const current = await readRequiredState(context);
      assertOwnerWritable(context);
      const next = structuredClone(current);
      const operation = next.operations[request.operationId];
      const relation = next.relations[request.relationId];
      if (!operation
        || !relation
        || relation.operationId !== request.operationId
        || relation.generation !== reservation.record.generation) {
        throw new Error("reservation superseded");
      }
      applyPrepared(operation, relation, prepared, protectionDigest, context);
      next.revision = current.revision + 1;
      next.updatedAt = nowIso(context);
      assertManagerState(next);
      await commitState(context, current, next, fence.attemptId);
      return structuredClone(relation);
    });
    assertOwnerWritable(context);
  } catch (error) {
    if (context.ownerFatal) {
      await cleanupExactAttemptAfterOwnerFatal(context, {
        fence,
        lease,
        handle: prepared.handle
      });
      throw ownerFatalError(context);
    }
    await cleanupFailedAttempt(context, {
      fence,
      record: reservation.record,
      lease,
      handle: prepared.handle,
      handleDigest: prepared.handleDigest,
      runtimeIdentity: prepared.runtimeIdentity,
      provisionalEvidence: prepared.provisionalEvidence,
      checkpoint: "prepare-ready"
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Prepared runtime could not be durably recorded"
    );
  }

  const goOutcome = await boundedInvoke(context, {
    phase: "go",
    fence,
    operation: (signal, observedFence) => context.runtime.go(
      lease,
      { signal, fence: observedFence }
    )
  });
  if (context.ownerFatal) {
    if (goOutcome.kind === "timeout") {
      registerLateSimpleContinuation(context, {
        fence,
        record: preparedRecord,
        lease,
        phase: "go",
        continuation: goOutcome.continuation
      });
    }
    await cleanupExactAttemptAfterOwnerFatal(context, {
      fence,
      lease,
      handle: prepared.handle
    });
    throw ownerFatalError(context);
  }
  assertOwnerWritable(context);
  if (goOutcome.kind !== "fulfilled") {
    if (goOutcome.kind === "timeout") {
      await persistCleanupRequired(context, preparedRecord, {
        checkpoint: "go-pending",
        continuationRegistered: true,
        latePrepare: "not-applicable",
        lateGo: "pending",
        runtimeInvoked: true,
        leaseReturned: true,
        reasonCode: "relation_file_service_runtime_timeout"
      });
      registerLateSimpleContinuation(context, {
        fence,
        record: preparedRecord,
        lease,
        phase: "go",
        continuation: goOutcome.continuation
      });
      await cleanupFailedAttempt(context, {
        fence,
        record: preparedRecord,
        lease,
        checkpoint: "go-pending",
        cleanupAlreadyRequired: true
      });
      throw managerError(
        "relation_file_service_runtime_timeout",
        "Runtime go timed out"
      );
    }
    await cleanupFailedAttempt(context, {
      fence,
      record: preparedRecord,
      lease,
      checkpoint: "go-pending"
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Runtime go failed"
    );
  }

  const inspectOutcome = await boundedInvoke(context, {
    phase: "inspect-running",
    fence,
    operation: (signal, observedFence) => context.runtime.inspect(
      prepared.handle,
      { signal, fence: observedFence, purpose: "running" }
    )
  });
  if (context.ownerFatal) {
    if (inspectOutcome.kind === "timeout") {
      registerLateSimpleContinuation(context, {
        fence,
        record: preparedRecord,
        lease,
        phase: "inspect",
        continuation: inspectOutcome.continuation
      });
    }
    await cleanupExactAttemptAfterOwnerFatal(context, {
      fence,
      lease,
      handle: prepared.handle
    });
    throw ownerFatalError(context);
  }
  assertOwnerWritable(context);
  if (inspectOutcome.kind !== "fulfilled"
    || !validateRunningEvidence(
      inspectOutcome.value,
      prepared.handle,
      prepared.runtimeIdentity,
      fence
    )) {
    await persistCleanupRequired(context, preparedRecord, {
      checkpoint: "inspect-pending",
      continuationRegistered: inspectOutcome.kind === "timeout",
      latePrepare: "not-applicable",
      lateGo: "not-applicable",
      runtimeInvoked: true,
      leaseReturned: true,
      reasonCode: inspectOutcome.kind === "timeout"
        ? "relation_file_service_runtime_timeout"
        : "relation_file_service_runtime_cleanup_unconfirmed"
    });
    if (inspectOutcome.kind === "timeout") {
      registerLateSimpleContinuation(context, {
        fence,
        record: preparedRecord,
        lease,
        phase: "inspect",
        continuation: inspectOutcome.continuation
      });
    }
    await cleanupFailedAttempt(context, {
      fence,
      record: preparedRecord,
      lease,
      checkpoint: "inspect-pending",
      cleanupAlreadyRequired: true
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Runtime running evidence was incomplete"
    );
  }

  const runningEvidenceDigest = digestValue(inspectOutcome.value);
  let finalization;
  try {
    assertOwnerWritable(context);
    finalization = await withStateLock(context, async () => {
      assertOwnerNotFatal(context);
      const current = await readRequiredState(context);
      assertOwnerWritable(context);
      const next = structuredClone(current);
      const operation = next.operations[request.operationId];
      const relation = next.relations[request.relationId];
      if (!operation
        || !relation
        || relation.operationId !== request.operationId
        || relation.generation !== prepared.handle.generation
        || relation.handleDigest !== prepared.handleDigest
        || operation.expectedHandleDigest !== request.expectedHandleDigest
        || operation.protectionDigest !== protectionDigest) {
        return { superseded: true };
      }
      operation.phase = "running";
      operation.reason = "";
      operation.runningEvidenceDigest = runningEvidenceDigest;
      operation.updatedAt = nowIso(context);
      relation.phase = "running";
      relation.reason = "";
      relation.runningEvidenceDigest = runningEvidenceDigest;
      relation.updatedAt = operation.updatedAt;
      next.revision = current.revision + 1;
      next.updatedAt = operation.updatedAt;
      assertManagerState(next);
      await commitState(context, current, next, fence.attemptId);
      return { result: resultFromRecord(relation) };
    });
    assertOwnerWritable(context);
  } catch (error) {
    if (context.ownerFatal) {
      await cleanupExactAttemptAfterOwnerFatal(context, {
        fence,
        lease,
        handle: prepared.handle
      });
      throw ownerFatalError(context);
    }
    if (error?.code === "relation_file_service_commit_uncertain"
      || error?.code === "relation_file_service_volatile_quarantine") {
      throw error;
    }
    await cleanupFailedAttempt(context, {
      fence,
      record: preparedRecord,
      lease,
      checkpoint: "finalize-pending"
    });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Running state could not be durably finalized"
    );
  }
  if (finalization.superseded) {
    await reclaimSupersededLease(context, { fence, lease });
    throw managerError(
      "relation_file_service_runtime_cleanup_unconfirmed",
      "Running state could not be durably finalized"
    );
  }
  return finalization.result;
}

async function cleanupFailedAttempt(context, details) {
  const cleanupHandle = details.handle || details.record.handle || null;
  const abortOutcome = await boundedInvoke(context, {
    phase: "abort",
    fence: details.fence,
    operation: (signal, fence) => context.runtime.abort(
      details.lease,
      { signal, fence }
    )
  });
  if (abortOutcome.kind === "timeout") {
    registerLateSimpleContinuation(context, {
      fence: details.fence,
      record: details.record,
      lease: details.lease,
      phase: "abort",
      continuation: abortOutcome.continuation
    });
  }
  const containmentConfirmed = abortOutcome.kind === "fulfilled"
    && abortOutcome.value?.containmentConfirmed === true;
  const cleanupInspection = await boundedInvoke(context, {
    phase: "inspect-cleanup",
    fence: details.fence,
    operation: (signal, fence) => context.runtime.inspect(
      cleanupHandle,
      { signal, fence, purpose: "cleanup" }
    )
  });
  const evidence = createUnconfirmedCleanupEvidence({
    handle: cleanupHandle,
    checkpoint: details.checkpoint,
    continuationRegistered: true,
    latePrepare: "not-applicable",
    lateGo: details.checkpoint === "go-pending" ? "pending" : "not-applicable",
    runtimeInvoked: true,
    leaseReturned: true,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
  });
  if (!details.cleanupAlreadyRequired) {
    await persistCleanupRequired(context, details.record, {
      evidence,
      checkpoint: details.checkpoint,
      continuationRegistered: true,
      latePrepare: "not-applicable",
      lateGo: details.checkpoint === "go-pending" ? "pending" : "not-applicable",
      runtimeInvoked: true,
      leaseReturned: true,
      handle: details.handle,
      handleDigest: details.handleDigest,
      runtimeIdentity: details.runtimeIdentity,
      provisionalEvidence: details.provisionalEvidence,
      protectionDigest: details.fence.protectionDigest,
      reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
    });
  }
  if (containmentConfirmed
    && cleanupInspection.kind === "fulfilled"
    && validateCleanupEvidence(
      cleanupInspection.value,
      cleanupHandle,
      details.fence,
      "confirmedStopped"
    )) {
    queueRecovery(context, {
      fence: details.fence,
      record: details.record,
      lease: details.lease,
      handle: details.handle,
      handleDigest: details.handleDigest,
      runtimeIdentity: details.runtimeIdentity,
      provisionalEvidence: details.provisionalEvidence,
      cleanupEvidence: structuredClone(cleanupInspection.value)
    });
    return;
  }
}

function registerLatePrepareContinuation(context, details) {
  const registry = details.continuation;
  registry.record = details.record;
  registry.fence = details.fence;
  subscribeContinuation(registry, (outcome) => {
    if (outcome.kind === "fulfilled") {
      try {
        const prepared = validatePrepareResult(
          outcome.value,
          {
            relationId: details.fence.relationId,
            operationId: details.fence.operationId,
            expectedHandleDigest: details.fence.expectedHandleDigest,
            launch: details.launch
          },
          details.record,
          details.fence
        );
        registry.lease = prepared.lease;
        registry.latePrepare = "lease-returned";
        queueRecovery(context, {
          fence: details.fence,
          record: details.record,
          lease: prepared.lease,
          handle: prepared.handle,
          handleDigest: prepared.handleDigest,
          runtimeIdentity: prepared.runtimeIdentity,
          provisionalEvidence: prepared.provisionalEvidence
        });
      } catch {
        const returnedLease = outcome.value?.lease ?? null;
        registry.lease = returnedLease;
        registry.latePrepare = "invalid";
        queueRecovery(context, {
          fence: details.fence,
          record: details.record,
          lease: returnedLease,
          latePrepareInvalid: true,
          reasonCode: "relation_file_service_late_prepare_invalid"
        });
      }
      return;
    }
    registry.latePrepare = "rejected";
    queueRecovery(context, {
      fence: details.fence,
      record: details.record,
      lease: null,
      reasonCode: "relation_file_service_late_prepare_rejected"
    });
  });
}

function registerLateSimpleContinuation(context, details) {
  const registry = details.continuation;
  registry.record = details.record;
  registry.fence = details.fence;
  registry.lease = details.lease;
  subscribeContinuation(registry, (outcome) => {
    if (details.phase === "abort") {
      queueRecovery(context, {
        fence: details.fence,
        record: details.record,
        lease: details.lease,
        abortOutcome: outcome
      });
      return;
    }
    queueRecovery(context, {
      fence: details.fence,
      record: details.record,
      lease: details.lease,
      reasonCode: outcome.kind === "rejected"
        ? "relation_file_service_runtime_cleanup_unconfirmed"
        : details.phase === "go"
          ? "relation_file_service_late_go_returned"
          : "relation_file_service_runtime_cleanup_unconfirmed"
    });
  });
}

function queueRecovery(context, details) {
  const reportFailure = (error) => {
    if (process.env.SFSC_DEBUG_MANAGER_RECOVERY === "1") {
      console.error("relation manager recovery failed", error);
    }
  };
  const cleanupAfterFatal = () => cleanupExactAttemptAfterOwnerFatal(
    context,
    details
  ).catch(reportFailure);
  if (context.ownerFatal) {
    setImmediate(cleanupAfterFatal);
    return;
  }
  setImmediate(() => {
    if (context.ownerFatal) {
      cleanupAfterFatal();
      return;
    }
    enqueueRelation(context.relationQueues, details.record.relationId, async () => (
      context.ownerFatal
        ? cleanupExactAttemptAfterOwnerFatal(context, details)
        : withRelationLock(context, details.record.relationId, async () => {
          if (context.ownerFatal) {
            await cleanupExactAttemptAfterOwnerFatal(context, details);
            return;
          }
          await recoverLateCleanup(context, details);
        })
    )).catch(reportFailure);
  });
}

async function recoverLateCleanup(context, details) {
  if (context.ownerFatal) {
    await cleanupExactAttemptAfterOwnerFatal(context, details);
    return;
  }
  const hasSettledAbortOutcome = details.abortOutcome !== undefined;
  if (context.volatileQuarantine) {
    if (!hasSettledAbortOutcome) {
      await reclaimSupersededLease(context, details);
    }
    return;
  }
  const snapshot = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const state = await readRequiredState(context);
    assertOwnerNotFatal(context);
    return structuredClone(state);
  });
  if (context.ownerFatal) {
    await cleanupExactAttemptAfterOwnerFatal(context, details);
    return;
  }
  const operation = snapshot.operations[details.record.operationId];
  const relation = snapshot.relations[details.record.relationId];
  const handleDigestMatches = relation?.handleDigest === details.record.handleDigest
    || relation?.handleDigest === details.handleDigest
    || (relation?.handle === null && relation?.handleDigest === "");
  if (!operation
    || !relation
    || relation.operationId !== details.record.operationId
    || relation.generation !== details.record.generation
    || !handleDigestMatches
    || relation.desired !== "enabled") {
    if (!hasSettledAbortOutcome) {
      await reclaimSupersededLease(context, details);
    }
    return;
  }
  if (operation.commitUncertain || relation.commitUncertain) {
    if (!hasSettledAbortOutcome) {
      await reclaimSupersededLease(context, details);
    }
    return;
  }
  if (operation.cleanupRequired !== true) {
    return;
  }
  if (details.latePrepareInvalid) {
    const leaseReturned = hasOpaqueLease(details.lease);
    const abortOutcome = leaseReturned
      ? await boundedInvoke(context, {
        phase: "recovery-abort",
        fence: details.fence,
        operation: (signal, fence) => context.runtime.abort(
          details.lease,
          { signal, fence }
        )
      })
      : null;
    const continuationRegistered = abortOutcome?.kind === "timeout";
    if (continuationRegistered) {
      registerLateSimpleContinuation(context, {
        fence: details.fence,
        record: details.record,
        lease: details.lease,
        phase: "abort",
        continuation: abortOutcome.continuation
      });
    }
    const observedAbortOutcome = continuationRegistered
      && abortOutcome.continuation.settled
      ? abortOutcome.continuation.settlement
      : abortOutcome;
    const evidence = createUnconfirmedCleanupEvidence({
      handle: null,
      checkpoint: "prepare-ready",
      continuationRegistered,
      latePrepare: "invalid",
      runtimeInvoked: true,
      leaseReturned,
      reasonCode: "relation_file_service_late_prepare_invalid"
    });
    evidence.abortRequested = leaseReturned;
    evidence.abortCompleted = observedAbortOutcome?.kind === "fulfilled";
    evidence.containmentConfirmed = observedAbortOutcome?.kind === "fulfilled"
      && observedAbortOutcome.value?.containmentConfirmed === true;
    await persistCleanupRequired(context, relation, {
      evidence,
      checkpoint: "prepare-ready",
      continuationRegistered,
      latePrepare: "invalid",
      runtimeInvoked: true,
      leaseReturned,
      reasonCode: "relation_file_service_late_prepare_invalid"
    });
    return;
  }
  if (!hasOpaqueLease(details.lease)) {
    const evidence = createUnconfirmedCleanupEvidence({
      handle: relation.handle,
      checkpoint: "prepare-pending",
      continuationRegistered: true,
      latePrepare: details.reasonCode === "relation_file_service_late_prepare_rejected"
        ? "rejected"
        : "pending",
      runtimeInvoked: true,
      leaseReturned: false,
      reasonCode: details.reasonCode || "relation_file_service_runtime_cleanup_unconfirmed"
    });
    await persistCleanupRequired(context, relation, {
      evidence,
      checkpoint: evidence.lastRuntimeCheckpoint,
      continuationRegistered: true,
      latePrepare: evidence.latePrepare,
      runtimeInvoked: true,
      leaseReturned: false,
      reasonCode: evidence.reasonCode
    });
    return;
  }

  const cleanupHandle = relation.handle || details.handle || null;
  if (!cleanupHandle) {
    if (hasSettledAbortOutcome) {
      await persistLateAbortContinuationEvidence(
        context,
        relation,
        details.record,
        details.abortOutcome
      );
    } else {
      await reclaimSupersededLease(context, details);
    }
    return;
  }
  const abortOutcome = hasSettledAbortOutcome
    ? details.abortOutcome
    : await boundedInvoke(context, {
      phase: "recovery-abort",
      fence: details.fence,
      operation: (signal, fence) => context.runtime.abort(
        details.lease,
        { signal, fence }
      )
    });
  if (context.ownerFatal) {
    await cleanupExactAttemptAfterOwnerFatal(context, details);
    return;
  }
  const containmentConfirmed = abortOutcome.kind === "fulfilled"
    && abortOutcome.value?.containmentConfirmed === true;
  const inspectOutcome = containmentConfirmed
    ? await boundedInvoke(context, {
      phase: "recovery-inspect",
      fence: details.fence,
      operation: (signal, fence) => context.runtime.inspect(
        cleanupHandle,
        { signal, fence, purpose: "cleanup" }
      )
    })
    : null;
  if (context.ownerFatal) {
    await cleanupExactAttemptAfterOwnerFatal(context, details);
    return;
  }
  if (!containmentConfirmed
    || inspectOutcome?.kind !== "fulfilled"
    || !validateCleanupEvidence(
      inspectOutcome.value,
      cleanupHandle,
      details.fence,
      "confirmedStopped"
    )) {
    if (hasSettledAbortOutcome) {
      await persistLateAbortContinuationEvidence(
        context,
        relation,
        details.record,
        abortOutcome
      );
    }
    return;
  }
  await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    if (context.volatileQuarantine) {
      return;
    }
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    const next = structuredClone(current);
    const nextOperation = next.operations[details.record.operationId];
    const nextRelation = next.relations[details.record.relationId];
    const nextHandleDigestMatches = nextRelation?.handleDigest === details.record.handleDigest
      || nextRelation?.handleDigest === details.handleDigest
      || (nextRelation?.handle === null && nextRelation?.handleDigest === "");
    if (!nextOperation
      || !nextRelation
      || nextRelation.operationId !== details.record.operationId
      || nextRelation.generation !== details.record.generation
      || !nextHandleDigestMatches
      || nextRelation.desired !== "enabled"
      || nextOperation.commitUncertain
      || nextRelation.commitUncertain
      || nextOperation.cleanupRequired !== true) {
      return;
    }
    if (!nextRelation.handle && details.handle) {
      nextRelation.handle = structuredClone(details.handle);
      nextRelation.handleDigest = details.handleDigest;
      nextOperation.handleDigest = details.handleDigest;
      nextRelation.runtimeIdentity = structuredClone(details.runtimeIdentity);
      nextRelation.provisionalEvidence = structuredClone(details.provisionalEvidence);
      nextOperation.runtimeIdentity = structuredClone(details.runtimeIdentity);
      nextOperation.provisionalEvidence = structuredClone(details.provisionalEvidence);
      nextRelation.protectionDigest = details.fence.protectionDigest;
      nextOperation.protectionDigest = details.fence.protectionDigest;
    }
    applyCleanupFailure(
      nextOperation,
      nextRelation,
      inspectOutcome.value,
      "start_failed",
      context
    );
    next.revision = current.revision + 1;
    next.updatedAt = nowIso(context);
    assertManagerState(next);
    await commitState(context, current, next, details.fence.attemptId);
  });
}

async function persistLateAbortContinuationEvidence(context, relation, record, outcome) {
  const currentEvidence = relation.cleanupEvidence;
  if (!currentEvidence || currentEvidence.disposition !== "unconfirmed") {
    return;
  }
  const evidence = structuredClone(currentEvidence);
  evidence.abortRequested = true;
  evidence.abortCompleted = outcome.kind === "fulfilled";
  evidence.containmentConfirmed = outcome.kind === "fulfilled"
    && outcome.value?.containmentConfirmed === true;
  evidence.continuationRegistered = true;
  evidence.reasonCode = "relation_file_service_runtime_cleanup_unconfirmed";
  await persistCleanupRequired(context, record, {
    evidence,
    checkpoint: evidence.lastRuntimeCheckpoint,
    continuationRegistered: true,
    latePrepare: evidence.latePrepare,
    lateGo: evidence.lateGo,
    runtimeInvoked: evidence.runtimeInvoked,
    leaseReturned: evidence.leaseReturned,
    reasonCode: evidence.reasonCode
  });
}

async function reclaimSupersededLease(context, details) {
  if (!hasOpaqueLease(details.lease)) {
    return;
  }
  await boundedInvoke(context, {
    phase: "superseded-reclaim",
    fence: details.fence,
    operation: (signal, fence) => context.runtime.abort(
      details.lease,
      { signal, fence }
    )
  });
}

async function persistNotInvokedFailure(context, record, checkpoint) {
  await persistStartFailed(context, record, createNotInvokedCleanupEvidence(checkpoint), context);
}

async function persistStartFailed(context, record, cleanupEvidence) {
  await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    if (current.version !== 2) {
      throw new Error("V1 state cannot hold a start failure");
    }
    const next = structuredClone(current);
    const operation = next.operations[record.operationId];
    const relation = next.relations[record.relationId];
    if (!operation
      || !relation
      || relation.operationId !== record.operationId
      || relation.generation !== record.generation) {
      return;
    }
    applyCleanupFailure(operation, relation, cleanupEvidence, "start_failed", context);
    next.revision = current.revision + 1;
    next.updatedAt = nowIso(context);
    assertManagerState(next);
    await commitState(context, current, next, `${operation.operationId}-start-failed`);
  });
}

async function persistCleanupRequired(context, record, details) {
  await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    if (current.version !== 2) {
      return;
    }
    const next = structuredClone(current);
    const operation = next.operations[record.operationId];
    const relation = next.relations[record.relationId];
    if (!operation
      || !relation
      || relation.operationId !== record.operationId
      || relation.generation !== record.generation
      || relation.handleDigest !== record.handleDigest) {
      return;
    }
    if (!relation.handle && details.handle) {
      relation.handle = structuredClone(details.handle);
      relation.handleDigest = details.handleDigest;
      operation.handleDigest = details.handleDigest;
      if (details.runtimeIdentity && details.provisionalEvidence) {
        relation.runtimeIdentity = structuredClone(details.runtimeIdentity);
        relation.provisionalEvidence = structuredClone(details.provisionalEvidence);
        operation.runtimeIdentity = structuredClone(details.runtimeIdentity);
        operation.provisionalEvidence = structuredClone(details.provisionalEvidence);
      }
      if (details.protectionDigest) {
        relation.protectionDigest = details.protectionDigest;
        operation.protectionDigest = details.protectionDigest;
      }
    }
    const evidence = details.evidence || createUnconfirmedCleanupEvidence({
      handle: relation.handle,
      checkpoint: details.checkpoint,
      continuationRegistered: details.continuationRegistered,
      latePrepare: details.latePrepare,
      lateGo: details.lateGo,
      runtimeInvoked: details.runtimeInvoked,
      leaseReturned: details.leaseReturned,
      reasonCode: details.reasonCode
    });
    applyCleanupFailure(operation, relation, evidence, "cleanup_required", context);
    operation.commitUncertain = operation.commitUncertain === true;
    relation.commitUncertain = relation.commitUncertain === true;
    next.revision = current.revision + 1;
    next.updatedAt = nowIso(context);
    assertManagerState(next);
    await commitState(context, current, next, `${operation.operationId}-cleanup`);
  });
}

function applyCleanupFailure(operation, relation, cleanupEvidence, phase, context) {
  const now = nowIso(context);
  operation.phase = phase;
  relation.phase = phase;
  operation.reason = phase === "start_failed" ? "" : cleanupEvidence.reasonCode;
  relation.reason = operation.reason;
  operation.cleanupRequired = phase === "cleanup_required";
  relation.cleanupRequired = operation.cleanupRequired;
  operation.cleanupEvidence = structuredClone(cleanupEvidence);
  relation.cleanupEvidence = structuredClone(cleanupEvidence);
  operation.updatedAt = now;
  relation.updatedAt = now;
}

function prepareStartPreflight(state, request) {
  const existingOperation = state.operations[request.operationId];
  if (existingOperation) {
    if (existingOperation.requestDigest !== request.requestDigest) {
      throw managerError(
        "relation_file_service_operation_conflict",
        "operationId was already used with different start parameters"
      );
    }
    const existingRelation = state.relations[existingOperation.relationId];
    if (existingRelation?.operationId === request.operationId) {
      return { returnValue: resultFromRecord(existingRelation) };
    }
    throw managerError(
      "relation_file_service_operation_conflict",
      "operationId belongs to a superseded relation operation"
    );
  }
  const relation = state.relations[request.relationId];
  if (relation) {
    if (relation.identityDigest !== request.identityDigest) {
      throw managerError(
        "relation_file_service_identity_conflict",
        "relationId is already bound to a different service identity"
      );
    }
    if (relation.desired === "disabled") {
      throw managerError(
        "relation_file_service_start_blocked",
        "relation desired state is disabled"
      );
    }
    if (relation.handleDigest !== request.expectedHandleDigest) {
      throw managerError(
        "relation_file_service_expected_handle_mismatch",
        "expectedHandleDigest does not match the current relation"
      );
    }
    if (relation.commitUncertain || relation.cleanupRequired) {
      throw managerError(
        relation.commitUncertain
          ? "relation_file_service_commit_uncertain"
          : "relation_file_service_cleanup_required",
        "relation has unresolved durable lifecycle state"
      );
    }
    if (relation.phase !== "start_failed") {
      throw managerError(
        "relation_file_service_start_blocked",
        "relation already has a non-retryable runtime phase"
      );
    }
    const evidence = relation.cleanupEvidence;
    if (!evidence || !validateCleanupEvidence(evidence, relation.handle, null, null)) {
      throw managerError(
        "relation_file_service_start_blocked",
        "start_failed cleanup evidence is incomplete"
      );
    }
    if (evidence.disposition === "notInvoked") {
      if (relation.handle || relation.runtimeIdentity) {
        throw managerError(
          "relation_file_service_start_blocked",
          "notInvoked retry still contains runtime identity"
        );
      }
      return {};
    }
    if (evidence.disposition !== "confirmedStopped" || !relation.handle) {
      throw managerError(
        "relation_file_service_start_blocked",
        "confirmedStopped retry lacks an exact handle"
      );
    }
    return { retryBinding: createRetryBinding(state, relation) };
  }
  if (request.expectedHandleDigest !== "") {
    throw managerError(
      "relation_file_service_expected_handle_mismatch",
      "new relation requires an empty expectedHandleDigest"
    );
  }
  allocateGeneration(state, request.relationId);
  return {};
}

function createRetryBinding(state, relation) {
  const operation = state.operations[relation.operationId];
  if (!operation) {
    throw stateInvalid();
  }
  return {
    relationId: relation.relationId,
    operationId: relation.operationId,
    identityDigest: relation.identityDigest,
    generation: relation.generation,
    handle: structuredClone(relation.handle),
    handleDigest: relation.handleDigest,
    expectedHandleDigest: relation.expectedHandleDigest,
    protectionDigest: relation.protectionDigest,
    phase: relation.phase,
    desired: relation.desired,
    cleanupRequired: relation.cleanupRequired,
    commitUncertain: relation.commitUncertain,
    cleanupEvidence: structuredClone(relation.cleanupEvidence),
    cleanupEvidenceDigest: digestValue(relation.cleanupEvidence),
    exactHandleIdentity: structuredClone(relation.cleanupEvidence.exactHandleIdentity),
    operationDigest: digestValue(operation),
    relationDigest: digestValue(relation),
    generationHistoryDigest: digestValue(generationHistory(state, relation.relationId)),
    nextGeneration: allocateGeneration(state, relation.relationId)
  };
}

function assertRetryBindingUnchanged(state, binding, request) {
  const changed = () => managerError(
    "relation_file_service_start_blocked",
    "Previous runtime cleanup state changed before reservation"
  );
  const operation = state.operations[binding.operationId];
  const relation = state.relations[binding.relationId];
  if (state.version !== 2
    || !operation
    || !relation
    || state.operations[request.operationId]
    || relation.relationId !== binding.relationId
    || relation.operationId !== binding.operationId
    || relation.identityDigest !== binding.identityDigest
    || relation.identityDigest !== request.identityDigest
    || relation.generation !== binding.generation
    || relation.handleDigest !== binding.handleDigest
    || relation.expectedHandleDigest !== binding.expectedHandleDigest
    || relation.protectionDigest !== binding.protectionDigest
    || relation.phase !== "start_failed"
    || relation.phase !== binding.phase
    || relation.desired !== "enabled"
    || relation.desired !== binding.desired
    || relation.cleanupRequired !== false
    || relation.cleanupRequired !== binding.cleanupRequired
    || relation.commitUncertain !== false
    || relation.commitUncertain !== binding.commitUncertain
    || operation.relationId !== binding.relationId
    || operation.generation !== binding.generation
    || operation.handleDigest !== binding.handleDigest
    || operation.expectedHandleDigest !== binding.expectedHandleDigest
    || operation.protectionDigest !== binding.protectionDigest
    || operation.phase !== "start_failed"
    || operation.cleanupRequired !== false
    || operation.commitUncertain !== false
    || digestValue(operation) !== binding.operationDigest
    || digestValue(relation) !== binding.relationDigest
    || digestValue(generationHistory(state, binding.relationId))
      !== binding.generationHistoryDigest
    || allocateGeneration(state, binding.relationId) !== binding.nextGeneration
    || !validateCleanupEvidence(
      relation.cleanupEvidence,
      binding.handle,
      null,
      "confirmedStopped"
    )
    || digestValue(relation.cleanupEvidence) !== binding.cleanupEvidenceDigest
    || digestValue(relation.cleanupEvidence.exactHandleIdentity)
      !== digestValue(binding.exactHandleIdentity)
    || digestValue(relation.handle) !== binding.handleDigest) {
    throw changed();
  }
}

function createStartOperation(details) {
  return {
    action: "start",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: details.now,
    expectedHandleDigest: details.expectedHandleDigest,
    generation: details.generation,
    handleDigest: "",
    operationId: details.operationId,
    phase: "starting",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId: details.relationId,
    requestDigest: details.request.requestDigest,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: details.now
  };
}

function createStartRelation(details) {
  return {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    desired: "enabled",
    expectedHandleDigest: details.expectedHandleDigest,
    generation: details.generation,
    handle: null,
    handleDigest: "",
    identityDigest: details.request.identityDigest,
    operationId: details.request.operationId,
    phase: "starting",
    protectionDigest: null,
    provisionalEvidence: null,
    reason: "",
    recordOrigin: "v2",
    relationId: details.request.relationId,
    requestDigest: details.request.requestDigest,
    runningEvidenceDigest: null,
    runtimeIdentity: null,
    updatedAt: details.now
  };
}

function applyPrepared(operation, relation, prepared, protectionDigest, context) {
  const now = nowIso(context);
  for (const record of [operation, relation]) {
    record.phase = "prepared";
    record.handleDigest = prepared.handleDigest;
    record.protectionDigest = protectionDigest;
    record.provisionalEvidence = structuredClone(prepared.provisionalEvidence);
    record.runtimeIdentity = structuredClone(prepared.runtimeIdentity);
    record.updatedAt = now;
  }
  relation.handle = structuredClone(prepared.handle);
}

async function disableRelation(context, request) {
  assertMutationAllowed(context);
  const state = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    return current;
  });
  assertOwnerWritable(context);
  return state.version === 2
    ? disableV2Relation(context, request)
    : disableV1Relation(context, request);
}

async function disableV1Relation(context, request) {
  const prepared = await mutateV1State(context, (draft) => {
    const existingOperation = draft.operations[request.operationId];
    if (existingOperation) {
      if (existingOperation.requestDigest !== request.requestDigest) {
        throw managerError(
          "relation_file_service_operation_conflict",
          "operationId was already used with different disable parameters"
        );
      }
      const existingRelation = draft.relations[request.relationId];
      if (!existingRelation || existingRelation.operationId !== request.operationId) {
        return {
          write: false,
          value: {
            relationId: request.relationId,
            operationId: request.operationId,
            desired: "disabled",
            state: "superseded",
            reason: "relation_operation_superseded",
            generation: null
          }
        };
      }
      if (existingRelation.phase === "stopping") {
        return {
          write: false,
          value: { resume: true, record: structuredClone(existingRelation) }
        };
      }
      return { write: false, value: resultFromRecord(existingRelation) };
    }
    const existingRelation = draft.relations[request.relationId];
    if (existingRelation && existingRelation.identityDigest !== request.identityDigest) {
      throw managerError(
        "relation_file_service_identity_conflict",
        "relationId is already bound to a different service identity"
      );
    }
    const existingHandle = existingRelation?.handle || null;
    if (request.handle
      && existingHandle
      && digestValue(request.handle) !== digestValue(existingHandle)) {
      throw managerError(
        "relation_file_service_handle_conflict",
        "a persisted runtime handle cannot be replaced"
      );
    }
    const now = nowIso(context);
    const preservedHandle = request.handle || existingHandle;
    const canResumeStop = Boolean(request.handle)
      || (request.handleIssue === "runtime_handle_missing" && Boolean(existingRelation?.handle));
    const phase = canResumeStop ? "stopping" : "pending";
    const reason = canResumeStop ? "" : request.handleIssue;
    const handleDigest = preservedHandle ? digestValue(preservedHandle) : "";
    const generation = preservedHandle?.generation || null;
    const operation = {
      operationId: request.operationId,
      relationId: request.relationId,
      action: "disable",
      requestDigest: request.requestDigest,
      phase,
      reason,
      generation,
      handleDigest,
      createdAt: now,
      updatedAt: now
    };
    const relation = {
      relationId: request.relationId,
      identityDigest: request.identityDigest,
      desired: "disabled",
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      handle: preservedHandle ? structuredClone(preservedHandle) : null,
      handleDigest,
      generation,
      phase,
      reason,
      updatedAt: now
    };
    draft.operations[request.operationId] = operation;
    draft.relations[request.relationId] = relation;
    return {
      value: canResumeStop
        ? { resume: true, record: structuredClone(relation) }
        : resultFromRecord(relation)
    };
  });
  if (!prepared.resume) {
    return prepared;
  }
  assertOwnerWritable(context);
  const outcome = await stopFromRecord(context.runtime, prepared.record, request.operationId);
  assertOwnerWritable(context);
  return finalizeV1Operation(context, prepared.record, outcome);
}

async function disableV2Relation(context, request) {
  assertDurableWriter(context);
  const prepared = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerNotFatal(context);
    const next = structuredClone(current);
    const existingOperation = next.operations[request.operationId];
    if (existingOperation) {
      if (existingOperation.requestDigest !== request.requestDigest) {
        throw managerError(
          "relation_file_service_operation_conflict",
          "operationId was already used with different disable parameters"
        );
      }
      const existingRelation = next.relations[request.relationId];
      if (!existingRelation || existingRelation.operationId !== request.operationId) {
        return {
          value: {
            relationId: request.relationId,
            operationId: request.operationId,
            desired: "disabled",
            state: "superseded",
            reason: "relation_operation_superseded",
            generation: null
          }
        };
      }
      if (existingRelation.phase === "stopping") {
        return { resume: true, record: structuredClone(existingRelation) };
      }
      return { value: resultFromRecord(existingRelation) };
    }
    const existingRelation = next.relations[request.relationId];
    if (existingRelation && existingRelation.identityDigest !== request.identityDigest) {
      throw managerError(
        "relation_file_service_identity_conflict",
        "relationId is already bound to a different service identity"
      );
    }
    const existingHandle = existingRelation?.handle || null;
    if (request.handle
      && existingHandle
      && digestValue(request.handle) !== digestValue(existingHandle)) {
      throw managerError(
        "relation_file_service_handle_conflict",
        "a persisted runtime handle cannot be replaced"
      );
    }
    const preservedHandle = request.handle || existingHandle;
    const canResumeStop = Boolean(request.handle)
      || (request.handleIssue === "runtime_handle_missing" && Boolean(existingRelation?.handle));
    const now = nowIso(context);
    const phase = canResumeStop ? "stopping" : "pending";
    const reason = canResumeStop ? "" : request.handleIssue;
    const handleDigest = preservedHandle ? digestValue(preservedHandle) : "";
    const generation = preservedHandle?.generation || existingRelation?.generation || null;
    const operation = {
      action: "disable",
      cleanupEvidence: null,
      cleanupRequired: false,
      commitUncertain: false,
      createdAt: now,
      expectedHandleDigest: null,
      generation,
      handleDigest,
      operationId: request.operationId,
      phase,
      protectionDigest: null,
      provisionalEvidence: null,
      reason,
      recordOrigin: "v2",
      relationId: request.relationId,
      requestDigest: request.requestDigest,
      runningEvidenceDigest: null,
      runtimeIdentity: null,
      updatedAt: now
    };
    const relation = {
      cleanupEvidence: null,
      cleanupRequired: false,
      commitUncertain: false,
      desired: "disabled",
      expectedHandleDigest: null,
      generation,
      handle: preservedHandle ? structuredClone(preservedHandle) : null,
      handleDigest,
      identityDigest: request.identityDigest,
      operationId: request.operationId,
      phase,
      protectionDigest: null,
      provisionalEvidence: null,
      reason,
      recordOrigin: "v2",
      relationId: request.relationId,
      requestDigest: request.requestDigest,
      runningEvidenceDigest: null,
      runtimeIdentity: null,
      updatedAt: now
    };
    next.operations[request.operationId] = operation;
    next.relations[request.relationId] = relation;
    next.revision = current.revision + 1;
    next.updatedAt = now;
    assertManagerState(next);
    await commitState(context, current, next, `${request.operationId}-disable`);
    return {
      resume: canResumeStop,
      record: structuredClone(relation),
      value: resultFromRecord(relation)
    };
  });
  assertOwnerWritable(context);
  return prepared.resume
    ? stopV2FromRecord(context, prepared.record)
    : prepared.value;
}

async function reconcileRelation(context, relationId) {
  assertMutationAllowed(context);
  const record = await withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const state = await readRequiredState(context);
    assertOwnerNotFatal(context);
    const relation = state.relations[relationId];
    if (!relation) {
      return {
        absent: true,
        result: {
          relationId,
          desired: null,
          state: "absent",
          reason: "relation_not_found",
          operationId: null,
          generation: null
        }
      };
    }
    if (relation.desired !== "disabled") {
      return {
        ignored: true,
        result: {
          relationId,
          desired: relation.desired,
          state: "ignored",
          reason: "desired_not_disabled",
          operationId: relation.operationId,
          generation: relation.generation
        }
      };
    }
    return { record: structuredClone(relation), version: state.version };
  });
  assertOwnerWritable(context);
  if (record.absent || record.ignored) {
    return record.result;
  }
  if (record.version === 2) {
    assertDurableWriter(context);
    return stopV2FromRecord(context, record.record);
  }
  assertOwnerWritable(context);
  const outcome = await stopFromRecord(
    context.runtime,
    record.record,
    record.record.operationId
  );
  assertOwnerWritable(context);
  return finalizeV1Operation(context, record.record, outcome);
}

async function stopV2FromRecord(context, record) {
  if (!record.handle) {
    return resultFromRecord(record);
  }
  const fence = createFence({
    relationId: record.relationId,
    operationId: record.operationId,
    generation: record.generation,
    attemptId: randomAttemptId(context),
    expectedHandleDigest: record.expectedHandleDigest,
    protectionDigest: record.protectionDigest
  });
  assertOwnerWritable(context);
  const firstInspection = await boundedInvoke(context, {
    phase: "disable-inspect",
    fence,
    operation: (signal, observedFence) => context.runtime.inspect(
      record.handle,
      { signal, fence: observedFence, purpose: "disable" }
    )
  });
  assertOwnerWritable(context);
  if (firstInspection.kind === "fulfilled"
    && legacyInspectionState(firstInspection.value, record.handle) === "stopped") {
    return finalizeV2Disable(context, record, "stopped", "");
  }
  if (firstInspection.kind !== "fulfilled"
    || legacyInspectionState(firstInspection.value, record.handle) !== "running") {
    return persistV2DisableCleanup(context, record, "disable-inspect");
  }
  assertOwnerWritable(context);
  const stopOutcome = await boundedInvoke(context, {
    phase: "disable-stop",
    fence,
    operation: (signal, observedFence) => context.runtime.stop(
      record.handle,
      { signal, fence: observedFence, purpose: "disable" }
    )
  });
  assertOwnerWritable(context);
  if (stopOutcome.kind !== "fulfilled") {
    return persistV2DisableCleanup(context, record, "disable-stop");
  }
  assertOwnerWritable(context);
  const finalInspection = await boundedInvoke(context, {
    phase: "disable-inspect-final",
    fence,
    operation: (signal, observedFence) => context.runtime.inspect(
      record.handle,
      { signal, fence: observedFence, purpose: "disable" }
    )
  });
  assertOwnerWritable(context);
  if (finalInspection.kind === "fulfilled"
    && legacyInspectionState(finalInspection.value, record.handle) === "stopped") {
    return finalizeV2Disable(context, record, "stopped", "");
  }
  return persistV2DisableCleanup(context, record, "disable-inspect-final");
}

async function finalizeV2Disable(context, record, phase, reason) {
  assertOwnerWritable(context);
  return withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerWritable(context);
    const next = structuredClone(current);
    const operation = next.operations[record.operationId];
    const relation = next.relations[record.relationId];
    if (!operation
      || !relation
      || relation.operationId !== record.operationId
      || relation.generation !== record.generation
      || relation.handleDigest !== record.handleDigest) {
      return {
        relationId: record.relationId,
        operationId: record.operationId,
        desired: "disabled",
        state: "superseded",
        reason: "relation_operation_superseded",
        generation: record.generation
      };
    }
    const now = nowIso(context);
    operation.phase = phase;
    relation.phase = phase;
    operation.reason = reason;
    relation.reason = reason;
    operation.updatedAt = now;
    relation.updatedAt = now;
    next.revision = current.revision + 1;
    next.updatedAt = now;
    assertManagerState(next);
    await commitState(context, current, next, `${record.operationId}-disable-final`);
    return resultFromRecord(relation);
  });
}

async function persistV2DisableCleanup(context, record, checkpoint) {
  const evidence = createUnconfirmedCleanupEvidence({
    handle: record.handle,
    checkpoint,
    continuationRegistered: false,
    latePrepare: "not-applicable",
    runtimeInvoked: true,
    leaseReturned: false,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
  });
  await persistCleanupRequired(context, record, {
    checkpoint,
    continuationRegistered: false,
    latePrepare: "not-applicable",
    runtimeInvoked: true,
    leaseReturned: false,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed",
    evidence
  });
  return {
    ...resultFromRecord(record),
    state: "cleanup_required",
    reason: "relation_file_service_runtime_cleanup_unconfirmed"
  };
}

async function stopFromRecord(runtime, record, operationId) {
  if (!record.handle) {
    return { state: "pending", reason: record.reason || "runtime_handle_missing" };
  }
  const firstInspection = await inspectRuntime(runtime, record.handle);
  if (firstInspection.state === "stopped") {
    return { state: "stopped", reason: "" };
  }
  if (firstInspection.state !== "running") {
    return {
      state: "pending",
      reason: firstInspection.reason || "runtime_inspect_ambiguous"
    };
  }
  try {
    await runtime.stop(structuredClone(record.handle), { operationId });
  } catch {
    return { state: "pending", reason: "runtime_stop_failed" };
  }
  const finalInspection = await inspectRuntime(runtime, record.handle);
  if (finalInspection.state === "stopped") {
    return { state: "stopped", reason: "" };
  }
  return {
    state: "pending",
    reason: finalInspection.reason || "runtime_stop_not_confirmed"
  };
}

async function inspectRuntime(runtime, handle) {
  let observation;
  try {
    observation = await runtime.inspect(structuredClone(handle));
  } catch {
    return { state: "unknown", reason: "runtime_inspect_failed" };
  }
  if (!isPlainObject(observation)) {
    return { state: "unknown", reason: "runtime_inspect_invalid" };
  }
  if (observation.owned !== true) {
    return { state: "unknown", reason: "runtime_ownership_unconfirmed" };
  }
  const observedHandle = isPlainObject(observation.handle) ? observation.handle : observation;
  const relationId = firstText(observedHandle.relationId, observation.relationId);
  const generation = normalizeObservedGeneration(
    firstText(observedHandle.generation, observation.generation)
  );
  const token = firstText(observedHandle.token, observation.token);
  const phase = firstText(observation.phase, observation.state);
  if (relationId !== handle.relationId
    || generation !== handle.generation
    || token !== handle.token) {
    return { state: "unknown", reason: "runtime_handle_mismatch" };
  }
  if (phase === "running") {
    return { state: "running", reason: "" };
  }
  if (phase === "stopped"
    && observation.processExited === true
    && observation.listenerClosed === true
    && observation.sessionsClosed === true) {
    return { state: "stopped", reason: "" };
  }
  if (phase === "stopped") {
    return { state: "unknown", reason: "runtime_stop_evidence_incomplete" };
  }
  return { state: "unknown", reason: "runtime_inspect_ambiguous" };
}

async function finalizeV1Operation(context, record, outcome) {
  return mutateV1State(context, (draft) => {
    const operation = draft.operations[record.operationId];
    const relation = draft.relations[record.relationId];
    if (!operation
      || !relation
      || relation.operationId !== record.operationId
      || relation.generation !== record.generation
      || relation.handleDigest !== record.handleDigest) {
      return {
        write: false,
        value: {
          relationId: record.relationId,
          operationId: record.operationId,
          desired: "disabled",
          state: "superseded",
          reason: "relation_operation_superseded",
          generation: record.generation
        }
      };
    }
    const now = nowIso(context);
    operation.phase = outcome.state;
    operation.reason = outcome.reason;
    operation.updatedAt = now;
    relation.phase = outcome.state;
    relation.reason = outcome.reason;
    relation.updatedAt = now;
    return { value: resultFromRecord(relation) };
  });
}

async function mutateV1State(context, mutate) {
  return withStateLock(context, async () => {
    assertOwnerNotFatal(context);
    const current = await readRequiredState(context);
    assertOwnerWritable(context);
    if (current.version !== 1) {
      throw managerError(
        "relation_file_service_state_invalid",
        "V1 weak mutation cannot write a V2 state"
      );
    }
    const draft = structuredClone(current);
    const outcome = await mutate(draft);
    assertOwnerWritable(context);
    if (outcome.write === false) {
      return outcome.value;
    }
    draft.revision = current.revision + 1;
    draft.updatedAt = nowIso(context);
    assertManagerState(draft);
    assertOwnerWritable(context);
    await writeStateFileAtomic(context, draft);
    return outcome.value;
  });
}

function withStateLock(context, task) {
  return context.withExclusiveLock({
    statePath: context.statePath,
    scope: "state",
    lockPath: `${context.statePath}.storage.lock`
  }, task);
}

function withRelationLock(context, relationId, task) {
  return context.withExclusiveLock({
    statePath: context.statePath,
    scope: "relation",
    relationId,
    lockPath: `${context.statePath}.relation-${digestText(relationId).slice(0, 24)}.lock`
  }, task);
}

async function enqueueRelation(queues, relationId, task) {
  const previous = queues.get(relationId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  queues.set(relationId, current);
  try {
    return await current;
  } finally {
    if (queues.get(relationId) === current) {
      queues.delete(relationId);
    }
  }
}

function normalizeStartRequest(input) {
  assertPlainObject(input, "start request");
  assertAllowedKeys(
    input,
    ["expectedHandleDigest", "identity", "launch", "operationId", "relationId"],
    "start request"
  );
  const relationId = normalizeIdentity(input.relationId, "relationId");
  const operationId = normalizeIdentity(input.operationId, "operationId");
  if (!Object.hasOwn(input, "identity") || input.identity == null
    || !Object.hasOwn(input, "launch")) {
    throw managerError(
      "relation_file_service_request_invalid",
      "start request requires identity and launch",
      400
    );
  }
  const launchListener = input.launch?.listener;
  if (!isPlainObject(launchListener)
    || launchListener.host !== "127.0.0.1"
    || !Number.isInteger(launchListener.port)
    || launchListener.port < 1
    || launchListener.port > 65535) {
    throw managerError(
      "relation_file_service_request_invalid",
      "launch.listener must be an exact loopback address",
      400
    );
  }
  if (typeof input.expectedHandleDigest !== "string"
    || (input.expectedHandleDigest !== "" && !isDigest(input.expectedHandleDigest))) {
    throw managerError(
      "relation_file_service_request_invalid",
      "expectedHandleDigest must be empty or lowercase SHA-256",
      400
    );
  }
  const identityDigest = digestValue(input.identity);
  const requestDigest = digestValue({
    action: "start",
    relationId,
    operationId,
    identity: input.identity,
    expectedHandleDigest: input.expectedHandleDigest,
    launch: input.launch
  });
  return {
    relationId,
    operationId,
    identity: structuredClone(input.identity),
    identityDigest,
    expectedHandleDigest: input.expectedHandleDigest,
    launch: structuredClone(input.launch),
    requestDigest
  };
}

function normalizeDisableRequest(input) {
  assertPlainObject(input, "disable request");
  assertAllowedKeys(input, ["handle", "identity", "operationId", "relationId"], "disable request");
  const relationId = normalizeIdentity(input.relationId, "relationId");
  const operationId = normalizeIdentity(input.operationId, "operationId");
  if (!Object.hasOwn(input, "identity") || input.identity == null) {
    throw managerError(
      "relation_file_service_request_invalid",
      "disable request requires a stable identity",
      400
    );
  }
  const identityDigest = digestValue(input.identity);
  const handle = normalizeRuntimeHandle(input.handle, relationId);
  const handleIssue = !Object.hasOwn(input, "handle") || input.handle == null
    ? "runtime_handle_missing"
    : "runtime_handle_invalid";
  const requestDigest = digestValue({
    action: "disable",
    relationId,
    identity: input.identity,
    handle: input.handle ?? null
  });
  return { relationId, operationId, identityDigest, handle, handleIssue, requestDigest };
}

function normalizeRuntime(runtime) {
  assertPlainObject(runtime, "runtime");
  requireFunction(runtime.inspect, "runtime.inspect");
  requireFunction(runtime.stop, "runtime.stop");
  return runtime;
}

function normalizeDurableWriter(durableWriter) {
  assertPlainObject(durableWriter, "durableWriter");
  requireFunction(durableWriter.write, "durableWriter.write");
  return durableWriter;
}

function normalizeProtection(protection) {
  assertPlainObject(protection, "protection");
  requireFunction(protection.verify, "protection.verify");
  return protection;
}

function normalizeClock(clock) {
  return requireFunction(clock, "clock");
}

function normalizeTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw managerError(
      "relation_file_service_request_invalid",
      `${label} must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`,
      400
    );
  }
  return value;
}

function normalizeRuntimeHandle(input, relationId) {
  if (!isPlainObject(input)) {
    return null;
  }
  const handleRelationId = firstText(input.relationId);
  const generation = normalizeObservedGeneration(input.generation);
  const token = firstText(input.token);
  if (handleRelationId !== relationId || !generation || !token) {
    return null;
  }
  return { relationId: handleRelationId, generation, token };
}

function normalizeObservedGeneration(input) {
  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input >= 0 ? String(input) : "";
  }
  return firstText(input);
}

function resultFromRecord(record) {
  const desired = record.desired
    || (["pending", "stopping", "stopped"].includes(record.phase) ? "disabled" : "enabled");
  const result = {
    relationId: record.relationId,
    operationId: record.operationId,
    desired,
    state: record.phase,
    reason: publicReason(record.reason),
    generation: record.generation
  };
  if (record.recordOrigin === "v2" && desired === "enabled" && record.phase === "running") {
    result.handleDigest = record.handleDigest || "";
  }
  return result;
}

function querySnapshot(state, relationId) {
  const relation = state.relations[relationId];
  const allocatable = generationHistoryIsCanonical(state, relationId);
  if (!relation) {
    return {
      relationId,
      desired: null,
      state: "absent",
      operationId: null,
      generation: null,
      handlePresent: false,
      handleDigest: null,
      expectedHandleDigest: null,
      runtimeIdentityPresent: false,
      provisionalEvidencePresent: false,
      runningEvidencePresent: false,
      cleanupEvidencePresent: false,
      generationAllocatable: allocatable,
      storageMode: state.version === 1 ? "v1-legacy" : "v2-durable",
      commitUncertain: false,
      cleanupRequired: false,
      reason: "relation_not_found",
      updatedAt: null,
      source: "manager-state"
    };
  }
  return {
    relationId,
    desired: relation.desired,
    state: relation.phase,
    operationId: relation.operationId,
    generation: relation.generation,
    handlePresent: Boolean(relation.handle),
    handleDigest: relation.handleDigest || null,
    expectedHandleDigest: relation.expectedHandleDigest ?? null,
    runtimeIdentityPresent: Boolean(relation.runtimeIdentity),
    provisionalEvidencePresent: Boolean(relation.provisionalEvidence),
    runningEvidencePresent: Boolean(relation.runningEvidenceDigest),
    cleanupEvidencePresent: Boolean(relation.cleanupEvidence),
    generationAllocatable: allocatable,
    storageMode: state.version === 1 ? "v1-legacy" : "v2-durable",
    commitUncertain: relation.commitUncertain === true,
    cleanupRequired: relation.cleanupRequired === true,
    reason: publicReason(relation.reason),
    updatedAt: relation.updatedAt,
    source: "manager-state"
  };
}

function publicReason(reason) {
  if (typeof reason !== "string" || reason === "") {
    return "";
  }
  return ALLOWED_REASONS.has(reason)
    ? reason
    : "relation_file_service_reason_redacted";
}

function allocateGeneration(state, relationId) {
  const values = generationHistory(state, relationId);
  let maximum = 0n;
  let hasValue = false;
  for (const value of values) {
    if (typeof value !== "string" || !isCanonicalGeneration(value)) {
      throw managerError(
        "relation_file_service_generation_history_noncanonical",
        "relation generation history is not canonical decimal"
      );
    }
    const parsed = BigInt(value);
    if (!hasValue || parsed > maximum) {
      maximum = parsed;
      hasValue = true;
    }
  }
  return hasValue ? (maximum + 1n).toString() : "1";
}

function generationHistory(state, relationId) {
  const values = [];
  const relation = state.relations[relationId];
  if (relation?.generation != null) {
    values.push(relation.generation);
  }
  for (const operation of Object.values(state.operations)) {
    if (operation.relationId === relationId && operation.generation != null) {
      values.push(operation.generation);
    }
  }
  return values;
}

function generationHistoryIsCanonical(state, relationId) {
  return generationHistory(state, relationId)
    .every((value) => typeof value === "string" && isCanonicalGeneration(value));
}

function isCanonicalGeneration(value) {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function migrateV1State(current, context) {
  const next = {
    version: RELATION_FILE_SERVICE_MANAGER_STATE_VERSION,
    kind: STATE_KIND,
    storageContract: RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT,
    revision: current.revision,
    createdAt: current.createdAt,
    updatedAt: nowIso(context),
    operations: {},
    relations: {}
  };
  for (const [operationId, operation] of Object.entries(current.operations)) {
    next.operations[operationId] = {
      action: operation.action,
      cleanupEvidence: null,
      cleanupRequired: false,
      commitUncertain: false,
      createdAt: operation.createdAt,
      expectedHandleDigest: null,
      generation: operation.generation,
      handleDigest: operation.handleDigest,
      operationId: operation.operationId,
      phase: operation.phase,
      protectionDigest: null,
      provisionalEvidence: null,
      reason: operation.reason,
      recordOrigin: "v1-migrated",
      relationId: operation.relationId,
      requestDigest: operation.requestDigest,
      runningEvidenceDigest: null,
      runtimeIdentity: null,
      updatedAt: operation.updatedAt
    };
  }
  for (const [relationId, relation] of Object.entries(current.relations)) {
    next.relations[relationId] = {
      cleanupEvidence: null,
      cleanupRequired: false,
      commitUncertain: false,
      desired: relation.desired,
      expectedHandleDigest: null,
      generation: relation.generation,
      handle: relation.handle ? structuredClone(relation.handle) : null,
      handleDigest: relation.handleDigest,
      identityDigest: relation.identityDigest,
      operationId: relation.operationId,
      phase: relation.phase,
      protectionDigest: null,
      provisionalEvidence: null,
      reason: relation.reason,
      recordOrigin: "v1-migrated",
      relationId: relation.relationId,
      requestDigest: relation.requestDigest,
      runningEvidenceDigest: null,
      runtimeIdentity: null,
      updatedAt: relation.updatedAt
    };
  }
  return next;
}

function createInitialV1State(context) {
  const now = nowIso(context);
  return {
    version: RELATION_FILE_SERVICE_MANAGER_V1_STATE_VERSION,
    kind: STATE_KIND,
    storageContract: RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    operations: {},
    relations: {}
  };
}

function normalizeExpectedBaseline(input) {
  assertPlainObject(input, "expected manager baseline");
  assertExactKeys(input, ["rawSha256", "revision"], "expected manager baseline");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw managerError(
      "relation_file_service_state_invalid",
      "expected manager revision must be a non-negative safe integer"
    );
  }
  requireDigest(input.rawSha256);
  return Object.freeze({
    revision: input.revision,
    rawSha256: input.rawSha256
  });
}

function baselineFromSnapshot(snapshot) {
  return Object.freeze({
    revision: snapshot.revision,
    rawSha256: snapshot.rawSha256
  });
}

function sameParentIdentity(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino);
}

async function assertOwnerCheckpoint(context) {
  if (context.assertOwnerLease === null) {
    return null;
  }
  const verification = await context.assertOwnerLease(context.ownerLease);
  if (!verification || verification.valid !== true) {
    throw managerError(
      "relation_file_service_owner_lease_invalid",
      "owner lease verification did not succeed"
    );
  }
  if (context.stateParentIdentity
    && (verification.parentDev !== context.stateParentIdentity.dev
      || verification.parentIno !== context.stateParentIdentity.ino)) {
    throw managerError(
      "relation_file_service_state_path_changed",
      "owner lease no longer identifies the state parent"
    );
  }
  return verification;
}

async function readRequiredState(context) {
  await assertOwnerCheckpoint(context);
  const snapshot = await readStateFileWithMeta(context.statePath);
  if (!snapshot) {
    throw managerError(
      "relation_file_service_state_missing",
      "relation file service state file disappeared after manager open",
      500
    );
  }
  if (context.stateParentIdentity
    && !sameParentIdentity(snapshot.parentIdentity, context.stateParentIdentity)) {
    throw managerError(
      "relation_file_service_state_path_changed",
      "state parent identity changed after manager open",
      500
    );
  }
  if (context.expected
    && (snapshot.revision !== context.expected.revision
      || snapshot.rawSha256 !== context.expected.rawSha256)) {
    throw managerError(
      "relation_file_service_state_revision_conflict",
      "state revision and raw digest do not match the manager baseline",
      500
    );
  }
  await assertOwnerCheckpoint(context);
  const state = snapshot.state;
  if (!state) {
    throw managerError(
      "relation_file_service_state_missing",
      "relation file service state file disappeared after manager open",
      500
    );
  }
  return state;
}

async function readVisibleStateForQuery(context) {
  await assertOwnerCheckpoint(context);
  const snapshot = await readStateFileWithMeta(context.statePath);
  if (!snapshot) {
    throw managerError(
      "relation_file_service_state_missing",
      "relation file service state file disappeared after manager open",
      500
    );
  }
  if (!sameParentIdentity(snapshot.parentIdentity, context.stateParentIdentity)) {
    throw managerError(
      "relation_file_service_state_path_changed",
      "state parent identity changed after manager open",
      500
    );
  }
  await assertOwnerCheckpoint(context);
  return snapshot.state;
}

async function readStateFileWithMeta(statePath) {
  const parentPath = dirname(statePath);
  let fileInfo;
  let parentInfo;
  let raw;
  try {
    parentInfo = await lstat(parentPath);
    if (!parentInfo.isDirectory()) {
      throw new Error("state parent is not a directory");
    }
    const canonicalParent = await realpath(parentPath);
    if (resolve(canonicalParent) !== resolve(parentPath)) {
      throw new Error("state parent is not canonical");
    }
    fileInfo = await lstat(statePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("state entry is not a regular file");
    }
    raw = await readFile(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw managerError(
      "relation_file_service_state_read_failed",
      "Failed to read relation file service state",
      500
    );
  }
  let state;
  try {
    state = JSON.parse(raw.toString("utf8"));
  } catch {
    throw managerError(
      "relation_file_service_state_corrupt",
      "Relation file service state is not valid JSON",
      500
    );
  }
  assertManagerState(state);
  const parentIdentity = Object.freeze({
    dev: String(parentInfo.dev),
    ino: String(parentInfo.ino)
  });
  const metadata = Object.freeze({
    revision: state.revision,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    parentIdentity
  });
  STATE_READ_METADATA.set(state, metadata);
  return Object.freeze({ ...metadata, state });
}

async function writeStateFileAtomic(context, state) {
  assertOwnerWritable(context);
  const statePath = context.statePath;
  await mkdir(dirname(statePath), { recursive: true });
  await assertOwnerCheckpoint(context);
  if (context.expected) {
    const before = await readStateFileWithMeta(statePath);
    if (!before
      || before.revision !== context.expected.revision
      || before.rawSha256 !== context.expected.rawSha256
      || !sameParentIdentity(before.parentIdentity, context.stateParentIdentity)) {
      throw managerError(
        "relation_file_service_state_revision_conflict",
        "state changed before the manager write",
        500
      );
    }
  }
  assertOwnerWritable(context);
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${cryptoRandomBytes(6).toString("hex")}.tmp`;
  try {
    assertOwnerWritable(context);
    await writeFile(tempPath, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    assertOwnerWritable(context);
    await rename(tempPath, statePath);
    assertOwnerWritable(context);
    const after = await readStateFileWithMeta(statePath);
    if (!after
      || after.revision !== state.revision
      || after.rawSha256 !== sha256Text(JSON.stringify(state, null, 2))
      || (context.stateParentIdentity
        && !sameParentIdentity(after.parentIdentity, context.stateParentIdentity))) {
      throw managerError(
        "relation_file_service_state_write_verification_failed",
        "state readback does not match the manager write",
        500
      );
    }
    await assertOwnerCheckpoint(context);
    context.expected = baselineFromSnapshot(after);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    if (context.ownerFatal) {
      throw ownerFatalError(context);
    }
    if (error?.code?.startsWith("relation_file_service_")) {
      throw error;
    }
    throw managerError(
      "relation_file_service_state_write_failed",
      "Failed to persist relation file service state",
      500
    );
  }
}

async function commitState(context, current, next, attemptId) {
  assertDurableWriter(context);
  assertOwnerWritable(context);
  const currentMetadata = STATE_READ_METADATA.get(current);
  if (!currentMetadata
    || !context.expected
    || currentMetadata.revision !== context.expected.revision
    || currentMetadata.rawSha256 !== context.expected.rawSha256) {
    throw managerError(
      "relation_file_service_state_revision_conflict",
      "manager state baseline changed before commit",
      500
    );
  }
  if (next.revision !== current.revision + 1) {
    throw managerError(
      "relation_file_service_state_revision_conflict",
      "state revision must advance by exactly one"
    );
  }
  let receipt;
  try {
    receipt = await context.durableWriter.write({
      statePath: context.statePath,
      expectedRevision: current.revision,
      expectedRawSha256: currentMetadata.rawSha256,
      state: structuredClone(next),
      attemptId
    });
  } catch {
    if (context.ownerFatal) {
      throw ownerFatalError(context);
    }
    throw managerError(
      "relation_file_service_state_write_failed",
      "Durable state write failed",
      500
    );
  }
  const outcome = typeof receipt === "string" ? receipt : receipt?.outcome;
  if (context.ownerFatal) {
    if (outcome === "commit_uncertain") {
      context.volatileQuarantine = {
        attemptId,
        reason: "relation_file_service_commit_uncertain"
      };
    }
    throw ownerFatalError(context);
  }
  if (outcome === "committed") {
    const after = await readStateFileWithMeta(context.statePath);
    const intendedRawSha256 = sha256Text(JSON.stringify(next, null, 2));
    if (!after
      || after.revision !== next.revision
      || after.rawSha256 !== intendedRawSha256
      || !sameParentIdentity(after.parentIdentity, context.stateParentIdentity)) {
      throw managerError(
        "relation_file_service_state_write_verification_failed",
        "committed state does not match the intended exact bytes",
        500
      );
    }
    await assertOwnerCheckpoint(context);
    context.expected = baselineFromSnapshot(after);
    advanceStartupRecoveryBaseline(context.managerFacade, context.expected);
    return receipt;
  }
  if (outcome === "commit_uncertain") {
    context.volatileQuarantine = {
      attemptId,
      reason: "relation_file_service_commit_uncertain"
    };
    assertOwnerNotFatal(context);
    await attemptCommitMarker(context, attemptId, current, next);
    throw managerError(
      "relation_file_service_commit_uncertain",
      "State rename completed but parent fsync failed",
      500
    );
  }
  if (outcome === "not_committed"
    && receipt?.currentRevision === receipt?.expectedRevision) {
    throw managerError(
      "relation_file_service_state_write_failed",
      "Durable state write did not commit",
      500
    );
  }
  throw managerError(
    outcome === "not_committed"
      ? "relation_file_service_state_revision_conflict"
      : "relation_file_service_state_write_failed",
    "Durable state write did not commit",
    500
  );
}

async function attemptCommitMarker(context, attemptId, before, attempted) {
  assertOwnerNotFatal(context);
  let visible;
  try {
    visible = await readStateFileWithMeta(context.statePath);
  } catch {
    return;
  }
  assertOwnerNotFatal(context);
  if (!visible
    || !sameParentIdentity(visible.parentIdentity, context.stateParentIdentity)) {
    return;
  }
  visible = visible.state;
  if (visible.version !== 2) {
    return;
  }
  const operationIds = Object.keys(attempted.operations).filter((operationId) => {
    const attemptedRecord = attempted.operations[operationId];
    const priorRecord = before.operations[operationId];
    return attemptedRecord.recordOrigin === "v2"
      && (!priorRecord
        || (priorRecord.recordOrigin === "v2"
          && stableSerialize(priorRecord) !== stableSerialize(attemptedRecord)));
  });
  const relationIds = new Set(operationIds.map((operationId) => (
    attempted.operations[operationId].relationId
  )));
  if (operationIds.length === 0 || relationIds.size === 0) {
    return;
  }
  const marker = structuredClone(visible);
  const targetRecords = [
    ...operationIds.map((operationId) => marker.operations[operationId]).filter(Boolean),
    ...[...relationIds].map((relationId) => marker.relations[relationId]).filter(Boolean)
  ];
  if (targetRecords.length === 0) {
    return;
  }
  for (const record of targetRecords) {
    record.commitUncertain = true;
    if (record.phase !== "running") {
      record.phase = "commit_uncertain";
    }
  }
  marker.revision = visible.revision + 1;
  marker.updatedAt = nowIso(context);
  try {
    assertManagerState(marker);
    assertOwnerNotFatal(context);
    await context.durableWriter.write({
      statePath: context.statePath,
      expectedRevision: visible.revision,
      expectedRawSha256: sha256Text(JSON.stringify(visible, null, 2)),
      state: marker,
      attemptId: `${attemptId}-marker`
    });
    assertOwnerNotFatal(context);
  } catch {
    if (context.ownerFatal) {
      throw ownerFatalError(context);
    }
    // Volatile quarantine remains authoritative for this manager instance.
  }
}

function assertMutationAllowed(context) {
  if (context.ownerFatal) {
    throw ownerFatalError(context);
  }
  if (context.volatileQuarantine) {
    throw managerError(
      "relation_file_service_volatile_quarantine",
      "Manager is quarantined after an uncertain durable commit",
      409
    );
  }
}

function assertDurableWriter(context) {
  if (!context.durableWriter) {
    throw managerError(
      "relation_file_service_durable_writer_unsupported",
      "V2 lifecycle writes require a durable writer",
      409
    );
  }
}

function assertOwnerWritable(context) {
  assertMutationAllowed(context);
}

function assertOwnerNotFatal(context) {
  if (context.ownerFatal) {
    throw ownerFatalError(context);
  }
}

function enterOwnerFatal(context, details) {
  if (context.ownerFatal) {
    return context.ownerFatal;
  }
  context.ownerFatal = Object.freeze({
    reasonCode: details.reasonCode,
    relationId: details.relationId,
    operationId: details.operationId,
    phase: details.phase,
    settlementCode: details.settlementCode,
    detectedAt: nowIso(context)
  });
  context.ownerFatalController.abort(ownerFatalError(context));
  try {
    const outcome = context.onOwnerFatal(structuredClone(context.ownerFatal));
    if (outcome && typeof outcome.then === "function") {
      outcome.catch(() => {});
    }
  } catch {
    // Fatal callback failures cannot release or weaken the sticky latch.
  }
  return context.ownerFatal;
}

function ownerFatalError(context) {
  return managerError(
    "relation_file_service_owner_fatal",
    "Relation file service manager is isolated after an unconfirmed protection settlement",
    409
  );
}

async function cleanupExactAttemptAfterOwnerFatal(context, details) {
  if (hasOpaqueLease(details.lease)) {
    await boundedInvoke(context, {
      allowAfterFatal: true,
      phase: "fatal-cleanup-abort",
      fence: details.fence,
      operation: (signal, fence) => context.runtime.abort(
        details.lease,
        { signal, fence }
      )
    }).catch(() => {});
  }
  if (details.handle) {
    await boundedInvoke(context, {
      allowAfterFatal: true,
      phase: "fatal-cleanup-inspect",
      fence: details.fence,
      operation: (signal, fence) => context.runtime.inspect(
        details.handle,
        { signal, fence, purpose: "cleanup" }
      )
    }).catch(() => {});
  }
}

function assertStartCapabilities(context) {
  assertDurableWriter(context);
  if (!context.protection) {
    throw managerError(
      "relation_file_service_start_blocked",
      "start requires a protection verifier"
    );
  }
  for (const name of ["prepare", "go", "abort"]) {
    requireFunction(context.runtime[name], `runtime.${name}`);
  }
}

function invokeProtectionSettlement(context, details) {
  const startedAt = context.monotonicNow();
  const protectionDeadlineAt = startedAt + context.protectionTimeoutMs;
  const settlementDeadlineAt =
    protectionDeadlineAt + context.protectionSettlementWatchdogMs;
  const controller = new AbortController();
  let cancelRequested = false;
  let completed = null;
  let resolved = false;
  let invocationStarted = false;
  let protectionTimer;
  let watchdogTimer;

  return new Promise((resolveProtection) => {
    const clearTimers = () => {
      clearTimeout(protectionTimer);
      clearTimeout(watchdogTimer);
    };
    const removeOwnerFatalListener = () => {
      context.ownerFatalController.signal.removeEventListener(
        "abort",
        requestCancellation
      );
    };
    const finish = (value) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimers();
      removeOwnerFatalListener();
      resolveProtection(value);
    };
    const scheduleDeadline = (deadline, callback) => {
      const remaining = Math.max(0, deadline - context.monotonicNow());
      const timer = setTimeout(() => {
        if (resolved) {
          return;
        }
        if (context.monotonicNow() < deadline) {
          const replacement = scheduleDeadline(deadline, callback);
          if (deadline === protectionDeadlineAt) {
            protectionTimer = replacement;
          } else {
            watchdogTimer = replacement;
          }
          return;
        }
        callback();
      }, Math.min(MAX_TIMEOUT_MS, remaining));
      timer.unref?.();
      return timer;
    };
    const scheduleWatchdog = () => {
      if (watchdogTimer || resolved) {
        return;
      }
      watchdogTimer = scheduleDeadline(settlementDeadlineAt, onWatchdog);
    };
    const requestCancellation = (reason) => {
      if (cancelRequested) {
        return;
      }
      cancelRequested = true;
      controller.abort(reason);
      scheduleWatchdog();
    };
    const enterFatal = (settlementCode) => {
      enterOwnerFatal(context, {
        reasonCode: "relation_file_service_protection_settlement_unconfirmed",
        relationId: details.fence.relationId,
        operationId: details.fence.operationId,
        phase: "protection",
        settlementCode
      });
    };
    const classify = (outcome) => {
      if (outcome.kind === "fulfilled") {
        try {
          return {
            kind: "verified",
            value: outcome.value,
            protectionDigest: protectionDigestFrom(outcome.value)
          };
        } catch (error) {
          return {
            kind: "failed_settled",
            error
          };
        }
      }
      if (invocationStarted === false
        && outcome.error?.[OWNER_FATAL_PREINVOCATION] === true) {
        return {
          kind: "fatal_preinvocation",
          error: outcome.error
        };
      }
      const settlement = outcome.error?.settlement;
      return settlement === "confirmed"
        ? { kind: "failed_settled", error: outcome.error }
        : {
          kind: "uncertain",
          error: outcome.error,
          settlementCode: outcome.error?.settlementCode || "unknown_settlement"
        };
    };
    const evaluateCompletion = () => {
      if (!completed || resolved) {
        return;
      }
      const observedAt = context.monotonicNow();
      if (context.ownerFatal) {
        if (completed.kind === "uncertain") {
          return;
        }
        finish({ kind: "fatal_late_confirmed" });
        return;
      }
      if (cancelRequested || observedAt >= protectionDeadlineAt) {
        requestCancellation(
          managerError(
            "relation_file_service_start_blocked",
            "Runtime protection deadline elapsed"
          )
        );
        if (observedAt >= settlementDeadlineAt) {
          enterFatal(completed.settlementCode || "settlement_deadline_elapsed");
          if (completed.kind === "uncertain") {
            return;
          }
          finish({ kind: "fatal_late_confirmed" });
          return;
        }
        if (completed.kind === "uncertain") {
          enterFatal(completed.settlementCode);
          return;
        }
        finish(completed.kind === "verified"
          ? {
            kind: "failed_settled",
            error: managerError(
              "relation_file_service_start_blocked",
              "Runtime protection completed after cancellation"
            )
          }
          : completed);
        return;
      }
      if (completed.kind === "uncertain") {
        enterFatal(completed.settlementCode);
        return;
      }
      finish(completed);
    };
    const onWatchdog = () => {
      if (resolved) {
        return;
      }
      if (context.monotonicNow() < settlementDeadlineAt) {
        watchdogTimer = null;
        scheduleWatchdog();
        return;
      }
      enterFatal("settlement_deadline_elapsed");
      if (completed?.kind === "uncertain") {
        return;
      }
      if (completed) {
        finish({ kind: "fatal_late_confirmed" });
      }
    };

    context.ownerFatalController.signal.addEventListener(
      "abort",
      requestCancellation,
      { once: true }
    );
    if (context.ownerFatal) {
      requestCancellation(ownerFatalError(context));
    }

    Promise.resolve()
      .then(() => {
        if (context.ownerFatal) {
          const error = ownerFatalError(context);
          error[OWNER_FATAL_PREINVOCATION] = true;
          throw error;
        }
        invocationStarted = true;
        return details.operation(controller.signal, details.fence);
      })
      .then(
        (value) => {
          completed = classify({ kind: "fulfilled", value });
          evaluateCompletion();
        },
        (error) => {
          completed = classify({ kind: "rejected", error });
          evaluateCompletion();
        }
      );

    protectionTimer = scheduleDeadline(protectionDeadlineAt, () => {
      requestCancellation(
        managerError(
          "relation_file_service_start_blocked",
          "Runtime protection deadline elapsed"
        )
      );
      evaluateCompletion();
    });
  });
}

async function boundedInvoke(context, details) {
  if (context.ownerFatal && details.allowAfterFatal !== true) {
    return { kind: "rejected", error: ownerFatalError(context) };
  }
  const controller = new AbortController();
  const onOwnerFatal = () => controller.abort(ownerFatalError(context));
  context.ownerFatalController.signal.addEventListener(
    "abort",
    onOwnerFatal,
    { once: true }
  );
  const work = Promise.resolve().then(() => {
    if (context.ownerFatal && details.allowAfterFatal !== true) {
      throw ownerFatalError(context);
    }
    return details.operation(controller.signal, details.fence);
  });
  work.then(
    () => context.ownerFatalController.signal.removeEventListener("abort", onOwnerFatal),
    () => context.ownerFatalController.signal.removeEventListener("abort", onOwnerFatal)
  );
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), context.runtimeTimeoutMs);
  });
  const raced = await Promise.race([
    work.then(
      (value) => ({ kind: "fulfilled", value }),
      (error) => ({ kind: "rejected", error })
    ),
    timeout
  ]);
  clearTimeout(timer);
  if (raced.kind !== "timeout") {
    context.ownerFatalController.signal.removeEventListener("abort", onOwnerFatal);
    return raced;
  }
  controller.abort();
  const registry = {
    attemptId: details.fence.attemptId,
    phase: details.phase,
    fence: structuredClone(details.fence),
    settled: false,
    outcome: "pending",
    settlement: null,
    abortState: "unconfirmed",
    subscribed: false,
    delivered: false,
    onSettled: null
  };
  context.continuations.set(`${details.fence.attemptId}:${details.phase}`, registry);
  work.then(
    (value) => {
      settleContinuation(registry, { kind: "fulfilled", value });
    },
    (error) => {
      settleContinuation(registry, { kind: "rejected", error });
    }
  );
  return { kind: "timeout", continuation: registry };
}

function settleContinuation(registry, outcome) {
  if (registry.settled) {
    return;
  }
  registry.settled = true;
  registry.outcome = outcome.kind;
  registry.settlement = outcome;
  if (outcome.kind === "fulfilled") {
    registry.value = outcome.value;
  } else {
    registry.error = outcome.error;
  }
  deliverContinuation(registry);
}

function subscribeContinuation(registry, onSettled) {
  if (registry.subscribed) {
    throw new Error("continuation already has a subscriber");
  }
  registry.subscribed = true;
  registry.onSettled = onSettled;
  deliverContinuation(registry);
}

function deliverContinuation(registry) {
  if (!registry.settled || registry.delivered || registry.onSettled === null) {
    return;
  }
  const onSettled = registry.onSettled;
  registry.onSettled = null;
  registry.delivered = true;
  onSettled(registry.settlement);
}

function createFence(input) {
  return Object.freeze({
    schemaVersion: "1",
    relationId: input.relationId,
    operationId: input.operationId,
    generation: input.generation,
    attemptId: input.attemptId,
    expectedHandleDigest: input.expectedHandleDigest,
    protectionDigest: input.protectionDigest ?? null
  });
}

function randomAttemptId(context) {
  const bytes = context.random(16);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw managerError(
      "relation_file_service_request_invalid",
      "randomBytes must return bytes",
      400
    );
  }
  return Buffer.from(bytes).toString("hex").slice(0, 32);
}

function protectionDigestFrom(value) {
  const digest = typeof value === "string" ? value : value?.digest;
  if (!isDigest(digest)) {
    throw new Error("protection digest missing");
  }
  return digest;
}

function validatePrepareResult(value, request, record, fence) {
  if (!isPlainObject(value)) {
    throw new Error("invalid prepare result");
  }
  const handleValue = normalizeRuntimeHandle(value.handle, request.relationId);
  if (!handleValue
    || handleValue.generation !== record.generation
    || !hasOpaqueLease(value.lease)) {
    throw new Error("invalid handle or lease");
  }
  assertRuntimeIdentity(value.runtimeIdentity, handleValue);
  assertProvisionalEvidence(value.provisionalEvidence);
  if (value.runtimeIdentity.listener.host !== request.launch?.listener?.host
    || value.runtimeIdentity.listener.port !== request.launch?.listener?.port) {
    throw new Error("runtime listener does not match the requested listener");
  }
  if (value.fence != null && !validateFence(value.fence, fence)) {
    throw new Error("fence mismatch");
  }
  return {
    lease: value.lease,
    handle: handleValue,
    handleDigest: digestValue(handleValue),
    runtimeIdentity: structuredClone(value.runtimeIdentity),
    provisionalEvidence: structuredClone(value.provisionalEvidence)
  };
}

function hasOpaqueLease(value) {
  return value !== null && value !== undefined;
}

function validateFence(value, expected) {
  try {
    assertExactKeys(value, FENCE_KEYS, "fence");
    return stableSerialize(value) === stableSerialize(expected);
  } catch {
    return false;
  }
}

function assertRuntimeIdentity(value, handle) {
  assertRuntimeIdentityShape(value);
  if (value.tokenSha256 !== digestText(handle.token)) {
    throw new Error("runtime identity token mismatch");
  }
}

function assertRuntimeIdentityShape(value) {
  assertPlainObject(value, "runtimeIdentity");
  assertExactKeys(value, RUNTIME_IDENTITY_KEYS, "runtimeIdentity");
  assertExactKeys(value.namespace, RUNTIME_NAMESPACE_KEYS, "runtimeIdentity.namespace");
  assertExactKeys(value.manager, RUNTIME_MANAGER_KEYS, "runtimeIdentity.manager");
  assertExactKeys(value.process, RUNTIME_PROCESS_KEYS, "runtimeIdentity.process");
  assertExactKeys(value.executable, RUNTIME_EXECUTABLE_KEYS, "runtimeIdentity.executable");
  assertExactKeys(
    value.executable.launcher,
    EXECUTABLE_IDENTITY_KEYS,
    "runtimeIdentity.executable.launcher"
  );
  assertExactKeys(
    value.executable.target,
    EXECUTABLE_IDENTITY_KEYS,
    "runtimeIdentity.executable.target"
  );
  assertExactKeys(value.listener, EXPECTED_LISTENER_KEYS, "runtimeIdentity.listener");
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
    || !isExecutableIdentity(value.executable.launcher)
    || !isExecutableIdentity(value.executable.target)
    || !isDigest(value.tokenSha256)
    || value.listener.role !== "expected"
    || value.listener.host !== "127.0.0.1"
    || !Number.isInteger(value.listener.port)
    || value.listener.port < 1
    || value.listener.port > 65535) {
    throw new Error("runtime identity is invalid");
  }
}

function assertProvisionalEvidence(value) {
  assertPlainObject(value, "provisionalEvidence");
  assertExactKeys(value, PROVISIONAL_EVIDENCE_KEYS, "provisionalEvidence");
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
      throw new Error("provisional evidence is incomplete");
    }
  }
  if (!isTimestamp(value.observedAt)) {
    throw new Error("provisional evidence timestamp is invalid");
  }
}

function validateRunningEvidence(value, handle, runtimeIdentity, fence) {
  try {
    assertPlainObject(value, "runningEvidence");
    assertExactKeys(value, RUNNING_EVIDENCE_KEYS, "runningEvidence");
    assertExactKeys(value.namespace, RUNTIME_NAMESPACE_KEYS, "runningEvidence.namespace");
    assertExactKeys(value.process, RUNTIME_PROCESS_KEYS, "runningEvidence.process");
    assertExactKeys(value.executable, RUNTIME_EXECUTABLE_KEYS, "runningEvidence.executable");
    assertExactKeys(
      value.executable.launcher,
      EXECUTABLE_IDENTITY_KEYS,
      "runningEvidence.executable.launcher"
    );
    assertExactKeys(
      value.executable.target,
      EXECUTABLE_IDENTITY_KEYS,
      "runningEvidence.executable.target"
    );
    assertExactKeys(value.listener, RUNNING_LISTENER_KEYS, "runningEvidence.listener");
    assertExactKeys(value.sessions, SESSION_KEYS, "runningEvidence.sessions");
    assertExactKeys(value.children, CHILDREN_KEYS, "runningEvidence.children");
    assertExactKeys(value.capabilities, CAPABILITIES_KEYS, "runningEvidence.capabilities");
    return value.schemaVersion === "1"
      && value.fenceDigest === digestValue(fence)
      && value.handleDigest === digestValue(handle)
      && value.runtimeIdentityDigest === digestValue(runtimeIdentity)
      && stableSerialize(value.namespace) === stableSerialize(runtimeIdentity.namespace)
      && stableSerialize(value.process) === stableSerialize(runtimeIdentity.process)
      && stableSerialize(value.executable) === stableSerialize(runtimeIdentity.executable)
      && value.tokenSha256 === runtimeIdentity.tokenSha256
      && value.listener.role === "observed"
      && value.listener.host === runtimeIdentity.listener.host
      && value.listener.port === runtimeIdentity.listener.port
      && value.listener.open === true
      && value.listener.ownedByProcess === true
      && isCanonicalDecimal(value.listener.socketDev)
      && isCanonicalDecimal(value.listener.socketIno)
      && value.sessions.tracked === true
      && Number.isSafeInteger(value.sessions.count)
      && value.sessions.count >= 0
      && value.children.allTracked === true
      && stableSerialize(value.capabilities) === stableSerialize(ZERO_CAPABILITIES)
      && value.noNewPrivs === true
      && value.parentDeathSignal === "SIGKILL"
      && isTimestamp(value.observedAt);
  } catch {
    return false;
  }
}

function validateCleanupEvidence(value, handle, fence, requiredDisposition) {
  try {
    assertPlainObject(value, "cleanupEvidence");
    assertExactKeys(value, CLEANUP_EVIDENCE_KEYS, "cleanupEvidence");
    if (value.schemaVersion !== "1"
      || !["confirmedStopped", "notInvoked", "unconfirmed"].includes(value.disposition)
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
      || !isStableReason(value.reasonCode)
      || (requiredDisposition && value.disposition !== requiredDisposition)) {
      return false;
    }
    if (value.exactHandleIdentity !== null) {
      assertExactKeys(value.exactHandleIdentity, CLEANUP_IDENTITY_KEYS, "exactHandleIdentity");
      if (!firstText(value.exactHandleIdentity.relationId)
        || !isCanonicalGeneration(value.exactHandleIdentity.generation)
        || !isDigest(value.exactHandleIdentity.handleDigest)) {
        return false;
      }
      if (handle
        && (value.exactHandleIdentity.relationId !== handle.relationId
          || value.exactHandleIdentity.generation !== handle.generation
          || value.exactHandleIdentity.handleDigest !== digestValue(handle))) {
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

function cleanupEvidenceFromRejection(error) {
  return isPlainObject(error?.cleanupEvidence)
    ? structuredClone(error.cleanupEvidence)
    : null;
}

function createNotInvokedCleanupEvidence(checkpoint) {
  return {
    schemaVersion: "1",
    disposition: "notInvoked",
    lastRuntimeCheckpoint: checkpoint === "protection" ? "protection" : "reservation",
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

function createUnconfirmedCleanupEvidence(details) {
  const handle = details.handle;
  return {
    schemaVersion: "1",
    disposition: "unconfirmed",
    lastRuntimeCheckpoint: details.checkpoint,
    runtimeInvoked: details.runtimeInvoked === true,
    leaseReturned: details.leaseReturned === true,
    continuationRegistered: details.continuationRegistered === true,
    latePrepare: details.latePrepare || "not-applicable",
    lateGo: details.lateGo || "not-applicable",
    abortRequested: false,
    abortCompleted: false,
    containmentConfirmed: false,
    exactHandleIdentity: handle
      ? {
        relationId: handle.relationId,
        generation: handle.generation,
        handleDigest: digestValue(handle)
      }
      : null,
    processExited: null,
    listenerClosed: null,
    sessionsClosed: null,
    childrenExited: null,
    reasonCode: details.reasonCode || "relation_file_service_runtime_cleanup_unconfirmed"
  };
}

function legacyInspectionState(value, handle) {
  if (!isPlainObject(value) || value.owned !== true) {
    return "unknown";
  }
  const observed = isPlainObject(value.handle) ? value.handle : value;
  if (firstText(observed.relationId, value.relationId) !== handle.relationId
    || normalizeObservedGeneration(firstText(observed.generation, value.generation))
      !== handle.generation
    || firstText(observed.token, value.token) !== handle.token) {
    return "unknown";
  }
  const phase = firstText(value.phase, value.state);
  if (phase === "running") {
    return "running";
  }
  if (phase === "stopped"
    && value.processExited === true
    && value.listenerClosed === true
    && value.sessionsClosed === true) {
    return "stopped";
  }
  return "unknown";
}

function assertManagerState(state) {
  assertPlainObject(state, "relation file service state");
  assertExactKeys(state, STATE_KEYS, "relation file service state");
  if (state.version === 1) {
    assertV1State(state);
    return;
  }
  if (state.version === 2) {
    assertV2State(state);
    return;
  }
  throw stateInvalid();
}

function assertV1State(state) {
  if (state.kind !== STATE_KIND
    || state.storageContract !== RELATION_FILE_SERVICE_MANAGER_STORAGE_CONTRACT
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0
    || !isTimestamp(state.createdAt)
    || !isTimestamp(state.updatedAt)
    || !isPlainObject(state.operations)
    || !isPlainObject(state.relations)) {
    throw stateInvalid();
  }
  for (const [operationId, operation] of Object.entries(state.operations)) {
    assertPlainObject(operation, "operation record");
    assertExactKeys(operation, V1_OPERATION_KEYS, "operation record");
    if (operation.operationId !== operationId
      || operation.action !== "disable"
      || !V1_PHASES.has(operation.phase)
      || !isTimestamp(operation.createdAt)
      || !isTimestamp(operation.updatedAt)
      || typeof operation.reason !== "string"
      || (typeof operation.generation !== "string" && operation.generation !== null)
      || typeof operation.handleDigest !== "string") {
      throw stateInvalid();
    }
    requireStoredIdentity(operation.operationId, "operationId");
    assertV1OperationHandleState(operation);
    normalizeIdentity(operation.relationId, "relationId");
    requireDigest(operation.requestDigest);
  }
  for (const [relationId, relation] of Object.entries(state.relations)) {
    assertPlainObject(relation, "relation record");
    assertExactKeys(relation, V1_RELATION_KEYS, "relation record");
    if (relation.relationId !== relationId
      || relation.desired !== "disabled"
      || !V1_PHASES.has(relation.phase)
      || !isTimestamp(relation.updatedAt)
      || typeof relation.reason !== "string"
      || (typeof relation.generation !== "string" && relation.generation !== null)
      || typeof relation.handleDigest !== "string") {
      throw stateInvalid();
    }
    normalizeIdentity(relation.operationId, "operationId");
    requireDigest(relation.identityDigest);
    requireDigest(relation.requestDigest);
    if (relation.handle !== null) {
      assertRuntimeHandle(relation.handle, relationId);
      if (relation.handle.generation !== relation.generation
        || digestValue(relation.handle) !== relation.handleDigest) {
        throw stateInvalid();
      }
    } else if (relation.generation !== null || relation.handleDigest !== "") {
      throw stateInvalid();
    }
    const operation = state.operations[relation.operationId];
    if (!operation
      || operation.relationId !== relationId
      || operation.requestDigest !== relation.requestDigest
      || operation.phase !== relation.phase
      || operation.reason !== relation.reason
      || operation.generation !== relation.generation
      || operation.handleDigest !== relation.handleDigest) {
      throw stateInvalid();
    }
  }
}

function assertV2State(state) {
  if (state.kind !== STATE_KIND
    || state.storageContract !== RELATION_FILE_SERVICE_MANAGER_V2_STORAGE_CONTRACT
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0
    || !isTimestamp(state.createdAt)
    || !isTimestamp(state.updatedAt)
    || !isPlainObject(state.operations)
    || !isPlainObject(state.relations)) {
    throw stateInvalid();
  }
  for (const [operationId, operation] of Object.entries(state.operations)) {
    assertPlainObject(operation, "operation record");
    assertExactKeys(operation, OPERATION_KEYS, "operation record");
    if (operation.operationId !== operationId
      || !["disable", "start"].includes(operation.action)
      || !PHASES.has(operation.phase)
      || !isTimestamp(operation.createdAt)
      || !isTimestamp(operation.updatedAt)
      || typeof operation.reason !== "string"
      || !isNullableString(operation.generation)
      || (operation.handleDigest !== "" && !isDigest(operation.handleDigest))
      || typeof operation.cleanupRequired !== "boolean"
      || typeof operation.commitUncertain !== "boolean"
      || !["v1-migrated", "v2"].includes(operation.recordOrigin)) {
      throw stateInvalid();
    }
    requireStoredIdentity(operation.operationId, "operationId");
    normalizeIdentity(operation.relationId, "relationId");
    requireDigest(operation.requestDigest);
    if (operation.recordOrigin === "v2" && !isStoredReason(operation.reason)) {
      throw stateInvalid();
    }
    assertCommonV2Fields(operation);
  }
  for (const [relationId, relation] of Object.entries(state.relations)) {
    assertPlainObject(relation, "relation record");
    assertExactKeys(relation, RELATION_KEYS, "relation record");
    if (relation.relationId !== relationId
      || !["disabled", "enabled", "unknown"].includes(relation.desired)
      || !PHASES.has(relation.phase)
      || !isTimestamp(relation.updatedAt)
      || typeof relation.reason !== "string"
      || !isNullableString(relation.generation)
      || typeof relation.handleDigest !== "string"
      || typeof relation.cleanupRequired !== "boolean"
      || typeof relation.commitUncertain !== "boolean"
      || !["v1-migrated", "v2"].includes(relation.recordOrigin)) {
      throw stateInvalid();
    }
    normalizeIdentity(relation.operationId, "operationId");
    requireDigest(relation.identityDigest);
    requireDigest(relation.requestDigest);
    if (relation.recordOrigin === "v2" && !isStoredReason(relation.reason)) {
      throw stateInvalid();
    }
    assertCommonV2Fields(relation);
    if (relation.handle !== null) {
      assertRuntimeHandle(relation.handle, relationId);
      if (relation.handle.generation !== relation.generation
        || digestValue(relation.handle) !== relation.handleDigest) {
        throw stateInvalid();
      }
    } else if (relation.handleDigest !== "") {
      throw stateInvalid();
    }
    if (["prepared", "running"].includes(relation.phase)
      && (!relation.handle || relation.handleDigest === "")) {
      throw stateInvalid();
    }
    if (relation.phase === "starting"
      && (relation.handle !== null || relation.handleDigest !== "")) {
      throw stateInvalid();
    }
    if (["pending", "starting"].includes(relation.phase) && relation.handle !== null) {
      throw stateInvalid();
    }
    if (["stopping", "stopped"].includes(relation.phase) && !relation.handle) {
      throw stateInvalid();
    }
    if (relation.phase === "running" && !relation.runningEvidenceDigest) {
      throw stateInvalid();
    }
    if (["pending", "stopping", "stopped", "starting", "prepared"].includes(relation.phase)
      && relation.runningEvidenceDigest !== null) {
      throw stateInvalid();
    }
    if (relation.phase === "start_failed"
      && relation.runningEvidenceDigest !== null
      && relation.cleanupEvidence?.disposition !== "confirmedStopped") {
      throw stateInvalid();
    }
    assertPhaseSpecificV2Shape(relation);
    if (relation.runtimeIdentity !== null) {
      if (!relation.handle
        || relation.runtimeIdentity.tokenSha256 !== digestText(relation.handle.token)) {
        throw stateInvalid();
      }
    }
    const cleanupIdentity = relation.cleanupEvidence?.exactHandleIdentity;
    if (cleanupIdentity && (!relation.handle
      || cleanupIdentity.relationId !== relation.relationId
      || cleanupIdentity.generation !== relation.handle.generation
      || cleanupIdentity.handleDigest !== digestValue(relation.handle))) {
      throw stateInvalid();
    }
    const operation = state.operations[relation.operationId];
    if (!operation
      || operation.relationId !== relationId
      || !v2RecordsShareCommonState(operation, relation)) {
      throw stateInvalid();
    }
  }
}

function assertCommonV2Fields(record) {
  assertNullableDigestOrEmpty(record.expectedHandleDigest);
  assertNullableDigest(record.protectionDigest);
  assertNullableDigest(record.runningEvidenceDigest);
  if (record.generation === null && record.handleDigest !== "") {
    throw stateInvalid();
  }
  if (record.generation !== null && typeof record.generation !== "string") {
    throw stateInvalid();
  }
  if (record.runtimeIdentity !== null) {
    assertRuntimeIdentityShape(record.runtimeIdentity);
  }
  if (record.provisionalEvidence !== null) {
    assertProvisionalEvidence(record.provisionalEvidence);
  }
  if ((record.runtimeIdentity === null) !== (record.provisionalEvidence === null)) {
    throw stateInvalid();
  }
  if (record.cleanupEvidence !== null
    && !validateCleanupEvidence(record.cleanupEvidence, null, null, null)) {
    throw stateInvalid();
  }
  if (record.cleanupRequired
    && (!record.cleanupEvidence || record.cleanupEvidence.disposition !== "unconfirmed")) {
    throw stateInvalid();
  }
  if (record.phase === "cleanup_required" && !record.cleanupRequired) {
    throw stateInvalid();
  }
  if (record.phase === "commit_uncertain" && !record.commitUncertain) {
    throw stateInvalid();
  }
  if (record.phase === "start_failed"
    && (record.commitUncertain
      || record.cleanupRequired
      || !record.cleanupEvidence
      || !["confirmedStopped", "notInvoked"].includes(record.cleanupEvidence.disposition))) {
    throw stateInvalid();
  }
  if (record.phase === "stopped"
    && (record.generation === null || record.handleDigest === "")) {
    throw stateInvalid();
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
      throw stateInvalid();
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
      throw stateInvalid();
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
      throw stateInvalid();
    }
    return;
  }
  if (record.phase === "running") {
    if (typeof record.expectedHandleDigest !== "string"
      || record.protectionDigest === null
      || record.runtimeIdentity === null
      || record.cleanupEvidence !== null
      || record.cleanupRequired) {
      throw stateInvalid();
    }
    return;
  }
  if (record.phase === "start_failed") {
    if (typeof record.expectedHandleDigest !== "string"
      || (record.runtimeIdentity !== null && record.protectionDigest === null)) {
      throw stateInvalid();
    }
    return;
  }
  if (record.phase === "cleanup_required") {
    if ((record.runtimeIdentity !== null && record.protectionDigest === null)
      || (record.cleanupEvidence !== null
        && record.cleanupEvidence.disposition !== "unconfirmed")) {
      throw stateInvalid();
    }
    return;
  }
  if (record.phase === "commit_uncertain") {
    if ((record.runtimeIdentity !== null && record.protectionDigest === null)
      || (record.cleanupEvidence !== null
        && record.cleanupEvidence.disposition !== "unconfirmed")) {
      throw stateInvalid();
    }
  }
}

function v2RecordsShareCommonState(operation, relation) {
  try {
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
        || (operation.phase === "unknown" && relation.desired === "unknown"));
  } catch {
    return false;
  }
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
    if (!operation.generation || operation.generation.trim() !== operation.generation) {
      throw stateInvalid();
    }
    requireDigest(operation.handleDigest);
  } else if (operation.handleDigest !== "") {
    throw stateInvalid();
  }
  if (operation.phase === "stopped" && operation.generation === null) {
    throw stateInvalid();
  }
}

function assertRuntimeHandle(handle, relationId) {
  assertPlainObject(handle, "runtime handle");
  assertExactKeys(handle, HANDLE_KEYS, "runtime handle");
  if (handle.relationId !== relationId || !firstText(handle.generation) || !firstText(handle.token)) {
    throw stateInvalid();
  }
}

function assertNullableDigest(value) {
  if (value !== null && !isDigest(value)) {
    throw stateInvalid();
  }
}

function assertNullableDigestOrEmpty(value) {
  if (value !== null && value !== "" && !isDigest(value)) {
    throw stateInvalid();
  }
}

function createLinuxDurableWriter(options = {}) {
  const fileSystem = options.fileSystem || {
    constants: fsConstants,
    lstat,
    open: openFile,
    readFile,
    realpath,
    rename,
    unlink
  };
  const supported = options.forceSupported === true
    || options.fileSystem != null
    || process.platform === "linux";
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === "function" ? process.getuid() : null);
  return Object.freeze({
    async write({
      statePath,
      expectedRevision,
      expectedRawSha256,
      state,
      attemptId
    }) {
      if (!supported) {
        return {
          outcome: "failed",
          stages: [],
          stageErrors: [],
          cleanup: { attempted: false, status: "not-created" }
        };
      }
      const stages = [];
      const stageErrors = [];
      const receipt = {
        outcome: "failed",
        stages,
        stageErrors,
        parent: null,
        temp: null,
        cleanup: {
          attempted: false,
          status: "not-created"
        },
        expectedRevision,
        currentRevision: null
      };
      const stage = (name) => stages.push(name);
      const recordError = (stageName, error) => {
        stageErrors.push({
          stage: stageName,
          name: typeof error?.name === "string" ? error.name : "Error",
          code: typeof error?.code === "string" ? error.code : null
        });
      };
      let parentHandle;
      let tempHandle;
      let tempPath;
      let parentOpen = false;
      let parentClosed = false;
      let parentCloseFailed = false;
      let tempOpen = false;
      let tempClosed = false;
      let tempCreated = false;
      let tempIdentity = null;
      let renamed = false;
      let parentFsyncReturned = false;
      let revisionConflict = false;
      try {
        const parentPath = dirname(statePath);
        const canonicalParent = await fileSystem.realpath(parentPath);
        if (resolve(canonicalParent) !== resolve(parentPath)) {
          throw new Error("state parent is not a trusted real directory");
        }
        stage("parent_open_started");
        parentHandle = await fileSystem.open(
          parentPath,
          fileSystem.constants.O_RDONLY
            | (fileSystem.constants.O_DIRECTORY || 0)
            | (fileSystem.constants.O_NOFOLLOW || 0)
            | (fileSystem.constants.O_CLOEXEC || 0)
        );
        parentOpen = true;
        stage("parent_open_returned");
        const parentStat = await parentHandle.stat();
        if (!parentStat.isDirectory()
          || (expectedUid !== null && parentStat.uid !== expectedUid)) {
          throw new Error("parent directory trust verification failed");
        }
        receipt.parent = { dev: String(parentStat.dev), ino: String(parentStat.ino) };
        stage("parent_fstat_verified");
        const currentRaw = await fileSystem.readFile(statePath);
        const currentRawSha256 = createHash("sha256").update(currentRaw).digest("hex");
        const current = JSON.parse(
          Buffer.isBuffer(currentRaw) ? currentRaw.toString("utf8") : currentRaw
        );
        receipt.currentRevision = current.revision;
        if (current.revision !== expectedRevision
          || (expectedRawSha256 != null && currentRawSha256 !== expectedRawSha256)) {
          revisionConflict = true;
          throw new Error("state revision or raw bytes changed before temp creation");
        }
        assertManagerState(current);
        stage("current_schema_checked");
        stage("revision_checked");
        assertManagerState(state);
        stage("schema_checked");
        const basename = statePath.split(/[\\/]/).pop();
        tempPath = resolve(
          parentPath,
          `.${basename}.${process.pid}.${attemptId}.${cryptoRandomBytes(8).toString("hex")}.tmp`
        );
        const flags = fileSystem.constants.O_CREAT
          | fileSystem.constants.O_EXCL
          | fileSystem.constants.O_WRONLY
          | (fileSystem.constants.O_NOFOLLOW || 0)
          | (fileSystem.constants.O_CLOEXEC || 0);
        stage("temp_open_started");
        tempHandle = await fileSystem.open(tempPath, flags, 0o600);
        tempOpen = true;
        tempCreated = true;
        stage("temp_open_returned");
        let tempStat = await tempHandle.stat();
        tempIdentity = { dev: String(tempStat.dev), ino: String(tempStat.ino) };
        receipt.temp = structuredClone(tempIdentity);
        if (!tempStat.isFile()
          || (expectedUid !== null && tempStat.uid !== expectedUid)) {
          throw new Error("temp identity or owner verification failed");
        }
        stage("temp_fstat_verified");
        stage("temp_fchmod_started");
        await tempHandle.chmod(0o600);
        stage("temp_fchmod_returned");
        tempStat = await tempHandle.stat();
        if ((Number(tempStat.mode) & 0o7777) !== 0o600
          || (expectedUid !== null && tempStat.uid !== expectedUid)) {
          throw new Error("temp mode or owner is not exact 0600");
        }
        stage("temp_fstat_reverified");
        stage("write_started");
        await tempHandle.writeFile(JSON.stringify(state, null, 2), "utf8");
        stage("write_completed");
        stage("file_fsync_started");
        await tempHandle.sync();
        stage("file_fsync_returned");
        stage("file_close_started");
        await tempHandle.close();
        tempClosed = true;
        tempHandle = null;
        stage("file_close_returned");
        const beforeRenameRaw = await fileSystem.readFile(statePath);
        const beforeRenameRawSha256 = createHash("sha256")
          .update(beforeRenameRaw)
          .digest("hex");
        const beforeRename = JSON.parse(
          Buffer.isBuffer(beforeRenameRaw)
            ? beforeRenameRaw.toString("utf8")
            : beforeRenameRaw
        );
        if (beforeRename.revision !== expectedRevision
          || (expectedRawSha256 != null
            && beforeRenameRawSha256 !== expectedRawSha256)) {
          revisionConflict = true;
          throw new Error("state revision or raw bytes changed before rename");
        }
        assertManagerState(beforeRename);
        stage("rename_destination_schema_checked");
        assertManagerState(state);
        stage("rename_schema_checked");
        stage("rename_started");
        await fileSystem.rename(tempPath, statePath);
        renamed = true;
        stage("rename_returned");
        stage("parent_fsync_started");
        await parentHandle.sync();
        parentFsyncReturned = true;
        stage("parent_fsync_returned");
      } catch (error) {
        recordError(stages.at(-1) || "unknown", error);
      } finally {
        if (tempOpen && !tempClosed) {
          stage("file_close_retry_started");
          try {
            await tempHandle.close();
            tempClosed = true;
            tempHandle = null;
            stage("file_close_retry_returned");
          } catch (error) {
            recordError("file_close_retry", error);
            stage("file_close_retry_failed");
          }
        }
        if (tempCreated && !renamed) {
          receipt.cleanup.attempted = true;
          stage("temp_cleanup_started");
          if (!tempIdentity) {
            receipt.cleanup.status = "left-without-identity";
            stage("temp_cleanup_skipped_no_identity");
          } else {
            try {
              const currentTemp = await fileSystem.lstat(tempPath);
              if (currentTemp.isSymbolicLink()
                || String(currentTemp.dev) !== tempIdentity.dev
                || String(currentTemp.ino) !== tempIdentity.ino) {
                receipt.cleanup.status = "left-identity-mismatch";
                stage("temp_cleanup_identity_mismatch");
              } else {
                await fileSystem.unlink(tempPath);
                receipt.cleanup.status = "removed";
              }
            } catch (error) {
              receipt.cleanup.status = "failed";
              recordError("temp_cleanup", error);
            }
          }
          stage("temp_cleanup_returned");
        }
        if (parentOpen && !parentClosed) {
          stage("parent_close_started");
          try {
            await parentHandle.close();
            parentClosed = true;
            stage("parent_close_returned");
          } catch (error) {
            parentCloseFailed = true;
            recordError("parent_close", error);
            stage("parent_close_failed");
          }
        }
      }
      if (renamed) {
        receipt.outcome = parentFsyncReturned
          && !parentCloseFailed
          ? "committed"
          : "commit_uncertain";
      } else if (revisionConflict) {
        receipt.outcome = "not_committed";
      } else if (stages.includes("rename_started")) {
        receipt.outcome = "not_committed";
      } else {
        receipt.outcome = "failed";
      }
      if (receipt.outcome === "committed" && receipt.cleanup.status === "failed") {
        receipt.outcome = "commit_uncertain";
      }
      return receipt;
    }
  });
}

export { createLinuxDurableWriter };

function stateInvalid() {
  return managerError(
    "relation_file_service_state_invalid",
    "Relation file service state contract is invalid",
    500
  );
}

function managerError(code, message, status = 409) {
  return createHttpError(code, status, message);
}

function requireStoredIdentity(value, label) {
  try {
    normalizeIdentity(value, label);
  } catch {
    throw stateInvalid();
  }
}

function requireDigest(value) {
  if (!isDigest(value)) {
    throw stateInvalid();
  }
}

function normalizeIdentity(input, label) {
  const text = String(input || "").trim();
  if (!text || text !== input || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text)) {
    throw managerError(
      "relation_file_service_request_invalid",
      `${label} is invalid`,
      400
    );
  }
  return text;
}

function normalizeStatePath(input) {
  if (typeof input !== "string" || !input || input.trim() !== input || !isAbsolute(input)) {
    throw managerError(
      "relation_file_service_request_invalid",
      "statePath must be an absolute path",
      400
    );
  }
  return resolve(input);
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw managerError(
      "relation_file_service_request_invalid",
      `${label} must be a function`,
      400
    );
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw managerError(
      "relation_file_service_request_invalid",
      `${label} must be a plain object`,
      400
    );
  }
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw managerError(
        "relation_file_service_request_invalid",
        `${label} contains unsupported field: ${key}`,
        400
      );
    }
  }
}

function assertExactKeys(value, expected, label) {
  const expectedSet = new Set(expected);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expectedSet.has(key))) {
    throw stateInvalid();
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw stateInvalid();
    }
  }
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function digestValue(value) {
  return digestText(stableSerialize(value));
}

function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableSerialize(value) {
  return stableSerializeInner(value, new Set());
}

function stableSerializeInner(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && !isWellFormedUnicode(value)) {
      throw requestInvalid();
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)
      || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw requestInvalid();
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) {
    throw requestInvalid();
  }
  if (ancestors.has(value)) {
    throw requestInvalid();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw requestInvalid();
      }
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw requestInvalid();
        }
        parts.push(stableSerializeInner(value[index], ancestors));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw requestInvalid();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw requestInvalid();
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        throw requestInvalid();
      }
    }
    keys.sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${stableSerializeInner(value[key], ancestors)}`
    )).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requestInvalid() {
  return managerError(
    "relation_file_service_request_invalid",
    "request values must be unambiguous plain JSON",
    400
  );
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

function isNullableBoolean(value) {
  return value === null || typeof value === "boolean";
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isCanonicalDecimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isLowerUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isExecutableIdentity(value) {
  return isPlainObject(value)
    && isCanonicalDecimal(value.dev)
    && isCanonicalDecimal(value.ino)
    && isCanonicalDecimal(value.size)
    && isDigest(value.sha256);
}

function nowIso(context) {
  const value = context.clock();
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && isTimestamp(value)) {
    return value;
  }
  throw managerError(
    "relation_file_service_request_invalid",
    "clock must return a Date or timestamp string",
    400
  );
}
