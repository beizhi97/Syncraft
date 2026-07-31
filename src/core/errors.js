const DEFAULT_STATUS_BY_CODE = {
  admin_auth_required: 401,
  binary_version_check_failed: 503,
  bucket_disabled: 409,
  bucket_not_empty: 409,
  bucket_not_found: 404,
  claim_already_used: 409,
  claim_expired: 410,
  claim_not_found: 404,
  claim_redeem_rate_limited: 429,
  claim_redeem_failed: 502,
  client_error: 400,
  client_port_in_use: 409,
  danger_confirmation_required: 400,
  device_disabled: 409,
  device_not_found: 404,
  heartbeat_auth_invalid: 401,
  heartbeat_auth_required: 401,
  heartbeat_rate_limited: 429,
  import_code_required: 400,
  import_code_invalid: 400,
  invalid_json: 400,
  invalid_path: 400,
  invalid_vless_uri: 400,
  local_host_forbidden: 403,
  local_state_corrupt: 409,
  local_read_forbidden: 403,
  local_write_forbidden: 403,
  last_active_bucket_disable_blocked: 409,
  last_bucket_delete_blocked: 409,
  missing_rclone_binary: 503,
  missing_singbox_binary: 503,
  not_found: 404,
  profile_heartbeat_required: 400,
  profile_not_imported: 409,
  profile_storage_required: 400,
  profile_tunnel_required: 400,
  request_body_too_large: 413,
  rclone_config_failed: 500,
  rclone_sync_failed: 500,
  secret_vault_missing: 409,
  secret_vault_unprotected: 503,
  server_error: 500,
  server_state_locked: 409,
  server_singbox_config_write_failed: 500,
  server_state_corrupt: 500,
  server_state_write_failed: 500,
  singbox_start_failed: 500,
  singbox_restart_failed: 502,
  singbox_restart_timeout: 504,
  singbox_restart_unavailable: 503,
  storage_request_failed: 502,
  sync_already_running: 409,
  unsupported_profile_version: 400,
  unsupported_media_type: 415,
  user_not_found: 404,
  validation_failed: 400
};

export const CLAIM_REDEEM_ERROR_CODES = Object.freeze([
  "claim_not_found",
  "claim_already_used",
  "claim_expired",
  "claim_redeem_rate_limited",
  "server_state_write_failed",
  "validation_failed"
]);

const CLAIM_REDEEM_ERROR_CODE_SET = new Set(CLAIM_REDEEM_ERROR_CODES);

const MESSAGE_RULES = [
  {
    code: "request_body_too_large",
    status: 413,
    pattern: /^Request body too large$/i
  },
  {
    code: "invalid_json",
    status: 400,
    pattern: /^Unexpected .*JSON|^Expected .*JSON|^JSON Parse error/i
  },
  {
    code: "local_state_corrupt",
    status: 409,
    pattern: /^Local state file is not valid JSON:/i
  },
  {
    code: "server_state_corrupt",
    status: 500,
    pattern: /^Server state file is not valid JSON:/i
  },
  {
    code: "server_singbox_config_write_failed",
    status: 500,
    pattern: /^Failed to write server sing-box config:/i
  },
  {
    code: "server_state_write_failed",
    status: 500,
    pattern: /^Failed to write server state:/i
  },
  {
    code: "missing_singbox_binary",
    status: 503,
    pattern: /^Missing bundled sing-box:/i
  },
  {
    code: "missing_rclone_binary",
    status: 503,
    pattern: /^Missing bundled rclone:/i
  },
  {
    code: "profile_not_imported",
    status: 409,
    pattern: /^Import a server SyncKey before starting sing-box$/i
  },
  {
    code: "rclone_config_failed",
    status: 500,
    pattern: /^Failed to write rclone remote config:/i
  },
  {
    code: "singbox_start_failed",
    status: 500,
    pattern: /^Failed to start sing-box:/i
  },
  {
    code: "bucket_not_empty",
    status: 409,
    pattern: /^Bucket is not empty/i
  },
  {
    code: "bucket_not_found",
    status: 404,
    pattern: /^Storage bucket not found$/i
  },
  {
    code: "last_bucket_delete_blocked",
    status: 409,
    pattern: /^Cannot delete the last storage bucket$/i
  },
  {
    code: "last_active_bucket_disable_blocked",
    status: 409,
    pattern: /^Cannot disable the last active storage bucket$/i
  },
  {
    code: "bucket_disabled",
    status: 409,
    pattern: /^Storage bucket is disabled$/i
  },
  {
    code: "device_disabled",
    status: 409,
    pattern: /^Device is disabled$/i
  },
  {
    code: "storage_request_failed",
    status: 502,
    pattern: /MinIO|S3|Bucket clear stopped|fetch failed|getaddrinfo|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i
  },
  {
    code: "import_code_required",
    status: 400,
    pattern: /^Import code is required$/i
  },
  {
    code: "unsupported_profile_version",
    status: 400,
    pattern: /version is unsupported/i
  },
  {
    code: "import_code_invalid",
    status: 400,
    pattern: /^(Import code|SyncKey)/i
  },
  {
    code: "profile_tunnel_required",
    status: 400,
    pattern: /^(Profile tunnel\.uri is required|vlessUri is required)$/i
  },
  {
    code: "profile_heartbeat_required",
    status: 400,
    pattern: /^Server-issued profile must include heartbeat credentials$/i
  },
  {
    code: "profile_storage_required",
    status: 400,
    pattern: /^Server-issued profile must include storage credentials$/i
  },
  {
    code: "invalid_vless_uri",
    status: 400,
    pattern: /^(VLESS URI|Invalid VLESS URI|URI must start)/i
  },
  {
    code: "user_not_found",
    status: 404,
    pattern: /^User not found$/i
  },
  {
    code: "validation_failed",
    status: 400,
    pattern: /^(Bandwidth limit|Bucket name|Client name|Remote name|Schedule |Storage prefix|Remote folder|Server folder|S3 endpoint|Profile source server|Public host|Server URL|URL |Invalid URL|REALITY SNI|Port must)/i
  }
];

