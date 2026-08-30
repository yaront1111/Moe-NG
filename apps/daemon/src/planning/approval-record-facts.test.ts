import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqliteEventStore } from "@moe/store";
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { readRunPolicyEvaluation } from "../bootstrap/run-policy-selection.js";
import {
  PROJECT_ID,
  RUN_ID,
  closeStores,
  driveThrough,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { budgetCommitmentDigest, budgetCommitmentMaterial, verifyBudgetCommitment }
  from "../budget/budget-commitment.js";
import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";
import { readApprovalIntentSources } from "./approval-intent-sources.js";
import { firstMissingApprovalFact, readApprovalRecordFacts }
  from "./approval-record-facts.js";
import type {
  ApprovalRecordFacts,
  ApprovalRecordFactsIncomplete,
} from "./approval-record-facts.js";
import {
  SUCCESSOR_REVISION_REF,
  supersedableStore,
} from "./graph-supersede-test-fixtures.js";
import { readSupersessionPolicyDecision } from "./supersession-policy-decision.js";

/**
 * task-ba102165 — the durable, run-linked `applicablePolicyRef` the approval seam composes.
 *
 * WHAT IS UNDER TEST IS WHICH DURABLE FACT IS RETURNED. The ref is the `policyRef` of the
 * newest REPLAY-VERIFIED `PolicyEvaluated` on the project's policy aggregate, read through the
 * strict authority reader. Every arm below compares against that same fact computed by
 * PRODUCTION through its own path — never a literal, which a hardcoded-return mutant satisfies.
 *
 * IT IS NOT A THIRD NOTION. `graph-supersede-approval-binding.ts:94` compares a record's
 * `applicablePolicyRef` against exactly what `readSupersessionPolicyDecision` returns, and that
 * function reads `policyRef` off the SAME strict reader over the SAME newest-first selection.
 * The only thing it adds is a supersede-specific subject filter
 * (`supersession-policy-decision.ts:57-62`: `action === "graph.supersede"` with one matching
 * ref), which the PLAN path must not apply — a plan approval is never a supersede subject, so
 * applying it would refuse every honest plan approval. The fence relationship is pinned by its
 * own arm below rather than left as prose.
 *
 * THE TIER WAS NOT THIS ROW'S — it is task-f42d5165's, whose arms live at the bottom of this
 * file. When these arms were written no durable pre-approval producer existed, so the reader
 * always reported the tier missing; it now derives from the run's own `PolicyEvaluated` and the
 * walk answers a later fact. Absence is still not a default: a defaulted tier would silently
 * decide an authority question (`approval-invalidation.ts:73` special-cases R3), which is why
 * the absence arms assert the key is not present at all rather than not equal to something.
 */

afterEach(() => { closeStores(); });

/** The world the shipped journey leaves just BEFORE its approval: sealed, PLAN_REVIEW. */
function reviewableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

/**
 * Narrows to the incomplete arm.
 *
 * UPDATED BY task-f42d5165: this used to read "no tier producer exists, so the reader can never
 * answer ok:true today". One does now — the run's own `PolicyEvaluated` — so completeness turns
 * on whether the SEAM supplied its step-up fact. Arms that pass no `serverDerived` are still
 * incomplete, and this throws rather than casts so an arm whose premise silently flipped fails
 * loudly here instead of skipping every assertion below it.
 */
function incompleteFacts(facts: ApprovalRecordFacts): ApprovalRecordFactsIncomplete {
  if (facts.ok) throw new Error("expected an incomplete result: a fact this arm needs missing");
  return facts;
}

function commitPolicyEvent(
  store: SqliteEventStore,
  id: string,
  eventType: string,
  payload: Uint8Array,
): void {
  const aggregateId = policyAggregateId(PROJECT_ID);
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(id),
    commandId: `cmd-${id}`,
    committedAt: "2026-08-29T23:00:00.000Z",
    events: [{ eventId: id, eventType, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

describe("the approval record facts come from durable state, never from a caller", () => {
  it("derives a non-default applicablePolicyRef for the plan store", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    expect(facts.derived.applicablePolicyRef).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("carries every fact it derived even while refusing on a later one", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    // REWRITTEN BY task-f42d5165, and the property it pins is now testable for the tier for the
    // first time. Before this row the tier had no producer, so this arm could only assert that
    // the roster's index 0 answered. Now the tier IS derived while a LATER fact is not, which
    // is the module's "reports ONE missing fact but carries what it could derive" contract: a
    // reader that returned an all-or-nothing verdict would red here.
    expect(facts.missing).toBe(APPROVAL_MISSING_FACT_CODES[1]);
    expect(facts.derived.riskTier).toMatch(/^R[0-3]$/u);
    expect(facts.derived.applicablePolicyRef).toBeDefined();
  });

  it("leaves applicablePolicyRef ABSENT rather than defaulting when no policy is verified", () => {
    // A store the journey never drove: no PolicyInstalled, no PolicyEvaluated, nothing to read.
    const store = openStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
    // ABSENT, not "" and not a zero digest. Two zero digests compare EQUAL, so a defaulted ref
    // would make the fence at graph-supersede-approval-binding.ts:94 pass against a value
    // nothing durably asserted.
    expect(facts.derived.applicablePolicyRef).toBeUndefined();
    expect(JSON.stringify(facts.derived)).not.toContain("0000");
  });

  it("fails closed when the newest PolicyEvaluated cannot be verified", () => {
    const store = reviewableStore();
    const forged = "f".repeat(64);
    commitPolicyEvent(store, "policy-evaluated-forged", "PolicyEvaluated",
      new TextEncoder().encode(JSON.stringify({ policyRef: forged })));

    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    expect(facts.derived.applicablePolicyRef).toBeUndefined();
    expect(facts.upstream).toEqual({
      code: "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN",
      layer: "DAEMON_POLICY_AUTHORITY",
    });
  });

  it("uses the fence's bounded-decode disposition for an oversized newest row", () => {
    const store = reviewableStore();
    const oversized = new TextEncoder().encode(JSON.stringify({
      pad: "x".repeat(MAX_JSON_BODY_BYTES),
    }));
    expect(oversized.byteLength).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    commitPolicyEvent(store, "policy-evaluated-oversized", "PolicyEvaluated", oversized);

    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    expect(facts.derived.applicablePolicyRef).toBeUndefined();
    expect(facts.upstream).toEqual({
      code: "SUPERSESSION_POLICY_DECISION_ABSENT",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
    });
  });

  it("uses the fence's absence disposition for a non-object newest payload", () => {
    const store = reviewableStore();
    commitPolicyEvent(store, "policy-evaluated-array", "PolicyEvaluated",
      new TextEncoder().encode("[]"));

    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    expect(facts.derived.applicablePolicyRef).toBeUndefined();
    expect(facts.upstream).toEqual({
      code: "SUPERSESSION_POLICY_DECISION_ABSENT",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
    });
  });

  it("never answers with UNKNOWN_ERROR, on either the derivable or the absent store", () => {
    const driven = incompleteFacts(
      readApprovalRecordFacts(reviewableStore(), { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    const bare = incompleteFacts(
      readApprovalRecordFacts(openStore(), { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    for (const facts of [driven, bare]) {
      expect(facts.missing).not.toBe("UNKNOWN_ERROR");
      // Every code it can emit is one the seam already publishes, so a new spelling cannot
      // appear without moving this roster.
      expect([...APPROVAL_MISSING_FACT_CODES]).toContain(facts.missing);
    }
  });

  it("does not advance the durable policy aggregate while reading facts", () => {
    const store = reviewableStore();
    const aggregateId = policyAggregateId(PROJECT_ID);
    const before = store.getAggregateVersion(aggregateId);

    readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });

    expect(store.getAggregateVersion(aggregateId)).toBe(before);
  });
});

describe("the roster walk is data-driven, so the order is the only thing deciding the code", () => {
  /**
   * THE MOVEMENT PROOF (DoD-3), at the PRODUCTION walk rather than through the full command.
   *
   * `readApprovalRecordFacts` cannot show STEP_UP -> BUDGET_REF today: `riskTier` has no durable
   * producer until the T1 chain's last row (task-f42d5165) lands, so the command always answers
   * the roster's FIRST code and every later row is unreachable behind it. The walk is the same
   * production surface the command uses — the command calls exactly this function — so driving
   * it directly proves the movement without a mock and without narrowing the DoD.
   *
   * Each row asserts the EXACT code, never merely "it refused": a walk that answered whichever
   * fact it noticed last would satisfy a "some code" assertion while sending an operator to the
   * wrong producer.
   */
  const STEP_UP_REF = "b".repeat(64);

  it.each([
    { derived: {}, expected: APPROVAL_MISSING_FACT_CODES[0], name: "nothing established" },
    { derived: { riskTier: "R3" }, expected: APPROVAL_MISSING_FACT_CODES[1], name: "tier only" },
    {
      derived: { riskTier: "R3", stepUpAuthRef: STEP_UP_REF },
      expected: APPROVAL_MISSING_FACT_CODES[2],
      name: "tier + step-up",
    },
    {
      derived: { applicablePolicyRef: "c".repeat(64), riskTier: "R3", stepUpAuthRef: STEP_UP_REF },
      expected: APPROVAL_MISSING_FACT_CODES[3],
      name: "tier + step-up + policy ref",
    },
  ])("answers $name with the first roster fact it cannot establish", ({ derived, expected }) => {
    expect(firstMissingApprovalFact(derived)).toBe(expected);
  });

  it("names the four codes it walks in the seam's own order, over a nonzero roster", () => {
    // The matrix above is only meaningful if these ARE the roster's four codes in order. A
    // renumbered roster would otherwise leave every row above asserting a different fact.
    expect([...APPROVAL_MISSING_FACT_CODES]).toEqual([
      "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
      "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
      "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
      "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
    ]);
    expect(APPROVAL_MISSING_FACT_CODES).toHaveLength(4);
  });

  it("answers null only when every roster fact is established", () => {
    expect(firstMissingApprovalFact({
      applicablePolicyRef: "c".repeat(64),
      budgetRef: "d".repeat(64),
      riskTier: "R3",
      stepUpAuthRef: STEP_UP_REF,
    })).toBeNull();
  });

  it("walks EVERY roster code, so no fact is silently unreachable", () => {
    // Built by REMOVING one slot at a time from the complete record, so each code is reached by
    // the absence of its own fact rather than by a hand-written expectation.
    const complete = {
      applicablePolicyRef: "c".repeat(64),
      budgetRef: "d".repeat(64),
      riskTier: "R3",
      stepUpAuthRef: STEP_UP_REF,
    };
    const slots = ["riskTier", "stepUpAuthRef", "applicablePolicyRef", "budgetRef"] as const;
    expect(slots).toHaveLength(APPROVAL_MISSING_FACT_CODES.length);

    const answers = slots.map((slot) => {
      const partial: Record<string, string> = { ...complete };
      delete partial[slot];
      return firstMissingApprovalFact(partial);
    });

    expect(answers).toEqual([...APPROVAL_MISSING_FACT_CODES]);
  });

  it("answers COMPLETE once the seam supplies the one fact durable state cannot", () => {
    const store = reviewableStore();

    const facts = readApprovalRecordFacts(
      store, { projectId: PROJECT_ID, runId: RUN_ID }, { stepUpAuthRef: STEP_UP_REF },
    );

    // REWRITTEN BY task-f42d5165, and it is now a STRONGER assertion than the one it replaces.
    // This arm used to assert the walk still answered the tier, because no tier producer
    // existed. With the tier derived from the run's own evaluation, every roster fact resolves
    // and the reader completes -- which is the precondition the seam needs to MINT. A reader
    // that dropped any one of the four facts would red here rather than quietly refusing.
    if (!facts.ok) {
      throw new Error(`expected complete facts, refused ${facts.missing}`);
    }
    expect(facts.applicablePolicyRef).toMatch(/^[0-9a-f]{64}$/u);
    // The SAME value the seam handed in, returned so the caller burns what the reader validated
    // rather than re-deriving one beside it.
    expect(facts.stepUpAuthRef).toBe(STEP_UP_REF);
  });

  it("leaves the step-up fact ABSENT when the seam derived none, never defaulted", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    expect(facts.derived).not.toHaveProperty("stepUpAuthRef");
    // task-f42d5165 moved this from RISK_TIER to STEP_UP, which makes the arm STRONGER: the
    // code it reports is now the very fact this arm proves absent, rather than an earlier one
    // that would have answered whatever the step-up did.
    expect(facts.missing).toBe("APPROVAL_INTENT_STEP_UP_UNAVAILABLE");
  });
});

describe("the derived ref is the SAME notion the supersede fence compares against", () => {
  it("returns the consumer fence's policyRef for a supersede subject", () => {
    const store = supersedableStore();
    const mine = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    const fence = readSupersessionPolicyDecision(store, PROJECT_ID, SUCCESSOR_REVISION_REF);

    expect(fence.ok).toBe(true);
    if (!fence.ok) throw new Error(`expected the consumer to answer, got ${fence.code}`);
    expect(mine.derived.applicablePolicyRef).toBe(fence.policyRef);
  });

  it("refuses when the selected policy was reused after evaluation", () => {
    const store = supersedableStore();
    const fence = readSupersessionPolicyDecision(store, PROJECT_ID, SUCCESSOR_REVISION_REF);
    if (!fence.ok) throw new Error(`expected the fixture policy, got ${fence.code}`);
    commitPolicyEvent(store, "policy-installed-reused", "PolicyInstalled",
      new TextEncoder().encode(JSON.stringify({ sliceRef: fence.policyRef })));

    const mine = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    expect(mine.derived.applicablePolicyRef).toBeUndefined();
    expect(mine.upstream).toEqual({
      code: "SUPERSESSION_POLICY_DECISION_POLICY_REUSED",
      layer: "DAEMON_SUPERSESSION_POLICY_DECISION",
    });
  });
});

describe("the seam actually CONSULTS the reader, which no behavioural arm can see", () => {
  /**
   * A GREEN DRILL FOUND THIS, and it is worth stating plainly. Removing the composition from
   * `approval-intent.ts` entirely — dropping back to the old literal
   * `refuse(null, APPROVAL_MISSING_FACT_CODES[0], LAYER)` — left ALL 23 arms green. That is not
   * a gap in the arms; it is a property of where the seam is today. The reader's first missing
   * fact IS the roster's first fact, so both paths answer with the identical code and layer,
   * and no behavioural arm can distinguish them until a tier producer exists.
   *
   * That matters because the composition is the deliverable. Without a guard, a later edit
   * could drop it and every gate on this row would stay green while the seam silently stopped
   * reading durable state — which is precisely the inversion this seam exists to close.
   *
   * So this is a SOURCE-TEXT guard, deliberately, and it is the narrowest one that works: it
   * asserts the seam names the reader and passes it the run's identity. It is scoped by
   * reading the module's own path rather than a fixed line number, so a refactor that moves
   * the call does not red it — only removing the call does.
   */
  it("names readApprovalRecordFacts at the composition site and hands it the run identity", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "approval-intent.ts"),
      "utf8",
    );
    // Non-vacuous: the file was actually read and is the module we mean.
    expect(source).toContain("APPROVAL_MISSING_FACT_CODES");
    expect(source.length).toBeGreaterThan(1000);

    expect(source).toContain("readApprovalRecordFacts");
    // The run's identity reaches it — a call that passed only the project would derive the
    // policy ref for the right project while naming the wrong run.
    expect(source).toMatch(/readApprovalRecordFacts\([\s\S]{0,200}runId/u);
    // And its answer is what the seam refuses on, rather than a literal beside it.
    expect(source).toContain("facts.missing");
  });

  /**
   * THE SAME PROPERTY ONE SEAM LATER (task-3b61860f), REPHRASED BY task-f42d5165 FROM AN
   * ARRANGEMENT INTO AN INVARIANT.
   *
   * The original guard asserted the burn CALL EXISTS and sits after `facts.ok`. It had to: no
   * fixture could reach `facts.ok`, so deleting the call left every behavioural arm green and
   * only a source-text proxy could see it. task-f42d5165 landed the tier's producer, `facts.ok`
   * became reachable, and the burn had to leave the seam — burning with no record to follow it
   * would consume the one-shot reference and then refuse, bricking every retry. The seam now
   * refuses `APPROVAL_INTENT_RECORD_UNMINTED` first and task-6093483c restores the burn in the
   * same edit that lands the mint.
   *
   * So the clause that survives is the DANGEROUS ARRANGEMENT, not the call's presence: IF the
   * seam burns at all, the burn is after the gate. That is true with no burn, true once the
   * mint restores it correctly, and RED the moment anyone places a burn ahead of the facts gate
   * — which is the only arrangement that can brick a retry. The behaviour itself is now
   * directly asserted next door, in approval-intent.test.ts's "burns NOTHING when the approval
   * refuses" arm, which this row made load-bearing rather than accidentally true.
   */
  it("never burns the step-up reference ahead of the facts gate", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "approval-intent.ts"),
      "utf8",
    );
    // Non-vacuous: the file was actually read and is the module we mean.
    expect(source).toContain("APPROVAL_MISSING_FACT_CODES");
    expect(source.length).toBeGreaterThan(1000);

    const derive = source.indexOf("deriveStepUpAuthRef(");
    const gate = source.indexOf("if (!facts.ok)");
    // The CALL site, not a mention: the comments explaining the absence name the symbol too, and
    // a guard that counted those would go green on prose alone.
    const burn = source.indexOf("burnStepUpAuthRef(input.store");
    expect(derive).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);

    // DERIVE before the reader — its result is what the reader is handed.
    expect(derive).toBeLessThan(source.indexOf("readApprovalRecordFacts("));
    // AND IF THE SEAM BURNS AT ALL, it burns after the gate, so a refused approval writes
    // nothing durable and the reference survives for the retry.
    if (burn !== -1) expect(burn).toBeGreaterThan(gate);
  });
});

/**
 * task-be80cb74 — the BUDGET_REF slot, filled from the decide-time COMMITMENT.
 *
 * The slot's original doc said the budget ref could never be derived here because it is minted
 * at ACTIVATION, downstream of the record it would sign. That stopped being true when
 * task-61a2e8ad landed: `budgetRef` on an approval record is now a commitment over the material
 * the human saw, and that material is durable BEFORE activation. So the slot has a producer.
 *
 * The walk still refuses under the TIER, which is first in the roster and has no producer at
 * all, so the budget slot is graded on `derived` behind that refusal — which is exactly what
 * `ApprovalRecordFactsIncomplete.derived` exists for.
 */
describe("the BUDGET_REF slot (task-be80cb74)", () => {
  function approvedRunQuery(store: SqliteEventStore): Record<string, unknown> {
    const sources = readApprovalIntentSources(store, PROJECT_ID, RUN_ID);
    if (!sources.ok) throw new Error(`fixture run unreadable: ${sources.code}`);
    if (!sources.binding.ok) throw new Error(`fixture run unbound: ${sources.binding.code}`);
    return {
      approvedRun: {
        runBinding: sources.binding.binding,
        verifiedGraphRevisionRef: sources.graphRevisionRef,
      },
      goalRef: sources.goalRef,
      projectId: PROJECT_ID,
    };
  }

  it("derives a budget ref the activation bind-back itself accepts", () => {
    const store = reviewableStore();
    const result = readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const derivedRef = result.derived.budgetRef;
    expect(derivedRef).toMatch(/^[0-9a-f]{64}$/u);
    // THE STRONG FORM. Not "equals a digest this test recomputed" — that would pass for any
    // shared bug. The production bind-back that guards activation is asked whether it accepts
    // this ref, so the seam and the fence are proven to agree through production on both sides.
    const verdict = verifyBudgetCommitment(store, approvedRunQuery(store) as never, derivedRef);
    expect(verdict.ok, verdict.ok ? "ok" : String(verdict.code)).toBe(true);
    // And it is the COMMITMENT notion specifically, not some other 64-hex the seam had lying
    // around: the shared builder's own digest over the same durable material.
    const material = budgetCommitmentMaterial(store, approvedRunQuery(store) as never);
    if (!material.ok) throw new Error(`fixture material refused: ${material.code}`);
    expect(derivedRef).toBe(budgetCommitmentDigest(material.material));
  });

  it("leaves the slot ABSENT and carries the upstream when nothing durable answers", () => {
    const store = openStore();
    const result = readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // ABSENT, not defaulted: the key is not present at all, so "{}" and a zero digest stay
    // different answers, per the module's own ABSENCE IS NOT A VALUE contract.
    expect("budgetRef" in result.derived).toBe(false);
    // task-f42d5165 moved the upstream from the budget builder's refusal to the tier
    // selector's. That is roster order doing its job, not a loss: RISK_TIER is index 0, so on a
    // store where NOTHING is derivable the operator is sent to the first producer that owes an
    // answer. The budget half of this arm -- the slot stays ABSENT rather than defaulting -- is
    // unchanged and is what this arm exists to pin.
    expect(result.upstream).toEqual({
      code: "RUN_POLICY_SELECTION_ABSENT", layer: "DAEMON_RUN_POLICY_SELECTION",
    });
  });
});

/**
 * task-f42d5165 (T1-c) — the RISK_TIER slot, filled from the run's own policy evaluation.
 *
 * THE TIER IS NEVER A LITERAL HERE. Every arm compares against what the PRODUCTION selector
 * `readRunPolicyEvaluation` answers for the same run, so a reader that hard-coded "R2" would
 * still have to explain why the independently-composed production path agrees.
 */
describe("the risk tier comes from the run's own evaluation (task-f42d5165)", () => {
  it("derives the tier the production selector answers for this run", () => {
    const store = reviewableStore();
    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });
    if (!selected.ok) throw new Error(`the journey must evaluate: ${selected.code}`);

    const facts = readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });

    if (facts.ok) throw new Error("the step-up fact is seam-derived, so this must stay incomplete");
    // PRODUCTION-vs-PRODUCTION: both sides computed, neither spelled.
    expect(facts.derived.riskTier).toBe(selected.evaluation.riskTier);
    // NON-VACUITY: `toBe(undefined) === toBe(undefined)` would pass for a reader that derives
    // nothing at all, so the value is also required to be a real tier.
    expect(facts.derived.riskTier).toMatch(/^R[0-3]$/u);
  });

  it("advances past RISK_TIER to the next roster code once the tier resolves", () => {
    const store = reviewableStore();

    const facts = readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });

    if (facts.ok) throw new Error("the step-up fact is seam-derived, so this must stay incomplete");
    // THE MOVEMENT THIS ROW DELIVERS. Before it, the walk answered index 0 forever; the tier now
    // has a durable producer, so the roster's SECOND code is what an operator is sent to.
    expect(facts.missing).toBe(APPROVAL_MISSING_FACT_CODES[1]);
    expect(facts.missing).toBe("APPROVAL_INTENT_STEP_UP_UNAVAILABLE");
  });

  it("leaves the tier ABSENT and carries the selector's refusal verbatim", () => {
    // A store the journey never drove: no run evaluation exists for this run.
    const store = openStore();

    const facts = readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID });

    if (facts.ok) throw new Error("an unevaluated run must not complete");
    // ABSENT, not defaulted: the key is not present at all. A defaulted tier would silently
    // decide an authority question, since approval-invalidation.ts:73 special-cases R3.
    expect("riskTier" in facts.derived).toBe(false);
    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
    // VERBATIM, not restamped, and FIRST: the tier is roster index 0, so its upstream outranks
    // the policy and budget builders' refusals on the same empty store.
    expect(facts.upstream).toEqual({
      code: "RUN_POLICY_SELECTION_ABSENT", layer: "DAEMON_RUN_POLICY_SELECTION",
    });
  });

  it("never answers with another run's tier", () => {
    const store = reviewableStore();
    const selected = readRunPolicyEvaluation(store, { projectId: PROJECT_ID, runId: RUN_ID });
    if (!selected.ok) throw new Error(`the journey must evaluate: ${selected.code}`);

    // A run the journey never evaluated. A recency-keyed or project-wide reader would hand back
    // the journey's tier here; a run-keyed one has nothing to answer with.
    const facts = readApprovalRecordFacts(
      store, { projectId: PROJECT_ID, runId: `${RUN_ID}-unevaluated` },
    );

    if (facts.ok) throw new Error("an unevaluated run must not complete");
    expect("riskTier" in facts.derived).toBe(false);
    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
    expect(facts.upstream).toEqual({
      code: "RUN_POLICY_SELECTION_ABSENT", layer: "DAEMON_RUN_POLICY_SELECTION",
    });
  });
});
