/**
 * Conductor owns agent-directed LLM exploration (Cursor CLI backed).
 * Codemem owns deterministic code-graph / drift / impact truth.
 *
 * `explore-fast` is a typed wrapper around `agent -p --model composer-2-fast …`,
 * exposed as the `explore_fast` plugin tool registered in `src/index.ts`. It is
 * used for fast, model-reasoned exploration cues (prompts, narration) rather
 * than deterministic graph traversal. If you need file-dependency, impact-cone,
 * API-surface, layer-boundary, or change-risk analysis, use the codemem_* tools.
 *
 * Three public surfaces:
 *   - The `explore_fast` plugin tool — registered in `src/index.ts`, wraps
 *     `runExploreFast` with the OpenCode tool schema (`query`, `path?`,
 *     `thoroughness?`). This is what orchestrators call.
 *   - `runExploreFast` — drains the stream into `Promise<string>`. Internal
 *     library callers and the plugin tool both use this.
 *   - `streamExploreFast` — yields typed events as the CLI emits them, for
 *     internal callers that want incremental output. Not exposed via the
 *     plugin-tool schema.
 *
 * The library does not impose a per-call timeout. The CLI runs to completion
 * (success, CLI-emitted error, or non-zero exit). The OpenCode task harness
 * owns the outer wall-clock envelope. Callers that need a hard cap can break
 * out of `streamExploreFast` early — the async generator's `finally` aborts
 * the spawned `AbortController`, which Bun.spawn translates into SIGTERM.
 *
 * Pricing model: free with `agent login`. No new runtime dependencies.
 */

import path from "node:path";

import {
  toArgv,
  type CursorInvocation,
  type CursorModel,
  type ExploreFastEvent,
  type ExploreFastThoroughness,
} from "./cursor-cli-types";
import {
  computeCacheKey,
  getInflight,
  readCache,
  setInflight,
  writeCache,
} from "./explore-cache";

const DEFAULT_MAX_ERROR_CHARS = 2_000;
const DEFAULT_THOROUGHNESS: ExploreFastThoroughness = "standard";

/**
 * Default model per thoroughness tier. `exhaustive` upgrades to the deeper
 * `composer-2` model — the `explore-high` distinction from `orchestrator.txt`.
 *
 * The library does not impose a per-call timeout. The Cursor CLI runs to
 * completion (success, CLI-emitted error, or non-zero exit) and the OpenCode
 * task harness owns the outer wall-clock envelope. Callers that want a hard
 * cap can break out of `streamExploreFast` early — the async generator's
 * cleanup aborts the subprocess via SIGTERM (see the `finally` block).
 */
const THOROUGHNESS_MODELS: Record<ExploreFastThoroughness, CursorModel> = {
  quick: "composer-2-fast",
  standard: "composer-2-fast",
  exhaustive: "composer-2",
};

export type RunExploreFastInput = {
  directory: string;
  query: string;
  path?: string;
  /**
   * Thoroughness tier (`quick` / `standard` / `exhaustive`). Picks the default
   * model per `THOROUGHNESS_MODELS` and is written into the prompt so the
   * agent adapts its search depth. Explicit `model` overrides the tier
   * default. Defaults to `standard`.
   */
  thoroughness?: ExploreFastThoroughness;
  /**
   * Read and write the content-addressed cache at `.opencode/explore-cache/`.
   * Default `true`. Set `false` to force a fresh CLI call (escape hatch for
   * uncommitted-edit loops or known cache staleness). Cache key includes
   * query, target path, thoroughness, model, workspace, system prompt
   * content, git HEAD, and agent CLI version — see `explore-cache.ts`.
   *
   * Cache behavior only applies to `runExploreFast`. `streamExploreFast`
   * never consults the cache; callers using the streaming API are assumed
   * to want incremental output and bypass caching by definition.
   */
  cache?: boolean;
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
  const model = input.model ?? THOROUGHNESS_MODELS[thoroughness];
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

  let proc: ExploreFastSubprocess;
  try {
    proc = spawn({
      cmd: ["agent", ...toArgv(invocation)],
      cwd: input.directory,
      signal: controller.signal,
    });
  } catch (error) {
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

    if (exitCode !== 0) {
      const stderr = cap((await stderrPromise) || "(no stderr)", maxErrorChars);
      yield {
        type: "error",
        kind: "exit",
        message: `Cursor CLI failed with exit code ${exitCode}\n\n${stderr}`,
      };
    }
  } finally {
    // If the caller broke out of the stream early, the async generator's
    // .return() runs this finally — but the subprocess is still alive and
    // will block on stdout once the OS pipe buffer fills. Abort the signal
    // so Bun.spawn sends SIGTERM. No-op when the process already exited
    // cleanly.
    if (!controller.signal.aborted) controller.abort("disposed");
  }
}

