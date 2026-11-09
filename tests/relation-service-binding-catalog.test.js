import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  consumeOneTimeEnrollmentCode,
  createEnrollmentAuthorityState,
  issueOneTimeEnrollmentCode,
  revokeEnrollmentDevice,
  revokeEnrollmentRelation
} from "../src/core/enrollmentAuthority.js";
import {
  canonicalJson,
  createEnrollmentKeyPair,
  publicKeyFingerprint
} from "../src/core/enrollmentProtocol.js";
import {
  openRelationServiceBindingCatalog
} from "../src/service/relationServiceBindingCatalog.js";

const repositoryRoot = join(import.meta.dirname, "..");
const authorizedTestRoot = join(
  repositoryRoot,
  ".tmp",
  "development-2026-10-21",
  "p2-owner-admission",
  "relation-service-binding-catalog"
);
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const SERVER_ID = "srv_0000000000000001";
const DEVICE_ID = "dev_0000000000000001";
const CHANNEL_REVISION = "chrev_0000000000000001";
const CREDENTIAL_REVISION = "cred_0000000000000001";

function deferred() {
  let resolveValue;
  let rejectValue;
  const promise = new Promise((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue
  };
}

function createExclusiveLock() {
  let tail = Promise.resolve();
  const entered = [];
  return {
    entered,
    async withExclusiveLock(task) {
      const previous = tail;
      let release;
      tail = new Promise(resolve => {
        release = resolve;
      });
      await previous;
      entered.push(true);
      try {
        return await task();
      } finally {
        release();
      }
    }
  };
}

async function createCase(t) {
  await mkdir(authorizedTestRoot, {
    recursive: true,
    mode: 0o700
  });
  await chmod(authorizedTestRoot, 0o700);
  const directory = await mkdtemp(join(
    authorizedTestRoot,
    "case-"
  ));
  await chmod(directory, 0o700);
  t.after(async () => {
    await rm(directory, {
      recursive: true,
      force: true
    });
  });
  return directory;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sshString(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function authorizedKeysLine(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.from(jwk.x, "base64url");
  const wire = Buffer.concat([
    sshString(Buffer.from("ssh-ed25519", "ascii")),
    sshString(key)
  ]);
  return Buffer.from(
    `ssh-ed25519 ${wire.toString("base64")}\n`,
    "utf8"
  );
}

function binding(relationNumber) {
  const suffix = String(relationNumber).padStart(16, "0");
  return {
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-binding",
    identity: {
      serverId: SERVER_ID,
      deviceId: DEVICE_ID,
      shareId: `shr_${suffix}`,
      rootId: `root_${suffix}`,
      relationId: `rel_${suffix}`
    },
    baselineEpoch: 1,
    channelRevision: CHANNEL_REVISION,
    credentialRevision: CREDENTIAL_REVISION,
    rootAttestation: {
      source: "server-enrollment-record",
      referenceId: `att_${suffix}`,
      attestedAt: new Date(NOW - 60_000).toISOString()
    }
  };
}

function pendingRoot(directory, enrollmentBinding, relationNumber) {
  const suffix = String(relationNumber).padStart(16, "0");
  const markerContent = {
    schemaVersion: 1,
    kind: "syncraft-directory-root",
    serverId: enrollmentBinding.identity.serverId,
    shareId: enrollmentBinding.identity.shareId,
    rootId: enrollmentBinding.identity.rootId,
    markerId: `mkr_${suffix}`,
    operationId: `rootop_${suffix}`,
    createdAt: "2026-10-23T11:50:00.000Z"
  };
  const markerBytes = Buffer.from(
    canonicalJson(markerContent),
    "utf8"
  );
  return {
    schemaVersion: 1,
    kind: "syncraft-directory-root-record",
    status: "pending",
    operationId: markerContent.operationId,
    serverId: markerContent.serverId,
    shareId: markerContent.shareId,
    rootId: markerContent.rootId,
    markerId: markerContent.markerId,
    canonicalRoot: join(directory, `share-${relationNumber}`),
    createdAt: markerContent.createdAt,
    rootIdentity: {
      dev: String(relationNumber),
      ino: String(relationNumber + 1)
    },
    mountEvidence: {
      platform: "win32",
      kind: "filesystem-identity-only-v1"
    },
    marker: {
      name: ".syncraft-root.json",
      content: markerContent,
      contentLength: String(markerBytes.length),
      contentSha256: sha256(markerBytes)
    },
    stage: {
      name: `.syncraft-root.stage-${markerContent.operationId}`
    }
  };
}

function activeRoot(pending) {
  return {
    ...pending,
    status: "active",
    activatedAt: "2026-10-23T11:51:00.000Z",
    stage: {
      name: pending.stage.name,
      state: "installed"
    },
    markerIdentity: {
      dev: "11",
      ino: "12",
      size: pending.marker.contentLength
    },
    markerSync: {
      fileSynced: true,
      directorySync: "success"
    }
  };
}

async function writePrivateFile(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture(t, {
  relationCount = 1,
  sameRoot = false,
  rootStatus = "pending"
} = {}) {
  const directory = await createCase(t);
  const devicePair = createEnrollmentKeyPair();
  const hostPair = createEnrollmentKeyPair();
  const bindings = [];
  for (let index = 1; index <= relationCount; index += 1) {
    const value = binding(index);
    if (sameRoot) {
      value.identity.rootId = "root_0000000000000001";
      value.identity.shareId = "shr_0000000000000001";
    }
    bindings.push(value);
  }

  let authority = createEnrollmentAuthorityState({
    serverId: SERVER_ID,
    nowMs: NOW
  });
  const issued = issueOneTimeEnrollmentCode(authority, {
    requestId: "req_0000000000000001",
    deviceId: DEVICE_ID,
    channelRevision: CHANNEL_REVISION,
    publicKey: devicePair.publicKey,
    bindings,
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString()
  }, {
    expectedRevision: authority.revision,
    nowMs: NOW
  });
  const consumed = consumeOneTimeEnrollmentCode(
    issued.nextState,
    issued.code,
    {
      requestId: "req_0000000000000001",
      deviceId: DEVICE_ID,
      channelRevision: CHANNEL_REVISION,
      publicKey: devicePair.publicKey,
      bindings
    },
    {
      expectedRevision: issued.nextState.revision,
      nowMs: NOW
    }
  );
  authority = consumed.nextState;

  const hostKeyPath = join(directory, "host-key.pem");
  await writePrivateFile(
    hostKeyPath,
    hostPair.privateKey.export({
      format: "pem",
      type: "pkcs8"
    })
  );
  const hostPublicSha256 = sha256(
    createPublicKey(hostPair.privateKey).export({
      format: "der",
      type: "spki"
    })
  );

  const roots = {};
  const relations = {};
  for (let index = 0; index < bindings.length; index += 1) {
    const enrollmentBinding = bindings[index];
    const root = pendingRoot(
      directory,
      enrollmentBinding,
      index + 1
    );
    await mkdir(root.canonicalRoot, {
      recursive: true,
      mode: 0o700
    });
    roots[root.rootId] = rootStatus === "pending"
      ? root
      : activeRoot(root);

    const authorizedKeysPath = join(
      directory,
      `authorized-keys-${index + 1}`
    );
    const authorizedKeys = authorizedKeysLine(devicePair.publicKey);
    await writePrivateFile(authorizedKeysPath, authorizedKeys);
    relations[enrollmentBinding.identity.relationId] = {
      rootId: enrollmentBinding.identity.rootId,
      authorization: {
        authorizedKeysPath,
        sha256: sha256(authorizedKeys),
        devicePublicKeyFingerprint:
          authority.devices[DEVICE_ID].publicKeyFingerprint
      },
      listener: {
        host: "127.0.0.1",
        port: 23001 + index
      }
    };
  }

  const statePath = join(directory, "relation-bindings.json");
  const initialState = {
    schemaVersion: "1",
    kind: "syncraft-relation-service-bindings",
    revision: 0,
    authority,
    roots,
    serverHostKey: {
      path: hostKeyPath,
      publicKeySha256: hostPublicSha256
    },
    relations
  };
  return {
    directory,
    statePath,
    initialState,
    bindings,
    devicePair,
    hostPair
  };
}

async function openCatalog(context, {
  initialState = context.initialState,
  mode = "create",
  lock = createExclusiveLock(),
  activate = true
} = {}) {
  const catalog = await openRelationServiceBindingCatalog({
    path: context.statePath,
    withExclusiveLock: lock.withExclusiveLock,
    mode,
    initialState
  });
  if (activate && mode === "create") {
    const current = await catalog.read();
    const pendingRootIds = Object.entries(current.roots)
      .filter(([, record]) => record.status === "pending")
      .map(([rootId]) => rootId);
    if (pendingRootIds.length > 0) {
      await catalog.update({
        expectedRevision: current.revision
      }, state => {
        for (const rootId of pendingRootIds) {
          state.roots[rootId] = activeRoot(state.roots[rootId]);
        }
        return state;
      });
    }
  }
  return {
    catalog,
    lock
  };
}

function incrementedAuthority(authority, mutate) {
  const next = structuredClone(authority);
  mutate(next);
  next.revision += 1;
  next.updatedAt = new Date(NOW + 120_000).toISOString();
  return next;
}

function publicJwk(pair) {
  const value = pair.publicKey.export({ format: "jwk" });
  return {
    kty: value.kty,
    crv: value.crv,
    x: value.x
  };
}

test("facade API is limited and create/require-existing initialization is canonical", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context, {
    activate: false
  });
  assert.deepEqual(
    Object.keys(catalog).sort(),
    ["getForStart", "read", "update", "withStartBinding"]
  );

  const bytes = await readFile(context.statePath);
  assert.equal(
    bytes.toString("utf8"),
    canonicalJson({
      ...context.initialState,
      schemaVersion: "2",
      revocationOperations: {}
    })
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(context.statePath)).mode & 0o777, 0o600);
  }

  const firstRead = await catalog.read();
  firstRead.relations[
    context.bindings[0].identity.relationId
  ].listener.port = 24000;
  assert.equal(
    (await catalog.read()).relations[
      context.bindings[0].identity.relationId
    ].listener.port,
    23001
  );

  const activated = await catalog.update({
    expectedRevision: 0
  }, state => {
    for (const rootId of Object.keys(state.roots)) {
      state.roots[rootId] = activeRoot(state.roots[rootId]);
    }
    return state;
  });
  assert.equal(activated.revision, 1);

  await openRelationServiceBindingCatalog({
    path: context.statePath
  });
});

