import test from "node:test";
import assert from "node:assert/strict";
import { assertClientEnrollmentStatusContract } from "../scripts/lib/runtimeContracts.mjs";

function enrollment(overrides = {}) {
  return {
    phase: "not-started",
    serverId: "",
    signingKeyId: "",
    serverKeyFingerprint: "",
    deviceId: "",
    requestId: "",
    status: "",
    directoryAuthorization: "waiting",
    authorizedDirectories: [],
    ...overrides
  };
}

test("client enrollment status contract accepts fixed public identity and authorized directory summaries", () => {
  assertClientEnrollmentStatusContract(enrollment());
  assertClientEnrollmentStatusContract(enrollment({
    phase: "identity-verified-awaiting-directory-authorization",
    serverId: "server-1",
    signingKeyId: "key-1",
    serverKeyFingerprint: "sha256:abc",
    deviceId: "device-1",
    requestId: "request-1",
    status: "consumed",
    directoryAuthorization: "granted",
    authorizedDirectories: [{
      relationId: "rel_0123456789abcdef",
      displayName: "Documents",
      expiresAt: "2026-10-30T00:00:00.000Z"
    }]
  }));
  assertClientEnrollmentStatusContract({ phase: "local-state-error", stateError: "local_state_corrupt" });
});

test("client enrollment status contract rejects unknown fields and credential material", () => {
  assert.throws(
    () => assertClientEnrollmentStatusContract(enrollment({ privateKey: "must-not-escape" })),
    /keys expected/
  );
  assert.throws(
    () => assertClientEnrollmentStatusContract(enrollment({
      authorizedDirectories: [{ relationId: "rel_0123456789abcdef", displayName: "Docs", expiresAt: "now", secretAccessKey: "leak" }]
    })),
    /keys expected/
  );
});
