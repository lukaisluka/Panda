# Panda 客户端的 Agent 接入契约(ACP v1)

面向想让 Panda 正常工作的 ACP agent 实现者:哪些接口是接入门槛,哪些强烈推荐,以及缺失各自的代价是什么。

> 英文版:[acp-agent-requirements.en.md](acp-agent-requirements.en.md)。中文版为事实源,两版需同步更新。

- 协议版本:**ACP v1**(`protocolVersion: 1`,SDK `@agentclientprotocol/sdk` 1.4.0)。
- 代码事实源(本文据其整理而成,如有出入以代码为准):
  - 连接与全部 RPC 调用:[`src/acp/LiveAcpClient.ts`](../src/acp/LiveAcpClient.ts)
  - `session/update` 解析与宽容契约:[`src/acp/wire.ts`](../src/acp/wire.ts)
  - 能力组合判定:[`src/capabilities.ts`](../src/capabilities.ts)
  - 全量参考实现:[`test-agent/src/agentServer.ts`](../test-agent/src/agentServer.ts)

**等级用语**(全文统一,只此三档):

| 用语 | 含义 | 所在 |
| --- | --- | --- |
| **必须** | 接入门槛:缺失即客户端不可用或该功能死 | §2、§3 |
| **推荐** | 不做也能跑,但有明确的用户可感代价;按损失分三个梯队 | §5 |
| **按需** | agent 具备相应能力时才适用(归入第三梯队) | §5.3 |

## 0. 一览

接入的最小面:

| 方向 | 方法 | 级别 |
| --- | --- | --- |
| Client→Agent 请求 | `initialize`、`session/new`、`session/prompt` | 必须 |
| Agent→Client 通知 | `session/update`(最低:`agent_message_chunk` 文本块) | 必须 |
| Client→Agent 通知 | `session/cancel` | 应当(推荐第一梯队) |
| Agent→Client 请求 | `session/request_permission`、`elicitation/create` | 按需;Panda 恒定应答,要用即可调 |
| Agent→Client 通知 | `elicitation/complete` | 按需(url 模式完结信号) |

两条贯穿全文的硬事实:

1. **红线**:Panda 只应答四个 client 侧方法(§3),`fs/*` 与 `terminal/*` 一律 `-32601 Method not found`——从 Zed 等环境移植的 agent 不能假设客户端提供文件/终端执行面。
2. **第一梯队的共性**:会话持久化、会话列表、回合可见性、取消这四项,Panda 没有任何客户端侧替代通道——agent 不给,就真的没有(§5.1)。

## 1. 传输与报文框架

Panda 是纯协议客户端:从不拉起 agent 进程,只连接已在运行的服务(桌面壳的 stdio 进程平面是宿主行为,不是协议要求)。两种线上形态,消息体都是标准 JSON-RPC 2.0:

- **WebSocket**:每个文本帧恰好一条 JSON-RPC 消息(不是行分隔)。
- **stdio(桌面壳)**:行分隔 JSON,每行一条消息。

## 2. 接入门槛:最低必须集

### 2.1 `initialize` —— 握手

Panda 建连后的第一个请求,固定为:

```jsonc
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "elicitation": { "form": {}, "url": {} },
    "session": { "configOptions": { "boolean": {} }, "compaction": {} },
    "plan": {}
  },
  "clientInfo": { "name": "panda", "title": "Panda", "version": "0.1.0" }
}
```

响应必须满足:

1. **`protocolVersion` 必须回 `1`(数值硬相等)。** 回任何其他值,客户端立即报「协议版本不匹配」并断连——不支持 v1 就接不上。
2. `agentInfo`:至少 `name`;显示名取 `title ?? name`,都没有则显示 "unknown agent"。
3. `agentCapabilities`:字段缺省即不支持;**声明即承诺有对应 handler,不得虚假声明**。`sessionCapabilities.*` 的判定是「字段存在」——空对象 `{}` 就算声明。
4. `authMethods`(可选):agent 托管登录方式;`type: "terminal"` 的条目会被过滤丢弃(web 宿主跑不了 TUI)并打 warn。

握手通过后,客户端按能力建立会话:`session/resume`(优先)→ `session/load`(回退)→ `session/new`(兜底)。

### 2.2 `session/new`

