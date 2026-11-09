import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireServerStateLock } from "../src/core/serverStateLock.js";
import {
  runStartupMaintenanceEntry
} from "../src/service/startupMaintenanceCli.js";
import {
  markRecoveryCommitted
} from "../src/service/runtimeRecoveryTransaction.js";

const projectRoot = join(import.meta.dirname, "..");
const artifactPath = join(
  projectRoot,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "sfsc_owner_lock.node"
);
const manifestPath = join(
  projectRoot,
  "server",
  "runtime",
  "native",
  "linux-arm64",
  "manifest.json"
);
const ZERO = "0".repeat(64);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function syntheticFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sfsc-maintenance-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "relation-services.json");
  const recoveryDir = join(root, "recovery");
  const resultPath = join(root, "maintenance-result.json");
  const state = {
    version: 2,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
    revision: 7,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    operations: {},
    relations: {}
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { root, statePath, recoveryDir, resultPath, state };
}

function configFor(fixture, overrides = {}) {
  return {
    schemaVersion: "1",
    statePath: fixture.statePath,
    recoveryDir: fixture.recoveryDir,
    resultPath: fixture.resultPath,
    artifactPath,
    manifestPath,
    mode: "require-existing",
    deploymentId: "dep-maintenance-entry",
    policyVersion: "startup-admission-integration-v3",
    targetEpoch: "epoch-00000001",
    createdFromEpoch: "initial",
    oldContainerId: "no-previous-test",
    closureProofSha256: "a".repeat(64),
    previousHistoryClosureSha256: ZERO,
    previousHistoryClosurePath: null,
    ...overrides
  };
}

function gateFor(bytes, calls) {
  const lease = Object.freeze({});
  return {
    lease,
    gate: {
      acquireOwnerLease({ statePath }) {
        calls.push(["owner", statePath]);
        return lease;
      },
      evaluateStartupState(received) {
        assert.equal(received, lease);
        calls.push(["snapshot"]);
        return {
          fullStartupAdmission: false,
          revision: JSON.parse(bytes.toString("utf8")).revision,
          rawSha256: sha256(bytes)
        };
      },
      async assertOwnerLease(received) {
        assert.equal(received, lease);
        calls.push(["assert"]);
        return { valid: true };
      }
    }
  };
}

function recoverySuccession(result, epochManifestSha256, mode) {
  return {
    schemaVersion: "1",
    mode,
    previousOperationId: "c".repeat(64),
    previousTargetEpoch: result.targetEpoch,
    previousEpochManifestSha256: epochManifestSha256,
    previousFailureCode: "synthetic_host_restart",
    closedProofSha256: "d".repeat(64),
    sourceStateRevision: result.revision,
    sourceStateRawSha256: result.rawSha256,
    sourceTransactionId: result.transactionId,
    sourceScopeProjectionSha256: result.scopeProjectionSha256,
    sourceHistoryClosureSha256: result.historyClosureSha256,
    transactionEpochManifestSha256:
      mode === "reuse-after" ? epochManifestSha256 : null
  };
}

async function seedCommittedRecovery(fixture) {
  const initialState = stateWithRecoveryScope();
  const initialBytes = Buffer.from(
    JSON.stringify(initialState, null, 2),
    "utf8"
  );
  await writeFile(fixture.statePath, initialBytes, { mode: 0o600 });
  const result = await runStartupMaintenanceEntry({
    config: configFor(fixture),
    createGate: () => gateFor(initialBytes, []).gate,
    acquireStateLock: acquireServerStateLock
  });
  const epochManifestSha256 = "e".repeat(64);
  await markRecoveryCommitted({
    recoveryDir: fixture.recoveryDir,
    transactionId: result.transactionId,
    epochManifestSha256
  });
  const journalPath = join(
    fixture.recoveryDir,
    `${result.transactionId}.json`
  );
  const afterPath = join(
    fixture.recoveryDir,
    `${result.transactionId}.after.json`
  );
  const historyPath = join(
    fixture.recoveryDir,
    `${result.transactionId}.history-closure.json`
  );
  const afterBytes = await readFile(afterPath);
  const historyBytes = await readFile(historyPath);
  return {
    result,
    epochManifestSha256,
    journalPath,
    afterPath,
    historyPath,
    afterBytes,
    historyBytes,
    journal: JSON.parse(await readFile(journalPath, "utf8")),
    closure: JSON.parse(historyBytes.toString("utf8"))
  };
}

