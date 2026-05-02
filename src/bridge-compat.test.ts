import { describe, expect, test } from "bun:test"
import { bridgeArtifactSchema } from "opencode-engram/bridge"
import type { ConductorArtifact } from "./bridge"

describe("Engram bridge compatibility", () => {
  test("Conductor artifacts parse with Engram's bridge schema", () => {
    const artifacts: ConductorArtifact[] = [
      { kind: "plan", slug: "api-plan", title: "API Plan", status: "archived", body: "done" },
      { kind: "audit", slug: "api-audit", title: "API Audit", status: "archived", body: "done" },
      { kind: "journal", type: "discovery", body: "found a reusable boundary" },
      { kind: "review", verdict: "comment", body: "needs follow-up", findings: [], planSlug: "api-plan" },
      { kind: "wave_progress", planSlug: "api-plan", waveId: "W1", status: "blocked", summary: "waiting" },
    ]

    for (const artifact of artifacts) {
      expect(bridgeArtifactSchema.parse(artifact).kind).toBe(artifact.kind)
    }
  })
})
