import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  link,
  lstat,
  open,
  readFile,
  realpath,
  statfs
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  canonicalJson,
  createEnrollmentIdentityId
} from "./enrollmentProtocol.js";

export const DIRECTORY_ROOT_MARKER_NAME = ".syncraft-root.json";

const SCHEMA_VERSION = 1;
const RECORD_KIND = "syncraft-directory-root-record";
const MARKER_KIND = "syncraft-directory-root";
const MAX_MARKER_BYTES = 4096;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]{16,128}$/;
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{16,128}$/;
const ROOT_ID_PATTERN = /^root_[A-Za-z0-9_-]{16,128}$/;
const MARKER_ID_PATTERN = /^mkr_[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID_PATTERN = /^rootop_[A-Za-z0-9_-]{16,128}$/;
const OPERATIONS = new Set(["read", "write", "traverse"]);
const DIRECTORY_SYNC_STATES = new Set(["success", "unsupported"]);

const DEFAULT_FS = Object.freeze({
  access,
  link,
  lstat,
  open,
  realpath,
  statfs
});

const PENDING_KEYS = [
  "canonicalRoot",
  "createdAt",
  "kind",
  "marker",
  "markerId",
  "mountEvidence",
  "operationId",
  "rootId",
  "rootIdentity",
  "schemaVersion",
  "serverId",
  "shareId",
  "stage",
  "status"
];
const ACTIVE_KEYS = [
  ...PENDING_KEYS,
  "activatedAt",
  "markerIdentity",
  "markerSync"
];
const MARKER_CONTENT_KEYS = [
  "createdAt",
  "kind",
  "markerId",
  "operationId",
  "rootId",
  "schemaVersion",
  "serverId",
  "shareId"
];

export class DirectoryRootGuardError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DirectoryRootGuardError";
    this.code = code;
    this.reviewRequired = options.reviewRequired === true;
  }
}

/**
 * Read-only preparation. The caller must persist the returned pending record
 * under its own server lock before calling commitDirectoryRootRegistration().
 */
