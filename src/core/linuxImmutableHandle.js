import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import {
  DIRECTORY_ROOT_MARKER_NAME,
  checkDirectoryRoot
} from "./directoryRootGuard.js";
import { canonicalJson } from "./enrollmentProtocol.js";

export const ROOT_GUARD_HELPER_PROTOCOL_VERSION = 1;
export const ROOT_GUARD_HELPER_VERSION = "1";
export const ROOT_GUARD_HELPER_DEFAULT_PATH = "/usr/local/lib/syncraft/sfsc-root-guard";

const HELPER_EXEC_PATH = "/proc/self/fd/4";
const HELPER_FD = 4;
const MARKER_FD = 3;
const MAX_MARKER_BYTES = 4096;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const IMMUTABLE_FLAG = 0x10n;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HELPER_ERROR_CODES = new Set([
  "request_invalid",
  "fd_invalid",
  "not_regular_file",
  "identity_mismatch",
  "content_mismatch",
  "flags_read_failed",
  "set_flags_failed",
  "flags_verify_failed",
  "capabilities_read_failed",
  "unsupported"
]);
const OPTION_KEYS = [
  "helperPath",
  "helperSha256",
  "requiredBytes",
  "reserveBytes",
  "signal",
  "testDependencies"
];
const TEST_DEPENDENCY_KEYS = [
  "checkDirectoryRoot",
  "fs",
  "platform",
  "runHelper",
  "spawn",
  "validateHelperMetadata"
];

export class LinuxImmutableHandleError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "LinuxImmutableHandleError";
    this.code = code;
    if (options.helperCode) {
      this.helperCode = options.helperCode;
    }
    if (options.reviewRequired !== undefined) {
      this.reviewRequired = options.reviewRequired;
    }
    if (options.settlement !== undefined) {
      this.settlement = options.settlement;
    }
    if (options.settlementCode !== undefined) {
      this.settlementCode = options.settlementCode;
    }
    if (options.closeErrors !== undefined) {
      this.closeErrors = options.closeErrors;
    }
  }
}

/**
 * Ensure the active directory-root marker is immutable through an inherited
 * Linux file descriptor. The function is Linux-only and fails closed.
 */