test("production entry creates a recovery transaction for existing V2 without a journal", async t => {
  const fixture = await syntheticFixture(t);
  const calls = [];
  const bytes = await readFile(fixture.statePath);
  const owner = gateFor(bytes, calls);
  const result = await runStartupMaintenanceEntry({
    config: configFor(fixture),
    createGate: () => owner.gate,
    acquireStateLock: acquireServerStateLock,
    openManager: async () => {
      throw new Error("existing state must not be initialized");
    },
    runTransaction: async input => {
      calls.push(["transaction", input.transaction.targetEpoch]);
      assert.deepEqual(input.transaction.inheritedDescriptors, []);
      assert.equal(input.transaction.previousHistoryClosureSha256, ZERO);
      const before = await readFile(input.statePath);
      const state = JSON.parse(before.toString("utf8"));
      assert.equal(state.revision, 7);
      state.revision = 8;
      state.updatedAt = "2026-10-23T00:00:01.000Z";
      const after = Buffer.from(JSON.stringify(state, null, 2), "utf8");
      await writeFile(input.statePath, after, { mode: 0o600 });
      return {
        required: true,
        transactionId: "b".repeat(64),
        revision: 8,
        rawSha256: sha256(after),
        scopeProjectionSha256: "c".repeat(64),
        historyClosureSha256: "d".repeat(64),
        previousHistoryClosureSha256: ZERO,
        targetEpoch: "epoch-00000001"
      };
    }
  });
  assert.equal(result.required, true);
  assert.equal(result.initialized, false);
  assert.equal(result.revision, 8);
  assert.deepEqual(JSON.parse(await readFile(fixture.resultPath, "utf8")), result);
  assert.ok(calls.some(call => call[0] === "transaction"));
  assert.equal(calls.filter(call => call[0] === "snapshot").length, 1);
});

test("synthetic owner gate exercises the default JS transaction on complete V2 state", async t => {
  const fixture = await syntheticFixture(t);
  const state = stateWithRecoveryScope();
  const before = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  await writeFile(fixture.statePath, before, { mode: 0o600 });
  const owner = gateFor(before, []);
  const result = await runStartupMaintenanceEntry({
    config: configFor(fixture),
    createGate: () => owner.gate,
    acquireStateLock: acquireServerStateLock
  });
  assert.equal(result.required, true);
  assert.equal(result.revision, 8);
  const after = await readFile(fixture.statePath);
  assert.equal(sha256(after), result.rawSha256);
  assert.equal(JSON.parse(after.toString("utf8")).revision, 8);
  const journalNames = (await readdir(fixture.recoveryDir)).filter(name => (
    /^[a-f0-9]{64}\.json$/.test(name)
  ));
  assert.equal(journalNames.length, 1);
  const journal = JSON.parse(await readFile(
    join(fixture.recoveryDir, journalNames[0]),
    "utf8"
  ));
  assert.equal(journal.status, "after-verified");
  assert.equal(journal.beforeRevision, 7);
  assert.equal(journal.afterRevision, 8);
  assert.equal(journal.transactionId, result.transactionId);
  assert.equal(journal.historyClosureSha256, result.historyClosureSha256);
  assert.ok(journal.descriptors.length > 0);
});

