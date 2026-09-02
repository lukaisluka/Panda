# Panda 使用指南

Panda 是一个 ACP（Agent Client Protocol）通用客户端：连接任何说 ACP 的 agent 服务（Claude Code、Gemini CLI、Codex、Goose……经 bridge 暴露后），以对话为核心体验。Panda 是**纯协议客户端**——它从不安装、启动或管理 agent 进程，你连的必须是一个已在运行的服务。

## 1. 快速上手

```sh
pnpm install
pnpm dev            # http://localhost:5173，自动进入脚本回放 demo
```

打开页面就是 **demo 回放**：Panda 会自动播放一段脚本化的 agent 会话（重构 auth 校验的故事），不需要任何外部服务。回放和真实连接走的是完全相同的内部路径，所以它是了解界面行为的样板：

- 发消息试试——回放驱动会给出脚本化的后续回应
- 遇到权限卡片时点 Allow / Reject，观察 agent 的不同走向
- 侧栏底部「回到 demo 回放」可随时重看

想校准长会话下的滚动表现，用长场景回放：`http://localhost:5173/?demo=long`（80 轮会话）。

## 2. 连接真实 agent

### 端点约定

Panda 连接的端点必须满足：**WebSocket，一条 text 帧承载一条 JSON-RPC 消息**。这是官方 TypeScript SDK、ACP remote-transport 草案与主流 bridge 共同遵守的约定。

### 用本仓库的 mock agent 起步

```sh
node scripts/mock-acp-server.mjs          # ws://localhost:8765/acp
PORT=9000 node scripts/mock-acp-server.mjs   # 自定义端口
```

mock agent 声明了全部会话能力（list / load / resume / delete）和图片输入能力，会话**磁盘持久化**（`scripts/.mock-sessions.json`），进程重启也不丢——是演练断线恢复、会话切换、图片发送的最好目标。它的第一轮对话包含思考、计划、读文件、权限请求、代码 diff 和图片，之后每轮简短回应。

然后：

1. 在 Panda 侧栏「ACP 连接」面板填入 `ws://localhost:8765/acp`
2. 填一个**绝对路径**作为工作目录（随便写，mock 只存不用；连真实 agent 时见下节）
3. 点「连接」

### 连接你自己的 agent

