import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { summarizeImportProfile } from "../src/core/profileProtocol.js";
import {
  createDefaultAdminState,
  createManagedUser,
  createSyncSpace,
  createClaim
} from "../src/core/serverAdmin.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function baseState() {
  return createDefaultAdminState({
    VLESS_PUBLIC_HOST: "sync.example.com",
    VLESS_PORT: "45678",
    PUBLIC_SERVER_URL: "http://127.0.0.1:8080"
  });
}

// createClaim 直接返回签发好的 profile；这里不走 redeem，因为被测对象是
// 「服务端算出的 profile 如何被 UI 摘要」，兑换环节与方向授权无关。
function issueProfile(state, { mode, role }) {
  const owner = createManagedUser(state, { clientName: `owner-${mode}` });
  const syncSpace = createSyncSpace(state, { ownerUserId: owner.id, syncId: `space-${mode}`, mode });
  const created = createClaim(state, {
    clientName: `pc-${role}`,
    syncSpaceId: syncSpace.id,
    requestedRole: role
  });
  return created.profile;
}

test("status profile summary carries the sync space and authorization the UI needs", () => {
  const state = baseState();
  const profile = issueProfile(state, { mode: "distribution", role: "reader" });
  const summary = summarizeImportProfile(profile);

  assert.equal(summary.syncSpace.syncId, "space-distribution");
  assert.equal(summary.syncSpace.mode, "distribution");
  assert.equal(summary.authorization.role, "reader");
  assert.deepEqual(summary.authorization.directions, ["download"]);
  assert.equal(summary.authorization.allowDelete, false);
});

test("status profile summary keeps the legacy shape when no sync space is bound", () => {
  const summary = summarizeImportProfile({
    version: 1,
    profileId: "profile-legacy",
    clientName: "legacy-pc",
    tunnel: { type: "vless", uri: "vless://11111111-1111-4111-8111-111111111111@example.com:443?type=tcp&security=reality&pbk=k&sni=example.com&fp=chrome#legacy" },
    storage: {
      type: "s3",
      remoteName: "home-minio",
      endpoint: "http://127.0.0.1:9000",
      bucket: "home-sync",
      accessKeyId: "legacy-pc",
      secretAccessKey: "legacy-secret",
      prefix: "devices/legacy-pc"
    }
  });

  // null 而不是编造一个默认授权：UI 用 null 判断「未知授权」并退回旧的三方向可选行为。
  assert.equal(summary.syncSpace, null);
  assert.equal(summary.authorization, null);
  assert.equal(summary.clientName, "legacy-pc");
});

test("summarizeImportProfile does not leak credentials alongside the new blocks", () => {
  const state = baseState();
  const profile = issueProfile(state, { mode: "collaboration", role: "owner" });
  const summary = summarizeImportProfile(profile);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.authorization.directions, ["upload", "download", "bidirectional"]);
  assert.ok(!serialized.includes(profile.storage.secretAccessKey));
  assert.ok(!serialized.includes(profile.heartbeat.secret));
  assert.ok(!serialized.includes(profile.tunnel.uri));
});

test("summarizeImportProfile returns copies so UI mutation cannot widen authorization", () => {
  const state = baseState();
  const profile = issueProfile(state, { mode: "backup", role: "writer" });
  const summary = summarizeImportProfile(profile);

  summary.authorization.directions.push("download");
  const fresh = summarizeImportProfile(profile);
  assert.deepEqual(fresh.authorization.directions, ["upload"]);
});

test("client UI derives sync direction from authorization instead of local choice", async () => {
  const [appSource, htmlSource] = await Promise.all([
    readFile(join(projectRoot, "client", "public", "app.js"), "utf8"),
    readFile(join(projectRoot, "client", "public", "index.html"), "utf8")
  ]);

  // 客户端自造的「同步空间」和「远端子目录」必须消失：serverSpace=shared 会把远端前缀
  // 指到桶根 shared/，而 MinIO 策略只授予 ${prefix}/*，那是一个必然被拒的选项。
  assert.ok(!htmlSource.includes('id="serverSpace"'));
  assert.ok(!htmlSource.includes('id="remoteFolder"'));
  assert.ok(!appSource.includes("readRemoteFolderField"));
  assert.ok(!appSource.includes("updateRemoteTargetDraft"));

  assert.ok(appSource.includes("function allowedSyncDirections"));
  assert.ok(appSource.includes("function applySyncDirectionAuthorization"));
  assert.ok(appSource.includes("sync_direction_not_authorized"));
  assert.ok(appSource.includes('id="directionFixedHint"') || htmlSource.includes('id="directionFixedHint"'));
  // 状态刷新时必须重算，否则首次导入 SyncKey 后选择器不会收窄。
  assert.match(appSource, /renderRemoteTargetSummary\([^)]*\);\n(?:\s*\/\/[^\n]*\n)*\s*applySyncDirectionAuthorization\(\);/);
});
