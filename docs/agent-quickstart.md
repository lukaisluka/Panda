# 给你的 agent 一个 UI:Panda 接入快速上手

从零写一个最小 ACP agent,接到 Panda 桌面版上,得到一个带流式回复、工具卡与审批卡的完整会话界面。全程不需要写任何前端代码。

> 英文版:[agent-quickstart.en.md](agent-quickstart.en.md)。中文版为事实源,两版需同步更新。
> 接入的完整规则(必须/推荐/按需三档、超时预算)见 [ACP agent 接入契约](acp-agent-requirements.md);本文只带你走最短路径。

## 前提

- Node 20+(本教程代码在 Node 24 + `@agentclientprotocol/sdk` 1.4.0 实测通过)
- Panda 桌面版(macOS / Windows,beta)—— stdio 直连是桌面版独有能力,见[使用指南](user-guide.md)

## 第 1 步:起项目

```sh
mkdir hello-agent && cd hello-agent
npm init -y
npm install @agentclientprotocol/sdk@^1.4.0
```

## 第 2 步:写一个最小 agent

新建 `agent.mjs`,全文如下——**三个请求 + 一个通知出口**,这就是接入门槛的全部:

```js
// agent.mjs —— 最小 ACP agent
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const connection = new AgentSideConnection(
  (conn) => ({
    // ① 握手:回协议版本(必须回 1)与 agent 信息
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {}, // 会话列表/历史等能力先都不声明 → Panda 可见降级
      agentInfo: { name: 'hello-agent', title: 'Hello Agent' },
    }),

    // ② 建会话:回一个唯一 id
    newSession: () => ({ sessionId: randomUUID() }),

    // ③ 回合:推 session/update 通知,结束时回 stopReason
    prompt: async ({ sessionId, prompt }) => {
      const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `你说:「${text}」——这条消息流就是你 agent 的 UI。` },
        },
      });
      return { stopReason: 'end_turn' };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
// 构造即开始服务;持有引用防回收,进程随 stdin 关闭退出
void connection;
```

注意 `ndJsonStream(...stdout..., ...stdin...)` 的方向:**stdout 是协议通道**,日志一律写 `stderr`,否则会污染协议流。

## 第 3 步:让 Panda 连上它

打开 Panda 桌面版 → 设置 → Agent profiles → 新建:

- 连接类型:**stdio**
- 命令:`node`
- 参数:`/绝对路径/hello-agent/agent.mjs`(图形环境启动的 PATH 可能与终端不同,建议绝对路径)
- 工作目录:随便填(本例不读文件)

保存后在侧栏点击该 profile 连接。Panda 会拉起这个进程、握手、建会话——状态栏出现 **Ready** 就通了。

## 第 4 步:聊一句

发送「你好」。你会看到:流式回复出现在消息流里;侧栏只有当前会话(没声明 `sessionCapabilities.list`/`loadSession`,Panda 可见降级,不假装有历史)。

这就是能力门控的工作方式:**你声明什么,界面就亮什么;没声明的,诚实降级。**

## 第 5 步:点亮工具卡与审批卡

把 `prompt` 实现替换成下面这段——一个带 diff 的工具卡,加一次真正交给用户的审批:

```js
    prompt: async ({ sessionId, prompt }) => {
      const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const toolCallId = randomUUID();

      // 工具卡:先推 pending(diff 随 start 送达)
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          kind: 'edit',
          status: 'pending',
          title: 'Edit `greeting.txt`',
          locations: [{ path: 'greeting.txt' }],
          rawInput: { file_path: 'greeting.txt', new_text: text },
          content: [{ type: 'diff', path: 'greeting.txt', oldText: '', newText: text }],
        },
      });

      // 审批卡:把决定权交给用户(Panda 呈现 Allow / Reject)
      const decision = await conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId,
          title: '写入 greeting.txt',
          rawInput: { file_path: 'greeting.txt', new_text: text },
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const allowed =
        decision.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow';

      // 工具卡必须推到终态(漏发会永远挂在「运行中」)
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: allowed ? 'completed' : 'cancelled',
        },
      });

      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: allowed ? '已写入 greeting.txt。' : '你拒绝了写入,未改动文件。' },
        },
      });
      return { stopReason: 'end_turn' };
    },
```

再发一条消息:消息流里先出现一张带语法高亮 diff 的编辑卡,随后是一张审批卡——点 Allow 或 Reject,agent 沿不同分支收尾,工具卡随之变为完成/取消。

## 加码:每多发一种 update,界面多亮一块

| 想要的界面 | 发什么 |
| --- | --- |
| 思考流(可折叠推理过程) | `agent_thought_chunk`(text 内容块,增量推送) |
| 计划坞(任务清单与进度) | `plan`(entries 带 content/status) |
| 状态栏上下文用量 | `usage_update`(`used`/`size` 对,不是累计量) |
| 侧栏会话标题 | `session_info_update`(`title`;首条用户消息生成标题是零成本的好做法) |
| 收图片 | `initialize` 声明 `promptCapabilities.image: true`,`session/prompt` 就会出现 image 内容块 |

各 update 的字段细节、推荐实现按体验损失的排序、超时预算,见 [ACP agent 接入契约](acp-agent-requirements.md);全量参考实现(session 持久化、elicitation、模式、压缩、用量……)见 [`test-agent/src/agentServer.ts`](../test-agent/src/agentServer.ts)。

## 网页版怎么办

网页版不拉起本地进程,需要把 stdio agent 桥接成 WebSocket——配方见 [stdio agent 桥接 WebSocket](acp-stdio-to-websocket.md)。开发阶段用桌面版直连最顺手。

## 常见坑

- **日志写 stdout 会炸协议**——stdio 模式下 stdout 只属于 NDJSON 协议流,日志一律 `console.error`(stderr)。
- **`protocolVersion` 必须回 `1`(数值)**——回别的值 Panda 立即断连报「协议版本不匹配」。
- **工具卡必须推终态**——`tool_call_update` 把 status 推到 `completed`/`failed`/`cancelled`,漏发则卡片永远停在「运行中」。
- **取消要响应**——用户点停止时 Panda 发 `session/cancel` 通知;最小版不处理也能跑,但回合会跑到自然结束(契约 §2.5)。

---

*本教程的两段示例代码在干净目录、Node 24 + SDK 1.4.0 下实测通过完整链路(initialize → session/new → session/prompt → session/update → stopReason,审批 allow/reject 两个分支)。*
