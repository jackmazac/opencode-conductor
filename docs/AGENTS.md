# Conductor Docs Agent Guide

## Tool Args Validation

- Production Conductor tools are wrapped by Host Adapter, which validates runtime args by default. Do not bypass the wrapper for production tool execution.
- Tool `args` schemas are runtime contracts, not just TypeScript hints. If a tool can be called through OpenCode, malformed or missing args must fail before the handler touches `args.<field>`.
- Shared Host Adapter validation should be the first line of defense. Add local parsing only when a helper is exported and called directly in tests or by other code outside the wrapped plugin path.
- Regressions to watch for: `undefined is not an object`, `r.split`, path helpers receiving `undefined`, and file writes receiving missing content. These indicate handler code ran before args were narrowed.
- When adding a workflow tool, add a wrapped-tool regression for at least one required field if the handler writes files or mutates `.opencode/` state.
