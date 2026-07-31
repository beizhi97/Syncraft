# Syncraft v0.4 设计评审：协议扩展与客户端形态

状态：设计评审草案，等待评审通过后进入实施。尚未动代码。

记录日期：2026-07-31。

上游文档：`docs/SYNC_ID_PRODUCT_REQUIREMENT.md`（需求）、`../UI_PRODUCT_DESIGN_REVIEW_2026-07-30.md`（设计评审）、`../UI_REVIEW_REPORT_2026-07-30.md`（四席位技术评审）。

本文档回应 `SYNC_ID_PRODUCT_REQUIREMENT.md` §6 的要求：涉及协议字段的变化须进入单独设计评审。

## 1. 已确认的产品决策

2026-07-31 确认：

1. 贯彻落实 SyncKey 模型的承诺——管理员决定一切，用户粘贴一个字符串就能工作。
2. 双向同步是必备能力，不降级。
3. A/B 进入 v0.4，按需扩展协议携带 syncId 与 role。
4. transfers/streams 由客户端不再发送，对齐需求 §3。
5. 控制台补建设备入口。

## 2. 决策 1 与决策 2 如何同时成立

这两条初看冲突：既然管理员决定一切，用户又必须拥有双向同步。实际上它们互相成立，前提是把「方向」从用户选项改为推导结果。

设计：管理员为同步空间设定**用途**，成员**角色**再收窄可执行的方向。

| 空间用途 | owner / writer | reader |
| --- | --- | --- |
| 备份（backup） | 仅上传 | 拒绝入座 |
| 分发（distribution） | 仅上传 | 仅下载 |
| 协作（collaboration） | 双向 | 仅下载 |

有效方向 = f(空间用途, 成员角色)。双向因此保持一等能力，但它是管理员的策略表达，不是用户在下拉框里的一次猜测。

这样做同时消除了一整类非法状态。当前 `src/core/minioPolicy.js:13` 对 reader 返回空写动作集合，MinIO 是最终权威；而 `client/public/index.html:79-83` 把上传、下载、双向作为三个等权选项。reader 选择上传，UI 全程无提示，直到运行时被存储层拒绝。方向一旦由角色推导，这个失败在界面上就不可能被表达出来。

它也让实现与需求 §5 的「单写入端、多读取端」安全默认自然对齐：默认用途为分发，只有管理员显式选择协作用途时才出现双向。

## 3. 协议扩展

### 3.1 现状：翻译在哪里发生

服务端模型早已完备。`state.syncSpaces` 与 `state.syncSpaceMemberships` 已经存在，membership 携带 `role`（经 `normalizeSyncSpaceRole` 归一）与 `storageTarget{bucket, prefix}`。

`createClaim`（`src/core/serverAdmin.js`）在第 735 行通过 `requireActiveSyncSpaceMembership` 取得 membership，claim 记录了 `syncSpaceId`（第 759 行）与 `requestedRole: membership.role`（第 760 行）。

但 `buildProfileForUser`（`src/core/serverAdmin.js:1348-1388`）接收 `syncSpaceId`、`storageTarget`、`storageCredentials` 三个入参，发出的 profile 只包含 `version`、`profileId`、`clientName`、`issuedAt`、`expiresAt`、`tunnel`、`heartbeat`、`storage`、`defaults`。**syncSpaceId 与 role 在此被整个丢弃。**

`profileProtocol.js` 的字段计数印证了这一点：`syncSpaceId` 0 次、`storageTarget` 0 次、`role` 0 次，而 `remoteFolder` 9 次、`serverSpace` 6 次、`direction` 6 次。

这就是「客户端与服务端不是同一代产品」的确切机制：服务端解析出新模型，在协议边界把它翻译回旧前缀模型。所有下游症状——客户端不知道自己在哪个空间、不知道自己的角色、把方向当作用户选项、远端目标摘要是空壳——都是这一次丢弃的后果。

### 3.2 v0.4 profile 新增字段

`PROFILE_VERSION` 由 1 升到 2，新增两个块：

```text
profile.syncSpace = {
  id            // syncSpaceId，稳定标识
  displayName   // 人类可读名称，客户端界面显示这个
  mode          // "backup" | "distribution" | "collaboration"
}

profile.authorization = {
  role            // "owner" | "writer" | "reader"
  directions      // 服务端推导后的合法方向数组，客户端不再自行计算
  allowDelete     // 布尔，与 minioPolicy 的 allowDelete 同源
}
```

`directions` 由服务端下发而非客户端推导，是刻意的：推导规则若在两端各写一份，就会重新产生本轮修复的那类漂移。客户端只负责渲染服务端给出的集合；集合只有一个元素时不显示选择器。

`storage.prefix` 保持现状。它已经由 `storageTarget.prefix` 在服务端算出受管前缀，这正是客户端 `serverSpace` 与 `remoteFolder` 冗余的依据——删除它们不是 UI 偏好，而是消除同一事实的第二个矛盾来源。

### 3.3 兼容策略

