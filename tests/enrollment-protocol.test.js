import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHANNEL_CONFIG_URI_PREFIX,
  DEVICE_ENROLLMENT_URI_PREFIX,
  ENROLLMENT_PROTOCOL_NAME,
  ENROLLMENT_PROTOCOL_VERSION,
  EnrollmentProtocolError,
  canonicalJson,
  createChannelConfigCode,
  createEnrollmentKeyPair,
  decodeChannelConfigCode,
  decodeOneTimeEnrollmentCode,
  normalizeEnrollmentBinding,
  publicKeyFingerprint,
  sha256Bytes,
  signAuthorizationRequest,
  verifyChannelConfigCode,
  verifyAuthorizationRequestSignature
} from "../src/core/enrollmentProtocol.js";
import {
  ENROLLMENT_STATE_STORAGE_CONTRACT,
  assertEnrollmentStateTransition,
  consumeOneTimeEnrollmentCode,
  createEnrollmentAuthorityState,
  grantEnrollmentBinding,
  issueOneTimeEnrollmentCode,
  revokeEnrollmentDevice,
  revokeEnrollmentRelation,
  verifySignedAuthorizationRequest
} from "../src/core/enrollmentAuthority.js";
import {
  PROFILE_URI_PREFIX,
  PROFILE_VERSION,
  SUPPORTED_PROFILE_VERSIONS
} from "../src/core/profileProtocol.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const SERVER_ID = "srv_0123456789abcdef";
const OTHER_SERVER_ID = "srv_fedcba9876543210";
const DEVICE_ID = "dev_0123456789abcdef";
const OTHER_DEVICE_ID = "dev_fedcba9876543210";
const CHANNEL_REVISION = "chrev_0123456789abcdef";
const CREDENTIAL_REVISION = "cred_0123456789abcdef";
const SHARE_ID = "shr_0123456789abcdef";
const ROOT_ID = "root_0123456789abcdef";
const RELATION_ID = "rel_0123456789abcdef";
const SECOND_SHARE_ID = "shr_fedcba9876543210";
const SECOND_ROOT_ID = "root_fedcba9876543210";
const SECOND_RELATION_ID = "rel_fedcba9876543210";
const REQUEST_ID = "req_0123456789abcdef";
const ATTESTATION_ID = "att_0123456789abcdef";
const VLESS_URI =
  "vless://11111111-1111-4111-8111-111111111111@sync.example.test:443?type=tcp&security=reality&pbk=public-key&sid=01234567#sfsc";

const pair = createEnrollmentKeyPair();
const otherPair = createEnrollmentKeyPair();
const channelPair = createEnrollmentKeyPair();
const CHANNEL_KEY_ID = "key_0123456789abcdef";

function binding(overrides = {}) {
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "enrollment-binding",
    identity: {
      serverId: overrides.serverId ?? SERVER_ID,
      deviceId: overrides.deviceId ?? DEVICE_ID,
      shareId: overrides.shareId ?? SHARE_ID,
      rootId: overrides.rootId ?? ROOT_ID,
      relationId: overrides.relationId ?? RELATION_ID
    },
    baselineEpoch: overrides.baselineEpoch ?? 7,
    channelRevision: overrides.channelRevision ?? CHANNEL_REVISION,
    credentialRevision: overrides.credentialRevision ?? CREDENTIAL_REVISION,
    rootAttestation: {
      source: overrides.attestationSource ?? "server-enrollment-record",
      referenceId: overrides.attestationId ?? ATTESTATION_ID,
      attestedAt: overrides.attestedAt ?? new Date(NOW - 60_000).toISOString()
    }
  };
}

function secondBinding(overrides = {}) {
  return binding({
    shareId: SECOND_SHARE_ID,
    rootId: SECOND_ROOT_ID,
    relationId: SECOND_RELATION_ID,
    attestationId: "att_fedcba9876543210",
    ...overrides
  });
}

function channelInput(overrides = {}) {
  return {
    serverId: SERVER_ID,
    channelRevision: CHANNEL_REVISION,
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
    connection: { type: "vless", uri: VLESS_URI },
    bootstrap: {
      endpoint: "https://sync.example.test/api/enrollment/v1/challenge",
      purpose: "identity-enrollment",
      expiresAt: new Date(NOW + 15 * 60 * 1000).toISOString()
    },
    ...overrides
  };
}

function issue(state, overrides = {}, options = {}) {
  return issueOneTimeEnrollmentCode(state, {
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    channelRevision: CHANNEL_REVISION,
    publicKey: pair.publicKey,
    bindings: [binding(), secondBinding()],
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    ...overrides
  }, {
    expectedRevision: state.revision,
    nowMs: NOW,
    ...options
  });
}

function consumeRequest(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    channelRevision: CHANNEL_REVISION,
    publicKey: pair.publicKey,
    bindings: [binding(), secondBinding()],
    ...overrides
  };
}

function consume(state, code, request = consumeRequest(), options = {}) {
  return consumeOneTimeEnrollmentCode(state, code, request, {
    expectedRevision: state.revision,
    nowMs: NOW,
    ...options
  });
}

