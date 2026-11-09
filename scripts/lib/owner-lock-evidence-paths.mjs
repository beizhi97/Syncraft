import {
  lstat,
  mkdir,
  realpath
} from "node:fs/promises";
import path from "node:path";

const ERROR_CODE = "owner_lock_evidence_path_invalid";

function pathError(reason, message, details = {}) {
  const error = new Error(message);
  error.code = ERROR_CODE;
  error.reason = reason;
  Object.assign(error, details);
  return error;
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) {
    throw pathError("segments_invalid", "path segments must be an array");
  }
  return Object.freeze(segments.map(segment => {
    if (typeof segment !== "string"
      || segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || segment.includes("\0")) {
      throw pathError(
        "segments_invalid",
        "each path segment must be one safe directory name"
      );
    }
    return segment;
  }));
}

async function directoryMetadata(directoryPath, reason, missingReason) {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw pathError(
        missingReason,
        `required directory is missing: ${directoryPath}`,
        { path: directoryPath }
      );
    }
    throw pathError(
      reason,
      `directory cannot be inspected: ${directoryPath}`,
      { path: directoryPath, cause: error }
    );
  }
  if (metadata.isSymbolicLink()) {
    throw pathError(
      "directory_alias",
      `symbolic link or junction is not allowed: ${directoryPath}`,
      { path: directoryPath }
    );
  }
  if (!metadata.isDirectory()) {
    throw pathError(
      "directory_invalid",
      `path is not a real directory: ${directoryPath}`,
      { path: directoryPath }
    );
  }
  return metadata;
}

async function inspectChain(rootPath, segments, { create, mode }) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    throw pathError("root_invalid", "root path must be absolute");
  }
  const rootLexical = path.resolve(rootPath);
  await directoryMetadata(rootLexical, "root_invalid", "root_missing");
  const rootReal = await realpath(rootLexical);
  if (!samePath(rootLexical, rootReal)) {
    throw pathError(
      "root_alias",
      `root path must already be canonical: ${rootLexical}`,
      { path: rootLexical, canonicalPath: rootReal }
    );
  }

  const safeSegments = normalizeSegments(segments);
  const components = [];
  let currentLexical = rootLexical;
  let currentReal = rootReal;

  for (let index = 0; index < safeSegments.length; index += 1) {
    const segment = safeSegments[index];
    const nextLexical = path.join(currentLexical, segment);
    if (!isWithin(rootLexical, nextLexical)) {
      throw pathError(
        "path_outside_root",
        `path escapes the authorized root: ${nextLexical}`,
        { path: nextLexical }
      );
    }

    let exists = true;
    try {
      await directoryMetadata(nextLexical, "directory_invalid", "missing");
    } catch (error) {
      if (error?.reason !== "missing") {
        throw error;
      }
      exists = false;
    }

    if (!exists) {
      if (!create) {
        throw pathError(
          "directory_missing",
          `required directory is missing: ${nextLexical}`,
          { path: nextLexical }
        );
      }
      try {
        await mkdir(nextLexical, { mode });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw pathError(
            "directory_create_failed",
            `directory cannot be created: ${nextLexical}`,
            { path: nextLexical, cause: error }
          );
        }
      }
      await directoryMetadata(
        nextLexical,
        "directory_create_failed",
        "directory_create_failed"
      );
    }

    const nextReal = await realpath(nextLexical);
    const expectedReal = path.join(rootReal, ...safeSegments.slice(0, index + 1));
    if (!isWithin(rootReal, nextReal)) {
      throw pathError(
        "canonical_outside_root",
        `canonical path escapes the authorized root: ${nextReal}`,
        { path: nextLexical, canonicalPath: nextReal }
      );
    }
    if (!samePath(nextReal, expectedReal)) {
      throw pathError(
        "canonical_alias",
        `canonical path does not match its real directory chain: ${nextReal}`,
        { path: nextLexical, canonicalPath: nextReal }
      );
    }
    components.push(Object.freeze({
      name: segment,
      path: nextLexical,
      canonicalPath: nextReal
    }));
    currentLexical = nextLexical;
    currentReal = nextReal;
  }

  return Object.freeze({
    rootPath: rootLexical,
    canonicalRootPath: rootReal,
    segments: safeSegments,
    targetPath: currentLexical,
    canonicalTargetPath: currentReal,
    components: Object.freeze(components)
  });
}

export function assertSafeDirectory(rootPath, segments = []) {
  return inspectChain(rootPath, segments, { create: false, mode: 0o700 });
}

export function ensureSafeDirectory(
  rootPath,
  segments,
  { mode = 0o700 } = {}
) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw pathError("mode_invalid", "directory mode must be an integer from 0 to 0777");
  }
  return inspectChain(rootPath, segments, { create: true, mode });
}
