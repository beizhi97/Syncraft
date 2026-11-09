import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";

import { parseVlessUri } from "./vless.js";

export const ENROLLMENT_PROTOCOL_NAME = "sfsc-enrollment";
export const ENROLLMENT_PROTOCOL_VERSION = 1;

export const CHANNEL_CONFIG_KIND = "channel-config";
export const DEVICE_ENROLLMENT_KIND = "device-enrollment";
export const AUTHORIZATION_REQUEST_KIND = "authorization-request";

export const CHANNEL_CONFIG_CODE_PREFIX = "SFSC-CHANNEL1-";
export const CHANNEL_CONFIG_URI_PREFIX = "sfsc://channel/v1#";
export const DEVICE_ENROLLMENT_CODE_PREFIX = "SFSC-ENROLL1-";
export const DEVICE_ENROLLMENT_URI_PREFIX = "sfsc://enroll/v1#";

export const AUTHORIZATION_SIGNATURE_SCHEME = "sfsc-ed25519-v1";
export const CHANNEL_AUTHENTICATOR_SCHEME = "sfsc-ed25519-channel-v1";
export const DEFAULT_AUTHORIZATION_MAX_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_AUTHORIZATION_NONCE_LIMIT = 64;
export const DEFAULT_CHANNEL_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ENROLLMENT_MAX_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_ISSUED_AT_FUTURE_SKEW_MS = 60 * 1000;
export const MIN_ENROLLMENT_SECRET_BYTES = 32;

export const ENROLLMENT_ERROR_STATUS = Object.freeze({
  enrollment_auth_capacity: 429,
  enrollment_auth_expired: 401,
  enrollment_auth_invalid: 401,
  enrollment_auth_replayed: 409,
  enrollment_binding_mismatch: 403,
  enrollment_channel_expired: 410,
  enrollment_channel_stale: 409,
  enrollment_code_expired: 410,
  enrollment_code_invalid: 400,
  enrollment_code_used: 409,
  enrollment_device_revoked: 403,
  enrollment_identity_conflict: 409,
  enrollment_public_key_mismatch: 403,
  enrollment_relation_denied: 403,
  enrollment_relation_conflict: 409,
  enrollment_relation_revoked: 409,
  enrollment_request_exists: 409,
  enrollment_request_invalid: 400,
  enrollment_request_mismatch: 403,
  enrollment_state_conflict: 409,
  enrollment_state_invalid: 500,
  enrollment_trust_failed: 401,
  enrollment_trust_verifier_required: 500
});

const ID_RULES = Object.freeze({
  channelRevision: ["chrev_", "channelRevision"],
  credentialRevision: ["cred_", "credentialRevision"],
  deviceId: ["dev_", "deviceId"],
  enrollmentId: ["enr_", "enrollmentId"],
  relationId: ["rel_", "relationId"],
  requestId: ["req_", "requestId"],
  rootAttestation: ["att_", "referenceId"],
  rootId: ["root_", "rootId"],
  serverId: ["srv_", "serverId"],
  shareId: ["shr_", "shareId"],
  signingKeyId: ["key_", "keyId"]
});

const ASCII_PATH_QUERY_PATTERN = /^\/[\x21-\x7e]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export class EnrollmentProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "EnrollmentProtocolError";
    this.code = code;
    this.status = ENROLLMENT_ERROR_STATUS[code] || 400;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function createEnrollmentIdentityId(kind) {
  const rule = ID_RULES[kind];
  if (!rule) {
    throw protocolError("enrollment_request_invalid", `Unknown identity kind: ${kind}`);
  }
  return `${rule[0]}${randomBytes(18).toString("base64url")}`;
}

export function normalizeServerId(input) {
  return normalizeIdentityId(input, "serverId");
}

export function normalizeDeviceIdentity(input = {}) {
  assertPlainObject(input, "device identity");
  assertExactKeys(input, ["deviceId", "serverId"], "device identity");
  return {
    serverId: normalizeIdentityId(input.serverId, "serverId"),
    deviceId: normalizeIdentityId(input.deviceId, "deviceId")
  };
}

