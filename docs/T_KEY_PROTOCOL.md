# SyncKey 协议说明

## 1. 目标

SyncKey 用于让客户端一次性领取完整同步配置。用户只需要粘贴 SyncKey，不需要手动填写 VLESS、S3 endpoint、bucket、access key 或同步参数。

## 2. 编码格式

```text
SFSC1-{base64url(json)}
```

也兼容 URI 形式：

```text
sfsc://import/v1#{base64url(json)}
```

## 3. SyncKey JSON

```json
{
  "version": 1,
  "type": "claim",
  "server": "https://pass.971223.xyz:2025",
  "code": "DVCS-VRS8"
}
```

字段：

- `version`: 固定为 `1`
- `type`: 固定为 `claim`
- `server`: SyncKey 解析服务地址
- `code`: 一次性兑换码。新生成短码必须使用 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 字符集，形态为 `AAAA-AAAA`，不得包含易混字符 `0`、`1`、`I` 或 `O`。兑换解析仍兼容历史 `[A-Z0-9]{4}-[A-Z0-9]{4}` 短码。

## 4. 客户端兑换流程

客户端解码 SyncKey 后请求：

```http
POST {server}/api/claims/redeem
Content-Type: application/json
```

新客户端请求体：

```json
{
  "code": "DVCS-VRS8",
  "clientRedeemId": "8a7d25f7-19e0-4a8c-9d9f-efc0c2c61010",
  "clientInstallId": "b9e558e2-4b86-47f9-8e20-d08f0d9dc6b3"
}
```

`clientRedeemId` 标识一次导入尝试，`clientInstallId` 标识本机安装。两者都不写入 SyncKey 本体，而是在客户端兑换前生成并保存在本机恢复状态中。服务端用这两个字段判断同一客户端绑定，支持导入未完成后的短时绑定重放。

旧客户端也兼容只发送短码：

```json
{
  "code": "DVCS-VRS8"
}
```

历史调试入口还兼容 `tKey` 字段；`tKey` 可以传完整 `SFSC1-...`，也可以传短码 `DVCS-VRS8`。新客户端和第三方实现应优先使用 `code` 表示短码，避免把完整 SyncKey 与一次性短码混用。

客户端在远端兑换前必须写入 `data/claim-recovery.json` pending recovery stash。该文件表示当前导入未完成，只保存 server/code 摘要和绑定，例如 `claim: { server, codeHash }`、`clientRedeemId`、`clientInstallId`、`createdAt`、`updatedAt`；不得保存完整 SyncKey、不得保存一次性短码、不得保存 profile、VLESS URI、S3 secret 或 heartbeat secret。若用户重试同一个 SyncKey，客户端用新输入计算同一 server/code 摘要并复用已有 `clientRedeemId` 和 `clientInstallId`；若摘要不同，则生成新的绑定。服务端兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用，校验 claim 创建时的 profile 下发材料仍与当前可签发材料一致，并拒绝已过期的 profile；若设备、bucket、下发材料或 profile 过期已失效，服务端返回 `validation_failed` 且不得把 SyncKey 标记为 used。同一来源和同一 code 摘要连续失败过多时，服务端返回 `429 claim_redeem_rate_limited`，不得泄露短码原文、不得消耗 SyncKey。兑换成功后若本地 profile/jobs/secrets/scheduler 任一步提交失败，客户端必须回滚导入前 profile/jobs/secrets 状态，并继续保留该 pending recovery stash 供同一 SyncKey 重试。远端 redeem 失败只透传合同登记的结构化错误码：`claim_not_found`、`claim_already_used`、`claim_expired`、`claim_redeem_rate_limited`、`server_state_write_failed`、`validation_failed`；未登记错误码、非结构化失败、无 HTTP 响应，以及 HTTP 2xx 但不是 JSON/profile 对象、返回 `ok:false` 的坏成功响应统一降级为 `claim_redeem_failed`，其中收到远端 HTTP 响应时保留 status，无 HTTP 响应使用 502。

## 5. 服务端返回 Profile

