import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open as openFile,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve
} from "node:path";

import {
  assertEnrollmentAuthorityState,
  assertEnrollmentStateTransition
} from "../core/enrollmentAuthority.js";
import {
  canonicalJson,
  normalizeEnrollmentBinding
} from "../core/enrollmentProtocol.js";
import { acquireServerStateLock } from "../core/serverStateLock.js";
import {
  deepFreeze,
  parseStrictStateJson,
  STARTUP_STATE_POLICY_LIMITS
} from "./strictStateJson.js";

const SCHEMA_VERSION = "1";
const CURRENT_SCHEMA_VERSION = "2";
const CATALOG_KIND = "syncraft-relation-service-bindings";
const ROOT_RECORD_KIND = "syncraft-directory-root-record";
const ROOT_MARKER_KIND = "syncraft-directory-root";
const ROOT_MARKER_NAME = ".syncraft-root.json";
const MAX_KEY_FILE_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]{16,128}$/;
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{16,128}$/;
const ROOT_ID_PATTERN = /^root_[A-Za-z0-9_-]{16,128}$/;
const RELATION_ID_PATTERN = /^rel_[A-Za-z0-9_-]{16,128}$/;
const MARKER_ID_PATTERN = /^mkr_[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID_PATTERN = /^rootop_[A-Za-z0-9_-]{16,128}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const PENDING_ROOT_KEYS = [
  "canonicalRoot",
  "createdAt",
  "kind",
  "marker",
  "markerId",
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
const ACTIVE_ROOT_KEYS = [
  ...PENDING_ROOT_KEYS,
  "activatedAt",
  "markerIdentity",
  "markerSync"
];
const ROOT_IMMUTABLE_KEYS = [
  "canonicalRoot",
  "createdAt",
  "kind",
  "marker",
  "markerId",
  "mountEvidence",
  "operationId",
  "rootId",
  "rootIdentity",
  "schemaVersion",
  "serverId",
  "shareId"
];
const MARKER_KEYS = [
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
const LINUX_MOUNT_KEYS = [
  "fsType",
  "majorMinor",
  "mountId",
  "mountPoint",
  "mountRoot",
  "parentId",
  "platform",
  "source"
];

class RelationServiceBindingCatalogError extends Error {
  constructor(code, message, options = {}) {
    super(
      message,
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "RelationServiceBindingCatalogError";
    this.code = code;
  }
}

/**
 * Open the single durable relation-service configuration file.
 *
 * withExclusiveLock receives one async callback. The callback owns the
 * project server-state lock for its complete duration.
 */
export async function openRelationServiceBindingCatalog(options = {}) {
  assertAllowedKeys(
    options,
    ["initialState", "mode", "path", "withExclusiveLock"],
    "catalog open options"
  );
  const statePath = canonicalAbsolutePath(
    options.path,
    "catalog path"
  );
  const mode = options.mode ?? "require-existing";
  if (mode !== "require-existing" && mode !== "create") {
    throw catalogError(
      "relation_service_binding_catalog_input_invalid",
      "catalog mode must be require-existing or create"
    );
  }
  if (options.withExclusiveLock != null
    && typeof options.withExclusiveLock !== "function") {
    throw catalogError(
      "relation_service_binding_catalog_input_invalid",
      "withExclusiveLock must be a function"
    );
  }
  if (mode === "require-existing" && options.initialState != null) {
    throw catalogError(
      "relation_service_binding_catalog_input_invalid",
      "initialState is only accepted in create mode"
    );
  }

  const parentPath = dirname(statePath);
  await assertPrivateDirectory(parentPath, "catalog parent directory");
  const withExclusiveLock = options.withExclusiveLock
    ?? createDefaultExclusiveLock(statePath);

  const opened = await withExclusiveLock(async () => {
    if (await pathExists(statePath)) {
      return readCatalogState(statePath);
    }
    if (mode === "require-existing") {
      throw catalogError(
        "relation_service_binding_catalog_missing",
        "relation-service binding catalog does not exist"
      );
    }
    if (options.initialState == null) {
      throw catalogError(
        "relation_service_binding_catalog_input_invalid",
        "create mode requires initialState when the catalog is absent"
      );
    }
    const initialState = validateCatalogState(migrateCatalogState(options.initialState, statePath), {
      configPath: statePath,
      createInitial: true
    });
    await writeCatalogState(statePath, initialState);
    return readCatalogState(statePath);
  });

  const serverId = opened.authority.serverId;
  assertServerIdentity(opened, serverId);

  async function readLockedState() {
    const current = await readCatalogState(statePath);
    assertServerIdentity(current, serverId);
    return current;
  }

  async function startSnapshotLocked(relationId) {
    const current = await readLockedState();
    return createStartSnapshot(current, relationId, statePath);
  }

  const facade = {
    async read() {
      return withExclusiveLock(async () => (
        structuredClone(await readLockedState())
      ));
    },

    async update(request = {}, updater) {
      assertExactKeys(request, ["expectedRevision"], "catalog update request");
      if (!Number.isSafeInteger(request.expectedRevision)
        || request.expectedRevision < 0) {
        throw catalogError(
          "relation_service_binding_catalog_input_invalid",
          "expectedRevision must be a non-negative safe integer"
        );
      }
      if (typeof updater !== "function") {
        throw catalogError(
          "relation_service_binding_catalog_input_invalid",
          "update requires an updater function"
        );
      }

      return withExclusiveLock(async () => {
        const current = await readLockedState();
        if (request.expectedRevision !== current.revision) {
          throw catalogError(
            "relation_service_binding_catalog_conflict",
            "relation-service binding catalog revision changed"
          );
        }

        const working = structuredClone(current);
        const updated = await updater(working);
        const proposed = updated === undefined ? working : updated;
        if (!isPlainObject(proposed)
          || proposed.revision !== current.revision) {
          throw catalogError(
            "relation_service_binding_catalog_invalid",
            "updater must return the current revision without advancing it"
          );
        }
        const next = structuredClone(proposed);
        next.revision = current.revision + 1;
        const validated = validateCatalogState(next, {
          configPath: statePath,
          previous: current
        });
        assertServerIdentity(validated, serverId);
        await writeCatalogState(statePath, validated);
        return structuredClone(validated);
      });
    },

    async getForStart(relationId) {
      const normalizedRelationId = relationIdentity(
        relationId,
        "relationId"
      );
      return withExclusiveLock(async () => (
        startSnapshotLocked(normalizedRelationId)
      ));
    },

    async withStartBinding(relationId, task) {
      const normalizedRelationId = relationIdentity(
        relationId,
        "relationId"
      );
      if (typeof task !== "function") {
        throw catalogError(
          "relation_service_binding_catalog_input_invalid",
          "withStartBinding requires a task function"
        );
      }
      return withExclusiveLock(async () => {
        const snapshot = await startSnapshotLocked(normalizedRelationId);
        return task(snapshot);
      });
    }
  };

  return Object.freeze(facade);
}

function createDefaultExclusiveLock(statePath) {
  return async (task) => {
    const release = acquireServerStateLock({
      dataDir: dirname(statePath),
      statePath,
      lockPath: `${statePath}.lock`
    });
    try {
      return await task();
    } finally {
      release();
    }
  };
}

async function readCatalogState(statePath) {
  const file = await readBoundedRegularFile(statePath, {
    label: "relation-service binding catalog",
    maxBytes: STARTUP_STATE_POLICY_LIMITS.maxBytes,
    requirePrivateMode: true
  });
  let parsed;
  try {
    parsed = parseStrictStateJson(
      file.bytes,
      STARTUP_STATE_POLICY_LIMITS
    );
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog is not strict JSON",
      { cause: error }
    );
  }
  let canonical;
  try {
    canonical = canonicalJson(parsed.value);
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog cannot be canonicalized",
      { cause: error }
    );
  }
  if (canonical !== file.bytes.toString("utf8")) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog is not canonical JSON"
    );
  }
  if (parsed.value?.schemaVersion === SCHEMA_VERSION) {
    const legacy = validateCatalogState(parsed.value, {
      configPath: statePath,
      legacy: true
    });
    const migrated = validateCatalogState({
      ...legacy,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revocationOperations: {}
    }, { configPath: statePath });
    await writeCatalogState(statePath, migrated);
    return migrated;
  }
  return validateCatalogState(parsed.value, { configPath: statePath });
}

