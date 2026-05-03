import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExploreFastProcessRequest, ExploreFastProcessRunner } from "./explore-fast";
import { createConductorHooks } from "./index";

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
      expect(Object.hasOwn(hooks.tool ?? {}, name)).toBe(true);
    }
  });

  test("run_init creates a structured run correlation record", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-init-"));
    try {
      const hooks = createConductorHooks();
      const runInit = (
        hooks.tool as unknown as Record<
          string,
          {
            execute: (
              args: Record<string, unknown>,
              context: ReturnType<typeof toolContext>,
            ) => Promise<unknown>;
          }
        >
      )["run_init"];
      if (!runInit) throw new Error("run_init tool was not registered");

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
      const parsed = JSON.parse(String(result)) as {
        agent_run_id: string;
        correlation_id: string;
        workspace_id: string;
        file: string;
        status_file: string;
        status_slug: string;
      };

      expect(parsed.agent_run_id.startsWith("run_")).toBe(true);
      expect(parsed.correlation_id.startsWith("corr_")).toBe(true);
      expect(parsed.workspace_id.startsWith("ws_")).toBe(true);
      expect(parsed.file.startsWith(".opencode/runs/run_")).toBe(true);
      expect(parsed.status_slug.startsWith("run-")).toBe(true);
      expect(parsed.status_file.startsWith(".opencode/status/run-")).toBe(true);
      const status = JSON.parse(await readFile(join(root, parsed.status_file), "utf8")) as {
        agent_run_id: string;
        correlation_id: string;
        run_file: string;
      };
      expect(status.agent_run_id).toBe(parsed.agent_run_id);
      expect(status.correlation_id).toBe(parsed.correlation_id);
      expect(status.run_file).toBe(parsed.file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run_update and run_finish progress run and status records", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-run-progress-"));
    try {
      const hooks = createConductorHooks();
      const tools = hooks.tool as unknown as Record<
        string,
        {
          execute: (
            args: Record<string, unknown>,
            context: ReturnType<typeof toolContext>,
          ) => Promise<unknown>;
        }
      >;
      const created = JSON.parse(
        String(
          await tools.run_init!.execute(
            { agent_type: "executor-high", goal: "finish run", paths: ["src/a.ts"] },
            toolContext(root),
          ),
        ),
      ) as { agent_run_id: string; status_file: string };

      const updated = JSON.parse(
        String(
          await tools.run_update!.execute(
            {
              agent_run_id: created.agent_run_id,
              status: "in_progress",
              current: "editing files",
              pending: ["validate"],
            },
            toolContext(root),
          ),
        ),
      ) as { status: string; current: string };
      expect(updated.status).toBe("in_progress");
      expect(updated.current).toBe("editing files");

      const finished = JSON.parse(
        String(
          await tools.run_finish!.execute(
            { agent_run_id: created.agent_run_id, summary: "validated" },
            toolContext(root),
          ),
        ),
      ) as { status: string; finished_at: string; status_file: string };
      const status = JSON.parse(await readFile(join(root, finished.status_file), "utf8")) as {
        current: string;
        pending: string[];
        completed: string[];
      };

      expect(finished.status).toBe("done");
      expect(typeof finished.finished_at).toBe("string");
      expect(status.current).toBe("validated");
      expect(status.pending).toEqual([]);
      expect(status.completed).toEqual(["validated"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lifecycle_concord_ingest writes Concord artifacts from JSON input", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-concord-ingest-"));
    try {
      const hooks = createConductorHooks();
      const ingest = (
        hooks.tool as unknown as Record<
          string,
          {
            execute: (
              args: Record<string, unknown>,
              context: ReturnType<typeof toolContext>,
            ) => Promise<unknown>;
          }
        >
      )["lifecycle_concord_ingest"];
      if (!ingest) throw new Error("lifecycle_concord_ingest tool was not registered");
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
      const summary = JSON.parse(String(result)) as {
        artifacts_written: number;
        spine_seqs: number[];
      };
      const artifact = JSON.parse(
        await readFile(
          join(root, ".opencode", "lifecycle", "artifacts", "concord", "42.json"),
          "utf8",
        ),
      ) as { event_id: string; spine_seq: number };

      expect(summary.artifacts_written).toBe(1);
      expect(summary.spine_seqs.length).toBe(1);
      expect(artifact.event_id).toBe("42");
      expect(artifact.spine_seq).toBe(summary.spine_seqs[0]!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("conflict_context runs one Engram context command with correlation flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "conductor-conflict-context-"));
    try {
      const fakeEngram = join(root, "fake-engram.ts");
      await Bun.write(fakeEngram, "console.log(JSON.stringify({ argv: process.argv.slice(2) }))\n");
      const hooks = createConductorHooks();
      const conflictContext = (
        hooks.tool as unknown as Record<
          string,
          {
            execute: (
              args: Record<string, unknown>,
              context: ReturnType<typeof toolContext>,
            ) => Promise<unknown>;
          }
        >
      )["conflict_context"];
      if (!conflictContext) throw new Error("conflict_context tool was not registered");

      const result = JSON.parse(
        String(
          await conflictContext.execute(
            {
              project_id: "proj_1",
              correlation_id: "corr_1",
              concord_event_ids: ["42"],
              artifact_refs: ["artifact:concord:42"],
              engram_command: `bun ${fakeEngram}`,
              ingest_artifacts: false,
              json: true,
            },
            toolContext(root),
          ),
        ),
      ) as { context: { output: string } };
      const output = JSON.parse(result.context.output) as { argv: string[] };

      expect(output.argv).toContain("context");
      expect(output.argv).toContain("--correlation-id");
      expect(output.argv).toContain("corr_1");
      expect(output.argv).toContain("--concord-event-id");
      expect(output.argv).toContain("42");
      expect(output.argv).toContain("--artifact-ref");
      expect(output.argv).toContain("artifact:concord:42");
    } finally {
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
