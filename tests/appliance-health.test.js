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

test("split-container health trusts a successful remote TCP probe instead of an inaccessible host PID", async () => {
  let probedHost = "";
  const health = await checkApplianceHealth({
    singboxHost: "host.docker.internal",
    singboxPort: 45679,
    readPid: async () => 231891,
    // A PID written by the host-network tunnel container is not visible from
    // the bridge-network server container, even while sing-box is healthy.
    isProcessAlive: () => false,
    probeTcp: async (host, port) => {
      probedHost = host;
      assert.equal(port, 45679);
      return true;
    },
    probePath: async () => true,
    probeStorage: async () => true
  });

  assert.equal(probedHost, "host.docker.internal");
  assert.equal(health.checks.singbox.ok, true);
  assert.equal(health.checks.singbox.processAlive, true);
  assert.equal(health.checks.singbox.portReady, true);
  assert.equal(health.checks.singbox.processProbe, "tcp");
});

test("directory appliance health requires the mounted writable root without probing MinIO", async () => {
  let storageProbed = false;
  const health = await checkApplianceHealth({
    storageMode: "directory",
    directoryRoot: "/srv/syncraft/shared",
    readPid: async () => 23,
    isProcessAlive: () => true,
    probeTcp: async () => true,
    probePath: async () => true,
    probeStorage: async () => { storageProbed = true; return false; }
  });

  assert.equal(health.ok, true);
  assert.equal(storageProbed, false);
  assert.deepEqual(health.checks.storage, {
    ok: true,
    dataWritable: true,
    directoryRootWritable: true,
    mode: "directory"
  });
});
