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
  connection_repair_busy: 409,
  connection_repair_cleanup_failed: 500,
  connection_repair_invalid: 400,
  connection_repair_list_failed: 502,
  connection_repair_probe_conflict: 409,
  connection_repair_read_failed: 502,
  connection_repair_write_failed: 502,
  danger_confirmation_required: 400,
  data_authorization_invalid: 400,
  data_authorization_mismatch: 403,
  data_authorization_trust_failed: 401,
  directory_root_input_invalid: 400,
  directory_root_io_failed: 500,
  directory_root_link_denied: 403,
  directory_root_marker_collision: 409,
  directory_root_marker_mismatch: 409,
  directory_root_marker_missing: 409,
  directory_root_missing: 404,
  directory_root_mount_changed: 409,
  directory_root_mount_unavailable: 503,
  directory_root_not_ready: 503,
  directory_root_overlap: 409,
  directory_root_permission_denied: 403,
  directory_root_record_invalid: 500,
  directory_root_registration_incomplete: 503,
  directory_root_registration_review_required: 409,
  directory_root_replaced: 409,
  directory_root_space_insufficient: 409,
  directory_root_space_unavailable: 503,
  device_disabled: 409,
  device_not_found: 404,
  enrollment_auth_invalid: 401,
  enrollment_auth_capacity: 429,
  enrollment_auth_expired: 401,
  enrollment_auth_replayed: 409,
  enrollment_binding_mismatch: 403,
  enrollment_catalog_not_ready: 503,
  enrollment_channel_mismatch: 409,
  enrollment_channel_invalid: 409,
  enrollment_channel_not_ready: 503,
  enrollment_channel_stale: 409,
  enrollment_channel_expired: 410,
  enrollment_code_expired: 410,
  enrollment_code_invalid: 400,
  enrollment_code_used: 409,
  enrollment_device_revoked: 403,
  enrollment_data_authorization_denied: 403,
  enrollment_data_channel_not_ready: 503,
  enrollment_data_relation_not_ready: 503,
  enrollment_data_relation_start_failed: 503,
  enrollment_identity_conflict: 409,
  enrollment_identity_missing: 409,
  enrollment_public_key_mismatch: 403,
  enrollment_relation_conflict: 409,
  enrollment_relation_denied: 403,
  enrollment_relation_revoked: 409,
  enrollment_request_exists: 409,
  enrollment_request_invalid: 400,
  enrollment_request_mismatch: 403,
  enrollment_request_not_found: 404,
  enrollment_reconfigure_busy: 409,
  enrollment_reconfigure_conflict: 409,
  enrollment_reconfigure_invalid: 400,
  enrollment_reconfigure_needs_repair: 503,
  enrollment_reconfigure_not_found: 404,
  enrollment_reconfigure_state_invalid: 500,
  enrollment_reconfigure_write_failed: 500,
  enrollment_revocation_identity_conflict: 409,
  enrollment_revocation_incomplete: 503,
  enrollment_revocation_invalid: 400,
  enrollment_revocation_operation_conflict: 409,
  enrollment_revocation_operation_not_found: 404,
  enrollment_revocation_not_ready: 503,
  enrollment_revocation_overlay_not_applied: 503,
  enrollment_revocation_recovery_pending: 503,
  enrollment_signer_invalid: 500,
  enrollment_state_invalid: 500,
  enrollment_state_conflict: 409,
  enrollment_trust_failed: 401,
  enrollment_trust_verifier_required: 500,
  enrollment_endpoint_invalid: 400,
  enrollment_proxy_unavailable: 503,
  enrollment_transport_failed: 502,
  enrollment_response_invalid: 502,
  first_sync_conflict_command_failed: 502,
  first_sync_conflict_preview_expired: 410,
  first_sync_conflict_preview_required: 409,
  first_sync_conflict_review_required: 409,
  first_sync_conflict_save_required: 409,
  first_sync_conflict_scan_failed: 502,
  first_sync_conflict_set_changed: 409,
  first_sync_conflict_source_changed: 409,
  first_sync_conflict_stage_invalid: 409,
  first_sync_conflict_staging_invalid: 500,
  first_sync_conflict_target_exists: 409,
  first_sync_conflict_target_invalid: 409,
  first_sync_conflict_trusted_relation_required: 409,
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
  sftp_access_marker_conflict: 409,
  sftp_access_marker_invalid: 400,
  sftp_access_marker_missing: 400,
  sftp_access_marker_write_failed: 500,
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
  sync_relation_migration_required: 409,
  sync_recovery_preflight_failed: 500,
  sync_recovery_restore_hash_mismatch: 409,
  sync_recovery_restore_preview_expired: 410,
  sync_recovery_restore_preview_required: 409,
  sync_recovery_restore_staging_invalid: 500,
  sync_recovery_restore_target_exists: 409,
  sync_recovery_restore_target_invalid: 400,
  sync_recovery_review_required: 409,
  sync_recovery_trusted_relation_required: 409,
  sync_recovery_version_not_found: 404,
  // 这四个同步空间码此前只存在于 serverAdmin.js，未注册到本表。
  // 后果是 normalizeHttpError 认不出它们，403/409 全被压平成 500「Internal server error」，
  // 控制台无法分支。已由 tests/sync-space-mode.test.js 锁住。
  sync_id_unavailable: 409,
  sync_space_access_denied: 403,
  sync_space_membership_exists: 409,
  sync_space_role_not_allowed: 409,
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
  connection_repair_busy: "A sync or another connection repair is in progress",
  connection_repair_cleanup_failed: "The repair probe was not confirmed clean; repair is incomplete",
  connection_repair_invalid: "Connection repair request is invalid",
  connection_repair_list_failed: "Could not inspect the connection repair target",
  connection_repair_probe_conflict: "The probe path could not be verified as belonging to this repair; no changes were made",
  connection_repair_read_failed: "Could not read the connection repair target",
  connection_repair_write_failed: "Could not update the connection repair target",
  enrollment_reconfigure_busy: "A tunnel or overlay change is already in progress",
  enrollment_reconfigure_conflict: "This operation ID was already used with different inputs",
  enrollment_reconfigure_invalid: "Tunnel reconfiguration request is invalid",
  enrollment_reconfigure_needs_repair: "Tunnel reconfiguration needs operator repair; no channel code was issued",
  enrollment_reconfigure_not_found: "Tunnel reconfiguration operation was not found",
  enrollment_reconfigure_state_invalid: "Tunnel reconfiguration journal is invalid",
  enrollment_reconfigure_write_failed: "Tunnel reconfiguration could not be saved",
  enrollment_revocation_identity_conflict: "The relation identity changed after revocation began",
  enrollment_revocation_incomplete: "Enrollment revocation is still pending",
  enrollment_revocation_invalid: "Enrollment revocation request is invalid",
  enrollment_revocation_operation_conflict: "This operation ID is already bound to another revocation target",
  enrollment_revocation_operation_not_found: "Enrollment revocation operation was not found",
  enrollment_revocation_not_ready: "The relation service or enrollment catalog is not ready for revocation",
  enrollment_revocation_overlay_not_applied: "The revoked data overlay has not been confirmed as applied",
  enrollment_revocation_recovery_pending: "Enrollment revocation recovery must finish before data authorization can continue",
  sftp_access_marker_conflict: "本机或远端 SFTP 访问标记与当前授权根目录冲突，拒绝覆盖。",
  sftp_access_marker_invalid: "SFTP 访问标记输入无效，或缺少已验证的根目录标识。",
  sftp_access_marker_missing: "已初始化关系的本机或远端 SFTP 访问标记缺失，拒绝重建或继续。",
  sftp_access_marker_write_failed: "无法确认 SFTP 访问标记写入结果；请核对本机或远端目录后重试。",
  enrollment_data_relation_start_failed: "The server could not start its protected directory service. Ask an administrator to check protection capabilities and retry.",
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
