# Planner A return: Worktree isolation + lifecycle

## Priming

- **User-visible outcome**: each plan runs in an isolated worktree without changing executor/reviewer/scribe prompts; on successful plan completion the branch merges back and disappears, while conflicts leave a clear recovery report.
- **Failure modes**: launcher starts in the wrong root, dependencies are duplicated or broken, Engram/Codemem silently fork state per worktree, merge runs with uncommitted changes, base moved into conflicts, cleanup deletes an active worktree, or telemetry leaks absolute private paths.
- **Patterns to preserve**: contracts owns shared shapes; Fleet owns CLI/process/git orchestration; Conductor owns artifacts and must not shell to git; `.opencode/plans/<slug>.md` paths remain stable; report/telemetry flow stays machine-global and best-effort.
- **Root cause correlation**: most risks are one shared abstraction problem: distinguish the isolated `worktree_path` from the stable `primary_workspace_root` and shared resources once, then let plugins consume metadata instead of re-deriving incompatible paths.
- **Type pipeline (primed)**: one canonical `WorktreeMetadata` contract should flow Fleet create/merge → `.opencode/worktree.json` artifact → Conductor plan index → Engram/Codemem awareness. Status is a closed enum; no ad-hoc normalizers.
- **Contract & vendor audit (primed)**: reviewed Fleet CLI/report patterns (`opencode-fleet/src/cli.ts`, `src/telemetry.ts`), Conductor plan index (`src/plan-artifacts.ts`), contracts artifact/telemetry/id files, Engram `sidecarPath`, Concord correlation/status mirror code, Codemem state-dir derivation, package scripts, and native `git worktree` behavior empirically.
- **Codemem signals (primed)**: `codemem_conflicts` returned no active conflicts. `codemem_change_risk` for Conductor artifact/tool surfaces is high: `src/index.ts`, `src/plan-artifacts.ts`, and `src/plugin-contract.test.ts` sit in a 21-file dependency cone with public exports/API drift findings. Keep Conductor changes additive and small.

## Recommended approach (1 sentence each)
- **Trigger**: choose **Option A**, but make it an internal Fleet/launcher pre-spawn primitive, because only a pre-spawn wrapper can start OpenCode with `cwd` already set to the isolated worktree; `persist_final_plan`/`worktree_enter` side effects cannot reliably change the running orchestrator process root.
- **Storage**: use a separate Fleet-managed working tree path (prefer `~/.local/share/opencode/fleet/worktrees/<repo-hash>/<plan-slug>` over user-visible `~/worktrees`), while letting Git keep its metadata in the primary repo’s `.git/worktrees`; do not put working files inside `.git/worktrees`.
- **node_modules strategy**: do **not** run `bun install` in normal worktree creation; create an absolute `node_modules` symlink to the primary worktree’s `node_modules` and fail fast if it is absent or if dependency files changed and the shared install is stale.
- **Engram DB path**: share the primary workspace DB, physically the primary repo’s existing `.opencode/memory.db` (or configured absolute sidecar path) referenced from `.opencode/worktree.json`, not a child worktree-local `.opencode/memory.db`.
- **Merge trigger + policy**: the pre-spawn Fleet wrapper should run `fleet worktree merge <plan-slug>` after Planner D’s completion/reflection marker or, as a fallback, successful orchestrator exit; merge with `git merge --no-ff` into the recorded base branch, abort on conflicts, keep the worktree, and write `.opencode/merge-conflict.md`.
- **Cleanup**: successful merge deletes the worktree and local plan branch immediately by default; failed/abandoned worktrees are retained with a 7-day cleanup TTL and visible via `fleet worktree list/status --json`.

## Wave-level task breakdown

