# Planner D return: Reflection phase + reflector subagent

## Priming

- **User-visible outcome**: The current user still sees the plan finish immediately; future planners/brainstormers gain a searchable, cited postmortem artifact for completed plans.
- **Failure modes**: Blocking the completion response violates the performance constraint; uncited prose becomes memory pollution; missing artifact kinds prevents Engram ingestion; loose tool permissions let the reflector mutate non-reflection state; deferred markers can become stale if no startup pickup exists.
- **Patterns to preserve**: Conductor owns `.opencode/` workflow artifacts and exact tool names (`src/plugin-contract.test.ts`, `scripts/runtime-smoke.ts`); generated `opencode.json` preserves user-owned agent sections while Fleet owns plugin refs; canonical `ArtifactKind` and `ArtifactRef` come from `@jackmazac/opencode-fleet-contracts`; Engram ingests artifacts from configured `.opencode` paths.
- **Root cause correlation**: The reflection request combines three symptoms—plan learnings disappear, future planners do not see prior outcomes, and finalization lacks a learning loop—solved by one source-of-truth reflection artifact plus Engram ingestion, not separate planner/scribe workflows.
- **Type pipeline (primed)**: One canonical `reflection`/`reflection_pending` artifact kind flows from contracts → Conductor `reflection_*` tools → Engram artifact ingestion → memory retrieval. Avoid parallel string unions except narrowed subsets derived from contracts.
- **Contract & vendor audit (primed)**: Reviewed `src/plan-artifacts.ts`, `src/workflow-tools/audit.ts`, `src/workflow-artifacts.ts`, `src/index.ts`, `src/plugin-contract.test.ts`, `scripts/runtime-smoke.ts`, `prompts/orchestrator.txt`, `prompts/planner.txt`, `prompts/brainstormer.txt`, `~/.config/opencode/opencode.json`, `~/.config/opencode/fleet.jsonc`, `opencode-fleet-contracts/src/artifacts.ts`, `opencode-fleet-contracts/src/telemetry.ts`, `engram/src/artifacts.ts`, `engram/src/config.ts`, and package scripts.
- **Codemem signals (primed)**: `codemem_before_edit` on Conductor tool/index paths reported `safeToEdit=false`, high risk score 100: public exports in `src/index.ts`, `src/plan-artifacts.ts`, `src/workflow-artifacts.ts`; API drift findings on `createWorkflowArtifactTools` and `PlanArtifactFolder`; dependency cone touches 21 files. Treat Conductor tool registration as shared API work requiring contract/smoke tests.

## Recommended approach

- **Trigger mechanism (immediate vs deferred)**: Use a deferred marker, not an inline `task` call. After `progress_done(plan_slug)` succeeds, orchestrator writes `.opencode/reflection-pending/<plan_slug>.json` via `reflection_pending_write` and returns the normal “plan done” response. Current OpenCode `task` calls are synchronous, so true “lands a few minutes later” background execution is infeasible without new async plumbing or an external watcher. V1 preserves the non-blocking current-user experience and lets startup/maintenance pickup run the reflector later; if minutes-later delivery is non-negotiable, the platform needs an async task queue.
- **Reflector subagent type + model tier**: Add `reflector` as a subagent using Claude Sonnet family, medium reasoning (`amazon-bedrock/anthropic.claude-sonnet-4-6`, `reasoningEffort: medium`). It is reasoning-heavy enough for synthesis but not executor-genius tier.
- **Tool permissions set**: Read-only local tools plus constrained artifact write: `read_final_plan`, `read_subplan`, `journal_read`, `progress_read`, `handoff_read`, Planner C’s `wave_snapshot_read`, `memory`/`memory_context` for prior reflections, `reflection_write`, and bash limited by prompt to read-only `git log/show/diff --stat/status` commands. `write`/`edit` disabled; `reflection_write` enforces `.opencode/reflections/` path.
- **Template structure summary**: Fixed seven-section markdown template: hypothesis/outcome, plan accuracy table, top-5 regressions, proven patterns, failed/modified patterns, tool gaps, and next-plan recommendations. Every claim-bearing row has an `Evidence` column.
- **Quality gate approach**: Do not add a reviewer pass in v1; it would add latency and another synchronous subagent. Add a deterministic `reflection_write` lint instead: required headings present, capped tables respected where machine-checkable, and every non-empty claim row must include a citation token (`W#`, task ID, commit hash, artifact path, or metric). If evidence is absent, the section must say `Omitted — no citeable evidence.`

