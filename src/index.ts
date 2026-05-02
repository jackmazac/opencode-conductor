import { type Plugin, tool } from "@opencode-ai/plugin"
import { createPlanArtifactStore } from "./plan-artifacts"

const subplans = createPlanArtifactStore({
  folder: "subplans",
  artifactName: "subplan",
  missingMessage: "no subplans",
  readCap: 3000,
})

const finalPlans = createPlanArtifactStore({
  folder: "plans",
  artifactName: "final plan",
  missingMessage: "no final plans",
  readCap: 3000,
})

export const ConductorPlugin: Plugin = async () => {
  return {
    tool: {
      persist_subplan: tool({
        description:
          "Persist a planner draft or intermediary plan to .opencode/subplans/<slug>.md. Planner agents use this for candidate plans before the orchestrator synthesizes the final canonical plan.",
        args: {
          slug: tool.schema.string().describe("Subplan slug: 2-4 lowercase hyphenated words"),
          content: tool.schema.string().describe("Markdown content for the planner draft or intermediary plan"),
        },
        async execute(args, context) {
          return subplans.write(context.directory, args)
        },
      }),
      read_subplan: tool({
        description:
          "Read planner draft plans from .opencode/subplans. Omit slug to list drafts; provide slug to read one; provide section with slug to read one markdown section.",
        args: {
          slug: tool.schema.string().optional().describe("Subplan slug to read. Omit to list all subplans."),
          section: tool.schema
            .string()
            .optional()
            .describe("Markdown heading text to extract from the subplan, such as 'Wave 1' or 'Risks'."),
        },
        async execute(args, context) {
          return subplans.read(context.directory, args)
        },
      }),
      discard_subplan: tool({
        description:
          "Remove obsolete planner draft plans from .opencode/subplans. Provide slug to remove one draft; omit slug to remove all subplans.",
        args: {
          slug: tool.schema.string().optional().describe("Subplan slug to remove. Omit to remove all subplans."),
        },
        async execute(args, context) {
          return subplans.discard(context.directory, args)
        },
      }),
      persist_final_plan: tool({
        description:
          "Persist the orchestrator-approved canonical plan to .opencode/plans/<slug>.md. Use only after synthesizing planner drafts and presenting the final plan to the user.",
        args: {
          slug: tool.schema.string().describe("Final plan slug: 2-4 lowercase hyphenated words"),
          content: tool.schema.string().describe("Markdown content for the canonical final plan"),
        },
        async execute(args, context) {
          return finalPlans.write(context.directory, args)
        },
      }),
      read_final_plan: tool({
        description:
          "Read canonical final plans from .opencode/plans. Omit slug to list plans; provide slug to read one; provide section with slug to read one markdown section.",
        args: {
          slug: tool.schema.string().optional().describe("Final plan slug to read. Omit to list all final plans."),
          section: tool.schema
            .string()
            .optional()
            .describe("Markdown heading text to extract from the final plan, such as 'Wave 1' or 'Definition of Done'."),
        },
        async execute(args, context) {
          return finalPlans.read(context.directory, args)
        },
      }),
      discard_final_plan: tool({
        description:
          "Remove completed canonical final plans from .opencode/plans. Provide slug to remove one final plan; omit slug to remove all final plans.",
        args: {
          slug: tool.schema.string().optional().describe("Final plan slug to remove. Omit to remove all final plans."),
        },
        async execute(args, context) {
          return finalPlans.discard(context.directory, args)
        },
      }),
    },
  }
}

export default ConductorPlugin
