# P2 每关系文件服务与新引擎后续合同

日期：2026-10-20  
当前状态更新：2026-10-24。manager、原生 runtime、启动准入和真实目录组合已取得分段运行证据；
N1 ARM64 单关系 main→catalog→root guard→SFTP 读写→同 manager 停用场景通过，见执行记录
run `023c5f233af74b8a`。这不表示 API/UI、完整双向引擎、通道隔离及 P2 全闸门已通过。
以下 2026-10-20 的模块状态和“尚未验收”列表保留为历史合同/切片边界；当前阶段结论以
`DEVELOPMENT_EXECUTION_2026-10-19.md` 的对应运行记录为准，不把历史待办重复当作当前缺失事实。

## 已确认依据

- 用户目标是N1普通目录与Windows双向同步，正常使用隐藏底层配置，换通道码后保持原关系、目录及可信基准。
- auth-proxy共享进程的helper撤销在本机新连接实测未即时生效，证据见P2_DIRECTORY_ADAPTER_DECISION_2026-10-20.md。
- 本机SFTP checksum样例可识别同尺寸同秒改写；N1、完整写入、中断、代理和成本尚需验证。

## 当前 manager-only V2 候选

### 接口与兼容边界

当前模块在原有 `disable`/`reconcile` 之外增加：

```text
start({ relationId, operationId, identity, expectedHandleDigest, launch })
query({ relationId })
```

- V1 `disable`/`reconcile` 的公开结果字段、weak writer 路径和既有回归保持冻结。
- V2 `start` 只允许 `state.version=2` 的 durable writer 路径；首次 start 可把合法 V1
  账本迁移为 V2，并在同一事务中加入首个 start reservation。
- `query` 只读取 manager 账本，不调用 runtime/protection，不增加 revision。
- `start` 成功返回 `relationId/operationId/desired/state/reason/generation/handleDigest`；
  V1 结果不增加 `handleDigest`。公开结果不返回 handle token、runtime identity、
  lease、路径、异常正文或 launch 原文。
- V1 非 canonical generation 历史会阻断新 start，但不阻断冻结的 disable/reconcile。
  V2 新 generation 使用 BigInt 最大值加一，已消耗但 `handle=null` 的 generation
  不复用。

### 持久 schema 与锁

- V2 顶层、operation 和 relation 使用 exact key；额外字段、缺失字段、错误
  nullability、未知 phase、非法 digest、handle/runtimeIdentity/evidence 不一致均按
  `relation_file_service_state_invalid` 阻断，不自动修复或覆盖。
- 每次 mutation 先取 relation scope，再在短 state scope 内读账本、比较 operation
  幂等性、identity、desired、expected handle digest、generation 和 cleanup/commit
  preflight。runtime/protection 调用发生在 state lock 之外；abort 同样使用有界
  invocation，不得在 state lock 内等待 adapter Promise。
- `query` 只取 state scope。durable rename 与 query 由同一 state lock 串行化，
  测试只观察到一个完整旧快照或完整新快照。
- 正常 V2 phase、handle、protection、runtime identity、running evidence 和
  cleanup evidence 的合法组合由 schema 与合同测试逐项约束。

### start 生命周期

2026-10-28 补充：`disable` 持久写入 `desired=disabled`，表示停用意图；即使旧进程、
监听和会话均已确认关闭，携带精确旧 `expectedHandleDigest` 的 `start` 仍须拒绝，
不能把该摘要当成重新授权。拒绝不得推进 generation 或改写原账本。换通道配置、
运行进程故障恢复与设备停用是不同操作；当前公开 facade 只有 start/query/disable/reconcile，
未提供显式重新启用接口。F 场已观察到该拒绝，完整通过与否仍以执行记录为准。

V2 start 的可见阶段为：

```text
starting → prepared → running
                    ↘ cleanup_required → start_failed（仅内部恢复）
                    ↘ commit_uncertain（dir fsync/commit 不明）
```

- reservation 先持久化 generation、`starting` 和 fence 基础字段，再执行 protection、
  prepare、durable prepared checkpoint、go、post-go running inspection 和 durable
  running finalize。
