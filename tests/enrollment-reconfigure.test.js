import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnrollmentReconfigureService } from "../src/service/enrollmentReconfigure.js";

const operationId = "op_0123456789abcdef0123456789abcdef";
const bootstrapSnapshot = {
  kind: "sfsc-enrollment-bootstrap-registry",
  version: 1,
  bootstrapUuid: "10000000-0000-4000-8000-000000000001",
  channelRevision: "chrev_0123456789abcdef",
  channelFingerprint: "a".repeat(64),
  applied: null
};

function fixture(journalDir, options = {}) {
  let tunnel = {
    id: "vless-1",
    protocol: "vless-tcp-none",
    listenHost: "0.0.0.0",
    listenPort: 45678,
    publicHost: "old.example.test",
    publicPort: 45678,
    security: "none",
    transport: "tcp",
    transportPath: "",
    reality: {},
    restartRequired: false,
    lastAppliedAt: "2026-10-29T11:00:00.000Z"
  };
  const encodeConfig = value => Buffer.from(JSON.stringify({ publicHost: value.publicHost, publicPort: value.publicPort }));
  let configBytes = encodeConfig(tunnel);
  const beforeConfig = Buffer.from(configBytes);
  let restartCalls = 0;
  let issueCalls = 0;
  let verifyCalls = 0;
  const issuanceOrder = [];
  let restoreCalls = 0;
  let resolveRestart;
  let restartStarted;
  const didStartRestart = new Promise(resolve => { restartStarted = resolve; });
  let clock = Date.parse("2026-10-29T12:00:00.000Z");
  const service = createEnrollmentReconfigureService({
    journalDir,
    getTunnel: async () => tunnel,
    setTunnel: async value => { tunnel = structuredClone(value); },
    readConfig: async () => Buffer.from(configBytes),
    writeConfig: async () => { configBytes = encodeConfig(tunnel); },
    restoreConfig: async bytes => { configBytes = Buffer.from(bytes); },
    saveAdminState: async () => {},
    requestRestart: async configSha256 => {
      restartCalls += 1;
      restartStarted();
      if (options.blockRestart && restartCalls === 1) {
        await new Promise(resolve => { resolveRestart = resolve; });
      }
      if (options.failFirstRestart && restartCalls === 1) throw Object.assign(new Error("supervisor failed"), { code: "singbox_restart_failed" });
      return { ok: true, configSha256, restartedAt: new Date(clock).toISOString() };
    },
    markDataApplied: async () => {},
    markBootstrapApplied: async () => {},
    markSingboxApplied: async () => { tunnel = { ...tunnel, restartRequired: false, lastAppliedAt: new Date(clock).toISOString() }; },
    verifyTransport: options.verifyTransport ? async input => {
      verifyCalls += 1;
      issuanceOrder.push("verify");
      return options.verifyTransport(input);
    } : undefined,
    issueCode: async ({ issuedAt, expiresAt, onIssued }) => {
      issueCalls += 1;
      issuanceOrder.push("issue");
      if (options.failJournalAfterApply) {
        await rm(journalDir, { recursive: true, force: true });
        await writeFile(journalDir, "journal unavailable", "utf8");
        throw Object.assign(new Error("issuer unavailable"), { code: "issuer_unavailable" });
      }
      const result = { wrappedCode: `wrapped:${issuedAt}:${expiresAt}`, channelRevision: "chrev_0123456789abcdef", expiresAt };
      await onIssued(result);
      return result;
    },
    snapshotBootstrap: async () => structuredClone(bootstrapSnapshot),
    restoreBootstrap: async snapshot => { restoreCalls += 1; assert.deepEqual(snapshot, bootstrapSnapshot); },
    isCurrentConfigApplied: async (currentTunnel, bytes) => currentTunnel.id === "vless-1" && bytes !== null,
    makeTargetTunnel: async (currentTunnel, input) => ({
      ...currentTunnel,
      publicHost: input.publicHost ?? currentTunnel.publicHost,
      publicPort: input.publicPort ?? currentTunnel.publicPort,
      restartRequired: true
    }),
    summarizeState: async () => ({ tunnel: { publicHost: tunnel.publicHost, publicPort: tunnel.publicPort } }),
    now: () => clock
  });
  return {
    service,
    get tunnel() { return tunnel; },
    get configBytes() { return Buffer.from(configBytes); },
    beforeConfig,
    get restartCalls() { return restartCalls; },
    get issueCalls() { return issueCalls; },
    get verifyCalls() { return verifyCalls; },
    issuanceOrder,
    get restoreCalls() { return restoreCalls; },
    didStartRestart,
    releaseRestart() { resolveRestart?.(); },
    advanceClock(value) { clock = value; }
  };
}

async function withJournal(task, prefix = "sfsc-reconfigure-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const journalDir = join(root, "operations");
  try { await task(journalDir); } finally { await rm(root, { recursive: true, force: true }); }
}

