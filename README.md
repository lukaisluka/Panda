# Panda 🐼

**A universal client for every ACP-compatible agent, built around a meticulously crafted message stream.**

Panda speaks [ACP (Agent Client Protocol)](https://agentclientprotocol.com) — the standard that 40+ coding agents (Claude Code, Gemini CLI, Codex, Cursor, Goose, Copilot…) expose to editors. Panda is an independent, conversation-first client: not an IDE plugin, but a place where talking to an agent is the primary experience.

📖 **使用指南（中文）**：[docs/user-guide.md](docs/user-guide.md) — 快速上手、连接 agent、界面指南、能力矩阵、故障排查与 FAQ。

## Status: Phase 2 — sessions, recovery, content polish

Panda is a **pure protocol client**: it never spawns or manages agent processes. Connect it to an ACP service you have already started, and the whole message stream is live:

- Real `session/prompt` turns: streaming messages, tool-call cards, plans, usage/cost
- Inline permission cards wired to `session/request_permission` — Allow / Reject answers the pending RPC with the exact option id
- Stop button → `session/cancel` (pending permissions answered with `cancelled`, per spec)
- v1 turn lifecycle synthesized client-side: running → requires_action → idle
- **Session list & history**: `session/list` in the sidebar (paginated), click to switch via `session/load` history replay; `session_info_update` keeps titles live
- **Disconnect recovery**: an unexpected drop keeps the transcript and offers *reconnect & resume* — `session/resume` when the agent declares it, `session/load` replay as fallback, all capability-gated with visible fallbacks
- **Diff polish**: Shiki syntax highlighting (lazy-loaded per language) + word-level changed-span highlighting
- **Images** in agent messages, thoughts and tool results render inline
- **Long sessions**: react-virtuoso virtualization with stick-to-bottom that follows streaming growth yet detaches only on genuine user scroll
- Sessions are remembered per endpoint in localStorage and merged with the server list on connect

The scripted replay from Phase 0 stays available as an offline demo and visual-calibration mode (sidebar → "重放 demo"), exercising exactly the same store actions as the live client. Open `http://localhost:5173/?demo=long` for an 80-turn stream used to calibrate the virtualized list's scroll behavior.

Try it:

```sh
pnpm install && pnpm dev            # opens on the scripted demo replay
node scripts/mock-acp-server.mjs    # dev-only mock ACP service → ws://localhost:8765/acp
```

Then in the sidebar's "ACP 连接" panel point Panda at `ws://localhost:8765/acp` (or your own service), pick an absolute working directory, and connect.

## Connecting to an agent

Any endpoint that speaks ACP over **WebSocket with one JSON-RPC message per text frame** works — the convention shared by the official TypeScript SDK, the ACP remote-transport draft, and mainstream bridges:

- **Dev smoke**: `node scripts/mock-acp-server.mjs` in this repo serves a scripted agent at `ws://localhost:8765/acp`, with durable sessions (disk-persisted; supports `session/list`, `session/load`, `session/resume`, `session/delete`) for trying the recovery flows.
- **Expose an agent you already run**: community bridges wrap a stdio ACP agent in a WebSocket endpoint — e.g. [acpremote](https://github.com/vcoderun/acpkit) (`expose`), [@flutur/acp-http-bridge](https://github.com/Alemusica/acp-http-bridge), [acp-bridge](https://github.com/vezaynk/acp-bridge). See each tool's README for the exact command; the service lifecycle is yours, Panda only connects.

The working directory you enter is sent in `session/new` and interpreted by the service — for a remote service that's a server-side path.

## Architecture

The core idea: **ACP is an event stream, but the UI needs a document.** A pure reduction layer folds `session/update` notifications into a stable `SessionDocument`; React only ever renders that document. Protocol version differences (v1's blocking prompt vs v2's `running/idle/requires_action` state machine and messageId upserts) are absorbed below the components, never inside them.

```
┌──────────────── React UI ────────────────┐
│  MessageStream · Composer · StatusBar    │
└──────────────────┬───────────────────────┘
                   │ reads SessionDocument only
┌──────────────────┴───────────────────────┐
│  Reduction layer: applyUpdate(doc, event)│  pure, replayable, testable
└──────────────────┬───────────────────────┘
┌──────────────────┴───────────────────────┐
│ Session drivers — same handler contract: │
│  · LiveAcpClient: v1 ACP over WebSocket  │
│    (@agentclientprotocol/sdk)            │
│  · ReplayDriver: scripted demo/fixtures  │
└──────────────────┬───────────────────────┘
                   │ one JSON-RPC message per WS text frame
        an ACP service you start and own
```

Both drivers feed the same three store actions (`update` / `setStatus` / `setPermission`). `LiveAcpClient`'s unit tests drive the full JSON-RPC layer against a scripted SDK `agent()` app — no network, real protocol — and the replay fixtures double as visual-calibration samples (later: snapshot tests).

Panda negotiates v1 today (`PROTOCOL_VERSION = 1`, failing fast on a mismatch); the reducer is already shaped for v2's state machine and messageId upserts.

## Stack

Vite · React 19 · TypeScript (strict) · Tailwind CSS v4 · Zustand · react-markdown · react-virtuoso · diff · shiki · [@agentclientprotocol/sdk](https://github.com/agentclientprotocol/typescript-sdk) · Vitest

## Roadmap

- **Phase 2** — done: reconnect with `session/resume` / `session/load`, session list/history, diff polish (Shiki highlight + word-level spans), image content display, long-session virtualization. Consciously out of scope: *terminal* tool content (in v1 that means the client executes commands on the agent's behalf — a browser chat client doesn't declare the capability and skips such blocks with a warning); image *sending* moves to Phase 3.
- **Phase 3** — multi-agent configuration, image sending, desktop shell

## License

Apache-2.0