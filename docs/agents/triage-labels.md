# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

This repo adds a sixth state role beyond the canonical five:

| Label in our tracker | Meaning                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `claimed`            | Claimed and being worked on; the claim comment names the worktree/branch |

Claim protocol:

- **Claim**: swap `ready-for-agent` / `ready-for-human` for `claimed`
  (replace, not add — the exactly-one-state-role invariant still holds),
  and post a one-line comment naming the claiming worktree/branch
  (all local agents share one GitHub account, so the comment is the
  attribution). `gh issue edit <n> --remove-label ready-for-agent
  --add-label claimed`. Wayfinder child tickets carry a type label
  (`wayfinder:<type>`) rather than a state role, so they simply gain
  `claimed` — see `issue-tracker.md`.
- **Done**: close the issue. There is no `done` label — closing is the
  terminal state.
- **Discovery**: `claimed` issues are in flight — exclude them from the
  "needs attention" buckets and from "what's ready to pick up" queries.
  Liveness is judged via the worktree/branch the claim comment names
  (a stale `claimed` label whose worktree/branch no longer exists means
  the session died; reclaim by removing `claimed` and restoring the role
  it was claimed from — `ready-for-agent` / `ready-for-human`).

All six labels exist in the repo's GitHub labels; the mapping is the identity, so no per-skill translation is needed.