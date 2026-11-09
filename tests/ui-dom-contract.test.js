import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("production UI pages keep the design DOM contract executable", async () => {
  const pages = [
    {
      name: "client",
      htmlPath: join(projectRoot, "client", "public", "index.html"),
      appPath: join(projectRoot, "client", "public", "app.js"),
      refPattern: /\$\("([^"]+)"\)/g,
      requiredIds: [
        "scheduleIntervalRow",
        "scheduleTimeRow",
        "bandwidthScheduleRow",
        "settingsScrim",
        "settingsPanel",
        "confirmGate"
      ]
    },
    {
      name: "server",
      htmlPath: join(projectRoot, "public", "index.html"),
      appPath: join(projectRoot, "public", "app.js"),
      refPattern: /byId\("([^"]+)"\)/g,
      requiredIds: [
        "authGate",
        "confirmGate",
        "claimOut",
        "refreshSingboxConfigBtn",
        "tunnelOut",
        "statDirectoryValue",
        "statDirectorySub",
        "statOnlineDevicesValue",
        "statOnlineDevicesSub",
        "statSyncingValue",
        "statSyncingSub",
        "statAuthorizedRelationValue",
        "statAuthorizedRelationSub",
        "enrollmentRelationList",
        "firstUsePublicHost",
        "firstUsePublicPort"
      ]
    }
  ];

  for (const page of pages) {
    const html = await readFile(page.htmlPath, "utf8");
    const app = await readFile(page.appPath, "utf8");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const idSet = new Set(ids);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index).sort();
    const refs = [...app.matchAll(page.refPattern)].map((match) => match[1]);
    const missingRefs = [...new Set(refs)].filter((id) => !idSet.has(id)).sort();
    const missingRequired = page.requiredIds.filter((id) => !idSet.has(id));

    assert.deepEqual(duplicates, [], `${page.name} HTML should not duplicate ids`);
    assert.deepEqual(missingRefs, [], `${page.name} app.js should only reference existing ids`);
    assert.deepEqual(missingRequired, [], `${page.name} HTML should include required design ids`);
    assert.equal(html.includes("wf-bar"), false, `${page.name} production HTML should not include wireframe controls`);
  assert.equal(/<script(?! src=)/.test(html), false, `${page.name} production HTML should not include inline prototype scripts`);
    const inlineHandlers = [...html.matchAll(/<[^>]+\s(on[a-z][\w:-]*)\s*=/gi)].map((match) => match[1]).sort();
    assert.deepEqual(inlineHandlers, [], `${page.name} production HTML should not include inline on* handlers`);
  }
});

test("server enrollment authorization UI distinguishes relation and device revocation", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(html, /id="enrollmentRelationList"/);
  assert.match(app, /撤销此目录授权/);
  assert.match(app, /revokeDevice\.textContent = "撤销设备授权"/);
  assert.match(app, /retry\.textContent = "继续"/);
  assert.match(app, /授权已撤销，相关传输已停止/);
  assert.match(app, /授权已停用，正在停止传输；可点击继续/);
  const revocationUi = app.slice(app.indexOf("async function loadEnrollmentRelations()"), app.indexOf("async function loadEnrollmentRequests()"));
  assert.doesNotMatch(revocationUi, /enrollment device|VLESS 停用|operation ID|配置回执|已持久化|收敛/i);
});

test("server claim output remains writable by production app.js", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");

  assert.match(html, /<textarea[^>]*id="claimOut"[^>]*readonly/);
  assert.doesNotMatch(html, /<div[^>]*id="claimOut"/);
});

test("server SyncKey copy works without the secure-context Clipboard API and stale keys are cleared", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(app, /async function copyText\(value\)/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(app, /async function copyClaim\(\)[\s\S]*?await copyText\(value\)/);
  assert.match(app, /async function createClaim\(\)[\s\S]*?clearClaimResult\(\)[\s\S]*?runAction/);
  assert.match(app, /function clearClaimResult\(\)[\s\S]*?byId\("profileOut"\)\.textContent = "等待新的 SyncKey 生成结果\.\.\."/);
});

test("client import errors stay above the settings drawer", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const css = await readFile(join(projectRoot, "client", "public", "styles.css"), "utf8");

  assert.match(html, /id="actionMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /#actionMessage\{[^}]*position:fixed[^}]*z-index:2[1-9]\d/);
});

test("enrollment timestamp expiry explains clock correction without re-pairing", async () => {
  const authority = await readFile(join(projectRoot, "src", "core", "enrollmentAuthority.js"), "utf8");
  const clientApp = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const serverApp = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const guidance = "服务器与电脑的系统时间可能存在较大差异。请先检查本机 Windows 日期、时间和时区，并尝试立即同步；若本机时间正确，再请管理员检查服务器时间。无需重新配对、重新导入通道码或重新签发身份验证码。";

  assert.match(authority, /enrollment_auth_expired[\s\S]*Authorization request timestamp is outside the allowed window/);
  assert.ok(clientApp.includes(`enrollment_auth_expired: "${guidance}"`));
  assert.ok(serverApp.includes(`enrollment_auth_expired: "${guidance}"`));
});

