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
 * tier; `explore-fast` maps it to a default model (see `THOROUGHNESS_MODELS`
 * in `explore-fast.ts`) and writes the tier into the prompt so the agent
 * adapts its search depth. There is no per-tier timeout — the CLI runs to
 * completion and the outer task harness owns the wall-clock budget.
 *
 *   quick      — first match is sufficient, return immediately
 *   standard   — primary locations + 2-3 grep passes + cross-references (default)
 *   exhaustive — map all occurrences, re-exports, tests, configs, consumers
 */
export type ExploreFastThoroughness = "quick" | "standard" | "exhaustive";

/**
 * Classifies the source of an error event. The library does not impose a
 * per-call timeout — the caller (OpenCode's task harness, or whoever owns the
 * outer envelope) is responsible for bounding wall time. The kinds below are
 * the only error sources `streamExploreFast` can emit.
 *
 *   validation — caller input rejected (empty query, path escape)
 *   spawn      — Bun.spawn threw before the process started
 *   exit       — CLI exited non-zero with stderr content
 *   cli        — CLI emitted a `result` event with `is_error: true`
 */
export type ExploreFastErrorKind = "validation" | "spawn" | "exit" | "cli";

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
