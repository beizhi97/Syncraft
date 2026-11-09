import { createHash, randomUUID } from "node:crypto";
import { constants, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PREVIEWS = new Map();
const STATE_TYPE = "sync-first-bisync-conflicts";
const STAGE_PREFIX = "first-bisync-conflict-";
const MAX_PREVIEW_AGE_MS = 30 * 60 * 1000;

/** Scan a new trusted relation and stage both byte streams before initialization. */
export async function previewFirstBisyncConflicts(options = {}) {
  const { job, relation = job?.syncRelation, baselineEntry = null, conflictStateFile,
    stagingRoot, protectStagingFile, runBuffered, rcloneExe, rcloneConfigFile,
    env = {}, cwd, now = () => new Date() } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ conflictStateFile, readProtected: options.readProtected, writeProtected: options.writeProtected,
    stagingRoot, protectStagingFile, runBuffered, rcloneExe, rcloneConfigFile });
  if (baselineEntry) throw conflictError("first_sync_conflict_review_required", "An initialized relation cannot use first-sync conflict preparation");
  if (relation.filters?.exclude?.length) throw conflictError("first_sync_conflict_review_required", "First-sync conflict preparation requires an unfiltered relation");
  await assertNoBisyncListings(job, relation);
  await assertEmptyConflictState(options, relation);
  const localRoot = resolve(job.localPath);
  await assertPlainDirectory(localRoot, "Local sync root");
  const overlaps = await scanCurrentConflicts(localRoot, relation, { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });

  const operationId = randomUUID();
  const stageDir = join(resolve(stagingRoot), `${STAGE_PREFIX}${operationId}`);
  await ensurePrivateDirectory(resolve(stagingRoot));
  await mkdir(stageDir, { recursive: false });
  const entries = [];
  try {
    for (let index = 0; index < overlaps.length; index += 1) {
      const conflict = overlaps[index];
      const localStage = join(stageDir, `${index}-local.bin`);
      const remoteStage = join(stageDir, `${index}-remote.bin`);
      const localSource = join(localRoot, ...conflict.path.split("/"));
      const remoteSource = appendRemote(relation.rclone.remotePath, conflict.path);
      await createProtectedStage(localStage, protectStagingFile);
      await copyFile(localSource, localStage);
      await protectStagingFile(localStage);
      await createProtectedStage(remoteStage, protectStagingFile);
      await requireRun(runBuffered, rcloneExe, ["copyto", remoteSource, remoteStage, "--config", rcloneConfigFile], { cwd, env });
      await protectStagingFile(remoteStage);
      if (await sha256File(localStage) !== conflict.localHash || await sha256File(remoteStage) !== conflict.remoteHash) {
        throw conflictError("first_sync_conflict_source_changed", "A conflict source changed while it was being staged");
      }
      entries.push({ ...conflict, index, localStage, remoteStage,
        localTarget: conflictTarget(conflict.path, operationId, index, "local"),
        remoteTarget: conflictTarget(conflict.path, operationId, index, "remote") });
    }
    await verifySourcesUnchanged(entries, localRoot, relation, { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  } catch (error) {
    // Keep protected staging material for inspection; never silently remove evidence after a failed scan.
    throw error;
  }
  const previewId = randomUUID();
  const preview = { previewId, operationId, relationId: relation.relationId, baselineId: relation.baselineId,
    rootId: relation.rootId, localRoot, stagingRoot: resolve(stagingRoot), stageDir, createdAt: now().toISOString(), entries };
  PREVIEWS.set(previewId, preview);
  prunePreviews(now().getTime());
  return publicPreview(preview);
}

/** Save staged versions into the sync root. This is idempotent only for exact journal hashes. */
export async function saveFirstBisyncConflicts(options = {}) {
  const { previewId } = options;
  const preview = PREVIEWS.get(String(previewId || ""));
  const { job, relation = job?.syncRelation } = options;
  assertTrustedContext(job, relation);
  if (!preview || !previewMatches(preview, relation, job)) {
    throw conflictError("first_sync_conflict_preview_required", "A current preview for this trusted relation is required");
  }
  if (Date.now() - Date.parse(preview.createdAt) > MAX_PREVIEW_AGE_MS) {
    throw conflictError("first_sync_conflict_preview_expired", "The conflict preview expired; scan again before saving");
  }
  PREVIEWS.delete(preview.previewId);
  const { conflictStateFile, readProtected, writeProtected, protectStagingFile, runBuffered, rcloneExe,
    rcloneConfigFile, env = {}, cwd } = options;
  assertDependencies({ conflictStateFile, readProtected, writeProtected, stagingRoot: options.stagingRoot,
    protectStagingFile, runBuffered, rcloneExe, rcloneConfigFile });
  if (typeof options.stagingRoot !== "string" || resolve(options.stagingRoot) !== preview.stagingRoot) {
    throw conflictError("first_sync_conflict_review_required", "Protected staging root changed after conflict preview");
  }
  await verifySourcesUnchanged(preview.entries, preview.localRoot, relation, { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  const state = await readProtected(conflictStateFile, null);
  const manifest = validateState(state, relation);
  if (manifest.operations.some(op => op.operationId === preview.operationId)) {
    throw conflictError("first_sync_conflict_review_required", "The operation ID already exists in protected state");
  }
  const operation = operationFromPreview(preview);
  manifest.operations.push(operation);
  await writeProtected(conflictStateFile, manifest);
  return continueSave({ ...options, operationId: preview.operationId });
}

/** Resume only the exact operation already journaled in protected state. */
export async function resumeFirstBisyncConflictSave(options = {}) {
  const { job, relation = job?.syncRelation, conflictStateFile, readProtected } = options;
  assertTrustedContext(job, relation);
  assertDependencies({ conflictStateFile, readProtected, writeProtected: options.writeProtected,
    stagingRoot: options.stagingRoot, protectStagingFile: options.protectStagingFile, runBuffered: options.runBuffered,
    rcloneExe: options.rcloneExe, rcloneConfigFile: options.rcloneConfigFile });
  const manifest = validateState(await readProtected(conflictStateFile, null), relation);
  const operation = manifest.operations.find(entry => entry.operationId === options.operationId);
  if (!operation) throw conflictError("first_sync_conflict_review_required", "No protected journal exists for this operation ID");
  if (resolve(options.stagingRoot) !== operation.stagingRoot) throw conflictError("first_sync_conflict_review_required", "Protected staging root does not match the journal");
  return continueSave({ ...options, operationId: operation.operationId });
}

/** Return only operations bound to this relation so the UI can resume after a process restart. */
export async function listFirstBisyncConflictOperations(options = {}) {
  const { job, relation = job?.syncRelation, conflictStateFile, readProtected } = options;
  assertTrustedContext(job, relation);
  if (!conflictStateFile || typeof readProtected !== "function") {
    throw new TypeError("First-sync conflict operation listing requires protected state");
  }
  const manifest = validateState(await readProtected(conflictStateFile, null), relation);
  return manifest.operations.map(operation => ({
    operationId: operation.operationId,
    status: operation.status,
    createdAt: operation.createdAt,
    savedAt: operation.savedAt || "",
    conflicts: operation.entries.map(entry => ({ ...publicEntry(entry), status: entry.status }))
  }));
}

/** Recheck originals and visible copies immediately before first bisync initialization. */
export async function verifyFirstBisyncConflictsSaved(options = {}) {
  const { job, relation = job?.syncRelation, conflictStateFile, readProtected,
    runBuffered, rcloneExe, rcloneConfigFile, env = {}, cwd, operationId } = options;
  assertTrustedContext(job, relation);
  assertReadDependencies({ conflictStateFile, readProtected, runBuffered, rcloneExe, rcloneConfigFile });
  const manifest = validateState(await readProtected(conflictStateFile, null), relation);
  const operation = manifest.operations.find(entry => entry.operationId === operationId);
  if (!operation || operation.status !== "saved") throw conflictError("first_sync_conflict_review_required", "Conflict copies are not fully saved for this operation");
  const currentConflicts = await scanCurrentConflicts(resolve(job.localPath), relation,
    { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  assertConflictSetMatches(operation.entries, currentConflicts);
  await verifySourcesUnchanged(operation.entries, resolve(job.localPath), relation, { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
  for (const entry of operation.entries) {
    await verifyTarget(resolve(job.localPath), entry.localTarget, entry.localHash);
    await verifyTarget(resolve(job.localPath), entry.remoteTarget, entry.remoteHash);
  }
  return { operationId, relationId: relation.relationId, baselineId: relation.baselineId, rootId: relation.rootId,
    status: "ready-for-initialization", conflicts: operation.entries.map(publicEntry) };
}

async function continueSave(options) {
  const { job, relation = job?.syncRelation, conflictStateFile, readProtected, writeProtected,
    protectStagingFile, runBuffered, rcloneExe, rcloneConfigFile, env = {}, cwd, operationId } = options;
  assertTrustedContext(job, relation);
  const localRoot = resolve(job.localPath);
  const manifest = validateState(await readProtected(conflictStateFile, null), relation);
  const operation = manifest.operations.find(entry => entry.operationId === operationId);
  if (!operation) throw conflictError("first_sync_conflict_review_required", "Protected conflict journal no longer contains this operation");
  if (operation.status === "saved") return { operationId, status: operation.status, createdAt: operation.createdAt,
    savedAt: operation.savedAt || "", conflicts: operation.entries.map(entry => ({ ...publicEntry(entry), status: entry.status })) };
  if (operation.status !== "saving") throw conflictError("first_sync_conflict_review_required", "Conflict operation is not resumable");
  for (const entry of operation.entries) {
    await assertStagedEntry(entry, operation, protectStagingFile);
    await verifySourceEntry(entry, localRoot, relation, { runBuffered, rcloneExe, rcloneConfigFile, env, cwd });
    await ensureExclusiveCopy(localRoot, entry.localStage, join(localRoot, ...entry.localTarget.split("/")), entry.localHash);
    await ensureExclusiveCopy(localRoot, entry.remoteStage, join(localRoot, ...entry.remoteTarget.split("/")), entry.remoteHash);
    entry.status = "saved";
    await writeProtected(conflictStateFile, manifest);
  }
  operation.status = "saved";
  operation.savedAt = new Date().toISOString();
  await writeProtected(conflictStateFile, manifest);
  return { operationId, status: operation.status, createdAt: operation.createdAt, savedAt: operation.savedAt || "",
    conflicts: operation.entries.map(entry => ({ ...publicEntry(entry), status: entry.status })) };
}

function operationFromPreview(preview) {
  return { operationId: preview.operationId, relationId: preview.relationId, baselineId: preview.baselineId,
    rootId: preview.rootId, localRoot: normalizeRoot(preview.localRoot), stagingRoot: preview.stagingRoot, stageDir: preview.stageDir,
    createdAt: preview.createdAt, status: "saving", savedAt: "",
    entries: preview.entries.map(entry => ({ ...entry, status: "pending" })) };
}

function validateState(value, relation) {
  const owner = `${relation.relationId}:${relation.baselineId}:${relation.rootId}`;
  if (value == null) return { type: STATE_TYPE, version: 1, owner, relationId: relation.relationId,
    baselineId: relation.baselineId, rootId: relation.rootId, operations: [] };
  if (value.type !== STATE_TYPE || value.version !== 1 || value.owner !== owner
    || value.relationId !== relation.relationId || value.baselineId !== relation.baselineId || value.rootId !== relation.rootId
    || !Array.isArray(value.operations)) {
    throw conflictError("first_sync_conflict_review_required", "Protected conflict journal belongs to another relation or has an invalid shape");
  }
  for (const operation of value.operations) validateOperation(operation, value, relation);
  if (new Set(value.operations.map(entry => entry.operationId)).size !== value.operations.length) {
    throw conflictError("first_sync_conflict_review_required", "Protected conflict journal contains duplicate operation IDs");
  }
  return value;
}

function validateOperation(operation, manifest, relation) {
  if (!isUuid(operation?.operationId) || operation.relationId !== relation.relationId
    || operation.baselineId !== relation.baselineId || operation.rootId !== relation.rootId
    || operation.localRoot !== normalizeRoot(relation.localRoot) || !["saving", "saved"].includes(operation.status)
    || !Array.isArray(operation.entries) || !isAbsolute(operation.stageDir) || !isAbsolute(operation.stagingRoot)
    || dirname(operation.stageDir) !== operation.stagingRoot
    || basename(operation.stageDir) !== `${STAGE_PREFIX}${operation.operationId}`) {
    throw conflictError("first_sync_conflict_review_required", "Protected conflict operation is malformed");
  }
  const seenTargets = new Set();
  for (let index = 0; index < operation.entries.length; index += 1) {
    const entry = operation.entries[index];
    if (entry.index !== index || !isSafeRelativePath(entry.path) || !isHash(entry.localHash) || !isHash(entry.remoteHash)
      || entry.localHash === entry.remoteHash || entry.localStage !== join(operation.stageDir, `${index}-local.bin`)
      || entry.remoteStage !== join(operation.stageDir, `${index}-remote.bin`)
      || entry.localTarget !== conflictTarget(entry.path, operation.operationId, index, "local")
      || entry.remoteTarget !== conflictTarget(entry.path, operation.operationId, index, "remote")
      || !["pending", "saved"].includes(entry.status)) {
      throw conflictError("first_sync_conflict_review_required", "Protected conflict entry is malformed");
    }
    for (const target of [entry.localTarget, entry.remoteTarget]) {
      if (seenTargets.has(target)) throw conflictError("first_sync_conflict_review_required", "Conflict targets are duplicated");
      seenTargets.add(target);
    }
  }
  if (operation.status === "saved" && operation.entries.some(entry => entry.status !== "saved")) {
    throw conflictError("first_sync_conflict_review_required", "Saved operation has unfinished entries");
  }
}

async function assertEmptyConflictState(options, relation) {
  const { conflictStateFile, readProtected } = options;
  if (typeof readProtected !== "function") throw new TypeError("Conflict preview requires protected state access");
  const manifest = validateState(await readProtected(conflictStateFile, null), relation);
  if (manifest.operations.some(operation => operation.status !== "saved")) {
    throw conflictError("first_sync_conflict_review_required", "A prior first-sync conflict operation is incomplete; resume it first");
  }
}

async function scanCurrentConflicts(localRoot, relation, context) {
  if (relation.filters?.exclude?.length) throw conflictError("first_sync_conflict_review_required", "First-sync conflict preparation requires an unfiltered relation");
  const [localFiles, remoteFiles] = await Promise.all([
    listLocalFiles(localRoot),
    listRemoteFiles({ relation, ...context })
  ]);
  const remoteByPath = new Map();
  const remoteCasePaths = new Map();
  for (const file of remoteFiles) {
    const folded = file.path.toLocaleLowerCase("en-US");
    if (remoteCasePaths.has(folded)) throw conflictError("first_sync_conflict_review_required", "Remote listing has case-colliding paths that cannot be safely initialized on this client");
    remoteCasePaths.set(folded, file.path);
    remoteByPath.set(file.path, file);
  }
  const conflicts = [];
  for (const local of localFiles) {
    const folded = local.path.toLocaleLowerCase("en-US");
    const remoteCasePath = remoteCasePaths.get(folded);
    if (remoteCasePath && remoteCasePath !== local.path) {
      throw conflictError("first_sync_conflict_review_required", "Local and remote names differ only by case; review the paths before initialization");
    }
    const remote = remoteByPath.get(local.path);
    if (!remote) continue;
    const localHash = await sha256File(local.absolutePath);
    const remoteHash = await hashRemoteFile(remote.absolutePath, context);
    if (localHash !== remoteHash) conflicts.push({ path: local.path, localHash, remoteHash, localSize: local.size, remoteSize: remote.size });
  }
  return conflicts;
}

function assertConflictSetMatches(savedEntries, currentConflicts) {
  const saved = new Map(savedEntries.map(entry => [entry.path, entry]));
  if (saved.size !== currentConflicts.length) {
    throw conflictError("first_sync_conflict_set_changed", "Files changed after the conflict preview; preview and save the current conflicts again");
  }
  for (const current of currentConflicts) {
    const prior = saved.get(current.path);
    if (!prior || prior.localHash !== current.localHash || prior.remoteHash !== current.remoteHash) {
      throw conflictError("first_sync_conflict_set_changed", "Files changed after the conflict preview; preview and save the current conflicts again");
    }
  }
}

async function assertNoBisyncListings(job, relation) {
  const workdir = relation.rclone?.workdir;
  if (!workdir || !isAbsolute(workdir)) throw conflictError("first_sync_conflict_review_required", "A trusted bisync work directory is required");
  const files = await readdir(workdir).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const stem = `${String(job.localPath).replace(/[\\/:]/g, "_")}..${String(relation.rclone.remotePath).replace(/[\\/:]/g, "_")}`;
  if (files.some(name => name.startsWith(stem) && /\.path[12]\.lst(?:-(?:old|dry))?$/.test(name))) {
    throw conflictError("first_sync_conflict_review_required", "Bisync listing files already exist; first-sync conflict preparation is blocked");
  }
}

async function listLocalFiles(root, directory = root, prefix = "") {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw conflictError("first_sync_conflict_review_required", "Symlink found while scanning the local sync root");
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (relativePath === ".syncraft-recovery" || relativePath.startsWith(".syncraft-recovery/")) continue;
    if (item.isDirectory()) files.push(...await listLocalFiles(root, join(directory, item.name), relativePath));
    else if (item.isFile()) {
      const absolutePath = join(directory, item.name);
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) throw conflictError("first_sync_conflict_review_required", "Non-regular file found while scanning the local sync root");
      files.push({ path: relativePath, absolutePath, size: info.size });
    }
  }
  return files;
}

async function listRemoteFiles({ relation, runBuffered, rcloneExe, rcloneConfigFile, env, cwd }) {
  const result = await requireRun(runBuffered, rcloneExe, ["lsjson", relation.rclone.remotePath, "--recursive", "--config", rcloneConfigFile], { cwd, env });
  let rows;
  try { rows = JSON.parse(result.stdout || "[]"); } catch { throw conflictError("first_sync_conflict_scan_failed", "Rclone returned invalid JSON while scanning remote files"); }
  if (!Array.isArray(rows)) throw conflictError("first_sync_conflict_scan_failed", "Rclone returned an invalid remote listing");
  return rows.filter(row => row?.IsDir !== true).map(row => {
    const path = String(row?.Path || "").replace(/\\/g, "/");
    if (!isSafeRelativePath(path) || !Number.isFinite(Number(row?.Size)) || Number(row.Size) < 0) {
      throw conflictError("first_sync_conflict_scan_failed", "Rclone returned an unsafe or incomplete remote file entry");
    }
    return { path, size: Number(row.Size), absolutePath: appendRemote(relation.rclone.remotePath, path) };
  });
}

async function hashRemoteFile(path, context) {
  const result = await requireRun(context.runBuffered, context.rcloneExe,
    ["hashsum", "sha256", path, "--download", "--config", context.rcloneConfigFile], { cwd: context.cwd, env: context.env });
  const match = /^([a-f0-9]{64})\s+(.+)\s*$/i.exec(String(result.stdout || "").trim());
  if (!match) throw conflictError("first_sync_conflict_scan_failed", "Rclone did not return a verifiable SHA-256 for a remote file");
  return match[1].toLowerCase();
}

async function verifySourcesUnchanged(entries, localRoot, relation, context) {
  for (const entry of entries) await verifySourceEntry(entry, localRoot, relation, context);
}

async function verifySourceEntry(entry, localRoot, relation, context) {
  const localPath = join(localRoot, ...entry.path.split("/"));
  if (await sha256File(localPath).catch(() => "") !== entry.localHash) {
    throw conflictError("first_sync_conflict_source_changed", "A local conflict source changed after preview");
  }
  const remotePath = appendRemote(relation.rclone.remotePath, entry.path);
  if (await hashRemoteFile(remotePath, context) !== entry.remoteHash) {
    throw conflictError("first_sync_conflict_source_changed", "A remote conflict source changed after preview");
  }
}

async function assertStagedEntry(entry, operation, protectStagingFile) {
  if (!entry.localStage.startsWith(`${operation.stageDir}${sep}`) || !entry.remoteStage.startsWith(`${operation.stageDir}${sep}`)) {
    throw conflictError("first_sync_conflict_review_required", "Staging paths do not belong to the journaled operation");
  }
  const stageInfo = await lstat(operation.stageDir);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw conflictError("first_sync_conflict_review_required", "Protected staging directory is invalid");
  for (const [path, expected] of [[entry.localStage, entry.localHash], [entry.remoteStage, entry.remoteHash]]) {
    if (await sha256File(path).catch(() => "") !== expected) throw conflictError("first_sync_conflict_stage_invalid", "Protected staged content is missing or changed");
    await protectStagingFile(path);
  }
}

async function ensureExclusiveCopy(root, source, target, expectedHash) {
  await mkdir(dirname(target), { recursive: true });
  await assertSafeAncestors(root, target);
  const existing = await lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw conflictError("first_sync_conflict_target_exists", "A non-regular file occupies a conflict copy target");
  }
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await sha256File(target).catch(() => "") !== expectedHash) {
      throw conflictError("first_sync_conflict_target_exists", "An unknown file occupies a conflict copy target");
    }
  }
  if (await sha256File(target) !== expectedHash) throw conflictError("first_sync_conflict_target_invalid", "Saved conflict copy failed hash verification");
}

async function verifyTarget(localRoot, relativePath, expectedHash) {
  const absolutePath = join(localRoot, ...relativePath.split("/"));
  const info = await lstat(absolutePath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info || !info.isFile() || info.isSymbolicLink()) throw conflictError("first_sync_conflict_target_invalid", "A saved conflict copy is missing or is not a regular file");
  if (await sha256File(absolutePath).catch(() => "") !== expectedHash) {
    throw conflictError("first_sync_conflict_target_invalid", "A saved conflict copy is missing or changed");
  }
}

async function assertSafeAncestors(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw conflictError("first_sync_conflict_review_required", "Conflict copy target escapes the local sync root");
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw conflictError("first_sync_conflict_review_required", "Conflict copy parent is not a plain directory");
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflictError("first_sync_conflict_staging_invalid", "Protected staging root is not a plain directory");
}

async function createProtectedStage(path, protectStagingFile) {
  await writeFile(path, Buffer.alloc(0), { flag: "wx" });
  await protectStagingFile(path);
}

async function assertPlainDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflictError("first_sync_conflict_review_required", `${label} is not a plain directory`);
}

function conflictTarget(relativePath, operationId, index, side) {
  const parent = relativePath.split("/").slice(0, -1).join("/");
  // Keep each component short even when the original filename is near Windows' limit.
  const name = `sfsc-${operationId}-${index}-${side === "local" ? "l" : "r"}.conflict`;
  return parent ? `${parent}/${name}` : name;
}

function publicPreview(preview) {
  return { previewId: preview.previewId, operationId: preview.operationId, relationId: preview.relationId,
    baselineId: preview.baselineId, rootId: preview.rootId, createdAt: preview.createdAt,
    conflicts: preview.entries.map(publicEntry) };
}

function publicEntry(entry) {
  return { path: entry.path, localHash: entry.localHash, remoteHash: entry.remoteHash,
    localSize: entry.localSize, remoteSize: entry.remoteSize, localTarget: entry.localTarget, remoteTarget: entry.remoteTarget };
}

function previewMatches(preview, relation, job) {
  return preview.relationId === relation.relationId && preview.baselineId === relation.baselineId
    && preview.rootId === relation.rootId && preview.localRoot === resolve(job.localPath);
}

function prunePreviews(now) {
  for (const [id, preview] of PREVIEWS) if (now - Date.parse(preview.createdAt) > MAX_PREVIEW_AGE_MS) PREVIEWS.delete(id);
}

function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
    && !value.includes(":") && value.split("/").every(part => part && part !== "." && part !== "..");
}

