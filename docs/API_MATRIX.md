# 双端 API 矩阵

本文档用于快速审计客户端、服务端和页面之间的 HTTP 接口关系。字段级协议、错误码和兼容策略仍以 `docs/INTERFACE_CONTRACT.md` 为唯一基线。

消费者分类采用固定词汇：`服务端控制台` / `客户端 UI` 表示用户可见产品界面；`客户端本地运行时`、`启动器` 和 `本地自动化` 表示本机后台或自动触发；`smoke` 表示验收脚本会直接调用；`运维探活`、`运维只读入口` 和 `调试/运维入口` 表示非普通用户入口；`调试/兼容入口` 表示为兼容、诊断或无状态预览保留的接口；`测试` 只允许出现在本地测试专用入口。

## 1. 服务端 HTTP API

| 方法 | 路径 | 鉴权 | 当前消费者 | 用途 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 服务端控制台、smoke、运维探活 | 服务端健康、版本和协议诊断 |
| GET | `/api/admin/auth/check` | 管理 token | 服务端控制台、smoke | 校验管理登录状态 |
| GET | `/api/admin/state` | 管理 token | 服务端控制台、smoke | 获取脱敏管理摘要 |
| GET | `/api/admin/enrollment/v1/requests` | 管理 token | 服务端控制台 | 列出待审批的设备接入申请，不返回设备私钥或同步凭据 |
| GET | `/api/admin/enrollment/v1/relations` | 管理 token | 服务端控制台 | 列出 enrollment relation、设备和目录的授权状态；不返回 identity、密钥或 runtime handle |
| POST | `/api/admin/enrollment/v1/revocations` | 管理 token | 服务端控制台 | 仅接受 `{operationId,target}`；target 为 relation 或 device。按固定目标幂等续做；只有 authority 已撤销、适用 relation service 已确认停止/不存在且 overlay 配置收到匹配 supervisor receipt 才返回 200 complete，否则返回 503 pending |
| GET | `/api/admin/enrollment/v1/operations/{operationId}` | 管理 token | 服务端控制台 | 查询脱敏撤销 journal；读取不等待正在运行的 stop/restart；POST 同 operationId 可继续 pending 操作 |
| POST | `/api/admin/enrollment/v1/requests/{requestId}/issue` | 管理 token | 服务端控制台 | 兼容 `{rootId}` 单目录请求；`{rootIds:[...]}` 一次为多个 active root 签发同一身份验证码与多条独立 binding；不能混用两字段 |
| GET | `/api/admin/enrollment/v1/directories` | 管理 token | 服务端控制台 | 列出已登记同步目录及登记状态，不返回内部 UUID |
| POST | `/api/admin/enrollment/v1/directories` | 管理 token | 服务端控制台 | 仅接受 `{path}`；校验既存目录并登记，首次登记会在所选目录写入 `.syncraft-root.json` 隐藏标记；不会创建或删除用户文件 |
| GET | `/api/admin/enrollment/v1/trust` | 管理 token | 服务端控制台 | 返回接入签名公钥及实际 loopback bootstrap origin pin |
| POST | `/api/admin/enrollment/v1/channel-code` | 管理 token | 服务端控制台 | 仅接受空 JSON `{}`；当前 sing-box overlay 已由 supervisor 应用且摘要匹配时，签发受限 bootstrap 通道包装码 |
| POST | `/api/admin/enrollment/v1/reconfigure` | 管理 token | 服务端控制台 | 仅接受 `{operationId, publicHost?, publicPort?}`；沿用现有 VLESS 协议、安全、传输和身份参数，持久化操作阶段，写入候选配置，要求 supervisor 确认精确 SHA-256，再更新 data/bootstrap 双 overlay 应用回执；REALITY 模式还必须经当前 bootstrap VLESS 身份完成本机 loopback gateway challenge 探测后才签发包装码；失败时仅在隧道设置与配置摘要仍属于本操作时恢复快照，否则标记 `repair-needed` 且不返回成功码 |
| GET | `/api/admin/enrollment/v1/reconfigure/{operationId}` | 管理 token | 服务端控制台 | 查询持久化重配置阶段；仅 `complete` 返回已持久化通道码，其余阶段不返回码 |
| POST | `/api/enrollment/v1/data-authorization` | X-SFSC-Authorization 设备 Ed25519 签名、当前未撤销 relation grant | 客户端本地运行时 | 仅接受 `{relationId}`；loopback gateway 校验精确 method/path/body/nonce 后物化 SFTP relation、应用数据通道 overlay 并返回签名 data-authorization；受保护 relation service 启动失败返回 `enrollment_data_relation_start_failed`/503，与授权拒绝区分 |
| POST | `/api/enrollment/v1/channel-renewal` | X-SFSC-Authorization 设备 Ed25519 签名、当前已消费且未撤销的 binding | 已配对客户端本地运行时 | 仅接受 `{channelRevision}`；对原始 consumed binding 与精确请求签名验 nonce，仅为当前已应用 bootstrap transport revision 签发可导入的新包装码，不改写原 binding/receipt |
| GET | `/api/enrollment/v1/transport-probe?challenge={randomHex}` | 仅 loopback gateway；本机受限 bootstrap VLESS 身份由当前 sing-box overlay 路由 | 服务端内部 REALITY 探针 | 仅接受一个 48 位小写十六进制 challenge；返回精确 challenge 和 `sfsc-enrollment-bootstrap` 服务标识，不创建申请、不签发码、不改写状态 |
| GET | `/api/admin/setup` | 管理 token | 服务端控制台（目录、配对、修复） | 返回 `{complete,currentStepId,steps}` 三步就绪度；依赖 active 且当前 marker/挂载/读写检查通过的目录、匹配当前 sing-box SHA-256 的 bootstrap 与 data overlay supervisor 回执、以及绑定到有效目录的未撤销已消费设备 grant；MinIO/S3 不阻塞普通目录首用。该结果不表示已完成客户端双向同步。探针或证据读取失败按未就绪。独立于高频 `/api/admin/state` |
| GET | `/api/admin/devices/{id}/vless-uri` | 管理 token | 服务端控制台、调试/运维入口 | 显式按需返回单个设备完整 VLESS URI；常规 `/api/admin/state` 不得携带完整 URI |
| POST | `/api/admin/tunnel/generate` | 管理 token | 服务端控制台 | 生成并写入服务端 sing-box 配置 |
| POST | `/api/admin/tunnel/autofill` | 管理 token | 服务端控制台 | 高级连接设置自动补全 VLESS/REALITY 参数；全新部署可提交 REALITY 模式和管理员提供的外部地址/端口，服务端生成并复用强随机密钥。参数补全本身不证明外部端点可达；控制台随后必须调用 `/api/admin/singbox/apply` 并等待 supervisor 应用回执 |
| POST | `/api/admin/storage/save` | 管理 token | 服务端控制台 | 保存 S3/MinIO 配置 |
| POST | `/api/admin/sync-spaces/create` | 管理 token | 服务端控制台、受控多设备试用 | 以现有设备为 owner 创建逻辑同步空间；只接受 `ownerUserId` 和用户可见 `syncId`，服务端生成内部空间 ID 和存储目标，响应与管理状态不泄露物理路径或成员凭据 |
| POST | `/api/admin/storage/buckets/refresh` | 管理 token | 服务端控制台 | 刷新 bucket 列表；请求 schema 是空 JSON 信封 `{}`，非对象、数组或非空对象返回 `validation_failed` 且不得触发远端 bucket list |
| POST | `/api/admin/storage/buckets/create` | 管理 token | 服务端控制台 | 创建同步仓库 |
| POST | `/api/admin/storage/buckets/enable` | 管理 token | 服务端控制台 | 启用同步仓库 |
| POST | `/api/admin/storage/buckets/disable` | 管理 token | 服务端控制台 | 停用同步仓库 |
| POST | `/api/admin/storage/buckets/clear` | 管理 token | 服务端控制台 | 清空同步仓库对象，需要危险确认 |
| POST | `/api/admin/storage/buckets/delete-empty` | 管理 token | 服务端控制台 | 删除空同步仓库，需要危险确认 |
| POST | `/api/admin/users/create` | 管理 token | 服务端控制台、调试/运维入口 | 创建或登记设备。控制台「设备 → 新建设备」显式调用；同名设备是幂等返回既有设备，控制台改为前置拦截并提示，不谎报新建。`/api/claims/create` 仍会在设备名首次出现时隐式建设备，但那是签发 SyncKey 的副作用，不是建设备的正式入口 |
| POST | `/api/admin/users/enable` | 管理 token | 服务端控制台 | 启用设备 |
| POST | `/api/admin/users/disable` | 管理 token | 服务端控制台 | 停用设备 |
| POST | `/api/admin/users/delete` | 管理 token | 服务端控制台、smoke lifecycle | 删除设备，需要危险确认 |
| GET | `/api/admin/singbox/config` | 管理 token | 服务端控制台、smoke、运维只读入口 | 预览脱敏 sing-box 配置 |
| POST | `/api/admin/singbox/write` | 管理 token | 调试/运维入口 | 重写 sing-box 配置，需要危险确认 |
| POST | `/api/admin/singbox/apply` | 管理 token | 服务端控制台 | 校验配置，通过受控 supervisor 重启 sing-box 并标记已应用 |
| POST | `/api/admin/singbox/mark-applied` | 管理 token | 调试/运维入口 | 兼容旧版运维自动化，在外部确认重启后标记配置已应用 |
| POST | `/api/claims/create` | 管理 token | 服务端控制台、smoke lifecycle | 生成一次性 SyncKey 和待兑换 profile；`code` 是 `AAAA-AAAA` 服务端兑换短码，`tKey`/`claimCode` 和 `tKeyUri`/`uri` 才是完整客户端导入凭据；显式 `server` 会更新 `settings.publicServerUrl`，但状态持久化失败必须回滚，不能发布幽灵 SyncKey 或污染 SyncKey 服务地址 |
| POST | `/api/claims/redeem` | 公开 | 客户端本地运行时、服务端控制台测试兑换入口、smoke lifecycle | 兑换一次性 SyncKey 为完整 profile；新客户端可带 `clientRedeemId` 和 `clientInstallId`，支持同一客户端绑定的短时绑定重放，不同客户端或缺失绑定仍返回 `claim_already_used`；兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用，校验 claim 创建时的 profile 下发材料仍与当前可签发材料一致，并拒绝已过期的 profile；设备、bucket、下发材料或 profile 过期失效时返回 `validation_failed` 且不得消耗 SyncKey；同一来源和同一 code 摘要连续失败过多时返回 `429 claim_redeem_rate_limited`，失败窗口持久化到服务端内部状态并在同一数据目录重启后继续生效，但不得泄露短码原文或消耗 SyncKey；默认忽略 `X-Forwarded-For`，只有显式 `SFSC_TRUST_PROXY=1` 且直连来源是 loopback 或 `SFSC_TRUSTED_PROXY_IPS` 中的可信代理 IP/CIDR 时，才用 XFF 第一个有效客户端 IP 作为限速来源 |
| POST | `/api/devices/heartbeat` | Profile heartbeat HMAC | 客户端本地运行时、smoke lifecycle | 上报设备在线状态、诊断和同步摘要；新 profile 必须使用 `profile.heartbeat.secret` 生成 `sfsc-hmac-sha256-v1` auth，服务端在时间窗口内拒绝重复 nonce，缺失返回 `heartbeat_auth_required`，签名错误或重放返回 `heartbeat_auth_invalid` |
| POST | `/api/vless/parse` | 管理 token | smoke、调试/兼容入口 | 解析 VLESS URI |
| POST | `/api/singbox/client-config` | 管理 token | smoke、调试/兼容入口 | 由 VLESS URI 生成客户端 sing-box 配置 |
| POST | `/api/profile/encode` | 管理 token | smoke、调试/兼容入口 | 编码包含 heartbeat 和 storage credentials 的完整 profile 导入码，并保留 source.server、heartbeat 密钥和 S3 存储凭据 |
| POST | `/api/jobs/preview` | 管理 token | smoke、调试/兼容入口 | 预览 rclone/sing-box/schedule 组合 |

