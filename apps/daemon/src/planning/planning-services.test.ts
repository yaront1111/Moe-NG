import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_AUTHORITY_CODES,
  APPROVAL_AUTHORITY_LAYERS,
  APPROVAL_POLICY_KINDS,
  decideApprovalAuthority,
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
  sendReviewed,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readApprovalGate } from "./approval-gate.js";
import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_APPROVAL_MODE,
  SPEED_MODE_DELAY_ENV_KEY,
  readApprovalPolicySettings,
} from "./approval-policy-settings.js";
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

/**
 * A gate a named human has already satisfied. It is seeded straight into the durable run
 * because proposal ingress deliberately refuses caller-shaped grant bytes: minting a human
 * is a future authority-bearing writer's job, not a payload's.
 */
const SATISFIED_GATE: HumanAuthorityGate = Object.freeze({
  gateId: "gate-plan-approval",
  grant: Object.freeze({
    gateId: "gate-plan-approval",
    grantedAtEpochMs: 1_760_000_000_000,
    principalId: "human-1",
    principalKind: "HUMAN" as const,
    workRef: RUN_ID,
  }),
  workRef: RUN_ID,
});

type ApprovalEnv = Readonly<Record<string, string | undefined>>;

/** Every settings shape the file can express, and the policy each one decodes to. */
const SETTINGS_CASES: readonly { readonly env: ApprovalEnv; readonly why: string }[] =
  Object.freeze([
    {
      env: { [APPROVAL_MODE_ENV_KEY]: SPEED_APPROVAL_MODE, [SPEED_MODE_DELAY_ENV_KEY]: "0" },
      why: "the most permissive settings expressible: SPEED at a stated zero delay",
    },
    { env: {}, why: "no approval settings at all" },
  ]);

/**
 * States the daemon's approval settings for one test. The read-back is not ceremony: a stub
 * that failed to apply would leave the fixture's authorising settings in place and silently
 * turn every refusal case below into a test of nothing.
 */
function useApprovalSettings(mode: string | undefined, delayMs: string | undefined): void {
  vi.stubEnv(APPROVAL_MODE_ENV_KEY, mode);
  vi.stubEnv(SPEED_MODE_DELAY_ENV_KEY, delayMs);
  expect(process.env[APPROVAL_MODE_ENV_KEY]).toBe(mode);
  expect(process.env[SPEED_MODE_DELAY_ENV_KEY]).toBe(delayMs);
}

function useSettings(env: ApprovalEnv): void {
  useApprovalSettings(env[APPROVAL_MODE_ENV_KEY], env[SPEED_MODE_DELAY_ENV_KEY]);
}

/**
 * TWO APPROVAL_POLICY BRANCHES ANSWER WITH THE SAME CODE: settings that state no policy, and
 * settings that state a delay the consumer then bounds away from immediate. An arm asserting
 * only APPROVAL_HUMAN_REVIEW_REQUIRED cannot say which one refused, so a decoder that quietly
 * defaulted a missing delay to any non-zero number would keep it green. This pins the branch
 * by reading the production decode for the settings actually in force.
 */
function expectUnstatedPolicy(): void {
  expect(readApprovalPolicySettings(process.env)).toEqual({ kind: "REQUIRE_HUMAN" });
}

function proposeGatedWork(store: SqliteEventStore): void {
  driveThrough(store, "plan.propose");
  const outcome = send(store, envelope("plan.propose", 0, {
    commands: planningChain(),
    humanAuthorityGate: HUMAN_GATE,
    runId: RUN_ID,
  }));
  expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
}

/** A durably proposed run carrying an already-satisfied gate, seeded past ingress. */
function proposeGrantedWork(store: SqliteEventStore): void {
  driveThrough(store, "plan.propose");
  seedPlanningRunResult(store, {
    state: { goalRef: GOAL_ID, lifecycle: "PLANNING" },
    submissionHash: SUBMISSION_HASH,
    workIdentity: { humanAuthorityGate: SATISFIED_GATE },
  });
  expect(planningRunRow(store)?.workIdentity?.humanAuthorityGate).toEqual(SATISFIED_GATE);
}

/**
 * The approval for a run THIS SUITE proposed, which is the authority-LESS world: the arms below
 * send a legacy `planningChain()` rather than the shipped `sealedPlanningChain()`, so the run's
 * submission hash is the spelled `SUBMISSION_HASH`. An approval naming the SEALED hash is refused
 * BOOTSTRAP_REVISION_HASH_MISMATCH before it ever reaches the human-authority gate these arms are
 * about (task-074e6d2e), which would answer the refusal at the wrong layer while staying red-free
 * elsewhere. Keeping them legacy also keeps live consumers of the ABSENT arm inside this suite.
 */
const legacyApprovalPayload = (): Record<string, unknown> =>
  approvalPayload({ record: approvalRecord(SUBMISSION_HASH) });

