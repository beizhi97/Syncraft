# 5-10 人小范围试点支持指南

本文供试点支持人员处理参与者问题。所有记录必须脱敏；不得写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key。

## 1. 支持入口

每个问题先建立支持单，最小字段：

- ticketId
- participantId
- cohort
- packageType
- packageSha256Verified
- issueStartedAt
- severity
- userAction
- stableErrorCode
- currentStatus
- owner
- nextAction
- diagnosticArtifact
- firstResponseAt
- artifacts

`diagnosticArtifact` 填写脱敏诊断 JSON 的路径；`artifacts` 只填写脱敏诊断包、截图、日志摘要或报告路径，不粘贴密钥原文。

试点负责人每天运行：

```powershell
pnpm run pilot:summary -- --cohort-dir reports/pilot/<cohortId>
```

支持单中的 `ticketId`、`severity`、`status`、稳定错误码、`issueStartedAt`、`firstResponseAt`、`owner`、`nextAction` 和 `diagnosticArtifact` 应同步回对应参与者的 `participant-record.json`，让汇总能及时发现 P0/P1、P2 跟进缺口、P1/P2 诊断缺口、首响超时和重复问题。

## 2. 首问脚本

先问并记录：

- 使用桌面包还是便携包？
- 是否核对 ZIP SHA256？
- 问题发生在安装、首次启动、导入、保存任务、预览、同步、停止、重启还是诊断导出？
- 页面是否显示稳定错误码？
- 是否可以导出诊断包？
- 是否正在运行同步；如果正在运行，是否能点击停止？
- 本地目录是否为试点目录，远端是否为本轮专用前缀？

不要要求用户发送完整 SyncKey、完整导入 URI、完整 VLESS URI 或任何 secret。

## 3. 分流处理

安装或启动失败：

- 核对 SHA256、解压目录是否可写、是否从 ZIP 内直接运行。
- 检查是否有旧 `Syncraft.exe`、`node.exe`、`sing-box.exe`、`rclone.exe` 占用。
- 端口占用应记录 `client_port_in_use` 和 Electron main 日志路径。

导入失败：

- 确认 SyncKey 是本轮新生成、未过期、未被使用。
- 只记录 SyncKey SHA256 或长度摘要，不记录原文。
- 重复导入已使用 SyncKey 应记录稳定错误码，不能重新生成设备绑定。

预览或同步失败：

- 先要求用户停止同步或退出客户端。
- 收集任务方向、远端前缀别名、文件数量级和错误码。
- 确认预览输出、rclone 命令展示和诊断包均未包含 S3 secret。

诊断包问题：

- 导出失败列为 P1 或 P2，取决于是否阻断核心路径。
- 如果诊断包疑似包含 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或 SSH key，立即升级 P0 并停止传播该文件。

## 4. 升级、回滚、暂停

升级给工程负责人：

- P0 立即升级。
- P1 在 2 小时内首响并升级；P2 在 1 个工作日内首响。
- 同一错误码出现 2 人及以上，升级并暂停下一批 rollout。
- 需要服务端变更、客户端重打包或数据清理时升级。

回滚建议：

- 客户端回滚前备份 `data/`，再替换为上一版 ZIP；不要用新包空 `data/` 覆盖现场状态。
- 服务端回滚按 `docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md` 的 N1 rollback 流程执行。
- 回滚后必须重新确认 `releaseManifest.ok` 或 N1 `restartRequired=false`。

暂停建议：

- 发现隐私泄露、误同步、无法停止同步或 N1 状态异常时暂停全试点。
- 暂停期间不生成新的 SyncKey，不邀请新参与者。

## 5. 支持包内容

支持包应包含：

- 支持单摘要。
- 脱敏诊断 JSON。
- 截图或录屏。
- 客户端包 SHA256 是否核对。
- N1 run id 或 post-deploy summary 路径。
- 复现步骤。
- 已尝试的操作和结果。

支持包不得包含：

- SyncKey 原文或 `sfsc://` 导入 URI。
- 完整 VLESS URI。
- S3 secret、heartbeat secret、管理 token。
- SSH 私钥内容。
- 用户真实敏感文件内容。

## 6. 关闭标准

支持单关闭前确认：

- 用户核心路径恢复，或已回滚/暂停并告知。
- 诊断包已脱敏。
- 如涉及服务端或对象存储，管理员确认试点前缀状态正确。
- 如涉及隐私或误同步，已完成 P0 复盘和试点负责人确认。
- 名册中的 `status`、`lastCheckAt`、`supportTicketIds` 已更新。
