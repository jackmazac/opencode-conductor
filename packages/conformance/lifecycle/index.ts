import { createArtifactRef, sha256ContentHash } from "../../lifecycle-contracts/src/artifacts.ts";
import type { LifecycleDecision } from "../../lifecycle-contracts/src/decisions.ts";
import { lifecycleDecisionSchema } from "../../lifecycle-contracts/src/decisions.ts";
import {
  concordCollisionArtifactRefSchema,
  externalGuidanceEnvelopeSchema,
} from "../../lifecycle-contracts/src/external-sources.ts";

const sourceMapArtifact = createArtifactRef({
  kind: "generated-source-map",
  content: JSON.stringify({ output: "src/generated/client.ts", source: "specs/openapi.yaml" }),
  artifactId: "artifact:origin-source-map",
  createdAt: 1,
});

export const allowDecisionFixture: LifecycleDecision = lifecycleDecisionSchema.parse({
  decision_id: "decision:origin:allow:1",
  module: "origin",
  severity: "allow",
  reason_code: "origin.source-owned-change",
  object_id: "source-file:specs/openapi.yaml",
  object: {
    kind: "source-file",
    id: "specs/openapi.yaml",
    owner_module: "origin",
    path: "specs/openapi.yaml",
  },
  evidence_refs: [sourceMapArtifact],
  remediation: { summary: "Edit the vendor-native OpenAPI source." },
  freshness: { epoch_id: 0, as_of_seq: 1, status: "fresh" },
});

export const warnDecisionFixture: LifecycleDecision = lifecycleDecisionSchema.parse({
  decision_id: "decision:seal:warn:1",
  module: "seal",
  severity: "warn",
  reason_code: "seal.public-api-review-recommended",
  object_id: "package-export:@scope/pkg#Widget",
  object: {
    kind: "package-export",
    id: "@scope/pkg#Widget",
    owner_module: "seal",
    vendor: "typescript",
  },
  evidence_refs: [],
  remediation: { summary: "Review public export impact before merging." },
  freshness: { epoch_id: 0, as_of_seq: 2, status: "fresh" },
});

export const blockDecisionFixture: LifecycleDecision = lifecycleDecisionSchema.parse({
  decision_id: "decision:origin:block:1",
  module: "origin",
  severity: "block",
  reason_code: "origin.no-direct-generated-edit",
  object_id: "generated-output:src/generated/client.ts",
  object: {
    kind: "generated-output",
    id: "src/generated/client.ts",
    owner_module: "origin",
    path: "src/generated/client.ts",
  },
  evidence_refs: [sourceMapArtifact],
  remediation: {
    summary: "Edit specs/openapi.yaml and regenerate the client.",
    source_paths: ["specs/openapi.yaml"],
    commands: ["bun run generate:api"],
  },
  freshness: { epoch_id: 0, as_of_seq: 3, status: "fresh" },
});

export const staleBlockDecisionInput = {
  ...blockDecisionFixture,
  decision_id: "decision:origin:block:stale",
  freshness: { epoch_id: 0, as_of_seq: 3, status: "stale" },
};

export const concordCollisionFixture = concordCollisionArtifactRefSchema.parse({
  source: "concord",
  protocol_version: "1",
  schema_version: "1",
  event_id: "collision:1",
  ts: 1,
  file_path: "src/generated/client.ts",
  requested_range: { start_line: 10, end_line: 20 },
  conflicting_range: { start_line: 12, end_line: 18 },
  guidance_emitted: true,
  correlation: {
    source: "concord",
    correlation_id: "corr-1",
    plan_ref: "lifecycle-integrity:Wave1",
    intent: "update generated client",
  },
});

export const concordGuidanceFixture = externalGuidanceEnvelopeSchema.parse({
  source: "concord",
  format: "concord_conflict_xml",
  content: "<concord_conflict><summary>Range is already reserved.</summary></concord_conflict>",
  content_hash: sha256ContentHash(
    "<concord_conflict><summary>Range is already reserved.</summary></concord_conflict>",
  ),
  source_event_id: "collision:1",
});