test("strict v1 catalog migration writes v2 and rejects unknown legacy fields", async (t) => {
  const context = await fixture(t);
  await writeFile(context.statePath, canonicalJson(context.initialState), { mode: 0o600 });
  const lock = createExclusiveLock();
  const catalog = await openRelationServiceBindingCatalog({
    path: context.statePath,
    mode: "require-existing",
    withExclusiveLock: lock.withExclusiveLock
  });
  const migrated = await catalog.read();
  assert.equal(migrated.schemaVersion, "2");
  assert.deepEqual(migrated.revocationOperations, {});
  assert.deepEqual(JSON.parse(await readFile(context.statePath, "utf8")), migrated);

  const invalidContext = await fixture(t);
  const unknownLegacy = { ...invalidContext.initialState, unrecognizedFutureField: true };
  const unknownBytes = canonicalJson(unknownLegacy);
  await writeFile(invalidContext.statePath, unknownBytes, { mode: 0o600 });
  await assert.rejects(
    () => openRelationServiceBindingCatalog({
      path: invalidContext.statePath,
      mode: "require-existing",
      withExclusiveLock: createExclusiveLock().withExclusiveLock
    }),
    error => error.code === "relation_service_binding_catalog_invalid"
  );
  assert.equal(await readFile(invalidContext.statePath, "utf8"), unknownBytes, "failed migration leaves unknown legacy bytes untouched");
});

