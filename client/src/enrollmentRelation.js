import {
  ENROLLMENT_PROTOCOL_NAME,
  ENROLLMENT_PROTOCOL_VERSION,
  EnrollmentProtocolError,
  canonicalJson,
  normalizeDeviceIdentity,
  normalizeEnrollmentBinding,
  normalizeEnrollmentBindings,
  normalizeTimestamp
} from "../../src/core/enrollmentProtocol.js";

export const ENROLLMENT_DIRECTORY_GRANT_KIND = "enrollment-directory-grant";
export const ENROLLMENT_VERIFICATION_CONTEXT_KIND = "enrollment-verification-context";

const DIRECTORY_BACKENDS = new Set(["s3", "webdav"]);
const DIRECTIONS = new Set(["upload", "download", "bidirectional"]);
const ENROLLMENT_GRANT_KEYS = [
  "bindings",
  "deviceId",
  "enrolledAt",
  "kind",
  "protocol",
  "publicKeyFingerprint",
  "requestId",
  "serverId",
  "version"
];
const DIRECTORY_GRANT_KEYS = [
  "authorization",
  "binding",
  "kind",
  "protocol",
  "revision",
  "root",
  "scope",
  "version"
];
const VERIFICATION_CONTEXT_KEYS = [
  "directoryGrantRevision",
  "expectedChannelRevision",
  "expectedDeviceId",
  "expectedPublicKeyFingerprint",
  "expectedRequestId",
  "expectedServerId",
  "kind",
  "protocol",
  "verifiedAt",
  "verifier",
  "version"
];

/**
 * Projects already-verified enrollment inputs into the client's trusted-binding
 * shape. This function validates shape and association only. The supplied
 * verification context is caller evidence, not cryptographic proof.
 */
export function projectVerifiedEnrollmentRelation(input = {}) {
  assertPlainObject(input, "enrollment relation projection input");
  assertExactKeys(
    input,
    ["binding", "directoryGrant", "grant", "verifiedContext"],
    "enrollment relation projection input"
  );

  const grant = normalizeEnrollmentGrant(input.grant);
  const selectedBinding = normalizeEnrollmentBinding(input.binding);
  if (!grant.bindings.some((item) => canonicalJson(item) === canonicalJson(selectedBinding))) {
    fail("enrollment_binding_mismatch", "Selected binding is not present in the consumed enrollment grant");
  }
  if (
    grant.serverId !== selectedBinding.identity.serverId
    || grant.deviceId !== selectedBinding.identity.deviceId
  ) {
    fail("enrollment_binding_mismatch", "Enrollment grant and selected binding identify different devices");
  }

  const directoryGrant = normalizeDirectoryGrant(input.directoryGrant);
  if (canonicalJson(directoryGrant.binding) !== canonicalJson(selectedBinding)) {
    fail("enrollment_binding_mismatch", "Directory grant is bound to a different enrollment binding");
  }

  const verificationContext = normalizeVerificationContext(input.verifiedContext);
  if (
    verificationContext.expectedServerId !== grant.serverId
    || verificationContext.expectedDeviceId !== grant.deviceId
    || verificationContext.expectedRequestId !== grant.requestId
    || verificationContext.expectedPublicKeyFingerprint !== grant.publicKeyFingerprint
    || verificationContext.expectedChannelRevision !== selectedBinding.channelRevision
  ) {
    fail(
      "enrollment_relation_conflict",
      "Verification context does not match the normalized enrollment grant and binding"
    );
  }
  if (verificationContext.directoryGrantRevision !== directoryGrant.revision) {
    fail("enrollment_relation_conflict", "Verification context belongs to a different directory grant revision");
  }

  const trustedBinding = {
    serverId: selectedBinding.identity.serverId,
    deviceId: selectedBinding.identity.deviceId,
    shareId: selectedBinding.identity.shareId,
    rootId: selectedBinding.identity.rootId,
    relationId: selectedBinding.identity.relationId,
    baselineEpoch: selectedBinding.baselineEpoch,
    channelRevision: selectedBinding.channelRevision,
    credentialRevision: selectedBinding.credentialRevision,
    rootAttestation: canonicalJson(selectedBinding.rootAttestation),
    scope: directoryGrant.scope,
    authorization: {
      directions: [...directoryGrant.authorization.directions],
      allowDelete: directoryGrant.authorization.allowDelete
    },
    root: {
      backend: directoryGrant.root.backend,
      bucketName: directoryGrant.root.bucketName,
      path: directoryGrant.root.path
    }
  };

  return {
    trustedBinding,
    provenance: {
      source: "caller-supplied-verification-context",
      cryptographicProof: false,
      verifier: verificationContext.verifier,
      reportedVerifiedAt: verificationContext.verifiedAt,
      directoryGrantRevision: directoryGrant.revision,
      enrollmentRequestId: grant.requestId,
      publicKeyFingerprint: grant.publicKeyFingerprint
    }
  };
}

