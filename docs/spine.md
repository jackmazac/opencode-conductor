# Event Spine — Wave 0 Contracts

This document describes the repo-scoped event spine and shared message contracts introduced in Wave 0 of the Lifecycle Integrity plan. It is written for plugin authors and tooling integrators who need to emit events, query history, or interpret freshness state.

---

## Purpose

The event spine is a local SQLite-backed append-only event log that gives all lifecycle plugins a shared identity surface:

- A single place where session, correlation, actor, workspace, and epoch context are recorded per event.
- A DB-assigned monotonic sequence number (`seq`) that establishes total ordering of events within a repo.
- A freshness model that lets plugins query current truth without requiring them to rebuild all history.

Without a shared spine, each plugin would invent its own event identity, resulting in irreconcilable rollback semantics and stale decisions that silently disagree with each other.

The spine is **local-first**. It is scoped to a single repository and does not replicate, sync, or federate across workstations or CI instances in Wave 0.

---

## Event Envelope Identity Fields

Every event stored in the spine carries the following identity fields. The `AppendEventInput` type (from `packages/bridge-contracts/src/events.ts`) defines what the emitter provides; `PluginEvent` extends it with `seq` after insert.

| Field | Type | Source | Description |
|---|---|---|---|
| `seq` | `integer` | DB-assigned | Monotonic, auto-incremented by SQLite `AUTOINCREMENT` on insert. Must never be set by the emitter. |
| `workspace_id` | `string` | emitter | Identifies the workspace (repo path hash or explicit config value). Validated against the `SpineStore`'s `workspaceId` at append time. |
| `workspace_root` | `string` | emitter | Absolute filesystem path to the workspace root. Validated against the `SpineStore`'s `workspaceRoot` at append time. |
| `session_id` | `string` | emitter | Identifies the tool session or invocation that produced the event. |
| `correlation_id` | `string` | emitter | Groups causally related events across multiple plugins or actors. |
| `actor_id` | `string` | emitter | Identifies the plugin, module, or agent that emitted the event. |
| `parent_seq` | `integer \| undefined` | emitter | Optional reference to the `seq` of the parent spine event for causal chaining. |
| `epoch_id` | `integer` | emitter | The current rollback epoch at time of emission. Must match the spine's active epoch at append time; a mismatch throws. |
| `snapshot_id` | `string \| undefined` | emitter | Optional content-addressed snapshot reference (e.g. `sha256:<hex>`) for events that carry or refer to artifact snapshots. |
| `tool_call_id` | `string \| undefined` | emitter | Optional identifier when the event is produced inside a specific tool invocation. |
| `plugin` | `string` | emitter | Plugin or module that produced this event (e.g. `origin`, `seal`, `portage`). Core spine events use `core`. |
| `kind` | `string` | emitter | Namespaced dot-path event kind, e.g. `tool.before` or `origin.scan.completed`. Must match `^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)*$`. |
| `ts` | `integer` | emitter | Unix timestamp in milliseconds at emit time. |
| `payload_hash` | `string` | emitter | Content hash of the event payload (e.g. `sha256:<hex>`). Callers compute and supply this; the spine stores it verbatim. |

### Key constraint: `seq` is DB-assigned

The `seq` field must **never** be set by the emitter. `AppendEventInput` is defined with `.strict()`, so passing a `seq` field is a Zod parse error — the spine rejects it rather than silently stripping it. SQLite assigns `seq` atomically on `INSERT`.

### Key constraint: `epoch_id` must match the current epoch

`appendEvent` reads the active epoch from the `current_epoch` table and throws if the supplied `epoch_id` does not match. Emitters must call `getCurrentEpoch()` immediately before constructing the input and pass the result unchanged.

---

## Epoch Model and Freshness Semantics

### What is an epoch?

An epoch is a monotonic integer counter managed by the spine. It advances whenever a rollback is completed via `completeRollback`. Specifically:

- Epoch `N` contains all events emitted before a rollback completes.
- When `completeRollback` runs, the epoch counter advances to `N+1` and the previous epoch is marked `closed` in the `epochs` table.
- Events from epoch `N` are hidden from default fresh reads after the rollback.

### Default query semantics: current epoch, not invalidated

Unless a caller requests historical or stale data via `listEvents({ freshness: "include_stale" })`, the spine filters to:

```sql
WHERE seq > ?
  AND epoch_id = <current_epoch>
  AND NOT EXISTS (
    SELECT 1 FROM event_invalidations WHERE event_invalidations.event_seq = events.seq
  )
ORDER BY seq ASC
```

