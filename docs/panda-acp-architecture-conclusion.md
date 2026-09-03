# Panda ACP 架构结论与实施建议（源码核实版）

> 目标：明确 Panda、assistant-ui、react-acp、acp-components 四者的边界，确定 Panda 应该复用什么、自己保留什么、优先重构什么，避免重复造轮子，同时保证 Panda 继续保持 ACP-first 的产品定位。
>
> **核实说明（2026-09-03）**：本文全部外部项目论断已对照源码逐条核实。核对版本：assistant-ui `97ec932`（2026-09-02 HEAD）、react-acp（hafbit）`339d455`（2026-08-11）、acp-components（zvzuola）`1708c20`（2026-08-05）；Panda 侧论断对照 `main@1d2d9d8`。与初稿不一致的结论以「核实修正」标注。

---

## 1. 最终结论

Panda 不应该变成 `assistant-ui + react-acp` 的一个壳，也不应该继续把所有 UI 和 ACP 客户端能力都从零实现。

更合理的方向是：

```text
                         Panda
                           │
              ┌────────────┴────────────┐
              │                         │
        Panda ACP Core              Panda UI
              │                         │
     ACP-first state model       选择性复用成熟组件
              │                         │
     reducer / lifecycle          assistant-ui Elements
              │                   （仅叶子级展示组件）
     extensions / capabilities    Composer / Attachment 芯片
              │                   ActionBar / ToolCall / Reasoning
              │
              ├──── 借鉴 react-acp
              │     raw 归属制保存
              │     事务性 session 切换
              │     双 generation 竞态防护
              │     权限集合生命周期
              │     echo 对账
              │
              └──── 借鉴 acp-components
                    multi-agent 状态模型
                    transport 抽象
                    Platform 能力分片
                    workbench 架构
```

一句话概括（核实后）：

- **assistant-ui：帮 Panda 少写 UI —— 但只有「叶子级」纯展示组件可独立复用。**（核实修正：消息列表、自动滚动、多行键盘交互全部绑定其 runtime，不能脱离 `AssistantRuntimeProvider` 使用；而这些恰恰是 Panda 已经自研完成且带测试的部分。）
- **react-acp：帮 Panda 少踩 ACP 协议状态机的坑 —— 已核实，且可直接照搬的具体机制比初稿更丰富。**
- **acp-components：给 Panda 提供完整 Workbench 架构参考 —— multi-agent 模型已核实；但其 host capability 分层并不存在（核实修正，见 5.3），那层 Panda 必须自建。**
- **Panda 自己必须掌握：ACP-first domain model、产品体验与 Host/Agent 边界。**

---

## 2. 四个项目分别是什么

### 2.1 Panda

Panda 的目标应该明确为：

> **Universal ACP Agent Workbench / Client**

它不是一个普通 AI Chat UI，而是面向任意 ACP Agent 的通用客户端。

因此 Panda 的核心世界观不应该只有：

```text
Thread
Message
Composer
Tool
```

而应该至少能容纳：

```text
Agent
Connection
Workspace
Session
Message
Thought
ToolCall
Permission
Plan
Mode
ConfigOption
Command
Terminal
Filesystem
Resource
Usage
Compaction
Extension
```

这也是为什么 Panda 的核心状态模型应该优先忠实于 ACP，而不是忠实于某个 UI 框架。

---

### 2.2 assistant-ui（已核实）

成熟度与合规性：

- **MIT**（各发布包一致；Assistant Cloud 是可选商业服务，不影响 UI 库本身）。
- npm `@assistant-ui/react` **v0.15.17**，约 48 个 package 的 monorepo，极活跃（HEAD 2026-09-02，PR 编号已到 #6718），测试文化好。
- peer `react: ^18 || ^19`——与 Panda 的 React 19.2 完全兼容。
- 核心依赖轻：`@assistant-ui/react` 仅 10 个依赖（含 zustand ^5、zod、radix-ui），markdown/高亮/虚拟化全在可选包里，`sideEffects: false`。

它主要解决的是：

```text
AI / Agent backend
       ↓
统一 Runtime
       ↓
Thread / Message / Composer / Tool UI
```

**Elements 的真实形态（核实修正，初稿未提及）**：Elements 不是 npm 包，而是 **copy-paste 源码组件**，经 shadcn registry（`https://r.assistant-ui.com`）用 `assistant-ui add`（内部委托 `shadcn add`）拷进你的仓库，之后由你维护。升级靠 CLI 的 update 命令——拷得越多，vendor 代码漂移面越大。

