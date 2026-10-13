<p align="center">
  <img src="app-icon.svg" width="120" alt="MyShell+">
</p>

<h1 align="center">MyShell+</h1>

<p align="center">安全、稳定、可被 Agent 操作的 SSH 客户端</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Rust-core-000000?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/React-xterm.js-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/MCP-ready-7C3AED" alt="MCP">
  <img src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows">
</p>

<p align="center">
  <a href="https://cnklpz.github.io/myshellplus/">官网</a> ·
  <a href="#功能">功能</a> ·
  <a href="#截图">截图</a> ·
  <a href="#安全设计">安全</a> ·
  <a href="#稳定性设计">稳定性</a> ·
  <a href="#接入-agent">接入 Agent</a> ·
  <a href="#开发">开发</a>
</p>

<p align="center">
  <img src="docs/images/terminal.png" width="900" alt="终端与状态面板">
</p>

目前支持 Windows，Android 计划中。

## 功能

| 模块 | 说明 |
|---|---|
| **终端** | 多标签、xterm.js（WebGL 渲染）、搜索、语法高亮、复制粘贴、断线重连 |
| **命令预测** | 历史命令 + 收藏命令 + 内置常用命令实时补全；输入中文直接转命令；可选 AI 预测（`Ctrl+Space`） |
| **AI 命令** | `Ctrl+K` 用自然语言生成命令，选中输出可让 AI 解释；支持 Claude / OpenAI 兼容服务 |
| **状态面板** | CPU / 每核 / 内存 / Swap / 负载 / 网络 / 磁盘 IO / 磁盘 / Top 进程，可自定义卡片 |
| **总览** | 所有服务器一屏实时状态，按分组批量连接 |
| **文件** | SFTP 浏览、上传下载（拖拽）、在线编辑、改权限 |
| **隧道** | 本地转发 `-L`、远程转发 `-R`、动态 SOCKS5 `-D`，可开机自动启动 |
| **批量执行** | 多行命令逐行发送到当前终端 |
| **多机执行** | 多台服务器并发执行，按主机查看输出，失败重试 |
| **命令** | 常用命令收藏，支持 `{{变量:默认值}}` |
| **搜索** | `Ctrl+P` 搜索服务器、终端、命令、历史、隧道、设置 |
| **全局热键** | `Ctrl+Alt+M` 显示/隐藏窗口；``Alt+` `` 按住切换终端（类似 Alt+Tab） |
| **测速** | 单台或全部服务器延迟测试 |
| **导入** | OpenSSH config、PuTTY、Xshell、MobaXterm、FinalShell、1Password、CSV、本软件备份 |
| **SSH Agent** | 支持 1Password、Windows OpenSSH Agent，私钥不离开 Agent |
| **主题** | 多套深色 / 浅色主题 |
| **Agent 接口** | 内置 MCP 服务，Claude Code 等 Agent 可直接列服务器、执行命令、读写文件、操作终端 |

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/images/home.png" alt="服务器列表"><p align="center">服务器分组</p></td>
    <td width="50%"><img src="docs/images/search.png" alt="全局搜索"><p align="center">全局搜索 <code>Ctrl+P</code></p></td>
  </tr>
  <tr>
    <td><img src="docs/images/predict.png" alt="命令预测"><p align="center">命令预测</p></td>
    <td><img src="docs/images/ai-command.png" alt="中文转命令"><p align="center">中文转命令</p></td>
  </tr>
  <tr>
    <td><img src="docs/images/cpu-detail.png" alt="CPU 详情"><p align="center">CPU 详情</p></td>
    <td><img src="docs/images/processes.png" alt="进程"><p align="center">进程</p></td>
  </tr>
  <tr>
    <td><img src="docs/images/files.png" alt="SFTP 文件"><p align="center">SFTP 文件</p></td>
    <td><img src="docs/images/tunnels.png" alt="隧道"><p align="center">隧道</p></td>
  </tr>
  <tr>
    <td><img src="docs/images/agent.png" alt="MCP 服务"><p align="center">MCP 服务</p></td>
    <td><img src="docs/images/themes.png" alt="主题"><p align="center">主题</p></td>
  </tr>
</table>

## 安全设计

- 所有密码、私钥、API Key 用主密码派生的密钥加密（Argon2id + XChaCha20-Poly1305），磁盘上只有密文
- 可选"在此设备记住"：数据密钥由 Windows DPAPI 保护，只有当前 Windows 账户能解开
- 主机指纹首次连接确认，指纹变化时告警
- Agent 权限按服务器设置：禁止 / 只读 / 每次询问 / 自动（高风险命令仍需确认），全部操作写审计日志
- MCP 服务只监听 `127.0.0.1`，需要 Bearer Token，拒绝浏览器来源请求

## 稳定性设计

SSH 连接、终端会话、隧道全部运行在 Rust 进程里，界面只负责显示：

```mermaid
flowchart LR
  UI["React + xterm.js<br/>只负责显示"] <-- "IPC 事件<br/>~60fps 合并" --> Core["Rust 核心"]
  Core --> SSH["SSH 连接池"]
  Core --> Term["终端会话<br/>512KB 环形缓冲"]
  Core --> Tun["隧道"]
  Core --> MCP["MCP 服务<br/>127.0.0.1"]
  Agent["Claude Code 等 Agent"] --> MCP
```

- 终端输出在 Rust 侧环形缓冲（每会话 512KB），界面重载后自动重新接上并回放
- 输出按约 60fps 合并后推送，大量输出不会压垮界面
- 界面心跳看门狗：窗口可见但界面 90 秒无响应（白屏/黑屏）时自动重载界面，连接不受影响
- 图表只保留最近 60 个采样点，终端回滚 5000 行，长时间运行内存稳定

## 接入 Agent

在应用的 **Agent** 页开启 MCP 服务后，复制页面上的命令，例如 Claude Code：

```bash
claude mcp add --transport http myshellplus http://127.0.0.1:17890/mcp --header "Authorization: Bearer <token>"
```

| 工具 | 说明 |
|---|---|
| `list_hosts` | 列出服务器 |
| `run_command` | 执行命令 |
| `batch_run` | 多机执行 |
| `host_status` | 主机状态 |
| `list_dir` / `read_file` / `write_file` | 文件操作 |
| `list_terminals` / `read_terminal` / `send_terminal` | 操作已打开的终端 |

## 开发

```bash
pnpm install
pnpm tauri dev
```

打包：`pnpm tauri build`

```
src-tauri/src/
  ssh/        连接池（跳板机、指纹校验、远程转发回调）、命令执行
  term.rs     终端会话（环形缓冲、输出合并、重连回放）
  monitor.rs  服务器状态采集
  transfer.rs SFTP 与传输
  tunnel.rs   -L / -R / SOCKS5
  batch.rs    批量执行
  predict.rs  命令预测、AI 命令生成
  ai.rs       Claude / OpenAI 兼容接口
  mcp.rs      MCP 服务
  guard.rs    Agent 权限与审计
  vault.rs    加密保险库
  importer.rs 导入与备份
  onepass.rs  SSH Agent 与 1Password
  hotkey.rs   全局热键与终端切换器
  watchdog.rs 界面自愈
src/features/ 各功能界面
e2e/          基于真实应用的端到端测试（WebView2 CDP）
```

## 云同步（规划中）

所有同步表带 `id / updated_at / deleted`，按最后写入合并；密文直接上传，服务器无法解密（端到端加密）。服务端使用自建服务器。