Events are not modified when they become stale. The `event_invalidations` table holds invalidation rows; the event rows themselves remain immutable.

### Freshness status values

These four values are exported by `bridge-contracts` as the `Freshness` type and appear in `FreshQueryResult.status`:

| Status | Meaning |
|---|---|
| `fresh` | Data is in the current epoch and has not been invalidated. |
| `stale` | Data belongs to an epoch that has been superseded by a rollback, or a plugin checkpoint's epoch is behind the current epoch. Readable with explicit opt-in. |
| `recomputing` | Computation is in progress; gate decisions should await or treat as stale. |
| `unavailable` | No data found for the query scope. |

Plugin checkpoints also allow a fifth status, `error`, for cases where recomputation failed.

### FreshQueryResult wrapper

Freshness-aware reads return a `FreshQueryResult` discriminated union keyed on `status`:

- `fresh` — includes `data`, `as_of_seq`, `epoch_id`.
- `stale` — includes optional `data`, `as_of_seq`, `epoch_id`, and `current_epoch_id`.
- `recomputing` — includes optional `data`, `as_of_seq`, `epoch_id`.
- `unavailable` — `as_of_seq` and `epoch_id` are optional and may be absent.

---

## Rollback Invalidation

When a rollback completes (`completeRollback`), the spine does **not** delete historical events. Instead it:

1. Appends a `spine.rollback.completed` event in the current epoch.
2. Inserts a new row in the `epochs` table for `N+1` and marks epoch `N` as `closed`.
3. Updates `current_epoch` to `N+1`.
4. Inserts rows into the `event_invalidations` table for every event in epoch `N` that falls after the target snapshot's `seq` (or all events in epoch `N` if no target snapshot is found).
5. Marks all `fresh` plugin checkpoints for the workspace/epoch as `stale`.

**Events are immutable.** There is no `freshness_status` column on event rows. Staleness is expressed entirely through the `event_invalidations` table and the epoch mismatch between the event's `epoch_id` and `current_epoch`.

A rollback also has a start phase (`startRollback`) that appends a `spine.rollback.started` event in the current epoch before the transaction commits.

**Wave 0 limitation**: Rollback invalidation operates at epoch granularity relative to a target snapshot. Events in the rolled-back epoch with `seq` ≤ the target snapshot's `seq` are preserved (not invalidated). Fine-grained selective invalidation within an epoch is not supported beyond this snapshot-boundary rule.

---

## Plugin Checkpoints

Plugins that derive computed state from spine events should record a **checkpoint** row to track their consumption high-watermark. A checkpoint captures:

| Field | Type | Description |
|---|---|---|
| `plugin` | `string` | Plugin name (part of primary key with `consumer_id` and `workspace_id`). |
| `consumer_id` | `string` | Identifies the specific consumer within the plugin. |
| `workspace_id` | `string` | Workspace scope. Defaults to the store's `workspaceId` if omitted. |
| `epoch_id` | `integer` | Epoch at checkpoint time. Defaults to current epoch if omitted. |
| `last_seq` | `integer` | The highest `seq` consumed to produce the checkpoint's derived result. |
| `status` | `string` | One of `fresh`, `stale`, `recomputing`, `unavailable`, `error`. Defaults to `fresh`. |
| `updated_at` | `integer` | Unix milliseconds; set by the spine at write time. |
| `error_message` | `string \| undefined` | Optional error detail when `status` is `error`. |

Checkpoints are upserted on `(plugin, consumer_id, workspace_id)`. Each `recordCheckpoint` call replaces all mutable fields for that key.

### Checkpoint freshness

`getCheckpointFreshness` returns a `FreshQueryResult`:

- Returns `fresh` only when the checkpoint exists, its `status` is `fresh`, and its `epoch_id` matches the current epoch.
- Returns `stale` (with the checkpoint as `data`) if the checkpoint exists but its epoch is behind.
- Returns `unavailable` if no checkpoint row exists for the given `(plugin, consumer_id, workspace_id)`.

### Checkpoint recomputation expectations

When a checkpoint is found to be stale (its epoch is behind the current epoch, or `completeRollback` marked it stale), the plugin is expected to:

1. Record the checkpoint with `status: "recomputing"` to signal that work is in progress.
2. Re-read events under the current epoch.
3. Re-derive the artifact.
4. Record a new checkpoint with `status: "fresh"` and the updated `last_seq` high-watermark.

