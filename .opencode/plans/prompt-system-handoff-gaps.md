# Conductor Prompt System — Handoff Gap Repairs Plan

Compiled from: 1 audit pass over `prompts/*.txt` (13 prompts) and `src/plugin-contract.test.ts` (30-tool surface).
Total tasks: 12 across 4 waves.
Critical path: W1 (prompt-only fixes) → W2 (centralization + slug discipline) → W3 (tool-surface additions, gated on user approval) → W4 (downstream prompt rewiring on the new tools).

## Goal

Close all 8 functional gaps identified in the prompt-system audit: places where one agent persists or produces durable state but the consuming agent has no handle to look it up, plus inconsistent slug-discipline rules that drift between sites.

## Priming

- **User-visible outcome**: Agents resume cleanly across compaction. After a brainstorm, audit, debugger session, or validator pass, the next agent (or next session) can find and reload the durable artifact instead of re-deriving from a paraphrased summary or re-running the work.
- **Failure modes addressed**:
  1. Brainstormer recommendation lost across compaction → planner re-derives or guesses.
  2. Audit slug drifts between `audit_write` and `audit_progress_*` → progress orphaned.
  3. Resumed session has handoff but never calls `audit_read` → active audit invisible.
  4. Debugger root cause lives only in chat → reviewer can't reference it post-commit.
  5. Validator runs without plan context → wave-level DoD/verification commands ignored.
  6. Validator "remaining issues" lack stable IDs → re-validation pass can't confirm "R2 resolved."
  7. Suborchestrator return lacks plan slug → orchestrator can't attribute campaign output to a wave for `progress_update`/journaling.
  8. Designer advisory output evaporates after compaction → executors can't read the design system.
- **Patterns to preserve**:
  - Tool addition workflow in `~/Developer/opencode-conductor/AGENTS.md` (registration in `src/workflow-artifacts.ts`, exact-tools check in `src/plugin-contract.test.ts`, runtime smoke asserts tool count).
  - Validation gate: `bun run check` + `bun run smoke:runtime` + `bun run doctor -- --json` + `bun run status -- --json` must all pass.
  - No Zod imports in `src/` (`lint:no-zod` enforces this); use contracts parsers.
  - No `as` assertions; branded ID types stay validated end-to-end.
  - Existing slug discipline for `persist_final_plan` (verbatim, copy-paste, never paraphrase).
- **Root cause correlation**: All 8 gaps share one missing abstraction — **structured handoff lines on agent chat returns when the agent persisted durable state**. Today only `persist_final_plan` enforces this, via the `Plan: <slug> | Task: … | Wave: …` discipline. Every other persistence path is informal. The fix is to extend that single discipline outward, not to invent 8 separate fixes.
- **Type pipeline**: N/A — prompt-text changes only for W1/W2/W4. W3 (new tools) follows the existing `WorkflowArtifactTools` pattern: branded slug ID at the boundary, schema validation via host-adapter `tool.schema.*`, structured JSON return, no `as`.
- **Contract & vendor audit**: Reviewed:
  - `prompts/orchestrator.txt`, `prompts/planner.txt` (recent fix), `prompts/brainstormer.txt`, `prompts/designer.txt`, `prompts/debugger.txt`, `prompts/validator.txt`, `prompts/reviewer.txt`, `prompts/scribe.txt`, `prompts/executor.txt`, `prompts/suborchestrator.txt`, `prompts/explore.txt`, `prompts/compaction.txt`, `prompts/deployer.txt`.
  - `src/plugin-contract.test.ts` — exact tool list (30 tools, all `audit_*`, `persist_subplan`/`read_subplan`/`discard_subplan`, `persist_final_plan`/`read_final_plan`/`discard_final_plan` already exist; no `persist_brainstorm` or `persist_design`).
  - Existing pattern in `src/workflow-tools/<name>.ts` + registration in `src/workflow-artifacts.ts` (per AGENTS.md).
