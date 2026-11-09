import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeConnectionRepairJournal,
  probeLocalDirectory,
  probeSftpDirectory,
  upsertConnectionRepairOperation
} from "../client/src/connectionRepair.js";

test("remote repair preserves probe content replaced after verification", async () => {
  let remote = "";
  const deleted = [];
  const foreign = "changed by another writer; this is no longer the probe";
  const probeId = "00000000-0000-4000-8000-000000000001";
  const contents = "syncraft-connection-probe-v1\n" + probeId + "\n";
  const runner = async (_binary, args) => {
    if (args[0] === "lsjson") return { ok: true, stdout: "[]" };
    if (args[0] === "copyto") { remote = contents; return { ok: true }; }
    if (args[0] === "cat") return { ok: true, stdout: remote };
    if (args[0] === "deletefile") { deleted.push(remote); remote = ""; return { ok: true }; }
    throw new Error("Unexpected command " + args[0]);
  };
  await assert.rejects(probeSftpDirectory({
    rcloneBin: "fake-runner",
    runtimeRoot: tmpdir(),
    remoteRoot: "isolated:/",
    runBuffered: runner,
    probeId,
    writeLocalProbe: async () => {},
    removeLocalProbe: async () => {},
    onProgress: async (event) => {
      if (event.stage === "probe_verified") remote = foreign;
    }
  }), (error) => error.code === "connection_repair_probe_conflict");
  assert.deepEqual(deleted, []);
  assert.equal(remote, foreign);
});

test("remote repair reports runtime probe cleanup failure", async () => {
  const probeId = "00000000-0000-4000-8000-000000000002";
  const contents = "syncraft-connection-probe-v1\n" + probeId + "\n";
  let remote = "";
  const runner = async (_binary, args) => {
    if (args[0] === "lsjson") return { ok: true, stdout: "[]" };
    if (args[0] === "copyto") { remote = contents; return { ok: true }; }
    if (args[0] === "cat") return { ok: true, stdout: remote };
    if (args[0] === "deletefile") { remote = ""; return { ok: true }; }
    throw new Error("Unexpected command " + args[0]);
  };
  await assert.rejects(probeSftpDirectory({
    rcloneBin: "fake-runner",
    runtimeRoot: tmpdir(),
    remoteRoot: "isolated:/",
    runBuffered: runner,
    probeId,
    writeLocalProbe: async () => {},
    removeLocalProbe: async () => { throw Object.assign(new Error("locked file"), { code: "EPERM" }); }
  }), (error) => error.code === "connection_repair_cleanup_failed");
});

test("local repair reuses and removes only an exact operation-owned probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-repair-local-"));
  const probeId = "00000000-0000-4000-8000-000000000003";
  const path = join(root, ".syncraft-connection-probe-" + probeId + ".tmp");
  const contents = "syncraft-local-connection-probe-v1\n" + probeId + "\n";
  try {
    await writeFile(path, contents, { flag: "wx" });
    assert.equal(await probeLocalDirectory({ localRoot: root, probeId }), "passed");
    await assert.rejects(readFile(path), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local repair leaves a probe path with unknown contents untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "sfsc-repair-local-"));
  const probeId = "00000000-0000-4000-8000-000000000004";
  const path = join(root, ".syncraft-connection-probe-" + probeId + ".tmp");
  try {
    await writeFile(path, "unknown owner");
    await assert.rejects(probeLocalDirectory({ localRoot: root, probeId }),
      (error) => error.code === "connection_repair_probe_conflict");
    assert.equal(await readFile(path, "utf8"), "unknown owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair journal retains terminal operations while tracking one active operation", () => {
  const first = { operationId: "first", status: "succeeded", requestHash: "a" };
  const secondRunning = { operationId: "second", status: "running", requestHash: "b" };
  const secondDone = { ...secondRunning, status: "failed" };
  let journal = normalizeConnectionRepairJournal(null);
  journal = upsertConnectionRepairOperation(journal, first);
  journal = upsertConnectionRepairOperation(journal, secondRunning);
  assert.equal(journal.activeOperationId, "second");
  assert.equal(journal.operations.first, first);
  journal = upsertConnectionRepairOperation(journal, secondDone);
  assert.equal(journal.activeOperationId, null);
  assert.equal(journal.operations.first, first);
  assert.equal(journal.operations.second, secondDone);
  assert.throws(() => normalizeConnectionRepairJournal({ version: 1, operations: [] }),
    (error) => error.code === "local_state_corrupt");
});
