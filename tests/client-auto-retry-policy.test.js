import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

function functionSource(name) {
  const start = clientServer.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const parenStart = clientServer.indexOf("(", start);
  let parenDepth = 0;
  let signatureEnd = -1;
  for (let index = parenStart; index < clientServer.length; index += 1) {
    if (clientServer[index] === "(") parenDepth += 1;
    if (clientServer[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnd = index;
        break;
      }
    }
  }
  assert.notEqual(signatureEnd, -1, `${name} has a complete signature`);
  const open = clientServer.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = open; index < clientServer.length; index += 1) {
    if (clientServer[index] === "{") depth += 1;
    if (clientServer[index] === "}") {
      depth -= 1;
      if (depth === 0) return clientServer.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has a closing brace`);
}

function policyRegex(name) {
  const body = functionSource(name);
  const match = body.match(/return\s+\/(.*)\/([a-z]*)\.test\(/s);
  assert.ok(match, `${name} returns a regular-expression policy`);
  return new RegExp(match[1].replaceAll("\\/", "/"), match[2]);
}

test("automatic data-tunnel retry classifies transient network failures and rejects authorization/root failures", () => {
  const transient = policyRegex("isTransientTunnelDisconnect");
  for (const text of [
    "connection reset by peer",
    "dial tcp 10.0.0.1:22: i/o timeout",
    "TLS handshake timeout",
    "temporary failure in name resolution"
  ]) assert.match(text, transient);

  const nonRetryable = policyRegex("isNonRetryableDataRootFailure");
  for (const text of [
    "directory root missing",
    "sftp_access_marker_mismatch",
    "permission denied",
    "authentication failed",
    "host key verification failed",
    "revoked authorization"
  ]) assert.match(text, nonRetryable);
  assert.doesNotMatch("connection reset by peer", nonRetryable);
});

test("automatic retry is bounded to three fresh attempts and regenerates its safety plan", () => {
  const runSync = functionSource("runSync");
  const runSyncAfterAdmission = functionSource("runSyncAfterAdmission");
  const retryCallbackStart = clientServer.indexOf("onExit: async (exit) =>");
  assert.notEqual(retryCallbackStart, -1);
  const retryCallback = clientServer.slice(retryCallbackStart, retryCallbackStart + 4800);

  assert.match(retryCallback, /retryAttempt\s*<\s*3/);
  assert.match(retryCallback, /const attempt = retryAttempt \+ 1/);
  assert.match(retryCallback, /automaticRetryAttempt:\s*attempt/);
  assert.match(retryCallback, /!userRequestedStop/);
  assert.match(retryCallback, /ownTunnelExited/);
  assert.match(retryCallback, /options\.trigger === "scheduler"/);
  assert.match(retryCallback, /isNonRetryableDataRootFailure\(recentFailureLog\)/);

  assert.match(runSync, /runSyncAfterAdmission\(job, options, requestFingerprint\)/);
  assert.match(runSyncAfterAdmission, /buildSyncRunPlan\(job\)/);
  assert.match(runSyncAfterAdmission, /options\.automaticRetryAttempt\s*>\s*0/);
  assert.match(runSyncAfterAdmission, /createSyncSafetyPlan\(runPlan\.normalizedJob\)/);
  assert.match(runSyncAfterAdmission, /requireSyncSafetyPlan\(/);
});

test("manual tunnel retry replaces the consumed manual safety plan before admission", async () => {
  assert.match(clientServer, /runSync\(body\.job \|\| \{\}, \{ trigger: "manual", safetyPlanId: body\.safetyPlanId \}\)/,
    "the external manual route must not accept an automaticRetryAttempt override");
  const consumedPlans = new Set();
  const createdPlanIds = [];
  let runCount = 0;
  let nextSafetyPlan = { deletions: { allowed: true }, bidirectional: { initializationRequired: false } };
  const context = {
    ensureLocalStateWritable: async () => {},
    buildSyncRunPlan: async (job) => ({ normalizedJob: job }),
    requiresSyncSafetyPlan: () => true,
    requireSyncSafetyPlan: async ({ safetyPlanId }) => {
      if (!safetyPlanId || consumedPlans.has(safetyPlanId)) {
        throw Object.assign(new Error("The sync safety plan is missing or already consumed."), { code: "danger_confirmation_required" });
      }
      consumedPlans.add(safetyPlanId);
    },
    createSyncSafetyPlan: async () => {
      const id = `fresh-plan-${createdPlanIds.length + 1}`;
      createdPlanIds.push(id);
      return { id, ...nextSafetyPlan };
    },
    syncJobFingerprint: () => "same-job",
    currentStoppingSyncReplay: () => null,
    syncProcess: { isRunning: () => false },
    runSyncExclusive: async () => ({ started: ++runCount }),
    createHttpError: (code, status, message) => Object.assign(new Error(message), { code, status }),
    syncRunInFlightJobFingerprint: "",
    activeSyncRequestFingerprint: "",
    activeSyncRequestJob: null,
    stoppingSyncReplay: null,
    syncRunInFlight: null
  };
  vm.createContext(context);
  vm.runInContext(`async ${functionSource("runSyncAfterAdmission")}; this.runSyncAfterAdmission = runSyncAfterAdmission;`, context);

  const job = { id: "job-1", direction: "bidirectional", schedule: { mode: "manual" } };
  const options = { trigger: "manual", safetyPlanId: "user-approved-plan" };
  await context.runSyncAfterAdmission(job, options, "request-fingerprint");
  assert.ok(consumedPlans.has(options.safetyPlanId));

  const retry = await context.runSyncAfterAdmission(job, { ...options, automaticRetryAttempt: 1 }, "request-fingerprint");
  assert.deepEqual({ ...retry }, { started: 2 });
  assert.deepEqual(createdPlanIds, ["fresh-plan-1"]);
  assert.ok(consumedPlans.has("fresh-plan-1"));
  assert.equal(runCount, 2);

  await assert.rejects(
    context.runSyncAfterAdmission(job, options, "request-fingerprint"),
    { code: "danger_confirmation_required" },
    "an external manual retry with a missing or consumed plan must still require confirmation"
  );
  assert.equal(createdPlanIds.length, 1, "manual admission must not silently replace its user's plan");
  assert.equal(runCount, 2);

  nextSafetyPlan = { deletions: { allowed: false }, bidirectional: { initializationRequired: false } };
  await assert.rejects(
    context.runSyncAfterAdmission(job, { ...options, automaticRetryAttempt: 2 }, "request-fingerprint"),
    { code: "danger_confirmation_required" },
    "an automatic retry must stop when the fresh plan exceeds the deletion threshold"
  );
  assert.equal(createdPlanIds.length, 2);
  assert.ok(!consumedPlans.has("fresh-plan-2"), "the rejected fresh plan must not be consumed");
  assert.equal(runCount, 2, "a deletion-risk plan must not start rclone");

  nextSafetyPlan = { deletions: { allowed: true }, bidirectional: { initializationRequired: true } };
  await assert.rejects(
    context.runSyncAfterAdmission(job, { ...options, automaticRetryAttempt: 3 }, "request-fingerprint"),
    { code: "danger_confirmation_required" },
    "an automatic retry must stop when the fresh plan requires bidirectional initialization"
  );
  assert.equal(createdPlanIds.length, 3);
  assert.ok(!consumedPlans.has("fresh-plan-3"), "the initialization-required plan must not be consumed");
  assert.equal(runCount, 2, "an uninitialized bidirectional baseline must not start rclone");
});
