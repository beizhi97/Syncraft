import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { resolveProfileImport } from "../client/src/profileImport.js";
import { createHeartbeatAuth } from "../src/core/heartbeatAuth.js";
import { decodeClaimToken } from "../src/core/claimProtocol.js";
import { createDefaultAdminState } from "../src/core/index.js";
import { decodeImportProfile } from "../src/core/profileProtocol.js";
import { parseVlessUri } from "../src/core/vless.js";
import { assertAdminSingboxApplyResponseContract } from "../scripts/lib/runtimeContracts.mjs";
import {
  assertAdminClaimSummaryContract,
  assertAdminAuthCheckResponseContract,
  assertAdminDeviceVlessUriRevealContract,
  assertAdminStateSummaryContract,
  assertAdminSingboxMarkAppliedResponseContract,
  assertAdminSingboxConfigPreviewContract,
  assertAdminSingboxWriteResponseContract,
  assertAdminStorageSaveResponseContract,
  assertAdminStorageBucketClearResponseContract,
  assertAdminStorageBucketCreateResponseContract,
  assertAdminStorageBucketDeleteEmptyResponseContract,
  assertAdminStorageBucketsRefreshResponseContract,
  assertAdminStorageBucketToggleResponseContract,
  assertAdminStorageSummaryContract,
  assertAdminTunnelAutofillResponseContract,
  assertAdminTunnelGenerateResponseContract,
  assertAdminTunnelSummaryContract,
  assertAdminUserDeleteResponseContract,
  assertAdminUserWriteResponseContract,
  assertAdminUserSummaryContract,
  assertAdminWriteStateResponseContract,
  assertClaimCreateResponseContract,
  assertClaimRedeemResponseContract,
  assertClientHeartbeatDeviceSummaryContract,
  assertHttpErrorResponseContract,
  assertJobsPreviewResponseContract,
  assertProfileEncodeResponseContract,
  assertRuntimeDiagnosticsContract,
  assertServerDeviceSummaryContract,
  assertServerHeartbeatResponseContract,
  assertServerHealthResponseContract,
  assertSingboxClientConfigResponseContract,
  assertVlessParseResponseContract
} from "./helpers/contracts.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(projectRoot, "src", "server.js");
const serverSmokeEntry = join(projectRoot, "scripts", "smoke-server.mjs");
// The server now fails closed on a missing admin token. These contract tests spawn
// it with `...process.env` and exercise management APIs without credentials, so they
// opt into no-auth mode explicitly. Tests that assert the fail-closed startup itself
// override this per spawn (SFSC_REQUIRE_ADMIN_TOKEN=1 wins over ALLOW).
process.env.SFSC_ALLOW_NO_ADMIN_TOKEN = "1";
const REALITY_PUBLIC_KEY = "A".repeat(43);
const REALITY_PRIVATE_KEY = "B".repeat(43);
const REALITY_SHORT_ID = "abcdef1234567890";

test("HTTP contract: server refuses to overwrite corrupt admin state on startup", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-corrupt-server-state-"));
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const port = await getFreePort();
  await mkdir(dataRoot, { recursive: true });
  await writeFile(stateFile, "{ bad server state", "utf8");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  t.after(async () => {
    if (!child.killed && child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("server did not exit on corrupt state")), 3000))
  ]);
  assert.notEqual(code, 0);
  assert.match(stderr, /server_state_corrupt/);
  assert.equal(await readFile(stateFile, "utf8"), "{ bad server state");
});

test("HTTP contract: server refuses a second writer for the same state directory", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-server-state-lock-"));
  const dataRoot = join(tempRoot, "data");
  const firstPort = await getFreePort();
  const secondPort = await getFreePort();
  const firstBaseUrl = `http://127.0.0.1:${firstPort}`;
  const children = [];

  function start(port, name) {
    const child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
        SERVER_DATA_ROOT: dataRoot,
        SINGBOX_CONFIG_PATH: join(tempRoot, name, "sing-box", "config.json")
      }
    });
    children.push(child);
    return child;
  }

  t.after(async () => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]).catch(() => {});
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const first = start(firstPort, "first");
  await waitForHealth(firstBaseUrl, first);

  const second = start(secondPort, "second");
  let secondStderr = "";
  second.stderr.on("data", (chunk) => {
    secondStderr += chunk.toString("utf8");
  });
  const [exitCode] = await Promise.race([
    once(second, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("second server did not exit on state lock")), 3000))
  ]);
  assert.notEqual(exitCode, 0);
  assert.match(secondStderr, /server_state_locked/);
});

test("HTTP contract: failed sing-box config writes roll back admin state", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-singbox-write-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = join(tempRoot, "sing-box-config-is-dir");
  await mkdir(configPath, { recursive: true });

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "rollback.before");

  const failedGenerate = await fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      remark: "should-rollback",
      publicHost: "rollback.example.com",
      publicPort: 45679,
      listenPort: 45679,
      confirmGenerateTunnel: true,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: REALITY_PUBLIC_KEY,
        privateKey: REALITY_PRIVATE_KEY,
        shortId: REALITY_SHORT_ID
      }
    })
  });
  assert.equal(failedGenerate.status, 500);
  assertHttpErrorResponseContract(await failedGenerate.json(), "failedGenerate", {
    errorCode: "server_singbox_config_write_failed"
  });

  const after = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(after, "rollback.after");
  assert.equal(after.tunnel.protocol, before.tunnel.protocol);
  assert.equal(after.tunnel.publicHost, before.tunnel.publicHost);
  assert.equal(after.tunnel.publicPort, before.tunnel.publicPort);
  assert.equal(after.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(after.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
});

test("HTTP contract: failed admin state writes use a stable code and roll back memory", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-state-write-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "stateWriteFailure.before");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedSave = await fetch(`${baseUrl}/api/admin/storage/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: "http://should-not-stick:9000",
      bucket: "should-not-stick",
      accessKeyId: "bad",
      secretAccessKey: "bad-secret"
    })
  });
  assert.equal(failedSave.status, 500);
  assertHttpErrorResponseContract(await failedSave.json(), "failedSave", {
    errorCode: "server_state_write_failed"
  });

  const after = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(after, "stateWriteFailure.after");
  assert.equal(after.storage.endpoint, before.storage.endpoint);
  assert.equal(after.storage.bucket, before.storage.bucket);
  assert.equal(after.storage.accessKeyId, before.storage.accessKeyId);
});

test("HTTP contract: server POST APIs require application/json media type", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-server-json-media-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "json-media-admin-token";
  const validTunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&security=none&type=tcp#home-sync";

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_ADMIN_TOKEN: adminToken
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);

  const nonStandardJson = await fetch(`${baseUrl}/api/vless/parse`, {
    method: "POST",
    headers: {
      "content-type": "text/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ uri: validTunnelUri })
  });
  assert.equal(nonStandardJson.status, 415);
  assertHttpErrorResponseContract(await nonStandardJson.json(), "serverNonStandardJson", {
    errorCode: "unsupported_media_type"
  });

  for (const path of ["/api/claims/create", "/api/vless/parse", "/api/admin/storage/save"]) {
    const unauthenticatedTextPlain = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json"
    });
    assert.equal(unauthenticatedTextPlain.status, 415);
    assertHttpErrorResponseContract(await unauthenticatedTextPlain.json(), `serverMediaTypeBeforeAuth:${path}`, {
      errorCode: "unsupported_media_type"
    });
  }

  const missingTextPlain = await fetch(`${baseUrl}/api/does-not-exist`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-json"
  });
  assert.equal(missingTextPlain.status, 415);
  assertHttpErrorResponseContract(await missingTextPlain.json(), "serverMissingTextPlain", {
    errorCode: "unsupported_media_type"
  });

  const missingJson = await fetch(`${baseUrl}/api/does-not-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(missingJson.status, 404);
  assertHttpErrorResponseContract(await missingJson.json(), "serverMissingJson", {
    errorCode: "not_found"
  });

  const missingEmptyBody = await fetch(`${baseUrl}/api/does-not-exist`, {
    method: "POST"
  });
  assert.equal(missingEmptyBody.status, 404);
  assertHttpErrorResponseContract(await missingEmptyBody.json(), "serverMissingEmptyBody", {
    errorCode: "not_found"
  });

  const jsonWithCharset = await fetch(`${baseUrl}/api/vless/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ uri: validTunnelUri })
  });
  assert.equal(jsonWithCharset.status, 200);
  assertVlessParseResponseContract(await jsonWithCharset.json(), "serverJsonWithCharset");
});

test("HTTP contract: failed storage bucket creation persistence does not publish a phantom bucket", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-bucket-create-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "bucketCreateRollback.before");
  assert.equal(before.storage.buckets.some((bucket) => bucket.name === "phantom-bucket"), false);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedCreate = await fetch(`${baseUrl}/api/admin/storage/buckets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket: "phantom-bucket"
    })
  });
  assert.equal(failedCreate.status, 500);
  assertHttpErrorResponseContract(await failedCreate.json(), "failedBucketCreate", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "bucketCreateRollback.afterFailure");
  assert.equal(afterFailure.updatedAt, before.updatedAt);
  assert.deepEqual(afterFailure.storage, before.storage);
  assert.equal(afterFailure.storage.buckets.some((bucket) => bucket.name === "phantom-bucket"), false);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const created = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "phantom-bucket"
  });
  assertAdminStorageBucketCreateResponseContract(created, "bucketCreateRollback.created");
  assert.equal(created.bucket.name, "phantom-bucket");
  assert.equal(created.state.storage.buckets.some((bucket) => bucket.name === "phantom-bucket"), true);
});

test("HTTP contract: failed storage bucket refresh persistence keeps previous bucket list", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-bucket-refresh-rollback-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const minioRequests = [];
  const minioServer = createHttpServer((req, res) => {
    minioRequests.push({ method: req.method, url: req.url });
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListAllMyBucketsResult>",
        "<Buckets>",
        "<Bucket><Name>refresh-rollback</Name><CreationDate>2026-07-06T00:00:00.000Z</CreationDate></Bucket>",
        "</Buckets>",
        "</ListAllMyBucketsResult>"
      ].join(""));
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  minioServer.listen(minioPort, "127.0.0.1");
  await once(minioServer, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    if (minioServer.listening) {
      minioServer.close();
      await Promise.race([
        once(minioServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  assertAdminStorageSummaryContract(storageSave.storage, "bucketRefreshRollback.storageSave.storage");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "bucketRefreshRollback.before");
  assert.equal(before.storage.buckets.some((bucket) => bucket.name === "refresh-rollback"), false);
  const minioRequestCountBeforeInvalid = minioRequests.length;
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ignored: true })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([])
  }));
  assert.equal(minioRequests.length, minioRequestCountBeforeInvalid);
  const afterInvalid = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterInvalid, "bucketRefreshRollback.afterInvalid");
  assert.deepEqual(afterInvalid.storage, before.storage);

  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedRefresh = await fetch(`${baseUrl}/api/admin/storage/buckets/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(failedRefresh.status, 500);
  assertHttpErrorResponseContract(await failedRefresh.json(), "failedBucketRefresh", {
    errorCode: "server_state_write_failed"
  });
  assert.equal(minioRequests.some((request) => request.method === "GET" && request.url === "/"), true);

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "bucketRefreshRollback.afterFailure");
  assert.equal(afterFailure.updatedAt, before.updatedAt);
  assert.deepEqual(afterFailure.storage, before.storage);
  assert.equal(afterFailure.storage.buckets.some((bucket) => bucket.name === "refresh-rollback"), false);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const refreshed = await postJson(`${baseUrl}/api/admin/storage/buckets/refresh`, {});
  assertAdminStorageBucketsRefreshResponseContract(refreshed, "bucketRefreshRollback.refreshed");
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.buckets.some((bucket) => bucket.name === "refresh-rollback"), true);
  assert.equal(refreshed.state.storage.buckets.some((bucket) => bucket.name === "refresh-rollback"), true);
});

test("HTTP contract: failed storage bucket disable persistence keeps bucket active", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-bucket-disable-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const created = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "archive-rollback"
  });
  assertAdminStorageBucketCreateResponseContract(created, "bucketDisableRollback.created");
  assert.equal(created.bucket.name, "archive-rollback");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "bucketDisableRollback.before");
  const beforeBucket = before.storage.buckets.find((bucket) => bucket.name === "archive-rollback");
  assert.ok(beforeBucket);
  assert.equal(beforeBucket.disabledAt, null);
  assert.equal(before.storage.bucket, "home-sync");
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedDisable = await fetch(`${baseUrl}/api/admin/storage/buckets/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket: "archive-rollback"
    })
  });
  assert.equal(failedDisable.status, 500);
  assertHttpErrorResponseContract(await failedDisable.json(), "failedBucketDisable", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "bucketDisableRollback.afterFailure");
  assert.deepEqual(afterFailure.storage, before.storage);
  const afterBucket = afterFailure.storage.buckets.find((bucket) => bucket.name === "archive-rollback");
  assert.ok(afterBucket);
  assert.equal(afterBucket.disabledAt, null);
  assert.equal(afterFailure.storage.bucket, before.storage.bucket);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const disabled = await postJson(`${baseUrl}/api/admin/storage/buckets/disable`, {
    bucket: "archive-rollback"
  });
  assertAdminStorageBucketToggleResponseContract(disabled, "bucketDisableRollback.disabled");
  assert.equal(disabled.bucket.name, "archive-rollback");
  assert.equal(disabled.bucket.disabledAt.length > 0, true);
  const disabledSummary = disabled.state.storage.buckets.find((bucket) => bucket.name === "archive-rollback");
  assert.equal(disabledSummary.disabledAt, disabled.bucket.disabledAt);
});

test("HTTP contract: failed storage bucket enable persistence keeps bucket disabled", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-bucket-enable-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const created = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "archive-enable-rollback"
  });
  assertAdminStorageBucketCreateResponseContract(created, "bucketEnableRollback.created");
  const disabledBaseline = await postJson(`${baseUrl}/api/admin/storage/buckets/disable`, {
    bucket: "archive-enable-rollback"
  });
  assertAdminStorageBucketToggleResponseContract(disabledBaseline, "bucketEnableRollback.disabledBaseline");
  assert.equal(disabledBaseline.bucket.disabledAt.length > 0, true);

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "bucketEnableRollback.before");
  const beforeBucket = before.storage.buckets.find((bucket) => bucket.name === "archive-enable-rollback");
  assert.ok(beforeBucket);
  assert.equal(beforeBucket.disabledAt.length > 0, true);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedEnable = await fetch(`${baseUrl}/api/admin/storage/buckets/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket: "archive-enable-rollback"
    })
  });
  assert.equal(failedEnable.status, 500);
  assertHttpErrorResponseContract(await failedEnable.json(), "failedBucketEnable", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "bucketEnableRollback.afterFailure");
  assert.deepEqual(afterFailure.storage, before.storage);
  const afterBucket = afterFailure.storage.buckets.find((bucket) => bucket.name === "archive-enable-rollback");
  assert.ok(afterBucket);
  assert.equal(afterBucket.disabledAt, beforeBucket.disabledAt);
  assert.equal(afterFailure.storage.bucket, before.storage.bucket);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const enabled = await postJson(`${baseUrl}/api/admin/storage/buckets/enable`, {
    bucket: "archive-enable-rollback"
  });
  assertAdminStorageBucketToggleResponseContract(enabled, "bucketEnableRollback.enabled");
  assert.equal(enabled.bucket.name, "archive-enable-rollback");
  assert.equal(enabled.bucket.disabledAt, null);
  const enabledSummary = enabled.state.storage.buckets.find((bucket) => bucket.name === "archive-enable-rollback");
  assert.equal(enabledSummary.disabledAt, null);
});

test("HTTP contract: failed sing-box write persistence deletes uncommitted config", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-singbox-state-write-fail-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "singboxWriteFailure.before");
  assert.equal(before.tunnel.restartRequired, false);
  assert.equal(before.tunnel.lastConfigWrittenAt, null);
  await assert.rejects(readFile(configPath, "utf8"), (error) => error.code === "ENOENT");
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedWrite = await fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      confirmWriteSingbox: true
    })
  });
  assert.equal(failedWrite.status, 500);
  assertHttpErrorResponseContract(await failedWrite.json(), "failedSingboxWrite", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "singboxWriteFailure.afterFailure");
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  await assert.rejects(readFile(configPath, "utf8"), (error) => error.code === "ENOENT");

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const written = await postJson(`${baseUrl}/api/admin/singbox/write`, {
    confirmWriteSingbox: true
  });
  assertAdminSingboxWriteResponseContract(written, "singboxWriteFailure.written");
  assert.equal(written.state.tunnel.restartRequired, true);
  assert.ok(written.state.tunnel.lastConfigWrittenAt);
  const committedConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(committedConfig), []);
});

test("HTTP contract: failed tunnel autofill persistence rolls back tunnel state", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-tunnel-autofill-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "tunnelAutofillFailure.before");
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedAutofill = await fetch(`${baseUrl}/api/admin/tunnel/autofill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      publicHost: "autofill-rollback.example.com",
      publicPort: 45680,
      listenPort: 45680,
      serverName: "www.microsoft.com",
      fingerprint: "chrome",
      shortId: "1234abcd5678ef90"
    })
  });
  assert.equal(failedAutofill.status, 500);
  assertHttpErrorResponseContract(await failedAutofill.json(), "failedAutofill", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "tunnelAutofillFailure.afterFailure");
  assert.deepEqual(afterFailure.tunnel, before.tunnel);
  assert.equal(afterFailure.tunnel.publicHost, before.tunnel.publicHost);
  assert.equal(afterFailure.tunnel.publicPort, before.tunnel.publicPort);
  assert.equal(afterFailure.tunnel.listenPort, before.tunnel.listenPort);
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const autofill = await postJson(`${baseUrl}/api/admin/tunnel/autofill`, {
    protocol: "vless-reality-tcp",
    publicHost: "autofill-rollback.example.com",
    publicPort: 45680,
    listenPort: 45680,
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    shortId: "1234abcd5678ef90"
  });
  assertAdminTunnelAutofillResponseContract(autofill, "tunnelAutofillFailure.autofill");
  assert.equal(autofill.tunnel.protocol, "vless-reality-tcp");
  assert.equal(autofill.tunnel.publicHost, "autofill-rollback.example.com");
  assert.equal(autofill.tunnel.publicPort, 45680);
  assert.equal(autofill.tunnel.listenPort, 45680);
  assert.equal(autofill.tunnel.restartRequired, true);
  assert.equal(autofill.tunnel.reality.shortId, "1234abcd5678ef90");
});

