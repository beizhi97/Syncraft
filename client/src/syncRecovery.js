import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const OWNER_FILE = ".syncraft-recovery-owner.json";
const RESERVED_ROOT = ".syncraft-recovery";
const RESTORE_PREVIEWS = new Map();

export function verifySyncRecoveryManifestOwnership(value, relation) {
  validateManifest(value, relation);
  return true;
}

/**
 * Prepare one relation-owned recovery namespace and one unique backup version.
 *
 * The caller must pass the normalized job/relation and the matching persisted
 * bisync baseline entry (when initialized). Filesystem/remote inspection is
 * done here; protected persistence and rclone execution are injected so the
 * client composition can use its existing ACL and process boundaries.
 */
export async function prepareSyncRecovery(options = {}) {
  const {
    job,
    relation = job?.syncRelation,
    baselineEntry = null,
    recoveryStateFile,
    readProtected,
    writeProtected,
    runBuffered,
    rcloneExe,
    rcloneConfigFile,
    env = {},
    cwd,
    now = () => new Date()
  } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ recoveryStateFile, readProtected, writeProtected, runBuffered, rcloneExe, rcloneConfigFile });
  assertPrepareWriter(writeProtected);
  const initialized = validateBaselineEntry(relation, baselineEntry);
  const workdir = relation.rclone?.workdir;
  if (!workdir || !isAbsolute(workdir)) {
    throw recoveryError("sync_recovery_review_required", "A trusted bisync work directory is required");
  }

  const listing = await inspectBisyncListings({ workdir, job, relation });
  if (initialized && !listing.initialized) {
    throw recoveryError("sync_recovery_review_required", "The initialized relation has no verifiable current bisync listing pair");
  }
  if (!initialized && listing.anyListingFiles) {
    throw recoveryError("sync_recovery_review_required", "Unmapped bisync listing files exist before first initialization");
  }

  const namespace = `${RESERVED_ROOT}/${relation.relationId}`;
  const excludePattern = `/${namespace}/**`;
  if (initialized && listing.names.some((name) => isWithinNamespace(name, namespace))) {
    throw recoveryError("sync_recovery_review_required", "The existing bisync listing contains user data in the proposed recovery namespace");
  }

  const state = await readProtected(recoveryStateFile, null);
  let manifest = validateManifest(state, relation);
  const localRoot = resolve(job.localPath);
  const rootInfo = await lstat(localRoot).catch((error) => {
    if (error?.code === "ENOENT") throw recoveryError("sync_recovery_review_required", "The local sync root is unavailable");
    throw error;
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw recoveryError("sync_recovery_review_required", "The local sync root is not a plain directory");
  }
  const localRecoveryRoot = join(localRoot, RESERVED_ROOT, relation.relationId);
  const remoteRoot = String(relation.rclone.remotePath || "");
  if (!remoteRoot) throw recoveryError("sync_recovery_review_required", "A canonical remote root is required");
  const remoteRecoveryRoot = appendRemote(remoteRoot, namespace);
  const localPresence = await inspectLocalNamespace(localRoot, relation.relationId);
  const remotePresence = await inspectRemoteNamespace({
    remoteRoot,
    relationId: relation.relationId,
    remoteRecoveryRoot,
    runBuffered,
    rcloneExe,
    rcloneConfigFile,
    env,
    cwd
  });

  if (!manifest && (localPresence.exists || remotePresence.exists)) {
    throw recoveryError("sync_recovery_review_required", "A recovery namespace already exists without a matching protected owner record");
  }
  if (manifest?.status === "ready") {
    await verifyOwnedNamespace({
      manifest,
      relation,
      localRecoveryRoot,
      localPresence,
      remoteRecoveryRoot,
      remotePresence,
      runBuffered,
      rcloneExe,
      rcloneConfigFile,
      env,
      cwd
    });
  } else if (manifest?.status === "preparing") {
    await verifyPreparingNamespace({ manifest, relation, localRecoveryRoot, localPresence, remoteRecoveryRoot,
      remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  }
  let run = manifest?.runs.find((entry) => entry.status === "preparing");
  if (manifest?.status === "preparing" && !run) {
    throw recoveryError("sync_recovery_review_required", "Recovery prepare journal has no resumable run");
  }
  if (manifest?.runs.some((entry) => entry.status === "running")) {
    throw recoveryError("sync_recovery_review_required", "A recovery run was interrupted or is still active; inspect saved versions before starting another run");
  }
  if (manifest?.status === "ready") {
    const priorMigration = manifest.migrations.find((entry) => entry.baselineId === relation.baselineId && entry.rootId === relation.rootId);
    const migrationRecordId = priorMigration?.id || "";
    const runId = randomUUID();
    const runRoot = `${namespace}/runs/${runId}`;
    assertNewRunNamespaceEmpty(runId, manifest, localPresence, remotePresence);
    const backupDir1 = join(localRoot, ...runRoot.split("/"), "path1");
    const backupDir2 = appendRemote(remoteRoot, `${runRoot}/path2`);
    run = {
      runId,
      createdAt: now().toISOString(),
      backupDir1,
      backupDir2,
      status: "preparing",
      preflightKind: migrationRecordId ? "existing-relation-migration" : "new-relation",
      migrationStatus: migrationRecordId ? "recorded" : "not-applicable",
      migrationRecordId,
      namespaceWasEmpty: false
    };
    manifest.status = "preparing";
    manifest.runs.push(run);
    await writeProtected(recoveryStateFile, manifest);
  } else if (!manifest) {
    const createdAt = now().toISOString();
    manifest = ownerManifest(relation, createdAt);
    manifest.status = "preparing";
    const migrationRecordId = initialized ? randomUUID() : "";
    const runId = randomUUID();
    const runRoot = `${namespace}/runs/${runId}`;
    assertNewRunNamespaceEmpty(runId, manifest, localPresence, remotePresence);
    run = {
      runId,
      createdAt,
      backupDir1: join(localRoot, ...runRoot.split("/"), "path1"),
      backupDir2: appendRemote(remoteRoot, `${runRoot}/path2`),
      status: "preparing",
      preflightKind: migrationRecordId ? "existing-relation-migration" : "new-relation",
      migrationStatus: migrationRecordId ? "recorded" : "not-applicable",
      migrationRecordId,
      namespaceWasEmpty: true
    };
    manifest.runs.push(run);
    if (migrationRecordId) {
      manifest.migrations.push({ id: migrationRecordId, baselineId: relation.baselineId, rootId: relation.rootId, recordedAt: createdAt });
    }
    // The durable journal precedes all local and remote mutations. A crash can
    // therefore resume only this relation-owned, UUID-scoped preparation.
    await writeProtected(recoveryStateFile, manifest);
  }

  await ensureOwnedNamespace({ manifest, relation, localRoot, localRecoveryRoot, localPresence,
    remoteRecoveryRoot, remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const runRootPath = join(localRecoveryRoot, "runs", run.runId);
  const localRunPath = join(runRootPath, "path1");
  if (await pathExists(runRootPath)) {
    const entries = await listLocalRelativeEntries(runRootPath);
    if (entries.some((entry) => entry !== "path1/")) {
      throw recoveryError("sync_recovery_review_required", "Unowned content exists in the pending local recovery run");
    }
  }
  await mkdir(localRunPath, { recursive: true });
  await requireRun(runBuffered, rcloneExe, ["mkdir", run.backupDir2, "--config", rcloneConfigFile], { cwd, env });
  run.status = "prepared";
  manifest.status = "ready";
  await writeProtected(recoveryStateFile, manifest);

  const receipt = receiptForRun(manifest, run, relation, namespace, excludePattern);
  return { recoveryPreflight: receipt, manifest };
}

/** Recheck the persisted receipt, current namespace, listings, and empty run directory before execution. */
export async function verifySyncRecoveryPreflight(options = {}) {
  const { receipt, job, relation = job?.syncRelation, baselineEntry = null, recoveryStateFile,
    readProtected, runBuffered, rcloneExe, rcloneConfigFile, env = {}, cwd } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile });
  assertPreflightShape(receipt, job, relation);
  const initialized = validateBaselineEntry(relation, baselineEntry);
  const listing = await inspectBisyncListings({ workdir: relation.rclone.workdir, job, relation });
  if ((initialized && !listing.initialized)
    || (!initialized && listing.anyListingFiles)
    || listing.names.some((name) => isWithinNamespace(name, receipt.namespace))) {
    throw recoveryError("sync_recovery_review_required", "Bisync listings no longer match the recovery preflight");
  }
  const manifest = validateManifest(await readProtected(recoveryStateFile, null), relation);
  const run = manifest?.runs.find((entry) => entry.runId === receipt.runId);
  if (!run || run.status !== "prepared" || run.backupDir1 !== receipt.backupDir1 || run.backupDir2 !== receipt.backupDir2) {
    throw recoveryError("sync_recovery_review_required", "Recovery run is not present as a prepared entry in protected state");
  }
  const remoteRoot = relation.rclone.remotePath;
  const remoteRecoveryRoot = appendRemote(remoteRoot, receipt.namespace);
  const localRoot = resolve(job.localPath);
  const localRecoveryRoot = join(localRoot, RESERVED_ROOT, relation.relationId);
  const [localPresence, remotePresence] = await Promise.all([
    inspectLocalNamespace(localRoot, relation.relationId),
    inspectRemoteNamespace({ remoteRoot, relationId: relation.relationId, remoteRecoveryRoot,
      runBuffered, rcloneExe, rcloneConfigFile, env, cwd })
  ]);
  await verifyOwnedNamespace({ manifest, relation, localRecoveryRoot, localPresence, remoteRecoveryRoot,
    remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const localRunEntries = await listLocalRelativeEntries(receipt.backupDir1);
  const remoteRunEntries = await listRemoteRows({ path: receipt.backupDir2, runBuffered, rcloneExe, rcloneConfigFile, env, cwd, recursive: true });
  if (localRunEntries.length || remoteRunEntries.length) {
    throw recoveryError("sync_recovery_review_required", "The per-run recovery directory is no longer empty");
  }
  return true;
}

function assertPreflightShape(receipt, job, relation) {
  if (!receipt || receipt.type !== "bisync-recovery-preflight" || receipt.version !== 1
    || receipt.issuer !== "sync-recovery-preflight" || receipt.status !== "ready"
    || receipt.relationId !== relation.relationId
    || receipt.baselineId !== relation.baselineId
    || receipt.rootId !== relation.rootId
    || receipt.namespace !== `${RESERVED_ROOT}/${relation.relationId}`
    || receipt.runNamespaceWasEmpty !== true
    || receipt.priorListingNamespaceWasEmpty !== true
    || !isUuid(receipt.runId)
    || receipt.ownerRecordId !== `${relation.relationId}:${relation.baselineId}:${relation.rootId}`
    || receipt.excludePattern !== `/${receipt.namespace}/**`
    || !["new-relation", "existing-relation-migration"].includes(receipt.preflightKind)
    || (receipt.preflightKind === "new-relation" && receipt.migrationStatus !== "not-applicable")
    || (receipt.preflightKind === "existing-relation-migration"
      && (receipt.migrationStatus !== "recorded" || !isUuid(receipt.migrationRecordId)))) {
    throw recoveryError("sync_recovery_review_required", "Recovery preflight receipt does not match the trusted relation");
  }
  const runRoot = `${receipt.namespace}/runs/${receipt.runId}`;
  if (receipt.backupDir1 !== join(resolve(job.localPath), ...runRoot.split("/"), "path1")
    || receipt.backupDir2 !== appendRemote(relation.rclone.remotePath, `${runRoot}/path2`)) {
    throw recoveryError("sync_recovery_review_required", "Recovery preflight paths do not match the relation and run namespace");
  }
}

export async function listSyncRecoveryVersions(options = {}) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile, env = {}, cwd } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile });
  const inspection = await inspectRecoveryListingNamespace(options);
  const { manifest } = inspection;
  if (!manifest) {
    if (!inspection.pristine) {
      throw recoveryError("sync_recovery_review_required", "A recovery namespace exists without a matching protected owner record");
    }
    return [];
  }
  await verifyCurrentOwnedNamespace({ job, relation, manifest, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const versions = [];
  for (const run of manifest.runs) {
    const [localFiles, remoteFiles] = await Promise.all([
      listLocalFiles(run.backupDir1),
      listRemoteFiles({ path: run.backupDir2, runBuffered, rcloneExe, rcloneConfigFile, env, cwd })
    ]);
    versions.push({
      runId: run.runId,
      createdAt: run.createdAt,
      status: run.status,
      files: [
        ...localFiles.map((file) => ({ side: "path1", path: file })),
        ...remoteFiles.map((file) => ({ side: "path2", path: file }))
      ]
    });
  }
  return versions;
}

/** Read-only proof that a relation has neither protected recovery history nor either recovery namespace. */
export async function isSyncRecoveryPristine(options = {}) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile });
  const inspection = await inspectRecoveryListingNamespace(options);
  return inspection.pristine;
}

