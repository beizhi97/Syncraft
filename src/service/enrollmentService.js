import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  assertEnrollmentAuthorityState,
  consumeOneTimeEnrollmentCode,
  issueOneTimeEnrollmentCode,
  verifySignedAuthorizationRequest
} from "../core/enrollmentAuthority.js";
import {
  canonicalJson,
  createChannelConfigCode,
  createEnrollmentIdentityId,
  decodeOneTimeEnrollmentCode,
  normalizeEd25519PublicKey,
  normalizeEnrollmentBindings,
  normalizeAuthorizationRequest,
  verifyAuthorizationRequestSignature,
  timestampFromClock
} from "../core/enrollmentProtocol.js";
import { createHttpError } from "../core/errors.js";
import { normalizeDataAuthorizationPayload, signDataAuthorizationPayload } from "../core/dataAuthorization.js";
import { CHANNEL_IMPORT_CODE_PREFIX } from "../core/channelImportCode.js";
import { acquireServerStateLock } from "../core/serverStateLock.js";
import { parseStrictStateJson, STARTUP_STATE_POLICY_LIMITS } from "./strictStateJson.js";
import { openRelationServiceBindingCatalog } from "./relationServiceBindingCatalog.js";

const STATE_KIND = "sfsc-enrollment-service-state";
const STATE_VERSION = 2;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{16,128}$/;
const DEVICE_ID = /^dev_[A-Za-z0-9_-]{16,128}$/;
const CHANNEL_REVISION = /^chrev_[A-Za-z0-9_-]{16,128}$/;
const DATA_AUTHORIZATION_START_FAILURE_CODES = new Set([
  "root_protection_helper_failed",
  "relation_file_service_start_blocked",
  "relation_file_service_owner_fatal",
  "relation_file_service_protection_settlement_unconfirmed",
  "relation_file_service_runtime_timeout",
  "relation_file_service_runtime_cleanup_unconfirmed",
  "relation_file_service_cleanup_required",
  "relation_file_service_commit_uncertain"
]);

function safeDiagnosticCode(value) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value) ? value : "unknown";
}

function serviceError(code, message, status = 400) {
  return createHttpError(code, status, message);
}

function initialState(serverId, nowMs) {
  const createdAt = timestampFromClock(nowMs);
  return {
    kind: STATE_KIND,
    version: STATE_VERSION,
    revision: 0,
    serverId,
    createdAt,
    updatedAt: createdAt,
    requests: {}
  };
}

function validateState(value, serverId) {
  if (!value || !isRecord(value)
    || value.kind !== STATE_KIND || value.version !== STATE_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || value.serverId !== serverId
    || !isRecord(value.requests)) {
    throw serviceError("enrollment_state_invalid", "Enrollment service state is invalid", 500);
  }
  if (Object.keys(value).sort().join(",") !== "createdAt,kind,requests,revision,serverId,updatedAt,version") {
    throw serviceError("enrollment_state_invalid", "Enrollment metadata state has unexpected fields", 500);
  }
  for (const [requestId, record] of Object.entries(value.requests)) {
    if (!REQUEST_ID.test(requestId) || !record || record.requestId !== requestId
      || !DEVICE_ID.test(record.deviceId) || !CHANNEL_REVISION.test(record.channelRevision)
      || !["pending", "issued", "consumed"].includes(record.status)
      || typeof record.publicKeyFingerprint !== "string"
      || !isRecord(record.publicKeyJwk)) {
      throw serviceError("enrollment_state_invalid", "Enrollment request state is invalid", 500);
    }
    const expectedKeys = record.status === "pending"
      ? ["channelRevision", "createdAt", "deviceId", "enrollmentId", "expiresAt", "publicKeyFingerprint", "publicKeyJwk", "requestId", "status"]
      : record.status === "issued"
        ? ["channelRevision", "createdAt", "deviceId", "enrollmentId", "expiresAt", "issuedCode", "publicKeyFingerprint", "publicKeyJwk", "requestId", "status"]
        : ["channelRevision", "consumedAt", "createdAt", "deviceId", "enrollmentId", "expiresAt", "publicKeyFingerprint", "publicKeyJwk", "requestId", "status"];
    const actualKeys = Object.keys(record).sort().join(",");
    if ((actualKeys !== [...expectedKeys].sort().join(",")
        && !(record.status === "consumed" && actualKeys === [...expectedKeys, "issuedCode"].sort().join(",")))
      || !Number.isFinite(Date.parse(record.createdAt))
      || new Date(record.createdAt).toISOString() !== record.createdAt
      || normalizeEd25519PublicKey(record.publicKeyJwk).fingerprint !== record.publicKeyFingerprint
      || (record.status === "pending" && (record.enrollmentId !== null || record.expiresAt !== null))
      || (record.status !== "pending" && (typeof record.enrollmentId !== "string"
        || !Number.isFinite(Date.parse(record.expiresAt))
        || new Date(record.expiresAt).toISOString() !== record.expiresAt))
      || (record.status === "issued" && typeof record.issuedCode !== "string")
      || (record.status === "consumed" && record.issuedCode != null && typeof record.issuedCode !== "string")
      || (record.status === "consumed" && (!Number.isFinite(Date.parse(record.consumedAt))
        || new Date(record.consumedAt).toISOString() !== record.consumedAt))) {
      throw serviceError("enrollment_state_invalid", "Enrollment request state is invalid", 500);
    }
  }
  return value;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function loadState(path, serverId, nowMs, catalogAuthority) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw serviceError("enrollment_state_invalid", "Enrollment state must be a regular non-link file", 500);
    }
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw serviceError("enrollment_state_invalid", "Enrollment state must have mode 0600", 500);
    }
    const bytes = await readFile(path);
    const parsed = parseStrictStateJson(bytes, STARTUP_STATE_POLICY_LIMITS);
    if (canonicalJson(parsed.value) !== bytes.toString("utf8")) {
      throw serviceError("enrollment_state_invalid", "Enrollment state is not canonical JSON", 500);
    }
    if (parsed.value.version === 1) {
      const oldAuthority = parsed.value.authority;
      try { assertEnrollmentAuthorityState(oldAuthority); }
      catch { throw serviceError("enrollment_state_invalid", "Legacy enrollment authority state is invalid", 500); }
      const nonEmpty = oldAuthority.revision > 0
        || Object.keys(oldAuthority.enrollmentRecords).length > 0
        || Object.keys(oldAuthority.devices).length > 0
        || Object.keys(oldAuthority.relationGrants).length > 0
        || Object.keys(oldAuthority.authorizationNonces).length > 0;
      if (nonEmpty && canonicalJson(oldAuthority) !== canonicalJson(catalogAuthority)) {
        throw serviceError("enrollment_state_conflict", "Legacy enrollment authority conflicts with the catalog authority; controlled migration is required", 409);
      }
      const migrated = { ...parsed.value, version: STATE_VERSION };
      delete migrated.authority;
      validateState(migrated, serverId);
      await writeState(path, migrated);
      return migrated;
    }
    return validateState(parsed.value, serverId);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return initialState(serverId, nowMs);
  }
}

