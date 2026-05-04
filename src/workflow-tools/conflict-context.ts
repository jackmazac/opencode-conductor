import path from "node:path";
import { tool } from "@opencode-ai/plugin";

type EngramDispatch = (toolName: "conflict_context", args: unknown) => Promise<unknown>;

let engramDispatch: EngramDispatch | null = null;

export function __test_setEngramDispatch(fn: EngramDispatch | null): void {
  engramDispatch = fn;
}

function unavailableResult() {
  return {
    ok: false,
    error: {
      code: "E_ENGRAM_NATIVE_UNAVAILABLE",
      message:
        "Engram native conflict_context tool not yet wired. Wave 3 ships the native tool; Wave 2 replaces the prior shell path.",
    },
  };
}

export const context = tool({
  description:
    "Fetch conflict-aware Engram context using Concord/lifecycle correlation fields through Engram's native conflict_context tool.",
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
    engram_command: tool.schema
      .string()
      .optional()
      .describe("Deprecated Wave 1 shell option retained for signature compatibility; ignored."),
    ingest_artifacts: tool.schema
      .boolean()
      .optional()
      .describe("Deprecated Wave 1 shell option retained for signature compatibility; ignored."),
    json: tool.schema.boolean().optional().describe("Request JSON output from Engram context."),
  },
  async execute(args, contextArg) {
    const dispatch = engramDispatch;
    if (!dispatch) return JSON.stringify(unavailableResult(), null, 2);

    // TODO(Wave 3): wire this module-local dispatcher to OpenCode's native tool dispatch
    // once the SDK exposes an in-tool dispatch surface for Engram's conflict_context.
    const result = await dispatch("conflict_context", {
      ...args,
      worktree: path.resolve(args.worktree ?? contextArg.directory),
    });
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  },
});
