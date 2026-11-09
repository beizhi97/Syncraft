import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createEnrollmentAuthorityState, issueOneTimeEnrollmentCode, consumeOneTimeEnrollmentCode, grantEnrollmentBinding, revokeEnrollmentDevice } from "../src/core/enrollmentAuthority.js";
import { createEnrollmentIdentityId } from "../src/core/enrollmentProtocol.js";
import { canonicalJson } from "../src/core/enrollmentProtocol.js";
import { openRelationServiceBindingCatalog } from "../src/service/relationServiceBindingCatalog.js";
import { createSharedDirectoryService } from "../src/service/sharedDirectoryService.js";
import { normalizeDataAuthorizationPayload } from "../src/core/dataAuthorization.js";
import { applyEnrollmentDataOverlay, createEnrollmentDataAuthorization, enrollmentEd25519OpenSshKey, enrollmentSshFingerprint } from "../src/service/enrollmentDataAuthorization.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const SERVER_ID = "srv_0123456789abcdef";
const DEVICE_ID = "dev_0123456789abcdef";
const CHANNEL_REVISION = "chrev_0123456789abcdef";
const ROOT_ID = "root_0123456789abcdef";
const SHARE_ID = "shr_0123456789abcdef";
const RELATION_ID = "rel_0123456789abcdef";

function makeAuthority(devicePair) {
  const binding = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: { serverId: SERVER_ID, deviceId: DEVICE_ID, shareId: SHARE_ID, rootId: ROOT_ID, relationId: RELATION_ID },
    baselineEpoch: 1, channelRevision: CHANNEL_REVISION, credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: { source: "relation-catalog-root-sha256-v1", referenceId: `att_${"a".repeat(64)}`, attestedAt: new Date(NOW).toISOString() }
  };
  let authority = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issueOneTimeEnrollmentCode(authority, {
    requestId: "req_0123456789abcdef", deviceId: DEVICE_ID, channelRevision: CHANNEL_REVISION,
    publicKey: devicePair.publicKey, bindings: [binding], issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60000).toISOString()
  }, { expectedRevision: authority.revision, nowMs: NOW });
  authority = issued.nextState;
  const consumed = consumeOneTimeEnrollmentCode(authority, issued.code, {
    requestId: "req_0123456789abcdef", deviceId: DEVICE_ID, channelRevision: CHANNEL_REVISION,
    publicKey: devicePair.publicKey, bindings: [binding]
  }, { expectedRevision: authority.revision, nowMs: NOW });
  return { authority: consumed.nextState, binding: consumed.grant.bindings[0], grant: consumed.grant };
}

