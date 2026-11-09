import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  prepareStartupRecovery,
  recoveryJournalRecord
} from "./startupMaintenance.js";
import { projectStartupRecoveryScope } from "./startupQuiescenceStateParser.js";

const DIGEST = /^[a-f0-9]{64}$/;
const JOURNAL_NAME = /^([a-f0-9]{64})\.json$/;

function transactionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      `${label} must be a non-negative safe integer`
    );
  }
}

function exactKeys(value, keys, label) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      `${label} must be a plain object`
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      `${label} has an invalid schema`
    );
  }
}

export async function prepareRecoveryTransaction({
  recoveryDir,
  statePath,
  bytes,
  beforeRawSha256,
  closureProofSha256,
  deploymentId,
  policyVersion,
  oldContainerId,
  targetEpoch,
  createdFromEpoch,
  previousHistoryClosureSha256 = "0".repeat(64),
  inheritedDescriptors = [],
  onBoundary = async () => {},
  assertOwnerLease = async () => {},
  now = new Date()
}) {
  if (typeof onBoundary !== "function"
    || typeof assertOwnerLease !== "function") {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      "onBoundary and assertOwnerLease must be functions"
    );
  }
  const recovery = prepareStartupRecovery({
    bytes,
    beforeRawSha256,
    closureProofSha256,
    deploymentId,
    policyVersion,
    oldContainerId,
    targetEpoch,
    createdFromEpoch,
    previousHistoryClosureSha256,
    inheritedDescriptors,
    now
  });
  if (!recovery.required) {
    return Object.freeze({
      required: false,
      statePath,
      beforeRevision: recovery.beforeRevision,
      beforeRawSha256,
      afterRevision: recovery.afterRevision,
      afterRawSha256: recovery.afterRawSha256
    });
  }
  const pending = await readPendingTransactions(recoveryDir);
  if (pending.length !== 0) {
    throw transactionError(
      "runtime_recovery_multiple_pending",
      "a recovery transaction is already pending"
    );
  }
  await ensurePrivateDirectory(recoveryDir);
  await assertNoConflictingTransactionFiles(
    recoveryDir,
    recovery
  );
  const journal = recoveryJournalRecord(recovery);
  const afterPath = join(recoveryDir, `${recovery.transactionId}.after.json`);
  const historyClosurePath = join(
    recoveryDir,
    `${recovery.transactionId}.history-closure.json`
  );
  await assertOwnerLease();
  await writePrivateAtomic(historyClosurePath, recovery.historyClosureBytes);
  await assertExactPrivateFile(
    historyClosurePath,
    recovery.historyClosureBytes,
    "history closure"
  );
  await onBoundary("history-closure");
  await assertOwnerLease();
  await writePrivateAtomic(afterPath, recovery.afterBytes);
  await assertExactPrivateFile(afterPath, recovery.afterBytes, "after bytes");
  await onBoundary("after-bytes");
  await assertOwnerLease();
  await writePrivateAtomic(
    join(recoveryDir, `${recovery.transactionId}.json`),
    Buffer.from(JSON.stringify(journal, null, 2), "utf8")
  );
  await assertOwnerLease();
  await onBoundary("journal-prepared");
  return Object.freeze({
    required: true,
    statePath,
    journal,
    afterBytes: recovery.afterBytes,
    scopeProjection: recovery.scopeProjection,
    historyClosure: recovery.historyClosure,
    historyClosureBytes: recovery.historyClosureBytes,
    historyClosureSha256: recovery.historyClosureSha256
  });
}