- 请求必带 `{ cwd, mcpServers: [] }`。`mcpServers` 字段**总会存在**(可能是空数组)——至少要容忍;接收即合规,连不连是 agent 自己的事。
- 响应最小:`{ sessionId }`。可选 `modes` / `configOptions`——返回了才解锁相应功能(§5)。
- 需要登录的 agent 可以用 `-32000 auth_required` 拒绝,前提是 `initialize` 声明过 `authMethods`(§5.3)。

### 2.3 `session/prompt` —— 回合主循环

- 请求:`{ sessionId, prompt: ContentBlock[] }`。内容块只可能是 `text` 与 `image`,且 `image` 仅在声明 `promptCapabilities.image: true` 后才会出现(未声明时客户端在本地就拒绝图片,不会到线上)。
- **整个回合期间 RPC 保持 pending**:边执行边推 `session/update` 通知,结束时才响应 `{ stopReason }`。
- `stopReason` 枚举:`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`。除 `end_turn` 外,每一个都会作为用户可见的回合结束提示呈现。
- 响应中的 `usage`(UNSTABLE)被客户端忽略——上下文占用请走 `usage_update` 通知(`used`/`size` 对,不是累计量)。

### 2.4 `session/update` —— 输出通道

- **能对话的最低线**:回合中至少推 `agent_message_chunk`(text 内容块)。
- **应当**推 `user_message_chunk` 回显用户消息:客户端有乐观 echo + 对账机制,agent 不回显也能渲染,但回显是「agent 究竟收到了什么」的追溯通道。
- 每条通知**必须带正确的 `sessionId`**:客户端按会话过滤,错会话的 update 被响亮丢弃(唯一例外:客户端自己的会话尚未建立时放行,供 `session/load` 回放)。
- 种类消费表与内容块边界见 §4;未知种类不会丢——以 unsupported 事件保留并 warn(向前兼容,vendor 扩展安全)。

### 2.5 `session/cancel` —— 取消(应当)

客户端取消按钮发出的是通知。收到后应当:尽快停掉模型请求、中止进行中的工具调用、补发未发的 `session/update`、让挂着的 `session/prompt` 以 `stopReason: "cancelled"` 收尾。

不实现也能跑:客户端会把挂起的权限等待器自行答成 cancelled,UI 不会卡死;但取消本身失效——回合继续跑到自然结束。

## 3. 客户端回调面:agent 可调用的四个方法

Panda 注册的 client 侧 handler 全集:

| 方法 | 类型 | 用途 |
| --- | --- | --- |
| `session/request_permission` | 请求 | 工具执行审批 |
| `elicitation/create` | 请求 | 表单(form)/链接(url)征询,两种模式均已声明 |
| `session/update` | 通知 | 接收方向,见 §2.4 与 §4 |
| `elicitation/complete` | 通知 | url 模式的带外完成信号 |

**其余一切 client 侧方法——`fs/read_text_file`、`fs/write_text_file`、`terminal/*`——都是 `-32601 Method not found`。** 这是 v1 里 Panda 刻意不实现的分片(v2 已整体移除该执行面,替代路径是 client MCP server,见 `src/capabilities.ts` 的 host shard 设计)。

### 3.1 权限流行为契约(agent 视角)

- **并发合法**:多个 `session/request_permission` 可同时挂起,客户端按 `${sessionId}:${toolCallId}` 各自独立应答。
- **重发语义**:同一 key 重发时,旧请求先被答成 `cancelled` 再挂新的——不要假设旧请求还在等。
- **取消路径**:回合取消或断连时,所有挂起权限被统一答 `cancelled`;agent 也可以主动发 `$/cancel_request` 撤回不再需要的请求。
- **可能被自动应答**:客户端侧有 host policy 与会话内 `always` 记忆,agent 只会看到结果(`selected` / `cancelled`),无需感知是谁点的。
- 至少提供一个拒绝类 option——纯 allow 的权限卡让用户无法拒绝。

### 3.2 Elicitation 流行为契约

- `form` 与 `url` 两模式都已声明;发未声明的模式会被 `decline`(不会挂起)。
- **url 模式是两段式**:用户点「打开链接」时 RPC 即以 `accept` 结束;整个流程的完结靠 agent 回发 `elicitation/complete` 通知(按 `elicitationId` 匹配)。
- 会话建立前(无 `sessionId`)的 request-scoped elicitation 是 auth 阶段专用,渲染在登录卡片上。
- 表单字段支持 string / number / integer / boolean / multiselect(array);未知字段类型渲染为 inert 的 unsupported 行,不丢。

## 4. 报文细节:`session/update` 种类与内容块