async function writeState(path, state) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw serviceError("enrollment_state_invalid", "Enrollment state directory must be a non-link directory", 500);
  }
  const existing = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw serviceError("enrollment_state_invalid", "Enrollment state target must be a regular non-link file", 500);
  }
  const bytes = Buffer.from(canonicalJson(state), "utf8");
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(parent, fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function pendingSummary(record) {
  return {
    requestId: record.requestId,
    deviceId: record.deviceId,
    channelRevision: record.channelRevision,
    publicKeyFingerprint: record.publicKeyFingerprint,
    createdAt: record.createdAt,
    status: record.status
  };
}

function metadataFromEnrollment(record, issuedCode = null) {
  const metadata = {
    requestId: record.requestId,
    deviceId: record.deviceId,
    channelRevision: record.channelRevision,
    publicKeyFingerprint: record.publicKeyFingerprint,
    publicKeyJwk: record.publicKeyJwk,
    createdAt: record.issuedAt,
    status: record.consumedAt === null ? "issued" : "consumed",
    enrollmentId: record.enrollmentId,
    expiresAt: record.expiresAt
  };
  if (record.consumedAt !== null) metadata.consumedAt = record.consumedAt;
  if (issuedCode != null) metadata.issuedCode = issuedCode;
  return metadata;
}

function reconcileRequestMetadata(state, authority) {
  const next = structuredClone(state);
  const records = new Map(Object.values(authority.enrollmentRecords).map(record => [record.requestId, record]));
  for (const [requestId, metadata] of Object.entries(next.requests)) {
    const enrollment = records.get(requestId);
    if (enrollment) {
      if (metadata.deviceId !== enrollment.deviceId
        || metadata.channelRevision !== enrollment.channelRevision
        || metadata.publicKeyFingerprint !== enrollment.publicKeyFingerprint) {
        throw serviceError("enrollment_state_conflict", "Request metadata conflicts with catalog authority", 409);
      }
      if (metadata.status !== "pending" && metadata.issuedCode) {
        try {
          const payload = decodeOneTimeEnrollmentCode(metadata.issuedCode, { nowMs: Date.parse(enrollment.issuedAt) });
          if (createHash("sha256").update(payload.secret, "utf8").digest("hex") !== enrollment.secretHash) {
            throw new Error("code secret does not match");
          }
        } catch {
          throw serviceError("enrollment_state_conflict", "Persisted issued code does not match catalog authority", 409);
        }
      }
      if (enrollment.consumedAt === null && typeof metadata.issuedCode !== "string") {
        throw serviceError("enrollment_state_conflict", "Issued code metadata is missing; controlled recovery is required", 409);
      }
      metadata.status = enrollment.consumedAt === null ? "issued" : "consumed";
      metadata.enrollmentId = enrollment.enrollmentId;
      metadata.expiresAt = enrollment.expiresAt;
      if (enrollment.consumedAt !== null) metadata.consumedAt = enrollment.consumedAt;
      else delete metadata.consumedAt;
      continue;
    }
    if (metadata.status !== "pending") {
      metadata.status = "pending";
      metadata.enrollmentId = null;
      metadata.expiresAt = null;
      delete metadata.consumedAt;
      delete metadata.issuedCode;
    }
  }
  for (const [requestId, enrollment] of records) {
    if (!next.requests[requestId]) {
      if (enrollment.consumedAt === null) {
        throw serviceError("enrollment_state_conflict", "Issued request metadata is missing its recoverable code", 409);
      }
      next.requests[requestId] = metadataFromEnrollment(enrollment);
    }
  }
  return next;
}

export function createEnrollmentService({ statePath, catalogPath, signerPath, activeChannelRevision = "", allowedBootstrapOrigins = [], now = () => Date.now() } = {}) {
  if (typeof statePath !== "string" || typeof catalogPath !== "string" || typeof signerPath !== "string") {
    throw new TypeError("Enrollment service requires statePath, catalogPath, and signerPath");
  }
  let queue = Promise.resolve();
  let lockedServerId = null;
  let releaseLock = null;
  let currentActiveChannelRevision = activeChannelRevision;
  let currentAllowedBootstrapOrigins = [...allowedBootstrapOrigins];
  let dataAuthorizationProvider = null;
  let channelRenewalProvider = null;
  let dataAuthorizationQueue = Promise.resolve();
  const verifiedAuthorizationContexts = new WeakSet();
  const usedAuthorizationContexts = new WeakSet();

  async function withState(task) {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      let catalog;
      try {
        catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
      } catch (error) {
        if (error?.code === "relation_service_binding_catalog_missing") {
          throw serviceError("enrollment_catalog_not_ready", "Enrollment requires an existing relation catalog", 503);
        }
        if (error?.code === "relation_service_binding_catalog_file_invalid"
          && error?.cause?.code === "ENOENT") {
          throw serviceError("enrollment_catalog_not_ready", "Enrollment requires an existing relation catalog", 503);
        }
        throw error;
      }
      const catalogState = await catalog.read();
      const serverId = catalogState.authority.serverId;
      if (lockedServerId && lockedServerId !== serverId) {
        throw serviceError("enrollment_state_invalid", "Enrollment server identity changed", 500);
      }
      ensureServiceLock();
      lockedServerId = serverId;
      const state = reconcileRequestMetadata(
        await loadState(statePath, serverId, now(), catalogState.authority),
        catalogState.authority
      );
      const outcome = await task({ state, catalogState, catalog });
      if (outcome?.nextState && outcome.metadataWritten !== true) {
        outcome.nextState.revision = state.revision + 1;
        outcome.nextState.updatedAt = timestampFromClock(now());
        validateState(outcome.nextState, serverId);
        await writeState(statePath, outcome.nextState);
      }
      return outcome?.result;
    } finally {
      release();
    }
  }

  function ensureServiceLock() {
    if (releaseLock) return;
    releaseLock = acquireServerStateLock({
      dataDir: dirname(statePath),
      statePath,
      lockPath: `${statePath}.lock`,
      onLockLost: error => { throw error; }
    });
  }

  async function initialize() {
    ensureServiceLock();
    await readOrCreateSigner();
  }

  async function createRequest({ input, bodyBytes, rawTarget, proofHeader }) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join(",") !== ["channelRevision", "deviceId", "kind", "protocol", "publicKey", "requestId", "version"].sort().join(",")
      || input.protocol !== "sfsc-enrollment" || input.version !== 1 || input.kind !== "enrollment-request"
      || !REQUEST_ID.test(input.requestId) || !DEVICE_ID.test(input.deviceId) || !CHANNEL_REVISION.test(input.channelRevision)) {
      throw serviceError("enrollment_request_invalid", "Enrollment request shape is invalid");
    }
    const normalizedKey = normalizeEd25519PublicKey(input.publicKey);
    const proof = parseProofHeader(proofHeader, "enrollment-request-proof");
    const bodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
    if (proof.bodySha256 !== bodySha256) throw serviceError("enrollment_request_mismatch", "Request proof body hash does not match", 403);
    const proofPayload = {
      protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request-proof",
      method: "POST", path: rawTarget, bodySha256,
      deviceId: input.deviceId, requestId: input.requestId, channelRevision: input.channelRevision
    };
    if (rawTarget !== "/api/enrollment/v1/requests" || !verify(
      null,
      Buffer.from(canonicalJson(proofPayload), "utf8"),
      createPublicKey({ key: normalizedKey.jwk, format: "jwk" }),
      Buffer.from(proof.signature, "base64url")
    )) throw serviceError("enrollment_auth_invalid", "Enrollment request proof signature is invalid", 401);
    return withState(async ({ state, catalogState }) => {
      const authorityRecord = Object.values(catalogState.authority.enrollmentRecords)
        .find(item => item.requestId === input.requestId);
      const existing = state.requests[input.requestId];
      const identityMatches = record => record.deviceId === input.deviceId
        && record.channelRevision === input.channelRevision
        && record.publicKeyFingerprint === normalizedKey.fingerprint;
      if ((existing && !identityMatches(existing)) || (authorityRecord && !identityMatches(authorityRecord))) {
        throw serviceError("enrollment_request_exists", "Request ID is already bound to another device identity", 409);
      }
      const known = existing || (authorityRecord ? metadataFromEnrollment(authorityRecord) : null);
      if (known) {
        const nextState = structuredClone(state);
        nextState.requests[input.requestId] = known;
        return { result: pendingSummary(known), ...(canonicalJson(nextState) === canonicalJson(state) ? {} : { nextState }) };
      }
      const nextState = structuredClone(state);
      nextState.requests[input.requestId] = {
        requestId: input.requestId,
        deviceId: input.deviceId,
        channelRevision: input.channelRevision,
        publicKeyJwk: normalizedKey.jwk,
        publicKeyFingerprint: normalizedKey.fingerprint,
        createdAt: timestampFromClock(now()),
        status: "pending",
        enrollmentId: null,
        expiresAt: null
      };
      return { result: pendingSummary(nextState.requests[input.requestId]), nextState };
    });
  }

  async function listRequests() {
    return withState(async ({ state, catalogState }) => {
      const reconciled = reconcileRequestMetadata(state, catalogState.authority);
      return {
        result: Object.values(reconciled.requests).filter(item => item.status === "pending").map(pendingSummary),
        ...(canonicalJson(reconciled) === canonicalJson(state) ? {} : { nextState: reconciled })
      };
    });
  }

  async function issueCode(requestId, selection = {}) {
    return withState(async ({ state, catalogState, catalog }) => {
      const record = state.requests[requestId];
      if (!record) throw serviceError("enrollment_request_not_found", "Pending enrollment request was not found", 404);
      if (!/^chrev_[A-Za-z0-9_-]{16,128}$/.test(currentActiveChannelRevision)
        || record.channelRevision !== currentActiveChannelRevision) {
        throw serviceError("enrollment_channel_not_ready", "Request channel revision does not match an active server channel", 503);
      }
      const selectedRootIds = normalizeIssueRootSelection(selection);
      const roots = selectedRootIds.map(rootId => {
        const root = catalogState.roots[rootId];
        if (!root || root.status !== "active") {
          throw serviceError("enrollment_catalog_not_ready", "Every selected catalog root must be active", 503);
        }
        return root;
      });
      const alreadyIssued = Object.values(catalogState.authority.enrollmentRecords)
        .find(item => item.requestId === requestId);
      if (alreadyIssued) {
        if (!record.issuedCode) throw serviceError("enrollment_state_conflict", "Issued code metadata is missing; controlled recovery is required", 409);
        const codePayload = decodeOneTimeEnrollmentCode(record.issuedCode, { nowMs: Date.parse(alreadyIssued.issuedAt) });
        if (createHash("sha256").update(codePayload.secret, "utf8").digest("hex") !== alreadyIssued.secretHash) {
          throw serviceError("enrollment_state_conflict", "Issued code metadata does not match catalog authority", 409);
        }
        if (alreadyIssued.consumedAt !== null) throw serviceError("enrollment_code_used", "Enrollment code has already been consumed", 409);
        const issuedRootIds = (alreadyIssued.bindings || []).map(binding => binding.identity?.rootId).filter(Boolean);
        if (issuedRootIds.length !== selectedRootIds.length
          || issuedRootIds.some(rootId => !selectedRootIds.includes(rootId))) {
          throw serviceError("enrollment_state_conflict", "The pending request already has a code for a different root selection", 409);
        }
        return {
          result: formatIssuedCodeResult({
            requestId,
            deviceEnrollmentCode: record.issuedCode,
            expiresAt: alreadyIssued.expiresAt,
            bindings: alreadyIssued.bindings,
            legacyRequest: Object.hasOwn(selection, "rootId")
          })
        };
      }
      if (record.status !== "pending") throw serviceError("enrollment_request_not_found", "Pending enrollment request was not found", 404);
      const bindings = roots.map(root => {
        const rootDigest = createHash("sha256").update(canonicalJson(root), "utf8").digest("hex");
        return {
          protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
          identity: {
            serverId: catalogState.authority.serverId,
            deviceId: record.deviceId,
            shareId: root.shareId,
            rootId: root.rootId,
            relationId: createEnrollmentIdentityId("relationId")
          },
          baselineEpoch: 1,
          channelRevision: record.channelRevision,
          credentialRevision: createEnrollmentIdentityId("credentialRevision"),
          rootAttestation: {
            source: "relation-catalog-root-sha256-v1",
            referenceId: `att_${rootDigest}`,
            attestedAt: root.activatedAt
          }
        };
      });
      const normalizedBindings = normalizeEnrollmentBindings(bindings, {
        serverId: catalogState.authority.serverId,
        deviceId: record.deviceId,
        channelRevision: record.channelRevision
      });
      const expiresAt = new Date(now() + 10 * 60 * 1000).toISOString();
      let issued;
      await catalog.update({ expectedRevision: catalogState.revision }, async working => {
        issued = issueOneTimeEnrollmentCode(working.authority, {
          requestId,
          deviceId: record.deviceId,
          channelRevision: record.channelRevision,
          publicKey: record.publicKeyJwk,
          bindings: normalizedBindings,
          issuedAt: timestampFromClock(now()),
          expiresAt
        }, { expectedRevision: working.authority.revision, nowMs: now() });
        const stagedMetadata = structuredClone(state);
        stagedMetadata.revision = state.revision + 1;
        stagedMetadata.updatedAt = timestampFromClock(now());
        stagedMetadata.requests[requestId].status = "issued";
        stagedMetadata.requests[requestId].enrollmentId = issued.enrollmentId;
        stagedMetadata.requests[requestId].expiresAt = issued.expiresAt;
        stagedMetadata.requests[requestId].issuedCode = issued.code;
        validateState(stagedMetadata, catalogState.authority.serverId);
        await writeState(statePath, stagedMetadata);
        working.authority = issued.nextState;
        return working;
      });
      return {
        result: formatIssuedCodeResult({
          requestId,
          deviceEnrollmentCode: issued.code,
          expiresAt: issued.expiresAt,
          bindings: issued.bindings,
          legacyRequest: Object.hasOwn(selection, "rootId")
        }),
        metadataWritten: true
      };
    });
  }

  async function consume({ body, bodyBytes, rawTarget, authorizationHeader }) {
    if (!body || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).join(",") !== "code") {
      throw serviceError("enrollment_request_invalid", "Enrollment consumption shape is invalid");
    }
    return withState(async ({ state, catalogState, catalog }) => {
      const authorization = parseProofHeader(authorizationHeader, "authorization-request");
      const codePayload = decodeOneTimeEnrollmentCode(body.code, { nowMs: now() });
      const enrollment = Object.values(catalogState.authority.enrollmentRecords)
        .find(item => item.requestId === codePayload.requestId);
      if (!enrollment) throw serviceError("enrollment_request_not_found", "Issued enrollment request was not found", 404);
      const actualHash = createHash("sha256").update(bodyBytes).digest("hex");
      if (authorization.method !== "POST" || authorization.path !== rawTarget || authorization.bodySha256 !== actualHash) {
        throw serviceError("enrollment_request_mismatch", "Signed authorization does not match the exact HTTP request", 403);
      }
      if (authorization.binding.identity.deviceId !== enrollment.deviceId
        || authorization.binding.identity.serverId !== catalogState.authority.serverId
        || authorization.binding.channelRevision !== enrollment.channelRevision) {
        throw serviceError("enrollment_binding_mismatch", "Signed identity does not match the pending request", 403);
      }
      verifyAuthorizationRequestSignature(authorization, enrollment.publicKeyJwk);
      if (!Object.values(enrollment.bindings).some(binding => canonicalJson(binding) === canonicalJson(authorization.binding))) {
        throw serviceError("enrollment_binding_mismatch", "Signed identity binding does not match the issued grant", 403);
      }
      if (codePayload.enrollmentId !== enrollment.enrollmentId
        || codePayload.serverId !== enrollment.serverId
        || codePayload.deviceId !== enrollment.deviceId
        || codePayload.publicKeyFingerprint !== enrollment.publicKeyFingerprint
        || codePayload.channelRevision !== enrollment.channelRevision
        || createHash("sha256").update(codePayload.secret, "utf8").digest("hex") !== enrollment.secretHash
        || canonicalJson(codePayload.bindings) !== canonicalJson(enrollment.bindings)) {
        throw serviceError("enrollment_code_invalid", "Enrollment code does not match the catalog record", 400);
      }

      let grant;
      let committedAuthority = catalogState.authority;
      if (enrollment.consumedAt === null) {
        const result = consumeOneTimeEnrollmentCode(catalogState.authority, body.code, {
          requestId: enrollment.requestId,
          deviceId: enrollment.deviceId,
          channelRevision: enrollment.channelRevision,
          publicKey: enrollment.publicKeyJwk,
          bindings: enrollment.bindings
        }, { expectedRevision: catalogState.authority.revision, nowMs: now() });
        const updated = await catalog.update({ expectedRevision: catalogState.revision }, working => {
          if (working.authority.revision !== catalogState.authority.revision) {
            throw serviceError("enrollment_state_conflict", "Catalog authority changed during consumption", 409);
          }
          working.authority = result.nextState;
          return working;
        });
        grant = result.grant;
        committedAuthority = updated.authority;
      } else {
        if (enrollment.consumedByDeviceId !== enrollment.deviceId) {
          throw serviceError("enrollment_state_invalid", "Consumed catalog enrollment record is inconsistent", 500);
        }
        const device = committedAuthority.devices[enrollment.deviceId];
        if (!device || device.revokedAt !== null) throw serviceError("enrollment_device_revoked", "Enrollment device is no longer active", 403);
        grant = {
          protocol: "sfsc-enrollment", version: 1, kind: "enrollment-grant",
          requestId: enrollment.requestId,
          serverId: enrollment.serverId,
          deviceId: enrollment.deviceId,
          publicKeyFingerprint: enrollment.publicKeyFingerprint,
          bindings: enrollment.bindings,
          enrolledAt: enrollment.consumedAt
        };
      }

      const nextState = structuredClone(state);
      nextState.requests[enrollment.requestId] ||= metadataFromEnrollment(enrollment);
      nextState.requests[enrollment.requestId].status = "consumed";
      nextState.requests[enrollment.requestId].consumedAt = enrollment.consumedAt || grant.enrolledAt;
      const signer = await readOrCreateSigner();
      const receiptUnsigned = {
        protocol: "sfsc-enrollment", version: 1,
        kind: "enrollment-consumption-receipt",
        requestId: enrollment.requestId,
        bodySha256: actualHash,
        grant,
        signingKeyId: signer.keyId
      };
      const receipt = {
        ...receiptUnsigned,
        signature: sign(null, Buffer.from(canonicalJson(receiptUnsigned), "utf8"), signer.privateKey).toString("base64url")
      };
      return { result: { grant, receipt }, nextState, authorityRevision: committedAuthority.revision };
    });
  }

  async function readOrCreateSigner() {
    const statePathInfo = await lstat(signerPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (statePathInfo) {
      if (statePathInfo.isSymbolicLink() || !statePathInfo.isFile()
        || (process.platform !== "win32" && (statePathInfo.mode & 0o777) !== 0o600)) {
        throw serviceError("enrollment_signer_invalid", "Enrollment signer file must be a private regular file", 500);
      }
      const stored = JSON.parse(await readFile(signerPath, "utf8"));
      if (stored.kind !== "sfsc-enrollment-signing-key" || stored.version !== 1
        || typeof stored.keyId !== "string" || typeof stored.privateKeyPem !== "string") {
        throw serviceError("enrollment_signer_invalid", "Enrollment signer file is invalid", 500);
      }
      const privateKey = createPrivateKey({ key: stored.privateKeyPem, format: "pem" });
      if (privateKey.asymmetricKeyType !== "ed25519") throw serviceError("enrollment_signer_invalid", "Enrollment signer must use Ed25519", 500);
      return { keyId: stored.keyId, privateKey, publicKey: createPublicKey(privateKey) };
    }
    const parent = dirname(signerPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = createEnrollmentIdentityId("signingKeyId");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    const temp = join(parent, `.${basename(signerPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify({ kind: "sfsc-enrollment-signing-key", version: 1, keyId, privateKeyPem: pem })); await handle.chmod(0o600); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, signerPath); } catch (error) { await unlink(temp).catch(() => {}); if (error?.code !== "EEXIST") throw error; return readOrCreateSigner(); }
    if (process.platform !== "win32") {
      const directory = await open(parent, fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { keyId, privateKey, publicKey };
  }

  async function getTrustMaterial() {
    return withState(async ({ catalogState }) => {
      const signer = await readOrCreateSigner();
      const jwk = signer.publicKey.export({ format: "jwk" });
      return { result: {
        serverId: catalogState.authority.serverId,
        keyId: signer.keyId,
        publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        publicKeyFingerprint: createHash("sha256").update(signer.publicKey.export({ format: "der", type: "spki" })).digest("base64url")
      } };
    });
  }

  async function listConsumedGrants() {
    const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
    const state = await catalog.read();
    const authority = state.authority;
    return Object.values(authority.enrollmentRecords)
      .filter(record => record.consumedAt !== null && record.consumedByDeviceId === record.deviceId)
      .filter(record => {
        const device = authority.devices[record.deviceId];
        return device && device.revokedAt === null
          && device.publicKeyFingerprint === record.publicKeyFingerprint
          && canonicalJson(device.publicKeyJwk) === canonicalJson(record.publicKeyJwk);
      })
      .map(record => ({
        requestId: record.requestId,
        enrollmentId: record.enrollmentId,
        deviceId: record.deviceId,
        serverId: record.serverId,
        publicKeyFingerprint: record.publicKeyFingerprint,
        publicKeyJwk: record.publicKeyJwk,
        consumedAt: record.consumedAt,
        authorityRevision: authority.revision,
        bindings: record.bindings.filter(binding => {
          const grant = authority.relationGrants[binding.identity.relationId];
          return grant && grant.revokedAt === null && canonicalJson(grant.binding) === canonicalJson(binding);
        })
      }));
  }

  function setDataAuthorizationProvider(provider) {
    if (typeof provider !== "function") throw new TypeError("data authorization provider must be a function");
    dataAuthorizationProvider = provider;
  }

  function setChannelRenewalProvider(provider) {
    if (typeof provider !== "function") throw new TypeError("channel renewal provider must be a function");
    channelRenewalProvider = provider;
  }

  async function issueChannelRenewal({ body, bodyBytes, rawTarget, authorizationHeader } = {}) {
    if (!channelRenewalProvider) throw serviceError("enrollment_channel_not_ready", "Channel renewal provider is unavailable", 503);
    if (!body || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).sort().join(",") !== "channelRevision"
      || typeof body.channelRevision !== "string" || !CHANNEL_REVISION.test(body.channelRevision)) {
      throw serviceError("enrollment_request_invalid", "Channel renewal request must contain only channelRevision");
    }
    const expectedPath = "/api/enrollment/v1/channel-renewal";
    const actualHash = createHash("sha256").update(bodyBytes).digest("hex");
    const authorization = parseProofHeader(authorizationHeader, "authorization-request");
    if (rawTarget !== expectedPath || authorization.method !== "POST" || authorization.path !== rawTarget
      || authorization.bodySha256 !== actualHash) {
      throw serviceError("enrollment_request_mismatch", "Signed authorization does not match the exact channel-renewal request", 403);
    }

    const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
    const initialSnapshot = await catalog.read();
    const initiallyChecked = verifySignedAuthorizationRequest(initialSnapshot.authority, authorization, {
      bodySha256: actualHash, method: "POST", path: expectedPath
    }, { expectedRevision: initialSnapshot.authority.revision, nowMs: now() });
    assertCurrentConsumedRelation(initialSnapshot, initiallyChecked.binding);

    // The binding records the channel revision used for first pairing. Renewal
    // proves that same consumed binding, while the body names the transport
    // revision currently applied by the server.
    const issued = await channelRenewalProvider({
      deviceId: initiallyChecked.binding.identity.deviceId,
      binding: initiallyChecked.binding,
      channelRevision: body.channelRevision
    });
    if (!issued || issued.channelRevision !== body.channelRevision
      || typeof issued.wrappedCode !== "string" || !issued.wrappedCode.startsWith(CHANNEL_IMPORT_CODE_PREFIX)) {
      throw serviceError("enrollment_channel_not_ready", "Current channel renewal material is unavailable", 503);
    }

    const afterProvider = await catalog.read();
    const checked = verifySignedAuthorizationRequest(afterProvider.authority, authorization, {
      bodySha256: actualHash, method: "POST", path: expectedPath
    }, { expectedRevision: afterProvider.authority.revision, nowMs: now() });
    assertCurrentConsumedRelation(afterProvider, checked.binding);
    if (canonicalJson(checked.binding) !== canonicalJson(initiallyChecked.binding)) {
      throw serviceError("enrollment_state_conflict", "Enrollment relation changed during channel renewal", 409);
    }

    const committed = await catalog.update({ expectedRevision: afterProvider.revision }, working => {
      const currentCheck = verifySignedAuthorizationRequest(working.authority, authorization, {
        bodySha256: actualHash, method: "POST", path: expectedPath
      }, { expectedRevision: working.authority.revision, nowMs: now() });
      assertCurrentConsumedRelation(working, currentCheck.binding);
      if (canonicalJson(currentCheck.binding) !== canonicalJson(checked.binding)) {
        throw serviceError("enrollment_state_conflict", "Enrollment relation changed during channel renewal", 409);
      }
      working.authority = currentCheck.nextState;
      return working;
    });

    if (body.channelRevision !== currentActiveChannelRevision) {
      throw serviceError("enrollment_channel_stale", "Server channel changed while renewing; request the current channel again", 409);
    }
    const signer = await readOrCreateSigner();
    const payload = {
      protocol: "sfsc-enrollment", version: 1, kind: "channel-renewal",
      serverId: committed.authority.serverId,
      keyId: signer.keyId,
      deviceId: initiallyChecked.binding.identity.deviceId,
      channelRevision: body.channelRevision,
      wrappedCode: issued.wrappedCode
    };
    return {
      payload,
      signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), signer.privateKey).toString("base64url")
    };
  }

  // A VLESS overlay restart can cut the response after provider work has begun.
  // The client may then retry with a fresh nonce while the first request still
  // owns the catalog's fail-fast lock. Serialize the full operation and keep
  // proof, current grant, and nonce validation inside the queue so revocation
  // and replay checks run against the state visible when each turn begins.
  async function issueDataAuthorization(input = {}) {
    const next = dataAuthorizationQueue.then(
      () => issueDataAuthorizationSerial(input),
      () => issueDataAuthorizationSerial(input)
    );
    dataAuthorizationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function issueDataAuthorizationSerial({ body, bodyBytes, rawTarget, authorizationHeader } = {}) {
    if (!dataAuthorizationProvider) throw serviceError("enrollment_data_authorization_denied", "Data authorization provider is unavailable", 503);
    if (!body || Object.getPrototypeOf(body) !== Object.prototype
      || Object.keys(body).sort().join(",") !== "relationId"
      || typeof body.relationId !== "string") {
      throw serviceError("enrollment_request_invalid", "Data authorization request must contain only relationId");
    }
    const expectedPath = "/api/enrollment/v1/data-authorization";
    const actualHash = createHash("sha256").update(bodyBytes).digest("hex");
    const authorization = parseProofHeader(authorizationHeader, "authorization-request");
    if (rawTarget !== expectedPath || authorization.method !== "POST" || authorization.path !== rawTarget
      || authorization.bodySha256 !== actualHash
      || authorization.binding.identity.relationId !== body.relationId) {
      throw serviceError("enrollment_request_mismatch", "Signed authorization does not match the exact data-authorization request", 403);
    }

    const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
    const initialSnapshot = await catalog.read();
    const initiallyChecked = verifySignedAuthorizationRequest(initialSnapshot.authority, authorization, {
      bodySha256: actualHash, method: "POST", path: expectedPath
    }, { expectedRevision: initialSnapshot.authority.revision, nowMs: now() });
    assertCurrentConsumedRelation(initialSnapshot, initiallyChecked.binding);
    let authorizedPayload;
    try {
      authorizedPayload = await dataAuthorizationProvider({
        deviceId: initiallyChecked.binding.identity.deviceId,
        relationId: initiallyChecked.binding.identity.relationId,
        binding: initiallyChecked.binding
      });
    } catch (error) {
      if (!DATA_AUTHORIZATION_START_FAILURE_CODES.has(error?.code)) throw error;
      const code = safeDiagnosticCode(error.code);
      const helperCode = safeDiagnosticCode(error.helperCode);
      console.error(`[sfsc] enrollment_data_relation_start_failed code=${code} helperCode=${helperCode}`);
      const mapped = serviceError(
        "enrollment_data_relation_start_failed",
        "The server could not start its protected directory service. Ask an administrator to check protection capabilities and retry.",
        503
      );
      mapped.internalCode = code;
      mapped.helperCode = helperCode;
      throw mapped;
    }

    // Provider work can legitimately advance the catalog revision while it
    // materializes a relation. Re-read before consuming the signed nonce so
    // the nonce update uses the current catalog revision, while still checking
    // that the request's original grant remains exactly the same.
    const afterProvider = await catalog.read();
    const checked = verifySignedAuthorizationRequest(afterProvider.authority, authorization, {
      bodySha256: actualHash, method: "POST", path: expectedPath
    }, { expectedRevision: afterProvider.authority.revision, nowMs: now() });
    assertCurrentConsumedRelation(afterProvider, checked.binding);
    if (canonicalJson(checked.binding) !== canonicalJson(initiallyChecked.binding)) {
      throw serviceError("enrollment_state_conflict", "Enrollment relation changed during data authorization", 409);
    }

    const committed = await catalog.update({ expectedRevision: afterProvider.revision }, working => {
      const currentCheck = verifySignedAuthorizationRequest(working.authority, authorization, {
        bodySha256: actualHash, method: "POST", path: expectedPath
      }, { expectedRevision: working.authority.revision, nowMs: now() });
      assertCurrentConsumedRelation(working, currentCheck.binding);
      if (canonicalJson(currentCheck.binding) !== canonicalJson(checked.binding)) {
        throw serviceError("enrollment_state_conflict", "Enrollment relation changed during data authorization", 409);
      }
      working.authority = currentCheck.nextState;
      return working;
    });
    const context = Object.freeze({
      binding: checked.binding,
      deviceId: checked.binding.identity.deviceId,
      relationId: checked.binding.identity.relationId,
      authorityRevision: committed.authority.revision
    });
    verifiedAuthorizationContexts.add(context);
    return signProvisioningPayload({ authorizedPayload, verifiedAuthorization: context });
  }

  async function signProvisioningPayload({ authorizedPayload, verifiedAuthorization } = {}) {
    if (!verifiedAuthorizationContexts.has(verifiedAuthorization)
      || usedAuthorizationContexts.has(verifiedAuthorization)) {
      throw serviceError("enrollment_auth_invalid", "Provisioning payload is not bound to a verified data request", 401);
    }
    usedAuthorizationContexts.add(verifiedAuthorization);
    const payload = normalizeDataAuthorizationPayload(authorizedPayload);
    const state = await (await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" })).read();
    const binding = verifiedAuthorization.binding;
    assertCurrentConsumedRelation(state, binding);
    if (payload.serverId !== state.authority.serverId
      || payload.deviceId !== verifiedAuthorization.deviceId
      || payload.binding.identity.relationId !== verifiedAuthorization.relationId
      || canonicalJson(payload.binding) !== canonicalJson(binding)) {
      throw serviceError("enrollment_binding_mismatch", "Provisioning payload does not match current catalog authority", 403);
    }
    const device = state.authority.devices[payload.deviceId];
    if (payload.publicKeyFingerprint !== device.publicKeyFingerprint) {
      throw serviceError("enrollment_public_key_mismatch", "Provisioning payload device key does not match catalog authority", 403);
    }
    const signer = await readOrCreateSigner();
    if (payload.keyId !== signer.keyId) throw serviceError("enrollment_signer_invalid", "Provisioning payload signer id does not match the active server key", 500);
    return signDataAuthorizationPayload(payload, signer.privateKey);
  }

  async function issueChannelCode(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || ![["bootstrap", "channelRevision", "connection", "expiresAt"],
        ["bootstrap", "channelRevision", "connection", "expiresAt", "issuedAt"]]
        .some(keys => Object.keys(input).sort().join(",") === keys.sort().join(","))
      || typeof input.channelRevision !== "string"
      || (input.issuedAt !== undefined && typeof input.issuedAt !== "string")
      || input.channelRevision !== currentActiveChannelRevision) {
      throw serviceError("enrollment_channel_not_ready", "Channel code request does not match the active server channel", 503);
    }
    return withState(async ({ catalogState }) => {
      const signer = await readOrCreateSigner();
      const channelCode = createChannelConfigCode({
        serverId: catalogState.authority.serverId,
        channelRevision: input.channelRevision,
        connection: input.connection,
        bootstrap: input.bootstrap,
        issuedAt: input.issuedAt || new Date(now()).toISOString(),
        expiresAt: input.expiresAt
      }, {
        signingKey: signer.privateKey,
        keyId: signer.keyId,
        nowMs: now()
      });
      const jwk = signer.publicKey.export({ format: "jwk" });
      return { result: {
        channelCode,
        pin: {
          serverId: catalogState.authority.serverId,
          keyId: signer.keyId,
          publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
          allowedBootstrapOrigins: currentAllowedBootstrapOrigins,
          bootstrapPathPrefix: "/api/enrollment/v1"
        }
      } };
    });
  }

  function setActiveChannelRevision(value) {
    if (typeof value !== "string" || !CHANNEL_REVISION.test(value)) {
      throw serviceError("enrollment_channel_not_ready", "Active channel revision is invalid", 503);
    }
    currentActiveChannelRevision = value;
  }

  function setAllowedBootstrapOrigins(values) {
    if (!Array.isArray(values) || values.length === 0 || values.some(value => {
      if (typeof value !== "string") return true;
      try { const parsed = new URL(value); return parsed.origin !== value || !["https:", "http:"].includes(parsed.protocol); }
      catch { return true; }
    })) {
      throw serviceError("enrollment_channel_not_ready", "Allowed bootstrap origin is invalid", 503);
    }
    currentAllowedBootstrapOrigins = [...new Set(values)];
  }

  return Object.freeze({ initialize, createRequest, listRequests, issueCode, consume, getTrustMaterial, issueChannelCode, listConsumedGrants, setDataAuthorizationProvider, setChannelRenewalProvider, issueChannelRenewal, issueDataAuthorization, signProvisioningPayload, setActiveChannelRevision, setAllowedBootstrapOrigins, close() { releaseLock?.(); releaseLock = null; } });
}

function normalizeIssueRootSelection(selection) {
  if (!selection || Object.getPrototypeOf(selection) !== Object.prototype) {
    throw serviceError("validation_failed", "Enrollment issue selection must be an object", 400);
  }
  const hasRootId = Object.hasOwn(selection, "rootId");
  const hasRootIds = Object.hasOwn(selection, "rootIds");
  if (hasRootId === hasRootIds || Object.keys(selection).length !== 1) {
    throw serviceError("validation_failed", "Select exactly one of rootId or rootIds", 400);
  }
  const rootIds = hasRootId ? [selection.rootId] : selection.rootIds;
  if (!Array.isArray(rootIds) || rootIds.length === 0
    || rootIds.some(rootId => typeof rootId !== "string" || !/^root_[A-Za-z0-9_-]{16,128}$/.test(rootId))
    || new Set(rootIds).size !== rootIds.length) {
    throw serviceError("validation_failed", "Selected root IDs must be non-empty, unique, and valid", 400);
  }
  return [...rootIds];
}

function formatIssuedCodeResult({ requestId, deviceEnrollmentCode, expiresAt, bindings, legacyRequest }) {
  const result = { requestId, deviceEnrollmentCode, expiresAt };
  if (legacyRequest) result.binding = bindings[0];
  else result.bindings = bindings;
  return result;
}

function assertCurrentConsumedRelation(state, binding) {
  const authority = state.authority;
  const deviceId = binding.identity.deviceId;
  const device = authority.devices[deviceId];
  if (!device || device.revokedAt !== null) throw serviceError("enrollment_device_revoked", "Data authorization device is not active", 403);
  const grant = authority.relationGrants[binding.identity.relationId];
  if (!grant || grant.revokedAt !== null || canonicalJson(grant.binding) !== canonicalJson(binding)) {
    throw serviceError("enrollment_relation_denied", "Data authorization relation is not currently granted", 403);
  }
  const consumed = Object.values(authority.enrollmentRecords).some(record => record.deviceId === deviceId
    && record.consumedAt !== null && record.consumedByDeviceId === deviceId
    && record.publicKeyFingerprint === device.publicKeyFingerprint
    && record.bindings.some(item => canonicalJson(item) === canonicalJson(binding)));
  if (!consumed) throw serviceError("enrollment_relation_denied", "Data authorization requires a current consumed enrollment", 403);
  if (state.roots[binding.identity.rootId]?.status !== "active") {
    throw serviceError("enrollment_catalog_not_ready", "Authorized directory root is not active", 503);
  }
  return { device, grant };
}

function parseProofHeader(value, expectedKind) {
  if (typeof value !== "string" || value.length > 24_000
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw serviceError("enrollment_auth_invalid", "Signature header is missing or invalid", 401);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw serviceError("enrollment_auth_invalid", "Signature header encoding is invalid", 401);
  }
  let decoded;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw serviceError("enrollment_auth_invalid", "Signature header JSON is invalid", 401); }
  if (canonicalJson(decoded) !== bytes.toString("utf8")) {
    throw serviceError("enrollment_auth_invalid", "Signature header JSON is not canonical", 401);
  }
  if (!decoded || decoded.protocol !== "sfsc-enrollment" || decoded.version !== 1
    || decoded.kind !== expectedKind || typeof decoded.signature !== "string"
    || !/^[A-Za-z0-9_-]{86}$/.test(decoded.signature)) {
    throw serviceError("enrollment_auth_invalid", "Signature header contract is invalid", 401);
  }
  if (expectedKind === "authorization-request") return normalizeAuthorizationRequest(decoded);
  if (Object.keys(decoded).sort().join(",") !== "bodySha256,kind,protocol,signature,version"
    || !/^[a-f0-9]{64}$/.test(decoded.bodySha256)) {
    throw serviceError("enrollment_auth_invalid", "Enrollment request proof header contract is invalid", 401);
  }
  return decoded;
}
