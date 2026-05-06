import { tool } from "@opencode-ai/plugin";
import path from "path";
import { mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";

const SLUG_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const STATUSES = ["pending", "in-progress", "done"];

type Wave = {
  status: string;
  summary?: string | null;
  updated: string;
};

type ProgressData = {
  waves: Record<string, Wave>;
};

function validate(slug: string) {
  if (slug.length > 64 || !SLUG_RE.test(slug))
    throw new Error(
      `invalid slug "${slug}" — use lowercase words separated by hyphens or dots (e.g. auth-refactor, ugi-render-0.18-hardcutover)`,
    );
}

function dir(directory: string) {
  return path.join(directory, ".opencode", "progress");
}

function target(directory: string, slug: string) {
  return path.join(dir(directory), `${slug}.json`);
}

function rel(directory: string, file: string) {
  return path.relative(directory, file);
}

export const update = tool({
  description:
    "Update wave-level progress for a persisted plan. Call after each wave completes or starts. Tracks per-wave state (pending/in-progress/done) with optional summary and commit reference.",
  args: {
    plan_slug: tool.schema.string().describe("Plan slug this progress tracks"),
    wave_id: tool.schema.string().describe("Wave identifier (e.g. W1, W2)"),
    status: tool.schema.string().describe("Wave status: pending | in-progress | done"),
    summary: tool.schema
      .string()
      .optional()
      .describe("Brief summary of wave state (e.g. '3/5 tasks done', commit hash)"),
  },
  async execute(args, context) {
    validate(args.plan_slug);
    if (!STATUSES.includes(args.status))
      throw new Error(`invalid status "${args.status}" — use: ${STATUSES.join(", ")}`);
    const dest = target(context.directory, args.plan_slug);
    await mkdir(dir(context.directory), { recursive: true });
    const existing: ProgressData = fs.existsSync(dest)
      ? JSON.parse(await Bun.file(dest).text())
      : { waves: {} };
    existing.waves[args.wave_id] = {
      status: args.status,
      summary: args.summary || null,
      updated: new Date().toISOString(),
    };
    const tmp = `${dest}.tmp`;
    await Bun.write(tmp, JSON.stringify(existing, null, 2));
    fs.renameSync(tmp, dest);
    return `progress: ${args.plan_slug} ${args.wave_id} → ${args.status}\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read wave-level progress. Call with a plan slug to see waves for that plan (last 10). Call without a slug to list all plans with progress summaries.",
  args: {
    plan_slug: tool.schema
      .string()
      .optional()
      .describe("Plan slug to read. Omit to list all plans with progress."),
  },
  async execute(args, context) {
    if (args.plan_slug) {
      validate(args.plan_slug);
      const dest = target(context.directory, args.plan_slug);
      if (!fs.existsSync(dest)) return `no progress for ${args.plan_slug}`;
      const data: ProgressData = JSON.parse(await Bun.file(dest).text());
      const all = Object.entries(data.waves);
      const skipped = Math.max(0, all.length - 10);
      const shown = all.slice(-10);
      const completed = all.filter(([, w]) => w.status === "done").length;
      const header = `File: ${rel(context.directory, dest)}\n${args.plan_slug}: ${completed}/${all.length} waves done${skipped > 0 ? ` (showing last 10, ${skipped} omitted)` : ""}`;
      const body = shown
        .map(([id, w]) => {
          const sum = w.summary ? ` | ${w.summary.slice(0, 80)}` : "";
          return `${id} | ${w.status}${sum}`;
        })
        .join("\n");
      return `${header}\n${body}`;
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no progress files";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".json")).sort();
    if (entries.length === 0) return "no progress files";
    const lines = await Promise.all(
      entries.map(async (f) => {
        const full = path.join(base, f);
        const slug = f.replace(/\.json$/, "");
        const data: ProgressData = JSON.parse(await Bun.file(full).text());
        const waves = Object.entries(data.waves);
        const completed = waves.filter(([, w]) => w.status === "done").length;
        return `${slug} | ${completed}/${waves.length} waves done | file ${rel(context.directory, full)}`;
      }),
    );
    return lines.join("\n");
  },
});

export const done = tool({
  description:
    "Remove progress tracking for a plan. Call with a slug to remove one plan's progress. Call without a slug to remove ALL progress files.",
  args: {
    plan_slug: tool.schema
      .string()
      .optional()
      .describe("Plan slug to remove. Omit to remove ALL progress files."),
  },
  async execute(args, context) {
    if (args.plan_slug) {
      validate(args.plan_slug);
      const dest = target(context.directory, args.plan_slug);
      if (!fs.existsSync(dest)) return `no progress for ${args.plan_slug}`;
      await Bun.file(dest).delete();
      return `removed progress for ${args.plan_slug}\nfile: ${rel(context.directory, dest)}`;
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no progress files to clean";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".json"));
    if (entries.length === 0) return "no progress files to clean";
    const files = entries.map((f) => path.join(base, f));
    await Promise.all(files.map((file) => Bun.file(file).delete()));
    if ((await readdir(base)).length === 0) fs.rmdirSync(base);
    return `removed ${entries.length} progress files\nfiles:\n${files.map((file) => rel(context.directory, file)).join("\n")}`;
  },
});
