import path from "node:path";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { newPlanId, parsePlanId } from "@jackmazac/opencode-fleet-contracts";

const SLUG_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export type PlanArtifactFolder = "plans" | "subplans" | "brainstorms" | "designs";

export type PlanArtifactStoreConfig = {
  folder: PlanArtifactFolder;
  artifactName: string;
  missingMessage: string;
  readCap: number;
};

export type WritePlanArtifactArgs = {
  slug: string;
  content: string;
};

export type ReadPlanArtifactArgs = {
  slug?: string;
  plan_id?: string;
  section?: string;
};

export type DiscardPlanArtifactArgs = {
  slug?: string;
};

type Heading = {
  level: number;
  title: string;
  normalized: string;
};

type Fence = {
  marker: "`" | "~";
  length: number;
};

export type PlanIndexEntry = {
  plan_id: string;
  plan_slug: string;
  path: string;
  created_at: string;
  updated_at: string;
};

export type PlanIndex = {
  schema_version: 1;
  entries: Record<string, PlanIndexEntry>;
};

export function createPlanArtifactStore(config: PlanArtifactStoreConfig) {
  const baseDir = (directory: string) => path.join(directory, ".opencode", config.folder);
  const target = (directory: string, slug: string) => path.join(baseDir(directory), `${slug}.md`);

  return {
    async write(directory: string, rawArgs: unknown) {
      const args = parseWriteArgs(rawArgs, config.artifactName);
      validateSlug(args.slug);
      const base = baseDir(directory);
      await mkdir(base, { recursive: true });
      const dest = target(directory, args.slug);
      const tmp = `${dest}.tmp`;
      await Bun.write(tmp, args.content);
      await rename(tmp, dest);
      if (config.folder === "plans") {
        const entry = await upsertPlanIndex(directory, args.slug, dest);
        return JSON.stringify(
          { plan_id: entry.plan_id, plan_slug: entry.plan_slug, path: entry.path },
          null,
          2,
        );
      }
      return `wrote ${config.artifactName} ${args.slug}\nfile: ${relative(directory, dest)}`;
    },

    async read(directory: string, rawArgs: unknown) {
      const args = parseReadArgs(rawArgs, config.artifactName);
      const slug = args.plan_id ? await slugForPlanId(directory, args.plan_id) : args.slug;
      if (slug) {
        validateSlug(slug);
        const dest = target(directory, slug);
        if (!(await Bun.file(dest).exists())) return `no ${config.artifactName} file for ${slug}`;
        const fileStat = await stat(dest);
        const raw = await Bun.file(dest).text();
        if (args.section) {
          const section = extractSection(raw, args.section);
          if (!section) return `section "${args.section}" not found in ${slug}`;
          return formatReadResult({
            directory,
            file: dest,
            mtime: fileStat.mtime.toISOString(),
            content: cap(section, config.readCap),
          });
        }
        return formatReadResult({
          directory,
          file: dest,
          mtime: fileStat.mtime.toISOString(),
          content: cap(raw, config.readCap),
          length: raw.length,
        });
      }

      if (args.plan_id) return `no ${config.artifactName} file for plan_id ${args.plan_id}`;

      if (args.section) return `${config.artifactName} section reads require a slug`;
      return listArtifacts({
        directory,
        base: baseDir(directory),
        missingMessage: config.missingMessage,
      });
    },

    async discard(directory: string, rawArgs: unknown) {
      const args = parseDiscardArgs(rawArgs, config.artifactName);
      if (args.slug) {
        validateSlug(args.slug);
        const dest = target(directory, args.slug);
        if (!(await Bun.file(dest).exists()))
          return `no ${config.artifactName} file for ${args.slug}`;
        await Bun.file(dest).delete();
        if (config.folder === "plans") await removePlanIndexEntry(directory, args.slug);
        return `removed ${config.artifactName} ${args.slug}\nfile: ${relative(directory, dest)}`;
      }

      const base = baseDir(directory);
      const entries = await readMarkdownEntries(base);
      if (entries.length === 0) return `no ${config.artifactName} files to clean`;
      const files = entries.map((entry) => path.join(base, entry));
      await Promise.all(files.map((file) => Bun.file(file).delete()));
      if (config.folder === "plans") await removePlanIndex(directory);
      try {
        if ((await readdir(base)).length === 0) await rmdir(base);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return `removed ${entries.length} ${config.artifactName} files\nfiles:\n${files
        .map((file) => relative(directory, file))
        .join("\n")}`;
    },
  };
}

function parseWriteArgs(args: unknown, artifactName: string): WritePlanArtifactArgs {
  const record = requireArgsRecord(args, `${artifactName} write`);
  const slug = requireStringArg(record, "slug", `${artifactName} write`);
  const content = requireStringArg(record, "content", `${artifactName} write`);
  return { slug, content };
}

function parseReadArgs(args: unknown, artifactName: string): ReadPlanArtifactArgs {
  const record = optionalArgsRecord(args, `${artifactName} read`);
  return {
    slug: optionalStringArg(record, "slug", `${artifactName} read`),
    plan_id: optionalStringArg(record, "plan_id", `${artifactName} read`),
    section: optionalStringArg(record, "section", `${artifactName} read`),
  };
}

function parseDiscardArgs(args: unknown, artifactName: string): DiscardPlanArtifactArgs {
  const record = optionalArgsRecord(args, `${artifactName} discard`);
  return { slug: optionalStringArg(record, "slug", `${artifactName} discard`) };
}

function requireArgsRecord(args: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(args)) throw new Error(`${operation} args must be an object`);
  return args;
}

