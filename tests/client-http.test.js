import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import {
  assertClientBinariesCheckContract,
  assertClientHealthContract,
  assertClientJobsReadContract,
  assertClientJobSaveResponseContract,
  assertClientJobSummaryContract,
  assertClientLogsContract,
  assertClientProfileImportResponseContract,
  assertClientProfileReadContract,
  assertClientShutdownResponseContract,
  assertClientStatusContract,
  assertClientSingboxProcessResponseContract,
  assertClientSyncHistoryContract,
  assertClientSyncRunResponseContract,
  assertDiagnosticExportContract,
  assertHeartbeatContract,
  assertHttpErrorResponseContract,
  assertSyncPreviewContract
} from "./helpers/contracts.js";
import { buildRuntimeDiagnostics, compareRuntimeDiagnostics } from "../src/core/diagnostics.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const clientEntry = join(projectRoot, "client", "src", "clientServer.js");
const serverEntry = join(projectRoot, "src", "server.js");
const clientSmokeEntry = join(projectRoot, "scripts", "smoke-client.mjs");
process.env.SFSC_TEST_ALLOW_UNSAFE_PATHS = "1";
const tunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&security=none&type=tcp#home-sync";
const overrideTunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@override.example.invalid:45679?encryption=none&security=none&type=tcp#override";
const jsonHeaders = { "content-type": "application/json", connection: "close" };

function maliciousProfileDerivedJobFields() {
  return {
    clientName: "evil-pc",
    remoteName: "evil-minio",
    bucketName: "evil-bucket",
    bucket: "evil-bucket",
    remotePrefix: "shared/evil-prefix",
    s3Endpoint: "http://evil-minio.invalid:9000",
    endpoint: "http://evil-endpoint.invalid:9000",
    accessKeyId: "evil-access-key",
    secretAccessKey: "evil-secret-value",
    s3SecretAccessKey: "evil-s3-secret-value",
    storageBackend: "local",
    uri: overrideTunnelUri,
    vlessUri: overrideTunnelUri
  };
}

test("client local HTTP API ignores HOST and advertises loopback", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-host-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout.on("data", (chunk) => {
    childStdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString("utf8");
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);
  await waitForOutput(
    () => childStdout,
    new RegExp(`Syncraft Client: http://127\\.0\\.0\\.1:${port}/`),
    child,
    childStderr
  );
  assert.doesNotMatch(childStdout, /http:\/\/0\.0\.0\.0:/);
});

test("client local write APIs reject cross-site and non-JSON browser writes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-local-write-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const crossSiteSave = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      origin: "https://attacker.example.invalid",
      "sec-fetch-site": "cross-site"
    },
    body: JSON.stringify({ job: { name: "blocked-cross-site" } })
  });
  assert.equal(crossSiteSave.status, 403);
  assertHttpErrorResponseContract(await crossSiteSave.json(), "crossSiteSave", {
    errorCode: "local_write_forbidden"
  });

  for (const [label, origin] of [
    ["remoteOrigin", "http://attacker.example.invalid"],
    ["wrongPortOrigin", `http://127.0.0.1:${port + 1}`],
    ["httpsOrigin", `https://127.0.0.1:${port}`],
    ["nullOrigin", "null"]
  ]) {
    const response = await fetch(`${baseUrl}/api/binaries/check`, {
      method: "POST",
      headers: { ...jsonHeaders, origin },
      body: "{}"
    });
    assert.equal(response.status, 403, label);
    assertHttpErrorResponseContract(await response.json(), label, {
      errorCode: "local_write_forbidden"
    });
  }

  const crossSiteNonJson = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "http://attacker.example.invalid",
      "sec-fetch-site": "cross-site"
    },
    body: "blocked"
  });
  assert.equal(crossSiteNonJson.status, 403);
  assertHttpErrorResponseContract(await crossSiteNonJson.json(), "crossSiteNonJson", {
    errorCode: "local_write_forbidden"
  });

  const sameOrigin = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: { ...jsonHeaders, origin: baseUrl },
    body: "{}"
  });
  assert.equal(sameOrigin.status, 200);

  const nonJsonRun = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: { "content-type": "text/plain", connection: "close" },
    body: "job=blocked"
  });
  assert.equal(nonJsonRun.status, 415);
  assertHttpErrorResponseContract(await nonJsonRun.json(), "nonJsonRun", {
    errorCode: "unsupported_media_type"
  });

  const nonStandardJson = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: { "content-type": "text/json", connection: "close" },
    body: "{}"
  });
  assert.equal(nonStandardJson.status, 415);
  assertHttpErrorResponseContract(await nonStandardJson.json(), "nonStandardJson", {
    errorCode: "unsupported_media_type"
  });

  const jsonWithCharset = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", connection: "close" },
    body: "{}"
  });
  assert.equal(jsonWithCharset.status, 200);
});

test("client local API rejects non-loopback Host headers on reads and writes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-host-guard-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  // A rebound DNS name resolving to 127.0.0.1 reaches the listener but carries
  // the attacker's hostname in Host, so every method must be refused.
  for (const [label, hostHeader] of [
    ["rebindName", "attacker.example.invalid"],
    ["rebindNameWithPort", `attacker.example.invalid:${port}`],
    ["loopbackWrongPort", `127.0.0.1:${port + 1}`],
    ["malformedHost", "]not-a-host["]
  ]) {
    const read = await rawClientRequest(port, "GET", "/api/health", hostHeader);
    assert.equal(read.status, 403, `${label} read`);
    assertHttpErrorResponseContract(JSON.parse(read.body), `${label}Read`, {
      errorCode: "local_host_forbidden"
    });

    const write = await rawClientRequest(port, "POST", "/api/binaries/check", hostHeader, {
      "content-type": "application/json"
    }, "{}");
    assert.equal(write.status, 403, `${label} write`);
    assertHttpErrorResponseContract(JSON.parse(write.body), `${label}Write`, {
      errorCode: "local_host_forbidden"
    });

    const staticAsset = await rawClientRequest(port, "GET", "/index.html", hostHeader);
    assert.equal(staticAsset.status, 403, `${label} static`);
  }

  for (const [label, hostHeader] of [
    ["loopbackIp", `127.0.0.1:${port}`],
    ["localhostName", `localhost:${port}`],
    ["ipv6Loopback", `[::1]:${port}`]
  ]) {
    const allowed = await rawClientRequest(port, "GET", "/api/health", hostHeader);
    assert.equal(allowed.status, 200, `${label} allowed`);
  }
});

test("client shuts down managed processes through its platform-supported shutdown trigger", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-signal-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  t.after(async () => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);
  if (process.platform === "win32") {
    // Node's SIGTERM emulation on Windows is not a graceful-process signal:
    // the OS may terminate the parent before its JS handler begins awaiting
    // managed child exits. Exercise the supported loopback shutdown endpoint
    // there; POSIX still verifies the real signal-handler path below.
    const shutdown = await fetch(`${baseUrl}/api/client/shutdown`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}"
    });
    assert.equal(shutdown.status, 200);
    assertClientShutdownResponseContract(await shutdown.json(), "windowsClientShutdown");
  } else {
    child.kill("SIGTERM");
  }

  const [exitCode] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`client shutdown timed out; stdout=${stdout}`)), 8000))
  ]);
  assert.equal(exitCode, 0);
  if (process.platform !== "win32") {
    assert.match(stdout, /stopping on SIGTERM/);
  }
});

test("client runtime refuses occupied port unless health belongs to SFSC client", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-port-"));
  const port = await getFreePort();
  const fakeServer = createHttpServer((req, res) => {
    if (req.url === "/api/health") {
      jsonResponse(res, {
        ok: true,
        mode: "other-local-service",
        diagnostics: {
          role: "server"
        }
      });
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  fakeServer.listen(port, "127.0.0.1");
  await once(fakeServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });
  let childStdout = "";
  let childStderr = "";
  child.stdout.on("data", (chunk) => {
    childStdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString("utf8");
  });

  t.after(async () => {
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    fakeServer.close();
    await Promise.race([
      once(fakeServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await removeTempRoot(tempRoot);
  });

  const [exitCode] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`client did not exit; stdout=${childStdout} stderr=${childStderr}`)), 5000))
  ]);
  assert.equal(exitCode, 1);
  assert.match(childStderr, /client_port_in_use|Client port/);
  assert.doesNotMatch(childStdout, /already running/);
});