async function fixture(t, { revoked = false, noConsumedGrant = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sfsc-data-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const devicePair = generateKeyPairSync("ed25519");
  const enrolled = makeAuthority(devicePair);
  let authority = enrolled.authority;
  if (revoked) authority = revokeEnrollmentDevice(authority, { deviceId: DEVICE_ID }, { expectedRevision: authority.revision, nowMs: NOW }).nextState;
  const hostPair = generateKeyPairSync("ed25519");
  const hostPath = join(directory, "host-key.pem");
  await writeFile(hostPath, hostPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await chmod(hostPath, 0o600);
  let state = {
    revision: 0, authority,
    roots: { [ROOT_ID]: { rootId: ROOT_ID, shareId: SHARE_ID, status: "active", activatedAt: new Date(NOW).toISOString(), canonicalRoot: "/srv/private/backups" } },
    relations: {}, serverHostKey: { path: hostPath, publicKeySha256: createHash("sha256").update(createPublicKey(hostPair.privateKey).export({ format: "der", type: "spki" })).digest("hex") }
  };
  const catalog = {
    async read() { return structuredClone(state); },
    async update({ expectedRevision }, updater) {
      assert.equal(expectedRevision, state.revision);
      const next = structuredClone(state);
      await updater(next);
      next.revision += 1; state = next;
      return structuredClone(state);
    }
  };
  const grants = noConsumedGrant || revoked ? [] : [{ deviceId: DEVICE_ID, publicKeyJwk: authority.devices[DEVICE_ID].publicKeyJwk,
    publicKeyFingerprint: authority.devices[DEVICE_ID].publicKeyFingerprint, bindings: [enrolled.binding] }];
  let currentConfigSha256 = "";
  let tunnelState = { protocol: "vless-tcp-none", publicHost: "sync.example.test", publicPort: 443, transportPath: "", security: "none", transport: "tcp", restartRequired: false };
  const enrollmentService = {
    async listConsumedGrants() { return grants; },
    async getTrustMaterial() { return { serverId: SERVER_ID, keyId: "key_0123456789abcdef" }; }
  };
  const facade = { async query() { return { state: "running" }; }, async start() { throw new Error("unexpected start"); } };
  const module = createEnrollmentDataAuthorization({ catalog, enrollmentService, facade,
    registryPath: join(directory, "data-channel.json"), authorizedKeysDir: join(directory, "authorized-keys"), getBootstrapUuid: async () => "22222222-2222-4222-8222-222222222222",
    listenerPortStart: 24000, listenerPortEnd: 24010, getTunnel: async () => tunnelState,
    getCurrentConfigSha256: async () => currentConfigSha256, now: () => NOW });
  return { directory, module, catalog, devicePair, hostPair, enrolled, grants, getState: () => state,
    setCurrentConfigSha256(value) { currentConfigSha256 = value; }, setTunnel(value) { tunnelState = value; } };
}

test("consumed active grant materializes one loopback relation with device OpenSSH key and signed payload inputs", async t => {
  const f = await fixture(t);
  await f.module.initialize();
  const result = await f.module.materialize({ deviceId: DEVICE_ID, relationId: RELATION_ID });
  const relation = result.relation;
  assert.equal(relation.listener.host, "127.0.0.1");
  assert.equal(relation.listener.port, 24000);
  assert.equal(relation.authorization.sha256, createHash("sha256").update(`${enrollmentEd25519OpenSshKey(f.getState().authority.devices[DEVICE_ID].publicKeyJwk)}\n`).digest("hex"));
  assert.equal(await readFile(relation.authorization.authorizedKeysPath, "utf8"), `${enrollmentEd25519OpenSshKey(f.getState().authority.devices[DEVICE_ID].publicKeyJwk)}\n`);
  assert.notEqual(result.dataIdentity.uuid, "22222222-2222-4222-8222-222222222222");
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_channel_not_ready");
  const originalConfig = { inbounds: [{ type: "vless", tag: "vless-in", users: [] }], route: { rules: [], final: "direct" } };
  const overlaid = await f.module.applyOverlay(originalConfig);
  assert.equal(overlaid.inbounds[0].users[0].uuid, result.dataIdentity.uuid);
  const appliedDigest = createHash("sha256").update(JSON.stringify(overlaid, null, 2)).digest("hex");
  f.setCurrentConfigSha256(appliedDigest);
  await f.module.markApplied({ expectedConfigSha256: appliedDigest, restartResult: { ok: true, configSha256: appliedDigest } });
  assert.equal(await f.module.isApplied({ expectedConfigSha256: appliedDigest }), true);
  assert.equal(await f.module.isApplied({ expectedConfigSha256: "b".repeat(64) }), false);
  const { payload } = await f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID });
  assert.doesNotThrow(() => normalizeDataAuthorizationPayload(payload));
  assert.deepEqual(payload.binding, f.enrolled.binding);
  assert.equal(payload.sftp.user, "sfsc");
  assert.equal(payload.sftp.rootPath, "/");
  assert.notEqual(payload.serverHostKey.fingerprint, enrollmentSshFingerprint(createPublicKey(f.devicePair.privateKey).export({ format: "jwk" })));
  const hostWire = Buffer.from(payload.serverHostKey.publicKey.split(" ")[1], "base64");
  assert.equal(payload.serverHostKey.fingerprint, `SHA256:${createHash("sha256").update(hostWire).digest("base64").replace(/=+$/, "")}`);
  assert.equal(payload.displayName, "backups");
  assert.notEqual(payload.sftpDataChannel.connection.uri.match(/^vless:\/\/([^@]+)/)?.[1], "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.sftpDataChannel.channelRevision.startsWith("chrev_"), true);
  assert.equal(Object.hasOwn(payload, "privateKey"), false);
  f.setCurrentConfigSha256("c".repeat(64));
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_channel_not_ready");
  f.setCurrentConfigSha256(appliedDigest);
  f.setTunnel({ ...tunnelStateForTest(), publicHost: "changed.example.test" });
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_channel_not_ready");
  f.setTunnel(tunnelStateForTest());
  f.setTunnel({ ...tunnelStateForTest(), restartRequired: true });
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_channel_not_ready");
});

function tunnelStateForTest() {
  return { protocol: "vless-tcp-none", publicHost: "sync.example.test", publicPort: 443, transportPath: "", security: "none", transport: "tcp", restartRequired: false };
}

test("old overlay receipt cannot mark a relation added after its build as applied", async t => {
  const f = await fixture(t);
  await f.module.initialize();
  await f.module.materialize({ deviceId: DEVICE_ID, relationId: RELATION_ID });
  const base = { inbounds: [{ type: "vless", tag: "vless-in", users: [] }], route: { rules: [], final: "direct" } };
  const oldConfig = await f.module.applyOverlay(base);
  const oldDigest = createHash("sha256").update(JSON.stringify(oldConfig, null, 2)).digest("hex");
  await f.module.markApplied({ expectedConfigSha256: oldDigest, restartResult: { ok: true, configSha256: oldDigest } });

  const secondRelationId = "rel_1123456789abcdef";
  const secondBinding = { ...f.enrolled.binding, identity: { ...f.enrolled.binding.identity, relationId: secondRelationId }, credentialRevision: createEnrollmentIdentityId("credentialRevision") };
  const current = await f.catalog.read();
  const changed = grantEnrollmentBinding(current.authority, secondBinding, { expectedRevision: current.authority.revision, nowMs: NOW });
  await f.catalog.update({ expectedRevision: current.revision }, state => { state.authority = changed.nextState; });
  f.grants[0].bindings.push(secondBinding);
  await f.module.materialize({ deviceId: DEVICE_ID, relationId: secondRelationId });
  await f.module.markApplied({ expectedConfigSha256: oldDigest, restartResult: { ok: true, configSha256: oldDigest } });
  f.setCurrentConfigSha256(oldDigest);
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: secondRelationId }), error => error.code === "enrollment_data_channel_not_ready");

  const newConfig = await f.module.applyOverlay(base);
  const newDigest = createHash("sha256").update(JSON.stringify(newConfig, null, 2)).digest("hex");
  f.setCurrentConfigSha256(newDigest);
  await f.module.markApplied({ expectedConfigSha256: newDigest, restartResult: { ok: true, configSha256: newDigest } });
  const { payload } = await f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: secondRelationId });
  assert.equal(payload.sftp.port, 24001);
});