export async function ensureDirectoryRootProtection(record, options = {}) {
  const request = normalizeOptions(options);
  let dependencies;
  let markerHandle;
  let helperHandle;
  let receipt;
  let operationError;
  try {
    assertNotAborted(request.signal, "before platform validation");
    dependencies = runtimeDependencies(request.testDependencies);
    assertNotAborted(request.signal, "before platform validation");
    if (dependencies.platform !== "linux") {
      throw handleError(
        "root_protection_unsupported_platform",
        "Directory-root immutable protection is supported only on Linux"
      );
    }

    assertNotAborted(request.signal, "before root guard");
    const rootGuardBefore = await dependencies.checkDirectoryRoot(record, {
      operation: "write",
      requiredBytes: request.requiredBytes,
      reserveBytes: request.reserveBytes
    });
    assertNotAborted(request.signal, "after root guard");
    const canonicalRoot = rootGuardBefore.canonicalRoot;
    if (typeof canonicalRoot !== "string" || !isAbsolute(canonicalRoot)) {
      throw handleError(
        "root_protection_root_guard_invalid",
        "Directory-root guard did not return a canonical root"
      );
    }

    const stageName = record?.stage?.name;
    if (typeof stageName !== "string" || stageName.length === 0) {
      throw handleError(
        "root_protection_input_invalid",
        "Active directory-root record has no stage name"
      );
    }

    const markerPath = join(canonicalRoot, DIRECTORY_ROOT_MARKER_NAME);
    const stagePath = join(canonicalRoot, stageName);
    const markerBytes = markerBytesFor(record);
    assertNotAborted(request.signal, "before marker open");
    const markerBefore = await openVerifiedMarker(
      markerPath,
      markerBytes,
      record,
      dependencies,
      request.signal
    );
    markerHandle = markerBefore.handle;
    assertNotAborted(request.signal, "after marker open");
    const stageBefore = await inspectStage(
      stagePath,
      markerBefore.identity,
      dependencies,
      request.signal
    );
    assertNotAborted(request.signal, "after stage inspection");
    assertNotAborted(request.signal, "before helper open");
    const markerForHelper = markerHandle;
    markerHandle = null;
    const helper = await openVerifiedHelper(
      request,
      dependencies,
      request.signal,
      markerForHelper
    );
    markerHandle = markerForHelper;
    helperHandle = helper.handle;
    assertNotAborted(request.signal, "after helper open");

    const expected = Object.freeze({
      dev: markerBefore.identity.dev,
      ino: markerBefore.identity.ino,
      size: markerBefore.identity.size,
      sha256: record.marker.contentSha256
    });

    assertNotAborted(request.signal, "before initial helper inspect");
    let inspect = await invokeHelper(
      "inspect",
      expected,
      markerHandle,
      helperHandle,
      dependencies,
      request.signal
    );
    assertNotAborted(request.signal, "after initial helper inspect");
    let changed = false;
    if (inspect.flagsBefore.immutable !== inspect.flagsAfter.immutable) {
      throw handleError(
        "root_protection_helper_protocol_invalid",
        "inspect changed immutable flags"
      );
    }

    let finalInspect = inspect;
    if (!inspect.flagsBefore.immutable) {
      assertNotAborted(request.signal, "before set_immutable");
      const setResult = await invokeHelper(
        "set_immutable",
        expected,
        markerHandle,
        helperHandle,
        dependencies,
        request.signal
      );
      assertNotAborted(request.signal, "after set_immutable");
      changed = setResult.flagsBefore.immutable === false
        && setResult.flagsAfter.immutable === true;
      inspect = setResult;
      assertNotAborted(request.signal, "before post-set inspect");
      finalInspect = await invokeHelper(
        "inspect",
        expected,
        markerHandle,
        helperHandle,
        dependencies,
        request.signal
      );
      assertNotAborted(request.signal, "after post-set inspect");
    }

    if (!finalInspect.flagsAfter.immutable) {
      throw handleError(
        "root_protection_flags_verify_failed",
        "Marker immutable flag was not set and verified"
      );
    }

    assertNotAborted(request.signal, "before marker handle recheck");
    const markerAfter = await verifyMarkerHandle(
      markerHandle,
      markerBytes,
      markerBefore.identity,
      request.signal
    );
    assertNotAborted(request.signal, "after marker handle recheck");
    assertNotAborted(request.signal, "before marker path recheck");
    await verifyMarkerPath(
      markerPath,
      markerAfter.identity,
      dependencies,
      request.signal
    );
    assertNotAborted(request.signal, "after marker path recheck");
    assertNotAborted(request.signal, "before stage recheck");
    const stageAfter = await verifyStageAfter(
      stagePath,
      stageBefore,
      markerAfter.identity,
      dependencies,
      request.signal
    );
    assertNotAborted(request.signal, "after stage recheck");
    assertNotAborted(request.signal, "before helper handle recheck");
    await verifyHelperHandle(helperHandle, helper.identity, request.signal);
    assertNotAborted(request.signal, "after helper handle recheck");

    assertNotAborted(request.signal, "before final root guard");
    const rootGuardAfter = await dependencies.checkDirectoryRoot(record, {
      operation: "write",
      requiredBytes: request.requiredBytes,
      reserveBytes: request.reserveBytes
    });
    assertNotAborted(request.signal, "after final root guard");

    receipt = deepFreeze({
      ok: true,
      rootId: record.rootId,
      markerId: record.markerId,
      operationId: record.operationId,
      markerIdentity: markerAfter.identity,
      stageName,
      stageBefore: stageBefore.state,
      stageAfter: stageAfter.state,
      contentSha256: markerAfter.contentSha256,
      helper: {
        version: ROOT_GUARD_HELPER_VERSION,
        sha256: request.helperSha256
      },
      changed,
      flagsBefore: inspect.flagsBefore,
      flagsAfter: finalInspect.flagsAfter,
      capabilities: finalInspect.capabilities,
      rootGuardBefore,
      rootGuardAfter
    });
  } catch (error) {
    operationError = error;
  }

  const closeResult = await closeHandlesOnce(
    [helperHandle, markerHandle],
    request.signal
  );
  if (closeResult.errors.length > 0) {
    throw settlementUncertainError(
      operationError,
      closeResult.errors,
      "handle_close_failed"
    );
  }
  if (operationError?.settlement === "uncertain") {
    throw operationError;
  }
  if (request.signal?.aborted) {
    throw markConfirmedSettlement(
      abortError(request.signal, "after handle close"),
      "aborted_after_cleanup"
    );
  }
  if (operationError) {
    throw markConfirmedSettlement(operationError, "protection_failed_after_cleanup");
  }
  return receipt;
}