test("client first-use and recovery UI follows the current no-overwrite contracts", async () => {
  const html = await readFile(join(projectRoot, "client", "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const restoreRecoveryFile = extractFunction(app, "restoreRecoveryFile");
  const formatRecoveryExpiry = extractFunction(app, "formatRecoveryExpiry");
  const renderEnrollmentSteps = extractFunction(app, "renderEnrollmentSteps");
  const renderHeartbeat = extractFunction(app, "renderHeartbeat");
  const resumeFirstBisyncConflictOperation = extractFunction(app, "resumeFirstBisyncConflictOperation");
  const readConfirmedJob = extractFunction(app, "readConfirmedJob");
  const hasAutomaticScheduleChanged = extractFunction(app, "hasAutomaticScheduleChanged");
  const scheduleFingerprint = extractFunction(app, "scheduleFingerprint");
  const advanced = extractDetailsById(html, "advancedDiagnostics");

  for (const id of ["recoveryPanel", "recoveryVersions", "recoveryStatus", "refreshRecoveryBtn", "firstBisyncRecoveryPanel", "firstBisyncOperations", "firstBisyncRecoveryStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /导入通道配置码[\s\S]*提交身份申请[\s\S]*身份验证码/);
  assert.match(html, /高级兼容：旧版 SyncKey/);
  assert.match(html, /已有文件不会被覆盖/);
  assert.doesNotMatch(advanced.slice(0, advanced.indexOf("安装与文件校验")), /id="(?:protocolCompatibility|secretVaultStatus|previewBtn|syncHistoryList|logOutput)"/);
  for (const id of ["protocolCompatibility", "secretVaultStatus", "startTunnelBtn", "previewBtn", "syncHistoryList", "logOutput"]) {
    assert.match(advanced, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="heartbeatStatus"[^>]*>\s*<span class="dot"><\/span>心跳不适用/);
  assert.match(html, /<label id="syncSpaceLabel">同步空间<\/label>/);
  assert.match(app, /\$\("syncSpaceLabel"\)\.textContent = "服务器文件夹"/);
  assert.match(app, /action === "save" && job\.schedule\?\.mode !== "manual" && hasAutomaticScheduleChanged\(job\)/);
  assert.doesNotMatch(readConfirmedJob, /requiredText:\s*"授权自动同步"/);
  assert.match(app, /function renderEnrollmentStatus\([\s\S]*?renderEnrollmentSteps\(phase\)/);
  const advancedStart = html.indexOf('id="advancedSettingsContent"');
  const advancedEnd = html.indexOf('id="saveJobBtn"', advancedStart);
  assert.ok(advancedStart >= 0 && advancedEnd > advancedStart);
  assert.ok(html.indexOf('id="destructiveSync"') > advancedStart && html.indexOf('id="destructiveSync"') < advancedEnd);
  assert.ok(html.indexOf('id="bisyncInitialMode"') > advancedStart && html.indexOf('id="bisyncInitialMode"') < advancedEnd);
  assert.match(app, /\/recovery\/restore-cancel/);
  assert.match(app, /path: "\/api\/sync\/bisync\/conflicts\/operations"/);
  assert.match(app, /path: "\/api\/sync\/bisync\/conflicts\/resume"/);

  async function confirmScheduleFor(action, savedSchedule, requestedSchedule) {
    const scheduleContext = { confirmations: [] };
    runInNewContext(`
      const currentJobDraft = { schedule: ${JSON.stringify(savedSchedule)} };
      function readJob() { return { direction: "bidirectional", destructiveSync: false, schedule: ${JSON.stringify(requestedSchedule)} }; }
      function currentSyncCompatibility() { return null; }
      function describeLocalSchedule(schedule) { return schedule.mode; }
      async function requestConfirmation(options) { confirmations.push(options); return true; }
      ${scheduleFingerprint}
      ${hasAutomaticScheduleChanged}
      ${readConfirmedJob}
      globalThis.confirm = () => readConfirmedJob(${JSON.stringify(action)});
    `, scheduleContext);
    await scheduleContext.confirm();
    return scheduleContext.confirmations;
  }
  assert.equal((await confirmScheduleFor("run", { mode: "interval", intervalMinutes: 30 }, { mode: "interval", intervalMinutes: 30 })).length, 0);
  assert.equal((await confirmScheduleFor("save", { mode: "interval", intervalMinutes: 30 }, { mode: "interval", intervalMinutes: 30 })).length, 0);
  assert.equal((await confirmScheduleFor("save", { mode: "interval", intervalMinutes: "30" }, { mode: "interval", intervalMinutes: 30 })).length, 0);
  const changedScheduleConfirmations = await confirmScheduleFor("save", { mode: "manual" }, { mode: "interval", intervalMinutes: 30 });
  assert.equal(changedScheduleConfirmations.length, 1);
  assert.equal(changedScheduleConfirmations[0].submitText, "确认并保存计划");
  assert.equal(changedScheduleConfirmations[0].requiredText, undefined);

  const context = { calls: [], confirmations: [], confirmed: false, status: { textContent: "" } };
  runInNewContext(`
    function $(id) { if (id !== "recoveryStatus") throw new Error("unexpected element " + id); return status; }
    function formatError(error) { return error.message; }
    async function refreshRecoveryVersions() { calls.push({ type: "refresh" }); }
    async function requestConfirmation(options) { confirmations.push(options); return confirmed; }
    const clientApi = {
      async previewRecoveryRestore(jobId, body) {
        calls.push({ type: "preview", jobId, body });
        return { previewId: "preview-1", destinationPath: "notes.txt.recovered-run-1234", sourceSha256: "a".repeat(64), expiresAt: "2026-10-31T12:00:00.000Z" };
      },
      async cancelRecoveryRestore(jobId, previewId) { calls.push({ type: "cancel", jobId, previewId }); },
      async restoreRecoveryVersion(jobId, previewId) {
        calls.push({ type: "restore", jobId, previewId });
        return { destinationPath: "notes.txt.recovered-run-1234", sourceSha256: "a".repeat(64) };
      }
    };
    ${formatRecoveryExpiry}
    ${restoreRecoveryFile}
    globalThis.restoreFile = (confirmedValue) => {
      confirmed = confirmedValue;
      return restoreRecoveryFile("job-1", { runId: "run-12345678" }, { side: "path1", path: "notes.txt" });
    };
  `, context);

  await context.restoreFile(false);
  assert.deepEqual(context.calls.map(({ type }) => type), ["preview", "cancel"]);
  assert.equal(context.calls[0].jobId, "job-1");
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[0].body)), {
    runId: "run-12345678", side: "path1", path: "notes.txt", destinationPath: "notes.txt.recovered-run-1234"
  });
  assert.match(context.confirmations[0].body, /目标文件已存在时系统会拒绝还原，不会覆盖/);
  assert.match(context.confirmations[0].body, /预览有效期至/);
  assert.equal(context.status.textContent, "已取消还原；本地文件未更改。");

  context.calls.length = 0;
  context.confirmations.length = 0;
  await context.restoreFile(true);
  assert.deepEqual(context.calls.map(({ type }) => type), ["preview", "restore", "refresh"]);
  assert.equal(context.calls[1].previewId, "preview-1");
  assert.match(context.status.textContent, /已还原到 notes\.txt\.recovered-run-1234/);

  const stepNodes = Array.from({ length: 3 }, () => ({
    classes: {}, attributes: {},
    classList: { toggle(name, enabled) { this.owner.classes[name] = enabled; }, owner: null },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  }));
  for (const node of stepNodes) node.classList.owner = node;
  const stepsContext = { stepNodes };
  runInNewContext(`
    const document = { querySelectorAll: () => stepNodes };
    ${renderEnrollmentSteps}
    globalThis.renderSteps = renderEnrollmentSteps;
  `, stepsContext);
  stepsContext.renderSteps("request-pending");
  const stepSnapshot = JSON.parse(JSON.stringify(stepNodes.map((node) => [node.classes.complete, node.classes.current, node.attributes["aria-current"] || ""])));
  assert.deepEqual(stepSnapshot, [
    [true, false, ""], [true, false, ""], [false, true, "step"]
  ]);

  const heartbeatContext = { rendered: [] };
  runInNewContext(`
    const health = {};
    function $(id) { if (id !== "heartbeatHealth") throw new Error("unexpected element " + id); return health; }
    function setPill(...args) { rendered.push(["pill", ...args]); }
    function setHealth(...args) { rendered.push(["health", ...args]); }
    ${renderHeartbeat}
    globalThis.renderStatus = renderHeartbeat;
    globalThis.getHealth = () => health;
  `, heartbeatContext);
  heartbeatContext.renderStatus(null, false);
  assert.deepEqual(JSON.parse(JSON.stringify(heartbeatContext.rendered)), [
    ["pill", "heartbeatStatus", "心跳不适用", ""]
  ]);
  assert.equal(heartbeatContext.getHealth().textContent, "— 服务端心跳 · 两码接入不使用旧心跳");
  assert.equal(heartbeatContext.getHealth().className, "health-card neutral");
  heartbeatContext.rendered.length = 0;
  heartbeatContext.renderStatus(null, null);
  assert.deepEqual(JSON.parse(JSON.stringify(heartbeatContext.rendered)), [
    ["pill", "heartbeatStatus", "未知", "unknown"],
    ["health", "heartbeatHealth", "服务端心跳", null, "客户端离线"]
  ]);

  const conflictContext = { calls: [], buttons: [{ disabled: false }], status: { textContent: "" } };
  runInNewContext(`
    let selectedFirstBisyncOperationId = "";
    function $(id) {
      if (id === "firstBisyncRecoveryStatus") return status;
      if (id === "firstBisyncOperations") return { querySelectorAll: () => buttons };
      throw new Error("unexpected element " + id);
    }
    function formatError(error) { return error.message; }
    const clientApi = {
      async resumeFirstBisyncConflictSave(body) {
        calls.push(body);
        return { operationId: body.operationId, status: "saved" };
      }
    };
    async function refreshFirstBisyncConflictOperations() { calls.push({ type: "refresh" }); }
    ${resumeFirstBisyncConflictOperation}
    globalThis.resumeConflict = (job, operation) => resumeFirstBisyncConflictOperation(job, operation);
    globalThis.selectedOperation = () => selectedFirstBisyncOperationId;
  `, conflictContext);
  await conflictContext.resumeConflict({ id: "job-9", relationId: "rel_123", direction: "bidirectional" }, {
    operationId: "operation-5", status: "saving"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(conflictContext.calls)), [
    { job: { id: "job-9", relationId: "rel_123", direction: "bidirectional" }, operationId: "operation-5" },
    { type: "refresh" }
  ]);
  assert.equal(conflictContext.selectedOperation(), "operation-5");
  assert.equal(conflictContext.status.textContent, "冲突双方版本已保存。点击“开始同步”确认后继续首次双向初始化。");
});

function extractDetailsById(html, id) {
  const start = html.indexOf(`<details id="${id}"`);
  assert.ok(start >= 0, `expected details element ${id}`);
  const tagPattern = /<details\b[^>]*>|<\/details>/g;
  tagPattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith("<details")) depth += 1;
    else depth -= 1;
    if (depth === 0) return html.slice(start, tagPattern.lastIndex);
  }
  assert.fail(`expected details element ${id} to close`);
}

test("server shell health and stat strip avoid stale optimistic status", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const renderStatStrip = extractFunction(app, "renderStatStrip");
  const checkHealth = extractFunction(app, "checkHealth");

  assert.match(html, /id="healthDot" class="health-dot warn"/);
  assert.match(html, /id="healthText">检测中/);
  assert.doesNotMatch(html, /id="healthDot" class="health-dot ok"/);
  for (const id of ["statDirectorySub", "statOnlineDevicesSub", "statSyncingSub", "statAuthorizedRelationSub"]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderStatStrip, new RegExp(`setStatText\\("${id}"`));
  }
  assert.match(checkHealth, /serviceHealth\.restartRequired/);
  assert.match(checkHealth, /classList\.remove\("ok", "good", "warn", "err"\)/);
  assert.match(checkHealth, /管理 API 可达 · 待重启/);
  assert.doesNotMatch(html, /id="statTunnelValue"|id="statStorageUsageValue"/);
  assert.match(renderStatStrip, /activeRootCount/);
  assert.match(renderStatStrip, /authorizedRelationCount/);
});