**双模式是官方明确支持的**：

- **Standalone**：叶子组件纯 props / 回调驱动，零 runtime import。官方文档原文："You own that state and pass it down as props and event handlers."
- **Runtime**：组合组件（如 `thread.aui.tsx`）消费内部 context，必须包在 `AssistantRuntimeProvider` 里。

**不能独立复用的（核实修正）**——以下全部是 runtime 绑定，standalone 模式拿不到：

```text
Thread 消息列表本体（thread.aui.tsx 走 useAuiState，不接受外部 messages props）
auto-scroll / scroll-to-bottom（useThreadViewportAutoScroll）
多行 ComposerInput（standalone 版是单行 <input>；
  Enter/Shift+Enter/autosize 在 runtime primitive 里）
attachment 预览大图 Dialog（依赖 Base UI/Radix）
```

**无任何 ACP 支持**：全仓搜索 `acp` / `agentclientprotocol` 零命中。现有协议适配器是 ag-ui、a2a、opencode、mcp——ACP 客户端要接它只能自己走 `useExternalStoreRuntime`（ExternalStoreAdapter：`messages` + `convertMessage` + `onNew`）桥接，这层完全自担。

---

### 2.3 react-acp（已核实）

**归属（核实修正）**：`hafbit/react-acp`（不是 Zed；zed-industries 下只有已归档的 codex-acp）。npm 包名 `@hafbit/react-acp`，**v0.1.9**，**MIT**，peer `react ^18 || ^19` + `@assistant-ui/react ^0.15`。依赖 `@agentclientprotocol/sdk ^1.3.0`，**只承诺 ACP v1**；v2 Draft 明确不承诺，一律按 raw/unsupported 保留。

**成熟度警示**：0.1.x 早期项目（squashed 单 commit 历史，README 版本号滞后于 package）。但工程化程度高：约 2,000 行测试对 3,800 行源码，含 Playwright e2e 与需求基线文档（docs/requirements.md）——把它当「高质量参考实现」而非「可依赖的生产库」。

定位核实（属实）：README 自述「transport-agnostic ACP v1 runtime adapter for assistant-ui … while preserving raw ACP metadata」。它不做 agent 生命周期、网关、filesystem/terminal host。

架构分层核实（属实，实际模块比初稿画的更细）：

| 文件（src/core/） | 职责 |
|---|---|
| `types.ts`（541 行） | 全部公开类型：`AcpThreadState`（连接级仓库）、`AcpSessionState`（每 session 协议权威状态）、`AcpStateEvent` 事件联合、`AcpClientAdapter` 传输边界、`AcpRuntimeExtensionAdapter` 扩展接口 |
| `state.ts`（574 行） | **纯 reducer**，零 I/O |
| `controller.ts`（955 行） | 全部 I/O 编排（connect/auth/attach/prompt/permission），手写 external store |
| `projection.ts`（479 行） | Projector：session state → assistant-ui 消息，带引用相等缓存 |
| `sdk-adapter.ts` / `serialize.ts` / `errors.ts` | SDK 封装 / 反向序列化 / 稳定错误码 |

`/core` 完全不 import React（仅类型引用 assistant-ui）。对 Panda 最有价值的是 Projector 之前的部分——这个判断经核实成立。

核实中发现、初稿没写但值得学的三个设计：

```text
乐观消息 + echo 对账（PendingOutbound / echoRelation）
  —— 本地乐观 user message 与 agent 回显对账合并，不伪造协议通知
compactInactiveSessions
  —— 非活动会话压缩（保 info/modes/config，丢消息/工具）控内存
能力门控纪律
  —— 所有 mutating 调用先查 agentCapabilities / sessionCapabilities
```

---

### 2.4 acp-components（已核实）

**归属**：`zvzuola/acp-components`。双包 `@acp-components/core` + `@acp-components/react`，**v0.1.0**（npm 实查），**MIT**。

**成熟度警示（核实）**：CHANGELOG 只有 Unreleased 一节；squashed 单 commit；单维护者；README 自述「Until the first stable release, minor versions may include breaking public API changes」。有 CI、26 个测试文件、在线 demo——可用但需警惕 API 变动。

**core / React 分离是真实的**：`@acp-components/core` 依赖仅 `@agentclientprotocol/sdk ^1.2.1` + `zustand ^5`（vanilla），零 React；README 明文「Never add React imports to core」。

