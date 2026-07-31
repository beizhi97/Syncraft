# Syncraft 软件设计说明书

## 1. 项目概述

Syncraft 是一个自托管文件夹同步工具，用于在运营商单 TCP 流限速的网络环境下，通过 VLESS 隧道和 rclone 多线程同步提升文件传输稳定性与吞吐。

双端接口与协议以 `docs/INTERFACE_CONTRACT.md` 为准。修改客户端导入、SyncKey、profile、设备心跳或服务端管理接口时，必须同步更新该合同和合同测试。

系统分为服务端和客户端：

- 服务端运行在 N1/Debian/Docker 环境。systemd 管理 appliance 与独立 MinIO 两个容器；appliance 内由 s6 管理 Node 控制面和 `sing-box`，并内置 `rclone`。
- 客户端为 Windows 桌面 EXE，内置 `sing-box.exe` 和 `rclone.exe`。
- 客户端不修改系统代理、路由、DNS、防火墙或 TUN，只让同步进程走本地代理。

## 2. 设计目标

- 用 SyncKey 简化客户端配置，普通用户不需要填写 VLESS/S3 参数。
- 同步流量仅限 rclone 进程，避免污染本机网络环境。
- 使用 rclone 的 `--transfers` 与 `--multi-thread-streams` 绕过单连接限速。
- 服务端集中管理 VLESS、同步仓库、设备、SyncKey 和在线状态。
- 桌面客户端展示速度、进度、当前文件、已传输数据和可调线程数。

## 3. 总体架构

```text
Windows Client EXE
  UI
  local client API 127.0.0.1:5188
  bundled sing-box.exe
  bundled rclone.exe
        |
        | local SOCKS proxy 127.0.0.1:18081
        v
公网/Lucky/端口转发
        |
        v
Server systemd
  ├── sfsc-appliance container (s6 -> Node + sing-box; bundled rclone)
  └── sfsc-minio container (independent persistent storage)

Legacy / development Docker Compose
  sync-server :5177
  sing-box VLESS inbound
  MinIO S3 storage
```

## 4. 服务端模块

### 4.1 sync-server

入口文件：`src/server.js`

职责：

- 管理 VLESS 参数与 sing-box 配置。
- 管理同步仓库 bucket。
- 生成和兑换 SyncKey。
- 记录设备心跳和同步状态。
- 提供服务端控制台 UI。

主要接口按产品入口分组：

- 服务端健康与控制台摘要：`GET /api/health`、`GET /api/admin/auth/check`、`GET /api/admin/state`。
- VLESS/sing-box 管理：`POST /api/admin/tunnel/autofill` 补全参数，`POST /api/admin/tunnel/generate` 生成并写入配置，`GET /api/admin/singbox/config` 只读预览脱敏配置，`POST /api/admin/singbox/write` 作为运维重写入口，`POST /api/admin/singbox/mark-applied` 在管理员确认进程已重启后清除待应用状态。
- 同步仓库管理：`POST /api/admin/storage/save` 保存 S3/MinIO 参数；`POST /api/admin/storage/buckets/refresh` 刷新远端 bucket 摘要；`POST /api/admin/storage/buckets/create`、`enable`、`disable`、`clear`、`delete-empty` 管理同步仓库生命周期。
- 设备与 SyncKey 生命周期：服务端控制台「设备 → 新建设备」用 `POST /api/admin/users/create` 显式登记设备（设备必须能先于 SyncKey 存在，否则创建同步空间时无 owner 可选）；`POST /api/claims/create` 生成一次性 SyncKey 和待兑换 profile，并在设备名首次出现时隐式建设备；`POST /api/admin/users/enable`、`disable`、`delete` 管理已有设备。
- 客户端运行入口：`POST /api/claims/redeem` 兑换 SyncKey，`POST /api/devices/heartbeat` 接收带 HMAC 的设备心跳。
- 调试/兼容入口：`POST /api/vless/parse`、`POST /api/singbox/client-config`、`POST /api/profile/encode`、`POST /api/jobs/preview` 用于 smoke、迁移验证和无状态预览，不是普通控制台主流程。

管理鉴权：

