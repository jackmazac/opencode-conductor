/**
 * `task_dispatch` — Plan-aware prompt formatter for OpenCode `task` invocations.
 *
 * NOT an actual dispatcher. The OpenCode SDK does not expose a plugin-side
 * hook to invoke the `task` tool from inside a Conductor tool. What this
 * tool DOES do:
 *
 *   1. Validate that the plan slug exists in `.opencode/plans/index.json`.
 *      Drift between a delegation header and a persisted plan silently
 *      disables `read_final_plan` for that subagent — exactly the failure
 *      mode `prompts/orchestrator.txt` calls out under `# Plan slug discipline`.
 *   2. Validate optional `task_id` and `wave_name` arg formats.
 *   3. Build the canonical `Plan: <slug> | Task: <id> | Wave: <name>` header.
 *   4. Return the header AND the fully assembled prompt body (header + blank
 *      line + caller's prompt text) so the orchestrator can paste it directly
 *      into the `task` tool's prompt arg.
 *
 * The orchestrator still calls OpenCode's `task` tool itself; this tool just
 * removes the "I forgot the Plan: line" failure mode and gives a typed
 * boundary for the slug-discipline rules.
 */

import { tool } from "@opencode-ai/plugin";

import { readPlanIndex } from "../plan-artifacts";
import { validateSlug } from "../util/slug";

const PLAN_SLUG_EXAMPLE = "auth-refactor, ugi-render-0.18-hardcutover";
const HEADER_FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const taskDispatch = tool({
  description:
    "Build a plan-aware `task` prompt with the canonical `Plan: <slug> | Task: <id> | Wave: <name>` header pre-attached. Validates that the plan slug exists in the persisted plan index — rejects drift between a delegation header and a persisted plan (the failure mode `# Plan slug discipline` was written to prevent). Returns `{ header, prompt, plan_id }` so the orchestrator can pass the assembled `prompt` straight to OpenCode's `task` tool. For ad-hoc delegations (no persisted plan), pass `ad_hoc: true` to skip plan-index validation and omit the header from the assembled prompt.",
  args: {
    plan_slug: tool.schema
      .string()
      .optional()
      .describe(
        "Persisted plan slug. Validated against .opencode/plans/index.json — must exist. Omit (or set ad_hoc:true) for ad-hoc delegations.",
      ),
    task_id: tool.schema
      .string()
      .optional()
      .describe(
        "Task identifier from the plan (e.g. T1.2, T2). Format: alphanumeric + ._- (max 64 chars).",
      ),
    wave_name: tool.schema
      .string()
      .optional()
      .describe(
        "Wave name from the plan (e.g. W1, infra-bootstrap). Format: alphanumeric + ._- (max 64 chars).",
      ),
    prompt: tool.schema
      .string()
      .describe(
        "The body of the subagent prompt (everything the subagent needs to know about the task, excluding the Plan: header). Will be appended to the assembled header.",
      ),
    ad_hoc: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true, skips plan-index validation and omits the Plan: header from the assembled prompt. Use for delegations not backed by a persisted plan.",
      ),
  },
  async execute(args, context) {
    if (args.prompt.trim().length === 0) {
      throw new Error("task_dispatch: prompt body must be non-empty");
    }
    if (args.task_id !== undefined) validateHeaderField(args.task_id, "task_id");
    if (args.wave_name !== undefined) validateHeaderField(args.wave_name, "wave_name");

    if (args.ad_hoc) {
      return JSON.stringify(
        { header: null, prompt: args.prompt, plan_id: null, ad_hoc: true },
        null,
        2,
      );
    }

    if (args.plan_slug === undefined) {
      throw new Error(
        "task_dispatch: plan_slug is required unless ad_hoc:true. For ad-hoc delegations, set ad_hoc:true.",
      );
    }

    validateSlug(args.plan_slug, { example: PLAN_SLUG_EXAMPLE });
    const index = await readPlanIndex(context.directory);
    const entry = index.entries[args.plan_slug];
    if (!entry) {
      throw new Error(
        `task_dispatch: plan_slug "${args.plan_slug}" not found in .opencode/plans/index.json — persist the plan first via persist_final_plan, or fix the slug to match an existing entry.`,
      );
    }

    const header = formatHeader(args.plan_slug, args.task_id, args.wave_name);
    const assembled = `${header}\n\n${args.prompt}`;
    return JSON.stringify(
      {
        header,
        prompt: assembled,
        plan_id: entry.plan_id,
        ad_hoc: false,
      },
      null,
      2,
    );
  },
});

function formatHeader(
  planSlug: string,
  taskId: string | undefined,
  waveName: string | undefined,
): string {
  const parts = [`Plan: ${planSlug}`];
  if (taskId !== undefined) parts.push(`Task: ${taskId}`);
  if (waveName !== undefined) parts.push(`Wave: ${waveName}`);
  return parts.join(" | ");
}

function validateHeaderField(value: string, field: string): void {
  if (!HEADER_FIELD_RE.test(value)) {
    throw new Error(
      `task_dispatch: ${field} "${value}" must be alphanumeric with optional ._- separators (max 64 chars)`,
    );
  }
}
