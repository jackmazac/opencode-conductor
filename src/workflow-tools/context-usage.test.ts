import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createContextUsageTool, type ContextUsageClient } from "./context-usage";

describe("context_usage", () => {
  test("returns an empty-session message", async () => {
    const tool = createContextUsageTool(clientWithMessages([]));

    const result = await tool.execute({}, toolContext("empty-session"));

    expect(result).toBe("Session empty-session has no messages yet.");
  });

  test("summarizes user, assistant, tool, and reasoning tokens", async () => {
    const tool = createContextUsageTool(
      clientWithMessages([
        {
          info: {
            id: "assistant-1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4o",
            system: ["You are a concise coding assistant."],
          },
          parts: [
            { type: "text", text: "I can help with the implementation." },
            { type: "reasoning", text: "Need to inspect tests and edge cases." },
            {
              type: "tool",
              tool: "read",
              state: { status: "completed", output: "file content output" },
            },
          ],
        },
        {
          info: { id: "user-1", role: "user", providerID: "openai", modelID: "gpt-4o" },
          parts: [{ type: "text", text: "Please summarize context usage." }],
        },
      ]),
    );

    const result = await tool.execute({ limitMessages: 3 }, toolContext("summary-session"));

    expect(String(result)).toContain("Context Analysis: Session summary-session");
    expect(String(result)).toContain("SYSTEM");
    expect(String(result)).toContain("USER");
    expect(String(result)).toContain("ASSISTANT");
    expect(String(result)).toContain("TOOLS");
    expect(String(result)).toContain("REASONING");
    expect(String(result)).toContain("Top Contributors:");
    expect(String(result)).toContain("read");
  });

  test("uses assistant token telemetry when available", async () => {
    const tool = createContextUsageTool(
      clientWithMessages([
        {
          info: {
            id: "assistant-budget",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4o",
            system: ["budget system prompt"],
            tokens: {
              input: 120000,
              output: 60000,
              reasoning: 30000,
              cache: { read: 10000, write: 5000 },
            },
          },
          parts: [
            { type: "text", text: "assistant output" },
            { type: "reasoning", text: "reasoning output" },
          ],
        },
        {
          info: { id: "user-budget", role: "user", providerID: "openai", modelID: "gpt-4o" },
          parts: [{ type: "text", text: "budget question" }],
        },
      ]),
    );

    const result = await tool.execute({ sessionID: "budget-session" }, toolContext("fallback"));

    expect(String(result)).toContain("Context Analysis: Session budget-session");
    expect(String(result)).toContain("225,000 tokens");
    expect(String(result)).toContain("60,000 tokens");
    expect(String(result)).toContain("30,000 tokens");
  });

  test("reports tokenizer resolution errors for unrecognized sessions", async () => {
    const tool = createContextUsageTool(
      clientWithMessages([
        {
          info: { id: "unknown", role: "user", providerID: "mystery", modelID: "model-x" },
          parts: [{ type: "text", text: "hello" }],
        },
      ]),
    );

    const result = await tool.execute({}, toolContext("unknown-session"));

    expect(String(result)).toContain("Unable to resolve a tokenizer for session unknown-session.");
    expect(String(result)).toContain("Models considered: model-x");
    expect(String(result)).toContain("Providers observed: mystery");
  });
});

function clientWithMessages(messages: unknown[]): ContextUsageClient {
  return {
    session: {
      async messages() {
        return { data: messages };
      },
    },
  };
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "message",
    agent: "test-agent",
    directory: "/tmp/opencode-conductor-context-usage-test",
    worktree: "/tmp/opencode-conductor-context-usage-test",
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      return Effect.void;
    },
  };
}
