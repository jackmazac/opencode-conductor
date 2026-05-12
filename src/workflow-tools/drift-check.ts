/**
 * `drift_check` — surface inconsistencies between persisted Conductor artifacts.
 *
 * Examples of drift caught here:
 *   - Progress files for plans that no longer exist
 *   - Audit-progress files for audits that no longer exist
 *   - Active runs referencing plans not in the plan index
 *   - Status files older than their corresponding run's finished_at
 *
 * Findings are categorized by severity:
 *   - error:   a downstream tool will fail (e.g. progress_update for a deleted plan)
 *   - warning: probable orphan or stale reference, but no hard failure
 *   - info:    expected but worth knowing (e.g. plan persisted, not yet started)
 *
 * Uses internal artifact-store reads, never shells out to other plugin tools.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { pathExists } from "../util/path-exists";
import { readAllRuns } from "./run";

type Severity = "error" | "warning" | "info";

type Finding = {
  kind: string;
  severity: Severity;
  message: string;
  suggested_fix?: string;
};

export const driftCheck = tool({
  description:
    "Inspect persisted Conductor artifacts for inconsistencies — orphaned progress files, runs referencing non-existent plans, stale status files, and similar drift. Returns a JSON envelope of findings categorized by severity (`error`, `warning`, `info`). Call at session resume or before a `discard_*` cleanup pass. Severity `error` indicates a downstream tool will fail; `warning` flags probable orphans; `info` notes expected-but-worth-knowing states.",
  args: {},
  async execute(_args, context) {
    const cwd = context.directory;
    const findings: Finding[] = [];

    const [plans, subplans, audits, progressSlugs, auditProgressSlugs, statusFiles, runs] =
      await Promise.all([
        listFilenames(cwd, "plans", ".md"),
        listFilenames(cwd, "subplans", ".md"),
        listFilenames(cwd, "audits", ".md"),
        listFilenames(cwd, "progress", ".json"),
        listFilenames(cwd, "audit-progress", ".json"),
        listFilenameStats(cwd, "status", ".json"),
        readAllRuns(cwd),
      ]);

    const planSlugs = new Set(plans);
    const auditSlugs = new Set(audits);

    // 1. Progress without plan → error (progress_update will fail)
    for (const slug of progressSlugs) {
      if (!planSlugs.has(slug)) {
        findings.push({
          kind: "progress_without_plan",
          severity: "error",
          message: `progress/${slug}.json exists but no plans/${slug}.md`,
          suggested_fix: `Run progress_done(plan_slug: "${slug}") to remove the orphan, or persist the plan.`,
        });
      }
    }

    // 2. Plan without progress → info (may be pre-execution)
    for (const slug of plans) {
      if (!progressSlugs.includes(slug)) {
        findings.push({
          kind: "plan_without_progress",
          severity: "info",
          message: `plans/${slug}.md exists but no progress/${slug}.json — plan may be pre-execution or already complete`,
        });
      }
    }

    // 3. Audit progress without audit → error
    for (const slug of auditProgressSlugs) {
      if (!auditSlugs.has(slug)) {
        findings.push({
          kind: "audit_progress_without_audit",
          severity: "error",
          message: `audit-progress/${slug}.json exists but no audits/${slug}.md`,
          suggested_fix: `Run audit_progress_done(audit_slug: "${slug}") to remove the orphan, or persist the audit.`,
        });
      }
    }

    // 4. Active run referencing non-existent plan → warning
    for (const run of runs) {
      if (run.status !== "initialized" && run.status !== "in_progress" && run.status !== "blocked") {
        continue;
      }
      if (run.plan_slug && !planSlugs.has(run.plan_slug)) {
        findings.push({
          kind: "run_references_missing_plan",
          severity: "warning",
          message: `run ${run.agent_run_id} (${run.status}) references plan_slug "${run.plan_slug}" which is not persisted`,
          suggested_fix: `Confirm the plan slug is correct, or finalize the run via run_finish if it's stale.`,
        });
      }
    }

    // 5. Stale status: status file older than its corresponding run's finished_at
    const finishedRunStatuses = new Map<string, string>();
    for (const run of runs) {
      if (run.finished_at && run.status === "done") {
        finishedRunStatuses.set(statusSlugFromRunId(run.agent_run_id), run.finished_at);
      }
    }
    for (const status of statusFiles) {
      const finishedAt = finishedRunStatuses.get(status.slug);
      if (finishedAt && status.mtime < finishedAt) {
        findings.push({
          kind: "status_older_than_run_finish",
          severity: "warning",
          message: `status/${status.slug}.json is older than its run's finished_at — likely stale`,
          suggested_fix: `Run status_done(slug: "${status.slug}") to remove the stale mirror.`,
        });
      }
    }

    // 6. Subplan with no final plan persisted at all (orphan drafts) → warning
    if (subplans.length > 0 && plans.length === 0) {
      findings.push({
        kind: "subplans_without_any_final_plan",
        severity: "warning",
        message: `${subplans.length} subplan draft(s) persisted but no final plan exists — synthesis may not have completed`,
      });
    }

    const counts = countSeverities(findings);
    return JSON.stringify(
      {
        findings,
        summary: `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
        counts,
      },
      null,
      2,
    );
  },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function listFilenames(cwd: string, folder: string, ext: string): Promise<string[]> {
  const base = path.join(cwd, ".opencode", folder);
  if (!(await pathExists(base))) return [];
  return (await readdir(base))
    .filter((f) => f.endsWith(ext))
    .map((f) => f.replace(new RegExp(`\\${ext}$`), ""))
    .sort();
}

async function listFilenameStats(
  cwd: string,
  folder: string,
  ext: string,
): Promise<Array<{ slug: string; mtime: string }>> {
  const base = path.join(cwd, ".opencode", folder);
  if (!(await pathExists(base))) return [];
  const files = (await readdir(base)).filter((f) => f.endsWith(ext));
  return Promise.all(
    files.map(async (f) => ({
      slug: f.replace(new RegExp(`\\${ext}$`), ""),
      mtime: (await stat(path.join(base, f))).mtime.toISOString(),
    })),
  );
}

/**
 * The status mirror written by `writeRun` uses slug = `run-${id.slice(4, 16)}`.
 * Mirror that here so we can correlate status files back to runs.
 */
function statusSlugFromRunId(agentRunId: string): string {
  return `run-${agentRunId.slice(4, 16)}`;
}

function countSeverities(findings: readonly Finding[]): {
  error: number;
  warning: number;
  info: number;
} {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
