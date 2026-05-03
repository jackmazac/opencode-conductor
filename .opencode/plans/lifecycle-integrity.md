---
slug: lifecycle-integrity
title: OpenCode Lifecycle Integrity Plan
status: final
created: 2026-05-02
compiled_from:
  - Planner A: seal public API contracts
  - Planner B: portage DB migration safety
  - Planner C: torch feature flag awareness
  - Planner D: origin generated-code guard
  - Planner E: lifecycle vertical synthesis
  - Prior OpenCode control-plane roadmap: event spine, veil/ledger, tide, guard, loupe
---

# OpenCode Lifecycle Integrity Plan

## Executive decision

Build a **Lifecycle Integrity** vertical for OpenCode: a local, deterministic safety layer that prevents agents from silently breaking lifecycle boundaries in a codebase.

Product promise:

> Every code lifecycle boundary has an owner, source of truth, snapshot, and safe-change protocol.

Do **not** market four separate new products initially. Ship one lifecycle vertical with strict internal modules:

- `origin` — generated code/source-of-truth protection
- `seal` — public API contract snapshots and breaking-change gates
- `portage` — migration safety and schema-change ledger
- `torch` — feature flag inventory and retirement safety, deferred/experimental

Initial packaging should be one installable plugin package, tentatively `opencode-lifecycle`, with module-level bridge contracts and rule packs. Split `portage` or `torch` later only if their ecosystem-specific surface becomes independently large enough.

This is **not** a generic linter. Each module targets a specific decay vector with vendor-native sources, deterministic classification, structured artifacts, and event-spine receipts.

## Relationship to prior control-plane roadmap

The Lifecycle Integrity vertical depends on the prior fleet architecture:

1. **Required prerequisite**: minimal repo-scoped event spine/control-plane SQLite with session/correlation/actor/workspace identity, DB-assigned `seq`, `epoch_id`, `snapshot_id`, event hash chain, plugin checkpoints, and freshness-aware reads.
2. **Strong dependency**: deterministic `ledger` receipts for verifying that required notes/artifacts/checks exist.
3. **Useful dependency**: `tide` rollback epochs for clearing stale lifecycle blocks after restored code state.
4. **Useful dependency**: Engram artifact ingest for authoritative lifecycle snapshots.
5. **Useful dependency**: codemem symbol graph/API surface hooks for `seal` and generated/source mapping hints for `origin`.
6. **External coordination integration**: Concord owns live working-tree edit/range coordination. Lifecycle modules may reference Concord collision events as external evidence, but must not reimplement locks, reservation expiry, stale-read tracking, or conflict guidance.

New Concord boundary decision:

- Concord answers: "Can this agent safely edit this file/range right now?"
- Lifecycle Integrity answers: "Is this code object safe to change according to its lifecycle owner/source-of-truth protocol?"
- Conductor/lifecycle may export lifecycle correlation IDs, decision IDs, and object IDs into Concord metadata when Concord exposes a stable field for them.
- Conductor/lifecycle may ingest Concord `collision_events` and `<concord_conflict>` guidance as artifacts/evidence.
- Conductor/lifecycle must preserve Concord guidance verbatim when presenting a lock conflict; do not reinterpret or overwrite Concord's blame-free conflict messages.

Recommended revised roadmap placement:

```txt
Prior Phase 0: event spine/contracts
→ Lifecycle Wave 1: lifecycle foundation
→ Lifecycle Wave 2: origin generated-code guard
→ Prior Phase 1: veil + ledger safety core
→ Lifecycle Wave 3: seal public API contracts
→ Prior Phase 2: tide recovery
→ Prior Phase 3: guard governance
→ Prior Phase 4: loupe observability
→ Lifecycle Wave 4: portage migration safety
→ Lifecycle Wave 5: torch experimental flag rule pack
```

`origin` can land before `veil`/`ledger` because it is preventive and crisp. `seal` should wait for ledger receipts if it is going to block breaking changes. `portage` should wait for ledger and preferably tide because migration gates need durable evidence and rollback/backfill artifacts. `torch` should wait until observability/provider truth is available.

## Disposition table

