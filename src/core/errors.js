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
  import_code_required: 400,
  import_code_invalid: 400,
  invalid_json: 400,
  invalid_path: 400,
  invalid_vless_uri: 400,
  local_state_corrupt: 409,
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
  const publicMessage = error?.publicMessage
    || (explicitCode || messageCode || rule ? message || code : fallbackMessage);

  return {
    status,
    code,
    message: publicMessage
  };
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
