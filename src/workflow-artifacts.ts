import type { ToolDefinition } from "@opencode-ai/plugin";
import { artifactIndex } from "./workflow-tools/artifact-index";
import * as audit from "./workflow-tools/audit";
import * as auditProgress from "./workflow-tools/audit-progress";
import { changelogEmit } from "./workflow-tools/changelog-emit";
import { commit } from "./workflow-tools/commit";
import * as conflictContext from "./workflow-tools/conflict-context";
import * as concordIngest from "./workflow-tools/concord-ingest";
import { createContextUsageTool, type ContextUsageClient } from "./workflow-tools/context-usage";
import { driftCheck } from "./workflow-tools/drift-check";
import * as handoff from "./workflow-tools/handoff";
import * as journal from "./workflow-tools/journal";
import { planValidate } from "./workflow-tools/plan-validate";
import * as progress from "./workflow-tools/progress";
import * as run from "./workflow-tools/run";
import { sessionInit } from "./workflow-tools/session-init";
import { spineQuery } from "./workflow-tools/spine-query";
import * as status from "./workflow-tools/status";
import { taskDispatch } from "./workflow-tools/task-dispatch";
import { workspaceInfo } from "./workflow-tools/workspace-info";

export function createWorkflowArtifactTools(
  input: { contextUsageClient?: ContextUsageClient } = {},
): Record<string, ToolDefinition> {
  return {
    artifact_index: artifactIndex,
    audit_write: audit.write,
    audit_read: audit.read,
    audit_done: audit.done,
    audit_progress_update: auditProgress.update,
    audit_progress_read: auditProgress.read,
    audit_progress_done: auditProgress.done,
    changelog_emit: changelogEmit,
    commit: commit,
    conflict_context: conflictContext.context,
    context_usage: createContextUsageTool(input.contextUsageClient),
    drift_check: driftCheck,
    lifecycle_concord_ingest: concordIngest.ingest,
    handoff_write: handoff.write,
    handoff_read: handoff.read,
    handoff_done: handoff.done,
    journal_write: journal.write,
    journal_read: journal.read,
    journal_search: journal.search,
    journal_done: journal.done,
    plan_validate: planValidate,
    progress_update: progress.update,
    progress_read: progress.read,
    progress_done: progress.done,
    run_init: run.init,
    run_update: run.update,
    run_list: run.list,
    run_finish: run.finish,
    session_init: sessionInit,
    spine_query: spineQuery,
    status_write: status.write,
    status_read: status.read,
    status_done: status.done,
    task_dispatch: taskDispatch,
    workspace_info: workspaceInfo,
  };
}
