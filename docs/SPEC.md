# system-orca — design spec

**Status:** v1 base = approved (planner/critic loop closed 2026-05-05). v2 wave-mode layer = sketched, deferred.
**Date:** 2026-05-05
**Owner:** Julian
**Versions:** v1 (base) ships first; v2 (wave-mode layer) is opt-in and additive.

## Goal

A user-level Claude Code skill that gives the orchestrator a live, browser-viewable
dashboard of any multi-step or multi-agent workflow it's running. Every agent
participating in the workflow (the orchestrator itself, every dispatched
subagent) publishes structured events to a single local server. The server
projects events into a current-state view, renders an index of all running
workflows as cards on `/`, and renders a detail page per workflow at `/w/<id>`
with two views: a stages list (rich) and a mermaid DAG (topology + status).

The motivating scenario is the existing `agentic-bridge` pipeline at
`docs/agentic-bridge/` — a stage tree with critics, fan-out specialists, and a
nested 5→5→3→1 analysis funnel. The skill must support that shape generically,
without baking that workflow into the schema.

## Non-goals

- Remote access. Bind 127.0.0.1 only; if remote is wanted later, SSH-tunnel.
- Auth or multi-user support.
- WebSocket / SSE push. 2-second polling is sufficient.
- A database. JSONL append-only logs are the storage; state is projected on demand.
- A frontend framework. Vanilla HTML + a small `app.js`. Mermaid is the only
  client-side library, vendored at `server/static/vendor/mermaid.min.js` so
  the dashboard works offline (no CDN dependency).
- Auto-archival or auto-deletion of completed workflows. User runs
  `system-orca archive` explicitly.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                       ~/.claude/skills/system-orca/                          │
