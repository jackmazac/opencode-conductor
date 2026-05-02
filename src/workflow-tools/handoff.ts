import { tool } from "@opencode-ai/plugin";
import path from "path";
import { mkdir } from "node:fs/promises";
import fs from "node:fs";

const READ_CAP = 3000;

function target(directory: string) {
  return path.join(directory, ".opencode", "handoff.md");
}

function rel(directory: string, file: string) {
  return path.relative(directory, file);
}

function cap(text: string, limit: number) {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[truncated — ${text.length - limit} chars omitted, stored handoff is complete]`
  );
}

export const write = tool({
  description:
    "Write or overwrite the session handoff document. Contains: goal, current state, what's done, what's next, key decisions, blockers, active plan slugs, and active audit slugs (if any). Read by the orchestrator at session start to resume context.",
  args: {
    content: tool.schema.string().describe("Markdown content for the handoff document"),
  },
  async execute(args, context) {
    const dest = target(context.directory);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await Bun.write(tmp, args.content);
    fs.renameSync(tmp, dest);
    return `handoff written\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read the session handoff document left by a previous session. Returns handoff content soft-truncated for context if it exists. Call at session start to resume context.",
  args: {},
  async execute(_args, context) {
    const dest = target(context.directory);
    if (!fs.existsSync(dest)) return "no handoff document";
    const mtime = fs.statSync(dest).mtime.toISOString();
    const raw = await Bun.file(dest).text();
    return `File: ${rel(context.directory, dest)}\nLast updated: ${mtime} (${raw.length} chars)\n\n${cap(raw, READ_CAP)}`;
  },
});

export const done = tool({
  description:
    "Remove the session handoff document. Call after the project concludes or the handoff has been consumed.",
  args: {},
  async execute(_args, context) {
    const dest = target(context.directory);
    if (!fs.existsSync(dest)) return "no handoff to remove";
    await Bun.file(dest).delete();
    return `handoff removed\nfile: ${rel(context.directory, dest)}`;
  },
});
