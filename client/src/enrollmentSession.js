import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import {
  canonicalJson,
  createEnrollmentIdentityId,
  decodeOneTimeEnrollmentCode,
  normalizeEd25519PublicKey,
  normalizeEnrollmentBindings,
  publicKeyFingerprint,
  sha256Bytes,
  signAuthorizationRequest,
  verifyChannelConfigCode
} from "../../src/core/enrollmentProtocol.js";
import { isStableErrorCode } from "../../src/core/errors.js";
import { decodeChannelImportCode } from "../../src/core/channelImportCode.js";
import { verifyDataAuthorizationEnvelope } from "../../src/core/dataAuthorization.js";

const REQUESTS_PATH = "/api/enrollment/v1/requests";
const CONSUME_PATH = "/api/enrollment/v1/consume";
const DATA_AUTHORIZATION_PATH = "/api/enrollment/v1/data-authorization";
const CHANNEL_RENEWAL_PATH = "/api/enrollment/v1/channel-renewal";
const CHANNEL_RENEWAL_WINDOW_MS = 60 * 60 * 1000;
const CHANNEL_RENEWAL_MAX_ATTEMPTS = 3;
const CHANNEL_RENEWAL_RETRYABLE_CODES = new Set(["enrollment_transport_failed", "enrollment_proxy_unavailable"]);

export function createEnrollmentIdentity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    deviceId: createEnrollmentIdentityId("deviceId"),
    privateKey: pair.privateKey.export({ format: "jwk" }),
    publicKey: pair.publicKey.export({ format: "jwk" })
  };
}

export function importEnrollmentChannel(text) {
  const wrapper = decodeChannelImportCode(text);
  const verified = verifyChannelConfigCode(wrapper.channelCode, {
    trustedServerKeys: {
      [wrapper.pin.keyId]: wrapper.pin
    }
  });
  if (verified.payload.serverId !== wrapper.pin.serverId
    || verified.payload.authenticator.keyId !== wrapper.pin.keyId) {
    throw enrollmentError("enrollment_trust_failed", "Channel config does not match the copied server pin");
  }
  const endpoint = new URL(verified.payload.bootstrap.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !wrapper.pin.allowedBootstrapOrigins.includes(endpoint.origin)) {
    throw enrollmentError("enrollment_trust_failed", "Bootstrap endpoint is outside the copied server pin");
  }
  return {
    channel: verified.payload,
    channelCode: wrapper.channelCode,
    pin: wrapper.pin,
    bootstrapEndpoint: endpoint.toString(),
    trust: { status: "verified", serverId: wrapper.pin.serverId, keyId: wrapper.pin.keyId }
  };
}

export function revalidateEnrollmentChannel(serverState) {
  if (!serverState?.channelCode || !serverState?.pin) throw enrollmentError("enrollment_channel_invalid", "Stored enrollment channel is incomplete");
  const verified = verifyChannelConfigCode(serverState.channelCode, {
    trustedServerKeys: { [serverState.pin.keyId]: serverState.pin }
  });
  if (verified.payload.serverId !== serverState.pin.serverId
    || verified.payload.authenticator.keyId !== serverState.pin.keyId
    || canonicalJson(verified.payload) !== canonicalJson(serverState.channel)) {
    throw enrollmentError("enrollment_trust_failed", "Stored enrollment channel no longer matches its trusted signature");
  }
  return verified.payload;
}