test("HTTP contract: failed mark-applied persistence keeps sing-box pending", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-mark-applied-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);

  const written = await postJson(`${baseUrl}/api/admin/singbox/write`, {
    confirmWriteSingbox: true
  });
  assertAdminSingboxWriteResponseContract(written, "markAppliedRollback.written");
  assert.equal(written.state.tunnel.restartRequired, true);
  assert.equal(written.state.tunnel.lastAppliedAt, null);

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "markAppliedRollback.before");
  assert.equal(before.tunnel.restartRequired, true);
  assert.equal(before.tunnel.lastAppliedAt, null);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedMarkApplied = await fetch(`${baseUrl}/api/admin/singbox/mark-applied`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      confirmMarkApplied: true
    })
  });
  assert.equal(failedMarkApplied.status, 500);
  assertHttpErrorResponseContract(await failedMarkApplied.json(), "failedMarkApplied", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "markAppliedRollback.afterFailure");
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastAppliedAt, before.tunnel.lastAppliedAt);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const markedApplied = await postJson(`${baseUrl}/api/admin/singbox/mark-applied`, {
    confirmMarkApplied: true
  });
  assertAdminSingboxMarkAppliedResponseContract(markedApplied, "markAppliedRollback.markedApplied");
  assert.equal(markedApplied.state.tunnel.restartRequired, false);
  assert.ok(markedApplied.state.tunnel.lastAppliedAt);
});

test("HTTP contract: failed admin user creation persistence does not publish a phantom user", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-user-create-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const baseline = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "baseline-admin-pc"
  });
  assertAdminUserWriteResponseContract(baseline, "userCreateRollback.baseline");
  assert.equal(baseline.user.clientName, "baseline-admin-pc");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "userCreateRollback.before");
  assert.equal(before.users.some((user) => user.clientName === "baseline-admin-pc"), true);
  const beforeConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(beforeConfig), ["baseline-admin-pc"]);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedCreate = await fetch(`${baseUrl}/api/admin/users/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: "phantom-admin-pc"
    })
  });
  assert.equal(failedCreate.status, 500);
  assertHttpErrorResponseContract(await failedCreate.json(), "failedUserCreate", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "userCreateRollback.afterFailure");
  assert.equal(afterFailure.users.some((user) => user.clientName === "phantom-admin-pc"), false);
  assert.equal(afterFailure.devices.some((device) => device.clientName === "phantom-admin-pc"), false);
  assert.equal(afterFailure.users.length, before.users.length);
  assert.equal(afterFailure.devices.length, before.devices.length);
  assert.equal(afterFailure.tunnel.userCount, before.tunnel.userCount);
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  const afterConfig = await readFile(configPath, "utf8");
  assert.equal(afterConfig, beforeConfig);
  assert.deepEqual(readSingboxUserNames(afterConfig), ["baseline-admin-pc"]);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const created = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "phantom-admin-pc"
  });
  assertAdminUserWriteResponseContract(created, "userCreateRollback.created");
  assert.equal(created.user.clientName, "phantom-admin-pc");
});

test("HTTP contract: failed admin user disable persistence keeps user enabled", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-user-disable-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const baseline = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "disable-rollback-pc"
  });
  assertAdminUserWriteResponseContract(baseline, "userDisableRollback.baseline");
  assert.equal(baseline.user.clientName, "disable-rollback-pc");
  assert.equal(baseline.user.enabled, true);

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "userDisableRollback.before");
  const beforeUser = before.users.find((user) => user.clientName === "disable-rollback-pc");
  assert.ok(beforeUser);
  assert.equal(beforeUser.enabled, true);
  const beforeDevice = before.devices.find((device) => device.clientName === "disable-rollback-pc");
  assert.ok(beforeDevice);
  assert.equal(beforeDevice.enabled, true);
  const beforeConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(beforeConfig), ["disable-rollback-pc"]);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedDisable = await fetch(`${baseUrl}/api/admin/users/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: baseline.user.id
    })
  });
  assert.equal(failedDisable.status, 500);
  assertHttpErrorResponseContract(await failedDisable.json(), "failedUserDisable", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "userDisableRollback.afterFailure");
  const afterUser = afterFailure.users.find((user) => user.id === baseline.user.id);
  assert.ok(afterUser);
  assert.equal(afterUser.enabled, true);
  assert.equal(afterUser.deletedAt || null, null);
  const afterDevice = afterFailure.devices.find((device) => device.clientName === "disable-rollback-pc");
  assert.ok(afterDevice);
  assert.equal(afterDevice.enabled, true);
  assert.equal(afterFailure.tunnel.userCount, before.tunnel.userCount);
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  const afterConfig = await readFile(configPath, "utf8");
  assert.equal(afterConfig, beforeConfig);
  assert.deepEqual(readSingboxUserNames(afterConfig), ["disable-rollback-pc"]);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const disabled = await postJson(`${baseUrl}/api/admin/users/disable`, {
    userId: baseline.user.id
  });
  assertAdminUserWriteResponseContract(disabled, "userDisableRollback.disabled");
  assert.equal(disabled.user.enabled, false);
  assert.deepEqual(readSingboxUserNames(JSON.stringify(disabled.config)), []);
});

test("HTTP contract: failed admin user enable persistence keeps user disabled", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-user-enable-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const baseline = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "enable-rollback-pc"
  });
  assertAdminUserWriteResponseContract(baseline, "userEnableRollback.baseline");
  const disabledBaseline = await postJson(`${baseUrl}/api/admin/users/disable`, {
    userId: baseline.user.id
  });
  assertAdminUserWriteResponseContract(disabledBaseline, "userEnableRollback.disabledBaseline");
  assert.equal(disabledBaseline.user.enabled, false);

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "userEnableRollback.before");
  const beforeUser = before.users.find((user) => user.clientName === "enable-rollback-pc");
  assert.ok(beforeUser);
  assert.equal(beforeUser.enabled, false);
  const beforeDevice = before.devices.find((device) => device.clientName === "enable-rollback-pc");
  assert.ok(beforeDevice);
  assert.equal(beforeDevice.enabled, false);
  const beforeConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(beforeConfig), []);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedEnable = await fetch(`${baseUrl}/api/admin/users/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: baseline.user.id
    })
  });
  assert.equal(failedEnable.status, 500);
  assertHttpErrorResponseContract(await failedEnable.json(), "failedUserEnable", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "userEnableRollback.afterFailure");
  const afterUser = afterFailure.users.find((user) => user.id === baseline.user.id);
  assert.ok(afterUser);
  assert.equal(afterUser.enabled, false);
  assert.equal(afterUser.deletedAt || null, null);
  const afterDevice = afterFailure.devices.find((device) => device.clientName === "enable-rollback-pc");
  assert.ok(afterDevice);
  assert.equal(afterDevice.enabled, false);
  assert.equal(afterFailure.tunnel.userCount, before.tunnel.userCount);
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  const afterConfig = await readFile(configPath, "utf8");
  assert.equal(afterConfig, beforeConfig);
  assert.deepEqual(readSingboxUserNames(afterConfig), []);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const enabled = await postJson(`${baseUrl}/api/admin/users/enable`, {
    userId: baseline.user.id
  });
  assertAdminUserWriteResponseContract(enabled, "userEnableRollback.enabled");
  assert.equal(enabled.user.enabled, true);
  assert.deepEqual(readSingboxUserNames(JSON.stringify(enabled.config)), ["enable-rollback-pc"]);
});

test("HTTP contract: failed admin user delete persistence keeps user present", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-user-delete-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.ok, true);
  const baseline = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "delete-rollback-pc"
  });
  assertAdminUserWriteResponseContract(baseline, "userDeleteRollback.baseline");
  assert.equal(baseline.user.clientName, "delete-rollback-pc");
  assert.equal(baseline.user.enabled, true);

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "userDeleteRollback.before");
  const beforeUser = before.users.find((user) => user.clientName === "delete-rollback-pc");
  assert.ok(beforeUser);
  assert.equal(beforeUser.enabled, true);
  assert.equal(beforeUser.deletedAt || null, null);
  const beforeDevice = before.devices.find((device) => device.clientName === "delete-rollback-pc");
  assert.ok(beforeDevice);
  assert.equal(beforeDevice.enabled, true);
  const beforeConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(beforeConfig), ["delete-rollback-pc"]);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedDelete = await fetch(`${baseUrl}/api/admin/users/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: baseline.user.id,
      confirmText: "delete-rollback-pc"
    })
  });
  assert.equal(failedDelete.status, 500);
  assertHttpErrorResponseContract(await failedDelete.json(), "failedUserDelete", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "userDeleteRollback.afterFailure");
  const afterUser = afterFailure.users.find((user) => user.id === baseline.user.id);
  assert.ok(afterUser);
  assert.equal(afterUser.enabled, true);
  assert.equal(afterUser.deletedAt || null, null);
  assert.equal(afterFailure.devices.some((device) => device.clientName === "delete-rollback-pc"), true);
  assert.equal(afterFailure.users.length, before.users.length);
  assert.equal(afterFailure.devices.length, before.devices.length);
  assert.equal(afterFailure.tunnel.userCount, before.tunnel.userCount);
  assert.equal(afterFailure.tunnel.restartRequired, before.tunnel.restartRequired);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  const afterConfig = await readFile(configPath, "utf8");
  assert.equal(afterConfig, beforeConfig);
  assert.deepEqual(readSingboxUserNames(afterConfig), ["delete-rollback-pc"]);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const deleted = await postJson(`${baseUrl}/api/admin/users/delete`, {
    userId: baseline.user.id,
    confirmText: "delete-rollback-pc"
  });
  assertAdminUserDeleteResponseContract(deleted, "userDeleteRollback.deleted");
  assert.equal(deleted.deletedUserId, baseline.user.id);
  assert.equal(deleted.state.devices.some((device) => device.clientName === "delete-rollback-pc"), false);
  assert.deepEqual(readSingboxUserNames(JSON.stringify(deleted.config)), []);
});

test("HTTP contract: failed claim redemption persistence does not consume the SyncKey", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "redeem-rollback-pc",
    server: baseUrl
  });
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tKey: claim.tKey })
  });
  assert.equal(failedRedeem.status, 500);
  assertHttpErrorResponseContract(await failedRedeem.json(), "failedRedeem", {
    errorCode: "server_state_write_failed"
  });

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const redeemed = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: claim.tKey
  });
  assertClaimRedeemResponseContract(redeemed, "redeemRollback.redeemedProfile", {
    expectedClientName: "redeem-rollback-pc"
  });
  assert.equal(redeemed.clientName, "redeem-rollback-pc");

  const duplicateRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tKey: claim.tKey })
  });
  assert.equal(duplicateRedeem.status, 409);
  assertHttpErrorResponseContract(await duplicateRedeem.json(), "redeemRollback.duplicateRedeem", {
    errorCode: "claim_already_used"
  });
});

test("HTTP contract: failed claim redemption audit persistence returns server_state_write_failed", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-audit-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_CLAIM_REDEEM_FAILURE_LIMIT: "3",
      SFSC_CLAIM_REDEEM_FAILURE_WINDOW_MS: "60000",
      SFSC_CLAIM_REDEEM_RATE_LIMIT_MS: "60000"
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedAuditPersist = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ABCD-EFGH" })
  });
  assert.equal(failedAuditPersist.status, 500);
  assertHttpErrorResponseContract(await failedAuditPersist.json(), "failedAuditPersist", {
    errorCode: "server_state_write_failed"
  });

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const retryInvalidRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ABCD-EFGH" })
  });
  assert.equal(retryInvalidRedeem.status, 404);
  assertHttpErrorResponseContract(await retryInvalidRedeem.json(), "retryInvalidRedeem", {
    errorCode: "claim_not_found"
  });

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const windows = Object.values(state.claimRedeemFailures || {});
  assert.equal(windows.length, 1);
  assert.equal(windows[0].failures, 1);
});

test("HTTP contract: repeated failed claim redemption is rate limited", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-rate-limit-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_CLAIM_REDEEM_FAILURE_LIMIT: "3",
      SFSC_CLAIM_REDEEM_FAILURE_WINDOW_MS: "60000",
      SFSC_CLAIM_REDEEM_RATE_LIMIT_MS: "60000"
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const invalidRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-EFGH" })
    });
    assert.equal(invalidRedeem.status, 404);
    assertHttpErrorResponseContract(await invalidRedeem.json(), `invalidRedeem.${attempt}`, {
      errorCode: "claim_not_found"
    });
  }

  const rateLimitedRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ABCD-EFGH" })
  });
  assert.equal(rateLimitedRedeem.status, 429);
  assertHttpErrorResponseContract(await rateLimitedRedeem.json(), "rateLimitedRedeem", {
    errorCode: "claim_redeem_rate_limited"
  });

  // Rotating to a fresh code must not reset the limiter: the failure window is
  // keyed on the client address only, otherwise brute force would be free.
  const differentCode = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "JKLM-NPQR" })
  });
  assert.equal(differentCode.status, 429);
  assertHttpErrorResponseContract(await differentCode.json(), "differentCode", {
    errorCode: "claim_redeem_rate_limited"
  });

  const stateText = await readFile(join(dataRoot, "sfsc-state.json"), "utf8");
  assert.equal(stateText.includes("ABCD-EFGH"), false);
  const state = JSON.parse(stateText);
  const windows = Object.values(state.claimRedeemFailures || {});
  assert.equal(windows.length, 1);
  assert.equal(windows.some((window) => window.failures >= 3 && window.limitedUntil > Date.now()), true);

  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(adminState, "claimRedeemRateLimit.adminState");
  const adminStateText = JSON.stringify(adminState);
  assert.equal(adminStateText.includes("claimRedeemFailures"), false);
  assert.equal(adminStateText.includes("ABCD-EFGH"), false);
});