function consumedFixture() {
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(initial);
  const consumed = consume(issued.nextState, issued.code);
  return {
    initial,
    issued,
    consumed,
    state: consumed.nextState
  };
}

async function persistAndLoad(root, name, state) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    path,
    state: JSON.parse(await readFile(path, "utf8"))
  };
}

function signedGetRequest(bindingValue, nonce = "nonce_0123456789abcdef") {
  const bodyBytes = Buffer.alloc(0);
  return {
    request: signAuthorizationRequest({
      binding: bindingValue,
      method: "GET",
      path: "/api/files",
      bodyBytes,
      timestamp: new Date(NOW).toISOString(),
      nonce
    }, pair.privateKey),
    expected: {
      method: "GET",
      path: "/api/files",
      bodySha256: sha256Bytes(bodyBytes)
    }
  };
}

function stateInvalid(error) {
  return error.code === "enrollment_state_invalid";
}

test("channel config is pre-enrollment, strict, expiring, and requires an external trust verifier", () => {
  const code = createChannelConfigCode(channelInput(), {
    nowMs: NOW,
    signingKey: channelPair.privateKey,
    keyId: CHANNEL_KEY_ID
  });
  assert.ok(code.startsWith(CHANNEL_CONFIG_URI_PREFIX));
  const payload = decodeChannelConfigCode(code, { nowMs: NOW });
  assert.equal(payload.kind, "channel-config");
  assert.equal(payload.serverId, SERVER_ID);
  assert.equal(payload.channelRevision, CHANNEL_REVISION);
  assert.equal(Object.hasOwn(payload, "deviceId"), false);
  assert.equal(Object.hasOwn(payload, "shareId"), false);
  assert.equal(Object.hasOwn(payload, "relationId"), false);
  assert.deepEqual(Object.keys(payload.bootstrap).sort(), ["endpoint", "expiresAt", "purpose"]);

  assert.throws(
    () => verifyChannelConfigCode(code, { nowMs: NOW, trustedServerKeys: {} }),
    (error) => error.code === "enrollment_trust_failed"
  );
  assert.throws(
    () => createChannelConfigCode(channelInput(), { nowMs: NOW }),
    (error) => error.code === "enrollment_request_invalid"
  );
  const verified = verifyChannelConfigCode(code, {
    nowMs: NOW,
    trustedServerKeys: {
      [CHANNEL_KEY_ID]: {
        serverId: SERVER_ID,
        publicKey: channelPair.publicKey,
        allowedBootstrapOrigins: ["https://sync.example.test"],
        bootstrapPathPrefix: "/api/enrollment/v1/"
      }
    }
  });
  assert.equal(verified.trust.status, "verified");
  assert.equal(verified.trust.signerId, CHANNEL_KEY_ID);
  const segmentPin = {
    [CHANNEL_KEY_ID]: {
      serverId: SERVER_ID,
      publicKey: channelPair.publicKey,
      allowedBootstrapOrigins: ["https://sync.example.test"],
      bootstrapPathPrefix: "/api/enrollment/v1"
    }
  };
  const subpathCode = createChannelConfigCode(channelInput({
    bootstrap: {
      endpoint: "https://sync.example.test/api/enrollment/v1/child/challenge",
      purpose: "identity-enrollment",
      expiresAt: new Date(NOW + 15 * 60 * 1000).toISOString()
    }
  }), {
    nowMs: NOW,
    signingKey: channelPair.privateKey,
    keyId: CHANNEL_KEY_ID
  });
  assert.equal(
    verifyChannelConfigCode(subpathCode, { nowMs: NOW, trustedServerKeys: segmentPin }).trust.status,
    "verified"
  );
  const pathSiblingCode = createChannelConfigCode(channelInput({
    bootstrap: {
      endpoint: "https://sync.example.test/api/enrollment/v1evil/challenge",
      purpose: "identity-enrollment",
      expiresAt: new Date(NOW + 15 * 60 * 1000).toISOString()
    }
  }), {
    nowMs: NOW,
    signingKey: channelPair.privateKey,
    keyId: CHANNEL_KEY_ID
  });
  assert.throws(
    () => verifyChannelConfigCode(pathSiblingCode, {
      nowMs: NOW,
      trustedServerKeys: segmentPin
    }),
    (error) => error.code === "enrollment_trust_failed"
  );
  const tamperedPayload = structuredClone(payload);
  tamperedPayload.authenticator.signature = tamperedPayload.authenticator.signature.startsWith("A")
    ? `B${tamperedPayload.authenticator.signature.slice(1)}`
    : `A${tamperedPayload.authenticator.signature.slice(1)}`;
  const tamperedCode = `${CHANNEL_CONFIG_URI_PREFIX}${Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url")}`;
  assert.throws(
    () => verifyChannelConfigCode(tamperedCode, {
      nowMs: NOW,
      trustedServerKeys: {
        [CHANNEL_KEY_ID]: {
          serverId: SERVER_ID,
          publicKey: channelPair.publicKey,
          allowedBootstrapOrigins: ["https://sync.example.test"],
          bootstrapPathPrefix: "/api/enrollment/v1/"
        }
      }
    }),
    (error) => error.code === "enrollment_trust_failed"
  );
  assert.throws(
    () => verifyChannelConfigCode(code, {
      nowMs: NOW,
      trustedServerKeys: {
        [CHANNEL_KEY_ID]: {
          serverId: SERVER_ID,
          publicKey: channelPair.publicKey,
          allowedBootstrapOrigins: ["https://other.example.test"],
          bootstrapPathPrefix: "/api/enrollment/v1/"
        }
      }
    }),
    (error) => error.code === "enrollment_trust_failed"
  );

  assert.throws(
    () => createChannelConfigCode({ ...channelInput(), serverId: [SERVER_ID] }, {
      nowMs: NOW,
      signingKey: channelPair.privateKey,
      keyId: CHANNEL_KEY_ID
    }),
    (error) => error.code === "enrollment_request_invalid"
  );
  assert.throws(
    () => createChannelConfigCode(channelInput({ issuedAt: "2026-10-19T12:00:00Z" }), {
      nowMs: NOW,
      signingKey: channelPair.privateKey,
      keyId: CHANNEL_KEY_ID
    }),
    (error) => error.code === "enrollment_request_invalid"
  );
  assert.throws(
    () => createChannelConfigCode(channelInput({
      expiresAt: new Date(NOW + 25 * 60 * 60 * 1000).toISOString(),
      bootstrap: {
        endpoint: "https://sync.example.test/api/enrollment/v1/challenge",
        purpose: "identity-enrollment",
        expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString()
      }
    }), {
      nowMs: NOW,
      signingKey: channelPair.privateKey,
      keyId: CHANNEL_KEY_ID
    }),
    (error) => error.code === "enrollment_request_invalid"
  );

  assert.throws(
    () => verifyChannelConfigCode(code, { nowMs: NOW }),
    (error) => error.code === "enrollment_trust_verifier_required"
  );

  assert.throws(
    () => createChannelConfigCode({ ...channelInput(), storage: { secretAccessKey: "forbidden" } }, {
      nowMs: NOW,
      signingKey: channelPair.privateKey,
      keyId: CHANNEL_KEY_ID
    }),
    (error) => error.code === "enrollment_request_invalid"
  );
  assert.throws(
    () => decodeChannelConfigCode(`SFSC1-${Buffer.from("{}").toString("base64url")}`, { nowMs: NOW }),
    (error) => error.code === "enrollment_code_invalid"
  );
  assert.throws(
    () => decodeChannelConfigCode(code, { nowMs: NOW + 16 * 60 * 1000 }),
    (error) => error.code === "enrollment_channel_expired"
  );
});

