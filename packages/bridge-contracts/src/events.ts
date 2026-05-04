/**
 * packages/bridge-contracts/src/events.ts
 *
 * Shared event envelope and freshness contracts for the lifecycle-integrity
 * event spine. All event rows stored in SQLite carry a DB-assigned `seq`
 * that callers MUST NOT provide when appending. `AppendEventInput` enforces
 * this by using `.strict()` — any caller-supplied `seq` field will cause a
 * parse error rather than being silently stripped.
 *
 * Event kind: regex-based string supporting namespaced plugin events like
 * `origin.scan.completed` and core events like `tool.before`.
 *
 * Freshness semantics:
 *   fresh        — authoritative, current epoch, ready to gate decisions
 *   stale        — from a prior epoch or rolled-back epoch; requires explicit opt-in
 *   recomputing  — computation in progress; gate decisions should await or treat as stale
 *   unavailable  — no data found for the query scope
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Event kind — flexible regex so plugins can register namespaced event kinds
// like `origin.scan.completed` without requiring this package to enumerate them.
// Core events use a single dotted-path pattern: `<segment>.<segment>...`
// ---------------------------------------------------------------------------

export const eventKindSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)*$/,
    "Event kind must be a dot-separated lowercase path, e.g. 'tool.before' or 'origin.scan.completed'",
  );

export type EventKind = z.infer<typeof eventKindSchema>;

// ---------------------------------------------------------------------------
// AppendEventInput — what a caller provides when emitting a new event.
// `seq` is intentionally absent: it is DB-assigned only.
// `.strict()` means any extra key (including a caller-supplied `seq`) is
// a parse error, preventing accidental DB-identity spoofing.
// ---------------------------------------------------------------------------

export const appendEventInputSchema = z
  .object({
    /** Session identifier grouping a set of related tool invocations. */
    session_id: z.string().min(1),

    /** Correlation token linking causally-related events across sessions. */
    correlation_id: z.string().min(1),

    /** Identity of the actor that emitted the event (agent ID, user ID, etc.). */
    actor_id: z.string().min(1),

    /** Identifier of the workspace/repo context at emit time. */
    workspace_id: z.string().min(1),

    /** Absolute filesystem path to the workspace root. */
    workspace_root: z.string().min(1),

    /**
     * Optional reference to the parent spine event for causal chaining.
     * DB-assigned `seq` of the parent row, not caller-provided `seq`.
     */
    parent_seq: z.number().int().nonnegative().optional(),

    /**
     * Epoch identifier for freshness-aware reads.
     * A monotonically-increasing logical clock managed by the spine.
     * Callers must supply the current epoch at emit time.
     */
    epoch_id: z.number().int().nonnegative(),

    /**
     * Content-addressed snapshot reference (e.g. `sha256:<hex>`) for
     * events that carry or refer to artifact snapshots.
     */
    snapshot_id: z.string().optional(),

    /**
     * Tool call identifier when the event is produced inside a tool invocation.
     */
    tool_call_id: z.string().optional(),

    /**
     * Optional canonical lifecycle object identity associated with this event.
     */
    lifecycle_object_id: z.string().min(1).optional(),

    /**
     * Plugin or module that produced this event, e.g. `origin`, `seal`, `portage`.
     * Core spine events use `core`.
     */
    plugin: z.string().min(1),

    /** Namespaced dot-path event kind, e.g. `tool.before`, `origin.scan.completed`. */
    kind: eventKindSchema,

    /**
     * Unix timestamp in milliseconds at emit time.
     * The spine may also record a server-side timestamp for auditing.
     */
    ts: z.number().int().nonnegative(),

    /**
     * Content hash of the event payload (e.g. `sha256:<hex>`).
     * Callers compute and supply this; the spine stores it verbatim.
     * Hashing implementation is NOT provided here.
     */
    payload_hash: z.string().min(1),
  })
  .strict();

export type AppendEventInput = z.infer<typeof appendEventInputSchema>;

// ---------------------------------------------------------------------------
// PluginEvent — a fully-materialized event row as returned by the spine.
// Extends AppendEventInput with the DB-assigned `seq`.
// `.strict()` carries forward so deserialized rows with extra columns fail
// loudly rather than silently widening the type.
// ---------------------------------------------------------------------------

export const pluginEventSchema = appendEventInputSchema
  .extend({
    /**
     * DB-assigned monotonically-increasing sequence number.
     * Uniquely identifies a row in the event log.
     * Must NOT be provided by callers on append.
     */
    seq: z.number().int().positive(),
  })
  .strict();

export type PluginEvent = z.infer<typeof pluginEventSchema>;

// ---------------------------------------------------------------------------
// Freshness — current status of a query result relative to the spine epoch.
// ---------------------------------------------------------------------------

export const freshnessSchema = z.enum(["fresh", "stale", "recomputing", "unavailable"]);

export type Freshness = z.infer<typeof freshnessSchema>;

// ---------------------------------------------------------------------------
// FreshQueryResult — wrapper returned by freshness-aware spine reads.
// When status is `fresh`, `data` is present; otherwise `data` is absent and
// `as_of_seq`/`epoch_id` describe the last known data point.
// ---------------------------------------------------------------------------

export const freshQueryResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("fresh"),
    /** The query result payload, valid for the current epoch. */
    data: z.unknown(),
    /** Spine seq of the most recent event contributing to this result. */
    as_of_seq: z.number().int().nonnegative(),
    /** Epoch this result belongs to. */
    epoch_id: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("stale"),
    /** Stale data from a prior epoch (only present when caller opts into stale reads). */
    data: z.unknown().optional(),
    as_of_seq: z.number().int().nonnegative(),
    epoch_id: z.number().int().nonnegative(),
    /** The current epoch at query time; stale result's epoch_id is older. */
    current_epoch_id: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("recomputing"),
    /** Stale data may be provided as a hint during recomputation. */
    data: z.unknown().optional(),
    as_of_seq: z.number().int().nonnegative(),
    epoch_id: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("unavailable"),
    /** No data is available; data field is absent. */
    as_of_seq: z.number().int().nonnegative().optional(),
    epoch_id: z.number().int().nonnegative().optional(),
  }),
]);

export type FreshQueryResult = z.infer<typeof freshQueryResultSchema>;
