import { z } from "zod";
import { lifecycleModuleSchema } from "./config.ts";

export const lifecycleSourceKindSchema = z.enum([
  "source-file",
  "generated-output",
  "package-export",
  "openapi-operation",
  "graphql-field",
  "proto-symbol",
  "migration",
  "db-object",
  "feature-flag",
]);

export type LifecycleSourceKind = z.infer<typeof lifecycleSourceKindSchema>;

const lifecycleObjectBaseSchema = z
  .object({
    id: z.string().min(1),
    owner_module: lifecycleModuleSchema.optional(),
    version: z.string().min(1).optional(),
  })
  .strict();

const pathIdentitySchema = lifecycleObjectBaseSchema
  .extend({
    path: z.string().min(1),
  })
  .superRefine((object, ctx) => {
    if (object.id !== object.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "Path-backed lifecycle object IDs must use the same id and path.",
      });
    }
  });

export const lifecycleObjectIdSchema = z.discriminatedUnion("kind", [
  pathIdentitySchema.extend({ kind: z.literal("source-file") }),
  pathIdentitySchema.extend({ kind: z.literal("generated-output") }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("package-export"),
    vendor: z.literal("typescript"),
    id: z
      .string()
      .min(1)
      .regex(/^[^#]+#[^#]+$/, "Package exports must be identified as package#export."),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("openapi-operation"),
    vendor: z.literal("openapi"),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("graphql-field"),
    vendor: z.literal("graphql"),
    id: z
      .string()
      .min(1)
      .regex(/^[^.]+\.[^.]+$/, "GraphQL fields must be identified as Type.field."),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("proto-symbol"),
    vendor: z.literal("proto"),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("migration"),
    vendor: z.enum(["drizzle", "prisma", "sql", "dbmate", "liquibase"]),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("db-object"),
    vendor: z.enum(["postgres", "mysql", "sqlite", "dynamodb"]),
  }),
  lifecycleObjectBaseSchema.extend({
    kind: z.literal("feature-flag"),
    vendor: z.enum(["launchdarkly", "statsig", "unleash", "config"]).optional(),
  }),
]);

export type LifecycleObjectId = z.infer<typeof lifecycleObjectIdSchema>;

export function formatLifecycleObjectId(object: LifecycleObjectId): string {
  const vendor = "vendor" in object && object.vendor ? `${object.vendor}:` : "";
  return `${object.kind}:${vendor}${object.id}`;
}

export function parseLifecycleObjectId(input: unknown): LifecycleObjectId {
  return lifecycleObjectIdSchema.parse(input);
}