test("old profile v1/v2 names and meanings remain untouched", () => {
  assert.equal(PROFILE_VERSION, 2);
  assert.deepEqual(SUPPORTED_PROFILE_VERSIONS, [1, 2]);
  assert.equal(PROFILE_URI_PREFIX, "sfsc://import/v1#");
  assert.notEqual(PROFILE_URI_PREFIX, CHANNEL_CONFIG_URI_PREFIX);
  assert.notEqual(PROFILE_URI_PREFIX, DEVICE_ENROLLMENT_URI_PREFIX);
  assert.equal(
    normalizeEnrollmentBinding({ ...binding(), baselineEpoch: 1 }).baselineEpoch,
    1
  );
  assert.throws(
    () => normalizeEnrollmentBinding({ ...binding(), baselineEpoch: "7" }),
    (error) => error.code === "enrollment_request_invalid"
  );
  for (const baselineEpoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeEnrollmentBinding({ ...binding(), baselineEpoch }),
      (error) => error.code === "enrollment_request_invalid",
      String(baselineEpoch)
    );
  }
});

test("enrollment issue and consume are transactional and return multiple versioned relation bindings", () => {
  const state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(state);
  assert.ok(issued.code.startsWith(DEVICE_ENROLLMENT_URI_PREFIX));
  assert.equal(state.revision, 0);
  assert.deepEqual(state.enrollmentRecords, {});
  assert.equal(issued.nextState.revision, 1);
  assertEnrollmentStateTransition(state, issued.nextState);

  const decoded = decodeOneTimeEnrollmentCode(issued.code, { nowMs: NOW });
  assert.equal(decoded.bindings.length, 2);
  assert.equal(JSON.stringify(issued.nextState).includes(decoded.secret), false);

  const consumed = consume(issued.nextState, issued.code);
  assert.equal(consumed.grant.kind, "enrollment-grant");
  assert.equal(consumed.grant.bindings.length, 2);
  for (const item of consumed.grant.bindings) {
    assert.equal(item.kind, "enrollment-binding");
    assert.equal(item.identity.serverId, SERVER_ID);
    assert.equal(item.identity.deviceId, DEVICE_ID);
    assert.equal(item.channelRevision, CHANNEL_REVISION);
    assert.match(item.credentialRevision, /^cred_/);
    assert.equal(item.rootAttestation.source, "server-enrollment-record");
  }
  assert.equal(issued.nextState.enrollmentRecords[issued.enrollmentId].consumedAt, null);
  assert.equal(consumed.nextState.revision, 2);
  assert.ok(consumed.nextState.devices[DEVICE_ID]);
  assert.ok(consumed.nextState.relationGrants[RELATION_ID]);
  assert.ok(consumed.nextState.relationGrants[SECOND_RELATION_ID]);

  assert.throws(
    () => consume(consumed.nextState, issued.code),
    (error) => error.code === "enrollment_code_used"
  );
});

