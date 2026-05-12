import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __test_clearCacheDeps,
  __test_setCacheDeps,
  cacheDir,
  computeCacheKey,
  discardCache,
  getInflight,
  readCache,
  setInflight,
  writeCache,
  type CacheKeyInput,
} from "./explore-cache";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "explore-cache-test-"));
  __test_setCacheDeps({
    readGitHead: async () => "test-head-0000000",
    readAgentVersion: async () => "agent-test-0.0.0",
  });
});

afterEach(async () => {
  __test_clearCacheDeps();
  await rm(workspace, { recursive: true, force: true });
});

const baseInput: CacheKeyInput = {
  query: "find auth flow",
  targetPath: null,
  thoroughness: "standard",
  model: "composer-2-fast",
  workspace: "/tmp/project",
  systemPrompt: "you are a search agent",
};

// ---------------------------------------------------------------------------
// Cache key composition
// ---------------------------------------------------------------------------

describe("computeCacheKey", () => {
  test("is stable across identical inputs", async () => {
    const a = await computeCacheKey(baseInput);
    const b = await computeCacheKey(baseInput);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  test("changes when any keyed input changes", async () => {
    const base = await computeCacheKey(baseInput);
    expect(await computeCacheKey({ ...baseInput, query: "different" })).not.toBe(base);
    expect(await computeCacheKey({ ...baseInput, targetPath: "/tmp/project/src" })).not.toBe(base);
    expect(await computeCacheKey({ ...baseInput, thoroughness: "exhaustive" })).not.toBe(base);
    expect(await computeCacheKey({ ...baseInput, model: "composer-2" })).not.toBe(base);
    expect(await computeCacheKey({ ...baseInput, workspace: "/tmp/other" })).not.toBe(base);
    expect(await computeCacheKey({ ...baseInput, systemPrompt: "different prompt" })).not.toBe(
      base,
    );
  });

  test("changes when git HEAD changes", async () => {
    const headA = await computeCacheKey(baseInput);

    __test_setCacheDeps({
      readGitHead: async () => "different-head-1111111",
      readAgentVersion: async () => "agent-test-0.0.0",
    });
    const headB = await computeCacheKey(baseInput);

    expect(headA).not.toBe(headB);
  });

  test("changes when agent CLI version changes", async () => {
    const verA = await computeCacheKey(baseInput);

    __test_setCacheDeps({
      readGitHead: async () => "test-head-0000000",
      readAgentVersion: async () => "agent-test-9.9.9",
    });
    const verB = await computeCacheKey(baseInput);

    expect(verA).not.toBe(verB);
  });

  test("tolerates missing git HEAD (non-git workspace)", async () => {
    __test_setCacheDeps({
      readGitHead: async () => null,
      readAgentVersion: async () => "agent-test-0.0.0",
    });
    const key = await computeCacheKey(baseInput);
    expect(key).toHaveLength(12);
  });

  test("tolerates missing agent version (agent CLI not installed)", async () => {
    __test_setCacheDeps({
      readGitHead: async () => "test-head-0000000",
      readAgentVersion: async () => null,
    });
    const key = await computeCacheKey(baseInput);
    expect(key).toHaveLength(12);
  });

  test("hashes the full system prompt content (not just a reference)", async () => {
    // Two prompts with identical lengths but different content must hash differently.
    const a = await computeCacheKey({ ...baseInput, systemPrompt: "aaa".repeat(100) });
    const b = await computeCacheKey({ ...baseInput, systemPrompt: "bbb".repeat(100) });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

describe("readCache / writeCache", () => {
  test("round-trips a cached entry", async () => {
    await writeCache(workspace, "abc123def456", "## findings\n- foo");
    const read = await readCache(workspace, "abc123def456");
    expect(read).toBe("## findings\n- foo");
  });

  test("returns null on cache miss", async () => {
    const read = await readCache(workspace, "nonexistent0");
    expect(read).toBeNull();
  });

  test("returns null on corrupt JSON", async () => {
    const dir = cacheDir(workspace);
    await Bun.$`mkdir -p ${dir}`.quiet();
    await writeFile(path.join(dir, "corrupt00000.json"), "not valid json {{{");
    const read = await readCache(workspace, "corrupt00000");
    expect(read).toBeNull();
  });

  test("returns null on schema version mismatch", async () => {
    const dir = cacheDir(workspace);
    await Bun.$`mkdir -p ${dir}`.quiet();
    await writeFile(
      path.join(dir, "stale0000000.json"),
      JSON.stringify({
        schema_version: 999,
        created_at: "2026-01-01T00:00:00.000Z",
        key: "stale0000000",
        content: "would-be-stale",
      }),
    );
    const read = await readCache(workspace, "stale0000000");
    expect(read).toBeNull();
  });

  test("writes atomically — no intermediate file is left after a successful write", async () => {
    await writeCache(workspace, "atomic000000", "content");
    const dir = cacheDir(workspace);
    const entries = (await Bun.$`ls -1 ${dir}`.text()).split("\n").filter(Boolean);
    expect(entries).toEqual(["atomic000000.json"]);
  });

  test("creates the cache directory if missing", async () => {
    // workspace is fresh — no .opencode/explore-cache directory exists yet
    await writeCache(workspace, "fresh0000000", "content");
    const file = await readFile(
      path.join(workspace, ".opencode", "explore-cache", "fresh0000000.json"),
      "utf8",
    );
    expect(file).toContain("content");
  });
});

// ---------------------------------------------------------------------------
// discardCache
// ---------------------------------------------------------------------------

describe("discardCache", () => {
  test("removes all .json entries and reports the count", async () => {
    await writeCache(workspace, "aaaaaaaaaaaa", "a");
    await writeCache(workspace, "bbbbbbbbbbbb", "b");
    await writeCache(workspace, "cccccccccccc", "c");

    const cleared = await discardCache(workspace);
    expect(cleared).toBe(3);

    expect(await readCache(workspace, "aaaaaaaaaaaa")).toBeNull();
    expect(await readCache(workspace, "bbbbbbbbbbbb")).toBeNull();
    expect(await readCache(workspace, "cccccccccccc")).toBeNull();
  });

  test("returns 0 when the cache directory does not exist", async () => {
    // workspace is fresh, no cache dir
    const cleared = await discardCache(workspace);
    expect(cleared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Inflight dedup
// ---------------------------------------------------------------------------

describe("inflight dedup", () => {
  test("setInflight + getInflight returns the same promise for the same key", async () => {
    const promise = Promise.resolve("payload");
    setInflight("inflight0000", promise);
    expect(getInflight("inflight0000")).toBe(promise);
    await promise;
  });

  test("entry is removed after the promise settles", async () => {
    let resolveOuter: (value: string) => void = () => {};
    const promise = new Promise<string>((resolve) => {
      resolveOuter = resolve;
    });
    setInflight("settle000000", promise);
    expect(getInflight("settle000000")).toBe(promise);
    resolveOuter("done");
    await promise;
    // Allow microtask queue to drain
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflight("settle000000")).toBeUndefined();
  });

  test("entry is removed even when the promise rejects", async () => {
    const promise = Promise.reject(new Error("boom")).catch(() => "swallowed");
    setInflight("reject000000", promise);
    await promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflight("reject000000")).toBeUndefined();
  });
});
