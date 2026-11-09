import { createHash } from "node:crypto";
import { join, posix, win32 } from "node:path";
import { selectBisyncEngine } from "../../src/core/syncEngine.js";
import {
  assertNoSftpSecretMaterial,
  normalizeSftpRootPath,
  normalizeSftpTransport
} from "../../src/core/storage.js";

export const SYNC_RELATION_SCHEMA_VERSION = 1;
export const SYNC_RELATION_MIGRATION_STATES = Object.freeze([
  "ready",
  "legacy_compatible",
  "migration_required",
  "legacy_reused",
  "review_required"
]);

export function buildSyncRelation(profile = {}, job = {}, options = {}) {
  const requestedBackend = job.storageBackend || "s3";
  const backend = normalizeText(requestedBackend).toLowerCase();
  if (backend === "sftp") {
    assertNoSftpSecretMaterial(job);
    assertNoSftpSecretMaterial(options);
    if (typeof requestedBackend !== "string" || requestedBackend !== "sftp") {
      throw new Error('SFTP storageBackend must be exactly "sftp"');
    }
  }
  const localRoot = normalizeSyncLocalRoot(job.localPath);
  const direction = normalizeText(job.direction || "upload");
  const engine = selectBisyncEngine(backend);
  if (backend === "sftp") {
    if (Object.hasOwn(job, "remotePath") || Object.hasOwn(job, "remotePrefix")) {
      throw new Error("SFTP jobs must use rootPath as the canonical remote root");
    }
  }
  const bucketName = backend === "sftp" ? "" : normalizeText(job.bucketName);
  const remotePrefix = backend === "sftp"
    ? normalizeSftpRootPath(job.rootPath)
    : normalizeRemotePath(firstText(job.rootPath, job.remotePrefix));
  const trusted = normalizeTrustedBinding(options.trustedBinding);
  const sftpTransport = backend === "sftp"
    ? normalizeSftpTransport(options.sftpTransport)
    : null;
  const scope = trusted.valid
    ? trusted.value.scope
    : normalizeText(job.serverSpace || "device").toLowerCase();
  const authorization = trusted.valid
    ? {
        directions: normalizedDirections(trusted.value.authorization.directions),
        allowDelete: trusted.value.authorization.allowDelete === true
      }
    : {
        directions: normalizedDirections(profile.authorization?.directions),
        allowDelete: profile.authorization?.allowDelete === true
      };
  const filters = {
    exclude: normalizedStrings(job.exclude).sort()
  };
  const server = trusted.valid
    ? { id: trusted.value.serverId, source: "trusted-binding", proven: true }
    : relationServerIdentity(profile);
  const connection = relationConnectionIdentity(profile, job, backend, trusted, sftpTransport);
  const deviceId = trusted.valid
    ? trusted.value.deviceId
    : firstText(
        profile.deviceId,
        profile.identity?.deviceId,
        profile.device?.id,
        job.clientName,
        profile.clientName
      );
  const shareId = trusted.valid
    ? trusted.value.shareId
    : firstText(
        profile.shareId,
        profile.identity?.shareId,
        profile.share?.id,
        profile.syncSpace?.id,
        profile.syncSpace?.syncId,
        `claimed-share-${stableHash(`${backend}\0${bucketName}\0${remotePrefix}`).slice(0, 20)}`
      );
  const rootId = trusted.valid
    ? trusted.value.rootId
    : firstText(
        profile.rootId,
        profile.identity?.rootId,
        profile.share?.rootId,
        `claimed-root-${stableHash(`${backend}\0${bucketName}\0${remotePrefix}`).slice(0, 24)}`
      );
  const remoteRoot = {
    backend,
    bucketName,
    path: remotePrefix,
    rootId
  };
  const trustedBindingConflict = trusted.valid
    ? trustedBindingConflictReason(trusted.value, {
        backend,
        bucketName,
        remotePrefix,
        direction,
        scope
      })
    : "";
  const identityAssurance = trusted.valid ? "trusted-binding" : "unverified-profile-claims";
  const trustedBindingId = trusted.valid
    ? stableHash(stableSerialize(trustedBindingIdentity(trusted.value)))
    : "";
  const baselineIdentity = {
    schemaVersion: SYNC_RELATION_SCHEMA_VERSION,
    localRoot,
    relationId: trusted.valid ? trusted.value.relationId : "",
    serverId: server.id,
    identityAssurance,
    trustedBindingId,
    deviceId,
    shareId,
    rootId,
    remoteRoot,
    direction,
    scope,
    authorization,
    backend,
    engine,
    filters
  };
  const baselineId = stableHash(stableSerialize(baselineIdentity));
  const relationId = trusted.valid ? trusted.value.relationId : baselineId;
  const baselineEpoch = trusted.valid ? trusted.value.baselineEpoch : 1;
  const remoteAlias = `sfsc_${stableHash(`${relationId}\0${baselineId}`).slice(0, 20)}`;
  return {
    schemaVersion: SYNC_RELATION_SCHEMA_VERSION,
    relationId,
    baselineId,
    baselineEpoch,
    localRoot,
    serverId: server.id,
    serverIdentitySource: server.source,
    serverIdentityProven: server.proven,
    identityAssurance,
    trustedBindingId,
    rootAttested: trusted.valid && !trustedBindingConflict,
    rootAttestation: trusted.valid ? trusted.value.rootAttestation : "",
    revisions: trusted.valid
      ? {
          channelRevision: trusted.value.channelRevision,
          credentialRevision: trusted.value.credentialRevision
        }
      : {
          channelRevision: "",
          credentialRevision: ""
        },
    connection,
    deviceId,
    shareId,
    rootId,
    remoteRoot,
    direction,
    scope,
    authorization,
    backend,
    engine: cloneValue(engine),
    filters,
    rclone: {
      remoteAlias,
      remotePath: buildRcloneRemotePath(remoteAlias, backend, bucketName, remotePrefix),
      workdir: ""
    },
    migration: {
      state: !trusted.valid && options.trustedBinding
        ? "review_required"
        : trustedBindingConflict ? "review_required" : "ready",
      reasons: !trusted.valid && options.trustedBinding
        ? [trusted.reason || "trusted_binding_invalid"]
        : trustedBindingConflict ? [trustedBindingConflict] : [],
      legacyFingerprint: ""
    }
  };
}

