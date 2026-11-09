# P2 Linux relation runtime adapter 合同

日期：2026-10-21  
状态：隔离 runtime-adapter 实施候选；未接产品 API/UI、未部署 N1、未访问真实数据。

## 范围

【已确认事实】本切片只验证一个隔离 relation：

```text
prepare/go
→ rclone SFTP listener 启动
→ 已认证写读并保持 transport
→ disable
→ process/listener/sessions/children 四项清理
→ final inspect
→ supervisor release
```

【已确认事实】冻结输入绑定：

- manager：`src/core/relationFileServiceManager.js`
- root-guard：`native/sfsc-root-guard/`
- 既有 manager 合同：`docs/P2_SFTP_RELATION_SERVICE_CONTRACT.md`
- 实施批准：`.tmp/development-2026-10-20/p2-runtime-adapter/parent-runtime-adapter-implementation-approval.json`

本切片不修改上述冻结文件，也不把它们重写为新候选。

## Ownership

```text
Node durable lifecycle owner
└─ relation supervisor
   ├─ runtimeIdentity.manager / PID namespace subreaper
   ├─ exec-service → 原 PID execve rclone
   │  └─ runtimeIdentity.process / listener owner
   └─ one-shot signal-service
      └─ caller=supervisor；target parent=supervisor
```

【已确认事实】manager 要求 `process.pid != manager.pid`，且 process 的 parent PID/starttime 等于 manager。冻结 exec-service 校验直接 parent；signal-service 校验直接 caller 和 target parent。

【建议】Node 不伪造为 `runtimeIdentity.manager`。每个 relation attempt 启动一个独立 supervisor；supervisor 自己直接启动 exec-service。helper 在 `go` 后保持原 PID，经冻结 fd3 路径 `execve` 为 rclone。rclone 使用冻结 argv 自行绑定 `127.0.0.1:<port>`。

## Node adapter

新增模块：`src/core/linuxRelationFileServiceRuntime.js`

### 构造参数

```text
supervisorPath
execServicePath
signalServicePath
rclonePath
rootPath
authorizedKeysPath
hostKeyPath
requestTimeoutMs
releaseTimeoutMs
```

【已确认事实】所有路径必须是绝对路径。测试可注入 `spawnSupervisor`、`probe`、`randomBytes`、`clock` 和只读 `onObservation`；生产默认值只使用 Node 内置模块。

### 方法

- `prepare({launch},{fence})`：生成 128-bit token，启动 supervisor，获取 helper 原 PID/starttime、launcher/target identity、namespace 和 provisional evidence。返回 opaque lease、handle、runtime identity、provisional evidence。
- `go(lease,{fence})`：只接受本次 attempt 的 lease，向同一 helper 写入 strict `go` 帧。
- `inspect(handle,{fence,purpose})`：支持 `running`、`disable`、`cleanup` 三种 exact 回包。
- `abort(lease,{fence})`：只回收该 lease 的 attempt，与 `stop` 共用精确清理实现；返回 `containmentConfirmed`，不自行声明最终 stopped。
- `stop(handle,{fence,purpose:"disable"})`：停止 exact handle。fulfilled 只表示清理命令完成，最终状态仍由后续 disable `inspect` 决定。

### fence 与 identity

【已确认事实】running inspect 使用 start fence 生成 `fenceDigest`。

【建议】disable 使用该 disable operation 的新 fence。adapter 校验：

- fence relationId/generation 与 handle 相同；
- handle 的 relationId/generation/token 与原 session 完全相同；
- observed manager/process identity 与原 runtime identity 完全相同。

disable 不要求复用 start fence，也不把 start attempt ID 当成 disable authority。

## Go supervisor

新增目录：`native/sfsc-relation-supervisor/`

### 控制 owner

【建议】Go 主控制循环调用 `runtime.LockOSThread`，并由该锁定 OS thread 串行执行：

- prepare/go 请求处理；
- helper、signal-service fork；
- exact PID/starttime 校验；
- 所有 `Wait4`/`waitpid` 回收；
- cleanup 的 TERM/KILL 与 adopted-child drain。

其他 Go runtime thread 可以存在。`GOMAXPROCS=1` 不作为单线程证明；唯一约束是唯一受控 fork/reap ownership。

【建议】supervisor 在启动任何 child 前：

1. 对 Node 设置并复核 `PDEATHSIG=SIGKILL`；
2. 设置 `PR_SET_CHILD_SUBREAPER`；
3. 记录 supervisor PID/starttime。

### task census

【建议】running `children.allTracked:true` 定义为：

