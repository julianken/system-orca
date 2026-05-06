# Claude Configuration

Project context and guidance for AI-assisted development on system-orca.

## Project Overview

A Claude Code plugin that gives multi-step or multi-agent workflows a live, browser-viewable dashboard. The first time it's invoked it starts a tiny local Node HTTP server on `127.0.0.1:8765`; every agent participating in a workflow (the orchestrator + every subagent) publishes events to it. A cards page at `http://127.0.0.1:8765/` lists every running workflow; clicking a card opens a detail view with a stages list and a mermaid DAG that live-updates every two seconds.

**Current phase:** Pre-implementation. Design approved 2026-05-05 through a 3-round planner/critic loop. Phase 1 (server skeleton + CLI `up`/`down`/`status`) is next.

## Quick Reference

```bash
node --check server/server.js       # syntax-only check, no execution
bin/system-orca up                  # start local server (127.0.0.1:8765)
bin/system-orca status              # up/down + workflow counts
bin/system-orca down                # SIGTERM + unlink pidfile
curl -fsS http://127.0.0.1:8765/api/health    # liveness
curl -fsS http://127.0.0.1:8765/api/version   # identity (used by `up`)
node --test tests/                  # tests (Phase 2 onwards)
```

Zero dependencies. No `package.json`, no `node_modules`. Node ≥ 20 stdlib only.

## Architecture

Append-only `events.jsonl` per workflow + a pure projection function in node = current state. `node:http` server exposes `POST /api/events` for publishing and `GET /api/workflows[/<id>]` for reading. Browser polls every 2 seconds. Mermaid is vendored offline-safe (`mermaid@10.9.1`, sha256 verified at install). The `system-orca` CLI gives the orchestrator ergonomic shell commands; subagents that don't have node on PATH can fall back to raw `curl`.

### Key directories

```
bin/                 # `system-orca` CLI executable
server/
├── server.js        # node:http server (Phase 1)
└── static/          # browser-served files
    ├── index.html   # cards page (Phase 5)
    ├── workflow.html# detail page (Phase 6)
    ├── app.js       # client-side polling (Phases 5–6)
    └── vendor/      # mermaid.min.js, sha256-verified (Phase 6)
skills/system-orca/  # plugin skill manifest + discovery metadata
references/          # long-form docs surfaced via the plugin
tests/               # node --test fixtures + assertions (Phase 2 onwards)
```

### Runtime root (NOT in this repo)

Per-workflow event logs and the server pidfile live at `~/.claude/system-orca/`, never inside the repo. The `.gitignore` guards against accidental copies.

## Coding Conventions

- **Files:** `kebab-case.js`, 2-space indent, LF line endings, UTF-8, final newline.
- **Node:** ≥ 20 stdlib only — `node:http`, `node:fs`, `node:path`, `node:util`, `node:crypto`, `node:child_process`. Nothing else.
- **Bind:** `127.0.0.1` only. Never `0.0.0.0`.
- **Commits:** conventional-commit format, see `AGENTS.md` for the type/scope tables.

## What Claude Should Know

### Path conventions

The approved plan was written before this work was migrated into plugin form. Translate as needed:

- `~/.claude/skills/system-orca/` (in PLAN.md / SPEC.md) → **plugin source root**. During development, this is the repo root. When installed via Claude Code, it'll be the cached install path. The CLI resolves its own location via `__dirname`, so this works regardless.
- `~/.claude/system-orca/` → **runtime root**. Unchanged. Server pidfile, log, and per-workflow `events.jsonl` files always live here, independent of plugin install location.

### When implementing

- Check `docs/SPEC.md` for the contract before writing any handler.
- Run the relevant Phase N verification gate (defined in `docs/PLAN.md` locally) before opening a PR.
- Don't add npm dependencies. If you reach for one, you're solving a different problem than the SPEC describes.
- Don't bind anything but `127.0.0.1`. There's no auth.
- Mermaid hash mismatches are a tampering signal — escalate, never silence by overwriting the expected hash.

## Skill Ownership

No repo-canonical skills yet. If a workflow specific to system-orca emerges (e.g. a "drive a workflow through all 7 phases" skill), it lives at `.claude/skills/<name>/SKILL.md` and is documented here.

## Merge Queue

No `.mergify.yml` yet — single-author repo, manual merges via `gh pr merge --squash` after CI green and self-approval. Add a queue if PR volume grows enough to warrant it.

## Common Tasks

| Task | Approach |
|---|---|
| Run the server during dev | `bin/system-orca up`; logs to `~/.claude/system-orca/server.log` |
| Tail workflow events | `bin/system-orca tail <workflow-id>` (Phase 7) |
| Add a route | Edit `server/server.js`'s router; static files in `server/static/` are auto-served |
| Verify a phase | Run the gate command block from PLAN.md `## 7. Verification gates` |
| Open a PR | Branch off main, follow `.github/PULL_REQUEST_TEMPLATE.md` |
| Ship a release | (Not yet defined; v1 ships only when Phase 7's e2e parity check passes against the agentic-bridge replay) |

## Phase Roadmap

1. **Phase 1 (next):** Server skeleton + filesystem scaffolding (`bin/system-orca` `up`/`down`/`status`, `/api/health`, `/api/version`, pidfile lifecycle).
2. **Phase 2:** Event ingest + per-workflow append mutex.
3. **Phase 3:** State projection + workflow APIs.
4. **Phase 4:** Mermaid generation + diagram endpoint.
5. **Phase 5:** Index page (cards + 2 s polling).
6. **Phase 6:** Detail page (Stages tab + Diagram tab).
7. **Phase 7:** CLI completeness + SKILL.md + references + end-to-end parity check.

## Files to Read First

When starting a session, these provide the most context:

1. `README.md` — what the plugin is and where the design lives.
2. `CLAUDE.md` (this file).
3. `AGENTS.md` — repo-wide guidelines.
4. `docs/SPEC.md` — event schema, server contract, CLI surface (canonical).
5. `.github/PULL_REQUEST_TEMPLATE.md` — what a PR has to include.
