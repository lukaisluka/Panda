# Changelog

All notable changes to Panda are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will
follow the releases published from this repository.

## [0.2.0] - 2026-09-09

The positioning pivot to "a ready-made UI for agent developers" — README
rewrite, bilingual quickstart, first-run onboarding, launch facade — plus
plan-aware approvals and the first UX polish batch.

### Added

- **First-run onboarding (#200)** — with no foreground live session the
  main column shows the three ways in: the scripted demo (an in-UI
  `#/demo` entry), connecting your own agent (desktop stdio + quickstart
  link; web WebSocket + bridge guide), and a collapsed path for
  existing-agent users. Per-locale doc links target the matching mirror.
- **Developer quickstart (#199)** — a bilingual tutorial (`docs/agent-quickstart.md`
  + mirror) writing a minimal ACP agent from scratch — one stdio file on the
  `@agentclientprotocol/sdk`, no framework — and getting Panda's full UI for
  it: streaming, tool cards, plans, permissions, usage.
- **Demo facade (#196)** — `#/demo` is a production entry (not a dev-only
  route), both READMEs embed the demo GIF inline, and shared links unfurl an
  OG card.
- **Plan-aware approvals (#220)** — a permission request carrying a
  `write_todos`-shaped payload now renders the plan per-step inside the
  approval card (in every card state), so approving a plan is no longer
  blind; the dock counter reads `N/M done` instead of the ambiguous `N/M`;
  the scripted demo walks its plan 0/3 → 3/3 instead of pre-completing
  step one.

### Changed

- **README rewrite (#198)** — both READMEs now lead with the
  agent-developer story ("your agent speaks ACP, Panda is its UI"), quantify
  the integration bar up front (the contract's minimum method set), and move
  ready-made agents to an explicitly secondary section; the integration
  contract and quickstart are linked from the first screen.
- **Launch facade repositioning (#229)** — the OG/share card and page meta
  now speak to agent developers ("your agent speaks ACP, Panda is its UI").
  The card's chips carry the integration bar itself (`initialize`,
  `session/new`, `session/prompt`, `session/update`) instead of ready-made
  agent names, and its source lives in `branding/og-card.html`.
- **Positioning residue sweep (#232)** — the scripted demo no longer
  masquerades as a claude-code endpoint (header/sidebar labels, follow-up
  script line); the stdio command example now points at your own agent
  (`node your-agent.mjs`); the user guide and CONTEXT openings and package
  metadata drop the "universal client" framing; ADR 0008 records the
  agent-developer positioning decision.
- **UX polish batch (#221)** — offline sidebar rows connect on click; the
  profile form gains a Test connection probe (full initialize handshake,
  zero store/session footprint, verdicts reuse the #217 attribution copy);
  saving a profile offers a "start a session" CTA that opens the picker with
  the new row highlighted; a fresh direct connect sweeps older pure-failure
  slots at the same address; untitled sessions fall back to their first
  user message; the transcript is a `role="log"` and the mode menu implements
  APG keyboard navigation; the "always allow" tooltip states its real scope
  (remembered session-wide for identical requests, expires with the session).
- **Conventional Commits (#225, #227)** — commit subjects and PR titles now
  follow Conventional Commits in English, with the PR title linted in CI.

### Fixed

- **Scroll follow (#210)** — approving a permission no longer counts as user
  scrolling; follow mode never detaches silently during an approval.
- **Status bar wording (#211)** — Ready/Working labels go through the i18n
  dictionary, so a broken link no longer shows a contradictory "ready".
- **Contrast (#212)** — `--color-muted` now derives to an AA ratio; faint
  informational sites were moved up a step (light theme 2.12/3.06 → 4.78).
- **i18n leftovers (#213)** — leftover chrome strings are translated and
  Astryx component locale is bridged to the app language.
- **Session-settings popover (#215)** — closes on Escape and outside click,
  and collapses when its session is gone.
- **Composer hint (#216)** — the awaiting-approval hint points at the stream
  instead of blocking the composer; drafting stays open.
- **Connection failures (#217)** — failure attribution copy is human-readable
  (DNS vs refused vs timeout); a failed session switch surfaces a retryable
  toast instead of a dead end.
- **Retained documents (#218, #240)** — documents kept after a disconnect
  stay readable, and foregrounding an offline slot keeps them in view.
- **Demo banner (#219)** — the scripted replay banner is visually distinct
  from the live session list.
- **Reconnect races (#238)** — a reconnect request the UI cannot accept is
  answered with a toast instead of being silently ignored.

## [0.1.1] - 2026-09-07

Bug-hunt hardening (18 confirmed fixes from #182/#183) plus the MCP config
surface, the settings redesign, and activity-ordered sessions.

### Added

- **MCP server configuration (#142–#149)** — servers are managed in settings
  with a form or a JSON/YAML text view that tolerantly parses other clients'
  dialects (Claude Desktop/Code, Cursor, VS Code, Gemini, Continue…); each
  agent profile carries a whitelist deciding which servers ride its
  sessions.
- **Sidebar session last-activity times (#175)** — session rows show a coarse
  relative label ("3 min ago"; absolute date beyond a week, exact time on
  hover) for their last conversation activity.
- **Claude Code contract tests (#154)** — recorded real-traffic fixtures
  replay in CI; an opt-in live e2e (`PANDA_CLAUDE_CODE_E2E=1`) covers the
  real adapter.
- **Onboarding docs** — ACP agent contract (zh/en) and the stdio→WebSocket
  bridge guide (zh/en) for third-party implementers and web users.

### Changed

- **Settings redesign (#138/#140/#171)** — Codex-style one-setting-per-row
  pages with the section title in the top bar; font size converges to three
  presets (one message-stream knob, one interface knob).
- **Visible failures (#160)** — destructive confirms are Astryx AlertDialogs
  (no more `window.confirm`); silent failure paths (clipboard, failed saves)
  now surface as toasts.
- **Local activity stamping (#175)** — conversation events (user input, agent
  replies, tool calls) now stamp `sessions[].updatedAt` and the connection's
  ordering key on the host, so agents that never report `updatedAt` still get
  meaningful order. Suppressed during `session/load` replay (history is not
  activity); agent reports (`session/list`, `session_info_update`) still
  overwrite on arrival — last writer wins, no cross-clock comparison.
- **New sessions sort first (#180)** — a session entering the sidebar for the
  first time (session/new) is stamped at that moment, so a freshly created
  conversation heads its group instead of sinking to the untimed bottom;
  adopting a known session (resume) still keeps its existing time.
- **Stable sidebar order (#175)** — the "foreground pinned first" rule is
  removed from both the agent groups and the session rows: order now tracks
  only last activity, so switching no longer jumps rows around; the current
  agent/session is recognized by its highlight.
- **New-session form (#157)** — with agents configured, the custom address
  collapses into an advanced option.
- **Branding (#155/#176)** — retro-badge panda across favicon, Tauri icon,
  sidebar logo, and the crash page.

### Fixed

- **IME input (#182-2)** — Enter during composition no longer sends
  half-typed pinyin; command parsing respects composition too.
- **Session-scoped UI state (#182-15, #183-16/17)** — composer drafts and
  attachments, half-filled elicitation forms, expanded tool cards, and
  scroll/follow modes are keyed per session: switching the foreground session
  no longer leaks them across sessions or silently drops them.
- **Row-level action routing (#182-1/5/3)** — a background connection's
  reconnect/resume buttons act on THAT connection (not the foreground one);
  the new-session dialog's profile rows create the session on the clicked
  agent; mid-turn session creation is refused with a busy notice instead of
  wedging the old session.
- **Protocol flow dead-ends (#182-4, #183-13/8)** — settled elicitation
  records no longer block legitimate id reuse (the new request used to hang
  forever); `session/load` replay no longer merges two distinct user
  messages into one; request-scoped auth elicitations (OAuth url / key form)
  during a mid-connection re-login now render and complete.
- **MCP settings honesty (#183-12/18)** — saving the text view keeps
  surviving servers' ids (profile whitelists stay intact across a text
  round-trip); rejected writes surface as an error toast instead of silently
  rolling back.
- **Persistence & unread signals (#183-9/14)** — the session persistence pump
  no longer lets stale stored values overwrite fresh live ones (last-activity
  times used to freeze at their first-ever write); disconnecting a background
  connection mid-turn no longer lights the "unread completion" indicator for
  a turn the user killed.
- **Diff & highlighting (#182-6, #183-10)** — copied patches carry the
  `\ No newline at end of file` marker (git used to reject patches of
  newline-less files); oversized code (>600 lines / 30K chars) degrades to
  plain text instead of freezing the UI for seconds, and a re-tokenizing
  diff no longer paints the previous file's content in the new geometry.
- **Process lifecycle (#183-7/11)** — quitting Panda terminates every agent
  child (SIGTERM → 3 s → SIGKILL, waited synchronously) and a webview reload
  sweeps orphaned children, honoring the documented promise; the
  test-agent serve bridge survives EPIPE when an agent child dies with
  frames in flight (the bridge guide's teaching example now shows the fix).
- **Sparse session patches (#178)** — absent fields no longer erase known
  values (an undefined `updatedAt` used to blank the stamp).
- **Layout overflow (#150–#153)** — sidebar error cards wrap instead of
  overflowing; long URLs and unbreakable words truncate cleanly.

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

[Unreleased]: https://github.com/lukaisluka/Panda/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lukaisluka/Panda/releases/tag/v0.2.0
[0.1.1]: https://github.com/lukaisluka/Panda/releases/tag/v0.1.1
[0.1.0]: https://github.com/lukaisluka/Panda/releases/tag/v0.1.0
