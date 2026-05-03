import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AppendEventInput } from "../../bridge-contracts/src/index";
import { appendEventInputSchema } from "../../bridge-contracts/src/index";
import { createSpineStore } from "./index";

const workspaceId = "workspace-test";
const workspaceRoot = "/tmp/workspace-test";

const invalidationRowSchema = z.object({
  event_seq: z.union([z.number(), z.bigint().transform((value) => Number(value))]),
});

describe("spine store", () => {
  test("appending two events assigns seq 1 then 2", () => {
    const store = createTestStore();

    const first = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), { payload_hash: "sha256:first" }),
    );
    const second = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), { payload_hash: "sha256:second" }),
    );

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    store.close();
  });

  test("appended events include workspace, session, correlation, actor, and epoch metadata", () => {
    const store = createTestStore();

    const event = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        actor_id: "agent-lifecycle",
        correlation_id: "corr-lifecycle",
        session_id: "session-lifecycle",
        snapshot_id: "snapshot:lifecycle",
      }),
    );

    expect(event.workspace_id).toBe(workspaceId);
    expect(event.workspace_root).toBe(workspaceRoot);
    expect(event.session_id).toBe("session-lifecycle");
    expect(event.correlation_id).toBe("corr-lifecycle");
    expect(event.actor_id).toBe("agent-lifecycle");
    expect(event.epoch_id).toBe(0);
    expect(event.snapshot_id).toBe("snapshot:lifecycle");

    store.close();
  });

  test("default list returns fresh current-epoch events", () => {
    const store = createTestStore();
    const first = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), { payload_hash: "sha256:first" }),
    );
    const second = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), { payload_hash: "sha256:second" }),
    );

    expect(store.listEvents()).toEqual([first, second]);
    expect(store.listEvents({ sinceSeq: 1 })).toEqual([second]);

    store.close();
  });

  test("completing rollback creates a new epoch and hides invalidated old events from default reads", () => {
    const store = createTestStore();
    const target = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:target",
        snapshot_id: "snapshot:target",
      }),
    );
    const reverted = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:reverted",
        snapshot_id: "snapshot:reverted",
      }),
    );

    const rollback = store.completeRollback({
      targetSnapshotId: "snapshot:target",
      reason: "restore test snapshot",
      context: makeContext(),
    });

    expect(rollback.kind).toBe("spine.rollback.completed");
    expect(store.getCurrentEpoch()).toBe(1);
    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ freshness: "include_stale" })).toEqual([target, reverted, rollback]);

    store.close();
  });

  test("rollback invalidates reverted events but not the target snapshot event", () => {
    const databasePath = makeDatabasePath();
    const store = createTestStoreAtPath(databasePath);
    const target = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:target",
        snapshot_id: "snapshot:target",
      }),
    );
    const reverted = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:reverted",
        snapshot_id: "snapshot:reverted",
      }),
    );

    const rollback = store.completeRollback({
      targetSnapshotId: "snapshot:target",
      reason: "restore test snapshot",
      context: makeContext(),
    });
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const invalidatedSeqs = database
      .query("SELECT event_seq FROM event_invalidations ORDER BY event_seq ASC")
      .all()
      .map((row) => invalidationRowSchema.parse(row).event_seq);
    database.close();

    expect(invalidatedSeqs).toContain(reverted.seq);
    expect(invalidatedSeqs).not.toContain(target.seq);
    expect(invalidatedSeqs).not.toContain(rollback.seq);
  });

  test("rollback receipts do not become targets or invalidated events", () => {
    const databasePath = makeDatabasePath();
    const store = createTestStoreAtPath(databasePath);
    const target = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:target",
        snapshot_id: "snapshot:target",
      }),
    );
    const reverted = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:reverted",
        snapshot_id: "snapshot:reverted",
      }),
    );

    const started = store.startRollback({
      targetSnapshotId: "snapshot:target",
      reason: "restore test snapshot",
      context: makeContext(),
    });
    const completed = store.completeRollback({
      targetSnapshotId: "snapshot:target",
      reason: "restore test snapshot",
      context: makeContext(),
    });
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const invalidatedSeqs = database
      .query("SELECT event_seq FROM event_invalidations ORDER BY event_seq ASC")
      .all()
      .map((row) => invalidationRowSchema.parse(row).event_seq);
    database.close();

    expect(invalidatedSeqs).toEqual([reverted.seq]);
    expect(invalidatedSeqs).not.toContain(target.seq);
    expect(invalidatedSeqs).not.toContain(started.seq);
    expect(invalidatedSeqs).not.toContain(completed.seq);
  });

  test("a fresh plugin checkpoint becomes stale after rollback", () => {
    const store = createTestStore();
    store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:target",
        snapshot_id: "snapshot:target",
      }),
    );
    const latest = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:latest",
        snapshot_id: "snapshot:latest",
      }),
    );

    store.recordCheckpoint({
      plugin: "origin",
      consumer_id: "origin-scanner",
      last_seq: latest.seq,
      status: "fresh",
    });
    expect(store.getCheckpoint({ plugin: "origin", consumer_id: "origin-scanner" })?.status).toBe(
      "fresh",
    );

    store.completeRollback({
      targetSnapshotId: "snapshot:target",
      reason: "checkpoint must recompute",
      context: makeContext(),
    });

    expect(store.getCheckpoint({ plugin: "origin", consumer_id: "origin-scanner" })?.status).toBe(
      "stale",
    );

    store.close();
  });

  test("checkpoint freshness reports missing checkpoints as unavailable", () => {
    const store = createTestStore();

    const freshness = store.getCheckpointFreshness({
      plugin: "origin",
      consumer_id: "origin-scanner",
    });

    expect(freshness.status).toBe("unavailable");

    store.close();
  });

  test("checkpoint freshness preserves current recomputing checkpoints", () => {
    const store = createTestStore();
    const event = store.appendEvent(makeEventInput(store.getCurrentEpoch()));
    store.recordCheckpoint({
      plugin: "origin",
      consumer_id: "origin-scanner",
      last_seq: event.seq,
      status: "recomputing",
    });

    const freshness = store.getCheckpointFreshness({
      plugin: "origin",
      consumer_id: "origin-scanner",
    });

    expect(freshness.status).toBe("recomputing");
    if (freshness.status !== "recomputing") {
      throw new Error(`expected recomputing checkpoint freshness, got ${freshness.status}`);
    }
    expect(freshness.data).toEqual(
      store.getCheckpoint({ plugin: "origin", consumer_id: "origin-scanner" }),
    );
    expect(freshness.as_of_seq).toBe(event.seq);
    expect(freshness.epoch_id).toBe(store.getCurrentEpoch());

    store.close();
  });

  test("checkpoint freshness preserves current unavailable checkpoints", () => {
    const store = createTestStore();
    const event = store.appendEvent(makeEventInput(store.getCurrentEpoch()));
    store.recordCheckpoint({
      plugin: "origin",
      consumer_id: "origin-scanner",
      last_seq: event.seq,
      status: "unavailable",
    });

    const freshness = store.getCheckpointFreshness({
      plugin: "origin",
      consumer_id: "origin-scanner",
    });

    expect(freshness.status).toBe("unavailable");
    if (freshness.status !== "unavailable") {
      throw new Error(`expected unavailable checkpoint freshness, got ${freshness.status}`);
    }
    expect("data" in freshness).toBe(false);
    expect(freshness.as_of_seq).toBe(event.seq);
    expect(freshness.epoch_id).toBe(store.getCurrentEpoch());

    store.close();
  });

  test("checkpoint freshness reports current explicitly stale checkpoints as stale", () => {
    const store = createTestStore();
    const event = store.appendEvent(makeEventInput(store.getCurrentEpoch()));
    store.recordCheckpoint({
      plugin: "origin",
      consumer_id: "origin-scanner",
      last_seq: event.seq,
      status: "stale",
    });

    const freshness = store.getCheckpointFreshness({
      plugin: "origin",
      consumer_id: "origin-scanner",
    });

    expect(freshness.status).toBe("stale");
    if (freshness.status !== "stale") {
      throw new Error(`expected stale checkpoint freshness, got ${freshness.status}`);
    }
    expect(freshness.data).toEqual(
      store.getCheckpoint({ plugin: "origin", consumer_id: "origin-scanner" }),
    );
    expect(freshness.as_of_seq).toBe(event.seq);
    expect(freshness.epoch_id).toBe(store.getCurrentEpoch());
    expect(freshness.current_epoch_id).toBe(store.getCurrentEpoch());

    store.close();
  });

  test("checkpoint freshness reports prior-epoch checkpoints as stale", () => {
    const store = createTestStore();
    store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:target",
        snapshot_id: "snapshot:target",
      }),
    );
    const event = store.appendEvent(
      makeEventInput(store.getCurrentEpoch(), {
        payload_hash: "sha256:latest",
        snapshot_id: "snapshot:latest",
      }),
    );
    store.recordCheckpoint({
      plugin: "origin",
      consumer_id: "origin-scanner",
      last_seq: event.seq,
      status: "recomputing",
    });

    store.completeRollback({
      targetSnapshotId: "snapshot:target",
      reason: "checkpoint must recompute",
      context: makeContext(),
    });
    const freshness = store.getCheckpointFreshness({
      plugin: "origin",
      consumer_id: "origin-scanner",
    });

    expect(freshness.status).toBe("stale");
    if (freshness.status !== "stale") {
      throw new Error(`expected stale checkpoint freshness, got ${freshness.status}`);
    }
    expect(freshness.as_of_seq).toBe(event.seq);
    expect(freshness.epoch_id).toBe(0);
    expect(freshness.current_epoch_id).toBe(1);

    store.close();
  });
});

function createTestStore() {
  return createTestStoreAtPath(makeDatabasePath());
}

function createTestStoreAtPath(databasePath: string) {
  return createSpineStore({
    databasePath,
    workspaceId,
    workspaceRoot,
  });
}

function makeDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "spine-store-"));
  return join(directory, "control.sqlite");
}

function makeEventInput(
  epochId: number,
  overrides: Partial<AppendEventInput> = {},
): AppendEventInput {
  return appendEventInputSchema.parse({
    actor_id: "agent-test",
    correlation_id: "corr-test",
    epoch_id: epochId,
    kind: "origin.scan.completed",
    plugin: "origin",
    payload_hash: "sha256:test",
    session_id: "session-test",
    ts: 1,
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
    ...overrides,
  });
}

function makeContext() {
  return {
    actor_id: "agent-test",
    correlation_id: "corr-test",
    session_id: "session-test",
  };
}
