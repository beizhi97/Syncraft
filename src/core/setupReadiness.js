// 首次运行的就绪取证。
//
// 唯一的设计约束：就绪只能从证据推导，永不从「默认值为真」推导。
// 这条约束不是风格偏好，它是为了在构造上消除一类已发生的缺陷——
// 全新部署曾经报告「隧道已配置并应用」「1 个仓库可用」，因为：
//   1. state.tunnel.protocol 硬编码默认 "vless-tcp-none"，恒为真值；
//   2. normalizeBuckets 在列表为空时凭空补一个 fallback 桶，还标 source: "configured"，
//      于是 buckets.length > 0 恒真；
//   3. /api/health 直接返回字面量 ok: true。
// 三者都是「存在一个默认值」，没有一个是「管理员做过某件事」或「探针探到了什么」。
//
// 因此本模块只认两类证据：
//   A. 状态里由管理员操作写入的时间戳与记录（写入/应用时刻、设备记录、已签发凭据）；
//   B. checkApplianceHealth 的实时探针结果（PID 存活、端口监听、端点可达、目录可写）。
// 探针缺失一律按未就绪处理：把未知当就绪，就是换个地方重犯同一个错。

import { DEFAULT_STORAGE_SECRET_PLACEHOLDER } from "./serverAdmin.js";

// 顺序即依赖顺序，也是导航顺序。
// 存储在最前：桶与凭据是 profile 的必要内容，隧道之外的一切都落在它上面。
// SyncKey 在最后：它把前三步的产物打包下发，是唯一对外交付物。
export const SETUP_STEP_IDS = Object.freeze(["storage", "tunnel", "device", "synckey"]);

const STEP_TITLES = Object.freeze({
  storage: "配置存储",
  tunnel: "生成并应用隧道",
  device: "注册第一台设备",
  synckey: "签发 SyncKey"
});

const STEP_HINTS = Object.freeze({
  storage: "填写 MinIO 端点与凭据，改掉出厂口令，确认控制台能连上。",
  tunnel: "生成 VLESS 配置后执行「重启并应用」，让 sing-box 真正加载它。",
  device: "注册一台设备。设备是同步空间的成员单位，也是签发 SyncKey 的对象。",
  synckey: "为设备签发一次性 SyncKey，客户端粘贴后即可完成全部配置。"
});

export function summarizeSetupReadiness(state, health) {
  const checks = readChecks(health);
  const evidence = {
    storage: collectStorageEvidence(state, checks),
    tunnel: collectTunnelEvidence(state, checks),
    device: collectDeviceEvidence(state),
    synckey: collectSyncKeyEvidence(state)
  };
  const verdicts = {
    storage: judgeStorage(evidence.storage),
    tunnel: judgeTunnel(evidence.tunnel),
    device: judgeDevice(evidence.device),
    synckey: judgeSyncKey(evidence.synckey)
  };

  // blocked 与 ready 是两件事：ready 说这一步自己成不成，
  // blocked 说管理员现在该不该碰它。只有 not ready 会让四个红灯一起亮，
  // 管理员无法判断从哪儿下手——那正是「控制台没有『你还没配置完』这个概念」的症状。
  let blockedBy = null;
  const steps = SETUP_STEP_IDS.map((id) => {
    const verdict = verdicts[id];
    const step = {
      id,
      title: STEP_TITLES[id],
      hint: STEP_HINTS[id],
      ready: verdict.ready,
      blocked: blockedBy !== null,
      blockedBy,
      blockedReason: verdict.ready ? "" : verdict.reason,
      evidence: evidence[id]
    };
    if (!verdict.ready && blockedBy === null) {
      blockedBy = id;
    }
    return step;
  });

  const firstUnready = steps.find((step) => !step.ready) || null;
  return {
    complete: steps.every((step) => step.ready),
    currentStepId: firstUnready ? firstUnready.id : null,
    steps
  };
}

// 探针形状缺失、为空、checks 为 null 都走同一条路：所有探针项按 false 记。
function readChecks(health) {
  const checks = health && typeof health === "object" ? health.checks : null;
  const source = checks && typeof checks === "object" ? checks : {};
  return {
    singbox: source.singbox && typeof source.singbox === "object" ? source.singbox : {},
    storage: source.storage && typeof source.storage === "object" ? source.storage : {},
    probeAvailable: Boolean(checks && typeof checks === "object")
  };
}

