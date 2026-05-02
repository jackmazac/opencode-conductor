import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPlanArtifactStore } from "./plan-artifacts"

const subplans = createPlanArtifactStore({
  folder: "subplans",
  artifactName: "subplan",
  missingMessage: "no subplans",
  readCap: 3000,
})

const finalPlans = createPlanArtifactStore({
  folder: "plans",
  artifactName: "final plan",
  missingMessage: "no final plans",
  readCap: 3000,
})

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "conductor-plan-artifacts-"))
})

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe("plan artifact storage", () => {
  test("writes subplans and final plans to separate directories", async () => {
    const subplanResult = await subplans.write(directory, {
      slug: "api-refactor",
      content: "# API Refactor\n\nDraft plan",
    })
    const finalPlanResult = await finalPlans.write(directory, {
      slug: "api-refactor",
      content: "# API Refactor\n\nCanonical plan",
    })

    expect(subplanResult).toContain("file: .opencode/subplans/api-refactor.md")
    expect(finalPlanResult).toContain("file: .opencode/plans/api-refactor.md")
    expect(await Bun.file(path.join(directory, ".opencode", "subplans", "api-refactor.md")).text()).toContain(
      "Draft plan",
    )
    expect(await Bun.file(path.join(directory, ".opencode", "plans", "api-refactor.md")).text()).toContain(
      "Canonical plan",
    )
  })

  test("rejects invalid slugs before writing", async () => {
    await expect(
      subplans.write(directory, {
        slug: "Invalid Slug",
        content: "# Invalid\n",
      }),
    ).rejects.toThrow('invalid slug "Invalid Slug"')

    expect(await Bun.file(path.join(directory, ".opencode", "subplans", "Invalid Slug.md")).exists()).toBe(false)
  })

  test("lists subplans and final plans without mixing stores", async () => {
    await subplans.write(directory, {
      slug: "draft-one",
      content: "# Draft One\n\nPlanner notes",
    })
    await finalPlans.write(directory, {
      slug: "final-one",
      content: "# Final One\n\nApproved plan",
    })

    const subplanList = await subplans.read(directory, {})
    const finalPlanList = await finalPlans.read(directory, {})

    expect(subplanList).toContain("draft-one | Draft One")
    expect(subplanList).not.toContain("final-one")
    expect(finalPlanList).toContain("final-one | Final One")
    expect(finalPlanList).not.toContain("draft-one")
  })
})

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
    })

    const result = await finalPlans.read(directory, {
      slug: "section-test",
      section: "Wave 1",
    })

    expect(result).toContain("## Wave 1\nFirst line\n\n### Task 1\nNested task")
    expect(result).not.toContain("## Wave 2")
  })

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
    })

    const result = await subplans.read(directory, {
      slug: "regex-heading",
      section: "API (v2) [draft] API",
    })

    expect(result).toContain("## API (v2) [draft] API\nKeep this section")
    expect(result).not.toContain("Do not include this sibling")
  })

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
    })

    const result = await finalPlans.read(directory, {
      slug: "fenced-heading",
      section: "Wave 1",
    })

    expect(result).toContain("## Not a real heading")
    expect(result).toContain("After fence")
    expect(result).not.toContain("## Wave 2")
  })

  test("reports missing sections", async () => {
    await finalPlans.write(directory, {
      slug: "missing-section",
      content: "# Main Plan\n\n## Present\nText",
    })

    await expect(finalPlans.read(directory, { slug: "missing-section", section: "Absent" })).resolves.toContain(
      'section "Absent" not found in missing-section',
    )
  })
})
