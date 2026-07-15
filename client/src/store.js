import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHttpError, normalizeSyncRun } from "../../src/core/index.js";
import { getClientPaths } from "./paths.js";

const execFileAsync = promisify(execFile);
const fileWriteQueues = new Map();
const clientStateQueues = new Map();
const clientStateLockContext = new AsyncLocalStorage();

export async function readJsonFile(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      const wrapped = createHttpError("local_state_corrupt", 409, `Local state file is not valid JSON: ${basename(file)}`);
      wrapped.file = file;
      wrapped.fileName = basename(file);
      throw wrapped;
    }
    throw error;
  }
}

export async function writeJsonFile(file, value) {
  return withFileWriteLock(file, () => writeJsonFileUnlocked(file, value));
}

async function writeJsonFileUnlocked(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempFile, JSON.stringify(value, null, 2), "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

function withFileWriteLock(file, task) {
  const previous = fileWriteQueues.get(file) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.then(
    () => undefined,
    () => undefined
  ).then(() => {
    if (fileWriteQueues.get(file) === cleanup) {
      fileWriteQueues.delete(file);
    }
  });
  fileWriteQueues.set(file, cleanup);
  return run;
}

export function withClientStateLock(paths = getClientPaths(), task) {
  const key = clientStateLockKey(paths);
  const heldLocks = clientStateLockContext.getStore();
  if (heldLocks?.has(key)) {
    return task();
  }
  const previous = clientStateQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => clientStateLockContext.run(new Set([...(heldLocks || []), key]), task));
  const cleanup = run.then(
    () => undefined,
    () => undefined
  ).then(() => {
    if (clientStateQueues.get(key) === cleanup) {
      clientStateQueues.delete(key);
    }
  });
  clientStateQueues.set(key, cleanup);
  return run;
}

function clientStateLockKey(paths = {}) {
  const anchor = paths.profileFile || paths.jobsFile || paths.secretsFile || paths.syncHistoryFile || paths.claimRecoveryFile || paths.heartbeatSnapshotFile || ".";
  return dirname(anchor);
}

export async function readProfile(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const profile = await readJsonFile(paths.profileFile, null);
    return hydrateProfileSecrets(profile, paths);
  });
}

export async function readStoredProfile(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const profile = await readJsonFile(paths.profileFile, null);
    return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : null;
  });
}

export async function saveProfile(profile, paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const stored = await externalizeProfileSecrets(profile, paths);
    await writeJsonFile(paths.profileFile, stored);
    return hydrateProfileSecrets(stored, paths);
  });
}

export async function readJobs(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const jobs = await readStoredJobs(paths);
    return Promise.all(jobs.map((job) => hydrateJobSecrets(job, paths)));
  });
}

export async function readStoredJobs(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const jobs = await readJsonFile(paths.jobsFile, []);
    if (!Array.isArray(jobs)) {
      return [];
    }
    return jobs;
  });
}

export async function saveJob(job, paths = getClientPaths()) {
  return withClientStateLock(paths, () => withFileWriteLock(paths.jobsFile, async () => {
    const storedExistingJobs = await readStoredJobs(paths);
    const id = job.id || `job-${randomUUID()}`;
    const next = {
      ...job,
      id,
      updatedAt: new Date().toISOString()
    };
    const index = storedExistingJobs.findIndex((item) => item.id === id);
    const storedNext = await externalizeJobSecrets(next, paths);
    const storedJobs = [...storedExistingJobs];
    if (index >= 0) {
      storedJobs[index] = storedNext;
    } else {
      storedJobs.push(storedNext);
    }
    await writeJsonFileUnlocked(paths.jobsFile, storedJobs);
    return hydrateJobSecrets(storedNext, paths);
  }));
}

export async function saveJobs(jobs, paths = getClientPaths()) {
  return withClientStateLock(paths, () => withFileWriteLock(paths.jobsFile, async () => {
    const now = new Date().toISOString();
    const normalized = Array.isArray(jobs)
      ? jobs.map((job, index) => ({
          ...job,
          id: job.id || `job-${randomUUID()}-${index}`,
          updatedAt: now
        }))
      : [];
    const stored = await Promise.all(normalized.map((job) => externalizeJobSecrets(job, paths)));
    await writeJsonFileUnlocked(paths.jobsFile, stored);
    return Promise.all(stored.map((job) => hydrateJobSecrets(job, paths)));
  }));
}

export async function snapshotProfileImportState(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const files = [
      paths.profileFile,
      paths.jobsFile,
      paths.secretsFile || secretStoreFile(paths)
    ].filter(Boolean);
    return {
      type: "profile-import-state-snapshot",
      files: await Promise.all(files.map(snapshotStateFile))
    };
  });
}

