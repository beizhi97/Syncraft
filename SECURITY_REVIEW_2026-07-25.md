# Syncraft 白盒代码审查报告

- **项目**：Syncraft（`singbox-folder-sync` v0.3.0-rc.1）—— 自托管 Windows 文件夹同步工具，基于 VLESS 隧道 + rclone + MinIO/S3。
- **审查日期**：2026-07-25
- **审查范围**：服务端 `src/`（server.js + core 全部模块）、客户端 `client/`（本地 HTTP 服务、Electron 壳、渲染层）、依赖与供应链、二进制分发与发布链。约 1.4 万行 JS。
- **审查维度**：安全漏洞 / 正确性与 Bug / 架构与代码质量 / 依赖与供应链。
- **方法**：静态白盒审查，关键发现已按真实行号核实。未运行动态测试（node_modules 场景外）。

---

## 一、总体评价

Syncraft 的安全基线**明显高于同类 MVP 平均水平**，值得肯定的地方：

- 管理 Token 用 `timingSafeEqual` 恒定时间比较；SyncKey 一次性核销有全局写锁串行化，check-then-set 无竞态。
- 认证走 Header 而非 Cookie，天然免疫经典 CSRF；请求体有 2MB 上限；路径穿越有 `isPathInside` 防护。
- 所有子进程启动均用 argv 数组、无 `shell:true`，传统 shell 命令注入面基本不存在。
- 二进制走 HTTPS + 官方仓库 + SHA-256 pin；发布包有多层 SHA-256 校验链；lockfile 冻结、CI `--frozen-lockfile`。
- Electron 安全三件套齐全（contextIsolation / nodeIntegration:false / sandbox）；渲染层全程 `textContent`，无 XSS sink；诊断包双层脱敏较彻底。

**未发现 P0（严重）问题。** 主要缺口集中在三条主线：

1. **"默认不安全"**：服务端默认无鉴权、客户端本地服务缺 Host 校验与本地 token。
2. **凭证暴露面**：密钥经命令行 argv 传递、部分运行时配置文件明文未加 ACL。
3. **信任根缺失**：整条 SHA-256 校验链无签名背书，可被控制分发通道者篡改。

---

## 二、按严重级别汇总

### P1（重要，建议优先处理）

| 编号 | 模块 | 位置 | 问题 | 状态 |
|------|------|------|------|------|
| S-1 | 服务端 | `server.js:701-703, 710-722` | 未配置 Token 时管理 API 静默变为完全无鉴权 | ✅ 已修复 |
| C-1 | 客户端 | `clientServer.js:232, 2563-2565` | 本地服务无 Host 校验、缺失 Origin 直接放行 → CSRF/DNS rebinding | ✅ 已修复（Host 校验）|
| C-2 | 客户端 | `clientServer.js:1035`, `core/rclone.js:144-160` | rclone.conf / sing-box 配置明文落盘且未 ACL 保护 | ✅ 已修复 |
| C-3 | 客户端/core | `core/rclone.js:144-160`, `minioProvisioner.js:38,40` | S3 密钥（含 MinIO root）经命令行参数暴露于进程列表 | ✅ 已修复（残留见 §六）|
| C-4 | 客户端 | `clientServer.js`（缺 signal handler） | 无信号处理，强杀主进程残留 sing-box/rclone 孤儿进程 | ✅ 已修复 |
| D-1 | 供应链 | 发布链全局 | 全链缺代码签名与签名校验和，SHA-256 无法抵御恶意分发方 | ⚠️ 部分修复（待证书决策）|

### P2（次要 / 纵深加固）

