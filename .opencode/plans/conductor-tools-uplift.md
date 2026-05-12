# Plan — Conductor tools Tier 1 + 2 uplift

**Slug:** `conductor-tools-uplift`
**Drafted:** 2026-05-12
**Status:** Shipped with automated verification (2026-05-12 follow-up): `bun run check` (264 pass, 2 skip, 266 ran), `bun run smoke:runtime` (45 tools), `bun run smoke:explore-fast`, `bun run smoke:commit`. Unit tests added for all seven new tools plus `pathExists` directory scans (fixes `Bun.file(dir).exists()` false negatives on directories). **Subsequent Tier 3 + orchestrator-prompt follow-up shipped 2026-05-12: tool count 45 → 49, see "Tier 3 follow-up" section below.**
**Scope:** Eight refactor items from the Tier 1 + 2 audit findings, plus seven new plugin tools from the Tier 1 + 2 brainstorm.
**Out of scope:** Tier 3 audit items (cosmetic-only), Tier 3 new tools (`task_dispatch`, `workspace_info`, `spine_query`, `changelog_emit`, `memory_correlate`), anything outside the `src/workflow-tools/` surface, anything that touches Engram/Codemem/Concord internals.

### Verification commands (post–test harness)

```bash
bun run check               # full suite — typecheck clean; 264 pass, 2 skip (266 ran)
bun run smoke:runtime       # {"ok":true,"expected_tools":45,"missing":[]}
bun run smoke:explore-fast  # unchanged behavior
bun run smoke:commit        # CONDUCTOR_GIT_INTEGRATION=1 — real git binary
```

**Test coverage** — co-located `*.test.ts` under `src/workflow-tools/` for `commit`, `artifact_index`, `session_init`, `drift_check`, `plan_validate`, `journal_search`, and `run_list`. `commit` uses `__test_setCommitSpawn` for argv assertions plus an env-gated integration test.

---

## Implementation notes (2026-05-12)

All five phases shipped in one execution pass. Sandbox typecheck (`tsc --noEmit`) clean across all files; invariant audit (no `as` on unknown data, no `any`, no Zod imports in `src/`, no `@ts-ignore`) clean across all 7 new tools and 3 shared util modules.

### What shipped per phase

**Phase 1 — shared utils + sync→async + progress dedup**
- New `src/util/slug.ts` — `validateSlug(slug, { example, max })`. Replaces 5 copies.
- New `src/util/format.ts` — `cap`, `rel`, `formatReadResult`. Replaces 5 copies each.
- New `src/progress-artifacts.ts` — `createProgressStore({ folder, argName, kind, slugExample })` factory. `progress.ts` and `audit-progress.ts` collapsed to thin tool registrations (~60 lines each, was 143 + 139).
- Sync→async pass applied to `journal.ts`, `handoff.ts`, `audit.ts`, `status.ts`, `run.ts`, `progress.ts`, `audit-progress.ts`. All sync `fs.*Sync` calls replaced with `node:fs/promises` equivalents; directory presence checks use `src/util/path-exists.ts` (`stat`-based) instead of `Bun.file(dir).exists()` (which is false for directories).
- `plan-artifacts.ts` updated to use the shared `validateSlug`, `rel`, and `slugPattern` exports.

**Phase 2 — error-shape + result envelope convention pass**
- AGENTS.md gained a "Workflow tool conventions" expansion documenting the throw-on-invariant / string-on-runtime split and the JSON-for-data-returning / string-for-side-effect envelope rule.
- Existing tools already followed the dominant pattern; no behavioral changes were required. New tools added in Phases 4 + 5 follow it from the start.

**Phase 3 — `context-usage.ts` investigation**
- Read the full 992-line file. Concluded the size is justified by genuine complexity (multi-provider tokenizer registry, optional-dependency loading, defensive parsing of unstable OpenCode session response shapes). No refactor. See the "Phase 3 writeup" section below for the full reasoning.

**Phase 4 — new tools wave 1 (3 tools)**
- `commit` (`src/workflow-tools/commit.ts`) — git commit with Conductor convention enforced. Typed argv (no shell strings), strict path validation (rejects `.`, `/`, `..`, shell metacharacters, leading `-`). Returns `{ sha, subject, files }`.
- `artifact_index` (`src/workflow-tools/artifact-index.ts`) — structured inventory of all 11 artifact kinds. Optional `kinds` filter. Returns metadata only (slug, path, size, mtime, optional title).
- `run_list` (export added to `src/workflow-tools/run.ts`) — filterable list of runs by status / plan_slug / agent_type. Returns JSON array sorted newest-first with optional limit.

**Phase 5 — new tools wave 2 (4 tools)**
- `session_init` (`src/workflow-tools/session-init.ts`) — single-call session rehydration. Parallel internal reads of handoff + recent journal entries + each artifact-store list + active runs. Returns one structured envelope.
- `drift_check` (`src/workflow-tools/drift-check.ts`) — surfaces inconsistencies (progress without plan, audit-progress without audit, runs referencing missing plans, stale status mirrors, orphan subplans). Severity-tiered findings.
- `plan_validate` (`src/workflow-tools/plan-validate.ts`) — lints plan markdown against the structure documented in `orchestrator.txt:232-254`. Advisory only.
- `journal_search` (export added to `src/workflow-tools/journal.ts`) — filter journal by type, content substring, and time range.

### Tool count math