- prepare 返回的 handle、generation、runtime identity、provisional evidence 和
  listener 必须匹配本次 request/fence。listener 只接受请求中的精确 loopback
  host/port；listener 打开及 ownership 必须由独立 running evidence 证明。
- opaque lease 的存在性只按 `lease !== null && lease !== undefined` 判断；
  `0`、`false` 和空字符串都是有效 opaque 值，必须原样传给 go/abort，不得做
  truthiness、类型或字符串转换，也不得 inspect 或持久化 lease 本体。null 和
  undefined 均表示没有 lease。
- fulfilled prepare 即使因 handle/identity/evidence 无效而不能进入 `prepared`，
  只要原响应返回非 null 且非 undefined opaque lease，manager 仍须以同一 fence 有界 abort 该
  lease，并保持 `cleanup_required`。不得把无效 handle 用于 inspect，也不得仅凭
  abort fulfilled 或 containment 单项声明 `confirmedStopped`；abort timeout 须
  持久登记 continuation 并保留进程内 lease 责任。
- prepare 超时后到达的 invalid fulfilled response 若返回非 null 且非 undefined
  opaque lease，
  `cleanupEvidence` 必须如实记录 `latePrepare: "invalid"`、
  `leaseReturned: true` 和 unconfirmed disposition。manager 只用原 fence
  回收该 lease；没有完整 cleanup-purpose inspect 时状态保持
  `cleanup_required`。
- prepare/go/inspect/abort 超时使用同一 fence 的 `AbortSignal`。迟到 outcome 被登记，
  原调用先持久 `cleanup_required` 并释放 relation lock，再由内部 recovery 排队。
- continuation registry 原子缓存 fulfilled value 或 rejected error。每个
  continuation 只允许一个订阅者；订阅发生在 settlement 前、结算竞争期间或
  settlement 后，都必须恰好投递一次，已 settle 的结果在订阅时立即 replay。
  重复 recovery 若观察到同一操作已完成 cleanup，不得再次 abort 当前 lease。
- 新 disable/new operation supersede 原 start 后，旧 recovery 只能回收旧 lease，
  不得修改新 operation/relation。running finalize 在 state lock 内只返回 supersede
  标记；锁释放后才对该 attempt 的 exact lease 做一次有界 abort，且不得再进入会
  重复 abort 的通用失败清理。
- `cleanup_required`、`commit_uncertain`、`unknown` 和 volatile quarantine 均阻断
  公开 start/disable/reconcile；只有内部、同 fence、完整 confirmed cleanup 可把
  `cleanup_required` 原子转为 `start_failed`。

### cleanup evidence 绑定

`cleanupEvidence` 持久记录 checkpoint、late prepare/go 状态、abort/containment、
process/listener/session/children 状态、稳定 reason code 和 exact handle identity。

- `confirmedStopped` 必须包含与当前 relation handle 完全一致的 relationId、
  generation 和 handle digest，并确认 process、listener、sessions、children 全部停止。
- `notInvoked` 不得携带 handle identity、runtime identity 或虚假的进程关闭结果。
- `unconfirmed` 不得被公开结果解释为“没有进程”或“已停止”。
- cleanup-purpose inspect 返回的 identity 或任一 containment 字段不完整时，状态保持
  `cleanup_required`，不会进入 `start_failed`。

### durable writer、close 与 cleanup

Linux 默认 writer 在同一真实父目录内创建唯一 temp，并使用
`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW|O_CLOEXEC` 和 mode `0600`：

```text
open/verify parent
→ read/validate current revision and exact destination schema
→ create/fstat/fchmod/reverify temp
→ write → file fsync → close
→ reread/validate destination revision and exact schema
→ rename → parent fsync → close parent
```

- temp 的 regular-file、owner 和完整 `mode & 07777 === 0600` 均须核验。
- 首次读取和 rename 前重读都必须校验目标账本本身；revision 相同但目标 JSON 已损坏
  或含额外字段时不得覆盖。
