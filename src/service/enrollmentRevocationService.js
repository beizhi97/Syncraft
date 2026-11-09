import { createHash } from "node:crypto";

import {
  revokeEnrollmentDevice,
  revokeEnrollmentRelation
} from "../core/enrollmentAuthority.js";
import { canonicalJson } from "../core/enrollmentProtocol.js";

const OPERATION_ID = /^revop_[A-Za-z0-9_-]{16,96}$/;
const RELATION_ID = /^rel_[A-Za-z0-9_-]{16,128}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

function serviceError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function relationIdentity(binding) {
  return {
    serverId: binding.identity.serverId,
    deviceId: binding.identity.deviceId,
    shareId: binding.identity.shareId,
    rootId: binding.identity.rootId,
    relationId: binding.identity.relationId,
    baselineEpoch: binding.baselineEpoch,
    rootAttestation: structuredClone(binding.rootAttestation),
    backend: "sftp"
  };
}

function relationIdentityDigest(state, binding) {
  const devicePublicKeyFingerprint = state.authority.devices[binding.identity.deviceId]?.publicKeyFingerprint || "";
  return digest({ identity: relationIdentity(binding), devicePublicKeyFingerprint });
}

function assertInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "operationId,target"
    || typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId)) {
    throw serviceError("enrollment_revocation_invalid", "Revocation request is invalid", 400);
  }
  const target = input.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw serviceError("enrollment_revocation_invalid", "Revocation target is invalid", 400);
  }
  const keys = Object.keys(target).sort().join(",");
  if (target.kind === "relation" && keys === "kind,relationId"
    && typeof target.relationId === "string" && RELATION_ID.test(target.relationId)) {
    return { operationId: input.operationId, target: { kind: "relation", targetId: target.relationId } };
  }
  if (target.kind === "device" && keys === "deviceId,kind"
    && typeof target.deviceId === "string" && DEVICE_ID.test(target.deviceId)) {
    return { operationId: input.operationId, target: { kind: "device", targetId: target.deviceId } };
  }
  throw serviceError("enrollment_revocation_invalid", "Revocation target is invalid", 400);
}

function publicOperation(record) {
  return structuredClone(record);
}

