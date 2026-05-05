# Planner C return: Snapshots + subplan lineage

## Priming
- **User-visible outcome**: No new user action. At plan reflection time, the user sees more accurate wave retrospectives because each completed wave has a small immutable metadata snapshot and final plans retain the planner drafts that informed them.
- **Failure modes**: snapshots become too large or slow if tools compute diffs; duplicate wave writes obscure history; preserved subplans are misclassified as final plans by Engram; `discard_subplan` deletes reasoning that `persist_final_plan` promised to preserve; plan index decoding drops older entries.
- **Patterns to preserve**: Conductor tools are thin artifact writers under `.opencode/`, use atomic temp-file writes, validate branded IDs via `@jackmazac/opencode-fleet-contracts`, avoid direct Zod imports in `src/`, register every tool in `plugin-contract.test.ts` and `scripts/runtime-smoke.ts`. Engram artifact ingestion is path/discovery based and must remain optional/passive.
- **Root cause correlation**: both ideas solve the same reflection provenance gap: “what changed in wave W?” and “which planner reasoning led to this wave?” should be artifact references, not raw chat history.
- **Type pipeline (primed)**: one canonical `WaveSnapshot` contract flows from suborch/validator output → Conductor writer → `.opencode/snapshots/...json` → Engram ingest/reflection. Subplan lineage is one optional `contributing_subplans` array on `PlanIndexEntry`; no mappers or assertions.
- **Contract & vendor audit (primed)**: read `opencode-fleet-contracts/src/artifacts.ts`, `src/ids.ts`; Conductor `src/index.ts`, `src/plan-artifacts.ts`, `src/workflow-artifacts.ts`, `src/plan-artifacts.test.ts`, `src/plugin-contract.test.ts`, `scripts/runtime-smoke.ts`; Engram `src/artifacts.ts`, `src/config.ts`, `AGENTS.md`; package scripts in all relevant repos.
- **Memory/eval check**: `memory_context` returned only the current Planner C brief, no higher-authority prior design. Plan requires Engram artifact ingest tests plus `engram` eval fixture coverage after adding `wave_snapshot`; do not add sqlite-vec or any vector backend.
- **Codemem signals (primed)**: `codemem check` had no findings globally. `codemem before_edit/change_risk` on Conductor plan/tool files returned high risk because `src/index.ts`, `src/plan-artifacts.ts`, and `src/workflow-artifacts.ts` are public/exported and affect 21 files; implementation must keep changes additive and prioritize `src/index.test.ts`, `src/plan-artifacts.test.ts`, `src/plugin-contract.test.ts`, and runtime smoke.

## Recommended approach
- **WaveSnapshot shape (TS type block)**:
```ts
import type {
  ArtifactRef,
  PlanId,
  PlanSlug,
  WaveId,
} from "@jackmazac/opencode-fleet-contracts";

export type WaveSnapshotStatus = "met" | "not_met" | "deferred";

export type WaveSnapshotFileChange = {
  path: string;
  // null represents git numstat "-" for binary/unmeasured files.
  added: number | null;
  removed: number | null;
};

export type WaveSnapshotNumericDelta = {
  before: Record<string, number>;
  after: Record<string, number>;
  diff: Record<string, number>;
};

export type WaveSnapshotSubplanRef = {
  slug: PlanSlug;
  planner_domain: string;
  path: string;
  synthesized_into_waves: WaveId[];
  artifact_ref?: ArtifactRef;
};

export type WaveSnapshotDodItem = {
  criterion: string;
  status: WaveSnapshotStatus;
  notes?: string;
};

export type WaveSnapshot = {
  schema_version: 1;
  plan_id: PlanId;
  plan_slug: PlanSlug;
  wave_id: WaveId;
  commit_hash: string;
  previous_commit: string | null;
  started_at: string;
  finished_at: string;
  durationMs: number;
  files_changed: WaveSnapshotFileChange[];
  test_delta: WaveSnapshotNumericDelta;
  metric_deltas: Record<string, WaveSnapshotNumericDelta>;
  artifact_refs: ArtifactRef[];
  subplan_refs: WaveSnapshotSubplanRef[];
  dod_checklist: WaveSnapshotDodItem[];
  summary: string;
};
```
Contracts should also expose `parseWaveSnapshot(value: unknown)` implemented with `isRecord` guards, `parsePlanId`, `parsePlanSlug`, `parseWaveId`, and `parseArtifactRef`; no `as`, `any`, or deep coercion.

