# @jackmazac/opencode-conductor

Doctrine, plans, waves, runs, and lifecycle for the OpenCode plugin fleet.

## What Conductor is

Conductor is the doctrine and orchestration plugin for the OpenCode fleet. It writes canonical plans, run records, status mirrors, progress trackers, audits, journals, handoffs, and lifecycle artifacts. It integrates with the rest of the fleet through declarative handoffs — no shell-outs to other plugins in production. Conductor answers the question "what is the correct way to do this in this repo?" and enforces that answer through its tool surface and artifact shapes.

## Ownership

Conductor owns:

- Plans + subplans (`.opencode/plans/`, `.opencode/subplans/`)
- Plan index (`.opencode/plans/index.json`, maps `plan_id` ↔ `plan_slug`)
- Run records + status mirrors (`.opencode/runs/`, `.opencode/status/`)
- Progress tracking — plan and audit (`.opencode/progress/`, `.opencode/audit-progress/`)
- Journal (`.opencode/journal.jsonl`), handoff (`.opencode/handoff.md`), audits (`.opencode/audits/`)
- Concord lifecycle artifacts — declarative (`.opencode/lifecycle/artifacts/concord/`)
- Event spine (`.opencode/spine/events.sqlite`)
- Agent-directed exploration (`explore` / `explore-high` Task subagents, backed by `src/explore-fast.ts` wrapping the Cursor `agent` CLI)
- Context budget diagnostics (`context_usage`)

Conductor does NOT own:

- Memory retrieval / artifact ingest → Engram
- Code-graph / drift / impact / API-surface truth → Codemem
- Live edit locks / conflict guidance → Concord
- Plugin install / cross-plugin doctor / runtime contract validation → opencode-fleet
- Plugin-boundary safety / telemetry emission → opencode-host-adapter
- Canonical IDs / telemetry envelope / artifact ref / health report shapes → opencode-fleet-contracts

### Third-party OpenCode plugins

Plugins that are **not** authored and maintained by jackmazac — including typical community npm packages enabled through Fleet (for example `external_plugins`) — are **operator- and Fleet-owned**. Conductor does not ship them, maintain them, validate them from this repo, or treat them as part of its doctrine. Interop with separately maintained fleet repos stays contract- and artifact-based, as described in “Conductor does NOT own” above.

## Install

```bash
bun add @jackmazac/opencode-conductor
```

Then add to your `opencode.json` plugin array, or regenerate it via `opencode-fleet generate-opencode-json`.

For local development:

```json
{
  "plugin": ["file:///path/to/opencode-conductor/src/index.ts"]
}
```

## Plugin tools (49)

| Category | Tools |
|---|---|
| Plans | `persist_final_plan`, `read_final_plan`, `discard_final_plan`, `persist_subplan`, `read_subplan`, `discard_subplan`, `plan_validate` |
| Brainstorms | `persist_brainstorm`, `read_brainstorm`, `discard_brainstorm` |
| Designs | `persist_design`, `read_design`, `discard_design` |
| Runs | `run_init`, `run_update`, `run_finish`, `run_list` |
| Status | `status_write`, `status_read`, `status_done` |
| Progress | `progress_update`, `progress_read`, `progress_done` |
| Audits | `audit_write`, `audit_read`, `audit_done`, `audit_progress_update`, `audit_progress_read`, `audit_progress_done` |
| Journal | `journal_write`, `journal_read`, `journal_search`, `journal_done` |
| Handoff | `handoff_write`, `handoff_read`, `handoff_done` |
| Lifecycle | `lifecycle_concord_ingest` (declarative), `conflict_context` (dispatcher), `spine_query` (read SQLite event log) |
| Diagnostics | `context_usage`, `workspace_info` (workspace_id + git HEAD + dirty files + recent commits) |
| Sessions | `session_init` (composite rehydration), `artifact_index` (inventory), `drift_check` (consistency) |
| Git | `commit` (semantic commit with Conductor convention enforced), `changelog_emit` (markdown from wave commits) |
| Delegation | `task_dispatch` (plan-aware `task` prompt builder + slug validator) |
| Exploration | `explore_fast`, `discard_explore_cache` (Cursor `agent` CLI wrapper + cache management — see next section) |

