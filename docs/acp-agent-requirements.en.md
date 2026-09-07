# Panda Client — Agent Integration Contract (ACP v1)

For implementers of any ACP agent that should work well with Panda: which interfaces are entry requirements, which are strongly recommended, and what each omission costs.

> 中文版(事实源):[acp-agent-requirements.md](acp-agent-requirements.md)。The Chinese version is the source of truth — update both together.

- Protocol version: **ACP v1** (`protocolVersion: 1`, SDK `@agentclientprotocol/sdk` 1.4.0).
- Code sources of truth (this document is their human-readable export; on conflict, code wins):
  - Connection and every RPC call: [`src/acp/LiveAcpClient.ts`](../src/acp/LiveAcpClient.ts)
  - `session/update` parsing and the lenient contract: [`src/acp/wire.ts`](../src/acp/wire.ts)
  - Capability composition: [`src/capabilities.ts`](../src/capabilities.ts)
  - Full reference implementation: [`test-agent/src/agentServer.ts`](../test-agent/src/agentServer.ts)

**Level vocabulary** (uniform across this document, three levels only):

| Level | Meaning | Where |
| --- | --- | --- |
| **MUST** | Entry requirement: without it the client is unusable or the feature is dead | §2, §3 |
| **RECOMMENDED** | Works without it, but with a clear user-visible cost; ranked into three tiers | §5 |
| **AS NEEDED** | Applies only when the agent has the matching capability (tier three) | §5.3 |

## 0. Overview

The minimal surface to integrate:

| Direction | Method | Level |
| --- | --- | --- |
| Client→Agent request | `initialize`, `session/new`, `session/prompt` | MUST |
| Agent→Client notification | `session/update` (minimum: an `agent_message_chunk` text block) | MUST |
| Client→Agent notification | `session/cancel` | SHOULD (tier-one recommendation) |
| Agent→Client request | `session/request_permission`, `elicitation/create` | as needed; Panda always answers — call freely |
| Agent→Client notification | `elicitation/complete` | as needed (url-mode completion signal) |

Two hard facts that run through the whole document:

1. **Red line**: Panda answers exactly four client-side methods (§3); `fs/*` and `terminal/*` always get `-32601 Method not found` — agents ported from Zed-style environments must not assume the client provides a file/terminal execution surface.
2. **What tier one has in common**: session persistence, session listing, in-turn visibility, and cancellation have no client-side fallback in Panda — if the agent does not provide them, they simply do not exist (§5.1).

## 1. Transport and framing

