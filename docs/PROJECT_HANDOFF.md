# 项目交接说明

## 1. 当前状态

项目当前交付口径为 beta/productized baseline：已经具备可运行、可验收、可诊断的产品化基线，不再按 demo/MVP 表述。当前 beta 交付形态仍是 Windows 便携 ZIP/桌面包和服务端部署 bundle，不是正式安装器；现场安装、升级和卸载按便携包流程处理。

- 服务端控制台可管理 VLESS、同步仓库、设备 SyncKey、在线设备，并可筛选定位离线、停用、同步失败、冲突或协议不兼容设备。
- Windows 客户端可导入 SyncKey。
- 客户端内置 sing-box 和 rclone。
- 客户端可启动本地隧道并运行 rclone 同步。
- 客户端主界面显示同步速度、进度、当前文件。
- 支持并行文件和单文件多线程配置。
- 客户端设置页可查看本机/服务端协议、发布包 manifest 状态、组件状态、本地状态、密钥库、心跳、同步历史和脱敏诊断包。
- Windows 桌面包会生成目录包、ZIP、ZIP SHA256 sidecar 和 `release-manifest.json`，并由 smoke/preflight 校验关键文件、Electron 安全桥、runtime 状态排除和 manifest 哈希；旧式 Node 便携包也会生成独立 `release-manifest.json`、ZIP、ZIP SHA256 sidecar，并由同一 smoke/preflight 按便携布局校验。

2026-07-08 当前验收状态：