export function revalidateEnrollmentChannelForRenewal(serverState) {
  if (!serverState?.channelCode || !serverState?.pin || !serverState?.channel) {
    throw enrollmentError("enrollment_channel_invalid", "Stored enrollment channel is incomplete");
  }
  const issuedAtMs = Date.parse(serverState.channel.issuedAt);
  if (!Number.isFinite(issuedAtMs)) throw enrollmentError("enrollment_trust_failed", "Stored enrollment channel issue time is invalid");
  const verified = verifyChannelConfigCode(serverState.channelCode, {
    nowMs: issuedAtMs,
    trustedServerKeys: { [serverState.pin.keyId]: serverState.pin }
  });
  if (verified.payload.serverId !== serverState.pin.serverId
    || verified.payload.authenticator.keyId !== serverState.pin.keyId
    || canonicalJson(verified.payload) !== canonicalJson(serverState.channel)) {
    throw enrollmentError("enrollment_trust_failed", "Stored enrollment channel no longer matches its trusted signature");
  }
  return verified.payload;
}

export function enrollmentChannelNeedsRenewal(serverState, nowMs = Date.now()) {
  const expiresAt = Math.min(
    Date.parse(serverState?.channel?.expiresAt),
    Date.parse(serverState?.channel?.bootstrap?.expiresAt)
  );
  return Number.isFinite(expiresAt) && expiresAt <= nowMs + CHANNEL_RENEWAL_WINDOW_MS;
}

/** Renew an expiring bootstrap channel using only a consumed, receipt-verified identity. */
export async function renewEnrollmentChannel({ serverState, identity, sendRequest, nowMs } = {}) {
  assertIdentity(identity);
  if (serverState?.request?.status !== "consumed" || !verifyPersistedEnrollmentReceipt(serverState, identity)) {
    throw enrollmentError("enrollment_trust_failed", "A verified enrollment receipt is required for channel renewal");
  }
  const channel = revalidateEnrollmentChannelForRenewal(serverState);
  if (typeof sendRequest !== "function") throw enrollmentError("enrollment_request_invalid", "Channel renewal transport is unavailable");
  const binding = normalizeEnrollmentBindings(serverState.receipt.grant.bindings, {
    serverId: serverState.pin.serverId,
    deviceId: identity.deviceId
  })[0];
  if (!binding) throw enrollmentError("enrollment_binding_mismatch", "The consumed enrollment receipt has no binding for renewal");
  const bodyBytes = Buffer.from(JSON.stringify({ channelRevision: channel.channelRevision }), "utf8");
  for (let attempt = 0; attempt < CHANNEL_RENEWAL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const authorization = signAuthorizationRequest({
        binding,
        bodyBytes,
        method: "POST",
        path: CHANNEL_RENEWAL_PATH,
        ...(nowMs == null ? {} : { timestamp: new Date(nowMs).toISOString() })
      }, createPrivateKey({ key: identity.privateKey, format: "jwk" }));
      const response = await sendRequest(serverState.bootstrapEndpoint, CHANNEL_RENEWAL_PATH, bodyBytes, {
        "X-SFSC-Authorization": Buffer.from(canonicalJson(authorization), "utf8").toString("base64url")
      });
      if (response.status < 200 || response.status >= 300) {
        throw enrollmentError(enrollmentResponseErrorCode(response.body, "enrollment_channel_not_ready"), "Server rejected the channel renewal request");
      }
      const imported = verifyChannelRenewalEnvelope(response.body, serverState.pin, identity, channel.channelRevision);
      return {
        pin: imported.pin,
        channel: imported.channel,
        channelCode: imported.channelCode,
        bootstrapEndpoint: imported.bootstrapEndpoint,
        trustFingerprint: publicKeyFingerprint(imported.pin.publicKey)
      };
    } catch (error) {
      if (!CHANNEL_RENEWAL_RETRYABLE_CODES.has(error?.code) || attempt + 1 >= CHANNEL_RENEWAL_MAX_ATTEMPTS) throw error;
    }
  }
  throw enrollmentError("enrollment_transport_failed", "Could not renew the enrollment channel");
}

