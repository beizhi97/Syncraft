import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listFirstBisyncConflictOperations,
  previewFirstBisyncConflicts,
  resumeFirstBisyncConflictSave,
  saveFirstBisyncConflicts,
  verifyFirstBisyncConflictsSaved
} from "../client/src/firstBisyncConflict.js";

async function setup({ localBytes = Buffer.from("local first version\n"), remoteBytes = Buffer.from("remote distinct version\n") } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-first-conflict-"));
  const localRoot = join(root, "sync-root");
  const workdir = join(root, "runtime", "bisync", "relation");
  const stagingRoot = join(root, "protected", "staging");
  const conflictStateFile = join(root, "protected", "conflicts.json");
  await Promise.all([mkdir(localRoot), mkdir(workdir, { recursive: true }), mkdir(stagingRoot, { recursive: true })]);
  await writeFile(join(localRoot, "nested", "same.txt"), localBytes).catch(async () => {
    await mkdir(join(localRoot, "nested"), { recursive: true });
    await writeFile(join(localRoot, "nested", "same.txt"), localBytes);
  });
  const remoteFiles = new Map([["nested/same.txt", remoteBytes]]);
  const state = { manifest: null, calls: [], protectedStages: new Set(), failOnProtectedWrite: 0, protectedWrites: 0 };
  const relation = {
    schemaVersion: 1,
    direction: "bidirectional",
    backend: "sftp",
    identityAssurance: "trusted-binding",
    rootAttested: true,
    trustedBindingId: "a".repeat(64),
    relationId: "rel_first_conflict_123",
    baselineId: "b".repeat(64),
    baselineEpoch: 1,
    rootId: "root_0123456789abcdef",
    authorization: { directions: ["bidirectional"], allowDelete: true },
    filters: { exclude: [] },
    localRoot: localRoot.toLowerCase(),
    rclone: { remotePath: "sfsc_test:", workdir }
  };
  const job = { direction: "bidirectional", storageBackend: "sftp", localPath: localRoot, syncRelation: relation };
  const runBuffered = async (_exe, args) => {
    state.calls.push([...args]);
    if (args[0] === "lsjson") {
      const rows = [...remoteFiles.entries()].map(([Path, bytes]) => ({ Path, Size: bytes.length, IsDir: false }));
      return { ok: true, stdout: JSON.stringify(rows), stderr: "" };
    }
    if (args[0] === "hashsum") {
      const path = args[2].slice("sfsc_test:".length);
      const bytes = remoteFiles.get(path);
      if (!bytes) return { ok: false, stdout: "", stderr: "missing" };
      return { ok: true, stdout: `${sha256(bytes)}  ${args[2]}\n`, stderr: "" };
    }
    if (args[0] === "copyto") {
      const source = args[1].slice("sfsc_test:".length);
      const bytes = remoteFiles.get(source);
      if (!bytes) return { ok: false, stdout: "", stderr: "missing" };
      await writeFile(args[2], bytes);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected command ${args[0]}` };
  };
  const options = {
    job, relation, localRoot, workdir, stagingRoot, conflictStateFile,
    readProtected: async () => structuredClone(state.manifest),
    writeProtected: async (_file, value) => {
      state.protectedWrites += 1;
      if (state.failOnProtectedWrite === state.protectedWrites) throw new Error("injected protected write failure");
      state.manifest = structuredClone(value);
    },
    protectStagingFile: async path => { state.protectedStages.add(path); },
    runBuffered, rcloneExe: "rclone", rcloneConfigFile: join(root, "rclone.conf"), env: {}, cwd: root
  };
  return { root, localRoot, relation, job, localBytes, remoteBytes, remoteFiles, state, options,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

test("first bisync conflict copies both versions before initialization and verifies them", async () => {
  const fixture = await setup();
  try {
    const preview = await previewFirstBisyncConflicts(fixture.options);
    assert.equal(preview.conflicts.length, 1);
    assert.equal(preview.conflicts[0].path, "nested/same.txt");
    assert.equal(preview.conflicts[0].localHash, sha256(fixture.localBytes));
    assert.equal(preview.conflicts[0].remoteHash, sha256(fixture.remoteBytes));
    assert.notEqual(preview.conflicts[0].localTarget, preview.conflicts[0].remoteTarget);
    assert.ok([...fixture.state.protectedStages].length >= 2);

    const saved = await saveFirstBisyncConflicts({ ...fixture.options, previewId: preview.previewId });
    assert.equal(saved.status, "saved");
    assert.equal(fixture.state.manifest.operations[0].status, "saved");
    const localCopy = await readFile(join(fixture.localRoot, ...saved.conflicts[0].localTarget.split("/")));
    const remoteCopy = await readFile(join(fixture.localRoot, ...saved.conflicts[0].remoteTarget.split("/")));
    assert.deepEqual([sha256(localCopy), sha256(remoteCopy)].sort(), [sha256(fixture.localBytes), sha256(fixture.remoteBytes)].sort());
    const receipt = await verifyFirstBisyncConflictsSaved({ ...fixture.options, operationId: preview.operationId });
    assert.equal(receipt.status, "ready-for-initialization");
  } finally {
    await fixture.cleanup();
  }
});

test("journal resume accepts only exact copies after a crash and rejects unknown targets", async () => {
  const fixture = await setup();
  try {
    const preview = await previewFirstBisyncConflicts(fixture.options);
    fixture.state.failOnProtectedWrite = 2;
    await assert.rejects(saveFirstBisyncConflicts({ ...fixture.options, previewId: preview.previewId }), /injected protected write failure/);
    assert.equal(fixture.state.manifest.operations[0].status, "saving");
    const afterRestart = await listFirstBisyncConflictOperations(fixture.options);
    assert.equal(afterRestart.length, 1);
    assert.equal(afterRestart[0].operationId, preview.operationId);
    assert.equal(afterRestart[0].status, "saving");
    assert.ok(afterRestart[0].conflicts.length > 0);
    fixture.state.failOnProtectedWrite = 0;
    const resumed = await resumeFirstBisyncConflictSave({ ...fixture.options, operationId: preview.operationId });
    assert.equal(resumed.status, "saved");

    const other = await setup();
    try {
      const collisionPreview = await previewFirstBisyncConflicts(other.options);
      const expectedTarget = join(other.localRoot, ...collisionPreview.conflicts[0].localTarget.split("/"));
      await mkdir(join(other.localRoot, "nested"), { recursive: true });
      await writeFile(expectedTarget, "unknown content");
      await assert.rejects(saveFirstBisyncConflicts({ ...other.options, previewId: collisionPreview.previewId }), error => error.code === "first_sync_conflict_target_exists");
      await assert.rejects(resumeFirstBisyncConflictSave({ ...other.options, operationId: collisionPreview.operationId }), error => error.code === "first_sync_conflict_target_exists");
      assert.equal(await readFile(expectedTarget, "utf8"), "unknown content");
    } finally {
      await other.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("first conflict scan refuses initialized baselines, existing listing files, and excluded relations", async () => {
  const fixture = await setup();
  try {
    await assert.rejects(previewFirstBisyncConflicts({ ...fixture.options, baselineEntry: { initializedAt: "now" } }), error => error.code === "first_sync_conflict_review_required");
    const stem = `${fixture.localRoot.replace(/[\\/:]/g, "_")}..${fixture.relation.rclone.remotePath.replace(/[\\/:]/g, "_")}`;
    await writeFile(join(fixture.relation.rclone.workdir, `${stem}.path1.lst`), "existing listing");
    await assert.rejects(previewFirstBisyncConflicts(fixture.options), error => error.code === "first_sync_conflict_review_required");
    await rm(join(fixture.relation.rclone.workdir, `${stem}.path1.lst`));
    fixture.relation.filters.exclude.push("*.secret");
    await assert.rejects(previewFirstBisyncConflicts(fixture.options), error => error.code === "first_sync_conflict_review_required");
  } finally {
    await fixture.cleanup();
  }
});

test("pre-initialization verification catches conflicts introduced after an empty preview", async () => {
  const same = Buffer.from("same at preview\n");
  const fixture = await setup({ localBytes: same, remoteBytes: same });
  try {
    const preview = await previewFirstBisyncConflicts(fixture.options);
    assert.equal(preview.conflicts.length, 0);
    const saved = await saveFirstBisyncConflicts({ ...fixture.options, previewId: preview.previewId });
    assert.equal(saved.status, "saved");
    await writeFile(join(fixture.localRoot, "nested", "same.txt"), "changed on one side\n");
    await assert.rejects(
      verifyFirstBisyncConflictsSaved({ ...fixture.options, operationId: preview.operationId }),
      error => error.code === "first_sync_conflict_set_changed"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("pre-initialization verification requires a new saved set when a conflict appears after saving", async () => {
  const fixture = await setup();
  try {
    const firstPreview = await previewFirstBisyncConflicts(fixture.options);
    await saveFirstBisyncConflicts({ ...fixture.options, previewId: firstPreview.previewId });
    await writeFile(join(fixture.localRoot, "nested", "second.txt"), "new local second version\n");
    fixture.remoteFiles.set("nested/second.txt", Buffer.from("new remote second version\n"));
    await assert.rejects(
      verifyFirstBisyncConflictsSaved({ ...fixture.options, operationId: firstPreview.operationId }),
      error => error.code === "first_sync_conflict_set_changed"
    );

    const refreshed = await previewFirstBisyncConflicts(fixture.options);
    assert.equal(refreshed.conflicts.length, 2);
    await saveFirstBisyncConflicts({ ...fixture.options, previewId: refreshed.previewId });
    const receipt = await verifyFirstBisyncConflictsSaved({ ...fixture.options, operationId: refreshed.operationId });
    assert.equal(receipt.conflicts.length, 2);
    assert.equal(fixture.state.manifest.operations.length, 2);
  } finally {
    await fixture.cleanup();
  }
});
