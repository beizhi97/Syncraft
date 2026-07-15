# 5-10 人小范围试点 Runbook

本文用于内部 trial 通过后，把 Syncraft 扩展到 5-10 名真实参与者的小范围试点。试点只验证产品化交付、支持和运营流程；不得在本文或试点记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key。

## 1. 准入门禁

试点开始前必须同时满足：

- 最新 strict preflight 中的全量 Node 测试通过，且 `releaseOk=true`、`failed=0`、`skipped=0`。
- 严格 `pnpm run preflight:release` 通过，`reports/release/preflight.json` 中 `releaseOk: true`、`failed: 0`、`skipped: 0`。
- 桌面包和便携包 ZIP、`.sha256`、`release-manifest.json` 齐全，并通过客户端 package smoke。
- 最新 release bundle SHA256 已按 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip.sha256` 记录。
- 当前试用服务端基线必须与 release bundle 使用同一构建 ID，且有当次 HTTPS server smoke、真实客户端同步报告和 `restartRequired=false` 证据；公网 Beta 使用 `reports/beta-host/beta-candidate-baseline.json`，N1 仅作为旧测试环境回退证据。
- internal trial assistant 状态为 `ready-for-human-review`，人工清单无阻断项。
- 已指定试点负责人、支持联系人、回滚负责人和每日检查窗口。

## 2. 参与者名册字段

名册只保存运营所需摘要，不保存任何密钥或完整导入 URI。建议字段：

- participantId：试点编号，例如 `pilot-001`。
- displayName：参与者姓名或内部昵称。
- contact：企业微信、电话或邮箱。
- cohort：批次，取值 `A`、`B`、`C`。
- windowsVersion：Windows 版本和架构。
- packageType：`desktop` 或 `portable`。
- packageSha256Verified：是否已核对 ZIP SHA256。
- assignedAt / installedAt / firstSyncAt：关键时间。
- dataScope：试点目录用途摘要，不写真实敏感路径内容。
- remotePrefixAlias：远端前缀别名，不写真实 secret。
- status：`invited`、`installed`、`active`、`paused`、`rolled_back`、`completed`。
- lastCheckAt：最近一次每日检查时间。
- supportTicketIds：关联支持单编号。
- cleanupConfirmed：试点结束后是否清理。

可以用工具生成批次名册、每人命令单和记录模板：

```powershell
pnpm run pilot:prepare -- --cohort-id pilot-202607 --server-base-url https://sync.example.com --participant pilot-001:Alice:PC-A --participant pilot-002:Bob:PC-B
```

该命令输出 `reports/pilot/<cohortId>/pilot-wave.json`、批次命令单、每位参与者的 `participant-record.json` 和个人命令单；文件只包含路径、状态、命令模板和哈希，不保存真实 SyncKey 或导入 URI。
同时会生成 `reports/pilot/<cohortId>/pilot-daily-health.json`，用于记录连续每日健康检查；扩大发布前至少 3 条完整记录必须达标。
试点生成器只接受 HTTPS 服务地址；内部 N1 排障如确有必要可显式传 `--allow-insecure-server-base-url`，但该批次不得作为 Beta 参与者名册。

## 3. 分批 rollout

按三批推进，每批之间至少观察 1 个完整工作日：

- A 批：2 人，优先选择技术熟悉、可快速反馈的用户。只开启桌面包。
- B 批：3-4 人，在 A 批 24 小时无 P0/P1 后加入；允许 1 名便携包兼容抽检用户。
- C 批：剩余 3-4 人，在累计 5 人稳定 48 小时后加入。

每批开始前检查：

- 本批参与者已收到 SHA256 校验步骤和支持入口。
- 每名参与者使用独立本地测试目录和独立远端前缀。
- 每名参与者使用独立一次性 SyncKey，由负责人现场生成并一次性传递，不写入文档。
- 当批期间不得同时升级服务端、客户端和存储配置。

## 4. 每日检查

每日固定检查并记录摘要：

- 当前试用服务端 `/api/health`、候选基线和当次 server smoke 是否仍为正常。
- 管理控制台设备数、在线数、禁用数、`restartRequired` 状态。
- 每名 active 参与者最近一次心跳时间、最近一次同步状态、失败码和冲突数。
- 客户端设置页 `releaseManifest.ok`、协议兼容状态、组件状态和本地状态摘要。
- 支持单数量、未关闭 P1/P2 数量、重复问题类型。
- 诊断包抽检是否继续脱敏，不包含 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或 SSH key。
- 对象存储试点前缀中是否出现非本轮目录或明显误同步；完成首次真实同步的参与者必须在 `participant-record.json.syncEvidence` 中记录期望远端目录、实际确认目录、检查 artifact 和检查时间。

每日检查后运行汇总：

```powershell
pnpm run pilot:summary -- --cohort-dir reports/pilot/<cohortId>
```

汇总会计算安装、导入、带远端前缀确认的首次同步、诊断包通过率，检查 P0/P1、P2 上限和跟进字段、P1/P2 诊断 artifact、P1/P2 首响 SLA、重复稳定错误码、当前服务端候选基线、internal trial 和回滚演练门禁，并输出 `pilot-summary.json`。
`pilot:summary` 还会读取 `pilot-daily-health.json`，要求最近 3 条完整每日记录同时满足服务端 health 正常、候选基线证据正常、`restartRequired=false`、`finalRestartClear=true`、active 参与者 24 小时成功心跳率 >= 90%、P1=0、P2<=3，并填写诊断抽检 artifact、对象存储前缀抽检 artifact、检查人和检查时间。旧 N1 字段继续可读，但新记录应使用 `serverHealthOk` 和 `candidateBaselineOk`。

## 5. 升级、回滚和暂停规则

升级规则：

- 仅当修复 P0/P1 或试点负责人批准的 P2 问题时升级。
- 升级前重新生成客户端包、release bundle 和 SHA256，并跑严格 preflight。
- 服务端变更必须先在当前试用服务端完成同构建的部署、HTTPS server smoke 和真实客户端同步验证，再通知用户升级客户端。
- 每批升级不超过 2 人，观察 2 小时后再扩大。

回滚规则：

- 客户端问题优先回滚到上一版 ZIP，保留用户 `data/` 备份，不覆盖现场状态。
- 服务端问题使用部署指南中的服务端 rollback 流程，保留 `.env`、`server/data`、`server/sing-box`。
- 回滚后重新运行客户端 package smoke 或当前服务端 smoke，并在 `participant-record.json.rollbackDrill` 中记录包类型、回滚/升级前后版本、`dataBackupConfirmed=true`、验证 artifact、恢复时间和负责人；只有字段完整的演练才会被 `pilot:summary` 计入放行门禁。

暂停规则：

- 任一 P0 立即暂停新增参与者和新增 SyncKey。
- 同一根因 P1 影响 2 人及以上时暂停下一批 rollout。
- 出现疑似密钥泄露、误同步到非试点前缀、无法停止同步或诊断包脱敏失败时暂停全试点。
- 暂停期间只允许收集脱敏诊断、备份本地 `data/`、执行回滚或等待修复包。

## 6. 支持包

参与者遇到问题时，支持人员只收集：

- 参与者编号、批次、包类型和包 SHA256 是否核对。
- 问题发生时间、用户动作、稳定错误码、截图或简短录屏。
- 客户端设置页导出的脱敏诊断 JSON。
- 最近一次同步任务摘要：方向、远端前缀别名、文件数量级、是否停止/重启过。
- 当前试用服务端管理状态摘要和相关候选基线/smoke 报告路径。

不得收集或粘贴：

- 完整 SyncKey 或 `sfsc://` 导入 URI。
- 完整 VLESS URI。
- S3 access key、secret access key、heartbeat secret、管理 token。
- SSH 私钥内容或私钥文件内容。

## 7. 隐私

- 试点目录应使用非敏感样例文件或可公开测试资料。
- 名册不记录真实文件名清单；只记录文件数量级、大小级别和同步结果。
- 诊断包外发前搜索敏感关键词和真实 token 样式；发现疑似泄露即停止传播并升级为 P0。
- 试点记录保留最小必要信息，结束后只保留汇总指标和已脱敏问题单。

## 8. 试点结束清理

试点结束后逐项确认：

- 停止所有试点任务，并确认客户端不再运行计划同步。
- 禁用或清理试点设备和一次性 SyncKey 摘要，保留必要审计记录。
- 清理对象存储中的试点专用前缀；删除前由负责人二次确认。
- 参与者如继续使用，迁移到正式目录和正式支持流程；如不继续，删除解压目录或归档 `data/` 后卸载。
- 归档每日检查、验收指标、支持单和最终结论。
- 更新 `docs/PROJECT_HANDOFF.md` 中的后续优先事项和试点结论。
