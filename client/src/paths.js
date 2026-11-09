import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function getClientPaths() {
  const portableRoot = process.env.SFSC_PORTABLE_ROOT;
  const root = portableRoot ? resolve(portableRoot) : resolve(here, "..");
  const appRoot = process.env.SFSC_APP_ROOT
    ? resolve(process.env.SFSC_APP_ROOT)
    : portableRoot
      ? join(root, "app", "client")
      : root;
  const binRoot = join(root, "resources", "bin", "win32");
  const configuredDataRoot = process.env.SFSC_CLIENT_DATA_ROOT || process.env.SFSC_DATA_ROOT;
  const legacyDataRoot = join(root, "data");
  const dataRoot = configuredDataRoot
    ? resolve(configuredDataRoot)
    : process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS === "1"
      ? legacyDataRoot
      : resolve(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "Syncraft",
        "data"
      );
  const runtimeRoot = join(dataRoot, "runtime");
  const logRoot = join(dataRoot, "logs");

  return {
    root,
    appRoot,
    legacyDataRoot,
    usesDefaultDataRoot: !configuredDataRoot && process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS !== "1",
    publicDir: join(appRoot, "public"),
    binRoot,
    dataRoot,
    runtimeRoot,
    sftpRoot: join(runtimeRoot, "sftp"),
    logRoot,
    releaseManifestFile: join(root, "release-manifest.json"),
    profileFile: join(dataRoot, "profile.json"),
    jobsFile: join(dataRoot, "jobs.json"),
    secretsFile: join(dataRoot, "secrets.json"),
    claimRecoveryFile: join(dataRoot, "claim-recovery.json"),
    enrollmentFile: join(dataRoot, "enrollment-session.json"),
    heartbeatSnapshotFile: join(dataRoot, "last-successful-heartbeat.json"),
    syncHistoryFile: join(dataRoot, "sync-history.json"),
    bisyncStateFile: join(dataRoot, "bisync-state.json"),
    firstBisyncConflictFile: join(dataRoot, "first-bisync-conflicts.json"),
    firstBisyncConflictStagingRoot: join(dataRoot, "protected-staging", "first-bisync-conflicts"),
    syncRecoveryStateFile: join(dataRoot, "sync-recovery.json"),
    syncRecoveryRoot: join(dataRoot, "sync-recovery"),
    syncRecoveryStagingRoot: join(dataRoot, "protected-staging", "sync-recovery"),
    singboxConfigFile: join(runtimeRoot, "sing-box-client.json"),
    enrollmentSingboxConfigFile: join(runtimeRoot, "sing-box-enrollment.json"),
    dataSingboxConfigFile: join(runtimeRoot, "sing-box-data.json"),
    rcloneConfigFile: join(runtimeRoot, "rclone.conf"),
    singboxExe: join(binRoot, "sing-box.exe"),
    rcloneExe: join(binRoot, "rclone.exe"),
    electronLog: join(logRoot, "electron-main.log"),
    singboxLog: join(logRoot, "sing-box.log"),
    rcloneLog: join(logRoot, "rclone.log")
  };
}

export function getSyncRecoveryPathsForRelation(relation, paths = getClientPaths()) {
  const relationId = String(relation?.relationId || "");
  const baselineId = String(relation?.baselineId || "");
  const rootId = String(relation?.rootId || "");
  if (!relationId || !baselineId || !rootId) throw new TypeError("Recovery state requires stable relation, baseline, and root identifiers");
  const key = createHash("sha256").update(`${relationId}\0${baselineId}\0${rootId}`).digest("hex");
  const root = join(paths.dataRoot, "sync-recovery", key);
  return {
    stateFile: join(root, "manifest.json"),
    stagingRoot: join(paths.dataRoot, "protected-staging", "sync-recovery", key)
  };
}

export function getFirstBisyncConflictPathsForRelation(relation, paths = getClientPaths()) {
  const relationId = String(relation?.relationId || "");
  const baselineId = String(relation?.baselineId || "");
  const rootId = String(relation?.rootId || "");
  if (!relationId || !baselineId || !rootId) throw new TypeError("Conflict state requires stable relation, baseline, and root identifiers");
  const key = createHash("sha256").update(`${relationId}\0${baselineId}\0${rootId}`).digest("hex");
  const root = join(paths.dataRoot, "first-bisync-conflicts", key);
  return {
    stateFile: join(root, "manifest.json"),
    stagingRoot: join(paths.dataRoot, "protected-staging", "first-bisync-conflicts", key)
  };
}

