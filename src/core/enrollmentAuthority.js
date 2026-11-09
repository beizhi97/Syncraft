import { createHash, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_AUTHORIZATION_MAX_SKEW_MS,
  DEFAULT_AUTHORIZATION_NONCE_LIMIT,
  ENROLLMENT_PROTOCOL_NAME,
  ENROLLMENT_PROTOCOL_VERSION,
  EnrollmentProtocolError,
  canonicalJson,
  createEnrollmentIdentityId,
  createOneTimeEnrollmentCode,
  decodeOneTimeEnrollmentCode,
  generateEnrollmentSecret,
  normalizeAuthorizationRequest,
  normalizeDeviceIdentity,
  normalizeEnrollmentBinding,
  normalizeEnrollmentBindings,
  normalizeEd25519PublicKey,
  normalizeServerId,
  normalizeTimestamp,
  sha256Bytes,
  timestampFromClock,
  verifyAuthorizationRequestSignature
} from "./enrollmentProtocol.js";

export const ENROLLMENT_STATE_STORAGE_CONTRACT =
  "caller-held-lock+atomic-json-replace+revision-check-v1";

const AUTHORITY_STATE_KEYS = [
  "authorizationNonces",
  "createdAt",
  "devices",
  "enrollmentRecords",
  "kind",
  "protocol",
  "relationGrants",
  "revision",
  "serverId",
  "storageContract",
  "updatedAt",
  "version"
];
const DEVICE_RECORD_KEYS = [
  "deviceId",
  "enrolledAt",
  "publicKeyFingerprint",
  "publicKeyJwk",
  "revokedAt",
  "serverId"
];
const ENROLLMENT_RECORD_KEYS = [
  "bindings",
  "channelRevision",
  "consumedAt",
  "consumedByDeviceId",
  "deviceId",
  "enrollmentId",
  "expiresAt",
  "issuedAt",
  "publicKeyFingerprint",
  "publicKeyJwk",
  "requestId",
  "secretHash",
  "serverId"
];
const RELATION_GRANT_RECORD_KEYS = [
  "binding",
  "grantedAt",
  "revokedAt"
];
const AUTHORIZATION_NONCE_RECORD_KEYS = [
  "nonce",
  "seenAt",
  "timestamp"
];
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function createEnrollmentAuthorityState(input = {}) {
  const serverId = normalizeServerId(input.serverId);
  const createdAt = timestampFromClock(input.nowMs ?? Date.now());
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "enrollment-authority-state",
    storageContract: ENROLLMENT_STATE_STORAGE_CONTRACT,
    revision: 0,
    serverId,
    createdAt,
    updatedAt: createdAt,
    enrollmentRecords: {},
    devices: {},
    relationGrants: {},
    authorizationNonces: {}
  };
}

