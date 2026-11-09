import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  createChannelConfigCode,
  createEnrollmentIdentityId,
  createOneTimeEnrollmentCode,
  generateEnrollmentSecret,
  normalizeEnrollmentBinding,
  canonicalJson,
  publicKeyFingerprint,
  signAuthorizationRequest,
  verifyAuthorizationRequestSignature,
  verifyChannelConfigCode
} from "../src/core/enrollmentProtocol.js";
import { encodeChannelImportCode, decodeChannelImportCode } from "../src/core/channelImportCode.js";
import { consumeEnrollmentCode, createEnrollmentIdentity, enrollmentChannelNeedsRenewal, importEnrollmentChannel, renewEnrollmentChannel, revalidateEnrollmentChannel, revalidateEnrollmentChannelForRenewal, requestDataAuthorization, submitEnrollmentRequest } from "../client/src/enrollmentSession.js";
import { readEnrollmentSession, saveEnrollmentSession } from "../client/src/store.js";
import { requestThroughSocks } from "../client/src/bootstrapTransport.js";
import { parseProtocolRequest, PROTOCOL_REQUESTS } from "../src/core/protocolSchemas.js";

test("channel import wrapper normalizes the OOB pin and verifies the signed channel", () => {
  const now = Date.now();
  const pair = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const channelRevision = createEnrollmentIdentityId("channelRevision");
  const publicKey = pair.publicKey.export({ format: "jwk" });
  const channelCode = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId, channelRevision,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    connection: { type: "vless", uri: "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@proxy.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: "https://sync.example.invalid/api/enrollment/v1", purpose: "identity-enrollment", expiresAt: new Date(now + 60_000).toISOString() }
  }, { signingKey: pair.privateKey, keyId, nowMs: now });
  const pin = { serverId, keyId, publicKey, allowedBootstrapOrigins: ["https://sync.example.invalid"], bootstrapPathPrefix: "/api/enrollment/v1" };
  const wrapped = encodeChannelImportCode({ channelCode, pin });
  const decoded = decodeChannelImportCode(wrapped);
  assert.equal(typeof decoded.pin.publicKey, "object");
  assert.equal(decoded.pin.publicKey.x, publicKey.x);
  assert.equal(importEnrollmentChannel(wrapped).trust.status, "verified");
  assert.throws(() => importEnrollmentChannel(encodeChannelImportCode({ channelCode, pin: { ...pin, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) } })), /signature|pin/i);
});

test("local enrollment request schemas whitelist code fields and require empty request body", () => {
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CHANNEL_IMPORT, {
    code: " SFSC-CHANNEL-IMPORT-V1:abc ", ignored: "discarded"
  }), { code: "SFSC-CHANNEL-IMPORT-V1:abc" });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_REQUEST, {}), {});
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CONSUME, { code: " code ", extra: true }), { code: "code" });
  assert.throws(() => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CONSUME, { code: [] }), { code: "validation_failed" });
  assert.throws(() => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_REQUEST, { requestId: "caller-controlled" }), { code: "validation_failed" });
});

