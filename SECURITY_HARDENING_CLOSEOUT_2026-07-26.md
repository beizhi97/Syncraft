# Syncraft 安全加固工程结项交付报告

- **项目**：Syncraft（`singbox-folder-sync`）
- **工程周期**：2026-07-25 审查 → 2026-07-26 安全结项 → 2026-07-28 跨平台修复与 CI 验证
- **范围**：白盒安全审查（约 1.4 万行 JS）+ P1 全量修复 + P2 全量可代码修复项 + Q-2 清理
- **验证基线**：提交 `b3a48d4`，不可变 tag `v0.3.0-rc.2`，Windows CI 全绿
- **结项状态**：✅ 代码工程全部完成；C-5 与 D-4 已在 §八 处理/降级，剩余仅 Q-1 重构与部署机验证（见 §四、§五）
- **配套文档**：审查报告与逐项实施记录见 `SECURITY_REVIEW_2026-07-25.md`（§六 P1、§七 P2、§八 跨平台与 Q-2）

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

## 三、结项测试结论

### Windows CI（权威结论，2026-07-28）

基线提交 `b3a48d4`（tag `v0.3.0-rc.2`）在 GitHub Actions Windows runner 上 **411 条用例全部通过**，`audit:release` 与 `audit:compose` 均通过。这是唯一的全量判定依据：此前 Linux 沙箱无法覆盖 PowerShell 路径与若干 Windows 运行时行为，正是完整 CI 才暴露出 §八 记录的子进程输出流与心跳并发缺陷。

### Linux 沙箱（开发期辅助）

沙箱缺少 PowerShell，`tests/core.test.js` 中 19 条依赖 PowerShell 的用例恒为 `spawn powershell ENOENT`；这些路径已由 Windows CI 覆盖。其余套件在沙箱内全绿，可用于修改后的快速回归，但不能替代 Windows 全量结论。

**结论：Windows CI 411/411 通过，本工程零回归。**

---

## 四、遗留事项（均需用户决策或行动）

| 项 | 性质 | 需要什么 |
|----|------|----------|
| D-4 轮换 SSH 私钥 | 维护期事项（已降级） | 目标 N1 主机仅内网可达、无公网入口，利用前提是攻击者已在内网，故非紧急。仍建议在某次维护窗口轮换：私钥引用已进 git 历史，若该仓库将来开源或转手，历史无法追溯收回。轮换即删除服务器 `authorized_keys` 中的旧公钥 |
| D-1 残留：Authenticode 签名 | 待决策 | 需购买代码签名证书；分离式签名（minisign 链）已落地可先行使用 |
| ~~C-5 客户端本地 API 鉴权 token~~ | 已处理（方案调整） | 未采纳 token：能在本机执行代码的进程可直接读 `secrets.json`，token 无防御力却需改 213 处调用。改为补齐读接口跨站防护（新增 403 `local_read_forbidden`），使读写防护对称。见审查报告 §八 |
| Q-1 重构 | 低优先级 | god 文件拆分（`server.js` / `serverAdmin.js` / `clientServer.js` / `app.js`），建议单独排期。Q-2 已完成，见审查报告 §八 |

## 五、待用户环境验证清单

1. ~~**Windows 全量测试**~~：已完成。`b3a48d4` 在 Windows CI 上 411/411 通过，含 D-2/D-3 的 PowerShell 执行路径。
2. **部署机 / N1 冒烟**（仍待确认）：确认 digest 钉定后的镜像可正常拉取构建（`docker compose build/pull`）；appliance 内 rclone 1.74.3 运行正常；升级前先在 `.env` 设置 `MINIO_ROOT_PASSWORD` 强密码（新 compose 缺失即拒绝启动）。
3. ~~**bisync 分块用例排查**~~：已定位并修复，为 stdout/stderr 共用解析缓冲导致的真实缺陷，见审查报告 §八。

---

*本报告与 `SECURITY_REVIEW_2026-07-25.md` 共同构成本轮安全加固工程的完整交付物。*
