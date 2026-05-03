import type { ToolDefinition } from "@opencode-ai/plugin";
import * as audit from "./workflow-tools/audit";
import * as auditProgress from "./workflow-tools/audit-progress";
import * as conflictContext from "./workflow-tools/conflict-context";
import * as concordIngest from "./workflow-tools/concord-ingest";
import * as handoff from "./workflow-tools/handoff";
import * as journal from "./workflow-tools/journal";
import * as progress from "./workflow-tools/progress";
import * as run from "./workflow-tools/run";
import * as status from "./workflow-tools/status";

export function createWorkflowArtifactTools(): Record<string, ToolDefinition> {
  return {
    audit_write: audit.write,
    audit_read: audit.read,
    audit_done: audit.done,
    audit_progress_update: auditProgress.update,
    audit_progress_read: auditProgress.read,
    audit_progress_done: auditProgress.done,
    conflict_context: conflictContext.context,
    lifecycle_concord_ingest: concordIngest.ingest,
    handoff_write: handoff.write,
    handoff_read: handoff.read,
    handoff_done: handoff.done,
    journal_write: journal.write,
    journal_read: journal.read,
    journal_done: journal.done,
    progress_update: progress.update,
    progress_read: progress.read,
    progress_done: progress.done,
    run_init: run.init,
    run_update: run.update,
    run_finish: run.finish,
    status_write: status.write,
    status_read: status.read,
    status_done: status.done,
  };
}
