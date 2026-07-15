# 5-10 人小范围试点验收标准

本文定义试点是否可以从 5-10 人继续扩大范围。不得在验收记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key。

## 1. 验收范围

验收对象是同一批 release bundle、桌面包、便携包、当前试用服务端状态和试点运营流程。当前准入基线：

- 最新 strict preflight 中的全量测试通过，且 `releaseOk=true`、`failed=0`、`skipped=0`。
- release bundle SHA256：以 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip.sha256` 和 `reports/internal-trial/internal-trial-record.json` 为准。
- 公网 Beta：以 `reports/beta-host/beta-candidate-baseline.json` 为准，要求服务端 build ID、bundle build ID 和双客户端包 build ID 一致；N1 仅作为历史测试环境回退证据。
- internal trial assistant：`ready-for-human-review`。

## 2. 量化通过指标

试点结束时必须同时满足：

- 参与者规模：5-10 人，其中至少 5 人完成首次启动、导入、预览和一次真实小文件同步。
- 安装成功率：>= 90%，失败用户必须有明确错误码或环境原因。
- 首次同步成功率：>= 90%，且没有误同步到非试点前缀。
- 每日健康：连续 3 个工作日当前试用服务端 health 正常，`restartRequired=false`。
- 心跳稳定：active 参与者最近 24 小时内至少 90% 有成功心跳。每日健康和心跳稳定必须写入 `reports/pilot/<cohortId>/pilot-daily-health.json`，且 `pilot:summary` 的 `dailyHealth.ready` 必须为 `true`。
- 诊断可用：100% P1/P2 问题能导出脱敏诊断包，并在参与者记录的 issue 中填写 `diagnosticArtifact`；缺少该字段会被 `pilot:summary` 阻断。
- 隐私：0 起 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或 SSH key 泄露。
- 数据安全：0 起非试点目录误删、非试点前缀误写、无法停止的持续同步。
- 支持响应：P1 首响 <= 2 小时，P2 首响 <= 1 个工作日；参与者记录中的 P1/P2 issue 必须填写 `issueStartedAt` 和 `firstResponseAt`，`pilot:summary` 会自动计算 `supportResponseBreaches`。
- 回滚演练：至少 1 次客户端回滚或升级演练有结构化记录；如未触发真实回滚，需完成桌面包替换演练。参与者记录的 `rollbackDrill` 必须包含 `performed=true`、包类型、回滚/升级前后版本、`dataBackupConfirmed=true`、验证 artifact、恢复时间和负责人。

## 3. 分级问题标准

- P0：密钥或隐私泄露、误删/误写非试点数据、客户端无法停止同步、服务端管理接口失控、当前试用服务端无法恢复。
- P1：2 人及以上无法导入或同步、同一稳定错误码阻断核心路径、诊断包无法导出、升级后回滚失败。
- P2：单人安装/导入/同步失败但可恢复、UI 状态不清晰、速度/进度展示异常、支持流程缺字段。
- P3：文字、易用性或低频兼容问题。

通过要求：

- P0 必须为 0。
- 未关闭 P1 必须为 0。
- 未关闭 P2 不超过 3 个，且都有负责人、规避方案和后续修复计划。

## 4. 功能验收

每名计入通过的参与者必须完成：

- 校验 ZIP SHA256。
- 启动桌面包或便携包，确认 `releaseManifest.ok: true`。
- 导入一次性 SyncKey，并确认重复导入失败行为可理解。
- 选择本地目录，保存上传或镜像上传任务。
- 运行预览并确认不会写入远端。
- 完成一次真实小文件同步，并由管理员在参与者记录的 `syncEvidence` 中确认文件进入本轮专用前缀；`actualRemoteFolderConfirmed` 必须等于该参与者的 `expectedRemoteFolder`，并填写前缀检查 artifact 和检查时间。
- 停止或退出客户端后重启，确认 profile、任务和最近历史仍可读。
- 导出诊断包并完成敏感内容抽检。

## 5. 运营验收

试点负责人必须能提供：

- 参与者名册，字段符合 `docs/PILOT_RUNBOOK.md`。
- 分批 rollout 记录和每批放行时间。
- 每日检查记录，至少覆盖 3 个工作日或试点实际运行周期。
- `pilot-daily-health.json` 至少 3 条完整记录，包含日期、检查人、检查时间、服务端 health、候选基线证据、`restartRequired`、`finalRestartClear`、active 人数、24 小时成功心跳数、P1/P2 数量、诊断抽检 artifact 和对象存储前缀抽检 artifact。
- 支持单汇总，包含问题等级、状态、根因、处理时长和是否需要修复。
- 升级、回滚、暂停决策记录；未触发时需明确写“未触发”。计入放行的回滚演练必须能在 `pilot-summary.json.metrics.completedRollbackDrills[]` 中复核。
- 试点结束清理记录。
- `pnpm run pilot:summary -- --cohort-dir reports/pilot/<cohortId>` 输出的 `pilot-summary.json`，且扩大发布前 recommendation 应为 `ready-for-pilot-signoff`。

## 6. 放行结论

结论只能取以下之一：

- `expand`：满足全部量化指标，允许扩大到下一批用户。
- `extend`：核心路径可用，但样本量、天数或 P2 处理不足，需要延长 2-5 个工作日。
- `pause`：存在 P0/P1 或隐私/数据安全疑虑，暂停扩大并进入修复。
- `rollback`：当前包不适合继续试点，回滚到上一稳定交付物。