## Reflection template (markdown skeleton with section guidance)

```markdown
# Reflection: <plan_slug>

| Field | Value |
|---|---|
| Plan | `<plan_slug>` |
| Plan ID | `<plan_id or unknown>` |
| Generated at | `<ISO timestamp>` |
| Evidence sources | `<final plan, progress, snapshots N, subplans N, journal N, commits N>` |
| Citation rule | Every claim cites a wave ID, task ID, commit hash, artifact path, or metric. |

## 1. Hypothesis vs outcome

_Max 6 rows. Compare the plan thesis to observed completion evidence; do not restate the plan._

| Hypothesis / bet | Outcome | Evidence | Verdict |
|---|---|---|---|
| `<planned claim>` | `<what actually happened>` | `<W#, task ID, commit, snapshot, metric>` | `confirmed | partially confirmed | disproven` |

## 2. Plan accuracy table

_One row per wave. Use `unknown` only when the source truly does not exist; cite that absence._

| Wave | Estimated tasks | Actual tasks | Estimated LOC | Actual LOC | Estimated duration | Actual duration | Estimated tier mix | Actual tier mix | Evidence |
|---|---:|---:|---:|---:|---|---|---|---|---|
| `W1` | `<n>` | `<n>` | `<n/unknown>` | `<n/unknown>` | `<duration>` | `<duration>` | `<tiers>` | `<tiers>` | `<plan/progress/snapshot/commit>` |

## 3. Regressions with root cause + guard

_Top 5 by severity. Omit if none are citeable._

| Severity | Regression | Root cause | Guard that would have caught it | Evidence |
|---|---|---|---|---|
| `P0-P3` | `<specific breakage>` | `<specific cause>` | `<test/reviewer/codemem/eval/telemetry guard>` | `<wave/task/commit/error metric>` |

## 4. Patterns proven (promote to conventions)

_Max 5. Only promote reusable patterns shown by at least one completed wave/task._

| Pattern | Promote where | Why it held | Evidence |
|---|---|---|---|
| `<pattern>` | `<AGENTS/ruler/README/prompt>` | `<specific benefit>` | `<wave/task/commit/metric>` |

## 5. Patterns failed or modified (deprecate or adjust)

_Max 5. Include the replacement if known._

| Pattern | Failure / modification | Adjustment | Evidence |
|---|---|---|---|
| `<pattern>` | `<what failed or changed>` | `<new rule or deprecation>` | `<wave/task/commit/metric>` |

## 6. Tool gaps identified

_Max 5. Tool gaps only; do not list generic “better docs” unless a concrete missing tool would have helped._

| Gap | Impact | Proposed tool / change | Evidence |
|---|---|---|---|
| `<missing capability>` | `<specific friction>` | `<tool/prompt/contract change>` | `<wave/task/commit/metric>` |

## 7. Recommendations for next similar plan

_Max 7. Each recommendation must name where it applies and cite the wave/task that motivates it._