| Idea | Decision | Rank | Rationale |
|---|---:|---:|---|
| `origin` | **Build first** as lifecycle foundation module | 1 | Crisp, deterministic, high-value. Protects generated files and establishes generated → source → command mapping that codemem/seal/portage/tracer can consume. |
| `seal` | **Build early** as public contract module | 2 | Strong product value. Converts codemem drift into versioned contract artifacts, structured diffs, migration notes, and consumer impact. |
| `portage` | **Build after ledger/seal foundations** | 3 | High risk/high value, but parser scope and migration policy vary by stack. Start narrow and deterministic. |
| `torch` | **Defer** as experimental optional rule pack | 4 | Valuable, but provider fragmentation and stale external truth make hard blocking risky. Start registry/static-only later. |

## Shared architecture

### Package shape

```txt
plugins/
  lifecycle/
    modules/
      origin/
      seal/
      portage/
      torch/       # experimental/later
    contracts/
    rules/
    cli/
    evals/

packages/
  bridge-contracts/
  lifecycle-contracts/
  conformance/
  eval-fixtures/
```

### Core primitives

1. **Code object identity**
   - Stable identity for generated outputs, source schemas/IDLs, public API entries, migrations, DB objects, and flag references.
   - Derived from vendor-native source identity: package exports, OpenAPI operation IDs, GraphQL field paths, proto tags, migration IDs, flag keys.
   - No fuzzy semantic matching in v1.

2. **Artifact snapshots**
   - Structured JSON artifacts for API surfaces, generated source maps, schema snapshots, migration findings, and flag inventories.
   - Stored as content-addressed payloads referenced from event spine events.
   - Large payloads are artifacts; event rows carry hashes and refs only.

3. **Lifecycle rule result**

```ts
type LifecycleDecision = {
  decision_id: string
  module: "origin" | "seal" | "portage" | "torch"
  severity: "allow" | "warn" | "block"
  reason_code: string
  object_id: string
  evidence_refs: string[]
  remediation: {
    summary: string
    required_artifacts?: string[]
    source_paths?: string[]
    commands?: string[]
  }
  freshness: {
    epoch_id: number
    as_of_seq: number
    status: "fresh" | "stale" | "recomputing" | "unavailable"
  }
}
```

4. **Structured agent message contract**
   - Factual, actionable, blame-free, bounded.
   - Always includes violated rule, affected object, canonical source, and remediation.
   - Never includes secrets or huge raw outputs.

5. **Freshness-aware event-spine reads**
   - Default: current epoch, fresh only.
   - Historical/stale reads require explicit opt-in.
   - After tide rollback, lifecycle decisions from reverted epochs become stale and no longer block current work.

6. **External coordination evidence**
   - Concord lock reservations are operational state, not lifecycle artifacts.
   - Concord collision events and conflict guidance may be stored as evidence refs.
   - Concord protocol/schema versions must be carried on any imported collision artifact.

## Critical path

```txt
Wave 0: Event spine/contracts prerequisite
  → Wave 1: Lifecycle foundation
    → Wave 2: origin prevents generated-file edits
      → Wave 3: seal makes public API changes explicit
        → Wave 4: portage gates destructive migrations
          → Wave 5: torch advisory/experimental feature-flag safety
            → Wave 6: lifecycle conformance, docs, and public demo
```

Total lifecycle tasks: **32** across **6 lifecycle waves**, plus the external event-spine prerequisite.

---

## Wave 0: Event spine prerequisite — plugins share truth before lifecycle gates block work

**Thesis**: Lifecycle gates are dangerous if each module invents its own event identity, rollback model, and freshness semantics. This wave is inherited from the prior control-plane roadmap and must exist before blocking lifecycle decisions are trusted.

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W0-T1 | Define event envelope, identity fallback, epoch/freshness model | `packages/bridge-contracts`, `packages/spine` | planner/high | L |
| W0-T2 | Implement repo-scoped SQLite event log with DB-assigned `seq` | `packages/spine` | executor-high | L |
| W0-T3 | Define plugin checkpoint and stale-row query semantics | `packages/spine`, docs | executor-medium | M |
| W0-T4 | Define structured agent message contract shared with conflict plugin | `packages/bridge-contracts/messages` | executor-medium | M |

**Definition of Done**:

- Plugins can emit events with session/correlation/actor/workspace/epoch identity.
- Event `seq` is assigned only by SQLite.
- Default queries are fresh/current epoch.
- Rollback invalidation has exact semantics.
- Message contract is used by conflict plugin, origin, seal, portage, and torch.

