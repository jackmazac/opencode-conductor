/**
 * `workspace_info` — workspace_id, branch, HEAD, dirty-file summary, recent commits.
 *
 * Grounding tool for session-start context. Returns the metadata an orchestrator
 * needs to answer "what state is this workspace in right now?" without spawning
 * a sequence of bash calls. Read-only — never modifies anything.
 *
 * Uses typed argv to `git` (matching the pattern in `commit.ts`). Falls back
 * gracefully when not in a git workspace.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

export type WorkspaceInfoSpawnInput = {
  cmd: readonly string[];
  cwd: string;
};

export type WorkspaceInfoSubprocess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

export type WorkspaceInfoSpawnFn = (
  input: WorkspaceInfoSpawnInput,
) => WorkspaceInfoSubprocess;

let spawnOverride: WorkspaceInfoSpawnFn | undefined;

export function __test_setWorkspaceInfoSpawn(fn: WorkspaceInfoSpawnFn | undefined): void {
  spawnOverride = fn;
}

function defaultSpawn(input: WorkspaceInfoSpawnInput): WorkspaceInfoSubprocess {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  return { stdout: proc.stdout, exited: proc.exited };
}

function runGit(input: WorkspaceInfoSpawnInput): WorkspaceInfoSubprocess {
  return (spawnOverride ?? defaultSpawn)(input);
}

type WorkspaceInfo = {
  workspace_id: string;
  workspace_root: string;
  git:
    | { available: false }
    | {
        available: true;
        head: string | null;
        branch: string | null;
        dirty_count: number;
        dirty_sample: string[];
        recent_commits: Array<{ sha: string; subject: string }>;
      };
};

const RECENT_COMMITS_DEFAULT = 5;
const RECENT_COMMITS_MAX = 25;
const DIRTY_SAMPLE_LIMIT = 10;

export const workspaceInfo = tool({
  description:
    "Return workspace metadata: workspace_id (sha256 of the workspace root path, matches the value run records use), workspace_root, git HEAD SHA, current branch, count + sample of dirty files, and the last N commit subjects. Read-only. Gracefully reports `git.available: false` when not in a git workspace. Use at session start to ground context, or whenever the orchestrator wants to know 'what state is this workspace in right now?'",
  args: {
    recent_commits: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Number of recent commits to include. Default ${RECENT_COMMITS_DEFAULT}, max ${RECENT_COMMITS_MAX}.`,
      ),
  },
  async execute(args, context) {
    const cwd = context.directory;
    const recentLimit = Math.min(
      Math.max(1, Math.floor(args.recent_commits ?? RECENT_COMMITS_DEFAULT)),
      RECENT_COMMITS_MAX,
    );

    const workspaceRoot = path.resolve(cwd);
    const wsId = `ws_${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16)}`;

    const head = await readGitOutput(cwd, ["git", "rev-parse", "HEAD"]);
    if (head === null) {
      const result: WorkspaceInfo = {
        workspace_id: wsId,
        workspace_root: workspaceRoot,
        git: { available: false },
      };
      return JSON.stringify(result, null, 2);
    }

    const branch = await readGitOutput(cwd, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    const dirtyRaw = await readGitOutput(cwd, ["git", "status", "--porcelain"]);
    const dirtyLines =
      dirtyRaw === null
        ? []
        : dirtyRaw.split("\n").filter((line) => line.trim().length > 0);
    const recentRaw = await readGitOutput(cwd, [
      "git",
      "log",
      "--oneline",
      `-${recentLimit}`,
    ]);
    const recent_commits =
      recentRaw === null
        ? []
        : recentRaw
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const space = line.indexOf(" ");
              return space < 0
                ? { sha: line, subject: "" }
                : { sha: line.slice(0, space), subject: line.slice(space + 1) };
            });

    const result: WorkspaceInfo = {
      workspace_id: wsId,
      workspace_root: workspaceRoot,
      git: {
        available: true,
        head,
        branch: branch === null || branch === "HEAD" ? null : branch,
        dirty_count: dirtyLines.length,
        dirty_sample: dirtyLines.slice(0, DIRTY_SAMPLE_LIMIT),
        recent_commits,
      },
    };
    return JSON.stringify(result, null, 2);
  },
});

async function readGitOutput(cwd: string, argv: readonly string[]): Promise<string | null> {
  try {
    const proc = runGit({ cmd: argv, cwd });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}
