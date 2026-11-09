import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { getFirstBisyncConflictPathsForRelation, getSyncRecoveryPathsForRelation } from "../client/src/paths.js";
import {
  assertClientFirstBisyncConflictOperationsResponseContract,
  assertClientFirstBisyncConflictResumeResponseContract,
  assertClientRecoveryRestoreCancelResponseContract,
  assertClientRecoveryRestorePreviewResponseContract,
  assertClientRecoveryRestoreResponseContract,
  assertClientRecoveryVersionsResponseContract
} from "../scripts/lib/runtimeContracts.mjs";
import {
  completeSyncRecoveryRun,
  isSyncRecoveryPristine,
  listSyncRecoveryVersions,
  markSyncRecoveryRunStarted,
  prepareSyncRecovery,
  previewSyncRecoveryRestore,
  restoreSyncRecoveryVersion,
  verifySyncRecoveryPreflight
} from "../client/src/syncRecovery.js";

const remoteAlias = "sfsc_testalias";

test("first bisync conflict operation APIs expose strict resumable journal fields", () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const operation = { operationId, status: "saving", createdAt: "2026-10-31T12:00:00.000Z", savedAt: "",
    conflicts: [{ path: "nested/file.txt", localHash: "a".repeat(64), remoteHash: "b".repeat(64), localSize: 1,
      remoteSize: 2, localTarget: "nested/sfsc-copy.conflict", remoteTarget: "nested/sfsc-copy-remote.conflict", status: "pending" }] };
  assertClientFirstBisyncConflictOperationsResponseContract({ operations: [operation] });
  assertClientFirstBisyncConflictResumeResponseContract({ saved: operation });
  assert.throws(() => assertClientFirstBisyncConflictOperationsResponseContract({ operations: [
    { ...operation, conflicts: [{ ...operation.conflicts[0], stagedPath: "C:\\private\\stage" }] }
  ] }));
});

test("recovery HTTP contracts expose bounded paths and exact response fields", () => {
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const previewId = "123e4567-e89b-42d3-a456-426614174001";
  const hash = "a".repeat(64);
  assertClientRecoveryVersionsResponseContract({
    jobId: "job-1",
    versions: [{ runId, createdAt: "2026-10-31T12:00:00.000Z", status: "completed", files: [{ side: "path1", path: "nested/file.txt" }] }]
  });
  assertClientRecoveryRestorePreviewResponseContract({
    jobId: "job-1",
    preview: { previewId, runId, side: "path1", path: "nested/file.txt", destinationPath: "nested/file.txt.recovered",
      sourceSha256: hash, expiresAt: "2026-10-31T12:10:00.000Z" }
  });
  assertClientRecoveryRestoreResponseContract({ jobId: "job-1", restored: true, destinationPath: "nested/file.txt.recovered", sourceSha256: hash, runId });
  assertClientRecoveryRestoreCancelResponseContract({ jobId: "job-1", cancelled: true });
  assert.throws(() => assertClientRecoveryVersionsResponseContract({ jobId: "job-1", versions: [], localPath: "C:\\private" }));
  assert.throws(() => assertClientRecoveryRestorePreviewResponseContract({
    jobId: "job-1", preview: { previewId, runId, side: "path1", path: "nested/file.txt", destinationPath: "C:\\private\\x",
      sourceSha256: hash, expiresAt: "2026-10-31T12:10:00.000Z", stagedPath: "C:\\private\\stage" }
  }));
});