服务端所有 `POST` 写入口在共享 schema 前先做 HTTP 层媒体类型防护：带请求体但不是精确 `Content-Type: application/json`（允许 `; charset=utf-8` 等参数）时返回 `415 unsupported_media_type`。该检查优先于管理 token 鉴权和未匹配路由兜底；只有无正数 `Content-Length` 且无 `Transfer-Encoding` 的空 body 可省略 `Content-Type`，零字节 chunked 请求仍视为声明了 body。

机器路由索引：GET `/api/admin/enrollment/v1/requests`；POST `/api/admin/enrollment/v1/requests/{requestId}/issue`；GET `/api/admin/enrollment/v1/directories`；POST `/api/admin/enrollment/v1/directories`；GET `/api/admin/enrollment/v1/trust`；POST `/api/admin/enrollment/v1/channel-code`；POST `/api/admin/enrollment/v1/reconfigure`；GET `/api/admin/enrollment/v1/reconfigure/{operationId}`；POST `/api/enrollment/v1/data-authorization`；POST `/api/enrollment/v1/channel-renewal`。

服务端控制台对 `/api/claims/create` 失败必须给出动作建议：`server_state_write_failed`、`network_error`、`request_timeout`、`storage_request_failed`、`server_error` 标为 `retryable: true` 并提示 SyncKey 未生成、可重试、检查 `sfsc-state.json` 数据目录权限/磁盘空间、sync-server 容器/反代/端口、N1 负载、sync-server 日志或 MinIO/S3 后重新生成 SyncKey；`danger_confirmation_required`、`device_disabled`、`bucket_disabled`、`bucket_not_found`、`user_not_found`、`validation_failed` 标为 `retryable: false` 并提示先确认兼容性风险、重新启用设备并应用 sing-box 配置、启用或重新选择同步仓库、刷新设备/仓库列表或检查表单后再重新生成。

