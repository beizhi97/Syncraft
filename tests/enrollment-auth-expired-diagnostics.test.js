import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { buildDiagnosticBundle } from "../client/src/diagnosticBundle.js";
import {
  createEnrollmentDiagnosticError,
  isEnrollmentDiagnosticError,
  normalizeEnrollmentDiagnosticError,
  runEnrollmentRefreshWithDiagnostics
} from "../client/src/enrollmentDiagnostics.js";
import { assertClientEnrollmentStatusContract, assertDiagnosticBundleContract } from "../scripts/lib/runtimeContracts.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("enrollment refresh failure wrapper persists a strict safe error through status and diagnostic export", async () => {
  const recordedAt = "2026-11-04T20:15:30.123Z";
  const serverState = { dataAuthorizations: { keep: { payload: "previously-verified" } } };
  let persisted = null;
  const failure = Object.assign(new Error("raw request and signed envelope must not persist"), {
    code: "enrollment_auth_expired",
    rawRequest: "RAW_REQUEST_SECRET",
    signedEnvelope: "SIGNED_ENVELOPE_SECRET"
  });

  await assert.rejects(runEnrollmentRefreshWithDiagnostics(
    serverState,
    async () => { throw failure; },
    async () => { persisted = structuredClone(serverState); },
    { now: Date.parse(recordedAt), onFailure: () => {} }
  ), error => error === failure);

  assert.deepEqual(persisted, {
    dataAuthorizations: { keep: { payload: "previously-verified" } },
    lastEnrollmentError: { code: "enrollment_auth_expired", recordedAt }
  });
  const lastError = normalizeEnrollmentDiagnosticError(persisted.lastEnrollmentError);
  const enrollmentStatus = {
    phase: "identity-verified-awaiting-directory-authorization",
    serverId: "",
    signingKeyId: "",
    serverKeyFingerprint: "",
    deviceId: "",
    requestId: "",
    status: "",
    directoryAuthorization: "waiting",
    authorizedDirectories: [],
    lastError
  };
  assertClientEnrollmentStatusContract(enrollmentStatus);

  const bundle = buildDiagnosticBundle({
    generatedAt: recordedAt,
    status: { enrollment: enrollmentStatus },
    logs: {
      electron: { exists: true, maxChars: 1000, modifiedAt: recordedAt, path: "electron-main.log", size: 72, text: "secret_access_key RAW_REQUEST_SECRET\nAWS_SECRET_ACCESS_KEY=SIGNED_ENVELOPE_SECRET", truncated: false },
      singbox: { exists: false, maxChars: 1000, modifiedAt: null, path: "sing-box.log", size: 0, text: "", truncated: false },
      rclone: { exists: false, maxChars: 1000, modifiedAt: null, path: "rclone.log", size: 0, text: "", truncated: false }
    }
  });
  assertDiagnosticBundleContract(bundle, "diagnosticBundle", { strictEnvironment: false });
  assert.deepEqual(bundle.status.enrollment, { lastError: { code: "enrollment_auth_expired", recordedAt } });
  assert.deepEqual(bundle.status.enrollment.lastError, { code: "enrollment_auth_expired", recordedAt });
  assert.equal(JSON.stringify(bundle).includes("RAW_REQUEST_SECRET"), false);
  assert.equal(JSON.stringify(bundle).includes("SIGNED_ENVELOPE_SECRET"), false);
  assert.equal(JSON.stringify(bundle).includes("raw request and signed envelope"), false);
  assert.match(bundle.logs.electron.text, /secret_access_key \*\*\*\*/);
  assert.match(bundle.logs.electron.text, /AWS_SECRET_ACCESS_KEY=\*\*\*\*/);
  assert.doesNotMatch(bundle.logs.electron.text, /RAW_REQUEST_SECRET/);
  assert.doesNotMatch(bundle.logs.electron.text, /SIGNED_ENVELOPE_SECRET/);
});

