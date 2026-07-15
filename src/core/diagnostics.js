import { CLAIM_VERSION } from "./claimProtocol.js";
import { PROFILE_VERSION } from "./profileProtocol.js";

export const APP_ID = "singbox-folder-sync";
export const ADMIN_STATE_VERSION = 1;
export const CLIENT_STATUS_VERSION = 1;
export const HEARTBEAT_VERSION = 1;
export const RUNTIME_PROTOCOL_FIELDS = Object.freeze(["claim", "profile", "adminState", "clientStatus", "heartbeat"]);

export function buildRuntimeDiagnostics(input = {}) {
  return {
    app: APP_ID,
    role: normalizeRole(input.role),
    version: normalizeText(input.version, "0.0.0"),
    buildId: normalizeText(input.buildId || process.env.SFSC_BUILD_ID, ""),
    buildTime: normalizeText(input.buildTime || process.env.SFSC_BUILD_TIME, null),
    protocols: {
      claim: CLAIM_VERSION,
      profile: PROFILE_VERSION,
      adminState: ADMIN_STATE_VERSION,
      clientStatus: CLIENT_STATUS_VERSION,
      heartbeat: HEARTBEAT_VERSION
    }
  };
}

export function compareRuntimeDiagnostics(local = {}, remote = {}, options = {}) {
  const protocolFields = options.protocols || RUNTIME_PROTOCOL_FIELDS;
  const issues = [];
  const localRole = normalizeRuntimeRole(options.localRole || local?.role);
  const remoteRole = normalizeRuntimeRole(options.remoteRole || remote?.role);
  const expectedRemoteRole = options.remoteRole || oppositeRuntimeRole(localRole);
  const localProtocols = isRuntimeDiagnosticsEnvelope(local, localRole) ? local.protocols : {};
  const remoteProtocols = isRuntimeDiagnosticsEnvelope(remote, expectedRemoteRole) ? remote.protocols : {};

  for (const field of protocolFields) {
    const localVersion = normalizeProtocolVersion(localProtocols[field]);
    const remoteVersion = normalizeProtocolVersion(remoteProtocols[field]);
    if (!Number.isInteger(localVersion) || localVersion < 1) {
      issues.push({
        field,
        type: "local_missing",
        local: null,
        remote: remoteVersion,
        message: `${field} local protocol version is missing`
      });
      continue;
    }
    if (!Number.isInteger(remoteVersion) || remoteVersion < 1) {
      issues.push({
        field,
        type: "remote_missing",
        local: localVersion,
        remote: null,
        message: `${field} remote protocol version is missing`
      });
      continue;
    }
    if (localVersion !== remoteVersion) {
      issues.push({
        field,
        type: remoteVersion < localVersion ? "remote_older" : "remote_newer",
        local: localVersion,
        remote: remoteVersion,
        message: `${field} protocol mismatch: local v${localVersion}, remote v${remoteVersion}`
      });
    }
  }

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "compatible" : "mismatch",
    action: summarizeCompatibilityAction(issues),
    severity: issues.length === 0 ? "ok" : "warning",
    policy: buildCompatibilityPolicy(issues),
    localRole,
    remoteRole,
    issues
  };
}

function normalizeProtocolVersion(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function normalizeRuntimeDiagnostics(input = {}, expectedRole = "") {
  const role = normalizeRuntimeRole(expectedRole || input?.role);
  if (!isRuntimeDiagnosticsEnvelope(input, role)) {
    return null;
  }
  if (!hasExactKeys(input.protocols, RUNTIME_PROTOCOL_FIELDS)) {
    return null;
  }
  for (const field of RUNTIME_PROTOCOL_FIELDS) {
    if (normalizeProtocolVersion(input.protocols[field]) === null) {
      return null;
    }
  }
  return {
    app: APP_ID,
    role,
    version: input.version.trim(),
    buildId: input.buildId.trim(),
    buildTime: input.buildTime === null ? null : input.buildTime.trim(),
    protocols: Object.fromEntries(RUNTIME_PROTOCOL_FIELDS.map((field) => [field, input.protocols[field]]))
  };
}

function isRuntimeDiagnosticsEnvelope(input, expectedRole = "") {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (!hasExactKeys(input, ["app", "buildId", "buildTime", "protocols", "role", "version"])) return false;
  if (input.app !== APP_ID) return false;
  const role = normalizeRuntimeRole(input.role);
  if (!role || (expectedRole && role !== expectedRole)) return false;
  if (typeof input.version !== "string" || input.version.trim() === "") return false;
  if (typeof input.buildId !== "string") return false;
  if (input.buildTime !== null && (typeof input.buildTime !== "string" || input.buildTime.trim() === "")) return false;
  return Boolean(input.protocols && typeof input.protocols === "object" && !Array.isArray(input.protocols));
}

function normalizeRuntimeRole(value) {
  const role = String(value || "").trim();
  return role === "server" || role === "client" ? role : "";
}

function oppositeRuntimeRole(role) {
  if (role === "server") return "client";
  if (role === "client") return "server";
  return "";
}

function hasExactKeys(value, expectedKeys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

export function buildCompatibilityPolicy(issues = []) {
  const compatible = issues.length === 0;
  return {
    heartbeat: "allow",
    profileIssue: compatible ? "allow" : "warn",
    syncRun: compatible ? "allow" : "warn",
    adminActions: "allow",
    reason: summarizeCompatibilityAction(issues)
  };
}

function summarizeCompatibilityAction(issues) {
  if (!issues.length) {
    return "none";
  }
  if (issues.some((issue) => issue.type === "local_missing" || issue.type === "remote_missing")) {
    return "diagnostics_missing";
  }
  const hasRemoteOlder = issues.some((issue) => issue.type === "remote_older");
  const hasRemoteNewer = issues.some((issue) => issue.type === "remote_newer");
  if (hasRemoteOlder && !hasRemoteNewer) {
    return "upgrade_remote";
  }
  if (hasRemoteNewer && !hasRemoteOlder) {
    return "upgrade_local";
  }
  return "manual_check";
}

function normalizeRole(input) {
  const role = String(input || "").trim();
  return role || "unknown";
}

function normalizeText(input, fallback) {
  if (input == null) return fallback;
  const text = String(input).trim();
  return text || fallback;
}
