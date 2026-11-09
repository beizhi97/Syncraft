import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";

import { consumeOneTimeEnrollmentCode, createEnrollmentAuthorityState, issueOneTimeEnrollmentCode, revokeEnrollmentDevice, revokeEnrollmentRelation } from "../src/core/enrollmentAuthority.js";
import { canonicalJson, createEnrollmentIdentityId, createEnrollmentKeyPair, publicKeyFingerprint, signAuthorizationRequest, verifyChannelConfigCode } from "../src/core/enrollmentProtocol.js";
import { createEnrollmentService } from "../src/service/enrollmentService.js";
import { createEnrollmentBootstrapGateway } from "../src/service/enrollmentBootstrapGateway.js";
import { createSharedDirectoryService } from "../src/service/sharedDirectoryService.js";
import { verifyDataAuthorizationEnvelope } from "../src/core/dataAuthorization.js";
import { createDefaultAdminState } from "../src/core/serverAdmin.js";
import { decodeChannelConfigCode } from "../src/core/enrollmentProtocol.js";
import { decodeChannelImportCode } from "../src/core/channelImportCode.js";
import { openRelationServiceBindingCatalog } from "../src/service/relationServiceBindingCatalog.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(rootDir, "src", "server.js");
const adminToken = "test-admin-token-for-enrollment";
const syntheticStorageSecret = randomBytes(12).toString("hex");
const serverId = "srv_0000000000000001";
const sourceDeviceId = "dev_0000000000000001";
const channelRevision = "chrev_0000000000000001";
const fixedNow = Date.parse("2026-10-29T12:00:00.000Z");

const firstUseServerHarnessSource = `
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { main } = await import(pathToFileURL(process.argv[2]).href);
const manager = Object.freeze({ async start() {}, async query() {}, async disable() {}, async reconcile() {} });
const runtime = Object.freeze({ async inspect() { return { owned: false }; }, async stop() {}, async abort() {} });
const protection = Object.freeze({ async verify() {} });
let relationRunning = await readFile(join(process.env.SERVER_DATA_ROOT, "test-relation-running"), "utf8").then(value => value === "true", () => false);
const facade = Object.freeze({
  async query({ relationId } = {}) {
    return relationRunning
      ? { relationId, source: "manager-state", desired: "enabled", state: "running", handlePresent: true }
      : { relationId, source: "manager-state", desired: null, state: "absent", handlePresent: false, runningEvidencePresent: false, cleanupRequired: false, commitUncertain: false };
  },
  async start() {
    relationRunning = true;
    await writeFile(join(process.env.SERVER_DATA_ROOT, "test-relation-running"), "true", "utf8");
    return { state: "running" };
  },
  async disable({ relationId } = {}) {
    if (process.env.SFSC_TEST_REVOCATION_IN_FLIGHT === "1"
      && !await readFile(join(process.env.SERVER_DATA_ROOT, "allow-revocation-attempt"), "utf8").then(() => true, () => false)) {
      await writeFile(join(process.env.SERVER_DATA_ROOT, "revocation-stop-entered"), "entered", "utf8");
      while (!await readFile(join(process.env.SERVER_DATA_ROOT, "allow-revocation-attempt"), "utf8").then(() => true, () => false)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { relationId, desired: "disabled", state: "cleanup_required", reason: "test_stop_pending" };
    }
    if (process.env.SFSC_TEST_REVOCATION_PENDING === "1"
      && !await readFile(join(process.env.SERVER_DATA_ROOT, "allow-revocation-stop"), "utf8").then(() => true, () => false)) {
      return { relationId, desired: "disabled", state: "cleanup_required", reason: "test_stop_pending" };
    }
    relationRunning = false;
    await writeFile(join(process.env.SERVER_DATA_ROOT, "test-relation-running"), "false", "utf8");
    return { relationId, desired: "disabled", state: "stopped" };
  },
  async reconcile() { return { state: relationRunning ? "running" : "absent" }; }
});
const startupAdmission = async () => ({ manager });
const relationCompositionFactory = async () => ({
  runtime, protection,
  createFacade() { return facade; }
});
const result = await main({
  env: process.env,
  startupAdmission,
  readEpochIdentity: async () => ({ containerId: process.env.SFSC_CONTAINER_ID }),
  ownerGateFactory: () => ({}),
  relationCompositionFactory
});

const dataRoot = process.env.SERVER_DATA_ROOT;
const controlDir = process.env.SINGBOX_CONTROL_DIR;
const receiptPath = join(dataRoot, "test-supervisor-receipts.json");
const handled = new Set((await readdir(controlDir).catch(() => []))
  .map(name => name.match(/^restart-request-([a-f0-9]{24})-[a-f0-9]{64}\.json$/)?.[1])
  .filter(Boolean));
const receipts = await readFile(receiptPath, "utf8").then(value => JSON.parse(value), () => []);
const watcher = setInterval(async () => {
  for (const name of await readdir(controlDir).catch(() => [])) {
    const match = name.match(/^restart-request-([a-f0-9]{24})-([a-f0-9]{64})\\.json$/);
    if (!match || handled.has(match[1])) continue;
    handled.add(match[1]);
    const requestPath = join(controlDir, name);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const configBytes = await readFile(process.env.SINGBOX_CONFIG_PATH);
    const actualSha256 = createHash("sha256").update(configBytes).digest("hex");
    const ok = request.expectedConfigSha256 === match[2] && actualSha256 === match[2];
    receipts.push({ requestId: request.requestId, expectedConfigSha256: match[2], actualConfigSha256: actualSha256, ok });
    await writeFile(receiptPath, JSON.stringify(receipts), "utf8");
    await writeFile(join(controlDir, "restart-result-" + request.requestId + ".json"), JSON.stringify({
      requestId: request.requestId, ok, errorCode: ok ? "" : "singbox_config_mismatch",
      message: ok ? "test supervisor accepted exact config digest" : "config digest mismatch",
      restartedAt: new Date().toISOString(), configSha256: actualSha256
    }), "utf8");
  }
}, 20);
watcher.unref();
process.stdout.write(JSON.stringify({ event: "ready", port: result.server.address().port, gatewayPort: result.bootstrapGatewayAddress.port }) + "\\n");

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", async chunk => {
  input += chunk;
  if (input.includes("close\\n")) {
    clearInterval(watcher);
    await result.close();
    process.exit(0);
  }
});
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sshString(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function authorizedKeysLine(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  const wire = Buffer.concat([
    sshString(Buffer.from("ssh-ed25519", "ascii")),
    sshString(Buffer.from(jwk.x, "base64url"))
  ]);
  return Buffer.from(`ssh-ed25519 ${wire.toString("base64")}\n`, "utf8");
}

async function writePrivate(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function createReadyCatalog(dataRoot) {
  const catalogDir = join(dataRoot, "relation-service");
  const rootPath = join(dataRoot, "shares", "projects");
  await mkdir(catalogDir, { recursive: true, mode: 0o700 });
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const sourcePair = createEnrollmentKeyPair();
  const hostPair = createEnrollmentKeyPair();
  const shareId = "shr_0000000000000001";
  const rootId = "root_0000000000000001";
  const relationId = "rel_0000000000000001";
  const sourceBinding = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-binding",
    identity: { serverId, deviceId: sourceDeviceId, shareId, rootId, relationId },
    baselineEpoch: 1, channelRevision, credentialRevision: "cred_0000000000000001",
    rootAttestation: { source: "server-enrollment-record", referenceId: "att_0000000000000001", attestedAt: new Date(fixedNow - 30_000).toISOString() }
  };
  let authority = createEnrollmentAuthorityState({ serverId, nowMs: fixedNow });
  const issued = issueOneTimeEnrollmentCode(authority, {
    requestId: "req_0000000000000001", deviceId: sourceDeviceId, channelRevision,
    publicKey: sourcePair.publicKey, bindings: [sourceBinding],
    issuedAt: new Date(fixedNow).toISOString(), expiresAt: new Date(fixedNow + 60_000).toISOString()
  }, { expectedRevision: authority.revision, nowMs: fixedNow });
  authority = consumeOneTimeEnrollmentCode(issued.nextState, issued.code, {
    requestId: "req_0000000000000001", deviceId: sourceDeviceId, channelRevision,
    publicKey: sourcePair.publicKey, bindings: [sourceBinding]
  }, { expectedRevision: issued.nextState.revision, nowMs: fixedNow }).nextState;

  const markerContent = {
    schemaVersion: 1, kind: "syncraft-directory-root", serverId, shareId, rootId,
    markerId: "mkr_0000000000000001", operationId: "rootop_0000000000000001",
    createdAt: new Date(fixedNow - 120_000).toISOString()
  };
  const markerBytes = Buffer.from(canonicalJson(markerContent), "utf8");
  const root = {
    schemaVersion: 1, kind: "syncraft-directory-root-record", status: "pending",
    operationId: markerContent.operationId, serverId, shareId, rootId, markerId: markerContent.markerId,
    canonicalRoot: rootPath, createdAt: markerContent.createdAt,
    rootIdentity: { dev: "10", ino: "11" },
    mountEvidence: { platform: "win32", kind: "filesystem-identity-only-v1" },
    marker: { name: ".syncraft-root.json", content: markerContent, contentLength: String(markerBytes.length), contentSha256: sha256(markerBytes) },
    stage: { name: `.syncraft-root.stage-${markerContent.operationId}` }
  };
  const hostKeyPath = join(catalogDir, "host-key.pem");
  const authorizedKeysPath = join(catalogDir, "authorized-keys");
  await writePrivate(hostKeyPath, hostPair.privateKey.export({ format: "pem", type: "pkcs8" }));
  const authorizedBytes = authorizedKeysLine(sourcePair.publicKey);
  await writePrivate(authorizedKeysPath, authorizedBytes);
  const hostPublicSha256 = sha256(createPublicKey(hostPair.privateKey).export({ format: "der", type: "spki" }));
  const initialState = {
    schemaVersion: "1", kind: "syncraft-relation-service-bindings", revision: 0, authority,
    roots: { [rootId]: root },
    serverHostKey: { path: hostKeyPath, publicKeySha256: hostPublicSha256 },
    relations: {
      [relationId]: {
        rootId,
        authorization: { authorizedKeysPath, sha256: sha256(authorizedBytes), devicePublicKeyFingerprint: publicKeyFingerprint(sourcePair.publicKey) },
        listener: { host: "127.0.0.1", port: 24001 }
      }
    }
  };
  const catalog = await openRelationServiceBindingCatalog({ path: join(catalogDir, "catalog.json"), mode: "create", initialState });
  await catalog.update({ expectedRevision: 0 }, state => {
    state.roots[rootId] = {
      ...state.roots[rootId], status: "active",
      activatedAt: new Date(fixedNow - 60_000).toISOString(),
      stage: { name: state.roots[rootId].stage.name, state: "installed" },
      markerIdentity: { dev: "10", ino: "12", size: String(markerBytes.length) },
      markerSync: { fileSynced: true, directorySync: "success" }
    };
    return state;
  });
  return { rootId, rootPath, relationId, sourcePair, hostPair, sourceBinding };
}

async function freePort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitReady(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited before readiness");
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function waitForBootstrapRegistry(registryPath, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before bootstrap registry was initialized: ${child.exitCode}`);
    }
    try {
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      if (typeof registry.channelRevision === "string" && registry.channelRevision) return registry;
      throw new Error("bootstrap registry is present but has no active channel revision");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("server health succeeded but bootstrap registry was not initialized within 10 seconds");
}

