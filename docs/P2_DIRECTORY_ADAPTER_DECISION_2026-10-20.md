# 普通目录适配决策记录

日期：2026-10-20  
状态：SFTP + 内容校验作为优先验证路线；生产适配器及 P2 尚未放行。

## 已确认事实

- 用户已确认 REALITY 与并发传输的真实链路可行；本决策不重新设置速度门槛。
- 直接 WebDAV 的本机锁定版本实验发现最终文件名暴露部分上传内容、秒级修改时间且无远端 hash；默认 bisync 可漏掉同尺寸同秒改写。证据见 WEBDAV_ADAPTER_PROBE_2026-10-19.md。
- SFTP 在本机 checksum 三文件样例中能传播远端唯一变化，保持两个不变文件；默认 size,modtime 仍漏检。实际 MD5/SHA-1 与样例匹配；cache0 新服务可无重启读取外部同尺寸覆盖。证据见 SFTP_ADAPTER_PROBE_2026-10-19.md。
- 上传采样未观察到最终文件名的部分内容，只是采样证据；没有证明中断、掉电或跨平台原子性。两组探针均未证明 N1、产品设备授权、代理或 bootstrap 数据隔离。
- GPT-6 Luna 已只读复核上述最终实验的实际参数和结果。

## 当前技术决定

1. 优先补证 SFTP 与明确 checksum 比较语义，内部参数由工具管理；普通用户仍只操作接入和同步目录。
2. 当前直接 WebDAV 不进入产品主流程。透明 staging + hash 的 WebDAV 网关保留为条件替代方案，暂不建设大网关。
3. checksum 属于引擎语义，必须纳入稳定关系合同。不得全局替换旧任务比较方式，不得静默复用旧 baseline；同关系旧 engine 状态必须显式转迁移检查，禁止自动 resync。
4. 普通目录的 rootId、根标记、挂载健康和目录替换保护独立实现，供最终适配器接入；检查失败不得重建标记或把空目录解释为全量删除。
5. 不把 SFTP 或 SSH 通用能力当作设备授权实现。须验证每设备每关系的路径限制、撤销和仅必要 hash 操作；不提供通用 shell、转发或 N1 内网代理能力。

## P2 最少剩余证据

- N1 ARM64 隔离样例：checksum 同尺寸同秒对照，以及新增、修改、删除、重命名；保留未变文件，校验两端最终内容。
- 中断上传和服务重启：最终路径保留旧完整内容或不存在；临时对象可识别且可安全恢复/清理。
- 两个独立设备凭据的目录授权与撤销；bootstrap-only 不能列举、读写目录或访问其他内网目标。
- 实际代理/通道路由与限制，以及 N1 的 CPU、RSS、磁盘和扫描耗时。Windows 实验不能替代这些证据。

若逐设备/关系 SFTP 隔离不可实现或 N1 成本不可接受，再实施最小 WebDAV 网关原型，验证授权、隐藏 staging、同文件系统提交和内容指纹。当前没有证据可以提前宣称该替代网关已可用。

## 追加认证缓存风险（帮助声明，尚未实测）

主审读取锁定rclone 1.74.3的serve sftp帮助：auth-proxy可以按user生成backend和_root，但帮助说明其内部按user缓存，凭据改变需等5分钟缓存过期；启用auth-proxy会忽略authorized-keys。不能把该能力直接当作逐请求授权或即时撤销实现。下一项局部补证应区分helper是否再次调用、撤销后同user的新连接、错key尝试及已有会话终止；当前没有这些实测结果，不提前认定缓存一定导致放行或一定安全。

## auth-proxy撤销实测与局部预审（2026-10-20）

- 冻结脚本SHA256：91986D287D61A7F0D4A9C5DA9F0623E69958EA272BDC019D148F7C5BD6D44303。
- 主审独立run：.tmp/development-2026-10-20/p2-sftp-auth-proxy/2026-10-20T084604-534Z/report.json。GPT-6 Luna已只读核对脚本和真实报告，确认下述局部结论，不代表P2通过。
- 冷缓存错误密钥由helper拒绝；热缓存错误密钥仍被SSH认证拒绝，但helper调用增量为0。不得将热缓存无helper调用写成错误密钥成功。
- helper配置撤销A后，新客户端连接仍能读取A文件且内容hash匹配，helper调用增量为0；B新连接继续正常。由此确认本次Windows本机run中，修改helper配置不能立即阻断已经缓存的授权。
- 仅对方唯一文件名不可读取，不等于symlink、路径逃逸或完整目录隔离已验证。没有等待5分钟过期，没有验证已有会话撤销、N1或真实代理。
- 技术决定：共享auth-proxy配置撤销模式不进入产品授权实现。下一候选为每device/relation独立loopback SFTP进程，持久停用后终止该进程，并实测新连接、已有连接和其他关系不受影响；这是待验证方案，尚未实现。
- 原探针对自定义out-dir的约束是词法边界，Luna指出祖先symlink/junction可能绕过预期存放范围。当前run未显示利用，且已清理；后续探针运行前须核对整条实际祖先路径，不能以此脚本宣称具备完整realpath隔离能力。