服务端控制台对 `/api/claims/redeem` 测试兑换失败必须给出动作建议：`claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed`、`import_code_invalid` 标为 `retryable: false` 并提示 SyncKey 测试兑换失败、不可重试当前 SyncKey/当前内容、重新复制完整 SyncKey 或重新生成 SyncKey；`claim_redeem_rate_limited`、`server_state_write_failed` 标为 `retryable: true`，前者提示等待限速窗口并检查是否误粘贴或重复提交，后者提示兑换状态未成功持久化、SyncKey 不应视为已消耗、检查 `sfsc-state.json` 数据目录权限和磁盘空间，修复后用同一个 SyncKey 再试；`network_error`、`request_timeout`、`server_error`、`claim_redeem_failed` 标为 `retryable: false` 并提示结果未知、先刷新管理状态查看 claim 是否已 `used` / `redeemedAt`、不要把这个 SyncKey 交给客户端，无法确认时重新生成。

## 2. 客户端本地 HTTP API

客户端本地 `POST` 写入口在共享 schema 前先做 HTTP 层防护：拒绝 `Sec-Fetch-Site: cross-site`、非 `http:` 或非同一 loopback host/port 的 `Origin`，返回 `403 local_write_forbidden`；该 origin 防护优先于媒体类型检查。带请求体但不是精确 `Content-Type: application/json`（允许 `; charset=utf-8` 等参数）时返回 `415 unsupported_media_type`。