- file fsync/close、rename 前 revision/schema、parent open/fsync/close 任一失败均不得
  映射为公开成功。rename 后的 parent fsync 或 parent close 失败返回
  `commit_uncertain`，不改写为 `committed`。
- 未 rename 的 temp 只有在本次 `O_EXCL` 创建成功且 lstat 的 dev/ino 完全匹配时才可
  unlink。foreign、symlink、identity mismatch 或首次 fstat 前失败均保留
  `left-*`/`left-without-identity`，不得猜测删除。
- rename 已返回后不得删除或覆盖 statePath。commit marker 只标记本次 attempted
  operation/relation，不得把无关 running relation 改成 commit uncertain。

### commit uncertainty 与历史 running digest

`commitUncertain` 和 `cleanupRequired` 是正交持久字段，任一写入不得清除另一项。
parent fsync/close 不明时，本 manager 实例立即进入不可由公开 API 清除的 volatile
quarantine；marker durable 失败仍保持 quarantine。重开只按磁盘可见 checkpoint
fail closed。

窄例外：`phase=start_failed` 且 cleanup evidence 为完整 `confirmedStopped` 时，
允许保留此前 checkpoint 已存在的 `runningEvidenceDigest`。该 digest 只是历史观测，
`query.runningEvidencePresent=true` 不表示当前仍在 running；新 start 仍必须重新
preflight 和有界 cleanup inspect。重检时首次 state snapshot 形成 retry binding，
包含原 operation/relation、generation、handle、expected handle、protection、
cleanup evidence、exact handle identity 和 generation history；有界 inspect 完成
后，reservation 在同一 state lock 内确认该绑定逐项未变，才原子写入新 generation
的 start reservation。任一字段或 generation history 改变均 fail closed。

### 当前测试与独立 gate

目标测试已覆盖 V1 回归、迁移、BigInt generation、exact schema/overlay、state lock、
并发 rename snapshot、稳定 JSON/脱敏、late prepare/go/abort 的
settlement-before-subscription replay、invalid prepare opaque lease abort、
`0`/`false`/空字符串 lease 的原值传递与至多一次 abort、null/undefined 无 lease、
confirmedStopped retry binding、running finalize supersede、cleanup 字段矩阵和
reopen checkpoint 正交矩阵。mock durable writer 的
open/fstat/chmod/write/file fsync/close/rename/parent fsync/temp cleanup 失败由
writer 合同测试覆盖。

marker-specific 失败矩阵只覆盖 V3 §15.6(3) 明确列出的六个阶段：temp open、
write、file fsync、temp close、rename、parent fsync。该范围不表示 durable writer
的所有 syscall 或所有可能失败组合均已验证；parent open、temp fstat、chmod、
parent close 和 temp cleanup 由通用 writer 测试单独覆盖。

这些是模块与注入式合同证据。以下仍未验收：

- 固定 Node `22.23.1` / Linux ARM64 容器中的真实默认 writer storage probe；
- 真实文件系统上的掉电/崩溃恢复证明；
- 生产 supervisor/native launcher 的 prepare/go/abort、pidfd、进程归属和 listener/
  session/socket ownership；
- 跨进程 relation lock、自动恢复和历史 PID 清理；
- API/UI、N1 服务生命周期接线、真实数据操作和部署。

## 建议的文件服务切片

1. 一个device/relation持有一个独立loopback服务进程及静态授权文件；不使用共享auth-proxy缓存。该切片首先验证单设备绑定，不提前开放同目录多设备并行写入。
2. 根路径只来自服务端已登记且root guard检查通过的记录，不接受客户端任意物理路径。凭据不是目录注册依据。
3. 服务端只暴露SFTP及锁定版本支持且需要的checksum操作；不允许通用shell、端口转发或任意内网访问。必须实测，而非仅根据SSH/SFTP名称推断。
4. 服务默认dir-cache-time=0。marker和stage保留名必须在服务端与同步端排除，并用已知路径直接读写验证排除有效；只在列表隐藏不足以验收。
5. 停用先持久化期望状态与操作ID，再停止受控进程并确认监听关闭、已有会话断开和新访问拒绝。失败或结果不明必须报告处理中或失败；监督器不得把已停用关系重新启动。
6. 其他关系维持服务。进程PID必须绑定本次受控实例，重启后不能仅凭历史PID操作未知进程。
7. 进程数、CPU、RSS、扫描及checksum耗时必须在N1 ARM64测量，未测量前不承诺容量。

