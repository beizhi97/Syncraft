import test from "node:test";
import assert from "node:assert/strict";

import { isServerStateLockOwnerStale } from "../src/core/serverStateLock.js";

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
