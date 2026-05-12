import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { list } from "./run";

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

function baseRun(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    agent_run_id: "run_placeholder",
    correlation_id: "corr_placeholder000000000000",
    workspace_id: "ws_0123456789abcdef",
    agent_type: "executor",
    paths: [],
    status: "initialized",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("run_list", () => {
  test("empty workspace returns empty records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-runlist-"));
    try {
      const out = toolResultText(await list.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(0);
      const records = parsed.records;
      if (!Array.isArray(records)) throw new Error("records");
      expect(records.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sorts newest-first and respects limit cap 100", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-runlist-"));
    try {
      const runsDir = path.join(root, ".opencode", "runs");
      await mkdir(runsDir, { recursive: true });
      const r1 = baseRun({
        agent_run_id: "run_111111111111111111111111",
        updated_at: "2026-01-01T00:00:00.000Z",
        status: "done",
        finished_at: "2026-01-01T00:00:00.000Z",
      });
      const r2 = baseRun({
        agent_run_id: "run_222222222222222222222222",
        updated_at: "2026-06-01T00:00:00.000Z",
        status: "done",
        finished_at: "2026-06-01T00:00:00.000Z",
      });
      await writeFile(
        path.join(runsDir, "run_111111111111111111111111.json"),
        JSON.stringify(r1),
        "utf8",
      );
      await writeFile(
        path.join(runsDir, "run_222222222222222222222222.json"),
        JSON.stringify(r2),
        "utf8",
      );
      const out = toolResultText(await list.execute({ limit: 1 }, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(2);
      expect(parsed.shown).toBe(1);
      const records = parsed.records;
      if (!Array.isArray(records) || records.length < 1) throw new Error("records");
      const first = records[0];
      if (!isRecord(first)) throw new Error("row");
      expect(first.agent_run_id).toBe("run_222222222222222222222222");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filters compose: status + plan_slug + agent_type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-runlist-"));
    try {
      const runsDir = path.join(root, ".opencode", "runs");
      await mkdir(runsDir, { recursive: true });
      const a = baseRun({
        agent_run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        plan_slug: "plan-a",
        agent_type: "executor-high",
        status: "in_progress",
        updated_at: "2026-02-01T00:00:00.000Z",
      });
      const b = baseRun({
        agent_run_id: "run_bbbbbbbbbbbbbbbbbbbbbbbb",
        plan_slug: "plan-b",
        agent_type: "reviewer",
        status: "in_progress",
        updated_at: "2026-03-01T00:00:00.000Z",
      });
      await writeFile(
        path.join(runsDir, "run_aaaaaaaaaaaaaaaaaaaaaaaa.json"),
        JSON.stringify(a),
        "utf8",
      );
      await writeFile(
        path.join(runsDir, "run_bbbbbbbbbbbbbbbbbbbbbbbb.json"),
        JSON.stringify(b),
        "utf8",
      );
      const out = toolResultText(
        await list.execute(
          {
            status: "in_progress",
            plan_slug: "plan-a",
            agent_type: "executor-high",
          },
          toolContext(root),
        ),
      );
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      expect(parsed.total).toBe(1);
      const records = parsed.records;
      if (!Array.isArray(records) || records.length !== 1) throw new Error("records");
      const row = records[0];
      if (!isRecord(row)) throw new Error("row");
      expect(row.agent_run_id).toBe("run_aaaaaaaaaaaaaaaaaaaaaaaa");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