export function issueOneTimeEnrollmentCode(state, input = {}, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  assertPlainObject(input, "one-time enrollment issue request");
  assertExactKeys(input, [
    "bindings",
    "channelRevision",
    "deviceId",
    "expiresAt",
    "issuedAt",
    "publicKey",
    "requestId"
  ], "one-time enrollment issue request");

  const device = normalizeDeviceIdentity({
    serverId: state.serverId,
    deviceId: input.deviceId
  });
  const requestId = normalizeIdentityId(input.requestId, "requestId");
  const channelRevision = normalizeIdentityId(input.channelRevision, "channelRevision");
  const bindings = normalizeEnrollmentBindings(input.bindings, {
    serverId: device.serverId,
    deviceId: device.deviceId,
    channelRevision
  });
  const publicKey = normalizeEd25519PublicKey(input.publicKey);
  const issuedAt = input.issuedAt == null
    ? timestampFromClock(options.nowMs ?? Date.now())
    : normalizeTimestamp(input.issuedAt);
  const expiresAt = normalizeTimestamp(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw protocolError("enrollment_request_invalid", "Enrollment code expiry must be later than issuedAt");
  }

  const existingDevice = state.devices[device.deviceId];
  if (existingDevice && existingDevice.revokedAt !== null) {
    throw protocolError("enrollment_device_revoked", "Revoked devices cannot be re-enrolled automatically");
  }
  if (existingDevice && existingDevice.publicKeyFingerprint !== publicKey.fingerprint) {
    throw protocolError(
      "enrollment_identity_conflict",
      "Replacing an enrolled device public key requires a separate controlled migration"
    );
  }
  if (Object.values(state.enrollmentRecords).some((record) => record.requestId === requestId)) {
    throw protocolError("enrollment_request_exists", "Enrollment requestId has already been issued");
  }

  const enrollmentId = createEnrollmentIdentityId("enrollmentId");
  const secret = generateEnrollmentSecret();
  const payload = {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "device-enrollment",
    enrollmentId,
    requestId,
    serverId: device.serverId,
    deviceId: device.deviceId,
    channelRevision,
    publicKeyFingerprint: publicKey.fingerprint,
    bindings,
    issuedAt,
    expiresAt,
    secret
  };
  const code = createOneTimeEnrollmentCode(payload, { nowMs: options.nowMs });
  const nextState = cloneState(state);
  nextState.enrollmentRecords[enrollmentId] = {
    enrollmentId,
    requestId,
    serverId: device.serverId,
    deviceId: device.deviceId,
    channelRevision,
    publicKeyFingerprint: publicKey.fingerprint,
    publicKeyJwk: publicKey.jwk,
    bindings,
    issuedAt,
    expiresAt,
    secretHash: sha256Text(secret),
    consumedAt: null,
    consumedByDeviceId: null
  };
  bumpRevision(nextState, options.nowMs);
  return {
    code,
    enrollmentId,
    requestId,
    serverId: device.serverId,
    deviceId: device.deviceId,
    channelRevision,
    publicKeyFingerprint: publicKey.fingerprint,
    bindings,
    issuedAt,
    expiresAt,
    nextState
  };
}

export function consumeOneTimeEnrollmentCode(state, code, request = {}, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  assertPlainObject(request, "enrollment consumption request");
  assertExactKeys(request, [
    "bindings",
    "channelRevision",
    "deviceId",
    "publicKey",
    "requestId"
  ], "enrollment consumption request");

  const payload = decodeOneTimeEnrollmentCode(code, {
    expectedServerId: state.serverId,
    nowMs: options.nowMs
  });
  const record = state.enrollmentRecords[payload.enrollmentId];
  if (!record) {
    throw protocolError("enrollment_code_invalid", "Enrollment code record is unavailable");
  }
  if (!constantTimeEqual(sha256Text(payload.secret), record.secretHash)) {
    throw protocolError("enrollment_code_invalid", "Enrollment code secret does not match server state");
  }
  if (record.consumedAt !== null) {
    throw protocolError("enrollment_code_used", "Enrollment code has already been consumed");
  }

  const requestId = normalizeIdentityId(request.requestId, "requestId");
  const channelRevision = normalizeIdentityId(request.channelRevision, "channelRevision");
  const requestBindings = normalizeEnrollmentBindings(request.bindings, {
    serverId: state.serverId,
    deviceId: payload.deviceId,
    channelRevision
  });
  const publicKey = normalizeEd25519PublicKey(request.publicKey);

  assertCodeRecordMatches(payload, record);
  if (
    requestId !== record.requestId ||
    payload.deviceId !== request.deviceId ||
    channelRevision !== record.channelRevision ||
    canonicalJson(requestBindings) !== canonicalJson(record.bindings)
  ) {
    throw protocolError("enrollment_binding_mismatch", "Enrollment request does not match the server-bound code");
  }
  if (publicKey.fingerprint !== record.publicKeyFingerprint) {
    throw protocolError("enrollment_public_key_mismatch", "Enrollment request public key does not match");
  }
  const existingDevice = state.devices[record.deviceId];
  if (existingDevice && existingDevice.revokedAt !== null) {
    throw protocolError("enrollment_device_revoked", "Revoked devices cannot be re-enrolled automatically");
  }
  if (existingDevice && existingDevice.publicKeyFingerprint !== record.publicKeyFingerprint) {
    throw protocolError(
      "enrollment_identity_conflict",
      "Enrollment cannot replace an existing device public key without a controlled migration"
    );
  }
  for (const binding of record.bindings) {
    const existingGrant = state.relationGrants[binding.identity.relationId];
    if (existingGrant && existingGrant.revokedAt !== null) {
      throw protocolError("enrollment_relation_revoked", "A revoked relation binding cannot be reactivated automatically");
    }
    if (existingGrant && canonicalJson(existingGrant.binding) !== canonicalJson(binding)) {
      throw protocolError(
        "enrollment_relation_conflict",
        "Enrollment cannot replace an existing relation binding without a controlled migration"
      );
    }
  }

  const consumedAt = timestampFromClock(options.nowMs ?? Date.now());
  const nextState = cloneState(state);
  nextState.enrollmentRecords[record.enrollmentId].consumedAt = consumedAt;
  nextState.enrollmentRecords[record.enrollmentId].consumedByDeviceId = record.deviceId;
  if (!state.devices[record.deviceId]) {
    nextState.authorizationNonces[record.deviceId] = [];
  }
  nextState.devices[record.deviceId] = {
    serverId: record.serverId,
    deviceId: record.deviceId,
    publicKeyFingerprint: record.publicKeyFingerprint,
    publicKeyJwk: record.publicKeyJwk,
    enrolledAt: consumedAt,
    revokedAt: null
  };
  for (const binding of record.bindings) {
    nextState.relationGrants[binding.identity.relationId] = {
      binding,
      grantedAt: consumedAt,
      revokedAt: null
    };
  }
  bumpRevision(nextState, options.nowMs);
  return {
    grant: {
      protocol: ENROLLMENT_PROTOCOL_NAME,
      version: ENROLLMENT_PROTOCOL_VERSION,
      kind: "enrollment-grant",
      requestId: record.requestId,
      serverId: record.serverId,
      deviceId: record.deviceId,
      publicKeyFingerprint: record.publicKeyFingerprint,
      bindings: record.bindings,
      enrolledAt: consumedAt
    },
    nextState
  };
}

