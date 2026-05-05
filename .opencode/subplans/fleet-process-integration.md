# Planner E return: Cross-cutting integration

## Priming
- **User-visible outcome**: future plans run in isolated worktrees with wave accountability, snapshots, and reflection while the normal user path still looks like “ask the orchestrator to do work.” Ops can inspect status/doctor/hygiene when needed.
- **Failure modes**: schema drift breaks all plugins; worktree metadata diverges from Git; snapshots accidentally persist prompts/tool output; suborch wave reports become new rituals for agents; Engram cannot retrieve new artifacts; expected tool counts drift; merge conflicts break invisibility.
- **Patterns to preserve**: contracts live in `opencode-fleet-contracts`; Conductor writes `.opencode/*` workflow artifacts and indexes final plans in `.opencode/plans/index.json`; Fleet owns manifest/runtime checks; Engram ingests artifacts passively; Concord remains hook-only; telemetry uses `makeEnvelope` and the existing local JSONL sink.
- **Root cause correlation**: A/B/C/D all need “metadata-only lifecycle artifacts plus canonical refs.” Solve with one contracts addition and one artifact-discovery expansion, not four local schemas.
- **Type pipeline**: canonical contracts types flow from file writer/CLI boundary → artifact ref/plan index → Engram/Fleet health views. One decode at file/JSON boundary; no per-plugin casts, mappers, or shim stacks.
- **Contract/vendor audit**: reviewed `opencode-fleet-contracts/src/{artifacts,telemetry,ids,context,health}.ts`, Conductor `src/{index,workflow-artifacts,plan-artifacts}.ts`, Fleet `src/{manifest,doctor,hygiene,plugin-commands,status,telemetry,schema}.ts`, Engram `src/{artifacts,config,runtime,dashboard}.ts`, and config `fleet.jsonc`/`package.json`.
- **Codemem signals**: `codemem_conflicts` reported no parallel-session conflicts. `codemem_before_edit`/`change_risk` is high for Conductor plan artifacts: `src/plan-artifacts.ts` has 10 public exports, 17-file dependency cone, and API drift findings touching `src/index.ts`, `src/index.test.ts`, and `src/plan-artifacts.test.ts`. Treat plan-index changes as guarded API work.

## Consolidated contracts patch
- ArtifactKind additions (additive):
  - Add `wave_snapshot`, `reflection`, `worktree_metadata`, and `wave_report` to `ArtifactKind` and `isArtifactKind` in `src/artifacts.ts`.
  - Do **not** add ambiguous `worktree`; the artifact is metadata about a Git worktree, not the checkout itself.
  - Do **not** add a new persistent store kind. All files remain under `.opencode/` and are ingestible artifacts.
- TelemetryKind additions:
  - Canonical event strings: `fleet.worktree.created`, `fleet.worktree.merged`, `fleet.worktree.merge_failed`, `fleet.worktree.cleaned_up`, `wave.started`, `wave.completed`, `wave.failed`, `wave.snapshot.written`, `reflection.written`, `reflection.deferred`.
  - Current `TelemetryKind` already accepts dot-delimited `${string}.${string}`. Add a const tuple / named `FleetProcessTelemetryKind` for discoverability only; no validator shape change.
- New type definitions:
  - Add one new contracts module, e.g. `src/process.ts`, exported from `src/index.ts`, containing:
    - `WorktreeStatus = "active" | "merged" | "merge_failed" | "cleaned_up" | "abandoned"`.
    - `WorktreeMetadata`: `schema_version: 1`, `plan_slug`, optional `plan_id`, `workspace_id`, `path`, `branch`, `base_branch`, `created_at`, optional `merged_at`, `cleaned_up_at`, `status`, optional `merge_commit`, `error`.
    - `WaveBrief`: minimal orchestrator-owned metadata (`plan_slug`, `wave_id`, `title`, `depends_on`, `scope`, optional `artifact_refs`) — not full prompts.
    - `WaveReport`: metadata-only suborch completion record with status, start/finish/duration, tasks, touched files, commits, artifact refs, verification commands/results, blockers, and summary.
    - `WaveSnapshot`: metadata-only frozen state: plan IDs, wave ID, commit/base commit, artifact refs, contributing subplans, wave reports, metrics, and tool/run refs. Explicitly exclude raw prompts, tool outputs, and source payloads.
    - `ReflectionFrontmatter` / `Reflection`: plan slug, wave IDs, commits, metrics, cited artifact refs, created_at, optional deferred reason; markdown body stays in the artifact file.
  - Prefer parser/guard helpers for these types in contracts tests rather than ad hoc downstream validation.
