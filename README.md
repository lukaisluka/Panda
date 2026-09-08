<div align="center">
  <img src="branding/clean/concept-retro-badge.png" alt="Panda" width="180" />
  <h1>Panda</h1>
  <p><strong>A ready-made client for agent developers: your agent speaks ACP, Panda is its UI.</strong></p>
  <p>
    <a href="https://github.com/lukaisluka/Panda/actions/workflows/ci.yml"><img src="https://github.com/lukaisluka/Panda/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/lukaisluka/Panda/releases"><img src="https://img.shields.io/github/v/release/lukaisluka/Panda" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  </p>
  <p>
    <img src="branding/clean/series-retro-hello.png" alt="Say hello" width="88" />
    <img src="branding/clean/series-retro-reading.png" alt="Reading" width="88" />
    <img src="branding/clean/series-retro-tea.png" alt="Tea break" width="88" />
    <img src="branding/clean/series-retro-sleep.png" alt="Idle" width="88" />
  </p>
  <p><em>English · <a href="README.zh-CN.md">简体中文</a></em></p>
  <p><img src="docs/assets/demo.gif" alt="Panda demo: a scripted agent session — streaming replies, tool-call cards, an edit diff behind an inline permission card, tests, and a usage summary" /></p>
</div>

People who build agents rarely want to build frontends — and a decent chat client is a whole project: streaming rendering, tool-call cards, diff highlighting, permission prompts, plans and usage, session management and reconnect recovery. Panda has finished that project: **implement [ACP (Agent Client Protocol)](https://agentclientprotocol.com) in your agent, and it immediately gets this meticulously crafted message stream.** Panda is not an IDE plugin; it is a standalone conversation app. No bundled runtime, no accounts, no backend — the connection and the data stay with you.

- **Zero frontend** — implement the ACP minimum and the whole message-stream UI is yours
- **Multiple agents in parallel** — one connection per profile; background connections keep receiving updates and flag when they need you
- **No accounts, no telemetry, no backend** — a pure protocol client that stores no conversation content; everything lives with your agent

## A UI for your agent

The bar to integrate is low. With the official SDK (`@agentclientprotocol/sdk`), implement:

- **three requests** — `initialize` (handshake), `session/new`, `session/prompt`
- **one notification outlet** — push `session/update` during a turn; at minimum `agent_message_chunk` text blocks

That's it. Every extra capability lights up another piece of the UI: push `tool_call` for tool cards with diffs, send `session/request_permission` for approval cards, `plan` for the plan dock, `usage_update` for the context meter… anything you skip degrades visibly and never blocks integration.

For a ten-minute, write-it-from-scratch walkthrough see the [agent quickstart](docs/agent-quickstart.en.md); for the full integration bar, recommendations ranked by user-visible cost, and timeout budgets, see the [agent integration contract](docs/acp-agent-requirements.en.md); for a complete reference implementation, see [test-agent/](test-agent/README.md) (Chinese). Connecting your own agent: desktop stdio is the smoothest path ([user guide](docs/user-guide.md) (Chinese)); the web app takes any ACP-over-WebSocket endpoint ([bridge guide](docs/acp-stdio-to-websocket.md) (Chinese)).

## Get Panda

Pick by scenario — the desktop build connects stdio agents you develop; the web app is zero-install with a built-in [scripted demo](https://lukaisluka.github.io/Panda/#/demo), no agent needed:

- **Web (zero install)** — <https://lukaisluka.github.io/Panda/> runs in any modern browser. Point it at an ACP-over-WebSocket endpoint and the message stream is live.
- **Desktop (macOS / Windows) — beta** — grab a build from [GitHub Releases](https://github.com/lukaisluka/Panda/releases). The desktop shell works — same UI and protocol stack as the web version, plus direct stdio agents — but it has not been through organized release testing yet, so it ships as beta; day-to-day, prefer the web version:
  - macOS: `Panda_<ver>_aarch64.dmg`
  - Windows: `Panda_<ver>_x64-setup.exe` (installer), or `Panda_<ver>_x64-portable.zip` (no install; the app is the same either way — user data stays in the per-user data directory, it does not travel with the exe)

  Notes: connecting stdio agents directly needs the desktop build ([guide](docs/user-guide.md) (Chinese)). Windows needs WebView2 (preinstalled on Windows 11 and updated Windows 10; the installer downloads it when missing). Builds are **unsigned**: SmartScreen / first-run Gatekeeper prompts are expected.
- **From source** — see [Development](#development).

## Features

All of the following works out of the box for any integrated agent — this is the frontend Panda delivers, not your to-do list:

- **Live conversations** — streaming messages, tool-call cards, plans, usage and cost, rendered as they arrive
- **Inline permission cards** — Allow / Reject answers the pending `session/request_permission` RPC; a stop button sends `session/cancel` and auto-cancels pending permissions per spec
- **Sessions & history** — browse past sessions (`session/list`), switch by replaying history (`session/load`), live-updating titles
- **Saved agent profiles (parallel connections)** — name, endpoint and default workspace per profile, connect-time edits write back; multiple profiles online at once, with background connections receiving updates and flagging when they need attention
- **Disconnect recovery** — an unexpected drop keeps the transcript and offers *reconnect & resume* (`session/resume`, `session/load` fallback), all capability-gated with visible fallbacks
- **Polished diffs** — Shiki syntax highlighting plus word-level changed spans
- **Images both ways** — paste or pick images for capable agents; render images in user/agent messages, thoughts and tool results
- **Long sessions** — a virtualized message list that follows streaming growth yet detaches only on genuine user scroll
- **Direct stdio agents on desktop** — spawn a local ACP agent command and talk NDJSON over its pipes, managed lifecycle included
- **Scripted demo replay** — the same UI driven by a scripted agent, no backend needed: <https://lukaisluka.github.io/Panda/#/demo> (`?demo=long` streams an 80-turn session)

## Works with existing agents, too

Not building your own? Claude Code, Gemini CLI, Codex, Cursor, Goose, Copilot and 40+ other mainstream coding agents speak ACP, or can be exposed through a bridge.

- **Claude Code — verified**: CI replays recorded real Claude Code traffic as contract tests (#154), so protocol coverage has regression protection.
- **The rest — expected to work, not individually tested**: issues welcome.

Paths for connecting existing agents: the [user guide](docs/user-guide.md) (Chinese) and the [bridge guide](docs/acp-stdio-to-websocket.md) (Chinese).

## How it works

ACP is an event stream, but the UI needs a document. A pure reduction layer folds `session/update` notifications into a stable `SessionDocument`; React renders only that document, and protocol-version differences are absorbed below the components. Session drivers — the live client and the scripted replay — feed the same store actions, so the offline demo exercises exactly the code paths a live connection uses. In the browser Panda is a **pure protocol client** (it never spawns agent processes); the desktop shell adds exactly one host capability — the stdio process plane.

## Documentation

- [ACP agent integration contract](docs/acp-agent-requirements.md) ([English](docs/acp-agent-requirements.en.md)) — minimum required method set, UX-cost-ranked recommendation tiers, and timeout budgets for agent implementers
- [Agent quickstart](docs/agent-quickstart.md) ([English](docs/agent-quickstart.en.md)) — a ten-minute tutorial: write a minimal ACP agent from scratch and connect it to Panda
- [User guide](docs/user-guide.md) (Chinese) — quick start, connecting agents, UI guide, capability matrix, troubleshooting & FAQ
- [Bridging stdio agents to WebSocket](docs/acp-stdio-to-websocket.md) ([English](docs/acp-stdio-to-websocket.en.md)) — frame mapping, wss/TLS setup, and security rules for exposing stdio agents to the web app, for self-hosters
- [CHANGELOG](CHANGELOG.md)
- [Architecture decision records](docs/adr/) (Chinese) — significant decisions, with context and rejected alternatives
- [desktop/README.md](desktop/README.md) — desktop shell: development, acceptance harness, artifacts
- [test-agent/README.md](test-agent/README.md) (Chinese) — the deterministic deepagents-based ACP agent used by integration tests

## Brand

The retro badge panda is the project's identity. Final artwork lives in `branding/clean/` (watermark-free): the main badge plus four state illustrations — hello / reading / tea / sleep. Where each piece is used:

- `src/assets/brand/` — app-ready exports: `panda-badge.png` (sidebar logo), `panda-sleep.png` (crash page); the rest are available for future empty/loading states
- `public/favicon.png` + `public/apple-touch-icon.png` — web icons, declared in `index.html`
- `public/og-image.png` — social-preview composite (og/twitter cards in `index.html`); the GitHub repo's *Social preview* under Settings uses the same artwork (manual upload)
- `desktop/icon-source.png` — desktop icon source; regenerate `desktop/src-tauri/icons/` with `pnpm --dir desktop exec tauri icon icon-source.png`

## Development

Requires Node 24+, pnpm 11, and (for the desktop shell only) a Rust toolchain.

```sh
pnpm install
pnpm dev           # http://127.0.0.1:5173 — #/demo runs the scripted replay
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest — includes live-agent e2e when test-agent deps are installed
pnpm build         # typecheck + vite build
```

The repository is a pnpm workspace: the root package is the web app, `test-agent/` is a deterministic ACP agent for integration tests, and `desktop/` is the Tauri v2 shell (`pnpm desktop:dev` / `pnpm desktop:build` — see [desktop/README.md](desktop/README.md)). Domain terminology lives in [CONTEXT.md](CONTEXT.md); UI design contracts in [DESIGN.md](DESIGN.md).

## Roadmap

- **Later** — code signing and auto-update for desktop artifacts; ACP v2
- Consciously out of scope for v1: *terminal* tool content — executing commands on the agent's behalf is something a chat client doesn't declare; Panda skips such blocks with a warning

## License

Apache-2.0