**Blast radius**: shared control-plane contracts. Rollback by pinning contract version and disabling lifecycle modules.

**Dependencies**: prior control-plane Phase 0.

---

## Wave 1: Lifecycle foundation — modules share object identity, artifacts, and rule results

**Thesis**: `origin`, `seal`, `portage`, and `torch` should not create parallel type worlds. This wave builds the single lifecycle contract layer: object IDs, snapshot refs, decision results, config schema, and eval harness.

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W1-T1 | Define lifecycle config schema and module registry | `plugins/lifecycle/contracts/config.ts`, `.opencode/lifecycle.yml` schema | executor-medium | M |
| W1-T2 | Define canonical `LifecycleObjectId` and source-kind identities | `packages/lifecycle-contracts/object-id.ts` | executor-high | L |
| W1-T3 | Define artifact snapshot and content-addressed ref schema | `packages/lifecycle-contracts/artifacts.ts` | executor-medium | M |
| W1-T4 | Define `LifecycleDecision` and message rendering helpers | `packages/lifecycle-contracts/decisions.ts`, `messages.ts` | executor-medium | M |
| W1-T5 | Build conformance fixtures for allow/warn/block and freshness behavior | `packages/conformance/lifecycle` | executor-medium | M |
| W1-T6 | Document vendor-native source-of-truth rule | `docs/lifecycle/source-of-truth.md` | scribe | S |
| W1-T7 | Define external coordination refs for Concord collisions and guidance passthrough | `packages/lifecycle-contracts/external-sources.ts`, `docs/lifecycle/concord.md` | executor-medium | M |

**Definition of Done**:

- One canonical decision/result type used by every module.
- One object ID model, with source-kind-specific identity rules.
- One artifact reference schema.
- Conformance fixtures prove no module can return stale current truth by default.
- Docs state: use vendor-native sources; do not invent parallel contracts.
- Concord collision events are modeled as external evidence, not lifecycle decisions or lock state.

**Blast radius**: lifecycle modules only. Rollback by freezing lifecycle contract v0.

**Dependencies**: Wave 0.

---

## Wave 2: `origin` — generated files redirect agents to the true source

**Thesis**: The first lifecycle win should be crisp: agents stop editing generated output and instead edit the schema/IDL/config that owns it.

**V1 scope**:

- Prisma generator outputs
- GraphQL Code Generator outputs
- Buf/protobuf outputs
- Config-driven OpenAPI/Orval/Hey API/openapi-generator outputs
- Explicit `.opencode/origin.yml` declarations

**Non-goals**:

- Arbitrary templates
- Heuristic-only hard blocks
- Auto-regeneration by default
- Vendored SDKs without local source/config

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W2-T1 | Implement generated → source → command source-map schema | `plugins/lifecycle/modules/origin/contracts.ts` | executor-medium | M |
| W2-T2 | Implement deterministic scanner framework and confidence model | `modules/origin/scanner` | executor-high | L |
| W2-T3 | Add Prisma and GraphQL Codegen detection packs | `modules/origin/packs/prisma.ts`, `graphql-codegen.ts` | executor-medium | M |
| W2-T4 | Add Buf/protobuf and high-confidence OpenAPI packs | `modules/origin/packs/buf.ts`, `openapi.ts` | executor-high | L |
| W2-T5 | Add `tool.execute.before` edit/write gate | `modules/origin/hooks/before.ts` | executor-medium | M |
| W2-T6 | Add bash literal-path preflight and post-execute mutation detection | `modules/origin/hooks/bash.ts` | executor-high | L |
| W2-T7 | Add CLI: `origin scan`, `origin explain`, `origin map`, `origin regen --dry-run` | `modules/origin/cli` | executor-medium | M |
| W2-T8 | Add codemem/tracer/ledger/tide/loupe bridge payloads | `modules/origin/integrations` | executor-medium | M |
| W2-T9 | Add eval fixtures for supported codegen systems and overrides | `modules/origin/evals` | executor-medium | M |

**Block policy**:

- Block direct edits to high-confidence generated files with known source and regenerate command.
- Warn on likely-generated files without authoritative source map.
- Allow declared hand-patched overrides with owner, reason, and expiry.