test("entry reuses a committed recovery and carries exact history into a changed-current transaction", async t => {
  const fixture = await syntheticFixture(t);
  const initialState = stateWithRecoveryScope();
  const initialBytes = Buffer.from(JSON.stringify(initialState, null, 2), "utf8");
  await writeFile(fixture.statePath, initialBytes, { mode: 0o600 });

  const first = await runStartupMaintenanceEntry({
    config: configFor(fixture),
    createGate: () => gateFor(initialBytes, []).gate,
    acquireStateLock: acquireServerStateLock
  });
  assert.equal(first.required, true);
  assert.equal(first.revision, 8);

  const firstJournalPath = join(
    fixture.recoveryDir,
    `${first.transactionId}.json`
  );
  const firstHistoryPath = join(
    fixture.recoveryDir,
    `${first.transactionId}.history-closure.json`
  );
  const firstAfterPath = join(
    fixture.recoveryDir,
    `${first.transactionId}.after.json`
  );
  const sealedState = await readFile(fixture.statePath);
  const firstHistoryBytes = await readFile(firstHistoryPath);
  const firstClosure = JSON.parse(firstHistoryBytes.toString("utf8"));
  assert.equal(
    firstHistoryBytes.length > 0
      && sha256(firstHistoryBytes) === first.historyClosureSha256,
    true
  );
  assert.equal(JSON.parse(await readFile(firstJournalPath, "utf8")).status,
    "after-verified");

  const syntheticEpochManifestSha256 = "e".repeat(64);
  await markRecoveryCommitted({
    recoveryDir: fixture.recoveryDir,
    transactionId: first.transactionId,
    epochManifestSha256: syntheticEpochManifestSha256
  });
  const committedJournalBytes = await readFile(firstJournalPath);
  const committedJournal = JSON.parse(committedJournalBytes.toString("utf8"));
  assert.equal(committedJournal.status, "committed");
  assert.equal(
    committedJournal.epochManifestSha256,
    syntheticEpochManifestSha256
  );

  const previousHistoryPath = join(fixture.root, "history-closure.json");
  await writeFile(previousHistoryPath, firstHistoryBytes, { mode: 0o600 });
  const reuseSuccession = recoverySuccession(
    first,
    syntheticEpochManifestSha256,
    "reuse-after"
  );
  const reused = await runStartupMaintenanceEntry({
    config: configFor(fixture, {
      previousHistoryClosureSha256: first.historyClosureSha256,
      previousHistoryClosurePath: previousHistoryPath,
      succession: reuseSuccession
    }),
    createGate: () => gateFor(sealedState, []).gate,
    acquireStateLock: acquireServerStateLock
  });
  assert.equal(reused.required, true);
  assert.equal(reused.transactionId, first.transactionId);
  assert.equal(reused.revision, first.revision);
  assert.equal(reused.rawSha256, first.rawSha256);
  assert.equal(reused.scopeProjectionSha256, first.scopeProjectionSha256);
  assert.equal(reused.historyClosureSha256, first.historyClosureSha256);
  assert.deepEqual(await readFile(fixture.statePath), sealedState);
  assert.deepEqual(await readFile(firstJournalPath), committedJournalBytes);
  assert.deepEqual(await readFile(firstHistoryPath), firstHistoryBytes);
  assert.deepEqual(await readFile(firstAfterPath), sealedState);

  const firstState = JSON.parse(sealedState.toString("utf8"));
  const unknownOperation = structuredClone(
    firstState.operations["op-rel-current"]
  );
  const unknownRelation = structuredClone(
    firstState.relations["rel-current"]
  );
  assert.equal(unknownOperation.phase, "unknown");
  const next = currentRecoveryPair("rel-second", "5");
  next.operation.createdAt = "2026-10-23T00:00:09.000Z";
  next.operation.updatedAt = "2026-10-23T00:00:09.000Z";
  next.relation.updatedAt = "2026-10-23T00:00:09.000Z";
  firstState.revision += 1;
  firstState.updatedAt = "2026-10-23T00:00:09.000Z";
  firstState.operations[next.operation.operationId] = next.operation;
  firstState.relations[next.relation.relationId] = next.relation;
  const changedCurrentBytes = Buffer.from(
    JSON.stringify(firstState, null, 2),
    "utf8"
  );
  await writeFile(fixture.statePath, changedCurrentBytes, { mode: 0o600 });

  const recoverCurrentSuccession = recoverySuccession(
    first,
    syntheticEpochManifestSha256,
    "recover-current"
  );
  const second = await runStartupMaintenanceEntry({
    config: configFor(fixture, {
      previousHistoryClosureSha256: first.historyClosureSha256,
      previousHistoryClosurePath: previousHistoryPath,
      targetEpoch: "epoch-00000002",
      createdFromEpoch: first.targetEpoch,
      oldContainerId: "old-container-after-current-update",
      closureProofSha256: "9".repeat(64),
      succession: recoverCurrentSuccession
    }),
    createGate: () => gateFor(changedCurrentBytes, []).gate,
    acquireStateLock: acquireServerStateLock
  });
  assert.equal(second.required, true);
  assert.notEqual(second.transactionId, first.transactionId);
  assert.equal(second.revision, 10);
  assert.equal(second.previousHistoryClosureSha256,
    first.historyClosureSha256);

  const secondJournalPath = join(
    fixture.recoveryDir,
    `${second.transactionId}.json`
  );
  const secondHistoryPath = join(
    fixture.recoveryDir,
    `${second.transactionId}.history-closure.json`
  );
  const secondJournal = JSON.parse(
    await readFile(secondJournalPath, "utf8")
  );
  assert.equal(secondJournal.beforeRevision, 9);
  assert.equal(secondJournal.afterRevision, 10);
  assert.deepEqual(secondJournal.inheritedDescriptors,
    firstClosure.descriptors);

  const secondClosure = JSON.parse(
    await readFile(secondHistoryPath, "utf8")
  );
  assert.equal(secondClosure.previousHistoryClosureSha256,
    first.historyClosureSha256);
  for (const descriptor of firstClosure.descriptors) {
    assert.ok(secondClosure.descriptors.some(candidate => (
      stableJson(candidate) === stableJson(descriptor)
    )));
  }

  const secondState = JSON.parse(
    await readFile(fixture.statePath, "utf8")
  );
  assert.equal(secondState.revision, 10);
  assert.deepEqual(
    secondState.operations["op-rel-current"],
    unknownOperation
  );
  assert.deepEqual(
    secondState.relations["rel-current"],
    unknownRelation
  );
  assert.deepEqual(await readFile(firstJournalPath), committedJournalBytes);
  assert.deepEqual(await readFile(firstHistoryPath), firstHistoryBytes);
  assert.deepEqual(await readFile(firstAfterPath), sealedState);
});

