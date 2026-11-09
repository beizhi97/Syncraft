import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerAdmissionCore } from "../src/service/ownerAdmissionCore.js";

const statePath = "/srv/sfsc/relation-services.json";
const evidence = Object.freeze({
  schemaVersion: "1",
  statePath,
  parentDev: "12",
  parentIno: "34",
  lockDev: "56",
  lockIno: "78"
});
const verification = Object.freeze({ ...evidence, valid: true });

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fakeBinding({
  acquire = () => ({ ...evidence }),
  verify = () => ({ ...verification })
} = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      acquireOwnerLock(input) {
        calls.push({ operation: "acquire", input });
        return acquire(input);
      },
      verifyOwnerLock(input) {
        calls.push({ operation: "verify", input });
        return verify(input);
      }
    }
  };
}

function hasCode(code) {
  return error => error?.code === code;
}

test("candidate core exposes only acquireOwnerLease and assertOwnerLease", () => {
  const { binding } = fakeBinding();
  const admission = createOwnerAdmissionCore({ binding });
  assert.deepEqual(Object.keys(admission), [
    "acquireOwnerLease",
    "assertOwnerLease"
  ]);

  const lease = admission.acquireOwnerLease({ statePath });
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease), []);
  assert.deepEqual(admission.assertOwnerLease(lease), verification);
});

test("mandatory acquire then verify establishes the lease", () => {
  const { binding, calls } = fakeBinding();
  const admission = createOwnerAdmissionCore({ binding });
  const lease = admission.acquireOwnerLease({ statePath });
  assert.deepEqual(calls.map(call => call.operation), ["acquire", "verify"]);
  assert.deepEqual(calls[0].input, { statePath });
  assert.deepEqual(calls[1].input, { evidence });
  assert.deepEqual(admission.assertOwnerLease(lease), verification);
});

test("acquire reads statePath once and uses only that snapshot", () => {
  let reads = 0;
  const request = {
    get statePath() {
      reads += 1;
      return reads === 1 ? statePath : "/other/relation-services.json";
    }
  };
  const { binding, calls } = fakeBinding();
  const admission = createOwnerAdmissionCore({ binding });

  admission.acquireOwnerLease(request);
  assert.equal(reads, 1);
  assert.equal(calls[0].input.statePath, statePath);
});

test("invalid evidence uses a fresh empty invalidation sentinel and becomes sticky", () => {
  const { binding, calls } = fakeBinding({
    acquire: () => ({ ...evidence, parentDev: "01" }),
    verify: input => {
      if (Object.keys(input.evidence).length === 0) {
        throw codedError("owner_lock_evidence_invalid");
      }
      return { ...verification, parentDev: input.evidence.parentDev };
    }
  });
  const admission = createOwnerAdmissionCore({ binding });

  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_evidence_invalid")
  );
  assert.equal(calls.at(-1).operation, "verify");
  assert.deepEqual(calls.at(-1).input, { evidence: {} });
  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_sticky_invalid")
  );
});

test("malformed verification uses a second fresh empty sentinel", () => {
  let verifyCount = 0;
  const { binding, calls } = fakeBinding({
    verify: () => {
      verifyCount += 1;
      if (verifyCount === 1) {
        return { ...verification, extra: true };
      }
      throw codedError("owner_lock_evidence_invalid");
    }
  });
  const admission = createOwnerAdmissionCore({ binding });

  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_evidence_invalid")
  );
  assert.deepEqual(
    calls.filter(call => call.operation === "verify").map(call => call.input),
    [{ evidence }, { evidence: {} }]
  );
  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_sticky_invalid")
  );
});

test("reentrant acquire while ACQUIRING is rejected without consuming a second attempt", () => {
  let admission;
  let nestedCode;
  const { binding } = fakeBinding({
    acquire: () => {
      try {
        admission.acquireOwnerLease({ statePath });
      } catch (error) {
        nestedCode = error.code;
      }
      return { ...evidence };
    }
  });
  admission = createOwnerAdmissionCore({ binding });

  const lease = admission.acquireOwnerLease({ statePath });
  assert.equal(nestedCode, "owner_lock_already_admitted");
  assert.deepEqual(admission.assertOwnerLease(lease), verification);
});

