# 同步 ID 与设备授权实施计划

状态：已确认，待设计评审和实现。

优先级：多设备同步 Beta 上线硬门槛。

记录日期：2026-07-13。

关联需求：`docs/SYNC_ID_PRODUCT_REQUIREMENT.md`。

## 1. 不可破坏的安全边界

```text
同步 ID：标识一份逻辑同步内容，不是密码，也不是访问凭据。
SyncKey：一次性设备加入授权，绑定目标同步 ID、设备和预期权限。
设备凭据：SyncKey 成功兑换后获得，只能访问已授权同步空间。
```

用户可以把同一个同步 ID 告诉多台设备，但仅输入或猜中同步 ID 不能读取、写入、枚举或判断该空间是否存在。服务器必须在每次签发和存储访问前校验设备身份、同步空间成员关系、权限、凭据状态和撤销状态。

同步 ID 可以是便于识别的稳定标识，但不得承担保密性。产品安全不能依赖 ID 难以猜测。

## 2. 当前差距

- 当前模型主要使用设备 prefix 或 `shared/{remoteFolder}` 表示目标，没有独立的同步空间实体和成员关系。
- SyncKey 绑定设备 profile，但没有正式的 `syncSpaceId + membership + role` 授权模型。
- 新设备默认可能继承服务端存储凭据；如果客户端获得可访问整个 bucket 的共享凭据，即使 UI 隐藏 bucket/prefix，也不能形成真实的跨空间隔离。
- 客户端任务仍包含可派生的 bucket、prefix 和 endpoint 字段，必须防止篡改本地 job 后越权访问其他空间。
- 停用设备目前不等于立即撤销已经下发的对象存储权限，成员撤销和凭据生命周期需要闭环。

因此，“多台设备填写同一个 ID”不能只实现为多台客户端拼接同一个远端路径。必须先建立服务端授权模型和存储层强制隔离。

## 3. 目标数据模型

服务端增加独立实体：

```text
SyncSpace
  id                  内部不可变 ID
  syncId              用户可见同步 ID
  storageTarget       服务端管理的 bucket/prefix 引用
  policy              同步、删除、配额和冲突策略
  status              active / disabled / deleted
  version             并发和迁移版本

SyncSpaceMembership
  syncSpaceId
  deviceId
  role                reader / writer / owner
  credentialId
  createdAt
  revokedAt

TKeyClaim
  targetSyncSpaceId
  requestedRole
  targetDeviceId 或兑换绑定
  expiresAt
  usedAt
```

内部 `storageTarget` 可以继续映射 MinIO bucket/prefix，但普通客户端和用户不能修改该映射。用户可见 `syncId` 与物理路径分离，服务器迁移存储位置时无需改变同步 ID。

## 4. SyncKey 加入流程

1. 服务端创建同步空间，或选择一个现有同步空间。
2. 管理员或空间 owner 为该同步 ID 生成一次性 SyncKey，并指定设备预期权限。
3. 新设备兑换 SyncKey 时提交安装绑定信息；服务端校验 claim 未过期、未撤销、空间有效且角色允许。
4. 服务端创建独立设备身份和 `SyncSpaceMembership`，签发该设备在该同步空间内的受限凭据。
5. 客户端保存设备身份和逻辑同步空间摘要；bucket、prefix、endpoint 和密钥继续由运行时管理，不作为用户任务输入。
6. 同一个同步 ID 的其他设备必须使用各自 SyncKey 加入，不得复制第一台设备的 profile 或存储凭据。
7. SyncKey 重放继续遵守当前设备绑定恢复规则，不得让不同设备借重放加入空间。

## 5. 存储授权

上线前必须在以下方案中完成验证并选定一种：

- **优先方案：每设备、每同步空间独立存储凭据。** 服务端为凭据绑定仅允许目标 bucket/prefix 的 MinIO/S3 policy；设备移除时可以单独撤销，不影响同空间其他设备。
- **备选方案：服务端存储网关。** 客户端不直接获得 S3 凭据，所有对象操作经过校验设备身份和空间成员关系的网关。

无论采用哪种方案，都必须满足：