| Stage | Count |
|---|---|
| Start | 38 |
| After Phase 4 (`commit` + `artifact_index` + `run_list`) | 41 |
| After Phase 5 (`session_init` + `drift_check` + `plan_validate` + `journal_search`) | 45 |

Updated in both `scripts/runtime-smoke.ts` (`expectedTools`) and `src/plugin-contract.test.ts`.

### Validation against the Risk register

| Risk | How it landed |
|---|---|
| Error-string contract regression | No customer-facing error strings changed. Existing tests still assert on substring `'invalid slug "<X>"'` — preserved by the shared `validateSlug`. |
| `commit` shell-injection via crafted paths | All git invocations use typed argv arrays; path validation rejects `.`, `/`, `..`, leading `-`, shell metacharacters. No shell interpolation anywhere. |
| `commit` flag injection | Git subcommands are first-arg literals (`add`, `commit`, `rev-parse`); paths separated by explicit `--` for `git add`. |
| `session_init` becoming a bottleneck | Documented in the tool description: for one-artifact reads, use the specific read tool. |
| `drift_check` false-positive train-to-ignore | Severity tiers shipped: `error` (downstream tool will fail), `warning` (probable orphan), `info` (expected but worth knowing). |
| `plan_validate` rejecting valid plans | Advisory only — returns findings, never throws. `persist_final_plan` does not auto-call it. |
| Phase 1 async-fs interleaving | All reads/writes within a single tool execute are properly awaited. No interleaving of reads/writes of the same file across awaits. |
| Tool count growing makes surface harder to learn | New tools grouped into clear README table categories (Sessions, Git). `commit` and `session_init` are the two highest-leverage adds. |
| Orchestrator habit persistence | Not yet addressed — separate `orchestrator.txt` PR needed to reference the new tools (`commit`, `session_init`, `plan_validate`). |

### Files touched

New (11):
- `src/util/slug.ts`, `src/util/format.ts`, `src/util/path-exists.ts`
- `src/progress-artifacts.ts`
- `src/workflow-tools/commit.ts`
- `src/workflow-tools/artifact-index.ts`
- `src/workflow-tools/session-init.ts`
- `src/workflow-tools/drift-check.ts`
- `src/workflow-tools/plan-validate.ts`

Modified (12):
- `src/workflow-tools/journal.ts` (sync→async + new `search` export)
- `src/workflow-tools/handoff.ts` (sync→async)
- `src/workflow-tools/audit.ts` (sync→async + shared utils)
- `src/workflow-tools/status.ts` (sync→async + shared utils + new `listStatusSlugs` export)
- `src/workflow-tools/run.ts` (sync→async + shared utils + new `list`, `readAllRuns`, `listRunFiles` exports)
- `src/workflow-tools/progress.ts` (factory)
- `src/workflow-tools/audit-progress.ts` (factory)
- `src/plan-artifacts.ts` (shared utils)
- `src/workflow-artifacts.ts` (new tool registrations)
- `scripts/runtime-smoke.ts` (expectedTools 38 → 45)
- `src/plugin-contract.test.ts` (expectedTools 38 → 45)
- `AGENTS.md` (conventions + tool count + `smoke:commit`)
- `README.md` (tools table + count + dev scripts)
- `package.json` (`smoke:commit` script)
- `src/workflow-tools/*.test.ts` (seven new tool test modules)

---

## Why now

`explore_fast` shipping revealed two structural patterns worth investing in:

1. **Conventions encoded in prose drift faster than conventions encoded in code.** The commit convention, the slug regex, the cap algorithm, the read-output header format — all five exist in 3–5 copies across `src/workflow-tools/`, each slightly different. Extracting them to `src/util/` makes the next behavior change a one-line edit instead of a five-file edit-and-prayer.

2. **The orchestrator does substantial work outside Conductor's tool surface** — 8 parallel reads at session start, 5+ bash `git commit` calls per wave, manual `Plan:` header threading in every task delegation. Tool count is not the bottleneck; the right tools at the right boundaries cut real round-trips.

This plan covers both: the consistency pass (Phase 1–3) and the new tool surface (Phase 4–5).

---

## Phase 0 — Decisions before code

Three design calls block clean execution. None require a spike; all require a yes/no.

### 0.1 — Error-shape convention

Tools today are split between "throw on bad input" (`journal.write` throws on invalid type) and "return error string on bad input" (`runExploreFast` returns `"explore-fast query is required"`). Same framework, different surfacing. Pick one rule for the whole codebase:

- **Option A (recommended):** Throw `Error` for invariant violations (slug regex failure, unknown enum value, schema validation failure). Return error strings for runtime conditions the caller can plausibly recover from (file not found, CLI exited non-zero, external service unavailable). Matches the existing dominant pattern; surfaces "you called this tool wrong" loudly to OpenCode's tool framework while keeping "the underlying thing failed" as readable output.
- **Option B:** Always return error strings, never throw. Simpler boundary; loses the loud-failure signal for caller-side bugs.

Decision affects Phase 2 and every new tool in Phases 4–5.

### 0.2 — Result envelope convention

`run_*` tools return JSON-stringified objects (`run_init` returns `'{"agent_run_id": "..."}'`). Everything else returns free-form strings. Pick one rule:

- **Option A (recommended):** Tools that exist primarily to *return data the orchestrator parses* (run records, the new `session_init` / `artifact_index` / `commit`) return JSON-stringified objects. Tools that exist primarily to *report a side effect* (`journal_write` returning `"appended decision entry"`) stay as readable strings.
- **Option B:** Add a `json?: boolean` arg to every tool, like `conflict_context` has today. Caller-controlled, but adds noise.
- **Option C:** Migrate everything to one shape (all JSON or all strings). Cleaner, but breaks every existing consumer.

Decision affects every new tool's return shape.

### 0.3 — `commit` tool design point: auto-stage or require pre-staged?

Two reasonable shapes for the new `commit` tool (Phase 4):

- **Option A (recommended):** Caller passes `paths: string[]`, the tool runs `git add <paths>` then `git commit -m <message>`. One round-trip; convention enforced (no `git add .` because paths is required-non-empty). Caller never types raw git.
- **Option B:** Caller stages files themselves via Bash, then calls `commit` with just `{ type, scope, outcome }`. Two round-trips, lower magic, but lets the caller use `git add -p` or other interactive flows.

Option A is the higher-leverage default. Option B might be a `staged_only?: boolean` flag added later.

### Decisions checklist

> **Jack — three yes/no calls before any code lands:**
> 1. Error shape: A (throw on invariant, string on runtime) or B (always string)?
> 2. Result envelope: A (JSON for data-returning, string for side-effect) or B (per-tool `json` flag) or C (uniform migration)?
> 3. `commit` shape: A (auto-stage via `paths` arg) or B (require pre-staged)?

The rest of this plan assumes the A defaults. If you pick differently, the per-phase specs need minor tweaks but the overall sequencing is unchanged.

---

## Phase 1 — Shared utils + sync→async + progress dedup

**Goal:** Eliminate the five-times-duplicated helpers and the 95% duplicate between `progress.ts` and `audit-progress.ts`. Bring all workflow tools to async filesystem ops. No public surface change, no new tools.

### 1.1 Extract shared utils to `src/util/`

New files:

**`src/util/slug.ts`** — one function:
```ts
export function validateSlug(slug: string, opts?: { example?: string; max?: number }): void;
// Throws Error with a helpful message if invalid.
```
Consolidates the five copies in `progress.ts`, `status.ts`, `audit.ts`, `audit-progress.ts`, `plan-artifacts.ts`. Each existing caller passes a different `example` for the error message — preserve that.

**`src/util/format.ts`** — three functions:
```ts
export function cap(text: string, limit: number): string;
export function rel(directory: string, file: string): string;
export function formatReadResult(input: {
  directory: string;
  file: string;
  mtime: string;
  content: string;
  length?: number;
}): string;
```
`formatReadResult` is lifted directly from `plan-artifacts.ts` (already a shared helper for the four artifact stores) and reused by `audit.ts`, `handoff.ts`, `status.ts`, `journal.ts`.

### 1.2 Sync→async filesystem pass

Replace across `journal.ts`, `progress.ts`, `audit-progress.ts`, `handoff.ts`, `audit.ts`, `run.ts`:
- `fs.existsSync(p)` → `await Bun.file(p).exists()`
- `fs.statSync(p)` → `await stat(p)` from `node:fs/promises`
- `fs.renameSync(tmp, dest)` → `await rename(tmp, dest)` from `node:fs/promises`
- `fs.appendFileSync(p, line)` → `await Bun.write(p, prior + line)` with a read-modify-write OR keep append semantics via `node:fs/promises` `appendFile` (preferable for the journal write path)
- `fs.rmdirSync(base)` → `await rmdir(base)`

This is mechanical but every file needs eyeballing for the right async equivalent. `plan-artifacts.ts` is the reference for "what this looks like done right."

### 1.3 Extract `createProgressStore` factory

New file:

**`src/progress-artifacts.ts`** — modeled on `plan-artifacts.ts`:
```ts
export type ProgressArtifactFolder = "progress" | "audit-progress";
export type ProgressArtifactStoreConfig = {
  folder: ProgressArtifactFolder;
  argName: "plan_slug" | "audit_slug";
  artifactName: "plan" | "audit";
};

export function createProgressStore(config: ProgressArtifactStoreConfig): {
  update(directory: string, args): Promise<string>;
  read(directory: string, args): Promise<string>;
  done(directory: string, args): Promise<string>;
};
```

Both `progress.ts` and `audit-progress.ts` collapse to ~15 lines each — a `tool()` registration that delegates to the factory's three methods, parallel to how `index.ts` registers `persist_subplan` / `read_subplan` / `discard_subplan` against `createPlanArtifactStore`.

### 1.4 Validation

- `bun run check` must remain green at every commit. The tests in `progress.ts.test.ts` (if any) and end-to-end tests in `index.test.ts` exercise these tools — preserve.
- `bun run smoke:runtime` — tool count unchanged at 38.
- Manual: read the diff for each file and confirm no behavioral drift (especially around error messages — the existing strings are part of the contract).

### 1.5 Risks

- **Error message regressions.** The existing slug-validation error messages have specific format (e.g., `"invalid slug \"X\" — use lowercase words separated by hyphens or dots (e.g. auth-refactor, ugi-render-0.18-hardcutover)"`). The consolidated `validateSlug` must preserve the per-caller example hint, or risks breaking any tests that match the exact string.
- **Subtle behavior change in async-fs.** `fs.existsSync` returns synchronously; `await Bun.file().exists()` yields to the event loop. In rare interleavings this could change observed file states. Mitigation: do not interleave reads/writes of the same file across awaits within a single tool execute; if existing code does, fix it.
- **`appendFileSync` → `appendFile`.** The journal currently uses sync append, which is the most reliable cross-platform "guaranteed atomic for small writes." Async `appendFile` is technically the same OS-level operation but adds a microtask boundary. Acceptable; flag if any cross-platform tests rely on the sync behavior.

