import { createHttpError } from "./errors.js";

export function normalizeTcpPort(input, options = {}) {
  const field = options.field || "port";
  const fallback = options.defaultValue;
  if (isMissing(input)) {
    if (fallback === undefined) {
      throw validationError(`${field} is required`);
    }
    return normalizeTcpPort(fallback, { field });
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw validationError(`${field} must be an integer between 1 and 65535`);
  }
  return value;
}

export function normalizePositiveInteger(input, options = {}) {
  const field = options.field || "value";
  const fallback = options.defaultValue;
  const max = options.max || 1024;
  if (isMissing(input)) {
    if (fallback === undefined) {
      throw validationError(`${field} is required`);
    }
    return normalizePositiveInteger(fallback, { field, max });
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw validationError(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

function isMissing(input) {
  return input === undefined || input === null || input === "";
}

function validationError(message) {
  return createHttpError("validation_failed", 400, message);
}
