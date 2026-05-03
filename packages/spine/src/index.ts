import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type {
  AppendEventInput,
  FreshQueryResult,
  Freshness,
  PluginEvent,
} from "../../bridge-contracts/src/index";
import { appendEventInputSchema, pluginEventSchema } from "../../bridge-contracts/src/index";

export type ListEventsOptions = {
  freshness?: "fresh_only" | "include_stale";
  sinceSeq?: number;
};

export type RollbackContext = Pick<AppendEventInput, "session_id" | "correlation_id" | "actor_id"> &
  Partial<Pick<AppendEventInput, "parent_seq" | "tool_call_id">>;

export type RollbackArgs = {
  targetSnapshotId: string;
  reason: string;
  context: RollbackContext;
};

export type CheckpointStatus = Freshness | "error";

export type RecordCheckpointInput = {
  plugin: string;
  consumer_id: string;
  last_seq: number;
  workspace_id?: string;
  epoch_id?: number;
  status?: CheckpointStatus;
  error_message?: string;
};

export type GetCheckpointInput = {
  plugin: string;
  consumer_id: string;
  workspace_id?: string;
};

export type PluginCheckpoint = {
  plugin: string;
  consumer_id: string;
  workspace_id: string;
  epoch_id: number;
  last_seq: number;
  status: CheckpointStatus;
  updated_at: number;
  error_message?: string;
};

export type SpineStoreOptions = {
  databasePath: string;
  workspaceId: string;
  workspaceRoot: string;
};

export type SpineStore = {
  appendEvent(input: AppendEventInput): PluginEvent;
  listEvents(options?: ListEventsOptions): PluginEvent[];
  startRollback(args: RollbackArgs): PluginEvent;
  completeRollback(args: RollbackArgs): PluginEvent;
  getCurrentEpoch(): number;
  recordCheckpoint(input: RecordCheckpointInput): PluginCheckpoint;
  getCheckpoint(input: GetCheckpointInput): PluginCheckpoint | undefined;
  getCheckpointFreshness(input: GetCheckpointInput): FreshQueryResult;
  close(): void;
};

const sqliteNumberSchema = z.union([z.number(), z.bigint().transform((value) => Number(value))]);

const eventRowSchema = z.object({
  seq: sqliteNumberSchema,
  session_id: z.string(),
  correlation_id: z.string(),
  actor_id: z.string(),
  workspace_id: z.string(),
  workspace_root: z.string(),
  parent_seq: sqliteNumberSchema.nullable(),
  epoch_id: sqliteNumberSchema,
  snapshot_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  plugin: z.string(),
  kind: z.string(),
  ts: sqliteNumberSchema,
  payload_hash: z.string(),
});

const epochRowSchema = z.object({
  epoch_id: sqliteNumberSchema,
});

const checkpointStatusSchema = z.enum(["fresh", "stale", "recomputing", "unavailable", "error"]);

const checkpointRowSchema = z.object({
  plugin: z.string(),
  consumer_id: z.string(),
  workspace_id: z.string(),
  epoch_id: sqliteNumberSchema,
  last_seq: sqliteNumberSchema,
  status: checkpointStatusSchema,
  updated_at: sqliteNumberSchema,
  error_message: z.string().nullable(),
});

const seqRowSchema = z.object({
  seq: sqliteNumberSchema,
});

const optionalSeqRowSchema = z.object({
  seq: sqliteNumberSchema.nullable(),
});

const rollbackStartedKind = "spine.rollback.started";
const rollbackCompletedKind = "spine.rollback.completed";
type RollbackEventKind = typeof rollbackStartedKind | typeof rollbackCompletedKind;

