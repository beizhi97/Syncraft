import assert from "node:assert/strict";
import {
  link as fsLink,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  DIRECTORY_ROOT_MARKER_NAME,
  DirectoryRootGuardError,
  checkDirectoryRoot,
  commitDirectoryRootRegistration,
  prepareDirectoryRootRegistration
} from "../src/core/directoryRootGuard.js";
import { canonicalJson } from "../src/core/enrollmentProtocol.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMP_BASE = join(PROJECT_ROOT, ".tmp", "directory-root-guard-tests");
const SERVER_ID = `srv_${"a".repeat(24)}`;
const SHARE_ID = `shr_${"b".repeat(24)}`;
const NOW_MS = 1_760_000_000_000;
const WIN32_DEPS = Object.freeze({ platform: "win32" });

await mkdir(TEMP_BASE, { recursive: true });

after(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
});

async function makeCase(t, label) {
  const caseRoot = await mkdtemp(join(TEMP_BASE, `${label}-`));
  t.after(async () => {
    await rm(caseRoot, { recursive: true, force: true });
  });
  return caseRoot;
}

async function prepare(rootPath, testDependencies = WIN32_DEPS, nowMs = NOW_MS) {
  return prepareDirectoryRootRegistration(
    {
      rootPath,
      serverId: SERVER_ID,
      shareId: SHARE_ID
    },
    {
      nowMs,
      testDependencies
    }
  );
}

async function commit(pending, testDependencies = WIN32_DEPS, nowMs = NOW_MS + 1000) {
  return commitDirectoryRootRegistration(pending, {
    nowMs,
    testDependencies
  });
}

async function register(rootPath, testDependencies = WIN32_DEPS) {
  const pending = await prepare(rootPath, testDependencies);
  return commit(pending, testDependencies);
}

async function expectGuardError(promise, code, reviewRequired) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DirectoryRootGuardError);
    assert.equal(error.code, code);
    if (reviewRequired !== undefined) {
      assert.equal(error.reviewRequired, reviewRequired);
    }
    return true;
  });
}

function markerBytes(record) {
  return Buffer.from(canonicalJson(record.marker.content), "utf8");
}

function expectedRootEntries(pending) {
  return [DIRECTORY_ROOT_MARKER_NAME, pending.stage.name].sort();
}
function withFs(fs, extra = {}) {
  return {
    platform: "win32",
    fs,
    ...extra
  };
}

function escapeMountInfo(value) {
  return String(value).replace(/[\\ \t\n]/g, (character) => {
    const code = character.charCodeAt(0).toString(8).padStart(3, "0");
    return `\\${code}`;
  });
}

function mountLine(id, parentId, mountPoint, source = "fixture-source") {
  return `${id} ${parentId} 0:${id} / ${escapeMountInfo(mountPoint)} rw - ext4 ${escapeMountInfo(source)} rw`;
}

test("prepare is read-only and returns a pending record", async (t) => {
  const caseRoot = await makeCase(t, "prepare");
  const before = await readdir(caseRoot);
  const pending = await prepare(caseRoot);
  const afterPrepare = await readdir(caseRoot);

  assert.deepEqual(afterPrepare, before);
  assert.equal(pending.status, "pending");
  assert.equal(pending.canonicalRoot, caseRoot);
  assert.equal(pending.marker.name, DIRECTORY_ROOT_MARKER_NAME);
  assert.equal(pending.stage.name, `.syncraft-root.stage-${pending.operationId}`);
  assert.equal(pending.rootIdentity.dev, (await readFileIdentity(caseRoot)).dev);
  assert.equal(pending.rootIdentity.ino, (await readFileIdentity(caseRoot)).ino);

  await expectGuardError(
    checkDirectoryRoot(pending, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_not_ready"
  );
});

test("commit creates the marker, retains the stage, and supports JSON reload", async (t) => {
  const caseRoot = await makeCase(t, "commit");
  const pending = JSON.parse(JSON.stringify(await prepare(caseRoot)));
  const active = await commit(pending);
  const reloaded = JSON.parse(JSON.stringify(active));
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);

  assert.equal(active.status, "active");
  assert.equal(active.rootId, pending.rootId);
  assert.equal(active.markerSync.fileSynced, true);
  assert.deepEqual(await readdir(caseRoot), expectedRootEntries(pending));
  assert.deepEqual(await readFile(markerPath), markerBytes(pending));

  const readCheck = await checkDirectoryRoot(reloaded, {
    operation: "read",
    testDependencies: WIN32_DEPS
  });
  assert.equal(readCheck.ok, true);
  assert.equal(readCheck.rootId, active.rootId);
  assert.equal(readCheck.markerIdentity.ino, active.markerIdentity.ino);

  const writeCheck = await checkDirectoryRoot(reloaded, {
    operation: "write",
    requiredBytes: "0",
    reserveBytes: "0",
    testDependencies: WIN32_DEPS
  });
  assert.equal(writeCheck.operation, "write");
});

