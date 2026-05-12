/**
 * Conductor owns agent-directed LLM exploration (Cursor CLI backed).
 * Codemem owns deterministic code-graph / drift / impact truth.
 *
 * `explore-fast` is a typed wrapper around `agent -p --model composer-2-fast …`.
 * It is used as an internal library by Conductor flows that want fast,
 * model-reasoned exploration cues (prompts, narration) rather than deterministic
 * graph traversal. If you need file-dependency, impact-cone, API-surface,
 * layer-boundary, or change-risk analysis, use the codemem_* tools.
 *
 * Two public functions:
 *   - `streamExploreFast` yields typed events as the CLI emits them. Callers
 *     that want incremental output use this directly.
 *   - `runExploreFast` drains the stream into a bounded `Promise<string>` —
 *     same return shape `explore-fast` has always had, so legacy callers
 *     don't need to change.
 *
 * Pricing model: free with `agent login`. No new runtime dependencies.
 */

import path from "node:path";

import {
  toArgv,
  type CursorInvocation,
  type CursorModel,
  type ExploreFastErrorKind,
  type ExploreFastEvent,
  type ExploreFastThoroughness,
} from "./cursor-cli-types";

const DEFAULT_MAX_ERROR_CHARS = 2_000;
const DEFAULT_THOROUGHNESS: ExploreFastThoroughness = "standard";

/**
 * Default time and model budget per thoroughness tier. Callers can override
 * `timeoutMs` or `model` explicitly; otherwise these defaults match the
 * orchestrator's `explore` / `explore-high` shape from `orchestrator.txt`.
 *
 * Notably: `exhaustive` upgrades to the deeper `composer-2` model. That maps
 * the `explore-high` distinction directly — strongest reasoning when the slice
 * needs it, fast model otherwise.
 */
const THOROUGHNESS_DEFAULTS: Record<
  ExploreFastThoroughness,
  { timeoutMs: number; model: CursorModel }
> = {
  quick: { timeoutMs: 30_000, model: "composer-2-fast" },
  standard: { timeoutMs: 120_000, model: "composer-2-fast" },
  exhaustive: { timeoutMs: 300_000, model: "composer-2" },
};

export type RunExploreFastInput = {
  directory: string;
  query: string;
  path?: string;
  /**
   * Thoroughness tier (`quick` / `standard` / `exhaustive`). Drives the
   * default `timeoutMs` and `model` per `THOROUGHNESS_DEFAULTS`, and is
   * written into the prompt so the agent adapts its search depth. Explicit
   * `timeoutMs` / `model` override the tier defaults. Defaults to `standard`.
   */
  thoroughness?: ExploreFastThoroughness;
  timeoutMs?: number;
  maxErrorChars?: number;
  systemPrompt?: string;
  model?: CursorModel;
  /**
   * Test seam. Overrides the real `Bun.spawn` call so unit tests can drive
   * the parser end-to-end against scripted `ReadableStream` fixtures without
   * ever launching a subprocess.
   */
  spawn?: ExploreFastSpawnFn;
};

export type ExploreFastSpawnInput = {
  cmd: readonly string[];
  cwd: string;
  signal: AbortSignal;
};

export type ExploreFastSubprocess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

export type ExploreFastSpawnFn = (input: ExploreFastSpawnInput) => ExploreFastSubprocess;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream typed events from the `agent` CLI. Validation failures (empty query,
 * out-of-workspace path) are surfaced as a single `error` event, so callers
 * have one event shape to handle.
 */
