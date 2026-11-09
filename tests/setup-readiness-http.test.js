import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(projectRoot, "src", "server.js");

test("首次运行就绪度有独立端点，且不把未配置的部署报成就绪", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-setup-readiness-"));
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
      SFSC_ENROLLMENT_BOOTSTRAP_PORT: "0",
      // 服务端默认对缺失管理 token fail-closed；本测试不验证鉴权，显式退出该门槛。
      SFSC_ALLOW_NO_ADMIN_TOKEN: "1",
      // 指向一个必定连不上的存储端点：这就是「全新部署，MinIO 还没起来」。
      S3_ENDPOINT: `http://127.0.0.1:${await getFreePort()}`
    }
  });
  const startupOutput = [];
  child.stderr.on("data", chunk => startupOutput.push(String(chunk)));

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

  await waitForHealth(baseUrl, child, () => startupOutput.join(""));

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const apiHealth = await healthResponse.json();
  assert.equal(apiHealth.ok, true, "the console API health lamp must not depend on MinIO availability");
  assert.equal(apiHealth.serviceHealth.ok, true);

  const response = await fetch(`${baseUrl}/api/admin/setup`);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.deepEqual(Object.keys(payload).sort(), ["complete", "currentStepId", "enrollmentRevocations", "steps"]);
  assert.deepEqual(payload.enrollmentRevocations, { ready: true, pendingRecovery: false });
  assert.deepEqual(payload.steps.map((step) => step.id), ["directory", "repair", "pairing"]);

  // MinIO 未启动不再阻塞普通目录首用；没有已验证目录时仍必须保持未完成。
  assert.equal(payload.complete, false);
  assert.equal(payload.currentStepId, "directory");

  const byId = Object.fromEntries(payload.steps.map((step) => [step.id, step]));
  assert.equal(byId.directory.evidence.directoryEvidenceAvailable, true);
  assert.equal(byId.directory.evidence.activeRootCount, 0);
  assert.equal(byId.repair.ready, false);
  assert.equal(byId.repair.evidence.configDigestAvailable, false);
  assert.equal(byId.pairing.ready, false);

  // 响应不得夹带凭据：就绪度是给界面点灯用的，不该成为一条泄露通道。
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /change-this-minio-root-password/);
  assert.doesNotMatch(serialized, /secretAccessKey/);
});

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(baseUrl, child, getStartupOutput = () => "") {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check: ${child.exitCode}\n${getStartupOutput()}`);
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