test("the same pending commit is idempotent after marker installation", async (t) => {
  const caseRoot = await makeCase(t, "idempotent");
  const pending = await prepare(caseRoot);
  const first = await commit(pending);
  const second = await commit(pending, WIN32_DEPS, NOW_MS + 5000);

  assert.equal(second.status, "active");
  assert.equal(second.rootId, first.rootId);
  assert.equal(second.markerIdentity.dev, first.markerIdentity.dev);
  assert.equal(second.markerIdentity.ino, first.markerIdentity.ino);
  assert.deepEqual(await readdir(caseRoot), expectedRootEntries(pending));
});

test("marker-only recovery reuses the same pending without recreating the stage", async (t) => {
  const caseRoot = await makeCase(t, "marker-only-recovery");
  const pending = await prepare(caseRoot);
  const first = await commit(pending);
  const stagePath = join(caseRoot, pending.stage.name);
  await unlink(stagePath);

  const recovered = await commit(pending, WIN32_DEPS, NOW_MS + 6000);

  assert.equal(recovered.status, "active");
  assert.equal(recovered.rootId, first.rootId);
  assert.deepEqual(await readdir(caseRoot), [DIRECTORY_ROOT_MARKER_NAME]);
  await assert.rejects(readFile(stagePath), { code: "ENOENT" });
});
test("a fully synced stage resumes after a pre-install crash", async (t) => {
  const caseRoot = await makeCase(t, "stage-resume");
  const pending = await prepare(caseRoot);
  const stagePath = join(caseRoot, pending.stage.name);

  await expectGuardError(
    commit(pending, withFs({
      link: async () => {
        const error = new Error("simulated pre-install crash");
        error.code = "ESIMULATEDCRASH";
        throw error;
      }
    })),
    "directory_root_registration_review_required",
    true
  );
  assert.deepEqual(await readFile(stagePath), markerBytes(pending));
  assert.deepEqual(await readdir(caseRoot), [pending.stage.name]);

  const active = await commit(pending);
  assert.equal(active.status, "active");
  assert.deepEqual(await readdir(caseRoot), expectedRootEntries(pending));
});

test("unsupported hard-link installation fails closed and preserves the stage", async (t) => {
  const caseRoot = await makeCase(t, "link-unsupported");
  const pending = await prepare(caseRoot);
  const stagePath = join(caseRoot, pending.stage.name);

  await expectGuardError(
    commit(pending, withFs({
      link: async () => {
        const error = new Error("hard links unsupported");
        error.code = "EPERM";
        throw error;
      }
    })),
    "directory_root_registration_review_required",
    true
  );

  assert.deepEqual(await readFile(stagePath), markerBytes(pending));
  await assert.rejects(readFile(join(caseRoot, DIRECTORY_ROOT_MARKER_NAME)), {
    code: "ENOENT"
  });
});

test("an incomplete stage is blocked and never silently repaired", async (t) => {
  const caseRoot = await makeCase(t, "incomplete-stage");
  const pending = await prepare(caseRoot);
  const stagePath = join(caseRoot, pending.stage.name);
  const incomplete = Buffer.from("{\"partial\":", "utf8");
  await writeFile(stagePath, incomplete, { mode: 0o600 });

  await expectGuardError(
    commit(pending),
    "directory_root_registration_incomplete",
    true
  );
  assert.deepEqual(await readFile(stagePath), incomplete);

  await expectGuardError(
    commit(pending),
    "directory_root_registration_incomplete",
    true
  );
  assert.deepEqual(await readFile(stagePath), incomplete);
});

