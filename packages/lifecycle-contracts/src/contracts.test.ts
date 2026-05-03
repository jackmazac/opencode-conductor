import { describe, expect, test } from "bun:test";
import { createArtifactRef, sha256ContentHash } from "./artifacts.ts";
import type { LifecycleDecision } from "./decisions.ts";
import { lifecycleDecisionSchema } from "./decisions.ts";
import {
  concordCollisionArtifactRefSchema,
  externalGuidanceEnvelopeSchema,
} from "./external-sources.ts";
import { formatLifecycleObjectId, lifecycleObjectIdSchema } from "./object-id.ts";

const typeCheckRejectsStaleCurrentDecision = {
  decision_id: "decision:typecheck:stale",
  module: "origin",
  severity: "block",
  reason_code: "origin.stale",
  object_id: "source-file:specs/openapi.yaml",
  evidence_refs: [],
  remediation: { summary: "Recompute before enforcing." },
  // @ts-expect-error Current lifecycle decisions must be fresh at the type level.
  freshness: { epoch_id: 1, as_of_seq: 2, status: "stale" },
} satisfies LifecycleDecision;
void typeCheckRejectsStaleCurrentDecision;

describe("lifecycle contract primitives", () => {
  test("formats vendor-native object identities", () => {
    const object = lifecycleObjectIdSchema.parse({
      kind: "openapi-operation",
      vendor: "openapi",
      id: "GET /v1/accounts/{id}",
      owner_module: "seal",
    });
    expect(formatLifecycleObjectId(object)).toBe("openapi-operation:openapi:GET /v1/accounts/{id}");
  });

  test("creates content-addressed artifact refs", () => {
    const ref = createArtifactRef({ kind: "schema-snapshot", content: "schema" });
    expect(ref.hash).toBe(sha256ContentHash("schema"));
    expect(ref.artifact_id).toBe(ref.hash);
  });

  test("requires fresh current decisions", () => {
    const parsed = lifecycleDecisionSchema.safeParse({
      decision_id: "decision:1",
      module: "portage",
      severity: "warn",
      reason_code: "portage.review-required",
      object_id: "migration:202605030001",
      evidence_refs: [],
      remediation: { summary: "Review the migration plan." },
      freshness: { epoch_id: 1, as_of_seq: 10, status: "stale" },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects Concord collisions as lifecycle decision objects", () => {
    const parsedWithObject = lifecycleDecisionSchema.safeParse({
      decision_id: "decision:concord:invalid",
      module: "origin",
      severity: "warn",
      reason_code: "origin.external-collision",
      object_id: "concord-collision:collision:42",
      object: { kind: "concord-collision", id: "collision:42" },
      evidence_refs: [],
      remediation: { summary: "Use Concord guidance as evidence only." },
      freshness: { epoch_id: 1, as_of_seq: 10, status: "fresh" },
    });
    expect(parsedWithObject.success).toBe(false);

    const parsedWithoutObject = lifecycleDecisionSchema.safeParse({
      decision_id: "decision:concord:invalid-id",
      module: "origin",
      severity: "warn",
      reason_code: "origin.external-collision",
      object_id: "concord-collision:collision:42",
      evidence_refs: [],
      remediation: { summary: "Use Concord guidance as evidence only." },
      freshness: { epoch_id: 1, as_of_seq: 10, status: "fresh" },
    });
    expect(parsedWithoutObject.success).toBe(false);
  });

  test("enforces source-kind-specific object identities", () => {
    expect(
      lifecycleObjectIdSchema.safeParse({ kind: "source-file", id: "not-a-path" }).success,
    ).toBe(false);
    expect(
      lifecycleObjectIdSchema.safeParse({ kind: "package-export", id: "Widget" }).success,
    ).toBe(false);
    expect(
      lifecycleObjectIdSchema.safeParse({
        kind: "migration",
        id: "202605030001",
        vendor: "openapi",
      }).success,
    ).toBe(false);
  });

  test("models Concord collision evidence with versioned protocol refs", () => {
    const collision = concordCollisionArtifactRefSchema.parse({
      source: "concord",
      protocol_version: "1",
      schema_version: "1",
      event_id: "collision:42",
      ts: 42,
      file_path: "src/foo.ts",
    });
    expect(collision.source).toBe("concord");

    const guidance = externalGuidanceEnvelopeSchema.parse({
      source: "concord",
      format: "concord_conflict_xml",
      content: "<concord_conflict />",
      content_hash: sha256ContentHash("<concord_conflict />"),
    });
    expect(guidance.format).toBe("concord_conflict_xml");
  });
});