test("client local HTTP API returns structured errors", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-http-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString("utf8");
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assertClientHealthContract(healthPayload);
  assert.equal(healthPayload.ok, true);
  assert.equal(healthPayload.mode, "client-exe-runtime");
  assert.equal(healthPayload.version, healthPayload.clientVersion);
  assert.equal(healthPayload.diagnostics.role, "client");
  assert.equal(healthPayload.diagnostics.version, healthPayload.clientVersion);
  assert.equal(healthPayload.diagnostics.protocols.clientStatus, 1);
  assert.equal(healthPayload.diagnostics.protocols.heartbeat, 1);
  assert.equal(healthPayload.paths, undefined);
  assert.equal(healthPayload.profileSummary, undefined);
  assert.equal(healthPayload.jobs, undefined);
  assert.equal(healthPayload.safeguards, undefined);
  assert.equal(healthPayload.heartbeat, undefined);

  const statusForHealthContract = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusForHealthContract.status, 200);
  const statusForHealthContractPayload = await statusForHealthContract.json();
  assertClientStatusContract(statusForHealthContractPayload);
  assert.deepEqual(
    healthPayload.diagnostics.protocols,
    statusForHealthContractPayload.diagnostics.protocols
  );
  assert.equal(statusForHealthContractPayload.profileImported, false);
  assert.equal(statusForHealthContractPayload.profileSummary, null);
  assert.equal(statusForHealthContractPayload.safeguards.tun, false);
  assert.equal(statusForHealthContractPayload.safeguards.systemProxy, false);
  assert.equal(statusForHealthContractPayload.safeguards.routeMutation, false);
  assert.equal(statusForHealthContractPayload.safeguards.dnsMutation, false);
  assert.match(statusForHealthContractPayload.safeguards.rcloneConfigScope, /rclone\.conf$/);
  assert.equal(typeof statusForHealthContractPayload.safeguards.localState.ok, "boolean");
  assert.deepEqual(
    statusForHealthContractPayload.safeguards.localState.files.map((file) => file.name).sort(),
    ["claimRecovery", "jobs", "lastSuccessfulHeartbeat", "profile", "secrets", "syncHistory"]
  );
  assert.equal(typeof statusForHealthContractPayload.safeguards.secretVault.ok, "boolean");
  assert.equal(typeof statusForHealthContractPayload.safeguards.secretVault.protected, "boolean");
  assert.equal(
    statusForHealthContractPayload.safeguards.secretVault.protection.protected,
    statusForHealthContractPayload.safeguards.secretVault.protected
  );
  assert.equal(statusForHealthContractPayload.processes.singbox.name, "sing-box");
  assert.equal(statusForHealthContractPayload.processes.singbox.running, false);
  assert.equal(statusForHealthContractPayload.processes.singbox.pid, null);
  assert.equal(statusForHealthContractPayload.processes.sync.name, "rclone-sync");
  assert.equal(statusForHealthContractPayload.processes.sync.running, false);
  assert.equal(statusForHealthContractPayload.processes.sync.pid, null);
  assert.equal(statusForHealthContractPayload.processes.sync.metrics.syncState, "idle");
  assert.equal(statusForHealthContractPayload.heartbeat, null);
  assert.equal(typeof statusForHealthContractPayload.scheduler.enabled, "boolean");
  assert.equal(Number.isInteger(statusForHealthContractPayload.scheduler.intervalMs), true);
  assert.equal(statusForHealthContractPayload.scheduler.intervalMs >= 0, true);
  assert.ok(statusForHealthContractPayload.scheduler.updatedAt === null || typeof statusForHealthContractPayload.scheduler.updatedAt === "string");
  assert.ok(statusForHealthContractPayload.scheduler.nextRun === null || typeof statusForHealthContractPayload.scheduler.nextRun === "string");
  assert.ok(statusForHealthContractPayload.scheduler.lastTriggeredAt === null || typeof statusForHealthContractPayload.scheduler.lastTriggeredAt === "string");
  assert.equal(statusForHealthContractPayload.scheduler.lastError, "");
  assert.equal(Array.isArray(statusForHealthContractPayload.scheduler.jobs), true);

  const smokeReportPath = join(tempRoot, "reports", "client-smoke.json");
  const smoke = await runClientSmoke(baseUrl, { jsonReportPath: smokeReportPath });
  assert.equal(smoke.code, 0);
  assert.match(smoke.stdout, /SFSC client smoke passed/);
  assert.match(smoke.stdout, /SFSC client smoke JSON report written/);
  assert.match(smoke.stdout, /protocols=aligned/);
  assert.match(smoke.stdout, /client-jobs/);
  assert.match(smoke.stdout, /client-sync-history/);
  assert.match(smoke.stdout, /client-logs/);
  assert.match(smoke.stdout, /diagnostic-export/);
  const smokeReport = JSON.parse(await readFile(smokeReportPath, "utf8"));
  assert.equal(smokeReport.schemaVersion, 1);
  assert.equal(smokeReport.type, "client-smoke-report");
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.context.baseUrl, baseUrl);
  assert.equal(smokeReport.summary.failed, 0);
  assert.equal(smokeReport.failure, null);
  assert.deepEqual(smokeReport.checks.map((check) => check.name), ["health", "client-status", "client-profile", "client-jobs", "client-sync-history", "client-logs", "diagnostic-export"]);

  const emptyProfile = await fetch(`${baseUrl}/api/profile`);
  assert.equal(emptyProfile.status, 200);
  const emptyProfilePayload = await emptyProfile.json();
  assert.deepEqual(emptyProfilePayload, { profile: null });
  assertClientProfileReadContract(emptyProfilePayload, "emptyProfile");

  const emptyJobs = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(emptyJobs.status, 200);
  const emptyJobsPayload = await emptyJobs.json();
  assert.deepEqual(emptyJobsPayload, { jobs: [] });
  assertClientJobsReadContract(emptyJobsPayload, "emptyJobs");

  const emptyHistory = await fetch(`${baseUrl}/api/sync/history`);
  assert.equal(emptyHistory.status, 200);
  const emptyHistoryPayload = await emptyHistory.json();
  assertClientSyncHistoryContract(emptyHistoryPayload, "emptyHistory");
  assert.deepEqual(emptyHistoryPayload, { history: [] });

  const response = await fetch(`${baseUrl}/missing-route`);
  assert.equal(response.status, 404);
  const payload = await response.json();
  assertHttpErrorResponseContract(payload, "clientMissingRoute", {
    errorCode: "not_found",
    message: "not_found"
  });

  const escapedStatic = await fetch(`${baseUrl}/%2e%2e%5cpackage.json`);
  assert.equal(escapedStatic.status, 400);
  assertHttpErrorResponseContract(await escapedStatic.json(), "clientEscapedStatic", {
    errorCode: "invalid_path",
    message: "invalid_path"
  });

  const emptyImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(emptyImport.status, 400);
  const emptyImportPayload = await emptyImport.json();
  assertHttpErrorResponseContract(emptyImportPayload, "emptyImport", {
    errorCode: "import_code_required"
  });
  assert.match(emptyImportPayload.message, /Import code is required/);

  const invalidImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ code: "SFSC1-not-json" })
  });
  assert.equal(invalidImport.status, 400);
  const invalidImportPayload = await invalidImport.json();
  assertHttpErrorResponseContract(invalidImportPayload, "invalidImport", {
    errorCode: "import_code_invalid"
  });

  const missingTunnelImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "broken-profile"
      })}`
    })
  });
  assert.equal(missingTunnelImport.status, 400);
  const missingTunnelPayload = await missingTunnelImport.json();
  assertHttpErrorResponseContract(missingTunnelPayload, "missingTunnelImport", {
    errorCode: "profile_tunnel_required"
  });

  const serverIssuedMissingHeartbeatImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "server-issued-missing-heartbeat",
        source: {
          type: "profile",
          server: "https://pass.971223.xyz:2025"
        },
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "server-issued-missing-heartbeat",
          secretAccessKey: "secret-for-test",
          prefix: "devices/server-issued-missing-heartbeat"
        }
      })}`
    })
  });
  assert.equal(serverIssuedMissingHeartbeatImport.status, 400);
  assertHttpErrorResponseContract(await serverIssuedMissingHeartbeatImport.json(), "serverIssuedMissingHeartbeatImport", {
    errorCode: "profile_heartbeat_required"
  });

  const serverIssuedMissingStorageImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "server-issued-missing-storage",
        source: {
          type: "profile",
          server: "https://pass.971223.xyz:2025"
        },
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        heartbeat: {
          scheme: "sfsc-hmac-sha256-v1",
          secret: "heartbeat-secret"
        }
      })}`
    })
  });
  assert.equal(serverIssuedMissingStorageImport.status, 400);
  assertHttpErrorResponseContract(await serverIssuedMissingStorageImport.json(), "serverIssuedMissingStorageImport", {
    errorCode: "profile_storage_required"
  });

  const invalidVlessImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ uri: "https://example.com/not-vless" })
  });
  assert.equal(invalidVlessImport.status, 400);
  const invalidVlessPayload = await invalidVlessImport.json();
  assertHttpErrorResponseContract(invalidVlessPayload, "invalidVlessImport", {
    errorCode: "invalid_vless_uri"
  });

  const startWithoutSingbox = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(startWithoutSingbox.status, 409);
  const startWithoutSingboxPayload = await startWithoutSingbox.json();
  assertHttpErrorResponseContract(startWithoutSingboxPayload, "startWithoutSingbox", {
    errorCode: "profile_not_imported"
  });
  assert.match(startWithoutSingboxPayload.message, /Import a server SyncKey/);

  const missingBinaryCheck = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(missingBinaryCheck.status, 200);
  const missingBinaryCheckPayload = await missingBinaryCheck.json();
  assertClientBinariesCheckContract(missingBinaryCheckPayload, "missingBinaryCheck");
  assert.equal(missingBinaryCheckPayload.ok, false);
  assertBinaryCheckContract(
    missingBinaryCheckPayload.singbox,
    "missing_singbox_binary",
    false,
    /Missing bundled sing-box/
  );
  assertBinaryCheckContract(
    missingBinaryCheckPayload.rclone,
    "missing_rclone_binary",
    false,
    /Missing bundled rclone/
  );

  await mkdir(join(tempRoot, "resources", "bin", "win32"), { recursive: true });
  await writeFile(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), "placeholder");
  await writeFile(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), "placeholder");

  const placeholderBinaryCheck = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(placeholderBinaryCheck.status, 200);
  const placeholderBinaryCheckPayload = await placeholderBinaryCheck.json();
  assertClientBinariesCheckContract(placeholderBinaryCheckPayload, "placeholderBinaryCheck");
  assert.equal(placeholderBinaryCheckPayload.ok, false);
  assertBinaryCheckContract(
    placeholderBinaryCheckPayload.singbox,
    "binary_version_check_failed",
    true,
    /Binary version check failed|spawn|EACCES|ENOEXEC|Unknown system error/
  );
  assertBinaryCheckContract(
    placeholderBinaryCheckPayload.rclone,
    "binary_version_check_failed",
    true,
    /Binary version check failed|spawn|EACCES|ENOEXEC|Unknown system error/
  );

  const startWithoutProfile = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(startWithoutProfile.status, 409);
  const startWithoutProfilePayload = await startWithoutProfile.json();
  assertHttpErrorResponseContract(startWithoutProfilePayload, "startWithoutProfile", {
    errorCode: "profile_not_imported"
  });
  assert.match(startWithoutProfilePayload.message, /Import a server SyncKey/);
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "sing-box-client.json")), false);

  const malformedStart = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify([])
  });
  assert.equal(malformedStart.status, 400);
  assertHttpErrorResponseContract(await malformedStart.json(), "malformedStart", {
    errorCode: "validation_failed"
  });
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "sing-box-client.json")), false);

  const saveWithoutProfile = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(saveWithoutProfile.status, 409);
  const saveWithoutProfilePayload = await saveWithoutProfile.json();
  assertHttpErrorResponseContract(saveWithoutProfilePayload, "saveWithoutProfile", {
    errorCode: "profile_not_imported"
  });
  assert.equal(JSON.stringify(saveWithoutProfilePayload).includes("CHANGE_ME_CLIENT_SECRET"), false);

  const previewWithoutProfile = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(previewWithoutProfile.status, 409);
  const previewWithoutProfilePayload = await previewWithoutProfile.json();
  assertHttpErrorResponseContract(previewWithoutProfilePayload, "previewWithoutProfile", {
    errorCode: "profile_not_imported"
  });
  assert.equal(JSON.stringify(previewWithoutProfilePayload).includes("CHANGE_ME_CLIENT_SECRET"), false);

  const profilePath = join(tempRoot, "data", "profile.json");
  await writeFile(profilePath, "{", "utf8");
  const previewWithCorruptProfile = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(previewWithCorruptProfile.status, 409);
  const previewWithCorruptProfilePayload = await previewWithCorruptProfile.json();
  assertHttpErrorResponseContract(previewWithCorruptProfilePayload, "previewWithCorruptProfile", {
    errorCode: "local_state_corrupt"
  });
  await rm(profilePath, { force: true });

  const oversizedImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ code: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(oversizedImport.status, 413);
  const oversizedImportPayload = await oversizedImport.json();
  assertHttpErrorResponseContract(oversizedImportPayload, "clientOversizedImport", {
    errorCode: "request_body_too_large",
    message: "Request body too large"
  });

  const invalidJsonImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: "{"
  });
  assert.equal(invalidJsonImport.status, 400);
  assertHttpErrorResponseContract(await invalidJsonImport.json(), "clientInvalidJsonImport", {
    errorCode: "invalid_json",
    message: "Invalid JSON"
  });

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "company-pc1",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "company-pc1",
          secretAccessKey: "top-secret-value",
          prefix: "devices/company-pc1"
        },
        defaults: {
          localProxyPort: 18082,
          transfers: 6,
          streams: 9,
          checkers: 11,
          chunkSize: "32M",
          retries: 5,
          lowLevelRetries: 12,
          bandwidthLimit: "20M",
          schedule: { mode: "daily", time: "03:30" }
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);
  const profileImportPayload = await profileImport.json();
  assertClientProfileImportResponseContract(profileImportPayload, "profileImport");
  assert.equal(profileImportPayload.profile.clientName, "company-pc1");
  assert.equal(profileImportPayload.profile.importMode, "offline-profile");
  assert.equal(profileImportPayload.profile.storage.bucket, "home-sync");
  assert.equal(profileImportPayload.profile.storage.prefix, "devices/company-pc1");
  assert.equal(Object.hasOwn(profileImportPayload.profile.storage, "accessKeyId"), false);
  assert.equal(Object.hasOwn(profileImportPayload.profile.storage, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(profileImportPayload.profile.tunnel, "uri"), false);
  assert.equal(JSON.stringify(profileImportPayload.profile).includes("top-secret-value"), false);
  assert.equal(JSON.stringify(profileImportPayload.profile).includes(tunnelUri), false);
  assert.equal(profileImportPayload.profile.defaults.transfers, 6);
  assert.equal(profileImportPayload.profile.defaults.streams, 9);
  assert.equal(profileImportPayload.profile.defaults.checkers, 11);
  assert.equal(profileImportPayload.profile.defaults.chunkSize, "32M");
  assert.equal(profileImportPayload.profile.defaults.localProxyPort, 18082);

  const savedJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...maliciousProfileDerivedJobFields(),
        localPath: "D:\\Work",
        direction: "download",
        remoteFolder: "projects",
        serverSpace: "device"
      }
    })
  });
  assert.equal(savedJob.status, 200);
  const savedJobPayload = await savedJob.json();
  assertClientJobSaveResponseContract(savedJobPayload, "savedJob");
  assertClientJobSummaryContract(savedJobPayload.job, "savedJob.job");
  assert.equal(savedJobPayload.job.localPath, "D:\\Work");
  assert.equal(savedJobPayload.job.direction, "download");
  assert.equal(savedJobPayload.job.remoteFolder, "projects");
  assert.equal(savedJobPayload.job.serverSpace, "device");
  assert.equal(savedJobPayload.job.clientName, "company-pc1");
  assert.equal(savedJobPayload.job.remoteName, "home-minio");
  assert.equal(savedJobPayload.job.bucketName, "home-sync");
  assert.equal(savedJobPayload.job.s3Endpoint, "http://minio:9000");
  assert.equal(savedJobPayload.job.remotePrefix, "devices/company-pc1/projects");
  assert.equal(savedJobPayload.job.transfers, 6);
  assert.equal(savedJobPayload.job.streams, 9);
  assert.equal(savedJobPayload.job.checkers, 11);
  assert.equal(savedJobPayload.job.s3UploadConcurrency, 9);
  assert.equal(savedJobPayload.job.s3ChunkSize, "32M");
  assert.equal(savedJobPayload.job.cutoff, "32M");
  assert.equal(savedJobPayload.job.retries, 5);
  assert.equal(savedJobPayload.job.lowLevelRetries, 12);
  assert.equal(savedJobPayload.job.bandwidthLimit, "20M");
  assert.deepEqual(savedJobPayload.job.schedule, { mode: "daily", time: "03:30" });
  assert.equal(savedJobPayload.job.localProxyPort, 18082);
  assert.equal(Object.hasOwn(savedJobPayload.job, "accessKeyId"), false);
  assert.equal(Object.hasOwn(savedJobPayload.job, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(savedJobPayload.job, "s3SecretAccessKey"), false);
  assert.equal(savedJobPayload.scheduler.enabled, true);
  assert.equal(savedJobPayload.scheduler.jobs.length, 1);
  assert.equal(savedJobPayload.scheduler.jobs[0].scheduleText, "Daily at 03:30");
  assert.match(savedJobPayload.scheduler.jobs[0].nextRun, /^\d{4}-\d{2}-\d{2}T/);

  const previewFromMinimalJob = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...maliciousProfileDerivedJobFields(),
        localPath: "D:\\Work",
        direction: "download"
      }
    })
  });
  assert.equal(previewFromMinimalJob.status, 200);
  const previewFromMinimalJobPayload = await previewFromMinimalJob.json();
  assertSyncPreviewContract(previewFromMinimalJobPayload, "previewFromMinimalJob", {
    rawSecrets: ["top-secret-value"],
    remoteConfigSecret: "top-secret-value"
  });
  const previewArgs = previewFromMinimalJobPayload.rclone.args;
  assert.equal(previewArgs[previewArgs.indexOf("--transfers") + 1], "6");
  assert.equal(previewArgs[previewArgs.indexOf("--checkers") + 1], "11");
  assert.equal(previewArgs[previewArgs.indexOf("--multi-thread-streams") + 1], "9");
  assert.equal(previewArgs[previewArgs.indexOf("--multi-thread-cutoff") + 1], "32M");
  assert.equal(previewArgs[previewArgs.indexOf("--retries") + 1], "5");
  assert.equal(previewArgs[previewArgs.indexOf("--low-level-retries") + 1], "12");
  assert.equal(previewArgs[previewArgs.indexOf("--s3-upload-concurrency") + 1], "9");
  assert.equal(previewArgs[previewArgs.indexOf("--s3-chunk-size") + 1], "32M");
  assert.equal(previewArgs[previewArgs.indexOf("--bwlimit") + 1], "20M");
  assert.equal(previewFromMinimalJobPayload.rclone.env.ALL_PROXY, "socks5://127.0.0.1:18082");
  assert.equal(previewFromMinimalJobPayload.rclone.storage.remoteName, "home-minio");
  assert.equal(previewFromMinimalJobPayload.rclone.storage.bucketName, "home-sync");
  assert.equal(previewFromMinimalJobPayload.rclone.storage.endpoint, "http://minio:9000");
  assert.equal(previewFromMinimalJobPayload.rclone.remotePath, "home-minio:home-sync/devices/company-pc1");
  assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.args.includes("top-secret-value"), false);
  assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.args.includes("secret_access_key"), false);
  assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.env.RCLONE_CONFIG_HOME_MINIO_SECRET_ACCESS_KEY, "top-secret-value");
  assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.args.includes("evil-secret-value"), false);
  assert.equal(previewFromMinimalJobPayload.rclone.remoteConfig.args.includes("evil-s3-secret-value"), false);
  assert.equal(JSON.stringify(previewFromMinimalJobPayload).includes("evil-minio"), false);
  assert.equal(JSON.stringify(previewFromMinimalJobPayload).includes("override.example.invalid"), false);
  assert.equal(previewFromMinimalJobPayload.schedule.text, "Daily at 03:30");
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "rclone.conf")), false);
  const historyAfterPreview = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assertClientSyncHistoryContract(historyAfterPreview, "historyAfterPreview");
  assert.deepEqual(historyAfterPreview.history, []);

  const statusAfterSave = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusAfterSave.status, 200);
  const statusAfterSavePayload = await statusAfterSave.json();
  assertClientStatusContract(statusAfterSavePayload);
  assert.equal(statusAfterSavePayload.ok, true);
  assert.equal(statusAfterSavePayload.mode, "client-exe-runtime");
  assert.equal(statusAfterSavePayload.appVersion, "0.3.0-rc.1");
  assert.equal(statusAfterSavePayload.clientVersion, "0.3.0-rc.1");
  assert.equal(statusAfterSavePayload.diagnostics.role, "client");
  assert.equal(statusAfterSavePayload.diagnostics.version, "0.3.0-rc.1");
  assert.equal(statusAfterSavePayload.diagnostics.protocols.profile, 1);
  assert.equal(statusAfterSavePayload.diagnostics.protocols.heartbeat, 1);
  assert.match(statusAfterSavePayload.paths.root, /sfsc-client-http-/);
  assert.match(statusAfterSavePayload.paths.binRoot, /bin/);
  assert.match(statusAfterSavePayload.paths.dataRoot, /data/);
  assert.equal(statusAfterSavePayload.releaseManifest.exists, false);
  assert.equal(statusAfterSavePayload.releaseManifest.ok, false);
  assert.equal(statusAfterSavePayload.releaseManifest.errorCode, "release_manifest_missing");
  assert.match(statusAfterSavePayload.releaseManifest.message, /release-manifest\.json was not found/);
  assert.equal(statusAfterSavePayload.releaseManifest.supportDocuments.ok, false);
  assert.deepEqual(
    statusAfterSavePayload.releaseManifest.supportDocuments.files.map((file) => [file.name, file.path, file.present, file.valid]),
    [
      ["INTERFACE_CONTRACT", "resources/app/docs/INTERFACE_CONTRACT.md", false, false],
      ["API_MATRIX", "resources/app/docs/API_MATRIX.md", false, false],
      ["DEPLOYMENT_AND_MIGRATION_GUIDE", "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md", false, false],
      ["INTERNAL_TRIAL_CHECKLIST", "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md", false, false],
      ["PILOT_RUNBOOK", "resources/app/docs/PILOT_RUNBOOK.md", false, false],
      ["PILOT_ACCEPTANCE_CRITERIA", "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md", false, false],
      ["PILOT_SUPPORT_GUIDE", "resources/app/docs/PILOT_SUPPORT_GUIDE.md", false, false]
    ]
  );
  assert.equal(statusAfterSavePayload.releaseManifest.requiredFiles.ok, false);
  assert.equal(Array.isArray(statusAfterSavePayload.releaseManifest.requiredFiles.files), true);
  assert.ok(statusAfterSavePayload.releaseManifest.requiredFiles.files.every((file) => typeof file.name === "string" && typeof file.path === "string"));
  assert.equal(statusAfterSavePayload.profileImported, true);
  assert.equal(typeof statusAfterSavePayload.profileImported, "boolean");
  assert.equal(typeof statusAfterSavePayload.profileSummary, "object");
  assert.equal(statusAfterSavePayload.profileSummary.clientName, "company-pc1");
  assert.equal(statusAfterSavePayload.profileSummary.storage, "home-sync/devices/company-pc1");
  assert.equal(statusAfterSavePayload.jobs.length, 1);
  assert.equal(Array.isArray(statusAfterSavePayload.syncHistory), true);
  assert.equal(statusAfterSavePayload.lastSync, null);
  assert.equal(statusAfterSavePayload.scheduler.jobs.length, 1);
  assert.equal(statusAfterSavePayload.scheduler.enabled, true);
  assert.equal(typeof statusAfterSavePayload.scheduler.intervalMs, "number");
  assert.equal(Number.isInteger(statusAfterSavePayload.scheduler.intervalMs), true);
  assert.equal(statusAfterSavePayload.scheduler.lastError, "");
  assert.match(statusAfterSavePayload.scheduler.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(statusAfterSavePayload.scheduler.jobs[0].id, savedJobPayload.job.id);
  assert.equal(typeof statusAfterSavePayload.scheduler.jobs[0].name, "string");
  assert.equal(statusAfterSavePayload.scheduler.jobs[0].lastError, "");
  assert.ok(statusAfterSavePayload.scheduler.jobs[0].lastTriggeredAt === null || typeof statusAfterSavePayload.scheduler.jobs[0].lastTriggeredAt === "string");
  assert.match(statusAfterSavePayload.scheduler.nextRun, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof statusAfterSavePayload.processes.singbox.running, "boolean");
  assert.equal(typeof statusAfterSavePayload.processes.sync.running, "boolean");
  assert.equal(statusAfterSavePayload.processes.singbox.name, "sing-box");
  assert.equal(statusAfterSavePayload.processes.sync.name, "rclone-sync");
  assert.ok(statusAfterSavePayload.processes.singbox.pid === null || Number.isInteger(statusAfterSavePayload.processes.singbox.pid));
  assert.ok(statusAfterSavePayload.processes.sync.pid === null || Number.isInteger(statusAfterSavePayload.processes.sync.pid));
  assert.equal(statusAfterSavePayload.processes.singbox.running, false);
  assert.equal(statusAfterSavePayload.processes.sync.running, false);
  assert.equal(statusAfterSavePayload.processes.sync.metrics.syncState, "idle");
  assert.ok(["idle", "syncing", "error", "stopping", "offline"].includes(statusAfterSavePayload.processes.sync.metrics.syncState));
  assert.equal(statusAfterSavePayload.jobs[0].checkers, 11);
  assert.equal(statusAfterSavePayload.jobs[0].localProxyPort, 18082);
  assert.equal(Object.hasOwn(statusAfterSavePayload.jobs[0], "secretAccessKey"), false);
  assert.equal(Object.hasOwn(statusAfterSavePayload.jobs[0], "s3SecretAccessKey"), false);
  assert.equal(Object.hasOwn(statusAfterSavePayload.jobs[0], "heartbeatSecret"), false);
  assert.equal(Object.hasOwn(statusAfterSavePayload.jobs[0], "heartbeatAuthNonces"), false);
  assert.equal(Object.hasOwn(statusAfterSavePayload.jobs[0], "vlessUri"), false);

  const startupJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\Startup",
        direction: "upload",
        schedule: { mode: "startup" }
      }
    })
  });
  assert.equal(startupJob.status, 200);
  const startupJobPayload = await startupJob.json();
  assertClientJobSaveResponseContract(startupJobPayload, "startupJob");
  assert.deepEqual(startupJobPayload.job.schedule, { mode: "startup" });
  const startupSchedule = startupJobPayload.scheduler.jobs.find((job) => job.schedule?.mode === "startup");
  assert.ok(startupSchedule);
  assert.equal(startupSchedule.scheduleText, "Run on client startup");
  assert.equal(startupSchedule.nextRun, "on-startup");
  assert.equal(startupSchedule.lastError, "");

  assert.equal(statusAfterSavePayload.safeguards.tun, false);
  assert.equal(statusAfterSavePayload.safeguards.systemProxy, false);
  assert.equal(statusAfterSavePayload.safeguards.routeMutation, false);
  assert.equal(statusAfterSavePayload.safeguards.dnsMutation, false);
  assert.equal(typeof statusAfterSavePayload.safeguards.rcloneConfigScope, "string");
  assert.match(statusAfterSavePayload.safeguards.rcloneConfigScope, /rclone\.conf$/);
  assert.equal(statusAfterSavePayload.safeguards.localState.ok, true);
  assert.equal(statusAfterSavePayload.safeguards.secretVault.ok, true);
  assertBinaryPresenceContract(statusAfterSavePayload.binaries.singbox, "missing_singbox_binary", /Missing bundled sing-box/);
  assertBinaryPresenceContract(statusAfterSavePayload.binaries.rclone, "missing_rclone_binary", /Missing bundled rclone/);
  const profileRead = await fetch(`${baseUrl}/api/profile`);
  assert.equal(profileRead.status, 200);
  const profileReadPayload = await profileRead.json();
  assertClientProfileReadContract(profileReadPayload, "profileRead");
  assert.equal(profileReadPayload.profile.storage.bucket, "home-sync");
  assert.equal(profileReadPayload.profile.storage.prefix, "devices/company-pc1");
  assert.equal(Object.hasOwn(profileReadPayload.profile.storage, "accessKeyId"), false);
  assert.equal(Object.hasOwn(profileReadPayload.profile.storage, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(profileReadPayload.profile.tunnel, "uri"), false);
  assert.equal(JSON.stringify(profileReadPayload.profile).includes("top-secret-value"), false);
  assert.equal(JSON.stringify(profileReadPayload.profile).includes(tunnelUri), false);
  const jobsRead = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(jobsRead.status, 200);
  const jobsReadPayload = await jobsRead.json();
  assertClientJobsReadContract(jobsReadPayload, "jobsRead");
  assert.equal(jobsReadPayload.jobs.length, 2);
  const listedSavedJob = jobsReadPayload.jobs.find((job) => job.id === savedJobPayload.job.id);
  assert.ok(listedSavedJob);
  assert.equal(listedSavedJob.remotePrefix, "devices/company-pc1/projects");
  assert.equal(Object.hasOwn(listedSavedJob, "accessKeyId"), false);
  assert.equal(Object.hasOwn(listedSavedJob, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(listedSavedJob, "s3SecretAccessKey"), false);
  const storedProfileText = await readFile(join(tempRoot, "data", "profile.json"), "utf8");
  const storedJobsText = await readFile(join(tempRoot, "data", "jobs.json"), "utf8");
  assert.equal(storedProfileText.includes("top-secret-value"), false);
  assert.equal(storedJobsText.includes("top-secret-value"), false);
  assert.equal(storedJobsText.includes("evil"), false);
  const storedProfile = JSON.parse(storedProfileText);
  const storedJobs = JSON.parse(storedJobsText);
  assert.match(storedProfile.storage.secretAccessKey.secretRef, /^profile:/);
  assert.equal(storedJobs.length, 2);
  for (const storedJob of storedJobs) {
    assert.match(storedJob.secretAccessKey.secretRef, /^job:/);
  }
  const secretsText = await readFile(join(tempRoot, "data", "secrets.json"), "utf8");
  assert.equal(secretsText.includes("top-secret-value"), true);
  assert.equal(secretsText.includes("evil-secret-value"), false);
  assert.equal(secretsText.includes("evil-s3-secret-value"), false);
  await writeFile(join(tempRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: "SyncraftDesktop",
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    files: releaseManifestFiles("SyncraftDesktop")
  }, null, 2), "utf8");

  const statusAfterManifest = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusAfterManifest.status, 200);
  const statusAfterManifestPayload = await statusAfterManifest.json();
  assert.equal(statusAfterManifestPayload.releaseManifest.ok, true);
  assert.equal(statusAfterManifestPayload.releaseManifest.package, "SyncraftDesktop");
  assert.equal(statusAfterManifestPayload.releaseManifest.version, "0.3.0-rc.1");
  assert.equal(statusAfterManifestPayload.releaseManifest.builtAt, "2026-07-04T00:00:00.000Z");
  assert.equal(statusAfterManifestPayload.releaseManifest.fileCount, 27);
  assert.equal(statusAfterManifestPayload.releaseManifest.supportDocuments.ok, true);
  assert.equal(statusAfterManifestPayload.releaseManifest.requiredFiles.ok, true);
  assert.deepEqual(
    statusAfterManifestPayload.releaseManifest.supportDocuments.files.map((file) => [file.name, file.present, file.valid]),
    [
      ["INTERFACE_CONTRACT", true, true],
      ["API_MATRIX", true, true],
      ["DEPLOYMENT_AND_MIGRATION_GUIDE", true, true],
      ["INTERNAL_TRIAL_CHECKLIST", true, true],
      ["PILOT_RUNBOOK", true, true],
      ["PILOT_ACCEPTANCE_CRITERIA", true, true],
      ["PILOT_SUPPORT_GUIDE", true, true]
    ]
  );

  await writeFile(join(tempRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: "SyncraftClient",
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T01:00:00.000Z",
    files: releaseManifestFiles("SyncraftClient")
  }, null, 2), "utf8");

  const statusAfterPortableManifest = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusAfterPortableManifest.status, 200);
  const portableManifestPayload = await statusAfterPortableManifest.json();
  assert.equal(portableManifestPayload.releaseManifest.ok, true);
  assert.equal(portableManifestPayload.releaseManifest.package, "SyncraftClient");
  assert.equal(portableManifestPayload.releaseManifest.errorCode, "");
  assert.equal(portableManifestPayload.releaseManifest.builtAt, "2026-07-04T01:00:00.000Z");
  assert.equal(portableManifestPayload.releaseManifest.supportDocuments.ok, true);
  assert.equal(portableManifestPayload.releaseManifest.requiredFiles.ok, true);

  await writeFile(join(tempRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: "SyncraftDesktop",
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    files: releaseManifestFiles("SyncraftDesktop", {
      "resources/app/docs/INTERFACE_CONTRACT.md": { size: 0, sha256: "not-a-sha" }
    })
  }, null, 2), "utf8");

  const statusAfterInvalidSupportDocManifest = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusAfterInvalidSupportDocManifest.status, 200);
  const invalidSupportDocPayload = await statusAfterInvalidSupportDocManifest.json();
  assert.equal(invalidSupportDocPayload.releaseManifest.ok, false);
  assert.equal(invalidSupportDocPayload.releaseManifest.errorCode, "release_manifest_invalid");
  assert.equal(invalidSupportDocPayload.releaseManifest.supportDocuments.ok, false);
  assert.equal(invalidSupportDocPayload.releaseManifest.requiredFiles.ok, false);
  assert.deepEqual(
    invalidSupportDocPayload.releaseManifest.supportDocuments.files.map((file) => [file.name, file.present, file.valid]),
    [
      ["INTERFACE_CONTRACT", true, false],
      ["API_MATRIX", true, true],
      ["DEPLOYMENT_AND_MIGRATION_GUIDE", true, true],
      ["INTERNAL_TRIAL_CHECKLIST", true, true],
      ["PILOT_RUNBOOK", true, true],
      ["PILOT_ACCEPTANCE_CRITERIA", true, true],
      ["PILOT_SUPPORT_GUIDE", true, true]
    ]
  );

  const stoppedSingbox = await fetch(`${baseUrl}/api/singbox/stop`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(stoppedSingbox.status, 200);
  const stoppedSingboxPayload = await stoppedSingbox.json();
  assertClientSingboxProcessResponseContract(stoppedSingboxPayload, "stoppedSingbox");
  assert.equal(stoppedSingboxPayload.singbox.name, "sing-box");
  assert.equal(stoppedSingboxPayload.singbox.running, false);
  assert.ok(stoppedSingboxPayload.singbox.lastExit === null || stoppedSingboxPayload.singbox.lastExit.ok === true);
  const statusAfterIdleSingboxStop = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterIdleSingboxStop.processes.singbox.name, "sing-box");
  assert.equal(statusAfterIdleSingboxStop.processes.singbox.running, false);
  assert.equal(statusAfterIdleSingboxStop.lastSync?.id || null, null);

  await writeFile(join(tempRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: "SyncraftDesktop",
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    files: releaseManifestFiles("SyncraftDesktop")
  }, null, 2), "utf8");

  const stoppedSync = await fetch(`${baseUrl}/api/sync/stop`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(stoppedSync.status, 200);
  const stoppedSyncPayload = await stoppedSync.json();
  assertClientSyncRunResponseContract(stoppedSyncPayload, "stoppedSync");
  assert.equal(stoppedSyncPayload.sync.name, "rclone-sync");
  assert.equal(stoppedSyncPayload.sync.running, false);
  const historyAfterIdleStop = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assert.deepEqual(historyAfterIdleStop.history, []);
  const statusAfterIdleStop = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterIdleStop.processes.sync.metrics.syncState, "idle");
  assert.equal(statusAfterIdleStop.lastSync, null);

  await mkdir(join(tempRoot, "data", "logs"), { recursive: true });
  await writeFile(
    join(tempRoot, "data", "logs", "sing-box.log"),
    "singbox ok\nsecret_access_key singbox-secret\n{\"secretAccessKey\":\"json-log-secret\"}\nMINIO_ROOT_PASSWORD=.minio-placeholder\n",
    "utf8"
  );
  await writeFile(
    join(tempRoot, "data", "logs", "rclone.log"),
    "rclone ok\nS3_SECRET_ACCESS_KEY=rclone-secret\nAWS_SECRET_ACCESS_KEY = aws-secret\nTransferred: C:\\Users\\Tong_hp\\Documents\\private.txt\n",
    "utf8"
  );
  const logsResponse = await fetch(`${baseUrl}/api/logs`);
  assert.equal(logsResponse.status, 200);
  const logsPayload = await logsResponse.json();
  assertClientLogsContract(logsPayload, "logsPayload", {
    rawSecrets: ["singbox-secret", "json-log-secret", ".minio-placeholder", "rclone-secret", "aws-secret"]
  });
  assert.match(logsPayload.singbox, /singbox ok/);
  assert.match(logsPayload.rclone, /rclone ok/);
  assert.equal(logsPayload.singbox.includes("singbox-secret"), false);
  assert.equal(logsPayload.singbox.includes("json-log-secret"), false);
  assert.equal(logsPayload.singbox.includes(".minio-placeholder"), false);
  assert.equal(logsPayload.rclone.includes("rclone-secret"), false);
  assert.equal(logsPayload.rclone.includes("aws-secret"), false);
  assert.equal(logsPayload.rclone.includes("C:\\Users"), false);
  assert.equal(logsPayload.rclone.includes("private.txt"), false);
  assert.match(logsPayload.singbox, /secret_access_key \*\*\*\*/);
  assert.match(logsPayload.singbox, /"secretAccessKey":"\*\*\*\*"/);
  assert.match(logsPayload.singbox, /MINIO_ROOT_PASSWORD=\*\*\*\*/);
  assert.match(logsPayload.rclone, /S3_SECRET_ACCESS_KEY=\*\*\*\*/);
  assert.match(logsPayload.rclone, /AWS_SECRET_ACCESS_KEY = \*\*\*\*/);
  assert.match(logsPayload.rclone, /<local-path>/);

  const diagnosticExport = await fetch(`${baseUrl}/api/diagnostics/export`);
  assert.equal(diagnosticExport.status, 200);
  const diagnosticPayload = await diagnosticExport.json();
  assertDiagnosticExportContract(diagnosticPayload, "diagnosticExport", {
    rawSecrets: ["top-secret-value", tunnelUri, "json-log-secret", ".minio-placeholder", "aws-secret"]
  });
  assert.equal(diagnosticPayload.ok, true);
  assert.match(diagnosticPayload.filename, /^sfsc-client-diagnostics-.*\.json$/);
  assert.equal(diagnosticPayload.bundle.schemaVersion, 1);
  assert.equal(diagnosticPayload.bundle.role, "client");
  assert.equal(diagnosticPayload.bundle.summary.appVersion, "0.3.0-rc.1");
  assert.equal(diagnosticPayload.bundle.summary.releaseManifestOk, true);
  assert.equal(diagnosticPayload.bundle.summary.releaseManifestVersion, "0.3.0-rc.1");
  assert.equal(diagnosticPayload.bundle.summary.releaseManifestBuiltAt, "2026-07-04T00:00:00.000Z");
  assert.equal(diagnosticPayload.bundle.summary.releaseManifestErrorCode, "");
  assert.equal(diagnosticPayload.bundle.summary.releaseManifestSupportDocsOk, true);
  assert.deepEqual(diagnosticPayload.bundle.summary.releaseManifestSupportDocsMissing, []);
  assert.equal(diagnosticPayload.bundle.summary.profileImported, true);
  assert.equal(diagnosticPayload.bundle.summary.profileClientName, "redacted");
  assert.equal(diagnosticPayload.bundle.summary.portableRoot, true);
  assert.equal(typeof diagnosticPayload.bundle.summary.binariesOk, "boolean");
  assert.equal(Array.isArray(diagnosticPayload.bundle.summary.missingBinaries), true);
  assert.equal(diagnosticPayload.bundle.summary.localStateOk, true);
  assert.equal(diagnosticPayload.bundle.summary.secretVaultOk, true);
  assert.ok([null, false].includes(diagnosticPayload.bundle.summary.heartbeatOk));
  assert.ok(["", "heartbeat_failed"].includes(diagnosticPayload.bundle.summary.heartbeatErrorCode));
  assert.equal(typeof diagnosticPayload.bundle.summary.lastSyncStatus, "string");
  assert.equal(Array.isArray(diagnosticPayload.bundle.summary.logsMissing), true);
  assert.equal(Array.isArray(diagnosticPayload.bundle.summary.logsTruncated), true);
  assert.equal(diagnosticPayload.bundle.status.diagnostics.role, "client");
  assert.equal(diagnosticPayload.bundle.status.jobs.length, 2);
  assert.ok(diagnosticPayload.bundle.status.jobs.some((job) => job.schedule?.mode === "startup"));
  assert.equal(diagnosticPayload.bundle.environment.platform, process.platform);
  assert.equal(diagnosticPayload.bundle.environment.portableRoot, true);
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.ok, true);
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.version, "0.3.0-rc.1");
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.fileCount, 27);
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.supportDocuments.ok, true);
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.requiredFiles.ok, true);
  assert.equal(diagnosticPayload.bundle.environment.releaseManifest.path, "release-manifest.json");
  assert.equal(diagnosticPayload.bundle.environment.stateFiles.profile.exists, true);
  assert.equal(diagnosticPayload.bundle.environment.stateFiles.jobs.exists, true);
  assert.equal(diagnosticPayload.bundle.environment.stateFiles.secrets.exists, true);
  assert.equal(typeof diagnosticPayload.bundle.environment.stateFiles.claimRecovery.exists, "boolean");
  assert.equal(diagnosticPayload.bundle.environment.stateFiles.claimRecovery.path, "claim-recovery.json");
  assert.equal(typeof diagnosticPayload.bundle.environment.logFiles.electron.exists, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.environment.logFiles.singbox.exists, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.environment.logFiles.rclone.exists, "boolean");
  assert.equal(diagnosticPayload.bundle.environment.logFiles.electron.path, "electron-main.log");
  assert.equal(diagnosticPayload.bundle.environment.logFiles.singbox.path, "sing-box.log");
  assert.equal(diagnosticPayload.bundle.environment.logFiles.rclone.path, "rclone.log");
  assert.equal(typeof diagnosticPayload.bundle.environment.binaries.rclone.exists, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.environment.binaries.singbox.exists, "boolean");
  assert.equal(diagnosticPayload.bundle.environment.binaries.rclone.path, "rclone.exe");
  assert.equal(diagnosticPayload.bundle.environment.binaries.singbox.path, "sing-box.exe");
  assert.equal(typeof diagnosticPayload.bundle.logs.electron.exists, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.logs.singbox.exists, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.logs.rclone.exists, "boolean");
  assert.equal(diagnosticPayload.bundle.logs.rclone.maxChars, 20000);
  assert.equal(typeof diagnosticPayload.bundle.logs.rclone.truncated, "boolean");
  assert.equal(typeof diagnosticPayload.bundle.logs.rclone.text, "string");
  assert.equal(diagnosticPayload.bundle.logs.rclone.path, "rclone.log");
  assert.equal(diagnosticPayload.bundle.logs.singbox.text.includes("json-log-secret"), false);
  assert.equal(diagnosticPayload.bundle.logs.singbox.text.includes(".minio-placeholder"), false);
  assert.equal(diagnosticPayload.bundle.logs.rclone.text.includes("aws-secret"), false);
  assert.equal(diagnosticPayload.bundle.logs.rclone.text.includes("private.txt"), false);
  const diagnosticText = JSON.stringify(diagnosticPayload.bundle);
  assert.equal(diagnosticText.includes("company-pc1"), false);
  assert.equal(diagnosticText.includes("home-sync"), false);
  assert.equal(diagnosticText.includes("devices/company-pc1"), false);
  assert.equal(diagnosticText.includes("http://minio:9000"), false);
  assert.equal(
    diagnosticPayload.bundle.environment.logFiles.rclone.exists,
    diagnosticPayload.bundle.logs.rclone.exists
  );
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes("top-secret-value"), false);
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes(tunnelUri), false);
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes(tempRoot), false);
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes("D:\\Work"), false);
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes("projects/current.iso"), false);
  assert.equal(JSON.stringify(diagnosticPayload.bundle).includes("projects/conflict.txt"), false);
  assert.equal(Object.hasOwn(diagnosticPayload.bundle.status.jobs[0], "secretAccessKey"), false);
  assert.equal(Object.hasOwn(diagnosticPayload.bundle.status.jobs[0], "s3SecretAccessKey"), false);

  await rm(join(tempRoot, "data", "secrets.json"), { force: true });
  const missingVaultStatus = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(missingVaultStatus.status, 200);
  const missingVaultPayload = await missingVaultStatus.json();
  assert.equal(missingVaultPayload.safeguards.secretVault.ok, false);
  assert.equal(missingVaultPayload.safeguards.secretVault.protected, false);
  assert.equal(missingVaultPayload.safeguards.secretVault.protection.exists, false);
  assert.equal(missingVaultPayload.safeguards.secretVault.missingRefs.length, 3);
  assert.equal(missingVaultPayload.safeguards.secretVault.missingRefs.every((ref) => ref === "redacted"), true);
  assert.equal(missingVaultPayload.profileImported, true);
  assert.equal(missingVaultPayload.profileSummary.clientName, "company-pc1");
  assert.equal(missingVaultPayload.profileSummary.storage, "home-sync/devices/company-pc1");
  assert.equal(missingVaultPayload.jobs.length, 2);
  assert.equal(Object.hasOwn(missingVaultPayload.jobs[0], "secretAccessKey"), false);
  assert.equal(JSON.stringify(missingVaultPayload).includes("top-secret-value"), false);

  const missingVaultProfileRead = await fetch(`${baseUrl}/api/profile`);
  assert.equal(missingVaultProfileRead.status, 200);
  const missingVaultProfileReadPayload = await missingVaultProfileRead.json();
  assert.equal(missingVaultProfileReadPayload.profile.clientName, "company-pc1");
  assert.equal(missingVaultProfileReadPayload.profile.storage.bucket, "home-sync");
  assert.equal(Object.hasOwn(missingVaultProfileReadPayload.profile.storage, "secretAccessKey"), false);
  assert.equal(JSON.stringify(missingVaultProfileReadPayload).includes("top-secret-value"), false);

  const missingVaultJobsRead = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(missingVaultJobsRead.status, 200);
  const missingVaultJobsReadPayload = await missingVaultJobsRead.json();
  assertClientJobsReadContract(missingVaultJobsReadPayload, "missingVaultJobsRead");
  assert.equal(missingVaultJobsReadPayload.jobs.length, 2);
  assert.equal(missingVaultJobsReadPayload.jobs.some((job) => job.schedule?.mode === "startup"), true);
  assert.equal(Object.hasOwn(missingVaultJobsReadPayload.jobs[0], "secretAccessKey"), false);
  assert.equal(JSON.stringify(missingVaultJobsReadPayload).includes("top-secret-value"), false);

  const missingVaultDiagnosticExport = await fetch(`${baseUrl}/api/diagnostics/export`);
  assert.equal(missingVaultDiagnosticExport.status, 200);
  const missingVaultDiagnosticPayload = await missingVaultDiagnosticExport.json();
  assertDiagnosticExportContract(missingVaultDiagnosticPayload, "missingVaultDiagnosticExport", {
    rawSecrets: ["top-secret-value"]
  });
  assert.equal(missingVaultDiagnosticPayload.ok, true);
  assert.equal(missingVaultDiagnosticPayload.bundle.summary.secretVaultOk, false);
  assert.equal(missingVaultDiagnosticPayload.bundle.summary.missingSecretRefs, 3);
  assert.equal(missingVaultDiagnosticPayload.bundle.status.safeguards.secretVault.ok, false);
  assert.equal(missingVaultDiagnosticPayload.bundle.status.safeguards.secretVault.missingRefs.length, 3);
  assert.equal(missingVaultDiagnosticPayload.bundle.status.safeguards.secretVault.missingRefs.every((ref) => ref === "redacted"), true);
  assert.equal(JSON.stringify(missingVaultDiagnosticPayload.bundle).includes("top-secret-value"), false);

  const missingVaultPreview = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work", direction: "download" } })
  });
  assert.equal(missingVaultPreview.status, 409);
  assertHttpErrorResponseContract(await missingVaultPreview.json(), "missingVaultPreview", {
    errorCode: "secret_vault_missing"
  });

  const missingVaultJobsBefore = await readFile(join(tempRoot, "data", "jobs.json"), "utf8");
  const missingVaultHistoryBefore = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  const missingVaultRcloneConfigPath = join(tempRoot, "data", "runtime", "rclone.conf");
  assert.equal(await pathExists(missingVaultRcloneConfigPath), false);

  const missingVaultSave = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        id: "missing-vault-should-not-save",
        localPath: "D:\\MissingVault",
        direction: "upload"
      }
    })
  });
  assert.equal(missingVaultSave.status, 409);
  assertHttpErrorResponseContract(await missingVaultSave.json(), "missingVaultSave", {
    errorCode: "secret_vault_missing"
  });
  assert.equal(await readFile(join(tempRoot, "data", "jobs.json"), "utf8"), missingVaultJobsBefore);

  const missingVaultRun = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work", direction: "download" } })
  });
  assert.equal(missingVaultRun.status, 409);
  assertHttpErrorResponseContract(await missingVaultRun.json(), "missingVaultRun", {
    errorCode: "secret_vault_missing"
  });
  assert.equal(await readFile(join(tempRoot, "data", "jobs.json"), "utf8"), missingVaultJobsBefore);
  const missingVaultHistoryAfterRun = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assert.deepEqual(missingVaultHistoryAfterRun.history, missingVaultHistoryBefore.history);
  assert.equal(await pathExists(missingVaultRcloneConfigPath), false);
  const statusAfterMissingVaultRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterMissingVaultRun.processes.sync.running, false);
  assert.equal(statusAfterMissingVaultRun.processes.sync.metrics.syncState, "idle");

  const refreshedProfileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "company-pc1",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio-v2",
          endpoint: "http://minio-v2:9000",
          bucket: "home-sync-v2",
          accessKeyId: "company-pc1-v2",
          secretAccessKey: "top-secret-value-v2",
          prefix: "devices-v2/company-pc1"
        },
        defaults: {
          localProxyPort: 18083,
          transfers: 2,
          streams: 3,
          checkers: 13,
          chunkSize: "64M",
          retries: 7,
          lowLevelRetries: 14,
          bandwidthLimit: "off",
          schedule: { mode: "manual" }
        }
      })}`
    })
  });
  assert.equal(refreshedProfileImport.status, 200);
  const statusAfterReimport = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(statusAfterReimport.status, 200);
  const statusAfterReimportPayload = await statusAfterReimport.json();
  assert.equal(statusAfterReimportPayload.jobs.length, 2);
  const refreshedSavedJob = statusAfterReimportPayload.jobs.find((job) => job.id === savedJobPayload.job.id);
  const refreshedStartupJob = statusAfterReimportPayload.jobs.find((job) => job.schedule?.mode === "startup");
  assert.ok(refreshedSavedJob);
  assert.ok(refreshedStartupJob);
  assert.equal(refreshedSavedJob.localPath, "D:\\Work");
  assert.equal(refreshedSavedJob.direction, "download");
  assert.equal(refreshedSavedJob.remoteFolder, "projects");
  assert.equal(refreshedSavedJob.serverSpace, "device");
  assert.equal(refreshedSavedJob.remoteName, "home-minio-v2");
  assert.equal(refreshedSavedJob.bucketName, "home-sync-v2");
  assert.equal(refreshedSavedJob.remotePrefix, "devices-v2/company-pc1/projects");
  assert.equal(Object.hasOwn(refreshedSavedJob, "secretAccessKey"), false);
  assert.equal(refreshedSavedJob.checkers, 11);
  assert.equal(refreshedSavedJob.s3ChunkSize, "32M");
  assert.equal(refreshedSavedJob.localProxyPort, 18082);
  assert.equal(refreshedStartupJob.remoteName, "home-minio-v2");
  assert.deepEqual(refreshedStartupJob.schedule, { mode: "startup" });
  const listedJobsAfterReimport = await (await fetch(`${baseUrl}/api/jobs`)).json();
  const listedRefreshedSavedJob = listedJobsAfterReimport.jobs.find((job) => job.id === savedJobPayload.job.id);
  assert.equal(listedRefreshedSavedJob.remotePrefix, "devices-v2/company-pc1/projects");
  assert.equal(Object.hasOwn(listedRefreshedSavedJob, "secretAccessKey"), false);

  const updatedJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        id: savedJobPayload.job.id,
        localPath: "D:\\Work Updated",
        direction: "download",
        remoteFolder: "projects",
        serverSpace: "device",
        checkers: 12,
        dryRun: true,
        localProxyPort: 18083
      }
    })
  });
  assert.equal(updatedJob.status, 200);
  const updatedJobPayload = await updatedJob.json();
  assertClientJobSaveResponseContract(updatedJobPayload, "updatedJob");
  assert.equal(updatedJobPayload.job.id, savedJobPayload.job.id);
  assert.equal(updatedJobPayload.job.localPath, "D:\\Work Updated");
  assert.equal(updatedJobPayload.job.remoteFolder, "projects");
  assert.equal(updatedJobPayload.job.serverSpace, "device");
  assert.equal(updatedJobPayload.job.remotePrefix, "devices-v2/company-pc1/projects");
  assert.equal(updatedJobPayload.job.checkers, 12);
  assert.equal(updatedJobPayload.job.dryRun, true);
  assert.equal(updatedJobPayload.job.localProxyPort, 18083);
  const jobsAfterUpdate = await (await fetch(`${baseUrl}/api/jobs`)).json();
  assertClientJobsReadContract(jobsAfterUpdate, "jobsAfterUpdate");
  assert.equal(jobsAfterUpdate.jobs.length, 2);
  assert.equal(jobsAfterUpdate.jobs.filter((job) => job.id === savedJobPayload.job.id).length, 1);

  const bidirectionalJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        id: "job-bisync",
        localPath: "D:\\Mirror",
        direction: "bidirectional",
        destructiveSync: true
      }
    })
  });
  const bidirectionalJobPayload = await bidirectionalJob.json();
  assert.equal(bidirectionalJob.status, 200, `${JSON.stringify(bidirectionalJobPayload)}\n${childStderr}`);
  assertClientJobSaveResponseContract(bidirectionalJobPayload, "bidirectionalJob");
  assert.equal(bidirectionalJobPayload.job.direction, "bidirectional");
  assert.equal(bidirectionalJobPayload.job.destructiveSync, false);

  const bidirectionalPreview = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\Mirror",
        direction: "bidirectional",
        destructiveSync: true
      }
    })
  });
  assert.equal(bidirectionalPreview.status, 200);
  const bidirectionalPreviewPayload = await bidirectionalPreview.json();
  assertSyncPreviewContract(bidirectionalPreviewPayload, "bidirectionalPreview", {
    rawSecrets: ["top-secret-value-v2"],
    remoteConfigSecret: "top-secret-value-v2"
  });
  assert.equal(bidirectionalPreviewPayload.rclone.args[0], "bisync");
  assert.equal(bidirectionalPreviewPayload.rclone.safety.deleteProtection, true);
  // The refreshed profile renamed the remote to home-minio-v2, so the env key follows it.
  assert.equal(bidirectionalPreviewPayload.rclone.remoteConfig.env.RCLONE_CONFIG_HOME_MINIO_V2_SECRET_ACCESS_KEY, "top-secret-value-v2");
  assert.equal(bidirectionalPreviewPayload.rclone.remoteConfig.args.includes("top-secret-value-v2"), false);
  assert.equal(bidirectionalPreviewPayload.rclone.remoteConfig.args.includes("top-secret-value"), false);
  assert.equal(bidirectionalPreviewPayload.rclone.remoteConfig.displayCommand.includes("top-secret-value-v2"), false);

  await writeFile(join(tempRoot, "data", "sync-history.json"), JSON.stringify([
    {
      id: "history-safe",
      status: "success",
      startedAt: "2026-07-04T08:00:00.000Z",
      finishedAt: "2026-07-04T08:05:00.000Z",
      progressPercent: 150,
      job: {
        name: "safe job",
        direction: "download",
        remotePrefix: "devices/company-pc1",
        remoteFolder: "reports"
      },
      conflicts: { count: 1, files: ["projects\\conflict.txt"] },
      extensionField: "preserved",
      secretAccessKey: "raw-history-secret",
      debug: {
        tKey: "SFSC1-history-secret"
      }
    },
    "not-a-history-record",
    {
      id: "history-dirty-paths",
      status: "surprising",
      startedAt: "not-a-date",
      errorCode: "not stable",
      job: {
        name: "dirty job",
        direction: "upload",
        remotePrefix: "C:\\absolute",
        remoteFolder: "../escape"
      },
      conflictCount: 2,
      conflictFiles: ["bad\\name.txt"]
    }
  ], null, 2), "utf8");
  const normalizedHistory = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assert.equal(normalizedHistory.history.length, 2);
  assert.equal(normalizedHistory.history[0].id, "history-safe");
  assert.equal(normalizedHistory.history[0].extensionField, undefined);
  assert.equal(normalizedHistory.history[0].secretAccessKey, undefined);
  assert.equal(normalizedHistory.history[0].debug, undefined);
  assert.equal(normalizedHistory.history[0].progressPercent, 100);
  assert.equal(normalizedHistory.history[0].conflicts.count, 0);
  assert.deepEqual(normalizedHistory.history[0].conflicts.files, []);
  assert.equal(normalizedHistory.history[1].id, "history-dirty-paths");
  assert.equal(normalizedHistory.history[1].status, "unknown");
  assert.equal(normalizedHistory.history[1].startedAt, null);
  assert.equal(normalizedHistory.history[1].errorCode, "");
  assert.equal(normalizedHistory.history[1].job.remotePrefix, "");
  assert.equal(normalizedHistory.history[1].job.remoteFolder, "");
  assert.deepEqual(normalizedHistory.history[1].conflicts.files, []);
  assert.equal(JSON.stringify(normalizedHistory).includes("raw-history-secret"), false);
  assert.equal(JSON.stringify(normalizedHistory).includes("SFSC1-"), false);
  const statusAfterNormalizedHistory = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.deepEqual(statusAfterNormalizedHistory.syncHistory, normalizedHistory.history);
  assert.equal(JSON.stringify(statusAfterNormalizedHistory.syncHistory).includes("raw-history-secret"), false);
  assert.equal(JSON.stringify(statusAfterNormalizedHistory.syncHistory).includes("SFSC1-"), false);
  assert.equal(statusAfterNormalizedHistory.lastSync.id, "history-safe");

  const historyBeforePreStartFailures = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  const syncHistoryFile = join(tempRoot, "data", "sync-history.json");
  const rcloneConfigFile = join(tempRoot, "data", "runtime", "rclone.conf");
  assert.equal(await pathExists(rcloneConfigFile), false);
  await writeFile(syncHistoryFile, "{ bad history", "utf8");
  const corruptHistoryRun = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(corruptHistoryRun.status, 409);
  assertHttpErrorResponseContract(await corruptHistoryRun.json(), "corruptHistoryRun", {
    errorCode: "local_state_corrupt"
  });
  assert.equal(await readFile(syncHistoryFile, "utf8"), "{ bad history");
  assert.equal(await pathExists(rcloneConfigFile), false);
  const statusAfterCorruptHistoryRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterCorruptHistoryRun.processes.singbox.running, false);
  assert.equal(statusAfterCorruptHistoryRun.processes.sync.running, false);
  assert.equal(statusAfterCorruptHistoryRun.processes.sync.metrics.syncState, "idle");
  await writeFile(syncHistoryFile, JSON.stringify(historyBeforePreStartFailures.history, null, 2), "utf8");

  await rm(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), { force: true });

  const missingRclonePreview = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(missingRclonePreview.status, 503);
  assertHttpErrorResponseContract(await missingRclonePreview.json(), "missingRclonePreview", {
    errorCode: "missing_rclone_binary"
  });

  const missingRclone = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(missingRclone.status, 503);
  const missingRclonePayload = await missingRclone.json();
  assertHttpErrorResponseContract(missingRclonePayload, "missingRcloneRun", {
    errorCode: "missing_rclone_binary"
  });
  const historyAfterPreStartFailures = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assert.deepEqual(historyAfterPreStartFailures.history, historyBeforePreStartFailures.history);

  const profileBeforeCorruptStateImport = await readFile(join(tempRoot, "data", "profile.json"), "utf8");
  await writeFile(join(tempRoot, "data", "jobs.json"), "{ bad jobs", "utf8");
  await writeFile(join(tempRoot, "data", "claim-recovery.json"), "{ bad claim recovery", "utf8");
  const corruptStateStatus = await fetch(`${baseUrl}/api/client/status`);
  assert.equal(corruptStateStatus.status, 200);
  const corruptStatePayload = await corruptStateStatus.json();
  assertClientStatusContract(corruptStatePayload, "corruptStateStatus");
  assert.equal(corruptStatePayload.safeguards.localState.ok, false);
  assert.equal(corruptStatePayload.safeguards.secretVault.ok, false);
  assert.equal(corruptStatePayload.safeguards.secretVault.protected, false);
  assert.equal(corruptStatePayload.safeguards.secretVault.protection.protected, false);
  assert.equal(typeof corruptStatePayload.safeguards.secretVault.protection.mode, "string");
  assert.equal(
    corruptStatePayload.safeguards.localState.files.find((file) => file.name === "jobs").errorCode,
    "local_state_corrupt"
  );
  assert.equal(
    corruptStatePayload.safeguards.localState.files.find((file) => file.name === "claimRecovery").errorCode,
    "local_state_corrupt"
  );
  assert.equal(corruptStatePayload.jobs.length, 0);
  const corruptStateDiagnosticExport = await fetch(`${baseUrl}/api/diagnostics/export`);
  assert.equal(corruptStateDiagnosticExport.status, 200);
  const corruptStateDiagnosticPayload = await corruptStateDiagnosticExport.json();
  assertDiagnosticExportContract(corruptStateDiagnosticPayload, "corruptStateDiagnosticExport", {
    rawSecrets: ["top-secret-value-v2"]
  });
  assert.equal(corruptStateDiagnosticPayload.ok, true);
  assert.equal(corruptStateDiagnosticPayload.bundle.summary.localStateOk, false);
  assert.equal(
    corruptStateDiagnosticPayload.bundle.summary.localStateErrors.find((file) => file.name === "jobs").errorCode,
    "local_state_corrupt"
  );
  assert.equal(
    corruptStateDiagnosticPayload.bundle.summary.localStateErrors.find((file) => file.name === "claimRecovery").errorCode,
    "local_state_corrupt"
  );
  assert.equal(corruptStateDiagnosticPayload.bundle.status.jobs.length, 0);

  const corruptStateSave = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(corruptStateSave.status, 409);
  assertHttpErrorResponseContract(await corruptStateSave.json(), "corruptStateSave", {
    errorCode: "local_state_corrupt"
  });

  await writeFile(join(tempRoot, "data", "jobs.json"), "[]", "utf8");
  await writeFile(join(tempRoot, "data", "sync-history.json"), "{ bad history", "utf8");
  const corruptHistorySave = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\Work" } })
  });
  assert.equal(corruptHistorySave.status, 409);
  assertHttpErrorResponseContract(await corruptHistorySave.json(), "corruptHistorySave", {
    errorCode: "local_state_corrupt"
  });
  await writeFile(join(tempRoot, "data", "sync-history.json"), "[]", "utf8");
  await writeFile(join(tempRoot, "data", "jobs.json"), "{ bad jobs", "utf8");

  const corruptStateImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "company-pc1",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "should-not-write",
          endpoint: "http://minio-bad:9000",
          bucket: "should-not-write",
          accessKeyId: "bad",
          secretAccessKey: "should-not-write-secret",
          prefix: "devices/bad"
        }
      })}`
    })
  });
  assert.equal(corruptStateImport.status, 409);
  assertHttpErrorResponseContract(await corruptStateImport.json(), "corruptStateImport", {
    errorCode: "local_state_corrupt"
  });
  assert.equal(await readFile(join(tempRoot, "data", "profile.json"), "utf8"), profileBeforeCorruptStateImport);

  const stateBeforeShutdown = await readClientStateFiles(tempRoot);
  const shutdown = await fetch(`${baseUrl}/api/client/shutdown`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(shutdown.status, 200);
  assertClientShutdownResponseContract(await shutdown.json(), "clientShutdown");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("client did not exit after shutdown")), 3000))
  ]);
  assert.deepEqual(await readClientStateFiles(tempRoot), stateBeforeShutdown);
});

test("client local HTTP API checks fake binaries and starts sing-box", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-success-path-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");
  const singboxConfigFile = join(tempRoot, "data", "runtime", "sing-box-client.json");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: tempRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const binaryCheck = await fetch(`${baseUrl}/api/binaries/check`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(binaryCheck.status, 200);
  const binaryCheckPayload = await binaryCheck.json();
  assertClientBinariesCheckContract(binaryCheckPayload, "successfulBinaryCheck");
  assert.equal(binaryCheckPayload.ok, true);
  assert.equal(binaryCheckPayload.singbox.ok, true);
  assert.equal(binaryCheckPayload.singbox.errorCode, "");
  assert.match(binaryCheckPayload.singbox.version.stdout, /sing-box version 1\.13\.14/);
  assert.deepEqual(binaryCheckPayload.singbox.version.args, ["version"]);
  assert.equal(binaryCheckPayload.rclone.ok, true);
  assert.equal(binaryCheckPayload.rclone.errorCode, "");
  assert.match(binaryCheckPayload.rclone.version.stdout, /rclone v1\.74\.3/);
  assert.deepEqual(binaryCheckPayload.rclone.version.args, ["version"]);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "singbox-success-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "singbox-success-pc",
          secretAccessKey: "singbox-success-secret",
          prefix: "devices/singbox-success-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);
  assertClientProfileImportResponseContract(await profileImport.json(), "successfulSingboxProfileImport");

  const startSingbox = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(startSingbox.status, 200);
  const startSingboxPayload = await startSingbox.json();
  assertClientSingboxProcessResponseContract(startSingboxPayload, "startedSingbox");
  assert.equal(startSingboxPayload.singbox.name, "sing-box");
  assert.equal(startSingboxPayload.singbox.running, true);
  assert.equal(Number.isInteger(startSingboxPayload.singbox.pid), true);
  assert.equal(typeof startSingboxPayload.singbox.startedAt, "string");
  assert.equal(startSingboxPayload.singbox.lastExit, null);

  const fakeToolEvents = await waitForFakeToolEvent(fakeToolLog, "singbox-run");
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-version").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-version").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-check").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-run").length, 1);
  assert.ok(
    fakeToolEvents.findIndex((event) => event.tool === "singbox-check")
      < fakeToolEvents.findIndex((event) => event.tool === "singbox-run")
  );

  const singboxConfig = JSON.parse(await readFile(singboxConfigFile, "utf8"));
  assert.equal(singboxConfig.inbounds[0].listen, "127.0.0.1");
  assert.equal(singboxConfig.inbounds[0].listen_port, 18082);
  assert.equal(singboxConfig.outbounds[0].server, "pass.971223.xyz");
  assert.equal(singboxConfig.outbounds[0].server_port, 45678);
  assert.equal(JSON.stringify(singboxConfig).includes("override.example.invalid"), false);
  assert.equal(JSON.stringify(singboxConfig).includes("19091"), false);
});

test("client sing-box start checks config before running the tunnel process", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-singbox-check-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: tempRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SINGBOX_CHECK_EXIT_CODE: "23"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "singbox-check-fail-pc",
        tunnel: { type: "vless", uri: tunnelUri },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "singbox-check-fail-pc",
          secretAccessKey: "singbox-check-secret",
          prefix: "devices/singbox-check-fail-pc"
        },
        defaults: { localProxyPort: 18083 }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const startSingbox = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(startSingbox.status, 500);
  assertHttpErrorResponseContract(await startSingbox.json(), "singboxCheckFailed", {
    errorCode: "singbox_start_failed"
  });

  const fakeToolEvents = await waitForFakeToolEvent(fakeToolLog, "singbox-check");
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-check").length, 1);
  assert.equal(fakeToolEvents.some((event) => event.tool === "singbox-run"), false);
});

test("client sync stop waits for rclone exit and records user stop", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-sync-stop-wait-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "10000",
      SFSC_FAKE_SYNC_STOP_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_STOP_DELAY_MS: "150"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "sync-stop-pc",
        tunnel: { type: "vless", uri: tunnelUri },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "sync-stop-pc",
          secretAccessKey: "sync-stop-secret",
          prefix: "devices/sync-stop-pc"
        },
        defaults: { localProxyPort: 18084 }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const runSyncResponse = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\SyncStop",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(runSyncResponse.status, 200);
  assertClientSyncRunResponseContract(await runSyncResponse.json(), "syncStop.started");
  await waitForSyncRunning(baseUrl);
  await waitForFakeToolEvent(fakeToolLog, "rclone-sync");

  const stopResponse = await fetch(`${baseUrl}/api/sync/stop`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(stopResponse.status, 200);
  const stopPayload = await stopResponse.json();
  assertClientSyncRunResponseContract(stopPayload, "syncStop.stopped");
  assert.equal(stopPayload.sync.name, "rclone-sync");
  assert.equal(stopPayload.sync.running, false);
  assert.equal(stopPayload.sync.stopTimedOut, false);
  assert.equal(stopPayload.sync.stopSignal, "SIGTERM");

  const history = await waitForSyncHistoryStatus(baseUrl, "stopped");
  assert.equal(history.history[0].errorCode, "");
  assert.equal(history.history[0].error, "");
  assert.equal(JSON.stringify(history.history[0]).includes("rclone_sync_failed"), false);

  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  assert.equal(fakeToolEvents.some((event) => event.tool === "rclone-sync"), true);
});

test("client scheduler records secret vault failures without starting sync", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-scheduler-vault-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(join(tempRoot, "resources", "bin", "win32"), { recursive: true });
  await writeFile(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), "placeholder");
  await writeFile(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), "placeholder");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "100"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "scheduled-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "scheduled-pc",
          secretAccessKey: "scheduler-secret-value",
          prefix: "devices/scheduled-pc"
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const savedStartupJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\Scheduled",
        direction: "upload",
        schedule: { mode: "startup" }
      }
    })
  });
  assert.equal(savedStartupJob.status, 200);
  const savedStartupJobPayload = await savedStartupJob.json();
  assertClientJobSaveResponseContract(savedStartupJobPayload, "savedStartupJob");
  assert.equal(savedStartupJobPayload.scheduler.jobs[0].nextRun, "on-startup");

  await rm(join(tempRoot, "data", "secrets.json"), { force: true });

  const status = await waitForSchedulerError(baseUrl, "secret_vault_missing");
  assert.equal(status.scheduler.lastError, "secret_vault_missing");
  assert.equal(status.scheduler.jobs[0].lastError, "secret_vault_missing");
  assert.equal(status.scheduler.jobs[0].lastTriggeredAt !== null, true);
  assert.equal(status.processes.sync.running, false);
  assert.equal(status.processes.sync.metrics.syncState, "idle");
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "rclone.conf")), false);
  const history = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assert.deepEqual(history.history, []);
});

test("client sync endpoints refuse partial secret vault misses before starting binaries", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-partial-vault-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(join(tempRoot, "resources", "bin", "win32"), { recursive: true });
  await writeFile(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), "placeholder");
  await writeFile(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), "placeholder");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "partial-vault-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "partial-vault-pc",
          secretAccessKey: "partial-vault-secret",
          prefix: "devices/partial-vault-pc"
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const savedJob = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\PartialVault",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(savedJob.status, 200);
  assertClientJobSaveResponseContract(await savedJob.clone().json(), "partialVault.savedJob");

  const jobsFile = join(tempRoot, "data", "jobs.json");
  const secretsFile = join(tempRoot, "data", "secrets.json");
  const jobsBeforeMissingRef = await readFile(jobsFile, "utf8");
  const storedJobs = JSON.parse(jobsBeforeMissingRef);
  const missingJobSecretRef = storedJobs[0]?.secretAccessKey?.secretRef;
  assert.equal(typeof missingJobSecretRef, "string");
  const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  delete secrets[missingJobSecretRef];
  await writeFile(secretsFile, JSON.stringify(secrets, null, 2), "utf8");

  const vaultStatus = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(vaultStatus.safeguards.secretVault.ok, false);
  assert.equal(vaultStatus.safeguards.secretVault.protected, true);
  assert.equal(vaultStatus.safeguards.secretVault.missingRefs.length, 1);
  assert.equal(vaultStatus.safeguards.secretVault.missingRefs.includes(missingJobSecretRef), false);
  assert.equal(vaultStatus.safeguards.secretVault.missingRefs[0], "redacted");
  assert.equal(JSON.stringify(vaultStatus).includes(missingJobSecretRef), false);

  const startSingbox = await fetch(`${baseUrl}/api/singbox/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(startSingbox.status, 409);
  assertHttpErrorResponseContract(await startSingbox.json(), "partialVaultStartSingbox", {
    errorCode: "secret_vault_missing"
  });
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "sing-box-client.json")), false);

  const preview = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\PartialVault", direction: "upload" } })
  });
  assert.equal(preview.status, 409);
  assertHttpErrorResponseContract(await preview.json(), "partialVaultPreview", {
    errorCode: "secret_vault_missing"
  });

  const save = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        id: "partial-vault-should-not-save",
        localPath: "D:\\ShouldNotSave",
        direction: "download"
      }
    })
  });
  assert.equal(save.status, 409);
  assertHttpErrorResponseContract(await save.json(), "partialVaultSave", {
    errorCode: "secret_vault_missing"
  });
  assert.equal(await readFile(jobsFile, "utf8"), jobsBeforeMissingRef);

  const rcloneConfigFile = join(tempRoot, "data", "runtime", "rclone.conf");
  assert.equal(await pathExists(rcloneConfigFile), false);
  const historyBeforeRun = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  assertClientSyncHistoryContract(historyBeforeRun, "historyBeforeRun");
  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: { localPath: "D:\\PartialVault", direction: "upload" } })
  });
  assert.equal(run.status, 409);
  assertHttpErrorResponseContract(await run.json(), "partialVaultRun", {
    errorCode: "secret_vault_missing"
  });
  assert.deepEqual((await (await fetch(`${baseUrl}/api/sync/history`)).json()).history, historyBeforeRun.history);
  assert.equal(await pathExists(rcloneConfigFile), false);
  const statusAfterRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterRun.processes.singbox.running, false);
  assert.equal(statusAfterRun.processes.sync.running, false);
  assert.equal(statusAfterRun.processes.sync.metrics.syncState, "idle");
});