| ID | Task | Owner repo | Files | Size | Executor tier | Deps | Risks |
|---|---|---|---|---|---|---|---|
| A1 | Add canonical `WorktreeMetadata`, `ArtifactKind: "worktree"`, and explicit worktree telemetry event names with tests. | `opencode-fleet-contracts` | `src/artifacts.ts`, new `src/worktree.ts`, `src/telemetry.ts`, `src/index.ts`, `src/*test.ts`, README | M — small API, broad consumers | executor-medium | none | Must be additive only; no required envelope fields; avoid absolute paths in telemetry payloads. |
| A2 | Implement Fleet worktree core: resolve repo identity, create branch/worktree, write `.opencode/worktree.json`, symlink `node_modules`, list/status/cleanup state, and unit-test gitfile/worktree edge cases. | `opencode-fleet` | new `src/worktree.ts`, `src/index.ts`, `test/worktree.test.ts` | L — git process orchestration + fixtures | executor-high | A1 | Must not block hot path with installs/indexing; cleanup must not delete locked/active worktrees. |
| A3 | Implement Fleet merge protocol: dry-run checks, uncommitted-change guard, stale-base detection, `--no-ff` merge, conflict abort/report, telemetry, delete branch/worktree on success. | `opencode-fleet` | `src/worktree.ts`, `src/cli.ts`, `test/worktree-merge.test.ts`, README | L — destructive git operations need careful tests | executor-high | A2 | Merge commits are irreversible repo history; conflict report must be written before cleanup and never auto-resolve. |
| A4 | Add invisible launcher path: `fleet orchestrator start --plan-slug <slug> [--base <branch>] -- <opencode args>` or equivalent internal entry that prepares the worktree then spawns OpenCode in it. | `opencode-fleet` plus config integration | `src/cli.ts`, `src/worktree.ts`, `test/orchestrator-start.test.ts`, `~/.config/opencode` wrapper docs/scripts if needed | M — process wrapper using existing CLI patterns | executor-medium | A2 | If the normal OpenCode launch path cannot invoke this wrapper, worktree-per-orchestrator is not actually invisible. |
| A5 | Make Conductor metadata-aware without owning git: preserve final plan path convention, add optional `worktree` field to `PlanIndexEntry`, read `.opencode/worktree.json` when present, and test index compatibility. | `opencode-conductor` | `src/plan-artifacts.ts`, `src/plan-artifacts.test.ts`, maybe README | M — additive index change in high-risk cone | executor-medium | A1, A2 | Codemem marks this cone high risk; no tool rename, no `persist_final_plan` git side effects, no new required fields. |
| A6 | Make Engram sidecar DB worktree-aware: decode `WorktreeMetadata` once, use primary/shared DB path when present, preserve existing `.opencode/memory.db` default for non-worktree repos, and run retrieval regression. | `engram` | `src/db.ts`, `src/runtime.ts`, `src/config.ts`, focused tests | M — boundary path change | executor-medium | A1, A2 | Current default is per-worktree; migration must not strand existing memories or widen hot write paths. |
| A7 | Fix Codemem linked-worktree state handling: resolve gitfile actual git dir/common dir deliberately, avoid accidental `<worktree>/.codemem` clutter, and document first-call reindex cost. | `codemem` | `packages/codemem-shared/src/config.ts`, `packages/codemem-plugin/src/daemon/supervisor.ts`, tests | M — path semantics + daemon lifecycle | executor-medium | A2 | Advisory index may reindex per worktree; acceptable only off hot path and cleanly prunable. |
| A8 | Document Concord behavior and add a regression if needed: locks/status mirrors remain worktree-local, while `WorktreeMetadata.primary_workspace_id` is used for cross-worktree reporting only. | `concord` / contracts docs | `packages/concord-plugin/src/correlation.ts` tests or docs only | S/M — likely docs/test only | executor-low/medium | A1 | Current `workspaceId` hashes resolved worktree path, so do not claim it is stable across worktrees unless Planner E changes contracts/host context. |
| A9 | End-to-end fleet validation and config smoke: create isolated worktree, run a no-op plan flow, merge, cleanup, then run full runtime/profile checks. | config + all repos | smoke scripts/docs; no product code unless gaps found | M | executor-medium | A1-A8 | Cross-repo file dependencies and local absolute paths can make CI/non-Jack machines differ. |

## Fleet CLI additions (new subcommands + flags)

- `fleet worktree status <plan-slug> --json [--repo <path>]`: reads `.opencode/worktree.json`, git branch/head/base state, node_modules symlink target, merge status, cleanup eligibility, and emits a report with `fleet_run_id`.
- `fleet worktree list --json [--repo <path>] [--all]`: enumerates Fleet-managed worktrees plus matching `git worktree list --porcelain` entries; marks missing metadata, locked worktrees, stale TTL, and active status.
- `fleet worktree merge <plan-slug> [--dry-run] [--repo <path>] [--delete-branch=true|false]`: guards clean primary/worktree state, checks recorded base SHA vs current base, attempts `--no-ff` merge, writes conflict report on failure, and emits `fleet.worktree.merged` or `fleet.worktree.merge_failed`.
- `fleet worktree cleanup [--older-than <duration>] [--dry-run] [--repo <path>] [--include-merged]`: removes only Fleet-owned worktrees whose metadata is terminal/expired and not Git-locked; never prunes unknown worktrees by default.
- Internal/less-prominent: `fleet orchestrator start --plan-slug <slug> [--base <branch>] -- <opencode args>` (or same behavior embedded in the existing launcher) creates/reuses the worktree and spawns OpenCode there. Do not expose a normal user-facing `fleet worktree create` workflow.

## Contracts impact

Planner E should add a canonical `WorktreeMetadata` type and validator, not parallel shapes. Minimum fields: `schema_version: 1`, `plan_id?`, `plan_slug`, `primary_workspace_id`, `worktree_workspace_id?`, `primary_workspace_root`, `worktree_path`, `git_common_dir`, `branch`, `base_branch`, `base_sha`, `created_at`, `updated_at`, `merged_at?`, `status: "active" | "merge_pending" | "merged" | "merge_failed" | "abandoned"`, `node_modules: { strategy: "symlink" | "none"; target?: string }`, `shared_resources: { engram_db_path?: string; bun_cache_path?: string }`, and `cleanup_after?`. Add `ArtifactKind: "worktree"` for `.opencode/worktree.json`; add optional `PlanIndexEntry.worktree` with a compact subset/ref; add explicit telemetry kinds `fleet.worktree.created`, `fleet.worktree.merged`, `fleet.worktree.merge_failed`, `fleet.worktree.cleaned`. Telemetry metadata should include repo hash, plan slug, status, and durations, but not raw absolute paths unless local-only policy explicitly permits them.

