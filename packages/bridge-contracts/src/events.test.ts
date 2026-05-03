/**
 * packages/bridge-contracts/src/events.test.ts
 *
 * Tests for the event envelope and freshness contracts.
 *
 * Key invariants tested:
 * 1. appendEventInputSchema accepts valid append input without `seq`
 * 2. appendEventInputSchema rejects any input that provides `seq` (strict mode)
 * 3. pluginEventSchema requires DB-assigned `seq` and epoch identity
 * 4. freshQueryResultSchema supports all freshness variants with correct shape
 * 5. eventKindSchema enforces the dot-path format
 */

import { describe, expect, test } from "bun:test";
import {
  appendEventInputSchema,
  pluginEventSchema,
  freshQueryResultSchema,
  eventKindSchema,
} from "./events.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validAppendInput = {
  session_id: "ses_abc123",
  correlation_id: "corr_xyz",
  actor_id: "agent/planner",
  workspace_id: "ws_repo42",
  workspace_root: "/home/dev/myrepo",
  epoch_id: 7,
  plugin: "origin",
  kind: "origin.scan.completed",
  ts: 1746100000000,
  payload_hash: "sha256:abcdef1234567890",
};

// ---------------------------------------------------------------------------
// appendEventInputSchema
// ---------------------------------------------------------------------------

describe("appendEventInputSchema", () => {
  test("accepts a valid append input without seq", () => {
    const result = appendEventInputSchema.safeParse(validAppendInput);
    expect(result.success).toBe(true);
    if (result.success) {
      // Runtime check: the parsed shape has the expected fields
      expect(result.data.session_id).toBe(validAppendInput.session_id);
      expect(result.data.kind).toBe(validAppendInput.kind);
    }
  });

  test("accepts optional fields when provided", () => {
    const withOptionals = {
      ...validAppendInput,
      parent_seq: 3,
      snapshot_id: "sha256:deadbeef",
      tool_call_id: "tc_001",
    };
    const result = appendEventInputSchema.safeParse(withOptionals);
    expect(result.success).toBe(true);
  });

  test("rejects when caller provides seq (strict mode)", () => {
    const withSeq = { ...validAppendInput, seq: 42 };
    const result = appendEventInputSchema.safeParse(withSeq);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod v4 strict mode reports an unrecognized_keys issue for caller-supplied `seq`.
      // $ZodIssue is a discriminated union on .code, so narrowing on .code === "unrecognized_keys"
      // makes .keys available without any type assertion.
      const hasSeqIssue = result.error.issues.some(
        (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("seq"),
      );
      expect(hasSeqIssue).toBe(true);
    }
  });

  test("rejects unknown extra fields (strict mode)", () => {
    const withExtra = { ...validAppendInput, extra_field: "not allowed" };
    const result = appendEventInputSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  test("rejects when required fields are missing", () => {
    const { session_id: _omitted, ...withoutSessionId } = validAppendInput;
    const result = appendEventInputSchema.safeParse(withoutSessionId);
    expect(result.success).toBe(false);
  });

  test("rejects an empty string for session_id", () => {
    const result = appendEventInputSchema.safeParse({ ...validAppendInput, session_id: "" });
    expect(result.success).toBe(false);
  });

  test("rejects an invalid event kind", () => {
    const result = appendEventInputSchema.safeParse({ ...validAppendInput, kind: "INVALID KIND" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pluginEventSchema
// ---------------------------------------------------------------------------

describe("pluginEventSchema", () => {
  const validPluginEvent = {
    ...validAppendInput,
    seq: 99,
  };

  test("accepts a fully-materialized plugin event with DB-assigned seq", () => {
    const result = pluginEventSchema.safeParse(validPluginEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(99);
      expect(result.data.epoch_id).toBe(7);
    }
  });

  test("requires seq to be a positive integer", () => {
    const withZeroSeq = { ...validPluginEvent, seq: 0 };
    const result = pluginEventSchema.safeParse(withZeroSeq);
    // seq: 0 fails z.number().int().positive()
    expect(result.success).toBe(false);
  });

  test("requires seq to be present", () => {
    // Without seq, pluginEventSchema should fail since seq is required
    const result = pluginEventSchema.safeParse(validAppendInput);
    expect(result.success).toBe(false);
  });

  test("requires epoch_id to be present", () => {
    const { epoch_id: _omitted, ...withoutEpoch } = validPluginEvent;
    const result = pluginEventSchema.safeParse(withoutEpoch);
    expect(result.success).toBe(false);
  });

  test("rejects extra fields (strict mode)", () => {
    const withExtra = { ...validPluginEvent, undocumented: true };
    const result = pluginEventSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// freshQueryResultSchema
// ---------------------------------------------------------------------------

describe("freshQueryResultSchema", () => {
  test("accepts a fresh result with current data", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "fresh",
      data: { decisions: [], confidence: "high" },
      as_of_seq: 100,
      epoch_id: 7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("fresh");
    }
  });

  test("accepts a stale result with metadata", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "stale",
      data: { decisions: [{ id: "old-decision" }] },
      as_of_seq: 50,
      epoch_id: 4,
      current_epoch_id: 7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("stale");
    }
  });

  test("accepts a stale result without data (data is optional for stale)", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "stale",
      as_of_seq: 50,
      epoch_id: 4,
      current_epoch_id: 7,
    });
    expect(result.success).toBe(true);
  });

  test("accepts a recomputing result", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "recomputing",
      as_of_seq: 80,
      epoch_id: 6,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("recomputing");
    }
  });

  test("accepts an unavailable result with no seq data", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "unavailable",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("unavailable");
    }
  });

  test("rejects an unknown status value", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "pending",
      data: {},
      as_of_seq: 1,
      epoch_id: 1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects fresh result without as_of_seq", () => {
    const result = freshQueryResultSchema.safeParse({
      status: "fresh",
      data: {},
      epoch_id: 7,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eventKindSchema
// ---------------------------------------------------------------------------

describe("eventKindSchema", () => {
  test("accepts single-segment core kinds", () => {
    expect(eventKindSchema.safeParse("tool").success).toBe(true);
  });

  test("accepts multi-segment plugin event kinds", () => {
    expect(eventKindSchema.safeParse("origin.scan.completed").success).toBe(true);
    expect(eventKindSchema.safeParse("tool.before").success).toBe(true);
    expect(eventKindSchema.safeParse("seal.api.breaking").success).toBe(true);
  });

  test("rejects uppercase segments", () => {
    expect(eventKindSchema.safeParse("Origin.scan").success).toBe(false);
  });

  test("rejects spaces", () => {
    expect(eventKindSchema.safeParse("tool before").success).toBe(false);
  });

  test("rejects leading dots", () => {
    expect(eventKindSchema.safeParse(".tool.before").success).toBe(false);
  });

  test("rejects trailing dots", () => {
    expect(eventKindSchema.safeParse("tool.before.").success).toBe(false);
  });

  test("rejects empty string", () => {
    expect(eventKindSchema.safeParse("").success).toBe(false);
  });
});