test("client sync run refuses missing sing-box before writing rclone config", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-missing-singbox-sync-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);
  await rm(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), { force: true });

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "missing-singbox-sync-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "missing-singbox-sync-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/missing-singbox-sync-pc"
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const historyBeforeRun = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  const rcloneConfigFile = join(tempRoot, "data", "runtime", "rclone.conf");
  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\MissingSingbox",
        direction: "upload"
      }
    })
  });
  assert.equal(run.status, 503);
  assertHttpErrorResponseContract(await run.json(), "missingSingboxSyncRun", {
    errorCode: "missing_singbox_binary"
  });
  assert.equal(await pathExists(rcloneConfigFile), false);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/sync/history`)).json()).history, historyBeforeRun.history);

  const statusAfterRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterRun.processes.singbox.running, false);
  assert.equal(statusAfterRun.processes.sync.running, false);
  assert.equal(statusAfterRun.processes.sync.metrics.syncState, "idle");
  const fakeToolEvents = await readFakeToolEvents(fakeToolLog).catch(() => []);
  assert.equal(fakeToolEvents.some((event) => event.tool === "singbox-run"), false);
  assert.equal(fakeToolEvents.some((event) => event.tool === "rclone-config"), false);
  assert.equal(fakeToolEvents.some((event) => event.tool === "rclone-sync"), false);
});

test("client sync run fails rclone config before starting sing-box or history", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-rclone-config-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const rawSecret = "execution-secret-value";
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_CONFIG_EXIT_CODE: "23",
      SFSC_FAKE_CONFIG_STDERR_SECRET: "1",
      SFSC_FAKE_CONFIG_STDOUT_SECRET: "1",
      SFSC_FAKE_CONFIG_SKIP_WRITE: "1",
      SFSC_FAKE_RAW_SECRET: rawSecret,
      SFSC_FAKE_TUNNEL_URI: tunnelUri
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "config-fail-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "config-fail-pc",
          secretAccessKey: rawSecret,
          prefix: "devices/config-fail-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const historyBeforeRun = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  const rcloneConfigFile = join(tempRoot, "data", "runtime", "rclone.conf");
  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\ConfigFail",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(run.status, 500);
  const runPayload = await run.json();
  assertHttpErrorResponseContract(runPayload, "configFailRun", {
    errorCode: "rclone_config_failed"
  });
  assert.equal(JSON.stringify(runPayload).includes(rawSecret), false);
  assert.equal(JSON.stringify(runPayload).includes(tunnelUri), false);
  assert.match(runPayload.message, /bare-secret \*\*\*\*/);
  assert.match(runPayload.message, /stdout-secret \*\*\*\*/);

  assert.equal(await pathExists(rcloneConfigFile), false);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/sync/history`)).json()).history, historyBeforeRun.history);

  const statusAfterRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterRun.processes.singbox.running, false);
  assert.equal(statusAfterRun.processes.sync.running, false);
  assert.equal(statusAfterRun.processes.sync.metrics.syncState, "idle");

  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-config").length, 1);
  assert.equal(fakeToolEvents.some((event) => event.tool === "singbox-run"), false);
  assert.equal(fakeToolEvents.some((event) => event.tool === "rclone-sync"), false);
});