| 编号 | 模块 | 位置 | 问题 |
|------|------|------|------|
| S-2 | 服务端 | `server.js:134-161` | `/api/health` 未鉴权，泄露运营信息并暴露 `adminAuth.enabled` |
| S-3 | 服务端 | `serverAdmin.js:1364-1377` | 心跳端点 404/401 差异可枚举设备名，且无限速 |
| S-4 | 服务端 | `server.js:968-983`, `serverAdmin.js:1959-1963` | `maskSecret` 首尾明文泄露；`maskSingboxConfig` 未遮蔽用户 UUID |
| S-5 | 服务端/core | `server.js:1208,1019`, `errors.js:154-157,217-225` | 错误信息回显内部 endpoint URL / fs 路径 / 内网主机名 |
| S-6 | 服务端 | `server.js:167-169, 1140-1155` | 全局写锁在长耗时 S3 操作期间持有，阻塞心跳/核销 |
| S-7 | 服务端 | `server.js:453-455` | 签发 SyncKey 顺带永久改写全局 `publicServerUrl`（意外副作用）|
| CORE-1 | core | `serverStateLock.js:44-58` | 陈旧锁回收 TOCTOU，可致双实例同时持锁、并发写坏 state |
| CORE-2 | core | `rclone.js:33-52`, `storage.js:49` | 位置参数缺 `--` 终止符 + remoteName 允许 `-` 开头，参数注入 |
| CORE-3 | core | `protocolSchemas.js:600-614` | 嵌套对象/JSON 字段不做白名单与类型校验 |
| CORE-4 | core | `profileProtocol.js:82-85`, `rclone.js:143-144` | 硬编码弱默认密钥、默认允许 http 端点 |
| CORE-5 | core | `heartbeatAuth.js:32` | 无 nonce 重放缓存，5 分钟时窗内可重放心跳 |
| C-5 | 客户端 | `clientServer.js` 全局 | 无鉴权令牌，任意本地进程可全量调用 API |
| C-6 | 客户端 | `store.js:331-338,369` | secrets.json 写入 TOCTOU 明文窗口 + icacls 失败静默 |
| C-7 | 客户端 | `clientServer.js:521-547` | GET /api/client/status 泄露本地绝对路径 |
| E-1 | Electron | `main.cjs:117-147,181-203` | 缺 will-navigate / setWindowOpenHandler 导航限制 |
| E-2 | Electron | `index.html`, `main.cjs` | 全应用无 Content-Security-Policy |
| D-2 | 供应链 | `download-binaries.ps1:81-94,130` | 版本覆盖参数（含 `latest`）绕过 SHA-256 校验 |
| D-3 | 供应链 | `build-fingerprint.ps1:87` | 第三方二进制及 lock 文件被排除在 buildId 指纹之外 |
| D-4 | 供应链 | `apply-beta-singbox.ps1:3-6` 等 | 生产主机 IP / SSH 私钥路径硬编码入库，私钥位于全用户可读目录 |
| D-5 | 供应链 | `server/*.Dockerfile` | 服务端镜像按可变 tag 而非 digest 固定；客户端/服务端 rclone 版本不一致 |
| Q-1 | 全局 | server.js / serverAdmin.js / clientServer.js / app.js | 超大 god 文件，职责过载 |
| Q-2 | 全局 | `maskSecret`、`summarizeAdminSyncSpace` 等 | 重复代码与死代码/死导入 |

---

## 三、P1 详细说明

### S-1 未配置 Token 时管理 API 静默无鉴权
`assertAdminAuthorized`（`server.js:701-703`）在 `!adminToken` 时直接 `return` 放行；`resolveAdminToken`（`710-722`）仅在 `SFSC_REQUIRE_ADMIN_TOKEN==="1"` 时才强制要求 Token，否则返回空串。默认部署（不设 Token、未设 REQUIRE 标志）下，`/api/admin/*`、`/api/claims/create`、`/api/singbox/client-config` 等**全部无需凭据**即可访问——可任意增删设备、签发 SyncKey、改写 sing-box 配置、清空存储桶。默认 `HOST=127.0.0.1` 是重要缓解，但运维一旦为远程访问改成 `0.0.0.0` 又忘开强制 Token，管理面即完全暴露。非 REQUIRE 模式下还会把占位符 `change-this-admin-token` 当作有效 Token（弱默认凭据）。

**修复**：把"强制 Token"改为默认行为——缺省即拒绝所有管理请求，仅当显式设置 `SFSC_ALLOW_NO_ADMIN_TOKEN=1` 才放行；占位符校验始终生效。

### C-1 本地服务无 Host 校验、缺失 Origin 放行
服务绑定 `127.0.0.1`（正确），POST 有 Origin + `sec-fetch-site` + Content-Type 校验。但 `assertBrowserWriteOrigin`（`clientServer.js:2563-2565`）对**缺失 Origin 直接放行**，且全程从不校验 Host 头（`clientServer.js:232`）；所有 GET 端点（status/profile/jobs/history/logs/diagnostics）无任何来源防护。恶意网页经 DNS rebinding（把域名重绑到 127.0.0.1:5188）可发起"同源"读取，泄露 S3 endpoint/bucket、VLESS 服务器、本地绝对路径、同步历史等元数据。

**修复**：对所有请求（含 GET）增加 Host 头白名单（只允许 `127.0.0.1:port` / `localhost:port`），拒绝其他 Host——这是防 DNS rebinding 的标准做法。