export async function restoreProfileImportState(snapshot) {
  if (!snapshot || snapshot.type !== "profile-import-state-snapshot" || !Array.isArray(snapshot.files)) {
    return;
  }
  const firstFile = snapshot.files.find((entry) => entry?.file)?.file;
  return withClientStateLock({ profileFile: firstFile }, async () => {
    for (const entry of snapshot.files) {
      if (!entry?.file) {
        continue;
      }
      await withFileWriteLock(entry.file, async () => {
        if (entry.exists) {
          await writeTextFileUnlocked(entry.file, typeof entry.content === "string" ? entry.content : "");
        } else {
          await rm(entry.file, { force: true });
        }
      });
    }
  });
}

async function snapshotStateFile(file) {
  try {
    return {
      file,
      exists: true,
      content: await readFile(file, "utf8")
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        file,
        exists: false,
        content: ""
      };
    }
    throw error;
  }
}

async function writeTextFileUnlocked(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempFile, text, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function inspectSecretVault(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const file = secretStoreFile(paths);
    const [profile, jobs, secrets] = await Promise.all([
      readJsonFile(paths.profileFile, null),
      readJsonFile(paths.jobsFile, []),
      readSecrets(paths)
    ]);
    const refs = [
      ...collectSecretRefs(profile),
      ...collectSecretRefs(Array.isArray(jobs) ? jobs : [])
    ];
    const uniqueRefs = [...new Set(refs)];
    const missingRefs = uniqueRefs.filter((ref) => typeof secrets[ref] !== "string" || !secrets[ref]);
    const protection = await inspectSecretVaultProtection(file);
    return {
      backend: "file",
      path: file,
      protected: protection.protected,
      protection,
      refs: uniqueRefs.length,
      missingRefs,
      ok: missingRefs.length === 0
    };
  });
}

async function externalizeProfileSecrets(profile, paths) {
  if (!profile || typeof profile !== "object") {
    return profile;
  }
  const stored = structuredClone(profile);
  const secret = stored.storage?.secretAccessKey;
  if (typeof secret === "string" && secret) {
    const key = `profile:${stored.profileId || stored.clientName || "default"}:storage.secretAccessKey`;
    await writeSecret(paths, key, secret);
    stored.storage.secretAccessKey = { secretRef: key };
  }
  const heartbeatSecret = stored.heartbeat?.secret;
  if (typeof heartbeatSecret === "string" && heartbeatSecret) {
    const key = `profile:${stored.profileId || stored.clientName || "default"}:heartbeat.secret`;
    await writeSecret(paths, key, heartbeatSecret);
    stored.heartbeat.secret = { secretRef: key };
  }
  return stored;
}

async function hydrateProfileSecrets(profile, paths) {
  if (!profile || typeof profile !== "object") {
    return profile;
  }
  const hydrated = structuredClone(profile);
  if (isSecretReference(hydrated.storage?.secretAccessKey)) {
    hydrated.storage.secretAccessKey = await readSecret(paths, hydrated.storage.secretAccessKey.secretRef);
  }
  if (isSecretReference(hydrated.heartbeat?.secret)) {
    hydrated.heartbeat.secret = await readSecret(paths, hydrated.heartbeat.secret.secretRef);
  }
  return hydrated;
}

async function externalizeJobSecrets(job, paths) {
  if (!job || typeof job !== "object") {
    return job;
  }
  const stored = structuredClone(job);
  for (const field of ["secretAccessKey", "s3SecretAccessKey"]) {
    const secret = stored[field];
    if (typeof secret === "string" && secret) {
      const key = `job:${stored.id || "default"}:${field}:${randomUUID()}`;
      await writeSecret(paths, key, secret);
      stored[field] = { secretRef: key };
    }
  }
  return stored;
}

async function hydrateJobSecrets(job, paths) {
  if (!job || typeof job !== "object") {
    return job;
  }
  const hydrated = structuredClone(job);
  for (const field of ["secretAccessKey", "s3SecretAccessKey"]) {
    if (isSecretReference(hydrated[field])) {
      hydrated[field] = await readSecret(paths, hydrated[field].secretRef);
    }
  }
  return hydrated;
}

function isSecretReference(value) {
  return Boolean(value && typeof value === "object" && typeof value.secretRef === "string");
}

async function readSecrets(paths) {
  const secrets = await readJsonFile(secretStoreFile(paths), {});
  return secrets && typeof secrets === "object" && !Array.isArray(secrets) ? secrets : {};
}

