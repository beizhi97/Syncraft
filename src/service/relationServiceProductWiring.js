import { createHash } from "node:crypto";
import { isAbsolute, parse, resolve } from "node:path";

import {
  canonicalJson,
  normalizeEnrollmentBinding
} from "../core/enrollmentProtocol.js";
import {
  createLinuxRelationFileServiceRuntime,
  createLinuxSftpRelationFileServiceRuntime
} from "../core/linuxRelationFileServiceRuntime.js";
import {
  ensureDirectoryRootProtection
} from "../core/linuxImmutableHandle.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTEMPT_ID_PATTERN = /^[a-f0-9]{32}$/;
const IDENTITY_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FENCE_KEYS = [
  "attemptId",
  "expectedHandleDigest",
  "generation",
  "operationId",
  "protectionDigest",
  "relationId",
  "schemaVersion"
];
const ROOT_RECORD_KEYS = [
  "activatedAt",
  "canonicalRoot",
  "createdAt",
  "kind",
  "marker",
  "markerId",
  "markerIdentity",
  "markerSync",
  "mountEvidence",
  "operationId",
  "rootId",
  "rootIdentity",
  "schemaVersion",
  "serverId",
  "shareId",
  "stage",
  "status"
];
const MARKER_RECORD_KEYS = [
  "content",
  "contentLength",
  "contentSha256",
  "name"
];
const MARKER_CONTENT_KEYS = [
  "createdAt",
  "kind",
  "markerId",
  "operationId",
  "rootId",
  "schemaVersion",
  "serverId",
  "shareId"
];
const RUNTIME_PACKAGE_KEYS = [
  "execServicePath",
  "helperPath",
  "helperSha256",
  "signalServicePath",
  "supervisorPath"
];
const SFTP_RUNTIME_PACKAGE_KEYS = [
  "rootGuardPath",
  "rootGuardSha256",
  "sftpServicePath",
  "supervisorPath"
];
export const RELATION_SERVICE_SFTP_USER = "sfsc";

function wiringError(message) {
  const error = new Error(message);
  error.code = "relation_service_product_wiring_invalid";
  return error;
}

function ownershipError() {
  const error = new Error("relation runtime ownership is not present in this process");
  error.code = "runtime_ownership_unconfirmed";
  return error;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw wiringError(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw wiringError(`${label} contains unsupported or missing fields`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    throw wiringError(`${label} contains unsupported fields`);
  }
}

function requiredFunction(value, label) {
  if (typeof value !== "function") {
    throw wiringError(`${label} must be a function`);
  }
  return value;
}

function identityText(value, label) {
  if (typeof value !== "string"
    || !IDENTITY_TEXT_PATTERN.test(value)) {
    throw wiringError(`${label} is invalid`);
  }
  return value;
}

function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || parse(value).root === value) {
    throw wiringError(`${label} must be a canonical absolute path`);
  }
  return value;
}

