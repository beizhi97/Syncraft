import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  createRelationServiceProductWiring,
  createSftpRelationServiceProductWiring,
  RELATION_SERVICE_SFTP_USER
} from "../src/service/relationServiceProductWiring.js";

const root = join(import.meta.dirname, "..");
const fixtureRoot = join(root, "tests", "fixtures", "relation-product-wiring");
const attemptA = "a".repeat(32);
const attemptB = "b".repeat(32);
const attemptC = "c".repeat(32);
const attemptD = "d".repeat(32);
const attemptE = "e".repeat(32);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function binding({
  relationId = "rel_relation0000000001",
  channelRevision = "chrev_channel000000001",
  credentialRevision = "cred_credential0000001"
} = {}) {
  return {
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-binding",
    identity: {
      serverId: "srv_server000000000001",
      deviceId: "dev_device000000000001",
      shareId: "shr_share0000000000001",
      rootId: "root_root00000000000001",
      relationId
    },
    baselineEpoch: 1,
    channelRevision,
    credentialRevision,
    rootAttestation: {
      source: "server-enrollment",
      referenceId: "att_attestation00000001",
      attestedAt: "2026-10-20T00:00:00.000Z"
    }
  };
}

function directoryRoot(enrollmentBinding, name) {
  const canonicalRoot = join(fixtureRoot, name);
  const createdAt = "2026-10-20T00:00:00.000Z";
  return {
    schemaVersion: 1,
    kind: "syncraft-directory-root-record",
    status: "active",
    serverId: enrollmentBinding.identity.serverId,
    shareId: enrollmentBinding.identity.shareId,
    rootId: enrollmentBinding.identity.rootId,
    markerId: "mkr_marker000000000001",
    operationId: "rootop_operation00000001",
    createdAt,
    canonicalRoot,
    rootIdentity: { dev: "1", ino: "2" },
    mountEvidence: {
      platform: "win32",
      kind: "filesystem-identity-only-v1"
    },
    marker: {
      name: ".syncraft-root.json",
      content: {
        schemaVersion: 1,
        kind: "syncraft-directory-root",
        serverId: enrollmentBinding.identity.serverId,
        shareId: enrollmentBinding.identity.shareId,
        rootId: enrollmentBinding.identity.rootId,
        markerId: "mkr_marker000000000001",
        operationId: "rootop_operation00000001",
        createdAt
      },
      contentLength: "1",
      contentSha256: "1".repeat(64)
    },
    stage: {
      name: "rootop_operation00000001.stage",
      state: "installed"
    },
    activatedAt: createdAt,
    markerIdentity: { dev: "3", ino: "4", size: "5" },
    markerSync: { fileSynced: true, directorySync: "success" }
  };
}

function snapshot({
  relationId = "rel_relation0000000001",
  name = "relation-a",
  port = 22001,
  channelRevision,
  credentialRevision
} = {}) {
  const enrollmentBinding = binding({
    relationId,
    channelRevision,
    credentialRevision
  });
  return {
    binding: enrollmentBinding,
    directoryRoot: directoryRoot(enrollmentBinding, name),
    authorization: {
      authorizedKeysPath: join(fixtureRoot, name, "authorized_keys"),
      sha256: "2".repeat(64),
      devicePublicKeyFingerprint: "A".repeat(43)
    },
    hostKey: {
      path: join(fixtureRoot, name, "ssh_host_ed25519_key"),
      publicKeySha256: "3".repeat(64)
    },
    listener: {
      host: "127.0.0.1",
      port
    }
  };
}

function runtimePackage() {
  const relationPackage = join(
    fixtureRoot,
    "native",
    "sfsc-root-guard"
  );
  return {
    supervisorPath: join(fixtureRoot, "native", "sfsc-relation-supervisor"),
    helperPath: relationPackage,
    helperSha256: "4".repeat(64),
    execServicePath: relationPackage,
    signalServicePath: relationPackage
  };
}