export function grantEnrollmentBinding(state, bindingInput, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  const binding = normalizeEnrollmentBinding(bindingInput);
  assertServerBinding(state, binding);
  const device = state.devices[binding.identity.deviceId];
  if (!device || device.revokedAt !== null) {
    throw protocolError("enrollment_relation_denied", "Only an active enrolled device can receive a relation grant");
  }
  const existing = state.relationGrants[binding.identity.relationId];
  if (existing && existing.revokedAt !== null) {
    throw protocolError("enrollment_relation_revoked", "Revoked relation grants are not reactivated automatically");
  }
  if (existing && canonicalJson(existing.binding) !== canonicalJson(binding)) {
    throw protocolError(
      "enrollment_relation_conflict",
      "Relation grants cannot be rebound to another device or root without a controlled migration"
    );
  }
  const grantedAt = timestampFromClock(options.nowMs ?? Date.now());
  const nextState = cloneState(state);
  nextState.relationGrants[binding.identity.relationId] = {
    binding,
    grantedAt,
    revokedAt: null
  };
  bumpRevision(nextState, options.nowMs);
  return {
    binding,
    grantedAt,
    nextState
  };
}

export function revokeEnrollmentDevice(state, input = {}, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  assertPlainObject(input, "device revocation request");
  assertExactKeys(input, ["deviceId"], "device revocation request");
  const deviceId = normalizeIdentityId(input.deviceId, "deviceId");
  const device = state.devices[deviceId];
  if (!device) {
    throw protocolError("enrollment_relation_denied", "Device is not enrolled");
  }
  const revokedAt = timestampFromClock(options.nowMs ?? Date.now());
  const nextState = cloneState(state);
  nextState.devices[deviceId].revokedAt = revokedAt;
  bumpRevision(nextState, options.nowMs);
  return { deviceId, revokedAt, nextState };
}

export function revokeEnrollmentRelation(state, input = {}, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  assertPlainObject(input, "relation revocation request");
  assertExactKeys(input, ["relationId"], "relation revocation request");
  const relationId = normalizeIdentityId(input.relationId, "relationId");
  const grant = state.relationGrants[relationId];
  if (!grant) {
    throw protocolError("enrollment_relation_denied", "Relation grant does not exist");
  }
  const revokedAt = timestampFromClock(options.nowMs ?? Date.now());
  const nextState = cloneState(state);
  nextState.relationGrants[relationId].revokedAt = revokedAt;
  bumpRevision(nextState, options.nowMs);
  return { relationId, revokedAt, nextState };
}

