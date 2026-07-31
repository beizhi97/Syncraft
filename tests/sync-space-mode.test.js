import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultAdminState, createClaim, createManagedUser, createSyncSpace, normalizeAdminState, summarizeAdminSyncSpace } from "../src/core/serverAdmin.js";
import { createHttpError, isStableErrorCode, normalizeHttpError } from "../src/core/errors.js";
import {
  SYNC_SPACE_MODES,
  DEFAULT_SYNC_SPACE_MODE,
  PRIVATE_SYNC_SPACE_MODE,
  normalizeSyncSpaceMode,
  requireSyncSpaceMode,
  deriveSyncDirections,
  deriveAuthorization
} from "../src/core/syncSpaceMode.js";

test("mode vocabulary is exactly the three documented purposes", () => {
  assert.deepEqual(SYNC_SPACE_MODES, ["backup", "distribution", "collaboration"]);
});

test("the safe default is distribution and private spaces stay bidirectional-capable", () => {
  // docs/V04_DESIGN_REVIEW.md 第 2 节：默认用途为分发，只有管理员显式选择协作才出现双向。
  assert.equal(DEFAULT_SYNC_SPACE_MODE, "distribution");
  // 设备私有空间只有一个 owner 成员，不存在第二个写入端，因此不受 §5 单写入端默认约束；
  // 若也降级为分发，既有安装的「换机恢复」能力会被静默删除。
  assert.equal(PRIVATE_SYNC_SPACE_MODE, "collaboration");
});

test("normalizeSyncSpaceMode is lenient for state loaded from disk", () => {
  assert.equal(normalizeSyncSpaceMode("backup"), "backup");
  assert.equal(normalizeSyncSpaceMode("  Collaboration  "), "collaboration");
  assert.equal(normalizeSyncSpaceMode(undefined), DEFAULT_SYNC_SPACE_MODE);
  assert.equal(normalizeSyncSpaceMode("nonsense"), DEFAULT_SYNC_SPACE_MODE);
});

test("requireSyncSpaceMode rejects admin input instead of silently downgrading it", () => {
  assert.equal(requireSyncSpaceMode(undefined), DEFAULT_SYNC_SPACE_MODE);
  assert.equal(requireSyncSpaceMode("backup"), "backup");
  assert.throws(() => requireSyncSpaceMode("nonsense"), (error) => {
    assert.equal(error.code, "validation_failed");
    return true;
  });
});

test("directions are derived from mode x role, never chosen by the client", () => {
  const matrix = {
    backup: { owner: ["upload"], writer: ["upload"], reader: [] },
    distribution: { owner: ["upload"], writer: ["upload"], reader: ["download"] },
    collaboration: {
      owner: ["upload", "download", "bidirectional"],
      writer: ["upload", "download", "bidirectional"],
      reader: ["download"]
    }
  };
  for (const mode of SYNC_SPACE_MODES) {
    for (const role of ["owner", "writer", "reader"]) {
      assert.deepEqual(
        deriveSyncDirections(mode, role),
        matrix[mode][role],
        `${mode} x ${role}`
      );
    }
  }
});

test("upload stays first so an existing install's default direction does not silently change", () => {
  // client/public/app.js 今天默认 upload。把 bidirectional 排在首位会让既有设备
  // 在升级后默认执行 bisync——这是需要初始化基准的破坏性操作，不能靠排序偷偷启用。
  assert.equal(deriveSyncDirections("collaboration", "owner")[0], "upload");
});

test("an unknown mode or role degrades to no directions rather than to write access", () => {
  assert.deepEqual(deriveSyncDirections("nonsense", "owner"), []);
  assert.deepEqual(deriveSyncDirections("collaboration", "nonsense"), []);
});

test("deriveAuthorization mirrors minioPolicy's allowDelete gate", () => {
  assert.deepEqual(
    deriveAuthorization({ mode: "collaboration", role: "writer", policy: { allowDelete: true } }),
    { role: "writer", directions: ["upload", "download", "bidirectional"], allowDelete: true }
  );
  // reader 在 minioPolicy 里拿到空写动作集合，allowDelete 必须同源为 false。
  assert.deepEqual(
    deriveAuthorization({ mode: "collaboration", role: "reader", policy: { allowDelete: true } }),
    { role: "reader", directions: ["download"], allowDelete: false }
  );
  // 缺省 policy 不开放删除。
  assert.equal(deriveAuthorization({ mode: "backup", role: "owner" }).allowDelete, false);
});

