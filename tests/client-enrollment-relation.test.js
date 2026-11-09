import test from "node:test";
import assert from "node:assert/strict";

import {
  ENROLLMENT_PROTOCOL_NAME,
  ENROLLMENT_PROTOCOL_VERSION,
  createEnrollmentKeyPair,
  publicKeyFingerprint
} from "../src/core/enrollmentProtocol.js";
import {
  consumeOneTimeEnrollmentCode,
  createEnrollmentAuthorityState,
  issueOneTimeEnrollmentCode
} from "../src/core/enrollmentAuthority.js";
import {
  ENROLLMENT_DIRECTORY_GRANT_KIND,
  ENROLLMENT_VERIFICATION_CONTEXT_KIND,
  projectVerifiedEnrollmentRelation
} from "../client/src/enrollmentRelation.js";
import {
  buildSyncRelation,
  sameSyncRelationBaseline,
  syncRelationConnectionChanged
} from "../client/src/syncRelation.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const SERVER_ID = "srv_0123456789abcdef";
const OTHER_SERVER_ID = "srv_fedcba9876543210";
const DEVICE_ID = "dev_0123456789abcdef";
const OTHER_DEVICE_ID = "dev_fedcba9876543210";
const CHANNEL_REVISION = "chrev_0123456789abcdef";
const OTHER_CHANNEL_REVISION = "chrev_fedcba9876543210";
const CREDENTIAL_REVISION = "cred_0123456789abcdef";
const SHARE_ID = "shr_0123456789abcdef";
const ROOT_ID = "root_0123456789abcdef";
const RELATION_ID = "rel_0123456789abcdef";
const SECOND_SHARE_ID = "shr_fedcba9876543210";
const SECOND_ROOT_ID = "root_fedcba9876543210";
const SECOND_RELATION_ID = "rel_fedcba9876543210";
const REQUEST_ID = "req_0123456789abcdef";
const OTHER_REQUEST_ID = "req_fedcba9876543210";
const pair = createEnrollmentKeyPair();
const PUBLIC_KEY_FINGERPRINT = publicKeyFingerprint(pair.publicKey);

function enrollmentBinding(overrides = {}) {
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "enrollment-binding",
    identity: {
      serverId: SERVER_ID,
      deviceId: DEVICE_ID,
      shareId: overrides.shareId ?? SHARE_ID,
      rootId: overrides.rootId ?? ROOT_ID,
      relationId: overrides.relationId ?? RELATION_ID
    },
    baselineEpoch: overrides.baselineEpoch ?? 7,
    channelRevision: overrides.channelRevision ?? CHANNEL_REVISION,
    credentialRevision: overrides.credentialRevision ?? CREDENTIAL_REVISION,
    rootAttestation: {
      source: "server-enrollment-record",
      referenceId: overrides.attestationId ?? "att_0123456789abcdef",
      attestedAt: new Date(NOW - 60_000).toISOString()
    }
  };
}

function secondEnrollmentBinding(overrides = {}) {
  return enrollmentBinding({
    shareId: SECOND_SHARE_ID,
    rootId: SECOND_ROOT_ID,
    relationId: SECOND_RELATION_ID,
    attestationId: "att_fedcba9876543210",
    ...overrides
  });
}

function issueAndConsume(overrides = {}) {
  const bindings = [
    enrollmentBinding(overrides),
    secondEnrollmentBinding(overrides)
  ];
  const initial = createEnrollmentAuthorityState({ serverId: SERVER_ID, nowMs: NOW });
  const issued = issueOneTimeEnrollmentCode(initial, {
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    channelRevision: CHANNEL_REVISION,
    publicKey: pair.publicKey,
    bindings,
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString()
  }, {
    expectedRevision: initial.revision,
    nowMs: NOW
  });
  const consumed = consumeOneTimeEnrollmentCode(issued.nextState, issued.code, {
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    channelRevision: CHANNEL_REVISION,
    publicKey: pair.publicKey,
    bindings
  }, {
    expectedRevision: issued.nextState.revision,
    nowMs: NOW
  });
  return {
    grant: consumed.grant,
    binding: consumed.grant.bindings[0],
    secondBinding: consumed.grant.bindings[1]
  };
}

function directoryGrant(binding, overrides = {}) {
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: ENROLLMENT_DIRECTORY_GRANT_KIND,
    revision: overrides.revision ?? 3,
    binding,
    root: overrides.root ?? {
      backend: "s3",
      bucketName: "home-sync",
      path: "relations/primary"
    },
    scope: overrides.scope ?? "device",
    authorization: overrides.authorization ?? {
      directions: ["bidirectional", "download"],
      allowDelete: true
    }
  };
}

