import { Buffer } from "node:buffer";
import { normalizeEd25519PublicKey } from "./enrollmentProtocol.js";

export const CHANNEL_IMPORT_CODE_PREFIX = "SFSC-CHANNEL-IMPORT-V1:";
const MAX_IMPORT_CODE_LENGTH = 64 * 1024;
const KEYS = ["channelCode", "kind", "pin", "version"];
const PIN_KEYS = ["allowedBootstrapOrigins", "bootstrapPathPrefix", "keyId", "publicKey", "serverId"];

/**
 * Wraps the existing signed channel config and its separately obtained OOB pin.
 * The wrapper is a copy/paste container, not a signature or trust assertion.
 */
export function encodeChannelImportCode({ channelCode, pin } = {}) {
  const payload = normalizePayload({
    channelCode,
    kind: "sfsc-channel-import",
    pin,
    version: 1
  });
  return `${CHANNEL_IMPORT_CODE_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeChannelImportCode(input) {
  if (typeof input !== "string" || input.length > MAX_IMPORT_CODE_LENGTH) {
    throw new TypeError("Channel import code is invalid");
  }
  const text = input.trim();
  if (!text.startsWith(CHANNEL_IMPORT_CODE_PREFIX)) {
    throw new TypeError("Channel import code prefix is invalid");
  }
  const encoded = text.slice(CHANNEL_IMPORT_CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TypeError("Channel import code encoding is invalid");
  let raw;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("noncanonical");
    raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("invalid utf8");
  } catch {
    throw new TypeError("Channel import code encoding is invalid");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new TypeError("Channel import code JSON is invalid"); }
  return normalizePayload(parsed);
}

function normalizePayload(input) {
  assertExactKeys(input, KEYS, "channel import code");
  if (input.kind !== "sfsc-channel-import" || input.version !== 1) {
    throw new TypeError("Channel import code version is unsupported");
  }
  if (typeof input.channelCode !== "string" || !input.channelCode.trim() || input.channelCode.length > 32 * 1024) {
    throw new TypeError("Channel config code is invalid");
  }
  assertExactKeys(input.pin, PIN_KEYS, "channel trust pin");
  const pin = input.pin;
  if (typeof pin.serverId !== "string" || !/^srv_[A-Za-z0-9_-]{16,128}$/.test(pin.serverId)
    || typeof pin.keyId !== "string" || !/^key_[A-Za-z0-9_-]{16,128}$/.test(pin.keyId)
    || !pin.publicKey
    || !Array.isArray(pin.allowedBootstrapOrigins) || pin.allowedBootstrapOrigins.length < 1
    || pin.allowedBootstrapOrigins.some((origin) => typeof origin !== "string" || new URL(origin).origin !== origin)
    || typeof pin.bootstrapPathPrefix !== "string" || !pin.bootstrapPathPrefix.startsWith("/")) {
    throw new TypeError("Channel trust pin is invalid");
  }
  let publicKey;
  try { publicKey = normalizeEd25519PublicKey(pin.publicKey).jwk; }
  catch { throw new TypeError("Channel trust pin public key is invalid"); }
  return {
    kind: "sfsc-channel-import",
    version: 1,
    channelCode: input.channelCode.trim(),
    pin: {
      serverId: pin.serverId,
      keyId: pin.keyId,
      publicKey,
      allowedBootstrapOrigins: [...new Set(pin.allowedBootstrapOrigins)],
      bootstrapPathPrefix: pin.bootstrapPathPrefix
    }
  };
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${label} fields are invalid`);
  }
}