**技术栈与 Panda 高度重合（核实，初稿未提及）**：zustand（vanilla store）+ `react-virtuoso`（长列表虚拟化）+ react-markdown——与 Panda 完全同款。但样式是 **SCSS modules + `--acp-*` tokens + 单一 react.css，不是 tailwind**；复用其视觉层需要接纳这套 token 体系，对 tailwind 项目有摩擦。

功能覆盖面核实表（初稿说法逐项对账）：

| 功能 | 核实结果 |
|---|---|
| permissions | ✓ 完整闭环（Promise 队列 + 断连 reject-all） |
| plan | ✓ |
| files | ✓（FileTree + FileViewer，Monaco 为可选 peer） |
| diff | ~ 仅行级 +/- 渲染，非真正 diff 算法（简陋） |
| skills | ✓ 但走**非标准私有方法** `_acp/skills/list`（需 agent 配合） |
| settings | ✓ |
| workbench shell | ✓（三栏 Grid + 视图切换） |
| 会话管理 | ✓ 全 CRUD（含 fork、分页、认证） |
| **terminal** | **✗ 不存在**（只是文档里的扩展示例，无 xterm 依赖） |
| multi-agent / workspace / multi-session | ✓（见 5.4） |
| stdio / WebSocket / HTTP / custom transport | ✓（见 5.2） |

wire → 状态的转换层在 `provider.ts` 的 `setupSessionUpdateHandler`（含**每会话独立的 16ms 文本块 batching** 以减少流式重渲染）——这是它最值得读的一段代码。

与 assistant-ui **完全无关**（全仓零命中；UI 全自研）。

它对 Panda 最大的参考价值经核实依然成立：

> **完整 Workbench 应该如何分层，而不是 UI 应该长什么样。**

---

# 3. Panda 应该如何使用 assistant-ui（修订版）

## 3.1 复用清单（核实修正后）

**真正可以 standalone 复用的**（纯 props / 回调、零 runtime import）：

| Panda UI | 建议 |
|---|---|
| Composer 外壳 / 工具栏 / Attach 按钮 | 从 `composer.tsx`（约 660 行）拷贝或参照 |
| Attachment 芯片 | `ComposerAttachmentChip`（uploading/done/error 状态 + 进度 + 移除回调） |
| Message ActionBar | `message-actions.tsx`（copied / reaction / regenerating + 回调，纯 props） |
| ToolCall 面板 | `tool-call.tsx`（纯 props：label/query/request/result/running/open） |
| Reasoning 折叠面板 | `reasoning.tsx` 基础版（纯展示） |

**不可 standalone 复用（核实修正，从初稿清单中移除）**：

```text
auto-scroll                ← runtime 绑定（useThreadViewportAutoScroll）
scroll-to-bottom           ← runtime 绑定
Message shell / 消息列表    ← thread.aui.tsx 只吃内部 context
Keyboard interaction       ← 多行 Enter/Shift+Enter 在 runtime primitive；
                             standalone ComposerInput 是单行 <input>
attachment 预览 Dialog      ← 依赖 Base UI/Radix ui 组件
```

**Panda 现状对照（核实）**：auto-scroll / scroll-to-bottom / 虚拟化 / 多行 composer 键盘逻辑 **Panda 已经自研完成且带测试**——MessageStream.tsx（339 行）处理了用户滚动 detach 窗口与 Virtuoso recalc 协调，Composer.tsx（189 行）含完整输入逻辑。也就是说：不能复用的部分恰好是已经造好的部分，能复用的部分才是真正的增量收益。

## 3.2 Panda 自己保留的 UI

以下 UI 与 ACP 语义高度相关，建议 Panda 自己掌控：

```text
ToolCall
Permission
Plan
Mode
Config
Terminal
Filesystem
Diff
Resource
ACP Capability UI
Agent / Session Lifecycle UI
```

尤其不要为了复用 assistant-ui，把这些强行塞成普通 MessagePart。

## 3.3 推荐使用方式（修订版）

第一阶段：

```text
Panda State（zustand）
    ↓ props / 回调
assistant-ui Elements（叶子组件，copy-paste 源码）
```

- 从 `https://r.assistant-ui.com` registry（或直接从 `packages/ui/src/.../elements/` 目录）取出上表的叶子组件 + `surfaces.tsx` 设计令牌，接到 Panda 自己的 store 上。
- 成本：tailwind 类名与 Panda 主题对齐、`lucide-react` 图标、`cn`（clsx + tailwind-merge）工具。
- standalone `ComposerInput` 是单行 input——**Panda 保留自己的多行输入与键盘逻辑**。
- 维护成本提示：copy-paste 源码没有 npm 版本可跟，升级走 CLI update——**拷的文件越少越好**，只挑真正省力的。

