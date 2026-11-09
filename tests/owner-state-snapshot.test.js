import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOwnerAdmissionCore } from "../src/service/ownerAdmissionCore.js";
import { createOwnerStateSnapshotGate } from "../src/service/ownerStateSnapshot.js";
import { evaluateOwnerLockCompatibility } from "../src/service/ownerLockCompatibility.js";
import {
  loadOwnerLockBinding,
  loadOwnerStateSnapshotBinding
} from "../src/service/ownerLockBinding.js";
import {
  assertSafeDirectory,
  ensureSafeDirectory
} from "../scripts/lib/owner-lock-evidence-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const statePath = "/srv/sfsc/relation-services.json";
const evidence = Object.freeze({
  schemaVersion: "1",
  statePath,
  parentDev: "12",
  parentIno: "34",
  lockDev: "56",
  lockIno: "78"
});
const verification = Object.freeze({ ...evidence, valid: true });
const canonicalState = Buffer.from(JSON.stringify({
  version: 1,
  kind: "relation-file-service-manager-state",
  storageContract:
    "single-manager-owner+injected-scoped-locks+atomic-json-replace-v1",
  revision: 0,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  operations: {},
  relations: {}
}));
const canonicalSha256 = createHash("sha256")
  .update(canonicalState)
  .digest("hex");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasCode(code) {
  return error => error?.code === code;
}

function fakeBinding({
  acquire = () => ({ ...evidence }),
  readSnapshot = () => Buffer.from(canonicalState),
  verify = () => ({ ...verification })
} = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      acquireOwnerLock(input) {
        calls.push({ operation: "acquire", input });
        return acquire(input);
      },
      readOwnerStateSnapshot(input) {
        calls.push({ operation: "snapshot", input });
        return readSnapshot(input);
      },
      verifyOwnerLock(input) {
        calls.push({ operation: "verify", input });
        return verify(input);
      }
    }
  };
}

function createSnapshotCore(binding, options = {}) {
  return createOwnerAdmissionCore({
    binding,
    snapshotEnabled: true,
    ...options
  });
}

function snapshotManifest(overrides = {}) {
  return {
    schemaVersion: "2",
    nativeApiRevision: "2",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    napiVersion: 8,
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === "win32" ? "glibc" : "glibc",
    artifactFile: "placeholder.node",
    artifactSizeBytes: 1,
    artifactSha256: "a".repeat(64),
    ...overrides
  };
}

test("r4 core exposes exact3 and keeps the lease opaque", () => {
  const { binding } = fakeBinding();
  const core = createSnapshotCore(binding);
  assert.deepEqual(Object.keys(core), [
    "acquireOwnerLease",
    "assertOwnerLease",
    "evaluateStartupState"
  ]);
  const lease = core.acquireOwnerLease({ statePath });
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease), []);
  assert.deepEqual(core.assertOwnerLease(lease), verification);
});

test("snapshot consumes once, returns accepted parser output, and leaves verify usable", () => {
  const { binding, calls } = fakeBinding();
  const core = createSnapshotCore(binding);
  const lease = core.acquireOwnerLease({ statePath });
  const result = core.evaluateStartupState(lease);

  assert.equal(result.decision, "historical_closed");
  assert.equal(result.historicalClosureEligible, true);
  assert.equal(result.fullStartupAdmission, false);
  assert.equal(result.rawSha256, canonicalSha256);
  assert.equal(result.observedBytes, canonicalState.length);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(core.assertOwnerLease(lease), verification);

  const snapshotCalls = calls.filter(call => call.operation === "snapshot");
  assert.equal(snapshotCalls.length, 1);
  assert.deepEqual(snapshotCalls[0].input, {
    evidence,
    maxBytes: 16 * 1024 * 1024
  });
  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_state_snapshot_consumed")
  );
  assert.equal(
    calls.filter(call => call.operation === "snapshot").length,
    1
  );
});

test("safe parser blocked output remains a consumed successful gate result", () => {
  const { binding } = fakeBinding({
    readSnapshot: () => Buffer.from("{")
  });
  const core = createSnapshotCore(binding);
  const lease = core.acquireOwnerLease({ statePath });
  const result = core.evaluateStartupState(lease);

  assert.equal(result.decision, "blocked");
  assert.equal(result.code, "startup_quiescence_json_invalid");
  assert.equal(result.fullStartupAdmission, false);
  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_state_snapshot_consumed")
  );
});

