import { Effect } from "effect";
import ConductorPlugin from "../src/index.ts";

const expectedTools = [
  "audit_write",
  "audit_read",
  "audit_done",
  "audit_progress_update",
  "audit_progress_read",
  "audit_progress_done",
  "handoff_write",
  "handoff_read",
  "handoff_done",
  "journal_write",
  "journal_read",
  "journal_done",
  "progress_update",
  "progress_read",
  "progress_done",
  "run_init",
  "run_update",
  "run_finish",
  "status_write",
  "status_read",
  "status_done",
  "persist_subplan",
  "read_subplan",
  "discard_subplan",
  "persist_final_plan",
  "read_final_plan",
  "discard_final_plan",
  "persist_brainstorm",
  "read_brainstorm",
  "discard_brainstorm",
  "persist_design",
  "read_design",
  "discard_design",
  "conflict_context",
  "context_usage",
  "lifecycle_concord_ingest",
];

async function main() {
  const input = {
    client: {},
    project: "runtime-smoke",
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: process.cwd(),
    serverUrl: "http://127.0.0.1",
    $: () => ({
      text: async () => "",
      json: async () => ({}),
      quiet() {
        return this;
      },
      cwd() {
        return this;
      },
      env() {
        return this;
      },
      nothrow() {
        return this;
      },
    }),
  };
  const hooks: unknown = await Reflect.apply(ConductorPlugin, undefined, [input]);
  const tools = getTools(hooks);
  const missing = expectedTools.filter((name) => !hasOwn(tools, name));
  if (missing.length > 0) throw new Error(`missing tools: ${missing.join(", ")}`);
  const readSubplan = tools.read_subplan;
  if (!readSubplan) throw new Error("read_subplan was not registered");
  await readSubplan.execute(
    {},
    {
      sessionID: "runtime-smoke",
      messageID: "runtime-smoke",
      agent: "runtime-smoke",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata() {},
      ask() {
        return Effect.void;
      },
    },
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, expected_tools: expectedTools.length, missing }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false }, null, 2)}\n`);
  process.exit(1);
});

function getTools(
  hooks: unknown,
): Record<string, { execute: (args: object, context: object) => Promise<unknown> }> {
  if (!isRecord(hooks)) throw new Error("plugin did not return hooks object");
  const tools = hooks.tool;
  if (!isRecord(tools)) throw new Error("plugin did not return tool hooks");
  const result: Record<string, { execute: (args: object, context: object) => Promise<unknown> }> =
    {};
  for (const [name, value] of Object.entries(tools)) {
    if (isTool(value)) result[name] = value;
  }
  return result;
}

function isTool(
  value: unknown,
): value is { execute: (args: object, context: object) => Promise<unknown> } {
  return isRecord(value) && typeof value.execute === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