export function reuseMatchingSyncRelation(candidate, existing) {
  if (!existing || !sameSyncRelationBaseline(candidate, existing)) {
    return candidate;
  }
  const existingAlias = firstText(existing.rclone?.remoteAlias);
  const existingWorkdir = firstText(existing.rclone?.workdir);
  const existingMigration = existing.migration && typeof existing.migration === "object"
    ? {
        state: SYNC_RELATION_MIGRATION_STATES.includes(existing.migration.state)
          ? existing.migration.state
          : "review_required",
        reasons: normalizedStrings(existing.migration.reasons),
        legacyFingerprint: firstText(existing.migration.legacyFingerprint)
      }
    : candidate.migration;
  return {
    ...candidate,
    relationId: firstText(existing.relationId, candidate.relationId),
    baselineEpoch: Number.isInteger(existing.baselineEpoch) && existing.baselineEpoch > 0
      ? existing.baselineEpoch
      : candidate.baselineEpoch,
    rclone: {
      ...candidate.rclone,
      remoteAlias: existingAlias || candidate.rclone.remoteAlias,
      remotePath: `${existingAlias || candidate.rclone.remoteAlias}:${candidate.rclone.remotePath.split(":").slice(1).join(":")}`,
      workdir: existingWorkdir
    },
    connection: cloneValue(candidate.connection),
    serverIdentitySource: candidate.serverIdentitySource,
    serverIdentityProven: candidate.serverIdentityProven,
    identityAssurance: candidate.identityAssurance,
    trustedBindingId: candidate.trustedBindingId,
    rootAttested: candidate.rootAttested,
    rootAttestation: candidate.rootAttestation,
    revisions: cloneValue(candidate.revisions),
    migration: existingMigration
  };
}

export function sameSyncRelationBaseline(left, right) {
  if (!left || !right) {
    return false;
  }
  return firstText(left.baselineId) === firstText(right.baselineId)
    && firstText(left.relationId) === firstText(right.relationId)
    && left.baselineEpoch === right.baselineEpoch
    && stableSerialize(relationBaselineIdentity(left)) === stableSerialize(relationBaselineIdentity(right));
}

export function syncRelationConnectionChanged(left, right) {
  if (!left || !right) {
    return true;
  }
  return stableSerialize(left.connection || null) !== stableSerialize(right.connection || null);
}