test("HTTP contract: claim redemption rate limit trusts X-Forwarded-For only when enabled", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-trust-proxy-"));
  const dataRoot = join(tempRoot, "data");
  const children = [];

  t.after(async () => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]).catch(() => {});
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function startServer(name, extraEnv = {}) {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_SERVER_URL: baseUrl,
        SERVER_DATA_ROOT: join(dataRoot, name),
        SINGBOX_CONFIG_PATH: join(tempRoot, name, "sing-box", "config.json"),
        SFSC_CLAIM_REDEEM_FAILURE_LIMIT: "2",
        SFSC_CLAIM_REDEEM_FAILURE_WINDOW_MS: "60000",
        SFSC_CLAIM_REDEEM_RATE_LIMIT_MS: "60000",
        ...extraEnv
      }
    });
    children.push(child);
    await waitForHealth(baseUrl, child);
    return baseUrl;
  }

  async function redeem(baseUrl, forwardedFor) {
    return fetch(`${baseUrl}/api/claims/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor
      },
      body: JSON.stringify({ code: "ABCD-EFGH" })
    });
  }

  const untrustedBaseUrl = await startServer("untrusted");
  for (const forwardedFor of ["198.51.100.10", "198.51.100.10"]) {
    const response = await redeem(untrustedBaseUrl, forwardedFor);
    assert.equal(response.status, 404);
    assertHttpErrorResponseContract(await response.json(), "untrustedRedeem", {
      errorCode: "claim_not_found"
    });
  }
  const spoofedDifferentClient = await redeem(untrustedBaseUrl, "198.51.100.11");
  assert.equal(spoofedDifferentClient.status, 429);
  assertHttpErrorResponseContract(await spoofedDifferentClient.json(), "spoofedDifferentClient", {
    errorCode: "claim_redeem_rate_limited"
  });

  const trustedBaseUrl = await startServer("trusted", {
    SFSC_TRUST_PROXY: "1"
  });
  for (const forwardedFor of ["198.51.100.20", "198.51.100.20"]) {
    const response = await redeem(trustedBaseUrl, forwardedFor);
    assert.equal(response.status, 404);
    assertHttpErrorResponseContract(await response.json(), "trustedRedeem.sameClient", {
      errorCode: "claim_not_found"
    });
  }
  const trustedDifferentClient = await redeem(trustedBaseUrl, "198.51.100.21");
  assert.equal(trustedDifferentClient.status, 404);
  assertHttpErrorResponseContract(await trustedDifferentClient.json(), "trustedRedeem.differentClient", {
    errorCode: "claim_not_found"
  });
  const trustedSameClientLimited = await redeem(trustedBaseUrl, "198.51.100.20");
  assert.equal(trustedSameClientLimited.status, 429);
  assertHttpErrorResponseContract(await trustedSameClientLimited.json(), "trustedRedeem.sameClientLimited", {
    errorCode: "claim_redeem_rate_limited"
  });
});

test("HTTP contract: claim redemption rate limit survives server restart", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-rate-limit-restart-"));
  const dataRoot = join(tempRoot, "data");
  const singboxConfigPath = join(tempRoot, "sing-box", "config.json");
  const children = [];

  t.after(async () => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]).catch(() => {});
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function startServer() {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_SERVER_URL: baseUrl,
        SERVER_DATA_ROOT: dataRoot,
        SINGBOX_CONFIG_PATH: singboxConfigPath,
        SFSC_CLAIM_REDEEM_FAILURE_LIMIT: "3",
        SFSC_CLAIM_REDEEM_FAILURE_WINDOW_MS: "60000",
        SFSC_CLAIM_REDEEM_RATE_LIMIT_MS: "60000"
      }
    });
    children.push(child);
    await waitForHealth(baseUrl, child);
    return { baseUrl, child };
  }

  const first = await startServer();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const invalidRedeem = await fetch(`${first.baseUrl}/api/claims/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "RSTT-LIMT" })
    });
    assert.equal(invalidRedeem.status, 404);
    assertHttpErrorResponseContract(await invalidRedeem.json(), `restartInvalidRedeem.${attempt}`, {
      errorCode: "claim_not_found"
    });
  }

  first.child.kill();
  await Promise.race([
    once(first.child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);

  const second = await startServer();
  const rateLimitedAfterRestart = await fetch(`${second.baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "RSTT-LIMT" })
  });
  assert.equal(rateLimitedAfterRestart.status, 429);
  assertHttpErrorResponseContract(await rateLimitedAfterRestart.json(), "rateLimitedAfterRestart", {
    errorCode: "claim_redeem_rate_limited"
  });

  const stateText = await readFile(join(dataRoot, "sfsc-state.json"), "utf8");
  assert.equal(stateText.includes("RSTT-LIMT"), false);
});

test("HTTP contract: claim redemption replays briefly only for the same client binding", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-replay-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "replay-contract-pc",
    server: baseUrl
  });

  const binding = {
    clientRedeemId: "redeem-contract-attempt",
    clientInstallId: "install-contract-device"
  };
  const first = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: claim.tKey,
    ...binding
  });
  assertClaimRedeemResponseContract(first, "claimReplay.first", {
    expectedClientName: "replay-contract-pc"
  });
  assert.equal(first.clientName, "replay-contract-pc");

  const replay = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: claim.tKey,
    ...binding
  });
  assertClaimRedeemResponseContract(replay, "claimReplay.replay", {
    expectedClientName: "replay-contract-pc"
  });
  assert.equal(replay.profileId, first.profileId);
  assert.equal(replay.heartbeat.secret, first.heartbeat.secret);
  assert.equal(replay.storage.secretAccessKey, first.storage.secretAccessKey);

  const conflictingRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tKey: claim.tKey,
      clientRedeemId: "other-redeem-attempt",
      clientInstallId: "install-contract-device"
    })
  });
  assert.equal(conflictingRedeem.status, 409);
  assertHttpErrorResponseContract(await conflictingRedeem.json(), "conflictingRedeem", {
    errorCode: "claim_already_used"
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(stderr, /claim_redeem_audit/);
  assert.match(stderr, /status=409/);
  assert.match(stderr, /error=claim_already_used/);
  assert.match(stderr, /codeHash=[a-f0-9]{16}/);
  assert.equal(stderr.includes(claim.tKey), false);
  assert.equal(stderr.includes(claim.code), false);
  assert.equal(stderr.includes(first.storage.secretAccessKey), false);

  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  const claimSummary = adminState.claims.find((item) => item.code === claim.code);
  assertAdminClaimSummaryContract(claimSummary, "replayClaimSummary");
  assert.equal(JSON.stringify(claimSummary).includes("redeem-contract-attempt"), false);
  assert.equal(JSON.stringify(claimSummary).includes("install-contract-device"), false);
  assert.equal(JSON.stringify(claimSummary).includes(first.storage.secretAccessKey), false);
});

test("HTTP contract: stale SyncKeys cannot redeem after device disable", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-stale-disabled-claim-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "stale-disabled-pc",
    server: baseUrl
  });
  await postJson(`${baseUrl}/api/admin/users/disable`, {
    userId: claim.claim.userId
  });

  const staleRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tKey: claim.tKey,
      clientRedeemId: "stale-disabled-attempt",
      clientInstallId: "stale-disabled-install"
    })
  });
  assert.equal(staleRedeem.status, 400);
  assertHttpErrorResponseContract(await staleRedeem.json(), "staleDisabledRedeem", {
    errorCode: "validation_failed",
    message: "SyncKey claim device is disabled"
  });

  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  const claimSummary = adminState.claims.find((item) => item.code === claim.code);
  assertAdminClaimSummaryContract(claimSummary, "staleDisabledClaimSummary");
  assert.equal(claimSummary.used, false);
  assert.equal(claimSummary.redeemedAt, null);
});

test("HTTP contract: stale SyncKeys cannot redeem after issued profile material drifts", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-stale-profile-claim-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: "http://minio:9000",
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "stale-profile-pc",
    server: baseUrl
  });
  await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: "http://new-minio:9000",
    internalEndpoint: "http://new-minio:9000"
  });

  const staleRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tKey: claim.tKey,
      clientRedeemId: "stale-profile-attempt",
      clientInstallId: "stale-profile-install"
    })
  });
  assert.equal(staleRedeem.status, 400);
  assertHttpErrorResponseContract(await staleRedeem.json(), "staleProfileRedeem", {
    errorCode: "validation_failed",
    message: "SyncKey claim profile is stale; regenerate SyncKey"
  });

  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  assert.equal(adminState.storage.endpoint, "http://new-minio:9000");
  const claimSummary = adminState.claims.find((item) => item.code === claim.code);
  assertAdminClaimSummaryContract(claimSummary, "staleProfileClaimSummary");
  assert.equal(claimSummary.used, false);
  assert.equal(claimSummary.redeemedAt, null);
});

test("HTTP contract: claim redemption rejects malformed input and expired claims with stable codes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-redeem-errors-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);

  for (const [context, body] of [
    ["missingRedeemInput", {}],
    ["malformedRedeemInput", { tKey: "SFSC1-not-a-json-payload" }]
  ]) {
    const response = await fetch(`${baseUrl}/api/claims/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assertHttpErrorResponseContract(await response.json(), context, {
      errorCode: "import_code_invalid"
    });
  }

  const expiringClaim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "expired-contract-pc",
    server: baseUrl,
    expiresInHours: 0.000001
  });
  assertClaimCreateResponseContract(expiringClaim, "expiringClaim", {
    expectedClientName: "expired-contract-pc",
    expectedServer: baseUrl
  });

  const expiresAtMs = new Date(expiringClaim.claim.expiresAt).getTime();
  await new Promise((resolve) => setTimeout(resolve, Math.max(25, expiresAtMs - Date.now() + 25)));

  const expiredRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tKey: expiringClaim.tKey })
  });
  assert.equal(expiredRedeem.status, 410);
  assertHttpErrorResponseContract(await expiredRedeem.json(), "expiredRedeem", {
    errorCode: "claim_expired"
  });

  const profileExpiresAt = new Date(Date.now() + 100).toISOString();
  const profileExpiringClaim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "expired-profile-contract-pc",
    server: baseUrl,
    profileExpiresAt
  });
  assertClaimCreateResponseContract(profileExpiringClaim, "profileExpiringClaim", {
    expectedClientName: "expired-profile-contract-pc",
    expectedServer: baseUrl
  });
  assert.equal(profileExpiringClaim.profile.expiresAt, profileExpiresAt);
  const profileExpiresAtMs = new Date(profileExpiresAt).getTime();
  await new Promise((resolve) => setTimeout(resolve, Math.max(25, profileExpiresAtMs - Date.now() + 25)));

  const expiredProfileRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tKey: profileExpiringClaim.tKey })
  });
  assert.equal(expiredProfileRedeem.status, 400);
  assertHttpErrorResponseContract(await expiredProfileRedeem.json(), "expiredProfileRedeem", {
    errorCode: "validation_failed",
    message: "SyncKey claim profile is expired; regenerate SyncKey"
  });

  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  const claimSummary = adminState.claims.find((item) => item.code === expiringClaim.code);
  assertAdminClaimSummaryContract(claimSummary, "expiredClaimSummary");
  assert.equal(claimSummary.used, false);
  assert.equal(claimSummary.redeemedAt, null);
  const profileExpiredClaimSummary = adminState.claims.find((item) => item.code === profileExpiringClaim.code);
  assertAdminClaimSummaryContract(profileExpiredClaimSummary, "profileExpiredClaimSummary");
  assert.equal(profileExpiredClaimSummary.used, false);
  assert.equal(profileExpiredClaimSummary.redeemedAt, null);
});

test("HTTP contract: claim creation honors explicit expiry fields", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-create-expiry-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);

  const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const explicitClaim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "http-explicit-expiry-pc",
    server: baseUrl,
    expiresAt: futureExpiresAt,
    expiresInHours: 48
  });
  assertClaimCreateResponseContract(explicitClaim, "httpExplicitExpiryClaim", {
    expectedClientName: "http-explicit-expiry-pc",
    expectedServer: baseUrl
  });
  assert.equal(explicitClaim.claim.expiresAt, futureExpiresAt);

  const noExpiryClaim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "http-no-expiry-pc",
    server: baseUrl,
    expiresAt: null
  });
  assertClaimCreateResponseContract(noExpiryClaim, "httpNoExpiryClaim", {
    expectedClientName: "http-no-expiry-pc",
    expectedServer: baseUrl
  });
  assert.equal(noExpiryClaim.claim.expiresAt, null);

  const beforeInvalid = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(beforeInvalid, "claimCreateExpiry.beforeInvalid");

  for (const [context, body] of [
    ["invalidExpiresAt", { clientName: "http-invalid-expires-at-pc", server: baseUrl, expiresAt: "not-a-date" }],
    ["pastExpiresAt", { clientName: "http-past-expires-at-pc", server: baseUrl, expiresAt: "2000-01-01T00:00:00.000Z" }],
    ["invalidExpiresInHours", { clientName: "http-invalid-expires-hours-pc", server: baseUrl, expiresInHours: 0 }]
  ]) {
    const response = await fetch(`${baseUrl}/api/claims/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assertHttpErrorResponseContract(await response.json(), context, {
      errorCode: "validation_failed"
    });
  }

  const afterInvalid = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterInvalid, "claimCreateExpiry.afterInvalid");
  assert.deepEqual(afterInvalid.claims, beforeInvalid.claims);
  assert.deepEqual(afterInvalid.users, beforeInvalid.users);
});

test("HTTP contract: failed SyncKey creation persistence does not publish a phantom claim", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-claim-create-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const configPath = join(tempRoot, "sing-box", "config.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: configPath
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const baseline = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "baseline-claim-pc",
    server: baseUrl
  });
  assert.equal(baseline.profile.clientName, "baseline-claim-pc");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "claimCreateFailure.before");
  assert.equal(before.settings.publicServerUrl, baseUrl);
  const beforeConfig = await readFile(configPath, "utf8");
  assert.deepEqual(readSingboxUserNames(beforeConfig), ["baseline-claim-pc"]);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedServerUrl = "https://should-not-stick.example";
  const failedCreate = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: "phantom-claim-pc",
      server: failedServerUrl
    })
  });
  assert.equal(failedCreate.status, 500);
  assertHttpErrorResponseContract(await failedCreate.json(), "failedCreate", {
    errorCode: "server_state_write_failed"
  });

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "claimCreateFailure.afterFailure");
  assert.deepEqual(afterFailure.settings, before.settings);
  assert.equal(afterFailure.settings.publicServerUrl, before.settings.publicServerUrl);
  assert.notEqual(afterFailure.settings.publicServerUrl, failedServerUrl);
  assert.equal(afterFailure.tunnel.lastConfigWrittenAt, before.tunnel.lastConfigWrittenAt);
  assert.equal(afterFailure.devices.some((device) => device.clientName === "phantom-claim-pc"), false);
  assert.equal(afterFailure.users.some((user) => user.clientName === "phantom-claim-pc"), false);
  assert.equal(afterFailure.claims.some((claim) => claim.clientName === "phantom-claim-pc"), false);
  assert.equal(afterFailure.claims.some((claim) => claim.server === failedServerUrl), false);
  assert.equal(afterFailure.claims.length, before.claims.length);
  assert.deepEqual(
    afterFailure.claims.map((claim) => [claim.code, claim.clientName, claim.server]),
    before.claims.map((claim) => [claim.code, claim.clientName, claim.server])
  );
  assert.deepEqual(afterFailure.devices.map((device) => device.clientName), before.devices.map((device) => device.clientName));
  assert.deepEqual(afterFailure.users.map((user) => user.clientName), before.users.map((user) => user.clientName));
  const afterConfig = await readFile(configPath, "utf8");
  assert.equal(afterConfig, beforeConfig);
  assert.deepEqual(readSingboxUserNames(afterConfig), ["baseline-claim-pc"]);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const created = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "phantom-claim-pc",
    server: baseUrl
  });
  assert.match(created.tKey, /^SFSC1-/);
  assert.equal(created.profile.clientName, "phantom-claim-pc");
});

test("HTTP contract: failed heartbeat persistence does not update device presence", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-heartbeat-rollback-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "heartbeat-rollback-pc",
    server: baseUrl
  });
  const profile = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: claim.tKey
  });
  assertClaimRedeemResponseContract(profile, "heartbeatFailure.redeemedProfile", {
    expectedClientName: "heartbeat-rollback-pc"
  });
  const stateBeforeFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(stateBeforeFailure, "heartbeatFailure.stateBeforeFailure");
  const deviceBeforeFailure = stateBeforeFailure.devices.find((device) => device.clientName === "heartbeat-rollback-pc");
  assert.equal(deviceBeforeFailure.online, false);
  assert.equal(deviceBeforeFailure.lastSeenAt, null);

  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedHeartbeatPayload = signHeartbeatPayload({
    clientName: profile.clientName,
    profileId: profile.profileId,
    clientVersion: "contract-test",
    sync: {
      syncState: "idle"
    }
  }, profile);
  const failedHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(failedHeartbeatPayload)
  });
  assert.equal(failedHeartbeat.status, 500);
  assertHttpErrorResponseContract(await failedHeartbeat.json(), "failedHeartbeat", {
    errorCode: "server_state_write_failed"
  });

  const stateAfterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(stateAfterFailure, "heartbeatFailure.stateAfterFailure");
  const deviceAfterFailure = stateAfterFailure.devices.find((device) => device.clientName === "heartbeat-rollback-pc");
  assert.equal(deviceAfterFailure.online, false);
  assert.equal(deviceAfterFailure.lastSeenAt, null);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const heartbeat = await postJson(`${baseUrl}/api/devices/heartbeat`, signHeartbeatPayload({
    clientName: profile.clientName,
    profileId: profile.profileId,
    clientVersion: "contract-test",
    sync: {
      syncState: "idle"
    }
  }, profile));
  assertServerHeartbeatResponseContract(heartbeat, "heartbeatFailure.success");
  assert.equal(heartbeat.device.online, true);
  assert.ok(heartbeat.device.lastSeenAt);
});

test("HTTP contract: hung storage backend requests time out instead of freezing the appliance", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-s3-timeout-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;

  // Accepts connections and never answers — the failure mode where the old
  // code held the global admin-state write lock until the socket died on its
  // own, freezing every POST on the appliance.
  const sockets = new Set();
  const hungMinio = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  hungMinio.listen(minioPort, "127.0.0.1");
  await once(hungMinio, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_S3_TIMEOUT_MS: "800"
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    hungMinio.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  assertAdminStorageSummaryContract(storageSave.storage, "s3Timeout.storageSave.storage");
  const startedAt = Date.now();
  const refresh = await postJson(`${baseUrl}/api/admin/storage/buckets/refresh`, {});
  const elapsedMs = Date.now() - startedAt;
  // Refresh degrades gracefully by contract: HTTP 200 with ok:false and a
  // storage_request_failed errorCode. The point here is the *bound*: the remote
  // failure must come from the request timeout, not from a socket that dies on
  // its own long after the appliance froze.
  assertAdminStorageBucketsRefreshResponseContract(refresh, "s3Timeout.refresh");
  assert.equal(refresh.ok, false);
  assert.equal(refresh.errorCode, "storage_request_failed");
  assert.match(refresh.warning, /timed out after 800ms/);
  // Well above the 800ms timeout for scheduling slack, far below the
  // no-timeout behaviour where this request would outlive the test.
  assert.equal(elapsedMs < 10_000, true, `expected a bounded failure, took ${elapsedMs}ms`);

  // The write lock must be free immediately afterwards: another POST completes
  // instead of queueing behind a hung storage connection.
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "s3-timeout-pc",
    server: baseUrl
  });
  assert.equal(typeof claim.tKey, "string");
});

test("HTTP contract: heartbeat failures are rate limited per source without counting disabled devices", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-heartbeat-rate-limit-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_HEARTBEAT_FAILURE_LIMIT: "3",
      SFSC_HEARTBEAT_FAILURE_WINDOW_MS: "60000",
      SFSC_HEARTBEAT_RATE_LIMIT_MS: "1500"
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const claim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "heartbeat-limit-pc",
    server: baseUrl
  });
  const profile = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: claim.tKey
  });
  assertClaimRedeemResponseContract(profile, "heartbeatRateLimit.redeemedProfile", {
    expectedClientName: "heartbeat-limit-pc"
  });
  const buildHeartbeatPayload = () => signHeartbeatPayload({
    clientName: profile.clientName,
    profileId: profile.profileId,
    clientVersion: "contract-test",
    sync: { syncState: "idle" }
  }, profile);
  const adminState = await getJson(`${baseUrl}/api/admin/state`);
  const device = adminState.devices.find((item) => item.clientName === "heartbeat-limit-pc");

  // A disabled device keeps retrying on its normal interval; the contract says it
  // must keep receiving 409 device_disabled so the client UI can show the state.
  // Five straight disabled heartbeats exceed the limit of 3, so if they counted,
  // the re-enabled heartbeat below would already be 429.
  await postJson(`${baseUrl}/api/admin/users/disable`, { userId: device.id });
  for (let i = 0; i < 5; i += 1) {
    const disabledHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildHeartbeatPayload())
    });
    assert.equal(disabledHeartbeat.status, 409);
    assertHttpErrorResponseContract(await disabledHeartbeat.json(), `heartbeatRateLimit.disabled.${i}`, {
      errorCode: "device_disabled"
    });
  }
  await postJson(`${baseUrl}/api/admin/users/enable`, { userId: device.id });
  const afterDisabled = await postJson(`${baseUrl}/api/devices/heartbeat`, buildHeartbeatPayload());
  assertServerHeartbeatResponseContract(afterDisabled, "heartbeatRateLimit.afterDisabled");

  // Unregistered clientName probes are the enumeration vector; they must count.
  for (let i = 0; i < 3; i += 1) {
    const probe = await fetch(`${baseUrl}/api/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: `probe-pc-${i}` })
    });
    assert.equal(probe.status, 404);
    assertHttpErrorResponseContract(await probe.json(), `heartbeatRateLimit.probe.${i}`, {
      errorCode: "device_not_found"
    });
  }

  // Once limited, even a valid signed heartbeat from the same source is refused
  // before business processing.
  const limited = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildHeartbeatPayload())
  });
  assert.equal(limited.status, 429);
  assertHttpErrorResponseContract(await limited.json(), "heartbeatRateLimit.limited", {
    errorCode: "heartbeat_rate_limited"
  });

  // The limit window expires (1.5s here); a successful heartbeat then clears the
  // failure counter so the next probes start from zero instead of instantly
  // re-triggering the limiter.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const recovered = await postJson(`${baseUrl}/api/devices/heartbeat`, buildHeartbeatPayload());
  assertServerHeartbeatResponseContract(recovered, "heartbeatRateLimit.recovered");
  const afterRecovery = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName: "probe-pc-after-recovery" })
  });
  assert.equal(afterRecovery.status, 404);
  assertHttpErrorResponseContract(await afterRecovery.json(), "heartbeatRateLimit.afterRecovery", {
    errorCode: "device_not_found"
  });
});

test("HTTP contract: server smoke can exercise the real claim lifecycle when opted in", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-smoke-lifecycle-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const smokeReportPath = join(tempRoot, "server-smoke-lifecycle.json");
  const smoke = await runServerSmoke(baseUrl, "", {
    jsonReportPath: smokeReportPath,
    exerciseClaimLifecycle: true
  });
  assert.equal(smoke.code, 0, smoke.stderr);
  assert.match(smoke.stdout, /claim-lifecycle-create/);
  assert.match(smoke.stdout, /claim-lifecycle-redeem/);
  assert.match(smoke.stdout, /claim-lifecycle-bound-replay/);
  assert.match(smoke.stdout, /claim-lifecycle-duplicate-redeem/);
  assert.match(smoke.stdout, /claim-lifecycle-different-binding-redeem/);
  assert.match(smoke.stdout, /claim-lifecycle-heartbeat/);
  assert.match(smoke.stdout, /claim-lifecycle-admin-state/);

  const smokeReport = JSON.parse(await readFile(smokeReportPath, "utf8"));
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.context.exerciseClaimLifecycle, true);
  assert.match(smokeReport.context.claimLifecycleClientName, /^sfsc-smoke-client-/);
  assert.match(smokeReport.context.claimLifecycleDeviceName, /^sfsc-smoke-device-/);
  assert.equal(smokeReport.summary.restartRequired, true);
  assert.equal(smokeReport.summary.userCount, 1);
  assert.equal(smokeReport.summary.deviceCount, 1);
  assert.equal(smokeReport.summary.claimCount, 1);
  assert.equal(JSON.stringify(smokeReport).includes("SFSC1-"), false);
  assert.equal(JSON.stringify(smokeReport).includes("sfsc://import/v1#"), false);
  for (const checkName of [
    "claim-lifecycle-create",
    "claim-lifecycle-redeem",
    "claim-lifecycle-bound-replay",
    "claim-lifecycle-duplicate-redeem",
    "claim-lifecycle-different-binding-redeem",
    "claim-lifecycle-heartbeat",
    "claim-lifecycle-admin-state"
  ]) {
    assert.equal(smokeReport.checks.some((check) => check.name === checkName), true);
  }

  const state = await getJson(`${baseUrl}/api/admin/state`);
  const device = state.devices.find((item) => item.clientName === smokeReport.context.claimLifecycleClientName);
  assert.ok(device);
  assertServerDeviceSummaryContract(device, "smokeLifecycle.adminDevice");
  assert.equal(device.online, true);
  assert.equal(device.clientVersion, "server-smoke-lifecycle");
  const claim = state.claims.find((item) => item.clientName === smokeReport.context.claimLifecycleClientName);
  assert.ok(claim);
  assertAdminClaimSummaryContract(claim, "smokeLifecycle.adminClaim");
  assert.equal(claim.used, true);
  assert.ok(claim.redeemedAt);
});

