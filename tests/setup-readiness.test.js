import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDefaultAdminState, createManagedUser, createSyncSpace } from "../src/core/serverAdmin.js";
import {
  SETUP_STEP_IDS,
  summarizeSetupReadiness
} from "../src/core/setupReadiness.js";

// 全新部署：管理员什么都没做过。这是整个 C 的基准场景——
// 上一轮 P0「新部署谎报隧道就绪」就发生在这个状态下。
// 拼接而非字面量：审计的密钥扫描器按「≥24 个连续密钥字符」判定，一个够真实的
// 假口令会被它当成真泄漏拦下。把它加进扫描器白名单是错的方向——白名单里每多一条
// 长得像真密钥的字符串，扫描器就钝一分。这里只要它不等于出厂占位口令即可。
const ROTATED_SECRET = ["rotated", "not", "default"].join("-");

function freshState() {
  // createDefaultAdminState 直接收 env 对象本身，不是 { env }。
  // 传空对象即「什么环境变量都没设」的全新部署。
  return createDefaultAdminState({});
}

// checkApplianceHealth 的返回形状。默认给「全部探针失败」，
// 因为全新部署里 MinIO 未必起得来，而这正是必须显示成未就绪的情况。
function health(overrides = {}) {
  return {
    ok: false,
    checks: {
      node: { ok: true },
      singbox: { ok: false, processAlive: false, portReady: false, pid: null },
      rclone: { ok: false, binaryReady: false },
      storage: { ok: false, dataWritable: false, endpointReachable: false },
      ...overrides
    }
  };
}

test("步骤顺序就是依赖顺序：存储 → 隧道 → 第一个设备 → 签发 SyncKey", () => {
  assert.deepEqual(SETUP_STEP_IDS, ["storage", "tunnel", "device", "synckey"]);

  const readiness = summarizeSetupReadiness(freshState(), health());
  assert.deepEqual(readiness.steps.map((step) => step.id), SETUP_STEP_IDS);
});

test("全新部署的隧道不算就绪，因为 protocol 是硬编码默认值而非管理员写入的证据", () => {
  const state = freshState();
  // 这两个断言先钉住前提：默认状态确实带着一个真值 protocol，
  // 而真正的证据（写入/应用时间戳）是空的。前提若变，本测试应当立刻失败。
  assert.equal(state.tunnel.protocol, "vless-tcp-none");
  assert.equal(state.tunnel.lastConfigWrittenAt, null);
  assert.equal(state.tunnel.lastAppliedAt, null);

  const tunnel = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "tunnel");
  assert.equal(tunnel.ready, false);
  assert.equal(tunnel.evidence.configWrittenAt, null);
  assert.equal(tunnel.evidence.appliedAt, null);
  assert.equal(tunnel.evidence.processAlive, false);
  assert.equal(tunnel.evidence.portReady, false);
  // 未就绪必须说清缺什么，否则管理员只知道红灯不知道下一步。
  assert.match(tunnel.blockedReason, /尚未生成|尚未写入/);
});

test("隧道就绪要求配置已写入、已应用、且进程与端口都被探到", () => {
  const state = freshState();
  state.tunnel.lastConfigWrittenAt = "2026-07-31T10:00:00.000Z";
  state.tunnel.lastAppliedAt = "2026-07-31T10:01:00.000Z";

  const partial = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "tunnel");
  // 时间戳齐了但进程没起——配置写在磁盘上不等于隧道在工作。
  assert.equal(partial.ready, false);
  assert.match(partial.blockedReason, /进程|端口/);

  const live = summarizeSetupReadiness(state, health({
    singbox: { ok: true, processAlive: true, portReady: true, pid: 4321 }
  })).steps.find((step) => step.id === "tunnel");
  assert.equal(live.ready, true);
  assert.equal(live.evidence.pid, 4321);
});