function verificationContext(overrides = {}) {
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: ENROLLMENT_VERIFICATION_CONTEXT_KIND,
    verifier: "server-enrollment-authority-v1",
    verifiedAt: new Date(NOW).toISOString(),
    directoryGrantRevision: 3,
    expectedServerId: SERVER_ID,
    expectedDeviceId: DEVICE_ID,
    expectedRequestId: REQUEST_ID,
    expectedPublicKeyFingerprint: PUBLIC_KEY_FINGERPRINT,
    expectedChannelRevision: CHANNEL_REVISION,
    ...overrides
  };
}

function makeProfile(overrides = {}) {
  return {
    clientName: "profile-client",
    serverId: "profile-server-claim",
    identity: {
      serverId: "profile-server-claim",
      deviceId: "profile-device-claim",
      serverIdAttested: true
    },
    source: { type: "claim", server: "https://sync.example.test:2025" },
    tunnel: {
      parsed: {
        server: "tunnel.example.test",
        port: 45678
      }
    },
    storage: {
      endpoint: "http://minio-one:9000"
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      checkers: 8
    },
    ...overrides
  };
}

function makeJob(overrides = {}) {
  return {
    localPath: "D:\\Projects",
    direction: "bidirectional",
    clientName: "profile-client",
    storageBackend: "s3",
    bucketName: "home-sync",
    remotePrefix: "relations/primary",
    serverSpace: "device",
    localProxyPort: 18081,
    transfers: 4,
    streams: 8,
    checkers: 8,
    ...overrides
  };
}

function project(grant, binding, directory, context = verificationContext()) {
  return projectVerifiedEnrollmentRelation({
    grant,
    binding,
    directoryGrant: directory,
    verifiedContext: context
  });
}

function assertCode(code) {
  return (error) => error.code === code;
}

test("consumed enrollment grant projects into a trusted relation without old-profile inference", () => {
  const { grant, binding } = issueAndConsume();
  const projected = project(grant, binding, directoryGrant(binding));
  const relation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: projected.trustedBinding
  });

  assert.equal(relation.relationId, RELATION_ID);
  assert.equal(relation.serverId, SERVER_ID);
  assert.equal(relation.deviceId, DEVICE_ID);
  assert.equal(relation.shareId, SHARE_ID);
  assert.equal(relation.rootId, ROOT_ID);
  assert.equal(relation.baselineEpoch, 7);
  assert.equal(relation.identityAssurance, "trusted-binding");
  assert.equal(relation.serverIdentityProven, true);
  assert.equal(relation.rootAttested, true);
  assert.equal(relation.migration.state, "ready");
  assert.equal(projected.provenance.source, "caller-supplied-verification-context");
  assert.equal(projected.provenance.cryptographicProof, false);
  assert.equal(Object.hasOwn(projected.provenance, "authorized"), false);
  assert.equal(Object.hasOwn(projected.provenance, "signatureVerified"), false);
});

test("endpoint and tuning changes keep the projected sync baseline", () => {
  const { grant, binding } = issueAndConsume();
  const projected = project(grant, binding, directoryGrant(binding));
  const initial = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: projected.trustedBinding
  });
  const changed = buildSyncRelation(makeProfile({
    source: { type: "claim", server: "https://new-management.example.test:2025" },
    tunnel: {
      parsed: {
        server: "new-tunnel.example.test",
        port: 45679
      }
    },
    storage: {
      endpoint: "http://minio-two:9000"
    },
    defaults: {
      localProxyPort: 18123,
      transfers: 12,
      streams: 16,
      checkers: 24
    }
  }), makeJob({
    localProxyPort: 18123,
    transfers: 12,
    streams: 16,
    checkers: 24
  }), {
    trustedBinding: projected.trustedBinding
  });

  assert.equal(sameSyncRelationBaseline(initial, changed), true);
  assert.equal(changed.baselineId, initial.baselineId);
  assert.equal(syncRelationConnectionChanged(initial, changed), true);
});

test("root and epoch changes cannot reuse an existing sync baseline", () => {
  const first = issueAndConsume();
  const initialProjection = project(
    first.grant,
    first.binding,
    directoryGrant(first.binding)
  );
  const initial = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: initialProjection.trustedBinding
  });

  const changedRootProjection = project(
    first.grant,
    first.binding,
    directoryGrant(first.binding, {
      root: {
        backend: "s3",
        bucketName: "home-sync",
        path: "relations/replaced-root"
      }
    })
  );
  const changedRoot = buildSyncRelation(makeProfile(), makeJob({
    remotePrefix: "relations/replaced-root"
  }), {
    trustedBinding: changedRootProjection.trustedBinding
  });
  assert.equal(sameSyncRelationBaseline(initial, changedRoot), false);

  const changedEpoch = issueAndConsume({ baselineEpoch: 8 });
  const epochProjection = project(
    changedEpoch.grant,
    changedEpoch.binding,
    directoryGrant(changedEpoch.binding)
  );
  const epochRelation = buildSyncRelation(makeProfile(), makeJob(), {
    trustedBinding: epochProjection.trustedBinding
  });
  assert.equal(epochRelation.baselineEpoch, 8);
  assert.equal(sameSyncRelationBaseline(initial, epochRelation), false);
});