- 设置 `SFSC_ADMIN_TOKEN` 或 `ADMIN_TOKEN` 后，管理接口必须携带 `Authorization: Bearer {token}`。
- 受保护接口包括 `/api/admin/*`、`POST /api/claims/create`、`POST /api/vless/parse`、`POST /api/singbox/client-config`、`POST /api/profile/encode`、`POST /api/jobs/preview`。
- 公开运行接口包括 `GET /api/health`、`POST /api/claims/redeem`、`POST /api/devices/heartbeat`；其中新 profile 的心跳必须使用 `profile.heartbeat.secret` 生成 `sfsc-hmac-sha256-v1` HMAC `auth`，未签名返回 `heartbeat_auth_required`，签名无效、过期、nonce 重放或请求体不匹配返回 `heartbeat_auth_invalid`。
- 服务端控制台使用正式登录/锁定页，不使用浏览器 `prompt()`。
- SyncKey 生成结果短码优先展示，完整 SyncKey 和导入 URI 分开复制；测试兑换必须确认其会消耗 SyncKey。
- SyncKey 创建只有在服务端成功持久化 claim 和设备状态后才算发布；状态写入失败返回 `server_state_write_failed` 并回滚内存状态，控制台不得显示或复制未持久化的幽灵 SyncKey。
- 控制台必须把 `tunnel.restartRequired` 显示为显眼的待应用状态，并同时展示最近写入时间 `lastConfigWrittenAt` 和最近应用时间 `lastAppliedAt`；常规用户通过“重启并应用”触发受控 supervisor 校验并重启 sing-box，成功后服务端才清除待应用状态，避免管理员误以为写入配置等于 sing-box 已加载。
- 服务端写 sing-box 配置失败时返回 `server_singbox_config_write_failed`，并回滚本次请求对内存管理状态的修改，避免控制台显示尚未成功写入配置文件的 tunnel、设备或 SyncKey 状态。

危险操作保护：

- 生成 sing-box 配置必须提交 `confirmGenerateTunnel: true`。
- 已存在 REALITY key 时强制轮换必须提交 `confirmRotateRealityKeys: true`。
- 控制台重启并应用 sing-box 必须提交 `confirmApplySingbox: true`，且只有存在待应用变更时服务端才接受；`confirmMarkApplied: true` 仅供已在外部完成重启的兼容运维脚本使用。
- 服务端控制台在生成 sing-box 配置或轮换 REALITY key 前必须展示影响摘要，包括设备总数、启用/在线数量、受影响设备示例和协议兼容性警告数量；REALITY key 轮换还必须提示旧 SyncKey/profile 会失效，需要重新生成 SyncKey 并重新导入客户端。
- 清空 bucket 或删除空 bucket 必须提交与 bucket 名完全一致的 `confirmBucket`。
- 删除设备必须提交与设备名完全一致的确认文本。
- 删除最后一个 bucket 或停用最后一个启用 bucket 会被服务端拒绝，避免默认 SyncKey 生成路径不可用；服务端控制台也会提前禁用这些按钮并在按钮提示中说明原因。
- 为已有设备重新生成 SyncKey 且显式选择 bucket 时，服务端会同步更新该设备 bucket 绑定，确保新 profile、claim 和设备摘要一致。
- 删除 bucket 后，仍绑定该 bucket 的设备会迁移到替代 bucket，避免设备摘要和后续 SyncKey 引用已删除仓库。
- 创建 bucket 接口负责登记同步仓库并尝试远端 provision；若 MinIO/S3 创建失败，允许保留登记结果以支持外部已创建 bucket，但响应必须带 `provision.ok: false`、`provision.errorCode: "storage_request_failed"` 和 warning，控制台据此提示检查存储服务。
- 停用设备不能生成新 SyncKey，旧客户端心跳返回 `device_disabled`；控制台生成 SyncKey 前会提前拦截已停用设备并提示先重新启用；按已删除设备的旧 `userId` 生成 SyncKey 返回 `user_not_found`。
- 服务端控制台设备列表显示设备影响摘要，管理员无需打开原始 JSON 即可看到停用影响、离线处理建议或最近同步失败原因；设备列表支持按在线/停用状态、最近同步结果、兼容状态和设备/bucket/文件/错误文本筛选，用于快速定位需要处理的客户端。管理操作失败时，控制台基于稳定 `errorCode` 展示中文原因和恢复建议，例如刷新仓库、检查 MinIO、重新登录、先清空 bucket、重新生成 SyncKey 或查看 sync-server 日志。