function assertTrustedContext(job, relation) {
  if (!job || !relation || job.direction !== "bidirectional" || relation.direction !== "bidirectional"
    || relation.schemaVersion !== 1 || !job.syncRelation
    || job.syncRelation.relationId !== relation.relationId || job.syncRelation.baselineId !== relation.baselineId
    || job.syncRelation.rootId !== relation.rootId || job.syncRelation.rclone?.remotePath !== relation.rclone?.remotePath
    || relation.identityAssurance !== "trusted-binding" || relation.rootAttested !== true
    || !relation.trustedBindingId || !relation.relationId || !relation.baselineId
    || !/^[A-Za-z0-9_-]{1,128}$/.test(String(relation.relationId))
    || !/^root_[A-Za-z0-9_-]{16,128}$/.test(String(relation.rootId || ""))
    || job.storageBackend !== relation.backend || !relation.authorization?.directions?.includes("bidirectional")
    || relation.authorization?.allowDelete !== true || !job.localPath || !relation.localRoot
    || normalizeRoot(job.localPath) !== normalizeRoot(relation.localRoot)) {
    throw conflictError("first_sync_conflict_trusted_relation_required", "Conflict preparation requires a normalized trusted attested bidirectional relation");
  }
}

function assertDependencies(values) {
  if (!values.conflictStateFile || typeof values.readProtected !== "function" || typeof values.writeProtected !== "function"
    || !values.stagingRoot || !isAbsolute(values.stagingRoot) || typeof values.protectStagingFile !== "function"
    || typeof values.runBuffered !== "function" || !values.rcloneExe || !values.rcloneConfigFile) {
    throw new TypeError("First-sync conflict handling requires protected state, protected staging, and rclone dependencies");
  }
}

function assertReadDependencies(values) {
  if (!values.conflictStateFile || typeof values.readProtected !== "function"
    || typeof values.runBuffered !== "function" || !values.rcloneExe || !values.rcloneConfigFile) {
    throw new TypeError("First-sync conflict verification requires protected state and rclone dependencies");
  }
}

async function requireRun(runBuffered, executable, args, options) {
  const result = await runBuffered(executable, args, options);
  if (!result?.ok) throw conflictError("first_sync_conflict_command_failed", "An rclone conflict-safety command failed");
  return result;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function appendRemote(root, path) {
  return String(root).endsWith(":") ? `${root}${path}` : `${String(root).replace(/\/+$/, "")}/${path}`;
}

function normalizeRoot(value) { return resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase(); }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
function isHash(value) { return /^[a-f0-9]{64}$/.test(String(value || "")); }
function conflictError(code, message) { const error = new Error(message); error.code = code; return error; }