## Integration with existing plugins

**Conductor**: keep Conductor out of git. `persist_final_plan` should not create/merge worktrees because it cannot change the running process root and would couple artifact persistence to Git. The only Conductor change should be additive awareness: if `.opencode/worktree.json` exists, include a worktree ref/status in `.opencode/plans/index.json` and any future plan-completion marker. Validation remains `bun run check`, `bun run smoke:runtime`, `bun run doctor -- --json`, and `bun run status -- --json`.

**Engram**: current code uses `.opencode/memory.db` relative to `input.worktree`, so a child worktree would fork memory today. Change Engram to decode `WorktreeMetadata` once at startup and use the primary/shared DB path when present, while preserving the current relative default for ordinary repos. This is retrieval-sensitive: after implementation run `bun run check`, `bun run smoke:runtime`, `bun run doctor`, and `bun run sprint` (local eval/regression) from `engram`.

**Concord**: current `workspaceId` is `sha256(path.resolve(worktreeRoot))`, so it is not stable across linked worktrees. That is acceptable for live hunk locks because each isolated worktree has local `.opencode/status/run-*.json` mirrors and merge-time Git conflicts are the cross-worktree arbiter. For fleet-wide correlation, use `primary_workspace_id` from metadata/host context rather than changing lock semantics blindly.

**Codemem**: current config falls back to `<projectRoot>/.codemem` when `.git` is a gitfile, which is likely in linked worktrees and violates cleanup/minimal-clutter goals. Fix gitfile resolution so state is under Git-managed worktree/common metadata, or explicitly choose per-worktree state with cleanup. Reindex on first codemem call is acceptable because codemem is advisory and not in orchestrator spawn/wave hot paths; verify with `bun run typecheck`, `bun run test`, and `bun run smoke:runtime` where applicable.

**~/.config/opencode**: normal user commands should not change. If the OpenCode launch path is configured here, update generated/managed wrappers only through `fleet.jsonc` → `opencode.json` regeneration rules; do not hand-edit generated `opencode.json`. Fleet reports and host-adapter telemetry remain machine-global under `~/.local/share/opencode/...`.

## Dependencies on other planners

- **Planner B (suborch/waves)**: wave ownership must define when wave commits are created; merge requires the worktree branch to have committed changes and no dirty state.
- **Planner C (snapshots)**: snapshots should reference `WorktreeMetadata`/branch/head/base SHAs, not blob copies, and final plan persistence should preserve contributing subplan refs inside the worktree.
- **Planner D (reflection)**: reflection must run before merge and should produce the completion marker consumed by the wrapper; do not merge before reflection artifacts are written.
- **Planner E (cross-cutting)**: owns the final contract shape, telemetry event names, privacy policy for paths, and migration guidance for workspace IDs that are currently path-derived.

## Open questions / user decisions

- Dependency-changing plans conflict with “no per-worktree `node_modules` duplication”: should Fleet fail fast until the primary shared install is refreshed, or may it mutate primary `node_modules` during an isolated plan? I recommend fail-fast by default with an explicit recovery command.
- Auto-merge with `--no-ff` creates merge commits in the user’s repo history. I recommend this because the user already asked to preserve wave commits, but it is the only irreversible-history policy worth confirming before implementation.

## Type flow claim

The design has one canonical `WorktreeMetadata` contract produced by Fleet at the boundary and consumed by Conductor, Engram, Codemem, and reporting. Fleet validates plan IDs/slugs with existing parsers, writes the metadata artifact, and downstream packages perform one validated decode at startup/read time. There should be no `as` casts, no package-local `normalizeWorktree*` stacks, and no plugin-specific shadow interfaces; if a field is missing, extend the contract additively or fail with a typed recovery message.

## Empirical findings

- `git worktree add --detach` for `opencode-fleet` took **0.070–0.074s** and created no `node_modules`; the linked worktree `.git` was a **92-byte gitfile**.
- Bun cache is global at **`/Users/jack.mazac/.bun/install/cache`** (`bun pm cache`), but `bun install` still materializes a local `node_modules` directory.
- In a sibling worktree under `/Users/jack.mazac/Developer`, `bun install --frozen-lockfile` succeeded in **0.930s** (`35 packages installed [891ms]`) but created a **93M** `node_modules`; local `file:../...` deps were materialized as directories, not symlinks.
- In an arbitrary temp worktree under `/var/folders/.../opencode`, `bun install --frozen-lockfile` failed in **0.581s** because `file:../opencode-fleet-contracts` and `file:../opencode-host-adapter` resolved relative to the new path; it still created a **93M** partial `node_modules`.
- Creating the worktree plus an absolute `node_modules` symlink to the primary repo took **0.077s**, consumed **0B** for the symlink itself, and `bun run typecheck` in that symlinked worktree exited **0** in **0.160s**. This is the only measured strategy satisfying the <2s hot-path and minimal-disk constraints for the current fleet.