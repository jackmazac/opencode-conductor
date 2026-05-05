---
name: opencode-plugin-architecture
description: Create, review, or refactor custom OpenCode plugins using this fleet's architecture: clean plugin boundaries, Host Adapter wrapping, shared contracts, nonblocking runtime hooks, low memory use, durable telemetry, modular building blocks, and fleet validation.
license: MIT
metadata:
  author: jackmazac
  version: "1.1.0"
---

# OpenCode Plugin Architecture

Use this skill when creating, reviewing, or refactoring an OpenCode plugin in this fleet. The target is boring, sharp architecture: explicit ownership, tiny runtime boundaries, low startup cost, bounded memory, durable telemetry, and shared primitives instead of bespoke glue.

## When To Use

Apply this skill when the user asks to:

- Create a new custom OpenCode plugin.
- Add a tool, hook, CLI, daemon, health check, or telemetry path to a plugin.
- Review plugin architecture for cleanliness, performance, or fleet compatibility.
- Split concerns between Conductor, Engram, Codemem, Concord, Host Adapter, Fleet, or a new plugin.
- Convert local scripts or ad hoc automation into a production-quality OpenCode plugin.

Do not use this skill for application product code unless that code is itself an OpenCode plugin or fleet support package.

## Fleet Doctrine

Build plugins around ownership, not convenience.

- Conductor owns doctrine, plans, runs, lifecycle artifacts, progress, audits, journals, handoffs, status mirrors, event spine, and context diagnostics.
- Engram owns local memory, memory search, bounded context bundles, feedback, stats, and lifecycle artifact ingestion.
- Codemem owns code graph truth, drift analysis, impact cones, API surface, review focus, and advisory code intelligence.
- Concord owns live edit coordination, stale-read detection, lock guidance, and collision events.
- Host Adapter owns plugin boundary safety, tool wrapping, validation, timeouts, correlation propagation, and telemetry emission.
- Fleet Contracts owns canonical IDs, FleetContext, telemetry envelopes, artifact refs, and health reports.
- OpenCode Fleet owns install/update, manifest generation, runtime contract checks, doctor, hygiene, and policy export.

Prefer correlation over coupling. A plugin should exchange canonical IDs, artifact refs, health reports, telemetry, and declarative files rather than shelling out to another plugin or importing another plugin's product internals.

## First Decision

Classify the thing before writing code.

- Runtime tool plugin: exposes one or more OpenCode tools and must be wrapped with wrapPlugin from @jackmazac/opencode-host-adapter.
- Hook-only plugin: intercepts OpenCode hooks and may expose no tools, like Concord.
- Library-only package: exports shared code and has no plugin_ref, like Host Adapter.
- CLI/control-plane package: manages config, validation, install, or reporting, like OpenCode Fleet.
- Sidecar daemon plugin: uses TypeScript for OpenCode integration and a daemon for long-lived indexing, lock state, heavy analysis, or low-latency shared state.

If the plugin's responsibility overlaps an existing fleet owner, stop and move the feature to the owning repo instead of creating a duplicate abstraction.

## Repo Shape

Prefer this structure for a TypeScript runtime plugin:

```text
<plugin-repo>/
  AGENTS.md
  README.md
  package.json
  src/
    index.ts
    runtime.ts
    health.ts
    tools.ts
    cli.ts
    telemetry.ts
    *.test.ts
  scripts/
    runtime-smoke.ts
  docs/
    architecture.md
```

Use packages only when there is a real boundary:

```text
packages/
  <plugin>-shared/      # wire types, parsers, constants
  <plugin>-daemon/      # Rust or other long-lived worker when justified
  <plugin>-contracts/   # product-specific contracts, not fleet primitives
```

Keep the package root small. Runtime plugin load should not eagerly initialize databases, scan worktrees, start daemons, or import large optional subsystems.

## Package Contract

Use @jackmazac/opencode-host-adapter and @jackmazac/opencode-fleet-contracts as first-class dependencies.