## 新引擎与兼容性

- 旧S3任务的engine对象、比较方式和基准定位保持现有语义。
- 新普通目录任务使用独立engine合同，显式包含工具版本、比较参数、checksum方式和保留名过滤规则；不能仅在执行时临时追加checksum而仍沿用旧语义身份。
- SFTP必须显式设置该backend支持的socks_proxy，并用代理关闭时无法传输等对照验证。HTTP_PROXY/ALL_PROXY本身不作为证据。
- 主机公钥固定；凭据通过受保护配置或进程环境注入，不进入argv、预览和日志。更换通道不改变内容根与关系身份。
- 同relation有已初始化旧baseline时，新的baseline/engine不能按全新任务返回ready，不能自动resync；必须先进入迁移审核。包括丢失job记录而仍保留baseline账本的情况。
- 相同baseline但状态条目损坏也必须阻断。确认迁移的后续事务需要保留旧基准、差异预览与回退材料，不在本切片实现隐式批准。

## 最小证据顺序

1. 独立服务脚本：单关系读回 → 双关系各自读回与错误key拒绝 → A已认证连接与新连接在停用后拒绝，B继续正确读回；精确清理随机测试密钥与进程。
2. 路径与能力边界：已知保留名直接访问、父目录、绝对路径、symlink/junction及SSH shell/转发请求逐项记录。
3. 新engine模型、状态门控和命令配置接线；旧任务回归与同relation旧engine迁移阻断。
4. 服务生命周期接线到登记/停用/根健康及重启恢复，再进行N1与真实通道隔离样例。

每项未通过时保留失败材料。局部脚本或模块通过不能替代P2整体或A01–A20验收。

## 当前实施阻断与范围更正（2026-10-20）

第4项的服务端exclude只可作过滤，不得当成保留名写权限边界。主审原生OpenSSH put实验已改写marker和stage，Luna独立复核成立。路径证据见P2_DIRECTORY_ADAPTER_DECISION_2026-10-20.md；后续服务必须在create/open-write/remove/rename等写入口或文件系统边界明确拒绝保留名修改后才能接线。N1已有immutable原语及SFTP精确put的局部证据，仍无已接线并验收的产品替代实现。

历史 V1 首切片是独立relationFileServiceManager模块的disable/reconcile路径；该路径继续冻结，持久JSON、注入分域锁、单manager所有权及runtime exact handle/closure回执仍有效。V1 weak atomic rename不等于fsync或掉电持久性。当前 V2 候选新增的start/query、exact schema、cleanup证据和durable writer边界见上文；模块仍不包含实际 supervisor/launcher 或产品启动接线。根异常不能作为拒绝停用的前提。

## 保护启动门约束（实验后的建议；生产接线尚未实现）

- 当前N1 ext4实验支持继续采用文件系统immutable作为候选边界；该证据不适用于未经验证的文件系统或运行身份。
- root guard完整stage写入、hardlink安装marker及最终验证完成后，必须在可写文件服务启动前设置并核验保护；不能在设置immutable后再尝试安装hardlink。
- marker/stage身份或内容不符、保护设置/读取失败、服务capability或NoNewPrivs不符时，服务启动必须阻断；不能退回仅exclude的可写模式。
- 解除保护只能由受控管理路径执行，不能由文件服务或普通重连触发。换通道码不应改动root标记、relationId或同步基准。
- 下一产品小包须明确重启后的保护重验、异常启动的精确进程回收、失败状态查询以及与已持久停用关系的冲突处理。当前 manager-only V2 候选提供状态与证据合同，但不提供这些生产启动保证。
- 完整路径、SSH能力及SFTP remove/rename/hardlink尚需单独证据；本次put成功不能替代这些门槛。证据范围见适配决策记录。