test("create mode rejects an initial active root registry", async (t) => {
  const context = await fixture(t);
  const initialState = structuredClone(context.initialState);
  const rootId = context.bindings[0].identity.rootId;
  initialState.roots[rootId] = activeRoot(
    initialState.roots[rootId]
  );

  await assert.rejects(
    openCatalog(context, {
      initialState,
      activate: false
    }),
    error => error?.code ===
      "relation_service_binding_catalog_invalid"
      && /empty or pending-only root registry/.test(error.message)
  );
  await assert.rejects(
    stat(context.statePath),
    { code: "ENOENT" }
  );
});

test("ordinary update adds roots pending before same-operation activation", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context);
  const current = await catalog.read();
  const originalBytes = await readFile(context.statePath);
  const newPendingRoot = pendingRoot(
    context.directory,
    binding(2),
    2
  );

  await assert.rejects(
    catalog.update({
      expectedRevision: current.revision
    }, state => {
      state.roots[newPendingRoot.rootId] = activeRoot(newPendingRoot);
      return state;
    }),
    error => error?.code ===
      "relation_service_binding_catalog_invalid"
      && /new directory-root records must be created pending/.test(
        error.message
      )
  );
  assert.deepEqual(
    await readFile(context.statePath),
    originalBytes
  );

  const added = await catalog.update({
    expectedRevision: current.revision
  }, state => {
    state.roots[newPendingRoot.rootId] = newPendingRoot;
    return state;
  });
  assert.equal(added.roots[newPendingRoot.rootId].status, "pending");
  assert.equal(
    added.roots[newPendingRoot.rootId].operationId,
    newPendingRoot.operationId
  );

  const activated = await catalog.update({
    expectedRevision: added.revision
  }, state => {
    state.roots[newPendingRoot.rootId] = activeRoot(
      state.roots[newPendingRoot.rootId]
    );
    return state;
  });
  assert.equal(
    activated.roots[newPendingRoot.rootId].status,
    "active"
  );
  assert.equal(
    activated.roots[newPendingRoot.rootId].operationId,
    newPendingRoot.operationId
  );
});

