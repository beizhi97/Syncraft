import { createHttpError } from "./errors.js";

export const CLAIM_VERSION = 1;
export const CLAIM_CODE_PREFIX = "SFSC1-";
export const CLAIM_URI_PREFIX = "sfsc://import/v1#";
export const CLAIM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CLAIM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
export const LEGACY_CLAIM_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function encodeClaimToken(input, options = {}) {
  const payload = normalizeClaimPayload(input);
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return options.format === "uri" ? `${CLAIM_URI_PREFIX}${encoded}` : `${CLAIM_CODE_PREFIX}${encoded}`;
}

export function decodeClaimToken(input) {
  const raw = String(input || "").trim();
  let encoded;

  if (raw.startsWith(CLAIM_CODE_PREFIX)) {
    encoded = raw.slice(CLAIM_CODE_PREFIX.length);
  } else if (raw.startsWith(CLAIM_URI_PREFIX)) {
    encoded = raw.slice(CLAIM_URI_PREFIX.length);
  } else {
    throw createHttpError("import_code_invalid", 400, "SyncKey must start with SFSC1- or sfsc://import/v1#");
  }

  let decoded;
  try {
    decoded = JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw createHttpError("import_code_invalid", 400, "SyncKey payload is invalid");
  }

  if (decoded.version !== CLAIM_VERSION) {
    throw createHttpError("unsupported_profile_version", 400, "SyncKey version is unsupported");
  }
  if (decoded.type !== "claim") {
    throw createHttpError("import_code_invalid", 400, "SyncKey type must be claim");
  }

  try {
    return normalizeClaimPayload(decoded, { allowLegacyCode: true });
  } catch (error) {
    throw createHttpError("import_code_invalid", 400, error.message);
  }
}

export function normalizeClaimPayload(input = {}, options = {}) {
  const server = normalizeClaimServer(input.server);
  const code = normalizeClaimCode(input.code, options);

  return {
    version: CLAIM_VERSION,
    type: "claim",
    server,
    code
  };
}

export function normalizeClaimCode(input, options = {}) {
  const code = String(input || "").trim().toUpperCase();
  const pattern = options.allowLegacyCode === true
    ? LEGACY_CLAIM_CODE_PATTERN
    : CLAIM_CODE_PATTERN;
  if (!pattern.test(code)) {
    throw new Error("SyncKey short code must look like C7KD-92PQ and use unambiguous uppercase characters");
  }
  return code;
}

export function extractClaimCode(input) {
  const raw = String(input || "").trim();
  if (raw.startsWith(CLAIM_CODE_PREFIX) || raw.startsWith(CLAIM_URI_PREFIX)) {
    return decodeClaimToken(raw).code;
  }
  return normalizeClaimCode(raw, { allowLegacyCode: true });
}

export function normalizeClaimServer(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("SyncKey server must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("SyncKey server must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SyncKey server must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const normalized = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}
