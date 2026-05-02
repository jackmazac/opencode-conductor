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

## Extraction status

This package is a clean extraction target for the current `/Users/jack.mazac/.config/opencode` orchestration setup. Plan artifact tools live here; future packaging waves can move agent definitions and prompts here without changing behavior.
