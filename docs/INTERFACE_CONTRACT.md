# 双端接口与协议合同

本文档是客户端和服务端之间的产品化基线。以后任一端修改接口时，必须同步更新本文档和合同测试。

所有机器可读验收报告和发布证据在写入磁盘、复制到 `reports/`、聚合到 N1 验收目录或进入 release bundle 前，必须经过共享报告敏感信息扫描器。Node 脚本使用 `scripts/lib/reportSecrets.mjs`，PowerShell 发布/N1 脚本使用 `scripts/lib/report-secrets.ps1`。扫描器至少拒绝完整 SyncKey、`sfsc://import/v1#`、完整 VLESS URI、管理 token 赋值、S3/MinIO secret 赋值、raw `secretAccessKey`、raw heartbeat secret 和私钥块；报告只能记录布尔值、哈希、长度、路径、错误码、脱敏值或 `secretRef`。

## 1. 协议版本

当前协议版本为 `1`。

版本字段出现位置：

- SyncKey payload: `version: 1`
- profile: `version: 1`
- 服务端状态: `version: 1`

## Enrollment 管理端路由

以下路由均受管理 token 保护。`GET /api/admin/enrollment/v1/directories` 返回登记目录路径和 `pending`/`active` 状态；`POST` 只接受 `{path}`，路径必须指向已存在目录。首次登记以 catalog 的 pending root 为恢复点，之后调用目录 guard 实测并激活；首次选择路径即授权服务端在该目录安装 `.syncraft-root.json`。登记过程不创建或删除用户文件，已有未知 marker、root identity/mount 变化或 revision 冲突必须失败关闭。空 catalog 初始化仅包含 pending root 且必须同时持久化独立 SFTP host key；enrollment signer 不得复用 host key。

`GET /api/admin/enrollment/v1/requests` 列出待审批申请。`POST /api/admin/enrollment/v1/requests/{requestId}/issue` 兼容旧 `{rootId}`，新 `{rootIds:[...]}` 必须是非空、无重复的有效 root ID 数组；两种形式不能混用。服务端要求本次选择的每个 root 都 active，一次签发同一个一次性身份验证码及各 root 独立的 binding；任一 root 无效则整次拒绝。旧单 root 请求仍返回 `binding`；`rootIds` 请求返回 `bindings` 数组，不返回单个 `binding`。同一申请重放时，所选 root 集合可以换序但必须与首次签发的集合完全相同，返回首次持久化的 binding 顺序；改变集合失败关闭。消费后的 identity grant 尚不授予同步目录权限。`GET /api/admin/enrollment/v1/trust` 使用启动时实际绑定的 loopback gateway origin 返回签名公钥 pin。`POST /api/admin/enrollment/v1/channel-code` 只接受 `{}`；端点写入 overlay 配置、按配置文件真实字节计算摘要、经 supervisor 重启并核对回执后才签发包装码。

`POST /api/admin/enrollment/v1/reconfigure` 只接受 `{operationId, publicHost?, publicPort?}`，operation ID 必须是 `op_` 前缀加 16–128 个字母、数字、下划线或连字符。它从当前 tunnel 继承协议、监听端口、transport、安全参数、REALITY 身份及全部目录/设备/关系状态；只允许覆盖公网 host/port。操作先把 tunnel 快照和 sing-box 配置原始字节保存到 0600 journal，再写候选配置、等待 supervisor 对精确 SHA-256 的成功回执，依次登记 data authorization 与 bootstrap 双 overlay 已应用回执；REALITY 模式还须通过当前 bootstrap 身份完成本机 VLESS/REALITY loopback gateway challenge 探测后才签发通道码。内部探针 `GET /api/enrollment/v1/transport-probe?challenge={48位小写十六进制}` 只绑定 `127.0.0.1`；合法请求返回 `ok:true`、`service` 为 `sfsc-enrollment-bootstrap`，并原样回显 challenge，不创建申请或修改授权状态。探针失败沿用现有操作回滚边界且不签发码。`GET /api/admin/enrollment/v1/reconfigure/{operationId}` 使用相同管理 token 查询操作；只有 `complete` 返回持久化包装码。相同 ID 和相同输入可续做或重放终态，相同 ID 的不同输入返回 `enrollment_reconfigure_conflict`。失败时仅在当前 tunnel endpoint fingerprint 和配置摘要仍与本操作候选一致、且恢复配置能逐字节重建原快照时才回滚；否则状态为 `repair-needed` 且不返回通道码。操作日志不得记录包装码。

`POST /api/enrollment/v1/data-authorization` 只在受限 loopback gateway 接收，body 精确为 `{relationId}`，`X-SFSC-Authorization` 必须以已消费设备公钥签署 binding、精确 method/path/body 摘要和 nonce。服务端重新检查 catalog.authority 当前设备、relation 和 active root，再由服务端流程物化 authorized_keys/catalog relation、启动 relation facade、最后合成数据 overlay 并经 supervisor 写入/重启/核对真实配置摘要。成功响应精确为 `{payload,signature}`，signature 是独立服务端 enrollment Ed25519 key 对 canonical payload UTF-8 的签名；payload 的 keyId 必须等于 `/api/admin/enrollment/v1/trust` pin 的 keyId。失败的物化或重启不返回授权 payload。

`GET /api/admin/enrollment/v1/relations` 返回 enrollment relation 的 `relationId`、`deviceId`、`rootId`、目录路径与 `active`/`revoked` 状态，不返回 identity、密钥或 runtime handle。`POST /api/admin/enrollment/v1/revocations` 仅接受精确 `{operationId,target}`；target 只能是 `{kind:"relation",relationId}` 或 `{kind:"device",deviceId}`。relation 撤销只撤销该 relation grant；device 撤销永久撤销该 enrollment device，并固定撤销时该设备全部 relation grants。它们不等同于 `/api/admin/users/disable` 或 `delete`。

撤销操作先持久化 authority revocation 与 operation journal，再逐个停用固定 relation 列表并重建/应用 data overlay。相同 operationId 和相同目标可继续执行；同 ID 绑定其他目标或 authority identity 时返回 409 `enrollment_revocation_operation_conflict`。`GET /api/admin/enrollment/v1/operations/{operationId}` 读取脱敏 journal，不等待 runtime stop/restart；返回 `pending` 或 `cleanup_required` 不表示已完成。只有每个 relation 已由 manager inventory 确认为 stopped/absent，且配置摘要对应的受控 sing-box restart receipt 已应用，POST 才返回 200 `complete`；未收敛返回 503，readiness 与数据授权保持阻断，重试或重启继续撤销，绝不恢复已撤销 authority。

机器路由索引：GET `/api/admin/enrollment/v1/requests`；POST `/api/admin/enrollment/v1/requests/{requestId}/issue`；GET `/api/admin/enrollment/v1/relations`；POST `/api/admin/enrollment/v1/revocations`；GET `/api/admin/enrollment/v1/operations/{operationId}`；GET `/api/admin/enrollment/v1/directories`；POST `/api/admin/enrollment/v1/directories`；GET `/api/admin/enrollment/v1/trust`；POST `/api/admin/enrollment/v1/channel-code`；POST `/api/admin/enrollment/v1/reconfigure`；GET `/api/admin/enrollment/v1/reconfigure/{operationId}`；GET `/api/enrollment/v1/transport-probe`（loopback 内部探针）；POST `/api/enrollment/v1/data-authorization`。

目录登记稳定错误码沿用 guard 证据分类：`directory_root_input_invalid` (400)、`directory_root_missing` (404)、`directory_root_link_denied` (403)、`directory_root_permission_denied` (403)、`directory_root_marker_collision` (409)、`directory_root_marker_mismatch` (409)、`directory_root_marker_missing` (409)、`directory_root_mount_changed` (409)、`directory_root_overlap` (409)、`directory_root_registration_review_required` (409)、`directory_root_space_insufficient` (409)、`directory_root_mount_unavailable` (503)、`directory_root_registration_incomplete` (503)、`directory_root_space_unavailable` (503)、`directory_root_not_ready` (503)、`directory_root_io_failed` (500)、`directory_root_record_invalid` (500) 和 `directory_root_replaced` (409)。失败时不会覆盖未知 marker。

稳定错误状态映射：stable errorCode directory_root_input_invalid with HTTP 400；stable errorCode directory_root_io_failed with HTTP 500；stable errorCode directory_root_link_denied with HTTP 403；stable errorCode directory_root_marker_collision with HTTP 409；stable errorCode directory_root_marker_mismatch with HTTP 409；stable errorCode directory_root_marker_missing with HTTP 409；stable errorCode directory_root_missing with HTTP 404；stable errorCode directory_root_mount_changed with HTTP 409；stable errorCode directory_root_mount_unavailable with HTTP 503；stable errorCode directory_root_not_ready with HTTP 503；stable errorCode directory_root_overlap with HTTP 409；stable errorCode directory_root_permission_denied with HTTP 403；stable errorCode directory_root_record_invalid with HTTP 500；stable errorCode directory_root_registration_incomplete with HTTP 503；stable errorCode directory_root_registration_review_required with HTTP 409；stable errorCode directory_root_replaced with HTTP 409；stable errorCode directory_root_space_insufficient with HTTP 409；stable errorCode directory_root_space_unavailable with HTTP 503。

### 同步恢复稳定错误码

恢复 API 失败时返回 `{ok:false,error,errorCode,message}`；`error` 和 `errorCode` 使用同一稳定码，HTTP 状态如下：

| `errorCode` | HTTP | 含义 |
| --- | ---: | --- |
| `sync_recovery_preflight_failed` | 500 | 双向运行的恢复预检或运行结束 journal 持久化失败 |
| `sync_recovery_restore_hash_mismatch` | 409 | 恢复内容哈希与保存的恢复版本不一致，目标内容保留供检查 |
| `sync_recovery_restore_preview_expired` | 410 | 还原预览已过期 |
| `sync_recovery_restore_preview_required` | 409 | 缺少当前关系绑定的还原预览 |
| `sync_recovery_restore_staging_invalid` | 500 | 受保护暂存副本缺失或内容不一致 |
| `sync_recovery_restore_target_exists` | 409 | 还原目标已存在，不覆盖目标 |
| `sync_recovery_restore_target_invalid` | 400 | 还原目标路径无效或越出同步根目录 |
| `sync_recovery_review_required` | 409 | 恢复区、关系基准或预检状态需要人工复核 |
| `sync_recovery_trusted_relation_required` | 409 | 任务缺少可信、稳定的同步关系 |
| `sync_recovery_version_not_found` | 404 | 请求的恢复版本或文件不存在 |
| `first_sync_conflict_command_failed` | 502 | 冲突保护扫描命令失败 |
| `first_sync_conflict_preview_expired` | 410 | 首次冲突预览已过期 |
| `first_sync_conflict_preview_required` | 409 | 保存冲突副本需要当前关系的有效预览 |
| `first_sync_conflict_review_required` | 409 | 关系、listing、journal 或目标状态需要人工复核 |
| `first_sync_conflict_save_required` | 409 | 首次双向初始化前必须保存冲突双方副本 |
| `first_sync_conflict_scan_failed` | 502 | 本地或远端冲突扫描结果无法验证 |
| `first_sync_conflict_set_changed` | 409 | 预览后冲突集合或源内容发生变化 |
| `first_sync_conflict_source_changed` | 409 | 暂存期间冲突源内容发生变化 |
| `first_sync_conflict_stage_invalid` | 409 | 受保护暂存内容缺失或已变化 |
| `first_sync_conflict_staging_invalid` | 500 | 受保护暂存目录结构无效 |
| `first_sync_conflict_target_exists` | 409 | 冲突副本目标已被未知文件占用 |
| `first_sync_conflict_target_invalid` | 409 | 冲突副本写入后的文件校验失败 |
| `first_sync_conflict_trusted_relation_required` | 409 | 首次冲突保护缺少可信的目录关系 |

客户端必须拒绝未知 SyncKey 版本。服务端在新增不兼容协议时，应新增版本而不是改变 v1 字段语义。`ADMIN_STATE_VERSION` 和 `PROFILE_VERSION` 分别是所有服务端状态、服务端签发 profile、离线 profile 与 legacy profile 生产者的单一版本源；读取到高于当前实现的 admin state 版本时必须拒绝启动，不得静默降级。

入口请求必须先通过 HTTP 层媒体类型防护和共享请求 schema 归一化，再进入业务实现。服务端和客户端本地 `POST` 写入口带请求体时必须使用精确 `Content-Type: application/json`（允许 `; charset=utf-8` 等参数），否则返回 `415 unsupported_media_type`；该媒体类型防护优先于管理 token 鉴权和未匹配路由兜底，因此受保护 POST 或不存在的 POST 路径只要携带非 JSON body，也必须先返回 `415 unsupported_media_type`。只有既无正数 `Content-Length`、也无 `Transfer-Encoding` 的真正空 body 才可省略 `Content-Type`；零字节 chunked 请求仍必须声明 JSON。共享 body parser 必须累计原始 Buffer、在拼接前执行 2 MiB 字节限制，并在完整收包后统一 UTF-8 解码，不能逐 chunk 字符串拼接。客户端本地写入口还必须先拒绝 cross-site、非 `http:` 或非同一 loopback host/port 的 Origin。当前机器可读入口（52 个）位于 `src/core/protocolSchemas.js`，通过 `parseProtocolRequest(PROTOCOL_REQUESTS.*)` 约束关键写接口的请求信封：服务端 `/api/admin/tunnel/generate`、`/api/admin/tunnel/autofill`、`/api/admin/singbox/write`、`/api/admin/singbox/apply`、`/api/admin/singbox/mark-applied`、`/api/admin/enrollment/v1/directories`、`/api/admin/enrollment/v1/requests/{requestId}/issue`、`/api/admin/enrollment/v1/channel-code`、`/api/admin/enrollment/v1/reconfigure`、`/api/admin/enrollment/v1/revocations`、`/api/admin/storage/save`、`/api/admin/storage/buckets/refresh`、`/api/admin/storage/buckets/create`、`/api/admin/storage/buckets/enable`、`/api/admin/storage/buckets/disable`、`/api/admin/storage/buckets/clear`、`/api/admin/storage/buckets/delete-empty`、`/api/admin/users/create`、`/api/admin/users/enable`、`/api/admin/users/disable`、`/api/admin/users/delete`、`/api/admin/sync-spaces/create`、`/api/claims/create`、`/api/claims/redeem`、`/api/devices/heartbeat`、`/api/profile/encode`、`/api/vless/parse`、`/api/singbox/client-config`、`/api/jobs/preview`，以及客户端本地 `/api/binaries/check`、`/api/client/shutdown`、`/api/enrollment/channel/import`、`/api/enrollment/request`、`/api/enrollment/consume`、`/api/enrollment/data-authorizations/refresh`、`/api/enrollment/connection/repair`、`/api/profile/import`、`/api/jobs/save`、`/api/singbox/start`、`/api/singbox/stop`、`/api/sync/preview`、`/api/sync/safety-plan`、`/api/sync/bisync/conflicts/preview`、`/api/sync/bisync/conflicts/save`、`/api/sync/bisync/conflicts/operations`、`/api/sync/bisync/conflicts/resume`、`/api/sync/bisync/initialize`、`/api/jobs/{jobId}/recovery/restore-preview`、`/api/jobs/{jobId}/recovery/restore`、`/api/jobs/{jobId}/recovery/restore-cancel`、`/api/sync/run`、`/api/sync/stop`。该 schema 只负责入口字段白名单、基础类型和稳定错误码，不替代 profile、rclone、heartbeat HMAC、admin state 等深层合同；新增或修改这些入口字段时必须同时更新 `src/core/protocolSchemas.js`、本文档和 `tests/core.test.js` 的 schema 回归。入口 schema 的嵌套对象字段也必须做字段级白名单：`schedule` 只允许 `mode`、`intervalMinutes`、`time`；`reality` 只允许 `serverName`、`fingerprint`、`publicKey`、`privateKey`、`shortId`；`defaults` 只允许 `localProxyPort`、`transfers`、`streams`、`checkers`、`chunkSize`、`retries`、`lowLevelRetries`、`bandwidthLimit` 和嵌套 `schedule`；客户端 job 的 `safety` 只允许 `version`、`recoveryRetentionDays`、`deleteLimit.maxFiles`、`deleteLimit.maxPercent`、`bidirectional.initialized`、`bidirectional.initialMode`；`/api/profile/encode` 的 `heartbeat` 只允许 `scheme`、`secret`。嵌套白名单中的未知字段必须丢弃。`bandwidthLimit` 允许 rclone `--bwlimit` 兼容字符串或 UI 对象形态（`enabled`、`mode`、`value`、`unit`、`startTime`、`endTime`），数组必须返回 `400 validation_failed`。schema 白名单里的标量槽位（如 `transfers`、`publicPort`、`expiresAt`）不得接受对象或数组，走私嵌套结构必须返回 `400 validation_failed`。唯一的例外是 `/api/devices/heartbeat`：其 `diagnostics`、`storage`、`sync`、`auth` 与 legacy sync 字段必须按到达形态透传，因为心跳 HMAC 签名覆盖整个请求体，schema 层改写会破坏合法客户端的签名；这些字段的深层校验由验签后的 `normalizeDeviceSync`、`normalizeRuntimeDiagnostics` 等归一化承担。

## 2. SyncKey

### 同步空间管理入口

`POST /api/admin/sync-spaces/create` 受管理 token 保护，只接受现有 owner 设备的 `ownerUserId`、用户可见的 `syncId`，以及可选的 `mode`（`backup`、`distribution`、`collaboration` 三者之一）。`mode` 必须显式列入请求白名单——请求解析按字段白名单重建对象，未列入的字段会在到达 `createSyncSpace` 之前被静默丢弃。省略 `mode` 时由 `createSyncSpace` 一处决定默认值；给出未知值必须返回 `validation_failed` 400，不得静默回落到默认用途，否则会把「仅上传」成员显示成可双向。`mode` 决定成员可用的同步方向，创建后没有修改接口——刻意不提供，以免要发明「改用途后如何驱逐已有 reader」的语义。服务端生成不可变的内部空间 ID 与物理存储目标；成功响应和 `GET /api/admin/state` 只返回脱敏空间摘要（ID、同步 ID、状态、策略、用途、版本、创建时间和活跃成员数），不得返回 bucket、prefix、成员 access key 或 secret。该入口不提供根据同步 ID 查询或匿名加入能力；新设备只能由管理端通过绑定目标空间与角色的 SyncKey 加入。

SyncKey 用于一次性兑换完整客户端 profile。

支持两种外层格式：

```text
SFSC1-{base64url(json)}
sfsc://import/v1#{base64url(json)}
```

SyncKey payload：

```json
{
  "version": 1,
  "type": "claim",
  "server": "http://127.0.0.1:5177",
  "code": "C7KD-92PQ"
}
```

约束：

- `server` 必须是 `http` 或 `https` URL，末尾斜杠无语义。
- 新生成的 `code` 必须是 `AAAA-AAAA` 形态的大写无歧义短码，字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，不得包含易混字符 `0`、`1`、`I` 或 `O`。
- 兑换解析可以继续接受历史 `[A-Z0-9]{4}-[A-Z0-9]{4}` 短码，以兼容旧 SyncKey；新编码、管理摘要和控制台展示必须使用无歧义字符集。
- SyncKey 默认只能兑换一次；只有服务端成功持久化兑换状态后，才算消耗该 SyncKey。同一客户端绑定在短时重放窗口内的恢复兑换是一次性语义的受限例外。
- 新客户端兑换 SyncKey 时应提交 `clientRedeemId` 和 `clientInstallId`，作为同一客户端绑定，用于导入未完成后的短时绑定重放；旧客户端不提交绑定时仍保持严格一次性语义。
- SyncKey 兑换成功后，客户端保存 profile，不得保存一次性短码。

## 3. Profile

服务端兑换 SyncKey 后返回完整 profile：

```json
{
  "version": 1,
  "profileId": "profile-company-pc1-abc123",
  "clientName": "company-pc1",
  "issuedAt": "2026-07-03T00:00:00.000Z",
  "expiresAt": null,
  "tunnel": {
    "type": "vless",
    "uri": "vless://..."
  },
  "storage": {
    "type": "s3",
    "remoteName": "home-minio",
    "endpoint": "http://minio:9000",
    "bucket": "home-sync",
    "accessKeyId": "company-pc1",
    "secretAccessKey": "secret",
    "prefix": "devices/company-pc1"
  },
  "heartbeat": {
    "scheme": "sfsc-hmac-sha256-v1",
    "secret": "heartbeat-secret"
  },
  "defaults": {
    "localProxyPort": 18081,
    "transfers": 4,
    "streams": 8,
    "checkers": 8,
    "chunkSize": "16M",
    "retries": 3,
    "lowLevelRetries": 10,
    "bandwidthLimit": "off",
    "schedule": {
      "mode": "manual"
    }
  }
}
```

`defaults.bandwidthLimit` 和本地 job 的 `bandwidthLimit` 统一使用 rclone `--bwlimit` 兼容字符串：

- `"off"` 表示不限制，是默认值。
- 正整数加单位表示限速，单位只允许 `k`、`M`、`G`，例如 `"500k"`、`"10M"`、`"1G"`。
- 两段式时间表表示时间段限速，例如 `"08:00,10M 18:00,off"` 表示 08:00 到 18:00 限速 10 MB/s，其余时间不限制。
- 客户端 UI 以“启用开关 + 模式选择 + 数值 + KB/s、MB/s、GB/s 单位选择 + 时间输入”录入，并提交为上述字符串；产品 UI 不接受任意自由文本时间表。
- 服务端和客户端本地 API 必须规范化该字段；非法值返回 `validation_failed`。

`defaults.schedule` 和本地 job 的 `schedule` 统一使用以下结构：

```json
{ "mode": "manual" }
{ "mode": "interval", "intervalMinutes": 30 }
{ "mode": "daily", "time": "02:00" }
{ "mode": "startup" }
```

约束：

- `manual` 表示只手动运行，是默认值。
- `interval.intervalMinutes` 必须是 1 到 1440 的整数。
- `daily.time` 必须是 24 小时制 `HH:MM`。
- `startup` 表示客户端本地运行时启动后触发一次；Windows 客户端 UI 可配置该模式，服务端控制台默认策略不暴露给批量下发。
- 客户端 UI 和服务端控制台的 SyncKey 默认同步策略当前只暴露“手动 / 每隔 N 分钟 / 每天 HH:MM”；非法值返回 `validation_failed`。

`defaults` 是服务端 profile 到客户端本地 job 的兜底合同。客户端 UI 可以只提交用户正在编辑的字段，例如 `localPath`、`direction`、`transfers`、`streams`、`destructiveSync`、`bandwidthLimit`、`schedule`；客户端本地 API 保存、预览和运行前必须用导入 profile 补齐未提交字段，包括 `checkers`、`chunkSize`、`retries`、`lowLevelRetries` 和 `localProxyPort`。

客户端重新导入 profile 后，必须刷新已保存 job 中由 profile 派生的字段，包括 `clientName`、`remoteName`、`bucketName`、`remotePrefix`、`s3Endpoint`、`accessKeyId` 和 `secretAccessKey`。已保存 job 中的用户配置字段必须保留，包括 `name`、`localPath`、`direction`、`remoteFolder`、`serverSpace`、`transfers`、`streams`、`checkers`、`s3UploadConcurrency`、`s3ChunkSize`、`chunkSize`、`cutoff`、`retries`、`lowLevelRetries`、`dryRun`、`destructiveSync`、`bandwidthLimit`、`schedule` 和 `localProxyPort`；缺失字段再由新 profile 的 `defaults` 兜底。`remoteFolder` 是用户选择的相对目录；`remotePrefix` 是运行时执行路径，必须从新 profile 的 `storage.prefix` 与保留的 `remoteFolder` 重新派生。设备空间下为 `{profile.storage.prefix}/{remoteFolder}`，共享空间下为 `shared/{remoteFolder}`；没有 `remoteFolder` 时直接使用 `profile.storage.prefix`。这样旧 profile 的 bucket、prefix 或 secret 不会随旧 job 残留。

服务端若配置 `S3_CLIENT_ENDPOINT`，签发给客户端的 `profile.storage.endpoint` 必须使用该客户端可达地址，而不是仅容器内部使用的 `S3_ENDPOINT` / `storage.internalEndpoint`。客户端导入 SyncKey 后必须把 `profile.storage.endpoint` 原样派生为 job 的 `s3Endpoint`，并在 `/api/sync/preview` / `/api/sync/run` 的 `rclone.remoteConfig.args` 中作为 `endpoint` 参数写入 rclone 配置。N1 部署中 `S3_ENDPOINT` 保持 `http://minio:9000` 供 sync-server 在 Docker 网络内管理 MinIO，`S3_CLIENT_ENDPOINT` 则把 `http://n1-minio.sfsc:9000` 从服务端 SyncKey 下发到 Windows 客户端，并经 sing-box 代理交给 rclone 使用。

`heartbeat` 是服务端下发给客户端运行时的心跳认证材料。新签发 profile 必须包含 `heartbeat.scheme: "sfsc-hmac-sha256-v1"` 和 `heartbeat.secret`；客户端使用 `profile.heartbeat.secret` 生成 `/api/devices/heartbeat` 的 HMAC `auth` 字段。`heartbeat.secret` 不得出现在服务端管理摘要、客户端诊断包或日志中。

客户端本地持久化层不得把 S3 `secretAccessKey` 或 `profile.heartbeat.secret` 明文写入 `profile.json` 或 `jobs.json`。保存 profile/job 时应把密钥外置到本地 secret vault，并在原密钥字段中保存引用对象，例如 `profile.storage.secretAccessKey: { "secretRef": "profile:...:storage.secretAccessKey" }`、`profile.heartbeat.secret: { "secretRef": "profile:...:heartbeat.secret" }`、`job.secretAccessKey: { "secretRef": "job:...:secretAccessKey:..." }`；不得改成平级 `secretRef` 字段导致运行时水合歧义。Job 密钥引用必须是不可变引用，更新同一 job 的密钥时生成新的 `job:...:secretAccessKey:...` vault key，而不是覆盖旧 key，避免 jobs 写入失败后改变旧 job 的有效密钥。`readProfile()` / `readJobs()` 对运行时返回水合后的完整对象，确保 rclone 配置生成、心跳签名和同步执行合同不变；本地 HTTP `GET /api/jobs` 和 `POST /api/jobs/save` 响应只返回展示安全 job 摘要，不得返回水合密钥。当前 vault 后端可以是本地文件，后续可迁移到 Windows Credential Manager。

若 `secretRef` 存在但 vault 条目缺失，运行时必须使用 `secret_vault_missing`，不得静默退回占位密钥。`/api/jobs/save`、`/api/singbox/start`、`/api/sync/preview` 和 `/api/sync/run` 必须检查整个 secret vault 健康状态；即使当前请求可由 profile 默认值补齐，只要已有 profile/job 引用缺失条目，也必须在写入状态、写入 sing-box 配置、写入 `rclone.conf` 或启动本地进程之前返回 `secret_vault_missing`。

正式导入 profile 的来源字段：

- `importedAt`
- `importMode`
- `source.type`
- `source.server`

