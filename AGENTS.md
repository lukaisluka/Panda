# Panda

## Agent skills

### Issue tracker

Issues live in GitHub Issues (repo `lukaisluka/Panda`), driven via the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles plus this repo's sixth role `claimed`
(issue claimed, work in flight; claim comment names the worktree/branch).
Label strings are identical to role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, created
lazily by `/domain-modeling`. See `docs/agents/domain.md`.

### Bilingual docs

Docs are organized by language: each file is single-language prose, and the
only bilingual pairs are explicit mirrors. Two pairs exist — `README.md`
(English) + `README.zh-CN.md` (Chinese), and the ACP contract pair (Chinese
source of truth + English mirror, see "ACP agent contract"). When editing
one side of a pair, update the other in the same change. Everything else is
single-language by audience: agent-facing docs (`AGENTS.md`, `docs/agents/*`,
`desktop/README.md`, `CHANGELOG.md`) are English; human-facing docs
(`CONTEXT.md`, `DESIGN.md`, `docs/user-guide.md`, `docs/adr/*`,
`test-agent/README.md`) are Chinese. Don't mix prose languages inside one
file — cross-links to a doc in the other language get a language tag
(`(Chinese)` / `（英文）`), nothing more.

### UI design system

`DESIGN.md` at the repo root is the SSOT for UI tokens, themes, and the
Astryx/Tailwind coexistence contracts (cascade layers, spacing pin). The
UI runs on Astryx (matcha theme) behind the official Tailwind bridge —
migration tracked in #32; dev-only self-check at `#/astryx-smoke`.

### Test ACP agent

`test-agent/` is a TypeScript pnpm-workspace package (`panda-test-agent`, Node
>= 22.5 for `node:sqlite`) running the real deepagents JS stack behind an ACP
shell built directly on `@agentclientprotocol/sdk` (the same SDK Panda uses);
only the default chat model is deterministic (scripted). The npm
`deepagents-acp` server is intentionally NOT used — its sessions live in
process memory and its permission flow never resumes the graph. Runtime
sandboxes and SQLite state belong under ignored `test-agent/sandbox*/` and
`test-agent/.state*/`.

Third-party compat is covered by the Claude Code contract tests (#154):
layer 1 replays recorded real traffic from `@agentclientprotocol/claude-agent-acp`
(`test-agent/fixtures/claude-code/` + `src/acp/claudeCodeContract.test.ts`,
runs in CI); layer 2 is an opt-in live e2e (`PANDA_CLAUDE_CODE_E2E=1`,
`src/acp/ClaudeCode.e2e.test.ts`, costs real tokens, never in CI). Re-record
fixtures with `pnpm --filter panda-test-agent record:claude-code` (requires a
logged-in `claude` CLI); the adapter is spawned via `zsh -lc 'exec npx -y …'`
with `CLAUDE_CODE_EXECUTABLE` set explicitly.

### ACP agent contract

`docs/acp-agent-requirements.md` (Chinese, source of truth) and
`docs/acp-agent-requirements.en.md` (English mirror, updated in sync) export
the protocol contract for third-party agent implementers: the minimum method
set, the four client-side handlers Panda answers (fs/terminal are deliberately
`-32601`), the UX-cost-ranked recommendation tiers, and the timeout/timing
budgets. The code SSOT is `src/acp/LiveAcpClient.ts` + `src/acp/wire.ts` —
when those change, update both doc versions in sync.

### Desktop shell

`desktop/` is a pnpm-workspace package (`panda-desktop`) hosting the same
Vite UI in a Tauri v2 shell; the Rust process plane (`stdio_spawn`/`stdio_write`
/`stdio_kill`) is hand-rolled, NOT tauri-plugin-shell (ADR 0007). Development,
the WKWebView acceptance harness, the vite host/port pins, and artifact/CI
notes live in [desktop/README.md](desktop/README.md) — keep it the single
source. Two rules that apply repo-wide: the webview boots the stdio factory
via `src/desktop/boot.ts`, lazily imported only when `__TAURI_INTERNALS__`
exists — never import `@tauri-apps/api` outside that chunk; and one-time
research notes belong under `docs/research/` (archived, not maintained), not
in `docs/` proper.