`buildProfileForUser` 依据客户端声明的协议版本分别发 v1 与 v2 profile。v1 客户端继续收到今天的字段集，行为不变；v2 客户端收到新增块，并且不再收到 `serverSpace` 与 `remoteFolder`。

服务端保留 bucket 与 prefix 作为内部实现与兼容层，符合需求 §6。

`docs/INTERFACE_CONTRACT.md`、`docs/protocol/schemas/` 下的 schema、以及 `scripts/audit-release.mjs` 的字符串锚点需同步更新。新增错误码须走完整链路：`src/core/errors.js` 的 `DEFAULT_STATUS_BY_CODE` → `docs/protocol/schemas/error-codes.json` 的 `stableHttpCodes` → `docs/INTERFACE_CONTRACT.md` → 两份 `app.js` 的 `formatError`。上一轮 P0 第一项正是漏走这条链路造成的：三个 sync-space 错误码未注册，403/409 被压平成 500。

## 4. 客户端形态

主界面收敛到三件事：你被授权同步什么（`syncSpace.displayName`，真实名称）、哪个本地文件夹（用户唯一真正必须选的东西）、一个主操作。

从主流程移除：同步空间二元开关、远端子目录、并行文件数、单文件线程数、计划任务。方向仅在 `authorization.directions` 多于一个元素时出现。

决策 4 由此自然完成：客户端不再发送 transfers 与 streams，服务端 `normalizePositiveInteger` 的 `defaultValue` 分支从此可达，管理员下发的默认值真正生效。这是通过删除而非接线解决的——上一轮 P0 第三项随之消失。

带宽限制与镜像删除保留为明确标注的高级覆盖项，默认关闭。理由是它们改变的是用户本地资源与本地数据的处置方式，与「授权范围」不是同一类决策。

## 5. 决策 2 的实施代价

需求 §5 列出七项前置条件，作为开放多设备写入的门槛。决策 2 把它们从可选变为必做。当前状态：

已具备三项。删除传播规则与危险删除确认——`src/core/rclone.js:69` 的 `--max-delete` 加第 70-71 行的 `--backup-dir`，加引擎侧双层确认。成员加入、移除、凭据轮换——服务端 memberships 与 `ensureMembershipStorageCredentials`。断网重连韧性部分具备——`src/core/rclone.js:74-79` 的 bisync 已带 `--check-access --resilient` 与独立 `--workdir`。

缺四项。同一同步空间的任务互斥或并发协调：无任何按空间的写锁，`src/core/serverStateLock.js` 是状态文件锁，`client/src/Launcher.cs` 的 mutex 是单实例启动锁，二者都不解决这个问题。同名文件并发修改的冲突检测与冲突副本策略：`conflict`、`--resync`、`track-renames` 在 rclone 参数构造中命中 0。同步完成后的清单、大小与内容完整性验证：`rclone.js` 与 `syncRun.js` 中无 `rclone check` 或 checksum 调用。按同步 ID 隔离日志、状态、配额与审计：客户端侧尚无 syncId 概念，隔离无从谈起。

建议排期：先落**按同步空间的单写入端互斥锁**。它最便宜，直接满足七项中的「任务互斥」，并且让「单写入端、多读取端」从文档承诺变成运行时强制。冲突副本策略与完整性验证随后。协作用途在互斥锁到位前，应保持为管理员可选但界面明示实验状态。

不建议因为四项缺口未齐就阻塞 v0.4 的协议与形态设计——协议扩展本身不引入新的并发风险，而缺少 syncId 隔离恰恰是完整性验证与配额隔离无法实施的前置障碍。

## 6. 决策 5 的实际成本

比预估低得多。`createManagedUser` 已实现于 `src/core/serverAdmin.js:610`，且已路由为 POST `/api/admin/users/create`（`src/server.js:364-372`），请求 schema 为 `PROTOCOL_REQUESTS.SERVER_ADMIN_USER_CREATE`。控制台 UI 对它的引用数为 0。

因此这是纯 UI 增补，无后端工作。设备只能作为 `createClaim` 副产品产生的鸡生蛋问题，是一个从未接线的现成端点。

建议与上一轮建议 C 的首次运行流程合并实施：存储 → 隧道 → 第一个设备 → 签发 SyncKey。就绪状态必须从证据推导（配置写入与应用时间戳、实时存储探针），永不从默认值为真推导。

## 7. 实施纪律

每条回归测试先对旧代码跑一遍确认变红，否则它只是在描述新实现而没有判别力。

`scripts/audit-release.mjs` 含大量精确字符串锚点，UI 文案改动会触发契约漂移告警，需同步更新。

沙箱环境已知有 19 个 powershell 相关红项，非回归。

## 8. 待评审确认

第一，空间用途三分（备份／分发／协作）是否是正确的切分，以及默认用途取分发是否可接受。

第二，`authorization.directions` 由服务端下发而非客户端推导，是否认可这一取舍。

第三，协作用途在互斥锁落地前是否允许启用，若允许，界面如何标注实验状态。

第四，带宽限制与镜像删除保留为高级覆盖项是否合适，或应一并收归管理员策略。
