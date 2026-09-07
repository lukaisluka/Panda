<div align="center">
  <img src="branding/clean/concept-retro-badge.png" alt="Panda" width="180" />
  <h1>Panda</h1>
  <p><strong>A universal client for every ACP-compatible agent, built around a meticulously crafted message stream.</strong></p>
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
</div>

Panda speaks [ACP (Agent Client Protocol)](https://agentclientprotocol.com) — the standard that 40+ coding agents (Claude Code, Gemini CLI, Codex, Cursor, Goose, Copilot…) expose to editors. Panda is an independent, conversation-first client: not an IDE plugin, but a place where talking to an agent is the primary experience.

📖 **中文使用指南**：[docs/user-guide.md](docs/user-guide.md) — 快速上手、连接 agent、界面指南、能力矩阵、故障排查与 FAQ。

## Get Panda

- **Web (recommended)** — <https://lukaisluka.github.io/Panda/> runs in any modern browser, nothing to install. Point it at an ACP-over-WebSocket endpoint and the message stream is live; with no agent connected you get the built-in scripted demo.
- **Desktop (macOS / Windows) — beta** — grab a build from [GitHub Releases](https://github.com/lukaisluka/Panda/releases). The desktop shell works — same UI and protocol stack as the web version, plus direct stdio agents — but it has not been through organized release testing yet, so it ships as beta; day-to-day, prefer the web version:
  - macOS: `Panda_<ver>_aarch64.dmg`
  - Windows: `Panda_<ver>_x64-setup.exe` (installer), or `Panda_<ver>_x64-portable.zip` (no install; the app is the same either way — user data stays in the per-user data directory, it does not travel with the exe)

  Notes: connecting stdio agents directly needs the desktop build ([guide](docs/user-guide.md)). Windows needs WebView2 (preinstalled on Windows 11 and updated Windows 10; the installer downloads it when missing). Builds are **unsigned**: SmartScreen / first-run Gatekeeper prompts are expected.
- **From source** — see [Development](#development).

## Features

- **Live conversations** — streaming messages, tool-call cards, plans, usage and cost, rendered as they arrive
- **Inline permission cards** — Allow / Reject answers the pending `session/request_permission` RPC; a stop button sends `session/cancel` and auto-cancels pending permissions per spec
- **Sessions & history** — browse past sessions (`session/list`), switch by replaying history (`session/load`), live-updating titles
- **Saved agent profiles** — name, endpoint and default workspace per profile; connect-time edits write back
- **Disconnect recovery** — an unexpected drop keeps the transcript and offers *reconnect & resume* (`session/resume`, `session/load` fallback), all capability-gated with visible fallbacks
- **Polished diffs** — Shiki syntax highlighting plus word-level changed spans
- **Images both ways** — paste or pick images for capable agents; render images in user/agent messages, thoughts and tool results
- **Long sessions** — a virtualized message list that follows streaming growth yet detaches only on genuine user scroll
- **Direct stdio agents on desktop** — spawn a local ACP agent command and talk NDJSON over its pipes, managed lifecycle included
- **Offline demo replay** — the same UI driven by a scripted agent; `?demo=long` streams an 80-turn session

## How it works

ACP is an event stream, but the UI needs a document. A pure reduction layer folds `session/update` notifications into a stable `SessionDocument`; React renders only that document, and protocol-version differences are absorbed below the components. Session drivers — the live client and the scripted replay — feed the same store actions, so the offline demo exercises exactly the code paths a live connection uses. In the browser Panda is a **pure protocol client** (it never spawns agent processes); the desktop shell adds exactly one host capability — the stdio process plane.

## Documentation

- [User guide (中文)](docs/user-guide.md) — 快速上手、连接 agent、界面指南、能力矩阵、故障排查与 FAQ
- [CHANGELOG](CHANGELOG.md)
- [Architecture decision records](docs/adr/) — significant decisions, with context and rejected alternatives
- [desktop/README.md](desktop/README.md) — desktop shell: development, acceptance harness, artifacts
- [test-agent/README.md](test-agent/README.md) — the deterministic deepagents-based ACP agent used by integration tests
- [ACP agent integration contract](docs/acp-agent-requirements.md)([English](docs/acp-agent-requirements.en.md))— 接入 Panda 的最低必须集、体验损失分级与超时预算,面向 agent 实现者

## Brand

The retro badge panda is the project's identity. Final artwork lives in `branding/clean/` (watermark-free): the main badge plus four state illustrations — hello / reading / tea / sleep. Where each piece is used:

- `src/assets/brand/` — app-ready exports: `panda-badge.png` (sidebar logo), `panda-sleep.png` (crash page); the rest are available for future empty/loading states
- `public/favicon.png` + `public/apple-touch-icon.png` — web icons, declared in `index.html`
- `desktop/icon-source.png` — desktop icon source; regenerate `desktop/src-tauri/icons/` with `pnpm --dir desktop exec tauri icon icon-source.png`

## Development

Requires Node 24+, pnpm 11, and (for the desktop shell only) a Rust toolchain.

```sh
pnpm install
pnpm dev           # http://127.0.0.1:5173 — opens on the scripted demo
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
