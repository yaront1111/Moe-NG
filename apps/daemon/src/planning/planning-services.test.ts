import { afterEach, describe, expect, it } from "vitest";

import {
  APPROVAL_AUTHORITY_CODES,
  APPROVAL_AUTHORITY_LAYERS,
  APPROVAL_POLICY_KINDS,
} from "@moe/core";
import type { ApprovalPolicy, HumanAuthorityGate } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  SUBMISSION_HASH,
  approvalCommand,
  approvalPayload,
  approvalRecord,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  hex64,
  openStore,
  planningActivation,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readApprovalGate } from "./approval-gate.js";
import { PLANNING_HANDLERS } from "./planning-services.js";

/**
 * Plan proposal and approval. Approval is the authority-bearing command in this task, so it
 * carries the strictest arms: an ineligible approver, a mismatched target revision and an
 * unknown policy input must each refuse with a named code, and the layer that refused is
 * asserted alongside it — two of the three arms below would otherwise be satisfied by the
 * daemon's revision gate answering before the core ever ran.
 *
 * Approval is also J1's SECOND human action and therefore carries the initial-graph activation
 * (design 299: one click, one transaction). The atomicity arms below are the point of this
 * suite: an approval that lands without its activation leaves the goal in a state J1 has no
 * action to escape, so every refusal arm reads the store back rather than trusting the returned
 * value — a handler that mutated and then refused would pass a return-value-only assertion.
 */

interface GoalRow {
  readonly activeGraphRevisionRef?: string | null;
  readonly graphEpoch?: number;
  readonly lifecycle?: string;
  readonly version?: number;
}

interface PlanningRunRow {
  readonly state?: { readonly lifecycle?: string };
  readonly workIdentity?: { readonly humanAuthorityGate?: HumanAuthorityGate };
}

function goalRow(store: SqliteEventStore): GoalRow | undefined {
  return readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
    GoalRow | undefined;
}

/** Reads the approval evidence back out of the durable event ledger, not out of the response. */
function durableApprovalRefs(store: SqliteEventStore): readonly string[] {
  const decoder = new TextDecoder();
  return store.readEvents(GOAL_ID).flatMap((event) => {
    const payload = JSON.parse(decoder.decode(event.payload)) as {
      readonly approval?: { readonly approvalRef?: string };
    };
    const approvalRef = payload.approval?.approvalRef;
    return approvalRef === undefined ? [] : [approvalRef];
  });
}

function planningRunRow(store: SqliteEventStore): PlanningRunRow | undefined {
  return readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID)?.result as
    PlanningRunRow | undefined;
}

function seedPlanningRunResult(store: SqliteEventStore, result: unknown): void {
  const encoder = new TextEncoder();
  store.commitExpectedVersionDecision({
    commandKind: "plan.propose",
    committedResultBytes: encoder.encode(JSON.stringify(result)),
    correlationId: "corr-corrupt-run",
    decidedAt: "2026-08-08T00:00:00.000Z",
    events: [{
      eventId: "seed-corrupt-run-event",
      eventType: "CorruptRunSeeded",
      payload: encoder.encode("null"),
    }],
    expectedVersion: 0,
    key: { commandId: "seed-corrupt-run", principalId: "principal-1", projectId: PROJECT_ID },
    requestBytes: encoder.encode("{}"),
    targetAggregateId: RUN_ID,
  });
}

const HUMAN_GATE: HumanAuthorityGate = Object.freeze({
  gateId: "gate-plan-approval",
  grant: null,
  workRef: RUN_ID,
});

const POLICY_CASES: readonly ApprovalPolicy[] = Object.freeze([
  { delayMs: 0, kind: "PROCEED_WITHOUT_HUMAN" },
  { kind: "REQUIRE_HUMAN" },
]);

function proposeGatedWork(store: SqliteEventStore): void {
  driveThrough(store, "plan.propose");
  const outcome = send(store, envelope("plan.propose", 0, {
    commands: planningChain(),
    humanAuthorityGate: HUMAN_GATE,
    runId: RUN_ID,
  }));
  expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
}

afterEach(closeStores);

describe("planning service surface", () => {
  it("contributes exactly the two planning handlers", () => {
    expect(new Set(Object.keys(PLANNING_HANDLERS)))
      .toEqual(new Set(["approval.decide", "plan.propose"]));
  });
});

