# 内部 beta E2E 检查清单

本文用于干净 Windows 机器或干净用户目录上的人工端到端验收。它补充自动化 `preflight:release`、客户端包 smoke 和 N1 release acceptance；只有自动化门禁通过且本文关键路径通过，才建议发给内部用户继续扩大范围。

## 1. 验收输入

每次执行前记录：

- release bundle：`dist/release-bundles/singbox-folder-sync-<version>-release.zip`
- Windows 桌面包：`dist/SyncraftDesktop.zip`
- 便携包：`dist/SyncraftClient.zip`
- N1 验收报告：`reports/n1/<run-id>/post-deploy-summary.json`
- 服务端地址：例如 `http://192.168.1.254:5177` 或现场反代 HTTPS 地址
- 管理员在服务端控制台生成的一次性 SyncKey
- 测试本地目录：一个新建的空目录，路径中建议包含中文和空格，例如 `%USERPROFILE%\Desktop\SFSC 测试 A`
- 远端测试 bucket/前缀：只用于本轮验收，不复用生产目录

## 2. 发布证据检查

在交付机器或构建机确认：

```powershell
pnpm run preflight:release
```

生成本轮人工验收记录模板：

```powershell
pnpm run trial:record
```

生成半自动验收助手报告，汇总自动化证据、提示每个章节还需要人工确认的动作：

```powershell
pnpm run trial:assist
```

`trial:assist` 只生成 `reports/internal-trial/internal-trial-assistant.json`，不会修改 `internal-trial-record.json`，也不会把任何人工章节标记为通过。它会核对记录中的 release bundle、桌面/便携包 SHA256 与版本、以及 N1 run 是否仍对应当前交付；任一漂移都会阻止 `ready-for-human-review`。最终 `sections[].status` 仍必须由测试者根据真实 Windows/N1 操作手工填写。

生成本轮真实试跑命令单和样例文件：

```powershell
pnpm run trial:prepare -- --tester "<执行人>" --local-path "$env:USERPROFILE\Desktop\SFSC 测试 A" --remote-folder "internal-trial-001"
```

`trial:prepare` 会写入 `reports/internal-trial/internal-trial-command-sheet.md` 和 `.json`，并在指定本地目录下创建 3 个小样例文件，其中包含中文和空格文件名。它不读取、不保存、不打印真实 SyncKey；命令单只包含 `$env:SFSC_TRIAL_T_KEY="<完整 SyncKey>"` 占位符、profile preview、真实同步和停止/恢复抽检命令，便于测试者逐条执行。

在 N1 或目标服务端上为本轮内部试跑生成一次性 SyncKey 时，优先使用安全报告助手：

```powershell
$env:SFSC_ADMIN_TOKEN="<管理 token>"
pnpm run trial:create-t-key -- --base-url http://192.168.1.254:5177 --client-name "internal-trial-001" --expires-in-hours 2 --print-t-key
```

`trial:create-t-key` 调用服务端 `POST /api/claims/create`，写入 `reports/internal-trial/trial-t-key-report.json`。该报告只保存 SyncKey / SyncKey URI 的 SHA256、长度、claim 短码、过期时间和下一步命令，不保存管理 token、完整 SyncKey 或 `sfsc://` 导入 URI。完整 SyncKey 只有显式传 `--print-t-key` 时才会在终端打印一次，测试者应立即复制到 `$env:SFSC_TRIAL_T_KEY`，不要粘贴进记录 notes 或 artifact。

如果客户端已经在试用机器上启动，且管理员已经为本轮生成真实完整 SyncKey，可以用客户端执行助手串起本地 API 的导入、任务保存、预览、可选真实同步和诊断导出：

```powershell
$env:SFSC_TRIAL_T_KEY="<完整 SyncKey>"
pnpm run trial:client-runner -- --base-url http://127.0.0.1:5188 --local-path "<测试目录>" --remote-folder "internal-trial-001"
```