test("client sync run uses real rclone config secret while redacting execution logs", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-fake-rclone-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const rawSecret = "execution-secret-value";
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_RAW_SECRET: rawSecret,
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "100"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "fake-rclone-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "fake-rclone-pc",
          secretAccessKey: rawSecret,
          prefix: "devices/fake-rclone-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...maliciousProfileDerivedJobFields(),
        localPath: "D:\\FakeRclone",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(run.status, 200);
  const runPayload = await run.json();
  assertClientSyncRunResponseContract(runPayload, "run");
  assert.equal(runPayload.sync.name, "rclone-sync");
  assert.equal(runPayload.sync.running, true);

  const history = await waitForSyncHistoryStatus(baseUrl, "error");
  assert.equal(history.history[0].trigger, "manual");
  assert.equal(history.history[0].errorCode, "rclone_sync_failed");
  assert.equal(history.history[0].exitCode, 7);
  assert.match(history.history[0].error, /rclone exited with code 7/);

  const fakeToolLogText = await readFile(fakeToolLog, "utf8");
  assert.equal(fakeToolLogText.includes(rawSecret), true);
  const fakeToolEvents = fakeToolLogText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const configEvent = fakeToolEvents.find((event) => event.tool === "rclone-config");
  const syncEvent = fakeToolEvents.find((event) => event.tool === "rclone-sync");
  assert.ok(configEvent);
  assert.ok(syncEvent);
  assert.equal(configEvent.argv.includes("secret_access_key"), false);
  assert.equal(configEvent.argv.includes(rawSecret), false);
  assert.equal(configEvent.secretEnv, rawSecret);
  assert.equal(configEvent.argv.includes("evil-secret-value"), false);
  assert.equal(configEvent.argv.includes("evil-s3-secret-value"), false);
  assert.equal(configEvent.argv.includes("http://minio:9000"), true);
  assert.equal(configEvent.argv.includes("http://evil-minio.invalid:9000"), false);
  assert.equal(syncEvent.allProxy, "socks5://127.0.0.1:18082");
  assert.equal(syncEvent.argv.some((arg) => String(arg).includes("home-minio:home-sync/devices/fake-rclone-pc/projects")), true);
  assert.equal(syncEvent.argv.some((arg) => String(arg).includes("evil-minio")), false);

  const logs = await (await fetch(`${baseUrl}/api/logs`)).json();
  assertClientLogsContract(logs, "fakeRcloneLogs", { rawSecrets: [rawSecret] });
  assert.equal(logs.rclone.includes(rawSecret), false);
  assert.match(logs.rclone, /secret_access_key \*\*\*\*/);
  assert.match(logs.rclone, /S3_SECRET_ACCESS_KEY=\*\*\*\*/);
  assert.match(logs.rclone, /"secretAccessKey":"\*\*\*\*"/);

  const diagnostics = await (await fetch(`${baseUrl}/api/diagnostics/export`)).json();
  assertDiagnosticExportContract(diagnostics, "fakeRcloneDiagnostics", {
    rawSecrets: [rawSecret, tunnelUri]
  });
  assert.equal(JSON.stringify(diagnostics.bundle).includes(rawSecret), false);
  assert.equal(diagnostics.bundle.logs.rclone.text.includes(rawSecret), false);
});

test("client records a bisync conflict split across real process output chunks", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-chunked-conflict-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_CHUNKED_CONFLICT: "1",
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "150"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "chunked-conflict-pc",
        tunnel: { type: "vless", uri: tunnelUri },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "chunked-conflict-pc",
          secretAccessKey: "chunked-conflict-secret",
          prefix: "devices/chunked-conflict-pc"
        },
        defaults: { localProxyPort: 18082 }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\ChunkedConflict",
        direction: "bidirectional",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(run.status, 200);
  assertClientSyncRunResponseContract(await run.json(), "chunkedConflictRun");

  const history = await waitForSyncHistoryStatus(baseUrl, "success");
  assert.equal(history.history[0].conflicts.count, 1);
  assert.deepEqual(history.history[0].conflicts.files, ["projects/chunked.txt"]);
  assert.equal(history.history[0].conflicts.truncated, false);

  const status = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(status.lastSync.conflicts.count, 1);
  assert.deepEqual(status.lastSync.conflicts.files, ["projects/chunked.txt"]);
});

test("client sync run does not write history when rclone sync spawn fails after config", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-rclone-spawn-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_REMOVE_RCLONE_AFTER_CONFIG: "1"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const profileImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "spawn-fail-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "spawn-fail-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/spawn-fail-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(profileImport.status, 200);

  const historyBeforeRun = await (await fetch(`${baseUrl}/api/sync/history`)).json();
  const rcloneConfigFile = join(tempRoot, "data", "runtime", "rclone.conf");

  const run = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\SpawnFail",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  assert.equal(run.status, 500);
  assertHttpErrorResponseContract(await run.json(), "spawnFailRun", {
    errorCode: "rclone_sync_failed"
  });
  assert.equal(await pathExists(rcloneConfigFile), true);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/sync/history`)).json()).history, historyBeforeRun.history);

  const statusAfterRun = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assert.equal(statusAfterRun.processes.sync.running, false);
  assert.equal(statusAfterRun.processes.sync.metrics.syncState, "idle");

  const fakeToolEvents = (await readFile(fakeToolLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(fakeToolEvents.find((event) => event.tool === "rclone-config"));
  assert.ok(fakeToolEvents.find((event) => event.tool === "rclone-exe-renamed"));
  assert.equal(fakeToolEvents.some((event) => event.tool === "rclone-sync"), false);
});

test("client scheduler runs a saved startup sync after restart with fake binaries", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-scheduler-success-"));
  const firstPort = await getFreePort();
  const firstBaseUrl = `http://127.0.0.1:${firstPort}`;
  const secondPort = await getFreePort();
  const secondBaseUrl = `http://127.0.0.1:${secondPort}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");
  let firstChild = null;
  let secondChild = null;

  await installFakeSyncTools(tempRoot);

  t.after(async () => {
    await shutdownClient(firstBaseUrl, firstChild);
    await shutdownClient(secondBaseUrl, secondChild);
    await removeTempRoot(tempRoot);
  });

  firstChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(firstPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "500"
    }
  });
  await waitForClient(firstBaseUrl, firstChild, tempRoot);

  const importResponse = await fetch(`${firstBaseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "scheduler-success-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "scheduler-success-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/scheduler-success-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const savedStartupJob = await fetch(`${firstBaseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\SchedulerSuccess",
        direction: "upload",
        remoteFolder: "projects",
        schedule: { mode: "startup" }
      }
    })
  });
  assert.equal(savedStartupJob.status, 200);
  const savedStartupJobPayload = await savedStartupJob.json();
  assertClientJobSaveResponseContract(savedStartupJobPayload, "schedulerSuccess.savedStartupJob");
  assert.equal(savedStartupJobPayload.scheduler.jobs[0].nextRun, "on-startup");
  assert.equal(savedStartupJobPayload.scheduler.jobs[0].lastTriggeredAt, null);

  const firstShutdown = await fetch(`${firstBaseUrl}/api/client/shutdown`, { method: "POST" });
  assert.equal(firstShutdown.status, 200);
  await Promise.race([
    once(firstChild, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("first client did not exit")), 3000))
  ]);

  secondChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(secondPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "50",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "500"
    }
  });
  await waitForClient(secondBaseUrl, secondChild, tempRoot);
  await waitForSyncRunning(secondBaseUrl);
  const history = await waitForSyncHistoryStatus(secondBaseUrl, "success");
  assert.equal(history.history[0].trigger, "scheduler");
  assert.equal(history.history[0].exitCode, 0);
  assert.equal(history.history[0].errorCode, "");

  const status = await (await fetch(`${secondBaseUrl}/api/client/status`)).json();
  assert.equal(status.scheduler.lastError, "");
  assert.equal(status.scheduler.jobs.length, 1);
  assert.equal(status.scheduler.jobs[0].schedule.mode, "startup");
  assert.equal(status.scheduler.jobs[0].nextRun, null);
  assert.equal(typeof status.scheduler.lastTriggeredAt, "string");
  assert.equal(typeof status.scheduler.jobs[0].lastTriggeredAt, "string");
  assert.equal(status.scheduler.jobs[0].lastError, "");
  assert.equal(await pathExists(join(tempRoot, "data", "runtime", "rclone.conf")), true);

  const fakeToolEvents = (await readFile(fakeToolLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-run").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-config").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-sync").length, 1);
});

test("client scheduler sync run aligns legacy job proxy port with profile defaults", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-scheduler-proxy-port-"));
  const firstPort = await getFreePort();
  const firstBaseUrl = `http://127.0.0.1:${firstPort}`;
  const secondPort = await getFreePort();
  const secondBaseUrl = `http://127.0.0.1:${secondPort}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");
  const jobsFile = join(tempRoot, "data", "jobs.json");
  const singboxConfigFile = join(tempRoot, "data", "runtime", "sing-box-client.json");
  let firstChild = null;
  let secondChild = null;

  await installFakeSyncTools(tempRoot);

  t.after(async () => {
    await shutdownClient(firstBaseUrl, firstChild);
    await shutdownClient(secondBaseUrl, secondChild);
    await removeTempRoot(tempRoot);
  });

  firstChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(firstPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "500"
    }
  });
  await waitForClient(firstBaseUrl, firstChild, tempRoot);

  const importResponse = await fetch(`${firstBaseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "scheduler-proxy-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "scheduler-proxy-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/scheduler-proxy-pc"
        },
        defaults: {
          localProxyPort: 18092
        }
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const savedStartupJob = await fetch(`${firstBaseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\SchedulerProxyPort",
        direction: "upload",
        remoteFolder: "projects",
        schedule: { mode: "startup" }
      }
    })
  });
  assert.equal(savedStartupJob.status, 200);
  const savedStartupJobPayload = await savedStartupJob.json();
  assertClientJobSaveResponseContract(savedStartupJobPayload, "schedulerProxyPort.savedStartupJob");
  assert.equal(savedStartupJobPayload.job.localProxyPort, 18092);

  const firstShutdown = await fetch(`${firstBaseUrl}/api/client/shutdown`, { method: "POST" });
  assert.equal(firstShutdown.status, 200);
  await Promise.race([
    once(firstChild, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("first proxy-port client did not exit")), 3000))
  ]);

  const storedJobs = JSON.parse(await readFile(jobsFile, "utf8"));
  delete storedJobs[0].localProxyPort;
  await writeFile(jobsFile, JSON.stringify(storedJobs, null, 2), "utf8");

  secondChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(secondPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "50",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "500"
    }
  });
  await waitForClient(secondBaseUrl, secondChild, tempRoot);
  await waitForSyncHistoryStatus(secondBaseUrl, "success");

  const fakeToolEvents = (await readFakeToolEvents(fakeToolLog));
  const syncEvent = fakeToolEvents.find((event) => event.tool === "rclone-sync");
  assert.ok(syncEvent);
  assert.equal(syncEvent.allProxy, "socks5://127.0.0.1:18092");

  const singboxConfig = JSON.parse(await readFile(singboxConfigFile, "utf8"));
  assert.equal(singboxConfig.inbounds[0].listen, "127.0.0.1");
  assert.equal(singboxConfig.inbounds[0].listen_port, 18092);
});

test("client sync run uses one profile snapshot for rclone and sing-box", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-sync-run-snapshot-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");
  const singboxConfigFile = join(tempRoot, "data", "runtime", "sing-box-client.json");
  const replacementTunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@replacement.example.invalid:45679?encryption=none&security=none&type=tcp#replacement";

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_CONFIG_DELAY_MS: "1500",
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "10000"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importInitialProfile = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "snapshot-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "snapshot-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/snapshot-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(importInitialProfile.status, 200);

  const run = fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        localPath: "D:\\Snapshot",
        direction: "upload",
        remoteFolder: "projects"
      }
    })
  });
  await waitForFakeToolEvent(fakeToolLog, "rclone-config");

  const importReplacementProfile = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "snapshot-pc",
        tunnel: {
          type: "vless",
          uri: replacementTunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "snapshot-pc",
          secretAccessKey: "replacement-secret",
          prefix: "devices/snapshot-pc-replacement"
        },
        defaults: {
          localProxyPort: 18093
        }
      })}`
    })
  });
  assert.equal(importReplacementProfile.status, 200);

  const runResponse = await run;
  assert.equal(runResponse.status, 200);
  const runPayload = await runResponse.json();
  assertClientSyncRunResponseContract(runPayload, "snapshotRun");
  assert.equal(runPayload.sync.running, true);
  await waitForFakeToolEvent(fakeToolLog, "rclone-sync");

  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  const syncEvent = fakeToolEvents.find((event) => event.tool === "rclone-sync");
  assert.ok(syncEvent);
  assert.equal(syncEvent.allProxy, "socks5://127.0.0.1:18082");

  const singboxConfig = JSON.parse(await readFile(singboxConfigFile, "utf8"));
  assert.equal(singboxConfig.inbounds[0].listen_port, 18082);
  assert.equal(singboxConfig.outbounds[0].server, "pass.971223.xyz");
  assert.equal(singboxConfig.outbounds[0].server_port, 45678);
  assert.equal(JSON.stringify(singboxConfig).includes("replacement.example.invalid"), false);
});

test("client sync run is single-flight while rclone config is starting", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-single-flight-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_CONFIG_DELAY_MS: "700",
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "300"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "single-flight-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "single-flight-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/single-flight-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const job = {
    localPath: "D:\\SingleFlight",
    direction: "upload",
    remoteFolder: "projects"
  };
  const firstRun = fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  await waitForFakeToolEvent(fakeToolLog, "rclone-config");
  const secondRun = fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  const conflictingRun = fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...job,
        localPath: "D:\\SingleFlightOther",
        remoteFolder: "other-projects"
      }
    })
  });

  const [firstRunResponse, secondRunResponse, conflictingRunResponse] = await Promise.all([firstRun, secondRun, conflictingRun]);
  assert.equal(firstRunResponse.status, 200);
  assert.equal(secondRunResponse.status, 200);
  assert.equal(conflictingRunResponse.status, 409);
  const firstRunPayload = await firstRunResponse.json();
  const secondRunPayload = await secondRunResponse.json();
  const conflictingRunPayload = await conflictingRunResponse.json();
  assertClientSyncRunResponseContract(firstRunPayload, "firstRun");
  assertClientSyncRunResponseContract(secondRunPayload, "secondRun");
  assertHttpErrorResponseContract(conflictingRunPayload, "conflictingRun", {
    errorCode: "sync_already_running"
  });
  assert.equal(firstRunPayload.sync.running, true);
  assert.equal(secondRunPayload.sync.running, true);
  assert.match(conflictingRunPayload.message, /already running/i);

  const history = await waitForSyncHistoryStatus(baseUrl, "success");
  assert.equal(history.history.length, 1);
  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-config").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-sync").length, 1);
});

