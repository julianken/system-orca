# Subagent prompt snippet

Paste this block into a dispatched subagent's prompt with the templated fields filled in. The orchestrator substitutes `{WORKFLOW_ID}` and `{STAGE_ID}` at dispatch time.

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

## Placeholders

- `{WORKFLOW_ID}` — the workflow id minted by `system-orca init`. Format: `wf_<YYYY-MM-DD>_<4hex>` by default; any value matching `/^[a-z0-9_-]{1,64}$/` is accepted by the server.
- `{STAGE_ID}` — the orchestrator-assigned id for this subagent's stage. The orchestrator owns naming and uniqueness within a workflow.

## Why curl

Subagents may not have `node` on their PATH or the `system-orca` CLI installed. `curl` is the lowest-friction publisher. The orchestrator can substitute `system-orca event ...` for an internal subagent if it's running in the same shell environment.

## See also

- [`event-schema.md`](./event-schema.md) — the full envelope, every event type, and the projection's out-of-order policy.