Plugins must not serve `fresh` lifecycle decisions from a stale checkpoint. If recomputation is in progress, any decisions derived from that checkpoint should be treated as `recomputing`, not `fresh`.

---

## Structured Agent Message Contract

Lifecycle plugins communicate with agents using a structured message type defined in `packages/bridge-contracts/src/messages.ts`, not freeform prose. The contract is shared across all lifecycle modules (origin, seal, portage, torch) and the conflict plugin.

### AgentMessage fields

```ts
type AgentMessage = {
  message_id: string           // unique identifier for this message (e.g. UUID or deterministic hash)
  severity: "info" | "warn" | "block"
  violated_rule: string        // stable namespaced rule ID, e.g. "origin.no-direct-generated-edit"
  affected_object: string      // identity of the object affected (file path, API path, migration ID, etc.)
  canonical_source?: string    // vendor-native source for the affected object (schema, IDL, OpenAPI spec)
  remediation: AgentRemediation
  source_plugin: string        // plugin that produced this message, e.g. "origin", "seal"
  source_module?: string       // specific module path within the plugin
  no_reply?: boolean           // true if the message is terminal; no follow-up expected
  correlation_id?: string      // links this message to the originating event spine context
}

type AgentRemediation = {
  summary: string              // required: human-readable action summary
  source_paths?: string[]      // canonical source file paths relevant to the remediation
  commands?: string[]          // shell commands that effect the remediation
  refs?: string[]              // additional reference links or artifact IDs
}
```

### Severity invariant

`warn` and `block` messages **must** include a non-empty `remediation.summary`. This is enforced at the schema level via a Zod `superRefine` — parse will fail if the field is absent or blank.

`info` messages are advisory only; however, every message of any severity still **requires** a `remediation` object with a non-empty `summary` field (the base schema makes `remediation` required and `summary` is `string.min(1)` in `AgentRemediation`). The `superRefine` additionally guards against whitespace-only summaries for `warn` and `block`.

### Message authoring rules

- **Factual**: state what was found and from what source. Do not editorialize.
- **Actionable**: every `block`-severity message must include a `remediation` with at least a `summary`.
- **Blame-free**: messages are directed at the code change, not the author.
- **Bounded**: no secrets, no environment variables with credential-shaped values, no raw multi-kilobyte outputs in any field.
- **Source-attributed**: `canonical_source` should name the vendor-native truth consulted (e.g., `prisma/schema.prisma`, `specs/openapi.yaml`). Do not invent parallel authoritative sources.

### Example: origin block

```
Blocked: src/generated/api/client.ts is generated by openapi-generator.

Source:   specs/openapi.yaml
Regen:    bun run generate:api

Edit the source schema instead of this generated file.
Changes here will be overwritten on next generation.
```

Rendered from:
- `severity: "block"`
- `violated_rule: "origin.no-direct-generated-edit"`
- `canonical_source: "specs/openapi.yaml"`
- `remediation.commands: ["bun run generate:api"]`

---

## Current Limitations (Wave 0)

The following are known limitations of the Wave 0 event spine and message contracts. They are not bugs; they are intentional scope restrictions for this wave.

### Local-first only

The spine is a single-file SQLite database scoped to one repo checkout. There is no replication, remote sync, federation, or cross-workspace shared truth in Wave 0. CI and developer workstations operate on independent spine instances.

### No distributed coordination

Multiple concurrent writers are serialized by SQLite's WAL mode with a 5-second busy timeout. This is sufficient for typical local agent use but is not designed for high-concurrency write throughput.

### Rollback invalidation is epoch + snapshot-boundary only

`completeRollback` invalidates events in the rolled-back epoch with `seq` greater than the target snapshot's last `seq` (or all events in the epoch if no snapshot match is found). There is no mechanism to selectively preserve arbitrary events from a reverted epoch while invalidating others. Fine-grained per-event invalidation is deferred to a future wave.

### No runtime hard-coupling between plugins

Plugin checkpoints and freshness queries are advisory in Wave 0. There is no enforcement that a plugin must re-check freshness before emitting a decision. Plugin authors are responsible for implementing recomputation correctly when their checkpoint is stale.

### No hash-chain verification

The `payload_hash` field exists and emitters should populate it, but the spine does not verify hash-chain continuity at insert time and provides no hash-chain audit query in Wave 0. Hash verification is deferred to a future wave.

### No cross-repo identity

`workspace_id` is a local opaque identifier. There is no global registry of workspace IDs and no way to correlate events from two checkouts of the same repo.
