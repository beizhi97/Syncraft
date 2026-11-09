const SCHEMA_1_MANIFEST_KEYS = Object.freeze([
  "arch",
  "artifactFile",
  "artifactSha256",
  "artifactSizeBytes",
  "libc",
  "napiVersion",
  "nodeMajor",
  "platform",
  "schemaVersion"
]);
const SCHEMA_2_MANIFEST_KEYS = Object.freeze([
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
]);
const RUNTIME_KEYS = Object.freeze([
  "arch",
  "libc",
  "napiVersion",
  "platform"
]);
const DIGEST = /^[a-f0-9]{64}$/;
const LIBC_FAMILIES = new Set(["glibc", "musl"]);

function result(compatible, reason) {
  return Object.freeze({ compatible, reason });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isArtifactFile(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function hasValidManifestShape(manifest) {
  const schemaVersion = manifest.schemaVersion;
  const schemaMatches = schemaVersion === "1"
    || (schemaVersion === "2" && manifest.nativeApiRevision === "2");
  return schemaMatches
    && isArtifactFile(manifest.artifactFile)
    && DIGEST.test(manifest.artifactSha256)
    && Number.isSafeInteger(manifest.artifactSizeBytes)
    && manifest.artifactSizeBytes > 0
    && Number.isSafeInteger(manifest.nodeMajor)
    && manifest.nodeMajor > 0
    && typeof manifest.platform === "string"
    && manifest.platform.length > 0
    && typeof manifest.arch === "string"
    && manifest.arch.length > 0
    && LIBC_FAMILIES.has(manifest.libc);
}

export function evaluateOwnerLockCompatibility({ manifest, runtime } = {}) {
  const manifestKeys = manifest?.schemaVersion === "2"
    ? SCHEMA_2_MANIFEST_KEYS
    : SCHEMA_1_MANIFEST_KEYS;
  if (!hasExactKeys(manifest, manifestKeys)
    || !hasExactKeys(runtime, RUNTIME_KEYS)
    || !hasValidManifestShape(manifest)) {
    return result(false, "manifest_invalid");
  }

  if (manifest.platform !== runtime.platform) {
    return result(false, "platform_mismatch");
  }
  if (manifest.arch !== runtime.arch) {
    return result(false, "arch_mismatch");
  }

  if (!Number.isSafeInteger(manifest.napiVersion)
    || manifest.napiVersion < 8) {
    return result(false, "napi_too_low");
  }
  if (!Number.isSafeInteger(runtime.napiVersion)
    || runtime.napiVersion < 8) {
    return result(false, "napi_runtime_invalid");
  }
  if (manifest.napiVersion > runtime.napiVersion) {
    return result(false, "napi_runtime_insufficient");
  }

  if (!LIBC_FAMILIES.has(runtime.libc)
    || manifest.libc !== runtime.libc) {
    return result(false, "libc_mismatch");
  }

  return result(true, "compatible");
}
