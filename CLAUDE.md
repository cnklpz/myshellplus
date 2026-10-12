# MyShell+

Tauri 2 SSH 客户端。Rust 核心（`src-tauri/`）持有所有连接、密钥和隧道；React + xterm.js 前端（`src/`）只负责显示。前端崩溃/重载不得导致连接断开。

## UI 规则：视觉对齐

所有界面必须遵循视觉对齐设计：

- **统一网格**：间距只用 4px 的倍数（4/8/12/16/24/32），写成 CSS 变量 `--sp-*`，不写零散数值。
- **对齐线一致**：同一区域的图标、文字、输入框左边缘对齐到同一条竖线；列表项的图标列、文字列、右侧数值列在每一行都处于相同 x 位置。
- **垂直居中**：图标与文字在同一行时以视觉中心对齐（`align-items: center`），图标尺寸用 `--icon-sm/md/lg`，不要靠 margin 微调。
- **统一高度**：同一行内的按钮、输入框、下拉框高度一致（紧凑 `--h-sm` 32px / 默认 `--h-md` 36px），表格行高一致。正文 14px，宁可略大也不要让人看着累。
- **数字对齐**：数值使用 `font-variant-numeric: tabular-nums` 并右对齐，单位与数值间距一致。
- **面板边距一致**：侧边栏、右侧面板、对话框的内边距相同，标题与内容左边缘对齐。
- **只用 token**：小于 4px 的间距只能用 `--sp-half`（2px），不写 1/6/7px；高度用 `--h-xs/sm/md`、`--h-badge` 和标题栏类 `--h-titlebar/panel-head/dialog-head/page-head`；字号 `--fs-*`（页面标题 `--fs-title`，`--fs-xl` 只给大数字）；图标 `--icon-sm/md/lg/xl`。与 JS 常量重复的尺寸（如图表 gutter）由 JS 设成 CSS 变量，不在 CSS 里再写一遍。

## UI 规则：共享原语

新增界面先用 `src/styles/base.css` 与 `src/components/ui.tsx` 的现成原语，**功能 CSS 不再写私有版本**：

| 需要 | 用 | 不要再写 |
|---|---|---|
| 搜索框 | `<SearchBox>` / `.search-box`（`.sm`、`.flat`） | `xx-search` |
| 空状态 | `<Empty icon text action sm>` | `xx-empty`、手写 `<div className="empty">` |
| 加载转圈 | `.spin`（加在 svg 上，不加在按钮上） | 私有 `@keyframes` |
| 进度条 | `<Bar thin>` / `.bar.thin` | 3–4px 私有进度条 |
| 小图标按钮 | `.icon-btn.sm`（`.danger`/`.ok`），悬停显示用 `.hover-reveal` + `.hover-host` | `xx-ibtn`、`display:none`/负 margin |
| 标签/值网格 | `.kv`（`.loose`） | `xx-kv` |
| 胶囊 | `.badge`（`.ok/.warn/.err/.mono/.trunc/.count`） | `xx-chip`、`xx-tag` |
| 区块/分组标题 | `.section-title`（右侧 `.meta`，计数 `.count`） | `xx-sec-title`、`xx-group-head` |
| 表单行与提示 | `<Field>` / `.field`，`.field-hint` | `xx-field`、`xx-note` |
| 统计数字 | `.stat-value` / `.stat-label` | `xx-stat-value` |
| 对话框 | `<Dialog>`；自定义外壳也用 `<DialogHeader>`，标题对齐 `--sp-6` | 私有 `xx-head` |
| 数值 | `.num`（tabular、右对齐） | `xx-num` |

- **inline style 只给运行时计算值**（位置、百分比、数据颜色）。表格列宽写成 CSS 类（`<col className="mon-w-72">`），不写 `<col style={{width}}>`；不用 inline style 抵消共享类（`flex:"none"`、`marginTop:0`、`gridColumn`），在类里解决。
- 共享原语给子元素定样式时用 `:where(.x) > …` 压低优先级，颜色放在容器上让子元素继承，不能盖掉子元素自己的 `.faint`、状态色等类。
- **局部修饰类不得与全局类重名**（如 `.mon-note.empty` 会撞上 `.empty`），也不得跨功能借用别的模块的类（如 toolbox 用 `.dk-sub`）。
- 侧边面板：顶栏 `padding: var(--sp-3) var(--sp-4) var(--sp-2)`，列表底部 `--sp-3`，内容左边缘与面板标题对齐。

## UI 规则：视觉风格

目标是克制、有质感的桌面工具，不要“AI 生成感”：

