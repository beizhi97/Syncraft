// D. 把「状态」与「事件」分开。
//
// 这一轮修的是两个同源缺陷：
//   1. 离线残影：loadStatusOnce 成功路径渲染 29 处，catch 分支只重置 6 处，
//      其余 23 处保留上一次成功轮询的值。最尖锐的是 tunnelStatus——客户端已经
//      连不上了，界面还在断言「隧道运行中」，这是在陈述一件假事。
//   2. 绿色横幅驻留：setAction 写入的事件字符串没有任何存活期。全文 34 个调用点，
//      actionMessage 元素在 app.js 里只被 setAction 自己碰过一次，没有任何地方
//      按状态变化清除它。于是「同步已开始。」会一直挂着，哪怕同步早已失败。
//
// 设计评审的原话是「事件字符串的存活期不得超过它所描述的状态」，所以修法不是
// 在 catch 里补齐那 23 处——那样每新增一个渲染项就会重新漏一次，正是上一轮 C
// 反复教过的「补布尔值」。修法是让「活状态」只有一个渲染入口，null 即未知，
// 成功与离线两条路径都走它。
//
// 注意本文件断言的边界：只有「现在怎么样」才归未知。「你配置成什么样」——版本号、
// 安装路径、协议、发布清单、保管箱、同步历史——离线时必须留着，因为那些字段描述的
// 是最后一次成功观测到的配置事实，而排障恰恰要看它们；一次轮询超时就清空会造成闪烁，
// 反而更难读。测 3 专门钉这条边界，防止后人把「归未知」过度推广。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function stripComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function makeFakeElement() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: "",
    className: "",
    value: "",
    dataset: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name))
    }
  };
}

function makeStatus(overrides = {}) {
  return {
    appVersion: "0.3.0-rc.3",
    clientVersion: "0.3.0-rc.3",
    diagnostics: { protocols: { clientStatus: 1 }, buildId: "build-1", buildTime: "2026-07-31T00:00:00.000Z" },
    releaseManifest: { ok: true, builtAt: "2026-07-31T00:00:00.000Z" },
    binaries: {
      singbox: { path: "C:\\bin\\sing-box.exe", exists: true },
      rclone: { path: "C:\\bin\\rclone.exe", exists: true }
    },
    paths: { dataRoot: "C:\\Data" },
    safeguards: { localState: { ok: true }, secretVault: { ok: true } },
    profileImported: true,
    heartbeat: { ok: true },
    processes: {
      singbox: { running: true },
      sync: { running: Boolean(overrides.syncRunning), metrics: { syncState: overrides.syncState || "idle" } }
    },
    lastSync: null,
    scheduler: {},
    syncHistory: [],
    profileSummary: null,
    jobs: [],
    ...overrides
  };
}