function verifyChannelRenewalEnvelope(envelope, pin, identity, requestedRevision) {
  const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
  if (!exact(envelope, ["payload", "signature"]) || typeof envelope.signature !== "string"
    || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) {
    throw enrollmentError("enrollment_trust_failed", "Server channel renewal signature envelope is invalid");
  }
  const payload = envelope.payload;
  if (!exact(payload, ["channelRevision", "deviceId", "keyId", "kind", "protocol", "serverId", "version", "wrappedCode"])
    || payload.protocol !== "sfsc-enrollment" || payload.version !== 1 || payload.kind !== "channel-renewal"
    || payload.serverId !== pin.serverId || payload.keyId !== pin.keyId || payload.deviceId !== identity.deviceId
    || payload.channelRevision !== requestedRevision || typeof payload.wrappedCode !== "string") {
    throw enrollmentError("enrollment_trust_failed", "Server channel renewal response does not match the pinned request");
  }
  let trusted = false;
  try {
    const publicKey = createPublicKey({ key: normalizeEd25519PublicKey(pin.publicKey).jwk, format: "jwk" });
    trusted = verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, Buffer.from(envelope.signature, "base64url"));
  } catch {}
  if (!trusted) throw enrollmentError("enrollment_trust_failed", "Server channel renewal signature is invalid");

  let imported;
  try { imported = importEnrollmentChannel(payload.wrappedCode); }
  catch { throw enrollmentError("enrollment_trust_failed", "Renewed channel code is invalid or expired"); }
  if (canonicalJson(imported.pin) !== canonicalJson(pin)
    || imported.channel.serverId !== payload.serverId
    || imported.channel.authenticator.keyId !== payload.keyId
    || imported.channel.channelRevision !== payload.channelRevision) {
    throw enrollmentError("enrollment_trust_failed", "Renewed channel does not match the pinned renewal response");
  }
  return imported;
}

export async function submitEnrollmentRequest({ channel, identity, requestState, sendRequest }) {
  assertIdentity(identity);
  if (!channel?.channel || !channel.bootstrapEndpoint) throw enrollmentError("enrollment_channel_invalid", "Import a valid channel code first");
  const requestId = requestState?.requestId || createEnrollmentIdentityId("requestId");
  const body = {
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-request",
    requestId,
    deviceId: identity.deviceId,
    channelRevision: channel.channel.channelRevision,
    publicKey: identity.publicKey
  };
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const bodySha256 = sha256Bytes(bytes);
  const proofBytes = Buffer.from(canonicalJson({
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-request-proof",
    method: "POST",
    path: REQUESTS_PATH,
    bodySha256,
    deviceId: identity.deviceId,
    requestId,
    channelRevision: channel.channel.channelRevision
  }), "utf8");
  const privateKey = createPrivateKey({ key: identity.privateKey, format: "jwk" });
  const proof = {
    protocol: "sfsc-enrollment",
    version: 1,
    kind: "enrollment-request-proof",
    bodySha256,
    signature: sign(null, proofBytes, privateKey).toString("base64url")
  };
  const response = await sendRequest(channel.bootstrapEndpoint, REQUESTS_PATH, bytes, {
    "X-SFSC-Enrollment-Request": Buffer.from(canonicalJson(proof), "utf8").toString("base64url")
  });
  if (response.status < 200 || response.status >= 300) {
    throw enrollmentError(enrollmentResponseErrorCode(response.body, "enrollment_request_invalid"), "Server rejected the enrollment request");
  }
  if (response.status !== 202 || response.body?.requestId !== requestId
    || response.body?.deviceId !== identity.deviceId
    || response.body?.status !== "pending"
    || response.body?.publicKeyFingerprint !== publicKeyFingerprint(identity.publicKey)) {
    throw enrollmentError("enrollment_request_invalid", "Server did not confirm this enrollment request");
  }
  return { requestId, deviceId: identity.deviceId, publicKeyFingerprint: publicKeyFingerprint(identity.publicKey), status: "pending" };
}