export function createSpineStore(options: SpineStoreOptions): SpineStore {
  const database = new Database(options.databasePath, { create: true });
  initializeDatabase(database);

  const store: SpineStore = {
    appendEvent(input) {
      const event = appendEventInputSchema.parse(input);
      ensureWorkspace(event, options);
      const currentEpoch = store.getCurrentEpoch();
      if (event.epoch_id !== currentEpoch) {
        throw new Error(
          `append epoch ${event.epoch_id} does not match current epoch ${currentEpoch}`,
        );
      }

      database
        .query(
          `INSERT INTO events (
            session_id,
            correlation_id,
            actor_id,
            workspace_id,
            workspace_root,
            parent_seq,
            epoch_id,
            snapshot_id,
            tool_call_id,
            plugin,
            kind,
            ts,
            payload_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.session_id,
          event.correlation_id,
          event.actor_id,
          event.workspace_id,
          event.workspace_root,
          event.parent_seq ?? null,
          event.epoch_id,
          event.snapshot_id ?? null,
          event.tool_call_id ?? null,
          event.plugin,
          event.kind,
          event.ts,
          event.payload_hash,
        );

      const row = seqRowSchema.parse(database.query("SELECT last_insert_rowid() AS seq").get());
      return getEventBySeq(database, row.seq);
    },

    listEvents(readOptions = {}) {
      const freshness = readOptions.freshness ?? "fresh_only";
      const sinceSeq = readOptions.sinceSeq ?? 0;

      if (freshness === "include_stale") {
        return database
          .query(
            `SELECT seq, session_id, correlation_id, actor_id, workspace_id, workspace_root,
              parent_seq, epoch_id, snapshot_id, tool_call_id, plugin, kind, ts, payload_hash
             FROM events
             WHERE seq > ?
             ORDER BY seq ASC`,
          )
          .all(sinceSeq)
          .map((row) => rowToPluginEvent(eventRowSchema.parse(row)));
      }

      const currentEpoch = store.getCurrentEpoch();
      return database
        .query(
          `SELECT seq, session_id, correlation_id, actor_id, workspace_id, workspace_root,
            parent_seq, epoch_id, snapshot_id, tool_call_id, plugin, kind, ts, payload_hash
           FROM events
           WHERE seq > ?
             AND epoch_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM event_invalidations WHERE event_invalidations.event_seq = events.seq
             )
           ORDER BY seq ASC`,
        )
        .all(sinceSeq, currentEpoch)
        .map((row) => rowToPluginEvent(eventRowSchema.parse(row)));
    },

    startRollback(args) {
      return appendRollbackEvent(store, options, args, rollbackStartedKind);
    },

    completeRollback(args) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const previousEpoch = store.getCurrentEpoch();
        const targetSeq = findTargetSeq(database, previousEpoch, args.targetSnapshotId);
        const invalidatedEventSeqs = listInvalidatedEventSeqs(database, previousEpoch, targetSeq);
        const completion = appendRollbackEvent(store, options, args, rollbackCompletedKind);
        const nextEpoch = previousEpoch + 1;
        const now = Date.now();

        database
          .query(
            `INSERT INTO epochs (epoch_id, status, started_at, target_snapshot_id, reason)
             VALUES (?, 'active', ?, ?, ?)`,
          )
          .run(nextEpoch, now, args.targetSnapshotId, args.reason);
        database.query("UPDATE epochs SET status = 'closed' WHERE epoch_id = ?").run(previousEpoch);
        database.query("UPDATE current_epoch SET epoch_id = ? WHERE id = 1").run(nextEpoch);

        for (const seq of invalidatedEventSeqs) {
          database
            .query(
              `INSERT OR IGNORE INTO event_invalidations (
                event_seq,
                invalidated_by_seq,
                from_epoch_id,
                to_epoch_id,
                target_snapshot_id,
                reason,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              seq,
              completion.seq,
              previousEpoch,
              nextEpoch,
              args.targetSnapshotId,
              args.reason,
              now,
            );
        }

        markStaleCheckpoints(database, options.workspaceId, previousEpoch, now);
        database.exec("COMMIT");
        return completion;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    getCurrentEpoch() {
      const row = epochRowSchema.parse(
        database.query("SELECT epoch_id FROM current_epoch WHERE id = 1").get(),
      );
      return row.epoch_id;
    },

    recordCheckpoint(input) {
      const checkpoint = checkpointInputSchema(options, store.getCurrentEpoch()).parse(input);
      const now = Date.now();
      database
        .query(
          `INSERT INTO plugin_checkpoints (
            plugin,
            consumer_id,
            workspace_id,
            epoch_id,
            last_seq,
            status,
            updated_at,
            error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(plugin, consumer_id, workspace_id) DO UPDATE SET
            epoch_id = excluded.epoch_id,
            last_seq = excluded.last_seq,
            status = excluded.status,
            updated_at = excluded.updated_at,
            error_message = excluded.error_message`,
        )
        .run(
          checkpoint.plugin,
          checkpoint.consumer_id,
          checkpoint.workspace_id,
          checkpoint.epoch_id,
          checkpoint.last_seq,
          checkpoint.status,
          now,
          checkpoint.error_message ?? null,
        );

      return getCheckpointRecord(
        database,
        checkpoint.plugin,
        checkpoint.consumer_id,
        checkpoint.workspace_id,
      );
    },

    getCheckpoint(input) {
      const workspaceId = input.workspace_id ?? options.workspaceId;
      return getCheckpointRecordOrUndefined(database, input.plugin, input.consumer_id, workspaceId);
    },

    getCheckpointFreshness(input) {
      const checkpoint = store.getCheckpoint(input);
      if (checkpoint === undefined) {
        return { status: "unavailable" };
      }

      const currentEpoch = store.getCurrentEpoch();
      if (checkpoint.epoch_id !== currentEpoch || checkpoint.status === "stale") {
        return {
          status: "stale",
          data: checkpoint,
          as_of_seq: checkpoint.last_seq,
          epoch_id: checkpoint.epoch_id,
          current_epoch_id: currentEpoch,
        };
      }

      if (checkpoint.status === "fresh") {
        return {
          status: "fresh",
          data: checkpoint,
          as_of_seq: checkpoint.last_seq,
          epoch_id: checkpoint.epoch_id,
        };
      }

      if (checkpoint.status === "recomputing") {
        return {
          status: "recomputing",
          data: checkpoint,
          as_of_seq: checkpoint.last_seq,
          epoch_id: checkpoint.epoch_id,
        };
      }

      return {
        status: "unavailable",
        as_of_seq: checkpoint.last_seq,
        epoch_id: checkpoint.epoch_id,
      };
    },

    close() {
      database.close();
    },
  };

  return store;
}

