# Concord Integration

Concord is the working-tree coordination source for concurrent OpenCode agents.

Boundary:

- Concord owns live file/range reservations, lock expiry, stale-read tracking, and conflict guidance.
- Lifecycle Integrity owns lifecycle object identity, artifact evidence, and source-of-truth decisions.
- Lifecycle modules may import Concord collision events as evidence.
- Lifecycle modules must not reinterpret or replace `<concord_conflict>` guidance.

Contract shape:

- `ConcordCorrelationRef` carries Concord correlation, plan, and intent fields.
- `ConcordCollisionArtifactRef` stores versioned collision evidence with file/range scope.
- `ExternalGuidanceEnvelope` preserves Concord XML guidance as a content-addressed artifact.

Usage:

- If an edit is blocked by Concord, show Concord's guidance directly.
- If a lifecycle decision references a Concord collision, store it as evidence, not as the decision itself.
- If future Concord metadata accepts lifecycle IDs, pass `decision_id`, `object_id`, and spine `correlation_id` through without changing Concord's lock semantics.
