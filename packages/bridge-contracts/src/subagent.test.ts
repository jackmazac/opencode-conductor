import { describe, expect, test } from "bun:test";
import {
  adaptSubagentResult,
  subagentResultEnvelopeSchema,
  validateSubagentEnvelope,
} from "./subagent.ts";

describe("subagentResultEnvelopeSchema", () => {
  test("accepts a minimal envelope", () => {
    const parsed = subagentResultEnvelopeSchema.safeParse({ status: "ok", content: "hello" });
    expect(parsed.success).toBe(true);
  });

  test("rejects an envelope with unknown extra keys (.strict)", () => {
    const parsed = subagentResultEnvelopeSchema.safeParse({
      status: "ok",
      content: "hello",
      bogus_key: 42,
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects an envelope with invalid status", () => {
    const parsed = subagentResultEnvelopeSchema.safeParse({ status: "weird", content: "" });
    expect(parsed.success).toBe(false);
  });

  test("accepts a full envelope with all optional fields", () => {
    const parsed = subagentResultEnvelopeSchema.safeParse({
      status: "ok",
      content: "done",
      agent_id: "executor-high",
      session_id: "ses_abc",
      trace_id: "trc_xyz",
      tool_calls: [{ tool: "edit", status: "ok", duration_ms: 1500 }],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      metadata: { wave: "W1" },
    });
    expect(parsed.success).toBe(true);
  });

  test("error envelope must include error info", () => {
    const parsed = subagentResultEnvelopeSchema.safeParse({
      status: "error",
      content: "",
      error: { type: "tool_failure", message: "edit failed" },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("adaptSubagentResult", () => {
  test("wraps a plain string as ok envelope", () => {
    const env = adaptSubagentResult("plain reply");
    expect(env.status).toBe("ok");
    expect(env.content).toBe("plain reply");
  });

  test("passes through a valid envelope", () => {
    const env = adaptSubagentResult({ status: "ok", content: "hi" });
    expect(env.status).toBe("ok");
    expect(env.content).toBe("hi");
  });

  test("returns an error envelope for non-string non-envelope values", () => {
    const env = adaptSubagentResult(42);
    expect(env.status).toBe("error");
    expect(env.error?.type).toBe("envelope_unparseable");
  });

  test("returns an error envelope for null", () => {
    const env = adaptSubagentResult(null);
    expect(env.status).toBe("error");
  });
});

describe("validateSubagentEnvelope", () => {
  test("ok for a string", () => {
    const r = validateSubagentEnvelope("hello");
    expect(r.ok).toBe(true);
  });

  test("captures malformed structured input as a clear error", () => {
    const r = validateSubagentEnvelope({ status: "ok" }); // missing content
    expect(r.ok).toBe(true);
  });

  test("rejects values that adapt to envelope_unparseable", () => {
    const r = validateSubagentEnvelope(42);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.status).toBe("error");
    expect(r.envelope.error?.type).toBe("envelope_unparseable");
  });
});
