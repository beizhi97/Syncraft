# 工程交接说明

## 范围与边界

- 本目录只包含研究、设计 Token 和独立原型，不修改生产文件。
- 用户可见凭据统一为 SyncKey；内部 `tKey`、`SFSC1-...`、URI、API 和错误码仍是兼容标识，不在页面文案中展示。
- 客户端不暴露 MinIO、S3、bucket、prefix、远端目录、endpoint 或 rclone remote；只能显示当前授权的同步内容。

## 数据合同

- 管理端从 `/api/admin/state` 的 `syncSpaces` 与设备加载数据；空数组必须显示空态。
- 创建凭据调用 `/api/claims/create`，请求包含 `syncSpaceId` 和 `requestedRole`，回显真实响应值。
- Sync ID 由管理员创建、全局唯一；冲突使用 `sync_id_unavailable`。服务端负责内部空间 ID 与存储目标。
- 客户端显示实际 Sync ID 需要 Profile 或本地安全摘要携带这个非敏感字段；当前原型不伪造该能力，这是待确认的合同缺口。

## 关键 id 保留

- 客户端：`claimCode`、`saveProfileBtn`、`runSyncBtn`、`stopSyncBtn`、`historyStatusFilter`、`historySearch`、`syncHistoryList`、`confirmTextInput`、`confirmSubmitBtn`。
- 服务端：`createClaimBtn`、`deviceList`、`deviceSearch` 及既有 VLESS、存储和确认表单 id。

## 验收

- 未绑定接口的页面不得默认宣称在线、健康、容量、成功同步、固定设备或固定日期。
- 刷新操作必须执行实际重新请求；失败时保留明确错误状态而非成功提示。
