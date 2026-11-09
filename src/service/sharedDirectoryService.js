import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createEnrollmentIdentityId } from "../core/enrollmentProtocol.js";
import {
  checkDirectoryRoot,
  commitDirectoryRootRegistration,
  prepareDirectoryRootRegistration
} from "../core/directoryRootGuard.js";
import { createEnrollmentAuthorityState } from "../core/enrollmentAuthority.js";
import { openRelationServiceBindingCatalog } from "./relationServiceBindingCatalog.js";

const CATALOG_KIND = "syncraft-relation-service-bindings";

/** First-run administrator directory enrollment, persisted solely in catalog. */
export function createSharedDirectoryService({ catalogPath, directoryRoot, now = () => Date.now() } = {}) {
  if (typeof catalogPath !== "string" || !catalogPath) throw new TypeError("catalogPath is required");
  const configuredDirectoryRoot = typeof directoryRoot === "string" && directoryRoot.trim()
    ? resolve(directoryRoot.trim()) : null;
  let queue = Promise.resolve();

  function serialize(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  async function openExisting() {
    return openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  }

  async function list() {
    try {
      const catalog = await openExisting();
      const state = await catalog.read();
      const result = [];
      for (const record of Object.values(state.roots)) {
        let status = record.status;
        if (configuredDirectoryRoot && status === "active") {
          const within = await isWithinConfiguredRoot(record.canonicalRoot);
          if (!within) status = "pending";
        }
        result.push({ rootId: record.rootId, status, path: record.canonicalRoot,
          createdAt: record.createdAt, activatedAt: record.activatedAt || null });
      }
      return result;
    } catch (error) {
      if (error?.code === "relation_service_binding_catalog_missing"
        || error?.cause?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function inspectActiveRoots() {
    let catalog;
    try { catalog = await openExisting(); }
    catch (error) {
      if (error?.code === "relation_service_binding_catalog_missing"
        || error?.cause?.code === "ENOENT") return { verifiedRootIds: [], activeRootCount: 0, unverifiedRootCount: 0 };
      throw error;
    }
    const state = await catalog.read();
    const active = Object.values(state.roots).filter(record => record.status === "active");
    const verifiedRootIds = [];
    let unverifiedRootCount = 0;
    for (const record of active) {
      if (configuredDirectoryRoot && !(await isWithinConfiguredRoot(record.canonicalRoot))) {
        unverifiedRootCount += 1;
        continue;
      }
      try {
        await checkDirectoryRoot(record, { operation: "write", requiredBytes: "0", reserveBytes: "0", nowMs: now() });
        verifiedRootIds.push(record.rootId);
      } catch {
        unverifiedRootCount += 1;
      }
    }
    return { verifiedRootIds, activeRootCount: verifiedRootIds.length, unverifiedRootCount };
  }

  async function register({ path } = {}) {
    return serialize(async () => {
      if (typeof path !== "string" || !path.trim()) {
        throw Object.assign(new Error("path is required"), { code: "directory_root_input_invalid", status: 400 });
      }
      const requestedPath = resolve(path.trim());
      let canonicalPath;
      try { canonicalPath = await realpath(requestedPath); }
      catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        throw Object.assign(new Error("Selected directory must already exist"), {
          code: "directory_root_missing", status: 400, cause
        });
      }
      if (configuredDirectoryRoot && !(await isWithinConfiguredRoot(canonicalPath))) {
        throw Object.assign(new Error("Selected directory must be inside the configured shared directory"), {
          code: "directory_root_input_invalid", status: 400
        });
      }

      const { catalog, state, newCatalog } = await openOrCreateWithPending(canonicalPath);
      const candidate = Object.values(state.roots).find(record => record.canonicalRoot === canonicalPath);
      if (candidate?.status === "active") {
        await checkDirectoryRoot(candidate, { operation: "write", requiredBytes: "0", reserveBytes: "0", nowMs: now() });
        return publicDirectory(candidate);
      }
      if (candidate?.status === "pending") {
        const active = await commitDirectoryRootRegistration(candidate, { nowMs: now() });
        const fresh = await catalog.read();
        const activated = await catalog.update({ expectedRevision: fresh.revision }, working => {
          const current = working.roots[candidate.rootId];
          if (!current || current.operationId !== candidate.operationId || current.status !== "pending") {
            throw Object.assign(new Error("Directory registration changed during commit"), { code: "relation_service_binding_catalog_conflict", status: 409 });
          }
          working.roots[candidate.rootId] = active;
          return working;
        });
        return publicDirectory(activated.roots[candidate.rootId]);
      }

      assertNoOverlappingRoot(canonicalPath, Object.values(state.roots));

      const serverId = state.authority.serverId;
      const shareId = createEnrollmentIdentityId("shareId");
      const pending = await prepareDirectoryRootRegistration({ rootPath: canonicalPath, serverId, shareId }, { nowMs: now() });
      if (newCatalog) {
        // The pending record is durable before the first marker write.
        const refreshed = await catalog.read();
        const active = await commitDirectoryRootRegistration(pending, { nowMs: now() });
        const updated = await catalog.update({ expectedRevision: refreshed.revision }, working => {
          working.roots[pending.rootId] = active;
          return working;
        });
        return publicDirectory(updated.roots[pending.rootId]);
      }

      const withPending = await catalog.update({ expectedRevision: state.revision }, working => {
        if (working.roots[pending.rootId]) throw Object.assign(new Error("Generated root identity already exists"), { code: "relation_service_binding_catalog_conflict", status: 409 });
        working.roots[pending.rootId] = pending;
        return working;
      });
      const active = await commitDirectoryRootRegistration(withPending.roots[pending.rootId], { nowMs: now() });
      const current = await catalog.read();
      const completed = await catalog.update({ expectedRevision: current.revision }, working => {
        const record = working.roots[pending.rootId];
        if (!record || record.operationId !== pending.operationId || record.status !== "pending") {
          throw Object.assign(new Error("Directory registration changed during commit"), { code: "relation_service_binding_catalog_conflict", status: 409 });
        }
        working.roots[pending.rootId] = active;
        return working;
      });
      return publicDirectory(completed.roots[pending.rootId]);
    });
  }

  async function isWithinConfiguredRoot(candidatePath) {
    let canonicalRoot;
    try { canonicalRoot = await realpath(configuredDirectoryRoot); }
    catch (error) {
      if (error?.code === "ENOENT") {
        throw Object.assign(new Error("Configured shared directory is unavailable"), {
          code: "directory_root_input_invalid", status: 400, cause: error
        });
      }
      throw error;
    }
    let canonicalCandidate;
    try { canonicalCandidate = await realpath(candidatePath); }
    catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    return pathContains(canonicalRoot, canonicalCandidate);
  }

  async function openOrCreateWithPending(canonicalPath) {
    try {
      const catalog = await openExisting();
      return { catalog, state: await catalog.read(), newCatalog: false };
    } catch (error) {
      if (error?.code !== "relation_service_binding_catalog_missing"
        && error?.cause?.code !== "ENOENT") throw error;
    }

    const catalogDir = dirname(catalogPath);
    await mkdir(catalogDir, { recursive: true, mode: 0o700 });
    const serverId = createEnrollmentIdentityId("serverId");
    const shareId = createEnrollmentIdentityId("shareId");
    const pending = await prepareDirectoryRootRegistration({ rootPath: canonicalPath, serverId, shareId }, { nowMs: now() });
    const hostKeyPath = join(catalogDir, "server-host-key.pem");
    const pair = generateKeyPairSync("ed25519");
    const privateBytes = pair.privateKey.export({ format: "pem", type: "pkcs8" });
    const hostKeyHandle = await open(hostKeyPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      .catch(error => {
        if (error?.code === "EEXIST") throw Object.assign(new Error("Server host key already exists without a catalog; review required"), { code: "directory_root_registration_review_required", status: 409 });
        throw error;
      });
    try { await hostKeyHandle.writeFile(privateBytes); await hostKeyHandle.sync(); }
    finally { await hostKeyHandle.close(); }
    const publicDer = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" });
    const initialState = {
      schemaVersion: "1", kind: CATALOG_KIND, revision: 0,
      authority: createEnrollmentAuthorityState({ serverId, nowMs: now() }),
      roots: { [pending.rootId]: pending },
      serverHostKey: { path: hostKeyPath, publicKeySha256: createHash("sha256").update(publicDer).digest("hex") },
      relations: {}
    };
    const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "create", initialState });
    return { catalog, state: await catalog.read(), newCatalog: true };
  }

  return Object.freeze({ list, inspectActiveRoots, register });
}

function assertNoOverlappingRoot(candidatePath, roots) {
  for (const root of roots) {
    const existingPath = root.canonicalRoot;
    if (samePath(candidatePath, existingPath)
      || pathContains(existingPath, candidatePath)
      || pathContains(candidatePath, existingPath)) {
      throw Object.assign(new Error("Selected directory overlaps an existing registered root"), {
        code: "directory_root_overlap", status: 409
      });
    }
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function pathContains(parent, child) {
  const result = relative(parent, child);
  return result !== "" && result !== "."
    && result !== ".."
    && !result.startsWith(`..${sep}`)
    && !isAbsolute(result);
}

function publicDirectory(record) {
  return { rootId: record.rootId, status: record.status, path: record.canonicalRoot, createdAt: record.createdAt, activatedAt: record.activatedAt || null };
}