默认不会运行真实同步。若要让助手调用真实 `/api/sync/run`，必须显式加入：

```powershell
pnpm run trial:client-runner -- --base-url http://127.0.0.1:5188 --local-path "<测试目录>" --remote-folder "internal-trial-001" --run-sync --i-understand-real-sync
```

该脚本输出 `reports/internal-trial/client-trial-runner.json`，只记录 SyncKey 的 SHA256、长度和执行摘要，不写入 SyncKey 原文。真实同步后仍必须人工到对象存储或服务端控制台确认测试文件已进入本轮专用 bucket/prefix。

人工执行下列章节后，优先用记录命令更新 `reports/internal-trial/internal-trial-record.json`，避免手工 JSON 拼写错误或误写敏感内容：

```powershell
pnpm run trial:record:update -- --tester "<执行人>" --date "2026-07-08" --windows-version "<Windows 版本>" --machine "<机器名>"
pnpm run trial:record:update -- --section release-evidence --status passed --notes "SHA256、release bundle、N1 latest 已核对" --artifact reports/internal-trial/internal-trial-command-sheet.md
pnpm run trial:record:update -- --section t-key-profile --status failed --notes "真实 SyncKey 导入失败，错误码 claim_redeem_failed，见诊断包"
```

`trial:record:update` 只记录人工结论，不会自动把章节标记为通过；`passed` 必须带 `--notes` 或 `--artifact`，`failed` / `skipped` 必须带 `--notes`。notes 和 artifact 路径中若出现疑似 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或私钥内容，命令会拒绝写入。

确需手工编辑时，把对应 `sections[].status` 从 `pending` 改为 `passed`、`failed` 或 `skipped`，并填写必要 notes/artifacts。完成后校验记录：

```powershell
pnpm run trial:record:verify
```

通过条件：

- `reports/release/preflight.json` 中 `releaseOk: true`
- `summary.failed == 0`
- `summary.skipped == 0`
- `clientPackageSmokeReports[]` 同时包含 desktop 和 portable，且 `ok: true`
- 最近 N1 `post-deploy-summary.json` 中 `ok: true`
- N1 `acceptance.releaseAcceptance.releaseBundleVerified: true`
- N1 `acceptance.releaseAcceptance.clientRealSyncVerified: true`
- N1 `acceptance.releaseAcceptance.ssdObjectVerified: true`
- N1 `acceptance.releaseAcceptance.testDataCleanupVerified: true`
- N1 `acceptance.releaseAcceptance.restartRequired: false`
- N1 `acceptance.target.targetHostsMatch: true`
- `trial:record:verify` 在所有必填人工章节完成后通过；如果仍有 `pending`，不能作为扩大内部用户范围的通过证据。

## 3. 安装与首次启动

在干净 Windows 环境执行：

