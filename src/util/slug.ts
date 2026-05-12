/**
 * Shared slug validation for all Conductor artifact stores.
 *
 * Slugs are the filename keys for plan, subplan, brainstorm, design, audit,
 * progress, audit-progress, and status artifacts. The regex enforces:
 *   - lowercase only
 *   - alphanumeric + hyphen + dot separators
 *   - no leading/trailing separators
 *   - 64-char max (overridable per caller)
 *
 * Tests across the repo (e.g. `plan-artifacts.test.ts`) assert on the exact
 * substring `'invalid slug "<value>"'` — preserve that. The example hint at
 * the end is per-caller so error messages stay actionable.
 */

const SLUG_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DEFAULT_MAX = 64;
const DEFAULT_EXAMPLE = "auth-refactor, ugi-render-0.18-hardcutover";

export type ValidateSlugOptions = {
  /** Example slugs to show in the error message. Caller-specific so the hint matches the artifact kind. */
  example?: string;
  /** Maximum slug length. Defaults to 64. */
  max?: number;
};

export function validateSlug(slug: string, opts: ValidateSlugOptions = {}): void {
  const max = opts.max ?? DEFAULT_MAX;
  const example = opts.example ?? DEFAULT_EXAMPLE;
  if (slug.length > max || !SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug "${slug}" — use lowercase words separated by hyphens or dots (e.g. ${example})`,
    );
  }
}

/** Re-exported for callers that need the raw regex (e.g., docs-style consumers). */
export const slugPattern: RegExp = SLUG_RE;