test("createSyncSpace records the mode and rejects a misspelled one", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "mode-owner" });

  assert.equal(createSyncSpace(state, { ownerUserId: owner.id, syncId: "default-mode" }).mode, "distribution");
  assert.equal(
    createSyncSpace(state, { ownerUserId: owner.id, syncId: "team-docs", mode: "collaboration" }).mode,
    "collaboration"
  );
  assert.throws(
    () => createSyncSpace(state, { ownerUserId: owner.id, syncId: "typo-mode", mode: "colaboration" }),
    (error) => error?.code === "validation_failed"
  );
});

test("mode survives a state reload", () => {
  // normalizeSyncSpaceState 按白名单重建 syncSpace 记录，漏读 mode 会让管理员的
  // 用途设置在下次进程启动后静默退回分发——权限模型被悄悄改掉。
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "reload-owner" });
  createSyncSpace(state, { ownerUserId: owner.id, syncId: "reload-space", mode: "backup" });

  const reloaded = normalizeAdminState(JSON.parse(JSON.stringify(state)));
  assert.equal(reloaded.syncSpaces.find((space) => space.syncId === "reload-space").mode, "backup");
});

test("a device's own private space keeps bidirectional after an upgrade", () => {
  // 既有 state 里没有 mode 字段。这条断言锁住升级路径：私有空间不能被降级成仅上传。
  const legacy = normalizeAdminState({
    users: [{
      id: "user-legacy",
      clientName: "legacy-device",
      createdAt: "2026-01-01T00:00:00.000Z",
      storage: { bucket: "home-sync", prefix: "devices/legacy-device" }
    }]
  });
  const space = legacy.syncSpaces.find((item) => item.storageTarget.prefix === "devices/legacy-device");
  assert.equal(space.mode, "collaboration");
  assert.deepEqual(deriveSyncDirections(space.mode, "owner"), ["upload", "download", "bidirectional"]);
});

test("the console summary exposes mode so an admin can see the current purpose", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "summary-owner" });
  const space = createSyncSpace(state, { ownerUserId: owner.id, syncId: "summary-space", mode: "backup" });
  assert.equal(summarizeAdminSyncSpace(state, space).mode, "backup");
});

test("a backup space refuses a reader instead of seating a member with no legal direction", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "backup-owner" });
  const space = createSyncSpace(state, { ownerUserId: owner.id, syncId: "backup-space", mode: "backup" });

  assert.throws(
    () => createClaim(state, { clientName: "backup-reader", syncSpaceId: space.id, requestedRole: "reader" }),
    (error) => {
      assert.equal(error.code, "sync_space_role_not_allowed");
      assert.equal(error.status, 409);
      return true;
    }
  );
  // 被拒绝的成员不能留下半成品：既不该有成员资格，也不该留下设备记录。
  assert.equal(state.syncSpaceMemberships.some((item) => item.syncSpaceId === space.id && item.role === "reader"), false);
  assert.equal(state.users.some((user) => user.clientName === "backup-reader" && !user.deletedAt), false);

  // 同一个空间接受 writer。
  const ok = createClaim(state, { clientName: "backup-writer", syncSpaceId: space.id, requestedRole: "writer" });
  assert.equal(ok.claim.requestedRole, "writer");
});

test("distribution and collaboration spaces still accept readers", () => {
  for (const mode of ["distribution", "collaboration"]) {
    const state = createDefaultAdminState();
    const owner = createManagedUser(state, { clientName: `${mode}-owner` });
    const space = createSyncSpace(state, { ownerUserId: owner.id, syncId: `${mode}-space`, mode });
    const issued = createClaim(state, { clientName: `${mode}-reader`, syncSpaceId: space.id, requestedRole: "reader" });
    assert.equal(issued.claim.requestedRole, "reader", mode);
  }
});

test("the three sync space error codes survive normalizeHttpError", () => {
  // 这四个码此前只存在于 serverAdmin.js，未注册进 DEFAULT_STATUS_BY_CODE，
  // 结果 403/409 全被压平成 500 "Internal server error"，控制台无法分支。
  const expected = {
    sync_id_unavailable: 409,
    sync_space_access_denied: 403,
    sync_space_membership_exists: 409,
    sync_space_role_not_allowed: 409
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(isStableErrorCode(code), true, code);
    const normalized = normalizeHttpError(createHttpError(code));
    assert.equal(normalized.status, status, code);
    assert.equal(normalized.code, code, code);
  }
});
