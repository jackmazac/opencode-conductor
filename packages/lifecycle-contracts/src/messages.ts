import { agentMessageSchema, type AgentMessageSeverity } from "../../bridge-contracts/src/index.ts";
import type { AgentMessage } from "../../bridge-contracts/src/messages.ts";
import type { LifecycleDecision } from "./decisions.ts";

const severityMap: Record<LifecycleDecision["severity"], AgentMessageSeverity> = {
  allow: "info",
  warn: "warn",
  block: "block",
};

export function renderLifecycleDecisionMessage(decision: LifecycleDecision): AgentMessage {
  return agentMessageSchema.parse({
    message_id: decision.decision_id,
    severity: severityMap[decision.severity],
    violated_rule: decision.reason_code,
    affected_object: decision.object_id,
    canonical_source:
      decision.object && "path" in decision.object ? decision.object.path : decision.object?.id,
    remediation: {
      summary: decision.remediation.summary,
      source_paths: decision.remediation.source_paths,
      commands: decision.remediation.commands,
      refs: decision.evidence_refs.map((ref) => ref.artifact_id),
    },
    source_plugin: decision.module,
    source_module: decision.module,
  });
}