export function legacySyncJobFingerprint(job = {}) {
  const fingerprint = {};
  for (const field of [
    "localPath",
    "direction",
    "remoteFolder",
    "serverSpace",
    "clientName",
    "remoteName",
    "bucketName",
    "remotePrefix",
    "s3Endpoint",
    "localProxyPort",
    "transfers",
    "streams",
    "checkers",
    "s3UploadConcurrency",
    "s3ChunkSize",
    "chunkSize",
    "cutoff",
    "retries",
    "lowLevelRetries",
    "dryRun",
    "destructiveSync",
    "bandwidthLimit",
    "safety"
  ]) {
    fingerprint[field] = job[field] ?? null;
  }
  return JSON.stringify(fingerprint);
}

export function resolveLegacyBisyncCompatibility(relation, options = {}) {
  if (relation?.backend === "sftp") {
    return null;
  }
  if (!relation || relation.direction !== "bidirectional") {
    return null;
  }
  const state = isPlainObject(options.state) ? options.state : {};
  const storedJob = isPlainObject(options.storedJob) ? options.storedJob : null;
  const candidateJob = isPlainObject(options.candidateJob) ? options.candidateJob : null;
  if (!storedJob || !candidateJob) {
    return null;
  }

  const storedFingerprintKey = legacySyncJobFingerprint(storedJob);
  const candidateFingerprintKey = legacySyncJobFingerprint(candidateJob);
  const record = isPlainObject(state[storedFingerprintKey]) && state[storedFingerprintKey].initializedAt
    ? state[storedFingerprintKey]
    : null;
  const relatedEntries = findLegacyBisyncEntries(state, relation, { ignoreFilters: true });

  if (!record) {
    if (relatedEntries.length > 0) {
      return migrationRequiredRelation(
        relation,
        relatedEntries.length > 1
          ? "ambiguous_legacy_bisync_state"
          : "legacy_bisync_state_unverified",
        relatedEntries[0]?.fingerprintKey || ""
      );
    }
    return null;
  }
  if (relatedEntries.length > 1) {
    return migrationRequiredRelation(
      relation,
      "ambiguous_legacy_bisync_state",
      storedFingerprintKey
    );
  }
  if (relatedEntries.length === 1 && relatedEntries[0].fingerprintKey !== storedFingerprintKey) {
    return migrationRequiredRelation(
      relation,
      "legacy_bisync_fingerprint_mismatch",
      storedFingerprintKey
    );
  }
  if (storedFingerprintKey !== candidateFingerprintKey) {
    return migrationRequiredRelation(
      relation,
      "legacy_execution_parameters_changed",
      storedFingerprintKey
    );
  }
  const storedBackend = normalizeText(storedJob.storageBackend || "s3").toLowerCase();
  if (storedBackend !== relation.backend) {
    return migrationRequiredRelation(relation, "legacy_backend_changed", storedFingerprintKey);
  }
  if (normalizeSyncLocalRoot(storedJob.localPath) !== relation.localRoot) {
    return migrationRequiredRelation(relation, "legacy_local_root_changed", storedFingerprintKey);
  }
  const storedFilters = normalizedStrings(storedJob.exclude).sort();
  if (stableSerialize(storedFilters) !== stableSerialize(normalizedStrings(candidateJob.exclude).sort())
    || stableSerialize(storedFilters) !== stableSerialize(normalizedStrings(relation.filters?.exclude).sort())) {
    return migrationRequiredRelation(relation, "legacy_filter_scope_changed", storedFingerprintKey);
  }
  const legacyAlias = firstText(record.remoteAlias, storedJob.remoteName);
  if (!legacyAlias || legacyAlias !== firstText(storedJob.remoteName)) {
    return migrationRequiredRelation(relation, "legacy_remote_alias_unverified", storedFingerprintKey);
  }
  const runtimeBisyncRoot = firstText(options.runtimeBisyncRoot);
  if (!runtimeBisyncRoot) {
    return migrationRequiredRelation(relation, "legacy_workdir_unverified", storedFingerprintKey);
  }
  const runtimeId = stableHash(storedFingerprintKey).slice(0, 24);
  const expectedWorkdir = join(runtimeBisyncRoot, "bisync", runtimeId);
  if (!firstText(record.workdir)
    || normalizeSyncLocalRoot(record.workdir) !== normalizeSyncLocalRoot(expectedWorkdir)) {
    return migrationRequiredRelation(relation, "legacy_workdir_mismatch", storedFingerprintKey);
  }
  if (!hasRuntimeDirectory(options.runtimeDirectoryIds, runtimeId)) {
    return migrationRequiredRelation(relation, "legacy_workdir_missing", storedFingerprintKey);
  }

  return {
    ...relation,
    rclone: {
      ...relation.rclone,
      remoteAlias: legacyAlias,
      remotePath: buildRcloneRemotePath(
        legacyAlias,
        relation.backend,
        relation.remoteRoot.bucketName,
        relation.remoteRoot.path
      ),
      workdir: expectedWorkdir
    },
    migration: {
      state: "legacy_compatible",
      reasons: [],
      legacyFingerprint: storedFingerprintKey
    }
  };
}

