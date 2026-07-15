# Syncraft

> 透過 VLESS 隧道與 S3 相容儲存的自託管 Windows 資料夾同步工具。

Syncraft 將 `sing-box`、`rclone` 與 MinIO/S3 串成一套可管理的同步服務：伺服器負責建立裝置與一次性 SyncKey；Windows 用戶端匯入 SyncKey 後，即可在不修改系統代理、路由、DNS、TUN 或防火牆的前提下執行多執行緒資料夾同步。

目前是 **0.2.0-beta.2 產品化基線（产品化基线）**。交付型態為 Windows 可攜 ZIP／桌面包與 Docker 伺服器部署包，尚非正式安裝程式。

## 主要能力

- 服务端 Docker Compose 部署：`sync-server`、`sing-box`、`MinIO`。
- 服务端控制台管理 VLESS、同步仓库、设备、SyncKey、在线设备状态。
- Windows 客户端 EXE 内置 `sing-box.exe` 和 `rclone.exe`。
- 客户端通过 SyncKey 导入完整 profile。
- 同步流量只走 rclone 进程代理，不修改系统代理、路由、DNS、TUN。
- 客户端主界面显示同步速度、进度、当前文件和已传输数据。
- 支持 `并行文件` 与 `单文件线程` 配置。
- 客户端设置页显示协议/构建、发布包 manifest、组件、本地状态、密钥库、心跳和同步历史，并可导出脱敏诊断包。
- Windows 发行包输出桌面包、旧式便携包、ZIP、SHA256 sidecar 和关键文件 `release-manifest.json`，发布前可由 smoke/preflight 校验。

## 架構

```text
Windows Client (Electron)
  ├─ 本機 API（127.0.0.1:5188）
  ├─ sing-box：僅供 rclone 使用的本機 SOCKS 代理
  └─ rclone：上傳、下載或雙向同步
           │ VLESS
           ▼
Server (Docker Compose)
  ├─ sync-server：管理控制台、SyncKey、裝置心跳
  ├─ sing-box：VLESS 入站
  └─ MinIO：S3 相容同步儲存
```

## 快速開始

### 開發與測試

需求：Windows、Node.js 24、pnpm 9、Docker Desktop（僅伺服器端需要）。

```powershell
pnpm install
pnpm test
pnpm start             # 啟動伺服器 API／管理控制台
pnpm run client:desktop
```

### 啟動伺服器

```bash
cd server
cp .env.example .env
docker compose up --build -d
```

控制台預設位址為 `http://127.0.0.1:5177/`。對外部署前，請設定 `SFSC_ADMIN_TOKEN`（或 `ADMIN_TOKEN`）保護管理 API。

### 建置 Windows 用戶端

```powershell
pnpm install
pnpm run client:download-binaries
pnpm run client:desktop-package
```

輸出在 `dist/SyncraftDesktop/` 與 `dist/SyncraftClient/`。內建的 `sing-box.exe`、`rclone.exe` 不納入原始碼倉庫；由 `binaries.lock.json` 鎖定版本與 SHA-256，透過上述命令下載驗證。

## 專案結構

```text
src/                 伺服器 API 與共享核心邏輯
src/core/            協議、SyncKey、VLESS、rclone、儲存與同步邏輯
public/              伺服器管理控制台
client/              Windows 本機 API、Electron 殼、用戶端 UI 與建置指令碼
server/              Docker Compose、Caddy 與 sing-box 部署設定
tests/               Node 合約與行為測試
docs/                協議、設計、部署、試點與交接文件
scripts/             CI、smoke、發行與 N1 部署自動化
```

## 開發守則

- `docs/INTERFACE_CONTRACT.md` 是雙端 API 與協議的唯一基線；修改 `/api/*`、SyncKey、profile、heartbeat、穩定錯誤碼或診斷欄位時，須同步更新合約與測試。
- 請勿提交 `.env`、`server/data/`、真實 sing-box 設定、本機用戶端資料、下載的二進位檔或 `dist/` 產物。
- 發行前先執行 `pnpm run ci:verify`；需要完整交付驗證時，依下方「發行前檢查」執行 strict preflight。

