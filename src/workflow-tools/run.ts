import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

type RunRecord = {
  schema_version: 1;
  agent_run_id: string;
  correlation_id: string;
  workspace_id: string;
  plan_slug?: string;
  wave_id?: string;
  task_id?: string;
  agent_type: string;
  goal?: string;
  paths: string[];
  status: RunStatus;
  created_at: string;
  updated_at: string;
  current?: string;
  completed?: string[];
  pending?: string[];
  blockers?: string[];
  finished_at?: string;
};

type RunStatus = "initialized" | "in_progress" | "done" | "blocked" | "cancelled";

type StatusMirror = {
  slug: string;
  goal?: string;
  plan?: string;
  wave?: string;
  current: string;
  completed: string[];
  pending: string[];
  blockers: string[];
  touched_files: string[];
  updated: string;
  agent_run_id: string;
  correlation_id: string;
  workspace_id: string;
  task_id?: string;
  agent_type: string;
  run_file: string;
};

function dir(directory: string) {
  return path.join(directory, ".opencode", "runs");
}

function statusDir(directory: string) {
  return path.join(directory, ".opencode", "status");
}

function rel(directory: string, file: string) {
  return path.relative(directory, file);
}

function workspaceId(directory: string) {
  const hash = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16);
  return `ws_${hash}`;
}