```json
{
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./cli": "./src/cli.ts"
  },
  "bin": {
    "my-plugin": "./src/cli.ts"
  },
  "dependencies": {
    "@jackmazac/opencode-fleet-contracts": "file:../opencode-fleet-contracts",
    "@jackmazac/opencode-host-adapter": "file:../opencode-host-adapter",
    "@opencode-ai/plugin": "1.14.31"
  },
  "scripts": {
    "typecheck": "tsgo --noEmit",
    "test": "bun test",
    "lint:no-zod": "bun run ./node_modules/@jackmazac/opencode-host-adapter/src/cli/check-no-zod-import.ts src/",
    "check": "bun run lint:no-zod && bun run typecheck && bun test",
    "doctor": "bun src/cli.ts doctor",
    "status": "bun src/cli.ts status",
    "smoke:runtime": "bun scripts/runtime-smoke.ts"
  }
}
```

Pin or coordinate dependency versions with the fleet. Do not casually bump Zod, OpenCode plugin SDK, or shared contract packages.

## Plugin Entry Point

The default export should be thin and wrapped.

```ts
import type { Plugin } from "@opencode-ai/plugin";
import { wrapPlugin } from "@jackmazac/opencode-host-adapter";
import { createMyPluginTools } from "./tools";

const MyPlugin: Plugin = async ({ project, client, app }) => {
  return {
    tool: createMyPluginTools({ project, client, app }),
  };
};

export default wrapPlugin(MyPlugin, { name: "my-plugin" });
```

Rules:

- Keep src/index.ts declarative.
- Do not perform work at import time.
- Do not start daemons, open databases, read large files, or scan the repo until a tool or hook needs it.
- Register a stable tool list and assert it in contract tests.
- Never rename public tools without a migration plan.

## Nonblocking Runtime Architecture

OpenCode hooks and prompt transforms are latency-critical. They may normalize inputs, derive small records, append to an in-memory queue, and return. They must not run scans, migrations over large state, long SQLite transactions, network calls, keychain subprocesses, large filesystem walks, or CPU-heavy scoring inline.

Use this runtime split:

```text
OpenCode hook/tool boundary
  -> validate and normalize
  -> enqueue bounded work or run bounded read
  -> return structured result/status

Writer loop / explicit CLI job / daemon
  -> batches work
  -> owns durable cursors
  -> records progress and health
```

Rules:

- Default plugin startup must not schedule heavy work behind timers. A 30s or 60s delay still blocks the live plugin later.
- Automatic hot database backfill, repo indexing, large artifact ingest, and broad analysis must be opt-in or CLI/daemon isolated.
- Queue overflow must use bounded drop/backpressure behavior with visible counters; never flush SQLite synchronously from a hook to make room.
- Writer loops should use small batches, short transactions, and one writer per sidecar.
- Runtime maps and buffers need limits, TTLs, or lifecycle pruning.
- Hook tests should prove construction and common hook calls do not trigger hot DB scans or inline writes.

## Tool Design

Each tool should be small, bounded, and explicit.

- Use OpenCode tool.schema helpers for inputs.
- Avoid direct Zod imports in plugin src/ unless the repo explicitly owns validation libraries and the lint policy allows it.
- Inputs should include optional fleet correlation fields when the result needs to join across plugins: workspace_id, plan_id, plan_slug, wave_id, agent_run_id, correlation_id, tool_call_id, artifact_ref, lifecycle_object_id, concord_event_id, fleet_run_id.
- Outputs should be structured JSON, not prose.
- Always include limits: maxResults, maxFindings, depth, budget_chars, timeout_ms, or equivalent.
- Prefer advisory outputs over blocking behavior unless the plugin's explicit purpose is to block unsafe operations.
- Return typed error payloads with stable code values.
- Do not leak raw prompts, secrets, full file contents, or unbounded logs.

Good tool shape:

```ts
my_plugin_check: tool({
  description: "Run a bounded advisory check and return structured findings.",
  args: {
    paths: tool.schema.array(tool.schema.string()).optional(),
    maxFindings: tool.schema.number().optional(),
    correlation_id: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const runtime = await getRuntime(context);
    return runtime.check({
      paths: args.paths ?? [],
      maxFindings: Math.min(args.maxFindings ?? 50, 200),
      correlation: extractFleetContext(context),
    });
  },
})
```

## Modular Building Blocks

Keep code split by responsibility, not by arbitrary layers.

- runtime.ts: lazy runtime construction, path resolution, shared resources, and dependency injection.
- tools.ts: OpenCode tool declarations and argument normalization only.
- health.ts: health checks and canonical HealthReport construction.
- cli.ts: thin command router over runtime and health modules.
- telemetry.ts: product-specific metric helpers if Host Adapter telemetry is not enough.
- protocol.ts: daemon wire contracts when a sidecar exists.
- store.ts: local persistence and migrations.
- *.test.ts: unit tests near the behavior they cover.

Do not create framework abstractions before the second real use. Prefer one clear function over a generic registry when the tool count is small.

## Shared Infrastructure

Use fleet primitives instead of inventing new shapes.

- Branded IDs and parsers come from @jackmazac/opencode-fleet-contracts.
- FleetContext is the standard correlation carrier.
- FleetTelemetryEnvelope is the standard telemetry envelope.
- ArtifactRef is the standard durable artifact pointer.
- HealthReport is the standard doctor/status shape.
- wrapPlugin and extractFleetContext come from Host Adapter.
- Runtime validation belongs in OpenCode Fleet, not each plugin.

Do not redefine these types locally. Extend plugin-specific payloads around them.

## Telemetry

Telemetry must be useful, cheap, and non-fatal.

- Wrap the plugin with Host Adapter so every tool call gets a tool_call_id, correlation_id, duration, status, and canonical telemetry envelope.
- Propagate incoming fleet context to every daemon request, store row, artifact, and result where correlation matters.
- Use low-cardinality event names and stable error codes.
- Redact secrets, prompts, payload bodies, and credentials before writing telemetry.
- Telemetry write failures must not fail user actions.
- Health and CLI reports should use makeHealthReport / validateHealthReport from Fleet Contracts.
- Long-running CLIs should write command reports with a fleet_run_id when managed by Fleet.

Minimum useful telemetry fields:

```text
plugin, tool, status, durationMs, error.code,
workspace_id, plan_id, plan_slug, wave_id,
agent_run_id, correlation_id, tool_call_id,
artifact_ref, lifecycle_object_id, concord_event_id, fleet_run_id
```

## Performance

Optimize for cheap startup and bounded per-call work.

- Keep module import side effects near zero.
- Lazy-initialize expensive state on first tool call or relevant hook.
- Cache only stable, bounded data.
- Prefer streaming, pagination, and top-K selection over materializing all results.
- Avoid full-repo scans in tool handlers unless explicitly requested and capped.
- Use SQLite WAL or an equivalent local store when state must survive process restarts.
- Push CPU-heavy or long-lived state to a daemon only when startup, concurrency, or memory pressure justifies it.
- If using a daemon, use a small typed protocol, health/heartbeat, auth token, crash recovery, and lazy startup.
- Add timeouts around external processes, daemon RPC, network calls, and expensive file operations.
- Cache keychain/credential lookups for the process lifetime or a bounded TTL; synchronous keychain calls must not happen per runtime construction or per tool call.
- Split required work from optional enrichment. Embedding may be useful; classification, rerank, summarization, and analytics should yield, skip, or run at lower priority when queues are deep.
- Prefer direct imports over barrels for heavy packages.

Targets are contextual, but plugin load should feel instant, common tool calls should be bounded, and output size should never threaten the model context window.

## Durable Job Pattern

Use a structured job table or daemon store for any resumable background pipeline: hot DB backfill, artifact ingest, indexing, distillation, relation building, cleanup, or repair.

Required job fields:

```text
id, project_id, kind, strategy, status,
cursor_json, lease_owner, lease_expires_at,
processed counts, inserted counts, error_summary,
time_created, time_updated, time_started, time_finished
```

