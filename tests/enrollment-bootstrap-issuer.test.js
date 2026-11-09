import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { decodeChannelImportCode } from "../src/core/channelImportCode.js";
import { createChannelConfigCode, decodeChannelConfigCode, verifyChannelConfigCode } from "../src/core/enrollmentProtocol.js";
import { buildSingboxServerConfig, createDefaultAdminState } from "../src/core/serverAdmin.js";
import { applyEnrollmentBootstrapOverlay, createEnrollmentBootstrapIssuer } from "../src/service/enrollmentBootstrapIssuer.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const SERVER_ID = "srv_0123456789abcdef";
const KEY_ID = "key_0123456789abcdef";
const GATEWAY_PORT = 18082;
const CONFIG_SHA256 = "a".repeat(64);

function tunnel(overrides = {}) {
  return {
    id: "vless-main", protocol: "vless-tcp-none", listenHost: "0.0.0.0", listenPort: 45678,
    publicHost: "sync.example.test", publicPort: 45678, security: "none", transport: "tcp",
    transportPath: "", remark: "syncraft", reality: {}, lastAppliedAt: new Date(NOW).toISOString(),
    restartRequired: false, ...overrides
  };
}

function serviceFake(overrides = {}) {
  const pair = generateKeyPairSync("ed25519");
  const exported = pair.publicKey.export({ format: "jwk" });
  const pin = {
    serverId: SERVER_ID,
    keyId: KEY_ID,
    publicKey: { kty: exported.kty, crv: exported.crv, x: exported.x },
    allowedBootstrapOrigins: [`http://127.0.0.1:${GATEWAY_PORT}`],
    bootstrapPathPrefix: "/api/enrollment/v1"
  };
  const revisions = [];
  return {
    revisions,
    pin,
    async setActiveChannelRevision(revision) { revisions.push(revision); },
    async issueChannelCode(input) {
      if (overrides.issueChannelCode) return overrides.issueChannelCode(input, { pair, pin });
      return {
        channelCode: createChannelConfigCode({
          serverId: SERVER_ID,
          channelRevision: input.channelRevision,
          connection: input.connection,
          bootstrap: input.bootstrap,
          expiresAt: input.expiresAt
        }, { signingKey: pair.privateKey, keyId: KEY_ID, nowMs: NOW }),
        pin
      };
    },
    pair
  };
}

test("bootstrap identity and current channel revision persist, and issuer signs wrapped inherited tunnel settings", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-bootstrap-issuer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, "sfsc-enrollment-bootstrap.json");
  const service = serviceFake();
  const issuer = createEnrollmentBootstrapIssuer({ registryPath, enrollmentService: service, now: () => NOW });
  const first = await issuer.initialize({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT });
  assert.equal(first.gatewayPort, GATEWAY_PORT);
  assert.match(first.uuid, /^[0-9a-f-]{36}$/i);
  assert.match(first.channelRevision, /^chrev_[A-Za-z0-9_-]{16,128}$/);
  await issuer.markApplied({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT,
    expectedConfigSha256: CONFIG_SHA256, restartResult: { ok: true, configSha256: CONFIG_SHA256 } });
  assert.equal(await issuer.isApplied({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: CONFIG_SHA256 }), true);
  assert.equal(await issuer.isApplied({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: "b".repeat(64) }), false);

  const issued = await issuer.issue({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: CONFIG_SHA256 });
  assert.equal(issued.bootstrapUser.uuid, first.uuid);
  assert.equal(issued.channelRevision, first.channelRevision);
  assert.equal(issued.bootstrap.endpoint, `http://127.0.0.1:${GATEWAY_PORT}/api/enrollment/v1`);
  assert.match(issued.connection.uri, new RegExp(`^vless://${first.uuid}@sync\\.example\\.test:45678\\?`));
  const verified = verifyChannelConfigCode(issued.channelCode, { trustedServerKeys: { [KEY_ID]: service.pin }, nowMs: NOW });
  assert.equal(verified.payload.channelRevision, first.channelRevision);
  assert.equal(verified.payload.connection.uri, issued.connection.uri);
  assert.equal(verified.payload.bootstrap.endpoint, issued.bootstrap.endpoint);
  assert.equal(decodeChannelConfigCode(issued.channelCode, { nowMs: NOW }).serverId, SERVER_ID);
  const wrapped = decodeChannelImportCode(issued.wrappedCode);
  assert.equal(wrapped.channelCode, issued.channelCode);
  assert.deepEqual(wrapped.pin, { ...service.pin, allowedBootstrapOrigins: [`http://127.0.0.1:${GATEWAY_PORT}`], bootstrapPathPrefix: "/api/enrollment/v1" });

  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.bootstrapUuid, first.uuid);
  assert.equal(stored.channelRevision, first.channelRevision);
  assert.equal(JSON.stringify(stored).includes("privateKey"), false);

  const restartedService = serviceFake();
  const restartedIssuer = createEnrollmentBootstrapIssuer({ registryPath, enrollmentService: restartedService, now: () => NOW });
  const restored = await restartedIssuer.initialize({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT });
  assert.equal(restored.uuid, first.uuid);
  assert.equal(restored.channelRevision, first.channelRevision);
  assert.deepEqual(restartedService.revisions, [first.channelRevision]);
});