| Recommendation | Applies to | Rationale | Evidence |
|---|---|---|---|
| `<imperative recommendation>` | `<future plan shape>` | `<specific reason>` | `<wave/task/commit/metric>` |
```

## Reflector subagent prompt (high-level outline, not full prose)

1. **Startup contract**: Require first line `Plan: <slug> | Reflection: post-completion`. Extract `plan_slug`; if absent, fail without writing.
2. **Bounded input loading**: Call `read_final_plan(slug)`; `progress_read(slug)`; `journal_read(last_n: 10)`; `handoff_read`; `wave_snapshot_read(plan_slug: slug, limit: 5, order: "recent")` if available; `read_subplan` list then only contributing subplans identified by Planner C lineage; `memory` query `reflection <plan_slug>` and `reflection similar plan pattern` with low limit. Never load raw runs/status transcripts.
3. **Git evidence**: Use bash only for read-only git inspection: recent commits, commit stats, and wave commit hashes. No redirection, no file writes, no mutation.
4. **Synthesis discipline**: Fill the exact template. If a section lacks citeable evidence, write only `Omitted — no citeable evidence.` No “we learned a lot,” no generic recommendations, no uncited claims.
5. **Budget discipline**: Keep source notes internal and final reflection under ~4–6K tokens; cap regressions/tool gaps/pattern tables as specified.
6. **Write path**: Call `reflection_write({ plan_slug, body, metadata })`; final subagent response is a compact JSON-like summary with path, artifact_ref, and omitted sections.

## Wave-level task breakdown

| ID | Task | Owner repo | Files | Size | Executor tier | Deps | Risks |
|---|---|---|---|---|---|---|---|
| D1 | Add reflection artifact kinds to canonical contracts | `opencode-fleet-contracts` | `src/artifacts.ts`, `src/artifacts.test.ts`, possibly `src/index.ts` | M | executor-medium | none | Must be additive to schema v1; downstream repos fail until updated. |
| D2 | Implement Conductor reflection + pending tools | `opencode-conductor` | `src/workflow-tools/reflection.ts`, `src/workflow-artifacts.ts`, `src/index.ts` if needed, `src/plugin-contract.test.ts`, `scripts/runtime-smoke.ts`, `src/workflow-tools/reflection.test.ts`, `README.md` | M | executor-high | D1 | Codemem high-risk API cone; tool count changes from 31 to 37 if pending trio ships. |
| D3 | Write reflector prompt package file | `opencode-conductor` | `prompts/reflector.txt` | M | executor-medium | D2 | Prompt quality determines artifact quality; must encode anti-platitude and bounded-input rules. |
| D4 | Integrate orchestrator lifecycle and config agent entry | `opencode-conductor`, `~/.config/opencode` | `prompts/orchestrator.txt`, `~/.config/opencode/opencode.json`, `~/.config/opencode/fleet.jsonc`, `.opencode-fleet.lock.json` after regeneration | M | executor-medium | D2, D3 | No true async task API; must document deferred marker semantics honestly. Generated-config source of truth for agent entries is currently ambiguous. |
| D5 | Extend Engram artifact ingestion for reflections | `engram` | `src/artifacts.ts`, `src/config.ts`, artifact ingestion tests/eval fixtures | M | executor-medium | D1, D2 | Engram currently has a local artifact kind subset and no `.opencode/reflections` path; retrieval quality should be eval-checked. |
| D6 | Teach planning/brainstorming prompts to consult reflections | `opencode-conductor` | `prompts/planner.txt`, `prompts/brainstormer.txt` | S | executor-low | D5 | Keep executors/reviewers/scribes unaware unless explicitly needed. |
| D7 | Fleet/runtime validation sweep | all changed repos + config | package locks/generated config as needed | S-M | validator | D1-D6 | Multi-repo tool count/config drift can leave runtime broken despite local tests. |

Verification commands to attach to executor prompts: Contracts `bun run check`; Conductor `bun run check && bun run smoke:runtime`; Engram `bun run check && bun run smoke:runtime`, plus `bun src/cli/run.ts eval context --fixture eval/fixtures/context-core.json --worktree .` after adding reflection retrieval fixture; config `bun run fleet:doctor -- --json && bun run fleet:test:full-runtime && bun run fleet:hygiene -- --strict --json` from `~/.config/opencode`.

## Contracts impact

Add `ArtifactKind` members `"reflection"` and `"reflection_pending"` in `@jackmazac/opencode-fleet-contracts`. `buildArtifactRef`, `parseArtifactRef`, and tests must accept both. Telemetry can use existing open `TelemetryKind = ${string}.${string}` with new emitted kinds `reflection.written` and `reflection.deferred`; no schema-version bump beyond additive schema_version 1. If Planner E defines central telemetry constants, these names should be registered there rather than redefined locally.

## Conductor tool additions

```ts
reflection_write({
  plan_slug: string,
  body: string,
  metadata?: {
    plan_id?: string,
    source_refs?: string[],
    generated_by?: "reflector",
    input_counts?: Record<string, number>,
  },
}) -> { plan_slug, path: ".opencode/reflections/<plan_slug>.md", artifact_ref, metadata }

