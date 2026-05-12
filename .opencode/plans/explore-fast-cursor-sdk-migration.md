# Plan — Harden the Cursor CLI `explore-fast` implementation

**Slug:** `explore-fast-cursor-sdk-migration` (kept for slug stability; this plan supersedes the prior SDK-migration draft)
**Drafted:** 2026-05-12
**Status:** ✅ **Implemented and verified 2026-05-12** against `agent 2026.05.09-0afadcc` on Bun 1.3.13. See "Implementation notes" below for deviations from the original draft.
**Supersedes:** the earlier `@cursor/sdk` migration draft. The SDK path was abandoned because Cursor's token-based pricing on every SDK call is a real cost regression versus the CLI's free-with-login auth.

---

## Implementation notes (2026-05-12)

What shipped:
- `src/cursor-cli-types.ts` (new, 62 lines) — `CursorModel` / `CursorMode` / `CursorOutputFormat` literal unions, `CursorInvocation`, `toArgv()`, `ExploreFastEvent` tagged union.
- `src/explore-fast.ts` (rewritten) — `streamExploreFast` async generator + `runExploreFast` drain-to-string wrapper; `AbortController` + Bun.spawn `signal`; cached system prompt; concurrent stderr drain; line-reassembly across chunk boundaries; caller-disposal abort.
- `src/explore-fast.test.ts` (rewritten) — 20 unit tests covering validation, typed argv, real-CLI-shape parsing, dedup, abort lifecycle. One env-gated integration test (`CURSOR_CLI_INTEGRATION=1`) runs against the real `agent` binary; surfaced as `bun run smoke:explore-fast`.

Phase-0 spike outcomes (run during validation, not before):
- **0.1 (NDJSON support)** — Confirmed. `agent -p --output-format stream-json` works.
- **0.2 (event schema)** — `system` / `init` / `user` / `assistant` (with `message.content[]`) / `result`. **Did NOT match** the assumed flat `assistant_text` / `tool_call` / `done` shapes — required a corrective revision after the first integration run returned empty output.
- **0.3 (Bun spawn)** — `signal` + `timeout` both work as documented.
- **0.4 (API shape)** — Went with the additive option: `runExploreFast(input): Promise<string>` preserved; `streamExploreFast` added.

Bugs found and fixed in flight:
1. Wrong assumed event shape (above) — fixed in `parseEvent` by mapping the real envelope: `assistant.message.content[]` → `assistant_text` / `tool_call`; `result` → `done` / `error`.
2. **Output doubling** — the CLI emits the same body in both `assistant_text` events *and* the terminal `result.result`. `runExploreFast` initially appended both. Fixed by making `done.result` a *fallback* (only used when no `assistant_text` was streamed), not an additive source.
3. **Subprocess leak on caller-disposal** — when a caller breaks out of `streamExploreFast` early, the async generator's `finally` now aborts the `AbortController` so Bun.spawn SIGTERMs the child. Without this, the subprocess hangs once the stdout pipe buffer fills.

Lesson for next time: **run the Phase 0 spikes**. The event-shape mismatch cost one full integration-test round-trip that the spike would have caught in five minutes.

---

## Why

`src/explore-fast.ts` works, but every piece of its complexity is a *consequence of treating the CLI boundary as untyped strings + opaque JSON*, not of using the CLI itself. The CLI is fine. The wrapper is the problem.

Three categories of fragility, none of which require the SDK to fix:

1. **`buildExploreFastCommand`** assembles argv as a flat `string[]`. A typo in `--workspace` is a runtime error, not a compile error, and the model id `"composer-2-fast"` is a magic string scattered across implementation and tests.
2. **`parseCursorOutput` + `extractText`** scans four possible JSON shapes (`string`, `result`, `message`, `output`, `result.text`) because we don't have a typed contract with the CLI's output. This is the part most likely to silently misbehave when Cursor changes their JSON envelope.
3. **`runCursorProcess`** hand-rolls a `Bun.spawn` + `Promise.race` timeout + manual `proc.kill()`, then buffers the entire stdout via `new Response(proc.stdout).text()`. No streaming, no incremental output, and the runner-injection test seam means CI never exercises the real spawning code.

This plan keeps the `agent` CLI as the transport — same pricing model, same auth model — and rebuilds the wrapper around three typed contracts: a typed invocation, a typed event stream, and a typed result.

