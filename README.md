# Panda 🐼

**A universal client for every ACP-compatible agent, built around a meticulously crafted message stream.**

Panda speaks [ACP (Agent Client Protocol)](https://agentclientprotocol.com) — the standard that 40+ coding agents (Claude Code, Gemini CLI, Codex, Cursor, Goose, Copilot…) expose to editors. Panda is an independent, conversation-first client: not an IDE plugin, but a place where talking to an agent is the primary experience.

Panda is a **pure protocol client**: it never installs, spawns, or manages agent processes. Connect it to an ACP service you already run, and the whole message stream is live. Panda negotiates ACP **v1** today, failing fast on version mismatch.

📖 **中文使用指南**：[docs/user-guide.md](docs/user-guide.md) — 快速上手、连接 agent、界面指南、能力矩阵、故障排查与 FAQ。

## Features

- **Live conversations** — streaming messages, tool-call cards, plans, usage and cost, rendered as they arrive
- **Inline permission cards** — Allow / Reject answers the pending `session/request_permission` RPC; a stop button sends `session/cancel` and auto-cancels pending permissions per spec
- **Sessions & history** — browse past sessions (`session/list`), switch by replaying history (`session/load`), live-updating titles
- **Disconnect recovery** — an unexpected drop keeps the transcript and offers *reconnect & resume* (`session/resume`, `session/load` fallback), all capability-gated with visible fallbacks
- **Polished diffs** — Shiki syntax highlighting plus word-level changed spans
- **Images both ways** — paste or pick images for capable agents; render images in user/agent messages, thoughts and tool results
- **Long sessions** — a virtualized message list that follows streaming growth yet detaches only on genuine user scroll
- **Offline demo replay** — the same UI driven by a scripted agent; `?demo=long` streams an 80-turn session for scroll calibration

## Quick start

```sh
pnpm install && pnpm dev            # http://localhost:5173 — opens on the scripted demo
node scripts/mock-acp-server.mjs    # dev-only mock agent → ws://localhost:8765/acp
```

In the sidebar's ACP panel, point Panda at the mock endpoint, pick a working directory, and connect. Any service speaking ACP over WebSocket — one JSON-RPC message per text frame, the convention shared by the official TypeScript SDK and mainstream bridges — works the same way. To expose an agent you already run, community bridges such as [acpremote](https://github.com/vcoderun/acpkit), [@flutur/acp-http-bridge](https://github.com/Alemusica/acp-http-bridge) and [acp-bridge](https://github.com/vezaynk/acp-bridge) wrap stdio ACP agents in a WebSocket endpoint.

Note: the working directory is sent in `session/new` and interpreted by the service — for a remote service that's a server-side path. The full walkthrough (UI tour, capability matrix, troubleshooting, FAQ) lives in the [user guide](docs/user-guide.md).

## How it works

ACP is an event stream, but the UI needs a document. A pure reduction layer folds `session/update` notifications into a stable `SessionDocument`; React renders only that document, and protocol-version differences are absorbed below the components. Session drivers — the live WebSocket client and the scripted replay — feed the same store actions, so the offline demo exercises exactly the code paths a live connection uses.

## Development

```sh
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest — reducer, diff utils, LiveAcpClient against a scripted SDK agent
pnpm build        # typecheck + vite build
```

Domain terminology lives in [CONTEXT.md](CONTEXT.md), significant decisions in [docs/adr/](docs/adr/).

## Roadmap

- **Done** — live ACP client, session lifecycle & recovery, image sending, diff polish, virtualized streams, [user guide](docs/user-guide.md)
- **In progress** — [#2](https://github.com/lukaisluka/Panda/issues/2) saved agent profiles (one active connection)
- **Later** — desktop shell

Consciously out of scope: *terminal* tool content — in v1 that means the client executes commands on the agent's behalf, which a browser chat client doesn't declare; Panda skips such blocks with a warning.

## License

Apache-2.0