export async function prepareDirectoryRootRegistration(input = {}, options = {}) {
  assertExactKeys(
    input,
    ["rootPath", "serverId", "shareId"],
    "registration input",
    "directory_root_input_invalid"
  );
  assertAllowedKeys(
    options,
    ["nowMs", "testDependencies"],
    "prepare options",
    "directory_root_input_invalid"
  );
  const serverId = requirePattern(input.serverId, SERVER_ID_PATTERN, "serverId");
  const shareId = requirePattern(input.shareId, SHARE_ID_PATTERN, "shareId");
  const requestedRoot = requireAbsolutePath(input.rootPath, "rootPath");
  if (isFilesystemRoot(requestedRoot)) {
    throw guardError("directory_root_input_invalid", "Selected root cannot be a filesystem root");
  }

  const dependencies = runtimeDependencies(options);
  const requestedStat = await lstatPath(requestedRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  assertDirectoryNotLink(requestedStat, "selected root");
  if (!requestedStat.isDirectory()) {
    throw guardError("directory_root_input_invalid", "Selected root must be an existing directory");
  }

  const canonicalRoot = await realpathPath(requestedRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  if (isFilesystemRoot(canonicalRoot)) {
    throw guardError("directory_root_input_invalid", "Selected root cannot be a filesystem root");
  }
  const inspection = await inspectRoot(canonicalRoot, dependencies);
  await assertAccess(canonicalRoot, fsConstants.R_OK | fsConstants.W_OK, dependencies);
  await readAvailableBytes(canonicalRoot, dependencies);

  const markerPath = join(canonicalRoot, DIRECTORY_ROOT_MARKER_NAME);
  if (await pathExists(markerPath, dependencies)) {
    throw guardError(
      "directory_root_marker_collision",
      "The directory already contains a root marker and cannot be registered automatically"
    );
  }

  const createdAt = timestampFromNow(options.nowMs);
  const rootId = createEnrollmentIdentityId("rootId");
  const markerId = createRandomIdentity("mkr_");
  const operationId = createRandomIdentity("rootop_");
  const stageName = stageNameForOperation(operationId);
  if (await pathExists(join(canonicalRoot, stageName), dependencies)) {
    throw guardError(
      "directory_root_registration_review_required",
      "A derived registration stage already exists and requires review",
      { reviewRequired: true }
    );
  }

  const markerContent = {
    schemaVersion: SCHEMA_VERSION,
    kind: MARKER_KIND,
    serverId,
    shareId,
    rootId,
    markerId,
    operationId,
    createdAt
  };
  const markerBytes = markerBytesFor(markerContent);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: RECORD_KIND,
    status: "pending",
    operationId,
    serverId,
    shareId,
    rootId,
    markerId,
    canonicalRoot,
    createdAt,
    rootIdentity: inspection.rootIdentity,
    mountEvidence: inspection.mountEvidence,
    marker: {
      name: DIRECTORY_ROOT_MARKER_NAME,
      content: markerContent,
      contentLength: String(markerBytes.length),
      contentSha256: sha256(markerBytes)
    },
    stage: {
      name: stageName
    }
  };
}

/**
 * Idempotent commit for one persisted pending record. The marker is installed
 * only by hard-linking a fully synced, same-directory stage file. A missing or
 * unknown final marker is never replaced.
 */
export async function commitDirectoryRootRegistration(record, options = {}) {
  assertAllowedKeys(
    options,
    ["nowMs", "testDependencies"],
    "commit options",
    "directory_root_input_invalid"
  );
  const pending = assertPendingRecord(record);
  const dependencies = runtimeDependencies(options);
  const markerBytes = markerBytesFor(pending.marker.content);
  await assertPendingInspection(pending, dependencies);

  const markerPath = join(pending.canonicalRoot, DIRECTORY_ROOT_MARKER_NAME);
  const stagePath = join(pending.canonicalRoot, pending.stage.name);
  let markerExists = await pathExists(markerPath, dependencies);
  let stageExists = await pathExists(stagePath, dependencies);
  let stageVerification;

  if (stageExists) {
    stageVerification = await readVerifiedFile(
      stagePath,
      markerBytes,
      dependencies,
      {
        missingCode: "directory_root_registration_incomplete",
        mismatchCode: "directory_root_registration_incomplete",
        reviewRequired: true,
        syncFile: true,
        writable: true
      }
    );
  }

  if (!markerExists) {
    if (!stageExists) {
      await createAndSyncStage(stagePath, markerBytes, dependencies);
      stageExists = true;
      stageVerification = await readVerifiedFile(
        stagePath,
        markerBytes,
        dependencies,
        {
          missingCode: "directory_root_registration_incomplete",
          mismatchCode: "directory_root_registration_incomplete",
          reviewRequired: true,
          syncFile: true,
          writable: true
        }
      );
    }

    await assertPendingInspection(pending, dependencies);
    await assertPathIdentity(stagePath, stageVerification, dependencies);
    const installed = await installStageWithoutReplace(stagePath, markerPath, dependencies);
    if (!installed) {
      throw guardError(
        "directory_root_registration_review_required",
        "The filesystem cannot install the root marker with a safe no-replace operation",
        { reviewRequired: true }
      );
    }
    markerExists = true;
  }

  const markerResult = await readVerifiedFile(
    markerPath,
    markerBytes,
    dependencies,
    {
      expectedIdentity: stageExists ? stageVerification.identity : undefined,
      expectedMtimeNs: stageExists ? stageVerification.mtimeNs : undefined,
      missingCode: "directory_root_registration_incomplete",
      mismatchCode: "directory_root_marker_collision",
      reviewRequired: true,
      syncFile: !stageExists,
      writable: !stageExists
    }
  );
  await assertPendingInspection(pending, dependencies);

  const markerSync = await syncDirectory(pending.canonicalRoot, dependencies);
  await assertPendingInspection(pending, dependencies);

  const finalMarkerResult = await readVerifiedFile(
    markerPath,
    markerBytes,
    dependencies,
    {
      expectedIdentity: markerResult.identity,
      expectedMtimeNs: markerResult.mtimeNs,
      expectedCtimeNs: markerResult.ctimeNs,
      missingCode: "directory_root_registration_incomplete",
      mismatchCode: "directory_root_marker_collision",
      reviewRequired: true
    }
  );

  return {
    ...pending,
    status: "active",
    activatedAt: timestampFromNow(options.nowMs),
    stage: {
      name: pending.stage.name,
      state: "installed"
    },
    markerIdentity: {
      dev: finalMarkerResult.identity.dev,
      ino: finalMarkerResult.identity.ino,
      size: finalMarkerResult.identity.size
    },
    markerSync: {
      fileSynced: true,
      directorySync: markerSync
    }
  };
}
/**
 * Side-effect-free health check. It never creates or repairs the marker and
 * does not recurse through the directory.
 */
export async function checkDirectoryRoot(record, options = {}) {
  assertAllowedKeys(
    options,
    ["nowMs", "operation", "requiredBytes", "reserveBytes", "testDependencies"],
    "check options",
    "directory_root_input_invalid"
  );
  const active = assertActiveRecord(record);
  const operation = requirePattern(options.operation, /^(?:read|write|traverse)$/, "operation");
  if (!OPERATIONS.has(operation)) {
    throw guardError("directory_root_input_invalid", "Unsupported directory operation");
  }
  const requiredBytes = parseDecimalOption(options.requiredBytes, "requiredBytes", "0");
  const reserveBytes = parseDecimalOption(
    options.reserveBytes,
    "reserveBytes",
    operation === "write" ? undefined : "0"
  );
  if (operation === "write" && reserveBytes == null) {
    throw guardError(
      "directory_root_input_invalid",
      "Write checks require an explicit reserveBytes policy"
    );
  }

  const dependencies = runtimeDependencies(options);
  await assertActiveInspection(active, dependencies);
  const markerBytes = markerBytesFor(active.marker.content);
  const markerPath = join(active.canonicalRoot, DIRECTORY_ROOT_MARKER_NAME);
  const markerResult = await readVerifiedFile(
    markerPath,
    markerBytes,
    dependencies,
    {
      expectedIdentity: active.markerIdentity,
      missingCode: "directory_root_marker_missing",
      mismatchCode: "directory_root_marker_mismatch"
    }
  );
  await assertActiveInspection(active, dependencies);

  const permissionMode = operation === "write"
    ? fsConstants.R_OK | fsConstants.W_OK
    : operation === "traverse"
      ? fsConstants.R_OK | fsConstants.X_OK
      : fsConstants.R_OK;
  await assertAccess(active.canonicalRoot, permissionMode, dependencies);
  const freeBytes = await readAvailableBytes(active.canonicalRoot, dependencies);
  if (operation === "write") {
    const requiredFree = BigInt(requiredBytes) + BigInt(reserveBytes);
    if (freeBytes < requiredFree) {
      throw guardError(
        "directory_root_space_insufficient",
        "The directory does not have the required free space"
      );
    }
  }

  return {
    ok: true,
    rootId: active.rootId,
    checkedAt: timestampFromNow(options.nowMs),
    operation,
    canonicalRoot: active.canonicalRoot,
    rootIdentity: active.rootIdentity,
    markerIdentity: markerResult.identity,
    mountEvidence: active.mountEvidence,
    freeBytes: freeBytes.toString()
  };
}

function runtimeDependencies(options = {}) {
  const test = options.testDependencies == null ? {} : options.testDependencies;
  assertPlainObject(test, "testDependencies", "directory_root_input_invalid");
  assertAllowedKeys(
    test,
    ["fs", "platform", "readMountInfo"],
    "testDependencies",
    "directory_root_input_invalid"
  );
  const fsOverrides = test.fs == null ? {} : test.fs;
  assertPlainObject(fsOverrides, "testDependencies.fs", "directory_root_input_invalid");
  assertAllowedKeys(
    fsOverrides,
    Object.keys(DEFAULT_FS),
    "testDependencies.fs",
    "directory_root_input_invalid"
  );
  for (const [name, value] of Object.entries(fsOverrides)) {
    if (typeof value !== "function") {
      throw guardError(
        "directory_root_input_invalid",
        `testDependencies.fs.${name} must be a function`
      );
    }
  }
  if (test.readMountInfo != null && typeof test.readMountInfo !== "function") {
    throw guardError(
      "directory_root_input_invalid",
      "testDependencies.readMountInfo must be a function"
    );
  }
  const platform = test.platform == null ? process.platform : String(test.platform);
  if (!["linux", "win32"].includes(platform)) {
    throw guardError(
      "directory_root_mount_unavailable",
      "This platform has no supported directory-root identity policy"
    );
  }
  return {
    fs: {
      ...DEFAULT_FS,
      ...fsOverrides
    },
    platform,
    readMountInfo: test.readMountInfo || (() => readFile("/proc/self/mountinfo", "utf8"))
  };
}

async function inspectRoot(canonicalRoot, dependencies) {
  const first = await lstatPath(canonicalRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  assertDirectoryNotLink(first, "canonical root");
  if (!first.isDirectory()) {
    throw guardError("directory_root_replaced", "Canonical root is no longer a directory");
  }
  const currentCanonical = await realpathPath(canonicalRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  if (currentCanonical !== canonicalRoot) {
    throw guardError("directory_root_replaced", "Canonical root path changed");
  }
  const second = await lstatPath(canonicalRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  assertDirectoryNotLink(second, "canonical root");
  if (!second.isDirectory() || !sameFilesystemIdentity(first, second)) {
    throw guardError("directory_root_replaced", "Canonical root changed while being inspected");
  }
  const confirmedCanonical = await realpathPath(canonicalRoot, dependencies, {
    missingCode: "directory_root_missing"
  });
  if (confirmedCanonical !== canonicalRoot) {
    throw guardError("directory_root_replaced", "Canonical root path changed while being inspected");
  }
  return {
    canonicalRoot,
    rootIdentity: {
      dev: decimal(second.dev),
      ino: decimal(second.ino)
    },
    mountEvidence: await readMountEvidence(canonicalRoot, dependencies)
  };
}

async function assertPendingInspection(pending, dependencies) {
  const inspection = await inspectRoot(pending.canonicalRoot, dependencies);
  assertInspectionMatchesRecord(pending, inspection);
}

async function assertActiveInspection(active, dependencies) {
  const inspection = await inspectRoot(active.canonicalRoot, dependencies);
  assertInspectionMatchesRecord(active, inspection);
}

function assertInspectionMatchesRecord(record, inspection) {
  if (inspection.canonicalRoot !== record.canonicalRoot
    || inspection.rootIdentity.dev !== record.rootIdentity.dev
    || inspection.rootIdentity.ino !== record.rootIdentity.ino) {
    throw guardError("directory_root_replaced", "Canonical root filesystem identity changed");
  }
  if (canonicalJson(inspection.mountEvidence) !== canonicalJson(record.mountEvidence)) {
    throw guardError("directory_root_mount_changed", "The root is now served by different mount evidence");
  }
}

async function readMountEvidence(canonicalRoot, dependencies) {
  if (dependencies.platform === "win32") {
    return {
      platform: "win32",
      kind: "filesystem-identity-only-v1"
    };
  }
  let text;
  try {
    text = String(await dependencies.readMountInfo());
  } catch (error) {
    throw guardError(
      "directory_root_mount_unavailable",
      "Linux mount evidence is unavailable",
      { cause: error }
    );
  }
  const matches = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(" - ");
    if (separator <= 0) {
      continue;
    }
    const before = line.slice(0, separator).trim().split(/\s+/);
    const after = line.slice(separator + 3).trim().split(/\s+/);
    if (before.length < 6 || after.length < 2) {
      continue;
    }
    const mountPoint = unescapeMountInfo(before[4]);
    if (!isPathInsideOrEqual(mountPoint, canonicalRoot)) {
      continue;
    }
    matches.push({
      platform: "linux",
      mountId: before[0],
      parentId: before[1],
      majorMinor: before[2],
      mountRoot: unescapeMountInfo(before[3]),
      mountPoint,
      fsType: unescapeMountInfo(after[0]),
      source: unescapeMountInfo(after[1])
    });
  }
  matches.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  const selected = matches[0];
  if (!selected) {
    throw guardError(
      "directory_root_mount_unavailable",
      "No Linux mount entry contains the canonical root"
    );
  }
  return selected;
}

function unescapeMountInfo(value) {
  return String(value).replace(/\\([0-7]{3})/g, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function isPathInsideOrEqual(container, target) {
  const diff = relative(resolve(container), resolve(target));
  return diff === "" || (!diff.startsWith(`..${sep}`) && diff !== ".." && !isAbsolute(diff));
}

async function createAndSyncStage(stagePath, markerBytes, dependencies) {
  let handle;
  try {
    handle = await dependencies.fs.open(stagePath, "wx", 0o600);
    await writeAll(handle, markerBytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(markerBytes.length)) {
      throw guardError(
        "directory_root_registration_incomplete",
        "The staged marker is incomplete",
        { reviewRequired: true }
      );
    }
  } catch (error) {
    throw normalizeIoError(
      error,
      "directory_root_registration_incomplete",
      "The staged marker could not be completed",
      { reviewRequired: true }
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!result || !Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw guardError(
        "directory_root_registration_incomplete",
        "The staged marker write made no progress",
        { reviewRequired: true }
      );
    }
    offset += result.bytesWritten;
  }
}

async function installStageWithoutReplace(stagePath, markerPath, dependencies) {
  try {
    await dependencies.fs.link(stagePath, markerPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return true;
    }
    if (isUnsupportedLinkError(error)) {
      return false;
    }
    throw normalizeIoError(
      error,
      "directory_root_registration_review_required",
      "The staged marker could not be installed safely",
      { reviewRequired: true }
    );
  }
}

function isUnsupportedLinkError(error) {
  return [
    "EACCES",
    "EMLINK",
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
    "EXDEV"
  ].includes(error?.code);
}


async function readVerifiedFile(filePath, expectedBytes, dependencies, options) {
  if (!(expectedBytes instanceof Uint8Array)
    || expectedBytes.length === 0
    || expectedBytes.length > MAX_MARKER_BYTES) {
    throw guardError("directory_root_record_invalid", "Expected directory-root bytes are invalid");
  }

  let before;
  try {
    before = await dependencies.fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw guardError(options.missingCode, "Required directory-root file is missing", {
        cause: error,
        reviewRequired: options.reviewRequired
      });
    }
    throw normalizeIoError(error, "directory_root_io_failed", "Failed to inspect directory-root file");
  }
  if (before.isSymbolicLink()) {
    throw guardError("directory_root_link_denied", "Directory-root files cannot be links");
  }
  if (!before.isFile()) {
    throw guardError(options.mismatchCode, "Directory-root file is not a regular file", {
      reviewRequired: options.reviewRequired
    });
  }
  if (before.size !== BigInt(expectedBytes.length)) {
    throw guardError(options.mismatchCode, "Directory-root file has an unexpected length", {
      reviewRequired: options.reviewRequired
    });
  }

  const noFollow = dependencies.platform === "linux"
    ? (fsConstants.O_NOFOLLOW ?? 0)
    : 0;
  const openFlags = (options.writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY) | noFollow;
  let handle;
  let handleBefore;
  let bytes;
  try {
    handle = await dependencies.fs.open(filePath, openFlags);
    handleBefore = await handle.stat({ bigint: true });
    assertStableFileIdentity(before, handleBefore, options);
    if (!handleBefore.isFile()) {
      throw guardError(options.mismatchCode, "Directory-root file is not a regular file", {
        reviewRequired: options.reviewRequired
      });
    }
    if (handleBefore.size !== BigInt(expectedBytes.length)) {
      throw guardError(options.mismatchCode, "Directory-root file has an unexpected length", {
        reviewRequired: options.reviewRequired
      });
    }
    assertExpectedFileEvidence(handleBefore, options);
    bytes = Buffer.alloc(expectedBytes.length);
    await readAll(handle, bytes);
    if (options.syncFile) {
      await handle.sync();
    }
    const handleAfter = await handle.stat({ bigint: true });
    assertStableFileIdentity(handleBefore, handleAfter, options);
  } catch (error) {
    if (error instanceof DirectoryRootGuardError) {
      throw error;
    }
    if (error?.code === "ELOOP") {
      throw guardError("directory_root_link_denied", "Directory-root file link traversal was refused");
    }
    throw normalizeIoError(
      error,
      "directory_root_io_failed",
      "Failed to read directory-root file"
    );
  } finally {
    await handle?.close().catch(() => {});
  }

  let after;
  try {
    after = await dependencies.fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw guardError(options.missingCode, "Directory-root file disappeared during validation", {
        cause: error,
        reviewRequired: options.reviewRequired
      });
    }
    throw normalizeIoError(error, "directory_root_io_failed", "Failed to recheck directory-root file");
  }
  if (after.isSymbolicLink()) {
    throw guardError("directory_root_link_denied", "Directory-root files cannot be links");
  }
  assertStableFileIdentity(handleBefore, after, options);

  const identity = {
    dev: decimal(handleBefore.dev),
    ino: decimal(handleBefore.ino),
    size: decimal(handleBefore.size)
  };
  if (!bytes.equals(expectedBytes)) {
    throw guardError(options.mismatchCode, "Directory-root file content does not match", {
      reviewRequired: options.reviewRequired
    });
  }
  return {
    identity,
    mtimeNs: decimal(handleBefore.mtimeNs),
    ctimeNs: decimal(handleBefore.ctimeNs),
    contentSha256: sha256(bytes)
  };
}

function assertExpectedFileEvidence(stat, options) {
  const identity = {
    dev: decimal(stat.dev),
    ino: decimal(stat.ino),
    size: decimal(stat.size)
  };
  if (options.expectedIdentity
    && (identity.dev !== options.expectedIdentity.dev
      || identity.ino !== options.expectedIdentity.ino
      || identity.size !== options.expectedIdentity.size)) {
    throw guardError(options.mismatchCode, "Directory-root file identity changed", {
      reviewRequired: options.reviewRequired
    });
  }
  if (options.expectedMtimeNs != null
    && decimal(stat.mtimeNs) !== options.expectedMtimeNs) {
    throw guardError(options.mismatchCode, "Directory-root file modification time changed", {
      reviewRequired: options.reviewRequired
    });
  }
  if (options.expectedCtimeNs != null
    && decimal(stat.ctimeNs) !== options.expectedCtimeNs) {
    throw guardError(options.mismatchCode, "Directory-root file change time changed", {
      reviewRequired: options.reviewRequired
    });
  }
}

async function readAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!result || !Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
      throw guardError("directory_root_io_failed", "Directory-root file read made no progress");
    }
    offset += result.bytesRead;
  }
}