export async function ensureClientDirs(paths = getClientPaths()) {
  try {
    await migrateLegacyDataRoot(paths);
    await ensureWritableDataRoot(paths);
  } catch (error) {
    if (process.env.SFSC_CLIENT_DATA_ROOT || process.env.SFSC_DATA_ROOT) {
      throw error;
    }
    const fallbackRoot = resolve(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Syncraft",
      "data"
    );
    const originalDataRoot = paths.dataRoot;
    applyDataRoot(paths, fallbackRoot);
    await ensureWritableDataRoot(paths);
    console.warn(`SFSC client data root is not writable, using fallback: ${paths.dataRoot} (original: ${originalDataRoot})`);
  }
}

async function ensureWritableDataRoot(paths) {
  await mkdir(paths.dataRoot, { recursive: true });
  await access(paths.dataRoot, constants.W_OK);
  const probeFile = join(paths.dataRoot, `.sfsc-write-probe-${process.pid}-${Date.now()}.tmp`);
  await writeFile(probeFile, "ok", "utf8");
  await rm(probeFile, { force: true });
  await mkdir(paths.runtimeRoot, { recursive: true });
  await mkdir(paths.logRoot, { recursive: true });
}

async function migrateLegacyDataRoot(paths) {
  if (!paths.usesDefaultDataRoot || paths.legacyDataRoot === paths.dataRoot) {
    return;
  }
  if (await directoryExists(paths.dataRoot) || !await directoryExists(paths.legacyDataRoot)) {
    return;
  }
  const legacyFiles = ["profile.json", "jobs.json", "secrets.json", "sync-history.json", "claim-recovery.json"];
  if (!await Promise.all(legacyFiles.map((file) => pathExists(join(paths.legacyDataRoot, file)))).then((items) => items.some(Boolean))) {
    return;
  }
  const temporaryRoot = `${paths.dataRoot}.migrating-${process.pid}-${Date.now()}`;
  try {
    await cp(paths.legacyDataRoot, temporaryRoot, { recursive: true, errorOnExist: true, force: false });
    await rename(temporaryRoot, paths.dataRoot);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function applyDataRoot(paths, dataRoot) {
  paths.dataRoot = dataRoot;
  paths.usesDefaultDataRoot = false;
  paths.runtimeRoot = join(dataRoot, "runtime");
  paths.logRoot = join(dataRoot, "logs");
  paths.profileFile = join(dataRoot, "profile.json");
  paths.jobsFile = join(dataRoot, "jobs.json");
  paths.secretsFile = join(dataRoot, "secrets.json");
  paths.claimRecoveryFile = join(dataRoot, "claim-recovery.json");
  paths.enrollmentFile = join(dataRoot, "enrollment-session.json");
  paths.heartbeatSnapshotFile = join(dataRoot, "last-successful-heartbeat.json");
  paths.syncHistoryFile = join(dataRoot, "sync-history.json");
  paths.bisyncStateFile = join(dataRoot, "bisync-state.json");
  paths.firstBisyncConflictFile = join(dataRoot, "first-bisync-conflicts.json");
  paths.firstBisyncConflictStagingRoot = join(dataRoot, "protected-staging", "first-bisync-conflicts");
  paths.syncRecoveryStateFile = join(dataRoot, "sync-recovery.json");
  paths.syncRecoveryRoot = join(dataRoot, "sync-recovery");
  paths.syncRecoveryStagingRoot = join(dataRoot, "protected-staging", "sync-recovery");
  paths.singboxConfigFile = join(paths.runtimeRoot, "sing-box-client.json");
  paths.enrollmentSingboxConfigFile = join(paths.runtimeRoot, "sing-box-enrollment.json");
  paths.dataSingboxConfigFile = join(paths.runtimeRoot, "sing-box-data.json");
  paths.sftpRoot = join(paths.runtimeRoot, "sftp");
  paths.rcloneConfigFile = join(paths.runtimeRoot, "rclone.conf");
  paths.electronLog = join(paths.logRoot, "electron-main.log");
  paths.singboxLog = join(paths.logRoot, "sing-box.log");
  paths.rcloneLog = join(paths.logRoot, "rclone.log");
}
