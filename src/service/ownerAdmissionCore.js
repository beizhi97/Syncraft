import { isMainThread as nodeIsMainThread } from "node:worker_threads";
import { evaluateManagerHistoryClosure } from "./startupQuiescenceStateParser.js";
import { STARTUP_STATE_POLICY_LIMITS } from "./strictStateJson.js";

const EVIDENCE_KEYS = [
  "lockDev",
  "lockIno",
  "parentDev",
  "parentIno",
  "schemaVersion",
  "statePath"
];
const VERIFICATION_KEYS = [...EVIDENCE_KEYS, "valid"];
const DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;
const STATE_BASENAME = "relation-services.json";
const SENTINEL = Object.freeze({});
const SNAPSHOT_BINDING_KEYS = Object.freeze([
  "acquireOwnerLock",
  "readOwnerStateSnapshot",
  "verifyOwnerLock"
]);
const SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: STARTUP_STATE_POLICY_LIMITS.maxBytes,
  maxDepth: STARTUP_STATE_POLICY_LIMITS.maxDepth,
  maxNodes: STARTUP_STATE_POLICY_LIMITS.maxNodes
});

function ownerLockError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function assertPlainObject(value, label, code) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw ownerLockError(code, `${label} must be a plain object`);
  }
}

function assertExactKeys(value, expected, label, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw ownerLockError(
      code,
      `${label} must contain exactly ${wanted.join(", ")}`
    );
  }
}

function assertAcquireRequest(input) {
  assertPlainObject(
    input,
    "acquire request",
    "owner_lock_input_invalid"
  );
  assertExactKeys(
    input,
    ["statePath"],
    "acquire request",
    "owner_lock_input_invalid"
  );
}

function assertCanonicalStatePath(statePath) {
  if (typeof statePath !== "string"
    || statePath.includes("\0")
    || !statePath.startsWith("/")
    || statePath.endsWith("/")
    || statePath.includes("//")
    || statePath.split("/").some((part, index) => index > 0
      && (part === "" || part === "." || part === ".."))
    || statePath.slice(statePath.lastIndexOf("/") + 1) !== STATE_BASENAME) {
    throw ownerLockError(
      "owner_lock_path_invalid",
      "statePath must be a canonical absolute relation-services.json path"
    );
  }
}

function assertDecimalString(value, label) {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) {
    throw ownerLockError(
      "owner_lock_evidence_invalid",
      `${label} must be a canonical decimal string`
    );
  }
}

function normalizeEvidence(value, expectedStatePath) {
  assertPlainObject(
    value,
    "owner evidence",
    "owner_lock_evidence_invalid"
  );
  assertExactKeys(
    value,
    EVIDENCE_KEYS,
    "owner evidence",
    "owner_lock_evidence_invalid"
  );
  const snapshot = {
    schemaVersion: value.schemaVersion,
    statePath: value.statePath,
    parentDev: value.parentDev,
    parentIno: value.parentIno,
    lockDev: value.lockDev,
    lockIno: value.lockIno
  };
  if (snapshot.schemaVersion !== "1"
    || snapshot.statePath !== expectedStatePath) {
    throw ownerLockError(
      "owner_lock_evidence_invalid",
      "owner evidence schema or statePath does not match"
    );
  }
  for (const key of ["parentDev", "parentIno", "lockDev", "lockIno"]) {
    assertDecimalString(snapshot[key], key);
  }
  return Object.freeze(snapshot);
}