## 独立关系进程候选的局部机制证据（2026-10-20）

- scripts/probe-sftp-relation-isolation.mjs最终候选CCB161D50817D6281BCFBDE542DC91FE4B443967DD4E404E95BFD883F9D64812；主审run .tmp/development-2026-10-20/p2-sftp-relation-isolation/2026-10-20T090953-990Z/report.json，通过且cleanup无失败。
- A/B独立静态key、服务进程、host key及root能各读回正确内容；两个交叉key均在SSH认证拒绝。A服务与SSH transport停前均存活，停止A进程后transport退出、监听关闭、新A连接拒绝，B仍正确读回。
- GPT-6 Luna已核对修后哈希和真实记录，局部放行用作后续机制设计依据。ssh -N没有SFTP文件操作，不能表述为在途文件传输中断已验证。
- 当前决定是继续实现每关系独立服务的产品生命周期和新引擎接线。持久停用/监督器恢复、保留名与路径/能力限制、双向写入、真实代理、N1 ARM64与成本仍未验收，P2未通过。

## 保留名过滤的直接写入反例（2026-10-20）

- 本机锁定rclone 1.74.3可写serve sftp，配置--exclude /.syncraft-root.json及--exclude /.syncraft-root.stage-*，不能保护这两个保留文件的写入。
- 主审第二次run：.tmp/development-2026-10-20/p2-sftp-reserved-paths/2026-10-20T092315-990Z/report.json。系统OpenSSH sftp.exe的精确路径put均成功且marker/stage本地SHA256均改变。get两路径在该次配置返回not found；普通canary读写成功，清理无失败。
- 第一run还观察到rclone copyto退出4却已经删除并替换marker；结果是否安全必须核对实际文件，不能只看退出码。
- GPT-6 Luna独立复核4项冻结哈希、探针及两次报告，确认可用作阻断仅靠exclude保护保留文件的充分证据；结论限本次Windows loopback路径与参数，不外推N1、别名、竞态或完整目录jail。
- 决定：保留SFTP作为待验证路线，但当前serve过滤方案不得进入普通目录生产接线。先落实写入口守卫或经验证的文件系统隔离；扩大过滤规则不构成修复。root guard仍保持已验收冻结，任何合同变更另行作为明确增量审查。

## N1 immutable 原语局部证据（2026-10-20）

- 初版 Linux 探针由显式指定 GPT-6 Luna 静态预审拒绝：任意 OSError 可被计为保护成功、缺普通目录操作正对照和状态不变量、capability-drop 判据不足。DeepSeek V4.1 Flash 修复后重新冻结，源码 SHA256 `811AC7FE3E5A1AE9DE93D44644398E5663EECD6C3A200D682759942B140D41E9`，Luna 修后预审通过。
- 主审真实 N1 run：`.tmp/development-2026-10-20/p2-linux-marker-immutable/n1-primitive-ZwdSYJ/stdout.json`；命令 `python3 - --base /ssd`，SSH 从 stdin 送入已冻结脚本，exit0。挂载 ext4、major:minor 8:1；只操作新建随机 fixture。
- 四项正对照（内容读写、覆盖改名、删除、硬链接）成功；marker/stage 的14项写入、截断、改名、覆盖、删除、chmod和硬链接负向操作均为 EPERM。每步存在性、dev/ino、nlink、大小、权限、uid/gid、SHA256和immutable不变量均保持。
- worker 实际尝试清除 immutable 得到 EPERM；CapEff/CapPrm/CapBnd/CapInh/CapAmb 均无 CAP_LINUX_IMMUTABLE。自建 fixture 清除 immutable 后精确清理成功，无留置。
- 主审独立逐项核对原始报告，Luna复核源、运行报告、执行回执和主审检查4项冻结哈希及结果，允许作为本环境下文件系统原语的局部证据。它尚未证明 rclone/SFTP 写入口、安全路径、生命周期、掉电或产品接线。
- 接续决定：在真实锁定 rclone1.74.3 ARM64 上验证同参数未保护对照、普通文件 SFTP 读写、immutable marker/stage 原生 put 拒绝和原文件不变。现有生产容器内的1.71.1不作替代；不升级现有容器。正式服务必须在 link 安装 marker 后、暴露可写服务前完成保护和核验；该启动门仍待设计实现。

## N1 原生 SFTP put 写保护实测（2026-10-20）