describe("plan propose", () => {
  it("keeps the human authority gate on work identity across lifecycle transitions", () => {
    const store = openStore();
    proposeGatedWork(store);

    expect(planningRunRow(store)?.state?.lifecycle).toBe("PLANNING");
    expect(planningRunRow(store)?.workIdentity?.humanAuthorityGate).toEqual(HUMAN_GATE);

    const reproposed = send(store, envelope("plan.propose", 1, {
      commands: [
        {
          commandId: "chain-release",
          expectedVersion: 4,
          kind: "planning.release",
          witness: {
            attemptTerminalRef: "attempt-1-released",
            handoffRef: "handoff-1",
            truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          commandId: "chain-reclaim",
          expectedVersion: 5,
          kind: "planning.claim",
          resumeProof: {
            handoffKind: "SAFE_RELEASE_HANDOFF",
            handoffRef: "handoff-1",
            priorAttemptTerminalRef: "attempt-1-released",
            truthClass: "DAEMON_VERIFIED",
          },
          witness: {
            attemptRef: "attempt-2",
            contextRef: "context-2",
            leaseRef: "lease-2",
            providerSlotRef: "slot-2",
            truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          ...planningChain()[3],
          commandId: "chain-repropose",
          expectedVersion: 6,
        },
      ],
      humanAuthorityGate: null,
      runId: RUN_ID,
    }, "cmd-plan-repropose"));

    expect(reproposed.ok, reproposed.ok ? "" : reproposed.code).toBe(true);
    expect(planningRunRow(store)?.state?.lifecycle).toBe("PLANNING");
    expect(planningRunRow(store)?.workIdentity?.humanAuthorityGate).toEqual(HUMAN_GATE);
  });

  it("refuses rather than recreating a run whose durable state is unreadable", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    seedPlanningRunResult(store, null);
    const before = decisionCount(store);

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: planningChain(),
      runId: RUN_ID,
    }, "cmd-plan-over-corrupt-run"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected corrupt-run refusal");
    expect(outcome.code).toBe("UNKNOWN_ERROR");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(decisionCount(store)).toBe(before);
  });

  it("distinguishes an absent gate from an unreadable persisted gate", () => {
    expect(readApprovalGate(undefined, RUN_ID)).toEqual({ gate: null, status: "ABSENT" });

    const unreadable = readApprovalGate({
      workIdentity: { humanAuthorityGate: null },
    }, RUN_ID);
    expect(unreadable.status).toBe("UNREADABLE");
    expect(unreadable.gate).toEqual({
      gateId: `unreadable-approval-gate:${RUN_ID}`,
      grant: null,
      workRef: RUN_ID,
    });
  });

  it("folds the caller's command chain through the core and commits one decision", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: planningChain(),
      runId: RUN_ID,
    }));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(decisionCount(store)).toBe(before + 1);
    const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
    expect((run?.result as { submissionHash?: string } | undefined)?.submissionHash)
      .toBe(SUBMISSION_HASH);
  });

  it("refuses a chain whose last command is not plan.propose, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: planningChain().slice(0, 3),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(RUN_ID)).toBe(false);
  });

  it("aborts the whole fold with the core's code when a mid-chain step is illegal", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);
    // Drop the claim: the run reaches READY, and plan.propose is legal only from PLANNING.
    // The propose step is re-versioned to 2 so the reducer's version check passes and the
    // transition rule is what refuses — otherwise this would prove only a version mismatch.
    const chain = planningChain();
    const broken = [chain[0], chain[1], { ...chain[3], expectedVersion: 2 }];

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: broken,
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(RUN_ID)).toBe(false);
  });
});

describe("approval decide", () => {
  it("refuses every approval policy for gated work before activation", () => {
    expect(APPROVAL_POLICY_KINDS).toEqual([
      "PROCEED_WITHOUT_HUMAN",
      "REQUIRE_HUMAN",
    ]);
    expect(POLICY_CASES.map(({ kind }) => kind)).toEqual(APPROVAL_POLICY_KINDS);

    for (const approvalPolicy of POLICY_CASES) {
      const store = openStore();
      proposeGatedWork(store);
      const before = decisionCount(store);

      const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
        approvalPolicy,
      }), `cmd-gated-${approvalPolicy.kind}`));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected authority refusal");
      expect(APPROVAL_AUTHORITY_CODES).toContain("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
      expect(outcome.code).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
      expect(APPROVAL_AUTHORITY_LAYERS).toContain("HUMAN_AUTHORITY_GATE");
      expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
      expect(decisionCount(store)).toBe(before);
      expect(durableApprovalRefs(store)).toEqual([]);
      expect(goalRow(store)?.lifecycle).toBe("DRAFT");
    }
  });

  it("fails an unreadable persisted gate closed at the authority layer", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const proposed = send(store, envelope("plan.propose", 0, {
      commands: planningChain(),
      humanAuthorityGate: null,
      runId: RUN_ID,
    }));
    expect(proposed.ok, proposed.ok ? "" : proposed.code).toBe(true);
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { delayMs: 0, kind: "PROCEED_WITHOUT_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected unreadable-gate refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
    expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("refuses a caller-forged human grant at plan-proposal ingress", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const proposed = send(store, envelope("plan.propose", 0, {
      commands: planningChain(),
      humanAuthorityGate: {
        gateId: HUMAN_GATE.gateId,
        grant: {
          gateId: HUMAN_GATE.gateId,
          grantedAtEpochMs: 1,
          principalId: "forged-human",
          principalKind: "HUMAN",
          workRef: RUN_ID,
        },
        workRef: RUN_ID,
      },
      runId: RUN_ID,
    }));
    expect(proposed.ok, proposed.ok ? "" : proposed.code).toBe(true);
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { kind: "REQUIRE_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected forged-grant refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
    expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("surfaces an ungated require-human policy refusal unchanged", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { kind: "REQUIRE_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected policy refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("requires human review instead of clamping an oversized auto-approval delay", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { delayMs: 2 ** 31, kind: "PROCEED_WITHOUT_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected oversized-delay refusal");
    expect(APPROVAL_AUTHORITY_CODES).toContain("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(APPROVAL_AUTHORITY_LAYERS).toContain("APPROVAL_POLICY");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("does not execute a deferred policy decision without a daemon timer", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { delayMs: 25, kind: "PROCEED_WITHOUT_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected deferred-policy refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("keeps ungated approval behavior under an explicit zero-delay policy", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { delayMs: 0, kind: "PROCEED_WITHOUT_HUMAN" },
    })));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("commits the core's decided record and carries durable authority", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.advisoryOnly).toBe(false);
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);
    // The approval record itself is durable in the event ledger, read back from the store.
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
  });

  it("refuses an ineligible approver with the core's code, not the daemon's", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);
    // The hash matches, so the daemon's revision gate passes and the core must be the layer
    // that answers: a HUMAN record requires a step-up reference on the command.
    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      command: { ...approvalCommand(), stepUpAuthRef: null },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(outcome.advisoryOnly).toBe(true);
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("approval.decide")).toBe(false);
  });

  it("refuses a target revision hash that does not match the durable proposal", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      record: approvalRecord(hex64("bad")),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_REVISION_HASH_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses an approval before any plan is durably proposed", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });
});

