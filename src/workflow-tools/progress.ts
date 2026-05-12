import { tool } from "@opencode-ai/plugin";

import { createProgressStore } from "../progress-artifacts";

const store = createProgressStore({
  folder: "progress",
  argName: "plan_slug",
  kind: "plan",
  slugExample: "auth-refactor, ugi-render-0.18-hardcutover",
});

export const update = tool({
  description:
    "Update wave-level progress for a persisted plan. Call after each wave completes or starts. Tracks per-wave state (pending/in-progress/done) with optional summary and commit reference.",
  args: {
    plan_slug: tool.schema.string().describe("Plan slug this progress tracks"),
    wave_id: tool.schema.string().describe("Wave identifier (e.g. W1, W2)"),
    status: tool.schema.string().describe("Wave status: pending | in-progress | done"),
    summary: tool.schema
      .string()
      .optional()
      .describe("Brief summary of wave state (e.g. '3/5 tasks done', commit hash)"),
  },
  async execute(args, context) {
    return store.update(context.directory, {
      slug: args.plan_slug,
      wave_id: args.wave_id,
      status: args.status,
      summary: args.summary,
    });
  },
});

export const read = tool({
  description:
    "Read wave-level progress. Call with a plan slug to see waves for that plan (last 10). Call without a slug to list all plans with progress summaries.",
  args: {
    plan_slug: tool.schema
      .string()
      .optional()
      .describe("Plan slug to read. Omit to list all plans with progress."),
  },
  async execute(args, context) {
    return store.read(context.directory, { slug: args.plan_slug });
  },
});

export const done = tool({
  description:
    "Remove progress tracking for a plan. Call with a slug to remove one plan's progress. Call without a slug to remove ALL progress files.",
  args: {
    plan_slug: tool.schema
      .string()
      .optional()
      .describe("Plan slug to remove. Omit to remove ALL progress files."),
  },
  async execute(args, context) {
    return store.discard(context.directory, { slug: args.plan_slug });
  },
});

/** Exported for use by composite tools (artifact_index, drift_check, session_init). */
export const __store = store;