test("client sync stop waits through delayed rclone exit before accepting a new run", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-stop-active-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");

  await installFakeSyncTools(tempRoot);

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "10000",
      SFSC_FAKE_SYNC_STOP_DELAY_MS: "700",
      SFSC_FAKE_SYNC_STOP_EXIT_CODE: "1"
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "stop-active-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "stop-active-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/stop-active-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const job = {
    localPath: "D:\\StopActive",
    direction: "upload",
    remoteFolder: "projects"
  };
  const runResponse = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(runResponse.status, 200);
  const runPayload = await runResponse.json();
  assertClientSyncRunResponseContract(runPayload, "stopActive.firstRun");
  assert.equal(runPayload.sync.running, true);
  await waitForFakeToolEvent(fakeToolLog, "rclone-sync");

  const runningStatus = await waitForSyncRunning(baseUrl);
  const firstPid = runningStatus.processes.sync.pid;
  assert.equal(Number.isInteger(firstPid), true);

  const conflictingRunResponse = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...job,
        localPath: "D:\\StopActiveOther",
        remoteFolder: "other-projects"
      }
    })
  });
  assert.equal(conflictingRunResponse.status, 409);
  assertHttpErrorResponseContract(await conflictingRunResponse.json(), "stopActive.conflictingRun", {
    errorCode: "sync_already_running"
  });

  const stopResponse = await fetch(`${baseUrl}/api/sync/stop`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(stopResponse.status, 200);
  const stopPayload = await stopResponse.json();
  assertClientSyncRunResponseContract(stopPayload, "stopActive.stop");
  assert.equal(stopPayload.sync.running, false);
  assert.equal(stopPayload.sync.pid, null);
  assert.equal(stopPayload.sync.stopTimedOut, false);
  assert.equal(stopPayload.sync.stopSignal, "SIGTERM");

  const history = await waitForSyncHistoryStatus(baseUrl, "stopped");
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].status, "stopped");
  assert.equal(history.history[0].errorCode, "");
  assert.equal(history.history[0].error, "");
  assert.equal(JSON.stringify(history.history[0]).includes("rclone_sync_failed"), false);

  const secondRunResponse = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(secondRunResponse.status, 200);
  const secondRunPayload = await secondRunResponse.json();
  assertClientSyncRunResponseContract(secondRunPayload, "stopActive.secondRunAfterStop");
  assert.equal(secondRunPayload.sync.running, true);
  assert.notEqual(secondRunPayload.sync.pid, firstPid);
  await waitForSyncRunning(baseUrl);

  const conflictingRunWhileStoppingResponse = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        ...job,
        localPath: "D:\\StopActiveAfterStop",
        remoteFolder: "after-stop-projects"
      }
    })
  });
  assert.equal(conflictingRunWhileStoppingResponse.status, 409);
  assertHttpErrorResponseContract(await conflictingRunWhileStoppingResponse.json(), "stopActive.conflictingRunWhileStopping", {
    errorCode: "sync_already_running"
  });

  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-config").length >= 1, true);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-sync").length >= 1, true);
});

test("client scheduler and manual sync run share single-flight while rclone config is starting", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-scheduler-manual-single-flight-"));
  const firstPort = await getFreePort();
  const firstBaseUrl = `http://127.0.0.1:${firstPort}`;
  const secondPort = await getFreePort();
  const secondBaseUrl = `http://127.0.0.1:${secondPort}`;
  const fakeToolLog = join(tempRoot, "fake-tools.jsonl");
  let firstChild = null;
  let secondChild = null;

  await installFakeSyncTools(tempRoot);

  t.after(async () => {
    await shutdownClient(firstBaseUrl, firstChild);
    await shutdownClient(secondBaseUrl, secondChild);
    await removeTempRoot(tempRoot);
  });

  firstChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(firstPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "60000",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "300"
    }
  });
  await waitForClient(firstBaseUrl, firstChild, tempRoot);

  const importResponse = await fetch(`${firstBaseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        clientName: "scheduler-manual-single-flight-pc",
        tunnel: {
          type: "vless",
          uri: tunnelUri
        },
        storage: {
          type: "s3",
          remoteName: "home-minio",
          endpoint: "http://minio:9000",
          bucket: "home-sync",
          accessKeyId: "scheduler-manual-single-flight-pc",
          secretAccessKey: "secret-for-test",
          prefix: "devices/scheduler-manual-single-flight-pc"
        },
        defaults: {
          localProxyPort: 18082
        }
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const startupJob = {
    localPath: "D:\\SchedulerManualSingleFlight",
    direction: "upload",
    remoteFolder: "projects",
    schedule: { mode: "startup" }
  };
  const savedStartupJob = await fetch(`${firstBaseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: startupJob })
  });
  assert.equal(savedStartupJob.status, 200);
  const savedStartupJobPayload = await savedStartupJob.json();
  assertClientJobSaveResponseContract(savedStartupJobPayload, "schedulerManualSingleFlight.savedStartupJob");

  const firstShutdown = await fetch(`${firstBaseUrl}/api/client/shutdown`, { method: "POST" });
  assert.equal(firstShutdown.status, 200);
  await Promise.race([
    once(firstChild, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("first client did not exit")), 3000))
  ]);

  secondChild = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(secondPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      SFSC_SCHEDULER_MS: "50",
      SFSC_FAKE_TOOL_LOG: fakeToolLog,
      SFSC_FAKE_CONFIG_DELAY_MS: "700",
      SFSC_FAKE_SYNC_EXIT_CODE: "0",
      SFSC_FAKE_SYNC_EXIT_DELAY_MS: "300"
    }
  });
  await waitForClient(secondBaseUrl, secondChild, tempRoot);
  await waitForFakeToolEvent(fakeToolLog, "rclone-config");

  const manualRun = await fetch(`${secondBaseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job: startupJob })
  });
  assert.equal(manualRun.status, 200);
  const manualRunPayload = await manualRun.json();
  assertClientSyncRunResponseContract(manualRunPayload, "schedulerManualSingleFlight.manualRun");
  assert.equal(manualRunPayload.sync.running, true);

  const history = await waitForSyncHistoryStatus(secondBaseUrl, "success");
  assert.equal(history.history.length, 1);

  const status = await (await fetch(`${secondBaseUrl}/api/client/status`)).json();
  assert.equal(status.scheduler.lastError, "");
  assert.equal(status.scheduler.jobs.length, 1);
  assert.equal(status.scheduler.jobs[0].schedule.mode, "startup");
  assert.equal(status.scheduler.jobs[0].nextRun, null);
  assert.equal(typeof status.scheduler.jobs[0].lastTriggeredAt, "string");

  const fakeToolEvents = await readFakeToolEvents(fakeToolLog);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "singbox-run").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-config").length, 1);
  assert.equal(fakeToolEvents.filter((event) => event.tool === "rclone-sync").length, 1);
});

test("client profile refresh preserves user job tuning while replacing profile-derived fields", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-profile-refresh-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(join(tempRoot, "resources", "bin", "win32"), { recursive: true });
  await writeFile(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), "placeholder");
  await writeFile(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), "placeholder");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const oldSecret = "old-profile-secret";
  const newSecret = "new-profile-secret";
  const makeProfileCode = ({
    clientName,
    remoteName,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix,
    defaults
  }) => `SFSC1-${base64UrlJson({
    version: 1,
    clientName,
    tunnel: {
      type: "vless",
      uri: tunnelUri
    },
    storage: {
      type: "s3",
      remoteName,
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      prefix
    },
    defaults
  })}`;

  await postJson(`${baseUrl}/api/profile/import`, {
    code: makeProfileCode({
      clientName: "refresh-pc",
      remoteName: "old-minio",
      endpoint: "http://old-minio:9000",
      bucket: "old-sync",
      accessKeyId: "old-access-key",
      secretAccessKey: oldSecret,
      prefix: "devices/refresh-pc",
      defaults: {
        localProxyPort: 18082,
        transfers: 2,
        streams: 3,
        checkers: 4,
        chunkSize: "16M",
        retries: 5,
        lowLevelRetries: 6,
        bandwidthLimit: "off",
        schedule: { mode: "manual" }
      }
    })
  });

  const saved = await postJson(`${baseUrl}/api/jobs/save`, {
    confirmDestructiveSync: true,
    job: {
      name: "Custom sync",
      localPath: "D:\\Custom",
      direction: "download",
      remoteFolder: "projects",
      serverSpace: "device",
      transfers: 12,
      streams: 10,
      checkers: 15,
      s3UploadConcurrency: 6,
      s3ChunkSize: "48M",
      cutoff: "96M",
      retries: 8,
      lowLevelRetries: 21,
      dryRun: true,
      destructiveSync: true,
      bandwidthLimit: "08:00,30M 18:00,off",
      schedule: { mode: "interval", intervalMinutes: 17 },
      localProxyPort: 19091
    }
  });
  assertClientJobSaveResponseContract(saved, "saved");
  assert.equal(saved.job.remoteName, "old-minio");
  assert.equal(saved.job.bucketName, "old-sync");
  assert.equal(saved.job.remotePrefix, "devices/refresh-pc/projects");
  assert.equal(saved.job.checkers, 15);
  assert.equal(saved.job.s3UploadConcurrency, 6);
  assert.equal(saved.job.s3ChunkSize, "48M");
  assert.equal(saved.job.cutoff, "96M");
  assert.equal(saved.job.retries, 8);
  assert.equal(saved.job.lowLevelRetries, 21);
  assert.equal(saved.job.localProxyPort, 19091);
  assert.equal(Object.hasOwn(saved.job, "accessKeyId"), false);
  assert.equal(Object.hasOwn(saved.job, "secretAccessKey"), false);

  await postJson(`${baseUrl}/api/profile/import`, {
    code: makeProfileCode({
      clientName: "refresh-pc",
      remoteName: "new-minio",
      endpoint: "http://new-minio:9000",
      bucket: "new-sync",
      accessKeyId: "new-access-key",
      secretAccessKey: newSecret,
      prefix: "devices-v2/refresh-pc",
      defaults: {
        localProxyPort: 18083,
        transfers: 3,
        streams: 4,
        checkers: 5,
        chunkSize: "64M",
        retries: 6,
        lowLevelRetries: 7,
        bandwidthLimit: "5M",
        schedule: { mode: "daily", time: "01:30" }
      }
    })
  });

  const status = await (await fetch(`${baseUrl}/api/client/status`)).json();
  const refreshed = status.jobs.find((job) => job.id === saved.job.id);
  assert.ok(refreshed);
  assert.equal(refreshed.name, "Custom sync");
  assert.equal(refreshed.localPath, "D:\\Custom");
  assert.equal(refreshed.direction, "download");
  assert.equal(refreshed.remoteFolder, "projects");
  assert.equal(refreshed.serverSpace, "device");
  assert.equal(refreshed.remoteName, "new-minio");
  assert.equal(refreshed.bucketName, "new-sync");
  assert.equal(refreshed.remotePrefix, "devices-v2/refresh-pc/projects");
  assert.equal(refreshed.s3Endpoint, "http://new-minio:9000");
  assert.equal(refreshed.transfers, 12);
  assert.equal(refreshed.streams, 10);
  assert.equal(refreshed.checkers, 15);
  assert.equal(refreshed.s3UploadConcurrency, 6);
  assert.equal(refreshed.s3ChunkSize, "48M");
  assert.equal(refreshed.cutoff, "96M");
  assert.equal(refreshed.retries, 8);
  assert.equal(refreshed.lowLevelRetries, 21);
  assert.equal(refreshed.dryRun, true);
  assert.equal(refreshed.destructiveSync, true);
  assert.equal(refreshed.bandwidthLimit, "08:00,30M 18:00,off");
  assert.deepEqual(refreshed.schedule, { mode: "interval", intervalMinutes: 17 });
  assert.equal(refreshed.localProxyPort, 19091);
  assert.equal(Object.hasOwn(refreshed, "accessKeyId"), false);
  assert.equal(Object.hasOwn(refreshed, "secretAccessKey"), false);
  assert.equal(JSON.stringify(refreshed).includes(oldSecret), false);
  assert.equal(JSON.stringify(refreshed).includes(newSecret), false);

  const listed = await (await fetch(`${baseUrl}/api/jobs`)).json();
  const listedRefreshed = listed.jobs.find((job) => job.id === saved.job.id);
  assert.deepEqual(listedRefreshed, refreshed);

  const preview = await postJson(`${baseUrl}/api/sync/preview`, {
    job: refreshed
  });
  assertSyncPreviewContract(preview, "profileRefreshPreview", {
    rawSecrets: [newSecret, oldSecret],
    remoteConfigSecret: newSecret
  });
  const args = preview.rclone.args;
  assert.equal(args[args.indexOf("--transfers") + 1], "12");
  assert.equal(args[args.indexOf("--checkers") + 1], "15");
  assert.equal(args[args.indexOf("--multi-thread-streams") + 1], "10");
  assert.equal(args[args.indexOf("--multi-thread-cutoff") + 1], "96M");
  assert.equal(args[args.indexOf("--retries") + 1], "8");
  assert.equal(args[args.indexOf("--low-level-retries") + 1], "21");
  assert.equal(args[args.indexOf("--s3-upload-concurrency") + 1], "6");
  assert.equal(args[args.indexOf("--s3-chunk-size") + 1], "48M");
  assert.equal(args[args.indexOf("--bwlimit") + 1], "08:00,30M 18:00,off");
  assert.equal(args.includes("--dry-run"), true);
  assert.equal(preview.rclone.env.ALL_PROXY, "socks5://127.0.0.1:19091");
  assert.equal(preview.rclone.storage.remoteName, "new-minio");
  assert.equal(preview.rclone.storage.bucketName, "new-sync");
  assert.equal(preview.rclone.remotePath, "new-minio:new-sync/devices-v2/refresh-pc/projects");
  assert.equal(preview.rclone.remoteConfig.args.includes(newSecret), false);
  assert.equal(preview.rclone.remoteConfig.args.includes(oldSecret), false);
  assert.equal(preview.rclone.remoteConfig.env.RCLONE_CONFIG_NEW_MINIO_SECRET_ACCESS_KEY, newSecret);
  assert.equal(preview.rclone.remoteConfig.displayCommand.includes(newSecret), false);
  assert.equal(preview.rclone.remoteConfig.displayCommand.includes(oldSecret), false);
  assert.equal(preview.schedule.text, "Every 17 minutes");
});

test("client imports a real server-issued SyncKey into local jobs and sync preview", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-server-e2e-"));
  const serverRoot = await mkdtemp(join(tmpdir(), "sfsc-server-for-client-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const clientBaseUrl = `http://127.0.0.1:${clientPort}`;
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const n1StorageEndpoint = "http://n1-minio.sfsc:9000";

  await mkdir(join(tempRoot, "resources", "bin", "win32"), { recursive: true });
  await writeFile(join(tempRoot, "resources", "bin", "win32", "sing-box.exe"), "placeholder");
  await writeFile(join(tempRoot, "resources", "bin", "win32", "rclone.exe"), "placeholder");

  const server = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(serverPort),
      PUBLIC_SERVER_URL: serverBaseUrl,
      SERVER_DATA_ROOT: join(serverRoot, "data"),
      SINGBOX_CONFIG_PATH: join(serverRoot, "sing-box", "config.json"),
      // Server fails closed without an admin token; this end-to-end path drives
      // management APIs without credentials, so no-auth mode is opt-in here.
      SFSC_ALLOW_NO_ADMIN_TOKEN: "1",
      S3_CLIENT_ENDPOINT: n1StorageEndpoint,
      LOCAL_PROXY_PORT: "18092"
    }
  });
  const client = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${clientBaseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!client.killed && client.exitCode === null) {
      client.kill();
    }
    if (!server.killed && server.exitCode === null) {
      server.kill();
    }
    await Promise.race([
      once(client, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    await rm(serverRoot, { recursive: true, force: true });
  });

  await waitForServerHealth(serverBaseUrl, server);
  await waitForClient(clientBaseUrl, client, tempRoot);

  const createdClaim = await postJson(`${serverBaseUrl}/api/claims/create`, {
    clientName: "e2e-pc",
    server: `${serverBaseUrl}/`,
    defaults: {
      transfers: 7,
      streams: 5,
      checkers: 9,
      chunkSize: "24M",
      retries: 4,
      lowLevelRetries: 13,
      bandwidthLimit: "15M",
      schedule: { mode: "interval", intervalMinutes: 45 }
    }
  });
  assert.match(createdClaim.tKey, /^SFSC1-/);
  assert.match(createdClaim.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(createdClaim.profile.storage.endpoint, n1StorageEndpoint);
  assert.equal(createdClaim.profile.defaults.localProxyPort, 18092);

  const shortCodeImport = await fetch(`${clientBaseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ code: createdClaim.code })
  });
  assert.equal(shortCodeImport.status, 400);
  const shortCodeImportPayload = await shortCodeImport.json();
  assertHttpErrorResponseContract(shortCodeImportPayload, "shortCodeImport", {
    errorCode: "import_code_invalid"
  });
  assert.match(shortCodeImportPayload.message, /SFSC1-|sfsc:\/\/import\/v1#/);
  assert.equal(await pathExists(join(tempRoot, "data", "claim-recovery.json")), false);

  const imported = await postJson(`${clientBaseUrl}/api/profile/import`, {
    code: createdClaim.tKey
  });
  assert.equal(imported.profile.importMode, "claim-redeem");
  assert.deepEqual(imported.profile.source, {
    type: "claim",
    server: serverBaseUrl
  });
  assert.equal(imported.profile.clientName, "e2e-pc");
  assert.equal(imported.profile.storage.remoteName, "home-minio");
  assert.equal(imported.profile.storage.endpoint, n1StorageEndpoint);
  assert.equal(imported.profile.storage.bucket, "home-sync");
  assert.equal(imported.profile.storage.prefix, "devices/e2e-pc");
  assert.equal(Object.hasOwn(imported.profile.storage, "accessKeyId"), false);
  assert.equal(Object.hasOwn(imported.profile.storage, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(imported.profile.tunnel, "uri"), false);
  assert.equal(Object.hasOwn(imported.profile.heartbeat, "secret"), false);
  assert.equal(JSON.stringify(imported.profile).includes(createdClaim.profile.storage.secretAccessKey), false);
  assert.equal(JSON.stringify(imported.profile).includes(createdClaim.profile.tunnel.uri), false);
  assert.equal(imported.profile.defaults.transfers, 7);
  assert.equal(imported.profile.defaults.streams, 5);
  assert.equal(imported.profile.defaults.checkers, 9);
  assert.equal(imported.profile.defaults.chunkSize, "24M");
  assert.equal(imported.profile.defaults.retries, 4);
  assert.equal(imported.profile.defaults.lowLevelRetries, 13);
  assert.equal(imported.profile.defaults.bandwidthLimit, "15M");
  assert.deepEqual(imported.profile.defaults.schedule, { mode: "interval", intervalMinutes: 45 });
  assert.equal(imported.profile.defaults.localProxyPort, 18092);

  const savedJob = await postJson(`${clientBaseUrl}/api/jobs/save`, {
    job: {
      localPath: "E:\\E2E",
      direction: "upload"
    }
  });
  assertClientJobSaveResponseContract(savedJob, "savedJob");
  assert.equal(savedJob.job.clientName, "e2e-pc");
  assert.equal(savedJob.job.remoteName, "home-minio");
  assert.equal(savedJob.job.s3Endpoint, n1StorageEndpoint);
  assert.equal(savedJob.job.bucketName, "home-sync");
  assert.equal(savedJob.job.remotePrefix, "devices/e2e-pc");
  assert.equal(Object.hasOwn(savedJob.job, "accessKeyId"), false);
  assert.equal(Object.hasOwn(savedJob.job, "secretAccessKey"), false);
  assert.equal(savedJob.job.transfers, 7);
  assert.equal(savedJob.job.streams, 5);
  assert.equal(savedJob.job.checkers, 9);
  assert.equal(savedJob.job.s3UploadConcurrency, 5);
  assert.equal(savedJob.job.s3ChunkSize, "24M");
  assert.equal(savedJob.job.cutoff, "24M");
  assert.equal(savedJob.job.retries, 4);
  assert.equal(savedJob.job.lowLevelRetries, 13);
  assert.equal(savedJob.job.bandwidthLimit, "15M");
  assert.deepEqual(savedJob.job.schedule, { mode: "interval", intervalMinutes: 45 });
  assert.equal(savedJob.job.localProxyPort, 18092);

  const preview = await postJson(`${clientBaseUrl}/api/sync/preview`, {
    job: {
      localPath: "E:\\E2E",
      direction: "upload"
    }
  });
  assertSyncPreviewContract(preview, "e2ePreview", {
    rawSecrets: [createdClaim.profile.storage.secretAccessKey],
    remoteConfigSecret: createdClaim.profile.storage.secretAccessKey
  });
  const rawStorageSecret = createdClaim.profile.storage.secretAccessKey;
  assert.equal(typeof preview.schedule.text, "string");
  assert.notEqual(preview.schedule.text.trim(), "");
  assert.ok(
    preview.schedule.nextRun === null || typeof preview.schedule.nextRun === "string",
    "preview.schedule.nextRun is a string or null"
  );
  assert.equal(typeof preview.rclone.remotePath, "string");
  assert.notEqual(preview.rclone.remotePath.trim(), "");
  assert.equal(typeof preview.rclone.remoteConfig.displayCommand, "string");
  assert.equal(preview.rclone.remoteConfig.displayCommand.includes(rawStorageSecret), false);
  assert.equal(typeof preview.rclone.displayCommand, "string");
  assert.equal(preview.rclone.displayCommand.includes(rawStorageSecret), false);
  assert.equal(preview.rclone.remoteConfig.args.includes(rawStorageSecret), false);
  assert.ok(rcloneRemoteConfigSecretEnvValues(preview.rclone).includes(rawStorageSecret));
  assert.equal(preview.rclone.storage.endpoint, n1StorageEndpoint);
  const remoteConfigArgs = preview.rclone.remoteConfig.args;
  assert.equal(remoteConfigArgs[remoteConfigArgs.indexOf("endpoint") + 1], n1StorageEndpoint);
  const args = preview.rclone.args;
  assert.equal(args[args.indexOf("--transfers") + 1], "7");
  assert.equal(args[args.indexOf("--checkers") + 1], "9");
  assert.equal(args[args.indexOf("--multi-thread-streams") + 1], "5");
  assert.equal(args[args.indexOf("--multi-thread-cutoff") + 1], "24M");
  assert.equal(args[args.indexOf("--retries") + 1], "4");
  assert.equal(args[args.indexOf("--low-level-retries") + 1], "13");
  assert.equal(args[args.indexOf("--s3-upload-concurrency") + 1], "5");
  assert.equal(args[args.indexOf("--s3-chunk-size") + 1], "24M");
  assert.equal(args[args.indexOf("--bwlimit") + 1], "15M");
  assert.equal(preview.rclone.env.ALL_PROXY, "socks5://127.0.0.1:18092");
  assert.equal(preview.schedule.text, "Every 45 minutes");
});

test("client profile import rejects claim redeem profiles without heartbeat credentials", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-missing-heartbeat-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const redeemRequests = [];

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      redeemRequests.push(await readJsonRequest(req));
      const profile = buildMockProfile({
        server: mockServerUrl,
        clientName: "missing-heartbeat-pc"
      });
      delete profile.heartbeat;
      jsonResponse(res, profile);
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "ABCD-2345"
      })}`
    })
  });
  assert.equal(importResponse.status, 400);
  assertHttpErrorResponseContract(await importResponse.json(), "missingHeartbeatImport", {
    errorCode: "profile_heartbeat_required"
  });
  assert.equal(redeemRequests.length, 1);
  assert.equal(await pathExists(join(tempRoot, "data", "claim-recovery.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false);
});

test("client profile import rejects claim redeem profiles without storage credentials", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-missing-storage-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const redeemRequests = [];

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      redeemRequests.push(await readJsonRequest(req));
      const profile = buildMockProfile({
        server: mockServerUrl,
        clientName: "missing-storage-pc"
      });
      delete profile.storage;
      jsonResponse(res, { profile });
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "ABCD-2345"
      })}`
    })
  });
  assert.equal(importResponse.status, 400);
  const importPayload = await importResponse.json();
  assertHttpErrorResponseContract(importPayload, "missingStorageImport", {
    errorCode: "profile_storage_required"
  });
  assert.match(importPayload.message, /storage credentials/);
  assert.equal(redeemRequests.length, 1);
  assert.equal(await pathExists(join(tempRoot, "data", "claim-recovery.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false);
});

test("client profile import rejects claim redeem profiles without tunnel credentials", async (t) => {
  const redeemRequests = [];
  const { baseUrl, mockServerUrl, tempRoot } = await startClaimImportHarness(t, {
    tempPrefix: "sfsc-client-missing-tunnel-",
    redeemHandler: async (req, res) => {
      redeemRequests.push(await readJsonRequest(req));
      const profile = buildMockProfile({
        server: mockServerUrl,
        clientName: "missing-tunnel-pc"
      });
      delete profile.tunnel;
      jsonResponse(res, { profile });
    }
  });

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: claimImportTKey(mockServerUrl, "ABCD-2345")
    })
  });
  assert.equal(importResponse.status, 400);
  assertHttpErrorResponseContract(await importResponse.json(), "missingTunnelClaimRedeemImport", {
    errorCode: "profile_tunnel_required"
  });
  assert.equal(redeemRequests.length, 1);
  assert.equal(redeemRequests[0].code, "ABCD-2345");
  assert.equal(await pathExists(join(tempRoot, "data", "claim-recovery.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false);
  assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false);
});

test("client profile import clears claim recovery after terminal claim redeem errors", async (t) => {
  const terminalCases = [
    {
      claimCode: "T404-AAAA",
      status: 404,
      errorCode: "claim_not_found",
      message: "SyncKey was not found"
    },
    {
      claimCode: "T409-AAAA",
      status: 409,
      errorCode: "claim_already_used",
      message: "SyncKey has already been used"
    },
    {
      claimCode: "T410-AAAA",
      status: 410,
      errorCode: "claim_expired",
      message: "SyncKey has expired"
    },
    {
      claimCode: "T400-AAAA",
      status: 400,
      errorCode: "validation_failed",
      message: "SyncKey redeem request was invalid"
    }
  ];
  const redeemRequests = [];
  const { baseUrl, mockServerUrl, tempRoot } = await startClaimImportHarness(t, {
    tempPrefix: "sfsc-client-terminal-claim-",
    redeemHandler: async (req, res) => {
      const body = await readJsonRequest(req);
      redeemRequests.push(body);
      const item = terminalCases.find((entry) => entry.claimCode === body.code);
      if (!item) {
        jsonResponse(res, { ok: false, errorCode: "claim_not_found" }, 404);
        return;
      }
      jsonResponse(res, {
        ok: false,
        errorCode: item.errorCode,
        message: item.message
      }, item.status);
    }
  });

  const recoveryPath = join(tempRoot, "data", "claim-recovery.json");
  for (const item of terminalCases) {
    const tKey = claimImportTKey(mockServerUrl, item.claimCode);
    const response = await fetch(`${baseUrl}/api/profile/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ code: tKey })
    });
    assert.equal(response.status, item.status);
    assertHttpErrorResponseContract(await response.json(), `terminalClaimRedeem.${item.errorCode}`, {
      errorCode: item.errorCode,
      message: item.message
    });
    const redeemRequest = redeemRequests.at(-1);
    assert.equal(redeemRequest.code, item.claimCode);
    assert.match(redeemRequest.clientRedeemId, /^[0-9a-f-]{36}$/);
    assert.match(redeemRequest.clientInstallId, /^[0-9a-f-]{36}$/);
    assert.equal(await pathExists(recoveryPath), false);
    assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false);
    assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false);
  }
  assert.equal(redeemRequests.length, terminalCases.length);
});