function initializeDatabase(database: Database) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS epochs (
      epoch_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
      started_at INTEGER NOT NULL,
      target_snapshot_id TEXT,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS current_epoch (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch_id INTEGER NOT NULL REFERENCES epochs(epoch_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      parent_seq INTEGER REFERENCES events(seq),
      epoch_id INTEGER NOT NULL REFERENCES epochs(epoch_id),
      snapshot_id TEXT,
      tool_call_id TEXT,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts INTEGER NOT NULL,
      payload_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_invalidations (
      event_seq INTEGER NOT NULL REFERENCES events(seq),
      invalidated_by_seq INTEGER NOT NULL REFERENCES events(seq),
      from_epoch_id INTEGER NOT NULL REFERENCES epochs(epoch_id),
      to_epoch_id INTEGER NOT NULL REFERENCES epochs(epoch_id),
      target_snapshot_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (event_seq, invalidated_by_seq)
    );

    CREATE TABLE IF NOT EXISTS plugin_checkpoints (
      plugin TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      epoch_id INTEGER NOT NULL REFERENCES epochs(epoch_id),
      last_seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'recomputing', 'unavailable', 'error')),
      updated_at INTEGER NOT NULL,
      error_message TEXT,
      PRIMARY KEY (plugin, consumer_id, workspace_id)
    );

    INSERT OR IGNORE INTO epochs (epoch_id, status, started_at)
    VALUES (0, 'active', unixepoch('subsec') * 1000);

    INSERT OR IGNORE INTO current_epoch (id, epoch_id)
    VALUES (1, 0);
  `);
}

function ensureWorkspace(event: AppendEventInput, options: SpineStoreOptions) {
  if (event.workspace_id !== options.workspaceId) {
    throw new Error(
      `event workspace ${event.workspace_id} does not match store workspace ${options.workspaceId}`,
    );
  }

  if (event.workspace_root !== options.workspaceRoot) {
    throw new Error(
      `event workspace root ${event.workspace_root} does not match store root ${options.workspaceRoot}`,
    );
  }
}

function getEventBySeq(database: Database, seq: number): PluginEvent {
  const row = database
    .query(
      `SELECT seq, session_id, correlation_id, actor_id, workspace_id, workspace_root,
        parent_seq, epoch_id, snapshot_id, tool_call_id, plugin, kind, ts, payload_hash
       FROM events
       WHERE seq = ?`,
    )
    .get(seq);

  if (row === null) {
    throw new Error(`spine event ${seq} was not found after append`);
  }

  return rowToPluginEvent(eventRowSchema.parse(row));
}

function rowToPluginEvent(row: z.infer<typeof eventRowSchema>): PluginEvent {
  return pluginEventSchema.parse({
    seq: row.seq,
    session_id: row.session_id,
    correlation_id: row.correlation_id,
    actor_id: row.actor_id,
    workspace_id: row.workspace_id,
    workspace_root: row.workspace_root,
    epoch_id: row.epoch_id,
    plugin: row.plugin,
    kind: row.kind,
    ts: row.ts,
    payload_hash: row.payload_hash,
    ...(row.parent_seq === null ? {} : { parent_seq: row.parent_seq }),
    ...(row.snapshot_id === null ? {} : { snapshot_id: row.snapshot_id }),
    ...(row.tool_call_id === null ? {} : { tool_call_id: row.tool_call_id }),
  });
}

function appendRollbackEvent(
  store: SpineStore,
  options: SpineStoreOptions,
  args: RollbackArgs,
  kind: RollbackEventKind,
): PluginEvent {
  return store.appendEvent(
    appendEventInputSchema.parse({
      actor_id: args.context.actor_id,
      correlation_id: args.context.correlation_id,
      epoch_id: store.getCurrentEpoch(),
      kind,
      plugin: "core",
      payload_hash: payloadHash({
        kind,
        targetSnapshotId: args.targetSnapshotId,
        reason: args.reason,
      }),
      session_id: args.context.session_id,
      snapshot_id: args.targetSnapshotId,
      ts: Date.now(),
      workspace_id: options.workspaceId,
      workspace_root: options.workspaceRoot,
      ...(args.context.parent_seq === undefined ? {} : { parent_seq: args.context.parent_seq }),
      ...(args.context.tool_call_id === undefined
        ? {}
        : { tool_call_id: args.context.tool_call_id }),
    }),
  );
}

function payloadHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function findTargetSeq(
  database: Database,
  epochId: number,
  targetSnapshotId: string,
): number | undefined {
  const row = optionalSeqRowSchema.parse(
    database
      .query(
        `SELECT MAX(seq) AS seq
         FROM events
         WHERE epoch_id = ?
           AND snapshot_id = ?
           AND kind NOT IN (?, ?)`,
      )
      .get(epochId, targetSnapshotId, rollbackStartedKind, rollbackCompletedKind),
  );

  if (row.seq === null) {
    return undefined;
  }

  return row.seq;
}

function listInvalidatedEventSeqs(
  database: Database,
  epochId: number,
  targetSeq: number | undefined,
): number[] {
  if (targetSeq === undefined) {
    return database
      .query(
        `SELECT seq FROM events
         WHERE epoch_id = ?
           AND kind NOT IN (?, ?)
         ORDER BY seq ASC`,
      )
      .all(epochId, rollbackStartedKind, rollbackCompletedKind)
      .map((row) => seqRowSchema.parse(row).seq);
  }

  return database
    .query(
      `SELECT seq FROM events
       WHERE epoch_id = ?
         AND seq > ?
         AND kind NOT IN (?, ?)
       ORDER BY seq ASC`,
    )
    .all(epochId, targetSeq, rollbackStartedKind, rollbackCompletedKind)
    .map((row) => seqRowSchema.parse(row).seq);
}

function markStaleCheckpoints(
  database: Database,
  workspaceId: string,
  epochId: number,
  updatedAt: number,
) {
  database
    .query(
      `UPDATE plugin_checkpoints
       SET status = 'stale', updated_at = ?
       WHERE workspace_id = ? AND epoch_id = ? AND status = 'fresh'`,
    )
    .run(updatedAt, workspaceId, epochId);
}

function checkpointInputSchema(options: SpineStoreOptions, currentEpoch: number) {
  return z.object({
    plugin: z.string().min(1),
    consumer_id: z.string().min(1),
    workspace_id: z.string().min(1).default(options.workspaceId),
    epoch_id: z.number().int().nonnegative().default(currentEpoch),
    last_seq: z.number().int().nonnegative(),
    status: checkpointStatusSchema.default("fresh"),
    error_message: z.string().optional(),
  });
}

function getCheckpointRecord(
  database: Database,
  plugin: string,
  consumerId: string,
  workspaceId: string,
): PluginCheckpoint {
  const checkpoint = getCheckpointRecordOrUndefined(database, plugin, consumerId, workspaceId);
  if (checkpoint === undefined) {
    throw new Error(`checkpoint ${plugin}/${consumerId}/${workspaceId} was not found after write`);
  }

  return checkpoint;
}

function getCheckpointRecordOrUndefined(
  database: Database,
  plugin: string,
  consumerId: string,
  workspaceId: string,
): PluginCheckpoint | undefined {
  const row = database
    .query(
      `SELECT plugin, consumer_id, workspace_id, epoch_id, last_seq, status, updated_at, error_message
       FROM plugin_checkpoints
       WHERE plugin = ? AND consumer_id = ? AND workspace_id = ?`,
    )
    .get(plugin, consumerId, workspaceId);

  if (row === null) {
    return undefined;
  }

  const checkpoint = checkpointRowSchema.parse(row);
  return {
    plugin: checkpoint.plugin,
    consumer_id: checkpoint.consumer_id,
    workspace_id: checkpoint.workspace_id,
    epoch_id: checkpoint.epoch_id,
    last_seq: checkpoint.last_seq,
    status: checkpoint.status,
    updated_at: checkpoint.updated_at,
    ...(checkpoint.error_message === null ? {} : { error_message: checkpoint.error_message }),
  };
}