function startServer(dataRoot, port, bootstrapPort) {
  return spawn(process.execPath, [serverEntry], {
    cwd: rootDir, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), SERVER_DATA_ROOT: dataRoot,
      SINGBOX_CONFIG_PATH: join(dataRoot, "sing-box", "config.json"),
      SFSC_REQUIRE_ADMIN_TOKEN: "1", SFSC_ADMIN_TOKEN: adminToken,
      SFSC_ENROLLMENT_BOOTSTRAP_PORT: String(bootstrapPort),
      MINIO_ROOT_PASSWORD: "test-password-not-used-in-enrollment",
      PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`,
      SFSC_ENROLLMENT_CHANNEL_REVISION: channelRevision,
      SFSC_ENROLLMENT_BOOTSTRAP_ORIGINS: `http://127.0.0.1:${port}`
    }
  });
}

async function waitHarnessReady(lines, child) {
  const iterator = lines[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error(`server harness exited before ready (code ${child.exitCode})`);
    try {
      const event = JSON.parse(next.value);
      if (event.event === "ready") return { event, iterator };
    } catch {}
  }
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
}

function requestProofHeader({ bodyBytes, input, privateKey }) {
  const bodySha256 = sha256(bodyBytes);
  const payload = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request-proof",
    method: "POST", path: "/api/enrollment/v1/requests", bodySha256,
    deviceId: input.deviceId, requestId: input.requestId, channelRevision: input.channelRevision
  };
  const proof = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request-proof", bodySha256,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url")
  };
  return Buffer.from(canonicalJson(proof)).toString("base64url");
}

test("bootstrap registry readiness wait tolerates a delayed initializer", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-bootstrap-readiness-wait-"));
  const registryPath = join(tempRoot, "sfsc-enrollment-bootstrap-registry.json");
  const child = { exitCode: null };
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const delayedRegistry = (async () => {
    await new Promise(resolve => setTimeout(resolve, 75));
    await writeFile(registryPath, JSON.stringify({ channelRevision }), "utf8");
  })();

  const registry = await waitForBootstrapRegistry(registryPath, child);
  await delayedRegistry;
  assert.equal(registry.channelRevision, channelRevision);
});