- supervisor 是该 attempt 的 subreaper 根；
- 扫描 supervisor 全部 `/proc/self/task/*/children`；
- 对每个 descendant 的全部 task children 递归扫描并按 PID 去重；
- supervisor task set 在采样前后不变；
- 两次递归 census 结果一致；
- 任一步读取失败、task 变化或结果变化则 `allTracked:false`。

该值是本次完整成功 census 的包含性观测声明，不声称原子冻结未来 fork。

### listener 与 session

【建议】观测复用 `/proc/<pid>/net/tcp`、`tcp6` 和 `/proc/<pid>/fd`：

- listener 必须是唯一 `127.0.0.1:<port>` `LISTEN`；
- listener inode 必须由 exact rclone PID 的 socket fd 持有；
- `socketDev` 来自 exact fd path 的 `stat`，`socketIno` 来自 TCP 表；
- session 按 exact listener 上 `ESTABLISHED` 的 SSH transport 计数；
- 同一 transport 内多个 SFTP channel 不重复计数；
- 每个 established inode 也必须由 exact rclone PID 持有；
- 任一项不完整时 `sessions.tracked:false`。

【已确认事实】Go supervisor 与 Node independent probe 对 TCP 表采用严格解析。header 必须存在且字段位置符合 Linux `/proc/net/tcp` 格式；除最终空行外，任何非空行的字段数、地址、端口、state 或 inode 不能解析时，本次观测按失败关闭处理，不能解释为空表或“已关闭”。

【已确认事实】隔离 N1 实测中，`/proc/net/tcp` 第二列标签为 `rem_address`，`/proc/net/tcp6` 第二列标签为 `remote_address`。Go 与 Node parser 仅在该固定列接受这两个精确标签；`remote-address`、`remoteaddr`、大小写变体或其他近似标签仍按 `header_invalid` 拒绝。Node 公开的默认 `parseTcpTableText(text)` 调用继续接受原有 `rem_address` 表头。

【已确认事实】活动 transport 只定义为 `ESTABLISHED`（state `01`）。`TIME_WAIT`、`CLOSE_WAIT` 等内核残留状态不延长 session closure；process exit、exact child reap、listener fd/inode 消失和 client transport 断开共同提供清理证据。

【已确认事实】`/proc/<pid>/fd` 扫描遇到短暂 fd 关闭竞态时重新采样；重采后仍不稳定、权限错误、fd 名称或 stat 不可解释时返回失败，不能把读取错误当成“socket 不存在”。

精确 session tuple 只保存在 adapter/supervisor 私有状态，不进入 manager exact evidence schema。

【已确认事实】cleanup 开始时必须尝试一次完整 session census。若 TCP/fd 观测失败或 `sessions.tracked:false`，本次 census 记为不完整；后续仍继续有界停止和回收 exact process/children，但最终 `sessionsClosed` 必须为 `false`，不得回退到旧 tuple 集合或把空 tuple 集合解释为关闭。

【已确认事实】Node 默认独立 session probe 在 exact rclone 退出后重新读取当前 `/proc/self/net/tcp` 与 `tcp6`，检查 exact listener port 上是否仍有 loopback `ESTABLISHED` transport。该 probe 不依赖 adapter 缓存的 tuple；缓存为空不能证明端口没有新 transport。TCP 读取或严格解析失败仍为未确认。

【已确认事实】supervisor 只有在 exact listener port 上存在唯一 loopback `LISTEN` 时才可继续建立完整 session census。监听条目为 0 或多于 1 时，即使当前没有可见 `ESTABLISHED`，也必须返回 `sessions.tracked:false`；不得仅凭监听缺席推断“已知零会话”。若 listener 已关闭但仍保留原端口上的 `ESTABLISHED` socket，本次 census 同样保持未确认。

【已确认事实】`SupervisorClient` 对 child stdin `error`/`close`、同步或异步 frame write 失败及 child `error`/`exit` 使用同一失败通道。首次失败清除全部 pending timer 并恰好拒绝一次，后续 request 必须因失败通道不可用而拒绝；后续事件不得产生未处理异常或二次写入。

### cleanup

【建议】`abort` 与 `stop` 共用：

1. 校验 exact rclone PID/starttime/token/parent/executable；
2. one-shot signal-service 发送 TERM；
3. 有界等待；
4. 仍存活时再次经 signal-service发送 KILL；
5. supervisor 等待并 reap 每个 signal-service；
6. 等待 exact rclone 退出；
7. 对所有 adopted direct child 做 exact TERM/KILL；
8. 持续 wait/reap 直到 `waitid/waitpid(-1, WNOHANG)` 明确 `ECHILD`。