### 4.2 sing-box

职责：

- 提供 VLESS TCP / VLESS REALITY TCP 入站。
- 客户端通过本地 sing-box outbound 连接服务端。
- 服务端 outbound 为 direct，允许访问 Compose 内部 MinIO。

### 4.3 MinIO

职责：

- 作为 S3 兼容存储。
- bucket 作为同步仓库。
- 默认只绑定本机端口，公网不直接暴露 MinIO。

## 5. 客户端模块

### 5.1 Electron 壳

入口文件：`client/electron/main.cjs`

职责：

- 启动本地客户端 API。
- 打开桌面窗口。
- 写入 Electron 主进程日志。
- 通过受限 preload 暴露原生目录选择器，页面只可调用 `window.sfscDesktop.pickFolder()`。

### 5.2 本地客户端 API

入口文件：`client/src/clientServer.js`

职责：

- 导入 SyncKey 并保存 profile。
- 生成 sing-box 本地配置。
- 启动/停止 sing-box。
- 启动/停止 rclone 同步。
- 从 rclone 输出解析速度、进度、当前文件。
- 持久化最近 20 次同步运行记录，并在状态接口和心跳中上报最近结果。
- 从 rclone/bisync 输出中提取同步冲突摘要，写入最近运行记录和心跳，供客户端历史和服务端设备列表直接展示。
- 定时向服务端发送设备心跳。
- 最近一次心跳结果写入本地状态，并在客户端顶部状态区和设置页诊断项展示；客户端发送前用 `profile.heartbeat.secret` 签名 heartbeat 请求，网络异常、上报超时或服务端非 2xx 响应统一标记为 `heartbeat_failed`，服务端结构化错误码保留为 `remoteErrorCode`。

本地 HTTP API 按用途分组：

- 健康与状态：轻量 `GET /api/health` 只做本机 readiness 和版本/协议探活，不读取完整本地状态、profile、任务或密钥库；`GET /api/client/status` 返回客户端 UI 所需的 profile 摘要、任务、同步历史、心跳、二进制组件、进程状态、发布 manifest 和本地安全防护摘要。
- Profile 与任务只读摘要：`GET /api/profile`、`GET /api/jobs`、`GET /api/sync/history` 返回展示安全摘要，并与 `/api/client/status` 中的 `profileImported`、`jobs[]` 和 `syncHistory[]` 保持一致。
- 写入和执行入口：`POST /api/profile/import` 导入 SyncKey 或完整 profile；`POST /api/jobs/save` 保存任务；`POST /api/sync/preview` 只读预览 rclone/sing-box/schedule；`POST /api/sync/run`、`POST /api/sync/stop` 启动或停止同步；`POST /api/singbox/start`、`POST /api/singbox/stop` 管理本地代理进程。
- 现场支持入口：`POST /api/binaries/check` 检查内置组件；`GET /api/logs` 和 `GET /api/diagnostics/export` 返回脱敏日志与诊断包。

### 5.3 客户端 UI

目录：`client/public`

主界面只保留同步任务：

- 本地文件夹
- 同步方向
- 计划任务：手动、每隔 N 分钟、每天 HH:MM
- 并行文件
- 单文件线程
- 同步速度、进度、当前文件
- 最近一次同步结果
- 高级参数折叠区：镜像同步、带宽限制

本地文件夹选择：

- Electron 桌面版使用原生 `dialog.showOpenDialog` 选择目录。
- 浏览器开发模式回退到隐藏的 `webkitdirectory` 文件输入。
- 始终保留手动粘贴路径能力。

设置页包含：

- SyncKey 导入
- 组件检测
- 发布包 manifest 状态和包构建时间
- 服务端心跳状态
- 隧道启动/停止
- 高级诊断
- 最近 20 次同步历史
- 日志查看/复制
- 一键导出脱敏 JSON 诊断包，包含本机状态、协议/构建、发布 manifest、任务、调度、心跳、同步历史、运行环境、组件/状态/日志文件摘要和最近日志；最近日志带 `exists/size/modifiedAt/maxChars/truncated` 元数据，便于判断日志缺失或截断

