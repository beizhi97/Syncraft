import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function consoleSources() {
  const [html, app] = await Promise.all([
    readFile(join(projectRoot, "public", "index.html"), "utf8"),
    readFile(join(projectRoot, "public", "app.js"), "utf8")
  ]);
  return { html, app };
}

test("导航按真实依赖顺序排列：基础设置在 SyncKey 之前", async () => {
  const { html } = await consoleSources();
  const order = [...html.matchAll(/data-tab-target="(tab-[a-z]+)"[^>]*><span class="nav-dot"/g)]
    .map((match) => match[1]);

  // 旧顺序是 概览 → SyncKey → 设备 → 基础设置：SyncKey 排在它依赖的存储与隧道之前，
  // 于是「首次搭建」没有对应界面，管理员从最后一步开始点。
  assert.deepEqual(order, ["tab-overview", "tab-setup", "tab-vless", "tab-devices", "tab-tkey"]);
});

test("控制台有首次运行面板，且四步顺序与服务端一致", async () => {
  const { html, app } = await consoleSources();

  assert.match(html, /id="tab-setup"/);
  assert.match(html, /id="setupStepList"/);
  assert.match(html, /id="setupProgress"/);

  // 步骤顺序与文案都来自服务端 /api/admin/setup，控制台不自己排序、不自己判断就绪。
  // 两端各写一份顺序，就会重新产生 A/B 修掉的那类漂移。
  assert.match(app, /api\("\/api\/admin\/setup"/);
  assert.doesNotMatch(app, /SETUP_STEP_IDS\s*=/);
});

// 断言「某段代码不含某写法」时必须剥掉注释：本轮的注释里点名了那些被废弃的
// 判断方式以说明为什么不能用，对含注释的原文断言会数到解释文字本身，
// 那是断言太松，不是实现有问题。本会话已因此误报三次。
function stripComments(source) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("首次运行面板渲染服务端给的证据，不自己推导就绪", async () => {
  const { app } = await consoleSources();
  const render = app.slice(app.indexOf("function renderSetupReadiness"));
  assert.ok(render.startsWith("function renderSetupReadiness"), "缺少 renderSetupReadiness");
  const body = stripComments(render.slice(0, render.indexOf("\n}\n") + 3));

  // 只读 step.ready / step.blocked / step.blockedReason，不重算。
  assert.match(body, /step\.ready/);
  assert.match(body, /step\.blockedReason/);
  // 这三个是曾经的谎报源：控制台不得再从它们推导任何灯的颜色。
  assert.doesNotMatch(body, /tunnel\.protocol/);
  assert.doesNotMatch(body, /activeBuckets/);
  assert.doesNotMatch(body, /restartRequired/);
});

test("概览的隧道与存储灯改为读就绪度证据，不再读默认值", async () => {
  const { app } = await consoleSources();
  const overview = app.slice(app.indexOf("function renderOverview"));
  const body = stripComments(overview.slice(0, overview.indexOf("\n}\n") + 3));

  // 旧实现：Boolean(tunnel.protocol) && !tunnel.restartRequired → 零配置报「已配置并应用」。
  assert.doesNotMatch(body, /Boolean\(tunnel\.protocol\)/);
  // 旧实现：activeBuckets.length > 0 → normalizeBuckets 凭空补的桶让它恒真。
  assert.doesNotMatch(body, /activeBuckets\.length > 0/);
  // 旧实现：服务可达灯直接硬编码 true。
  assert.doesNotMatch(body, /setOverviewStatus\("overviewServiceState", true/);
  // 新实现从就绪度取。
  assert.match(body, /setupReadiness|readinessStep/);
});

test("配置未完成时概览把首次运行列为待处理项，并能跳到该面板", async () => {
  const { html, app } = await consoleSources();
  assert.match(app, /首次配置尚未完成|尚未完成首次配置/);
  // 待处理项要能一键到达对应步骤，否则「你还没配置完」只是一句评论。
  assert.match(html, /data-tab-target="tab-setup"/);
});

test("首次运行完成后面板与导航项隐藏，不长期占位", async () => {
  const { app } = await consoleSources();
  const body = stripComments(app);
  // complete 为真时收起：向导长期驻留会让日常运维界面多一个永远绿的装饰。
  assert.match(body, /setupReadiness\?\.complete === true/);
  assert.match(body, /navItem\.hidden = complete/);
  // 收起判断必须是「明确为 true」而不是真值判断：setupReadiness 为 null 时
  // 不能当成已完成而把入口藏掉，那样检测失败就再也看不见了。
  assert.doesNotMatch(body, /if \(setupReadiness\.complete\)/);
});