export function createEnrollmentRevocationService({
  catalog,
  relationService,
  applyOverlay,
  now = () => Date.now()
} = {}) {
  if (typeof catalog?.read !== "function" || typeof catalog?.update !== "function"
    || typeof relationService?.query !== "function" || typeof relationService?.disable !== "function"
    || typeof applyOverlay !== "function" || typeof now !== "function") {
    throw new TypeError("enrollment revocation dependencies are incomplete");
  }

  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task, task);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  async function ensureOperation(request) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await catalog.read();
      const prior = state.revocationOperations?.[request.operationId];
      if (prior) {
        const current = targetIdentity(state, request.target);
        if (prior.target.kind !== request.target.kind || prior.target.targetId !== request.target.targetId
          || prior.target.identityDigest !== current.identityDigest) {
          throw serviceError("enrollment_revocation_operation_conflict", "Operation ID is already bound to a different revocation target");
        }
        return prior;
      }
      const captured = targetIdentity(state, request.target);
      const timestamp = new Date(now()).toISOString();
      const created = await catalog.update({ expectedRevision: state.revision }, working => {
        working.revocationOperations ||= {};
        const raced = working.revocationOperations[request.operationId];
        if (raced) {
          if (raced.target.kind !== request.target.kind || raced.target.targetId !== request.target.targetId
            || raced.target.identityDigest !== captured.identityDigest) {
            throw serviceError("enrollment_revocation_operation_conflict", "Operation ID is already bound to a different revocation target");
          }
          return;
        }
        let authority = working.authority;
        let authorityRevokedAt;
        if (request.target.kind === "relation") {
          const grant = authority.relationGrants[request.target.targetId];
          if (!grant) throw serviceError("enrollment_relation_denied", "Relation grant does not exist", 404);
          if (grant.revokedAt === null) {
            const revoked = revokeEnrollmentRelation(authority, { relationId: request.target.targetId }, {
              expectedRevision: authority.revision,
              nowMs: now()
            });
            authority = revoked.nextState;
            authorityRevokedAt = revoked.revokedAt;
          } else {
            authorityRevokedAt = grant.revokedAt;
          }
        } else {
          const device = authority.devices[request.target.targetId];
          if (!device) throw serviceError("enrollment_relation_denied", "Enrollment device does not exist", 404);
          if (device.revokedAt === null) {
            const revoked = revokeEnrollmentDevice(authority, { deviceId: request.target.targetId }, {
              expectedRevision: authority.revision,
              nowMs: now()
            });
            authority = revoked.nextState;
            authorityRevokedAt = revoked.revokedAt;
          } else {
            authorityRevokedAt = device.revokedAt;
          }
        }
        working.authority = authority;
        working.revocationOperations[request.operationId] = {
          authorityRevokedAt,
          createdAt: timestamp,
          lastErrorCode: "",
          operationId: request.operationId,
          overlayStatus: captured.relations.length ? "pending" : "not_required",
          relations: captured.relations.map(({ relationId, identityDigest }) => ({
            identityDigest,
            managerOperationId: managerOperationId(request.operationId, relationId),
            relationId,
            state: "pending"
          })),
          status: "pending",
          target: {
            identityDigest: captured.identityDigest,
            kind: request.target.kind,
            targetId: request.target.targetId
          },
          updatedAt: timestamp
        };
      });
      if (created?.revocationOperations?.[request.operationId]) {
        return created.revocationOperations[request.operationId];
      }
      const latest = await catalog.read();
      if (latest.revocationOperations?.[request.operationId]) return latest.revocationOperations[request.operationId];
    }
    throw serviceError("relation_service_binding_catalog_conflict", "Revocation changed concurrently; retry the same operation", 409);
  }

  function targetIdentity(state, target) {
    if (target.kind === "relation") {
      const grant = state.authority?.relationGrants?.[target.targetId];
      if (!grant?.binding) throw serviceError("enrollment_relation_denied", "Relation grant does not exist", 404);
      const identityDigest = relationIdentityDigest(state, grant.binding);
      return {
        identityDigest,
        relations: [{ relationId: target.targetId, identityDigest, managerOperationId: managerOperationId("", target.targetId) }]
      };
    }
    const device = state.authority?.devices?.[target.targetId];
    if (!device) throw serviceError("enrollment_relation_denied", "Enrollment device does not exist", 404);
    const relations = Object.entries(state.authority.relationGrants || {})
      .filter(([, grant]) => grant.binding?.identity?.deviceId === target.targetId)
      .map(([relationId, grant]) => {
        const identityDigest = relationIdentityDigest(state, grant.binding);
        return { relationId, identityDigest, managerOperationId: managerOperationId("", relationId) };
      })
      .sort((left, right) => left.relationId.localeCompare(right.relationId));
    return {
      identityDigest: digest({ deviceId: target.targetId, publicKeyFingerprint: device.publicKeyFingerprint, relations: relations.map(({ relationId, identityDigest }) => ({ relationId, identityDigest })) }),
      relations
    };
  }

  function managerOperationId(operationId, relationId) {
    return `revstop_${createHash("sha256").update(`${operationId}\0${relationId}`).digest("hex").slice(0, 40)}`;
  }

  async function persistOperation(operationId, update) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await catalog.read();
      const current = state.revocationOperations?.[operationId];
      if (!current) throw serviceError("enrollment_revocation_operation_not_found", "Revocation operation does not exist", 404);
      const next = structuredClone(current);
      update(next);
      next.updatedAt = new Date(now()).toISOString();
      try {
        const persisted = await catalog.update({ expectedRevision: state.revision }, working => {
          const actual = working.revocationOperations[operationId];
          if (!actual) throw serviceError("enrollment_revocation_operation_not_found", "Revocation operation does not exist", 404);
          working.revocationOperations[operationId] = next;
        });
        return persisted.revocationOperations[operationId];
      } catch (error) {
        if (error?.code !== "relation_service_binding_catalog_conflict" || attempt === 2) throw error;
      }
    }
    throw serviceError("relation_service_binding_catalog_conflict", "Revocation operation changed concurrently; retry", 409);
  }

  async function processOperation(operationId) {
    let operation = (await catalog.read()).revocationOperations?.[operationId];
    if (!operation) throw serviceError("enrollment_revocation_operation_not_found", "Revocation operation does not exist", 404);
    if (operation.status === "complete") return publicOperation(operation);
    for (const originalStep of operation.relations) {
      if (["stopped", "absent"].includes(originalStep.state)) continue;
      try {
        const current = await catalog.read();
        const grant = current.authority.relationGrants?.[originalStep.relationId];
        if (!grant?.binding) throw serviceError("enrollment_revocation_identity_conflict", "Revoked relation binding is unavailable");
        const identity = relationIdentity(grant.binding);
        if (relationIdentityDigest(current, grant.binding) !== originalStep.identityDigest) {
          throw serviceError("enrollment_revocation_identity_conflict", "Relation identity changed after revocation");
        }
        let observed = await relationService.query({ relationId: originalStep.relationId });
        if (isTrustedAbsent(observed)) {
          operation = await persistOperation(operationId, record => {
            const step = record.relations.find(item => item.relationId === originalStep.relationId);
            step.state = "absent";
            record.lastErrorCode = "";
          });
          continue;
        }
        if (!isTrustedStopped(observed)) {
          if (observed?.desired === "disabled" && typeof relationService.reconcile === "function") {
            await relationService.reconcile({ relationId: originalStep.relationId });
          } else {
            await relationService.disable({
              relationId: originalStep.relationId,
              operationId: originalStep.managerOperationId,
              identity
            });
          }
          observed = await relationService.query({ relationId: originalStep.relationId });
        }
        if (!isTrustedStopped(observed) && !isTrustedAbsent(observed)) {
          throw serviceError("relation_file_service_runtime_cleanup_unconfirmed", "Relation service stop is not confirmed", 503);
        }
        operation = await persistOperation(operationId, record => {
          const step = record.relations.find(item => item.relationId === originalStep.relationId);
          step.state = isTrustedAbsent(observed) ? "absent" : "stopped";
          record.lastErrorCode = "";
        });
      } catch (error) {
        operation = await persistOperation(operationId, record => {
          const step = record.relations.find(item => item.relationId === originalStep.relationId);
          if (step && !["stopped", "absent"].includes(step.state)) {
            step.state = error?.code === "relation_file_service_runtime_cleanup_unconfirmed"
              ? "cleanup_required" : "pending";
          }
          record.lastErrorCode = /^[a-z0-9_]{1,96}$/.test(error?.code || "")
            ? error.code : "enrollment_revocation_step_failed";
        });
        return publicOperation(operation);
      }
    }
    operation = (await catalog.read()).revocationOperations[operationId];
    if (operation.relations.length && operation.overlayStatus !== "applied") {
      try {
        const receipt = await applyOverlay({ operation: publicOperation(operation) });
        if (receipt?.applied !== true) {
          throw serviceError("enrollment_revocation_overlay_not_applied", "Revoked data overlay is not applied", 503);
        }
        operation = await persistOperation(operationId, record => {
          record.overlayStatus = "applied";
          record.lastErrorCode = "";
        });
      } catch (error) {
        operation = await persistOperation(operationId, record => {
          record.lastErrorCode = /^[a-z0-9_]{1,96}$/.test(error?.code || "")
            ? error.code : "enrollment_revocation_overlay_not_applied";
        });
        return publicOperation(operation);
      }
    }
    operation = await persistOperation(operationId, record => {
      if (record.relations.some(step => !["stopped", "absent"].includes(step.state))
        || !["applied", "not_required"].includes(record.overlayStatus)) {
        throw serviceError("enrollment_revocation_incomplete", "Revocation operation is incomplete", 503);
      }
      record.status = "complete";
      record.lastErrorCode = "";
    });
    return publicOperation(operation);
  }

  function isTrustedAbsent(value) {
    return value?.source === "manager-state" && value.state === "absent"
      && value.desired === null && value.handlePresent === false
      && value.runningEvidencePresent === false && value.cleanupRequired === false
      && value.commitUncertain === false;
  }

  function isTrustedStopped(value) {
    return value?.source === "manager-state" && value.state === "stopped"
      && value.desired === "disabled" && value.cleanupRequired === false
      && value.commitUncertain === false;
  }

  return Object.freeze({
    revoke(input = {}) {
      return serialize(async () => {
        const request = assertInput(input);
        await ensureOperation(request);
        return processOperation(request.operationId);
      });
    },
    get(operationId) {
      if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
        throw serviceError("enrollment_revocation_invalid", "Revocation operation ID is invalid", 400);
      }
      // Reads use the catalog's own lock/atomic snapshot and must remain
      // observable while a serialized mutation is waiting on runtime I/O.
      return catalog.read().then(state => {
        const record = state.revocationOperations?.[operationId];
        return record ? publicOperation(record) : null;
      });
    },
    resumePending() {
      return serialize(async () => {
        const operations = Object.values((await catalog.read()).revocationOperations || {})
          .filter(record => record.status !== "complete")
          .map(record => record.operationId);
        const results = [];
        for (const operationId of operations) results.push(await processOperation(operationId));
        return results;
      });
    },
    async hasPending() {
      return Object.values((await catalog.read()).revocationOperations || {})
        .some(record => record.status !== "complete");
    }
  });
}