function collectStorageEvidence(state, checks) {
  const storage = state?.storage || {};
  return {
    probeAvailable: checks.probeAvailable,
    endpointReachable: checks.storage.endpointReachable === true,
    dataWritable: checks.storage.dataWritable === true,
    // 出厂口令是「管理员没配过」的强证据：探针能连上只说明 MinIO 活着。
    usesDefaultCredentials: String(storage.secretAccessKey || "") === DEFAULT_STORAGE_SECRET_PLACEHOLDER,
    endpoint: String(storage.endpoint || "")
  };
}

function collectTunnelEvidence(state, checks) {
  const tunnel = state?.tunnel || {};
  const pid = Number(checks.singbox.pid);
  return {
    probeAvailable: checks.probeAvailable,
    // 时间戳是管理员动作留下的痕迹，protocol 字段不是。
    configWrittenAt: tunnel.lastConfigWrittenAt || null,
    appliedAt: tunnel.lastAppliedAt || null,
    restartRequired: tunnel.restartRequired === true,
    processAlive: checks.singbox.processAlive === true,
    portReady: checks.singbox.portReady === true,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null
  };
}

function collectDeviceEvidence(state) {
  // 设备实体就是受管用户（summarizeAdminState 里 devices: state.users）。
  const users = Array.isArray(state?.users) ? state.users : [];
  const active = users.filter((user) => user && user.enabled !== false && !user.deletedAt);
  return {
    deviceCount: active.length,
    firstDeviceName: active[0]?.clientName || ""
  };
}

function collectSyncKeyEvidence(state) {
  const claims = Array.isArray(state?.claims) ? state.claims : [];
  return {
    issuedCount: claims.length,
    lastIssuedAt: claims[0]?.createdAt || null
  };
}

function judgeStorage(evidence) {
  if (!evidence.probeAvailable) {
    return { ready: false, reason: "存储状态未验证：拿不到健康探针结果，先确认服务自身在运行。" };
  }
  if (!evidence.endpointReachable) {
    return { ready: false, reason: `连不上存储端点${evidence.endpoint ? `（${evidence.endpoint}）` : ""}，请确认 MinIO 已启动且地址正确。` };
  }
  if (!evidence.dataWritable) {
    return { ready: false, reason: "数据目录不可写，容器挂载或权限需要修正。" };
  }
  if (evidence.usesDefaultCredentials) {
    return { ready: false, reason: "存储仍在使用出厂默认口令，请改成自己的密钥后再继续。" };
  }
  return { ready: true, reason: "" };
}

function judgeTunnel(evidence) {
  if (!evidence.configWrittenAt) {
    return { ready: false, reason: "隧道配置尚未写入：请先生成 VLESS 配置。默认协议字段不代表已经配置过。" };
  }
  if (!evidence.appliedAt) {
    return { ready: false, reason: "配置已写入但尚未应用，请执行「重启并应用」。" };
  }
  if (evidence.restartRequired) {
    return { ready: false, reason: "配置改动尚未应用，sing-box 仍在使用上一版配置，请重启并应用。" };
  }
  if (!evidence.probeAvailable) {
    return { ready: false, reason: "隧道状态未验证：拿不到健康探针结果，先确认服务自身在运行。" };
  }
  if (!evidence.processAlive) {
    return { ready: false, reason: "sing-box 进程没在运行，配置写在磁盘上不等于隧道在工作。" };
  }
  if (!evidence.portReady) {
    return { ready: false, reason: "sing-box 进程在运行，但监听端口没被探到，请检查端口占用与防火墙。" };
  }
  return { ready: true, reason: "" };
}

function judgeDevice(evidence) {
  if (evidence.deviceCount < 1) {
    return { ready: false, reason: "还没有任何设备。设备是签发 SyncKey 的对象，需要先注册一台。" };
  }
  return { ready: true, reason: "" };
}

function judgeSyncKey(evidence) {
  if (evidence.issuedCount < 1) {
    return { ready: false, reason: "还没有签发过 SyncKey，客户端拿不到配置。" };
  }
  return { ready: true, reason: "" };
}
