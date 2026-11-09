import { createHash, createPublicKey, sign, verify } from "node:crypto";

import {
  canonicalJson,
  DEFAULT_ISSUED_AT_FUTURE_SKEW_MS,
  normalizeEd25519PublicKey,
  normalizeEnrollmentBinding,
  normalizeTimestamp,
  publicKeyFingerprint
} from "./enrollmentProtocol.js";
import { parseVlessUri } from "./vless.js";

export const DATA_AUTHORIZATION_PROTOCOL = "sfsc-data-authorization";
export const DATA_AUTHORIZATION_VERSION = 1;

const PAYLOAD_KEYS = Object.freeze([
  "authorization",
  "binding",
  "deviceId",
  "displayName",
  "expiresAt",
  "issuedAt",
  "keyId",
  "kind",
  "protocol",
  "publicKeyFingerprint",
  "serverHostKey",
  "serverId",
  "sftp",
  "sftpDataChannel",
  "version"
]);
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,128}$/;
const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]{16,128}$/;
const SIGNING_KEY_ID_PATTERN = /^key_[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_KEY_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

export class DataAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DataAuthorizationError";
    this.code = code;
  }
}

/** Normalize the signed payload shared by the enrollment authority and client. */
export function normalizeDataAuthorizationPayload(input) {
  assertPlainObject(input, "data authorization payload");
  assertExactKeys(input, PAYLOAD_KEYS, "data authorization payload");
  if (input.protocol !== DATA_AUTHORIZATION_PROTOCOL
    || input.version !== DATA_AUTHORIZATION_VERSION
    || input.kind !== "data-authorization") {
    throw invalid("Unsupported data authorization protocol header");
  }

  const serverId = requirePattern(input.serverId, SERVER_ID_PATTERN, "serverId");
  const keyId = requirePattern(input.keyId, SIGNING_KEY_ID_PATTERN, "keyId");
  const deviceId = requirePattern(input.deviceId, DEVICE_ID_PATTERN, "deviceId");
  const publicKeyFingerprintValue = requirePattern(
    input.publicKeyFingerprint,
    PUBLIC_KEY_FINGERPRINT_PATTERN,
    "publicKeyFingerprint"
  );

  const binding = normalizeEnrollmentBinding(input.binding);
  if (binding.identity.serverId !== serverId || binding.identity.deviceId !== deviceId) {
    throw mismatch("Data authorization binding does not match its server or device identity");
  }

  const authorization = normalizeAuthorization(input.authorization);
  const displayName = normalizeDisplayName(input.displayName);
  const sftp = normalizeSftp(input.sftp);
  const serverHostKey = normalizeServerHostKey(input.serverHostKey);
  const sftpDataChannel = normalizeSftpDataChannel(input.sftpDataChannel, binding);
  const issuedAt = normalizeTimestamp(input.issuedAt);
  const expiresAt = normalizeTimestamp(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw invalid("Data authorization expiry must be later than issuedAt");
  }

  return {
    protocol: DATA_AUTHORIZATION_PROTOCOL,
    version: DATA_AUTHORIZATION_VERSION,
    kind: "data-authorization",
    serverId,
    keyId,
    deviceId,
    publicKeyFingerprint: publicKeyFingerprintValue,
    binding,
    authorization,
    displayName,
    sftp,
    serverHostKey,
    sftpDataChannel,
    issuedAt,
    expiresAt
  };
}

/** Sign canonical UTF-8 JSON for a normalized data authorization payload. */
export function signDataAuthorizationPayload(payloadInput, privateKey) {
  if (!privateKey) throw invalid("Data authorization signing requires a server signing key");
  const payload = normalizeDataAuthorizationPayload(payloadInput);
  let signature;
  try {
    signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url");
  } catch {
    throw invalid("Unable to sign data authorization payload");
  }
  return { payload, signature };
}

/** Verify the exact response wrapper against the caller-pinned enrollment server key. */
export function verifyDataAuthorizationEnvelope(input, pin, expected = {}, options = {}) {
  assertPlainObject(input, "data authorization envelope");
  assertExactKeys(input, ["payload", "signature"], "data authorization envelope");
  if (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature)) {
    throw invalid("Data authorization signature is invalid");
  }
  const payload = normalizeDataAuthorizationPayload(input.payload);
  if (canonicalJson(payload) !== canonicalJson(input.payload)) {
    throw invalid("Data authorization payload is not in canonical normalized form");
  }
  assertPlainObject(pin, "trusted server pin");
  if (payload.keyId !== pin.keyId || payload.serverId !== pin.serverId) {
    throw trustFailure("Data authorization signer does not match the pinned server");
  }
  assertExpectedIdentity(payload, expected);

  let valid = false;
  try {
    const key = createPublicKey({ key: normalizeEd25519PublicKey(pin.publicKey).jwk, format: "jwk" });
    valid = verify(null, Buffer.from(canonicalJson(input.payload), "utf8"), key, Buffer.from(input.signature, "base64url"));
  } catch {}
  if (!valid) throw trustFailure("Data authorization signature is invalid");

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || Date.parse(payload.expiresAt) <= nowMs) {
    throw trustFailure("Data authorization has expired");
  }
  const futureSkewMs = options.futureSkewMs ?? DEFAULT_ISSUED_AT_FUTURE_SKEW_MS;
  if (!Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0
    || Date.parse(payload.issuedAt) - nowMs > futureSkewMs) {
    throw trustFailure("Data authorization issuedAt is too far in the future");
  }
  if (expected.bootstrapUri) {
    try {
      if (parseVlessUri(expected.bootstrapUri).uuid === parseVlessUri(payload.sftpDataChannel.connection.uri).uuid) {
        throw trustFailure("Data authorization reuses the bootstrap VLESS credential");
      }
    } catch (error) {
      if (error instanceof DataAuthorizationError) throw error;
      throw trustFailure("Unable to compare data and bootstrap VLESS credentials");
    }
  }
  return payload;
}