test("server lazily initializes first-use authorization after empty-catalog startup and skips same-digest restart", { timeout: 30_000 }, async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-first-use-"));
  const dataRoot = join(tempRoot, "data");
  const sharedRoot = join(tempRoot, "shared");
  const selectedRoot = join(sharedRoot, "selected-root");
  const selectedRoot2 = join(sharedRoot, "second-root");
  const externalRoot = join(tempRoot, "external-root");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  await mkdir(selectedRoot2, { recursive: true, mode: 0o700 });
  await mkdir(externalRoot, { mode: 0o700 });
  const adminState = createDefaultAdminState({
    VLESS_PORT: "45678", VLESS_LISTEN_PORT: "45678", VLESS_PUBLIC_PORT: "45678",
    VLESS_PUBLIC_HOST: "sync.example.test", PUBLIC_SERVER_URL: "https://sync.example.test"
  });
  adminState.tunnel.listenHost = "127.0.0.1";
  adminState.tunnel.lastAppliedAt = new Date().toISOString();
  adminState.tunnel.restartRequired = false;
  adminState.storage.secretAccessKey = syntheticStorageSecret;
  await writeFile(join(dataRoot, "sfsc-state.json"), JSON.stringify(adminState, null, 2), "utf8");
  const catalogPath = join(dataRoot, "relation-service", "catalog.json");
  assert.equal(await readFile(catalogPath, "utf8").then(() => true, () => false), false);

  const harnessPath = join(tempRoot, "first-use-server-harness.mjs");
  await writeFile(harnessPath, firstUseServerHarnessSource, "utf8");
  const harnessEnv = {
    ...process.env,
    HOST: "127.0.0.1", PORT: "0", SERVER_DATA_ROOT: dataRoot,
    SINGBOX_CONFIG_PATH: join(dataRoot, "sing-box", "config.json"),
    SINGBOX_CONTROL_DIR: join(dataRoot, "control"),
    SINGBOX_LISTEN_PORT: "45678", VLESS_PORT: "45678", VLESS_LISTEN_PORT: "45678",
    VLESS_PUBLIC_HOST: "sync.example.test", VLESS_PUBLIC_PORT: "45678",
    S3_ENDPOINT: "http://127.0.0.1:9000", S3_CLIENT_ENDPOINT: "http://127.0.0.1:9000",
    S3_SECRET_ACCESS_KEY: syntheticStorageSecret,
    MINIO_ROOT_PASSWORD: syntheticStorageSecret,
    SFSC_REQUIRE_ADMIN_TOKEN: "1", SFSC_ADMIN_TOKEN: adminToken,
    SFSC_ENROLLMENT_BOOTSTRAP_PORT: "0",
    SFSC_STORAGE_MODE: "directory",
    SFSC_DIRECTORY_ROOT: sharedRoot,
    SFSC_RUNTIME_ADMISSION_REQUIRED: "1",
    SFSC_TEST_REVOCATION_PENDING: "1",
    SFSC_TEST_REVOCATION_IN_FLIGHT: "1",
    SFSC_RUNTIME_EPOCH_ROOT: join(dataRoot, "epoch"),
    SFSC_RELATION_STATE_PATH: join(dataRoot, "relation-services.json"),
    SFSC_CONTAINER_ID: "a".repeat(64),
    SFSC_BOOTSTRAP_NONCE: "A".repeat(43)
  };
  let child;
  let lines;
  let childStderr = "";
  let childStopped = false;
  const harnessChildren = [];
  const launchHarness = () => {
    childStderr = "";
    child = spawn(process.execPath, [harnessPath, serverEntry], {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: harnessEnv
    });
    harnessChildren.push(child);
    lines = createInterface({ input: child.stdout });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { childStderr += chunk; });
    childStopped = false;
  };
  launchHarness();
  t.after(async () => {
    if (!childStopped && child.exitCode === null) {
      child.stdin.write("close\n");
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    lines.close();
    for (const item of harnessChildren) {
      if (item.exitCode !== 0 && item.exitCode !== null) assert.fail(`first-use server harness failed: ${childStderr}`);
    }
    await rm(tempRoot, { recursive: true, force: true });
  });
  const ready = await waitHarnessReady(lines, child);
  let baseUrl = `http://127.0.0.1:${ready.event.port}`;
  let gatewayUrl = `http://127.0.0.1:${ready.event.gatewayPort}`;
  const adminRequest = (path, method = "GET", body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {})
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
  });

  const outsideRegistration = await adminRequest("/api/admin/enrollment/v1/directories", "POST", { path: externalRoot });
  assert.equal(outsideRegistration.status, 400, await outsideRegistration.clone().text());
  assert.equal(await readFile(catalogPath, "utf8").then(() => true, () => false), false, "outside registration must not create a catalog");
  assert.equal(await readFile(join(externalRoot, ".syncraft-root.json"), "utf8").then(() => true, () => false), false, "outside registration must not write a marker");

  const opened = await adminRequest("/api/admin/enrollment/v1/directories", "POST", { path: selectedRoot });
  assert.equal(opened.status, 201, await opened.clone().text());
  const { directory } = await opened.json();
  const opened2 = await adminRequest("/api/admin/enrollment/v1/directories", "POST", { path: selectedRoot2 });
  assert.equal(opened2.status, 201, await opened2.clone().text());
  const { directory: directory2 } = await opened2.json();
  assert.notEqual(directory.rootId, directory2.rootId);
  const trustResponse = await adminRequest("/api/admin/enrollment/v1/trust");
  assert.equal(trustResponse.status, 200);
  const { pin } = await trustResponse.json();
  const generatedConfig = await adminRequest("/api/admin/tunnel/generate", "POST", { confirmGenerateTunnel: true });
  assert.equal(generatedConfig.status, 200, await generatedConfig.clone().text());
  // Do not read /api/admin/setup here. Reconfigure must lazily initialize the
  // data authorizer itself after this newly registered directory.
  const initialReconfigure = await adminRequest("/api/admin/enrollment/v1/reconfigure", "POST", {
    operationId: "op_1123456789abcdef0123456789abcdef"
  });
  assert.equal(initialReconfigure.status, 200, await initialReconfigure.clone().text());
  const initialOperation = await initialReconfigure.json();
  assert.equal(initialOperation.stage, "complete");
  const channel = decodeChannelImportCode(initialOperation.wrappedCode);
  const channelPayload = decodeChannelConfigCode(channel.channelCode);
  const channelRestartReceipts = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.equal(channelRestartReceipts.length, 1, "direct reconfigure should apply both overlays with one confirmed restart");
  const initialBootstrapRegistry = JSON.parse(await readFile(join(dataRoot, "sfsc-enrollment-bootstrap-registry.json"), "utf8"));
  const initialDataRegistry = JSON.parse(await readFile(join(dataRoot, "sfsc-enrollment-data-registry.json"), "utf8"));
  assert.equal(initialBootstrapRegistry.applied.configSha256, channelRestartReceipts[0].actualConfigSha256);
  assert.equal(initialDataRegistry.built.configSha256, channelRestartReceipts[0].actualConfigSha256);

  const pair = createEnrollmentKeyPair();
  const request = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request",
    requestId: createEnrollmentIdentityId("requestId"), deviceId: createEnrollmentIdentityId("deviceId"),
    channelRevision: channelPayload.channelRevision,
    publicKey: pair.publicKey.export({ format: "jwk" })
  };
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  const bootstrapPost = (path, bytes, headers) => fetch(`${gatewayUrl}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: bytes
  });
  const created = await bootstrapPost("/api/enrollment/v1/requests", requestBytes, {
    "x-sfsc-enrollment-request": requestProofHeader({ bodyBytes: requestBytes, input: request, privateKey: pair.privateKey })
  });
  assert.equal(created.status, 202, await created.clone().text());
  const externalRegistered = await createSharedDirectoryService({ catalogPath }).register({ path: externalRoot });
  assert.equal(externalRegistered.status, "active", "fixture creates an otherwise valid legacy/out-of-bound catalog root");
  const outsideIssue = await adminRequest(`/api/admin/enrollment/v1/requests/${request.requestId}/issue`, "POST", { rootId: externalRegistered.rootId });
  assert.equal(outsideIssue.status, 400, await outsideIssue.clone().text());
  const partiallyOutsideIssue = await adminRequest(`/api/admin/enrollment/v1/requests/${request.requestId}/issue`, "POST", {
    rootIds: [directory.rootId, externalRegistered.rootId]
  });
  assert.equal(partiallyOutsideIssue.status, 400, await partiallyOutsideIssue.clone().text());
  assert.equal((await adminRequest("/api/admin/enrollment/v1/requests")).status, 200, "rejected issue must leave the request available");
  const issuePath = `/api/admin/enrollment/v1/requests/${request.requestId}/issue`;
  const selectedRootIds = [directory.rootId, directory2.rootId];
  const issuedResponse = await adminRequest(issuePath, "POST", { rootIds: selectedRootIds });
  assert.equal(issuedResponse.status, 201, await issuedResponse.clone().text());
  const issued = await issuedResponse.json();
  assert.equal(Object.hasOwn(issued, "binding"), false, "multi-root response must not imply a single authorized directory");
  assert.deepEqual(
    issued.bindings.map(binding => binding.identity.rootId).sort(),
    [...selectedRootIds].sort(),
    "response bindings cover the exact requested root set"
  );
  assert.equal(new Set(issued.bindings.map(binding => binding.identity.relationId)).size, 2);
  assert.equal(new Set(issued.bindings.map(binding => binding.identity.shareId)).size, 2);
  const reorderedIssue = await adminRequest(issuePath, "POST", { rootIds: [...selectedRootIds].reverse() });
  assert.equal(reorderedIssue.status, 201, await reorderedIssue.clone().text());
  assert.deepEqual(await reorderedIssue.json(), issued, "idempotent replay treats root selection as a set and preserves original binding order");
  const changedIssue = await adminRequest(issuePath, "POST", { rootIds: [directory2.rootId] });
  assert.equal(changedIssue.status, 409, await changedIssue.clone().text());
  assert.equal((await changedIssue.json()).errorCode, "enrollment_state_conflict");
  const primaryBinding = issued.bindings[0];
  const consumePath = "/api/enrollment/v1/consume";
  const consumeBody = Buffer.from(JSON.stringify({ code: issued.deviceEnrollmentCode }), "utf8");
  const consumeAuthorization = signAuthorizationRequest({ binding: primaryBinding, bodyBytes: consumeBody, method: "POST", path: consumePath }, pair.privateKey);
  const consumed = await bootstrapPost(consumePath, consumeBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(consumeAuthorization), "utf8").toString("base64url")
  });
  assert.equal(consumed.status, 200, await consumed.clone().text());
  const consumedPayload = await consumed.json();
  assert.deepEqual(consumedPayload.receipt.grant.bindings, issued.bindings, "one consumed receipt carries all selected independent roots");

  // The one-click operation advances bootstrap transport without rewriting the
  // binding already consumed by this device; repeated IDs return the same code.
  const reconfigureRequest = {
    operationId: "op_0123456789abcdef0123456789abcdef",
    publicHost: "renewed.sync.example.test"
  };
  const reconfiguredResponse = await adminRequest("/api/admin/enrollment/v1/reconfigure", "POST", reconfigureRequest);
  assert.equal(reconfiguredResponse.status, 200, await reconfiguredResponse.clone().text());
  const reconfigured = await reconfiguredResponse.json();
  assert.equal(reconfigured.stage, "complete");
  assert.equal(typeof reconfigured.wrappedCode, "string");
  const operationStatus = await adminRequest(`/api/admin/enrollment/v1/reconfigure/${reconfigureRequest.operationId}`);
  assert.deepEqual(await operationStatus.json(), reconfigured);
  const reconfigureReplay = await adminRequest("/api/admin/enrollment/v1/reconfigure", "POST", reconfigureRequest);
  assert.deepEqual(await reconfigureReplay.json(), reconfigured);
  const renewedChannel = decodeChannelImportCode(reconfigured.wrappedCode);
  const renewedChannelPayload = decodeChannelConfigCode(renewedChannel.channelCode);
  assert.notEqual(renewedChannelPayload.channelRevision, primaryBinding.channelRevision);
  const channelRestartReceiptsAfterReconfigure = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.equal(channelRestartReceiptsAfterReconfigure.length, 2, "replaying the reconfiguration ID must not restart sing-box again");

  const renewalPath = "/api/enrollment/v1/channel-renewal";
  const renewalBytes = Buffer.from(JSON.stringify({ channelRevision: renewedChannelPayload.channelRevision }), "utf8");
  const signRenewal = (bodyBytes, nonce) => signAuthorizationRequest({
    binding: primaryBinding, bodyBytes, method: "POST", path: renewalPath, nonce
  }, pair.privateKey);
  const renewalRequest = (bodyBytes, nonce) => bootstrapPost(renewalPath, bodyBytes, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(signRenewal(bodyBytes, nonce)), "utf8").toString("base64url")
  });
  const tamperedBody = Buffer.from(JSON.stringify({ channelRevision: primaryBinding.channelRevision }), "utf8");
  const tamperedRenewal = await bootstrapPost(renewalPath, tamperedBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(signRenewal(renewalBytes, "nonce_renewal_tamper_0001")), "utf8").toString("base64url")
  });
  assert.equal(tamperedRenewal.status, 403);
  assert.equal((await tamperedRenewal.json()).error, "enrollment_request_mismatch");

  const firstRenewalResponse = await renewalRequest(renewalBytes, "nonce_renewal_lost_0001");
  assert.equal(firstRenewalResponse.status, 200, await firstRenewalResponse.clone().text());
  const lostRenewalEnvelope = await firstRenewalResponse.json();
  const secondRenewalResponse = await renewalRequest(renewalBytes, "nonce_renewal_retry_0001");
  assert.equal(secondRenewalResponse.status, 200, await secondRenewalResponse.clone().text());
  const renewalEnvelope = await secondRenewalResponse.json();
  assert.deepEqual(Object.keys(renewalEnvelope).sort(), ["payload", "signature"]);
  assert.deepEqual(Object.keys(renewalEnvelope.payload).sort(), [
    "channelRevision", "deviceId", "keyId", "kind", "protocol", "serverId", "version", "wrappedCode"
  ]);
  assert.equal(renewalEnvelope.payload.kind, "channel-renewal");
  assert.equal(renewalEnvelope.payload.deviceId, request.deviceId);
  assert.equal(renewalEnvelope.payload.channelRevision, renewedChannelPayload.channelRevision);
  const pinPublicKey = createPublicKey({ key: pin.publicKey, format: "jwk" });
  for (const envelope of [lostRenewalEnvelope, renewalEnvelope]) {
    assert.equal(verify(null, Buffer.from(canonicalJson(envelope.payload), "utf8"), pinPublicKey,
      Buffer.from(envelope.signature, "base64url")), true);
  }
  const importedRenewal = decodeChannelImportCode(renewalEnvelope.payload.wrappedCode);
  assert.equal(decodeChannelConfigCode(importedRenewal.channelCode).channelRevision, renewedChannelPayload.channelRevision);
  assert.equal(importedRenewal.pin.keyId, pin.keyId);
  const firstLostImport = decodeChannelImportCode(lostRenewalEnvelope.payload.wrappedCode);
  const firstLostChannel = decodeChannelConfigCode(firstLostImport.channelCode);
  const retriedChannel = decodeChannelConfigCode(importedRenewal.channelCode);
  assert.equal(firstLostChannel.channelRevision, retriedChannel.channelRevision);
  assert.deepEqual(firstLostChannel.connection, retriedChannel.connection,
    "response-loss retry must preserve the applied bootstrap transport identity");
  assert.equal(firstLostChannel.bootstrap.endpoint, retriedChannel.bootstrap.endpoint,
    "response-loss retry must preserve the bootstrap control endpoint");
  assert.equal(firstLostChannel.bootstrap.purpose, retriedChannel.bootstrap.purpose);
  const renewalReceipts = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.equal(renewalReceipts.length, 2, "channel renewal after reconfiguration must not request another restart");

  const staleBytes = Buffer.from(JSON.stringify({ channelRevision: primaryBinding.channelRevision }), "utf8");
  const staleRenewal = await renewalRequest(staleBytes, "nonce_renewal_stale_0001");
  assert.equal(staleRenewal.status, 409);
  assert.equal((await staleRenewal.json()).error, "enrollment_channel_stale");

  const relationId = primaryBinding.identity.relationId;
  const dataPath = "/api/enrollment/v1/data-authorization";
  const dataBody = Buffer.from(canonicalJson({ relationId }), "utf8");
  const makeDataAuthorization = nonce => signAuthorizationRequest({
    binding: primaryBinding, bodyBytes: dataBody, method: "POST", path: dataPath, nonce
  }, pair.privateKey);
  const refresh = authorization => bootstrapPost(dataPath, dataBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(authorization), "utf8").toString("base64url")
  });

  const firstRefresh = await refresh(makeDataAuthorization("nonce_0123456789abcdef"));
  assert.equal(firstRefresh.status, 200, await firstRefresh.clone().text());
  const firstEnvelope = await firstRefresh.json();
  assert.deepEqual(Object.keys(firstEnvelope).sort(), ["payload", "signature"]);
  verifyDataAuthorizationEnvelope(firstEnvelope, pin, {
    deviceId: request.deviceId, publicKey: pair.publicKey.export({ format: "jwk" }),
    relationId, binding: primaryBinding
  });
  const afterFirst = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.equal(afterFirst.length, 3, "first data-channel materialization should apply exactly one new config after renewal setup");
  assert.notEqual(afterFirst[1].expectedConfigSha256, afterFirst[2].expectedConfigSha256);
  assert.equal(afterFirst[2].ok, true);
  t.diagnostic(`dataAuthorizationBodySha256=${sha256(dataBody)}`);
  t.diagnostic(`firstAppliedDataConfigSha256=${afterFirst[2].expectedConfigSha256}`);

  const secondRefresh = await refresh(makeDataAuthorization("nonce_1123456789abcdef"));
  assert.equal(secondRefresh.status, 200, await secondRefresh.clone().text());
  const secondEnvelope = await secondRefresh.json();
  verifyDataAuthorizationEnvelope(secondEnvelope, pin, {
    deviceId: request.deviceId, publicKey: pair.publicKey.export({ format: "jwk" }),
    relationId, binding: primaryBinding
  });
  const afterSecond = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.equal(afterSecond.length, 3, "same desired config digest must not request a second data-channel restart");
  assert.equal(afterSecond[2].actualConfigSha256, afterSecond[2].expectedConfigSha256);

  const secondaryBinding = issued.bindings[1];
  const secondaryRelationId = secondaryBinding.identity.relationId;
  const secondaryDataBody = Buffer.from(canonicalJson({ relationId: secondaryRelationId }), "utf8");
  const secondaryAuthorization = signAuthorizationRequest({
    binding: secondaryBinding,
    bodyBytes: secondaryDataBody,
    method: "POST",
    path: dataPath,
    nonce: "nonce_2123456789abcdef"
  }, pair.privateKey);
  const secondaryRefresh = await bootstrapPost(dataPath, secondaryDataBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(secondaryAuthorization), "utf8").toString("base64url")
  });
  assert.equal(secondaryRefresh.status, 200, await secondaryRefresh.clone().text());
  const secondaryEnvelope = await secondaryRefresh.json();
  verifyDataAuthorizationEnvelope(secondaryEnvelope, pin, {
    deviceId: request.deviceId,
    publicKey: pair.publicKey.export({ format: "jwk" }),
    relationId: secondaryRelationId,
    binding: secondaryBinding
  });

  const readinessResponse = await adminRequest("/api/admin/setup");
  assert.equal(readinessResponse.status, 200, await readinessResponse.clone().text());
  const readiness = await readinessResponse.json();
  const readinessSteps = Object.fromEntries(readiness.steps.map(step => [step.id, step]));
  assert.equal(readinessSteps.directory.evidence.activeRootCount, 2);
  assert.equal(readinessSteps.repair.evidence.bootstrapApplyReceipt, true);
  assert.equal(readinessSteps.repair.evidence.dataOverlayApplyReceipt, true);
  assert.equal(readinessSteps.pairing.evidence.authorizedRelationCount, 2);

  const revokeOperationId = "revop_1123456789abcdef";
  const revokeRequest = {
    operationId: revokeOperationId,
    target: { kind: "relation", relationId }
  };
  const malformedRevocation = await adminRequest("/api/admin/enrollment/v1/revocations", "POST", {});
  assert.equal(malformedRevocation.status, 400, await malformedRevocation.clone().text());
  assert.equal((await fetch(`${baseUrl}/healthz`).then(response => response.json())).enrollmentRevocations.pendingRecovery, false,
    "a malformed request must not mark recovery pending");
  const inflightRevoke = adminRequest("/api/admin/enrollment/v1/revocations", "POST", revokeRequest);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readFile(join(dataRoot, "revocation-stop-entered"), "utf8").then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(join(dataRoot, "revocation-stop-entered"), "utf8").then(() => true, () => false), true,
    "runtime stop is held after the revocation operation has been persisted");
  const inflightOperation = await adminRequest(`/api/admin/enrollment/v1/operations/${revokeOperationId}`);
  assert.equal(inflightOperation.status, 200, await inflightOperation.clone().text());
  assert.equal((await inflightOperation.json()).status, "pending");
  const inflightHealth = await fetch(`${baseUrl}/healthz`);
  assert.equal(inflightHealth.status, 503, await inflightHealth.clone().text());
  assert.equal((await inflightHealth.json()).enrollmentRevocations.pendingRecovery, true,
    "health must report persisted pending recovery while the revocation HTTP request is still awaiting runtime stop");
  await writeFile(join(dataRoot, "allow-revocation-attempt"), "continue", "utf8");
  const pendingRevoke = await inflightRevoke;
  assert.equal(pendingRevoke.status, 503, await pendingRevoke.clone().text());
  assert.equal((await pendingRevoke.json()).status, "pending");
  const pendingOperation = await adminRequest(`/api/admin/enrollment/v1/operations/${revokeOperationId}`);
  assert.equal(pendingOperation.status, 200);
  assert.equal((await pendingOperation.json()).status, "pending");
  const conflictingTarget = await adminRequest("/api/admin/enrollment/v1/revocations", "POST", {
    operationId: revokeOperationId,
    target: { kind: "device", deviceId: request.deviceId }
  });
  assert.equal(conflictingTarget.status, 409, await conflictingTarget.clone().text());
  assert.equal((await conflictingTarget.json()).errorCode, "enrollment_revocation_operation_conflict");
  const unknownOperation = await adminRequest("/api/admin/enrollment/v1/operations/revop_2123456789abcdef");
  assert.equal(unknownOperation.status, 404);
  assert.equal((await unknownOperation.json()).errorCode, "enrollment_revocation_operation_not_found");
  const sameOperationRetry = await adminRequest("/api/admin/enrollment/v1/revocations", "POST", revokeRequest);
  assert.equal(sameOperationRetry.status, 503, await sameOperationRetry.clone().text());
  assert.equal((await sameOperationRetry.json()).status, "pending");
  const blockedDataAuthorization = await bootstrapPost(dataPath, secondaryDataBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(signAuthorizationRequest({
      binding: secondaryBinding, bodyBytes: secondaryDataBody, method: "POST", path: dataPath, nonce: "nonce_revocation_blocked_01"
    }, pair.privateKey)), "utf8").toString("base64url")
  });
  assert.equal(blockedDataAuthorization.status, 503, await blockedDataAuthorization.clone().text());
  assert.equal((await blockedDataAuthorization.json()).errorCode, "enrollment_revocation_recovery_pending");

  child.stdin.write("close\n");
  await once(child, "exit");
  childStopped = true;
  lines.close();
  assert.equal(child.exitCode, 0, childStderr);
  launchHarness();
  const recoveryReady = await waitHarnessReady(lines, child);
  baseUrl = `http://127.0.0.1:${recoveryReady.event.port}`;
  gatewayUrl = `http://127.0.0.1:${recoveryReady.event.gatewayPort}`;
  const recoveryHealth = await fetch(`${baseUrl}/healthz`);
  assert.equal(recoveryHealth.status, 503, await recoveryHealth.clone().text());
  assert.equal((await recoveryHealth.json()).enrollmentRevocations.pendingRecovery, true);
  const recoveredPendingOperation = await adminRequest(`/api/admin/enrollment/v1/operations/${revokeOperationId}`);
  assert.equal(recoveredPendingOperation.status, 200, await recoveredPendingOperation.clone().text());
  assert.equal((await recoveredPendingOperation.json()).status, "pending");
  assert.equal((await adminRequest("/api/admin/enrollment/v1/requests")).status, 200, "management listener remains available during pending recovery");
  const recoveryBlockedRefresh = await bootstrapPost(dataPath, secondaryDataBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(signAuthorizationRequest({
      binding: secondaryBinding, bodyBytes: secondaryDataBody, method: "POST", path: dataPath, nonce: "nonce_revocation_recovery_01"
    }, pair.privateKey)), "utf8").toString("base64url")
  });
  assert.equal(recoveryBlockedRefresh.status, 503, await recoveryBlockedRefresh.clone().text());
  assert.equal((await recoveryBlockedRefresh.json()).errorCode, "enrollment_revocation_recovery_pending");

  await writeFile(join(dataRoot, "allow-revocation-stop"), "confirmed", "utf8");
  const resumedRevoke = await adminRequest("/api/admin/enrollment/v1/revocations", "POST", revokeRequest);
  assert.equal(resumedRevoke.status, 200, await resumedRevoke.clone().text());
  const completedRevoke = await resumedRevoke.json();
  assert.equal(completedRevoke.status, "complete");
  assert.ok(completedRevoke.relations.every(item => ["stopped", "absent"].includes(item.state)));
  assert.equal(completedRevoke.overlayStatus, "applied");
  const completedOperation = await adminRequest(`/api/admin/enrollment/v1/operations/${revokeOperationId}`);
  assert.equal((await completedOperation.json()).status, "complete");
  const appliedConfig = await readFile(join(dataRoot, "sing-box", "config.json"));
  const appliedDigest = sha256(appliedConfig);
  const recoveredReceipts = JSON.parse(await readFile(join(dataRoot, "test-supervisor-receipts.json"), "utf8"));
  assert.ok(recoveredReceipts.some(item => item.ok && item.actualConfigSha256 === appliedDigest), "test supervisor accepted the exact post-revocation config digest");

  const rejectedRevokedRefresh = await refresh(makeDataAuthorization("nonce_revocation_denied_01"));
  assert.equal(rejectedRevokedRefresh.status, 403, await rejectedRevokedRefresh.clone().text());
  assert.equal((await rejectedRevokedRefresh.json()).errorCode, "enrollment_relation_denied");
  const refreshedSecondary = await bootstrapPost(dataPath, secondaryDataBody, {
    "x-sfsc-authorization": Buffer.from(canonicalJson(signAuthorizationRequest({
      binding: secondaryBinding, bodyBytes: secondaryDataBody, method: "POST", path: dataPath, nonce: "nonce_revocation_other_01"
    }, pair.privateKey)), "utf8").toString("base64url")
  });
  assert.equal(refreshedSecondary.status, 200, await refreshedSecondary.clone().text());
  const postRevokeRelations = await adminRequest("/api/admin/enrollment/v1/relations");
  const postRevokeRelationRows = (await postRevokeRelations.json()).relations;
  assert.equal(postRevokeRelationRows.find(item => item.relationId === relationId).status, "revoked");
  assert.equal(postRevokeRelationRows.find(item => item.relationId === secondaryRelationId).status, "active");

  child.stdin.write("close\n");
  await once(child, "exit");
  childStopped = true;
  assert.equal(child.exitCode, 0, childStderr);
  assert.equal(await readFile(catalogPath, "utf8").then(() => true, () => false), true);
});