## 6. 同步模型

客户端通过 rclone 执行同步：

- 上传：本地目录 -> S3 bucket/prefix
- 下载：S3 bucket/prefix -> 本地目录
- 双向：使用 rclone `bisync`
- 默认上传/下载使用 `rclone copy`，不会删除目标端多余文件。
- 开启 `destructiveSync` 时上传/下载改为 `rclone sync`，会删除目标端多余文件；产品 UI 必须放在高级区并二次确认。
- 双向同步使用 `rclone bisync`，不使用 `destructiveSync` 开关；客户端本地 API 和 rclone preview 必须把 `direction: "bidirectional"` + `destructiveSync: true` 归一化为非 destructive 状态。
- 客户端保存或启动带 `destructiveSync: true` 的任务前必须再次确认。

默认路径模型：

```text
设备私有空间: {bucket}/devices/{clientName}/{remoteFolder}
共享空间:     {bucket}/shared/{remoteFolder}
```

当前客户端主界面隐藏远端路径，由 SyncKey 下发 profile 决定 bucket 和 prefix。

计划任务模型：

- `manual`：只手动运行。
- `interval`：`intervalMinutes` 为 1 到 1440 的整数。
- `daily`：`time` 为 24 小时制 `HH:MM`。
- `startup`：客户端运行时支持启动后一次性触发，Windows 客户端 UI 可配置；服务端控制台默认策略不暴露给批量下发。

## 7. 性能参数

默认值：

```text
--transfers 4
--checkers 8
--multi-thread-streams 8
--multi-thread-cutoff 16M
--s3-upload-concurrency 8
--s3-chunk-size 16M
--stats=1s
```

说明：

- `并行文件` 对应 `--transfers`。
- `单文件线程` 对应 `--multi-thread-streams`。
- 小于 `16M` 的文件不会启用单文件多线程。
- `带宽限制` 位于高级参数区，使用开关 + 模式选择 + 正整数 + KB/s、MB/s、GB/s 单位选择；固定模式生成 `500k`、`10M`、`1G` 这类 rclone 参数，时间段模式生成 `08:00,10M 18:00,off` 这类两段式时间表。
- `--stats-one-line` 已关闭，以便解析当前正在传输的文件。
- 客户端 UI 未展示的底层性能参数必须从导入 profile 的 `defaults` 继承；保存、预览和运行任务时不能把 `checkers`、`chunkSize`、`retries`、`lowLevelRetries`、`localProxyPort` 重置成硬编码默认值。
- 客户端重新导入 profile 后必须刷新已保存 job 中的 profile 派生字段，替换旧 bucket、执行 prefix、secret、隐藏 defaults 和本地代理端口，同时保留用户填写的本地路径、方向、远端相对目录、空间类型、计划、带宽和可见并发参数；执行 `remotePrefix` 必须从新 profile prefix 与保留的 `remoteFolder/serverSpace` 重新派生。
- 服务端控制台当前只暴露 SyncKey 常用默认项：`transfers`、`streams`、`checkers`、`chunkSize` 和 `schedule`；完整 `defaults` 仍由服务端 API/profile 合同承载。
- 同步预览中的展示命令必须脱敏 S3 secret；secret 不得进入执行参数数组，只能通过 `RCLONE_CONFIG_<REMOTE>_SECRET_ACCESS_KEY` 环境变量注入，避免在进程命令行中泄露。

## 8. 安全边界

客户端明确不做：

- 不启用 TUN。
- 不修改系统代理。
- 不写系统路由。
- 不改 DNS。
- 不改防火墙。

敏感项：

