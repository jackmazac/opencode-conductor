import path from "node:path"
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises"

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

export type PlanArtifactFolder = "plans" | "subplans"

export type PlanArtifactStoreConfig = {
  folder: PlanArtifactFolder
  artifactName: string
  missingMessage: string
  readCap: number
}

export type WritePlanArtifactArgs = {
  slug: string
  content: string
}

export type ReadPlanArtifactArgs = {
  slug?: string
  section?: string
}

export type DiscardPlanArtifactArgs = {
  slug?: string
}

type Heading = {
  level: number
  title: string
  normalized: string
}

type Fence = {
  marker: "`" | "~"
  length: number
}

export function createPlanArtifactStore(config: PlanArtifactStoreConfig) {
  const baseDir = (directory: string) => path.join(directory, ".opencode", config.folder)
  const target = (directory: string, slug: string) => path.join(baseDir(directory), `${slug}.md`)

  return {
    async write(directory: string, args: WritePlanArtifactArgs) {
      validateSlug(args.slug)
      const base = baseDir(directory)
      await mkdir(base, { recursive: true })
      const dest = target(directory, args.slug)
      const tmp = `${dest}.tmp`
      await Bun.write(tmp, args.content)
      await rename(tmp, dest)
      return `wrote ${config.artifactName} ${args.slug}\nfile: ${relative(directory, dest)}`
    },

    async read(directory: string, args: ReadPlanArtifactArgs) {
      if (args.slug) {
        validateSlug(args.slug)
        const dest = target(directory, args.slug)
        if (!(await Bun.file(dest).exists())) return `no ${config.artifactName} file for ${args.slug}`
        const fileStat = await stat(dest)
        const raw = await Bun.file(dest).text()
        if (args.section) {
          const section = extractSection(raw, args.section)
          if (!section) return `section "${args.section}" not found in ${args.slug}`
          return formatReadResult({
            directory,
            file: dest,
            mtime: fileStat.mtime.toISOString(),
            content: cap(section, config.readCap),
          })
        }
        return formatReadResult({
          directory,
          file: dest,
          mtime: fileStat.mtime.toISOString(),
          content: cap(raw, config.readCap),
          length: raw.length,
        })
      }

      if (args.section) return `${config.artifactName} section reads require a slug`
      return listArtifacts({
        directory,
        base: baseDir(directory),
        missingMessage: config.missingMessage,
      })
    },

    async discard(directory: string, args: DiscardPlanArtifactArgs) {
      if (args.slug) {
        validateSlug(args.slug)
        const dest = target(directory, args.slug)
        if (!(await Bun.file(dest).exists())) return `no ${config.artifactName} file for ${args.slug}`
        await Bun.file(dest).delete()
        return `removed ${config.artifactName} ${args.slug}\nfile: ${relative(directory, dest)}`
      }

      const base = baseDir(directory)
      const entries = await readMarkdownEntries(base)
      if (entries.length === 0) return `no ${config.artifactName} files to clean`
      const files = entries.map((entry) => path.join(base, entry))
      await Promise.all(files.map((file) => Bun.file(file).delete()))
      try {
        if ((await readdir(base)).length === 0) await rmdir(base)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      return `removed ${entries.length} ${config.artifactName} files\nfiles:\n${files
        .map((file) => relative(directory, file))
        .join("\n")}`
    },
  }
}

export function extractSection(markdown: string, section: string) {
  const target = normalizeHeading(section)
  if (!target) return undefined

  const lines = markdown.split("\n")
  const fenceLines = collectFenceLines(lines)
  let start = -1
  let level = 0

  for (let index = 0; index < lines.length; index += 1) {
    if (fenceLines.has(index)) continue
    const line = lines[index]
    if (line === undefined) continue
    const heading = parseHeading(line)
    if (!heading) continue
    if (heading.normalized !== target) continue
    start = index
    level = heading.level
    break
  }

  if (start === -1) return undefined

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (fenceLines.has(index)) continue
    const line = lines[index]
    if (line === undefined) continue
    const heading = parseHeading(line)
    if (!heading) continue
    if (heading.level <= level) {
      end = index
      break
    }
  }

  return lines.slice(start, end).join("\n").trim()
}

function collectFenceLines(lines: string[]) {
  const fenceLines = new Set<number>()
  let fenceMarker: "`" | "~" | undefined
  let fenceLength = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue

    const fence = parseFence(line)
    if (!fenceMarker) {
      if (!fence) continue
      fenceMarker = fence.marker
      fenceLength = fence.length
      fenceLines.add(index)
      continue
    }

    fenceLines.add(index)
    if (fence && fence.marker === fenceMarker && fence.length >= fenceLength) {
      fenceMarker = undefined
      fenceLength = 0
    }
  }

  return fenceLines
}

function parseFence(line: string): Fence | undefined {
  const match = /^\s*(`{3,}|~{3,})/.exec(line)
  if (!match) return undefined
  const marker = match[1]
  if (!marker) return undefined
  const first = marker[0]
  if (first === "`") return { marker: first, length: marker.length }
  if (first === "~") return { marker: first, length: marker.length }
  return undefined
}

function validateSlug(slug: string) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid slug "${slug}" - use 2-4 lowercase hyphenated words (e.g. auth-refactor, inbox-ui)`)
  }
}

function parseHeading(line: string): Heading | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  if (!match) return undefined
  const marker = match[1]
  const rawTitle = match[2]
  if (!marker || !rawTitle) return undefined
  const title = rawTitle.replace(/\s+#+\s*$/, "").trim()
  if (!title) return undefined
  return {
    level: marker.length,
    title,
    normalized: normalizeHeading(title),
  }
}

function normalizeHeading(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function cap(text: string, limit: number) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n[truncated - ${text.length - limit} chars omitted, use targeted section reads for more]`
}

async function listArtifacts(input: { directory: string; base: string; missingMessage: string }) {
  const entries = await readMarkdownEntries(input.base)
  if (entries.length === 0) return input.missingMessage
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(input.base, entry)
      const slug = entry.replace(/\.md$/, "")
      const fileStat = await stat(full)
      const text = await Bun.file(full).text()
      const title = extractTitle(text)
      return `${slug} | ${title} | ${text.length} chars | updated ${fileStat.mtime.toISOString()} | file ${relative(
        input.directory,
        full,
      )}`
    }),
  )
  return lines.join("\n")
}

async function readMarkdownEntries(base: string) {
  try {
    return (await readdir(base)).filter((entry) => entry.endsWith(".md")).sort()
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

function extractTitle(markdown: string) {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "))
  return line?.slice(2).trim() || "(untitled plan)"
}

function formatReadResult(input: {
  directory: string
  file: string
  mtime: string
  content: string
  length?: number
}) {
  const length = input.length === undefined ? "" : ` (${input.length} chars)`
  return `File: ${relative(input.directory, input.file)}\nLast updated: ${input.mtime}${length}\n\n${input.content}`
}

function relative(directory: string, file: string) {
  return path.relative(directory, file)
}

function isNotFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