test("client profile import keeps claim recovery after retryable claim redeem errors", async (t) => {
  const retryableCases = [
    {
      claimCode: "R500-AAAA",
      status: 500,
      remoteErrorCode: "server_state_write_failed",
      localErrorCode: "server_state_write_failed",
      message: "Failed to persist claim redemption"
    },
    {
      claimCode: "R418-AAAA",
      status: 418,
      remoteErrorCode: "remote_new_failure",
      localErrorCode: "claim_redeem_failed",
      message: "Resolver returned a new failure"
    }
  ];
  const redeemRequests = [];
  const { baseUrl, mockServerUrl, tempRoot } = await startClaimImportHarness(t, {
    tempPrefix: "sfsc-client-retryable-claim-",
    redeemHandler: async (req, res) => {
      const body = await readJsonRequest(req);
      redeemRequests.push(body);
      const item = retryableCases.find((entry) => entry.claimCode === body.code);
      if (!item) {
        jsonResponse(res, { ok: false, errorCode: "claim_not_found" }, 404);
        return;
      }
      jsonResponse(res, {
        ok: false,
        errorCode: item.remoteErrorCode,
        message: item.message
      }, item.status);
    }
  });

  const recoveryPath = join(tempRoot, "data", "claim-recovery.json");
  for (const item of retryableCases) {
    const tKey = claimImportTKey(mockServerUrl, item.claimCode);
    const response = await fetch(`${baseUrl}/api/profile/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ code: tKey })
    });
    assert.equal(response.status, item.status);
    assertHttpErrorResponseContract(await response.json(), `retryableClaimRedeem.${item.localErrorCode}`, {
      errorCode: item.localErrorCode,
      message: item.message
    });
    const redeemRequest = redeemRequests.at(-1);
    assert.equal(redeemRequest.code, item.claimCode);
    const recovery = await readClaimRecovery(tempRoot);
    assertClaimRecoveryRetained(recovery, {
      server: mockServerUrl,
      request: redeemRequest,
      rawCode: item.claimCode,
      tKey
    });
    assert.equal(await pathExists(recoveryPath), true);
    assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false);
    assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false);
  }
  assert.equal(redeemRequests.length, retryableCases.length);
});

test("client profile import keeps claim recovery after malformed successful claim redeem responses", async (t) => {
  const cases = [
    {
      claimCode: "R200-HTML",
      label: "html",
      respond: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>bad gateway</title>");
      }
    },
    {
      claimCode: "R200-OKAY",
      label: "success envelope without profile",
      respond: (_req, res) => jsonResponse(res, { ok: true })
    },
    {
      claimCode: "R200-MSG1",
      label: "message envelope without profile",
      respond: (_req, res) => jsonResponse(res, { message: "ok" })
    },
    {
      claimCode: "R200-NULL",
      label: "null profile wrapper",
      respond: (_req, res) => jsonResponse(res, { profile: null })
    }
  ];
  const redeemRequests = [];
  const { baseUrl, mockServerUrl, tempRoot } = await startClaimImportHarness(t, {
    tempPrefix: "sfsc-client-malformed-success-claim-",
    redeemHandler: async (req, res) => {
      const body = await readJsonRequest(req);
      redeemRequests.push(body);
      const item = cases.find((entry) => entry.claimCode === body.code);
      if (!item) {
        jsonResponse(res, { ok: false, errorCode: "claim_not_found" }, 404);
        return;
      }
      item.respond(req, res);
    }
  });

  const recoveryPath = join(tempRoot, "data", "claim-recovery.json");
  for (const item of cases) {
    const tKey = claimImportTKey(mockServerUrl, item.claimCode);
    const response = await fetch(`${baseUrl}/api/profile/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ code: tKey })
    });
    assert.equal(response.status, 502, item.label);
    assertHttpErrorResponseContract(await response.json(), `malformedSuccessfulClaimRedeem.${item.label}`, {
      errorCode: "claim_redeem_failed"
    });
    const redeemRequest = redeemRequests.at(-1);
    assert.equal(redeemRequest.code, item.claimCode, item.label);
    const recovery = await readClaimRecovery(tempRoot);
    assertClaimRecoveryRetained(recovery, {
      server: mockServerUrl,
      request: redeemRequest,
      rawCode: item.claimCode,
      tKey
    });
    assert.equal(await pathExists(recoveryPath), true, item.label);
    assert.equal(await pathExists(join(tempRoot, "data", "profile.json")), false, item.label);
    assert.equal(await pathExists(join(tempRoot, "data", "secrets.json")), false, item.label);
  }
  assert.equal(redeemRequests.length, cases.length);
});

test("client profile import reuses pending recovery binding after lost redeem response", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-claim-recovery-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const redeemRequests = [];

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      const body = await readJsonRequest(req);
      redeemRequests.push(body);
      if (redeemRequests.length === 1) {
        req.socket.destroy();
        return;
      }
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: "recovery-pc"
        })
      });
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const tKey = `SFSC1-${base64UrlJson({
    version: 1,
    type: "claim",
    server: mockServerUrl,
    code: "RCVY-0001"
  })}`;
  const firstImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ code: tKey })
  });
  assert.equal(firstImport.status, 502);
  assertHttpErrorResponseContract(await firstImport.json(), "firstImport", {
    errorCode: "claim_redeem_failed"
  });
  assert.equal(redeemRequests.length, 1);
  assert.equal(redeemRequests[0].code, "RCVY-0001");
  assert.match(redeemRequests[0].clientRedeemId, /^[0-9a-f-]{36}$/);
  assert.match(redeemRequests[0].clientInstallId, /^[0-9a-f-]{36}$/);

  const recoveryPath = join(tempRoot, "data", "claim-recovery.json");
  const recovery = JSON.parse(await readFile(recoveryPath, "utf8"));
  assert.equal(recovery.type, "claim-import-recovery");
  assert.equal(recovery.claim.server, mockServerUrl);
  assert.equal(recovery.claim.code, undefined);
  assert.match(recovery.claim.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(recovery.clientRedeemId, redeemRequests[0].clientRedeemId);
  assert.equal(recovery.clientInstallId, redeemRequests[0].clientInstallId);
  assert.equal(JSON.stringify(recovery).includes(tKey), false);
  assert.equal(JSON.stringify(recovery).includes("RCVY-0001"), false);
  assert.equal(JSON.stringify(recovery).includes("top-secret-value"), false);

  const secondImport = await postJson(`${baseUrl}/api/profile/import`, {
    code: tKey
  });
  assert.equal(secondImport.profile.importMode, "claim-redeem");
  assert.equal(secondImport.profile.clientName, "recovery-pc");
  assert.equal(redeemRequests.length, 2);
  assert.equal(redeemRequests[1].clientRedeemId, redeemRequests[0].clientRedeemId);
  assert.equal(redeemRequests[1].clientInstallId, redeemRequests[0].clientInstallId);
  assert.equal(await pathExists(recoveryPath), false);
});

test("client profile import rolls back profile jobs and secrets when job refresh fails", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-import-rollback-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const redeemRequests = [];
  const oldStorageSecret = "old-rollback-storage-secret";
  const oldHeartbeatSecret = "old-rollback-heartbeat-secret";
  const newStorageSecret = "new-rollback-storage-secret";
  const newHeartbeatSecret = "new-rollback-heartbeat-secret";
  let releaseRedeem;
  const redeemGate = new Promise((resolve) => {
    releaseRedeem = resolve;
  });

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      const body = await readJsonRequest(req);
      redeemRequests.push(body);
      const profile = buildMockProfile({
        server: mockServerUrl,
        clientName: "new-rollback-pc"
      });
      profile.storage.secretAccessKey = newStorageSecret;
      profile.heartbeat.secret = newHeartbeatSecret;
      await redeemGate;
      jsonResponse(res, { profile });
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  await postJson(`${baseUrl}/api/profile/import`, {
    code: `SFSC1-${base64UrlJson({
      version: 1,
      profileId: "profile-old-rollback-pc",
      clientName: "old-rollback-pc",
      issuedAt: "2026-07-04T12:00:00.000Z",
      expiresAt: null,
      tunnel: {
        type: "vless",
        uri: tunnelUri
      },
      heartbeat: {
        scheme: "sfsc-hmac-sha256-v1",
        secret: oldHeartbeatSecret
      },
      storage: {
        type: "s3",
        remoteName: "old-minio",
        endpoint: "http://old-minio:9000",
        bucket: "old-sync",
        accessKeyId: "old-rollback-pc",
        secretAccessKey: oldStorageSecret,
        prefix: "devices/old-rollback-pc"
      },
      defaults: {
        localProxyPort: 18082,
        transfers: 4,
        streams: 8,
        checkers: 8,
        chunkSize: "16M",
        retries: 3,
        lowLevelRetries: 10,
        bandwidthLimit: "off",
        schedule: { mode: "manual" }
      }
    })}`
  });

  const profilePath = join(tempRoot, "data", "profile.json");
  const jobsPath = join(tempRoot, "data", "jobs.json");
  const secretsPath = join(tempRoot, "data", "secrets.json");
  const recoveryPath = join(tempRoot, "data", "claim-recovery.json");
  const invalidStoredJobs = [{
    id: "job-rollback",
    name: "Rollback sync",
    localPath: "D:\\Rollback",
    direction: "upload",
    remoteFolder: "projects",
    serverSpace: "device",
    transfers: 0,
    createdAt: "2026-07-04T12:00:00.000Z",
    updatedAt: "2026-07-04T12:00:00.000Z"
  }];
  await writeFile(jobsPath, JSON.stringify(invalidStoredJobs, null, 2), "utf8");
  const oldProfileRaw = await readFile(profilePath, "utf8");
  const oldJobsRaw = await readFile(jobsPath, "utf8");
  const oldSecretsRaw = await readFile(secretsPath, "utf8");

  const failedImportPromise = fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "RLBK-0001"
      })}`
    })
  });
  for (let attempt = 0; attempt < 50 && redeemRequests.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(redeemRequests.length, 1);

  const concurrentSavePromise = fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: {
        id: "job-after-rollback",
        name: "Saved after rollback",
        localPath: "D:\\AfterRollback",
        direction: "download",
        remoteFolder: "after"
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseRedeem();

  const failedImport = await failedImportPromise;
  assert.equal(failedImport.status, 400);
  assertHttpErrorResponseContract(await failedImport.json(), "rollbackImport", {
    errorCode: "validation_failed"
  });
  const concurrentSave = await concurrentSavePromise;
  assert.equal(concurrentSave.status, 200);
  const concurrentSavePayload = await concurrentSave.json();
  assertClientJobSaveResponseContract(concurrentSavePayload, "rollbackConcurrentSave");
  assert.equal(concurrentSavePayload.job.id, "job-after-rollback");
  assert.equal(concurrentSavePayload.job.clientName, "old-rollback-pc");
  assert.equal(concurrentSavePayload.job.remoteName, "old-minio");

  assert.equal(await readFile(profilePath, "utf8"), oldProfileRaw);
  const finalJobs = JSON.parse(await readFile(jobsPath, "utf8"));
  assert.equal(finalJobs.length, 2);
  assert.deepEqual(finalJobs.find((job) => job.id === "job-rollback"), JSON.parse(oldJobsRaw)[0]);
  assert.equal(finalJobs.find((job) => job.id === "job-after-rollback")?.clientName, "old-rollback-pc");
  const finalSecrets = JSON.parse(await readFile(secretsPath, "utf8"));
  const oldSecrets = JSON.parse(oldSecretsRaw);
  assert.equal(finalSecrets[Object.keys(oldSecrets).find((key) => oldSecrets[key] === oldStorageSecret)], oldStorageSecret);
  assert.equal(finalSecrets[Object.keys(oldSecrets).find((key) => oldSecrets[key] === oldHeartbeatSecret)], oldHeartbeatSecret);
  const combinedState = [
    await readFile(profilePath, "utf8"),
    await readFile(jobsPath, "utf8"),
    await readFile(secretsPath, "utf8")
  ].join("\n");
  assert.equal(combinedState.includes(newStorageSecret), false);
  assert.equal(combinedState.includes(newHeartbeatSecret), false);
  assert.equal(combinedState.includes(oldStorageSecret), true);
  assert.equal(combinedState.includes(oldHeartbeatSecret), true);

  const recovery = JSON.parse(await readFile(recoveryPath, "utf8"));
  assert.equal(recovery.type, "claim-import-recovery");
  assert.equal(recovery.claim.server, mockServerUrl);
  assert.equal(recovery.claim.code, undefined);
  assert.match(recovery.claim.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(recovery.clientRedeemId, redeemRequests[0].clientRedeemId);
  assert.equal(recovery.clientInstallId, redeemRequests[0].clientInstallId);
  assert.equal(JSON.stringify(recovery).includes("RLBK-0001"), false);
  assert.equal(JSON.stringify(recovery).includes(newStorageSecret), false);
  assert.equal(JSON.stringify(recovery).includes(newHeartbeatSecret), false);

  const profileRead = await (await fetch(`${baseUrl}/api/profile`)).json();
  assertClientProfileReadContract(profileRead, "rollbackProfileRead");
  assert.equal(profileRead.profile.clientName, "old-rollback-pc");
  assert.equal(profileRead.profile.storage.remoteName, "old-minio");
});

test("client sends signed heartbeat for server-issued offline full profile", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-offline-profile-heartbeat-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const heartbeatRequests = [];
  let claimRedeemRequests = 0;

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      claimRedeemRequests += 1;
      jsonResponse(res, { ok: false, errorCode: "unexpected_claim_redeem" }, 500);
      return;
    }
    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      heartbeatRequests.push(body);
      jsonResponse(res, buildHeartbeatResponse({
        clientName: body.clientName,
        compatibility: compatibleHeartbeatCompatibility()
      }));
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const imported = await postJson(`${baseUrl}/api/profile/import`, {
    code: `SFSC1-${base64UrlJson({
      version: 1,
      profileId: "profile-offline-pc",
      clientName: "offline-pc",
      issuedAt: "2026-07-04T12:00:00.000Z",
      expiresAt: null,
      source: {
        type: "profile",
        server: `${mockServerUrl}/`
      },
      tunnel: {
        type: "vless",
        uri: tunnelUri
      },
      heartbeat: {
        scheme: "sfsc-hmac-sha256-v1",
        secret: "offline-heartbeat-secret"
      },
      storage: {
        type: "s3",
        remoteName: "home-minio",
        endpoint: "http://minio:9000",
        bucket: "home-sync",
        accessKeyId: "offline-pc",
        secretAccessKey: "top-secret-value",
        prefix: "devices/offline-pc"
      },
      defaults: {
        localProxyPort: 18082,
        transfers: 4,
        streams: 8,
        checkers: 8,
        chunkSize: "16M",
        retries: 3,
        lowLevelRetries: 10,
        bandwidthLimit: "off",
        schedule: { mode: "manual" }
      }
    })}`
  });
  assert.equal(imported.profile.importMode, "offline-profile");
  assert.equal(imported.profile.source.type, "profile");
  assert.equal(imported.profile.source.server, mockServerUrl);
  assert.equal(imported.profile.heartbeat.configured, true);

  const status = await waitForHeartbeatCompatibility(baseUrl, "allow");
  assertHeartbeatContract(status.heartbeat);
  assert.equal(status.heartbeat.server, mockServerUrl);
  assert.equal(status.heartbeat.device.clientName, "offline-pc");
  assert.equal(claimRedeemRequests, 0);
  assert.ok(heartbeatRequests.some((request) => request.clientName === "offline-pc"));
  const request = heartbeatRequests.find((item) => item.clientName === "offline-pc");
  assert.equal(request.auth.scheme, "sfsc-hmac-sha256-v1");
  assert.match(request.auth.signature, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(request.sync, "phase"), false);
});

test("client status preserves server heartbeat device sync summary without VLESS secrets", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-heartbeat-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const heartbeatRequests = [];
  let heartbeatMode = "success";

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      const body = await readJsonRequest(req);
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: body.code === "ABCD-1234" ? "company-pc1" : "unknown"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      heartbeatRequests.push(body);
      if (heartbeatMode === "fail") {
        jsonResponse(res, {
          ok: false,
          errorCode: "device_not_found",
          error: "device_not_found",
          message: "Device was not found on the server"
        }, 404);
        return;
      }
      const diagnostics = buildServerDiagnostics();
      jsonResponse(res, {
        ok: true,
        diagnostics,
        device: {
          id: "user-company-pc1",
          clientName: "company-pc1",
          enabled: true,
          online: true,
          status: "online",
          lastSeenAt: "2026-07-04T12:00:00.000Z",
          bucket: "home-sync",
          prefix: "devices/company-pc1",
          clientVersion: "0.3.0-rc.1",
          lastRemoteAddress: "127.0.0.1",
          syncState: "syncing",
          speedMbps: 50,
          vlessUri: "vless://server-secret@example.invalid:443",
          compatibility: compareHeartbeatDiagnostics(diagnostics, body.diagnostics),
          sync: {
            state: "syncing",
            speedMbps: 50,
            progressPercent: 42.5,
            currentFile: "projects/current.iso",
            currentJob: null,
            conflicts: {
              count: 1,
              files: ["projects/conflict.txt"],
              truncated: false
            },
            scheduler: {
              enabled: true,
              intervalMs: 15000,
              nextRun: "2026-07-04T12:15:00.000Z",
              lastTriggeredAt: "2026-07-04T12:00:00.000Z",
              lastError: "",
              jobs: [
                {
                  id: "job-folder-sync",
                  name: "Folder sync",
                  schedule: { mode: "interval", intervalMinutes: 15 },
                  scheduleText: "Every 15 minutes",
                  nextRun: "2026-07-04T12:15:00.000Z",
                  lastTriggeredAt: "2026-07-04T12:00:00.000Z",
                  lastError: ""
                }
              ]
            },
            lastRun: {
              id: "sync-run-1",
              status: "success",
              trigger: "scheduler",
              startedAt: "2026-07-04T11:00:00.000Z",
              finishedAt: "2026-07-04T11:05:00.000Z",
              job: {
                name: "Folder sync",
                direction: "upload",
                bucketName: "home-sync",
                remotePrefix: "devices/company-pc1",
                remoteFolder: "projects",
                serverSpace: "device"
              },
              localPath: "C:\\Data\\Projects",
              exitCode: 0,
              error: "",
              progressPercent: 100,
              transferredSizeText: "1.2 GiB",
              currentFile: "projects/video.iso",
              rawSpeed: "8 MiB/s",
              speedMbps: 67.11,
              errorCode: "",
              conflicts: {
                count: 1,
                files: ["projects/conflict.txt"],
                truncated: false
              }
            }
          }
        }
      });
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "ABCD-1234"
      })}`
    })
  });
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json();
  assert.equal(imported.profile.importMode, "claim-redeem");
  assert.equal(imported.profile.source.server, mockServerUrl);

  const status = await waitForHeartbeatStatus(baseUrl);
  assertClientStatusContract(status);
  assertHeartbeatContract(status.heartbeat);
  assertHeartbeatContract(status.lastSuccessfulHeartbeat);
  assert.equal(status.heartbeat.ok, true);
  assert.equal(status.lastSuccessfulHeartbeat.ok, true);
  assert.deepEqual(status.lastSuccessfulHeartbeat.compatibility, status.heartbeat.compatibility);
  assert.equal(status.heartbeat.server, mockServerUrl);
  assert.match(status.heartbeat.sentAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.heartbeat.status, 200);
  assert.equal(status.heartbeat.serverDiagnostics.role, "server");
  assert.equal(status.heartbeat.serverDiagnostics.protocols.heartbeat, 1);
  assert.equal(status.heartbeat.compatibility.ok, true);
  assert.equal(status.heartbeat.compatibility.status, "compatible");
  assert.equal(status.heartbeat.compatibility.action, "none");
  assert.equal(status.heartbeat.compatibility.policy.heartbeat, "allow");
  assert.equal(status.heartbeat.compatibility.policy.profileIssue, "allow");
  assert.equal(status.heartbeat.compatibility.policy.syncRun, "allow");
  assert.equal(status.heartbeat.compatibility.policy.adminActions, "allow");
  assert.equal(status.heartbeat.compatibility.policy.reason, "none");
  assert.deepEqual(status.heartbeat.compatibility.issues, []);
  assert.equal(status.heartbeat.device.id, "user-company-pc1");
  assert.equal(status.heartbeat.device.clientName, "company-pc1");
  assert.equal(status.heartbeat.device.enabled, true);
  assert.equal(status.heartbeat.device.online, true);
  assert.equal(status.heartbeat.device.status, "online");
  assert.equal(status.heartbeat.device.lastSeenAt, "2026-07-04T12:00:00.000Z");
  assert.equal(status.heartbeat.device.bucket, "home-sync");
  assert.equal(status.heartbeat.device.prefix, "devices/company-pc1");
  assert.equal(status.heartbeat.device.clientVersion, "0.3.0-rc.1");
  assert.equal(status.heartbeat.device.lastRemoteAddress, "127.0.0.1");
  assert.equal(status.heartbeat.device.syncState, "syncing");
  assert.equal(status.heartbeat.device.sync.state, "syncing");
  assert.equal(status.heartbeat.device.syncState, status.heartbeat.device.sync.state);
  assert.equal(status.heartbeat.device.speedMbps, 50);
  assert.equal(status.heartbeat.device.sync.speedMbps, 50);
  assert.equal(status.heartbeat.device.speedMbps, status.heartbeat.device.sync.speedMbps);
  assert.equal(status.heartbeat.device.sync.progressPercent, 42.5);
  assert.equal(status.heartbeat.device.sync.currentFile, "projects/current.iso");
  assert.equal(status.heartbeat.device.sync.currentJob, null);
  assert.equal(status.heartbeat.device.sync.lastRun.id, "sync-run-1");
  assert.equal(status.heartbeat.device.sync.lastRun.status, "success");
  assert.equal(status.heartbeat.device.sync.lastRun.trigger, "scheduler");
  assert.equal(status.heartbeat.device.sync.lastRun.startedAt, "2026-07-04T11:00:00.000Z");
  assert.equal(status.heartbeat.device.sync.lastRun.finishedAt, "2026-07-04T11:05:00.000Z");
  assert.equal(status.heartbeat.device.sync.lastRun.job.name, "Folder sync");
  assert.equal(status.heartbeat.device.sync.lastRun.job.direction, "upload");
  assert.equal(status.heartbeat.device.sync.lastRun.job.bucketName, "home-sync");
  assert.equal(status.heartbeat.device.sync.lastRun.job.remotePrefix, "devices/company-pc1");
  assert.equal(status.heartbeat.device.sync.lastRun.job.remoteFolder, "projects");
  assert.equal(status.heartbeat.device.sync.lastRun.job.serverSpace, "device");
  assert.equal(status.heartbeat.device.sync.lastRun.localPath, "C:\\Data\\Projects");
  assert.equal(status.heartbeat.device.sync.lastRun.exitCode, 0);
  assert.equal(status.heartbeat.device.sync.lastRun.error, "");
  assert.equal(status.heartbeat.device.sync.lastRun.progressPercent, 100);
  assert.equal(status.heartbeat.device.sync.lastRun.transferredSizeText, "1.2 GiB");
  assert.equal(status.heartbeat.device.sync.lastRun.currentFile, "projects/video.iso");
  assert.equal(status.heartbeat.device.sync.lastRun.rawSpeed, "8 MiB/s");
  assert.equal(status.heartbeat.device.sync.lastRun.speedMbps, 67.11);
  assert.equal(status.heartbeat.device.sync.lastRun.errorCode, "");
  assert.equal(status.heartbeat.device.sync.lastRun.conflicts.count, 1);
  assert.equal(status.heartbeat.device.sync.conflicts.count, 1);
  assert.equal(status.heartbeat.device.sync.scheduler.enabled, true);
  assert.equal(status.heartbeat.device.sync.scheduler.intervalMs, 15000);
  assert.equal(status.heartbeat.device.sync.scheduler.nextRun, "2026-07-04T12:15:00.000Z");
  assert.equal(status.heartbeat.device.sync.scheduler.lastTriggeredAt, "2026-07-04T12:00:00.000Z");
  assert.equal(status.heartbeat.device.sync.scheduler.lastError, "");
  assert.equal(status.heartbeat.device.sync.scheduler.jobs.length, 1);
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].id, "job-folder-sync");
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].name, "Folder sync");
  assert.deepEqual(status.heartbeat.device.sync.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 15 });
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].scheduleText, "Every 15 minutes");
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].nextRun, "2026-07-04T12:15:00.000Z");
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].lastTriggeredAt, "2026-07-04T12:00:00.000Z");
  assert.equal(status.heartbeat.device.sync.scheduler.jobs[0].lastError, "");
  assert.equal(status.heartbeat.device.vlessUri, undefined);
  assert.equal(status.heartbeat.device.secretAccessKey, undefined);
  assert.equal(status.heartbeat.device.privateKey, undefined);
  assert.equal(status.heartbeat.device.tKey, undefined);
  assert.equal(status.heartbeat.device.claimCode, undefined);
  assert.equal(JSON.stringify(status.heartbeat.device).includes("vless://server-secret"), false);
  assert.ok(heartbeatRequests.some((request) => request.clientName === "company-pc1"));

  const diagnostics = await (await fetch(`${baseUrl}/api/diagnostics/export`)).json();
  assert.equal(diagnostics.bundle.summary.heartbeatDeviceCurrentFile, "redacted");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.enabled, true);
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.intervalMs, 15000);
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.nextRun, "2026-07-04T12:15:00.000Z");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.lastTriggeredAt, "2026-07-04T12:00:00.000Z");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.lastError, "");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs.length, 1);
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].id, "redacted");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].name, "Folder sync");
  assert.deepEqual(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 15, timeOfDay: "" });
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].scheduleText, "Every 15 minutes");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].nextRun, "2026-07-04T12:15:00.000Z");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].lastTriggeredAt, "2026-07-04T12:00:00.000Z");
  assert.equal(diagnostics.bundle.status.heartbeat.device.sync.scheduler.jobs[0].lastError, "");
  assert.equal(JSON.stringify(diagnostics.bundle).includes("vless://server-secret"), false);
  assert.equal(JSON.stringify(diagnostics.bundle).includes("projects/current.iso"), false);

  heartbeatMode = "fail";
  const failedStatus = await waitForHeartbeatFailure(baseUrl);
  assert.equal(failedStatus.heartbeat.ok, false);
  assert.equal(failedStatus.heartbeat.remoteErrorCode, "device_not_found");
  assert.equal(failedStatus.lastSuccessfulHeartbeat.device.sync.currentFile, "projects/current.iso");

  const fallbackDiagnostics = await (await fetch(`${baseUrl}/api/diagnostics/export`)).json();
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatOk, false);
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatErrorCode, "heartbeat_failed");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatRemoteErrorCode, "device_not_found");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatDeviceBucket, "redacted");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatDevicePrefix, "redacted");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatDeviceCurrentFile, "redacted");
  assert.equal(JSON.stringify(fallbackDiagnostics.bundle).includes("projects/current.iso"), false);
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatServerProtocols.heartbeat, 1);
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatCompatibilityStatus, "compatible");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatCompatibilitySeverity, "ok");
  assert.equal(fallbackDiagnostics.bundle.summary.heartbeatCompatibilitySyncRunPolicy, "allow");
  assert.equal(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.intervalMs, 15000);
  assert.equal(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.lastTriggeredAt, "2026-07-04T12:00:00.000Z");
  assert.deepEqual(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 15, timeOfDay: "" });
  assert.equal(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.jobs[0].scheduleText, "Every 15 minutes");
  assert.equal(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.jobs[0].nextRun, "2026-07-04T12:15:00.000Z");
  assert.equal(fallbackDiagnostics.bundle.status.lastSuccessfulHeartbeat.device.sync.scheduler.jobs[0].lastError, "");
});

