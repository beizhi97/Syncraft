import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  createEnrollmentIdentityId,
  publicKeyFingerprint
} from "../src/core/enrollmentProtocol.js";
import {
  normalizeDataAuthorizationPayload,
  signDataAuthorizationPayload,
  verifyDataAuthorizationEnvelope
} from "../src/core/dataAuthorization.js";
import { canonicalJson } from "../src/core/enrollmentProtocol.js";

test("data authorization signs and verifies the exact normalized payload against the pinned key", () => {
  const fixture = createFixture();
  const envelope = signDataAuthorizationPayload(fixture.payload, fixture.serverKey.privateKey);

  const verified = verifyDataAuthorizationEnvelope(envelope, fixture.pin, {
    deviceId: fixture.payload.deviceId,
    publicKey: fixture.deviceKey.publicKey,
    relationId: fixture.payload.binding.identity.relationId,
    binding: fixture.payload.binding,
    bootstrapUri: "vless://123e4567-e89b-42d3-a456-426614174000@sync.example.invalid:443?security=tls"
  }, { nowMs: Date.parse("2026-10-29T12:00:00.000Z") });

  assert.deepEqual(verified, normalizeDataAuthorizationPayload(fixture.payload));
  assert.equal(envelope.payload.sftp.rootPath, "/");
});

test("data authorization rejects unsigned changes, wrong pins, bootstrap credential reuse, and untrusted host keys", () => {
  const fixture = createFixture();
  const envelope = signDataAuthorizationPayload(fixture.payload, fixture.serverKey.privateKey);

  assert.throws(() => verifyDataAuthorizationEnvelope({
    ...envelope,
    payload: { ...envelope.payload, displayName: "different" }
  }, fixture.pin, {}, { nowMs: Date.parse("2026-10-29T12:00:00.000Z") }), /signature/i);
  assert.throws(() => verifyDataAuthorizationEnvelope(envelope, {
    ...fixture.pin,
    keyId: createEnrollmentIdentityId("signingKeyId")
  }, {}, { nowMs: Date.parse("2026-10-29T12:00:00.000Z") }), /pinned server/i);
  assert.throws(() => verifyDataAuthorizationEnvelope(envelope, fixture.pin, {
    bootstrapUri: fixture.payload.sftpDataChannel.connection.uri
  }, { nowMs: Date.parse("2026-10-29T12:00:00.000Z") }), /bootstrap VLESS credential/i);

  const badHostKey = {
    ...fixture.payload,
    serverHostKey: { ...fixture.payload.serverHostKey, fingerprint: "SHA256:" + "A".repeat(43) }
  };
  assert.throws(() => normalizeDataAuthorizationPayload(badHostKey), /fingerprint/i);
  const injectedHostKey = {
    ...fixture.payload,
    serverHostKey: {
      ...fixture.payload.serverHostKey,
      publicKey: `${fixture.payload.serverHostKey.publicKey}\nssh-ed25519 ${fixture.payload.serverHostKey.publicKey.split(" ")[1]}`
    }
  };
  assert.throws(() => normalizeDataAuthorizationPayload(injectedHostKey), /single line/i);

  const nonCanonicalPayload = {
    ...envelope.payload,
    serverHostKey: {
      ...envelope.payload.serverHostKey,
      publicKey: envelope.payload.serverHostKey.publicKey.replace(" ", "  ")
    }
  };
  const ambiguousEnvelope = {
    payload: nonCanonicalPayload,
    signature: sign(null, Buffer.from(canonicalJson(nonCanonicalPayload), "utf8"), fixture.serverKey.privateKey).toString("base64url")
  };
  assert.throws(() => verifyDataAuthorizationEnvelope(ambiguousEnvelope, fixture.pin, {}, {
    nowMs: Date.parse("2026-10-29T12:00:00.000Z")
  }), (error) => error.code === "data_authorization_invalid");
});

function createFixture() {
  const serverKey = generateKeyPairSync("ed25519");
  const deviceKey = generateKeyPairSync("ed25519");
  const hostKey = generateKeyPairSync("ed25519");
  const serverId = createEnrollmentIdentityId("serverId");
  const deviceId = createEnrollmentIdentityId("deviceId");
  const keyId = createEnrollmentIdentityId("signingKeyId");
  const binding = {
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-binding",
    identity: {
      serverId,
      deviceId,
      shareId: createEnrollmentIdentityId("shareId"),
      rootId: createEnrollmentIdentityId("rootId"),
      relationId: createEnrollmentIdentityId("relationId")
    },
    baselineEpoch: 1,
    channelRevision: createEnrollmentIdentityId("channelRevision"),
    credentialRevision: createEnrollmentIdentityId("credentialRevision"),
    rootAttestation: {
      source: "administrator-approved",
      referenceId: createEnrollmentIdentityId("rootAttestation"),
      attestedAt: "2026-10-29T11:00:00.000Z"
    }
  };
  const hostPublicBytes = Buffer.from(hostKey.publicKey.export({ format: "jwk" }).x, "base64url");
  const hostKeyBlob = Buffer.concat([
    sshString(Buffer.from("ssh-ed25519", "ascii")),
    sshString(hostPublicBytes)
  ]);
  const hostFingerprint = `SHA256:${createHash("sha256").update(hostKeyBlob).digest("base64").replace(/=+$/, "")}`;
  const payload = {
    protocol: "sfsc-data-authorization",
    version: 1,
    kind: "data-authorization",
    serverId,
    keyId,
    deviceId,
    publicKeyFingerprint: publicKeyFingerprint(deviceKey.publicKey),
    binding,
    authorization: { directions: ["bidirectional"], allowDelete: true },
    displayName: "Documents",
    sftp: { host: "127.0.0.1", port: 2222, user: "sfsc", rootPath: "/" },
    serverHostKey: { publicKey: `ssh-ed25519 ${hostKeyBlob.toString("base64")} sfsc`, fingerprint: hostFingerprint },
    sftpDataChannel: {
      channelRevision: createEnrollmentIdentityId("channelRevision"),
      connection: { type: "vless", uri: "vless://123e4567-e89b-42d3-a456-426614174001@sync.example.invalid:443?security=tls#data" }
    },
    issuedAt: "2026-10-29T11:55:00.000Z",
    expiresAt: "2026-10-29T12:05:00.000Z"
  };
  return {
    payload,
    serverKey,
    deviceKey,
    pin: {
      serverId,
      keyId,
      publicKey: serverKey.publicKey.export({ format: "jwk" })
    }
  };
}

function sshString(value) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}
