/**
 * Shared store for plan-progress and audit-progress artifacts.
 *
 * Before this factory, `progress.ts` and `audit-progress.ts` were ~95% duplicate
 * — same slug regex, same status enum, same Wave type, same dir/target/rel
 * helpers, same upsert algorithm. The only meaningful differences were the
 * argument name (`plan_slug` vs `audit_slug`) and the folder name. This module
 * extracts the common shape into a `createProgressStore` factory; the two tool
 * files now register thin `tool()` wrappers that delegate to the same logic.
 *
 * Same pattern as `createPlanArtifactStore` in `plan-artifacts.ts`.
 */

import path from "node:path";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";

import { rel } from "./util/format";
import { validateSlug } from "./util/slug";

const STATUSES = ["pending", "in-progress", "done"];
const READ_LIMIT = 10;

export type ProgressArtifactFolder = "progress" | "audit-progress";
export type ProgressArgName = "plan_slug" | "audit_slug";

export type ProgressArtifactStoreConfig = {
  /** Subdirectory under `.opencode/` where these files live. */
  folder: ProgressArtifactFolder;
  /** Caller-facing arg name for the slug (`plan_slug` vs `audit_slug`). */
  argName: ProgressArgName;
  /** Singular name used in error messages and output strings. */
  kind: "plan" | "audit";
  /** Example slug fragments used in slug-validation error messages. */
  slugExample: string;
};

export type ProgressWave = {
  status: string;
  summary?: string | null;
  updated: string;
};

export type ProgressData = {
  waves: Record<string, ProgressWave>;
};

export type UpdateArgs = {
  slug: string;
  wave_id: string;
  status: string;
  summary?: string;
};

export type ReadArgs = {
  slug?: string;
};

export type DiscardArgs = {
  slug?: string;
};

export function createProgressStore(config: ProgressArtifactStoreConfig) {
  const baseDir = (directory: string): string =>
    path.join(directory, ".opencode", config.folder);

  const target = (directory: string, slug: string): string =>
    path.join(baseDir(directory), `${slug}.json`);

  return {
    async update(directory: string, args: UpdateArgs): Promise<string> {
      validateSlug(args.slug, { example: config.slugExample });
      if (!STATUSES.includes(args.status)) {
        throw new Error(`invalid status "${args.status}" — use: ${STATUSES.join(", ")}`);
      }
      const dest = target(directory, args.slug);
      await mkdir(baseDir(directory), { recursive: true });
      const existing: ProgressData = (await Bun.file(dest).exists())
        ? JSON.parse(await Bun.file(dest).text())
        : { waves: {} };
      existing.waves[args.wave_id] = {
        status: args.status,
        summary: args.summary || null,
        updated: new Date().toISOString(),
      };
      const tmp = `${dest}.tmp`;
      await Bun.write(tmp, JSON.stringify(existing, null, 2));
      await rename(tmp, dest);
      const label = config.kind === "audit" ? "audit progress" : "progress";
      return `${label}: ${args.slug} ${args.wave_id} → ${args.status}\nfile: ${rel(directory, dest)}`;
    },

    async read(directory: string, args: ReadArgs): Promise<string> {
      const missingLabel = config.kind === "audit" ? "audit progress" : "progress";
      if (args.slug) {
        validateSlug(args.slug, { example: config.slugExample });
        const dest = target(directory, args.slug);
        if (!(await Bun.file(dest).exists())) return `no ${missingLabel} for ${args.slug}`;
        const data: ProgressData = JSON.parse(await Bun.file(dest).text());
        const all = Object.entries(data.waves);
        const skipped = Math.max(0, all.length - READ_LIMIT);
        const shown = all.slice(-READ_LIMIT);
        const completed = all.filter(([, w]) => w.status === "done").length;
        const showingNote =
          skipped > 0 ? ` (showing last ${READ_LIMIT}, ${skipped} omitted)` : "";
        const header = `File: ${rel(directory, dest)}\n${args.slug}: ${completed}/${all.length} waves done${showingNote}`;
        const body = shown
          .map(([id, w]) => {
            const sum = w.summary ? ` | ${w.summary.slice(0, 80)}` : "";
            return `${id} | ${w.status}${sum}`;
          })
          .join("\n");
        return `${header}\n${body}`;
      }
      const base = baseDir(directory);
      if (!(await Bun.file(base).exists())) return `no ${config.folder} files`;
      const entries = (await readdir(base)).filter((f) => f.endsWith(".json")).sort();
      if (entries.length === 0) return `no ${config.folder} files`;
      const lines = await Promise.all(
        entries.map(async (f) => {
          const full = path.join(base, f);
          const slug = f.replace(/\.json$/, "");
          const data: ProgressData = JSON.parse(await Bun.file(full).text());
          const waves = Object.entries(data.waves);
          const completed = waves.filter(([, w]) => w.status === "done").length;
          return `${slug} | ${completed}/${waves.length} waves done | file ${rel(directory, full)}`;
        }),
      );
      return lines.join("\n");
    },

    async discard(directory: string, args: DiscardArgs): Promise<string> {
      const missingLabel = config.kind === "audit" ? "audit progress" : "progress";
      if (args.slug) {
        validateSlug(args.slug, { example: config.slugExample });
        const dest = target(directory, args.slug);
        if (!(await Bun.file(dest).exists())) return `no ${missingLabel} for ${args.slug}`;
        await Bun.file(dest).delete();
        const verb = config.kind === "audit" ? "removed audit progress for" : "removed progress for";
        return `${verb} ${args.slug}\nfile: ${rel(directory, dest)}`;
      }
      const base = baseDir(directory);
      if (!(await Bun.file(base).exists())) return `no ${config.folder} files to clean`;
      const entries = (await readdir(base)).filter((f) => f.endsWith(".json"));
      if (entries.length === 0) return `no ${config.folder} files to clean`;
      const files = entries.map((f) => path.join(base, f));
      await Promise.all(files.map((file) => Bun.file(file).delete()));
      if ((await readdir(base)).length === 0) await rmdir(base);
      const label = config.kind === "audit" ? "audit progress files" : "progress files";
      return `removed ${entries.length} ${label}\nfiles:\n${files.map((file) => rel(directory, file)).join("\n")}`;
    },

    /** Public helper for other tools (e.g. drift_check, artifact_index) that need to enumerate. */
    listSlugs: async (directory: string): Promise<string[]> => {
      const base = baseDir(directory);
      if (!(await Bun.file(base).exists())) return [];
      return (await readdir(base))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
    },
  };
}

export type ProgressStore = ReturnType<typeof createProgressStore>;