- **Storage path**: `.opencode/snapshots/<plan_slug>/<wave_id>.json`, written atomically via `<wave_id>.json.tmp` then rename. The snapshot’s returned `artifact_ref` uses `buildArtifactRef({ kind: "wave_snapshot", path, hash })`.
- **Write trigger (Planner B coordinates)**: suborch calls `wave_snapshot_write` after a wave reaches terminal validation and after any wave artifacts/progress/run records are already written. The tool is invisible to executor/reviewer/scribe.
- **Subplan preservation mechanism (persist_final_plan changes)**: `persist_final_plan` accepts optional `contributing_subplans`. For each entry, move `.opencode/subplans/<slug>.md` to `.opencode/plans/<final_slug>/subplans/<planner_domain>.md`, record metadata in the plan index, and return preserved metadata. `read_subplan(slug)` scans both live draft files and preserved index metadata; `discard_subplan(slug)` is a no-op for preserved drafts unless `force: true`.
- **Plan index JSON diff**: source currently uses `{ schema_version: 1, entries: { ... } }` rather than the flat shorthand in the brief. The change is additive inside each `PlanIndexEntry`:
```jsonc
{
  "schema_version": 1,
  "entries": {
    "fleet-process": {
      "plan_id": "pln_...",
      "plan_slug": "fleet-process",
      "path": ".opencode/plans/fleet-process.md",
      "contributing_subplans": [
        {
          "planner_domain": "snapshots-subplan-lineage",
          "slug": "snapshots-subplan-lineage",
          "path": ".opencode/plans/fleet-process/subplans/snapshots-subplan-lineage.md",
          "synthesized_into_waves": ["W3", "W4"]
        }
      ],
      "created_at": "...",
      "updated_at": "..."
    }
  }
}
```
Existing entries without `contributing_subplans` remain valid; no backfill of `fleet-correlation`.

## Wave-level task breakdown
| ID | Task | Owner repo | Files | Size | Executor tier | Deps | Risks |
|---|---|---|---|---|---|---|---|
| C1 | Add `wave_snapshot` contract and validators. Tests first: artifact kind round-trip and `parseWaveSnapshot` rejects malformed IDs/refs. Verify `bun run check`. | `opencode-fleet-contracts` | `src/artifacts.ts`, `src/artifacts.test.ts`, maybe `README.md` | S-M | executor-medium | none | Parser sprawl; keep one boundary parser and exported type. |
| C2 | Add Conductor snapshot tools: `wave_snapshot_write/read/list`; register and smoke-test. Tests first for atomic write, artifact_ref, duplicate handling, read-one/read-all/list. Verify `bun run check` and `bun run smoke:runtime`. | `opencode-conductor` | `src/workflow-tools/wave-snapshot.ts`, `src/workflow-artifacts.ts`, `src/plugin-contract.test.ts`, `scripts/runtime-smoke.ts`, `src/index.test.ts` | M | executor-medium | C1 | Tool count changes from 31 to 34; fleet manifest update belongs to Planner E/fleet config wave. |
| C3 | Preserve contributing subplans in final plan persistence. Tests first: move on persist, plan index metadata, `read_subplan` lookup after move, `discard_subplan` no-op, `force` deletes only when requested. Verify `bun run check` and `bun run smoke:runtime`. | `opencode-conductor` | `src/plan-artifacts.ts`, `src/plan-artifacts.test.ts`, `src/index.ts`, `src/index.test.ts` | M | executor-medium | none | Ambiguous reused subplan slugs across final plans; return matches or require final slug if ambiguity appears. |
| C4 | Update Engram artifact ingestion for `wave_snapshot` and preserved subplans. Tests first: discovery classifies `.opencode/snapshots/**/*.json` as `wave_snapshot` and `.opencode/plans/*/subplans/*.md` as `subplan`, not `plan`. Verify `bun run check` plus `bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .` after adding a fixture. | `engram` | `src/artifacts.ts`, `src/config.ts`, `test/learning-modules.test.ts`, eval fixture | M | executor-medium | C1 | Current source does not ingest `.opencode/subplans` and would classify nested plan subplans as `plan` unless fixed. |
| C5 | Documentation and fleet wiring. Document snapshot immutability, caller-supplied metrics/numstat, new subplan preservation semantics, and update fleet expected tool count/regenerate config. Verify Conductor/Fleet `bun run fleet:test:full-runtime` after integration. | `opencode-conductor`, `~/.config/opencode`, maybe `opencode-fleet` | `README.md`, `AGENTS.md` if needed, `fleet.jsonc`, generated `opencode.json` | S | executor-low | C2-C4 | Generated config must not be hand-edited; coordinate with Planner E. |

## Contracts impact
- Add `"wave_snapshot"` to `ArtifactKind` and `isArtifactKind` in `opencode-fleet-contracts`.
- Add canonical `WaveSnapshot` exported type and `parseWaveSnapshot` decode helper. This is additive; schema_version remains `1`.
- Optional: add `WaveSnapshotSubplanRef`/`WaveSnapshotNumericDelta` helper types in contracts so Conductor and Engram do not invent parallel shapes.
- Telemetry: no new telemetry envelope required for MVP. If Planner E wants metrics, emit existing tool invocation telemetry with kind/name `wave_snapshot_write`; do not widen core telemetry shape unless additive and nullable.

