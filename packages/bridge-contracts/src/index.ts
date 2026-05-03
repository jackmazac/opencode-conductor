/**
 * packages/bridge-contracts/src/index.ts
 *
 * Public API surface for @opencode/bridge-contracts.
 * Re-exports all schemas, types, and runtime helpers from the event and
 * message sub-modules.
 *
 * Spine executor and lifecycle modules should import from this barrel or
 * directly from the sub-module. Both paths are stable exports.
 */

export {
  // Schemas
  eventKindSchema,
  appendEventInputSchema,
  pluginEventSchema,
  freshnessSchema,
  freshQueryResultSchema,
  // Types
} from "./events.ts";

export type {
  EventKind,
  AppendEventInput,
  PluginEvent,
  Freshness,
  FreshQueryResult,
} from "./events.ts";

export {
  // Schemas
  agentMessageSeveritySchema,
  agentRemediationSchema,
  agentMessageSchema,
  // Types
} from "./messages.ts";

export type { AgentMessageSeverity, AgentRemediation, AgentMessage } from "./messages.ts";

export {
  subagentStatusSchema,
  subagentToolCallSchema,
  subagentUsageSchema,
  subagentResultEnvelopeSchema,
  adaptSubagentResult,
  validateSubagentEnvelope,
} from "./subagent.ts";

export type {
  SubagentStatus,
  SubagentToolCall,
  SubagentUsage,
  SubagentResultEnvelope,
} from "./subagent.ts";