Panda is a pure protocol client: it never spawns an agent process, it only connects to an already-running service (the desktop shell's stdio process plane is host behavior, not a protocol requirement). Two wire forms, both carrying standard JSON-RPC 2.0 messages:

- **WebSocket**: exactly one JSON-RPC message per text frame (not line-delimited).
- **stdio (desktop shell)**: line-delimited JSON, one message per line.

## 2. Entry requirements: the minimum set

### 2.1 `initialize` — the handshake

Panda's first request after connecting is always:

```jsonc
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "elicitation": { "form": {}, "url": {} },
    "session": { "configOptions": { "boolean": {} }, "compaction": {} },
    "plan": {}
  },
  "clientInfo": { "name": "panda", "title": "Panda", "version": "0.1.0" }
}
```

The response MUST:

1. **Echo `protocolVersion: 1` (strict numeric equality).** Any other value makes the client report a protocol mismatch and drop the connection immediately — no v1, no connection.
2. `agentInfo`: at least `name`; display name is `title ?? name`, falling back to "unknown agent".
3. `agentCapabilities`: an absent field means unsupported; **declaring is promising the handler exists — never declare falsely**. `sessionCapabilities.*` is judged by field presence — an empty object `{}` counts as declared.
4. `authMethods` (optional): agent-managed login methods; entries with `type: "terminal"` are filtered out with a warning (a web host cannot run a TUI).

After the handshake, the client establishes a session by capability: `session/resume` (preferred) → `session/load` (fallback) → `session/new` (last resort).

### 2.2 `session/new`

- The request always carries `{ cwd, mcpServers: [] }`. The `mcpServers` field **is always present** (possibly an empty array) — at minimum tolerate it; accepting it is compliance, connecting is the agent's own business.
- Minimal response: `{ sessionId }`. Optional `modes` / `configOptions` — returning them unlocks the matching features (§5).
- An agent requiring login may reject with `-32000 auth_required`, provided `authMethods` was declared at `initialize` (§5.3).

### 2.3 `session/prompt` — the turn loop

- Request: `{ sessionId, prompt: ContentBlock[] }`. Content blocks can only be `text` and `image`, and `image` appears only after `promptCapabilities.image: true` is declared (otherwise the client rejects images locally — they never reach the wire).
- **The RPC stays pending for the whole turn**: stream `session/update` notifications while working, respond `{ stopReason }` only when the turn ends.
- `stopReason` enum: `end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`. Everything except `end_turn` surfaces as a user-visible turn-ending notice.
- The response's `usage` (UNSTABLE) is ignored by the client — report context occupancy via `usage_update` notifications (the `used`/`size` pair, not a cumulative tally).

### 2.4 `session/update` — the output channel

- **Minimum to hold a conversation**: at least `agent_message_chunk` (text content blocks) during turns.
- **SHOULD** echo user messages via `user_message_chunk`: the client has an optimistic echo with reconciliation and renders fine without it, but the echo is the audit trail of *what the agent actually received*.
- Every notification **MUST carry the correct `sessionId`**: the client filters per session and loudly drops updates for the wrong one (single exception: before the client's own session exists, updates pass through — that serves `session/load` replay).
- See §4 for the kind-consumption table and content-block boundaries; unknown kinds are never lost — preserved as unsupported events with a warning (forward-compatible, vendor-extension safe).

### 2.5 `session/cancel` — cancellation (SHOULD)

The client's cancel button sends this notification. On receipt: stop model requests as soon as possible, abort in-flight tool calls, flush any un-sent `session/update`, and settle the pending `session/prompt` with `stopReason: "cancelled"`.

It works without it: the client settles its own permission waiters as cancelled, so the UI never deadlocks; but cancellation itself is dead — the turn keeps running to its natural end.

## 3. Client callbacks: the four methods Panda answers

The complete set of client-side handlers Panda registers:

| Method | Type | Purpose |
| --- | --- | --- |
| `session/request_permission` | request | tool-execution approval |
| `elicitation/create` | request | form/url elicitation; both modes are declared |
| `session/update` | notification | inbound direction — see §2.4 and §4 |
| `elicitation/complete` | notification | out-of-band completion signal for url mode |

**Every other client-side method — `fs/read_text_file`, `fs/write_text_file`, `terminal/*` — gets `-32601 Method not found`.** This is the v1 shard Panda deliberately does not implement (v2 removes that execution surface entirely; the replacement path is a client MCP server — see the host-shard design in `src/capabilities.ts`).

### 3.1 Permission-flow contract (from the agent's point of view)

- **Concurrency is legal**: multiple `session/request_permission` may hang at once; the client answers each independently, keyed by `${sessionId}:${toolCallId}`.
- **Re-send semantics**: re-sending under the same key first answers the old request `cancelled`, then hangs the new one — never assume the old one is still waiting.
- **Cancellation paths**: on turn cancel or disconnect, all pending permissions are answered `cancelled`; the agent may also send `$/cancel_request` to withdraw a request it no longer needs.
- **Auto-answers are possible**: the client has a host policy and per-session `always` memory; the agent only ever sees the outcome (`selected` / `cancelled`) and need not know who chose.
- Offer at least one reject-type option — an allow-only permission card leaves the user no way to say no.

### 3.2 Elicitation-flow contract

- Both `form` and `url` modes are declared; an undeclared mode gets `decline` (never hangs).
- **url mode is two-phase**: when the user clicks "open link" the RPC ends with `accept`; the flow's completion is the agent's `elicitation/complete` notification (matched by `elicitationId`).
- Request-scoped elicitations before any session exists (no `sessionId`) are the auth phase's exclusive channel and render on the login card.
- Form fields support string / number / integer / boolean / multiselect (array); unknown field types render as inert unsupported rows — never dropped.

## 4. Wire details: `session/update` kinds and content blocks

### 4.1 Kind-consumption table

| Handling | Kinds |
| --- | --- |
| Rendered in flow | `user_message_chunk` (text/image), `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`*, `plan_removed`, `compaction_update`, `compaction_summary_chunk`, `usage_update`, `current_mode_update`, `available_commands_update`, `config_option_update` |
| Session-level latest kept | `session_info_update` (`title` / `updatedAt`, drives the sidebar) |
| Unknown kinds | warned + preserved as unsupported events (forward-compatible) |

\* `plan_update` is UNSTABLE: the `items` variant reaches the plan dock; `file` / `markdown` variants degrade to unsupported blocks.

### 4.2 Content-block and tool-content boundaries

- Content blocks: `text` / `image` render; `audio` / `resource` etc. degrade to unsupported.
- Tool content: `diff` and `content` (containing text/image) render; `terminal` and other kinds render as unsupported rows.
- A `tool_call`'s `rawInput` / `rawOutput` must be JSON objects; non-objects are dropped with a warning.
- **Every tool card MUST reach a terminal state**: `tool_call_update` pushes status to `completed` / `failed` / `cancelled`. Miss it and the card stays "running" forever (the real bug fixed in #75; the e2e suite now pins a terminal state for every card).

## 5. Recommended implementation: ranked by UX cost

None of these are entry requirements, but each omission has a clear user-visible cost. Master table (the "surface" column doubles as an `initialize` capability-declaration cheat sheet):

| # | Feature | Surface | Cost if missing | Tier |
| --- | --- | --- | --- | --- |
| 1 | Session persistence | `sessionCapabilities.resume` + `session/resume`; `loadSession: true` + `session/load` | every disconnect/reopen loses all history; no browsing past sessions | 1 |
| 2 | Session list | `sessionCapabilities.list` + `session/list` (`nextCursor` pagination) | sidebar finds no old sessions | 1 |
| 3 | In-turn visibility | `agent_thought_chunk`; `tool_call`/`tool_call_update` (with terminal states) | execution is a black box; long turns look hung | 1 |
| 4 | Cancellation | `session/cancel` (§2.5) | a runaway turn can only be waited out or the connection dropped | 1 |
| 5 | Session metadata | `session_info_update` (`title` / `updatedAt`) | sidebar full of untitled sessions; stale relative times | 2 |
| 6 | Image input | `promptCapabilities.image: true` | images can never be sent from the UI | 2 |
| 7 | Session config | `configOptions` + `session/set_config_option` + `config_option_update` | model/toggles can't be changed in-app | 2 |
| 8 | Context gauge | `usage_update` | compaction/truncation ambushes the user | 2 |
| 9 | Session deletion | `sessionCapabilities.delete` + `session/delete` | session list only ever grows | 2 |
| 10 | Session close | `sessionCapabilities.close` + `session/close` | agent runtime state leaks until process restart | 2 |
| 11 | Login | `authMethods` + `authenticate` + `logout` + `-32000` | gated without declaring: instant disconnect (de-facto MUST) | 3 |
| 12 | Plan dock | `plan` / `plan_update` (items variant) | no progress anchor on planned long tasks | 3 |
| 13 | Command completion | `available_commands_update` | no slash-command autocomplete | 3 |
| 14 | Session modes | `modes` + `session/set_mode` + `current_mode_update` | no mode switcher | 3 |
| 15 | Context compaction | `compaction_update` + `compaction_summary_chunk` | transcript mutates without explanation | 3 |

### 5.1 Tier one: core experience visibly broken

**Session persistence (at least one of the two; both is best).** `resume` and `load` differ in emphasis: resume is the reconnect-preferred path (no replay, instant); load is history switching and the reconnect fallback (rebuilds the document by replay). Resume only: fast reconnects but no browsing history. Load only: browsing works but every reconnect replays everything. Semantic boundary: `close` releases this connection's runtime state and *keeps* persisted history (a later `load` still works); `delete` erases — a later `load` must say Session not found.

**Session list.** The sidebar's session list comes entirely from `session/list` results (endpoint memory included). The client loops `nextCursor` until exhausted — pagination is not optional, implement it correctly.

**In-turn visibility.** With message blocks alone, execution is a black box: the thought stream drives the "thinking" animation, tool cards are the main progress anchor, and every card must reach a terminal state (§4.2).

**Cancellation.** See §2.5 — without it the user has no answer to a runaway turn except dropping the connection (and losing it entirely).

### 5.2 Tier two: clearly felt in daily use

**Session metadata.** Deriving the title deterministically from the first user message costs zero extra model calls (reference: `test-agent/src/sessionTitles.ts`); pushing `updatedAt` per turn keeps the sidebar's relative times alive.

**Image input.** A multimodal-capable model left undeclared means images can never be sent from the UI (the client rejects locally).

**Session config.** Select writes carry no `type`; boolean writes carry an explicit `type: "boolean"`. The response should carry the **full** updated `configOptions` (changing one may affect others), followed by a `config_option_update` notification — the confirm-driven RPC plus idempotent notification is the normal dual path, pinned by e2e.

**Context gauge.** The status bar's `used`/`size` pair; without it on long sessions the user has no warning before compaction or truncation.

**Session deletion / close.** Delete keeps the list cleanable; close lets the client tell the agent to release runtime state on switch/disconnect — without it, a long-lived service leaks one runtime state per session switch until process restart.

### 5.3 Tier three: recommended only with the matching capability

**Login (the auth four-piece).** The moment an agent needs login, this is a de-facto MUST: declare `authMethods` → login card → `authenticate(methodId)` (request-scoped url elicitations may run the OAuth flow meanwhile) → the client auto-retries session establishment on success. Throwing `-32000` without declaring anything is an instant client disconnect. `logout` is callable only after declaring `auth.logout`.

**Plan dock / command completion / session modes / context compaction.** Respectively for: planned long tasks (multi-step refactors, research), a stable command surface (trigger words, quick actions), an ask/code-style mode concept, and agents that compact context themselves. Modes work like config: after a successful RPC, also send `current_mode_update`, landing idempotently on the same state. Compaction must be reported — unreported, the transcript mutates without explanation, and the user cannot tell "the agent compacted" from "the agent lost history".

## 6. Timing and timeout constraints

| Item | Budget | On expiry |
| --- | --- | --- |
| Control-plane RPCs: `initialize`, `session/new`, `session/load`, `session/list`, `session/resume`, `session/delete`, `session/set_mode`, `session/set_config_option`, `logout` | **30 s** (`CONTROL_REQUEST_TIMEOUT_MS`) | agent judged hung; the whole connection is torn down |
| `session/prompt` | unbounded | a turn runs as long as it runs; the user bounds it with cancel |
| `authenticate` | unbounded | OAuth waits on the user out-of-band |
| `session/close` | 1.5 s (client-side race) | the client drops the wire |

Timing advice:

- **Send lifecycle companion notifications after the corresponding RPC response** (e.g. `available_commands_update` after `session/new`): before the response the client hasn't adopted that `sessionId` yet — it passes through, but don't rely on the ordering; the reference implementation pins the practice with an after-response helper.
- **Stream `session/load` history replay before the load response**: the client routes to the target session before sending the request (a stage→commit transaction), so pre-response replay lands on the staged document and the response commits it.
- Notifications must carry the same `sessionId` throughout the session (after a reconnect-resume too).

## 7. Non-goals: methods neither side exercises

Panda never sends: `document/didOpen|didChange|didClose|didSave|didFocus`, `nes/*`, `providers/*` (UNSTABLE), `session/fork` (UNSTABLE, not wired in the client). Implementing them is irrelevant to integration.

Panda never implements (restating §3's red line): `fs/*`, `terminal/*` — calling them gets `-32601`.

## 8. Verification channels

- **Full reference implementation**: `test-agent/` (the self-built ACP shell: session four-piece, both elicitation modes, compaction, plan, usage, commands, mode notifications, auth — all implemented). Start it with `pnpm --filter panda-test-agent serve`.
- **Third-party compatibility baseline**: the Claude Code contract tests (#154/#156): `src/acp/claudeCodeContract.test.ts` replays recorded real-traffic fixtures in CI; `PANDA_CLAUDE_CODE_E2E=1` goes live.
- **Client behavior unit tests**: `src/acp/LiveAcpClient.test.ts`, `src/acp/wire.test.ts`.