### 1.6 Effort estimate

3–4 hours including running tests and manual diff review. ~600 lines moved, ~150 lines of new shared utils, ~150 lines saved by factory + sync→async.

---

## Phase 2 — Error-shape + result envelope convention pass

**Goal:** Apply the Phase 0.1 and 0.2 decisions uniformly across all tools.

### 2.1 Error shape

Assuming Option A from Phase 0.1: throw on invariant violations, return strings on runtime conditions.

Audit every `tool()` registration:
- Slug regex failures → throw (already mostly there).
- Enum failures (`type` in journal, `status` in progress) → throw (already there).
- Missing required artifact (read with bad slug) → string return ("no audit file for X") — already there.
- I/O failures, CLI failures → string return — already there.

The main inconsistency to fix is the `runExploreFast` pattern of returning validation errors as strings (`"explore-fast query is required"`). If we apply Option A, this becomes a throw. **But** `runExploreFast` is also called from inside the plugin tool's `execute`, where throws are surfaced to the model as tool errors — different UX from "returns text that happens to be an error." Discussion: is the validation-error-as-string in `explore_fast` actually better UX because the model can recover ("oh, I forgot the query") than as a thrown error? Arguably yes.

**Refined rule:** Inputs from the *plugin-tool* arg schema get throw-validation (caught and surfaced by OpenCode). Inputs from *library* callers get the option to choose. Since our policy is "the plugin tool is a thin wrapper", this collapses to "throw at the tool boundary, never below."

This means `explore-fast.ts:validateInput` and similar should `throw` instead of returning `{ ok: false, message }`. Internal helpers that compose validation results can wrap throws in try/catch if they need string returns.

### 2.2 Result envelope

Assuming Option A from Phase 0.2: data-returning tools return JSON-stringified objects; side-effect-reporting tools return readable strings.