async function assertPathIdentity(filePath, expectedVerification, dependencies) {
  const expectedIdentity = expectedVerification?.identity;
  if (!expectedIdentity) {
    throw guardError(
      "directory_root_registration_incomplete",
      "The completed registration stage has no verified identity",
      { reviewRequired: true }
    );
  }
  let current;
  try {
    current = await dependencies.fs.lstat(filePath, { bigint: true });
  } catch (error) {
    throw normalizeIoError(
      error,
      "directory_root_registration_incomplete",
      "The completed registration stage disappeared before installation",
      { reviewRequired: true }
    );
  }
  if (!current.isFile()
    || decimal(current.dev) !== expectedIdentity.dev
    || decimal(current.ino) !== expectedIdentity.ino
    || decimal(current.size) !== expectedIdentity.size
    || decimal(current.mtimeNs) !== expectedVerification.mtimeNs
    || decimal(current.ctimeNs) !== expectedVerification.ctimeNs) {
    throw guardError(
      "directory_root_registration_incomplete",
      "The completed registration stage changed before installation",
      { reviewRequired: true }
    );
  }
}
function assertStableFileIdentity(before, after, options) {
  if (!after.isFile()
    || decimal(after.dev) !== decimal(before.dev)
    || decimal(after.ino) !== decimal(before.ino)
    || decimal(after.size) !== decimal(before.size)
    || decimal(after.mtimeNs) !== decimal(before.mtimeNs)
    || decimal(after.ctimeNs) !== decimal(before.ctimeNs)) {
    throw guardError(options.mismatchCode, "Directory-root file changed during validation", {
      reviewRequired: options.reviewRequired
    });
  }
}