test("HTTP contract: server smoke can clean up its lifecycle test device when opted in", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-contract-smoke-cleanup-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const smokeReportPath = join(tempRoot, "server-smoke-lifecycle-cleanup.json");
  const smoke = await runServerSmoke(baseUrl, "", {
    jsonReportPath: smokeReportPath,
    exerciseClaimLifecycle: true,
    cleanupClaimLifecycle: true
  });
  assert.equal(smoke.code, 0, smoke.stderr);
  assert.match(smoke.stdout, /claim-lifecycle-cleanup-device/);

  const smokeReport = JSON.parse(await readFile(smokeReportPath, "utf8"));
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.context.exerciseClaimLifecycle, true);
  assert.equal(smokeReport.context.cleanupClaimLifecycle, true);
  assert.equal(smokeReport.context.cleanupClaimLifecycleUserDeleted, true);
  assert.equal(smokeReport.context.cleanupClaimLifecycleClaimRetained, true);
  assert.equal(smokeReport.context.cleanupClaimLifecycleRestartRequired, true);
  assert.match(smokeReport.context.claimLifecycleClientName, /^sfsc-smoke-client-/);
  assert.equal(smokeReport.summary.deviceCount, 0);
  assert.equal(smokeReport.summary.claimCount, 1);
  assert.equal(smokeReport.checks.some((check) => check.name === "claim-lifecycle-cleanup-device"), true);
  assert.equal(JSON.stringify(smokeReport).includes("SFSC1-"), false);
  assert.equal(JSON.stringify(smokeReport).includes("sfsc://import/v1#"), false);

  const state = await getJson(`${baseUrl}/api/admin/state`);
  assert.equal(state.devices.some((item) => item.clientName === smokeReport.context.claimLifecycleClientName), false);
  const retainedClaim = state.claims.find((item) => item.clientName === smokeReport.context.claimLifecycleClientName);
  assert.ok(retainedClaim);
  assertAdminClaimSummaryContract(retainedClaim, "smokeCleanup.retainedClaim");
  assert.equal(retainedClaim.used, true);
});

