import { describe, expect, test } from "bun:test";
import { lifecycleConfigSchema } from "./config.ts";

describe("lifecycleConfigSchema", () => {
  test("applies safe defaults", () => {
    const config = lifecycleConfigSchema.parse({});
    expect(config.version).toBe(1);
    expect(config.modules.origin.mode).toBe("warn");
    expect(config.modules.torch.enabled).toBe(false);
    expect(config.external_sources.concord.enabled).toBe(true);
  });

  test("rejects unknown config keys", () => {
    expect(() => lifecycleConfigSchema.parse({ unknown: true })).toThrow();
  });
});
