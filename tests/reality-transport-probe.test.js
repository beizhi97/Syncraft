import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile, stat } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { autoFillTunnelConfig, createDefaultAdminState } from "../src/core/serverAdmin.js";
import { createRealityTransportProbe } from "../src/service/realityTransportProbe.js";

const bootstrapUser = {
  clientName: "sfsc-enrollment-bootstrap",
  uuid: "10000000-0000-4000-8000-000000000001"
};

function realityTunnel() {
  const state = createDefaultAdminState();
  autoFillTunnelConfig(state, { protocol: "vless-reality-tcp" });
  return {
    id: "vless-main",
    protocol: "vless-reality-tcp",
    listenHost: "0.0.0.0",
    listenPort: 45678,
    publicHost: "sync.example.test",
    publicPort: 45678,
    security: "reality",
    transport: "tcp",
    remark: "sfsc-home",
    reality: state.tunnel.reality
  };
}

function child({ pid = 4242, onKill } = {}) {
  const emitter = new EventEmitter();
  emitter.pid = pid;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = signal => {
    if (emitter.exitCode !== null || emitter.signalCode !== null) return false;
    if (onKill) onKill(signal, emitter);
    else {
      emitter.signalCode = signal;
      queueMicrotask(() => {
        emitter.emit("exit", null, signal);
        emitter.emit("close", null, signal);
      });
    }
    return true;
  };
  return emitter;
}

function fakeSingbox({ response = "expected", checkMode = "ok", observeConfig, exitAfterResponse = false } = {}) {
  const spawned = [];
  const spawnImpl = (_binary, args) => {
    spawned.push(args);
    const configPath = args.at(-1);
    if (args[0] === "check") {
      const proc = child({
        onKill: (_signal, self) => {
          self.signalCode = "SIGKILL";
          queueMicrotask(() => {
            self.emit("exit", null, "SIGKILL");
            self.emit("close", null, "SIGKILL");
          });
        }
      });
      if (checkMode === "spawn-error") {
        proc.pid = undefined;
        queueMicrotask(() => proc.emit("error", new Error("missing test binary")));
      } else if (checkMode === "ok") {
        void readFile(configPath, "utf8").then(async text => {
          await observeConfig?.(JSON.parse(text), configPath);
          proc.exitCode = 0;
          proc.emit("exit", 0, null);
          proc.emit("close", 0, null);
        });
      }
      return proc;
    }
    const proxy = http.createServer((request, responseStream) => {
      let target;
      try { target = new URL(request.url); } catch { target = null; }
      const body = {
        ok: true,
        service: response === "expected" ? "sfsc-enrollment-bootstrap" : "unrelated-service",
        challenge: response === "wrong-challenge" ? "0".repeat(48) : target?.searchParams.get("challenge")
      };
      responseStream.writeHead(200, { "content-type": "application/json" });
      responseStream.end(JSON.stringify(body));
      if (exitAfterResponse) responseStream.once("finish", () => setImmediate(() => {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
        proxy.close();
      }));
    });
    const proc = child({
      onKill: (signal, self) => proxy.close(() => {
        self.signalCode = signal;
        self.emit("exit", null, signal);
        self.emit("close", null, signal);
      })
    });
    void readFile(configPath, "utf8").then(text => {
      const config = JSON.parse(text);
      proxy.listen(config.inbounds[0].listen_port, "127.0.0.1");
    });
    return proc;
  };
  return { spawnImpl, spawned };
}

test("first-use REALITY defaults to verified SNI while explicit SNI and existing keys remain intact", () => {
  const fresh = createDefaultAdminState();
  assert.equal(fresh.tunnel.reality.serverName, "www.apple.com");
  autoFillTunnelConfig(fresh, { protocol: "vless-reality-tcp" });
  assert.equal(fresh.tunnel.reality.serverName, "www.apple.com");
  const publicKey = fresh.tunnel.reality.publicKey;
  const privateKey = fresh.tunnel.reality.privateKey;
  const shortId = fresh.tunnel.reality.shortId;

  autoFillTunnelConfig(fresh, { protocol: "vless-reality-tcp", serverName: "custom.example.test" });
  assert.equal(fresh.tunnel.reality.serverName, "custom.example.test");
  assert.equal(fresh.tunnel.reality.publicKey, publicKey);
  assert.equal(fresh.tunnel.reality.privateKey, privateKey);
  assert.equal(fresh.tunnel.reality.shortId, shortId);

  const legacyFresh = createDefaultAdminState();
  legacyFresh.tunnel.reality.serverName = "www.microsoft.com";
  autoFillTunnelConfig(legacyFresh, { protocol: "vless-reality-tcp" });
  assert.equal(legacyFresh.tunnel.reality.serverName, "www.apple.com");
  const explicitLegacyTarget = createDefaultAdminState();
  autoFillTunnelConfig(explicitLegacyTarget, {
    protocol: "vless-reality-tcp",
    serverName: "www.microsoft.com"
  });
  assert.equal(explicitLegacyTarget.tunnel.reality.serverName, "www.microsoft.com");
});

