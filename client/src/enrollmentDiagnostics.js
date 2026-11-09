import { isStableErrorCode } from "../../src/core/errors.js";

const DIAGNOSTIC_ERROR_KEYS = ["code", "recordedAt"];

export function createEnrollmentDiagnosticError(error, now = Date.now()) {
  const code = String(error?.code || "");
  const recordedAt = new Date(now).toISOString();
  if (!code.startsWith("enrollment_") || !isStableErrorCode(code)) return null;
  return { code, recordedAt };
}

export async function runEnrollmentRefreshWithDiagnostics(serverState, refresh, persist, {
  now = () => Date.now(),
  onFailure
} = {}) {
  try {
    const result = await refresh();
    delete serverState.lastEnrollmentError;
    await persist();
    return result;
  } catch (error) {
    onFailure?.();
    const diagnosticError = createEnrollmentDiagnosticError(error, typeof now === "function" ? now() : now);
    if (diagnosticError) {
      serverState.lastEnrollmentError = diagnosticError;
      await persist().catch(() => {});
    }
    throw error;
  }
}

export function isEnrollmentDiagnosticError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== DIAGNOSTIC_ERROR_KEYS.join("\0")
    || typeof value.code !== "string"
    || !value.code.startsWith("enrollment_")
    || !isStableErrorCode(value.code)
    || typeof value.recordedAt !== "string"
    || value.recordedAt.length !== 24
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.recordedAt)) return false;
  const parsedAt = Date.parse(value.recordedAt);
  return Number.isFinite(parsedAt) && new Date(parsedAt).toISOString() === value.recordedAt;
}

export function normalizeEnrollmentDiagnosticError(value) {
  return isEnrollmentDiagnosticError(value)
    ? { code: value.code, recordedAt: value.recordedAt }
    : null;
}