test("nested verify is rejected while verification is in flight", () => {
  let admission;
  let lease;
  let nestedCode;
  let trigger = false;
  const { binding } = fakeBinding({
    verify: () => {
      if (trigger) {
        try {
          admission.assertOwnerLease(lease);
        } catch (error) {
          nestedCode = error.code;
        }
      }
      return { ...verification };
    }
  });
  admission = createOwnerAdmissionCore({ binding });
  lease = admission.acquireOwnerLease({ statePath });
  trigger = true;

  assert.deepEqual(admission.assertOwnerLease(lease), verification);
  assert.equal(nestedCode, "owner_lock_verification_in_progress");
});

test("verification in-flight guard covers result normalization getters", () => {
  let admission;
  let lease;
  let nestedCode;
  let verifyCount = 0;
  const { binding } = fakeBinding({
    verify: () => {
      verifyCount += 1;
      if (verifyCount === 1) {
        return { ...verification };
      }
      return {
        schemaVersion: "1",
        get valid() {
          try {
            admission.assertOwnerLease(lease);
          } catch (error) {
            nestedCode = error.code;
          }
          return true;
        },
        statePath: evidence.statePath,
        parentDev: evidence.parentDev,
        parentIno: evidence.parentIno,
        lockDev: evidence.lockDev,
        lockIno: evidence.lockIno
      };
    }
  });
  admission = createOwnerAdmissionCore({ binding });
  lease = admission.acquireOwnerLease({ statePath });

  assert.deepEqual(admission.assertOwnerLease(lease), verification);
  assert.equal(nestedCode, "owner_lock_verification_in_progress");
});

test("a failed verification call becomes sticky and cannot be retried", () => {
  let trigger = false;
  const { binding } = fakeBinding({
    verify: () => {
      if (trigger) {
        throw codedError("owner_lock_replaced");
      }
      return { ...verification };
    }
  });
  const admission = createOwnerAdmissionCore({ binding });
  const lease = admission.acquireOwnerLease({ statePath });
  trigger = true;

  assert.throws(
    () => admission.assertOwnerLease(lease),
    hasCode("owner_lock_replaced")
  );
  assert.throws(
    () => admission.assertOwnerLease(lease),
    hasCode("owner_lock_sticky_invalid")
  );
  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_sticky_invalid")
  );
});

test("invalid main-thread input consumes the one allowed attempt", () => {
  const { binding, calls } = fakeBinding();
  const admission = createOwnerAdmissionCore({ binding });

  assert.throws(
    () => admission.acquireOwnerLease({}),
    hasCode("owner_lock_input_invalid")
  );
  assert.equal(calls.length, 0);
  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_retry_forbidden")
  );

  const pathAdmission = createOwnerAdmissionCore({
    binding: fakeBinding().binding
  });
  assert.throws(
    () => pathAdmission.acquireOwnerLease({ statePath: "relative.json" }),
    hasCode("owner_lock_path_invalid")
  );
});

test("worker rejection does not consume the later main-thread attempt", () => {
  let mainThread = false;
  const { binding, calls } = fakeBinding();
  const admission = createOwnerAdmissionCore({
    binding,
    isMainThread: () => mainThread
  });

  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_main_thread_required")
  );
  assert.equal(calls.length, 0);
  mainThread = true;
  const lease = admission.acquireOwnerLease({ statePath });
  assert.deepEqual(admission.assertOwnerLease(lease), verification);
});

test("second acquire, including a different path, never mints another lease", () => {
  const { binding } = fakeBinding();
  const admission = createOwnerAdmissionCore({ binding });
  admission.acquireOwnerLease({ statePath });

  assert.throws(
    () => admission.acquireOwnerLease({ statePath }),
    hasCode("owner_lock_already_admitted")
  );
  assert.throws(
    () => admission.acquireOwnerLease({
      statePath: "/other/relation-services.json"
    }),
    hasCode("owner_lock_already_admitted")
  );
});

test("production candidate exports no native verify or fake mint", async () => {
  const production = await import("../src/service/ownerAdmission.js");
  assert.deepEqual(Object.keys(production).sort(), [
    "acquireOwnerLease",
    "assertOwnerLease"
  ]);
  assert.equal("verifyOwnerLock" in production, false);
  assert.equal("createOwnerAdmissionCore" in production, false);
});
