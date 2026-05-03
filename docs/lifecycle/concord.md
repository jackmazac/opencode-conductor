# Concord Integration

Concord is the working-tree coordination source for concurrent OpenCode agents.

Boundary:

- Concord owns live file/range reservations, lock expiry, stale-read tracking, and conflict guidance.
- Lifecycle Integrity owns lifecycle object identity, artifact evidence, and source-of-truth decisions.
- Lifecycle modules may import Concord collision events as evidence.
- Lifecycle modules must not reinterpret or replace `<concord_conflict>` guidance.

Contract shape:

- `ConcordCorrelationRef` carries Concord correlation, plan, and intent fields.
- `ConcordCollisionArtifactRef` stores versioned collision evidence with file/range scope.
- `ExternalGuidanceEnvelope` preserves Concord XML guidance as a content-addressed artifact.

Usage:

- If an edit is blocked by Concord, show Concord's guidance directly.
- If a lifecycle decision references a Concord collision, store it as evidence, not as the decision itself.
- If future Concord metadata accepts lifecycle IDs, pass `decision_id`, `object_id`, and spine `correlation_id` through without changing Concord's lock semantics.

## Context Ingestion Flow

Conductor imports Concord collisions with `lifecycle_concord_ingest`:

```sh
concord collisions --json --worktree <repo> --since <checkpoint> --correlation <correlation_id>
```

The ingest tool writes:

- `.opencode/lifecycle/artifacts/concord/<event_id>.json` for structured collision evidence.
- `.opencode/lifecycle/artifacts/concord/<event_id>.xml` for exact `<concord_conflict>` guidance when present.
- `concord.collision.detected` spine events with `tool_call_id = concord:<event_id>`.
- A Concord checkpoint under the spine consumer id `conductor.lifecycle_concord_ingest`.

Engram can ingest those lifecycle artifacts and retrieve conflict-aware context with correlation signals:

```sh
engram ingest-artifacts --apply --kind concord_collision --project-id <project_id> --worktree <repo>
engram context "Concord conflict context" \
  --project-id <project_id> \
  --worktree <repo> \
  --mode debug \
  --correlation-id <correlation_id> \
  --concord-event-id <event_id> \
  --artifact-ref artifact:.opencode/lifecycle/artifacts/concord/<event_id>.json:<hash>
```

Conductor wraps this in `conflict_context`, which optionally runs Engram artifact ingestion and then performs one correlation-aware `engram context` call. Use it when an agent needs the relevant historical plan/status/memory context for a Concord collision without manually stitching artifact refs and correlation flags.

Subagents should call `run_init` at the start of substantial work. The returned `agent_run_id`, `correlation_id`, and `workspace_id` are the canonical join keys across Concord, lifecycle spine events, Engram context bundles, and Fleet telemetry. `run_init` writes both `.opencode/runs/run_<id>.json` and a compact `.opencode/status/run-<id>.json` mirror so normal status tooling can surface active run ownership without parsing the full run record.

Use `run_update` during longer work to mark the run `in_progress` or `blocked`, update touched paths, and keep the status mirror fresh. Use `run_finish` to mark the run `done`, `blocked`, or `cancelled` with a final summary.