async function syncDirectory(directory, dependencies) {
  let handle;
  try {
    handle = await dependencies.fs.open(directory, "r");
    await handle.sync();
    return "success";
  } catch (error) {
    if (["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(error?.code)) {
      return "unsupported";
    }
    throw normalizeIoError(
      error,
      "directory_root_registration_review_required",
      "The directory entry could not be durably synchronized",
      { reviewRequired: true }
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}


async function readAvailableBytes(canonicalRoot, dependencies) {
  let stats;
  try {
    stats = await dependencies.fs.statfs(canonicalRoot, { bigint: true });
  } catch (error) {
    throw guardError(
      "directory_root_space_unavailable",
      "Directory free-space evidence is unavailable",
      { cause: error }
    );
  }
  try {
    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    if (available < 0n) {
      throw new RangeError("negative available bytes");
    }
    return available;
  } catch (error) {
    throw guardError(
      "directory_root_space_unavailable",
      "Directory free-space evidence is invalid",
      { cause: error }
    );
  }
}

async function assertAccess(filePath, mode, dependencies) {
  try {
    await dependencies.fs.access(filePath, mode);
  } catch (error) {
    throw guardError(
      "directory_root_permission_denied",
      "The current process lacks the required directory permission",
      { cause: error }
    );
  }
}

async function lstatPath(filePath, dependencies, options) {
  try {
    return await dependencies.fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw guardError(options.missingCode, "Directory root does not exist", { cause: error });
    }
    throw normalizeIoError(error, "directory_root_io_failed", "Failed to inspect directory root");
  }
}

async function realpathPath(filePath, dependencies, options) {
  try {
    return await dependencies.fs.realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw guardError(options.missingCode, "Directory root does not exist", { cause: error });
    }
    throw normalizeIoError(error, "directory_root_io_failed", "Failed to resolve directory root");
  }
}

async function pathExists(filePath, dependencies) {
  try {
    await dependencies.fs.lstat(filePath, { bigint: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw normalizeIoError(error, "directory_root_io_failed", "Failed to inspect registration file");
  }
}

function assertDirectoryNotLink(stat, label) {
  if (stat.isSymbolicLink()) {
    throw guardError("directory_root_link_denied", `${label} cannot be a symlink or junction`);
  }
}

function assertPendingRecord(record) {
  assertExactKeys(record, PENDING_KEYS, "pending record");
  if (record.schemaVersion !== SCHEMA_VERSION || record.kind !== RECORD_KIND) {
    throw guardError("directory_root_record_invalid", "Registration record schema is unsupported");
  }
  if (record.status !== "pending") {
    throw guardError("directory_root_record_invalid", "Registration record is not pending");
  }
  assertRecordFields(record);
  assertExactKeys(record.stage, ["name"], "pending stage");
  if (record.stage.name !== stageNameForOperation(record.operationId)) {
    throw guardError(
      "directory_root_record_invalid",
      "Pending stage name is not derived from operationId"
    );
  }
  return structuredClone(record);
}

function assertActiveRecord(record) {
  assertPlainObject(record, "active record");
  if (record.status === "pending") {
    assertPendingRecord(record);
    throw guardError(
      "directory_root_not_ready",
      "Pending registration cannot authorize directory access"
    );
  }
  assertExactKeys(record, ACTIVE_KEYS, "active record");
  if (record.schemaVersion !== SCHEMA_VERSION || record.kind !== RECORD_KIND) {
    throw guardError("directory_root_record_invalid", "Registration record schema is unsupported");
  }
  if (record.status !== "active") {
    throw guardError("directory_root_record_invalid", "Registration record has an unsupported status");
  }
  assertRecordFields(record);
  assertExactKeys(record.stage, ["name", "state"], "active stage");
  if (record.stage.name !== stageNameForOperation(record.operationId)
    || record.stage.state !== "installed") {
    throw guardError("directory_root_record_invalid", "Active stage metadata is invalid");
  }
  assertTimestamp(record.activatedAt, "activatedAt");
  assertExactKeys(record.markerIdentity, ["dev", "ino", "size"], "markerIdentity");
  for (const key of ["dev", "ino", "size"]) {
    assertDecimal(record.markerIdentity[key], `markerIdentity.${key}`);
  }
  assertExactKeys(record.markerSync, ["directorySync", "fileSynced"], "markerSync");
  if (record.markerSync.fileSynced !== true
    || !DIRECTORY_SYNC_STATES.has(record.markerSync.directorySync)) {
    throw guardError("directory_root_record_invalid", "Active marker sync evidence is invalid");
  }
  return structuredClone(record);
}

function assertRecordFields(record) {
  requirePattern(
    record.serverId,
    SERVER_ID_PATTERN,
    "serverId",
    "directory_root_record_invalid"
  );
  requirePattern(
    record.shareId,
    SHARE_ID_PATTERN,
    "shareId",
    "directory_root_record_invalid"
  );
  requirePattern(record.rootId, ROOT_ID_PATTERN, "rootId", "directory_root_record_invalid");
  requirePattern(record.markerId, MARKER_ID_PATTERN, "markerId", "directory_root_record_invalid");
  requirePattern(
    record.operationId,
    OPERATION_ID_PATTERN,
    "operationId",
    "directory_root_record_invalid"
  );
  assertTimestamp(record.createdAt, "createdAt");
  const canonicalRoot = requireAbsolutePath(
    record.canonicalRoot,
    "canonicalRoot",
    "directory_root_record_invalid"
  );
  if (canonicalRoot !== record.canonicalRoot || isFilesystemRoot(canonicalRoot)) {
    throw guardError(
      "directory_root_record_invalid",
      "canonicalRoot is not a canonical non-root path"
    );
  }
  assertExactKeys(record.rootIdentity, ["dev", "ino"], "rootIdentity");
  assertDecimal(record.rootIdentity.dev, "rootIdentity.dev");
  assertDecimal(record.rootIdentity.ino, "rootIdentity.ino");
  assertMountEvidence(record.mountEvidence);
  assertExactKeys(
    record.marker,
    ["content", "contentLength", "contentSha256", "name"],
    "marker record"
  );
  if (record.marker.name !== DIRECTORY_ROOT_MARKER_NAME) {
    throw guardError("directory_root_record_invalid", "Marker filename is unsupported");
  }
  assertMarkerContent(record.marker.content, record);
  assertDecimal(record.marker.contentLength, "marker.contentLength");
  if (!SHA256_PATTERN.test(record.marker.contentSha256)) {
    throw guardError("directory_root_record_invalid", "Marker content hash is invalid");
  }
  const markerBytes = markerBytesFor(record.marker.content);
  if (BigInt(record.marker.contentLength) !== BigInt(markerBytes.length)
    || record.marker.contentSha256 !== sha256(markerBytes)) {
    throw guardError(
      "directory_root_record_invalid",
      "Marker record content evidence does not match"
    );
  }
}

function assertMarkerContent(content, record) {
  assertExactKeys(content, MARKER_CONTENT_KEYS, "marker content");
  if (content.schemaVersion !== SCHEMA_VERSION || content.kind !== MARKER_KIND) {
    throw guardError("directory_root_record_invalid", "Marker content schema is unsupported");
  }
  for (const field of ["serverId", "shareId", "rootId", "markerId", "operationId", "createdAt"]) {
    if (content[field] !== record[field]) {
      throw guardError(
        "directory_root_record_invalid",
        `Marker content ${field} does not match record`
      );
    }
  }
}

function assertMountEvidence(evidence) {
  assertPlainObject(evidence, "mountEvidence");
  if (evidence.platform === "win32") {
    assertExactKeys(evidence, ["kind", "platform"], "Windows mountEvidence");
    if (evidence.kind !== "filesystem-identity-only-v1") {
      throw guardError(
        "directory_root_record_invalid",
        "Windows mount evidence kind is unsupported"
      );
    }
    return;
  }
  if (evidence.platform !== "linux") {
    throw guardError("directory_root_record_invalid", "Mount evidence platform is unsupported");
  }
  assertExactKeys(
    evidence,
    [
      "fsType",
      "majorMinor",
      "mountId",
      "mountPoint",
      "mountRoot",
      "parentId",
      "platform",
      "source"
    ],
    "Linux mountEvidence"
  );
  for (const field of [
    "fsType",
    "majorMinor",
    "mountId",
    "mountPoint",
    "mountRoot",
    "parentId",
    "source"
  ]) {
    if (typeof evidence[field] !== "string" || !evidence[field]) {
      throw guardError(
        "directory_root_record_invalid",
        `Mount evidence ${field} is invalid`
      );
    }
  }
  if (!isAbsolute(evidence.mountPoint)) {
    throw guardError(
      "directory_root_record_invalid",
      "Mount evidence mountPoint must be absolute"
    );
  }
}

function markerBytesFor(content) {
  const bytes = Buffer.from(canonicalJson(content), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_MARKER_BYTES) {
    throw guardError("directory_root_input_invalid", "Marker content size is unsupported");
  }
  return bytes;
}

function stageNameForOperation(operationId) {
  return `.syncraft-root.stage-${operationId}`;
}

function createRandomIdentity(prefix) {
  return `${prefix}${randomBytes(18).toString("base64url")}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decimal(value) {
  try {
    return BigInt(value).toString(10);
  } catch {
    throw guardError(
      "directory_root_record_invalid",
      "Filesystem identity cannot be represented exactly"
    );
  }
}

function sameFilesystemIdentity(left, right) {
  return decimal(left.dev) === decimal(right.dev)
    && decimal(left.ino) === decimal(right.ino)
    && decimal(left.size) === decimal(right.size)
    && decimal(left.mtimeNs) === decimal(right.mtimeNs)
    && decimal(left.ctimeNs) === decimal(right.ctimeNs);
}

function timestampFromNow(nowMs) {
  const value = nowMs == null ? Date.now() : nowMs;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw guardError("directory_root_input_invalid", "nowMs must be finite epoch milliseconds");
  }
  try {
    return new Date(value).toISOString();
  } catch (error) {
    throw guardError(
      "directory_root_input_invalid",
      "nowMs is outside the supported timestamp range",
      { cause: error }
    );
  }
}

function parseDecimalOption(input, label, fallback) {
  const value = input == null ? fallback : input;
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw guardError(
      "directory_root_input_invalid",
      `${label} must be a non-negative decimal string`
    );
  }
  return value;
}

function assertDecimal(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw guardError(
      "directory_root_record_invalid",
      `${label} must be an exact decimal string`
    );
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== "string") {
    throw guardError("directory_root_record_invalid", `${label} must be a canonical timestamp`);
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    canonical = "";
  }
  if (canonical !== value) {
    throw guardError("directory_root_record_invalid", `${label} must be a canonical timestamp`);
  }
}

function requireAbsolutePath(input, label, code = "directory_root_input_invalid") {
  if (typeof input !== "string" || !input || input !== input.trim() || !isAbsolute(input)) {
    throw guardError(code, `${label} must be an absolute path`);
  }
  return resolve(input);
}

function requirePattern(input, pattern, label, code = "directory_root_input_invalid") {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw guardError(code, `${label} has an invalid format`);
  }
  return input;
}

function isFilesystemRoot(filePath) {
  const resolved = resolve(filePath);
  const root = parse(resolved).root;
  return process.platform === "win32"
    ? root.toLowerCase() === resolved.toLowerCase()
    : root === resolved;
}

function assertPlainObject(value, label, code = "directory_root_record_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw guardError(code, `${label} must be a plain object`);
  }
}

function assertAllowedKeys(value, allowed, label, code = "directory_root_record_invalid") {
  assertPlainObject(value, label, code);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw guardError(code, `${label} contains unsupported field: ${key}`);
    }
  }
}

function assertExactKeys(value, required, label, code = "directory_root_record_invalid") {
  assertAllowedKeys(value, required, label, code);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw guardError(code, `${label} is missing field: ${key}`);
    }
  }
}

function normalizeIoError(error, code, message, options = {}) {
  if (error instanceof DirectoryRootGuardError) {
    return error;
  }
  return guardError(code, message, { cause: error, ...options });
}

function guardError(code, message, options = {}) {
  return new DirectoryRootGuardError(code, message, options);
}