## 已实现的保护检查模块与接线边界（2026-10-20）

`ensureDirectoryRootProtection()` 已在 `src/core/linuxImmutableHandle.js` 实现。它通过真实 root guard 前后检查、已打开 marker fd 3、已验 SHA 的 helper fd 4，执行 Linux 原生查询/设置及结果复核。stage 可缺失；存在时须为同一 marker inode，且前后状态一致。检查失败抛错，不创建标记、不清除 immutable，也不启动文件服务。

原生程序及 Node 模块已在 N1 ext4 / ARM64 / Node 22.23.1 的临时隔离环境实测，证据与限制见执行记录“目录保护产品模块与 ARM64 实机验证”。这不是已接入服务生命周期的保证。实际服务启动方仍须在共同 relation 锁内调用本检查，并遵守持久停用意图；原生 launcher、精确 supervisor 及 API 尚未实现。

后续生命周期采用 manager additive 接口，保留单一 desired 状态，不另建互不协调的启停账本。V1 disable/reconcile 合同继续冻结；manager-only V2 start/query 与 durable writer 已形成候选，但真实 supervisor/launcher、API/UI、崩溃恢复、跨进程锁和产品接线仍须独立预审与验收。管理 Node 持 immutable capability 的信任边界明确接受；可写文件服务必须在 exec 前清除 capability 并验证 NNP。未完成该隔离与接线前，不修改生产容器能力或开放新目录服务。

## SFTP engine 核心切片（2026-10-24）

本切片只冻结 SFTP engine 的描述、关系基准、命令构造和输入形状，不开放 HTTP/UI，
不修改 enrollment/profile 流程，也不连接 N1。

- SFTP relationship descriptor 使用 `semanticsVersion=2`、checksum 比较和两个根级
  reserved excludes；S3/WebDAV 保持 `semanticsVersion=1` 的既有描述。
- relation 构造只将精确小写 `sftp` 作为新 backend 入口；其他大小写或带空白拼写
  固定拒绝且不回显原值。这不扩大 `storage.js` 的输入范围。S3/WebDAV 保留既有大小写
  归一化兼容。
- SFTP 的目标和 baseline 只使用 canonical `rootPath`；job 或 trusted binding 中残留的
  `bucketName` 归一为空，不参与远端路径或 baseline 身份。
- SFTP transport 固定为 `host`、`port`、`user`、`socksProxy`、`knownHostsFile`、
  `keyFile`、`hostKeyFingerprint`、`credentialRevision` 八个字段。
- `rootPath` 必须是 string。空字符串表示该关系映射后的虚拟根，生成 `alias:`；
  缺失或非 string 必须拒绝。非空值只能是 canonical 相对虚拟路径，仍拒绝绝对路径、
  `.`、`..`、空路径段、反斜杠和控制字符。空串不得用 bucket/prefix/folder 等字段回填，
  也不表示宿主文件系统 `/`。
- 代理只接受 `localhost`、回环 IPv4 或带方括号的回环 IPv6 `[::1]:port`。
- job 和 options 的任意嵌套普通字段出现非法秘密字段名或标准 PEM 私钥头时阻断，
  错误信息不包含原值。该扫描不声称能识别任意无标记秘密字符串。
- SFTP command 显式设置 `--sftp-socks-proxy`；remote-scoped 环境配置同时保留。
  使用锁定 rclone 1.74.3 的本机对照确认：仅有 remote-scoped 值时会使用该值，但与
  继承的全局 `RCLONE_SFTP_SOCKS_PROXY` 同时存在时全局值胜出；因此命令层显式 flag
  是本切片要求的代理绑定，不能用环境变量优先级作为安全保证。
- 本切片只校验输入形状。文件存在性、权限、引用解析、known_hosts 内容与 host key
  fingerprint 的一致性、保留名写入口保护、真实代理路由和真实 SFTP 传输均留给执行层
  与后续验收，不能由本切片测试通过推出。
