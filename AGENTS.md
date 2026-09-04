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

`test-agent/` is an isolated Python 3.11+ project managed by `uv`. It runs the
real deepagents/deepagents-acp stack behind Panda's WebSocket transport; only
the default chat model is deterministic. Keep the pinned ACP dependency trio in
`test-agent/pyproject.toml` aligned, because deepagents-acp 0.0.11 imports APIs
removed by newer agent-client-protocol releases. Runtime sandboxes and SQLite
state belong under ignored `test-agent/sandbox/` and `test-agent/.state/`.