function sftpRuntimePackage() {
  const relationPackage = join(fixtureRoot, "native", "sfsc-root-guard");
  return {
    supervisorPath: join(fixtureRoot, "native", "sfsc-relation-supervisor-v2"),
    rootGuardPath: relationPackage,
    rootGuardSha256: "4".repeat(64),
    sftpServicePath: join(fixtureRoot, "native", "sfsc-sftp-service")
  };
}

function harness(initialSnapshots = [snapshot()], runtimeMode = "rclone") {
  const snapshots = new Map(
    initialSnapshots.map(value => [value.binding.identity.relationId, value])
  );
  const catalogCalls = [];
  const bindingCalls = [];
  const catalogUpdates = [];
  const protectionCalls = [];
  const adapters = [];
  let configLock = Promise.resolve();
  const withConfigLock = task => {
    const previous = configLock;
    let release;
    configLock = new Promise(resolve => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await task();
      } finally {
        release();
      }
    });
  };
  const catalog = {
    async getForStart(relationId) {
      catalogCalls.push(relationId);
      const value = snapshots.get(relationId);
      if (!value) {
        throw new Error("relation is unavailable");
      }
      return structuredClone(value);
    },
    async withStartBinding(relationId, task) {
      bindingCalls.push(relationId);
      return withConfigLock(async () => {
        const value = snapshots.get(relationId);
        if (!value) {
          throw new Error("relation authorization is unavailable");
        }
        return task(structuredClone(value));
      });
    },
    async update(relationId, update) {
      return withConfigLock(async () => {
        const current = snapshots.get(relationId);
        if (!current) {
          throw new Error("relation is unavailable");
        }
        const next = await update(structuredClone(current));
        snapshots.set(relationId, next);
        catalogUpdates.push(relationId);
        return structuredClone(next);
      });
    },
    async revoke(relationId) {
      return withConfigLock(async () => {
        snapshots.delete(relationId);
        catalogUpdates.push(relationId);
      });
    }
  };
  const createRuntime = config => {
    let sequence = 0;
    const adapter = {
      config,
      calls: [],
      async prepare(request, details) {
        this.calls.push({ method: "prepare", request, details });
        sequence += 1;
        return {
          lease: {
            leaseId: `lease-${sequence}`,
            relationId: details.fence.relationId
          },
          handle: {
            relationId: details.fence.relationId,
            generation: details.fence.generation,
            token: `token-${adapters.length}-${sequence}`
          }
        };
      },
      async go(lease, details) {
        this.calls.push({ method: "go", lease, details });
        if (this.goGate) {
          await this.goGate;
        }
        return { ok: true };
      },
      async inspect(handle, details) {
        this.calls.push({ method: "inspect", handle, details });
        return { owned: true, purpose: details.purpose };
      },
      async stop(handle, details) {
        this.calls.push({ method: "stop", handle, details });
        return { ok: true, containmentConfirmed: true };
      },
      async abort(lease, details) {
        this.calls.push({ method: "abort", lease, details });
        return { containmentConfirmed: true };
      }
    };
    adapters.push(adapter);
    return adapter;
  };
  const ensureProtection = async (record, options) => {
    protectionCalls.push({ record, options });
    return {
      schemaVersion: "1",
      protected: true,
      rootId: record.rootId
    };
  };
  const wiringOptions = {
    catalog,
    runtimePackage: runtimeMode === "sftp" ? sftpRuntimePackage() : runtimePackage(),
    testDependencies: {
      createRuntime,
      ensureDirectoryRootProtection: ensureProtection
    }
  };
  const wiring = runtimeMode === "sftp"
    ? createSftpRelationServiceProductWiring(wiringOptions)
    : createRelationServiceProductWiring({
      ...wiringOptions,
      rclonePath: join(fixtureRoot, "native", "rclone")
    });
  return {
    wiring,
    catalog,
    snapshots,
    catalogCalls,
    bindingCalls,
    catalogUpdates,
    protectionCalls,
    adapters
  };
}

