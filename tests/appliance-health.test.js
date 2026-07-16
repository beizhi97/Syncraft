import test from "node:test";
import assert from "node:assert/strict";

import { checkApplianceHealth } from "../src/core/applianceHealth.js";

test("appliance health is ready only when Node, sing-box, rclone, and storage are ready", async () => {
  const health = await checkApplianceHealth({
    dataDir: "/data/app",
    singboxControlDir: "/data/control",
    singboxPort: 45679,
    rcloneBin: "/usr/local/bin/rclone",
    storageEndpoint: "http://127.0.0.1:9000",
    readPid: async () => 23,
    isProcessAlive: () => true,
    probeTcp: async () => true,
    probePath: async () => true,
    probeStorage: async () => true
  });

  assert.equal(health.ok, true);
  assert.deepEqual(Object.keys(health.checks).sort(), ["node", "rclone", "singbox", "storage"]);
  assert.equal(health.checks.singbox.pid, 23);
  assert.equal(health.checks.storage.endpointReachable, true);
});

test("appliance health reports the failing dependency", async () => {
  const health = await checkApplianceHealth({
    readPid: async () => 23,
    isProcessAlive: () => true,
    probeTcp: async () => true,
    probePath: async () => true,
    probeStorage: async () => false
  });

  assert.equal(health.ok, false);
  assert.equal(health.checks.node.ok, true);
  assert.equal(health.checks.singbox.ok, true);
  assert.equal(health.checks.storage.ok, false);
});
