import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlanArtifactStore, readPlanIndex } from "./plan-artifacts";

const subplans = createPlanArtifactStore({
  folder: "subplans",
  artifactName: "subplan",
  missingMessage: "no subplans",
  readCap: 3000,
});

const finalPlans = createPlanArtifactStore({
  folder: "plans",
  artifactName: "final plan",
  missingMessage: "no final plans",
  readCap: 3000,
});

const brainstorms = createPlanArtifactStore({
  folder: "brainstorms",
  artifactName: "brainstorm",
  missingMessage: "no brainstorms",
  readCap: 3000,
});

const designs = createPlanArtifactStore({
  folder: "designs",
  artifactName: "design",
  missingMessage: "no designs",
  readCap: 3000,
});

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "conductor-plan-artifacts-"));
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("plan artifact storage", () => {
  test("writes subplans and final plans to separate directories", async () => {
    const subplanResult = await subplans.write(directory, {
      slug: "api-refactor",
      content: "# API Refactor\n\nDraft plan",
    });
    const finalPlanResult = await finalPlans.write(directory, {
      slug: "api-refactor",
      content: "# API Refactor\n\nCanonical plan",
    });

    expect(subplanResult).toContain("file: .opencode/subplans/api-refactor.md");
    const finalPlanSummary = JSON.parse(finalPlanResult);
    expect(String(finalPlanSummary.plan_id).startsWith("pln_")).toBe(true);
    expect(finalPlanSummary.plan_slug).toBe("api-refactor");
    expect(finalPlanSummary.path).toBe(".opencode/plans/api-refactor.md");
    expect(
      await Bun.file(path.join(directory, ".opencode", "subplans", "api-refactor.md")).text(),
    ).toContain("Draft plan");
    expect(
      await Bun.file(path.join(directory, ".opencode", "plans", "api-refactor.md")).text(),
    ).toContain("Canonical plan");
  });

  test("indexes final plans with stable plan ids", async () => {
    const first = JSON.parse(
      await finalPlans.write(directory, {
        slug: "stable-plan",
        content: "# Stable Plan\n\nFirst version",
      }),
    );
    await finalPlans.write(directory, {
      slug: "stable-plan",
      content: "# Stable Plan\n\nSecond version",
    });
    const second = JSON.parse(
      await finalPlans.write(directory, {
        slug: "another-plan",
        content: "# Another Plan\n\nContent",
      }),
    );

    const index = await readPlanIndex(directory);

    expect(index.entries["stable-plan"]?.plan_id).toBe(first.plan_id);
    expect(typeof index.entries["stable-plan"]?.updated_at).toBe("string");
    expect(index.entries["another-plan"]?.plan_id).toBe(second.plan_id);
  });

  test("keeps created_at stable and advances updated_at on repersist", async () => {
    await finalPlans.write(directory, {
      slug: "timestamped-plan",
      content: "# Timestamped Plan\n\nFirst version",
    });
    const firstIndex = await readPlanIndex(directory);
    const firstEntry = firstIndex.entries["timestamped-plan"];
    if (!firstEntry) throw new Error("timestamped-plan was not indexed");

    await new Promise((resolve) => setTimeout(resolve, 2));
    await finalPlans.write(directory, {
      slug: "timestamped-plan",
      content: "# Timestamped Plan\n\nSecond version",
    });
    const secondIndex = await readPlanIndex(directory);
    const secondEntry = secondIndex.entries["timestamped-plan"];
    if (!secondEntry) throw new Error("timestamped-plan index entry disappeared");

    expect(secondEntry.plan_id).toBe(firstEntry.plan_id);
    expect(secondEntry.created_at).toBe(firstEntry.created_at);
    expect(Date.parse(secondEntry.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(firstEntry.updated_at),
    );
  });

  test("readPlanIndex tolerates missing and malformed index files", async () => {
    expect((await readPlanIndex(directory)).entries).toEqual({});

    const planDir = path.join(directory, ".opencode", "plans");
    await mkdir(planDir, { recursive: true });
    await Bun.write(path.join(planDir, "index.json"), "not json");

    expect((await readPlanIndex(directory)).entries).toEqual({});
  });

  test("discard removes final plan index entries", async () => {
    await finalPlans.write(directory, {
      slug: "discarded-plan",
      content: "# Discarded Plan\n\nBody",
    });

    await finalPlans.discard(directory, { slug: "discarded-plan" });

    expect((await readPlanIndex(directory)).entries["discarded-plan"]).toBeUndefined();
  });

  test("discard all final plans removes the sidecar index", async () => {
    await finalPlans.write(directory, {
      slug: "discard-all-one",
      content: "# One\n",
    });
    await finalPlans.write(directory, {
      slug: "discard-all-two",
      content: "# Two\n",
    });

    await finalPlans.discard(directory, {});

    expect((await readPlanIndex(directory)).entries).toEqual({});
    expect(await Bun.file(path.join(directory, ".opencode", "plans", "index.json")).exists()).toBe(
      false,
    );
  });

  test("subplan writes do not create a final-plan sidecar index", async () => {
    await subplans.write(directory, {
      slug: "draft-only",
      content: "# Draft Only\n\nBody",
    });

    expect(await Bun.file(path.join(directory, ".opencode", "plans", "index.json")).exists()).toBe(
      false,
    );
  });

  test("reads final plans by plan_id", async () => {
    const persisted = JSON.parse(
      await finalPlans.write(directory, {
        slug: "lookup-plan",
        content: "# Lookup Plan\n\n## Target\nSelected content\n\n## Other\nIgnored",
      }),
    );

    const result = await finalPlans.read(directory, {
      plan_id: persisted.plan_id,
      section: "Target",
    });

    expect(result).toContain("## Target\nSelected content");
    expect(result).not.toContain("## Other");
  });

  test("reports missing plan_id lookups", async () => {
    const result = await finalPlans.read(directory, {
      plan_id: "pln_01HZ0000000000000000000000",
    });

    expect(result).toContain("no final plan file for plan_id pln_01HZ0000000000000000000000");
  });

  test("rejects invalid slugs before writing", async () => {
    await expect(
      subplans.write(directory, {
        slug: "Invalid Slug",
        content: "# Invalid\n",
      }),
    ).rejects.toThrow('invalid slug "Invalid Slug"');

    expect(
      await Bun.file(path.join(directory, ".opencode", "subplans", "Invalid Slug.md")).exists(),
    ).toBe(false);
  });

  test("accepts versioned slugs", async () => {
    await finalPlans.write(directory, {
      slug: "ugi-render-0.18-hardcutover",
      content: "# Versioned Plan\n",
    });

    expect(
      await Bun.file(
        path.join(directory, ".opencode", "plans", "ugi-render-0.18-hardcutover.md"),
      ).exists(),
    ).toBe(true);
  });

  test("validates final plan write args before writing", async () => {
    await expect(finalPlans.write(directory, undefined)).rejects.toThrow(
      "final plan write args must be an object",
    );
    await expect(finalPlans.write(directory, { slug: "missing-content" })).rejects.toThrow(
      'final plan write arg "content" must be a string',
    );

    expect(
      await Bun.file(path.join(directory, ".opencode", "plans", "missing-content.md")).exists(),
    ).toBe(false);
  });

  test("lists subplans and final plans without mixing stores", async () => {
    await subplans.write(directory, {
      slug: "draft-one",
      content: "# Draft One\n\nPlanner notes",
    });
    await finalPlans.write(directory, {
      slug: "final-one",
      content: "# Final One\n\nApproved plan",
    });

    const subplanList = await subplans.read(directory, {});
    const finalPlanList = await finalPlans.read(directory, {});

    expect(subplanList).toContain("draft-one | Draft One");
    expect(subplanList).not.toContain("final-one");
    expect(finalPlanList).toContain("final-one | Final One");
    expect(finalPlanList).not.toContain("draft-one");
  });
});

describe("brainstorm and design artifact storage", () => {
  test("writes brainstorms and designs to separate directories without index sidecars", async () => {
    const brainstormResult = await brainstorms.write(directory, {
      slug: "auth-options",
      content: "# Auth options\n\n- Session\n- JWT\n- mTLS",
    });
    const designResult = await designs.write(directory, {
      slug: "design-system-v1",
      content: "# Design system v1\n\n## Colors\n\n## Typography",
    });

    expect(brainstormResult).toContain("file: .opencode/brainstorms/auth-options.md");
    expect(designResult).toContain("file: .opencode/designs/design-system-v1.md");
    expect(
      await Bun.file(path.join(directory, ".opencode", "brainstorms", "auth-options.md")).text(),
    ).toContain("Session");
    expect(
      await Bun.file(path.join(directory, ".opencode", "designs", "design-system-v1.md")).text(),
    ).toContain("Typography");

    expect(await Bun.file(path.join(directory, ".opencode", "brainstorms", "index.json")).exists())
      .toBe(false);
    expect(await Bun.file(path.join(directory, ".opencode", "designs", "index.json")).exists())
      .toBe(false);
  });

  test("rejects invalid slugs across new artifact kinds", async () => {
    await expect(
      brainstorms.write(directory, { slug: "Bad Slug", content: "# x\n" }),
    ).rejects.toThrow('invalid slug "Bad Slug"');
    await expect(
      designs.write(directory, { slug: "Bad Slug", content: "# x\n" }),
    ).rejects.toThrow('invalid slug "Bad Slug"');
  });

  test("validates write args for brainstorm and design before writing", async () => {
    await expect(brainstorms.write(directory, undefined)).rejects.toThrow(
      "brainstorm write args must be an object",
    );
    await expect(designs.write(directory, { slug: "missing" })).rejects.toThrow(
      'design write arg "content" must be a string',
    );
  });

  test("lists, reads sections, and discards brainstorms and designs without mixing kinds", async () => {
    await brainstorms.write(directory, {
      slug: "auth-options",
      content: [
        "# Auth options",
        "",
        "## Session",
        "Cookie-based.",
        "",
        "## JWT",
        "Stateless tokens.",
      ].join("\n"),
    });
    await designs.write(directory, {
      slug: "design-system-v1",
      content: "# Design system v1\n\n## Colors\n\nBlue, green",
    });

    const brainstormList = await brainstorms.read(directory, {});
    const designList = await designs.read(directory, {});
    expect(brainstormList).toContain("auth-options | Auth options");
    expect(brainstormList).not.toContain("design-system-v1");
    expect(designList).toContain("design-system-v1 | Design system v1");
    expect(designList).not.toContain("auth-options");

    const sectionRead = await brainstorms.read(directory, {
      slug: "auth-options",
      section: "JWT",
    });
    expect(sectionRead).toContain("Stateless tokens.");
    expect(sectionRead).not.toContain("Cookie-based.");

    const discardOne = await brainstorms.discard(directory, { slug: "auth-options" });
    expect(discardOne).toContain("removed brainstorm auth-options");
    expect(
      await Bun.file(path.join(directory, ".opencode", "brainstorms", "auth-options.md")).exists(),
    ).toBe(false);

    const discardAll = await designs.discard(directory, {});
    expect(discardAll).toContain("removed 1 design files");
  });

  test("missing brainstorm and design slugs report cleanly", async () => {
    expect(await brainstorms.read(directory, { slug: "ghost" })).toBe(
      "no brainstorm file for ghost",
    );
    expect(await designs.read(directory, { slug: "ghost" })).toBe("no design file for ghost");
    expect(await brainstorms.read(directory, {})).toBe("no brainstorms");
    expect(await designs.read(directory, {})).toBe("no designs");
  });
});

describe("section reads", () => {
  test("returns one heading section without leaking siblings", async () => {
    await finalPlans.write(directory, {
      slug: "section-test",
      content: [
        "# Main Plan",
        "",
        "Intro",
        "",
        "## Wave 1",
        "First line",
        "",
        "### Task 1",
        "Nested task",
        "",
        "## Wave 2",
        "Second line",
      ].join("\n"),
    });

    const result = await finalPlans.read(directory, {
      slug: "section-test",
      section: "Wave 1",
    });

    expect(result).toContain("## Wave 1\nFirst line\n\n### Task 1\nNested task");
    expect(result).not.toContain("## Wave 2");
  });

  test("handles regex metacharacters and repeated words in headings", async () => {
    await subplans.write(directory, {
      slug: "regex-heading",
      content: [
        "# Main Plan",
        "",
        "## API (v2) [draft] API",
        "Keep this section",
        "",
        "## API v2 draft API",
        "Do not include this sibling",
      ].join("\n"),
    });

    const result = await subplans.read(directory, {
      slug: "regex-heading",
      section: "API (v2) [draft] API",
    });

    expect(result).toContain("## API (v2) [draft] API\nKeep this section");
    expect(result).not.toContain("Do not include this sibling");
  });

  test("ignores heading-looking lines inside fenced code blocks", async () => {
    await finalPlans.write(directory, {
      slug: "fenced-heading",
      content: [
        "# Main Plan",
        "",
        "## Wave 1",
        "Before fence",
        "",
        "```markdown",
        "## Not a real heading",
        "fenced content",
        "```",
        "",
        "After fence",
        "",
        "## Wave 2",
        "Sibling section",
      ].join("\n"),
    });

    const result = await finalPlans.read(directory, {
      slug: "fenced-heading",
      section: "Wave 1",
    });

    expect(result).toContain("## Not a real heading");
    expect(result).toContain("After fence");
    expect(result).not.toContain("## Wave 2");
  });

  test("reports missing sections", async () => {
    await finalPlans.write(directory, {
      slug: "missing-section",
      content: "# Main Plan\n\n## Present\nText",
    });

    await expect(
      finalPlans.read(directory, { slug: "missing-section", section: "Absent" }),
    ).resolves.toContain('section "Absent" not found in missing-section');
  });
});