reflection_read({ plan_slug?: string }) -> list reflections or soft-truncated content
reflection_done({ plan_slug?: string }) -> remove one/all reflection artifacts

reflection_pending_write({
  plan_slug: string,
  reason: string,
  requested_at?: string,
  after_progress_done?: boolean,
  inputs?: { max_snapshots?: number, max_subplans?: number },
}) -> { plan_slug, path: ".opencode/reflection-pending/<plan_slug>.json", artifact_ref }

reflection_pending_read({ plan_slug?: string }) -> list/read pending markers
reflection_pending_done({ plan_slug?: string }) -> remove one/all pending markers
```

`reflection_write` should atomically write via temp+rename, compute SHA-256 with Node `crypto`, return `buildArtifactRef({ kind: "reflection", path, hash })`, validate slug with the existing slug convention, enforce the citation/heading lint, and never write outside `.opencode/reflections/`.

## Prompt changes

- Add `prompts/reflector.txt` in Conductor’s packaged prompts.
- Add `reflector` to `~/.config/opencode/opencode.json` agent list with `mode: "subagent"`, Sonnet medium reasoning, `write:false`, `edit:false`, `bash:true`, and permissions for the read tools plus `reflection_write`. Add `task.reflector: allow` to orchestrator permissions and allow orchestrator `reflection_pending_*`.
- Update `prompts/orchestrator.txt`: after final validation/review/commit and `progress_done(plan_slug)`, call `reflection_pending_write`; during startup/maintenance, read pending markers and, when acceptable, run `task` with `Plan: <slug> | Reflection: post-completion`, then `reflection_pending_done` on success. Explicitly state this is deferred because `task` is synchronous.
- Update `prompts/planner.txt` and `prompts/brainstormer.txt`: before designing similar work, query `memory`/`memory_context` for `reflection <domain/pattern>` and incorporate only cited learnings.

## Engram integration

Engram must ingest `.opencode/reflections/*.md` as `reflection` with high authority (near plan/audit, e.g. 8) and optionally `.opencode/reflection-pending/*.json` as low-authority operational state or skip pending if Planner E decides pending is not memory-worthy. Add config defaults for `reflections` and `reflectionPending`; update `discoverSources`, `contentType`, tests, and a context eval fixture proving a query like “what did we learn from plan <slug>?” retrieves the reflection by `plan_slug` / `artifact_ref`. Do not add sqlite-vec or alternate vector backends.

## Dependencies on other planners

- **Planner A (worktree state at plan-end)**: Needs to define what “all commits in” means per worktree so reflector git stats can map commits to waves without reading unrelated branches.
- **Planner B (wave reports as input)**: If suborch-owned waves emit reports, reflector should treat those as preferred actuals for task count/tier/duration rather than reconstructing from prose.
- **Planner C (wave snapshots + contributing subplans as primary input)**: Reflection depends on `wave_snapshot_read` and subplan lineage to avoid loading full plan history.
- **Planner E (contracts, telemetry)**: Owns final decision on `reflection_pending` as an artifact kind, telemetry naming, generated config ownership, and migration/backward compatibility.

## Open questions / user decisions

- Should `reflection_pending` be ingested into Engram or remain transient Conductor state? I recommend transient unless Planner E wants complete lifecycle traceability.
- Is a deterministic citation linter acceptable in v1? I recommend yes; without it, reflections will become platitudes and contaminate memory.
- Where is the durable source of truth for agent entries? Current Fleet generation preserves but does not generate the `agent` section, so adding `reflector` may require a config convention or Planner E change.
- Should startup auto-run pending reflections even if it delays the next user’s first response? I recommend no; process pending only during explicit maintenance or when the orchestrator has idle budget until async task support exists.
- No user confirmation should be required before writing reflections; invisibility is a core constraint.

## Type flow claim

Canonical flow: `ReflectionMarkdown + ReflectionMetadata` is produced by the `reflector` prompt, validated and written by Conductor `reflection_write`, returned as a canonical `ArtifactRef(kind: "reflection")`, auto-ingested by Engram as artifact kind `reflection`, and later retrieved by planners/brainstormers through `memory`/`memory_context`. There is no mapper stack: the only boundary validation is the Conductor write tool and canonical contracts parsing.