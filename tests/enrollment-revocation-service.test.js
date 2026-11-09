import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeOneTimeEnrollmentCode, createEnrollmentAuthorityState, issueOneTimeEnrollmentCode, revokeEnrollmentDevice, verifySignedAuthorizationRequest } from "../src/core/enrollmentAuthority.js";
import { createEnrollmentKeyPair, signAuthorizationRequest } from "../src/core/enrollmentProtocol.js";
import { open as openRelationManager } from "../src/core/relationFileServiceManager.js";
import { createEnrollmentRevocationService } from "../src/service/enrollmentRevocationService.js";

const SERVER_ID = "srv_0000000000000001";
const DEVICE_A = "dev_0000000000000001";
const DEVICE_B = "dev_0000000000000002";
const ROOT_A = "root_0000000000000001";
const ROOT_B = "root_0000000000000002";
const SHARE_A = "shr_0000000000000001";
const SHARE_B = "shr_0000000000000002";
const REL_A = "rel_0000000000000001";
const REL_B = "rel_0000000000000002";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function createAuthority() {
  const pairA = createEnrollmentKeyPair();
  const pairB = createEnrollmentKeyPair();
  let state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  for (const [deviceId, pair, bindings, requestId] of [
    [DEVICE_A, pairA, [
      { protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding", identity: { serverId: SERVER_ID, deviceId: DEVICE_A, shareId: SHARE_A, rootId: ROOT_A, relationId: REL_A }, baselineEpoch: 1, channelRevision: "chrev_0000000000000001", credentialRevision: "cred_0000000000000001", rootAttestation: { source: "server-enrollment-record", referenceId: "att_0000000000000001", attestedAt: new Date(NOW).toISOString() } },
      { protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding", identity: { serverId: SERVER_ID, deviceId: DEVICE_A, shareId: SHARE_B, rootId: ROOT_B, relationId: REL_B }, baselineEpoch: 1, channelRevision: "chrev_0000000000000001", credentialRevision: "cred_0000000000000002", rootAttestation: { source: "server-enrollment-record", referenceId: "att_0000000000000002", attestedAt: new Date(NOW).toISOString() } }
    ], "req_0000000000000001"],
    [DEVICE_B, pairB, [
      { protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding", identity: { serverId: SERVER_ID, deviceId: DEVICE_B, shareId: "shr_0000000000000003", rootId: ROOT_A, relationId: "rel_0000000000000003" }, baselineEpoch: 1, channelRevision: "chrev_0000000000000001", credentialRevision: "cred_0000000000000003", rootAttestation: { source: "server-enrollment-record", referenceId: "att_0000000000000003", attestedAt: new Date(NOW).toISOString() } }
    ], "req_0000000000000002"]
  ]) {
    const issued = issueOneTimeEnrollmentCode(state, {
      requestId, deviceId, channelRevision: "chrev_0000000000000001",
      publicKey: pair.publicKey.export({ format: "jwk" }), bindings,
      issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString()
    }, { expectedRevision: state.revision, nowMs: NOW });
    state = consumeOneTimeEnrollmentCode(issued.nextState, issued.code, {
      requestId,
      deviceId,
      channelRevision: "chrev_0000000000000001",
      publicKey: pair.publicKey.export({ format: "jwk" }),
      bindings
    }, { expectedRevision: issued.nextState.revision, nowMs: NOW }).nextState;
  }
  return state;
}

function fakeCatalog(authority = createAuthority()) {
  let state = { authority, kind: "test", revision: 0, relations: {
    [REL_A]: { rootId: ROOT_A }, [REL_B]: { rootId: ROOT_B }, "rel_0000000000000003": { rootId: ROOT_A }
  }, revocationOperations: {} };
  return {
    async read() { return structuredClone(state); },
    async update({ expectedRevision }, updater) {
      assert.equal(state.revision, expectedRevision);
      const next = structuredClone(state);
      const returned = await updater(next);
      state = returned ?? next;
      state.revision = expectedRevision + 1;
      return structuredClone(state);
    }
  };
}

function createSingleDeviceAuthority() {
  const pair = createEnrollmentKeyPair();
  let state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const binding = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: { serverId: SERVER_ID, deviceId: DEVICE_A, shareId: SHARE_A, rootId: ROOT_A, relationId: REL_A },
    baselineEpoch: 1, channelRevision: "chrev_0000000000000001", credentialRevision: "cred_0000000000000001",
    rootAttestation: { source: "server-enrollment-record", referenceId: "att_0000000000000001", attestedAt: new Date(NOW).toISOString() }
  };
  const issued = issueOneTimeEnrollmentCode(state, {
    requestId: "req_0000000000000001", deviceId: DEVICE_A, channelRevision: binding.channelRevision,
    publicKey: pair.publicKey.export({ format: "jwk" }), bindings: [binding],
    issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString()
  }, { expectedRevision: state.revision, nowMs: NOW });
  state = consumeOneTimeEnrollmentCode(issued.nextState, issued.code, {
    requestId: "req_0000000000000001", deviceId: DEVICE_A, channelRevision: binding.channelRevision,
    publicKey: pair.publicKey.export({ format: "jwk" }), bindings: [binding]
  }, { expectedRevision: issued.nextState.revision, nowMs: NOW }).nextState;
  return { state, pair, binding };
}

function manager({ running = new Set(), stopped = new Set(), failFirst = false } = {}) {
  const calls = [];
  let fail = failFirst;
  return {
    calls,
    async query({ relationId }) {
      calls.push(["query", relationId]);
      if (running.has(relationId)) return { relationId, desired: "enabled", state: "running", source: "manager-state", handlePresent: true };
      if (stopped.has(relationId)) return { relationId, desired: "disabled", state: "stopped", source: "manager-state", handlePresent: true, cleanupRequired: false, commitUncertain: false };
      return { relationId, desired: null, state: "absent", source: "manager-state", handlePresent: false, runningEvidencePresent: false, cleanupRequired: false, commitUncertain: false };
    },
    async disable(input) {
      calls.push(["disable", input.relationId, input.operationId, input.identity]);
      if (fail) { fail = false; return { relationId: input.relationId, desired: "disabled", state: "cleanup_required", reason: "relation_file_service_runtime_cleanup_unconfirmed" }; }
      running.delete(input.relationId);
      stopped.add(input.relationId);
      return { relationId: input.relationId, desired: "disabled", state: "stopped", reason: "" };
    }
  };
}

test("relation revoke is scoped, durable, idempotent, and queryable", async () => {
  const catalog = fakeCatalog();
  const relationService = manager({ running: new Set([REL_A]) });
  const applied = [];
  const service = createEnrollmentRevocationService({ catalog, relationService, applyOverlay: async () => { applied.push("apply"); return { applied: true }; }, now: () => NOW });
  const input = { operationId: "revop_0000000000000001", target: { kind: "relation", relationId: REL_A } };
  const first = await service.revoke(input);
  assert.equal(first.status, "complete", JSON.stringify(first));
  assert.ok(first.authorityRevokedAt);
  assert.equal((await catalog.read()).authority.relationGrants[REL_B].revokedAt, null);
  assert.equal((await catalog.read()).authority.devices[DEVICE_A].revokedAt, null);
  assert.equal((await catalog.read()).authority.devices[DEVICE_B].revokedAt, null);
  assert.deepEqual(applied, ["apply"]);
  assert.equal(relationService.calls.some(([method, id]) => method === "disable" && id === REL_B), false);
  assert.equal(relationService.calls.some(([method, id]) => method === "disable" && id === "rel_0000000000000003"), false);
  const retry = await service.revoke(input);
  assert.equal(retry.status, "complete");
  assert.equal(relationService.calls.filter(([method]) => method === "disable").length, 1);
  assert.deepEqual(await service.get(input.operationId), retry);
  await assert.rejects(() => service.revoke({ ...input, target: { kind: "relation", relationId: REL_B } }), error => error.code === "enrollment_revocation_operation_conflict");
});

test("device revoke covers only that device and disables its current relations", async () => {
  const catalog = fakeCatalog();
  const relationService = manager({ running: new Set([REL_A, REL_B, "rel_0000000000000003"]) });
  const service = createEnrollmentRevocationService({ catalog, relationService, applyOverlay: async () => ({ applied: true }), now: () => NOW });
  const result = await service.revoke({ operationId: "revop_0000000000000002", target: { kind: "device", deviceId: DEVICE_A } });
  assert.equal(result.status, "complete");
  const state = await catalog.read();
  assert.ok(state.authority.devices[DEVICE_A].revokedAt);
  assert.equal(state.authority.devices[DEVICE_B].revokedAt, null);
  assert.deepEqual(relationService.calls.filter(([method]) => method === "disable").map(([, id]) => id).sort(), [REL_A, REL_B]);
  assert.equal((await catalog.read()).authority.relationGrants["rel_0000000000000003"].revokedAt, null, "other device relation remains granted");
  assert.equal(relationService.calls.some(([method, id]) => method === "disable" && id === "rel_0000000000000003"), false);
});

test("device revocation rejects a fresh enrollment claim and signed channel refresh", () => {
  const { state, pair, binding } = createSingleDeviceAuthority();
  const revoked = revokeEnrollmentDevice(state, { deviceId: DEVICE_A }, { expectedRevision: state.revision, nowMs: NOW + 1000 }).nextState;
  assert.throws(() => issueOneTimeEnrollmentCode(revoked, {
    requestId: "req_0000000000000002", deviceId: DEVICE_A,
    channelRevision: binding.channelRevision,
    publicKey: pair.publicKey.export({ format: "jwk" }), bindings: [binding],
    issuedAt: new Date(NOW + 2000).toISOString(), expiresAt: new Date(NOW + 62_000).toISOString()
  }, { expectedRevision: revoked.revision, nowMs: NOW + 2000 }), error => error.code === "enrollment_device_revoked");
  const bodyBytes = Buffer.from(JSON.stringify({ channelRevision: binding.channelRevision }));
  const signedRefresh = signAuthorizationRequest({
    binding, method: "POST", path: "/api/enrollment/v1/channel-renewal", bodyBytes,
    timestamp: new Date(NOW + 2000).toISOString(), nonce: "revoked_refresh_nonce_1"
  }, pair.privateKey);
  assert.throws(() => verifySignedAuthorizationRequest(revoked, signedRefresh, {
    bodySha256: signedRefresh.bodySha256, method: "POST", path: "/api/enrollment/v1/channel-renewal"
  }, { expectedRevision: revoked.revision, nowMs: NOW + 2000 }), error => error.code === "enrollment_relation_denied");
});

test("revoked authority survives failed disable and retry resumes without regrant", async () => {
  const catalog = fakeCatalog();
  const relationService = manager({ running: new Set([REL_A]), failFirst: true });
  const service = createEnrollmentRevocationService({ catalog, relationService, applyOverlay: async () => ({ applied: true }), now: () => NOW });
  const input = { operationId: "revop_0000000000000004", target: { kind: "relation", relationId: REL_A } };
  const pending = await service.revoke(input);
  assert.equal(pending.status, "pending");
  assert.ok((await catalog.read()).authority.relationGrants[REL_A].revokedAt);
  const complete = await service.revoke(input);
  assert.equal(complete.status, "complete");
  assert.ok((await catalog.read()).authority.relationGrants[REL_A].revokedAt);
  assert.equal(relationService.calls.filter(([method]) => method === "disable").length, 2);
});

test("operation GET stays observable while runtime disable is unresolved", async () => {
  const catalog = fakeCatalog();
  let signalDisableStarted;
  const disableStarted = new Promise(resolve => { signalDisableStarted = resolve; });
  let resolveDisable;
  const disableGate = new Promise(resolve => { resolveDisable = resolve; });
  let disabled = false;
  const relationService = {
    async query() {
      if (disabled) return { relationId: REL_A, desired: "disabled", state: "stopped", source: "manager-state", handlePresent: true, cleanupRequired: false, commitUncertain: false };
      return { relationId: REL_A, desired: "enabled", state: "running", source: "manager-state", handlePresent: true };
    },
    async disable() {
      signalDisableStarted();
      await disableGate;
      disabled = true;
      return { relationId: REL_A, desired: "disabled", state: "stopped" };
    }
  };
  const service = createEnrollmentRevocationService({ catalog, relationService, applyOverlay: async () => ({ applied: true }), now: () => NOW });
  const input = { operationId: "revop_0000000000000007", target: { kind: "relation", relationId: REL_A } };
  const pendingMutation = service.revoke(input);
  await disableStarted;
  const observed = await service.get(input.operationId);
  assert.equal(observed.status, "pending");
  assert.ok(observed.authorityRevokedAt);
  resolveDisable();
  assert.equal((await pendingMutation).status, "complete");
});

test("real relation manager inventory proves an absent relation before completing revoke", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-revocation-manager-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const manager = await openRelationManager({
    statePath: join(tempRoot, "manager-state.json"),
    withExclusiveLock: async (_scope, task) => task(),
    runtime: { async inspect() { return { state: "unknown", owned: false }; }, async stop() { return { ok: false }; } },
    durableWriter: {
      async write(request) {
        await writeFile(request.statePath, JSON.stringify(request.state), "utf8");
        return { outcome: "committed", stages: ["parent_fsync_returned"], expectedRevision: request.expectedRevision };
      }
    }
  });
  const inventory = await manager.query({ relationId: REL_A });
  assert.equal(inventory.source, "manager-state");
  assert.equal(inventory.state, "absent");
  assert.equal(inventory.desired, null);
  const catalog = fakeCatalog();
  const service = createEnrollmentRevocationService({ catalog, relationService: manager, applyOverlay: async () => ({ applied: true }), now: () => NOW });
  const result = await service.revoke({ operationId: "revop_0000000000000008", target: { kind: "relation", relationId: REL_A } });
  assert.equal(result.status, "complete");
  assert.equal(result.relations[0].state, "absent");
});

test("never-started and previously stopped relations complete from trusted manager inventory", async () => {
  const catalog = fakeCatalog();
  const relationService = manager({ stopped: new Set([REL_B]) });
  const service = createEnrollmentRevocationService({ catalog, relationService, applyOverlay: async () => ({ applied: true }), now: () => NOW });
  const result = await service.revoke({ operationId: "revop_0000000000000005", target: { kind: "relation", relationId: REL_A } });
  assert.equal(result.status, "complete");
  assert.equal(relationService.calls.some(([method]) => method === "disable"), false, "trusted absent inventory is an idempotent stopped proof");
  const alreadyStopped = await service.revoke({ operationId: "revop_0000000000000006", target: { kind: "relation", relationId: REL_B } });
  assert.equal(alreadyStopped.status, "complete");
  assert.equal(alreadyStopped.relations.find(item => item.relationId === REL_B).state, "stopped");
  assert.equal(relationService.calls.some(([method, id]) => method === "disable" && id === REL_B), false, "a stopped manager inventory from another op is reused");
});