export function applySyncRelationToJob(job = {}, relation = null) {
  if (!relation) {
    return job;
  }
  const remoteAlias = relation.direction === "bidirectional"
    ? relation.rclone.remoteAlias
    : firstText(job.remoteName, relation.rclone.remoteAlias);
  const remotePath = remoteAlias === relation.rclone.remoteAlias
    ? relation.rclone.remotePath
    : `${remoteAlias}:${relation.rclone.remotePath.split(":").slice(1).join(":")}`;
  const appliedRelation = {
    ...cloneValue(relation),
    rclone: {
      ...relation.rclone,
      remoteAlias,
      remotePath
    }
  };
  const appliedJob = relation.backend === "sftp"
    ? Object.fromEntries(Object.entries(job).filter(([key]) => (
        !["remotePrefix", "bucketName", "remotePath"].includes(key)
      )))
    : job;
  return {
    ...appliedJob,
    remoteName: remoteAlias,
    exclude: [...relation.filters.exclude],
    ...(relation.backend === "sftp"
      ? {
          rootPath: relation.remoteRoot.path
        }
      : {}),
    syncRelation: appliedRelation
  };
}

export function resolveBisyncMigration(relation, state = {}, options = {}) {
  if (!relation || relation.direction !== "bidirectional") {
    return relation;
  }
  const exactStateKey = bisyncStateKey(relation);
  if (isPlainObject(state.baselines)
    && Object.hasOwn(state.baselines, exactStateKey)
    && !findBisyncStateEntry(state, relation, options)) {
    return migrationRequiredRelation(relation, ["sync_relation_baseline_state_mismatch"]);
  }
  if (!findBisyncStateEntry(state, relation, options)
    && isPlainObject(state.baselines)
    && Object.values(state.baselines).some((entry) => (
      isPlainObject(entry)
      && firstText(entry.initializedAt)
      && entry.relationId === relation.relationId
    ))) {
    return migrationRequiredRelation(relation, ["sync_relation_existing_baseline_changed"]);
  }
  if (options.legacyJob && relation.backend !== "sftp") {
    const legacy = resolveLegacyBisyncCompatibility(relation, {
      ...options.legacyJob,
      state,
      runtimeBisyncRoot: options.runtimeBisyncRoot,
      runtimeDirectoryIds: options.runtimeDirectoryIds
    });
    if (legacy) {
      return legacy;
    }
  }

  const exact = findBisyncStateEntry(state, relation, options);
  if (exact) {
    if (!hasRuntimeDirectory(options.runtimeDirectoryIds, syncRelationRuntimeId(relation))) {
      return migrationRequiredRelation(relation, ["sync_relation_workdir_missing"]);
    }
    return {
      ...relation,
      rclone: {
        ...relation.rclone,
        remoteAlias: firstText(exact.remoteAlias, relation.rclone.remoteAlias),
        workdir: firstText(exact.workdir, relation.rclone.workdir)
      },
      migration: {
        state: "ready",
        reasons: [],
        legacyFingerprint: ""
      }
    };
  }

  const legacyCandidates = findLegacyBisyncEntries(state, relation);
  if (legacyCandidates.length > 0) {
    return migrationRequiredRelation(relation, [
      legacyCandidates.length > 1
        ? "ambiguous_legacy_bisync_state"
        : "legacy_bisync_state_unverified"
    ], legacyCandidates[0]?.fingerprintKey || "");
  }
  if (hasRuntimeDirectory(options.runtimeDirectoryIds, syncRelationRuntimeId(relation))) {
    return migrationRequiredRelation(relation, ["unmapped_bisync_runtime_state"]);
  }
  return relation;
}