// 驱动真实的 loadStatusOnce：setPill/setHealth/setBodyState 用真实语义的桩，
// 渲染函数记录收到的参数，这样才能断言离线时它们收到 null 而不是「没被调用」。
// 「没被调用」是当前缺陷的症状，不是修好的样子。
async function buildContext() {
  const app = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
  const start = app.indexOf("async function loadStatus");
  const end = app.indexOf("async function checkBinaries", start);
  const actionStart = app.indexOf("function setAction(");
  const actionEnd = app.indexOf("async function withBusyAction", actionStart);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);

  // 从真实源码里抽一段函数，抽不到就直接失败——静默抽空会让后面的断言变成
  // 「桩通过了」而不是「实现通过了」。
  const slice = (from, to) => {
    const a = app.indexOf(from);
    const b = app.indexOf(to, a);
    assert.notEqual(a, -1, `抽取失败: ${from}`);
    assert.notEqual(b, -1, `抽取失败: ${to}`);
    return app.slice(a, b);
  };

  const elements = {};
  const context = {
    app,
    elements,
    getStatusQueue: [],
    renderCalls: { heartbeat: [], syncProgress: [], scheduler: [], deviceRecovery: [] },
    bodyStates: [],
    document: {
      getElementById: (id) => (elements[id] ||= makeFakeElement()),
      body: { classList: makeFakeElement().classList }
    }
  };

  runInNewContext([
    "const $ = (id) => document.getElementById(id);",
    "let statusRequestInFlight = null;",
    "let latestStatus = null;",
    "let currentAction = null;",
    "let latestSyncHistory = [];",
    "let currentJobDraft = null;",
    "let latestStatusRequestId = 0;",
    "let latestAppliedStatusRequestId = 0;",
    "const clientApi = { getStatus: () => this.getStatusQueue.shift() };",
    // setBodyState 真实定义在抽取范围之外，历史上 harness 从未桩它，
    // 于是离线分支一跑就 ReferenceError——这正是那 23 处残影长期没被发现的原因。
    "function setBodyState(next) { this.bodyStates.push(next); document.body.classList.add(next); }",
    "function updateBodyState(status) { setBodyState(status.profileImported ? 'state-normal' : 'state-empty'); }",
    "function currentSuccessfulHeartbeat(status) { return status.heartbeat || null; }",
    "function currentProcessSyncState(sync) { return sync?.metrics?.syncState || 'idle'; }",
    "function formatProtocols(v) { return v ? 'protocols' : '-'; }",
    "function formatCompatibility(v) { return v?.status || '-'; }",
    "function formatCompatibilityPolicy(v) { return v?.syncRun || '-'; }",
    "function formatShortTime(v) { return v || '-'; }",
    "function formatReleaseManifest(v) { return v?.ok ? 'ok' : '-'; }",
    "function formatLocalState(v) { return v?.ok ? 'ok' : '-'; }",
    "function formatSecretVault(v) { return v?.ok ? 'ok' : '-'; }",
    "function profileStatusDisplay() { return { pill: '配置正常', state: 'good' }; }",
    "function syncStatusPill(sync) { return sync?.running ? { text: '同步中', state: 'good' } : { text: '空闲', state: '' }; }",
    // setPill 与 setHealth 取真实实现：本轮给它们加了 unknown 三态，用桩断言等于
    // 在验证测试自己写的版本。两者定义位置不连续，所以分两段抽。
    slice("function setPill(", "function syncStatusPill("),
    slice("function setHealth(", "function renderHeartbeat("),
    // renderHeartbeat 取真实实现并记录入参：既要断言它收到 null，也要断言 null 分支
    // 真的把 pill 和健康行写成未知。heartbeatDisplay 一起抽；它依赖的两个 format 函数
    // 只在非 null 分支用到，桩掉不影响本文件断言的那条路径。
    "function formatHeartbeatDevice() { return ''; }",
    "function formatError(e) { return e.code || ''; }",
    slice("function heartbeatDisplay(", "function formatHeartbeatDevice("),
    // 真实实现改名后引入，再用同名包装记录入参并委托给它：这样既断言 renderLiveState
    // 传了 null，也断言 null 分支真的把 pill 和健康行写成未知。只桩不跑等于断言测试自己。
    slice("function renderHeartbeat(", "function renderDeviceRecovery(")
      .replace("function renderHeartbeat(", "function realRenderHeartbeat("),
    "function renderHeartbeat(hb, imported) { this.renderCalls.heartbeat.push(hb === null ? null : 'value'); return realRenderHeartbeat(hb, imported); }",
    "function renderSyncProgress(m) { this.renderCalls.syncProgress.push(m === null ? null : 'value'); }",
    "function renderScheduler(s) { this.renderCalls.scheduler.push(s === null ? null : 'value'); }",
    "function renderDeviceRecovery(p) { this.renderCalls.deviceRecovery.push(p === null ? null : 'value'); }",
    "function renderSyncHistory() {}",
    "function renderProfileSummary() {}",
    "function renderEnrollmentStatus() {}",
    "function renderRemoteTargetSummary() {}",
    "function applySyncDirectionAuthorization() {}",
    "function writeJob() {}",
    app.slice(start, end),
    // setAction 必须取真实实现一起跑：本轮改的就是它的存活期，桩掉它等于把被测行为
    // 换成测试自己写的版本。它定义在 loadStatus 之后很远处，所以单独抽一段拼进来。
    app.slice(actionStart, actionEnd),
    "this.loadStatus = loadStatus;",
    "this.setAction = setAction;",
    // 把事件的写入时间往前推，用来验证兜底存活期。改时间而不是 sleep：
    // 让测试等 6 秒会把整个套件拖慢，而且 sleep 的时长断言本身就不稳。
    "this.currentActionAgeMs = (ms) => { if (currentAction) currentAction.at -= ms; };"
  ].join("\n"), context);

  return context;
}