**Agent message example**:

```txt
Blocked: src/generated/api/client.ts is generated by openapi-generator.

Source: specs/openapi.yaml
Regenerate with: bun run generate:api

Edit the source schema/IDL instead of this generated file. Changes here will be overwritten on next generation.
```

**Definition of Done**:

- High-confidence generated-file edits are blocked before mutation.
- Every block names source path and regeneration command.
- Heuristic-only generated paths warn, not block.
- codemem can consume the generated-file map and skip indexing generated outputs.
- `origin regen --dry-run` is available; `--execute` remains explicit and guarded.

**Blast radius**: file-write hooks and generated-file paths. Rollback by disabling `origin.block` while leaving scanner in warn mode.

**Dependencies**: Waves 0–1. Tide optional for rollback suggestion. Ledger optional for receipts.

---

## Wave 3: `seal` — public API changes become versioned contract artifacts

**Thesis**: codemem can detect API drift, but `seal` turns public surface into a first-class deliverable: snapshot, structured diff, consumer impact, and migration-note policy.

**V1 scope**:

- TypeScript/package public exports via `package.json` `exports`, `types`, `.d.ts`, and codemem symbol IDs where available
- OpenAPI 3.0/3.1 JSON/YAML with explicit config path
- GraphQL SDL/introspection JSON if canonical files already exist
- Proto files via `buf`/descriptor output where available

**Defer**:

- Runtime route introspection
- tRPC unless it emits canonical OpenAPI/JSON Schema
- JSDoc-only APIs
- LLM semantic compatibility analysis
- Automatic version bumping

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W3-T1 | Define `seal` package config, snapshot schema, and diff schema | `modules/seal/contracts` | executor-medium | M |
| W3-T2 | Implement TypeScript exports adapter using declarations/codemem IDs | `modules/seal/adapters/ts` | executor-high | L |
| W3-T3 | Implement OpenAPI adapter with canonicalization | `modules/seal/adapters/openapi` | executor-high | L |
| W3-T4 | Add GraphQL/proto adapters only if canonical fixture sources exist | `modules/seal/adapters/graphql`, `proto` | executor-medium | M |
| W3-T5 | Implement deterministic diff engine: Added/Changed/Removed/Deprecated | `modules/seal/diff` | executor-high | L |
| W3-T6 | Implement breaking-change policy and migration-note requirement | `modules/seal/policy`, `modules/seal/migrations` | executor-high | L |
| W3-T7 | Bind migration notes to ledger receipts by diff hash | `modules/seal/integrations/ledger.ts` | executor-medium | M |
| W3-T8 | Emit Engram artifacts and tide freshness events | `modules/seal/integrations/engram.ts`, `tide.ts` | executor-medium | M |
| W3-T9 | Add CLI: `seal snapshot`, `seal diff`, `seal check`, `seal note validate` | `modules/seal/cli` | executor-medium | M |
| W3-T10 | Add eval fixtures for TS, OpenAPI, optional GraphQL/proto, rollback stale-clearing | `modules/seal/evals` | executor-medium | M |

**Block policy**:

- Block breaking diff when migration note is missing.
- Block stale migration note whose hash does not match current diff.
- Block disappearance of a configured public source without explicit override.
- Warn on additive changes, deprecations, first baselines, and review-required unknown diffs.

**Required migration note shape**:

```json
{
  "schema_version": 1,
  "package_id": "workspace:@acme/sdk",
  "from_snapshot_id": "sha256:old",
  "to_snapshot_id": "sha256:new",
  "breaking_change_ids": ["sha256:change"],
  "summary": "createClient now requires an options object.",
  "consumer_actions": [
    { "consumer": "*", "action": "Replace createClient(url) with createClient({ url })." }
  ],
  "versioning": { "recommended_bump": "major", "declared_bump": "major" },
  "correlation_id": "..."
}
```

**Definition of Done**:

- `seal snapshot` is deterministic and content-addressed.
- `seal diff` emits structured Added/Changed/Removed/Deprecated changes.
- Breaking changes are detected without LLM classification.
- Missing/stale migration notes block.
- Ledger verifies note presence/hash, not prose quality.
- Engram ingests snapshots/diffs as authoritative artifacts.
- Tide rollback marks reverted diffs stale and clears current blockers.