## 重要文档

- `docs/SOFTWARE_DESIGN_SPEC.md`：软件设计说明书
- `docs/INTERFACE_CONTRACT.md`：客户端/服务端接口与协议合同
- `docs/API_MATRIX.md`：双端 API 路由和消费者矩阵
- `docs/protocol/PROTOCOL_V1_BASELINE.md`：冻结的 Protocol v1 范围、兼容策略和封版证据要求
- `docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`：部署与迁移说明
- `docs/T_KEY_PROTOCOL.md`：SyncKey 协议说明
- `docs/PROJECT_HANDOFF.md`：项目交接说明
- `docs/server-design.md`：服务端设计草案
- `docs/client-design.md`：客户端设计草案

修改任一 `/api/*` 路由、SyncKey/profile/heartbeat 字段、稳定错误码、诊断字段或发布包结构时，必须同步更新 `docs/INTERFACE_CONTRACT.md`、`docs/API_MATRIX.md` 和对应合同测试。

## 服务端运行

```bash
cd server
cp .env.example .env
docker compose up --build -d
```

服务端控制台默认：

```text
http://127.0.0.1:5177/
```

健康检查：

```bash
curl http://127.0.0.1:5177/api/health
```

## 客户端运行

开发模式：

```powershell
pnpm run client:desktop
```

客户端本地 runtime 启动后，可先跑只读运行时 smoke，确认 `/api/health`、`/api/client/status`、`/api/logs` 和 `/api/diagnostics/export` 的本机协议、诊断、状态与脱敏支持入口正常：

```powershell
pnpm run smoke:client
```

如需指定非默认端口或写出自动化报告：

```powershell
node scripts/smoke-client.mjs --base-url http://127.0.0.1:5188 --json-report reports/client-smoke.json
```

打包：

```powershell
pnpm install
pnpm run client:download-binaries
pnpm run client:desktop-package
```

`smoke:client` 检查已经运行的客户端本地服务；`smoke:client-package` 检查已经构建出的发行包目录。`client:desktop-package` 会在构建结束后自动运行客户端包 smoke 检查；也可单独运行：

```powershell
pnpm run smoke:client-package
```

如需生成旧式 Node 便携目录包，可运行 `pnpm run client:package`；该命令同样会生成 `dist/SyncraftClient/release-manifest.json`、ZIP、SHA256 sidecar，并自动运行同一套客户端包 smoke。单独复验非默认目录时设置 `$env:SFSC_CLIENT_PACKAGE_DIR` 指向包根目录。

输出：

```text
dist/SyncraftDesktop/Syncraft.exe
dist/SyncraftDesktop/release-manifest.json
dist/SyncraftDesktop.zip
dist/SyncraftDesktop.zip.sha256
dist/SyncraftClient/release-manifest.json
dist/SyncraftClient.zip
dist/SyncraftClient.zip.sha256
```

`release-manifest.json` 记录版本、构建时间、关键文件 SHA256，以及随包交付的 `resources/app/docs/INTERFACE_CONTRACT.md` 和 `resources/app/docs/API_MATRIX.md`；客户端设置页和诊断包会展示 manifest 状态，便于现场确认用户运行的包批次。

## 测试

```powershell
pnpm test
```

或：

```powershell
.\test.ps1
```

## 发布前检查

普通终端或 CI 中运行完整检查：

```powershell
pnpm run ci:verify
```

`ci:verify` 固定运行发布审计和全量 Node 测试；GitHub Actions 的 `.github/workflows/ci.yml` 也使用同一入口。需要生成可交付 Windows 客户端包时，手动触发 `.github/workflows/release.yml`：它会按 `client/resources/bin/win32/binaries.lock.json` 确保内置 sing-box/rclone 存在并校验 SHA256，构建 Electron 桌面包和旧式 Node 便携包，运行严格 preflight，显式检查 `releaseOk: true`、`skipped: 0` 和双包 smoke 报告，生成 release bundle，并上传 ZIP、`.sha256`、`release-manifest.json`、`reports/release/**` 和 `dist/release-bundles/**`。

