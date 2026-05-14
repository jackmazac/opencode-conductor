import { type Plugin, tool } from "@opencode-ai/plugin";
import { wrapPlugin } from "@mazac-fox/opencode-host-adapter";
import { discardCache as discardExploreCache } from "./explore-cache";
import { runExploreFast } from "./explore-fast";
import { createPlanArtifactStore } from "./plan-artifacts";
import { createWorkflowArtifactTools } from "./workflow-artifacts";
import type { ContextUsageClient } from "./workflow-tools/context-usage";

const subplans = createPlanArtifactStore({
  folder: "subplans",
  artifactName: "subplan",
  missingMessage: "no subplans",
  readCap: 3000,
});

const finalPlans = createPlanArtifactStore({
  folder: "plans",
  artifactName: "final plan",
  missingMessage: "no final plans",
  readCap: 3000,
});

const brainstorms = createPlanArtifactStore({
  folder: "brainstorms",
  artifactName: "brainstorm",
  missingMessage: "no brainstorms",
  readCap: 3000,
});

const designs = createPlanArtifactStore({
  folder: "designs",
  artifactName: "design",
  missingMessage: "no designs",
  readCap: 3000,
});

export type ConductorPluginDeps = {
  contextUsageClient?: ContextUsageClient;
};

export function createConductorHooks(deps: ConductorPluginDeps = {}) {
  return {
    tool: {
      ...createWorkflowArtifactTools({ contextUsageClient: deps.contextUsageClient }),
      persist_subplan: tool({
        description:
          "Persist a planner draft or intermediary plan to .opencode/subplans/<slug>.md. Planner agents use this for candidate plans before the orchestrator synthesizes the final canonical plan.",
        args: {
          slug: tool.schema
            .string()
            .describe("Subplan slug: lowercase words separated by hyphens or dots"),
          content: tool.schema
            .string()
            .describe("Markdown content for the planner draft or intermediary plan"),
        },
        async execute(args, context) {
          return subplans.write(context.directory, args);
        },
      }),
      read_subplan: tool({
        description:
          "Read planner draft plans from .opencode/subplans. Omit slug to list drafts; provide slug to read one; provide section with slug to read one markdown section.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Subplan slug to read. Omit to list all subplans."),
          section: tool.schema
            .string()
            .optional()
            .describe(
              "Markdown heading text to extract from the subplan, such as 'Wave 1' or 'Risks'.",
            ),
        },
        async execute(args, context) {
          return subplans.read(context.directory, args);
        },
      }),
      discard_subplan: tool({
        description:
          "Remove obsolete planner draft plans from .opencode/subplans. Provide slug to remove one draft; omit slug to remove all subplans.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Subplan slug to remove. Omit to remove all subplans."),
        },
        async execute(args, context) {
          return subplans.discard(context.directory, args);
        },
      }),
      persist_final_plan: tool({
        description:
          "Persist the orchestrator-approved canonical plan to .opencode/plans/<slug>.md, returning its stable plan_id, plan_slug, and path. Use only after synthesizing planner drafts and presenting the final plan to the user.",
        args: {
          slug: tool.schema
            .string()
            .describe("Final plan slug: lowercase words separated by hyphens or dots"),
          content: tool.schema.string().describe("Markdown content for the canonical final plan"),
        },
        async execute(args, context) {
          return finalPlans.write(context.directory, args);
        },
      }),
      read_final_plan: tool({
        description:
          "Read canonical final plans from .opencode/plans. Omit slug to list plans; provide slug or plan_id to read one; provide section with slug or plan_id to read one markdown section.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Final plan slug to read. Omit to list all final plans."),
          plan_id: tool.schema
            .string()
            .optional()
            .describe("Final plan id to read via the plans index."),
          section: tool.schema
            .string()
            .optional()
            .describe(
              "Markdown heading text to extract from the final plan, such as 'Wave 1' or 'Definition of Done'.",
            ),
        },
        async execute(args, context) {
          return finalPlans.read(context.directory, args);
        },
      }),
      discard_final_plan: tool({
        description:
          "Remove completed canonical final plans from .opencode/plans. Provide slug to remove one final plan; omit slug to remove all final plans.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Final plan slug to remove. Omit to remove all final plans."),
        },
        async execute(args, context) {
          return finalPlans.discard(context.directory, args);
        },
      }),
      persist_brainstorm: tool({
        description:
          "Persist a brainstorm transcript or summary to .opencode/brainstorms/<slug>.md. Brainstormer agents use this when their conclusions (options, trade-offs, recommendations) need to survive across compaction or to feed downstream planners and executors.",
        args: {
          slug: tool.schema
            .string()
            .describe("Brainstorm slug: lowercase words separated by hyphens or dots"),
          content: tool.schema.string().describe("Markdown content for the brainstorm"),
        },
        async execute(args, context) {
          return brainstorms.write(context.directory, args);
        },
      }),
      read_brainstorm: tool({
        description:
          "Read brainstorms from .opencode/brainstorms. Omit slug to list brainstorms; provide slug to read one; provide section with slug to read one markdown section.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Brainstorm slug to read. Omit to list all brainstorms."),
          section: tool.schema
            .string()
            .optional()
            .describe(
              "Markdown heading text to extract from the brainstorm, such as 'Options' or 'Recommendation'.",
            ),
        },
        async execute(args, context) {
          return brainstorms.read(context.directory, args);
        },
      }),
      discard_brainstorm: tool({
        description:
          "Remove obsolete brainstorms from .opencode/brainstorms. Provide slug to remove one; omit slug to remove all brainstorms.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Brainstorm slug to remove. Omit to remove all brainstorms."),
        },
        async execute(args, context) {
          return brainstorms.discard(context.directory, args);
        },
      }),
      persist_design: tool({
        description:
          "Persist a design system specification or design audit to .opencode/designs/<slug>.md. Designer agents use this in advisory mode (or when an implementation review needs a durable artifact) so executors can read the canonical design before applying it.",
        args: {
          slug: tool.schema
            .string()
            .describe("Design slug: lowercase words separated by hyphens or dots"),
          content: tool.schema.string().describe("Markdown content for the design specification"),
        },
        async execute(args, context) {
          return designs.write(context.directory, args);
        },
      }),
      read_design: tool({
        description:
          "Read designs from .opencode/designs. Omit slug to list designs; provide slug to read one; provide section with slug to read one markdown section.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Design slug to read. Omit to list all designs."),
          section: tool.schema
            .string()
            .optional()
            .describe(
              "Markdown heading text to extract from the design, such as 'Colors' or 'Components'.",
            ),
        },
        async execute(args, context) {
          return designs.read(context.directory, args);
        },
      }),
      discard_design: tool({
        description:
          "Remove obsolete designs from .opencode/designs. Provide slug to remove one; omit slug to remove all designs.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe("Design slug to remove. Omit to remove all designs."),
        },
        async execute(args, context) {
          return designs.discard(context.directory, args);
        },
      }),
      explore_fast: tool({
        description:
          "Fast model-reasoned codebase exploration via the Cursor `agent` CLI (Composer-2 Fast by default). Returns a structured markdown report with file:line citations — the same shape the `explore` / `explore-high` Task subagents return. Use for narrative discovery (cues, ranked file lists, behavioral tracing) when you want the answer in one tool call instead of spawning a full Task subagent. For deterministic file-dependency, impact-cone, API-surface, or change-risk truth use the codemem_* tools instead. The CLI runs to completion; the outer task harness owns the wall-clock budget. Results are cached at .opencode/explore-cache/ keyed by content hash; identical repeat queries return instantly without re-spawning the CLI. Cache invalidates automatically on every commit (git HEAD is in the key) and on prompts/explore.txt content changes.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Natural-language exploration question. Include directories or globs, the question to answer, and explicit non-goals when scoping a parallel discovery wave.",
            ),
          path: tool.schema
            .string()
            .optional()
            .describe(
              "Optional workspace-relative path to focus the exploration on. Rejected if it escapes the workspace root.",
            ),
          thoroughness: tool.schema
            .enum(["quick", "standard", "exhaustive"])
            .optional()
            .describe(
              "Search depth: 'quick' (first match), 'standard' (default — 2-3 grep passes plus cross-references), 'exhaustive' (map all occurrences, re-exports, tests, configs, consumers). Picks the default model — exhaustive upgrades to composer-2.",
            ),
          cache: tool.schema
            .boolean()
            .optional()
            .describe(
              "Default true. Set false to bypass the cache and force a fresh CLI call — use when you've edited code since the last cached run on the same query (uncommitted changes don't auto-invalidate; only commits do).",
            ),
        },
        async execute(args, context) {
          return runExploreFast({
            directory: context.directory,
            query: args.query,
            path: args.path,
            thoroughness: args.thoroughness,
            cache: args.cache,
          });
        },
      }),
      discard_explore_cache: tool({
        description:
          "Clear the .opencode/explore-cache/ directory. Use when the cache has drifted (e.g., you suspect Cursor changed model behavior server-side, or you want a clean baseline). Cache invalidates automatically on every commit; this tool is the manual override.",
        args: {},
        async execute(_args, context) {
          const cleared = await discardExploreCache(context.directory);
          return cleared === 0
            ? "explore cache: nothing to clear"
            : `explore cache: cleared ${cleared} ${cleared === 1 ? "entry" : "entries"}`;
        },
      }),
    },
  };
}

export const ConductorPlugin: Plugin = async ({ client }) => {
  return createConductorHooks({ contextUsageClient: client });
};

export default wrapPlugin(ConductorPlugin, { name: "conductor" });