### 4.1 种类消费表

| 处理方式 | 种类 |
| --- | --- |
| 流内渲染 | `user_message_chunk`(text/image)、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`plan_update`*、`plan_removed`、`compaction_update`、`compaction_summary_chunk`、`usage_update`、`current_mode_update`、`available_commands_update`、`config_option_update` |
| 会话级 latest 保留 | `session_info_update`(`title` / `updatedAt`,驱动侧栏) |
| 未知种类 | warn + 以 unsupported 事件保留(向前兼容) |

\* `plan_update` 为 UNSTABLE:`items` 变体进计划坞;`file` / `markdown` 变体降级为 unsupported 块。

### 4.2 内容块与工具内容的边界

- 内容块:`text` / `image` 渲染;`audio` / `resource` 等降级为 unsupported。
- 工具内容:`diff` 与 `content`(内含 text/image)渲染;`terminal` 等其余种类渲染为 unsupported 行。
- `tool_call` 的 `rawInput` / `rawOutput` 必须是 JSON 对象,非对象会被丢弃并 warn。
- **工具卡必须推到终态**:`tool_call_update` 把 status 推到 `completed` / `failed` / `cancelled`。漏发终态,卡片永久停在「运行中」(#75 修过的真实坑,e2e 已钉死每卡必有终态)。

## 5. 推荐实现:按体验损失分级

以下都不是接入门槛,但每一项缺失都有明确的用户可感代价。总表(实现面列同时充当 `initialize` 能力声明速查):

| # | 功能 | 实现面 | 缺失代价 | 梯队 |
| --- | --- | --- | --- | --- |
| 1 | 会话持久化 | `sessionCapabilities.resume` + `session/resume`;`loadSession: true` + `session/load` | 断线/重开丢全部历史,不能翻历史会话 | 一 |
| 2 | 会话列表 | `sessionCapabilities.list` + `session/list`(`nextCursor` 分页) | 侧栏找不到任何旧会话 | 一 |
| 3 | 回合可见性 | `agent_thought_chunk`;`tool_call`/`tool_call_update`(含终态) | 执行期黑箱,长回合像卡死 | 一 |
| 4 | 取消 | `session/cancel`(§2.5) | 跑飞的回合只能等它跑完或断线 | 一 |
| 5 | 会话元信息 | `session_info_update`(`title` / `updatedAt`) | 侧栏全是无题会话,相对时间是死的 | 二 |
| 6 | 图片输入 | `promptCapabilities.image: true` | UI 里永远发不了图 | 二 |
| 7 | 会话配置 | `configOptions` + `session/set_config_option` + `config_option_update` | 应用内改不了模型/开关 | 二 |
| 8 | 上下文水位 | `usage_update` | 压缩/截断对用户是突袭 | 二 |
| 9 | 会话删除 | `sessionCapabilities.delete` + `session/delete` | 会话列表只增不减 | 二 |
| 10 | 会话关闭 | `sessionCapabilities.close` + `session/close` | agent 运行态泄漏,直到进程重启 | 二 |
| 11 | 登录 | `authMethods` + `authenticate` + `logout` + `-32000` | 要登录却不声明:直接断连(事实上的必须) | 三 |
| 12 | 计划坞 | `plan` / `plan_update`(items 变体) | 计划性长任务无进度锚点 | 三 |
| 13 | 命令补全 | `available_commands_update` | 无斜杠命令自动补全 | 三 |
| 14 | 会话模式 | `modes` + `session/set_mode` + `current_mode_update` | 无模式切换器 | 三 |
| 15 | 上下文压缩 | `compaction_update` + `compaction_summary_chunk` | transcript 无解释地突变 | 三 |

### 5.1 第一梯队:核心体验明显残缺

**会话持久化(至少二选一,最佳两个都给)。** `resume` 与 `load` 侧重不同:resume 是重连优先路径(不回放、瞬接),load 是历史切换与重连回退(回放重建文档)。只给 resume:重连快,但不能翻历史会话;只给 load:能翻,但每次重连整段回放。语义边界:`close` 释放本连接运行态、保留持久化历史(之后 load 仍可用);`delete` 是抹除,之后 load 必须 Session not found。

**会话列表。** 侧栏的会话列表完全来自历次 `session/list`(端点记忆也是)。客户端会循环拉取 `nextCursor` 直到拉空——分页不是可选项,必须正确实现。

**回合可见性。** 只有消息块时,执行期是黑箱:thought 流驱动「思考中」的动态呈现,工具卡是执行进度的主要锚点,且每张卡必须推终态(§4.2)。

**取消。** 见 §2.5——不实现,用户对跑飞的回合毫无办法,只能断线(连带丢掉整条连接)。

### 5.2 第二梯队:日常使用有明确感知

**会话元信息。** 首条用户消息确定性生成标题是零额外模型成本的好做法(参考实现:`test-agent/src/sessionTitles.ts`);`updatedAt` 随回合推送,侧栏相对时间才是活的。

**图片输入。** 模型侧支持多模态却不声明,用户在 UI 里永远发不了图(客户端本地直接拒绝)。

**会话配置。** select 写不带 `type`;boolean 写显式带 `type: "boolean"`;响应应携带**全量**更新后的 `configOptions`(改一项可能影响其他项),并补发 `config_option_update` 通知——确认驱动 + 通知幂等的双路径是常态,e2e 钉过。

**上下文水位。** 状态栏的 `used`/`size` 对;长会话没有它,用户对压缩与截断毫无预期。

**会话删除 / 会话关闭。** delete 让列表可清理;close 让客户端在切换/断开时通知 agent 释放运行态——长驻服务缺了它,每次会话切换泄漏一份运行态,直到进程重启。

### 5.3 第三梯队:有对应能力才推荐

**登录(auth 四件套)。** agent 一旦需要登录,这就是事实上的必须:声明 `authMethods` 走登录卡 → `authenticate(methodId)`(期间可发 request-scoped url elicitation 走 OAuth)→ 成功后客户端自动重试建会话;什么都不声明却抛 `-32000`,客户端直接断连报错。`logout` 仅在声明 `auth.logout` 后可调。

**计划坞 / 命令补全 / 会话模式 / 上下文压缩。** 分别适用于:计划性长任务(多步重构、调研)、有稳定命令面(触发词、快捷动作)、有 ask/code 类模式概念、agent 自己做上下文压缩。模式切换与配置项同理:RPC 成功后补发 `current_mode_update` 通知,幂等落在同一状态。压缩必须报告——不报告的话 transcript 无解释地突变,用户无法区分「agent 压缩了」和「agent 丢了历史」。

## 6. 时序与超时约束

| 项 | 预算 | 超时后果 |
| --- | --- | --- |
| 控制面 RPC:`initialize`、`session/new`、`session/load`、`session/list`、`session/resume`、`session/delete`、`session/set_mode`、`session/set_config_option`、`logout` | **30 s**(`CONTROL_REQUEST_TIMEOUT_MS`) | 判定 agent 挂死,整条连接拆除 |
| `session/prompt` | 不限时 | 回合跑多久算多久,用户用取消兜底 |
| `authenticate` | 不限时 | OAuth 等用户带外操作 |
| `session/close` | 1.5 s(客户端侧竞速) | 客户端直接断线 |

时序建议:

- **生命周期伴生通知放在对应 RPC response 之后发**(如 `session/new` 后的 `available_commands_update`):response 前客户端尚未 adopt 该 `sessionId`,虽然放行但顺序不可依赖;参考实现用 after-response helper 钉住这个姿势。
- **`session/load` 的历史回放通知在 load 响应之前流式发**:客户端在发请求前就把路由切到目标会话(stage→commit 事务),响应前的回放正好落在暂存文档上,响应即提交。
- 会话内通知全程必须带同一 `sessionId`(重连 resume 后同样)。

## 7. 非目标:双方都不走的方法面

Panda 从不发出:`document/didOpen|didChange|didClose|didSave|didFocus`、`nes/*`、`providers/*`(UNSTABLE)、`session/fork`(UNSTABLE,客户端未接)。实现与否不影响接入。

Panda 恒定不实现(重申 §3 红线):`fs/*`、`terminal/*`——调用即 `-32601`。

## 8. 验证通道

- **全量参考实现**:`test-agent/`(自研 ACP 壳:session 四件套、elicitation 双模式、compaction、plan、usage、commands、mode 通知、auth 全部落地),`pnpm --filter panda-test-agent serve` 起服务。
- **第三方兼容基线**:Claude Code 契约测试(#154/#156):`src/acp/claudeCodeContract.test.ts` 回放真实报文 fixture 进 CI;`PANDA_CLAUDE_CODE_E2E=1` 真连。
- **客户端行为单测**:`src/acp/LiveAcpClient.test.ts`、`src/acp/wire.test.ts`。
