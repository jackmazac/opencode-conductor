import path from "node:path";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { cap, rel } from "../util/format";
import { pathExists } from "../util/path-exists";
import { validateSlug } from "../util/slug";

const READ_CAP = 3000;
const AUDIT_SLUG_EXAMPLE = "auth-surface, api-audit-0.18";

function dir(directory: string): string {
  return path.join(directory, ".opencode", "audits");
}

function target(directory: string, slug: string): string {
  return path.join(dir(directory), `${slug}.md`);
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
    validateSlug(args.slug, { example: AUDIT_SLUG_EXAMPLE });
    await mkdir(dir(context.directory), { recursive: true });
    const dest = target(context.directory, args.slug);
    const tmp = `${dest}.tmp`;
    await Bun.write(tmp, args.content);
    await rename(tmp, dest);
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
      validateSlug(args.slug, { example: AUDIT_SLUG_EXAMPLE });
      const dest = target(context.directory, args.slug);
      if (!(await Bun.file(dest).exists())) return `no audit file for ${args.slug}`;
      const fileStat = await stat(dest);
      const raw = await Bun.file(dest).text();
      return `File: ${rel(context.directory, dest)}\nLast updated: ${fileStat.mtime.toISOString()} (${raw.length} chars)\n\n${cap(raw, READ_CAP)}`;
    }
    const base = dir(context.directory);
    if (!(await pathExists(base))) return "no audit files";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".md")).sort();
    if (entries.length === 0) return "no audit files";
    const lines = await Promise.all(
      entries.map(async (f) => {
        const full = path.join(base, f);
        const slug = f.replace(/\.md$/, "");
        const fileStat = await stat(full);
        const text = await Bun.file(full).text();
        const title =
          text
            .split("\n")
            .find((line) => line.startsWith("# "))
            ?.slice(2)
            .trim() || "(untitled audit)";
        return `${slug} | ${title} | updated ${fileStat.mtime.toISOString()} | file ${rel(context.directory, full)}`;
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
      validateSlug(args.slug, { example: AUDIT_SLUG_EXAMPLE });
      const dest = target(context.directory, args.slug);
      if (!(await Bun.file(dest).exists())) return `no audit file for ${args.slug}`;
      await Bun.file(dest).delete();
      return `removed audit ${args.slug}\nfile: ${rel(context.directory, dest)}`;
    }
    const base = dir(context.directory);
    if (!(await pathExists(base))) return "no audit files to clean";
    const entries = (await readdir(base)).filter((f) => f.endsWith(".md"));
    if (entries.length === 0) return "no audit files to clean";
    const files = entries.map((f) => path.join(base, f));
    await Promise.all(files.map((file) => Bun.file(file).delete()));
    if ((await readdir(base)).length === 0) await rmdir(base);
    return `removed ${entries.length} audit files\nfiles:\n${files.map((file) => rel(context.directory, file)).join("\n")}`;
  },
});