function normalizeEnrollmentGrant(input) {
  assertPlainObject(input, "enrollment grant");
  assertExactKeys(input, ENROLLMENT_GRANT_KEYS, "enrollment grant");
  assertProtocolHeader(input, "enrollment-grant");
  const device = normalizeDeviceIdentity({
    serverId: input.serverId,
    deviceId: input.deviceId
  });
  const requestId = requireText(input.requestId, "grant.requestId");
  if (!/^req_[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
    fail("enrollment_request_invalid", "Enrollment grant requestId has an invalid format");
  }
  const publicKeyFingerprint = requireText(
    input.publicKeyFingerprint,
    "grant.publicKeyFingerprint"
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKeyFingerprint)) {
    fail("enrollment_request_invalid", "Enrollment grant public key fingerprint is invalid");
  }
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    fail("enrollment_request_invalid", "Enrollment grant bindings must be a non-empty array");
  }
  const bindings = normalizeEnrollmentBindings(input.bindings, {
    serverId: device.serverId,
    deviceId: device.deviceId
  });
  if (new Set(bindings.map((binding) => binding.channelRevision)).size !== 1) {
    fail("enrollment_binding_mismatch", "Enrollment grant bindings contain mixed channel revisions");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "enrollment-grant",
    requestId,
    serverId: device.serverId,
    deviceId: device.deviceId,
    publicKeyFingerprint,
    bindings,
    enrolledAt: normalizeTimestamp(input.enrolledAt)
  };
}

function normalizeDirectoryGrant(input) {
  assertPlainObject(input, "enrollment directory grant");
  assertExactKeys(input, DIRECTORY_GRANT_KEYS, "enrollment directory grant");
  assertProtocolHeader(input, ENROLLMENT_DIRECTORY_GRANT_KIND);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    fail("enrollment_request_invalid", "Directory grant revision must be a positive safe integer");
  }
  const scope = requireText(input.scope, "directoryGrant.scope");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) {
    fail("enrollment_request_invalid", "Directory grant scope is invalid");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: ENROLLMENT_DIRECTORY_GRANT_KIND,
    revision: input.revision,
    binding: normalizeEnrollmentBinding(input.binding),
    root: normalizeDirectoryRoot(input.root),
    scope,
    authorization: normalizeDirectoryAuthorization(input.authorization)
  };
}