/**
 * Drain `streamExploreFast` into a single string. Same `Promise<string>`
 * return shape as the pre-migration `runExploreFast` — legacy callers see no
 * API change. Output is not truncated; the orchestrator's task harness is
 * the right place to bound subagent return size.
 *
 * Cache behavior (when `input.cache !== false`, the default):
 *   1. Compute the content-hash cache key from post-default-expansion inputs.
 *   2. If the disk cache has a fresh entry, return it without spawning.
 *   3. If a concurrent in-process call is already running the same key, await
 *      its result (dedup) without spawning a second CLI process.
 *   4. Otherwise, run the stream and on successful completion, write the
 *      result to the cache. Errors are not cached — a transient CLI failure
 *      shouldn't poison subsequent retries.
 *
 * Resolution order for the drained result:
 *   1. First `error` event wins — returned verbatim (already bounded by the
 *      streamer's `maxErrorChars`).
 *   2. Otherwise, concatenated `assistant_text` chunks.
 *   3. Otherwise (no streamed text), the terminal `done.result`. Cursor's
 *      `result` event echoes the final answer; if we already captured it via
 *      `assistant_text` we drop the echo to avoid doubling the output.
 *   4. Empty string.
 */
export async function runExploreFast(input: RunExploreFastInput): Promise<string> {
  const useCache = input.cache !== false;

  // Cache lookup happens before validation so an invalid input doesn't burn
  // a cache key computation. validateInput is fast; we run it twice (here for
  // cache eligibility, and again inside streamExploreFast). Cheap.
  let cacheKey: string | undefined;
  if (useCache) {
    cacheKey = await tryComputeCacheKey(input);
    if (cacheKey !== undefined) {
      const cached = await readCache(input.directory, cacheKey);
      if (cached !== null) return cached;
      const concurrent = getInflight(cacheKey);
      if (concurrent !== undefined) return concurrent;
    }
  }

  const runPromise = drainStream(input);
  // Inflight dedup must expose the final string to peer callers — they don't
  // need the `hadError` flag since they don't make caching decisions.
  if (useCache && cacheKey !== undefined) {
    setInflight(
      cacheKey,
      runPromise.then((r) => r.content),
    );
  }

  const { content, hadError } = await runPromise;

  // Cache writes are best-effort. A disk failure here must not poison the
  // caller's result — they already have the content; the cache miss on the
  // next call is the only consequence.
  if (useCache && cacheKey !== undefined && !hadError && content.length > 0) {
    try {
      await writeCache(input.directory, cacheKey, content);
    } catch {
      // swallowed — see comment above
    }
  }

  return content;
}

async function drainStream(
  input: RunExploreFastInput,
): Promise<{ content: string; hadError: boolean }> {
  const chunks: string[] = [];
  let doneResult: string | undefined;
  let firstError: string | undefined;

  for await (const event of streamExploreFast(input)) {
    if (event.type === "assistant_text") {
      chunks.push(event.text);
    } else if (event.type === "done") {
      if (event.result !== undefined) doneResult = event.result;
    } else if (event.type === "error") {
      if (firstError === undefined) firstError = event.message;
    }
  }

  if (firstError !== undefined) return { content: firstError, hadError: true };
  if (chunks.length > 0) return { content: chunks.join(""), hadError: false };
  if (doneResult !== undefined) return { content: doneResult, hadError: false };
  return { content: "", hadError: false };
}

/**
 * Build the cache key from the same normalized inputs the streamer uses.
 * Returns `undefined` if the input fails validation — we never cache
 * malformed requests because their key inputs aren't meaningful (e.g., the
 * trimmed query is empty). Streamer still runs and surfaces the validation
 * error to the caller via its `error` event.
 */
async function tryComputeCacheKey(input: RunExploreFastInput): Promise<string | undefined> {
  const validation = validateInput(input);
  if (!validation.ok) return undefined;
  const thoroughness = input.thoroughness ?? DEFAULT_THOROUGHNESS;
  const model = input.model ?? THOROUGHNESS_MODELS[thoroughness];
  const systemPrompt = input.systemPrompt ?? (await loadExplorePrompt());
  return computeCacheKey({
    query: validation.query,
    targetPath: validation.targetPath ?? null,
    thoroughness,
    model,
    workspace: path.resolve(input.directory),
    systemPrompt,
  });
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