function optionalArgsRecord(args: unknown, operation: string): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  return requireArgsRecord(args, operation);
}

function requireStringArg(
  record: Record<string, unknown>,
  field: string,
  operation: string,
): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${operation} arg "${field}" must be a string`);
  return value;
}

function optionalStringArg(
  record: Record<string, unknown>,
  field: string,
  operation: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${operation} arg "${field}" must be a string`);
  return value;
}

export async function readPlanIndex(root: string): Promise<PlanIndex> {
  const file = planIndexPath(root);
  if (!(await Bun.file(file).exists())) return emptyPlanIndex();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(file).text());
  } catch {
    return emptyPlanIndex();
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !isRecord(parsed.entries)) {
    return emptyPlanIndex();
  }
  const entries: Record<string, PlanIndexEntry> = {};
  for (const [slug, value] of Object.entries(parsed.entries)) {
    if (!isPlanIndexEntry(value)) continue;
    entries[slug] = value;
  }
  return { schema_version: 1, entries };
}

async function upsertPlanIndex(
  directory: string,
  slug: string,
  dest: string,
): Promise<PlanIndexEntry> {
  const index = await readPlanIndex(directory);
  const existing = index.entries[slug];
  const now = new Date().toISOString();
  const entry: PlanIndexEntry = {
    plan_id: existing?.plan_id ?? newPlanId(),
    plan_slug: slug,
    path: relative(directory, dest),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const next: PlanIndex = {
    schema_version: 1,
    entries: { ...index.entries, [slug]: entry },
  };
  const file = planIndexPath(directory);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await Bun.write(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, file);
  return entry;
}

async function slugForPlanId(directory: string, rawPlanId: string): Promise<string | undefined> {
  const parsed = parsePlanId(rawPlanId);
  if (!parsed.ok) throw new Error(`invalid plan_id "${rawPlanId}": ${parsed.reason}`);
  const index = await readPlanIndex(directory);
  for (const entry of Object.values(index.entries)) {
    if (entry.plan_id === parsed.value) return entry.plan_slug;
  }
  return undefined;
}

async function removePlanIndexEntry(directory: string, slug: string): Promise<void> {
  const index = await readPlanIndex(directory);
  if (!index.entries[slug]) return;
  const nextEntries = { ...index.entries };
  delete nextEntries[slug];
  const file = planIndexPath(directory);
  const tmp = `${file}.tmp`;
  await Bun.write(tmp, JSON.stringify({ schema_version: 1, entries: nextEntries }, null, 2));
  await rename(tmp, file);
}

async function removePlanIndex(directory: string): Promise<void> {
  const file = planIndexPath(directory);
  if (await Bun.file(file).exists()) await Bun.file(file).delete();
}

function planIndexPath(root: string) {
  return path.join(root, ".opencode", "plans", "index.json");
}

function emptyPlanIndex(): PlanIndex {
  return { schema_version: 1, entries: {} };
}

function isPlanIndexEntry(value: unknown): value is PlanIndexEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.plan_id === "string" &&
    parsePlanId(value.plan_id).ok &&
    typeof value.plan_slug === "string" &&
    value.plan_slug.length <= 64 &&
    SLUG_RE.test(value.plan_slug) &&
    typeof value.path === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractSection(markdown: string, section: string) {
  const target = normalizeHeading(section);
  if (!target) return undefined;

  const lines = markdown.split("\n");
  const fenceLines = collectFenceLines(lines);
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (fenceLines.has(index)) continue;
    const line = lines[index];
    if (line === undefined) continue;
    const heading = parseHeading(line);
    if (!heading) continue;
    if (heading.normalized !== target) continue;
    start = index;
    level = heading.level;
    break;
  }

  if (start === -1) return undefined;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (fenceLines.has(index)) continue;
    const line = lines[index];
    if (line === undefined) continue;
    const heading = parseHeading(line);
    if (!heading) continue;
    if (heading.level <= level) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

function collectFenceLines(lines: string[]) {
  const fenceLines = new Set<number>();
  let fenceMarker: "`" | "~" | undefined;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;

    const fence = parseFence(line);
    if (!fenceMarker) {
      if (!fence) continue;
      fenceMarker = fence.marker;
      fenceLength = fence.length;
      fenceLines.add(index);
      continue;
    }

    fenceLines.add(index);
    if (fence && fence.marker === fenceMarker && fence.length >= fenceLength) {
      fenceMarker = undefined;
      fenceLength = 0;
    }
  }

  return fenceLines;
}