async function writeCatalogState(statePath, value) {
  const parentPath = dirname(statePath);
  await assertPrivateDirectory(parentPath, "catalog parent directory");
  if (await pathExists(statePath)) {
    await assertNotLink(statePath, "relation-service binding catalog");
  }

  let bytes;
  try {
    bytes = Buffer.from(canonicalJson(value), "utf8");
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog cannot be serialized",
      { cause: error }
    );
  }
  if (bytes.length === 0
    || bytes.length > STARTUP_STATE_POLICY_LIMITS.maxBytes) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog exceeds its byte limit"
    );
  }

  const temporaryPath = join(
    parentPath,
    `.${basename(statePath)}.${process.pid}.${
      randomBytes(12).toString("hex")
    }.tmp`
  );
  let created = false;
  try {
    const handle = await openFile(
      temporaryPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL,
      0o600
    );
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      if (process.platform !== "win32") {
        const stat = await handle.stat({ bigint: true });
        if ((stat.mode & 0o777n) !== 0o600n) {
          throw catalogError(
            "relation_service_binding_catalog_file_invalid",
            "temporary catalog file is not mode 0600"
          );
        }
      }
    } finally {
      await handle.close();
    }

    if (await pathExists(statePath)) {
      await assertNotLink(statePath, "relation-service binding catalog");
    }
    await rename(temporaryPath, statePath);
    created = false;
    await syncDirectory(parentPath);
  } finally {
    if (created) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

async function readBoundedRegularFile(
  filePath,
  { label, maxBytes, requirePrivateMode }
) {
  let pathStat;
  try {
    pathStat = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw catalogError(
        "relation_service_binding_catalog_missing",
        `${label} does not exist`,
        { cause: error }
      );
    }
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} cannot be inspected`,
      { cause: error }
    );
  }
  if (pathStat.isSymbolicLink()) {
    throw catalogError(
      "relation_service_binding_catalog_link_denied",
      `${label} cannot be a symlink`
    );
  }
  if (!pathStat.isFile()) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} must be a regular file`
    );
  }
  if (pathStat.size > BigInt(maxBytes)) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} exceeds its byte limit`
    );
  }

  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await openFile(filePath, flags);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "EMLINK") {
      throw catalogError(
        "relation_service_binding_catalog_link_denied",
        `${label} cannot be a symlink`,
        { cause: error }
      );
    }
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} cannot be opened`,
      { cause: error }
    );
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || (pathStat.dev !== 0n
        && before.dev !== 0n
        && before.dev !== pathStat.dev)
      || (pathStat.ino !== 0n
        && before.ino !== 0n
        && before.ino !== pathStat.ino)) {
      throw catalogError(
        "relation_service_binding_catalog_file_invalid",
        `${label} changed while it was opened`
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw catalogError(
        "relation_service_binding_catalog_file_invalid",
        `${label} exceeds its byte limit`
      );
    }
    if (requirePrivateMode
      && process.platform !== "win32"
      && (before.mode & 0o777n) !== 0o600n) {
      throw catalogError(
        "relation_service_binding_catalog_file_invalid",
        `${label} must be mode 0600`
      );
    }

    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (bytes.length > maxBytes
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw catalogError(
        "relation_service_binding_catalog_file_invalid",
        `${label} changed while it was read`
      );
    }
    return Object.freeze({
      bytes,
      stat: before
    });
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(directoryPath, label) {
  const stat = await lstat(directoryPath, { bigint: true }).catch((error) => {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} cannot be inspected`,
      { cause: error }
    );
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} must be a non-symlink directory`
    );
  }
  let resolved;
  try {
    resolved = await realpath(directoryPath);
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} cannot be resolved`,
      { cause: error }
    );
  }
  if (resolved !== directoryPath) {
    throw catalogError(
      "relation_service_binding_catalog_link_denied",
      `${label} must not traverse a symlink`
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} must not grant group or world access`
    );
  }
}