test("enrollment request sends a durable-key proof over the exact JSON body bytes", async () => {
  const now = Date.now();
  const pair = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const channelRevision = createEnrollmentIdentityId("channelRevision");
  const code = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId, channelRevision,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    connection: { type: "vless", uri: "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@proxy.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: "https://sync.example.invalid/api/enrollment/v1", purpose: "identity-enrollment", expiresAt: new Date(now + 60_000).toISOString() }
  }, { signingKey: pair.privateKey, keyId, nowMs: now });
  const channel = importEnrollmentChannel(encodeChannelImportCode({
    channelCode: code,
    pin: { serverId, keyId, publicKey: pair.publicKey.export({ format: "jwk" }), allowedBootstrapOrigins: ["https://sync.example.invalid"], bootstrapPathPrefix: "/api/enrollment/v1" }
  }));
  const identity = createEnrollmentIdentity();
  const expectedRequestId = createEnrollmentIdentityId("requestId");
  let sent;
  const result = await submitEnrollmentRequest({
    channel,
    identity,
    requestState: { requestId: expectedRequestId },
    sendRequest: async (endpoint, path, bytes, headers) => {
      sent = { endpoint, path, bytes: Buffer.from(bytes), headers };
      const body = JSON.parse(bytes.toString("utf8"));
      return { status: 202, body: { requestId: body.requestId, deviceId: body.deviceId, publicKeyFingerprint: publicKeyFingerprint(identity.publicKey), status: "pending" } };
    }
  });
  const body = JSON.parse(sent.bytes.toString("utf8"));
  const proof = JSON.parse(Buffer.from(sent.headers["X-SFSC-Enrollment-Request"], "base64url").toString("utf8"));
  assert.equal(sent.path, "/api/enrollment/v1/requests");
  assert.equal(result.requestId, expectedRequestId);
  assert.equal(proof.bodySha256, createHash("sha256").update(sent.bytes).digest("hex"));
  const { signature, ...unsigned } = proof;
  const signedBytes = Buffer.from(canonicalJson({
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request-proof", method: "POST",
    path: sent.path, bodySha256: proof.bodySha256, deviceId: body.deviceId,
    requestId: body.requestId, channelRevision: body.channelRevision
  }));
  assert.equal(unsigned.kind, "enrollment-request-proof");
  assert.equal(verify(null, signedBytes, createPublicKey({ key: identity.publicKey, format: "jwk" }), Buffer.from(signature, "base64url")), true);
  assert.equal(publicKeyFingerprint(body.publicKey), publicKeyFingerprint(identity.publicKey));

  await assert.rejects(submitEnrollmentRequest({
    channel,
    identity,
    requestState: { requestId: expectedRequestId },
    sendRequest: async () => ({
      status: 503,
      body: { error: "enrollment_data_channel_not_ready", errorCode: "enrollment_data_channel_not_ready", message: "not ready" }
    })
  }), (error) => error.code === "enrollment_data_channel_not_ready");
});

test("enrollment data authorization preserves gateway errorCode shapes and legacy nested codes", async () => {
  const identity = createEnrollmentIdentity();
  const serverId = createEnrollmentIdentityId("serverId");
  const binding = normalizeEnrollmentBinding({
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: {
      serverId,
      deviceId: identity.deviceId,
      shareId: createEnrollmentIdentityId("shareId"),
      rootId: createEnrollmentIdentityId("rootId"),
      relationId: createEnrollmentIdentityId("relationId")
    },
    baselineEpoch: 1,
    channelRevision: createEnrollmentIdentityId("channelRevision"),
    credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: {
      source: "admin",
      referenceId: createEnrollmentIdentityId("rootAttestation"),
      attestedAt: new Date().toISOString()
    }
  });
  const channel = {
    bootstrapEndpoint: "https://sync.example.invalid/api/enrollment/v1",
    pin: { serverId },
    channel: { channelRevision: binding.channelRevision }
  };
  const responses = [
    {
      status: 503,
      body: { error: "enrollment_data_relation_not_ready", errorCode: "enrollment_data_relation_not_ready", message: "not ready" },
      expectedCode: "enrollment_data_relation_not_ready"
    },
    {
      status: 403,
      body: { error: "enrollment_relation_revoked", errorCode: "enrollment_relation_revoked", message: "revoked" },
      expectedCode: "enrollment_relation_revoked"
    },
    {
      status: 503,
      body: { error: { code: "enrollment_data_channel_not_ready" } },
      expectedCode: "enrollment_data_channel_not_ready"
    },
    {
      status: 503,
      body: { error: "untrusted arbitrary text", errorCode: "unknown_error_code" },
      expectedCode: "enrollment_relation_denied"
    }
  ];

  for (const response of responses) {
    await assert.rejects(requestDataAuthorization({
      channel,
      identity,
      binding,
      sendRequest: async () => response
    }), (error) => error.code === response.expectedCode);
  }
});

