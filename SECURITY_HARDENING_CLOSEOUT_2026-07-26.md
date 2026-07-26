# Syncraft 安全加固工程结项交付报告

- **项目**：Syncraft（`singbox-folder-sync` v0.3.0-rc.1）
- **工程周期**：2026-07-25 审查 → 2026-07-26 收尾
- **范围**：白盒安全审查（约 1.4 万行 JS）+ P1 全量修复 + P2 全量可代码修复项
- **结项状态**：✅ 代码工程全部完成；4 项遗留均需用户决策/行动（见 §四）
- **配套文档**：审查报告与逐项实施记录见 `SECURITY_REVIEW_2026-07-25.md`（§六 P1、§七 P2）

---

## 一、成果总览

| 阶段 | 条目 | 结果 |
|------|------|------|
| 白盒审查 | 服务端 / 客户端 / Electron / core / 供应链 | 0 个 P0，6 个 P1，24 个 P2 |
| P1 修复 | S-1、C-1、C-2、C-3、C-4、D-1 | 6/6 完成（D-1 中 Authenticode 待证书决策）|
| P2 修复（第一批）| S-2~S-7、CORE-1/2/5、C-6、D-2/D-3 | 全部完成或按设计裁定 |
| P2 修复（第二批）| CORE-3、CORE-4、C-7、E-1、E-2、D-5 | 全部完成 |
| 结项测试 | 全部 10 个测试文件 410 条用例 | 390 通过；20 个失败全部为环境限制/既有长红，**零回归** |

安全基线变化（审查报告原文三条主线的收敛情况）：

1. **"默认不安全" → 默认 fail-closed**：管理 Token 缺省拒绝启动；生产模式拒绝占位管理 Token 与占位 MinIO root 密码；compose 密钥全部 `:?` 强制注入；心跳/兑换双限速。
2. **凭证暴露面 → 全链收紧**：密钥移出 argv 改环境变量注入；secrets.json/rclone.conf/sing-box 配置 ACL 收紧且写入前先上 ACL（关闭明文窗口）、失败显式报错；错误信息/诊断包/管理摘要多层脱敏。
3. **信任根缺失 → 多层钉定**：二进制 SHA-256 lock 不可静默绕过（`-AllowUnverified` 显式豁免 + UNVERIFIED 警告）；lock 纳入 buildId 指纹；全部 Docker 基础镜像 tag@digest 双钉定；appliance rclone 与客户端 lock 版本强制对齐；分离式签名落地（Authenticode 待证书）。

---

## 二、提交清单（本工程共 14 个提交，均在 main）

### P1（2026-07-25）
| 提交 | 内容 |
|------|------|
| `8399e93` | P1 六项：S-1 管理 Token 默认强制；C-1 Host 白名单防 DNS rebinding；C-2 凭证文件 ACL；C-3 密钥移出命令行；C-4 信号处理防孤儿进程；D-1 分离式签名 |
| `bc437a3` | scheduler：`computeNextRun` 按归一化 mode 判定 startup（修复过程中发现的正确性 bug）|
| `1673bf8` | 审查报告 + §六 P1 实施记录 + 交付物签名文档 |

### P2 第一批（2026-07-26 上半）
| 提交 | 内容 |
|------|------|
| `8dc637a` | CORE-1 状态锁原子抢占+所有权丢失致命退出；CORE-2 rclone 位置参数注入收敛；S-2/S-4/S-5 信息泄露；S-5 连带 `relayedPublicMessage` 中继修复 |
| `3533659` | CORE-5：nonce 上限 512 + fail-closed（原条目为误报，真实残留是 slice 驱逐）|
| `b3a1644` | S-3：心跳按来源限速，新增稳定码 429 `heartbeat_rate_limited` |
| `b602b9a` | C-6：`writeProtectedTextFileUnlocked` ACL-first 写入，新增 503 `secret_vault_unprotected` |
| `8e9ecc1` | S-6：`signedS3Request` 加 AbortController + `SFSC_S3_TIMEOUT_MS`（默认 15s）|
| `b34737a` | D-2/D-3：版本覆盖须显式 `-AllowUnverified`；`binaries.lock.json` 纳入 buildId 指纹 |
| `a41c206` | §七 第一批实施记录 |

