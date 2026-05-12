/**
 * `spine_query` — read events from the SQLite event spine at
 * `.opencode/spine/events.sqlite`.
 *
 * The spine is written by `lifecycle_concord_ingest` and any other future
 * Conductor flow that needs a durable, ordered, workspace-scoped event log.
 * Until this tool existed, the spine was write-only from the orchestrator's
 * perspective. Now orchestrators (and any user investigating Concord/fleet
 * correlation drift) can read events filtered by plugin, kind, correlation_id,
 * lifecycle_object_id, and time/sequence ranges.
 *
 * Read-only. Returns at most `limit` events (default 50, max 500) sorted by
 * seq ascending — the spine's natural causal order.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

import { pathExists } from "../util/path-exists";
import { createSpineStore } from "../../packages/spine/src/index.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function spinePath(directory: string, override?: string): string {
  return override ?? path.join(directory, ".opencode", "spine", "events.sqlite");
}

function workspaceId(directory: string): string {
  return `ws_${createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)}`;
}

export const spineQuery = tool({
  description:
    "Read events from the Conductor spine SQLite log (`.opencode/spine/events.sqlite`). Returns events sorted by seq ascending (causal order). Supports filtering by plugin, kind, correlation_id, lifecycle_object_id, session_id, and sinceSeq / sinceTsMs. Read-only — never modifies the spine. Returns `{ available: false }` when the spine has not been initialized yet (no `lifecycle_concord_ingest` calls have run).",
  args: {
    plugin: tool.schema
      .string()
      .optional()
      .describe("Filter to events from a specific plugin (e.g. 'concord', 'conductor')."),
    kind: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to events of a specific kind (e.g. 'concord.collision.detected', 'spine.rollback.started').",
      ),
    correlation_id: tool.schema
      .string()
      .optional()
      .describe("Filter to events sharing a correlation_id."),
    lifecycle_object_id: tool.schema
      .string()
      .optional()
      .describe("Filter to events for a specific lifecycle_object_id."),
    session_id: tool.schema.string().optional().describe("Filter to events from a session_id."),
    since_seq: tool.schema
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Return only events with seq > since_seq. Use for incremental polling."),
    since_ts_ms: tool.schema
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Return only events with ts >= since_ts_ms (epoch milliseconds)."),
    include_stale: tool.schema
      .boolean()
      .optional()
      .describe(
        "Include events from rolled-back epochs. Default false (fresh-only — only events from the current epoch).",
      ),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum events to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
    spine_db: tool.schema
      .string()
      .optional()
      .describe(
        "Override spine SQLite path. Defaults to .opencode/spine/events.sqlite under the workspace root.",
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const db = spinePath(cwd, args.spine_db);

    if (!(await pathExists(db))) {
      return JSON.stringify(
        {
          available: false,
          reason: `spine database not initialized at ${path.relative(cwd, db)} — no lifecycle_concord_ingest calls have run yet`,
        },
        null,
        2,
      );
    }

    const limit = Math.min(
      Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );

    const store = createSpineStore({
      databasePath: db,
      workspaceId: workspaceId(cwd),
      workspaceRoot: cwd,
    });

    try {
      const events = store.listEvents({
        freshness: args.include_stale ? "include_stale" : "fresh_only",
        sinceSeq: args.since_seq,
      });

      const filtered = events.filter((e) => {
        if (args.plugin !== undefined && e.plugin !== args.plugin) return false;
        if (args.kind !== undefined && e.kind !== args.kind) return false;
        if (args.correlation_id !== undefined && e.correlation_id !== args.correlation_id) {
          return false;
        }
        if (
          args.lifecycle_object_id !== undefined &&
          e.lifecycle_object_id !== args.lifecycle_object_id
        ) {
          return false;
        }
        if (args.session_id !== undefined && e.session_id !== args.session_id) return false;
        if (args.since_ts_ms !== undefined && e.ts < args.since_ts_ms) return false;
        return true;
      });

      const shown = filtered.slice(0, limit);

      return JSON.stringify(
        {
          available: true,
          total: filtered.length,
          shown: shown.length,
          limit,
          current_epoch: store.getCurrentEpoch(),
          events: shown,
        },
        null,
        2,
      );
    } finally {
      store.close();
    }
  },
});