test("server first use applies generated REALITY settings before reconfiguration", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const firstUse = extractFunction(app, "reconfigureEnrollmentChannel");
  assert.match(firstUse, /protocol: "vless-reality-tcp"/);
  assert.match(firstUse, /api\("\/api\/admin\/singbox\/apply"/);
  assert.match(firstUse, /api\("\/api\/admin\/enrollment\/v1\/reconfigure"/);
  assert.ok(firstUse.indexOf("/api/admin/singbox/apply") < firstUse.indexOf("/api/admin/enrollment/v1/reconfigure"));
  assert.match(firstUse, /外部访问地址和 1–65535 之间的端口/);
});

test("server enrollment lists remain available without auth only when server auth is disabled", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const directories = extractFunction(app, "loadEnrollmentDirectories");
  const requests = extractFunction(app, "loadEnrollmentRequests");
  for (const body of [directories, requests]) {
    assert.match(body, /adminAuthEnabled && !adminToken/);
    assert.match(body, /api\("\/api\/admin\/enrollment\/v1\//);
    assert.doesNotMatch(body, /!adminToken\) return/);
  }
  assert.ok(requests.indexOf("/api/admin/enrollment/v1/directories") < requests.indexOf("/api/admin/enrollment/v1/requests"));
  assert.match(requests, /if \(!activeDirectories\.length\)/);
  assert.match(requests, /开放并验证服务器目录后，设备配对申请会显示在这里/);
});

test("server live refresh updates both device cards and top-level statistics", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const refreshLiveDevices = extractFunction(app, "refreshLiveDevices");

  assert.match(refreshLiveDevices, /state = await api\("\/api\/admin\/state"\)/);
  assert.match(refreshLiveDevices, /renderStatStrip\(\)/);
  assert.match(refreshLiveDevices, /renderDevices\(\)/);
});