- 客户端不得获得 MinIO root key 或可枚举全部 bucket/prefix 的共享凭据。
- 修改本地 job、rclone 配置或请求中的 bucket/prefix 不能突破授权范围。
- `reader` 不得上传或删除，`writer` 的删除能力受空间策略约束，`owner` 权限也不能越过当前同步空间。
- 停用设备、撤销成员或删除 profile 后，存储权限在规定时间内失效。
- 凭据轮换不改变同步 ID，也不要求其他未受影响设备重新选择目录。

## 6. 协议与接口计划

- profile 增加版本化同步空间摘要，例如 `syncSpace.id`、`syncSpace.displayId`、`membership.role` 和不含原始基础设施细节的传输描述。
- SyncKey claim 明确绑定目标同步空间和角色；创建、兑换、绑定重放和撤销均进入协议合同与机器可读 schema。
- 增加同步空间创建、查询、成员加入、权限修改、成员撤销和凭据轮换的管理接口。
- 所有接口使用内部不可变 ID 做授权判断；用户可见同步 ID 只用于选择和展示，不直接作为存储路径。
- 对不存在和无权限的同步 ID 返回不可枚举的统一响应，避免通过错误差异探测空间。
- Protocol v1 客户端继续读取 legacy profile；新字段是否作为 v1 加法扩展或 Protocol v2，必须经过兼容性评审后封版。

## 7. 客户端计划

- 普通流程只展示本地文件夹、同步 ID、设备权限、连接状态和同步状态。
- 用户输入同步 ID 后，客户端仍必须要求有效 SyncKey/加入凭据；不得把同步 ID 当成密码。
- 客户端不允许编辑 bucket、prefix、endpoint、access key 或内部传输路由。
- 已保存任务只保留逻辑 `syncSpaceId` 和用户选项；实际目标每次从有效 profile/membership 派生。
- 设备被撤销后停止新同步、清除运行时存储凭据并显示明确状态，不自动退回匿名或共享凭据。
- 诊断包可以报告空间授权是否存在、角色和撤销状态，但必须脱敏同步 ID、设备 ID、存储目标和凭据。

## 8. 旧数据迁移

- 当前 `devices/{clientName}` 路径转换为只有一个初始成员的同步空间。
- 当前 `shared/{remoteFolder}` 需要先识别实际参与设备，再转换为一个同步空间及多条 membership；同路径映射冲突必须人工确认。
- 为旧 profile 建立兼容窗口，但不得把 legacy 共享根凭据继续用于新同步空间。
- 新 SyncKey 只签发新授权模型；旧设备通过重新签发 SyncKey/重新导入完成凭据收敛。
- 迁移报告记录空间数量、成员数量、未迁移设备、旧凭据撤销状态和回滚点，不记录原始密钥。
- 旧凭据全部撤销并完成回滚演练后，才能关闭 legacy 设备空间/共享空间入口。

## 9. 安全与合同测试

必须自动覆盖：

- 三台不同设备使用各自 SyncKey 加入同一个同步 ID，能访问同一逻辑内容。
- 未持有有效 SyncKey 的设备输入或猜中同步 ID，不能读取、写入、枚举或确认空间存在。
- 已加入空间 A 的设备篡改 bucket、prefix、同步 ID 或 rclone 配置后，不能访问空间 B。
- reader 上传/删除失败，writer 按策略工作，owner 不能访问其他空间。
- SyncKey 跨设备重放、过期 SyncKey、撤销 SyncKey 和伪造 membership 均失败。
- 设备撤销和凭据轮换后，旧凭据不能继续访问；其他成员不受影响。
- 日志、管理摘要、客户端状态和诊断包不泄露 SyncKey、存储密钥、真实内部路径或可用于枚举空间的标识。
- 断网重连、服务重启和回滚后，成员关系与撤销状态保持一致。

## 10. 发布闸门

以下条件全部满足前，不得把“使用相同同步 ID 实现多设备共享内容”标记为稳定 Beta：

- 服务端同步空间和 membership 数据模型完成并可备份/恢复。
- SyncKey 正式绑定同步空间、设备和角色。
- 存储层强制执行每设备/每空间的最小权限，客户端不持有共享根凭据。
- 跨空间越权、ID 枚举、凭据重放和撤销测试全部通过。
- 单写入端、多读取端完成真实 N1 与 `sync.970506.xyz` 验收。
- 多写入端仅在互斥、冲突、删除、幂等和断网恢复门禁通过后开放。
- 旧 profile 迁移、凭据撤销和客户端/服务端回滚演练通过。