test("enrollment consumption requires the current binding and a pinned signed receipt", async () => {
  const now = Date.now();
  const signer = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const channelRevision = createEnrollmentIdentityId("channelRevision");
  const identity = createEnrollmentIdentity();
  const requestId = createEnrollmentIdentityId("requestId");
  const timestamp = new Date(now).toISOString();
  const binding = normalizeEnrollmentBinding({
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: {
      serverId, deviceId: identity.deviceId,
      shareId: createEnrollmentIdentityId("shareId"),
      rootId: createEnrollmentIdentityId("rootId"),
      relationId: createEnrollmentIdentityId("relationId")
    },
    baselineEpoch: 1,
    channelRevision,
    credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: { source: "admin", referenceId: createEnrollmentIdentityId("rootAttestation"), attestedAt: timestamp }
  });
  const channelCode = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId, channelRevision,
    issuedAt: timestamp, expiresAt: new Date(now + 60_000).toISOString(),
    connection: { type: "vless", uri: "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@proxy.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: "https://sync.example.invalid/api/enrollment/v1", purpose: "identity-enrollment", expiresAt: new Date(now + 60_000).toISOString() }
  }, { signingKey: signer.privateKey, keyId, nowMs: now });
  const channel = importEnrollmentChannel(encodeChannelImportCode({
    channelCode,
    pin: { serverId, keyId, publicKey: signer.publicKey.export({ format: "jwk" }), allowedBootstrapOrigins: ["https://sync.example.invalid"], bootstrapPathPrefix: "/api/enrollment/v1" }
  }));
  const code = createOneTimeEnrollmentCode({
    protocol: "sfsc-enrollment", version: 1, kind: "device-enrollment",
    enrollmentId: createEnrollmentIdentityId("enrollmentId"), requestId, serverId,
    deviceId: identity.deviceId, channelRevision,
    publicKeyFingerprint: publicKeyFingerprint(identity.publicKey), bindings: [binding],
    issuedAt: timestamp, expiresAt: new Date(now + 60_000).toISOString(), secret: generateEnrollmentSecret()
  }, { nowMs: now });
  await assert.rejects(consumeEnrollmentCode({
    channel,
    identity,
    requestState: { requestId, status: "pending" },
    code,
    sendRequest: async () => ({
      status: 403,
      body: { error: "enrollment_relation_revoked", errorCode: "enrollment_relation_revoked", message: "revoked" }
    })
  }), (error) => error.code === "enrollment_relation_revoked");
  const grant = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-grant", requestId, serverId,
    deviceId: identity.deviceId, publicKeyFingerprint: publicKeyFingerprint(identity.publicKey),
    enrolledAt: timestamp, bindings: [binding]
  };
  const bodyBytes = Buffer.from(JSON.stringify({ code }), "utf8");
  const unsignedReceipt = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-consumption-receipt", requestId,
    bodySha256: createHash("sha256").update(bodyBytes).digest("hex"), grant, signingKeyId: keyId
  };
  const signature = sign(null, Buffer.from(canonicalJson(unsignedReceipt)), signer.privateKey).toString("base64url");
  const receipt = { ...unsignedReceipt, signature };
  let auth;
  const result = await consumeEnrollmentCode({
    channel, identity, requestState: { requestId, status: "pending" }, code,
    sendRequest: async (_endpoint, path, bytes, headers) => {
      auth = JSON.parse(Buffer.from(headers["X-SFSC-Authorization"], "base64url").toString("utf8"));
      assert.equal(path, "/api/enrollment/v1/consume");
      assert.deepEqual(bytes, bodyBytes);
      return { status: 200, body: { grant, receipt } };
    }
  });
  assert.equal(auth.binding.identity.relationId, binding.identity.relationId);
  assert.equal(auth.bodySha256, unsignedReceipt.bodySha256);
  assert.equal(result.status, "identity-verified-awaiting-directory-authorization");
});