export function hasAnyLegacyBisyncState(state = {}) {
  if (!isPlainObject(state)) {
    return false;
  }
  return Object.entries(state).some(([key, value]) => (
    key !== "version"
    && key !== "baselines"
    && isPlainObject(value)
    && Boolean(value.initializedAt)
  ));
}

export function bisyncStateKey(relation = {}) {
  const baselineId = firstText(relation.baselineId);
  const baselineEpoch = Number(relation.baselineEpoch);
  if (!baselineId || !Number.isInteger(baselineEpoch) || baselineEpoch < 1) {
    return "";
  }
  return `${baselineId}:${baselineEpoch}`;
}

export function syncRelationRuntimeId(relation = {}) {
  const baselineId = firstText(relation.baselineId);
  return baselineId ? stableHash(baselineId).slice(0, 24) : "";
}

export function findBisyncStateEntry(state = {}, relation = {}, options = {}) {
  const key = bisyncStateKey(relation);
  if (!key || !isPlainObject(state.baselines)) {
    return null;
  }
  const entry = state.baselines[key];
  if (!isPlainObject(entry) || !firstText(entry.initializedAt)) {
    return null;
  }
  if (!isCompleteBisyncStateEntry(entry, relation)) {
    return null;
  }
  const runtimeBisyncRoot = firstText(options.runtimeBisyncRoot);
  if (runtimeBisyncRoot) {
    const expectedWorkdir = join(runtimeBisyncRoot, "bisync", syncRelationRuntimeId(relation));
    if (normalizeSyncLocalRoot(entry.workdir) !== normalizeSyncLocalRoot(expectedWorkdir)) {
      return null;
    }
  }
  return entry;
}

export function findLegacyBisyncEntries(state = {}, relation = {}, options = {}) {
  if (!isPlainObject(state)) {
    return [];
  }
  const matches = [];
  for (const [fingerprintKey, record] of Object.entries(state)) {
    if (fingerprintKey === "version" || fingerprintKey === "baselines" || !isPlainObject(record) || !record.initializedAt) {
      continue;
    }
    let fingerprint;
    try {
      fingerprint = JSON.parse(fingerprintKey);
    } catch {
      continue;
    }
    if (!legacyFingerprintMatchesRelation(fingerprint, relation, options)) {
      continue;
    }
    matches.push({
      fingerprintKey,
      fingerprint,
      record,
      remoteAlias: firstText(fingerprint.remoteName),
      workdir: firstText(record.workdir) || joinRuntimeBisyncId(fingerprintKey)
    });
  }
  return matches;
}

export function legacyFingerprintMatchesRelation(fingerprint = {}, relation = {}, options = {}) {
  if (!isPlainObject(fingerprint) || !relation) {
    return false;
  }
  if (normalizeSyncLocalRoot(fingerprint.localPath) !== relation.localRoot) {
    return false;
  }
  if (normalizeText(fingerprint.direction || "upload") !== relation.direction) {
    return false;
  }
  if (firstText(fingerprint.clientName) !== relation.deviceId) {
    return false;
  }
  const legacyRootHash = stableHash(
    `${firstText(fingerprint.storageBackend || "s3").toLowerCase()}\0${firstText(fingerprint.bucketName)}\0${normalizeRemotePath(fingerprint.remotePrefix)}`
  ).slice(0, 24);
  if (relation.rootId !== `root-${legacyRootHash}`
    && relation.rootId !== `claimed-root-${legacyRootHash}`) {
    return false;
  }
  const legacyScope = normalizeText(fingerprint.serverSpace || "device").toLowerCase();
  if (legacyScope !== relation.scope) {
    return false;
  }
  if (options.ignoreFilters) {
    return true;
  }
  const legacyExclude = normalizedStrings(fingerprint.exclude).sort();
  return stableSerialize(legacyExclude) === stableSerialize((relation.filters?.exclude || []).slice().sort());
}