test("host key is re-read and checked against the catalog DER digest before signing material", async t => {
  const f = await fixture(t);
  await f.module.initialize();
  await f.module.materialize({ deviceId: DEVICE_ID, relationId: RELATION_ID });
  const config = await f.module.applyOverlay({ inbounds: [{ type: "vless", tag: "vless-in", users: [] }], route: { rules: [] } });
  const digest = createHash("sha256").update(JSON.stringify(config, null, 2)).digest("hex");
  f.setCurrentConfigSha256(digest);
  await f.module.markApplied({ expectedConfigSha256: digest, restartResult: { ok: true, configSha256: digest } });
  await writeFile(join(f.directory, "host-key.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  await assert.rejects(f.module.prepareDataAuthorization({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_host_key_invalid");
});

test("real directory catalog and consumed authority materialize a strict start snapshot", async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "sfsc-data-auth-real-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const dataDir = join(rootDir, "data", "relation-service");
  const selectedRoot = join(rootDir, "selected");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(selectedRoot, { mode: 0o700 });
  const catalogPath = join(dataDir, "catalog.json");
  const directoryService = createSharedDirectoryService({ catalogPath });
  const registered = await directoryService.register({ path: selectedRoot });
  const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  const current = await catalog.read();
  const devicePair = generateKeyPairSync("ed25519");
  const requestId = "req_1123456789abcdef";
  const deviceId = "dev_1123456789abcdef";
  const channelRevision = "chrev_1123456789abcdef";
  const relationId = "rel_1123456789abcdef";
  const rootRecord = current.roots[registered.rootId];
  const rootDigest = createHash("sha256").update(canonicalJson(rootRecord), "utf8").digest("hex");
  const binding = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: { serverId: current.authority.serverId, deviceId, shareId: rootRecord.shareId, rootId: rootRecord.rootId, relationId },
    baselineEpoch: 1, channelRevision, credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: { source: "relation-catalog-root-sha256-v1", referenceId: `att_${rootDigest}`, attestedAt: rootRecord.activatedAt }
  };
  const issued = issueOneTimeEnrollmentCode(current.authority, { requestId, deviceId, channelRevision,
    publicKey: devicePair.publicKey, bindings: [binding], issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60000).toISOString() },
  { expectedRevision: current.authority.revision, nowMs: NOW });
  const consumed = consumeOneTimeEnrollmentCode(issued.nextState, issued.code, { requestId, deviceId,
    channelRevision, publicKey: devicePair.publicKey, bindings: [binding] }, { expectedRevision: issued.nextState.revision, nowMs: NOW });
  await catalog.update({ expectedRevision: current.revision }, state => { state.authority = issued.nextState; });
  await catalog.update({ expectedRevision: current.revision + 1 }, state => { state.authority = consumed.nextState; });
  let facadeQueries = 0;
  const enrollmentService = {
    async listConsumedGrants() { const state = await catalog.read(); const device = state.authority.devices[deviceId]; return [{ deviceId,
      publicKeyJwk: device.publicKeyJwk, publicKeyFingerprint: device.publicKeyFingerprint, bindings: [binding] }]; },
    async getTrustMaterial() { const state = await catalog.read(); return { serverId: state.authority.serverId, keyId: "key_1123456789abcdef" }; }
  };
  const provisioner = createEnrollmentDataAuthorization({ catalog, enrollmentService,
    facade: { async query() { facadeQueries += 1; return { state: "absent" }; } },
    registryPath: join(dataDir, "data-channel.json"), authorizedKeysDir: join(dataDir, "authorized-keys"),
    getBootstrapUuid: async () => "33333333-3333-4333-8333-333333333333",
    getTunnel: async () => ({ publicHost: "sync.example.test", publicPort: 443, security: "none", transport: "tcp", restartRequired: false }),
    getCurrentConfigSha256: async () => "a".repeat(64), now: () => NOW });
  await provisioner.initialize();
  await provisioner.materialize({ deviceId, relationId });
  assert.equal(facadeQueries, 0, "materialization must not fabricate a runtime start receipt");
  const startSnapshot = await catalog.getForStart(relationId);
  assert.equal(startSnapshot.binding.identity.relationId, relationId);
  assert.equal(startSnapshot.listener.host, "127.0.0.1");
  assert.equal(startSnapshot.listener.port, 22000);
  assert.equal(startSnapshot.authorization.devicePublicKeyFingerprint, consumed.grant.publicKeyFingerprint);
  assert.equal(startSnapshot.directoryRoot.canonicalRoot, selectedRoot);
  const finalState = await catalog.read();
  assert.equal(startSnapshot.authorization.sha256, createHash("sha256").update(`${enrollmentEd25519OpenSshKey(finalState.authority.devices[deviceId].publicKeyJwk)}\n`).digest("hex"));
});