function parseFence(line: string): Fence | undefined {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!match) return undefined;
  const marker = match[1];
  if (!marker) return undefined;
  const first = marker[0];
  if (first === "`") return { marker: first, length: marker.length };
  if (first === "~") return { marker: first, length: marker.length };
  return undefined;
}

function validateSlug(slug: string) {
  if (slug.length > 64 || !SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug "${slug}" - use lowercase words separated by hyphens or dots (e.g. auth-refactor, ugi-render-0.18-hardcutover)`,
    );
  }
}

function parseHeading(line: string): Heading | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return undefined;
  const marker = match[1];
  const rawTitle = match[2];
  if (!marker || !rawTitle) return undefined;
  const title = rawTitle.replace(/\s+#+\s*$/, "").trim();
  if (!title) return undefined;
  return {
    level: marker.length,
    title,
    normalized: normalizeHeading(title),
  };
}

function normalizeHeading(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function cap(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated - ${text.length - limit} chars omitted, use targeted section reads for more]`;
}

async function listArtifacts(input: { directory: string; base: string; missingMessage: string }) {
  const entries = await readMarkdownEntries(input.base);
  if (entries.length === 0) return input.missingMessage;
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(input.base, entry);
      const slug = entry.replace(/\.md$/, "");
      const fileStat = await stat(full);
      const text = await Bun.file(full).text();
      const title = extractTitle(text);
      return `${slug} | ${title} | ${text.length} chars | updated ${fileStat.mtime.toISOString()} | file ${relative(
        input.directory,
        full,
      )}`;
    }),
  );
  return lines.join("\n");
}

async function readMarkdownEntries(base: string) {
  try {
    return (await readdir(base)).filter((entry) => entry.endsWith(".md")).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function extractTitle(markdown: string) {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "));
  return line?.slice(2).trim() || "(untitled plan)";
}

function formatReadResult(input: {
  directory: string;
  file: string;
  mtime: string;
  content: string;
  length?: number;
}) {
  const length = input.length === undefined ? "" : ` (${input.length} chars)`;
  return `File: ${relative(input.directory, input.file)}\nLast updated: ${input.mtime}${length}\n\n${input.content}`;
}

function relative(directory: string, file: string) {
  return path.relative(directory, file);
}

function isNotFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