| 方法 | 路径 | 当前消费者 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/health` | 启动器、smoke、运维探活 | 客户端本地健康、版本和协议诊断 |
| GET | `/api/client/status` | 客户端 UI、smoke | `{...status,enrollment}`；固定包含身份接入摘要。`safeguards.localState.files` 精确包含 `profile`、`jobs`、`secrets`、`syncHistory`、`syncRecovery`、`claimRecovery`、`lastSuccessfulHeartbeat` 七项；`syncRecovery.path` 指向关系隔离恢复状态目录摘要 |
| GET | `/api/enrollment/session` | 客户端 UI | 读取首次接入的展示安全状态，不返回私钥、完整通道码或验证码 |
| POST | `/api/enrollment/channel/import` | 客户端 UI | 导入包装通道码，验证已签名 channel config 与随码 OOB pin；同一 serverId 的 signing key 变化时拒绝覆盖 |
| POST | `/api/enrollment/request` | 客户端 UI | 创建或重试当前持久化设备身份的签名申请；所有远端流量必须经该 channel 的专用 sing-box 代理 |
| POST | `/api/enrollment/consume` | 客户端 UI | 提交一次性身份验证码；只在验证绑定关系和 pinned Ed25519 receipt 签名后记录“身份已验证、等待目录授权” |
| POST | `/api/enrollment/data-authorizations/refresh` | 客户端 UI | 对已消费回执中的每个绑定，经 bootstrap 通道请求并验签新的数据授权；仅返回目录显示名和授权状态 |
| POST | `/api/enrollment/connection/repair` | 客户端 UI | 仅接受 `{operationId, relationId, jobId?}`；持久化本机修复操作并立即返回 operation 摘要，后台按原 relation/job 检查并修复连接，不修改目录绑定或同步基准 |
| GET | `/api/enrollment/connection/repair/` | 客户端 UI | 在该路径追加 `{operationId}` 查询并恢复同一修复操作；相同 ID 和输入返回/续做相同操作，输入冲突返回 `connection_repair_invalid`，并发同步或修复返回 `connection_repair_busy` |
| POST | `/api/client/shutdown` | 客户端 UI、测试 | 关闭本地 runtime |
| POST | `/api/binaries/check` | 客户端 UI | 检查内置 sing-box/rclone 组件和版本 |
| GET | `/api/profile` | smoke、调试/兼容入口 | 读取本地 profile 的展示安全摘要，不返回水合密钥或原始 VLESS URI |
| POST | `/api/profile/import` | 客户端 UI | 导入完整 SyncKey（`SFSC1-...` / `sfsc://import/v1#...`）、离线完整 profile 导入码，或用 `code: AAAA-AAAA` 加对应 HTTP(S) `server` 地址短码加入；短码缺少有效 `server` 时返回 `import_code_invalid` 且不消耗 SyncKey；SyncKey 远端兑换前写入 `data/claim-recovery.json` pending recovery stash；代理远端 redeem 登记错误时保留 status/errorCode/message，未登记或非结构化远端失败降级为 `claim_redeem_failed`；远端 HTTP 2xx 但响应不是 JSON/profile 对象或返回 `ok:false` 也降级为 `claim_redeem_failed` 并保留 recovery；远端成功但签发 profile 缺少 heartbeat/storage/tunnel 材料返回 `profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required` 并清理 recovery；带 `source.server` 的离线完整 profile 同样按服务端签发 profile 校验，缺 heartbeat/storage 不得回退默认值或占位密钥；远端终态错误 `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 清理 recovery；`claim_redeem_rate_limited`、`server_state_write_failed`、`claim_redeem_failed` 和本地提交失败保留 recovery；成功持久化 profile/jobs/scheduler/secrets 后清理；若刷新已有 job 或本地持久化失败，必须回滚导入前 profile/jobs/secrets；响应展示安全 profile 摘要，真实密钥进入本地 secret vault |
| GET | `/api/jobs` | smoke、调试/兼容入口 | 读取本地保存任务的展示安全摘要，不返回水合密钥 |
| GET | `/api/sync/history` | 客户端 UI、smoke | 读取最近同步历史 |
| POST | `/api/jobs/save` | 客户端 UI、本地自动化 | 保存同步任务并刷新调度器；SFTP 任务只能引用本地已验签数据授权的 relationId，host/user/key/known_hosts/channel 参数由签名授权重建；用户可调的 transfers/streams/checkers/retries/lowLevelRetries/cutoff/bandwidth/safety/schedule 使用共享有界 normalizer。只有已授权且已初始化的 SFTP 双向任务可保存自动计划，legacy S3 双向和未初始化 SFTP 必须手动；当最近一次成功 heartbeat 返回 `compatibility.policy.syncRun: "warn"` 时必须带 `confirmCompatibilityWarning: true` |
| POST | `/api/singbox/start` | 客户端 UI | 读取水合 profile 后启动本地 sing-box；本地 secret vault 缺失时返回 `secret_vault_missing` 且不得写配置或启动进程 |
| POST | `/api/singbox/stop` | 客户端 UI | 停止本地 sing-box |
| POST | `/api/sync/preview` | 客户端 UI | 预览 rclone 命令、远端配置和下次执行时间；SFTP 端口冲突时选择可绑定的 loopback SOCKS 端口，响应中的 `ALL_PROXY`、`--sftp-socks-proxy` 和 sing-box inbound 使用同一端口，不连接未知现有 listener |
| POST | `/api/sync/safety-plan` | 客户端 UI、本地自动化 | 对镜像和双向任务生成短时、任务指纹绑定的只读安全计划；枚举源端和目标端文件，检查删除上限和双向初始化状态 |
| POST | `/api/sync/bisync/conflicts/preview` | 客户端 UI | 只接受 `{job}`；对未初始化可信双向 relation 扫描冲突并 stage 双侧字节；响应 `{preview:{previewId,operationId,relationId,baselineId,rootId,createdAt,conflicts}}` |
| POST | `/api/sync/bisync/conflicts/save` | 客户端 UI | 只接受 `{job,previewId}`；成功响应 `{saved:{operationId,status,conflicts}}`；journal 按 relation/baseline/root 隔离，复制前后校验原文件，未知目标不覆盖 |
| POST | `/api/sync/bisync/conflicts/operations` | 客户端 UI | 只接受 `{job}`；返回未初始化可信 relation 的自有 journal `{operations:[{operationId,status,createdAt,savedAt,conflicts}]}`；只暴露相对副本名与哈希，不返回 staging 路径；已初始化 relation 返回空列表 |
| POST | `/api/sync/bisync/conflicts/resume` | 客户端 UI | 只接受 `{job,operationId}`；只恢复精确 journal 中状态为 `saving` 的操作；响应 `{saved:{operationId,status,createdAt,savedAt,conflicts}}`，已保存操作幂等返回；丢失的内存 preview 不要求重新初始化或删除状态 |
| POST | `/api/sync/bisync/initialize` | 客户端 UI | 接受 `{job,safetyPlanId,confirmBidirectionalInitialization:true,conflictOperationId}`；验证当前计划和冲突 operation，先 dry-run 再执行一次 `rclone bisync --resync`；不自动选择或伪造首次冲突确认 |
| GET | `/api/jobs/{jobId}/recovery` | 客户端 UI | 仅可信稳定双向 relation 可列出恢复版本及相对文件路径；检查任务授权、恢复区所有权与当前通道。精确兼容的非 SFTP `legacy_compatible` 任务没有新恢复版本，返回 `409 sync_recovery_trusted_relation_required`；活动同步期间返回 busy |
| POST | `/api/jobs/{jobId}/recovery/restore-preview` | 客户端 UI | 严格接受 `{runId,side,path,destinationPath}`；验签恢复版本哈希、验证路径并要求目标不存在，建立短时受保护暂存预览；响应不暴露暂存绝对路径 |
| POST | `/api/jobs/{jobId}/recovery/restore` | 客户端 UI | 严格接受 `{previewId}`；只按当前预览将文件以排他创建方式写入本地同步目录，校验 SHA-256，目标已存在时拒绝且不覆盖 |
| POST | `/api/jobs/{jobId}/recovery/restore-cancel` | 客户端 UI | 严格接受 `{previewId}` 并清理未执行的暂存预览 |
| POST | `/api/sync/run` | 客户端 UI、调度器、本地自动化 | 手动请求先通过兼容/删除确认，再进入 admission；准备中的同任务请求合并，不同 job 冲突返回 `409 sync_already_running`；运行中同任务返回当前状态，不同任务冲突；停止中的同 normalized fingerprint 重放停止状态。每轮由 `buildSyncRunPlan` 构造当前执行 job，并核验当前安全计划；计划 helper 独立重建/规范化 job 和授权。随后生成 rclone 预览与 app-scoped config；config 成功后才启动本次 runPlan 对应 tunnel，再启动 rclone。SFTP 的 `ALL_PROXY`、`--sftp-socks-proxy` 和 data sing-box inbound listen port 相等；busy requested/default proxy port 最多改选 3 个 OS 分配候选。新 trusted relation 每轮准备、验证并落盘恢复 journal；经旧 fingerprint/alias/workdir/initialized state 精确验证的非 SFTP `legacy_compatible` 任务继续原手动 bisync，不新建 recovery namespace。自动计划只允许已授权、已初始化 SFTP 双向任务；每轮重建安全计划并重验删除阈值/marker，超限、需初始化或授权失败不启动。data sing-box 自身退出及可识别临时断线限最多 3 次安全重试；auth/root/marker/permission/host-key 错误不重试。rclone config 失败不写同步历史、不启动 rclone sync。|
| POST | `/api/sync/stop` | 客户端 UI | 停止当前同步；运行中 stop 必须把状态置为 `stopping`，发送停止信号并等待 rclone 退出，响应可携带 `stopSignal`/`stopTimedOut` 诊断字段；正常停止完成后允许新的 `/api/sync/run` 启动 |
| GET | `/api/logs` | 客户端 UI、smoke | 读取脱敏近期日志 |
| GET | `/api/diagnostics/export` | 客户端 UI、smoke | 导出脱敏诊断包 |