function runId() {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function statusSlug(id: string) {
  return `run-${id.slice(4, 16)}`;
}

function validateStatus(value: string): RunStatus {
  if (
    value === "initialized" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`invalid run status: ${value}`);
}

function runPath(directory: string, id: string) {
  return path.join(dir(directory), `${id}.json`);
}

async function loadRun(directory: string, id: string): Promise<RunRecord> {
  const file = runPath(directory, id);
  if (!fs.existsSync(file)) throw new Error(`run not found: ${id}`);
  return JSON.parse(await Bun.file(file).text()) as RunRecord;
}

async function writeRun(
  directory: string,
  record: RunRecord,
): Promise<{ runFile: string; statusFile: string; statusSlug: string }> {
  await mkdir(dir(directory), { recursive: true });
  await mkdir(statusDir(directory), { recursive: true });
  const dest = runPath(directory, record.agent_run_id);
  const tmp = `${dest}.tmp`;
  await Bun.write(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, dest);
  const runFile = rel(directory, dest);
  const status = statusMirror(record, runFile);
  const statusDest = path.join(statusDir(directory), `${status.slug}.json`);
  const statusTmp = `${statusDest}.tmp`;
  await Bun.write(statusTmp, JSON.stringify(status, null, 2));
  fs.renameSync(statusTmp, statusDest);
  return { runFile, statusFile: rel(directory, statusDest), statusSlug: status.slug };
}

function statusMirror(record: RunRecord, runFile: string): StatusMirror {
  return {
    slug: statusSlug(record.agent_run_id),
    goal: record.goal,
    plan: record.plan_slug,
    wave: record.wave_id,
    current: record.current ?? `${record.status} ${record.agent_type}`,
    completed: record.completed ?? [],
    pending: record.pending ?? (record.goal && record.status !== "done" ? [record.goal] : []),
    blockers: record.blockers ?? [],
    touched_files: record.paths,
    updated: record.updated_at,
    agent_run_id: record.agent_run_id,
    correlation_id: record.correlation_id,
    workspace_id: record.workspace_id,
    task_id: record.task_id,
    agent_type: record.agent_type,
    run_file: runFile,
  };
}

export const init = tool({
  description:
    "Initialize a structured subagent/tool run record so future code changes can be correlated to a plan, wave, agent, paths, and Concord/telemetry correlation id.",
  args: {
    agent_type: tool.schema
      .string()
      .describe("Agent or tool owner, e.g. executor-high, reviewer, concord-ingest"),
    plan_slug: tool.schema
      .string()
      .optional()
      .describe("Canonical plan slug, if this run belongs to a plan"),
    wave_id: tool.schema.string().optional().describe("Plan wave/task identifier, if applicable"),
    task_id: tool.schema.string().optional().describe("External task/subagent id, if available"),
    goal: tool.schema.string().optional().describe("Short run goal"),
    paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Paths this run expects to read or edit"),
    correlation_id: tool.schema
      .string()
      .optional()
      .describe("Existing Concord/Fleet correlation id; generated when omitted"),
  },
  async execute(args, context) {
    const id = runId();
    const now = new Date().toISOString();
    const record: RunRecord = {
      schema_version: 1,
      agent_run_id: id,
      correlation_id: args.correlation_id ?? `corr_${id.slice(4)}`,
      workspace_id: workspaceId(context.directory),
      plan_slug: args.plan_slug,
      wave_id: args.wave_id,
      task_id: args.task_id,
      agent_type: args.agent_type,
      goal: args.goal,
      paths: args.paths ?? [],
      status: "initialized",
      created_at: now,
      updated_at: now,
    };
    const files = await writeRun(context.directory, record);
    return JSON.stringify(
      {
        ...record,
        file: files.runFile,
        status_slug: files.statusSlug,
        status_file: files.statusFile,
      },
      null,
      2,
    );
  },
});

export const update = tool({
  description:
    "Update a structured run record and its compact status mirror as a subagent/tool run progresses.",
  args: {
    agent_run_id: tool.schema.string().describe("Run id returned by run_init"),
    status: tool.schema
      .string()
      .optional()
      .describe("Run status: initialized, in_progress, done, blocked, or cancelled"),
    current: tool.schema.string().optional().describe("Current activity summary"),
    completed: tool.schema.array(tool.schema.string()).optional().describe("Completed items"),
    pending: tool.schema.array(tool.schema.string()).optional().describe("Pending items"),
    blockers: tool.schema.array(tool.schema.string()).optional().describe("Blocking issues"),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Touched/owned paths"),
  },
  async execute(args, context) {
    const existing = await loadRun(context.directory, args.agent_run_id);
    const now = new Date().toISOString();
    const next: RunRecord = {
      ...existing,
      status: args.status ? validateStatus(args.status) : existing.status,
      current: args.current ?? existing.current,
      completed: args.completed ?? existing.completed,
      pending: args.pending ?? existing.pending,
      blockers: args.blockers ?? existing.blockers,
      paths: args.paths ?? existing.paths,
      updated_at: now,
    };
    const files = await writeRun(context.directory, next);
    return JSON.stringify(
      {
        ...next,
        file: files.runFile,
        status_slug: files.statusSlug,
        status_file: files.statusFile,
      },
      null,
      2,
    );
  },
});

export const finish = tool({
  description: "Finish a structured run record and status mirror as done, blocked, or cancelled.",
  args: {
    agent_run_id: tool.schema.string().describe("Run id returned by run_init"),
    status: tool.schema
      .string()
      .optional()
      .describe("Final status: done, blocked, or cancelled. Defaults to done."),
    summary: tool.schema.string().optional().describe("Final run summary"),
    blockers: tool.schema.array(tool.schema.string()).optional().describe("Final blockers, if any"),
    paths: tool.schema.array(tool.schema.string()).optional().describe("Final touched/owned paths"),
  },
  async execute(args, context) {
    const existing = await loadRun(context.directory, args.agent_run_id);
    const status = args.status ? validateStatus(args.status) : "done";
    if (status === "initialized" || status === "in_progress") {
      throw new Error("run_finish status must be done, blocked, or cancelled");
    }
    const now = new Date().toISOString();
    const next: RunRecord = {
      ...existing,
      status,
      current: args.summary ?? `${status} ${existing.agent_type}`,
      completed:
        status === "done" ? [args.summary ?? existing.goal ?? "completed"] : existing.completed,
      pending: [],
      blockers: args.blockers ?? existing.blockers ?? [],
      paths: args.paths ?? existing.paths,
      updated_at: now,
      finished_at: now,
    };
    const files = await writeRun(context.directory, next);
    return JSON.stringify(
      {
        ...next,
        file: files.runFile,
        status_slug: files.statusSlug,
        status_file: files.statusFile,
      },
      null,
      2,
    );
  },
});