test("unconsumed or revoked devices cannot materialize or receive a payload", async t => {
  for (const options of [{ revoked: true }, { noConsumedGrant: true }]) {
    const f = await fixture(t, options);
    await f.module.initialize();
    await assert.rejects(f.module.materialize({ deviceId: DEVICE_ID, relationId: RELATION_ID }), error => error.code === "enrollment_data_authorization_denied");
    assert.equal(Object.keys(f.getState().relations).length, 0);
  }
});

test("data overlay adds a relation-scoped identity and exact loopback listener route followed by reject", () => {
  const config = { inbounds: [{ type: "vless", tag: "vless-in", users: [] }], route: { rules: [], final: "direct" } };
  const output = applyEnrollmentDataOverlay(config, { relations: [{ dataIdentity: { clientName: "sfsc-enrollment-data-0123456789abcdef01234567", uuid: "11111111-1111-4111-8111-111111111111" }, listener: { host: "127.0.0.1", port: 24000 } }] });
  assert.equal(config.inbounds[0].users.length, 0);
  assert.deepEqual(output.inbounds[0].users, [{ name: "sfsc-enrollment-data-0123456789abcdef01234567", uuid: "11111111-1111-4111-8111-111111111111" }]);
  assert.deepEqual(output.route.rules, [
    { inbound: ["vless-in"], auth_user: ["sfsc-enrollment-data-0123456789abcdef01234567"], ip_cidr: ["127.0.0.1/32"], port: [24000], action: "route", outbound: "direct" },
    { inbound: ["vless-in"], auth_user: ["sfsc-enrollment-data-0123456789abcdef01234567"], action: "reject" }
  ]);
});
