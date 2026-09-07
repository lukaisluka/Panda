# Changelog

All notable changes to Panda are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will
follow the releases published from this repository.

## [Unreleased]

## [0.1.0] - 2026-09-07

First publishable cut: a complete ACP v1 client — web app, live deployment,
and a macOS/Windows desktop shell with stdio support.

### Added

- **ACP v1 live client** — `initialize` negotiation with fail-fast version
  mismatch; full session lifecycle: new, list (with pagination), load
  (history replay), resume, cancel, delete, close; live session titles.
- **Message stream** — streaming messages, thoughts, tool-call cards with
  kind icons and diffs, plans, usage/cost; Shiki syntax highlighting with
  word-level changed spans; images in both directions (paste/pick up to
  capability limits); virtualized long-session list with streaming-aware
  auto-scroll.
- **Permissions & elicitation** — inline Allow / Reject cards for
  `session/request_permission`, always-allow options, auto-cancel of
  pending permissions on turn cancel; auth challenges (methods, elicitation,
  logout) and form/url elicitation flows.
- **Agent profiles** — saved per-profile name / endpoint / workspace,
  WebSocket and (desktop) stdio types; connect-time edits write back; one
  active connection per profile, multiple profiles in parallel with
  background-connection indicators.
- **Disconnect recovery** — transcript preserved across unexpected drops;
  reconnect offers `session/resume` with `session/load` replay fallback,
  capability-gated with visible degradation.
- **Mode & config** — session modes (`default` / `accept_edits` /
  `accept_everything`) and mode/model session config options where the
  agent declares them; per-endpoint remembered sessions merged with the
  server list.
- **Offline demo replay** — the same UI driven by a scripted agent,
  including an 80-turn long scenario (`?demo=long`).
- **Desktop shell (beta)** — Tauri v2 shell (macOS dmg, Windows NSIS installer and
  portable zip) hosting the same UI plus a local stdio process plane:
  spawn/write/kill with SIGTERM→SIGKILL lifecycle, no orphan processes,
  base64-chunk pipe streaming; `@tauri-apps/api` stays out of the browser
  bundle via lazy boot.
- **CI & releases** — browser CI (typecheck + tests incl. live-agent e2e),
  GitHub Pages deployment, dual-platform desktop artifact workflow
  (dispatch + `v*` tags).
- **Diagnostics** — environment report (host, locale, user agent) and a
  console ring with a copyable diagnostics report.
- **UI language** — English / Simplified Chinese, switchable in settings.

### Fixed

- Windows CI: e2e cleanup now terminates the agent process tree
  (`taskkill /T /F`) instead of a silently-ignored POSIX process-group
  kill, and retries temp-dir removal around lingering sqlite handles.
- Desktop dev: vite dev server pinned to `127.0.0.1` + `strictPort` — an
  IPv6-only `localhost` listener or a drifting port left the shell window
  blank.
- Desktop build: `frontendDist` resolved relative to `src-tauri`, so the
  previous `../dist` pointed inside `desktop/` and broke release bundling.

[Unreleased]: https://github.com/lukaisluka/Panda/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lukaisluka/Panda/releases/tag/v0.1.0