export function normalizeEnrollmentBinding(input = {}) {
  assertPlainObject(input, "enrollment binding");
  assertExactKeys(input, [
    "baselineEpoch",
    "channelRevision",
    "credentialRevision",
    "identity",
    "kind",
    "protocol",
    "rootAttestation",
    "version"
  ], "enrollment binding");
  assertProtocolHeader(input, "enrollment-binding");
  if (typeof input.baselineEpoch !== "number" || !Number.isSafeInteger(input.baselineEpoch) || input.baselineEpoch < 1) {
    throw protocolError("enrollment_request_invalid", "baselineEpoch must be a positive safe integer");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: "enrollment-binding",
    identity: normalizeFullIdentity(input.identity),
    baselineEpoch: input.baselineEpoch,
    channelRevision: normalizeIdentityId(input.channelRevision, "channelRevision"),
    credentialRevision: normalizeIdentityId(input.credentialRevision, "credentialRevision"),
    rootAttestation: normalizeRootAttestation(input.rootAttestation)
  };
}

export function normalizeFullIdentity(input = {}) {
  assertPlainObject(input, "full identity");
  assertExactKeys(input, ["deviceId", "relationId", "rootId", "serverId", "shareId"], "full identity");
  return {
    ...normalizeDeviceIdentity({ serverId: input.serverId, deviceId: input.deviceId }),
    shareId: normalizeIdentityId(input.shareId, "shareId"),
    rootId: normalizeIdentityId(input.rootId, "rootId"),
    relationId: normalizeIdentityId(input.relationId, "relationId")
  };
}

export function normalizeEnrollmentBindings(input, expected = {}) {
  if (!Array.isArray(input) || input.length === 0) {
    throw protocolError("enrollment_request_invalid", "Enrollment bindings must be a non-empty array");
  }
  const bindings = input.map(normalizeEnrollmentBinding);
  const relationIds = new Set();
  for (const binding of bindings) {
    if (relationIds.has(binding.identity.relationId)) {
      throw protocolError("enrollment_request_invalid", "Enrollment bindings contain a duplicate relationId");
    }
    relationIds.add(binding.identity.relationId);
    if (expected.serverId != null && binding.identity.serverId !== expected.serverId) {
      throw protocolError("enrollment_binding_mismatch", "Enrollment binding belongs to a different server");
    }
    if (expected.deviceId != null && binding.identity.deviceId !== expected.deviceId) {
      throw protocolError("enrollment_binding_mismatch", "Enrollment binding belongs to a different device");
    }
    if (expected.channelRevision != null && binding.channelRevision !== expected.channelRevision) {
      throw protocolError("enrollment_binding_mismatch", "Enrollment binding belongs to a different channel revision");
    }
  }
  return bindings.sort(compareEnrollmentBindings);
}

export function createEnrollmentKeyPair() {
  return generateKeyPairSync("ed25519");
}

export function normalizeEd25519PublicKey(input) {
  let key;
  try {
    if (typeof input === "string") {
      key = createPublicKey({ key: input, format: "pem" });
    } else if (input && typeof input === "object" && input.type === "public") {
      key = input;
    } else if (isPlainObject(input) && input.kty === "OKP") {
      key = createPublicKey({ key: input, format: "jwk" });
    } else {
      key = createPublicKey(input);
    }
  } catch {
    throw protocolError("enrollment_request_invalid", "A valid Ed25519 public key is required");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw protocolError("enrollment_request_invalid", "Enrollment public keys must use Ed25519");
  }
  const exported = key.export({ format: "jwk" });
  return {
    jwk: {
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x
    },
    fingerprint: createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("base64url")
  };
}

export function publicKeyFingerprint(input) {
  return normalizeEd25519PublicKey(input).fingerprint;
}

export function generateEnrollmentSecret() {
  return randomBytes(32).toString("base64url");
}