export function markBisyncInitializedState(state = {}, relation = {}, details = {}) {
  const next = isPlainObject(state) ? cloneValue(state) : {};
  if (!isPlainObject(next.baselines)) {
    next.baselines = {};
  }
  next.version = 2;
  const stateKey = bisyncStateKey(relation);
  if (!stateKey) {
    throw new Error("Cannot persist bisync state without a valid baseline identity");
  }
  next.baselines[stateKey] = {
    schemaVersion: SYNC_RELATION_SCHEMA_VERSION,
    initializedAt: details.initializedAt || new Date().toISOString(),
    relationId: relation.relationId,
    baselineId: relation.baselineId,
    baselineEpoch: relation.baselineEpoch,
    serverId: relation.serverId,
    serverIdentityProven: relation.serverIdentityProven === true,
    identityAssurance: relation.identityAssurance,
    trustedBindingId: relation.trustedBindingId,
    rootAttested: relation.rootAttested === true,
    rootAttestation: relation.rootAttestation,
    revisions: cloneValue(relation.revisions),
    deviceId: relation.deviceId,
    shareId: relation.shareId,
    localRoot: relation.localRoot,
    rootId: relation.rootId,
    remoteRoot: cloneValue(relation.remoteRoot),
    direction: relation.direction,
    scope: relation.scope,
    authorization: cloneValue(relation.authorization),
    backend: relation.backend,
    engine: cloneValue(relation.engine),
    filters: cloneValue(relation.filters),
    remoteAlias: relation.rclone.remoteAlias,
    remotePath: relation.rclone.remotePath,
    workdir: details.workdir || relation.rclone.workdir,
    mode: details.mode || ""
  };
  return next;
}

export function summarizeSyncRelation(relation = null) {
  if (!relation) {
    return null;
  }
  return {
    schemaVersion: relation.schemaVersion,
    relationId: relation.relationId,
    baselineId: relation.baselineId,
    baselineEpoch: relation.baselineEpoch,
    migrationState: relation.migration?.state || "review_required",
    migrationReasons: normalizedStrings(relation.migration?.reasons),
    remoteAlias: relation.rclone?.remoteAlias || "",
    serverIdentityProven: relation.serverIdentityProven === true,
    rootAttested: relation.rootAttested === true
  };
}

export function normalizeSyncLocalRoot(input) {
  const text = String(input || "").trim();
  if (!text) {
    return "";
  }
  const windowsPath = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  const normalized = windowsPath
    ? win32.normalize(win32.resolve(text))
    : posix.normalize(posix.resolve(text));
  const withoutTrailing = normalized.length > normalizedPathRootLength(normalized)
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return windowsPath ? withoutTrailing.toLowerCase() : withoutTrailing;
}

function normalizedPathRootLength(path) {
  if (/^[A-Za-z]:[\\/]$/.test(path)) {
    return 3;
  }
  if (path === "/" || /^\\\\[^\\]+\\.+$/.test(path)) {
    return path.length;
  }
  return 0;
}

function relationServerIdentity(profile) {
  const explicit = firstText(
    profile.identity?.serverId,
    profile.binding?.serverId,
    profile.server?.id,
    profile.serverId
  );
  if (explicit) {
    return { id: `claimed-explicit-${stableHash(explicit).slice(0, 20)}`, source: "profile-claim", proven: false };
  }
  const sourceServer = firstText(profile.source?.server);
  if (sourceServer) {
    return { id: `claimed-source-${stableHash(sourceServer).slice(0, 20)}`, source: "source-claim", proven: false };
  }
  const parsed = profile.tunnel?.parsed || {};
  const endpoint = firstText(parsed.server) && parsed.port
    ? `${parsed.server}:${parsed.port}`
    : firstText(profile.tunnel?.uri, profile.uri);
  return {
    id: endpoint ? `claimed-tunnel-${stableHash(endpoint).slice(0, 20)}` : "unidentified",
    source: "tunnel-claim",
    proven: false
  };
}

