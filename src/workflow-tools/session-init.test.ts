import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { sessionInit } from "./session-init";

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

describe("session_init", () => {
  test("empty workspace returns valid envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-sess-"));
    try {
      const out = toolResultText(await sessionInit.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.handoff).toEqual({ exists: false });
      const journal = parsed.journal;
      if (!isRecord(journal)) throw new Error("journal");
      expect(journal.exists).toBe(false);
      expect(journal.total).toBe(0);
      expect(Array.isArray(parsed.plans)).toBe(true);
      expect(Array.isArray(parsed.active_runs)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("journal_n cap clamps to 10", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-sess-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(op, { recursive: true });
      const lines = Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({
          ts: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          type: "decision",
          content: `entry ${i}`,
        }),
      ).join("\n");
      await writeFile(path.join(op, "journal.jsonl"), `${lines}\n`, "utf8");

      const out = toolResultText(await sessionInit.execute({ journal_n: 99 }, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const journal = parsed.journal;
      if (!isRecord(journal)) throw new Error("journal");
      expect(journal.total).toBe(12);
      expect(journal.shown).toBeLessThanOrEqual(10);
      const entries = journal.entries;
      if (!Array.isArray(entries)) throw new Error("entries");
      expect(entries.length).toBeLessThanOrEqual(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("includes handoff content and plan summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-sess-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(path.join(op, "plans"), { recursive: true });
      await writeFile(path.join(op, "handoff.md"), "Resume here", "utf8");
      await writeFile(path.join(op, "plans", "p1.md"), "# My Plan\n\nx\n", "utf8");

      const out = toolResultText(await sessionInit.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const handoff = parsed.handoff;
      if (!isRecord(handoff)) throw new Error("handoff");
      expect(handoff.exists).toBe(true);
      expect(handoff.content).toContain("Resume here");
      const plans = parsed.plans;
      if (!Array.isArray(plans) || plans.length < 1) throw new Error("plans");
      const p0 = plans[0];
      if (!isRecord(p0)) throw new Error("plan");
      expect(p0.slug).toBe("p1");
      expect(p0.title).toBe("My Plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
