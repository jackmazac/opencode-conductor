import { z } from "zod";

export const lifecycleModuleSchema = z.enum(["origin", "seal", "portage", "torch"]);
export type LifecycleModule = z.infer<typeof lifecycleModuleSchema>;

export const lifecycleModeSchema = z.enum(["observe", "warn", "block"]);
export type LifecycleMode = z.infer<typeof lifecycleModeSchema>;

export const lifecycleModuleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: lifecycleModeSchema.default("warn"),
    source_roots: z.array(z.string().min(1)).default([]),
    artifact_kinds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type LifecycleModuleConfig = z.infer<typeof lifecycleModuleConfigSchema>;

const defaultModuleConfig: LifecycleModuleConfig = {
  enabled: true,
  mode: "warn",
  source_roots: [],
  artifact_kinds: [],
};

const defaultTorchConfig: LifecycleModuleConfig = {
  ...defaultModuleConfig,
  enabled: false,
  mode: "observe",
};

export const concordExternalSourceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    protocol_version: z.string().min(1).optional(),
    schema_version: z.string().min(1).optional(),
  })
  .strict();

export type ConcordExternalSourceConfig = z.infer<typeof concordExternalSourceConfigSchema>;

const defaultConcordConfig: ConcordExternalSourceConfig = {
  enabled: true,
};

export const lifecycleConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    artifacts_dir: z.string().min(1).default(".opencode/lifecycle/artifacts"),
    modules: z
      .object({
        origin: lifecycleModuleConfigSchema.default(defaultModuleConfig),
        seal: lifecycleModuleConfigSchema.default(defaultModuleConfig),
        portage: lifecycleModuleConfigSchema.default(defaultModuleConfig),
        torch: lifecycleModuleConfigSchema.default(defaultTorchConfig),
      })
      .strict()
      .default({
        origin: defaultModuleConfig,
        seal: defaultModuleConfig,
        portage: defaultModuleConfig,
        torch: defaultTorchConfig,
      }),
    external_sources: z
      .object({
        concord: concordExternalSourceConfigSchema.default(defaultConcordConfig),
      })
      .strict()
      .default({ concord: defaultConcordConfig }),
  })
  .strict();

export type LifecycleConfig = z.infer<typeof lifecycleConfigSchema>;

export function parseLifecycleConfig(input: unknown): LifecycleConfig {
  return lifecycleConfigSchema.parse(input);
}
