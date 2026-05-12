/**
 * `artifact_index` — single read of the state of every persisted Conductor artifact.
 *
 * Inventory-focused. Returns metadata (slug, path, size, mtime, optional title)
 * for every kind of artifact under `.opencode/`. Distinct from `session_init`,
 * which is rehydration-focused and returns the *contents* of handoff + recent
 * journal entries.
 *
 * Use this tool before compaction (to know what's load-bearing), before a
 * `discard_*` cleanup pass (to know what exists), or when surveying project
 * state.
 *
 * Uses internal artifact-store reads directly — never shells out to other
 * plugin tools. Per the AGENTS.md invariant for composite tools.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { rel } from "../util/format";
import { pathExists } from "../util/path-exists";
import { listRunFiles } from "./run";

const ARTIFACT_KINDS = [
  "plans",
  "subplans",
  "brainstorms",
  "designs",
  "audits",
  "audit_progress",
  "progress",
  "runs",
  "status",
  "handoff",
  "journal",
] as const;

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

type SluggedEntry = {
  slug: string;
  path: string;
  size: number;
  mtime: string;
  title?: string;
};

type SingletonEntry =
  | { exists: false }
  | { exists: true; path: string; size: number; mtime: string };

type JournalEntry =
  | { exists: false }
  | { exists: true; path: string; entries: number; last_mtime: string };

type ArtifactIndexResult = {
  kinds: {
    plans?: SluggedEntry[];
    subplans?: SluggedEntry[];
    brainstorms?: SluggedEntry[];
    designs?: SluggedEntry[];
    audits?: SluggedEntry[];
    audit_progress?: SluggedEntry[];
    progress?: SluggedEntry[];
    runs?: Array<{ id: string; path: string; mtime: string }>;
    status?: SluggedEntry[];
    handoff?: SingletonEntry;
    journal?: JournalEntry;
  };
  summary: string;
};

export const artifactIndex = tool({
  description:
    "Return a single structured inventory of every persisted Conductor artifact (plans, subplans, brainstorms, designs, audits, progress, runs, status, handoff, journal). Metadata only — slug, path, size, mtime, optional title. Use before compaction, before `discard_*` passes, or to survey project state. For rehydration with actual content, use `session_init` instead.",
  args: {
    kinds: tool.schema
      .array(tool.schema.enum([...ARTIFACT_KINDS]))
      .optional()
      .describe(
        "Restrict to specific artifact kinds. Omit to list all kinds. Useful for partial surveys (e.g. just plans + audits).",
      ),
  },
  async execute(args, context) {
    const want = args.kinds ?? [...ARTIFACT_KINDS];
    const wantSet = new Set<ArtifactKind>(want);
    const cwd = context.directory;
    const result: ArtifactIndexResult = { kinds: {}, summary: "" };

    const collected: string[] = [];

    if (wantSet.has("plans")) {
      const entries = await listMarkdownArtifacts(cwd, "plans");
      result.kinds.plans = entries;
      collected.push(`plans: ${entries.length}`);
    }
    if (wantSet.has("subplans")) {
      const entries = await listMarkdownArtifacts(cwd, "subplans");
      result.kinds.subplans = entries;
      collected.push(`subplans: ${entries.length}`);
    }
    if (wantSet.has("brainstorms")) {
      const entries = await listMarkdownArtifacts(cwd, "brainstorms");
      result.kinds.brainstorms = entries;
      collected.push(`brainstorms: ${entries.length}`);
    }
    if (wantSet.has("designs")) {
      const entries = await listMarkdownArtifacts(cwd, "designs");
      result.kinds.designs = entries;
      collected.push(`designs: ${entries.length}`);
    }
    if (wantSet.has("audits")) {
      const entries = await listMarkdownArtifacts(cwd, "audits");
      result.kinds.audits = entries;
      collected.push(`audits: ${entries.length}`);
    }
    if (wantSet.has("audit_progress")) {
      const entries = await listJsonArtifacts(cwd, "audit-progress");
      result.kinds.audit_progress = entries;
      collected.push(`audit_progress: ${entries.length}`);
    }
    if (wantSet.has("progress")) {
      const entries = await listJsonArtifacts(cwd, "progress");
      result.kinds.progress = entries;
      collected.push(`progress: ${entries.length}`);
    }
    if (wantSet.has("runs")) {
      const entries = await listRunFiles(cwd);
      result.kinds.runs = entries;
      collected.push(`runs: ${entries.length}`);
    }
    if (wantSet.has("status")) {
      const entries = await listJsonArtifacts(cwd, "status");
      result.kinds.status = entries;
      collected.push(`status: ${entries.length}`);
    }
    if (wantSet.has("handoff")) {
      const entry = await singletonInfo(cwd, ".opencode/handoff.md");
      result.kinds.handoff = entry;
      collected.push(`handoff: ${entry.exists ? "present" : "missing"}`);
    }
    if (wantSet.has("journal")) {
      const entry = await journalInfo(cwd);
      result.kinds.journal = entry;
      collected.push(
        entry.exists ? `journal: ${entry.entries} entries` : "journal: missing",
      );
    }

    result.summary = `${want.length} kinds inspected — ${collected.join(", ")}`;
    return JSON.stringify(result, null, 2);
  },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function listMarkdownArtifacts(
  cwd: string,
  folder: string,
): Promise<SluggedEntry[]> {
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
        path: rel(cwd, full),
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
        title,
      };
    }),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function listJsonArtifacts(cwd: string, folder: string): Promise<SluggedEntry[]> {
  const base = path.join(cwd, ".opencode", folder);
  if (!(await pathExists(base))) return [];
  const files = (await readdir(base)).filter((f) => f.endsWith(".json"));
  const entries = await Promise.all(
    files.map(async (f) => {
      const full = path.join(base, f);
      const fileStat = await stat(full);
      return {
        slug: f.replace(/\.json$/, ""),
        path: rel(cwd, full),
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      };
    }),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function singletonInfo(cwd: string, relativePath: string): Promise<SingletonEntry> {
  const full = path.join(cwd, relativePath);
  if (!(await Bun.file(full).exists())) return { exists: false };
  const fileStat = await stat(full);
  return {
    exists: true,
    path: rel(cwd, full),
    size: fileStat.size,
    mtime: fileStat.mtime.toISOString(),
  };
}

async function journalInfo(cwd: string): Promise<JournalEntry> {
  const full = path.join(cwd, ".opencode", "journal.jsonl");
  if (!(await Bun.file(full).exists())) return { exists: false };
  const fileStat = await stat(full);
  const text = await Bun.file(full).text();
  const entries = text.split("\n").filter((line) => line.trim().length > 0).length;
  return {
    exists: true,
    path: rel(cwd, full),
    entries,
    last_mtime: fileStat.mtime.toISOString(),
  };
}

function extractTitle(markdown: string): string | undefined {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "));
  return line?.slice(2).trim() || undefined;
}