function normalizeOptions(options) {
  assertPlainObject(options, "options");
  assertAllowedKeys(options, OPTION_KEYS, "options");
  const helperPath = options.helperPath ?? ROOT_GUARD_HELPER_DEFAULT_PATH;
  if (typeof helperPath !== "string"
    || !isAbsolute(helperPath)
    || normalize(helperPath) !== helperPath) {
    throw handleError(
      "root_protection_input_invalid",
      "helperPath must be a normalized absolute path"
    );
  }
  if (typeof options.helperSha256 !== "string"
    || !SHA256_PATTERN.test(options.helperSha256.toLowerCase())) {
    throw handleError(
      "root_protection_input_invalid",
      "helperSha256 must be a SHA-256 hex digest"
    );
  }
  return {
    helperPath,
    helperSha256: options.helperSha256.toLowerCase(),
    requiredBytes: decimalOption(options.requiredBytes, "requiredBytes", "0"),
    reserveBytes: decimalOption(options.reserveBytes, "reserveBytes", "0"),
    signal: normalizeSignal(options.signal),
    testDependencies: options.testDependencies
  };
}

function runtimeDependencies(testDependencies) {
  if (testDependencies == null) {
    return {
      platform: process.platform,
      fs: { lstat, open, realpath },
      checkDirectoryRoot,
      runHelper: runNativeHelper,
      spawn,
      validateHelperMetadata: validateTrustedHelperMetadata
    };
  }
  assertPlainObject(testDependencies, "testDependencies");
  assertAllowedKeys(testDependencies, TEST_DEPENDENCY_KEYS, "testDependencies");
  return {
    platform: testDependencies.platform ?? process.platform,
    fs: testDependencies.fs ?? { lstat, open, realpath },
    checkDirectoryRoot: testDependencies.checkDirectoryRoot ?? checkDirectoryRoot,
    runHelper: testDependencies.runHelper ?? runNativeHelper,
    spawn: testDependencies.spawn ?? spawn,
    validateHelperMetadata:
      testDependencies.validateHelperMetadata ?? validateTrustedHelperMetadata
  };
}

async function openVerifiedMarker(
  markerPath,
  expectedBytes,
  record,
  dependencies,
  signal
) {
  assertNotAborted(signal, "before marker lstat");
  let before;
  try {
    before = await dependencies.fs.lstat(markerPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw handleError(
        "root_protection_marker_missing",
        "Directory-root marker disappeared before protection",
        { cause: error }
      );
    }
    throw ioError("Failed to inspect directory-root marker", error);
  }
  assertNotAborted(signal, "after marker lstat");
  assertRegularNotLink(before, "root_protection_marker_invalid");
  assertIdentity(before, record.markerIdentity, "root_protection_marker_changed");
  if (before.size !== BigInt(expectedBytes.length)) {
    throw handleError(
      "root_protection_marker_changed",
      "Directory-root marker length changed"
    );
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    assertNotAborted(signal, "before marker open");
    handle = await dependencies.fs.open(markerPath, fsConstants.O_RDONLY | noFollow);
    assertNotAborted(signal, "after marker open");
    const opened = await handle.stat({ bigint: true });
    assertNotAborted(signal, "after marker handle stat");
    assertRegularNotLink(opened, "root_protection_marker_invalid");
    assertStableFileEvidence(before, opened, "root_protection_marker_changed");
    assertIdentity(opened, record.markerIdentity, "root_protection_marker_changed");
    if (opened.size !== BigInt(expectedBytes.length)) {
      throw handleError(
        "root_protection_marker_changed",
        "Directory-root marker length changed"
      );
    }
    assertNotAborted(signal, "before marker handle read");
    const bytes = await readExactHandle(handle, expectedBytes.length, signal);
    assertNotAborted(signal, "after marker handle read");
    assertNotAborted(signal, "before marker final handle stat");
    const after = await handle.stat({ bigint: true });
    assertNotAborted(signal, "after marker final handle stat");
    assertStableFileEvidence(opened, after, "root_protection_marker_changed");
    if (!bytes.equals(expectedBytes)) {
      throw handleError(
        "root_protection_marker_changed",
        "Directory-root marker content changed"
      );
    }
    const contentSha256 = sha256(bytes);
    if (contentSha256 !== record.marker.contentSha256) {
      throw handleError(
        "root_protection_marker_changed",
        "Directory-root marker content digest changed"
      );
    }
    return {
      handle,
      identity: identityOf(opened),
      contentSha256
    };
  } catch (error) {
    const closeResult = await closeHandlesOnce([handle], signal);
    if (closeResult.errors.length > 0) {
      throw settlementUncertainError(error, closeResult.errors, "handle_close_failed");
    }
    if (error?.settlement === "uncertain") {
      throw error;
    }
    if (signal?.aborted) {
      throw markConfirmedSettlement(
        abortError(signal, "after marker handle close"),
        "marker_open_failed_after_cleanup"
      );
    }
    if (error instanceof LinuxImmutableHandleError) {
      throw markConfirmedSettlement(error, "marker_open_failed_after_cleanup");
    }
    if (error?.code === "ELOOP") {
      throw markConfirmedSettlement(handleError(
        "root_protection_link_denied",
        "Directory-root marker link traversal was refused",
        { cause: error }
      ), "marker_open_failed_after_cleanup");
    }
    throw markConfirmedSettlement(
      ioError("Failed to open directory-root marker", error),
      "marker_open_failed_after_cleanup"
    );
  }
}

