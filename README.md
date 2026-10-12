# MyShell+

一个安全、稳定、可被 Agent 操作的 SSH 客户端。目前支持 Windows，Android 计划中。

## 功能

- **终端**：多标签、xterm.js（WebGL 渲染）、搜索、复制粘贴、断线重连
- **命令预测**：历史命令 + 片段 + 内置常用命令实时补全；可选 AI 预测（`Ctrl+Space`）
- **AI 命令**：`Ctrl+K` 用自然语言生成命令，选中输出可让 AI 解释
- **状态面板**：CPU / 每核 / 内存 / Swap / 负载 / 网络 / 磁盘 IO / 磁盘 / Top 进程
- **文件**：SFTP 浏览、上传下载（拖拽）、在线编辑、改权限
- **隧道**：本地转发 `-L`、远程转发 `-R`、动态 SOCKS5 `-D`，可开机自动启动
- **批量执行**：多台服务器并发执行，按主机查看输出，失败重试
- **片段**：常用命令收藏，支持 `{{变量:默认值}}`
- **导入**：OpenSSH config、PuTTY、Xshell、MobaXterm、FinalShell、CSV、本软件备份
- **Agent 接口**：内置 MCP 服务，Claude Code 等 Agent 可直接列服务器、执行命令、读写文件、操作终端

## 安全设计

- 所有密码、私钥、API Key 用主密码派生的密钥加密（Argon2id + XChaCha20-Poly1305），磁盘上只有密文
- 可选"在此设备记住"：数据密钥由 Windows DPAPI 保护，只有当前 Windows 账户能解开
- 主机指纹首次连接确认，指纹变化时告警
- Agent 权限按服务器设置：禁止 / 只读 / 每次询问 / 自动（高风险命令仍需确认），全部操作写审计日志
- MCP 服务只监听 `127.0.0.1`，需要 Bearer Token，拒绝浏览器来源请求

## 稳定性设计

SSH 连接、终端会话、隧道全部运行在 Rust 进程里，界面只负责显示：

- 终端输出在 Rust 侧环形缓冲（每会话 512KB），界面重载后自动重新接上并回放
- 输出按约 60fps 合并后推送，大量输出不会压垮界面
- 界面心跳看门狗：窗口可见但界面 90 秒无响应（白屏/黑屏）时自动重载界面，连接不受影响
- 图表只保留最近 60 个采样点，终端回滚 5000 行，长时间运行内存稳定

## 接入 Agent

在应用的 **Agent** 页开启 MCP 服务后，复制页面上的命令，例如 Claude Code：

```bash
claude mcp add --transport http myshellplus http://127.0.0.1:17890/mcp --header "Authorization: Bearer <token>"
```

工具：`list_hosts` `run_command` `batch_run` `host_status` `list_dir` `read_file` `write_file` `list_terminals` `read_terminal` `send_terminal`

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
  watchdog.rs 界面自愈
src/features/ 各功能界面
```

## 云同步（规划中）

所有同步表带 `id / updated_at / deleted`，按最后写入合并；密文直接上传，服务器无法解密（端到端加密）。服务端使用自建服务器。