test("server console offers a real sing-box restart and apply action", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const applySingbox = extractFunction(app, "applySingbox");

  assert.match(html, /id="applySingboxBtn"[^>]*>重启并应用</);
  assert.match(app, /byId\("applySingboxBtn"\)\.addEventListener\("click", applySingbox\)/);
  assert.match(applySingbox, /api\("\/api\/admin\/singbox\/apply"/);
  assert.match(applySingbox, /confirmApplySingbox: true/);
  assert.match(applySingbox, /重启并应用 sing-box/);
  assert.doesNotMatch(app, /点击“标记已应用”/);
});

test("server static shell starts without demo operational data", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");

  for (const forbidden of [
    "company-pc1",
    "laptop-office",
    "nas-home",
    "backup-photos",
    "archive-old",
    "C7KD-92PQ",
    "SFSC1-",
    "profile-company",
    "vless://",
    "syn***ord",
    "2 / 3",
    "18.0 GB",
    "12.3 GB",
    "12.3 Mbps",
    "45%"
  ]) {
    assert.equal(html.includes(forbidden), false, `server HTML should not include demo fixture: ${forbidden}`);
  }

  assert.match(html, /id="claimResult"[^>]*hidden/);
  assert.match(html, /id="bucketList"[\s\S]*正在加载仓库/);
  assert.match(html, /id="deviceList"[\s\S]*正在加载设备/);
  assert.match(html, /id="profileOut"[\s\S]*等待操作结果/);
});