**Blast radius**: public API source files and package contract artifacts. Rollback by setting `seal.mode = warn` per package.

**Dependencies**: Waves 0–1, codemem bridge. Ledger for blocking. Origin recommended so generated clients are not treated as source truth.

---

## Wave 4: `portage` — destructive migrations require recovery artifacts

**Thesis**: DB migrations are stateful and often irreversible. They need a domain-specific gate that verifies deterministic evidence: classification, rollback/backfill artifacts, schema snapshots, and append-only migration records.

**V1 scope**:

- Prisma Migrate: `prisma/migrations/*/migration.sql`, `schema.prisma`
- Drizzle: `drizzle/*.sql`, `drizzle/meta/_journal.json`, metadata snapshots
- Configured raw SQL, Postgres-first

**Defer**:

- Alembic/Rails/Liquibase/Flyway hard blocking
- Live production DB calls
- Running migrations
- Proving data safety
- Full deployment orchestration

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W4-T1 | Define `MigrationFinding` and artifact contracts | `modules/portage/contracts.ts` | executor-medium | M |
| W4-T2 | Detect Prisma/Drizzle/configured raw SQL migration files | `modules/portage/detectors` | executor-medium | M |
| W4-T3 | Implement Postgres DDL parser/classifier for destructive operations | `modules/portage/parsers/postgres.ts`, `classifier.ts` | executor-high | L |
| W4-T4 | Implement rollback/backfill artifact validation and hash binding | `modules/portage/artifacts` | executor-high | L |
| W4-T5 | Implement SQLite state and append-only migration event ledger | `modules/portage/db`, `ledger` | executor-high | L |
| W4-T6 | Build structural schema snapshots/diffs for Prisma/Drizzle/raw SQL | `modules/portage/snapshots`, `diff` | executor-high | L/XL |
| W4-T7 | Add hook gates: after-edit scan, pre-command block, pre-commit check | `modules/portage/hooks` | executor-high | L |
| W4-T8 | Integrate with origin, seal, tide, and ledger | `modules/portage/integrations` | executor-medium | M |
| W4-T9 | Add CLI: `portage scan`, `check --staged`, `artifacts init`, `ledger record/list/verify` | `modules/portage/cli` | executor-medium | M |
| W4-T10 | Add eval fixtures for Prisma, Drizzle, raw SQL, destructive ops, unknown SQL | `modules/portage/evals` | executor-medium | M |

**Destructive v1 operations**:

- `DROP TABLE`
- `DROP COLUMN`
- `RENAME COLUMN`
- `RENAME TABLE`
- `ALTER COLUMN TYPE`
- destructive enum/type rewrites where detected
- `TRUNCATE`
- raw `DELETE`/`UPDATE` in migration without explicit configured allowance

**Block policy**:

- Hard-block deterministic destructive findings without required artifacts.
- Hard-block migration execution commands with stale/unresolved findings.
- Hard-block editing migrations recorded as applied in non-local env unless policy override exists.
- Warn on unsupported systems and unknown-confidence SQL unless org policy says block unknown.

**Artifact conventions**:

```txt
prisma/migrations/<migration-id>/
  migration.sql
  rollback.sql
  backfill.md
  portage.json
```

`portage.json` binds sidecars to the forward migration hash.

**Definition of Done**:

- Prisma/Drizzle/raw SQL migrations are detected.
- Core destructive DDL is classified with confidence levels.
- Missing rollback/backfill artifacts block deterministic destructive migrations.
- Unsupported systems warn honestly instead of pretending safety.
- Append-only ledger records migration identities and evidence refs.
- Structural diffs clearly state they are not proof of runtime safety.
- Origin blocks generated ORM client edits; portage treats generated clients as derived evidence only.

**Blast radius**: migration directories, schema files, generated ORM staleness checks, pre-command gates. Rollback by `portage.mode = warn` or disabling hard-block for raw SQL unknowns.

**Dependencies**: Waves 0–1, ledger, preferably seal, origin, and tide.

---

## Wave 5: `torch` — feature flag awareness starts as advisory, not absolute truth

**Thesis**: Feature flags decay, but truth often lives outside the repo. `torch` should not hard-block from stale or unknown provider data. Start with static/registry truth and optional read-only provider sync.

**V1 scope**:

- Generic configured matchers
- JS/TS LaunchDarkly static preset
- Internal flag registry file, e.g. `.torch/flags.yaml`
- Optional read-only LaunchDarkly sync
- Experimental static presets for Statsig/Unleash

**Defer**:

- Writes to flag providers
- Universal provider abstraction
- Runtime traffic inference
- Automatic flag cleanup
- Hard blocks from stale provider data

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W5-T1 | Define flag status model and freshness semantics | `modules/torch/contracts.ts` | executor-medium | M |
| W5-T2 | Implement config-driven matcher engine and LaunchDarkly JS/TS preset | `modules/torch/matchers` | executor-high | L |
| W5-T3 | Implement SQLite-backed flag/reference index and `.torch/flags.yaml` registry | `modules/torch/db`, `registry` | executor-high | L |
| W5-T4 | Implement diff gate for added/removed refs with refactor-safe same-patch moves | `modules/torch/gate` | executor-high | L |
| W5-T5 | Add structured comments/metadata for new flags | `modules/torch/annotations` | executor-medium | M |
| W5-T6 | Add optional LaunchDarkly read-only sync with freshness expiry | `modules/torch/providers/launchdarkly` | executor-high | L |
| W5-T7 | Emit ledger/Engram/seal/tide/loupe/guard bridge events | `modules/torch/integrations` | executor-medium | M |
| W5-T8 | Add CLI: `torch scan`, `status`, `diff`, `check`, `sync`, `explain` | `modules/torch/cli` | executor-medium | M |
| W5-T9 | Add eval fixtures for live removal, dead cleanup, unknown/stale provider data, dynamic keys | `modules/torch/evals` | executor-medium | M |

**Status model**:

- `live`: fresh authoritative evidence says active/rely-on-it.
- `defined`: exists but not proven live/dead/deprecated.
- `deprecated`: planned removal.
- `dead`: should no longer be used.
- `unknown`: static-only, stale, failed sync, conflicting sources, or dynamic key.

**Block policy**:

- Block removing production references to fresh `live` flags.
- Block adding new production flags without ticket/owner/intent/expiry.
- Block adding references to fresh `dead` flags.
- Warn on unknown/stale status by default.
- Allow refactors that preserve the same flag reference set.

**Definition of Done**:

- Static JS/TS flag refs are indexed from configured matchers.
- Registry-backed lifecycle status works without provider API.
- Stale provider data degrades to `unknown`.
- Live-removal hard block requires fresh authoritative evidence.
- Ledger receipts include config hash, diff hash, status evidence hash, and decision code.

**Blast radius**: flag provider config, production flag references, optional external read-only credentials. Rollback by running `torch` in warn-only mode.

**Dependencies**: Waves 0–1, ledger, loupe/observability preferred. Torch should not block by default until eval precision is proven.

---

## Wave 6: Conformance, docs, and north-star demo — lifecycle gates become understandable and reusable

**Thesis**: Lifecycle modules will be ignored if they feel like opaque blockers. This wave proves deterministic behavior with fixtures, documents guarantees/non-goals, and builds a demo that ties modules together.

**Tasks**:

| ID | Task | Files / packages | Executor | Size |
|---|---|---|---:|---:|
| W6-T1 | Build lifecycle conformance test runner across origin/seal/portage/torch | `packages/conformance/lifecycle` | executor-medium | M |
| W6-T2 | Add golden eval suites and fixture repos | `plugins/lifecycle/evals`, `packages/eval-fixtures` | executor-medium | L |
| W6-T3 | Add `lifecycle doctor`, `lifecycle status`, `lifecycle check --changed`, `lifecycle report` | `plugins/lifecycle/cli` | executor-medium | M |
| W6-T4 | Write docs: guarantees, non-goals, override policy, source-of-truth setup | `docs/lifecycle` | scribe | M |
| W6-T5 | Build north-star demo scenario | `examples/lifecycle-demo` | executor-medium | M |
| W6-T6 | Add loupe timeline integration for lifecycle decisions | `plugins/lifecycle/integrations/loupe` | executor-medium | M |

**North-star demo**:

1. Agent edits a generated OpenAPI client.
   - `origin` blocks and redirects to `specs/openapi.yaml` + `bun run generate:api`.