test("client profile import clears stale heartbeat snapshots", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-profile-heartbeat-reset-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const heartbeatRequests = [];
  let heartbeatMode = "success";

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      const body = await readJsonRequest(req);
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: body.code === "ABCD-1234" ? "old-pc" : "new-pc"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      heartbeatRequests.push(body);
      if (heartbeatMode === "fail") {
        jsonResponse(res, {
          ok: false,
          errorCode: "device_not_found",
          error: "device_not_found",
          message: "Device was not found on the server"
        }, 404);
        return;
      }
      jsonResponse(res, buildHeartbeatResponse({
        clientName: body.clientName,
        compatibility: compatibleHeartbeatCompatibility()
      }));
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const oldImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "ABCD-1234"
      })}`
    })
  });
  assert.equal(oldImport.status, 200);

  const oldStatus = await waitForHeartbeatCompatibility(baseUrl, "allow");
  assert.equal(oldStatus.heartbeat.ok, true);
  assert.equal(oldStatus.lastSuccessfulHeartbeat.device.clientName, "old-pc");

  heartbeatMode = "fail";
  const newImport = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "EFGH-5678"
      })}`
    })
  });
  assert.equal(newImport.status, 200);

  const newStatus = await waitForHeartbeatFailure(baseUrl);
  assert.equal(newStatus.profileSummary.clientName, "new-pc");
  assert.equal(newStatus.heartbeat.ok, false);
  assert.equal(newStatus.heartbeat.remoteErrorCode, "device_not_found");
  assert.equal(newStatus.lastSuccessfulHeartbeat, null);
  assert.ok(heartbeatRequests.some((request) => request.clientName === "new-pc"));
});

test("client status preserves structured remote heartbeat failures", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-heartbeat-failure-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const heartbeatRequests = [];

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: "missing-pc"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      heartbeatRequests.push(await readJsonRequest(req));
      jsonResponse(res, {
        errorCode: "device_not_found",
        message: "Device was not found on the server"
      }, 404);
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "MISS-0001"
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const status = await waitForHeartbeatFailure(baseUrl);
  assertClientStatusContract(status);
  assertHeartbeatContract(status.heartbeat);
  assert.equal(status.heartbeat.ok, false);
  assert.equal(status.heartbeat.server, mockServerUrl);
  assert.equal(status.heartbeat.status, 404);
  assert.equal(status.heartbeat.errorCode, "heartbeat_failed");
  assert.equal(status.heartbeat.remoteErrorCode, "device_not_found");
  assert.equal(status.lastSuccessfulHeartbeat, null);
  assert.match(status.heartbeat.error, /Device was not found on the server/);
  assert.match(status.heartbeat.message, /Heartbeat failed: Device was not found on the server/);
  assert.ok(heartbeatRequests.some((request) => request.clientName === "missing-pc"));

  const diagnostics = await (await fetch(`${baseUrl}/api/diagnostics/export`)).json();
  assert.equal(diagnostics.bundle.summary.heartbeatOk, false);
  assert.equal(diagnostics.bundle.summary.heartbeatErrorCode, "heartbeat_failed");
  assert.equal(diagnostics.bundle.summary.heartbeatRemoteErrorCode, "device_not_found");
});

test("client status omits non-stable remote heartbeat error codes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-heartbeat-unstable-error-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: "unstable-error-pc"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      await readJsonRequest(req);
      jsonResponse(res, {
        errorCode: "remote_new_failure",
        message: "Proxy returned an unregistered heartbeat failure"
      }, 502);
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "BADA-2222"
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const status = await waitForHeartbeatFailure(baseUrl, { requireRemoteErrorCode: false });
  assertClientStatusContract(status);
  assertHeartbeatContract(status.heartbeat);
  assert.equal(status.heartbeat.ok, false);
  assert.equal(status.heartbeat.status, 502);
  assert.equal(status.heartbeat.errorCode, "heartbeat_failed");
  assert.equal(Object.hasOwn(status.heartbeat, "remoteErrorCode"), false);
  assert.match(status.heartbeat.error, /Proxy returned an unregistered heartbeat failure/);

  const diagnostics = await (await fetch(`${baseUrl}/api/diagnostics/export`)).json();
  assert.equal(diagnostics.bundle.summary.heartbeatRemoteErrorCode, "");
});

test("client heartbeat treats malformed successful responses as heartbeat_failed", async () => {
  const cases = [
    {
      code: "R200-HEARTBEAT-HTML",
      claimCode: "HTML-2001",
      clientName: "heartbeat-html-pc",
      respond(res) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>gateway</title>");
      }
    },
    {
      code: "R200-HEARTBEAT-EMPTY",
      claimCode: "EMPT-2002",
      clientName: "heartbeat-empty-pc",
      respond(res) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("");
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-CONTRACT-DIAGNOSTICS",
      claimCode: "DIAG-2003",
      clientName: "heartbeat-missing-diagnostics-pc",
      respond(res) {
        jsonResponse(res, {
          ok: true,
          device: buildHeartbeatResponse({
            clientName: "heartbeat-missing-diagnostics-pc",
            compatibility: compatibleHeartbeatCompatibility()
          }).device
        });
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-CONTRACT-DEVICE",
      claimCode: "DEVC-2004",
      clientName: "heartbeat-missing-device-pc",
      respond(res) {
        jsonResponse(res, {
          ok: true,
          diagnostics: buildHeartbeatResponse({
            clientName: "heartbeat-missing-device-pc",
            compatibility: compatibleHeartbeatCompatibility()
          }).diagnostics
        });
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-CONTRACT-COMPATIBILITY",
      claimCode: "COMP-2005",
      clientName: "heartbeat-missing-compatibility-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.device.compatibility;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-OK-FALSE",
      claimCode: "OKFL-2006",
      clientName: "heartbeat-ok-false-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-ok-false-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.ok = false;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-DIAGNOSTICS-ROLE",
      claimCode: "ROLE-2007",
      clientName: "heartbeat-bad-diagnostics-role-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-diagnostics-role-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.diagnostics.role = "client";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-DIAGNOSTICS-PROTOCOL",
      claimCode: "PROT-2008",
      clientName: "heartbeat-bad-diagnostics-protocol-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-diagnostics-protocol-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.diagnostics.protocols.heartbeat;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-DIAGNOSTICS-APP",
      claimCode: "DAPP-2025",
      clientName: "heartbeat-bad-diagnostics-app-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-diagnostics-app-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.diagnostics.app = "other-product";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-STRING-DIAGNOSTICS-PROTOCOL",
      claimCode: "DSTR-2026",
      clientName: "heartbeat-string-diagnostics-protocol-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-string-diagnostics-protocol-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.diagnostics.protocols.heartbeat = "1";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-INCONSISTENT-COMPATIBILITY",
      claimCode: "CINC-2027",
      clientName: "heartbeat-inconsistent-compatibility-pc",
      respond(res) {
        jsonResponse(res, buildHeartbeatResponse({
          clientName: "heartbeat-inconsistent-compatibility-pc",
          compatibility: warningHeartbeatCompatibility()
        }));
      }
    },
    {
      code: "R200-HEARTBEAT-FORGED-ALLOW-POLICY",
      claimCode: "CFAP-2028",
      clientName: "heartbeat-forged-allow-policy-pc",
      respond(res) {
        const compatibility = warningHeartbeatCompatibility();
        compatibility.action = "none";
        compatibility.policy = {
          heartbeat: "allow",
          profileIssue: "allow",
          syncRun: "allow",
          adminActions: "allow",
          reason: "none"
        };
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-forged-allow-policy-pc",
          compatibility
        });
        response.diagnostics.protocols.heartbeat = 2;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-STATUS",
      claimCode: "CSTA-2009",
      clientName: "heartbeat-missing-compatibility-status-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-status-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.device.compatibility.status;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-SEVERITY",
      claimCode: "CSEV-2010",
      clientName: "heartbeat-missing-compatibility-severity-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-severity-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.device.compatibility.severity;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-STATUS",
      claimCode: "CBST-2011",
      clientName: "heartbeat-bad-compatibility-status-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-status-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.compatibility.status = "ok";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-ACTION",
      claimCode: "CBAA-2012",
      clientName: "heartbeat-bad-compatibility-action-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-action-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.compatibility.action = "ignore";
        response.device.compatibility.policy.reason = "ignore";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-SEVERITY",
      claimCode: "CBSE-2013",
      clientName: "heartbeat-bad-compatibility-severity-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-severity-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.compatibility.severity = "error";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-POLICY-VALUE",
      claimCode: "CBPV-2014",
      clientName: "heartbeat-bad-compatibility-policy-value-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-policy-value-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.compatibility.policy.syncRun = "block";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-COMPATIBILITY-REASON-MISMATCH",
      claimCode: "CRMM-2015",
      clientName: "heartbeat-compatibility-reason-mismatch-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-compatibility-reason-mismatch-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.compatibility.policy.reason = "manual_check";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-ISSUE-TYPE",
      claimCode: "CMIT-2016",
      clientName: "heartbeat-missing-compatibility-issue-type-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-issue-type-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        delete response.device.compatibility.issues[0].type;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-ISSUE-LOCAL",
      claimCode: "CMIL-2017",
      clientName: "heartbeat-missing-compatibility-issue-local-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-issue-local-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        delete response.device.compatibility.issues[0].local;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-ISSUE-REMOTE",
      claimCode: "CMIR-2018",
      clientName: "heartbeat-missing-compatibility-issue-remote-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-issue-remote-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        delete response.device.compatibility.issues[0].remote;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-COMPATIBILITY-ISSUE-MESSAGE",
      claimCode: "CMIM-2019",
      clientName: "heartbeat-missing-compatibility-issue-message-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-compatibility-issue-message-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        delete response.device.compatibility.issues[0].message;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-ISSUE-LOCAL",
      claimCode: "CBIL-2020",
      clientName: "heartbeat-bad-compatibility-issue-local-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-issue-local-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        response.device.compatibility.issues[0].local = 0;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-BAD-COMPATIBILITY-ISSUE-REMOTE",
      claimCode: "CBIR-2021",
      clientName: "heartbeat-bad-compatibility-issue-remote-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-bad-compatibility-issue-remote-pc",
          compatibility: warningHeartbeatCompatibility()
        });
        response.device.compatibility.issues[0].remote = 1.5;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-MISSING-SYNC",
      claimCode: "SYNC-2022",
      clientName: "heartbeat-missing-sync-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-missing-sync-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.device.sync;
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-SYNCSTATE-MISMATCH",
      claimCode: "SSTA-2023",
      clientName: "heartbeat-syncstate-mismatch-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-syncstate-mismatch-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.syncState = "syncing";
        response.device.sync.state = "idle";
        jsonResponse(res, response);
      }
    },
    {
      code: "R200-HEARTBEAT-SPEED-MISMATCH",
      claimCode: "SPED-2024",
      clientName: "heartbeat-speed-mismatch-pc",
      respond(res) {
        const response = buildHeartbeatResponse({
          clientName: "heartbeat-speed-mismatch-pc",
          compatibility: compatibleHeartbeatCompatibility()
        });
        response.device.speedMbps = 3;
        response.device.sync.speedMbps = 7;
        jsonResponse(res, response);
      }
    }
  ];

  for (const scenario of cases) {
    const harness = await startClientHeartbeatHarness({
      tempPrefix: `sfsc-client-${scenario.code.toLowerCase()}-`,
      clientName: scenario.clientName,
      heartbeatHandler: async (_req, res) => {
        scenario.respond(res);
      }
    });
    try {
      const importResponse = await fetch(`${harness.baseUrl}/api/profile/import`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          code: claimImportTKey(harness.mockServerUrl, scenario.claimCode)
        })
      });
      assert.equal(importResponse.status, 200, scenario.code);

      const status = await waitForHeartbeatFailure(harness.baseUrl, { requireRemoteErrorCode: false });
      assertClientStatusContract(status);
      assertHeartbeatContract(status.heartbeat);
      assert.equal(status.heartbeat.ok, false);
      assert.equal(status.heartbeat.status, 200);
      assert.equal(status.heartbeat.errorCode, "heartbeat_failed");
      assert.equal(Object.hasOwn(status.heartbeat, "remoteErrorCode"), false);
      assert.match(status.heartbeat.error, /Malformed heartbeat response/);
      assert.match(status.heartbeat.message, /Heartbeat failed: Malformed heartbeat response/);
      assert.equal(status.lastSuccessfulHeartbeat, null);
      assert.ok(
        harness.heartbeatRequests.some((request) => request.clientName === scenario.clientName),
        scenario.code
      );
    } finally {
      await harness.cleanup();
    }
  }
});

test("client heartbeat does not replace lastSuccessfulHeartbeat after malformed successful responses", async () => {
  let heartbeatMode = "success";
  const harness = await startClientHeartbeatHarness({
    tempPrefix: "sfsc-client-heartbeat-malformed-preserve-",
    clientName: "heartbeat-preserve-pc",
    heartbeatHandler: async (_req, res, body) => {
      if (heartbeatMode === "malformed") {
        const response = buildHeartbeatResponse({
          clientName: body.clientName,
          compatibility: compatibleHeartbeatCompatibility()
        });
        delete response.device.compatibility;
        jsonResponse(res, response);
        return;
      }
      jsonResponse(res, buildHeartbeatResponse({
        clientName: body.clientName,
        compatibility: compatibleHeartbeatCompatibility()
      }));
    }
  });
  try {
    const importResponse = await fetch(`${harness.baseUrl}/api/profile/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        code: claimImportTKey(harness.mockServerUrl, "PRSV-2006")
      })
    });
    assert.equal(importResponse.status, 200);

    const successfulStatus = await waitForHeartbeatCompatibility(harness.baseUrl, "allow");
    assertHeartbeatContract(successfulStatus.lastSuccessfulHeartbeat, "lastSuccessfulHeartbeat");
    assert.equal(successfulStatus.lastSuccessfulHeartbeat.ok, true);
    assert.equal(successfulStatus.lastSuccessfulHeartbeat.device.clientName, "heartbeat-preserve-pc");

    heartbeatMode = "malformed";
    const status = await waitForHeartbeatFailure(harness.baseUrl, { requireRemoteErrorCode: false });
    assertClientStatusContract(status);
    assertHeartbeatContract(status.heartbeat);
    assert.equal(status.heartbeat.ok, false);
    assert.equal(status.heartbeat.status, 200);
    assert.equal(status.heartbeat.errorCode, "heartbeat_failed");
    assert.equal(Object.hasOwn(status.heartbeat, "remoteErrorCode"), false);
    assert.match(status.heartbeat.error, /Malformed heartbeat response/);
    assertHeartbeatContract(status.lastSuccessfulHeartbeat, "lastSuccessfulHeartbeat");
    assert.equal(status.lastSuccessfulHeartbeat.ok, true);
    assert.equal(status.lastSuccessfulHeartbeat.device.clientName, "heartbeat-preserve-pc");
    assert.equal(status.lastSuccessfulHeartbeat.sentAt, successfulStatus.lastSuccessfulHeartbeat.sentAt);
  } finally {
    await harness.cleanup();
  }
});

test("client local API enforces sync compatibility confirmation from heartbeat", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-compat-"));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  let heartbeatMode = "warn";

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: "warn-pc"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      if (heartbeatMode === "fail") {
        jsonResponse(res, {
          ok: false,
          errorCode: "device_not_found",
          error: "device_not_found",
          message: "Device was not found on the server"
        }, 404);
        return;
      }
      const diagnostics = buildServerDiagnostics({
        heartbeat: heartbeatMode === "warn" ? 2 : 1
      });
      const compatibility = compareHeartbeatDiagnostics(diagnostics, body.diagnostics);
      jsonResponse(res, buildHeartbeatResponse({
        clientName: "warn-pc",
        compatibility,
        diagnostics
      }));
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  t.after(async () => {
    await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
    if (!child.killed && child.exitCode === null) {
      child.kill();
    }
    mockServer.close();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForClient(baseUrl, child, tempRoot);

  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "WARN-0001"
      })}`
    })
  });
  assert.equal(importResponse.status, 200);

  const status = await waitForHeartbeatCompatibility(baseUrl, "warn");
  assert.equal(status.heartbeat.ok, true);
  assert.equal(status.heartbeat.compatibility.policy.syncRun, "warn");
  assert.equal(status.lastSuccessfulHeartbeat.ok, true);
  assert.equal(status.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "warn");

  const job = {
    localPath: "D:\\Compat",
    direction: "upload"
  };

  const saveWithoutConfirmation = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(saveWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await saveWithoutConfirmation.json(), "saveWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const previewWithoutConfirmation = await fetch(`${baseUrl}/api/sync/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(previewWithoutConfirmation.status, 503);
  assertHttpErrorResponseContract(await previewWithoutConfirmation.json(), "previewWithoutConfirmation", {
    errorCode: "missing_rclone_binary"
  });

  const runWithoutConfirmation = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(runWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await runWithoutConfirmation.json(), "runWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  heartbeatMode = "fail";
  const failedHeartbeatStatus = await waitForHeartbeatFailure(baseUrl);
  assert.equal(failedHeartbeatStatus.heartbeat.ok, false);
  assert.equal(failedHeartbeatStatus.heartbeat.remoteErrorCode, "device_not_found");
  assertHeartbeatContract(failedHeartbeatStatus.lastSuccessfulHeartbeat, "lastSuccessfulHeartbeat");
  assert.equal(failedHeartbeatStatus.lastSuccessfulHeartbeat.ok, true);
  assert.equal(failedHeartbeatStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "warn");

  const saveAfterFailedHeartbeat = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(saveAfterFailedHeartbeat.status, 400);
  assertHttpErrorResponseContract(await saveAfterFailedHeartbeat.json(), "saveAfterFailedHeartbeat", {
    errorCode: "danger_confirmation_required"
  });

  const runAfterFailedHeartbeat = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(runAfterFailedHeartbeat.status, 400);
  assertHttpErrorResponseContract(await runAfterFailedHeartbeat.json(), "runAfterFailedHeartbeat", {
    errorCode: "danger_confirmation_required"
  });

  const saveWithConfirmation = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job, confirmCompatibilityWarning: true })
  });
  assert.equal(saveWithConfirmation.status, 200);
  const saveWithConfirmationPayload = await saveWithConfirmation.json();
  assertClientJobSaveResponseContract(saveWithConfirmationPayload, "saveWithConfirmation");
  assert.equal(saveWithConfirmationPayload.job.localPath, "D:\\Compat");
  assert.equal(saveWithConfirmationPayload.job.clientName, "warn-pc");

  const runWithConfirmation = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job, confirmCompatibilityWarning: true })
  });
  assert.equal(runWithConfirmation.status, 503);
  assertHttpErrorResponseContract(await runWithConfirmation.json(), "runWithConfirmation", {
    errorCode: "missing_rclone_binary"
  });

  heartbeatMode = "allow";
  const allowHeartbeatStatus = await waitForHeartbeatCompatibility(baseUrl, "allow");
  assert.equal(allowHeartbeatStatus.heartbeat.ok, true);
  assert.equal(allowHeartbeatStatus.heartbeat.compatibility.policy.syncRun, "allow");
  assert.equal(allowHeartbeatStatus.lastSuccessfulHeartbeat.ok, true);
  assert.equal(allowHeartbeatStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "allow");

  const saveAfterAllowHeartbeat = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(saveAfterAllowHeartbeat.status, 200);
  const saveAfterAllowHeartbeatPayload = await saveAfterAllowHeartbeat.json();
  assertClientJobSaveResponseContract(saveAfterAllowHeartbeatPayload, "saveAfterAllowHeartbeat");

  const runAfterAllowHeartbeat = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(runAfterAllowHeartbeat.status, 503);
  assertHttpErrorResponseContract(await runAfterAllowHeartbeat.json(), "runAfterAllowHeartbeat", {
    errorCode: "missing_rclone_binary"
  });

  const destructiveJob = {
    ...job,
    destructiveSync: true
  };

  const saveDestructiveWithoutConfirmation = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: destructiveJob,
      confirmCompatibilityWarning: true
    })
  });
  assert.equal(saveDestructiveWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await saveDestructiveWithoutConfirmation.json(), "saveDestructiveWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const runDestructiveWithoutConfirmation = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: destructiveJob,
      confirmCompatibilityWarning: true
    })
  });
  assert.equal(runDestructiveWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await runDestructiveWithoutConfirmation.json(), "runDestructiveWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const saveDestructiveWithConfirmation = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: destructiveJob,
      confirmCompatibilityWarning: true,
      confirmDestructiveSync: true
    })
  });
  assert.equal(saveDestructiveWithConfirmation.status, 200);
  const saveDestructiveWithConfirmationPayload = await saveDestructiveWithConfirmation.json();
  assertClientJobSaveResponseContract(saveDestructiveWithConfirmationPayload, "saveDestructiveWithConfirmation");
  assert.equal(saveDestructiveWithConfirmationPayload.job.destructiveSync, true);

  const runDestructiveWithConfirmation = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      job: destructiveJob,
      confirmCompatibilityWarning: true,
      confirmDestructiveSync: true
    })
  });
  assert.equal(runDestructiveWithConfirmation.status, 503);
  assertHttpErrorResponseContract(await runDestructiveWithConfirmation.json(), "runDestructiveWithConfirmation", {
    errorCode: "missing_rclone_binary"
  });
});