async function verifyMarkerHandle(handle, expectedBytes, expectedIdentity, signal) {
  assertNotAborted(signal, "before marker recheck stat");
  const before = await handle.stat({ bigint: true });
  assertNotAborted(signal, "after marker recheck stat");
  assertRegularNotLink(before, "root_protection_marker_invalid");
  if (identityOf(before).dev !== expectedIdentity.dev
    || identityOf(before).ino !== expectedIdentity.ino
    || identityOf(before).size !== expectedIdentity.size) {
    throw handleError(
      "root_protection_marker_changed",
      "Directory-root marker identity changed during protection"
    );
  }
  assertNotAborted(signal, "before marker recheck read");
  const bytes = await readExactHandle(handle, expectedBytes.length, signal);
  assertNotAborted(signal, "after marker recheck read");
  assertNotAborted(signal, "before marker recheck final stat");
  const after = await handle.stat({ bigint: true });
  assertNotAborted(signal, "after marker recheck final stat");
  if (identityOf(before).dev !== identityOf(after).dev
    || identityOf(before).ino !== identityOf(after).ino
    || identityOf(before).size !== identityOf(after).size) {
    throw handleError(
      "root_protection_marker_changed",
      "Directory-root marker identity changed while being rechecked"
    );
  }
  if (!bytes.equals(expectedBytes)) {
    throw handleError(
      "root_protection_marker_changed",
      "Directory-root marker content changed during protection"
    );
  }
  return {
    identity: identityOf(after),
    contentSha256: sha256(bytes)
  };
}

async function verifyMarkerPath(markerPath, expectedIdentity, dependencies, signal) {
  assertNotAborted(signal, "before marker path recheck");
  let current;
  try {
    current = await dependencies.fs.lstat(markerPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw handleError(
        "root_protection_marker_changed",
        "Directory-root marker path disappeared during protection",
        { cause: error }
      );
    }
    throw ioError("Failed to recheck directory-root marker path", error);
  }
  assertNotAborted(signal, "after marker path recheck");
  assertRegularNotLink(current, "root_protection_marker_changed");
  assertIdentity(current, expectedIdentity, "root_protection_marker_changed");
}

async function inspectStage(stagePath, markerIdentity, dependencies, signal) {
  assertNotAborted(signal, "before stage inspection");
  let current;
  try {
    current = await dependencies.fs.lstat(stagePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ state: "missing" });
    }
    throw ioError("Failed to inspect directory-root stage", error);
  }
  assertNotAborted(signal, "after stage inspection");
  assertRegularNotLink(current, "root_protection_stage_changed");
  assertIdentity(current, markerIdentity, "root_protection_stage_changed");
  return Object.freeze({
    state: "same_inode",
    identity: identityOf(current)
  });
}

async function verifyStageAfter(stagePath, before, markerIdentity, dependencies, signal) {
  assertNotAborted(signal, "before stage recheck");
  let current;
  try {
    current = await dependencies.fs.lstat(stagePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && before.state === "missing") {
      return Object.freeze({ state: "missing" });
    }
    if (error?.code === "ENOENT") {
      throw handleError(
        "root_protection_stage_changed",
        "Directory-root stage disappeared during protection",
        { cause: error }
      );
    }
    throw ioError("Failed to recheck directory-root stage", error);
  }
  assertNotAborted(signal, "after stage recheck");
  if (before.state === "missing") {
    throw handleError(
      "root_protection_stage_changed",
      "Directory-root stage appeared during protection"
    );
  }
  assertRegularNotLink(current, "root_protection_stage_changed");
  assertIdentity(current, markerIdentity, "root_protection_stage_changed");
  assertIdentity(current, before.identity, "root_protection_stage_changed");
  return Object.freeze({
    state: "same_inode",
    identity: identityOf(current)
  });
}

