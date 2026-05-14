import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parsePlanId } from "@mazac-fox/opencode-fleet-contracts";
import { tool } from "@opencode-ai/plugin";
import { readPlanIndex } from "../plan-artifacts.ts";

import { rel } from "../util/format";
import { pathExists } from "../util/path-exists";

type RunRecord = {
  schema_version: 1;
  agent_run_id: string;
  correlation_id: string;
  workspace_id: string;
  plan_id?: string;
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
  plan_id?: string;
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
  if (!(await Bun.file(file).exists())) throw new Error(`run not found: ${id}`);
  const parsed: unknown = JSON.parse(await Bun.file(file).text());
  if (!isRunRecord(parsed)) throw new Error(`invalid run record: ${id}`);
  return parsed;
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
  await rename(tmp, dest);
  const runFile = rel(directory, dest);
  const status = statusMirror(record, runFile);
  const statusDest = path.join(statusDir(directory), `${status.slug}.json`);
  const statusTmp = `${statusDest}.tmp`;
  await Bun.write(statusTmp, JSON.stringify(status, null, 2));
  await rename(statusTmp, statusDest);
  return { runFile, statusFile: rel(directory, statusDest), statusSlug: status.slug };
}

/** Exposed for use by run_list, artifact_index, drift_check, session_init. */
export async function readAllRuns(directory: string): Promise<RunRecord[]> {
  const base = dir(directory);
  if (!(await pathExists(base))) return [];
  const entries = (await readdir(base)).filter((f) => f.endsWith(".json"));
  const records = await Promise.all(
    entries.map(async (f) => {
      try {
        const parsed: unknown = JSON.parse(await Bun.file(path.join(base, f)).text());
        return isRunRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }),
  );
  return records.filter((r): r is RunRecord => r !== null);
}

/** Exposed for composite tools. Returns workspace-relative run file paths. */
export async function listRunFiles(
  directory: string,
): Promise<Array<{ id: string; path: string; mtime: string }>> {
  const base = dir(directory);
  if (!(await pathExists(base))) return [];
  const entries = (await readdir(base)).filter((f) => f.endsWith(".json"));
  const results = await Promise.all(
    entries.map(async (f) => {
      const full = path.join(base, f);
      const fileStat = await stat(full);
      return {
        id: f.replace(/\.json$/, ""),
        path: rel(directory, full),
        mtime: fileStat.mtime.toISOString(),
      };
    }),
  );
  return results.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function statusMirror(record: RunRecord, runFile: string): StatusMirror {
  return {
    slug: statusSlug(record.agent_run_id),
    goal: record.goal,
    plan_id: record.plan_id,
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
    plan_id: tool.schema
      .string()
      .optional()
      .describe("Canonical plan id, if already known; resolved from plan_slug when omitted."),
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
    const planId = await resolvePlanId(context.directory, args.plan_id, args.plan_slug);
    const record: RunRecord = {
      schema_version: 1,
      agent_run_id: id,
      correlation_id: args.correlation_id ?? `corr_${id.slice(4)}`,
      workspace_id: workspaceId(context.directory),
      plan_id: planId,
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

async function resolvePlanId(
  directory: string,
  explicitPlanId: string | undefined,
  planSlug: string | undefined,
): Promise<string | undefined> {
  if (explicitPlanId !== undefined) {
    const parsed = parsePlanId(explicitPlanId);
    if (!parsed.ok) throw new Error(`invalid plan_id "${explicitPlanId}": ${parsed.reason}`);
    return parsed.value;
  }
  if (planSlug === undefined) return undefined;
  const index = await readPlanIndex(directory);
  return index.entries[planSlug]?.plan_id;
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value)) return false;
  return (
    value.schema_version === 1 &&
    typeof value.agent_run_id === "string" &&
    typeof value.correlation_id === "string" &&
    typeof value.workspace_id === "string" &&
    optionalString(value.plan_id) &&
    optionalString(value.plan_slug) &&
    optionalString(value.wave_id) &&
    optionalString(value.task_id) &&
    typeof value.agent_type === "string" &&
    optionalString(value.goal) &&
    isStringArray(value.paths) &&
    isRunStatus(value.status) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    optionalString(value.current) &&
    optionalStringArray(value.completed) &&
    optionalStringArray(value.pending) &&
    optionalStringArray(value.blockers) &&
    optionalString(value.finished_at)
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "initialized" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export const list = tool({
  description:
    "List structured run records with optional filtering by status, plan slug, or agent type. Closes the trio for run_init / run_update / run_finish. Returns a JSON array sorted by most-recent-first. Use during session rehydration or to audit which runs are still in-progress.",
  args: {
    status: tool.schema
      .enum(["initialized", "in_progress", "done", "blocked", "cancelled"])
      .optional()
      .describe("Filter by run status. Omit to include all statuses."),
    plan_slug: tool.schema.string().optional().describe("Filter to runs for a specific plan slug."),
    agent_type: tool.schema
      .string()
      .optional()
      .describe("Filter to runs of a specific agent type (e.g. executor-high)."),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of records to return. Default 20, max 100."),
  },
  async execute(args, context) {
    const all = await readAllRuns(context.directory);
    let filtered = all;
    if (args.status) filtered = filtered.filter((r) => r.status === args.status);
    if (args.plan_slug) filtered = filtered.filter((r) => r.plan_slug === args.plan_slug);
    if (args.agent_type) filtered = filtered.filter((r) => r.agent_type === args.agent_type);
    filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const requested = args.limit ?? 20;
    const limit = Math.min(Math.max(1, Math.floor(requested)), 100);
    const shown = filtered.slice(0, limit);
    const records = shown.map((r) => ({
      agent_run_id: r.agent_run_id,
      status: r.status,
      plan_slug: r.plan_slug,
      plan_id: r.plan_id,
      wave_id: r.wave_id,
      task_id: r.task_id,
      agent_type: r.agent_type,
      goal: r.goal,
      updated_at: r.updated_at,
      finished_at: r.finished_at,
      file: rel(context.directory, runPath(context.directory, r.agent_run_id)),
    }));
    return JSON.stringify(
      {
        total: filtered.length,
        shown: shown.length,
        limit,
        records,
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