## Scope

**In scope**
- Strongly-typed argv construction with literal-union types for `model`, `mode`, and `outputFormat`.
- Switch to `--output-format stream-json` (or whatever the CLI's NDJSON-equivalent flag turns out to be — Phase 0) so we can parse a stable per-event schema instead of guessing at one of four JSON shapes.
- Stream events from the CLI's stdout as an `AsyncIterable<ExploreFastEvent>` and provide a `Promise<string>` convenience that drains it. Callers that want incremental output can iterate directly; callers that don't keep the same `Promise<string>` shape they have today.
- Replace the manual `setTimeout` + `Promise.race` cancellation with `AbortController` + `Bun.spawn`'s built-in `timeout` / `signal` options. Single source of cancellation.
- Cache the `prompts/explore.txt` system prompt at module load. Stop re-reading it on every invocation.
- Real integration test that actually invokes `agent`, gated on env so it skips in offline CI.

**Out of scope**
- `@cursor/sdk`. Explicitly rejected for cost reasons.
- Cloud-mode agents (a property of the SDK, not the CLI).
- Touching `prompts/explore.txt`.
- Replacing other Conductor tools that have nothing to do with Cursor.

**Preserved as-is** (don't touch the parts that already work)
- The `resolveTargetPath` workspace-boundary check.
- The `cap()` + `[truncated - N chars omitted]` output bounding behavior.
- The 120s / 12k chars / 2k chars defaults.
- The empty-query short-circuit before any process spawn.
- The injectable test seam pattern — just refined into a more typed shape.

---

## Phase 0 — Pre-flight spikes

Four cheap spikes settle the design. Run them, paste the output back, then proceed to Phase 1.

### 0.1 Does the `agent` CLI support streaming NDJSON?

```bash
agent -p --output-format stream-json --model composer-2-fast --mode ask \
  --workspace "$PWD" "Say hi in one sentence"
```

Possible outcomes:
- **A.** Emits one JSON object per line on stdout (NDJSON). → Best case. Plan proceeds as written.
- **B.** Errors on `stream-json` but supports a different flag (e.g. `--output-format jsonl`, `--stream`). → Plan proceeds, just swap the flag literal.
- **C.** No streaming mode at all; only `--output-format json` exists. → Drop the streaming public API and keep just the typed-argv + typed-result improvements. Still a meaningful net win, just smaller.

### 0.2 What's the event schema?

Capture a few events from spike 0.1's output. The plan assumes the shape below (which mirrors what Cursor's SDK exposes through `run.stream()`):

```ts
type ExploreFastEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "error"; message: string }
  | { type: "done"; result?: string };
```

If the CLI's actual event shape differs, the plan only changes inside the event-parser file — everything else stays.

### 0.3 Bun spawn capabilities

Confirm `Bun.spawn` supports `timeout` (ms) and `signal: AbortSignal` on the Bun version Conductor pins. Both have been stable since Bun 1.1; the project's `bun.lock` should already be on a compatible version. One-liner:

```bash
bun -e 'Bun.spawn(["sleep", "5"], { timeout: 100 }).exited.then(c => console.log("exit", c))'
```

Should print `exit 143` (or similar) within ~100ms. If yes, we delete the manual `Promise.race` timeout entirely.

### 0.4 Public-API breaking-change tolerance

Two shapes for the migration:
- **Additive (recommended).** Keep `runExploreFast(input): Promise<string>` unchanged. Add new `streamExploreFast(input): AsyncIterable<ExploreFastEvent>`. Internally `runExploreFast` drains `streamExploreFast`. Zero breaking risk.
- **Breaking.** Change `runExploreFast` to return `AsyncIterable<ExploreFastEvent>`. Cleaner, but breaks any caller (none today, but stops being a future-proofing argument the moment someone wires it in).

Default to additive unless Jack wants breaking.

---

## Phase 1 — Type the invocation

**Goal:** make every flag name a compile-time literal so typos are caught by `tsgo --noEmit`.

### 1.1 New types

```ts
export type CursorModel = "composer-2-fast" | "composer-2";
export type CursorMode = "ask" | "agent";
export type CursorOutputFormat = "json" | "stream-json";

export type CursorInvocation = {
  model: CursorModel;
  mode: CursorMode;
  outputFormat: CursorOutputFormat;
  workspace: string;
  prompt: string;
};

// Only place flag literals exist. One function, one source of truth.
export function toArgv(inv: CursorInvocation): readonly string[] {
  return [
    "-p",
    "--model", inv.model,
    "--mode", inv.mode,
    "--output-format", inv.outputFormat,
    "--workspace", inv.workspace,
    inv.prompt,
  ];
}
```

### 1.2 What this kills

- The current `buildExploreFastCommand` that ships an `ExploreFastCommand` with a flat `args: string[]`.
- Every test assertion that does `expect(command.args).toContain("--workspace")` — replaced by `expect(toArgv(inv)).toEqual([...exact array...])`, which catches both presence *and* ordering regressions in one shot.
- The magic-string `"composer-2-fast"` repeated across implementation, tests, and the AGENTS.md comment.

### 1.3 Where the literal types come from

Define `CursorModel` and friends in a small `src/cursor-cli-types.ts` so they're reusable if any other Conductor tool ever drives `agent`. Single import, single source.

---

## Phase 2 — Stream the output (assumes spike 0.1 outcome A or B)

**Goal:** replace the four-key JSON shape-guesser with a per-event parser against a known schema.

### 2.1 NDJSON line stream

```ts
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}
```

Handles partial lines split across chunk boundaries — the one place a stdout streamer can quietly corrupt itself.

### 2.2 Typed event parser

```ts
function parseEvent(line: string): ExploreFastEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "assistant_text":
      return typeof raw.text === "string" ? { type: "assistant_text", text: raw.text } : null;
    case "tool_call":
      return typeof raw.name === "string" ? { type: "tool_call", name: raw.name, input: raw.input } : null;
    case "tool_result":
      return typeof raw.name === "string" && typeof raw.ok === "boolean"
        ? { type: "tool_result", name: raw.name, ok: raw.ok } : null;
    case "error":
      return typeof raw.message === "string" ? { type: "error", message: raw.message } : null;
    case "done":
      return { type: "done", result: typeof raw.result === "string" ? raw.result : undefined };
    default: return null;
  }
}
```

No `as`, no `any`, no `@ts-ignore`. Conductor's type-safety invariants stay green. Unknown event types return `null` and get skipped — forward-compatible with new events the CLI may add.

### 2.3 What this kills

- `parseCursorOutput`, `extractText`, `ParsedCursorOutput`. Net ~35 lines deleted.
- The "malformed JSON" error branch — a malformed line is now just a skipped line, not a fatal error. Logged via the existing journal if useful.

### 2.4 Fallback (if spike 0.1 returns outcome C, no streaming flag)

Keep `--output-format json` but type the single-shot envelope:

```ts
type CursorBatchOutput = { result?: string; message?: string; output?: string };
```

Parse once, prefer `result`, fall back to `message`, fall back to `output`. Same defensive behavior as today but expressed as a typed schema. The 4-key reflection scan still goes away.

---

## Phase 3 — Process lifecycle

**Goal:** replace the hand-rolled timeout/kill with Bun-native cancellation.

### 3.1 Spawn

```ts
const controller = new AbortController();
const proc = Bun.spawn(["agent", ...toArgv(inv)], {
  cwd: inv.workspace,
  stdout: "pipe",
  stderr: "pipe",
  signal: controller.signal,           // single cancellation source
  timeout: input.timeoutMs ?? 120_000, // Bun handles SIGTERM itself
});
```

### 3.2 What this kills

- The manual `setTimeout` + `proc.kill()` + `Promise.race` block.
- The `timedOut?: boolean` field on the result — replaced by checking whether `controller.signal.aborted` is true or whether `proc.exitCode === null` after `await proc.exited`.
- `new Response(proc.stdout).text()` (the full-buffering call). Stdout is now consumed line-by-line via the generator in 2.1.

### 3.3 Concurrent stderr drain

Bun deadlocks if stderr fills its pipe buffer (~64KB) and nobody reads it. Drain it concurrently:

```ts
const stderrPromise = new Response(proc.stderr).text(); // fire-and-forget; awaited only on failure
```

Single line, no semantic change, prevents a class of "works locally, hangs in CI" bugs.

---

## Phase 4 — Public API

### 4.1 Streaming function

```ts
export async function* streamExploreFast(input: RunExploreFastInput): AsyncIterable<ExploreFastEvent> {
  // ... validation (empty-query, resolveTargetPath) — unchanged ...
  // ... spawn (Phase 3) ...
  for await (const line of readLines(proc.stdout)) {
    const event = parseEvent(line);
    if (event) yield event;
  }
  // ... handle non-zero exit, emit final `error` event if needed ...
}
```

### 4.2 Drain-to-string convenience (preserves today's signature)

```ts
export async function runExploreFast(input: RunExploreFastInput): Promise<string> {
  const chunks: string[] = [];
  let lastError: string | undefined;
  for await (const event of streamExploreFast(input)) {
    if (event.type === "assistant_text") chunks.push(event.text);
    else if (event.type === "error") lastError = event.message;
    else if (event.type === "done" && event.result) chunks.push(event.result);
  }
  if (lastError !== undefined) return `Cursor CLI failed: ${cap(lastError, input.maxErrorChars ?? 2_000)}`;
  return cap(chunks.join(""), input.maxOutputChars ?? 12_000);
}
```

Same return shape as today. Same error-string conventions (`Cursor CLI failed: …`, `Cursor CLI timed out after …ms`, `explore-fast query is required`, `explore-fast path must stay inside workspace`) — keeps any log-grepper happy.

### 4.3 Performance wins

- **Cached system prompt.** `loadExplorePrompt()` currently re-reads `prompts/explore.txt` on every call. Cache it once at module load: `const EXPLORE_PROMPT = await Bun.file(...).text();`. Saves ~1ms + an fs syscall per invocation. Tiny on its own, multiplied across orchestrator fan-out it adds up.
- **No full-stdout buffering.** Streaming means the first assistant token can surface before the model is done generating. For 12k-char outputs at ~50 tok/s, that's seconds of latency saved end-to-end if any caller consumes incrementally.
- **No `Bun.spawn` arg-array allocation per typo.** Trivial but real — typed argv builder runs once per call, deterministically.

---

## Phase 5 — Tests

### 5.1 Unit tests (no spawning)

Replace the current `runner` injection with a **`spawn` function injection** that returns a fake process object with `stdout` (a `ReadableStream`), `stderr`, `exited`, etc. Tests construct fixture NDJSON strings, wrap them as `ReadableStream<Uint8Array>`, and drive the parser end-to-end without ever touching `Bun.spawn`.

Test cases:
| Case | What it asserts |
|---|---|
| Empty query | Short-circuits before spawn; fake spawn never called. |
| Target path outside workspace | Same as above, with explicit `path` arg. |
| Single assistant_text event | Returned text equals event's text. |
| Multiple assistant_text events | Concatenated in order. |
| Skipped malformed line | Parser ignores `not-json\n` and continues with next event. Doesn't fatal. |
| `error` event | `runExploreFast` returns `"Cursor CLI failed: …"`. |
| Output cap | 26-char text capped to 10 returns `"abcdefghij\n\n[truncated - 16 chars omitted]"`. (Identical to today.) |
| Stdout that never closes | AbortController fires after `timeoutMs`; result is `"Cursor CLI timed out after Xms"`. |
| `toArgv` | Exact array equality, including order. Catches flag-name typos at test time. |

### 5.2 Integration test (real spawn, env-gated)

```ts
test.skipIf(!process.env.CURSOR_CLI_INTEGRATION)("invokes the real agent CLI", async () => {
  const out = await runExploreFast({
    directory: process.cwd(),
    query: "What does package.json's name field say?",
    timeoutMs: 30_000,
  });
  expect(out).toMatch(/@jackmazac\/opencode-conductor/);
});
```

`bun test` skips it by default. CI/dev can run it via `CURSOR_CLI_INTEGRATION=1 bun test src/explore-fast.test.ts`. Closes the "we never test the actual spawn path" gap.

### 5.3 Tests removed

- "builds a Cursor CLI JSON print-mode command for Composer 2 Fast" — replaced by the typed `toArgv` test in 5.1.
- "reports malformed Cursor JSON output" — no longer a failure mode in stream-json. Replaced by "skipped malformed line".

---

## Phase 6 — Validation

All four required gates from `AGENTS.md` plus the new integration smoke:

```bash
bun run check               # lint:no-zod + typecheck + unit tests
bun run smoke:runtime       # tool count (only material if Phase 7 wires a tool)
bun run doctor -- --json    # canonical HealthReport
bun run status -- --json    # canonical HealthReport
CURSOR_CLI_INTEGRATION=1 bun test src/explore-fast.test.ts  # real agent CLI
```

---

## Phase 7 — Plugin-tool decision (carried over)

`explore_fast` is currently described as "removed" in `AGENTS.md` and the file header, isn't in `scripts/runtime-smoke.ts:4-41`'s `expectedTools`, and the file exists as an internal library only. Two paths:

- **Keep internal-only** (recommended). Touch nothing in `index.ts` or `runtime-smoke.ts`. Update the file-header comment in `src/explore-fast.ts` to reflect that it's actively used as a library (just not plugin-registered).
- **Re-register as `explore_fast` plugin tool.** Add `tool({ description, args: { query, path?, timeout_ms? }, execute })` to `src/index.ts`, add the name to `expectedTools` (becomes 36 entries) in `scripts/runtime-smoke.ts` and to `src/plugin-contract.test.ts`. Add a row to the orchestrator's tool table in `prompts/orchestrator.txt:392+`.

Same decision as the prior plan — open question for Jack.

---

## What this delivers vs the SDK migration

| Dimension | SDK migration (rejected) | CLI hardening (this plan) |
|---|---|---|
| Pricing | Token-based per call | Free with `agent login` (unchanged) |
| New runtime deps | `@cursor/sdk` | None |
| Typed invocation | ✅ via SDK | ✅ via `CursorInvocation` + `toArgv` |
| Typed output | ✅ via `run.stream()` | ✅ via `ExploreFastEvent` parsing of `--output-format stream-json` |
| Streaming output | ✅ | ✅ |
| Cancellation | SDK `run.abort()` | `AbortController` + `Bun.spawn` `timeout` |
| Real exercise of transport in CI | Unit tests cover SDK adapter; SDK calls cost tokens so integration skipped | Unit tests cover NDJSON parsing; env-gated integration runs the real `agent` |
| LOC delta in `explore-fast.ts` | ~−40 net | ~−30 net |
| Risk of CLI envelope changes breaking us | N/A (no CLI) | Lowered: typed schema parsed per event, unknown events skip gracefully instead of fataling |

The CLI plan gets us 85–90% of the SDK plan's structural benefits with zero pricing impact and zero new dependencies. The one thing it doesn't get is cloud-VM agents — and that wasn't in scope anyway.

---

## Risks and unknowns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `agent` CLI doesn't support `--output-format stream-json` | Medium | Medium — falls back to typed batch JSON | Phase 0 spike. Plan degrades cleanly to the Phase 2.4 fallback. |
| Event schema differs from the assumed shape | High (specifics unknown) | Low — single file edit in `parseEvent` | Phase 0 spike captures real samples; encode the actual schema. |
| Bun's `spawn` `timeout`/`signal` behavior differs from documented | Low | Medium — keep the manual race as fallback | Phase 0 spike confirms before deletion. |
| Some unseen caller relies on the `ExploreFastCommand`/`ExploreFastProcessRunner` exports | Low (grep showed only the test file consumes them) | Medium — would force keeping deprecated re-exports | Grep across the monorepo before the commit that drops them. |
| `agent` CLI auth context not present in plugin runtime | Low | High — calls fail with "not logged in" | Same risk that exists today; not introduced by this plan. Worth confirming via the Phase 5.2 integration test on a fresh checkout. |

---

## Open questions

> **Jack — four decisions to confirm before coding:**
>
> 1. Does `agent -p --output-format stream-json …` work on your machine? (Phase 0.1 spike.) If yes, we get streaming for free. If no, we still get the typed-argv + typed-batch-output wins.
> 2. Additive API (`runExploreFast` unchanged, add `streamExploreFast`) or breaking (`runExploreFast` returns `AsyncIterable`)? Recommend additive.
> 3. Re-register `explore_fast` as a plugin tool, or keep it as an internal helper module?
> 4. OK to delete the public `ExploreFastCommand`, `ExploreFastProcessRunner`, and friends from the module's exports?

Once those land: one PR, two files touched (`src/explore-fast.ts` + `src/explore-fast.test.ts`), one tiny new file (`src/cursor-cli-types.ts`), no dependency changes. Estimated effort: half a day end-to-end including validation.
