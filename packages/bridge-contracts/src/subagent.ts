/**
 * packages/bridge-contracts/src/subagent.ts
 *
 * Schema and helpers for subagent (task) result envelopes.
 *
 * Background: opencode's `task` tool dispatches a subagent and returns the
 * subagent's final response. The shape of that response varies — sometimes
 * it's a plain string, sometimes a structured envelope with metadata,
 * tool calls, or error info. When orchestrators consume subagent results,
 * malformed envelopes can crash downstream consumers (especially when
 * processed through Effect-based pipelines that introspect schemas).
 *
 * This module defines a stable envelope contract that orchestrator code
 * SHOULD validate at the boundary:
 *
 *   import { subagentResultEnvelopeSchema } from "@mazac-fox/opencode-conductor/bridge-contracts/subagent";
 *
 *   const parsed = subagentResultEnvelopeSchema.safeParse(rawResult);
 *   if (!parsed.success) {
 *     return `❌ subagent returned malformed envelope: ${parsed.error.message}`;
 *   }
 *
 * Validating at the boundary turns a silent crash into a clear error string.
 */

import { z } from "zod";

/**
 * Status of a subagent task.
 *
 *   ok       — completed normally; payload is the assistant's final answer.
 *   error    — failed; payload SHOULD include an error description.
 *   blocked  — paused waiting on user input; payload describes what's needed.
 *   timeout  — exceeded execution budget; payload may be partial.
 */
export const subagentStatusSchema = z.enum(["ok", "error", "blocked", "timeout"]);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

/**
 * Tool call summary recorded inside a subagent envelope.
 *
 * Lightweight: name + brief outcome only. Full tool call records belong in
 * opencode's session storage, not in the envelope itself.
 */
export const subagentToolCallSchema = z
  .object({
    tool: z.string().min(1),
    status: z.enum(["ok", "error", "skip"]),
    duration_ms: z.number().nonnegative().optional(),
    error_message: z.string().optional(),
  })
  .strict();
export type SubagentToolCall = z.infer<typeof subagentToolCallSchema>;

/**
 * Token usage summary recorded inside a subagent envelope.
 *
 * Optional. Used for orchestrator budget tracking.
 */
export const subagentUsageSchema = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
export type SubagentUsage = z.infer<typeof subagentUsageSchema>;

/**
 * Subagent result envelope.
 *
 * Required:
 *   - status: one of `subagentStatusSchema` values.
 *   - content: the subagent's textual response (may be empty for error/timeout).
 *
 * Optional:
 *   - agent_id: which agent produced this result (e.g. "executor-high").
 *   - session_id: the subagent's session id, useful for cross-referencing.
 *   - trace_id: correlation id propagated from the orchestrator turn.
 *   - tool_calls: lightweight summary of tools the subagent invoked.
 *   - usage: token + cost summary.
 *   - error: present when status is "error" or "timeout".
 *   - metadata: free-form additional context.
 */
export const subagentResultEnvelopeSchema = z
  .object({
    status: subagentStatusSchema,
    content: z.string(),
    agent_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    trace_id: z.string().min(1).optional(),
    tool_calls: z.array(subagentToolCallSchema).optional(),
    usage: subagentUsageSchema.optional(),
    error: z
      .object({
        type: z.string().min(1),
        message: z.string().min(1),
        recoverable: z.boolean().optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SubagentResultEnvelope = z.infer<typeof subagentResultEnvelopeSchema>;

/**
 * Adapt a raw subagent result (which may be a plain string or a partial
 * object) into a normalized envelope. Use this at the orchestrator
 * boundary when you don't control the subagent's output format.
 *
 *   const envelope = adaptSubagentResult(taskOutput);
 *
 * Always returns a valid envelope. Falls back to wrapping plain strings
 * as `{ status: "ok", content: <string> }`.
 */
export function adaptSubagentResult(raw: unknown): SubagentResultEnvelope {
  if (typeof raw === "string") {
    return { status: "ok", content: raw };
  }

  if (raw && typeof raw === "object") {
    const parsed = subagentResultEnvelopeSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }

  return {
    status: "error",
    content: "",
    error: {
      type: "envelope_unparseable",
      message: `subagent returned non-string, non-envelope value of type ${typeof raw}`,
    },
  };
}

/**
 * Validate a raw subagent result against the envelope schema. Returns a
 * Result-style discriminated union so orchestrators can branch on success
 * without throwing.
 */
export function validateSubagentEnvelope(
  raw: unknown,
):
  | { ok: true; envelope: SubagentResultEnvelope }
  | { ok: false; error: string; rawType: string } {
  const adapted = adaptSubagentResult(raw);
  const parsed = subagentResultEnvelopeSchema.safeParse(adapted);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
    rawType: typeof raw,
  };
}