test("oversized marker or stage is rejected before an unbounded read", async (t) => {
  const caseRoot = await makeCase(t, "oversized-stage");
  const pending = await prepare(caseRoot);
  const stagePath = join(caseRoot, pending.stage.name);
  const expectedLength = Number(pending.marker.contentLength);
  await writeFile(stagePath, Buffer.alloc(expectedLength + 1, 0x20), { mode: 0o600 });
  let stageOpenCalls = 0;

  await expectGuardError(
    commit(pending, withFs({
      open: async (filePath, flags, mode) => {
        if (filePath === stagePath) {
          stageOpenCalls += 1;
        }
        return mode === undefined
          ? fsOpen(filePath, flags)
          : fsOpen(filePath, flags, mode);
      }
    })),
    "directory_root_registration_incomplete",
    true
  );

  assert.equal(stageOpenCalls, 0);
  assert.equal((await readFile(stagePath)).length, expectedLength + 1);
});

test("a directory-sync failure after installation remains resumable", async (t) => {
  const caseRoot = await makeCase(t, "directory-sync-failure");
  const pending = await prepare(caseRoot);
  let injected = false;

  await expectGuardError(
    commit(pending, withFs({
      open: async (filePath, flags, mode) => {
        if (!injected && filePath === caseRoot && flags === "r") {
          injected = true;
          const error = new Error("simulated directory sync failure");
          error.code = "EIO";
          throw error;
        }
        return mode === undefined
          ? fsOpen(filePath, flags)
          : fsOpen(filePath, flags, mode);
      }
    })),
    "directory_root_registration_review_required",
    true
  );

  assert.equal(injected, true);
  assert.deepEqual(
    (await readdir(caseRoot)).sort(),
    [DIRECTORY_ROOT_MARKER_NAME, pending.stage.name].sort()
  );

  const active = await commit(pending);
  assert.equal(active.status, "active");
  assert.deepEqual(await readdir(caseRoot), expectedRootEntries(pending));
});

