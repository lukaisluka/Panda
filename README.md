# Panda 🐼

**A universal client for every ACP-compatible agent, built around a meticulously crafted message stream.**

Panda speaks [ACP (Agent Client Protocol)](https://agentclientprotocol.com) — the standard that 40+ coding agents (Claude Code, Gemini CLI, Codex, Cursor, Goose, Copilot…) expose to editors. Panda is an independent, conversation-first client: not an IDE plugin, but a place where talking to an agent is the primary experience.

## Status: Phase 0 — replay-driven UI shell

The message stream is the hard part of this project, so it is being built first, driven by hand-scripted ACP event replays. No live agent is wired up yet; every visual detail below is already real and calibratable:

- Streaming agent messages with frozen-paragraph Markdown (finished paragraphs never re-parse)
- Collapsible tool-call cards: icon per `ToolKind`, live status, diffstat, raw input, results
- Full-file diff view (ACP delivers `oldText`/`newText`; Panda computes line pairs, dual line numbers)
- Inline permission cards — the session visibly suspends on `requires_action` until you Allow / Reject
- Collapsible thought blocks and a live plan checklist
- Session state bar with context-usage meter and cost
- Scroll-following with detach + jump-to-latest

Try it: `pnpm install && pnpm dev`, then watch the scripted Claude Code-style session unfold. Approve or reject the edit request and follow up with your own messages.

## Architecture

The core idea: **ACP is an event stream, but the UI needs a document.** A pure reduction layer folds `session/update` notifications into a stable `SessionDocument`; React only ever renders that document. Protocol version differences (v1's blocking prompt vs v2's `running/idle/requires_action` state machine and messageId upserts) are absorbed in the reducer, never in components.

```
┌──────────────── React UI ────────────────┐
│  MessageStream · Composer · StatusBar    │
└──────────────────┬───────────────────────┘
                   │ reads SessionDocument only
┌──────────────────┴───────────────────────┐
│  Reduction layer: applyUpdate(doc, event)│  pure, replayable, testable
└──────────────────┬───────────────────────┘
┌──────────────────┴───────────────────────┐
│  ReplayDriver (now) → ACP client (Phase 1)│
│  @agentclientprotocol/sdk, stdio agents   │
└──────────────────────────────────────────┘
```

The replay driver feeds the same store actions a real ACP client will use, so nothing is throwaway: fixtures double as visual-calibration samples and, later, snapshot tests.

## Stack

Vite · React 19 · TypeScript (strict) · Tailwind CSS v4 · Zustand · react-markdown · diff

## Roadmap

- **Phase 1** — live agent: `claude-agent-acp` adapter over a local dev bridge; real `session/prompt` / `request_permission` flow
- **Phase 2** — diff polish (syntax highlight overlay, word-level), terminal tool content, session list/history (`session/load`), long-session virtualization
- **Phase 3** — multi-agent configuration, desktop shell

## License

Apache-2.0