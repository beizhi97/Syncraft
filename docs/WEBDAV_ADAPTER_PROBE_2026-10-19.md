# Windows 本地 WebDAV 普通目录适配探针

日期：2026-10-19  
状态：P2 研究准备完成；适配器技术闸门 **blocked**  
结论边界：本文只记录 Windows 本机 loopback 实测，不表示 P1 已验收或 P2 已放行。

## 1. 实验目的与边界

本实验使用仓库锁定的 Windows `rclone 1.74.3`，验证 `rclone serve webdav` 作为 N1 普通目录适配候选时的可观察行为。实验只启动脚本自己的 `127.0.0.1` 服务，只使用隔离测试数据和随机测试凭据。

本次结果不能证明：

- N1 ARM64 上的相同行为；
- 真实公网、sing-box 或路由链路；
- 最终目录网关的设备授权和路径授权；
- P1 协议验收；
- P2 放行；
- Windows `rename`、N1 `rename` 或未来网关事务的跨平台原子性。

## 2. 可重复入口与证据

运行命令：

```powershell
node scripts/probe-webdav-adapter.mjs
```

该脚本是隔离研究 harness，包含故障注入、采样和证据汇总；生产适配器不应直接复制其结构。

最终运行证据：

- `.tmp/development-2026-10-19/p2-webdav/latest-probe.json`

最终运行结果：

- 13 个探针：6 个 `passed`，7 个 `blocked`，0 个 harness failure；
- 总体状态：`blocked`；
- 脚本因闸门未满足返回非零退出码；
- `rclone serve webdav` 已退出，PID 不再存活；
- 本次隔离运行根已删除；
- 运行结束后未发现残留 `rclone.exe` 进程。

## 3. 已确认事实

### 3.1 二进制与服务隔离

| 项目 | 实测结果 |
|---|---|
| rclone 版本 | `rclone v1.74.3` |
| 文件大小 | `78,717,440` bytes |
| SHA-256 | `3ac0dba3a883555f0c0daabc8a87c8f78e531f339780335e07beadf77734b5bc` |
| lock 匹配 | SHA-256 和版本均匹配 |
| 服务监听 | 仅 `127.0.0.1:0`，实际端口由系统分配 |
| 认证 | 未认证 GET 返回 HTTP `401` |
| 凭据 | 服务端使用隔离 htpasswd verifier；客户端使用环境变量中的 obscured 值；原始随机密码未进入 argv 或证据 |
| 服务参数 | `dir-cache-time=1s`、`poll-interval=0`、`vfs-cache-mode=off` |

### 3.2 探针结果

| 探针 | 结果 | 关键证据 |
|---|---|---|
| 外部文件创建可见性 | passed | 64 KiB 文件首次 GET 可见，约 `33.484 ms` |
| 外部同尺寸改写可见性 | passed | 同尺寸内容改写后 GET 返回新内容，约 `19.178 ms` |
| mtime 精度 | blocked | 写入 `.789Z` 后变为 `.000Z`；读取 `.456Z` 也变为 `.000Z`；实际精度为整秒 |
| WebDAV features | blocked | `Precision=1000000000` ns、`Hashes=[]`、`PartialUploads=false` |
| 并发 Range | passed | 8 路并发读取 2 MiB 文件，8 个 `206` 分段均与预期 SHA-256 一致 |
| rclone 写、改名、删除 | passed | 写后、改名后的文件系统 SHA-256 一致；删除后文件不存在 |
| 未认证访问 | passed | HTTP `401` |
| junction 越界 | passed | 指向服务根外的 junction 未被列出；直接访问返回 `404`，未返回外部秘密内容 |
| 中断 raw PUT | blocked | 4 MiB PUT 仅发送 256 KiB 后断开，最终文件名在传输中和断开后均保留部分内容 |
| `rclone copy` | blocked | 最终文件名下观察到 `126976`、`258048`、`520192` bytes 的部分内容 |
| 显式 atomic flags 的 `rclone copy` | blocked | 加 `--inplace=false --partial-suffix .partial` 后仍观察到最终名部分内容，且没有临时名 |
| 受控 staging 后 `moveto` | passed | 最终路径在上传 staging 时不存在；staging 内容可部分见；MOVE 后最终 SHA-256 正确、staging 已消失 |
| `rclone bisync --resync` 上传 | blocked | 最终文件名下观察到 `126976` 至 `1044480` bytes 的部分内容 |
| 同尺寸同秒改写后的普通 bisync | blocked | WebDAV 已返回改写内容，但 bisync 退出码为 `0` 且未传播或报告变化 |