async function openVerifiedHelper(request, dependencies, signal, markerHandle) {
  let handle;
  let parentStat;
  let fileBefore;
  try {
    const parentPath = dirname(request.helperPath);
    assertNotAborted(signal, "before helper parent realpath");
    let resolvedParent;
    try {
      resolvedParent = await dependencies.fs.realpath(parentPath);
    } catch (error) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Helper parent directory cannot be resolved",
        { cause: error }
      );
    }
    assertNotAborted(signal, "after helper parent realpath");
    if (resolvedParent !== parentPath) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Helper parent directory must not traverse links"
      );
    }

    assertNotAborted(signal, "before helper parent lstat");
    parentStat = await dependencies.fs.lstat(parentPath, { bigint: true });
    assertNotAborted(signal, "after helper parent lstat");
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Helper parent must be a real directory"
      );
    }
    assertNotAborted(signal, "before helper file lstat");
    fileBefore = await dependencies.fs.lstat(request.helperPath, { bigint: true });
    assertNotAborted(signal, "after helper file lstat");
    if (fileBefore.isSymbolicLink() || !fileBefore.isFile()) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Helper must be a regular non-link file"
      );
    }
    if (fileBefore.size <= 0n || fileBefore.size > BigInt(MAX_HELPER_BYTES)) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Helper file size is unsupported"
      );
    }

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    assertNotAborted(signal, "before helper open");
    handle = await dependencies.fs.open(
      request.helperPath,
      fsConstants.O_RDONLY | noFollow
    );
    assertNotAborted(signal, "after helper open");
    const opened = await handle.stat({ bigint: true });
    assertNotAborted(signal, "after helper handle stat");
    if (opened.isSymbolicLink() || !opened.isFile()) {
      throw handleError(
        "root_protection_helper_trust_invalid",
        "Opened helper is not a regular file"
      );
    }
    assertStableFileEvidence(fileBefore, opened, "root_protection_helper_trust_invalid");
    await dependencies.validateHelperMetadata({
      parentPath,
      parentStat,
      helperPath: request.helperPath,
      fileStat: opened
    });
    assertNotAborted(signal, "after helper metadata validation");

    assertNotAborted(signal, "before helper handle read");
    const bytes = await readExactHandle(handle, Number(opened.size), signal);
    assertNotAborted(signal, "after helper handle read");
    assertNotAborted(signal, "before helper final handle stat");
    const after = await handle.stat({ bigint: true });
    assertNotAborted(signal, "after helper final handle stat");
    assertStableFileEvidence(opened, after, "root_protection_helper_trust_invalid");
    const digest = sha256(bytes);
    if (digest !== request.helperSha256) {
      throw handleError(
        "root_protection_helper_digest_mismatch",
        "Helper digest does not match helperSha256"
      );
    }
    return {
      handle,
      identity: stableIdentity(opened),
      sha256: digest
    };
  } catch (error) {
    const closeResult = await closeHandlesOnce([handle, markerHandle], signal);
    if (closeResult.errors.length > 0) {
      throw settlementUncertainError(error, closeResult.errors, "handle_close_failed");
    }
    if (error?.settlement === "uncertain") {
      throw error;
    }
    if (signal?.aborted) {
      throw markConfirmedSettlement(
        abortError(signal, "after helper handle close"),
        "helper_open_failed_after_cleanup"
      );
    }
    if (error instanceof LinuxImmutableHandleError) {
      throw markConfirmedSettlement(error, "helper_open_failed_after_cleanup");
    }
    if (error?.code === "ELOOP") {
      throw markConfirmedSettlement(handleError(
        "root_protection_helper_trust_invalid",
        "Helper link traversal was refused",
        { cause: error }
      ), "helper_open_failed_after_cleanup");
    }
    throw markConfirmedSettlement(handleError(
      "root_protection_helper_trust_invalid",
      "Helper cannot be opened from the trusted path",
      { cause: error }
    ), "helper_open_failed_after_cleanup");
  }
}

async function verifyHelperHandle(handle, expectedIdentity, signal) {
  assertNotAborted(signal, "before helper handle recheck");
  const current = await handle.stat({ bigint: true });
  assertNotAborted(signal, "after helper handle recheck");
  if (!sameStableIdentity(current, expectedIdentity)) {
    throw handleError(
      "root_protection_helper_trust_invalid",
      "Helper identity changed while protection was running"
    );
  }
}

async function validateTrustedHelperMetadata({
  parentStat,
  fileStat
}) {
  if (parentStat.uid !== 0n || (parentStat.mode & 0o022n) !== 0n) {
    throw handleError(
      "root_protection_helper_trust_invalid",
      "Helper parent must be root-owned and not group/world writable"
    );
  }
  if (fileStat.uid !== 0n
    || (fileStat.mode & 0o022n) !== 0n
    || (fileStat.mode & 0o111n) === 0n) {
    throw handleError(
      "root_protection_helper_trust_invalid",
      "Helper must be root-owned, executable, and not group/world writable"
    );
  }
}