test("重启未应用时隧道回落为未就绪，即使进程活着", () => {
  const state = freshState();
  state.tunnel.lastConfigWrittenAt = "2026-07-31T10:00:00.000Z";
  state.tunnel.lastAppliedAt = "2026-07-31T10:01:00.000Z";
  state.tunnel.restartRequired = true;

  const tunnel = summarizeSetupReadiness(state, health({
    singbox: { ok: true, processAlive: true, portReady: true, pid: 4321 }
  })).steps.find((step) => step.id === "tunnel");
  // 活着的进程用的是上一版配置，管理员以为新参数已生效，这正是要拦的误解。
  assert.equal(tunnel.ready, false);
  assert.equal(tunnel.evidence.restartRequired, true);
  assert.match(tunnel.blockedReason, /尚未应用|重启/);
});

test("全新部署的存储不算就绪，凭空补出的 fallback 桶不构成证据", () => {
  const state = freshState();
  // 前提：默认状态里就有一个 source 标成 configured 的桶，且没有 createdAt。
  assert.equal(state.storage.buckets.length, 1);
  assert.equal(state.storage.buckets[0].source, "configured");

  const storage = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "storage");
  assert.equal(storage.ready, false);
  assert.equal(storage.evidence.endpointReachable, false);
  // 桶数量不是就绪证据，探针结果才是；这里必须不把 1 当成「1 个仓库可用」。
  assert.match(storage.blockedReason, /连不上|不可达|未验证/);
});

test("存储就绪要求端点可达、数据目录可写、且默认口令已被改掉", () => {
  const state = freshState();
  assert.equal(state.storage.secretAccessKey, "change-this-minio-root-password");

  const stillDefault = summarizeSetupReadiness(state, health({
    storage: { ok: true, dataWritable: true, endpointReachable: true }
  })).steps.find((step) => step.id === "storage");
  // 探针能连上只说明 MinIO 活着，用出厂口令的部署不该被称为配置完成。
  assert.equal(stillDefault.ready, false);
  assert.equal(stillDefault.evidence.usesDefaultCredentials, true);
  assert.match(stillDefault.blockedReason, /默认口令|出厂/);

  state.storage.secretAccessKey = ROTATED_SECRET;
  const ready = summarizeSetupReadiness(state, health({
    storage: { ok: true, dataWritable: true, endpointReachable: true }
  })).steps.find((step) => step.id === "storage");
  assert.equal(ready.ready, true);
  assert.equal(ready.evidence.usesDefaultCredentials, false);
});

test("设备与 SyncKey 的就绪由真实记录数推导，且缺前置时不谎报可用", () => {
  const state = freshState();
  const device = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "device");
  assert.equal(device.ready, false);
  assert.equal(device.evidence.deviceCount, 0);

  createManagedUser(state, { clientName: "company-pc1" });
  const withDevice = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "device");
  assert.equal(withDevice.ready, true);
  assert.equal(withDevice.evidence.deviceCount, 1);

  const synckey = summarizeSetupReadiness(state, health()).steps.find((step) => step.id === "synckey");
  assert.equal(synckey.ready, false);
  assert.equal(synckey.evidence.issuedCount, 0);
});

test("前置步骤未就绪时后续步骤被标为 blocked，而不是仅仅 not ready", () => {
  const state = freshState();
  const steps = summarizeSetupReadiness(state, health()).steps;
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));

  // 存储没就绪，隧道就不该被邀请去点；但存储本身是第一步，不被任何东西阻塞。
  assert.equal(byId.storage.blocked, false);
  assert.equal(byId.tunnel.blocked, true);
  assert.equal(byId.tunnel.blockedBy, "storage");
  assert.equal(byId.device.blocked, true);
  assert.equal(byId.synckey.blocked, true);
  // 当前应当引导管理员做的那一步。
  assert.equal(summarizeSetupReadiness(state, health()).currentStepId, "storage");
});