test("directory mode refuses to start without its published root", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-directory-root-required-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1", PORT: "0", SERVER_DATA_ROOT: join(tempRoot, "data"),
      SFSC_STORAGE_MODE: "directory", SFSC_DIRECTORY_ROOT: "",
      SFSC_REQUIRE_ADMIN_TOKEN: "1", SFSC_ADMIN_TOKEN: adminToken,
      MINIO_ROOT_PASSWORD: "test-password-not-used-in-enrollment"
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 1, stderr);
  assert.match(stderr, /SFSC_DIRECTORY_ROOT is required when SFSC_STORAGE_MODE=directory/);
});

test("data authorization gateway consumes a nonce after provider catalog writes and rejects replay or revoked authority", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-data-auth-http-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataRoot = join(tempRoot, "data");
  const fixture = await createReadyCatalog(dataRoot);
  const catalogPath = join(dataRoot, "relation-service", "catalog.json");
  const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  let nowMs = fixedNow;
  const service = createEnrollmentService({
    statePath: join(dataRoot, "sfsc-enrollment-state.json"),
    signerPath: join(dataRoot, "sfsc-enrollment-signer.json"),
    catalogPath,
    activeChannelRevision: channelRevision,
    now: () => nowMs
  });
  await service.initialize();
  t.after(() => service.close());
  const signer = await service.getTrustMaterial();
  let providerCalls = 0;
  let nextDataAuthorizationFailure = null;
  let providerLockGate = null;
  service.setDataAuthorizationProvider(async ({ deviceId, relationId, binding }) => {
    providerCalls += 1;
    if (nextDataAuthorizationFailure) {
      const failure = nextDataAuthorizationFailure;
      nextDataAuthorizationFailure = null;
      const error = new Error("internal protection failure at /private/server/path");
      Object.assign(error, failure);
      throw error;
    }
    assert.equal(deviceId, sourceDeviceId);
    assert.equal(relationId, fixture.relationId);
    assert.deepEqual(binding, fixture.sourceBinding);
    if (providerLockGate) {
      const gate = providerLockGate;
      providerLockGate = null;
      const before = await catalog.read();
      await catalog.update({ expectedRevision: before.revision }, async () => {
        gate.entered();
        await gate.wait;
      });
    }
    const before = await catalog.read();
    // Relation materialization may advance catalog.revision while leaving
    // authority and the signed request nonce unchanged.
    await catalog.update({ expectedRevision: before.revision }, () => {});
    const hostKeyLine = authorizedKeysLine(fixture.hostPair.publicKey).toString("utf8").trim();
    const hostBlob = Buffer.from(hostKeyLine.split(" ")[1], "base64");
    const hostFingerprint = `SHA256:${createHash("sha256").update(hostBlob).digest("base64").replace(/=+$/, "")}`;
    return {
      protocol: "sfsc-data-authorization", version: 1, kind: "data-authorization",
      serverId, keyId: signer.keyId, deviceId,
      publicKeyFingerprint: publicKeyFingerprint(fixture.sourcePair.publicKey),
      binding,
      authorization: { directions: ["bidirectional"], allowDelete: true },
      displayName: "projects",
      sftp: { host: "127.0.0.1", port: 24001, user: "sfsc", rootPath: "/" },
      serverHostKey: { publicKey: `${hostKeyLine} sfsc`, fingerprint: hostFingerprint },
      sftpDataChannel: {
        channelRevision: "chrev_0000000000000002",
        connection: { type: "vless", uri: "vless://123e4567-e89b-42d3-a456-426614174001@sync.example.test:443?security=tls" }
      },
      issuedAt: new Date(fixedNow).toISOString(),
      expiresAt: new Date(fixedNow + 60_000).toISOString()
    };
  });
  let renewalProviderCalls = 0;
  service.setChannelRenewalProvider(async ({ deviceId, binding, channelRevision: requestedRevision }) => {
    renewalProviderCalls += 1;
    assert.equal(deviceId, sourceDeviceId);
    assert.deepEqual(binding, fixture.sourceBinding);
    assert.equal(requestedRevision, channelRevision);
    return { channelRevision: requestedRevision, wrappedCode: "SFSC-CHANNEL-IMPORT-V1:dGVzdA" };
  });

  const oldChannel = await service.issueChannelCode({
    channelRevision,
    connection: { type: "vless", uri: "vless://123e4567-e89b-42d3-a456-426614174001@sync.example.test:443?security=tls" },
    bootstrap: {
      endpoint: "http://127.0.0.1:9000/api/enrollment/v1",
      purpose: "identity-enrollment",
      expiresAt: new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString()
    },
    expiresAt: new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString()
  });
  const gateway = createEnrollmentBootstrapGateway({ enrollmentService: service, port: 0 });
  const address = await gateway.start();
  t.after(() => gateway.close());
  const path = "/api/enrollment/v1/data-authorization";
  const bodyBytes = Buffer.from(canonicalJson({ relationId: fixture.relationId }), "utf8");
  const makeHeader = nonce => Buffer.from(canonicalJson(signAuthorizationRequest({
    binding: fixture.sourceBinding, method: "POST", path, bodyBytes,
    timestamp: new Date(fixedNow).toISOString(), nonce
  }, fixture.sourcePair.privateKey)), "utf8").toString("base64url");
  const send = authorizationHeader => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-sfsc-authorization": authorizationHeader }, body: bodyBytes
  });

  const header = makeHeader("nonce_0123456789abcdef");
  const response = await send(header);
  assert.equal(response.status, 200, await response.clone().text());
  const envelope = await response.json();
  assert.deepEqual(Object.keys(envelope).sort(), ["payload", "signature"]);
  assert.equal(envelope.payload.binding.identity.relationId, fixture.relationId);
  const verified = verifyDataAuthorizationEnvelope(envelope, {
    serverId: signer.serverId, keyId: signer.keyId, publicKey: signer.publicKey
  }, { deviceId: sourceDeviceId, publicKey: fixture.sourcePair.publicKey, relationId: fixture.relationId, binding: fixture.sourceBinding }, { nowMs: fixedNow });
  assert.deepEqual(verified.binding, fixture.sourceBinding);
  assert.equal(providerCalls, 1);

  const replay = await send(header);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).errorCode, "enrollment_auth_replayed");
  assert.equal(providerCalls, 1, "replay must fail before repeating provider work");

  let enterProviderLock;
  let releaseProviderLock;
  const providerLockEntered = new Promise(resolve => { enterProviderLock = resolve; });
  const providerLockWait = new Promise(resolve => { releaseProviderLock = resolve; });
  providerLockGate = { entered: enterProviderLock, wait: providerLockWait };
  let firstConcurrentSettled = false;
  const firstConcurrent = send(makeHeader("nonce_catalog_serial_a_001")).then(response => {
    firstConcurrentSettled = true;
    return response;
  });
  await providerLockEntered;
  let secondConcurrentSettled = false;
  const secondConcurrent = send(makeHeader("nonce_catalog_serial_b_001")).then(response => {
    secondConcurrentSettled = true;
    return response;
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(firstConcurrentSettled, false);
  assert.equal(secondConcurrentSettled, false, "second signed refresh must wait for the in-flight provider/catalog work");
  assert.equal(providerCalls, 2, "queued request must not enter provider before the first nonce commit");
  releaseProviderLock();
  const [firstConcurrentResponse, secondConcurrentResponse] = await Promise.all([firstConcurrent, secondConcurrent]);
  assert.equal(firstConcurrentResponse.status, 200, await firstConcurrentResponse.clone().text());
  assert.equal(secondConcurrentResponse.status, 200, await secondConcurrentResponse.clone().text());
  assert.equal(providerCalls, 3);

  const renewalPath = "/api/enrollment/v1/channel-renewal";
  const renewalBody = Buffer.from(canonicalJson({ channelRevision }), "utf8");
  const makeRenewalHeader = nonce => Buffer.from(canonicalJson(signAuthorizationRequest({
    binding: fixture.sourceBinding, method: "POST", path: renewalPath, bodyBytes: renewalBody,
    timestamp: new Date(nowMs).toISOString(), nonce
  }, fixture.sourcePair.privateKey)), "utf8").toString("base64url");
  const sendRenewal = authorizationHeader => fetch(`http://127.0.0.1:${address.port}${renewalPath}`, {
    method: "POST", headers: { "content-type": "application/json", "x-sfsc-authorization": authorizationHeader }, body: renewalBody
  });
  const renewalHeader = makeRenewalHeader("nonce_renewal_http_000001");
  const renewalResponse = await sendRenewal(renewalHeader);
  assert.equal(renewalResponse.status, 200, await renewalResponse.clone().text());
  const renewalEnvelope = await renewalResponse.json();
  assert.equal(verify(null, Buffer.from(canonicalJson(renewalEnvelope.payload), "utf8"),
    createPublicKey({ key: signer.publicKey, format: "jwk" }), Buffer.from(renewalEnvelope.signature, "base64url")), true);
  const renewalReplay = await sendRenewal(renewalHeader);
  assert.equal(renewalReplay.status, 409);
  assert.equal((await renewalReplay.json()).errorCode, "enrollment_auth_replayed");
  assert.equal(renewalProviderCalls, 1, "replay must fail before repeating channel issuance");

  nextDataAuthorizationFailure = {
    code: "root_protection_helper_failed",
    helperCode: "set_flags_failed"
  };
  const failedDataAuthHeader = makeHeader("nonce_3123456789abcdef");
  const errorLogs = [];
  const originalConsoleError = console.error;
  let failedDataAuth;
  console.error = (...values) => errorLogs.push(values.join(" "));
  try {
    failedDataAuth = await send(failedDataAuthHeader);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failedDataAuth.status, 503, await failedDataAuth.clone().text());
  const failedEnvelope = await failedDataAuth.json();
  assert.equal(failedEnvelope.errorCode, "enrollment_data_relation_start_failed");
  assert.match(failedEnvelope.message, /administrator.*protection capabilities/i);
  assert.doesNotMatch(JSON.stringify(failedEnvelope), /root_protection_helper_failed|set_flags_failed|private\/server\/path/i);
  assert.match(errorLogs.join("\n"), /code=root_protection_helper_failed helperCode=set_flags_failed/);
  assert.doesNotMatch(errorLogs.join("\n"), /private\/server\/path/);
  const recoveredDataAuth = await send(failedDataAuthHeader);
  assert.equal(recoveredDataAuth.status, 200, await recoveredDataAuth.clone().text());

  nowMs = fixedNow + 25 * 60 * 60 * 1000;
  assert.throws(() => verifyChannelConfigCode(oldChannel.channelCode, {
    trustedServerKeys: { [signer.keyId]: { keyId: signer.keyId, publicKey: signer.publicKey } }, nowMs
  }), error => error.code === "enrollment_channel_expired");
  const afterExpiry = await sendRenewal(makeRenewalHeader("nonce_renewal_after_exp_001"));
  assert.equal(afterExpiry.status, 200, await afterExpiry.clone().text());
  assert.equal(renewalProviderCalls, 2, "expired channel config may renew through the signed consumed binding");

  let state = await catalog.read();
  const relationRevoked = revokeEnrollmentRelation(state.authority, { relationId: fixture.relationId }, { expectedRevision: state.authority.revision, nowMs: fixedNow });
  await catalog.update({ expectedRevision: state.revision }, current => { current.authority = relationRevoked.nextState; });
  const revokedRelationResponse = await send(makeHeader("nonce_1123456789abcdef"));
  assert.equal(revokedRelationResponse.status, 403);
  assert.equal(providerCalls, 5, "revoked relation must fail before provider work");
  const revokedRelationRenewal = await sendRenewal(makeRenewalHeader("nonce_renewal_revoked_0001"));
  assert.equal(revokedRelationRenewal.status, 403);
  assert.equal((await revokedRelationRenewal.json()).errorCode, "enrollment_relation_denied");
  assert.equal(renewalProviderCalls, 2, "revoked relation must fail before channel issuance");

  state = await catalog.read();
  const deviceRevoked = revokeEnrollmentDevice(state.authority, { deviceId: sourceDeviceId }, { expectedRevision: state.authority.revision, nowMs: fixedNow });
  await catalog.update({ expectedRevision: state.revision }, current => { current.authority = deviceRevoked.nextState; });
  const revokedDeviceResponse = await send(makeHeader("nonce_2123456789abcdef"));
  assert.equal(revokedDeviceResponse.status, 403);
  assert.equal(providerCalls, 5, "revoked device must fail before provider work");
});

