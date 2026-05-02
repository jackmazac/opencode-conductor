import { tool } from "@opencode-ai/plugin";
import path from "path";
import { mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const READ_CAP = 3000;

function validate(slug: string) {
  if (!SLUG_RE.test(slug))
    throw new Error(
      `invalid slug "${slug}" — use 2-4 lowercase hyphenated words (e.g. auth-surface, api-audit)`,
    );
}

function dir(directory: string) {
  return path.join(directory, ".opencode", "audits");
}

function target(directory: string, slug: string) {
  return path.join(dir(directory), `${slug}.md`);
}

function rel(directory: string, file: string) {
  return path.relative(directory, file);
}

function cap(text: string, limit: number) {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[truncated — ${text.length - limit} chars omitted, stored audit is complete]`
  );
}

export const write = tool({
  description:
    "Write or update a persisted audit report (orchestrator-only durable artifact). Use a 2-4 word hyphenated slug. Content should be the finalized markdown audit shown to the user. Subagents do not read this file — inline slices in task prompts instead.",
  args: {
    slug: tool.schema
      .string()
      .describe("Audit slug: lowercase hyphenated words identifying this audit"),
    content: tool.schema.string().describe("Markdown content for the persisted audit"),
  },
  async execute(args, context) {
    validate(args.slug);
    await mkdir(dir(context.directory), { recursive: true });
    const dest = target(context.directory, args.slug);
    const tmp = `${dest}.tmp`;
    await Bun.write(tmp, args.content);
    fs.renameSync(tmp, dest);
    return `wrote audit ${args.slug}\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read persisted audit files (orchestrator use). No slug: compact list of all audits (slug, title, last updated). With slug: audit content soft-truncated for context. Do not ask subagents to call this — pass inlined context in task prompts.",
  args: {
    slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to read. Omit to list all persisted audit files."),
  },
  async execute(args, context) {
    if (args.slug) {
      validate(args.slug);
      const dest = target(context.directory, args.slug);
      if (!(await Bun.file(dest).exists())) return `no audit file for ${args.slug}`;
      const mtime = fs.statSync(dest).mtime.toISOString();
      const raw = await Bun.file(dest).text();
      return `File: ${rel(context.directory, dest)}\nLast updated: ${mtime} (${raw.length} chars)\n\n${cap(raw, READ_CAP)}`;
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no audit files";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".md")).sort();
    if (entries.length === 0) return "no audit files";
    const lines = await Promise.all(
      entries.map(async (f) => {
        const full = path.join(base, f);
        const slug = f.replace(/\.md$/, "");
        const mtime = fs.statSync(full).mtime.toISOString();
        const text = await Bun.file(full).text();
        const title =
          text
            .split("\n")
            .find((line) => line.startsWith("# "))
            ?.slice(2)
            .trim() || "(untitled audit)";
        return `${slug} | ${title} | updated ${mtime} | file ${rel(context.directory, full)}`;
      }),
    );
    return lines.join("\n");
  },
});

export const done = tool({
  description:
    "Remove a persisted audit file. With slug: remove one. Without slug: remove ALL audit files.",
  args: {
    slug: tool.schema
      .string()
      .optional()
      .describe("Audit slug to remove. Omit to remove ALL persisted audit files."),
  },
  async execute(args, context) {
    if (args.slug) {
      validate(args.slug);
      const dest = target(context.directory, args.slug);
      if (!(await Bun.file(dest).exists())) return `no audit file for ${args.slug}`;
      await Bun.file(dest).delete();
      return `removed audit ${args.slug}\nfile: ${rel(context.directory, dest)}`;
    }
    const base = dir(context.directory);
    if (!fs.existsSync(base)) return "no audit files to clean";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".md"));
    if (entries.length === 0) return "no audit files to clean";
    const files = entries.map((f) => path.join(base, f));
    await Promise.all(files.map((file) => Bun.file(file).delete()));
    if ((await readdir(base)).length === 0) fs.rmdirSync(base);
    return `removed ${entries.length} audit files\nfiles:\n${files.map((file) => rel(context.directory, file)).join("\n")}`;
  },
});