- 双端协议入口已扩展为 31 个机器可读请求 schema；客户端本地 `/api/binaries/check`、`/api/client/shutdown`、`/api/singbox/stop`、`/api/sync/stop` 也纳入空 JSON 信封校验。
- 客户端状态轮询已避免后台请求堆积和旧响应覆盖新状态，并补充行为级回归覆盖 in-flight 复用和乱序响应不覆盖新 DOM。
- 非 Electron 模式下不再用 `webkitdirectory` 目录名伪造本地绝对路径，改为提示用户粘贴完整本地路径；Electron 选择成功、取消、失败 fallback 和 legacy picker path 均有行为级回归。
- 客户端长操作按钮已统一 busy/disable，避免导入、保存、同步、停止、刷新、导出诊断和退出等操作被重复点击；busy 重复点击和失败恢复已补行为级回归，退出失败会在页面显示稳定中文反馈。
- Electron 桌面启动失败不再静默退出：本地 API 启动失败或端口被非 SFSC 进程占用时会显示启动失败窗口，包含稳定错误码、目标端口、Electron main 日志路径和可复制详情；端口冲突归一化为 `client_port_in_use`。`SFSC_PACKAGE_SMOKE=1` 仍保持非零退出，确保打包 smoke 能捕获启动回归。
- 客户端确认弹窗已补行为级回归：错误确认文本不关闭、不 resolve；正确确认返回结构化确认结果；取消返回 `null`；新确认会释放旧 pending 确认；兼容性 warning 与镜像同步双确认的顺序、取消路径和最终 `confirmCompatibilityWarning` / `confirmDestructiveSync` payload 字段也已覆盖。
- 客户端任务表单已支持可选远端子目录和设备/共享空间选择；设备空间留空时直接使用 SyncKey 下发的设备专属 prefix，共享空间要求明确子目录。保存、预览、同步和镜像确认会携带 `remoteFolder` / `serverSpace`，实际 S3 bucket/prefix 仍由本地 API 按导入 profile 派生，用户不手写 raw S3 路径或密钥。
- 客户端诊断包 `bundle.status` 已改为显式 allowlist DTO，并由 runtime contract 做嵌套 exact keys 校验；新增未知 status 字段默认不会进入可外发诊断包。
- 客户端本地 `/api/singbox/start` 已收紧为空 JSON 信封 `{}`，不得通过该入口覆盖 URI、端口或 profile 派生字段；端口继续来自 profile/defaults/job。
- 服务端 SyncKey redeem 限速窗口已从单进程内存提升为内部状态持久化：失败窗口只保存远端地址与短码摘要组成的脱敏 key，随 `sfsc-state.json` 保存，同一数据目录重启后继续生效；成功兑换会清理对应窗口并持久化，管理摘要不暴露该内部状态。
- 内部 beta 人工 E2E 入口为 `docs/INTERNAL_TRIAL_CHECKLIST.md`，用于干净 Windows 环境验证 ZIP SHA256、首次启动、SyncKey 导入、目录选择、预览、小规模同步、停止/重启、诊断包隐私和便携包兼容抽检；release audit 会检查该清单和入口引用，客户端包也会随包携带该文档。
- 已新增最小真实 Electron 窗口 smoke：`pnpm run smoke:electron-window`。该脚本启动 `dist/SyncraftDesktop` 的真实窗口，验证 UI 加载、`window.sfscDesktop.pickFolder` 原生目录选择桥、设置抽屉和诊断导出按钮；它需要当前 Windows 桌面会话可创建窗口，因此作为内部 beta 辅助检查，不纳入 strict preflight。
- 已新增真实 Electron UI 业务链路 smoke：`pnpm run smoke:electron-e2e`。该脚本启动临时复制的打包桌面窗口，用离线服务端 profile 走 UI 导入、保存任务、生成 rclone preview，并通过 fake sing-box/rclone 覆盖 UI 开始同步、停止同步、同步历史和诊断 JSON 脱敏校验；它不连接 N1、不访问真实对象存储，作为人工 E2E 前的强辅助证据。
- 已新增内部 beta 人工验收工具链：`pnpm run trial:record` 生成 `reports/internal-trial/internal-trial-record.json` 模板并校验 release bundle、客户端 ZIP SHA256 和最新 N1 release acceptance；`pnpm run trial:record:update` 通过命令记录 tester/date/Windows 环境、章节状态、notes 和 artifact，并拒绝疑似 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或私钥内容进入记录；`pnpm run trial:create-t-key` 调用服务端 `POST /api/claims/create` 生成本轮一次性 SyncKey，要求 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN`，只把 SyncKey / SyncKey URI 的 SHA256、长度、claim 短码和过期时间写入 `reports/internal-trial/trial-t-key-report.json`，完整 SyncKey 仅在显式 `--print-t-key` 时打印一次；`pnpm run trial:prepare` 生成 `reports/internal-trial/internal-trial-command-sheet.md` / `.json` 并创建本轮小样例文件，它只写 SyncKey 占位符，不读取、不保存、不打印真实 SyncKey；`pnpm run trial:assist` 生成 `reports/internal-trial/internal-trial-assistant.json`，只汇总自动化证据和剩余人工动作，不修改人工记录、不把章节标记为通过；`pnpm run trial:client-runner` 可在真实客户端已启动且拿到真实 SyncKey 后串起本地 API 导入、保存、预览、可选真实同步和诊断导出，真实同步必须显式传 `--run-sync --i-understand-real-sync`，对象存储结果仍需人工确认。人工完成清单章节后运行 `pnpm run trial:record:verify`。5-10 人试点新增 `pnpm run pilot:prepare` 生成批次名册、个人命令单和 `participant-record.json`，`pnpm run pilot:summary` 汇总多人安装、导入、首次同步、诊断、P0/P1 和回滚演练门禁。该工具链只把人工 E2E/试点结果结构化，不会把 `pending` 章节当作通过。
- 客户端 release manifest/support-documents 合同已纳入 `INTERNAL_TRIAL_CHECKLIST.md` 和 5-10 人试点材料：桌面包 manifest 当前 27 个文件，便携包 manifest 当前 25 个文件。
- 全量 Node 测试和 release audit 已通过；测试数量以最新 strict preflight 报告为准，当前观察值为 318/318。
- 已重建 `dist/SyncraftDesktop.zip`、`dist/SyncraftClient.zip` 及其 SHA256 sidecar，并重建 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip`。release bundle 以 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release/release-bundle-manifest.json` 为权威 manifest，需满足 `preflightVerified=true`。若本段之后继续修改源码、文档或测试，必须重新运行 strict preflight 和 release bundle 构建。
- 严格 preflight 已刷新到 `reports/release/preflight.json`，通过项包括 release audit、N1 dry-run/archive validation、桌面/便携 package smoke、全量 Node 测试；`releaseOk=true`、`passed=6`、`failed=0`、`skipped=0`。真实 Electron 窗口 smoke 已刷新到 `reports/release/electron-window-smoke.json`，`generatedAt=2026-07-08T14:21:51.068Z`、`passed=6`、`failed=0`。
- 最新 release bundle SHA256 基线以 `dist/release-bundles/singbox-folder-sync-0.2.0-beta.2-release.zip.sha256`、`reports/internal-trial/internal-trial-record.json` 和 `reports/n1/latest-post-deploy.json` 为准。N1 release acceptance 已绑定当前 release bundle，汇总以 `reports/n1/latest-post-deploy.json` 指向的 `post-deploy-summary.json` 为准。关键字段应保持：`ok=true`、`releaseBundleVerified=true`、`lifecycleExercised=true`、`cleanupUserDeleted=true`、`cleanupClaimRetained=true`、`restartRequired=false`、`finalRestartClear=true`、`targetHostsMatch=true`、桌面包 `fileCount=27`、便携包 `fileCount=25`。internal trial assistant 当前状态为 `ready-for-human-review`。该轮已重新部署 N1、执行 lifecycle smoke 和 sing-box apply/final smoke。

## 2. 关键目录

```text
src/                  服务端 API 和共享核心逻辑
src/core/             VLESS、rclone、SyncKey、profile、storage 等核心模块
public/               服务端控制台前端
server/               Docker Compose 和服务端部署文件
client/src/           Windows 客户端本地 API
client/public/        Windows 客户端 UI
client/electron/      Electron 壳
client/resources/     客户端内置二进制
tests/                Node test 测试
dist/                 Windows 客户端发行包
docs/                 设计和迁移文档
```

## 3. 开发命令

```powershell
pnpm install
pnpm test
pnpm run client:package
pnpm run client:desktop
pnpm run client:desktop-package
```

服务端开发：

```powershell
pnpm start
```

Docker 服务端：

```bash
cd server
docker compose up --build -d
```

## 4. 后续优先事项

1. 安全存储增强：当前 `profile.json/jobs.json` 已改为 `secretRef`，真实 S3 secret 进入本地 vault 文件；后续可把 vault 后端替换为 Windows Credential Manager。
2. 5-10 人小范围试点：按 `docs/PRODUCTIZATION_ROADMAP.md`、`docs/PILOT_RUNBOOK.md`、`docs/PILOT_ACCEPTANCE_CRITERIA.md`、`docs/PILOT_SUPPORT_GUIDE.md` 建立名册、分批 rollout、每日检查、量化验收、升级/回滚/暂停和结束清理；试点记录不得包含真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key。
3. 干净 Windows E2E：按 `docs/INTERNAL_TRIAL_CHECKLIST.md` 跑通内部 beta 人工路径，并把失败记录转成修复项；多人试点前必须通过该清单的“多人试点扩展门禁”。
4. 真实 SyncKey 和小文件同步人工验收：窗口 smoke 已覆盖最小桌面加载和诊断入口，但仍需按内部清单验证 SyncKey 导入、目录选择、预览和真实小文件同步。
5. 诊断包增强：当前设置页已支持导出脱敏 JSON 诊断包，并包含运行环境、发布 manifest、组件/状态/日志文件摘要和最近日志截断元数据；后续可升级为 zip，并附带更多环境检查结果。
6. 更完整的任务历史页：当前客户端已保留最近 20 次运行记录，并在设置抽屉支持状态/文本筛选、状态/冲突统计和速度峰值；后续可补独立详情和更细的任务维度统计。
7. 冲突策略：双向同步需要更明确的冲突 UI。
8. 高级同步参数：带宽限制已支持固定值和两段式时间段限速；后续如需可扩展多时段时间表。
9. 安装器：当前 beta 桌面包和旧式 Node 便携包已有 ZIP、SHA256、release manifest、smoke 和 preflight 验收，但仍不是正式安装器；后续再把便携 ZIP/桌面包升级为正式安装包。

## 5. 已知注意点

- `dist/SyncraftDesktop` 和 `dist/SyncraftClient` 运行时会生成 `data/`，打包迁移时应排除日志、本机 profile/job 和 `data/secrets.json`；交付前运行 `pnpm run smoke:client-package`，或为非默认目录设置 `SFSC_CLIENT_PACKAGE_DIR`，复验发行包不携带这些本机状态，并确认 `release-manifest.json` 与关键文件哈希一致。
- `server/sing-box/config.json` 可能包含真实 private key，外发前必须轮换。
- `server/data/` 是运行数据，不是源码。
- SyncKey 对外解析服务必须能通过 `https://域名:端口/api/health` 访问。

## 6. 验收基线

迁移后至少运行：

```powershell
pnpm run ci:verify
```

并确认：

```text
dist/SyncraftDesktop/Syncraft.exe
dist/SyncraftDesktop/release-manifest.json
dist/SyncraftDesktop.zip
dist/SyncraftDesktop.zip.sha256
dist/SyncraftClient/release-manifest.json
dist/SyncraftClient.zip
dist/SyncraftClient.zip.sha256
```

可以启动，`/api/client/status` 返回 `ok: true`，并且 `releaseManifest.ok: true`。

对外 beta 验收时，还应确认交付物来自已通过严格 preflight 的 release bundle；N1 证据以最新 post-deploy 汇总、对应 server smoke、`context.adminAuthProvided: true`、`summary.restartRequired: false` 和 `acceptance.target.targetHostsMatch: true` 为准。