export function createChannelConfigCode(input, options = {}) {
  if (!options.signingKey) {
    throw protocolError("enrollment_request_invalid", "Channel config issuance requires a server signing key");
  }
  const keyId = normalizeIdentityId(options.keyId, "signingKeyId");
  const unsigned = normalizeChannelConfigPayload(input, options, { requireAuthenticator: false });
  let signature;
  try {
    signature = sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), options.signingKey).toString("base64url");
  } catch {
    throw protocolError("enrollment_request_invalid", "Unable to sign the channel config payload");
  }
  const payload = normalizeChannelConfigPayload({
    ...unsigned,
    authenticator: {
      scheme: CHANNEL_AUTHENTICATOR_SCHEME,
      keyId,
      signature
    }
  }, options);
  return encodeEnvelope(CHANNEL_CONFIG_URI_PREFIX, payload);
}

export function decodeChannelConfigCode(input, options = {}) {
  const decoded = decodeEnvelope(input, {
    codePrefix: CHANNEL_CONFIG_CODE_PREFIX,
    uriPrefix: CHANNEL_CONFIG_URI_PREFIX,
    label: "Channel config code"
  });
  assertProtocolHeader(decoded, CHANNEL_CONFIG_KIND);
  const payload = normalizeChannelConfigPayload(decoded, options);
  assertNotExpired(payload.expiresAt, options.nowMs, "enrollment_channel_expired", "Channel config code has expired");
  assertNotExpired(
    payload.bootstrap.expiresAt,
    options.nowMs,
    "enrollment_channel_expired",
    "Enrollment bootstrap window has expired"
  );
  return payload;
}

export function verifyChannelConfigCode(input, options = {}) {
  const payload = decodeChannelConfigCode(input, options);
  const trustedServerKeys = options.trustedServerKeys;
  if (!isPlainObject(trustedServerKeys)) {
    throw protocolError("enrollment_trust_verifier_required", "Channel config verification requires pinned server keys");
  }
  const pin = trustedServerKeys[payload.authenticator.keyId];
  if (!isPlainObject(pin) || pin.serverId !== payload.serverId || !pin.publicKey) {
    throw protocolError("enrollment_trust_failed", "Channel config signing key is not pinned for this server");
  }
  let trusted = false;
  try {
    const pinnedKey = normalizeEd25519PublicKey(pin.publicKey);
    trusted = verify(
      null,
      Buffer.from(canonicalJson(channelConfigUnsignedPayload(payload)), "utf8"),
      createPublicKey({ key: pinnedKey.jwk, format: "jwk" }),
      Buffer.from(payload.authenticator.signature, "base64url")
    );
  } catch {
    trusted = false;
  }
  if (!trusted) {
    throw protocolError("enrollment_trust_failed", "Channel config server signature is invalid");
  }
  assertBootstrapPolicy(payload.bootstrap.endpoint, pin);
  return {
    payload,
    trust: {
      status: "verified",
      signerId: payload.authenticator.keyId,
      pinnedServerId: pin.serverId
    }
  };
}

export function createOneTimeEnrollmentCode(input, options = {}) {
  return encodeEnvelope(DEVICE_ENROLLMENT_URI_PREFIX, normalizeOneTimeEnrollmentPayload(input, options));
}

export function decodeOneTimeEnrollmentCode(input, options = {}) {
  const decoded = decodeEnvelope(input, {
    codePrefix: DEVICE_ENROLLMENT_CODE_PREFIX,
    uriPrefix: DEVICE_ENROLLMENT_URI_PREFIX,
    label: "One-time enrollment code"
  });
  assertProtocolHeader(decoded, DEVICE_ENROLLMENT_KIND);
  const payload = normalizeOneTimeEnrollmentPayload(decoded, options);
  if (options.expectedServerId != null && payload.serverId !== normalizeServerId(options.expectedServerId)) {
    throw protocolError("enrollment_binding_mismatch", "Enrollment code belongs to a different server");
  }
  assertNotExpired(payload.expiresAt, options.nowMs, "enrollment_code_expired", "Enrollment code has expired");
  return payload;
}

export function sha256Bytes(input) {
  return createHash("sha256").update(toByteView(input)).digest("hex");
}

