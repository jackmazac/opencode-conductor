import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExploreFastProcessRequest, ExploreFastProcessRunner } from "./explore-fast";
import { createConductorHooks } from "./index";
import { __test_setEngramDispatch } from "./workflow-tools/conflict-context";

describe("ConductorPlugin tools", () => {
  test("exposes explore_fast without removing plan artifact tools", () => {
    const hooks = createConductorHooks();

    expect(hooks.tool?.persist_subplan).toBeDefined();
    expect(hooks.tool?.read_subplan).toBeDefined();
    expect(hooks.tool?.discard_subplan).toBeDefined();
    expect(hooks.tool?.persist_final_plan).toBeDefined();
    expect(hooks.tool?.read_final_plan).toBeDefined();
    expect(hooks.tool?.discard_final_plan).toBeDefined();
    expect(hooks.tool?.explore_fast).toBeDefined();
    expect(hooks.tool?.explore_fast.description).toContain("Cursor CLI");
  });

  test("preserves migrated workflow tool names", () => {
    const hooks = createConductorHooks();
    const toolNames = [
      "audit_write",
      "audit_read",
      "audit_done",
      "audit_progress_update",
      "audit_progress_read",
      "audit_progress_done",
      "conflict_context",
      "context_usage",
      "lifecycle_concord_ingest",
      "handoff_write",
      "handoff_read",
      "handoff_done",
      "journal_write",
      "journal_read",
      "journal_done",
      "progress_update",
      "progress_read",
      "progress_done",
      "run_init",
      "run_update",
      "run_finish",
      "status_write",
      "status_read",
      "status_done",
    ];

    for (const name of toolNames) {
      expect(hasOwn(hooks.tool ?? {}, name)).toBe(true);
    }
  });

  test("run_init creates a structured run correlation record", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-init-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");

      const result = await runInit.execute(
        {
          agent_type: "executor-high",
          plan_slug: "fleet-integration",
          wave_id: "wave-1",
          goal: "wire concord context",
          paths: ["src/index.ts"],
        },
        toolContext(root),
      );
      const parsed = parseJsonRecord(result);
      const agentRunId = requiredString(parsed, "agent_run_id");
      const correlationId = requiredString(parsed, "correlation_id");
      const workspaceId = requiredString(parsed, "workspace_id");
      const file = requiredString(parsed, "file");
      const statusFile = requiredString(parsed, "status_file");
      const statusSlug = requiredString(parsed, "status_slug");

      expect(agentRunId.startsWith("run_")).toBe(true);
      expect(correlationId.startsWith("corr_")).toBe(true);
      expect(workspaceId.startsWith("ws_")).toBe(true);
      expect(file.startsWith(".opencode/runs/run_")).toBe(true);
      expect(statusSlug.startsWith("run-")).toBe(true);
      expect(statusFile.startsWith(".opencode/status/run-")).toBe(true);
      const status = await readJsonRecord(join(root, statusFile));
      expect(requiredString(status, "agent_run_id")).toBe(agentRunId);
      expect(requiredString(status, "correlation_id")).toBe(correlationId);
      expect(requiredString(status, "run_file")).toBe(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_init records explicit plan_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-plan-id-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");
      const created = parseJsonRecord(
        await runInit.execute(
          {
            agent_type: "executor-high",
            plan_id: "pln_01HZ0000000000000000000000",
            plan_slug: "fleet-integration",
            goal: "wire plan id",
          },
          toolContext(root),
        ),
      );

      const run = await readJsonRecord(join(root, requiredString(created, "file")));
      const status = await readJsonRecord(join(root, requiredString(created, "status_file")));

      expect(requiredString(run, "plan_id")).toBe("pln_01HZ0000000000000000000000");
      expect(requiredString(status, "plan_id")).toBe("pln_01HZ0000000000000000000000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_init looks up plan_id by plan_slug and preserves legacy records", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-plan-lookup-"));
    try {
      const hooks = createConductorHooks();
      const persistFinalPlan = getTool(hooks, "persist_final_plan");
      const runInit = getTool(hooks, "run_init");
      const runUpdate = getTool(hooks, "run_update");
      const persisted = parseJsonRecord(
        await persistFinalPlan.execute(
          { slug: "indexed-plan", content: "# Indexed Plan\n\nBody" },
          toolContext(root),
        ),
      );
      const created = parseJsonRecord(
        await runInit.execute(
          { agent_type: "executor-high", plan_slug: "indexed-plan", goal: "lookup" },
          toolContext(root),
        ),
      );

      const run = await readJsonRecord(join(root, requiredString(created, "file")));
      expect(requiredString(run, "plan_id")).toBe(requiredString(persisted, "plan_id"));

      const runFilePath = join(root, requiredString(created, "file"));
      const legacyRecord = await readJsonRecord(runFilePath);
      delete legacyRecord.plan_id;
      await Bun.write(runFilePath, JSON.stringify(legacyRecord, null, 2));

      const updated = parseJsonRecord(
        await runUpdate.execute(
          { agent_run_id: requiredString(created, "agent_run_id"), current: "legacy update" },
          toolContext(root),
        ),
      );
      const status = await readJsonRecord(join(root, requiredString(updated, "status_file")));

      expect(updated.plan_id).toBeUndefined();
      expect(status.plan_id).toBeUndefined();
      expect(requiredString(status, "current")).toBe("legacy update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_update preserves plan_id in run and status mirrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-update-plan-id-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");
      const runUpdate = getTool(hooks, "run_update");
      const created = parseJsonRecord(
        await runInit.execute(
          {
            agent_type: "executor-high",
            plan_id: "pln_01HZ0000000000000000000001",
            goal: "preserve on update",
          },
          toolContext(root),
        ),
      );

      const updated = parseJsonRecord(
        await runUpdate.execute(
          { agent_run_id: requiredString(created, "agent_run_id"), current: "still linked" },
          toolContext(root),
        ),
      );
      const run = await readJsonRecord(join(root, requiredString(updated, "file")));
      const status = await readJsonRecord(join(root, requiredString(updated, "status_file")));

      expect(requiredString(run, "plan_id")).toBe("pln_01HZ0000000000000000000001");
      expect(requiredString(status, "plan_id")).toBe("pln_01HZ0000000000000000000001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_finish preserves plan_id in run and status mirrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-finish-plan-id-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");
      const runFinish = getTool(hooks, "run_finish");
      const created = parseJsonRecord(
        await runInit.execute(
          {
            agent_type: "executor-high",
            plan_id: "pln_01HZ0000000000000000000002",
            goal: "preserve on finish",
          },
          toolContext(root),
        ),
      );

      const finished = parseJsonRecord(
        await runFinish.execute(
          { agent_run_id: requiredString(created, "agent_run_id"), summary: "done" },
          toolContext(root),
        ),
      );
      const run = await readJsonRecord(join(root, requiredString(finished, "file")));
      const status = await readJsonRecord(join(root, requiredString(finished, "status_file")));

      expect(requiredString(run, "plan_id")).toBe("pln_01HZ0000000000000000000002");
      expect(requiredString(status, "plan_id")).toBe("pln_01HZ0000000000000000000002");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_init rejects malformed plan_id values", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-invalid-plan-id-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");

      await expect(
        runInit.execute(
          { agent_type: "executor-high", plan_id: "not-a-plan-id", goal: "invalid" },
          toolContext(root),
        ),
      ).rejects.toThrow("invalid plan_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_update and run_finish progress run and status records", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-progress-"));
    try {
      const hooks = createConductorHooks();
      const runInit = getTool(hooks, "run_init");
      const runUpdate = getTool(hooks, "run_update");
      const runFinish = getTool(hooks, "run_finish");
      const created = parseJsonRecord(
        await runInit.execute(
          { agent_type: "executor-high", goal: "finish run", paths: ["src/a.ts"] },
          toolContext(root),
        ),
      );

      const updated = parseJsonRecord(
        await runUpdate.execute(
          {
            agent_run_id: requiredString(created, "agent_run_id"),
            status: "in_progress",
            current: "editing files",
            pending: ["validate"],
          },
          toolContext(root),
        ),
      );
      expect(requiredString(updated, "status")).toBe("in_progress");
      expect(requiredString(updated, "current")).toBe("editing files");

      const finished = parseJsonRecord(
        await runFinish.execute(
          { agent_run_id: requiredString(created, "agent_run_id"), summary: "validated" },
          toolContext(root),
        ),
      );
      const status = await readJsonRecord(join(root, requiredString(finished, "status_file")));

      expect(requiredString(finished, "status")).toBe("done");
      expect(typeof requiredString(finished, "finished_at")).toBe("string");
      expect(requiredString(status, "current")).toBe("validated");
      expect(requiredStringArray(status, "pending")).toEqual([]);
      expect(requiredStringArray(status, "completed")).toEqual(["validated"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lifecycle_concord_ingest writes Concord artifacts from JSON input", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-concord-ingest-"));
    try {
      const hooks = createConductorHooks();
      const ingest = getTool(hooks, "lifecycle_concord_ingest");
      const input = {
        rows: [
          {
            id: 42,
            ts: 1234,
            eventType: "hunk_overlap",
            requestingSession: "session-a",
            requestingCorrelationId: "corr-a",
            requestingPlanRef: "plan-a",
            requestingIntent: "edit alpha",
            holdingSession: "session-b",
            holdingCorrelationId: "corr-b",
            holdingPlanRef: "plan-b",
            holdingIntent: "edit beta",
            filePath: "src/demo.ts",
            requestedRange: "2:1-2:4",
            conflictingRange: "2:3-2:6",
            resolution: "rejected",
            guidanceEmitted: '<concord_conflict version="1" />',
          },
        ],
      };

      const result = await ingest.execute({ input_json: JSON.stringify(input) }, toolContext(root));
      const summary = parseJsonRecord(result);
      const artifact = await readJsonRecord(
        join(root, ".opencode", "lifecycle", "artifacts", "concord", "42.json"),
      );
      const refs = requiredRecordArray(summary, "artifact_refs");

      expect(requiredNumber(summary, "artifacts_written")).toBe(1);
      expect(requiredString(firstRecord(refs), "kind")).toBe("concord_collision");
      expect(requiredString(firstRecord(refs), "ref")).toContain("artifact:concord_collision:");
      expect(requiredStringArray(summary, "concord_event_ids")).toEqual(["concord:42"]);
      expect(requiredStringArray(summary, "lifecycle_object_ids")).toEqual([
        "concord-event:concord:42",
      ]);
      const spineSeq = requiredNumberArray(summary, "spine_seq");
      expect(spineSeq.length).toBe(1);
      expect(requiredString(artifact, "event_id")).toBe("concord:42");
      expect(requiredString(artifact, "lifecycle_object_id")).toBe("concord-event:concord:42");
      expect(spineSeq).toContain(requiredNumber(artifact, "spine_seq"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lifecycle_concord_ingest dry-run returns identifiers without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-concord-dry-run-"));
    try {
      const hooks = createConductorHooks();
      const ingest = getTool(hooks, "lifecycle_concord_ingest");
      const input = {
        rows: [
          {
            id: 43,
            ts: 1235,
            eventType: "hunk_overlap",
            requestingSession: "session-a",
            requestingIntent: "edit alpha",
            filePath: "src/demo.ts",
            requestedRange: "2:1-2:4",
            conflictingRange: "2:3-2:6",
            resolution: "downgraded",
          },
        ],
      };

      const summary = parseJsonRecord(
        await ingest.execute(
          { input_json: JSON.stringify(input), dry_run: true },
          toolContext(root),
        ),
      );

      expect(summary.dry_run).toBe(true);
      expect(requiredNumber(summary, "artifacts_written")).toBe(0);
      expect(requiredStringArray(summary, "concord_event_ids")).toEqual(["concord:43"]);
      expect(requiredStringArray(summary, "lifecycle_object_ids")).toEqual([
        "concord-event:concord:43",
      ]);
      expect(requiredNumberArray(summary, "spine_seq")).toEqual([]);
      expect(
        await Bun.file(
          join(root, ".opencode", "lifecycle", "artifacts", "concord", "43.json"),
        ).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lifecycle_concord_ingest writes guidance XML beside collision artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-concord-guidance-"));
    try {
      const hooks = createConductorHooks();
      const ingest = getTool(hooks, "lifecycle_concord_ingest");
      const input = {
        rows: [
          {
            id: 44,
            ts: 1236,
            eventType: "hunk_overlap",
            requestingSession: "session-a",
            requestingIntent: "edit alpha",
            filePath: "src/demo.ts",
            requestedRange: "2:1-2:4",
            conflictingRange: "2:3-2:6",
            resolution: "waited_then_acquired",
            guidanceEmitted: '<concord_conflict version="1">guidance</concord_conflict>',
          },
        ],
      };

      await ingest.execute({ input_json: JSON.stringify(input) }, toolContext(root));
      const xml = await Bun.file(
        join(root, ".opencode", "lifecycle", "artifacts", "concord", "44.xml"),
      ).text();

      expect(xml).toContain("guidance");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("conflict_context returns structured unavailable result without Engram dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-conflict-context-"));
    try {
      const hooks = createConductorHooks();
      const conflictContext = getTool(hooks, "conflict_context");

      const result = parseJsonRecord(
        await conflictContext.execute(
          {
            project_id: "proj_1",
            correlation_id: "corr_1",
            concord_event_ids: ["concord:42"],
            artifact_refs: [
              "artifact:concord_collision:path:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
            ingest_artifacts: false,
            json: true,
          },
          toolContext(root),
        ),
      );

      expect(result.ok).toBe(false);
      expect(requiredString(requiredRecord(result, "error"), "code")).toBe(
        "E_ENGRAM_NATIVE_UNAVAILABLE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("conflict_context delegates through the test Engram dispatcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-conflict-dispatch-"));
    try {
      let dispatchedToolName = "";
      let dispatchedArgs: unknown;
      __test_setEngramDispatch(async (toolName, args) => {
        dispatchedToolName = toolName;
        dispatchedArgs = args;
        return { ok: true, context: "fake context" };
      });
      const hooks = createConductorHooks();
      const conflictContext = getTool(hooks, "conflict_context");

      const result = parseJsonRecord(
        await conflictContext.execute(
          {
            project_id: "proj_1",
            correlation_id: "corr_1",
            concord_event_ids: ["concord:42"],
            json: true,
          },
          toolContext(root),
        ),
      );

      expect(result.ok).toBe(true);
      expect(requiredString(result, "context")).toBe("fake context");
      expect(dispatchedToolName).toBe("conflict_context");
      expect(JSON.stringify(dispatchedArgs)).toContain("corr_1");
      expect(JSON.stringify(dispatchedArgs)).toContain(root);
    } finally {
      __test_setEngramDispatch(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("delegates explore_fast execution to the Cursor runner", async () => {
    let request: ExploreFastProcessRequest | undefined;
    const runner: ExploreFastProcessRunner = async (input) => {
      request = input;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "delegated exploration" }),
        stderr: "",
      };
    };
    const hooks = createConductorHooks({ exploreFastRunner: runner });
    const exploreFast = hooks.tool?.explore_fast;
    if (!exploreFast) throw new Error("explore_fast tool was not registered");

    const result = await exploreFast.execute(
      {
        query: "find plan tools",
        path: "src",
        max_output_chars: 100,
        timeout_ms: 123,
      },
      toolContext("/tmp/project"),
    );

    expect(result).toBe("delegated exploration");
    expect(request?.cwd).toBe("/tmp/project");
    expect(request?.timeoutMs).toBe(123);
    expect(request?.args).toContain("--workspace");
    expect(request?.args).toContain("/tmp/project");
  });

  test("rejects explore_fast paths outside the workspace before spawning", async () => {
    let spawned = false;
    const runner: ExploreFastProcessRunner = async () => {
      spawned = true;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "unused" }),
        stderr: "",
      };
    };
    const hooks = createConductorHooks({ exploreFastRunner: runner });
    const exploreFast = hooks.tool?.explore_fast;
    if (!exploreFast) throw new Error("explore_fast tool was not registered");

    const result = await exploreFast.execute(
      {
        query: "find plan tools",
        path: "../outside",
      },
      toolContext("/tmp/project"),
    );

    expect(result).toContain("explore-fast path must stay inside workspace");
    expect(spawned).toBe(false);
  });
});

type HooksUnderTest = ReturnType<typeof createConductorHooks>;
type ToolContextUnderTest = ReturnType<typeof toolContext>;
type ToolUnderTest = {
  execute(args: Record<string, unknown>, context: ToolContextUnderTest): Promise<unknown>;
};

function getTool(hooks: HooksUnderTest, name: string): ToolUnderTest {
  const tools: unknown = hooks.tool;
  if (!isRecord(tools)) throw new Error("Conductor hooks did not register tools");
  const candidate = tools[name];
  if (!isToolUnderTest(candidate)) throw new Error(`${name} tool was not registered`);
  return candidate;
}

function isToolUnderTest(value: unknown): value is ToolUnderTest {
  return isRecord(value) && typeof value.execute === "function";
}

async function readJsonRecord(file: string): Promise<Record<string, unknown>> {
  return parseJsonRecord(await readFile(file, "utf8"));
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!isRecord(parsed)) throw new Error("expected JSON object");
  return parsed;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`expected ${key} to be an object`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected ${key} to be a string`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`expected ${key} to be a number`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`expected ${key} to contain strings`);
    strings.push(item);
  }
  return strings;
}

function requiredNumberArray(record: Record<string, unknown>, key: string): number[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") throw new Error(`expected ${key} to contain numbers`);
    numbers.push(item);
  }
  return numbers;
}

function requiredRecordArray(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`expected ${key} to contain objects`);
    records.push(item);
  }
  return records;
}

function firstRecord(records: Record<string, unknown>[]): Record<string, unknown> {
  const first = records[0];
  if (!first) throw new Error("expected at least one object");
  return first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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