```json
{
  "version": 1,
  "profileId": "profile-company-pc1",
  "clientName": "company-pc1",
  "tunnel": {
    "type": "vless",
    "uri": "vless://..."
  },
  "heartbeat": {
    "scheme": "sfsc-hmac-sha256-v1",
    "secret": "heartbeat-secret"
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

正式 SyncKey 兑换返回的 profile 必须同时包含 `heartbeat.scheme: "sfsc-hmac-sha256-v1"`、非空 `heartbeat.secret`，以及完整 storage credentials：`storage.remoteName`、`storage.endpoint`、`storage.bucket`、`storage.accessKeyId`、`storage.secretAccessKey` 和 `storage.prefix`。客户端缺少心跳材料时返回 `profile_heartbeat_required`，缺少存储凭据或必要存储字段时返回 `profile_storage_required`，不得用 `CHANGE_ME_CLIENT_SECRET` 等占位值把不完整的服务端 profile 保存成正式导入状态。

`defaults.bandwidthLimit` 的合法值为 `"off"`、正整数加单位：`"500k"`、`"10M"`、`"1G"`，或客户端生成的两段式时间表：`"08:00,10M 18:00,off"`。客户端展示为带宽限制开关、模式选择、数值输入、KB/s/MB/s/GB/s 单位选择和时间输入，保存和运行时再转换为 rclone `--bwlimit` 字符串。

`defaults.schedule` 的合法模式为：

- `{ "mode": "manual" }`
- `{ "mode": "interval", "intervalMinutes": 30 }`
- `{ "mode": "daily", "time": "02:00" }`
- `{ "mode": "startup" }`

当前客户端主界面暴露手动、每隔 N 分钟、每天 HH:MM 和启动时一次性触发；服务端控制台默认同步策略不暴露 `startup` 给批量下发，但完整 profile/defaults 合同保留该字段。

客户端导入 profile 后，`defaults` 是本地 job 的兜底配置。当前客户端 UI 可以省略 `checkers`、`chunkSize`、`retries`、`lowLevelRetries`、`localProxyPort` 等底层字段，但 `/api/jobs/save`、`/api/sync/preview` 和 `/api/sync/run` 必须先用导入 profile 归一化，确保这些 defaults 不会被硬编码默认值覆盖。

服务端 `/api/claims/create` 支持完整 `defaults`；当前服务端控制台只暴露常用默认项：`transfers`、`streams`、`checkers`、`chunkSize` 和 `schedule`，未暴露项继续使用服务端状态或环境变量默认值。

## 6. 一次性语义与短时绑定重放

服务端保存 SyncKey 状态：

- 未使用：可以兑换
- 已使用且仍在 `claim.replayUntil` 前：同一客户端绑定可以重放并拿回同一份 profile
- 已使用但请求来自不同客户端、缺失绑定或超过 `claim.replayUntil`：返回 `claim_already_used`
- 过期：返回 `claim_expired`
- 不存在：返回 `claim_not_found`
- 设备、bucket 或 profile 下发材料漂移：返回 `validation_failed`，其中下发材料漂移的消息为 `SyncKey claim profile is stale; regenerate SyncKey`
- profile `expiresAt` 已过期：返回 `validation_failed`，消息为 `SyncKey claim profile is expired; regenerate SyncKey`

首次成功兑换时，如果请求包含 `clientRedeemId` 和 `clientInstallId`，服务端必须记录：

- `claim.redeemedBy.clientRedeemId`
- `claim.redeemedBy.clientInstallIdHash`
- `claim.redeemedBy.firstRedeemedAt`
- `claim.replayUntil`

`clientInstallIdHash` 是 `clientInstallId` 的哈希，服务端不得在管理摘要或日志中保存原始 `clientInstallId`。重放判断必须同时匹配 `clientRedeemId` 和 `clientInstallIdHash`，否则视为不同客户端并返回 `409 claim_already_used`。首次兑换未带完整绑定的旧客户端仍保持一次性语义，后续重复兑换都返回 `claim_already_used`。

客户端兑换成功后保存完整 profile、刷新 jobs 和 scheduler，并把真实密钥写入本地 secret vault。只有 profile、jobs、scheduler 和 secrets 都成功持久化后，才能清理 `claim-recovery.json`。如果远端返回终态结构化错误 `claim_not_found`、`claim_already_used`、`claim_expired` 或 `validation_failed`，客户端应回滚本地状态并清理对应 pending recovery stash，因为同一个 SyncKey 无法通过重放恢复。若远端返回 `claim_redeem_rate_limited`，客户端应保留 pending recovery stash，提示等待限速窗口或重新生成 SyncKey，不得把本地状态当成导入成功。若远端成功但签发 profile 缺少必要材料并触发 `profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`，客户端也必须清理 pending recovery stash，并提示检查服务端配置后重新生成 SyncKey。若网络中断、请求超时、远端无结构化错误、未登记错误码、远端 `server_state_write_failed`、HTTP 2xx 但响应不是 JSON/profile 对象、返回 `ok:false`，或本地 job/scheduler/secret/profile/jobs 持久化失败，客户端应保留 pending recovery stash；其中网络、超时、未登记、非结构化远端失败和坏成功响应统一使用 `claim_redeem_failed`。客户端不得保存一次性短码，只能保存导入后的 profile 摘要、来源 server 和必要的本地运行字段。

## 7. 命名说明

代码内部仍保留 `claim` 命名，以保持协议兼容；产品界面和文档统一称为 `SyncKey`。