export function signAuthorizationRequest(input = {}, privateKey, options = {}) {
  assertPlainObject(input, "authorization request input");
  assertExactKeys(input, ["binding", "bodyBytes", "method", "nonce", "path", "timestamp"], "authorization request input");
  const unsigned = {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: AUTHORIZATION_REQUEST_KIND,
    scheme: AUTHORIZATION_SIGNATURE_SCHEME,
    binding: normalizeEnrollmentBinding(input.binding),
    publicKeyFingerprint: publicKeyFingerprint(privateKey),
    method: normalizeHttpMethod(input.method),
    path: normalizeRequestPath(input.path),
    bodySha256: sha256Bytes(input.bodyBytes),
    timestamp: input.timestamp == null
      ? timestampFromClock(options.nowMs ?? Date.now())
      : normalizeTimestamp(input.timestamp),
    nonce: normalizeNonce(input.nonce ?? randomBytes(18).toString("base64url"))
  };
  let signature;
  try {
    signature = sign(null, authorizationSigningBytes(unsigned), privateKey).toString("base64url");
  } catch {
    throw protocolError("enrollment_auth_invalid", "Unable to sign the authorization request");
  }
  return { ...unsigned, signature };
}

export function verifyAuthorizationRequestSignature(request, publicKeyInput) {
  const normalized = normalizeAuthorizationRequest(request);
  const publicKey = normalizeEd25519PublicKey(publicKeyInput);
  if (normalized.publicKeyFingerprint !== publicKey.fingerprint) {
    throw protocolError("enrollment_public_key_mismatch", "Authorization request public key fingerprint does not match");
  }
  let valid = false;
  try {
    valid = verify(
      null,
      authorizationSigningBytes(authorizationUnsignedPayload(normalized)),
      createPublicKey({ key: publicKey.jwk, format: "jwk" }),
      Buffer.from(normalized.signature, "base64url")
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw protocolError("enrollment_auth_invalid", "Authorization request signature is invalid");
  }
  return normalized;
}

export function normalizeAuthorizationRequest(input = {}) {
  assertPlainObject(input, "authorization request");
  assertExactKeys(input, [
    "binding",
    "bodySha256",
    "kind",
    "method",
    "nonce",
    "path",
    "protocol",
    "publicKeyFingerprint",
    "scheme",
    "signature",
    "timestamp",
    "version"
  ], "authorization request");
  assertProtocolHeader(input, AUTHORIZATION_REQUEST_KIND);
  if (input.scheme !== AUTHORIZATION_SIGNATURE_SCHEME) {
    throw protocolError("enrollment_auth_invalid", "Authorization signature scheme is unsupported");
  }
  const fingerprint = requireString(input.publicKeyFingerprint, "publicKeyFingerprint");
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw protocolError("enrollment_auth_invalid", "Authorization public key fingerprint is invalid");
  }
  const bodySha256 = requireString(input.bodySha256, "bodySha256").toLowerCase();
  if (!HEX_SHA256_PATTERN.test(bodySha256)) {
    throw protocolError("enrollment_auth_invalid", "Authorization body hash is invalid");
  }
  const signature = requireString(input.signature, "signature");
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw protocolError("enrollment_auth_invalid", "Authorization signature is invalid");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: AUTHORIZATION_REQUEST_KIND,
    scheme: AUTHORIZATION_SIGNATURE_SCHEME,
    binding: normalizeEnrollmentBinding(input.binding),
    publicKeyFingerprint: fingerprint,
    method: normalizeHttpMethod(input.method),
    path: normalizeRequestPath(input.path),
    bodySha256,
    timestamp: normalizeTimestamp(input.timestamp),
    nonce: normalizeNonce(input.nonce),
    signature
  };
}

export function authorizationUnsignedPayload(request) {
  const normalized = request.signature == null
    ? normalizeAuthorizationRequest({ ...request, signature: "A".repeat(86) })
    : normalizeAuthorizationRequest(request);
  const { signature: _signature, ...unsigned } = normalized;
  return unsigned;
}

export function authorizationSigningBytes(unsignedRequest) {
  return Buffer.from(canonicalJson(unsignedRequest), "utf8");
}

export function canonicalJson(value) {
  return stringifyCanonical(toJsonValue(value));
}

export function normalizeTimestamp(input) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    throw protocolError("enrollment_request_invalid", "Timestamp must be a canonical UTC ISO-8601 string");
  }
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input) {
    throw protocolError("enrollment_request_invalid", "Timestamp must be a canonical UTC ISO-8601 string");
  }
  return input;
}

