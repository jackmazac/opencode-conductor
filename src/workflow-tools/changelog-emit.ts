/**
 * `changelog_emit` — generate a structured markdown changelog from a plan's
 * wave summaries.
 *
 * The orchestrator convention is to call `progress_update({ plan_slug,
 * wave_id, status: "done", summary: "<commit hash>" })` after each completed
 * wave (per `orchestrator.txt:280+`). This tool walks those progress entries,
 * extracts commit SHAs from each `summary` field, runs `git log -1 --format`
 * to get the subject + body, and emits a markdown section the orchestrator
 * can paste into a release notes file, a PR description, or a status update.
 *
 * Read-only. Skips waves whose summary doesn't look like a commit SHA; those
 * are flagged in `unmatched_waves` so the orchestrator knows what was
 * skipped.
 */

import path from "node:path";
import { tool } from "@opencode-ai/plugin";

import { pathExists } from "../util/path-exists";
import { validateSlug } from "../util/slug";

const PLAN_SLUG_EXAMPLE = "auth-refactor, ugi-render-0.18-hardcutover";
// Match 7+ hex chars (short or full SHA). Anchored boundaries handled by extractSha.
const SHA_RE = /\b([0-9a-f]{7,40})\b/i;

export type ChangelogSpawnInput = {
  cmd: readonly string[];
  cwd: string;
};

export type ChangelogSubprocess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

export type ChangelogSpawnFn = (input: ChangelogSpawnInput) => ChangelogSubprocess;

let spawnOverride: ChangelogSpawnFn | undefined;

export function __test_setChangelogSpawn(fn: ChangelogSpawnFn | undefined): void {
  spawnOverride = fn;
}

function defaultSpawn(input: ChangelogSpawnInput): ChangelogSubprocess {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: proc.stdout, exited: proc.exited };
}

function runGit(input: ChangelogSpawnInput): ChangelogSubprocess {
  return (spawnOverride ?? defaultSpawn)(input);
}

type WaveData = {
  status: string;
  summary?: string | null;
  updated: string;
};

type ProgressData = {
  waves: Record<string, WaveData>;
};

type ResolvedCommit = {
  wave_id: string;
  sha: string;
  subject: string;
};

type UnmatchedWave = {
  wave_id: string;
  reason: string;
};

export const changelogEmit = tool({
  description:
    "Generate a markdown changelog section from a plan's completed waves. Walks `.opencode/progress/<plan_slug>.json`, extracts commit SHAs from each wave's `summary` field, runs `git log -1 --format='%h %s'` on each, and emits structured markdown with one line per wave. Skips waves whose summary doesn't look like a commit SHA; those appear under `unmatched_waves` in the response. Read-only.",
  args: {
    plan_slug: tool.schema
      .string()
      .describe(
        "Plan slug whose progress file to walk. Must match an entry in `.opencode/progress/`.",
      ),
    include_pending: tool.schema
      .boolean()
      .optional()
      .describe(
        "Include waves with status != 'done' in the output (default false — done-only).",
      ),
    title: tool.schema
      .string()
      .optional()
      .describe(
        "Optional H2 title for the rendered changelog. Defaults to `## Changelog — <plan_slug>`.",
      ),
  },
  async execute(args, context) {
    validateSlug(args.plan_slug, { example: PLAN_SLUG_EXAMPLE });
    const cwd = context.directory;
    const progressFile = path.join(cwd, ".opencode", "progress", `${args.plan_slug}.json`);
    if (!(await pathExists(progressFile))) {
      throw new Error(
        `changelog_emit: no progress file for plan_slug "${args.plan_slug}" at ${path.relative(cwd, progressFile)} — run progress_update first or check the slug.`,
      );
    }

    const raw: unknown = JSON.parse(await Bun.file(progressFile).text());
    if (!isProgressData(raw)) {
      throw new Error(
        `changelog_emit: progress file for "${args.plan_slug}" is malformed (missing 'waves' map)`,
      );
    }

    const waves = Object.entries(raw.waves);
    const resolved: ResolvedCommit[] = [];
    const unmatched: UnmatchedWave[] = [];

    for (const [waveId, wave] of waves) {
      if (!args.include_pending && wave.status !== "done") {
        unmatched.push({ wave_id: waveId, reason: `status is "${wave.status}", not "done"` });
        continue;
      }
      const summary = wave.summary;
      if (!summary) {
        unmatched.push({ wave_id: waveId, reason: "summary is empty" });
        continue;
      }
      const match = SHA_RE.exec(summary);
      if (!match) {
        unmatched.push({
          wave_id: waveId,
          reason: `summary "${summary.slice(0, 60)}" contains no commit-SHA-like substring`,
        });
        continue;
      }
      const sha = match[1]!;
      const subject = await readCommitSubject(cwd, sha);
      if (subject === null) {
        unmatched.push({
          wave_id: waveId,
          reason: `git log -1 ${sha} failed (commit not in workspace?)`,
        });
        continue;
      }
      resolved.push({ wave_id: waveId, sha, subject });
    }

    const title = args.title ?? `## Changelog — ${args.plan_slug}`;
    const lines = [title, ""];
    if (resolved.length === 0) {
      lines.push("_(no commits resolved from progress summaries)_");
    } else {
      for (const r of resolved) {
        lines.push(`- **${r.wave_id}** — \`${r.sha}\` ${r.subject}`);
      }
    }
    const markdown = lines.join("\n");

    return JSON.stringify(
      {
        plan_slug: args.plan_slug,
        resolved_count: resolved.length,
        unmatched_count: unmatched.length,
        resolved,
        unmatched_waves: unmatched,
        markdown,
      },
      null,
      2,
    );
  },
});

async function readCommitSubject(cwd: string, sha: string): Promise<string | null> {
  // git log -1 --format=%s <sha> — typed argv only, no shell.
  // The SHA is regex-validated as hex before reaching here, so it's safe to
  // pass as the final positional arg.
  try {
    const proc = runGit({ cmd: ["git", "log", "-1", "--format=%s", sha], cwd });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function isProgressData(value: unknown): value is ProgressData {
  if (!isRecord(value)) return false;
  if (!isRecord(value.waves)) return false;
  for (const w of Object.values(value.waves)) {
    if (!isRecord(w)) return false;
    if (typeof w.status !== "string") return false;
    if (typeof w.updated !== "string") return false;
    if (w.summary !== undefined && w.summary !== null && typeof w.summary !== "string") {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