- **层次靠底色，不靠边框**：表面层级 `--chrome` < `--bg-0` < `--bg-1` < `--bg-2`。分隔优先用留白和底色差；必须有线时用 `box-shadow: inset 0 0 0 1px var(--line)`，不要到处 `border`。
- **颜色只用 token**：所有颜色来自 `src/lib/themes.ts` 设置的 CSS 变量（支持多主题，含浅色）。禁止写死颜色；需要半透明时用 `color-mix(in srgb, var(--x) N%, transparent)`。
- **强调色要少**：一个屏幕里 accent 只用于当前选中项和一个主操作按钮。状态色（ok/warn/err）只表达状态。每张卡片/每一行都重复出现的按钮、图标、胶囊（快速连接、文件夹图标、协议标签、固定按钮）不得用 accent/primary。
- **实色上的文字**：实心 accent/danger 底上的文字和图标用 `--on-accent` / `--on-danger`，遮罩用 `--scrim`，阴影用 `--shadow-sm`；新增颜色 token 要在 `themes.ts` 里给每个主题（含浅色）都赋值。
- **图标克制**：卡片标题、表单标签前不加装饰性图标；图标只用在按钮、列表行类型列、状态指示。
- **徽章克制**：能用文字颜色或小圆点表达的，不用 badge。
- **排版**：页面标题用 `.page-header h1`（20px），区块标题用 `.section-title`，正文 13px；不要大写字母间距标题。

## UI 规则：文案

- 不写副标题、引导语、功能介绍段落（“这里可以…”“通过 X 让你…”）。
- 标签、按钮直接说功能，2–4 个字为宜。
- 提示文字只在用户会犯错或有风险时出现，一句话，不超过 20 个字。
- 空状态：一行短句 + 一个操作按钮，不列快捷键清单、不解释原理。
- 提示/备注不复述按钮或标题已经说明的功能，只写风险或后果（“立即生效”“会删除家目录全部文件”）；“密码经标准输入传递”这类实现细节不是风险，不写。
- placeholder 用示例值（`192.168.1.10`、`查看占用 80 端口的进程`）而不是说明句或状态。例外：没有选中值的下拉框，placeholder 就是按钮文字，可写功能名。
- 会再弹对话框的按钮（不只是菜单项）标签以 `…` 结尾，如 `导入…`、`管理…`。
- 错误信息说清楚原因即可，不道歉、不加感叹号。

## UI 规则：右键菜单

WebView 自带菜单（后退/刷新/检查）任何地方都不能出现。`GlobalContextMenu` 兜底：输入框给编辑操作，选中文字给复制/搜索，空白处给应用操作。

**实现**
- 一律用 `src/features/terminal/ContextMenu.tsx`：行级用 `useContextMenu()` 的 `open(e, items)` + 渲染 `node`；需要自定义关闭逻辑时直接用 `<ContextMenu>`。不要再写 `MenuBox` / `.fp-menu` / `.home-menu` 这类私有菜单和私有 CSS。
- 菜单项用 `MenuItem` 数据描述（`label/icon/hint/disabled/danger/onSelect`），条件项写成 `cond && {...}`，分隔写 `"sep"`，由 `normalize` 去掉首尾和重复分隔，不手动拼 `<hr>`。
- `.ctx-menu` / `.ctx-item` 是全局类名，功能模块的 CSS 不得再定义或用后代选择器覆盖它们。
- 自定义菜单的组件必须 `preventDefault()`（`open` 已处理），否则全局菜单会叠出来；嵌套区域还要 `stopPropagation()`，避免外层行/面板的菜单同时打开。

**右键菜单独有的行为（共享组件已实现，自写逻辑时不得丢）**
- 以光标为原点，右/下空间不够时翻到另一侧，距窗口边 `EDGE`（4px）；首帧 `visibility: hidden` 量尺寸，避免闪到错误位置。
- 通过 portal 挂到 `body`：对话框的 transform 动画会让 `position: fixed` 偏移。portal 后 React 事件仍会冒泡到所有者，菜单根节点要拦 `pointerdown/mousedown/click`，防止触发行点击和拖拽。
- 关闭时机：菜单外 mousedown、滚轮、外部滚动、窗口失焦、窗口 resize、Esc/Tab。
- 键盘：↑↓ 跳过分隔和禁用项循环移动，Enter 执行；其它键关闭菜单并照常传给原目标（终端继续能打字）。
- 焦点：菜单不抢焦点（菜单项 `onMouseDown` 要 `preventDefault`）；Esc 关闭时 `onClose(true)`，调用方据此把焦点还给终端/列表。
- 先关菜单再执行动作；异步动作失败用 `toast(errMsg(e), "error")`，不能静默。
- 菜单打开期间在菜单上再右键不弹任何菜单。

