/**
 * `commit` — git commit with the Conductor commit convention enforced.
 *
 * The orchestrator's commit discipline (per `prompts/orchestrator.txt:272-279`)
 * requires:
 *   - Deterministic semantic message: `<type>(<scope>): <imperative outcome>`
 *   - `type` in {feat, fix, refactor, test, docs, chore}
 *   - Stage only changed files (never `git add .`)
 *   - One commit per concern
 *   - No --amend / --no-verify / --no-edit
 *
 * Before this tool, that convention lived only in prose and was enforced by
 * orchestrator self-discipline. This tool moves the convention into the tool
 * boundary: argv is typed, dangerous flags are unreachable, and the orchestrator
 * gets back the SHA in one call instead of running git through Bash 5+ times
 * per wave.
 *
 * Security model: we NEVER construct shell strings. All git subcommands are
 * passed to `Bun.spawn` as an array of literal-typed args. The git binary
 * receives `add`, `commit`, `rev-parse` as the *first* arg only — never a
 * caller-controlled value. Path validation rejects shell metacharacters and
 * path-traversal even though we don't use shell interpolation, as defense in
 * depth.
 */

import path from "node:path";
import { tool } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// Spawn test seam (same pattern as explore-fast.ts)
// ---------------------------------------------------------------------------

export type CommitSpawnInput = {
  cmd: readonly string[];
  cwd: string;
};

export type CommitSubprocess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

export type CommitSpawnFn = (input: CommitSpawnInput) => CommitSubprocess;

let commitSpawnOverride: CommitSpawnFn | undefined;

export function __test_setCommitSpawn(fn: CommitSpawnFn | undefined): void {
  commitSpawnOverride = fn;
}

function defaultCommitSpawn(input: CommitSpawnInput): CommitSubprocess {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
  };
}

function spawnGit(input: CommitSpawnInput): CommitSubprocess {
  const impl = commitSpawnOverride ?? defaultCommitSpawn;
  return impl(input);
}

const COMMIT_TYPES = ["feat", "fix", "refactor", "test", "docs", "chore"] as const;
type CommitType = (typeof COMMIT_TYPES)[number];

const FORBIDDEN_PATH_CHARS = /[;&|`$()<>\n\r\0]/;

export const commit = tool({
  description:
    "Create a git commit with the Conductor semantic convention enforced (`<type>(<scope>): <outcome>`). Stages the named paths (rejects '.' or empty paths to prevent the documented anti-pattern), commits with the formatted message, and returns the new commit SHA. Use after each wave completes and validation passes, before `progress_update`. The tool refuses dangerous flags by construction — pass only the fields below.",
  args: {
    type: tool.schema
      .enum([...COMMIT_TYPES])
      .describe(
        "Commit type: feat (new behavior), fix (bug fix), refactor (behavior-preserving), test, docs, chore (config/tooling).",
      ),
    scope: tool.schema
      .string()
      .describe(
        "Primary repo/package/domain touched (e.g. 'conductor', 'api', 'plan-artifacts'). Not the plan slug.",
      ),
    outcome: tool.schema
      .string()
      .describe(
        "Imperative outcome statement that makes sense to a developer who hasn't read the plan. No initiative names, plan slugs, or wave numbers.",
      ),
    paths: tool.schema
      .array(tool.schema.string())
      .describe(
        "Workspace-relative files to stage. Must be non-empty and must not include '.' or any path traversal. Pass exact paths only.",
      ),
    body: tool.schema
      .string()
      .optional()
      .describe(
        "Optional commit body (passed as a second -m to git). Use for longer explanation when the subject alone is insufficient.",
      ),
  },
  async execute(args, context) {
    validatePaths(args.paths);
    validateScope(args.scope);
    validateOutcome(args.outcome);
    const subject = `${args.type}(${args.scope}): ${args.outcome}`;
    const cwd = context.directory;
    await stagePaths(cwd, args.paths);
    await runGitCommit(cwd, subject, args.body);
    const sha = await readHead(cwd);
    return JSON.stringify(
      {
        sha,
        subject,
        files: args.paths,
      },
      null,
      2,
    );
  },
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePaths(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new Error("commit: paths must be non-empty (Conductor convention forbids 'git add .')");
  }
  for (const p of paths) {
    if (p === "" || p === "." || p === "/") {
      throw new Error(`commit: refusing path "${p}" — pass exact workspace-relative paths only`);
    }
    if (p.startsWith("-")) {
      throw new Error(`commit: refusing path "${p}" — paths must not start with '-' (flag injection guard)`);
    }
    if (p.startsWith("/")) {
      throw new Error(`commit: refusing absolute path "${p}" — paths must be workspace-relative`);
    }
    if (FORBIDDEN_PATH_CHARS.test(p)) {
      throw new Error(`commit: refusing path "${p}" — contains forbidden shell-metacharacter`);
    }
    // Path traversal guard: reject any segment that is `..` after normalization.
    const segments = p.split(path.sep).filter(Boolean);
    if (segments.some((s) => s === "..")) {
      throw new Error(`commit: refusing path "${p}" — must stay inside workspace (no '..')`);
    }
  }
}

function validateScope(scope: string): void {
  if (scope.length === 0 || scope.length > 64) {
    throw new Error(`commit: scope length must be 1-64 chars (got ${scope.length})`);
  }
  if (/[():\n\r]/.test(scope)) {
    throw new Error(`commit: scope must not contain '(', ')', ':', or newlines (got "${scope}")`);
  }
}

function validateOutcome(outcome: string): void {
  if (outcome.length === 0) {
    throw new Error("commit: outcome must be non-empty");
  }
  if (outcome.length > 200) {
    throw new Error(`commit: outcome subject too long (${outcome.length} chars, max 200)`);
  }
  if (/[\n\r]/.test(outcome)) {
    throw new Error("commit: outcome must be a single line (use the optional body for multi-line)");
  }
}

// ---------------------------------------------------------------------------
// Git invocations (typed argv only — never shell strings)
// ---------------------------------------------------------------------------

async function stagePaths(cwd: string, paths: readonly string[]): Promise<void> {
  const argv = ["git", "add", "--", ...paths];
  const proc = spawnGit({ cmd: argv, cwd });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`commit: \`git add\` failed (exit ${exitCode})\n${stderr.trim()}`);
  }
}

async function runGitCommit(cwd: string, subject: string, body: string | undefined): Promise<void> {
  const argv = ["git", "commit", "-m", subject];
  if (body && body.length > 0) {
    argv.push("-m", body);
  }
  const proc = spawnGit({ cmd: argv, cwd });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `commit: \`git commit\` failed (exit ${exitCode})\n${(stderr || stdout).trim()}`,
    );
  }
}

async function readHead(cwd: string): Promise<string> {
  const proc = spawnGit({ cmd: ["git", "rev-parse", "HEAD"], cwd });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("commit: failed to read HEAD after commit (was the commit actually created?)");
  }
  return stdout.trim();
}