function fence({
  relationId,
  operationId = "operation-one",
  generation = "1",
  attemptId,
  expectedHandleDigest = "",
  protectionDigest = null
}) {
  return {
    schemaVersion: "1",
    relationId,
    operationId,
    generation,
    attemptId,
    expectedHandleDigest,
    protectionDigest
  };
}

async function protectAndPrepare({
  wiring,
  value,
  operationId = "operation-one",
  attemptId
}) {
  const relationId = value.binding.identity.relationId;
  const initialFence = fence({ relationId, operationId, attemptId });
  const protection = await wiring.protection.verify({
    relationId,
    operationId,
    generation: "1",
    fence: initialFence,
    signal: new AbortController().signal
  });
  const prepareFence = fence({
    relationId,
    operationId,
    attemptId,
    protectionDigest: protection.digest
  });
  const prepared = await wiring.runtime.prepare(
    { launch: { listener: value.listener } },
    { fence: prepareFence }
  );
  return { protection, prepareFence, prepared };
}

test("test dependencies are optional and may be supplied independently", () => {
  const options = {
    catalog: {
      async getForStart() {
        throw new Error("catalog access is not expected");
      },
      async withStartBinding() {
        throw new Error("catalog access is not expected");
      }
    },
    runtimePackage: runtimePackage(),
    rclonePath: join(fixtureRoot, "native", "rclone")
  };

  assert.doesNotThrow(() => createRelationServiceProductWiring(options));
  assert.doesNotThrow(() => createRelationServiceProductWiring({
    ...options,
    testDependencies: {
      createRuntime() {
        throw new Error("runtime creation is not expected");
      }
    }
  }));
  assert.doesNotThrow(() => createRelationServiceProductWiring({
    ...options,
    testDependencies: {
      ensureDirectoryRootProtection() {
        throw new Error("protection is not expected");
      }
    }
  }));
});

test("SFTP wiring uses only the V2 package, fixed sfsc user, and shared lifecycle", async () => {
  const value = snapshot();
  const context = harness([value], "sftp");
  const { prepared, prepareFence } = await protectAndPrepare({
    wiring: context.wiring,
    value,
    attemptId: attemptA
  });
  assert.equal(context.adapters.length, 1);
  assert.equal(context.adapters[0].config.servicePath, sftpRuntimePackage().sftpServicePath);
  assert.equal(context.adapters[0].config.serviceUser, RELATION_SERVICE_SFTP_USER);
  assert.equal(Object.hasOwn(context.adapters[0].config, "rclonePath"), false);
  await context.wiring.runtime.go(prepared.lease, { fence: prepareFence });
  const inspected = await context.wiring.runtime.inspect(prepared.handle, {
    purpose: "running",
    fence: prepareFence
  });
  assert.equal(inspected.owned, true);
  assert.equal(context.adapters[0].calls.at(-1).method, "inspect");
  await context.wiring.runtime.abort(prepared.lease, { fence: prepareFence });
  assert.equal(context.adapters[0].calls.at(-1).method, "abort");
  assert.equal(context.protectionCalls[0].options.helperPath, sftpRuntimePackage().rootGuardPath);
});

test("SFTP wiring rejects rclone options and non-V2 package shape", () => {
  const catalog = {
    async getForStart() {},
    async withStartBinding() {}
  };
  const options = { catalog, runtimePackage: sftpRuntimePackage() };
  assert.throws(() => createSftpRelationServiceProductWiring({
    ...options,
    rclonePath: join(fixtureRoot, "native", "rclone")
  }), /unsupported fields/);
  assert.throws(() => createSftpRelationServiceProductWiring({
    ...options,
    runtimePackage: runtimePackage()
  }), /unsupported or missing fields/);
});

