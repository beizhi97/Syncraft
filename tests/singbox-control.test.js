import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestSingboxRestart } from "../src/core/singboxControl.js";

const EXPECTED_CONFIG_SHA256 = "a".repeat(64);

test("sing-box restart control waits for the supervisor result", async (t) => {
  const controlDir = await mkdtemp(join(tmpdir(), "sfsc-singbox-control-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));

  const supervisor = emulateSupervisor(controlDir, { ok: true, message: "restarted" });
  const result = await requestSingboxRestart({ controlDir, expectedConfigSha256: EXPECTED_CONFIG_SHA256, timeoutMs: 2000, pollIntervalMs: 10 });
  await supervisor;

  assert.equal(result.ok, true);
  assert.equal(result.message, "restarted");
  assert.equal(result.configSha256, EXPECTED_CONFIG_SHA256);
});

test("sing-box restart control surfaces supervisor failures", async (t) => {
  const controlDir = await mkdtemp(join(tmpdir(), "sfsc-singbox-control-failure-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));

  const supervisor = emulateSupervisor(controlDir, { ok: false, errorCode: "singbox_config_invalid", message: "config check failed" });
  await assert.rejects(
    requestSingboxRestart({ controlDir, expectedConfigSha256: EXPECTED_CONFIG_SHA256, timeoutMs: 2000, pollIntervalMs: 10 }),
    (error) => error?.code === "singbox_restart_failed" && /config check failed/.test(error.publicMessage)
  );
  await supervisor;
});

test("sing-box restart control fails closed when no supervisor responds", async (t) => {
  const controlDir = await mkdtemp(join(tmpdir(), "sfsc-singbox-control-timeout-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));

  await assert.rejects(
    requestSingboxRestart({ controlDir, expectedConfigSha256: EXPECTED_CONFIG_SHA256, timeoutMs: 40, pollIntervalMs: 10 }),
    (error) => error?.code === "singbox_restart_timeout"
  );
});

test("sing-box restart control rejects missing or mismatched config hashes", async (t) => {
  const controlDir = await mkdtemp(join(tmpdir(), "sfsc-singbox-control-hash-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));

  await assert.rejects(
    requestSingboxRestart({ controlDir }),
    (error) => error?.code === "singbox_restart_unavailable"
  );

  const supervisor = emulateSupervisor(controlDir, {
    ok: true,
    configSha256: "b".repeat(64),
    message: "wrong config"
  });
  await assert.rejects(
    requestSingboxRestart({ controlDir, expectedConfigSha256: EXPECTED_CONFIG_SHA256, timeoutMs: 2000, pollIntervalMs: 10 }),
    (error) => error?.code === "singbox_restart_failed" && /unexpected config version/.test(error.publicMessage)
  );
  await supervisor;
});

async function emulateSupervisor(controlDir, result) {
  let requestName = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    requestName = (await readdir(controlDir)).find((name) => name.startsWith("restart-request-")) || "";
    if (requestName) break;
    await delay(5);
  }
  assert.ok(requestName, "restart request should be written for the supervisor");
  const request = JSON.parse(await readFile(join(controlDir, requestName), "utf8"));
  const resultPath = join(controlDir, `restart-result-${request.requestId}.json`);
  const resultTempPath = `${resultPath}.tmp`;
  await writeFile(resultTempPath, JSON.stringify({
    requestId: request.requestId,
    ...result,
    configSha256: result.configSha256 || request.expectedConfigSha256
  }), "utf8");
  await rename(resultTempPath, resultPath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
