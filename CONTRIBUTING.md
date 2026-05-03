# Contributing to @jackmazac/opencode-conductor

This plugin orchestrates multi-agent workflows inside opencode. Authoring rules are stricter than for an ordinary npm package because mistakes can crash opencode itself, not just conductor.

## Setup

```bash
bun install
bun run check    # lint + typecheck + tests
```

## Authoring rules

### Use `tool.schema`, not `import { z } from "zod"`

In any file that exports a `Plugin` factory or registers a `tool({...})`, use `tool.schema` instead of importing `z` from `zod`:

```ts
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;
```

`bun run lint:no-zod` enforces this. Internal validation outside the plugin boundary (e.g. `packages/spine`, `packages/bridge-contracts`) may import zod directly.

### Tool args must be a `ZodRawShape` literal

```ts
// GOOD
args: { foo: z.string(), count: z.number().optional() }
```

```ts
// BAD — opencode iterates Object.keys(args) and dereferences method.._zod.def → TypeError
args: z.object({ foo: z.string(), count: z.number().optional() })
```

### Wrap the default export with `wrapPlugin`

```ts
import { wrapPlugin } from "@jackmazac/opencode-host-adapter";

export default wrapPlugin(ConductorPlugin, { name: "conductor" });
```

### Subagent envelope contract

When orchestrator code consumes a subagent's task result, validate the envelope with the schema in `packages/bridge-contracts/src/subagent.ts`:

```ts
import { validateSubagentEnvelope } from "./packages/bridge-contracts/src/subagent.ts";

const result = validateSubagentEnvelope(rawTaskResult);
if (!result.ok) {
  return `❌ subagent returned malformed envelope: ${result.error}`;
}
const envelope = result.envelope;
// envelope.status: ok | error | blocked | timeout
// envelope.content, envelope.tool_calls, envelope.usage, envelope.error, envelope.metadata
```

This turns malformed subagent output into a clear error string instead of a downstream Effect crash.

## Naming convention

This package's npm name is `@jackmazac/opencode-conductor` to avoid collision with `opencode-conductor` (NocturnLabs' separate package). Always reference it by the scoped name in `opencode.json` plugin lists, package.json deps, and prompt file paths.

## Versioning

`@opencode-ai/plugin` version is pinned in `.opencode-plugin-version`. Bump on upgrade.

## Debugging

See the runbook at `~/.config/opencode/runbooks/plugin-broken.md`.
