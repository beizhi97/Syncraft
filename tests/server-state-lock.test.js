import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireServerStateLock, isServerStateLockOwnerStale } from "../src/core/serverStateLock.js";

const lockModuleUrl = new URL("../src/core/serverStateLock.js", import.meta.url);

const current = {
  hostname: "appliance-a",
  instanceId: "container-a",
  pid: 1,
  processStartedAt: "2026-07-16T05:48:56.000Z",
  now: new Date("2026-07-16T05:49:00.000Z"),
  staleAfterMs: 30_000,
  isProcessAlive: () => true
};

test("legacy PID 1 lock from an earlier container process is stale", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-a",
    pid: 1,
    startedAt: "2026-07-14T11:13:59.682Z"
  }, current), true);
});

test("lock owned by the current process identity remains active", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-a",
    instanceId: "container-a",
    pid: 1,
    startedAt: "2026-07-16T05:48:56.100Z",
    processStartedAt: current.processStartedAt,
    heartbeatAt: "2026-07-16T05:48:59.000Z"
  }, current), false);
});

test("dead same-host process lock is stale", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-a",
    instanceId: "container-a",
    pid: 42,
    processStartedAt: "2026-07-16T05:48:56.000Z",
    heartbeatAt: "2026-07-16T05:48:59.000Z"
  }, {
    ...current,
    pid: 1,
    isProcessAlive: () => false
  }), true);
});

test("fresh foreign-container heartbeat prevents lock stealing", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-b",
    instanceId: "container-b",
    pid: 1,
    heartbeatAt: "2026-07-16T05:48:59.000Z"
  }, current), false);
});

test("expired foreign-container heartbeat permits recovery", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-b",
    instanceId: "container-b",
    pid: 1,
    heartbeatAt: "2026-07-16T05:47:00.000Z"
  }, current), true);
});

test("fresh same-host container instance cannot steal a reused PID lock", () => {
  assert.equal(isServerStateLockOwnerStale({
    hostname: "appliance-a",
    instanceId: "container-b",
    pid: 1,
    processStartedAt: "2026-07-16T05:48:40.000Z",
    heartbeatAt: "2026-07-16T05:48:59.000Z"
  }, current), false);
});

function makeLockDir() {
  const root = mkdtempSync(join(tmpdir(), "sfsc-lock-"));
  return { root, lockPath: join(root, "sfsc-state.lock"), ownerPath: join(root, "sfsc-state.lock", "owner.json") };
}

function writeStaleOwner(lockPath) {
  mkdirSync(lockPath, { recursive: true });
  const stale = {
    token: "stale-token",
    pid: 999_999,
    hostname: "appliance-a",
    instanceId: "container-stale",
    startedAt: "2026-07-16T05:00:00.000Z",
    processStartedAt: "2026-07-16T05:00:00.000Z",
    heartbeatAt: "2026-07-16T05:00:00.000Z",
    statePath: join(lockPath, "..", "sfsc-state.json")
  };
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify(stale, null, 2), "utf8");
  return stale;
}

test("stale lock reclaim leaves the reclaiming process as the recorded owner", () => {
  const { root, lockPath, ownerPath } = makeLockDir();
  try {
    const stale = writeStaleOwner(lockPath);
    let observed = null;
    const release = acquireServerStateLock({
      dataDir: root,
      statePath: join(root, "sfsc-state.json"),
      lockPath,
      staleAfterMs: 1,
      onStaleLock: (owner) => {
        observed = owner;
      }
    });
    assert.equal(observed?.token, stale.token);
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, stale.token);
    // No reclaim scratch directory may survive a successful acquisition.
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".reclaim.")), []);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live lock is never stolen by a second acquire in the same host", () => {
  const { root, lockPath } = makeLockDir();
  try {
    const release = acquireServerStateLock({ dataDir: root, statePath: join(root, "sfsc-state.json"), lockPath });
    assert.throws(
      () => acquireServerStateLock({ dataDir: root, statePath: join(root, "sfsc-state.json"), lockPath, instanceId: "other" }),
      (error) => error?.code === "server_state_locked"
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent stale lock reclaim yields exactly one owner", async () => {
  const { root, lockPath } = makeLockDir();
  try {
    writeStaleOwner(lockPath);
    // Both children judge the same owner stale at the same moment. rmSync-based
    // reclaim let both of them "win" and write state concurrently; the rename
    // based reclaim must admit exactly one. The children must run in parallel —
    // a sequential harness lets each acquire legitimately after the other exits.
    // staleAfterMs must stay realistic: the seeded owner's heartbeat is days old
    // so it is stale under any threshold, but a near-zero threshold would also
    // make the *winner's* fresh lock instantly stale to the loser, which is a
    // legitimate takeover rather than the race this test is about.
    const startAt = Date.now() + 900;
    const code = `
      const startAt = ${startAt};
      const { acquireServerStateLock } = await import(${JSON.stringify(lockModuleUrl.href)});
      while (Date.now() < startAt) {}
      try {
        const release = acquireServerStateLock({
          dataDir: ${JSON.stringify(root)},
          statePath: ${JSON.stringify(join(root, "sfsc-state.json"))},
          lockPath: ${JSON.stringify(lockPath)},
          staleAfterMs: 30000,
          heartbeatMs: 100000
        });
        process.stdout.write("acquired");
        // Hold the lock so an overlapping acquire cannot succeed by waiting.
        await new Promise((resolve) => setTimeout(resolve, 400));
        release();
      } catch (error) {
        process.stdout.write("rejected:" + (error && error.code));
      }`;
    const run = (instanceId) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, SFSC_INSTANCE_ID: instanceId }
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(out.trim()));
    });
    const results = await Promise.all([run("container-x"), run("container-y")]);
    const acquired = results.filter((line) => line === "acquired");
    assert.equal(acquired.length, 1, `expected exactly one acquire, got: ${results.join(" | ")}`);
    for (const line of results.filter((entry) => entry !== "acquired")) {
      assert.equal(line, "rejected:server_state_locked", `unexpected rejection: ${line}`);
    }
    // The reclaim must not leave the moved-aside directory behind: an orphan
    // sfsc-state.lock.reclaim.* would accumulate on every restart after a crash.
    const orphans = readdirSync(root).filter((entry) => entry.includes(".reclaim."));
    assert.deepEqual(orphans, [], `reclaim left orphan directories: ${orphans.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat surfaces lost ownership instead of continuing to write state", async () => {
  const { root, lockPath, ownerPath } = makeLockDir();
  try {
    const lost = [];
    const release = acquireServerStateLock({
      dataDir: root,
      statePath: join(root, "sfsc-state.json"),
      lockPath,
      heartbeatMs: 20,
      onLockLost: (error) => lost.push(error)
    });
    // Simulate another instance reclaiming the lock and writing its own owner.
    writeFileSync(ownerPath, JSON.stringify({ token: "someone-else", pid: 1, hostname: "other" }, null, 2), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(lost.length >= 1, true, "expected onLockLost to fire");
    assert.equal(lost[0].code, "server_state_locked");
    // The heartbeat must not have rewritten our owner over the new holder's.
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).token, "someone-else");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