afterEach(closeStores);
afterEach(() => { vi.unstubAllEnvs(); });

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
  it("refuses every settings-decodable approval policy for gated work before activation", () => {
    expect(APPROVAL_POLICY_KINDS).toEqual([
      "PROCEED_WITHOUT_HUMAN",
      "REQUIRE_HUMAN",
    ]);
    // The sweep is over what the SETTINGS FILE can express, and it covers the whole
    // vocabulary: no settings value, and no combination of them, approves gated work.
    const decoded: readonly ApprovalPolicy[] =
      SETTINGS_CASES.map(({ env }) => readApprovalPolicySettings(env));
    expect(decoded.map(({ kind }) => kind)).toEqual(APPROVAL_POLICY_KINDS);
    expect(new Set(decoded.map(({ kind }) => kind)).size).toBe(APPROVAL_POLICY_KINDS.length);

    for (const [index, { env, why }] of SETTINGS_CASES.entries()) {
      useSettings(env);
      const store = openStore();
      proposeGatedWork(store);
      const before = decisionCount(store);

      const outcome = send(store, envelope("approval.decide", 0, legacyApprovalPayload(),
        `cmd-gated-${String(index)}`));

      expect(outcome.ok, why).toBe(false);
      if (outcome.ok) throw new Error("expected authority refusal");
      expect(APPROVAL_AUTHORITY_CODES).toContain("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
      expect(outcome.code, why).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
      expect(APPROVAL_AUTHORITY_LAYERS).toContain("HUMAN_AUTHORITY_GATE");
      expect(outcome.refusedBy, why).toBe("HUMAN_AUTHORITY_GATE");
      expect(decisionCount(store), why).toBe(before);
      expect(durableApprovalRefs(store), why).toEqual([]);
      expect(goalRow(store)?.lifecycle, why).toBe("DRAFT");
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
    // Under the most permissive settings the file can express, so the gate is what answers.
    useApprovalSettings(SPEED_APPROVAL_MODE, "0");

    const outcome = send(store, envelope("approval.decide", 0, legacyApprovalPayload()));

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
    useApprovalSettings(SPEED_APPROVAL_MODE, "0");

    const outcome = send(store, envelope("approval.decide", 0, legacyApprovalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected forged-grant refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
    expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  /**
   * THE REGRESSION. Before the settings binding landed, this handler sourced its policy from a
   * module-level `DEFAULT_APPROVAL_POLICY` of `{kind: "PROCEED_WITHOUT_HUMAN", delayMs: 0}`,
   * and the payload key that could have overridden it was never allow-listed at the seam. So
   * EVERY gate-free approval the daemon made proceeded immediately, on a delay nobody stated —
   * the incident's exact mechanism. Unstated settings must refuse, not default.
   */
  it("refuses gate-free approval when no settings authorise proceeding without a human", () => {
    useApprovalSettings(undefined, undefined);
    expectUnstatedPolicy();
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected unstated-settings refusal");
    expect(APPROVAL_AUTHORITY_CODES).toContain("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(APPROVAL_AUTHORITY_LAYERS).toContain("APPROVAL_POLICY");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("surfaces an ungated require-human policy refusal unchanged", () => {
    useApprovalSettings("QUALITY", "0");
    expectUnstatedPolicy();
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected policy refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("refuses a SPEED mode whose delay the settings never stated", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, undefined);
    expectUnstatedPolicy();
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected unstated-delay refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  /**
   * THE INVERSION. `delayMs` is a safe non-negative integer, wider than `setTimeout` accepts:
   * above 2**31-1 a timer clamps it to 1ms, so the most conservative setting a board can write
   * would become the most permissive thing the daemon does. The core still decides `ok` here —
   * the bound belongs at this consumer, where the timer would live.
   */
  it("requires human review instead of clamping an oversized configured delay", () => {
    const oversized = String(2 ** 31);
    useApprovalSettings(SPEED_APPROVAL_MODE, oversized);
    const decided = decideApprovalAuthority({
      gate: null,
      policy: readApprovalPolicySettings(process.env),
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("the core admits the whole safe-integer range");
    expect(decided.delayMs).toBe(2 ** 31);

    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected oversized-delay refusal");
    expect(APPROVAL_AUTHORITY_CODES).toContain("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(APPROVAL_AUTHORITY_LAYERS).toContain("APPROVAL_POLICY");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("carries the exact configured delay into the authority decision", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "2000");
    const decided = decideApprovalAuthority({
      gate: null,
      policy: readApprovalPolicySettings(process.env),
    });

    expect(decided).toEqual({ delayMs: 2000, grant: null, ok: true });
  });

  it("does not execute a deferred configured decision without a daemon timer", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "25");
    // The mirror of `expectUnstatedPolicy`: here the policy IS stated, so the refusal below
    // must be the consumer's delay bound answering rather than an unstated-settings refusal.
    expect(readApprovalPolicySettings(process.env))
      .toEqual({ delayMs: 25, kind: "PROCEED_WITHOUT_HUMAN" });
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected deferred-policy refusal");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("keeps ungated approval behavior under an explicitly configured zero delay", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "0");
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  /**
   * THE OPERATOR'S CLICK IS THE HUMAN REVIEW — but only under the composition
   * root's server-assembled witness. Every witness-less arm above keeps its
   * refusal byte-for-byte: the handler still cannot know a caller is human on
   * its own, so nothing decoded from bytes can flip these outcomes. The witness
   * path exists so a REQUIRE_HUMAN board is operable by the human it requires,
   * while an explicit GO gate and the delay bound both keep outranking it.
   */
  it("commits gate-free approval as the operator's own review under unstated settings", () => {
    useApprovalSettings(undefined, undefined);
    expectUnstatedPolicy();
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    // The same dispatch WITHOUT the witness must keep refusing first — the
    // contrast is the contract: bytes alone can never become a human.
    const unwitnessed = send(store, envelope("approval.decide", 0, approvalPayload()));
    expect(unwitnessed.ok).toBe(false);
    expect(decisionCount(store)).toBe(before);

    const outcome = sendReviewed(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("keeps an explicit GO gate outranking the operator's click", () => {
    useApprovalSettings(undefined, undefined);
    const store = openStore();
    proposeGatedWork(store);
    const before = decisionCount(store);

    const outcome = sendReviewed(store, envelope("approval.decide", 0, legacyApprovalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the unsatisfied gate to stand");
    expect(outcome.code).toBe("APPROVAL_HUMAN_AUTHORITY_REQUIRED");
    expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("keeps the deferred-delay bound outranking the operator's click", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "25");
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = sendReviewed(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the stated delay to defer");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("fails a witness that names no principal closed at the gate layer", () => {
    useApprovalSettings(undefined, undefined);
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = sendReviewed(store, envelope("approval.decide", 0, approvalPayload()), "");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the unnamed witness to refuse");
    expect(outcome.code).toBe("APPROVAL_PRINCIPAL_UNNAMED");
    expect(outcome.refusedBy).toBe("HUMAN_AUTHORITY_GATE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("leaves the SPEED path untouched by the witness", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "0");
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = sendReviewed(store, envelope("approval.decide", 0, approvalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  /**
   * The registry allow-list already refuses an `approvalPolicy` payload key, but that guard
   * lives in a different file. These arms hold at the HANDLER, in both directions, so the
   * guarantee survives an allow-list edit: a payload can neither loosen nor tighten the
   * decision, because there is no payload-sourced policy left to read.
   */
  it("ignores a permissive approval policy presented in the payload", () => {
    useApprovalSettings(undefined, undefined);
    expectUnstatedPolicy();
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { delayMs: 0, kind: "PROCEED_WITHOUT_HUMAN" },
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the payload policy to be ignored");
    expect(outcome.code).toBe("APPROVAL_HUMAN_REVIEW_REQUIRED");
    expect(outcome.refusedBy).toBe("APPROVAL_POLICY");
    expect(decisionCount(store)).toBe(before);
    expect(durableApprovalRefs(store)).toEqual([]);
    expect(goalRow(store)?.lifecycle).toBe("DRAFT");
  });

  it("ignores a restrictive approval policy presented in the payload", () => {
    useApprovalSettings(SPEED_APPROVAL_MODE, "0");
    const store = openStore();
    driveThrough(store, "approval.decide");

    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      approvalPolicy: { kind: "REQUIRE_HUMAN" },
    })));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(durableApprovalRefs(store)).toEqual(["approval-1"]);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  /**
   * The gate path is not a policy value and the loaded policy must not disturb it: a human has
   * decided, so the decision proceeds immediately and carries their grant forward even under
   * the most restrictive settings the file can express.
   */
  it("proceeds on a satisfied human gate at delay zero under unstated settings", () => {
    useApprovalSettings(undefined, undefined);
    const decided = decideApprovalAuthority({
      gate: SATISFIED_GATE,
      policy: readApprovalPolicySettings(process.env),
    });
    expect(decided).toEqual({ delayMs: 0, grant: SATISFIED_GATE.grant, ok: true });

    const store = openStore();
    proposeGrantedWork(store);

    const outcome = send(store, envelope("approval.decide", 0, legacyApprovalPayload()));

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

  it("refuses a runId no plan was proposed under as MISSING, never as a hash mismatch", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    // The durable proposal exists — under RUN_ID. Naming a different run is a
    // missing prerequisite for THAT run; the old collapsed guard blamed the
    // revision hash, and a live operator chased the wrong field (measured on
    // the board: a dev payload naming an uncommitted run answered HASH_MISMATCH).
    const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
      runId: "run-nobody-proposed",
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
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