- DeepSeek编制 `scripts/probe-linux-sftp-marker-protection.py`，冻结源码 SHA256 `6793DEACDEC932E6CBE69C9206F565B3BA0B7C36E07207A3D1DCFAEC2F9C5382`；主审独立AST检查，Luna静态预审允许执行。此次仅验证精确put，不扩展为rm/rename/hardlink或完整路径隔离。
- 主审真实run `.tmp/development-2026-10-20/p2-linux-sftp-marker-protection/n1-put-8xXLNk/stdout.json`，exit0/status=passed/failures=[]。二进制为经官方归档SHA与远端文件SHA校验的1.74.3 linux arm64；控制组和保护组均仅监听随机loopback端口、使用自建临时SSH密钥和相同exclude/VFS参数。
- 未设置immutable的两个控制文件均被原生SFTP put成功改写，直接SHA256等于测试源。由此证实同参数在N1也不能靠exclude阻止精确路径写入。
- 受保护组先完整stage写入/fsync，hardlink安装marker，再设置并核验immutable，最后启动移除CAP_LINUX_IMMUTABLE且NoNewPrivs生效的服务。普通canary get/put/get均成功，两端直接读取和下载内容哈希正确。
- marker和stage的原生put均exit1，客户端为`close remote: Permission denied`；rclone同一目标日志为`operation not permitted`。每次put后的两个真实文件均保持dev/ino、nlink=2、大小、权限、uid/gid、SHA256与immutable不变。日志中的虚拟Remove成功不能作为物理文件已删除的证据，以直接文件证据为准。
- 两个测试进程经精确Popen handle停止，监听关闭；fixture和随机密钥精确清理。主审另行SSH确认两PID不存在、两端口关闭、两次实验fixture不存在，并核对runtime目录原dev/ino/owner/mode及二进制SHA后精确清理临时runtime。回执为 `p2-linux-marker-immutable/n1-runtime-cleanup.json`。
- 主审独立核对完整原始报告和清理，冻结 `p2-linux-sftp-marker-protection/n1-put-run-review-hashes.json` 七项证据，已提交Luna结果复核。当前只确认这组N1原生put实验，不能放行完整SFTP适配器或P2；产品启动保护门、其他路径及SSH能力、checksum引擎与显式代理、写入中断及资源成本继续待办。

### 结果复核与局部采纳

GPT-6 Luna已核对上述七项哈希及原始结果，正式确认该最小put矩阵的局部结论，报告为 `p2-linux-sftp-marker-protection/luna-n1-put-review.md`。主审据此采纳N1文件系统保护路线继续实施，不把探针直接当作产品模块。

清理记录边界：主审实际执行的SSH清理代码先断言目录原dev/ino/owner/mode及文件SHA，再unlink/rmdir；但JSON回执没有完整保存目录身份的前后观测字段。Luna可确认清理声明及binary SHA，不能仅凭七项冻结文件独立复算该身份比较过程。保留这一证据限制；后续产品及探针清理回执需保存实际观测，不追补伪造本次字段。

## 2026-10-26：真实越根写入反例，当前 serve 实现拒绝放行

root 单次隔离 R75 run `d5f564ac33815f59` 中，原生 SFTP 对授权根内 `external-link -> ../../canaries/outside.bin` 的写/截断被接受。独立宿主磁盘读回确认根外 canary 同 inode 内容由102字节变为17字节，SHA256恰为探针写入payload。四保护marker/stage保持原样，不能用marker保护代替所有文件路径的目录隔离。

证据位于 `r75-protocol-integration/.test-runs/root-core-candidate-20261026-d/` 的 matrix-result、root-physical-audit 与 root-exact-cleanup；完整来源/摘要/清理记录见执行日志同日条目。该场只使用合成数据，真实目录没有开放或迁移。

当前结论：拒绝将现有 `rclone serve sftp :local:<root>` 当作安全目录边界。SFTP客户端/内容校验路线尚不因此自动废弃，服务端数据访问实现需要可验证的运行时边界。启动前扫描、exclude、隐藏目录和界面限制不能替代修复。root已安排评估受控SFTP服务实现及更小的真实OS边界方案；尚未裁定具体替代实现，也未宣布P2通过。

## 2026-10-26：选择受控 SFTP 服务替换数据访问端，先通过局部门

在保留 SFTP 客户端和 rclone 同步引擎的前提下，新的目录服务使用独立 Go 模块 `native/sfsc-sftp-service`，所有授权目录数据操作经 `os.Root`；SSH 限定指定用户名及公钥、loopback、SFTP 与白名单 hash exec。新服务不伪装成 rclone；原 supervisor/guard 使用显式 V2 service 身份与启动参数接入，旧制品及失败证据保留。

root 已独立构建 ARM64 测试二进制并在 N1 新合成目录单次运行 `83e9541d555ca79c`，8/8通过、0跳过，覆盖正常读写/mtime/hash/改名、外部文件及目录 symlink、外部 hardlink 与 FIFO 拒绝。原 canary 同 inode/size/内容不变的断言通过。独立 SSH 收尾确认本场目录及进程均不存在，详情/摘要见执行日志。

该结果接受 standalone 服务的这些路径与协议回归。它不涵盖特权本地 writer 改挂载或并发创建外部硬链接，不等于完整 OS jail；新 guard/supervisor 生命周期、三 artifact package、当前 builder 真双向样例、通道隔离及资源成本仍待验收。P2 当前继续不放行。
