import path from "node:path";
import { mkdir, rename, stat } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { cap, rel } from "../util/format";

const READ_CAP = 3000;

function target(directory: string): string {
  return path.join(directory, ".opencode", "handoff.md");
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
    await rename(tmp, dest);
    return `handoff written\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read the session handoff document left by a previous session. Returns handoff content soft-truncated for context if it exists. Call at session start to resume context.",
  args: {},
  async execute(_args, context) {
    const dest = target(context.directory);
    if (!(await Bun.file(dest).exists())) return "no handoff document";
    const fileStat = await stat(dest);
    const raw = await Bun.file(dest).text();
    return `File: ${rel(context.directory, dest)}\nLast updated: ${fileStat.mtime.toISOString()} (${raw.length} chars)\n\n${cap(raw, READ_CAP)}`;
  },
});

export const done = tool({
  description:
    "Remove the session handoff document. Call after the project concludes or the handoff has been consumed.",
  args: {},
  async execute(_args, context) {
    const dest = target(context.directory);
    if (!(await Bun.file(dest).exists())) return "no handoff to remove";
    await Bun.file(dest).delete();
    return `handoff removed\nfile: ${rel(context.directory, dest)}`;
  },
});