test("entry rejects source scope or after-byte tampering", async t => {
  for (const mode of ["scope", "after-bytes"]) {
    const fixture = await syntheticFixture(t);
    const source = await seedCommittedRecovery(fixture);
    let previousHistoryBytes = source.historyBytes;
    if (mode === "scope") {
      const tamperedClosure = structuredClone(source.closure);
      tamperedClosure.scopeProjectionSha256 = "9".repeat(64);
      previousHistoryBytes = Buffer.from(
        JSON.stringify(tamperedClosure, null, 2),
        "utf8"
      );
      await writeFile(source.historyPath, previousHistoryBytes, {
        mode: 0o600
      });
      await writeFile(source.journalPath, JSON.stringify({
        ...source.journal,
        historyClosureSha256: sha256(previousHistoryBytes)
      }, null, 2), { mode: 0o600 });
    } else {
      await writeFile(
        source.afterPath,
        Buffer.concat([source.afterBytes, Buffer.from("\n")]),
        { mode: 0o600 }
      );
    }
    const previousHistoryPath = join(fixture.root, "history-closure.json");
    await writeFile(previousHistoryPath, previousHistoryBytes, {
      mode: 0o600
    });

    await assert.rejects(
      runStartupMaintenanceEntry({
        config: configFor(fixture, {
          previousHistoryClosureSha256: sha256(previousHistoryBytes),
          previousHistoryClosurePath: previousHistoryPath,
          succession: recoverySuccession(
            source.result,
            source.epochManifestSha256,
            "reuse-after"
          )
        }),
        createGate: () => gateFor(source.afterBytes, []).gate,
        acquireStateLock: acquireServerStateLock
      }),
      { code: "startup_maintenance_previous_history_invalid" }
    );
    assert.deepEqual(await readFile(fixture.statePath), source.afterBytes);
  }
});