**明确不做（核实后确定的边界）**：不引 `AssistantRuntimeProvider`、不用 `useExternalStoreRuntime` 接管消息区。理由：

1. ThreadViewport 自带一整套 scroll-anchor 自动滚动体系（turnAnchor / rAF / isAtBottom 状态机），**与 react-virtuoso 无集成路径**，两套滚动/锚定系统会互相打架——Panda 已含自动滚动 + 虚拟化 + 测试的消息流会被迫二选一。
2. 仓库无任何 ACP 支持，ACP 事件流 → runtime 的桥接层完全自担（参照 `react-opencode` 适配器的量级）。

---

# 4. react-acp 对 Panda 最有价值的部分（核实版）

## 4.1 第一优先级：永远不要丢 ACP 原始数据——采用「归属制」保存

这是 Panda 当前最需要修正的架构问题。

Panda 当前 `src/acp/wire.ts` 会跳过部分暂未支持的数据（已核实）：

```text
audio / resource content block（wire.ts:41，返回 null）
terminal tool content（wire.ts:62）
tool_call_update 的 kind / rawInput / rawOutput（wire.ts:92-101）
default 分支的所有未知 sessionUpdate（wire.ts:142-144）
  含 current_mode_update / compaction_* / available_commands_update …
```

当前逻辑：`unsupported → console.warn → skip`。对 Universal ACP Client 不合适，因为 wire 层一旦丢掉协议数据，后续 UI 即使增加支持也无法恢复。

**核实修正——推荐改法从初稿的「全量 {normalized, raw}」升级为 react-acp 已验证的归属制模型**（内存有界、同样不丢数据）：

```text
三层归属 + 一个桶
├── 消息级：每条消息持有 rawNotifications
│          （归它所有的全部通知，含 text/image chunk）
├── 工具级：每个 tool call 持有 rawNotifications
├── 会话级：latestNotifications 按 sessionUpdate kind 只存最新一条
│          （plan / usage / mode / config / commands / session_info）
└── 未知 update：进消息流的 unsupported piece
             + 会话的 unhandledNotifications 列表
```

react-acp 明确**不做**无限增长的全量 raw 日志（docs/architecture.md 明文「session 不再维护无限增长的全量 raw log」）——这同时回答了初稿遗留的内存成本问题。

原则不变：

> **Unsupported ≠ Dropped**

## 4.2 借鉴 protocol-authoritative state（核实：属实，Panda 基础正确）

react-acp 的核心思想：**ACP session state 是事实源，UI 只是 projection。**

Panda 当前已有不错的基础（已核实）：`ACP event → pure reducer → SessionDocument`，这个方向保留。

状态结构演进方向不变（connections / sessions / activeSessionId / uiState），补充一个可直接对照的资产：react-acp 的 `AcpStateEvent` 事件分类法——

```text
connection.*
session.attached / loading / restored / compacted
message.optimistic*（乐观消息 + echo 对账）
permission.requested / resolved
```

Panda 的 reducer 事件设计可以对照这份 taxonomy。

## 4.3 借鉴 Session Lifecycle（核实：属实，机制已确认）

Panda 当前 session/load 的风险（已核实）：`loadSessionInternal` 先触发 `onReplayStart()`（即 `resetDocument()`）再发 `session/load`（LiveAcpClient.ts:354-363），load 失败时旧 transcript 已丢；`connect()` 同样先 reset 再连（useLiveSession.ts:154）。

react-acp 的已验证机制（`performAttach`）：

```text
取快照（当前 session state ?? 空状态）
   ↓
session.loading + clearHistory: !useResume
   （load 清重放区但保留 info；resume 不清历史）
   ↓
session/load
   ├── success → commit
   └── failure → session.restored（恢复快照 + error 状态），
                 active session 回退到 settledActiveSessionId
```

附加纪律：未挂载会话禁止 prompt；close 保留缓存历史、delete 才移除；重连后强制重新 load active session。

## 4.4 借鉴双 Generation 竞态防护（核实：属实）

react-acp 用两个递增计数器：

- **`connectionGeneration`**：Agent→Client handler 闭包捕获 generation，不匹配直接丢弃；initialize / auth 完成后二次校验（被超越则 close + "superseded" 错误）；所有异步结果（refreshSessions / createSession / attach）都校验。
- **`selectionGeneration`**：session 选择 latest-wins；delete / close 时自增以作废在途选择。