test("keeps root, key, host-key, listener, and adapter state isolated by relation", async () => {
  const relationA = snapshot({ name: "relation-a", port: 22001 });
  const relationB = snapshot({
    relationId: "rel_relation0000000002",
    name: "relation-b",
    port: 22002
  });
  const context = harness([relationA, relationB]);

  const first = await protectAndPrepare({
    wiring: context.wiring,
    value: relationA,
    operationId: "operation-a",
    attemptId: attemptA
  });
  const second = await protectAndPrepare({
    wiring: context.wiring,
    value: relationB,
    operationId: "operation-b",
    attemptId: attemptB
  });

  assert.equal(context.adapters.length, 2);
  assert.equal(
    context.adapters[0].config.rootPath,
    relationA.directoryRoot.canonicalRoot
  );
  assert.equal(
    context.adapters[1].config.rootPath,
    relationB.directoryRoot.canonicalRoot
  );
  assert.equal(
    context.adapters[0].config.authorizedKeysPath,
    relationA.authorization.authorizedKeysPath
  );
  assert.equal(
    context.adapters[1].config.authorizedKeysPath,
    relationB.authorization.authorizedKeysPath
  );
  assert.equal(
    context.adapters[0].config.hostKeyPath,
    relationA.hostKey.path
  );
  assert.equal(
    context.adapters[1].config.hostKeyPath,
    relationB.hostKey.path
  );
  assert.deepEqual(
    context.adapters[0].calls[0].request.launch.listener,
    relationA.listener
  );
  assert.deepEqual(
    context.adapters[1].calls[0].request.launch.listener,
    relationB.listener
  );
  assert.equal(first.prepared.handle.relationId, relationA.binding.identity.relationId);
  assert.equal(second.prepared.handle.relationId, relationB.binding.identity.relationId);
  assert.equal(
    context.protectionCalls[0].options.helperPath,
    runtimePackage().helperPath
  );
  assert.equal(
    context.protectionCalls[0].options.helperSha256,
    runtimePackage().helperSha256
  );
});

test("makeStartRequest uses only the stable identity and has no caller paths", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const request = await context.wiring.makeStartRequest({
    relationId: relation.binding.identity.relationId,
    operationId: "operation-start",
    expectedHandleDigest: ""
  });
  assert.deepEqual(Object.keys(request.identity), [
    "serverId",
    "deviceId",
    "shareId",
    "rootId",
    "relationId",
    "baselineEpoch",
    "rootAttestation",
    "backend"
  ]);
  assert.equal("channelRevision" in request.identity, false);
  assert.equal("credentialRevision" in request.identity, false);
  assert.equal(request.identity.backend, "sftp");
  assert.deepEqual(request.launch, {
    listener: { host: "127.0.0.1", port: 22001 }
  });

  context.snapshots.set(
    relation.binding.identity.relationId,
    snapshot({
      channelRevision: "chrev_channel000000002",
      credentialRevision: "cred_credential0000002"
    })
  );
  const changedChannel = await context.wiring.makeStartRequest({
    relationId: relation.binding.identity.relationId,
    operationId: "operation-start-two",
    expectedHandleDigest: ""
  });
  assert.deepEqual(changedChannel.identity, request.identity);
});

test("rejects arbitrary launch fields and missing or unsupported catalog data", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const initialFence = fence({
    relationId,
    operationId: "operation-launch",
    attemptId: attemptA
  });
  const protection = await context.wiring.protection.verify({
    relationId,
    operationId: "operation-launch",
    generation: "1",
    fence: initialFence
  });
  await assert.rejects(
    context.wiring.runtime.prepare({
      launch: {
        listener: relation.listener,
        rootPath: relation.directoryRoot.canonicalRoot
      }
    }, {
      fence: fence({
        relationId,
        operationId: "operation-launch",
        attemptId: attemptA,
        protectionDigest: protection.digest
      })
    }),
    /runtime launch/
  );
  assert.equal(context.adapters.length, 0);

  const missing = structuredClone(relation);
  delete missing.binding;
  context.snapshots.set(relationId, missing);
  await assert.rejects(
    context.wiring.makeStartRequest({
      relationId,
      operationId: "operation-missing",
      expectedHandleDigest: ""
    }),
    /catalog start snapshot/
  );

  const unsupported = structuredClone(relation);
  unsupported.unexpected = true;
  context.snapshots.set(relationId, unsupported);
  await assert.rejects(
    context.wiring.makeStartRequest({
      relationId,
      operationId: "operation-unsupported",
      expectedHandleDigest: ""
    }),
    /unsupported/
  );
});