【已确认事实】supervisor 对尚未 reap 的 direct child 先取得 pidfd，再校验 parent/starttime 并调用 `pidfd_send_signal`；不再使用裸 PID `kill`。未 reap 状态本身也保证 PID 不会被复用，pidfd 进一步固定发送目标。

`ECHILD` 前 supervisor 不得退出。超时、仍有 child、wait 失败或 supervisor 失联均返回 unconfirmed。

【已确认事实】process presence 是三态观测：`/proc/<pid>/stat` 消失、starttime 不同或进程处于 `Z/X` 才可判为 gone；parent/starttime 身份冲突及权限、格式或其他读取错误判为 unknown，不得写成 `processExited:true`。

### ECHILD 后状态

【建议】明确 `ECHILD` 后 supervisor：

- 不再创建 helper、signal-service 或任何 child；
- 保持存活以回答 final `inspect`；
- 只接受 `inspect` 和 `release`；
- 回包必须保持同一 manager/process identity、listener dev/ino 和原 session tuple；
- release 回包写出后，supervisor 才退出。

## disable 与 cleanup 回包

### running

manager exact keys：

```text
capabilities, children, executable, fenceDigest, handleDigest,
listener, namespace, noNewPrivs, observedAt, parentDeathSignal,
process, runtimeIdentityDigest, schemaVersion, sessions, tokenSha256
```

### disable

【已确认事实】V2 disable 的正常完成由 final inspect 的 `stopped` 观测触发，不经过 cleanupEvidence。manager 的 legacy 检查本身只看 process/listener/sessions。

【建议】adapter 必须在返回 `phase:"stopped"` 前自行门禁 process/listener/sessions/children 四项。Node 再独立确认：

- exact rclone PID/starttime 已消失；
- listener dev/ino 消失且端口拒绝新连接；
- exact listener port 上当前不存在任何 loopback `ESTABLISHED` transport；
- release 后 exact supervisor PID/starttime 退出。

### cleanup

cleanup inspect 返回 manager exact cleanup evidence：

```text
abortCompleted, abortRequested, childrenExited, containmentConfirmed,
continuationRegistered, disposition, exactHandleIdentity,
lastRuntimeCheckpoint, lateGo, latePrepare, leaseReturned,
listenerClosed, processExited, reasonCode, runtimeInvoked,
schemaVersion, sessionsClosed
```

只有同时满足以下条件才返回 `disposition:"confirmedStopped"`：

- abort 已请求并完成；
- containment 已确认；
- exact handle identity 匹配；
- process/listener/sessions/children 全为 true；
- reasonCode 为 `cleanup_confirmed_stopped`。

## 失败关闭

以下任一条件必须返回 owned=false、unconfirmed 或 cleanup_required：

- unknown lease/token；
- supervisor 丢失或 exit 身份不明；
- PID/starttime/token/executable 漂移；
- incomplete task census；
- cleanup session census 失败或不可证明；
- listener/session fd ownership 不完整；
- independent `/proc`、TCP 或 port 复核失败；
- release 超时或 exit 身份不匹配；
- 主 PID 退出、端口关闭、pidfd send 返回或 running snapshot 被单独当成 children closure。

## 隔离 harness

目录：`.tmp/development-2026-10-20/p2-runtime-adapter/integration-r4/`

### 构建候选

在仓库根目录：

```text
node .tmp/development-2026-10-20/p2-runtime-adapter/integration-r4/build-candidates.mjs
```

输出：

```text
integration-r4/candidates/sfsc-relation-supervisor-linux-amd64
integration-r4/candidates/sfsc-relation-supervisor-linux-arm64
integration-r4/candidates/sfsc-relation-supervisor-linux-amd64.test
integration-r4/candidates/sfsc-relation-supervisor-linux-arm64.test
integration-r4/candidates/sfsc-root-guard-linux-amd64
integration-r4/candidates/sfsc-root-guard-linux-arm64
integration-r4/candidates/manifest.json
integration-r4/source-snapshot/native/sfsc-relation-supervisor/*.go
integration-r4/source-snapshot/src/core/*.js
integration-r4/source-snapshot/tests/*.js
```

构建环境固定为 `CGO_ENABLED=0`、`GO111MODULE=off`、`GOOS=linux`，并按目标设置 `GOARCH`。supervisor binary 与 Linux test binary 使用 `-trimpath -buildvcs=false -ldflags=-buildid=`。manifest 记录 Go version、每个目标的 vet/build/test-compile/root-guard-copy 命令、全部 runtime inputs 与 `native/sfsc-relation-supervisor/*.go` 的 size/SHA-256、对应 source-snapshot 路径，以及候选 binary 的 size/SHA-256。

