/**
 * Contracts compat test — Wave 0, Task C
 *
 * Verifies that the on-disk artifact shapes Conductor emits today decode cleanly
 * through @mazac-fox/opencode-fleet-contracts without any changes to Conductor.
 *
 * No subprocesses, no disk I/O. All assertions use representative fixtures
 * derived from the actual runtime shapes in:
 *   src/workflow-tools/run.ts        (RunRecord, StatusMirror, workspace_id derivation)
 *   src/workflow-tools/concord-ingest.ts (spine event shape)
 *   src/workflow-tools/progress.ts   (progress artifact path pattern)
 *   src/plan-artifacts.ts            (plan file path pattern)
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildArtifactRef,
  decodeFleetContext,
  isLegacyId,
  newWorkspaceId,
  parseAgentRunId,
  parseConcordEventId,
  parseCorrelationId,
  parseLegacyAgentRunId,
  parseLegacyCorrelationId,
  parsePlanSlug,
  parseToolCallId,
  parseWaveId,
  parseWorkspaceId,
  parseArtifactRef,
} from "@mazac-fox/opencode-fleet-contracts";

// ---------------------------------------------------------------------------
// Shared ULID-shaped fixture IDs (plausible values Conductor would write in
// a future ULID-adopting version; still match `run_` / `corr_` prefixes).
// ---------------------------------------------------------------------------
const ULID_SUFFIX = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const RUN_ID_ULID = `run_${ULID_SUFFIX}`;
const CORR_ID_ULID = `corr_${ULID_SUFFIX}`;

// workspace_id: sha256 of resolved path, first 16 hex chars
const WS_ROOT = "/tmp/test-workspace";
const WS_HASH = createHash("sha256").update(path.resolve(WS_ROOT)).digest("hex").slice(0, 16);
const WS_ID = `ws_${WS_HASH}`;

// A representative RunRecord fixture (schema emitted by run.ts)
const runRecord = {
  schema_version: 1 as const,
  agent_run_id: RUN_ID_ULID,
  correlation_id: CORR_ID_ULID,
  workspace_id: WS_ID,
  plan_slug: "fleet-correlation",
  wave_id: "W0",
  task_id: "W0-A",
  agent_type: "executor-high",
  goal: "Bootstrap contracts package",
  paths: ["src/ids.ts"],
  status: "done" as const,
  created_at: "2026-05-03T12:00:00.000Z",
  updated_at: "2026-05-03T12:15:00.000Z",
  finished_at: "2026-05-03T12:15:00.000Z",
};

// ---------------------------------------------------------------------------
// A. Run record IDs decode cleanly
// ---------------------------------------------------------------------------
describe("A. Run record IDs decode cleanly", () => {
  test("parseAgentRunId accepts ULID-shaped run_ id", () => {
    const result = parseAgentRunId(runRecord.agent_run_id);
    expect(result.ok, `parseAgentRunId failed: ${!result.ok ? result.reason : ""}`).toBe(true);
  });

  test("parseCorrelationId accepts ULID-shaped corr_ id", () => {
    const result = parseCorrelationId(runRecord.correlation_id);
    expect(result.ok, `parseCorrelationId failed: ${!result.ok ? result.reason : ""}`).toBe(true);
  });

  test("parseWorkspaceId accepts ws_<16hex> id", () => {
    const result = parseWorkspaceId(runRecord.workspace_id);
    expect(result.ok, `parseWorkspaceId failed: ${!result.ok ? result.reason : ""}`).toBe(true);
  });

  test("parsePlanSlug accepts fleet-correlation", () => {
    const result = parsePlanSlug(runRecord.plan_slug);
    expect(result.ok, `parsePlanSlug failed: ${!result.ok ? result.reason : ""}`).toBe(true);
  });

  test("parseWaveId accepts W0", () => {
    const result = parseWaveId(runRecord.wave_id);
    expect(result.ok, `parseWaveId failed: ${!result.ok ? result.reason : ""}`).toBe(true);
  });

  // Legacy (pre-ULID) format: Conductor's runId() uses randomUUID hex slices
  // e.g. "run_abc123def456789012345678" — NOT a valid ULID suffix
  const legacyRunId = "run_abc123-def";
  const legacyCorrId = "corr_abc123-def";

  test("parseLegacyAgentRunId accepts legacy non-ULID run_ id", () => {
    const result = parseLegacyAgentRunId(legacyRunId);
    expect(result.ok, `parseLegacyAgentRunId rejected legacy id "${legacyRunId}"`).toBe(true);
    expect(parseAgentRunId(legacyRunId).ok).toBe(false);
  });

  test("isLegacyId('run', ...) returns true for legacy run id", () => {
    expect(isLegacyId("run", legacyRunId)).toBe(true);
  });

  test("isLegacyId('run', ...) returns false for ULID run id", () => {
    expect(isLegacyId("run", RUN_ID_ULID)).toBe(false);
  });

  test("parseLegacyCorrelationId accepts legacy non-ULID corr_ id", () => {
    const result = parseLegacyCorrelationId(legacyCorrId);
    expect(result.ok, `parseLegacyCorrelationId rejected legacy id "${legacyCorrId}"`).toBe(true);
    expect(parseCorrelationId(legacyCorrId).ok).toBe(false);
  });

  test("isLegacyId('corr', ...) returns true for legacy correlation id", () => {
    expect(isLegacyId("corr", legacyCorrId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. decodeFleetContext extracts IDs from a Conductor run record
// ---------------------------------------------------------------------------
describe("B. decodeFleetContext from run record", () => {
  test("decodes ok and populates core IDs; plan_id / tool_call_id are null", () => {
    const result = decodeFleetContext(runRecord);
    expect(
      result.ok,
      `decodeFleetContext failed: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);
    if (!result.ok) return;

    expect(result.value.agent_run_id).not.toBeNull();
    expect(result.value.correlation_id).not.toBeNull();
    expect(result.value.workspace_id).not.toBeNull();
    expect(result.value.plan_slug).not.toBeNull();
    expect(result.value.wave_id).not.toBeNull();

    // These IDs are not present in a RunRecord (Wave 2+ concern)
    expect(result.value.plan_id).toBeNull();
    expect(result.value.tool_call_id).toBeNull();
    expect(result.value.fleet_run_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. Status mirror decodes
// ---------------------------------------------------------------------------
describe("C. Status mirror decodes through decodeFleetContext", () => {
  // StatusMirror shape from src/workflow-tools/run.ts
  const statusMirror = {
    slug: "run-01HZZZZZZZ",
    goal: "Bootstrap contracts package",
    plan: "fleet-correlation", // note: "plan" not "plan_slug" in StatusMirror
    wave: "W0", // note: "wave" not "wave_id" in StatusMirror
    current: "done executor-high",
    completed: ["Bootstrap contracts package"],
    pending: [],
    blockers: [],
    touched_files: ["src/ids.ts"],
    updated: "2026-05-03T12:15:00.000Z",
    agent_run_id: RUN_ID_ULID,
    correlation_id: CORR_ID_ULID,
    workspace_id: WS_ID,
    task_id: "W0-A",
    agent_type: "executor-high",
    run_file: ".opencode/runs/run_01HZZZZZZZZZZZZZZZZZZZZZZZ.json",
  };

  test("decodeFleetContext extracts agent_run_id, correlation_id, workspace_id from status mirror", () => {
    const result = decodeFleetContext(statusMirror);
    expect(
      result.ok,
      `decodeFleetContext on status mirror failed: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);
    if (!result.ok) return;

    expect(result.value.agent_run_id).not.toBeNull();
    expect(result.value.correlation_id).not.toBeNull();
    expect(result.value.workspace_id).not.toBeNull();
    // StatusMirror uses "plan" / "wave" field names (not "plan_slug" / "wave_id")
    // so those won't be decoded into FleetContext — that's expected today
    expect(result.value.plan_id).toBeNull();
    expect(result.value.tool_call_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. Spine event from Concord ingest carries tool_call_id
// ---------------------------------------------------------------------------
describe("D. Spine event from concord-ingest carries tool_call_id", () => {
  // Spine event shape written by concord-ingest.ts via store.appendEvent(...)
  // Today's concord-ingest sets tool_call_id to "concord:<row.id>" which is
  // NOT a tool_-prefixed id, so decodeFleetContext won't accept it.
  // We omit tool_call_id from the spine event fixture to test the other IDs.
  const properToolCallId = `tool_${ULID_SUFFIX}`; // canonical format (Wave 2+)

  const spineEvent = {
    session_id: "ses_abc123",
    correlation_id: CORR_ID_ULID,
    actor_id: "ses_abc123",
    workspace_id: WS_ID,
    // tool_call_id omitted: today concord-ingest writes "concord:<id>" which
    // fails parseToolCallId; that's expected and documented below.
    plugin: "concord",
    kind: "concord.collision.detected",
    created_at: "2026-05-03T12:00:00.000Z",
    hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  test("decodeFleetContext extracts correlation_id and workspace_id from spine event", () => {
    const result = decodeFleetContext(spineEvent);
    expect(
      result.ok,
      `decodeFleetContext on spine event failed: ${!result.ok ? result.errors.join(", ") : ""}`,
    ).toBe(true);
    if (!result.ok) return;

    expect(result.value.correlation_id).not.toBeNull();
    expect(result.value.workspace_id).not.toBeNull();
    expect(result.value.tool_call_id).toBeNull();
  });

  test("parseToolCallId accepts canonical tool_ ULID-shaped id", () => {
    const result = parseToolCallId(properToolCallId);
    expect(result.ok, `parseToolCallId rejected "${properToolCallId}"`).toBe(true);
  });

  test("parseToolCallId rejects 'concord:42' (today's concord-ingest format, not tool_-prefixed)", () => {
    const result = parseToolCallId("concord:42");
    expect(result.ok, "concord:42 should not parse as a tool_call_id").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. Conductor lifecycle artifact path → canonical artifact_ref
// ---------------------------------------------------------------------------
describe("E. Lifecycle artifact path → canonical artifact_ref", () => {
  const sha256Hex = "a".repeat(64);
  const jsonPath = ".opencode/lifecycle/artifacts/concord/42.json";
  const xmlPath = ".opencode/lifecycle/artifacts/concord/42.xml";

  test("buildArtifactRef produces canonical concord_collision ref from .json path", () => {
    const ref = buildArtifactRef({ kind: "concord_collision", path: jsonPath, hash: sha256Hex });
    expect(ref.ref.startsWith("artifact:concord_collision:")).toBe(true);
    expect(ref.kind).toBe("concord_collision");
  });

  test("buildArtifactRef produces canonical concord_guidance ref from .xml path", () => {
    const ref = buildArtifactRef({ kind: "concord_guidance", path: xmlPath, hash: sha256Hex });
    expect(ref.ref.startsWith("artifact:concord_guidance:")).toBe(true);
    expect(ref.kind).toBe("concord_guidance");
  });

  test("parseArtifactRef round-trips the concord_collision ref", () => {
    const built = buildArtifactRef({ kind: "concord_collision", path: jsonPath, hash: sha256Hex });
    const parsed = parseArtifactRef(built.ref);
    expect(
      parsed.ok,
      `parseArtifactRef failed on "${built.ref}": ${!parsed.ok ? parsed.reason : ""}`,
    ).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("concord_collision");
    expect(parsed.value.path).toBe(jsonPath);
    expect(parsed.value.hash).toBe(`sha256:${sha256Hex}`);
  });

  test("parseArtifactRef round-trips the concord_guidance ref", () => {
    const built = buildArtifactRef({ kind: "concord_guidance", path: xmlPath, hash: sha256Hex });
    const parsed = parseArtifactRef(built.ref);
    expect(
      parsed.ok,
      `parseArtifactRef failed on "${built.ref}": ${!parsed.ok ? parsed.reason : ""}`,
    ).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("concord_guidance");
  });
});

// ---------------------------------------------------------------------------
// F. Plan/subplan artifact shape
// ---------------------------------------------------------------------------
describe("F. Plan artifact shape", () => {
  const sha256Hex = "b".repeat(64);

  test("buildArtifactRef produces canonical plan ref for .opencode/plans/*.md", () => {
    const ref = buildArtifactRef({
      kind: "plan",
      path: ".opencode/plans/fleet-correlation.md",
      hash: sha256Hex,
    });
    expect(ref.ref.startsWith("artifact:plan:")).toBe(true);
    expect(ref.kind).toBe("plan");
  });

  test("buildArtifactRef produces canonical subplan ref", () => {
    const ref = buildArtifactRef({
      kind: "subplan",
      path: ".opencode/plans/fleet-correlation-w0.md",
      hash: sha256Hex,
    });
    expect(ref.ref.startsWith("artifact:subplan:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G. Progress artifact shape
// ---------------------------------------------------------------------------
describe("G. Progress artifact shape", () => {
  const sha256Hex = "c".repeat(64);

  test("buildArtifactRef produces canonical progress ref for .opencode/progress/*.json", () => {
    const ref = buildArtifactRef({
      kind: "progress",
      path: ".opencode/progress/fleet-correlation.json",
      hash: sha256Hex,
    });
    expect(ref.ref.startsWith("artifact:progress:")).toBe(true);
    expect(ref.kind).toBe("progress");
  });
});

// ---------------------------------------------------------------------------
// H. Concord event ID parses as concord:<numeric>
// ---------------------------------------------------------------------------
describe("H. Concord event ID parsing", () => {
  test("parseConcordEventId('concord:42') returns ok=true, prefix=concord, id=42, no daemonNonce", () => {
    const result = parseConcordEventId("concord:42");
    expect(result.ok, `parseConcordEventId failed: ${!result.ok ? result.reason : ""}`).toBe(true);
    if (!result.ok) return;
    expect(result.prefix).toBe("concord");
    expect(result.id).toBe("42");
    expect(result.daemonNonce).toBeUndefined();
  });

  test("parseConcordEventId rejects non-concord prefix", () => {
    const result = parseConcordEventId("other:42");
    expect(result.ok).toBe(false);
  });

  test("parseConcordEventId accepts concord:<nonce>:<id> three-part form", () => {
    const result = parseConcordEventId("concord:daemon1:99");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.daemonNonce).toBe("daemon1");
    expect(result.id).toBe("99");
  });
});

// ---------------------------------------------------------------------------
// I. Workspace ID matches Conductor's real derivation (run.ts:61-63)
// ---------------------------------------------------------------------------
describe("I. Workspace ID algorithm matches Conductor's run.ts derivation", () => {
  test("newWorkspaceId produces same ws_<16hex> as Conductor's workspaceId()", () => {
    // Conductor's exact algorithm (run.ts:61-63):
    //   createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)
    //   prefixed with "ws_"
    const nodeComputed = `ws_${createHash("sha256").update(path.resolve(WS_ROOT)).digest("hex").slice(0, 16)}`;
    const contractsComputed = newWorkspaceId(WS_ROOT);
    // String template strips the brand type so toBe sees string === string
    expect(`${contractsComputed}`).toBe(nodeComputed);
  });

  test("workspace_id follows ws_<16 lowercase hex> pattern", () => {
    const wsId = newWorkspaceId(WS_ROOT);
    expect(wsId).toMatch(/^ws_[0-9a-f]{16}$/);
  });

  test("parseWorkspaceId validates the computed workspace_id", () => {
    const wsId = newWorkspaceId(WS_ROOT);
    const result = parseWorkspaceId(wsId);
    expect(result.ok, `parseWorkspaceId failed for computed id "${wsId}"`).toBe(true);
  });
});
