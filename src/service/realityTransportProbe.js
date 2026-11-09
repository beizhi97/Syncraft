import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

import { buildClientSingboxConfig } from "../core/singbox.js";
import { parseVlessUri } from "../core/vless.js";
import { buildVlessUri } from "../core/serverAdmin.js";
import { createHttpError } from "../core/errors.js";

const PROBE_PATH = "/api/enrollment/v1/transport-probe";
const DEFAULT_TIMEOUT_MS = 10_000;

function channelNotReady() {
  return createHttpError(
    "enrollment_channel_not_ready",
    503,
    "The server could not verify its secure connection to the local enrollment service. Check the connection address and port, then retry. No channel code was issued."
  );
}

function abortError() {
  return Object.assign(new Error("REALITY transport probe was cancelled"), { name: "AbortError" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(channelNotReady()));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForLocalProxy(port, child, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onChildError);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(abortError());
    const onChildError = () => finish(channelNotReady());
    const tryConnect = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(channelNotReady());
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        finish();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          finish(channelNotReady());
        } else {
          timer = setTimeout(tryConnect, 100);
          timer.unref?.();
        }
      });
    };
    timer = setTimeout(() => finish(channelNotReady()), timeoutMs);
    timer.unref?.();
    child.once("error", onChildError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    tryConnect();
  });
}

function requestProbe(port, gatewayPort, challenge, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: `http://127.0.0.1:${gatewayPort}${PROBE_PATH}?challenge=${challenge}`,
      headers: { connection: "close" },
      timeout: timeoutMs
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        if (response.statusCode === 200 && body?.ok === true
          && body.service === "sfsc-enrollment-bootstrap" && body.challenge === challenge) {
          resolve();
        } else {
          reject(channelNotReady());
        }
      });
    });
    request.once("timeout", () => request.destroy(channelNotReady()));
    request.once("error", error => reject(error?.name === "AbortError" ? error : channelNotReady()));
    const onAbort = () => request.destroy(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", onAbort));
    if (signal?.aborted) onAbort();
    request.end();
  });
}

function runCheck(binaryPath, configPath, timeoutMs, spawnImpl, signal) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const failAndStop = async error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { await stopChild(child, 1_000); } catch { /* the probe remains failed; no code can be issued */ }
      reject(error);
    };
    const onAbort = () => { void failAndStop(abortError()); };
    const onError = () => { void failAndStop(channelNotReady()); };
    let timer;
    try { child = spawnImpl(binaryPath, ["check", "-c", configPath], { stdio: "ignore", windowsHide: true }); }
    catch { reject(channelNotReady()); return; }
    child.once("error", onError);
    timer = setTimeout(() => {
      void failAndStop(channelNotReady());
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    child.once("exit", code => {
      code === 0 ? finish() : finish(channelNotReady());
    });
  });
}

async function stopChild(child, timeoutMs) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let killed = false;
    const finish = error => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      error ? reject(error) : resolve();
    };
    const onError = () => {
      // A failed spawn has no running process to retain the temporary config.
      if (child.pid === undefined) finish();
      else finish(channelNotReady());
    };
    const onClose = () => finish();
    child.once("error", onError);
    child.once("close", onClose);
    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        try { child.kill("SIGKILL"); } catch { /* process can exit between state check and kill */ }
        timer.refresh();
        return;
      }
      // Never report probe success if the child did not confirm exit.
      finish(channelNotReady());
    }, timeoutMs);
    timer.unref?.();
    try {
      if (!child.kill("SIGTERM")) {
        if (child.exitCode !== null || child.signalCode !== null) finish();
      }
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) finish();
    }
  });
}

/** Proves the configured REALITY tunnel reaches this server's loopback bootstrap gateway. */
export function createRealityTransportProbe({
  binaryPath = process.env.SFSC_SINGBOX_BINARY || "/usr/local/bin/sing-box",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawnChild
} = {}) {
  if (typeof binaryPath !== "string" || !binaryPath
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    || typeof spawnImpl !== "function") throw new TypeError("REALITY probe options are invalid");

  return async function verifyRealityTransport({ tunnel, bootstrapUser, gatewayPort, signal }) {
    throwIfAborted(signal);
    if (!tunnel || tunnel.protocol !== "vless-reality-tcp"
      || !bootstrapUser || typeof bootstrapUser.uuid !== "string"
      || !Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535
      || !Number.isInteger(tunnel.listenPort) || tunnel.listenPort < 1 || tunnel.listenPort > 65535) {
      throw channelNotReady();
    }
    const workDir = await mkdtemp(join(tmpdir(), "sfsc-reality-probe-"));
    let child;
    try {
      const proxyPort = await reservePort();
      const uri = buildVlessUri(tunnel, { uuid: bootstrapUser.uuid, clientName: bootstrapUser.clientName });
      const profile = parseVlessUri(uri);
      profile.server = "127.0.0.1";
      profile.port = tunnel.listenPort;
      const config = buildClientSingboxConfig(profile, {
        localProxyHost: "127.0.0.1",
        localProxyPort: proxyPort,
        logLevel: "error"
      });
      const configPath = join(workDir, "config.json");
      await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") await chmod(configPath, 0o600);
      await runCheck(binaryPath, configPath, timeoutMs, spawnImpl, signal);
      child = spawnImpl(binaryPath, ["run", "-c", configPath], {
        stdio: "ignore",
        windowsHide: true
      });
      await waitForLocalProxy(proxyPort, child, timeoutMs, signal);
      const challenge = randomBytes(24).toString("hex");
      await requestProbe(proxyPort, gatewayPort, challenge, timeoutMs, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw channelNotReady();
    } finally {
      let childStopped = true;
      try { await stopChild(child, 1_000); } catch { childStopped = false; }
      let filesRemoved = true;
      try { await rm(workDir, { recursive: true, force: true }); } catch { filesRemoved = false; }
      if (!childStopped || !filesRemoved) throw channelNotReady();
    }
  };
}