root-guard 不重新编译：构建脚本直接复制已验收的 `signal-service/candidate-r4/bin/` 输入，并校验冻结 SHA-256。ARM64 输入必须保持 `3536944` bytes / `a01a75e1991c01d2e28fc7f98b0983789dbc73099f5bdd4043c6f41eb22756a1`。

### 运行端到端 fixture

在固定 Linux 隔离 runtime 中：

```text
SFSC_FIXTURE_ROOT=/fixtures \
SFSC_EVIDENCE_ROOT=/fixtures/evidence \
SFSC_RUNTIME_IMAGE_DIGEST=sha256:<fixed-digest> \
SFSC_RCLONE_SHA256=<fixed-rclone-sha256> \
SFSC_RCLONE_BIN=/absolute/path/to/rclone \
node .tmp/development-2026-10-20/p2-runtime-adapter/integration-r4/run-integration.mjs
```

【已确认事实】所有新写入文件、Ed25519 key、manager state、rclone config、临时目录和 evidence 只落在 `SFSC_FIXTURE_ROOT` / `SFSC_EVIDENCE_ROOT`；默认值分别为 `/fixtures` 与 `/fixtures/evidence`。repo、manager/adapter/package 输入和 `scriptDirectory/candidates` 只读挂载。harness 不修改输入文件 mode，也不依赖或写真实项目路径。

【已确认事实】运行前 harness 要求：

- `CapBnd` 与 `CapEff` 均为 `0000000000000100`（仅 `SETPCAP`）；
- `NoNewPrivs=1`；
- `/sys/class/net` 只有 `lo`；
- repoRoot 与 candidates 不可写；
- `SFSC_EVIDENCE_ROOT` 的 realpath 必须位于 `SFSC_FIXTURE_ROOT` 内；
- `SFSC_RCLONE_BIN` 的 SHA-256 精确等于 `SFSC_RCLONE_SHA256`；
- `SFSC_RUNTIME_IMAGE_DIGEST` 为 `sha256:<64 lowercase hex>`；
- supervisor 与 root-guard candidate 的 size/SHA-256 与 manifest 一致，且已有执行位；
- 全部 native Go source 与 source-snapshot 的 size/SHA-256 和 manifest 一致。

Node `process.arch === "x64"` 必须映射到 Go `amd64`；ARM64 保持 `arm64`。candidate 文件名和 manifest `goarch` 校验均使用映射后的 Go 架构值。

fixture 使用 Node 内置 `crypto` 生成 Ed25519 key，不使用 paramiko、ssh2 或额外依赖。锁定 rclone 以 `rcd --rc-addr 127.0.0.1:<port> --rc-no-auth` 运行；`operations/copyfile` 完成写入和读回，SFTP backend 保持 connection cache。只有 supervisor 实际观测到 exact listener 上的 `ESTABLISHED` transport 后才继续。

成功后：

```text
/fixtures/evidence/latest.json
```

失败时保留：

```text
/fixtures/evidence/latest-failure.json
```

设置 `SFSC_KEEP_TEMP=1` 可保留隔离临时目录用于复核。

【建议】root 验证外壳应串行执行 Linux ARM64 supervisor test binary、Node manager+adapter 定向测试和该端到端 fixture。supervisor test binary 必须先于端到端运行，以便把纯 Linux `/proc`、pidfd、subreaper 和 TCP parser 失败与 SFTP 集成失败分开定位。

## 当前证据边界

【已确认事实】Windows 锁定 rclone 的 rcd 客户端 probe 已证明：写入、读回、transport 在空闲后保持、server 停止后 session 消失、新连接拒绝。该证据不证明 Linux subreaper、supervisor、adapter、release 或产品接线。

【已确认事实】r3 ARM64 candidate 已在隔离 N1 容器中启动 native test binary；两个测试因内核 `tcp6` 表头使用 `remote_address` 而返回 `tcp6_table_invalid: header_invalid`，后续 Node 与 SFTP 阶段未运行。该 run 的 exact cleanup 已成功，容器、runtime 和 fixture 根均确认消失。

【已确认事实】当前 Windows 本机完成 r4 Node 定向测试、Linux cross-build、Linux test-binary 编译和候选冻结；本机未执行 r4 Linux test binary、subreaper、SFTP 或端到端 fixture，也未执行新的远端运行。

【建议】本合同通过 Linux/ARM64 supervisor test binary、Node 定向测试和 Linux fixture 后，只能称为隔离 runtime-adapter 候选证据；仍不代表 P2 完成、N1 部署或生产验收。