function assertDigest(value, label, allowNull = false) {
  if (allowNull && value === null) {
    return null;
  }
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw wiringError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotDigest(snapshot) {
  return sha256Text(canonicalJson(snapshot));
}

function validateFence(value) {
  assertExactKeys(value, FENCE_KEYS, "runtime fence");
  if (value.schemaVersion !== "1") {
    throw wiringError("runtime fence schema is invalid");
  }
  const relationId = identityText(value.relationId, "fence.relationId");
  const operationId = identityText(value.operationId, "fence.operationId");
  const generation = identityText(value.generation, "fence.generation");
  if (typeof value.attemptId !== "string"
    || !ATTEMPT_ID_PATTERN.test(value.attemptId)) {
    throw wiringError("runtime fence attemptId is invalid");
  }
  if (value.expectedHandleDigest !== ""
    && !SHA256_PATTERN.test(value.expectedHandleDigest)) {
    throw wiringError("runtime fence expectedHandleDigest is invalid");
  }
  assertDigest(value.protectionDigest, "fence.protectionDigest", true);
  return Object.freeze({
    schemaVersion: "1",
    relationId,
    operationId,
    generation,
    attemptId: value.attemptId,
    expectedHandleDigest: value.expectedHandleDigest,
    protectionDigest: value.protectionDigest
  });
}

function validateRuntimePackage(value) {
  assertExactKeys(value, RUNTIME_PACKAGE_KEYS, "runtimePackage");
  const supervisorPath = canonicalAbsolutePath(
    value.supervisorPath,
    "runtimePackage.supervisorPath"
  );
  const helperPath = canonicalAbsolutePath(
    value.helperPath,
    "runtimePackage.helperPath"
  );
  const execServicePath = canonicalAbsolutePath(
    value.execServicePath,
    "runtimePackage.execServicePath"
  );
  const signalServicePath = canonicalAbsolutePath(
    value.signalServicePath,
    "runtimePackage.signalServicePath"
  );
  assertDigest(value.helperSha256, "runtimePackage.helperSha256");
  if (execServicePath !== helperPath || signalServicePath !== helperPath) {
    throw wiringError(
      "runtimePackage exec and signal services must both use the root-guard helper"
    );
  }
  return Object.freeze({
    supervisorPath,
    helperPath,
    helperSha256: value.helperSha256,
    execServicePath,
    signalServicePath
  });
}

function validateSftpRuntimePackage(value) {
  assertExactKeys(value, SFTP_RUNTIME_PACKAGE_KEYS, "sftpRuntimePackage");
  return Object.freeze({
    supervisorPath: canonicalAbsolutePath(value.supervisorPath, "sftpRuntimePackage.supervisorPath"),
    helperPath: canonicalAbsolutePath(value.rootGuardPath, "sftpRuntimePackage.rootGuardPath"),
    helperSha256: assertDigest(value.rootGuardSha256, "sftpRuntimePackage.rootGuardSha256"),
    servicePath: canonicalAbsolutePath(value.sftpServicePath, "sftpRuntimePackage.sftpServicePath")
  });
}

function validateDirectoryRoot(value, bindingIdentity) {
  assertExactKeys(value, ROOT_RECORD_KEYS, "directoryRoot");
  if (value.schemaVersion !== 1
    || value.kind !== "syncraft-directory-root-record"
    || value.status !== "active") {
    throw wiringError("directoryRoot is not an active directory-root record");
  }
  if (value.serverId !== bindingIdentity.serverId
    || value.shareId !== bindingIdentity.shareId
    || value.rootId !== bindingIdentity.rootId) {
    throw wiringError("directoryRoot does not match the enrollment identity");
  }
  canonicalAbsolutePath(value.canonicalRoot, "directoryRoot.canonicalRoot");
  assertExactKeys(value.stage, ["name", "state"], "directoryRoot.stage");
  if (value.stage.state !== "installed") {
    throw wiringError("directoryRoot stage is not installed");
  }
  assertExactKeys(value.marker, MARKER_RECORD_KEYS, "directoryRoot.marker");
  if (value.marker.name !== ".syncraft-root.json") {
    throw wiringError("directoryRoot marker name is unsupported");
  }
  assertExactKeys(
    value.marker.content,
    MARKER_CONTENT_KEYS,
    "directoryRoot.marker.content"
  );
  if (value.marker.content.serverId !== bindingIdentity.serverId
    || value.marker.content.shareId !== bindingIdentity.shareId
    || value.marker.content.rootId !== bindingIdentity.rootId) {
    throw wiringError("directoryRoot marker does not match the enrollment identity");
  }
  return Object.freeze(structuredClone(value));
}

function validateListener(value) {
  assertExactKeys(value, ["host", "port"], "catalog.listener");
  if (value.host !== "127.0.0.1"
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65535) {
    throw wiringError("catalog listener must be an exact loopback address");
  }
  return Object.freeze({ host: value.host, port: value.port });
}

function validateCatalogSnapshot(value, relationId) {
  assertExactKeys(
    value,
    ["authorization", "binding", "directoryRoot", "hostKey", "listener"],
    "catalog start snapshot"
  );
  let binding;
  try {
    binding = normalizeEnrollmentBinding(value.binding);
  } catch (error) {
    throw wiringError(`catalog binding is invalid: ${error.message}`);
  }
  if (canonicalJson(binding) !== canonicalJson(value.binding)) {
    throw wiringError("catalog binding is not the normalized P1 enrollment binding");
  }
  if (binding.identity.relationId !== relationId) {
    throw wiringError("catalog binding belongs to a different relation");
  }

  const directoryRoot = validateDirectoryRoot(
    value.directoryRoot,
    binding.identity
  );
  assertExactKeys(
    value.authorization,
    ["authorizedKeysPath", "devicePublicKeyFingerprint", "sha256"],
    "catalog.authorization"
  );
  const authorizedKeysPath = canonicalAbsolutePath(
    value.authorization.authorizedKeysPath,
    "catalog.authorization.authorizedKeysPath"
  );
  assertDigest(value.authorization.sha256, "catalog.authorization.sha256");
  if (typeof value.authorization.devicePublicKeyFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(
      value.authorization.devicePublicKeyFingerprint
    )) {
    throw wiringError("catalog authorization public-key fingerprint is invalid");
  }

  assertExactKeys(
    value.hostKey,
    ["path", "publicKeySha256"],
    "catalog.hostKey"
  );
  const hostKeyPath = canonicalAbsolutePath(
    value.hostKey.path,
    "catalog.hostKey.path"
  );
  assertDigest(value.hostKey.publicKeySha256, "catalog.hostKey.publicKeySha256");

  return Object.freeze({
    binding: Object.freeze(structuredClone(binding)),
    directoryRoot,
    authorization: Object.freeze({
      authorizedKeysPath,
      sha256: value.authorization.sha256,
      devicePublicKeyFingerprint:
        value.authorization.devicePublicKeyFingerprint
    }),
    hostKey: Object.freeze({
      path: hostKeyPath,
      publicKeySha256: value.hostKey.publicKeySha256
    }),
    listener: validateListener(value.listener)
  });
}

function stableIdentity(binding) {
  return Object.freeze({
    serverId: binding.identity.serverId,
    deviceId: binding.identity.deviceId,
    shareId: binding.identity.shareId,
    rootId: binding.identity.rootId,
    relationId: binding.identity.relationId,
    baselineEpoch: binding.baselineEpoch,
    rootAttestation: Object.freeze({ ...binding.rootAttestation }),
    backend: "sftp"
  });
}

function requireRuntimeAdapter(value, label) {
  assertPlainObject(value, label);
  for (const method of ["prepare", "go", "inspect", "stop", "abort"]) {
    requiredFunction(value[method], `${label}.${method}`);
  }
  return value;
}

function attemptKey(relationId, attemptId) {
  return `${relationId}\0${attemptId}`;
}

function ownerKey(prefix, value) {
  try {
    return `${prefix}:${canonicalJson(value)}`;
  } catch {
    throw ownershipError();
  }
}

function unownedCleanupEvidence() {
  return {
    schemaVersion: "1",
    disposition: "unconfirmed",
    lastRuntimeCheckpoint: "inspect-pending",
    runtimeInvoked: false,
    leaseReturned: false,
    continuationRegistered: false,
    latePrepare: "not-applicable",
    lateGo: "not-applicable",
    abortRequested: false,
    abortCompleted: false,
    containmentConfirmed: false,
    exactHandleIdentity: null,
    processExited: null,
    listenerClosed: null,
    sessionsClosed: null,
    childrenExited: null,
    reasonCode: "relation_file_service_runtime_cleanup_unconfirmed"
  };
}

export function createRelationServiceProductWiring(options = {}) {
  return createProductWiring(options, "rclone");
}

export function createSftpRelationServiceProductWiring(options = {}) {
  return createProductWiring(options, "sftp");
}

function createProductWiring(options, runtimeMode) {
  assertAllowedKeys(
    options,
    runtimeMode === "sftp"
      ? ["catalog", "runtimePackage", "testDependencies"]
      : ["catalog", "rclonePath", "runtimePackage", "testDependencies"],
    "relation service wiring options"
  );
  const { catalog, runtimePackage, rclonePath, testDependencies } = options;
  requiredFunction(catalog?.getForStart, "catalog.getForStart");
  requiredFunction(catalog?.withStartBinding, "catalog.withStartBinding");
  const fixedRuntimePackage = runtimeMode === "sftp"
    ? validateSftpRuntimePackage(runtimePackage)
    : validateRuntimePackage(runtimePackage);
  const fixedRclonePath = runtimeMode === "rclone"
    ? canonicalAbsolutePath(rclonePath, "rclonePath")
    : null;
  const dependencies = testDependencies ?? {};
  assertAllowedKeys(
    dependencies,
    ["createRuntime", "ensureDirectoryRootProtection"],
    "testDependencies"
  );
  const createRuntime = dependencies.createRuntime == null
    ? (runtimeMode === "sftp"
      ? createLinuxSftpRelationFileServiceRuntime
      : createLinuxRelationFileServiceRuntime)
    : requiredFunction(dependencies.createRuntime, "testDependencies.createRuntime");
  const ensureProtection = dependencies.ensureDirectoryRootProtection == null
    ? ensureDirectoryRootProtection
    : requiredFunction(
      dependencies.ensureDirectoryRootProtection,
      "testDependencies.ensureDirectoryRootProtection"
    );

  const protectedAttempts = new Map();
  const adaptersByRelation = new Map();
  const leaseOwners = new Map();
  const handleOwners = new Map();

  async function loadSnapshot(relationId) {
    const snapshot = await catalog.getForStart(relationId);
    return validateCatalogSnapshot(snapshot, relationId);
  }

  function findOrCreateAdapter(relationId, snapshot, digest) {
    const entries = adaptersByRelation.get(relationId) ?? [];
    const existing = entries.find(entry => entry.digest === digest);
    if (existing) {
      return existing.adapter;
    }
    const runtimeOptions = {
      supervisorPath: fixedRuntimePackage.supervisorPath,
      rootPath: snapshot.directoryRoot.canonicalRoot,
      authorizedKeysPath: snapshot.authorization.authorizedKeysPath,
      hostKeyPath: snapshot.hostKey.path
    };
    if (runtimeMode === "sftp") {
      Object.assign(runtimeOptions, {
        execServicePath: fixedRuntimePackage.helperPath,
        signalServicePath: fixedRuntimePackage.helperPath,
        servicePath: fixedRuntimePackage.servicePath,
        serviceUser: RELATION_SERVICE_SFTP_USER
      });
    } else {
      Object.assign(runtimeOptions, {
        execServicePath: fixedRuntimePackage.execServicePath,
        signalServicePath: fixedRuntimePackage.signalServicePath,
        rclonePath: fixedRclonePath
      });
    }
    const adapter = requireRuntimeAdapter(createRuntime(Object.freeze(runtimeOptions)), `relation runtime adapter for ${relationId}`);
    entries.push(Object.freeze({ digest, adapter }));
    adaptersByRelation.set(relationId, entries);
    return adapter;
  }

  function registerPreparedOwnership(adapter, prepared, attempt, fence) {
    if (!isPlainObject(prepared)) {
      return;
    }
    if (Object.hasOwn(prepared, "lease") && prepared.lease != null) {
      if (leaseOwners.has(prepared.lease)) {
        throw wiringError("runtime lease ownership already exists");
      }
      leaseOwners.set(prepared.lease, Object.freeze({
        adapter,
        relationId: attempt.relationId,
        snapshotDigest: attempt.snapshotDigest,
        fence
      }));
    }
    if (Object.hasOwn(prepared, "handle") && prepared.handle != null) {
      const key = ownerKey("handle", prepared.handle);
      const existing = handleOwners.get(key);
      if (existing && existing !== adapter) {
        throw wiringError("runtime ownership maps contain a conflicting adapter");
      }
      handleOwners.set(key, adapter);
    }
  }

  const runtime = Object.freeze({
    async prepare(request = {}, details = {}) {
      assertExactKeys(request, ["launch"], "runtime prepare request");
      assertAllowedKeys(details, ["fence", "signal"], "runtime prepare details");
      const fence = validateFence(details.fence);
      const key = attemptKey(fence.relationId, fence.attemptId);
      const attempt = protectedAttempts.get(key);
      if (!attempt) {
        throw wiringError("runtime prepare has no protected configuration attempt");
      }
      if (attempt.relationId !== fence.relationId
        || attempt.operationId !== fence.operationId
        || attempt.generation !== fence.generation
        || attempt.protectionDigest !== fence.protectionDigest) {
        throw wiringError("runtime prepare fence does not match the protected attempt");
      }
      protectedAttempts.delete(key);

      const currentSnapshot = await loadSnapshot(fence.relationId);
      if (snapshotDigest(currentSnapshot) !== attempt.snapshotDigest) {
        throw wiringError("catalog configuration changed after protection");
      }
      assertExactKeys(request.launch, ["listener"], "runtime launch");
      if (canonicalJson(request.launch.listener)
        !== canonicalJson(attempt.snapshot.listener)) {
        throw wiringError("runtime launch listener does not match catalog");
      }

      const adapter = findOrCreateAdapter(
        fence.relationId,
        attempt.snapshot,
        attempt.snapshotDigest
      );
      const prepared = await adapter.prepare(
        Object.freeze({
          launch: Object.freeze({
            listener: Object.freeze({ ...attempt.snapshot.listener })
          })
        }),
        Object.freeze({
          signal: details.signal,
          fence
        })
      );
      registerPreparedOwnership(adapter, prepared, attempt, fence);
      return prepared;
    },

    async go(lease, details = {}) {
      assertAllowedKeys(details, ["fence", "signal"], "runtime go details");
      const owner = leaseOwners.get(lease);
      if (!owner) {
        throw ownershipError();
      }
      return catalog.withStartBinding(owner.relationId, async boundSnapshot => {
        const fence = validateFence(details.fence);
        if (canonicalJson(fence) !== canonicalJson(owner.fence)) {
          throw wiringError("runtime go fence does not match the prepared attempt");
        }
        const snapshot = validateCatalogSnapshot(
          boundSnapshot,
          owner.relationId
        );
        if (snapshotDigest(snapshot) !== owner.snapshotDigest) {
          throw wiringError("catalog configuration changed after prepare");
        }
        return owner.adapter.go(lease, { ...details, fence });
      });
    },

    async inspect(handle, details = {}) {
      const adapter = handleOwners.get(ownerKey("handle", handle));
      if (adapter) {
        return adapter.inspect(handle, details);
      }
      if (details.purpose === "cleanup") {
        return unownedCleanupEvidence();
      }
      return {
        owned: false,
        reason: "runtime_ownership_unconfirmed"
      };
    },

    async stop(handle, details = {}) {
      const adapter = handleOwners.get(ownerKey("handle", handle));
      if (!adapter) {
        throw ownershipError();
      }
      return adapter.stop(handle, details);
    },

    async abort(lease, details = {}) {
      const owner = leaseOwners.get(lease);
      if (!owner) {
        throw ownershipError();
      }
      return owner.adapter.abort(lease, details);
    }
  });

  const protection = Object.freeze({
    async verify(request = {}) {
      assertAllowedKeys(
        request,
        ["fence", "generation", "operationId", "relationId", "signal"],
        "runtime protection request"
      );
      const relationId = identityText(
        request.relationId,
        "protection relationId"
      );
      const operationId = identityText(
        request.operationId,
        "protection operationId"
      );
      const generation = identityText(
        request.generation,
        "protection generation"
      );
      const fence = validateFence(request.fence);
      if (fence.relationId !== relationId
        || fence.operationId !== operationId
        || fence.generation !== generation
        || fence.protectionDigest !== null) {
        throw wiringError("protection request does not match its runtime fence");
      }

      const snapshot = await loadSnapshot(relationId);
      let receipt;
      try {
        receipt = await ensureProtection(snapshot.directoryRoot, {
          helperPath: fixedRuntimePackage.helperPath,
          helperSha256: fixedRuntimePackage.helperSha256,
          signal: request.signal
        });
      } catch (error) {
        if (error?.code === "root_protection_helper_failed") {
          const helperCode = typeof error.helperCode === "string" && /^[a-z0-9_]{1,80}$/.test(error.helperCode)
            ? error.helperCode
            : "unknown";
          console.error(`[sfsc] relation_root_protection_failed code=root_protection_helper_failed helperCode=${helperCode}`);
        }
        throw error;
      }
      if (receipt == null) {
        throw wiringError("directory-root protection returned no receipt");
      }
      const digest = sha256Text(canonicalJson(receipt));
      const key = attemptKey(relationId, fence.attemptId);
      if (protectedAttempts.has(key)) {
        throw wiringError("protected runtime attempt already exists");
      }
      protectedAttempts.set(key, Object.freeze({
        relationId,
        operationId,
        generation,
        protectionDigest: digest,
        snapshot,
        snapshotDigest: snapshotDigest(snapshot)
      }));
      return Object.freeze({ digest });
    }
  });

  async function makeStartRequest(input = {}) {
    assertExactKeys(
      input,
      ["expectedHandleDigest", "operationId", "relationId"],
      "start request inputs"
    );
    const relationId = identityText(input.relationId, "relationId");
    const operationId = identityText(input.operationId, "operationId");
    if (input.expectedHandleDigest !== ""
      && (typeof input.expectedHandleDigest !== "string"
        || !SHA256_PATTERN.test(input.expectedHandleDigest))) {
      throw wiringError(
        "expectedHandleDigest must be empty or a lowercase SHA-256 digest"
      );
    }
    const snapshot = await loadSnapshot(relationId);
    return Object.freeze({
      relationId,
      operationId,
      identity: stableIdentity(snapshot.binding),
      launch: Object.freeze({
        listener: Object.freeze({ ...snapshot.listener })
      }),
      expectedHandleDigest: input.expectedHandleDigest
    });
  }

  return Object.freeze({
    runtime,
    protection,
    makeStartRequest
  });
}
