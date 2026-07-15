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
        "statTunnelValue",
        "statTunnelSub",
        "statOnlineDevicesValue",
        "statOnlineDevicesSub",
        "statSyncingValue",
        "statSyncingSub",
        "statStorageUsageValue",
        "statStorageUsageSub"
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

test("server claim output remains writable by production app.js", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");

  assert.match(html, /<textarea[^>]*id="claimOut"[^>]*readonly/);
  assert.doesNotMatch(html, /<div[^>]*id="claimOut"/);
});

test("server shell health and stat strip avoid stale optimistic status", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const renderStatStrip = extractFunction(app, "renderStatStrip");
  const checkHealth = extractFunction(app, "checkHealth");

  assert.match(html, /id="healthDot" class="health-dot warn"/);
  assert.match(html, /id="healthText">检测中/);
  assert.doesNotMatch(html, /id="healthDot" class="health-dot ok"/);
  for (const id of ["statTunnelSub", "statOnlineDevicesSub", "statSyncingSub", "statStorageUsageSub"]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderStatStrip, new RegExp(`setStatText\\("${id}"`));
  }
  assert.match(checkHealth, /serviceHealth\.restartRequired/);
  assert.match(checkHealth, /classList\.remove\("ok", "good", "warn", "err"\)/);
  assert.match(checkHealth, /API 可达 · 待重启/);
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