- SyncKey 一次性使用，兑换后服务端标记已使用。
- SyncKey 只有在服务端成功持久化兑换状态后才算消耗；若状态写入失败，兑换请求返回 `server_state_write_failed`，客户端可在管理员修复后重试同一个 SyncKey。
- 管理状态会脱敏 `storage.secretAccessKey`、`users[].storage.secretAccessKey`、`tunnel.reality.privateKey`。
- sing-box 配置预览会脱敏 REALITY `private_key`，真实配置写入仍使用真实 key。
- 服务端控制台调试 JSON 也必须递归脱敏密钥字段；SyncKey/profile API 响应可作为导入凭据保留真实密钥，但 UI 展示不得明文显示。
- 客户端诊断日志写入和读取都必须脱敏 `secret_access_key`、`secretAccessKey`、`S3_SECRET_ACCESS_KEY`、`AWS_SECRET_ACCESS_KEY`、`MINIO_ROOT_PASSWORD`。
- 客户端组件检测和 `/api/client/status.binaries` 必须在缺少内置 `sing-box.exe` 或 `rclone.exe` 时暴露稳定 `missing_singbox_binary` / `missing_rclone_binary`，并给出缺失路径，便于现场判断是否解压不完整或发行包错误。
- 管理端提交空 private key 或包含 `***` 的 private key 表示保持原值不变。
- 客户端 `profile.json` 和 `jobs.json` 不直接保存 S3 `secretAccessKey` 或 `profile.heartbeat.secret`，而在原密钥字段中保存 `{ "secretRef": "..." }` 引用对象；运行时通过本地 secret vault 水合后再生成 rclone 配置和 heartbeat auth。进程内 `readProfile()` / `readJobs()` 返回水合后的运行时对象；HTTP 的 `GET /api/profile`、`POST /api/profile/import.profile`、`GET /api/jobs`、`POST /api/jobs/save.job` 和 `GET /api/client/status.jobs` 只返回展示安全摘要，不得包含 access key、S3 secret、heartbeat secret/nonce、原始 VLESS URI、SyncKey、claim code、token 或完整 profile。当前 vault 后端是 `data/secrets.json`，后续可替换为 Windows Credential Manager。
- 若 `secretRef` 找不到对应条目，状态接口仍返回 `safeguards.secretVault.ok: false`，同步预览/运行返回 `secret_vault_missing`，提示用户重新导入 SyncKey。
- 若本地 JSON 状态文件损坏，状态接口仍返回 200，并通过 `safeguards.localState` 点名损坏文件；保存任务、导入 profile、启动同步等会修改状态的入口返回 `local_state_corrupt`，避免继续覆盖损坏文件。
- 服务端启动时必须先获取 `SERVER_DATA_ROOT/sfsc-state.lock`，同一数据目录只允许一个 sync-server 写入者。owner 记录容器 `instanceId`、进程启动身份并持续刷新心跳：同一容器内 PID 复用时通过 `processStartedAt` 识别旧进程，不同容器实例仅在心跳超时后接管；仍有活动 owner 或无法判断的锁必须返回 `server_state_locked`。`sfsc-state.json` 存在但损坏时必须失败并保留原文件，不得用默认状态静默覆盖；状态写入使用临时文件和原子 rename，写入失败返回 `server_state_write_failed` 并回滚本次请求对内存管理状态的修改。
- `server/sing-box/config.json` 当前只保留占位配置；真实运行密钥应来自服务端状态或环境变量。

## 9. 双端接口约定

双端协议以 `docs/INTERFACE_CONTRACT.md` 为唯一基线。

核心约定：