test("link-time stage replacement cannot activate and preserves every object", async (t) => {
  const caseRoot = await makeCase(t, "link-stage-replacement");
  const pending = await prepare(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const stagePath = join(caseRoot, pending.stage.name);
  const backupPath = join(caseRoot, "verified-stage-backup");
  const unknown = Buffer.from("UNKNOWN STAGE REPLACEMENT", "utf8");

  await expectGuardError(
    commit(pending, withFs({
      link: async (source, destination) => {
        await rename(source, backupPath);
        await writeFile(source, unknown, { mode: 0o600 });
        await fsLink(source, destination);
      }
    })),
    "directory_root_marker_collision",
    true
  );

  assert.deepEqual(await readFile(markerPath), unknown);
  assert.deepEqual(await readFile(stagePath), unknown);
  assert.deepEqual(await readFile(backupPath), markerBytes(pending));
});

test("same-content marker installation from a different inode is rejected", async (t) => {
  const caseRoot = await makeCase(t, "same-content-inode");
  const pending = await prepare(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const stagePath = join(caseRoot, pending.stage.name);
  const replacementPath = join(caseRoot, "same-content-replacement");
  await writeFile(replacementPath, markerBytes(pending), { mode: 0o600 });

  await expectGuardError(
    commit(pending, withFs({
      link: async (_source, destination) => {
        await fsLink(replacementPath, destination);
      }
    })),
    "directory_root_marker_collision",
    true
  );

  assert.deepEqual(await readFile(markerPath), markerBytes(pending));
  assert.deepEqual(await readFile(stagePath), markerBytes(pending));
  assert.deepEqual(await readFile(replacementPath), markerBytes(pending));
});

test("replacing the stage after hard-link installation never deletes the replacement", async (t) => {
  const caseRoot = await makeCase(t, "post-link-stage-replacement");
  const pending = await prepare(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const stagePath = join(caseRoot, pending.stage.name);
  const backupPath = join(caseRoot, "post-link-stage-backup");
  const replacement = Buffer.from("POST LINK STAGE REPLACEMENT", "utf8");

  const active = await commit(pending, withFs({
    link: async (source, destination) => {
      await fsLink(source, destination);
      await rename(source, backupPath);
      await writeFile(source, replacement, { mode: 0o600 });
    }
  }));

  assert.equal(active.status, "active");
  assert.deepEqual(await readFile(markerPath), markerBytes(pending));
  assert.deepEqual(await readFile(backupPath), markerBytes(pending));
  assert.deepEqual(await readFile(stagePath), replacement);
});

test("marker replacement during directory sync prevents activation", async (t) => {
  const caseRoot = await makeCase(t, "sync-marker-replacement");
  const pending = await prepare(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const backupPath = join(caseRoot, "pre-sync-marker-inode");
  const original = markerBytes(pending);
  let replaced = false;

  await expectGuardError(
    commit(pending, withFs({
      open: async (filePath, flags, mode) => {
        if (!replaced && filePath === caseRoot && flags === "r") {
          replaced = true;
          await rename(markerPath, backupPath);
          await writeFile(markerPath, original);
        }
        return mode === undefined
          ? fsOpen(filePath, flags)
          : fsOpen(filePath, flags, mode);
      }
    })),
    "directory_root_marker_collision",
    true
  );

  assert.equal(replaced, true);
  assert.deepEqual(await readFile(markerPath), original);
  assert.deepEqual(await readFile(backupPath), original);
  assert.deepEqual(await readFile(join(caseRoot, pending.stage.name)), original);
});
test("an unknown marker is never overwritten or deleted", async (t) => {
  const caseRoot = await makeCase(t, "unknown-marker");
  const pending = await prepare(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const unknown = Buffer.from("unknown marker", "utf8");
  await writeFile(markerPath, unknown);

  await expectGuardError(
    commit(pending),
    "directory_root_marker_collision",
    true
  );

  assert.deepEqual(await readFile(markerPath), unknown);
  assert.deepEqual(await readdir(caseRoot), [DIRECTORY_ROOT_MARKER_NAME]);
});

test("marker deletion denies access and is never repaired by checks", async (t) => {
  const caseRoot = await makeCase(t, "marker-deletion");
  const active = await register(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  await unlink(markerPath);

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_marker_missing"
  );
  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_marker_missing"
  );

  assert.deepEqual(await readdir(caseRoot), [active.stage.name]);
});

test("marker content and file-identity replacement are both denied", async (t) => {
  const caseRoot = await makeCase(t, "marker-replacement");
  const active = await register(caseRoot);
  const markerPath = join(caseRoot, DIRECTORY_ROOT_MARKER_NAME);
  const original = await readFile(markerPath);
  await writeFile(markerPath, Buffer.from("tampered marker", "utf8"));

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_marker_mismatch"
  );

  await rename(markerPath, join(caseRoot, "marker-original-inode"));
  await writeFile(markerPath, original);

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_marker_mismatch"
  );
});

test("root replacement and symlink or junction replacement are denied", async (t) => {
  const caseRoot = await makeCase(t, "root-replacement");
  const rootPath = join(caseRoot, "root");
  const movedRoot = join(caseRoot, "root-moved");
  await mkdir(rootPath);
  const active = await register(rootPath);
  await rename(rootPath, movedRoot);
  await mkdir(rootPath);

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_replaced"
  );

  const symlinkCase = await makeCase(t, "root-link");
  const linkRoot = join(symlinkCase, "root");
  const linkTarget = join(symlinkCase, "target");
  await mkdir(linkRoot);
  const linkActive = await register(linkRoot);
  await rename(linkRoot, linkTarget);
  try {
    await symlink(linkTarget, linkRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.diagnostic(`symlink/junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await expectGuardError(
    checkDirectoryRoot(linkActive, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_link_denied"
  );
});

test("Linux mount evidence selects the deepest escaped path and rejects adjacent prefixes", async (t) => {
  const caseRoot = await makeCase(t, "linux-mount");
  const rootPath = join(caseRoot, "root with space");
  await mkdir(rootPath);
  const parent = dirname(rootPath);
  const adjacent = `${rootPath}-adjacent`;
  const child = join(rootPath, "nested-mount");
  const fixture = [
    mountLine("10", "1", parent),
    mountLine("11", "1", adjacent),
    mountLine("20", "10", child),
    mountLine("30", "10", rootPath)
  ].join("\n");
  const deps = {
    platform: "linux",
    readMountInfo: async () => fixture
  };

  const pending = await prepare(rootPath, deps);
  assert.equal(pending.mountEvidence.mountId, "30");
  assert.equal(pending.mountEvidence.mountPoint, rootPath);
  const active = await commit(pending, deps);
  const result = await checkDirectoryRoot(active, {
    operation: "read",
    testDependencies: deps
  });
  assert.equal(result.mountEvidence.mountId, "30");

  const adjacentRoot = join(caseRoot, "adjacent-root");
  await mkdir(adjacentRoot);
  await expectGuardError(
    prepare(adjacentRoot, {
      platform: "linux",
      readMountInfo: async () => mountLine("40", "1", `${adjacentRoot}-adjacent`)
    }),
    "directory_root_mount_unavailable"
  );
});

test("mount evidence unavailability and mount changes fail closed", async (t) => {
  const caseRoot = await makeCase(t, "mount-change");
  const fixtureA = mountLine("50", "1", caseRoot);
  const fixtureB = mountLine("51", "1", caseRoot);
  const depsA = {
    platform: "linux",
    readMountInfo: async () => fixtureA
  };
  const active = await register(caseRoot, depsA);

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: {
        platform: "linux",
        readMountInfo: async () => fixtureB
      }
    }),
    "directory_root_mount_changed"
  );
  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: {
        platform: "linux",
        readMountInfo: async () => {
          const error = new Error("mountinfo unavailable");
          error.code = "EACCES";
          throw error;
        }
      }
    }),
    "directory_root_mount_unavailable"
  );
});

test("permission and free-space evidence failures have explicit error states", async (t) => {
  const caseRoot = await makeCase(t, "checks");
  const active = await register(caseRoot);

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: withFs({
        access: async () => {
          const error = new Error("permission denied");
          error.code = "EACCES";
          throw error;
        }
      })
    }),
    "directory_root_permission_denied"
  );

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "read",
      testDependencies: withFs({
        statfs: async () => {
          const error = new Error("statfs failed");
          error.code = "EIO";
          throw error;
        }
      })
    }),
    "directory_root_space_unavailable"
  );

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "write",
      requiredBytes: "0",
      reserveBytes: "1",
      testDependencies: withFs({
        statfs: async () => ({ bavail: 0n, bsize: 1n })
      })
    }),
    "directory_root_space_insufficient"
  );

  await expectGuardError(
    checkDirectoryRoot(active, {
      operation: "write",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_input_invalid"
  );
});

test("invalid and pending records are rejected before directory access", async (t) => {
  const caseRoot = await makeCase(t, "record-validation");
  const pending = await prepare(caseRoot);
  const active = await commit(pending);
  const missingField = structuredClone(active);
  delete missingField.markerSync;
  const badStatus = structuredClone(active);
  badStatus.status = "unknown";

  await expectGuardError(
    checkDirectoryRoot(missingField, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_record_invalid"
  );
  await expectGuardError(
    checkDirectoryRoot(badStatus, {
      operation: "read",
      testDependencies: WIN32_DEPS
    }),
    "directory_root_record_invalid"
  );
});

test("checks inspect only the root and marker, never nested content", async (t) => {
  const caseRoot = await makeCase(t, "no-recursion");
  const nested = join(caseRoot, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "sentinel"), "not traversed");
  const active = await register(caseRoot);
  const inspected = [];

  const result = await checkDirectoryRoot(active, {
    operation: "traverse",
    testDependencies: withFs({
      lstat: async (filePath, options) => {
        inspected.push(filePath);
        const { lstat } = await import("node:fs/promises");
        return lstat(filePath, options);
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(inspected.some((filePath) => filePath.startsWith(`${nested}`)), false);
});

test("options use input errors and unknown fields are rejected", async (t) => {
  const caseRoot = await makeCase(t, "options");
  await expectGuardError(
    prepareDirectoryRootRegistration(
      {
        rootPath: caseRoot,
        serverId: SERVER_ID,
        shareId: SHARE_ID
      },
      {
        unexpected: true
      }
    ),
    "directory_root_input_invalid"
  );
  await expectGuardError(
    prepareDirectoryRootRegistration(
      {
        rootPath: caseRoot,
        serverId: SERVER_ID
      },
      {}
    ),
    "directory_root_input_invalid"
  );
});

async function readFileIdentity(filePath) {
  const { lstat } = await import("node:fs/promises");
  const stat = await lstat(filePath, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString()
  };
}