test("getForStart returns the dispatcher snapshot with the P1 grant binding", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context);
  const relationId = context.bindings[0].identity.relationId;
  const snapshot = await catalog.getForStart(relationId);
  const state = await catalog.read();

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ["authorization", "binding", "directoryRoot", "hostKey", "listener"]
  );
  assert.deepEqual(
    snapshot.binding,
    context.initialState.authority.relationGrants[relationId].binding
  );
  assert.deepEqual(
    snapshot.directoryRoot,
    state.roots.root_0000000000000001
  );
  assert.deepEqual(snapshot.hostKey, context.initialState.serverHostKey);
  assert.deepEqual(snapshot.listener, {
    host: "127.0.0.1",
    port: 23001
  });
  assert.equal(Object.isFrozen(snapshot), true);
  await assert.rejects(
    async () => {
      snapshot.listener.port = 25000;
    },
    TypeError
  );
});

test("revoked grant and revoked device are both denied at start", async (t) => {
  await t.test("revoked relation grant", async (subtest) => {
    const context = await fixture(subtest);
    const relationId = context.bindings[0].identity.relationId;
    const authority = context.initialState.authority;
    context.initialState.authority = revokeEnrollmentRelation(
      authority,
      { relationId },
      {
        expectedRevision: authority.revision,
        nowMs: NOW + 60_000
      }
    ).nextState;
    const { catalog } = await openCatalog(context);
    await assert.rejects(
      catalog.getForStart(relationId),
      error => error?.code ===
        "relation_service_binding_catalog_authorization_denied"
        && /grant is revoked/.test(error.message)
    );
  });

  await t.test("revoked device", async (subtest) => {
    const context = await fixture(subtest);
    const relationId = context.bindings[0].identity.relationId;
    const authority = context.initialState.authority;
    context.initialState.authority = revokeEnrollmentDevice(
      authority,
      { deviceId: DEVICE_ID },
      {
        expectedRevision: authority.revision,
        nowMs: NOW + 60_000
      }
    ).nextState;
    const { catalog } = await openCatalog(context);
    await assert.rejects(
      catalog.getForStart(relationId),
      error => error?.code ===
        "relation_service_binding_catalog_authorization_denied"
        && /device is not active/.test(error.message)
    );
  });
});

