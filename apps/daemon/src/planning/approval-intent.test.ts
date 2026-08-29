import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  bootstrapSequence,
  closeStores,
  driveThrough,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import {
  APPROVAL_INTENT_PAYLOAD_KEYS,
  APPROVAL_MISSING_FACT_CODES,
  readApprovalIntentSources,
  runApprovalIntentCommand,
} from "./approval-intent.js";

/**
 * `approval.decide_intent` — the daemon-owned approval seam (task-6646f888).
 *
 * WHAT THIS SUITE IS THE OPERAND OF. The shipped `approval.decide` path takes the ACTIVATION
 * WITNESS and the APPROVAL RECORD off the caller's payload (`daemon-command-graph-approve.ts:94-98`,
 * `planning-services.ts:230-234`), so the caller authors the very bytes that say a human approved.
 * Task rail 1 — "human authority is not delegable" — makes that an inversion, and this seam is
 * where it is closed: the caller supplies INTENT ONLY and the daemon derives the rest from the
 * durable PLAN_REVIEW run and the authenticated operator session.
 *
 * WHY THE ARMS RUN UNDER SPEED APPROVAL MODE, and it is a divergence fixture rather than a
 * convenience. `bootstrap-test-fixtures.ts:34-35` sets `MOE_APPROVAL_MODE=SPEED` with a stated
 * zero delay, so `decideApprovalAuthority` returns PROCEED for a gate-free run and the POLICY
 * cannot be what refuses a witness-less request. Under that mode this seam's own human-witness
 * fence is the ONLY mechanism that can answer, which is exactly the condition epic rail 7(A)
 * asks for: loosen that fence by one and the AGENT arm goes green while nothing else notices.
 * Under REQUIRE_HUMAN the policy would emit the same tuple and the arm would prove only that
 * the system refuses, not that this seam refuses.
 */

const decoder = new TextDecoder();
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

afterEach(() => {
  closeStores();
});

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

interface Refusal {
  readonly code: string;
  readonly layer: string;
}

const refusalOf = (outcome: unknown): Refusal => ({
  code: String(own(outcome, "code")),
  layer: String(own(outcome, "refusedBy")),
});

/** The world the shipped journey leaves just BEFORE its approval: sealed, PLAN_REVIEW, undecided. */
function reviewableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

const OPERATOR = "principal-1";

/** The registry-minted witness, in the exact shape `daemon-command-registry.ts:200-202` freezes. */
const witness = Object.freeze({ principalId: OPERATOR });

const INTENT = Object.freeze({
  decision: "APPROVE",
  decisionReason: "the plan is sound",
  runId: RUN_ID,
});

function dispatch(
  store: SqliteEventStore,
  payload: JsonObject,
  overrides: { humanReview?: { principalId: string } | undefined; principalId?: string } = {},
): ReturnType<typeof runApprovalIntentCommand> {
  return runApprovalIntentCommand({
    commandId: "cmd-approval.decide_intent",
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    humanReview: "humanReview" in overrides ? overrides.humanReview : witness,
    payload,
    principalId: overrides.principalId ?? OPERATOR,
    projectId: PROJECT_ID,
    store,
  });
}

/** The run's own durable record, read through the committed production reader. */
function runRecord(store: SqliteEventStore): unknown {
  const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
  if (run === undefined) throw new Error(`no durable decision for ${RUN_ID}`);
  return run.result;
}

/** `criteriaDigest` from its only durable home, selected BY TYPE and never by index. */
function sealedCriteriaDigest(store: SqliteEventStore): unknown {
  const events = store.readEvents(planningAuthorityAggregateId(RUN_ID));
  const bodies = events.find((event) => event.eventType === BODIES_EVENT_TYPE);
  if (bodies === undefined) throw new Error("the authority aggregate holds no bodies event");
  return own(JSON.parse(decoder.decode(bodies.payload)) as unknown, "criteriaDigest");
}