test("离线时派生状态整体归为未知，不保留上一次成功轮询的值", async () => {
  const context = await buildContext();
  context.getStatusQueue.push(Promise.resolve(makeStatus({ syncRunning: true, syncState: "syncing" })));
  await context.loadStatus();

  // 先确认成功路径真的把这些渲染出来了，否则后面的断言可能只是「本来就没渲染」。
  assert.equal(context.elements.tunnelStatus.textContent, "隧道运行中");
  assert.equal(context.elements.syncStatus.textContent, "同步中");
  assert.equal(context.elements.profileStatus.textContent, "配置正常");

  context.getStatusQueue.push(Promise.reject(new Error("offline")));
  await context.loadStatus();

  // 客户端连不上时，界面不能继续断言隧道在跑、同步在进行。这三条是残影本身。
  assert.notEqual(context.elements.tunnelStatus.textContent, "隧道运行中");
  assert.notEqual(context.elements.syncStatus.textContent, "同步中");
  assert.notEqual(context.elements.profileStatus.textContent, "配置正常");

  // 归「未知」而不是归「正常/停止」：把未知说成已停止同样是断言假事。
  for (const id of ["tunnelStatus", "syncStatus", "profileStatus"]) {
    assert.match(context.elements[id].textContent, /未知/, `${id} 应显示未知`);
  }

  // 明细区必须收到 null 走未知分支，而不是「不被调用」从而留着旧内容。
  assert.equal(context.renderCalls.heartbeat.at(-1), null);
  assert.equal(context.renderCalls.syncProgress.at(-1), null);
  assert.equal(context.renderCalls.scheduler.at(-1), null);
  assert.equal(context.renderCalls.deviceRecovery.at(-1), null);
});

test("离线时保留配置与身份信息，避免一次轮询失败就整屏闪烁", async () => {
  const context = await buildContext();
  context.getStatusQueue.push(Promise.resolve(makeStatus()));
  await context.loadStatus();
  context.getStatusQueue.push(Promise.reject(new Error("offline")));
  await context.loadStatus();

  // 这些字段描述「最后一次成功观测到的配置」，不是「现在怎么样」。排障要看它们。
  assert.equal(context.elements.clientVersion.textContent, "0.3.0-rc.3");
  assert.equal(context.elements.singboxPath.textContent, "C:\\bin\\sing-box.exe");
  assert.equal(context.elements.dataRoot.textContent, "C:\\Data");
});

test("绿色事件不得越过它所描述的状态继续存活", async () => {
  const context = await buildContext();
  assert.equal(typeof context.setAction, "function", "setAction 应在抽取范围内可驱动");

  context.getStatusQueue.push(Promise.resolve(makeStatus({ syncRunning: true, syncState: "syncing" })));
  await context.loadStatus();
  context.setAction("同步已开始。", "good");
  assert.equal(context.elements.actionMessage.textContent, "同步已开始。");

  // 同步结束后，「同步已开始」描述的状态已经不存在了，横幅必须随之消失。
  context.getStatusQueue.push(Promise.resolve(makeStatus({ syncRunning: false, syncState: "idle" })));
  await context.loadStatus();
  assert.equal(context.elements.actionMessage.textContent, "");
});