async function invokeHelper(
  operation,
  expected,
  markerHandle,
  helperHandle,
  dependencies,
  signal
) {
  assertNotAborted(signal, `before ${operation} helper`);
  const request = Object.freeze({
    version: ROOT_GUARD_HELPER_PROTOCOL_VERSION,
    operation,
    expected
  });
  let result;
  try {
    result = await dependencies.runHelper({
      helperExecPath: HELPER_EXEC_PATH,
      helperFd: HELPER_FD,
      markerFd: MARKER_FD,
      markerHandle,
      helperHandle,
      request,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
      spawn: dependencies.spawn
    });
    assertNotAborted(signal, `after ${operation} helper`);
  } catch (error) {
    if (error instanceof LinuxImmutableHandleError) {
      throw markConfirmedSettlement(error, "helper_failed_after_cleanup");
    }
    throw markConfirmedSettlement(handleError(
      "root_protection_helper_spawn_failed",
      "Root protection helper could not be started",
      { cause: error }
    ), "helper_failed_after_cleanup");
  }
  return parseHelperResult(result, operation, expected);
}

function parseHelperResult(result, expectedOperation, expected) {
  if (!result || result.timedOut === true) {
    throw handleError(
      "root_protection_helper_timeout",
      "Root protection helper timed out"
    );
  }
  if (result.overflow === true) {
    throw handleError(
      "root_protection_helper_protocol_invalid",
      "Root protection helper output exceeded the limit"
    );
  }
  if (result.signal != null) {
    throw handleError(
      "root_protection_helper_protocol_invalid",
      "Root protection helper ended by signal"
    );
  }
  if (!Number.isInteger(result.exitCode)) {
    throw handleError(
      "root_protection_helper_protocol_invalid",
      "Root protection helper exit code is missing"
    );
  }

  const value = parseSingleJson(result.stdout);
  if (result.exitCode === 0) {
    return parseHelperSuccess(value, expectedOperation, expected);
  }
  if (result.exitCode !== 2) {
    throw handleError(
      "root_protection_helper_protocol_invalid",
      "Root protection helper used an unexpected failure exit code"
    );
  }
  return parseHelperFailure(value, expectedOperation);
}

function parseHelperSuccess(value, expectedOperation, expected) {
  assertExactObject(value, [
    "capabilities",
    "contentSha256",
    "flagsAfter",
    "flagsBefore",
    "helperVersion",
    "identity",
    "ok",
    "operation",
    "version"
  ], "helper success");
  if (value.version !== ROOT_GUARD_HELPER_PROTOCOL_VERSION
    || value.helperVersion !== ROOT_GUARD_HELPER_VERSION
    || value.operation !== expectedOperation
    || value.ok !== true) {
    throw protocolError("Helper success header is invalid");
  }
  assertExactObject(value.identity, ["dev", "ino", "size"], "helper identity");
  assertDecimalString(value.identity.dev, "helper identity.dev");
  assertDecimalString(value.identity.ino, "helper identity.ino");
  assertDecimalString(value.identity.size, "helper identity.size");
  if (value.identity.dev !== expected.dev
    || value.identity.ino !== expected.ino
    || value.identity.size !== expected.size
    || value.contentSha256 !== expected.sha256) {
    throw protocolError("Helper success evidence does not match the request");
  }
  const flagsBefore = parseFlags(value.flagsBefore, "flagsBefore");
  const flagsAfter = parseFlags(value.flagsAfter, "flagsAfter");
  assertExactObject(value.capabilities, [
    "boundingHasLinuxImmutable",
    "effectiveHasLinuxImmutable",
    "noNewPrivs",
    "permittedHasLinuxImmutable"
  ], "helper capabilities");
  for (const [key, field] of Object.entries(value.capabilities)) {
    if (typeof field !== "boolean") {
      throw protocolError(`Helper capabilities.${key} is invalid`);
    }
  }

  if (expectedOperation === "inspect") {
    if (flagsBefore.raw !== flagsAfter.raw
      || flagsBefore.immutable !== flagsAfter.immutable) {
      throw protocolError("inspect changed file flags");
    }
  } else {
    if (!flagsAfter.immutable) {
      throw protocolError("set_immutable did not verify the immutable flag");
    }
    const beforeOther = BigInt(flagsBefore.raw) & ~IMMUTABLE_FLAG;
    const afterOther = BigInt(flagsAfter.raw) & ~IMMUTABLE_FLAG;
    if (beforeOther !== afterOther) {
      throw protocolError("set_immutable changed unrelated file flags");
    }
  }

  return Object.freeze({
    identity: Object.freeze({ ...value.identity }),
    contentSha256: value.contentSha256,
    flagsBefore,
    flagsAfter,
    capabilities: Object.freeze({ ...value.capabilities })
  });
}