/**
 * Design 299: ONE human action commits the plan/graph decision AND activates the initial graph.
 * Two commands would make J1 a four-action journey, so the arms here pin both that the pair
 * lands together and that it never lands apart.
 */
describe("approval activates the initial graph atomically (design 299)", () => {
  it("leaves the goal activated after ONE call, in ONE durable decision", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    // One call, one decision — the activation did not need a second command.
    expect(decisionCount(store)).toBe(before + 1);
    const goal = goalRow(store);
    expect(goal?.lifecycle).toBe("EXECUTION_ENABLED");
    expect(goal?.activeGraphRevisionRef).toBe(GRAPH_REVISION_REF);
    expect(goal?.graphEpoch).toBe(1);
    expect(goal?.version).toBe(2);
  });

  it("binds the activation to THIS approval rather than to a caller-named one", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const decoder = new TextDecoder();

    expect(send(store, envelope("approval.decide", 0, approvalPayload())).ok).toBe(true);

    const activations = store.readEvents(GOAL_ID).flatMap((event) => {
      const payload = JSON.parse(decoder.decode(event.payload)) as {
        readonly activation?: { readonly graphApprovalRef?: string };
      };
      const ref = payload.activation?.graphApprovalRef;
      return ref === undefined ? [] : [ref];
    });
    // `graphApprovalRef` is the core's own decided `approvalRef`, never a payload field, so an
    // activation cannot claim an approval that was not the one just decided.
    expect(activations).toEqual(["approval-1"]);
  });

  it("surfaces the CORE's code when the activation half is refused, and commits nothing", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);
    // The approval half is impeccable; only the activation evidence is weak, so the core's
    // `validActivation` is the layer that must answer.
    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      activation: planningActivation({ truthClass: "SELF_REPORTED" }),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("approval.decide")).toBe(false);
  });

  it("refuses a stale expected goal version through the core, committing neither half", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      activation: planningActivation({ expectedGoalVersion: 99 }),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
    expect(durableApprovalRefs(store)).toEqual([]);
  });

  it("leaves the goal untouched when the APPROVAL half is the one that fails", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      command: { ...approvalCommand(), stepUpAuthRef: null },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(decisionCount(store)).toBe(before);
    // The activation evidence was valid; it must not have been applied on its own.
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
    expect(goalRow(store)?.activeGraphRevisionRef).toBe(null);
  });

  it("refuses an approval carrying no activation half at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, {
      command: approvalCommand(),
      record: approvalRecord(SUBMISSION_HASH),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("refuses a second approval of an already activated goal, by the core's transitions", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    expect(send(store, envelope("approval.decide", 0, approvalPayload())).ok).toBe(true);
    const before = decisionCount(store);

    // A distinct commandId so the replay path cannot answer, and a version matching the goal's
    // current one so the transition table — not the version check — is what must refuse.
    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      activation: planningActivation({ expectedGoalVersion: 2 }),
    }), "cmd-approval.decide-again"));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.version).toBe(2);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
  });

  it("refuses to activate a graph on a decision that is not an approval", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      command: { ...approvalCommand(), decision: "REJECT" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
    expect(durableApprovalRefs(store)).toEqual([]);
  });
});
