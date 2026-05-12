import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { search } from "./journal";

function toolContext(directory: string) {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      return Effect.void;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "output" in result) {
    const out = Reflect.get(result, "output");
    if (typeof out === "string") return out;
  }
  throw new Error(`unexpected tool result shape: ${typeof result}`);
}

describe("journal_search", () => {
  test("empty journal returns empty envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-journal-search-"));
    try {
      const out = toolResultText(await search.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(0);
      expect(parsed.shown).toBe(0);
      const entries = parsed.entries;
      if (!Array.isArray(entries)) throw new Error("entries");
      expect(entries.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bad ISO since throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-journal-search-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(op, { recursive: true });
      await writeFile(
        path.join(op, "journal.jsonl"),
        `${JSON.stringify({ ts: "2026-03-01T12:00:00.000Z", type: "decision", content: "x" })}\n`,
        "utf8",
      );
      await expect(
        search.execute({ since: "not-a-date" }, toolContext(root)),
      ).rejects.toThrow(/not a valid ISO 8601/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filters compose: type + query + since + until", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-journal-search-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(op, { recursive: true });
      const lines = [
        { ts: "2026-01-01T00:00:00.000Z", type: "decision", content: "Alpha BRAVO" },
        { ts: "2026-02-01T00:00:00.000Z", type: "contract", content: "alpha ignored" },
        {
          ts: "2026-02-20T00:00:00.000Z",
          type: "decision",
          content: "contains BRAVO keyword for filter",
        },
        { ts: "2026-03-01T00:00:00.000Z", type: "decision", content: "charlie" },
      ].map((e) => JSON.stringify(e));
      await writeFile(path.join(op, "journal.jsonl"), `${lines.join("\n")}\n`, "utf8");

      const out = toolResultText(
        await search.execute(
          {
            type: "decision",
            query: "bravo",
            since: "2026-01-15T00:00:00.000Z",
            until: "2026-04-01T00:00:00.000Z",
          },
          toolContext(root),
        ),
      );
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(1);
      const entries = parsed.entries;
      if (!Array.isArray(entries) || entries.length < 1) throw new Error("entries");
      const first = entries[0];
      if (!isRecord(first)) throw new Error("entry");
      expect(first.content).toBe("contains BRAVO keyword for filter");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("substring search is case-insensitive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-journal-search-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(op, { recursive: true });
      await writeFile(
        path.join(op, "journal.jsonl"),
        `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "pattern", content: "CamelCase TOKEN" })}\n`,
        "utf8",
      );
      const out = toolResultText(await search.execute({ query: "token" }, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("limit is clamped to 50", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-journal-search-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(op, { recursive: true });
      const many = Array.from({ length: 60 }, (_, i) =>
        JSON.stringify({
          ts: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
          type: "discovery",
          content: `line ${i}`,
        }),
      );
      await writeFile(path.join(op, "journal.jsonl"), `${many.join("\n")}\n`, "utf8");
      const out = toolResultText(await search.execute({ type: "discovery", limit: 999 }, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const entries = parsed.entries;
      if (!Array.isArray(entries)) throw new Error("entries");
      expect(entries.length).toBe(50);
      expect(parsed.shown).toBe(50);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
