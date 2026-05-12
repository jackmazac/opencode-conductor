import path from "node:path";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { rel } from "../util/format";
import { pathExists } from "../util/path-exists";
import { validateSlug } from "../util/slug";

const STATUS_SLUG_EXAMPLE = "api-routes, db-schema-0.18";
const READ_LIMIT = 10;
const READ_FIELD_CAP = 240;
const READ_LIST_ITEM_CAP = 160;
const READ_LIST_ITEM_LIMIT = 8;

type Status = {
  slug: string;
  goal?: string;
  plan?: string;
  wave?: string;
  current?: string;
  completed: string[];
  pending: string[];
  blockers: string[];
  touched_files: string[];
  updated: string;
};

function dir(directory: string): string {
  return path.join(directory, ".opencode", "status");
}

function target(directory: string, slug: string): string {
  return path.join(dir(directory), `${slug}.json`);
}

function legacyTarget(directory: string, slug: string): string {
  return path.join(dir(directory), `${slug}.md`);
}

function compact(text: string | undefined, limit = READ_FIELD_CAP): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function renderList(items: string[]): string {
  const shown = items
    .slice(0, READ_LIST_ITEM_LIMIT)
    .map((item) => compact(item, READ_LIST_ITEM_CAP) || "");
  const omitted = items.length - shown.length;
  return `${shown.join("; ") || "none"}${omitted > 0 ? `; ... (${omitted} omitted)` : ""}`;
}

function emptyStatus(slug: string): Status {
  return {
    slug,
    completed: [],
    pending: [],
    blockers: [],
    touched_files: [],
    updated: new Date().toISOString(),
  };
}

async function loadStatus(directory: string, slug: string): Promise<Status> {
  const dest = target(directory, slug);
  if (!(await Bun.file(dest).exists())) return emptyStatus(slug);
  return { ...emptyStatus(slug), ...JSON.parse(await Bun.file(dest).text()) };
}

function render(status: Status, file?: string): string {
  const lines = [
    ...(file ? [`File: ${file}`] : []),
    `Last updated: ${status.updated}`,
    `Goal: ${compact(status.goal) || "(not set)"}`,
    `Plan: ${compact(status.plan, 80) || "(none)"}${status.wave ? ` | Wave: ${compact(status.wave, 80)}` : ""}`,
    `Current: ${compact(status.current, 180) || "(not set)"}`,
    `Completed (${status.completed.length}): ${renderList(status.completed)}`,
    `Pending (${status.pending.length}): ${renderList(status.pending)}`,
    `Blockers (${status.blockers.length}): ${renderList(status.blockers)}`,
    `Touched files (${status.touched_files.length}): ${renderList(status.touched_files)}`,
  ];
  return lines.join("\n");
}