已有客户端发行包并准备在本地做发布放行时，再运行严格预检：

```powershell
pnpm run preflight:release
```

该命令会串联发布审计、N1 dry-run、N1 升级包验包、客户端包 smoke（要求 `dist\SyncraftDesktop` 和 `dist\SyncraftClient` 都存在并通过）和全量测试；生成 JSON 报告时会分别写出 `client-package-smoke-desktop.json` 和 `client-package-smoke-portable.json`。

需要把源码、文档、客户端 ZIP、manifest 和预检报告收成一个本地交付包时运行：

```powershell
pnpm run bundle:release
```

输出位于 `dist/release-bundles/`，包含 `release-bundle-manifest.json`、同名 ZIP 和 `.sha256`，并排除 `.env`、`server/data`、真实 `server/sing-box/config.json`、客户端运行态 `data/`、`.tmp` 和 `node_modules`。manifest 的 `preflightVerified` 和 `preflightVerification` 字段是发布放行判断入口；`preflight` 区块会记录严格预检报告、双包 smoke 子报告的 SHA256 和 `releaseOk` 摘要。release workflow 会把 `reports/release/preflight.*` 注入 bundle 作为交付自证明，此时 legacy `strictPreflight` 可能为 `false`，但 `preflightVerification.mode: "external"` 且 `preflightVerified: true` 表示已使用上游严格预检证据放行。

真实 N1 部署后需要归档验收证据时运行：

```powershell
pnpm run postdeploy:n1 -- -Apply
```

输出位于 `reports/n1/<UTC-run-id>/`，包含 deploy、server smoke 和统一的 `post-deploy-summary.json`。正式 `-ReleaseAcceptance` 必须在真实客户端同步、SSD 对象核验和最终测试数据清理完成后执行，并同时传入 `-ReleaseBundleManifestPath`、`-ClientRealSyncJsonPath`、`-SsdObjectVerificationJsonPath` 和 `-TestDataCleanupJsonPath`。验收会复制并计算四类证据的 SHA-256，校验客户端 EXE/manifest/ZIP、N1 最终 smoke、双客户端包与 release bundle 的 build ID 完全一致，并检查 SSD 实际对象哈希、零残留测试数据以及最终 `restartRequired=false`；任一证据缺失或构建不一致都会失败。普通 `-Apply` 先用于部署和生命周期 smoke，完成真实同步及清理后再用已有 deploy/smoke 报告执行正式聚合。

如果 smoke 报告显示 `summary.restartRequired: true`，需要让 N1 的 sing-box 加载已写入配置后再标记已应用：

```powershell
pnpm run apply:n1 -- -Apply -ReportPath reports/n1/apply.txt -JsonReportPath reports/n1/apply.json
```

该命令只重启 N1 compose 中的 `sing-box` 服务，随后调用 `/api/admin/singbox/mark-applied` 并再次运行 server smoke；最终报告要求 `restartRequired=false`。脚本默认要求 SSH `RemoteHost` 与 `SmokeBaseUrl` 指向同一 host，避免错机重启后误清除状态。管理 Token 只从本机 `SFSC_ADMIN_TOKEN` / `ADMIN_TOKEN` 读取，报告只记录是否提供 token。

查看最近一次 N1 验收摘要：

```powershell
pnpm run postdeploy:n1 -- -PrintLatest
```

受限沙箱中先运行无测试 quick 检查，再单独运行测试：

```powershell
pnpm run preflight:release:quick
pnpm test
```

quick 检查只用于开发自检，不等价于发布放行；正式 beta/N1 验收仍必须使用严格 preflight、无 skipped 的双客户端包 smoke、已验证 release bundle 和最新 N1 证据。

## 迁移注意

默认迁移源码和发行包，不迁移本机运行数据：

- 不迁移 `node_modules/`
- 不迁移 `server/data/`
- 不迁移 `dist/SyncraftDesktop/data/`
- 不迁移生产环境真实 `server/sing-box/config.json`
- 对外部署前设置 `SFSC_ADMIN_TOKEN` 保护服务端管理接口