test("forged lease rejects before native I/O and does not poison the valid lease", () => {
  const { binding, calls } = fakeBinding();
  const core = createSnapshotCore(binding);
  const lease = core.acquireOwnerLease({ statePath });

  assert.throws(
    () => core.evaluateStartupState(Object.freeze(Object.create(null))),
    hasCode("owner_lock_evidence_invalid")
  );
  assert.equal(
    calls.filter(call => call.operation === "snapshot").length,
    0
  );
  assert.equal(core.evaluateStartupState(lease).fullStartupAdmission, false);
});

test("wrong thread rejects before snapshot I/O", () => {
  let mainThread = true;
  const { binding, calls } = fakeBinding();
  const core = createSnapshotCore(binding, {
    isMainThread: () => mainThread
  });
  const lease = core.acquireOwnerLease({ statePath });
  mainThread = false;

  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_lock_main_thread_required")
  );
  assert.equal(
    calls.filter(call => call.operation === "snapshot").length,
    0
  );
  mainThread = true;
  assert.equal(core.evaluateStartupState(lease).fullStartupAdmission, false);
});

test("snapshot to verify reentry fails sticky even when nested error is caught", () => {
  let core;
  let lease;
  let nestedCode;
  const { binding } = fakeBinding({
    readSnapshot: () => {
      try {
        core.assertOwnerLease(lease);
      } catch (error) {
        nestedCode = error.code;
      }
      return Buffer.from(canonicalState);
    }
  });
  core = createSnapshotCore(binding);
  lease = core.acquireOwnerLease({ statePath });

  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_lock_sticky_invalid")
  );
  assert.equal(nestedCode, "owner_lock_verification_in_progress");
  assert.throws(
    () => core.assertOwnerLease(lease),
    hasCode("owner_lock_sticky_invalid")
  );
});

test("verify to snapshot reentry fails sticky even when result getter catches it", () => {
  let core;
  let lease;
  let trigger = false;
  let nestedCode;
  const { binding } = fakeBinding({
    verify: () => {
      if (!trigger) {
        return { ...verification };
      }
      return {
        schemaVersion: "1",
        get valid() {
          try {
            core.evaluateStartupState(lease);
          } catch (error) {
            nestedCode = error.code;
          }
          return true;
        },
        statePath: evidence.statePath,
        parentDev: evidence.parentDev,
        parentIno: evidence.parentIno,
        lockDev: evidence.lockDev,
        lockIno: evidence.lockIno
      };
    }
  });
  core = createSnapshotCore(binding);
  lease = core.acquireOwnerLease({ statePath });
  trigger = true;

  assert.throws(
    () => core.assertOwnerLease(lease),
    hasCode("owner_lock_sticky_invalid")
  );
  assert.equal(nestedCode, "owner_lock_verification_in_progress");
  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_lock_sticky_invalid")
  );
});

test("cross snapshot reentry remains sticky after normal consumption", () => {
  let core;
  let lease;
  let trigger = false;
  let nestedCode;
  const { binding } = fakeBinding({
    verify: () => {
      if (!trigger) {
        return { ...verification };
      }
      return {
        schemaVersion: "1",
        get valid() {
          try {
            core.evaluateStartupState(lease);
          } catch (error) {
            nestedCode = error.code;
          }
          return true;
        },
        statePath: evidence.statePath,
        parentDev: evidence.parentDev,
        parentIno: evidence.parentIno,
        lockDev: evidence.lockDev,
        lockIno: evidence.lockIno
      };
    }
  });
  core = createSnapshotCore(binding);
  lease = core.acquireOwnerLease({ statePath });
  assert.equal(core.evaluateStartupState(lease).fullStartupAdmission, false);
  trigger = true;

  assert.throws(
    () => core.assertOwnerLease(lease),
    hasCode("owner_lock_sticky_invalid")
  );
  assert.equal(nestedCode, "owner_lock_verification_in_progress");
});