test("server console tolerates legacy devices without runtime diagnostics", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const formatBuildInfo = extractFunction(app, "formatBuildInfo");
  const context = {};

  runInNewContext(`
    function formatTime(value) { return String(value); }
    ${formatBuildInfo}
    globalThis.formatBuildInfo = formatBuildInfo;
  `, context);

  assert.equal(context.formatBuildInfo(null), "-");
  assert.equal(context.formatBuildInfo(undefined), "-");
  assert.equal(context.formatBuildInfo({ buildId: "sfsc-test", buildTime: null }), "sfsc-test");
});

test("server console keeps a verified admin token when state rendering fails", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const loginAdmin = extractFunction(app, "loginAdmin");
  const context = {
    apiCalls: [],
    authUpdates: [],
    actionMessages: [],
    storedToken: ""
  };

  runInNewContext(`
    let adminToken = "";
    const fields = {
      adminTokenInput: { value: "verified-admin-token" }
    };
    const localStorage = {
      setItem(_key, value) { storedToken = value; },
      removeItem() { storedToken = ""; }
    };
    const adminTokenStorageKey = "sfsc-admin-token";

    async function api(path) {
      apiCalls.push(path);
      return { ok: true };
    }
    async function loadState() {
      throw new Error("render failed");
    }
    function hideAuthGate() {}
    function updateAuthStatus(value) { authUpdates.push(value); }
    function setAuthMessage() {}
    function setAction(message, status) { actionMessages.push({ message, status }); }
    function formatActionError(error) { return error.message; }
    function clearAdminToken() {
      adminToken = "";
      localStorage.removeItem(adminTokenStorageKey);
    }

    ${loginAdmin}
    globalThis.loginAdmin = loginAdmin;
    globalThis.getAdminToken = () => adminToken;
  `, context);

  await context.loginAdmin({ preventDefault() {} });

  assert.deepEqual(context.apiCalls, ["/api/admin/auth/check"]);
  assert.equal(context.getAdminToken(), "verified-admin-token");
  assert.equal(context.storedToken, "verified-admin-token");
  assert.deepEqual(context.authUpdates, [true]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.actionMessages)), [{
    message: "控制台状态加载失败：render failed",
    status: "bad"
  }]);
});

test("server storage save preserves secret when password field is blank or masked", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const saveStorage = extractFunction(app, "saveStorage");
  const readOptionalSecret = extractFunction(app, "readOptionalSecret");

  assert.match(html, /<input[^>]*id="secretAccessKey"[^>]*placeholder="留空保持不变"/);
  assert.doesNotMatch(html, /id="secretAccessKey"[^>]*value=/);
  assert.doesNotMatch(html, /id="secretAccessKey"[^>]*readonly/);
  assert.match(html, /<input[^>]*id="internalEndpoint"[^>]*readonly/);
  assert.match(saveStorage, /readOptionalSecret\(fields\.secretAccessKey\.value\)/);

  const context = {
    apiCalls: []
  };
  runInNewContext(`
    let state = {};
    const fields = {
      remoteName: { value: "s3" },
      bucket: { value: "home-sync" },
      endpoint: { value: "http://minio.local:9000" },
      internalEndpoint: { value: "http://minio:9000" },
      accessKeyId: { value: "syncadmin" },
      secretAccessKey: { value: "" },
      prefixRoot: { value: "devices" },
      sharedPrefix: { value: "shared" }
    };

    async function api(path, body) {
      apiCalls.push({ path, body: { ...body } });
      return { state: {}, storage: { ok: true } };
    }

    async function runAction(_pendingText, _successText, action) {
      return action();
    }

    function renderDebugJson() {}
    function renderState() {}

    ${readOptionalSecret}
    ${saveStorage}

    globalThis.saveWithSecret = async (value) => {
      fields.secretAccessKey.value = value;
      await saveStorage();
    };
  `, context);

  await context.saveWithSecret("");
  await context.saveWithSecret("abc***xyz");
  await context.saveWithSecret("new-secret-value");

  assert.equal(context.apiCalls.length, 3);
  for (const call of context.apiCalls.slice(0, 2)) {
    assert.equal(call.path, "/api/admin/storage/save");
    assert.equal(Object.hasOwn(call.body, "secretAccessKey"), false);
  }
  for (const call of context.apiCalls) {
    assert.equal(Object.hasOwn(call.body, "internalEndpoint"), false);
  }
  assert.equal(context.apiCalls[2].body.secretAccessKey, "new-secret-value");
});

