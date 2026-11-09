# 普通目录根保护合同

日期：2026-10-20  
状态：最小本地模块已实现并有专属测试；尚未接入SFTP/API/UI或N1，本文不表示部署验收。

## 职责与边界

N1管理员选择既有普通目录，工具将其注册为稳定rootId。同步前检查同一个目录及其挂载仍在，防止掉盘、路径替换、根标记丢失被解释为正常空目录。此模块不授予设备权限，不提供文件服务，也不构成抗并发路径替换的操作系统沙箱。

当前切片仅新增 src/core/directoryRootGuard.js、tests/directory-root-guard.test.js 和本文。调用者负责服务端状态锁、revision检查与原子持久化；不修改现有server/API/UI，不连接真实目录，不更改bisync引擎语义。

## 最小接口（已实现，未接线）

| 接口 | 行为与返回 |
|---|---|
| prepareDirectoryRootRegistration(input, options) | 只读检查现有目录，生成rootId及随机marker标识，返回pending record；不创建根或marker |
| commitDirectoryRootRegistration(pending, options) | 核对pending与当前根，排他创建marker并完成校验，返回active record；同一pending可安全续做 |
| checkDirectoryRoot(active, options) | 无写副作用核对根、marker、文件系统/挂载、权限和空间；返回可读的健康证据或明确错误 |

input包括serverId、shareId和绝对rootPath。rootId沿用enrollment协议的ID格式，由服务端生成，不能由通道码提供。marker身份随机生成，存于受保护的pending record；它不是设备访问凭据。

options只包含明确的clock、操作类型与写入保留空间策略；测试可注入最小filesystem/mount证据读取器。Linux默认读取真实mountinfo，不能把测试注入值当N1实测。函数应拒绝不完整或非法record。

## 注册事务

1. prepare要求目录已经存在，不创建目录；解析canonical root，读取root文件系统身份与挂载证据。
2. 调用方在锁内将完整pending record持久化，再调用commit。未持久化pending不得启动服务或签发根授权。
3. commit重新核对根；以`wx`排他创建同目录、由pending操作标识派生的staging文件，权限设为0600，完整写入并调用文件`fsync`，再以同文件系统hard-link完成no-replace安装为保留文件名 `.syncraft-root.json`，不得使用可覆盖rename。stage在安装后保留，不自动unlink；它与marker是同一inode的小别名，供同一pending恢复和复核。hard-link不受支持时阻断并标记人工核对。目录刷新成功记录`success`，平台不支持记录`unsupported`，实际刷新失败则阻断且不得返回active；该字段只表示marker安装所在目录项的刷新，不表示stage清理持久性。
4. marker存在时不覆盖。marker与stage同时存在时，必须内容精确、dev/inode/size一致且mtime符合安装前stage证据；marker-only恢复只允许沿用同一pending且内容精确对应的既有marker，不重建stage。其他碰撞或未知marker拒绝注册。
5. 新安装marker后立即以同一句柄校验内容，并确认marker的dev/inode/size等于安装前已验证的stage身份；目录刷新和root重验后，再以同一句柄复核marker内容和身份，全部通过才返回active record。调用方原子保存后，才允许适配器启动。
6. 失败保留pending和已有stage/marker。完整stage或完整已安装marker可供同操作重验续做；写入中断留下不完整stage、未知文件碰撞、平台不能安全no-replace安装时，明确返回registration_incomplete或需人工核对，禁止宣称总能自动续做。不得删除未知文件、重新生成rootId、重建丢失根或认领另一份marker。

注册记录状态只用pending与active；review_required表示失败操作的处置结论，不把损坏stage升级为active。操作结果应携带rootId和证据，不记录marker原始随机值到普通日志。未完成事务不能显示为健康同步目录。

## 记录与检查

记录至少保存版本、serverId、shareId、rootId、pending/active、canonical root、root filesystem身份、marker预期内容及active时的文件身份、注册时间和平台挂载证据。可持久化整数使用精确字符串，避免inode/dev经JSON浮点化丢精度。

每次同步扫描或目录服务开放前：

- active record必需字段、ID、时间与平台形状有效；pending不能用于数据访问。
- 当前canonical root与注册值相同，仍是普通目录；root的dev/inode与记录匹配。标识不可用时明确失败，不跳过校验。
- marker的内容读取与fstat身份校验基于同一个已打开句柄，非先lstat再单独readFile。Linux使用no-follow能力拒绝symlink；Windows结合前后lstat、句柄身份和根重验，明确不能承诺POSIX openat级原子约束。marker必须仍为普通文件，非symlink/junction，内容精确匹配，文件系统身份未变化；缺失或不完整立即拒绝，检查不创建或修复marker。
- Linux读取 `/proc/self/mountinfo`，按路径段边界选择最深挂载，正确处理mountinfo转义；核对挂载点、mount root、文件系统类型、来源及设备证据。不能只用前缀字符串认定挂载关系。
- Windows本地测试使用真实canonical path与文件身份，挂载身份语义单列；不得据其通过宣称Linux/N1挂载检查通过。
- 检查对应read/write/目录遍历权限。权限探针只反映当前进程和检查时刻；实际I/O错误仍由适配器捕获并暂停。
- statfs获取可用字节；write检查不得越过明确保留空间。只读健康检查不写测试文件，不给未知空间返回“正常”。

最小模块错误应区分record无效、尚未active、根缺失/替换、marker缺失/不符、挂载变化/证据不可用、权限不足和空间不足；接HTTP时统一映射，不在本切片添加路由。

## 当前实现证据与限制