test("native snapshot failure is sticky and never retryable", () => {
  const { binding, calls } = fakeBinding({
    readSnapshot: () => {
      throw codedError("owner_lock_napi_failed");
    }
  });
  const core = createSnapshotCore(binding);
  const lease = core.acquireOwnerLease({ statePath });

  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_lock_napi_failed")
  );
  assert.throws(
    () => core.evaluateStartupState(lease),
    hasCode("owner_lock_sticky_invalid")
  );
  assert.equal(
    calls.filter(call => call.operation === "snapshot").length,
    1
  );
});

test("r4 core rejects an exact2 binding", () => {
  const { binding } = fakeBinding();
  const exactTwo = {
    acquireOwnerLock: binding.acquireOwnerLock,
    verifyOwnerLock: binding.verifyOwnerLock
  };
  assert.throws(
    () => createSnapshotCore(exactTwo),
    hasCode("owner_lock_artifact_invalid")
  );
});

test("schema 2 requires nativeApiRevision 2 and exact keys", () => {
  const runtime = Object.freeze({
    platform: process.platform,
    arch: process.arch,
    napiVersion: Number(process.versions.napi),
    libc: "glibc"
  });
  assert.deepEqual(
    evaluateOwnerLockCompatibility({
      manifest: snapshotManifest(),
      runtime
    }),
    { compatible: true, reason: "compatible" }
  );
  assert.equal(
    evaluateOwnerLockCompatibility({
      manifest: snapshotManifest({ nativeApiRevision: "1" }),
      runtime
    }).reason,
    "manifest_invalid"
  );
  const extra = { ...snapshotManifest(), buildId: "forbidden" };
  assert.equal(
    evaluateOwnerLockCompatibility({ manifest: extra, runtime }).reason,
    "manifest_invalid"
  );
});

test("r3 and r4 loaders reject each other's schema before require", async t => {
  const tempRootChain = await ensureSafeDirectory(root, [".tmp"]);
  const tempRoot = tempRootChain.canonicalTargetPath;
  const createdCaseRoot = await mkdtemp(
    path.join(tempRoot, "snapshot-loader-")
  );
  const caseRootChain = await assertSafeDirectory(
    root,
    [".tmp", path.basename(createdCaseRoot)]
  );
  const caseRoot = caseRootChain.canonicalTargetPath;
  t.after(async () => {
    await assertSafeDirectory(root, [".tmp"]);
    const cleanupCaseChain = await assertSafeDirectory(
      root,
      [".tmp", path.basename(caseRoot)]
    );
    const resolvedCaseRoot = cleanupCaseChain.canonicalTargetPath;
    await rm(resolvedCaseRoot, { recursive: true, force: false });
    await assert.rejects(access(caseRoot), error => error?.code === "ENOENT");
  });

  const artifactPath = path.join(caseRoot, "placeholder.node");
  await writeFile(artifactPath, Buffer.from("x"), { flag: "wx" });
  const schemaOnePath = path.join(caseRoot, "schema1.json");
  const schemaTwoPath = path.join(caseRoot, "schema2.json");
  await writeFile(schemaOnePath, JSON.stringify({
    schemaVersion: "1",
    nodeMajor: 22,
    napiVersion: 8,
    platform: process.platform,
    arch: process.arch,
    libc: "glibc",
    artifactFile: "placeholder.node",
    artifactSizeBytes: 1,
    artifactSha256: "a".repeat(64)
  }), { flag: "wx" });
  await writeFile(schemaTwoPath, JSON.stringify(snapshotManifest()), {
    flag: "wx"
  });

  assert.throws(
    () => loadOwnerStateSnapshotBinding({
      artifactPath,
      manifestPath: schemaOnePath
    }),
    error => error?.code === "owner_lock_artifact_invalid"
  );
  assert.throws(
    () => loadOwnerLockBinding({
      artifactPath,
      manifestPath: schemaTwoPath
    }),
    error => error?.code === "owner_lock_artifact_invalid"
  );
});

test("private real factory has no synthetic injection surface", () => {
  assert.throws(
    () => createOwnerStateSnapshotGate({
      artifactPath: "/missing.node",
      manifestPath: "/missing.json",
      binding: fakeBinding().binding
    }),
    hasCode("owner_lock_input_invalid")
  );
});
