import { createHttpError } from "./errors.js";

export const SYNC_SAFETY_VERSION = 1;

export function normalizeSyncSafety(input = {}, direction = "upload") {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const deleteLimit = value.deleteLimit && typeof value.deleteLimit === "object" && !Array.isArray(value.deleteLimit)
    ? value.deleteLimit
    : {};
  const bidirectional = value.bidirectional && typeof value.bidirectional === "object" && !Array.isArray(value.bidirectional)
    ? value.bidirectional
    : {};
  const initialMode = String(bidirectional.initialMode || "").trim();
  if (initialMode && !["local", "remote", "newer"].includes(initialMode)) {
    throw createHttpError("validation_failed", 400, "Bidirectional initial mode must be local, remote, or newer");
  }
  const maxFiles = positiveInteger(deleteLimit.maxFiles, 100, "deleteLimit.maxFiles");
  const maxPercent = positiveInteger(deleteLimit.maxPercent, 10, "deleteLimit.maxPercent");
  if (maxPercent > 100) {
    throw createHttpError("validation_failed", 400, "deleteLimit.maxPercent must be 100 or fewer");
  }
  return {
    version: SYNC_SAFETY_VERSION,
    recoveryRetentionDays: positiveInteger(value.recoveryRetentionDays, 30, "recoveryRetentionDays"),
    deleteLimit: {
      maxFiles,
      maxPercent
    },
    bidirectional: {
      initialized: direction === "bidirectional" && value.bidirectional?.initialized === true,
      initialMode
    }
  };
}

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw createHttpError("validation_failed", 400, `${field} must be a positive integer`);
  }
  return value;
}
