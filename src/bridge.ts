export type ConductorArtifact =
  | { kind: "plan"; slug: string; title: string; status: "draft" | "active" | "done"; body: string }
  | { kind: "audit"; slug: string; title: string; status: "open" | "done"; body: string }
  | { kind: "journal"; type: "decision" | "contract" | "pattern"; body: string }
  | { kind: "review"; verdict: "pass" | "fail" | "pass_with_fixes"; findings: unknown[] }
  | { kind: "wave_progress"; planSlug: string; waveId: string; status: string; summary: string }

export type EngramPreflightRequest = {
  query: string
  projectId?: string
  limit?: number
}
