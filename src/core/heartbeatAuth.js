import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createHttpError } from "./errors.js";

export const HEARTBEAT_AUTH_SCHEME = "sfsc-hmac-sha256-v1";
export const HEARTBEAT_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

export function createHeartbeatSecret() {
  return randomBytes(32).toString("base64url");
}

export function createHeartbeatAuth(payload, secret, options = {}) {
  const auth = {
    scheme: HEARTBEAT_AUTH_SCHEME,
    timestamp: options.timestamp || new Date().toISOString(),
    nonce: options.nonce || randomBytes(12).toString("base64url")
  };
  auth.signature = signHeartbeatPayload(payload, secret, auth);
  return auth;
}

export function verifyHeartbeatAuth(payload, secret, options = {}) {
  const auth = payload?.auth;
  if (!auth || typeof auth !== "object") {
    throw createHttpError("heartbeat_auth_required", 401, "Heartbeat authentication is required");
  }
  if (auth.scheme !== HEARTBEAT_AUTH_SCHEME) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication scheme is invalid");
  }
  if (typeof auth.timestamp !== "string" || !Number.isFinite(new Date(auth.timestamp).getTime())) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication timestamp is invalid");
  }
  if (Math.abs((options.nowMs ?? Date.now()) - new Date(auth.timestamp).getTime()) > (options.maxSkewMs ?? HEARTBEAT_AUTH_MAX_SKEW_MS)) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication timestamp is outside the allowed window");
  }
  if (typeof auth.nonce !== "string" || auth.nonce.length < 8) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication nonce is invalid");
  }
  if (typeof auth.signature !== "string" || !/^[a-f0-9]{64}$/.test(auth.signature)) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication signature is invalid");
  }

  const expected = signHeartbeatPayload(payload, secret, auth);
  const actualBuffer = Buffer.from(auth.signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw createHttpError("heartbeat_auth_invalid", 401, "Heartbeat authentication signature is invalid");
  }
  return true;
}

function signHeartbeatPayload(payload, secret, auth) {
  const bodyHash = createHash("sha256")
    .update(stableStringify(toJsonValue(stripHeartbeatAuth(payload))))
    .digest("hex");
  return createHmac("sha256", String(secret || ""))
    .update([
      HEARTBEAT_AUTH_SCHEME,
      auth.timestamp,
      auth.nonce,
      bodyHash
    ].join("\n"))
    .digest("hex");
}

function stripHeartbeatAuth(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { auth: _auth, ...rest } = payload;
  return rest;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toJsonValue(value) {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}