function normalizeVerification(value, evidence) {
  assertPlainObject(
    value,
    "owner verification",
    "owner_lock_evidence_invalid"
  );
  assertExactKeys(
    value,
    VERIFICATION_KEYS,
    "owner verification",
    "owner_lock_evidence_invalid"
  );
  const snapshot = {
    schemaVersion: value.schemaVersion,
    valid: value.valid,
    statePath: value.statePath,
    parentDev: value.parentDev,
    parentIno: value.parentIno,
    lockDev: value.lockDev,
    lockIno: value.lockIno
  };
  if (snapshot.schemaVersion !== "1" || snapshot.valid !== true) {
    throw ownerLockError(
      "owner_lock_evidence_invalid",
      "owner verification must be schema 1 and valid"
    );
  }
  for (const key of EVIDENCE_KEYS) {
    if (snapshot[key] !== evidence[key]) {
      throw ownerLockError(
        "owner_lock_evidence_invalid",
        `owner verification ${key} does not match owner evidence`
      );
    }
  }
  return Object.freeze({
    schemaVersion: "1",
    valid: true,
    statePath: evidence.statePath,
    parentDev: evidence.parentDev,
    parentIno: evidence.parentIno,
    lockDev: evidence.lockDev,
    lockIno: evidence.lockIno
  });
}

function normalizeBinding(binding, snapshotEnabled) {
  const expectedKeys = snapshotEnabled
    ? SNAPSHOT_BINDING_KEYS
    : ["acquireOwnerLock", "verifyOwnerLock"];
  if (binding === null
    || typeof binding !== "object"
    || expectedKeys.some(key => typeof binding[key] !== "function")) {
    throw ownerLockError(
      "owner_lock_artifact_invalid",
      snapshotEnabled
        ? "native binding must export the exact r4 functions"
        : "native binding must export acquireOwnerLock and verifyOwnerLock"
    );
  }
  const keys = Object.keys(binding).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw ownerLockError(
      "owner_lock_artifact_invalid",
      "native binding exports are not exact"
    );
  }
  return Object.freeze(Object.fromEntries(
    expectedKeys.map(key => [key, binding[key]])
  ));
}

function normalizeThrown(error, fallbackCode) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error;
  }
  return ownerLockError(fallbackCode, "owner lock operation failed", error);
}