2. Agent changes the OpenAPI source and removes/changes a public route.
   - `seal` creates structured diff and requires a migration note.
3. Agent adds a destructive migration.
   - `portage` classifies `DROP COLUMN` and requires rollback/backfill artifacts.
4. Optional later: agent removes a live feature flag guarding the API.
   - `torch` blocks only with fresh registry/provider evidence.
5. `ledger` receipts and `loupe` timeline explain every block/warn.

**Definition of Done**:

- `lifecycle check --changed` runs all enabled modules deterministically.
- Golden fixtures cover true positives, false positives, stale epoch behavior, and override cases.
- Docs state what each module proves and does **not** prove.
- Demo shows generated-code protection, API-contract drift, migration safety, and receipt trace.

**Blast radius**: developer UX, CLI, docs, examples. Rollback by hiding demo/docs from release while keeping module checks internal.

**Dependencies**: Waves 1–5 as enabled.

---

## Execution summary

| Wave | Outcome | Effort | Parallelism | Gate |
|---|---|---:|---|---|
| 0 | Shared event truth exists | L/XL | parallel contracts + DB + messages | Event conformance passes |
| 1 | Lifecycle modules share contracts | L | mostly parallel after W1-T1 | Contract/eval fixtures pass |
| 2 | Generated-file edits are redirected | L/XL | scanner packs parallel after source-map contract | Origin evals pass; block messages include source+command |
| 3 | Public API drift is structured and gated | XL | adapters parallel; diff/policy after schema | Seal evals pass; ledger note receipts verified |
| 4 | Destructive migrations require recovery evidence | XL | detectors/parsers/artifacts parallel after contracts | Portage evals pass; no overclaiming live DB safety |
| 5 | Feature flag safety is advisory-to-gated | L/XL | matcher/index/provider parallel after status model | Torch evals pass; stale data never treated safe |
| 6 | Lifecycle vertical is documented and demoable | L | docs/evals/demo/CLI parallel | North-star demo passes |

## Commit strategy

One scoped commit per wave when implementing:

1. `feat(spine): add lifecycle-ready event contracts`
2. `feat(lifecycle): add shared lifecycle contracts`
3. `feat(origin): guard generated code edits`
4. `feat(seal): snapshot and gate public API changes`
5. `feat(portage): classify and gate destructive migrations`
6. `feat(torch): add feature flag lifecycle checks`
7. `docs(lifecycle): add conformance fixtures and demo`

## Validation defaults for future implementation

Before delegating implementation, read the owning `package.json` and use its scripts. Expected Bun/TypeScript defaults if present:

```bash
bun run typecheck
bun run lint:check || bun run lint
bun test
```

Lifecycle-specific checks to add once implemented:

```bash
lifecycle check --changed --json
origin scan --json
seal check --all --json
portage check --staged --json
torch check --changed --json
```

For broad TypeScript/API changes, run codemem evidence where available:

```bash
codemem check --json
codemem api-surface --json
codemem conflicts --json
```

## Open decisions

1. External name: **Lifecycle Integrity** vs **Contract Lifecycle** vs **Change Safety**. Recommendation: Lifecycle Integrity.
2. Package name: `opencode-lifecycle` vs separate `opencode-origin`, `opencode-seal`, etc. Recommendation: one package initially, module-level internal names.
3. First `seal` sources: Recommendation: TypeScript exports + OpenAPI first; GraphQL/proto only when canonical fixtures exist.
4. First `portage` ecosystem: Recommendation: Prisma + Drizzle + Postgres raw SQL. Alembic/Rails warn-only later.
5. Torch v1 requirement: Recommendation: registry/static matcher first; LaunchDarkly sync optional.
6. Artifact storage: Recommendation: control-plane SQLite metadata + content-addressed JSON artifacts; no parallel per-module truth.
7. Overrides: Recommendation: every allow override requires owner, reason, and expiry.

## Stop conditions

- If a module requires broad semantic LLM judgment to be useful, do not ship it as a blocking gate.
- If two modules create separate object IDs for the same lifecycle object, stop and fix the contract.
- If a module cannot name the vendor-native source of truth, it may warn but must not hard-block.
- If stale provider/snapshot data is the only evidence, warn or mark unknown; do not declare safe.
- If an implementation needs casts/adapters to reconcile parallel schemas, replan around a single canonical contract.
