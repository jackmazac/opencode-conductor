import { describe, expect, test } from "bun:test";

import { toArgv, type ExploreFastEvent } from "./cursor-cli-types";
import {
  runExploreFast,
  streamExploreFast,
  type ExploreFastSpawnFn,
  type ExploreFastSpawnInput,
  type ExploreFastSubprocess,
} from "./explore-fast";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (chunk.length > 0) controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

type FakeProcessConfig = {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exitCode?: number;
};

function fakeSpawn(config: FakeProcessConfig): {
  fn: ExploreFastSpawnFn;
  calls: ExploreFastSpawnInput[];
} {
  const calls: ExploreFastSpawnInput[] = [];
  const fn: ExploreFastSpawnFn = (input) => {
    calls.push(input);
    const proc: ExploreFastSubprocess = {
      stdout: config.stdout ?? emptyStream(),
      stderr: config.stderr ?? emptyStream(),
      exited: Promise.resolve(config.exitCode ?? 0),
    };
    return proc;
  };
  return { fn, calls };
}

/** A spawn that hangs forever until its caller aborts. Used for timeout tests. */
function stallingSpawn(options: {
  seed?: string;
} = {}): { fn: ExploreFastSpawnFn; calls: ExploreFastSpawnInput[] } {
  const calls: ExploreFastSpawnInput[] = [];
  const fn: ExploreFastSpawnFn = (input) => {
    calls.push(input);
    const safeClose = (stream: ReadableStreamDefaultController<Uint8Array>) => {
      try {
        stream.close();
      } catch {
        // Abort may notify both streams; a second close() throws. Listener errors
        // surface after abort() returns — must not throw from the handler.
      }
    };
    const stdout = new ReadableStream<Uint8Array>({
      start(stream) {
        if (options.seed !== undefined) stream.enqueue(encoder.encode(options.seed));
        input.signal.addEventListener("abort", () => safeClose(stream));
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(stream) {
        input.signal.addEventListener("abort", () => safeClose(stream));
      },
    });
    const exited = new Promise<number>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(143));
    });
    return { stdout, stderr, exited };
  };
  return { fn, calls };
}

const eventLine = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;

/** Real Cursor CLI shape: assistant with nested `message.content[]`. */
const assistantLine = (
  ...content: ReadonlyArray<Record<string, unknown>>
): string => eventLine({ type: "assistant", message: { content } });

const textContent = (text: string) => ({ type: "text", text });
const toolUseContent = (name: string, input?: unknown) =>
  input === undefined ? { type: "tool_use", name } : { type: "tool_use", name, input };

const resultLine = (result?: string): string =>
  result === undefined ? eventLine({ type: "result" }) : eventLine({ type: "result", result });

const errorResultLine = (error: string): string =>
  eventLine({ type: "result", is_error: true, error });

const systemLine = () =>
  eventLine({ type: "system", subtype: "init", apiKeySource: "login", model: "composer-2-fast" });

const userLine = (prompt: string) =>
  eventLine({ type: "user", message: { content: [{ type: "text", text: prompt }] } });

// ---------------------------------------------------------------------------
// toArgv — typed flag layout
// ---------------------------------------------------------------------------

describe("toArgv", () => {
  test("emits the Cursor CLI argv in exact order for Composer 2 Fast", () => {
    const argv = toArgv({
      model: "composer-2-fast",
      mode: "ask",
      outputFormat: "stream-json",
      workspace: "/tmp/project",
      prompt: "find auth flow",
    });

    expect([...argv]).toEqual([
      "-p",
      "--model",
      "composer-2-fast",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      "--workspace",
      "/tmp/project",
      "find auth flow",
    ]);
  });

  test("never emits dangerous mode flags", () => {
    const argv = toArgv({
      model: "composer-2-fast",
      mode: "ask",
      outputFormat: "stream-json",
      workspace: "/tmp/project",
      prompt: "find auth flow",
    });
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--yolo");
  });
});

// ---------------------------------------------------------------------------
// streamExploreFast / runExploreFast
// ---------------------------------------------------------------------------

