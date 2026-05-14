import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type ArtifactRef,
  buildArtifactRef,
  parseConcordEventId,
  parseLifecycleObjectId,
} from "@mazac-fox/opencode-fleet-contracts";
import { tool } from "@opencode-ai/plugin";
import { concordCollisionArtifactRefSchema } from "../../packages/lifecycle-contracts/src/external-sources.ts";
import { createSpineStore } from "../../packages/spine/src/index.ts";

const concordCollisionRowSchema = tool.schema
  .object({
    id: tool.schema.number().int().nonnegative(),
    ts: tool.schema.number().int().nonnegative(),
    eventType: tool.schema.string().min(1),
    requestingSession: tool.schema.string().min(1),
    requestingCorrelationId: tool.schema.string().min(1).optional(),
    requestingPlanRef: tool.schema.string().min(1).optional(),
    requestingIntent: tool.schema.string().min(1),
    holdingSession: tool.schema.string().min(1).optional(),
    holdingCorrelationId: tool.schema.string().min(1).optional(),
    holdingPlanRef: tool.schema.string().min(1).optional(),
    holdingIntent: tool.schema.string().min(1).optional(),
    filePath: tool.schema.string().min(1),
    requestedRange: tool.schema.string().min(1),
    conflictingRange: tool.schema.string().min(1),
    resolution: tool.schema.enum(["rejected", "waited_then_acquired", "downgraded"]),
    waitMs: tool.schema.number().int().nonnegative().optional(),
    guidanceEmitted: tool.schema.string().min(1).optional(),
  })
  .passthrough();

const eventsResponseSchema = tool.schema.object({
  rows: tool.schema.array(concordCollisionRowSchema).default([]),
});