test("HTTP contract: server-issued SyncKey imports into client profile and accepts heartbeat", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-contract-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const singboxControlDir = join(tempRoot, "sing-box-control");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SINGBOX_CONTROL_DIR: singboxControlDir
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assertServerHealthResponseContract(health, "health");
  assert.equal(health.version, "0.3.0-rc.3");
  assert.equal(health.diagnostics.role, "server");
  assert.equal(health.diagnostics.version, "0.3.0-rc.3");
  assert.equal(health.diagnostics.protocols.profile, 2);
  assert.equal(health.diagnostics.protocols.heartbeat, 1);
  assert.deepEqual(health.adminAuth, { enabled: false });
  const stateForHealthContract = await getJson(`${baseUrl}/api/admin/state`);
  assert.deepEqual(health.diagnostics.protocols, stateForHealthContract.diagnostics.protocols);
  assert.deepEqual(health.serviceHealth, {
    ok: !stateForHealthContract.tunnel.restartRequired,
    apiReachable: true,
    restartRequired: stateForHealthContract.tunnel.restartRequired
  });
  // The public probe must not disclose operational scale.
  for (const field of ["enabledDeviceCount", "onlineDeviceCount", "bucketCount", "activeBucketCount"]) {
    assert.equal(field in health.serviceHealth, false, `serviceHealth.${field} must not be exposed`);
  }
  assertAdminStateSummaryContract(stateForHealthContract, "stateForHealthContract");
  assert.equal(stateForHealthContract.tunnel.id, "vless-main");
  assert.equal(stateForHealthContract.tunnel.protocol, "vless-tcp-none");
  assert.equal(stateForHealthContract.tunnel.listenHost, "0.0.0.0");
  assert.equal(stateForHealthContract.tunnel.listenPort, 45678);
  assert.equal(stateForHealthContract.tunnel.publicHost, "pass.971223.xyz");
  assert.equal(stateForHealthContract.tunnel.publicPort, 45678);
  assert.equal(stateForHealthContract.tunnel.security, "none");
  assert.equal(stateForHealthContract.tunnel.transport, "tcp");
  assert.equal(stateForHealthContract.tunnel.lastConfigWrittenAt, null);
  assert.equal(stateForHealthContract.tunnel.lastAppliedAt, null);
  assert.equal(stateForHealthContract.tunnel.restartRequired, false);
  assert.equal(stateForHealthContract.tunnel.userCount, 0);
  assert.equal(stateForHealthContract.tunnel.sampleUri, null);
  assert.match(stateForHealthContract.tunnel.reality.privateKey, /\*\*\*/);
  assert.equal(stateForHealthContract.storage.id, "home-minio");
  assert.equal(stateForHealthContract.storage.type, "s3");
  assert.equal(stateForHealthContract.storage.remoteName, "home-minio");
  assert.equal(stateForHealthContract.storage.bucket, "home-sync");
  assert.match(stateForHealthContract.storage.secretAccessKey, /\*\*\*/);
  assert.equal(JSON.stringify(stateForHealthContract.storage).includes("change-this-minio-root-password"), false);
  const defaultBucketSummary = stateForHealthContract.storage.buckets.find((bucket) => bucket.name === stateForHealthContract.storage.bucket);
  assert.ok(defaultBucketSummary);
  assert.equal(defaultBucketSummary.endpoint, stateForHealthContract.storage.endpoint);
  assert.equal(defaultBucketSummary.remoteName, stateForHealthContract.storage.remoteName);
  assert.deepEqual(defaultBucketSummary.prefixes, [
    `${stateForHealthContract.storage.prefixRoot}/`,
    `${stateForHealthContract.storage.sharedPrefix}/`
  ]);
  const smokeReportPath = join(tempRoot, "server-smoke.json");
  const smoke = await runServerSmoke(baseUrl, "", { jsonReportPath: smokeReportPath });
  assert.equal(smoke.code, 0);
  assert.match(smoke.stdout, /version=0\.3\.0-rc\.3/);
  assert.match(smoke.stdout, /protocols=aligned/);
  assert.match(smoke.stdout, /admin-auth: auth disabled/);
  assert.match(smoke.stdout, /admin-state/);
  assert.match(smoke.stdout, /SFSC server smoke JSON report written/);
  const smokeReport = JSON.parse(await readFile(smokeReportPath, "utf8"));
  assert.equal(smokeReport.schemaVersion, 1);
  assert.equal(smokeReport.type, "server-smoke-report");
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.context.baseUrl, baseUrl);
  assert.equal(smokeReport.context.adminAuthProvided, false);
  assert.equal(smokeReport.context.exerciseClaimLifecycle, false);
  assert.equal(smokeReport.context.claimLifecycleClientName, null);
  assert.equal(smokeReport.context.claimLifecycleDeviceName, null);
  assert.equal(smokeReport.summary.failed, 0);
  assert.equal(smokeReport.summary.restartRequired, false);
  assert.equal(smokeReport.summary.userCount, 0);
  assert.equal(smokeReport.summary.deviceCount, 0);
  assert.equal(smokeReport.summary.claimCount, 0);
  assert.equal(smokeReport.checks.some((check) => check.name === "health"), true);
  assert.equal(smokeReport.checks.some((check) => check.name === "vless-parse"), true);
  assert.equal(smokeReport.checks.some((check) => check.name === "singbox-client-config"), true);
  assert.equal(smokeReport.checks.some((check) => check.name.startsWith("claim-lifecycle-")), false);
  const stateAfterDefaultSmoke = await getJson(`${baseUrl}/api/admin/state`);
  assert.equal(stateAfterDefaultSmoke.devices.length, 0);
  assert.equal(stateAfterDefaultSmoke.claims.length, 0);

  const directWritten = await postJson(`${baseUrl}/api/admin/singbox/write`, {
    confirmWriteSingbox: true
  });
  assert.equal(directWritten.restartRequired, true);
  assertAdminSingboxWriteResponseContract(directWritten, "directWritten");
  assert.equal(directWritten.state.tunnel.restartRequired, true);
  const stateAfterDirectWrite = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(stateAfterDirectWrite, "stateAfterDirectWrite");
  assert.equal(stateAfterDirectWrite.tunnel.restartRequired, true);

  const supervisorResponse = respondToSingboxRestart(singboxControlDir);
  const directApplied = await postJson(`${baseUrl}/api/admin/singbox/apply`, {
    confirmApplySingbox: true
  });
  await supervisorResponse;
  assertAdminSingboxApplyResponseContract(directApplied, "directApplied");
  assert.equal(directApplied.restart.ok, true);
  assert.equal(directApplied.state.tunnel.restartRequired, false);

  await postJson(`${baseUrl}/api/admin/singbox/write`, {
    confirmWriteSingbox: true
  });
  const directMarkedApplied = await postJson(`${baseUrl}/api/admin/singbox/mark-applied`, {
    confirmMarkApplied: true
  });
  assertAdminSingboxMarkAppliedResponseContract(directMarkedApplied, "directMarkedApplied");
  assert.equal(directMarkedApplied.state.tunnel.restartRequired, false);

  const directApplySmokeReportPath = join(tempRoot, "server-smoke-after-direct-apply.json");
  const directApplySmoke = await runServerSmoke(baseUrl, "", { jsonReportPath: directApplySmokeReportPath });
  assert.equal(directApplySmoke.code, 0, directApplySmoke.stderr);
  const directApplySmokeReport = JSON.parse(await readFile(directApplySmokeReportPath, "utf8"));
  assert.equal(directApplySmokeReport.summary.restartRequired, false);

  const markAppliedWithoutPendingOrConfirmation = await fetch(`${baseUrl}/api/admin/singbox/mark-applied`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(markAppliedWithoutPendingOrConfirmation.status, 400);
  assertHttpErrorResponseContract(await markAppliedWithoutPendingOrConfirmation.json(), "markAppliedWithoutPendingOrConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const autofill = await postJson(`${baseUrl}/api/admin/tunnel/autofill`, {
    protocol: "vless-reality-tcp",
    remark: "contract",
    publicHost: "pass.971223.xyz",
    publicPort: 45679,
    listenPort: 45679,
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    forceRealityKeys: true
  });
  assert.match(autofill.tunnel.reality.privateKey, /\*\*\*/);
  assert.doesNotMatch(autofill.tunnel.reality.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(autofill.tunnel.protocol, "vless-reality-tcp");
  assert.equal(autofill.tunnel.security, "reality");
  assert.equal(autofill.tunnel.transport, "tcp");
  assert.equal(autofill.tunnel.publicHost, "pass.971223.xyz");
  assert.equal(autofill.tunnel.publicPort, 45679);
  assert.equal(autofill.tunnel.listenPort, 45679);
  assert.equal(autofill.tunnel.restartRequired, true);
  assert.equal(autofill.tunnel.userCount, 0);
  assert.equal(autofill.tunnel.sampleUri, null);
  assertAdminTunnelAutofillResponseContract(autofill, "autofill");
  assert.deepEqual(autofill.tunnel, autofill.state.tunnel);

  const configPreview = await getJson(`${baseUrl}/api/admin/singbox/config`);
  assertAdminSingboxConfigPreviewContract(configPreview, autofill.state, "configPreview");

  const rotateWithoutConfirmation = await fetch(`${baseUrl}/api/admin/tunnel/autofill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      remark: "contract",
      publicHost: "pass.971223.xyz",
      publicPort: 45679,
      listenPort: 45679,
      serverName: "www.microsoft.com",
      fingerprint: "chrome",
      forceRealityKeys: true
    })
  });
  assert.equal(rotateWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await rotateWithoutConfirmation.json(), "rotateWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const generateWithoutConfirmation = await fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      remark: "contract",
      publicHost: "pass.971223.xyz",
      publicPort: 45679,
      listenPort: 45679,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: autofill.tunnel.reality.publicKey,
        shortId: autofill.tunnel.reality.shortId
      }
    })
  });
  assert.equal(generateWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await generateWithoutConfirmation.json(), "generateWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const generated = await postJson(`${baseUrl}/api/admin/tunnel/generate`, {
    protocol: "vless-reality-tcp",
    remark: "contract",
    publicHost: "pass.971223.xyz",
    publicPort: 45679,
    listenPort: 45679,
    confirmGenerateTunnel: true,
    reality: {
      serverName: "www.microsoft.com",
      fingerprint: "chrome",
      publicKey: autofill.tunnel.reality.publicKey,
      shortId: autofill.tunnel.reality.shortId
    }
  });
  assertAdminTunnelGenerateResponseContract(generated, "generated");
  assert.deepEqual(generated.tunnel, generated.state.tunnel);
  assert.equal(generated.state.tunnel.restartRequired, true);
  assert.ok(generated.state.tunnel.lastConfigWrittenAt);
  assert.equal(generated.state.tunnel.security, "reality");
  assert.match(generated.state.tunnel.reality.privateKey, /\*\*\*/);
  assert.equal(generated.state.tunnel.sampleUri, null);

  const writeWithoutConfirmation = await fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(writeWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await writeWithoutConfirmation.json(), "writeWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const invalidJson = await fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(invalidJson.status, 400);
  assertHttpErrorResponseContract(await invalidJson.json(), "serverInvalidJson", {
    errorCode: "invalid_json",
    message: "Invalid JSON"
  });

  const oversizedJson = await fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmWriteSingbox: true, padding: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(oversizedJson.status, 413);
  assertHttpErrorResponseContract(await oversizedJson.json(), "serverOversizedJson", {
    errorCode: "request_body_too_large",
    message: "Request body too large"
  });

  const written = await postJson(`${baseUrl}/api/admin/singbox/write`, {
    confirmWriteSingbox: true
  });
  assert.equal(written.restartRequired, true);
  assertAdminSingboxWriteResponseContract(written, "written");
  assert.equal(written.state.tunnel.restartRequired, true);
  assert.match(written.config.inbounds[0].tls.reality.private_key, /\*\*\*/);

  const markAppliedWithoutConfirmation = await fetch(`${baseUrl}/api/admin/singbox/mark-applied`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(markAppliedWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await markAppliedWithoutConfirmation.json(), "markAppliedWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const markedApplied = await postJson(`${baseUrl}/api/admin/singbox/mark-applied`, {
    confirmMarkApplied: true
  });
  assertAdminSingboxMarkAppliedResponseContract(markedApplied, "markedApplied");
  assert.equal(markedApplied.state.tunnel.restartRequired, false);
  assert.ok(markedApplied.state.tunnel.lastAppliedAt);

  const markAppliedWithoutPendingChange = await fetch(`${baseUrl}/api/admin/singbox/mark-applied`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmMarkApplied: true })
  });
  assert.equal(markAppliedWithoutPendingChange.status, 400);
  assertHttpErrorResponseContract(await markAppliedWithoutPendingChange.json(), "markAppliedWithoutPendingChange", {
    errorCode: "validation_failed"
  });

  const created = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "contract-pc1",
    bucketName: "home-sync",
    server: `${baseUrl}/`,
    expiresInHours: 1,
    defaults: {
      transfers: 5,
      streams: 6,
      checkers: 7,
      chunkSize: "32M"
    }
  });

  assertClaimCreateResponseContract(created, "created", {
    expectedClientName: "contract-pc1",
    expectedServer: baseUrl
  });
  assert.equal(typeof created.state.tunnel.lastConfigWrittenAt, "string");
  assert.notEqual(created.state.tunnel.lastConfigWrittenAt, "");
  assert.match(created.tKey, /^SFSC1-/);
  assert.match(created.tKeyUri, /^sfsc:\/\/import\/v1#/);
  assert.equal(created.code, created.claim.code);
  assert.equal(created.claimCode, created.tKey);
  assert.equal(created.uri, created.tKeyUri);
  assert.equal(created.claim.server, baseUrl);
  assertAdminClaimSummaryContract(created.claim, "created.claim");
  assert.equal(Object.hasOwn(created.claim, "profile"), false);
  assert.equal(Object.hasOwn(created.claim, "tKey"), false);
  assert.equal(Object.hasOwn(created.claim, "tKeyUri"), false);
  assert.equal(Object.hasOwn(created.claim, "uri"), false);
  assert.equal(JSON.stringify(created.claim).includes(created.tKey), false);
  assert.deepEqual(decodeClaimToken(created.tKey), {
    version: 1,
    type: "claim",
    server: baseUrl,
    code: created.code
  });
  assert.deepEqual(decodeClaimToken(created.tKeyUri), decodeClaimToken(created.tKey));
  assert.equal(created.profile.clientName, "contract-pc1");
  assert.equal(created.profile.defaults.transfers, 5);
  assert.equal(created.profile.defaults.streams, 6);
  assert.equal(created.profile.defaults.checkers, 7);
  assert.equal(created.profile.defaults.chunkSize, "32M");

  const adminStateAfterClaimCreate = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(adminStateAfterClaimCreate, "adminStateAfterClaimCreate");
  assert.equal(adminStateAfterClaimCreate.settings.publicServerUrl, baseUrl);
  assert.equal(adminStateAfterClaimCreate.tunnel.userCount, 1);
  assert.equal(adminStateAfterClaimCreate.tunnel.sampleUri, null);
  assert.equal(adminStateAfterClaimCreate.tunnel.sampleUriAvailable, true);
  assertVlessUriMatchesTunnel(created.profile.tunnel.uri, adminStateAfterClaimCreate.tunnel);
  const createdUserSummary = adminStateAfterClaimCreate.users.find((user) => user.clientName === "contract-pc1");
  assert.ok(createdUserSummary);
  assert.equal(Object.hasOwn(createdUserSummary, "vlessUri"), false);
  assert.equal(createdUserSummary.vlessUriAvailable, true);
  assert.match(createdUserSummary.vlessUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/);
  const revealedVless = await getJson(`${baseUrl}${createdUserSummary.vlessUriRevealPath}`);
  assertAdminDeviceVlessUriRevealContract(revealedVless, adminStateAfterClaimCreate, "revealedVless");
  assert.equal(revealedVless.device.clientName, "contract-pc1");
  assert.equal(revealedVless.vlessUri.includes("contract-pc1"), true);
  const configAfterClaimCreate = await getJson(`${baseUrl}/api/admin/singbox/config`);
  assertAdminSingboxConfigPreviewContract(configAfterClaimCreate, adminStateAfterClaimCreate, "configAfterClaimCreate");
  const claimSummary = adminStateAfterClaimCreate.claims.find((claim) => claim.code === created.code);
  assert.ok(claimSummary);
  assertAdminClaimSummaryContract(claimSummary, "claimSummary");
  assert.equal(claimSummary.id, created.claim.id);
  assert.equal(claimSummary.userId, created.claim.userId);
  assert.equal(claimSummary.clientName, "contract-pc1");
  assert.equal(claimSummary.bucketName, "home-sync");
  assert.equal(claimSummary.profileId, created.profile.profileId);
  assert.equal(claimSummary.used, false);
  assert.equal(claimSummary.redeemedAt, null);
  assert.equal(claimSummary.server, baseUrl);
  assert.equal(JSON.stringify(claimSummary).includes(created.tKey), false);
  assert.equal(JSON.stringify(claimSummary).includes(created.profile.storage.secretAccessKey), false);

  const redeemBinding = {
    clientRedeemId: "contract-redeem-1",
    clientInstallId: "contract-install-1"
  };
  const rawRedeemed = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: created.tKey,
    ...redeemBinding
  });
  assertClaimRedeemResponseContract(rawRedeemed, "rawRedeemed", { expectedClientName: "contract-pc1" });
  assert.equal(Object.hasOwn(rawRedeemed, "source"), false);
  assert.equal(Object.hasOwn(rawRedeemed, "importMode"), false);
  assert.equal(Object.hasOwn(rawRedeemed, "importedAt"), false);

  const imported = await resolveProfileImport({ code: created.tKey }, {
    fetchImpl: fetch,
    ...redeemBinding
  });
  assert.equal(imported.importMode, "claim-redeem");
  assert.deepEqual(imported.source, {
    type: "claim",
    server: baseUrl
  });
  assert.equal(imported.clientName, "contract-pc1");
  assert.equal(imported.storage.bucket, "home-sync");
  assert.equal(imported.storage.prefix, "devices/contract-pc1");
  assert.equal(imported.defaults.transfers, 5);
  assert.equal(imported.defaults.streams, 6);

  const adminStateAfterClaimRedeem = await getJson(`${baseUrl}/api/admin/state`);
  const redeemedClaimSummary = adminStateAfterClaimRedeem.claims.find((claim) => claim.code === created.code);
  assertAdminClaimSummaryContract(redeemedClaimSummary, "redeemedClaimSummary");
  assert.equal(redeemedClaimSummary.used, true);
  assert.equal(JSON.stringify(redeemedClaimSummary).includes(created.tKey), false);

  const duplicateRedeem = await fetch(`${baseUrl}/api/claims/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tKey: created.tKey })
  });
  assert.equal(duplicateRedeem.status, 409);
  const duplicateError = await duplicateRedeem.json();
  assertHttpErrorResponseContract(duplicateError, "duplicateRedeem", {
    errorCode: "claim_already_used",
    message: "claim_already_used"
  });

  const unknownHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: "unknown-device",
      clientVersion: "contract-test",
      sync: {
        syncState: "idle"
      }
    })
  });
  assert.equal(unknownHeartbeat.status, 404);
  const unknownHeartbeatError = await unknownHeartbeat.json();
  assertHttpErrorResponseContract(unknownHeartbeatError, "unknownHeartbeat", {
    errorCode: "device_not_found",
    message: "device_not_found"
  });

  const unauthenticatedHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientName: imported.clientName,
      clientVersion: "contract-test",
      sync: { syncState: "idle" }
    })
  });
  assert.equal(unauthenticatedHeartbeat.status, 401);
  const unauthenticatedHeartbeatError = await unauthenticatedHeartbeat.json();
  assertHttpErrorResponseContract(unauthenticatedHeartbeatError, "unauthenticatedHeartbeat", {
    errorCode: "heartbeat_auth_required"
  });

  const unknownApi = await fetch(`${baseUrl}/api/unknown-route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(unknownApi.status, 404);
  assertHttpErrorResponseContract(await unknownApi.json(), "serverUnknownApi", {
    errorCode: "not_found",
    message: "Not found"
  });

  const missingStatic = await fetch(`${baseUrl}/missing-static-file.js`);
  assert.equal(missingStatic.status, 404);
  assertHttpErrorResponseContract(await missingStatic.json(), "serverMissingStatic", {
    errorCode: "not_found",
    message: "Not found"
  });

  const escapedStatic = await fetch(`${baseUrl}/%2e%2e%5cpackage.json`);
  assert.equal(escapedStatic.status, 400);
  assertHttpErrorResponseContract(await escapedStatic.json(), "serverEscapedStatic", {
    errorCode: "invalid_path",
    message: "Invalid path"
  });

  const heartbeatPayload = {
    clientName: imported.clientName,
    clientVersion: "contract-test",
    diagnostics: {
      app: "singbox-folder-sync",
      role: "client",
      version: "contract-test",
      buildId: "contract-build",
      buildTime: null,
      protocols: {
        claim: 1,
        profile: 2,
        adminState: 1,
        clientStatus: 1,
        heartbeat: 1
      }
    },
    storage: {
      bucket: imported.storage.bucket,
      prefix: imported.storage.prefix
    },
    sync: {
      syncState: "syncing",
      bytesPerSecond: 6250000,
      speedMbps: 50,
      progressPercent: 42.5,
      currentFile: "projects/current.iso",
      conflicts: {
        count: 1,
        files: ["projects/conflict.txt"]
      },
      scheduler: {
        enabled: true,
        intervalMs: 15000,
        nextRun: "2026-07-03T10:30:00.000Z",
        jobs: [{
          id: "job-1",
          name: "contract-sync",
          schedule: { mode: "interval", intervalMinutes: 30 },
          scheduleText: "Every 30 minutes",
          nextRun: "2026-07-03T10:30:00.000Z"
        }]
      },
      currentJob: {
        name: "contract-sync",
        direction: "bidirectional",
        bucketName: imported.storage.bucket,
        remotePrefix: imported.storage.prefix
      },
      lastRun: {
        id: "sync-contract-1",
        status: "success",
        trigger: "scheduler",
        startedAt: "2026-07-03T10:00:00.000Z",
        finishedAt: "2026-07-03T10:05:00.000Z",
        job: {
          name: "contract-sync",
          direction: "bidirectional",
          bucketName: imported.storage.bucket,
          remotePrefix: imported.storage.prefix
        },
        progressPercent: 100,
        transferredSizeText: "1 GiB / 1 GiB",
        currentFile: "projects/video.iso",
        rawSpeed: "8 MiB/s",
        speedMbps: 67.11,
        exitCode: 0,
        error: "",
        conflicts: {
          count: 1,
          files: ["projects/conflict.txt"]
        }
      }
    }
  };
  const signedHeartbeatPayload = signHeartbeatPayload(heartbeatPayload, imported);
  const heartbeat = await postJson(`${baseUrl}/api/devices/heartbeat`, signedHeartbeatPayload);

  assertServerHeartbeatResponseContract(heartbeat, "heartbeat");
  assertRuntimeDiagnosticsContract(heartbeat.diagnostics, "server", "heartbeat.diagnostics");
  assert.equal(heartbeat.diagnostics.protocols.heartbeat, 1);
  assertClientHeartbeatDeviceSummaryContract(heartbeat.device, "heartbeat.device");
  assert.equal(Object.hasOwn(heartbeat.device, "vlessUri"), false);
  assert.equal(heartbeat.device.clientName, "contract-pc1");
  assert.ok(heartbeat.device.id);
  assert.equal(heartbeat.device.enabled, true);
  assert.equal(heartbeat.device.online, true);
  assert.equal(heartbeat.device.status, "online");
  assert.ok(heartbeat.device.lastSeenAt);
  assert.equal(heartbeat.device.bucket, imported.storage.bucket);
  assert.equal(heartbeat.device.prefix, imported.storage.prefix);
  assert.equal(heartbeat.device.clientVersion, "contract-test");
  assert.ok(heartbeat.device.lastRemoteAddress);
  assert.equal(heartbeat.device.diagnostics.role, "client");
  assert.equal(heartbeat.device.diagnostics.version, "contract-test");
  assert.equal(heartbeat.device.diagnostics.buildId, "contract-build");
  assert.equal(heartbeat.device.diagnostics.protocols.heartbeat, 1);
  assert.equal(heartbeat.device.compatibility.ok, true);
  assert.equal(heartbeat.device.compatibility.status, "compatible");
  assert.equal(heartbeat.device.compatibility.action, "none");
  assert.equal(heartbeat.device.compatibility.policy.heartbeat, "allow");
  assert.equal(heartbeat.device.compatibility.policy.profileIssue, "allow");
  assert.equal(heartbeat.device.compatibility.policy.syncRun, "allow");
  assert.equal(heartbeat.device.syncState, "syncing");
  assert.equal(heartbeat.device.speedMbps, 50);
  assert.equal(heartbeat.device.sync.currentFile, "projects/current.iso");
  assert.equal(heartbeat.device.sync.lastRun.id, "sync-contract-1");
  assert.equal(heartbeat.device.sync.lastRun.status, "success");
  assert.equal(heartbeat.device.sync.lastRun.trigger, "scheduler");
  assert.equal(heartbeat.device.sync.lastRun.rawSpeed, "8 MiB/s");
  assert.equal(heartbeat.device.sync.lastRun.currentFile, "projects/video.iso");
  assert.equal(heartbeat.device.sync.lastRun.exitCode, 0);
  assert.equal(heartbeat.device.sync.conflicts.count, 1);
  assert.equal(heartbeat.device.sync.lastRun.conflicts.count, 1);
  assert.deepEqual(heartbeat.device.sync.lastRun.conflicts.files, ["projects/conflict.txt"]);
  assert.equal(heartbeat.device.sync.scheduler.nextRun, "2026-07-03T10:30:00.000Z");
  assert.deepEqual(heartbeat.device.sync.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 30 });
  assert.equal(heartbeat.device.sync.scheduler.jobs[0].scheduleText, "Every 30 minutes");

  const adminStateAfterHeartbeat = await getJson(`${baseUrl}/api/admin/state`);
  const adminDevice = adminStateAfterHeartbeat.devices.find((device) => device.id === heartbeat.device.id);
  assert.ok(adminDevice);
  assertServerDeviceSummaryContract(adminDevice, "adminDevice");
  assert.equal(Object.hasOwn(adminDevice, "vlessUri"), false);
  assert.equal(adminDevice.vlessUriAvailable, true);
  assert.match(adminDevice.vlessUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/);
  const revealedAdminDeviceVless = await getJson(`${baseUrl}${adminDevice.vlessUriRevealPath}`);
  assertAdminDeviceVlessUriRevealContract(revealedAdminDeviceVless, adminStateAfterHeartbeat, "revealedAdminDeviceVless");
  assert.equal(revealedAdminDeviceVless.device.id, adminDevice.id);
  assert.equal(adminDevice.clientName, "contract-pc1");
  assert.equal(adminDevice.enabled, true);
  assert.equal(adminDevice.online, true);
  assert.equal(adminDevice.status, "online");
  assert.ok(adminDevice.lastSeenAt);
  assert.equal(adminDevice.bucket, imported.storage.bucket);
  assert.equal(adminDevice.prefix, imported.storage.prefix);
  assert.equal(adminDevice.clientVersion, "contract-test");
  assert.equal(adminDevice.diagnostics.role, "client");
  assert.equal(adminDevice.diagnostics.version, "contract-test");
  assert.equal(adminDevice.diagnostics.buildId, "contract-build");
  assert.equal(adminDevice.diagnostics.protocols.heartbeat, 1);
  assert.equal(adminDevice.compatibility.ok, true);
  assert.equal(adminDevice.compatibility.status, "compatible");
  assert.equal(adminDevice.compatibility.action, "none");
  assert.equal(adminDevice.compatibility.severity, "ok");
  assert.equal(adminDevice.compatibility.policy.heartbeat, "allow");
  assert.equal(adminDevice.compatibility.policy.profileIssue, "allow");
  assert.equal(adminDevice.compatibility.policy.syncRun, "allow");
  assert.equal(adminDevice.compatibility.policy.adminActions, "allow");
  assert.equal(adminDevice.compatibility.policy.reason, "none");
  assert.deepEqual(adminDevice.compatibility.issues, []);
  assert.equal(adminDevice.sync.state, "syncing");
  assert.equal(adminDevice.syncState, adminDevice.sync.state);
  assert.equal(adminDevice.speedMbps, adminDevice.sync.speedMbps);
  assert.equal(adminDevice.speedMbps, 50);
  assert.equal(adminDevice.sync.currentFile, "projects/current.iso");
  assert.equal(adminDevice.sync.currentJob.name, "contract-sync");
  assert.equal(adminDevice.sync.currentJob.remotePrefix, imported.storage.prefix);
  assert.equal(adminDevice.sync.lastRun.id, "sync-contract-1");
  assert.equal(adminDevice.sync.lastRun.status, "success");
  assert.equal(adminDevice.sync.lastRun.trigger, "scheduler");
  assert.equal(adminDevice.sync.lastRun.speedMbps, 67.11);
  assert.equal(adminDevice.sync.lastRun.conflicts.count, 1);
  assert.equal(Object.hasOwn(adminDevice, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(adminDevice, "privateKey"), false);
  assert.equal(Object.hasOwn(adminDevice, "tKey"), false);
  assert.equal(Object.hasOwn(adminDevice, "claimCode"), false);

  const replayedHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signedHeartbeatPayload)
  });
  assert.equal(replayedHeartbeat.status, 401);
  const replayedHeartbeatError = await replayedHeartbeat.json();
  assertHttpErrorResponseContract(replayedHeartbeatError, "replayedHeartbeat", {
    errorCode: "heartbeat_auth_invalid"
  });

  const invalidHeartbeatCases = [
    {
      label: "wrongSecretHeartbeat",
      payload: signHeartbeatPayload(heartbeatPayload, imported, {
        secret: "wrong-heartbeat-secret",
        nonce: "wrong-secret-nonce"
      })
    },
    {
      label: "tamperedHeartbeat",
      payload: {
        ...signHeartbeatPayload(heartbeatPayload, imported, {
          nonce: "tampered-heartbeat"
        }),
        sync: {
          ...heartbeatPayload.sync,
          progressPercent: 99
        }
      }
    },
    {
      label: "expiredHeartbeat",
      payload: signHeartbeatPayload(heartbeatPayload, imported, {
        timestamp: "2026-07-03T10:00:00.000Z",
        nonce: "expired-heartbeat"
      })
    },
    {
      label: "malformedHeartbeat",
      payload: {
        ...heartbeatPayload,
        auth: {
          scheme: "sfsc-hmac-sha256-v1",
          timestamp: new Date().toISOString(),
          nonce: "bad",
          signature: "not-a-hex-signature"
        }
      }
    }
  ];
  for (const { label, payload } of invalidHeartbeatCases) {
    const response = await fetch(`${baseUrl}/api/devices/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 401, label);
    assertHttpErrorResponseContract(await response.json(), label, {
      errorCode: "heartbeat_auth_invalid"
    });
    const stateAfterInvalidHeartbeat = await getJson(`${baseUrl}/api/admin/state`);
    const deviceAfterInvalidHeartbeat = stateAfterInvalidHeartbeat.devices.find((device) => device.id === heartbeat.device.id);
    assert.ok(deviceAfterInvalidHeartbeat, label);
    assert.equal(deviceAfterInvalidHeartbeat.lastSeenAt, adminDevice.lastSeenAt, `${label}.lastSeenAt`);
    assert.equal(deviceAfterInvalidHeartbeat.clientVersion, adminDevice.clientVersion, `${label}.clientVersion`);
    assert.equal(deviceAfterInvalidHeartbeat.sync.progressPercent, adminDevice.sync.progressPercent, `${label}.sync.progressPercent`);
    assert.equal(deviceAfterInvalidHeartbeat.sync.currentFile, adminDevice.sync.currentFile, `${label}.sync.currentFile`);
  }

  const heartbeatWithInvalidPathsPayload = {
    clientName: imported.clientName,
    clientVersion: "contract-test",
    diagnostics: {
      app: "singbox-folder-sync",
      role: "client",
      version: "contract-test",
      buildId: "contract-build",
      buildTime: null,
      protocols: {
        claim: 1,
        profile: 2,
        adminState: 1,
        clientStatus: 1,
        heartbeat: 1
      }
    },
    sync: {
      syncState: "syncing",
      progressPercent: 88,
      rawSpeed: "9 MiB/s",
      currentJob: {
        name: "bad-path-current-job",
        direction: "upload",
        bucketName: imported.storage.bucket,
        remotePrefix: "C:/not/remote",
        remoteFolder: "../escape"
      },
      lastRun: {
        id: "sync-contract-bad-path",
        status: "error",
        job: {
          name: "bad-path-last-run",
          direction: "upload",
          bucketName: imported.storage.bucket,
          remotePrefix: "devices/../escape",
          remoteFolder: "bad|folder"
        },
        errorCode: "rclone_sync_failed",
        error: "bad remote path should not reject heartbeat",
        conflicts: {
          count: 2,
          files: ["projects/a.txt", "projects/b.txt"]
        }
      }
    }
  };
  const heartbeatWithInvalidPaths = await postJson(`${baseUrl}/api/devices/heartbeat`, signHeartbeatPayload(heartbeatWithInvalidPathsPayload, imported));

  assert.equal(heartbeatWithInvalidPaths.ok, true);
  assert.equal(heartbeatWithInvalidPaths.device.syncState, "syncing");
  assert.equal(heartbeatWithInvalidPaths.device.sync.progressPercent, 88);
  assert.equal(heartbeatWithInvalidPaths.device.sync.rawSpeed, "9 MiB/s");
  assert.equal(heartbeatWithInvalidPaths.device.sync.currentJob.name, "bad-path-current-job");
  assert.equal(heartbeatWithInvalidPaths.device.sync.currentJob.remotePrefix, "");
  assert.equal(heartbeatWithInvalidPaths.device.sync.currentJob.remoteFolder, "");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.id, "sync-contract-bad-path");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.status, "error");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.trigger, "manual");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.errorCode, "rclone_sync_failed");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.job.name, "bad-path-last-run");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.job.remotePrefix, "");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.job.remoteFolder, "");
  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.conflicts.count, 0);
  assert.deepEqual(heartbeatWithInvalidPaths.device.sync.lastRun.conflicts.files, []);
});