test("client restores lastSuccessfulHeartbeat after restart for compatibility confirmation", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-heartbeat-persist-"));
  const serverPort = await getFreePort();
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  let heartbeatMode = "warn";
  let child = null;
  let baseUrl = "";

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName: "persist-warn-pc"
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      if (heartbeatMode === "fail") {
        jsonResponse(res, {
          ok: false,
          errorCode: "device_not_found",
          error: "device_not_found",
          message: "Device was not found on the server"
        }, 404);
        return;
      }
      const diagnostics = buildServerDiagnostics({ heartbeat: 2 });
      jsonResponse(res, buildHeartbeatResponse({
        clientName: "persist-warn-pc",
        compatibility: compareHeartbeatDiagnostics(diagnostics, body.diagnostics),
        diagnostics
      }));
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  async function startClient() {
    const clientPort = await getFreePort();
    const url = `http://127.0.0.1:${clientPort}`;
    const proc = spawn(process.execPath, [clientEntry], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(clientPort),
        SFSC_PORTABLE_ROOT: tempRoot,
        SFSC_APP_ROOT: join(projectRoot, "client"),
        SFSC_OPEN_BROWSER: "0",
        SFSC_HEARTBEAT_MS: "250",
        SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
      }
    });
    await waitForClient(url, proc, tempRoot);
    child = proc;
    baseUrl = url;
    return { proc, url };
  }

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    mockServer.close();
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  await startClient();
  const importResponse = await fetch(`${baseUrl}/api/profile/import`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      code: `SFSC1-${base64UrlJson({
        version: 1,
        type: "claim",
        server: mockServerUrl,
        code: "WARN-0001"
      })}`
    })
  });
  assert.equal(importResponse.status, 200);
  const warnedStatus = await waitForHeartbeatCompatibility(baseUrl, "warn");
  assert.equal(warnedStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "warn");

  const snapshotText = await readFile(join(tempRoot, "data", "last-successful-heartbeat.json"), "utf8");
  assert.equal(snapshotText.includes("persist-warn-pc"), true);
  await shutdownClient(baseUrl, child);
  heartbeatMode = "fail";

  await startClient();
  const restoredStatus = await (await fetch(`${baseUrl}/api/client/status`)).json();
  assertClientStatusContract(restoredStatus);
  assert.equal(restoredStatus.lastSuccessfulHeartbeat.ok, true);
  assert.equal(restoredStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "warn");

  const job = {
    localPath: "D:\\PersistCompat",
    direction: "upload"
  };
  const saveWithoutConfirmation = await fetch(`${baseUrl}/api/jobs/save`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(saveWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await saveWithoutConfirmation.json(), "persist.saveWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const failedHeartbeatStatus = await waitForHeartbeatFailure(baseUrl);
  assert.equal(failedHeartbeatStatus.heartbeat.ok, false);
  assert.equal(failedHeartbeatStatus.lastSuccessfulHeartbeat.compatibility.policy.syncRun, "warn");

  const runWithoutConfirmation = await fetch(`${baseUrl}/api/sync/run`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ job })
  });
  assert.equal(runWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await runWithoutConfirmation.json(), "persist.runWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });
});

// fetch() derives Host from the URL, so a spoofed Host needs a raw request.
function rawClientRequest(port, method, path, hostHeader, extraHeaders = {}, body = null) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      setHost: false,
      headers: {
        host: hostHeader,
        connection: "close",
        ...extraHeaders,
        ...(body === null ? {} : { "content-length": Buffer.byteLength(body) })
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });
}

function rcloneRemoteConfigSecretEnvValues(rclone = {}) {
  return Object.entries(rclone?.remoteConfig?.env || {})
    .filter(([key]) => /_SECRET_ACCESS_KEY$/.test(key))
    .map(([, value]) => value);
}

async function installFakeSyncTools(root) {
  const binRoot = join(root, "resources", "bin", "win32");
  await mkdir(binRoot, { recursive: true });
  for (const name of ["sing-box.exe", "rclone.exe"]) {
    const target = join(binRoot, name);
    await copyFile(process.execPath, target);
    await chmod(target, 0o755).catch(() => {});
  }

  const prelude = String.raw`
const fs = require("node:fs");
const path = require("node:path");
function recordFakeTool(tool, extra = {}) {
  const log = process.env.SFSC_FAKE_TOOL_LOG;
  if (!log) return;
  const event = { tool, argv: process.argv.slice(2), ...extra };
  fs.appendFileSync(log, JSON.stringify(event) + "\n");
}
`;

  await writeFile(join(root, "run"), `${prelude}
const net = require("node:net");
recordFakeTool("singbox-run");
const configIndex = process.argv.indexOf("-c");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : "";
const config = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const inbound = Array.isArray(config.inbounds) ? config.inbounds[0] || {} : {};
const listen = inbound.listen || "127.0.0.1";
const port = Number(inbound.listen_port || 18081);
const server = net.createServer((socket) => socket.end());
server.listen(port, listen);
setInterval(() => {}, 1000);
`, "utf8");

  await writeFile(join(root, "check"), `${prelude}
recordFakeTool("singbox-check");
const exitCode = Number(process.env.SFSC_FAKE_SINGBOX_CHECK_EXIT_CODE || 0);
if (exitCode !== 0) {
  process.stderr.write("sing-box check failed\\n");
  process.exit(exitCode);
}
process.stdout.write("sing-box check ok\\n");
`, "utf8");

  await writeFile(join(root, "version"), `${prelude}
const executableName = path.basename(process.execPath).toLowerCase();
if (executableName.includes("rclone")) {
  recordFakeTool("rclone-version");
  process.stdout.write("rclone v1.74.3\\n");
} else {
  recordFakeTool("singbox-version");
  process.stdout.write("sing-box version 1.13.14\\n");
}
`, "utf8");

  await writeFile(join(root, "config"), `${prelude}
recordFakeTool("rclone-config", {
  secretEnv: Object.entries(process.env)
    .filter(([key]) => /^RCLONE_CONFIG_.*_SECRET_ACCESS_KEY$/.test(key))
    .map(([, value]) => value)[0] || ""
});
function finishConfig() {
  const raw = process.env.SFSC_FAKE_RAW_SECRET || "";
  const tunnel = process.env.SFSC_FAKE_TUNNEL_URI || "";
  if (process.env.SFSC_FAKE_CONFIG_STDERR_SECRET === "1") {
    process.stderr.write("secret_access_key " + raw + "\\n");
    process.stderr.write("S3_SECRET_ACCESS_KEY=" + raw + "\\n");
    process.stderr.write("{\\"secretAccessKey\\":\\"" + raw + "\\"}\\n");
    process.stderr.write("bare-secret " + raw + "\\n");
    if (tunnel) process.stderr.write(tunnel + "\\n");
  }
  if (process.env.SFSC_FAKE_CONFIG_STDOUT_SECRET === "1") {
    process.stdout.write("stdout-secret " + raw + "\\n");
  }
  const exitCode = Number(process.env.SFSC_FAKE_CONFIG_EXIT_CODE || 0);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  const configIndex = process.argv.indexOf("--config");
  if (configIndex >= 0 && process.argv[configIndex + 1]) {
    const configPath = process.argv[configIndex + 1];
    if (process.env.SFSC_FAKE_CONFIG_SKIP_WRITE !== "1") {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "# fake rclone config\\n", "utf8");
    }
  }
  process.stdout.write("rclone config ok\\n");
}
const configDelayMs = Number(process.env.SFSC_FAKE_CONFIG_DELAY_MS || 0);
if (configDelayMs > 0) {
  setTimeout(finishConfig, configDelayMs);
} else {
  finishConfig();
}
if (process.env.SFSC_FAKE_REMOVE_RCLONE_AFTER_CONFIG === "1") {
  try {
    fs.renameSync(process.execPath, process.execPath + ".moved");
    recordFakeTool("rclone-exe-renamed", { ok: true });
  } catch (error) {
    recordFakeTool("rclone-exe-renamed", { ok: false, code: error.code, message: error.message });
  }
}
`, "utf8");

const syncScript = `${prelude}
recordFakeTool("rclone-sync", { allProxy: process.env.ALL_PROXY || "" });
const raw = process.env.SFSC_FAKE_RAW_SECRET || "";
process.stdout.write("Transferred: 1 MiB / 2 MiB, 50%, 1 MiB/s, ETA 1s\\n");
if (process.env.SFSC_FAKE_SYNC_CHUNKED_CONFLICT === "1") {
  process.stdout.write("ERROR : projects/chunked.txt: file changed on both sides - con");
  setTimeout(() => process.stdout.write("flict\\n"), 25);
}
process.stderr.write("secret_access_key " + raw + "\\n");
process.stderr.write("S3_SECRET_ACCESS_KEY=" + raw + "\\n");
process.stderr.write("{\\"secretAccessKey\\":\\"" + raw + "\\"}\\n");
let exiting = false;
function exitAfterStop(signal) {
  if (exiting) return;
  exiting = true;
  recordFakeTool("rclone-sync-stop-signal", { signal });
  setTimeout(
    () => process.exit(Number(process.env.SFSC_FAKE_SYNC_STOP_EXIT_CODE || 0)),
    Number(process.env.SFSC_FAKE_SYNC_STOP_DELAY_MS || 500)
  );
}
process.on("SIGTERM", () => exitAfterStop("SIGTERM"));
process.on("SIGINT", () => exitAfterStop("SIGINT"));
setTimeout(
  () => process.exit(Number(process.env.SFSC_FAKE_SYNC_EXIT_CODE || 7)),
  Number(process.env.SFSC_FAKE_SYNC_EXIT_DELAY_MS || 100)
);
`;
  for (const action of ["copy", "sync", "bisync"]) {
    await writeFile(join(root, action), syncScript, "utf8");
  }
}

async function shutdownClient(baseUrl, child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await fetch(`${baseUrl}/api/client/shutdown`, { method: "POST" }).catch(() => {});
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]).catch(() => {});
  if (!child.killed && child.exitCode === null) {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
}

async function waitForFakeToolEvent(file, tool) {
  const deadline = Date.now() + 5000;
  let events = [];
  while (Date.now() < deadline) {
    events = await readFakeToolEvents(file).catch(() => []);
    if (events.some((event) => event.tool === tool)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fake tool event check timed out: ${tool} ${JSON.stringify(events)}`);
}

async function readFakeToolEvents(file) {
  const text = await readFile(file, "utf8");
  return text.trim()
    ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    : [];
}

async function removeTempRoot(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForOutput(readOutput, pattern, child, stderr = "") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const output = readOutput();
    if (pattern.test(output)) {
      return output;
    }
    if (child.exitCode !== null) {
      throw new Error(`client exited before output matched: ${child.exitCode}\nstdout: ${output}\nstderr: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const output = readOutput();
  throw new Error(`client output check timed out: expected ${pattern}\nstdout: ${output}\nstderr: ${stderr}`);
}

async function waitForClient(baseUrl, child, expectedRoot) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`client exited before status check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/client/status`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.ok && (!expectedRoot || payload.paths?.root === expectedRoot)) return payload;
        lastError = new Error(`unexpected client root: ${payload.paths?.root || "unknown"}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`client status check timed out: ${lastError?.message || "no response"}`);
}

async function waitForServerHealth(baseUrl, child) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.ok) return payload;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health check timed out: ${lastError?.message || "no response"}`);
}

async function waitForHeartbeatStatus(baseUrl) {
  const deadline = Date.now() + 5000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/client/status`);
    if (response.ok) {
      const payload = await response.json();
      lastStatus = payload.heartbeat || null;
      if (payload.heartbeat?.ok && payload.heartbeat?.device?.sync?.currentFile) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`heartbeat status check timed out: ${JSON.stringify(lastStatus)}`);
}

async function waitForHeartbeatFailure(baseUrl, options = {}) {
  const deadline = Date.now() + 5000;
  let lastStatus = null;
  const requireRemoteErrorCode = options.requireRemoteErrorCode !== false;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/client/status`);
    if (response.ok) {
      const payload = await response.json();
      lastStatus = payload.heartbeat || null;
      if (
        payload.heartbeat?.ok === false &&
        payload.heartbeat?.errorCode === "heartbeat_failed" &&
        (!requireRemoteErrorCode || payload.heartbeat?.remoteErrorCode)
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`heartbeat failure check timed out: ${JSON.stringify(lastStatus)}`);
}

async function waitForHeartbeatCompatibility(baseUrl, expectedSyncRun = "warn") {
  const deadline = Date.now() + 5000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/client/status`);
    if (response.ok) {
      const payload = await response.json();
      lastStatus = payload.heartbeat || null;
      if (payload.heartbeat?.ok && payload.heartbeat?.compatibility?.policy?.syncRun === expectedSyncRun) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`heartbeat compatibility check timed out: ${JSON.stringify(lastStatus)}`);
}

async function waitForSchedulerError(baseUrl, expectedErrorCode) {
  const deadline = Date.now() + 5000;
  let lastScheduler = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/client/status`);
    if (response.ok) {
      const payload = await response.json();
      lastScheduler = payload.scheduler || null;
      if (payload.scheduler?.lastError === expectedErrorCode) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`scheduler error check timed out: ${JSON.stringify(lastScheduler)}`);
}

async function waitForSyncRunning(baseUrl) {
  const deadline = Date.now() + 5000;
  let lastSync = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/client/status`);
    if (response.ok) {
      const payload = await response.json();
      lastSync = payload.processes?.sync || null;
      if (payload.processes?.sync?.running) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sync running check timed out: ${JSON.stringify(lastSync)}`);
}

async function waitForSyncHistoryStatus(baseUrl, expectedStatus) {
  const deadline = Date.now() + 12000;
  let lastHistory = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/sync/history`);
    if (response.ok) {
      const payload = await response.json();
      assertClientSyncHistoryContract(payload, "waitForSyncHistoryStatus");
      lastHistory = payload.history || [];
      if (payload.history?.[0]?.status === expectedStatus) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sync history status check timed out: ${JSON.stringify(lastHistory)}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.errorCode || payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function startClientHeartbeatHarness({ tempPrefix, clientName, heartbeatHandler }) {
  const tempRoot = await mkdtemp(join(tmpdir(), tempPrefix));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;
  const heartbeatRequests = [];

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      jsonResponse(res, {
        profile: buildMockProfile({
          server: mockServerUrl,
          clientName
        })
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/devices/heartbeat") {
      const body = await readJsonRequest(req);
      heartbeatRequests.push(body);
      await heartbeatHandler(req, res, body);
      return;
    }

    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "250",
      SFSC_HEARTBEAT_TIMEOUT_MS: "2000"
    }
  });

  await waitForClient(baseUrl, child, tempRoot);

  return {
    baseUrl,
    mockServerUrl,
    heartbeatRequests,
    cleanup: async () => {
      await shutdownClient(baseUrl, child);
      mockServer.close();
      await Promise.race([
        once(mockServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
      await removeTempRoot(tempRoot);
    }
  };
}

async function runClientSmoke(baseUrl, options = {}) {
  const args = [
    clientSmokeEntry,
    "--base-url",
    baseUrl
  ];
  if (options.jsonReportPath) {
    args.push("--json-report", options.jsonReportPath);
  }
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function readJsonRequest(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
  }
  return body ? JSON.parse(body) : {};
}

function jsonResponse(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function startClaimImportHarness(t, { tempPrefix = "sfsc-client-claim-import-", redeemHandler, env = {} } = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), tempPrefix));
  const clientPort = await getFreePort();
  const serverPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  const mockServerUrl = `http://127.0.0.1:${serverPort}`;

  const mockServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/claims/redeem") {
      await redeemHandler(req, res);
      return;
    }
    jsonResponse(res, { ok: false, errorCode: "not_found" }, 404);
  });
  mockServer.listen(serverPort, "127.0.0.1");
  await once(mockServer, "listening");

  const child = spawn(process.execPath, [clientEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(clientPort),
      SFSC_PORTABLE_ROOT: tempRoot,
      SFSC_APP_ROOT: join(projectRoot, "client"),
      SFSC_OPEN_BROWSER: "0",
      SFSC_HEARTBEAT_MS: "60000",
      ...env
    }
  });

  t.after(async () => {
    await shutdownClient(baseUrl, child);
    mockServer.close();
    await Promise.race([
      once(mockServer, "close"),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
    await removeTempRoot(tempRoot);
  });

  await waitForClient(baseUrl, child, tempRoot);
  return { baseUrl, mockServerUrl, tempRoot };
}

function claimImportTKey(server, code) {
  return `SFSC1-${base64UrlJson({
    version: 1,
    type: "claim",
    server,
    code
  })}`;
}

async function readClaimRecovery(tempRoot) {
  return JSON.parse(await readFile(join(tempRoot, "data", "claim-recovery.json"), "utf8"));
}

function assertClaimRecoveryRetained(recovery, { server, request, rawCode, tKey }) {
  assert.equal(recovery.type, "claim-import-recovery");
  assert.equal(recovery.claim.server, server);
  assert.equal(recovery.claim.code, undefined);
  assert.match(recovery.claim.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(recovery.clientRedeemId, request.clientRedeemId);
  assert.equal(recovery.clientInstallId, request.clientInstallId);
  assert.match(recovery.clientRedeemId, /^[0-9a-f-]{36}$/);
  assert.match(recovery.clientInstallId, /^[0-9a-f-]{36}$/);
  const serialized = JSON.stringify(recovery);
  assert.equal(serialized.includes(rawCode), false);
  assert.equal(serialized.includes(tKey), false);
  assert.equal(serialized.includes("top-secret-value"), false);
}

function buildMockProfile({ server, clientName }) {
  return {
    version: 1,
    profileId: `profile-${clientName}`,
    clientName,
    issuedAt: "2026-07-04T12:00:00.000Z",
    expiresAt: null,
    source: {
      type: "claim",
      server
    },
    tunnel: {
      type: "vless",
      uri: tunnelUri
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: "heartbeat-secret"
    },
    storage: {
      type: "s3",
      remoteName: "home-minio",
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: clientName,
      secretAccessKey: "top-secret-value",
      prefix: `devices/${clientName}`
    },
    defaults: {
      localProxyPort: 18082,
      transfers: 4,
      streams: 8,
      checkers: 8,
      chunkSize: "16M",
      retries: 3,
      lowLevelRetries: 10,
      bandwidthLimit: "off",
      schedule: { mode: "manual" }
    }
  };
}

function buildServerDiagnostics(protocols = {}) {
  const diagnostics = buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" });
  return {
    ...diagnostics,
    protocols: {
      ...diagnostics.protocols,
      ...protocols
    }
  };
}

function compareHeartbeatDiagnostics(serverDiagnostics, clientDiagnostics) {
  return compareRuntimeDiagnostics(serverDiagnostics, clientDiagnostics, {
    localRole: "server",
    remoteRole: "client"
  });
}

function buildHeartbeatResponse({ clientName, compatibility, diagnostics = buildServerDiagnostics() }) {
  return {
    ok: true,
    diagnostics,
    device: {
      id: `user-${clientName}`,
      clientName,
      enabled: true,
      online: true,
      status: "online",
      lastSeenAt: "2026-07-04T12:00:00.000Z",
      bucket: "home-sync",
      prefix: `devices/${clientName}`,
      clientVersion: "0.3.0-rc.1",
      lastRemoteAddress: "127.0.0.1",
      syncState: "idle",
      speedMbps: 0,
      compatibility,
      sync: {
        state: "idle",
        speedMbps: 0,
        progressPercent: null,
        currentFile: "",
        currentJob: null,
        conflicts: {
          count: 0,
          files: [],
          truncated: false
        },
        scheduler: {
          enabled: true,
          intervalMs: 15000,
          nextRun: null,
          lastTriggeredAt: null,
          lastError: "",
          jobs: []
        },
        lastRun: null
      }
    }
  };
}

function compatibleHeartbeatCompatibility() {
  return {
    ok: true,
    status: "compatible",
    action: "none",
    severity: "ok",
    policy: {
      heartbeat: "allow",
      profileIssue: "allow",
      syncRun: "allow",
      adminActions: "allow",
      reason: "none"
    },
    localRole: "server",
    remoteRole: "client",
    issues: []
  };
}

function warningHeartbeatCompatibility() {
  return {
    ok: false,
    status: "mismatch",
    action: "upgrade_remote",
    severity: "warning",
    policy: {
      heartbeat: "allow",
      profileIssue: "warn",
      syncRun: "warn",
      adminActions: "allow",
      reason: "upgrade_remote"
    },
    localRole: "server",
    remoteRole: "client",
    issues: [
      {
        field: "heartbeat",
        type: "remote_older",
        local: 2,
        remote: 1,
        message: "heartbeat protocol mismatch: local v2, remote v1"
      }
    ]
  };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function releaseManifestFiles(packageName, overrides = {}) {
  const names = packageName === "SyncraftClient" ? [
    "Syncraft.exe",
    "app/package.json",
    "app/client/src/clientServer.js",
    "app/client/src/paths.js",
    "app/client/src/store.js",
    "app/client/src/diagnosticBundle.js",
    "app/client/src/processRunner.js",
    "app/client/src/rcloneStats.js",
    "app/client/src/profileImport.js",
    "app/client/src/launcher.cjs",
    "app/client/src/Launcher.cs",
    "app/client/public/index.html",
    "app/client/public/app.js",
    "app/client/public/styles.css",
    "app/src/core/index.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ] : [
    "Syncraft.exe",
    "resources/app/package.json",
    "resources/app/client/electron/main.cjs",
    "resources/app/client/electron/preload.cjs",
    "resources/app/client/src/clientServer.js",
    "resources/app/client/src/paths.js",
    "resources/app/client/src/store.js",
    "resources/app/client/src/diagnosticBundle.js",
    "resources/app/client/src/processRunner.js",
    "resources/app/client/src/rcloneStats.js",
    "resources/app/client/src/profileImport.js",
    "resources/app/client/src/launcher.cjs",
    "resources/app/client/src/Launcher.cs",
    "resources/app/client/public/index.html",
    "resources/app/client/public/app.js",
    "resources/app/client/public/styles.css",
    "resources/app/src/core/index.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ];
  return names.map((name, index) => ({
    name,
    size: overrides[name]?.size ?? index + 1,
    sha256: overrides[name]?.sha256 ?? String(index % 10).repeat(64)
  }));
}

async function readClientStateFiles(root) {
  const dataRoot = join(root, "data");
  const entries = {};
  for (const name of ["profile.json", "jobs.json", "secrets.json", "sync-history.json"]) {
    entries[name] = await readFile(join(dataRoot, name), "utf8");
  }
  return entries;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertBinaryPresenceContract(binary, missingCode, missingMessagePattern) {
  assert.equal(typeof binary.path, "string");
  assert.equal(typeof binary.exists, "boolean");
  assert.equal(binary.ok, binary.exists);
  if (binary.exists) {
    assert.equal(binary.errorCode, "");
    assert.equal(binary.message, "");
  } else {
    assert.equal(binary.errorCode, missingCode);
    assert.match(binary.message, missingMessagePattern);
  }
}

function assertBinaryCheckContract(binary, expectedErrorCode, expectedExists, messagePattern) {
  assert.equal(typeof binary.path, "string");
  assert.equal(binary.exists, expectedExists);
  assert.equal(binary.ok, false);
  assert.equal(binary.errorCode, expectedErrorCode);
  assert.match(binary.message, messagePattern);
  if (expectedExists) {
    assert.equal(typeof binary.version, "object");
    assert.equal(binary.version.ok, false);
  } else {
    assert.equal(binary.version, null);
  }
}
