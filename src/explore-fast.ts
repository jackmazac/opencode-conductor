/**
 * Conductor owns agent-directed LLM exploration (Cursor CLI backed).
 * Codemem owns deterministic code-graph / drift / impact truth.
 *
 * Historical: `explore_fast` was a Conductor plugin tool; removed — use Task `explore` / local read tools instead.
 * (prompts, cues, model-reasoned narration) rather than deterministic
 * graph traversal. If you need file-dependency, impact-cone, API-surface,
 * layer-boundary, or change-risk analysis, use the codemem_* tools.
 */
import path from "node:path"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 12_000
const DEFAULT_MAX_ERROR_CHARS = 2_000

export type ExploreFastCommandInput = {
  directory: string
  query: string
  path?: string
  timeoutMs?: number
  systemPrompt?: string
}

export type ExploreFastCommand = {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  prompt: string
}

export type ExploreFastProcessRequest = {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
}

export type ExploreFastProcessResult = {
  exitCode: number | undefined
  stdout: string
  stderr: string
  timedOut?: boolean
}

export type ExploreFastProcessRunner = (request: ExploreFastProcessRequest) => Promise<ExploreFastProcessResult>

export type RunExploreFastInput = ExploreFastCommandInput & {
  maxOutputChars?: number
  maxErrorChars?: number
  runner?: ExploreFastProcessRunner
}

export function buildExploreFastCommand(input: ExploreFastCommandInput): ExploreFastCommand {
  const prompt = buildPrompt(input)
  return {
    executable: "agent",
    args: [
      "-p",
      "--model",
      "composer-2-fast",
      "--mode",
      "ask",
      "--output-format",
      "json",
      "--workspace",
      input.directory,
      prompt,
    ],
    cwd: input.directory,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    prompt,
  }
}

export async function runExploreFast(input: RunExploreFastInput): Promise<string> {
  const query = input.query.trim()
  if (!query) return "explore-fast query is required"

  const targetPath = resolveTargetPath(input.directory, input.path)
  if (targetPath === false) return "explore-fast path must stay inside workspace"

  const runner = input.runner ?? runCursorProcess
  const systemPrompt = input.systemPrompt ?? (await loadExplorePrompt())
  const command = buildExploreFastCommand({
    directory: input.directory,
    query,
    path: targetPath,
    timeoutMs: input.timeoutMs,
    systemPrompt,
  })

  let result: ExploreFastProcessResult
  try {
    result = await runner({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
    })
  } catch (error) {
    return `Cursor CLI failed to start: ${cap(errorMessage(error), input.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS)}`
  }

  if (result.timedOut) {
    return `Cursor CLI timed out after ${command.timeoutMs}ms`
  }

  if (result.exitCode !== 0) {
    const stderr = cap(result.stderr || result.stdout || "(no stderr)", input.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS)
    return `Cursor CLI failed with exit code ${result.exitCode ?? "unknown"}\n\n${stderr}`
  }

  const parsed = parseCursorOutput(result.stdout)
  if (!parsed.ok) {
    const sample = cap(result.stdout, input.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS)
    return `Cursor CLI returned malformed JSON: ${parsed.message}\n\n${sample}`
  }

  return cap(parsed.text, input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)
}

async function loadExplorePrompt() {
  return Bun.file(path.join(import.meta.dir, "..", "prompts", "explore.txt")).text()
}

function buildPrompt(input: ExploreFastCommandInput) {
  const parts = [
    input.systemPrompt?.trim(),
    "# Exploration request",
    "",
    input.query.trim(),
    "",
    "# Workspace",
    input.directory,
  ].filter((part) => part !== undefined && part.length > 0)

  if (input.path) {
    parts.push("", "# Target path", input.path)
  }

  return parts.join("\n")
}

function resolveTargetPath(directory: string, targetPath: string | undefined) {
  if (targetPath === undefined || targetPath.trim() === "") return undefined

  const root = path.resolve(directory)
  const candidate = path.resolve(root, targetPath)
  const relative = path.relative(root, candidate)
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return candidate
  return false
}

async function runCursorProcess(request: ExploreFastProcessRequest): Promise<ExploreFastProcessResult> {
  const proc = Bun.spawn([request.executable, ...request.args], {
    cwd: request.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => {
      proc.kill()
      resolve("timeout")
    }, request.timeoutMs)
  })

  const exit = await Promise.race([proc.exited, timeoutResult])
  if (timeout) clearTimeout(timeout)

  return {
    exitCode: exit === "timeout" ? undefined : exit,
    stdout: await stdout,
    stderr: await stderr,
    timedOut: exit === "timeout",
  }
}

type ParsedCursorOutput =
  | {
      ok: true
      text: string
    }
  | {
      ok: false
      message: string
    }

function parseCursorOutput(stdout: string): ParsedCursorOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }

  const text = extractText(parsed)
  if (text === undefined) return { ok: false, message: "missing string result field" }
  return { ok: true, text }
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined

  const directResult = Reflect.get(value, "result")
  if (typeof directResult === "string") return directResult

  const directMessage = Reflect.get(value, "message")
  if (typeof directMessage === "string") return directMessage

  const directOutput = Reflect.get(value, "output")
  if (typeof directOutput === "string") return directOutput

  if (typeof directResult === "object" && directResult !== null) {
    const nestedText = Reflect.get(directResult, "text")
    if (typeof nestedText === "string") return nestedText
  }

  return undefined
}

function cap(text: string, limit: number) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n[truncated - ${text.length - limit} chars omitted]`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