test("entry rejects joint scope tampering across inherited closure and succession", async t => {
  for (const mode of [
    "input-and-succession",
    "source-closure-journal-and-succession",
    "source-journal-scope-and-succession"
  ]) {
    const fixture = await syntheticFixture(t);
    const source = await seedCommittedRecovery(fixture);
    const wrongScopeProjectionSha256 = "8".repeat(64);
    assert.notEqual(
      wrongScopeProjectionSha256,
      source.result.scopeProjectionSha256
    );

    const inputClosure = structuredClone(source.closure);
    inputClosure.scopeProjectionSha256 = wrongScopeProjectionSha256;
    let inputHistoryBytes = Buffer.from(
      JSON.stringify(inputClosure, null, 2),
      "utf8"
    );
    const succession = recoverySuccession(
      source.result,
      source.epochManifestSha256,
      "reuse-after"
    );
    succession.sourceScopeProjectionSha256 = wrongScopeProjectionSha256;

    if (mode !== "input-and-succession") {
      const sourceClosure = structuredClone(inputClosure);
      const sourceHistoryBytes = Buffer.from(
        JSON.stringify(sourceClosure, null, 2),
        "utf8"
      );
      const sourceHistoryClosureSha256 = sha256(sourceHistoryBytes);
      const sourceJournal = {
        ...source.journal,
        historyClosureSha256: sourceHistoryClosureSha256
      };
      if (mode === "source-journal-scope-and-succession") {
        sourceJournal.scopeProjectionSha256 = wrongScopeProjectionSha256;
      }
      await writeFile(source.historyPath, sourceHistoryBytes, { mode: 0o600 });
      await writeFile(
        source.journalPath,
        Buffer.from(JSON.stringify(sourceJournal, null, 2), "utf8"),
        { mode: 0o600 }
      );
      inputHistoryBytes = sourceHistoryBytes;
      succession.sourceHistoryClosureSha256 = sourceHistoryClosureSha256;
    }

    const previousHistoryPath = join(fixture.root, "history-closure.json");
    await writeFile(previousHistoryPath, inputHistoryBytes, { mode: 0o600 });
    const evidenceBefore = {
      recoveryEntries: (await readdir(fixture.recoveryDir)).sort(),
      state: await readFile(fixture.statePath),
      result: await readFile(fixture.resultPath),
      journal: await readFile(source.journalPath),
      history: await readFile(source.historyPath),
      after: await readFile(source.afterPath),
      previousHistory: await readFile(previousHistoryPath)
    };

    await assert.rejects(
      runStartupMaintenanceEntry({
        config: configFor(fixture, {
          previousHistoryClosureSha256: sha256(inputHistoryBytes),
          previousHistoryClosurePath: previousHistoryPath,
          succession
        }),
        createGate: () => gateFor(source.afterBytes, []).gate,
        acquireStateLock: acquireServerStateLock
      }),
      { code: "startup_maintenance_previous_history_invalid" }
    );

    assert.deepEqual(
      (await readdir(fixture.recoveryDir)).sort(),
      evidenceBefore.recoveryEntries
    );
    assert.deepEqual(await readFile(fixture.statePath), evidenceBefore.state);
    assert.deepEqual(await readFile(fixture.resultPath), evidenceBefore.result);
    assert.deepEqual(
      await readFile(source.journalPath),
      evidenceBefore.journal
    );
    assert.deepEqual(
      await readFile(source.historyPath),
      evidenceBefore.history
    );
    assert.deepEqual(await readFile(source.afterPath), evidenceBefore.after);
    assert.deepEqual(
      await readFile(previousHistoryPath),
      evidenceBefore.previousHistory
    );
  }
});

