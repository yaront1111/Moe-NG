import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { humanReviewWitness, readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { runApprovalIntentEdge } from "../daemon-command-edges.js";
import { isSessionDigest } from "../identity/session-authority-protocol.js";
import { replayAggregateId } from "../identity/session-authority-store.js";
import { burnStepUpAuthRef, deriveStepUpAuthRef } from "./approval-step-up.js";
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
  readApprovalIntent,
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

/** The server facts the seam hands the burn: identity of the approving principal and project. */
const BURN_FACTS = Object.freeze({
  decidedAt: "2026-08-08T00:00:00.000Z", principalId: OPERATOR, projectId: PROJECT_ID,
});

const INTENT = Object.freeze({
  decision: "APPROVE",
  decisionReason: "the plan is sound",
  dependencyChanges: { additions: [], challenges: [], removals: [] },
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

/**
 * The SAME dispatch through the production EDGE, so the registry-owned mint conditional is in
 * the call path and the registry's own operator gate is not. Every field below is a server fact
 * the ingress resolves; the payload is the honest intent, so nothing here can be what refuses.
 */
function edgeRefusalOf(store: SqliteEventStore, principalId: string): Refusal {
  try {
    runApprovalIntentEdge({
      decidedAt: "2026-08-08T00:00:00.000Z",
      envelope: {
        commandId: "cmd-approval-intent-edge",
        commandKind: "approval.decide_intent",
        correlationId: "corr-edge-1",
        expectedVersion: 0,
        payload: { ...INTENT },
        requestDigest: "a".repeat(64),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: "edge-credential",
        targetAggregateId: RUN_ID,
      },
      eventSubscriberId: undefined,
      operatorPrincipalId: OPERATOR,
      principal: { capabilities: ["planning.write"], principalId, projectId: PROJECT_ID },
      projectId: PROJECT_ID,
      store,
    });
  } catch (error) {
    if (error instanceof DomainRefusal) return { code: error.code, layer: error.layer };
    throw error;
  }
  throw new Error("expected the approval intent edge to refuse");
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
  it("advertises exactly the four human-authored intent keys", () => {
    expect([...APPROVAL_INTENT_PAYLOAD_KEYS].sort())
      .toEqual(["decision", "decisionReason", "dependencyChanges", "runId"]);
  });

  it("admits the exact intent shape past the shape fence", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT });

    // NOT an assertion that the request SUCCEEDS — record minting belongs to task-6093483c, so
    // this seam deliberately stops at RECORD_UNMINTED. The claim here is narrower: whatever
    // answers, it is not the shape fence.
    expect(refusalOf(outcome).code).not.toBe("APPROVAL_INTENT_SHAPE_INVALID");
  });

  it.each([
    ["empty", { additions: [], challenges: [], removals: [] }],
    ["nonempty", {
      additions: ["node-added"], challenges: ["challenge-reviewed"], removals: ["node-removed"],
    }],
  ] satisfies readonly (readonly [string, JsonObject])[])(
    "admits an explicit %s dependency tuple byte-equal to the human payload",
    (_label, dependencyChanges) => {
      const admitted = readApprovalIntent({ ...INTENT, dependencyChanges });
      const carried = own(admitted, "dependencyChanges");

      expect(carried).toEqual(dependencyChanges);
      expect(JSON.stringify(carried)).toBe(JSON.stringify(dependencyChanges));
    },
  );

  it("isolates two admissions with detached deeply frozen dependency snapshots", () => {
    const dependencyChanges = {
      additions: ["node-added"],
      challenges: ["challenge-reviewed"],
      removals: ["node-removed"],
    };
    const admitted = readApprovalIntent({ ...INTENT, dependencyChanges });
    const sibling = readApprovalIntent({ ...INTENT, dependencyChanges });
    const carried = own(admitted, "dependencyChanges");
    const siblingCarried = own(sibling, "dependencyChanges");
    const carriedAdditions = own(carried, "additions");
    const carriedChallenges = own(carried, "challenges");
    const carriedRemovals = own(carried, "removals");

    expect(carried).toEqual(dependencyChanges);
    expect(carried).not.toBe(dependencyChanges);
    expect(siblingCarried).not.toBe(dependencyChanges);
    expect(siblingCarried).not.toBe(carried);
    expect(carriedAdditions).not.toBe(dependencyChanges.additions);
    expect(carriedChallenges).not.toBe(dependencyChanges.challenges);
    expect(carriedRemovals).not.toBe(dependencyChanges.removals);
    expect([
      Object.isFrozen(carried), Object.isFrozen(carriedAdditions),
      Object.isFrozen(carriedChallenges), Object.isFrozen(carriedRemovals),
    ]).toEqual([true, true, true, true]);

    dependencyChanges.additions.push("mutated-addition");
    dependencyChanges.challenges.push("mutated-challenge");
    dependencyChanges.removals.push("mutated-removal");
    expect(carried).toEqual({
      additions: ["node-added"],
      challenges: ["challenge-reviewed"],
      removals: ["node-removed"],
    });
    expect(siblingCarried).toEqual(carried);
  });

  it("refuses absent dependencyChanges with the seam's exact tuple", () => {
    const outcome = dispatch(reviewableStore(), {
      decision: INTENT.decision,
      decisionReason: INTENT.decisionReason,
      runId: INTENT.runId,
    });

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("refuses an exact nonzero sweep of malformed dependency tuples", () => {
    const getterBacked: Record<string, unknown> = { challenges: [], removals: [] };
    Object.defineProperty(getterBacked, "additions", {
      enumerable: true,
      get: () => [],
    });
    const cyclic: Record<string, unknown> = {
      additions: [], challenges: [], removals: [],
    };
    cyclic["additions"] = [cyclic];
    const cases: readonly { readonly name: string; readonly value: unknown }[] = [
      { name: "missing sub-key", value: { additions: [], challenges: [] } },
      { name: "extra sub-key", value: {
        additions: [], challenges: [], extra: [], removals: [],
      } },
      { name: "non-array member", value: {
        additions: "node-added", challenges: [], removals: [],
      } },
      { name: "empty-string ref", value: { additions: [""], challenges: [], removals: [] } },
      { name: "null", value: null },
      { name: "nested object", value: {
        additions: [{ ref: "nested" }], challenges: [], removals: [],
      } },
      { name: "getter-backed key", value: getterBacked },
      { name: "cycle", value: cyclic },
    ];
    expect(cases).toHaveLength(8);

    const store = reviewableStore();
    let swept = 0;
    for (const testCase of cases) {
      const answer = refusalOf(dispatch(store, {
        ...INTENT,
        dependencyChanges: testCase.value,
      } as JsonObject));
      expect(answer, testCase.name)
        .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
      swept += 1;
    }

    expect(swept).toBe(cases.length);
    expect(cases.length).toBeGreaterThan(0);
  });

  it("isolates the nested dependency validator from the top-level roster fence", () => {
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const outcome = dispatch(reviewableStore(), {
      ...INTENT,
      dependencyChanges: {
        additions: [], challenges: [], extra: [], removals: [],
      },
    }, { humanReview: transported });

    // DIVERGENCE TELL: all four top-level keys are present and every durable fact resolves.
    // Bypassing only validateApprovalDependencyChanges must therefore change this answer to
    // APPROVAL_INTENT_RECORD_UNMINTED, never leave SHAPE_INVALID and never make it succeed.
    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_SHAPE_INVALID", layer: "DAEMON_APPROVAL_INTENT" });
  });

  it("gets the identical valid dependency fixture past the nested shape fence", () => {
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const outcome = dispatch(
      reviewableStore(),
      { ...INTENT, dependencyChanges: { additions: [], challenges: [], removals: [] } },
      { humanReview: transported },
    );

    expect(refusalOf(outcome))
      .toEqual({ code: "APPROVAL_INTENT_RECORD_UNMINTED", layer: "DAEMON_APPROVAL_INTENT" });
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
      // NEVER FROM BYTES, re-asserted for the two names the server-derived step-up fact
      // introduced (task-3b61860f): the witness's transport identity is assembled at the
      // composition root from the ingress's own authentication result, so a payload offering
      // either is a fifth key and is refused as a set rather than trimmed.
      "sessionRef", "transport",
    ] as const;
    // A sweep that silently produces zero cases passes. Pinned, with the denominator stated.
    expect(forbidden.length).toBe(20);

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
    const requiredKeys = [
      "decision", "decisionReason", "dependencyChanges", "runId",
    ] as const;
    const cases = requiredKeys.map((omitted) => {
      const payload = Object.fromEntries(
        Object.entries(INTENT).filter(([key]) => key !== omitted),
      ) as JsonObject;
      return refusalOf(dispatch(store, payload));
    });

    expect(requiredKeys).toHaveLength(4);
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

  /**
   * THE MINTING CONDITION ITSELF, exercised at the production edge that owns it
   * (`daemon-command-edges.ts:55`) rather than through the registry.
   *
   * WHY NOT THE REGISTRY. `approval.decide_intent` is in `OPERATOR_PRINCIPAL_KINDS`, so a
   * non-operator dispatch is refused 403 `OPERATOR_PRINCIPAL_REQUIRED` @ `DAEMON_AUTHORIZATION`
   * by the gate BEFORE the mint runs. An arm routed that way would stay green with the
   * conditional deleted — it would prove the system refuses, not that the mint withholds the
   * witness. Calling the exported edge puts the gate out of the call path, and SPEED mode (see
   * the file header) keeps the policy from emitting the same tuple, so the conditional at
   * `daemon-command-edges.ts:55` is the ONLY mechanism that can answer these two arms
   * differently: drop `principal.principalId === operatorPrincipalId` and the AGENT row goes
   * green while every other arm in this file stays green.
   */
  it("withholds the witness at the edge for a principal that is not the operator", () => {
    expect(edgeRefusalOf(reviewableStore(), "agent-session-1"))
      .toEqual({ code: "APPROVAL_HUMAN_REVIEW_REQUIRED", layer: "APPROVAL_POLICY" });
  });

  it("mints it at the edge for the operator, whose dispatch reaches the fact derivation", () => {
    // MOVED BY task-f42d5165, and the move STRENGTHENS what this arm witnesses. It used to
    // prove the dispatch reached fact derivation by observing the roster's first code — a code
    // a dispatch that derived NOTHING would also produce. `APPROVAL_INTENT_RECORD_UNMINTED` is
    // only reachable AFTER every roster fact has been established, so it can no longer be
    // answered by a path that failed to derive.
    expect(edgeRefusalOf(reviewableStore(), OPERATOR))
      .toEqual({ code: "APPROVAL_INTENT_RECORD_UNMINTED", layer: "DAEMON_APPROVAL_INTENT" });
  });
});

describe("the step-up reference is server-derived and burns exactly once", () => {
  /**
   * DoD-3 (derivation) and DoD-4 (one-shot), against `approval-step-up.ts`.
   *
   * WHY THE ARMS LIVE IN THIS FILE. The module is the seam's own derivation half; splitting it
   * into a sibling suite would put the plan over its distinct-file cap while proving nothing the
   * shared `reviewableStore()` harness does not already reach.
   */
  const BURN = BURN_FACTS;
  const mint = (commandId: string) => humanReviewWitness(OPERATOR, commandId);

  const derivedRef = (commandId: string, runId: string = RUN_ID): string => {
    const derived = deriveStepUpAuthRef(mint(commandId), runId);
    if (!derived.ok) throw new Error(`expected a derivation, got ${derived.code}`);
    return derived.stepUpAuthRef;
  };

  it("refuses with the seam's EXISTING code and layer when the witness carries no transport", () => {
    // The witness the registry minted BEFORE this row: a principal and nothing else. Not a
    // fabricated shape -- it is exactly what every pre-transport mint site produced.
    expect(deriveStepUpAuthRef(Object.freeze({ principalId: OPERATOR }), RUN_ID)).toEqual({
      code: "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      layer: "DAEMON_APPROVAL_INTENT",
      ok: false,
    });
    // The code is the seam's ROSTER entry, not a literal that merely happens to match today.
    expect(deriveStepUpAuthRef(undefined, RUN_ID)).toEqual({
      code: APPROVAL_MISSING_FACT_CODES[1],
      layer: "DAEMON_APPROVAL_INTENT",
      ok: false,
    });
  });

  it("derives a reference the PRODUCTION digest guard accepts", () => {
    const reference = derivedRef("cmd-derive-1");

    // `isSessionDigest` is the guard `observeReplayMarker` itself applies before burning, so
    // this asserts the production fence rather than a regex reimplementing one. Core's own
    // `validRef` (policy-validation.ts:106 -- `typeof value === "string" && value.length > 0`)
    // is satisfied a fortiori and is NOT importable here: it is not on the core barrel, and a
    // deep import fails TS6059.
    expect(isSessionDigest(reference)).toBe(true);
    expect(reference.length).toBeGreaterThan(0);
  });

  it("is DETERMINISTIC, which is the only thing that makes a replay detectable", () => {
    expect(derivedRef("cmd-same")).toBe(derivedRef("cmd-same"));
  });

  it("binds all three server facts, so changing any one changes the reference", () => {
    const base = derivedRef("cmd-bind", RUN_ID);
    const otherCommand = derivedRef("cmd-bind-other", RUN_ID);
    const otherRun = derivedRef("cmd-bind", `${RUN_ID}-other`);
    const otherSession = deriveStepUpAuthRef(humanReviewWitness("operator-elsewhere", "cmd-bind"), RUN_ID);
    if (!otherSession.ok) throw new Error("expected a derivation for a different session");

    expect(new Set([base, otherCommand, otherRun, otherSession.stepUpAuthRef]).size).toBe(4);
  });

  /**
   * THE ONE-SHOT (DoD-4). DIVERGENCE: only the burn can answer `SESSION_REPLAYED` -- nothing
   * else in the module or the seam emits that code, so deleting the burn call reddens exactly
   * this arm and leaves every other arm in this file green.
   */
  it("admits the first burn and refuses the second with the ledger's own code AND layer", () => {
    const store = reviewableStore();
    const stepUpAuthRef = derivedRef("cmd-one-shot");

    const first = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    const second = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ code: "SESSION_REPLAYED", layer: "REPLAY", ok: false });
  });

  it("holds EXACTLY ONE replay observation for the digest after two attempts", () => {
    const store = reviewableStore();
    const stepUpAuthRef = derivedRef("cmd-count-once");

    burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });

    const first = burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef });
    if (first.ok) throw new Error("expected the third attempt to be refused too");
    const observed = store
      .readEvents(replayAggregateId(stepUpAuthRef))
      .filter((event) => event.eventType === "SessionAuthorityReplayObserved");

    // The denominator matters: a fixture that produced zero events would satisfy "no duplicate".
    expect(observed).toHaveLength(1);
  });

  it("admits a FRESH request identity, so an honest second approval is not locked out", () => {
    const store = reviewableStore();

    expect(burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef: derivedRef("cmd-fresh-a") }))
      .toMatchObject({ ok: true });
    expect(burnStepUpAuthRef(store, { ...BURN, stepUpAuthRef: derivedRef("cmd-fresh-b") }))
      .toMatchObject({ ok: true });
  });

  it("refuses a malformed reference under the evidence pair rather than reaching the store", () => {
    expect(burnStepUpAuthRef(reviewableStore(), { ...BURN, stepUpAuthRef: "not-a-digest" }))
      .toEqual({ code: "AUTHENTICATION_FAILED", layer: "REPLAY", ok: false });
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
  it("advances past riskTier to the step-up, naming the fact in its own code and layer", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT });

    // MOVED BY task-f42d5165. The tier now has a durable producer — the run's own
    // PolicyEvaluated — so the roster's FIRST code no longer answers and an operator is sent to
    // the next producer that actually owes something. Without a transported witness that is the
    // step-up. This arm reds if the tier's producer regresses, because the answer falls back.
    expect(refusalOf(outcome)).toEqual({
      code: "APPROVAL_INTENT_STEP_UP_UNAVAILABLE", layer: "DAEMON_APPROVAL_INTENT",
    });
  });

  /**
   * ORDER PRESERVATION (risk 6) with the transport fact PRESENT, and the BURN-PLACEMENT proof.
   *
   * The seam now derives a step-up reference from the composition-root witness before consulting
   * the reader. Two things must remain true and neither is visible from the code alone: the
   * ROSTER'S order still decides which producer an operator is sent to (the tier is still first
   * and still has no producer, so supplying a later fact must NOT move the answer), and a request
   * that goes on to refuse must leave NOTHING durable behind.
   */
  it("reaches the mint boundary with every roster fact established", () => {
    const outcome = dispatch(reviewableStore(), { ...INTENT }, {
      humanReview: humanReviewWitness(OPERATOR, "cmd-approval.decide_intent"),
    });

    // MOVED BY task-f42d5165, and this is the row's headline: with the tier derived from the
    // run's own evaluation and the step-up derived from the transported witness, EVERY roster
    // fact resolves and the walk has nothing left to refuse. The seam stops at the mint, which
    // is a different condition from a missing producer and carries its own non-roster code.
    expect(refusalOf(outcome)).toEqual({
      code: "APPROVAL_INTENT_RECORD_UNMINTED", layer: "DAEMON_APPROVAL_INTENT",
    });
  });

  it("burns NOTHING when the approval refuses, so a later retry is not locked out", () => {
    const store = reviewableStore();
    const transported = humanReviewWitness(OPERATOR, "cmd-approval.decide_intent");
    const derived = deriveStepUpAuthRef(transported, RUN_ID);
    if (!derived.ok) throw new Error("expected the transported witness to derive a reference");

    // Non-vacuous: the dispatch really did run and really did refuse.
    //
    // THIS ARM IS NOW THE ANTI-BRICKING GUARD, and task-f42d5165 is what made it load-bearing.
    // Before this row the burn was unreachable because the walk always answered first, so
    // "nothing was burned" was true by accident. Every roster fact now resolves, so the seam
    // runs all the way to the mint boundary — and the assertions below are the only thing
    // proving it refuses BEFORE consuming the one-shot reference rather than after. Move the
    // guard in approval-intent.ts below the burn and this arm reds.
    expect(refusalOf(dispatch(store, { ...INTENT }, { humanReview: transported })).code)
      .toBe("APPROVAL_INTENT_RECORD_UNMINTED");

    expect(store.readEvents(replayAggregateId(derived.stepUpAuthRef))).toHaveLength(0);
    // And the reference is still burnable afterwards -- the refused attempt did not consume it.
    expect(burnStepUpAuthRef(store, { ...BURN_FACTS, stepUpAuthRef: derived.stepUpAuthRef }))
      .toMatchObject({ ok: true });
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

    // NOT-UNKNOWN_ERROR IS THE WEAKER HALF, and on its own it is not the fence this arm's header
    // claims. A drill proved it: retyping a refusal code to an unregistered string left every
    // assertion above GREEN, because a code can lose its identity without ever becoming the one
    // literal spelled out here. So the codes are also graded against the roster this seam is
    // allowed to emit -- HAND-TRANSCRIBED, never imported from the module under test, which would
    // make the expectation a fixed point that moves with the very edit it is supposed to catch.
    const EMITTABLE = [
      "APPROVAL_HUMAN_REVIEW_REQUIRED",
      "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
      "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
      "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
      "APPROVAL_INTENT_SHAPE_INVALID",
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      "APPROVAL_AUTHORITY_UNSEALED",
      "BOOTSTRAP_PREREQUISITE_MISSING",
    ];
    for (const code of [...codes, witnessLess]) {
      expect({ code, emittable: EMITTABLE.includes(code) }).toEqual({ code, emittable: true });
    }
  });
});