test("REALITY probe verifies the challenge-bearing gateway response, uses private config, and cleans up after child exit", async () => {
  const tunnel = realityTunnel();
  const observed = {};
  const fake = fakeSingbox({ exitAfterResponse: true, observeConfig: async (config, path) => {
    observed.config = config;
    observed.path = path;
    observed.mode = (await stat(path)).mode;
  } });
  const probe = createRealityTransportProbe({ binaryPath: "test-sing-box", spawnImpl: fake.spawnImpl });
  await probe({ tunnel, bootstrapUser, gatewayPort: 18082 });
  assert.deepEqual(fake.spawned.map(args => args[0]), ["check", "run"]);
  if (process.platform !== "win32") assert.equal(observed.mode & 0o777, 0o600);
  assert.equal(observed.config.outbounds[0].server, "127.0.0.1");
  assert.equal(observed.config.outbounds[0].server_port, 45678);
  assert.equal(observed.config.outbounds[0].type, "vless");
  assert.equal(observed.config.outbounds[0].uuid, bootstrapUser.uuid);
  assert.equal(observed.config.outbounds[0].tls.reality.enabled, true);
  assert.equal(observed.config.outbounds[0].tls.reality.public_key, tunnel.reality.publicKey);
  assert.equal(observed.config.outbounds[0].tls.reality.short_id, tunnel.reality.shortId);
  assert.equal(observed.config.outbounds[0].tls.server_name, "www.apple.com");
  await assert.rejects(access(observed.path));
});

test("REALITY probe rejects a response from the wrong service or with the wrong challenge", async () => {
  for (const response of ["wrong-service", "wrong-challenge"]) {
    const fake = fakeSingbox({ response });
    const probe = createRealityTransportProbe({ binaryPath: "test-sing-box", spawnImpl: fake.spawnImpl });
    await assert.rejects(probe({ tunnel: realityTunnel(), bootstrapUser, gatewayPort: 18082 }), error => {
      assert.equal(error.code, "enrollment_channel_not_ready");
      return true;
    });
  }
});

test("REALITY probe handles child spawn errors and timeout by stopping the child and removing the temporary config", async () => {
  const spawned = [];
  const errorSpawn = (_binary, args) => {
    spawned.push(args.at(-1));
    const proc = child({ pid: undefined });
    queueMicrotask(() => proc.emit("error", new Error("spawn failed")));
    return proc;
  };
  const failed = createRealityTransportProbe({ binaryPath: "missing-sing-box", spawnImpl: errorSpawn, timeoutMs: 200 });
  await assert.rejects(failed({ tunnel: realityTunnel(), bootstrapUser, gatewayPort: 18082 }));
  await assert.rejects(access(spawned[0]));

  let callCount = 0;
  const runSpawnError = (_binary, args) => {
    callCount += 1;
    spawned.push(args.at(-1));
    const proc = child({ pid: args[0] === "run" ? undefined : 4242 });
    if (args[0] === "check") queueMicrotask(() => {
      proc.exitCode = 0;
      proc.emit("exit", 0, null);
      proc.emit("close", 0, null);
    });
    else queueMicrotask(() => proc.emit("error", new Error("run spawn failed")));
    return proc;
  };
  const runFailed = createRealityTransportProbe({ binaryPath: "run-spawn-error", spawnImpl: runSpawnError });
  await assert.rejects(runFailed({ tunnel: realityTunnel(), bootstrapUser, gatewayPort: 18082 }));
  assert.equal(callCount, 2);
  await assert.rejects(access(spawned[1]));

  let killed = false;
  const timeoutSpawn = (_binary, args) => {
    if (args[0] === "run") throw new Error("check must time out before run");
    const proc = child({ onKill: (signal, self) => {
      killed = true;
      self.signalCode = signal;
      queueMicrotask(() => {
        self.emit("exit", null, signal);
        self.emit("close", null, signal);
      });
    } });
    spawned.push(args.at(-1));
    return proc;
  };
  const timedOut = createRealityTransportProbe({ binaryPath: "stuck-sing-box", spawnImpl: timeoutSpawn, timeoutMs: 100 });
  await assert.rejects(timedOut({ tunnel: realityTunnel(), bootstrapUser, gatewayPort: 18082 }));
  assert.equal(killed, true);
  await assert.rejects(access(spawned[3]));
});

test("REALITY probe cancellation stops the process and removes its temporary config", async () => {
  const controller = new AbortController();
  let configPath;
  let killed = false;
  const spawnImpl = (_binary, args) => {
    configPath = args.at(-1);
    const proc = child({ onKill: (signal, self) => {
      killed = true;
      self.signalCode = signal;
      queueMicrotask(() => {
        self.emit("exit", null, signal);
        self.emit("close", null, signal);
      });
    } });
    setTimeout(() => controller.abort(), 15);
    return proc;
  };
  const probe = createRealityTransportProbe({ binaryPath: "test-sing-box", spawnImpl, timeoutMs: 500 });
  await assert.rejects(probe({ tunnel: realityTunnel(), bootstrapUser, gatewayPort: 18082, signal: controller.signal }));
  assert.equal(killed, true);
  await assert.rejects(access(configPath));
});
