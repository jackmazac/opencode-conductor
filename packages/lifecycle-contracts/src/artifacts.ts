import { createHash } from "node:crypto";
import { z } from "zod";

export const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Expected sha256:<64 lowercase hex chars>");

export type ContentHash = z.infer<typeof contentHashSchema>;

export const lifecycleArtifactKindSchema = z.enum([
  "api-snapshot",
  "generated-source-map",
  "schema-snapshot",
  "migration-finding",
  "flag-inventory",
  "concord-collision",
  "concord-guidance",
  "decision-evidence",
]);

export type LifecycleArtifactKind = z.infer<typeof lifecycleArtifactKindSchema>;

export const lifecycleArtifactRefSchema = z
  .object({
    artifact_id: z.string().min(1),
    kind: lifecycleArtifactKindSchema,
    hash: contentHashSchema,
    uri: z.string().min(1).optional(),
    size_bytes: z.number().int().nonnegative().optional(),
    created_at: z.number().int().nonnegative().optional(),
  })
  .strict();

export type LifecycleArtifactRef = z.infer<typeof lifecycleArtifactRefSchema>;

export function sha256ContentHash(content: string | Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function createArtifactRef(args: {
  kind: LifecycleArtifactKind;
  content: string | Uint8Array;
  artifactId?: string;
  uri?: string;
  createdAt?: number;
}): LifecycleArtifactRef {
  const hash = sha256ContentHash(args.content);
  return lifecycleArtifactRefSchema.parse({
    artifact_id: args.artifactId ?? hash,
    kind: args.kind,
    hash,
    uri: args.uri,
    size_bytes:
      typeof args.content === "string" ? Buffer.byteLength(args.content) : args.content.byteLength,
    created_at: args.createdAt,
  });
}
