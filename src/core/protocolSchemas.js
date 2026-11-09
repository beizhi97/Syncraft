import { createHttpError } from "./errors.js";
import { requireSyncSpaceMode } from "./syncSpaceMode.js";

export const PROTOCOL_REQUESTS = Object.freeze({
  CLIENT_BINARIES_CHECK: "client.binariesCheck",
  CLIENT_CONNECTION_REPAIR: "client.connectionRepair",
  CLIENT_ENROLLMENT_CHANNEL_IMPORT: "client.enrollmentChannelImport",
  CLIENT_ENROLLMENT_DATA_AUTHORIZATIONS_REFRESH: "client.enrollmentDataAuthorizationsRefresh",
  CLIENT_ENROLLMENT_REQUEST: "client.enrollmentRequest",
  CLIENT_ENROLLMENT_CONSUME: "client.enrollmentConsume",
  CLIENT_JOB_SAVE: "client.jobSave",
  CLIENT_PROFILE_IMPORT: "client.profileImport",
  CLIENT_SHUTDOWN: "client.shutdown",
  CLIENT_SINGBOX_START: "client.singboxStart",
  CLIENT_SINGBOX_STOP: "client.singboxStop",
  CLIENT_SYNC_BISYNC_INITIALIZE: "client.syncBisyncInitialize",
  CLIENT_SYNC_BISYNC_CONFLICT_PREVIEW: "client.syncBisyncConflictPreview",
  CLIENT_SYNC_BISYNC_CONFLICT_SAVE: "client.syncBisyncConflictSave",
  CLIENT_SYNC_BISYNC_CONFLICT_OPERATIONS: "client.syncBisyncConflictOperations",
  CLIENT_SYNC_BISYNC_CONFLICT_RESUME: "client.syncBisyncConflictResume",
  CLIENT_SYNC_RECOVERY_RESTORE_PREVIEW: "client.syncRecoveryRestorePreview",
  CLIENT_SYNC_RECOVERY_RESTORE: "client.syncRecoveryRestore",
  CLIENT_SYNC_RECOVERY_RESTORE_CANCEL: "client.syncRecoveryRestoreCancel",
  CLIENT_SYNC_SAFETY_PLAN: "client.syncSafetyPlan",
  CLIENT_SYNC_PREVIEW: "client.syncPreview",
  CLIENT_SYNC_RUN: "client.syncRun",
  CLIENT_SYNC_STOP: "client.syncStop",
  SERVER_ADMIN_STORAGE_BUCKET_CLEAR: "server.admin.storageBucketClear",
  SERVER_ADMIN_STORAGE_BUCKET_CREATE: "server.admin.storageBucketCreate",
  SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY: "server.admin.storageBucketDeleteEmpty",
  SERVER_ADMIN_STORAGE_BUCKET_DISABLE: "server.admin.storageBucketDisable",
  SERVER_ADMIN_STORAGE_BUCKET_ENABLE: "server.admin.storageBucketEnable",
  SERVER_ADMIN_STORAGE_BUCKET_REFRESH: "server.admin.storageBucketRefresh",
  SERVER_ADMIN_ENROLLMENT_DIRECTORY_REGISTER: "server.admin.enrollmentDirectoryRegister",
  SERVER_ADMIN_ENROLLMENT_CHANNEL_CODE: "server.admin.enrollmentChannelCode",
  SERVER_ADMIN_ENROLLMENT_RECONFIGURE: "server.admin.enrollmentReconfigure",
  SERVER_ADMIN_ENROLLMENT_REVOKE: "server.admin.enrollmentRevoke",
  SERVER_ADMIN_ENROLLMENT_ISSUE: "server.admin.enrollmentIssue",
  SERVER_ADMIN_STORAGE_SAVE: "server.admin.storageSave",
  SERVER_ADMIN_SYNC_SPACE_CREATE: "server.admin.syncSpaceCreate",
  SERVER_ADMIN_SINGBOX_APPLY: "server.admin.singboxApply",
  SERVER_ADMIN_SINGBOX_MARK_APPLIED: "server.admin.singboxMarkApplied",
  SERVER_ADMIN_SINGBOX_WRITE: "server.admin.singboxWrite",
  SERVER_ADMIN_TUNNEL_AUTOFILL: "server.admin.tunnelAutofill",
  SERVER_ADMIN_TUNNEL_GENERATE: "server.admin.tunnelGenerate",
  SERVER_ADMIN_USER_CREATE: "server.admin.userCreate",
  SERVER_ADMIN_USER_DELETE: "server.admin.userDelete",
  SERVER_ADMIN_USER_DISABLE: "server.admin.userDisable",
  SERVER_ADMIN_USER_ENABLE: "server.admin.userEnable",
  SERVER_CLAIM_CREATE: "server.claimCreate",
  SERVER_CLAIM_REDEEM: "server.claimRedeem",
  SERVER_DEVICE_HEARTBEAT: "server.deviceHeartbeat",
  SERVER_JOBS_PREVIEW: "server.jobsPreview",
  SERVER_PROFILE_ENCODE: "server.profileEncode",
  SERVER_SINGBOX_CLIENT_CONFIG: "server.singboxClientConfig",
  SERVER_VLESS_PARSE: "server.vlessParse"
});

