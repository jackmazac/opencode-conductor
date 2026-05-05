Goal: OpenCode plugin fleet correlation plan (slug: fleet-correlation) — COMPLETE.

## Status
All 8 waves shipped + 2 regression hotfixes. End-to-end validation green: fleet:test:full-runtime 37 pass / 0 fail / 0 warn / 1 skip.

## Commits (12 across 8 repos)

| Repo | Commit | Wave |
|---|---|---|
| opencode-fleet-contracts | 55f8d91 | W0 initial |
| opencode-host-adapter | ec39835 → 7497c01 → eb3f323 | W0 + W1 + W1 hotfix |
| opencode-conductor | 1f4f4f8 → bd6aa18 → 0a74ec0 | W0 + W2 + W7.2 |
| engram | c59abf5 | W3 |
| concord | cdf32c5 → 2150012 | W4 + W4 hotfix |
| codemem | 6532862 | W5 |
| opencode-fleet | 3f88690 → 0cebd70 | W0 + W6 |
| ~/.config/opencode | 1b7cbb0 | W7 (branch plan-persistence-config) |

## Canonical plan
Persisted at: opencode-conductor/.opencode/plans/fleet-correlation.md (slug 'fleet-correlation').
Loaded via: read_final_plan('fleet-correlation').

## Test counts (before → after)
- contracts: new, 44 tests
- host-adapter: 11 → 34 (+23)
- conductor: 109 → 159 (+50)
- engram: 44 → 49 (+5)
- concord: TS 5→7 (+2), Rust 16→19 (+3)
- codemem: TS 29→38 (+9), Rust 15→17 (+2)
- fleet: 12 → 51 (+39)

## Architecture shipped
Canonical contracts package `@jackmazac/opencode-fleet-contracts` owns FleetTelemetryEnvelope, HealthReport, ArtifactRef, FleetContext + ID constructors/parsers. Host Adapter re-exports. Every plugin threads these through. Opencode-fleet generates opencode.json from fleet.jsonc, runs real bun install, validates runtime tool contracts, emits fleet_run_id per command, persists reports to ~/.local/share/opencode/fleet/reports/.

## Cross-plugin flows now wire end-to-end
- F1: Concord conflict → Conductor ingest → Engram context → agent retry (dispatcher abstraction in place; runtime tool dispatch wired when OpenCode SDK exposes it).
- F2: Codemem risk → Conductor plan/review → Engram memory (10 advisory Codemem tools exposed; correlation IDs on protocol).
- F3: Conductor prescription → Fleet/Host Adapter verification (fleet test validates expected_tools against actual plugin surface).
- F4: Runtime install/update/doctor path (bun install runs, generate-opencode-json preserves user sections).

## Two runtime regressions found + fixed during rollout
1. Host Adapter tool.execute.before was dropping input args (patchText/filePath/etc.) — fixed eb3f323 with input-args preservation + 3 regression tests.
2. Concord absolute-path rejection masked as 'RPC id mismatch' — fixed 2150012 with toProjectRelative helper + daemon error-id preservation + 5 regression tests.

## Known residual
- opencode-notifier-state.json dirty in ~/.config/opencode (pre-existing user state, out of scope per plan).
- Concord tsc warning in hygiene strict (not a failure, informational).
- plan-persistence-config branch in ~/.config/opencode awaits merge to main per W7.7 plan.
- Archive of pre-W7.4 .opencode/ state at ~/.local/share/opencode/archive/config-opencode-20260503-204036/.

## User decisions honored
1. Contracts package stays local/private (not published to npm). DONE.
2. Telemetry local-only (no external export). DONE.
3. bun install runs automatically on opencode-fleet install. DONE.
4. Fleet is source of truth for opencode.json. DONE.
5. No historical backfill of plan_id into legacy runs. DONE.
6. Concord enabled after W4/W6 green. DONE.
7. context_usage moved to Conductor. DONE.
8. Global .opencode/ in config archived + deleted. DONE.

## Next session start
Consume this handoff then call handoff_done. Plan is archived; journal has the decisions log. Project complete for the 'fleet-correlation' effort.