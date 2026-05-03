import { z } from "zod";
import { freshnessSchema } from "../../bridge-contracts/src/index.ts";
import { lifecycleArtifactRefSchema } from "./artifacts.ts";
import { lifecycleModuleSchema } from "./config.ts";
import { lifecycleObjectIdSchema } from "./object-id.ts";

export const lifecycleDecisionSeveritySchema = z.enum(["allow", "warn", "block"]);
export type LifecycleDecisionSeverity = z.infer<typeof lifecycleDecisionSeveritySchema>;

export const lifecycleRemediationSchema = z
  .object({
    summary: z.string().min(1),
    required_artifacts: z.array(z.string().min(1)).optional(),
    source_paths: z.array(z.string().min(1)).optional(),
    commands: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type LifecycleRemediation = z.infer<typeof lifecycleRemediationSchema>;

export const lifecycleDecisionObjectIdSchema = z
  .string()
  .min(1)
  .superRefine((objectId, ctx) => {
    if (objectId.startsWith("concord-collision:") || objectId.startsWith("concord-guidance:")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Concord collisions and guidance are external evidence, not lifecycle decision targets.",
      });
    }
  });

export type LifecycleDecisionObjectId = z.infer<typeof lifecycleDecisionObjectIdSchema>;

export const lifecycleDecisionFreshnessSchema = z
  .object({
    epoch_id: z.number().int().nonnegative(),
    as_of_seq: z.number().int().nonnegative(),
    status: freshnessSchema,
  })
  .strict();

export type LifecycleDecisionFreshness = z.infer<typeof lifecycleDecisionFreshnessSchema>;

export const freshLifecycleDecisionFreshnessSchema = lifecycleDecisionFreshnessSchema.extend({
  status: z.literal("fresh"),
});

export type FreshLifecycleDecisionFreshness = z.infer<typeof freshLifecycleDecisionFreshnessSchema>;

export const lifecycleDecisionBaseSchema = z
  .object({
    decision_id: z.string().min(1),
    module: lifecycleModuleSchema,
    severity: lifecycleDecisionSeveritySchema,
    reason_code: z.string().min(1),
    object_id: lifecycleDecisionObjectIdSchema,
    object: lifecycleObjectIdSchema.optional(),
    evidence_refs: z.array(lifecycleArtifactRefSchema).default([]),
    remediation: lifecycleRemediationSchema,
    freshness: lifecycleDecisionFreshnessSchema,
  })
  .strict();

export const historicalLifecycleDecisionSchema = lifecycleDecisionBaseSchema;
export type HistoricalLifecycleDecision = z.infer<typeof historicalLifecycleDecisionSchema>;

export const lifecycleDecisionSchema = lifecycleDecisionBaseSchema.extend({
  freshness: freshLifecycleDecisionFreshnessSchema,
});

export type LifecycleDecision = z.infer<typeof lifecycleDecisionSchema>;

export function parseLifecycleDecision(input: unknown): LifecycleDecision {
  return lifecycleDecisionSchema.parse(input);
}