test("enrollment HTTP flow persists request, issues a separate identity code, and consumes with signed receipt", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-http-"));
  const dataRoot = join(tempRoot, "data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const catalog = await createReadyCatalog(dataRoot);
  const port = await freePort();
  const bootstrapPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrapUrl = `http://127.0.0.1:${bootstrapPort}`;
  let child = startServer(dataRoot, port, bootstrapPort);
  t.after(async () => { await stopServer(child); await rm(tempRoot, { recursive: true, force: true }); });
  await waitReady(baseUrl, child);

  const bootstrapRegistry = await waitForBootstrapRegistry(join(dataRoot, "sfsc-enrollment-bootstrap-registry.json"), child);
  const activeChannelRevision = bootstrapRegistry.channelRevision;

  const unauthenticatedAdmin = await fetch(`${baseUrl}/api/admin/enrollment/v1/requests`);
  assert.equal(unauthenticatedAdmin.status, 401);
  const unauthenticatedDirectories = await fetch(`${baseUrl}/api/admin/enrollment/v1/directories`);
  assert.equal(unauthenticatedDirectories.status, 401);
  const unauthenticatedRevocation = await fetch(`${baseUrl}/api/admin/enrollment/v1/revocations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: "revop_0123456789abcdef", target: { kind: "relation", relationId: catalog.relationId } })
  });
  assert.equal(unauthenticatedRevocation.status, 401);
  const invalidRevocation = await fetch(`${baseUrl}/api/admin/enrollment/v1/revocations`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ operationId: "revop_0123456789abcdef", target: { kind: "relation", relationId: catalog.relationId, identity: {} } })
  });
  assert.equal(invalidRevocation.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/admin/enrollment/v1/relations`)).status, 401);
  const directoryPath = join(tempRoot, "extra-root");
  await mkdir(directoryPath, { mode: 0o700 });
  const openedDirectory = await fetch(`${baseUrl}/api/admin/enrollment/v1/directories`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: directoryPath })
  });
  assert.equal(openedDirectory.status, 201, JSON.stringify(await openedDirectory.clone().json()));
  const openedDirectoryBody = await openedDirectory.json();
  assert.equal(openedDirectoryBody.directory.status, "active");
  assert.equal((await readFile(join(directoryPath, ".syncraft-root.json"), "utf8")).includes(openedDirectoryBody.directory.rootId), true);
  const pinResponse = await fetch(`${baseUrl}/api/admin/enrollment/v1/trust`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(pinResponse.status, 200);
  const { pin } = await pinResponse.json();
  assert.equal(pin.serverId, serverId);
  assert.equal((await readFile(join(dataRoot, "sfsc-enrollment-signer.json"), "utf8")).includes("PRIVATE KEY"), true);

  const pair = createEnrollmentKeyPair();
  const request = {
    protocol: "sfsc-enrollment", version: 1, kind: "enrollment-request",
    requestId: createEnrollmentIdentityId("requestId"), deviceId: createEnrollmentIdentityId("deviceId"),
    channelRevision: activeChannelRevision, publicKey: pair.publicKey.export({ format: "jwk" })
  };
  const requestBytes = Buffer.from(JSON.stringify(request));
  const badRequest = await fetch(`${bootstrapUrl}/api/enrollment/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: requestBytes
  });
  assert.equal(badRequest.status, 401);
  const publicRoute = await fetch(`${baseUrl}/api/enrollment/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: requestBytes
  });
  assert.equal(publicRoute.status, 404);
  const created = await fetch(`${bootstrapUrl}/api/enrollment/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sfsc-enrollment-request": requestProofHeader({ bodyBytes: requestBytes, input: request, privateKey: pair.privateKey }) },
    body: requestBytes
  });
  assert.equal(created.status, 202, JSON.stringify(await created.clone().json()));
  assert.equal((await created.json()).status, "pending");
  const tamperedBytes = Buffer.from(`${requestBytes.toString("utf8")} `);
  const tamperedRequest = await fetch(`${bootstrapUrl}/api/enrollment/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sfsc-enrollment-request": requestProofHeader({ bodyBytes: requestBytes, input: request, privateKey: pair.privateKey }) },
    body: tamperedBytes
  });
  assert.equal(tamperedRequest.status, 403);

  const pending = await fetch(`${baseUrl}/api/admin/enrollment/v1/requests`, { headers: { authorization: `Bearer ${adminToken}` } });
  const pendingPayload = await pending.json();
  assert.equal(pendingPayload.requests?.[0]?.requestId, request.requestId, JSON.stringify(pendingPayload));
  const issuedResponse = await fetch(`${baseUrl}/api/admin/enrollment/v1/requests/${request.requestId}/issue`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ rootId: catalog.rootId })
  });
  assert.equal(issuedResponse.status, 201, JSON.stringify(await issuedResponse.clone().json()));
  const issued = await issuedResponse.json();
  assert.equal(issued.binding.identity.deviceId, request.deviceId);
  assert.equal(issued.binding.identity.rootId, catalog.rootId);
  assert.match(issued.binding.rootAttestation.referenceId, /^att_[a-f0-9]{64}$/);
  const issueRetry = await fetch(`${baseUrl}/api/admin/enrollment/v1/requests/${request.requestId}/issue`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ rootId: catalog.rootId })
  });
  assert.equal(issueRetry.status, 201);
  assert.deepEqual(await issueRetry.json(), issued, "issue retry must return the staged code and same binding");

  const body = Buffer.from(JSON.stringify({ code: issued.deviceEnrollmentCode }));
  const authorization = signAuthorizationRequest({
    binding: issued.binding, bodyBytes: body, method: "POST", path: "/api/enrollment/v1/consume"
  }, pair.privateKey);
  const authHeader = Buffer.from(canonicalJson(authorization)).toString("base64url");
  const mismatchedTarget = await fetch(`${bootstrapUrl}/api/enrollment/v1/consume?extra=1`, {
    method: "POST", headers: { "content-type": "application/json", "x-sfsc-authorization": authHeader }, body
  });
  assert.equal(mismatchedTarget.status, 404);
  const mismatchedBody = await fetch(`${bootstrapUrl}/api/enrollment/v1/consume`, {
    method: "POST", headers: { "content-type": "application/json", "x-sfsc-authorization": authHeader },
    body: Buffer.from(`${body.toString("utf8")} `)
  });
  assert.equal(mismatchedBody.status, 403);
  const consumed = await fetch(`${bootstrapUrl}/api/enrollment/v1/consume`, {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-sfsc-authorization": authHeader
    }, body
  });
  assert.equal(consumed.status, 200);
  const result = await consumed.json();
  assert.equal(result.grant.deviceId, request.deviceId);
  assert.equal(result.receipt.kind, "enrollment-consumption-receipt");
  const { signature, ...receiptUnsigned } = result.receipt;
  assert.equal(verify(null, Buffer.from(canonicalJson(receiptUnsigned)), createPublicKey({ key: pin.publicKey, format: "jwk" }), Buffer.from(signature, "base64url")), true);
  const persistedState = await readFile(join(dataRoot, "sfsc-enrollment-state.json"), "utf8");
  const metadataState = JSON.parse(persistedState);
  assert.equal(metadataState.version, 2);
  assert.equal(Object.hasOwn(metadataState, "authority"), false);
  assert.equal(metadataState.requests[request.requestId].status, "consumed");
  assert.equal(persistedState.includes(issued.deviceEnrollmentCode), true);

  const managementSurface = await fetch(`${baseUrl}/api/enrollment/v1/data-authorization`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relationId: "rel_0000000000000001" })
  });
  assert.equal(managementSurface.status, 404);

  // Simulate request-metadata loss after catalog authority committed. The
  // consumed catalog record remains the source used to rebuild the retry receipt.
  await rm(join(dataRoot, "sfsc-enrollment-state.json"));
  await stopServer(child);
  child = startServer(dataRoot, port, bootstrapPort);
  await waitReady(baseUrl, child);
  const restoredPin = await fetch(`${baseUrl}/api/admin/enrollment/v1/trust`, { headers: { authorization: `Bearer ${adminToken}` } }).then(response => response.json());
  assert.deepEqual(restoredPin.pin, pin);
  const replay = await fetch(`${bootstrapUrl}/api/enrollment/v1/consume`, {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-sfsc-authorization": authHeader
    }, body
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), result);
  const recoveredMetadata = JSON.parse(await readFile(join(dataRoot, "sfsc-enrollment-state.json"), "utf8"));
  assert.equal(recoveredMetadata.version, 2);
  assert.equal(recoveredMetadata.requests[request.requestId].status, "consumed");
  const relationList = await fetch(`${baseUrl}/api/admin/enrollment/v1/relations`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(relationList.status, 200);
  const relationListBody = await relationList.json();
  assert.equal(relationListBody.relations.some(item => item.relationId === catalog.relationId && item.status === "active"), true, JSON.stringify(relationListBody));
  const revokeBody = { operationId: "revop_0123456789abcdef", target: { kind: "relation", relationId: catalog.relationId } };
  const revokeResponse = await fetch(`${baseUrl}/api/admin/enrollment/v1/revocations`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(revokeBody)
  });
  const revokeResult = await revokeResponse.json();
  assert.equal(revokeResponse.status, 503);
  assert.equal(revokeResult.errorCode, "enrollment_revocation_not_ready");
  assert.equal(catalog.rootPath, join(dataRoot, "shares", "projects"));
});

