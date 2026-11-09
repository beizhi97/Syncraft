import { createOwnerAdmissionCore } from "./ownerAdmissionCore.js";
import { loadOwnerStateSnapshotBinding } from "./ownerLockBinding.js";

function snapshotGateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRequest(request) {
  if (request === null
    || typeof request !== "object"
    || Array.isArray(request)
    || (Object.getPrototypeOf(request) !== Object.prototype
      && Object.getPrototypeOf(request) !== null)) {
    throw snapshotGateError(
      "owner_lock_input_invalid",
      "snapshot gate request must be a plain object"
    );
  }
  const keys = Object.keys(request).sort();
  if (keys.length !== 2
    || keys[0] !== "artifactPath"
    || keys[1] !== "manifestPath") {
    throw snapshotGateError(
      "owner_lock_input_invalid",
      "snapshot gate request must contain exactly artifactPath and manifestPath"
    );
  }
  const artifactPath = request.artifactPath;
  const manifestPath = request.manifestPath;
  if (typeof artifactPath !== "string" || typeof manifestPath !== "string") {
    throw snapshotGateError(
      "owner_lock_input_invalid",
      "snapshot gate paths must be strings"
    );
  }
  return Object.freeze({ artifactPath, manifestPath });
}

export function createOwnerStateSnapshotGate(request = {}) {
  const normalized = normalizeRequest(request);
  const binding = loadOwnerStateSnapshotBinding(normalized);
  return createOwnerAdmissionCore({
    binding,
    snapshotEnabled: true
  });
}
