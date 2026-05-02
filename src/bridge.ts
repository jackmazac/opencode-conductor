export type ConductorArtifact =
  | { kind: "plan"; slug: string; title: string; status: "draft" | "active" | "done" | "archived"; body: string; updatedAt?: number }
  | { kind: "audit"; slug: string; title: string; status: "open" | "done" | "archived"; body: string; updatedAt?: number }
  | { kind: "journal"; type: "decision" | "contract" | "pattern" | "discovery"; body: string; slug?: string; updatedAt?: number }
  | { kind: "review"; verdict: "pass" | "fail" | "pass_with_fixes" | "comment"; body: string; findings: unknown[]; planSlug?: string; updatedAt?: number }
  | { kind: "wave_progress"; planSlug: string; waveId: string; status: "pending" | "in-progress" | "done" | "blocked" | "cancelled"; summary: string; updatedAt?: number }

export type EngramPreflightRequest = {
  query: string
  projectId?: string
  limit?: number
}