test("enrollment HTTP routes fail closed when relation catalog is missing and channel config is unavailable", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-unready-"));
  const dataRoot = join(tempRoot, "data");
  const port = await freePort();
  const bootstrapPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(dataRoot, port, bootstrapPort);
  t.after(async () => { await stopServer(child); await rm(tempRoot, { recursive: true, force: true }); });
  await waitReady(baseUrl, child);
  const channel = await fetch(`${baseUrl}/api/admin/enrollment/v1/channel-code`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(channel.status, 503);
  assert.equal((await channel.json()).errorCode, "enrollment_channel_not_ready");
  const trust = await fetch(`${baseUrl}/api/admin/enrollment/v1/trust`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(trust.status, 503);
  assert.equal((await trust.json()).errorCode, "enrollment_catalog_not_ready");
});

test("nonempty legacy authority that differs from the catalog is rejected for controlled migration", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-enrollment-legacy-conflict-"));
  const dataRoot = join(tempRoot, "data");
  const catalogFixture = await createReadyCatalog(dataRoot);
  const catalogPath = join(dataRoot, "relation-service", "catalog.json");
  const catalog = await openRelationServiceBindingCatalog({ path: catalogPath, mode: "require-existing" });
  const catalogState = await catalog.read();
  const legacyAuthority = structuredClone(catalogState.authority);
  legacyAuthority.revision += 1;
  legacyAuthority.updatedAt = new Date(fixedNow + 1).toISOString();
  const createdAt = new Date(fixedNow).toISOString();
  await writeFile(join(dataRoot, "sfsc-enrollment-state.json"), canonicalJson({
    kind: "sfsc-enrollment-service-state", version: 1, revision: 0,
    serverId: catalogState.authority.serverId, createdAt, updatedAt: createdAt,
    requests: {}, authority: legacyAuthority
  }), "utf8");

  const port = await freePort();
  const bootstrapPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(dataRoot, port, bootstrapPort);
  t.after(async () => { await stopServer(child); await rm(tempRoot, { recursive: true, force: true }); });
  await waitReady(baseUrl, child);
  const response = await fetch(`${baseUrl}/api/admin/enrollment/v1/requests`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "enrollment_state_conflict");
  assert.equal(catalogFixture.relationId, "rel_0000000000000001");
});