test("entry rejects duplicate inherited history descriptors", async t => {
  const fixture = await syntheticFixture(t);
  const source = await seedCommittedRecovery(fixture);
  const duplicatedClosure = structuredClone(source.closure);
  duplicatedClosure.descriptors.push(
    structuredClone(duplicatedClosure.descriptors[0])
  );
  const duplicatedBytes = Buffer.from(
    JSON.stringify(duplicatedClosure, null, 2),
    "utf8"
  );
  const previousHistoryPath = join(fixture.root, "history-closure.json");
  await writeFile(previousHistoryPath, duplicatedBytes, { mode: 0o600 });

  await assert.rejects(
    runStartupMaintenanceEntry({
      config: configFor(fixture, {
        previousHistoryClosureSha256: sha256(duplicatedBytes),
        previousHistoryClosurePath: previousHistoryPath,
        succession: recoverySuccession(
          source.result,
          source.epochManifestSha256,
          "reuse-after"
        )
      }),
      createGate: () => gateFor(source.afterBytes, []).gate,
      acquireStateLock: acquireServerStateLock
    }),
    { code: "startup_maintenance_previous_history_invalid" }
  );
  assert.deepEqual(await readFile(fixture.statePath), source.afterBytes);
});

test("fresh recovery rejects unknown, unaccepted, or ambiguous transaction artifacts", async t => {
  for (const mode of ["unknown", "unaccepted", "ambiguous"]) {
    const fixture = await syntheticFixture(t);
    const source = await seedCommittedRecovery(fixture);
    const foreignId = "d".repeat(64);
    await writeFile(
      join(fixture.recoveryDir, `${foreignId}.after.json`),
      source.afterBytes,
      { mode: 0o600 }
    );
    await writeFile(
      join(fixture.recoveryDir, `${foreignId}.history-closure.json`),
      source.historyBytes,
      { mode: 0o600 }
    );
    if (mode !== "unknown") {
      await writeFile(
        join(fixture.recoveryDir, `${foreignId}.json`),
        JSON.stringify({
          ...source.journal,
          transactionId: foreignId,
          historyClosureSha256: mode === "unaccepted"
            ? "8".repeat(64)
            : source.result.historyClosureSha256
        }, null, 2),
        { mode: 0o600 }
      );
    }
    const previousHistoryPath = join(fixture.root, "history-closure.json");
    await writeFile(previousHistoryPath, source.historyBytes, { mode: 0o600 });
    await assert.rejects(
      runStartupMaintenanceEntry({
        config: configFor(fixture, {
          previousHistoryClosureSha256:
            source.result.historyClosureSha256,
          previousHistoryClosurePath: previousHistoryPath
        }),
        createGate: () => gateFor(source.afterBytes, []).gate,
        acquireStateLock: acquireServerStateLock
      }),
      {
        code: mode === "ambiguous"
          ? "startup_maintenance_previous_history_invalid"
          : "runtime_recovery_orphan_transaction"
      }
    );
    assert.deepEqual(await readFile(fixture.statePath), source.afterBytes);
  }
});

