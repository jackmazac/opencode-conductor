import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { artifactIndex } from "./artifact-index";

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

describe("artifact_index", () => {
  test("empty workspace returns valid envelope with empty collections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-artidx-"));
    try {
      const out = toolResultText(await artifactIndex.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const kinds = parsed.kinds;
      if (!isRecord(kinds)) throw new Error("expected kinds");
      if (!Array.isArray(kinds.plans)) throw new Error("expected plans array");
      expect(kinds.plans.length).toBe(0);
      expect(kinds.handoff).toEqual({ exists: false });
      expect(kinds.journal).toEqual({ exists: false });
      expect(typeof parsed.summary).toBe("string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pre-populated workspace reports counts and titles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-artidx-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(path.join(op, "plans"), { recursive: true });
      await writeFile(
        path.join(op, "plans", "auth-refactor.md"),
        "# Auth refactor Plan\n\nBody\n",
        "utf8",
      );
      await writeFile(path.join(op, "handoff.md"), "# Handoff\n\nok", "utf8");
      await writeFile(
        path.join(op, "journal.jsonl"),
        `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "decision", content: "x" })}\n`,
        "utf8",
      );

      const out = toolResultText(await artifactIndex.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const kinds = parsed.kinds;
      if (!isRecord(kinds)) throw new Error("expected kinds");
      const plans = kinds.plans;
      if (!Array.isArray(plans) || plans.length < 1) throw new Error("expected plans");
      const first = plans[0];
      if (!isRecord(first)) throw new Error("plan entry");
      expect(first.slug).toBe("auth-refactor");
      expect(first.title).toBe("Auth refactor Plan");

      const handoff = kinds.handoff;
      if (!isRecord(handoff)) throw new Error("handoff");
      expect(handoff.exists).toBe(true);

      const journal = kinds.journal;
      if (!isRecord(journal)) throw new Error("journal");
      expect(journal.exists).toBe(true);
      expect(journal.entries).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("kinds filter is respected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-artidx-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(path.join(op, "plans"), { recursive: true });
      await mkdir(path.join(op, "subplans"), { recursive: true });
      await writeFile(path.join(op, "plans", "a.md"), "# A Plan\n", "utf8");
      await writeFile(path.join(op, "subplans", "b.md"), "# B\n", "utf8");

      const out = toolResultText(
        await artifactIndex.execute({ kinds: ["plans"] }, toolContext(root)),
      );
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const kinds = parsed.kinds;
      if (!isRecord(kinds)) throw new Error("expected kinds");
      expect(kinds.plans).toBeDefined();
      expect(kinds.subplans).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