export function verifySignedAuthorizationRequest(state, request, expected = {}, options = {}) {
  assertAuthorityState(state);
  assertExpectedRevision(state, options.expectedRevision);
  assertPlainObject(expected, "expected authorization request");
  assertExactKeys(expected, ["bodySha256", "method", "path"], "expected authorization request");

  const normalized = normalizeAuthorizationRequest(request);
  const binding = normalized.binding;
  if (binding.identity.serverId !== state.serverId) {
    throw protocolError("enrollment_binding_mismatch", "Authorization request belongs to a different server");
  }
  const device = state.devices[binding.identity.deviceId];
  if (!device || device.revokedAt !== null) {
    throw protocolError("enrollment_relation_denied", "Authorization device is not active");
  }
  if (device.publicKeyFingerprint !== normalized.publicKeyFingerprint) {
    throw protocolError("enrollment_public_key_mismatch", "Authorization public key is not the enrolled device key");
  }
  const verified = verifyAuthorizationRequestSignature(normalized, device.publicKeyJwk);
  const grant = state.relationGrants[binding.identity.relationId];
  if (!grant || grant.revokedAt !== null || canonicalJson(grant.binding) !== canonicalJson(binding)) {
    throw protocolError("enrollment_relation_denied", "Authorization binding is not granted by server state");
  }

  const nowMs = resolveNowMs(options.nowMs);
  const timestampMs = Date.parse(verified.timestamp);
  const maxSkewMs = normalizePositiveIntegerOption(
    options.maxSkewMs ?? DEFAULT_AUTHORIZATION_MAX_SKEW_MS,
    "maxSkewMs",
    60 * 60 * 1000
  );
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    throw protocolError("enrollment_auth_expired", "Authorization request timestamp is outside the allowed window");
  }
  if (
    verified.method !== normalizeHttpMethod(expected.method) ||
    verified.path !== normalizeRequestPath(expected.path) ||
    verified.bodySha256 !== normalizeBodySha256(expected.bodySha256)
  ) {
    throw protocolError("enrollment_request_mismatch", "Authorization request does not match the actual HTTP request");
  }

  const nextState = cloneState(state);
  const storedNonceEntries = nextState.authorizationNonces[binding.identity.deviceId];
  if (storedNonceEntries != null && !Array.isArray(storedNonceEntries)) {
    throw protocolError("enrollment_state_invalid", "Authorization nonce state is not an array");
  }
  const nonceEntries = storedNonceEntries || [];
  for (const entry of nonceEntries) {
    if (!isPlainObject(entry) || typeof entry.nonce !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw protocolError("enrollment_state_invalid", "Authorization nonce state is corrupt");
    }
  }
  const retained = nonceEntries.filter((entry) => {
    const entryTimestamp = Date.parse(entry.timestamp);
    return nowMs <= entryTimestamp + maxSkewMs;
  });
  if (retained.some((entry) => entry.nonce === verified.nonce)) {
    throw protocolError("enrollment_auth_replayed", "Authorization nonce was already used");
  }
  const nonceLimit = normalizePositiveIntegerOption(
    options.nonceLimit ?? DEFAULT_AUTHORIZATION_NONCE_LIMIT,
    "nonceLimit",
    10_000
  );
  if (retained.length >= nonceLimit) {
    throw protocolError("enrollment_auth_capacity", "Authorization nonce window is saturated");
  }
  retained.push({
    nonce: verified.nonce,
    timestamp: verified.timestamp,
    seenAt: timestampFromClock(nowMs)
  });
  nextState.authorizationNonces[binding.identity.deviceId] = retained;
  bumpRevision(nextState, nowMs);

  return {
    decision: "allow",
    binding,
    requestDigest: sha256Bytes(Buffer.from(canonicalJson(authorizationUnsigned(verified)), "utf8")),
    checkedAt: timestampFromClock(nowMs),
    nextState
  };
}

export function relationGrantKey(relationId) {
  return normalizeIdentityId(relationId, "relationId");
}

