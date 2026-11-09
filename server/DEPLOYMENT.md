# N1 部署：普通目录模式

本文说明 N1 上不依赖 MinIO 的普通目录部署。部署资产使用现有 appliance image、`sfsc-runtime-launcher`、runtime epoch、state lock 和同一 server data/state 路径。这个模式把管理员明确指定的既存主机父目录以读写 bind mount 暴露到容器 `/srv/syncraft/shared`，管理界面只登记该根下的实际目录。

旧 `sfsc-appliance.service`、`sfsc-minio.service` 和 `install-n1-appliance.sh` 仍保留为 S3/MinIO 兼容模式。普通目录安装器不会停止或删除 MinIO；MinIO 可能仍在运行供其他用途使用。

## 准备

把仓库放在 N1 的 `/opt/sfsc-test`，或通过 `SFSC_ROOT` 指定已存在的项目根目录。以下示例用 `/srv/syncraft-shares` 作为管理员选定的数据父目录：

```sh
sudo install -d -m 0750 /srv/syncraft-shares
sudo cp server/.env.directory.example server/.env.directory
sudoedit server/.env.directory
```

把 `.env.directory` 里的 `SFSC_ADMIN_TOKEN` 换成非占位的强随机 token，并填写客户端实际使用的服务端地址。该文件不能提交或放进交付包。不要在此文件加入 S3/MinIO 密钥。

`/srv/syncraft-shares` 必须先由管理员创建，且是一个实际目录；安装器不会创建、清空或迁移该目录。容器内固定映射为 `/srv/syncraft/shared`，挂载为读写以允许 Windows 客户端回写。安装器将 canonical host path 写入 root-only 的 `/etc/syncraft/sfsc-directory.env`；路径中不允许逗号、控制字符、百分号、引号或反斜线，以免破坏 systemd/Docker mount 参数。

## 安装与切换

首次安装且没有其他 appliance unit 已启用时：

```sh
cd /opt/sfsc-test
sudo sh server/install-n1-directory-appliance.sh /srv/syncraft-shares
```

安装器会检查输入目录已存在、`.env.directory` 已启用管理 token、sing-box 配置目录及 runtime launcher 存在，然后构建独立标签 `sfsc-appliance:directory-local`，安装独立的 `sfsc-appliance-directory.service`，并检查管理 API 与所选目录挂载。全新安装不要求预置 sing-box `config.json`；首次连接会由管理界面生成并应用。构建该独立标签不会重新标记旧 S3 模式的 `sfsc-appliance:local` 镜像。

如果旧 `sfsc-appliance.service` 或目录模式 unit 已启用/运行，安装器默认在任何服务切换前失败。核对当前活动服务及维护窗口后，明确传入切换参数：

```sh
sudo sh server/install-n1-directory-appliance.sh --replace-active-appliance /srv/syncraft-shares
```

该参数只切换 appliance unit；它不会停止 `sfsc-minio.service`、删 MinIO 容器、删除 MinIO 数据或改旧 S3 配置。MinIO 保持原状。普通模式和旧 S3 模式都会监听管理端口 `5177`、使用同一个 runtime ledger、同一 `server/data/app`、同一 sing-box 配置目录和相同 deployment identity，不能同时运行。

可先检查目录、环境和服务状态而不构建镜像、不安装 unit、不停止服务：

```sh
sudo env SFSC_DIRECTORY_CHECK_ONLY=1 sh server/install-n1-directory-appliance.sh /srv/syncraft-shares
```

服务检查：

```sh
systemctl status sfsc-appliance-directory.service
curl --fail http://127.0.0.1:5177/healthz
```

安装器不要求首次启动时 sing-box 已就绪。`/healthz` 在普通目录模式检查 Node、sing-box、rclone、应用状态目录和已挂载目录根的可读写性；它不探测 MinIO，首次连接配置前可返回非 200。安装器读取响应中的管理 API、状态目录和选择目录挂载证据，不把完整 `/healthz` 设为首用门槛。浏览器健康灯只表示管理 API 可达。管理界面逐步显示目录、连接应用和配对证据；这些证据也不替代一次真实双向文件读写。

管理端口绑定所有主机接口。只应从可信管理网络访问，或置于经过 HTTPS 保护和访问控制的反向代理之后；不要把管理 token 交给客户端。用户需在 `/api/health` 中确认 `adminAuth.enabled` 为 `true`，再登录。

## 首次两码接入

1. 管理员登录控制台，在“开放目录”填写容器可见路径，例如 `/srv/syncraft/shared/team`。服务端只登记现存子目录，并验证 marker、挂载身份和读写权限；不要把主机源路径填进容器路径栏。
2. 填写外部设备实际使用的域名/IP 和外部端口，再点“应用连接并签发通道码”。服务端在全新配置上自动生成 REALITY 密钥、写入配置并等待 supervisor 的配置摘要应用结果，然后才签发通道配置码。已有已应用连接会沿用当前设置，不会因普通重试而轮换密钥。
3. 本地 REALITY 模板使用 `www.microsoft.com` 和 `chrome` 作为默认 SNI / fingerprint；这是配置默认值，不是已验证的公网可达性或伪装目标结论。若路由器做了端口转发，输入客户端连接的外部端口；实际能否连通仍需客户端经通道完成申请来确认。
4. 客户端粘贴通道配置码并提交设备身份申请。管理员在设备配对申请列表中选择已经开放的目录，为该申请签发一次性身份验证码；客户端输入该验证码完成设备身份验证。
5. 客户端检查管理员授予的目录授权，选择授权目录和本地文件夹。文件同步就绪应由客户端自身状态和真实读写结果确认；管理 API、目录计数或 supervisor 回执均不等于双向同步已完成。

通道配置码用于建立受限接入通道；身份验证码独立验证某台设备。不要把两者混用，也不要把任一完整码放入工单、日志或截图。

## 修复与恢复

- 首次连接操作失败或响应丢失时，重新点同一操作可查询或恢复本地持久化操作；不要为清除错误而删除目录 catalog、runtime ledger 或客户端 identity/job 状态。
- 已应用连接后，使用控制台修复/重新签发通道码。外部设备仍需实际重新连接验证；不要把配置写入成功或 `/healthz` 成功称作公网链路成功。
- 客户端已存在同步任务时，先使用客户端的连接修复和数据恢复入口。不要删除任务或重建双向基准来解决单纯的连接问题。
- 普通目录和旧 MinIO 可以并存。将某个设备切到目录模式不会自动迁移 MinIO 对象；需要迁移时，先另建文件清单、复制和哈希核对，再由管理员明确切换授权目录。

## 回滚到旧 S3/MinIO appliance

先停目录 unit，再显式启用原 S3 unit；不要删目录树、catalog、runtime state 或 MinIO 数据：

```sh
sudo systemctl disable --now sfsc-appliance-directory.service
sudo systemctl enable --now sfsc-appliance.service
```

若旧 unit 不存在，先从同一版本的服务端源码安装 `server/systemd/sfsc-appliance.service`，并按旧 S3/MinIO 文档核对 `.env`、MinIO service 和端口后再启动。目录模式的 `.env.directory`、目录 unit 和 `/etc/syncraft/sfsc-directory.env` 保留供再次切换；不要让两种 appliance unit 同时 active。本文的普通目录安装资产尚未作为生产服务安装或替换。
