import { describe, expect, test } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { Effect } from "effect";

import { driftCheck } from "./drift-check";

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

function kinds(findings: unknown[], want: string): unknown[] {
  return findings.filter((f) => {
    if (!isRecord(f)) return false;
    return f.kind === want;
  });
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "output" in result) {
    const out = Reflect.get(result, "output");
    if (typeof out === "string") return out;
  }
  throw new Error(`unexpected tool result shape: ${typeof result}`);
}

describe("drift_check", () => {
  test("clean workspace returns empty findings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(findings.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects progress_without_plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const op = path.join(root, ".opencode", "progress");
      await mkdir(op, { recursive: true });
      await writeFile(path.join(op, "ghost.json"), "{}", "utf8");
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "progress_without_plan").length).toBe(1);
      const f = kinds(findings, "progress_without_plan")[0];
      if (!isRecord(f)) throw new Error("finding");
      expect(f.severity).toBe("error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects plan_without_progress as info", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const op = path.join(root, ".opencode", "plans");
      await mkdir(op, { recursive: true });
      await writeFile(path.join(op, "solo.md"), "# Solo Plan\n", "utf8");
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "plan_without_progress").length).toBe(1);
      const f = kinds(findings, "plan_without_progress")[0];
      if (!isRecord(f)) throw new Error("finding");
      expect(f.severity).toBe("info");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects audit_progress_without_audit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const op = path.join(root, ".opencode", "audit-progress");
      await mkdir(op, { recursive: true });
      await writeFile(path.join(op, "orphan-audit.json"), "{}", "utf8");
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "audit_progress_without_audit").length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects run_references_missing_plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const runsDir = path.join(root, ".opencode", "runs");
      await mkdir(runsDir, { recursive: true });
      const runRecord = {
        schema_version: 1,
        agent_run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        correlation_id: "corr_bbbbbbbbbbbbbbbbbbbbbbbb",
        workspace_id: "ws_cccccccccccccc",
        plan_slug: "missing-plan",
        agent_type: "executor",
        paths: [],
        status: "in_progress",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      };
      await writeFile(
        path.join(runsDir, "run_aaaaaaaaaaaaaaaaaaaaaaaa.json"),
        JSON.stringify(runRecord),
        "utf8",
      );
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "run_references_missing_plan").length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects status_older_than_run_finish", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const op = path.join(root, ".opencode");
      await mkdir(path.join(op, "runs"), { recursive: true });
      await mkdir(path.join(op, "status"), { recursive: true });
      const agentRunId = "run_0123456789abcdef01234567";
      const finishedAt = "2026-06-15T12:00:00.000Z";
      const runRecord = {
        schema_version: 1,
        agent_run_id: agentRunId,
        correlation_id: "corr_0123456789abcdef012345",
        workspace_id: "ws_0123456789abcdef",
        agent_type: "executor",
        paths: [],
        status: "done",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: finishedAt,
        finished_at: finishedAt,
      };
      await writeFile(
        path.join(op, "runs", `${agentRunId}.json`),
        JSON.stringify(runRecord),
        "utf8",
      );
      const statusSlug = `run-${agentRunId.slice(4, 16)}`;
      const statusPath = path.join(op, "status", `${statusSlug}.json`);
      await writeFile(statusPath, '{"slug":"mirror"}', "utf8");
      const old = new Date("2020-01-01T00:00:00.000Z");
      await utimes(statusPath, old, old);

      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "status_older_than_run_finish").length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects subplans_without_any_final_plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conductor-drift-"));
    try {
      const op = path.join(root, ".opencode", "subplans");
      await mkdir(op, { recursive: true });
      await writeFile(path.join(op, "draft.md"), "# Draft\n", "utf8");
      const out = toolResultText(await driftCheck.execute({}, toolContext(root)));
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      const findings = parsed.findings;
      if (!Array.isArray(findings)) throw new Error("findings");
      expect(kinds(findings, "subplans_without_any_final_plan").length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
