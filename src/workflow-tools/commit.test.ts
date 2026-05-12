import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";

import {
  __test_setCommitSpawn,
  commit,
  type CommitSpawnFn,
  type CommitSpawnInput,
  type CommitSubprocess,
} from "./commit";

const encoder = new TextEncoder();

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text.length > 0) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function toolContext(directory: string) {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      return Effect.void;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "output" in result) {
    const out = Reflect.get(result, "output");
    if (typeof out === "string") return out;
  }
  throw new Error(`unexpected tool result shape: ${typeof result}`);
}

function fakeSpawn(calls: CommitSpawnInput[], headSha: string): CommitSpawnFn {
  return (input) => {
    calls.push(input);
    const cmd = input.cmd;
    const sub = cmd[1];
    let stdout = "";
    const exit = 0;
    if (sub === "add") {
      stdout = "";
    } else if (sub === "commit") {
      stdout = "";
    } else if (sub === "rev-parse") {
      stdout = `${headSha}\n`;
    }
    const proc: CommitSubprocess = {
      stdout: streamFromText(stdout),
      stderr: emptyStream(),
      exited: Promise.resolve(exit),
    };
    return proc;
  };
}

afterEach(() => {
  __test_setCommitSpawn(undefined);
});

describe("commit tool", () => {
  test("rejects empty paths", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: [] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/paths must be non-empty/);
  });

  test("rejects paths: [\".\"]", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: ["."] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/refusing path/);
  });

  test("rejects absolute paths", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: ["/etc/passwd"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/absolute path/);
  });

  test("rejects paths starting with -", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: ["--help"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/flag injection/);
  });

  test("rejects path traversal segments", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: ["../outside"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/\.\./);
  });

  test.each([
    ["semi", "a;b"],
    ["amp", "a&b"],
    ["pipe", "a|b"],
    ["backtick", "a`b"],
    ["dollar-paren", "a$(b)"],
    ["lt", "a<b"],
    ["gt", "a>b"],
    ["newline", "a\nb"],
  ])("rejects shell metacharacters (%s)", async (_label, badPath) => {
    await expect(
      commit.execute(
        { type: "feat", scope: "x", outcome: "y", paths: [badPath] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/forbidden shell-metacharacter/);
  });

  test("rejects empty scope", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "", outcome: "y", paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/scope length/);
  });

  test("rejects scope longer than 64 chars", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "a".repeat(65), outcome: "y", paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/scope length/);
  });

  test("rejects scope with forbidden punctuation", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "bad:scope", outcome: "y", paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/scope must not contain/);
  });

  test("rejects empty outcome", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "s", outcome: "", paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/outcome must be non-empty/);
  });

  test("rejects outcome longer than 200 chars", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "s", outcome: "o".repeat(201), paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/outcome subject too long/);
  });

  test("rejects outcome with newlines", async () => {
    await expect(
      commit.execute(
        { type: "feat", scope: "s", outcome: "one\ntwo", paths: ["a.ts"] },
        toolContext("/tmp"),
      ),
    ).rejects.toThrow(/single line/);
  });

  test("builds subject and passes argv to git (add, commit with two -m, rev-parse)", async () => {
    const calls: CommitSpawnInput[] = [];
    __test_setCommitSpawn(fakeSpawn(calls, "abc123deadbeefabc123deadbeefabc123dead"));
    const root = await mkdtemp(path.join(tmpdir(), "conductor-commit-"));
    try {
      const out = toolResultText(
        await commit.execute(
          {
            type: "fix",
            scope: "run",
            outcome: "repair flaky test",
            paths: ["src/a.ts", "src/b.ts"],
            body: "Details line one.\nLine two.",
          },
          toolContext(root),
        ),
      );
      const parsed: unknown = JSON.parse(out);
      if (!isRecord(parsed)) throw new Error("expected object");
      if (typeof parsed.sha !== "string") throw new Error("expected sha string");
      if (typeof parsed.subject !== "string") throw new Error("expected subject string");
      if (!Array.isArray(parsed.files)) throw new Error("expected files array");
      expect(parsed.sha).toBe("abc123deadbeefabc123deadbeefabc123dead");
      expect(parsed.subject).toBe("fix(run): repair flaky test");
      expect(parsed.files).toEqual(["src/a.ts", "src/b.ts"]);

      expect(calls.map((c) => c.cmd)).toEqual([
        ["git", "add", "--", "src/a.ts", "src/b.ts"],
        ["git", "commit", "-m", "fix(run): repair flaky test", "-m", "Details line one.\nLine two."],
        ["git", "rev-parse", "HEAD"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commit without body uses single -m", async () => {
    const calls: CommitSpawnInput[] = [];
    __test_setCommitSpawn(fakeSpawn(calls, "aaa"));
    const root = await mkdtemp(path.join(tmpdir(), "conductor-commit-"));
    try {
      await commit.execute(
        { type: "docs", scope: "agents", outcome: "note conventions", paths: ["AGENTS.md"] },
        toolContext(root),
      );
      expect(calls[1]?.cmd).toEqual([
        "git",
        "commit",
        "-m",
        "docs(agents): note conventions",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("commit tool — git integration", () => {
  test.skipIf(!process.env.CONDUCTOR_GIT_INTEGRATION)(
    "creates a real commit and returns a 40-char sha",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "conductor-commit-git-"));
      try {
        async function git(args: string[]): Promise<void> {
          const proc = Bun.spawn(["git", ...args], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          });
          const code = await proc.exited;
          const err = await new Response(proc.stderr).text();
          if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
        }
        await git(["init"]);
        await git(["config", "user.email", "conductor-test@example.com"]);
        await git(["config", "user.name", "Conductor Test"]);
        const f = path.join(root, "tracked.txt");
        await Bun.write(f, "hello\n");
        const relPath = "tracked.txt";

        const out = toolResultText(
          await commit.execute(
            {
              type: "feat",
              scope: "test",
              outcome: "add tracked file",
              paths: [relPath],
            },
            toolContext(root),
          ),
        );
        const parsed: unknown = JSON.parse(out);
        if (!isRecord(parsed)) throw new Error("expected object");
        if (typeof parsed.sha !== "string") throw new Error("expected sha string");
        if (typeof parsed.subject !== "string") throw new Error("expected subject string");
        if (!Array.isArray(parsed.files)) throw new Error("expected files array");
        expect(parsed.sha).toMatch(/^[a-f0-9]{40}$/);
        expect(parsed.subject).toBe("feat(test): add tracked file");
        expect(parsed.files).toEqual([relPath]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
