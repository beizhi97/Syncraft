# P2 产品接线裁决

日期：2026-10-23。root 实施裁决；不是实现完成或运行验收记录。

## 依据

- 用户已确认 N1 普通目录与 Windows 双向同步、两个码、自动修复和同关系换码续同步。
- r35 接线准备与 GPT-6 Luna 只读预审确认：`server.js` 尚注入 `unavailableRuntime`；P1 authority 尚无产品持久入口；runtime session 只属当前 Node 进程。
- 已有 manager 是唯一 desired/lifecycle owner；启动恢复继续使用现有 admission/host closure，不新增第二套启停账本。

## 实施决定

1. **授权来源**：持久保存 P1 原有完整 authority state；grant/device 的有效性只从该对象判断。服务配置只引用其 relation、设备公钥指纹和目录身份，不凭复制的五元组自授予权限。一次读取返回授权与服务配置的一致快照。配置文件属于内部产品状态，普通使用者不编辑。
2. **目录登记**：必须保存 guard 原样返回的 pending record 及 operationId，再执行原 guard commit，最后保存 active record。中断后只重放同一 pending record；active marker 丢失或身份不符时拒绝启动，不自动补建。首配与授权接口在 P3 接入 UI。
3. **稳定身份**：manager identity 使用五元组、baselineEpoch、rootAttestation 和目录后端语义。channelRevision 与 credentialRevision 是连接/凭据材料，不进入内容身份；换通道不更改原关系和同步基准。客户端 engine 的后续迁移仍受原 baseline guard 约束。
4. **接线**：真实 dispatcher/protection 在同一次 `admitStartup()` 注入，只使用其返回的 manager。listener、root、authorized keys 和 host key 由可信服务配置固定，启动请求不能指定其他路径或端口。保护成功至 prepare 间的配置变化必须拒绝。
5. **停用**：当前进程保存的 adapter/lease/handle 映射可用于精确清理；停用不读取数据根或要求授权仍有效。新进程不得凭持久 handle 自动认领、信号终止或重建旧 session。旧运行状态的关闭及恢复继续依赖已实现的宿主整容器关闭证明；缺少关闭证明时保留未完成状态。
6. **撤销**：先持久撤销授权，阻止新启动，再调用同一 manager disable。确认 exact process/listener/sessions/children 关闭后，才清理该 relation 的授权文件并报告完成。中断后的重试依据既有 revoked grant 与 manager desired/operation 状态，不新增独立 desired/revocation 生命周期账本。撤销授权本身不等于会话已关闭。
7. **SSH 身份**：首版采用服务端稳定 host key，私钥仅服务端持久存储；客户端固定其公钥指纹。relation 使用独立 authorized_keys。缺失既有私钥不得静默重生成；轮换走显式迁移。设备 Ed25519 公钥来自已登记 P1 device。
8. **原生制品**：复用已验 ARM64 supervisor 和 root-guard，后者同时作为 exec/signal helper；生产包只核固定 manifest、平台、文件与字节摘要。owner-lock manifest 保持独立。目录保护需要的最小 capability 只在隔离产品组合验收时配置，并证明文件服务 exec 前清除 capability/设置 NNP；不据本裁决修改生产容器。
9. **通道授权**：P2 合成样例明确绑定单一已授权 transport user 与唯一 relation listener；按仓库锁定 sing-box 版本验证路由语法及拒绝其他 relation、管理口和任意 loopback 的实际行为。现有 `route.final: direct` 不作为隔离证明。P3 再接入两码/设备的配置生成入口。

## 2026-10-24 接线前补充

- `catalog.withStartBinding(relationId, task(snapshot))` 必须与 update/撤销使用同一配置独占锁，并持锁到真实 adapter.go 返回。dispatcher 对照 prepare 时的完整 snapshot digest 与 fence；变化或撤销时拒绝 go，并沿用 manager 原有 abort 路径。仅在 go 前重新读取而不持锁，不能闭合竞态。
- catalog 新建状态只接受空 roots 或 pending records，不接收 active 初态。既有持久 active 可以 require-existing 读取；激活必须承接同一已持久 pending operation。真正的 marker/mount 检查由 dispatcher 调用原 `ensureDirectoryRootProtection` 完成，不能把 catalog 的结构验证写成目录实态验证。
- 普通 catalog update 保持已配置 relation 的五元组、baselineEpoch、rootAttestation 和设备公钥，不允许撤销回退。channelRevision 与 credentialRevision 可更新。显式内容迁移不在普通配置更新中实施；不新增第二套 P1 授权状态机或 manager 生命周期账本。

## 当前范围

先闭合正在执行的启动链路 Linux 整合验证，再把目录配置与真实 runtime 注入服务端，随后做隔离目录读写和通道隔离。新增打包模块和 dispatcher 的替身测试，只证明其静态组合行为；不代替真实 guard/native/SFTP/双向同步验收。P2 与 P3–P7 仍未完成。

## 2026-10-24 启动接线实施裁决

- 启动 slice 已完成两轮真实 host 启动/退出/重启，证据见执行记录 run `5d2b95da5baad590`；下一步是接线实现，尚未验收目录读写。
- 启动时立即校验固定 relation native package，并只创建一个 dispatcher。其 catalog 代理在首次配置读取时以 require-existing 打开 `dirname(relationStatePath)/relation-service/catalog.json`；成功缓存 facade，失败不永久缓存。目录尚未配置时允许管理端启动，关系 start 必须在 manager mutation 前因缺配置而拒绝。
- 本接线不自动创建 authority、catalog、host key 或目录标记。P3 首配负责创建并核验私有 relation-service 目录，再持久登记。缺少既有密钥或 marker 继续拒绝，不能作为“自动修复”重建。
- 同一次 admission 注入该 dispatcher 的 runtime/protection，并只使用返回的 manager。产品 facade 的 start 先从可信 catalog 生成请求，再交同一 manager；query/disable/reconcile 使用该 manager。cleanup 仍只用 dispatcher 当前进程的精确 ownership，不依赖 catalog 可读或授权仍有效。
- package 路径固定为源码根下 `server/runtime/native/linux-arm64/relation`，rclone 固定为 `/usr/local/bin/rclone`；请求不得指定路径或端口。Dockerfile 显式赋予两 native 制品执行位。单元测试接缝仅由显式函数参数传入，产品入口不从 env/用户配置加载函数。
- manager runtime 等待预算采用 30 秒，覆盖 adapter 单次请求默认 10 秒、ready 默认 3 秒及 release 默认 5 秒的组合；这属于接线预算建议，不是性能实测。实际超时、停止和失败清理仍需隔离整合验收。

## 2026-10-28：显式 SFTP V2 入口替代

- 上述固定 `relation` 包与 `/usr/local/bin/rclone` 文件服务启动决定被新默认入口替代：server main 选择 `createSftpRelationServiceStartup`，固定加载 `server/runtime/native/linux-arm64/relation-v2` 的 schemaVersion 2 包，包含 supervisor、root-guard、受控 SFTP service 三项。SFTP 用户固定 `sfsc`，不从请求或环境变量指定文件服务路径。
- 原 V1 API/包保留兼容，V2 缺失、损坏或不适用时拒绝启动，不回退到 V1。目录服务替换原因及边界见 `P2_DIRECTORY_ADAPTER_DECISION_2026-10-20.md`。
- 本机组合测试及固定字节打包已复验；实际 N1 全生命周期和新镜像组合尚未通过，仍不作 P2 整体验收声明。