async function writeSecret(paths, key, value) {
  const file = secretStoreFile(paths);
  return withFileWriteLock(file, async () => {
    const secrets = await readSecrets(paths);
    secrets[key] = String(value);
    await writeJsonFileUnlocked(file, secrets);
    await protectSecretVaultFile(file);
  });
}

async function readSecret(paths, key) {
  const secrets = await readSecrets(paths);
  if (typeof secrets[key] === "string" && secrets[key]) {
    return secrets[key];
  }
  throw createHttpError("secret_vault_missing", 409, `Missing local secret vault entry: ${key}`);
}

function secretStoreFile(paths) {
  return paths.secretsFile || join(dirname(paths.profileFile || paths.jobsFile || paths.syncHistoryFile), "secrets.json");
}

async function protectSecretVaultFile(file) {
  if (process.platform !== "win32") {
    return { protected: true, mode: "not_applicable" };
  }
  const account = currentWindowsAccount();
  if (!account) {
    return { protected: false, mode: "windows-acl", errorCode: "account_unknown" };
  }
  try {
    await execFileAsync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${account}:F`], {
      windowsHide: true,
      timeout: 5000
    });
    return { protected: true, mode: "windows-acl" };
  } catch (error) {
    return {
      protected: false,
      mode: "windows-acl",
      errorCode: error?.code || "acl_failed",
      message: String(error?.stderr || error?.message || "Failed to protect secret vault ACL").trim()
    };
  }
}

async function inspectSecretVaultProtection(file) {
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        protected: false,
        mode: process.platform === "win32" ? "windows-acl" : "not_applicable",
        exists: false
      };
    }
    throw error;
  }
  const result = await protectSecretVaultFile(file);
  return {
    ...result,
    exists: true
  };
}

function currentWindowsAccount() {
  const username = String(process.env.USERNAME || "").trim();
  const domain = String(process.env.USERDOMAIN || "").trim();
  if (!username) {
    return "";
  }
  return domain ? `${domain}\\${username}` : username;
}

function collectSecretRefs(value) {
  if (Array.isArray(value)) {
    return value.flatMap(collectSecretRefs);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (isSecretReference(value)) {
    return [value.secretRef];
  }
  return Object.values(value).flatMap(collectSecretRefs);
}

export async function readSyncHistory(paths = getClientPaths()) {
  const history = await readJsonFile(paths.syncHistoryFile, []).catch((error) => {
    if (error?.code === "local_state_corrupt") {
      return [];
    }
    throw error;
  });
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .map(normalizeStoredSyncRun)
    .filter(Boolean);
}

export async function inspectLocalState(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const files = await Promise.all([
      inspectJsonStateFile("profile", paths.profileFile),
      inspectJsonStateFile("jobs", paths.jobsFile),
      inspectJsonStateFile("secrets", paths.secretsFile || secretStoreFile(paths)),
      inspectJsonStateFile("syncHistory", paths.syncHistoryFile),
      inspectJsonStateFile("claimRecovery", claimRecoveryStoreFile(paths)),
      inspectJsonStateFile("lastSuccessfulHeartbeat", heartbeatSnapshotStoreFile(paths))
    ]);
    return {
      ok: files.every((file) => file.ok),
      files
    };
  });
}

export async function readLastSuccessfulHeartbeat(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const heartbeat = await readJsonFile(heartbeatSnapshotStoreFile(paths), null);
    return heartbeat && typeof heartbeat === "object" && !Array.isArray(heartbeat) && heartbeat.ok === true
      ? heartbeat
      : null;
  });
}

export async function saveLastSuccessfulHeartbeat(heartbeat, paths = getClientPaths()) {
  if (!heartbeat || typeof heartbeat !== "object" || heartbeat.ok !== true) {
    return null;
  }
  return withClientStateLock(paths, async () => {
    const snapshot = structuredClone(heartbeat);
    await writeJsonFile(heartbeatSnapshotStoreFile(paths), snapshot);
    return snapshot;
  });
}

export async function clearLastSuccessfulHeartbeat(paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    await rm(heartbeatSnapshotStoreFile(paths), { force: true });
  });
}

export async function prepareClaimRecovery(claim, paths = getClientPaths()) {
  return withClientStateLock(paths, async () => {
    const file = claimRecoveryStoreFile(paths);
    const existing = await readJsonFile(file, null);
    const server = String(claim?.server || "").trim();
    const code = String(claim?.code || "").trim();
    if (!server || !code) {
      return null;
    }
    const codeHash = hashClaimRecoveryCode(code);
    const reusable = existing
      && existing.type === "claim-import-recovery"
      && existing.claim?.server === server
      && claimRecoveryMatchesCode(existing.claim, code, codeHash)
      && typeof existing.clientRedeemId === "string"
      && existing.clientRedeemId
      && typeof existing.clientInstallId === "string"
      && existing.clientInstallId;
    const now = new Date().toISOString();
    const recovery = reusable
      ? {
          ...existing,
          updatedAt: now
        }
      : {
          schemaVersion: 1,
          type: "claim-import-recovery",
          claim: { server, codeHash },
          clientRedeemId: randomUUID(),
          clientInstallId: randomUUID(),
          createdAt: now,
          updatedAt: now
        };
    recovery.claim = { server, codeHash };
    await writeJsonFile(file, recovery);
    return recovery;
  });
}

export async function clearClaimRecovery(recovery, paths = getClientPaths()) {
  if (!recovery?.claim?.server || !recovery?.claim?.codeHash) {
    return;
  }
  return withClientStateLock(paths, async () => {
    const file = claimRecoveryStoreFile(paths);
    await withFileWriteLock(file, async () => {
      const current = await readJsonFile(file, null);
      if (
        current?.type === "claim-import-recovery"
        && current.claim?.server === recovery.claim.server
        && current.claim?.codeHash === recovery.claim.codeHash
        && current.clientRedeemId === recovery.clientRedeemId
        && current.clientInstallId === recovery.clientInstallId
      ) {
        await rm(file, { force: true });
      }
    });
  });
}

function claimRecoveryStoreFile(paths) {
  return paths.claimRecoveryFile || join(dirname(paths.profileFile || paths.jobsFile || paths.syncHistoryFile), "claim-recovery.json");
}

function heartbeatSnapshotStoreFile(paths) {
  return paths.heartbeatSnapshotFile || join(dirname(paths.profileFile || paths.jobsFile || paths.syncHistoryFile), "last-successful-heartbeat.json");
}

function claimRecoveryMatchesCode(claim, code, codeHash) {
  return claim?.codeHash === codeHash || claim?.code === code;
}

function hashClaimRecoveryCode(code) {
  return createHash("sha256").update(String(code || "")).digest("hex");
}

async function inspectJsonStateFile(name, file) {
  try {
    const raw = await readFile(file, "utf8");
    JSON.parse(raw.replace(/^\uFEFF/, ""));
    return { name, path: file, exists: true, ok: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { name, path: file, exists: false, ok: true };
    }
    if (error instanceof SyntaxError) {
      return {
        name,
        path: file,
        exists: true,
        ok: false,
        errorCode: "local_state_corrupt",
        message: `Local state file is not valid JSON: ${basename(file)}`
      };
    }
    throw error;
  }
}

function normalizeStoredSyncRun(run) {
  let normalized = null;
  try {
    normalized = normalizeSyncRun(run);
  } catch {
    try {
      normalized = normalizeSyncRun({
        ...run,
        job: run?.job && typeof run.job === "object"
          ? {
              ...run.job,
              remotePrefix: "",
              remoteFolder: ""
            }
          : run?.job
      });
    } catch {
      return null;
    }
  }
  if (!normalized) {
    return null;
  }
  return normalized;
}

async function readSyncHistoryForWrite(paths = getClientPaths()) {
  const history = await readJsonFile(paths.syncHistoryFile, []);
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .map(normalizeStoredSyncRun)
    .filter(Boolean);
}

export async function recordSyncRunStarted(run, paths = getClientPaths()) {
  const now = new Date().toISOString();
  const next = {
    id: run.id || `sync-${Date.now()}`,
    status: "running",
    startedAt: now,
    finishedAt: null,
    ...run,
    trigger: run.trigger === "scheduler" ? "scheduler" : "manual"
  };
  const history = await readSyncHistoryForWrite(paths);
  const updated = [
    next,
    ...history.filter((item) => item.id !== next.id)
  ].slice(0, 20);
  await writeJsonFile(paths.syncHistoryFile, updated);
  return next;
}

export async function recordSyncRunFinished(runId, patch, paths = getClientPaths()) {
  const history = await readSyncHistoryForWrite(paths);
  const index = history.findIndex((item) => item.id === runId);
  const existing = index >= 0 ? history[index] : { id: runId || `sync-${Date.now()}` };
  const next = {
    ...existing,
    ...patch,
    finishedAt: patch.finishedAt || new Date().toISOString()
  };
  const updated = index >= 0
    ? [next, ...history.slice(0, index), ...history.slice(index + 1)]
    : [next, ...history];
  await writeJsonFile(paths.syncHistoryFile, updated.slice(0, 20));
  return next;
}
