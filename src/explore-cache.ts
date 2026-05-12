/**
 * Content-addressed cache for `explore-fast` results.
 *
 * Why this exists: an orchestrator that fans out parallel exploration waves
 * frequently re-asks similar questions across waves and across sessions on
 * the same codebase. The Cursor CLI is free (per `agent login`), but it's
 * slow — a real exhaustive explore takes 15-30s. Caching by content hash
 * means the second identical query returns in milliseconds with zero CLI
 * cost.
 *
 * Cache directory: `.opencode/explore-cache/<key>.json`, gitignored.
 *
 * Invalidation strategy (in the hash key):
 *   - Query, target path, thoroughness, model, workspace: change → new key.
 *   - System prompt content: if `prompts/explore.txt` changes, every cached
 *     entry becomes stale because the agent is now operating under different
 *     instructions.
 *   - Git HEAD: every commit invalidates the cache. This is the natural
 *     reset point for "the code I'm exploring has changed."
 *   - Cursor CLI version: bumping the binary may change output format or
 *     behavior; we hash `agent --version` once per process.
 *
 * Deliberately NOT in the key:
 *   - Uncommitted working-tree changes. Including them gives correctness on
 *     edit-then-query loops but kills hit rate (any edit anywhere clears
 *     everything). The `cache: false` escape hatch covers this case.
 *   - Wall-clock TTL. Redundant given git-HEAD invalidation.
 *   - Cursor server-side model version. We can't observe it.
 *
 * Process-local concurrency dedup: two simultaneous calls with the same key
 * share a single CLI invocation via the in-memory `inflight` map.
 */

import { mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { CursorModel, ExploreFastThoroughness } from "./cursor-cli-types";

const SCHEMA_VERSION = 1;
const HASH_LENGTH = 12; // 48 bits — birthday collision at 100k entries is ~1.8e-5
const CACHE_DIRNAME = path.join(".opencode", "explore-cache");

export type CacheKeyInput = {
  /** Trimmed query — must be the same value passed to the CLI. */
  query: string;
  /** Canonicalized absolute path, or `null` if no target path. */
  targetPath: string | null;
  /** Post-default-expansion: never `undefined`. */
  thoroughness: ExploreFastThoroughness;
  /** Post-default-expansion: never `undefined`. */
  model: CursorModel;
  /** Canonicalized absolute workspace root. */
  workspace: string;
  /** Full system-prompt content. Hashed internally. */
  systemPrompt: string;
};

export type CachedEntry = {
  schema_version: number;
  created_at: string;
  key: string;
  content: string;
};

// --- Public API ------------------------------------------------------------

/**
 * Stable hash of all inputs that determine the CLI's output. 12 hex chars
 * (48 bits). Includes git HEAD and agent CLI version as side-effect reads,
 * both of which gracefully degrade to `null` when unavailable.
 */
export async function computeCacheKey(input: CacheKeyInput): Promise<string> {
  const payload = {
    schema_version: SCHEMA_VERSION,
    query: input.query,
    target_path: input.targetPath,
    thoroughness: input.thoroughness,
    model: input.model,
    workspace: input.workspace,
    prompt_hash: sha256(input.systemPrompt).slice(0, 16),
    git_head: await readGitHead(input.workspace),
    agent_version: await readAgentVersion(),
  };
  return sha256(JSON.stringify(payload)).slice(0, HASH_LENGTH);
}

/**
 * Read a cached entry. Returns the content string if the file exists, parses
 * cleanly, and has a matching schema version. Returns `null` for misses,
 * corrupt files, and schema mismatches (all treated identically — the caller
 * will re-fetch and overwrite).
 */
export async function readCache(workspace: string, key: string): Promise<string | null> {
  try {
    const file = Bun.file(cacheFilePath(workspace, key));
    if (!(await file.exists())) return null;
    const raw: unknown = await file.json();
    if (!isCachedEntry(raw)) return null;
    if (raw.schema_version !== SCHEMA_VERSION) return null;
    return raw.content;
  } catch {
    return null;
  }
}

/**
 * Atomically write a cached entry. Writes to `<file>.tmp` first, then
 * renames into place — guarantees readers never see a half-written file.
 * Failures are returned, not thrown, so cache write errors don't poison the
 * caller's result.
 */
export async function writeCache(
  workspace: string,
  key: string,
  content: string,
): Promise<void> {
  const file = cacheFilePath(workspace, key);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const entry: CachedEntry = {
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    key,
    content,
  };
  await Bun.write(tmp, JSON.stringify(entry, null, 2));
  await rename(tmp, file);
}

/**
 * In-process dedup for concurrent identical queries. Two parallel
 * `runExploreFast` calls with the same cache key share one Cursor CLI
 * invocation. Entries are removed once the underlying promise settles.
 */
const inflight = new Map<string, Promise<string>>();

export function getInflight(key: string): Promise<string> | undefined {
  return inflight.get(key);
}

export function setInflight(key: string, promise: Promise<string>): void {
  inflight.set(key, promise);
  promise.finally(() => {
    // Only clear if we're still the registered promise — guards against
    // a stale clear racing a fresh inflight insertion under the same key.
    if (inflight.get(key) === promise) inflight.delete(key);
  });
}

/**
 * Remove all cached entries under the workspace. Returns the count of
 * entries cleared. Best-effort: returns 0 if the cache directory does not
 * exist or is unreadable.
 */
export async function discardCache(workspace: string): Promise<number> {
  const dir = path.join(workspace, CACHE_DIRNAME);
  try {
    const entries = await Bun.$`ls -1 ${dir}`.quiet().text();
    const lines = entries.split("\n").filter((line) => line.endsWith(".json"));
    for (const line of lines) {
      await Bun.$`rm ${path.join(dir, line)}`.quiet().nothrow();
    }
    return lines.length;
  } catch {
    return 0;
  }
}

export function cacheDir(workspace: string): string {
  return path.join(workspace, CACHE_DIRNAME);
}

// --- Test seams ------------------------------------------------------------

/**
 * Tests inject deterministic `git_head` / `agent_version` values via this
 * setter to avoid spawning real git / agent processes during unit tests.
 * Pattern matches `__test_setEngramDispatch` in `conflict-context.ts`.
 */
export type CacheTestDeps = {
  readGitHead?: (workspace: string) => Promise<string | null>;
  readAgentVersion?: () => Promise<string | null>;
};

let testDeps: CacheTestDeps = {};

export function __test_setCacheDeps(deps: CacheTestDeps): void {
  testDeps = deps;
}

export function __test_clearCacheDeps(): void {
  testDeps = {};
  agentVersionMemo = undefined;
  inflight.clear();
}

// --- Internals -------------------------------------------------------------

function cacheFilePath(workspace: string, key: string): string {
  return path.join(workspace, CACHE_DIRNAME, `${key}.json`);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.schema_version === "number" &&
    typeof value.created_at === "string" &&
    typeof value.key === "string" &&
    typeof value.content === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readGitHead(workspace: string): Promise<string | null> {
  if (testDeps.readGitHead) return testDeps.readGitHead(workspace);
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return out.trim() || null;
  } catch {
    return null;
  }
}

let agentVersionMemo: Promise<string | null> | undefined;
async function readAgentVersion(): Promise<string | null> {
  if (testDeps.readAgentVersion) return testDeps.readAgentVersion();
  if (agentVersionMemo === undefined) {
    agentVersionMemo = (async () => {
      try {
        const proc = Bun.spawn(["agent", "--version"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) return null;
        return out.trim() || null;
      } catch {
        return null;
      }
    })();
  }
  return agentVersionMemo;
}