- **Codemem signals**: N/A for W1/W2 (text-only). For W3, run `codemem impact-cone --path src/workflow-tools/ --json` and `codemem api-surface --json` before adding `persist_brainstorm` to confirm no unexpected coupling; expected impact is `src/workflow-artifacts.ts`, `src/index.ts`, `src/plugin-contract.test.ts`, and `~/.config/opencode/fleet.jsonc` `expected_tools` count.

---

## Wave 1: Fix prompt-only handoff bugs (no new tools)

**Thesis**: Eliminate the highest-impact handoff breaks that need zero tool-surface change. Each agent that already persists state via an existing tool gets a `# Handoff line` rule mirroring the planner→orchestrator fix.

**Tasks**:

| ID | Task | Files | Executor | Size |
|---|---|---|---|---|
| W1-T1 | Validator startup loads plan + numbered remaining issues | `prompts/validator.txt` | executor-low | S |
| W1-T2 | Suborchestrator return echoes plan slug | `prompts/suborchestrator.txt` | executor-low | S |
| W1-T3 | Audit slug discipline + handoff resume rule | `prompts/orchestrator.txt` | executor-medium | S |
| W1-T4 | Debugger root-cause journaling routing | `prompts/orchestrator.txt`, `prompts/debugger.txt` | executor-low | S |
| W1-T5 | Compaction template lists audits + audit-progress | `prompts/compaction.txt` | executor-low | S |

### W1-T1: Validator startup + remaining-issue IDs

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `prompts/validator.txt`
- **Test plan**: N/A — prompt-only behavioral change. Verify via wave smoke (W4-T2): spawn `validator` with `Plan: <slug>` header against a synthetic persisted plan; confirm it calls `read_final_plan` first and returns issues numbered `R1`, `R2`, ….
- **Type flow**: N/A — text only.
- **Description**: Add an `# On startup` section near the top of `validator.txt` (mirroring `reviewer.txt:51–58`): if the prompt has `Plan: <slug>`, call `read_final_plan(<slug>)` before discovering toolchain so wave-level verification commands and per-task DoD inform the run; if no `Plan:` line, skip and treat the delegation prompt as the spec. Number the "Remaining issues" section (`R1`, `R2`, …) in the output template (`validator.txt:134–135`) and add a short rule: "Use these IDs when reporting back to the orchestrator so a follow-up pass can confirm `R2 resolved`."
- **Definition of done**:
  1. `validator.txt` has an `# On startup` block with the `read_final_plan` rule.
  2. The "Remaining issues" template entries are numbered `R1.`, `R2.`, … with the cross-reference rule appended.
  3. `bun run check` still passes (no test references the old format).
- **Verify**: `bun run check` from repo root; `rg -n "On startup" prompts/validator.txt` returns the new block.
- **Depends on**: none.

### W1-T2: Suborchestrator campaign return echoes plan slug

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `prompts/suborchestrator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: Add a `### Plan reference` line as the **first** sub-section of the campaign summary template (`suborchestrator.txt:92–113`): `Plan: <slug> | Wave: <name>` — populated only when the orchestrator passed those identifiers in the delegation prompt; omit cleanly for ad-hoc campaigns. Add one sentence explaining why: "The orchestrator uses this to attribute campaign output to a wave for `progress_update` and journaling."
- **Definition of done**:
  1. `## Campaign summary` template starts with `### Plan reference` whenever a plan slug is in scope.
  2. Behavior on ad-hoc (no `Plan:`) campaigns explicitly preserved — section omitted, not stubbed.
- **Verify**: `bun run check`; `rg -n "Plan reference" prompts/suborchestrator.txt` returns one match.
- **Depends on**: none.

### W1-T3: Audit slug discipline + handoff resume

- **Complexity**: low (text only) but **medium-importance** (audit lifecycle is currently fragile across sessions)
- **Executor**: executor-medium (importance promotion)
- **Effort**: S
- **Files**: `prompts/orchestrator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: Two edits in `orchestrator.txt`:
  1. In `# Persisted audits (orchestrator-only)` (around line 109), append: "**Audit slug discipline**: Reuse the **same slug** verbatim across `audit_progress_update`, `audit_progress_read`, `audit_progress_done`, and `audit_done`. Same rule as plan slugs — copy-paste the string you passed to `audit_write`, do not paraphrase or shorten."
  2. In `# Session startup` (around line 67), extend the handoff branch: "If `handoff_read` returned active audit slugs, call `audit_read(<slug>)` for each before continuing — same discipline as `read_final_plan` for plans."
