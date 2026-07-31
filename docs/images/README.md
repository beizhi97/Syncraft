# README 截图的重截流程

截图是产品事实，只能在真机上截取，不能按设计意图画出来或用无头浏览器在 Linux 上渲染后冒充。
UI 改动一旦影响下面任一画面，必须重截并在同一个提交里替换。

## 现有截图与对应界面

| 文件 | 对应界面 | 何时失效 |
| --- | --- | --- |
| `client-first-run.png` | 客户端未导入配置时的空状态 | 空状态文案、首次使用步骤列表或顶部状态徽章改动 |
| `client-settings-import.png` | 设置面板的「服务端配置」与「组件检测」 | 导入输入框提示、组件检测卡片改动 |
| `client-task-setup.png` | 主界面「同步任务」表单 | 表单字段增删、同步空间与同步方向的呈现方式改动 |

## 重截步骤

客户端就是一个本机 HTTP 服务，不需要 Electron 也不需要一台服务端就能进入截图所需状态。

```powershell
# 1) 用临时目录启动客户端，避免把演示状态写进日常使用的数据目录
$env:SFSC_PORTABLE_ROOT = "$env:TEMP\syncraft-doc-shot"
$env:SFSC_OPEN_BROWSER = "0"
pnpm client:start

# 2) 另开一个终端，把界面送进目标状态
pnpm docs:seed-screenshot
```

然后浏览器打开 `http://127.0.0.1:5188/` 截图。`client-first-run.png` 在执行 seed 之前截；
`client-task-setup.png` 在 seed 之后截；`client-settings-import.png` 点开右上角「设置」后截。

截完删除 `$env:TEMP\syncraft-doc-shot`，避免演示用的假凭据留在机器上。

## seed 脚本能造出哪些状态

默认是 collaboration 空间 + writer 角色，这时同步方向选择器保持可选，是常规形态。
要截「方向被服务端锁定」的画面：

```powershell
pnpm docs:seed-screenshot -- --mode distribution --role reader --direction download
```

其余可选参数见 `scripts/seed-doc-screenshot.mjs` 顶部：`--local-path`、`--sync-id`、`--base-url`。
脚本用服务端真实签发链路造 profile，再通过客户端真实的导入与保存接口写入，所以截出来的
界面代表真实签发结果，而不是手写状态文件拼出的形状。

## 两个已知问题

- 三个文件的扩展名是 `.png`，实际内容是 JPEG 数据。这是历史遗留，Markdown 与浏览器都按内容
  嗅探所以不影响显示。下次重截时按扩展名存成真正的 PNG。
- 服务端控制台的「首次配置」面板还没有截图。README 目前只用客户端截图，控制台部分是文字说明。

## 不要做的事

- 不要把完整 SyncKey、`sfsc://` 导入串、VLESS URI、管理 Token 或存储密钥截进画面。
  seed 脚本用的是本地生成的一次性假凭据，但真机上如果连过真实服务端，截图前要确认画面里
  没有真凭据。
- 不要用无头浏览器渲染后当作「实际截图」：字体与窗口都和 Windows 客户端不一致。