Panda 当前已有 connection identity 校验（LiveAcpClient.ts:151-155，`this.connection === connection`，方向正确）。需要补的是显式的 `selectionGeneration`（以及把 connection identity 升级为 generation 计数，支持同一条连接上的多次重连场景）。

## 4.5 扩展机制（核实修正：初稿提议的方向需要调整）

初稿提议 per-agent 注册表（`@panda/extension-codex` 等）。**核实后修正**：react-acp 刻意反其道而行——core 不内置任何厂商命名空间，机制是**单一可选接口 + 三个解释钩子**：

```ts
interface AcpRuntimeExtensionAdapter {
  sessionAccess?(context)   // 从 load/resume 响应的 _meta 解释读写权限
  messagePhase?(notification) // 按私有 _meta 给消息分段（如 Codex phase）
  messageState?(notification) // 从 opaque metadata 恢复 sentAt/finishedAt/status
}
```

厂商特化全部在**应用侧**（测试里 Codex / hafbit 的 `_meta` 都是应用注入的函数解释的）。

Panda 修正后的做法：**注册解释钩子，而非注册厂商适配器。** `if (agent === "codex")` 的坏味道判断不变；但解法不是 per-agent 包，而是 vendor-neutral 的钩子接口。

## 4.6 Permission 必须是集合（核实：属实，机制已确认）

Panda 当前（已核实）：store 是 `permission: PermissionRequest | null`；LiveAcpClient 对重叠的 request_permission **自动 cancel 旧的**（LiveAcpClient.ts:424-429）——对通用客户端这是有损行为。

react-acp 的已验证模型：

- reducer 内 `permissions: Record<toolCallId, {status: pending|resolved|cancelled, response}>`；
- controller 侧 `permissionWaiters: Map<sessionId:toolCallId, waiter>`——多个并发 request_permission 各自独立挂起；
- 乱序处理：权限先于 tool_call 到达时创建占位 tool 记录；
- 三条 settle 路径：用户答复 / request 自带 AbortSignal abort（自动 cancelled）/ disconnect / dispose / cancel（全量结算）。

注：Panda 现有代码在「disconnect / cancel 时 settle pending RPC」这一点上已经做对（`cleanupConnection → finishPermission(cancelled)`）；要改的是单例 → 集合。

## 4.7 新增：echo 对账（初稿遗漏，核实后发现）

Panda 的 `send()` 会本地先 echo 一条 user_message（LiveAcpClient.ts:280 注释自认）。如果 agent 也回显 `user_message_chunk`（ACP 允许），会出现双条用户消息。

react-acp 的解法是现成的：`PendingOutbound` + `echoRelation`（prefix / equal / different 三态）+ 独立的 `protocolMessageId`——内容相符则合并进本地乐观消息，不符则 flush 不合并，且**不伪造协议通知**。Panda 直接借鉴。

---

# 5. acp-components 对 Panda 最值得参考的部分（核实版）

## 5.1 Core 与 React 分离（核实：属实）

```text
@acp-components/core   ← zustand/vanilla + ACP SDK，零 React
        ↓
@acp-components/react  ← useStore 订阅同一批 vanilla store
```

Panda 值得走向同样的结构（协议逻辑不依赖 React、reducer 独立测试、Desktop/Web/IDE 复用），且两者技术栈重合（zustand + react-virtuoso），迁移心智成本低。

**依赖决策（核实后）**：暂不把 `@acp-components/core` 作为依赖引入——0.1.0 无稳定 API 承诺、单维护者、squashed 历史。若未来引入，锁精确版本并保持 fork-ready。当前阶段以借鉴其源码为主（`provider.ts` 的 wire→store 分发与 16ms batching、多 agent 编排、孤儿会话清理都可直接参照）。

## 5.2 Transport abstraction（核实：属实，Panda 起点比初稿写的好）

acp-components 的接口（4 个成员）：

```ts
interface AcpTransport {
  connect(): Promise<Stream>
  disconnect(): void
  onClose?(handler): () => void
  onError?(handler): () => void
}
```

四个实现：`stdio`（配置是纯数据 command/args，spawn 能力由宿主注入 `StdioTransportFactory`，未注入时 **fail-fast 抛错**）、`http`（SDK experimental http-client，Streamable HTTP）、`websocket`（浏览器原生 + NDJSON）、`custom`。浏览器连接拓扑参考：examples/server 的 WS↔stdio 桥 + HTTP 文件 API + SSE watch（安全性粗糙——CORS `*` 无鉴权——须自加固）。

