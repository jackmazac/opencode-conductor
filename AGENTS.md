# @jackmazac/opencode-conductor — agent guide

## Scope

Doctrine and orchestration. Plans, runs, lifecycle artifacts, spine, exploration, and context diagnostics. This is the plugin that answers "what is the correct way to do this in this repo?" and enforces that answer through its tool surface and artifact shapes.

Do not implement features that belong to other fleet plugins. Conductor is narrow by design.

## Plugin ownership boundary

This repository maintains **`@jackmazac/opencode-conductor`** and the bridge or contract packages it exports (for example under `packages/`). Conductor **does not** own OpenCode plugins that are **not** created and maintained by jackmazac. Do not add code, prompts, or documentation here that implies Conductor maintains third-party or community plugins; Fleet manifest and local `opencode.json` are the layer for those installs.

## Canonical contracts

ID types (`AgentRunId`, `PlanId`, `PlanSlug`, `WorkspaceId`, `CorrelationId`, `WaveId`, `TaskId`, `SpineSeq`, `ArtifactRef`, `LifecycleObjectId`, `ConcordEventId`, `FleetRunId`), the telemetry envelope, artifact ref shapes, and the canonical `HealthReport` all come from `@jackmazac/opencode-fleet-contracts` via `@jackmazac/opencode-host-adapter`. Do NOT redefine them here.

## What agents do here

- Add new plan/subplan/audit artifact kinds by extending the artifact store in `src/plan-artifacts.ts` or adding new files under `src/workflow-tools/`.
- Extend run record fields additively (nullable, never required-without-default). Existing consumers must not break.
- Add new workflow tools (one file per coherent concern in `src/workflow-tools/<name>.ts`; see Tool addition workflow below).
- Document behavioral conventions in the Ownership section of `README.md`.
- Extend the event spine schema in `packages/spine/src/` when new event categories are needed.

## What agents do NOT do here

- Implement memory retrieval or artifact ingest — that is Engram.
- Implement code-graph analysis, drift detection, or API-surface truth — that is Codemem.
- Implement live edit locks or conflict resolution logic — that is Concord.
- Shell out to other fleet plugins in production. Wave 2 removed all shell paths. Use tool dispatch (the `conflict_context` dispatcher abstraction) or declarative handoff (write an artifact; the other plugin picks it up).
- Rename existing tools. Every orchestrator script, smoke test, and external agent depends on the exact tool names in `src/plugin-contract.test.ts`.
- Mutate `.opencode/plans/<slug>.md` file paths. Downstream tools parse artifacts by slug. Changing the path convention breaks all consumers.
- Import Zod directly in `src/`. The `lint:no-zod` check enforces this. Use the validation utilities exported from `@jackmazac/opencode-fleet-contracts` or `@jackmazac/opencode-host-adapter`.

## Critical invariants

**`conflict_context` dispatcher**
`conflict_context` never shells to Engram in production. The dispatcher abstraction lives at `src/workflow-tools/conflict-context.ts`. Test-only injection is via `__test_setEngramDispatch(fn)`. When the OpenCode SDK does not yet expose cross-tool dispatch, the production path returns:
```json
{ "error": { "code": "E_ENGRAM_NATIVE_UNAVAILABLE" } }
```
Do not add a shell-out as a fallback.

**`lifecycle_concord_ingest` is declarative**
It writes lifecycle artifacts to `.opencode/lifecycle/artifacts/concord/` and spine rows to `.opencode/spine/events.sqlite`, then returns structured refs. It never invokes Engram or any other plugin.

**`plan_id` is additive**
`plan_id` was introduced in Wave 2 alongside the existing `plan_slug`. `plan_slug` remains the filename key. Records without `plan_id` are valid; do not require it.

**Run records are append-only-style**
`run_init` creates, `run_update` merges fields, `run_finish` sets terminal state. Never rewrite or delete history. The status mirror at `.opencode/status/run-<id>.json` is read by Concord for correlation; shape changes ripple there.

**Tool count is asserted at runtime**
`scripts/runtime-smoke.ts` asserts that the plugin exposes exactly the expected number of tools on every run. Update the assertion when adding or removing tools.

## Type safety rules

- No `as` assertions on unknown data. Use the contracts parsers (`parseAgentRunId`, `parsePlanId`, etc.) for ID validation.
- Branded ID types never leave their validated constructor. Pass `AgentRunId`, not `string`, across internal boundaries.
- No `any`. If the type is genuinely unknown at the boundary (e.g., raw JSON from disk), narrow it through a Zod schema (from contracts) or a manual guard before use.
- No `@ts-ignore` or `@ts-expect-error`.

## Tool addition workflow

1. Add the tool implementation in `src/workflow-tools/<name>.ts`.
2. Register it in `src/workflow-artifacts.ts` (add the exported tool to the return object of `createWorkflowArtifactTools`).
3. Wire it in `src/index.ts` tool map if it is not covered by `createWorkflowArtifactTools`.
4. Add the tool name to the `expectedTools` array in `src/plugin-contract.test.ts`.
5. Add a focused unit test (co-locate with the implementation or add a `<name>.test.ts` in `src/workflow-tools/`).
6. Run `bun run check` and `bun run smoke:runtime`. Smoke asserts the tool count.
7. Update `fleet.jsonc` `expected_tools` in `~/.config/opencode/` if it is maintained separately, or regenerate via `opencode-fleet generate-opencode-json --force` once the new default is baked into Fleet's manifest.

## Validation before commit

```bash
bun run check            # lint:no-zod + typecheck + tests (159+)
bun run smoke:runtime    # plugin loads, 30 tools present
bun run doctor -- --json # emits valid canonical HealthReport
bun run status -- --json # emits valid canonical HealthReport
```

All four must pass before a change is considered done.

## Fleet position

Conductor is downstream of `opencode-host-adapter` (wraps it via `wrapPlugin`) and `opencode-fleet-contracts` (uses the canonical ID and shape types). When an operator installs other jackmazac-maintained fleet plugins, Conductor coordinates with them as **peers** through declarative artifacts and shared contracts — no direct dependency. Conductor artifacts may be consumed by those plugins (for example ingest or status mirrors) and by Fleet (report aggregation). Plugins not authored by jackmazac are **out of scope** for ownership in this repo; see **Plugin ownership boundary** above.

## Workflow tool conventions

Every workflow tool category follows a write/read/done trio where applicable. Inputs are validated through contracts parsers before use. Outputs are structured JSON — never free-form strings. Tools fail fast on bad IDs with a clear `reason` field in the error shape. All file paths are scoped to the workspace root; tools do not escape the workspace boundary.

## Links

- Canonical plan: `.opencode/plans/fleet-correlation.md`
- Journal: `.opencode/journal.jsonl`
- Progress: `.opencode/progress/<plan-slug>.json`
- Audit progress: `.opencode/audit-progress/<audit-slug>.json`
- Host adapter: `~/Developer/opencode-host-adapter/AGENTS.md`
- Fleet manager: `~/Developer/opencode-fleet/AGENTS.md`
- Fleet contracts: `~/Developer/opencode-fleet-contracts/AGENTS.md`