describe("the intent seam admits EXACTLY intent and refuses caller-supplied authority", () => {
  it("advertises exactly the three intent keys and nothing that carries authority", () => {
    expect([...APPROVAL_INTENT_PAYLOAD_KEYS].sort())
      .toEqual(["decision", "decisionReason", "runId"]);
  });

  it("admits the exact intent shape past the shape fence", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT });

    // NOT an assertion that the request SUCCEEDS — four record facts have no durable producer
    // yet (see the missing-fact arms below), so it cannot. The claim under test is narrower and
    // is the one that matters here: whatever answers, it is not the shape fence.
    expect(refusalOf(outcome).code).not.toBe("APPROVAL_INTENT_SHAPE_INVALID");
  });

  it("refuses a caller-supplied `activation` beside intent, naming code AND layer", () => {
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      activation: { activationRef: "activation-1", truthClass: "HUMAN_APPROVED" },
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("refuses a caller-supplied `record` beside intent, naming code AND layer", () => {
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      record: { actor: OPERATOR, actorKind: "HUMAN", truthClass: "HUMAN_APPROVED" },
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  /**
   * The generated sweep. Every one of these keys is a fact the caller must not be able to
   * present, and the seam REFUSES an unlisted key rather than trimming it — trimming is how a
   * caller-chosen authority gets in while every "it refused" arm above stays green.
   */
  it("refuses every authority-bearing extra key, over a nonzero generated roster", () => {
    const forbidden = [
      "activation", "actor", "actorKind", "applicablePolicyRef", "approvalRef", "budgetRef",
      "command", "criteriaRef", "decidedAt", "graphHash", "graphRevisionRef", "policyHash",
      "principalId", "qualityHash", "record", "riskTier", "stepUpAuthRef", "truthClass",
    ] as const;
    // A sweep that silently produces zero cases passes. Pinned, with the denominator stated.
    expect(forbidden.length).toBe(18);

    const store = reviewableStore();
    const answers = forbidden.map((key) =>
      refusalOf(dispatch(store, { ...INTENT, [key]: "anything at all" })));

    expect(answers).toHaveLength(forbidden.length);
    for (const answer of answers) {
      expect(answer)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
    }
  });

  it("refuses a MISSING intent key at the same fence, over a nonzero generated roster", () => {
    const store = reviewableStore();
    const cases = APPROVAL_INTENT_PAYLOAD_KEYS.map((omitted) => {
      const payload = Object.fromEntries(
        Object.entries(INTENT).filter(([key]) => key !== omitted),
      ) as JsonObject;
      return refusalOf(dispatch(store, payload));
    });

    expect(cases.length).toBeGreaterThan(0);
    for (const answer of cases) {
      expect(answer)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
    }
  });
});

describe("the human grant comes from the authenticated session, never from the payload", () => {
  /**
   * THE AGENT ARM. A dispatch with no server-assembled witness is an AGENT or otherwise
   * non-operator session, and this seam mints a HUMAN_APPROVED record — so it must refuse.
   *
   * The tuple is the EXISTING vocabulary verbatim (`approval-policy.ts:111`), not a local
   * invention: an operator repairs "a human must review this" the same way whichever layer
   * says it. See the file header for why SPEED mode makes this fence the only mechanism that
   * can answer here.
   */
  it("refuses a witness-less dispatch with the human-authority tuple unchanged", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT }, { humanReview: undefined });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });

  /**
   * A witness whose principal is not the dispatching principal is not this human's act. The
   * registry cannot mint one — it copies the authenticated principal — so this arm guards the
   * seam against a future caller that assembles its own.
   */
  it("refuses a witness that names a principal other than the authenticated one", () => {
    const outcome = dispatch(
      reviewableStore(),
      { ...INTENT },
      { humanReview: { principalId: "someone-else" } },
    );

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });
});

describe("run state refusals carry the existing layers' own codes", () => {
  it("refuses an unknown run as a MISSING prerequisite, not a hash disagreement", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT, runId: "run-never-proposed" });

    expect(refusalOf(outcome))
      .toEqual({ code: "BOOTSTRAP_PREREQUISITE_MISSING", layer: "DAEMON_PREREQUISITE" });
  });

  /**
   * A run that EXISTS but never reached PLAN_REVIEW — proposed, never finalized.
   *
   * It cannot be built with `driveThrough`: the shipped sequence carries TWO `plan.propose`
   * envelopes and `driveThrough` stops at the first kind match, leaving no run at all and an
   * answer of BOOTSTRAP_PREREQUISITE_MISSING. That is a different defect, and an arm satisfied by
   * it would never exercise the lifecycle check — measured, not assumed: this arm caught exactly
   * that ordering bug in the seam on its first run.
   */
  it("refuses a run short of PLAN_REVIEW with the run-binding layer's own code", () => {
    const store = openStore();
    for (const request of bootstrapSequence()) {
      if (request.commandId === "cmd-finalize") break;
      const outcome = send(store, request);
      if (!outcome.ok) throw new Error(`setup failed at ${request.kind}: ${outcome.code}`);
    }
    // The subject exists and is short of the lifecycle — asserted, so the arm cannot be satisfied
    // by the missing-run answer it was written to be distinguishable from.
    expect(own(own(runRecord(store), "state"), "lifecycle")).not.toBe("PLAN_REVIEW");

    const outcome = dispatch(store, { ...INTENT });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_RUN_NOT_REVIEWABLE", layer: "APPROVAL_RUN_BINDING" });
  });
});