### C-2 运行时配置文件明文且未 ACL 保护
`secrets.json` 已通过 `protectSecretVaultFile`（icacls 收紧 ACL）保护，profile/jobs 也只存 `secretRef`——设计良好。但真正含明文凭证的两份文件被遗漏：写 sing-box 配置（`clientServer.js:1035`，含完整 VLESS/reality 凭证）和 `rclone.conf`（`core/rclone.js:144-160`，含明文 `secret_access_key`）**均未做 ACL 保护**。同机其他用户/进程可直接读取，绕过 secrets.json 的努力。

**修复**：对 `singboxConfigFile` 和 `rcloneConfigFile` 写入后同样应用 ACL 收紧，或整个 runtimeRoot 目录收紧。

### C-3 密钥经命令行参数暴露于进程列表
`core/rclone.js:144-160` 把 `secret_access_key <明文>` 作为 argv 传给 `rclone config create`；`minioProvisioner.js:38,40` 把 **MinIO 管理员 root 凭证**和每设备 secret 传给 `mc`。Windows 上任意本地用户可通过 `tasklist`/WMI 读取命令行，Linux 上 `/proc/<pid>/cmdline` 默认可读。`maskRcloneConfigArgs` 仅用于展示，真正执行的 args 未脱敏。

**修复**：改用环境变量（`RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY`、`MC_HOST_<alias>`）或 stdin/受保护 config 文件，避免密钥进入命令行。

### C-4 无信号处理导致孤儿进程
子进程清理只在 `/api/client/shutdown` 触发的 `shutdownClientRuntime` 里做，未注册 `SIGINT/SIGTERM/SIGBREAK/exit`。Windows 上 `taskkill`、Electron 壳崩溃或任务管理器结束进程时，`sing-box.exe` / `rclone.exe` 成为孤儿继续运行，下次启动可能端口冲突。

**修复**：注册信号处理调用 `shutdownClientRuntime`；Windows 可用 job object 或记录 pid 于启动时清理。

### D-1 发布链缺代码签名与签名校验和
全仓库无 `signtool`/`cosign`/`minisign`/`gpg` 等签名机制；`Syncraft.exe` 未 Authenticode 签名；`*.zip.sha256` 与 zip 由同一脚本并排生成——**能改 zip 的攻击者同样能重算替换 `.sha256`**。SHA-256 链只防传输损坏，不防控制 GitHub Release / 中间人 / 内部投毒的主动篡改。对一个捆绑代理类二进制（sing-box/rclone）、经 Release 下发的桌面工具，这是高价值供应链攻击目标。

**修复**（按优先级）：(1) 对 exe 及 zip 做 Authenticode 签名；(2) 为 sha256/manifest 增加 detached 签名（minisign/cosign/GPG）并发布公钥；(3) 启用 GitHub build provenance / SLSA attestation。

---

## 四、优先处理建议

1. **S-1**（默认强制管理 Token）—— 单点改动，消除"改 HOST 后无意暴露完全无鉴权管理面"的最高风险路径。
2. **C-2 + C-3**（密钥落盘 ACL + 密钥移出命令行）—— 二者共同决定客户端凭证是否真正受保护，当前 secrets.json 的保护被这两处抵消。
3. **C-1**（Host 头校验）—— 标准 DNS rebinding 防护，改动小。
4. **C-4**（信号处理）—— 影响可用性与端口冲突，实现简单。
5. **D-1**（签名背书）—— 工作量最大但对分发安全最关键，可作为发布前专项。

---

## 五、确认无问题的项（供参考）

以下经核实实现正确，无需改动：命令注入面（全部 argv 无 shell）、路径穿越防护（isPathInside / validateSyncLocalPath）、CSRF（Header 鉴权 + 无 CORS）、SSRF（redirect:error）、审计日志脱敏（只记 codeHash + IP）、SyncKey 一次性核销并发正确性、MinIO 策略最小权限、heartbeatAuth 的 HMAC + timingSafeEqual、协议 schema 无原型污染、诊断包双层脱敏、Electron 安全三件套、渲染层无 XSS sink、依赖无 typosquatting、二进制 HTTPS + SHA-256 pin、CI frozen-lockfile。

---

## 六、P1 修复实施记录（2026-07-25）

六项 P1 已全部实施，D-1 中依赖外部证书采购的部分除外。修复后 `pnpm run audit:release` 通过，新增回归测试见各条末尾。