test("existing relation authority facts cannot be replaced", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context);
  const relationId = context.bindings[0].identity.relationId;
  const originalBytes = await readFile(context.statePath);

  async function rejectAuthorityChange(mutate, pattern) {
    const current = await catalog.read();
    await assert.rejects(
      catalog.update({
        expectedRevision: current.revision
      }, state => {
        state.authority = incrementedAuthority(
          current.authority,
          mutate
        );
        state.relations[
          relationId
        ].authorization.devicePublicKeyFingerprint =
          state.authority.devices[DEVICE_ID].publicKeyFingerprint;
        return state;
      }),
      error => error?.code ===
        "relation_service_binding_catalog_invalid"
        && pattern.test(error.message)
    );
    assert.deepEqual(
      await readFile(context.statePath),
      originalBytes
    );
  }

  await rejectAuthorityChange(
    authority => {
      authority.relationGrants[relationId].binding.baselineEpoch += 1;
    },
    /baselineEpoch cannot change/
  );
  await rejectAuthorityChange(
    authority => {
      authority.relationGrants[
        relationId
      ].binding.rootAttestation.referenceId =
        "att_0000000000000002";
    },
    /rootAttestation cannot change/
  );
  await rejectAuthorityChange(
    authority => {
      authority.relationGrants[
        relationId
      ].binding.identity.shareId =
        "shr_0000000000000002";
    },
    /identities differ/
  );

  const replacementPair = createEnrollmentKeyPair();
  const replacementJwk = publicJwk(replacementPair);
  const replacementFingerprint = publicKeyFingerprint(
    replacementPair.publicKey
  );
  await rejectAuthorityChange(
    authority => {
      authority.devices[DEVICE_ID].publicKeyJwk = replacementJwk;
      authority.devices[DEVICE_ID].publicKeyFingerprint =
        replacementFingerprint;
      for (const enrollment of Object.values(
        authority.enrollmentRecords
      )) {
        if (enrollment.deviceId === DEVICE_ID
          && enrollment.consumedByDeviceId === DEVICE_ID) {
          enrollment.publicKeyJwk = replacementJwk;
          enrollment.publicKeyFingerprint = replacementFingerprint;
        }
      }
    },
    /device public key cannot change/
  );

  const current = await catalog.read();
  const revised = await catalog.update({
    expectedRevision: current.revision
  }, state => {
    state.authority = incrementedAuthority(
      current.authority,
      authority => {
        authority.relationGrants[
          relationId
        ].binding.channelRevision =
          "chrev_0000000000000002";
        authority.relationGrants[
          relationId
        ].binding.credentialRevision =
          "cred_0000000000000002";
      }
    );
    state.relations[relationId].authorization.devicePublicKeyFingerprint =
      state.authority.devices[DEVICE_ID].publicKeyFingerprint;
    return state;
  });
  assert.equal(
    revised.authority.relationGrants[
      relationId
    ].binding.channelRevision,
    "chrev_0000000000000002"
  );
  assert.equal(
    revised.authority.relationGrants[
      relationId
    ].binding.credentialRevision,
    "cred_0000000000000002"
  );
});