// Public error messages for codes whose natural message embeds server-side
// internals: absolute state/config paths, the internal MinIO/S3 endpoint, or a
// raw fs/network error string ("getaddrinfo ENOTFOUND minio-internal",
// "connect ECONNREFUSED 172.18.0.5:9000"). The stable code already tells the
// caller what happened and both UIs map codes to their own copy, so the raw
// message adds nothing for callers while handing an attacker a map of the
// internal network and filesystem. The raw detail is not lost — it stays on the
// server-side error chain, and startup failures log it to the operator's own
// stderr rather than the sanitized public message.
// local_state_corrupt is deliberately absent: it names the user's own file over
// a loopback-only API, so sanitizing it would cost the user a useful diagnostic
// without withholding anything from an attacker.
const SANITIZED_MESSAGE_BY_CODE = {
  storage_request_failed: "Storage backend request failed",
  server_state_corrupt: "Server state file is corrupt",
  server_state_write_failed: "Server state could not be written",
  server_singbox_config_write_failed: "sing-box config could not be written",
  server_error: "Internal server error"
};

// Even a sanitized message must not carry a network address if a caller passed an
// explicit publicMessage built from raw error text. Filesystem paths are
// deliberately NOT matched here: client-local errors such as
// missing_rclone_binary legitimately name the user's own file, the local API is
// loopback-only behind a Host allowlist, and server-side path leaks are already
// covered by SANITIZED_MESSAGE_BY_CODE above.
const LEAKY_MESSAGE_PATTERN = /(?:getaddrinfo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET)\b|(?:\d{1,3}\.){3}\d{1,3}/i;

// Errors carrying relayedPublicMessage opt out of the code-to-message map above.
// The map exists to stop *this* process from echoing its own paths and endpoints;
// a message that arrived over the wire from a peer is not this process's internal
// detail, the peer already applied the same sanitizing rules before sending it,
// and INTERFACE_CONTRACT.md requires the client to preserve the server's
// structured errorCode, HTTP status and message when relaying a redeem failure.
// LEAKY_MESSAGE_PATTERN still applies, so a peer that leaks an address anyway is
// reduced to the bare code.

export function createHttpError(code, status = DEFAULT_STATUS_BY_CODE[code] || 400, publicMessage = code) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

export function normalizeHttpError(error, fallbackCode = "server_error") {
  const message = String(error?.message || "");
  const explicitCode = isStableErrorCode(error?.code) ? error.code : "";
  const messageCode = isStableErrorCode(message) ? message : "";
  const rule = explicitCode || messageCode ? null : MESSAGE_RULES.find((item) => item.pattern.test(message));
  const code = explicitCode || messageCode || rule?.code || fallbackCode;
  const status = explicitCode && isHttpErrorStatus(error?.status)
    ? error.status
    : DEFAULT_STATUS_BY_CODE[code] || rule?.status || DEFAULT_STATUS_BY_CODE[fallbackCode] || 400;

  const fallbackMessage = code === "client_error" ? "Client request failed" : "Internal server error";
  const rawMessage = error?.publicMessage
    || (explicitCode || messageCode || rule ? message || code : fallbackMessage);

  return {
    status,
    code,
    message: sanitizePublicMessage(code, rawMessage, Boolean(error?.relayedPublicMessage))
  };
}

// Keeps deployment internals (internal hostnames, container IPs, absolute paths)
// out of responses while preserving the stable code callers actually branch on.
function sanitizePublicMessage(code, rawMessage, relayed = false) {
  const sanitized = relayed ? "" : SANITIZED_MESSAGE_BY_CODE[code];
  if (sanitized) {
    return sanitized;
  }
  const text = String(rawMessage || "");
  if (LEAKY_MESSAGE_PATTERN.test(text)) {
    return code;
  }
  return text;
}

function isHttpErrorStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

export function isClaimRedeemErrorCode(value) {
  return isStableErrorCode(value) && CLAIM_REDEEM_ERROR_CODE_SET.has(String(value || ""));
}

export function isStableErrorCode(value) {
  const code = String(value || "");
  return Object.hasOwn(DEFAULT_STATUS_BY_CODE, code);
}