function parseHelperFailure(value, expectedOperation) {
  assertExactObject(value, [
    "error",
    "helperVersion",
    "ok",
    "operation",
    "version"
  ], "helper failure");
  if (value.version !== ROOT_GUARD_HELPER_PROTOCOL_VERSION
    || value.helperVersion !== ROOT_GUARD_HELPER_VERSION
    || value.ok !== false
    || value.operation !== ""
      && value.operation !== expectedOperation) {
    throw protocolError("Helper failure header is invalid");
  }
  assertExactObject(value.error, ["code"], "helper error");
  if (typeof value.error.code !== "string"
    || !HELPER_ERROR_CODES.has(value.error.code)) {
    throw protocolError("Helper error code is invalid");
  }
  throw handleError(
    "root_protection_helper_failed",
    "Root protection helper rejected the operation",
    { helperCode: value.error.code }
  );
}

function parseFlags(value, label) {
  assertExactObject(value, ["immutable", "raw"], label);
  assertDecimalString(value.raw, `${label}.raw`);
  if (typeof value.immutable !== "boolean") {
    throw protocolError(`${label}.immutable is invalid`);
  }
  if (((BigInt(value.raw) & IMMUTABLE_FLAG) !== 0n) !== value.immutable) {
    throw protocolError(`${label}.immutable does not match raw flags`);
  }
  return Object.freeze({
    raw: value.raw,
    immutable: value.immutable
  });
}

function parseSingleJson(output) {
  const buffer = Buffer.isBuffer(output)
    ? output
    : typeof output === "string"
      ? Buffer.from(output, "utf8")
      : null;
  if (!buffer || buffer.length === 0 || buffer.length > MAX_HELPER_OUTPUT_BYTES) {
    throw protocolError("Helper stdout is missing or too large");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
  } catch {
    throw protocolError("Helper stdout is not valid UTF-8");
  }
  if (text.length === 0) {
    throw protocolError("Helper stdout is empty");
  }
  try {
    const parsed = JSON.parse(text);
    if (JSON.stringify(parsed) !== text) {
      throw new Error("non-canonical JSON");
    }
    return parsed;
  } catch {
    throw protocolError("Helper stdout is not one JSON value");
  }
}

function runNativeHelper({
  helperExecPath,
  markerHandle,
  helperHandle,
  request,
  timeoutMs,
  signal,
  spawn: spawnImpl = spawn
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal, "before helper spawn"));
      return;
    }
    if (!Number.isInteger(markerHandle?.fd) || markerHandle.fd < 0
      || !Number.isInteger(helperHandle?.fd) || helperHandle.fd < 0) {
      reject(handleError(
        "root_protection_fd_mapping_invalid",
        "Marker or helper file handle has no usable file descriptor"
      ));
      return;
    }

    let child;
    try {
      child = spawnImpl(helperExecPath, ["protect-fd"], {
        cwd: "/",
        env: { LANG: "C" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", markerHandle.fd, helperHandle.fd]
      });
    } catch (error) {
      reject(handleError(
        "root_protection_helper_spawn_failed",
        "Root protection helper could not be spawned",
        { cause: error }
      ));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let killAttempted = false;
    let childError;
    let timer;
    const onAbort = () => {
      childError ||= abortError(signal, "while helper was running");
      killChild();
    };
    const killChild = () => {
      if (killAttempted || !Number.isInteger(child.pid) || child.pid <= 0) {
        return;
      }
      killAttempted = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        childError ||= error;
      }
    };
    const finish = (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (childError && !timedOut) {
        reject(childError);
        return;
      }
      resolve({
        exitCode,
        signal: childSignal,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    };

    try {
      child.once("error", (error) => {
        childError ||= handleError(
          "root_protection_helper_spawn_failed",
          "Root protection helper failed to start",
          { cause: error }
        );
      });
      child.once("close", (code, childSignal) => finish(code, childSignal));
      child.stdin.once("error", () => {});
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
          overflow = true;
          killChild();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
          overflow = true;
          killChild();
          return;
        }
        stderr.push(chunk);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);
      timer.unref?.();
      child.stdin.end(`${JSON.stringify(request)}\n`);
    } catch (error) {
      childError ||= error;
      killChild();
    }
  });
}

function normalizeSignal(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function") {
    throw handleError(
      "root_protection_input_invalid",
      "signal must be an AbortSignal"
    );
  }
  return value;
}