- Plan index JSON extensions:
  - Keep `schema_version: 1` and extend `PlanIndexEntry` with optional fields only:
    - `worktree?: { path: string; branch: string; base_branch?: string; created_at: string; merged_at?: string; cleaned_up_at?: string; status: WorktreeStatus; artifact_ref?: string }`
    - `contributing_subplans?: Array<{ slug: string; path: string; artifact_ref?: string; planner?: string; captured_at?: string }>`
    - `waves?: Array<{ wave_id: string; status?: string; snapshot_ref?: string; wave_report_ref?: string; reflection_ref?: string; commit?: string; started_at?: string; completed_at?: string }>`
    - `reflections?: Array<{ path: string; artifact_ref?: string; created_at: string; wave_ids?: string[] }>`
  - Existing `isPlanIndexEntry` already ignores extra fields if required fields are present, so old readers survive. New readers must tolerate absent fields.
- Schema version: STAYS AT 1 (proof: all changes are optional object fields, union member additions, and exported helper types. Existing envelopes, refs, health reports, and plan indexes remain valid. A bump is required only if a planner tries to require snapshots/reflections for all plans or changes existing field meaning; reject that design.)

## Telemetry topology table
| Kind | Source | Timing | IDs populated | Frequency |
|---|---|---|---|---|
| `fleet.worktree.created` | Fleet CLI worktree subcommand | after `git worktree add` and metadata write | `fleet_run_id`, `workspace_id`, `plan_id?`, `plan_slug`, `correlation_id?`, `artifact_ref` | p50 1/plan, p95 low single digits/day |
| `fleet.worktree.merged` | Fleet CLI | after successful merge to base branch | same + `durationMs` | p50 1/plan |
| `fleet.worktree.merge_failed` | Fleet CLI | on merge conflict/non-zero merge | same + `error` | rare; visibility required |
| `fleet.worktree.cleaned_up` | Fleet CLI | after metadata status update and worktree removal | same | p50 1/plan |
| `wave.started` | Conductor/orchestrator wave runner | before suborch/executor wave starts | `workspace_id`, `plan_id`, `plan_slug`, `wave_id`, `correlation_id` | p50 once/wave, p95 <20/plan |
| `wave.completed` | Conductor wave report writer | after wave report persisted | above + `artifact_ref`, `durationMs` | once/successful wave |
| `wave.failed` | Conductor wave report writer | after failed/blocked wave report persisted | above + `artifact_ref`, `error` | rare; per failed wave |
| `wave.snapshot.written` | Conductor snapshot writer | after atomic snapshot file write | above + `artifact_ref` | once/wave gate |
| `reflection.written` | Conductor reflection writer / orchestrator-invoked reflector | after reflection artifact write | `plan_id`, `plan_slug`, `wave_id?`, `correlation_id`, `artifact_ref` | once/plan by default |
| `reflection.deferred` | Conductor/orchestrator | when reflection intentionally skipped/deferred | `plan_id`, `plan_slug`, `correlation_id`, optional `error`/reason | rare |

All events must be constructed with existing `makeEnvelope` and validated by `validateTelemetryEnvelope`; no new sink, no remote telemetry, no hot-path blocking beyond the existing local append. Target p95 emission overhead: <5 ms because event volume is lifecycle-only. Snapshot/report file writes target p95 <25 ms locally and must remain metadata-only.

