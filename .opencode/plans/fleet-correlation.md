# OpenCode Fleet Full Implementation Plan

Slug: `fleet-correlation`
Compiled from: 7 parallel repo audits (Conductor, Engram, Concord, Codemem, Host Adapter, opencode-fleet, ~/.config/opencode) + 2 parallel planners (Contracts/Foundation vs Feature/Ops).
Total tasks: 56 across 8 waves (W0–W7).
Critical path: W0 → W1 → {W2, W3, W4, W5} (parallel-capable within constraints) → W6 → W7.

## Executive Summary

**What the fleet should become.** A five-plugin OpenCode fleet — Host Adapter, Conductor, Engram, Concord, Codemem — wrapped by a thin fleet tool (`opencode-fleet`) and driven from a single local `fleet.jsonc` manifest. Every plugin:
- Runs on Bun + TSGo, exports an OpenCode plugin + a `{plugin} doctor|status|check` CLI, and publishes structured JSON.
- Speaks a shared ID vocabulary (`workspace_id / plan_id / plan_slug / wave_id / agent_run_id / correlation_id / tool_call_id / spine_seq / artifact_ref / lifecycle_object_id / concord_event_id / fleet_run_id`) that threads end-to-end from plan to tool call to telemetry.
- Emits a canonical NDJSON telemetry envelope (Host Adapter owns the emitter; every plugin carries the IDs).
- Reports health in a canonical `HealthReport` shape (Fleet and every CLI agree on the verb set).
- Stays narrow: Conductor = doctrine/plans/lifecycle; Engram = memory/artifacts/retrieval; Concord = live edit coordination; Codemem = code-graph truth/advice; Host Adapter = plugin-boundary safety; Fleet = install/doctor/test/hygiene/report.

**The key architectural bet.** Correlation, not features. Almost every feature the user asks for in the top goals already exists in one plugin — but no fleet-wide ID threads them. Fixing that chain is a ~2-week engineering effort (W0/W1 unlock everything else) and unlocks every downstream integration flow. We avoid a mega-plugin: contracts live in a new shared package `@jackmazac/opencode-fleet-contracts`; Host Adapter re-exports them; plugins depend on Host Adapter.

**Top risks.**
1. Tool-execute return-shape change in Host Adapter (W1) ripples to every plugin — gate with `legacyErrorString: true` and expanded contract tests.
2. Engram schema expansion (W3) must stay additive and migrate old sidecars in-place — use sidecar `chunk_correlation` table, never widen hot write path.
3. Concord re-enablement (W4) risks destabilizing OpenCode tool-execute semantics — gate behind `live-smoke` + `bench:threshold` green and Fleet runtime validation (W6) shipping first.
4. Fleet `install` now actually runs `bun install` (W6) — shield with `--dry-run` default on first call and always write backups.
5. `opencode.json` generation (W6/W7) mutates user config — preserve user sections (`agent`, `mcp`, `formatter`, `lsp`, `instructions`) with a sibling `.opencode-fleet.lock.json` hash, warn before replacing drift.

The full plan (Current State, Canonical Contracts, all 8 waves, Cross-Plugin Flows, Testing/Bench Strategy, Operational Model, Commit Strategy, Risks & Open Decisions, Final Recommended Sequence) is at `/var/folders/ml/p_w___pn5jlbtt8fj2lrvwbm0000gp/T/opencode/fleet-plan/plan.md` (~8,300 words, 68 KB). Because that exceeds comfortable persist size, only this summary header is stored here — consult the temp file plus journal entry `fleet-correlation decisions` for the full body of each wave.

## Final Recommended Sequence

**Gate 0 — Contracts unlock everything.** W0 ships first, alone, with no other repo changes; W1 follows as soon as W0 is green. These two waves are the critical path — nothing downstream works without them.

**Gate 1 — Parallel plugin adoption.** After W1, launch W2 / W3 / W5 in parallel (distinct repos, no shared writes). **W4 waits for W3** because Concord's plugin reads Conductor's status mirror (W2 adds `plan_id` there) and because Concord re-enablement depends on Fleet runtime validation (W6). So W2 → W4; W3 → W4; W5 independent.

**Gate 2 — Fleet assembles.** W6 starts once W2/W3/W5 merge. W6 validates every plugin's runtime surface end-to-end.

**Gate 3 — Config drift resolution.** W7 ships last. Consumes W6's generator + contract validation to clean `~/.config/opencode` deterministically.

**Concord re-enablement (W4.7) is the last flag flip** — only after W6 green, W4 Rust + NDJSON + heartbeat green, and a manual scratch-repo collision test pass.

**Estimated effort.** W0+W1 ≈ 1–2 engineering-days. W2–W5 ≈ 3 engineering-days each (parallelizable). W6 ≈ 3–4 engineering-days. W7 ≈ 1–2 engineering-days. Calendar: 2–3 weeks serialized; < 2 weeks with parallel executors in gate 1.

## Decisions requiring user confirmation before any execution
1. Publish `@jackmazac/opencode-fleet-contracts` publicly to npm after local validation? **(default: no — private/local only)**
2. Allow any telemetry export outside the local machine? **(default: no)**
3. `opencode-fleet install/update` runs `bun install` automatically? **(default: yes with backups + `--dry-run`)**
4. Fleet becomes the generated source of truth for `~/.config/opencode/opencode.json`? **(default: yes, user sections preserved)**
5. Backfill historical `.opencode/runs` + Engram rows with `plan_id`? **(default: no — legacy records keep `plan_slug` only)**
6. Enable Concord in fleet manifest after W4/W6 green? **(default: yes, gated on manual collision smoke)**
7. Move `plugin/context-usage.ts` into Conductor as `context_usage` tool (W7.2)? **(default: yes)**
8. Delete accidental global `.opencode/` artifacts under `~/.config/opencode` (W7.4)? **(default: yes, archived before deletion)**
