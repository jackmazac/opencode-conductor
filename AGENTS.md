# @mazac-fox/opencode-conductor — agent guide

## Scope

Doctrine and orchestration. Plans, runs, lifecycle artifacts, spine, exploration, and context diagnostics. This is the plugin that answers "what is the correct way to do this in this repo?" and enforces that answer through its tool surface and artifact shapes.

Do not implement features that belong to other fleet plugins. Conductor is narrow by design.

## Plugin ownership boundary

This repository maintains **`@mazac-fox/opencode-conductor`** and the bridge or contract packages it exports (for example under `packages/`). Conductor **does not** own OpenCode plugins that are **not** created and maintained by jackmazac. Do not add code, prompts, or documentation here that implies Conductor maintains third-party or community plugins; Fleet manifest and local `opencode.json` are the layer for those installs.

## Canonical contracts

ID types (`AgentRunId`, `PlanId`, `PlanSlug`, `WorkspaceId`, `CorrelationId`, `WaveId`, `TaskId`, `SpineSeq`, `ArtifactRef`, `LifecycleObjectId`, `ConcordEventId`, `FleetRunId`), the telemetry envelope, artifact ref shapes, and the canonical `HealthReport` all come from `@mazac-fox/opencode-fleet-contracts` via `@mazac-fox/opencode-host-adapter`. Do NOT redefine them here.

## What agents do here

- Add new plan/subplan/audit artifact kinds by extending the artifact store in `src/plan-artifacts.ts` or adding new files under `src/workflow-tools/`.
- Extend run record fields additively (nullable, never required-without-default). Existing consumers must not break.
- Add new workflow tools (one file per coherent concern in `src/workflow-tools/<name>.ts`; see Tool addition workflow below).
- Document behavioral conventions in the Ownership section of `README.md`.
- Extend the event spine schema in `packages/spine/src/` when new event categories are needed.
- Extend the Cursor CLI wrapper at `src/explore-fast.ts` when adding fields to the typed argv (`CursorInvocation`), thoroughness defaults (`THOROUGHNESS_DEFAULTS`), or event mapping (`parseEvent` and friends). See the `explore-fast` invariant below before changing the event shape.

## What agents do NOT do here

- Implement memory retrieval or artifact ingest — that is Engram.
- Implement code-graph analysis, drift detection, or API-surface truth — that is Codemem.
- Implement live edit locks or conflict resolution logic — that is Concord.
- Shell out to other fleet plugins in production. Wave 2 removed all shell paths. Use tool dispatch (the `conflict_context` dispatcher abstraction) or declarative handoff (write an artifact; the other plugin picks it up).
- Rename existing tools. Every orchestrator script, smoke test, and external agent depends on the exact tool names in `src/plugin-contract.test.ts`.
- Mutate `.opencode/plans/<slug>.md` file paths. Downstream tools parse artifacts by slug. Changing the path convention breaks all consumers.
- Import Zod directly in `src/`. The `lint:no-zod` check enforces this. Use the validation utilities exported from `@mazac-fox/opencode-fleet-contracts` or `@mazac-fox/opencode-host-adapter`.

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

**`explore_fast` is the plugin-tool entry point to the Cursor `agent` CLI**
`src/explore-fast.ts` is the implementation behind the `explore_fast` plugin tool registered in `src/index.ts`. It wraps the Cursor `agent` CLI with `--output-format stream-json` and exposes a `runExploreFast(input): Promise<string>` library function for internal callers (the plugin tool is a thin wrapper around it) and a `streamExploreFast(input): AsyncGenerator<ExploreFastEvent>` for callers that want incremental output. The on-the-wire CLI envelope (`system` / `init` / `user` / `assistant` / `result`) is mapped to the internal `ExploreFastEvent` tagged union exactly once, in `parseEvent` / `parseAssistantEvent` / `parseResultEvent`. If the Cursor CLI envelope shape ever changes, those three functions are the only places that need to. Tests inject a fake `spawn` returning `ReadableStream<Uint8Array>` fixtures — never spawn the real `agent` from unit tests. The env-gated integration test (`CURSOR_CLI_INTEGRATION=1 bun test src/explore-fast.test.ts`, surfaced as `bun run smoke:explore-fast`) is the only place that exercises the real binary, and it is skipped by default. The `@cursor/sdk` TypeScript package was evaluated for this role and explicitly rejected — token-based pricing per call would be a real cost regression versus the CLI's free-with-`agent-login` auth. See `.opencode/plans/explore-fast-cursor-sdk-migration.md` for the full decision history.