test("reconfiguration persists the wrapped code before returning and replays the same terminal result", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir);
    const request = { operationId, publicHost: "new.example.test", publicPort: 45679 };
    const completed = await state.service.run(request);
    assert.equal(completed.stage, "complete");
    const journal = JSON.parse(await readFile(join(journalDir, `${operationId}.json`), "utf8"));
    assert.equal(completed.wrappedCode, `wrapped:${journal.issuedAt}:${completed.expiresAt}`);
    assert.equal((await state.service.get(operationId)).wrappedCode, completed.wrappedCode);
    assert.deepEqual(await state.service.run(request), completed);
    assert.equal(state.restartCalls, 1);
    assert.equal(state.issueCalls, 1);
    const journalPath = join(journalDir, `${operationId}.json`);
    assert.equal((await readFile(journalPath, "utf8")).includes(completed.wrappedCode), true);
    if (process.platform !== "win32") assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  });
});

test("GET returns a persisted in-progress stage while the supervisor restart is pending", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir, { blockRestart: true });
    const pending = state.service.run({ operationId, publicHost: "new.example.test" });
    await state.didStartRestart;
    const status = await state.service.get(operationId);
    assert.equal(status.stage, "restarting");
    state.releaseRestart();
    assert.equal((await pending).stage, "complete");
  });
});

test("candidate restart failure restores exact config bytes before reporting rollback", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir, { failFirstRestart: true });
    const result = await state.service.run({ operationId, publicHost: "new.example.test" });
    assert.equal(result.stage, "rolled-back");
    assert.equal(result.errorCode, "singbox_restart_failed");
    assert.deepEqual(state.configBytes, state.beforeConfig);
    assert.equal(state.tunnel.publicHost, "old.example.test");
    assert.equal(state.tunnel.restartRequired, false);
    assert.equal(state.restoreCalls, 1);
    assert.equal(state.issueCalls, 0);
    assert.equal((await state.service.get(operationId)).wrappedCode, undefined);
  });
});

test("REALITY transport verification runs before issuance and failure uses the existing rollback", async () => {
  await withJournal(async journalDir => {
    let verifyCalls = 0;
    const state = fixture(journalDir, {
      verifyTransport: async () => {
        verifyCalls += 1;
        throw Object.assign(new Error("probe failed"), { code: "enrollment_channel_not_ready" });
      }
    });
    const result = await state.service.run({ operationId, publicHost: "new.example.test" });
    assert.equal(verifyCalls, 1);
    assert.equal(result.stage, "rolled-back");
    assert.equal(result.errorCode, "enrollment_channel_not_ready");
    assert.equal(state.issueCalls, 0);
    assert.deepEqual(state.configBytes, state.beforeConfig);
    assert.equal(state.tunnel.publicHost, "old.example.test");
    assert.equal(state.restoreCalls, 1);
  });
});

test("successful REALITY transport verification precedes channel issuance", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir, { verifyTransport: async () => {} });
    const result = await state.service.run({ operationId, publicHost: "new.example.test" });
    assert.equal(result.stage, "complete");
    assert.equal(state.verifyCalls, 1);
    assert.equal(state.issueCalls, 1);
    assert.deepEqual(state.issuanceOrder, ["verify", "issue"]);
  });
});

test("operation ID validation is enforced at the service boundary", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir);
    await assert.rejects(
      state.service.run({ operationId: "op_..\\escape", publicHost: "new.example.test" }),
      error => error.code === "enrollment_reconfigure_invalid"
    );
  });
});

test("journal failure after config apply preserves the applied tunnel for repair", async () => {
  await withJournal(async journalDir => {
    const state = fixture(journalDir, { failJournalAfterApply: true });
    await assert.rejects(state.service.run({ operationId, publicHost: "new.example.test" }));
    assert.equal(state.tunnel.publicHost, "new.example.test");
    assert.equal(state.tunnel.restartRequired, false);
    assert.deepEqual(state.configBytes, Buffer.from(JSON.stringify({ publicHost: "new.example.test", publicPort: 45678 })));
    assert.equal(state.restartCalls, 1);
    assert.equal(state.issueCalls, 1);
    assert.equal(state.restoreCalls, 0);
  });
});

test("HTTP reconfigure remains serialized but bypasses generic admin snapshot rollback", async () => {
  const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const rollback = serverSource.match(/function shouldRollbackAdminStateOnError\(req, url\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const serialize = serverSource.match(/function shouldSerializeAdminStateWrite\(req, url\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(rollback, /\/api\/admin\/enrollment\/v1\/reconfigure/);
  assert.match(rollback, /return false/);
  assert.match(serialize, /\/api\/admin\/enrollment\/v1\/reconfigure/);
  assert.match(serialize, /return true/);
});