test("expired trusted channel renews with fresh nonce and keeps the consumed binding and local sync state", async (t) => {
  const now = Date.now();
  const signer = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const originalBindingRevision = createEnrollmentIdentityId("channelRevision");
  const currentTransportRevision = createEnrollmentIdentityId("channelRevision");
  const identity = createEnrollmentIdentity();
  const requestId = createEnrollmentIdentityId("requestId");
  const pin = {
    serverId,
    keyId,
    publicKey: signer.publicKey.export({ format: "jwk" }),
    allowedBootstrapOrigins: ["https://sync.example.invalid"],
    bootstrapPathPrefix: "/api/enrollment/v1"
  };
  const binding = normalizeEnrollmentBinding({
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: {
      serverId, deviceId: identity.deviceId,
      shareId: createEnrollmentIdentityId("shareId"),
      rootId: createEnrollmentIdentityId("rootId"),
      relationId: createEnrollmentIdentityId("relationId")
    },
    baselineEpoch: 7,
    channelRevision: originalBindingRevision,
    credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: {
      source: "admin", referenceId: createEnrollmentIdentityId("rootAttestation"),
      attestedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString()
    }
  });
  const expiredIssuedAt = now - 25 * 60 * 60 * 1000;
  const expiredAt = now - 60 * 60 * 1000;
  const oldChannelCode = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId,
    channelRevision: currentTransportRevision,
    issuedAt: new Date(expiredIssuedAt).toISOString(), expiresAt: new Date(expiredAt).toISOString(),
    connection: { type: "vless", uri: "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@proxy.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: "https://sync.example.invalid/api/enrollment/v1", purpose: "identity-enrollment", expiresAt: new Date(expiredAt).toISOString() }
  }, { signingKey: signer.privateKey, keyId, nowMs: expiredIssuedAt });
  const oldChannel = verifyChannelConfigCode(oldChannelCode, {
    nowMs: expiredIssuedAt,
    trustedServerKeys: { [keyId]: pin }
  }).payload;
  const bootstrapEndpoint = "https://sync.example.invalid/api/enrollment/v1";
  const grant = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-grant", requestId,
    serverId, deviceId: identity.deviceId,
    publicKeyFingerprint: publicKeyFingerprint(identity.publicKey),
    enrolledAt: new Date(expiredIssuedAt).toISOString(),
    bindings: [binding]
  };
  const unsignedReceipt = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-consumption-receipt", requestId,
    bodySha256: "a".repeat(64), grant, signingKeyId: keyId
  };
  const receipt = {
    ...unsignedReceipt,
    signature: sign(null, Buffer.from(canonicalJson(unsignedReceipt)), signer.privateKey).toString("base64url")
  };
  const serverState = {
    pin,
    channel: oldChannel,
    channelCode: oldChannelCode,
    bootstrapEndpoint,
    phase: "identity-verified-awaiting-directory-authorization",
    trustFingerprint: publicKeyFingerprint(pin.publicKey),
    request: {
      requestId,
      deviceId: identity.deviceId,
      publicKeyFingerprint: publicKeyFingerprint(identity.publicKey),
      status: "consumed"
    },
    receipt,
    dataAuthorizations: {}
  };
  assert.equal(enrollmentChannelNeedsRenewal(serverState, now), true);
  assert.throws(() => revalidateEnrollmentChannel(serverState), { code: "enrollment_channel_expired" });
  assert.equal(revalidateEnrollmentChannelForRenewal(serverState).channelRevision, currentTransportRevision);

  const renewedCode = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId,
    channelRevision: currentTransportRevision,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    connection: { type: "vless", uri: "vless://123e4567-e89b-42d3-a456-426614174001@renewed.sync.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: bootstrapEndpoint, purpose: "identity-enrollment", expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString() }
  }, { signingKey: signer.privateKey, keyId, nowMs: now });
  const wrappedCode = encodeChannelImportCode({ channelCode: renewedCode, pin });
  const renewalPayload = {
    protocol: "sfsc-enrollment", version: 1, kind: "channel-renewal",
    serverId, keyId, deviceId: identity.deviceId,
    channelRevision: currentTransportRevision, wrappedCode
  };
  const renewalEnvelope = {
    payload: renewalPayload,
    signature: sign(null, Buffer.from(canonicalJson(renewalPayload)), signer.privateKey).toString("base64url")
  };
  const seenNonces = [];
  let renewalCalls = 0;
  const renewed = await renewEnrollmentChannel({
    serverState,
    identity,
    nowMs: now,
    sendRequest: async (endpoint, path, bytes, headers) => {
      renewalCalls += 1;
      assert.equal(endpoint, bootstrapEndpoint);
      assert.equal(path, "/api/enrollment/v1/channel-renewal");
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), { channelRevision: currentTransportRevision });
      const proof = JSON.parse(Buffer.from(headers["X-SFSC-Authorization"], "base64url").toString("utf8"));
      const verifiedProof = verifyAuthorizationRequestSignature(proof, identity.publicKey);
      assert.equal(verifiedProof.binding.channelRevision, originalBindingRevision);
      assert.equal(verifiedProof.path, path);
      seenNonces.push(verifiedProof.nonce);
      if (renewalCalls === 1) {
        const lostResponse = { ...renewalEnvelope };
        assert.equal(verify(null, Buffer.from(canonicalJson(lostResponse.payload)), signer.publicKey, Buffer.from(lostResponse.signature, "base64url")), true);
        throw Object.assign(new Error("connection closed after request processing"), { code: "enrollment_transport_failed" });
      }
      return { status: 200, body: renewalEnvelope };
    }
  });
  assert.equal(renewalCalls, 2);
  assert.equal(new Set(seenNonces).size, 2, "retry must sign a fresh nonce after a lost response");
  assert.equal(renewed.channel.channelRevision, currentTransportRevision);
  assert.notEqual(renewed.channel.channelRevision, binding.channelRevision, "transport revision may advance independently from the consumed binding");
  assert.equal(renewed.pin.keyId, pin.keyId);

  await assert.rejects(renewEnrollmentChannel({
    serverState,
    identity,
    nowMs: now,
    sendRequest: async () => { throw Object.assign(new Error("revoked"), { code: "enrollment_relation_revoked" }); }
  }), (error) => error.code === "enrollment_relation_revoked");
  let invalidSignatureAttempts = 0;
  await assert.rejects(renewEnrollmentChannel({
    serverState,
    identity,
    nowMs: now,
    sendRequest: async () => {
      invalidSignatureAttempts += 1;
      return { status: 200, body: { ...renewalEnvelope, signature: "A".repeat(86) } };
    }
  }), (error) => error.code === "enrollment_trust_failed");
  assert.equal(invalidSignatureAttempts, 1, "a signature verification failure must not be retried");

  const sentDataAuthorization = await requestDataAuthorization({
    channel: { ...serverState, ...renewed },
    identity,
    binding,
    nowMs: now,
    sendRequest: async (_endpoint, path, _bytes, headers) => {
      const proof = JSON.parse(Buffer.from(headers["X-SFSC-Authorization"], "base64url").toString("utf8"));
      const verifiedProof = verifyAuthorizationRequestSignature(proof, identity.publicKey);
      assert.equal(path, "/api/enrollment/v1/data-authorization");
      assert.equal(verifiedProof.binding.channelRevision, originalBindingRevision);
      return { status: 403, body: { errorCode: "enrollment_relation_revoked" } };
    }
  }).catch((error) => error);
  assert.equal(sentDataAuthorization.code, "enrollment_relation_revoked", "current transport revision must not rewrite the original data binding");

  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-renewal-persist-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const paths = {
    enrollmentFile: join(tempRoot, "enrollment-session.json"),
    jobsFile: join(tempRoot, "jobs.json")
  };
  const jobs = [{ id: "job-preserve-baseline", relationId: binding.identity.relationId, baselineId: "baseline-kept", baselineEpoch: 7 }];
  await writeFile(paths.jobsFile, JSON.stringify(jobs), "utf8");
  const session = {
    version: 1, activeServerId: serverId, identity,
    servers: { [serverId]: { ...serverState, ...renewed } }
  };
  await saveEnrollmentSession(session, paths);
  const reloadedAfterRestart = await readEnrollmentSession(paths);
  assert.deepEqual(reloadedAfterRestart.identity, identity);
  assert.deepEqual(reloadedAfterRestart.servers[serverId].receipt, receipt);
  assert.deepEqual(reloadedAfterRestart.servers[serverId].receipt.grant.bindings, [binding]);
  assert.equal(reloadedAfterRestart.servers[serverId].channel.channelRevision, currentTransportRevision);
  assert.deepEqual(JSON.parse(await readFile(paths.jobsFile, "utf8")), jobs);
});