test("an existing manager state lock leaves V2 bytes byte-identical", async t => {
  const fixture = await syntheticFixture(t);
  const before = await readFile(fixture.statePath);
  const owner = gateFor(before, []);
  const lockPath = `${fixture.statePath}.storage.lock`;
  const release = acquireServerStateLock({
    dataDir: fixture.root,
    statePath: fixture.statePath,
    lockPath
  });
  try {
    await assert.rejects(
      runStartupMaintenanceEntry({
        config: configFor(fixture),
        createGate: () => owner.gate,
        acquireStateLock: acquireServerStateLock,
        openManager: async () => {
          throw new Error("must not open a manager");
        },
        runTransaction: async () => {
          throw new Error("must not reach a transaction");
        }
      }),
      { code: "server_state_locked" }
    );
  } finally {
    release();
  }
  assert.deepEqual(await readFile(fixture.statePath), before);
  assert.equal(await exists(fixture.resultPath), false);
  assert.equal(await exists(fixture.recoveryDir), false);
});

test("production maintenance rejects a prior history closure without a committed source", async t => {
  const fixture = await syntheticFixture(t);
  const before = await readFile(fixture.statePath);
  const closurePath = join(fixture.root, "history-closure.json");
  const closure = {
    schemaVersion: "1",
    transactionId: "b".repeat(64),
    previousHistoryClosureSha256: "c".repeat(64),
    scopeProjectionSha256: "d".repeat(64),
    descriptors: [{
      kind: "history",
      scope: "history",
      code: "relation_file_service_history",
      operationId: "op-history",
      relationId: "rel-current",
      generation: "2",
      handleDigest: "e".repeat(64),
      requestDigest: "f".repeat(64),
      phase: "start_failed",
      action: "start",
      recordSha256: "1".repeat(64)
    }]
  };
  const bytes = Buffer.from(JSON.stringify(closure, null, 2), "utf8");
  await writeFile(closurePath, bytes, { mode: 0o600 });
  const owner = gateFor(before, []);
  await assert.rejects(
    runStartupMaintenanceEntry({
      config: configFor(fixture, {
        previousHistoryClosureSha256: sha256(bytes),
        previousHistoryClosurePath: closurePath
      }),
      createGate: () => owner.gate,
      openManager: async () => {
        throw new Error("must not open a manager");
      },
      runTransaction: async () => {
        throw new Error("must not reach a transaction");
      }
    }),
    { code: "startup_maintenance_previous_history_invalid" }
  );
  assert.deepEqual(await readFile(fixture.statePath), before);
  assert.equal(await exists(fixture.resultPath), false);
});

test("real ARM64 maintenance entry creates the exact V2 recovery transaction", {
  skip: process.platform !== "linux" || process.arch !== "arm64"
    ? "requires the accepted linux-arm64 musl N-API artifact on a Linux ARM64 host"
    : false
}, async t => {
  if (!(await exists(artifactPath))) {
    t.skip("accepted linux-arm64 native artifact is absent");
    return;
  }
  const fixture = await syntheticFixture(t);
  const state = stateWithRecoveryScope();
  const before = Buffer.from(JSON.stringify(state, null, 2), "utf8");
  await writeFile(fixture.statePath, before, { mode: 0o600 });
  const result = await runStartupMaintenanceEntry({
    config: configFor(fixture)
  });
  assert.equal(result.required, true);
  assert.equal(result.initialized, false);
  assert.equal(result.revision, 8);
  const after = await readFile(fixture.statePath);
  assert.equal(sha256(after), result.rawSha256);
  const journals = (await readdir(fixture.recoveryDir)).filter(name => (
    /^[a-f0-9]{64}\.json$/.test(name)
  ));
  assert.equal(journals.length, 1);
  const journal = JSON.parse(await readFile(
    join(fixture.recoveryDir, journals[0]),
    "utf8"
  ));
  assert.equal(journal.status, "after-verified");
  assert.equal(journal.afterRevision, 8);
  assert.equal(journal.beforeRevision, 7);
  assert.equal(journal.transactionId, result.transactionId);
  assert.equal(journal.historyClosureSha256, result.historyClosureSha256);
  const info = await lstat(join(
    fixture.recoveryDir,
    `${journal.transactionId}.history-closure.json`
  ));
  assert.equal(Number(info.mode) & 0o777, 0o600);
});