The canonical tool list is enforced in `src/plugin-contract.test.ts`. The runtime smoke script (`scripts/runtime-smoke.ts`) asserts the tool count on every run.

## Agent-directed exploration (`explore_fast` plugin tool)

`explore_fast` is a plugin tool that runs fast, model-reasoned codebase exploration through the Cursor `agent` CLI (Composer-2 Fast by default). It is the single-shot counterpart to the `explore` / `explore-high` Task subagents — same prompt template (`prompts/explore.txt`), same structured markdown output with file:line citations, but invoked directly in one tool call instead of spawning a full subagent session.

The tool accepts:

| Arg | Type | Notes |
|---|---|---|
| `query` | string (required) | Natural-language exploration question. Include directories or globs, the question to answer, and explicit non-goals. |
| `path` | string (optional) | Workspace-relative focus path. Rejected if it escapes the workspace root. |
| `thoroughness` | `"quick"` / `"standard"` / `"exhaustive"` (optional) | Search depth tier. Picks the default model: `quick` and `standard` use `composer-2-fast`; `exhaustive` upgrades to `composer-2` (the `explore-high` distinction). |
| `cache` | boolean (optional) | Default `true`. Set `false` to bypass the cache and force a fresh CLI call. |

The library does not impose a per-call timeout — the Cursor CLI runs to completion and the outer task harness owns the wall-clock budget. Callers that want a hard cap should bound the surrounding task or break out of `streamExploreFast` early (the async generator's cleanup aborts the subprocess via SIGTERM).

### Cache

Results are persisted at `.opencode/explore-cache/<hash>.json` (gitignored) and returned instantly on repeat queries. The cache key is `sha256(query, target_path, thoroughness, model, workspace, prompt_hash, git_head, agent_version).slice(0, 12)`, so it invalidates automatically when:

- Any input to the query changes.
- The system prompt at `prompts/explore.txt` is edited (its content is hashed into the key).
- A commit lands (`git rev-parse HEAD` is hashed in).
- The Cursor CLI binary is upgraded (`agent --version` is hashed in — memoized once per process).

The cache does NOT invalidate on uncommitted working-tree changes — by design, to keep hit rate high during dev loops. If you've edited code you're about to query, pass `cache: false` once to force a fresh call. Concurrent identical queries within the same process dedupe through an in-memory inflight map (only one CLI invocation runs even if two callers fire the same query simultaneously).

Clear the entire cache via the `discard_explore_cache` plugin tool. Failed/errored explores are never cached — only successful results with non-empty content are persisted.

Implementation lives in `src/explore-fast.ts` and `src/explore-cache.ts`. The same modules expose two additional functions for internal callers (no plugin-tool surface):

- `runExploreFast(input): Promise<string>` — drains the CLI's output stream into a final string. The `explore_fast` plugin tool is a thin wrapper around this.
- `streamExploreFast(input): AsyncGenerator<ExploreFastEvent>` — yields typed events (`assistant_text`, `tool_call`, `tool_result`, `error`, `done`) as the CLI emits them, for callers that want incremental output.

Key contracts:

- **Typed argv.** Every flag (`--model`, `--mode`, `--output-format`, `--workspace`) is a compile-time literal via `CursorInvocation` + `toArgv()` in `src/cursor-cli-types.ts`. Flag typos are TypeScript errors, not runtime mysteries.
- **Stream-json envelope.** The wrapper parses the Cursor CLI's `--output-format stream-json` output and maps `system` / `init` / `user` / `assistant` (with nested `message.content[]`) / `result` events into the internal `ExploreFastEvent` tagged union. Unknown event types are dropped at parse time — forward-compatible with new CLI events.
- **Thoroughness tier drives budget.** `thoroughness: "quick" | "standard" | "exhaustive"` (default `standard`) maps to `timeoutMs` and `model` defaults:
  - `quick` → 30s, `composer-2-fast`
  - `standard` → 120s, `composer-2-fast`
  - `exhaustive` → 300s, `composer-2` (matches the `explore-high` "strongest reasoning" intent)

  The selected tier is also written into the prompt so the agent adapts its search depth per `prompts/explore.txt`. Explicit `timeoutMs` / `model` override the tier defaults.
- **Partial output preserved on timeout.** When `timeoutMs` elapses with `assistant_text` already streamed, `runExploreFast` returns `[partial output — Cursor CLI timed out after Xms]\n\n<text>` instead of discarding the agent's pre-cancellation work. Non-timeout errors (non-zero exit, CLI `is_error`, spawn failure) still drop partial output — the agent's reasoning is suspect in those cases.
- **Pricing.** Free with `agent login`. No tokens are billed by Cursor for CLI invocations on a logged-in account. The Cursor SDK (`@cursor/sdk`) was evaluated and explicitly rejected for cost reasons — see `.opencode/plans/explore-fast-cursor-sdk-migration.md` for the decision history.

## Correlation IDs

Every run record and status mirror carries a standard correlation envelope:

```
agent_run_id    correlation_id    workspace_id
plan_id         plan_slug         wave_id
task_id         agent_type
```

`plan_id` is additive alongside `plan_slug` (introduced in Wave 2). Legacy records without `plan_id` remain valid. Lifecycle artifacts additionally carry `lifecycle_object_id` and `concord_event_id`. All ID types are branded and validated through `@jackmazac/opencode-fleet-contracts` parsers.

## CLI

```bash
conductor detect               # stack profile detection
conductor doctor --json        # health report (canonical HealthReport shape)
conductor status --json        # current state
conductor policy export        # profile + policy JSON
```

Or via bun scripts:

```bash
bun run doctor -- --json
bun run status -- --json
```

## Integration with the fleet

Conductor writes all lifecycle and plan artifacts declaratively to disk. Engram ingests them through its own `lifecycle_ingest` tool — no shell-outs, no coupling at the process level. Concord collision events flow into Conductor through `lifecycle_concord_ingest`, which writes lifecycle artifacts and spine rows and returns structured refs. The `conflict_context` tool dispatches to Engram's native cross-tool handler for correlated memory retrieval; the dispatcher abstraction is at `src/workflow-tools/conflict-context.ts`. When Engram's native tool is unavailable (as in the current OpenCode SDK), `conflict_context` returns a structured `{ error: { code: "E_ENGRAM_NATIVE_UNAVAILABLE" } }` rather than shelling out.

## Development

```bash
bun run check               # lint:no-zod + typecheck + tests (260+)
bun run smoke:runtime       # assert plugin loads and exposes 49 tools
bun run smoke:explore-fast  # CURSOR_CLI_INTEGRATION=1 — exercises the real Cursor agent CLI
bun run smoke:commit        # CONDUCTOR_GIT_INTEGRATION=1 — real git commit in a temp repo
bun run doctor -- --json
bun run status -- --json
```

- `check` runs `lint:no-zod` (no Zod import in src/), then `typecheck` (tsgo --noEmit), then `bun test`.
- `smoke:runtime` loads the plugin in a subprocess and asserts the tool count. It fails fast if a tool registration is missing.
- `smoke:explore-fast` runs the env-gated integration test against the real `agent` binary. The same test is skipped in `check` / default `bun test` runs.
- `smoke:commit` runs the env-gated integration test for the `commit` tool (real `git` in a temp directory). Skipped unless `CONDUCTOR_GIT_INTEGRATION=1`.

## Package structure

The main package at the repo root exports the plugin. Four sub-packages support it:

- `packages/lifecycle-contracts` — TypeScript types and parsers for lifecycle artifact shapes
- `packages/spine` — SQLite event spine (`.opencode/spine/events.sqlite`) read/write
- `packages/bridge-contracts` — bridge shape types shared across the fleet
- `packages/conformance` — conformance test helpers for contract validation

## License

MIT