test("HTTP contract: admin token protects management APIs without blocking runtime APIs", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-auth-contract-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "test-admin-token";
  const clientStorageEndpoint = "http://n1-minio.sfsc:9000";
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      S3_ENDPOINT: "http://minio:9000",
      S3_CLIENT_ENDPOINT: clientStorageEndpoint,
      SFSC_ADMIN_TOKEN: adminToken
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.version, "0.3.0-rc.3");
  assert.equal(health.diagnostics.role, "server");
  assert.equal(health.diagnostics.protocols.adminState, 1);
  assert.deepEqual(health.adminAuth, { enabled: true });
  assert.equal(health.serviceHealth.apiReachable, true);
  assert.equal(typeof health.serviceHealth.restartRequired, "boolean");

  const unauthenticatedState = await fetch(`${baseUrl}/api/admin/state`);
  assert.equal(unauthenticatedState.status, 401);
  assertHttpErrorResponseContract(await unauthenticatedState.json(), "unauthenticatedState", {
    errorCode: "admin_auth_required"
  });

  const wrongTokenState = await fetch(`${baseUrl}/api/admin/state`, {
    headers: { authorization: "Bearer wrong-token" }
  });
  assert.equal(wrongTokenState.status, 401);
  assertHttpErrorResponseContract(await wrongTokenState.json(), "wrongTokenState", {
    errorCode: "admin_auth_required"
  });

  const authenticatedState = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assert.equal(authenticatedState.version, 1);
  assert.equal(authenticatedState.appVersion, "0.3.0-rc.3");
  assert.equal(authenticatedState.diagnostics.role, "server");
  assert.equal(authenticatedState.diagnostics.version, "0.3.0-rc.3");
  assert.equal(authenticatedState.diagnostics.protocols.profile, 2);
  assert.deepEqual(health.diagnostics.protocols, authenticatedState.diagnostics.protocols);
  assertAdminStateSummaryContract(authenticatedState, "authenticatedState");
  assert.equal(authenticatedState.users.length, 0);

  const authenticatedCheck = await getJson(`${baseUrl}/api/admin/auth/check`, adminToken);
  assertAdminAuthCheckResponseContract(authenticatedCheck, "authenticatedCheck");
  assert.equal(authenticatedCheck.adminAuth.enabled, true);

  const headerAuthenticatedCheckResponse = await fetch(`${baseUrl}/api/admin/auth/check`, {
    headers: { "X-SFSC-Admin-Token": adminToken }
  });
  assert.equal(headerAuthenticatedCheckResponse.status, 200);
  const headerAuthenticatedCheck = await headerAuthenticatedCheckResponse.json();
  assertAdminAuthCheckResponseContract(headerAuthenticatedCheck, "headerAuthenticatedCheck");
  assert.equal(headerAuthenticatedCheck.adminAuth.enabled, true);

  const smokeReportPath = join(tempRoot, "server-smoke-auth.json");
  const smoke = await runServerSmoke(baseUrl, adminToken, { jsonReportPath: smokeReportPath });
  assert.equal(smoke.code, 0);
  assert.match(smoke.stdout, /SFSC server smoke passed/);
  assert.match(smoke.stdout, /version=0\.3\.0-rc\.3/);
  assert.match(smoke.stdout, /protocols=aligned/);
  assert.match(smoke.stdout, /admin-auth-required/);
  assert.match(smoke.stdout, /admin-state/);
  assert.match(smoke.stdout, /singbox-config/);
  assert.match(smoke.stdout, /secret-masking/);
  const smokeReport = JSON.parse(await readFile(smokeReportPath, "utf8"));
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.context.adminAuthProvided, true);
  assert.equal(JSON.stringify(smokeReport).includes(adminToken), false);
  assert.equal(smokeReport.checks.some((check) => check.name === "admin-auth-required"), true);

  const storageSecret = "super-secret-management-key";
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    secretAccessKey: storageSecret
  }, adminToken);
  assert.equal(JSON.stringify(storageSave.storage).includes(storageSecret), false);
  assert.equal(JSON.stringify(storageSave.state.storage).includes(storageSecret), false);
  assert.match(storageSave.storage.secretAccessKey, /\*\*\*/);
  assertAdminStorageSummaryContract(storageSave.storage, "storageSave.storage");
  assertAdminStorageSaveResponseContract(storageSave, "storageSave", { rawSecrets: [storageSecret] });
  assert.deepEqual(storageSave.storage, storageSave.state.storage);

  const userCreate = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "auth-pc2"
  }, adminToken);
  assert.equal(JSON.stringify(userCreate.user).includes(storageSecret), false);
  assert.equal(JSON.stringify(userCreate.state.users).includes(storageSecret), false);
  assert.match(userCreate.user.storage.secretAccessKey, /\*\*\*/);
  assertAdminUserWriteResponseContract(userCreate, "userCreate", { rawSecrets: [storageSecret] });
  assertAdminUserContract(userCreate.user);
  assertAdminUserContract(userCreate.state.users.find((user) => user.id === userCreate.user.id));

  const disabledUser = await postJson(`${baseUrl}/api/admin/users/create`, {
    clientName: "disabled-pc",
    enabled: false
  }, adminToken);
  assert.equal(disabledUser.user.enabled, false);
  assertAdminUserWriteResponseContract(disabledUser, "disabledUser");
  assertAdminUserContract(disabledUser.user);

  const disabledClaim = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ clientName: "disabled-pc", server: baseUrl })
  });
  assert.equal(disabledClaim.status, 409);
  assertHttpErrorResponseContract(await disabledClaim.json(), "disabledClaim", {
    errorCode: "device_disabled"
  });

  const disabledHeartbeat = await fetch(`${baseUrl}/api/devices/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName: "disabled-pc", sync: { syncState: "idle" } })
  });
  assert.equal(disabledHeartbeat.status, 409);
  assertHttpErrorResponseContract(await disabledHeartbeat.json(), "disabledHeartbeat", {
    errorCode: "device_disabled"
  });

  const disabledAgain = await postJson(`${baseUrl}/api/admin/users/disable`, {
    userId: userCreate.user.id
  }, adminToken);
  assert.equal(disabledAgain.user.enabled, false);
  assertAdminUserWriteResponseContract(disabledAgain, "disabledAgain");
  assert.equal(disabledAgain.state.tunnel.restartRequired, true);

  const enabledAgain = await postJson(`${baseUrl}/api/admin/users/enable`, {
    userId: userCreate.user.id
  }, adminToken);
  assert.equal(enabledAgain.user.enabled, true);
  assertAdminUserWriteResponseContract(enabledAgain, "enabledAgain");

  const deleteUserWithoutConfirmation = await fetch(`${baseUrl}/api/admin/users/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: userCreate.user.id })
  });
  assert.equal(deleteUserWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await deleteUserWithoutConfirmation.json(), "deleteUserWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const deletedUser = await postJson(`${baseUrl}/api/admin/users/delete`, {
    userId: userCreate.user.id,
    confirmText: userCreate.user.clientName
  }, adminToken);
  assert.equal(deletedUser.ok, true);
  assert.equal(deletedUser.deletedUserId, userCreate.user.id);
  assertAdminUserDeleteResponseContract(deletedUser, "deletedUser");
  const deletedSummary = deletedUser.state.users.find((user) => user.id === userCreate.user.id);
  assertAdminUserContract(deletedSummary);
  assert.equal(deletedSummary.enabled, false);
  assert.equal(typeof deletedSummary.deletedAt, "string");

  const enableDeletedUser = await fetch(`${baseUrl}/api/admin/users/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: userCreate.user.id })
  });
  assert.equal(enableDeletedUser.status, 404);
  assertHttpErrorResponseContract(await enableDeletedUser.json(), "enableDeletedUser", {
    errorCode: "user_not_found"
  });

  const deleteMissingUser = await fetch(`${baseUrl}/api/admin/users/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: "missing-user", confirmText: userCreate.user.clientName })
  });
  assert.equal(deleteMissingUser.status, 404);
  assertHttpErrorResponseContract(await deleteMissingUser.json(), "deleteMissingUser", {
    errorCode: "user_not_found"
  });
  assert.equal(deletedUser.state.devices.some((device) => device.id === userCreate.user.id), false);

  const unauthenticatedCheck = await fetch(`${baseUrl}/api/admin/auth/check`);
  assert.equal(unauthenticatedCheck.status, 401);
  assertHttpErrorResponseContract(await unauthenticatedCheck.json(), "unauthenticatedCheck", {
    errorCode: "admin_auth_required"
  });

  const archiveBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "archive-sync"
  }, adminToken);
  assert.equal(archiveBucket.bucket.name, "archive-sync");
  assert.equal(archiveBucket.provision.ok, false);
  assert.equal(archiveBucket.provision.errorCode, "storage_request_failed");
  assert.match(archiveBucket.provision.warning, /fetch failed|ECONNREFUSED|ENOTFOUND|MinIO/i);
  assertAdminStorageBucketCreateResponseContract(archiveBucket, "archiveBucket");
  assert.equal(archiveBucket.state.storage.buckets.some((bucket) => bucket.name === "archive-sync"), true);
  const archiveBucketSummary = archiveBucket.state.storage.buckets.find((bucket) => bucket.name === "archive-sync");
  assert.equal(archiveBucketSummary.endpoint, archiveBucket.state.storage.endpoint);
  assert.equal(archiveBucketSummary.remoteName, archiveBucket.state.storage.remoteName);
  assert.deepEqual(archiveBucketSummary.prefixes, [
    `${archiveBucket.state.storage.prefixRoot}/`,
    `${archiveBucket.state.storage.sharedPrefix}/`
  ]);

  const disabledArchiveBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/disable`, {
    bucket: "archive-sync"
  }, adminToken);
  assert.equal(disabledArchiveBucket.bucket.disabledAt.length > 0, true);
  assertAdminStorageBucketToggleResponseContract(disabledArchiveBucket, "disabledArchiveBucket");
  const disabledArchiveBucketSummary = disabledArchiveBucket.state.storage.buckets.find((bucket) => bucket.name === "archive-sync");
  assert.equal(disabledArchiveBucketSummary.disabledAt, disabledArchiveBucket.bucket.disabledAt);
  assert.deepEqual(disabledArchiveBucketSummary.prefixes, [
    `${disabledArchiveBucket.state.storage.prefixRoot}/`,
    `${disabledArchiveBucket.state.storage.sharedPrefix}/`
  ]);

  const clearDisabledBucket = await fetch(`${baseUrl}/api/admin/storage/buckets/clear`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "archive-sync", confirmBucket: "archive-sync" })
  });
  assert.equal(clearDisabledBucket.status, 409);
  assertHttpErrorResponseContract(await clearDisabledBucket.json(), "clearDisabledBucket", {
    errorCode: "bucket_disabled"
  });

  const deleteDisabledBucket = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "archive-sync", confirmBucket: "archive-sync" })
  });
  assert.equal(deleteDisabledBucket.status, 409);
  assertHttpErrorResponseContract(await deleteDisabledBucket.json(), "deleteDisabledBucket", {
    errorCode: "bucket_disabled"
  });

  const clearWithoutConfirmation = await fetch(`${baseUrl}/api/admin/storage/buckets/clear`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync" })
  });
  assert.equal(clearWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await clearWithoutConfirmation.json(), "clearWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const deleteWithoutConfirmation = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync" })
  });
  assert.equal(deleteWithoutConfirmation.status, 400);
  assertHttpErrorResponseContract(await deleteWithoutConfirmation.json(), "deleteWithoutConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const deleteActiveWithOnlyDisabledReplacement = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync", confirmBucket: "home-sync" })
  });
  assert.equal(deleteActiveWithOnlyDisabledReplacement.status, 409);
  assertHttpErrorResponseContract(await deleteActiveWithOnlyDisabledReplacement.json(), "deleteActiveWithOnlyDisabledReplacement", {
    errorCode: "last_active_bucket_disable_blocked"
  });
  const stateAfterBlockedActiveDelete = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assertAdminStateSummaryContract(stateAfterBlockedActiveDelete, "stateAfterBlockedActiveDelete");
  assert.equal(stateAfterBlockedActiveDelete.storage.bucket, "home-sync");
  assert.equal(stateAfterBlockedActiveDelete.storage.buckets.some((bucket) => bucket.name === "home-sync"), true);

  const disableLastActiveBucket = await fetch(`${baseUrl}/api/admin/storage/buckets/disable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync" })
  });
  assert.equal(disableLastActiveBucket.status, 409);
  assertHttpErrorResponseContract(await disableLastActiveBucket.json(), "disableLastActiveBucket", {
    errorCode: "last_active_bucket_disable_blocked"
  });

  const enabledArchiveBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/enable`, {
    bucket: "archive-sync"
  }, adminToken);
  assert.equal(enabledArchiveBucket.bucket.disabledAt, null);
  assertAdminStorageBucketToggleResponseContract(enabledArchiveBucket, "enabledArchiveBucket");
  const enabledArchiveBucketSummary = enabledArchiveBucket.state.storage.buckets.find((bucket) => bucket.name === "archive-sync");
  assert.equal(enabledArchiveBucketSummary.disabledAt, null);

  const refreshedBuckets = await postJson(`${baseUrl}/api/admin/storage/buckets/refresh`, {}, adminToken);
  assert.equal(Array.isArray(refreshedBuckets.buckets), true);
  assertAdminStorageBucketsRefreshResponseContract(refreshedBuckets, "refreshedBuckets");

  const deleteMissingBucket = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "missing-bucket", confirmBucket: "missing-bucket" })
  });
  assert.equal(deleteMissingBucket.status, 404);
  assertHttpErrorResponseContract(await deleteMissingBucket.json(), "deleteMissingBucket", {
    errorCode: "bucket_not_found"
  });

  const unauthenticatedCreate = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName: "auth-pc1", server: baseUrl })
  });
  assert.equal(unauthenticatedCreate.status, 401);
  assertHttpErrorResponseContract(await unauthenticatedCreate.json(), "unauthenticatedCreate", {
    errorCode: "admin_auth_required"
  });

  for (const path of [
    "/api/vless/parse",
    "/api/singbox/client-config",
    "/api/profile/encode",
    "/api/jobs/preview"
  ]) {
    const unauthenticatedCompatibilityRoute = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(unauthenticatedCompatibilityRoute.status, 401);
    assertHttpErrorResponseContract(await unauthenticatedCompatibilityRoute.json(), "unauthenticatedCompatibilityRoute", {
      errorCode: "admin_auth_required"
    });
  }

  const invalidCreate = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ clientName: "bad name", server: baseUrl })
  });
  assert.equal(invalidCreate.status, 400);
  assertHttpErrorResponseContract(await invalidCreate.json(), "invalidCreate", {
    errorCode: "validation_failed"
  });

  const stateBeforeMalformedClaimCreate = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  const malformedClaimCreate = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  });
  assert.equal(malformedClaimCreate.status, 400);
  assertHttpErrorResponseContract(await malformedClaimCreate.json(), "malformedClaimCreate", {
    errorCode: "validation_failed"
  });
  const stateAfterMalformedClaimCreate = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assert.equal(stateAfterMalformedClaimCreate.claims.length, stateBeforeMalformedClaimCreate.claims.length);
  assert.equal(stateAfterMalformedClaimCreate.users.length, stateBeforeMalformedClaimCreate.users.length);

  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/autofill`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      serverName: "https://www.microsoft.com"
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      publicHost: "pass.971223.xyz",
      publicPort: "70000",
      listenPort: 45678,
      confirmGenerateTunnel: true,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: REALITY_PUBLIC_KEY,
        privateKey: REALITY_PRIVATE_KEY,
        shortId: REALITY_SHORT_ID
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      publicHost: "pass.971223.xyz",
      publicPort: 45678,
      listenPort: 45678,
      confirmGenerateTunnel: true,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: "SERVER_PUBLIC_KEY",
        privateKey: REALITY_PRIVATE_KEY,
        shortId: REALITY_SHORT_ID
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      publicHost: "pass.971223.xyz",
      publicPort: 45678,
      listenPort: 45678,
      confirmGenerateTunnel: true,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: REALITY_PUBLIC_KEY,
        privateKey: "",
        shortId: REALITY_SHORT_ID
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      protocol: "vless-reality-tcp",
      publicHost: "pass.971223.xyz",
      publicPort: 45678,
      listenPort: 45678,
      confirmGenerateTunnel: true,
      reality: {
        serverName: "www.microsoft.com",
        fingerprint: "chrome",
        publicKey: REALITY_PUBLIC_KEY,
        privateKey: REALITY_PRIVATE_KEY,
        shortId: "not-hex"
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ confirmGenerateTunnel: "true" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ confirmGenerateTunnel: true, reality: [] })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/tunnel/autofill`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ forceRealityKeys: "yes" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/singbox/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ confirmWriteSingbox: "true" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/singbox/mark-applied`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ confirmMarkApplied: "true" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ prefixRoot: "../devices" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ sharedPrefix: "C:\\shared" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ endpoint: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/disable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/clear`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync", confirmBucket: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ bucket: "home-sync", confirmBucket: 123 })
  }));
  const stateBeforeMalformedUserCreate = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ clientName: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ enabled: "false" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ forceNew: "yes" })
  }));
  const stateAfterMalformedUserCreate = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assert.equal(stateAfterMalformedUserCreate.users.length, stateBeforeMalformedUserCreate.users.length);
  assert.equal(stateAfterMalformedUserCreate.devices.length, stateBeforeMalformedUserCreate.devices.length);
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: "missing-user", confirmCompatibilityWarning: "true" })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/disable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/admin/users/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: "missing-user", confirmText: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      clientName: "bad-schedule-defaults",
      server: baseUrl,
      defaults: {
        schedule: { mode: "interval", intervalMinutes: 0 }
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      clientName: "bad-bandwidth-defaults",
      server: baseUrl,
      defaults: {
        bandwidthLimit: "fast"
      }
    })
  }));

  for (const [index, [field, value]] of [
    ["localProxyPort", "abc"],
    ["localProxyPort", 0],
    ["localProxyPort", 70000],
    ["localProxyPort", 1.5],
    ["transfers", "many"],
    ["streams", 0],
    ["checkers", -1],
    ["retries", 1.5],
    ["lowLevelRetries", "many"],
    ["chunkSize", ""],
    ["chunkSize", []],
    ["chunkSize", {}]
  ].entries()) {
    await assertValidationFailedResponse(fetch(`${baseUrl}/api/claims/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        clientName: `bad-claim-defaults-${index}`,
        server: baseUrl,
        defaults: {
          [field]: value
        }
      })
    }));
  }

  const validTunnelUri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&flow=&security=reality&sni=www.microsoft.com&fp=chrome&type=tcp&pbk=SERVER_PUBLIC_KEY&sid=abcd1234#home-sync";
  const parsedVless = await postJson(`${baseUrl}/api/vless/parse`, {
    uri: validTunnelUri
  }, adminToken);
  assertVlessParseResponseContract(parsedVless, "parsedVless");
  assert.equal(parsedVless.profile.server, "pass.971223.xyz");
  assert.equal(parsedVless.profile.port, 45678);
  assert.equal(parsedVless.profile.security, "reality");
  assert.equal(parsedVless.profile.publicKey, "SERVER_PUBLIC_KEY");

  const invalidVlessParse = await fetch(`${baseUrl}/api/vless/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ uri: "https://example.com/not-vless" })
  });
  assert.equal(invalidVlessParse.status, 400);
  assertHttpErrorResponseContract(await invalidVlessParse.json(), "invalidVlessParse", {
    errorCode: "invalid_vless_uri"
  });

  await assertValidationFailedResponse(fetch(`${baseUrl}/api/vless/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/vless/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ uri: 123 })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/singbox/client-config`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ uri: validTunnelUri, options: [] })
  }));

  const profileEncodeMissingTunnel = await fetch(`${baseUrl}/api/profile/encode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ clientName: "auth-pc1" })
  });
  assert.equal(profileEncodeMissingTunnel.status, 400);
  assertHttpErrorResponseContract(await profileEncodeMissingTunnel.json(), "profileEncodeMissingTunnel", {
    errorCode: "profile_tunnel_required"
  });

  const malformedProfileEncode = await fetch(`${baseUrl}/api/profile/encode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify([])
  });
  assert.equal(malformedProfileEncode.status, 400);
  assertHttpErrorResponseContract(await malformedProfileEncode.json(), "malformedProfileEncode", {
    errorCode: "validation_failed"
  });

  for (const [context, patch] of [
    ["emptyProfileHeartbeatSecret", { heartbeatSecret: "" }],
    ["emptyProfileNestedHeartbeatSecret", { heartbeat: { secret: "" } }],
    ["emptyProfileRemoteName", { remoteName: "" }],
    ["emptyProfileEndpoint", { endpoint: "" }],
    ["emptyProfileBucket", { bucket: "" }],
    ["emptyProfileAccessKeyId", { accessKeyId: "" }],
    ["emptyProfileSecretAccessKey", { secretAccessKey: "" }],
    ["emptyProfilePrefix", { prefix: "" }]
  ]) {
    const response = await fetch(`${baseUrl}/api/profile/encode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        clientName: "empty-profile-field-pc",
        uri: validTunnelUri,
        ...patch
      })
    });
    assert.equal(response.status, 400);
    assertHttpErrorResponseContract(await response.json(), context, {
      errorCode: "validation_failed"
    });
  }

  for (const [field, value] of [
    ["localProxyPort", "abc"],
    ["localProxyPort", 0],
    ["localProxyPort", 70000],
    ["localProxyPort", 1.5],
    ["transfers", "many"],
    ["streams", 0],
    ["checkers", -1],
    ["retries", 1.5],
    ["lowLevelRetries", "many"]
  ]) {
    await assertValidationFailedResponse(fetch(`${baseUrl}/api/profile/encode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        clientName: "bad-profile-defaults",
        uri: validTunnelUri,
        [field]: value
      })
    }));
  }

  for (const defaults of ["bad-defaults", []]) {
    await assertValidationFailedResponse(fetch(`${baseUrl}/api/profile/encode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        clientName: "bad-profile-defaults-shell",
        uri: validTunnelUri,
        defaults
      })
    }));
  }

  const encodedProfile = await postJson(`${baseUrl}/api/profile/encode`, {
    clientName: "auth-pc1",
    uri: validTunnelUri,
    endpoint: "http://minio:9000",
    bucket: "home-sync",
    accessKeyId: "auth-pc1",
    secretAccessKey: "profile-encode-secret",
    prefix: "devices/auth-pc1",
    localProxyPort: 18082,
    schedule: {
      mode: "interval",
      intervalMinutes: 30
    }
  }, adminToken);
  assertProfileEncodeResponseContract(encodedProfile, "encodedProfile", {
    expectedClientName: "auth-pc1",
    expectedStorageSecretAccessKey: "profile-encode-secret"
  });
  assert.equal(encodedProfile.profile.clientName, "auth-pc1");
  assert.equal(encodedProfile.profile.source.type, "profile");
  assert.match(encodedProfile.profile.source.server, /^https?:\/\//);
  assert.equal(encodedProfile.profile.tunnel.uri, validTunnelUri);
  assert.equal(encodedProfile.profile.heartbeat.scheme, "sfsc-hmac-sha256-v1");
  assert.equal(typeof encodedProfile.profile.heartbeat.secret, "string");
  assert.notEqual(encodedProfile.profile.heartbeat.secret, "");
  assert.equal(encodedProfile.profile.storage.secretAccessKey, "profile-encode-secret");
  assert.equal(encodedProfile.profile.defaults.localProxyPort, 18082);
  assert.equal(encodedProfile.profile.defaults.schedule.mode, "interval");
  assert.equal(encodedProfile.summary.clientName, "auth-pc1");
  assert.equal(encodedProfile.summary.server, "pass.971223.xyz:45678");
  assert.equal(encodedProfile.summary.storage, "home-sync/devices/auth-pc1");
  assert.match(encodedProfile.code, /^SFSC1-/);
  assert.match(encodedProfile.uri, /^sfsc:\/\/import\/v1#/);
  const decodedProfileCode = decodeImportProfile(encodedProfile.code);
  const decodedProfileUri = decodeImportProfile(encodedProfile.uri);
  assert.equal(decodedProfileCode.heartbeat.secret, encodedProfile.profile.heartbeat.secret);
  assert.equal(decodedProfileUri.heartbeat.secret, encodedProfile.profile.heartbeat.secret);
  assert.equal(decodedProfileCode.source.type, "profile");
  assert.equal(decodedProfileUri.source.type, "profile");
  assert.deepEqual(decodedProfileCode.source, encodedProfile.profile.source);
  assert.deepEqual(decodedProfileUri.source, encodedProfile.profile.source);
  assert.deepEqual(decodedProfileCode.tunnel.parsed, encodedProfile.profile.tunnel.parsed);
  assert.deepEqual(decodedProfileUri.tunnel.parsed, encodedProfile.profile.tunnel.parsed);

  const encodedProfileWithStateStorage = await postJson(`${baseUrl}/api/profile/encode`, {
    clientName: "auth-pc-state-storage",
    uri: validTunnelUri
  }, adminToken);
  assertProfileEncodeResponseContract(encodedProfileWithStateStorage, "encodedProfileWithStateStorage", {
    expectedClientName: "auth-pc-state-storage"
  });
  assert.equal(encodedProfileWithStateStorage.profile.storage.remoteName, "home-minio");
  assert.equal(encodedProfileWithStateStorage.profile.storage.endpoint, clientStorageEndpoint);
  assert.equal(encodedProfileWithStateStorage.profile.storage.bucket, "home-sync");
  assert.equal(encodedProfileWithStateStorage.profile.storage.prefix, "devices/auth-pc-state-storage");

  const encodedNestedDefaultsProfile = await postJson(`${baseUrl}/api/profile/encode`, {
    clientName: "auth-pc2",
    uri: validTunnelUri,
    defaults: {
      localProxyPort: 18083,
      transfers: 5,
      streams: 6,
      checkers: 7,
      retries: 2,
      lowLevelRetries: 11,
      schedule: {
        mode: "daily",
        time: "03:15"
      }
    }
  }, adminToken);
  assertProfileEncodeResponseContract(encodedNestedDefaultsProfile, "encodedNestedDefaultsProfile", {
    expectedClientName: "auth-pc2"
  });
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.localProxyPort, 18083);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.transfers, 5);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.streams, 6);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.checkers, 7);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.retries, 2);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.lowLevelRetries, 11);
  assert.equal(encodedNestedDefaultsProfile.profile.defaults.schedule.mode, "daily");
  assert.deepEqual(
    decodeImportProfile(encodedNestedDefaultsProfile.code).defaults,
    encodedNestedDefaultsProfile.profile.defaults
  );

  const clientConfig = await postJson(`${baseUrl}/api/singbox/client-config`, {
    uri: validTunnelUri,
    options: {
      localProxyPort: 18082,
      localProxyHost: "0.0.0.0",
      logLevel: "debug",
      ignored: "drop-me"
    }
  }, adminToken);
  assertSingboxClientConfigResponseContract(clientConfig, "clientConfig", { localProxyPort: 18082 });
  assert.equal(clientConfig.profile.server, "pass.971223.xyz");
  assert.equal(clientConfig.profile.port, 45678);
  assert.equal(clientConfig.config.log.level, "info");
  assert.equal(clientConfig.config.inbounds[0].type, "mixed");
  assert.equal(clientConfig.config.inbounds[0].listen, "127.0.0.1");
  assert.equal(clientConfig.config.inbounds[0].listen_port, 18082);
  assert.equal(clientConfig.config.outbounds[0].type, "vless");
  assert.equal(clientConfig.config.outbounds[0].server, "pass.971223.xyz");
  assert.equal(clientConfig.config.outbounds[0].multiplex.enabled, false);
  assert.equal(clientConfig.config.outbounds[0].tls.reality.enabled, true);
  assert.equal(JSON.stringify(clientConfig.config).includes('"tun"'), false);

  const previewSecret = "preview-secret-for-contract";
  const jobsPreview = await postJson(`${baseUrl}/api/jobs/preview`, {
    uri: validTunnelUri,
    options: {
      localProxyPort: 18082,
      localProxyHost: "0.0.0.0",
      logLevel: "debug"
    },
    job: {
      direction: "upload",
      localPath: "D:\\Work\\Projects",
      remoteName: "home-minio",
      bucketName: "home-sync",
      clientName: "auth-pc1",
      remoteFolder: "projects",
      storageBackend: "s3",
      streams: 8,
      transfers: 4,
      accessKeyId: "auth-pc1",
      secretAccessKey: previewSecret,
      dryRun: true,
      schedule: {
        mode: "interval",
        intervalMinutes: 30
      }
    }
  }, adminToken);
  assert.equal(jobsPreview.profile.server, "pass.971223.xyz");
  assert.equal(jobsPreview.singbox.log.level, "info");
  assert.equal(jobsPreview.singbox.inbounds[0].listen, "127.0.0.1");
  assert.equal(jobsPreview.singbox.inbounds[0].listen_port, 18082);
  assert.equal(jobsPreview.rclone.executable, "rclone");
  assert.equal(jobsPreview.rclone.args[0], "copy");
  assert.equal(jobsPreview.rclone.remotePath, "home-minio:home-sync/devices/auth-pc1/projects");
  assert.equal(jobsPreview.rclone.env.ALL_PROXY, "socks5://127.0.0.1:18082");
  assert.equal(jobsPreview.rclone.safety.usesProcessScopedProxy, true);
  assert.equal(jobsPreview.rclone.safety.mutatesSystemProxy, false);
  assert.equal(jobsPreview.rclone.safety.tunRequired, false);
  assertJobsPreviewResponseContract(jobsPreview, "jobsPreview", {
    rawSecrets: [previewSecret],
    remoteConfigSecret: previewSecret,
    localProxyPort: 18082
  });
  assert.equal(jobsPreview.rclone.remoteConfig.args.includes(previewSecret), false);
  assert.equal(jobsPreview.rclone.remoteConfig.args.includes("secret_access_key"), false);
  assert.equal(jobsPreview.rclone.remoteConfig.env.RCLONE_CONFIG_HOME_MINIO_SECRET_ACCESS_KEY, previewSecret);
  assert.equal(jobsPreview.rclone.remoteConfig.displayCommand.includes(previewSecret), false);
  assert.match(jobsPreview.rclone.remoteConfig.displayCommand, /pr\*\*\*\*ct/);
  assert.equal(jobsPreview.schedule.text, "Every 30 minutes");
  assert.match(jobsPreview.schedule.nextRun, /^\d{4}-\d{2}-\d{2}T/);

  const jobsPreviewNoUri = await postJson(`${baseUrl}/api/jobs/preview`, {
    job: {
      direction: "upload",
      localPath: "D:\\Work\\Projects",
      remoteName: "home-minio",
      bucketName: "home-sync",
      clientName: "auth-pc1",
      remoteFolder: "projects",
      storageBackend: "s3",
      accessKeyId: "auth-pc1",
      secretAccessKey: previewSecret,
      dryRun: true,
      schedule: { mode: "manual" }
    }
  }, adminToken);
  assertJobsPreviewResponseContract(jobsPreviewNoUri, "jobsPreviewNoUri", {
    rawSecrets: [previewSecret],
    remoteConfigSecret: previewSecret
  });
  assert.equal(jobsPreviewNoUri.profile, null);
  assert.equal(jobsPreviewNoUri.singbox, null);
  assert.equal(jobsPreviewNoUri.schedule.text, "Manual only");

  for (const localProxyPort of ["abc", 70000]) {
    await assertValidationFailedResponse(fetch(`${baseUrl}/api/jobs/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        uri: validTunnelUri,
        options: { localProxyPort },
        job: {
          localPath: "D:\\Work",
          remoteFolder: "projects"
        }
      })
    }));
  }
  for (const [field, value] of [
    ["transfers", "many"],
    ["streams", 0],
    ["checkers", -1],
    ["retries", 1.5],
    ["lowLevelRetries", "many"],
    ["s3UploadConcurrency", 0]
  ]) {
    await assertValidationFailedResponse(fetch(`${baseUrl}/api/jobs/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        uri: validTunnelUri,
        job: {
          localPath: "D:\\Work",
          remoteFolder: "projects",
          [field]: value
        }
      })
    }));
  }

  await assertValidationFailedResponse(fetch(`${baseUrl}/api/jobs/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      uri: validTunnelUri,
      job: {
        localPath: "D:\\Work",
        remoteFolder: "../escape"
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/jobs/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      uri: validTunnelUri,
      job: {
        localPath: "D:\\Work",
        bandwidthLimit: "fast"
      }
    })
  }));
  await assertValidationFailedResponse(fetch(`${baseUrl}/api/jobs/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      uri: validTunnelUri,
      job: {
        localPath: "D:\\Work",
        schedule: { mode: "interval", intervalMinutes: 0 }
      }
    })
  }));

  const created = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: "auth-pc1",
    server: baseUrl,
    expiresInHours: 1
  }, adminToken);
  assert.match(created.tKey, /^SFSC1-/);

  const authRedeemBinding = {
    clientRedeemId: "auth-contract-redeem-1",
    clientInstallId: "auth-contract-install-1"
  };
  const rawImported = await postJson(`${baseUrl}/api/claims/redeem`, {
    tKey: created.tKey,
    ...authRedeemBinding
  });
  assertClaimRedeemResponseContract(rawImported, "authContract.rawImported", { expectedClientName: "auth-pc1" });

  const imported = await resolveProfileImport({ code: created.tKey }, {
    fetchImpl: fetch,
    ...authRedeemBinding
  });
  assert.equal(imported.clientName, "auth-pc1");

  const heartbeat = await postJson(`${baseUrl}/api/devices/heartbeat`, signHeartbeatPayload({
    clientName: imported.clientName,
    clientVersion: "auth-contract-test",
    sync: {
      syncState: "idle"
    }
  }, imported));
  assertServerHeartbeatResponseContract(heartbeat, "authContract.heartbeat");
  const heartbeatDeviceId = heartbeat.device.id;

  const disabledIncompatible = await postJson(`${baseUrl}/api/admin/users/disable`, {
    userId: heartbeatDeviceId
  }, adminToken);
  assert.equal(disabledIncompatible.user.enabled, false);
  assertAdminUserWriteResponseContract(disabledIncompatible, "disabledIncompatible");

  const enableWithoutCompatibilityConfirmation = await fetch(`${baseUrl}/api/admin/users/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userId: heartbeatDeviceId })
  });
  assert.equal(enableWithoutCompatibilityConfirmation.status, 400);
  assertHttpErrorResponseContract(await enableWithoutCompatibilityConfirmation.json(), "enableWithoutCompatibilityConfirmation", {
    errorCode: "danger_confirmation_required"
  });

  const enabledIncompatible = await postJson(`${baseUrl}/api/admin/users/enable`, {
    userId: heartbeatDeviceId,
    confirmCompatibilityWarning: true
  }, adminToken);
  assert.equal(enabledIncompatible.user.enabled, true);
  assertAdminUserWriteResponseContract(enabledIncompatible, "enabledIncompatible");

  const incompatibleClaim = await fetch(`${baseUrl}/api/claims/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      clientName: imported.clientName,
      server: baseUrl
    })
  });
  assert.equal(incompatibleClaim.status, 400);
  assertHttpErrorResponseContract(await incompatibleClaim.json(), "incompatibleClaim", {
    errorCode: "danger_confirmation_required"
  });

  const confirmedIncompatibleClaim = await postJson(`${baseUrl}/api/claims/create`, {
    clientName: imported.clientName,
    server: baseUrl,
    confirmCompatibilityWarning: true
  }, adminToken);
  assert.equal(confirmedIncompatibleClaim.compatibility.policy.profileIssue, "warn");
  assert.match(confirmedIncompatibleClaim.tKey, /^SFSC1-/);
});