`importedAt` 和 `importMode` 总是由客户端本地运行时写入。服务端 `POST /api/claims/create` / `POST /api/claims/redeem` 返回的原始 profile 是服务端签发 profile 本体，不得包含 `source`、`importMode` 或 `importedAt`；客户端通过 SyncKey 导入后，必须从 claim token 补齐 `source.type: "claim"` 和 `source.server`。服务端 `POST /api/profile/encode` 生成的离线完整 profile 必须在编码内容里包含 `source.type: "profile"` 和 `source.server`，且该规范化 profile 允许并应保留 `tunnel.parsed`。旧 `uri` 形式的 legacy VLESS 导入不得补 `source.server`，它只是本地兼容导入，不参与 heartbeat/compatibility。

## 4. 服务端接口

### 通用错误响应

服务端接口和客户端本地接口的错误响应都必须保持旧客户端兼容，同时提供结构化字段；通用请求解析阶段也必须返回稳定错误码，例如请求体超过 2 MiB 时返回 `413 request_body_too_large`：
该结构是 http error response contract，并由共享运行时契约 `assertHttpErrorResponseContract` 校验；顶层必须且只包含 `ok`、`error`、`errorCode`、`message`，`ok` 必须为 `false`，`error` 必须等于 `errorCode`，`errorCode` 必须是稳定 snake_case，`message` 必须是非空字符串。

```json
{
  "ok": false,
  "error": "claim_already_used",
  "errorCode": "claim_already_used",
  "message": "claim_already_used"
}
```

字段约束：

- `error` 是历史兼容字段，旧客户端继续读取它。
- `errorCode` 是新 UI/客户端应优先读取的稳定错误码。
- `message` 是可展示或可记录的错误说明。
- 未登记异常降级为 `server_error` / `client_error` 时只能返回固定公共消息 `Internal server error` / `Client request failed`，不得把原始异常 message、内部路径、进程参数或网络细节写入 HTTP envelope。
- 未匹配的 API、缺失静态资源和非法静态路径也必须使用同一结构，分别返回 `404 not_found` 或 `400 invalid_path`，不得只返回裸 `{ "error": "Not found" }`。

管理端基础输入校验失败必须直接返回 `400 validation_failed`，覆盖 clientName、bucket、remoteName、URL、host、端口、REALITY SNI、REALITY public/private key、REALITY shortId、存储 prefix、profile defaults、job preview 数值字段、计划和带宽限制等字段；显式传入的空字符串、0、非法 URL/host/port 或空存储字段必须按非法输入处理，不得当作“未传”并回退到默认值或既有状态；不得把这些字段校验仅作为英文异常文本交给映射层兜底。

当前稳定错误码：

| errorCode | HTTP | 语义 |
| --- | --- | --- |
| `admin_auth_required` | 401 | 管理 token 缺失或错误 |
| `binary_version_check_failed` | 503 | 客户端组件存在但版本命令无法成功运行 |
| `bucket_disabled` | 409 | 同步仓库已停用 |
| `bucket_not_empty` | 409 | 删除空仓库时发现仓库非空 |
| `bucket_not_found` | 404 | 同步仓库不存在 |
| `client_error` | 400 | 客户端本地 API 通用兜底错误 |
| `client_port_in_use` | 409 | 客户端本地 API 端口被非 SFSC 进程占用 |
| `data_authorization_invalid` | 400 | 签名目录授权格式或签名无效 |
| `data_authorization_mismatch` | 403 | 签名目录授权与当前设备、关系或通道不匹配 |
| `data_authorization_trust_failed` | 401 | 目录授权签名者不匹配已 pin 的服务端密钥 |
| `connection_repair_busy` | 409 | 同步或另一项连接修复正在进行 |
| `connection_repair_cleanup_failed` | 500 | 本次探测未确认清理，不能宣告修复完成 |
| `connection_repair_invalid` | 400 | 连接修复请求无效或 operation ID 输入冲突 |
| `connection_repair_list_failed` | 502 | 无法列出待修复的远端目标 |
| `connection_repair_probe_conflict` | 409 | 无法证明探测路径属于本次操作，未做更改 |
| `connection_repair_read_failed` | 502 | 无法读取连接修复目标 |
| `connection_repair_write_failed` | 502 | 无法写入连接修复目标 |
| `danger_confirmation_required` | 400 | 危险操作缺少显式确认 |
| `directory_root_input_invalid` | 400 | 目录登记路径或操作输入无效 |
| `directory_root_io_failed` | 500 | 目录标记或文件操作失败 |
| `directory_root_link_denied` | 403 | 目录路径包含被拒绝的符号链接 |
| `directory_root_marker_collision` | 409 | 目录中已有未知标记，拒绝覆盖 |
| `directory_root_marker_mismatch` | 409 | 目录标记与 catalog 记录不匹配 |
| `directory_root_marker_missing` | 409 | 已登记目录的保护标记缺失 |
| `directory_root_missing` | 404 | 选择的目录不存在 |
| `directory_root_mount_changed` | 409 | 目录挂载身份已变化 |
| `directory_root_mount_unavailable` | 503 | 无法确认目录挂载状态 |
| `directory_root_not_ready` | 503 | 目录当前不可用于受保护操作 |
| `directory_root_overlap` | 409 | 新目录与已登记目录重叠 |
| `directory_root_permission_denied` | 403 | 服务进程无权访问目录 |
| `directory_root_record_invalid` | 500 | 持久化目录记录无效 |
| `directory_root_registration_incomplete` | 503 | 目录登记未完成，需要恢复检查 |
| `directory_root_registration_review_required` | 409 | 目录或 host key 状态需要人工检查 |
| `directory_root_replaced` | 409 | 受保护目录已被替换 |
| `directory_root_space_insufficient` | 409 | 目录可用空间不足 |
| `directory_root_space_unavailable` | 503 | 无法读取目录可用空间 |
| `device_disabled` | 409 | 设备已停用 |
| `heartbeat_auth_invalid` | 401 | 设备心跳签名无效、过期或与请求体不匹配 |
| `heartbeat_auth_required` | 401 | 新 profile 设备心跳缺少 HMAC 认证字段 |
| `heartbeat_rate_limited` | 429 | 同一来源在窗口内心跳失败次数过多，服务端临时限速 |
| `import_code_invalid` | 400 | SyncKey/profile 载荷无法解析 |
| `import_code_required` | 400 | 客户端导入时未填写 SyncKey |
| `invalid_vless_uri` | 400 | VLESS URI 格式错误 |
| `invalid_json` | 400 | 请求体 JSON 无法解析 |
| `local_state_corrupt` | 409 | 客户端本地 JSON 状态文件损坏 |
| `claim_not_found` | 404 | SyncKey 不存在 |
| `claim_already_used` | 409 | SyncKey 已兑换，且请求不是同一客户端绑定在重放窗口内的恢复兑换 |
| `claim_expired` | 410 | SyncKey 已过期 |
| `claim_redeem_rate_limited` | 429 | 同一来源和同一 SyncKey 摘要在窗口内兑换失败次数过多 |
| `claim_redeem_failed` | 502 | 客户端兑换 SyncKey 时网络请求失败，或远端服务返回非 2xx 且没有合同登记的 redeem 错误码；若已收到远端 HTTP 响应，客户端保留远端 status，无 HTTP 响应时使用 502 |
| `device_not_found` | 404 | 心跳设备未登记 |
| `enrollment_auth_invalid` | 401 | 设备对指定 enrollment binding 的请求签名无效 |
| `enrollment_auth_capacity` | 429 | 设备授权请求 nonce 容量已满，服务端拒绝继续消费请求 |
| `enrollment_auth_expired` | 401 | 设备授权请求签名时间与服务端当前时间相差超过默认五分钟窗口；该错误本身不能判断哪一端时钟不准 |
| `enrollment_auth_replayed` | 409 | 设备授权请求 nonce 已使用 |
| `enrollment_binding_mismatch` | 403 | enrollment grant、binding、设备或目录授权之间的绑定不一致 |
| `enrollment_catalog_not_ready` | 503 | 服务端 enrollment 目录或签发配置尚未就绪 |
| `enrollment_channel_mismatch` | 409 | 引导通道的服务器、修订或申请绑定不一致 |
| `enrollment_channel_invalid` | 409 | 客户端尚未导入有效的签名通道配置 |
| `enrollment_channel_stale` | 409 | 请求的引导通道 revision 已不是当前 revision |
| `enrollment_channel_not_ready` | 503 | 服务端尚无受限首次接入通道配置，不能签发通道码 |
| `enrollment_channel_expired` | 410 | 签名通道或引导窗口已过期 |
| `enrollment_code_expired` | 410 | 一次性身份验证码已过期 |
| `enrollment_code_invalid` | 400 | 一次性身份验证码格式无效或不匹配 |
| `enrollment_code_used` | 409 | 一次性身份验证码已消费 |
| `enrollment_device_revoked` | 403 | enrollment 设备已撤销 |
| `enrollment_data_authorization_denied` | 403 | 当前设备没有该关系的签名数据授权 |
| `enrollment_data_channel_not_ready` | 503 | 数据通道尚未配置或未由 supervisor 确认应用 |
| `enrollment_data_relation_not_ready` | 503 | 受保护的目录关系服务尚未运行 |
| `enrollment_data_relation_start_failed` | 503 | 无法启动受保护的目录关系服务 |
| `enrollment_endpoint_invalid` | 400 | 客户端引导端点或路径无效 |
| `enrollment_identity_conflict` | 409 | 已登记设备身份与本次申请冲突 |
| `enrollment_identity_missing` | 409 | 本地持久化设备身份缺失或损坏 |
| `enrollment_proxy_unavailable` | 503 | 首次接入的本地 sing-box SOCKS 代理不可用 |
| `enrollment_public_key_mismatch` | 403 | 授权签名的公钥指纹与已登记设备不匹配 |
| `enrollment_relation_conflict` | 409 | 关系身份或稳定目录绑定冲突 |
| `enrollment_relation_denied` | 403 | 设备没有该同步关系的有效授权 |
| `enrollment_relation_revoked` | 409 | 同步关系已撤销 |
| `enrollment_request_exists` | 409 | 当前设备已有重复或冲突的身份申请 |
| `enrollment_request_invalid` | 400 | 身份申请或 enrollment 对象格式无效 |
| `enrollment_request_mismatch` | 403 | 一次性身份验证码不属于当前申请、设备、密钥或通道 |
| `enrollment_request_not_found` | 404 | 服务端找不到对应的身份申请 |
| `enrollment_reconfigure_busy` | 409 | 隧道或数据 overlay 变更已在进行 |
| `enrollment_reconfigure_conflict` | 409 | operation ID 已关联不同输入 |
| `enrollment_reconfigure_invalid` | 400 | 重配置请求或 operation ID 无效 |
| `enrollment_reconfigure_needs_repair` | 503 | 无法证明安全回滚或当前配置归属，需要管理员修复 |
| `enrollment_reconfigure_not_found` | 404 | 找不到指定的重配置操作 |
| `enrollment_reconfigure_state_invalid` | 500 | 持久化重配置操作记录无效 |
| `enrollment_reconfigure_write_failed` | 500 | 无法持久化重配置操作记录 |
| `enrollment_revocation_identity_conflict` | 409 | 撤销操作期间关系 authority identity 与持久化快照不一致 |
| `enrollment_revocation_incomplete` | 503 | 撤销操作尚未完成，必须查询或继续同一操作 |
| `enrollment_revocation_invalid` | 400 | 撤销 operationId 或 target 格式无效 |
| `enrollment_revocation_operation_conflict` | 409 | 相同 operationId 已绑定到其他撤销目标或 identity |
| `enrollment_revocation_operation_not_found` | 404 | 找不到撤销操作 |
| `enrollment_revocation_not_ready` | 503 | relation service 或 enrollment catalog 尚未就绪，未开始撤销 |
| `enrollment_revocation_overlay_not_applied` | 503 | 撤销后的数据 overlay 未收到受控应用确认 |
| `enrollment_revocation_recovery_pending` | 503 | 尚有撤销恢复未收敛，新的数据授权暂时拒绝 |
| `enrollment_response_invalid` | 502 | 客户端收到的首次接入响应不是有效 JSON 合同 |
| `enrollment_signer_invalid` | 500 | 服务端 enrollment 签名器无法完成可信签发 |
| `enrollment_state_invalid` | 500 | 持久化 enrollment 状态无效或不完整 |
| `enrollment_state_conflict` | 409 | enrollment 状态版本已变化或与当前写入冲突 |
| `enrollment_transport_failed` | 502 | 经专用隧道发送首次接入请求失败 |
| `enrollment_trust_failed` | 401 | 通道 pin 不匹配、服务端公钥漂移或 receipt 签名验证失败 |
| `enrollment_trust_verifier_required` | 500 | 客户端未提供独立复制的服务端密钥 pin，无法验证通道签名 |
| `missing_rclone_binary` | 503 | 客户端缺少 rclone 组件 |
| `missing_singbox_binary` | 503 | 客户端缺少 sing-box 组件 |
| `not_found` | 404 | 本地 API 或资源不存在 |
| `profile_heartbeat_required` | 400 | 服务端签发 profile 缺少心跳认证材料 |
| `profile_not_imported` | 409 | 客户端尚未导入服务端 profile |
| `profile_storage_required` | 400 | 服务端签发 profile 缺少 S3 存储凭据或必要存储字段 |
| `profile_tunnel_required` | 400 | profile 缺少隧道 URI |
| `request_body_too_large` | 413 | 请求体过大 |
| `rclone_config_failed` | 500 | rclone remote 配置写入失败 |
| `rclone_sync_failed` | 500 | rclone 同步进程异常退出 |
| `secret_vault_missing` | 409 | 客户端本地 secret vault 缺少 profile/job 引用的密钥 |
| `secret_vault_unprotected` | 503 | Windows 上无法为本地 secret vault 应用仅限当前用户的 ACL，运行时拒绝把密钥明文写入磁盘 |
| `server_error` | 500 | 服务端通用兜底错误 |
| `sftp_access_marker_conflict` | 409 | 本机或远端访问标记与授权根目录不符，拒绝覆盖 |
| `sftp_access_marker_invalid` | 400 | 访问标记输入无效或缺少已验证的根目录 ID |
| `sftp_access_marker_missing` | 400 | 已初始化关系的本机或远端访问标记缺失，拒绝重建或继续 |
| `sftp_access_marker_write_failed` | 500 | 无法安全创建本机或远端访问标记 |
| `server_singbox_config_write_failed` | 500 | 服务端 sing-box 配置文件写入失败 |
| `server_state_corrupt` | 500 | 服务端 `sfsc-state.json` 损坏，启动时不得静默覆盖 |
| `server_state_locked` | 409 | 服务端数据目录已有写入者持有 `sfsc-state.lock` |
| `server_state_write_failed` | 500 | 服务端 `sfsc-state.json` 写入失败 |
| `singbox_start_failed` | 500 | sing-box 启动失败 |
| `singbox_restart_failed` | 502 | sing-box supervisor 校验或重启失败 |
| `singbox_restart_timeout` | 504 | 等待 sing-box supervisor 返回重启结果超时 |
| `singbox_restart_unavailable` | 503 | 服务端未配置或无法访问 sing-box supervisor 控制目录 |
| `storage_request_failed` | 502 | MinIO/S3 请求失败，包括 DNS、连接拒绝、超时或 S3 非 2xx 响应；若接口明确声明支持部分成功（例如 bucket refresh/create 的管理状态仍成功持久化），可在 HTTP 2xx 响应体内以 `ok:false` / `errorCode:"storage_request_failed"` 表示远端存储步骤失败 |
| `sync_already_running` | 409 | 已有其他同步任务正在运行，当前请求的 job 不能复用该运行 |
| `sync_relation_migration_required` | 409 | bidirectional 同步关系的身份、实际根、授权或 legacy bisync 状态无法安全复用；客户端必须在评审或迁移完成前阻断保存、预览和运行 |
| `sync_id_unavailable` | 409 | 同步空间名称已被占用 |
| `sync_space_access_denied` | 403 | 设备在该同步空间没有有效成员资格，或空间已停用 |
| `sync_space_membership_exists` | 409 | 设备已经是该同步空间的成员 |
| `sync_space_role_not_allowed` | 409 | 该角色不被同步空间的用途接受；备份用途不接受 reader |
| `local_host_forbidden` | 403 | 客户端本地接口拒绝非回环 `Host` 头请求（防 DNS rebinding，作用于所有方法）|
| `local_read_forbidden` | 403 | 客户端本地读接口拒绝跨站浏览器请求 |
| `local_write_forbidden` | 403 | 客户端本地写接口拒绝跨站浏览器请求 |
| `unsupported_media_type` | 415 | 带请求体的写请求未使用 `application/json` |
| `unsupported_profile_version` | 400 | profile 或 SyncKey 版本不支持 |
| `user_not_found` | 404 | 指定设备不存在或已删除 |
| `last_active_bucket_disable_blocked` | 409 | 禁止停用最后一个启用的同步仓库 |
| `last_bucket_delete_blocked` | 409 | 禁止删除最后一个同步仓库 |
| `validation_failed` | 400 | 输入字段校验失败 |
| `invalid_path` | 400 | 本地静态资源路径非法 |

运行期/前端合成错误码：

以下错误码不一定来自 HTTP JSON 响应。客户端心跳状态、服务端控制台和客户端页面都可以合成这些稳定码，供 UI 文案和诊断使用。

页面 API wrapper 读取到 HTTP 响应但响应体不是合法 JSON 时，不得合成未登记的新错误码：服务端控制台必须用 `server_error` 作为非 JSON 响应兜底，客户端页面必须用 `client_error` 作为本地 runtime 非 JSON 响应兜底，并在 `message` 中保留脱敏后的 HTTP 状态和响应摘要。

| errorCode | 语义 |
| --- | --- |
| `heartbeat_failed` | 客户端上报心跳失败，写入 `GET /api/client/status` 的 `heartbeat.errorCode` |
| `network_error` | 前端无法连接目标服务，由页面 API wrapper 合成 |
| `request_timeout` | 前端请求超过该操作的页面等待预算时由 API wrapper 合成；普通请求默认 15 秒，同步准备/启动为 120 秒，双向初始化为 240 秒 |
| `release_manifest_invalid` | 客户端诊断包发现发布 manifest 存在但结构无效或无法解析 |
| `release_manifest_missing` | 客户端诊断包未在便携包根目录找到发布 manifest |
| `server_error` | 服务端未知错误兜底 |
| `client_error` | 客户端本地 API 未知错误兜底 |

注意：当前服务端和客户端本地 API 已有集中错误映射层，UI 可以优先依赖稳定码。后续产品化仍应继续把内部英文异常细分为更精确的 snake_case 枚举，并在 `message` 中保留可诊断详情。

新增稳定错误码时，必须同步补充服务端控制台和客户端页面的 `formatError()` 中文文案。发布审计会从 `src/core/errors.js` 抽取核心稳定码，并要求 `public/app.js` 与 `client/public/app.js` 都能识别这些码，避免 UI 退回展示裸 snake_case。

### 健康检查

```http
GET /api/health
```

该成功响应是 server health response contract：响应顶层必须且只包含 `ok`、`app`、`version`、`diagnostics`、`mode`、`pathsConfigured`、`architecture`、`safeguards`、`serviceHealth` 和 `adminAuth`。必须返回 `ok: true`，用于反代和客户端诊断。`pathsConfigured.serverDataRoot` 与 `pathsConfigured.singboxConfigPath` 只表示关键路径是否已配置，不得在未认证健康检查中返回真实服务器路径；真实路径只允许出现在已认证管理接口或本机部署报告中。

必须返回 `version`，取自服务端 `package.json`，用于部署 smoke 和 N1 验收确认远端运行代码版本。

必须返回 `diagnostics`，作为双端排障和版本对齐的稳定入口：

```json
{
  "app": "singbox-folder-sync",
  "role": "server",
  "version": "0.2.0-beta.2",
  "buildId": "",
  "buildTime": null,
  "protocols": {
    "claim": 1,
    "profile": 2,
    "adminState": 1,
    "clientStatus": 1,
    "heartbeat": 1
  }
}
```

`version` / `appVersion` / `clientVersion` 继续保留作兼容字段；新诊断、smoke 和后续 UI 应优先读取 `diagnostics.version` 与 `diagnostics.protocols`。运行时 diagnostics 必须且只包含 `app`、`buildId`、`buildTime`、`protocols`、`role`、`version`；`app` 必须为 `singbox-folder-sync`，role 必须符合入口预期，protocols 必须且只包含五个当前协议字段且每项都是 JSON 正整数。字符串、布尔值、错误 app/role、缺字段或额外字段都使该 diagnostics 无效，并按 `diagnostics_missing` 处理。

服务端控制台必须可见展示 `/api/health.diagnostics` 摘要，并在设备列表展示最近心跳上报的客户端 `diagnostics` 摘要，便于现场确认双端版本和协议是否对齐。若某次设备 heartbeat 未上报 `diagnostics`，服务端必须把该设备当前 diagnostics 置为 `null`，并派生 `compatibility.action: "diagnostics_missing"`；不得沿用该设备较早 heartbeat 的 diagnostics 或兼容性结果。

服务端控制台展示管理操作失败时，必须基于稳定 `errorCode` 给出中文原因和可执行恢复建议。至少覆盖认证失败、bucket 非空/不存在/停用、最后一个 bucket 禁用或删除、危险确认缺失、设备不存在/停用、存储请求失败、网络错误、请求超时和字段校验失败。建议文本应指向下一步动作，例如刷新仓库、检查 MinIO、重新登录、先清空 bucket、重新生成 SyncKey 或查看 sync-server 日志。

双端兼容性判断以 `diagnostics.protocols.claim`、`profile`、`adminState`、`clientStatus`、`heartbeat` 为准。服务端设备摘要必须派生 `compatibility`：

```json
{
  "ok": true,
  "status": "compatible",
  "action": "none",
  "severity": "ok",
  "policy": {
    "heartbeat": "allow",
    "profileIssue": "allow",
    "syncRun": "allow",
    "adminActions": "allow",
    "reason": "none"
  },
  "localRole": "server",
  "remoteRole": "client",
  "issues": []
}
```

若任一协议版本缺失或不一致，`ok` 必须为 `false`，`status` 为 `mismatch`，`action` 必须给出可操作分类：

- `upgrade_remote`: remote 端协议较旧。在服务端设备摘要中 remote 是客户端，因此 UI 应提示升级客户端。
- `upgrade_local`: local 端协议较旧。在服务端设备摘要中 local 是服务端，因此 UI 应提示升级服务端。
- `diagnostics_missing`: 至少一端缺少协议版本或诊断字段。
- `manual_check`: 多个协议字段方向不一致，需要人工确认两端发布批次。

`issues[]` 中必须包含不匹配字段、双端版本和 `type`，其中 `type` 为 `local_missing`、`remote_missing`、`remote_older` 或 `remote_newer`。issue 的 null/版本大小关系、`action`、`status`、`severity` 和 policy 必须由本地与远端 diagnostics 重新计算；只满足字段形状但伪造 `action: "none"` 或 `syncRun: "allow"` 的响应必须拒绝，不得绕过兼容性确认。服务端控制台设备列表和客户端设置抽屉必须把该状态映射为“客户端过旧/服务端过旧/诊断信息缺失/协议版本混杂”一类的明确提示。

当前策略不因协议不兼容拒绝心跳：`policy.heartbeat` 必须保持 `allow`，以便服务端持续看到设备在线状态和诊断信息。不兼容时 `policy.profileIssue` 与 `policy.syncRun` 为 `warn`，表示后续涉及 profile/SyncKey 下发或同步执行的入口应提示确认或要求升级；兼容时为 `allow`。

客户端 UI 保存任务或启动同步前必须读取最近一次成功心跳的 `heartbeat.compatibility.policy.syncRun`，本地状态中对应字段为 `lastSuccessfulHeartbeat.compatibility.policy.syncRun`。当值为 `warn` 时，必须先展示协议兼容性风险确认；用户取消时不得调用本地 `/api/jobs/save` 或 `/api/sync/run`。该确认独立于镜像删除确认，如果两种风险同时存在，两个确认都必须出现。`/api/sync/preview` 是只读预览，不需要兼容性确认。

响应中的 `adminAuth.enabled` 表示服务端是否启用了管理 token；`adminAuth.enabled` 必须是布尔值，未启用时必须返回 `false`，不得省略 `adminAuth` 或返回字符串/数字等兼容形态。

响应中的 `serviceHealth` 是未认证、脱敏的服务健康摘要，只能包含 `ok`、`apiReachable` 和 `restartRequired`。`apiReachable` 必须为 `true`，`restartRequired` 必须是布尔值，`ok` 必须等于 `!restartRequired`。该摘要不得包含设备数量、在线数量或存储桶数量等运营规模信息：未认证调用方无需知晓部署规模，且这些计数没有任何消费方；控制台需要计数时必须从已认证的 `/api/admin/state` 的 `devices[]` 与 `storage.buckets[]` 自行统计。服务端控制台健康灯必须把 HTTP/API 可达和运行配置待应用分开展示：API 可达但 `serviceHealth.restartRequired: true` 时应显示待重启/需处理，而不是“服务正常”。

### 管理鉴权

设置环境变量 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN` 后，管理接口必须携带：

```http
Authorization: Bearer {token}
```

也兼容请求头：

```http
X-SFSC-Admin-Token: {token}
```

生产 compose/N1 部署必须设置 `SFSC_REQUIRE_ADMIN_TOKEN=1`。该模式下服务端启动时要求 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN` 非空且不能是 `change-this-admin-token` 占位值；本地开发直跑可以不设置该开关以保持开发兼容。同一模式下，`S3_SECRET_ACCESS_KEY` / `MINIO_ROOT_PASSWORD` 不能是 `change-this-minio-root-password` 占位值，服务端必须拒绝启动；compose 文件不得为 `MINIO_ROOT_PASSWORD` 提供占位默认值，必须使用 `:?` 强制注入。

受保护接口：

- `/api/admin/*`
- `POST /api/claims/create`
- `POST /api/vless/parse`
- `POST /api/singbox/client-config`
- `POST /api/profile/encode`
- `POST /api/jobs/preview`

这些调试/兼容入口也必须使用通用结构化错误响应，未携带有效管理 token 时返回 `401 admin_auth_required`。VLESS 解析失败返回 `400 invalid_vless_uri`；profile 编码缺少隧道 URI 返回 `400 profile_tunnel_required`。

`POST /api/vless/parse` 用于从 VLESS URI 解析 profile 摘要。该成功响应是 vless parse response contract：响应顶层必须且只包含 `profile`，其中必须包含 `raw`、`uuid`、`server`、`port`、`security`、`transport`、`sni`、`fingerprint`、REALITY `publicKey` 和 `shortId` 等客户端生成 sing-box 配置所需字段；`port` 必须是 1..65535 的整数，`raw` 必须是 `vless://` URI。

`POST /api/profile/encode` 用于把服务端签发的完整离线 profile 编码为导入码。响应顶层必须且只包含 `profile`、`summary`、`code` 和 `uri`；`profile` 必须包含 `profile.source.type: "profile"`、规范化的 `profile.source.server`、`profile.tunnel.parsed`、`profile.heartbeat.scheme: "sfsc-hmac-sha256-v1"` 和非空 `profile.heartbeat.secret`，且 `code` / `uri` 解码后必须保留同一份心跳密钥，并保留同一份来源；`code` 使用 `SFSC1-` 前缀，`uri` 使用 `sfsc://import/v1#` 前缀。`defaults` 若存在必须是普通对象，不得是字符串、数组或其他非对象值；`defaults.localProxyPort` 必须是 1..65535 的整数；`defaults.transfers`、`defaults.streams`、`defaults.checkers`、`defaults.retries` 和 `defaults.lowLevelRetries` 必须是正整数；非法值返回 `400 validation_failed`，不得编码为 `NaN`、`null`、小数、负数或越界端口。请求显式传入空白 `heartbeatSecret`、`heartbeat.secret`、`remoteName`、`endpoint`、`bucket`、`accessKeyId`、`secretAccessKey` 或 `prefix` 时，必须返回 `400 validation_failed`，不得回退到默认值或随机生成凭据；仅字段缺省时才允许使用兼容默认值。该接口是管理调试/兼容入口，返回的 `profile.storage.secretAccessKey` 和 `profile.heartbeat.secret` 可保留真实密钥供复制导入码，但控制台展示和日志仍必须脱敏。