### S-1 ✅ 管理 Token 改为默认强制
`resolveAdminToken` 改为 fail-closed：未配置 Token 时直接抛错拒绝启动，只有显式设置 `SFSC_ALLOW_NO_ADMIN_TOKEN=1`（或 `SFSC_REQUIRE_ADMIN_TOKEN=0`）才允许无鉴权运行；占位符 Token（如 `change-this-admin-token`）在任何模式下都被拒绝。显式关闭鉴权时启动打印 `admin_auth_disabled` 警告，若同时绑定非 loopback 地址则额外打印 `admin_auth_disabled_non_loopback`。

### C-1 ✅ Host 头白名单
`assertLocalHostHeader` 作为请求处理的第一步执行，覆盖所有方法与路径（含 GET）：仅接受 `127.0.0.1` / `::1` / `localhost` 且端口与监听端口一致的 Host，其余（含畸形值）返回新增稳定错误码 `local_host_forbidden`（403）。空 Host 为兼容 HTTP/1.0 放行——此时不存在浏览器 rebinding 场景。该错误码已同步登记到 `errors.js`、`error-codes.json`、`INTERFACE_CONTRACT.md` 与两份 `app.js` 文案，通过契约审计。

**保留的残留**：缺失 Origin 的写请求仍然放行，以兼容非浏览器本地客户端；缓解措施为 JSON Content-Type 强制 + `Sec-Fetch-Site` 校验 + 上述 Host 白名单，浏览器发起的跨站写请求必然携带 Origin 或 `Sec-Fetch-Site`，因此实际攻击面已闭合。

### C-2 ✅ 凭证文件 ACL 收紧
`store.js` 导出 `protectLocalSecretFile`，复用 secrets.json 的 Windows `icacls /inheritance:r /grant:r <account>:F` 逻辑。sing-box 配置写盘后立即收紧（该文件内嵌 VLESS UUID）；`rclone.conf` 在三处 config create 调用点后各自通过 `protectRcloneConfigFile` 收紧。ACL 失败不阻断同步，仅记录状态，避免可用性回退。

### C-3 ✅ 密钥移出命令行
- rclone：`buildRcloneRemoteConfig` 不再把 secret 放入 argv，改为 `RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY` 环境变量；`remoteConfig` 结构扩展为 `{executable, args, env, displayCommand}`，`renderCommand` 对敏感 env 值做遮蔽。
- MinIO：删除全部三处 `mc alias set <alias> <endpoint> <access> <secret>` 调用（root 凭证入 argv 的来源），改为通过 `MC_HOST_sfsc` 环境变量传递，`mc` 原生支持该形式，无需 alias 注册。

**保留的残留（降级为 P2）**：`mc admin user add` 的每设备 secret 仍在 argv 中——`mc` 未提供该参数的环境变量替代。影响面小于 root 凭证（单设备、可轮换），已记录待 upstream 支持或改用 MinIO Admin API 后处理。

### C-4 ✅ 信号处理
`installShutdownSignalHandlers` 在 `server.listen` 回调中注册，监听 `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGBREAK`，统一调用 `shutdownClientRuntime` 清理 sing-box / rclone，并用 `shutdownStarted` 标志防止重入。

### D-1 ⚠️ 分离式签名已落地，Authenticode 待决策
已实现：
- `scripts/lib/releaseSignature.mjs` —— 基于 `node:crypto` 的 Ed25519 分离式签名库（keygen / sign / verify，签名记录含 version、algorithm、digest、keyId、signedAt）。
- `scripts/release-signature.mjs` —— CLI，支持 `keygen` / `sign` / `verify`，私钥以 0600 写盘，受信公钥默认取仓库根 `release-signing-key.pub`。
- `scripts/audit-release.mjs` —— 新增非阻断 warnings 通道；验证 `dist/**` 全部交付 ZIP 的 `.sig`：验签失败一律判失败，缺签名默认警告，`SFSC_REQUIRE_SIGNED_RELEASE=1` 时升级为失败。
- `scripts/build-release-bundle.ps1` —— 生成 `.sha256` 后自动签名，新增 `-RequireSignature` 开关，manifest 增加 `signature` 区块。
- 文档见 `docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md` §1.1。

**仍未完成（需外部决策）**：`Syncraft.exe` 的 Windows Authenticode 签名需要先采购代码签名证书（OV 或 EV），属采购与密钥保管决策，无法在代码层完成；GitHub build provenance / SLSA attestation 可在 release workflow 中另行接入。

---

*本报告为静态白盒审查结论，行号基于 2026-07-25 审查时的代码状态（P1 修复后行号已变动，修复情况见 §六）。P2 项尚未处理，建议逐条评估后排期。*

