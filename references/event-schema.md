# Event schema reference

The event log for one workflow is `~/.claude/system-orca/workflows/<id>/events.jsonl` — append-only, one JSON object per line. The server's projection function (`server/state.js`) folds these events into `{meta, stages, feed}` on every read.

## Canonical envelope

```jsonc
{
  "ts": "2026-05-07T00:14:22.317Z",      // ISO-8601 UTC. Server fills if absent.
  "workflow_id": "wf_2026-05-07_a8f3",   // required; matches /^[a-z0-9_-]{1,64}$/
  "agent": "orchestrator",               // optional; defaults to "orchestrator"
  "type": "<see types below>",
  "stage_id": "1",                       // optional; null when n/a
  "data": { /* type-specific */ }
}
```

## Event types

| `type` | Emitter | `data` shape | Effect on projected state |
|---|---|---|---|
| `workflow_init` | orchestrator | `{title, goal, artifact_root?}` | Creates the workflow on disk: makes the directory, writes `meta.json` (`title`, `goal`, `started_at`, `status:"running"`, `archived:false`, `artifact_root`), and appends the event. |
| `plan_declared` | orchestrator | `{stages: [{id, label, name, type, blocked_by?, parent_id?, fanout?, model?, ...}]}` | Bulk-registers all stages with `deriveStatus` (`blocked` if any `blocked_by` references a non-completed stage, else `pending`). |
| `stage_register` | orchestrator | `{id, label, name, type, blocked_by?, parent_id?, fanout?, model?, ...}` | Adds one stage. Use when the plan was incomplete at `plan_declared` time. |
| `stage_start` | the stage's agent | `{started_at?}` | Marks stage `running`, records `started_at`. |
| `stage_update` | the stage's agent | `{summary?, key_findings?, open_questions?, percent?}` | Shallow-merges into the stage; status unchanged. |
| `stage_complete` | the stage's agent | `{summary?, key_findings?, artifact?, artifact_size_bytes?, verdict?}` | Marks `completed`, records `completed_at`, shallow-merges. Re-evaluates dependents — any blocked stage whose deps are now all completed flips to `pending`. |
| `stage_fail` | the stage's agent | `{summary?, error?, verdict: "COURSE_CORRECT" \| "FAIL"}` | Marks `failed`, records `completed_at`, shallow-merges. |
| `workflow_complete` | orchestrator | `{summary?}` | Sets `meta.status = "completed"`. |
| `note` | any | `{text, level?: "info" \| "warn" \| "error"}` | Appended to the feed only — no stage mutation. Used by the projection to surface out-of-order warnings (see below). |

### Examples

`workflow_init`:
```json
{"workflow_id":"wf_2026-05-07_a8f3","type":"workflow_init",
 "data":{"title":"Refactor auth","goal":"Split AuthN from AuthZ"}}
```

`plan_declared` with a chain + a critic + a fan-out:
```json
{"workflow_id":"wf_2026-05-07_a8f3","type":"plan_declared","data":{"stages":[
  {"id":"1","label":"Stage 1","name":"Investigate","type":"stage"},
  {"id":"1c","label":"Critic 1","name":"Review","type":"critic","blocked_by":["1"]},
  {"id":"2","label":"Stage 2","name":"Synthesize","type":"stage","blocked_by":["1c"]},
  {"id":"2a","label":"Stage 2a","name":"Branch A","type":"stage","parent_id":"2"},
  {"id":"2b","label":"Stage 2b","name":"Branch B","type":"stage","parent_id":"2"}
]}}
```

`stage_complete`:
```json
{"workflow_id":"wf_2026-05-07_a8f3","type":"stage_complete","stage_id":"1",
 "agent":"stage-1","data":{"summary":"investigated","key_findings":["fact1","fact2"]}}
```

## Field semantics

- **`agent` is optional, defaults to `"orchestrator"`.** Subagents should set it to `"stage-<id>"` or a more specific name (e.g. `"critic-1"`) so the feed is readable.
- **`type` is free-form on stages, with a `"critic"` special case in the renderer.** Any type renders as a generic stage in the Stages tab and as a node in the Mermaid diagram. `type: "critic"` triggers a dashed border in the UI and overrides the status colour with a critic-blue (`:::critic` in mermaid, regardless of the stage's status). Other domain-specific values (e.g. `"investigator"`, `"synthesizer"`) are preserved on the stage object and visible to clients but render generically in v1.
- **`fanout` is reserved/opaque pass-through for v1.** The server stores it on the stage object and exposes it via `/api/workflows/<id>`, but the v1 renderer does nothing special with it. v2 wave-mode will use it for visual fan-out grouping.
- **`parent_id` is for visual nesting only.** Mermaid groups children of a fan-out under a `subgraph`; the Stages tab nests them under the parent stage. It's not used for status logic — `blocked_by` is the only thing the projection consults for dependency state.
- **`blocked_by` carries the topology.** A stage with `blocked_by: ["1"]` waits for stage 1 to be `completed` before its `pending → running` transition is considered valid. The server doesn't enforce dispatch order; the orchestrator is responsible.

## Out-of-order policy

The projection is robust to events arriving out of order — it never throws, never drops state, and always produces a coherent `{meta, stages, feed}` document.

| Scenario | Projection behaviour |
|---|---|
| `stage_start` / `stage_update` / `stage_complete` / `stage_fail` whose `stage_id` is not in the stages map | The mutation is dropped from the stage projection. A warning entry is pushed to the feed: `{type:"note", level:"warn", text:"out-of-order: <type> for unregistered stage <id>"}`. The original event remains in the feed in file order as an audit trail. |
| Duplicate `stage_register` for an already-registered stage | Static fields (label, name, blocked_by, parent_id, type, model, fanout, ...) are shallow-merged onto the existing entry. Dynamic state (status, started_at, completed_at, summary, key_findings, open_questions, verdict, artifact, error) is preserved. |
| Second `plan_declared` after some have started | Additive: each stage in the new payload is treated as a duplicate `stage_register` if its id already exists, otherwise registered fresh with `deriveStatus`. |
| `stage_complete` on a stage already `completed` or `failed` | The mutation is ignored. A warning entry is pushed to the feed (`already-completed` or `already-failed`). |

## Identifier conventions

- `workflow_id`: orchestrator-minted. Default shape `wf_<YYYY-MM-DD>_<4hex>` from `system-orca init`. Server validation regex: `/^[a-z0-9_-]{1,64}$/`. Custom shapes are allowed via `--id`.
- `stage_id`: orchestrator-assigned, including children of fan-outs. Convention: parent `phase-1`, children `phase-1-a`, `phase-1-b`, or `phase-1/1`, `phase-1/2`. Free choice as long as IDs are unique within a workflow. The server treats `stage_id` as an opaque string.

## Server contract (HTTP)

Body cap: 1 MiB. Returns 415 on `content-type` other than `application/json`, 400 on parse failure or invalid envelope, 404 when an event other than `workflow_init` references a workflow that doesn't exist.

## See also

- [`subagent-snippet.md`](./subagent-snippet.md) — the prompt the orchestrator pastes into a dispatched subagent.
- [`docs/SPEC.md`](../docs/SPEC.md) — full server contract, page layout, and v2 wave-mode sketch.
