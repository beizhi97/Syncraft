// 把客户端 UI 送进 README 截图所需的状态，供人工重新截图。
//
// 为什么需要这个脚本：截图是产品事实，不能凭设计意图画出来。但要让客户端显示
// 「已导入 SyncKey、已绑定同步空间、方向已按角色收窄」的界面，原本得先起一台
// 服务端、配好存储与隧道、注册设备、签发 SyncKey、再在客户端粘贴——每次 UI 一改
// 就要重做一遍，于是截图就长期停留在旧版本。这个脚本用服务端真实签发逻辑
// （createManagedUser → createSyncSpace → createClaim）造出 profile，再通过客户端
// 真实的 /api/profile/import 与 /api/jobs/save 写进去，不手工拼本地状态文件。
//
// 刻意不自动截图：无头浏览器渲染出来的是 Linux 上的网页，不是 Windows 客户端，
// 字体与窗口都不一致，拿它冒充「实际截图」是在伪造产品事实。脚本只负责把状态
// 准备好，截图由人在真机上完成。
//
// 安全：所有凭据都是本地生成的一次性假值，不连任何真实服务端。profile 里含
// storage secret 与 heartbeat secret，所以脚本只把它 POST 给本机客户端，绝不打印、
// 不写报告、不落盘到仓库内。
//
// 用法（两个终端）：
//   1) $env:SFSC_PORTABLE_ROOT="$env:TEMP\syncraft-doc-shot"; pnpm client:start
//   2) node scripts/seed-doc-screenshot.mjs
// 然后浏览器打开 http://127.0.0.1:5188/ 截图。截完删掉 SFSC_PORTABLE_ROOT 目录。

import { createDefaultAdminState, createManagedUser, createSyncSpace, createClaim } from "../src/core/serverAdmin.js";
import { encodeImportProfile } from "../src/core/profileProtocol.js";

const baseUrl = normalizeBaseUrl(readArg("--base-url") || process.env.SFSC_DOC_SHOT_BASE_URL || "http://127.0.0.1:5188");
const localPath = readArg("--local-path") || process.env.SFSC_DOC_SHOT_LOCAL_PATH || "D:\\SyncraftDemo\\资料";
const syncId = readArg("--sync-id") || process.env.SFSC_DOC_SHOT_SYNC_ID || "team-docs";
// 默认 collaboration + writer：这是唯一能让「同步方向」选择器保持可选的组合，
// 截图要展示的是常规形态。想截「方向被服务端锁定」那张图时传 --mode distribution
// --role reader，选择器会置灰并显示锁定说明。
const mode = readArg("--mode") || process.env.SFSC_DOC_SHOT_MODE || "collaboration";
const role = readArg("--role") || process.env.SFSC_DOC_SHOT_ROLE || "writer";
const direction = readArg("--direction") || process.env.SFSC_DOC_SHOT_DIRECTION || "upload";

try {
  await main();
} catch (error) {
  console.error(`Seed failed: ${error.message || error}`);
  console.error("客户端未启动？先在另一个终端跑：pnpm client:start（建议设置 SFSC_PORTABLE_ROOT 指向临时目录）");
  process.exitCode = 1;
}

async function main() {
  await assertClientReachable();

  const profile = issueProfile();
  // sfsc:// 导入串要放在 code 而不是 uri：resolveProfileImport 把 body.uri 当成
  // 「历史遗留的裸 VLESS URI」走 buildLegacyVlessProfile，所以放错字段会报
  // invalid_vless_uri——看着像 URI 坏了，其实是走错了分支。code 分支才会先试
  // SyncKey 短码、再回落到 decodeImportProfilePayload 解 sfsc:// 串。
  //
  // 用 sfsc:// 串而不是短码：短码需要一台活着的服务端来兑换，而截图脚本不该顺带
  // 要求跑一套服务端。代价是 importMode 为 offline-profile。
  const importCode = encodeImportProfile(profile);
  await post("/api/profile/import", { code: importCode });
  // 不回显 importCode 或 profile：URI 片段里就是完整 profile，带 storage secret
  // 与 heartbeat secret。
  console.log(`已导入 profile：同步空间 ${syncId}（${mode}）／角色 ${role}`);

  await post("/api/jobs/save", { job: { localPath, direction, schedule: { mode: "manual" }, destructiveSync: false } });
  console.log(`已保存任务：${localPath} ／ 方向 ${direction}`);

  console.log("");
  console.log(`现在打开 ${baseUrl}/ 截图。README 用到的是主界面「同步任务」区域。`);
  console.log("截完请删除本次使用的 SFSC_PORTABLE_ROOT 目录，避免把演示状态留在机器上。");
}

// 走服务端真实签发链路，而不是手写一个 profile 字面量：手写的 profile 会随协议演进
// 变成只有截图脚本才见得到的形状，截出来的界面也就不再代表真实签发结果。
function issueProfile() {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "sync.example.com",
    VLESS_PORT: "45678",
    PUBLIC_SERVER_URL: "https://sync.example.com"
  });
  const owner = createManagedUser(state, { clientName: "doc-owner" });
  const space = createSyncSpace(state, { ownerUserId: owner.id, syncId, mode });
  const created = createClaim(state, {
    clientName: "doc-demo-pc",
    syncSpaceId: space.id,
    requestedRole: role
  });
  return created.profile;
}

async function assertClientReachable() {
  const res = await fetch(`${baseUrl}/api/client/status`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`客户端不可达：${baseUrl}/api/client/status`);
  }
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  if (!res.ok) {
    // 只回显稳定错误码，不回显整个响应体——失败响应可能带回请求里的字段。
    let code = "";
    try {
      code = JSON.parse(text)?.errorCode || "";
    } catch {}
    throw new Error(`POST ${path} 返回 ${res.status}${code ? ` (${code})` : ""}`);
  }
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