test("server console only presents conflicts for bidirectional sync", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const formatSyncRun = extractFunction(app, "formatSyncRun");
  const getDeviceConflictSummary = extractFunction(app, "getDeviceConflictSummary");
  const renderDeviceFilterSummary = extractFunction(app, "renderDeviceFilterSummary");
  const context = {};

  runInNewContext(`
    let summaryText = "";
    function formatTime(value) { return String(value); }
    function formatError() { return ""; }
    function formatSyncTrigger() { return "手动触发"; }
    function isBidirectionalSyncDirection(direction) {
      return String(direction || "").trim().toLowerCase() === "bidirectional";
    }
    function byId() {
      return {
        set textContent(value) { summaryText = value; }
      };
    }
    ${formatSyncRun}
    ${getDeviceConflictSummary}
    ${renderDeviceFilterSummary}
    globalThis.formatSyncRun = formatSyncRun;
    globalThis.getDeviceConflictSummary = getDeviceConflictSummary;
    globalThis.renderDeviceFilterSummary = renderDeviceFilterSummary;
    globalThis.getSummaryText = () => summaryText;
  `, context);

  const conflicts = { count: 2, files: ["a.txt", "b.txt"], truncated: false };
  for (const direction of ["upload", "download"]) {
    const run = { status: "success", job: { direction }, conflicts };
    const device = { enabled: true, online: true, sync: { lastRun: run, conflicts } };

    assert.doesNotMatch(context.formatSyncRun(run), /冲突/);
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.getDeviceConflictSummary(device))),
      { count: 0, files: [], truncated: false }
    );
    context.renderDeviceFilterSummary([device], [device]);
    assert.match(context.getSummaryText(), /需关注 0 个/);
  }

  const bidirectionalRun = {
    status: "success",
    job: { direction: "bidirectional" },
    conflicts
  };
  const bidirectionalDevice = {
    enabled: true,
    online: true,
    sync: { lastRun: bidirectionalRun, conflicts }
  };
  assert.match(context.formatSyncRun(bidirectionalRun), /冲突 2 项/);
  assert.equal(context.getDeviceConflictSummary(bidirectionalDevice).count, 2);
  context.renderDeviceFilterSummary([bidirectionalDevice], [bidirectionalDevice]);
  assert.match(context.getSummaryText(), /需关注 1 个/);
});

test("server bucket refresh ok false shows storage recovery guidance instead of success", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const refreshBuckets = extractFunction(app, "refreshBuckets");

  assert.doesNotMatch(refreshBuckets, /runAction\(/);
  assert.match(refreshBuckets, /result\.ok === false/);
  assert.match(
    app,
    /function formatBucketRefreshWarning\(result = \{\}\) \{\s*return formatActionError\(\{\s*code: result\.errorCode \|\| "storage_request_failed",\s*message: result\.warning \|\| ""\s*\}\);\s*\}/
  );
  assert.match(app, /storage_request_failed: "检查 MinIO 容器、endpoint、access key\/secret，以及 bucket 权限。"/);

  const context = {
    apiCalls: [],
    bucketRefreshResponse: {
      ok: false,
      errorCode: "storage_request_failed",
      warning: "MinIO unavailable",
      buckets: [{ name: "archive-sync" }],
      state: { storage: { buckets: [{ name: "archive-sync" }] } }
    }
  };

  runInNewContext(`
    let state = null;
    const actionMessages = [];
    const debugPayloads = [];
    let renderStateCalls = 0;

    function setAction(message, state = "") {
      actionMessages.push({ message, state });
    }

    function renderDebugJson(value) {
      debugPayloads.push(value);
    }

    function renderState() {
      renderStateCalls += 1;
    }

    async function api(path, body) {
      apiCalls.push({ path, body });
      return bucketRefreshResponse;
    }

    function formatBucketRefreshWarning() {
      return "存储服务请求失败，请检查 MinIO、地址和密钥。 建议：检查 MinIO 容器、endpoint、access key/secret，以及 bucket 权限。";
    }

    ${refreshBuckets}

    globalThis.runRefreshBuckets = refreshBuckets;
    globalThis.actionMessages = actionMessages;
    globalThis.debugPayloads = debugPayloads;
    globalThis.getRenderStateCalls = () => renderStateCalls;
  `, context);

  await context.runRefreshBuckets();

  assert.equal(context.apiCalls.length, 1);
  assert.equal(context.apiCalls[0].path, "/api/admin/storage/buckets/refresh");
  assert.deepEqual(JSON.parse(JSON.stringify(context.apiCalls[0].body)), {});
  assert.equal(context.getRenderStateCalls(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.debugPayloads[0])), {
    ok: false,
    errorCode: "storage_request_failed",
    warning: "MinIO unavailable",
    buckets: [{ name: "archive-sync" }]
  });

  const finalMessage = context.actionMessages[context.actionMessages.length - 1];
  assert.equal(finalMessage.state, "bad");
  assert.match(finalMessage.message, /存储服务请求失败/);
  assert.match(finalMessage.message, /建议：检查 MinIO 容器、endpoint、access key\/secret，以及 bucket 权限。/);
  assert.doesNotMatch(finalMessage.message, /仓库列表已刷新/);
});