describe("every derived fact traces to durable state, never to the request", () => {
  it("reads the revision, quality and criteria facts off the run's own durable records", () => {
    const store = reviewableStore();
    const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
    if (!sources.ok) throw new Error(`sources refused: ${sources.code}`);

    const state = own(runRecord(store), "state");
    // Copied from the durable record, never restated here: two hand-authored operands agreeing
    // would prove only that this file agrees with itself.
    expect(sources.exactRevisionHash).toBe(own(state, "submissionHash"));
    expect(sources.planQualityAssessmentRef)
      .toBe(own(own(state, "sealedHashes"), "qualityHash"));
    expect(sources.criteriaRef).toBe(sealedCriteriaDigest(store));
    expect(sources.graphRevisionRef).toBe(own(state, "graphRevisionRef"));
    expect(sources.graphRevisionRef).toBe(GRAPH_REVISION_REF);
  });

  it("mints the approval ref from the envelope command id, not from any payload field", () => {
    const store = reviewableStore();
    const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
    if (!sources.ok) throw new Error(`sources refused: ${sources.code}`);

    // The run identity is the only thing a caller names, and it names it as INTENT.
    expect(sources.approvalRef).toContain(RUN_ID);
  });

  it("refuses rather than answering for a run that has no durable record", () => {
    const sources = readApprovalIntentSources(reviewableStore(), PROJECT_ID, "run-absent");

    expect(sources.ok).toBe(false);
  });
});

describe("a fact with no durable producer is REFUSED, never defaulted", () => {
  /**
   * THE HANDOFF ARM, and it is the one task-ba1021652dcc4469bc4deb04a8e7d7d5 flips.
   *
   * `riskTier` decides whether step-up human authority is required — `approval-invalidation.ts:73`
   * special-cases R3 — so a defaulted tier silently decides an authority question. Absence and a
   * defaulted value are different answers, and this seam must give the first.
   */
  it("refuses on riskTier, naming the fact in its own code and layer", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT });

    expect(refusalOf(outcome)).toEqual({
      code: "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE", layer: "DAEMON_APPROVAL_INTENT",
    });
  });

  it("names one code per missing fact, over a nonzero roster", () => {
    expect(APPROVAL_MISSING_FACT_CODES.length).toBeGreaterThan(0);
    expect([...APPROVAL_MISSING_FACT_CODES].sort()).toEqual([
      "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
      "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
      "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
    ]);
  });

  /**
   * SILENT DEGRADATION. `createRuntimeError` (runtime-error-factory.ts:93-104) answers
   * `UNKNOWN_ERROR` and does NOT throw when a code is unknown or a descriptor does not list the
   * aggregate — so a wrong code compiles, runs, still refuses, and quietly loses its identity
   * while every "it refused" arm above stays green. This is the only arm that can see that.
   */
  it("produces no refusal whose code is UNKNOWN_ERROR", () => {
    const store = reviewableStore();
    const probes: JsonObject[] = [
      { ...INTENT },
      { ...INTENT, record: {} },
      { ...INTENT, runId: "run-never-proposed" },
      { ...INTENT, decision: "NOT_A_DECISION" },
    ];
    expect(probes.length).toBeGreaterThan(0);

    const codes = probes.map((payload) => refusalOf(dispatch(store, payload)).code);
    const witnessLess = refusalOf(
      dispatch(store, { ...INTENT }, { humanReview: undefined })).code;

    for (const code of [...codes, witnessLess]) expect(code).not.toBe("UNKNOWN_ERROR");
  });
});