## Conductor tool changes
- `wave_snapshot_write(args)` signature: all `WaveSnapshot` fields except `schema_version` are supplied by caller, plus `overwrite?: boolean`. The writer validates, adds `schema_version: 1`, writes JSON, hashes it, and returns `{ artifact_ref, path }`.
- Duplicate policy: identical retry returns existing `{ artifact_ref, path }`; different duplicate errors unless `overwrite: true`. This handles suborch retries without silently rewriting history.
- File listing call: caller supplies `files_changed`. My call is **no git shell inside the writer**. Planner B/suborch may compute it with `git diff --numstat <previous>..HEAD`, but the snapshot tool stays deterministic, fast, and worktree-model agnostic. Same recommendation applies to `commit_hash` and `previous_commit`; if the orchestrator insists on `git rev-parse` in-tool, make it only an optional fallback.
- `wave_snapshot_read({ plan_slug, wave_id? })`: with `wave_id`, return one parsed snapshot; without, return all snapshots for the plan sorted by filename or `finished_at`.
- `wave_snapshot_list({ plan_slug? })`: compact summaries: plan_slug, wave_id, commit_hash, previous_commit, finished_at, durationMs, file count, artifact/subplan counts, DoD met/not_met/deferred counts, path.
- No `wave_snapshot_done` in MVP. Snapshots are immutable provenance, not transient progress. Add a purge/TTL maintenance tool only if disk growth is observed and explicitly approved.
- `persist_final_plan`: add optional `contributing_subplans: Array<{ slug; planner_domain; synthesized_into_waves }>`.
- `discard_subplan`: add `force?: boolean`; if slug is preserved under a final plan and `force` is not true, return preserved path metadata and do not delete.
- `read_final_plan`: include contributing subplan metadata in the structured summary when listing/reading by slug or plan_id.

## Engram integration
- Add `wave_snapshot` to Engram’s local artifact kind union, authority map, and content type mapping (likely `milestone` or `analysis`; prefer `milestone`).
- Add a configured/default artifact path for snapshots, e.g. `integration.artifactPaths.snapshots: ".opencode/snapshots"`, and discover `*.json` there as `wave_snapshot`.
- Add subplan discovery for both `.opencode/subplans/*.md` and `.opencode/plans/*/subplans/*.md` as `subplan`; ensure the generic plan walker does not also ingest preserved subplans as `plan`.
- Existing artifact ingestion already emits canonical artifact refs with `buildArtifactRef`, inserts `chunk_correlation`, and can carry base `plan_id/wave_id` when invoked with correlation. For richer correlation from snapshot contents, Planner E/Engram can later parse `plan_id`/`wave_id` from `WaveSnapshot`, but MVP retrieval works with content plus artifact_ref.
- Re-ingest on move is acceptable: path changes produce a new artifact source. Document that preserved subplans are new-plan-only and old draft paths are not backfilled.

## Dependencies on other planners
- **Planner A (worktree)**: define stable commit source per worktree/branch so suborch can pass `commit_hash` and `previous_commit` without Conductor guessing branch topology.
- **Planner B (suborch)**: owns wave-end trigger, collects validator test/metric deltas, computes bounded `files_changed`, supplies DoD statuses, and calls `wave_snapshot_write` after validation.
- **Planner D (reflection)**: reads `wave_snapshot_read/list` and plan-index `contributing_subplans`; should not require executor/reviewer agents to know snapshots exist.
- **Planner E (cross-cutting)**: contracts bump, telemetry naming, fleet expected_tools update/regeneration, and any optional extraction of `plan_id/wave_id` from snapshot contents into Engram correlation.

## Open questions / user decisions
- Confirm no `wave_snapshot_done` for MVP; immutable snapshots are the recommendation.
- Confirm caller-supplied `commit_hash`, `previous_commit`, and `files_changed`; if not, accept a slower/less decoupled optional git fallback.
- Confirm no historical backfill for `fleet-correlation` subplans. New plans only.
- Disk bloat risk is low at the requested sizes, but if planner drafts include pasted tool output, enforce a warning or cap around preserved subplans (for example 64KB) before considering compression/TTL.

## Type flow claim
One canonical `WaveSnapshot` type is decoded once at the Conductor tool boundary and then written/read/ingested unchanged. Plan index remains the existing `PlanIndexEntry` with one optional `contributing_subplans` field. No cast-to-green, shim stack, or normalizer chain is required.