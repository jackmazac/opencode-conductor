# Extraction Plan

1. Move prompt templates from `/Users/jack.mazac/.config/opencode/prompts` into this package. The explore prompt lives at `prompts/explore.txt` for `explore` / `explore-high` subagents.
2. Move plan/audit/progress/status/journal tool implementations behind stable exports.
3. Export an OpenCode plugin that registers the same agents and tool permissions currently configured in `opencode.json`.
4. Keep Engram integration optional through the bridge contract. Conductor may ask for `memory_context`; it must not require Engram to load.
5. Add package-level typecheck and a local install smoke test.
