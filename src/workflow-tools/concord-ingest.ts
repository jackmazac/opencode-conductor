import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { concordCollisionArtifactRefSchema } from "../../packages/lifecycle-contracts/src/external-sources.ts";
import { createSpineStore } from "../../packages/spine/src/index.ts";

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

type EventsResponse = { rows: ConcordCollisionRow[] };

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

function collisionArtifact(row: ConcordCollisionRow, spineSeq?: number) {
  return concordCollisionArtifactRefSchema.parse({
    source: "concord",
    protocol_version: "1",
    schema_version: "1",
    event_id: String(row.id),
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
    const response = JSON.parse(raw) as EventsResponse;
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const artifacts = lifecycleDir(worktree);
    const dryRun = args.dry_run === true;
    let written = 0;
    const spineSeqs: number[] = [];

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
        const baseArtifact = collisionArtifact(row);
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
          plugin: "concord",
          kind: "concord.collision.detected",
          ts: row.ts,
          payload_hash: sha256(content),
        });
        const artifact = collisionArtifact(row, event?.seq);
        if (event) spineSeqs.push(event.seq);
        if (!dryRun) {
          await Bun.write(
            path.join(artifacts, `${row.id}.json`),
            JSON.stringify(artifact, null, 2),
          );
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
        rows: rows.length,
        artifacts_written: written,
        artifact_dir: path.relative(context.directory, artifacts),
        spine_seqs: spineSeqs,
      },
      null,
      2,
    );
  },
});