test("rejects a catalog configuration change after protection", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const initialFence = fence({
    relationId,
    operationId: "operation-change",
    attemptId: attemptB
  });
  const protection = await context.wiring.protection.verify({
    relationId,
    operationId: "operation-change",
    generation: "1",
    fence: initialFence
  });
  const changed = structuredClone(relation);
  changed.authorization.sha256 = "9".repeat(64);
  context.snapshots.set(relationId, changed);

  await assert.rejects(
    context.wiring.runtime.prepare(
      { launch: { listener: relation.listener } },
      {
        fence: fence({
          relationId,
          operationId: "operation-change",
          attemptId: attemptB,
          protectionDigest: protection.digest
        })
      }
    ),
    /changed after protection/
  );
  assert.equal(context.adapters.length, 0);
});

test("go rejects a catalog change after prepare and the lease remains abortable", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const { prepared, prepareFence } = await protectAndPrepare({
    wiring: context.wiring,
    value: relation,
    operationId: "operation-go-change",
    attemptId: attemptA
  });
  await context.catalog.update(relationId, current => {
    current.authorization.sha256 = "9".repeat(64);
    return current;
  });
  const getCallsBefore = context.catalogCalls.length;

  await assert.rejects(
    context.wiring.runtime.go(prepared.lease, { fence: prepareFence }),
    /catalog configuration changed after prepare/
  );
  assert.equal(
    context.adapters[0].calls.some(call => call.method === "go"),
    false
  );
  assert.equal(context.bindingCalls.length, 1);

  const aborted = await context.wiring.runtime.abort(
    prepared.lease,
    { fence: prepareFence }
  );
  assert.equal(aborted.containmentConfirmed, true);
  assert.equal(context.catalogCalls.length, getCallsBefore);
  assert.equal(context.bindingCalls.length, 1);
  assert.equal(context.adapters[0].calls.at(-1).method, "abort");
});

test("go rejects a catalog revocation after prepare and the lease remains abortable", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const { prepared, prepareFence } = await protectAndPrepare({
    wiring: context.wiring,
    value: relation,
    operationId: "operation-go-revoke",
    attemptId: attemptB
  });
  await context.catalog.revoke(relationId);
  const getCallsBefore = context.catalogCalls.length;

  await assert.rejects(
    context.wiring.runtime.go(prepared.lease, { fence: prepareFence }),
    /relation authorization is unavailable/
  );
  assert.equal(
    context.adapters[0].calls.some(call => call.method === "go"),
    false
  );
  assert.equal(context.bindingCalls.length, 1);

  const aborted = await context.wiring.runtime.abort(
    prepared.lease,
    { fence: prepareFence }
  );
  assert.equal(aborted.containmentConfirmed, true);
  assert.equal(context.catalogCalls.length, getCallsBefore);
  assert.equal(context.bindingCalls.length, 1);
  assert.equal(context.adapters[0].calls.at(-1).method, "abort");
});

test("start binding holds the catalog lock through adapter go", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const { prepared, prepareFence } = await protectAndPrepare({
    wiring: context.wiring,
    value: relation,
    operationId: "operation-go-lock",
    attemptId: attemptC
  });
  const goGate = deferred();
  context.adapters[0].goGate = goGate.promise;

  const goPromise = context.wiring.runtime.go(
    prepared.lease,
    { fence: prepareFence }
  );
  await waitFor(
    () => context.adapters[0].calls.some(call => call.method === "go"),
    "adapter go"
  );

  let updateRan = false;
  const updatePromise = context.catalog.update(relationId, current => {
    updateRan = true;
    current.authorization.sha256 = "9".repeat(64);
    return current;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updateRan, false);
  assert.equal(context.catalogUpdates.length, 0);

  goGate.resolve();
  await goPromise;
  await updatePromise;
  assert.equal(updateRan, true);
  assert.deepEqual(context.catalogUpdates, [relationId]);
});

