# Windows 本地 SFTP 普通目录适配探针

日期：2026-10-19  
状态：P2 隔离研究完成；默认 `size,modtime` bisync 技术闸门 **blocked**，checksum 候选路径在本机 fixture 中通过  
结论边界：本文只记录 Windows 本机 loopback 实测，不表示 P1 已验收、P2 已放行，也不代表 N1 或生产 SFTP 行为。

## 1. 实验目的与边界

本实验使用仓库锁定的 Windows `rclone 1.74.3`，验证 `rclone serve sftp` 作为普通目录适配候选时的可观察行为。探针仅监听 `127.0.0.1`，使用随机 loopback 端口、临时 Ed25519 主机/客户端密钥、隔离 `authorized_keys`、`known_hosts`、rclone 配置、缓存和测试数据。

本文结果不能证明：

- N1 ARM64、Linux 或其他真实服务器上的相同行为；
- 公网、sing-box、代理认证或代理路由；
- OpenSSH 或其他生产 SFTP 服务的兼容性；
- 最终目录网关的设备授权、路径授权和事务原子性；
- P1 协议验收或 P2 放行。

## 2. 可重复入口与证据

运行命令：

```powershell
node scripts/probe-sftp-adapter.mjs
```

脚本：

- `scripts/probe-sftp-adapter.mjs`

最终运行：

- 时间：`2026-10-20T05:00:30.436Z` 至 `2026-10-20T05:00:45.444Z`
- Run ID：`6df2728c-f45c-4ab3-a21c-7a0aeee4e0d7`
- 证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T050030-437Z/report.json`
- 汇总：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T050030-437Z/README.md`

上一轮已完成比较引擎与双向收敛语义修正：

- 时间：`2026-10-20T04:57:34.008Z` 至 `2026-10-20T04:57:48.640Z`
- Run ID：`f2590178-6cec-4f4b-9eb7-5cce8d384d86`
- 证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T045734-010Z/report.json`

最终运行结果：

- 总体状态：`blocked`
- harness failure：`0`
- 服务进程已退出，PID 不再存活；
- 隔离工作树、密钥、配置、缓存和测试数据已删除；
- 四份运行报告均未发现私钥内容或授权公钥内容。

## 3. Harness 修正记录

旧报告全部保留，用于审计 harness 演进。

### 3.1 首轮失败

证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T045301-398Z/report.json`

首轮失败来自 harness，而非已证明的生产缺陷：

- bisync 远端目标目录未先通过远端创建；
- 外部改写读回使用了同尺寸的旧本地目标文件；
- `ssh-keygen -V` 被 OpenSSH 解释为有效期参数。

### 3.2 第二轮阻断

证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T045400-382Z/report.json`

第二轮仍有两处影响结论的 harness 问题：

- bisync 初始化固定使用 `size,modtime`，第二次才切换比较模式；
- 双向同步的期望被错误写成“远端恢复为原始内容”，正确期望是远端唯一变更传播到本地，两端最终都为改写内容；
- 外部同尺寸改写后的读回错误没有独立隔离目录缓存变量。

第二轮中“checksum 场景检测后要求 `--resync`”的结论不能成立，已撤回。

### 3.3 比较语义修正

证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T045734-010Z/report.json`

该轮修正为：

1. bisync 初始化和第二次运行使用同一 `compareMode`；checksum 场景在两次运行中均显式使用 `--checksum`。
2. 双向同步按远端唯一变更传播到本地、两端最终一致的语义判定。

该轮的单文件目录只有 `collision.bin`。远端唯一文件变化使 checksum 场景触发：

```text
Safety abort: all files were changed on Path2.
Run with --force if desired.
Bisync aborted. Please try again.
```

这是“目录中全部文件都变化”的安全闸门，不应归类为 checksum 或 SFTP 后端不支持。该轮没有执行 `--force` 或自动 `--resync`。

### 3.4 最终 canary 与 cache-zero 修正

证据：`.tmp/development-2026-10-19/p2-sftp/2026-10-20T050030-437Z/report.json`

最终运行只补两处：

1. 两个 bisync 场景在初始化前均加入两个始终不变的普通文件 `canary-a.txt`、`canary-b.txt`，随后只改写远端 `collision.bin`；
2. 外部缓存验证改为另起一个从启动即使用 `dir-cache-time=0` 的新服务，依次读取 A、外部同尺寸覆盖为 B、不重启再次读取 B。

未使用 `--force` 或自动 `--resync`，未增加其他探针类别。