**Panda 侧核实补充**：`LiveAcpClient.connect` 本就接受注入的 `Stream`，client 层已经是 transport-agnostic 的。真正的差距只有两点：把这个 seam 命名成显式的 `AcpTransport` 接口、以及让 `useLiveSession` 不再在调用点直接 `createBrowserWebSocketStream`（useLiveSession.ts:170）。

**落地（issue #20）**：`src/acp/transport/` 下 `AcpTransport`（4 成员接口）+ `WebSocketTransport`（包装 `browserWebSocketStream`，close/error 经流的 `closed` promise 观察——不偷读连接消费的流）+ `StreamTransport`（既有流的包装，测试 seam，也是未来 stdio 的形状）。`LiveAcpClient.connect` 改收 `AcpTransport` 实例：流的获取移入 try（传输级失败按“连接失败”上报）、cleanup 显式 `transport.disconnect()`；`useLiveSession` 注入 `new WebSocketTransport(url)`。stdio / Tauri / HTTP 实现留待各自宿主立项。

## 5.3 Host capability 与 ACP capability 分离（核实修正：初稿高估了 acp-components）

**核实结论：acp-components 并没有这层。** agent 的 `agentCapabilities` 从 initialize 响应直接存入、直接信任，唯一用途是功能性门控；没有与宿主授权清单比对的 policy 层。实际存在的是：

- **Platform 能力分片**（`fs? / dialogs? / clipboard? / storage / process? / menu?` 按 slice 存在性表达，与 AcpContext 刻意正交——「把文件等高风险能力留在宿主侧治理」）；
- **`setPermissionHandler` 覆盖点**（宿主可插入自己的审批实现——这正是 policy 该插的位置）；
- **一个危险默认**：未设 handler 时 `AcpClient.handlePermission` **自动选第一个选项放行**（AcpClient.ts:282-289）。

因此方向修正：这不是「从 acp-components 借鉴」，而是 **Panda 必须自建 acp-components 缺失的东西**：

```text
Agent Capabilities
        +
Host Capabilities（Platform 分片）
        +
Policy
        ↓
Effective Capability
```

并多了一条反面纪律：**默认自动放行绝不能进 Panda**——Panda 的默认必须是拒绝（或至少显式要求用户决定）。

## 5.4 Multi-Agent / Workspace model（核实：属实）

acp-components 的模型（acpStore）：

```text
agents: Map<agentId, AgentConnection>     ← 多 agent 连接
workspaces: Map<cwd, WorkspaceState>      ← key 就是 cwd 字符串
activeSessionId: SessionId | null          ← 全局唯一活跃会话
```

- `SessionMeta = { id, title?, cwd, updatedAt?, agentId, loaded }`——会话属于 (cwd, agentId) 二元组；
- 没有独立的 activeWorkspace：由 activeSessionId 反查（避免冗余状态）；
- `createAcpProvider` 并行连接所有 agent，运行时 addAgent / removeAgent（removeAgent 做孤儿会话清理）。

初稿的忠告经核实成立且应加强：**workspace 严格绑定 cwd 是 coding-agent 世界观**（workspaces 以 cwd 为 key、per-cwd file tree/watcher、`listSessions(cwd)`）。Panda 的目标包含不落地的 Agent 类型，应把 Workspace 抽象为可选 context（local-directory / remote-repository / project / dataset / none）。

**这个 multi-agent 模型是 Panda 决定支持多连接的直接参考依据**（见第 10 节与 ADR 0002）。

---

# 6. Panda 当前架构的优点（核实版）

## 6.1 Pure reducer

`protocol/reducer.ts`：纯函数、无框架 import、确定性、可重放、可测试（已核实）。继续保持。

## 6.2 Store 不自己发明 protocol document

「所有文档变更走 `applyUpdate()`」基本属实（已核实），有一个已知的例外：`setStatus` 直接 patch `doc.status`（store.ts:121）。这是 v1 语义合成的刻意 seam（客户端自驱 running → requires_action → idle），可接受，但应记录在案——ACP v2 的 state_update 通知到来时，这里是替换点。不要让例外扩散。

## 6.3 ACP Client 已经和 UI 初步解耦（核实：比初稿写的更好）

已存在 `LiveAcpClient / wire / reducer / store / components` 分层，且两个额外事实：

- `LiveAcpClient` 接受**注入的 Stream**（transport-agnostic）；
- `LiveAcpClient` 是**实例级**的（一条连接 + 自有 pendingPrompt / pendingPermission / connection identity）。

