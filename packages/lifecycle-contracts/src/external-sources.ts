import { z } from "zod";
import { contentHashSchema } from "./artifacts.ts";

export const externalSourceSchema = z.enum(["concord"]);
export type ExternalSource = z.infer<typeof externalSourceSchema>;

export const concordRangeRefSchema = z
  .object({
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    start_column: z.number().int().positive().optional(),
    end_column: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.end_line < range.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_line"],
        message: "end_line must be greater than or equal to start_line",
      });
    }
  });

export type ConcordRangeRef = z.infer<typeof concordRangeRefSchema>;

export const concordCorrelationRefSchema = z
  .object({
    source: z.literal("concord"),
    correlation_id: z.string().min(1),
    plan_ref: z.string().min(1).optional(),
    plan_text: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
  })
  .strict();

export type ConcordCorrelationRef = z.infer<typeof concordCorrelationRefSchema>;

export const concordCollisionArtifactRefSchema = z
  .object({
    source: z.literal("concord"),
    protocol_version: z.string().min(1),
    schema_version: z.string().min(1),
    event_id: z.string().min(1),
    lifecycle_object_id: z.string().min(1).optional(),
    ts: z.number().int().nonnegative(),
    event_type: z.string().min(1).optional(),
    file_path: z.string().min(1),
    requested_range: concordRangeRefSchema.optional(),
    conflicting_range: concordRangeRefSchema.optional(),
    requesting_session: z.string().min(1).optional(),
    requesting_correlation_id: z.string().min(1).optional(),
    requesting_plan_ref: z.string().min(1).optional(),
    requesting_intent: z.string().min(1).optional(),
    holding_session: z.string().min(1).optional(),
    holding_correlation_id: z.string().min(1).optional(),
    holding_plan_ref: z.string().min(1).optional(),
    holding_intent: z.string().min(1).optional(),
    resolution: z.enum(["rejected", "waited_then_acquired", "downgraded"]).optional(),
    wait_ms: z.number().int().nonnegative().optional(),
    spine_seq: z.number().int().positive().optional(),
    guidance_emitted: z.boolean().optional(),
    correlation: concordCorrelationRefSchema.optional(),
  })
  .strict();

export type ConcordCollisionArtifactRef = z.infer<typeof concordCollisionArtifactRefSchema>;

export const externalGuidanceEnvelopeSchema = z
  .object({
    source: externalSourceSchema,
    format: z.literal("concord_conflict_xml"),
    content: z.string().min(1),
    content_hash: contentHashSchema,
    source_event_id: z.string().min(1).optional(),
  })
  .strict();

export type ExternalGuidanceEnvelope = z.infer<typeof externalGuidanceEnvelopeSchema>;