const CLAIM_REDEEM_FIELDS = ["code", "tKey", "tkey", "claimCode", "token"];
const HEARTBEAT_LEGACY_SYNC_FIELDS = [
  "bytesPerSecond",
  "conflicts",
  "currentFile",
  "currentFileProgressPercent",
  "currentFileSizeText",
  "currentJob",
  "eta",
  "finishedAt",
  "historyRunId",
  "lastExit",
  "lastRun",
  "lastSyncAt",
  "progressPercent",
  "rawSpeed",
  "scheduler",
  "speedMbps",
  "startedAt",
  "syncState",
  "totalBytes",
  "totalObjects",
  "transferredBytes",
  "transferredObjects",
  "transferredSizeText",
  "transferredText"
];
const CLIENT_JOB_STRING_FIELDS = [
  "id",
  "name",
  "localPath",
  "direction",
  "remoteFolder",
  "serverSpace",
  "s3ChunkSize",
  "chunkSize",
  "cutoff",
  "bandwidthLimit",
  "clientName",
  "relationId",
  "remoteName",
  "rootPath",
  "storageBackend"
];
const CLIENT_JOB_JSON_FIELDS = [
  "localProxyPort",
  "transfers",
  "streams",
  "checkers",
  "s3UploadConcurrency",
  "retries",
  "lowLevelRetries"
];
const CLIENT_JOB_BOOLEAN_FIELDS = [
  "dryRun",
  "destructiveSync"
];
const SERVER_JOBS_PREVIEW_OPTIONS_STRING_FIELDS = [
  "rcloneBin",
  "rcloneConfigPath"
];
const SERVER_JOBS_PREVIEW_OPTIONS_JSON_FIELDS = [
  "localProxyPort"
];
const SERVER_JOBS_PREVIEW_JOB_STRING_FIELDS = [
  "accessKeyId",
  "bandwidthLimit",
  "bucket",
  "bucketName",
  "chunkSize",
  "clientName",
  "cutoff",
  "direction",
  "endpoint",
  "id",
  "localPath",
  "name",
  "region",
  "remoteFolder",
  "remoteName",
  "remotePath",
  "remotePrefix",
  "s3AccessKeyId",
  "s3ChunkSize",
  "s3Endpoint",
  "s3Region",
  "s3SecretAccessKey",
  "secretAccessKey",
  "serverSpace",
  "serverSubdir",
  "storageBackend"
];
const SERVER_JOBS_PREVIEW_JOB_JSON_FIELDS = [
  "checkers",
  "lowLevelRetries",
  "retries",
  "s3UploadConcurrency",
  "streams",
  "transfers"
];
const SERVER_JOBS_PREVIEW_JOB_BOOLEAN_FIELDS = [
  "destructiveSync",
  "dryRun"
];
const SERVER_SINGBOX_CLIENT_CONFIG_OPTIONS_JSON_FIELDS = [
  "localProxyPort"
];
// Nested-object whitelists (CORE-3). Envelope-level nested objects must be
// field-whitelisted here so unknown nested fields are dropped at the schema
// boundary, per docs/INTERFACE_CONTRACT.md. Device heartbeat payloads are the
// deliberate exception (see parseServerDeviceHeartbeatRequest).
const SCHEDULE_OBJECT_FIELDS = ["mode", "intervalMinutes", "time"];
const REALITY_OBJECT_FIELDS = ["serverName", "fingerprint", "publicKey", "privateKey", "shortId"];
const PROFILE_ENCODE_HEARTBEAT_FIELDS = ["scheme", "secret"];
const PROFILE_DEFAULTS_SCALAR_FIELDS = [
  "localProxyPort",
  "transfers",
  "streams",
  "checkers",
  "chunkSize",
  "retries",
  "lowLevelRetries"
];
const BANDWIDTH_LIMIT_OBJECT_FIELDS = ["enabled", "mode", "value", "unit", "startTime", "endTime"];
const CLIENT_JOB_SAFETY_SCALAR_FIELDS = ["version", "recoveryRetentionDays"];
const CLIENT_JOB_SAFETY_DELETE_LIMIT_FIELDS = ["maxFiles", "maxPercent"];
const CLIENT_JOB_SAFETY_BIDIRECTIONAL_FIELDS = ["initialized", "initialMode"];

