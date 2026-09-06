/**
 * RECORDED DAEMON FRAMES - the post-REJECT affordance surface, not hand-written.
 *
 * Captured 2026-09-06 off the shipped production seams, by a throwaway recorder under
 * apps/daemon/src/http/ that drove `rejectedWorld()` from
 * `apps/daemon/src/planning/plan-reject-test-fixtures.ts` (bound goal -> committed revision ->
 * Gate 1 approved -> compiler's INITIAL chain to PLAN_REVIEW -> `approval.decide_intent` REJECT)
 * and serialised `createAffordancePort(...).readSurface()` VERBATIM. That value is exactly what
 * `POST /affordances/read` writes to the wire - `http-listener-command-stream-routes.ts:272` is
 * `reply(response, 200, options.affordances.readSurface())` - so these are the browser's real
 * bytes, not a shape someone believed the daemon produces. The recorder was deleted in the same
 * step; this file is its output.
 *
 * REJECTED run "run-1", SUCCESSOR run "run-ab155dbf7a69b4415eb25141", goal "goal-1".
 *
 *  - AFTER_REJECT_FRAME: the operator has just sent the plan back. NO `approval.decide_intent`
 *    for any run, `planning.submit_decomposition` offered on the goal, and `planningGoalRefs`
 *    binding ONLY the successor - the rejected run is bound to nothing.
 *  - AFTER_COMPILE_FRAME: the compiler has replanned. `approval.decide_intent` and
 *    `approval.decide` are back, both on the SUCCESSOR, and the compiler card is spent.
 *
 * Both are fed through the REAL decoder (`frameOfSurface`), so a frame that drifted from the
 * daemon's shape fails at the decoder rather than passing a softened assertion.
 */

/** Read back from the frames rather than respelled beside an assertion. */
export const RECORDED = Object.freeze({
  goalId: "goal-1",
  rejectedRunId: "run-1",
  successorRunId: "run-ab155dbf7a69b4415eb25141",
});

export const AFTER_REJECT_FRAME: unknown = Object.freeze({
  "nextAllowedCommands": [
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-1",
      "commandKind": "planning.submit_decomposition",
      "expectedVersion": 1,
      "inputSchemaVersion": "moe-product-contract-compiler/1",
      "targetAggregateId": "goal-1"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-2",
      "commandKind": "goal.create",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "goal-rec-2"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-3",
      "commandKind": "goal.create_with_source",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "goal-rec-3"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-4",
      "commandKind": "policy.install",
      "expectedVersion": 3,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "project-1-policy"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-5",
      "commandKind": "repository.bootstrap",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "project-1-bootstrap"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-6",
      "commandKind": "session.open",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/sess-ui-1"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-7",
      "commandKind": "session.close",
      "expectedVersion": 1,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-8",
      "commandKind": "session.renew",
      "expectedVersion": 1,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5"
    }
  ],
  "outcome": "SURFACE",
  "planningAuthorityByRun": {},
  "planningGoalRefs": {
    "run-ab155dbf7a69b4415eb25141": "goal-1"
  },
  "planningGoalRef": null,
  "steps": [
    {
      "aggregateId": null,
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "approval.decide",
      "missing": [
        "plan.propose"
      ],
      "status": "BLOCKED",
      "version": null
    },
    {
      "aggregateId": "goal-rec-2",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.create",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "goal-rec-3",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.create_with_source",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "run-live-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "plan.propose",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "project-1-policy",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "policy.install",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1-policy",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "policy.validate",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.activate",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.bind_repository",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.register",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1-provider",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "provider.probe",
      "missing": [],
      "status": "COMMITTED",
      "version": 1
    },
    {
      "aggregateId": "goal-live-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.close",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "publish:project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "repository.publish",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "project-1-bootstrap",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "repository.bootstrap",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "goal-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "planning.submit_decomposition",
      "missing": [],
      "status": "READY",
      "version": 1
    },
    {
      "aggregateId": "session/sess-ui-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.open",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.close",
      "missing": [],
      "status": "READY",
      "version": 1
    },
    {
      "aggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.renew",
      "missing": [],
      "status": "READY",
      "version": 1
    }
  ]
});

export const AFTER_COMPILE_FRAME: unknown = Object.freeze({
  "nextAllowedCommands": [
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-9",
      "commandKind": "approval.decide",
      "expectedVersion": 3,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "run-ab155dbf7a69b4415eb25141"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-10",
      "commandKind": "approval.decide_intent",
      "expectedVersion": 3,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "run-ab155dbf7a69b4415eb25141"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-11",
      "commandKind": "goal.create",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "goal-rec-11"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-12",
      "commandKind": "goal.create_with_source",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "goal-rec-12"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-13",
      "commandKind": "policy.install",
      "expectedVersion": 3,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "project-1-policy"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-14",
      "commandKind": "repository.bootstrap",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-bootstrap-command/1",
      "targetAggregateId": "project-1-bootstrap"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-15",
      "commandKind": "session.open",
      "expectedVersion": 0,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/sess-ui-1"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-16",
      "commandKind": "session.close",
      "expectedVersion": 1,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5"
    },
    {
      "commandEnvelopeVersion": "moe-runtime-command/1",
      "commandId": "rec-17",
      "commandKind": "session.renew",
      "expectedVersion": 1,
      "inputSchemaVersion": "moe-session-command/1",
      "targetAggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5"
    }
  ],
  "outcome": "SURFACE",
  "planningAuthorityByRun": {},
  "planningGoalRefs": {
    "run-ab155dbf7a69b4415eb25141": "goal-1"
  },
  "planningGoalRef": null,
  "steps": [
    {
      "aggregateId": "run-ab155dbf7a69b4415eb25141",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "approval.decide",
      "missing": [],
      "status": "READY",
      "version": 3
    },
    {
      "aggregateId": "goal-rec-11",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.create",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "goal-rec-12",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.create_with_source",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "run-ab155dbf7a69b4415eb25141",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "plan.propose",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1-policy",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "policy.install",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1-policy",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "policy.validate",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.activate",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.bind_repository",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "project.register",
      "missing": [],
      "status": "COMMITTED",
      "version": 3
    },
    {
      "aggregateId": "project-1-provider",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "provider.probe",
      "missing": [],
      "status": "COMMITTED",
      "version": 1
    },
    {
      "aggregateId": "goal-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "goal.close",
      "missing": [],
      "status": "READY",
      "version": 1
    },
    {
      "aggregateId": "publish:goal-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "repository.publish",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "project-1-bootstrap",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "repository.bootstrap",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "session/sess-ui-1",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.open",
      "missing": [],
      "status": "READY",
      "version": 0
    },
    {
      "aggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.close",
      "missing": [],
      "status": "READY",
      "version": 1
    },
    {
      "aggregateId": "session/fb12dfc4-8b11-48de-9676-6b477c76a4a5",
      "claim": null,
      "claimAggregateVersion": 0,
      "kind": "session.renew",
      "missing": [],
      "status": "READY",
      "version": 1
    }
  ]
});