Enrollment 本地 API 只接受字段白名单：通道导入和身份码消费只接受 `{ code }`，申请只接受 `{}`。导入包装码不是外部签名证明，客户端仍须使用码内 OOB pin 验证既有签名 channel config。新 Ed25519 私钥和复制来的通道配置仅保存到 ACL 保护的 enrollment-session 文件；身份验证码不写入状态、日志或 URL。申请/兑换远端请求只走专用 sing-box VLESS 通道，无通道、无二进制或代理未就绪时失败关闭，不回退直连。状态仅表达通道验证、申请待处理或身份验证后等待目录授权，不代表同步授权或同步就绪。

## 3. 跨端运行链路

| 发起端 | 方法 | 目标路径 | 触发点 | 成功结果 | 失败合同 |
| --- | --- | --- | --- | --- | --- |
| 客户端本地运行时 | POST | `/api/claims/redeem` | 用户导入 SyncKey | 保存完整 profile，刷新已有 job 的 profile 派生字段；若存在同一 server/code 摘要的 `claim-recovery.json`，复用其中 `clientRedeemId` / `clientInstallId` 绑定恢复导入未完成；profile/jobs/secrets 必须同进同退 | 请求默认 15 秒超时，可用 `SFSC_CLAIM_REDEEM_TIMEOUT_MS` 调整；优先保留服务端合同登记的结构化错误码，例如 `claim_not_found`、`claim_already_used`、`claim_expired`、`claim_redeem_rate_limited`、`server_state_write_failed`、`validation_failed`；远端非结构化失败、未登记错误码、超时，或 HTTP 2xx 但响应不是 JSON/profile 对象、返回 `ok:false` 时使用 `claim_redeem_failed`，收到远端 HTTP 响应时保留 status，无 HTTP 响应使用 502；客户端导入后必须补齐 source.server，兑换成功但 profile 缺少 heartbeat、storage credentials 或 tunnel 时必须拒绝导入并清理 pending recovery stash；远端终态错误 `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 清理 pending recovery stash，`claim_redeem_rate_limited`、`server_state_write_failed`、`claim_redeem_failed` 和本地提交失败保留；pending recovery stash 不得保存完整 SyncKey、不得保存一次性短码或 secrets |
| 客户端本地运行时 | POST | `/api/devices/heartbeat` | 启动、导入 profile、同步结束、周期心跳 | 使用 `profile.heartbeat.secret` 签名请求；客户端状态记录 `heartbeat.ok: true`、服务端 diagnostics、兼容性摘要和脱敏 `device.sync` 摘要 | 客户端本地状态使用 `heartbeat_failed`，服务端 `heartbeat_auth_required` / `heartbeat_auth_invalid` 等错误码放入 `remoteErrorCode`；HTTP 2xx 但非 JSON、空 body、缺少成功契约字段、`diagnostics.role/protocols` 非服务端协议、`device.sync` 缺失、`syncState` 与 `sync.state` 不一致或 `speedMbps` 与 `sync.speedMbps` 不一致，也必须按 `heartbeat_failed` 处理，且不得更新 `lastSuccessfulHeartbeat` |

客户端 UI 对 SyncKey 导入失败必须给出动作建议：终态错误 `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 标为 `retryable: false` 并提示不可重试当前 SyncKey/当前内容、检查输入或重新生成 SyncKey；`claim_redeem_rate_limited`、`server_state_write_failed`、`claim_redeem_failed` 标为 `retryable: true` 并提示可重试、等待限速窗口或检查服务端数据目录权限/磁盘空间、网络、服务端地址和服务端进程，修复后用同一个 SyncKey 再试；`profile_heartbeat_required`、`profile_storage_required` 表示服务端签发 profile 缺材料，提示检查服务端配置后重新生成 SyncKey。

