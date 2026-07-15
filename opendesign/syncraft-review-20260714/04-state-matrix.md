# 页面状态矩阵

## 客户端

> 合同缺口：客户端实际显示 Sync ID 需要 Profile 或本地安全摘要提供这个非敏感字段；原型不自行生成或猜测。

| 区域 | 状态 | 视觉 | 主操作 | 必须保留的合同 |
| --- | --- | --- | --- | --- |
| 首次连接 | 未导入 | 中性说明 | 导入并检查连接 | `claimCode`、`saveProfileBtn` |
| 首次连接 | 导入失败-终态 | 绯红，明确不可重试当前凭据 | 重新获取 SyncKey | 保留稳定错误码 |
| 首次连接 | 导入失败-可重试 | 琥珀，说明凭据未确认消耗 | 使用同一 SyncKey 重试 | recovery 行为不变 |
| 工作台 | 空闲可运行 | 绿色就绪摘要 | 预览并开始 | `runSyncBtn` |
| 工作台 | 同步中 | 蓝灰进度、当前文件 | 停止同步 | `syncing`、`stopSyncBtn` |
| 工作台 | 停止中 | 蓝灰低频脉冲 | 禁用重复停止 | `stopping` 优先于 running |
| 工作台 | 失败 | 绯红错误模板 | 查看处理办法 / 重试 | `error`、稳定错误码 |
| 工作台 | 离线 | 中性灰 | 检查连接 | `offline` 不等于失败 |
| 工作台 | 兼容警告 | 琥珀 | 确认后运行 | `confirmCompatibilityWarning` |
| 工作台 | 协议不兼容 | 绯红并阻止运行 | 升级/诊断 | compatibility policy |
| 镜像同步 | 未启用 | 收进高级区域 | 打开设置 | 双向时禁用 |
| 镜像同步 | 请求启用 | 页面内绯红确认 | 输入 `DELETE` | `confirmDestructiveSync` |
| 历史 | 成功 | 绿色 | 查看详情 | `success` |
| 历史 | 失败 | 绯红 | 查看原因 | `error` 才有 errorCode |
| 历史 | 已停止 | 中性灰 | 查看详情 | `stopped` 不显示同步失败 |
| 历史 | 冲突 | 琥珀 | 处理冲突 | `conflict` 筛选 |
| 设置 | 本地状态损坏 | 绯红 | 导出诊断/恢复 | `local_state_corrupt`，禁止覆盖写入 |
| 设置 | 密钥库缺失 | 绯红 | 重新导入 SyncKey | `secret_vault_missing` |

## 服务端

> `syncSpaces` 与设备从 `/api/admin/state` 加载；SyncKey 创建提交 `syncSpaceId` 与 `requestedRole` 到 `/api/claims/create`，并仅回显真实响应。

| 区域 | 状态 | 视觉 | 主操作 | 必须保留的合同 |
| --- | --- | --- | --- | --- |
| 登录 | 未鉴权 | 独立登录页 | 登录 | `loginForm`、`adminTokenInput` |
| 概览 | 全部正常 | 绿色就绪度 | 生成 SyncKey | 健康与协议摘要 |
| 概览 | 配置待应用 | 琥珀 | 检查并应用 | `applySingboxBtn` 语义不变 |
| SyncKey | 可签发 | 中性表单 | 生成 SyncKey | `/api/claims/create`，需选择同步 ID、设备、角色 |
| SyncKey | 已生成 | 琥珀“仅显示一次” | 复制 SyncKey 导入码 | 完整凭据默认遮蔽 |
| SyncKey | 已兑换 | 中性失效 | 重新生成 | 一次性语义 |
| SyncKey | 兑换未知 | 绯红 | 刷新状态后判断 | 不直接重用或交付 |
| 设备 | 在线同步中 | 绿 + 蓝灰 | 查看详情 | 心跳和 sync 摘要 |
| 设备 | 离线 | 中性灰 | 查看最近心跳 | 不误报为失败 |
| 设备 | 兼容警告 | 琥珀 | 查看影响 | policy warn |
| 设备 | 不兼容 | 绯红 | 升级客户端 | 阻止同步 |
| 设备 | 停用 | 琥珀 | 重新启用 | enable/disable 路径不变 |
| 基础设置 | 私钥/Secret | 遮蔽 | 显示/复制 | 常规 state 不返回完整 URI |
| 仓库 | 清空/删除 | 页面内绯红确认 | 输入确认文本 | danger confirmation |

## 错误模板

所有用户可见错误使用固定四段：

1. 发生了什么：一句普通语言。
2. 影响：是否已修改文件、是否可继续。
3. 下一步：一个明确动作，必要时再给诊断入口。
4. 错误码：等宽小字，便于支持沟通。