## Observability surface additions
- fleet:doctor: add opt-in checks for active plan worktrees and metadata health: count active, oldest active/abandoned age, metadata artifact parse validity, and “single telemetry sink still configured.” Default human output stays compact; `--json` carries details.
- fleet:hygiene: in `--strict`, fail on abandoned worktrees over threshold, missing wave snapshots for waves marked completed, invalid plan-index optional refs, and stale manifest expected_tools. Non-strict warns only.
- fleet:test: runtime profile validates the new Conductor tools only if present in manifest; host-adapter contract still owns loading. Add checks that contracts parse sample `WaveSnapshot`, `WaveReport`, `WorktreeMetadata`, and `ReflectionFrontmatter`.
- engram stats: add `stats --report insights` or overview line for new artifact kinds discovered/ingested (`wave_snapshot`, `wave_report`, `reflection`, `worktree_metadata`). This requires expanding `EngramConfig.integration.artifactPaths`/`discoverSources`; otherwise retrieval validation will fail.
- conductor status: add passive JSON fields for current worktree metadata, active waves, latest snapshot refs, and pending reflection. Existing text status can remain unchanged or add a short optional summary.

## Invisibility audit
| Change | User-visible? | Agent-visible? | Justification |
|---|---:|---:|---|
| New `.opencode/wave-reports`, `.opencode/snapshots`, `.opencode/reflections`, `.opencode/worktrees` files | Only if browsing repo | No | metadata-only artifacts; no required action |
| Fleet worktree subcommands | Ops-only | Orchestrator only | user does not run them in normal flow |
| Doctor/hygiene/status JSON fields | On request | No | hidden until invoked |
| Conductor artifact tools for reports/snapshots/reflections | No | Orchestrator only | executor/reviewer/scribe prompts unchanged |
| Contracts package type exports | No | No | compile-time/fleet-internal only |
| Engram artifact ingestion of new paths | No | No | passive default; retrieval improves silently |
| Orchestrator prompt rules | Indirectly yes | Orchestrator only | main orchestrator must learn worktree/wave/snapshot/reflection gates |
| Merge conflict or failed cleanup | Yes | Orchestrator sees failure | cannot be hidden safely; user must resolve or approve action |

## Migration + back-compat
- Existing fleet-correlation: no retroactive snapshots, reflections, or subplan relocation. It remains a valid schema_version 1 plan with absent optional fields.
- Legacy subplans: leave `.opencode/subplans/<slug>.md` as-is. New plans may preserve contributing subplans under plan-scoped directories, but do not migrate discarded campaigns.
- Mixed sessions: all readers must treat missing `worktree`, `waves`, `contributing_subplans`, and `reflections` as null/empty. Hygiene may warn only for plans created after fleet-process primitives are enabled.
- Fleet manifest: sync current drift first: `opencode-fleet/src/manifest.ts` default Conductor expected_tools is missing `context_usage` while `~/.config/opencode/fleet.jsonc` and `src/plugin-contract.test.ts` include it. Recommended Conductor bump is 31 → 37 **only if** new tools are exactly `wave_report_write/read`, `wave_snapshot_write/read`, and `reflection_write/read`; worktree operations stay in Fleet CLI. If B or A adds Conductor worktree/wave-report trios, count becomes 39–43 and must be explicitly reconciled before regeneration.

## End-to-end validation strategy
Use the new primitives on `fleet-process` itself starting after the contracts + first Conductor artifact tools ship. Concrete proof points:
- Worktree: `git worktree list` shows the orchestration branch; `fleet worktree list --json` reports active metadata; post-merge base branch is clean.
- Suborch waves: `.opencode/wave-reports/<plan_slug>/<wave_id>.json` exists for each new wave and has a canonical `wave_report` artifact ref.
- Snapshots: `.opencode/snapshots/<plan_slug>/<wave_id>.json` exists, is metadata-only, and appears in `memory`/`memory_context` after Engram ingest.
- Subplan preservation: plan-scoped contributing subplans are preserved after `persist_final_plan`, and `index.json` references them optionally.
- Reflection: `.opencode/reflections/<plan_slug>.md` exists, frontmatter cites wave IDs, commits, metrics, and artifact refs; `reflection.written` telemetry exists.
- Full-fleet smoke: run per repo `bun run check`; Conductor `bun run smoke:runtime && bun run doctor -- --json && bun run status -- --json`; config `bun run fleet:test:full-runtime && bun run fleet:hygiene -- --strict --json`; Engram retrieval-sensitive changes include `engram eval` or documented equivalent before final merge.

