/**
 * Typed contract for invocations of the Cursor `agent` CLI binary.
 *
 * The plain `string[]` argv lives behind `toArgv()`. Every flag name and
 * value is a compile-time literal in the source — a typo in `--workspace`
 * or `composer-2-fast` becomes a TypeScript error, not a runtime mystery.
 *
 * Keep this file dependency-free. Only `explore-fast.ts` (and any future
 * Conductor module that wraps the `agent` CLI) should import from here.
 */

export type CursorModel = "composer-2-fast" | "composer-2";
export type CursorMode = "ask" | "agent";
export type CursorOutputFormat = "json" | "stream-json";

/**
 * Thoroughness contract from `prompts/explore.txt`. The orchestrator picks the
 * tier; `explore-fast` maps it to timeout and model defaults (see
 * `THOROUGHNESS_DEFAULTS` in `explore-fast.ts`) and writes the tier into the
 * prompt so the agent adapts its search depth.
 *
 *   quick      — first match is sufficient, return immediately
 *   standard   — primary locations + 2-3 grep passes + cross-references (default)
 *   exhaustive — map all occurrences, re-exports, tests, configs, consumers
 */
export type ExploreFastThoroughness = "quick" | "standard" | "exhaustive";

/**
 * Classifies the source of an error event. Callers that drain the stream into
 * a final string (e.g. `runExploreFast`) check this to decide whether partial
 * output is worth keeping — `timeout` is the only kind where the agent's
 * pre-cancellation work has stand-alone value.
 *
 *   validation — caller input rejected (empty query, path escape)
 *   spawn      — Bun.spawn threw before the process started
 *   timeout    — we aborted after `timeoutMs` elapsed; partial chunks may exist
 *   exit       — CLI exited non-zero with stderr content
 *   cli        — CLI emitted a `result` event with `is_error: true`
 */
export type ExploreFastErrorKind = "validation" | "spawn" | "timeout" | "exit" | "cli";

export type CursorInvocation = {
  model: CursorModel;
  mode: CursorMode;
  outputFormat: CursorOutputFormat;
  workspace: string;
  prompt: string;
};

/**
 * Single source of truth for the `agent` CLI's flag names and ordering.
 * Tests assert on the exact return of this function — that catches both
 * presence and ordering regressions in one shot.
 */
export function toArgv(inv: CursorInvocation): readonly string[] {
  return [
    "-p",
    "--model",
    inv.model,
    "--mode",
    inv.mode,
    "--output-format",
    inv.outputFormat,
    "--workspace",
    inv.workspace,
    inv.prompt,
  ];
}

/**
 * Internal tagged union of events that `explore-fast` callers consume.
 *
 * This is NOT the on-the-wire CLI envelope — it's the normalized shape after
 * `parseEvent` in `explore-fast.ts` maps Cursor's `--output-format stream-json`
 * output into our domain. The CLI emits `system`, `init`, `user`, `assistant`,
 * and `result` top-level events; we drop boot/prompt/tool-result envelopes and
 * extract the per-content-item shapes below from `assistant.message.content[]`
 * and `result`.
 *
 * Unknown CLI events are dropped at parse time — forward-compatible with any
 * new event types Cursor adds.
 */
export type ExploreFastEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "error"; kind: ExploreFastErrorKind; message: string }
  | { type: "done"; result?: string };