test("local HTTP enrollment route refuses to proceed before a verified channel exists", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-api-"));
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("client/src/clientServer.js")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      PATH: process.env.PATH || "",
      SystemRoot: process.env.SystemRoot || "",
      WINDIR: process.env.WINDIR || "",
      TEMP: process.env.TEMP || tmpdir(),
      TMP: process.env.TMP || tmpdir(),
      LOCALAPPDATA: dataRoot,
      SFSC_CLIENT_DATA_ROOT: dataRoot,
      SFSC_TEST_ALLOW_UNSAFE_PATHS: "1",
      PORT: String(port)
    }
  });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    }
    await rm(dataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(health?.ok, true, "client local API should start for the isolated test directory");
  const status = await fetch(`${base}/api/enrollment/session`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).phase, "not-started");
  const response = await fetch(`${base}/api/enrollment/request`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: "{}"
  });
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.equal(result.errorCode, "enrollment_channel_invalid");
  await writeFile(join(dataRoot, "enrollment-session.json"), "{", "utf8");
  const corruptStatus = await fetch(`${base}/api/enrollment/session`);
  assert.equal((await corruptStatus.json()).phase, "local-state-error");
  const blocked = await fetch(`${base}/api/enrollment/request`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).errorCode, "local_state_corrupt");
});