export async function* streamExploreFast(
  input: RunExploreFastInput,
): AsyncGenerator<ExploreFastEvent> {
  const validation = validateInput(input);
  if (!validation.ok) {
    yield { type: "error", kind: "validation", message: validation.message };
    return;
  }

  const thoroughness = input.thoroughness ?? DEFAULT_THOROUGHNESS;
  const defaults = THOROUGHNESS_DEFAULTS[thoroughness];
  const timeoutMs = input.timeoutMs ?? defaults.timeoutMs;
  const model = input.model ?? defaults.model;
  const maxErrorChars = input.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS;

  const systemPrompt = input.systemPrompt ?? (await loadExplorePrompt());
  const prompt = buildPrompt({
    systemPrompt,
    query: validation.query,
    directory: input.directory,
    targetPath: validation.targetPath,
    thoroughness,
  });
  const invocation: CursorInvocation = {
    model,
    mode: "ask",
    outputFormat: "stream-json",
    workspace: input.directory,
    prompt,
  };

  const spawn = input.spawn ?? defaultSpawn;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let proc: ExploreFastSubprocess;
  try {
    proc = spawn({
      cmd: ["agent", ...toArgv(invocation)],
      cwd: input.directory,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    yield {
      type: "error",
      kind: "spawn",
      message: `Cursor CLI failed to start: ${cap(errorMessage(error), maxErrorChars)}`,
    };
    return;
  }

  // Drain stderr concurrently to avoid pipe-buffer deadlock. We only need
  // the contents on the failure path; on success the promise is ignored.
  const stderrPromise = collectStream(proc.stderr).catch(() => "");

  try {
    for await (const line of readLines(proc.stdout)) {
      for (const event of parseEvent(line)) yield event;
    }

    const exitCode = await proc.exited;

    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      yield {
        type: "error",
        kind: "timeout",
        message: `Cursor CLI timed out after ${timeoutMs}ms`,
      };
      return;
    }

    if (exitCode !== 0) {
      const stderr = cap((await stderrPromise) || "(no stderr)", maxErrorChars);
      yield {
        type: "error",
        kind: "exit",
        message: `Cursor CLI failed with exit code ${exitCode}\n\n${stderr}`,
      };
    }
  } finally {
    clearTimeout(timer);
    // If the caller broke out of the stream early, the async generator's
    // .return() runs this finally — but the subprocess is still alive and
    // will block on stdout once the OS pipe buffer fills. Abort the signal
    // so Bun.spawn sends SIGTERM. No-op if we already aborted via timeout
    // or the process exited cleanly.
    if (!controller.signal.aborted) controller.abort("disposed");
  }
}

/**
 * Drain `streamExploreFast` into a single string. Same `Promise<string>`
 * return shape as the pre-migration `runExploreFast` — legacy callers see no
 * API change. Output is no longer truncated; the orchestrator's task harness
 * is the right place to bound subagent return size.
 *
 * Resolution order:
 *   1. `error` event of kind `timeout` with partial chunks → return the
 *      partial output prefixed with `[partial output — <timeout message>]`.
 *      The agent's pre-cancellation work has stand-alone value; throwing it
 *      away is a real correctness loss for the `exhaustive` tier.
 *   2. Any other `error` event → return the message verbatim (bounded by the
 *      streamer's `maxErrorChars`).
 *   3. Otherwise, concatenated `assistant_text` chunks.
 *   4. Otherwise (no streamed text), the terminal `done.result`. Cursor's
 *      `result` event echoes the final answer; if we already captured it via
 *      `assistant_text` we drop the echo to avoid doubling the output.
 *   5. Empty string.
 */
export async function runExploreFast(input: RunExploreFastInput): Promise<string> {
  const chunks: string[] = [];
  let doneResult: string | undefined;
  let firstError: { kind: ExploreFastErrorKind; message: string } | undefined;

  for await (const event of streamExploreFast(input)) {
    if (event.type === "assistant_text") {
      chunks.push(event.text);
    } else if (event.type === "done") {
      if (event.result !== undefined) doneResult = event.result;
    } else if (event.type === "error") {
      if (firstError === undefined) firstError = { kind: event.kind, message: event.message };
    }
  }

  if (firstError !== undefined) {
    if (firstError.kind === "timeout" && chunks.length > 0) {
      return `[partial output — ${firstError.message}]\n\n${chunks.join("")}`;
    }
    return firstError.message;
  }
  if (chunks.length > 0) return chunks.join("");
  if (doneResult !== undefined) return doneResult;
  return "";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ValidatedInput =
  | { ok: true; query: string; targetPath: string | undefined }
  | { ok: false; message: string };

function validateInput(input: RunExploreFastInput): ValidatedInput {
  const query = input.query.trim();
  if (query === "") return { ok: false, message: "explore-fast query is required" };
  const targetPath = resolveTargetPath(input.directory, input.path);
  if (targetPath === false) {
    return { ok: false, message: "explore-fast path must stay inside workspace" };
  }
  return { ok: true, query, targetPath };
}

let cachedPrompt: Promise<string> | undefined;
function loadExplorePrompt(): Promise<string> {
  if (cachedPrompt === undefined) {
    cachedPrompt = Bun.file(path.join(import.meta.dir, "..", "prompts", "explore.txt")).text();
  }
  return cachedPrompt;
}

function buildPrompt(input: {
  systemPrompt: string;
  query: string;
  directory: string;
  targetPath: string | undefined;
  thoroughness: ExploreFastThoroughness;
}): string {
  const parts = [
    input.systemPrompt.trim(),
    "# Exploration request",
    "",
    input.query,
    "",
    "# Workspace",
    input.directory,
  ].filter((part) => part.length > 0);

  if (input.targetPath !== undefined) {
    parts.push("", "# Target path", input.targetPath);
  }

  parts.push("", "# Thoroughness", input.thoroughness);

  return parts.join("\n");
}

function resolveTargetPath(
  directory: string,
  targetPath: string | undefined,
): string | undefined | false {
  if (targetPath === undefined || targetPath.trim() === "") return undefined;

  const root = path.resolve(directory);
  const candidate = path.resolve(root, targetPath);
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  return false;
}

const defaultSpawn: ExploreFastSpawnFn = (input) => {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: input.signal,
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
  };
};

/**
 * Split a byte stream into newline-terminated lines. Carries partial lines
 * across chunk boundaries — the one place a stdout streamer can silently
 * corrupt itself if you skip it.
 */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      if (line.length > 0) yield line;
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * Typed parser for one NDJSON line from `agent --output-format stream-json`.
 *
 * Maps the Cursor CLI's on-the-wire envelope (verified against
 * `agent 2026.05.05` on 2026-05-12) to our internal `ExploreFastEvent` shape:
 *
 *   { type: "system",  apiKeySource, ... }      → skipped (boot metadata)
 *   { type: "init",    ... }                    → skipped (alias of system)
 *   { type: "user",    message: { content: … }} → skipped (prompt echo / tool results)
 *   { type: "assistant", message: { content: [
 *       { type: "text",     text: "…" },        → assistant_text
 *       { type: "tool_use", name: "…", input },  → tool_call
 *   ] }}
 *   { type: "result",  result: "…", is_error? } → done | error
 *
 * Returns an array so a single `assistant` line with mixed content yields
 * multiple typed events in order. Unknown top-level or content `type`s are
 * dropped, not thrown — forward-compatible with new event types Cursor adds.
 */
