# Syncraft 服务端 UI 工程交接

## 范围

- 本目录只包含设计 Token、独立 HTML 原型和交接说明；不修改生产 `public/` 文件、业务逻辑、协议、错误码或同步行为。
- 生产端继续使用现有管理登录、`/api/health`、`/api/admin/state`、VLESS、存储、仓库、设备和 SyncKey API。
- 页面迁移时保留 `public/index.html` 与 `public/app.js` 已绑定的 DOM id；不可直接用原型 id 替换生产 id。
- 动态状态必须来自真实响应。未返回值显示 `—`、`未检查` 或 `不可用`。

## 最小版本检查 API

新增一个经过管理认证的只读端点，建议沿用现有 Bearer 管理认证和统一错误结构：

```http
GET /api/admin/components
Authorization: Bearer <admin-token>
```

```ts
type ComponentStatus = {
  id: "syncraft-appliance" | "node" | "sing-box" | "rclone" | "minio" | "minio-mc";
  currentVersion: string | null;
  latestStableVersion: string | null;
  upgradeAvailable: boolean | null;
  checkedAt: string | null;
  errorCode: string | null;
};

type ComponentsResponse = {
  components: ComponentStatus[];
};
```

认证与数据约束：

- 未登录返回既有认证错误；页面回到未登录态，不保留前一次组件数据。
- `currentVersion=null` 表示无法读取本机组件版本；`latestStableVersion=null` 表示未取得稳定版本信息。
- `upgradeAvailable=null` 表示不能判断，绝不能映射为“已是最新”。
- `checkedAt` 只记录该组件最后一次成功或失败检查时间；不能用页面加载时间代替。
- `errorCode` 使用稳定、可诊断的机器码；响应不得包含命令输出、环境变量、内部路径或凭据。
- 六个组件独立返回，单个失败不能让整个响应失败；全局认证或服务故障除外。

## 状态映射

| 场景 | 页面表达 | 控件 |
|---|---|---|
| 未登录 | 显示现有管理登录页 | 不渲染管理数据 |
| 加载 | 行级骨架或“正在检查组件” | 检查按钮禁用，`aria-busy=true` |
| 空 | “未返回组件状态” | 提供同位置重试 |
| 全局错误 | “版本服务不可用” | 保留上次成功值时标记为旧数据 |
| 部分失败 | 成功行正常显示，失败行显示“检查失败” | 允许重试，不隐藏失败行 |
| 操作中 | “检查中” | 防止重复提交 |
| 禁用 | 受控升级按钮禁用 | `disabled`，不使用仅视觉禁用 |
| 成功 | 只显示真实当前版本与稳定版本 | 不额外重复“全部正常” |

## 受控升级边界

- 第一阶段只交付版本检查，不交付远程升级 API。
- 后续升级必须指定固定 tag，不允许自动跟随 `latest`。
- 流程固定为：选择固定 tag → 构建制品 → 完整性与兼容检查 → 受控替换 → 健康检查 → 必要时回滚。
- 禁止在运行容器内覆盖 Node、sing-box、rclone、MinIO 或 MinIO mc 二进制。
- 升级操作必须有独立权限、审计记录、并发锁和幂等操作 id；不得复用只读组件端点。

## 关键 DOM id

生产迁移必须保留：

- 全局与认证：`authGate`、`loginForm`、`adminTokenInput`、`authMessage`、`logoutBtn`、`actionMessage`。
- 概览与设备：`refreshOverviewBtn`、`overviewAttentionList`、`overviewDeviceList`、`deviceList`、`deviceSearch`、`deviceStatusFilter`、`deviceSyncFilter`、`deviceCompatFilter`、`refreshBtn`。
- SyncKey：`syncSpaceSelect`、`deviceName`、`syncSpaceRole`、`expiresInHours`、`createClaimBtn`、`claimResult`、`claimOut`、`copyClaimBtn`、`copyClaimUriBtn`。
- VLESS 与存储：保留 `public/index.html` 中所有现有字段和操作 id，不改 API 路径与 payload。
- 新增版本区建议使用：`tab-versions`、`settings-versions`、`componentCheckStatus`、`checkUpdatesBtn`、`componentList`。

## 安全

- 不把管理 Token 写入 DOM、URL、日志或截图；沿用当前会话内认证处理。
- SyncKey 仅在签发成功后显示一次；复制必须来自真实响应，页面刷新后清除。
- MinIO Access Key / Secret Key、内部 Endpoint、内部路径和 sing-box Private Key 默认隐藏；错误信息不得回显原值。
- 原型中的 `—` 不得在实现时替换成固定示例版本或伪造设备数据。

## 无障碍与响应式

- 标签页实现 `role=tablist/tab/tabpanel`，支持左右箭头、Home、End，并同步 `aria-selected` 与 `tabindex`。
- 表格外层可聚焦并允许自身横向滚动；页面根节点在 375px / 390px 不产生横向滚动。
- 交互控件桌面最小 40px，移动端最小 44px；长设备名和同步 ID 使用省略号，完整值通过标题或详情动作访问。
- 模态框打开后锁定背景滚动、限制焦点、Escape 关闭并恢复触发点焦点；仅顶层模态响应 Escape。
- `prefers-reduced-motion: reduce` 下关闭脉冲、旋转、位移和过渡。
- 验收视口：1280×720、1440×900、375×812、390×844；另以 Windows 125% / 150% 缩放复查无重叠、无页面级横溢。
