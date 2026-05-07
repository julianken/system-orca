# Repository Guidelines

## Project Structure

- **Spec:** `docs/SPEC.md` — single source of truth for the event schema, server contract, CLI surface, and storage layout. Read this first.
- **Plugin source:** Layout under the repo root maps to the plugin install root once Claude Code unpacks it.
  - `bin/system-orca` — CLI entrypoint (`up`, `down`, `init`, `event`, `archive`, `list`, `tail`, `status`).
  - `server/server.js` — `node:http` HTTP server. Zero npm deps; Node ≥ 20 stdlib only.
  - `server/static/` — index page, per-workflow detail page, vendored mermaid.
  - `skills/system-orca/` — skill metadata for Claude Code plugin discovery.
  - `references/` — long-form reference docs surfaced via the plugin.
- **Tests:** `tests/` — fixtures + node `--test` runner. (Lands with Phase 2.)
- **Runtime root:** `~/.claude/system-orca/` (NOT in this repo) — pidfile, log, per-workflow `events.jsonl`. Never check in runtime artefacts.
- **Local-only working material:** `docs/PLAN.md`, `docs/critic-verdict-r{1,2,3}.json`, `prior-art/` are gitignored. They're kept on disk for the author's reference.

## Build, Test, and Development Commands

```
node --version                                 # require ≥ 20
node --check server/server.js                  # syntax check (no execution)
node --check bin/system-orca                   # syntax check the CLI

bin/system-orca up                             # start local server (127.0.0.1:8765)
bin/system-orca status                         # report up/down + counts
bin/system-orca down                           # SIGTERM, unlink pidfile

curl -fsS http://127.0.0.1:8765/api/health    # liveness
curl -fsS http://127.0.0.1:8765/api/version   # identity probe (used by `up`)

node --test tests/                             # run all tests (Phase 2 onwards)
```

No `package.json`, no `node_modules`, no `pnpm`. The plugin uses Node's stdlib only.

## Coding Style & Naming Conventions

- **Language:** Plain JavaScript (ESM via `.js` with `import`/`export`, or CommonJS — pick one per phase 1 and stick with it).
- **Node version:** ≥ 20 stdlib (`node:http`, `node:fs`, `node:path`, `node:util`, `node:crypto`, `node:child_process`).
- **File names:** `kebab-case.js` for source files; the CLI binary stays `system-orca` (no extension, executable bit set).
- **Indentation:** 2 spaces. LF line endings. UTF-8. Final newline on every text file.
- **No external dependencies.** If a use case looks like it needs one, it doesn't — re-read the SPEC's "Hard constraints" section.
- **Bind `127.0.0.1` only.** Never `0.0.0.0` or unspecified.

## Testing

- **Unit + integration:** `node --test` against `tests/*.test.js`. Fixtures under `tests/fixtures/` are append-only `events.jsonl` snapshots.
- **End-to-end (phase 5–7):** scripted `chrome-devtools-mcp` runs against the local server. Selectors and assertions live alongside the phase gate in `docs/SPEC.md` (locally) and the PR's Test plan.
- Run the relevant phase gate from PLAN.md before opening a PR. The Test plan section in the PR template lists what each phase requires.

## Commit & Pull Request Guidelines

This repo uses **conventional commits**. Active scopes:

| Type          | When to use                                  |
|---------------|----------------------------------------------|
| `feat`        | New feature                                  |
| `fix`         | Bug fix                                      |
| `chore`       | Maintenance, tooling, repo metadata          |
| `docs`        | Documentation only                           |
| `ci`          | CI/CD pipeline changes                       |
| `test`        | Adding or updating tests                     |
| `build(deps)` | Dependency bumps (GitHub Actions only here)  |
| `refactor`    | Code restructure without behavior change     |
| `perf`        | Performance improvement                      |

Active scopes for this repo: `server`, `cli`, `static`, `vendor`, `docs`, `repo`, `ci`, `deps`.

Format: `type(scope): short imperative sentence (#issue)`.

PR descriptions follow `.github/PULL_REQUEST_TEMPLATE.md` — diagram-first, summary, screenshots when applicable, test plan, plan reference.

## Security

- Never commit secrets. The plugin has no auth surface and no secrets in its runtime.
- The server binds `127.0.0.1` only — never expose to the network. The server has no auth; loopback is the boundary.
- Mermaid is vendored offline-safe. The vendoring step verifies a sha256 hash committed in PLAN.md task 6.1; never silence a mismatch by overwriting the hash.
