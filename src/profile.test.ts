import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStackProfile, doctorStackProfile, exportPolicy } from "./profile.ts";

describe("Conductor stack profile", () => {
  test("detects Bun and package script doctrine", () => {
    const root = join(tmpdir(), `conductor-profile-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "bun.lock"), "");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.3.13",
        scripts: { typecheck: "tsgo --noEmit", "lint:check": "oxlint" },
      }),
    );
    writeFileSync(join(root, "tsconfig.json"), "{}");
    const profile = detectStackProfile(root);
    expect(profile.packageManager?.preferred).toBe("bun");
    expect(profile.typecheck?.preferred).toBe("tsgo --noEmit");
    expect(profile.lint?.preferred).toBe("oxlint");
    expect(doctorStackProfile(profile).some((check) => check.status === "fail")).toBe(false);
    expect(exportPolicy(profile).commands).toEqual({
      typecheck: "tsgo --noEmit",
      lint: "oxlint",
      format: undefined,
    });
  });
});