## 4. 已确认事实

### 4.1 二进制与服务隔离

| 项目 | 实测结果 |
|---|---|
| rclone | `rclone v1.74.3` |
| 文件大小 | `78,717,440` bytes |
| SHA-256 | `3ac0dba3a883555f0c0daabc8a87c8f78e531f339780335e07beadf77734b5bc` |
| lock 匹配 | SHA-256 和版本均匹配 |
| ssh-keygen 所在 OpenSSH | `OpenSSH_for_Windows_9.5p2`、`LibreSSL 3.8.2` |
| 监听 | 仅 `127.0.0.1`，随机空闲端口 |
| 认证 | 临时 Ed25519 公钥，通过隔离 `authorized_keys` |
| 主机校验 | 使用隔离 `known_hosts` 验证服务器主机密钥 |
| 初始服务参数 | `dir-cache-time=1s`、`poll-interval=0`、`vfs-cache-mode=off` |

### 4.2 SFTP 能力与上传可见性

`rclone backend features probe:` 报告：

- `Hashes`: `["md5", "sha1"]`
- 实际 MD5 和 SHA-1 均与本地计算值匹配。

1 MiB 文件以 `256Ki` 限速上传，25 ms 间隔采样：

| 场景 | 临时文件 | 最终名部分内容 | 最终内容 |
|---|---|---|---|
| `rclone copy` | 观察到 `copy-upload.bin.*.partial` | 未观察到 | SHA-256 匹配 |
| 初始 `rclone bisync --resync --resync-mode path1` | 观察到 `bisync-upload.bin.*.partial` | 未观察到 | SHA-256 匹配 |

“未观察到最终名部分内容”只代表本次采样窗口中的结果，不构成跨平台原子提交保证。

### 4.3 单向 checksum 检测与修复

4 KiB 文件在本地和远端具有相同尺寸和整秒 mtime，远端内容被直接改写：

| 项目 | 结果 |
|---|---|
| `rclone check --checksum` | 参数被接受，检测到差异 |
| `rclone copy --checksum` | 将远端恢复为本地原始内容 |
| 原始 SHA-256 | `6896d9ea3f73a4434f5832bc65714e7d066f177373f36f34dc8a6f735daa41b1` |
| 改写 SHA-256 | `725bcd6c66d02acf6ebeab9c92410e010ea22e336876256aaf05a211f4ce1902` |

该结果证明单向 `copy --checksum` 在本次 SFTP 场景中能够发现并修复同尺寸同秒改写。

### 4.4 双向 bisync 对照

最终 fixture 在初始化前同时存在：

- `collision.bin`：4096 bytes，远端随后改写为同尺寸内容；
- `canary-a.txt`：两端始终不变；
- `canary-b.txt`：两端始终不变。

collision 的原始 SHA-256 为 `6896d9ea3f73a4434f5832bc65714e7d066f177373f36f34dc8a6f735daa41b1`，改写 SHA-256 为 `725bcd6c66d02acf6ebeab9c92410e010ea22e336876256aaf05a211f4ce1902`。

| 场景 | 初始化与第二次比较 | 第二次退出码 | collision 最终结果 | canary 结果 |
|---|---|---|---|---|
| 默认比较 | 两次均为 `--compare size,modtime` | `0` | 本地原始 A，远端改写 B，未收敛 | 两端均未变 |
| checksum 比较 | 两次均为 `--compare size,modtime,checksum --checksum` | `0` | 本地和远端均为改写 B | 两端均未变 |

checksum 场景只改写了一个远端文件，两个 canary 始终未变，因此没有触发“全部文件变化”安全闸门。rclone 将该远端变化传播到本地，两端 collision 的最终 SHA-256 均为改写内容。

当前证据支持：

- 默认 `size,modtime` 比较仍会静默漏掉同尺寸同整秒 mtime 的远端内容变化；
- `--compare size,modtime,checksum --checksum` 在本次三文件 fixture 中能够检测并传播远端唯一变化；
- checksum 模式没有改变两个 canary；
- 本轮没有执行 `--force` 或自动 `--resync`；
- 单文件目录触发的“全部文件变化”安全中止是预期保护，不是数据一致性失败，也不是 checksum 不可用。

### 4.5 外部直接修改与目录缓存

默认 1 秒缓存服务中，64 KiB 随机文件被直接写入服务根，随后保持尺寸不变改写：