function normalizeTrustedBinding(input) {
  if (input == null) {
    return { valid: false, value: null, reason: "" };
  }
  if (!isPlainObject(input)) {
    return { valid: false, value: null, reason: "trusted_binding_not_object" };
  }
  const serverId = firstText(input.serverId);
  const deviceId = firstText(input.deviceId);
  const shareId = firstText(input.shareId);
  const rootId = firstText(input.rootId);
  const relationId = firstText(input.relationId);
  const baselineEpoch = Number(input.baselineEpoch);
  const scope = normalizeText(input.scope).toLowerCase();
  const backend = normalizeText(input.root?.backend).toLowerCase();
  const bucketName = backend === "sftp" ? "" : normalizeText(input.root?.bucketName);
  const path = input.root?.path;
  const rootAttestation = firstText(input.rootAttestation);
  if (!serverId || !deviceId || !shareId || !rootId || !relationId || !scope || !backend
    || typeof path !== "string" || !rootAttestation) {
    return { valid: false, value: null, reason: "trusted_binding_incomplete" };
  }
  if (backend === "s3" && !bucketName) {
    return { valid: false, value: null, reason: "trusted_binding_root_incomplete" };
  }
  if (!Number.isInteger(baselineEpoch) || baselineEpoch < 1) {
    return { valid: false, value: null, reason: "trusted_binding_epoch_invalid" };
  }
  if (!Array.isArray(input.authorization?.directions) || typeof input.authorization?.allowDelete !== "boolean") {
    return { valid: false, value: null, reason: "trusted_binding_authorization_incomplete" };
  }
  return {
    valid: true,
    reason: "",
    value: {
      serverId,
      deviceId,
      shareId,
      rootId,
      relationId,
      baselineEpoch,
      channelRevision: normalizeText(input.channelRevision),
      credentialRevision: normalizeText(input.credentialRevision),
      rootAttestation,
      scope,
      authorization: {
        directions: normalizedDirections(input.authorization.directions),
        allowDelete: input.authorization.allowDelete
      },
      root: {
        backend,
        bucketName,
        path
      }
    }
  };
}

function trustedBindingIdentity(binding) {
  return {
    serverId: binding.serverId,
    deviceId: binding.deviceId,
    shareId: binding.shareId,
    rootId: binding.rootId,
    relationId: binding.relationId,
    scope: binding.scope,
    authorization: binding.authorization,
    root: binding.root
  };
}

function trustedBindingConflictReason(binding, execution) {
  if (binding.root.backend !== execution.backend) {
    return "trusted_binding_backend_mismatch";
  }
  if (binding.root.path !== execution.remotePrefix
    || (execution.backend === "s3" && binding.root.bucketName !== execution.bucketName)) {
    return "trusted_binding_root_mismatch";
  }
  if (binding.scope !== execution.scope) {
    return "trusted_binding_scope_mismatch";
  }
  if (!binding.authorization.directions.includes(execution.direction)) {
    return "trusted_binding_direction_mismatch";
  }
  return "";
}

function buildRcloneRemotePath(remoteAlias, backend, bucketName, path) {
  if (backend === "s3") {
    return `${remoteAlias}:${bucketName}/${path}`;
  }
  return `${remoteAlias}:${path}`;
}

function relationConnectionIdentity(profile, job, backend, trusted, sftpTransport) {
  const serverClaim = firstText(profile.source?.server);
  const tunnelEndpoint = firstText(
    profile.tunnel?.parsed?.server && profile.tunnel?.parsed?.port
      ? `${profile.tunnel.parsed.server}:${profile.tunnel.parsed.port}`
      : "",
    profile.tunnel?.uri,
    profile.uri
  );
  if (backend === "sftp") {
    return {
      serverClaim,
      tunnelEndpoint,
      sftpEndpoint: `${sftpTransport.host}:${sftpTransport.port}`,
      sftpUser: sftpTransport.user,
      socksProxy: sftpTransport.socksProxy,
      knownHostsFileRef: sftpTransport.knownHostsFile,
      keyFileRef: sftpTransport.keyFile,
      hostKeyFingerprint: sftpTransport.hostKeyFingerprint,
      transportCredentialRevision: sftpTransport.credentialRevision,
      channelRevision: trusted.valid ? trusted.value.channelRevision : "",
      credentialRevision: trusted.valid ? trusted.value.credentialRevision : ""
    };
  }
  return {
    serverClaim,
    tunnelEndpoint,
    storageEndpoint: firstText(job.s3Endpoint, profile.storage?.endpoint)
  };
}