async function syncDirectory(directoryPath) {
  if (process.platform === "win32") {
    return;
  }
  const handle = await openFile(
    directoryPath,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      "catalog path cannot be inspected",
      { cause: error }
    );
  }
}

async function assertNotLink(filePath, label) {
  const stat = await lstat(filePath).catch((error) => {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} cannot be inspected`,
      { cause: error }
    );
  });
  if (stat.isSymbolicLink()) {
    throw catalogError(
      "relation_service_binding_catalog_link_denied",
      `${label} cannot be a symlink`
    );
  }
  if (!stat.isFile()) {
    throw catalogError(
      "relation_service_binding_catalog_file_invalid",
      `${label} must be a regular file`
    );
  }
}

function migrateCatalogState(value, configPath) {
  if (value?.schemaVersion === SCHEMA_VERSION) {
    const legacy = validateCatalogState(value, { configPath, legacy: true });
    return {
      ...legacy,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revocationOperations: {}
    };
  }
  if (value?.schemaVersion === CURRENT_SCHEMA_VERSION) return value;
  throw catalogError(
    "relation_service_binding_catalog_invalid",
    "relation-service binding catalog schema version is unsupported"
  );
}

function validateCatalogState(value, {
  configPath,
  createInitial = false,
  previous,
  legacy = false
} = {}) {
  assertExactKeys(
    value,
    legacy
      ? ["authority", "kind", "relations", "revision", "roots", "schemaVersion", "serverHostKey"]
      : ["authority", "kind", "relations", "revision", "roots", "schemaVersion", "serverHostKey", "revocationOperations"],
    "relation-service binding catalog"
  );
  if (value.schemaVersion !== (legacy ? SCHEMA_VERSION : CURRENT_SCHEMA_VERSION)
    || value.kind !== CATALOG_KIND
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "relation-service binding catalog header is invalid"
    );
  }

  try {
    assertEnrollmentAuthorityState(value.authority);
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog authority is not a complete valid P1 state",
      { cause: error }
    );
  }
  if (!SERVER_ID_PATTERN.test(value.authority.serverId)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog authority serverId is invalid"
    );
  }

  const authority = structuredClone(value.authority);
  const roots = validateRootMap(value.roots, authority.serverId);
  if (createInitial
    && Object.values(roots).some(record => record.status === "active")) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "create mode only accepts an empty or pending-only root registry"
    );
  }
  const serverHostKey = validateServerHostKey(value.serverHostKey);
  assertPlainObject(value.relations, "catalog relations");
  validateRelationMap(
    value.relations,
    roots,
    serverHostKey,
    authority,
    configPath
  );
  const revocationOperations = legacy
    ? {}
    : validateRevocationOperations(value.revocationOperations);

  if (previous != null) {
    assertCatalogTransition(previous, value, roots);
    assertRevocationOperationTransition(previous.revocationOperations, revocationOperations);
  }

  return structuredClone({
    ...value,
    authority,
    roots,
    serverHostKey,
    relations: value.relations,
    ...(legacy ? {} : { revocationOperations })
  });
}

function validateRevocationOperations(value) {
  assertPlainObject(value, "catalog revocation operations");
  const operations = {};
  for (const [operationId, record] of Object.entries(value)) {
    if (!/^revop_[A-Za-z0-9_-]{16,96}$/.test(operationId)) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation operation key is invalid");
    }
    assertPlainObject(record, "revocation operation");
    assertExactKeys(record, [
      "authorityRevokedAt", "createdAt", "lastErrorCode", "operationId",
      "overlayStatus", "relations", "status", "target", "updatedAt"
    ], "revocation operation");
    if (record.operationId !== operationId || !["pending", "complete"].includes(record.status)
      || !["pending", "applied", "not_required"].includes(record.overlayStatus)
      || (record.lastErrorCode !== "" && !/^[a-z0-9_]{1,96}$/.test(record.lastErrorCode))) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation operation status is invalid");
    }
    assertTimestamp(record.authorityRevokedAt, "revocation authorityRevokedAt");
    assertTimestamp(record.createdAt, "revocation createdAt");
    assertTimestamp(record.updatedAt, "revocation updatedAt");
    assertPlainObject(record.target, "revocation target");
    assertExactKeys(record.target, ["identityDigest", "kind", "targetId"], "revocation target");
    if (!["device", "relation"].includes(record.target.kind)
      || typeof record.target.targetId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(record.target.targetId)
      || !SHA256_PATTERN.test(record.target.identityDigest)) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation target identity is invalid");
    }
    if (!Array.isArray(record.relations)) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation relation steps must be an array");
    }
    const relationIds = new Set();
    const relations = record.relations.map((step) => {
      assertPlainObject(step, "revocation relation step");
      assertExactKeys(step, ["identityDigest", "managerOperationId", "relationId", "state"], "revocation relation step");
      if (!RELATION_ID_PATTERN.test(step.relationId)
        || !SHA256_PATTERN.test(step.identityDigest)
        || !/^revstop_[a-f0-9]{40}$/.test(step.managerOperationId)
        || !["pending", "stopped", "absent", "cleanup_required"].includes(step.state)
        || relationIds.has(step.relationId)) {
        throw catalogError("relation_service_binding_catalog_invalid", "revocation relation step is invalid");
      }
      relationIds.add(step.relationId);
      return structuredClone(step);
    });
    if (record.status === "complete"
      && (relations.some(step => !["stopped", "absent"].includes(step.state))
        || !["applied", "not_required"].includes(record.overlayStatus))) {
      throw catalogError("relation_service_binding_catalog_invalid", "completed revocation has unfinished steps");
    }
    operations[operationId] = { ...structuredClone(record), relations };
  }
  return operations;
}

function assertRevocationOperationTransition(previousValue, nextValue) {
  const previous = previousValue || {};
  for (const [operationId, oldRecord] of Object.entries(previous)) {
    const nextRecord = nextValue[operationId];
    if (!nextRecord) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation operation history cannot be removed");
    }
    if (canonicalJson(oldRecord.target) !== canonicalJson(nextRecord.target)
      || oldRecord.authorityRevokedAt !== nextRecord.authorityRevokedAt
      || oldRecord.createdAt !== nextRecord.createdAt
      || oldRecord.relations.length !== nextRecord.relations.length) {
      throw catalogError("relation_service_binding_catalog_invalid", "revocation operation target is immutable");
    }
    if (oldRecord.status === "complete" && nextRecord.status !== "complete") {
      throw catalogError("relation_service_binding_catalog_invalid", "completed revocation cannot be reopened");
    }
    if (oldRecord.overlayStatus === "applied" && nextRecord.overlayStatus === "pending") {
      throw catalogError("relation_service_binding_catalog_invalid", "applied revocation overlay cannot become pending");
    }
    for (let index = 0; index < oldRecord.relations.length; index += 1) {
      const oldStep = oldRecord.relations[index];
      const nextStep = nextRecord.relations[index];
      if (!nextStep || oldStep.relationId !== nextStep.relationId
        || oldStep.identityDigest !== nextStep.identityDigest
        || oldStep.managerOperationId !== nextStep.managerOperationId
        || (["stopped", "absent"].includes(oldStep.state) && oldStep.state !== nextStep.state)) {
        throw catalogError("relation_service_binding_catalog_invalid", "revocation relation target is immutable");
      }
    }
  }
}

function validateRootMap(value, authorityServerId) {
  if (!isPlainObject(value)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog roots must be an object"
    );
  }
  const roots = {};
  for (const [rootId, record] of Object.entries(value)) {
    if (!ROOT_ID_PATTERN.test(rootId)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog root map key is invalid"
      );
    }
    const checked = validateRootRecord(record, authorityServerId);
    if (checked.rootId !== rootId) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog root map key does not match the guard record"
      );
    }
    roots[rootId] = checked;
  }
  return roots;
}

function validateRootRecord(value, authorityServerId) {
  assertPlainObject(value, "directory-root record");
  if (value.schemaVersion !== 1 || value.kind !== ROOT_RECORD_KIND) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root record schema is unsupported"
    );
  }
  const keys = value.status === "active"
    ? ACTIVE_ROOT_KEYS
    : value.status === "pending"
      ? PENDING_ROOT_KEYS
      : null;
  if (keys == null) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root record status is unsupported"
    );
  }
  assertExactKeys(value, keys, "directory-root record");
  requirePattern(
    value.serverId,
    SERVER_ID_PATTERN,
    "directory-root serverId"
  );
  if (value.serverId !== authorityServerId) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root record belongs to a different authority server"
    );
  }
  requirePattern(value.shareId, SHARE_ID_PATTERN, "directory-root shareId");
  requirePattern(value.rootId, ROOT_ID_PATTERN, "directory-root rootId");
  requirePattern(value.markerId, MARKER_ID_PATTERN, "directory-root markerId");
  requirePattern(
    value.operationId,
    OPERATION_ID_PATTERN,
    "directory-root operationId"
  );
  canonicalAbsolutePath(
    value.canonicalRoot,
    "directory-root canonicalRoot"
  );
  assertTimestamp(value.createdAt, "directory-root createdAt");
  assertExactKeys(
    value.rootIdentity,
    ["dev", "ino"],
    "directory-root rootIdentity"
  );
  assertDecimal(value.rootIdentity.dev, "rootIdentity.dev");
  assertDecimal(value.rootIdentity.ino, "rootIdentity.ino");
  validateMountEvidence(value.mountEvidence);
  validateMarkerRecord(value.marker, value);

  const expectedStageName = `.syncraft-root.stage-${value.operationId}`;
  if (value.status === "pending") {
    assertExactKeys(value.stage, ["name"], "pending directory-root stage");
    if (value.stage.name !== expectedStageName) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "pending directory-root stage is not derived from operationId"
      );
    }
  } else {
    assertExactKeys(
      value.stage,
      ["name", "state"],
      "active directory-root stage"
    );
    if (value.stage.name !== expectedStageName
      || value.stage.state !== "installed") {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "active directory-root stage is invalid"
      );
    }
    assertTimestamp(value.activatedAt, "directory-root activatedAt");
    assertExactKeys(
      value.markerIdentity,
      ["dev", "ino", "size"],
      "directory-root markerIdentity"
    );
    for (const key of ["dev", "ino", "size"]) {
      assertDecimal(
        value.markerIdentity[key],
        `markerIdentity.${key}`
      );
    }
    assertExactKeys(
      value.markerSync,
      ["directorySync", "fileSynced"],
      "directory-root markerSync"
    );
    if (value.markerSync.fileSynced !== true
      || !["success", "unsupported"].includes(
        value.markerSync.directorySync
      )) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "directory-root marker sync evidence is invalid"
      );
    }
  }
  return structuredClone(value);
}

function validateMarkerRecord(value, rootRecord) {
  assertExactKeys(value, MARKER_KEYS, "directory-root marker");
  if (value.name !== ROOT_MARKER_NAME) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root marker name is unsupported"
    );
  }
  assertExactKeys(
    value.content,
    MARKER_CONTENT_KEYS,
    "directory-root marker content"
  );
  if (value.content.schemaVersion !== 1
    || value.content.kind !== ROOT_MARKER_KIND) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root marker content schema is unsupported"
    );
  }
  for (const key of [
    "serverId",
    "shareId",
    "rootId",
    "markerId",
    "operationId",
    "createdAt"
  ]) {
    if (value.content[key] !== rootRecord[key]) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        `directory-root marker ${key} does not match its record`
      );
    }
  }
  assertDecimal(value.contentLength, "directory-root marker contentLength");
  if (!SHA256_PATTERN.test(value.contentSha256)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root marker hash is invalid"
    );
  }
  const bytes = Buffer.from(canonicalJson(value.content), "utf8");
  if (BigInt(value.contentLength) !== BigInt(bytes.length)
    || value.contentSha256 !== sha256(bytes)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root marker evidence does not match its content"
    );
  }
}

function validateMountEvidence(value) {
  assertPlainObject(value, "directory-root mountEvidence");
  if (value.platform === "win32") {
    assertExactKeys(
      value,
      ["kind", "platform"],
      "Windows directory-root mountEvidence"
    );
    if (value.kind !== "filesystem-identity-only-v1") {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "Windows directory-root mountEvidence is unsupported"
      );
    }
    return;
  }
  if (value.platform !== "linux") {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root mountEvidence platform is unsupported"
    );
  }
  assertExactKeys(
    value,
    LINUX_MOUNT_KEYS,
    "Linux directory-root mountEvidence"
  );
  for (const key of LINUX_MOUNT_KEYS) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        `directory-root mountEvidence ${key} is invalid`
      );
    }
  }
  if (!isAbsolute(value.mountPoint)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "directory-root mountPoint must be absolute"
    );
  }
}

function validateServerHostKey(value) {
  assertExactKeys(
    value,
    ["path", "publicKeySha256"],
    "catalog serverHostKey"
  );
  const keyPath = canonicalAbsolutePath(
    value.path,
    "catalog serverHostKey.path"
  );
  if (!SHA256_PATTERN.test(value.publicKeySha256)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog serverHostKey.publicKeySha256 is invalid"
    );
  }
  return Object.freeze({
    path: keyPath,
    publicKeySha256: value.publicKeySha256
  });
}

function validateRelationMap(
  value,
  roots,
  serverHostKey,
  authority,
  configPath
) {
  if (!isPlainObject(value)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog relations must be an object"
    );
  }
  if (configPath == null) {
    throw catalogError(
      "relation_service_binding_catalog_input_invalid",
      "configPath is required to validate private paths"
    );
  }
  const configDirectory = dirname(configPath);
  const rootPaths = Object.values(roots).map(
    record => record.canonicalRoot
  );
  assertPathOutsideRoots(configPath, rootPaths, "catalog path");
  assertPathInsidePrivateDirectory(
    serverHostKey.path,
    configDirectory,
    "server host private key"
  );
  assertPathOutsideRoots(
    serverHostKey.path,
    rootPaths,
    "server host private key"
  );
  if (pathComparisonKey(serverHostKey.path)
    === pathComparisonKey(configPath)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog file and server host private key must be different files"
    );
  }

  const usedPorts = new Set();
  const usedAuthorizedKeysPaths = new Set();
  for (const [relationId, relation] of Object.entries(value)) {
    if (!RELATION_ID_PATTERN.test(relationId)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation map key is invalid"
      );
    }
    assertExactKeys(
      relation,
      ["authorization", "listener", "rootId"],
      "catalog relation"
    );
    requirePattern(
      relation.rootId,
      ROOT_ID_PATTERN,
      "catalog relation rootId"
    );
    const root = roots[relation.rootId];
    if (!root) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation references an unknown root"
      );
    }

    const grant = authority.relationGrants[relationId];
    if (!grant) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation has no authority grant"
      );
    }
    let binding;
    try {
      binding = normalizeEnrollmentBinding(grant.binding);
    } catch (error) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation grant binding is invalid",
        { cause: error }
      );
    }
    if (canonicalJson(binding) !== canonicalJson(grant.binding)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation grant binding is not normalized"
      );
    }
    if (binding.identity.relationId !== relationId
      || binding.identity.rootId !== relation.rootId
      || root.serverId !== binding.identity.serverId
      || root.shareId !== binding.identity.shareId
      || root.rootId !== binding.identity.rootId) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation, guard root, and authority grant identities differ"
      );
    }
    const device = authority.devices[binding.identity.deviceId];
    if (!device) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation references an unknown authority device"
      );
    }

    assertExactKeys(
      relation.authorization,
      ["authorizedKeysPath", "devicePublicKeyFingerprint", "sha256"],
      "catalog relation authorization"
    );
    const authorizedKeysPath = canonicalAbsolutePath(
      relation.authorization.authorizedKeysPath,
      "catalog relation authorizedKeysPath"
    );
    if (!SHA256_PATTERN.test(relation.authorization.sha256)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation authorizedKeys sha256 is invalid"
      );
    }
    if (!FINGERPRINT_PATTERN.test(
      relation.authorization.devicePublicKeyFingerprint
    )) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation device fingerprint is invalid"
      );
    }
    if (relation.authorization.devicePublicKeyFingerprint
      !== device.publicKeyFingerprint) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation device fingerprint differs from authority"
      );
    }
    assertPathInsidePrivateDirectory(
      authorizedKeysPath,
      configDirectory,
      "relation authorized_keys"
    );
    assertPathOutsideRoots(
      authorizedKeysPath,
      rootPaths,
      "relation authorized_keys"
    );
    const pathKey = pathComparisonKey(authorizedKeysPath);
    if (pathKey === pathComparisonKey(serverHostKey.path)
      || pathKey === pathComparisonKey(configPath)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation authorized_keys path aliases another private file"
      );
    }
    if (usedAuthorizedKeysPaths.has(pathKey)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relations must not reuse authorized_keys paths"
      );
    }
    usedAuthorizedKeysPaths.add(pathKey);

    assertExactKeys(
      relation.listener,
      ["host", "port"],
      "catalog relation listener"
    );
    if (relation.listener.host !== "127.0.0.1"
      || !Number.isSafeInteger(relation.listener.port)
      || relation.listener.port < 1
      || relation.listener.port > 65535) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation listener must be one valid loopback port"
      );
    }
    if (usedPorts.has(relation.listener.port)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog relation listener ports must be unique"
      );
    }
    usedPorts.add(relation.listener.port);
  }
}

function assertCatalogTransition(previous, next, nextRoots) {
  if (previous.authority.serverId !== next.authority.serverId) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog authority serverId cannot change"
    );
  }
  if (canonicalJson(previous.serverHostKey)
    !== canonicalJson(next.serverHostKey)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "server host key rotation requires a controlled migration"
    );
  }
  if (canonicalJson(previous.authority)
    !== canonicalJson(next.authority)) {
    try {
      assertEnrollmentStateTransition(previous.authority, next.authority);
    } catch (error) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "catalog authority changed without a valid P1 state transition",
        { cause: error }
      );
    }
  }
  assertExistingRelationAuthorityStable(previous, next);

  for (const [rootId, nextRoot] of Object.entries(nextRoots)) {
    if (!Object.hasOwn(previous.roots, rootId)
      && nextRoot.status !== "pending") {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "new directory-root records must be created pending"
      );
    }
  }

  for (const [rootId, previousRoot] of Object.entries(previous.roots)) {
    const nextRoot = nextRoots[rootId];
    if (!nextRoot) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing directory-root records cannot be removed"
      );
    }
    for (const key of ROOT_IMMUTABLE_KEYS) {
      if (canonicalJson(previousRoot[key])
        !== canonicalJson(nextRoot[key])) {
        throw catalogError(
          "relation_service_binding_catalog_invalid",
          `existing directory-root ${key} cannot change`
        );
      }
    }
    if (canonicalJson(previousRoot) === canonicalJson(nextRoot)) {
      continue;
    }
    if (previousRoot.status !== "pending"
      || nextRoot.status !== "active"
      || previousRoot.operationId !== nextRoot.operationId
      || previousRoot.stage.name !== nextRoot.stage.name) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing directory-root records may only remain pending or become active"
      );
    }
  }

  for (const [relationId, previousRelation] of Object.entries(
    previous.relations
  )) {
    const nextRelation = next.relations[relationId];
    if (!nextRelation) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing relation bindings cannot be removed"
      );
    }
    if (nextRelation.rootId !== previousRelation.rootId) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "an existing relation cannot be rebound to another root"
      );
    }
  }
}

function assertExistingRelationAuthorityStable(previous, next) {
  for (const relationId of Object.keys(previous.relations)) {
    const previousGrant =
      previous.authority.relationGrants[relationId];
    const nextGrant = next.authority.relationGrants[relationId];
    if (!nextGrant || !next.relations[relationId]) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "an existing relation and its authority grant must remain present"
      );
    }
    const previousBinding = normalizeEnrollmentBinding(
      previousGrant.binding
    );
    const nextBinding = normalizeEnrollmentBinding(nextGrant.binding);
    if (canonicalJson(previousBinding.identity)
      !== canonicalJson(nextBinding.identity)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing relation grant identity cannot change"
      );
    }
    if (previousBinding.baselineEpoch !== nextBinding.baselineEpoch) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing relation baselineEpoch cannot change"
      );
    }
    if (canonicalJson(previousBinding.rootAttestation)
      !== canonicalJson(nextBinding.rootAttestation)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "existing relation rootAttestation cannot change"
      );
    }

    const deviceId = previousBinding.identity.deviceId;
    const previousDevice = previous.authority.devices[deviceId];
    const nextDevice = next.authority.devices[deviceId];
    if (!nextDevice) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "an existing relation device must remain present"
      );
    }
    if (previousDevice.revokedAt !== null
      && nextDevice.revokedAt === null) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "a revoked relation device cannot be restored"
      );
    }
    if (canonicalJson(previousDevice.publicKeyJwk)
        !== canonicalJson(nextDevice.publicKeyJwk)
      || previousDevice.publicKeyFingerprint
        !== nextDevice.publicKeyFingerprint) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "an existing relation device public key cannot change"
      );
    }
    if (previousGrant.revokedAt !== null
      && nextGrant.revokedAt === null) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        "a revoked relation grant cannot be restored"
      );
    }
  }
}

async function createStartSnapshot(state, relationId, configPath) {
  const relation = state.relations[relationId];
  const grant = state.authority.relationGrants[relationId];
  if (!relation || !grant) {
    throw catalogError(
      "relation_service_binding_catalog_not_found",
      "relation-service binding is not configured"
    );
  }
  const binding = normalizeEnrollmentBinding(grant.binding);
  const device = state.authority.devices[binding.identity.deviceId];
  if (!device || device.revokedAt !== null) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "relation-service device is not active"
    );
  }
  if (grant.revokedAt !== null) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "relation-service grant is revoked"
    );
  }
  const root = state.roots[relation.rootId];
  if (!root) {
    throw catalogError(
      "relation_service_binding_catalog_not_ready",
      "relation-service directory root is unavailable"
    );
  }
  if (root.status !== "active") {
    throw catalogError(
      "relation_service_binding_catalog_not_ready",
      "pending directory-root registration cannot authorize start"
    );
  }

  const authorizedKeys = await readBoundedRegularFile(
    relation.authorization.authorizedKeysPath,
    {
      label: "relation authorized_keys",
      maxBytes: MAX_KEY_FILE_BYTES,
      requirePrivateMode: true
    }
  );
  await assertPrivateDirectory(
    dirname(relation.authorization.authorizedKeysPath),
    "relation authorized_keys parent directory"
  );
  if (sha256(authorizedKeys.bytes) !== relation.authorization.sha256) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "relation authorized_keys digest differs from configuration"
    );
  }
  const expectedAuthorizedKeys = authorizedKeysLine(device.publicKeyJwk);
  if (!authorizedKeys.bytes.equals(expectedAuthorizedKeys)
    && !authorizedKeys.bytes.equals(
      Buffer.from(`${expectedAuthorizedKeys.toString("utf8")}\n`, "utf8")
    )) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "relation authorized_keys content is not the enrolled device key"
    );
  }

  const hostKey = await readBoundedRegularFile(state.serverHostKey.path, {
    label: "server host private key",
    maxBytes: MAX_KEY_FILE_BYTES,
    requirePrivateMode: true
  });
  await assertPrivateDirectory(
    dirname(state.serverHostKey.path),
    "server host private key parent directory"
  );
  let hostPublicSha256;
  try {
    const pem = new TextDecoder("utf-8", { fatal: true }).decode(
      hostKey.bytes
    );
    if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")
      || !pem.trimEnd().endsWith("-----END PRIVATE KEY-----")) {
      throw new Error("host key is not unencrypted PKCS8 PEM");
    }
    const privateKey = createPrivateKey({
      key: pem,
      format: "pem"
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("host key is not Ed25519");
    }
    const publicDer = createPublicKey(privateKey).export({
      format: "der",
      type: "spki"
    });
    hostPublicSha256 = sha256(publicDer);
  } catch (error) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "server host private key is not parseable PKCS8 PEM Ed25519",
      { cause: error }
    );
  }
  if (hostPublicSha256 !== state.serverHostKey.publicKeySha256) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "server host public-key fingerprint differs from configuration"
    );
  }

  const configDirectory = dirname(configPath);
  if (!isPathInsideOrEqual(
    relation.authorization.authorizedKeysPath,
    configDirectory
  ) || !isPathInsideOrEqual(state.serverHostKey.path, configDirectory)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "private key paths escaped the catalog directory"
    );
  }

  return deepFreeze({
    binding,
    directoryRoot: root,
    authorization: {
      authorizedKeysPath: relation.authorization.authorizedKeysPath,
      sha256: relation.authorization.sha256,
      devicePublicKeyFingerprint:
        relation.authorization.devicePublicKeyFingerprint
    },
    hostKey: {
      path: state.serverHostKey.path,
      publicKeySha256: state.serverHostKey.publicKeySha256
    },
    listener: {
      host: relation.listener.host,
      port: relation.listener.port
    }
  });
}

function authorizedKeysLine(publicKeyJwk) {
  if (!isPlainObject(publicKeyJwk)
    || publicKeyJwk.kty !== "OKP"
    || publicKeyJwk.crv !== "Ed25519"
    || typeof publicKeyJwk.x !== "string") {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "enrolled device public key is not Ed25519 OKP"
    );
  }
  const publicKey = Buffer.from(publicKeyJwk.x, "base64url");
  if (publicKey.length !== 32
    || publicKey.toString("base64url") !== publicKeyJwk.x) {
    throw catalogError(
      "relation_service_binding_catalog_authorization_denied",
      "enrolled device public key encoding is invalid"
    );
  }
  const wire = Buffer.concat([
    sshString(Buffer.from("ssh-ed25519", "ascii")),
    sshString(publicKey)
  ]);
  return Buffer.from(
    `ssh-ed25519 ${wire.toString("base64")}`,
    "utf8"
  );
}

function sshString(value) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function assertServerIdentity(state, expectedServerId) {
  if (state.authority.serverId !== expectedServerId) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      "catalog authority serverId changed after open"
    );
  }
}

function assertPathInsidePrivateDirectory(filePath, directory, label) {
  if (!isPathInsideOrEqual(filePath, directory)
    || filePath === directory) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} must reside inside the catalog private directory`
    );
  }
}

function assertPathOutsideRoots(filePath, rootPaths, label) {
  for (const rootPath of rootPaths) {
    if (isPathInsideOrEqual(filePath, rootPath)) {
      throw catalogError(
        "relation_service_binding_catalog_invalid",
        `${label} must remain outside configured directory roots`
      );
    }
  }
}

function isPathInsideOrEqual(candidate, parent) {
  const child = relative(parent, candidate);
  return child === ""
    || (child !== ".."
      && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(child));
}

function pathComparisonKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function relationIdentity(value, label) {
  requirePattern(value, RELATION_ID_PATTERN, label);
  return value;
}

function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || parse(value).root === value) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} must be a canonical absolute non-root path`
    );
  }
  return value;
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} has an invalid format`
    );
  }
  return value;
}

function assertDecimal(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} must be a canonical decimal string`
    );
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string"
    || !TIMESTAMP_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} must be a canonical UTC timestamp`
    );
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} must be an object`
    );
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} contains unsupported or missing fields`
    );
  }
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) {
    throw catalogError(
      "relation_service_binding_catalog_invalid",
      `${label} contains unsupported fields`
    );
  }
}

function isPlainObject(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalogError(code, message, options = {}) {
  return new RelationServiceBindingCatalogError(code, message, options);
}