后者意味着：**多连接 = 多实例，客户端类几乎不用改**——多 agent 改造的真实成本集中在 store 的全局单例上。下一步是强化这些 seam，而不是推翻重写。

---

# 7. Panda 当前最重要的问题

## P0-1：wire.ts 在替 UI 决定什么数据值得存在（已核实）

当前 pipeline：

```text
ACP
 ↓
wire.ts
 ↓
只留下 Panda 当前会渲染的数据
 ↓
reducer
```

应该改成：

```text
ACP
 ↓
protocol ingestion（归属制保存，见 4.1）
 ↓
normalization
 ↓
projection
 ↓
UI
```

核心原则：**Protocol ingestion 不应该等于 rendering filter。**

## P0-2：Domain State 与 UI Projection 还没有完全分开

三层模型（Wire Model / Domain State / UI Projection）的建议不变。现状佐证：`SessionDocument` 的 turns/blocks 已经是偏 UI 的形状，这是一个可接受的中途态，但要在引入 raw 归属制时把「协议事实」与「渲染形状」显式分层。

---

# 8. 推荐目标架构

（不变）

```text
                        Panda App
                           │
              ┌────────────┴────────────┐
              │                         │
          Panda UI                  Host Services
              │                         │
    ┌─────────┼─────────┐       ┌──────┼────────┐
    │         │         │       │      │        │
 Message    Plan     ToolCall    FS   Terminal Storage
    │         │         │
    └─────────┼─────────┘
              │
        UI Projection Layer
              │
              ▼
       Panda ACP Domain State
              │
        Pure Reducer / Store
              │
     ┌────────┼───────────┐
     │        │           │
 Lifecycle Extension   Capabilities
     │        │           │
     └────────┼───────────┘
              │
          ACP Client（实例级，一连接一实例）
              │
       Transport Abstraction（AcpTransport）
              │
      ┌───────┼─────────┐
      │       │         │
     WS     stdio     custom
      │       │         │
      └───────┼─────────┘
              ▼
           ACP Agent（可多个，并行连接）
```

---

# 9. 推荐代码层次

（不变）

```text
src/
├── acp/
│   ├── client/
│   ├── transport/
│   ├── protocol/
│   ├── extensions/
│   └── capabilities/
│
├── domain/
│   ├── session/
│   ├── agent/
│   ├── workspace/
│   └── reducer/
│
├── runtime/
│   ├── store/
│   ├── lifecycle/
│   └── projector/
│
├── host/
│   ├── filesystem/
│   ├── terminal/
│   ├── storage/
│   └── permissions/
│
└── ui/
    ├── assistant-ui/     ← 拷贝来的叶子组件
    ├── message/
    ├── tools/
    ├── plan/
    ├── permissions/
    ├── terminal/
    └── workspace/
```

不急于 package 化；边界先在目录层面站稳。

---

# 10. 实施优先级（修订版）

## P0：马上做（与多连接无关，单连接下就有收益）

1. **raw 归属制保存**（4.1 的三层归属 + unhandledNotifications 桶）
2. **unsupported fallback UI**（渲染 "Unsupported ACP Event" 也比静默 drop 正确）
3. **echo 对账**（4.7，Panda 已有本地 echo，差对账逻辑）

## P1：通用 ACP Client 基础（多连接的前置条件）

4. **store 按 (connectionId, sessionId) 分键**——不再只有一个全局 current SessionDocument / connection / permission
5. **事务性 session 切换**（快照 / load / commit / rollback）
6. **connectionGeneration + selectionGeneration**
7. **Permission 单例 → 集合**（waiter Map 与 reducer 记录分离）
8. **transport seam 命名化**（AcpTransport 接口 + WebSocket 实现；调用点注入）

## P2：产品能力扩展

9. **放开多连接（ADR 0002）**——多 LiveAcpClient 实例 + keyed store + 连接管理器；前台会话 + 后台连接接收通知
10. **Capability-driven UI**（Agent 声明 × Host 授权 → Effective Capability）
11. **Workspace 抽象**（不绑死 cwd）
12. **UI Projection Layer** 与 React 渲染解耦

---

# 11. 明确的「用 / 学 / 不抄」清单（核实修订版）

## assistant-ui

### 用（standalone、copy-paste）

```text
Composer 外壳 / 工具栏
Attachment 芯片
ActionBar 行
ToolCall 面板（纯 props 版）
Reasoning 折叠面板（基础版）
```

### 不再用（核实修正：runtime 绑定，且 Panda 已自研完成）