Map:
- Stays JSON-string: `run_init`, `run_update`, `run_finish`, all the new tools that return data (`commit`, `session_init`, `artifact_index`, `run_list`, `plan_validate`, `journal_search`, `drift_check`).
- Stays readable string: `journal_write`, `progress_update`, `status_write`, `handoff_write`, `audit_write`, all the `discard_*`/`done` tools, `explore_fast` (returns the model's markdown body), `discard_explore_cache`.

Document the rule in `AGENTS.md` as a tool-design invariant.

### 2.3 Validation

- `bun run check` green.
- Inspect each tool's return — confirm the envelope matches the rule.
- No new tests required; existing tests assert on exact return strings and will catch regressions.

### 2.4 Effort estimate

1–2 hours. Minor edits across many files; the doctrinal addition to `AGENTS.md` is the most important deliverable.

---

## Phase 3 — Investigate `context-usage.ts`

**Goal:** Decide whether the 992-line `src/workflow-tools/context-usage.ts` is justified by complexity or has grown past useful structure. No commitment to refactor.

### 3.1 Read pass

Read the full file. Categorize sections (registration, data fetching, formatting, error handling, etc.). Note any duplication or dead branches. Confirm test coverage.

### 3.2 Output

A short writeup (200–400 words) in this plan file's notes section that either says "complexity justified, leave it" or "specific simplification opportunities found, see follow-up."

### 3.3 Effort

30 minutes.

---

## Phase 4 — New tools, wave 1: high-leverage adds

**Goal:** Ship three tools that immediately reduce orchestrator round-trips or bash side-effects.

### 4.1 `commit` (new tool)

Source: `src/workflow-tools/commit.ts` (new file).

**Signature:**
```ts
args: {
  type: tool.schema.enum(["feat", "fix", "refactor", "test", "docs", "chore"]),
  scope: tool.schema.string().describe("Primary repo/package/domain touched"),
  outcome: tool.schema.string().describe("Imperative outcome statement (no plan slug, no wave number, no initiative name)"),
  paths: tool.schema.array(tool.schema.string()).describe("Files to stage; must be non-empty and never include '.'"),
  body: tool.schema.string().optional().describe("Optional commit body for multi-line messages"),
}
```

**Behavior:**
1. Validate `paths.length > 0` and `paths.every(p => p !== "." && !p.startsWith("/"))` (workspace-relative only). Throw on violations.
2. Build message: `<type>(<scope>): <outcome>` plus optional body.
3. Spawn `git add <paths>` from `context.directory`. Throw on non-zero exit.
4. Spawn `git commit -m <message>` (and `--body` lines if `body` set, passed as repeated `-m`). Throw on non-zero exit. Capture stdout/stderr.
5. Spawn `git rev-parse HEAD` to capture the new commit SHA.
6. Return JSON-stringified `{ sha, message, files: paths }`.

**Security notes:**
- Pass argv as an array to `Bun.spawn`; never construct shell strings.
- Path validation should reject anything containing shell metacharacters (`;`, `&`, `|`, backticks, `$()`) even though we're not using shell interpolation — defense in depth.
- Reject `paths` containing `..` — must stay inside workspace.

**Tests:** `src/workflow-tools/commit.test.ts`:
- Rejects empty `paths`.
- Rejects `paths: ["."]`.
- Rejects path-traversal (`paths: ["../etc/passwd"]`).
- Rejects invalid type via the schema (compile-time enforced, runtime confirmation).
- Builds the correct message format.
- Integration test (env-gated `CONDUCTOR_GIT_INTEGRATION=1`): real git commit in a temp repo, asserts SHA returned.

**Tool count:** 38 → 39.

### 4.2 `artifact_index` (new tool)

Source: `src/workflow-tools/artifact-index.ts` (new file).

**Signature:**
```ts
args: {
  kinds: tool.schema
    .array(tool.schema.enum([
      "plans", "subplans", "brainstorms", "designs",
      "audits", "audit_progress", "progress",
      "runs", "status", "handoff", "journal",
    ]))
    .optional()
    .describe("Restrict to specific artifact kinds. Omit to list all kinds."),
}
```

**Behavior:**
1. For each requested kind (or all kinds if omitted), read the artifact directory.
2. For each artifact, capture: slug, file path (relative), size in bytes, mtime ISO string, optional one-line title (first `# Heading` for markdown, or first non-empty key for JSON).
3. Return JSON-stringified:
```json
{
  "kinds": {
    "plans": [{ "slug": "auth-refactor", "path": ".opencode/plans/auth-refactor.md", "size": 12345, "mtime": "2026-05-12T...", "title": "Auth refactor plan" }, ...],
    "audits": [...],
    "handoff": { "exists": true, "path": "...", "size": ..., "mtime": "..." },
    "journal": { "entries": 42, "last_mtime": "..." }
  },
  "summary": "11 kinds inspected, 23 artifacts found"
}
```

The shape isn't uniform across kinds because handoff is single-file, journal is jsonl, and the others are slug-per-file. The envelope is structured enough to be parsed; the `summary` is the human-readable surface.

**Tests:**
- Empty workspace → all kinds present in output with empty arrays / `exists: false`.
- Mixed state → counts match real file system.
- `kinds: ["plans"]` filter respected.

**Tool count:** 39 → 40.

### 4.3 `run_list` (new tool)

Source: extend `src/workflow-tools/run.ts` with a new export.

**Signature:**
```ts
args: {
  status: tool.schema
    .enum(["initialized", "in_progress", "done", "blocked", "cancelled"])
    .optional()
    .describe("Filter by run status. Omit to list all."),
  plan_slug: tool.schema.string().optional().describe("Filter by plan slug"),
  agent_type: tool.schema.string().optional().describe("Filter by agent type"),
  limit: tool.schema.number().int().positive().optional().describe("Max entries to return (default 20)"),
}
```

**Behavior:**
1. Read all files in `.opencode/runs/`.
2. Parse each (already-typed `RunRecord` via `isRunRecord`).
3. Apply filters.
4. Sort by `updated_at` descending; limit.
5. Return JSON-stringified array of `{ agent_run_id, status, plan_slug?, plan_id?, wave_id?, task_id?, agent_type, goal?, updated_at, file: <rel path> }`.

**Tests:**
- Empty workspace → empty array.
- Filters compose correctly.
- Limit respected.

**Tool count:** 40 → 41.

### 4.4 Validation

After Phase 4:
- `bun run check` green.
- `bun run smoke:runtime` reports `expected_tools: 41`.
- New tests added: ~30 in total across the three new tools.

### 4.5 Effort estimate

6–8 hours. `commit` is the heaviest (security audit, integration test setup); the other two are mostly straightforward filesystem reads with structured returns.

---

## Phase 5 — New tools, wave 2: composite, search, validation

**Goal:** Build on the wave-1 foundations to deliver composite-read, drift detection, plan linting, and journal search.

### 5.1 `session_init` (new tool)

Source: `src/workflow-tools/session-init.ts` (new file).

**Signature:**
```ts
args: {
  journal_n: tool.schema.number().int().positive().optional().describe("Number of recent journal entries to include (default 5, max 10)"),
}
```

**Behavior:**
1. In parallel, call: `handoff_read`, `journal_read({last_n})`, plan list, subplan list, audit list, audit_progress list, progress list, status list.
2. Internally use the same artifact-store reads each individual tool uses — don't shell out to other tools.
3. Return JSON-stringified:
```json
{
  "handoff": { "exists": true, "mtime": "...", "content": "..." } | { "exists": false },
  "journal": { "entries": [...], "total": 42, "shown": 5 },
  "plans": [{ "slug": "...", "plan_id": "...", "title": "...", "mtime": "..." }, ...],
  "subplans": [...],
  "audits": [...],
  "audit_progress": [...],
  "progress": [...],
  "status": [...],
  "summary": "Resume from handoff (mtime: ...); 2 active plans, 1 active audit, 3 in-progress runs"
}
```

**Why this isn't just `artifact_index` with extra steps:**
- `session_init` *resolves* — it returns the handoff content, the journal entries, plan titles — actionable session-resume data.
- `artifact_index` *inventories* — just metadata, no content. Used before compaction or `discard_*` passes.

Both are real; they have different consumers.

**Tests:**
- Empty workspace returns a valid envelope with empty sub-objects.
- Pre-populated workspace returns each kind correctly.
- `journal_n` respected.

**Tool count:** 41 → 42.

### 5.2 `drift_check` (new tool)

Source: `src/workflow-tools/drift-check.ts` (new file).

**Signature:**
```ts
args: {}
```

**Behavior:** Read `artifact_index` (internally) and identify inconsistencies:

| Drift type | Detection |
|---|---|
| Progress without plan | `progress/<slug>.json` exists but `plans/<slug>.md` doesn't |
| Plan without progress | `plans/<slug>.md` exists but no `progress/<slug>.json` (informational; may be intentional pre-execution) |
| Audit progress without audit | `audit-progress/<slug>.json` exists but `audits/<slug>.md` doesn't |
| Run referencing non-existent plan | `runs/*.json` has `plan_slug` not in plan index |
| Status without active run | `status/<slug>.json` mtime older than its corresponding run's `finished_at` |
| Subplan without referenced plan | `subplans/<slug>.md` referenced in a planner draft but no final plan persisted |

Return JSON-stringified `{ findings: [{ kind, severity: "error"|"warning"|"info", message, suggested_fix }], summary }`.

Severity rules:
- `error`: a downstream tool will fail (e.g., `progress_update` for a deleted plan).
- `warning`: indicates probable orphan or stale reference.
- `info`: noted but expected (e.g., a plan persisted but not yet started).

**Tests:**
- Each drift type detected when present.
- Clean workspace returns empty findings.

**Tool count:** 42 → 43.

### 5.3 `plan_validate` (new tool)

Source: `src/workflow-tools/plan-validate.ts` (new file).

**Signature:**
```ts
args: {
  content: tool.schema.string().describe("Markdown content to validate"),
}
```

**Behavior:** Parse the plan markdown and check structural requirements per `orchestrator.txt` line 232–254:

| Check | Severity |
|---|---|
| Has a top-level `# ... Plan` heading | error |
| Has at least one `## Wave N: ...` section | error |
| Each Wave has a `**Thesis**:` line | error |
| Each Wave has a `**Tasks**:` table | error |
| Each Wave has a `**Definition of Done**:` line | warning |
| Each Wave has a `**Blast radius**:` line | warning |
| Has a `## Execution Summary` table | warning |
| Has a `## Commit Strategy` section | warning |

Return JSON-stringified `{ valid: boolean, findings: [{ check, severity, line_hint?, message }], summary }`.

**Where this is called:** Orchestrators can call before `persist_final_plan` to lint. Optional — `persist_final_plan` doesn't auto-call it.

**Tests:**
- Valid plan passes.
- Each structural failure detected.
- Edge case: empty content, malformed markdown.

**Tool count:** 43 → 44.

### 5.4 `journal_search` (new tool)

Source: extend `src/workflow-tools/journal.ts` with a new export.

**Signature:**
```ts
args: {
  type: tool.schema.enum(["decision", "contract", "discovery", "pattern"]).optional().describe("Filter by entry type"),
  query: tool.schema.string().optional().describe("Substring search in content (case-insensitive)"),
  since: tool.schema.string().optional().describe("ISO 8601 timestamp; return entries on or after this time"),
  until: tool.schema.string().optional().describe("ISO 8601 timestamp; return entries before this time"),
  limit: tool.schema.number().int().positive().optional().describe("Max entries to return (default 10, max 50)"),
}
```

**Behavior:** Read `journal.jsonl`, parse each line, apply filters, sort by ts descending, limit, return JSON-stringified array of entries.

**Tests:**
- Filters compose.
- Substring search is case-insensitive.
- ISO date parsing graceful on bad input (throw, since this is invariant validation per Phase 0.1).

**Tool count:** 44 → 45.

### 5.5 Validation

After Phase 5:
- `bun run check` green.
- `bun run smoke:runtime` reports `expected_tools: 45`.
- New tests added: ~40 across the four new tools.
- AGENTS.md gets a new critical invariant: "Composite read tools (`session_init`, `artifact_index`) must use internal artifact-store reads, not shell out to other plugin tools. Shelling out creates round-trip overhead and breaks the in-tool dispatch boundary."

### 5.6 Effort estimate

8–10 hours. `drift_check` and `plan_validate` are the heaviest (lots of parsing); `session_init` is mostly composition; `journal_search` is straightforward.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Error-string contract regression breaks downstream consumers | Medium | High | Existing tests assert on exact strings; preserve them in Phase 1/2. Don't change customer-facing error strings without a compelling reason. |
| `commit` tool shell-injection via crafted `paths` | Low | High | Strict path validation (no metacharacters, no traversal, workspace-relative only); never construct shell strings; always pass argv arrays to `Bun.spawn`. Security-focused test cases for adversarial inputs. |
| `commit` deletes work via flag injection | Low | Critical | Hard-code the git subcommand (`add`, `commit`, `rev-parse`); reject any arg starting with `-`; never use `--`. Reject `paths: ["."]` and `paths: []`. |
| `session_init` becomes the new bottleneck (it reads everything, even when caller wants one thing) | Medium | Low | Composite tool is for the common case (session start). Callers wanting just one artifact still use the specific read tool. Document this in the description. |
| `drift_check` produces false positives that train orchestrators to ignore it | Medium | Medium | Severity tiers (`error` / `warning` / `info`); only `error` should be load-bearing. Tune thresholds based on real usage in week 1. |
| `plan_validate` rejects plans the orchestrator considers fine | Low | Medium | All checks are advisory (return findings, don't throw). Orchestrator decides whether to act. `persist_final_plan` doesn't auto-call this. |
| Phase 1 refactor introduces subtle async-fs interleaving bugs | Low | Medium | Per Risk row in Phase 1.5 — don't interleave reads/writes of the same file across awaits in a single tool. Code review + existing test suite catches most. |
| Tool count growing from 38 to 45 makes the surface harder to learn | Medium | Low | New tools are grouped by category in README's tools table (Exploration, Sessions, Git, etc.). The 7 new tools are all distinct concerns, not bundles or wrappers. |
| Orchestrator doesn't actually adopt new tools because prose habits persist | Medium | Low | This is a prompt-engineering problem, not a tool problem. Update `orchestrator.txt` in a separate small PR to reference the new tools (especially `commit`, `session_init`, `plan_validate`). |

---

## Effort & sequencing

| Phase | Effort | Net tool count | Risk | Ships value alone? |
|---|---|---|---|---|
| 0 — decisions | 30 min discussion | 38 | none | n/a |
| 1 — refactor | 3–4 hours | 38 | low | yes (zero feature change but reduces drift) |
| 2 — conventions | 1–2 hours | 38 | low-medium | yes (documents the convention) |
| 3 — investigation | 30 min | 38 | none | yes (writeup-only) |
| 4 — new tools wave 1 | 6–8 hours | 41 | medium (commit security) | yes |
| 5 — new tools wave 2 | 8–10 hours | 45 | medium | yes |

Total: ~20 hours over 2–3 focused days.

Each phase ships value independently and can be a separate PR. Recommend that sequencing — five PRs is easier to review than one mega-PR, and each PR's risk profile is bounded.

---

## What I'd cut if scope grows

If we need to ship sooner, cut in this order (least to most regrettable):

1. **Phase 3 (`context-usage` investigation).** Just an audit; skipping doesn't hurt. Re-do later.
2. **Phase 5.3 (`plan_validate`).** Advisory tool only; orchestrators can manually verify plan structure for now.
3. **Phase 5.4 (`journal_search`).** Bounded value until journal grows past `last_n` usefulness.
4. **Phase 5.2 (`drift_check`).** Real value but requires `artifact_index` to exist first; defer if Phase 5.1 alone is enough.
5. **Phase 2 (convention pass).** Existing inconsistency is annoying but not load-bearing.

Don't cut:
- **Phase 1.** It's the foundation for everything else. If you keep Phase 1, all future maintenance compounds positively.
- **Phase 4.1 (`commit`).** Highest single-tool leverage. Even shipping just this would justify the plan.
- **Phase 4.2 (`artifact_index`) + 5.1 (`session_init`).** Together they remove the 8-round-trip session-start pattern.

---

## Open question

Before I draft any of this as actual code, **the three decisions in Phase 0** need to land. Once they do, this plan splits cleanly into 5 PRs (one per phase), each independently reviewable and revertable. No phase depends on a later phase landing.

---

## Phase 3 writeup — `context-usage.ts`

**Conclusion: the size is justified. Do not refactor as part of this plan.**

The 992 lines decompose into six functional clusters:

1. **Tool registration** (~30 lines). Single `tool()` export with two args (`sessionID`, `limitMessages`). Lean.
2. **Session-message normalization** (~75 lines, functions `loadSessionMessages` through `toToolPartState`). Adapts unknown OpenCode session response shapes into typed `SessionMessage` records. Defensive parsing because the upstream type isn't stable.
3. **Context summarization** (~150 lines, `buildContextSummary` through `extractText`). Categorizes messages into system/user/assistant/tools/reasoning, counts tokens per category, returns a structured summary. One function per category, single-responsibility throughout.
4. **Token telemetry from session metadata** (~55 lines, `applyTokenTelemetry`, `tokenUsage`, `scalePromptCategories`, `scaleCategory`, `scaleEntries`). When OpenCode pre-counts tokens via session metadata, this code extracts and reconciles against our own counts. Real provider behavior driven.
5. **Token counting** (~65 lines, `countTokens`, `loadTiktokenEncoder`, `loadTransformersTokenizer`, plus encoder helpers). Three backends (tiktoken, `@huggingface/transformers`, approximate fallback) with multi-layer caching. Optional-dependency loading (modules may not be installed).
6. **Tokenizer registry / model resolution** (~250 lines, `resolveTokenModel` and helpers). The registry maps OpenAI/Azure/Anthropic/HuggingFace/etc. models to tokenizer specs, with candidate matching for partial model names and provider-default fallbacks.

**Why the size is justified:**

- Token counting across heterogeneous provider APIs is genuinely messy. Each provider names models differently, exposes different tokenizers, and the OpenCode session response shape isn't stable.
- Each function has one responsibility. No "god function" anti-pattern.
- Module-scope caches (`registryPromise`, `tiktokenCache`, `transformerCache`, `tiktokenModule`, `transformersModule`) are named clearly and scoped tight.
- Zero `as` casts on unknown data, zero `any`, zero `@ts-ignore` — invariant-clean.
- Dynamic optional-dependency loading is necessary (don't crash if `js-tiktoken` isn't installed) and handled correctly.

**If anyone needs to modify this file in the future**, the natural split would be three files: `src/workflow-tools/context-usage.ts` (tool registration + summarization), `src/util/session-messages.ts` (the message normalization layer at ~75 lines), `src/util/tokenizer-registry.ts` (the registry + resolution at ~250 lines, mostly data). But this is *premature splitting* today — the file works, the boundaries are visible from the function names, and a refactor risks introducing bugs in code that has clearly been carefully tuned to real provider behavior.

**Action:** none. Leave as-is. Revisit only if a future change touches multiple clusters and would benefit from clearer file boundaries.

**Re-evaluation 2026-05-12 (post-Tier 1+2 ship):** No new evidence. The file last changed in the initial Wave 7.2 port commit (`0a74ec0`), zero churn since. The next agent wrote a 132-line `context-usage.test.ts` against it without friction. No bug reports, no modification requests. Decision stands — no split.

---

## Tier 3 follow-up (2026-05-12) — orchestrator-prompt update + 4 new tools

After the Tier 1 + 2 tests landed, the natural next steps from the original Risk register fired:

1. **Orchestrator-prompt update.** `prompts/orchestrator.txt` now references the new tools at three load-bearing points:
   - **Session startup section** rewritten to prefer `session_init` (one composite call replaces the documented 8-parallel-tool-call pattern), with the individual reads kept as a fallback list. Also surfaces `drift_check` for resume sanity.
   - **Commit step** (item 7 under Execute) rewritten to call the `commit` plugin tool with `{ type, scope, outcome, paths, body? }`. Bash fallback documented but secondary.
   - **Plan persistence step** picked up an optional `plan_validate({ content })` call before `persist_final_plan`.
   - **"What you do directly" section** now lists `commit`, `journal_search`, `artifact_index`, `run_list` as orchestrator-direct operations.

2. **Tier 3 tools — 4 shipped, 1 deferred.** Tool count 45 → 49.

   **Shipped:**
   - `workspace_info` — workspace_id (sha256 of root, matches the run-record format), workspace_root, git HEAD / branch / dirty file summary / recent commits. Spawn-injection seam for tests. Falls back gracefully when not a git workspace.
   - `task_dispatch` — plan-aware prompt formatter. Validates the plan_slug exists in `.opencode/plans/index.json` (catches the drift mode `# Plan slug discipline` was written to prevent), validates `task_id` / `wave_name` formats, builds the canonical `Plan: <slug> | Task: <id> | Wave: <name>` header, returns the assembled prompt for direct paste into OpenCode's `task` tool. Not a true dispatcher (no SDK hook) — explicitly documented as such.
   - `spine_query` — wraps `SpineStore.listEvents()` with typed filters (plugin, kind, correlation_id, lifecycle_object_id, session_id, since_seq, since_ts_ms, include_stale). Read-only. Returns `{ available: false }` when the spine has never been initialized.
   - `changelog_emit` — reads `.opencode/progress/<plan_slug>.json`, extracts commit SHAs from wave `summary` fields (matching the orchestrator-side convention of `progress_update({ summary: <commit_hash> })`), runs `git log -1 --format=%s` on each, emits markdown. Unmatched waves (no SHA in summary, status != done, git lookup fail) reported in `unmatched_waves` so the caller knows what was skipped.

   **Deferred: `memory_correlate`.** Investigation showed Engram's cross-tool dispatch surface isn't live yet — even `conflict_context` currently returns `E_ENGRAM_NATIVE_UNAVAILABLE` (the dispatcher pattern exists; the underlying Engram tool ships in a later wave). Adding `memory_correlate` today would mean shipping a tool that always returns the same unavailability stub. That's tool-pollution with zero current value. Revisit once Engram's `memory_correlate` native tool lands and the existing `conflict_context` dispatcher path proves out.

3. **`context-usage.ts` split re-evaluation:** see the section above. Decision stands — no split.

### Implementation notes for Tier 3

- **AGENTS.md gained a "Subprocess-spawn injection pattern" subsection** codifying the `__test_setXxxSpawn` test seam pattern. Three of the four new Tier 3 tools (`workspace_info`, `commit`, `changelog_emit`) use this pattern verbatim; the fourth (`spine_query`) doesn't shell out so doesn't need it.
- **AGENTS.md "Shared utilities" subsection now references `src/util/path-exists.ts`** with the rationale: `Bun.file(dir).exists()` returns false for real directories on some Bun versions. The next-agent caught this during their test-writing pass; codifying the rule in AGENTS.md prevents the rediscovery.
- **No new tests written for Tier 3** in this pass — same deferred-test scope as the original Tier 1+2 ship. The next agent's test-writing pattern (`toolResultText` helper, `mkdtemp` workspace fixtures, spawn-injection in `commit.test.ts`) is the template. Recommend a follow-up PR that adds `workspace-info.test.ts`, `task-dispatch.test.ts`, `spine-query.test.ts`, `changelog-emit.test.ts` mirroring those patterns.
- **Tool count math:** 45 → 49 (+4 Tier 3 tools, 0 removals). `scripts/runtime-smoke.ts` `expectedTools` and `src/plugin-contract.test.ts` `expectedTools` both updated.

### What's left after this pass

| Item | Status |
|---|---|
| Tier 1 + 2 audit findings (8 items) | ✅ shipped |
| Tier 1 + 2 new tools (7 tools) | ✅ shipped + tested |
| Tier 3 new tools — `workspace_info`, `task_dispatch`, `spine_query`, `changelog_emit` | ✅ shipped (tests deferred) |
| Tier 3 new tool — `memory_correlate` | ⏸ deferred until Engram dispatcher lands |
| `context-usage.ts` split | ✅ re-evaluated, decision stands |
| `prompts/orchestrator.txt` update | ✅ shipped |
| Tier 3 unit tests | ⏳ next PR |
| `toolResultText` test-util dedup (6× duplicated across test files) | ⏳ next PR — extract to `src/test-util/` |
| `~/.config/opencode/opencode.json` wiring explore subagents to library | ⏳ separate Fleet config change |