test("tunnel or gateway change rotates channel revision but retains the independent bootstrap UUID", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-bootstrap-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = serviceFake();
  const issuer = createEnrollmentBootstrapIssuer({ registryPath: join(root, "registry.json"), enrollmentService: service, now: () => NOW });
  const initial = await issuer.initialize({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT });
  const changed = await issuer.current({ tunnel: tunnel({ publicPort: 45679 }), gatewayPort: GATEWAY_PORT });
  assert.equal(changed.uuid, initial.uuid);
  assert.notEqual(changed.channelRevision, initial.channelRevision);
  assert.equal(service.revisions.at(-1), changed.channelRevision);
});

test("issuer refuses to publish a channel before sing-box settings are applied or when pin origin differs", async t => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-bootstrap-not-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = serviceFake({ issueChannelCode: async (_input, { pair, pin }) => ({
    channelCode: "placeholder", pin: { ...pin, allowedBootstrapOrigins: ["https://wrong.example"] }
  }) });
  const issuer = createEnrollmentBootstrapIssuer({ registryPath: join(root, "registry.json"), enrollmentService: service, now: () => NOW });
  await issuer.initialize({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT });
  await assert.rejects(issuer.issue({ tunnel: tunnel({ restartRequired: true }), gatewayPort: GATEWAY_PORT }), error => error.code === "enrollment_channel_not_ready");
  await assert.rejects(issuer.issue({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: CONFIG_SHA256 }), error => error.code === "enrollment_channel_not_ready");
  await issuer.markApplied({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT,
    expectedConfigSha256: CONFIG_SHA256, restartResult: { ok: true, configSha256: CONFIG_SHA256 } });
  await assert.rejects(issuer.issue({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: "b".repeat(64) }), error => error.code === "enrollment_channel_not_ready");
  const issued = await issuer.issue({ tunnel: tunnel(), gatewayPort: GATEWAY_PORT, configSha256: CONFIG_SHA256 });
  assert.deepEqual(issued.pin.allowedBootstrapOrigins, [`http://127.0.0.1:${GATEWAY_PORT}`]);
  assert.equal(issued.pin.bootstrapPathPrefix, "/api/enrollment/v1");
});

test("sing-box overlay allows only the bootstrap identity to the gateway port and rejects its other destinations", () => {
  const bootstrapUser = { clientName: "sfsc-enrollment-bootstrap", uuid: "11111111-1111-4111-8111-111111111111" };
  const state = createDefaultAdminState({});
  state.users.push({ clientName: "admin", uuid: "22222222-2222-4222-8222-222222222222", enabled: true });
  const original = buildSingboxServerConfig(state);
  const output = applyEnrollmentBootstrapOverlay(original, { bootstrapUser, gatewayPort: GATEWAY_PORT });
  assert.equal(original.inbounds[0].users.length, 1);
  assert.deepEqual(output.inbounds[0].users.at(-1), { name: bootstrapUser.clientName, uuid: bootstrapUser.uuid });
  assert.deepEqual(output.route.rules, [
    { inbound: ["vless-in"], auth_user: [bootstrapUser.clientName], ip_cidr: ["127.0.0.1/32"], port: [GATEWAY_PORT], action: "route", outbound: "direct" },
    { inbound: ["vless-in"], auth_user: [bootstrapUser.clientName], action: "reject" }
  ]);
  assert.equal(output.route.final, "direct");
  assert.deepEqual(output.inbounds[0].users[0], { name: "admin", uuid: "22222222-2222-4222-8222-222222222222" });
});
