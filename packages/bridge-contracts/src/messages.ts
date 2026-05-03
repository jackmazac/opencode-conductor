/**
 * packages/bridge-contracts/src/messages.ts
 *
 * Structured agent message contract shared across the lifecycle-integrity
 * vertical (origin, seal, portage, torch) and the conflict plugin.
 *
 * Design principles (from the plan):
 *   - Factual, actionable, blame-free, bounded.
 *   - Always includes violated rule, affected object, canonical source, remediation.
 *   - Never includes secrets or huge raw outputs.
 *   - `no_reply` signals that the agent message is terminal (no follow-up expected).
 *
 * Severity semantics:
 *   info   — advisory only; includes remediation summary for actionable context.
 *   warn   — attention needed; includes remediation summary, non-whitespace when applicable.
 *   block  — gate is triggered; includes remediation summary, non-whitespace when applicable.
 *
 * Invariant: all agent messages MUST include a `remediation.summary`.
 * `warn` and `block` messages additionally enforce a non-whitespace summary via
 * `.superRefine()` so the type system preserves inference rather than carrying
 * a conditional type.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const agentMessageSeveritySchema = z.enum(["info", "warn", "block"]);

export type AgentMessageSeverity = z.infer<typeof agentMessageSeveritySchema>;

// ---------------------------------------------------------------------------
// Remediation — actionable guidance attached to a message.
// `summary` is free-form prose; `source_paths`, `commands`, `refs` are
// structured hints that tooling can render or act on.
// ---------------------------------------------------------------------------

export const agentRemediationSchema = z
  .object({
    /**
     * Human-readable action summary.
     * Required on all agent messages.
     */
    summary: z.string().min(1),

    /**
     * Canonical source file paths relevant to the remediation,
     * e.g. the schema/IDL to edit instead of the generated output.
     */
    source_paths: z.array(z.string().min(1)).optional(),

    /**
     * Shell commands that effect the remediation,
     * e.g. `["bun run generate:api"]`.
     */
    commands: z.array(z.string().min(1)).optional(),

    /**
     * Additional reference links or artifact IDs.
     */
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type AgentRemediation = z.infer<typeof agentRemediationSchema>;

// ---------------------------------------------------------------------------
// AgentMessage — the canonical structured message emitted by lifecycle modules.
// ---------------------------------------------------------------------------

const agentMessageBaseSchema = z
  .object({
    /**
     * Unique identifier for this message instance (e.g. UUID or deterministic hash).
     */
    message_id: z.string().min(1),

    /** Severity level. All severities require `remediation.summary`. */
    severity: agentMessageSeveritySchema,

    /**
     * The rule or policy that was violated or triggered this message.
     * Should be a stable, namespaced identifier, e.g.
     * `origin.no-direct-generated-edit` or `seal.breaking-change-requires-note`.
     */
    violated_rule: z.string().min(1),

    /**
     * Identity of the object affected by this message.
     * Should match the lifecycle object ID model (file path, API path, migration ID, flag key).
     */
    affected_object: z.string().min(1),

    /**
     * Canonical source path or vendor-native source identity for the affected object.
     * For generated files: the schema/IDL. For API routes: the OpenAPI operation ID.
     * Always populate when known — this is what makes messages actionable.
     */
    canonical_source: z.string().optional(),

    /**
     * Structured remediation guidance.
     * Required for all severities; `warn` and `block` enforce a non-whitespace
     * summary via superRefine.
     */
    remediation: agentRemediationSchema,

    /**
     * The plugin or module that produced this message, e.g. `origin`, `seal`.
     */
    source_plugin: z.string().min(1),

    /**
     * The specific module path within the plugin, e.g. `origin/scanner/prisma`.
     */
    source_module: z.string().optional(),

    /**
     * When `true`, the message is terminal — no reply or follow-up is expected
     * from the agent. Used for hard blocks that cannot be overridden in-session.
     */
    no_reply: z.boolean().optional(),

    /**
     * Correlation ID linking this message to the originating event spine event.
     */
    correlation_id: z.string().optional(),
  })
  .strict();

/**
 * Refinement: `warn` and `block` messages must carry a non-whitespace
 * `remediation.summary`.
 *
 * This is already structurally enforced by `agentRemediationSchema` (summary is required
 * and non-empty there) for all severities, but we add an explicit superRefine to document
 * the stricter warn/block invariant clearly and to surface a meaningful error if
 * `remediation.summary` is only whitespace.
 */
export const agentMessageSchema = agentMessageBaseSchema.superRefine((msg, ctx) => {
  if (msg.severity === "warn" || msg.severity === "block") {
    if (!msg.remediation.summary || msg.remediation.summary.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remediation", "summary"],
        message: `Messages with severity '${msg.severity}' must include a non-empty remediation.summary`,
      });
    }
  }
});

export type AgentMessage = z.infer<typeof agentMessageSchema>;
