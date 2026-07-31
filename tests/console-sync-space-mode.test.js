import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PROTOCOL_REQUESTS, parseProtocolRequest } from "../src/core/protocolSchemas.js";
import { SYNC_SPACE_MODES } from "../src/core/syncSpaceMode.js";
import {
  createDefaultAdminState,
  createManagedUser,
  createSyncSpace,
  summarizeAdminSyncSpace
} from "../src/core/serverAdmin.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 白名单陷阱：请求解析按字段白名单重建对象，mode 不在白名单里就会在到达
// createSyncSpace 之前被静默丢弃——控制台看起来有个能用的选择器，实际什么都没做。
test("admin sync space create request carries mode through the protocol whitelist", () => {
  const parsed = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SYNC_SPACE_CREATE, {
    ownerUserId: "user-1",
    syncId: "team-documents",
    mode: "backup"
  });
  assert.equal(parsed.mode, "backup");
});

test("admin sync space create rejects an unknown mode instead of silently defaulting", () => {
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SYNC_SPACE_CREATE, {
      ownerUserId: "user-1",
      syncId: "team-documents",
      mode: "archive"
    }),
    // 静默回落到默认用途会把「仅上传」的成员显示成可双向，属于安全性错误。
    (error) => error?.code === "validation_failed"
  );
});

test("admin sync space create still defaults mode when the console omits it", () => {
  const parsed = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SYNC_SPACE_CREATE, {
    ownerUserId: "user-1",
    syncId: "team-documents"
  });
  // 省略与填错是两件事：省略是兼容旧调用方，填错是管理员意图不明。
  assert.equal(Object.hasOwn(parsed, "mode"), false);
});

test("an admin-created space keeps the mode the console asked for", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "console-owner" });
  for (const mode of SYNC_SPACE_MODES) {
    const space = createSyncSpace(state, {
      ownerUserId: owner.id,
      syncId: `space-${mode}`,
      mode
    });
    assert.equal(summarizeAdminSyncSpace(state, space).mode, mode);
  }
});

test("console exposes sync space mode at creation and names each space one way", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  // 用途必须在创建时可选：服务端按 mode×role 推导方向，建完之后没有改 mode 的接口，
  // 建错就只能删空间重建。
  assert.match(html, /id="newSyncSpaceMode"/);
  for (const mode of SYNC_SPACE_MODES) {
    assert.match(html, new RegExp(`value="${mode}"`));
  }
  assert.match(app, /mode: fields\.newSyncSpaceMode\.value/);

  // 两个界面对同一个空间的说法必须一致：控制台也用「备份/分发/协作」。
  assert.match(app, /function formatSyncSpaceMode\(mode\)/);
  assert.match(app, /backup: "备份", distribution: "分发", collaboration: "协作"/);

  // 私有空间本身就是一个有真实 syncId 的同步空间，不是「没有空间」这个替代项。
  assert.doesNotMatch(html, /设备私有空间/);
  assert.doesNotMatch(app, /设备私有空间/);
});
