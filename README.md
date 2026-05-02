# OpenCode Conductor

OpenCode Conductor is an opinionated orchestration plugin for turning OpenCode from an ad hoc assistant into a disciplined multi-agent engineering workflow.

It owns agent definitions, planning conventions, delegation rules, review discipline, and documentation/scribe expectations. It is intentionally separate from Engram: Conductor coordinates work; Engram remembers and evaluates work.

## Product framing

Conductor is a software-engineering operating system for OpenCode: plan, delegate, execute, review, document, and learn in repeatable waves.

## Relationship to Engram

- Conductor works without Engram.
- Engram works without Conductor.
- Together, Conductor can request Engram preflight context before large plans and Engram can learn from Conductor artifacts through the bridge contract.

## Install during local development

```json
{
  "plugin": ["file:///Users/jack.mazac/Developer/opencode-conductor/src/index.ts"]
}
```

## Plan artifact tools

Conductor registers explicit tools for draft plans and canonical plans:

- `persist_subplan`, `read_subplan`, `discard_subplan` store planner drafts in `.opencode/subplans/<slug>.md`.
- `persist_final_plan`, `read_final_plan`, `discard_final_plan` store orchestrator-approved plans in `.opencode/plans/<slug>.md`.

Use `read_subplan({ "slug": "...", "section": "..." })` or `read_final_plan({ "slug": "...", "section": "..." })` to read a single markdown heading section from a large plan.

## Explore fast tool

Conductor registers `explore_fast`, a read-only codebase exploration tool backed by Cursor CLI headless mode and Composer 2 Fast. It packages the explore system prompt at `prompts/explore.txt`, so the behavior does not depend on a user-specific OpenCode config path.

The tool expects the Cursor CLI `agent` command to be installed and authenticated. It invokes Cursor with JSON output in print mode:

```bash
agent -p --model composer-2-fast --mode ask --output-format json --workspace <workspace> <prompt>
```

`explore_fast` does not pass `--force` or `--yolo`, constrains optional focus paths to the active workspace, and bounds returned output before handing it back to OpenCode.

## Extraction status

This package is a clean extraction target for the current `/Users/jack.mazac/.config/opencode` orchestration setup. Plan artifact tools and the fast explore prompt/tool live here; future packaging waves can move remaining agent definitions and prompts here without changing behavior.
