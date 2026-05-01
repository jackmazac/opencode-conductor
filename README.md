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

## Current scaffold

This package is a clean extraction target for the current `/Users/jack.mazac/.config/opencode` orchestration setup. The first packaging wave should move agent definitions, prompts, and artifact tools here without changing behavior.