### P2 第二批（2026-07-26 下半）
| 提交 | 内容 |
|------|------|
| `db25794` | CORE-3：入口 schema 嵌套对象白名单 + 标量槽位防走私（心跳透传为 HMAC 设计例外）|
| `2cc23e4` | CORE-4 上：compose 弱占位 MinIO 密码三层 fail-closed |
| `66ef6ed` | CORE-4 下：`CHANGE_ME_CLIENT_SECRET` / http 端点按设计接受，补契约注释 |
| `e2b12bc` | C-7：诊断包 `win32.basename` 修复路径穿透（顺带修复自 `fa51967` 起长红的测试）|
| `1e96f1e` | E-1/E-2：Electron 导航/弹窗封锁 + 双端 UI CSP + nosniff |
| `04159d1` | D-5：全部基础镜像 tag@digest 双钉定；appliance rclone 1.71.1→1.74.3 对齐客户端 lock |
| `d2b3f65` | §七 第二批实施记录 |

新增稳定错误码（已完成 5 点合同链登记：errors.js / error-codes.json / INTERFACE_CONTRACT.md / 双端 formatError 文案）：`heartbeat_rate_limited`(429)、`secret_vault_unprotected`(503)。

新增环境变量：`SFSC_S3_TIMEOUT_MS`、`SFSC_HEARTBEAT_FAILURE_LIMIT`、`SFSC_HEARTBEAT_FAILURE_WINDOW_MS`、`SFSC_HEARTBEAT_RATE_LIMIT_MS`、`*_IMAGE_DIGEST` 系列。**行为变化注意**：`MINIO_ROOT_PASSWORD` 变为必填（compose `:?` 强制），从旧 `.env` 升级前必须先设置强密码。

---

## 三、结项测试结论（2026-07-26，Linux 沙箱）

全部 10 个测试文件 410 条用例逐块跑完：

| 套件 | 结果 | 失败说明 |
|------|------|----------|
| tests/core.test.js | 175/194 | 19 个失败全部为 `spawn powershell ENOENT`（沙箱无 PowerShell，覆盖 N1 部署/preflight/release bundle/二进制下载器/构建指纹/PS 密钥扫描器），属已知环境限制 |
| tests/contract-http.test.js | 41/41 | — |
| tests/client.test.js | 101/101 | 含随 C-7 转绿的历史长红诊断包用例 |
| tests/client-http.test.js | 40/41 | 唯一失败 `bisync conflict split across real process output chunks`，已在无本工程改动的 HEAD 上复测同样红，属既有问题非回归 |
| server-state-lock / singbox-control / appliance-health / appliance-deployment / s3-endpoint / ui-dom-contract | 33/33 | — |
| `audit:release` / `audit:compose` | 通过 | — |

**结论：390/410 通过，20 个失败全部为环境限制或既有长红，本工程零回归。**

---

## 四、遗留事项（均需用户决策或行动）

| 项 | 性质 | 需要什么 |
|----|------|----------|
| **D-4 轮换已入库 SSH 私钥** | ⚠️ 唯一开放的真实安全风险 | 私钥已进 git 历史，代码不可修复。请在服务器侧作废旧钥换新钥，并考虑清理 git 历史或视该仓库为已泄露私钥的载体。**建议最优先处理** |
| D-1 残留：Authenticode 签名 | 待决策 | 需购买代码签名证书；分离式签名（minisign 链）已落地可先行使用 |
| C-5 客户端本地 API 鉴权 token | 待产品决策 | 核心问题是 token 如何交给浏览器 UI（Electron preload 注入 vs 纯浏览器首启配对）。方向确定后可实施 |
| Q-1 / Q-2 重构 | 低优先级 | god 文件拆分与死代码清理，无安全收益，建议稳定后单独排期 |

## 五、待用户环境验证清单（沙箱无法覆盖的部分）

1. **Windows 全量测试**：`pnpm test`（或按套件跑），重点确认 19 条 PowerShell 用例（D-2/D-3 的实际执行路径）转绿。
2. **部署机 / N1 冒烟**：确认 digest 钉定后的镜像可正常拉取构建（`docker compose build/pull`）；appliance 内 rclone 1.74.3 运行正常；升级前先在 `.env` 设置 `MINIO_ROOT_PASSWORD` 强密码（新 compose 缺失即拒绝启动）。
3. **既有长红排查（可选）**：`client-http` 的 bisync 分块用例在真实 Windows 环境验证是否为绿；若仍红按产品 bug 单独立项。

---

*本报告与 `SECURITY_REVIEW_2026-07-25.md` 共同构成本轮安全加固工程的完整交付物。*