export function assertEnrollmentStateTransition(previousState, nextState) {
  assertAuthorityState(previousState);
  assertAuthorityState(nextState);
  if (nextState.revision !== previousState.revision + 1) {
    throw protocolError("enrollment_state_conflict", "Enrollment state revision did not advance exactly once");
  }
  return true;
}

function assertCodeRecordMatches(payload, record) {
  const payloadRecord = {
    enrollmentId: payload.enrollmentId,
    requestId: payload.requestId,
    serverId: payload.serverId,
    deviceId: payload.deviceId,
    channelRevision: payload.channelRevision,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    bindings: payload.bindings,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  };
  const storedRecord = {
    enrollmentId: record.enrollmentId,
    requestId: record.requestId,
    serverId: record.serverId,
    deviceId: record.deviceId,
    channelRevision: record.channelRevision,
    publicKeyFingerprint: record.publicKeyFingerprint,
    bindings: record.bindings,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt
  };
  if (canonicalJson(payloadRecord) !== canonicalJson(storedRecord)) {
    throw protocolError("enrollment_binding_mismatch", "Enrollment code does not match server state");
  }
}

function assertAuthorityState(state) {
  assertPlainObject(state, "enrollment authority state");
  assertStateExactKeys(state, AUTHORITY_STATE_KEYS, "enrollment authority state");
  if (
    state.protocol !== ENROLLMENT_PROTOCOL_NAME ||
    state.version !== ENROLLMENT_PROTOCOL_VERSION ||
    state.kind !== "enrollment-authority-state" ||
    state.storageContract !== ENROLLMENT_STATE_STORAGE_CONTRACT ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    throw protocolError("enrollment_state_invalid", "Enrollment authority state contract is invalid");
  }
  const serverId = normalizeStateValue(
    () => normalizeServerId(state.serverId),
    "Enrollment authority state serverId"
  );
  assertStateTimestamp(state.createdAt, "Enrollment authority state createdAt");
  assertStateTimestamp(state.updatedAt, "Enrollment authority state updatedAt");
  for (const key of ["enrollmentRecords", "devices", "relationGrants", "authorizationNonces"]) {
    if (!isPlainObject(state[key])) {
      throw protocolError("enrollment_state_invalid", `Enrollment authority state is missing ${key}`);
    }
  }

  const requestIds = new Set();
  for (const [enrollmentId, record] of Object.entries(state.enrollmentRecords)) {
    assertEnrollmentRecord(state, enrollmentId, record, requestIds);
  }
  for (const [deviceId, record] of Object.entries(state.devices)) {
    assertDeviceRecord(state, deviceId, record);
  }
  for (const [relationId, record] of Object.entries(state.relationGrants)) {
    assertRelationGrantRecord(state, relationId, record);
  }
  for (const [deviceId, entries] of Object.entries(state.authorizationNonces)) {
    assertAuthorizationNonceEntries(state, deviceId, entries);
  }

  for (const [deviceId, record] of Object.entries(state.devices)) {
    if (!Object.hasOwn(state.authorizationNonces, deviceId)) {
      throw protocolError(
        "enrollment_state_invalid",
        `Device ${deviceId} is missing its authorization nonce array`
      );
    }
    const hasConsumedEnrollment = Object.values(state.enrollmentRecords).some((enrollment) => (
      enrollment.deviceId === deviceId
      && enrollment.serverId === serverId
      && enrollment.consumedAt !== null
      && enrollment.consumedByDeviceId === deviceId
      && enrollment.publicKeyFingerprint === record.publicKeyFingerprint
    ));
    if (!hasConsumedEnrollment) {
      throw protocolError(
        "enrollment_state_invalid",
        `Device ${deviceId} has no matching consumed enrollment record`
      );
    }
  }

  for (const enrollment of Object.values(state.enrollmentRecords)) {
    if (enrollment.consumedAt === null) {
      continue;
    }
    const device = state.devices[enrollment.consumedByDeviceId];
    if (
      !device
      || device.serverId !== enrollment.serverId
      || device.publicKeyFingerprint !== enrollment.publicKeyFingerprint
    ) {
      throw protocolError(
        "enrollment_state_invalid",
        "Consumed enrollment record does not match its device record"
      );
    }
  }
}