test("HTTP contract: production server startup rejects missing or placeholder admin token", async () => {
  for (const item of [
    {
      label: "missing",
      env: { SFSC_ADMIN_TOKEN: "", ADMIN_TOKEN: "" },
      message: /SFSC_ADMIN_TOKEN or ADMIN_TOKEN is required/
    },
    {
      label: "placeholder",
      env: { SFSC_ADMIN_TOKEN: "change-this-admin-token", ADMIN_TOKEN: "" },
      message: /must be changed from the placeholder/
    },
    {
      // CORE-4: the well-known MinIO root password placeholder must not
      // survive into a production start even when compose is bypassed.
      label: "storage-placeholder",
      env: {
        SFSC_ADMIN_TOKEN: "strong-production-token",
        ADMIN_TOKEN: "",
        S3_SECRET_ACCESS_KEY: "change-this-minio-root-password"
      },
      message: /S3_SECRET_ACCESS_KEY \/ MINIO_ROOT_PASSWORD must be changed from the placeholder/
    }
  ]) {
    const tempRoot = await mkdtemp(join(tmpdir(), `sfsc-auth-required-${item.label}-`));
    const port = await getFreePort();
    const child = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
        SERVER_DATA_ROOT: join(tempRoot, "data"),
        SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
        SFSC_REQUIRE_ADMIN_TOKEN: "1",
        ...item.env
      }
    });
    const stderrChunks = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const [code] = await once(child, "exit");
    await rm(tempRoot, { recursive: true, force: true });
    assert.notEqual(code, 0, item.label);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    assert.match(stderr, /server_config_invalid/, item.label);
    assert.match(stderr, item.message, item.label);
  }
});

test("HTTP contract: server serializes concurrent admin state writes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-write-queue-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "queued-admin-token";
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_ADMIN_TOKEN: adminToken,
      SFSC_TEST_STATE_WRITE_DELAY_MS: "120"
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const started = Date.now();
  const [remoteNameSave, endpointSave] = await Promise.all([
    postJson(`${baseUrl}/api/admin/storage/save`, {
      remoteName: "queued-minio"
    }, adminToken),
    postJson(`${baseUrl}/api/admin/storage/save`, {
      endpoint: "http://queued-minio:9000",
      internalEndpoint: "http://queued-internal-minio:9000"
    }, adminToken)
  ]);
  const elapsedMs = Date.now() - started;

  assertAdminStorageSaveResponseContract(remoteNameSave, "queued.remoteNameSave");
  assertAdminStorageSaveResponseContract(endpointSave, "queued.endpointSave");
  assert.ok(elapsedMs >= 200, `expected serialized writes to take at least 200ms, got ${elapsedMs}ms`);

  const state = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assertAdminStateSummaryContract(state, "queued.finalState");
  assert.equal(state.storage.remoteName, "queued-minio");
  assert.equal(state.storage.endpoint, "http://queued-minio:9000");
  assert.equal(state.storage.internalEndpoint, "http://minio:9000");
});