export function parseProtocolRequest(name, body = {}) {
  switch (name) {
    case PROTOCOL_REQUESTS.CLIENT_BINARIES_CHECK:
      return parseEmptyObjectRequest(body, "client binaries check request");
    case PROTOCOL_REQUESTS.CLIENT_CONNECTION_REPAIR:
      return parseClientConnectionRepairRequest(body);
    case PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CHANNEL_IMPORT:
      return parseClientEnrollmentCodeRequest(body, "client enrollment channel import request");
    case PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_REQUEST:
      return parseEmptyObjectRequest(body, "client enrollment request");
    case PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_DATA_AUTHORIZATIONS_REFRESH:
      return parseEmptyObjectRequest(body, "client enrollment data authorizations refresh request");
    case PROTOCOL_REQUESTS.CLIENT_ENROLLMENT_CONSUME:
      return parseClientEnrollmentCodeRequest(body, "client enrollment code consumption request");
    case PROTOCOL_REQUESTS.CLIENT_SHUTDOWN:
      return parseEmptyObjectRequest(body, "client shutdown request");
    case PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT:
      return parseClientProfileImportRequest(body);
    case PROTOCOL_REQUESTS.CLIENT_JOB_SAVE:
      return parseClientJobRequest(body, { label: "client job save request" });
    case PROTOCOL_REQUESTS.CLIENT_SINGBOX_START:
      return parseClientSingboxStartRequest(body);
    case PROTOCOL_REQUESTS.CLIENT_SINGBOX_STOP:
      return parseEmptyObjectRequest(body, "client sing-box stop request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_PREVIEW:
      return parseClientJobRequest(body, { label: "client sync preview request", allowConfirmations: false });
    case PROTOCOL_REQUESTS.CLIENT_SYNC_SAFETY_PLAN:
      return parseClientJobRequest(body, { label: "client sync safety plan request", allowConfirmations: false });
    case PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_INITIALIZE:
      return parseClientJobRequest(body, {
        label: "client bisync initialize request",
        allowSafetyPlanId: true,
        allowBisyncInitializationConfirmation: true,
        allowFirstConflictOperationId: true
      });
    case PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_PREVIEW:
      return parseStrictClientJobRequest(body, ["job"], "client bisync conflict preview request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_SAVE:
      return parseStrictClientJobRequest(body, ["job", "previewId"], "client bisync conflict save request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_OPERATIONS:
      return parseStrictClientJobRequest(body, ["job"], "client bisync conflict operations request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_BISYNC_CONFLICT_RESUME:
      return parseStrictClientJobRequest(body, ["job", "operationId"], "client bisync conflict resume request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE_PREVIEW:
      return parseStrictSyncRecoveryRestorePreviewRequest(body);
    case PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE:
      return parseStrictSyncRecoveryPreviewIdRequest(body, "client sync recovery restore request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_RECOVERY_RESTORE_CANCEL:
      return parseStrictSyncRecoveryPreviewIdRequest(body, "client sync recovery restore cancel request");
    case PROTOCOL_REQUESTS.CLIENT_SYNC_RUN:
      return parseClientJobRequest(body, { label: "client sync run request", allowSafetyPlanId: true });
    case PROTOCOL_REQUESTS.CLIENT_SYNC_STOP:
      return parseEmptyObjectRequest(body, "client sync stop request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_SAVE:
      return parseServerAdminStorageSaveRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_SYNC_SPACE_CREATE:
      return parseServerAdminSyncSpaceCreateRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CREATE:
      return parseServerAdminStorageBucketCreateRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_REFRESH:
      return parseEmptyObjectRequest(body, "admin storage bucket refresh request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_DIRECTORY_REGISTER:
      return parseServerAdminEnrollmentDirectoryRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_CHANNEL_CODE:
      return parseEmptyObjectRequest(body, "admin enrollment channel-code request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_RECONFIGURE:
      return parseServerAdminEnrollmentReconfigureRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_REVOKE:
      return parseServerAdminEnrollmentRevokeRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_ENROLLMENT_ISSUE:
      return parseServerAdminEnrollmentIssueRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_ENABLE:
      return parseServerAdminStorageBucketToggleRequest(body, "admin storage bucket enable request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DISABLE:
      return parseServerAdminStorageBucketToggleRequest(body, "admin storage bucket disable request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CLEAR:
      return parseServerAdminStorageBucketDangerRequest(body, "admin storage bucket clear request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY:
      return parseServerAdminStorageBucketDangerRequest(body, "admin storage bucket delete-empty request");
    case PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE:
      return parseServerAdminTunnelGenerateRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_AUTOFILL:
      return parseServerAdminTunnelAutofillRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_WRITE:
      return parseServerAdminSingboxWriteRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_APPLY:
      return parseServerAdminSingboxApplyRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_MARK_APPLIED:
      return parseServerAdminSingboxMarkAppliedRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_USER_CREATE:
      return parseServerAdminUserCreateRequest(body);
    case PROTOCOL_REQUESTS.SERVER_ADMIN_USER_ENABLE:
      return parseServerAdminUserToggleRequest(body, {
        label: "admin user enable request",
        allowCompatibilityConfirmation: true
      });
    case PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DISABLE:
      return parseServerAdminUserToggleRequest(body, { label: "admin user disable request" });
    case PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DELETE:
      return parseServerAdminUserDeleteRequest(body);
    case PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE:
      return parseServerClaimCreateRequest(body);
    case PROTOCOL_REQUESTS.SERVER_CLAIM_REDEEM:
      return parseServerClaimRedeemRequest(body);
    case PROTOCOL_REQUESTS.SERVER_DEVICE_HEARTBEAT:
      return parseServerDeviceHeartbeatRequest(body);
    case PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW:
      return parseServerJobsPreviewRequest(body);
    case PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE:
      return parseServerProfileEncodeRequest(body);
    case PROTOCOL_REQUESTS.SERVER_VLESS_PARSE:
      return parseServerVlessParseRequest(body);
    case PROTOCOL_REQUESTS.SERVER_SINGBOX_CLIENT_CONFIG:
      return parseServerSingboxClientConfigRequest(body);
    default:
      throw createHttpError("validation_failed", 400, `Unknown protocol request schema: ${name}`);
  }
}

function parseStrictSyncRecoveryRestorePreviewRequest(body) {
  const input = requirePlainObject(body, "client sync recovery restore preview request");
  if (Object.keys(input).some(field => !["runId", "side", "path", "destinationPath"].includes(field))) {
    throw createHttpError("validation_failed", 400, "client sync recovery restore preview request contains unsupported fields");
  }
  const output = {};
  copyOptionalStringFields(input, output, ["runId", "side", "path", "destinationPath"]);
  if (!output.runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.runId)
    || !["path1", "path2"].includes(output.side) || !output.path || !output.destinationPath) {
    throw createHttpError("validation_failed", 400, "client sync recovery restore preview request is incomplete or invalid");
  }
  return output;
}

function parseStrictSyncRecoveryPreviewIdRequest(body, label) {
  const input = requirePlainObject(body, label);
  if (Object.keys(input).some(field => field !== "previewId")) {
    throw createHttpError("validation_failed", 400, `${label} contains unsupported fields`);
  }
  const output = {};
  copyOptionalStringFields(input, output, ["previewId"]);
  if (!output.previewId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.previewId)) {
    throw createHttpError("validation_failed", 400, `${label} requires a UUID previewId`);
  }
  return output;
}

function parseClientConnectionRepairRequest(body) {
  const label = "client connection repair request";
  const input = requirePlainObject(body, label);
  const allowed = ["operationId", "relationId", "jobId"];
  if (Object.keys(input).some(field => !allowed.includes(field))) {
    throw createHttpError("validation_failed", 400, `${label} contains unsupported fields`);
  }
  const output = {};
  copyOptionalStringFields(input, output, allowed);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.operationId || "")
    || !/^[A-Za-z0-9_-]{1,128}$/.test(output.relationId || "")
    || (Object.hasOwn(input, "jobId") && !output.jobId)) {
    throw createHttpError("validation_failed", 400, `${label} is incomplete or invalid`);
  }
  return output;
}

function parseClientEnrollmentCodeRequest(body, label) {
  const input = requirePlainObject(body, label);
  const code = input.code;
  if (typeof code !== "string") throw createHttpError("validation_failed", 400, `${label} code must be a string`);
  if (!code.trim()) throw createHttpError("validation_failed", 400, `${label} code is required`);
  return { code: code.trim() };
}

function parseClientProfileImportRequest(body) {
  const input = requirePlainObject(body, "client profile import request");
  const output = {};
  copyOptionalStringFields(input, output, [...CLAIM_REDEEM_FIELDS, "uri", "clientName", "server"]);
  if (Object.hasOwn(input, "options")) {
    output.options = parseClientProfileImportOptions(input.options);
  }
  if (!hasAnyNonEmptyString(output, [...CLAIM_REDEEM_FIELDS, "uri"])) {
    throw createHttpError("import_code_required", 400, "Import code is required");
  }
  return output;
}

function parseClientProfileImportOptions(body) {
  const input = requirePlainObject(body, "client profile import request.options");
  const output = {};
  if (Object.hasOwn(input, "localProxyPort")) {
    output.localProxyPort = readPort(input.localProxyPort, "options.localProxyPort");
  }
  return output;
}

function parseClientJobRequest(body, options = {}) {
  const input = requirePlainObject(body, options.label || "client job request");
  const output = {};
  if (Object.hasOwn(input, "job")) {
    output.job = parseClientJobPayload(input.job, `${options.label || "client job request"}.job`);
  }
  if (options.allowConfirmations !== false) {
    copyOptionalBooleanField(input, output, "confirmCompatibilityWarning");
    copyOptionalBooleanField(input, output, "confirmDestructiveSync");
  }
  if (options.allowSafetyPlanId) {
    copyOptionalStringFields(input, output, ["safetyPlanId"]);
  }
  if (options.allowBisyncInitializationConfirmation) {
    copyOptionalBooleanField(input, output, "confirmBidirectionalInitialization");
  }
  if (options.allowFirstConflictOperationId) {
    copyOptionalStringFields(input, output, ["conflictOperationId"]);
    if (output.conflictOperationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.conflictOperationId)) {
      throw createHttpError("validation_failed", 400, "conflictOperationId must be a UUID");
    }
  }
  return output;
}

function parseStrictClientJobRequest(body, fields, label) {
  const input = requirePlainObject(body, label);
  if (Object.keys(input).some(field => !fields.includes(field)) || !input.job) {
    throw createHttpError("validation_failed", 400, `${label} contains unsupported or missing fields`);
  }
  const output = { job: parseClientJobPayload(input.job, `${label}.job`) };
  if (fields.includes("previewId")) {
    copyOptionalStringFields(input, output, ["previewId"]);
    if (!output.previewId) throw createHttpError("validation_failed", 400, `${label} requires previewId`);
  }
  if (fields.includes("operationId")) {
    copyOptionalStringFields(input, output, ["operationId"]);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(output.operationId || "")) {
      throw createHttpError("validation_failed", 400, `${label} requires a UUID operationId`);
    }
  }
  return output;
}

function parseClientJobPayload(body, label) {
  const input = requirePlainObject(body, label);
  const output = {};
  copyOptionalStringFields(input, output, CLIENT_JOB_STRING_FIELDS);
  copyOptionalJsonFields(input, output, CLIENT_JOB_JSON_FIELDS);
  for (const field of CLIENT_JOB_BOOLEAN_FIELDS) {
    copyOptionalBooleanField(input, output, field);
  }
  copyOptionalObjectField(input, output, "schedule", SCHEDULE_OBJECT_FIELDS);
  parseClientJobSafetyField(input, output);
  return output;
}

function parseClientSingboxStartRequest(body) {
  return parseEmptyObjectRequest(body, "client sing-box start request");
}

function parseServerAdminStorageSaveRequest(body) {
  const input = requirePlainObject(body, "admin storage save request");
  const output = {};
  copyOptionalStringFields(input, output, [
    "accessKeyId",
    "accessKeyMode",
    "bucket",
    "endpoint",
    "internalEndpoint",
    "name",
    "prefixRoot",
    "remoteName",
    "secretAccessKey",
    "sharedPrefix"
  ]);
  return output;
}

function parseServerAdminSyncSpaceCreateRequest(body) {
  const input = requirePlainObject(body, "admin sync space create request");
  const output = {};
  copyOptionalStringFields(input, output, ["ownerUserId", "syncId"]);
  if (!output.ownerUserId || !output.syncId) {
    throw createHttpError("validation_failed", 400, "admin sync space create request requires ownerUserId and syncId");
  }
  // mode 必须显式放行，否则会在到达 createSyncSpace 之前被白名单静默丢弃。
  // 只在调用方真的给了值时才校验并带上：省略是兼容旧调用方，填错是管理员意图不明，
  // 两者必须区分。默认值仍然只由 createSyncSpace 一处决定，这里不复制那个决定。
  if (input.mode != null && String(input.mode).trim() !== "") {
    output.mode = requireSyncSpaceMode(input.mode);
  }
  return output;
}

function parseServerAdminStorageBucketCreateRequest(body) {
  const input = requirePlainObject(body, "admin storage bucket create request");
  const output = {};
  copyOptionalStringFields(input, output, ["bucket", "name", "source"]);
  return output;
}

function parseEmptyObjectRequest(body, label) {
  const input = requirePlainObject(body, label);
  if (Object.keys(input).length) {
    throw createHttpError("validation_failed", 400, `${label} must be an empty JSON object`);
  }
  return {};
}

function parseServerAdminEnrollmentDirectoryRequest(body) {
  const input = requirePlainObject(body, "admin enrollment directory request");
  if (Object.keys(input).sort().join(",") !== "path") {
    throw createHttpError("validation_failed", 400, "Directory request must contain only path");
  }
  if (typeof input.path !== "string" || input.path.trim().length === 0 || input.path.length > 4096) {
    throw createHttpError("validation_failed", 400, "path must be a non-empty directory path");
  }
  return { path: input.path.trim() };
}

function parseServerAdminEnrollmentIssueRequest(body) {
  const input = requirePlainObject(body, "admin enrollment issue request");
  const fields = Object.keys(input);
  if (fields.length === 1 && fields[0] === "rootId") {
    if (typeof input.rootId !== "string" || !/^root_[A-Za-z0-9_-]{16,128}$/.test(input.rootId)) {
      throw createHttpError("validation_failed", 400, "rootId is invalid");
    }
    return { rootId: input.rootId };
  }
  if (fields.length === 1 && fields[0] === "rootIds") {
    if (!Array.isArray(input.rootIds) || input.rootIds.length === 0
      || input.rootIds.some(rootId => typeof rootId !== "string" || !/^root_[A-Za-z0-9_-]{16,128}$/.test(rootId))
      || new Set(input.rootIds).size !== input.rootIds.length) {
      throw createHttpError("validation_failed", 400, "rootIds must be a non-empty array of unique valid root IDs");
    }
    return { rootIds: [...input.rootIds] };
  }
  throw createHttpError("validation_failed", 400, "Enrollment issue request must contain only rootId or rootIds");
}

function parseServerAdminEnrollmentReconfigureRequest(body) {
  const input = requirePlainObject(body, "admin enrollment reconfigure request");
  const allowed = new Set(["operationId", "publicHost", "publicPort"]);
  if (Object.keys(input).some(key => !allowed.has(key))
    || typeof input.operationId !== "string"
    || !/^op_[A-Za-z0-9_-]{16,128}$/.test(input.operationId)) {
    throw createHttpError("enrollment_reconfigure_invalid", 400, "Reconfiguration operation ID or fields are invalid");
  }
  const output = { operationId: input.operationId };
  if (Object.hasOwn(input, "publicHost")) {
    if (typeof input.publicHost !== "string" || input.publicHost.trim().length === 0 || input.publicHost.trim().length > 253) {
      throw createHttpError("enrollment_reconfigure_invalid", 400, "Public host is invalid");
    }
    output.publicHost = input.publicHost.trim();
  }
  if (Object.hasOwn(input, "publicPort")) {
    if (!Number.isInteger(input.publicPort) || input.publicPort < 1 || input.publicPort > 65535) {
      throw createHttpError("enrollment_reconfigure_invalid", 400, "Public port is invalid");
    }
    output.publicPort = input.publicPort;
  }
  return output;
}

function parseServerAdminEnrollmentRevokeRequest(body) {
  const input = requirePlainObject(body, "admin enrollment revoke request");
  if (Object.keys(input).sort().join(",") !== "operationId,target"
    || typeof input.operationId !== "string"
    || !/^revop_[A-Za-z0-9_-]{16,96}$/.test(input.operationId)) {
    throw createHttpError("enrollment_revocation_invalid", 400, "Revocation operation ID or fields are invalid");
  }
  const target = requirePlainObject(input.target, "admin enrollment revocation target");
  if (target.kind === "relation"
    && Object.keys(target).sort().join(",") === "kind,relationId"
    && typeof target.relationId === "string"
    && /^rel_[A-Za-z0-9_-]{16,128}$/.test(target.relationId)) {
    return { operationId: input.operationId, target: { kind: "relation", relationId: target.relationId } };
  }
  if (target.kind === "device"
    && Object.keys(target).sort().join(",") === "deviceId,kind"
    && typeof target.deviceId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(target.deviceId)) {
    return { operationId: input.operationId, target: { kind: "device", deviceId: target.deviceId } };
  }
  throw createHttpError("enrollment_revocation_invalid", 400, "Revocation target is invalid");
}

function parseServerAdminStorageBucketToggleRequest(body, label) {
  const input = requirePlainObject(body, label);
  const output = {};
  copyOptionalStringFields(input, output, ["bucket"]);
  return output;
}

function parseServerAdminStorageBucketDangerRequest(body, label) {
  const input = requirePlainObject(body, label);
  const output = {};
  copyOptionalStringFields(input, output, ["bucket", "confirmBucket", "confirmText"]);
  return output;
}

function parseServerAdminTunnelGenerateRequest(body) {
  const input = requirePlainObject(body, "admin tunnel generate request");
  const output = {};
  copyOptionalStringFields(input, output, ["protocol", "publicHost", "transportPath", "remark"]);
  copyOptionalJsonFields(input, output, ["publicPort", "listenPort"]);
  copyOptionalBooleanField(input, output, "confirmGenerateTunnel");
  copyOptionalObjectField(input, output, "reality", REALITY_OBJECT_FIELDS);
  return output;
}

function parseServerAdminTunnelAutofillRequest(body) {
  const input = requirePlainObject(body, "admin tunnel autofill request");
  const output = {};
  copyOptionalStringFields(input, output, [
    "fingerprint",
    "protocol",
    "publicHost",
    "remark",
    "serverName",
    "shortId",
    "transportPath"
  ]);
  copyOptionalJsonFields(input, output, ["publicPort", "listenPort"]);
  copyOptionalBooleanField(input, output, "confirmRotateRealityKeys");
  copyOptionalBooleanField(input, output, "forceRealityKeys");
  return output;
}

function parseServerAdminSingboxWriteRequest(body) {
  const input = requirePlainObject(body, "admin sing-box write request");
  const output = {};
  copyOptionalBooleanField(input, output, "confirmWriteSingbox");
  return output;
}

function parseServerAdminSingboxApplyRequest(body) {
  const input = requirePlainObject(body, "admin sing-box apply request");
  const output = {};
  copyOptionalBooleanField(input, output, "confirmApplySingbox");
  return output;
}

function parseServerAdminSingboxMarkAppliedRequest(body) {
  const input = requirePlainObject(body, "admin sing-box mark-applied request");
  const output = {};
  copyOptionalBooleanField(input, output, "confirmMarkApplied");
  return output;
}

function parseServerAdminUserCreateRequest(body) {
  const input = requirePlainObject(body, "admin user create request");
  const output = {};
  copyOptionalStringFields(input, output, [
    "accessKeyId",
    "bucket",
    "bucketName",
    "clientName",
    "heartbeatSecret",
    "id",
    "prefix",
    "secretAccessKey",
    "uuid"
  ]);
  copyOptionalBooleanField(input, output, "enabled");
  copyOptionalBooleanField(input, output, "forceNew");
  return output;
}

function parseServerAdminUserToggleRequest(body, options = {}) {
  const input = requirePlainObject(body, options.label || "admin user toggle request");
  const output = {};
  copyOptionalStringFields(input, output, ["id", "userId"]);
  if (options.allowCompatibilityConfirmation) {
    copyOptionalBooleanField(input, output, "confirmCompatibilityWarning");
  }
  return output;
}

function parseServerAdminUserDeleteRequest(body) {
  const input = requirePlainObject(body, "admin user delete request");
  const output = {};
  copyOptionalStringFields(input, output, ["id", "userId", "confirmText"]);
  return output;
}

function parseServerClaimCreateRequest(body) {
  const input = requirePlainObject(body, "claim create request");
  const output = {};
  copyOptionalStringFields(input, output, [
    "bucket",
    "bucketName",
    "clientName",
    "profileExpiresAt",
    "profileId",
    "requestedRole",
    "server",
    "syncSpaceId",
    "userId"
  ]);
  copyOptionalBooleanField(input, output, "confirmCompatibilityWarning");
  parseProfileDefaultsField(input, output);
  copyOptionalJsonFields(input, output, ["expiresAt", "expiresInHours"]);
  return output;
}

function parseServerClaimRedeemRequest(body) {
  const input = requirePlainObject(body, "claim redeem request");
  const output = {};
  copyOptionalStringFields(input, output, [
    ...CLAIM_REDEEM_FIELDS,
    "clientRedeemId",
    "clientInstallId",
    "deviceBindingId"
  ]);
  if (!hasAnyNonEmptyString(output, CLAIM_REDEEM_FIELDS)) {
    throw createHttpError("import_code_invalid", 400, "SyncKey redeem request must include code, tKey, tkey, claimCode, or token");
  }
  for (const field of ["clientRedeemId", "clientInstallId", "deviceBindingId"]) {
    if (output[field] && output[field].length > 128) {
      throw createHttpError("validation_failed", 400, `${field} must be 128 characters or fewer`);
    }
  }
  return output;
}

function parseServerDeviceHeartbeatRequest(body) {
  const input = requirePlainObject(body, "device heartbeat request");
  const output = {};
  copyOptionalStringFields(input, output, ["clientName", "deviceName", "profileId", "clientVersion"]);
  if (!hasAnyNonEmptyString(output, ["clientName", "deviceName"])) {
    throw createHttpError("validation_failed", 400, "device heartbeat request requires clientName");
  }
  // Heartbeat nested payloads must pass through in arrival form: the HMAC
  // signature covers the whole body, and normalizeDeviceSync /
  // normalizeRuntimeDiagnostics deep-normalize them after verification.
  // Mutating or whitelisting nested content here would break signatures of
  // legitimate clients without adding a security boundary.
  copyOptionalObjectField(input, output, "diagnostics");
  copyOptionalObjectField(input, output, "storage");
  copyOptionalObjectField(input, output, "sync");
  copyOptionalObjectField(input, output, "auth");
  copyOptionalUncheckedJsonFields(input, output, HEARTBEAT_LEGACY_SYNC_FIELDS);
  return output;
}

function parseServerProfileEncodeRequest(body) {
  const input = requirePlainObject(body, "profile encode request");
  const output = {};
  copyOptionalStringFields(input, output, [
    "accessKeyId",
    "bucket",
    "chunkSize",
    "clientName",
    "endpoint",
    "expiresAt",
    "heartbeatSecret",
    "prefix",
    "profileId",
    "remoteName",
    "secretAccessKey",
    "server",
    "uri",
    "vlessUri"
  ]);
  parseProfileDefaultsField(input, output);
  copyOptionalObjectField(input, output, "heartbeat", PROFILE_ENCODE_HEARTBEAT_FIELDS);
  copyOptionalObjectField(input, output, "schedule", SCHEDULE_OBJECT_FIELDS);
  parseBandwidthLimitField(input, output);
  copyOptionalJsonFields(input, output, [
    "checkers",
    "localProxyPort",
    "lowLevelRetries",
    "retries",
    "streams",
    "transfers"
  ]);
  return output;
}

function parseServerJobsPreviewRequest(body) {
  const input = requirePlainObject(body, "server jobs preview request");
  const output = {};
  copyOptionalStringFields(input, output, ["uri"]);
  if (Object.hasOwn(input, "options")) {
    output.options = parseServerJobsPreviewOptions(input.options);
  }
  if (Object.hasOwn(input, "job")) {
    output.job = parseServerJobsPreviewJob(input.job);
  }
  return output;
}

function parseServerJobsPreviewOptions(body) {
  const input = requirePlainObject(body, "server jobs preview request.options");
  const output = {};
  copyOptionalStringFields(input, output, SERVER_JOBS_PREVIEW_OPTIONS_STRING_FIELDS);
  copyOptionalJsonFields(input, output, SERVER_JOBS_PREVIEW_OPTIONS_JSON_FIELDS);
  return output;
}

function parseServerJobsPreviewJob(body) {
  const input = requirePlainObject(body, "server jobs preview request.job");
  const output = {};
  copyOptionalStringFields(input, output, SERVER_JOBS_PREVIEW_JOB_STRING_FIELDS);
  copyOptionalJsonFields(input, output, SERVER_JOBS_PREVIEW_JOB_JSON_FIELDS);
  for (const field of SERVER_JOBS_PREVIEW_JOB_BOOLEAN_FIELDS) {
    copyOptionalBooleanField(input, output, field);
  }
  copyOptionalObjectField(input, output, "schedule", SCHEDULE_OBJECT_FIELDS);
  return output;
}

function parseServerVlessParseRequest(body) {
  const input = requirePlainObject(body, "server VLESS parse request");
  const output = {};
  copyOptionalStringFields(input, output, ["uri"]);
  return output;
}

function parseServerSingboxClientConfigRequest(body) {
  const input = requirePlainObject(body, "server sing-box client config request");
  const output = {};
  copyOptionalStringFields(input, output, ["uri"]);
  if (Object.hasOwn(input, "options")) {
    output.options = parseServerSingboxClientConfigOptions(input.options);
  }
  return output;
}

function parseServerSingboxClientConfigOptions(body) {
  const input = requirePlainObject(body, "server sing-box client config request.options");
  const output = {};
  copyOptionalJsonFields(input, output, SERVER_SINGBOX_CLIENT_CONFIG_OPTIONS_JSON_FIELDS);
  return output;
}

function copyOptionalStringFields(input, output, fields) {
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      continue;
    }
    if (input[field] == null) {
      output[field] = "";
      continue;
    }
    if (typeof input[field] !== "string") {
      throw createHttpError("validation_failed", 400, `${field} must be a string`);
    }
    output[field] = input[field].trim();
  }
}

function copyOptionalBooleanField(input, output, field) {
  if (!Object.hasOwn(input, field)) {
    return;
  }
  if (typeof input[field] !== "boolean") {
    throw createHttpError("validation_failed", 400, `${field} must be a boolean`);
  }
  output[field] = input[field];
}

function copyOptionalObjectField(input, output, field, allowedFields = null) {
  if (!Object.hasOwn(input, field)) {
    return;
  }
  const value = requirePlainObject(input[field], `${field}`);
  if (!allowedFields) {
    output[field] = value;
    return;
  }
  output[field] = {};
  copyOptionalJsonFields(value, output[field], allowedFields);
}

// JSON fields declared in schema whitelists are scalars by contract: nested
// objects and arrays must never ride through a scalar slot into deep sync or
// state logic (CORE-3). Deep normalizers still do range/format validation.
function copyOptionalJsonFields(input, output, fields) {
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      continue;
    }
    const value = input[field];
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      throw createHttpError("validation_failed", 400, `${field} must be a JSON scalar value`);
    }
    output[field] = value;
  }
}

// Device heartbeat legacy sync fields carry versioned nested objects
// (scheduler, currentJob, lastRun, lastExit, conflicts, ...). Their arrival
// form is bound by the heartbeat HMAC signature and they are deep-normalized
// by normalizeDeviceSync before persistence, so they intentionally bypass the
// scalar guard above. Do not reuse this helper for new fields.
function copyOptionalUncheckedJsonFields(input, output, fields) {
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      continue;
    }
    output[field] = input[field];
  }
}

