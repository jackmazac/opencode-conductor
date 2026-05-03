import path from "node:path";
import { tool } from "@opencode-ai/plugin";

type CommandResult = {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const rendered = [command, ...args.map(shellQuote)].join(" ");
  const result = Bun.spawnSync(["sh", "-lc", rendered], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return { command: rendered, exit_code: result.exitCode, stdout, stderr };
}

function pushOptional(args: string[], flag: string, value: string | number | undefined) {
  if (value !== undefined && value !== "") args.push(flag, String(value));
}

function pushRepeated(args: string[], flag: string, values: string[] | undefined) {
  for (const value of values ?? []) if (value) args.push(flag, value);
}

export const context = tool({
  description:
    "Fetch conflict-aware Engram context using Concord/lifecycle correlation fields. Optionally ingests lifecycle artifacts first, then runs one Engram context query.",
  args: {
    project_id: tool.schema.string().describe("Engram project id for the workspace"),
    worktree: tool.schema
      .string()
      .optional()
      .describe("Workspace root. Defaults to current directory."),
    query: tool.schema
      .string()
      .optional()
      .describe("Context query. Defaults to a Concord conflict context query."),
    mode: tool.schema.string().optional().describe("Engram context mode. Defaults to debug."),
    limit: tool.schema.number().int().positive().optional().describe("Context result limit"),
    budget_chars: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Context character budget"),
    correlation_id: tool.schema.string().optional().describe("Concord/Fleet correlation id"),
    session_id: tool.schema.string().optional().describe("OpenCode/Concord session id"),
    plan_slug: tool.schema.string().optional().describe("Plan slug"),
    wave_id: tool.schema.string().optional().describe("Plan wave id"),
    agent_run_id: tool.schema.string().optional().describe("Conductor run id"),
    lifecycle_object_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Lifecycle object ids"),
    artifact_refs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Lifecycle/Engram artifact refs"),
    concord_event_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Concord collision event ids"),
    engram_command: tool.schema.string().optional().describe("Engram command. Defaults to engram."),
    ingest_artifacts: tool.schema
      .boolean()
      .optional()
      .describe(
        "Run engram ingest-artifacts for lifecycle/concord artifacts before context. Defaults true.",
      ),
    json: tool.schema.boolean().optional().describe("Request JSON output from Engram context."),
  },
  async execute(args, contextArg) {
    const worktree = path.resolve(args.worktree ?? contextArg.directory);
    const command = args.engram_command ?? "engram";
    const ingestArtifacts = args.ingest_artifacts !== false;
    const ingestArgs = [
      "ingest-artifacts",
      "--apply",
      "--kind",
      "lifecycle,concord_collision,concord_guidance",
      "--project-id",
      args.project_id,
      "--worktree",
      worktree,
    ];
    const contextArgs = [
      "context",
      args.query ?? "Concord conflict context",
      "--project-id",
      args.project_id,
      "--worktree",
      worktree,
      "--mode",
      args.mode ?? "debug",
      "--limit",
      String(args.limit ?? 12),
      "--budget",
      String(args.budget_chars ?? 6000),
    ];
    pushOptional(contextArgs, "--correlation-id", args.correlation_id);
    pushOptional(contextArgs, "--session-id", args.session_id);
    pushOptional(contextArgs, "--plan-slug", args.plan_slug);
    pushOptional(contextArgs, "--wave-id", args.wave_id);
    pushOptional(contextArgs, "--agent-run-id", args.agent_run_id);
    pushRepeated(contextArgs, "--lifecycle-object-id", args.lifecycle_object_ids);
    pushRepeated(contextArgs, "--artifact-ref", args.artifact_refs);
    pushRepeated(contextArgs, "--concord-event-id", args.concord_event_ids);
    if (args.json) contextArgs.push("--json");

    const ingest = ingestArtifacts ? run(command, ingestArgs, worktree) : undefined;
    if (ingest && ingest.exit_code !== 0) {
      throw new Error(
        `engram ingest-artifacts failed (${ingest.exit_code}): ${ingest.stderr || ingest.stdout}`,
      );
    }
    const bundle = run(command, contextArgs, worktree);
    if (bundle.exit_code !== 0) {
      throw new Error(
        `engram context failed (${bundle.exit_code}): ${bundle.stderr || bundle.stdout}`,
      );
    }
    return JSON.stringify(
      {
        worktree,
        project_id: args.project_id,
        ingest: ingest
          ? { command: ingest.command, output: ingest.stdout, stderr: ingest.stderr }
          : { skipped: true },
        context: { command: bundle.command, output: bundle.stdout, stderr: bundle.stderr },
      },
      null,
      2,
    );
  },
});