服务端签发的完整 profile、`POST /api/claims/create` 响应、`POST /api/claims/redeem` 响应和 `POST /api/profile/encode` 响应必须分别通过共享运行时契约 `assertServerIssuedProfileContract`、`assertClaimCreateResponseContract`、`assertClaimRedeemResponseContract` 和 `assertProfileEncodeResponseContract` 校验。`/api/claims/create.code` 是 `AAAA-AAAA` 人工加入短码，必须与对应服务端 HTTP(S) origin 一起提交给客户端，由客户端调用服务端兑换；`tKey` / `claimCode` 是自带服务端地址的 `SFSC1-...` 完整 SyncKey，`tKeyUri` / `uri` 是自带服务端地址的 `sfsc://import/v1#...` 完整导入 URI。

`POST /api/singbox/client-config` 用于从 VLESS URI 生成客户端 sing-box 配置预览。请求 schema 只允许 `uri` 和 `options.localProxyPort`，未知 `options` 字段必须丢弃；请求不得覆盖客户端本地监听地址、日志级别、TUN、系统代理或系统路由行为。该成功响应是 singbox client config response contract：响应顶层必须且只包含 `profile` 和 `config`；`profile` 必须遵守 vless parse response contract 中的解析 profile 结构；`config.inbounds[0]` 必须是监听 `127.0.0.1:{localProxyPort}` 的本地 `mixed` 代理，VLESS 出站必须关闭 mux，并且不得要求 TUN、系统代理或系统路由变更。若 `profile.security === "reality"`，出站 TLS REALITY 的 `public_key` 和 `short_id` 必须与 `profile.publicKey` / `profile.shortId` 对齐；若 `profile.security === "tls"`，出站 TLS `server_name` 必须与 profile SNI 对齐，并在 `transport === "ws"` 时保留 profile 的 `path` / `host`；若 `security === "none"`，出站不得返回 `tls`。

`POST /api/jobs/preview` 用于服务端兼容预览，不落盘、不启动进程。请求可同时包含 `uri`、`options` 和 `job`；响应顶层必须且只包含 `profile`、`singbox`、`rclone` 和 `schedule`。服务端 preview 请求 schema 必须对 `options` 和 `job` 做字段级白名单归一化，未知字段必须丢弃；`options` 只允许 `localProxyPort`、`rcloneBin` 和 `rcloneConfigPath`，不得覆盖本地代理监听地址或 sing-box 日志级别；`job` 只允许 rclone/schedule 预览所需的执行字段，包括 `id`、`name`、`direction`、`localPath`、`remoteName`、`bucketName`、`bucket`、`clientName`、`remoteFolder`、`serverSpace`、`serverSubdir`、`remotePrefix`、`remotePath`、`storageBackend`、`s3Endpoint`、`endpoint`、`s3Region`、`region`、`accessKeyId`、`s3AccessKeyId`、`secretAccessKey`、`s3SecretAccessKey`、`transfers`、`streams`、`checkers`、`s3UploadConcurrency`、`s3ChunkSize`、`chunkSize`、`cutoff`、`retries`、`lowLevelRetries`、`dryRun`、`destructiveSync`、`bandwidthLimit` 和 `schedule`。无 `uri` 时 `profile` 和 `singbox` 必须同时为 `null`；传入 `uri` 时 `profile` 必须遵守 vless parse response contract 中的解析 profile 结构，`singbox` 必须遵守 singbox client config response contract 中的客户端配置结构，并与同一份 `profile` 和 `options.localProxyPort` 对齐。该成功响应是 jobs preview response contract，并复用 sync preview contract 约束 `rclone` 和 `schedule`。`options.localProxyPort` 必须是 1..65535 的整数；`job.transfers`、`job.streams`、`job.checkers`、`job.retries`、`job.lowLevelRetries` 和 `job.s3UploadConcurrency` 必须是正整数；非法值返回 `400 validation_failed`，不得进入 sing-box `listen_port`、代理 URL 或 rclone args。`rclone` 预览必须使用进程级代理环境变量，`displayCommand` 和 `remoteConfig.displayCommand` 必须脱敏密钥，`remoteConfig.args` 不得包含密钥，密钥只能通过 `remoteConfig.env` 的 `RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY` 注入。`schedule.text` 是展示文本，`schedule.nextRun` 为 ISO 时间、`on-startup` 或 `null`。

公开运行接口：

- `GET /api/health`
- `POST /api/claims/redeem`
- `POST /api/devices/heartbeat`

`POST /api/claims/redeem` 是公开兑换入口，必须在业务兑换前执行在线猜测防护。服务端不得把完整 SyncKey、完整导入 URI 或短码原文写入日志、状态或限速键；限速键只能使用远端地址和 SyncKey code 摘要等脱敏材料。连续失败超过窗口阈值时返回 `429 claim_redeem_rate_limited`，不得泄露短码是否接近有效值，也不得把 SyncKey 标记为 used。失败窗口必须写入服务端内部状态，使同一数据目录上的服务重启后仍保留限速语义；该内部状态不得出现在 `/api/admin/state` 摘要、日志或诊断包中。成功兑换后应清理该来源和该 code 摘要的失败窗口，并把清理结果持久化。

管理 token 校验：

```http
GET /api/admin/auth/check
Authorization: Bearer {token}
```

成功响应是 admin auth check response contract：

```json
{
  "ok": true,
  "adminAuth": {
    "enabled": true
  }
}
```

### 管理状态

```http
GET /api/admin/state
```

服务端启动时必须先获取 `SERVER_DATA_ROOT/sfsc-state.lock`，再读取 `SERVER_DATA_ROOT/sfsc-state.json`。同一个 `SERVER_DATA_ROOT` 在任意时刻只能有一个 sync-server 写入者；若锁已存在且不能确认为已退出进程留下的陈旧锁，第二个进程必须启动失败并报告 `409 server_state_locked`，不得继续以多写入者模式运行。该锁用于防止两个容器、两个本地进程或错误的共享挂载同时修改同一份管理状态。owner 必须记录容器 `instanceId`、PID、`processStartedAt` 和 `heartbeatAt`：同一 `instanceId` 内 PID 复用时以进程启动身份判断，不同容器实例仅在心跳超过陈旧阈值后自动接管；其他无法判断的情况只能由管理员在确认没有活动 sync-server 进程后手工清理。`sfsc-state.json` 不存在时可以初始化默认状态；文件存在但不是合法 JSON 时必须失败并报告 `server_state_corrupt`，不得用默认状态覆盖原文件。服务端状态写入必须使用临时文件和原子 rename，避免中途崩溃留下半写 JSON。涉及管理状态修改的 `POST /api/admin/*`、`POST /api/claims/create`、`POST /api/claims/redeem` 和 `POST /api/devices/heartbeat` 必须串行执行从内存修改到持久化完成的整个写事务，避免并发请求互相覆盖 `adminState`。若状态文件写入失败，接口必须返回 `500 server_state_write_failed`，并回滚本次请求对内存中 `adminState` 的修改。

返回管理摘要，顶层必须包含 `version`、`appVersion`、`diagnostics`、`updatedAt`、`settings`、`tunnel`、`storage`、`defaults`、`users[]`、`devices[]` 和 `claims[]`。其中 `diagnostics.role` 必须为 `server`，`diagnostics.protocols` 必须包含 `claim`、`profile`、`adminState`、`clientStatus` 和 `heartbeat` 正整数版本。该响应是 admin state summary contract，`settings`、`tunnel`、`storage`、`defaults`、`users[]`、`devices[]` 和 `claims[]` 的子结构必须分别遵守下列摘要合同。敏感项必须脱敏：

- `storage.secretAccessKey`
- `users[].storage.secretAccessKey`
- `tunnel.reality.privateKey`
- 完整 `vless://` URI

生成 sing-box 配置文件时仍使用真实 private key；管理摘要、自动补全响应和配置预览响应只返回遮罩值。

管理端提交 tunnel 配置时，`reality.privateKey` 为空或包含 `***` 表示保持现有 private key 不变。

所有返回管理摘要或控制台调试展示用 JSON 的接口都必须遵守同样的脱敏规则。`/api/claims/create` 和 `/api/claims/redeem` 返回的 profile 是客户端导入凭据，允许保留真实 `profile.storage.secretAccessKey`，但服务端控制台展示该 profile 时必须再次脱敏；复制的 SyncKey/URI 仍保持真实值。

管理摘要的 `settings` 是服务端控制台全局设置合同，必须至少包含 `publicServerUrl`。`settings.publicServerUrl` 必须是规范化后的 `http` 或 `https` URL，且不得带尾部 `/`；该值是生成 SyncKey/claim token 时写入 `claim.server` 和客户端导入来源的默认服务端地址。`/api/claims/create` 请求体显式传入 `server` 时，服务端必须先规范化该 URL、更新当前 `settings.publicServerUrl`，并让本次返回的 `claim.server`、管理摘要中的 claim summary `server` 和客户端解析出的 claim source server 使用同一个规范化值。`settings.publicServerUrl` 不等同于 VLESS/sing-box 的 `tunnel.publicHost` 与 `tunnel.publicPort`，后者只用于生成 `vless://` 传输 URI。该结构是 admin settings summary contract。

管理摘要的 `tunnel` 是服务端 VLESS/sing-box 配置状态合同，必须至少包含 `id`、`name`、`protocol`、`listenHost`、`listenPort`、`publicHost`、`publicPort`、`security`、`transport`、`transportPath`、`remark`、`reality`、`lastConfigWrittenAt`、`lastAppliedAt`、`restartRequired`、`userCount`、`sampleUri`、`sampleUriAvailable` 和 `sampleUriRevealPath`。`protocol` 只允许 `vless-tcp-none`、`vless-reality-tcp` 或 `vless-ws-tls`；`security` 必须随协议分别为 `none`、`reality` 或 `tls`；`transport` 必须分别为 `tcp`、`tcp` 或 `ws`。`vless-ws-tls` 的 `transportPath` 必须是安全绝对 URL 路径，且公网端口通常为 Caddy TLS 端口 `443`；其 sing-box 入站只接受 Docker 内网的 WebSocket。端口必须是 1 到 65535 的整数；`restartRequired` 必须是布尔值；`lastConfigWrittenAt` 和 `lastAppliedAt` 必须为 `null` 或字符串。`reality` 至少包含 `serverName`、`fingerprint`、`publicKey`、脱敏 `privateKey` 和 `shortId`；`privateKey` 不得返回原始 REALITY private key。`userCount` 表示启用且未删除设备数量；`/api/admin/state` 默认不得返回完整 VLESS URI，`sampleUri` 必须始终为 `null`。当 `userCount === 0` 时 `sampleUri` 必须为 `null`、`sampleUriAvailable` 必须为 `false`、`sampleUriRevealPath` 必须为空字符串；当 `userCount > 0` 时 `sampleUriAvailable` 必须为 `true`，`sampleUriRevealPath` 必须指向 `GET /api/admin/devices/{id}/vless-uri`。该结构是 admin tunnel summary contract。

管理摘要的 `storage` 是服务端 SyncKey 默认存储目标和 bucket 运维状态合同，必须至少包含 `id`、`type`、`name`、`remoteName`、`endpoint`、`internalEndpoint`、`bucket`、`accessKeyMode`、`accessKeyId`、脱敏 `secretAccessKey`、`prefixRoot`、`sharedPrefix` 和 `buckets[]`。`endpoint` 与 `internalEndpoint` 必须是 `http` 或 `https` URL；`secretAccessKey` 必须为遮罩值，不得返回原始 S3/MinIO 密钥。`storage.bucket` 必须出现在 `storage.buckets[]` 中。每个 bucket 摘要必须包含 `name`、`createdAt`、`source`、`objectCount`、`sizeBytes`、`disabledAt`、`clearedAt`、`endpoint`、`remoteName` 和 `prefixes[]`；其中时间字段为 `null` 或 ISO 字符串，计数字段为 `null` 或有限数字。`prefixes[]` 必须包含 `${prefixRoot}/` 和 `${sharedPrefix}/`，用于控制台和诊断包解释设备私有空间与共享空间。该结构是 admin storage summary contract。

管理摘要的 `defaults` 是服务端 SyncKey/profile 默认同步参数合同，必须至少包含 `localProxyPort`、`transfers`、`streams`、`checkers`、`chunkSize`、`retries`、`lowLevelRetries`、`bandwidthLimit` 和 `schedule`。`localProxyPort` 必须是 1 到 65535 的 TCP 端口；`transfers`、`streams`、`checkers`、`retries` 和 `lowLevelRetries` 必须是正整数；`chunkSize` 必须是非空字符串；`bandwidthLimit` 必须使用本文前述 rclone `--bwlimit` 兼容字符串；`schedule` 必须使用本文前述 `manual`、`interval`、`daily` 或 `startup` 结构。该结构是 admin defaults summary contract。

管理摘要的 `users[]` 是服务端控制台管理设备凭据和 sing-box 用户的运维列表合同，不等同于客户端心跳使用的 `devices[]`。每个用户必须至少包含 `id`、`clientName`、`uuid`、`enabled`、`createdAt`、`updatedAt`、`storage`、`vlessUriAvailable` 和 `vlessUriRevealPath`；`deletedAt` 可缺省，存在时必须为 `null` 或 ISO 字符串。`enabled` 和 `vlessUriAvailable` 必须是布尔值；`vlessUriRevealPath` 为空字符串或指向 `GET /api/admin/devices/{id}/vless-uri`。`storage` 必须至少包含 `accessKeyId`、脱敏 `secretAccessKey`、`bucket` 和 `prefix`，其中 `secretAccessKey` 不得返回原始 S3/MinIO 密钥。读取历史 `sfsc-state.json` 时，服务端必须把 legacy user 迁移为当前设备模型，补齐 `storage`、`heartbeatSecret`、`heartbeatAuthNonces`、`enabled`、`createdAt` 和 `updatedAt` 默认值；legacy diagnostics 只有满足完整客户端运行时诊断合同时才能保留，否则必须从设备摘要中置为 `null`，并通过 `compatibility.action: "diagnostics_missing"` 提示重新确认。迁移后的用户必须能被 `/api/admin/state` 摘要展示，并可继续重新签发 SyncKey/profile。`users[]` 可以包含已删除用户，用于审计和操作回显；客户端运行态不得依赖该列表，应使用 profile、heartbeat 或 `devices[]` 摘要。`users[]` 不得包含顶层原始密钥、SyncKey、claim code、token、完整 profile、完整 `vlessUri`、`heartbeatSecret` 或 `heartbeatAuthNonces`。该结构是 admin user summary contract。

管理摘要的 `devices[]` 是服务端控制台和客户端心跳回显共同使用的设备摘要合同。每个设备必须至少包含：

- `id`、`clientName`、`status`、`bucket`、`prefix`、`clientVersion`、`lastRemoteAddress` 字符串。
- `enabled`、`online` 布尔值；`lastSeenAt` 为 `null` 或 ISO 字符串。
- `diagnostics` 为 `null` 或客户端诊断块，且 `diagnostics.role` 必须为 `client`，`diagnostics.protocols` 必须包含 `claim`、`profile`、`adminState`、`clientStatus` 和 `heartbeat` 正整数版本。
- `compatibility` 必须遵守 compatibility contract：顶层必须且只包含 `action`、`issues`、`localRole`、`ok`、`policy`、`remoteRole`、`severity` 和 `status`；`status` 只能是 `compatible` 或 `mismatch`，`action` 只能是 `none`、`diagnostics_missing`、`upgrade_remote`、`upgrade_local` 或 `manual_check`，`severity` 只能是 `ok` 或 `warning`。`policy` 必须且只包含 `adminActions`、`heartbeat`、`profileIssue`、`reason` 和 `syncRun`，除 `reason` 外只能取 `allow` 或 `warn`，且 `policy.reason` 必须等于 `action`。`issues[]` 每项必须且只包含 `field`、`local`、`message`、`remote` 和 `type`；`field` 只能是 `adminState`、`claim`、`clientStatus`、`heartbeat` 或 `profile`，`type` 只能是 `local_missing`、`remote_missing`、`remote_newer` 或 `remote_older`，`local` / `remote` 必须是正整数或 `null`，`message` 必须是非空字符串。
- `sync` 必须为对象，`sync.state` 必须是 `idle`、`syncing`、`error`、`stopping` 或 `offline`；顶层 `syncState` 必须与 `sync.state` 完全一致。
- 顶层 `speedMbps` 和 `sync.speedMbps` 必须是有限数字；顶层 `speedMbps` 必须作为 UI 快速展示字段与当前 `sync.speedMbps` 保持一致。

`devices[]` 不得包含原始密钥、心跳认证内部状态、完整 `vlessUri` 或一次性凭据字段，例如 `secretAccessKey`、`privateKey`、`heartbeatSecret`、`heartbeatAuthNonces`、`tKey` 或 `claimCode`。服务端控制台若需要复制完整 VLESS URI，必须使用显式 reveal 接口；客户端本地 `heartbeat.device` 快照也不得保存该字段。

```http
GET /api/admin/devices/{id}/vless-uri
```

该接口受管理 token 保护，仅用于服务端控制台或运维人员明确点击复制/查看完整 VLESS URI。成功响应是 admin device VLESS URI reveal contract，顶层必须且只包含 `device` 和 `vlessUri`；`device` 必须且只包含 `id` 和 `clientName`；`vlessUri` 必须是可解析的 `vless://` URI，且 URI 的 host、port、security 和 type 必须分别与当前 `tunnel.publicHost`、`tunnel.publicPort`、`tunnel.security` 和 `tunnel.transport` 一致。设备不存在或已删除返回 `404 device_not_found`。该接口是唯一允许返回管理设备完整 VLESS URI 的常规管理读接口；`/api/admin/state`、所有写接口返回的 `state`、smoke 报告、诊断包和控制台调试 JSON 都不得默认携带完整 VLESS URI。

管理摘要的 `claims[]` 是服务端控制台展示 SyncKey 生命周期的只读摘要合同。每个 claim 必须至少包含 `id`、`code`、`userId`、`clientName`、`bucketName`、`profileId`、`used`、`createdAt`、`expiresAt`、`redeemedAt` 和 `server`；其中 `code` 必须是 `AAAA-AAAA` 无歧义短码，字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，`used` 必须是布尔值，`expiresAt` 与 `redeemedAt` 必须为 `null` 或 ISO 字符串。若 `used === true`，`redeemedAt` 必须为非空字符串。服务端内部可以为短时绑定重放记录 `claim.redeemedBy.clientRedeemId`、`claim.redeemedBy.clientInstallIdHash`、`claim.redeemedBy.firstRedeemedAt` 和 `claim.replayUntil`；管理摘要若展示这些恢复字段，只能展示 `clientRedeemId`、`clientInstallIdHash`、时间和布尔状态，不得展示原始 `clientInstallId`。状态保存前必须执行保守压缩：已兑换 claim 继续保留审计摘要，过期未使用 claim 在保留期后删除，过期的短时重放绑定只保留 `firstRedeemedAt`，不再保留绑定 ID 或安装 ID 哈希；已软删除且不再被 claim 引用的用户在保留期后可从 `users[]` 删除。`claims[]` 不得包含完整 `profile`、完整 `tKey`、`tKeyUri`、legacy `claimCode` / `token`、`uri`、VLESS URI 或存储密钥；完整导入凭据只允许出现在 `/api/claims/create` 响应和控制台复制动作的内存态中，不得进入管理摘要调试 JSON。

### 首次运行就绪度

```http
GET /api/admin/setup
```

该接口受管理 token 保护，返回普通目录首用的三步就绪度。响应顶层必须且只包含 `complete`、`currentStepId` 和 `steps`；`steps[]` 的顺序固定为 `directory` → `repair` → `pairing`。每一步必须包含 `id`、`title`、`hint`、`ready`、`blocked`、`blockedBy`、`blockedReason` 和 `evidence`。

目录步骤要求 catalog 中至少有一个 active root，且服务端重新校验其 marker、挂载身份和读写权限。修复步骤要求当前配置写入和应用时间存在、`restartRequired` 为假、sing-box 进程与端口通过实时探针，并且 bootstrap 与 data overlay 的 supervisor 回执都匹配配置文件当前 SHA-256。配对步骤要求至少一个未撤销的已消费设备 grant 绑定到当前已实测可用目录。MinIO / S3 配置、桶数量和存储探针不构成普通目录首用的前置条件，相关旧入口继续作为兼容路径提供。缺失目录、应用回执或授权证据必须保持未就绪；不得以默认值、目录记录数量或 `/api/health` 的字面 `ok: true` 代替证据。此三步只表示服务端目录、连接应用和配对证据齐备，不等同于客户端首次双向文件同步已通过。

`ready` 与 `blocked` 是两件事：`blocked` 表示前置步骤未完成，`blockedBy` 指向第一个未就绪的步骤 id。该接口刻意独立于 `GET /api/admin/state`：就绪度需要带超时的实时探针与 catalog/receipt 读取，而管理摘要是被控制台高频轮询的同步纯函数。响应不得包含存储 secret、管理 token 或出厂占位口令原文。就绪度未取到时界面必须显示为未验证，不得显示为正常。`complete` 为真时首次配置面板与导航入口收起，但判定必须是显式等于 `true`。

### 危险操作确认

危险操作必须由前端弹层明确确认，且服务端会强制校验确认字段。

#### 生成 sing-box 配置

```http
POST /api/admin/tunnel/generate
```

请求必须包含：

```json
{
  "confirmGenerateTunnel": true
}
```

该 2xx 响应是 admin tunnel generate response contract：顶层必须且只包含 `tunnel`、`config` 和 `state`。`tunnel` 必须与 `state.tunnel` 完全一致，并遵守 admin tunnel summary contract；`config` 必须是本次写入的服务端 sing-box 配置对象，并与 `state.tunnel`、启用且未删除的 `state.users[]` 对齐；`state` 必须遵守 admin state summary contract。成功生成后 `state.tunnel.restartRequired` 必须为 `true`，且 `state.tunnel.lastConfigWrittenAt` 必须是本次写入时间的非空 ISO 字符串。

写入 sing-box 配置、启用设备、停用设备或删除设备会让 `state.tunnel.restartRequired` 变为 `true`。控制台必须明显提示“配置已写入但尚未生效”，管理员重启 sing-box 后调用：

```http
GET /api/admin/singbox/config
```

该接口返回当前服务端 sing-box 配置预览，用于控制台只读刷新和 smoke 验证配置结构。控制台读取该接口不得写入管理状态、不得生成新配置，也不得改变 `restartRequired`。控制台在 `POST /api/admin/tunnel/generate`、`POST /api/admin/users/enable`、`POST /api/admin/users/disable` 和 `POST /api/admin/users/delete` 成功后必须展示响应中的最新 `config`；在 `POST /api/claims/create` 成功后必须通过该只读接口刷新预览，避免 SyncKey 生成已经写入配置但管理员仍看到旧 sing-box 配置。响应顶层必须且只包含 `path` 和 `config`。响应必须遵守管理摘要脱敏规则：REALITY private key、存储密钥和其他敏感字段不得以原文出现在预览或调试 JSON 中。

配置预览必须与 `/api/admin/state` 的管理摘要保持一致：`config.inbounds[0].type` 必须为 `vless`；`listen` 和 `listen_port` 必须分别等于 `state.tunnel.listenHost` 和 `state.tunnel.listenPort`；`users[]` 必须且只包含 `state.users[]` 中启用且未删除的用户，并用 `clientName` / `uuid` 映射为 sing-box 用户的 `name` / `uuid`。当 `state.tunnel.security === "reality"` 时，`config.inbounds[0].tls.enabled` 必须为 `true`，`tls.server_name`、`tls.reality.handshake.server` 和 `tls.reality.short_id[]` 必须与 `state.tunnel.reality.serverName`、`state.tunnel.reality.shortId` 对齐，`tls.reality.private_key` 必须为遮罩值；当 `state.tunnel.security === "tls"` 且 `transport === "ws"` 时，入站不得再配置 TLS，而必须设置 `transport.type === "ws"` 与 `transport.path === state.tunnel.transportPath`，TLS 由同一 Docker 网络中的 Caddy 终结；当 `state.tunnel.security === "none"` 时，预览不得返回 `tls`。该结构是 admin sing-box config preview contract。

```http
POST /api/admin/singbox/write
```

`singbox/write` 是运维重写配置入口，也必须提交显式确认字段 `confirmWriteSingbox`：

```json
{
  "confirmWriteSingbox": true
}
```

缺少确认返回 `400 danger_confirmation_required`。该 2xx 响应是 admin sing-box write response contract：顶层必须且只包含 `path`、`restartRequired`、`config` 和 `state`。`path` 必须是本次写入的服务端 sing-box 配置文件路径；`restartRequired` 必须为 `true`，且最新 `state.tunnel.restartRequired` 必须为 `true`；`state.tunnel.lastConfigWrittenAt` 必须是本次写入时间的非空 ISO 字符串；`config` 必须是本次写入的服务端 sing-box 配置对象，并与 `state.tunnel`、启用且未删除的 `state.users[]` 对齐；`state` 必须遵守 admin state summary contract。这仍只表示配置文件已更新，不表示 sing-box 进程已加载。