test("disable delegates to the old adapter after the catalog becomes unavailable", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const { prepared, prepareFence } = await protectAndPrepare({
    wiring: context.wiring,
    value: relation,
    operationId: "operation-disable-source",
    attemptId: attemptC
  });
  context.snapshots.delete(relationId);
  const catalogCalls = context.catalogCalls.length;
  const disableFence = fence({
    relationId,
    operationId: "operation-disable",
    attemptId: attemptD,
    expectedHandleDigest: null,
    protectionDigest: null
  });

  const inspection = await context.wiring.runtime.inspect(prepared.handle, {
    fence: disableFence,
    purpose: "disable"
  });
  const stopped = await context.wiring.runtime.stop(prepared.handle, {
    fence: disableFence,
    purpose: "disable"
  });
  assert.equal(inspection.owned, true);
  assert.equal(stopped.containmentConfirmed, true);
  assert.equal(context.catalogCalls.length, catalogCalls);
  assert.equal(context.adapters.length, 1);
  assert.equal(context.adapters[0].calls.at(-2).method, "inspect");
  assert.equal(context.adapters[0].calls.at(-1).method, "stop");
  assert.equal(prepareFence.relationId, relationId);
});

test("a rebuilt wiring does not claim old handles, leases, or cleanup ownership", async () => {
  const relation = snapshot();
  const first = harness([relation]);
  const { prepared } = await protectAndPrepare({
    wiring: first.wiring,
    value: relation,
    operationId: "operation-old",
    attemptId: attemptD
  });
  const second = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const disableFence = fence({
    relationId,
    operationId: "operation-new-disable",
    attemptId: attemptE,
    expectedHandleDigest: null,
    protectionDigest: null
  });

  assert.deepEqual(
    await second.wiring.runtime.inspect(prepared.handle, {
      fence: disableFence,
      purpose: "disable"
    }),
    { owned: false, reason: "runtime_ownership_unconfirmed" }
  );
  await assert.rejects(
    second.wiring.runtime.stop(prepared.handle, {
      fence: disableFence,
      purpose: "disable"
    }),
    { code: "runtime_ownership_unconfirmed" }
  );
  await assert.rejects(
    second.wiring.runtime.go(prepared.lease, { fence: disableFence }),
    { code: "runtime_ownership_unconfirmed" }
  );
  await assert.rejects(
    second.wiring.runtime.abort(prepared.lease, { fence: disableFence }),
    { code: "runtime_ownership_unconfirmed" }
  );
  const cleanup = await second.wiring.runtime.inspect(prepared.handle, {
    fence: disableFence,
    purpose: "cleanup"
  });
  assert.equal(cleanup.disposition, "unconfirmed");
  assert.equal(cleanup.runtimeInvoked, false);
  assert.equal(cleanup.exactHandleIdentity, null);
});

test("a changed configuration creates a new adapter without replacing the old owner", async () => {
  const relation = snapshot();
  const context = harness([relation]);
  const relationId = relation.binding.identity.relationId;
  const first = await protectAndPrepare({
    wiring: context.wiring,
    value: relation,
    operationId: "operation-first-config",
    attemptId: attemptC
  });
  const changed = structuredClone(relation);
  changed.directoryRoot.canonicalRoot = join(fixtureRoot, "relation-a-changed");
  context.snapshots.set(relationId, changed);
  const second = await protectAndPrepare({
    wiring: context.wiring,
    value: changed,
    operationId: "operation-second-config",
    attemptId: attemptE
  });

  assert.equal(context.adapters.length, 2);
  assert.notEqual(context.adapters[0], context.adapters[1]);
  const disableFence = fence({
    relationId,
    operationId: "operation-old-disable",
    attemptId: attemptA,
    expectedHandleDigest: null,
    protectionDigest: null
  });
  await context.wiring.runtime.stop(first.prepared.handle, {
    fence: disableFence,
    purpose: "disable"
  });
  assert.equal(context.adapters[0].calls.at(-1).method, "stop");
  assert.equal(second.prepared.handle.relationId, relationId);
});