当前源码导出 `DIRECTORY_ROOT_MARKER_NAME`、`DirectoryRootGuardError`、`prepareDirectoryRootRegistration()`、`commitDirectoryRootRegistration()` 和 `checkDirectoryRoot()`。pending与active record使用精确字段校验；dev/inode/size等持久化值使用十进制字符串，不经过JSON浮点化。

commit的实际恢复语义如下：

- 完整stage可沿用同一pending续做；stage缺失时排他重建。stage存在但内容、类型或精确长度不符时返回 `directory_root_registration_incomplete` 且 `reviewRequired=true`，不删除或修复该对象。
- marker已安装但active尚未由调用方保存时，同一pending可重新验证并返回active。marker与stage仍存在时，必须验证两者指向同一inode；marker-only恢复不重建stage。任何成功注册都保留stage，不自动清理。
- 未知marker、内容不符marker或不能安全安装时的碰撞均不覆盖。hard-link不受支持、stage安装失败或目录刷新失败时，错误需要人工核对；不自动删除marker、stage或其他未知对象。
- `checkDirectoryRoot()`只读，不创建、修复或重建marker。pending record返回 `directory_root_not_ready`，不能授权数据访问。

读取marker或stage前，先`lstat`确认普通文件及精确预期长度，再打开句柄；同一句柄的`fstat`再次确认普通文件、精确长度及dev/inode/size/mtime/ctime身份后才读取固定长度内容。Linux打开时加入`O_NOFOLLOW`；Windows使用打开前后`lstat`、同一句柄身份和根重验。新安装要求marker与安装前stage的dev/inode/size相同并比较stage mtime；hard-link会改变ctime，因此不把link前ctime作为安装后的硬条件。首次marker验证后，在目录刷新与root重验之后再做一次同句柄内容、身份、mtime和ctime复核。marker读取前后都重新核对root canonical path、普通目录、dev/inode和挂载证据。

纯Node路径link存在无法消除的TOCTOU边界：stage路径已通过身份检查，但在`link(stage, marker)`系统调用前仍可能被替换。此时可能以新inode在原本为空的marker名字下留下一个不匹配alias。实现会在安装后和最终复核中拒绝active并返回`reviewRequired=true`，保留marker、stage和其他对象供人工核对；它不保证零副作用，也不构成安全jail。既存marker仍不得覆盖。该边界必须由后续目录适配器通过受限进程、目录句柄或其他系统边界补强。
主要错误状态为：

| 状态码 | 含义 |
|---|---|
| `directory_root_input_invalid` | 调用参数或options形状无效 |
| `directory_root_record_invalid` | pending/active record字段、身份或证据无效 |
| `directory_root_not_ready` | pending record不能授权访问 |
| `directory_root_missing` / `directory_root_replaced` | 根缺失、路径或文件系统身份改变 |
| `directory_root_link_denied` | 根或保护文件为symlink/junction，或被no-follow拒绝 |
| `directory_root_marker_collision` | 未知或不匹配marker存在，未覆盖 |
| `directory_root_marker_missing` / `directory_root_marker_mismatch` | active检查时marker缺失、内容或身份改变 |
| `directory_root_registration_incomplete` | stage缺失/损坏/不匹配，恢复不能自动完成 |
| `directory_root_registration_review_required` | 安全安装、目录刷新、路径link竞态或对象保留状态需要人工核对 |
| `directory_root_mount_unavailable` / `directory_root_mount_changed` | Linux挂载证据不可用或已改变 |
| `directory_root_permission_denied` | 当前进程缺少所需目录权限 |
| `directory_root_space_unavailable` / `directory_root_space_insufficient` | statfs不可用或write检查越过保留空间 |
| `directory_root_io_failed` | 未归类的文件系统读取或检查失败 |
## 目录服务接线要求（后续工作）

- marker与保留stage不暴露给普通同步内容；适配器必须自动排除精确名 `.syncraft-root.json` 及 `.syncraft-root.stage-<operationId>` 保留名模式，用户不填写过滤器。
- root检查通过不等于设备被授权；设备授权必须精确绑定server/share/root/relation，bootstrap-only没有数据权限。
- 不递归扫描或逐请求整树hash。checksum比较由同步语义管理。
- 检查与后续I/O之间存在TOCTOU窗口；路径级安全需要适配器的受限进程/文件描述符或其他系统边界保证。不得将本模块宣称为安全目录jail。
- 文件系统编号可能跨重启/重新挂载改变。不能确认同根时先暂停，后续提供受控再验证；不能用自动重建marker绕过。

## 本切片必要测试

已用真实临时目录和明确故障注入执行 `node --test tests/directory-root-guard.test.js`，在Windows、Node.js 24.18.0下为23/23通过。覆盖prepare无写入、commit成功并保留stage、JSON重载、同pending幂等续做、完整stage预安装崩溃恢复、marker安装后active未保存恢复、marker-only同pending恢复且不重建stage、损坏stage阻断、hard-link不支持、目录刷新失败、未知marker不覆盖、marker删除/内容替换/同内容新inode替换、根替换、symlink/junction替换、权限与空间错误、非法record，以及检查不遍历嵌套内容。新增竞态覆盖link前stage被未知内容替换、同内容不同inode安装、link后stage被替换但不删除，以及directory sync期间marker被替换时禁止active。Linux mountinfo夹具覆盖空格转义、嵌套挂载、相邻前缀拒绝、挂载变化和证据不可用；该夹具只证明解析逻辑，不证明真实Linux或N1环境。

当前状态为局部实现和23项定向测试通过，等待独立复核；尚未接入目录服务、API/UI或SFTP，也未进行真实N1资源、掉盘、重启恢复或通道隔离验收。