function parseProfileDefaultsField(input, output) {
  if (!Object.hasOwn(input, "defaults")) {
    return;
  }
  const value = requirePlainObject(input.defaults, "defaults");
  const defaults = {};
  copyOptionalJsonFields(value, defaults, PROFILE_DEFAULTS_SCALAR_FIELDS);
  parseBandwidthLimitField(value, defaults);
  copyOptionalObjectField(value, defaults, "schedule", SCHEDULE_OBJECT_FIELDS);
  output.defaults = defaults;
}

// bandwidthLimit is the one dual-typed field: either an rclone --bwlimit
// compatible string ("off", "20M", timetable) or the UI widget object form.
function parseBandwidthLimitField(input, output, field = "bandwidthLimit") {
  if (!Object.hasOwn(input, field)) {
    return;
  }
  const value = input[field];
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      throw createHttpError("validation_failed", 400, `${field} must be a bandwidth limit string or object`);
    }
    output[field] = {};
    copyOptionalJsonFields(value, output[field], BANDWIDTH_LIMIT_OBJECT_FIELDS);
    return;
  }
  output[field] = value;
}

function parseClientJobSafetyField(input, output) {
  if (!Object.hasOwn(input, "safety")) {
    return;
  }
  const value = requirePlainObject(input.safety, "safety");
  const safety = {};
  copyOptionalJsonFields(value, safety, CLIENT_JOB_SAFETY_SCALAR_FIELDS);
  copyOptionalObjectField(value, safety, "deleteLimit", CLIENT_JOB_SAFETY_DELETE_LIMIT_FIELDS);
  copyOptionalObjectField(value, safety, "bidirectional", CLIENT_JOB_SAFETY_BIDIRECTIONAL_FIELDS);
  output.safety = safety;
}

function readPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createHttpError("validation_failed", 400, `${label} must be an integer between 1 and 65535`);
  }
  return port;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createHttpError("validation_failed", 400, `${label} must be a JSON object`);
  }
  return value;
}

function hasAnyNonEmptyString(value, fields) {
  return fields.some((field) => typeof value[field] === "string" && value[field].trim() !== "");
}