**`explore-fast` does not impose a per-call timeout**
The library deliberately has no `timeoutMs` parameter and the plugin tool exposes no `timeout_ms` arg. The Cursor CLI runs to completion — success, CLI `is_error`, or non-zero exit — and the OpenCode task harness (or whichever caller owns the outer envelope) is responsible for bounding wall time. Callers that need a hard cap should bound the surrounding task or break out of `streamExploreFast` early; the async generator's `finally` aborts the spawned `AbortController`, which Bun.spawn translates into SIGTERM. Do not reintroduce a library-level timer — that path was removed after real OpenCode usage showed a 30s default cutting off legitimately slow exhaustive explores. See `.opencode/plans/explore-fast-cursor-sdk-migration.md` for the decision trail.

**`explore-fast` cache key composition is the single source of correctness**
The cache at `.opencode/explore-cache/<hash>.json` is content-addressed via `sha256(query, target_path, thoroughness, model, workspace, prompt_hash, git_head, agent_version).slice(0, 12)`. All eight inputs are required for correctness — dropping any one is a real staleness bug. Specifically: the system prompt content (not just its path) is hashed because `prompts/explore.txt` is a live file in this repo; `git_head` provides natural invalidation on every commit; `agent_version` invalidates when the CLI binary is upgraded. Defaults are expanded BEFORE hashing — `thoroughness: undefined` and `thoroughness: "standard"` must produce the same key. Path normalization happens via `resolveTargetPath` BEFORE hashing — `path: "src"` and `path: "./src"` must produce the same key. Failed results (any `error` event, or empty content) are never written to the cache. Schema version mismatches are treated as misses. If you change the envelope shape on disk, bump `SCHEMA_VERSION` in `src/explore-cache.ts` — that invalidates all existing entries cleanly. Test seam is `__test_setCacheDeps({ readGitHead, readAgentVersion })` per `src/explore-cache.ts`, matching the `__test_setEngramDispatch` pattern.

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
bun run check               # lint:no-zod + typecheck + tests (260+)
bun run smoke:runtime       # plugin loads, 49 tools present
bun run doctor -- --json    # emits valid canonical HealthReport
bun run status -- --json    # emits valid canonical HealthReport
```

All four must pass before a change is considered done.

Optional, env-gated:

```bash
bun run smoke:explore-fast  # CURSOR_CLI_INTEGRATION=1 bun test src/explore-fast.test.ts
bun run smoke:commit        # CONDUCTOR_GIT_INTEGRATION=1 bun test src/workflow-tools/commit.test.ts
```

Run `smoke:explore-fast` when changing `src/explore-fast.ts`, `src/cursor-cli-types.ts`, or anything in the parser path. It exercises the real `agent` binary end-to-end and is skipped by default in `bun run check`.

Run `smoke:commit` when changing `src/workflow-tools/commit.ts` (spawn seam or path validation). It performs a real `git init` + commit in a temp directory and is skipped by default in `bun run check`.

## Fleet position

Conductor is downstream of `opencode-host-adapter` (wraps it via `wrapPlugin`) and `opencode-fleet-contracts` (uses the canonical ID and shape types). When an operator installs other jackmazac-maintained fleet plugins, Conductor coordinates with them as **peers** through declarative artifacts and shared contracts — no direct dependency. Conductor artifacts may be consumed by those plugins (for example ingest or status mirrors) and by Fleet (report aggregation). Plugins not authored by jackmazac are **out of scope** for ownership in this repo; see **Plugin ownership boundary** above.

## Workflow tool conventions

Every workflow tool category follows a write/read/done trio where applicable. Inputs are validated through contracts parsers before use. All file paths are scoped to the workspace root; tools do not escape the workspace boundary.

### Error-shape convention

- **Throw `Error`** for invariant violations the caller can't recover from at runtime: invalid slug regex, unknown enum value, schema validation failure, malformed contracts ID. OpenCode surfaces these as tool errors, signaling "you called this tool wrong."
- **Return error strings** for runtime conditions the caller can recover from: file not found ("no audit file for X"), CLI exited non-zero, external service unavailable. These read as normal tool output and the model can adapt without an explicit failure.

The split is observable today across `journal.write` (throws on invalid type), `progress.update` (throws on invalid status), `audit.read` (returns "no audit file for X" string), and `explore_fast`'s validation path (string returns for empty query / out-of-workspace path). New tools should follow this rule.

### Result-envelope convention

- **JSON-stringified objects** for tools that exist primarily to *return structured data the orchestrator parses*: `run_init`, `run_update`, `run_finish`, `commit`, `artifact_index`, `session_init`, `run_list`, `plan_validate`, `journal_search`, `drift_check`.
- **Readable strings** for tools that exist primarily to *report a side effect or return human-facing content*: `journal_write`, `progress_update`, `status_write`, `handoff_write`, `audit_write`, all `discard_*` / `done` tools, `explore_fast` (returns the agent's markdown body), `discard_explore_cache`.

The `conflict_context` tool is the special case — it accepts a `json?: boolean` arg because its caller may want either shape. Don't replicate that pattern for new tools; pick one envelope and commit to it.

### Shared utilities

Slug validation, output formatting, the directory-safe `pathExists`, and the `createPlanArtifactStore` / `createProgressStore` factories live in `src/util/` and `src/`. Do **not** copy-paste these helpers into individual workflow-tool files — that's the anti-pattern that motivated Phase 1 of the `conductor-tools-uplift` plan. Specifically:

- Slug validation → `src/util/slug.ts` (`validateSlug(slug, { example })`).
- Output formatting → `src/util/format.ts` (`cap`, `rel`, `formatReadResult`).
- Directory existence checks → `src/util/path-exists.ts` (`pathExists`). `Bun.file(dir).exists()` returns false for real directories — use `pathExists` for any path that may be a directory.
- Plan/subplan/brainstorm/design artifact stores → `createPlanArtifactStore` in `src/plan-artifacts.ts`.
- Progress / audit-progress artifact stores → `createProgressStore` in `src/progress-artifacts.ts`.

### Subprocess-spawn injection pattern

Tools that shell out (currently `explore_fast`, `commit`, `workspace_info`, `changelog_emit`) follow a consistent injection pattern so unit tests can drive deterministic fake subprocesses without launching the real binary:

```ts
let spawnOverride: SpawnFn | undefined;
export function __test_setXxxSpawn(fn: SpawnFn | undefined): void { spawnOverride = fn; }
function runSpawn(input) { return (spawnOverride ?? defaultSpawn)(input); }
```

Production code always passes typed argv (`readonly string[]`) to `Bun.spawn`, never constructs shell strings. New tools that shell out **must** follow this exact pattern — match the test seam name (`__test_setXxxSpawn`), reject `-`-prefixed args, reject shell metacharacters in any caller-controlled path component. Integration tests gated on env vars (e.g. `CONDUCTOR_GIT_INTEGRATION=1`) exercise the real binary; default `bun test` runs use the injected fake.

## Links

- Canonical plan: `.opencode/plans/fleet-correlation.md`
- Journal: `.opencode/journal.jsonl`
- Progress: `.opencode/progress/<plan-slug>.json`
- Audit progress: `.opencode/audit-progress/<audit-slug>.json`
- Host adapter: `~/Developer/opencode-host-adapter/AGENTS.md`
- Fleet manager: `~/Developer/opencode-fleet/AGENTS.md`
- Fleet contracts: `~/Developer/opencode-fleet-contracts/AGENTS.md`
