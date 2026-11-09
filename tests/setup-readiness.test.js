import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SETUP_STEP_IDS, summarizeSetupReadiness } from "../src/core/setupReadiness.js";

function state(overrides = {}) {
  return {
    tunnel: {
      lastConfigWrittenAt: "2026-10-29T10:00:00.000Z",
      lastAppliedAt: "2026-10-29T10:01:00.000Z",
      restartRequired: false
    },
    ...overrides
  };
}

function health(overrides = {}) {
  return {
    checks: {
      singbox: { processAlive: true, portReady: true, pid: 4321 },
      ...overrides
    }
  };
}

function enrollment(overrides = {}) {
  return {
    directoryEvidenceAvailable: true,
    activeRootCount: 1,
    verifiedRootIds: ["root_0123456789abcdef"],
    unverifiedRootCount: 0,
    configDigestAvailable: true,
    bootstrapApplyReceipt: true,
    dataOverlayApplyReceipt: true,
    authorizationEvidenceAvailable: true,
    authorizedRelationRootIds: ["root_0123456789abcdef"],
    ...overrides
  };
}

test("普通目录首用依赖目录、精确应用回执和有效设备授权，不依赖 MinIO", () => {
  assert.deepEqual(SETUP_STEP_IDS, ["directory", "repair", "pairing"]);
  const readiness = summarizeSetupReadiness(state(), health({
    storage: { endpointReachable: false, dataWritable: false }
  }), enrollment());
  assert.equal(readiness.complete, true);
  assert.equal(readiness.currentStepId, null);
  assert.ok(readiness.steps.every(step => step.ready && !step.blocked));
});

test("没有已验证目录时不就绪，后续修复和配对保持 blocked", () => {
  const readiness = summarizeSetupReadiness(state(), health(), enrollment({ activeRootCount: 0, verifiedRootIds: [] }));
  const byId = Object.fromEntries(readiness.steps.map(step => [step.id, step]));
  assert.equal(readiness.currentStepId, "directory");
  assert.equal(byId.directory.ready, false);
  assert.equal(byId.repair.blockedBy, "directory");
  assert.equal(byId.pairing.blockedBy, "directory");
});

test("缺少任一 supervisor overlay 回执时要求修复", () => {
  const readiness = summarizeSetupReadiness(state(), health(), enrollment({ dataOverlayApplyReceipt: false }));
  assert.equal(readiness.currentStepId, "repair");
  assert.equal(readiness.steps[1].ready, false);
  assert.match(readiness.steps[1].blockedReason, /连接设置尚未确认/);
  assert.equal(readiness.steps[2].blockedBy, "repair");
});

test("没有有效已消费关系授权时配对未就绪", () => {
  const readiness = summarizeSetupReadiness(state(), health(), enrollment({ authorizedRelationRootIds: [] }));
  assert.equal(readiness.currentStepId, "pairing");
  assert.equal(readiness.steps[2].ready, false);
  assert.match(readiness.steps[2].blockedReason, /设备完成目录配对/);
});

test("无法取得目录或授权证据时不把未知当作就绪", () => {
  const readiness = summarizeSetupReadiness(state(), null, {
    directoryEvidenceAvailable: false,
    authorizationEvidenceAvailable: false
  });
  assert.equal(readiness.complete, false);
  assert.equal(readiness.steps[0].ready, false);
  assert.equal(readiness.steps[1].ready, false);
  assert.equal(readiness.steps[2].ready, false);
});

test("readiness 判断不读取 S3/MinIO 默认配置或桶数量", () => {
  const source = readFileSync(new URL("../src/core/setupReadiness.js", import.meta.url), "utf8")
    .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(source, /storageEndpoint|endpointReachable|buckets\.length|secretAccessKey/);
  assert.match(source, /bootstrapApplyReceipt/);
  assert.match(source, /dataOverlayApplyReceipt/);
  assert.match(source, /authorizedRelationCount/);
});
