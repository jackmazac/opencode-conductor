/**
 * packages/bridge-contracts/src/messages.test.ts
 *
 * Tests for the structured agent message contract.
 *
 * Key invariants tested:
 * 1. agentMessageSchema accepts a fully-specified block message with remediation
 * 2. agentMessageSchema accepts info messages without strict remediation requirement
 * 3. agentMessageSchema rejects malformed severity values
 * 4. agentMessageSchema rejects block/warn messages with empty remediation summary
 * 5. agentMessageSchema rejects extra unrecognized fields (strict mode)
 */

import { describe, expect, test } from "bun:test";
import { agentMessageSchema } from "./messages.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validBlockMessage = {
  message_id: "msg_abc123",
  severity: "block",
  violated_rule: "origin.no-direct-generated-edit",
  affected_object: "src/generated/api/client.ts",
  canonical_source: "specs/openapi.yaml",
  remediation: {
    summary: "Edit the source schema/IDL instead of this generated file.",
    source_paths: ["specs/openapi.yaml"],
    commands: ["bun run generate:api"],
    refs: ["docs/origin.md"],
  },
  source_plugin: "origin",
  source_module: "origin/scanner/openapi",
  no_reply: true,
  correlation_id: "corr_xyz789",
};

const validWarnMessage = {
  message_id: "msg_warn01",
  severity: "warn",
  violated_rule: "seal.additive-change-requires-review",
  affected_object: "packages/sdk/src/index.ts",
  canonical_source: "packages/sdk/src/index.ts",
  remediation: {
    summary: "New public export detected. Confirm this is intentional.",
    source_paths: ["packages/sdk/src/index.ts"],
  },
  source_plugin: "seal",
};

const validInfoMessage = {
  message_id: "msg_info01",
  severity: "info",
  violated_rule: "origin.scan.heuristic-only",
  affected_object: "src/lib/generated-helpers.ts",
  remediation: {
    summary: "File matches generated-file heuristics but no authoritative source map found.",
  },
  source_plugin: "origin",
};

// ---------------------------------------------------------------------------
// agentMessageSchema — accept valid messages
// ---------------------------------------------------------------------------

