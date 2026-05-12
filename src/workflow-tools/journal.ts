import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { rel } from "../util/format";

const TYPE_TUPLE = ["decision", "contract", "discovery", "pattern"] as const;
const TYPES: readonly string[] = TYPE_TUPLE;
const READ_DEFAULT = 3;
const READ_MAX = 10;
const READ_ENTRY_CAP = 200;

function target(directory: string): string {
  return path.join(directory, ".opencode", "journal.jsonl");
}

export const write = tool({
  description:
    "Append an entry to the persistent decision journal. Use to record architectural decisions, interface contracts, discoveries, and established patterns that downstream waves or future sessions need. Entries are immutable once written.",
  args: {
    type: tool.schema.string().describe("Entry type: decision | contract | discovery | pattern"),
    content: tool.schema.string().describe("Durable conclusion only, not transcript text"),
  },
  async execute(args, context) {
    if (!(TYPES as readonly string[]).includes(args.type))
      throw new Error(`invalid type "${args.type}" — use: ${TYPES.join(", ")}`);
    const dest = target(context.directory);
    await mkdir(path.dirname(dest), { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type: args.type,
      content: args.content,
    });
    await appendFile(dest, `${entry}\n`);
    return `journal: appended ${args.type} entry\nfile: ${rel(context.directory, dest)}`;
  },
});

export const read = tool({
  description:
    "Read the persistent decision journal. Returns the last N entries (default 5). Each entry has a timestamp, type, and content. Entries are soft-truncated on read.",
  args: {
    last_n: tool.schema.number().optional().describe("Return only the last N entries (default 5)."),
  },
  async execute(args, context) {
    const dest = target(context.directory);
    if (!(await Bun.file(dest).exists())) return "no journal entries";
    const lines = (await Bun.file(dest).text()).trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "no journal entries";
    const requested = Math.max(1, Math.floor(args.last_n ?? READ_DEFAULT));
    const n = Math.min(requested, READ_MAX);
    const skipped = Math.max(0, lines.length - n);
    const entries = lines.slice(-n);
    const clamped = requested > READ_MAX ? `, requested ${requested} clamped to ${READ_MAX}` : "";
    const header = `File: ${rel(context.directory, dest)}\n${lines.length} total entries${skipped > 0 ? ` (showing last ${n}, ${skipped} omitted${clamped})` : clamped ? ` (${clamped.slice(2)})` : ""}`;
    const body = entries
      .map((line) => {
        const e = JSON.parse(line);
        const text =
          e.content.length > READ_ENTRY_CAP ? `${e.content.slice(0, READ_ENTRY_CAP)}…` : e.content;
        return `[${e.ts}] ${e.type}: ${text}`;
      })
      .join("\n");
    return `${header}\n${body}`;
  },
});

export const done = tool({
  description: "Remove the decision journal. Call after a project concludes to clean up.",
  args: {},
  async execute(_args, context) {
    const dest = target(context.directory);
    if (!(await Bun.file(dest).exists())) return "no journal to clean";
    await Bun.file(dest).delete();
    return `journal cleared\nfile: ${rel(context.directory, dest)}`;
  },
});

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;

type JournalSearchEntry = {
  ts: string;
  type: string;
  content: string;
};

export const search = tool({
  description:
    "Search the decision journal by type, content substring, and/or time range. Returns matching entries sorted by most-recent-first. Use when the orchestrator needs to recall older decisions/contracts/discoveries/patterns that `journal_read` (last N only) won't surface.",
  args: {
    type: tool.schema
      .enum([...TYPE_TUPLE])
      .optional()
      .describe("Filter by entry type."),
    query: tool.schema
      .string()
      .optional()
      .describe("Case-insensitive substring search in the entry content."),
    since: tool.schema
      .string()
      .optional()
      .describe("ISO 8601 timestamp; include entries on or after this time."),
    until: tool.schema
      .string()
      .optional()
      .describe("ISO 8601 timestamp; include entries before this time."),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum entries to return. Default 10, max 50."),
  },
  async execute(args, context) {
    const sinceMs = parseTimestampOrThrow(args.since, "since");
    const untilMs = parseTimestampOrThrow(args.until, "until");
    const requested = args.limit ?? SEARCH_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(requested)), SEARCH_MAX_LIMIT);
    const lowerQuery = args.query?.toLowerCase();

    const dest = target(context.directory);
    if (!(await Bun.file(dest).exists())) {
      return JSON.stringify(
        { total: 0, shown: 0, limit, entries: [] satisfies JournalSearchEntry[] },
        null,
        2,
      );
    }

    const lines = (await Bun.file(dest).text())
      .split("\n")
      .filter((line) => line.length > 0);

    const matches: JournalSearchEntry[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isJournalSearchEntry(parsed)) continue;
      if (args.type && parsed.type !== args.type) continue;
      if (lowerQuery && !parsed.content.toLowerCase().includes(lowerQuery)) continue;
      const entryMs = Date.parse(parsed.ts);
      if (!Number.isNaN(entryMs)) {
        if (sinceMs !== undefined && entryMs < sinceMs) continue;
        if (untilMs !== undefined && entryMs >= untilMs) continue;
      }
      matches.push(parsed);
    }

    matches.sort((a, b) => b.ts.localeCompare(a.ts));
    const shown = matches.slice(0, limit);

    return JSON.stringify(
      {
        total: matches.length,
        shown: shown.length,
        limit,
        entries: shown,
      },
      null,
      2,
    );
  },
});

function parseTimestampOrThrow(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`journal_search: \`${field}\` is not a valid ISO 8601 timestamp: "${value}"`);
  }
  return ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJournalSearchEntry(value: unknown): value is JournalSearchEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    typeof value.content === "string"
  );
}
