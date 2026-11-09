# Syncraft

> 将 Windows 普通目录与自托管 N1/Linux 目录安全双向同步的工具，通道配置码与设备身份验证码分步使用。

普通目录模式面向 N1/Linux 主机上由管理员开放的既有目录。客户端先导入管理员签发的**通道配置码**建立受信任接入通道，再提交设备身份申请；管理员在控制台勾选授权目录并独立签发**一次性身份验证码**后，用户在客户端完成核验、选择获授权目录与 Windows 本地文件夹、处理首次双向冲突（支持一键保存双方版本）并显式确认初始化，随后即可执行手动或定时自动同步。通道配置码建立接入通道，身份验证码验证设备身份并绑定目录授权，两者职责分离、不可互换。同步流量仅由受管理的同步子进程通过本地数据通道传输，不修改系统代理、路由、DNS、TUN 或防火墙。

当前版本建立在完整产品化基线之上，已完成目录优先（Ordinary-Directory Appliance）全链路重构、白盒安全加固、严格发布预检（`37 pass / 0 warn / 0 fail`）、1011 项单元与契约测试及 Windows + N1 隔离容器端到端验收闭环。Windows 客户端以免安装便携式 ZIP 包形态交付（默认推荐 Electron 桌面端 `SyncraftDesktop.zip`，同时提供 Node 便携回退包 `SyncraftClient.zip`）。N1 普通目录部署入口见 [`server/DEPLOYMENT.md`](server/DEPLOYMENT.md)，安装脚本为 `server/install-n1-directory-appliance.sh`。

本版在既有安全加固基线（管理 Token 默认强制、凭证不经命令行传递、密钥文件写入前收紧 ACL、心跳与兑换限速、本地读写接口拒绝跨站浏览器请求、二进制与容器镜像按哈希/digest 钉定，详见 [`SECURITY_REVIEW_2026-07-25.md`](SECURITY_REVIEW_2026-07-25.md) 与 [`SECURITY_HARDENING_CLOSEOUT_2026-07-26.md`](SECURITY_HARDENING_CLOSEOUT_2026-07-26.md)）之上，新增了 Go 原生 SFTP 与关系守护服务（`sfsc-sftp-service` / `sfsc-relation-supervisor` / `sfsc-root-guard`）、Linux 目录根不可变标记（`.sfsc-directory-root.json`）保护、授权关系/设备撤销实时终止在途传输（`SIGTERM`）以及连接修复与无损重配能力。

MinIO/S3 仍作为兼容模式保留，可从 [`docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`](docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md) 查阅旧部署与迁移说明；普通目录模式不依赖或部署 MinIO。两种 appliance 模式共享状态和端口，不能同时运行，切换前请按部署文档核对服务状态。

## 用户交付入口与当前发布版本

