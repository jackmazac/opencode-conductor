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
- Agent-directed exploration (`explore` / `explore-high` via Task)
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

## Plugin tools (31)

| Category | Tools |
|---|---|
| Plans | `persist_final_plan`, `read_final_plan`, `discard_final_plan`, `persist_subplan`, `read_subplan`, `discard_subplan` |
| Runs | `run_init`, `run_update`, `run_finish` |
| Status | `status_write`, `status_read`, `status_done` |
| Progress | `progress_update`, `progress_read`, `progress_done` |
| Audits | `audit_write`, `audit_read`, `audit_done`, `audit_progress_update`, `audit_progress_read`, `audit_progress_done` |
| Journal | `journal_write`, `journal_read`, `journal_done` |
| Handoff | `handoff_write`, `handoff_read`, `handoff_done` |
| Lifecycle | `lifecycle_concord_ingest` (declarative), `conflict_context` (dispatcher) |
| Exploration | `explore`, `explore-high` |
| Diagnostics | `context_usage` |

The canonical tool list is enforced in `src/plugin-contract.test.ts`. The runtime smoke script (`scripts/runtime-smoke.ts`) asserts the tool count on every run.

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
bun run check          # lint:no-zod + typecheck + tests (159+)
bun run smoke:runtime  # assert plugin loads and exposes 31 tools
bun run doctor -- --json
bun run status -- --json
```

- `check` runs `lint:no-zod` (no Zod import in src/), then `typecheck` (tsgo --noEmit), then `bun test`.
- `smoke:runtime` loads the plugin in a subprocess and asserts the tool count. It fails fast if a tool registration is missing.

## Package structure

The main package at the repo root exports the plugin. Four sub-packages support it:

- `packages/lifecycle-contracts` — TypeScript types and parsers for lifecycle artifact shapes
- `packages/spine` — SQLite event spine (`.opencode/spine/events.sqlite`) read/write
- `packages/bridge-contracts` — bridge shape types shared across the fleet
- `packages/conformance` — conformance test helpers for contract validation

## License

MIT
