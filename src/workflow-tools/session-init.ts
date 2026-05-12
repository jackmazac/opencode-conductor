/**
 * `session_init` — one-call session rehydration.
 *
 * Replaces the 8-parallel-tool-call startup sequence the orchestrator prompt
 * lays out (`handoff_read` + `journal_read` + plan list + subplan list + audit
 * list + audit_progress list + progress list + status list). Returns a
 * structured envelope with handoff content (if present), recent journal
 * entries (with content, not just metadata), and metadata lists for the
 * remaining artifact kinds.
 *
 * Distinct from `artifact_index`:
 *   - `session_init` *resolves* — returns handoff content and journal entries
 *     so the orchestrator can resume immediately.
 *   - `artifact_index` *inventories* — metadata only, used for compaction or
 *     cleanup passes.
 *
 * Uses internal artifact-store reads directly, never shells out to other
 * plugin tools (per the AGENTS.md composite-tool invariant).
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { pathExists } from "../util/path-exists";
import { listRunFiles, readAllRuns } from "./run";

const JOURNAL_DEFAULT = 5;
const JOURNAL_MAX = 10;
const HANDOFF_CAP = 3000;

type JournalEntry = {
  ts: string;
  type: string;
  content: string;
};

type SluggedSummary = {
  slug: string;
  title?: string;
  mtime: string;
};

type SessionInitResult = {
  handoff: { exists: false } | { exists: true; mtime: string; content: string };
  journal: {
    exists: boolean;
    total: number;
    shown: number;
    entries: JournalEntry[];
  };
  plans: SluggedSummary[];
  subplans: SluggedSummary[];
  brainstorms: SluggedSummary[];
  designs: SluggedSummary[];
  audits: SluggedSummary[];
  audit_progress: SluggedSummary[];
  progress: SluggedSummary[];
  status: SluggedSummary[];
  active_runs: Array<{
    agent_run_id: string;
    status: string;
    plan_slug?: string;
    agent_type: string;
    updated_at: string;
  }>;
  summary: string;
};

export const sessionInit = tool({
  description:
    "Single-call session rehydration. Returns handoff content, recent journal entries, and metadata lists for every persisted artifact kind. Replaces the 8-parallel-tool-call startup sequence (`handoff_read` + `journal_read` + each artifact-store list). Call at session start instead of running each rehydration tool individually. For metadata-only inventory (no handoff content, no journal contents), use `artifact_index`.",
  args: {
    journal_n: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Number of recent journal entries to include with full content. Default 5, max 10. Older entries are counted but not returned.",
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const journalLimit = Math.min(
      Math.max(1, Math.floor(args.journal_n ?? JOURNAL_DEFAULT)),
      JOURNAL_MAX,
    );

    const [
      handoff,
      journal,
      plans,
      subplans,
      brainstorms,
      designs,
      audits,
      audit_progress,
      progress,
      status,
      runs,
      runFiles,
    ] = await Promise.all([
      readHandoff(cwd),
      readJournal(cwd, journalLimit),
      listSluggedMarkdown(cwd, "plans"),
      listSluggedMarkdown(cwd, "subplans"),
      listSluggedMarkdown(cwd, "brainstorms"),
      listSluggedMarkdown(cwd, "designs"),
      listSluggedMarkdown(cwd, "audits"),
      listSluggedJson(cwd, "audit-progress"),
      listSluggedJson(cwd, "progress"),
      listSluggedJson(cwd, "status"),
      readAllRuns(cwd),
      listRunFiles(cwd),
    ]);

    const activeRuns = runs
      .filter((r) => r.status === "initialized" || r.status === "in_progress" || r.status === "blocked")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => ({
        agent_run_id: r.agent_run_id,
        status: r.status,
        plan_slug: r.plan_slug,
        agent_type: r.agent_type,
        updated_at: r.updated_at,
      }));

    const result: SessionInitResult = {
      handoff,
      journal,
      plans,
      subplans,
      brainstorms,
      designs,
      audits,
      audit_progress,
      progress,
      status,
      active_runs: activeRuns,
      summary: buildSummary({
        handoff,
        plans: plans.length,
        audits: audits.length,
        progress: progress.length,
        activeRuns: activeRuns.length,
        runs: runFiles.length,
      }),
    };

    return JSON.stringify(result, null, 2);
  },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readHandoff(
  cwd: string,
): Promise<SessionInitResult["handoff"]> {
  const file = path.join(cwd, ".opencode", "handoff.md");
  if (!(await Bun.file(file).exists())) return { exists: false };
  const fileStat = await stat(file);
  const raw = await Bun.file(file).text();
  const content =
    raw.length <= HANDOFF_CAP
      ? raw
      : `${raw.slice(0, HANDOFF_CAP)}\n\n[truncated - ${raw.length - HANDOFF_CAP} chars omitted]`;
  return { exists: true, mtime: fileStat.mtime.toISOString(), content };
}

async function readJournal(
  cwd: string,
  limit: number,
): Promise<SessionInitResult["journal"]> {
  const file = path.join(cwd, ".opencode", "journal.jsonl");
  if (!(await Bun.file(file).exists())) {
    return { exists: false, total: 0, shown: 0, entries: [] };
  }
  const lines = (await Bun.file(file).text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const total = lines.length;
  const shown = Math.min(limit, total);
  const recent = lines.slice(-shown);
  const entries: JournalEntry[] = [];
  for (const line of recent) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJournalEntry(parsed)) entries.push(parsed);
    } catch {
      // skip malformed lines silently
    }
  }
  return { exists: true, total, shown: entries.length, entries };
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    typeof value.content === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function listSluggedMarkdown(cwd: string, folder: string): Promise<SluggedSummary[]> {
  const base = path.join(cwd, ".opencode", folder);
  if (!(await pathExists(base))) return [];
  const files = (await readdir(base)).filter((f) => f.endsWith(".md"));
  const entries = await Promise.all(
    files.map(async (f) => {
      const full = path.join(base, f);
      const fileStat = await stat(full);
      const text = await Bun.file(full).text();
      const title = extractTitle(text);
      return {
        slug: f.replace(/\.md$/, ""),
        title,
        mtime: fileStat.mtime.toISOString(),
      };
    }),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function listSluggedJson(cwd: string, folder: string): Promise<SluggedSummary[]> {
  const base = path.join(cwd, ".opencode", folder);
  if (!(await pathExists(base))) return [];
  const files = (await readdir(base)).filter((f) => f.endsWith(".json"));
  const entries = await Promise.all(
    files.map(async (f) => {
      const full = path.join(base, f);
      const fileStat = await stat(full);
      return {
        slug: f.replace(/\.json$/, ""),
        mtime: fileStat.mtime.toISOString(),
      };
    }),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

function extractTitle(markdown: string): string | undefined {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "));
  return line?.slice(2).trim() || undefined;
}

function buildSummary(input: {
  handoff: SessionInitResult["handoff"];
  plans: number;
  audits: number;
  progress: number;
  activeRuns: number;
  runs: number;
}): string {
  const parts: string[] = [];
  parts.push(input.handoff.exists ? `Resume from handoff (${input.handoff.mtime})` : "No handoff");
  parts.push(`${input.plans} plan${input.plans === 1 ? "" : "s"}`);
  parts.push(`${input.audits} audit${input.audits === 1 ? "" : "s"}`);
  parts.push(`${input.progress} progress file${input.progress === 1 ? "" : "s"}`);
  parts.push(`${input.activeRuns}/${input.runs} active run${input.runs === 1 ? "" : "s"}`);
  return parts.join("; ");
}