│                                                                              │
│  SKILL.md          orchestrator-loaded trigger + how-to-use                  │
│  SPEC.md           this file                                                 │
│  bin/system-orca   CLI entrypoint (#!/usr/bin/env node)                      │
│  server/                                                                     │
│    server.js       node http server, zero deps                              │
│    state.js        events.jsonl → projected state (pure function)           │
│    mermaid.js      state → mermaid flowchart string (pure function)         │
│    static/                                                                   │
│      index.html    cards page                                               │
│      workflow.html detail page (Stages tab + Diagram tab)                   │
│      app.js        shared polling + render code                             │
│  references/                                                                 │
│    event-schema.md canonical event types and payloads                       │
│    subagent-snippet.md copy-paste prompt for subagents                      │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                ~/.claude/system-orca/      (runtime state)                   │
│                                                                              │
│  server.pid        pid of running server (absent ⇒ not running)             │
│  server.log        nohup stdout+stderr                                       │
│  workflows/                                                                  │
│    wf_<YYYY-MM-DD>_<4hex>/                                                   │
│      meta.json     title, goal, started_at, status, archived flag           │
│      events.jsonl  append-only log; one JSON event per line                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data flow

1. Orchestrator runs `system-orca up` — idempotent server-spawn check.
2. Orchestrator runs `system-orca init --title … --goal …` — creates a workflow
   directory, writes meta.json, emits `workflow_init` event, prints id + URL.
3. Orchestrator emits `plan_declared` — a single event carrying the full DAG of
   stages it intends to run, so the diagram is complete from t=0.
4. As work proceeds, the orchestrator (and dispatched subagents) emit
   `stage_start`, `stage_update`, `stage_complete`, `stage_fail` events.
5. Each event is one POST to `/api/events`, written to events.jsonl with
   `O_APPEND`. Concurrent writers are kernel-safe.
6. Browser pages poll `/api/workflows/<id>` every 2s for state and
   `/api/workflows/<id>/diagram.mmd` for mermaid source.

### Why event-sourced

- Concurrent subagents can publish without coordination.
- Server crash is recoverable — projection rebuilds from log.
- Audit history is free; no extra logging needed.
- Adding a new derived view later (timeline, sparkline, gantt) is a new
  projection over the existing events.

## Event schema

Canonical envelope:

```jsonc
{
  "ts": "2026-05-05T00:14:22.317Z",     // ISO-8601 UTC, server fills if absent
  "workflow_id": "wf_2026-05-05_a8f3",   // required
  "agent": "orchestrator" | "stage-1" | "critic-1" | "...",
  "type": "<see types below>",
  "stage_id": "1" | "phase-2-iter-3" | null,
  "data": { /* type-specific */ }
}
```

### Event types

| `type` | Emitter | `data` shape | Effect on projected state |
|---|---|---|---|
| `workflow_init` | orchestrator | `{title, goal, artifact_root?}` | creates workflow, sets meta |
| `plan_declared` | orchestrator | `{stages: [{id, label, name, type, blocked_by?, parent_id?, fanout?, model?, ...}]}` | bulk-registers all stages with status=`blocked` if they have unmet `blocked_by`, else `pending` |
| `stage_register` | orchestrator | `{id, label, name, type, blocked_by?, parent_id?, ...}` | adds one stage (use when plan was incomplete) |
| `stage_start` | the stage's agent | `{started_at?}` | marks stage `running`, records timestamp |
| `stage_update` | the stage's agent | `{summary?, key_findings?, open_questions?, percent?}` | merges into stage; status unchanged |
| `stage_complete` | the stage's agent | `{summary?, key_findings?, artifact?, artifact_size_bytes?, verdict?}` | marks `completed`, records timestamp, unblocks dependents |
| `stage_fail` | the stage's agent | `{summary?, error?, verdict: "COURSE_CORRECT" | "FAIL"}` | marks `failed` |
| `workflow_complete` | orchestrator | `{summary?}` | marks meta.status=`completed` |
| `note` | orchestrator | `{text, level?: "info" | "warn" | "error"}` | appended to feed only; doesn't affect stages |

### Notes on the schema

- **`plan_declared` is required for the diagram to look complete from t=0.**
  If omitted, mermaid renders only stages registered so far and grows as the
  workflow progresses.
- **Orchestrator assigns all stage IDs**, including children of fan-outs. The
  server does not auto-assign. Convention: parent `phase-1`, children
  `phase-1-a`, `phase-1-b`, etc., or `phase-1/1`, `phase-1/2`. Free choice as
  long as IDs are unique within a workflow.
- **`blocked_by` carries the topology.** A stage with `blocked_by: ["1"]` waits
  for stage 1 to be `completed` before its own `pending → running` transition is
  considered valid. The server doesn't enforce it; the orchestrator is
  responsible for dispatch order.
- **`parent_id` is for visual nesting only.** Mermaid uses it to group children
  of a fan-out under a header. Not used for status logic.

## Server (node, no npm install)

"Zero deps" here means no `package.json`, no `node_modules` — only Node's
stdlib (`node:http`, `node:fs`, `node:path`, `node:util`, `node:crypto`,
`node:child_process`). Requires Node ≥ 20 for `crypto.randomUUID` and
`util.parseArgs`.

### Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `static/index.html` |
| GET | `/w/<id>` | `static/workflow.html` (the page reads `<id>` from `location.pathname`) |
| GET | `/api/health` | `{status: "ok", uptime_s, started_at}` |
| GET | `/api/version` | `{name: "system-orca", version: "<semver>", commit: "<sha-or-null>"}` — required for `up` to identify "is this our server" before reusing a held port |
| GET | `/api/workflows` | `[{id, title, goal, started_at, last_event_at, status, stage_count, completed_count, archived}, …]` — sorted by `last_event_at` desc |
| GET | `/api/workflows/<id>` | full projected state — see "State projection" below |
| GET | `/api/workflows/<id>/diagram.mmd?include_status=true` | `text/plain` mermaid source |
| GET | `/api/workflows/<id>/events.jsonl` | raw event log, for debugging / external tooling |
| POST | `/api/events` | accepts a single event, appends to events.jsonl, returns `{ts, accepted: true}` |
| POST | `/api/workflows/<id>/archive` | marks `archived: true` in meta.json |
| GET | `/static/<file>` | serves `server/static/<file>` |

### Concurrency

Each event POST opens the workflow's `events.jsonl` with `fs.createWriteStream(path, {flags:"a"})`, writes one `JSON.stringify(event) + "\n"`, closes. POSIX `O_APPEND` makes each `write(2)` syscall atomic with respect to the file's end-of-file pointer — no interleaving between seek-to-end and write. The risk is at a higher layer: Node's `fs.appendFile` / `createWriteStream` may issue multiple `write(2)` syscalls for a single logical append when buffers are large, and concurrent appends could interleave between those syscalls. To guarantee that one JSON event lands as one contiguous line, the server holds a process-local mutex keyed by `workflow_id` that serialises appends within the server process. Multiple server processes are not supported (singleton enforced via pidfile); if the user circumvents the singleton, multi-process appends to the same `events.jsonl` may interleave.

(Note: PIPE_BUF is irrelevant here — it governs atomic-write size for *pipes*, not regular files. The mutex is justified by the userspace-write-splitting risk above, not by pipe semantics.)

### Out-of-order events

The projection must not crash on events arriving in unexpected order. Specifically:

- A `stage_start` / `stage_update` / `stage_complete` / `stage_fail` whose `stage_id` was never registered (no preceding `stage_register` or matching entry in a `plan_declared`) is **dropped from the stage projection**, and a `feed` entry of type `warning` is emitted: `{ts, agent, type:"note", data:{level:"warn", text:"out-of-order: <type> for unregistered stage <stage_id>"}}`. The original event remains in `events.jsonl` for audit.
- A duplicate `stage_register` for an already-registered `stage_id` overwrites the existing entry's static fields (label/name/blocked_by) but preserves any status transitions.
- A second `plan_declared` is treated as additive: each stage in the new payload merges by `id` (overwriting static fields, preserving status). This supports re-plans without resetting in-flight state.
- A `stage_complete` for a stage already in `completed` or `failed` is ignored with a warning feed entry.

### State projection (`state.js`)

Pure function. Reads events.jsonl, folds left:

```ts
function project(events: Event[]): WorkflowState {
  const meta = { /* from workflow_init */ };
  const stages = new Map<string, Stage>();
  const feed: FeedEntry[] = [];

  for (const e of events) {
    switch (e.type) {
      case "workflow_init":   meta = {...e.data, started_at: e.ts}; break;
      case "plan_declared":   for (const s of e.data.stages) stages.set(s.id, {...s, status: deriveStatus(s, stages)}); break;
      case "stage_register":  stages.set(e.data.id, {...e.data, status: deriveStatus(e.data, stages)}); break;
      case "stage_start":     mutate(stages.get(e.stage_id), {status: "running", started_at: e.ts}); break;
      case "stage_update":    merge(stages.get(e.stage_id), e.data); break;
      case "stage_complete":  mutate(stages.get(e.stage_id), {status: "completed", completed_at: e.ts, ...e.data}); unblockDependents(stages); break;
      case "stage_fail":      mutate(stages.get(e.stage_id), {status: "failed", ...e.data}); break;
      case "workflow_complete": meta.status = "completed"; break;
      case "note":            feed.push({...e}); break;
    }
    feed.push(toFeedEntry(e));
  }

  return { meta, stages: [...stages.values()], feed };
}
```

This runs on every `GET /api/workflows/<id>`. For realistic event counts
(<10k per workflow) it's microseconds. If a workflow ever gets huge, we add
projection caching keyed on `events.jsonl` size — but YAGNI for now.

### Mermaid generation (`mermaid.js`)

Pure function `stateToMermaid(state, opts) → string`. Algorithm:

1. Build adjacency: for each stage `s`, edges from each `s.blocked_by[i]` → `s.id`.
2. Render header `flowchart TD`.
3. For each stage emit `<id>[<label>: <name>]:::<status>`.
4. For each parent group, emit a mermaid `subgraph` block to nest children.
5. Emit edges.
6. Append `classDef` blocks tying status to colors:

```mermaid
classDef pending   fill:#27272a,color:#a1a1aa,stroke:#3f3f46
classDef blocked   fill:#27272a,color:#71717a,stroke:#3f3f46,stroke-dasharray:3 3
classDef running   fill:#84cc16,color:#000,stroke:#22c55e,stroke-width:2px
classDef completed fill:#22c55e,color:#fff,stroke:#16a34a
classDef failed    fill:#ef4444,color:#fff,stroke:#dc2626
classDef critic    fill:#0ea5e9,color:#fff,stroke:#0284c7
```

Colours match the existing `agentic-bridge/status.html` palette so the visual
language is consistent across the two views.

## CLI (`bin/system-orca`)

Single file, `#!/usr/bin/env node`. Uses `node:util.parseArgs`. Subcommands:

| Subcommand | Behaviour |
|---|---|
| `up` | If `~/.claude/system-orca/server.pid` exists and the process is alive, **and** `GET /api/version` returns `{name:"system-orca", ...}`, no-op. If pidfile exists but `GET /api/version` returns wrong shape (or 404), the held port belongs to a foreign process — error with the held PID and instructions to free the port. Else: spawn `nohup node <skill_dir>/server/server.js >server.log 2>&1 &` (path resolved via `__dirname` so the CLI works from any cwd), write pid, wait for `/api/version` to return correct shape, print URL. |
| `down` | Read pid, SIGTERM, wait for exit. Remove pidfile. |
| `status` | Print up/down + URL + count of workflows by status. |
| `init --title "…" --goal "…" [--id <forced-id>]` | Mints workflow_id `wf_<YYYY-MM-DD>_<4hex>`, POSTs `workflow_init`, prints `id\nurl`. |
| `event --workflow <id> --type <type> [--stage-id <id>] [--data <json>]` | POSTs to `/api/events`. `--data` accepts inline JSON or `@file.json`. |
| `plan --workflow <id> --file <path>` | Convenience: reads a JSON file with `{stages: [...]}`, emits a `plan_declared` event. |
| `list [--all]` | GET `/api/workflows`, prints table. `--all` includes archived. |
| `archive <id>` | POST `/api/workflows/<id>/archive`. |
| `tail <id>` | `tail -f` on the workflow's events.jsonl, pretty-printed. Useful for debugging. |

On first `up`, CLI symlinks itself to `~/.local/bin/system-orca` if that
directory exists and is on PATH; if not, prints the absolute path the user
should add to PATH or alias.

## Pages

### Index (`/`)

Vanilla HTML + a script that polls `/api/workflows` every 2s. Cards layout:

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ ● running                           │ ✓ complete                          │
│ Agentic Bridge — Multi-Stage…       │ Frontend redesign exploration       │
│ Bridge agentic-dev pattern gap…     │ Compare 3 candidate Tailwind…       │
│ stage 5/7  ·  started 23:34         │ stage 9/9  ·  ran 47m               │
│ last update 30s ago                 │ completed 14:22                     │
│                            →        │                            →        │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

Status pill colours derived from card's `status` field. Click any card →
`/w/<id>`. Default filter hides archived; toggle shows them with reduced
opacity.

### Detail (`/w/<id>`)

Two tabs:

- **Stages** (default): the existing `status.html` layout — vertical stage list
  with status pills, summaries, key findings, open questions, verdict, artifact
  links, plus the updates feed at the bottom. Generalised to read from
  `/api/workflows/<id>` instead of polling `STATUS.json` directly.
- **Diagram**: full-width mermaid render of the workflow DAG. Polls
  `/api/workflows/<id>/diagram.mmd` every 2s; only re-renders when the source
  string changed.

Tab state persisted to `localStorage` so the user's preferred view is sticky.

## Trigger and how the orchestrator uses it

### Skill description (the trigger string)

```
Use this skill when:

  (a) The user explicitly asks for a dashboard, status view, or live progress
      tracking — phrases like "show me a dashboard", "open the orca",
      "watch this run".

  (b) You are about to start any multi-step or multi-agent workflow — subagent
      fan-out, analysis funnel, multi-stage research pipeline, or any
      orchestration with ≥2 parallel agents or ≥3 sequential stages. In this
      case, INVITE THE USER FIRST: "I'm about to dispatch N subagents for X.
      Want a live dashboard at http://127.0.0.1:8765/ to watch?" Only spin up
      if they say yes.

  Don't use for: trivial single-agent tasks, quick fixes, conversational replies.
```

### Orchestrator workflow (case (a) or accepted (b))

```bash
# 1. Ensure server is running.
system-orca up
# → server up at http://127.0.0.1:8765

# 2. Mint the workflow.
WORKFLOW_ID=$(system-orca init --title "..." --goal "..." | head -1)

# 3. Declare the full plan up-front so the diagram is complete from t=0.
system-orca plan --workflow "$WORKFLOW_ID" --file /tmp/plan.json
# (or)
system-orca event --workflow "$WORKFLOW_ID" --type plan_declared \
  --data '{"stages":[{"id":"1","label":"Stage 1","name":"Investigation"},...]}'

# 4. As work happens:
system-orca event --workflow "$WORKFLOW_ID" --type stage_start --stage-id 1
# ... stage 1 runs ...
system-orca event --workflow "$WORKFLOW_ID" --type stage_complete --stage-id 1 \
  --data '{"summary":"...", "key_findings":["..."]}'

# 5. When dispatching a subagent, paste the snippet from references/subagent-snippet.md
#    into its prompt with workflow_id and stage_id substituted.

# 6. When done:
system-orca event --workflow "$WORKFLOW_ID" --type workflow_complete
```

### Subagent snippet (in `references/subagent-snippet.md`)

The orchestrator pastes this into each subagent's prompt with the templated
fields filled in:

```
You are stage-{STAGE_ID} in workflow {WORKFLOW_ID}. The user is watching
progress at http://127.0.0.1:8765/w/{WORKFLOW_ID}.

When you start, run:
  curl -sX POST 127.0.0.1:8765/api/events \
    -H 'content-type: application/json' \
    -d '{"workflow_id":"{WORKFLOW_ID}","agent":"stage-{STAGE_ID}","type":"stage_start","stage_id":"{STAGE_ID}"}'

When you finish successfully, run:
  curl -sX POST 127.0.0.1:8765/api/events \
    -H 'content-type: application/json' \
    -d '{"workflow_id":"{WORKFLOW_ID}","agent":"stage-{STAGE_ID}","type":"stage_complete","stage_id":"{STAGE_ID}","data":{"summary":"...","key_findings":["..."]}}'

If you fail or hit a blocker, emit type:"stage_fail" with the same shape and
data:{"summary":"...","error":"..."}.

Optional progress updates: type:"stage_update" with data:{"summary":"...","percent":42}.
```

## Lifecycle

| Event | Behaviour |
|---|---|
| First `system-orca up` ever | Server spawned, pidfile written, port bound. |
| `up` when running | Health-check; no-op if healthy. If port is held by something else (not our server, e.g. user's `python -m http.server`), error loudly with a hint to choose a different port via `SYSTEM_ORCA_PORT` env var. |
| Server crashes mid-workflow | Orchestrator's next `event` POST fails. Orchestrator should re-run `up`, retry. Events.jsonl is the source of truth — projection rebuilds from log, no state loss. |
| Workflow done | Orchestrator emits `workflow_complete`. Card switches to ✓ complete. Stays visible. |
| User runs `archive <id>` | meta.json gains `archived:true`. Hidden from default index list. |
| User runs `down` | SIGTERM via pidfile. Workflows persist on disk. Next `up` resumes from disk. |
| Machine reboot | Server gone (no launchd integration in v1). Workflows persist on disk. Next `up` reads them. |

### Port

Default `8765` (matches existing prototype). Configurable via
`SYSTEM_ORCA_PORT` env var. URL printed by `up` reflects the actual port.

## Testing strategy

Manual end-to-end test as the first integration check: drive the live
`agentic-bridge` pipeline through this skill instead of the existing
hand-rolled STATUS.json. The skill must reproduce or exceed the current
dashboard's information density.

Unit tests for the two pure functions:

- `state.js::project(events)` — fold over a known event log, assert state shape.
- `mermaid.js::stateToMermaid(state)` — for a fixture state, assert the mermaid
  output contains the expected nodes, edges, and class assignments.

No integration tests for the server in v1; the manual end-to-end on
`agentic-bridge` is the validation gate.

## Known risks / future work

- **PIPE_BUF on Linux is 4096; on macOS 512.** Large events (long
  `key_findings` arrays with verbose findings) might exceed atomic-append size.
  Mitigated by per-workflow process-local mutex; a different process writing to
  the same file would interleave. Singleton enforcement via pidfile prevents
  that in practice.
- **Server is not daemonised across reboot.** v2 candidate: launchd plist that
  re-spawns on user login. Out of scope for v1.
- **No remote read.** If multiple developers want a shared dashboard, that's a
  separate skill (likely backed by a real DB and proper auth).
- **Diagram view performance.** Mermaid re-renders a flowchart in ~50ms for
  ~50 nodes; acceptable for the workflows envisioned. If a workflow ever
  registers hundreds of stages, render time becomes noticeable; out of scope.

## Implementation order (handed off to writing-plans next)

1. Server skeleton: `server.js` listening on 8765 with `/api/health`, static
   file serving, pidfile.
2. Append-only event ingestion: `POST /api/events` with per-workflow mutex.
3. Projection: `state.js` + `GET /api/workflows/<id>`.
4. Workflow listing: `GET /api/workflows`.
5. CLI: `up`, `down`, `init`, `event` (smallest useful surface).
6. Index page: cards layout, polling.
7. Detail page Stages tab: lift from `agentic-bridge/status.html`, rewire to
   `/api/workflows/<id>`.
8. Mermaid generation: `mermaid.js` + `GET /api/workflows/<id>/diagram.mmd`.
9. Detail page Diagram tab.
10. Remaining CLI: `list`, `archive`, `tail`, `plan`, `status`.
11. SKILL.md with trigger language and orchestrator instructions.
12. references/event-schema.md, references/subagent-snippet.md.
13. End-to-end validation against the live `agentic-bridge` pipeline.

---

## Wave-mode (v2 layer, opt-in, deferred)

A richer projection that the base event log can be extended into for orchestrations matching the *waves of bands of issues* execution pattern (epic-driven GitHub work where each issue moves through a fixed multi-step pipeline). It is **not** in v1. v1 ships the base — workflows, stages, mermaid, the CLI subcommands listed above. Wave-mode layers on top, opt-in via `workflow_init.data.mode = "wave"`, and is fully additive — it does not change any v1 endpoint, page, schema, or CLI subcommand.

### Why deferred

The base event bus and the cards index are durable; their value is generic. The wave-mode concepts (waves, bands, the 10-step issue pipeline, GitHub coupling, mergify state, bot review cycles, critical-path) are project-specific until proven otherwise. Locking the schema before two or three workflows have driven it risks bad shape. Ship base, port the live `agentic-bridge` orchestration onto it, then v2 wave-mode with empirical guidance from that.

### What wave-mode adds (architecture only — full schema is v2 work)

1. **Two-level hierarchy on top of stages.** `waves[] → bands[] → issues[]`. Each issue is also a stage in the base sense.
2. **Concurrency labels per band.** `1` = sequential, `N` = N parallel, `0` = tracker (never gates progression). Rendered as `4 parallel`, `sequential`, `tracker` in the dashboard.
3. **Per-issue 10-step pipeline.** Steps: `0_claim, 1_reconcile, 2_worktree, 3_implement, 4_gate, 5_bot_review, 6_verdict, 7_mergify, 8_verify_merge, 9_cleanup`. Statuses: `pending | running | done | failed | n/a`.
4. **GitHub coupling.** Each issue carries `github: {repo, issue_num, pr_num?, tier?, labels[]}`. The dashboard links cards to GitHub Issues / PRs.
5. **Bot review cycle counter.** Counts comments matching the literal text `Review verdict` on the linked PR. Card shows `c2/5`. Warns at ≥3, errors at ≥5.
6. **Critical path computation.** Server identifies the next-blocking issue / PR with an ETA hint; rendered as a top-of-dashboard banner.
7. **Escalations channel.** Issues bearing the `needs:human` label surface as a top-of-dashboard alert.
8. **Per-issue activity NDJSON.** Each issue accumulates its own append-only event log. Latest entry shows on the card with agent attribution (impl / bot / orchestrator / merged).
9. **Detail page variants.** `static/workflow-wave.html` (rich layout: summary cards, critical-path banner, escalations, waves, bands, issue cards). `static/issue-detail.html` (per-issue drill-in linked from each card).
10. **Heartbeat companion.** `system-orca heartbeat --workflow <id> --mode wave --github-repo <r> --github-epic <n>` runs a poll loop that updates wave fields from GitHub Issues / PRs / Mergify state — the equivalent of the live `wave-heartbeat.sh`, generalized into the skill.
11. **Side-monitor companion.** `system-orca monitor --workflow <id> --mode wave --github-repo <r>` runs the equivalent of the live `wave-pr-monitor.py` and emits PR-CHANGE / STALL / CI-PROBLEM events into the workflow's event log.

### Event types added in wave-mode (sketch only — full payloads in v2 spec)

- `wave_register {wave_id, name, layout, blocked_by?}`
- `band_register {wave_id, band_id, concurrency, gate_after?, note?}`
- `issue_register {issue_id, wave_id, band_id, github: {repo, issue_num, pr_num?, tier?}}`
- `step_set {issue_id, step_key, status}`
- `review_cycle {issue_id, cycle_n, verdict}`
- `critical_path_update {next_dispatch, blocking_issue?, blocking_pr?, eta?}`
- `escalation_add {issue_id, reason}` / `escalation_clear {issue_id}`
- `github_state_set {issue_id, issue_state, pr_state?, mergeable?, review_decision?}`

Base events (`stage_register`, `stage_start`, etc.) remain valid in wave-mode workflows. An `issue_register` is implicitly also a stage. Wave-mode events arriving in a base-mode workflow are dropped with a warning, same as the base out-of-order policy.

### Layering rule (the spine of v2)

The server's projection function reads `meta.mode` (set by `workflow_init`) and routes to one of:

- `project_base(events) → BaseState` — what v1 ships.
- `project_wave(events) → WaveState` — invokes `project_base` first, then folds wave-mode events on top to derive waves, bands, steps, github fields, critical-path, escalations.

The browser's detail page picks its template from the projected state's mode field. Index page treats both modes identically (they both render as cards with title / goal / status / last-event).

### Open questions for v2 design

(All deferred — listed for tomorrow-Julian to chew on.)

- Do `wave_register` / `band_register` belong as their own event types, or as `mode_data` on a `stage_register` with type `"wave"` / `"band"`? The former is cleaner schema; the latter is fewer event types.
- The 10-step pipeline: is it baked into wave-mode (v2 schema enforces these exact step keys), or a *configurable* step list per workflow? Configurable is more flexible but adds projection complexity.
- GitHub heartbeat: should it run inside the server process (one shared poll budget across workflows) or as a separate process per workflow (the current `wave-heartbeat.sh` model)? The first is more efficient; the second is failure-isolated.
- Critical-path computation: server-side (one canonical algorithm) or emitted by the orchestrator? Server-side gives consistency; emitted gives the orchestrator full control over heuristics.
- Should base-mode `mermaid` view also light up for wave-mode workflows (DAG of waves → bands → issues), or is the rich card layout enough?