test("JSON restart preserves consumed state and prevents replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-restart-"));
  try {
    const state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
    const issued = issue(state);
    const persistedIssue = await persistAndLoad(root, "issued.json", issued.nextState);
    const consumed = consume(persistedIssue.state, issued.code);
    const persistedConsumption = await persistAndLoad(root, "consumed.json", consumed.nextState);

    assert.throws(
      () => consume(persistedConsumption.state, issued.code),
      (error) => error.code === "enrollment_code_used"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart rejects expired enrollment codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-expiry-"));
  try {
    const state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
    const issued = issue(state, {
      expiresAt: new Date(NOW + 60_000).toISOString()
    });
    const persisted = await persistAndLoad(root, "issued.json", issued.nextState);
    assert.throws(
      () => consume(persisted.state, issued.code, consumeRequest(), { nowMs: NOW + 61_000 }),
      (error) => error.code === "enrollment_code_expired"
    );
    assert.equal(persisted.state.enrollmentRecords[issued.enrollmentId].consumedAt, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-server, cross-device, and cross-public-key splicing are rejected without consuming the code", () => {
  const state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(state);
  const otherServer = createEnrollmentAuthorityState({ serverId: OTHER_SERVER_ID, nowMs: NOW });

  assert.throws(
    () => consume(otherServer, issued.code),
    (error) => ["enrollment_binding_mismatch", "enrollment_code_invalid"].includes(error.code)
  );
  assert.throws(
    () => consume(issued.nextState, issued.code, consumeRequest({ deviceId: OTHER_DEVICE_ID })),
    (error) => ["enrollment_binding_mismatch", "enrollment_request_invalid"].includes(error.code)
  );
  assert.throws(
    () => consume(issued.nextState, issued.code, consumeRequest({ publicKey: otherPair.publicKey })),
    (error) => error.code === "enrollment_public_key_mismatch"
  );
  assert.equal(issued.nextState.enrollmentRecords[issued.enrollmentId].consumedAt, null);
  assert.equal(consume(issued.nextState, issued.code).nextState.revision, 2);
});

test("signed authorization binds exact path/query and raw body bytes, then persists nonce replay state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-auth-"));
  try {
    const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
    const issued = issue(initial);
    const consumed = consume(issued.nextState, issued.code);
    const selectedBinding = consumed.grant.bindings[0];
    const bodyBytes = Buffer.from('{"operation":"list","cursor":"a/b"}', "utf8");
    const path = "/api/relations/rel_0123456789abcdef/files?cursor=a%2Fb&limit=10";
    const request = signAuthorizationRequest({
      binding: selectedBinding,
      method: "POST",
      path,
      bodyBytes,
      timestamp: new Date(NOW).toISOString(),
      nonce: "nonce_0123456789abcdef"
    }, pair.privateKey);
    const expected = {
      method: "POST",
      path,
      bodySha256: sha256Bytes(bodyBytes)
    };

    assert.throws(
      () => verifySignedAuthorizationRequest(consumed.nextState, { ...request, authorized: true }, expected, {
        expectedRevision: consumed.nextState.revision,
        nowMs: NOW
      }),
      (error) => error.code === "enrollment_request_invalid"
    );
    assert.throws(
      () => verifySignedAuthorizationRequest(consumed.nextState, request, {
        ...expected,
        bodySha256: sha256Bytes(Buffer.from("different bytes"))
      }, {
        expectedRevision: consumed.nextState.revision,
        nowMs: NOW
      }),
      (error) => error.code === "enrollment_request_mismatch"
    );

    const allowed = verifySignedAuthorizationRequest(consumed.nextState, request, expected, {
      expectedRevision: consumed.nextState.revision,
      nowMs: NOW
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(consumed.nextState.revision, 2);
    assert.equal(allowed.nextState.revision, 3);

    const persisted = await persistAndLoad(root, "authorized.json", allowed.nextState);
    assert.throws(
      () => verifySignedAuthorizationRequest(persisted.state, request, expected, {
        expectedRevision: persisted.state.revision,
        nowMs: NOW + 60_000
      }),
      (error) => error.code === "enrollment_auth_replayed"
    );
    assert.throws(
      () => verifySignedAuthorizationRequest(persisted.state, request, expected, {
        expectedRevision: persisted.state.revision,
        nowMs: NOW + 5 * 60 * 1000 + 1
      }),
      (error) => error.code === "enrollment_auth_expired"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted authorization nonce corruption is fail-closed after JSON reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-nonce-corruption-"));
  try {
    const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
    const issued = issue(initial);
    const consumed = consume(issued.nextState, issued.code);
    const bodyBytes = Buffer.from('{"operation":"list"}', "utf8");
    const path = "/api/relations/rel_0123456789abcdef/files";
    const request = signAuthorizationRequest({
      binding: consumed.grant.bindings[0],
      method: "POST",
      path,
      bodyBytes,
      timestamp: new Date(NOW).toISOString(),
      nonce: "nonce_ffeeddccbbaa9988"
    }, pair.privateKey);
    const expected = {
      method: "POST",
      path,
      bodySha256: sha256Bytes(bodyBytes)
    };
    const allowed = verifySignedAuthorizationRequest(consumed.nextState, request, expected, {
      expectedRevision: consumed.nextState.revision,
      nowMs: NOW
    });
    const persisted = await persistAndLoad(root, "authorized-nonce.json", allowed.nextState);

    const corruptNonceArray = structuredClone(persisted.state);
    corruptNonceArray.authorizationNonces[DEVICE_ID] = {};
    assert.throws(
      () => verifySignedAuthorizationRequest(corruptNonceArray, request, expected, {
        expectedRevision: corruptNonceArray.revision,
        nowMs: NOW + 60_000
      }),
      (error) => error.code === "enrollment_state_invalid"
    );

    const corruptNonceTimestamp = structuredClone(persisted.state);
    corruptNonceTimestamp.authorizationNonces[DEVICE_ID][0].timestamp = "bad";
    assert.throws(
      () => verifySignedAuthorizationRequest(corruptNonceTimestamp, request, expected, {
        expectedRevision: corruptNonceTimestamp.revision,
        nowMs: NOW + 60_000
      }),
      (error) => error.code === "enrollment_state_invalid"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted device and relation revocation corruption fails closed after JSON reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-revocation-corruption-"));
  try {
    const fixture = consumedFixture();
    const { request, expected } = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_1122334455667788"
    );
    const mutations = [
      ["device false", (state) => { state.devices[DEVICE_ID].revokedAt = false; }],
      ["device missing", (state) => { delete state.devices[DEVICE_ID].revokedAt; }],
      ["device invalid", (state) => { state.devices[DEVICE_ID].revokedAt = "not-a-time"; }],
      ["relation false", (state) => {
        state.relationGrants[RELATION_ID].revokedAt = false;
      }],
      ["relation missing", (state) => {
        delete state.relationGrants[RELATION_ID].revokedAt;
      }],
      ["relation invalid", (state) => {
        state.relationGrants[RELATION_ID].revokedAt = "not-a-time";
      }]
    ];

    for (const [label, mutate] of mutations) {
      const corrupt = structuredClone(fixture.state);
      mutate(corrupt);
      const persisted = await persistAndLoad(root, "revocation.json", corrupt);
      assert.throws(
        () => verifySignedAuthorizationRequest(persisted.state, request, expected, {
          expectedRevision: persisted.state.revision,
          nowMs: NOW
        }),
        stateInvalid,
        label
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted consumedAt corruption cannot replay an enrollment code", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-consumed-corruption-"));
  try {
    const fixture = consumedFixture();
    const mutations = [
      ["false", (record) => { record.consumedAt = false; }],
      ["missing", (record) => { delete record.consumedAt; }],
      ["invalid", (record) => { record.consumedAt = "not-a-time"; }]
    ];

    for (const [label, mutate] of mutations) {
      const corrupt = structuredClone(fixture.state);
      mutate(corrupt.enrollmentRecords[fixture.issued.enrollmentId]);
      const persisted = await persistAndLoad(root, "consumed.json", corrupt);
      assert.throws(
        () => consume(persisted.state, fixture.issued.code),
        stateInvalid,
        label
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or malformed persisted nonce state cannot replay a signed request", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-nonce-missing-"));
  try {
    const fixture = consumedFixture();
    const { request, expected } = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_2233445566778899"
    );
    const allowed = verifySignedAuthorizationRequest(fixture.state, request, expected, {
      expectedRevision: fixture.state.revision,
      nowMs: NOW
    });
    const mutations = [
      ["missing array", (state) => { delete state.authorizationNonces[DEVICE_ID]; }],
      ["invalid array", (state) => { state.authorizationNonces[DEVICE_ID] = {}; }],
      ["missing nonce", (state) => {
        delete state.authorizationNonces[DEVICE_ID][0].nonce;
      }],
      ["invalid timestamp", (state) => {
        state.authorizationNonces[DEVICE_ID][0].timestamp = "not-a-time";
      }],
      ["invalid seenAt", (state) => {
        state.authorizationNonces[DEVICE_ID][0].seenAt = "not-a-time";
      }],
      ["duplicate nonce", (state) => {
        state.authorizationNonces[DEVICE_ID].push(
          structuredClone(state.authorizationNonces[DEVICE_ID][0])
        );
      }]
    ];

    for (const [label, mutate] of mutations) {
      const corrupt = structuredClone(allowed.nextState);
      mutate(corrupt);
      const persisted = await persistAndLoad(root, "nonce.json", corrupt);
      assert.throws(
        () => verifySignedAuthorizationRequest(persisted.state, request, expected, {
          expectedRevision: persisted.state.revision,
          nowMs: NOW
        }),
        stateInvalid,
        label
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested authority records reject missing fields, key mismatches, and key substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-record-schema-"));
  try {
    const fixture = consumedFixture();
    const { request, expected } = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_33445566778899aa"
    );
    const allowed = verifySignedAuthorizationRequest(fixture.state, request, expected, {
      expectedRevision: fixture.state.revision,
      nowMs: NOW
    });
    const mutations = [
      ["top-level field", (state) => { delete state.createdAt; }],
      ["device field", (state) => { delete state.devices[DEVICE_ID].enrolledAt; }],
      ["relation field", (state) => {
        delete state.relationGrants[RELATION_ID].grantedAt;
      }],
      ["enrollment field", (state) => {
        delete state.enrollmentRecords[fixture.issued.enrollmentId].expiresAt;
      }],
      ["nonce field", (state) => {
        delete state.authorizationNonces[DEVICE_ID][0].seenAt;
      }],
      ["device map key", (state) => {
        const record = state.devices[DEVICE_ID];
        delete state.devices[DEVICE_ID];
        state.devices[OTHER_DEVICE_ID] = record;
      }],
      ["relation map key", (state) => {
        const record = state.relationGrants[RELATION_ID];
        delete state.relationGrants[RELATION_ID];
        state.relationGrants[SECOND_RELATION_ID] = record;
      }],
      ["device fingerprint", (state) => {
        state.devices[DEVICE_ID].publicKeyFingerprint = publicKeyFingerprint(otherPair.publicKey);
      }],
      ["device JWK", (state) => {
        state.devices[DEVICE_ID].publicKeyJwk = otherPair.publicKey.export({ format: "jwk" });
      }],
      ["enrollment fingerprint", (state) => {
        state.enrollmentRecords[fixture.issued.enrollmentId].publicKeyFingerprint =
          publicKeyFingerprint(otherPair.publicKey);
      }],
      ["orphan nonce map", (state) => {
        state.authorizationNonces[OTHER_DEVICE_ID] = [];
      }]
    ];

    for (const [label, mutate] of mutations) {
      const corrupt = structuredClone(allowed.nextState);
      mutate(corrupt);
      const persisted = await persistAndLoad(root, "record-schema.json", corrupt);
      assert.throws(
        () => verifySignedAuthorizationRequest(persisted.state, request, expected, {
          expectedRevision: persisted.state.revision,
          nowMs: NOW
        }),
        stateInvalid,
        label
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every authority entrypoint rejects malformed nested state before business logic", () => {
  const fixture = consumedFixture();
  const bindingValue = fixture.consumed.grant.bindings[0];
  const { request, expected } = signedGetRequest(
    bindingValue,
    "nonce_445566778899aabb"
  );

  const corruptDevice = structuredClone(fixture.state);
  corruptDevice.devices[DEVICE_ID].revokedAt = false;
  assert.throws(
    () => issue(corruptDevice, {
      requestId: "req_0011223344556677"
    }, { nowMs: NOW + 1000 }),
    stateInvalid
  );
  assert.throws(
    () => grantEnrollmentBinding(corruptDevice, bindingValue, {
      expectedRevision: corruptDevice.revision,
      nowMs: NOW + 1000
    }),
    stateInvalid
  );
  assert.throws(
    () => revokeEnrollmentDevice(corruptDevice, { deviceId: DEVICE_ID }, {
      expectedRevision: corruptDevice.revision,
      nowMs: NOW + 1000
    }),
    stateInvalid
  );
  assert.throws(
    () => verifySignedAuthorizationRequest(corruptDevice, request, expected, {
      expectedRevision: corruptDevice.revision,
      nowMs: NOW
    }),
    stateInvalid
  );

  const corruptRelation = structuredClone(fixture.state);
  corruptRelation.relationGrants[RELATION_ID].revokedAt = false;
  assert.throws(
    () => revokeEnrollmentRelation(corruptRelation, { relationId: RELATION_ID }, {
      expectedRevision: corruptRelation.revision,
      nowMs: NOW + 1000
    }),
    stateInvalid
  );

  const reissued = issue(fixture.state, {
    requestId: "req_fedcba9876543210"
  }, {
    nowMs: NOW + 1000
  });
  const corruptConsume = structuredClone(reissued.nextState);
  corruptConsume.devices[DEVICE_ID].revokedAt = false;
  assert.throws(
    () => consume(corruptConsume, reissued.code, consumeRequest({
      requestId: "req_fedcba9876543210"
    }), {
      nowMs: NOW + 1000
    }),
    stateInvalid
  );
});

test("valid null and canonical revocations remain supported while nonce history is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-enrollment-valid-records-"));
  try {
    const fixture = consumedFixture();
    assert.equal(fixture.state.devices[DEVICE_ID].revokedAt, null);
    assert.equal(fixture.state.relationGrants[RELATION_ID].revokedAt, null);
    assert.deepEqual(fixture.state.authorizationNonces[DEVICE_ID], []);

    const firstRequest = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_5566778899aabbcc"
    );
    const persistedNull = await persistAndLoad(root, "null-revocations.json", fixture.state);
    const firstAllowed = verifySignedAuthorizationRequest(
      persistedNull.state,
      firstRequest.request,
      firstRequest.expected,
      {
        expectedRevision: persistedNull.state.revision,
        nowMs: NOW
      }
    );
    const originalNonceHistory = structuredClone(
      firstAllowed.nextState.authorizationNonces[DEVICE_ID]
    );
    assert.equal(originalNonceHistory.length, 1);

    const reissued = issue(firstAllowed.nextState, {
      requestId: "req_fedcba9876543210"
    }, {
      nowMs: NOW + 1000
    });
    const reenrolled = consume(reissued.nextState, reissued.code, consumeRequest({
      requestId: "req_fedcba9876543210"
    }), {
      nowMs: NOW + 1000
    });
    assert.deepEqual(
      reenrolled.nextState.authorizationNonces[DEVICE_ID],
      originalNonceHistory
    );

    const extraBinding = binding({
      shareId: "shr_0011223344556677",
      rootId: "root_0011223344556677",
      relationId: "rel_0011223344556677",
      attestationId: "att_0011223344556677"
    });
    const granted = grantEnrollmentBinding(reenrolled.nextState, extraBinding, {
      expectedRevision: reenrolled.nextState.revision,
      nowMs: NOW + 2000
    });
    assert.deepEqual(
      granted.nextState.authorizationNonces[DEVICE_ID],
      originalNonceHistory
    );

    const revokedDevice = revokeEnrollmentDevice(firstAllowed.nextState, {
      deviceId: DEVICE_ID
    }, {
      expectedRevision: firstAllowed.nextState.revision,
      nowMs: NOW + 3000
    });
    const persistedDeviceRevocation = await persistAndLoad(
      root,
      "device-revoked.json",
      revokedDevice.nextState
    );
    const deviceRequest = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_66778899aabbccdd"
    );
    assert.throws(
      () => verifySignedAuthorizationRequest(
        persistedDeviceRevocation.state,
        deviceRequest.request,
        deviceRequest.expected,
        {
          expectedRevision: persistedDeviceRevocation.state.revision,
          nowMs: NOW + 3000
        }
      ),
      (error) => error.code === "enrollment_relation_denied"
    );

    const revokedRelation = revokeEnrollmentRelation(firstAllowed.nextState, {
      relationId: RELATION_ID
    }, {
      expectedRevision: firstAllowed.nextState.revision,
      nowMs: NOW + 3000
    });
    const persistedRelationRevocation = await persistAndLoad(
      root,
      "relation-revoked.json",
      revokedRelation.nextState
    );
    const relationRequest = signedGetRequest(
      fixture.consumed.grant.bindings[0],
      "nonce_778899aabbccddee"
    );
    assert.throws(
      () => verifySignedAuthorizationRequest(
        persistedRelationRevocation.state,
        relationRequest.request,
        relationRequest.expected,
        {
          expectedRevision: persistedRelationRevocation.state.revision,
          nowMs: NOW + 3000
        }
      ),
      (error) => error.code === "enrollment_relation_denied"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signature tampering and mismatched query bytes are rejected", () => {
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(initial);
  const consumed = consume(issued.nextState, issued.code);
  const bodyBytes = Buffer.from("exact-body", "utf8");
  const request = signAuthorizationRequest({
    binding: consumed.grant.bindings[0],
    method: "GET",
    path: "/api/files?cursor=a%2Fb",
    bodyBytes,
    timestamp: new Date(NOW).toISOString(),
    nonce: "nonce_fedcba9876543210"
  }, pair.privateKey);

  const tamperedSignature = request.signature.startsWith("A")
    ? `B${request.signature.slice(1)}`
    : `A${request.signature.slice(1)}`;
  assert.throws(
    () => verifyAuthorizationRequestSignature({ ...request, signature: tamperedSignature }, pair.publicKey),
    (error) => error.code === "enrollment_auth_invalid"
  );
  assert.throws(
    () => verifySignedAuthorizationRequest(consumed.nextState, request, {
      method: "GET",
      path: "/api/files?cursor=a/b",
      bodySha256: sha256Bytes(bodyBytes)
    }, {
      expectedRevision: consumed.nextState.revision,
      nowMs: NOW
    }),
    (error) => error.code === "enrollment_request_mismatch"
  );
});

test("authorization comes only from server grants and revoked devices do not revive", () => {
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(initial);
  const consumed = consume(issued.nextState, issued.code);
  const bindingValue = consumed.grant.bindings[0];
  const bodyBytes = Buffer.alloc(0);
  const request = signAuthorizationRequest({
    binding: bindingValue,
    method: "GET",
    path: "/api/files",
    bodyBytes,
    timestamp: new Date(NOW).toISOString(),
    nonce: "nonce_0011223344556677"
  }, pair.privateKey);

  const withoutGrant = structuredClone(consumed.nextState);
  delete withoutGrant.relationGrants[bindingValue.identity.relationId];
  assert.throws(
    () => verifySignedAuthorizationRequest(withoutGrant, request, {
      method: "GET",
      path: "/api/files",
      bodySha256: sha256Bytes(bodyBytes)
    }, {
      expectedRevision: withoutGrant.revision,
      nowMs: NOW
    }),
    (error) => error.code === "enrollment_relation_denied"
  );

  const revoked = revokeEnrollmentDevice(consumed.nextState, { deviceId: DEVICE_ID }, {
    expectedRevision: consumed.nextState.revision,
    nowMs: NOW + 1000
  });
  assert.throws(
    () => issue(revoked.nextState, {}, { nowMs: NOW + 2000 }),
    (error) => error.code === "enrollment_device_revoked"
  );
  assert.ok(revoked.nextState.devices[DEVICE_ID].revokedAt);
});

test("ordinary enrollment cannot replace device keys or rebind an existing relation", () => {
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(initial);
  const consumed = consume(issued.nextState, issued.code);

  assert.throws(
    () => issue(consumed.nextState, {
      requestId: "req_0011223344556677",
      publicKey: otherPair.publicKey
    }, { nowMs: NOW + 1000 }),
    (error) => error.code === "enrollment_identity_conflict"
  );

  assert.throws(
    () => grantEnrollmentBinding(consumed.nextState, binding({
      rootId: SECOND_ROOT_ID,
      attestationId: "att_0011223344556677"
    }), {
      expectedRevision: consumed.nextState.revision,
      nowMs: NOW + 1000
    }),
    (error) => error.code === "enrollment_relation_conflict"
  );

  const newDeviceId = "dev_0011223344556677";
  const conflictingCode = issue(consumed.nextState, {
    requestId: "req_1122334455667788",
    deviceId: newDeviceId,
    publicKey: otherPair.publicKey,
    bindings: [binding({
      deviceId: newDeviceId,
      rootId: SECOND_ROOT_ID,
      attestationId: "att_1122334455667788"
    })]
  }, { nowMs: NOW + 1000 });
  assert.throws(
    () => consume(conflictingCode.nextState, conflictingCode.code, {
      requestId: "req_1122334455667788",
      deviceId: newDeviceId,
      channelRevision: CHANNEL_REVISION,
      publicKey: otherPair.publicKey,
      bindings: [binding({
        deviceId: newDeviceId,
        rootId: SECOND_ROOT_ID,
        attestationId: "att_1122334455667788"
      })]
    }, { nowMs: NOW + 1000 }),
    (error) => error.code === "enrollment_relation_conflict"
  );
});

test("authorization target rejects unsafe path normalization and validates trusted timing options", () => {
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issue(initial);
  const consumed = consume(issued.nextState, issued.code);
  const bindingValue = consumed.grant.bindings[0];
  const bodyBytes = Buffer.from("{}", "utf8");

  for (const path of [
    "//other.example/api/files",
    "/api/%2e%2e/files",
    "/api/a//files",
    "/api/%2Ffiles",
    "/api/../files",
    "/api\\files"
  ]) {
    assert.throws(
      () => signAuthorizationRequest({
        binding: bindingValue,
        method: "GET",
        path,
        bodyBytes,
        timestamp: new Date(NOW).toISOString(),
        nonce: "nonce_1122334455667788"
      }, pair.privateKey),
      (error) => error.code === "enrollment_request_invalid"
    );
  }

  const request = signAuthorizationRequest({
    binding: bindingValue,
    method: "GET",
    path: "/api/files?cursor=a%2Fb",
    bodyBytes,
    timestamp: new Date(NOW).toISOString(),
    nonce: "nonce_2233445566778899"
  }, pair.privateKey);
  const expected = {
    method: "GET",
    path: "/api/files?cursor=a%2Fb",
    bodySha256: sha256Bytes(bodyBytes)
  };
  for (const invalidOptions of [
    { maxSkewMs: Number.NaN },
    { maxSkewMs: 0 },
    { nonceLimit: Number.POSITIVE_INFINITY },
    { nonceLimit: 0 }
  ]) {
    assert.throws(
      () => verifySignedAuthorizationRequest(consumed.nextState, request, expected, {
        expectedRevision: consumed.nextState.revision,
        nowMs: NOW,
        ...invalidOptions
      }),
      (error) => error.code === "enrollment_request_invalid"
    );
  }
});

test("state contract is explicit JSON persistence with caller lock and revision checks", () => {
  const state = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  assert.equal(state.storageContract, ENROLLMENT_STATE_STORAGE_CONTRACT);
  assert.equal(state.storageContract, "caller-held-lock+atomic-json-replace+revision-check-v1");
  assert.equal(state.revision, 0);
  const issued = issue(state);
  assert.throws(
    () => issueOneTimeEnrollmentCode(issued.nextState, {
      requestId: "req_fedcba9876543210",
      deviceId: DEVICE_ID,
      channelRevision: CHANNEL_REVISION,
      publicKey: pair.publicKey,
      bindings: [binding()],
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString()
    }, {
      expectedRevision: 0,
      nowMs: NOW
    }),
    (error) => error.code === "enrollment_state_conflict"
  );
  assert.equal(canonicalJson(JSON.parse(JSON.stringify(issued.nextState))), canonicalJson(issued.nextState));
  assert.throws(
    () => consume(issued.nextState, issued.code, consumeRequest({ publicKey: otherPair.publicKey }), {
      expectedRevision: 0
    }),
    (error) => error.code === "enrollment_state_conflict"
  );
});

test("protocol errors expose stable codes and HTTP status candidates", () => {
  const error = new EnrollmentProtocolError("enrollment_code_expired", "expired");
  assert.equal(error.code, "enrollment_code_expired");
  assert.equal(error.status, 410);
  assert.equal(publicKeyFingerprint(pair.publicKey).length, 43);
});