describe("runExploreFast", () => {
  test("rejects empty queries before creating any subprocess", async () => {
    const { fn, calls } = fakeSpawn({});
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "   ",
      spawn: fn,
    });

    expect(result).toBe("explore-fast query is required");
    expect(calls).toHaveLength(0);
  });

  test("rejects target paths outside the workspace", async () => {
    const { fn, calls } = fakeSpawn({});
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      path: "../../etc/passwd",
      spawn: fn,
    });

    expect(result).toBe("explore-fast path must stay inside workspace");
    expect(calls).toHaveLength(0);
  });

  test("invokes the agent CLI with composer-2-fast at the workspace cwd", async () => {
    const { fn, calls } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent("ok")) + resultLine("")),
    });
    await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd[0]).toBe("agent");
    expect([...call.cmd].slice(1, 8)).toEqual([
      "-p",
      "--model",
      "composer-2-fast",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
    ]);
    expect(call.cwd).toBe("/tmp/project");
  });

  test("upgrades to composer-2 when thoroughness=exhaustive", async () => {
    const { fn, calls } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent("ok")) + resultLine("")),
    });
    await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      thoroughness: "exhaustive",
      spawn: fn,
    });

    const cmd = [...calls[0]!.cmd];
    const modelIdx = cmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("composer-2");
  });

  test("writes the thoroughness tier into the prompt so the agent adapts depth", async () => {
    const { fn, calls } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent("ok")) + resultLine("")),
    });
    await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      thoroughness: "quick",
      spawn: fn,
    });

    // The final argv entry is the assembled prompt — assert the directive is in it.
    const prompt = calls[0]!.cmd[calls[0]!.cmd.length - 1];
    expect(prompt).toContain("# Thoroughness\nquick");
  });

  test("defaults to thoroughness=standard when omitted", async () => {
    const { fn, calls } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent("ok")) + resultLine("")),
    });
    await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    const prompt = calls[0]!.cmd[calls[0]!.cmd.length - 1];
    expect(prompt).toContain("# Thoroughness\nstandard");
  });

  test("explicit timeoutMs overrides the thoroughness tier default", async () => {
    // Use a stalling spawn with thoroughness=exhaustive (default 300s) but
    // an explicit 5ms timeout. If the explicit override didn't win, the test
    // would hang for the full tier default.
    const { fn, calls } = stallingSpawn();
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      thoroughness: "exhaustive",
      timeoutMs: 5,
      spawn: fn,
    });

    expect(result).toBe("Cursor CLI timed out after 5ms");
    expect(calls[0]!.signal.reason).toBe("timeout");
  });

  test("explicit model overrides the thoroughness tier default", async () => {
    const { fn, calls } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent("ok")) + resultLine("")),
    });
    await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      thoroughness: "exhaustive", // tier default would be composer-2
      model: "composer-2-fast", // explicit wins
      spawn: fn,
    });

    const cmd = [...calls[0]!.cmd];
    const modelIdx = cmd.indexOf("--model");
    expect(cmd[modelIdx + 1]).toBe("composer-2-fast");
  });

  test("concatenates assistant text content into the returned string", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(
        systemLine() +
          userLine("find auth flow") +
          assistantLine(textContent("## Auth\n\nFound auth flow.")) +
          resultLine(""),
      ),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("## Auth\n\nFound auth flow.");
  });

  test("preserves event order across multiple assistant events", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(
        assistantLine(textContent("first ")) +
          assistantLine(textContent("second")) +
          resultLine(""),
      ),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("first second");
  });

  test("falls back to result.result when no assistant text was streamed", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(resultLine("final summary")),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("final summary");
  });

  test("does not duplicate output when result.result echoes the assistant text", async () => {
    // The real Cursor CLI emits the same final body in both the assistant
    // event(s) AND the terminal result.result. We must prefer the streamed
    // text and drop the echo, not append both.
    const body = "## Findings\n\n- File A\n- File B";
    const { fn } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent(body)) + resultLine(body)),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe(body);
  });

  test("returns an empty string when the CLI produces no text and no result", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(systemLine() + userLine("find auth flow") + resultLine()),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("");
  });

  test("skips malformed NDJSON lines and unknown top-level event types", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(
        "not-json\n" +
          systemLine() +
          assistantLine(textContent("hello")) +
          "{}\n" + // missing type
          eventLine({ type: "unknown_future_event", payload: { foo: 1 } }) +
          resultLine(""),
      ),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("hello");
  });

  test("re-assembles lines split across chunk boundaries", async () => {
    const event = assistantLine(textContent("complete sentence"));
    // Split the line at every other character.
    const chunks: string[] = [];
    for (let i = 0; i < event.length; i += 3) chunks.push(event.slice(i, i + 3));
    chunks.push(resultLine(""));

    const { fn } = fakeSpawn({ stdout: streamFromChunks(chunks) });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("complete sentence");
  });

  test("returns the full streamed output without truncation", async () => {
    // No maxOutputChars: output is uncapped. The orchestrator's task harness
    // is the right place to bound subagent return size, not this library.
    const body = "x".repeat(50_000);
    const { fn } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent(body)) + resultLine("")),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe(body);
    expect(result).not.toContain("[truncated");
  });

  test("reports non-zero exits with bounded stderr", async () => {
    const { fn } = fakeSpawn({
      stdout: emptyStream(),
      stderr: streamFromText("authentication failed because no API key was configured"),
      exitCode: 2,
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      maxErrorChars: 24,
      spawn: fn,
    });

    expect(result).toContain("Cursor CLI failed with exit code 2");
    expect(result).toContain("authentication failed be");
    expect(result).toContain("[truncated - 31 chars omitted]");
  });

  test("reports a friendly message when stderr is empty on non-zero exit", async () => {
    const { fn } = fakeSpawn({
      stdout: emptyStream(),
      stderr: emptyStream(),
      exitCode: 1,
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toContain("Cursor CLI failed with exit code 1");
    expect(result).toContain("(no stderr)");
  });

  test("reports CLI error results (is_error=true) as the returned string", async () => {
    const { fn } = fakeSpawn({
      stdout: streamFromText(errorResultLine("model unavailable")),
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).toBe("model unavailable");
  });

  test("reports timeout failures and aborts the subprocess when no text was streamed", async () => {
    const { fn, calls } = stallingSpawn();
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      timeoutMs: 5,
      spawn: fn,
    });

    expect(result).toBe("Cursor CLI timed out after 5ms");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[0]!.signal.reason).toBe("timeout");
  });

  test("preserves partial assistant output when timing out mid-stream", async () => {
    // The agent has already streamed useful findings before our timeout fires.
    // Throwing that work away is a real correctness loss for `exhaustive` tier
    // explores where slow answers still beat empty ones.
    const partial = "## Auth flow (partial)\n\n- src/auth/login.ts:42 — entrypoint";
    const { fn, calls } = stallingSpawn({ seed: assistantLine(textContent(partial)) });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      timeoutMs: 5,
      spawn: fn,
    });

    expect(result).toBe(`[partial output — Cursor CLI timed out after 5ms]\n\n${partial}`);
    expect(calls[0]!.signal.reason).toBe("timeout");
  });

  test("does NOT preserve partial output on non-timeout errors (e.g. non-zero exit)", async () => {
    // A non-zero exit means the CLI itself reported failure — the agent's
    // partial reasoning is suspect. Drop it and return the error verbatim.
    const partial = "thinking out loud before crashing…";
    const { fn } = fakeSpawn({
      stdout: streamFromText(assistantLine(textContent(partial))),
      stderr: streamFromText("model crashed"),
      exitCode: 2,
    });
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    });

    expect(result).not.toContain("[partial output");
    expect(result).not.toContain(partial);
    expect(result).toContain("Cursor CLI failed with exit code 2");
  });

  test("reports synchronous spawn failures with bounded message", async () => {
    const fn: ExploreFastSpawnFn = () => {
      throw new Error("ENOENT: agent binary not found on PATH");
    };
    const result = await runExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      maxErrorChars: 20,
      spawn: fn,
    });

    expect(result).toContain("Cursor CLI failed to start:");
    expect(result).toContain("ENOENT: agent binary");
    expect(result).toContain("[truncated -");
  });
});

