import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_VERSION,
  PROFILE_URI_PREFIX,
  SUPPORTED_PROFILE_VERSIONS,
  decodeImportProfile,
  encodeImportProfile,
  normalizeImportProfile
} from "../src/core/profileProtocol.js";
import {
  createClaim,
  createDefaultAdminState,
  createManagedUser,
  createSyncSpace
} from "../src/core/serverAdmin.js";

const baseProfile = {
  clientName: "v2-device",
  tunnel: { uri: "vless://11111111-1111-4111-8111-111111111111@example.com:45678?type=tcp&security=none#sfsc" },
  heartbeat: { scheme: "sfsc-hmac-sha256-v1", secret: "a".repeat(64) },
  storage: {
    type: "s3",
    remoteName: "home-minio",
    endpoint: "http://minio:9000",
    bucket: "home-sync",
    accessKeyId: "sfsc-key",
    secretAccessKey: "sfsc-secret",
    prefix: "shared/space-abc"
  }
};

test("the protocol is at version 2 and still accepts version 1 payloads", () => {
  assert.equal(PROFILE_VERSION, 2);
  assert.deepEqual(SUPPORTED_PROFILE_VERSIONS, [1, 2]);
});

test("the envelope prefix stays v1 so an old client gets an actionable version error", () => {
  // 前缀标识信封编码，没有变；版本在载荷里自述。若把前缀也改成 v2#，
  // 旧客户端会在 decodeImportProfilePayload 阶段报 import_code_invalid
  // （「导入码格式不对」），而不是 unsupported_profile_version（「请升级客户端」）。
  assert.equal(PROFILE_URI_PREFIX, "sfsc://import/v1#");
  assert.ok(encodeImportProfile(baseProfile).startsWith("sfsc://import/v1#"));
});

test("a version 1 profile keeps working and reports no derived authorization", () => {
  const v1 = normalizeImportProfile({ ...baseProfile, version: 1 });
  assert.equal(v1.version, 1);
  // v1 载荷根本不携带角色，服务端也无从补出来；不能凭空造一个 authorization。
  assert.equal(Object.hasOwn(v1, "authorization"), false);
  assert.equal(Object.hasOwn(v1, "syncSpace"), false);
});

test("a version 3 profile is still rejected", () => {
  assert.throws(
    () => normalizeImportProfile({ ...baseProfile, version: 3 }),
    (error) => {
      assert.equal(error.code, "unsupported_profile_version");
      return true;
    }
  );
});

test("normalizeImportProfile carries syncSpace and authorization through a round trip", () => {
  const input = {
    ...baseProfile,
    version: 2,
    syncSpace: { id: "space-abc", syncId: "team-documents", mode: "collaboration" },
    authorization: { role: "writer", directions: ["upload", "download", "bidirectional"], allowDelete: false }
  };
  const normalized = normalizeImportProfile(input);
  assert.deepEqual(normalized.syncSpace, { id: "space-abc", syncId: "team-documents", mode: "collaboration" });
  assert.deepEqual(normalized.authorization, {
    role: "writer",
    directions: ["upload", "download", "bidirectional"],
    allowDelete: false
  });

  // 白名单式重建最容易在这里静默丢字段，所以连编码解码一起验。
  const decoded = decodeImportProfile(encodeImportProfile(input));
  assert.deepEqual(decoded.syncSpace, normalized.syncSpace);
  assert.deepEqual(decoded.authorization, normalized.authorization);
});

test("a client cannot widen its own directions by editing the payload", () => {
  // reader 谎报三个方向也只会得到 download：方向由 mode x role 在归一化时重新推导。
  const tampered = normalizeImportProfile({
    ...baseProfile,
    version: 2,
    syncSpace: { id: "space-abc", syncId: "team-documents", mode: "distribution" },
    authorization: { role: "reader", directions: ["upload", "download", "bidirectional"], allowDelete: true }
  });
  assert.deepEqual(tampered.authorization.directions, ["download"]);
  assert.equal(tampered.authorization.allowDelete, false);
});

test("an issued SyncKey profile names the sync space and the derived directions", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "profile-owner" });
  const space = createSyncSpace(state, {
    ownerUserId: owner.id,
    syncId: "team-documents",
    mode: "collaboration"
  });
  const issued = createClaim(state, {
    clientName: "profile-member",
    syncSpaceId: space.id,
    requestedRole: "reader"
  });

  assert.equal(issued.profile.version, 2);
  assert.deepEqual(issued.profile.syncSpace, {
    id: space.id,
    syncId: "team-documents",
    mode: "collaboration"
  });
  assert.deepEqual(issued.profile.authorization, {
    role: "reader",
    directions: ["download"],
    allowDelete: false
  });
});

test("a device's own private space is issued with its real sync id, not a bare bucket prefix", () => {
  const state = createDefaultAdminState();
  const issued = createClaim(state, { clientName: "solo-device" });
  assert.equal(issued.profile.version, 2);
  assert.ok(issued.profile.syncSpace.syncId, "private space must still name itself");
  assert.equal(issued.profile.syncSpace.mode, "collaboration");
  // 单人自持是主用例：自己的空间必须保留双向，否则换机恢复做不了。
  assert.deepEqual(issued.profile.authorization.directions, ["upload", "download", "bidirectional"]);
  assert.equal(issued.profile.authorization.role, "owner");
});