| 项目 | 结果 |
|---|---|
| 初始文件读取 | 成功，SHA-256 匹配 |
| 同尺寸改写后的读取 | 失败，`corrupted on transfer: md5 hashes differ` |

随后停止该服务，另起一个从启动即使用 `dir-cache-time=0` 的新服务，并在独立目录执行：

1. 创建 65536 字节、内容全为 `A` 的文件；
2. 通过 SFTP 首次读取，实际内容和 SHA-256 均匹配 A；
3. 在服务根外部直接同尺寸覆盖为内容全为 `B`；
4. 不重启服务，再次通过 SFTP 读取，实际内容和 SHA-256 均匹配 B。

| 项目 | 实测值 |
|---|---|
| 服务从启动即使用 `dir-cache-time=0` | 是 |
| A 读取与 B 覆盖之间重启服务 | 否 |
| A 内容 | 65536 个 ASCII `A` |
| A SHA-256 | `156c38442089c1323d3e3ba549a6ac24341c47e8b6367bec4740c9b8c865826e` |
| B 内容 | 65536 个 ASCII `B` |
| B SHA-256 | `fee47b1f0d7685a226fd5f2b9dd8f525038bbb05fe9d89a5d75c249edac868e3` |
| A 与 B 读取均匹配 | 是 |

该实验将 `dir-cache-time=0` 与“读取失败后重启”两个变量分开，证明在本次 `rclone serve sftp` Windows loopback 配置中，cache-zero 新服务可在不重启的情况下读到同尺寸覆盖后的 B。该结果仍不能直接推广到其他 SFTP 服务、N1 或生产配置。

### 4.6 根目录逃逸与代理声明

- Windows junction 创建成功；
- 本地可通过 junction 读取服务根外的标记文件；
- 通过 SFTP 远端 listing 和读取均无法访问该标记；
- 本次默认 VFS 链接行为未观察到根目录逃逸。

锁定版 rclone 的 SFTP 后端帮助声明了 `socks_proxy` 和 `http_proxy` 选项。本轮没有启动代理，因此代理认证、SOCKS5 路由和 HTTP CONNECT 路由均未验证。

## 5. 已实测阻断项与已定位保护

### 5.1 当前阻断项

- 默认 `--compare size,modtime` bisync 会静默漏掉远端同尺寸同整秒 mtime 的内容变化；
- 如果产品允许普通 bisync 使用该默认比较语义，则不能把 SFTP 候选视为满足双向内容一致性要求。

### 5.2 已定位为保护或可配置行为

- 单文件目录中 100% 文件变化触发 bisync 安全中止，属于预期保护；旧报告保留该事实；
- 加入两个不变 canary 后，checksum bisync 成功传播唯一的 collision 变化；
- 默认 1 秒目录缓存下，外部同尺寸覆盖后的读回可能触发 MD5 不一致；
- 从启动即使用 `dir-cache-time=0` 的新服务在本次 fixture 中成功读取 A 和随后无重启读取 B。

## 6. 未验证事项

- checksum bisync 在多文件、多目录、删除、重命名和并发冲突中的行为；
- 是否允许 `--force`，以及 `--force` 对真实多文件目录的影响；
- `--resync` 或 `--resync-mode` 作为恢复手段的数据安全边界；
- OpenSSH、其他生产 SFTP 服务、不同目录缓存和不同 hash 命令的行为；
- `dir-cache-time=0` 在 N1、真实网络、长期运行和掉电场景中的性能与一致性；
- N1 ARM64、Linux、公网、代理认证和代理路由；
- 25 ms 采样是否能捕获所有短暂最终名部分状态；
- 最终网关授权、staging 事务和原子提交语义。

## 7. 当前结论

【已确认事实】本轮 Windows loopback 证据下，SFTP 的 MD5/SHA-1、单向 checksum 修复、checksum bisync 的唯一远端变化传播、canary 保持、cache-zero 外部同尺寸覆盖读取和根目录逃逸拒绝均可工作。默认 `size,modtime` bisync 仍会静默漏检。

【合理推断】SFTP 候选的底层同步问题可能通过明确采用 checksum 比较语义解决，而不是由后端本身阻断。P2 技术闸门仍应保持 blocked，直到产品明确是否允许 checksum bisync，并完成多文件、冲突、缓存和 N1 验证。

【建议】若继续 SFTP 路线，应把 checksum 比较或等价内容指纹作为显式设计条件，同时保留“全部文件变化”安全闸门；不得把 `--force`、自动 `--resync` 或 cache-zero 视为未经更多验证即可启用的生产修复。