test("revoked grant or device cannot be restored by ordinary update", async (t) => {
  await t.test("revoked grant", async (subtest) => {
    const context = await fixture(subtest);
    const relationId = context.bindings[0].identity.relationId;
    const authority = context.initialState.authority;
    context.initialState.authority = revokeEnrollmentRelation(
      authority,
      { relationId },
      {
        expectedRevision: authority.revision,
        nowMs: NOW + 60_000
      }
    ).nextState;
    const { catalog } = await openCatalog(context);
    const current = await catalog.read();
    const originalBytes = await readFile(context.statePath);

    await assert.rejects(
      catalog.update({
        expectedRevision: current.revision
      }, state => {
        state.authority = incrementedAuthority(
          current.authority,
          next => {
            next.relationGrants[relationId].revokedAt = null;
          }
        );
        return state;
      }),
      error => error?.code ===
        "relation_service_binding_catalog_invalid"
        && /revoked relation grant cannot be restored/.test(
          error.message
        )
    );
    assert.deepEqual(
      await readFile(context.statePath),
      originalBytes
    );
  });

  await t.test("revoked device", async (subtest) => {
    const context = await fixture(subtest);
    const authority = context.initialState.authority;
    context.initialState.authority = revokeEnrollmentDevice(
      authority,
      { deviceId: DEVICE_ID },
      {
        expectedRevision: authority.revision,
        nowMs: NOW + 60_000
      }
    ).nextState;
    const { catalog } = await openCatalog(context);
    const current = await catalog.read();
    const originalBytes = await readFile(context.statePath);

    await assert.rejects(
      catalog.update({
        expectedRevision: current.revision
      }, state => {
        state.authority = incrementedAuthority(
          current.authority,
          next => {
            next.devices[DEVICE_ID].revokedAt = null;
          }
        );
        return state;
      }),
      error => error?.code ===
        "relation_service_binding_catalog_invalid"
        && /revoked relation device cannot be restored/.test(
          error.message
        )
    );
    assert.deepEqual(
      await readFile(context.statePath),
      originalBytes
    );
  });
});

test("authorized_keys digest matching is insufficient without the exact device key", async (t) => {
  const context = await fixture(t);
  const relationId = context.bindings[0].identity.relationId;
  const relation = context.initialState.relations[relationId];
  const otherPair = createEnrollmentKeyPair();
  const wrongLine = authorizedKeysLine(otherPair.publicKey);
  await writePrivateFile(
    relation.authorization.authorizedKeysPath,
    wrongLine
  );
  relation.authorization.sha256 = sha256(wrongLine);
  const { catalog } = await openCatalog(context);

  await assert.rejects(
    catalog.getForStart(relationId),
    error => error?.code ===
      "relation_service_binding_catalog_authorization_denied"
      && /not the enrolled device key/.test(error.message)
  );
});

test("pending roots cannot start and only the same guard operation may activate", async (t) => {
  const context = await fixture(t, {
    rootStatus: "pending"
  });
  const relationId = context.bindings[0].identity.relationId;
  const rootId = context.bindings[0].identity.rootId;
  const { catalog } = await openCatalog(context, {
    activate: false
  });
  await assert.rejects(
    catalog.getForStart(relationId),
    error => error?.code === "relation_service_binding_catalog_not_ready"
  );

  const pendingPreserved = await catalog.update({
    expectedRevision: 0
  }, state => {
    state.relations[relationId].listener.port = 23002;
    return state;
  });
  assert.equal(
    pendingPreserved.roots[rootId].status,
    "pending"
  );

  const updated = await catalog.update({
    expectedRevision: 1
  }, state => {
    state.roots[rootId] = activeRoot(state.roots[rootId]);
    return state;
  });
  assert.equal(updated.revision, 2);
  assert.equal(
    canonicalJson(updated.authority),
    canonicalJson(context.initialState.authority)
  );
  assert.equal((await catalog.getForStart(relationId)).directoryRoot.status, "active");
});

test("revision conflict leaves the original bytes and never invokes the updater", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context);
  const original = await readFile(context.statePath);
  let called = false;
  await assert.rejects(
    catalog.update({ expectedRevision: 7 }, state => {
      called = true;
      return state;
    }),
    error => error?.code ===
      "relation_service_binding_catalog_conflict"
  );
  assert.equal(called, false);
  assert.deepEqual(await readFile(context.statePath), original);
});