function assertEnrollmentRecord(state, enrollmentId, record, requestIds) {
  assertPlainObject(record, "enrollment record");
  assertStateExactKeys(record, ENROLLMENT_RECORD_KEYS, "enrollment record");
  const normalizedEnrollmentId = normalizeStateValue(
    () => normalizeIdentityId(enrollmentId, "enrollmentId"),
    "Enrollment record map key"
  );
  const recordEnrollmentId = normalizeStateValue(
    () => normalizeIdentityId(record.enrollmentId, "enrollmentId"),
    "Enrollment record enrollmentId"
  );
  if (normalizedEnrollmentId !== recordEnrollmentId) {
    throw protocolError("enrollment_state_invalid", "Enrollment record map key does not match enrollmentId");
  }
  const serverId = normalizeStateValue(
    () => normalizeServerId(record.serverId),
    "Enrollment record serverId"
  );
  if (serverId !== state.serverId) {
    throw protocolError("enrollment_state_invalid", "Enrollment record belongs to a different server");
  }
  const deviceId = normalizeStateValue(
    () => normalizeIdentityId(record.deviceId, "deviceId"),
    "Enrollment record deviceId"
  );
  const requestId = normalizeStateValue(
    () => normalizeIdentityId(record.requestId, "requestId"),
    "Enrollment record requestId"
  );
  if (requestIds.has(requestId)) {
    throw protocolError("enrollment_state_invalid", "Enrollment records contain a duplicate requestId");
  }
  requestIds.add(requestId);
  const channelRevision = normalizeStateValue(
    () => normalizeIdentityId(record.channelRevision, "channelRevision"),
    "Enrollment record channelRevision"
  );
  const publicKey = normalizeStateValue(
    () => normalizeEd25519PublicKey(record.publicKeyJwk),
    "Enrollment record publicKeyJwk"
  );
  if (
    canonicalJson(record.publicKeyJwk) !== canonicalJson(publicKey.jwk)
    || record.publicKeyFingerprint !== publicKey.fingerprint
  ) {
    throw protocolError(
      "enrollment_state_invalid",
      "Enrollment record public key fingerprint does not match its JWK"
    );
  }
  normalizeStateValue(
    () => normalizeEnrollmentBindings(record.bindings, {
      serverId: state.serverId,
      deviceId,
      channelRevision
    }),
    "Enrollment record bindings"
  );
  const issuedAt = assertStateTimestamp(record.issuedAt, "Enrollment record issuedAt");
  const expiresAt = assertStateTimestamp(record.expiresAt, "Enrollment record expiresAt");
  if (expiresAt <= issuedAt) {
    throw protocolError("enrollment_state_invalid", "Enrollment record expiry is not later than issuedAt");
  }
  if (typeof record.secretHash !== "string" || !HEX_SHA256_PATTERN.test(record.secretHash)) {
    throw protocolError("enrollment_state_invalid", "Enrollment record secretHash is invalid");
  }
  const consumedAt = assertNullableStateTimestamp(
    record.consumedAt,
    "Enrollment record consumedAt"
  );
  let consumedByDeviceId = null;
  if (record.consumedByDeviceId !== null) {
    consumedByDeviceId = normalizeStateValue(
      () => normalizeIdentityId(record.consumedByDeviceId, "deviceId"),
      "Enrollment record consumedByDeviceId"
    );
  }
  if (
    (consumedAt === null && consumedByDeviceId !== null)
    || (consumedAt !== null && consumedByDeviceId !== deviceId)
  ) {
    throw protocolError(
      "enrollment_state_invalid",
      "Enrollment record consumption fields are inconsistent"
    );
  }
}