1. 校验 ZIP：用 `Get-FileHash <zip> -Algorithm SHA256` 与 `.sha256` 首列比对。
2. 解压 `SyncraftDesktop.zip` 到用户可写、非临时目录，例如 `%LOCALAPPDATA%\Syncraft\`。
3. 启动 `SyncraftDesktop\Syncraft.exe`。
4. 打开设置页，确认本机版本、协议版本、发布 manifest 和内置组件状态可见。
5. 如果端口被占用或启动失败，记录页面错误、客户端日志和 Windows 进程列表，不要直接删除 `data/` 后重试。

通过条件：

- 客户端主窗口能打开；如果本地服务启动失败，则必须显示启动失败窗口，而不是静默退出。
- 启动失败窗口包含稳定错误码、目标端口和 Electron main 日志路径；端口占用应显示 `client_port_in_use`。
- `/api/client/status` 返回 `ok: true`。
- `releaseManifest.ok: true`。
- 组件摘要中 `sing-box` 和 `rclone` 可用。
- 首次启动未生成明文 SyncKey、VLESS URI 或 S3 secret 到页面展示区域。

可选自动化窗口 smoke：

```powershell
pnpm run smoke:electron-window
pnpm run smoke:electron-e2e
```

该 smoke 会启动桌面包真实 Electron 窗口，验证客户端 UI 加载、`window.sfscDesktop.pickFolder` 原生目录选择桥存在、设置抽屉可打开、诊断导出按钮能触发脱敏 JSON 下载。它需要当前 Windows 桌面会话可创建窗口；无桌面会话或远程无图形环境中不作为 strict preflight 放行条件。

`smoke:electron-e2e` 会进一步用真实桌面包 UI 导入一份离线服务端 profile、填写临时本地目录、保存上传任务、生成 rclone preview；随后复制一份临时桌面包并用 fake sing-box/rclone 走 UI 开始同步、停止同步、同步历史和诊断 JSON 脱敏校验。它不连接 N1、不访问真实对象存储，也不替代本清单后续的真实 SyncKey 和小文件同步验收。

## 4. 导入 SyncKey 与 profile 检查

1. 在服务端控制台创建一条新的 SyncKey。
2. 在客户端设置页导入该 SyncKey。
3. 导入成功后刷新客户端状态。
4. 回到服务端控制台，确认新设备出现，设备名、协议诊断和兼容性状态可读。

通过条件：

- 客户端显示 profile 已导入。
- 重复导入已使用 SyncKey 时显示稳定错误，不产生新的设备绑定。
- 服务端设备摘要不泄露 storage secret、heartbeat secret、SyncKey 原文或完整 VLESS URI。
- 客户端 `data/profile.json` 和 `data/jobs.json` 中 secret 字段为 `secretRef`，真实值只在本地密钥库中。

## 5. 文件夹选择与任务保存

1. 新建本地测试目录，并放入 2 到 5 个小文件。
2. 用客户端目录选择器选择本地目录。
3. 在客户端任务表单里选择设备空间或共享空间，并把远端目录填写为本轮专用前缀，例如 `internal-trial-001`。
4. 保存一个上传任务，方向先选上传或镜像上传。
5. 如出现兼容性 warning 或破坏性同步确认，按 UI 要求输入确认文本。

通过条件：

- Electron 桌面包能返回完整本地路径。
- 非 Electron fallback 不伪造绝对路径，会要求人工粘贴完整路径。
- 保存任务 payload 包含 `remoteFolder` 和 `serverSpace`，预览中计算出的远端路径落在本轮专用前缀下。
- 保存任务 payload 包含兼容性确认和破坏性同步确认字段时，字段值只来自用户确认。
- 重复点击保存不会创建重复任务或让按钮永久 busy。

## 6. 预览与小规模同步

1. 先运行预览，不直接同步。
2. 查看预览命令和输出，确认 secret 已脱敏。
3. 执行一次小规模上传。
4. 修改本地一个文件，再执行一次上传或双向同步。
5. 在服务端对象存储或控制台侧确认文件变化。

通过条件：

- 预览不会写入远端。
- 同步过程中页面显示速度、进度和当前文件。
- 同步结束后任务历史记录成功状态、耗时和摘要。
- rclone 命令展示不包含 S3 `secret_access_key`。
- 出错时 UI 显示稳定错误码或中文说明，诊断包能记录失败摘要。

## 7. 停止、重启与恢复

1. 同步过程中点击停止。
2. 退出客户端。
3. 重新打开客户端。
4. 确认 profile、任务和最近历史仍可读。

通过条件：

- 停止操作不会让页面卡在运行中。
- 退出失败会显示明确反馈。
- 重启后 `/api/client/status` 中 `safeguards.localState.ok: true`。
- 不需要重新导入 SyncKey 即可看到已保存任务。

## 8. 诊断包与隐私检查

1. 在设置页导出诊断包。
2. 打开导出的 JSON。
3. 搜索以下敏感内容：SyncKey 原文、VLESS URI、S3 secret、heartbeat secret、管理 token、SSH 私钥路径内容。
4. 记录诊断包中的 release manifest、协议版本、心跳兼容性和最近日志摘要。

通过条件：

- 诊断包不包含原始 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret 或管理 token。
- 诊断包包含 `releaseManifest`、`diagnostics.protocols`、组件摘要、本地状态摘要、最近日志摘要。
- 未知客户端 status 字段不会进入外发诊断包。

## 9. 便携包兼容抽检

如果本轮要同时交付旧式 Node 便携包，额外执行：

1. 解压 `SyncraftClient.zip` 到另一个干净目录。
2. 启动 `SyncraftClient\Syncraft.exe`。
3. 重复“首次启动”“导入 SyncKey”“诊断包导出”三个步骤。

通过条件：

- 便携包 `/api/client/status` 返回 `ok: true`。
- `releaseManifest.ok: true`。
- 内置 `runtime/node.exe`、`sing-box.exe`、`rclone.exe` 可用。
- 不把桌面包的 `data/` 混入便携包。

## 10. 通过/失败记录

验收记录至少包含：

- 执行人、日期、Windows 版本、包版本。
- release bundle ZIP SHA256、desktop ZIP SHA256、portable ZIP SHA256。
- N1 `post-deploy-summary.json` 路径和 `runId`。
- 每个章节的通过/失败结论。
- `reports/internal-trial/internal-trial-assistant.json`，用于说明自动化已观察到的证据和剩余人工动作。
- `reports/internal-trial/internal-trial-command-sheet.md`，如果本轮使用了命令单准备工具。
- `reports/internal-trial/client-trial-runner.json`，如果本轮使用了客户端执行助手。
- 失败时附客户端诊断包、`reports/release/preflight.json`、相关 N1 报告和复现步骤。

任一关键路径失败时，不扩大内部用户范围；先修复、重新打包、重新运行 strict preflight，并在涉及服务端变更时重新执行 N1 release acceptance。

## 11. 多人试点扩展门禁

内部人工 E2E 只是进入 5-10 人小范围试点的前置条件，不等于可以直接扩大到更多用户。进入多人试点前必须确认：

- 全量测试以最新 strict preflight 报告为准，且本轮 strict preflight 仍为 `releaseOk: true`、`failed: 0`、`skipped: 0`。
- release bundle SHA256 已按 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip.sha256` 核对并记录到 `reports/internal-trial/internal-trial-record.json`。
- N1 release acceptance 使用 `reports/n1/latest-post-deploy.json` 指向的最新 run 或更新的同等级通过证据，且 `restartRequired=false`、`targetHostsMatch=true`。
- internal trial assistant 为 `ready-for-human-review`，人工章节无阻断失败。
- 桌面包和便携包都随包携带 `docs/PILOT_RUNBOOK.md`、`docs/PILOT_ACCEPTANCE_CRITERIA.md`、`docs/PILOT_SUPPORT_GUIDE.md`，release manifest 中能看到这些文档。
- 试点负责人已建立参与者名册，字段至少覆盖 participantId、contact、cohort、Windows 版本、packageType、SHA256 核对状态、安装时间、首次同步时间、状态、支持单编号和清理确认。
- 使用 `pnpm run pilot:prepare` 生成批次名册、每人命令单和 `participant-record.json`；使用 `pnpm run pilot:summary` 汇总安装、导入、首次同步、诊断包、P0/P1 和回滚演练门禁。
- 已确认分批 rollout、每日检查、量化验收指标、升级/回滚/暂停规则、支持包、隐私检查和试点结束清理流程。

多人试点期间，如果出现 P0、同根因 P1 影响 2 人及以上、疑似密钥泄露、误同步到非试点前缀、无法停止同步或诊断包脱敏失败，立即暂停新增参与者和新 SyncKey，按 `docs/PILOT_SUPPORT_GUIDE.md` 升级处理。