export async function resumeRecoveryTransaction({
  recoveryDir,
  statePath,
  assertOwnerLease = async () => {}
}) {
  if (typeof assertOwnerLease !== "function") {
    throw transactionError(
      "runtime_recovery_transaction_invalid",
      "assertOwnerLease must be a function"
    );
  }
  const pending = await readPendingTransactions(recoveryDir);
  if (pending.length === 0) {
    return null;
  }
  if (pending.length !== 1) {
    throw transactionError(
      "runtime_recovery_multiple_pending",
      "exactly one recovery transaction may be pending"
    );
  }
  const transactionId = pending[0];
  const journalPath = join(recoveryDir, `${transactionId}.json`);
  const afterPath = join(recoveryDir, `${transactionId}.after.json`);
  const historyClosurePath = join(
    recoveryDir,
    `${transactionId}.history-closure.json`
  );
  const journal = await readJournal(journalPath, transactionId);
  let currentBytes;
  try {
    currentBytes = await readFile(statePath);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_state_missing",
      `cannot read current state: ${error.code || error.message}`
    );
  }
  const currentSha256 = sha256(currentBytes);
  let afterBytes;
  try {
    afterBytes = await readFile(afterPath);
  } catch (error) {
    if (error?.code !== "ENOENT" || currentSha256 !== journal.beforeRawSha256) {
      throw transactionError(
        "runtime_recovery_after_missing",
        `cannot read exact after bytes: ${error.code || error.message}`
      );
    }
    const reconstructed = prepareStartupRecovery({
      bytes: currentBytes,
      beforeRawSha256: journal.beforeRawSha256,
      closureProofSha256: journal.closureProofSha256,
      deploymentId: journal.deploymentId,
      policyVersion: journal.policyVersion,
      oldContainerId: journal.oldContainerId,
      targetEpoch: journal.targetEpoch,
      createdFromEpoch: journal.createdFromEpoch,
      previousHistoryClosureSha256: journal.previousHistoryClosureSha256,
      inheritedDescriptors: journal.inheritedDescriptors,
      now: new Date(journal.createdAt)
    });
    if (reconstructed.transactionId !== transactionId
      || reconstructed.afterRawSha256 !== journal.afterRawSha256
      || reconstructed.scopeProjectionSha256 !== journal.scopeProjectionSha256
      || reconstructed.historyClosureSha256 !== journal.historyClosureSha256
      || reconstructed.historyClosure.previousHistoryClosureSha256
        !== journal.previousHistoryClosureSha256) {
      throw transactionError(
        "runtime_recovery_after_missing",
        "the missing after bytes cannot be reconstructed exactly"
      );
    }
    afterBytes = reconstructed.afterBytes;
    await assertOwnerLease();
    await writePrivateAtomic(afterPath, afterBytes);
  }
  if (sha256(afterBytes) !== journal.afterBytesSha256
    || sha256(afterBytes) !== journal.afterRawSha256) {
    throw transactionError(
      "runtime_recovery_after_hash_mismatch",
      "exact after bytes do not match the journal"
    );
  }
  await readAndValidateHistoryClosure(historyClosurePath, journal, afterBytes);
  if (currentSha256 === journal.afterRawSha256) {
    await assertOwnerLease();
    const nextJournal = await updateJournalStatus(
      journalPath,
      journal,
      "after-verified"
    );
    return Object.freeze({
      transactionId,
      journal: nextJournal,
      stateWritten: false,
      currentRawSha256: currentSha256
    });
  }
  if (currentSha256 !== journal.beforeRawSha256) {
    throw transactionError(
      "runtime_recovery_state_conflict",
      "current state is neither the exact before nor exact after bytes"
    );
  }

  await assertOwnerLease();
  await writePrivateAtomic(statePath, afterBytes);
  const readback = await readFile(statePath);
  if (sha256(readback) !== journal.afterRawSha256) {
    throw transactionError(
      "runtime_recovery_after_readback_mismatch",
      "state readback does not equal the exact after bytes"
    );
  }
  await assertOwnerLease();
  const nextJournal = await updateJournalStatus(
    journalPath,
    journal,
    "after-verified"
  );
  await assertOwnerLease();
  return Object.freeze({
    transactionId,
    journal: nextJournal,
    stateWritten: true,
    currentRawSha256: sha256(readback)
  });
}


