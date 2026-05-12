import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { planValidate, validatePlanMarkdown } from "./plan-validate";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const validPlan = `# Example Plan

## Wave 1: First slice

**Thesis:** ship value

**Tasks:**

| Task | Owner |
|------|-------|
| a | me |

**Definition of Done:** tests pass

**Blast radius:** small

## Execution Summary

| Col | x |
|-----|---|
| y | z |

## Commit Strategy

One commit per wave.
`;

describe("validatePlanMarkdown", () => {
  test("valid plan produces no errors", () => {
    const findings = validatePlanMarkdown(validPlan);
    const errors = findings.filter((f) => f.severity === "error");
    expect(errors.length).toBe(0);
  });

  test("empty content reports missing plan title and waves", () => {
    const findings = validatePlanMarkdown("");
    const checks = findings.map((f) => f.check);
    expect(checks).toContain("has_plan_title");
    expect(checks).toContain("has_waves");
  });

  test("missing Plan heading in top-level title", () => {
    const findings = validatePlanMarkdown("# Quarterly roadmap\n\n## Wave 1: x\n\n**Thesis:** t\n\n**Tasks:**\n\n|a|\n|-|\n|b|\n\n**Definition of Done:** d\n\n**Blast radius:** r\n");
    expect(findings.some((f) => f.check === "has_plan_title")).toBe(true);
  });

  test("no wave sections", () => {
    const findings = validatePlanMarkdown("# My Plan\n\nNo waves here.\n");
    expect(findings.some((f) => f.check === "has_waves")).toBe(true);
  });

  test("wave missing Thesis", () => {
    const md = `# P Plan

## Wave 1: slice

**Tasks:**

| a |
|---|
| b |

**Definition of Done:** ok
**Blast radius:** low
`;
    const findings = validatePlanMarkdown(md);
    expect(findings.some((f) => f.check === "wave_has_thesis")).toBe(true);
  });

  test("wave missing Tasks", () => {
    const md = `# P Plan

## Wave 1: slice

**Thesis:** t

**Definition of Done:** ok
**Blast radius:** low
`;
    const findings = validatePlanMarkdown(md);
    expect(findings.some((f) => f.check === "wave_has_tasks")).toBe(true);
  });

  test("wave missing Definition of Done (warning)", () => {
    const md = `# P Plan

## Wave 1: slice

**Thesis:** t

**Tasks:**

| a |
|---|
| b |

**Blast radius:** low
`;
    const findings = validatePlanMarkdown(md);
    expect(findings.some((f) => f.check === "wave_has_definition_of_done")).toBe(true);
  });

  test("wave missing Blast radius (warning)", () => {
    const md = `# P Plan

## Wave 1: slice

**Thesis:** t

**Tasks:**

| a |
|---|
| b |

**Definition of Done:** ok
`;
    const findings = validatePlanMarkdown(md);
    expect(findings.some((f) => f.check === "wave_has_blast_radius")).toBe(true);
  });

  test("missing Execution Summary and Commit Strategy (warnings)", () => {
    const md = `# P Plan

## Wave 1: slice

**Thesis:** t

**Tasks:**

| a |
|---|
| b |

**Definition of Done:** ok

**Blast radius:** low
`;
    const findings = validatePlanMarkdown(md);
    expect(findings.some((f) => f.check === "has_execution_summary")).toBe(true);
    expect(findings.some((f) => f.check === "has_commit_strategy")).toBe(true);
  });
});

describe("plan_validate tool", () => {
  function toolResultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (typeof result === "object" && result !== null && "output" in result) {
      const out = Reflect.get(result, "output");
      if (typeof out === "string") return out;
    }
    throw new Error(`unexpected tool result shape: ${typeof result}`);
  }

  test("returns valid true for good plan", async () => {
    const out = toolResultText(
      await planValidate.execute(
        { content: validPlan },
        {
          sessionID: "s",
          messageID: "m",
          agent: "a",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata() {},
          ask() {
            return Effect.void;
          },
        },
      ),
    );
    const parsed: unknown = JSON.parse(out);
    if (!isRecord(parsed)) throw new Error("expected object");
    expect(parsed.valid).toBe(true);
  });
});