export function createOwnerAdmissionCore({
  binding,
  isMainThread = () => nodeIsMainThread,
  snapshotEnabled = false
} = {}) {
  if (typeof snapshotEnabled !== "boolean") {
    throw ownerLockError(
      "owner_lock_input_invalid",
      "snapshotEnabled must be a boolean"
    );
  }
  const nativeBinding = normalizeBinding(binding, snapshotEnabled);
  if (typeof isMainThread !== "function") {
    throw ownerLockError(
      "owner_lock_input_invalid",
      "isMainThread must be a function"
    );
  }

  let lifecycle = "empty";
  let acquireInFlight = false;
  let ownerCallInFlight = false;
  const leases = new WeakMap();

  function stickyInvalidate() {
    lifecycle = "sticky_invalid";
  }

  function invalidateNativeOwner() {
    // The fresh empty object is deliberately invalid. It must never be replaced
    // with raw caller evidence, which may satisfy the native schema.
    try {
      nativeBinding.verifyOwnerLock({ evidence: { ...SENTINEL } });
    } catch {
      // JS sticky state is still required when native invalidation also fails.
    }
  }

  function beginOwnerCall() {
    if (ownerCallInFlight) {
      if (snapshotEnabled) {
        stickyInvalidate();
        invalidateNativeOwner();
      }
      throw ownerLockError(
        "owner_lock_verification_in_progress",
        "owner verification or snapshot is already in flight"
      );
    }
    ownerCallInFlight = true;
  }

  function endOwnerCall() {
    ownerCallInFlight = false;
  }

  function acquireOwnerLease(input = {}) {
    if (!isMainThread()) {
      throw ownerLockError(
        "owner_lock_main_thread_required",
        "owner lease acquisition must run on the Node main thread"
      );
    }
    if (acquireInFlight || ["lease_unverified", "active"].includes(lifecycle)) {
      throw ownerLockError(
        "owner_lock_already_admitted",
        "this process already reserved the owner lease"
      );
    }
    if (lifecycle === "failed") {
      throw ownerLockError(
        "owner_lock_retry_forbidden",
        "the single owner-lock attempt has already failed"
      );
    }
    if (lifecycle === "sticky_invalid") {
      throw ownerLockError(
        "owner_lock_sticky_invalid",
        "the owner lease is permanently invalid"
      );
    }

    acquireInFlight = true;
    lifecycle = "acquiring";
    try {
      try {
        assertAcquireRequest(input);
        const statePath = input.statePath;
        assertCanonicalStatePath(statePath);
        input = Object.freeze({ statePath });
      } catch (error) {
        lifecycle = "failed";
        throw normalizeThrown(error, "owner_lock_input_invalid");
      }

      let rawEvidence;
      try {
        rawEvidence = nativeBinding.acquireOwnerLock({
          statePath: input.statePath
        });
      } catch (error) {
        lifecycle = "failed";
        throw normalizeThrown(error, "owner_lock_napi_failed");
      }

      let evidence;
      try {
        evidence = normalizeEvidence(rawEvidence, input.statePath);
      } catch (error) {
        invalidateNativeOwner();
        stickyInvalidate();
        throw normalizeThrown(error, "owner_lock_evidence_invalid");
      }

      let rawVerification;
      try {
        rawVerification = nativeBinding.verifyOwnerLock({ evidence });
      } catch (error) {
        stickyInvalidate();
        throw normalizeThrown(error, "owner_lock_napi_failed");
      }

      let verification;
      try {
        verification = normalizeVerification(rawVerification, evidence);
      } catch (error) {
        invalidateNativeOwner();
        stickyInvalidate();
        throw normalizeThrown(error, "owner_lock_evidence_invalid");
      }

      if (lifecycle !== "acquiring") {
        invalidateNativeOwner();
        stickyInvalidate();
        throw ownerLockError(
          "owner_lock_sticky_invalid",
          "owner lifecycle changed while admission was in flight"
        );
      }

      const lease = Object.freeze(Object.create(null));
      leases.set(lease, {
        evidence,
        verification,
        snapshotConsumed: false
      });
      lifecycle = "active";
      return lease;
    } finally {
      acquireInFlight = false;
    }
  }

  function assertOwnerLeaseR3(lease) {
    if (!isMainThread()) {
      throw ownerLockError(
        "owner_lock_main_thread_required",
        "owner lease verification must run on the Node main thread"
      );
    }
    beginOwnerCall();
    try {
      if (lifecycle === "sticky_invalid") {
        throw ownerLockError(
          "owner_lock_sticky_invalid",
          "the owner lease is permanently invalid"
        );
      }
      const record = leases.get(lease);
      if (!record || lifecycle !== "active") {
        throw ownerLockError(
          "owner_lock_evidence_invalid",
          "owner lease token is unknown or not active"
        );
      }

      let rawVerification;
      try {
        rawVerification = nativeBinding.verifyOwnerLock({
          evidence: record.evidence
        });
      } catch (error) {
        stickyInvalidate();
        throw normalizeThrown(error, "owner_lock_napi_failed");
      }

      let verification;
      try {
        verification = normalizeVerification(rawVerification, record.evidence);
      } catch (error) {
        invalidateNativeOwner();
        stickyInvalidate();
        throw normalizeThrown(error, "owner_lock_evidence_invalid");
      }

      if (lifecycle !== "active") {
        throw ownerLockError(
          "owner_lock_sticky_invalid",
          "owner lifecycle changed while verification was in flight"
        );
      }
      return verification;
    } finally {
      endOwnerCall();
    }
  }

  function assertOwnerLeaseR4(lease) {
    if (!isMainThread()) {
      throw ownerLockError(
        "owner_lock_main_thread_required",
        "owner lease verification must run on the Node main thread"
      );
    }
    if (lifecycle === "sticky_invalid") {
      throw ownerLockError(
        "owner_lock_sticky_invalid",
        "the owner lease is permanently invalid"
      );
    }
    const record = leases.get(lease);
    if (!record || lifecycle !== "active") {
      throw ownerLockError(
        "owner_lock_evidence_invalid",
        "owner lease token is unknown or not active"
      );
    }

    beginOwnerCall();
    try {
      let rawVerification;
      try {
        rawVerification = nativeBinding.verifyOwnerLock({
          evidence: record.evidence
        });
      } catch (error) {
        throw normalizeThrown(error, "owner_lock_napi_failed");
      }

      let verification;
      try {
        verification = normalizeVerification(rawVerification, record.evidence);
      } catch (error) {
        throw normalizeThrown(error, "owner_lock_evidence_invalid");
      }
      if (lifecycle !== "active") {
        throw ownerLockError(
          "owner_lock_sticky_invalid",
          "owner lifecycle changed while verification was in flight"
        );
      }
      return verification;
    } catch (error) {
      stickyInvalidate();
      invalidateNativeOwner();
      throw normalizeThrown(error, "owner_lock_napi_failed");
    } finally {
      endOwnerCall();
    }
  }

  function assertOwnerLease(lease) {
    return snapshotEnabled
      ? assertOwnerLeaseR4(lease)
      : assertOwnerLeaseR3(lease);
  }

  function evaluateStartupState(lease) {
    if (!isMainThread()) {
      throw ownerLockError(
        "owner_lock_main_thread_required",
        "owner state snapshot must run on the Node main thread"
      );
    }
    if (lifecycle === "sticky_invalid") {
      throw ownerLockError(
        "owner_lock_sticky_invalid",
        "the owner lease is permanently invalid"
      );
    }
    const record = leases.get(lease);
    if (!record || lifecycle !== "active") {
      throw ownerLockError(
        "owner_lock_evidence_invalid",
        "owner lease token is unknown or not active"
      );
    }
    if (ownerCallInFlight) {
      beginOwnerCall();
    }
    if (record.snapshotConsumed) {
      throw ownerLockError(
        "owner_state_snapshot_consumed",
        "this owner lease has already consumed its state snapshot"
      );
    }

    beginOwnerCall();
    try {
      let bytes;
      try {
        bytes = nativeBinding.readOwnerStateSnapshot({
          evidence: record.evidence,
          maxBytes: SNAPSHOT_LIMITS.maxBytes
        });
      } catch (error) {
        throw normalizeThrown(error, "owner_lock_napi_failed");
      }
      if (!Buffer.isBuffer(bytes)
        || bytes.length > SNAPSHOT_LIMITS.maxBytes) {
        throw ownerLockError(
          "owner_state_snapshot_invalid",
          "native snapshot did not return a bounded Buffer"
        );
      }

      record.snapshotConsumed = true;
      let result;
      try {
        result = evaluateManagerHistoryClosure(bytes, SNAPSHOT_LIMITS);
      } catch (error) {
        throw ownerLockError(
          "owner_state_parser_failed",
          "the accepted parser raised unexpectedly",
          error
        );
      }
      if (lifecycle !== "active") {
        throw ownerLockError(
          "owner_lock_sticky_invalid",
          "owner lifecycle changed while snapshot evaluation was in flight"
        );
      }
      if (result?.fullStartupAdmission !== false) {
        throw ownerLockError(
          "owner_state_admission_invalid",
          "the accepted parser did not preserve the full-admission block"
        );
      }
      return result;
    } catch (error) {
      stickyInvalidate();
      invalidateNativeOwner();
      throw normalizeThrown(error, "owner_lock_napi_failed");
    } finally {
      endOwnerCall();
    }
  }

  const surface = {
    acquireOwnerLease,
    assertOwnerLease
  };
  if (snapshotEnabled) {
    surface.evaluateStartupState = evaluateStartupState;
  }
  return Object.freeze(surface);
}
