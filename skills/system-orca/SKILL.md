---
name: system-orca
description: |
  Live dashboard for multi-step or multi-agent Claude Code workflows.

  Use this skill when:

    (a) The user explicitly asks for a dashboard, status view, or live
        progress tracking — phrases like "show me a dashboard", "open the
        orca", "watch this run".

    (b) You are about to start any multi-step or multi-agent workflow —
        subagent fan-out, analysis funnel, multi-stage research pipeline,
        or any orchestration with ≥2 parallel agents or ≥3 sequential
        stages. In this case, INVITE THE USER FIRST: "I'm about to
        dispatch N subagents for X. Want a live dashboard at
        http://127.0.0.1:8765/ to watch?" Only spin up if they say yes.

    Don't use for: trivial single-agent tasks, quick fixes, conversational
    replies.
---

# system-orca

A local browser dashboard for multi-step / multi-agent workflows. Spawns a
zero-dependency Node HTTP server on `127.0.0.1:8765` the first time it's
used; every agent in a workflow (orchestrator + subagents) publishes events
to it, and a cards page at `http://127.0.0.1:8765/` lists every running
workflow with a live-updating Stages view and Mermaid diagram.

## How the orchestrator uses this skill

```bash
# 1. Ensure server is running.
system-orca up
# → server up at http://127.0.0.1:8765

# 2. Mint the workflow.
WORKFLOW_ID=$(system-orca init --title "Refactor auth flow" --goal "..." | head -1)

# 3. Declare the full plan up-front so the diagram is complete from t=0.
system-orca plan --workflow "$WORKFLOW_ID" --file /tmp/plan.json
# (or)
system-orca event --workflow "$WORKFLOW_ID" --type plan_declared \
  --data '{"stages":[{"id":"1","label":"Stage 1","name":"Investigation"}]}'

# 4. As work happens:
system-orca event --workflow "$WORKFLOW_ID" --type stage_start --stage-id 1
# ... stage 1 runs ...
system-orca event --workflow "$WORKFLOW_ID" --type stage_complete --stage-id 1 \
  --data '{"summary":"...", "key_findings":["..."]}'

# 5. When dispatching a subagent, paste the snippet from
#    references/subagent-snippet.md into its prompt with
#    {WORKFLOW_ID} and {STAGE_ID} substituted.

# 6. When done:
system-orca event --workflow "$WORKFLOW_ID" --type workflow_complete
```

## Subcommand exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage / runtime error (bad args, server unreachable, validation failed) |
| `2` | subcommand not implemented in this version |

## References

- [`references/event-schema.md`](../../references/event-schema.md) —
  every event type, the canonical envelope, the projection effect on
  stages and feed, and the out-of-order policy.
- [`references/subagent-snippet.md`](../../references/subagent-snippet.md)
  — paste this into a dispatched subagent's prompt with `{WORKFLOW_ID}`
  and `{STAGE_ID}` substituted.

## Useful endpoints (curl-friendly)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | liveness |
| `GET` | `/api/version` | identity probe used by `up` |
| `GET` | `/api/workflows` | list (sorted desc by `last_event_at`) |
| `GET` | `/api/workflows/<id>` | full projected state (`{meta, stages, feed}`) |
| `GET` | `/api/workflows/<id>/diagram.mmd` | mermaid source |
| `GET` | `/api/workflows/<id>/events.jsonl` | raw event log |
| `POST` | `/api/events` | publish an event |
| `POST` | `/api/workflows/<id>/archive` | archive |

## Constraints

- Server binds `127.0.0.1` only; no auth.
- Zero npm dependencies. `node:http` + stdlib. Requires Node ≥ 20.
- One server per machine — singleton enforced via pidfile at
  `~/.claude/system-orca/server.pid`.
- Per-workflow `events.jsonl` files at
  `~/.claude/system-orca/workflows/<id>/events.jsonl`.