function normalizeAuthorization(value) {
  assertPlainObject(value, "data authorization permissions");
  assertExactKeys(value, ["allowDelete", "directions"], "data authorization permissions");
  if (value.allowDelete !== true || !Array.isArray(value.directions)
    || value.directions.length !== 1 || value.directions[0] !== "bidirectional") {
    throw invalid("Data authorization permissions are unsupported");
  }
  return { directions: ["bidirectional"], allowDelete: true };
}

function normalizeDisplayName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255
    || value !== value.trim() || value === "." || value === ".."
    || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw invalid("displayName must be a safe directory basename");
  }
  return value;
}

function normalizeSftp(value) {
  assertPlainObject(value, "SFTP endpoint");
  assertExactKeys(value, ["host", "port", "rootPath", "user"], "SFTP endpoint");
  if (value.host !== "127.0.0.1" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.user)
    || value.rootPath !== "/") {
    throw invalid("SFTP endpoint must use the authorized loopback root");
  }
  return { host: value.host, port: value.port, user: value.user, rootPath: "/" };
}

function normalizeServerHostKey(value) {
  assertPlainObject(value, "server host key");
  assertExactKeys(value, ["fingerprint", "publicKey"], "server host key");
  if (typeof value.publicKey !== "string" || value.publicKey.length > 16_384 || value.publicKey !== value.publicKey.trim()) {
    throw invalid("Server host public key is invalid");
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(value.publicKey)) {
    throw invalid("Server host public key must be a single line without control characters");
  }
  const fields = value.publicKey.split(/[\t ]+/);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519") {
    throw invalid("Server host public key must be one OpenSSH ssh-ed25519 key");
  }
  const keyBytes = decodeOpenSshEd25519(fields[1]);
  const fingerprint = `SHA256:${createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "")}`;
  if (typeof value.fingerprint !== "string" || !HOST_KEY_FINGERPRINT_PATTERN.test(value.fingerprint)
    || fingerprint !== value.fingerprint) {
    throw invalid("Server host key fingerprint does not match its public key");
  }
  return { publicKey: `${fields[0]} ${fields[1]}${fields.length > 2 ? ` ${fields.slice(2).join(" ")}` : ""}`, fingerprint };
}

function decodeOpenSshEd25519(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid("OpenSSH host key encoding is invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw invalid("OpenSSH host key encoding is invalid");
  let offset = 0;
  const readField = () => {
    if (offset + 4 > bytes.length) throw invalid("OpenSSH host key is truncated");
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + length > bytes.length) throw invalid("OpenSSH host key is truncated");
    const field = bytes.subarray(offset, offset + length);
    offset += length;
    return field;
  };
  const keyType = readField().toString("ascii");
  const key = readField();
  if (keyType !== "ssh-ed25519" || key.length !== 32 || offset !== bytes.length) throw invalid("OpenSSH host key is not a valid Ed25519 key");
  return bytes;
}

function normalizeSftpDataChannel(value, binding) {
  assertPlainObject(value, "SFTP data channel");
  assertExactKeys(value, ["channelRevision", "connection"], "SFTP data channel");
  if (typeof value.channelRevision !== "string" || !/^chrev_[A-Za-z0-9_-]{16,128}$/.test(value.channelRevision)
    || value.channelRevision === binding.channelRevision) {
    throw invalid("SFTP data channel revision must be distinct from the bootstrap channel");
  }
  assertPlainObject(value.connection, "SFTP data channel connection");
  assertExactKeys(value.connection, ["type", "uri"], "SFTP data channel connection");
  if (value.connection.type !== "vless" || typeof value.connection.uri !== "string") {
    throw invalid("SFTP data channel must contain a VLESS connection");
  }
  const parsed = parseVlessUri(value.connection.uri);
  if (parsed.raw !== value.connection.uri) throw invalid("SFTP data channel URI must be canonical");
  return {
    channelRevision: value.channelRevision,
    connection: { type: "vless", uri: parsed.raw }
  };
}

function assertExpectedIdentity(payload, expected) {
  assertPlainObject(expected, "expected data authorization identity");
  if (expected.serverId != null && payload.serverId !== expected.serverId
    || expected.deviceId != null && payload.deviceId !== expected.deviceId
    || expected.publicKeyFingerprint != null && payload.publicKeyFingerprint !== expected.publicKeyFingerprint
    || expected.relationId != null && payload.binding.identity.relationId !== expected.relationId) {
    throw mismatch("Data authorization belongs to a different identity or relation");
  }
  if (expected.publicKey != null && publicKeyFingerprint(expected.publicKey) !== payload.publicKeyFingerprint) {
    throw mismatch("Data authorization does not match the local device public key");
  }
  if (expected.binding != null && canonicalJson(normalizeEnrollmentBinding(expected.binding)) !== canonicalJson(payload.binding)) {
    throw mismatch("Data authorization does not match the trusted enrollment binding");
  }
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} has missing or unsupported fields`);
  }
}

function invalid(message) { return new DataAuthorizationError("data_authorization_invalid", message); }
function mismatch(message) { return new DataAuthorizationError("data_authorization_mismatch", message); }
function trustFailure(message) { return new DataAuthorizationError("data_authorization_trust_failed", message); }