function assertNotAborted(signal, phase) {
  if (signal?.aborted) {
    throw abortError(signal, phase);
  }
}

function abortError(signal, phase) {
  return handleError(
    "root_protection_aborted",
    `Directory-root protection was cancelled ${phase}`,
    { cause: signal?.reason }
  );
}

async function closeHandlesOnce(handles, signal) {
  const seen = new Set();
  const attempts = [];
  for (const handle of handles) {
    if (!handle || seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    attempts.push((async () => {
      if (typeof handle.close !== "function") {
        throw new TypeError("acquired handle has no close function");
      }
      await handle.close();
    })());
  }
  const results = await Promise.allSettled(attempts);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  return {
    errors,
    aborted: signal?.aborted === true
  };
}

function settlementUncertainError(originalError, closeErrors, settlementCode) {
  const priorCloseErrors = Array.isArray(originalError?.closeErrors)
    ? originalError.closeErrors
    : [];
  return handleError(
    "root_protection_settlement_uncertain",
    "Directory-root protection cleanup could not be confirmed",
    {
      cause: originalError,
      closeErrors: Object.freeze([...priorCloseErrors, ...closeErrors]),
      settlement: "uncertain",
      settlementCode
    }
  );
}

function markConfirmedSettlement(error, settlementCode) {
  if (error?.settlement === "uncertain") {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      if (error.settlement === undefined) {
        error.settlement = "confirmed";
      }
      if (error.settlementCode === undefined) {
        error.settlementCode = settlementCode;
      }
      return error;
    } catch {
      // Fall through to a typed wrapper when the original error is immutable.
    }
  }
  return handleError(
    "root_protection_failed",
    "Directory-root protection failed after confirmed cleanup",
    {
      cause: error,
      settlement: "confirmed",
      settlementCode
    }
  );
}

function markerBytesFor(record) {
  const bytes = Buffer.from(canonicalJson(record?.marker?.content), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_MARKER_BYTES) {
    throw handleError(
      "root_protection_input_invalid",
      "Marker content size is unsupported"
    );
  }
  if (String(bytes.length) !== record.marker.contentLength
    || sha256(bytes) !== record.marker.contentSha256) {
    throw handleError(
      "root_protection_input_invalid",
      "Marker content evidence does not match the active record"
    );
  }
  return bytes;
}

async function readExactHandle(handle, size, signal) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw handleError(
      "root_protection_io_failed",
      "File size cannot be represented safely"
    );
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    assertNotAborted(signal, "before file handle read");
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    assertNotAborted(signal, "after file handle read");
    if (!result || !Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
      throw handleError(
        "root_protection_io_failed",
        "File read made no progress"
      );
    }
    offset += result.bytesRead;
  }
  return bytes;
}

function assertRegularNotLink(stat, code) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw handleError(code, "Protected file is not a regular non-link file");
  }
}

function assertIdentity(stat, expected, code) {
  const identity = identityOf(stat);
  if (identity.dev !== expected.dev
    || identity.ino !== expected.ino
    || identity.size !== expected.size) {
    throw handleError(code, "Protected file identity changed");
  }
}

function assertStableFileEvidence(left, right, code) {
  if (left.dev !== right.dev
    || left.ino !== right.ino
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs) {
    throw handleError(code, "Protected file changed while being verified");
  }
}

function identityOf(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString()
  });
}

function stableIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  });
}

function sameStableIdentity(stat, expected) {
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeNs === expected.mtimeNs
    && stat.ctimeNs === expected.ctimeNs;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decimalOption(value, label, fallback) {
  const selected = value == null ? fallback : value;
  if (typeof selected !== "string" || !DECIMAL_PATTERN.test(selected)) {
    throw handleError(
      "root_protection_input_invalid",
      `${label} must be a canonical decimal string`
    );
  }
  return selected;
}

function assertDecimalString(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw protocolError(`${label} is not a canonical decimal string`);
  }
}

function assertPlainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw handleError(
      "root_protection_input_invalid",
      `${label} must be an object`
    );
  }
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw handleError(
        "root_protection_input_invalid",
        `${label} contains unsupported field ${key}`
      );
    }
  }
}

function assertExactObject(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${label} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw protocolError(`${label} fields are invalid`);
  }
}

function protocolError(message) {
  return handleError(
    "root_protection_helper_protocol_invalid",
    message
  );
}

function ioError(message, cause) {
  return handleError("root_protection_io_failed", message, { cause });
}

function handleError(code, message, options = {}) {
  return new LinuxImmutableHandleError(code, message, options);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