test("server console can create a device without spending a SyncKey", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  // The owner dropdown tells the admin "先创建设备", so the console must offer a
  // way to obey it. Without this, the only path to a device is issuing a SyncKey
  // from a free-text name field, which makes typos silently fabricate devices.
  assert.match(html, /id="newDeviceName"/);
  assert.match(html, /id="createDeviceBtn"/);
  assert.match(html, /for="newDeviceName"/);
  assert.match(html, /for="newDeviceBucket"/);
  assert.match(app, /byId\("createDeviceBtn"\)\.addEventListener\("click", createDevice\)/);

  const createDevice = extractFunction(app, "createDevice");
  const context = {};
  runInNewContext(`
    globalThis.calls = [];
    globalThis.actions = [];
    globalThis.rendered = 0;
    globalThis.devices = [];
    let nameValue = "";
    const fields = {
      newDeviceName: {
        get value() { return nameValue; },
        set value(next) { nameValue = next; }
      },
      newDeviceBucket: { value: "home-sync" },
      deviceName: { value: "" }
    };
    function setAction(message, tone) { actions.push({ message, tone }); }
    function findDeviceByName(input) {
      const name = String(input || "").trim();
      return devices.find((device) => device.clientName === name) || null;
    }
    async function api(path, body) {
      calls.push({ path, body });
      return { user: { id: "user-1", clientName: body.clientName }, state: { devices: [] } };
    }
    async function runAction(pendingText, successText, action) {
      const result = await action();
      setAction(successText, "good");
      return result;
    }
    function renderDebugJson() {}
    function renderState() { rendered += 1; }
    ${createDevice}
    globalThis.createDevice = createDevice;
    globalThis.fields = fields;
  `, context);

  // Empty name must not reach the server.
  await context.createDevice();
  assert.equal(context.calls.length, 0);
  assert.equal(context.actions.at(-1).tone, "warn");

  // Happy path posts to the existing endpoint and clears the input.
  context.fields.newDeviceName.value = "laptop-01";
  await context.createDevice();
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].path, "/api/admin/users/create");
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.calls[0].body)),
    { clientName: "laptop-01", bucketName: "home-sync" }
  );
  assert.equal(context.fields.newDeviceName.value, "");
  assert.equal(context.rendered, 1);
  // A device with no SyncKey cannot be imported, so creation must hand off to the
  // SyncKey flow rather than leaving a half-built device behind.
  assert.equal(context.fields.deviceName.value, "laptop-01");

  // createManagedUser is idempotent on clientName: a duplicate would return the
  // existing device and read as success. The console must not claim it created one.
  context.devices.push({ id: "user-1", clientName: "laptop-01" });
  context.fields.newDeviceName.value = "laptop-01";
  await context.createDevice();
  assert.equal(context.calls.length, 1);
  assert.equal(context.actions.at(-1).tone, "warn");
  assert.match(context.actions.at(-1).message, /已存在/);
});

test("client recovery panels load sequentially on first status load and direction changes", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const refreshPanels = extractFunction(app, "refreshSyncRecoveryPanels");
  const recoveryPanelContextKey = extractFunction(app, "syncRecoveryPanelContextKey");
  const loadStatusOnce = extractFunction(app, "loadStatusOnce");

  assert.match(loadStatusOnce, /void refreshSyncRecoveryPanels\(\)/);
  assert.match(app, /on\("direction",\s*"change",\s*refreshSyncRecoveryPanels\)/);
  assert.doesNotMatch(app, /on\("direction",\s*"change",\s*refreshRecoveryVersions\)/);
  assert.doesNotMatch(app, /on\("direction",\s*"change",\s*refreshFirstBisyncConflictOperations\)/);

  const calls = [];
  const rendered = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const job = { id: "job-1", direction: "bidirectional", storageBackend: "sftp", relationId: "rel-1" };
  const context = {
    currentJobDraft: null,
    latestStatusRequestId: 1,
    latestAppliedStatusRequestId: 0,
    latestSyncHistory: [],
    selectedFirstBisyncOperationId: "",
    setTimeout,
    rendered,
    clientApi: {
      async getStatus() {
        return { jobs: [job], syncHistory: [], profileSummary: {}, heartbeat: {}, enrollment: {} };
      },
      async listRecoveryVersions() {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        calls.push("recovery:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push("recovery:end");
        activeRequests -= 1;
        return { versions: [] };
      },
      async listFirstBisyncConflictOperations() {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        calls.push("conflicts:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push("conflicts:end");
        activeRequests -= 1;
        return [];
      }
    },
    elements: {
      localPath: { dataset: {} },
      recoveryPanel: {}, recoveryVersions: {}, recoveryStatus: {},
      firstBisyncRecoveryPanel: {}, firstBisyncOperations: {}, firstBisyncRecoveryStatus: {}
    },
    formatError: (error) => error.message
  };
  runInNewContext(`
    function $(id) { return elements[id]; }
    function writeJob(job) { currentJobDraft = job; }
    function renderObservedConfig() {}
    function renderLiveState() {}
    function renderSyncHistory() {}
    function renderProfileSummary() {}
    function renderEnrollmentStatus() {}
    function renderRemoteTargetSummary() {}
    function applySyncDirectionAuthorization() {}
    function renderRecoveryVersions() { elements.recoveryVersions.textContent = "ready"; rendered.push("recovery"); }
    function renderFirstBisyncConflictOperations() { elements.firstBisyncOperations.textContent = "ready"; rendered.push("conflicts"); }
    let currentJobDraft = null;
    let syncRecoveryPanelsRequestInFlight = null;
    let latestStatusRequestId = 1;
    let latestAppliedStatusRequestId = 0;
    let latestSyncHistory = [];
    ${extractFunction(app, "refreshRecoveryVersions")}
    ${extractFunction(app, "refreshFirstBisyncConflictOperations")}
    ${recoveryPanelContextKey}
    ${refreshPanels}
    ${loadStatusOnce}
    globalThis.firstStatusLoad = () => loadStatusOnce(1);
  `, context);

  await context.firstStatusLoad();
  for (let attempt = 0; attempt < 20 && rendered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(calls, ["recovery:start", "recovery:end", "conflicts:start", "conflicts:end"]);
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)), ["recovery", "conflicts"]);
  assert.equal(context.elements.recoveryVersions.textContent, "ready");
  assert.equal(context.elements.firstBisyncOperations.textContent, "ready");
});