**内容与适配**
- 右键对象决定菜单：右键未选中的行先把它设为唯一选中，再按选中集合出菜单；右键已选中的行则作用于整个选集（参照 `FilesPanel` 的 `onRowMenu`）。多选时只对单项有意义的操作置灰，不隐藏。右键空白处清空选中，只给“新建/上传/刷新/复制路径”这类容器级操作。
- 同一种对象在不同位置（侧边栏主机行、首页主机卡片、终端标签）菜单项和顺序要一致，可按位置追加独有项，但共有项不能这边有那边没有。
- 顺序：打开/主操作 → 编辑类 → 复制类 → 对象独有功能 → 危险操作（`danger`，永远在最后，前面加分隔）。删除、结束进程等不可逆操作走确认对话框，不在菜单里直接执行。
- 只有菜单里才有的功能（终端的“粘贴选中内容”“清除缓冲区并重置”、Shift+右键快速复制/粘贴；监控进程的暂停/结束；文件的“终端 cd”）必须同时有工具栏按钮或快捷键之一，或在 `hint` 显示快捷键，不能成为唯一入口却又不可发现。
- 有快捷键的项必须填 `hint`，与实际绑定一致（终端是 `Ctrl+Shift+C/V`，不是 `Ctrl+C/V`）；没有快捷键时 `hint` 可放简短参数（如信号名 `TERM`）。会再弹对话框的项标签以 `…` 结尾（`结束…`、`详情…`）。
- 依赖状态的项用 `disabled` 表达（未连接时粘贴、无选中时复制），不随状态忽隐忽现；只与选中文字相关的扩展项（AI 解释、加入命令）可以无选中时隐藏。
- 复制地址、主机名等提示遵守隐私模式（`usePrivacy` / `priv.addr`），toast 里不得泄露真实地址。
- 标签 2–6 字，动词开头；用分隔线按上面的顺序分组，每组不超过 5 项。

## 代码规则：Rust 核心

`panic = "abort"`：任何 panic 都会让整个应用退出、断开所有连接。

- **不 panic**：不对不可信数据用字节下标切片（`&s[a..b]`），用 `s.get(a..b)` 或按字节处理；不对外部输入 `unwrap`/`expect`。
- **用户等待不计入超时**：主机指纹确认、Agent 审批的等待时间不能算进网络超时；超时或取消时必须撤掉对应 prompt，不留死弹窗。
- **后台不重连**：监控、隧道转发、cwd 探测等后台/轮询路径只用已有连接（`pool.existing`），只有用户的显式操作可以 `get_conn`。断开/删除主机时同时停止它的监控、隧道等任务。
- **任务有主**：每个 `spawn` 出的任务都要由 JoinHandle 或取消信号持有；重绑端口前先 abort 并 `await` 旧任务。
- **读-改-写原子**：同一设置/meta 的读改写用 `Db::update_setting` / `meta_set_many`，不要先 `setting` 再 `set_setting`。设置 JSON 解析失败返回错误，只有“行不存在”才用默认值。
- **错误不吞**：`let _ =` 只用于 UI `emit`；数据库、审计、保险库、`trust_host` 的失败用 `util::log_err` 记录。
- **锁**：不跨 `.await` 持有同步锁；需要多把锁时固定顺序并写在结构体注释里。
- **不阻塞**：涉及磁盘、加密、网络的命令写成 `async`；KDF、私钥解码等耗 CPU 的放进 `spawn_blocking`。
- **安全**：远程命令里拼接的字符串一律 shell 转义；本地路径来自远端时拒绝 `..` 和驱动器前缀；只读策略（`guard.rs`）新增命令时必须同时列出其写入型参数并补测试。
- 面向用户的错误信息用中文。改动后 `cargo clippy --all-targets` 必须零警告、`cargo test` 通过。

## 代码规则：前端

- **复用 `src/lib` 的公共实现，不在组件里另写**：
  - 剪贴板：`copyText(text, "地址")`（`lib/clipboard`），toast 只写类别，不写复制的值。
  - Tauri 事件：组件里用 `useTauriEvent`，effect 里用 `onTauriEvent`（`lib/events`），不直接调 `listen()`。
  - localStorage：`lsGet/lsSet/lsGetJson/lsSetJson`（`lib/storage`）。
  - 格式化：`lib/format`（`fmtBytes/fmtMs/baseName`…）；阈值颜色：`lib/level`（`pctColor/levelColor`）；shell 转义：`lib/remote` 的 `shq`。
  - 所有后端调用经 `lib/api.ts`，不直接 `invoke`。
- **隐私模式**：主机名、地址、连接错误、AI 输出等显示文本一律经 `usePrivacy()`（`addr` / `text` / `hostText`），不直接读 localStorage 或调 `maskAddr`。
- **异步防过期**：异步结果写入 state 前必须判断是否过期（seq ref 或 alive 标志），重试、切换主机或卸载后旧结果不得落地。
- **错误可见**：用户触发的异步操作失败 `toast(errMsg(e), "error")`；`.catch(() => {})` 只用于确实无需提示的后台调用。启动流程每一步独立 catch，一步失败不能让界面空白。
- **模块级状态可订阅**：组件依赖的模块级可变状态（如 sudo 密码缓存）用 `useSyncExternalStore` 暴露，不靠 bump 强制重渲染。
- **对话框与事件冒泡**：`Dialog` 已 portal 到 body，但 React 事件仍冒泡到所有者。行/卡片上的 pointer、右键、双击处理先判断 `e.currentTarget.contains(e.target as Node)` 或 `e.defaultPrevented`；常驻但隐藏的容器包 `HideDialogs`。
- **全局监听要清理**：挂到 `window`/`document`/`body` 的监听和类名，在卸载时也要清理（不能只在拖拽结束时清）。
- 改动后 `npx tsc --noEmit -p .` 必须通过。
- 仓库里 LF 与 CRLF 文件混存：编辑时保留每个文件原有换行符，不做整体转换。