function normalizeDirectoryRoot(input) {
  assertPlainObject(input, "directory grant root");
  assertExactKeys(input, ["backend", "bucketName", "path"], "directory grant root");
  const backend = requireText(input.backend, "directoryGrant.root.backend").toLowerCase();
  if (!DIRECTORY_BACKENDS.has(backend)) {
    fail("enrollment_request_invalid", "Directory grant backend is unsupported");
  }
  const bucketName = requireString(input.bucketName, "directoryGrant.root.bucketName");
  if (bucketName !== bucketName.trim()) {
    fail("enrollment_request_invalid", "Directory grant bucket name cannot contain surrounding whitespace");
  }
  if (/[/\\?#%\u0000-\u001f\u007f]/.test(bucketName)) {
    fail("enrollment_request_invalid", "Directory grant bucket name contains an unsafe character");
  }
  if (backend === "s3" && !bucketName) {
    fail("enrollment_request_invalid", "An S3 directory grant requires a bucket name");
  }
  if (backend === "webdav" && bucketName) {
    fail("enrollment_request_invalid", "A WebDAV directory grant cannot contain a bucket name");
  }
  return {
    backend,
    bucketName,
    path: normalizeRemoteRelativePath(input.path)
  };
}

function normalizeDirectoryAuthorization(input) {
  assertPlainObject(input, "directory grant authorization");
  assertExactKeys(
    input,
    ["allowDelete", "directions"],
    "directory grant authorization"
  );
  if (!Array.isArray(input.directions) || input.directions.length === 0) {
    fail("enrollment_request_invalid", "Directory grant authorization requires at least one direction");
  }
  if (typeof input.allowDelete !== "boolean") {
    fail("enrollment_request_invalid", "Directory grant allowDelete must be boolean");
  }
  const directions = input.directions.map((item) => (
    requireText(item, "directoryGrant.authorization.directions[]")
  ));
  if (directions.some((direction) => !DIRECTIONS.has(direction))) {
    fail("enrollment_request_invalid", "Directory grant contains an unsupported direction");
  }
  return {
    directions: [...new Set(directions)].sort(),
    allowDelete: input.allowDelete
  };
}

function normalizeVerificationContext(input) {
  assertPlainObject(input, "enrollment verification context");
  assertExactKeys(input, VERIFICATION_CONTEXT_KEYS, "enrollment verification context");
  assertProtocolHeader(input, ENROLLMENT_VERIFICATION_CONTEXT_KIND);
  const verifier = requireText(input.verifier, "verifiedContext.verifier");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(verifier)) {
    fail("enrollment_request_invalid", "Verification context verifier identifier is invalid");
  }
  if (!Number.isSafeInteger(input.directoryGrantRevision) || input.directoryGrantRevision < 1) {
    fail(
      "enrollment_request_invalid",
      "Verification context directoryGrantRevision must be a positive safe integer"
    );
  }
  const expectedDevice = normalizeDeviceIdentity({
    serverId: input.expectedServerId,
    deviceId: input.expectedDeviceId
  });
  const expectedRequestId = requireText(
    input.expectedRequestId,
    "verifiedContext.expectedRequestId"
  );
  if (!/^req_[A-Za-z0-9_-]{16,128}$/.test(expectedRequestId)) {
    fail("enrollment_request_invalid", "Verification context expectedRequestId has an invalid format");
  }
  const expectedPublicKeyFingerprint = requireText(
    input.expectedPublicKeyFingerprint,
    "verifiedContext.expectedPublicKeyFingerprint"
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedPublicKeyFingerprint)) {
    fail(
      "enrollment_request_invalid",
      "Verification context expectedPublicKeyFingerprint is invalid"
    );
  }
  const expectedChannelRevision = requireText(
    input.expectedChannelRevision,
    "verifiedContext.expectedChannelRevision"
  );
  if (!/^chrev_[A-Za-z0-9_-]{16,128}$/.test(expectedChannelRevision)) {
    fail(
      "enrollment_request_invalid",
      "Verification context expectedChannelRevision has an invalid format"
    );
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: ENROLLMENT_VERIFICATION_CONTEXT_KIND,
    verifier,
    verifiedAt: normalizeTimestamp(input.verifiedAt),
    directoryGrantRevision: input.directoryGrantRevision,
    expectedServerId: expectedDevice.serverId,
    expectedDeviceId: expectedDevice.deviceId,
    expectedRequestId,
    expectedPublicKeyFingerprint,
    expectedChannelRevision
  };
}

function normalizeRemoteRelativePath(input) {
  const path = requireString(input, "directoryGrant.root.path");
  if (!path) {
    return "";
  }
  if (
    path.length > 2048
    || path.startsWith("/")
    || path.startsWith("\\")
    || /^[A-Za-z]:/.test(path)
    || path.includes("\\")
    || path.includes("%")
    || path.includes("?")
    || path.includes("#")
    || /[\u0000-\u001f\u007f]/.test(path)
    || path.normalize("NFC") !== path
  ) {
    fail("enrollment_request_invalid", "Directory grant root path is not an unambiguous remote relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment !== segment.trim()
  ))) {
    fail("enrollment_request_invalid", "Directory grant root path contains an unsafe segment");
  }
  return path;
}

function assertProtocolHeader(input, kind) {
  if (
    input.protocol !== ENROLLMENT_PROTOCOL_NAME
    || input.version !== ENROLLMENT_PROTOCOL_VERSION
    || input.kind !== kind
  ) {
    fail("enrollment_request_invalid", `${kind} protocol header is unsupported`);
  }
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail("enrollment_request_invalid", `${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      fail("enrollment_request_invalid", `${label} is missing field: ${key}`);
    }
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("enrollment_request_invalid", `${label} must be a plain object`);
  }
}

function requireString(input, label) {
  if (typeof input !== "string") {
    fail("enrollment_request_invalid", `${label} must be a string`);
  }
  return input;
}

function requireText(input, label) {
  const value = requireString(input, label);
  if (!value || value !== value.trim()) {
    fail("enrollment_request_invalid", `${label} must be non-empty without surrounding whitespace`);
  }
  return value;
}

function fail(code, message) {
  throw new EnrollmentProtocolError(code, message);
}