test("client recovery request remains alive past the old timeout before conflict listing", async () => {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const apiStart = app.indexOf("const clientApi = Object.freeze({");
  const apiEnd = app.indexOf("\n});\n\nasync function requestJson", apiStart);
  assert.notEqual(apiStart, -1);
  assert.notEqual(apiEnd, -1);
  const clientApi = app.slice(apiStart, apiEnd + "\n});".length).replace("const clientApi =", "globalThis.clientApi =");
  const recoveryPanelContextKey = extractFunction(app, "syncRecoveryPanelContextKey");
  const requestTimeoutConstants = [...app.matchAll(/const \w+RequestTimeoutMs = \d+;/g)].map(([declaration]) => declaration);
  assert.ok(requestTimeoutConstants.some((declaration) => declaration.startsWith("const defaultRequestTimeoutMs =")));
  assert.ok(requestTimeoutConstants.some((declaration) => declaration.startsWith("const syncPreparationRequestTimeoutMs =")));

  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const setVirtualTimeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + Number(delay), callback });
    return id;
  };
  const clearVirtualTimeout = (id) => timers.delete(id);
  const advanceClock = async (milliseconds) => {
    now += milliseconds;
    for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
      if (timer.at <= now && timers.delete(id)) timer.callback();
    }
    await Promise.resolve();
  };

  const calls = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let finishRecovery;
  const context = {
    AbortController,
    encodeURIComponent,
    setTimeout: setVirtualTimeout,
    clearTimeout: clearVirtualTimeout,
    fetch: async (path, options) => {
      calls.push({ path, signal: options.signal });
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (path.endsWith("/recovery")) {
        return await new Promise((resolve, reject) => {
          const onAbort = () => {
            activeRequests -= 1;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          finishRecovery = () => {
            options.signal.removeEventListener("abort", onAbort);
            activeRequests -= 1;
            resolve({ ok: true, status: 200, text: async () => JSON.stringify({ versions: [] }) });
          };
        });
      }
      const response = activeRequests > 1
        ? { ok: false, status: 409, text: async () => JSON.stringify({ error: "sync_already_running" }) }
        : { ok: true, status: 200, text: async () => JSON.stringify({ operations: [] }) };
      activeRequests -= 1;
      return response;
    },
    currentJobDraft: { id: "job-1", direction: "bidirectional", storageBackend: "sftp", relationId: "rel-1" },
    selectedFirstBisyncOperationId: "",
    elements: {
      recoveryPanel: {}, recoveryVersions: {}, recoveryStatus: {},
      firstBisyncRecoveryPanel: {}, firstBisyncOperations: {}, firstBisyncRecoveryStatus: {}
    },
    formatError: (error) => error.message
  };

  runInNewContext(`
    async function readJsonOrFallback(response) { return JSON.parse(await response.text()); }
    ${requestTimeoutConstants.join("\n")}
    ${extractFunction(app, "requestJson")}
    ${clientApi}
    function $(id) { return elements[id]; }
    function renderRecoveryVersions() { elements.recoveryVersions.textContent = "ready"; }
    function renderFirstBisyncConflictOperations() { elements.firstBisyncOperations.textContent = "ready"; }
    let syncRecoveryPanelsRequestInFlight = null;
    ${extractFunction(app, "refreshRecoveryVersions")}
    ${extractFunction(app, "refreshFirstBisyncConflictOperations")}
    ${recoveryPanelContextKey}
    ${extractFunction(app, "refreshSyncRecoveryPanels")}
    globalThis.refreshPanels = refreshSyncRecoveryPanels;
  `, context);

  const panelRefresh = context.refreshPanels();
  await Promise.resolve();
  assert.equal(calls.length, 1, `fetches=${JSON.stringify(calls)} status=${context.elements.recoveryStatus.textContent}`);
  await advanceClock(16000);
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(calls[0].signal.aborted, false, "recovery listing should not abort at the former 15-second limit");
  assert.equal(calls.length, 1, "conflict listing should wait for recovery listing to finish");

  finishRecovery();
  await panelRefresh;
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /\/recovery$/);
  assert.equal(calls[1].path, "/api/sync/bisync/conflicts/operations");
  assert.equal(calls[1].signal.aborted, false);
  assert.equal(maxActiveRequests, 1, "the backend data-operation lock should never see overlapping list requests");
  assert.equal(context.elements.recoveryVersions.textContent, "ready");
  assert.equal(context.elements.firstBisyncOperations.textContent, "ready");
});

function extractFunction(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `expected ${name} function to exist`);

  const start = match.index;
  const closeParen = source.indexOf(")", start);
  assert.notEqual(closeParen, -1, `expected ${name} parameters to close`);
  const openBrace = source.indexOf("{", closeParen);
  assert.notEqual(openBrace, -1, `expected ${name} function body to start`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBrace; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      lineComment = current !== "\n";
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        quote = "";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      continue;
    }

    if (current === "{") {
      depth += 1;
      continue;
    }

    if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`expected ${name} function body to close`);
}
