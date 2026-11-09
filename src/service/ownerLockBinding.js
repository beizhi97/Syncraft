import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { evaluateOwnerLockCompatibility } from "./ownerLockCompatibility.js";

const require = createRequire(import.meta.url);
const DIGEST = /^[a-f0-9]{64}$/;
const SCHEMA_1_MANIFEST_KEYS = [
  "arch",
  "artifactFile",
  "artifactSha256",
  "artifactSizeBytes",
  "libc",
  "napiVersion",
  "nodeMajor",
  "platform",
  "schemaVersion"
];
const SCHEMA_2_MANIFEST_KEYS = [
  "arch",
  "artifactFile",
  "artifactSha256",
  "artifactSizeBytes",
  "libc",
  "napiVersion",
  "nativeApiRevision",
  "nodeMajor",
  "platform",
  "schemaVersion"
];
const SCHEMA_1_EXPORT_KEYS = ["acquireOwnerLock", "verifyOwnerLock"];
const SCHEMA_2_EXPORT_KEYS = [
  "acquireOwnerLock",
  "readOwnerStateSnapshot",
  "verifyOwnerLock"
];

function bindingError(code, message, cause, reason) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  if (reason !== undefined) {
    error.reason = reason;
  }
  return error;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      `${label} must be a plain object`
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      `${label} must contain exactly ${wanted.join(", ")}`
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeLibcFamily() {
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return "glibc";
  }
  const sharedObjects = report?.sharedObjects ?? [];
  if (sharedObjects.some(file => file.includes("ld-musl"))) {
    return "musl";
  }
  return "unknown";
}

function loadBinding(request, {
  exportKeys,
  manifestKeys,
  nativeApiRevision,
  schemaVersion
}) {
  exactKeys(request, ["artifactPath", "manifestPath"], "loader request");
  const { artifactPath, manifestPath } = request;
  if (!path.isAbsolute(artifactPath)
    || !path.isAbsolute(manifestPath)
    || path.extname(artifactPath) !== ".node") {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "artifactPath and manifestPath must be absolute candidate paths",
      undefined,
      "request_invalid"
    );
  }

  let canonicalManifest;
  let canonicalArtifact;
  try {
    canonicalManifest = realpathSync(manifestPath);
    canonicalArtifact = realpathSync(artifactPath);
  } catch (error) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate manifest or artifact is missing",
      error,
      "candidate_paths_invalid"
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(canonicalManifest, "utf8"));
  } catch (error) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate manifest is not valid JSON",
      error,
      "manifest_invalid"
    );
  }
  exactKeys(manifest, manifestKeys, "candidate manifest");
  if (manifest.schemaVersion !== schemaVersion
    || (nativeApiRevision !== undefined
      && manifest.nativeApiRevision !== nativeApiRevision)
    || !DIGEST.test(manifest.artifactSha256)
    || !Number.isSafeInteger(manifest.artifactSizeBytes)
    || manifest.artifactSizeBytes < 1
    || !Number.isSafeInteger(manifest.nodeMajor)
    || !Number.isSafeInteger(manifest.napiVersion)
    || typeof manifest.platform !== "string"
    || typeof manifest.arch !== "string"
    || typeof manifest.libc !== "string"
    || typeof manifest.artifactFile !== "string"
    || path.basename(manifest.artifactFile) !== manifest.artifactFile
    || canonicalArtifact !== path.join(path.dirname(canonicalManifest), manifest.artifactFile)) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate manifest identity is invalid",
      undefined,
      "manifest_invalid"
    );
  }

  const runtime = Object.freeze({
    platform: process.platform,
    arch: process.arch,
    napiVersion: Number(process.versions.napi),
    libc: runtimeLibcFamily()
  });
  const compatibility = evaluateOwnerLockCompatibility({ manifest, runtime });
  if (!compatibility.compatible) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate artifact is incompatible with this runtime",
      undefined,
      compatibility.reason
    );
  }

  let artifactStat;
  let artifactBytes;
  try {
    artifactStat = statSync(canonicalArtifact);
    artifactBytes = readFileSync(canonicalArtifact);
  } catch (error) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate artifact cannot be read",
      error,
      "artifact_invalid"
    );
  }
  if (!artifactStat.isFile()
    || artifactStat.size !== manifest.artifactSizeBytes
    || sha256(artifactBytes) !== manifest.artifactSha256) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate artifact size or digest does not match its manifest",
      undefined,
      "artifact_invalid"
    );
  }

  let loaded;
  try {
    loaded = require(canonicalArtifact);
  } catch (error) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "candidate artifact cannot be loaded",
      error,
      "artifact_load_failed"
    );
  }
  exactKeys(loaded, exportKeys, "native binding exports");
  if (exportKeys.some(key => typeof loaded[key] !== "function")) {
    throw bindingError(
      "owner_lock_artifact_invalid",
      "native binding functions are invalid",
      undefined,
      "artifact_exports_invalid"
    );
  }
  return Object.freeze(Object.fromEntries(
    exportKeys.map(key => [key, loaded[key]])
  ));
}

export function loadOwnerLockBinding(request = {}) {
  return loadBinding(request, {
    exportKeys: SCHEMA_1_EXPORT_KEYS,
    manifestKeys: SCHEMA_1_MANIFEST_KEYS,
    schemaVersion: "1"
  });
}

export function loadOwnerStateSnapshotBinding(request = {}) {
  return loadBinding(request, {
    exportKeys: SCHEMA_2_EXPORT_KEYS,
    manifestKeys: SCHEMA_2_MANIFEST_KEYS,
    nativeApiRevision: "2",
    schemaVersion: "2"
  });
}
