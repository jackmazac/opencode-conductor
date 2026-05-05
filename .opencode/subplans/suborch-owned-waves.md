# Planner B return: Suborch-owned waves

## Priming

- **User-visible outcome**: Large approved waves execute faster with less orchestrator context pressure; small waves still run directly, so users see the same plan/approval/commit rhythm and no new CLI step.
- **Failure modes**: Over-delegating tiny waves adds latency; under-scoped wave briefs make suborchs guess; stale/incorrect scope matrices cause write conflicts; parallel suborch commits can race on the git index; missing `Plan:` headers prevent children from loading `read_final_plan`; unparseable reports break reflection and Engram retrieval.
- **Patterns to preserve**: Conductor prompt files are source (`prompts/orchestrator.txt`, `prompts/suborchestrator.txt`); `~/.config/opencode/opencode.json` points agents at package prompt files and its plugin array is generated; persisted plans live in `.opencode/plans/<slug>.md`; execution uses scope matrices, exact verification commands, per-wave commits, `progress_update`, and plan headers; executor/reviewer/scribe prompts stay unchanged.
- **Root cause correlation**: The current bottleneck is one shared delegation abstraction: `suborchestrator` is campaign-only and globally serialized. Fix prompt + wave/report contracts + spawn policy, not executor prompts.
- **Type pipeline (primed)**: One `WaveBrief` flows orchestrator → suborch; one `WaveReport` flows suborch → orchestrator + `.opencode/wave-reports/...`. Validate once at tool/prompt boundary; no mapper/normalizer stack.
- **Contract & vendor audit (primed)**: Read `prompts/suborchestrator.txt`, `prompts/orchestrator.txt`, `prompts/executor.txt`, `src/index.ts`, `src/workflow-artifacts.ts`, `src/workflow-tools/progress.ts`, `src/plugin-contract.test.ts`, `opencode-fleet-contracts/src/artifacts.ts`, `opencode-fleet-contracts/src/telemetry.ts`, and `~/.config/opencode/opencode.json` suborch agent config.
- **Codemem signals (primed)**: `codemem_conflicts` returned no active overlap. `codemem_change_risk` on prompt/tool/contract paths is high for `src/workflow-artifacts.ts`/`src/plugin-contract.test.ts`: 19-file dependency cone, public export `createWorkflowArtifactTools`, and API drift findings. Treat wave-report tooling as a checked multi-file change, not a prompt-only tweak.

## Recommended approach (1 sentence each)

- **Generalization strategy (in-place vs new subagent type)**: Extend the existing `suborchestrator` prompt in place with a `WaveBrief` mode while retaining campaign compatibility; a new `wave-suborchestrator` adds config/tool-surface drift without improving execution semantics.
- **Small-wave passthrough threshold (N tasks, complexity cap)**: Use direct executor fan-out when a wave has **≤3 tasks**, every task is `low`/`medium`, the scope matrix has no hard/soft write conflict, and the within-wave dependency graph is acyclic; otherwise use `suborchestrator`.
- **Disjoint-scope check mechanism**: Primary check is deterministic set intersection over each active wave’s `Owns` + `Shared(W|A)` paths/globs from the canonical scope matrix; use `codemem_conflicts` as a preflight/diagnostic for broad globs or suspected parallel-session overlap, not as a required extra round-trip for every wave.
- **Wave brief + return shape summary**: Orchestrator sends a ≤2000-word `WaveBrief` headed `Plan: <slug> | Wave: <wave_id>`; suborch returns and persists a parseable `WaveReport` with tasks, validation, commits or commit intent, snapshot ref, blockers, and `next_wave_unblocked`.
- **Retry policy**: Retry failed tasks only, reading any prior `WaveReport`; never amend—create a new retry commit such as `fix: wave W2 retry` or defer commit serialization to the orchestrator when multiple suborchs ran concurrently.

## Wave brief specification (the input contract)

`WaveBrief` is the only input contract. It is bounded, self-contained, and references—not duplicates—the final plan.

Required header:

```text
Plan: <plan_slug> | Wave: <wave_id> — <thesis>
```

Required JSON-ish body:

