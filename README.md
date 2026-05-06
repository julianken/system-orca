# system-orca

A Claude Code plugin that gives multi-step or multi-agent workflows a live, browser-viewable dashboard. The first time it's invoked it starts a tiny local node server; every agent participating in a workflow (the orchestrator + every subagent) publishes events to it. A cards page at `http://127.0.0.1:8765/` lists every running workflow; clicking a card opens a detail view with a stages list and a mermaid DAG that live-updates every two seconds.

## Status

**Pre-implementation.** Design is settled; v1 implementation plan was written and approved through a planner/critic loop on 2026-05-05. See [docs/SPEC.md](docs/SPEC.md) and [docs/PLAN.md](docs/PLAN.md). Audit trail of the critic loop in [docs/critic-verdict-r1.json](docs/critic-verdict-r1.json), [-r2.json](docs/critic-verdict-r2.json), [-r3.json](docs/critic-verdict-r3.json).

## v1 (base) and v2 (wave-mode)

- **v1 base** — generic event bus + cards index + per-workflow stages + mermaid topology view. Approved, ready for phase-1 implementation.
- **v2 wave-mode** — opt-in layer for epic-driven GitHub orchestrations (waves of bands of issues, 10-step per-issue pipeline, GitHub coupling, mergify state, bot review cycles, critical-path computation). Sketched at the bottom of [docs/SPEC.md](docs/SPEC.md). Deferred until v1 has driven at least one real workflow.

## Architecture (one paragraph)

Append-only `events.jsonl` per workflow + a pure projection function in node = current state. Server (`node:http`, zero npm dependencies) exposes `POST /api/events` for publishing and `GET /api/workflows[/<id>]` for reading. Browser polls every 2 seconds. Mermaid is vendored offline-safe (`mermaid@10.9.1`, sha256 verified at install). The `system-orca` CLI gives the orchestrator ergonomic shell commands (`up`, `init`, `event`, `archive`, `list`, `tail`, `down`); subagents that don't have node on PATH can fall back to raw `curl`.

## Install (when implemented)

This plugin is installed via the standard Claude Code plugin mechanism. Until v1 ships, the only way to use it is to read the spec.

## Implementation note: path conventions

The approved plan ([docs/PLAN.md](docs/PLAN.md)) and design spec ([docs/SPEC.md](docs/SPEC.md)) were written before this work was migrated into plugin form (2026-05-05). When reading those documents, translate:

- `~/.claude/skills/system-orca/` → **plugin source root**. During development, this is `~/repos/system-orca/` (this repo). When installed via Claude Code's plugin mechanism, it'll be the cached install path. The CLI resolves its own location via `__dirname`, so this works regardless.
- `~/.claude/system-orca/` → **runtime root**. Unchanged. Server pidfile, log, and per-workflow `events.jsonl` files always live here, independent of plugin install location.

## License

MIT — see [LICENSE](LICENSE).
