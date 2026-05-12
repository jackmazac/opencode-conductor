/**
 * `plan_validate` — lint plan markdown for the structure documented in
 * `prompts/orchestrator.txt:232-254`.
 *
 * Advisory only: returns findings, does not throw. `persist_final_plan`
 * does not auto-call this; orchestrators invoke it before persisting when
 * they want a structural sanity check.
 */

import { tool } from "@opencode-ai/plugin";

type Severity = "error" | "warning";

type Finding = {
  check: string;
  severity: Severity;
  line?: number;
  message: string;
};

export const planValidate = tool({
  description:
    "Lint a plan markdown document against the Conductor plan structure (Plan title, Waves with Thesis / Tasks / Definition of Done / Blast radius, Execution Summary, Commit Strategy). Returns a JSON envelope of findings categorized as `error` (structural failures) or `warning` (missing recommended sections). Advisory — does not throw. Call before `persist_final_plan` when you want a sanity check.",
  args: {
    content: tool.schema.string().describe("Markdown content to validate."),
  },
  async execute(args) {
    const findings = validatePlanMarkdown(args.content);
    const counts = {
      error: findings.filter((f) => f.severity === "error").length,
      warning: findings.filter((f) => f.severity === "warning").length,
    };
    const valid = counts.error === 0;
    return JSON.stringify(
      {
        valid,
        findings,
        counts,
        summary: valid
          ? `Plan structure OK${counts.warning > 0 ? ` (${counts.warning} warning${counts.warning === 1 ? "" : "s"})` : ""}`
          : `Plan has ${counts.error} structural error${counts.error === 1 ? "" : "s"}${counts.warning > 0 ? ` and ${counts.warning} warning${counts.warning === 1 ? "" : "s"}` : ""}`,
      },
      null,
      2,
    );
  },
});

// ---------------------------------------------------------------------------
// Validation logic — pure function, exported for tests
// ---------------------------------------------------------------------------

export function validatePlanMarkdown(content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");

  // 1. Top-level plan heading
  const titleLineIdx = lines.findIndex((line) => /^#\s+.*\bPlan\b/i.test(line));
  if (titleLineIdx < 0) {
    findings.push({
      check: "has_plan_title",
      severity: "error",
      message: "missing top-level heading matching `# ... Plan`",
    });
  }

  // 2. Waves
  const waveLines = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => /^##\s+Wave\b/i.test(line));

  if (waveLines.length === 0) {
    findings.push({
      check: "has_waves",
      severity: "error",
      message: "missing `## Wave N: ...` sections (a plan must have at least one wave)",
    });
  } else {
    // For each wave, scan from its heading to the next heading or EOF.
    for (let i = 0; i < waveLines.length; i++) {
      const start = waveLines[i]!.idx;
      const end = i + 1 < waveLines.length ? waveLines[i + 1]!.idx : lines.length;
      const body = lines.slice(start, end);
      const waveLabel = lines[start]!.replace(/^##\s+/, "").trim();
      checkWaveBody(body, start + 1, waveLabel, findings);
    }
  }

  // 3. Execution Summary
  const hasExecSummary = lines.some((line) => /^##\s+Execution Summary/i.test(line));
  if (!hasExecSummary) {
    findings.push({
      check: "has_execution_summary",
      severity: "warning",
      message: "missing `## Execution Summary` section",
    });
  }

  // 4. Commit Strategy
  const hasCommitStrategy = lines.some((line) => /^##\s+Commit Strategy/i.test(line));
  if (!hasCommitStrategy) {
    findings.push({
      check: "has_commit_strategy",
      severity: "warning",
      message: "missing `## Commit Strategy` section",
    });
  }

  return findings;
}

function checkWaveBody(
  body: readonly string[],
  startLine: number,
  waveLabel: string,
  findings: Finding[],
): void {
  const text = body.join("\n");

  if (!/\*\*Thesis:\*\*|\*\*Thesis\*\*:/.test(text)) {
    findings.push({
      check: "wave_has_thesis",
      severity: "error",
      line: startLine,
      message: `wave "${waveLabel}" missing **Thesis:** line`,
    });
  }
  if (!/\*\*Tasks:\*\*|\*\*Tasks\*\*:/.test(text)) {
    findings.push({
      check: "wave_has_tasks",
      severity: "error",
      line: startLine,
      message: `wave "${waveLabel}" missing **Tasks:** section`,
    });
  }
  if (!/\*\*Definition of Done:\*\*|\*\*Definition of Done\*\*:/.test(text)) {
    findings.push({
      check: "wave_has_definition_of_done",
      severity: "warning",
      line: startLine,
      message: `wave "${waveLabel}" missing **Definition of Done:** section`,
    });
  }
  if (!/\*\*Blast radius:\*\*|\*\*Blast radius\*\*:/i.test(text)) {
    findings.push({
      check: "wave_has_blast_radius",
      severity: "warning",
      line: startLine,
      message: `wave "${waveLabel}" missing **Blast radius:** section`,
    });
  }
}