export const write = tool({
  description:
    "Write or update compact executor status. Use small structured fields, not markdown transcripts. Omit unchanged fields; arrays replace prior arrays. Intended for resumability only.",
  args: {
    slug: tool.schema
      .string()
      .describe("Task slug: 2-4 lowercase hyphenated words identifying this task"),
    goal: tool.schema.string().optional().describe("One-sentence goal"),
    plan: tool.schema.string().optional().describe("Plan slug, if any"),
    wave: tool.schema.string().optional().describe("Wave or task id, if any"),
    current: tool.schema.string().optional().describe("Current activity"),
    completed: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Completed task labels; displayed compactly on read"),
    pending: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Pending task labels; displayed compactly on read"),
    blockers: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Active blockers; displayed compactly on read"),
    touched_files: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Relevant file paths touched or owned; displayed compactly on read"),
  },
  async execute(args, context) {
    validateSlug(args.slug, { example: STATUS_SLUG_EXAMPLE });
    const existing = await loadStatus(context.directory, args.slug);
    const next: Status = {
      ...existing,
      goal: args.goal ?? existing.goal,
      plan: args.plan ?? existing.plan,
      wave: args.wave ?? existing.wave,
      current: args.current ?? existing.current,
      completed: args.completed ?? existing.completed,
      pending: args.pending ?? existing.pending,
      blockers: args.blockers ?? existing.blockers,
      touched_files: args.touched_files ?? existing.touched_files,
      updated: new Date().toISOString(),
    };
    await mkdir(dir(context.directory), { recursive: true });
    const dest = target(context.directory, args.slug);
    const tmp = `${dest}.tmp`;
    await Bun.write(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, dest);
    return `status updated: ${args.slug} (${next.completed.length} done, ${next.pending.length} pending, ${next.blockers.length} blockers)\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read compact executor status. Call with no slug to list up to 10 active status files. Call with a slug to read that compact status only.",
  args: {
    slug: tool.schema
      .string()
      .optional()
      .describe("Task slug to read. Omit to list active status files with compact summaries."),
  },
  async execute(args, context) {
    const base = dir(context.directory);
    if (args.slug) {
      validateSlug(args.slug, { example: STATUS_SLUG_EXAMPLE });
      const dest = target(context.directory, args.slug);
      if (!(await Bun.file(dest).exists())) return `no status file for ${args.slug}`;
      return render(JSON.parse(await Bun.file(dest).text()), rel(context.directory, dest));
    }
    if (!(await pathExists(base))) return "no status files";
    const rawEntries = (await readdir(base)).filter((f) => f.endsWith(".json"));
    if (rawEntries.length === 0) return "no status files";
    const entries = await Promise.all(
      rawEntries.map(async (file) => {
        const full = path.join(base, file);
        const fileStat = await stat(full);
        return { file, mtime: fileStat.mtimeMs };
      }),
    );
    entries.sort((a, b) => b.mtime - a.mtime);
    const shown = entries.slice(0, READ_LIMIT);
    const lines = await Promise.all(
      shown.map(async ({ file }) => {
        const full = path.join(base, file);
        const status: Status = JSON.parse(await Bun.file(full).text());
        return `${status.slug} | ${status.current || "(no current task)"} | ${status.completed.length}/${status.completed.length + status.pending.length} done | updated ${status.updated} | file ${rel(context.directory, full)}`;
      }),
    );
    const omitted = entries.length - shown.length;
    return `${entries.length} active status file${entries.length === 1 ? "" : "s"}${omitted > 0 ? ` (showing newest ${READ_LIMIT}, ${omitted} omitted)` : ""}\n${lines.join("\n")}`;
  },
});

export const done = tool({
  description:
    "Remove completed status. Call with a slug to remove one executor status. Call WITHOUT a slug to remove ALL status files — orchestrator final cleanup only.",
  args: {
    slug: tool.schema
      .string()
      .optional()
      .describe("Task slug to remove. Omit to remove ALL status files (orchestrator-only)."),
  },
  async execute(args, context) {
    const base = dir(context.directory);
    if (args.slug) {
      validateSlug(args.slug, { example: STATUS_SLUG_EXAMPLE });
      const dest = target(context.directory, args.slug);
      const legacy = legacyTarget(context.directory, args.slug);
      const removed: string[] = [];
      if (await Bun.file(dest).exists()) {
        await Bun.file(dest).delete();
        removed.push(rel(context.directory, dest));
      }
      if (await Bun.file(legacy).exists()) {
        await Bun.file(legacy).delete();
        removed.push(rel(context.directory, legacy));
      }
      return removed.length
        ? `removed ${args.slug}\nfiles:\n${removed.join("\n")}`
        : `no status file for ${args.slug}`;
    }
    if (!(await pathExists(base))) return "no status files to clean";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".json") || f.endsWith(".md"));
    if (entries.length === 0) return "no status files to clean";
    const files = entries.map((f) => path.join(base, f));
    await Promise.all(files.map((file) => Bun.file(file).delete()));
    try {
      if ((await readdir(base)).length === 0) await rmdir(base);
    } catch {
      // ignore — directory deletion is best-effort
    }
    return `removed ${entries.length} status files\nfiles:\n${files.map((file) => rel(context.directory, file)).join("\n")}`;
  },
});

/** Exposed for composite tools (artifact_index, drift_check, session_init). */
export async function listStatusSlugs(directory: string): Promise<string[]> {
  const base = dir(directory);
  if (!(await pathExists(base))) return [];
  return (await readdir(base))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