export function timestampFromClock(input) {
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) {
      throw protocolError("enrollment_request_invalid", "Clock value is invalid");
    }
    return input.toISOString();
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return new Date(input).toISOString();
  }
  throw protocolError("enrollment_request_invalid", "Clock value must be a Date or finite epoch milliseconds");
}

function normalizeChannelConfigPayload(input, options, normalizeOptions = { requireAuthenticator: true }) {
  assertPlainObject(input, "channel config payload");
  assertExactKeys(input, [
    "authenticator",
    "bootstrap",
    "channelRevision",
    "connection",
    "expiresAt",
    "issuedAt",
    "kind",
    "protocol",
    "serverId",
    "version"
  ], "channel config payload");
  if (input.kind != null || input.protocol != null || input.version != null) {
    assertProtocolHeader(input, CHANNEL_CONFIG_KIND);
  }
  const issuedAt = input.issuedAt == null
    ? timestampFromClock(options.nowMs ?? Date.now())
    : normalizeTimestamp(input.issuedAt);
  const expiresAt = normalizeTimestamp(input.expiresAt);
  assertValidValidityWindow(issuedAt, expiresAt, "channel config code");
  assertIssuancePolicy(
    issuedAt,
    expiresAt,
    options.nowMs,
    options.maxTtlMs ?? DEFAULT_CHANNEL_MAX_TTL_MS,
    options.issuedAtFutureSkewMs ?? DEFAULT_ISSUED_AT_FUTURE_SKEW_MS,
    "channel config code"
  );
  const bootstrap = normalizeBootstrap(input.bootstrap);
  if (Date.parse(bootstrap.expiresAt) > Date.parse(expiresAt)) {
    throw protocolError("enrollment_request_invalid", "Bootstrap expiry cannot exceed channel config expiry");
  }
  if (Date.parse(bootstrap.expiresAt) <= Date.parse(issuedAt)) {
    throw protocolError("enrollment_request_invalid", "Bootstrap expiry must be later than issuedAt");
  }
  let authenticator = null;
  if (normalizeOptions.requireAuthenticator) {
    authenticator = normalizeChannelAuthenticator(input.authenticator);
  } else if (input.authenticator != null) {
    throw protocolError("enrollment_request_invalid", "Channel config authenticator is generated by the signer");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: CHANNEL_CONFIG_KIND,
    serverId: normalizeServerId(input.serverId),
    channelRevision: normalizeIdentityId(input.channelRevision, "channelRevision"),
    issuedAt,
    expiresAt,
    connection: normalizeConnection(input.connection),
    bootstrap,
    ...(authenticator ? { authenticator } : {})
  };
}