test("recovery journal and staging paths are isolated by relation, baseline, and root", () => {
  const paths = { dataRoot: "C:\\Syncraft\\data" };
  const first = { relationId: "relation-one", baselineId: "a".repeat(64), rootId: "root_0123456789abcdef" };
  const second = { ...first, relationId: "relation-two" };
  assert.deepEqual(getSyncRecoveryPathsForRelation(first, paths), getSyncRecoveryPathsForRelation(first, paths));
  assert.notEqual(getSyncRecoveryPathsForRelation(first, paths).stateFile, getSyncRecoveryPathsForRelation(second, paths).stateFile);
  assert.notEqual(getSyncRecoveryPathsForRelation(first, paths).stagingRoot, getSyncRecoveryPathsForRelation({ ...first, rootId: "root_fedcba9876543210" }, paths).stagingRoot);
  assert.notEqual(getFirstBisyncConflictPathsForRelation(first, paths).stateFile, getFirstBisyncConflictPathsForRelation(second, paths).stateFile);
  assert.notEqual(getFirstBisyncConflictPathsForRelation(first, paths).stagingRoot, getFirstBisyncConflictPathsForRelation({ ...first, baselineId: "b".repeat(64) }, paths).stagingRoot);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sfsc-sync-recovery-"));
  const localRoot = join(root, "sync-root");
  const workdir = join(root, "runtime", "bisync", "relation");
  const recoveryStateFile = join(root, "protected", "recovery.json");
  await Promise.all([mkdir(localRoot), mkdir(workdir, { recursive: true })]);
  const relation = {
    schemaVersion: 1,
    direction: "bidirectional",
    backend: "sftp",
    identityAssurance: "trusted-binding",
    rootAttested: true,
    trustedBindingId: "a".repeat(64),
    relationId: "rel_test_relation_123456",
    baselineId: "b".repeat(64),
    baselineEpoch: 1,
    rootId: "root_0123456789abcdef",
    authorization: { directions: ["bidirectional"], allowDelete: true },
    localRoot: localRoot.toLowerCase(),
    rclone: { remotePath: `${remoteAlias}:`, workdir }
  };
  const job = { direction: "bidirectional", storageBackend: "sftp", localPath: localRoot, syncRelation: relation };
  const state = { remoteFiles: new Map(), remoteDirs: new Set(), protected: null, protectedStages: new Set(), calls: [], failCommand: "" };
  const runBuffered = async (_exe, args) => {
    state.calls.push([...args]);
    const command = args[0];
    const target = args[1];
    if (state.failCommand === command) {
      state.failCommand = "";
      return { ok: false, stdout: "", stderr: "injected failure" };
    }
    if (command === "lsjson") {
      const dirsOnly = args.includes("--dirs-only");
      const recursive = args.includes("--recursive");
      const rows = listMockRemote(state, target, { dirsOnly, recursive });
      return { ok: true, stdout: JSON.stringify(rows), stderr: "" };
    }
    if (command === "mkdir") {
      addRemoteDir(state, target);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (command === "copyto") {
      const destination = args[2];
      const bytes = await readSource(state, target);
      if (destination.startsWith(`${remoteAlias}:`)) {
        state.remoteFiles.set(destination.slice(remoteAlias.length + 1), bytes);
        addRemoteDir(state, destination.slice(remoteAlias.length + 1).split("/").slice(0, -1).join("/"));
      } else {
        await mkdir(join(destination, ".."), { recursive: true }).catch(() => {});
        const { writeFile: write } = await import("node:fs/promises");
        await write(destination, bytes);
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (command === "cat") {
      const bytes = state.remoteFiles.get(target.slice(remoteAlias.length + 1));
      return bytes ? { ok: true, stdout: bytes.toString("utf8"), stderr: "" } : { ok: false, stdout: "", stderr: "missing" };
    }
    if (command === "hashsum") {
      const bytes = await readSource(state, args[2]);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { ok: true, stdout: `${hash}  ${args[2]}\n`, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected command ${command}` };
  };
  const readProtected = async () => state.protected;
  const writeProtected = async (_file, value) => { state.protected = structuredClone(value); };
  return {
    root, localRoot, workdir, recoveryStateFile, relation, job, state, runBuffered, readProtected, writeProtected,
    stagingRoot: join(root, "protected", "restore-staging"),
    protectStagingFile: async path => { state.protectedStages.add(path); },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

function runnerOptions(fixture) {
  return {
    job: fixture.job,
    relation: fixture.relation,
    recoveryStateFile: fixture.recoveryStateFile,
    stagingRoot: fixture.stagingRoot,
    readProtected: fixture.readProtected,
    writeProtected: fixture.writeProtected,
    protectStagingFile: fixture.protectStagingFile,
    runBuffered: fixture.runBuffered,
    rcloneExe: "rclone",
    rcloneConfigFile: join(fixture.root, "rclone.conf"),
    env: {},
    cwd: fixture.root
  };
}

test("pristine recovery proof requires no protected owner manifest or local or remote namespace", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const options = runnerOptions(fixture);
  assert.equal(await isSyncRecoveryPristine(options), true);

  const prepared = await prepareSyncRecovery(options);
  fixture.state.protected.runs = [];
  assert.equal(await isSyncRecoveryPristine(options), false, "an owner manifest remains non-pristine even with zero runs");
  fixture.state.protected = null;

  const localRecoveryRoot = join(fixture.localRoot, ".syncraft-recovery", fixture.relation.relationId);
  await mkdir(localRecoveryRoot, { recursive: true });
  assert.equal(await isSyncRecoveryPristine(options), false, "an orphan local namespace must remain non-pristine");
  await rm(join(fixture.localRoot, ".syncraft-recovery"), { recursive: true, force: true });

  addRemoteDir(fixture.state, `.syncraft-recovery/${fixture.relation.relationId}`);
  assert.equal(await isSyncRecoveryPristine(options), false, "an orphan remote namespace must remain non-pristine");
  assert.ok(prepared.recoveryPreflight.runId);
});

test("recovery listing wiring probes only inside the data tunnel and keeps strict cases gated", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const source = await readFile(new URL("../client/src/clientServer.js", import.meta.url), "utf8");
  const start = source.indexOf("async function listRecoveryVersionsForContext(context) {");
  const end = source.indexOf("\n}\n\nfunction firstBisyncConflictOptions", start);
  assert.ok(start >= 0 && end > start, "expected to read the production recovery listing helper");
  const calls = { tunnelDepth: 0, strict: 0, remoteProbes: 0, initialized: false };
  const options = {
    ...runnerOptions(fixture),
    runBuffered: async (...args) => {
      assert.ok(calls.tunnelDepth > 0, "remote namespace probe must run inside withSyncTunnel");
      calls.remoteProbes += 1;
      return fixture.runBuffered(...args);
    }
  };
  const vm = {
    recoveryOptions: () => options,
    isBisyncInitialized: async () => calls.initialized,
    withSyncTunnel: async (plan, task) => {
      assert.equal(plan.dataTunnel, true);
      calls.tunnelDepth += 1;
      try { return await task(); } finally { calls.tunnelDepth -= 1; }
    },
    withRecoveryContext: async (context, _task) => vm.withSyncTunnel(context.runPlan, async () => {
      assert.ok(calls.tunnelDepth > 0, "strict marker path must remain inside withSyncTunnel");
      calls.strict += 1;
      const error = new Error("strict SFTP marker gate");
      error.code = "strict_marker_gate";
      throw error;
    }),
    listSyncRecoveryVersions,
    isSyncRecoveryPristine
  };
  runInNewContext(`${source.slice(start, end + 2)}\nthis.listRecoveryVersionsForContext = listRecoveryVersionsForContext;`, vm);
  const run = () => vm.listRecoveryVersionsForContext({ job: fixture.job, runPlan: { dataTunnel: true } });

  assert.deepEqual(await run(), []);
  assert.equal(calls.strict, 0, "a proven pristine first-use listing skips the strict marker gate");
  assert.ok(calls.remoteProbes > 0, "fresh listing must actually inspect the remote recovery namespace");

  calls.initialized = true;
  await assert.rejects(run(), error => error.code === "strict_marker_gate");
  assert.equal(calls.strict, 1, "an initialized relation must use the original strict marker gate");
  calls.initialized = false;

  await prepareSyncRecovery(runnerOptions(fixture));
  fixture.state.protected.runs = [];
  await assert.rejects(run(), error => error.code === "strict_marker_gate");
  assert.equal(calls.strict, 2, "a protected owner manifest with zero runs must remain strict");
  fixture.state.protected = null;

  const localRecoveryRoot = join(fixture.localRoot, ".syncraft-recovery", fixture.relation.relationId);
  await mkdir(localRecoveryRoot, { recursive: true });
  await assert.rejects(run(), error => error.code === "strict_marker_gate");
  assert.equal(calls.strict, 3, "an orphan local namespace must remain strict");
  await rm(join(fixture.localRoot, ".syncraft-recovery"), { recursive: true, force: true });

  addRemoteDir(fixture.state, `.syncraft-recovery/${fixture.relation.relationId}`);
  await assert.rejects(run(), error => error.code === "strict_marker_gate");
  assert.equal(calls.strict, 4, "an orphan remote namespace must remain strict");
});

function listingName(path1, path2, side) {
  const encode = value => String(value).replace(/[\\/:]/g, "_");
  return `${encode(path1)}..${encode(path2)}.path${side}.lst`;
}

async function addValidListings(fixture, pathNames = ["ordinary.txt"]) {
  const row = name => `-       12 md5:0123456789abcdef0123456789abcdef - 2026-10-30T02:43:21.000000000+0000 ${JSON.stringify(name)}`;
  const text = `# bisync listing v1 from 2026-10-30T02:48:43.658409500+0000\n${pathNames.map(row).join("\n")}\n`;
  for (const side of [1, 2]) {
    const primary = join(fixture.workdir, listingName(fixture.job.localPath, fixture.relation.rclone.remotePath, side));
    await writeFile(primary, text);
    await writeFile(`${primary}-old`, text);
    await writeFile(`${primary}-dry`, text);
  }
}

test("prepares first-baseline recovery area with a relation-bound unique run namespace", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const result = await prepareSyncRecovery(runnerOptions(fixture));
  assert.equal(await verifySyncRecoveryPreflight({ ...runnerOptions(fixture), receipt: result.recoveryPreflight }), true);
  assert.equal(result.recoveryPreflight.preflightKind, "new-relation");
  assert.equal(result.recoveryPreflight.namespaceWasEmpty, true);
  assert.equal(result.recoveryPreflight.runNamespaceWasEmpty, true);
  assert.match(result.recoveryPreflight.backupDir1, new RegExp(`runs[\\\\/]${result.recoveryPreflight.runId}[\\\\/]path1$`));
  assert.equal(result.recoveryPreflight.backupDir2,
    `${remoteAlias}:.syncraft-recovery/${fixture.relation.relationId}/runs/${result.recoveryPreflight.runId}/path2`);
  assert.ok(fixture.state.calls.some(args => args[0] === "copyto"));
  assert.equal(fixture.state.protected.runs.length, 1);
});

test("prepare journal resumes an owned partial namespace after an injected command failure", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  fixture.state.failCommand = "mkdir";
  await assert.rejects(prepareSyncRecovery(runnerOptions(fixture)), error => error.code === "sync_recovery_preflight_failed");
  assert.equal(fixture.state.protected.status, "preparing");
  assert.equal(fixture.state.protected.runs.length, 1);
  const runId = fixture.state.protected.runs[0].runId;
  const resumed = await prepareSyncRecovery(runnerOptions(fixture));
  assert.equal(resumed.recoveryPreflight.runId, runId);
  assert.equal(resumed.manifest.status, "ready");
  assert.equal(resumed.manifest.runs.length, 1);
  assert.equal(await verifySyncRecoveryPreflight({ ...runnerOptions(fixture), receipt: resumed.recoveryPreflight }), true);
});

test("existing baselines migrate only after matching current and old listings prove namespace absent", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  await addValidListings(fixture);
  const baselineEntry = {
    initializedAt: "2026-10-30T02:48:36.326Z",
    relationId: fixture.relation.relationId,
    baselineId: fixture.relation.baselineId,
    baselineEpoch: fixture.relation.baselineEpoch,
    rootId: fixture.relation.rootId,
    workdir: fixture.workdir
  };
  const next = await prepareSyncRecovery({ ...runnerOptions(fixture), baselineEntry });
  assert.equal(next.recoveryPreflight.preflightKind, "existing-relation-migration");
  assert.equal(next.recoveryPreflight.migrationStatus, "recorded");
  assert.match(next.recoveryPreflight.migrationRecordId, /^[0-9a-f-]{36}$/i);
  assert.equal(fixture.state.protected.migrations.length, 1);
  assert.equal(fixture.state.protected.runs.length, 1);
});

test("blocks old listing namespace collisions, missing listing pairs, and unowned existing namespace", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  await prepareSyncRecovery(runnerOptions(fixture));
  await addValidListings(fixture, [".syncraft-recovery/rel_test_relation_123456/runs/old/path2/user.txt"]);
  const baselineEntry = {
    initializedAt: "2026-10-30T02:48:36.326Z",
    relationId: fixture.relation.relationId,
    baselineId: fixture.relation.baselineId,
    baselineEpoch: fixture.relation.baselineEpoch,
    rootId: fixture.relation.rootId,
    workdir: fixture.workdir
  };
  await assert.rejects(
    prepareSyncRecovery({ ...runnerOptions(fixture), baselineEntry }),
    error => error.code === "sync_recovery_review_required"
  );

  const other = await setup();
  t.after(other.cleanup);
  await addValidListings(other);
  const remoteNamespace = `.syncraft-recovery/${other.relation.relationId}`;
  addRemoteDir(other.state, remoteNamespace);
  other.state.remoteFiles.set(`${remoteNamespace}/user.txt`, Buffer.from("user data"));
  await assert.rejects(prepareSyncRecovery({ ...runnerOptions(other), baselineEntry: {
    ...baselineEntry,
    relationId: other.relation.relationId,
    baselineId: other.relation.baselineId,
    baselineEpoch: other.relation.baselineEpoch,
    rootId: other.relation.rootId,
    workdir: other.workdir
  } }), error => error.code === "sync_recovery_review_required");
});

test("lists saved versions and restores only through an absent target preview", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const prepared = await prepareSyncRecovery(runnerOptions(fixture));
  const run = fixture.state.protected.runs[0];
  await mkdir(run.backupDir1, { recursive: true });
  await writeFile(join(run.backupDir1, "kept.txt"), "recover me\n");
  const versionList = await listSyncRecoveryVersions(runnerOptions(fixture));
  assert.deepEqual(versionList[0].files, [{ side: "path1", path: "kept.txt" }]);
  await markSyncRecoveryRunStarted({ ...runnerOptions(fixture), runId: prepared.recoveryPreflight.runId });
  await completeSyncRecoveryRun({ ...runnerOptions(fixture), runId: prepared.recoveryPreflight.runId });
  const preview = await previewSyncRecoveryRestore({
    ...runnerOptions(fixture),
    runId: prepared.recoveryPreflight.runId,
    side: "path1",
    path: "kept.txt",
    destinationPath: "kept.raced.txt"
  });
  assert.match(preview.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.state.protectedStages.has(preview.stagedPath), true);
  const racedTarget = join(fixture.localRoot, "kept.raced.txt");
  await writeFile(racedTarget, "concurrent user content\n");
  await assert.rejects(restoreSyncRecoveryVersion({ ...runnerOptions(fixture), previewId: preview.previewId }),
    error => error.code === "sync_recovery_restore_target_exists");
  assert.equal(await readFile(racedTarget, "utf8"), "concurrent user content\n");
  await rm(racedTarget, { force: true });
  const finalPreview = await previewSyncRecoveryRestore({
    ...runnerOptions(fixture),
    runId: prepared.recoveryPreflight.runId,
    side: "path1",
    path: "kept.txt",
    destinationPath: "kept.recovered.txt"
  });
  const restored = await restoreSyncRecoveryVersion({
    ...runnerOptions(fixture), previewId: finalPreview.previewId
  });
  assert.equal(restored.restored, true);
  assert.equal(await readFile(join(fixture.localRoot, "kept.recovered.txt"), "utf8"), "recover me\n");
  await assert.rejects(previewSyncRecoveryRestore({
    ...runnerOptions(fixture),
    runId: prepared.recoveryPreflight.runId,
    side: "path1",
    path: "kept.txt",
    destinationPath: "kept.recovered.txt"
  }), error => error.code === "sync_recovery_restore_target_exists");
});

test("a restore destination changed after creation is preserved when its final hash mismatches", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const prepared = await prepareSyncRecovery(runnerOptions(fixture));
  const run = fixture.state.protected.runs[0];
  await mkdir(run.backupDir1, { recursive: true });
  await writeFile(join(run.backupDir1, "kept.txt"), "saved bytes\n");
  await markSyncRecoveryRunStarted({ ...runnerOptions(fixture), runId: prepared.recoveryPreflight.runId });
  await completeSyncRecoveryRun({ ...runnerOptions(fixture), runId: prepared.recoveryPreflight.runId });
  const preview = await previewSyncRecoveryRestore({
    ...runnerOptions(fixture), runId: prepared.recoveryPreflight.runId, side: "path1",
    path: "kept.txt", destinationPath: "kept.raced.txt"
  });
  await assert.rejects(restoreSyncRecoveryVersion({
    ...runnerOptions(fixture), previewId: preview.previewId,
    copyRestoredFile: async (source, destination, flags) => {
      await copyFile(source, destination, flags);
      await writeFile(destination, "other writer changed this after create\n");
    }
  }), error => error.code === "sync_recovery_restore_hash_mismatch");
  assert.equal(await readFile(join(fixture.localRoot, "kept.raced.txt"), "utf8"), "other writer changed this after create\n");
});

test("rejects untrusted relation and forged preflight receipts", async (t) => {
  const fixture = await setup();
  t.after(fixture.cleanup);
  const untrusted = { ...fixture.relation, rootAttested: false };
  await assert.rejects(
    prepareSyncRecovery({ ...runnerOptions(fixture), relation: untrusted }),
    error => error.code === "sync_recovery_trusted_relation_required"
  );
  await assert.rejects(
    verifySyncRecoveryPreflight({ ...runnerOptions(fixture), receipt: { type: "bisync-recovery-preflight" } }),
    error => error.code === "sync_recovery_review_required"
  );
});

function addRemoteDir(state, value) {
  const path = String(value).startsWith(`${remoteAlias}:`)
    ? String(value).slice(remoteAlias.length + 1)
    : String(value);
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    state.remoteDirs.add(current);
  }
}

function listMockRemote(state, value, { dirsOnly, recursive }) {
  const path = String(value).startsWith(`${remoteAlias}:`)
    ? String(value).slice(remoteAlias.length + 1).replace(/^\//, "").replace(/\/$/, "")
    : String(value);
  const prefix = path ? `${path}/` : "";
  const rows = [];
  for (const dir of state.remoteDirs) {
    if (!dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (!rest || (!recursive && rest.includes("/"))) continue;
    if (!dirsOnly || !rest.includes("/")) rows.push({ Path: rest, Name: rest.split("/").at(-1), IsDir: true });
  }
  if (!dirsOnly) {
    for (const file of state.remoteFiles.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || (!recursive && rest.includes("/"))) continue;
      rows.push({ Path: rest, Name: rest.split("/").at(-1), IsDir: false, Size: state.remoteFiles.get(file).length });
    }
  }
  return rows;
}

async function readSource(state, value) {
  if (String(value).startsWith(`${remoteAlias}:`)) {
    const bytes = state.remoteFiles.get(String(value).slice(remoteAlias.length + 1));
    if (!bytes) throw new Error("missing mock remote file");
    return bytes;
  }
  return readFile(value);
}