function relationBaselineIdentity(relation) {
  return {
    schemaVersion: relation.schemaVersion,
    localRoot: normalizeSyncLocalRoot(relation.localRoot),
    serverId: firstText(relation.serverId),
    identityAssurance: firstText(relation.identityAssurance),
    trustedBindingId: firstText(relation.trustedBindingId),
    deviceId: firstText(relation.deviceId),
    shareId: firstText(relation.shareId),
    rootId: firstText(relation.rootId),
    remoteRoot: relation.remoteRoot,
    direction: firstText(relation.direction),
    scope: firstText(relation.scope),
    authorization: {
      directions: normalizedDirections(relation.authorization?.directions),
      allowDelete: relation.authorization?.allowDelete === true
    },
    backend: firstText(relation.backend),
    engine: relation.engine,
    filters: {
      exclude: normalizedStrings(relation.filters?.exclude)
    }
  };
}

function reviewRequiredRelation(relation, reasons, legacyFingerprint = "") {
  return {
    ...relation,
    migration: {
      state: "review_required",
      reasons: normalizedStrings(reasons),
      legacyFingerprint
    }
  };
}

function migrationRequiredRelation(relation, reasons, legacyFingerprint = "") {
  return {
    ...relation,
    migration: {
      state: "migration_required",
      reasons: normalizedStrings(Array.isArray(reasons) ? reasons : [reasons]),
      legacyFingerprint
    }
  };
}

function hasRuntimeDirectory(runtimeDirectoryIds, runtimeId) {
  if (!runtimeId || runtimeDirectoryIds == null) {
    return runtimeDirectoryIds == null;
  }
  if (runtimeDirectoryIds instanceof Set) {
    return runtimeDirectoryIds.has(runtimeId);
  }
  if (Array.isArray(runtimeDirectoryIds)) {
    return runtimeDirectoryIds.includes(runtimeId);
  }
  if (isPlainObject(runtimeDirectoryIds)) {
    return Object.hasOwn(runtimeDirectoryIds, runtimeId);
  }
  return false;
}

function isCompleteBisyncStateEntry(entry, relation) {
  const requiredStrings = [
    "initializedAt",
    "relationId",
    "baselineId",
    "serverId",
    "identityAssurance",
    "deviceId",
    "shareId",
    "localRoot",
    "rootId",
    "direction",
    "scope",
    "backend",
    "remoteAlias",
    "remotePath",
    "workdir"
  ];
  if (requiredStrings.some((field) => !firstText(entry[field]))) {
    return false;
  }
  if (!Number.isInteger(entry.baselineEpoch) || entry.baselineEpoch < 1) {
    return false;
  }
  if (!Object.hasOwn(entry, "trustedBindingId")
    || typeof entry.trustedBindingId !== "string"
    || typeof entry.serverIdentityProven !== "boolean"
    || typeof entry.rootAttested !== "boolean"
    || !Object.hasOwn(entry, "rootAttestation")
    || typeof entry.rootAttestation !== "string"
    || !isPlainObject(entry.revisions)) {
    return false;
  }
  if (entry.relationId !== relation.relationId
    || entry.baselineId !== relation.baselineId
    || entry.baselineEpoch !== relation.baselineEpoch
    || entry.serverId !== relation.serverId
    || entry.serverIdentityProven !== relation.serverIdentityProven
    || entry.identityAssurance !== relation.identityAssurance
    || entry.trustedBindingId !== relation.trustedBindingId
    || entry.rootAttested !== relation.rootAttested
    || entry.deviceId !== relation.deviceId
    || entry.shareId !== relation.shareId
    || normalizeSyncLocalRoot(entry.localRoot) !== relation.localRoot
    || entry.rootId !== relation.rootId
    || stableSerialize(entry.remoteRoot) !== stableSerialize(relation.remoteRoot)
    || entry.direction !== relation.direction
    || entry.scope !== relation.scope
    || stableSerialize(entry.authorization) !== stableSerialize(relation.authorization)
    || entry.backend !== relation.backend
    || stableSerialize(entry.engine) !== stableSerialize(relation.engine)
    || stableSerialize(entry.filters) !== stableSerialize(relation.filters)
    || entry.remoteAlias !== relation.rclone.remoteAlias
    || entry.remotePath !== relation.rclone.remotePath) {
    return false;
  }
  return true;
}

function joinRuntimeBisyncId(fingerprintKey) {
  return `runtime/bisync/${stableHash(fingerprintKey).slice(0, 24)}`;
}

function normalizedDirections(value) {
  return normalizedStrings(value).sort();
}

function normalizedStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

function normalizeRemotePath(input) {
  return String(input || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function stableHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