test("local HTTP enrollment import persists a signed URI-shaped channel code", async (t) => {
  const now = Date.now();
  const signingKey = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const channelCode = createChannelConfigCode({
    protocol: "sfsc-enrollment", version: 1, kind: "channel-config", serverId,
    channelRevision: createEnrollmentIdentityId("channelRevision"),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    connection: { type: "vless", uri: "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@proxy.example.invalid:443?encryption=none&security=none&type=tcp" },
    bootstrap: { endpoint: "https://sync.example.invalid/api/enrollment/v1", purpose: "identity-enrollment", expiresAt: new Date(now + 60_000).toISOString() }
  }, { signingKey: signingKey.privateKey, keyId, nowMs: now });
  assert.ok(channelCode.startsWith("sfsc://channel/v1#"));
  const code = encodeChannelImportCode({
    channelCode,
    pin: {
      serverId,
      keyId,
      publicKey: signingKey.publicKey.export({ format: "jwk" }),
      allowedBootstrapOrigins: ["https://sync.example.invalid"],
      bootstrapPathPrefix: "/api/enrollment/v1"
    }
  });
  const dataRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-import-http-"));
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("client/src/clientServer.js")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      PATH: process.env.PATH || "",
      SystemRoot: process.env.SystemRoot || "",
      WINDIR: process.env.WINDIR || "",
      TEMP: process.env.TEMP || tmpdir(),
      TMP: process.env.TMP || tmpdir(),
      LOCALAPPDATA: dataRoot,
      SFSC_CLIENT_DATA_ROOT: dataRoot,
      SFSC_TEST_ALLOW_UNSAFE_PATHS: "1",
      PORT: String(port)
    }
  });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    }
    await rm(dataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { health = await fetch(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(health?.ok, true, "client local API should start for the isolated test directory");
  const response = await fetch(`${base}/api/enrollment/channel/import`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.phase, "channel-verified");
  assert.equal(imported.serverId, serverId);
  const status = await fetch(`${base}/api/enrollment/session`);
  assert.equal(status.status, 200);
  const sessionStatus = await status.json();
  assert.equal(sessionStatus.phase, "channel-verified");
  assert.equal(sessionStatus.serverId, serverId);
  const persisted = JSON.parse(await readFile(join(dataRoot, "enrollment-session.json"), "utf8"));
  assert.equal(persisted.activeServerId, serverId);
  assert.equal(persisted.servers[serverId].channelCode, channelCode);
});

test("bootstrap HTTP request traverses a real local SOCKS5 relay and awaits delayed response", async (t) => {
  let observed;
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      observed = { method: req.method, path: req.url, proof: req.headers["x-test-proof"], body };
      setTimeout(() => {
        res.writeHead(202, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ accepted: true, body }));
      }, 40);
    });
  });
  const targetPort = await listen(target);
  const relay = createSocksRelay(targetPort);
  const relayPort = await listen(relay);
  t.after(async () => {
    await closeServer(target);
    await closeServer(relay);
  });
  const requestBody = Buffer.from('{"probe":"delayed"}');
  const response = await requestThroughSocks(
    `http://127.0.0.1:${targetPort}`,
    "/api/enrollment/v1/requests",
    requestBody,
    { "X-Test-Proof": "signed" },
    { host: "127.0.0.1", port: relayPort }
  );
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { accepted: true, body: requestBody.toString("utf8") });
  assert.deepEqual(observed, {
    method: "POST", path: "/api/enrollment/v1/requests", proof: "signed", body: requestBody.toString("utf8")
  });
});