type ConcordCollisionRow = {
  id: number;
  ts: number;
  eventType: string;
  requestingSession: string;
  requestingCorrelationId?: string;
  requestingPlanRef?: string;
  requestingIntent: string;
  holdingSession?: string;
  holdingCorrelationId?: string;
  holdingPlanRef?: string;
  holdingIntent?: string;
  filePath: string;
  requestedRange: string;
  conflictingRange: string;
  resolution: "rejected" | "waited_then_acquired" | "downgraded";
  waitMs?: number;
  guidanceEmitted?: string;
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function workspaceId(worktree: string) {
  return `ws_${createHash("sha256").update(path.resolve(worktree)).digest("hex").slice(0, 16)}`;
}

function lifecycleDir(worktree: string) {
  return path.join(worktree, ".opencode", "lifecycle", "artifacts", "concord");
}

function spinePath(worktree: string, override?: string) {
  return override ?? path.join(worktree, ".opencode", "spine", "events.sqlite");
}

function parseRange(value: string) {
  const match = /^(\d+)(?::(\d+))?-(\d+|EOF)(?::(\d+))?$/.exec(value);
  if (!match || match[3] === "EOF") return undefined;
  return {
    start_line: Number(match[1]),
    start_column: match[2] ? Number(match[2]) : undefined,
    end_line: Number(match[3]),
    end_column: match[4] ? Number(match[4]) : undefined,
  };
}

function collisionArtifact(row: ConcordCollisionRow, ids: ConcordIds, spineSeq?: number) {
  return concordCollisionArtifactRefSchema.parse({
    source: "concord",
    protocol_version: "1",
    schema_version: "1",
    event_id: ids.concordEventId,
    lifecycle_object_id: ids.lifecycleObjectId,
    ts: row.ts,
    event_type: row.eventType,
    file_path: row.filePath,
    requested_range: parseRange(row.requestedRange),
    conflicting_range: parseRange(row.conflictingRange),
    requesting_session: row.requestingSession,
    requesting_correlation_id: row.requestingCorrelationId,
    requesting_plan_ref: row.requestingPlanRef,
    requesting_intent: row.requestingIntent,
    holding_session: row.holdingSession,
    holding_correlation_id: row.holdingCorrelationId,
    holding_plan_ref: row.holdingPlanRef,
    holding_intent: row.holdingIntent,
    resolution: row.resolution,
    wait_ms: row.waitMs,
    spine_seq: spineSeq,
    guidance_emitted: Boolean(row.guidanceEmitted),
    correlation: row.requestingCorrelationId
      ? {
          source: "concord",
          correlation_id: row.requestingCorrelationId,
          plan_ref: row.requestingPlanRef,
          intent: row.requestingIntent,
        }
      : undefined,
  });
}

type ConcordIds = {
  concordEventId: string;
  lifecycleObjectId: string;
};

function concordIds(row: ConcordCollisionRow): ConcordIds {
  const concord = parseConcordEventId(`concord:${row.id}`);
  if (!concord.ok) throw new Error(`invalid Concord event id ${row.id}: ${concord.reason}`);
  const lifecycle = parseLifecycleObjectId(`concord-event:${concord.value}`);
  if (!lifecycle.ok)
    throw new Error(`invalid lifecycle object id for ${concord.value}: ${lifecycle.reason}`);
  return { concordEventId: concord.value, lifecycleObjectId: lifecycle.value };
}

function runConcord(args: {
  command: string;
  worktree: string;
  since?: number;
  sessionId?: string;
  correlationId?: string;
  fileGlob?: string;
}) {
  const command = [args.command, "collisions", "--json", "--worktree", args.worktree];
  if (args.since !== undefined) command.push("--since", String(args.since));
  if (args.sessionId) command.push("--session", args.sessionId);
  if (args.correlationId) command.push("--correlation", args.correlationId);
  if (args.fileGlob) command.push("--file-glob", args.fileGlob);
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`concord collisions failed (${result.exitCode}): ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

export const ingest = tool({
  description:
    "Import Concord collision events into lifecycle artifacts and the event spine so conflict context can be reused by Engram and future agents.",
  args: {
    worktree: tool.schema
      .string()
      .optional()
      .describe("Workspace root. Defaults to the current tool directory."),
    since: tool.schema
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Concord event lower bound."),
    session_id: tool.schema
      .string()
      .optional()
      .describe("Filter Concord events by requesting session."),
    correlation_id: tool.schema
      .string()
      .optional()
      .describe("Filter Concord events by correlation id."),
    file_glob: tool.schema.string().optional().describe("Filter Concord events by file glob."),
    concord_command: tool.schema
      .string()
      .optional()
      .describe("Concord CLI command name or path. Defaults to concord."),
    spine_db: tool.schema.string().optional().describe("Optional spine SQLite path."),
    input_json: tool.schema
      .string()
      .optional()
      .describe("Test/automation override: raw concord collisions JSON."),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("Validate and summarize without writing artifacts or spine events."),
  },
  async execute(args, context) {
    const worktree = path.resolve(args.worktree ?? context.directory);
    const raw =
      args.input_json ??
      runConcord({
        command: args.concord_command ?? "concord",
        worktree,
        since: args.since,
        sessionId: args.session_id,
        correlationId: args.correlation_id,
        fileGlob: args.file_glob,
      });
    const parsed: unknown = JSON.parse(raw);
    const response = eventsResponseSchema.parse(parsed);
    const rows = response.rows;
    const artifacts = lifecycleDir(worktree);
    const dryRun = args.dry_run === true;
    let written = 0;
    const spineSeqs: number[] = [];
    const artifactRefs: ArtifactRef[] = [];
    const lifecycleObjectIds: string[] = [];
    const concordEventIds: string[] = [];

    if (!dryRun) {
      await mkdir(artifacts, { recursive: true });
      await mkdir(path.dirname(spinePath(worktree, args.spine_db)), { recursive: true });
    }
    const store = dryRun
      ? undefined
      : createSpineStore({
          databasePath: spinePath(worktree, args.spine_db),
          workspaceId: workspaceId(worktree),
          workspaceRoot: worktree,
        });
    try {
      for (const row of rows) {
        const ids = concordIds(row);
        concordEventIds.push(ids.concordEventId);
        lifecycleObjectIds.push(ids.lifecycleObjectId);
        const baseArtifact = collisionArtifact(row, ids);
        const content = JSON.stringify(baseArtifact, null, 2);
        const event = store?.appendEvent({
          session_id: row.requestingSession,
          correlation_id: row.requestingCorrelationId ?? args.correlation_id ?? `concord:${row.id}`,
          actor_id: row.requestingSession,
          workspace_id: workspaceId(worktree),
          workspace_root: worktree,
          epoch_id: store.getCurrentEpoch(),
          snapshot_id: sha256(content),
          tool_call_id: `concord:${row.id}`,
          lifecycle_object_id: ids.lifecycleObjectId,
          plugin: "concord",
          kind: "concord.collision.detected",
          ts: row.ts,
          payload_hash: sha256(content),
        });
        const artifact = collisionArtifact(row, ids, event?.seq);
        if (event) spineSeqs.push(event.seq);
        const jsonPath = path.join(artifacts, `${row.id}.json`);
        const artifactContent = JSON.stringify(artifact, null, 2);
        artifactRefs.push(
          buildArtifactRef({
            kind: "concord_collision",
            path: path.relative(worktree, jsonPath),
            hash: sha256(artifactContent),
          }),
        );
        if (!dryRun) {
          await Bun.write(jsonPath, artifactContent);
          if (row.guidanceEmitted)
            await Bun.write(path.join(artifacts, `${row.id}.xml`), row.guidanceEmitted);
          written += 1;
        }
      }
      if (store && spineSeqs.length > 0) {
        store.recordCheckpoint({
          plugin: "concord",
          consumer_id: "conductor.lifecycle_concord_ingest",
          last_seq: Math.max(...spineSeqs),
        });
      }
    } finally {
      store?.close();
    }

    return JSON.stringify(
      {
        dry_run: dryRun,
        artifact_refs: artifactRefs,
        lifecycle_object_ids: lifecycleObjectIds,
        concord_event_ids: concordEventIds,
        spine_seq: spineSeqs,
        rows: rows.length,
        artifacts_written: written,
      },
      null,
      2,
    );
  },
});
