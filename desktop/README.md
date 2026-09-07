# panda-desktop

Tauri v2 shell hosting the workspace's Vite app, plus the one capability a
browser cannot have: spawning local stdio agents and streaming their pipes.
The product is the webview; this executable exists only for that process
plane (ADR
[0007](../docs/adr/0007-desktop-shell-and-stdio-transport.md)).

Status: the shell ships as **beta** — its stdio path is covered by the
in-shell acceptance harness below, but it has not been through organized
release testing. User-facing docs recommend the web version for day-to-day
use; revisit this when a proper test pass happens.

## Commands

```sh
pnpm desktop:dev    # vite + cargo run — opens the shell window on http://127.0.0.1:5173
pnpm desktop:build  # tauri build — bundles a .dmg on macOS (aarch64), NSIS setup.exe on Windows
```

Prerequisites: the workspace's Node 24 / pnpm 11, plus a Rust toolchain
(rustup). First run compiles `src-tauri` (a few minutes); later runs are
incremental — note that editing `tauri.conf.json` also triggers a rebuild,
because the config is embedded via `generate_context!`.

## Layout

- `src-tauri/src/main.rs` — the process plane: three commands
  (`stdio_spawn` / `stdio_write` / `stdio_kill`) around a tokio `Child`.
  stdout/stderr stream back as base64 chunks over a Tauri `Channel`; exit
  funnels into one `Exit` event. Orphan guards (#7): the `RunEvent::Exit`
  hook sweeps every tracked child (stdin EOF + SIGTERM → 3 s → SIGKILL) and
  waits synchronously — tao ends its loop in `std::process::exit`, so
  `kill_on_drop` alone never fires; a webview (re)load sweeps the same way
  via `on_page_load`, because the reloaded JS state no longer owns the old
  children. Windows terminates directly (no SIGTERM).
- `src-tauri/tauri.conf.json` — window/bundle config. `frontendDist` is
  resolved **relative to `src-tauri`**, so it must point at `../../dist`
  (the repo-root build output), and `devUrl` pins `127.0.0.1:5173`.
- `src/desktop/boot.ts` (repo root) — the webview side: registers the stdio
  transport factory over the IPC commands, lazily imported by `main.tsx`
  only when `__TAURI_INTERNALS__` is present, so the browser bundle never
  carries `@tauri-apps/api`.

## Shell acceptance harness

WKWebView exposes no automation surface (no accessibility tree for the
content, no remote debugging), so end-to-end shell acceptance runs
in-page: point `devUrl` at
`http://127.0.0.1:5173/desktop-acceptance.html?agent=<abs path to test-agent>`
and relaunch `desktop:dev`. The page drives the **production** stdio path —
boot factory registration → connect → `session/new` → a full scripted turn
with tools → disconnect — against a live test-agent, and reports each step
through the `panda.acceptance` localStorage key (`finished` + per-step
`pass`/`fail`). Shell-side oracles while it runs: the sandbox dir gets
seeded, a `pnpm --dir …/test-agent stdio` process chain appears in `ps`,
and after disconnect no processes remain.

## Pins that must not drift

- vite `server.host: '127.0.0.1'` — on macOS Node resolves `localhost`
  IPv6-only while WKWebView's lookup goes IPv4-first; an IPv6-only listener
  leaves the shell window blank (browsers never notice, they retry both
  stacks).
- vite `server.strictPort: true` — the shell's `devUrl` pins 5173; a busy
  port must fail loudly instead of drifting to 5174 where the shell would
  load nothing.

## Artifacts & CI

[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) builds
on manual dispatch and on `v*` tags: `Panda_<ver>_aarch64.dmg`,
`Panda_<ver>_x64-setup.exe`, `Panda_<ver>_x64-portable.zip` (the bare
`--no-bundle` exe). Tag builds attach everything to a GitHub Release.
Artifacts are unsigned by decision — see ADR 0007.