```json
{
  "schema_version": 1,
  "plan_slug": "fleet-process",
  "wave_id": "W2",
  "thesis": "Suborchestrators execute large waves without becoming a global bottleneck.",
  "dependencies_satisfied": true,
  "upstream_dependencies": ["W1"],
  "delegation_reason": "4 medium tasks; disjoint scope; no cycles",
  "tasks": [
    {
      "id": "W2-T3",
      "description": "Generalize suborchestrator prompt to WaveBrief mode.",
      "files": { "owns": ["prompts/suborchestrator.txt"], "shared": [] },
      "executor_tier": "executor-medium",
      "size": "M",
      "dependencies": []
    }
  ],
  "scope_matrix": [
    { "id": "W2-T3", "owns": ["prompts/suborchestrator.txt"], "shared": [] }
  ],
  "definition_of_done": [
    "Suborch accepts wave briefs and campaign briefs.",
    "Suborch returns WaveReport JSON and does not prose-only summarize."
  ],
  "validation_commands": [
    { "cwd": "/Users/jack.mazac/Developer/opencode-conductor", "command": "bun run check" },
    { "cwd": "/Users/jack.mazac/Developer/opencode-conductor", "command": "bun run smoke:runtime" }
  ]
}
```

Rules: do not inline the whole plan; suborch must call `read_final_plan(plan_slug)` before delegating. Child executor prompts should look like normal orchestrator prompts: same `Plan: <slug> | Task: <id> | Wave: <wave>` header, explicit `Owns`/`Shared`, exact commands, no special “suborch-managed” banner unless needed for scope enforcement.

## Wave report specification (the output contract)

`WaveReport` is structured JSON returned in the subagent result and persisted to `.opencode/wave-reports/<plan_slug>/<wave_id>.json` via a Conductor wave-report tool.

```json
{
  "schema_version": 1,
  "plan_slug": "fleet-process",
  "wave_id": "W2",
  "status": "completed",
  "agent_run_id": "agrun_...",
  "correlation_id": "corr_...",
  "tasks_completed": ["W2-T1", "W2-T2", "W2-T3"],
  "tasks_failed": [],
  "commits": [
    { "hash": "abc1234", "message": "feat: execute wave W2", "paths": ["prompts/suborchestrator.txt"] }
  ],
  "validation_results": [
    { "cwd": "/Users/jack.mazac/Developer/opencode-conductor", "command": "bun run check", "status": "passed", "exit_code": 0, "summary": "159 tests passed" }
  ],
  "snapshot_ref": "artifact:wave_snapshot:...", 
  "blockers": [],
  "next_wave_unblocked": true,
  "retry_of": null
}
```

`status` can be `running | partial | completed | failed`. On retry, suborch first reads the existing report, skips `tasks_completed`, includes `retry_of`, and emits a new commit rather than amending. If multiple suborchs run concurrently in one worktree, the report may contain `commit_intent` and a blocker `commit_deferred_by_parallel_git_index`; orchestrator then serializes path-scoped commits.

## Wave-level task breakdown for fleet-process

| ID | Task | Owner repo | Files | Size | Executor tier | Deps | Risks |
|---|---|---|---|---|---|---|---|
| B1 | Define canonical `WaveBrief`/`WaveReport` and `wave_report` artifact kind | `opencode-fleet-contracts` | `src/artifacts.ts`, new `src/waves.ts`, `src/index.ts`, `src/*.test.ts`, README | M — additive contracts + tests | executor-medium | Planner E alignment | Contract ripple; avoid schema v2; no plugin-specific fields in shared shapes |
| B2 | Add Conductor wave-report persistence tools | `opencode-conductor` | new `src/workflow-tools/wave-report.ts`, `src/workflow-artifacts.ts`, `src/plugin-contract.test.ts`, `src/index.test.ts`, `src/contracts-compat.test.ts` | M — new internal tool trio | executor-medium | B1 | Tool count changes; codemem high-risk dependency cone; must update runtime smoke expectations |
| B3 | Generalize `suborchestrator` prompt from campaign runner to wave executor | `opencode-conductor` | `prompts/suborchestrator.txt` | M — full prompt rewrite but one file | executor-medium | B1/B2 shape agreed | Prompt ambiguity could make suborch duplicate plan context or skip report persistence |
| B4 | Update orchestrator prompt delegation policy | `opencode-conductor` | `prompts/orchestrator.txt` | M — multiple doctrine sections | executor-medium | B1/B3 | Too much policy may slow orch; keep threshold hardcoded and computed, not user-visible |
| B5 | Update runtime agent permissions/config for wave suborch | `~/.config/opencode` | `opencode.json` agent.suborchestrator, possibly `fleet.jsonc` expected_tools, `.opencode-fleet.lock.json`, `bun.lock` if install changes | S/M — config-only unless regenerate/install changes lock | executor-low | B2/B3 | `opencode.json` plugin array is generated; preserve user-owned sections and run Fleet regeneration workflow if needed |
| B6 | Validate and document process convention | `opencode-conductor` + config | `README.md` or `AGENTS.md` only if convention needs durable docs; no executor/reviewer/scribe prompt edits | S | executor-low or scribe after implementation | B1-B5 | Documentation duplication; keep executor/reviewer/scribe prompts unchanged per constraint |