test("HTTP contract: server compacts stale admin state during writes", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-admin-compact-"));
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminToken = "compact-admin-token";
  const oldState = createDefaultAdminState({
    PUBLIC_SERVER_URL: baseUrl,
    S3_SECRET_ACCESS_KEY: "compact-secret"
  });
  oldState.users.push({
    id: "user-old-deleted-unreferenced",
    clientName: "old-deleted-unreferenced",
    uuid: "11111111-1111-4111-8111-111111111111",
    enabled: false,
    deletedAt: "2026-05-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    heartbeatAuthNonces: [],
    storage: {
      accessKeyId: "old-deleted-unreferenced",
      secretAccessKey: "compact-secret",
      bucket: "home-sync",
      prefix: "devices/old-deleted-unreferenced"
    }
  });
  oldState.claims.unshift({
    id: "claim-expired-unused",
    code: "ABCD-EFGH",
    userId: "user-old-deleted-unreferenced",
    clientName: "old-deleted-unreferenced",
    bucketName: "home-sync",
    profileId: "profile-expired-unused",
    used: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-05-02T00:00:00.000Z",
    redeemedAt: null,
    server: baseUrl
  });
  oldState.claims.unshift({
    id: "claim-used-retained",
    code: "JKLM-NPQR",
    userId: "user-used-retained",
    clientName: "used-retained",
    bucketName: "home-sync",
    profileId: "profile-used-retained",
    used: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-05-02T00:00:00.000Z",
    redeemedAt: "2026-05-01T00:05:00.000Z",
    replayUntil: "2026-05-01T00:15:00.000Z",
    redeemedBy: {
      clientRedeemId: "old-redeem",
      clientInstallIdHash: "a".repeat(64),
      firstRedeemedAt: "2026-05-01T00:05:00.000Z"
    },
    server: baseUrl
  });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(stateFile, JSON.stringify(oldState, null, 2), "utf8");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_ADMIN_TOKEN: adminToken,
      SFSC_TEST_ADMIN_COMPACT_NOW_MS: String(Date.parse("2026-07-08T12:00:00.000Z"))
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  await postJson(`${baseUrl}/api/admin/storage/save`, {
    remoteName: "compact-minio"
  }, adminToken);
  const state = await getJson(`${baseUrl}/api/admin/state`, adminToken);
  assertAdminStateSummaryContract(state, "compact.finalState");
  assert.equal(state.claims.some((claim) => claim.id === "claim-expired-unused"), false);
  assert.equal(state.claims.some((claim) => claim.id === "claim-used-retained"), true);
  assert.equal(state.users.some((user) => user.id === "user-old-deleted-unreferenced"), false);

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.claims.some((claim) => claim.id === "claim-expired-unused"), false);
  const retained = persisted.claims.find((claim) => claim.id === "claim-used-retained");
  assert.equal(retained.replayUntil, undefined);
  assert.deepEqual(Object.keys(retained.redeemedBy), ["firstRedeemedAt"]);
});

test("HTTP contract: delete-empty reports bucket_not_empty before deleting non-empty MinIO buckets", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-delete-non-empty-bucket-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;
  const minioRequests = [];
  const minioServer = createHttpServer((req, res) => {
    minioRequests.push({ method: req.method, url: req.url });
    if (req.method === "PUT" && req.url === "/busy-sync") {
      res.writeHead(200);
      res.end("");
      return;
    }
    if (req.method === "PUT" && req.url === "/empty-sync") {
      res.writeHead(200);
      res.end("");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/busy-sync?")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "<Contents><Key>devices/contract.txt</Key><Size>1</Size></Contents>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/empty-sync?")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "DELETE" && req.url === "/busy-sync") {
      res.writeHead(204);
      res.end("");
      return;
    }
    if (req.method === "DELETE" && req.url === "/empty-sync") {
      res.writeHead(204);
      res.end("");
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  minioServer.listen(minioPort, "127.0.0.1");
  await once(minioServer, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    if (minioServer.listening) {
      minioServer.close();
      await Promise.race([
        once(minioServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  assertAdminStorageSummaryContract(storageSave.storage, "nonEmptyBucket.storageSave.storage");
  assertAdminWriteStateResponseContract(storageSave, "nonEmptyBucket.storageSave", { rawSecrets: ["change-this-minio-root-password"] });
  assert.deepEqual(storageSave.storage, storageSave.state.storage);
  const createdBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "busy-sync"
  });
  assert.equal(createdBucket.provision.ok, true);
  assertAdminStorageBucketCreateResponseContract(createdBucket, "nonEmptyBucket.createdBucket");

  const emptyBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "empty-sync"
  });
  assert.equal(emptyBucket.provision.ok, true);
  assertAdminStorageBucketCreateResponseContract(emptyBucket, "nonEmptyBucket.emptyBucket");

  const clearedBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/clear`, {
    bucket: "empty-sync",
    confirmBucket: "empty-sync"
  });
  assert.equal(clearedBucket.ok, true);
  assert.equal(clearedBucket.result.deleted, 0);
  assert.equal(clearedBucket.result.rounds, 1);
  assertAdminStorageBucketClearResponseContract(clearedBucket, "nonEmptyBucket.clearedBucket");
  const clearedBucketSummary = clearedBucket.state.storage.buckets.find((bucket) => bucket.name === "empty-sync");
  assert.equal(clearedBucketSummary.clearedAt, clearedBucket.bucket.clearedAt);

  const deletedEmptyBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    bucket: "empty-sync",
    confirmBucket: "empty-sync"
  });
  assert.equal(deletedEmptyBucket.ok, true);
  assert.equal(deletedEmptyBucket.result.deletedBucket, "empty-sync");
  assertAdminStorageSummaryContract(deletedEmptyBucket.storage, "nonEmptyBucket.deletedEmptyBucket.storage");
  assertAdminStorageBucketDeleteEmptyResponseContract(deletedEmptyBucket, "nonEmptyBucket.deletedEmptyBucket");
  assert.deepEqual(deletedEmptyBucket.storage, deletedEmptyBucket.state.storage);
  assert.equal(deletedEmptyBucket.state.storage.buckets.some((bucket) => bucket.name === "empty-sync"), false);

  const failedDelete = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bucket: "busy-sync", confirmBucket: "busy-sync" })
  });
  assert.equal(failedDelete.status, 409);
  assertHttpErrorResponseContract(await failedDelete.json(), "failedDelete", {
    errorCode: "bucket_not_empty"
  });
  assert.equal(minioRequests.some((request) => request.method === "DELETE" && request.url === "/busy-sync"), false);
  const stateAfterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(stateAfterFailure, "nonEmptyBucket.stateAfterFailure");
  assert.equal(stateAfterFailure.storage.buckets.some((bucket) => bucket.name === "busy-sync"), true);
});

test("HTTP contract: S3 list pagination uses sorted RFC3986 canonical query", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-s3-canonical-query-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;
  const continuationToken = "tok+/=!*'()";
  const expectedSecondPageUrl = "/paged-sync?continuation-token=tok%2B%2F%3D%21%2A%27%28%29&list-type=2&max-keys=1000";
  const minioRequests = [];
  let objectDeleted = false;
  const minioServer = createHttpServer((req, res) => {
    minioRequests.push({ method: req.method, url: req.url });
    if (req.method === "PUT" && req.url === "/paged-sync") {
      res.writeHead(200);
      res.end("");
      return;
    }
    if (req.method === "GET" && req.url === "/paged-sync?list-type=2&max-keys=1000") {
      res.writeHead(200, { "content-type": "application/xml" });
      if (objectDeleted) {
        res.end([
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<ListBucketResult>",
          "<IsTruncated>false</IsTruncated>",
          "</ListBucketResult>"
        ].join(""));
        return;
      }
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>true</IsTruncated>",
        "<NextContinuationToken>tok+/=!*'()</NextContinuationToken>",
        "<Contents><Key>devices/paged.txt</Key><Size>1</Size></Contents>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "GET" && req.url === expectedSecondPageUrl) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "DELETE" && req.url === "/paged-sync/devices/paged.txt") {
      objectDeleted = true;
      res.writeHead(204);
      res.end("");
      return;
    }
    res.writeHead(400);
    res.end("unexpected MinIO request");
  });
  minioServer.listen(minioPort, "127.0.0.1");
  await once(minioServer, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    if (minioServer.listening) {
      minioServer.close();
      await Promise.race([
        once(minioServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  const createdBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "paged-sync"
  });
  assert.equal(createdBucket.provision.ok, true);

  const clearedBucket = await postJson(`${baseUrl}/api/admin/storage/buckets/clear`, {
    bucket: "paged-sync",
    confirmBucket: "paged-sync"
  });
  assert.equal(clearedBucket.ok, true);
  assert.equal(clearedBucket.result.deleted, 1);
  assert.equal(clearedBucket.result.rounds, 2);
  assert.equal(minioRequests.some((request) => request.method === "GET" && request.url === expectedSecondPageUrl), true);
});

test("HTTP contract: failed delete-empty persistence keeps externally deleted bucket registered", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-delete-empty-rollback-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const minioRequests = [];
  const minioServer = createHttpServer((req, res) => {
    minioRequests.push({ method: req.method, url: req.url });
    if (req.method === "PUT" && req.url === "/delete-rollback") {
      res.writeHead(200);
      res.end("");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/delete-rollback?")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "DELETE" && req.url === "/delete-rollback") {
      res.writeHead(204);
      res.end("");
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  minioServer.listen(minioPort, "127.0.0.1");
  await once(minioServer, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    if (minioServer.listening) {
      minioServer.close();
      await Promise.race([
        once(minioServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  assertAdminStorageSummaryContract(storageSave.storage, "deleteEmptyRollback.storageSave.storage");
  const created = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "delete-rollback"
  });
  assert.equal(created.provision.ok, true);
  assertAdminStorageBucketCreateResponseContract(created, "deleteEmptyRollback.created");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "deleteEmptyRollback.before");
  assert.equal(before.storage.buckets.some((bucket) => bucket.name === "delete-rollback"), true);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedDelete = await fetch(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket: "delete-rollback",
      confirmBucket: "delete-rollback"
    })
  });
  assert.equal(failedDelete.status, 500);
  assertHttpErrorResponseContract(await failedDelete.json(), "failedDeleteEmptyRollback", {
    errorCode: "server_state_write_failed"
  });
  assert.equal(minioRequests.some((request) => request.method === "GET" && request.url?.startsWith("/delete-rollback?")), true);
  assert.equal(minioRequests.some((request) => request.method === "DELETE" && request.url === "/delete-rollback"), true);

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "deleteEmptyRollback.afterFailure");
  assert.equal(afterFailure.updatedAt, before.updatedAt);
  assert.deepEqual(afterFailure.storage, before.storage);
  assert.equal(afterFailure.storage.buckets.some((bucket) => bucket.name === "delete-rollback"), true);
  assert.equal(afterFailure.storage.bucket, before.storage.bucket);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const deleted = await postJson(`${baseUrl}/api/admin/storage/buckets/delete-empty`, {
    bucket: "delete-rollback",
    confirmBucket: "delete-rollback"
  });
  assertAdminStorageBucketDeleteEmptyResponseContract(deleted, "deleteEmptyRollback.deleted");
  assert.equal(deleted.result.deletedBucket, "delete-rollback");
  assert.equal(deleted.state.storage.buckets.some((bucket) => bucket.name === "delete-rollback"), false);
});

test("HTTP contract: failed bucket clear persistence keeps cleared marker uncommitted", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-clear-bucket-rollback-"));
  const port = await getFreePort();
  const minioPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const minioUrl = `http://127.0.0.1:${minioPort}`;
  const dataRoot = join(tempRoot, "data");
  const stateFile = join(dataRoot, "sfsc-state.json");
  const minioRequests = [];
  let listCount = 0;
  const minioServer = createHttpServer((req, res) => {
    minioRequests.push({ method: req.method, url: req.url });
    if (req.method === "PUT" && req.url === "/clear-rollback") {
      res.writeHead(200);
      res.end("");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/clear-rollback?")) {
      listCount += 1;
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(listCount === 1 ? [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "<Contents><Key>devices/contract.txt</Key><Size>1</Size></Contents>",
        "</ListBucketResult>"
      ].join("") : [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (req.method === "DELETE" && req.url === "/clear-rollback/devices/contract.txt") {
      res.writeHead(204);
      res.end("");
      return;
    }
    res.writeHead(404);
    res.end("");
  });
  minioServer.listen(minioPort, "127.0.0.1");
  await once(minioServer, "listening");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_SERVER_URL: baseUrl,
      S3_ENDPOINT: minioUrl,
      SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json")
    }
  });

  t.after(async () => {
    if (!child.killed) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    if (minioServer.listening) {
      minioServer.close();
      await Promise.race([
        once(minioServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const storageSave = await postJson(`${baseUrl}/api/admin/storage/save`, {
    endpoint: minioUrl,
    internalEndpoint: minioUrl,
    accessKeyId: "syncadmin",
    secretAccessKey: "change-this-minio-root-password"
  });
  assertAdminStorageSummaryContract(storageSave.storage, "clearBucketRollback.storageSave.storage");
  const created = await postJson(`${baseUrl}/api/admin/storage/buckets/create`, {
    bucket: "clear-rollback"
  });
  assert.equal(created.provision.ok, true);
  assertAdminStorageBucketCreateResponseContract(created, "clearBucketRollback.created");

  const before = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(before, "clearBucketRollback.before");
  const beforeBucket = before.storage.buckets.find((bucket) => bucket.name === "clear-rollback");
  assert.ok(beforeBucket);
  assert.equal(beforeBucket.clearedAt, null);
  assert.equal(beforeBucket.objectCount, null);
  assert.equal(beforeBucket.sizeBytes, null);
  const persistedState = await readFile(stateFile, "utf8");
  await rm(stateFile, { force: true });
  await mkdir(stateFile, { recursive: true });

  const failedClear = await fetch(`${baseUrl}/api/admin/storage/buckets/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket: "clear-rollback",
      confirmBucket: "clear-rollback"
    })
  });
  assert.equal(failedClear.status, 500);
  assertHttpErrorResponseContract(await failedClear.json(), "failedClearBucketRollback", {
    errorCode: "server_state_write_failed"
  });
  assert.equal(minioRequests.some((request) => request.method === "DELETE" && request.url === "/clear-rollback/devices/contract.txt"), true);

  const afterFailure = await getJson(`${baseUrl}/api/admin/state`);
  assertAdminStateSummaryContract(afterFailure, "clearBucketRollback.afterFailure");
  assert.equal(afterFailure.updatedAt, before.updatedAt);
  assert.deepEqual(afterFailure.storage, before.storage);
  const afterBucket = afterFailure.storage.buckets.find((bucket) => bucket.name === "clear-rollback");
  assert.equal(afterBucket.clearedAt, null);
  assert.equal(afterBucket.objectCount, null);
  assert.equal(afterBucket.sizeBytes, null);

  await rm(stateFile, { recursive: true, force: true });
  await writeFile(stateFile, persistedState, "utf8");
  const cleared = await postJson(`${baseUrl}/api/admin/storage/buckets/clear`, {
    bucket: "clear-rollback",
    confirmBucket: "clear-rollback"
  });
  assertAdminStorageBucketClearResponseContract(cleared, "clearBucketRollback.cleared");
  assert.equal(cleared.bucket.name, "clear-rollback");
  assert.equal(cleared.bucket.clearedAt.length > 0, true);
});

function readSingboxUserNames(configText) {
  const config = JSON.parse(configText);
  return (config.inbounds?.[0]?.users || []).map((user) => user.name);
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(baseUrl, child) {
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

async function runServerSmoke(baseUrl, adminToken, options = {}) {
  const args = [
    serverSmokeEntry,
    "--base-url",
    baseUrl,
    "--admin-token",
    adminToken
  ];
  if (options.jsonReportPath) {
    args.push("--json-report", options.jsonReportPath);
  }
  if (options.exerciseClaimLifecycle) {
    args.push("--exercise-claim-lifecycle");
  }
  if (options.cleanupClaimLifecycle) {
    args.push("--cleanup-claim-lifecycle");
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

async function postJson(url, body, adminToken = "") {
  const headers = { "content-type": "application/json" };
  if (adminToken) {
    headers.authorization = `Bearer ${adminToken}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function respondToSingboxRestart(controlDir) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const names = await readdir(controlDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const requestName = names.find((name) => /^restart-request-[a-f0-9]{24}-[a-f0-9]{64}\.json$/.test(name));
    if (requestName) {
      const request = JSON.parse(await readFile(join(controlDir, requestName), "utf8"));
      await writeFile(join(controlDir, `restart-result-${request.requestId}.json`), JSON.stringify({
        requestId: request.requestId,
        configSha256: request.expectedConfigSha256,
        ok: true,
        message: "sing-box restarted by contract test",
        restartedAt: new Date().toISOString()
      }), "utf8");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("sing-box restart request was not observed");
}

async function getJson(url, adminToken = "") {
  const headers = adminToken ? { authorization: `Bearer ${adminToken}` } : undefined;
  const response = await fetch(url, { headers });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function assertValidationFailedResponse(responsePromise) {
  const response = await responsePromise;
  assert.equal(response.status, 400);
  assertHttpErrorResponseContract(await response.json(), "validationFailedResponse", {
    errorCode: "validation_failed"
  });
}

function signHeartbeatPayload(payload, profile, options = {}) {
  const { secret: overrideSecret, ...authOptions } = options;
  const secret = overrideSecret ?? profile?.heartbeat?.secret;
  assert.equal(typeof secret, "string");
  return {
    ...payload,
    auth: createHeartbeatAuth(payload, secret, authOptions)
  };
}

function assertAdminUserContract(user) {
  assertAdminUserSummaryContract(user);
}

function assertVlessUriMatchesTunnel(uri, tunnel) {
  const parsed = parseVlessUri(uri);
  assert.equal(parsed.server, tunnel.publicHost);
  assert.equal(parsed.port, tunnel.publicPort);
  assert.equal(parsed.transport, tunnel.transport);
  assert.equal(parsed.security, tunnel.security);
  if (tunnel.security === "reality") {
    assert.equal(parsed.sni, tunnel.reality.serverName);
    assert.equal(parsed.fingerprint, tunnel.reality.fingerprint);
    assert.equal(parsed.publicKey, tunnel.reality.publicKey);
    assert.equal(parsed.shortId, tunnel.reality.shortId);
  }
}
