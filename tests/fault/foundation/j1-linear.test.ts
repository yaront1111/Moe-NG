/**
 * J1 (small Tuesday bug) fault schedules — design section 18.2.
 *
 * Every entry of the J1 manifest partition is executed here and its produced
 * outcome is compared with the ONE outcome the manifest declared. Nothing is
 * skipped and nothing is hand-picked: the executor map is asserted to equal the
 * partition, so a schedule cannot be dropped without turning this file red.
 */

import { describe, expect, it } from "vitest";

import {
  FOUNDATION_PARTITION_COUNTS,
  foundationPartition,
  resolveEvidenceOutcome,
} from "../../../packages/testkit/src/foundation/foundation-fault-schedule.js";
import {
  J1_AGGREGATE_ONLY_ACTIVATION,
  J1_LINEAR_COMMAND_SEQUENCE,
  J1_REQUIRED_HUMAN_ACTIONS,
  evaluateJ1Journey,
} from "../../../packages/testkit/src/foundation/foundation-model-j1.js";
import {
  J1_AGENT_TEXT,
  J1_WORKED,
  J1_ZERO_WORK,
} from "../../../packages/testkit/src/foundation/foundation-journey-fixtures.js";
import { passExpected } from "../../../packages/testkit/src/foundation/foundation-outcomes-fixtures.js";
import {
  accepted,
  assertPartitionOwnership,
  contracts,
  core,
  executorFor,
  fixturePayload,
  missingEvidenceOf,
  outcomeFromVerdict,
  partitionRows,
  produceAbsenceOutcome,
  refused,
} from "./foundation-harness.js";
import type { FoundationExecutors } from "./foundation-harness.js";

const PARTITION = foundationPartition("J1");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Drives the landed reducers along the linear J1 path and returns the final goal. */
function driveLinearPath() {
  const registered = accepted(core.reduceProject(undefined, {
    commandId: "cmd-register", expectedVersion: 0, kind: "project.register",
    owner: "owner-1", projectId: "project-1",
  }), "project.register");

  const bound = accepted(core.reduceProject(registered.state, {
    commandId: "cmd-bind", expectedVersion: registered.state.version,
    kind: "project.bind_repository",
    observation: {
      baseRevisionHash: HASH_A, repositoryRef: "repo-1", scopeRef: "scope-1",
      truthClass: "OBSERVED",
    },
  }), "project.bind_repository");

  const active = accepted(core.reduceProject(bound.state, {
    commandId: "cmd-activate", expectedVersion: bound.state.version, kind: "project.activate",
    witness: {
      artifactPathRef: "artifacts", backupPathRef: "backups", credentialRef: "credential-1",
      distributionManifestHash: HASH_A, policyRevisionHash: HASH_B,
      providerMinimumProfileRef: "profile-1", signingKeyRef: "key-1",
      storeDriverRef: "sqlite", truthClass: "DAEMON_VERIFIED",
    },
  }), "project.activate");
  expect(active.state.lifecycle).toBe("READY");

  const created = accepted(core.reduceGoal(undefined, {
    budgetAccountRef: "budget-1", commandId: "cmd-goal-create", expectedVersion: 0,
    goalId: "goal-1", kind: "goal.create", planningRunRef: "planning-1",
    projectId: "project-1",
    witness: { projectReadyRef: "project-1", truthClass: "DAEMON_VERIFIED" },
  }), "goal.create");
  expect(created.state.lifecycle).toBe("DRAFT");

  const enabled = accepted(core.reduceGoal(created.state, {
    commandId: "cmd-activate-graph", expectedVersion: created.state.version,
    kind: "goal.activate_initial_graph",
    witness: {
      activeGraphRevisionRef: "revision-1", graphApprovalRef: "approval-1",
      truthClass: "HUMAN_APPROVED",
    },
  }), "goal.activate_initial_graph");
  expect(enabled.state.lifecycle).toBe("EXECUTION_ENABLED");
  return enabled.state;
}

/** The exact plan/initial-graph approval, through the landed revision reducer. */
function driveGraphApproval() {
  const created = accepted(core.reduceGraphRevision(undefined, {
    commandId: "cmd-revision-create", expectedVersion: 0, goalRef: "goal-1",
    graphContentHash: HASH_A, kind: "graph_revision.create", planHash: HASH_B,
    revisionId: "revision-1",
  }), "graph_revision.create");

  const submitted = accepted(core.reduceGraphRevision(created.state, {
    commandId: "cmd-revision-submit", expectedVersion: created.state.version,
    kind: "graph_revision.submit",
    witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
  }), "graph_revision.submit");
  expect(submitted.state.lifecycle).toBe("PENDING_APPROVAL");

  const approved = accepted(core.reduceGraphRevision(submitted.state, {
    approval: {
      approvalRef: "approval-1", budgetHash: HASH_A, expectedGoalVersion: 1,
      graphHash: HASH_A, policyHash: HASH_B, qualityHash: HASH_B,
      truthClass: "HUMAN_APPROVED",
    },
    commandId: "cmd-revision-approve", expectedVersion: submitted.state.version,
    kind: "graph.approve",
  }), "graph.approve");
  expect(approved.state.lifecycle).toBe("APPROVED");
  return approved.state;
}