test("bootstrap transport treats zero-byte HTTP EOF as a retryable disconnect but preserves malformed-response errors", async (t) => {
  const closedTarget = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.socket.destroy());
  });
  const closedTargetPort = await listen(closedTarget);
  const closedRelay = createSocksRelay(closedTargetPort);
  const closedRelayPort = await listen(closedRelay);

  const malformedTarget = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("not an HTTP response\r\n\r\n");
    });
  });
  const malformedTargetPort = await listen(malformedTarget);
  const malformedRelay = createSocksRelay(malformedTargetPort);
  const malformedRelayPort = await listen(malformedRelay);
  t.after(async () => {
    await Promise.all([closedTarget, closedRelay, malformedTarget, malformedRelay].map(closeServer));
  });

  await assert.rejects(requestThroughSocks(
    `http://127.0.0.1:${closedTargetPort}`,
    "/api/enrollment/v1/data-authorization",
    Buffer.from("{}"),
    {},
    { host: "127.0.0.1", port: closedRelayPort }
  ), (error) => error.code === "enrollment_transport_failed");

  await assert.rejects(requestThroughSocks(
    `http://127.0.0.1:${malformedTargetPort}`,
    "/api/enrollment/v1/data-authorization",
    Buffer.from("{}"),
    {},
    { host: "127.0.0.1", port: malformedRelayPort }
  ), (error) => error.code === "enrollment_response_invalid");
});

function createSocksRelay(targetPort) {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    client.on("data", function onClientData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 3) return;
        assert.deepEqual([...buffer.subarray(0, 3)], [5, 1, 0]);
        buffer = buffer.subarray(3);
        client.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (buffer.length < 10) return;
        const version = buffer[0]; const command = buffer[1]; const addressType = buffer[3];
        assert.equal(version, 5); assert.equal(command, 1); assert.equal(addressType, 1);
        const host = [...buffer.subarray(4, 8)].join(".");
        const destinationPort = buffer.readUInt16BE(8);
        buffer = buffer.subarray(10);
        assert.equal(host, "127.0.0.1"); assert.equal(destinationPort, targetPort);
        const upstream = net.createConnection({ host, port: destinationPort }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.off("data", onClientData);
          client.pipe(upstream); upstream.pipe(client);
          if (buffer.length) upstream.write(buffer);
        });
        upstream.on("error", () => client.destroy());
      }
    });
  });
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = listener.address().port;
  await new Promise((resolvePromise) => listener.close(resolvePromise));
  return port;
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