function assertDeviceRecord(state, deviceId, record) {
  assertPlainObject(record, "device record");
  assertStateExactKeys(record, DEVICE_RECORD_KEYS, "device record");
  const normalizedKey = normalizeStateValue(
    () => normalizeIdentityId(deviceId, "deviceId"),
    "Device record map key"
  );
  const normalizedDeviceId = normalizeStateValue(
    () => normalizeIdentityId(record.deviceId, "deviceId"),
    "Device record deviceId"
  );
  if (normalizedKey !== normalizedDeviceId) {
    throw protocolError("enrollment_state_invalid", "Device record map key does not match deviceId");
  }
  const serverId = normalizeStateValue(
    () => normalizeServerId(record.serverId),
    "Device record serverId"
  );
  if (serverId !== state.serverId) {
    throw protocolError("enrollment_state_invalid", "Device record belongs to a different server");
  }
  const publicKey = normalizeStateValue(
    () => normalizeEd25519PublicKey(record.publicKeyJwk),
    "Device record publicKeyJwk"
  );
  if (
    canonicalJson(record.publicKeyJwk) !== canonicalJson(publicKey.jwk)
    || record.publicKeyFingerprint !== publicKey.fingerprint
  ) {
    throw protocolError(
      "enrollment_state_invalid",
      "Device record public key fingerprint does not match its JWK"
    );
  }
  assertStateTimestamp(record.enrolledAt, "Device record enrolledAt");
  assertNullableStateTimestamp(record.revokedAt, "Device record revokedAt");
}

function assertRelationGrantRecord(state, relationId, record) {
  assertPlainObject(record, "relation grant record");
  assertStateExactKeys(record, RELATION_GRANT_RECORD_KEYS, "relation grant record");
  const normalizedKey = normalizeStateValue(
    () => normalizeIdentityId(relationId, "relationId"),
    "Relation grant map key"
  );
  const binding = normalizeStateValue(
    () => normalizeEnrollmentBinding(record.binding),
    "Relation grant binding"
  );
  if (normalizedKey !== binding.identity.relationId) {
    throw protocolError(
      "enrollment_state_invalid",
      "Relation grant map key does not match its binding"
    );
  }
  if (binding.identity.serverId !== state.serverId) {
    throw protocolError("enrollment_state_invalid", "Relation grant belongs to a different server");
  }
  if (!state.devices[binding.identity.deviceId]) {
    throw protocolError("enrollment_state_invalid", "Relation grant references an unknown device");
  }
  assertStateTimestamp(record.grantedAt, "Relation grant grantedAt");
  assertNullableStateTimestamp(record.revokedAt, "Relation grant revokedAt");
}

function assertAuthorizationNonceEntries(state, deviceId, entries) {
  const normalizedDeviceId = normalizeStateValue(
    () => normalizeIdentityId(deviceId, "deviceId"),
    "Authorization nonce map key"
  );
  if (!state.devices[normalizedDeviceId]) {
    throw protocolError(
      "enrollment_state_invalid",
      "Authorization nonce entries reference an unknown device"
    );
  }
  if (!Array.isArray(entries)) {
    throw protocolError("enrollment_state_invalid", "Authorization nonce state is not an array");
  }
  const nonces = new Set();
  for (const entry of entries) {
    assertPlainObject(entry, "authorization nonce entry");
    assertStateExactKeys(entry, AUTHORIZATION_NONCE_RECORD_KEYS, "authorization nonce entry");
    if (typeof entry.nonce !== "string" || !NONCE_PATTERN.test(entry.nonce)) {
      throw protocolError("enrollment_state_invalid", "Authorization nonce entry is invalid");
    }
    if (nonces.has(entry.nonce)) {
      throw protocolError("enrollment_state_invalid", "Authorization nonce entries contain a duplicate");
    }
    nonces.add(entry.nonce);
    assertStateTimestamp(entry.timestamp, "Authorization nonce timestamp");
    assertStateTimestamp(entry.seenAt, "Authorization nonce seenAt");
  }
}

function assertStateExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw protocolError("enrollment_state_invalid", `${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw protocolError("enrollment_state_invalid", `${label} is missing field: ${key}`);
    }
  }
}

function assertStateTimestamp(input, label) {
  try {
    return Date.parse(normalizeTimestamp(input));
  } catch {
    throw protocolError("enrollment_state_invalid", `${label} is not a canonical timestamp`);
  }
}

function assertNullableStateTimestamp(input, label) {
  if (input === null) {
    return null;
  }
  return assertStateTimestamp(input, label);
}

function normalizeStateValue(normalize, label) {
  try {
    return normalize();
  } catch {
    throw protocolError("enrollment_state_invalid", `${label} is invalid`);
  }
}

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
    throw protocolError("enrollment_state_conflict", "Enrollment state changed since the caller acquired it");
  }
}

function assertServerBinding(state, binding) {
  if (binding.identity.serverId !== state.serverId) {
    throw protocolError("enrollment_binding_mismatch", "Enrollment binding belongs to a different server");
  }
}

function authorizationUnsigned(request) {
  const { signature: _signature, ...unsigned } = request;
  return unsigned;
}

function bumpRevision(nextState, nowMs) {
  nextState.revision += 1;
  nextState.updatedAt = timestampFromClock(nowMs ?? Date.now());
}

function cloneState(state) {
  return structuredClone(state);
}

function sha256Text(input) {
  return createHash("sha256").update(String(input), "utf8").digest("hex");
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left), "utf8");
  const rightBytes = Buffer.from(String(right), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeIdentityId(input, kind) {
  const rules = {
    channelRevision: ["chrev_", "channelRevision"],
    deviceId: ["dev_", "deviceId"],
    enrollmentId: ["enr_", "enrollmentId"],
    relationId: ["rel_", "relationId"],
    requestId: ["req_", "requestId"]
  };
  const rule = rules[kind];
  if (typeof input !== "string") {
    throw protocolError("enrollment_request_invalid", `${rule[1]} must be a string`);
  }
  const value = input;
  if (value !== value.trim()) {
    throw protocolError("enrollment_request_invalid", `${rule[1]} cannot contain surrounding whitespace`);
  }
  const pattern = new RegExp(`^${rule[0]}[A-Za-z0-9_-]{16,128}$`);
  if (!pattern.test(value)) {
    throw protocolError("enrollment_request_invalid", `${rule[1]} has an invalid format`);
  }
  return value;
}

function normalizeHttpMethod(input) {
  if (typeof input !== "string") {
    throw protocolError("enrollment_request_invalid", "HTTP method must be a string");
  }
  const method = input;
  if (method !== method.trim()) {
    throw protocolError("enrollment_request_invalid", "HTTP method cannot contain surrounding whitespace");
  }
  if (!/^[A-Z]{3,16}$/.test(method)) {
    throw protocolError("enrollment_request_invalid", "HTTP method must be uppercase ASCII");
  }
  return method;
}

function normalizeRequestPath(input) {
  if (typeof input !== "string") {
    throw protocolError("enrollment_request_invalid", "Authorization path must be a string");
  }
  const path = input;
  if (path !== path.trim()) {
    throw protocolError("enrollment_request_invalid", "Authorization path cannot contain surrounding whitespace");
  }
  if (
    !/^\/[\x21-\x7e]*$/.test(path) ||
    path.includes("#") ||
    path.includes("\\") ||
    /%(?![0-9A-Fa-f]{2})/.test(path) ||
    path.length > 2048
  ) {
    throw protocolError("enrollment_request_invalid", "Authorization path must be exact ASCII origin-form path and query");
  }
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (pathname.startsWith("//") || pathname.includes("//") || /%(?:2f|5c|2e)/i.test(pathname)) {
    throw protocolError("enrollment_request_invalid", "Authorization path contains an unsafe segment");
  }
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw protocolError("enrollment_request_invalid", "Authorization path contains invalid percent encoding");
  }
  if (decodedPathname.split("/").some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw protocolError("enrollment_request_invalid", "Authorization path contains a dot or backslash segment");
  }
  return path;
}

function normalizeBodySha256(input) {
  if (typeof input !== "string") {
    throw protocolError("enrollment_request_invalid", "bodySha256 must be a string");
  }
  const hash = input;
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw protocolError("enrollment_request_invalid", "bodySha256 is invalid");
  }
  return hash;
}

function resolveNowMs(input) {
  const value = input ?? Date.now();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError("enrollment_request_invalid", "nowMs must be finite epoch milliseconds");
  }
  return value;
}

function normalizePositiveIntegerOption(input, label, maximum) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0 || input > maximum) {
    throw protocolError("enrollment_request_invalid", `${label} must be a positive bounded integer`);
  }
  return input;
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw protocolError("enrollment_request_invalid", `${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw protocolError("enrollment_request_invalid", `${label} is missing field: ${key}`);
    }
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw protocolError("enrollment_state_invalid", `${label} must be a plain object`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolError(code, message) {
  return new EnrollmentProtocolError(code, message);
}
export { assertAuthorityState as assertEnrollmentAuthorityState };