// ---------------------------------------------------------------------------
// streamExploreFast — incremental consumption
// ---------------------------------------------------------------------------

describe("streamExploreFast", () => {
  test("expands assistant message content into ordered typed events", async () => {
    // One `assistant` envelope can carry text → tool_use → more text in a single
    // content array. Our parser splits that into ordered ExploreFastEvent's.
    const { fn } = fakeSpawn({
      stdout: streamFromText(
        systemLine() +
          assistantLine(
            textContent("thinking…"),
            toolUseContent("Grep", { pattern: "auth" }),
            textContent(" done"),
          ) +
          resultLine(""),
      ),
    });

    const events: string[] = [];
    for await (const event of streamExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["assistant_text", "tool_call", "assistant_text", "done"]);
  });

  test("surfaces validation failures as a single error event", async () => {
    const { fn, calls } = fakeSpawn({});
    const events: ExploreFastEvent[] = [];
    for await (const event of streamExploreFast({
      directory: "/tmp/project",
      query: "",
      spawn: fn,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "error", kind: "validation", message: "explore-fast query is required" },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("aborts the subprocess when the caller breaks out of the stream early", async () => {
    // The spawn yields one assistant event, then hangs. The consumer pulls
    // that event and breaks. The async generator's finally must abort the
    // signal so Bun.spawn sends SIGTERM — otherwise the subprocess leaks.
    const { fn, calls } = stallingSpawn({
      seed: assistantLine(textContent("first chunk")),
    });

    for await (const event of streamExploreFast({
      directory: "/tmp/project",
      query: "find auth flow",
      systemPrompt: "system",
      spawn: fn,
    })) {
      expect(event.type).toBe("assistant_text");
      break;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[0]!.signal.reason).toBe("disposed");
  });
});

// ---------------------------------------------------------------------------
// Integration — exercises real Bun.spawn against the actual `agent` CLI.
// Skipped by default. Run with:
//   CURSOR_CLI_INTEGRATION=1 bun test src/explore-fast.test.ts
// ---------------------------------------------------------------------------

describe.skipIf(process.env.CURSOR_CLI_INTEGRATION !== "1")("integration: real agent CLI", () => {
  test("returns a non-empty answer for a small query", async () => {
    const result = await runExploreFast({
      directory: process.cwd(),
      query: "What does the package.json name field say?",
      timeoutMs: 30_000,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("Cursor CLI failed");
    expect(result).not.toContain("timed out");
  }, 60_000);
});