## Risk synthesis (top 8)
| # | Risk | Impact | Prob | Mitigation | Wave |
|---:|---|---|---|---|---|
| 1 | Expected tool count drift across Conductor/Fleet/config | High | Med | finalize one tool-name list; update plugin test, Fleet default, `fleet.jsonc`, generated config together | 1–2 |
| 2 | Snapshot captures raw prompts/tool output, violating invisibility/privacy | High | Med | contract says metadata-only; tests assert forbidden fields absent and size bounded | 2 |
| 3 | Worktree merge conflicts expose hidden machinery | Med | Med | stop, surface conflict, keep metadata `merge_failed`, require user decision | 3 |
| 4 | Engram cannot ingest new artifact paths | Med | High | update `artifactPaths`, `discoverSources`, content types, stats, and retrieval eval | 2–3 |
| 5 | Plan index optional fields become de facto required | High | Med | tests for legacy minimal index and mixed sessions; no backfill | 1–2 |
| 6 | Multiple planners define duplicate schemas locally | High | High | contracts patch lands first; downstream imports only contracts types | 1 |
| 7 | New observability scans add slow hot-path I/O | Med | Low | only doctor/hygiene/status scans; lifecycle writes measured with p95 targets | 3 |
| 8 | Reflection cadence becomes scheduler/product scope | Med | Med | ship manual/orchestrator-invoked reflection first; defer scheduler to user decision | 4 |

## Decisions needing user confirmation
1. Worktree working-directory location (`~/worktrees/...`, repo-adjacent, or other). This affects filesystem layout and cleanup semantics.
2. Engram DB continuity: shared project memory across worktrees versus per-worktree sidecar. Default should be shared continuity, but confirm because it changes retrieval scope.
3. Delayed/7-day reflection cadence. Recommend no scheduler in this plan; user confirmation required to add one.
4. Ship all five domains in one integrated plan vs split contracts/observability first, worktree/suborch/reflection later.
5. Retention thresholds for abandoned worktrees and metadata artifacts if strict hygiene will fail after N days.

Auto-decide unless contradicted: telemetry kind names above, `worktree_metadata` artifact naming, metadata-only snapshot path, reflector model tier bounded to a low/medium model, and `schema_version: 1`.

## Recommended wave shape
Five waves:
1. **Contracts foundation**: ArtifactKind additions, `process.ts` types/parsers/tests, telemetry kind constants, plan-index optional type definitions. Gate: contracts `bun run check`.
2. **Conductor/Engram artifact plumbing**: minimal Conductor report/snapshot/reflection write/read tools, plan-index optional fields, Engram discovery/stats for new kinds. Gate: Conductor `bun run check && bun run smoke:runtime`; Engram `bun run check` plus retrieval eval.
3. **Fleet worktree + observability**: Fleet worktree ops/metadata, doctor/hygiene/status JSON, telemetry events. Gate: Fleet `bun run check && bun run smoke`, config `bun run fleet:doctor -- --json`.
4. **Wave orchestration + reflection**: orchestrator-only prompt/tool usage for suborch waves, snapshots, final reflection; no executor/reviewer/scribe ritual changes. Gate: reflexive wave artifacts exist.
5. **Dogfood + merge**: run fleet-process waves under the new model, strict hygiene, full runtime, final merge. Gate: `bun run fleet:test:full-runtime`, clean worktree metadata, reflection written.

Commit strategy: one scoped commit per wave on the plan worktree branch; merge to base only after Wave 5 gates pass. Parallelize after Wave 1: Engram ingest, Fleet observability, and Conductor tool implementation can proceed independently but must reconverge before dogfood.

## Predicted inconsistencies between other planners
- A may propose Conductor-owned worktree tools; adjudication: Fleet CLI owns Git worktree operations, Conductor only records/reads refs if needed.
- B may either reuse progress or create `wave_report`; adjudication: use `wave_report` artifact kind and type, but avoid tool-count explosion by adding only write/read if a tool is needed.
- C may preserve full subplan content inside snapshots; adjudication: snapshots cite artifact refs and hashes only.
- D may propose a scheduled reflector; adjudication: ship reflection artifact/tool first, scheduler requires user confirmation.
- Several planners may request schema_version bumps for “new plan shape”; adjudication: reject unless an existing required field changes.
- Tool count forecasts may conflict: 31 → 37 is viable only under the minimal six-tool design; triads or worktree tools make the forecast false.
