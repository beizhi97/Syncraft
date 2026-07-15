# 信息架构与关键用户流程

## 客户端

- 同步：选择本地文件夹、方向与计划；仅展示当前 SyncKey 已授权的同步内容。
- 历史：从本机历史接口加载成功、失败、停止和冲突；无结果时显示空态。
- 设置：导入或替换 SyncKey，显示 Profile 安全摘要、心跳和协议检测。

客户端不提供 Sync ID 的输入、查询、猜测、加入或枚举能力。Sync ID 由管理员创建且全局唯一；客户端只能由已兑换的 Profile 或本地安全摘要获知当前授权空间。

## 服务端

- 概览：从 `/api/admin/state` 加载健康、同步空间、设备及异常摘要。
- SyncKey：从 `/api/admin/state` 的 `syncSpaces` 和设备中选择对象，以 `/api/claims/create` 提交 `syncSpaceId` 与 `requestedRole`，显示真实返回结果。
- 设备：从 `/api/admin/state` 加载设备与同步摘要。
- 基础设置：管理 VLESS 和存储目标；服务端生成内部空间 ID 与存储目标，普通客户端不接触这些信息。

## 管理员关键流程

1. 创建全局唯一的 Sync ID；冲突返回 `sync_id_unavailable`。
2. 服务端创建内部空间 ID 与存储目标。
3. 选择同步空间、设备与角色，生成一次性 SyncKey。
4. 客户端兑换 SyncKey 后，仅获得被授权空间的最小可见摘要。