- 协议版本为 `1`。
- 关键写接口请求先经过 `src/core/protocolSchemas.js` 的共享 schema 归一化，入口只保留白名单字段和稳定错误码，再交给深层业务合同处理。
- SyncKey 外层格式为 `SFSC1-{base64url(json)}` 或 `sfsc://import/v1#{base64url(json)}`。
- SyncKey payload 包含 `server` 和一次性短码 `code`；新生成短码使用无歧义字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，兑换解析保留历史 `[A-Z0-9]` 短码兼容。
- 兑换成功后返回完整 profile，客户端保存 profile，不保存一次性短码。
- 客户端本地 API 只监听 `127.0.0.1:5188`。Electron 桌面入口使用 single-instance lock，第二次打开时聚焦已有窗口；便携 launcher 会先探测已运行本地 API 的轻量 `GET /api/health`，存在时直接打开已有 UI，不读取完整本地状态、profile、任务或密钥库；本地 API 启动时若发现端口已由 SFSC 客户端占用则通过同一轻量健康口复用退出，若被其他进程占用则返回/记录 `client_port_in_use`。
- 设备心跳由客户端定时发送到服务端，服务端以 2 分钟内心跳判断在线。新 profile 心跳必须携带 HMAC auth；服务端在认证时间窗口内拒绝重复 nonce，防止同一个已签名 heartbeat 被重放；服务端管理摘要和 user/device DTO 不得返回 `heartbeatSecret` 或 nonce 窗口。
- 服务端 `/api/health`、`/api/admin/state`、客户端 `/api/health`、客户端 `/api/client/status` 和设备心跳都暴露统一 `diagnostics` 诊断块；其中 `version` 对齐发布批次，`protocols` 对齐 SyncKey、profile、admin state、client status 和 heartbeat 的合同版本。客户端 `/api/health` 仅用于本机 readiness 和版本/协议探活，不得返回 paths、profile、jobs、safeguards 或密钥派生字段；完整本机状态仍以 `/api/client/status` 为准。服务端控制台顶部展示服务端诊断摘要，设备列表展示客户端心跳上报的协议/构建摘要、兼容状态和兼容策略；客户端设置抽屉展示本机协议、最近心跳返回的服务端协议、构建摘要、兼容状态和兼容策略。协议不兼容时 UI 必须根据 `compatibility.action` 区分客户端过旧、服务端过旧、诊断信息缺失和混合版本；心跳策略保持允许，配置下发和同步执行策略标记为警告。给已有且已运行过的设备重新生成 SyncKey 属于 profile 下发行为；若该设备 `compatibility.policy.profileIssue === "warn"`，服务端必须要求 `confirmCompatibilityWarning: true`，控制台必须弹出兼容性风险确认。启用已有且已运行过的不兼容设备属于运行状态恢复行为，也必须要求同样确认。客户端保存任务或开始同步属于同步执行入口；若最近心跳的 `compatibility.policy.syncRun === "warn"`，客户端必须在调用 `/api/jobs/save` 或 `/api/sync/run` 前弹出兼容性风险确认。只读预览不需要兼容性确认。新建设备或未运行过的设备不因缺少 diagnostics 被拦截。
- 客户端 `/api/client/status.releaseManifest` 和诊断包 `environment.releaseManifest` 暴露发布 manifest 摘要；设置抽屉展示发布包状态和包构建时间，支持人员可直接判断用户是否运行了正式交付包。
- 同步运行摘要通过 `src/core/syncRun.js` 共享归一化；客户端上报 `sync.lastRun` 前整理一次，服务端接收心跳后再整理一次。
- 客户端本地运行时根据已保存 job 的 `schedule` 自动调度 `interval`、`daily` 和 `startup` 任务；状态接口暴露 `scheduler.nextRun`、`lastTriggeredAt` 和稳定错误码 `lastError`，UI 在同步进度区显示下一次计划。客户端心跳也会上报 `sync.scheduler`，服务端控制台设备列表展示下一次计划或调度错误。
- 服务端只有在心跳状态成功持久化后才更新设备在线状态、`lastSeenAt` 和同步摘要；状态写入失败返回 `server_state_write_failed` 并回滚内存状态，避免控制台显示未持久化的假在线。
- rclone 同步进程异常退出时，同步运行记录使用 `errorCode: "rclone_sync_failed"`；用户主动停止使用 `status: "stopped"`，不归类为同步失败。
- 客户端读取本地同步历史时也执行共享归一化；旧记录中的非法状态、错误码、进度或远端路径字段不能导致状态页和心跳失败。
- 服务端接收心跳时对非法同步路径字段容错：清空坏路径字段，继续保留进度、速度和最近运行摘要。
- 启动阶段错误使用显式错误码：sing-box 配置写入或进程启动失败为 `singbox_start_failed`，rclone remote 配置写入失败为 `rclone_config_failed`。
- SyncKey/profile/VLESS 导入校验使用显式错误码：`import_code_invalid`、`unsupported_profile_version`、`profile_tunnel_required`、`invalid_vless_uri`。
- 心跳请求默认 10 秒超时，失败写入客户端本地状态 `heartbeat.errorCode: "heartbeat_failed"`；若服务端返回了结构化错误码，包括 `heartbeat_auth_required` 或 `heartbeat_auth_invalid`，则保留在 `heartbeat.remoteErrorCode` 里用于诊断。
- 客户端 UI 展示心跳失败时，会把 `remoteErrorCode` 映射成中文服务端原因，例如 `device_not_found` 会提示客户端未登记，而不是直接展示内部码。
- 服务端设备摘要保留最近心跳来源地址 `lastRemoteAddress`，控制台设备列表展示该字段，方便排查客户端是否连到预期公网入口。
- 客户端页面和服务端控制台的 API wrapper 默认 15 秒超时；客户端同步准备/启动使用 120 秒、双向初始化使用 240 秒，避免页面超时先于本地运行时的结构化错误；页面等待超时合成 `request_timeout`，无法连接本地服务合成 `network_error`。

