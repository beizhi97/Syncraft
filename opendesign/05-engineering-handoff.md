# 工程交接说明

## 范围与边界

- 本目录只包含研究、设计 Token 和独立原型，不修改生产文件。
- 不改变 API、请求字段、枚举、错误码、T-key/Profile/心跳/同步行为。
- 生产改造应保持现有关键 DOM id；原型中的新结构是布局建议，不是合同变更。

## 推荐落地顺序

1. 先把 `DESIGN.md` Token 映射到现有 `client/public/styles.css` 和 `public/styles.css`，不动 JS。
2. 客户端先重排 `client/public/index.html`：同步、历史、设置成为一级信息区；保留全部 id。
3. 将首次使用状态抽成独立可见区域，但仍复用 `claimCode`、`saveProfileBtn` 和现有导入函数。
4. 用 CSS/页面状态切换实现单一主操作：空闲显示开始，同步中显示停止，停止中禁用重复动作。
5. 将历史从设置抽屉提升为一级区，继续使用 `historyStatusFilter`、`historySearch`、`syncHistoryList`。
6. 服务端先重排导航与表格，保持 `data-tab-target`、现有表单 id 和事件绑定。
7. 最后统一错误模板、确认模态框和敏感字段遮蔽，不改变 `formatError`、`requestConfirmation` 等函数的输入输出。

## 客户端关键 id 保留

- 连接：`claimCode`、`saveProfileBtn`、`profileStatus`、`heartbeatStatus`
- 任务：`localPath`、`chooseFolderBtn`、`direction`、`serverSpace`、`remoteFolder`、`scheduleMode`
- 性能：`transfers`、`streams`、带宽限制相关 id
- 运行：`saveJobBtn`、`previewBtn`、`runSyncBtn`、`stopSyncBtn`
- 进度：`syncStatus`、`progressFill`、`progressValue`、`speedValue`、`transferredValue`、`currentFileValue`
- 历史：`historyStatusFilter`、`historySearch`、`syncHistoryList`
- 诊断：组件、协议、本地状态、日志与导出相关 id
- 安全确认：`confirmGate`、`confirmForm`、`confirmTextInput`、`confirmSubmitBtn`

## 服务端关键 id 保留

- 鉴权：`authGate`、`loginForm`、`adminTokenInput`、`logoutBtn`
- VLESS：现有协议、地址、端口、REALITY 字段及生成/应用按钮 id
- 存储：Endpoint、Access Key、Secret Key、bucket 与仓库操作 id
- T-key：`createClaimBtn`、复制/测试兑换相关 id
- 设备：筛选、搜索、`deviceList` 与行级操作事件委托
- 安全确认：复用现有确认表单，不使用浏览器 `confirm()`

## CSS 重构建议

- 在现有 Token 上增加 `--surface-subtle`、`--border-strong`、`--info` 和语义软背景。
- 建立 `.app-shell / .sidebar / .topbar / .content / .panel / .table / .notice / .modal` 基础层。
- 客户端和服务端共享 Token 与组件基础；客户端内容间距更松，服务端表格行高更紧。
- 为 1280×720 单独压缩纵向间距；不要缩小到不可读字号。
- 长路径使用 `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`。

## JavaScript 改造建议

- 不改 API 封装与业务函数；新增轻量视图状态函数，将合同状态映射到页面区块可见性。
- 保留事件绑定 id；若不得不更名，先提供旧 id → 新 id 映射并同步测试。
- `stopping`、`error`、`offline` 必须优先于 `running` 的辅助判断。
- 所有危险操作继续通过页面级确认状态机；双向同步时禁用镜像同步。
- 所有敏感值默认遮蔽，常规列表不请求完整 VLESS URI。

## 验收清单

- 1280×720 与 1440×900 无横向滚动、底部操作不被遮挡。
- 125%、150% Windows 缩放下表单标签和按钮不截断。
- 首次导入、同步中、停止中、失败、离线、兼容警告、不兼容均有可访问状态。
- 客户端关闭窗口后进入托盘的提示可见但不干扰主任务。
- 长路径、长文件名、长错误信息不撑破布局。
- 键盘可访问模态框与主操作，Escape 可关闭非强制模态框。
- 不出现真实凭据、设备、仓库、路径或原始诊断数据。
