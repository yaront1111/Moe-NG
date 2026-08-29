import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqliteEventStore } from "@moe/store";
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  PROJECT_ID,
  RUN_ID,
  closeStores,
  driveThrough,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";
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
 * THE TIER IS NOT THIS ROW'S. No durable pre-approval producer exists for `riskTier`, so the
 * reader always reports it missing and the seam keeps refusing under that name. Absence is not
 * a default: a defaulted tier would silently decide an authority question
 * (`approval-invalidation.ts:73` special-cases R3).
 */

afterEach(() => { closeStores(); });

/** The world the shipped journey leaves just BEFORE its approval: sealed, PLAN_REVIEW. */
function reviewableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

/**
 * Narrows to the incomplete arm, which every fixture in this suite yields: no tier producer
 * exists, so the reader can never answer `ok: true` today. Asserting that rather than casting
 * means a future reader that DID answer complete would fail here loudly instead of silently
 * skipping every assertion below.
 */
function incompleteFacts(facts: ApprovalRecordFacts): ApprovalRecordFactsIncomplete {
  if (facts.ok) throw new Error("expected an incomplete result: no tier producer exists yet");
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

  it("reports the tier missing FIRST, in the seam's own roster order", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    // The ORDER is the assertion, not the value: the reader names the first fact the seam's
    // roster lists as unavailable, so a reader that answered with whichever it noticed last
    // would red here.
    expect(facts.missing).toBe(APPROVAL_MISSING_FACT_CODES[0]);
    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
    // The ref IS derivable even while the tier is not, so the two facts are independent
    // answers rather than one all-or-nothing verdict.
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

  it("merges the SEAM-derived step-up fact into the walk without inverting the order", () => {
    const store = reviewableStore();

    // The seam's own server-derived fact reaches `derived` and is readable back through the
    // PRODUCTION reader result -- not a test helper -- while the walk still answers the tier.
    const facts = incompleteFacts(readApprovalRecordFacts(
      store,
      { projectId: PROJECT_ID, runId: RUN_ID },
      { stepUpAuthRef: STEP_UP_REF },
    ));

    expect(facts.derived.stepUpAuthRef).toBe(STEP_UP_REF);
    expect(facts.derived.applicablePolicyRef).toBeDefined();
    // ORDER PRESERVED: the tier is still first and still unestablished, so an operator is sent
    // there rather than to a fact the seam just supplied.
    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
  });

  it("leaves the step-up fact ABSENT when the seam derived none, never defaulted", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    expect(facts.derived).not.toHaveProperty("stepUpAuthRef");
    expect(facts.missing).toBe("APPROVAL_INTENT_RISK_TIER_UNAVAILABLE");
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
   * THE SAME PROPERTY ONE SEAM LATER, and it is here for the same measured reason
   * (task-3b61860f). The step-up BURN sits after `facts.ok`, which no fixture can reach today:
   * `budgetRef` has no producer, so the walk always answers before it. Deleting the burn call
   * therefore leaves every behavioural arm green — including the one-shot arms, which drive
   * `burnStepUpAuthRef` directly. This guard is what makes the CALL's existence and its ORDER
   * observable, and it is the narrowest form that works: it does not pin a line number, so a
   * refactor that moves the call does not red it — only removing it, or moving it AHEAD of the
   * `facts.ok` gate, does.
   */
  it("burns the step-up reference at the seam, strictly after the facts gate", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "approval-intent.ts"),
      "utf8",
    );
    // Non-vacuous: the file was actually read and is the module we mean.
    expect(source).toContain("APPROVAL_MISSING_FACT_CODES");
    expect(source.length).toBeGreaterThan(1000);

    const derive = source.indexOf("deriveStepUpAuthRef(");
    const gate = source.indexOf("if (!facts.ok)");
    const burn = source.indexOf("burnStepUpAuthRef(");
    expect(derive).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(burn).toBeGreaterThan(-1);

    // DERIVE before the reader (its result is what the reader is handed), BURN after the gate
    // (so a refused approval writes nothing durable).
    expect(derive).toBeLessThan(source.indexOf("readApprovalRecordFacts("));
    expect(burn).toBeGreaterThan(gate);
    // The ledger's own refusal travels back unrestamped rather than as this seam's layer.
    expect(source).toContain("burned.code, burned.layer");
  });
});
