/**
 * Shared formatting utilities for Conductor tool output.
 *
 * Replaces the previously-duplicated cap/rel/formatReadResult helpers in:
 *   - audit.ts, handoff.ts, journal.ts, status.ts, plan-artifacts.ts
 *
 * Read tools return human-readable strings (per the Phase 2 convention).
 * `formatReadResult` is the canonical envelope: a file pointer, an mtime,
 * an optional total length, then the content body. Keep the field order
 * stable — callers grep for "Last updated:" and similar.
 */

import path from "node:path";

/**
 * Soft-truncate `text` to `limit` characters. If truncation occurs, appends a
 * marker indicating the omitted count. Stable across the codebase — tests
 * assert on the exact suffix format `[truncated - N chars omitted]`.
 */
export function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated - ${text.length - limit} chars omitted]`;
}

/**
 * Workspace-relative path. Used in every "File: ..." output line to keep
 * absolute paths out of agent context.
 */
export function rel(directory: string, file: string): string {
  return path.relative(directory, file);
}

export type ReadResultEnvelope = {
  /** Workspace root, used to compute the relative file path. */
  directory: string;
  /** Absolute path of the artifact being read. */
  file: string;
  /** ISO 8601 mtime of the artifact. */
  mtime: string;
  /** Already-capped content body. */
  content: string;
  /** Optional total length (before any capping). Included in the header when present. */
  length?: number;
};

/**
 * Canonical "read artifact" output envelope. Output shape:
 *
 *   File: <relative path>
 *   Last updated: <mtime> (<length> chars)
 *   <blank line>
 *   <content>
 *
 * The `(<length> chars)` suffix only appears when `length` is provided —
 * section reads omit it because section extraction makes the total length
 * misleading.
 */
export function formatReadResult(input: ReadResultEnvelope): string {
  const relative = rel(input.directory, input.file);
  const sizeSuffix = input.length !== undefined ? ` (${input.length} chars)` : "";
  return `File: ${relative}\nLast updated: ${input.mtime}${sizeSuffix}\n\n${input.content}`;
}