`POST /api/admin/singbox/write` 只有在服务端成功写入 sing-box config 且成功持久化 `sfsc-state.json` 后才算发布。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt` 的内存修改；若请求前不存在 sing-box config 文件，必须删除本次未提交的新 config，控制台不得展示未持久化的“配置已写入”状态。

若服务端写入 sing-box 配置文件失败，相关入口必须返回 `500 server_singbox_config_write_failed`，并回滚本次请求对内存中 `adminState` 的修改；不得让 `/api/admin/state` 显示一个尚未成功写入配置文件的 tunnel、device 或 SyncKey 状态。sing-box config 文件写入必须使用临时文件和原子 rename，避免中途崩溃留下半写配置。若入口需要同时写入 sing-box 配置文件和 `sfsc-state.json`，则 `sfsc-state.json` 写入失败时必须返回 `500 server_state_write_failed`，回滚内存中的 `adminState`，并恢复本次请求前的 sing-box config 文件内容；如果本次请求前不存在 config 文件，则必须删除本次新写出的 config 文件，避免磁盘上留下尚未持久化到 state 的幽灵设备或幽灵 SyncKey 配置。涉及管理状态修改的 `POST /api/admin/*`、`POST /api/claims/create`、`POST /api/claims/redeem` 和 `POST /api/devices/heartbeat` 在失败时都必须回滚本次请求内存变更。

```http
POST /api/admin/singbox/apply
```

该接口是服务端控制台的实际“重启并应用”入口，请求必须包含 `{ "confirmApplySingbox": true }`。服务端只能通过部署时配置的私有文件控制目录提交固定重启请求；sing-box supervisor 必须先执行配置检查，检查通过后仅重启其管理的 sing-box 子进程，并返回与请求 ID 匹配的结果。不得向 sync-server 挂载 Docker socket，也不得接受客户端提供的命令、容器名或文件路径。成功后接口才可记录 `tunnel.lastAppliedAt` 并清除 `tunnel.restartRequired`。

该 2xx 响应是 admin sing-box apply response contract：顶层必须且只包含 `restart` 和 `state`；`restart` 必须且只包含 `ok`、`message`、`restartedAt` 和 `configSha256`，其中 `restart.ok` 必须为 `true`、`message` 必须是非空字符串、`restartedAt` 必须是 ISO 时间字符串或 `null`、`configSha256` 必须是本次校验并加载的配置 SHA-256；`state` 必须遵守 admin state summary contract，且 `state.tunnel.restartRequired` 必须为 `false`、`state.tunnel.lastAppliedAt` 必须是非空 ISO 时间字符串。服务端必须以当前管理状态生成的预期配置哈希发起请求，supervisor 只有在磁盘配置哈希一致、配置检查通过、重启后的进程存活且监听端口可连接时才能返回成功。未配置 supervisor 返回 `503 singbox_restart_unavailable`，哈希不匹配、配置检查或重启失败返回 `502 singbox_restart_failed`，等待结果超时返回 `504 singbox_restart_timeout`；这些失败均不得清除待应用状态。

```http
POST /api/admin/singbox/mark-applied
```

该接口记录 `tunnel.lastAppliedAt` 并清除 `tunnel.restartRequired`，仅为旧版外部运维脚本保留。常规控制台必须调用 `/api/admin/singbox/apply`，不得让用户在没有实际重启的情况下手工标记。控制台不得把“配置已写入”等同于“sing-box 已加载新配置”。

控制台提交生成前必须展示影响摘要，至少包含当前设备总数、启用设备数、在线设备数、受影响设备示例，以及启用设备中的协议兼容性警告数量。摘要必须提示写入配置后仍需重启 sing-box 并标记已应用。

`mark-applied` 只能在 `tunnel.restartRequired === true` 时调用，且请求必须包含字段 `confirmMarkApplied`：

```json
{
  "confirmMarkApplied": true
}
```

缺少确认返回 `400 danger_confirmation_required`；没有待应用变更时返回 `400 validation_failed`，不得刷新 `lastAppliedAt`。

该 2xx 响应是 admin sing-box mark-applied response contract：顶层必须且只包含 `state`。`state` 必须遵守 admin state summary contract，且 `state.tunnel.restartRequired` 必须为 `false`，`state.tunnel.lastAppliedAt` 必须为本次标记时间的 ISO 字符串。

若标记已应用时服务端无法写入 `sfsc-state.json`，接口必须返回 `500 server_state_write_failed`，并回滚本次请求对 `tunnel.restartRequired` 和 `tunnel.lastAppliedAt` 的内存修改；失败后 `/api/admin/state` 仍必须显示请求前的待应用状态，控制台不得展示一个未持久化的“已应用”状态。

N1 验收自动化可以使用独立 apply 脚本完成“重启 sing-box → 标记已应用 → 最终 smoke”闭环，但该脚本必须先确认 N1 的 `sing-box` 服务已重启或加载最新 `/server-singbox/config.json`，再调用 `POST /api/admin/singbox/mark-applied`。脚本默认必须校验 SSH `RemoteHost` 与 `SmokeBaseUrl`/admin API 指向同一 host，避免重启 A 机器却清除 B 机器状态；只有显式拆分目标的测试才允许覆盖该保护。最终验收证据必须来自 `scripts/smoke-server.mjs --json-report` 的 `summary.restartRequired=false`，且 apply 报告不得记录真实管理 token、SSH 私钥、`.env`、完整 sing-box 配置、SyncKey、导入 URI、VLESS URI 或 heartbeat secret。

部署或迁移后应运行只读 smoke 检查：

```bash
SFSC_SMOKE_BASE_URL=http://127.0.0.1:5177 SFSC_ADMIN_TOKEN=... node scripts/smoke-server.mjs
```

默认 smoke 必须保持只读，不得创建 SyncKey 或设备。若需要在测试环境覆盖真实写路径，必须显式使用 `--exercise-claim-lifecycle` 或 `SFSC_SMOKE_EXERCISE_CLAIM_LIFECYCLE=1`；该模式使用一次性 client/device 名称，执行 `POST /api/claims/create` → 带 `clientRedeemId` / `clientInstallId` 的 `POST /api/claims/redeem` → 同一客户端绑定短时重放成功 → 缺失绑定的重复 redeem 返回 `409 claim_already_used` → 不同客户端绑定的重复 redeem 返回 `409 claim_already_used` → 带 `sfsc-hmac-sha256-v1` 签名的 `POST /api/devices/heartbeat` → `GET /api/admin/state` 验证设备摘要和已使用 claim。若测试环境需要自动清理本次临时设备，可额外显式使用 `--cleanup-claim-lifecycle` 或 `SFSC_SMOKE_CLEANUP_CLAIM_LIFECYCLE=1`；该选项只能与 lifecycle 验收一起使用，成功验证后调用 `POST /api/admin/users/delete` 软删除本次 `sfsc-smoke-client-*` 设备，并保留已使用 claim 摘要作为审计记录。N1 post-deploy 等验收脚本可以把 lifecycle flags 暴露为 `-ExerciseClaimLifecycle` / `-CleanupClaimLifecycle` 并透传到 server smoke；cleanup 只能与 exercise 一起使用；验收报告不得包含 token/SyncKey/URI secrets。cleanup 会再次写入 sing-box 配置并让 `restartRequired` 保持或变为 `true`，管理员仍需重启 sing-box 后再标记已应用。JSON 报告必须在 `context.exerciseClaimLifecycle`、`context.claimLifecycleClientName` 和 `context.claimLifecycleDeviceName` 记录本次生命周期验收的可清理索引，在 `context.cleanupClaimLifecycle*` 字段记录清理是否请求、设备是否删除、claim 是否保留和清理后的待应用状态，并在 `summary.restartRequired`、`summary.userCount`、`summary.deviceCount` 和 `summary.claimCount` 记录最终管理状态摘要；但不得记录完整 SyncKey、导入 URI、heartbeat secret 或管理 token。

smoke 检查必须覆盖 `/api/health`、管理鉴权、`/api/admin/state`、`/api/admin/singbox/config`、`/api/profile/encode`、`/api/vless/parse`、`/api/singbox/client-config`、`/api/jobs/preview`、管理响应脱敏、admin state summary contract、admin settings summary contract、admin tunnel summary contract、admin storage summary contract、admin defaults summary contract、admin user summary contract、admin device summary contract、admin claim summary contract 和 admin sing-box config preview contract。服务端 `/api/health.adminAuth.enabled` 必须是布尔值；服务端 `/api/health.diagnostics.protocols` 必须与 `/api/admin/state.diagnostics.protocols` 完全一致，smoke 应在 `admin-state` 检查中输出 `protocols=aligned`；任一字段不一致都视为协议漂移失败。启用管理 token 时，smoke 还必须验证未带 token 的管理接口返回 `401 admin_auth_required`；管理响应脱敏至少检查 `storage.secretAccessKey`、`users[].storage.secretAccessKey`、`tunnel.reality.privateKey` 和 sing-box 配置预览中的 REALITY `private_key` 为遮罩值，且响应中不得出现 smoke 运行环境已知的原始 token 或密钥值。smoke 还必须逐项校验 `settings` 的 SyncKey server 默认地址、`tunnel` 的协议、端口、待应用状态、`sampleUri === null`、`sampleUriAvailable` 和 `sampleUriRevealPath`；当需要验证完整 VLESS URI 时，必须通过显式 reveal 接口读取，并确认 host、port、security 和 type 与 `tunnel` 摘要一致。smoke 还必须校验 sing-box 配置预览与 `state.tunnel`、启用且未删除的 `state.users[]` 和 REALITY 摘要对齐，校验 `storage` 的默认 bucket 与 bucket 摘要、`defaults` 的 profile 默认参数、`users[]` 的管理用户摘要、`devices[]` 的设备摘要合同和 `claims[]` 的 SyncKey 生命周期摘要合同。无状态兼容入口检查不得创建 SyncKey、写入管理状态或重启远端服务：`/api/profile/encode` 必须返回包含 `heartbeat.scheme: "sfsc-hmac-sha256-v1"` 和非空 `heartbeat.secret` 的完整导入 profile；`/api/vless/parse` 必须遵守 vless parse response contract；`/api/singbox/client-config` 必须遵守 singbox client config response contract；`/api/jobs/preview` 必须遵守 jobs preview response contract，尤其是 `profile`、`singbox`、`rclone` 和 `schedule` 顶层结构、sing-box 本地监听端口、`remoteConfig.args` 不得含密钥（密钥经 `remoteConfig.env` 注入）且 display 命令必须脱敏。失败信息应包含 `settings.*`、`tunnel.*`、`config.inbounds[0].*`、`storage.buckets[index]`、`defaults.*`、`users[index]`、`devices[index]`、`claims[index]`、`profileEncode.*`、`vlessParse.*`、`singboxClientConfig.*` 或 `jobsPreview.*` 字段路径，便于定位双端协议漂移。smoke 的 HTTP 请求必须带超时控制，默认 15 秒，并允许通过 `SFSC_SMOKE_TIMEOUT_MS` 或 `--timeout-ms` 覆盖。smoke 失败输出必须包含当前检查阶段；HTTP 非 2xx 响应必须包含请求路径、HTTP 状态和结构化 `errorCode` 摘要。smoke 必须支持 `--json-report` 或 `SFSC_SMOKE_JSON_REPORT` 输出机器可读报告，报告至少包含 `schemaVersion`、`ok`、`context`、`summary`、`checks` 和失败时的 `failure`；`summary` 必须包含 `passed`、`failed`、`appVersion`、`protocolsAligned`、`restartRequired`、`userCount`、`deviceCount` 和 `claimCount`，用于 N1 验收判断协议通过但运行配置待应用的状态；报告不得包含真实管理 token，只允许出现 `adminAuthProvided` 布尔值。

SyncKey 兑换限速来源默认只能使用直连 socket remote address，必须忽略客户端提供的 `X-Forwarded-For`。只有部署在反代后并显式设置 `SFSC_TRUST_PROXY=1` 时，服务端才允许读取 `X-Forwarded-For` 的第一个有效客户端 IP；此时直连来源仍必须是 loopback 或 `SFSC_TRUSTED_PROXY_IPS` 中配置的可信代理 IP / IPv4 CIDR。`SFSC_TRUSTED_PROXY_IPS` 配置错误必须在启动时失败，不得静默退化为信任所有 XFF。限速审计日志和状态只能记录来源 IP 与 code hash，不得记录完整 SyncKey、短码原文、管理 token 或导入 URI。

#### 重新生成 REALITY key

已有 REALITY key 时调用：

```http
POST /api/admin/tunnel/autofill
```

若 `forceRealityKeys: true`，请求必须包含：

```json
{
  "confirmRotateRealityKeys": true
}
```

控制台提交 REALITY key 轮换前必须展示比普通配置生成更强的影响摘要：旧 SyncKey/profile 中的 VLESS 参数会失效，管理员需要为受影响客户端重新生成 SyncKey 并重新导入。

该 2xx 响应是 admin tunnel autofill response contract：顶层必须且只包含 `tunnel` 和 `state`。`tunnel` 必须与 `state.tunnel` 完全一致，并遵守 admin tunnel summary contract；`state` 必须遵守 admin state summary contract。响应不得返回未遮罩的 REALITY private key、存储密钥、SyncKey、导入 URI 或 heartbeat secret；VLESS URI 只允许作为 `sampleUri` 或用户摘要中的展示字段出现。

`POST /api/admin/tunnel/autofill` 与 `POST /api/admin/tunnel/generate` 的请求可显式带 `transportPath`；该字段只在 `vless-ws-tls` 时生效，必须是安全绝对 URL 路径。接口只有在服务端成功持久化 `sfsc-state.json` 后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，并回滚本次对 tunnel 协议、host/port、REALITY 摘要、`tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt` 的内存修改；`vless-ws-tls` 还必须同时回滚传输路径。控制台不得展示未持久化的“自动补全 tunnel”状态。

全新部署的普通首用界面只收集管理员实际掌握的外部访问地址和端口；首次连接采用 `vless-reality-tcp` 并复用本接口的 REALITY key 生成器。`www.microsoft.com` 与 `chrome` 是仓库内置配置默认值，不是已验证的公网可达性或伪装目标验收结论。首次设置成功还必须经过 `/api/admin/singbox/apply` 的 supervisor 精确摘要回执；随后才可进入持久化 enrollment reconfigure 流程签发通道码。失败时界面不得声称连接已配置或已签发通道码。

### 存储配置和仓库管理

```http
POST /api/admin/storage/save
POST /api/admin/storage/buckets/refresh
POST /api/admin/storage/buckets/create
POST /api/admin/storage/buckets/enable
POST /api/admin/storage/buckets/disable
```

上述 `POST /api/admin/*` 管理写接口的 2xx JSON 响应必须遵守 admin write state response contract：顶层必须包含 `state`，且 `state` 必须遵守 admin state summary contract。若响应额外返回顶层 `storage` 或 `tunnel` 摘要，该别名必须分别与 `state.storage` 或 `state.tunnel` 完全一致；若响应返回 `user`、`bucket` 或 `deletedUserId` 等动作结果，`state` 中也必须能反映同一动作后的管理状态。管理写响应允许返回控制台展示所需的 VLESS 摘要字段，但不得返回未遮罩的 `secretAccessKey`、REALITY private key、heartbeat secret、完整 SyncKey 或 `sfsc://import/v1#` 导入 URI。`POST /api/claims/create` 也必须返回同一份 `state` 摘要，但该响应本身会按创建 SyncKey 合同返回一次性导入凭据，因此由 claim create response contract 单独校验。

`storage/save` 保存 S3/MinIO endpoint、access key、secret、默认 bucket 和 prefix 等配置；该 2xx 响应是 admin storage save response contract：顶层必须且只包含 `storage` 和 `state`，`storage` 必须遵守 admin storage summary contract 并与 `state.storage` 完全一致。响应必须返回脱敏后的管理摘要，不得把 `secretAccessKey` 原文写入控制台展示。bucket 名、endpoint、prefix 等字段校验失败返回 `400 validation_failed`。

`storage/buckets/refresh` 从当前 S3/MinIO 配置刷新 bucket 列表；该成功或部分失败响应是 admin storage buckets refresh response contract，响应顶层必须包含 `ok`、`buckets` 和 `state`。存储请求失败时该刷新操作不应破坏现有 bucket 列表，响应必须包含 `ok: false`、`errorCode: "storage_request_failed"`、`warning` 和当前 `buckets`，控制台必须给出检查 MinIO、endpoint、access key/secret 和权限的恢复建议。

请求 schema 是空 JSON 信封：`{}` 或空 body 归一化为 `{}`；非对象、数组或带任意字段的对象必须返回 `400 validation_failed`，且不得发起 S3/MinIO bucket list 或修改管理状态。

`storage/buckets/refresh` 只有在远端 bucket 列表读取成功且服务端成功持久化 `sfsc-state.json` 后才算从管理状态发布。若远端刷新成功后状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `storage.buckets[]`、默认 bucket 兜底和相关 `storage` 摘要的内存修改；控制台不得展示未持久化的“假刷新 bucket 列表”状态。

`storage/buckets/create` 登记同步仓库，并尝试在 S3/MinIO 中创建同名 bucket；该 2xx 响应是 admin storage bucket create response contract，顶层必须且只包含 `bucket`、`provision` 和 `state`。bucket 名非法返回 `validation_failed`。登记成功后管理摘要中的 `storage.buckets` 必须包含该 bucket；若远端 provision 失败，接口仍可返回 200 并保留登记结果，但响应的 `provision` 必须包含 `ok: false`、`errorCode: "storage_request_failed"` 和 `warning`。服务端控制台必须把这种部分成功作为 warning 展示在动作状态区，明确提示“已登记，但远端 MinIO/S3 创建未确认”，并给出检查 MinIO、endpoint、access key/secret 和 bucket 权限的恢复建议；不得只把失败原因放进调试 JSON。

`storage/buckets/create` 只有在服务端成功持久化 `sfsc-state.json` 后才算发布。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次新增的 `storage.buckets[]` 条目和相关 `storage` 摘要；控制台不得展示未持久化的“幽灵 bucket”状态。远端 provision 失败但状态持久化成功时仍可作为带 warning 的 2xx 部分成功处理。

`storage/buckets/enable` / `storage/buckets/disable` 使用 `{ "bucket": "..." }`。该 2xx 响应是 admin storage bucket toggle response contract，顶层必须且只包含 `bucket` 和 `state`，且 `bucket.disabledAt` 必须与 `state.storage.buckets[]` 中同名 bucket 一致。不存在返回 `404 bucket_not_found`；停用最后一个启用仓库返回 `409 last_active_bucket_disable_blocked`；停用默认 bucket 时服务端必须切换到另一个启用 bucket，后续 SyncKey 不得继续绑定已停用 bucket。

`storage/buckets/enable` 只有在服务端成功持久化 `sfsc-state.json` 后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `bucket.disabledAt` 和 `storage.buckets[]` 的内存修改；控制台不得展示未持久化的“假启用 bucket”状态。

`storage/buckets/disable` 只有在服务端成功持久化 `sfsc-state.json` 后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `bucket.disabledAt`、默认 `storage.bucket` 和 `storage.buckets[]` 的内存修改；控制台不得展示未持久化的“假停用 bucket”状态。

#### 清空或删除 bucket

```http
POST /api/admin/storage/buckets/clear
POST /api/admin/storage/buckets/delete-empty
```

请求必须包含与 bucket 名完全一致的确认文本，字段为 `confirmBucket`：

```json
{
  "bucket": "home-sync",
  "confirmBucket": "home-sync"
}
```

未确认或确认文本不匹配时返回：

```json
{
  "ok": false,
  "errorCode": "danger_confirmation_required"
}
```

删除最后一个 bucket 返回 `last_bucket_delete_blocked`；停用最后一个启用 bucket 返回 `last_active_bucket_disable_blocked`。服务端必须始终保留至少一个启用的同步仓库，保证默认 SyncKey 生成路径可用。服务端控制台也必须在 UI 层禁用这些明显会被拒绝的 bucket 操作，并用按钮 `title` 给出原因；服务端校验仍是最终防线。

bucket 不存在或已停用时，bucket 管理、SyncKey 生成和设备 bucket 绑定入口必须直接返回 `bucket_not_found` / `bucket_disabled`，不得依赖英文异常文本映射。清空或删除空 bucket 时也必须先完成启用状态校验；已停用 bucket 不得继续触碰 MinIO。控制台应禁用已停用 bucket 的清空和删除空仓库按钮，避免管理员误以为这些操作会清理远端对象。

删除某个 bucket 后，服务端必须把仍绑定该 bucket 的未删除设备迁移到替代 bucket，通常是当前默认或下一个启用 bucket；设备摘要和后续 SyncKey 生成不得引用已删除 bucket。

`storage/buckets/clear` 的 2xx 响应是 admin storage bucket clear response contract，顶层必须且只包含 `ok`、`bucket`、`result` 和 `state`；`ok` 必须为 `true`，`result` 必须包含非负整数 `deleted` 和 `rounds`，`bucket.clearedAt` 必须与 `state.storage.buckets[]` 中同名 bucket 一致。

`storage/buckets/clear` 只有在远端 MinIO/S3 清空流程成功完成，且服务端成功持久化 `sfsc-state.json` 后才算从管理状态发布。若对象删除成功后状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `bucket.clearedAt`、`bucket.objectCount`、`bucket.sizeBytes` 和 `storage.buckets[]` 的内存修改；控制台不得展示未持久化的“假清空 bucket”状态。

`storage/buckets/delete-empty` 的 2xx 响应是 admin storage bucket delete-empty response contract，顶层必须且只包含 `ok`、`storage`、`result` 和 `state`；`ok` 必须为 `true`，`storage` 必须与 `state.storage` 完全一致，`result.deletedBucket` 必须是被删除的 bucket 名，且删除后 `state.storage.buckets[]` 不得再包含该 bucket。

`storage/buckets/delete-empty` 只有在远端 MinIO/S3 确认 bucket 为空并完成删除，且服务端成功持久化 `sfsc-state.json` 后才算从管理状态发布。若远端删除成功后状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `storage.buckets[]`、默认 `storage.bucket` 和相关设备 bucket 迁移的内存修改；控制台不得展示未持久化的“假删除 bucket”状态，管理员修复状态文件写入问题后可以重新协调该 bucket 的状态。

### 设备管理

```http
POST /api/admin/users/create
POST /api/admin/users/enable
POST /api/admin/users/disable
POST /api/admin/users/delete
```

`POST /api/admin/users/create` 用于创建或登记管理用户并立即写入 sing-box 配置。服务端控制台「设备 → 新建设备」是它的产品化入口：设备是同步空间的成员单位，必须能先于 SyncKey 独立存在，否则「创建同步空间」要求选择 owner 设备时无设备可选，而唯一的建设备路径又是签发 SyncKey，形成死锁。`POST /api/claims/create` 在设备名首次出现时仍会隐式创建设备，但那是签发 SyncKey 的副作用，不是建设备的正式入口；控制台不得依赖它作为唯一建设备手段，因为自由文本设备名的拼写错误会静默伪造设备。为避免出现“已登记但没有可导入 SyncKey”的半成品设备，控制台创建设备成功后必须把设备名带入 SyncKey 签发流程并提示下一步；同名设备时 `createManagedUser` 是按 `clientName` 幂等返回既有设备，控制台必须前置拦截并提示，不得谎报新建。

- `enable` / `disable` 请求使用 `{ "userId": "..." }`。
- `delete` 为软删除，必须提交与设备名完全一致的确认文本，例如 `{ "userId": "...", "confirmText": "company-pc1" }`；未确认返回 `danger_confirmation_required`。
- 启用、停用或删除不存在、已删除或不属于当前状态的设备时返回 `404 user_not_found`，不得依赖 `"User not found"` 文本映射。
- 启用、停用、删除设备都会写入 sing-box 配置并设置 `tunnel.restartRequired: true`。
- 管理摘要的 `devices` 不包含已删除设备；`tunnel.sampleUri` 只来自启用且未删除的设备。
- 当启用已有且已运行过的设备，且该设备 `compatibility.policy.profileIssue === "warn"` 或 `compatibility.policy.syncRun === "warn"` 时，服务端必须要求 `confirmCompatibilityWarning: true`，否则返回 `400 danger_confirmation_required`。控制台启用前必须展示兼容性风险确认弹窗。
- 服务端控制台设备列表应展示设备影响摘要：停用设备提示旧客户端心跳和新 SyncKey 生成会被拒绝；最近同步失败时提示稳定错误码对应的人类可读原因；离线设备提示检查客户端运行状态、网络或重新导入 SyncKey。控制台还应直接展示当前或最近同步文件，方便管理员判断进度卡点；并允许管理员按在线/停用状态、最近同步结果、兼容状态和关键词筛选设备；关键词至少覆盖设备名、bucket/prefix、当前或最近文件、冲突样例和错误字段。
- 停用设备不能生成新 SyncKey，旧客户端心跳返回 `device_disabled`。

`POST /api/admin/users/create`、`POST /api/admin/users/enable` 和 `POST /api/admin/users/disable` 的 2xx 响应是 admin user write response contract：顶层必须且只包含 `user`、`config` 和 `state`。`user` 必须遵守 admin user summary contract，并与 `state.users[]` 中同一 `id` 的用户完全一致；`config` 必须是动作完成后的服务端 sing-box 配置对象，并与启用且未删除的 `state.users[]` 对齐；`state` 必须遵守 admin state summary contract，且 `state.tunnel.restartRequired` 必须为 `true`，`state.tunnel.lastConfigWrittenAt` 必须是本次写入时间的非空 ISO 字符串。

`POST /api/admin/users/delete` 的 2xx 响应是 admin user delete response contract：顶层必须且只包含 `ok`、`deletedUserId`、`config` 和 `state`。`ok` 必须为 `true`；`deletedUserId` 必须等于被软删除的用户 `id`；`config` 必须是动作完成后的服务端 sing-box 配置对象，且不得再包含被删除用户；`state` 必须遵守 admin state summary contract，且 `state.tunnel.restartRequired` 必须为 `true`，`state.tunnel.lastConfigWrittenAt` 必须是本次写入时间的非空 ISO 字符串，并且 `state.devices[]` 不得再包含被删除设备。

`POST /api/admin/users/create` 只有在服务端成功持久化设备状态并写入对应 sing-box 配置后才算发布。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次新增的 user/device、`tunnel.userCount`、`tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt`，并恢复请求前的 sing-box config 文件；控制台不得展示未持久化的“幽灵运维用户”。

`POST /api/admin/users/enable` 只有在服务端成功持久化设备状态并写入对应 sing-box 配置后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `user.enabled`、设备摘要、`tunnel.userCount`、`tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt` 的内存修改，并恢复请求前的 sing-box config 文件；控制台不得展示未持久化的“假启用”设备状态。

`POST /api/admin/users/disable` 只有在服务端成功持久化设备状态并写入对应 sing-box 配置后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `user.enabled`、设备摘要、`tunnel.userCount`、`tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt` 的内存修改，并恢复请求前的 sing-box config 文件；控制台不得展示未持久化的“假停用”设备状态。

`POST /api/admin/users/delete` 只有在服务端成功持久化设备状态并写入对应 sing-box 配置后才算生效。若状态持久化失败，接口必须返回 `500 server_state_write_failed`，回滚本次对 `user.enabled`、`user.deletedAt`、设备摘要、`tunnel.userCount`、`tunnel.restartRequired` 和 `tunnel.lastConfigWrittenAt` 的内存修改，并恢复请求前的 sing-box config 文件；控制台不得展示未持久化的“假删除”设备状态。

### 创建 SyncKey

```http
POST /api/claims/create
Content-Type: application/json
```

请求：

```json
{
  "clientName": "company-pc1",
  "bucketName": "home-sync",
  "server": "http://127.0.0.1:5177",
  "expiresInHours": 24,
  "confirmCompatibilityWarning": false,
  "defaults": {
    "transfers": 4,
    "streams": 8,
    "checkers": 8,
    "chunkSize": "16M",
    "bandwidthLimit": "off"
  }
}
```

`expiresAt` 和 `expiresInHours` 控制 SyncKey claim 自身的兑换有效期，不控制兑换后 profile 的运行有效期。若请求显式传入 `expiresAt: null`，claim 不设置兑换过期时间；若显式传入非空 `expiresAt`，它必须是未来 ISO 时间，服务端必须按该时间规范化后保存，并忽略同时传入的 `expiresInHours`；若未传入 `expiresAt`，服务端使用 `expiresInHours` 计算过期时间，未传时默认 `24` 小时。显式传入非法、过去时间的 `expiresAt`，或非法、非正数的 `expiresInHours`，必须返回 `400 validation_failed`，且不得创建 user、claim 或持久化任何部分状态。

响应顶层必须且只包含 `code`、`tKey`、`tKeyUri`、`claimCode`、`uri`、`claim`、`profile`、`compatibility` 和 `state`。`code` 是 `AAAA-AAAA` 人工加入短码，客户端使用时必须同时填写对应服务端 HTTP(S) origin；`tKey` / `claimCode` 是自带服务端地址的 `SFSC1-...` 完整 SyncKey；`tKeyUri` / `uri` 是自带服务端地址的 `sfsc://import/v1#...` 完整导入 URI。兼容字段 `claimCode` 和 `uri` 当前仍保留，但新客户端应优先使用 `tKey` 和 `tKeyUri`。`claim`: 本次 SyncKey 的生命周期摘要，字段与管理摘要 `claims[]` 单项一致；`profile` 是本次 SyncKey 将兑换出的原始服务端签发 profile。

`profile` 是客户端导入凭据，允许保留真实 `profile.storage.secretAccessKey` 和 `profile.heartbeat.secret` 供生成完整 SyncKey；`claim` 必须是展示安全摘要，不得包含完整 `profile`、完整 `tKey`、`tKeyUri`、legacy `claimCode` / `token`、`uri`、VLESS URI、心跳密钥或存储密钥。完整导入凭据只允许出现在响应顶层 `profile` 和复制动作所需的顶层 `tKey` / `tKeyUri` 兼容字段中，不得嵌入 `claim`。

该 2xx 响应是 claim create response contract：顶层必须包含本次短码、完整 SyncKey、导入 URI、展示安全 claim 摘要、完整待兑换 profile、兼容性摘要和 `state`。`state` 必须遵守 admin state summary contract，且 `state.tunnel.lastConfigWrittenAt` 必须是本次服务端写入 sing-box 配置后的非空 ISO 字符串。`state.tunnel.restartRequired` 仍由配置是否需要重新加载显式表达：新建设备或改变 sing-box 用户列表时通常为 `true`；仅给已有设备重新签发 SyncKey 且未改变 sing-box 用户列表时可以保持既有值。

当 `clientName` 或 `userId` 指向已有设备，且请求显式传入 `bucketName` / `bucket` 时，服务端必须先校验目标 bucket 已启用，然后同步更新该设备的 bucket 绑定；本次 claim、返回 profile 和管理摘要中的设备 bucket 必须保持一致。未显式指定 bucket 时沿用设备当前绑定 bucket。

当目标是已有设备，且该设备已有运行时信号（最近心跳、客户端版本或 diagnostics），并且 `device.compatibility.policy.profileIssue === "warn"` 时，服务端不得直接下发新 SyncKey。请求必须显式提交 `confirmCompatibilityWarning: true`，否则返回 `400 danger_confirmation_required`。控制台生成 SyncKey 前必须展示兼容性风险确认弹窗；新建设备或尚未运行过的设备不因缺少 diagnostics 被拦截。

如果设备 `enabled: false`，服务端不得为其生成新 SyncKey，旧客户端心跳返回 `409 device_disabled`。服务端控制台在按设备名生成 SyncKey 前也必须检查当前设备列表；命中已停用设备时应直接提示先重新启用，不调用 `/api/claims/create`。如果设备已删除，按 `clientName` 重新生成 SyncKey 会创建新设备；按旧 `userId` 生成 SyncKey 返回 `404 user_not_found`。旧客户端心跳返回 `device_not_found` 或匹配新的同名设备，取决于是否已重新创建。

服务端控制台展示约束：

- 首屏优先展示 `code` 短码、设备名、bucket、有效期。
- 完整 `tKey` 和 `tKeyUri` 必须分开复制。
- 完整长串可放入折叠区，避免管理员误把短码和完整 SyncKey 混用。
- 控制台调试 JSON 不得直接展示完整 SyncKey、SyncKey URI、legacy `claimCode` / `token`、VLESS URI 或存储密钥；复制入口可以保留真实值，但调试展示必须脱敏。
- “测试兑换”会消耗一次性 SyncKey，必须二次确认。
- `defaults` API 支持完整字段；当前服务端控制台只暴露常用 SyncKey 默认项：`transfers`、`streams`、`checkers`、`chunkSize` 和 `schedule`，其余默认值来自服务端状态或环境变量。

服务端控制台 SyncKey 生成失败 UI 建议合同：

- `server_state_write_failed`、`network_error`、`request_timeout`、`storage_request_failed` 和 `server_error` 是 SyncKey 生成可重试错误，`retryable: true`；控制台必须提示“SyncKey 未生成”和“可重试”，并指向检查 `sfsc-state.json` 数据目录权限和磁盘空间、sync-server 容器/反代/端口、N1 负载、sync-server 日志、MinIO/S3 endpoint、密钥和 bucket 权限，修复后重新生成 SyncKey。
- `danger_confirmation_required`、`device_disabled`、`bucket_disabled`、`bucket_not_found`、`user_not_found` 和 `validation_failed` 是 SyncKey 生成前置条件或输入错误，`retryable: false`；控制台必须提示“SyncKey 未生成”，并引导管理员先确认兼容性风险、重新启用设备并应用 sing-box 配置、启用或重新选择同步仓库、刷新设备/仓库列表，或检查设备名、SyncKey 服务地址、有效期、同步参数和仓库选择后再重新生成。

SyncKey 创建只有在服务端成功持久化 claim 和设备状态后才算发布。若请求显式传入 `server`，本次服务端地址设置也属于同一次创建事务。若创建过程中服务端无法写入 `sfsc-state.json`，接口必须返回 `server_state_write_failed`，并回滚本次请求对内存状态的修改；这包括回滚请求体 `server` 对 `settings.publicServerUrl` 的临时更新。控制台不得显示或复制一个尚未持久化的“幽灵 SyncKey”，也不得在失败后展示被未持久化请求污染的 SyncKey 服务地址。

### 兑换 SyncKey

```http
POST /api/claims/redeem
Content-Type: application/json
```

请求支持以下任一字段：

- `code`
- `tKey`
- `tkey`
- `claimCode`
- `token`

新客户端还应提交绑定字段：

```json
{
  "code": "C7KD-92PQ",
  "clientRedeemId": "8a7d25f7-19e0-4a8c-9d9f-efc0c2c61010",
  "clientInstallId": "b9e558e2-4b86-47f9-8e20-d08f0d9dc6b3"
}
```

`clientRedeemId` 标识一次导入尝试，`clientInstallId` 标识本机安装。两者同时存在才构成同一客户端绑定；任一字段缺失都按旧客户端一次性兑换处理。服务端不得把原始 `clientInstallId` 写入管理摘要或日志，持久化绑定时只保存 `claim.redeemedBy.clientInstallIdHash`。

成功响应为 profile 本体。该成功响应是 claim redeem response contract：响应必须遵守服务端签发完整 profile 契约，顶层必须且只包含 `version`、`profileId`、`clientName`、`issuedAt`、`expiresAt`、`tunnel`、`heartbeat`、`storage` 和 `defaults`，不得包含 `source`、`importMode` 或 `importedAt`。其中 `heartbeat` 必须且只包含 `scheme` 和 `secret`，`storage` 必须且只包含 `type`、`remoteName`、`endpoint`、`bucket`、`accessKeyId`、`secretAccessKey` 和 `prefix`，`defaults` 必须且只包含客户端导入 job 所需的默认同步参数。客户端导入成功后才补齐 `source.type: "claim"`、`source.server`、`importMode` 和 `importedAt`。

服务端在首次兑换和短时绑定重放返回 profile 前，必须重新校验 claim 指向的设备和同步仓库仍可用：`claim.userId` 必须对应未删除且启用的设备，`claim.bucketName` 或 profile storage bucket 必须仍存在且未停用。服务端还必须校验 claim 创建时签发的 profile 下发材料仍与当前可签发材料一致，覆盖 `clientName`、tunnel URI、heartbeat secret、storage remote/endpoint/bucket/accessKey/secret/prefix 和 profile defaults；若 claim 创建请求显式携带 `defaults`，该 SyncKey 绑定创建时的自定义 defaults，不因后续全局 defaults 变化失效。若 profile 带 `expiresAt`，服务端还必须在首次兑换和短时绑定重放前确认它仍未过期；已过期时返回 `400 validation_failed`，消息为 `SyncKey claim profile is expired; regenerate SyncKey`，不得返回已过期的旧 profile。若设备已停用、已删除、bucket 已停用或已删除，或下发材料已漂移，`/api/claims/redeem` 必须返回 `400 validation_failed`，漂移消息为 `SyncKey claim profile is stale; regenerate SyncKey`，且不得设置 `claim.used`、`redeemedAt`、`redeemedBy` 或 `replayUntil`。客户端把该错误视为终态错误，提示重新生成 SyncKey。

短时绑定重放语义：

- 首次成功兑换且请求包含 `clientRedeemId` 和 `clientInstallId` 时，服务端必须在同一次状态持久化中记录 `claim.redeemedBy.clientRedeemId`、`claim.redeemedBy.clientInstallIdHash`、`claim.redeemedBy.firstRedeemedAt` 和 `claim.replayUntil`。
- 在 `claim.replayUntil` 之前，同一客户端绑定再次兑换同一个 SyncKey 时，服务端返回同一份 profile，用于客户端从 pending recovery stash 恢复导入未完成的状态。
- 不同客户端再次兑换时必须返回 `409 claim_already_used`。不同客户端包括 `clientRedeemId` 不同、`clientInstallId` 不同、绑定缺失，或已经超过 `claim.replayUntil` 的请求。
- 首次兑换未提交完整绑定的旧客户端不启用短时绑定重放；任何后续重复兑换都返回 `409 claim_already_used`。

客户端兑换失败时，必须优先保留服务端结构化 `errorCode`、HTTP status 和 `message`，但只透传合同登记的 redeem 错误码，例如 `claim_not_found`、`claim_already_used`、`claim_expired`、`claim_redeem_rate_limited`、`server_state_write_failed` 和 `validation_failed`；远端仅返回未登记的 `error` / `errorCode`、非 snake_case 错误码、文本/HTML 失败体或无结构化错误时，客户端本地 `/api/profile/import` 必须降级为 `claim_redeem_failed`，同时保留已收到的远端 HTTP status。远端 HTTP 2xx 但响应不是 JSON、不是对象、返回 `ok:false`，或返回 `{ "ok": true }`、`{ "message": "ok" }`、`{ "profile": null }` 这类没有可校验 profile 的成功 envelope 时，也必须降级为 `502 claim_redeem_failed` 并保留 pending recovery stash，不得误判为 `profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`；服务端正式成功响应仍以裸 profile 为准，兼容 `{ "profile": ... }` wrapper 时也必须包含非空 profile 对象。客户端本地运行时请求远端 `/api/claims/redeem` 必须设置超时，默认 15 秒，可通过 `SFSC_CLAIM_REDEEM_TIMEOUT_MS` 调整。客户端 UI 调用本地 `/api/profile/import` 的请求超时必须长于本地运行时 redeem 超时默认值，避免页面先报 `request_timeout` 而掩盖本地运行时返回的 `claim_redeem_failed` 或远端结构化错误。若 DNS、连接拒绝、超时等网络异常导致请求没有得到 HTTP 响应，客户端本地 `/api/profile/import` 使用 `502 claim_redeem_failed`，不得只抛普通文本错误。

如果兑换过程中服务端无法持久化状态，应返回 `server_state_write_failed`，并回滚本次请求对内存状态的修改；该 SyncKey 不得被视为已消耗，管理员修复状态文件写入问题后客户端可以重试兑换。

错误语义：

- `404 claim_not_found`
- `409 claim_already_used`
- `410 claim_expired`
- `429 claim_redeem_rate_limited`
- `400 validation_failed`
- `500 server_state_write_failed`

这些错误同样使用通用错误响应格式，并保留 `error` 字段以兼容当前客户端导入逻辑。

服务端控制台 SyncKey 测试兑换失败 UI 建议合同：

- `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 和 `import_code_invalid` 是测试兑换终态或输入错误，`retryable: false`；控制台必须提示“SyncKey 测试兑换失败”和“不可重试当前 SyncKey”或“不可重试当前内容”，并引导管理员重新复制完整 SyncKey、检查是否误粘贴短码或截断内容，或在服务端重新生成 SyncKey。
- `claim_redeem_rate_limited` 是短期限速错误，`retryable: true`；控制台必须提示等待限速窗口、检查是否误粘贴或自动化重复提交，并在无法确认时重新生成 SyncKey。
- `server_state_write_failed` 是测试兑换可重试错误，`retryable: true`；控制台必须提示兑换状态未成功持久化、SyncKey 不应视为已消耗，并指向检查 `sfsc-state.json` 数据目录权限和磁盘空间，修复后用同一个 SyncKey 再试。
- `network_error`、`request_timeout`、`server_error` 和 `claim_redeem_failed` 是测试兑换结果未知错误，`retryable: false`；控制台必须提示先刷新管理状态查看 claim 是否已 `used` / `redeemedAt`，不要把这个 SyncKey 交给客户端，无法确认时重新生成 SyncKey。

### 设备心跳

```http
POST /api/devices/heartbeat
Content-Type: application/json
```

请求：

```json
{
  "clientName": "company-pc1",
  "profileId": "profile-company-pc1-abc123",
  "clientVersion": "0.2.0-beta.2",
  "diagnostics": {
    "app": "singbox-folder-sync",
    "role": "client",
    "version": "0.2.0-beta.2",
    "buildId": "",
    "buildTime": null,
    "protocols": {
      "claim": 1,
      "profile": 2,
      "adminState": 1,
      "clientStatus": 1,
      "heartbeat": 1
    }
  },
  "storage": {
    "bucket": "home-sync",
    "prefix": "devices/company-pc1"
  },
  "sync": {
    "syncState": "syncing",
    "bytesPerSecond": 6250000,
    "speedMbps": 50,
    "progressPercent": 42.5,
    "currentFile": "projects/current.iso",
    "currentJob": {
      "name": "company-pc1-sync",
      "direction": "upload",
      "bucketName": "home-sync",
      "remotePrefix": "devices/company-pc1"
    },
    "lastRun": {
      "id": "sync-1783123456789",
      "status": "success",
      "startedAt": "2026-07-03T10:00:00.000Z",
      "finishedAt": "2026-07-03T10:05:00.000Z",
      "progressPercent": 100,
      "transferredSizeText": "1 GiB / 1 GiB",
      "currentFile": "projects/video.iso",
      "rawSpeed": "8 MiB/s",
      "speedMbps": 67.11,
      "exitCode": 0,
      "errorCode": "",
      "error": ""
    }
  },
  "auth": {
    "scheme": "sfsc-hmac-sha256-v1",
    "timestamp": "2026-07-03T10:00:05.000Z",
    "nonce": "base64url-random",
    "signature": "hex-hmac-sha256"
  }
}
```

`profileId` 是客户端 profile 轮换诊断字段，必须参与 heartbeat HMAC 签名 payload；当前服务端仍以 `clientName` 定位设备并用该设备的 heartbeat secret 验签，后续可以在不改变请求形态的前提下加强 profile 轮换校验。为兼容旧客户端，服务端请求 schema 仍白名单保留 legacy 顶层同步字段，例如 `syncState`、`speedMbps`、`currentFile`、`lastRun`、`currentJob`、`scheduler` 等；新客户端应优先把当前同步摘要放入 `sync` 对象，并保持服务端响应中的 `device.syncState === device.sync.state`、`device.speedMbps === device.sync.speedMbps`。

新 profile 的心跳请求必须带 `auth`。客户端用 `createHeartbeatAuth(payloadWithoutAuth, profile.heartbeat.secret)` 生成 `auth.scheme`、`auth.timestamp`、`auth.nonce` 和 `auth.signature`；服务端按同一规范验签。签名输入为去掉 `auth` 字段后的稳定 JSON 请求体，HMAC secret 为 `profile.heartbeat.secret`。服务端必须忽略传输层派生的 `remoteAddress` 后再验签，避免代理地址变化破坏签名。兼容窗口内，服务端可以继续接受历史用户中没有 `heartbeatSecret` 的未签名心跳；一旦用户拥有 `heartbeatSecret`，未签名心跳必须返回 `401 heartbeat_auth_required`，签名错误、时间戳超出允许偏移、nonce 或 signature 非法必须返回 `401 heartbeat_auth_invalid`。服务端必须在允许时间偏移窗口内记录已接受的 `auth.nonce` 并拒绝重复 nonce，防止同一个已签名 heartbeat 被重放；nonce 窗口属于服务端内部状态，不得出现在 `/api/admin/state`、设备摘要或客户端诊断包中。

成功响应：

```json
{
  "ok": true,
  "diagnostics": {
    "app": "singbox-folder-sync",
    "role": "server",
    "version": "0.2.0-beta.2",
    "protocols": {
      "claim": 1,
      "profile": 2,
      "adminState": 1,
      "clientStatus": 1,
      "heartbeat": 1
    }
  },
  "device": {
    "id": "user-company-pc1",
    "clientName": "company-pc1",
    "enabled": true,
    "online": true,
    "status": "online",
    "lastSeenAt": "2026-07-03T10:00:05.000Z",
    "bucket": "home-sync",
    "prefix": "devices/company-pc1",
    "clientVersion": "0.2.0-beta.2",
    "diagnostics": {
      "role": "client",
      "version": "0.2.0-beta.2",
      "protocols": {
        "claim": 1,
        "profile": 2,
        "adminState": 1,
        "clientStatus": 1,
        "heartbeat": 1
      }
    },
    "compatibility": {
      "ok": true,
      "status": "compatible",
      "action": "none",
      "policy": {
        "heartbeat": "allow",
        "profileIssue": "allow",
        "syncRun": "allow",
        "adminActions": "allow",
        "reason": "none"
      },
      "issues": []
    },
    "sync": {
      "state": "syncing",
      "speedMbps": 50,
      "currentFile": "projects/current.iso",
      "progressPercent": 42,
      "lastRun": {
        "id": "run-20260703-103000",
        "status": "success",
        "progressPercent": 100,
        "conflicts": {
          "count": 0,
          "files": [],
          "truncated": false
        }
      },
      "conflicts": {
        "count": 0,
        "files": [],
        "truncated": false
      },
      "scheduler": {
        "enabled": true,
        "intervalMs": 3600000,
        "nextRun": "2026-07-03T10:30:00.000Z",
        "lastTriggeredAt": "2026-07-03T09:30:00.000Z",
        "lastError": "",
        "jobs": []
      }
    },
    "syncState": "syncing",
    "speedMbps": 50,
    "lastRemoteAddress": "192.168.1.23"
  }
}
```

该成功响应是 server heartbeat response contract：响应顶层必须且只包含 `ok`、`diagnostics` 和 `device`，其中 `ok` 必须为 `true`，`diagnostics.role` 必须为 `server`，`device` 必须遵守 client heartbeat device summary contract。客户端本地运行时依赖成功响应中的顶层 `diagnostics` 和 `device.compatibility`：心跳成功后必须把服务端协议诊断保存为 `heartbeat.serverDiagnostics`，把设备兼容状态保存为 `heartbeat.compatibility`。同时必须保存一份脱敏的 `heartbeat.device` 快照，至少包含 `id`、`clientName`、`enabled`、`online`、`status`、`lastSeenAt`、`bucket`、`prefix`、`clientVersion`、`lastRemoteAddress`、`syncState`、`speedMbps` 和安全的 `sync` 摘要；其中 `sync` 摘要至少保留 `state`、`speedMbps`、`progressPercent`、`currentFile`、`currentJob`、`lastRun`、`conflicts` 和完整稳定的 `scheduler` 字段，供客户端设置页与诊断包显示服务端实际接收到的同步状态。服务端 heartbeat 成功响应不得返回 `vlessUri`；客户端也不得保存服务端返回的 `vlessUri`，包括服务端异常返回或旧版本返回中的该字段。服务端不得在成功响应中移除 `device.sync`、`device.sync.currentFile`、`device.syncState`、`device.speedMbps`、`device.bucket`、`device.prefix`、`device.clientVersion` 或 `device.lastRemoteAddress`，这些字段用于服务端控制台、客户端设置页和诊断包。

服务端以最近 2 分钟内收到心跳作为在线判断。

服务端只有在成功持久化心跳状态后，才应更新设备在线状态、`lastSeenAt` 和同步摘要。若心跳过程中服务端无法写入 `sfsc-state.json`，应返回 `server_state_write_failed`，并回滚本次请求对内存状态的修改；客户端后续可以继续重试心跳，服务端控制台不得显示一个尚未持久化的“假在线”状态。

`sync.lastRun` 是客户端最近一次同步运行记录摘要，客户端发送前和服务端接收后都必须按共享 `normalizeSyncRun` 合同归一化。服务端设备摘要会保留并展示该摘要；客户端保存 `heartbeat.device.sync.lastRun` 时也必须保留这些稳定字段：`id`、`status`、`trigger`、`startedAt`、`finishedAt`、`job`、`localPath`、`exitCode`、`errorCode`、`error`、`progressPercent`、`transferredSizeText`、`currentFile`、`rawSpeed`、`speedMbps` 和 `conflicts`。`status` 取值为 `running`、`success`、`error`、`stopped` 或 `unknown`；`trigger` 取值为 `manual` 或 `scheduler`，缺失或非法时必须归一化为 `manual`，不得从 `schedule.mode` 反推来源。当 rclone 同步进程异常退出时，客户端必须记录 `status: "error"`、`errorCode: "rclone_sync_failed"` 和退出码；用户主动停止则记录 `status: "stopped"`，不写入 `rclone_sync_failed`。

`sync.conflicts` 和 `sync.lastRun.conflicts` 是双向同步冲突摘要，结构为 `{ "count": 0, "files": [], "truncated": false }`。客户端只能在 `direction: "bidirectional"` 时从已验证的 rclone bisync 冲突事件中提取线索，包括双方均修改事件和默认 `.conflict1` / `.conflict2` 冲突重命名；普通文件名中的 `conflict`、Syncthing `.sync-conflict-*` 副本和 HTTP `409 Conflict` 不得计入。最多上报 10 个文件名示例；服务端必须保留并归一化该摘要，控制台设备列表、客户端最近同步摘要和客户端同步历史必须用中文展示冲突数量、示例文件和处理建议，而不是要求用户只查原始日志。即使双向同步进程状态为 `success`，只要冲突数量大于 0，UI 也应把该运行呈现为需要处理的 warning 状态；上传、下载等单向任务必须忽略旧历史中不可能成立的 legacy 冲突计数。当前产品 UI 只提示用户暂停继续双向同步、手动比对示例文件并确认保留版本后再重新运行；不得自动删除、覆盖或选择冲突版本。

`sync.scheduler` 是客户端本地计划任务摘要，结构包含 `enabled`、`intervalMs`、`nextRun`、`lastTriggeredAt`、`lastError` 和 `jobs[]`。`jobs[]` 中每项必须保留对象 `schedule`、`scheduleText`、`nextRun`、`lastTriggeredAt` 和 `lastError`，使服务端控制台、客户端设置页和诊断包能区分 interval、daily、startup 与 manual 计划。`scheduler.lastError` 以及 `jobs[].lastError` 必须只保存稳定 snake_case 错误码，不能上传英文异常文本；无法识别的错误文本应清空。客户端心跳必须随同步状态上报该摘要；服务端设备摘要必须保留它，客户端保存 `heartbeat.device.sync.scheduler` 时也必须保留 `intervalMs`、`lastTriggeredAt` 和 `jobs[]`，不得只保留 `enabled`、`nextRun` 和 `lastError`。控制台设备列表展示下一次计划或调度错误，方便管理员判断设备是否只是空闲等待计划。

`sync.syncState` / 本地 `processes.sync.metrics.syncState` 取值为 `syncing`、`idle`、`error`、`stopping` 或 `offline`。用户触发停止后，只要 rclone 进程尚未完全退出，对外状态必须保持 `stopping`；退出完成后历史记录写入 `status: "stopped"`。服务端控制台设备列表的“同步中 / 空闲 / 出错”筛选必须使用当前 `device.sync.state` / `device.syncState`，不得用 `sync.lastRun.status` 替代当前同步状态；“出错”筛选可以额外包含最近运行 `status: "error"` 的设备。

服务端接收心跳时必须尽量保留可用状态。`sync.currentJob` 或 `sync.lastRun.job` 中非法的远端路径字段不得导致心跳接口整体失败；服务端应清空非法路径字段，并继续规范化 `syncState`、进度、速度、最近运行摘要等字段。

客户端本地状态中的 `heartbeat` 字段必须反映最近一次上报结果；未配置 profile 或尚未上报时为 `null`。一旦存在，`heartbeat.ok` 必须是布尔值，`heartbeat.server` 和 `heartbeat.sentAt` 必须是非空字符串，`heartbeat.status` 在有 HTTP 响应时必须是整数。成功心跳必须包含 `heartbeat.serverDiagnostics`、`heartbeat.compatibility` 和脱敏 `heartbeat.device`，其中 `heartbeat.serverDiagnostics.role` 必须为 `server`，`heartbeat.serverDiagnostics.protocols.claim/profile/adminState/clientStatus/heartbeat` 必须都是正整数。

`heartbeat.compatibility` 必须遵守 compatibility contract：顶层必须且只包含 `action`、`issues`、`localRole`、`ok`、`policy`、`remoteRole`、`severity` 和 `status`。`status` 只能是 `compatible` 或 `mismatch`；`action` 只能是 `none`、`diagnostics_missing`、`upgrade_remote`、`upgrade_local` 或 `manual_check`；`severity` 只能是 `ok` 或 `warning`；`localRole` 和 `remoteRole` 必须是字符串。`policy` 必须且只包含 `adminActions`、`heartbeat`、`profileIssue`、`reason` 和 `syncRun`；`heartbeat`、`profileIssue`、`syncRun` 和 `adminActions` 只能是 `allow` 或 `warn`，且 `policy.reason` 必须等于 `action`。`issues[]` 每项必须且只包含 `field`、`local`、`message`、`remote` 和 `type`；`field` 只能是 `adminState`、`claim`、`clientStatus`、`heartbeat` 或 `profile`；`type` 只能是 `local_missing`、`remote_missing`、`remote_newer` 或 `remote_older`；`local` / `remote` 必须是正整数或 `null`；`message` 必须是非空字符串。`ok` 必须等于 `issues.length === 0`，`status` 必须随 `ok` 分别为 `compatible` / `mismatch`，`severity` 必须随 `ok` 分别为 `ok` / `warning`。

`heartbeat.device` 必须遵守 client heartbeat device summary contract，不得包含服务端返回的 `vlessUri`，也不得包含 `secretAccessKey`、`privateKey`、`tKey` 或 `claimCode`。HTTP 2xx 只有在响应是 JSON object 且满足该成功契约时才算成功；若 2xx 响应不是 JSON、为空 body、缺少 `ok: true`、顶层 `diagnostics`、`device.compatibility`、`device.sync`，或缺少/错填 `diagnostics.role`、`diagnostics.protocols.*`、`device.compatibility.ok/status/action/severity/localRole/remoteRole`、`device.compatibility.policy.*`、`device.compatibility.policy.reason`、`device.compatibility.issues[]`、`device.sync.state`、`device.sync.speedMbps` 等成功契约字段，客户端必须把本次结果记录为 `heartbeat_failed`，不得写入或覆盖 `lastSuccessfulHeartbeat`。客户端保存的 `heartbeat.device.syncState` 必须与 `heartbeat.device.sync.state` 完全一致，`heartbeat.device.speedMbps` 必须与 `heartbeat.device.sync.speedMbps` 保持一致；若 HTTP 2xx 响应中的这两组字段不一致，也必须按 malformed success 处理为 `heartbeat_failed`。网络异常或服务端返回非 2xx 时，`heartbeat.ok` 为 `false`，失败心跳必须包含 `heartbeat.errorCode: "heartbeat_failed"`；若服务端返回了共享稳定错误码表登记的错误码，可放入 `heartbeat.remoteErrorCode` 供诊断使用；若远端响应是英文文本、HTML 网关错误、非 snake_case、snake_case 但未登记，或其他非稳定结构，客户端不得保存 `remoteErrorCode`，只能保留到 `heartbeat.error` / `heartbeat.message`。客户端还必须维护 `lastSuccessfulHeartbeat`，未发生成功心跳时为 `null`；一旦发生成功心跳，该字段必须保存最近一次成功心跳摘要，并且后续失败心跳不得清空或覆盖它。`lastSuccessfulHeartbeat` 必须持久化到本地 `data/last-successful-heartbeat.json`，客户端重启后应恢复该成功快照，使服务端临时不可达时仍能执行最近一次成功心跳返回的兼容性策略。导入新 profile 成功后必须清空 `heartbeat`、内存中的 `lastSuccessfulHeartbeat` 和持久化快照，并忽略旧 profile 仍在途的 heartbeat 响应，避免设置抽屉、诊断包或本地写接口继续使用旧服务端/旧设备的兼容性快照。客户端 UI 和本地 `/api/jobs/save`、`/api/sync/run` 兼容性确认必须以 `lastSuccessfulHeartbeat.compatibility.policy.syncRun` 为准，避免一次网络失败或客户端重启放松之前成功心跳返回的 `warn` 策略。

客户端心跳上报必须设置请求超时，默认 10 秒，可通过 `SFSC_HEARTBEAT_TIMEOUT_MS` 调整。客户端 UI 必须在主状态区展示心跳概况，并在设置/诊断区域展示最近一次心跳时间或失败原因。

心跳错误语义：

- `404 device_not_found`：`clientName` 未在服务端登记，通常表示客户端导入了错误服务端的 SyncKey、服务端状态被重置，或设备已被删除。
- `401 heartbeat_auth_required`：设备拥有 heartbeat secret，但请求没有携带 `auth`。
- `401 heartbeat_auth_invalid`：`auth` 的 scheme、timestamp、nonce、signature、请求体签名校验失败，或同一 nonce 在有效窗口内被重复使用。
- `429 heartbeat_rate_limited`：同一来源地址在窗口内心跳失败次数过多，服务端临时限速。限速窗口内该来源的心跳请求在业务处理前直接拒绝。计数在一次成功心跳后清零；`device_disabled` 不计入失败（停用设备按客户端默认间隔重试心跳属于登记行为，必须持续收到 `409 device_disabled` 以驱动客户端 UI 显示停用状态），服务端自身 5xx 也不计入。限速状态只保存在内存中，不写入 `sfsc-state.json`，服务端重启即清零；阈值和窗口可通过 `SFSC_HEARTBEAT_FAILURE_LIMIT`（默认 60 次）、`SFSC_HEARTBEAT_FAILURE_WINDOW_MS`（默认 5 分钟）和 `SFSC_HEARTBEAT_RATE_LIMIT_MS`（默认 5 分钟）调整，默认值对按 `SFSC_HEARTBEAT_MS` 默认 15 秒间隔上报的正常设备留有充足余量。

客户端本地心跳失败摘要应同时显示本地 `heartbeat_failed` 和服务端返回的 `remoteErrorCode` 对应中文原因，不能只把 `device_not_found` 这类内部码直接展示给用户。

客户端顶部配置状态不得只依据本地是否已导入配置判断。若最近一次心跳包含 `remoteErrorCode: "device_disabled"`，应显示设备已停用，并在主界面提示到服务端控制台重新启用；若包含 `remoteErrorCode: "device_not_found"`，应显示设备未登记，并提示重新生成并导入 SyncKey。

## 5. 客户端本地接口

客户端本地 HTTP 只监听 `127.0.0.1:5188`。桌面入口和便携 launcher 必须尽量复用已运行的本地运行时：重复打开客户端时应聚焦已有 Electron 窗口或打开已存在的本地 UI，而不是再启动一个占用同一端口的运行时。若 `5188` 被已运行 SFSC 客户端占用，`clientServer.js` 直接复用并退出；若被非 SFSC 进程占用，启动失败使用 `client_port_in_use`。判断“已运行 SFSC 客户端”时不得只看 `/api/health` 的 HTTP 200，必须解析 JSON 并校验 `ok: true`、`mode: "client-exe-runtime"` 和 `diagnostics.role: "client"`；HTTP 200 但不是 client health response contract 的本机服务必须视为非 SFSC 进程。

错误响应使用同一套通用错误响应格式。客户端 UI 应优先读取 `errorCode`，并继续兼容 `error`。

客户端本地所有 `GET` 读接口同样只面向本机 SFSC UI 与本地自动化。运行时必须在进入任何 handler 前拒绝浏览器跨站读取：`Sec-Fetch-Site: cross-site` 时返回 `403 local_read_forbidden`。这与写入口的跨站防护对称——否则恶意页面可用一次普通跨站 `GET` 读走同步配置、bucket 名称与 VLESS 服务器地址。该保护不替代 Host 白名单与 loopback 监听边界，三者都必须保留。读接口刻意不引入 bearer token：已能在本机执行代码的进程可直接读取 `secrets.json` 与 `profile.json`，token 无法防御该路径，只会让所有本地工具与测试被迫携带凭据。

客户端本地所有 `POST` 写入口只面向同一台机器上的 SFSC UI、启动器、调度器、smoke 和本地自动化。进入共享请求 schema 前，运行时必须拒绝浏览器跨站写入：`Sec-Fetch-Site: cross-site` 或 `Origin` 不是同一 loopback host/port 时返回 `403 local_write_forbidden`。带请求体的 `POST` 必须使用 `Content-Type: application/json`，否则返回 `415 unsupported_media_type`；空 body 的控制入口可继续兼容无 `Content-Type` 的本地 shutdown/stop 调用。该保护不替代 loopback 监听边界，二者都必须保留。

客户端本地写接口进入运行逻辑前也必须调用共享请求 schema：`/api/profile/import` 只接收导入码、claim/token 别名或 legacy VLESS `uri`；legacy VLESS 兼容输入还可携带 `clientName` 和 `options.localProxyPort`，其中 `options` 必须做字段级白名单，未知字段必须丢弃，`options.localProxyPort` 必须是 1..65535 的整数；`/api/jobs/save`、`/api/sync/preview`、`/api/sync/safety-plan`、`/api/sync/bisync/conflicts/preview`、`/api/sync/bisync/conflicts/save`、`/api/sync/bisync/conflicts/operations`、`/api/sync/bisync/conflicts/resume`、`/api/sync/bisync/initialize`、`/api/jobs/{jobId}/recovery/restore-preview`、`/api/jobs/{jobId}/recovery/restore`、`/api/jobs/{jobId}/recovery/restore-cancel`、`/api/sync/run` 只接收顶层 `job` 对象和允许的确认字段。字段类型错误返回 `400 validation_failed`，未填写导入内容返回 `400 import_code_required`，不得把未知字段继续传入深层同步执行逻辑。

启动阶段错误约定：

- 缺少内置 sing-box 或 rclone 时，启动隧道、同步预览或同步运行入口必须直接返回 `missing_singbox_binary` / `missing_rclone_binary`，不得依赖英文异常文本映射。
- sing-box 配置写入或进程启动失败返回 `singbox_start_failed`。
- rclone remote 配置写入失败返回 `rclone_config_failed`，此时同步任务尚未启动，不写入同步历史；若 sing-box 原本未运行，本次同步运行也不得为了失败的 rclone config 留下新启动的 sing-box 进程。

主要接口：

- `GET /api/health`
- `GET /api/client/status`
- `POST /api/client/shutdown`
- `GET /api/enrollment/session`
- `POST /api/enrollment/channel/import`
- `POST /api/enrollment/request`
- `POST /api/enrollment/consume`
- `POST /api/enrollment/connection/repair`
- `GET /api/enrollment/connection/repair/{operationId}`
- `POST /api/binaries/check`
- `POST /api/profile/import`
- `GET /api/profile`
- `GET /api/jobs`
- `POST /api/jobs/save`
- `POST /api/singbox/start`
- `POST /api/singbox/stop`
- `POST /api/sync/preview`
- `POST /api/sync/bisync/conflicts/preview`
- `POST /api/sync/bisync/conflicts/save`
- `POST /api/sync/bisync/conflicts/operations`
- `POST /api/sync/bisync/conflicts/resume`
- `POST /api/sync/safety-plan`
- `POST /api/sync/bisync/initialize`
- `POST /api/sync/run`
- `POST /api/sync/stop`
- `GET /api/sync/history`

#### 首次双向冲突保护与重启续做

四个本地路由均使用严格的共享请求 schema，并与同步、恢复及连接修复共用客户端数据操作 admission：

| 路由 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/sync/bisync/conflicts/preview` | `{job}` | `{preview:{previewId,operationId,relationId,baselineId,rootId,createdAt,conflicts}}` |
| `POST /api/sync/bisync/conflicts/save` | `{job,previewId}` | `{saved:{operationId,status,conflicts}}` |
| `POST /api/sync/bisync/conflicts/operations` | `{job}` | `{operations:[{operationId,status,createdAt,savedAt,conflicts}]}` |
| `POST /api/sync/bisync/conflicts/resume` | `{job,operationId}` | `{saved:{operationId,status,createdAt,savedAt,conflicts}}` |

`operations` 只列出当前未初始化可信 relation 的 journal；operation 和暂存区按 relation/baseline/root 派生路径。客户端重启后，`previewId` 的内存映射可能已失效，但 `operations` 仍从本地受保护 journal 读取精确 operation。状态为 `saving` 时调用 `resume` 续做；状态为 `saved` 时复用其 `operationId` 调用初始化。已初始化 relation 返回空列表。journal 只在旧全局 manifest 的 type、version、owner 和 relation/baseline/root 都精确匹配时迁移；未知或其他 relation 的旧文件不会被覆盖。

首次初始化只接受 `{job,safetyPlanId,confirmBidirectionalInitialization:true,conflictOperationId}`。初始化前需再次扫描并确认冲突集合及双方原始内容未变化；不同步冲突、journal 归属错误或未知目标都失败关闭。冲突与恢复模块收到的 `relation.rclone.workdir` 由客户端从受保护 runtime 根目录和稳定 baseline id 派生；HTTP 请求及持久化任务不能指定该路径。客户端 UI 应保留 operations 列表并允许用户显式续做，不得要求用户删除状态或重新初始化来恢复保存过程。

#### 恢复 API 路由与错误状态

恢复 API 的四条路由成功响应分别为：`GET /api/jobs/{jobId}/recovery` 返回 `{jobId,versions}`；`POST .../restore-preview` 返回 `{jobId,preview}`；`POST .../restore` 返回 `{jobId,restored,destinationPath,sourceSha256,runId}`；`POST .../restore-cancel` 返回 `{jobId,cancelled}`。恢复版本只适用于具有可信、稳定 relation 的任务；经精确旧 fingerprint、alias、workdir 和 initialized state 验证的非 SFTP `legacy_compatible` 任务保留原同步基准，但没有新恢复版本，调用恢复 API 返回 `409 sync_recovery_trusted_relation_required`。预览和还原只接受当前 job/relation 的预览，不返回同步根外绝对路径或受保护暂存路径；还原使用排他创建，校验 hash 不匹配时保留目标内容供检查。错误码和 HTTP 状态见本节“同步恢复稳定错误码”表。

#### 同步启动及运行语义

`POST /api/sync/run` 在第一次异步准备前取得 admission；准备中的同任务请求共享 promise，当前运行中的同任务请求重放当前状态，不同任务返回 `409 sync_already_running`。停止中的同 normalized job fingerprint 返回已记录的 stopping 状态，不同 fingerprint 冲突。运行准备先检查本地状态、密钥库和二进制，再生成带当前 job/profile/授权的 `runPlan`；危险任务还要校验有效安全计划。`runSyncExclusive` 写入 app-scoped rclone remote config 后才启动对应 sing-box/data tunnel，随后进行双向恢复预检并启动 rclone。config 写入失败时任务尚未启动：不新增 sync history、不启动 rclone；若 tunnel 原先未运行，不为该失败单独留下新进程。SFTP 的 `ALL_PROXY` 必须指向 data sing-box 的 SOCKS listen port。

调度器只运行已保存任务；危险任务每次触发重新计算计划和根目录安全状态。不同到期任务不会排入无限队列，运行期只允许一个同步准备/执行。首次初始化永不由调度器触发。数据 tunnel 自身退出时最多自动重试 3 次；自动计划遇到已识别的瞬时网络错误也最多重试 3 次。每次重试重新读取授权、构造同步计划并校验安全计划；权限、认证、目录 root、marker 或主机密钥错误不得自动重试。最终失败错误码写入 scheduler 状态。
- `GET /api/logs`
- `GET /api/diagnostics/export`

P3 首次接入使用独立本地流程，不更改旧 `SFSC1-` / `sfsc://import/v1#` profile 格式。`POST /api/enrollment/channel/import` 只接受 `{ code }`，其中包装码包含既有签名 channel config 和管理员复制来的 OOB pin；包装本身不构成签名或信任证明。客户端必须按 pin 验证 channel config 签名和 bootstrap origin/path。`GET /api/enrollment/session` 与 `GET /api/client/status.enrollment` 只返回接入阶段、短申请识别码及可供首次人工核对的服务器密钥指纹，不返回私钥、完整通道码、身份验证码或 underlying VLESS 配置；`POST /api/enrollment/request` 只接受 `{}`，`POST /api/enrollment/consume` 只接受 `{ code }`。

`POST /api/enrollment/connection/repair` 是客户端 loopback 管理写入口，只接受 `{operationId, relationId, jobId?}`；`operationId` 必须为 UUIDv4，`relationId` 必须是当前本地已验签授权中的关系，`jobId`（若提供）必须指向同一关系的本地 SFTP 任务。响应立即返回 `{operation}` 持久化操作摘要，后台检查并尝试恢复本机连接，不改目录绑定、关系身份或同步基准。状态为 `running`、`succeeded`、`failed` 或 `needs_attention`；进度仅记录阶段、检查状态和与本操作 ID 绑定的探测文件路径/SHA-256 归属证明，不记录凭据。`GET /api/enrollment/connection/repair/{operationId}` 返回同一摘要，并可在重启后恢复未终结操作；相同 ID 和相同 relation/job 输入可安全重试，不同输入返回 `connection_repair_invalid`，同步或另一修复运行时返回 `connection_repair_busy`。探测路径归属无法证明时返回 `connection_repair_probe_conflict` 且不改文件；只有本次探测已确认清理，操作才能报告成功。

客户端在新建私钥前必须使用 ACL-first 持久化路径保护 enrollment session；请求 ID 与 Ed25519 身份在远端请求前落盘，允许重启后使用相同身份和请求重试。重复导入相同 server ID 但不同 key ID 或公钥必须返回 `enrollment_trust_failed`，不得自动替换 pin。首次申请需以本地私钥签名 request proof；消费请求必须以同一身份签名精确 `POST /api/enrollment/v1/consume` 原始 body 字节哈希。客户端只在验证管理员码绑定当前 server/device/request/public key/channel revision，并验过 pin 公钥对消费 receipt 的 Ed25519 签名后，才记录“身份已验证”。消费码不得进入本地状态、日志或 URL。

首次申请和消费都必须使用该签名通道的专用 sing-box VLESS 配置和本地 SOCKS 连接器；不得直接调用远端 fetch/HTTP，不得使用 direct 出站兜底。缺少通道、内置 sing-box 或启动代理失败时明确报错。消费成功后若尚无独立签名目录授权，只能展示身份已验证并等待授权；不得显示同步就绪、创建同步任务、改写既有 sync relation 或重置 bisync 基准。获得签名目录授权后可创建 SFTP 双向任务，但签名授权只证明服务器准许连接，不代表同步已成功。自动重试使用既有本地身份；服务器公钥变化须由用户重新核对后才能建立新的信任记录。

客户端本地 `POST /api/enrollment/data-authorizations/refresh` 只接受 `{}`，对已消费回执里的每个 binding 逐一请求远端 `POST /api/enrollment/v1/data-authorization`。远端请求体精确为 `{ relationId }`，`X-SFSC-Authorization` 必须由设备密钥签名并覆盖完整 binding、精确 method/path 和原始 body 字节；响应直接为 `{ payload, signature }`，服务器 Ed25519 签名覆盖 `canonicalJson(payload)` 的 UTF-8 字节，客户端只接受 pin 中 `serverId/keyId` 一致、binding/设备/公钥匹配且未过期的授权。若授权有效但服务端受保护的 SFTP relation runtime 无法启动，远端返回 `503 enrollment_data_relation_start_failed` 和不含路径/密钥的可操作提示；该运行故障不得降为目录未授权或泛化 `server_error`。服务端诊断可记录底层稳定 manager/helper code，不应把这些内部码、helper 路径或密钥返回给设备。数据通道 URI 必须和 bootstrap UUID 不同，host public key 行必须是单行 OpenSSH Ed25519 且其 `SHA256:` 指纹匹配。任务请求只能提交选择的 `relationId`，不能提交 caller 自称已验证的上下文、SFTP transport、私钥或 known_hosts 内容；客户端从已验签授权构造 job，且将 PKCS8 Ed25519 私钥文件与 known_hosts 文件在设置 owner-only ACL 后才写内容。SFTP 的授权根 `/` 对应服务端已 chroot 的目录，rclone 使用该虚拟根的空相对路径；任务使用独立数据 sing-box 与 loopback SOCKS 代理，rclone host key 验证始终开启。已配对设备续期使用远端 `POST /api/enrollment/v1/channel-renewal`，精确请求体为 `{ channelRevision }`。`X-SFSC-Authorization` 必须由持久设备密钥对原始完整 consumed binding、精确 `POST`/path/body SHA-256 和 nonce 签名。服务端依据当前 catalog 再校验 consumed grant、设备和 relation 未撤销，并要求请求体的 `channelRevision` 等于当前已应用 bootstrap transport revision；该值不要求等于 binding 中记录的首次配对 revision。成功响应精确为 `{ payload, signature }`；payload 精确包含 `protocol`、`version`、`kind: "channel-renewal"`、`serverId`、`keyId`、`deviceId`、`channelRevision` 和 `wrappedCode`，外层签名覆盖 `canonicalJson(payload)` 的 UTF-8 字节。`wrappedCode` 可直接交给现有 channel import 校验器，仍须按已 pin 的服务端密钥验签。当前 transport 变更后，旧 binding 仍用于数据授权；续期只为当前 transport 签发新码，不修改已消费 receipt、binding、关系授权或同步基准。重试使用新 nonce；同一当前 revision 下重发不会重新配对或重置关系。已签名 channel config 到期后仍可用当前已应用 transport 续期；请求 revision 不同于当前 revision 返回 `enrollment_channel_stale`，当前 bootstrap transport 未配置或未应用返回 `enrollment_channel_not_ready`，撤销的设备/关系按相应授权错误拒绝。不能要求重输一次性身份码，也不能把身份验证或目录授权标成同步成功。

客户端本地接口不属于公网协议，不应被服务端或第三方直接依赖。

`GET /api/health` 是客户端本地轻量探活合同，用于启动器复用已运行 runtime、smoke 和本机运维探活。启动器和端口占用恢复逻辑必须把该响应作为结构化身份合同校验，不得把任意 HTTP 200 当作已运行客户端。该成功响应是 client health response contract：响应顶层必须且只包含 `{ "ok": true, "mode": "client-exe-runtime", "version": "...", "clientVersion": "...", "diagnostics": { ... } }`，且 `version` 必须等于 `clientVersion`；`diagnostics.role` 必须为 `client`，协议版本必须与 `GET /api/client/status.diagnostics.protocols` 完全一致，客户端 smoke 应输出 `protocols=aligned`，任一字段不一致都视为本机协议漂移失败。该接口不得读取本地状态文件或密钥库，不得返回 `paths`、`profileSummary`、`jobs`、`safeguards`、`heartbeat`、`releaseManifest` 或任何 profile/secret 派生字段。

`POST /api/client/shutdown` 用于桌面壳、启动器和测试关闭本地 runtime。该成功响应是 client shutdown response contract：响应顶层必须且只包含 `{ "ok": true }`，接口应尽快返回并触发进程退出；退出流程必须向 sing-box 和 rclone 子进程发出停止信号并短暂等待收尾，避免 Windows 残留进程；重复调用或退出中的状态不得破坏本地 profile、jobs、secrets、sync-history 等状态文件。

`POST /api/binaries/check` 执行内置 sing-box/rclone 的版本命令，比 `GET /api/client/status.binaries` 的轻量存在性检查更严格。该成功响应是 client binaries check response contract：接口本身返回 HTTP 200 和组件级检查结果；响应顶层必须且只包含 `ok`、`singbox` 和 `rclone`，且只有 sing-box 与 rclone 都存在并且版本命令成功时 `ok` 才为 `true`。响应中的每个组件必须包含 `path`、`exists`、`ok`、`errorCode`、`message` 和 `version`；组件存在但版本命令失败时组件级 `errorCode` 使用 `binary_version_check_failed`，组件缺失时继续使用 `missing_singbox_binary` / `missing_rclone_binary`。

`POST /api/singbox/start` 启动本地 sing-box 代理，请求体必须是空 JSON 对象 `{}`，不得通过该入口覆盖 URI、端口或 profile 派生字段。接口必须先读取水合后的本地 profile；尚未导入 profile 或 profile 缺少可用 tunnel URI 时返回 `409 profile_not_imported`，profile/job 引用的 secret vault 条目缺失时返回 `409 secret_vault_missing`，且不得写 sing-box 配置或启动进程。profile 可用后再做轻量文件存在性检查，缺少 `sing-box.exe` 时返回 `503 missing_singbox_binary`。成功时必须把客户端 sing-box 配置写入 app-scoped `paths.singboxConfigFile`，使用 `127.0.0.1` 本地监听和 profile/defaults/job 指定的 `localProxyPort`，然后返回 `{ "singbox": { ... } }` 进程状态摘要；该成功响应是 client singbox process response contract，顶层必须且只包含 `singbox`，`singbox.name` 必须为 `sing-box`，`running` 必须为布尔值，`pid` 必须为整数或 `null`，`startedAt` 必须为字符串或 `null`，`lastExit` 必须为对象或 `null`，且不得泄露 SyncKey、导入 URI、VLESS URI 或存储密钥。若 sing-box 已经运行，该接口必须幂等返回当前进程状态，不重写配置、不启动第二个进程。配置写入或进程启动失败返回 `500 singbox_start_failed`，错误 message 不得包含 VLESS URI、SyncKey、`sfsc://import/v1#` 或存储密钥。`POST /api/singbox/start` 不得写入同步历史，不得修改 profile、jobs、secret vault 或 scheduler 状态。

`POST /api/singbox/stop` 停止本地 sing-box 进程；若当前没有 sing-box 运行，仍返回 200 和遵守 client singbox process response contract 的当前 `sing-box` 进程状态，不得写入同步历史或修改 profile/job/secrets 状态。

客户端首次启动且尚未导入 profile 时，`GET /api/profile` 必须稳定返回 `{ "profile": null }`，`GET /api/jobs` 必须返回 `{ "jobs": [] }`，`GET /api/sync/history` 必须返回 `{ "history": [] }`。这些空状态属于正常引导流程，不应返回 404 或错误码。

`GET /api/profile` 返回本地已导入 profile 的展示安全摘要，响应格式为 `{ "profile": null }` 或 `{ "profile": { ... } }`。该 HTTP 响应不得作为执行 DTO；可包含 `version`、`profileId`、`clientName`、`issuedAt`、`expiresAt`、`importedAt`、`importMode`、`source`、`summary`、`tunnel.type`、`tunnel.parsed`、`heartbeat.scheme`、`heartbeat.configured`、`storage.type`、`storage.remoteName`、`storage.endpoint`、`storage.bucket`、`storage.prefix`、`syncSpace`、`authorization` 和 `defaults`。其中 `syncSpace` 为 `{ id, syncId, mode }`、`authorization` 为 `{ role, directions, allowDelete }`，两者都是服务端在签发时算好的结论，客户端只读不改；profile v1（legacy 或离线导入）没有同步空间归属，两者必须为 `null`，此时 UI 退回“三个同步方向都可选”的旧行为，最终仍由 MinIO 策略裁决。不得包含原始 `tunnel.uri`、`storage.accessKeyId`、`storage.secretAccessKey`、`heartbeat.secret`、SyncKey、claim code、token 或完整 profile。若 secret vault 缺失，该展示接口仍必须基于未水合的 `profile.json` 返回展示安全摘要，方便用户确认已导入设备；同步执行、心跳签名和 rclone 配置必须在进程内通过 `readProfile()` 取得水合运行时对象，并在 vault 缺失时返回 `secret_vault_missing`。

`GET /api/jobs` 返回本地已保存任务的展示安全摘要列表，响应格式为 `{ "jobs": [...] }`。该接口是本机调试/兼容读取入口，不是执行 DTO；每个 job 摘要可包含用户可编辑字段和非敏感派生字段，例如 `id`、`name`、`localPath`、`direction`、`remoteFolder`、`serverSpace`、`transfers`、`streams`、`dryRun`、`destructiveSync`、`bandwidthLimit`、`schedule`、`checkers`、`s3UploadConcurrency`、`s3ChunkSize`、`cutoff`、`retries`、`lowLevelRetries`、`localProxyPort`、`clientName`、`remoteName`、`bucketName`、`remotePrefix` 和 `s3Endpoint`；不得包含 `accessKeyId`、`secretAccessKey`、`s3SecretAccessKey`、`heartbeatSecret`、`heartbeatAuthNonces`、`vlessUri`、SyncKey、claim code、token 或完整 profile。若 secret vault 缺失，该展示接口仍必须基于未水合的 `jobs.json` 返回展示安全摘要；同步执行、调度器和预览必须在进程内通过 `readJobs()` / `readProfile()` 或 `buildJobFromProfile()` 取得水合运行时对象，不得依赖 HTTP job 摘要补齐密钥。

`GET /api/jobs` 响应和 `/api/client/status.jobs[]` 必须通过共享运行时契约 `assertClientJobsReadContract` / `assertClientJobSummaryContract` 校验；默认客户端 smoke 必须读取 `/api/jobs`，并确认其数量与 `/api/client/status.jobs` 一致。该契约必须递归拒绝 `secretRef`、存储密钥、heartbeat 密钥、SyncKey、导入 URI、VLESS URI 和完整 profile，不得只检查顶层字段。

`POST /api/jobs/save` 和 `POST /api/sync/run` 是会改变本地同步行为的写接口。若最近一次成功 heartbeat 中存在 `heartbeat.compatibility.policy.syncRun: "warn"`，本地 API 必须要求请求体包含 `confirmCompatibilityWarning: true`；缺失时返回 `400 danger_confirmation_required`，不得保存 job 或启动 rclone。若请求 job 显式设置 `destructiveSync: true` 且方向不是 `bidirectional`，本地 API 还必须要求请求体包含 `confirmDestructiveSync: true`；缺失时同样返回 `400 danger_confirmation_required`。这两个确认彼此独立，两个风险同时存在时必须同时提交两个顶层确认字段。`POST /api/sync/preview` 是只读预览，不要求这些确认。客户端 UI 必须在展示兼容性说明并得到用户确认后，把 `confirmCompatibilityWarning: true` 作为请求顶层字段发送；在展示镜像删除说明并得到用户确认后，把 `confirmDestructiveSync: true` 作为请求顶层字段发送。本地自动化或第三方调用方也必须遵守同一语义。镜像和双向同步在运行前还必须生成安全计划并提交其 `safetyPlanId`；计划与归一化 job 指纹绑定、仅有效五分钟、只能执行一次，过期、已使用或指纹不匹配时返回 `400 danger_confirmation_required`。调度器只运行已经保存的 job，不因这些确认字段而重复阻断。

### 导入 profile

```http
POST /api/profile/import
Content-Type: application/json
```

请求：

```json
{
  "code": "SFSC1-..."
}
```

`code` 可以是服务端生成的一次性完整 SyncKey（`SFSC1-...` 或 `sfsc://import/v1#...`）、离线完整 profile 导入码，或 `/api/claims/create` 返回的 `AAAA-AAAA` 短码。短码不包含路由信息，请求必须同时提交对应 HTTP(S) `server` 地址；客户端规范化地址和短码后，按与完整 SyncKey 相同的 recovery/redeem 流程处理。短码缺少有效 `server` 时必须返回 `400 import_code_invalid`，不得向任何服务端试探或消耗 SyncKey。兼容字段包括 `tKey`、`tkey`、`claimCode` 和 `token`；旧调试入口仍兼容 `uri` 形式的 VLESS 长链接并生成本地 legacy profile，可选 `clientName` 和 `options.localProxyPort` 只用于 legacy profile 默认值，不能把未知 `options` 字段继续传入执行链路。导入成功响应是 client profile import response contract：响应顶层必须且只包含 `profile`，且 `profile` 必须为非空展示安全摘要，不能复用 `GET /api/profile` 的空状态 `{ "profile": null }`。

导入模式不变量：

- `claim-redeem` 必须来自 SyncKey claim token 兑换，客户端必须写入 `source.type: "claim"` 和 `source.server`，兑换返回的正式 profile 必须包含 `heartbeat.scheme: "sfsc-hmac-sha256-v1"`、非空 `heartbeat.secret`，以及完整 S3 存储字段 `storage.remoteName`、`storage.endpoint`、`storage.bucket`、`storage.accessKeyId`、`storage.secretAccessKey` 和 `storage.prefix`。缺少心跳认证材料必须返回 `400 profile_heartbeat_required`；缺少存储凭据或必要存储字段必须返回 `400 profile_storage_required`；正式 SyncKey 导入不得把缺失存储字段静默补成 `CHANGE_ME_CLIENT_SECRET` 或其他占位密钥。
- `offline-profile` 表示离线完整 profile 导入码。服务端 `/api/profile/encode` 生成的离线完整 profile 必须携带 `source.type: "profile"`、`source.server`、`heartbeat.secret` 和完整 S3 存储字段；客户端在默认值填充前必须校验这类带 `source.server` 的服务端签发离线 profile，缺少心跳认证材料返回 `400 profile_heartbeat_required`，缺少存储凭据或必要存储字段返回 `400 profile_storage_required`，不得静默补成 `CHANGE_ME_CLIENT_SECRET` 或默认 bucket/prefix。手工或历史离线 profile 若缺少 `source.server` 或 `heartbeat.secret`，只能作为本地执行 profile，客户端不得发送 unsigned heartbeat。
- `legacy-vless-uri` 仅用于旧调试入口 `uri`，客户端可生成本地 legacy profile 以启动本机 sing-box/rclone 流程，但不得补 `source.server`，不得参与 heartbeat/compatibility，也不得被服务端视为正式签发 profile。

当 `code` 是 SyncKey 且需要远端兑换时，客户端本地运行时必须在发送 `/api/claims/redeem` 前写入 `data/claim-recovery.json` 作为 pending recovery stash。该 stash 表示“导入未完成”，必须只保存 claim 摘要和绑定，例如 `claim: { server, codeHash }`、`clientRedeemId`、`clientInstallId`、`createdAt`、`updatedAt`；不得保存完整 SyncKey、不得保存一次性短码、不得保存 profile、VLESS URI、S3 secret 或 heartbeat secret。若同一个 `claim.server`/`claim.codeHash` 已经存在 pending recovery stash，客户端必须复用其中的 `clientRedeemId` 和 `clientInstallId` 重新兑换，使服务端能按同一客户端绑定执行短时绑定重放。若摘要不同，应生成新的绑定并替换 pending stash。若 pending stash 无法安全读写，客户端不得调用远端 redeem。

成功响应：

```json
{
  "profile": {
    "version": 1,
    "profileId": "profile-company-pc1-abc123",
    "clientName": "company-pc1",
    "importMode": "claim-redeem",
    "source": {
      "type": "claim",
      "server": "https://server.example"
    },
    "tunnel": {
      "type": "vless",
      "parsed": {
        "server": "server.example",
        "port": 45678
      }
    },
    "heartbeat": {
      "scheme": "sfsc-hmac-sha256-v1",
      "configured": true
    },
    "storage": {
      "type": "s3",
      "remoteName": "home-minio",
      "endpoint": "http://minio:9000",
      "bucket": "home-sync",
      "prefix": "devices/company-pc1"
    },
    "defaults": {
      "localProxyPort": 18081,
      "transfers": 4,
      "streams": 8,
      "checkers": 8,
      "chunkSize": "16M",
      "retries": 3,
      "lowLevelRetries": 10,
      "bandwidthLimit": "off",
      "schedule": {
        "mode": "manual"
      }
    }
  }
}
```

导入成功后，本地运行时必须保存 profile、刷新调度器，并按 profile 派生字段刷新已有 job。响应中的 `profile` 是展示安全摘要，不得包含原始 `tunnel.uri`、`storage.accessKeyId`、`storage.secretAccessKey`、`heartbeat.secret` 或其他导入凭据；持久化到 `profile.json` 时必须写为 `{ "secretRef": "profile:...:storage.secretAccessKey" }` 和 `{ "secretRef": "profile:...:heartbeat.secret" }` 引用对象，真实密钥进入本地 secret vault。后续同步执行和心跳签名必须通过进程内水合 profile 获取这些运行材料。客户端必须把 `profile.json`、`jobs.json` 和 `secrets.json` 作为同一次导入提交来保护；若刷新已有 job、写入任一状态文件或刷新 scheduler 失败，必须回滚到导入前的 profile/jobs/secrets 状态，不得留下新旧 profile 与任务凭据混用的半提交状态。只有 profile、jobs、scheduler 和 secrets 都成功持久化后，客户端才可以清理 `data/claim-recovery.json`。若远端 `/api/claims/redeem` 返回合同登记的终态错误 `claim_not_found`、`claim_already_used`、`claim_expired` 或 `validation_failed`，或远端成功后本地校验发现服务端签发 profile 缺少必要材料并返回 `profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`，客户端必须回滚本地状态并清理对应 pending recovery stash；这些错误无法靠重放同一个 SyncKey 恢复，应检查服务端配置后重新生成 SyncKey。若远端返回 `claim_redeem_rate_limited`、`server_state_write_failed`、本地降级为 `claim_redeem_failed`、进程崩溃，或远端成功后 job 刷新、scheduler 刷新、secret/profile/jobs 任一持久化步骤失败，客户端必须保留 pending recovery stash，等待用户重试同一个 SyncKey。

客户端 SyncKey 导入错误 UI 建议合同：

- `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 是 SyncKey 导入终态错误，`retryable: false`；客户端 UI 必须提示“不可重试当前 SyncKey”或“不可重试当前内容”，并提示检查输入、确认是否复制完整、重新复制完整 SyncKey 或在服务端重新生成 SyncKey。
- `claim_redeem_rate_limited` 是短期限速错误，`retryable: true`；客户端 UI 必须提示等待限速窗口、检查是否反复粘贴了错误 SyncKey，必要时联系管理员重新生成 SyncKey。
- `server_state_write_failed`、`claim_redeem_failed` 是可重试错误，`retryable: true`；客户端 UI 必须提示“可重试”，并提示检查服务端数据目录权限和磁盘空间，或检查网络、服务端地址和服务端进程，修复后用同一个 SyncKey 再试。
- `profile_heartbeat_required`、`profile_storage_required` 表示服务端签发 profile 缺材料；客户端 UI 必须提示缺少心跳认证材料或存储凭据/必要存储字段，并提示检查服务端配置后重新生成 SyncKey，不能只让用户重试同一个 SyncKey。

错误：

- `400 import_code_required`
- `400 import_code_invalid`
- `400 unsupported_profile_version`
- `400 profile_heartbeat_required`
- `400 profile_storage_required`
- `400 profile_tunnel_required`
- `400 invalid_vless_uri`
- `400 validation_failed`
- `404 claim_not_found`
- `409 claim_already_used`
- `409 local_state_corrupt`
- `410 claim_expired`
- `500 server_state_write_failed`
- `502 claim_redeem_failed`

### 保存同步任务

```http
POST /api/jobs/save
Content-Type: application/json
```

请求：

```json
{
  "job": {
    "localPath": "D:\\Work",
    "direction": "upload",
    "remoteFolder": "projects",
    "transfers": 4,
    "streams": 8,
    "destructiveSync": false,
    "bandwidthLimit": "off",
    "schedule": {
      "mode": "manual"
    }
  }
}
```

客户端 UI 可以只提交用户可编辑字段。重新保存已从 `/api/client/status.jobs` 或 `/api/jobs` 加载的任务时，客户端 UI 必须以展示安全 job 摘要为 draft 基线，保留 `id`、`remoteFolder`、`serverSpace`、`checkers`、`retries`、`dryRun`、`localProxyPort` 等未展示但可编辑或用户配置字段，再用表单字段覆盖当前编辑值；不得因为页面未展示某字段而丢失该字段或创建重复任务。客户端 UI 读取 `transfers`、`streams` 等数值表单字段时必须严格要求正整数并阻止非法请求，不得把空值、0、小数或非数字静默替换成默认值。客户端 job 请求 schema 必须对白名单字段归一化，只允许用户可编辑字段 `id`、`name`、`localPath`、`direction`、`remoteFolder`、`serverSpace`、`transfers`、`streams`、`checkers`、`s3UploadConcurrency`、`s3ChunkSize`、`chunkSize`、`cutoff`、`retries`、`lowLevelRetries`、`dryRun`、`destructiveSync`、`bandwidthLimit`、`schedule` 和 `localProxyPort` 进入运行时。运行时必须先读取已导入 profile，并用 `buildJobFromProfile()` 补齐 `clientName`、`remoteName`、`bucketName`、`remotePrefix`、`s3Endpoint`、`accessKeyId`、`secretAccessKey`、`checkers`、`s3ChunkSize`、`cutoff`、`retries`、`lowLevelRetries` 和 `localProxyPort` 等执行字段；其中 job 请求已显式包含的用户配置优先，缺失字段才使用 profile defaults。job 请求体中的 `clientName`、`remoteName`、`bucketName`、`bucket`、`remotePrefix`、`s3Endpoint`、`endpoint`、`accessKeyId`、`secretAccessKey`、`s3SecretAccessKey`、`storageBackend`、`uri` 和 `vlessUri` 必须视为展示摘要残留或恶意覆盖输入，`POST /api/jobs/save`、`POST /api/sync/preview` 和 `POST /api/sync/run` 都不得用这些字段覆盖 profile 派生的执行材料，也不得把这些字段写入 `jobs.json`、secret vault、rclone 配置或 sing-box 配置。`direction: "bidirectional"` 时必须忽略 `destructiveSync`。

SFTP job 同样只接受上述用户可编辑 tuning 字段：`transfers`、`streams`、`checkers`、`retries`、`lowLevelRetries` 是 1..1024 的正整数，`cutoff`/`chunkSize` 是非空字符串且最多 64 个字符，`bandwidthLimit`、`safety` 与 `schedule` 使用本文各自的归一化合同。客户端必须从本机已验签的目录授权重建 SFTP host、port、user、SSH 私钥、known_hosts、host-key fingerprint、credential revision 和数据通道 URI；请求中的同名或附加传输材料不得覆盖这些签发值。SFTP SOCKS 端口先尝试绑定检查 job 显式端口或默认端口 `18082`；若端口被占用，最多另选 3 个由本机 OS 分配的候选端口，失败时返回 `503 singbox_start_failed`，不得复用未知 listener。归一化后的 `localProxyPort` 与 `sftpTransport.socksProxy` 必须一致，并供该次预览/安全计划/运行使用，使 rclone `ALL_PROXY`、`--sftp-socks-proxy` 和本次 data sing-box inbound 的 listen port 相等。SFTP safety-plan 指纹不把此本地临时代理端口视为目录或数据范围变化。只有已验签、已初始化的 SFTP 双向任务可保存 interval/daily/startup 自动计划；未初始化任务及其他 risky job 必须保持手动计划。每次自动运行仍须重新校验授权、marker 和当前删除阈值计划。

成功响应：

```json
{
  "job": {
    "id": "job-1783123456789",
    "localPath": "D:\\Work",
    "direction": "upload",
    "clientName": "company-pc1",
    "remoteName": "home-minio",
    "bucketName": "home-sync",
    "remotePrefix": "devices/company-pc1",
    "s3Endpoint": "http://minio:9000",
    "transfers": 4,
    "streams": 8,
    "checkers": 8,
    "s3ChunkSize": "16M",
    "cutoff": "16M",
    "retries": 3,
    "lowLevelRetries": 10,
    "bandwidthLimit": "off",
    "schedule": {
      "mode": "manual"
    },
    "localProxyPort": 18081
  },
  "scheduler": {
    "enabled": true,
    "intervalMs": 15000,
    "nextRun": null,
    "lastTriggeredAt": null,
    "lastError": "",
    "jobs": []
  }
}
```

该成功响应是 client job save response contract，必须包含展示安全 `job` 摘要和当前 `scheduler` 摘要。响应中的 `job` 不得包含 `accessKeyId`、`secretAccessKey`、`s3SecretAccessKey` 或其他密钥/凭据字段；运行时保存到 `jobs.json` 时仍必须把执行所需密钥写为 `{ "secretRef": "job:...:secretAccessKey:..." }` 不可变引用对象，并通过本地 secret vault 水合给同步执行链路。如果本地状态文件损坏，保存入口不得覆盖损坏文件，必须返回 `409 local_state_corrupt`。

错误：

- `409 profile_not_imported`
- `409 local_state_corrupt`
- `409 secret_vault_missing`
- `400 danger_confirmation_required`
- `400 validation_failed`

### 同步预览

```http
POST /api/sync/preview
Content-Type: application/json
```

请求格式与 `/api/jobs/save` 的 `job` 相同，客户端 UI 可以只提交用户可编辑字段。运行时必须先用已导入 profile 归一化 job，并检查内置 `rclone.exe` 是否存在；缺失时返回 `503 missing_rclone_binary`。

成功响应：

```json
{
  "rclone": {
    "executable": "C:\\App\\resources\\bin\\win32\\rclone.exe",
    "args": ["copy", "D:\\Work", "home-minio:home-sync/devices/company-pc1"],
    "env": {
      "HTTP_PROXY": "socks5://127.0.0.1:18081",
      "HTTPS_PROXY": "socks5://127.0.0.1:18081",
      "ALL_PROXY": "socks5://127.0.0.1:18081",
      "NO_PROXY": "127.0.0.1,localhost"
    },
    "displayCommand": "$env:HTTP_PROXY=\"socks5://127.0.0.1:18081\"\n...",
    "remoteConfig": {
      "executable": "C:\\App\\resources\\bin\\win32\\rclone.exe",
      "args": ["config", "create", "home-minio", "s3"],
      "displayCommand": "$env:RCLONE_CONFIG_HOME_MINIO_SECRET_ACCESS_KEY=\"se****et\"\nrclone config create home-minio s3 ..."
    },
    "storage": {
      "remoteName": "home-minio",
      "bucket": "home-sync",
      "prefix": "devices/company-pc1"
    },
    "remotePath": "home-minio:home-sync/devices/company-pc1",
    "safety": {
      "usesProcessScopedProxy": true,
      "mutatesSystemProxy": false,
      "mutatesRoutes": false,
      "tunRequired": false,
      "muxRequired": false,
      "deleteProtection": true
    }
  },
  "schedule": {
    "text": "Manual",
    "nextRun": null
  }
}
```

`rclone.args` 和 `rclone.remoteConfig.args` 是真实执行参数，但都不得包含 S3 secret：secret 只能通过 `rclone.remoteConfig.env` / `rclone.env` 里的 `RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY` 注入，避免出现在进程命令行中被同机其他进程读取；`displayCommand` 和 `remoteConfig.displayCommand` 必须脱敏该环境变量值，且不得包含 SyncKey、`sfsc://import/v1#` 或 VLESS URI。预览接口不得启动 sing-box、不得写 rclone config、不得写同步历史。`409 local_state_corrupt` 只覆盖预览实际读取的 profile/jobs/secrets 等本地状态；因为预览是只读接口，不得仅因 `sync-history.json` 或 `claim-recovery.json` 损坏而失败，除非实现明确读取它们。`direction: "bidirectional"` 时 action 必须为 `bisync` 且 `safety.deleteProtection` 为 `true`。该结构是 sync preview contract。

错误：

- `503 missing_rclone_binary`
- `409 local_state_corrupt`
- `409 profile_not_imported`
- `409 secret_vault_missing`
- `400 validation_failed`

### 同步安全计划

```http
POST /api/sync/safety-plan
Content-Type: application/json
```

请求格式与 `/api/jobs/save` 的 `job` 相同，不接受确认字段。对于镜像或双向同步，运行时必须在 app-scoped rclone 配置和本地 sing-box 隧道就绪后，以 `rclone lsjson --recursive --files-only` 只读枚举源端和目标端；响应不得包含文件名、路径、存储凭据、SyncKey 或 VLESS URI。响应 `plan` 必须包含一次性 `id`、`createdAt`、`expiresAt`、`jobFingerprint`、`direction`、`destructiveSync`、`recoveryRetentionDays`、`deleteLimit`、源/目标文件数、删除文件数和百分比、是否在删除上限内，以及双向初始化是否仍必需。镜像删除数超过 `deleteLimit.maxFiles` 或 `deleteLimit.maxPercent` 时，`plan.deletions.allowed` 必须为 `false`，`/api/sync/run` 不得执行该计划。双向任务在显式初始化完成前，`plan.bidirectional.initializationRequired` 必须为 `true`，`/api/sync/run` 不得执行。

成功响应：

```json
{
  "plan": {
    "id": "uuid",
    "createdAt": "2026-07-10T00:00:00.000Z",
    "expiresAt": "2026-07-10T00:05:00.000Z",
    "jobFingerprint": "{...}",
    "direction": "upload",
    "destructiveSync": true,
    "requiresExecutionPlan": true,
    "recoveryRetentionDays": 30,
    "deleteLimit": { "maxFiles": 100, "maxPercent": 10 },
    "source": { "files": 120 },
    "target": { "files": 125 },
    "deletions": { "files": 5, "percent": 4, "allowed": true },
    "bidirectional": { "initialized": false, "initializationRequired": false }
  }
}
```

失败响应可为 `503 missing_rclone_binary`、`503 missing_singbox_binary`、`500 singbox_start_failed`、`500 rclone_config_failed`、`500 rclone_sync_failed`、`409 profile_not_imported`、`409 local_state_corrupt`、`409 secret_vault_missing`、`400 invalid_path` 或 `400 validation_failed`。

### 初始化双向同步

```http
POST /api/sync/bisync/initialize
Content-Type: application/json
```

请求包含双向 `job`、同一 job 的未过期 `safetyPlanId` 和 `confirmBidirectionalInitialization: true`。运行时只接受 `direction: "bidirectional"`，并且该安全计划必须显示 `initializationRequired: true`。初始化必须先用 `rclone bisync --resync --resync-mode <local|remote|newer> --dry-run --check-access --resilient --workdir <app-scoped>` 校验，再执行同一初始化命令；只有实际命令成功后才可在 `bisync-state.json` 记录任务指纹、初始化时间、模式和 app-scoped 工作目录。计划在初始化成功后消费，后续普通双向运行不得附带 `--resync`。缺少确认、计划过期/失配或已初始化时返回 `400 danger_confirmation_required`；方向错误返回 `400 validation_failed`。

### 运行同步

```http
POST /api/sync/run
Content-Type: application/json
```

请求格式与 `/api/jobs/save` 的 `job` 相同。运行前必须先检查本地 JSON 状态可写、secret vault 健康、内置 `rclone.exe` 和内置 `sing-box.exe`，再用预览生成的 `remoteConfig.args` 写入 app-scoped rclone config；rclone config 写入成功后，启动本次 runPlan 对应的 sing-box/data tunnel 和 rclone。启动 sing-box 时必须先把配置写入 app-scoped配置文件，再执行 `sing-box check -c <config>`；check 失败必须返回 `500 singbox_start_failed`，不得启动 `sing-box run`。`sing-box run` spawn 后不能立即视为可用，必须等待由本次客户端进程启动的 loopback listener 就绪；若进程快速退出或端口就绪超时，也必须返回 `singbox_start_failed`。`runPlan` 用于本次同步执行。安全计划 helper 会独立重建并规范化任务、重新读取当前授权并再次校验，不能假设安全检查始终复用同一个 normalized job 快照。SFTP 的 `ALL_PROXY`、`--sftp-socks-proxy` 和本次 data sing-box inbound 必须共用同一端口；若 job/default 端口不可绑定，客户端最多尝试 3 个本机 OS 分配端口，最终配置必须来自同一个 runPlan。若 `sync-history.json` 或其他本地状态文件损坏，必须在启动 sing-box 或写 rclone 配置前返回 `409 local_state_corrupt`。缺少内置组件、sing-box 启动失败或 rclone config 写入失败都属于启动前失败，必须直接返回对应错误码，不得写入同步历史；rclone config 写入失败返回 `500 rclone_config_failed`，不得启动 rclone sync，若 sing-box 原本未运行也不得留下新启动的 sing-box 进程，`processes.sync.metrics.syncState` 必须保持 `idle`，错误 message 中的 stdout/stderr/detail 必须脱敏 S3 secret、SyncKey、`sfsc://import/v1#` 和 VLESS URI。只有新 trusted relation 每轮执行可信恢复 journal prepare/verify/start/complete；经原 fingerprint、alias、workdir 与 initialized state 精确确认的非 SFTP `legacy_compatible` 任务继续原手动 bisync，不创建新恢复命名空间，也不声称有新恢复版本。普通自动计划仅允许已初始化、已授权的 SFTP 双向任务；调度每轮重建当前安全计划并校验删除门槛、授权与 marker，未初始化或超限时不得启动 rclone。

成功响应：

```json
{
  "sync": {
    "name": "rclone-sync",
    "running": true,
    "pid": 1234,
    "startedAt": "2026-07-03T10:00:00.000Z",
    "lastExit": null
  }
}
```

该成功响应是 client sync run response contract，必须包含 `sync` 进程状态；`sync.name` 必须为 `rclone-sync`，`running` 必须为布尔值，`pid` 必须为整数或 `null`，`startedAt` 必须为字符串或 `null`，`lastExit` 必须为对象或 `null`，且不得泄露存储密钥、SyncKey、导入 URI 或 VLESS URI。

同步启动成功后必须写入一条 `status: "running"` 的同步历史，更新 `processes.sync.metrics.syncState` 为 `syncing`，并通过心跳上报最近运行摘要。客户端 UI 调用 `/api/sync/safety-plan` 和 `/api/sync/run` 时必须使用 120 秒页面等待预算，调用 `/api/sync/bisync/initialize` 时必须使用 240 秒页面等待预算，避免通用 15 秒超时抢先覆盖本地运行时稍后返回的 `rclone_sync_failed` 或 `singbox_start_failed`。页面等待超时只表示启动结果尚未确认，不表示远端服务端超时或同步必然失败；UI 必须提示后台仍可能在准备任务，并刷新客户端状态和日志。若已有同步启动流程或同步进程正在运行，客户端必须用归一化后的 job 指纹区分请求：同一 job 的重复 `/api/sync/run` 返回 `200` 和当前进程状态，不新增同步历史、不再次写 rclone config、不启动第二个 rclone；不同 job 返回 `409 sync_already_running`，不得等待当前运行完成，也不得启动任何新进程。`/api/sync/stop` 必须先把状态置为 `stopping`，向 rclone 发送停止信号并短暂等待退出；若进程在等待窗口内退出，响应返回非运行状态，后续相邻 `/api/sync/run` 可以启动新的同步；若等待超时，响应必须保留运行状态并通过 `stopTimedOut: true` 暴露诊断。同步进程异常退出时，包括进程在异步启动记录落盘期间快速退出，历史记录必须更新为 `status: "error"`、`errorCode: "rclone_sync_failed"`；用户主动停止时更新为 `status: "stopped"`，不写入 `rclone_sync_failed`。

错误：

- `503 missing_rclone_binary`
- `503 missing_singbox_binary`
- `409 profile_not_imported`
- `409 secret_vault_missing`
- `409 local_state_corrupt`
- `409 sync_already_running`
- `400 danger_confirmation_required`
- `500 singbox_start_failed`
- `500 rclone_config_failed`
- `500 rclone_sync_failed`

### 停止同步

```http
POST /api/sync/stop
Content-Type: application/json
```

成功响应：

```json
{
  "sync": {
    "name": "rclone-sync",
    "running": false,
    "pid": null,
    "startedAt": null,
    "lastExit": null
  }
}
```

成功响应复用 client sync run response contract，并可额外包含 `sync.stopSignal` 与 `sync.stopTimedOut` 诊断字段。若 rclone 正在运行，接口必须先把 `processes.sync.metrics.syncState` 置为 `stopping`，再向进程发送停止信号并等待短暂退出窗口；等待期间 `GET /api/client/status` 应呈现 `stopping`，客户端顶部同步状态和进度区都必须显示正在停止，而不是继续显示普通同步中。若退出完成，响应返回 `running: false`，同步历史写入 `status: "stopped"`，且不得写入 `rclone_sync_failed`；若等待超时，响应保留 `running: true` 并设置 `stopTimedOut: true`，供诊断和后续状态轮询判断。若没有同步正在运行，接口仍返回 200 和当前 `rclone-sync` 状态，方便 UI 把“停止”作为幂等操作处理。

### 读取日志

```http
GET /api/logs
```

成功响应：

```json
{
  "singbox": "recent sing-box log text",
  "rclone": "recent rclone log text"
}
```

`GET /api/logs` 返回客户端本地近期诊断日志文本，当前每个日志最多保留最近 20000 字符。该成功响应是 client logs contract：响应顶层必须且只包含 `singbox` 和 `rclone`。日志写入和读取都必须脱敏存储密钥字段，包括 `secret_access_key`、`secretAccessKey`、`S3_SECRET_ACCESS_KEY`、`AWS_SECRET_ACCESS_KEY`、`MINIO_ROOT_PASSWORD` 等。日志文件不存在时对应字段返回空字符串，不应导致接口失败。结构化元数据由 `/api/diagnostics/export` 的 `bundle.logs.*` 提供。

`GET /api/diagnostics/export` 返回一份客户端本地脱敏诊断包，供用户在设置页下载后交给支持人员排查。该成功响应是 client diagnostic export contract：响应顶层必须且只包含 `ok`、`filename` 和 `bundle`，且 `ok` 必须为 `true`；`bundle.schemaVersion` 当前为 `1`，内容包括生成时间、支持摘要、客户端状态摘要、协议/构建诊断、任务/调度/心跳/同步历史、运行环境、发布 manifest 摘要、组件文件摘要、本地状态文件摘要和最近日志。`bundle.summary` 是支持人员优先阅读的一层摘要，至少包含版本、发布 manifest 是否可用、发布 manifest 版本/构建时间/错误码、profile 导入状态、客户端名、服务端地址、组件是否齐全、缺失组件、local state/vault 健康、心跳错误码、心跳设备状态/启用状态/在线状态/bucket/prefix、服务端协议、心跳兼容状态、同步执行兼容策略、最近同步状态/错误码、冲突数量、缺失日志和截断日志；完整细节仍以 `status`、`environment` 和 `logs` 为准。诊断包 summary 的 `heartbeatOk`、`heartbeatErrorCode` 和 `heartbeatRemoteErrorCode` 必须来自当前 heartbeat；心跳设备状态、服务端协议和兼容性字段必须读取“当前成功 heartbeat，否则最近一次成功 heartbeat”的快照，避免当前网络失败时丢失最近可靠的服务端上下文。诊断包中的 `bundle.logs.electron`、`bundle.logs.singbox`、`bundle.logs.rclone` 必须是结构化日志元信息对象，字段必须且只包含 `path`、`exists`、`size`、`modifiedAt`、`maxChars`、`truncated` 和 `text`；`text` 只保留最近片段，超过 `maxChars` 时 `truncated` 为 `true`。诊断包必须递归脱敏密钥、token、SyncKey、VLESS URI、`heartbeatSecret`、`heartbeatAuthNonces` 和日志中的存储密钥值，不得泄露 `secretAccessKey` 原文。

诊断包中若存在 `bundle.status.enrollment.lastError`，它只包含稳定 enrollment 错误码和规范 UTC 记录时间；不得加入原始请求、密钥、验证码、签名信封或原始错误文本。该记录不携带可信时差测量，不得据此判断哪一端时钟不准。

诊断包是可外发的公开支持材料，不等同于本机 UI 状态接口。`bundle.status`、`bundle.environment`、`bundle.logs` 和 `bundle.summary` 不得包含 Windows/Unix 绝对路径、本机用户名、真实 secret vault key/ref、同步当前文件名、最近同步文件名、冲突文件名或原始日志中的本地文件路径；路径类字段必须降级为 basename、`redacted` 或结构化存在性/大小/错误码，`missingRefs` 只能保留与缺失数量一致的 `redacted` 占位，`currentFile` / `heartbeatDeviceCurrentFile` 和 `conflicts.files[]` 必须脱敏。普通本地状态接口可以继续给客户端 UI 展示本机操作所需的路径和同步文件线索，但一旦进入 `/api/diagnostics/export`，必须按公开诊断包规则处理。

诊断包 summary 必须显式包含 `heartbeatCompatibilityStatus`、`heartbeatCompatibilitySeverity` 和 `heartbeatCompatibilitySyncRunPolicy`；这三个字段必须来自同一份“当前成功 heartbeat，否则最近一次成功 heartbeat”的兼容性快照。

诊断包 `bundle.environment` 至少包含 Node/平台/架构、是否便携根目录运行、关键目录、`releaseManifest` 发布包摘要、sing-box/rclone 文件存在性与大小、profile/jobs/secrets/sync-history/sync-recovery/claim-recovery/last-successful-heartbeat 状态文件存在性、大小和修改时间，以及 Electron/sing-box/rclone 日志文件摘要。`bundle.environment.stateFiles` 必须且只包含 `profile`、`jobs`、`secrets`、`syncHistory`、`syncRecovery`、`claimRecovery` 和 `lastSuccessfulHeartbeat` 七项摘要；`syncRecovery` 对应恢复状态目录，`claimRecovery` 对应 `data/claim-recovery.json`，`lastSuccessfulHeartbeat` 对应 `data/last-successful-heartbeat.json`。`releaseManifest` 至少包含 manifest 路径、存在性、解析状态、schemaVersion、package、version、builtAt、fileCount、supportDocuments、requiredFiles、errorCode 和 message；manifest 缺失使用 `release_manifest_missing`，manifest 无法解析或结构不符合预期使用 `release_manifest_invalid`。`supportDocuments` 必须列出随包交付的 `INTERFACE_CONTRACT`、`API_MATRIX` 和 `DEPLOYMENT_AND_MIGRATION_GUIDE` 是否登记在 manifest 中，包含 `ok` 和每个文件的 `name`、`path`、`present`、`valid`、`size`、`sha256`；`requiredFiles` 必须按包类型列出启动器、app `package.json`、本地 HTTP 入口、路径解析、本地状态 store、诊断包、进程/sync/rclone 进度/profile import 运行模块、客户端 launcher 源文件、客户端 UI HTML/JS/CSS、共享 core 入口、支持文档、二进制 lock 和内置 sing-box/rclone 是否登记在 manifest 中。`valid` 要求该 manifest 条目的 `size > 0` 且 `sha256` 是 64 位小写十六进制，`supportDocuments.ok` 和 `requiredFiles.ok` 必须只有在对应文件都存在且 valid 时才为 true。诊断摘要中的 `releaseManifestSupportDocsMissing` 应列出缺失或无效的支持文档名称；`releaseManifestRequiredFilesMissing` 应列出缺失或无效的关键运行文件名称。该摘要用于支持人员判断用户是否使用了错误包、缺少组件、本地状态文件异常、合同文档缺失、manifest 关键文件登记不完整或日志未生成；它不得包含环境变量中的 token 或密钥值。

`GET /api/client/status` 是客户端 UI 的本地状态合同。成功响应顶层精确包含 `appVersion`、`binaries`、`clientVersion`、`diagnostics`、`enrollment`、`heartbeat`、`jobs`、`lastSuccessfulHeartbeat`、`lastSync`、`mode`、`ok`、`paths`、`processes`、`profileImported`、`profileSummary`、`releaseManifest`、`safeguards`、`scheduler`、`syncHistory`。HTTP 合同由 `assertClientStatusContract` 按精确字段检查。其余字段定义如下：

- `ok: true`: 本地运行时健康标记；启动器和 smoke 可用它判断已运行实例是否为 SFSC 客户端。
- `mode: "client-exe-runtime"`: 本地运行时模式标识，用于区分服务端控制台和客户端本地 API。
- `appVersion` / `clientVersion`: 客户端运行时版本，用于诊断客户端与服务端发布批次；默认来自根 `package.json` 版本生成的包元数据，可用 `SFSC_CLIENT_VERSION` 显式覆盖。
- `diagnostics`: 客户端诊断块，包含客户端角色、运行版本、可选构建标识和各协议版本；用于和服务端 `/api/health.diagnostics` 对齐。
- `enrollment`: 首次接入状态摘要，使用展示安全字段描述已验证通道、申请和已消费身份状态；不得包含私钥、一次性验证码或完整通道配置。只有记录到最近一次稳定 enrollment 错误时，才可增加 `lastError: { code, recordedAt }`；`code` 必须是稳定 `enrollment_*` 错误码，`recordedAt` 必须是规范 UTC 时间。不得保存或返回请求体、密钥、验证码、签名材料或原始错误文本。
- `releaseManifest`: 客户端发布包 manifest 摘要，至少包含 `path`、`exists`、`ok`、`schemaVersion`、`package`、`version`、`builtAt`、`fileCount`、`supportDocuments`、`requiredFiles`、`errorCode` 和 `message`；正式包名目前允许 `SyncraftDesktop` 和 `SyncraftClient`，分别对应 Electron 桌面包和旧式 Node 便携包。设置抽屉必须可见展示发布包状态、包构建时间、合同文档登记状态和关键文件登记状态，便于不用打开诊断 JSON 即可判断是否运行了正式交付包。`supportDocuments.ok` 为 `false` 时表示发行包缺少接口合同或 API 矩阵登记，`requiredFiles.ok` 为 `false` 时表示发行包关键运行文件未被 manifest 覆盖，均应视为非完整交付包；UI 必须直接提示缺少的合同文档名称和缺失/无效的关键运行文件名称，诊断包也必须列出这些名称。
- `paths`: 本地关键目录摘要，至少包含 `root`、`binRoot` 和 `dataRoot`，用于诊断便携包路径和运行时数据位置。客户端启动时可通过 `SFSC_CLIENT_DATA_ROOT` 或 `SFSC_DATA_ROOT` 显式指定数据目录；未指定时优先使用包根 `data`，若包根数据目录无法创建或写入，必须 fallback 到当前 Windows 用户的 `%LOCALAPPDATA%\Syncraft\data`，并在 `paths.dataRoot` 暴露实际使用目录。
- `binaries`: 客户端组件摘要，`singbox` 和 `rclone` 至少包含 `path`、`exists`、`ok`、`errorCode`、`message`；缺少组件时必须分别使用 `missing_singbox_binary` 或 `missing_rclone_binary`，让状态页和诊断包无需等待启动/同步失败即可定位缺失组件。`GET /api/client/status.binaries.ok` 是轻量存在性检查；`POST /api/binaries/check` 会额外运行版本命令，响应中的 `ok` 必须表示文件存在且版本检测成功，版本检测失败使用 `binary_version_check_failed`。
- `profileImported`: 是否已导入 profile。`profileImported` 必须是布尔值；未导入时必须返回 `false`，不得省略或返回字符串/数字等兼容形态。
- `profileSummary`: 已导入 profile 的摘要，包含 client、服务端、存储空间和本地代理端口，以及 v2 起的 `syncSpace`（`{ id, syncId, mode }`）和 `authorization`（`{ role, directions, allowDelete }`）。客户端 UI 必须以 `authorization.directions` 为唯一依据决定同步方向可选项，并以 `syncSpace.syncId` 作为空间显示名，不得自行提供同步空间或远端子目录选择——服务端签发的 MinIO 策略只授权 `${prefix}/*`，任何本地路由选择都是服务端必拒的组合。profile v1 没有这两块时必须为 `null`，UI 退回“三个方向都可选”。未导入 profile 时 `profileSummary` 必须为 `null`；`profileImported` 为 `true` 时必须为对象。
- `jobs`: 已保存任务的展示安全摘要；该数组供客户端 UI 预填和展示，不是同步执行 DTO。每项可以包含用户可编辑字段和非敏感派生字段，例如 `id`、`name`、`localPath`、`direction`、`remoteFolder`、`serverSpace`、`transfers`、`streams`、`dryRun`、`destructiveSync`、`bandwidthLimit`、`schedule`、`checkers`、`s3UploadConcurrency`、`s3ChunkSize`、`cutoff`、`retries`、`lowLevelRetries`、`localProxyPort`、`bucketName`、`remoteName` 和 `remotePrefix`；不得包含 `accessKeyId`、`secretAccessKey`、`s3SecretAccessKey`、`heartbeatSecret`、`heartbeatAuthNonces`、`vlessUri`、SyncKey、claim code、token 或完整 profile。同步预览/运行继续由本地运行时读取水合 job/profile 后生成执行配置；`GET /api/jobs` 也返回同类展示安全摘要。
- `scheduler`: 本地计划任务运行摘要，包含 `enabled`、`intervalMs`、`updatedAt`、`nextRun`、`lastTriggeredAt`、`lastError` 和每个非手动任务的 `jobs[]` 摘要。`scheduler.enabled` 必须是布尔值，`scheduler.intervalMs` 必须是非负整数；`scheduler.updatedAt`、`scheduler.nextRun` 和 `scheduler.lastTriggeredAt` 必须为 `null` 或字符串。`scheduler.lastError` 和 `scheduler.jobs[].lastError` 必须为空字符串或稳定 snake_case 错误码；`scheduler.jobs[]` 中每项至少包含非空字符串 `id`、`name`、`scheduleText`、对象 `schedule`、`nextRun`、`lastTriggeredAt` 和 `lastError`。
- `processes.singbox` / `processes.sync`: 本地进程状态，`processes.singbox.name` 必须为 `sing-box`，`processes.sync.name` 必须为 `rclone-sync`；每个进程摘要至少包含 `name`、`running`、`pid`、`startedAt` 和 `lastExit`，其中 `running` 必须是布尔值，未运行时 `pid` 必须为 `null`。`processes.sync.metrics` 包含当前同步进度，`processes.sync.metrics.syncState` 必须为 `idle`、`syncing`、`error`、`stopping` 或 `offline`。客户端页面顶部状态、body 状态 class、进度区和停止中样式必须以 `processes.sync.metrics.syncState` 为当前状态来源；`processes.sync.running` 只能辅助判断同步中，不能覆盖 `stopping` 或 `error`。
- `processes.dataSingbox`: SFTP 数据专用 sing-box 进程摘要，精确名称为 `sftp-data-sing-box`，字段合同与 `processes.singbox` 相同；其 loopback SOCKS 端口必须与该次 rclone `ALL_PROXY` 端口一致。
- `heartbeat`: 最近一次服务端心跳结果，未配置或尚未上报时必须为 `null`；存在时必须遵守心跳摘要合同。`heartbeat.ok` 必须是布尔值；成功心跳必须包含 `serverDiagnostics`、`compatibility` 和脱敏 `device` 快照；失败心跳必须包含稳定 `errorCode: "heartbeat_failed"`；仅当服务端返回共享稳定错误码时，才可包含服务端 `remoteErrorCode`。
- `lastSuccessfulHeartbeat`: 最近一次成功服务端心跳结果，未成功上报过时必须为 `null`；存在时必须遵守成功心跳摘要合同，且必须保留 `compatibility` 供客户端 UI 和本地写接口执行兼容性确认。失败心跳不得覆盖该字段；客户端重启后必须从 `data/last-successful-heartbeat.json` 恢复该字段，导入新 profile 后必须删除该持久化快照。
- `syncHistory`: 最近 20 次同步运行记录。
- `lastSync`: `syncHistory[0]` 或 `null`。
- `safeguards.localState.files`: 精确包含 `profile`、`jobs`、`secrets`、`syncHistory`、`syncRecovery`、`claimRecovery`、`lastSuccessfulHeartbeat` 七项；各项含 `exists` 和 `ok`，损坏时使用 `local_state_corrupt`。`syncRecovery.path` 指向恢复状态目录摘要，覆盖 legacy state 和关系独立 manifest。
- `safeguards`: 本地安全边界状态，必须表明不启用 TUN、不修改系统代理、不修改路由、不修改 DNS，并给出 app-scoped rclone config 路径。`safeguards.tun`、`safeguards.systemProxy`、`safeguards.routeMutation` 和 `safeguards.dnsMutation` 必须固定为 `false`；`safeguards.rcloneConfigScope` 必须是指向 app-scoped `rclone.conf` 的非空字符串。

`safeguards.secretVault` 暴露本地密钥库健康摘要，包含后端、路径、引用数、缺失引用数量、`ok` 状态、`protected` 布尔值和 `protection` 保护摘要。公开 HTTP 状态和诊断包不得暴露真实 vault key，例如 `profile:...:storage.secretAccessKey` 或 `job:...:secretAccessKey:...`；`missingRefs` 只能保留与缺失数量一致的脱敏占位，UI 只依据数组长度展示“缺少几项”。当前 file backend 在 Windows 上必须在写入 `data/secrets.json` 后收紧当前用户 ACL；非 Windows 平台可报告 `mode: "not_applicable"`。即使密钥库缺失，`GET /api/client/status` 也应返回该摘要，并继续基于未水合的 profile/jobs 本地 JSON 返回 `profileImported: true`、`profileSummary` 和展示安全 `jobs[]`，方便用户确认当前设备状态并重新导入 SyncKey。

`safeguards.localState` 暴露客户端本地 JSON 状态文件健康摘要，覆盖 `profile.json`、`jobs.json`、`secrets.json`、`sync-history.json`、`sync-recovery.json`、`claim-recovery.json` 和 `last-successful-heartbeat.json`。若某个文件存在但不是合法 JSON，状态接口仍必须返回 200，并在对应文件项中标记 `ok: false`、`errorCode: "local_state_corrupt"`；损坏的 `sync-recovery.json`、`claim-recovery.json` 或 `last-successful-heartbeat.json` 也必须作为 `local_state_corrupt` 暴露。读取 profile/jobs 时应降级为空状态以保证设置页和诊断导出可打开。会修改状态的入口，例如 `/api/profile/import`、`/api/jobs/save` 和 `/api/sync/run`，不得在损坏的状态文件上继续写入或覆盖既有 profile/jobs/secrets/sync-history/sync-recovery/claim-recovery/last-successful-heartbeat，应返回 `409 local_state_corrupt`。

客户端设置抽屉必须可见展示 `diagnostics.protocols`、`diagnostics.buildId`、`diagnostics.buildTime`、`releaseManifest.version`、`releaseManifest.builtAt`、`releaseManifest.supportDocuments` 和 `releaseManifest.requiredFiles` 摘要，便于不用打开 JSON 即可判断客户端版本/协议和发布包批次。协议展示必须覆盖 `claim`、`profile`、`adminState`、`clientStatus` 和 `heartbeat`，避免 UI 只显示部分协议字段而掩盖双端漂移。

客户端本地运行时必须根据已保存 job 的 `schedule` 自动触发同步：`manual` 不触发；`interval` 到间隔后触发；`daily` 到指定本地时间后触发；`startup` 在客户端启动后触发一次。非手动风险计划只允许已签名授权且已初始化的 SFTP 双向 job；legacy S3 双向仍为手动兼容路径。每次自动运行均重新构造当前安全计划并校验授权、marker、初始化状态和删除阈值；过期、超限或需首次初始化时失败关闭。若已有同步正在运行，本轮计划不得并发启动第二个 rclone 进程；同步启动阶段也必须 single-flight，覆盖启动 sing-box、写入 rclone config、记录 sync history running 状态到 rclone 子进程启动之间的窗口，避免手动 `/api/sync/run` 和调度器同时启动两套 rclone。有限重试仅针对本工具 data sing-box 退出或已识别临时数据通道断线，最多 3 次且每次重新做安全计划；授权、root、marker、权限、host-key 等错误不可自动重试。调度失败应写入稳定错误码到 `scheduler.lastError`，不应破坏 `/api/client/status`。当自动调度触发时发现本地 secret vault 缺失，应记录 `secret_vault_missing` 到 `scheduler.lastError` 和对应 `scheduler.jobs[].lastError`，不得启动 rclone 进程、不得写入 app-scoped `rclone.conf`，也不得新增 `sync-history.json` 记录。

危险任务（双向任务和启用删除传播的镜像任务）只有在用户明确确认自动同步后才能保存 interval/daily/startup 计划。每次计划触发都必须重新生成针对当前已保存任务的短时安全计划，重新枚举根目录并校验目录 marker、可信 relation 与既有 bisync 基准；双向任务从当前 primary listing 估算可能传播的删除数量和比例，任一值超过任务 `safety.deleteLimit` 时本轮必须失败关闭。首次初始化仍须独立由用户确认，调度器不得自动执行 `--resync`。运行中的触发不排队重复同一任务，不并发启动第二个 rclone；实际失败必须保留稳定错误码到 `scheduler.lastError` 与对应 job 状态。

每轮已初始化的双向同步必须按 relation/baseline/root 绑定恢复 namespace 建立唯一 UUID run journal，检查本地与远端 owner marker、namespace 空间和 listing pair，持久化 `prepared` 后复核预检收据并写入 `running`，rclone 退出后持久化 `completed` 或 `failed`。进程崩溃留下的 `running` 记录在重启后必须被保留为可检查的未完成版本；确认没有同步进程后，后续同步可将其收束为 `failed` 并建立新的唯一 run，不能重置 identity、relation、目录 root 或 bisync baseline。准备阶段崩溃须从持久 journal 继续同一 run；未知内容、标记不符、根变化、listing 不可验证或恢复副本路径冲突都必须中止，不得清理未知内容或重建基准。

恢复客户端 API 的请求和响应字段是封闭合同：`POST /api/jobs/{jobId}/recovery/restore-preview` 只接受 `{runId,side,path,destinationPath}`；`POST .../restore` 和 `POST .../restore-cancel` 只接受 `{previewId}`。列表返回 `{jobId,versions:[{runId,createdAt,status,files:[{side,path}]}]}`；预览只返回 `previewId`、run/side/path、同步根内的相对目标、源 SHA-256 和过期时间，不返回绝对 source、暂存路径或 secret。还原必须基于当前短时预览、源 SHA-256 和排他创建；目标已存在时以 `sync_recovery_restore_target_exists` 拒绝，不得覆盖。

客户端心跳成功后，应保存服务端响应中的 `diagnostics` 为本地 `heartbeat.serverDiagnostics`，并保存设备摘要中的 `compatibility`。设置抽屉必须同时展示本机协议、服务端协议和兼容状态；服务端协议和兼容状态必须读取“当前成功 heartbeat，否则最近一次成功 heartbeat”的快照，当前心跳失败时仍应在心跳状态区展示失败，但不得让设置抽屉和本地写接口使用不同的兼容性来源。

客户端 smoke 必须覆盖 `/api/profile` 展示安全合同：未导入时校验 `{ profile: null }`；已导入时校验详细 profile 摘要包含 `summary`、`tunnel.type` / `tunnel.parsed`、`heartbeat.scheme` / `heartbeat.configured`、`storage` 和 `defaults`，且不得包含 `tunnel.uri`、`storage.accessKeyId`、`storage.secretAccessKey`、`heartbeat.secret`、SyncKey、claim code、token、完整 profile 或 VLESS URI。客户端 smoke 还必须默认覆盖 `/api/jobs` 展示安全合同：校验 `{ jobs: [...] }` 中每个 job summary，不得泄露水合密钥或导入凭据，并确认数量与 `/api/client/status.jobs` 一致。客户端 smoke 还必须覆盖 `/api/sync/history` 的 client sync history contract，校验 `{ history: [...] }` 中每条 sync run 摘要，并确认数量与 `/api/client/status.syncHistory` 一致。客户端 smoke 还必须覆盖 `/api/logs` 的 client logs contract 和 `/api/diagnostics/export` 的 diagnostic export contract，确认脱敏日志和诊断包可用于现场支持。客户端 smoke 还必须覆盖 client heartbeat device summary contract：当 `heartbeat.ok === true` 时，必须校验 `heartbeat.serverDiagnostics`、`heartbeat.compatibility.policy`、脱敏 `heartbeat.device`、`heartbeat.device.syncState === heartbeat.device.sync.state`、`heartbeat.device.speedMbps === heartbeat.device.sync.speedMbps`、同步冲突摘要、调度摘要和最近运行摘要；当 `heartbeat.ok === false` 时，必须校验 `heartbeat.errorCode === "heartbeat_failed"`，且可选 `remoteErrorCode` 必须是共享稳定错误码。任一字段漂移都视为客户端本地状态协议失败。

`GET /api/sync/history` 返回最近 20 次同步运行记录，用于客户端 UI 展示最近结果和设置页同步历史列表。

客户端读取 `sync-history.json` 时必须按共享 `normalizeSyncRun` 合同规范化历史记录，并只返回该合同登记的展示安全字段；未知扩展字段、`lastExit` 运行细节、`secretAccessKey`、SyncKey、导入 URI、VLESS URI、profile 或调试对象不得透传到 `GET /api/sync/history` 或 `GET /api/client/status.syncHistory`。旧版本或手工损坏的单条记录不能导致 `GET /api/client/status` 或 `GET /api/sync/history` 整体失败；无法安全修复的记录应跳过，非法远端路径字段应清空。

该响应是 client sync history contract。`GET /api/sync/history` 响应：

```json
{
  "history": [
    {
      "id": "sync-1783123456789",
      "status": "success",
      "startedAt": "2026-07-03T10:00:00.000Z",
      "finishedAt": "2026-07-03T10:05:00.000Z",
      "job": {
        "name": "folder-sync",
        "direction": "upload"
      },
      "localPath": "D:\\Work",
      "progressPercent": 100,
      "transferredSizeText": "1 GiB / 1 GiB",
      "currentFile": "projects/video.iso",
      "rawSpeed": "8 MiB/s",
      "conflicts": {
        "count": 0,
        "files": [],
        "truncated": false
      },
      "exitCode": 0,
      "errorCode": "",
      "error": ""
    }
  ]
}
```

`status` 取值为 `running`、`success`、`error`、`stopped` 或 `unknown`。只有 `status: "error"` 可以携带非空 `errorCode` 和 `error`；`running`、`success`、`stopped` 和 `unknown` 必须返回空字符串，尤其是用户主动停止后的 `stopped` 记录不得在顶层或嵌套字段中暴露 `rclone_sync_failed`。客户端同步历史筛选器必须暴露全部同步运行状态 `running`、`success`、`error`、`stopped`、`unknown`，并额外保留 `conflict` 冲突筛选。客户端 UI 必须兼容缺失的传输统计字段。

## 6. 同步运行约束

客户端使用 profile 生成 rclone job：

- 上传/下载默认使用 `rclone copy`
- 显式启用 `destructiveSync` 时使用 `rclone sync`
- 双向使用 `rclone bisync`
- 代理只通过 rclone 进程环境变量注入
- rclone 配置写入客户端便携目录 `data/runtime/rclone.conf`
- `bandwidthLimit` 为 `"off"` 时不传 `--bwlimit`，为 `"500k"`、`"10M"`、`"1G"` 或 `"08:00,10M 18:00,off"` 等值时追加 `--bwlimit {value}`
- `/api/sync/preview` 返回的真实执行 `args` 可供客户端运行链路使用，但不得包含 S3 secret；secret 只经 `env` 注入，给 UI 展示的 `displayCommand` 必须脱敏。

客户端 UI 约束：

- `destructiveSync` 只在高级参数区展示。
- 开启 `destructiveSync` 时必须页面内二次确认。
- 保存或启动带 `destructiveSync: true` 的任务前必须再次确认；本地 `/api/jobs/save` 和 `/api/sync/run` 必须强制校验顶层 `confirmDestructiveSync: true`，不能只依赖页面弹窗。
- 同步方向为 `bidirectional` 时必须禁用 `destructiveSync`；客户端本地 API 和 rclone preview 也必须强制把该组合归一化为 `destructiveSync: false`。
- `bandwidthLimit` 只在高级参数区展示，必须使用开关、模式选择、正整数输入、单位选择和时间输入，不使用自由文本输入。
- 客户端 UI 未展示的 profile defaults 不得在保存任务时丢失；`/api/jobs/save` 和 `/api/sync/preview` 必须先用导入 profile 归一化 job。

必须保持的安全约束：

- 不启用 TUN
- 不修改系统代理
- 不修改系统路由
- 不修改 DNS
- 不修改防火墙

## 7. 回归测试

协议合同测试位于：

```text
tests/contract-http.test.js
tests/client-http.test.js
tests/core.test.js
```

测试覆盖：

- 服务端真实 HTTP 创建 SyncKey
- 客户端使用 SyncKey 兑换 profile，并用 `clientRedeemId` / `clientInstallId` 覆盖同一客户端绑定的短时绑定重放
- 真实服务端签发 SyncKey 后，真实客户端本地 `/api/profile/import`、`/api/jobs/save` 和 `/api/sync/preview` 端到端继承 profile 的 storage、tunnel 和 defaults
- 已兑换 SyncKey 再次兑换返回 `claim_already_used`
- 客户端导入未完成时保留 `claim-recovery.json` pending recovery stash，重试时复用绑定并在成功持久化后清理
- 客户端 profile 字段和默认同步参数保持一致
- 客户端导入 profile 后，保存 UI 最小 job 时继承未展示的 defaults
- 服务端接收设备心跳并在设备摘要中显示同步状态
- 客户端离线时活状态整体归未知（`tests/client-live-state.test.js`）：隧道/同步/配置/心跳四盏 pill 与健康行都不得保留上次成功轮询的值，未知使用中性配色而非错误色；版本与安装路径等观测到的配置事实必须保留；事件的存活期不得超过它所描述的状态