function normalizeOneTimeEnrollmentPayload(input, options) {
  assertPlainObject(input, "one-time enrollment payload");
  assertExactKeys(input, [
    "bindings",
    "channelRevision",
    "deviceId",
    "enrollmentId",
    "expiresAt",
    "issuedAt",
    "kind",
    "protocol",
    "publicKeyFingerprint",
    "requestId",
    "secret",
    "serverId",
    "version"
  ], "one-time enrollment payload");
  if (input.kind != null || input.protocol != null || input.version != null) {
    assertProtocolHeader(input, DEVICE_ENROLLMENT_KIND);
  }
  const issuedAt = input.issuedAt == null
    ? timestampFromClock(options.nowMs ?? Date.now())
    : normalizeTimestamp(input.issuedAt);
  const expiresAt = normalizeTimestamp(input.expiresAt);
  assertValidValidityWindow(issuedAt, expiresAt, "one-time enrollment code");
  assertIssuancePolicy(
    issuedAt,
    expiresAt,
    options.nowMs,
    options.maxTtlMs ?? DEFAULT_ENROLLMENT_MAX_TTL_MS,
    options.issuedAtFutureSkewMs ?? DEFAULT_ISSUED_AT_FUTURE_SKEW_MS,
    "one-time enrollment code"
  );
  const serverId = normalizeServerId(input.serverId);
  const deviceId = normalizeIdentityId(input.deviceId, "deviceId");
  const channelRevision = normalizeIdentityId(input.channelRevision, "channelRevision");
  const secret = requireString(input.secret, "secret");
  const secretBytes = decodeBase64Url(secret, "enrollment secret");
  if (secretBytes.length < MIN_ENROLLMENT_SECRET_BYTES) {
    throw protocolError("enrollment_request_invalid", "Enrollment secret must contain at least 32 random bytes");
  }
  const publicKeyFingerprintValue = requireString(input.publicKeyFingerprint, "publicKeyFingerprint");
  if (!FINGERPRINT_PATTERN.test(publicKeyFingerprintValue)) {
    throw protocolError("enrollment_request_invalid", "Enrollment public key fingerprint is invalid");
  }
  return {
    protocol: ENROLLMENT_PROTOCOL_NAME,
    version: ENROLLMENT_PROTOCOL_VERSION,
    kind: DEVICE_ENROLLMENT_KIND,
    enrollmentId: normalizeIdentityId(input.enrollmentId, "enrollmentId"),
    requestId: normalizeIdentityId(input.requestId, "requestId"),
    serverId,
    deviceId,
    channelRevision,
    publicKeyFingerprint: publicKeyFingerprintValue,
    bindings: normalizeEnrollmentBindings(input.bindings, { serverId, deviceId, channelRevision }),
    issuedAt,
    expiresAt,
    secret
  };
}

function normalizeRootAttestation(input) {
  assertPlainObject(input, "root attestation");
  assertExactKeys(input, ["attestedAt", "referenceId", "source"], "root attestation");
  const source = requireString(input.source, "rootAttestation.source");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(source)) {
    throw protocolError("enrollment_request_invalid", "Root attestation source is invalid");
  }
  return {
    source,
    referenceId: normalizeIdentityId(input.referenceId, "rootAttestation"),
    attestedAt: normalizeTimestamp(input.attestedAt)
  };
}

function normalizeChannelAuthenticator(input) {
  assertPlainObject(input, "channel authenticator");
  assertExactKeys(input, ["keyId", "scheme", "signature"], "channel authenticator");
  if (input.scheme !== CHANNEL_AUTHENTICATOR_SCHEME) {
    throw protocolError("enrollment_code_invalid", "Channel authenticator scheme is unsupported");
  }
  const signature = requireString(input.signature, "authenticator.signature");
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw protocolError("enrollment_code_invalid", "Channel authenticator signature is invalid");
  }
  return {
    scheme: CHANNEL_AUTHENTICATOR_SCHEME,
    keyId: normalizeIdentityId(input.keyId, "signingKeyId"),
    signature
  };
}

function channelConfigUnsignedPayload(payload) {
  const { authenticator: _authenticator, ...unsigned } = payload;
  return unsigned;
}

function assertBootstrapPolicy(endpointInput, pin) {
  const endpoint = new URL(endpointInput);
  const origins = Array.isArray(pin.allowedBootstrapOrigins) ? pin.allowedBootstrapOrigins : [];
  const pathPrefix = typeof pin.bootstrapPathPrefix === "string" ? pin.bootstrapPathPrefix : "";
  const pathPrefixMatches = endpoint.pathname === pathPrefix
    || (pathPrefix.endsWith("/")
      ? endpoint.pathname.startsWith(pathPrefix)
      : endpoint.pathname.startsWith(`${pathPrefix}/`));
  if (
    origins.length === 0 ||
    !origins.includes(endpoint.origin) ||
    !pathPrefix.startsWith("/") ||
    pathPrefix.includes("..") ||
    !pathPrefixMatches
  ) {
    throw protocolError("enrollment_trust_failed", "Bootstrap endpoint is outside the pinned server policy");
  }
}

function normalizeConnection(input) {
  assertPlainObject(input, "channel connection");
  assertExactKeys(input, ["type", "uri"], "channel connection");
  if (input.type !== "vless") {
    throw protocolError("enrollment_request_invalid", "Only vless channel connections are supported");
  }
  const uri = requireString(input.uri, "connection.uri");
  try {
    parseVlessUri(uri);
  } catch {
    throw protocolError("enrollment_request_invalid", "Channel connection contains an invalid VLESS URI");
  }
  return { type: "vless", uri };
}