export async function reuseCommittedRecoveryTransaction({
  recoveryDir,
  statePath,
  bytes,
  beforeRawSha256,
  succession,
  assertOwnerLease = async () => {}
}) {
  if (!Buffer.isBuffer(bytes)
    || typeof beforeRawSha256 !== "string"
    || !DIGEST.test(beforeRawSha256)
    || succession?.schemaVersion !== "1"
    || succession?.mode !== "reuse-after"
    || typeof succession.sourceTransactionId !== "string"
    || !DIGEST.test(succession.sourceTransactionId)
    || typeof assertOwnerLease !== "function") {
    throw transactionError(
      "runtime_recovery_succession_invalid",
      "succession reuse requires exact state, digest, transaction, and owner inputs"
    );
  }
  await assertOwnerLease();
  if (sha256(bytes) !== succession.sourceStateRawSha256
    || beforeRawSha256 !== succession.sourceStateRawSha256) {
    throw transactionError(
      "runtime_recovery_succession_state_mismatch",
      "succession reuse state does not equal the sealed source after bytes"
    );
  }
  const transactionId = succession.sourceTransactionId;
  const journalPath = join(recoveryDir, `${transactionId}.json`);
  const afterPath = join(recoveryDir, `${transactionId}.after.json`);
  const historyClosurePath = join(
    recoveryDir,
    `${transactionId}.history-closure.json`
  );
  const journal = await readJournal(journalPath, transactionId);
  if (journal.status !== "committed"
    || journal.epochManifestSha256
      !== succession.transactionEpochManifestSha256
    || journal.afterRevision !== succession.sourceStateRevision
    || journal.afterRawSha256 !== succession.sourceStateRawSha256
    || journal.scopeProjectionSha256
      !== succession.sourceScopeProjectionSha256
    || journal.historyClosureSha256
      !== succession.sourceHistoryClosureSha256) {
    throw transactionError(
      "runtime_recovery_succession_conflict",
      "source journal does not match the sealed succession identity"
    );
  }
  let afterBytes;
  try {
    afterBytes = await readFile(afterPath);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_succession_source_missing",
      `cannot read source after bytes: ${error.code || error.message}`
    );
  }
  if (!afterBytes.equals(bytes)
    || sha256(afterBytes) !== journal.afterRawSha256) {
    throw transactionError(
      "runtime_recovery_succession_state_mismatch",
      "current state is not the exact committed source after bytes"
    );
  }
  const history = await readAndValidateHistoryClosure(
    historyClosurePath,
    journal,
    bytes
  );
  const projection = projectStartupRecoveryScope(bytes);
  if (!projection.eligible
    || projection.revision !== journal.afterRevision
    || projection.scopeProjectionSha256 !== journal.scopeProjectionSha256
    || projection.rawSha256 !== journal.afterRawSha256
    || history.sha256 !== journal.historyClosureSha256) {
    throw transactionError(
      "runtime_recovery_succession_scope_mismatch",
      "current state scope or history closure is not the exact sealed source"
    );
  }
  await assertOwnerLease();
  return Object.freeze({
    required: true,
    transactionId,
    revision: journal.afterRevision,
    rawSha256: journal.afterRawSha256,
    afterRawSha256: journal.afterRawSha256,
    scopeProjectionSha256: journal.scopeProjectionSha256,
    historyClosureSha256: journal.historyClosureSha256,
    previousHistoryClosureSha256: journal.previousHistoryClosureSha256,
    closureProofSha256: journal.closureProofSha256,
    targetEpoch: journal.targetEpoch,
    reused: true
  });
}


export async function markRecoveryCommitted({
  recoveryDir,
  transactionId,
  epochManifestSha256
}) {
  requireDigest(transactionId, "transactionId");
  requireDigest(epochManifestSha256, "epochManifestSha256");
  const journalPath = join(recoveryDir, `${transactionId}.json`);
  const journal = await readJournal(journalPath, transactionId);
  if (journal.status !== "after-verified" && journal.status !== "committed") {
    throw transactionError(
      "runtime_recovery_transaction_state_invalid",
      "only an after-verified transaction can be committed"
    );
  }
  if (journal.status === "committed") {
    if (journal.epochManifestSha256 !== epochManifestSha256) {
      throw transactionError(
        "runtime_recovery_transaction_state_invalid",
        "committed recovery journal is bound to another epoch manifest"
      );
    }
    return journal;
  }
  const next = {
    ...journal,
    status: "committed",
    committedAt: new Date().toISOString(),
    epochManifestSha256
  };
  await writePrivateAtomic(
    journalPath,
    Buffer.from(JSON.stringify(next, null, 2), "utf8")
  );
  return Object.freeze(next);
}