async function inspectRecoveryListingNamespace(options) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile,
    env = {}, cwd } = options;
  const manifest = validateManifest(await readProtected(recoveryStateFile, null), relation);
  if (manifest) return { manifest, pristine: false };
  const remoteRoot = String(relation.rclone.remotePath || "");
  const localRoot = resolve(job.localPath);
  const remoteRecoveryRoot = appendRemote(remoteRoot, `${RESERVED_ROOT}/${relation.relationId}`);
  const [localPresence, remotePresence] = await Promise.all([
    inspectLocalNamespace(localRoot, relation.relationId),
    inspectRemoteNamespace({ remoteRoot, relationId: relation.relationId, remoteRecoveryRoot,
      runBuffered, rcloneExe, rcloneConfigFile, env, cwd })
  ]);
  return {
    manifest: null,
    localPresence,
    remotePresence,
    pristine: !localPresence.exists && !remotePresence.exists
  };
}

export async function completeSyncRecoveryRun(options = {}) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, writeProtected, runId, succeeded = true } = options;
  assertTrustedContext(job, relation);
  if (!relation || !isUuid(runId) || typeof readProtected !== "function" || typeof writeProtected !== "function") {
    throw new TypeError("Completing a recovery run requires a relation, run ID, and protected state access");
  }
  const manifest = validateManifest(await readProtected(recoveryStateFile, null), relation);
  const run = manifest?.runs.find((entry) => entry.runId === runId);
  if (!run || run.status !== "running") throw recoveryError("sync_recovery_version_not_found", "Running recovery run was not found");
  run.status = succeeded ? "completed" : "failed";
  run.completedAt = new Date().toISOString();
  await writeProtected(recoveryStateFile, manifest);
  return { runId, status: run.status, completedAt: run.completedAt };
}