test("directory grants reject revision, device, and relation-binding splicing", () => {
  const { grant, binding, secondBinding } = issueAndConsume();
  assert.throws(
    () => project(grant, binding, directoryGrant(secondBinding)),
    assertCode("enrollment_binding_mismatch")
  );

  const wrongDeviceGrant = {
    ...grant,
    deviceId: OTHER_DEVICE_ID
  };
  assert.throws(
    () => project(wrongDeviceGrant, binding, directoryGrant(binding)),
    assertCode("enrollment_binding_mismatch")
  );

  const invalidRevision = directoryGrant(binding, { revision: 0 });
  assert.throws(
    () => project(grant, binding, invalidRevision),
    assertCode("enrollment_request_invalid")
  );
  assert.throws(
    () => project(
      grant,
      binding,
      directoryGrant(binding, { revision: 4 }),
      verificationContext({ directoryGrantRevision: 3 })
    ),
    assertCode("enrollment_relation_conflict")
  );
});

test("verification context must match the local request, server, device, key, and channel", () => {
  const { grant, binding } = issueAndConsume();
  for (const [label, override] of [
    ["request", { expectedRequestId: OTHER_REQUEST_ID }],
    ["server", { expectedServerId: OTHER_SERVER_ID }],
    ["device", { expectedDeviceId: OTHER_DEVICE_ID }],
    ["public key", { expectedPublicKeyFingerprint: "A".repeat(43) }],
    ["channel", { expectedChannelRevision: OTHER_CHANNEL_REVISION }]
  ]) {
    assert.throws(
      () => project(
        grant,
        binding,
        directoryGrant(binding),
        verificationContext(override)
      ),
      assertCode("enrollment_relation_conflict"),
      label
    );
  }
});

test("enrollment grant normalization rejects duplicate, foreign-device, and mixed-channel bindings", () => {
  const { grant, binding, secondBinding } = issueAndConsume();
  const duplicateGrant = {
    ...grant,
    bindings: [binding, binding]
  };
  assert.throws(
    () => project(duplicateGrant, binding, directoryGrant(binding)),
    assertCode("enrollment_request_invalid")
  );

  const foreignGrant = {
    ...grant,
    bindings: [
      binding,
      {
        ...secondBinding,
        identity: {
          ...secondBinding.identity,
          deviceId: OTHER_DEVICE_ID
        }
      }
    ]
  };
  assert.throws(
    () => project(foreignGrant, binding, directoryGrant(binding)),
    assertCode("enrollment_binding_mismatch")
  );

  const mixedChannelGrant = {
    ...grant,
    bindings: [
      binding,
      {
        ...secondBinding,
        channelRevision: OTHER_CHANNEL_REVISION
      }
    ]
  };
  assert.throws(
    () => project(mixedChannelGrant, binding, directoryGrant(binding)),
    assertCode("enrollment_binding_mismatch")
  );
});

test("empty WebDAV root is accepted and remains an explicit share root", () => {
  const { grant, binding } = issueAndConsume();
  const projected = project(grant, binding, directoryGrant(binding, {
    root: {
      backend: "webdav",
      bucketName: "",
      path: ""
    }
  }));
  const relation = buildSyncRelation(makeProfile(), makeJob({
    storageBackend: "webdav",
    bucketName: "",
    remotePrefix: ""
  }), {
    trustedBinding: projected.trustedBinding
  });

  assert.equal(relation.migration.state, "ready");
  assert.equal(relation.remoteRoot.path, "");
  assert.equal(relation.rclone.remotePath, `${relation.rclone.remoteAlias}:`);
});

test("directory root paths reject absolute, dot, backslash, encoded, and ambiguous forms", () => {
  const { grant, binding } = issueAndConsume();
  for (const path of [
    "/absolute",
    "\\absolute",
    "C:\\absolute",
    "C:/absolute",
    "a/../b",
    "a/./b",
    "a//b",
    "a/%2e%2e/b",
    "a\\b",
    "a?query",
    "a#fragment",
    "a/%2Fb",
    " a/b",
    "a/b "
  ]) {
    assert.throws(
      () => project(grant, binding, directoryGrant(binding, {
        root: {
          backend: "webdav",
          bucketName: "",
          path
        }
      })),
      assertCode("enrollment_request_invalid"),
      path
    );
  }

  assert.throws(
    () => project(grant, binding, directoryGrant(binding, {
      root: {
        backend: "ftp",
        bucketName: "",
        path: ""
      }
    })),
    assertCode("enrollment_request_invalid")
  );
  assert.throws(
    () => project(grant, binding, directoryGrant(binding, {
      root: {
        backend: "webdav",
        bucketName: "unexpected",
        path: ""
      }
    })),
    assertCode("enrollment_request_invalid")
  );
});