- **Definition of done**:
  1. Both edits land verbatim above.
  2. The session-startup numbered list still parses cleanly.
- **Verify**: `bun run check`; `rg -n "Audit slug discipline|active audit slugs" prompts/orchestrator.txt` returns both.
- **Depends on**: none.

### W1-T4: Debugger root-cause journaling

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `prompts/orchestrator.txt`, `prompts/debugger.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: Two edits:
  1. `orchestrator.txt` step 9 ("Review", or under `# Delegation` next to the `debugger-xhigh` row): "After a debugger return with a non-obvious root cause, call `journal_write` with: the one-sentence Root cause, the Fix `file:line`, and the verification command + result. Do **not** journal the full Hypotheses table or log citations — those stay pinned in the chat return per `# Compression policy` until the wave commits."
  2. `debugger.txt` Phase 7 cleanup (line 131): clarify that the **chat-return Report** is the durable record; cleanup deletes `debug.log` and `[DBG]` instrumentation only **after** verification confirms the fix. (No behavioral change — just makes the contract explicit so the orchestrator's journal capture is unambiguous.)
- **Definition of done**:
  1. Orchestrator step 9 has the `journal_write` rule for debugger returns.
  2. `debugger.txt:131–136` clarifies that the chat-return Report is the durable artifact pre-journal.
- **Verify**: `bun run check`; `rg -n "journal_write" prompts/orchestrator.txt | rg -i debugger` returns the new rule.
- **Depends on**: none.

### W1-T5: Compaction template lists audits

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `prompts/compaction.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: In the `## Persistent stores` section (`compaction.txt:104–113`), add two bullets after the Subplans line:
  - **Audits** (`.opencode/audits/<slug>.md`): persisted read-only audit reports via `audit_write`/`audit_read`. List active audit slugs only when audit work is active or being resumed.
  - **Audit progress** (`.opencode/audit-progress/<slug>.json`): wave-level audit progress via `audit_progress_update`/`audit_progress_read`. List active audit-progress slugs with wave counts.
- **Definition of done**:
  1. Both bullets present, mirroring the structure of the existing Subplans/Final plans/Progress entries.
- **Verify**: `bun run check`; `rg -n "audits|audit-progress" prompts/compaction.txt` returns both.
- **Depends on**: none.

**Definition of Done (Wave 1)**:
- All five tasks complete.
- `bun run check` passes (lint:no-zod + typecheck + tests).
- `bun run smoke:runtime` passes (plugin loads, exact tool count of 30).
- `rg -n "On startup" prompts/validator.txt && rg -n "Plan reference" prompts/suborchestrator.txt && rg -n "Audit slug discipline" prompts/orchestrator.txt && rg -n "audits|audit-progress" prompts/compaction.txt` — all return matches.

**Blast radius**: prompt-text only. Rollback: `git revert` the wave commit.

**Dependencies**: enables W4. Independent of W2 and W3.

---

## Wave 2: Centralize plan-slug discipline (no new tools)

**Thesis**: The plan-slug invariant is restated 9 times across `orchestrator.txt` with subtle drift. Drift is how invariants break. Lift it into one canonical block and replace the scattered restatements with cross-references — same content, single source of truth.

**Tasks**:

| ID | Task | Files | Executor | Size |
|---|---|---|---|---|
| W2-T1 | Add canonical `# Plan slug discipline` block | `prompts/orchestrator.txt` | executor-medium | M |
| W2-T2 | Replace consumer-side restatements with cross-references | `prompts/orchestrator.txt`, `prompts/executor.txt`, `prompts/reviewer.txt`, `prompts/scribe.txt`, `prompts/suborchestrator.txt`, `prompts/validator.txt` | executor-medium | M |

### W2-T1: Canonical plan-slug-discipline block

- **Complexity**: low (text consolidation)
- **Executor**: executor-medium (multiple call-sites need consistent rewriting)
- **Effort**: S
- **Files**: `prompts/orchestrator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: Add a new top-level section `# Plan slug discipline` near `# Verification command defaults` in `orchestrator.txt`. Single canonical paragraph covering: (a) one slug per plan, (b) verbatim reuse in **every** delegation header for executors / reviewers / scribes / suborchestrators / validators when plan-backed, (c) `Plan: <slug> | Task: <id> | Wave: <name>` for executors and suborchestrator-managed leaves, (d) `Plan: <slug> | Review: <scope>` for reviewers, (e) `Plan: <slug> | Doc: <scope>` for scribes, (f) `Plan: <slug>` (no second field) for validators when the validation pass scopes a plan-backed wave, (g) missing `Plan:` line on plan-backed work = pre-flight failure → fix the prompt before sending, (h) ad-hoc delegations omit the line cleanly.
- **Definition of done**:
  1. `# Plan slug discipline` block exists, contains all 8 sub-rules above, and is the **single** authoritative statement of the rule in the file.
  2. Cross-references inserted where the existing 9 restatements lived (see W2-T2).
- **Verify**: `bun run check`; `rg -n "^# Plan slug discipline" prompts/orchestrator.txt` returns exactly one match.
- **Depends on**: none.

### W2-T2: Replace scattered restatements with cross-references

- **Complexity**: medium (touches 6 files; subtle edits to preserve intent)
- **Executor**: executor-medium
- **Effort**: M
- **Files**: `prompts/orchestrator.txt`, `prompts/executor.txt`, `prompts/reviewer.txt`, `prompts/scribe.txt`, `prompts/suborchestrator.txt`, `prompts/validator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: At each of the 9 `orchestrator.txt` restatement sites (lines 11, 59, 192–193, 202–203, 230, 245, 267, 322, 446–447 of the pre-W2-T1 file), replace the inline rule with a one-sentence pointer: "Slug discipline: see `# Plan slug discipline`." Preserve **role-specific** content (e.g., the `Review:` second field is still mentioned in the reviewer subsection, but the slug-handling rule itself is delegated to the canonical block). On the consumer side (`executor.txt:169`, `reviewer.txt:55`, `scribe.txt:36`, `suborchestrator.txt:42–54`, plus the new `validator.txt` startup from W1-T1), normalize the consumer rule to one consistent form: "If the prompt has `Plan: <slug>`, call `read_final_plan(<slug>)` before substantive work. See orchestrator's `# Plan slug discipline` for the full producer-side contract."
- **Definition of done**:
  1. No more than one full statement of the slug rule remains in any prompt; all other sites are pointers.
  2. Each consumer prompt (executor, reviewer, scribe, suborchestrator, validator) has the same one-line `read_final_plan` rule wording.
  3. The total prompt-text size shrinks (consolidation, not expansion).
- **Verify**: `bun run check`; `rg -c "verbatim" prompts/orchestrator.txt` should drop relative to pre-wave; `rg -n "read_final_plan" prompts/{executor,reviewer,scribe,suborchestrator,validator}.txt` returns one consistent rule per file.
- **Depends on**: W2-T1.

**Definition of Done (Wave 2)**:
- W2-T1 and W2-T2 complete.
- `bun run check` passes.
- Manual diff review: net prompt size shrinks; semantics preserved.

**Blast radius**: prompt-text only across 6 files. Rollback: `git revert`.

**Dependencies**: depends on W1 (validator already has `# On startup` block from W1-T1 to point at). Independent of W3.

---

## Wave 3: Tool surface additions (gated on user approval)

**Thesis**: The two HIGH-severity gaps (#1 brainstormer, #6 designer advisory) cannot be fixed by prompt edits alone — they need new persistence tools. Following the project's `Tool addition workflow`, this wave adds `persist_brainstorm`/`read_brainstorm`/`discard_brainstorm` (gap #1) and reuses the same shape for `persist_design`/`read_design`/`discard_design` (gap #6).

**THIS WAVE REQUIRES EXPLICIT USER SIGN-OFF.** It expands the conductor tool count from 30 → 36, modifies `src/plugin-contract.test.ts`, and requires regenerating `~/.config/opencode/opencode.json` via `opencode-fleet generate-opencode-json --force` after updating `~/.config/opencode/fleet.jsonc` `expected_tools` (currently 30 per `AGENTS.md`).

**Alternative path (if user rejects new tools)**: skip W3 entirely; W4 instead requires the brainstormer to write its analysis to `journal_write` (lossy — loses Approaches/Tradeoffs structure) and the designer to default to `--persist` implementation mode (already supported by the skill — `designer.txt:23–27`). Coverage is partial but no tool-surface change.

**Tasks** (only execute on user approval):

| ID | Task | Files | Executor | Size |
|---|---|---|---|---|
| W3-T1 | Add `brainstorm` workflow tool (write/read/discard) | `src/workflow-tools/brainstorm.ts`, `src/workflow-artifacts.ts`, `src/index.ts`, `src/plugin-contract.test.ts` | executor-high | M |
| W3-T2 | Add `design` workflow tool (write/read/discard) | `src/workflow-tools/design.ts`, `src/workflow-artifacts.ts`, `src/index.ts`, `src/plugin-contract.test.ts` | executor-high | M |
| W3-T3 | Update fleet manifest expected_tools count | `~/.config/opencode/fleet.jsonc`, regenerate `opencode.json` | executor-low | S |

### W3-T1: Add brainstorm tool

- **Complexity**: medium (follows existing `subplan` pattern exactly)
- **Executor**: executor-high (touches plugin contract surface; importance promotion over decomposition)
- **Effort**: M (1–4h)
- **Files**:
  - **Create**: `src/workflow-tools/brainstorm.ts`
  - **Modify**: `src/workflow-artifacts.ts` (register in `createWorkflowArtifactTools` return), `src/index.ts` (wire into tool map if not covered by the artifacts factory), `src/plugin-contract.test.ts` (add `persist_brainstorm`, `read_brainstorm`, `discard_brainstorm` to `expectedTools`)
- **Test plan**: Mirror the subplan-tool tests. Co-locate `src/workflow-tools/brainstorm.test.ts` covering: (a) round-trip write→read returns the exact markdown, (b) read with no slug lists active brainstorms, (c) discard removes the file and returns success, (d) write rejects malformed slugs (must validate via contracts parser, no `as`).
- **Type flow**: One canonical `BrainstormSlug` branded ID validated at the tool boundary via the contracts parser pattern; markdown content flows through unchanged. No `as` assertions, no Zod direct imports.
- **Description**: Implement `persist_brainstorm({ slug, content })`, `read_brainstorm({ slug? })`, `discard_brainstorm({ slug?, all? })` writing to `.opencode/brainstorms/<slug>.md`. Parallel to the subplan implementation (`src/workflow-tools/subplan.ts` if it exists; otherwise the relevant `workflow-artifacts.ts` factory). Use `tool.schema.*` for arg validation, never raw Zod. Branded slug type validated via contracts parser at the boundary.
- **Definition of done**:
  1. Three new tools registered and the plugin-contract test asserts exactly 33 tools (30 existing + 3 new).
  2. `bun run check` passes (159+ tests still green; new tests added).
  3. `bun run smoke:runtime` passes with the new tool count assertion updated.
  4. No `as`, no direct Zod, no `@ts-ignore`.
  5. `.opencode/brainstorms/` is created on first write; existing dir tolerated.
- **Verify**: `bun run check && bun run smoke:runtime && bun run doctor -- --json && bun run status -- --json`. Manual smoke: invoke `persist_brainstorm` then `read_brainstorm` and confirm round-trip.
- **Depends on**: none (within W3).

### W3-T2: Add design tool

- **Complexity**: medium (clone of W3-T1 with a different artifact directory)
- **Executor**: executor-high
- **Effort**: M
- **Files**:
  - **Create**: `src/workflow-tools/design.ts`
  - **Modify**: `src/workflow-artifacts.ts`, `src/index.ts`, `src/plugin-contract.test.ts`
- **Test plan**: Same shape as W3-T1; co-locate `design.test.ts`.
- **Type flow**: `DesignSlug` branded ID, same boundary discipline.
- **Description**: Implement `persist_design({ slug, content })`, `read_design({ slug? })`, `discard_design({ slug?, all? })` writing to `.opencode/designs/<slug>.md`. Parallel implementation to W3-T1.
- **Definition of done**:
  1. Three new tools registered; plugin-contract test asserts exactly 36 tools.
  2. All validation gates pass.
- **Verify**: same as W3-T1.
- **Depends on**: none (within W3); independent of W3-T1 — they can run in parallel since they touch different files in `workflow-tools/` and append-only-distinct rows in `workflow-artifacts.ts`/`plugin-contract.test.ts`. **Caveat**: both edit `workflow-artifacts.ts` and `plugin-contract.test.ts`. Either run them serially or have one executor own both; the recommended approach is **single executor (executor-high) implements both in one task** to avoid the soft conflict on those two shared files.
- **Revised recommendation**: collapse W3-T1 + W3-T2 into a single executor-high task. Keeps the wave at 2 tasks.

### W3-T3: Update fleet manifest expected_tools

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `~/.config/opencode/fleet.jsonc`, regenerated `~/.config/opencode/opencode.json`, `~/.config/opencode/.opencode-fleet.lock.json`
- **Test plan**: N/A — config regeneration.
- **Type flow**: N/A.
- **Description**: Per `~/.config/opencode/AGENTS.md` regeneration workflow:
  1. Edit `fleet.jsonc` conductor entry: bump `expected_tools` from 30 to 36.
  2. Run `bun run /Users/jack.mazac/Developer/opencode-fleet/src/cli.ts generate-opencode-json --force` from `~/.config/opencode/`.
  3. Run `bun run /Users/jack.mazac/Developer/opencode-fleet/src/cli.ts install` to install the updated package.
  4. Run `bun run fleet:test:full-runtime` and confirm green.
  5. Commit `fleet.jsonc` + `opencode.json` + `.opencode-fleet.lock.json` + `package.json` + `bun.lock` as a single logical change.
- **Definition of done**:
  1. Fleet test full-runtime passes with the new tool count.
  2. Lock file drift hash matches; no `CONFIG_DRIFT` exit.
- **Verify**: `bun run fleet:test:full-runtime` from `~/.config/opencode/` returns success; `bun run fleet:doctor -- --json` health report has no warnings about the conductor entry.
- **Depends on**: W3-T1+W3-T2 (collapsed). The conductor package must publish or be linked with the new tools first.

**Definition of Done (Wave 3)**:
- 36-tool conductor passes its own and the fleet's contract tests.
- `~/.config/opencode/fleet.jsonc` and generated `opencode.json` updated and committed.
- No drift warnings.

**Blast radius**: conductor plugin contract surface + fleet manifest + generated config in `~/.config/opencode/`. Rollback: `git revert` in conductor + revert `fleet.jsonc` + regenerate. Lock file tracks both states.

**Dependencies**: depends on W1 only insofar as W1 fixed the prompt landscape; functionally independent. Required by W4 (W4 wires the new tools into prompts).

---

## Wave 4: Wire new tools into prompts (gated on W3)

**Thesis**: Once `persist_brainstorm` and `persist_design` exist, extend the planner→orchestrator handoff pattern to brainstormer→orchestrator→planner and designer→orchestrator→executor.

**Skip this wave entirely** if the user rejected W3 — fall back to the lossy alternatives in W3's "Alternative path."

**Tasks**:

| ID | Task | Files | Executor | Size |
|---|---|---|---|---|
| W4-T1 | Brainstormer persists + emits handoff line; orchestrator threads slug to planners | `prompts/brainstormer.txt`, `prompts/orchestrator.txt` | executor-medium | S |
| W4-T2 | Designer persists in advisory mode + handoff; orchestrator threads slug to executors | `prompts/designer.txt`, `prompts/orchestrator.txt` | executor-medium | S |
| W4-T3 | Compaction template lists brainstorms + designs | `prompts/compaction.txt` | executor-low | S |

### W4-T1: Brainstormer persistence handoff

- **Complexity**: low (mirrors planner fix exactly)
- **Executor**: executor-medium
- **Effort**: S
- **Files**: `prompts/brainstormer.txt`, `prompts/orchestrator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: Two edits, mirroring the planner→orchestrator pattern:
  1. `brainstormer.txt`: after the "Output format" template, add a `# Persist and hand off` section: "After producing the structured analysis, call `persist_brainstorm({ slug, content })` with a descriptive slug and the exact markdown. The **first line** of your chat return to the orchestrator must then be: `Brainstorm: <slug> | Path: .opencode/brainstorms/<slug>.md` — same slug, verbatim. The orchestrator uses this to thread the slug into downstream planner prompts so they can `read_brainstorm(<slug>)` instead of consuming a paraphrase."
  2. `orchestrator.txt` step 1 (Ideation) and `# Planning workflow` step 1 (Brainstorm): "When `brainstormer` returns, capture the `Brainstorm:` slug. If you proceed to planning, include `Brainstorm: <slug>` in each parallel `planner` brief so they can `read_brainstorm(<slug>)`. If a brainstormer return is missing the handoff line, treat as incomplete delegation: re-prompt or re-issue."
  3. `planner.txt`: add a one-line consumer rule under `# Methodology` step 2 (Prime): "If the orchestrator's brief includes `Brainstorm: <slug>`, call `read_brainstorm(<slug>)` before priming so the recommendation, pre-mortem, and tradeoff matrix inform decomposition."
- **Definition of done**:
  1. Brainstormer return format requires the handoff line.
  2. Orchestrator's brainstorm-handling sections both reference the slug threading.
  3. Planner consumes `Brainstorm:` when present.
- **Verify**: `bun run check`; `rg -n "Brainstorm: <slug>" prompts/{brainstormer,orchestrator,planner}.txt` returns at least three matches across files.
- **Depends on**: W3-T1+W3-T2 (collapsed) — `persist_brainstorm` must exist.

### W4-T2: Designer advisory persistence handoff

- **Complexity**: low
- **Executor**: executor-medium
- **Effort**: S
- **Files**: `prompts/designer.txt`, `prompts/orchestrator.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**:
  1. `designer.txt` Output format (line 114): in **advisory mode**, after producing the structured design system, call `persist_design({ slug, content })` and lead the chat return with `Design: <slug> | Path: .opencode/designs/<slug>.md`. **Implementation mode** continues to write files directly and does **not** call `persist_design` (the codebase is the artifact). This preserves the existing two-mode dichotomy without forcing a tool call when files are already written.
  2. `orchestrator.txt` Planning workflow step 3 (around line 145, designer alongside planners): "When designer runs in advisory mode and returns `Design: <slug>`, thread `Design: <slug>` into every UI-touching executor brief so they `read_design(<slug>)` for tokens. When designer runs in implementation mode (writes to `design-system/MASTER.md` or equivalent), point executors at the file path instead — no slug needed."
  3. `executor.txt` consumer rule (one line under `# Targeted reading strategy` or `# On startup`): "If the prompt has `Design: <slug>`, call `read_design(<slug>)` before writing UI code."
- **Definition of done**:
  1. Designer advisory mode requires the handoff line; implementation mode unchanged.
  2. Orchestrator routes both modes correctly.
  3. Executor reads design slug when present.
- **Verify**: `bun run check`; `rg -n "Design: <slug>" prompts/{designer,orchestrator,executor}.txt` returns three+ matches.
- **Depends on**: W3-T1+W3-T2 (collapsed).

### W4-T3: Compaction template lists brainstorms + designs

- **Complexity**: low
- **Executor**: executor-low
- **Effort**: S
- **Files**: `prompts/compaction.txt`
- **Test plan**: N/A — prompt-only.
- **Type flow**: N/A.
- **Description**: After the W1-T5 audits/audit-progress entries, add:
  - **Brainstorms** (`.opencode/brainstorms/<slug>.md`): structured approach analyses via `persist_brainstorm`/`read_brainstorm`. List active brainstorm slugs only when ideation/planning is active or being resumed.
  - **Designs** (`.opencode/designs/<slug>.md`): persisted design systems via `persist_design`/`read_design`. List active design slugs only when UI work is active.
- **Definition of done**:
  1. Both bullets present in `## Persistent stores`.
- **Verify**: `bun run check`; `rg -n "brainstorms|designs" prompts/compaction.txt` returns both.
- **Depends on**: W3-T1+W3-T2; independent of W4-T1, W4-T2 (parallel).

**Definition of Done (Wave 4)**:
- All three tasks complete.
- `bun run check` passes.
- End-to-end smoke: spawn `brainstormer` → confirm handoff line → orchestrator threads to a `planner` → planner reads brainstorm; spawn `designer --advisory` → confirm handoff line → orchestrator threads to a UI executor → executor reads design.

**Blast radius**: 4 prompt files. Rollback: `git revert` the wave commit.

**Dependencies**: depends on W3.

---

## Execution Summary

| Wave | Tasks | Effort | Parallelism | Gate |
|---|---|---|---|---|
| W1 | 5 | S+S+S+S+S | All 5 in parallel (different files) | `bun run check` + `bun run smoke:runtime` |
| W2 | 2 | S+M | Serial (T2 depends on T1) | `bun run check` + diff review |
| W3 | 2 (collapsed T1+T2) + T3 | M + S | Serial (T3 depends on T1+T2) | Full conductor + fleet validation gate |
| W4 | 3 | S+S+S | T3 in parallel with T1+T2 | `bun run check` + smoke loop |

**Total tasks executed**: 11 (W3-T1 and W3-T2 collapse into one).
**Total parallelizable**: W1 fully parallel; W4 has 1 parallel slot.

## Commit Strategy

Per `~/Developer/opencode-conductor/AGENTS.md` and the orchestrator's commit rules. One commit per wave; if a wave's tasks touch unrelated concerns, split into multiple commits. Conventional Commits with deterministic types and scopes derived from the change, **not** from the plan slug:

- W1: `docs(prompts): close validator/suborchestrator/audit/debugger/compaction handoff gaps`
- W2: `docs(prompts): centralize plan-slug discipline as single source of truth`
- W3 (only on user approval): `feat(workflow-tools): add brainstorm and design persistence tools` + `chore(fleet): bump conductor expected_tools to 36 after brainstorm/design tools`
- W4 (only on user approval): `docs(prompts): wire brainstorm and design slug handoffs through orchestrator`

## Risks and open questions

- **Q1**: Does the user want W3+W4 (full fix, new tool surface) or the lossy alternative (W3 skipped, brainstormer→`journal_write`, designer→`--persist` default)? **This blocks the wave-3 gate.** Recommend asking before W1 starts so the plan's terminal state is fixed.
- **Q2**: For gap #6 (designer), is dropping advisory mode entirely acceptable? Implementation mode + `--persist design-system/MASTER.md` is what the underlying skill already encourages (`designer.txt:23–27`). If the user accepts this, W3-T2 (design tool) becomes unnecessary and W4-T2 simplifies. The audit listed this as **alternative (a)**; it's strictly less code than adding `persist_design`.
- **Risk**: W2-T2 touches 6 files for text consolidation. Soft conflict on `orchestrator.txt` if W1-T3 and W1-T4 land in the same wave commit. Mitigation: enforce W1 → W2 ordering as designed; the W2 task reads the post-W1 file.
- **Risk**: W3 fleet manifest update is a cross-repo change (`~/.config/opencode/`). Per the config root's AGENTS.md, this requires regeneration and a single logical commit across `fleet.jsonc` + `opencode.json` + `.opencode-fleet.lock.json` + `package.json` + `bun.lock`. **Do not split** that commit.
- **Risk**: Adding 6 tools to the conductor surface increases prompt-loading context for every session that includes the conductor plugin. Acceptable cost given the durability gain, but worth noting.
- **Open question**: Should `persist_brainstorm` content be limited in size (the brainstormer's output is structured but can be 2–4kb)? Existing subplan/final-plan tools have no explicit size cap; following precedent.