```text
auto-scroll / scroll-to-bottom
消息列表外壳
多行键盘交互
```

### 不应该让它接管

```text
Panda ACP truth
ACP lifecycle
ACP capability model
ACP extensions
整个 Panda domain model
AssistantRuntimeProvider / useExternalStoreRuntime
```

## react-acp

### 学 / 可以移植思想（全部已核实存在）

```text
pure reducer + AcpStateEvent taxonomy
protocol-authoritative state
raw 归属制保存
unsupported fallback（三层）
事务性 load（快照 + rollback + settledActiveSessionId）
双 generation 竞态防护
vendor-neutral 解释钩子（非 per-agent 注册表）
权限集合生命周期（并发 + 乱序 + 三条 settle 路径）
echo 对账（PendingOutbound / echoRelation）
compactInactiveSessions 内存控制
能力门控纪律
```

### 暂时不用

```text
assistant-ui-specific projector（ThreadMessageLike 投影）
手写 external store（Panda 用 zustand 天然覆盖）
```

## acp-components

### 学

```text
core / React 分离（vanilla zustand store）
transport 抽象（4 成员接口 + stdio 宿主注入 fail-fast）
multi-agent 状态模型（agents Map + 全局 activeSessionId + 孤儿清理）
wire→store 分发 + 每会话 16ms batching
Platform 能力分片（与 AcpContext 正交）
权限 Promise 队列 + 断连 reject-all
activeSessionId 反查 workspace（不维护冗余状态）
```

### 不要照搬

```text
coding-agent-first 世界观（workspace == cwd）
完整 UI 产品形态（SCSS token 体系与 tailwind 有摩擦）
把 Files / Diff / Terminal 当所有 Agent 的默认中心
（terminal 它根本没有；diff 只是行级 +/-）
默认自动放行第一个权限选项（危险默认，Panda 必须反着来）
```

### 暂不引依赖

```text
@acp-components/core：0.1.0 无稳定承诺 + 单维护者
——借鉴源码为主；若引入，锁精确版本 + fork-ready
```

---

# 12. Panda 的最终产品边界

（不变）

```text
             Agent Factory
                  │
       Create / Configure / Package
                  │
          ┌───────┼───────┐
          ▼       ▼       ▼
       Agent A  Agent B  Agent C
          │       │       │
          └────── ACP ────┘
                  │
                  ▼
                Panda
         Universal Agent UI
```

Agent Factory 是 Control Plane（create / configure / version / package / deploy / registry）；Panda 是 Interactive Data Plane（connect / session / prompt / stream / tool / permission / plan / config / usage）。正常聊天流量不经过 Factory API 代理。

---

# 13. 最终建议

Panda 不应该追求「所有东西都自己实现」，也不应该「找一个现成 UI 框架把 Panda 套进去」。正确路线：

```text
成熟基础设施 → 复用（assistant-ui 叶子组件，copy-paste）
协议状态机经验 → 借鉴（react-acp 已验证机制，逐条照搬）
ACP 核心语义 → 自己掌握
产品体验 → 自己定义
```

## Panda 自己造的

```text
ACP-first domain model
ACP lifecycle
capability model（含 acp-components 缺失的 host policy 层）
extensions（vendor-neutral 解释钩子）
Host boundary
Workbench product experience
```

## Panda 不需要自己造的

```text
Composer / Attachment 芯片 / ActionBar 的样式与交互细节
（从 assistant-ui Elements 拷叶子组件）
```

（核实修正：初稿此清单里的 textarea / auto-scroll / keyboard handling Panda 实际已经造好了，而且是带测试的——继续用。）

## Panda 最值得立即修正的

```text
wire.ts 的「unsupported → warn → skip」→ 归属制 raw 保存
```

这件事的优先级高于继续增加更多 UI feature。

---

# 14. 一句话架构原则

> **Panda 应该是 ACP-native，而不是 UI-framework-native。**

UI 可以大胆复用成熟组件（但只有叶子级值得拿）。协议、状态和生命周期必须牢牢掌握在 Panda 自己手里。

---

# 15. 与 ADR 的关系

- **ADR 0001（Agent 配置采用单活跃连接）**：其中「多连接并行明确排除出 Phase 3」的决定被本核实结论推翻——依据见 6.3（LiveAcpClient 已是实例级）与 5.4（acp-components 的多 agent 模型验证）。由 **`docs/adr/0002-multi-agent-parallel-connections.md`** 取代。0001 的其余内容（会话历史按端点记忆、与配置条目解耦）继续有效。