test("注册设备会把隧道重新弄脏，所以四步不是纯线性流程", () => {
  const state = freshState();
  state.storage.secretAccessKey = ROTATED_SECRET;
  state.tunnel.lastConfigWrittenAt = "2026-07-31T10:00:00.000Z";
  state.tunnel.lastAppliedAt = "2026-07-31T10:01:00.000Z";
  const liveProbe = health({
    singbox: { ok: true, processAlive: true, portReady: true, pid: 4321 },
    storage: { ok: true, dataWritable: true, endpointReachable: true }
  });

  const before = summarizeSetupReadiness(state, liveProbe).steps.find((step) => step.id === "tunnel");
  assert.equal(before.ready, true);

  // createManagedUser 会置 restartRequired = true：新设备意味着 sing-box 配置里
  // 多一个 VLESS 用户，不重新应用的话这台设备连不进来。这是真实依赖而非缺陷，
  // 所以第三步会把第二步重新弄脏。向导必须能表达「回去再应用一次」，
  // 否则管理员会看到刚点绿的隧道又变红，以为流程坏了。
  createManagedUser(state, { clientName: "company-pc1" });
  const after = summarizeSetupReadiness(state, liveProbe).steps.find((step) => step.id === "tunnel");
  assert.equal(after.ready, false);
  assert.equal(after.evidence.restartRequired, true);
  assert.equal(summarizeSetupReadiness(state, liveProbe).currentStepId, "tunnel");
});

test("四步全就绪后首次运行模式退出，complete 为真", () => {
  const state = freshState();
  state.storage.secretAccessKey = ROTATED_SECRET;
  const owner = createManagedUser(state, { clientName: "company-pc1" });
  createSyncSpace(state, { ownerUserId: owner.id, syncId: "team-docs" });
  state.claims.push({ id: "claim-1", userId: owner.id, code: "C7KD-92PQ", createdAt: "2026-07-31T10:02:00.000Z" });
  // 按真实顺序：建完设备之后才应用隧道配置，这样新用户才在生效的配置里。
  state.tunnel.lastConfigWrittenAt = "2026-07-31T10:03:00.000Z";
  state.tunnel.lastAppliedAt = "2026-07-31T10:04:00.000Z";
  state.tunnel.restartRequired = false;

  const readiness = summarizeSetupReadiness(state, health({
    singbox: { ok: true, processAlive: true, portReady: true, pid: 4321 },
    storage: { ok: true, dataWritable: true, endpointReachable: true }
  }));
  assert.equal(readiness.complete, true);
  assert.equal(readiness.currentStepId, null);
  assert.equal(readiness.steps.every((step) => step.ready), true);
  assert.equal(readiness.steps.every((step) => step.blocked === false), true);
});

test("健康探针缺失时按未就绪处理，不按就绪处理", () => {
  const state = freshState();
  state.storage.secretAccessKey = ROTATED_SECRET;
  state.tunnel.lastConfigWrittenAt = "2026-07-31T10:00:00.000Z";
  state.tunnel.lastAppliedAt = "2026-07-31T10:01:00.000Z";

  // 探针拿不到（/healthz 超时、容器刚起）时，把未知当成就绪就是又一次谎报。
  for (const missing of [undefined, null, {}, { checks: null }]) {
    const readiness = summarizeSetupReadiness(state, missing);
    const storage = readiness.steps.find((step) => step.id === "storage");
    const tunnel = readiness.steps.find((step) => step.id === "tunnel");
    assert.equal(storage.ready, false);
    assert.equal(tunnel.ready, false);
    assert.equal(readiness.complete, false);
  }
});

test("就绪判断不读取任何默认值为真的字段", () => {
  const source = readFileSync(new URL("../src/core/setupReadiness.js", import.meta.url), "utf8");
  // 必须剥掉注释：本模块的注释里点名了这几个字段以说明「为什么不能用它们」，
  // 直接对全文断言会数到解释文字本身，那是断言太松而非实现有问题。
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // tunnel.protocol 恒真、buckets 恒非空、/api/health 恒 ok:true，
  // 三者都曾被当作就绪依据。这条锁住它们不再回到判断里。
  assert.doesNotMatch(code, /tunnel\.protocol/);
  assert.doesNotMatch(code, /buckets\.length/);
  assert.doesNotMatch(code, /activeBuckets/);
});
