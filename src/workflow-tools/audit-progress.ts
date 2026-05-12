import { tool } from "@opencode-ai/plugin";

import { createProgressStore } from "../progress-artifacts";

const store = createProgressStore({
  folder: "audit-progress",
  argName: "audit_slug",
  kind: "audit",
  slugExample: "auth-surface, api-audit-0.18",
});

export const update = tool({
  description:
    "Update wave-level progress for a persisted audit (orchestrator-only). Call after each investigation wave completes or starts. Same semantics as plan progress: pending | in-progress | done.",
  args: {
    audit_slug: tool.schema.string().describe("Audit slug this progress tracks"),
    wave_id: tool.schema.string().describe("Wave identifier (e.g. W1, explore-batch-a)"),
    status: tool.schema.string().describe("Wave status: pending | in-progress | done"),
    summary: tool.schema
      .string()
      .optional()
      .describe("Brief summary (e.g. '3 explore tasks returned', synthesis done)"),
  },
  async execute(args, context) {
    return store.update(context.directory, {
      slug: args.audit_slug,
      wave_id: args.wave_id,
      status: args.status,
      summary: args.summary,
    });
  },
});

export const read = tool({
  description:
    "Read audit wave progress. With audit_slug: all waves for that audit. Without: list all audits that have progress files.",
  args: {
    audit_slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to read. Omit to list all audits with progress summaries."),
  },
  async execute(args, context) {
    return store.read(context.directory, { slug: args.audit_slug });
  },
});

export const done = tool({
  description:
    "Remove audit progress tracking. With audit_slug: one audit. Without: ALL audit progress files.",
  args: {
    audit_slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to remove. Omit to remove ALL audit progress files."),
  },
  async execute(args, context) {
    return store.discard(context.directory, { slug: args.audit_slug });
  },
});

/** Exported for use by composite tools (artifact_index, drift_check, session_init). */
export const __store = store;