最终一次运行的具体可见大小：

- 普通 `copy`：`126976`、`258048`、`520192` bytes；
- 显式 `--inplace=false --partial-suffix .partial`：`126976`、`258048`、`520192`、`1044480` bytes；
- `bisync`：`126976`、`258048`、`520192`、`1044480` bytes；
- 中断 raw PUT：传输中 `258048` bytes，断开后仍留下 `262144` bytes；
- 上述三种 rclone 上传均未观察到 `.partial` 或类似临时文件。

### 3.3 同尺寸同秒改写实测

实验步骤：

1. 本地和 WebDAV 两端使用 4 KiB 文件，mtime 固定为 `2026-10-19T14:00:00Z`；
2. 首次执行 `rclone bisync --resync --resync-mode path1`，两端内容为原始 SHA-256；
3. 直接在服务根文件系统写入同尺寸新内容，并强制保持相同整秒 mtime；
4. 确认 WebDAV GET 已返回新内容；
5. 使用 `--compare size,modtime` 再执行普通 bisync。

实测：

| 项目 | 值 |
|---|---|
| 原始 SHA-256 | `6896d9ea3f73a4434f5832bc65714e7d066f177373f36f34dc8a6f735daa41b1` |
| 改写 SHA-256 | `725bcd6c66d02acf6ebeab9c92410e010ea22e336876256aaf05a211f4ce1902` |
| 改写内容通过 WebDAV 可见 | 是 |
| 第二次 bisync 退出码 | `0` |
| 第二次 bisync 后本地 SHA-256 | 仍为原始内容 |
| 第二次 bisync 后远端 SHA-256 | 仍为改写内容 |
| 变化被传播或报告 | 否 |

这是本机实测漏检，不是仅凭 mtime 精度推导的风险。产品不能把“尺寸相同且整秒 mtime 相同”当作内容未变化。

### 3.4 rclone WebDAV 能力

`rclone backend features :webdav: --json` 返回：

- `Precision`: `1000000000` ns，即整秒；
- `Hashes`: `[]`；
- `PartialUploads`: `false`；
- `Move`: `true`；
- `DirMove`: `true`；
- `Copy`: `true`；
- `PutStream`: `true`；
- `OpenWriterAt`: `false`。

因此，当前 WebDAV vendor 不提供可用于普通比较的服务端 hash，也没有可强制使用的 partial upload 语义。`rclone bisync --download-hash` 仍是一个可选路径，但它的 CPU、全量下载流量和延迟成本尚未测量，本文不给出数值或结论。

## 4. 失败与限制分类

### 4.1 已实测阻断项

- 直接最终名写入可被其他读者观察到部分内容；
- 中断 raw PUT 会留下最终名下的部分文件；
- `rclone copy` 和 `bisync` 的默认上传均存在最终名部分可见；
- 显式 `--inplace=false --partial-suffix .partial` 不能修复该 WebDAV 上传语义；
- mtime 只有整秒精度；
- 无服务端 hash，普通 `size,modtime` bisync 可漏掉同尺寸同秒改写。

### 4.2 已通过但仍需后续验证

- 1 秒目录缓存配置下，外部创建和同尺寸改写均能在一次轮询内看到；
- 8 路并发 Range 返回正确；
- 未认证访问被拒绝；
- 默认不跟随 junction，未观察到越界；
- staging 后 `moveto` 在本机样机中没有观察到最终名部分内容。