export async function markSyncRecoveryRunStarted(options = {}) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, writeProtected, runId } = options;
  assertTrustedContext(job, relation);
  if (!isUuid(runId) || typeof readProtected !== "function" || typeof writeProtected !== "function") {
    throw new TypeError("Starting a recovery run requires a relation, run ID, and protected state access");
  }
  const manifest = validateManifest(await readProtected(recoveryStateFile, null), relation);
  const run = manifest?.runs.find((entry) => entry.runId === runId);
  if (!run || manifest.status !== "ready" || run.status !== "prepared") {
    throw recoveryError("sync_recovery_review_required", "Only a prepared recovery run can be started");
  }
  run.status = "running";
  run.startedAt = new Date().toISOString();
  await writeProtected(recoveryStateFile, manifest);
  return { runId, status: run.status, startedAt: run.startedAt };
}

export async function previewSyncRecoveryRestore(options = {}) {
  const { job, relation = job?.syncRelation, recoveryStateFile, readProtected, runBuffered, rcloneExe,
    rcloneConfigFile, env = {}, cwd, runId, side, path: relativePath, destinationPath,
    stagingRoot, protectStagingFile } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ recoveryStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile });
  if (!stagingRoot || !isAbsolute(stagingRoot) || typeof protectStagingFile !== "function") {
    throw new TypeError("Recovery restore preview requires a private staging root and protection callback");
  }
  if (!isUuid(runId) || !["path1", "path2"].includes(side) || !isSafeRelativePath(relativePath)) {
    throw recoveryError("validation_failed", "Recovery source must identify a saved run and safe relative file path");
  }
  const manifest = validateManifest(await readProtected(recoveryStateFile, null), relation);
  const run = manifest?.runs.find((entry) => entry.runId === runId);
  if (!run) throw recoveryError("sync_recovery_version_not_found", "Saved recovery version was not found");
  if (!["completed", "failed"].includes(run.status)) throw recoveryError("sync_recovery_version_not_found", "Only a finished recovery run can be restored");
  await verifyCurrentOwnedNamespace({ job, relation, manifest, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const source = side === "path1" ? join(run.backupDir1, ...relativePath.split("/")) : appendRemote(run.backupDir2, relativePath);
  const destination = safeLocalDestination(job.localPath, destinationPath || `${relativePath}.recovered-${runId.slice(0, 8)}`);
  await assertSafeDestinationAncestors(job.localPath, destination);
  if (await pathExists(destination)) throw recoveryError("sync_recovery_restore_target_exists", "Recovery restore target already exists");
  const sourceSha256 = await sourceSha256ForRestore({ side, source, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  await mkdir(stagingRoot, { recursive: true });
  const stageInfo = await lstat(stagingRoot);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw recoveryError("sync_recovery_restore_staging_invalid", "Private restore staging root is not a plain directory");
  const stagedPath = join(stagingRoot, `restore-${randomUUID()}.bin`);
  try {
    if (side === "path1") await copyFile(source, stagedPath, constants.COPYFILE_EXCL);
    else await requireRun(runBuffered, rcloneExe, ["copyto", source, stagedPath, "--config", rcloneConfigFile], { cwd, env });
    await protectStagingFile(stagedPath);
    const stagedSha256 = await sha256File(stagedPath);
    if (stagedSha256 !== sourceSha256) throw recoveryError("sync_recovery_restore_hash_mismatch", "Staged recovery content did not match the saved version hash");
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => {});
    throw error;
  }
  const previewId = randomUUID();
  const preview = { previewId, relationId: relation.relationId, baselineId: relation.baselineId, rootId: relation.rootId,
    runId, side, source, destination, relativePath, sourceSha256, stagedPath, createdAt: new Date().toISOString() };
  RESTORE_PREVIEWS.set(previewId, preview);
  pruneRestorePreviews();
  return preview;
}

export async function cancelSyncRecoveryRestorePreview(previewId, options = {}) {
  const preview = RESTORE_PREVIEWS.get(String(previewId || ""));
  if (!preview) return false;
  const relation = options.relation || options.job?.syncRelation;
  if (relation && (preview.relationId !== relation.relationId || preview.baselineId !== relation.baselineId || preview.rootId !== relation.rootId)) {
    throw recoveryError("sync_recovery_restore_preview_required", "Restore preview does not belong to this sync relation");
  }
  RESTORE_PREVIEWS.delete(preview.previewId);
  await rm(preview.stagedPath, { force: true }).catch(() => {});
  return true;
}

export async function restoreSyncRecoveryVersion(options = {}) {
  const { previewId, job, relation = job?.syncRelation, copyRestoredFile = copyFile } = options;
  assertTrustedContext(job, relation);
  const preview = RESTORE_PREVIEWS.get(String(previewId || ""));
  if (!preview || preview.relationId !== relation.relationId || preview.baselineId !== relation.baselineId || preview.rootId !== relation.rootId) {
    throw recoveryError("sync_recovery_restore_preview_required", "A current restore preview for this relation is required");
  }
  RESTORE_PREVIEWS.delete(preview.previewId);
  try {
    if (Date.now() - Date.parse(preview.createdAt) > 10 * 60 * 1000) {
      throw recoveryError("sync_recovery_restore_preview_expired", "Recovery restore preview expired; create a new preview");
    }
    await assertSafeDestinationAncestors(job.localPath, preview.destination);
    if (await pathExists(preview.destination)) throw recoveryError("sync_recovery_restore_target_exists", "Recovery restore target already exists");
    await mkdir(dirname(preview.destination), { recursive: true });
    await assertSafeDestinationAncestors(job.localPath, preview.destination);
    if (await sha256File(preview.stagedPath) !== preview.sourceSha256) {
      throw recoveryError("sync_recovery_restore_hash_mismatch", "Private staged content changed after preview");
    }
    await copyRestoredFile(preview.stagedPath, preview.destination, constants.COPYFILE_EXCL);
    const destinationSha256 = await sha256File(preview.destination);
    if (destinationSha256 !== preview.sourceSha256) {
      throw recoveryError("sync_recovery_restore_hash_mismatch", "Restored content changed during verification; the destination was preserved for review");
    }
    return { restored: true, destinationPath: preview.destination, runId: preview.runId, relativePath: preview.relativePath, sha256: destinationSha256 };
  } catch (error) {
    if (error?.code === "EEXIST") throw recoveryError("sync_recovery_restore_target_exists", "Recovery restore target already exists");
    throw error;
  } finally {
    await rm(preview.stagedPath, { force: true }).catch(() => {});
  }
}

async function inspectBisyncListings({ workdir, job, relation }) {
  const files = await readdir(workdir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const source = String(job.localPath || "");
  const target = String(relation.rclone?.remotePath || "");
  const stem = `${sanitizeListingPath(source)}..${sanitizeListingPath(target)}`;
  const selected = files.filter((name) => name.startsWith(stem) && /\.path[12]\.lst(?:-(?:old|dry))?$/.test(name));
  const primary1 = selected.filter((name) => name === `${stem}.path1.lst`);
  const primary2 = selected.filter((name) => name === `${stem}.path2.lst`);
  if (primary1.length !== 1 || primary2.length !== 1) {
    return { initialized: false, anyListingFiles: selected.length > 0 || files.some((name) => /\.path[12]\.lst(?:-|$)/.test(name)), names: [] };
  }
  const names = [];
  for (const file of selected) {
    const parsed = parseBisyncListing(await readFile(join(workdir, file), "utf8"));
    names.push(...parsed);
  }
  return { initialized: true, anyListingFiles: true, names };
}

export function parseBisyncListing(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!/^# bisync listing v1 from \S+$/.test(lines[0] || "")) {
    throw recoveryError("sync_recovery_review_required", "Bisync listing format is not recognized; migration is blocked");
  }
  const names = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const match = /^[d-]\s+-?\d+\s+\S+\s+-\s+\S+\s+("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!match) throw recoveryError("sync_recovery_review_required", "Bisync listing contains an unrecognized row; migration is blocked");
    let name;
    try { name = JSON.parse(match[1]); } catch {
      throw recoveryError("sync_recovery_review_required", "Bisync listing path encoding is invalid; migration is blocked");
    }
    if (typeof name !== "string" || !name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      throw recoveryError("sync_recovery_review_required", "Bisync listing contains a non-canonical relative path; migration is blocked");
    }
    names.push(name);
  }
  return names;
}

export async function inspectBisyncBaselineForSafety({ workdir, job, relation }) {
  const files = await readdir(workdir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const stem = `${sanitizeListingPath(job?.localPath || "")}..${sanitizeListingPath(relation?.rclone?.remotePath || "")}`;
  const path1 = `${stem}.path1.lst`;
  const path2 = `${stem}.path2.lst`;
  const has1 = files.filter((name) => name === path1).length === 1;
  const has2 = files.filter((name) => name === path2).length === 1;
  if (!has1 || !has2) {
    throw recoveryError("sync_recovery_review_required", "The initialized relation has no verifiable current bisync listing pair");
  }
  const [previousLocal, previousRemote] = await Promise.all([
    readFile(join(workdir, path1), "utf8").then(parseBisyncListing),
    readFile(join(workdir, path2), "utf8").then(parseBisyncListing)
  ]);
  return { previousLocal: new Set(previousLocal), previousRemote: new Set(previousRemote) };
}

function sanitizeListingPath(value) {
  return String(value).replace(/[\\/:]/g, "_");
}

async function inspectLocalNamespace(localRoot, relationId) {
  const reserved = join(localRoot, RESERVED_ROOT);
  const rootEntries = await readdir(localRoot, { withFileTypes: true });
  const item = rootEntries.find((entry) => entry.name === RESERVED_ROOT);
  if (!item) return { exists: false, entries: [] };
  if (!item.isDirectory()) throw recoveryError("sync_recovery_review_required", "Reserved recovery path is occupied by a non-directory");
  const recoveryEntries = await readdir(reserved, { withFileTypes: true });
  const relationEntry = recoveryEntries.find((entry) => entry.name === relationId);
  if (!relationEntry) return { exists: false, entries: [] };
  if (!relationEntry.isDirectory() || relationEntry.isSymbolicLink()) throw recoveryError("sync_recovery_review_required", "Relation recovery namespace is not a plain directory");
  return { exists: true, entries: await listLocalRelativeEntries(join(reserved, relationId)) };
}

async function inspectRemoteNamespace({ remoteRoot, relationId, remoteRecoveryRoot, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const rootRows = await listRemoteRows({ path: remoteRoot, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const reserved = rootRows.find((row) => row.Path === RESERVED_ROOT);
  if (!reserved) return { exists: false, entries: [] };
  if (reserved.IsDir !== true) throw recoveryError("sync_recovery_review_required", "Reserved remote recovery path is occupied by a non-directory");
  const recoveryRows = await listRemoteRows({ path: appendRemote(remoteRoot, RESERVED_ROOT), runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const relation = recoveryRows.find((row) => row.Path === relationId);
  if (!relation) return { exists: false, entries: [] };
  if (relation.IsDir !== true) throw recoveryError("sync_recovery_review_required", "Relation remote recovery namespace is not a directory");
  const rows = await listRemoteRows({ path: remoteRecoveryRoot, runBuffered, rcloneExe, rcloneConfigFile, env, cwd, recursive: true });
  return { exists: true, entries: rows.map((row) => String(row.Path || "")) };
}

async function verifyOwnedNamespace({ manifest, relation, localRecoveryRoot, localPresence, remoteRecoveryRoot,
  remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  if (!localPresence.exists || !remotePresence.exists) throw recoveryError("sync_recovery_review_required", "Owned recovery namespace is missing on one side");
  const expectedOwner = ownerManifest(relation, manifest.createdAt);
  if (manifest.ownerRecordId !== expectedOwner.ownerRecordId || !Array.isArray(manifest.runs) || !Array.isArray(manifest.migrations)) {
    throw recoveryError("sync_recovery_review_required", "Protected recovery owner record does not match the relation");
  }
  const localOwner = JSON.parse(await readFile(join(localRecoveryRoot, OWNER_FILE), "utf8"));
  const remoteOwnerResult = await requireRun(runBuffered, rcloneExe, ["cat", appendRemote(remoteRecoveryRoot, OWNER_FILE), "--config", rcloneConfigFile], { cwd, env });
  const remoteOwner = JSON.parse(remoteOwnerResult.stdout || "null");
  if (JSON.stringify(localOwner) !== JSON.stringify(expectedOwner) || JSON.stringify(remoteOwner) !== JSON.stringify(expectedOwner)) {
    throw recoveryError("sync_recovery_review_required", "Recovery owner markers do not match the protected relation receipt");
  }
  const runIds = new Set(manifest.runs.map((run) => run.runId));
  if (manifest.runs.some((run) => !isUuid(run.runId))) throw recoveryError("sync_recovery_review_required", "Protected recovery run inventory is invalid");
  for (const entry of localPresence.entries) {
    if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path1")) throw recoveryError("sync_recovery_review_required", "Unknown local content exists in the recovery namespace");
  }
  for (const entry of remotePresence.entries) {
    if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path2")) throw recoveryError("sync_recovery_review_required", "Unknown remote content exists in the recovery namespace");
  }
}

async function verifyPreparingNamespace({ manifest, relation, localRecoveryRoot, localPresence, remoteRecoveryRoot,
  remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const expectedOwner = ownerManifest(relation, manifest.createdAt);
  if (manifest.ownerRecordId !== expectedOwner.ownerRecordId) {
    throw recoveryError("sync_recovery_review_required", "Recovery prepare journal does not match the relation");
  }
  const runIds = new Set(manifest.runs.map((run) => run.runId));
  if (localPresence.exists) {
    for (const entry of localPresence.entries) {
      if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path1")) {
        throw recoveryError("sync_recovery_review_required", "Unknown local content appeared during recovery preparation");
      }
    }
    if (localPresence.entries.includes(OWNER_FILE)) await assertLocalOwnerMarker(localRecoveryRoot, expectedOwner);
  }
  if (remotePresence.exists) {
    for (const entry of remotePresence.entries) {
      if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path2")) {
        throw recoveryError("sync_recovery_review_required", "Unknown remote content appeared during recovery preparation");
      }
    }
    if (remotePresence.entries.includes(OWNER_FILE)) {
      await assertRemoteOwnerMarker({ remoteRecoveryRoot, expectedOwner, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
    }
  }
}

async function ensureOwnedNamespace({ manifest, relation, localRoot, localRecoveryRoot, remoteRecoveryRoot,
  runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const expectedOwner = ownerManifest(relation, manifest.createdAt);
  const runIds = new Set(manifest.runs.map((run) => run.runId));
  const localPresence = await inspectLocalNamespace(localRoot, relation.relationId);
  if (!localPresence.exists) {
    await mkdir(join(localRoot, RESERVED_ROOT), { recursive: true });
    await mkdir(localRecoveryRoot, { recursive: false });
  } else {
    for (const entry of localPresence.entries) {
      if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path1")) {
        throw recoveryError("sync_recovery_review_required", "Unknown local content occupies the recovery namespace");
      }
    }
  }
  const localOwnerPath = join(localRecoveryRoot, OWNER_FILE);
  if (await pathExists(localOwnerPath)) {
    await assertLocalOwnerMarker(localRecoveryRoot, expectedOwner);
  } else {
    await writeFile(localOwnerPath, JSON.stringify(expectedOwner), { encoding: "utf8", flag: "wx" });
  }

  const remotePresence = await inspectRemoteNamespace({ remoteRoot: relation.rclone.remotePath,
    relationId: relation.relationId, remoteRecoveryRoot, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  if (remotePresence.exists) {
    for (const entry of remotePresence.entries) {
      if (entry !== OWNER_FILE && !isOwnedRunPath(entry, runIds, "path2")) {
        throw recoveryError("sync_recovery_review_required", "Unknown remote content occupies the recovery namespace");
      }
    }
  } else {
    await requireRun(runBuffered, rcloneExe, ["mkdir", remoteRecoveryRoot, "--config", rcloneConfigFile], { cwd, env });
  }
  if (remotePresence.entries.includes(OWNER_FILE)) {
    await assertRemoteOwnerMarker({ remoteRecoveryRoot, expectedOwner, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  } else {
    await requireRun(runBuffered, rcloneExe, ["copyto", localOwnerPath, appendRemote(remoteRecoveryRoot, OWNER_FILE), "--config", rcloneConfigFile], { cwd, env });
  }
}

async function assertLocalOwnerMarker(localRecoveryRoot, expectedOwner) {
  let owner;
  try { owner = JSON.parse(await readFile(join(localRecoveryRoot, OWNER_FILE), "utf8")); } catch {
    throw recoveryError("sync_recovery_review_required", "Local recovery owner marker is unreadable");
  }
  if (JSON.stringify(owner) !== JSON.stringify(expectedOwner)) {
    throw recoveryError("sync_recovery_review_required", "Local recovery owner marker does not match");
  }
}

async function assertRemoteOwnerMarker({ remoteRecoveryRoot, expectedOwner, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const result = await requireRun(runBuffered, rcloneExe, ["cat", appendRemote(remoteRecoveryRoot, OWNER_FILE), "--config", rcloneConfigFile], { cwd, env });
  let owner;
  try { owner = JSON.parse(result.stdout || "null"); } catch {
    throw recoveryError("sync_recovery_review_required", "Remote recovery owner marker is unreadable");
  }
  if (JSON.stringify(owner) !== JSON.stringify(expectedOwner)) {
    throw recoveryError("sync_recovery_review_required", "Remote recovery owner marker does not match");
  }
}

function receiptForRun(manifest, run, relation, namespace, excludePattern) {
  return {
    type: "bisync-recovery-preflight",
    version: 1,
    issuer: "sync-recovery-preflight",
    status: "ready",
    preflightKind: run.preflightKind,
    migrationStatus: run.migrationStatus,
    migrationRecordId: run.migrationRecordId,
    relationId: relation.relationId,
    baselineId: relation.baselineId,
    rootId: relation.rootId,
    namespace,
    namespaceWasEmpty: run.namespaceWasEmpty,
    runNamespaceWasEmpty: true,
    priorListingNamespaceWasEmpty: true,
    ownerRecordId: manifest.ownerRecordId,
    runId: run.runId,
    backupDir1: run.backupDir1,
    backupDir2: run.backupDir2,
    excludePattern,
    createdAt: run.createdAt
  };
}

function assertNewRunNamespaceEmpty(runId, manifest, localPresence, remotePresence) {
  const prefix = `runs/${runId}`;
  if (manifest.runs.some((run) => run.runId === runId)
    || localPresence.entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))
    || remotePresence.entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))) {
    throw recoveryError("sync_recovery_review_required", "Generated recovery run namespace already contains data");
  }
}

function isOwnedRunPath(path, runIds, side) {
  const parts = String(path).split("/");
  while (parts.at(-1) === "") parts.pop();
  if (parts[0] !== "runs") return false;
  if (parts.length === 1) return true;
  if (!runIds.has(parts[1])) return false;
  if (parts.length === 2) return true;
  return parts[2] === side && parts.slice(3).every((part) => part && part !== "." && part !== "..");
}

function ownerManifest(relation, createdAt) {
  return {
    type: "sync-recovery-owner",
    version: 1,
    ownerRecordId: `${relation.relationId}:${relation.baselineId}:${relation.rootId}`,
    relationId: relation.relationId,
    baselineId: relation.baselineId,
    rootId: relation.rootId,
    createdAt,
    runs: [],
    migrations: []
  };
}

function validateManifest(value, relation) {
  if (value == null) return null;
  const expected = ownerManifest(relation, value.createdAt);
  if (value.type !== expected.type || value.version !== 1 || !["preparing", "ready"].includes(value.status)
    || value.ownerRecordId !== expected.ownerRecordId
    || value.relationId !== relation.relationId || value.baselineId !== relation.baselineId || value.rootId !== relation.rootId
    || !Array.isArray(value.runs) || !Array.isArray(value.migrations)
    || value.runs.some((run) => {
      if (!isUuid(run?.runId) || !["preparing", "prepared", "running", "completed", "failed"].includes(run.status)
        || !Number.isFinite(Date.parse(run.createdAt))
        || !["new-relation", "existing-relation-migration"].includes(run.preflightKind)
        || (run.preflightKind === "new-relation" && (run.migrationStatus !== "not-applicable" || run.migrationRecordId !== ""))
        || (run.preflightKind === "existing-relation-migration" && (run.migrationStatus !== "recorded" || !isUuid(run.migrationRecordId)))) return true;
      const root = `${RESERVED_ROOT}/${relation.relationId}/runs/${run.runId}`;
      return normalizeRoot(run.backupDir1) !== normalizeRoot(join(resolve(relation.localRoot), ...root.split("/"), "path1"))
        || run.backupDir2 !== appendRemote(relation.rclone?.remotePath, `${root}/path2`)
        || (run.migrationRecordId && !value.migrations.some((migration) => migration.id === run.migrationRecordId
          && migration.baselineId === relation.baselineId && migration.rootId === relation.rootId));
    })
    || new Set(value.runs.map((run) => run.runId)).size !== value.runs.length
    || value.migrations.some((migration) => !isUuid(migration?.id)
      || migration.baselineId !== relation.baselineId || migration.rootId !== relation.rootId)) {
    throw recoveryError("sync_recovery_review_required", "Protected recovery state belongs to a different relation or baseline");
  }
  return value;
}

function validateBaselineEntry(relation, entry) {
  if (!entry) return false;
  if (!entry.initializedAt || entry.relationId !== relation.relationId || entry.baselineId !== relation.baselineId
    || entry.rootId !== relation.rootId || entry.baselineEpoch !== relation.baselineEpoch
    || entry.workdir !== relation.rclone.workdir) {
    throw recoveryError("sync_recovery_review_required", "Existing baseline entry does not match the trusted relation");
  }
  return true;
}

function assertTrustedContext(job, relation) {
  if (!job || !relation || job.direction !== "bidirectional" || relation.direction !== "bidirectional"
    || relation.schemaVersion !== 1
    || !job.syncRelation || job.syncRelation.relationId !== relation.relationId
    || job.syncRelation.baselineId !== relation.baselineId || job.syncRelation.rootId !== relation.rootId
    || job.syncRelation.rclone?.remotePath !== relation.rclone?.remotePath
    || relation.identityAssurance !== "trusted-binding" || relation.rootAttested !== true
    || !relation.trustedBindingId || !relation.relationId || !relation.baselineId
    || !/^[A-Za-z0-9_-]{1,128}$/.test(String(relation.relationId))
    || !/^root_[A-Za-z0-9_-]{16,128}$/.test(String(relation.rootId || ""))
    || job.storageBackend !== relation.backend
    || !relation.authorization?.directions?.includes("bidirectional")
    || relation.authorization?.allowDelete !== true
    || !job.localPath || !relation.localRoot
    || normalizeRoot(job.localPath) !== normalizeRoot(relation.localRoot)) {
    throw recoveryError("sync_recovery_trusted_relation_required", "Recovery preflight requires a normalized job and trusted attested bidirectional relation");
  }
}

function normalizeRoot(value) {
  return resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
}

function assertDependencies(values) {
  if (!values.runBuffered) throw new TypeError("Recovery requires an injected runner");
  if (values.recoveryStateFile && typeof values.readProtected !== "function") throw new TypeError("Recovery requires a protected state reader");
  if (values.recoveryStateFile && typeof values.writeProtected !== "function" && values.writeProtected !== undefined) throw new TypeError("Recovery protected state writer must be a function");
  if (!values.runBuffered || !values.rcloneExe || !values.rcloneConfigFile) throw new TypeError("Recovery requires rclone execution inputs");
}

function assertPrepareWriter(writeProtected) {
  if (typeof writeProtected !== "function") throw new TypeError("Recovery preparation requires a protected state writer");
}

async function requireRun(runBuffered, executable, args, options) {
  const result = await runBuffered(executable, args, options);
  if (!result?.ok) throw recoveryError("sync_recovery_preflight_failed", "A recovery preflight rclone command failed");
  return result;
}

async function listRemoteRows({ path, runBuffered, rcloneExe, rcloneConfigFile, env, cwd, dirsOnly = false, recursive = false }) {
  const args = ["lsjson", path, "--config", rcloneConfigFile];
  if (dirsOnly) args.push("--dirs-only");
  if (recursive) args.push("--recursive");
  const result = await requireRun(runBuffered, rcloneExe, args, { cwd, env });
  let rows;
  try { rows = JSON.parse(result.stdout || "[]"); } catch {
    throw recoveryError("sync_recovery_preflight_failed", "Rclone returned invalid JSON while checking recovery storage");
  }
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.Path !== "string")) {
    throw recoveryError("sync_recovery_preflight_failed", "Rclone returned an invalid recovery listing");
  }
  return rows;
}

async function listRemoteFiles(options) {
  const rows = await listRemoteRows({ ...options, recursive: true });
  return rows.filter((row) => row.IsDir !== true).map((row) => String(row.Path).replace(/\\/g, "/"));
}

async function listLocalFiles(root) {
  return listLocalRelativeEntries(root).then((entries) => entries.filter((entry) => !entry.endsWith("/")).map((entry) => entry.replace(/\\/g, "/")));
}

async function listLocalRelativeEntries(root, prefix = "") {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw recoveryError("sync_recovery_review_required", "Symlink found in recovery namespace");
    if (entry.isDirectory()) {
      entries.push(`${name}/`);
      entries.push(...await listLocalRelativeEntries(path, name));
    } else if (entry.isFile()) {
      entries.push(name);
    } else {
      throw recoveryError("sync_recovery_review_required", "Unsupported filesystem entry found in recovery namespace");
    }
  }
  return entries;
}

function isWithinNamespace(name, namespace) {
  return name === namespace || name.startsWith(`${namespace}/`);
}

function appendRemote(root, child) {
  const normalizedRoot = String(root).replace(/\/+$/, "");
  const normalizedChild = String(child).replace(/^\/+/, "");
  return normalizedRoot.endsWith(":")
    ? `${normalizedRoot}${normalizedChild}`
    : `${normalizedRoot}/${normalizedChild}`;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/")
    && !value.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":") || part.includes("\0"));
}

function safeLocalDestination(localRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw recoveryError("validation_failed", "Restore target must be a safe relative path");
  const root = resolve(localRoot);
  const destination = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, destination);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw recoveryError("validation_failed", "Restore target must be inside the local sync root");
  }
  return destination;
}

async function assertSafeDestinationAncestors(localRoot, destination) {
  const root = resolve(localRoot);
  const relativePath = relative(root, destination);
  const segments = relativePath.split(sep).slice(0, -1);
  let current = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw recoveryError("sync_recovery_restore_target_invalid", "Restore root is not a plain directory");
  }
  for (const segment of ["", ...segments].filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw recoveryError("sync_recovery_restore_target_invalid", "Restore target parent is not a plain directory");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function sourceSha256ForRestore({ side, source, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  if (side === "path1") {
    let info;
    try { info = await lstat(source); } catch { /* fail below */ }
    if (!info?.isFile() || info.isSymbolicLink()) throw recoveryError("sync_recovery_version_not_found", "Saved recovery file no longer exists");
    return sha256File(source);
  }
  const result = await runBuffered(rcloneExe, ["hashsum", "sha256", source, "--download", "--config", rcloneConfigFile], { cwd, env });
  if (!result?.ok) throw recoveryError("sync_recovery_version_not_found", "Saved remote recovery file could not be hashed");
  const rows = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const match = rows.length === 1 ? /^([0-9a-f]{64})\s+.+$/i.exec(rows[0]) : null;
  if (!match) throw recoveryError("sync_recovery_preflight_failed", "Remote recovery hash output is invalid");
  return match[1].toLowerCase();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function verifyCurrentOwnedNamespace({ job, relation, manifest, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const localRoot = resolve(job.localPath);
  const localRecoveryRoot = join(localRoot, RESERVED_ROOT, relation.relationId);
  const remoteRecoveryRoot = appendRemote(relation.rclone.remotePath, `${RESERVED_ROOT}/${relation.relationId}`);
  const [localPresence, remotePresence] = await Promise.all([
    inspectLocalNamespace(localRoot, relation.relationId),
    inspectRemoteNamespace({ remoteRoot: relation.rclone.remotePath, relationId: relation.relationId,
      remoteRecoveryRoot, runBuffered, rcloneExe, rcloneConfigFile, env, cwd })
  ]);
  await verifyOwnedNamespace({ manifest, relation, localRecoveryRoot, localPresence, remoteRecoveryRoot,
    remotePresence, runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
}

function pruneRestorePreviews() {
  const now = Date.now();
  for (const [id, preview] of RESTORE_PREVIEWS) {
    if (now - Date.parse(preview.createdAt) > 10 * 60 * 1000) {
      RESTORE_PREVIEWS.delete(id);
      rm(preview.stagedPath, { force: true }).catch(() => {});
    }
  }
  while (RESTORE_PREVIEWS.size > 100) {
    const id = RESTORE_PREVIEWS.keys().next().value;
    const preview = RESTORE_PREVIEWS.get(id);
    RESTORE_PREVIEWS.delete(id);
    if (preview) rm(preview.stagedPath, { force: true }).catch(() => {});
  }
}
