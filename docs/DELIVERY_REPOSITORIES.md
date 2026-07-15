# 交付仓库约定

Syncraft 采用“一主仓、两交付仓”的模型：

| 仓库 | 受众 | 内容 | 不应包含 |
| --- | --- | --- | --- |
| `beizhi97/Syncraft` | 开发者 | 客户端、服务端、共享 core、协议合同、测试、构建脚本 | 真实密钥与运行态数据 |
| `beizhi97/Syncraft-server` | 服务端管理员 | 可直接 `docker compose up` 的服务端源码、Compose、`.env.example`、运维文档 | 客户端构建产物、`data/`、真实 `.env`、真实 sing-box 配置 |
| `beizhi97/Syncraft-client` | Windows 用户 | 下载/校验/使用文档、各版本 SHA-256 索引 | EXE/ZIP 提交历史、本地 data、任何 SyncKey |

## 发布职责

1. 在主仓库完成代码修改、合同测试、严格预检和版本标签。
2. 将经过验证的服务端运行源码同步到 `Syncraft-server`，使用相同的版本标签并写明主仓提交 SHA。
3. 将 `SyncraftDesktop.zip`、`SyncraftDesktop.zip.sha256`、`release-manifest.json` 作为 `Syncraft-client` 的同版本 GitHub Release 资产发布；`SyncraftClient.zip` 仅作为兼容回退资产。
4. Release 说明必须记录主仓提交 SHA、包 SHA-256、协议版本与兼容范围。不要把 EXE/ZIP 提交进 Git。

## 兼容性与回滚

协议合同仍只在主仓库维护；修改 SyncKey、profile、heartbeat、稳定错误码或 `/api/*` 行为时，必须先更新合同与测试，再同步两套交付仓库。服务端和客户端 Release 必须能追溯到同一个主仓版本标签。

回滚时分别恢复到上一个通过严格预检的服务端 tag 和客户端 Release，并保留服务端 `.env`、`data/`、`sing-box/config.json` 以及客户端 `%LOCALAPPDATA%\\Syncraft\\data`。不能用空目录覆盖真实运行态。