Rules:

- Status values should be explicit: pending, running, completed, failed, cancelled.
- Cursor/progress updates must share a durability boundary with writes when correctness depends on them.
- Jobs need resume, cancel, stale lease detection, and terminal error summaries.
- CLI jobs should open their own readonly source connections and report bounded batch progress.
- Runtime hooks may enqueue or report status; they must not run the job body.

## SQLite And Local Stores

SQLite is a single-writer store even in WAL mode. WAL enables concurrent readers, not unlimited write concurrency.

- Keep `busy_timeout`, WAL, and `synchronous=NORMAL` where appropriate, but treat them as safety rails, not a performance strategy.
- One writer path owns sidecar writes. Readonly workers or CLI processes may open separate source connections.
- Transactions should be short and batch-sized.
- Avoid recursive `IN (...)` expansion or unbounded `OR` clauses over large roots; traverse in bounded batches or persist closure/progress state.
- Avoid scanning content blobs before narrowing by indexed metadata.
- Health should check sidecar quick health, WAL size, stale running jobs, queue drops, broad caps, and unsafe runtime config.

## Retrieval And Context Access

Context-producing tools should default to bounded, high-authority evidence. Broad search must be explicit.

- Default memory access should prefer local context bundles, artifact metadata, recent windows, and high-authority rows.
- Broad hybrid search needs caps: vector candidate count, result count, time budget, context budget, and truncation metadata.
- Vector scoring should use bounded candidate SQL plus low-allocation top-K selection. Do not stream every embedded chunk by default.
- Rerank and LLM-assisted classification are optional enrichment. They require timeouts and skip behavior.
- Artifact context should filter by kind/title/slug/metadata before reading full content.

## Memory Discipline

Low memory usage comes from boundaries and caps.

- Return summaries, refs, and compact evidence, not raw corpora.
- Use budget_chars for context-producing tools.
- Cap arrays and include truncation metadata.
- Store large artifacts on disk and return ArtifactRef.
- Avoid retaining full OpenCode messages, prompts, logs, or file contents in process memory.
- Use iterators or chunked reads for large files and indexes.
- Dispose file handles, database statements, subprocesses, watchers, and timers.
- Do not keep per-session maps forever; expire by TTL, LRU, or explicit lifecycle.

## Sidecar Daemons

Use a sidecar only when a plugin needs persistent low-latency state, expensive indexing, lock tables, or heavyweight analysis.

Conventions:

- TypeScript owns OpenCode integration, hooks, tool registration, path normalization, and daemon supervision.
- The daemon owns durable state, incremental indexing, lock tables, or analysis algorithms.
- Shared protocol types live in a shared package and have tests on both sides.
- Paths sent to daemons should be project-relative unless there is a documented exception.
- Daemon state belongs under .git/<plugin>/ or .opencode/<plugin>/ depending on whether it is implementation cache or user-visible lifecycle state.
- Provide status, doctor, health, and lightweight heartbeat commands when the daemon can run independently.

## CLI And Health

Every production plugin should expose a small CLI.

Required commands:

```bash
<plugin> doctor --json
<plugin> status --json
```

Recommended commands when relevant:

```bash
<plugin> check
<plugin> maintain
<plugin> rebuild
<plugin> telemetry status
<plugin> policy export
```

Health checks should be fast, local-first, and canonical:

- Use HealthReport shape.
- Include schema_version: 1.
- Include clear ok, warn, and error checks.
- Do not require network access for basic health unless the plugin's core function requires it.
- Include actionable detail strings.
- Warn on unsafe runtime options, stale jobs, large WAL files, queue drops, disabled caps, and failed optional enrichment.

## Tests And Gates

Add tests before treating the plugin as fleet-ready.