const EXECUTORS: FoundationExecutors = {
  "fixture:j1-linear-happy-path": () =>
    outcomeFromVerdict(
      evaluateJ1Journey(fixturePayload("fixture:j1-linear-happy-path", J1_WORKED)),
    ),
  "fixture:j1-zero-work-false-green": () =>
    outcomeFromVerdict(
      evaluateJ1Journey(fixturePayload("fixture:j1-zero-work-false-green", J1_ZERO_WORK)),
    ),
  "fixture:j1-agent-text-as-gate": () =>
    outcomeFromVerdict(
      evaluateJ1Journey(fixturePayload("fixture:j1-agent-text-as-gate", J1_AGENT_TEXT)),
    ),

  "schedule:j1-linear-approval-path-executes": () => {
    const goal = driveLinearPath();
    const revision = driveGraphApproval();
    expect(goal.activeGraphRevisionRef).toBe("revision-1");
    expect(revision.lifecycle).toBe("APPROVED");
    return passExpected();
  },

  "schedule:j1-zero-work-false-green-refused": () => {
    const worked = fixturePayload("fixture:j1-linear-happy-path", J1_WORKED);
    const noop = {
      ...worked,
      attempt: {
        agentClaimsGreen: true, artifactRefs: [], attemptRef: "attempt/none",
        changedPaths: [], receipts: [],
      },
    };
    expect(evaluateJ1Journey(noop)).toEqual({ ok: false, refusal: "J1_ZERO_WORK_FALSE_GREEN" });
    expect(evaluateJ1Journey(worked).ok).toBe(true);
    return passExpected();
  },

  "schedule:j1-agent-text-cannot-satisfy-gate": () => {
    const narrated = fixturePayload("fixture:j1-agent-text-as-gate", J1_AGENT_TEXT);
    expect(evaluateJ1Journey(narrated)).toEqual({ ok: false, refusal: "J1_AGENT_TEXT_AS_GATE" });
    return passExpected();
  },

  "schedule:j1-acceptance-requires-proof": () => {
    const worked = fixturePayload("fixture:j1-linear-happy-path", J1_WORKED);
    const unproven = { ...worked, acceptanceProofRef: null };
    expect(evaluateJ1Journey(unproven)).toEqual({
      ok: false, refusal: "J1_ACCEPTANCE_WITHOUT_PROOF",
    });
    return passExpected();
  },

  "schedule:j1-cancel-start-race-aggregate-arbitration": () => {
    const enabled = driveLinearPath();
    const cancelled = accepted(core.reduceGoal(enabled, {
      commandId: "cmd-cancel", expectedVersion: enabled.version, kind: "goal.cancel",
      witness: {
        authorizationRef: "authorization-1", subordinateAuthorityFenced: true,
        truthClass: "HUMAN_APPROVED",
      },
    }), "goal.cancel");
    expect(cancelled.state.lifecycle).toBe("CANCELLED");

    const late = refused(core.reduceGoal(cancelled.state, {
      commandId: "cmd-late-start", expectedVersion: cancelled.state.version,
      kind: "goal.activate_initial_graph",
      witness: {
        activeGraphRevisionRef: "revision-2", graphApprovalRef: "approval-2",
        truthClass: "HUMAN_APPROVED",
      },
    }), "goal.activate_initial_graph after cancel");
    expect(late.error.code).toBe("ILLEGAL_TRANSITION");
    expect(late.error.details.sourceState).toBe("CANCELLED");
    return passExpected();
  },

  "schedule:j1-cancel-start-race-inflight-attempt": (entry) => produceAbsenceOutcome(entry),
  "schedule:j1-execution-dispatch-composition": (entry) => produceAbsenceOutcome(entry),
  "incident:hot-claim-loop-on-gated-work": (entry) => produceAbsenceOutcome(entry),

  "schedule:j1-control-plane-overhead": (entry) =>
    resolveEvidenceOutcome([], missingEvidenceOf(entry)),
};

describe("J1 linear journey fault schedules", () => {
  it("owns exactly the J1 manifest partition", () => {
    assertPartitionOwnership(PARTITION, EXECUTORS, FOUNDATION_PARTITION_COUNTS.J1);
  });

  it("keeps the model's command claims true against the landed vocabulary", () => {
    for (const kind of J1_LINEAR_COMMAND_SEQUENCE) {
      expect(contracts.RUNTIME_COMMAND_KINDS).toContain(kind);
    }
    // Landed on the GOAL aggregate, absent from the runtime vocabulary. Asserting
    // the divergence keeps it from being quietly "fixed" by a wrong assumption.
    expect(contracts.RUNTIME_COMMAND_KINDS).not.toContain(J1_AGGREGATE_ONLY_ACTIVATION);
    expect(core.GOAL_COMMAND_KINDS).toContain(J1_AGGREGATE_ONLY_ACTIVATION);
    expect([...J1_REQUIRED_HUMAN_ACTIONS]).toEqual([
      "goal.create", "graph.approve", "acceptance.final",
    ]);
  });

  it.each(partitionRows(PARTITION))("%s produces its declared outcome", (entryId, entry) => {
    expect(executorFor(EXECUTORS, entryId)(entry)).toEqual(entry.outcome);
  });
});
