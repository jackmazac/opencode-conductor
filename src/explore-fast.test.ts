import { describe, expect, test } from "bun:test"
import { buildExploreFastCommand, runExploreFast, type ExploreFastProcessRunner } from "./explore-fast"

describe("explore fast command", () => {
  test("builds a Cursor CLI JSON print-mode command for Composer 2 Fast", () => {
    const command = buildExploreFastCommand({
      directory: "/tmp/project",
      query: "find auth flow",
    })

    expect(command.executable).toBe("agent")
    expect(command.args).toContain("-p")
    expect(command.args).toContain("--model")
    expect(command.args).toContain("composer-2-fast")
    expect(command.args).toContain("--mode")
    expect(command.args).toContain("ask")
    expect(command.args).toContain("--output-format")
    expect(command.args).toContain("json")
    expect(command.args).toContain("--workspace")
    expect(command.args).toContain("/tmp/project")
    expect(command.args).not.toContain("--force")
    expect(command.args).not.toContain("--yolo")
  })

  test("rejects empty queries before spawning Cursor", async () => {
    let spawned = false
    const runner: ExploreFastProcessRunner = async () => {
      spawned = true
      return { exitCode: 0, stdout: '{"result":"unused"}', stderr: "" }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "   ",
      runner,
    })

    expect(result).toContain("explore-fast query is required")
    expect(spawned).toBe(false)
  })

  test("parses Cursor JSON output into bounded findings", async () => {
    const runner: ExploreFastProcessRunner = async () => {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "## Auth\n\nFound auth flow." }),
        stderr: "",
      }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      maxOutputChars: 100,
      runner,
    })

    expect(result).toBe("## Auth\n\nFound auth flow.")
  })

  test("reports malformed Cursor JSON output", async () => {
    const runner: ExploreFastProcessRunner = async () => {
      return { exitCode: 0, stdout: "not-json", stderr: "" }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      runner,
    })

    expect(result).toContain("Cursor CLI returned malformed JSON")
    expect(result).toContain("not-json")
  })

  test("truncates output that exceeds the configured cap", async () => {
    const runner: ExploreFastProcessRunner = async () => {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: "abcdefghijklmnopqrstuvwxyz" }),
        stderr: "",
      }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      maxOutputChars: 10,
      runner,
    })

    expect(result).toBe("abcdefghij\n\n[truncated - 16 chars omitted]")
  })

  test("reports non-zero Cursor exits with bounded stderr", async () => {
    const runner: ExploreFastProcessRunner = async () => {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "authentication failed because no API key was configured",
      }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      maxErrorChars: 24,
      runner,
    })

    expect(result).toContain("Cursor CLI failed with exit code 2")
    expect(result).toContain("authentication failed be")
    expect(result).toContain("[truncated - 31 chars omitted]")
  })

  test("reports timeout failures from the runner", async () => {
    const runner: ExploreFastProcessRunner = async () => {
      return {
        exitCode: undefined,
        stdout: "",
        stderr: "process exceeded timeout",
        timedOut: true,
      }
    }

    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      timeoutMs: 5,
      runner,
    })

    expect(result).toContain("Cursor CLI timed out after 5ms")
  })
})