本仓库（[beizhi97/Syncraft](https://github.com/beizhi97/Syncraft)）是开发主仓库，统一维护客户端、服务端、Go/C++ 原生组件、共享协议和测试，并在 [GitHub Releases](https://github.com/beizhi97/Syncraft/releases) 提供完整发布资产。普通使用者也可按角色直接前往独立交付仓库：

- **[Syncraft-client](https://github.com/beizhi97/Syncraft-client)**：Windows 客户端用户下载仓库，可直接从 [Releases](https://github.com/beizhi97/Syncraft-client/releases) 下载已打包并通过严格预检的 `SyncraftDesktop.zip` 与 `SyncraftClient.zip` 及同名 `.sha256` 校验文件。
- **[Syncraft-server](https://github.com/beizhi97/Syncraft-server)**：服务端部署交付仓库，包含已展开的 N1/Linux 普通目录模式与兼容模式部署文件（`install-n1-directory-appliance.sh`、`DEPLOYMENT.md`、`systemd/`、`runtime/` 等）。

## 适合谁使用

- 想在 N1/Linux 主机上直接开放既有普通目录，并从 Windows 设备安全双向同步的个人或小团队。
- 需要将“通道接入配置”与“设备身份及目录授权”分步管控，并在服务端重设连接配置后完整保留客户端既有任务与双向同步基准的用户。
- 需要保留既有 MinIO/S3 部署的存量用户；该路径仍作为兼容模式完整保留。

## 核心能力总览

- **N1/Linux 普通目录 Appliance**：管理员直接登记主机上已存在的目录，服务端按设备授权关系提供受 `sfsc-root-guard` 与 `sfsc-relation-supervisor` 隔离的原生 SFTP 数据通道，无需额外部署对象存储。
- **分步双码首次接入**：第一步导入通道配置码并提交设备耐久公钥签名的身份申请；第二步输入管理员签发的一次性身份验证码，自动拉取已授权目录范围与允许的同步方向。
- **Windows 原生文件夹选择与首次双向冲突保护**：Electron 桌面端内置原生文件夹选择器（`选择本地同步文件夹`）；首次双向同步前自动扫描双端同名异内容冲突，支持一键“保存双方版本”（带崩溃恢复日志），并须用户显式点击“初始化双向”后才建立双向同步基线。
- **一键连接修复与无损通道重配**：客户端内置一键“修复连接”（支持并发互斥保护与中断探测文件自动清理）及自有 `sing-box.exe` 进程异常退出自动重试；服务端一键重设连接配置并签发新通道码后，客户端无需删除既有任务或重建双向同步基线即可平滑恢复同步。
- **实时权限吊销与历史版本恢复**：管理员撤销单个目录授权关系或停用设备时，服务端实时向对应在途传输会期发送 `SIGTERM` 立即终止，不影响同设备其他授权目录或其他正常设备；支持从客户端历史版本恢复被远端误删的文件及按需调优传输并发参数。
- **全链路脱敏可观测性**：主界面实时展示速率、传输量、当前文件与最近同步状态；设置抽屉支持组件检测、协议兼容性核对、同步历史/日志查看及一键导出脱敏诊断包。

## 使用教程

下面按“管理员部署 N1 普通目录服务，Windows 用户完成双码接入与首次同步”说明。切勿将完整通道配置码、一次性身份验证码、管理 Token 或私钥发到聊天群、Issue 或截图中。

### 1. 管理员部署服务端

准备一台运行 Docker 和 systemd 的 N1/Linux 服务器，并由管理员预先创建要开放的主机目录。按 [普通目录部署文档](server/DEPLOYMENT.md) 准备 `.env.directory`，使用 `server/install-n1-directory-appliance.sh` 安装（可先用 `SFSC_DIRECTORY_CHECK_ONLY=1` 预检路径和环境配置）：

```bash
sudo install -d -m 0750 /srv/syncraft-shares
sudo cp server/.env.directory.example server/.env.directory
sudoedit server/.env.directory
```

设置强随机 `SFSC_ADMIN_TOKEN` 和客户端可访问的服务端公网/局域网地址（普通目录模式无需填写 S3/MinIO 密钥）。执行安装：

```sh
sudo sh server/install-n1-directory-appliance.sh /srv/syncraft-shares
```

登录管理控制台后按“首次配置”向导顺序完成：

1. **开放目录**：登记主机上预先创建的共享目录（服务端会自动写入并保护 `.sfsc-directory-root.json` 标记）。
2. **生成通道配置码**：填写外部连接地址，应用连接设置并生成通道配置码发给客户端用户。
3. **接收设备申请**：用户在 Windows 客户端导入通道配置码并提交设备身份申请。
4. **勾选授权目录并签发身份验证码**：在控制台“设备申请”列表中为该申请选择一个或多个获授权目录，签发一次性身份验证码。
5. **完成配对**：用户在客户端输入一次性身份验证码，即可在授权目录范围内配置同步任务。

普通目录安装不会停止或删除已有 MinIO 容器。若旧 S3 appliance 已启用，切换时请按部署文档执行显式替换步骤，不要同时启动两种 appliance unit。

### 2. 校验并启动 Windows 客户端

从 [Syncraft-client Releases](https://github.com/beizhi97/Syncraft-client/releases) 或主仓 Release 下载 `SyncraftDesktop.zip` 和同名 `SyncraftDesktop.zip.sha256`。先在 PowerShell 中核对 SHA-256 哈希，再解压到用户可写且不会被清理的固定目录（例如 `C:\Tools\Syncraft\`），切勿直接在压缩包预览目录、临时目录或系统受保护目录中运行：

```powershell
Get-FileHash -LiteralPath .\SyncraftDesktop.zip -Algorithm SHA256
```

解压后双击运行：

```text
SyncraftDesktop\Syncraft.exe
```

首次启动时，客户端会展示分步首次接入向导，等待导入通道配置码。

![Syncraft 首次启动实际截图](docs/images/client-first-run.png)

### 3. 导入通道配置码并完成身份验证

1. 在客户端粘贴管理员提供的**通道配置码**，填写设备名称并点击提交身份申请。
2. 管理员在服务端控制台为该申请勾选授权目录并生成**一次性身份验证码**。
3. 在客户端输入该一次性身份验证码完成核验（通道配置码用于建立连接，身份验证码用于核验设备身份与拉取目录授权，请勿混用）。

### 4. 选择同步目录、处理首次冲突并启动同步

身份核验通过后，客户端会自动展示服务端授予的目录范围与允许的同步方向：

1. **选择授权目录**：从服务端已授权目录列表中选择目标同步目录（客户端不允许填写未授权的服务端路径）。
2. **选择本地文件夹**：点击“浏览…”通过 Windows 原生文件夹选择器选择本地同步目录，或直接粘贴本地路径。
3. **同步方向与计划任务**：同步方向由服务端授权自动决定或限定；首次运行建议先保持手动模式完成首次同步验证，随后可切换为间隔（如每分钟/每 5 分钟）、每日或启动时自动同步。
4. **首次双向冲突检查与显式初始化**：首次执行双向同步前，客户端会先执行双端冲突扫描。若双端存在同名不同内容文件，可一键点击**“保存双方版本”**保留两份副本，再点击**“初始化双向”**建立双向同步基准，随后即可正常执行双向增量同步。
5. **连接修复与通道重配**：日常使用中若遇网络波动可点击**“修复连接”**自检恢复；若服务端更改端口或密钥并签发了新通道配置码，直接导入新通道配置码即可沿用既有授权关系、本地任务与双向同步基准，无需删除任务或重新初始化。

![同步任务配置实际截图](docs/images/client-task-setup.png)

自动同步按用户保存的调度计划运行；每次触发前都会重新验证当前任务授权、安全计划、目录 marker 与既有双向基准，任何需要人工确认的首次初始化操作绝不会由调度器静默执行。

### 5. 查看进度与排障

主界面实时显示传输速度、已传输字节、当前文件、最新同步结果以及历史恢复版本列表。点击右上角“设置”可查看 `sing-box` / `rclone` 组件状态、发布清单摘要、同步历史与运行日志，并支持一键导出脱敏诊断包。

遇到异常时建议按以下顺序排查：

1. 核对客户端 ZIP 的 SHA-256 与 `.sha256` 文件一致。
2. 在客户端“设置 -> 组件检测”中确认 `sing-box.exe` 与 `rclone.exe` 校验正常。
3. 使用主界面“修复连接”检测控制通道与 SFTP 数据通道可达性，并查看稳定错误码提示。
4. 导出脱敏诊断包，先备份本地 `data/` 目录后再按文档处理本地状态恢复。

常见稳定错误码与恢复步骤见 [部署与迁移指南](docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md#4-windows-客户端本地状态恢复) 与 [试点支持指南](docs/PILOT_SUPPORT_GUIDE.md)。

## 开发与构建

开发环境需要 Windows、Node.js 24、pnpm 9；部署或容器化验证服务端时需要 Docker。

```powershell
pnpm install
pnpm test
pnpm run client:start      # 启动本地客户端服务，访问 http://127.0.0.1:5188/
pnpm run client:desktop    # 启动 Electron 桌面窗口
```

改动 UI 后如需重截 README 截图，见 [截图说明](docs/images/README.md)；`pnpm docs:seed-screenshot` 会把客户端送进截图所需状态，不必先跑一台服务端。

构建 Windows 桌面包：

```powershell
pnpm install
pnpm run client:download-binaries
pnpm run client:desktop-package
```

构建输出：

```text
dist/SyncraftDesktop/Syncraft.exe
dist/SyncraftDesktop/release-manifest.json
dist/SyncraftDesktop.zip
dist/SyncraftDesktop.zip.sha256
```

旧式 Node 便携包仍可用 `pnpm run client:package` 生成。下载的 `sing-box.exe` 和 `rclone.exe` 不纳入源码仓库；构建时会按照 `client/resources/bin/win32/binaries.lock.json` 下载并校验 SHA-256。

## 发布前检查

提交前运行：

```powershell
pnpm run ci:verify
```

它会执行发布审计和全量 Node 测试。需要验证已经构建的双客户端包时，再运行：

```powershell
pnpm run preflight:release
```

严格预检要求 `dist\SyncraftDesktop` 与 `dist\SyncraftClient` 都存在且通过客户端包 smoke；它会生成可追溯的 JSON 报告。发布、N1 部署和验收证据的完整流程见 [部署与迁移指南](docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md)。

已启动的客户端可执行只读 smoke：

```powershell
pnpm run smoke:client
node scripts/smoke-client.mjs --base-url http://127.0.0.1:5188 --json-report reports/client-smoke.json
```

`smoke:client` 检查已经运行的客户端本地服务；`smoke:client-package` 检查已经构建出的发行包目录。

### 发布交付与验证

需要将源码、文档、双客户端 ZIP、manifest 和预检报告收集为本地交付包时，运行：

```powershell
pnpm run bundle:release
```

输出位于 `dist/release-bundles/`，包含 `release-bundle-manifest.json`、同名 ZIP 和 `.sha256`。bundle 会排除 `.env`、`server/data`、真实 `server/sing-box/config.json`、客户端运行态 `data/`、`.tmp` 和 `node_modules`。

manifest 的 `preflightVerified` 和 `preflightVerification` 字段是发布放行判断入口。`preflightVerification.mode: "external"` 表示 release workflow 已注入上游严格预检证据；该证据会作为交付自证明进入 bundle。

GitHub 的 `.github/workflows/ci.yml` 执行发布审计与全量测试；`.github/workflows/release.yml` 构建桌面包和便携包、运行严格预检，并显式检查 `releaseOk: true`、`skipped: 0` 和双包 smoke 报告。release workflow 会上传 ZIP、`.sha256`、`release-manifest.json`、`reports/release/**` 和 `dist/release-bundles/**`。

## 项目结构

```text
src/                 服务端 API、双码授权、连接修复与共享核心逻辑
public/              服务端管理控制台（含首次配置向导、目录登记、配对与修复）
client/              Windows 本地 API、Electron 桌面壳、客户端 UI 与打包脚本
native/              Go 原生服务（sfsc-sftp-service / sfsc-relation-supervisor / sfsc-root-guard）与 C++ 锁组件
server/              N1 普通目录与兼容模式 appliance、systemd 单元、运行时启动器与部署脚本
tests/               Node 契约、安全、UI 与端到端行为测试
docs/                接口合同、API 矩阵、协议 Schema、架构与部署文档
scripts/             CI、发布审计、smoke、打包与 N1 自动化脚本
```

## 文档导航

- [接口合同](docs/INTERFACE_CONTRACT.md)：客户端和服务端 API、双码入网、目录授权、SyncKey、profile、心跳与稳定错误码的唯一基线。
- [API 矩阵](docs/API_MATRIX.md)：双端路由与调用方。
- [普通目录部署指南](server/DEPLOYMENT.md)：N1/Linux 普通目录 appliance 部署、升级与排障说明。
- [目录根安全合同](docs/DIRECTORY_ROOT_CONTRACT.md)：普通目录根标记（`.sfsc-directory-root.json`）与路径边界约束。
- [部署与迁移指南](docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md)：Docker、N1、客户端状态恢复、升级和发布。
- [SyncKey 协议](docs/T_KEY_PROTOCOL.md)：旧 S3/MinIO 兼容模式的一次性授权格式和生命周期。
- [软件设计说明](docs/SOFTWARE_DESIGN_SPEC.md)：整体设计。
- [内部试运行清单](docs/INTERNAL_TRIAL_CHECKLIST.md) 与 [试点运行手册](docs/PILOT_RUNBOOK.md)：面向小范围试用与支持。

修改任一 `/api/*` 路由、SyncKey/profile/heartbeat 字段、稳定错误码、诊断字段或发布包结构时，必须同步更新 `docs/INTERFACE_CONTRACT.md`、`docs/API_MATRIX.md` 和对应合同测试。

## 安全边界

- 不提交 `.env`、`server/data/`、真实 sing-box 配置、本地客户端数据、下载的二进制文件或 `dist/` 产物。
- 管理 Token、通道配置码、一次性身份验证码、SyncKey、VLESS URI、S3/MinIO 密钥和私钥不得进入 `reports/`、Issue、聊天记录或截图。
- 客户端本地状态默认位于 `%LOCALAPPDATA%\Syncraft\data`；排障前先导出诊断包并备份，不要直接删除状态文件。
- 客户端本地 API 只绑定 loopback，并校验 Host 头以阻断 DNS 重绑定；读写接口都拒绝 `Sec-Fetch-Site: cross-site` 的浏览器请求。它**刻意不使用鉴权令牌**——已能在本机执行代码的进程可以直接读取本地凭据文件，令牌无法防御该路径，因此防线是进程边界与文件 ACL，而非 HTTP 层令牌。
- 服务端管理面应置于 HTTPS 反代之后，并始终设置强随机 `SFSC_ADMIN_TOKEN`；MinIO 的 API 与控制台端口默认只绑定 localhost。