export async function readRecoveryJournal(recoveryDir, transactionId) {
  requireDigest(transactionId, "transactionId");
  return readJournal(join(recoveryDir, `${transactionId}.json`), transactionId);
}

export async function readCommittedHistoryDescriptors({
  recoveryDir,
  transactionId,
  historyClosureSha256,
  deploymentId,
  policyVersion
}) {
  const chain = await readCommittedHistoryChain({
    recoveryDir,
    previousHistoryClosureSha256: historyClosureSha256,
    inheritedDescriptors: null,
    deploymentId,
    policyVersion
  });
  const source = chain.get(transactionId);
  if (source === undefined
    || source.journal.historyClosureSha256 !== historyClosureSha256) {
    throw transactionError(
      "runtime_recovery_succession_conflict",
      "history closure does not identify the exact committed chain source"
    );
  }
  return Object.freeze(source.closure.descriptors.map(value => (
    structuredClone(value)
  )));
}

async function assertNoConflictingTransactionFiles(recoveryDir, recovery) {
  let entries;
  try {
    entries = await readdir(recoveryDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const filesByTransaction = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = /^([a-f0-9]{64})\.(after|history-closure)\.json$/.exec(entry.name);
    if (!match) {
      continue;
    }
    const files = filesByTransaction.get(match[1]) || [];
    files.push({ name: entry.name, kind: match[2] });
    filesByTransaction.set(match[1], files);
  }

  const currentFiles = filesByTransaction.get(recovery.transactionId) || [];
  for (const file of currentFiles) {
    const expected = file.kind === "after"
      ? recovery.afterBytes
      : recovery.historyClosureBytes;
    await assertExactPrivateFile(
      join(recoveryDir, file.name),
      expected,
      file.kind === "after" ? "orphan after bytes" : "orphan history closure"
    );
  }

  const foreignFiles = [...filesByTransaction.entries()].filter(([transactionId]) => (
    transactionId !== recovery.transactionId
  ));
  if (foreignFiles.length === 0) {
    return;
  }

  const committedChain = await readCommittedHistoryChain({
    recoveryDir,
    previousHistoryClosureSha256:
      recovery.historyClosure.previousHistoryClosureSha256,
    inheritedDescriptors: recovery.inheritedDescriptors,
    deploymentId: recovery.deploymentId,
    policyVersion: recovery.policyVersion
  });
  for (const [transactionId, files] of foreignFiles) {
    const source = committedChain.get(transactionId);
    if (source === undefined) {
      throw transactionError(
        "runtime_recovery_orphan_transaction",
        "recovery directory contains bytes from another transaction"
      );
    }
    for (const file of files) {
      const expected = file.kind === "after"
        ? source.afterBytes
        : source.historyClosureBytes;
      await assertExactPrivateFile(
        join(recoveryDir, file.name),
        expected,
        file.kind === "after"
          ? "inherited committed after bytes"
          : "inherited committed history closure"
      );
    }
  }
}

async function readCommittedHistoryChain({
  recoveryDir,
  previousHistoryClosureSha256,
  inheritedDescriptors,
  deploymentId,
  policyVersion
}) {
  let entries;
  try {
    entries = await readdir(recoveryDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  const journalsByClosure = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = JOURNAL_NAME.exec(entry.name);
    if (!match) {
      continue;
    }
    const journal = await readJournal(
      join(recoveryDir, entry.name),
      match[1]
    );
    if (journal.status !== "committed") {
      continue;
    }
    const candidates = journalsByClosure.get(journal.historyClosureSha256) || [];
    candidates.push(journal.transactionId);
    journalsByClosure.set(journal.historyClosureSha256, candidates);
  }

  const inheritedSet = inheritedDescriptors === null
    ? null
    : new Set(inheritedDescriptors.map(stableJson));
  if (inheritedSet !== null
    && inheritedSet.size !== inheritedDescriptors.length) {
    throw transactionError(
      "runtime_recovery_history_invalid",
      "inherited history descriptors must be unique"
    );
  }

  const chain = new Map();
  let parentSha256 = previousHistoryClosureSha256;
  let immediate = true;
  while (parentSha256 !== "0".repeat(64)) {
    const candidates = journalsByClosure.get(parentSha256);
    if (!candidates || candidates.length === 0) {
      throw transactionError(
        "runtime_recovery_succession_source_missing",
        "the inherited committed history source is absent"
      );
    }
    if (candidates.length !== 1) {
      throw transactionError(
        "runtime_recovery_orphan_transaction",
        "the inherited committed history source is ambiguous"
      );
    }
    const transactionId = candidates[0];
    if (chain.has(transactionId)) {
      throw transactionError(
        "runtime_recovery_history_invalid",
        "the inherited committed history chain contains a cycle"
      );
    }
    const source = await readCommittedHistorySource({
      recoveryDir,
      transactionId,
      historyClosureSha256: parentSha256,
      deploymentId,
      policyVersion
    });
    const sourceDescriptors = source.closure.descriptors;
    const sourceSet = new Set(sourceDescriptors.map(stableJson));
    const exactImmediate = inheritedSet !== null
      && immediate
      && sourceDescriptors.length === inheritedDescriptors.length
      && sourceSet.size === inheritedSet.size
      && [...sourceSet].every(value => inheritedSet.has(value));
    const inheritedAncestor = inheritedSet === null
      || (!immediate && sourceDescriptors.every(value => (
        inheritedSet.has(stableJson(value))
      )));
    if (inheritedSet !== null
      && ((!exactImmediate && !inheritedAncestor)
        || sourceSet.size !== sourceDescriptors.length)) {
      throw transactionError(
        "runtime_recovery_history_scope_mismatch",
        "inherited committed history does not match the current descriptor range"
      );
    }
    chain.set(transactionId, source);
    parentSha256 = source.closure.previousHistoryClosureSha256;
    immediate = false;
  }
  return chain;
}

async function readCommittedHistorySource({
  recoveryDir,
  transactionId,
  historyClosureSha256,
  deploymentId,
  policyVersion
}) {
  requireDigest(transactionId, "transactionId");
  requireDigest(historyClosureSha256, "historyClosureSha256");
  if (typeof deploymentId !== "string"
    || typeof policyVersion !== "string"
    || deploymentId.trim() === ""
    || policyVersion.trim() === "") {
    throw transactionError(
      "runtime_recovery_succession_invalid",
      "committed history requires exact deployment and policy identities"
    );
  }
  const journal = await readJournal(
    join(recoveryDir, `${transactionId}.json`),
    transactionId
  );
  if (journal.status !== "committed"
    || journal.historyClosureSha256 !== historyClosureSha256) {
    throw transactionError(
      "runtime_recovery_succession_conflict",
      "history source is not the exact committed journal"
    );
  }
  if (journal.deploymentId !== deploymentId
    || journal.policyVersion !== policyVersion) {
    throw transactionError(
      "runtime_recovery_succession_conflict",
      "history source belongs to another deployment or policy"
    );
  }
  const afterPath = join(recoveryDir, `${transactionId}.after.json`);
  let afterBytes;
  try {
    afterBytes = await readFile(afterPath);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_succession_source_missing",
      `cannot read committed source after bytes: ${error.code || error.message}`
    );
  }
  if (sha256(afterBytes) !== journal.afterRawSha256) {
    throw transactionError(
      "runtime_recovery_history_hash_mismatch",
      "committed source after bytes do not match the journal"
    );
  }
  const history = await readAndValidateHistoryClosure(
    join(recoveryDir, `${transactionId}.history-closure.json`),
    journal,
    afterBytes
  );
  const projection = projectStartupRecoveryScope(afterBytes);
  if (!projection.eligible
    || projection.revision !== journal.afterRevision
    || projection.rawSha256 !== journal.afterRawSha256
    || projection.scopeProjectionSha256 !== journal.scopeProjectionSha256) {
    throw transactionError(
      "runtime_recovery_history_scope_mismatch",
      "committed source scope does not match its exact after bytes"
    );
  }
  return Object.freeze({
    journal,
    closure: history.closure,
    historyClosureBytes: history.bytes,
    afterBytes
  });
}

async function assertExactPrivateFile(path, expectedBytes, label) {
  let info;
  let bytes;
  try {
    info = await stat(path);
    bytes = await readFile(path);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_persistence_invalid",
      `${label} is unavailable: ${error.code || error.message}`
    );
  }
  if (!info.isFile()
    || !hasPrivatePermissions(info)
    || !bytes.equals(expectedBytes)) {
    throw transactionError(
      "runtime_recovery_persistence_invalid",
      `${label} is not the exact private persisted bytes`
    );
  }
}

