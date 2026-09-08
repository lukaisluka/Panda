# A UI for your agent: a Panda quickstart

Write a minimal ACP agent from scratch, connect it to the Panda desktop app, and get a full conversation UI — streaming replies, tool cards, and permission prompts. No frontend code involved.

> Chinese (source of truth): [agent-quickstart.md](agent-quickstart.md). Both versions must stay in sync.
> The complete integration rules (must/recommended/optional tiers, timeout budgets) live in the [agent integration contract](acp-agent-requirements.en.md); this page only walks the shortest path.

## Prerequisites

- Node 20+ (the sample code was verified on Node 24 + `@agentclientprotocol/sdk` 1.4.0)
- The Panda desktop app (macOS / Windows, beta) — direct stdio connections are desktop-only; see the [user guide](user-guide.md) (Chinese)

## Step 1: start a project

```sh
mkdir hello-agent && cd hello-agent
npm init -y
npm install @agentclientprotocol/sdk@^1.4.0
```

## Step 2: write a minimal agent

Create `agent.mjs` with the following content — **three requests plus one notification outlet**; that is the entire integration bar:

```js
// agent.mjs — a minimal ACP agent
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const connection = new AgentSideConnection(
  (conn) => ({
    // ① Handshake: return the protocol version (must be 1) and agent info
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {}, // declare nothing yet → Panda degrades visibly
      agentInfo: { name: 'hello-agent', title: 'Hello Agent' },
    }),

    // ② New session: return a unique id
    newSession: () => ({ sessionId: randomUUID() }),

    // ③ Turn: push session/update notifications, end with stopReason
    prompt: async ({ sessionId, prompt }) => {
      const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `You said: "${text}" — this message stream is your agent's UI.` },
        },
      });
      return { stopReason: 'end_turn' };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
// The connection starts serving on construction; hold a reference so it is
// not collected. The process exits when stdin closes.
void connection;
```

Note the argument order of `ndJsonStream(...stdout..., ...stdin...)`: **stdout is the protocol channel**. Log to `stderr` only, or you will corrupt the protocol stream.

## Step 3: connect Panda to it

Open the Panda desktop app → Settings → Agent profiles → New:

- Connection type: **stdio**
- Command: `node`
- Arguments: `/absolute/path/to/hello-agent/agent.mjs` (the GUI environment's PATH may differ from your shell; prefer absolute paths)
- Working directory: anything (this sample reads no files)

Save, then click the profile in the sidebar to connect. Panda spawns the process, handshakes, and opens a session — the status bar showing **Ready** means you are connected.

## Step 4: say something

Send "hello". You will see the streaming reply land in the message stream; the sidebar shows only the current session (without `sessionCapabilities.list`/`loadSession` declared, Panda degrades visibly instead of pretending history exists).

That is how capability gating works: **the UI lights up exactly what you declare; whatever you skip degrades honestly.**

## Step 5: light up tool cards and permission prompts

Replace the `prompt` implementation with the version below — a tool card carrying a diff, plus one approval genuinely handed to the user:

```js
    prompt: async ({ sessionId, prompt }) => {
      const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const toolCallId = randomUUID();

      // Tool card: start as pending (the diff rides on the start event)
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

      // Permission card: hand the decision to the user (Panda renders Allow / Reject)
      const decision = await conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId,
          title: 'Write greeting.txt',
          rawInput: { file_path: 'greeting.txt', new_text: text },
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const allowed =
        decision.outcome?.outcome === 'selected' && decision.outcome.optionId === 'allow';

      // Tool cards must reach a terminal status (otherwise they hang on "running" forever)
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
          content: { type: 'text', text: allowed ? 'Wrote greeting.txt.' : 'You rejected the write; nothing changed.' },
        },
      });
      return { stopReason: 'end_turn' };
    },
```

Send another message: an edit card with a syntax-highlighted diff appears first, followed by a permission card — click Allow or Reject, and the agent finishes along the matching branch while the tool card flips to completed/cancelled.

## Going further: every extra update lights up another piece

| UI you want | What to send |
| --- | --- |
| Thought stream (collapsible reasoning) | `agent_thought_chunk` (text blocks, incremental) |
| Plan dock (task list with progress) | `plan` (entries with content/status) |
| Context usage meter in the status bar | `usage_update` (a `used`/`size` pair, not a cumulative total) |
| Session titles in the sidebar | `session_info_update` (`title`; titling from the first user message is a zero-cost good practice) |
| Image input | declare `promptCapabilities.image: true` in `initialize`; image content blocks then arrive in `session/prompt` |

Field-level details, recommendations ranked by UX cost, and timeout budgets: the [agent integration contract](acp-agent-requirements.en.md). A complete reference implementation (session persistence, elicitation, modes, compaction, usage…): [`test-agent/src/agentServer.ts`](../test-agent/src/agentServer.ts) (Chinese comments).

## What about the web app?

The web app never spawns local processes; bridge your stdio agent to WebSocket following [Bridging stdio agents to WebSocket](acp-stdio-to-websocket.en.md). During development, the desktop app's direct stdio connection is the smoothest path.

## Common pitfalls

- **Logging to stdout breaks the protocol** — in stdio mode stdout belongs exclusively to the NDJSON protocol stream; log with `console.error` (stderr) only.
- **`protocolVersion` must return `1` (the number)** — anything else and Panda drops the connection with a version-mismatch error.
- **Tool cards must reach a terminal status** — push `tool_call_update` to `completed`/`failed`/`cancelled`; skip it and the card stays "running" forever.
- **Respond to cancellation** — the stop button sends a `session/cancel` notification; the minimal sample runs fine without handling it, but the turn then runs to its natural end (contract §2.5).

---

*Both sample files were verified end-to-end (initialize → session/new → session/prompt → session/update → stopReason, with both allow and reject permission branches) in a clean directory on Node 24 + SDK 1.4.0.*
