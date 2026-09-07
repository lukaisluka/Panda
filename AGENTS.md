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

### Desktop shell

`desktop/` is a pnpm-workspace package (`panda-desktop`) hosting the same
Vite UI in a Tauri v2 shell; the Rust process plane (`stdio_spawn`/`stdio_write`
/`stdio_kill`) is hand-rolled, NOT tauri-plugin-shell (ADR 0007). Commands:
`pnpm desktop:dev` / `pnpm desktop:build`. The webview boots the stdio factory
via `src/desktop/boot.ts`, lazily imported only when `__TAURI_INTERNALS__`
exists — never import `@tauri-apps/api` outside that chunk. Shell acceptance
is `desktop-acceptance.html` (dev-only vite page; point `devUrl` at it with
`?agent=<test-agent path>`, report lands in localStorage `panda.acceptance`),
because WKWebView has no automation surface. Two pins that must not drift:
vite `server.host` stays `127.0.0.1` (Node binds `localhost` IPv6-only while
WKWebView looks up IPv4 — blank window otherwise), and `strictPort` (devUrl
pins 5173). CI artifacts (dmg / NSIS / portable zip, unsigned) build in
`.github/workflows/desktop.yml`.