describe("agentMessageSchema — valid messages", () => {
  test("accepts a fully-specified block message with source/canonical paths/commands", () => {
    const result = agentMessageSchema.safeParse(validBlockMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("block");
      expect(result.data.violated_rule).toBe("origin.no-direct-generated-edit");
      expect(result.data.remediation.commands).toEqual(["bun run generate:api"]);
      expect(result.data.remediation.source_paths).toEqual(["specs/openapi.yaml"]);
      expect(result.data.no_reply).toBe(true);
    }
  });

  test("accepts a warn message with remediation summary", () => {
    const result = agentMessageSchema.safeParse(validWarnMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("warn");
    }
  });

  test("accepts an info message (remediation summary still required by schema)", () => {
    const result = agentMessageSchema.safeParse(validInfoMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe("info");
    }
  });

  test("accepts a message without optional fields", () => {
    const minimal = {
      message_id: "msg_min01",
      severity: "info",
      violated_rule: "portage.scan.unknown-sql",
      affected_object: "prisma/migrations/20240101_init/migration.sql",
      remediation: {
        summary: "Unknown SQL operations detected. Manual review required.",
      },
      source_plugin: "portage",
    };
    const result = agentMessageSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("accepts a message with correlation_id linking to an event spine event", () => {
    const withCorrelation = {
      ...validInfoMessage,
      correlation_id: "corr_abc456",
    };
    const result = agentMessageSchema.safeParse(withCorrelation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.correlation_id).toBe("corr_abc456");
    }
  });
});

// ---------------------------------------------------------------------------
// agentMessageSchema — reject invalid severity
// ---------------------------------------------------------------------------

describe("agentMessageSchema — severity validation", () => {
  test("rejects an invalid severity value", () => {
    const withBadSeverity = { ...validInfoMessage, severity: "critical" };
    const result = agentMessageSchema.safeParse(withBadSeverity);
    expect(result.success).toBe(false);
  });

  test("rejects an empty severity value", () => {
    const withEmpty = { ...validInfoMessage, severity: "" };
    const result = agentMessageSchema.safeParse(withEmpty);
    expect(result.success).toBe(false);
  });

  test("rejects a numeric severity value", () => {
    const withNumeric = { ...validInfoMessage, severity: 2 };
    const result = agentMessageSchema.safeParse(withNumeric);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agentMessageSchema — remediation invariant for warn/block
// ---------------------------------------------------------------------------

describe("agentMessageSchema — remediation invariant", () => {
  test("rejects a block message with empty remediation summary", () => {
    const withEmptySummary = {
      ...validBlockMessage,
      remediation: { ...validBlockMessage.remediation, summary: "" },
    };
    // agentRemediationSchema requires summary: z.string().min(1), so this
    // fails at the schema level before the superRefine even runs.
    const result = agentMessageSchema.safeParse(withEmptySummary);
    expect(result.success).toBe(false);
  });

  test("rejects a warn message with empty remediation summary", () => {
    const withEmptySummary = {
      ...validWarnMessage,
      remediation: { summary: "" },
    };
    const result = agentMessageSchema.safeParse(withEmptySummary);
    expect(result.success).toBe(false);
  });

  test("rejects a block message with whitespace-only remediation summary via superRefine", () => {
    // z.string().min(1) counts spaces as characters, so we need to test the superRefine
    // path that checks for non-empty trimmed content.
    const withWhitespaceSummary = {
      ...validBlockMessage,
      remediation: { ...validBlockMessage.remediation, summary: "   " },
    };
    // The superRefine fires after base schema validation passes (min(1) passes for "   ")
    const result = agentMessageSchema.safeParse(withWhitespaceSummary);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasRemediationIssue = result.error.issues.some(
        (issue) => issue.path.includes("remediation") || issue.path.includes("summary"),
      );
      expect(hasRemediationIssue).toBe(true);
    }
  });

  test("rejects a warn message with whitespace-only remediation summary via superRefine", () => {
    const withWhitespaceSummary = {
      ...validWarnMessage,
      remediation: { summary: "   " },
    };
    const result = agentMessageSchema.safeParse(withWhitespaceSummary);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agentMessageSchema — strict mode (no extra fields)
// ---------------------------------------------------------------------------

describe("agentMessageSchema — strict mode", () => {
  test("rejects unrecognized extra fields", () => {
    const withExtra = { ...validBlockMessage, internal_tag: "should-not-be-here" };
    const result = agentMessageSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agentMessageSchema — required fields
// ---------------------------------------------------------------------------

describe("agentMessageSchema — required fields", () => {
  test("rejects when message_id is missing", () => {
    const { message_id: _omitted, ...withoutId } = validBlockMessage;
    const result = agentMessageSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  test("rejects when violated_rule is missing", () => {
    const { violated_rule: _omitted, ...withoutRule } = validBlockMessage;
    const result = agentMessageSchema.safeParse(withoutRule);
    expect(result.success).toBe(false);
  });

  test("rejects when affected_object is missing", () => {
    const { affected_object: _omitted, ...withoutObject } = validBlockMessage;
    const result = agentMessageSchema.safeParse(withoutObject);
    expect(result.success).toBe(false);
  });

  test("rejects when remediation is missing entirely", () => {
    const { remediation: _omitted, ...withoutRemediation } = validBlockMessage;
    const result = agentMessageSchema.safeParse(withoutRemediation);
    expect(result.success).toBe(false);
  });

  test("rejects when source_plugin is missing", () => {
    const { source_plugin: _omitted, ...withoutPlugin } = validBlockMessage;
    const result = agentMessageSchema.safeParse(withoutPlugin);
    expect(result.success).toBe(false);
  });
});
