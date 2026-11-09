import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(projectRoot, "src", "server.js");

test("server S3 requests never leave internalEndpoint after it fails", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-s3-internal-boundary-"));
  const fetchAuditPath = join(tempRoot, "fetch-audit.jsonl");
  const preloadPath = join(tempRoot, "audit-fetch.mjs");
  const internalRequests = [];
  const clientEndpointRequests = [];
  const clientEndpointServer = createFailingProbe(clientEndpointRequests);

  await listen(clientEndpointServer);
  const clientEndpoint = serverUrl(clientEndpointServer);
  const internalServer = createRedirectingProbe(internalRequests, clientEndpoint);
  await listen(internalServer);
  const internalEndpoint = serverUrl(internalServer);
  const appPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;

  await writeFile(preloadPath, [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.SFSC_FETCH_AUDIT_PATH, JSON.stringify("__preload_loaded__") + "\\n");',
    "setImmediate(() => {",
    "  const nativeFetch = globalThis.fetch;",
    "  globalThis.fetch = async (input, init) => {",
    "    const url = new URL(typeof input === \"string\" || input instanceof URL ? input : input.url);",
    "    appendFileSync(process.env.SFSC_FETCH_AUDIT_PATH, JSON.stringify(url.href) + \"\\n\");",
    "    if (url.hostname === \"minio\" && url.port === \"9000\") {",
    "      return new Response(\"hardcoded endpoint unavailable\", { status: 503 });",
    "    }",
    "    return nativeFetch(input, init);",
    "  };",
    "});",
    ""
  ].join("\n"), "utf8");
  await writeFile(fetchAuditPath, "", "utf8");

  const child = spawn(process.execPath, [`--import=${pathToFileURL(preloadPath).href}`, serverEntry], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(appPort),
      PUBLIC_SERVER_URL: baseUrl,
      SERVER_DATA_ROOT: join(tempRoot, "data"),
      SINGBOX_CONFIG_PATH: join(tempRoot, "sing-box", "config.json"),
      SFSC_ENROLLMENT_BOOTSTRAP_PORT: "0",
      S3_ENDPOINT: internalEndpoint,
      S3_CLIENT_ENDPOINT: clientEndpoint,
      SFSC_FETCH_AUDIT_PATH: fetchAuditPath,
      SFSC_REQUIRE_ADMIN_TOKEN: "0",
      SFSC_ADMIN_TOKEN: "",
      ADMIN_TOKEN: ""
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  t.after(async () => {
    await stopChild(child);
    await closeServer(internalServer);
    await closeServer(clientEndpointServer);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, () => stderr);
  const response = await fetch(`${baseUrl}/api/admin/storage/buckets/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.warning, /fetch failed/);

  const auditedUrls = (await readFile(fetchAuditPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(auditedUrls.shift(), "__preload_loaded__");
  assert.deepEqual(auditedUrls, [`${internalEndpoint}/`]);
  assert.deepEqual(internalRequests, [{ method: "GET", url: "/" }]);
  assert.deepEqual(clientEndpointRequests, []);
  assert.doesNotMatch(payload.warning, new RegExp(escapeRegex(clientEndpoint)));
  assert.doesNotMatch(payload.warning, /http:\/\/minio:9000/);
});

function createFailingProbe(requests) {
  return createHttpServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("storage unavailable");
  });
}

function createRedirectingProbe(requests, location) {
  return createHttpServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(307, { location });
    res.end();
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function getFreePort() {
  const server = createHttpServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

async function waitForHealth(baseUrl, child, readStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check: ${child.exitCode}\n${readStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server health check timed out\n${readStderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]).catch(() => {});
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
