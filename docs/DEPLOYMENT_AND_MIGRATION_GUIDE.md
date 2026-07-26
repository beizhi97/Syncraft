# 部署与迁移说明

## 1. 迁移包内容

迁移包/交付 bundle 应包含：

- 项目源码：`src/`、`client/`、`server/`、`public/`、`tests/`
- Docker 配置：`server/docker-compose*.yml`
- Windows 客户端发行包：`dist/SyncraftDesktop.zip`
- 旧式 Node 便携包：`dist/SyncraftClient.zip`
- 内置二进制：`client/resources/bin/win32/sing-box.exe`、`rclone.exe`
- 文档：`docs/`、`README.md`、`server/README.md`、`client/README.md`
- 锁文件：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`
- 发布报告：bundle 内路径 `<bundle>/reports/release-bundle/preflight.*` 和客户端包 smoke 子报告

默认不包含：

- `node_modules/`
- `server/data/`
- `dist/SyncraftDesktop/data/`
- 临时日志和 smoke 测试输出
- 生产环境真实 `server/sing-box/config.json`

本地需要生成完整交付 bundle 时，先构建两个客户端包，再运行：

```powershell
pnpm run bundle:release
```

该命令执行 `scripts/build-release-bundle.ps1`，默认先跑严格 `preflight:release` 并把报告写到 `.tmp/release-bundle/reports/`，然后生成 `dist/release-bundles/singbox-folder-sync-<version>-release/`、同名 `.zip` 和 `.zip.sha256`。bundle 根目录包含 `release-bundle-manifest.json`，列出交付物 SHA256、明确排除的运行态/密钥路径，以及发布预检证据。读取 manifest 时以 `preflightVerified` 和 `preflightVerification` 作为放行入口：`preflightVerification.mode` 表示证据来自本次 bundle 构建的 `strict` 预检、上游 release workflow 注入的 `external` 预检，或 `skipped`；`preflight` 证据区块继续记录 `mode`、`releaseOk`、通过/失败/跳过计数、源报告 SHA256、bundle 内报告 SHA256。`-SkipPreflight` 只用于测试夹具或已经由上游 release workflow 明确验证过的场景；正式 release workflow 调用时必须同时传入 `-PreflightReportPath reports/release/preflight.txt -PreflightJsonReportPath reports/release/preflight.json`，让 bundle 复制已通过的严格预检报告和双包 smoke 子报告作为交付自证明。legacy `strictPreflight` 只表示预检是否由 bundle 脚本本次直接运行；当 `preflightVerification.mode: "external"` 且 `preflightVerified: true` 时，即使 `strictPreflight: false` 也表示 release workflow 已提供严格预检证据。

所有 `reports/release/**`、`reports/n1/**`、内部试跑/试点报告以及 bundle 内 `reports/release-bundle/**` 在写盘、复制或压缩前都会经过共享敏感信息扫描器；若报告包含完整 SyncKey、sfsc 导入 URI、VLESS URI、管理 token、S3/MinIO secret、heartbeat secret 或私钥块，脚本会拒绝写入或入包。

### 1.1 交付物签名（真实性验证）

`.zip.sha256` 只能证明校验和与当前 ZIP 一致：任何能改动 ZIP 的人都能重算这个值，因此它只保证完整性，不保证来源真实性。真实性由分离式 Ed25519 签名 `.zip.sig` 提供。

首次准备发布密钥（只做一次，且只在受控机器上）：

```powershell
node scripts/release-signature.mjs keygen --out-dir secrets/release-key
```

该命令生成 `release-signing-key.pem`（私钥，权限 0600，**不得入库**）和 `release-signing-key.pub`（公钥）。把公钥复制到仓库根目录 `release-signing-key.pub` 并提交，私钥存入发布密钥保管位置（release workflow 的 secret 或离线保管）。

发布机上设置 `SFSC_RELEASE_SIGNING_KEY` 指向私钥路径（CI 中可用 `SFSC_RELEASE_SIGNING_KEY_PEM` 直接注入 PEM 内容），`pnpm run bundle:release` 会在写完 `.zip.sha256` 后自动生成 `<bundle>.zip.sig`；未配置密钥时脚本会打印 UNSIGNED 警告并继续，传 `-RequireSignature` 则在缺少密钥时直接失败。`release-bundle-manifest.json` 的 `signature` 区块记录算法、sidecar 名称和验证命令。

接收方核对交付物：

```powershell
node scripts/release-signature.mjs verify dist/release-bundles/<bundle>.zip
```

`pnpm run audit:release` 也会在能找到受信公钥（`release-signing-key.pub`、`SFSC_RELEASE_PUBLIC_KEY` 或 `SFSC_RELEASE_PUBLIC_KEY_PEM`）时验证所有 `dist/**` 交付 ZIP 的签名：签名存在但校验失败一律判为失败；缺少签名默认只是警告，release/CI 环境应设置 `SFSC_REQUIRE_SIGNED_RELEASE=1`，让未签名交付物直接判为失败。

签名覆盖 ZIP 交付物的来源，但不等于 Windows Authenticode 签名：客户端 exe 的 SmartScreen/UAC 提示需要单独购买代码签名证书后在打包阶段签名，属于尚未完成的独立事项。

## 2. 服务端部署

进入服务端目录：

```bash
cd server
cp .env.example .env
```

至少修改：

```text
PUBLIC_SERVER_URL=https://sync.example.com
VLESS_PUBLIC_HOST=sync.example.com
VLESS_PORT=45678
SFSC_ADMIN_TOKEN=...
MINIO_ROOT_PASSWORD=...
SING_BOX_IMAGE_TAG=v1.13.14
MINIO_IMAGE_TAG=RELEASE.2025-09-07T16-13-09Z
MINIO_MC_IMAGE_TAG=RELEASE.2025-08-13T08-35-41Z
```

`SFSC_ADMIN_TOKEN` 用于保护服务端控制台和管理接口。Docker compose 会设置 `SFSC_REQUIRE_ADMIN_TOKEN=1`，因此 token 缺失或仍为 `change-this-admin-token` 占位值时服务端会拒绝启动。浏览器首次访问管理功能时会提示输入该 token。

`MINIO_ROOT_PASSWORD` 同样是必填项：compose 模板对它使用 `:?` 强制注入，缺失时 `docker compose up` 直接失败；即便绕过 compose 直接启动服务端，`SFSC_REQUIRE_ADMIN_TOKEN=1` 下 `S3_SECRET_ACCESS_KEY` / `MINIO_ROOT_PASSWORD` 仍为 `change-this-minio-root-password` 占位值时服务端也会拒绝启动。从旧版本升级时，请先在 `.env` 中把该占位密码轮换为强随机值（同时更新 MinIO 侧凭据），再拉起新 compose。

Docker 运行依赖锁定为**固定 tag + digest 双重钉定**：`sing-box v1.13.14`、`minio RELEASE.2025-09-07T16-13-09Z`、`mc RELEASE.2025-08-13T08-35-41Z`、`caddy 2.10.2-alpine`，appliance 内置 `rclone 1.74.3`（与客户端 `binaries.lock.json` 对齐，`audit:compose` 会强制校验）。tag 在任何 registry 上都是可变的，digest 才锁定实际内容。不要在正式部署中使用 `latest`；升级镜像时必须同时更新 tag 与 digest——用 `docker buildx imagetools inspect <image:tag>` 读取 manifest-list digest，修改 `.env` 中的 `*_IMAGE_TAG` 与 `*_IMAGE_DIGEST`，在测试环境执行 smoke 和 post-deploy 报告归档，再把新的默认值写回 `server/.env.example`、compose 模板与各 Dockerfile。

本地可用 `pnpm run audit:compose` 单独检查 compose 镜像锁定；正式 `audit:release` 和 `preflight:release` 也会执行同一审计，发现 `:latest`、缺失镜像 tag 默认值或 `.env.example` 默认值漂移时必须失败。

启动：

```bash
docker compose up --build -d
```

N1/host network 版本：

```bash
docker compose -f docker-compose.n1.yml up --build -d
```

N1 模板固定把 MinIO 数据挂载到 SSD 的 `/ssd/sfsc-test/minio`，发布审计会拒绝回退到 `server/data/minio` 等系统盘相对目录。首次切换前应停止 `sync-server` 和 `minio` 写入，用 `rsync -aHAX --numeric-ids` 复制旧目录，并用同参数的 `--dry-run --itemize-changes` 确认零差异；启动后还必须核对容器 `/data` 的实际挂载来源、`/api/health`、bucket 可枚举和保留对象前缀。旧目录只能在这些验证通过后移出系统盘，并把回滚副本保存在 SSD 的受控备份目录。

2026-07-13 的 N1 Beta 迁移已将活动目录切换到 `/ssd/sfsc-test/minio`。当次迁移前先清除了本轮 `home-sync/devices/test1` 对象和 MinIO 回收站，根盘可用空间由约 `37 MiB` 恢复到约 `3.7 GiB`；旧的 `trial-1758-n1` 前缀得到保留。后续部署不得覆盖该挂载，也不得把对象数据重新写回 eMMC 根分区。

从本地工作区升级 N1 测试环境源码时，先执行 dry-run：

```powershell
pnpm run preflight:release
```

CI 基础门禁使用：

```powershell
pnpm run ci:verify
```

该入口运行 `scripts/ci-verify.ps1`，固定执行 `scripts/audit-release.mjs` 和 `node --test "tests/*.test.js"`。仓库的 GitHub Actions 基础门禁位于 `.github/workflows/ci.yml`，在 push / pull request 时使用同一入口；如果 workflow_dispatch 且已准备好客户端发行包，可启用 `run_strict_preflight` 输入额外执行正式 `preflight:release`。

正式生成 Windows 客户端交付物时，手动触发 `.github/workflows/release.yml`。该 workflow 使用 Windows runner，依次执行 `pnpm install --frozen-lockfile`、`pnpm run client:download-binaries`（按 `client/resources/bin/win32/binaries.lock.json` 确保内置 sing-box/rclone 存在并校验 SHA256；如果仓库内已有 exe 且 hash 匹配会复用现有文件）、`pnpm run client:desktop-package`、`pnpm run client:package`，然后运行严格预检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-release.ps1 -ReportPath reports/release/preflight.txt -JsonReportPath reports/release/preflight.json
```

release workflow 会显式解析 `reports/release/preflight.json`，要求 `releaseOk: true`、`summary.failed == 0`、`summary.skipped == 0`，并确认 desktop 与 portable 两个 `clientPackageSmokeReports[]` 都存在且 `ok: true`。随后上传 `dist/SyncraftDesktop.zip`、`dist/SyncraftDesktop.zip.sha256`、`dist/SyncraftDesktop/release-manifest.json`、`dist/SyncraftClient.zip`、`dist/SyncraftClient.zip.sha256`、`dist/SyncraftClient/release-manifest.json`、`reports/release/**` 和 `dist/release-bundles/**`；其中 `reports/release/**` 包含 preflight 文本/JSON 和派生的 `client-package-smoke-desktop.json` / `client-package-smoke-portable.json`，`dist/release-bundles/**` 包含统一交付 bundle、`.sha256` 和 `release-bundle-manifest.json`。发布放行以 `reports/release/preflight.json` 中的 `releaseOk: true` 为准。

内置组件版本锁定在 `client/resources/bin/win32/binaries.lock.json`：当前记录 `sing-box`、`rclone` 的 GitHub repo、tag、Windows asset 匹配规则和 exe SHA256。升级组件时先更新锁文件，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File client/scripts/download-binaries.ps1 -Force
```

临时实验可使用 `-SingBoxVersion` 或 `-RcloneVersion` 覆盖版本。覆盖版本没有锁定 hash，脚本默认直接拒绝执行；必须显式追加 `-AllowUnverified` 才会下载，输出会以 `UNVERIFIED` 警告标注并打印实际 SHA256，便于验证后回填 `binaries.lock.json`。这类构建不应作为正式 release artifact。构建指纹（buildId）会纳入 `binaries.lock.json`，因此更换锁定的组件版本必然改变 buildId；二进制文件本身仍不参与指纹，由锁文件里的 SHA256 代表其身份。

该命令会串联发布审计、N1 dry-run、升级包验包、客户端包 smoke（要求 `dist\SyncraftDesktop` 和 `dist\SyncraftClient` 都存在并通过）和全量测试，不连接 N1、不修改远端。正式 `preflight:release` 是严格发布门禁：如果缺少任一客户端包，对应客户端包 smoke 必须失败而不是跳过；只有显式使用 quick/`-AllowSkips` 的开发自检才允许 skipped。结束时会输出 `Preflight report`，列出生成时间、仓库路径、Node 路径、`SkipTests` 和 `AllowSkips` 状态，以及每个步骤的 `passed`、`skipped` 或 `failed` 状态、耗时和跳过/失败原因，便于作为发布前检查记录。需要文本留档时可追加 `-ReportPath reports/preflight.txt`；需要给 CI 或自动化 agent 解析时可追加 `-JsonReportPath reports/preflight.json`。总 JSON 的 `steps[]` 会为每个步骤提供稳定 `errorCode`：通过为空，跳过为 `preflight_step_skipped`，失败按步骤名生成如 `preflight_release_audit_failed` 或 `preflight_client_package_smoke_desktop_failed`。当客户端包存在时，preflight 会同时把客户端包 smoke 子报告写到同目录的 `client-package-smoke-desktop.json` / `client-package-smoke-portable.json`，并在总 JSON 的 `context.ClientPackageSmokeJsonReportPaths` 中记录这些路径；兼容字段 `context.ClientPackageSmokeJsonReportPath` 指向桌面包子报告路径。总 JSON 还会在 `clientPackageSmokeReports[]` 中内嵌已生成的客户端包 smoke 报告，并把子报告的 `failure.check` 提升为 `failureCheck`；缺失或无法解析的子报告会以 `client_package_smoke_report_missing` / `client_package_smoke_report_invalid` 记录，便于 CI 只读取一个预检 JSON。相对路径按项目根目录解析，失败退出时也会尽量写入已完成步骤报告。确认全部通过后，如需单独查看 N1 升级计划可执行：

在受限沙箱里如果 `node --test "tests/*.test.js"` 因进程权限失败，可先执行：

```powershell
pnpm run preflight:release:quick
```

`preflight:release:quick` 会传入 `-SkipTests -AllowSkips`，用于开发阶段快速确认 release audit、N1 dry-run 和已有客户端包 smoke；它不是正式发布放行条件。

再在普通终端或 CI 中运行 `pnpm test`。

```powershell
pnpm run deploy:n1
```

确认升级包内容只包含源码和服务端配置模板后，再执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -Apply
```

`deploy-n1.ps1 -BuildArchive` 会列出升级包并执行归档校验：必须包含 `package.json`、`src/`、`public/`、服务端 Docker/compose 模板、`scripts/smoke-server.mjs` 和 `scripts/lib/runtimeContracts.mjs`；不得包含真实 `.env`、`server/data`、`server/sing-box`、`node_modules`、`dist`、`.tmp`、客户端包、测试或文档目录。该检查通过会输出 `Archive validation passed`。

部署脚本也支持留档：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -BuildArchive -ReportPath reports/n1/deploy.txt -JsonReportPath reports/n1/deploy.json
```

JSON 报告类型为 `n1-deploy-report`，包含 `schemaVersion`、`ok`、`context`、`summary` 和 `steps`；失败时也会尽量写入已完成步骤和稳定 `errorCode`。`context` 会记录 `RemoteHost`、`RemoteRoot`、`ArchivePath`、`RemoteArchive`、`PostDeploySmoke` 和 `SmokeBaseUrl`，但不会把真实管理 Token 写入部署 JSON。

`deploy-n1.ps1 -Apply` 只替换服务端源码、控制台静态文件、Dockerfile、compose 文件、`.env.example` 和 smoke 脚本；会保留 N1 上的 `.env`、`server/data` 和 `server/sing-box`。`-Apply` 默认重新生成本地源码归档，避免复用旧 `.tmp` 包；上传前也会运行同一归档校验，远端源码备份失败会阻断部署。脚本会校验 `$RemoteRoot` 是安全 POSIX 绝对路径；当追加 `-PostDeploySmoke` 时，还会要求 SSH `RemoteHost` 与 `SmokeBaseUrl` 指向同一 host，防止部署 A 机器却 smoke B 机器，只有显式拆分目标的测试才使用 `-AllowMismatchedSmokeBaseUrl`。`-Apply` 完成后会在 N1 本机重试请求 `http://127.0.0.1:5177/api/health`，并结构化校验 `ok: true`、`diagnostics.protocols` 和 `adminAuth.enabled: true` 这些响应字段；失败信息会指出缺失字段，成功时输出 `deploy-health=passed`。管理 Token 需要直接在 N1 的 `.env` 中设置，不要通过命令行参数传递；完整管理合同可在 `-Apply` 后显式追加 `-PostDeploySmoke`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -Apply -PostDeploySmoke -SmokeBaseUrl http://192.168.1.254:5177 -ReportPath reports/n1/deploy.txt -JsonReportPath reports/n1/deploy.json -SmokeJsonReportPath reports/n1/server-smoke.json
```

`-PostDeploySmoke` 只在 `-Apply` 成功后执行，本地 dry-run 或 `-BuildArchive` 归档校验不会触发 smoke，也不会连接管理接口。完整 smoke 使用 `scripts/smoke-server.mjs --base-url ... --json-report ...`，管理 Token 仍只从本机 `SFSC_ADMIN_TOKEN` / `ADMIN_TOKEN` 环境变量读取；未设置 token 时 post-deploy smoke 会失败，避免把未启用鉴权的管理接口误判为验收通过。

如果 `-Apply` 后发现新源码不可用，可先查看回滚计划：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -RollbackLatest -ReportPath reports/n1/rollback.txt -JsonReportPath reports/n1/rollback.json
```

确认后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-n1.ps1 -Apply -RollbackLatest -ReportPath reports/n1/rollback.txt -JsonReportPath reports/n1/rollback.json
```

`-RollbackLatest` 会在 N1 的 `$RemoteRoot/.deploy-backups/` 中选择最新 `source-before-*.tgz`，恢复 `package.json`、`src/`、`public/`、`scripts/smoke-server.mjs`、`scripts/lib/runtimeContracts.mjs`、Dockerfile 和 compose 模板，并保留 `.env`、`server/data`、`server/sing-box` 与既有备份目录；较早备份若尚未包含 `scripts/lib/runtimeContracts.mjs`，回滚会输出 `rollback-runtime-contracts=not-present-in-backup` 并继续恢复旧版 smoke 脚本。回滚前还会再写一份 `source-before-rollback-*.tgz`，便于撤销误回滚。回滚完成后同样运行结构化 `/api/health` JSON 校验，成功时输出 `rollback-health=passed`。如果追加 `-PostDeploySmoke`，则只在 `-Apply -RollbackLatest` 成功后运行完整 server smoke。

需要把一次真实 N1 部署和完整 smoke 归档成稳定验收目录时，使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/post-deploy-n1.ps1 -Apply
```

如需把真实 claim lifecycle 一起纳入 N1 post-deploy 验收，并在成功后清理本次临时设备，使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/post-deploy-n1.ps1 -Apply -ExerciseClaimLifecycle -CleanupClaimLifecycle
```

`-ExerciseClaimLifecycle -CleanupClaimLifecycle` 会透传到 `deploy-n1.ps1 -Apply -PostDeploySmoke` 和 server smoke。cleanup 会软删除本次 `sfsc-smoke-client-*` 测试设备，保留已使用 claim 摘要作为审计记录；由于删除设备会再次写入 sing-box 配置，通常会留下 `restartRequired=true`，需要随后运行 `scripts/apply-n1-singbox.ps1 -Apply` 完成 sing-box 重启、mark-applied 和最终 smoke。

该脚本会创建 `reports/n1/<UTC-run-id>/`，调用 `deploy-n1.ps1 -Apply -PostDeploySmoke`，并写入 deploy、server smoke 和统一汇总。正式 `-ReleaseAcceptance` 采用两阶段流程：先部署并完成 claim lifecycle，再用最终客户端包执行真实同步、核验 SSD 对象并清理本轮测试数据，最后把已有 deploy/smoke 报告与 release bundle、真实同步、SSD 核验、清理报告一起聚合。脚本会复制所有证据并计算 SHA-256，要求 `preflightVerified: true`、`versionAlignment.ok: true`，客户端 EXE/manifest/ZIP、N1 最终 smoke 和三份运行证据的 build ID 与 release bundle 一致，同时要求对象大小及哈希一致、MinIO 挂载源位于 `/ssd/`、测试用户/claim/对象前缀均为零、无额外容器且最终 `restartRequired=false`。缺少任一证据时，普通环境 smoke 仍可运行，但正式放行必定失败。

每次归档仍写入 `reports/n1/<UTC-run-id>/post-deploy-summary.json` 并更新 `latest-post-deploy.json`。`n1-post-deploy-report` 会保留 `acceptance.delivery.releaseBundle`，记录 bundle 名称、版本、预检摘要、bundle ZIP/manifest SHA256，并展开 `acceptance.delivery.releaseBundle.clientPackages.desktop` / `portable` 与 `acceptance.delivery.versionAlignment`。基础门禁要求 deploy JSON 和 server smoke JSON 都 `ok: true`、`context.adminAuthProvided: true`、目标主机对齐；测试夹具若必须接受未验证 bundle，只能显式使用 `-AllowUnverifiedReleaseBundle`，失败报告会保留 `failure.releaseBundlePreflightVerified` 和 `failure.versionAlignment`。正式环境不得使用该豁免。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/post-deploy-n1.ps1 -DeployJsonPath reports/n1/deploy.json -SmokeJsonPath reports/n1/server-smoke.json -FinalSmokeJsonPath reports/n1/final-server-smoke.json -ReleaseBundleManifestPath dist/release-bundles/<bundle>/release-bundle-manifest.json -ClientRealSyncJsonPath reports/n1/client-real-sync.json -SsdObjectVerificationJsonPath reports/n1/ssd-object-verification.json -TestDataCleanupJsonPath reports/n1/test-data-cleanup.json -ReleaseAcceptance
```

需要在终端快速查看最近一次 N1 验收结果时，使用只读摘要：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/post-deploy-n1.ps1 -PrintLatest
```

如果 `server-smoke.json`、`post-deploy-summary.json` 或 `latest-post-deploy.json` 显示 `summary.restartRequired` / `acceptance.smoke.state.restartRequired` 为 `true`，说明服务端已写入 sing-box 配置，但 N1 运行中的 sing-box 尚未被确认加载。使用独立 apply 脚本完成重启、标记和最终 smoke：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/apply-n1-singbox.ps1 -Apply -ReportPath reports/n1/apply.txt -JsonReportPath reports/n1/apply.json -SmokeJsonReportPath reports/n1/apply-server-smoke.json
```

`apply-n1-singbox.ps1 -Apply` 会要求本机环境变量中存在 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN`，并要求 SSH key 存在；它通过 SSH 进入 N1 的 `$RemoteRoot/server`，只执行 `docker compose -f docker-compose.n1.yml restart sing-box`，不重启 `sync-server`、不打印 `.env`、不输出管理 token。脚本默认校验 SSH `RemoteHost` 与 `SmokeBaseUrl` 指向同一 host，并校验 `$RemoteRoot` 是安全的 POSIX 绝对路径，防止错机 apply 或远端 shell 参数注入；只有显式拆分目标的测试才使用 `-AllowMismatchedSmokeBaseUrl`。重启后脚本等待 `/api/health` 恢复，调用 `POST /api/admin/singbox/mark-applied` 且 body 固定为 `{ "confirmMarkApplied": true }`，再运行 `scripts/smoke-server.mjs --json-report ...`；最终 smoke 必须证明 `summary.restartRequired=false`。JSON 报告类型为 `n1-singbox-apply-report`，包含 `summary.remoteRestarted`、`summary.markApplied`、`summary.preRestartRequired` 和 `summary.postRestartRequired`，只记录 `adminAuthProvided: true/false`，不得记录真实 token 或 SSH 私钥内容。不带 `-Apply` 时只写 dry-run 计划报告，不连接 N1、不重启服务。

健康检查：

```bash
curl http://127.0.0.1:5177/api/health
```

部署 smoke 检查：

```bash
SFSC_SMOKE_BASE_URL=http://127.0.0.1:5177 \
SFSC_ADMIN_TOKEN=change-this-admin-token \
node scripts/smoke-server.mjs
```

默认每个 HTTP 请求 15 秒超时；网络较慢或反代首次启动较慢时，可设置 `SFSC_SMOKE_TIMEOUT_MS=30000`，也可用 `node scripts/smoke-server.mjs --timeout-ms 30000` 临时覆盖。

如需为自动化留档，可追加 `--json-report reports/server-smoke.json`，或设置 `SFSC_SMOKE_JSON_REPORT=reports/server-smoke.json`。JSON 报告包含 `schemaVersion`、`ok`、`context`、`summary`、`checks` 和失败时的 `failure`，只记录 `adminAuthProvided: true/false`，不得写入真实管理 token。`summary.restartRequired`、`summary.userCount`、`summary.deviceCount` 和 `summary.claimCount` 会记录 smoke 结束时的管理状态，post-deploy 汇总会提升为 `acceptance.smoke.state`；执行生命周期验收时，`context.claimLifecycleClientName` 和 `context.claimLifecycleDeviceName` 会提升为 `acceptance.smoke.lifecycle`，便于后续清理测试设备。

该脚本默认只读取接口，不会生成 SyncKey、写入配置或修改状态。它会检查：

- `/api/health` 返回 JSON 且 `ok: true`，并包含服务端 `version` 和 `diagnostics.protocols`。
- 管理 Token 可访问 `/api/admin/auth/check`。
- 启用管理 Token 时，未带 Token 的 `/api/admin/state` 必须返回 `401 admin_auth_required`。
- `/api/admin/state` 包含 tunnel、storage、devices、claims 和 `restartRequired`。
- `/api/health.diagnostics.protocols` 与 `/api/admin/state.diagnostics.protocols` 完全一致，`admin-state` 检查输出 `protocols=aligned`。
- `/api/admin/singbox/config` 可生成配置预览。
- 管理响应中的 `storage.secretAccessKey`、`users[].storage.secretAccessKey` 和 REALITY `private_key` 保持脱敏，且不包含 smoke 运行环境已知的原始 token 或密钥值。

如需在测试环境执行真实生命周期验收，可显式追加 `--exercise-claim-lifecycle`，或设置 `SFSC_SMOKE_EXERCISE_CLAIM_LIFECYCLE=1`。该模式会生成一次性 client/device 名称，依次执行 `POST /api/claims/create`、带 `clientRedeemId` / `clientInstallId` 的 `POST /api/claims/redeem`、同一客户端绑定短时重放成功、缺失绑定的重复 redeem 返回 `409 claim_already_used`、不同客户端绑定的重复 redeem 返回 `409 claim_already_used`、签名 `POST /api/devices/heartbeat` 和 `GET /api/admin/state` 设备摘要验证；报告中会出现 `claim-lifecycle-bound-replay`、`claim-lifecycle-duplicate-redeem` 和 `claim-lifecycle-different-binding-redeem` 检查。它会写入服务端状态并更新 sing-box 配置预览文件，只应在 N1 这类测试环境或临时本地环境使用。若希望 smoke 成功后自动删除本次临时设备，可额外追加 `--cleanup-claim-lifecycle` 或设置 `SFSC_SMOKE_CLEANUP_CLAIM_LIFECYCLE=1`；该清理只软删除本次 `sfsc-smoke-client-*` 设备，保留已使用 claim 摘要作为审计记录，并会让 `restartRequired` 继续提示管理员重启 sing-box 后标记已应用。

失败时脚本会输出 `Failed check: ...`，并在 HTTP 非 2xx 响应中显示请求路径、HTTP 状态和结构化 `errorCode`，用于快速判断是健康检查、管理鉴权、状态摘要、配置预览还是脱敏合同不一致。

如果对外反代已配置好，也可以把 `SFSC_SMOKE_BASE_URL` 换成公网地址，例如 `https://pass.971223.xyz:2025`。

客户端本地 runtime 启动后，可用只读客户端 smoke 快速确认本机协议和状态入口：

```powershell
node scripts/smoke-client.mjs --base-url http://127.0.0.1:5188 --json-report reports/client-smoke.json
```

也可用 `SFSC_CLIENT_SMOKE_BASE_URL`、`SFSC_CLIENT_SMOKE_TIMEOUT_MS` 和 `SFSC_CLIENT_SMOKE_JSON_REPORT` 环境变量。该脚本检查轻量 `/api/health` 不泄露完整本地状态，确认 `/api/health.diagnostics.protocols` 与 `/api/client/status.diagnostics.protocols` 完全一致并输出 `protocols=aligned`，同时检查 `/api/client/status` 暴露客户端 diagnostics、发布 manifest、组件摘要和 local state 摘要，校验 `/api/profile` 返回 `{ profile: null }` 或展示安全 profile 摘要且不得包含执行密钥、SyncKey 或 VLESS URI，并对 `/api/logs` 与 `/api/diagnostics/export` 执行脱敏日志和诊断包合同校验；JSON 报告类型为 `client-smoke-report`，包含 `schemaVersion`、`ok`、`context`、`summary`、`checks` 和失败时的 `failure`。

## 3. 服务端状态恢复

通用自托管 Beta 使用 Caddy 作为 HTTPS 入口。DNS 必须先把 `SFSC_PUBLIC_HOST` 指向服务器，并放通 `80/tcp`、`443/tcp` 与 VLESS 端口；`sync-server:5177` 不应直接暴露。首次部署或升级后执行：

```bash
cd server
SFSC_HEALTH_URL=https://sync.example.com sh ./sfscctl health
```

服务端备份和恢复使用同一入口：

```bash
cd server
sh ./sfscctl backup
sh ./sfscctl restore backups/sfsc-backup-YYYYMMDDTHHMMSSZ.tgz
```

`backup` 创建仅当前用户可读的归档和 SHA-256 sidecar，只覆盖项目目录中的 `.env`、`data/` 和 `sing-box/`。`restore` 在停服务前先创建新的现场备份，并只接受这三个白名单路径；含绝对路径、`..` 或额外文件的归档会被拒绝。恢复后必须执行 `sh ./sfscctl health` 和 server smoke，确认 HTTPS health、管理鉴权和 `restartRequired=false`。

N1 的活动 MinIO 数据位于 SSD `/ssd/sfsc-test/minio`，不在项目目录中，因此 **`sfscctl backup` 不包含对象数据**。N1 备份必须在同一个停写窗口中同时保存控制状态和 SSD 对象目录：

```bash
cd /opt/sfsc-test/server
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/ssd/sfsc-backups/$stamp"
mkdir -p "$target"
docker compose -f docker-compose.n1.yml stop sync-server minio
SFSC_BACKUP_DIR="$target" sh ./sfscctl backup
rsync -aHAX --numeric-ids /ssd/sfsc-test/minio/ "$target/minio/"
docker compose -f docker-compose.n1.yml up -d
SFSC_HEALTH_URL=http://127.0.0.1:5177 SFSC_COMPOSE_FILE=docker-compose.n1.yml sh ./sfscctl health
```

恢复 N1 时先校验归档 SHA-256，再停止 `sync-server` 和 `minio`，用 `rsync -aHAX --numeric-ids --delete` 把备份的 `minio/` 恢复到 `/ssd/sfsc-test/minio/`，最后以 `SFSC_COMPOSE_FILE=docker-compose.n1.yml` 执行 `sfscctl restore`。恢复前自动生成的现场备份也必须把 `SFSC_BACKUP_DIR` 指向 SSD；服务恢复后核对 `/data` 的挂载来源仍是 `/ssd/sfsc-test/minio`，再执行 health、server smoke 和对象抽查。不得用空目录或系统盘中的旧 `server/data/minio` 覆盖 SSD。

服务端运行状态默认在 `SERVER_DATA_ROOT/sfsc-state.json`，N1 compose 模板通常映射到 `server/data/app/sfsc-state.json`。该文件记录设备、SyncKey、bucket 摘要和管理配置状态；迁移或排障前应先备份原文件，不得覆盖或删除现场文件来“恢复默认状态”。

常见稳定错误码和处理方式：

- `server_state_corrupt`：服务端启动时发现 `sfsc-state.json` 不是合法 JSON，会拒绝启动并保留原文件，不得覆盖为默认状态。先停止服务，备份损坏文件，再从最近备份恢复或手工修复 JSON；修复后启动服务并运行 `/api/health` 与 `scripts/smoke-server.mjs`。
- `server_state_locked`：服务端启动时发现 `SERVER_DATA_ROOT/sfsc-state.lock` 已存在，说明同一状态目录可能已有另一个 sync-server、容器副本或本地进程在写入。owner 会记录容器 `instanceId`、`processStartedAt` 并刷新 `heartbeatAt`；同一容器内 PID 复用时可立即识别旧进程，不同容器实例的 owner 只有在心跳超时后才会自动接管。其他情况应先确认没有活动进程、重复服务或共享挂载多写入者。只有确认锁是异常崩溃留下的陈旧锁后，才可以备份现场并删除 `sfsc-state.lock`，随后重新启动服务。
- `server_state_write_failed`：服务端无法写入状态文件，常见原因是 `SERVER_DATA_ROOT` 权限、磁盘空间、只读挂载或安全软件拦截。修复目录权限和磁盘后，重试 SyncKey 创建、兑换或心跳；失败请求不会发布幽灵 SyncKey、不会消耗未持久化的 SyncKey，也不会让控制台显示未持久化的假在线设备。
- `server_singbox_config_write_failed`：服务端无法写入 sing-box 配置。检查 `SINGBOX_CONFIG_PATH`、父目录权限、容器挂载和磁盘空间；该错误会回滚本次管理状态修改，修复后重新执行 tunnel 生成或配置写入。

迁移 N1 生产状态时，至少同时备份 `server/data/app/sfsc-state.json`、SSD `/ssd/sfsc-test/minio/`、`server/sing-box/config.json` 和真实 `.env`。恢复后先运行只读 smoke，再让客户端重新心跳；不要手工补写在线状态或 SyncKey 消耗状态。

## 4. Windows 客户端本地状态恢复

Windows 客户端正式默认将运行状态保存在 `%LOCALAPPDATA%\\Syncraft\\data`，主要包括 `profile.json`、`jobs.json`、`secrets.json`、`sync-history.json` 和 `claim-recovery.json`。首次启动新版 ZIP 时，若默认目录尚不存在而旧包根目录 `data/` 含有上述状态文件，客户端会先复制到同一目标目录旁的临时迁移目录，再原子切换到默认目录；旧包 `data/` 保留不删，作为升级失败时的回滚副本。显式设置 `SFSC_CLIENT_DATA_ROOT` 或兼容变量 `SFSC_DATA_ROOT` 时不执行自动迁移。这些文件包含导入的 SyncKey 派生配置、任务、密钥引用、最近同步历史和未完成 SyncKey 导入恢复绑定；排障前应先导出诊断包，并备份整个数据目录，不得直接删除或覆盖现场文件来“恢复默认状态”。

常见稳定错误码和处理方式：

- `local_state_corrupt`：某个客户端本地 JSON 状态文件不是合法 JSON，包括 `claim-recovery.json`。`/api/client/status` 仍应返回 200，并在 `safeguards.localState.files[]` 中标记损坏文件；诊断包摘要会记录 `localStateOk: false` 和对应 `localStateErrors`。先导出诊断包，备份损坏 JSON，再修复 JSON 或将损坏文件移到隔离备份目录；如果修复后 profile、密钥引用或 SyncKey 导入恢复绑定缺失，应重新导入 SyncKey。不要在损坏状态上继续保存任务、导入 profile 或运行同步。
- `secret_vault_missing`：`profile.json` 或 `jobs.json` 中存在密钥引用，但 `secrets.json` 缺少对应值。先备份 `data/`，再重新导入 SyncKey 或恢复匹配的 `secrets.json`；不要把明文密钥直接写回任务文件。

现场确认顺序：

1. 在客户端 UI 导出诊断包，或请求 `GET /api/diagnostics/export` 留存证据。
2. 备份 `profile.json`、`jobs.json`、`secrets.json`、`sync-history.json`、`claim-recovery.json` 和客户端日志。
3. 查看 `safeguards.localState.files[]` 中 `ok: false` 的文件名和 `errorCode`。
4. 修复或隔离损坏文件后重启客户端 runtime，运行 `node scripts/smoke-client.mjs --base-url http://127.0.0.1:5188`，确认 `/api/health.diagnostics.protocols` 与 `/api/client/status.diagnostics.protocols` 对齐且 `safeguards.localState` 本地状态摘要可读。
5. 重新导入 SyncKey 或恢复任务后，再执行预览/同步；不要手工伪造同步历史或密钥引用。

## 5. Lucky/反代建议

若使用 Lucky 对外提供 SyncKey 解析服务：

```text
外部: https://pass.971223.xyz:2025
后端: http://192.168.1.254:5177
```

注意：

- 后端协议通常是 `http`，不要填成 `https`。
- 不要把后端指回 `pass.971223.xyz:2025`，否则会循环跳转。
- `https://pass.971223.xyz:2025/api/health` 必须返回 JSON。

## 6. Beta 客户端安装/升级/卸载/诊断

当前 beta 交付形态是便携 ZIP/桌面包，不是正式安装器。推荐试点用户使用 Electron 桌面包；旧式 Node 便携包用于兼容或排障：

```text
dist/SyncraftDesktop.zip
dist/SyncraftClient.zip
```

内部 beta 扩大范围前，按 `docs/INTERNAL_TRIAL_CHECKLIST.md` 在干净 Windows 环境执行人工 E2E。先运行 `pnpm run trial:record` 生成 `reports/internal-trial/internal-trial-record.json`，再运行 `pnpm run trial:assist` 生成只读辅助报告 `reports/internal-trial/internal-trial-assistant.json`，用于汇总自动化证据和剩余人工动作；助手报告不能替代人工判断。生成真实内测 SyncKey 时使用 `pnpm run trial:create-t-key -- --base-url http://192.168.1.254:5177 --client-name "<本轮客户端名>" --expires-in-hours 2 --print-t-key`，该命令要求 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN`，只把 SyncKey / SyncKey URI 的 SHA256、长度、claim 短码和过期时间写入 `reports/internal-trial/trial-t-key-report.json`，完整 SyncKey 仅在显式 `--print-t-key` 时打印一次。人工记录优先通过 `pnpm run trial:record:update` 写入 tester/date/Windows 环境、章节状态、notes 和 artifact，命令会拒绝疑似 SyncKey、完整 VLESS URI、S3 secret、heartbeat secret、管理 token 或私钥内容进入记录。客户端已启动且拿到真实完整 SyncKey 后，可运行 `pnpm run trial:client-runner` 串起本地 API 导入、保存任务、预览、可选真实同步和诊断导出；该脚本默认不运行真实同步，必须显式传 `--run-sync --i-understand-real-sync` 才会调用 `/api/sync/run`，且对象存储中文件结果仍需人工确认。人工完成各章节后运行 `pnpm run trial:record:verify` 校验记录。该清单覆盖发布证据、ZIP SHA256、首次启动、SyncKey 导入、目录选择、预览、小规模同步、停止/重启、诊断包隐私和便携包兼容抽检；任一关键路径失败时，先修复并重新运行 strict preflight，涉及服务端变更时重新执行 N1 release acceptance。

5-10 人小范围试点必须在内部人工 E2E 通过后再启动，并使用随包文档 `docs/PRODUCTIZATION_ROADMAP.md`、`docs/PILOT_RUNBOOK.md`、`docs/PILOT_ACCEPTANCE_CRITERIA.md` 和 `docs/PILOT_SUPPORT_GUIDE.md`。试点准入门禁包括：最新 strict preflight 的全量测试通过且 `releaseOk=true`、双客户端包 smoke 通过、release bundle SHA256 已按 `dist/release-bundles/singbox-folder-sync-<version>-release.zip.sha256` 核对、`reports/n1/latest-post-deploy.json` 指向的 N1 run 通过 release acceptance、internal trial assistant 为 `ready-for-human-review`。用 `pnpm run pilot:prepare` 生成批次名册、每人命令单和 `participant-record.json`，用 `pnpm run pilot:summary` 汇总安装、导入、首次同步、诊断包、P0/P1 和回滚演练门禁。试点按 2 人、3-4 人、剩余 3-4 人分批 rollout，每批至少观察 1 个完整工作日；每日检查 N1 health、`restartRequired=false`、设备心跳、最近同步状态、支持单和诊断包隐私。升级必须重新打包、重新 strict preflight，服务端变更还必须重新 N1 release acceptance；客户端回滚保留 `data/`，服务端回滚使用 `deploy-n1.ps1 -Apply -RollbackLatest` 并保留 `.env`、`server/data`、`server/sing-box`。出现 P0、同根因 P1 影响 2 人及以上、疑似密钥泄露、误同步到非试点前缀、无法停止同步或诊断包脱敏失败时，立即暂停新增参与者和新 SyncKey。

在可创建桌面窗口的 Windows 会话中，可先运行 `pnpm run smoke:electron-window` 做最小真实窗口 smoke，再运行 `pnpm run smoke:electron-e2e` 做打包桌面 UI 业务链路 smoke。后者会用离线服务端 profile 走导入、保存任务、preview，并在临时复制的桌面包中注入 fake sing-box/rclone，覆盖 UI 开始同步、停止同步、同步历史和诊断 JSON 脱敏校验；它补充人工 E2E，但不替代 N1 真实 SyncKey 导入和真实小文件同步。

交付形态：

- `SyncraftDesktop.zip` 是 Windows 产品候选版的默认交付物；`SyncraftClient.zip` 仅作为无法使用桌面包时的兼容回退。
- 当前不提供安装器：项目尚未引入代码签名证书、自动更新服务或系统级卸载注册，提前加入安装器会让 Windows 信任提示、升级和回滚更难支持。
- 两个 ZIP 都是自包含交付物，不修改系统代理、路由、DNS、防火墙或系统服务。每次交付必须同时提供 ZIP、同名 `.sha256`、`release-manifest.json` 和对应 release bundle。

证据留存与重跑：

- 每个已交付版本保留 release bundle、两个客户端 ZIP、`.sha256`、`reports/release/`、`reports/n1/<run-id>/` 和 `latest-post-deploy.json` 指向的汇总，至少覆盖当前版本和上一个可回滚版本。
- 当前源码、客户端包、release bundle 或服务端部署任一项变化后，旧的 strict preflight、包 smoke 和 N1 release acceptance 都不能作为新版本的放行证据；必须重新构建并重跑对应门禁。
- 仅查看既有报告、处理文档或新增不进入交付包的运营记录时，可复用同一 build ID/source tree hash 的证据；只要摘要不一致，就必须停止复用。
- 清理旧报告前，确认它既不是当前 `latest-post-deploy.json` 指向的 run，也不是上一个可回滚版本的唯一证据；清理后仍保留版本、SHA-256、build ID、source tree hash、验收结论和存档位置的安全摘要。

安装：

- 在用户可写、非临时目录解压，例如 `%LOCALAPPDATA%\Syncraft\`、`C:\Tools\Syncraft\` 或现场约定的软件目录；不要直接在 ZIP、下载临时目录或会被清理的目录中运行。
- 保留 ZIP 内根目录结构，桌面包入口为 `SyncraftDesktop/Syncraft.exe`，旧式便携包入口为 `SyncraftClient/Syncraft.exe`。
- 首次启动后在设置中导入服务端生成的 SyncKey，再配置本地文件夹、同步方向、计划任务、并行文件和单文件线程。

升级：

- 退出客户端和本地 runtime，确认没有旧的 `Syncraft.exe`、`node.exe`、`sing-box.exe` 或 `rclone.exe` 进程仍在使用包目录。
- 备份 `%LOCALAPPDATA%\\Syncraft\\data`；若从旧包升级，同时保留旧包目录中的 `data/`，尤其是 `profile.json`、`jobs.json`、`secrets.json`、`sync-history.json` 和 `claim-recovery.json`。
- 解压新 ZIP 到新目录后直接启动。若旧包 `data/` 含实际状态且默认数据目录不存在，客户端会自动迁移并保留旧目录；不要手工用空 `data/` 覆盖默认数据目录，也不要删除旧目录，直到确认 profile、任务和同步历史均可读。
- 启动后确认设置页或 `/api/client/status` 中 `releaseManifest.ok: true`，并确认 profile、任务和同步历史可读。

校验：

- 交付 ZIP 必须同时带 `.sha256` sidecar。现场可用 `Get-FileHash <zip> -Algorithm SHA256` 与 `.sha256` 首列比对；不一致时停止安装并重新获取交付包。
- 包内 `release-manifest.json` 是关键文件清单和 SHA256 证据。运行后若 `releaseManifest.ok` 不是 `true`，优先检查是否解压不完整、混用了不同版本文件，或误把运行态 `data/` 打进/覆盖进包内。

诊断：

- 客户端设置页可导出脱敏诊断包；也可在本地 runtime 启动后调用本地诊断导出接口 `/api/diagnostics/export`。诊断包会摘要运行环境、发布 manifest、组件、状态文件、最近日志和脱敏结果。
- 常见失败处理：SHA256 不匹配则重新下载；manifest 失败则重新解压同一批次完整 ZIP；本地状态损坏先导出诊断并备份 `data/`，再隔离或修复损坏 JSON；`secret_vault_missing` 通常需要恢复匹配的 `secrets.json` 或重新导入 SyncKey；端口占用或组件无法启动时先关闭残留进程，再从可写目录重新启动。

卸载：

- 退出客户端和本地 runtime 后删除解压目录即可；当前 beta 包不会注册系统服务、驱动、系统代理或正式卸载器。
- 如需保留用户配置和任务，先归档 `data/`；如需彻底清除本机状态，再删除包目录下的 `data/` 和现场额外备份。

## 7. 客户端重新打包

安装依赖：

```powershell
pnpm install
```

下载内置组件：

```powershell
pnpm run client:download-binaries
```

打包：

```powershell
pnpm run client:desktop-package
```

打包脚本会自动运行客户端包 smoke 检查，确认 `Syncraft.exe`、`resources/app`、内置 `sing-box.exe/rclone.exe`、`binaries.lock.json` 固定 SHA256、版本元数据、原生目录选择器安全桥和运行时状态目录排除情况。需要单独复验已有产物时运行：

```powershell
pnpm run smoke:client-package
```

旧式 Node 便携目录包可用 `pnpm run client:package` 生成到 `dist\SyncraftClient`。该脚本会生成独立 `release-manifest.json`、`SyncraftClient.zip` 和 `.sha256` sidecar，并自动运行同一套 smoke；此形态没有 Electron 安全桥检查，但会校验 `app/`、`runtime/node.exe`、支持文档、内置组件、`binaries.lock.json` SHA256、manifest 哈希和运行态排除。单独复验时可设置 `$env:SFSC_CLIENT_PACKAGE_DIR="dist\SyncraftClient"`。

需要留给 CI 或交接 agent 解析时，可直接调用脚本生成 JSON 报告：

```powershell
node scripts/smoke-client-package.mjs --json-report reports/client-package-smoke.json
```

也可通过环境变量指定输出路径：

```powershell
$env:SFSC_CLIENT_PACKAGE_JSON_REPORT="reports/client-package-smoke.json"; pnpm run smoke:client-package
```

该报告包含 `schemaVersion`、`ok`、`context`、`summary`、`checks` 和 `failure` 字段；`context` 会记录包根目录、根版本、包类型、manifest 版本、构建时间、manifest 文件数量和 package launch 摘要。smoke 会校验本地运行时暴露轻量 `/api/health`，并确认随包启动器 readiness 探测使用该轻量入口而不是完整 `/api/client/status`。随后 smoke 会用随机本地端口和临时 `SFSC_CLIENT_DATA_ROOT` 启动打包后的 `Syncraft.exe`，验证 `/api/health`、`/api/client/status.releaseManifest.ok`，再调用 `/api/client/shutdown` 并确认本地 API 下线。失败时仍会尽量写入已完成检查和失败原因，其中 `failure.check` 会标记失败检查点（如 `release-manifest`、`support-docs`、`health-readiness`、`package-launch`、`runtime-state-absent`），便于自动化发布门禁定位问题。

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

目录包内的 `release-manifest.json` 记录客户端版本、构建时间和关键文件 SHA256；覆盖范围至少包括启动器、app `package.json`、本地 HTTP 入口、路径解析、本地状态 store、诊断包、进程/sync/rclone 进度/profile import 运行模块、客户端 launcher 源文件、客户端 UI HTML/JS/CSS、共享 core 入口、接口合同、API 矩阵、部署迁移指南、内部 trial 清单、5-10 人试点 runbook、试点验收标准、试点支持指南、二进制 lock 和内置 sing-box/rclone。客户端诊断包也会摘要展示 manifest 版本、构建时间和解析状态，方便支持人员判断用户是否运行了正式交付包。manifest 的文件名必须是规范包内相对路径，不得重复、不得使用绝对路径或 `..`，也不得登记 `data/`、`.env` 等运行态或密钥路径。交付 ZIP 时同时保留 `.sha256` 文件。现场可用 `Get-FileHash dist/SyncraftDesktop.zip -Algorithm SHA256` 或 `Get-FileHash dist/SyncraftClient.zip -Algorithm SHA256` 与对应 `.sha256` 文件首列比对，确认包未损坏或传错版本。

## 8. 测试

```powershell
pnpm test
```

交付或升级前运行只读发布检查：

```powershell
pnpm run preflight:release
```

该检查会拒绝常见运行态和密钥路径，例如真实 `.env`、`server/data/`、`server/sing-box/config.json`、客户端发行包运行数据和临时升级包；如果已生成客户端桌面包或便携目录包，会自动运行 `pnpm run smoke:client-package` 对应的包结构检查，其中桌面包额外覆盖 Electron 安全桥，便携包覆盖 `runtime/node.exe`。客户端 ZIP 会校验 `.sha256` 是否成对且哈希匹配，并读取 ZIP 中央目录确认包含包根目录、`release-manifest.json`、支持文档、关键运行文件和内置组件，同时拒绝 `data/` 等运行态条目。正式发布检查末尾的 `Preflight report` 不应出现 skipped；如果本地未生成客户端包会直接失败。只有 quick/`-AllowSkips` 开发自检可把缺包或 `-SkipTests` 记录为 skipped。

如需生成可交接的报告文件：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/preflight-release.ps1 -ReportPath reports/preflight.txt
```

如需同时生成机器可读报告：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/preflight-release.ps1 -ReportPath reports/preflight.txt -JsonReportPath reports/preflight.json
```

JSON 报告包含 `schemaVersion`、`ok`、`releaseOk`、`context`、`summary` 和 `steps`。正式发布门禁必须检查 `releaseOk: true`（等价于 `summary.failed == 0 && summary.skipped == 0`）；quick/`-AllowSkips` 自检即使退出码为 0，只要存在 skipped，`ok` 和 `releaseOk` 都会是 `false`，不得作为发布放行依据。

当前测试覆盖：

- VLESS URI 解析
- sing-box 客户端配置生成
- rclone 命令生成
- rclone 速度/进度解析
- SyncKey 生成与兑换
- 服务端 bucket/设备心跳
- 客户端 profile 导入

## 9. 迁移生产状态

如果要迁移正在使用的生产状态，另外备份：

```text
server/data/app/sfsc-state.json
/ssd/sfsc-test/minio/
server/sing-box/config.json
server/.env
```

以上路径适用于 N1。通用 compose 若仍使用项目内对象目录，应以实际 compose 的 `/data` 挂载源为准；迁移前必须通过 `docker inspect` 确认真实源目录，不能根据旧文档猜测。状态文件、对象存储、sing-box 配置和 `.env` 必须取自同一个停写窗口。

如果只是迁移项目给别人继续开发，不建议包含这些运行数据和密钥。