export async function consumeEnrollmentCode({ channel, identity, requestState, code, sendRequest }) {
  assertIdentity(identity);
  const text = typeof code === "string" ? code.trim() : "";
  if (!text || text.length > 32 * 1024) throw enrollmentError("enrollment_code_invalid", "Enter a valid enrollment code");
  const enrollment = decodeOneTimeEnrollmentCode(text, { expectedServerId: channel.pin.serverId });
  if (enrollment.requestId !== requestState.requestId
    || enrollment.deviceId !== identity.deviceId
    || enrollment.publicKeyFingerprint !== publicKeyFingerprint(identity.publicKey)
    || enrollment.channelRevision !== channel.channel.channelRevision) {
    throw enrollmentError("enrollment_request_mismatch", "Code is not bound to this request, device, key, and channel");
  }
  const bodyBytes = Buffer.from(JSON.stringify({ code: text }), "utf8");
  const authorization = signAuthorizationRequest({
    binding: enrollment.bindings[0],
    bodyBytes,
    method: "POST",
    path: CONSUME_PATH
  }, createPrivateKey({ key: identity.privateKey, format: "jwk" }));
  const response = await sendRequest(channel.bootstrapEndpoint, CONSUME_PATH, bodyBytes, {
    "X-SFSC-Authorization": Buffer.from(canonicalJson(authorization), "utf8").toString("base64url")
  });
  if (response.status < 200 || response.status >= 300) {
    throw enrollmentError(enrollmentResponseErrorCode(response.body, "enrollment_code_invalid"), "Server rejected the enrollment code");
  }
  const receipt = response.body?.receipt;
  validateReceipt(receipt, channel.pin, requestState, identity, enrollment, sha256Bytes(bodyBytes));
  return {
    status: "identity-verified-awaiting-directory-authorization",
    serverId: channel.pin.serverId,
    deviceId: identity.deviceId,
    requestId: requestState.requestId,
    publicKeyFingerprint: publicKeyFingerprint(identity.publicKey),
    receipt
  };
}

export async function requestDataAuthorization({ channel, identity, binding, sendRequest, nowMs } = {}) {
  assertIdentity(identity);
  if (typeof sendRequest !== "function") throw enrollmentError("enrollment_request_invalid", "Data authorization transport is unavailable");
  const trustedBinding = normalizeEnrollmentBindings([binding], {
    serverId: channel?.pin?.serverId,
    deviceId: identity.deviceId
  })[0];
  const bodyBytes = Buffer.from(JSON.stringify({ relationId: trustedBinding.identity.relationId }), "utf8");
  const authorization = signAuthorizationRequest({
    binding: trustedBinding,
    bodyBytes,
    method: "POST",
    path: DATA_AUTHORIZATION_PATH
  }, createPrivateKey({ key: identity.privateKey, format: "jwk" }));
  const response = await sendRequest(channel.bootstrapEndpoint, DATA_AUTHORIZATION_PATH, bodyBytes, {
    "X-SFSC-Authorization": Buffer.from(canonicalJson(authorization), "utf8").toString("base64url")
  });
  if (response.status < 200 || response.status >= 300) {
    throw enrollmentError(enrollmentResponseErrorCode(response.body, "enrollment_relation_denied"), "Server denied the authorized directory request");
  }
  const payload = verifyDataAuthorizationEnvelope(response.body, channel.pin, {
    serverId: channel.pin.serverId,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    publicKeyFingerprint: publicKeyFingerprint(identity.publicKey),
    relationId: trustedBinding.identity.relationId,
    binding: trustedBinding,
    bootstrapUri: channel.channel.connection.uri
  }, { nowMs });
  return { envelope: response.body, payload };
}

function enrollmentResponseErrorCode(body, fallback) {
  const candidates = [
    body?.errorCode,
    typeof body?.error === "string" ? body.error : "",
    body?.error && typeof body.error === "object" ? body.error.code : ""
  ];
  return candidates.find((candidate) => isStableErrorCode(candidate)) || fallback;
}

