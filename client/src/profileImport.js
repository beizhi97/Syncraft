import {
  createHttpError,
  decodeClaimToken,
  decodeImportProfilePayload,
  isClaimRedeemErrorCode,
  normalizeImportProfile,
  parseVlessUri,
  PROFILE_VERSION
} from "../../src/core/index.js";

const DEFAULT_CLAIM_REDEEM_TIMEOUT_MS = Number(process.env.SFSC_CLAIM_REDEEM_TIMEOUT_MS || 15000);

export async function resolveProfileImport(body = {}, options = {}) {
  const importCode = body.code || body.tKey || body.tkey || body.claimCode || body.token;
  if (importCode) {
    const text = String(importCode || "").trim();
    const claim = tryDecodeClaimToken(text);
    if (claim) {
      const profile = validateClaimRedeemProfile(await redeemClaim(claim, options));
      return {
        ...profile,
        importedAt: new Date().toISOString(),
        importMode: "claim-redeem",
        source: {
          type: "claim",
          server: claim.server
        }
      };
    }

    const decodedProfile = decodeImportProfilePayload(text);
    return {
      ...validateOfflineProfile(decodedProfile),
      importedAt: new Date().toISOString(),
      importMode: "offline-profile"
    };
  }

  if (body.uri) {
    return buildLegacyVlessProfile(body);
  }

  throw createHttpError("import_code_required", 400, "Import code is required");
}

function validateClaimRedeemProfile(profile) {
  try {
    validateClaimRedeemStorage(profile);
    const normalized = normalizeImportProfile(profile);
    if (normalized.heartbeat?.scheme !== "sfsc-hmac-sha256-v1" || !normalized.heartbeat?.secret) {
      throw createHttpError("profile_heartbeat_required", 400, "Server-issued profile must include heartbeat credentials");
    }
    return normalized;
  } catch (error) {
    error.claimRedeemRemoteResponse = true;
    throw error;
  }
}

function validateClaimRedeemStorage(profile) {
  const storage = profile?.storage;
  const requiredFields = ["remoteName", "endpoint", "bucket", "accessKeyId", "secretAccessKey", "prefix"];
  if (!storage || typeof storage !== "object") {
    throw createHttpError("profile_storage_required", 400, "Server-issued profile must include storage credentials");
  }
  for (const field of requiredFields) {
    if (!String(storage[field] || "").trim()) {
      throw createHttpError("profile_storage_required", 400, "Server-issued profile must include storage credentials");
    }
  }
}

function validateOfflineProfile(profile) {
  if (isServerIssuedOfflineProfile(profile)) {
    validateClaimRedeemStorage(profile);
    const normalized = normalizeImportProfile(profile);
    if (normalized.heartbeat?.scheme !== "sfsc-hmac-sha256-v1" || !normalized.heartbeat?.secret) {
      throw createHttpError("profile_heartbeat_required", 400, "Server-issued offline profile must include heartbeat credentials");
    }
    return normalized;
  }
  return normalizeImportProfile(profile);
}

function isServerIssuedOfflineProfile(profile) {
  return Boolean(profile?.source && typeof profile.source === "object" && String(profile.source.server || "").trim());
}

function tryDecodeClaimToken(text) {
  try {
    return decodeClaimToken(text);
  } catch {
    return null;
  }
}

async function redeemClaim(claim, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("This runtime cannot redeem SyncKey because fetch is unavailable");
  }

  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_CLAIM_REDEEM_TIMEOUT_MS);
  const controller = typeof AbortController === "function" && timeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  try {
    const redeemBody = { code: claim.code };
    if (options.clientRedeemId) {
      redeemBody.clientRedeemId = String(options.clientRedeemId);
    }
    if (options.clientInstallId) {
      redeemBody.clientInstallId = String(options.clientInstallId);
    }
    response = await fetchImpl(`${claim.server}/api/claims/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(redeemBody),
      signal: controller?.signal
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    throw createHttpError(
      "claim_redeem_failed",
      502,
      timedOut
        ? `SyncKey redemption request timed out after ${timeoutMs}ms`
        : `SyncKey redemption request failed: ${error?.message || "network error"}`
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = normalizeClaimRedeemErrorCode(payload);
    const error = createHttpError(
      code,
      response.status || 502,
      payload?.message || payload?.errorCode || payload?.error || `SyncKey redemption failed with HTTP ${response.status}`
    );
    error.claimRedeemRemoteResponse = true;
    // The message came from the remote server, which already sanitized it. Marking
    // it as relayed stops the local error normalizer from replacing it with its own
    // generic copy, which INTERFACE_CONTRACT.md forbids: a redeem failure must
    // preserve the server's errorCode, HTTP status and message.
    error.relayedPublicMessage = true;
    throw error;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createClaimRedeemProtocolError("SyncKey redemption response was not valid JSON");
  }
  if (payload.ok === false) {
    throw createClaimRedeemProtocolError(payload.message || payload.errorCode || payload.error || "SyncKey redemption returned an error envelope with HTTP 2xx");
  }
  const hasWrappedProfile = Object.hasOwn(payload, "profile");
  const profile = hasWrappedProfile ? payload.profile : payload;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw createClaimRedeemProtocolError("SyncKey redemption response did not include a profile object");
  }
  if (!hasWrappedProfile && !looksLikeBareProfile(profile)) {
    throw createClaimRedeemProtocolError("SyncKey redemption response did not include a profile object");
  }
  return profile;
}

function createClaimRedeemProtocolError(message) {
  const error = createHttpError("claim_redeem_failed", 502, message);
  error.claimRedeemRemoteResponse = true;
  return error;
}

function looksLikeBareProfile(value) {
  return [
    "tunnel",
    "storage",
    "heartbeat",
    "uri",
    "vlessUri"
  ].some((field) => Object.hasOwn(value, field));
}

function normalizeClaimRedeemErrorCode(payload) {
  for (const value of [payload?.errorCode, payload?.error]) {
    const code = String(value || "");
    if (isClaimRedeemErrorCode(code)) {
      return code;
    }
  }
  return "claim_redeem_failed";
}

function buildLegacyVlessProfile(body = {}) {
  const parsed = parseVlessUri(body.uri);
  const clientName = body.clientName || parsed.name || "company-pc1";
  return {
    version: PROFILE_VERSION,
    profileId: `legacy-${parsed.name || "vless"}`,
    clientName,
    uri: body.uri,
    parsed,
    tunnel: {
      type: "vless",
      uri: body.uri,
      parsed
    },
    storage: {
      type: "s3",
      remoteName: "home-minio",
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: clientName,
      secretAccessKey: "CHANGE_ME_CLIENT_SECRET",
      prefix: `devices/${clientName}`
    },
    defaults: {
      localProxyPort: Number(body.options?.localProxyPort || 18081),
      transfers: 4,
      streams: 8,
      checkers: 8,
      chunkSize: "16M",
      retries: 3,
      lowLevelRetries: 10,
      bandwidthLimit: "off",
      schedule: { mode: "manual" }
    },
    importedAt: new Date().toISOString(),
    importMode: "legacy-vless-uri"
  };
}