function digest(value) {
  return sha256(Buffer.from(stableJson(value), "utf8"));
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

function recoveryRuntimeIdentity(handle, port) {
  return {
    schemaVersion: "1",
    namespace: {
      bootId: "11111111-2222-4333-8444-555555555555",
      pidNamespaceId: "pid:[4026532000]"
    },
    manager: {
      pid: "100",
      starttime: "200"
    },
    process: {
      pid: "101",
      starttime: "201",
      parentPid: "100",
      parentStarttime: "200"
    },
    executable: {
      launcher: {
        dev: "1",
        ino: "2",
        size: "3",
        sha256: "a".repeat(64)
      },
      target: {
        dev: "4",
        ino: "5",
        size: "6",
        sha256: "b".repeat(64)
      }
    },
    tokenSha256: sha256(handle.token),
    listener: {
      role: "expected",
      host: "127.0.0.1",
      port
    }
  };
}

function recoveryProvisionalEvidence() {
  return {
    schemaVersion: "1",
    launcherReady: true,
    processRunning: true,
    preExecLauncherExeMatches: true,
    preExecTokenMatches: true,
    preparedTargetMatchesFd3: true,
    capabilitiesCleared: true,
    noNewPrivs: true,
    parentDeathSignal: "SIGKILL",
    parentMatches: true,
    executableMatches: true,
    tokenMatches: true,
    listenerOpen: false,
    observedAt: "2026-10-23T00:00:00.000Z"
  };
}

function currentRecoveryPair(relationId, generation) {
  const identity = {
    baselineId: `baseline-${relationId}`,
    engine: { type: "rclone-bisync", semanticsVersion: 1 },
    rootId: `root-${relationId}`,
    filters: { exclude: ["**/.syncraft-root.json"] }
  };
  const handle = { relationId, generation, token: `token-${relationId}` };
  const handleDigest = digest(handle);
  const runtimeIdentity = recoveryRuntimeIdentity(handle, 41000);
  const operationId = `op-${relationId}`;
  const requestDigest = digest({ action: "start", relationId, old: true });
  const operation = {
    action: "start",
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    createdAt: "2026-10-23T00:00:00.000Z",
    expectedHandleDigest: "",
    generation,
    handleDigest,
    operationId,
    phase: "running",
    protectionDigest: "f".repeat(64),
    provisionalEvidence: recoveryProvisionalEvidence(),
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest,
    runningEvidenceDigest: "a".repeat(64),
    runtimeIdentity,
    updatedAt: "2026-10-23T00:00:00.000Z"
  };
  const relation = {
    cleanupEvidence: null,
    cleanupRequired: false,
    commitUncertain: false,
    desired: "enabled",
    expectedHandleDigest: "",
    generation,
    handle,
    handleDigest,
    identityDigest: digest(identity),
    operationId,
    phase: "running",
    protectionDigest: "f".repeat(64),
    provisionalEvidence: recoveryProvisionalEvidence(),
    reason: "",
    recordOrigin: "v2",
    relationId,
    requestDigest,
    runningEvidenceDigest: "a".repeat(64),
    runtimeIdentity,
    updatedAt: "2026-10-23T00:00:00.000Z"
  };
  return {
    operation,
    relation
  };
}

function stateWithRecoveryScope() {
  const current = currentRecoveryPair("rel-current", "3");
  return {
    version: 2,
    kind: "relation-file-service-manager-state",
    storageContract:
      "single-manager-owner+injected-scoped-locks+durable-json-replace-v2",
    revision: 7,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    operations: { [current.operation.operationId]: current.operation },
    relations: { [current.relation.relationId]: current.relation }
  };
}