function validateReceipt(receipt, pin, requestState, identity, enrollment, bodySha256) {
  const expected = ["bodySha256", "grant", "kind", "protocol", "requestId", "signature", "signingKeyId", "version"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).sort().join("\0") !== [...expected].sort().join("\0")
    || receipt.protocol !== "sfsc-enrollment" || receipt.version !== 1
    || receipt.kind !== "enrollment-consumption-receipt"
    || receipt.requestId !== requestState.requestId || receipt.bodySha256 !== bodySha256
    || receipt.signingKeyId !== pin.keyId || typeof receipt.signature !== "string") {
    throw enrollmentError("enrollment_trust_failed", "Server enrollment receipt is invalid");
  }
  const grant = receipt.grant;
  if (!grant || grant.serverId !== pin.serverId || grant.deviceId !== identity.deviceId
    || grant.requestId !== requestState.requestId
    || grant.publicKeyFingerprint !== publicKeyFingerprint(identity.publicKey)) {
    throw enrollmentError("enrollment_binding_mismatch", "Signed enrollment receipt belongs to another request or device");
  }
  let grantBindings;
  try {
    grantBindings = normalizeEnrollmentBindings(grant.bindings, { serverId: pin.serverId, deviceId: identity.deviceId });
  } catch {
    throw enrollmentError("enrollment_binding_mismatch", "Signed enrollment receipt bindings are invalid");
  }
  if (grantBindings.length !== enrollment.bindings.length
    || grantBindings.some((binding) => !enrollment.bindings.some((expected) => canonicalJson(expected) === canonicalJson(binding)))) {
    throw enrollmentError("enrollment_binding_mismatch", "Signed enrollment receipt does not match the administrator code bindings");
  }
  const unsigned = { ...receipt };
  delete unsigned.signature;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(unsigned), "utf8"),
      createPublicKey({ key: normalizeEd25519PublicKey(pin.publicKey).jwk, format: "jwk" }),
      Buffer.from(receipt.signature, "base64url"));
  } catch {}
  if (!valid) throw enrollmentError("enrollment_trust_failed", "Server enrollment receipt signature is invalid");
}

export function verifyPersistedEnrollmentReceipt(serverState, identity) {
  const receipt = serverState?.receipt;
  const requestState = serverState?.request;
  if (!receipt || requestState?.status !== "consumed" || receipt.requestId !== requestState.requestId
    || !/^[a-f0-9]{64}$/.test(receipt.bodySha256 || "")) return false;
  try {
    const unsigned = { ...receipt };
    delete unsigned.signature;
    const valid = verify(null, Buffer.from(canonicalJson(unsigned), "utf8"),
      createPublicKey({ key: normalizeEd25519PublicKey(serverState.pin.publicKey).jwk, format: "jwk" }),
      Buffer.from(receipt.signature, "base64url"));
    if (!valid || receipt.signingKeyId !== serverState.pin.keyId
      || receipt.kind !== "enrollment-consumption-receipt" || receipt.protocol !== "sfsc-enrollment" || receipt.version !== 1) return false;
    const grant = receipt.grant;
    if (grant?.serverId !== serverState.pin.serverId || grant?.deviceId !== identity.deviceId
      || grant?.requestId !== requestState.requestId
      || grant?.publicKeyFingerprint !== publicKeyFingerprint(identity.publicKey)) return false;
    return normalizeEnrollmentBindings(grant.bindings, {
      serverId: serverState.pin.serverId,
      deviceId: identity.deviceId
    }).length > 0;
  } catch { return false; }
}

function assertIdentity(identity) {
  if (!identity || typeof identity.deviceId !== "string" || !identity.privateKey || !identity.publicKey
    || publicKeyFingerprint(identity.privateKey) !== publicKeyFingerprint(identity.publicKey)) {
    throw enrollmentError("enrollment_identity_missing", "Local enrollment identity is missing or corrupt");
  }
}

function enrollmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