- Contract test: default export loads, tool names are exact, tool definitions validate, and structured failures are stable.
- Unit tests: parsers, path normalization, budget caps, error codes, telemetry redaction, and store migrations.
- Nonblocking regressions: default startup schedules no heavy timers; hook enqueue does not flush SQLite inline; queue overflow is counted.
- Job regressions: lease, progress, resume, cancel, terminal state, stale lease health, and cursor durability.
- Retrieval regressions: broad-search caps, top-K ordering, context budget adherence, and eval fixture quality.
- Runtime smoke: load plugin in a subprocess and assert the expected tool count.
- CLI tests: doctor --json and status --json produce valid HealthReport.
- Daemon tests when present: protocol compatibility, startup, heartbeat, crash recovery, stale state handling, and persistence.
- Fleet validation: update fleet.jsonc expected tool counts and run Fleet doctor/test/hygiene after registration.

Preferred validation sequence:

```bash
bun run check
bun run smoke:runtime
bun run doctor -- --json
bun run status -- --json
```

For config-level registration:

```bash
bun run /Users/jack.mazac/Developer/opencode-fleet/src/cli.ts generate-opencode-json --force
bun run fleet:test:full-runtime
bun run fleet:hygiene -- --strict --json
```

## Fleet Registration

When registering a plugin in the local fleet:

- Edit ~/.config/opencode/fleet.jsonc, not generated opencode.json.
- Add plugin_ref only for runtime plugins.
- Leave library-only packages without plugin_ref.
- Set expected_tools for tool plugins.
- Use expected_tools_exact: true when extra tools are a contract failure.
- Regenerate opencode.json through OpenCode Fleet.
- Commit fleet.jsonc, opencode.json, .opencode-fleet.lock.json, and dependency lockfiles as one logical change.

## Architecture Review Checklist

Use this checklist before shipping:

- The plugin has one clear owner responsibility and does not duplicate another fleet plugin.
- src/index.ts is thin and wrapped with Host Adapter.
- Tool names are stable and asserted in tests.
- Tool inputs are bounded and outputs are structured JSON.
- Expensive work is lazy and cancellable or timed out.
- No hook or prompt-transform path runs hot DB scans, large filesystem walks, network calls, or long transactions.
- Background pipelines have durable jobs, leases, progress, cancellation, and stale-job health.
- Memory use is capped by limits, budgets, refs, or streaming.
- Broad retrieval has vector/result/time/context caps and reports when caps apply.
- Optional enrichment has timeouts and skip behavior.
- Canonical fleet IDs are parsed or decoded at boundaries.
- Telemetry is canonical, correlated, redacted, and non-fatal.
- doctor --json and status --json emit valid HealthReport.
- Runtime smoke asserts the plugin loads and exposes expected tools.
- No direct coupling to sibling plugin internals.
- No production shell-outs to sibling fleet plugins.
- Generated OpenCode config is not hand-edited.

## Anti-Patterns

Avoid these even if they seem faster in the moment:

- A plugin that owns multiple unrelated domains.
- Tool handlers that scan the whole repo by default.
- Returning raw file contents, logs, prompts, or unbounded arrays.
- Import-time daemon startup or database migration.
- Timer-delayed heavy work in the live plugin runtime.
- Hook queue overflow that triggers synchronous SQLite writes.
- Untracked background jobs with progress stored in generic key/value rows only.
- Full-project vector scans or artifact content scans by default.
- Per-call synchronous keychain, shell, or network access in runtime paths.
- Bespoke correlation IDs or telemetry shapes.
- Direct dependency on another plugin's implementation internals.
- Shelling out to another fleet plugin in production.
- Hand-editing generated opencode.json.
- Renaming tools without updating contract tests, fleet expected counts, and consumers.
- Adding compatibility layers without a concrete persisted-data, shipped-behavior, or external-consumer need.

## Default Recommendation

If uncertain, choose the smallest correct plugin:

- One explicit owner responsibility.
- A thin Host Adapter-wrapped entry point.
- A small tool map with bounded inputs and structured outputs.
- Canonical IDs and telemetry from shared contracts.
- Lazy runtime construction.
- Local-first health checks.
- Contract tests plus runtime smoke.

Scale to packages, daemons, caches, and richer lifecycle artifacts only after the simple boundary is no longer enough.
