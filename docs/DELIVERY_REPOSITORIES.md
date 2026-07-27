# 交付仓库约定

Syncraft 采用“一源码主仓、两受众交付仓”的模型。`beizhi97/Syncraft` 不是仅用于备份的副本，而是唯一的**源码事实来源**：所有代码、协议合同、测试、安全修复和版本标签必须先落在这里。备份是它的保护属性；`Syncraft-client` 与 `Syncraft-server` 是从已验证版本派生的只读交付面，不能反向成为源码来源。

| 仓库 | 受众 | 内容 | 不应包含 |
| --- | --- | --- | --- |
| `beizhi97/Syncraft` | 开发者 | 客户端、服务端、共享 core、协议合同、测试、构建脚本、审查与交付记录 | 真实密钥、运行态数据、构建产物、部署证据 |
| `beizhi97/Syncraft-server` | 服务端管理员 | 固定主仓 tag 导出的服务端运行源码、Compose、`.env.example`、运维文档、来源证明 | 客户端构建产物、`data/`、真实 `.env`、真实 sing-box 配置、报告、私钥 |
| `beizhi97/Syncraft-client` | Windows 用户 | 下载/校验/使用文档、各版本不可变 Release 元数据与 SHA-256 索引 | EXE/ZIP 提交历史、本地 data、任何 SyncKey、运行态报告 |

## 不变式

1. 每一份服务端镜像/Compose 快照和客户端 Release 都必须写明同一个主仓 tag、主仓 commit SHA、source tree hash、buildId 与协议版本；没有这些来源证明的交付物不发布。
2. 交付仓只能由主仓的发布工作流写入。日常开发不直接在交付仓改代码；紧急补丁先回到主仓，完成合同测试后重新发布。
3. 服务端交付仓是**生成镜像**：工作流每次用允许清单重建其工作树，而不是复制开发目录。允许项只含 `server/`、运行必需的 `src/` 和 `public/`、根 `package.json`/lock 文件、部署文档与来源证明。
4. 客户端二进制只能作为 GitHub Release 资产存在。每个版本同时上传 `SyncraftDesktop.zip`、其 `.sha256`、desktop `release-manifest.json`，并上传 `SyncraftClient.zip`、其 `.sha256`、portable manifest 作为兼容回退；不得把 ZIP、EXE 或运行态目录提交进 Git。
5. 发布工作流所用的跨仓库凭据必须是专用最小权限 fine-grained PAT 或 GitHub App token，仅授予两个交付仓的 Contents read/write 与 Releases write；它只能保存为主仓的 `SYNCRAFT_DELIVERY_REPOS_TOKEN` Actions secret，不能放入源码、`.env`、报告或命令行日志。

## 日常开发与发布的分工

主仓的日常循环只做验证，不产出交付物：改代码 → 推 `Syncraft` → CI 跑测试、合同审计、Compose 审计 → 通过即可继续。CI 绝不构建 Windows 包、不同步交付仓、不上传大体积 Artifact。

打包发布是独立、手动、按版本触发的动作，只在你确认某一版要交付给用户时才做，而不是每次 push。发布产物（客户端 ZIP、服务端部署快照）是交付物本身，不是 CI 证据。GitHub Actions 的 Artifact 只作为构建 job 到发布 job 的短期中转（保留期设为 2 天），长期权威副本是 `Syncraft-client` 的 GitHub Release 与 `Syncraft-server` 的仓库快照。

## 版本 tag 不可变

每次发布对应一个全新且此后不再移动的版本 tag（例如 `v0.3.0-rc.2`、`v0.3.0`）。已发布的 tag 不得为了追加改动而重新指向新提交——那会破坏交付物与来源的一一对应。需要交付新内容时，创建新 tag 重新走发布流程。



1. 在主仓完成代码修改、合同测试、`audit:release`、严格预检和版本 tag。主仓 tag 是三仓版本的锚点。
2. 主仓 Release workflow 在 Windows runner 构建 desktop 与 portable 客户端包，校验 SHA-256、release manifest、严格 preflight 与 package smoke。
3. workflow 用同一 tag 的固定 tree 导出服务端允许清单，更新 `Syncraft-server/main`，写入来源证明并创建同名 tag。
4. workflow 更新 `Syncraft-client` 的版本元数据，并将客户端包及其校验文件发布到同名 GitHub Release。Release 说明记录主仓 commit SHA、包 SHA-256、协议版本与兼容范围。
5. 三个目标都成功后才把该 tag 视为可交付；任何一步失败不得用手工复制绕过，修复后从同一主仓 tag 重跑。

## 首次配置

主仓 Actions secrets 中配置 `SYNCraft_DELIVERY_REPOS_TOKEN`。该 token 必须可读写 `beizhi97/Syncraft-client` 与 `beizhi97/Syncraft-server`，但不需要、也不应获得其他仓库权限。之后从主仓的 Release workflow 手工选择已经存在的版本 tag；工作流会检查 tag、来源树和构建产物的一致性。

本地目录 `delivery-repos/` 仅可作为方便查看交付仓的 clone 位置，不是发布权威，也不应保留未提交的发行物。当前若目录不是有效 Git clone，应删除后用目标仓库 URL 重新 clone，绝不可对空 `.git/objects` 目录执行手工复制。

## 兼容性与回滚

协议合同仍只在主仓维护；修改 SyncKey、profile、heartbeat、稳定错误码或 `/api/*` 行为时，必须先更新合同与测试，再同步两套交付仓库。服务端和客户端 Release 必须能追溯到同一个主仓版本标签。

回滚时分别恢复到上一个通过严格预检的服务端 tag 和客户端 Release，并保留服务端 `.env`、`data/`、`sing-box/config.json` 以及客户端 `%LOCALAPPDATA%\\Syncraft\\data`。不能用空目录覆盖真实运行态。