test("enrollment diagnostics reject unknown codes, extra secret fields, and noncanonical timestamps", () => {
  const valid = createEnrollmentDiagnosticError({ code: "enrollment_auth_expired" }, Date.parse("2026-11-04T20:15:30.123Z"));
  assert.deepEqual(valid, { code: "enrollment_auth_expired", recordedAt: "2026-11-04T20:15:30.123Z" });
  assert.equal(isEnrollmentDiagnosticError(valid), true);
  assert.equal(isEnrollmentDiagnosticError({ ...valid, code: "enrollment_secret_payload" }), false);
  assert.equal(isEnrollmentDiagnosticError({ ...valid, signedEnvelope: "SECRET" }), false);
  assert.equal(isEnrollmentDiagnosticError({ ...valid, recordedAt: "2026-11-04T20:15:30Z" }), false);
  assert.equal(createEnrollmentDiagnosticError({ code: "mystery_error" }), null);
});

test("successful enrollment refresh clears and persists the previous diagnostic error", async () => {
  const serverState = {
    lastEnrollmentError: { code: "enrollment_auth_expired", recordedAt: "2026-11-04T20:15:30.123Z" }
  };
  let persisted = null;
  const result = await runEnrollmentRefreshWithDiagnostics(
    serverState,
    async () => ({ authorizedDirectories: [] }),
    async () => { persisted = structuredClone(serverState); }
  );
  assert.deepEqual(result, { authorizedDirectories: [] });
  assert.equal(Object.hasOwn(serverState, "lastEnrollmentError"), false);
  assert.deepEqual(persisted, {});
});

test("refresh UI uses stable enrollment guidance and both consoles identify a possible clock difference", async () => {
  const clientApp = await readFile(new URL("../client/public/app.js", import.meta.url), "utf8");
  const serverApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const clientServer = await readFile(new URL("../client/src/clientServer.js", import.meta.url), "utf8");
  const guidance = "服务器与电脑的系统时间可能存在较大差异。请先检查本机 Windows 日期、时间和时区，并尝试立即同步；若本机时间正确，再请管理员检查服务器时间。无需重新配对、重新导入通道码或重新签发身份验证码。";

  assert.match(clientApp, /catch \(error\) \{\s*setEnrollmentMessage\(formatError\(error\) \|\| "目录授权检查失败。", true\);/);
  assert.ok(clientApp.includes(`enrollment_auth_expired: "${guidance}"`));
  assert.ok(serverApp.includes(`enrollment_auth_expired: "${guidance}"`));
  assert.match(clientServer, /runEnrollmentRefreshWithDiagnostics\(serverState/);
  assert.match(clientServer, /lastError = normalizeEnrollmentDiagnosticError\(server\?\.lastEnrollmentError\)/);
  assert.match(clientServer, /status: \{ \.\.\.\(await buildStatus\(\)\), enrollment: await enrollmentStatus\(\) \}/);

  const formatError = runInNewContext(`(${extractFunction(clientApp, "formatError")})`);
  const refreshContext = {
    $(id) { return id === "refreshDirectoryAuthorizationsBtn" ? { disabled: false } : {}; },
    clientApi: {
      async refreshDataAuthorizations() {
        throw Object.assign(new Error("Server denied the authorized directory request"), { code: "enrollment_auth_expired" });
      }
    },
    latestStatus: null,
    renderEnrollmentStatus() {},
    setEnrollmentMessage(message, isError) { refreshContext.message = message; refreshContext.isError = isError; },
    setAction() {},
    formatError
  };
  await runInNewContext(`(${extractFunction(clientApp, "refreshDirectoryAuthorizations")})()`, refreshContext);
  assert.equal(refreshContext.message, guidance);
  assert.equal(refreshContext.isError, true);
});

function extractFunction(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `expected ${name} function`);
  const start = match.index;
  const openBrace = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`expected ${name} to close`);
}
