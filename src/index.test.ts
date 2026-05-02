import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ExploreFastProcessRequest, ExploreFastProcessRunner } from "./explore-fast"
import { createConductorHooks } from "./index"

describe("ConductorPlugin tools", () => {
  test("exposes explore_fast without removing plan artifact tools", () => {
    const hooks = createConductorHooks()

    expect(hooks.tool?.persist_subplan).toBeDefined()
    expect(hooks.tool?.read_subplan).toBeDefined()
    expect(hooks.tool?.discard_subplan).toBeDefined()
    expect(hooks.tool?.persist_final_plan).toBeDefined()
    expect(hooks.tool?.read_final_plan).toBeDefined()
    expect(hooks.tool?.discard_final_plan).toBeDefined()
    expect(hooks.tool?.explore_fast).toBeDefined()
    expect(hooks.tool?.explore_fast.description).toContain("Cursor CLI")
  })

  test("preserves migrated workflow tool names", () => {
    const hooks = createConductorHooks()
    const toolNames = [
      "audit_write",
      "audit_read",
      "audit_done",
      "audit_progress_update",
      "audit_progress_read",
      "audit_progress_done",
      "handoff_write",
      "handoff_read",
      "handoff_done",
      "journal_write",
      "journal_read",
      "journal_done",
      "progress_update",
      "progress_read",
      "progress_done",
      "status_write",
      "status_read",
      "status_done",
    ]

    for (const name of toolNames) {
      expect(Object.hasOwn(hooks.tool ?? {}, name)).toBe(true)
    }
  })

  test("delegates explore_fast execution to the Cursor runner", async () => {
    let request: ExploreFastProcessRequest | undefined
    const runner: ExploreFastProcessRunner = async (input) => {
      request = input
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "delegated exploration" }),
        stderr: "",
      }
    }
    const hooks = createConductorHooks({ exploreFastRunner: runner })
    const exploreFast = hooks.tool?.explore_fast
    if (!exploreFast) throw new Error("explore_fast tool was not registered")

    const result = await exploreFast.execute(
      {
        query: "find plan tools",
        path: "src",
        max_output_chars: 100,
        timeout_ms: 123,
      },
      toolContext("/tmp/project"),
    )

    expect(result).toBe("delegated exploration")
    expect(request?.cwd).toBe("/tmp/project")
    expect(request?.timeoutMs).toBe(123)
    expect(request?.args).toContain("--workspace")
    expect(request?.args).toContain("/tmp/project")
  })

  test("rejects explore_fast paths outside the workspace before spawning", async () => {
    let spawned = false
    const runner: ExploreFastProcessRunner = async () => {
      spawned = true
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "unused" }),
        stderr: "",
      }
    }
    const hooks = createConductorHooks({ exploreFastRunner: runner })
    const exploreFast = hooks.tool?.explore_fast
    if (!exploreFast) throw new Error("explore_fast tool was not registered")

    const result = await exploreFast.execute(
      {
        query: "find plan tools",
        path: "../outside",
      },
      toolContext("/tmp/project"),
    )

    expect(result).toContain("explore-fast path must stay inside workspace")
    expect(spawned).toBe(false)
  })
})

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
      return Effect.void
    },
  }
}