function parseEvent(line: string): readonly ExploreFastEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "assistant":
      return parseAssistantEvent(raw);
    case "result":
      return parseResultEvent(raw);
    case "system":
    case "init":
    case "user":
      // Boot metadata, prompt echo, and tool-result envelopes carry no caller-
      // visible content for our use case. Tool calls surface via the assistant
      // event's `tool_use` content items above.
      return [];
    default:
      return [];
  }
}

function parseAssistantEvent(raw: Record<string, unknown>): readonly ExploreFastEvent[] {
  const message = raw.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const events: ExploreFastEvent[] = [];
  let textBuffer = "";
  const flushText = () => {
    if (textBuffer.length > 0) {
      events.push({ type: "assistant_text", text: textBuffer });
      textBuffer = "";
    }
  };

  for (const item of content) {
    if (!isRecord(item)) continue;
    const itemType = item.type;
    if (itemType === "text" && typeof item.text === "string") {
      textBuffer += item.text;
    } else if (itemType === "tool_use" && typeof item.name === "string") {
      flushText();
      const event: ExploreFastEvent = { type: "tool_call", name: item.name };
      if ("input" in item) event.input = item.input;
      events.push(event);
    }
  }
  flushText();
  return events;
}

function parseResultEvent(raw: Record<string, unknown>): readonly ExploreFastEvent[] {
  const isError =
    raw.is_error === true ||
    (typeof raw.subtype === "string" && raw.subtype.startsWith("error"));

  if (isError) {
    const message =
      typeof raw.error === "string"
        ? raw.error
        : typeof raw.message === "string"
          ? raw.message
          : typeof raw.result === "string"
            ? raw.result
            : "Cursor CLI emitted an error result";
    return [{ type: "error", kind: "cli", message }];
  }

  const result = raw.result;
  return typeof result === "string" ? [{ type: "done", result }] : [{ type: "done" }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated - ${text.length - limit} chars omitted]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