test("withStartBinding holds the configuration lock until the simulated go returns", async (t) => {
  const context = await fixture(t);
  const { catalog } = await openCatalog(context);
  const relationId = context.bindings[0].identity.relationId;
  const entered = deferred();
  const finishGo = deferred();
  const events = [];
  const baselineRevision = (await catalog.read()).revision;

  const goPromise = catalog.withStartBinding(
    relationId,
    async snapshot => {
      events.push("go-start");
      entered.resolve();
      await finishGo.promise;
      events.push("go-end");
      return snapshot;
    }
  );
  await entered.promise;

  const updatePromise = catalog.update({
    expectedRevision: baselineRevision
  }, state => {
    events.push("update");
    state.relations[relationId].listener.port = 23099;
    return state;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["go-start"]);

  finishGo.resolve();
  const snapshot = await goPromise;
  const updated = await updatePromise;
  assert.deepEqual(events, ["go-start", "go-end", "update"]);
  assert.equal(snapshot.listener.port, 23001);
  assert.equal(updated.relations[relationId].listener.port, 23099);
});

test("different relations may share a root but ports and key paths stay unique", async (t) => {
  await t.test("same root is accepted", async (subtest) => {
    const context = await fixture(subtest, {
      relationCount: 2,
      sameRoot: true
    });
    const { catalog } = await openCatalog(context);
    const [first, second] = await Promise.all([
      catalog.getForStart(context.bindings[0].identity.relationId),
      catalog.getForStart(context.bindings[1].identity.relationId)
    ]);
    assert.equal(
      first.directoryRoot.rootId,
      second.directoryRoot.rootId
    );
    assert.notEqual(
      first.authorization.authorizedKeysPath,
      second.authorization.authorizedKeysPath
    );
  });

  await t.test("duplicate listener port", async (subtest) => {
    const context = await fixture(subtest, {
      relationCount: 2,
      sameRoot: true
    });
    const [first, second] = context.bindings;
    context.initialState.relations[
      second.identity.relationId
    ].listener.port = context.initialState.relations[
      first.identity.relationId
    ].listener.port;
    await assert.rejects(
      openCatalog(context),
      error => error?.code ===
        "relation_service_binding_catalog_invalid"
        && /ports must be unique/.test(error.message)
    );
  });

  await t.test("duplicate authorized_keys path", async (subtest) => {
    const context = await fixture(subtest, {
      relationCount: 2,
      sameRoot: true
    });
    const [first, second] = context.bindings;
    context.initialState.relations[
      second.identity.relationId
    ].authorization.authorizedKeysPath =
      context.initialState.relations[
        first.identity.relationId
      ].authorization.authorizedKeysPath;
    await assert.rejects(
      openCatalog(context),
      error => error?.code ===
        "relation_service_binding_catalog_invalid"
        && /reuse authorized_keys paths/.test(error.message)
    );
  });
});

test("existing roots and relation root bindings cannot be changed", async (t) => {
  const context = await fixture(t, {
    relationCount: 2
  });
  const { catalog } = await openCatalog(context);
  const firstRelationId = context.bindings[0].identity.relationId;
  const firstRootId = context.bindings[0].identity.rootId;
  const baselineRevision = (await catalog.read()).revision;

  await assert.rejects(
    catalog.update({
      expectedRevision: baselineRevision
    }, state => {
      state.roots[firstRootId].canonicalRoot = join(
        context.directory,
        "rebound-root"
      );
      return state;
    }),
    error => error?.code ===
      "relation_service_binding_catalog_invalid"
      && /existing directory-root canonicalRoot cannot change/.test(
        error.message
      )
  );

  await assert.rejects(
    catalog.update({
      expectedRevision: baselineRevision
    }, state => {
      state.relations[firstRelationId].rootId =
        context.bindings[1].identity.rootId;
      return state;
    }),
    error => error?.code ===
      "relation_service_binding_catalog_invalid"
  );

  await assert.rejects(
    catalog.update({
      expectedRevision: baselineRevision
    }, state => {
      state.serverHostKey.publicKeySha256 = "f".repeat(64);
      return state;
    }),
    error => error?.code ===
      "relation_service_binding_catalog_invalid"
      && /rotation requires a controlled migration/.test(
        error.message
      )
  );
});