test("状态归未知时事件区一并清空", async () => {
  const context = await buildContext();
  context.getStatusQueue.push(Promise.resolve(makeStatus({ syncRunning: true, syncState: "syncing" })));
  await context.loadStatus();
  context.setAction("同步已开始。", "good");

  context.getStatusQueue.push(Promise.reject(new Error("offline")));
  await context.loadStatus();
  // 连不上客户端时，我们无从知道那条事件是否还成立，留着它就是在替一个未知状态背书。
  assert.equal(context.elements.actionMessage.textContent, "");
});

test("离线时心跳 pill 与健康行都归未知，且与「异常」区分开", async () => {
  const context = await buildContext();
  context.getStatusQueue.push(Promise.resolve(makeStatus()));
  await context.loadStatus();
  context.getStatusQueue.push(Promise.reject(new Error("offline")));
  await context.loadStatus();

  // 旧代码在 catch 里把心跳直接写成「客户端离线」并标红。但「连不上客户端」与
  // 「客户端说它连不上服务端」是两件事：后者才是故障，前者只是没有观测。
  assert.equal(context.elements.heartbeatStatus.textContent, "未知");
  assert.equal(context.elements.heartbeatStatus.className, "pill unknown");
  assert.match(context.elements.heartbeatHealth.textContent, /^\? 服务端心跳/);
  // 未知不能画成红色：那会让用户去修一个可能并不存在的故障。
  assert.doesNotMatch(context.elements.singboxHealth.textContent, /^×/);
  assert.match(context.elements.singboxHealth.textContent, /^\? sing-box/);
});

test("状态长期不变的事件靠兜底存活期收走，不长期驻留", async () => {
  const context = await buildContext();
  const status = makeStatus();
  context.getStatusQueue.push(Promise.resolve(status));
  await context.loadStatus();

  // 「已保存任务」这类事件描述的状态压根不会变，签名比对永远不触发。
  // 没有兜底存活期它就会一直挂着——这是绿色横幅驻留的另一副面孔。
  context.setAction("已保存任务。", "good");
  assert.equal(context.elements.actionMessage.textContent, "已保存任务。");

  // 同一状态再轮询一次，尚未到期时必须还在，否则事件会一闪而过读不到。
  context.getStatusQueue.push(Promise.resolve(makeStatus()));
  await context.loadStatus();
  assert.equal(context.elements.actionMessage.textContent, "已保存任务。");

  // 把写入时间往前推到超过存活期，再轮询一次就该被收走。
  context.currentActionAgeMs(7000);
  context.getStatusQueue.push(Promise.resolve(makeStatus()));
  await context.loadStatus();
  assert.equal(context.elements.actionMessage.textContent, "");
});

test("离线分支必须走统一渲染器，不得逐个重置元素", async () => {
  const context = await buildContext();
  const body = stripComments(context.app);
  const fnStart = body.indexOf("async function loadStatusOnce");
  // 只截到 loadStatusOnce 自己的收尾，不能截到 checkBinaries：renderLiveState 现在
  // 就定义在两者之间，截过界会把它内部正当的 setPill 调用当成 catch 里的残留。
  const catchStart = body.indexOf("} catch", fnStart);
  const catchBlock = body.slice(catchStart, body.indexOf("\n}\n", catchStart));
  const fn = body.slice(fnStart, catchStart);

  // 统一入口：活状态只有一个渲染函数，null 表示未知。
  assert.match(fn, /renderLiveState\(status\)/);
  assert.match(catchBlock, /renderLiveState\(null\)/);
  assert.match(body, /function renderLiveState\(status\)/);

  // catch 里再出现逐个 setPill/setHealth，就说明又回到了「补齐清单」的老路：
  // 每新增一个渲染项都得记得在这里补一次，而漏掉不会有任何报错。
  assert.doesNotMatch(catchBlock, /setPill\(/);
  assert.doesNotMatch(catchBlock, /setHealth\(/);
});