async function readAndValidateHistoryClosure(path, journal, afterBytes) {
  let info;
  let bytes;
  try {
    info = await stat(path);
    bytes = await readFile(path);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_history_missing",
      `cannot read persisted history closure: ${error.code || error.message}`
    );
  }
  if (!info.isFile() || !hasPrivatePermissions(info)) {
    throw transactionError(
      "runtime_recovery_history_invalid",
      "history closure must be a root-only 0600 file"
    );
  }
  const historyClosureSha256 = sha256(bytes);
  if (historyClosureSha256 !== journal.historyClosureSha256) {
    throw transactionError(
      "runtime_recovery_history_hash_mismatch",
      "history closure bytes do not match the journal"
    );
  }
  let closure;
  try {
    closure = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw transactionError(
      "runtime_recovery_history_invalid",
      "history closure is not valid JSON"
    );
  }
  exactKeys(closure, [
    "schemaVersion",
    "transactionId",
    "previousHistoryClosureSha256",
    "scopeProjectionSha256",
    "descriptors"
  ], "history closure");
  if (closure.schemaVersion !== "1"
    || closure.transactionId !== journal.transactionId
    || closure.previousHistoryClosureSha256
      !== journal.previousHistoryClosureSha256
    || closure.scopeProjectionSha256 !== journal.scopeProjectionSha256
    || !Array.isArray(closure.descriptors)
    || stableJson(closure.descriptors) !== stableJson(journal.descriptors)) {
    throw transactionError(
      "runtime_recovery_history_invalid",
      "history closure identity, parent hash, or descriptor range is invalid"
    );
  }
  requireDigest(closure.previousHistoryClosureSha256, "previousHistoryClosureSha256");
  requireDigest(closure.scopeProjectionSha256, "scopeProjectionSha256");
  const projection = projectStartupRecoveryScope(afterBytes);
  const persistedDescriptors = new Set(closure.descriptors.map(stableJson));
  const completeScope = projection.descriptors.every(descriptor => (
    persistedDescriptors.has(stableJson(descriptor))
  ));
  const expectedRange = new Set([
    ...projection.descriptors,
    ...journal.inheritedDescriptors
  ].map(stableJson));
  const uniqueRange = persistedDescriptors.size === closure.descriptors.length
    && expectedRange.size === persistedDescriptors.size
    && [...expectedRange].every(descriptor => (
      persistedDescriptors.has(descriptor)
    ));
  if (!projection.eligible
    || projection.stateVersion !== 2
    || !completeScope
    || !uniqueRange) {
    throw transactionError(
      "runtime_recovery_history_scope_mismatch",
      "history closure does not cover the exact complete recovery scope"
    );
  }
  return Object.freeze({ closure, bytes, sha256: historyClosureSha256 });
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`;
}

async function readPendingTransactions(recoveryDir) {
  let entries;
  try {
    entries = await readdir(recoveryDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze([]);
    }
    throw error;
  }
  const pending = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = JOURNAL_NAME.exec(entry.name);
    if (!match) {
      continue;
    }
    const journal = await readJournal(
      join(recoveryDir, entry.name),
      match[1]
    );
    if (journal.status === "prepared" || journal.status === "after-verified") {
      pending.push(match[1]);
    }
  }
  pending.sort();
  return Object.freeze(pending);
}

async function readJournal(path, transactionId) {
  let info;
  let bytes;
  try {
    info = await stat(path);
    bytes = await readFile(path);
  } catch (error) {
    throw transactionError(
      "runtime_recovery_journal_missing",
      `cannot read recovery journal: ${error.code || error.message}`
    );
  }
  if (!info.isFile() || !hasPrivatePermissions(info)) {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "recovery journal must be a root-only 0600 file"
    );
  }
  let journal;
  try {
    journal = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "recovery journal is not valid JSON"
    );
  }
  const baseKeys = [
    "schemaVersion",
    "transactionId",
    "status",
    "deploymentId",
    "policyVersion",
    "oldContainerId",
    "targetEpoch",
    "createdFromEpoch",
    "createdAt",
    "beforeRevision",
    "beforeRawSha256",
    "afterRevision",
    "afterRawSha256",
    "afterBytesSha256",
    "closureProofSha256",
    "scopeProjectionSha256",
    "historyClosureSha256",
    "previousHistoryClosureSha256",
    "inheritedDescriptors",
    "descriptors"
  ];
  const allowed = journal.status === "committed"
    ? [...baseKeys, "committedAt", "epochManifestSha256"]
    : baseKeys;
  exactKeys(journal, allowed, "recovery journal");
  if (journal.schemaVersion !== "1"
    || journal.transactionId !== transactionId
    || !["prepared", "after-verified", "committed"].includes(journal.status)) {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "recovery journal identity or status is invalid"
    );
  }
  requireInteger(journal.beforeRevision, "beforeRevision");
  requireInteger(journal.afterRevision, "afterRevision");
  if (journal.afterRevision !== journal.beforeRevision + 1) {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "recovery journal revision must advance exactly once"
    );
  }
  for (const key of [
    "beforeRawSha256",
    "afterRawSha256",
    "afterBytesSha256",
    "closureProofSha256",
    "scopeProjectionSha256",
    "historyClosureSha256",
    "previousHistoryClosureSha256"
  ]) {
    requireDigest(journal[key], key);
  }
  if (journal.afterRawSha256 !== journal.afterBytesSha256) {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "after raw and after-bytes digests must identify the same canonical bytes"
    );
  }
  if (!Array.isArray(journal.inheritedDescriptors)
    || !Array.isArray(journal.descriptors)
    || journal.inheritedDescriptors.length > 100_000
    || journal.descriptors.length > 100_000) {
    throw transactionError(
      "runtime_recovery_journal_invalid",
      "recovery descriptors must be bounded arrays"
    );
  }
  return Object.freeze(journal);
}

async function updateJournalStatus(path, journal, status) {
  if (journal.status === status) {
    return journal;
  }
  if (journal.status !== "prepared" || status !== "after-verified") {
    throw transactionError(
      "runtime_recovery_journal_transition_invalid",
      `cannot transition recovery journal from ${journal.status} to ${status}`
    );
  }
  const next = { ...journal, status };
  await writePrivateAtomic(
    path,
    Buffer.from(JSON.stringify(next, null, 2), "utf8")
  );
  return Object.freeze(next);
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function hasPrivatePermissions(info) {
  return process.platform === "win32"
    || (Number(info.mode) & 0o777) === 0o600;
}

async function writePrivateAtomic(targetPath, bytes) {
  const parent = dirname(targetPath);
  await ensurePrivateDirectory(parent);
  const tempPath = join(
    parent,
    `.${targetPath.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, targetPath);
    if (process.platform === "linux") {
      const parentHandle = await open(parent, "r");
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw transactionError(
      "runtime_recovery_write_failed",
      `failed to persist recovery transaction: ${error.code || error.message}`
    );
  }
}