常见做法是用社区 bridge 把一个 stdio ACP agent 包成 WebSocket 端点，例如 [acpremote](https://github.com/vcoderun/acpkit)（`expose`）、[@flutur/acp-http-bridge](https://github.com/Alemusica/acp-http-bridge)、[acp-bridge](https://github.com/vezaynk/acp-bridge)。具体命令看各工具的 README——服务生命周期归你，Panda 只负责连。

**工作目录（cwd）的含义**：它随 `session/new` 发给服务端，由**服务端**解释。对远程服务，这是远端机器上的路径，不是你本机的路径。

### 一次连接里发生了什么

Panda 连接后依次执行：`initialize`（协商协议版本、读取能力声明、拉取会话列表）→ `session/new`（新会话）或恢复既有会话。之后每一轮对话就是一次 `session/prompt`：流式消息、工具调用卡片、计划、用量/成本都会实时出现在消息流里。

## 3. 界面指南

### 侧栏

- **Sessions 列表**：当前活跃会话置顶，其余按最近活动排序。agent 起了标题的会话显示标题，否则显示「目录名 · 会话 id 末 6 位」
- **切换会话**：点击列表项，Panda 调用 `session/load` 把该会话的完整历史**重放**到界面上。正在执行一轮对话时（状态栏显示 Working…）切换会被阻止，避免孤儿请求
- **新建会话**：列表标题右侧的 `+`，沿用当前连接的工作目录
- **删除会话**：hover 到非活跃会话上出现垃圾桶图标（需要 agent 支持 `session/delete`）
- **ACP 连接面板**：断开时填地址和目录连接；连接中显示状态；连接成功显示 agent 自报名称和协议版本。意外断开后会出现「重连并恢复会话」按钮，见下文

### 消息流

- **用户/agent 消息**：Markdown 渲染；agent 发的图片内联显示
- **思考块**（agent 的推理过程，可折叠）
- **工具调用卡片**：标题、状态（pending → in_progress → completed）、涉及文件、文本结果或**代码 diff**（Shiki 语法高亮 + 词级变更高亮）
- **计划卡**：agent 的任务清单及各项状态推进
- **权限卡片**：agent 请求敏感操作批准时出现，点击选项即回复；期间状态栏显示「等待你的批准」，输入框停用
- **长会话**：列表做了虚拟化，流式增长时自动跟随底部；你向上滚动即脱离跟随，滚回底部自动恢复

### 状态栏

左侧是连接状态（agent 名 / 连接中 / 错误详情）和会话状态（**Ready** / **Working…** / **等待你的批准**）；右侧是 token 用量条和成本，数据来自 agent 的 `usage_update` 上报（agent 不报就不显示）。

### 输入框

`Enter` 发送，`Shift+Enter` 换行。agent 声明 `promptCapabilities.image` 后，可用回形针选择图片，或直接粘贴剪贴板截图；缩略图显示在输入框上方，可单独移除，也可以不写文字只发图片。图片保持原 MIME 类型与原始字节，不转码、不压缩；每张上限 5MB，每条消息最多 4 张，超限项会红字标注且不发送，其余内容照常发送。

一轮对话进行中，发送按钮变成红色**停止**按钮——点击即发 `session/cancel`，agent 停止当前轮次，未答复的权限请求按规范自动以 cancelled 回复。

### 断线恢复

意外断开时，**对话内容保留在屏幕上**，连接面板出现「重连并恢复会话」：

1. agent 声明了 `session/resume` → 直接恢复，transcript 原样保留
2. 没有 resume 但支持 `session/load` → 重连后把历史**重放**重建
3. 两者都没有 → 只能新建会话（界面会如实降级）

## 4. 能力矩阵

Panda 的功能跟随 agent 在 `initialize` 时声明的能力走，**未声明一律可见地降级，绝不假装**：

| 功能 | 依赖的 agent 能力 | 未声明时 Panda 的行为 |
| --- | --- | --- |
| 会话列表 | `sessionCapabilities.list` | 侧栏只显示本地记忆的会话（按端点存于浏览器） |
| 切换/加载历史会话 | `loadSession` | 列表项禁用，悬停提示「agent 不支持历史回放」 |
| 恢复会话（断线重连） | `sessionCapabilities.resume` | 降级为 `session/load` 重放；再不行则新会话 |
| 删除会话 | `sessionCapabilities.delete` | 删除按钮不出现 |
| 收图片 | 无需声明（agent 发什么渲染什么） | — |
| 发图片 | `promptCapabilities.image` | 图片入口保留但禁用，并说明 agent 未声明图片输入能力 |
| 终端类工具内容 | 客户端须声明 terminal 能力 | **跳过并在控制台告警**——浏览器聊天客户端不执行 agent 机器上的命令，这是 v1 协议的语义 |

浏览器控制台（DevTools）里 `[panda/acp]` 前缀的日志记录了每个门控决策，排查时先看那里。

## 5. 故障排查

**连不上**

- 确认端点是 WebSocket 且路径正确（mock 是 `ws://localhost:8765/acp`，不是 `http://`）
- 先用 `curl http://localhost:8765/`（mock）之类确认服务进程活着
- 错误会原样显示在连接面板和状态栏；`[object Event]` 这类不可读错误已被翻译成可读文本，剩下的照错误信息处理

**协议版本不匹配**

Panda 目前只协商 **v1**（`PROTOCOL_VERSION = 1`），不匹配时 fail fast，错误形如「agent 协商了协议 v2，Panda 目前只支持 v1」。v2 支持在 roadmap 上。

**连接成功但没消息 / 消息错乱**

- agent 必须把 `session/update` 发给当前会话；Panda 对其他会话的 update 会在控制台打 dropped 告警并忽略
- `session/list` 返回里缺 `sessionId` 的条目会被丢弃（控制台有告警）

**重连后历史没了**

看第 4 节的恢复矩阵：agent 既不声明 `resume` 也不声明 `loadSession` 时，Panda 无法恢复，只能新会话——这是 agent 侧的能力缺失，不是 Panda 丢数据。本地记忆的会话列表仍按端点保存在浏览器里（最多 50 条）。

**工具内容显示不全**

终端类（terminal）工具内容被跳过是**设计行为**（见第 4 节），控制台有 `[panda/acp] tool_call … "terminal" not supported yet — skipped` 告警。

## 6. FAQ

**Panda 会帮我装/启动 agent 吗？**
不会，也永远不打算会。agent 服务由你自己启动（或连接别人运维的），Panda 只消费协议。这是产品的核心边界。

**我的对话数据存在哪？**
对话内容在 agent 侧；Panda 只在浏览器 localStorage 里按端点记住会话列表（id、目录、标题、时间）和你上次填的地址/目录，方便下次连接。Panda 自己不落任何对话内容。

**demo 回放和真实连接有什么区别？**
同一个界面、同一套内部状态机，只是消息来源不同：demo 是内置脚本，live 是 JSON-RPC over WebSocket。demo 不需要网络，也不碰 localStorage 之外的任何东西。

**为什么我发的消息在切换会话后不见了？**
切换会话（`session/load`）会把界面重置成目标会话的完整历史重放，你切走前的界面只是被目标会话的历史替换了，数据都在 agent 侧，切回来即可。

**支持发图片吗？**
支持。agent 声明 `promptCapabilities.image` 后，可粘贴截图或用文件选择器添加任意 `image/*`；每张不超过 5MB、每条消息最多 4 张，也支持纯图片消息。未声明能力时入口可见但禁用。

**支持哪些 agent？**
任何说 ACP v1 的服务。40+ 主流 coding agent（Claude Code、Gemini CLI、Codex、Cursor、Goose、Copilot……）都可通过 ACP 或 bridge 暴露。