function normalizeBootstrap(input) {
  assertPlainObject(input, "channel bootstrap");
  assertExactKeys(input, ["endpoint", "expiresAt", "purpose"], "channel bootstrap");
  if (input.purpose !== "identity-enrollment") {
    throw protocolError("enrollment_request_invalid", "Bootstrap purpose must be identity-enrollment");
  }
  let endpoint;
  try {
    endpoint = new URL(requireString(input.endpoint, "bootstrap.endpoint"));
  } catch {
    throw protocolError("enrollment_request_invalid", "Bootstrap endpoint must be a valid URL");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw protocolError("enrollment_request_invalid", "Bootstrap endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw protocolError("enrollment_request_invalid", "Bootstrap endpoint cannot contain credentials, query, or fragment");
  }
  if (
    endpoint.pathname.includes("//") ||
    endpoint.pathname.includes("\\") ||
    /%(?:2f|5c|2e)/i.test(endpoint.pathname)
  ) {
    throw protocolError("enrollment_request_invalid", "Bootstrap endpoint contains an unsafe path segment");
  }
  return {
    endpoint: endpoint.toString(),
    purpose: "identity-enrollment",
    expiresAt: normalizeTimestamp(input.expiresAt)
  };
}

function normalizeHttpMethod(input) {
  const method = requireString(input, "method");
  if (!/^[A-Z]{3,16}$/.test(method)) {
    throw protocolError("enrollment_request_invalid", "HTTP method must be uppercase ASCII");
  }
  return method;
}

function normalizeRequestPath(input) {
  const path = requireString(input, "path");
  if (
    path.length > 2048 ||
    !ASCII_PATH_QUERY_PATTERN.test(path) ||
    path.includes("#") ||
    path.includes("\\") ||
    /%(?![0-9A-Fa-f]{2})/.test(path)
  ) {
    throw protocolError(
      "enrollment_request_invalid",
      "Authorization path must be the exact ASCII origin-form path and query, with no fragment"
    );
  }
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (
    pathname.startsWith("//") ||
    pathname.includes("//") ||
    /%(?:2f|5c|2e)/i.test(pathname)
  ) {
    throw protocolError("enrollment_request_invalid", "Authorization path contains an unsafe encoded or empty segment");
  }
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw protocolError("enrollment_request_invalid", "Authorization path contains invalid percent encoding");
  }
  const segments = decodedPathname.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw protocolError("enrollment_request_invalid", "Authorization path contains a dot or backslash segment");
  }
  return path;
}

function normalizeNonce(input) {
  const nonce = requireString(input, "nonce");
  if (!NONCE_PATTERN.test(nonce)) {
    throw protocolError("enrollment_auth_invalid", "Authorization nonce is invalid");
  }
  return nonce;
}

function normalizeIdentityId(input, kind) {
  const rule = ID_RULES[kind];
  const value = requireString(input, rule[1]);
  const pattern = new RegExp(`^${rule[0]}[A-Za-z0-9_-]{16,128}$`);
  if (!pattern.test(value)) {
    throw protocolError("enrollment_request_invalid", `${rule[1]} has an invalid format`);
  }
  return value;
}

function assertProtocolHeader(input, kind) {
  if (
    input.protocol !== ENROLLMENT_PROTOCOL_NAME ||
    input.version !== ENROLLMENT_PROTOCOL_VERSION ||
    input.kind !== kind
  ) {
    throw protocolError("enrollment_code_invalid", "Enrollment protocol name, version, or code kind is unsupported");
  }
}

function assertValidValidityWindow(issuedAt, expiresAt, label) {
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw protocolError("enrollment_request_invalid", `${label} expiry must be later than issuedAt`);
  }
}