### 4.3 不能由本实验确认

- 25 ms 采样是否捕获所有短暂状态；
- staging `moveto` 在 N1 文件系统上的原子性；
- 服务重启、掉电、缓存回写和凭据轮换期间的在途写入；
- 真实代理、公网、ARM64 或最终网关权限行为；
- 全量 hash 的实际成本。

## 5. 最小替代设计建议

以下为基于本次证据的设计建议，不是已实现或已验收结论。

### 5.1 受控目录入口

1. WebDAV 只绑定 loopback 或受控容器网络，不直接暴露给客户端。
2. rclone 和 bisync 继续对普通最终路径执行 PUT，保持现有 WebDAV 路径语义。
3. 网关接收 PUT 后，在内部同文件系统的隐藏 staging 区域写入；staging 路径不暴露给客户端，也不出现在 WebDAV listing 中。
4. 网关在接收请求体时流式计算长度和 SHA-256，不要求客户端改用自定义 staging API。
5. 请求完整结束后，校验长度、SHA-256、目标路径、设备/关系授权和并发 revision。
6. 全部校验通过后，才通过同文件系统 rename/replace 提交最终文件，并在提交完成后返回 PUT 成功。
7. 中断、校验失败或授权失败只清理 staging，不创建或替换最终文件。
8. MOVE、COPY、DELETE、GET、Range 和目录语义仍需兼容普通 rclone bisync 工作流。
9. 外部直接修改无法仅靠上传路径保护，仍需网关侧 hash 索引或受控扫描来发现同尺寸同秒改写。
10. 发布后写入操作记录；崩溃恢复只处理带明确 staging 状态的记录。

本机实验只证明 `moveto` 样机未观察到最终名部分内容；它不证明未来网关事务在 N1 上的原子性。生产实现必须自己完成同一文件系统、目标不存在、失败回滚和重启恢复测试。

### 5.2 变化检测

由于 mtime 为整秒且 WebDAV vendor 没有服务端 hash：

- 不能只使用 `size + modtime` 判断内容未变化；
- 网关应在提交时计算并保存内容 SHA-256，或保存其他经证明的完整内容指纹；
- 对无法信任指纹的外部直接修改，使用网关侧 hash 清单或受控全量扫描；
- `bisync --download-hash` 只能作为待评估方案，必须测量 CPU、下载流量和延迟；
- 同尺寸同秒改写必须有内容 hash 回归测试。

### 5.3 后续最小实现闸门

在生产实现前至少验证：

1. 普通最终路径 PUT 在提交完成前不会把部分内容暴露为最终文件；
2. 网关内部 staging 对普通客户端不可见；
3. 中断上传只留下可识别 staging，不产生最终名；
4. 成功提交后最终文件完整，失败提交不替换旧版本；
5. 同尺寸同秒改写能被 hash 或等价机制发现；
6. 服务重启、掉电恢复和并发提交不产生半文件；
7. N1 ARM64、真实 VLESS/公网入口和最终设备授权分别通过。

## 6. 结论

【已确认事实】锁定的 Windows rclone 1.74.3 在本机 loopback 样机中支持认证、Range 读取、基本写改删和 staging 后 MOVE；但普通 copy、显式 atomic flags 的 copy、bisync 上传以及中断 raw PUT 都能在最终文件名下留下部分内容。WebDAV vendor 没有服务端 hash，mtime 只有整秒精度，普通 bisync 已实测漏掉同尺寸同秒改写。

【合理推断】把 rclone serve webdav 直接作为最终目录入口不能满足 P2 的写入完成和变化检测闸门。使用受控网关、隐藏 staging、提交前 SHA-256 验证和同文件系统原子发布是当前最小替代方向。

【待验证】网关实现、N1 ARM64 原子性、全量 hash 成本、公网路由和最终授权仍未验证。本报告不能作为 P2 放行证据。
