import { tool } from "@opencode-ai/plugin";
import path from "path";
import { mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const STATUSES = ["pending", "in-progress", "done"];

type Wave = {
  status: string;
  summary?: string | null;
  updated: string;
};

type AuditProgressData = {
  waves: Record<string, Wave>;
};

function validate(slug: string) {
  if (!SLUG_RE.test(slug))
    throw new Error(
      `invalid slug "${slug}" — use 2-4 lowercase hyphenated words (e.g. auth-surface, api-audit)`,
    );
}

function dir(directory: string) {
  return path.join(directory, ".opencode", "audit-progress");
}

function target(directory: string, slug: string) {
  return path.join(dir(directory), `${slug}.json`);
}

function rel(directory: string, file: string) {
  return path.relative(directory, file);
}

export const update = tool({
  description:
    "Update wave-level progress for a persisted audit (orchestrator-only). Call after each investigation wave completes or starts. Same semantics as plan progress: pending | in-progress | done.",
  args: {
    audit_slug: tool.schema.string().describe("Audit slug this progress tracks"),
    wave_id: tool.schema.string().describe("Wave identifier (e.g. W1, explore-batch-a)"),
    status: tool.schema.string().describe("Wave status: pending | in-progress | done"),
    summary: tool.schema
      .string()
      .optional()
      .describe("Brief summary (e.g. '3 explore tasks returned', synthesis done)"),
  },
  async execute(args, context) {
    validate(args.audit_slug);
    if (!STATUSES.includes(args.status))
      throw new Error(`invalid status "${args.status}" — use: ${STATUSES.join(", ")}`);
    const dest = target(context.directory, args.audit_slug);
    await mkdir(dir(context.directory), { recursive: true });
    const existing: AuditProgressData = fs.existsSync(dest)
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
    return `audit progress: ${args.audit_slug} ${args.wave_id} → ${args.status}\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read audit wave progress. With audit_slug: all waves for that audit. Without: list all audits that have progress files.",
  args: {
    audit_slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to read. Omit to list all audits with progress summaries."),
  },
  async execute(args, context) {
    if (args.audit_slug) {
      validate(args.audit_slug);
      const dest = target(context.directory, args.audit_slug);
      if (!fs.existsSync(dest)) return `no audit progress for ${args.audit_slug}`;
      const data: AuditProgressData = JSON.parse(await Bun.file(dest).text());
      return (
        `File: ${rel(context.directory, dest)}\n` +
        Object.entries(data.waves)
          .map(
            ([id, w]) => `${id} | ${w.status}${w.summary ? ` | ${w.summary}` : ""} | ${w.updated}`,
          )
          .join("\n")
      );
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no audit progress files";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".json")).sort();
    if (entries.length === 0) return "no audit progress files";
    const lines = await Promise.all(
      entries.map(async (f) => {
        const full = path.join(base, f);
        const slug = f.replace(/\.json$/, "");
        const data: AuditProgressData = JSON.parse(await Bun.file(full).text());
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
    "Remove audit progress tracking. With audit_slug: one audit. Without: ALL audit progress files.",
  args: {
    audit_slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to remove. Omit to remove ALL audit progress files."),
  },
  async execute(args, context) {
    if (args.audit_slug) {
      validate(args.audit_slug);
      const dest = target(context.directory, args.audit_slug);
      if (!fs.existsSync(dest)) return `no audit progress for ${args.audit_slug}`;
      await Bun.file(dest).delete();
      return `removed audit progress for ${args.audit_slug}\nfile: ${rel(context.directory, dest)}`;
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no audit progress files to clean";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".json"));
    if (entries.length === 0) return "no audit progress files to clean";
    const files = entries.map((f) => path.join(base, f));
    await Promise.all(files.map((file) => Bun.file(file).delete()));
    if ((await readdir(base)).length === 0) fs.rmdirSync(base);
    return `removed ${entries.length} audit progress files\nfiles:\n${files.map((file) => rel(context.directory, file)).join("\n")}`;
  },
});