function assertIssuancePolicy(issuedAt, expiresAt, nowMs, maxTtlMs, futureSkewMs, label) {
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) {
    throw protocolError("enrollment_request_invalid", `${label} maximum TTL policy is invalid`);
  }
  if (!Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0) {
    throw protocolError("enrollment_request_invalid", `${label} issuedAt skew policy is invalid`);
  }
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const currentMs = nowMs == null ? Date.now() : nowMs;
  if (!Number.isFinite(currentMs)) {
    throw protocolError("enrollment_request_invalid", `${label} clock is invalid`);
  }
  if (issuedAtMs - currentMs > futureSkewMs) {
    throw protocolError("enrollment_request_invalid", `${label} issuedAt is too far in the future`);
  }
  if (expiresAtMs - issuedAtMs > maxTtlMs) {
    throw protocolError("enrollment_request_invalid", `${label} exceeds the maximum TTL`);
  }
}

function assertNotExpired(expiresAt, nowMs, code, message) {
  if (Date.parse(expiresAt) <= (nowMs ?? Date.now())) {
    throw protocolError(code, message);
  }
}

function encodeEnvelope(prefix, payload) {
  return `${prefix}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeEnvelope(input, options) {
  const raw = requireString(input, options.label);
  let encoded;
  if (raw.startsWith(options.uriPrefix)) {
    encoded = raw.slice(options.uriPrefix.length);
  } else if (raw.startsWith(options.codePrefix)) {
    encoded = raw.slice(options.codePrefix.length);
  } else {
    throw protocolError("enrollment_code_invalid", `${options.label} has an unsupported prefix`);
  }
  const bytes = decodeBase64Url(encoded, `${options.label} payload`);
  try {
    const decoded = JSON.parse(bytes.toString("utf8"));
    assertPlainObject(decoded, `${options.label} payload`);
    return decoded;
  } catch (error) {
    if (error instanceof EnrollmentProtocolError) {
      throw error;
    }
    throw protocolError("enrollment_code_invalid", `${options.label} payload is invalid JSON`);
  }
}

function decodeBase64Url(input, label) {
  const text = requireString(input, label);
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
    throw protocolError("enrollment_code_invalid", `${label} is not valid base64url`);
  }
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) {
    throw protocolError("enrollment_code_invalid", `${label} is not canonical base64url`);
  }
  return bytes;
}

function toByteView(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }
  throw protocolError("enrollment_request_invalid", "bodyBytes must be an exact byte buffer");
}

function toJsonValue(value) {
  if (value === undefined) {
    throw protocolError("enrollment_request_invalid", "Canonical JSON cannot contain undefined values");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw protocolError("enrollment_request_invalid", "Canonical JSON cannot contain non-finite numbers");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw protocolError("enrollment_request_invalid", "Canonical JSON contains an unsupported value");
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = toJsonValue(value[key]);
    }
    return output;
  }
  return value;
}

function stringifyCanonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareEnrollmentBindings(left, right) {
  return left.identity.shareId.localeCompare(right.identity.shareId)
    || left.identity.rootId.localeCompare(right.identity.rootId)
    || left.identity.relationId.localeCompare(right.identity.relationId);
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw protocolError("enrollment_request_invalid", `${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key) && !OPTIONAL_KEYS.has(`${label}.${key}`)) {
      throw protocolError("enrollment_request_invalid", `${label} is missing field: ${key}`);
    }
  }
}

const OPTIONAL_KEYS = new Set([
  "authorization request input.nonce",
  "authorization request input.timestamp",
  "channel config payload.authenticator",
  "channel config payload.issuedAt",
  "channel config payload.kind",
  "channel config payload.protocol",
  "channel config payload.version",
  "one-time enrollment payload.issuedAt",
  "one-time enrollment payload.kind",
  "one-time enrollment payload.protocol",
  "one-time enrollment payload.version"
]);

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw protocolError("enrollment_request_invalid", `${label} must be a plain object`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(input, label) {
  if (typeof input !== "string") {
    throw protocolError("enrollment_request_invalid", `${label} must be a string`);
  }
  const value = input;
  if (!value) {
    throw protocolError("enrollment_request_invalid", `${label} is required`);
  }
  if (value !== value.trim()) {
    throw protocolError("enrollment_request_invalid", `${label} cannot contain surrounding whitespace`);
  }
  return value;
}

function protocolError(code, message) {
  return new EnrollmentProtocolError(code, message);
}