Verification gates: `opencode-fleet-contracts`: `bun run check`. `opencode-conductor`: `bun run check`, `bun run smoke:runtime`, `bun run doctor -- --json`, `bun run status -- --json`. `~/.config/opencode`: `bun run fleet:doctor -- --json`, `bun run fleet:test -- --json`, `bun run fleet:test:full-runtime`, `bun run fleet:hygiene -- --strict --json`, `bun run check`.

## Prompt changes

- `prompts/suborchestrator.txt`: replace “Campaign methodology” with “Wave/campaign methodology”; accept either legacy campaign briefs or `WaveBrief`; require `read_final_plan` when `Plan:` is present; validate `dependencies_satisfied`; partition by task scope rather than discovering file patterns; spawn child executors using the task’s requested tier; call reviewer for medium/high-risk tasks; call validator after all tasks complete; persist `WaveReport`; cap retries at initial + 2; return JSON report plus minimal human summary.
- `prompts/orchestrator.txt`: replace “one suborchestrator/campaign at a time” reminders with “one suborch per disjoint scope”; add direct-vs-suborch threshold; update `Campaign detection` to `Wave delegation`; add WaveBrief template; require active scope comparison before parallel suborch spawn; keep review waves orchestrator-owned; keep final plan table user-facing and compute `Delegation` internally rather than adding a user-visible column by default.
- `~/.config/opencode/opencode.json`: update suborch description from campaign-only to wave/campaign executor; allow `read_final_plan`, `wave_report_read/write`, `executor-high` (and optionally `executor-genius` when task tier demands), `reviewer`, and `validator` for the suborch. Keep executor/reviewer/scribe prompt files unchanged.

## Contracts impact

- Add `ArtifactKind: "wave_report"` in `opencode-fleet-contracts/src/artifacts.ts` with tests; no schema version bump because it is additive.
- Prefer shared `WaveBrief` and `WaveReport` validators in contracts if Planner E wants Engram/reflection/fleet-wide consumers to parse them; otherwise keep the type in Conductor but do not duplicate it later.
- Telemetry can use current `TelemetryKind = ${string}.${string}`: emit `wave.started`, `wave.completed`, `wave.failed` with existing `plan_slug`, `wave_id`, `agent_run_id`, `correlation_id`, `durationMs`, and optional `artifact_ref`; no telemetry schema v2 needed.
- `agent_run_id` remains per agent: orchestrator run, suborch run, and child executor/reviewer/validator runs are distinct; `correlation_id` stays stable across the wave.

## Dependencies on other planners

- **Planner A (worktree)**: Confirms suborch inherits cwd/branch, codemem daemon path, and whether parallel suborchs may commit directly or must defer commits to orchestrator when sharing one git index.
- **Planner C (snapshots)**: Provides `snapshot_ref` shape and wave snapshot timing so `WaveReport.snapshot_ref` can be required instead of optional.
- **Planner D (reflection)**: Consumes `.opencode/wave-reports/<plan>/<wave>.json`; reflection should treat `tasks_failed`, `blockers`, and retry commits as first-class evidence.
- **Planner E (cross-cutting)**: Owns shared contracts, telemetry naming, artifact kind addition, and any fleet config expected-tool changes.

## Open questions / user decisions

- Should parallel suborchs be allowed to create git commits directly in the same worktree? I recommend direct commits only when one suborch is active; otherwise suborchs report `commit_intent` and the orchestrator serializes commits to avoid global git index races.
- Should `executor-genius` be spawnable by suborch when a canonical wave task specifies it? I recommend yes for invisibility, but it has cost implications.
- Should `Delegation` appear in the user-visible final plan execution table? I recommend no; compute it internally to keep the optimization virtually invisible.

## Type flow claim

`WaveBrief` and `WaveReport` are the only canonical shapes. The orchestrator derives `WaveBrief` directly from the persisted final plan’s wave/task/scope data; suborch validates it, passes task slices unchanged to child agents, then emits the same `WaveReport` object it persists. No parallel DTOs, no per-hop mappers, and no assertion-based “cast-to-green” path.