错误响应统一格式：

```json
{
  "ok": false,
  "error": "claim_already_used",
  "errorCode": "claim_already_used",
  "message": "claim_already_used"
}
```

说明：

- `error` 是兼容旧客户端的历史字段。
- `errorCode` 是新 UI 应优先读取的稳定字段。
- `message` 用于展示详情或写入日志。
- 当前已有集中错误映射层，能将常见英文异常转换为稳定码，例如 `validation_failed`、`missing_rclone_binary`、`profile_not_imported`、`bucket_not_empty`。
- 页面端网络/超时错误不经过后端 JSON 响应，也必须以 `network_error`、`request_timeout` 这类稳定码进入 UI 文案层。

## 10. 运行状态与日志

客户端日志：

```text
data/logs/electron-main.log
data/logs/sing-box.log
data/logs/rclone.log
data/sync-history.json
```

服务端状态：

```text
server/data/app/sfsc-state.json
```

运行数据不建议纳入源码迁移包，除非明确要迁移生产状态。

## 11. 当前限制

- 没有安装程序，Windows 客户端为便携目录。
- 还没有系统级服务守护。
- 同步冲突检测依赖 rclone 当前行为；客户端和服务端已突出显示冲突摘要与处理建议，但尚未做自动或交互式版本选择工作流。
- S3 凭据仍是共享存储凭据模型，后续可演进到按设备隔离的对象存储策略。
- 删除仓库只允许服务端管理页操作，客户端不提供删除仓库能力。
- 客户端设置页已展示最近 20 次同步运行记录、状态/冲突统计和速度峰值，并支持按状态与任务/路径/文件/错误文本筛选；尚未做独立历史详情页。
- 冲突记录已纳入同步运行合同，当前记录冲突数量和最多 10 个示例文件，并提示用户暂停双向同步、手动比对示例文件后再重新运行；后续可继续扩展为可交互的冲突处理工作流。
- 带宽限制已完成基础安全控件和两段式时间段限速；更复杂的多时段 rclone 时间表仍不作为产品 UI 暴露。

## 12. 产品化优先级

P0：

- 双端接口合同继续作为开发基线，并由 `tests/contract-http.test.js` 回归保护。
- 客户端完成 SyncKey 导入、文件夹选择、开始/停止同步、进度、错误提示的稳定体验。
- 服务端控制台完成登录、SyncKey、设备、bucket、VLESS/sing-box 配置的安全操作流。
- 后端和客户端错误码继续从英文异常消息细分为更稳定的 snake_case 枚举。

P1：

- 客户端高级参数：诊断日志元数据和发布 manifest 摘要已进入诊断包，设置页也展示发布包状态；Windows 桌面包 smoke 已覆盖产物结构、runtime 状态排除、release manifest 哈希和原生目录选择器安全桥；后续继续补现场可读性。
- 服务端操作反馈：继续扩展统一结果详情；常见失败已提供稳定错误码对应的恢复建议。
- Windows 客户端原生目录选择器已纳入桌面包 smoke 回归；后续如改 Electron 壳，必须同步更新 smoke。

P2：

- 独立任务历史详情页和更细的任务维度统计。
- rclone bisync 冲突结构化解析和冲突处理 UI。
- 将当前本地 secret vault 文件后端替换为 Windows Credential Manager。