## 4. 矩阵维护规则

- 新增、删除或改名任一 `/api/*` 路由时，必须同步更新本文档和 `docs/INTERFACE_CONTRACT.md`。
- 页面新增直接调用时，必须确认该路径已经出现在对应矩阵中。
- 客户端后台新增服务端调用时，必须补充“跨端运行链路”；发布审计会从客户端后台 `fetch(.../api/...)` 调用中抽取出站路径，并要求它出现在该表中。
- smoke 脚本新增直接调用时，对应 API 行的“当前消费者”必须包含 `smoke`。
- 修改 `/api/admin/sync-spaces/create`、`/api/admin/tunnel/generate`、`/api/admin/tunnel/autofill`、`/api/admin/singbox/write`、`/api/admin/singbox/apply`、`/api/admin/singbox/mark-applied`、`/api/admin/enrollment/v1/directories`、`/api/admin/enrollment/v1/requests/{requestId}/issue`、`/api/admin/enrollment/v1/channel-code`、`/api/admin/enrollment/v1/reconfigure`、`/api/admin/storage/save`、`/api/admin/storage/buckets/refresh`、`/api/admin/storage/buckets/create`、`/api/admin/storage/buckets/enable`、`/api/admin/storage/buckets/disable`、`/api/admin/storage/buckets/clear`、`/api/admin/storage/buckets/delete-empty`、`/api/admin/users/create`、`/api/admin/users/enable`、`/api/admin/users/disable`、`/api/admin/users/delete`、`/api/claims/create`、`/api/claims/redeem`、`/api/devices/heartbeat`、`/api/binaries/check`、`/api/enrollment/channel/import`、`/api/enrollment/request`、`/api/enrollment/consume`、`/api/enrollment/data-authorizations/refresh`、`/api/enrollment/connection/repair`、`/api/client/shutdown`、`/api/profile/import`、`/api/jobs/save`、`/api/singbox/start`、`/api/singbox/stop`、`/api/sync/preview`、`/api/sync/safety-plan`、`/api/sync/bisync/conflicts/preview`、`/api/sync/bisync/conflicts/save`、`/api/sync/bisync/conflicts/operations`、`/api/sync/bisync/conflicts/resume`、`/api/sync/bisync/initialize`、`/api/jobs/{jobId}/recovery/restore-preview`、`/api/jobs/{jobId}/recovery/restore`、`/api/jobs/{jobId}/recovery/restore-cancel`、`/api/sync/run`、`/api/sync/stop`、`/api/profile/encode`、`/api/vless/parse`、`/api/singbox/client-config` 或 `/api/jobs/preview` 的请求字段时，必须同步更新 `src/core/protocolSchemas.js` 和 `tests/core.test.js` 的 schema 回归。
- 修改 `/api/sync/safety-plan` 的请求或响应字段时，同样必须同步更新 `src/core/protocolSchemas.js`、运行时合同和测试。
- 修改 `/api/sync/bisync/initialize` 的请求或响应字段时，同样必须同步更新 `src/core/protocolSchemas.js`、运行时合同和测试。
- `tests/core.test.js` 和 `scripts/audit-release.mjs` 会从 `src/server.js`、`client/src/clientServer.js`、`public/app.js`、`client/public/app.js` 和客户端后台代码中抽取 `/api/*` 路径，确保本文档覆盖当前代码事实。
