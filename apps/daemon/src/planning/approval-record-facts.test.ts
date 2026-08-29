import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readPolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  PROJECT_ID,
  RUN_ID,
  closeStores,
  driveThrough,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";
import { readApprovalRecordFacts } from "./approval-record-facts.js";
import type {
  ApprovalRecordFacts,
  ApprovalRecordFactsIncomplete,
} from "./approval-record-facts.js";
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
 * The policy ref PRODUCTION derives, computed here by the same strict reader over the same
 * newest-first selection, so the expectation is a second read of one durable fact rather than
 * a value this suite chose.
 */
function durablePolicyRef(store: SqliteEventStore): string {
  const events = store.readEvents(policyAggregateId(PROJECT_ID));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== "PolicyEvaluated") continue;
    const payload: unknown = JSON.parse(new TextDecoder().decode(event.payload));
    const authority = readPolicyEvaluationAuthority(
      payload as never, PROJECT_ID, Date.parse(event.committedAt),
    );
    if (authority.ok) return authority.policyRef;
  }
  throw new Error("the harness left no replay-verified PolicyEvaluated");
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

describe("the approval record facts come from durable state, never from a caller", () => {
  it("derives applicablePolicyRef as the strict reader's policyRef for the same store", () => {
    const store = reviewableStore();
    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );

    // A second read of the SAME durable fact through production's own reader. Not a literal:
    // a hardcoded-return mutant passes a literal and fails this.
    expect(facts.derived.applicablePolicyRef).toBe(durablePolicyRef(store));
    // Non-vacuous: the expectation is a real 64-hex digest, not an empty string agreeing with
    // an empty string.
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

  it("ignores a PolicyEvaluated the strict reader refuses, rather than trusting the newest row", () => {
    const store = reviewableStore();
    const honest = durablePolicyRef(store);
    // A NEWER PolicyEvaluated planted through the store's raw API, carrying a plausible-looking
    // policyRef but no verifiable decision material. Newest-first selection alone would take
    // it; the strict reader is what refuses it.
    const forged = "f".repeat(64);
    store.commit({
      aggregateId: policyAggregateId(PROJECT_ID),
      commandBytes: new TextEncoder().encode("plant-forged-policy-evaluated"),
      commandId: "cmd-plant-forged-policy-evaluated",
      committedAt: "2026-08-29T23:00:00.000Z",
      events: [{
        eventId: "policy-evaluated-forged",
        eventType: "PolicyEvaluated",
        payload: new TextEncoder().encode(JSON.stringify({ policyRef: forged })),
      }],
      expectedVersion: store.getAggregateVersion(policyAggregateId(PROJECT_ID)),
    });

    const facts = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    expect(facts.derived.applicablePolicyRef).not.toBe(forged);
    expect(facts.derived.applicablePolicyRef).toBe(honest);
  });

  it("takes only {projectId, runId}, so no caller can present a ref or a tier", () => {
    // Structural, not a runtime check. The request vocabulary has exactly two keys and neither
    // is a digest or a tier; a caller-presented ref would make the fence compare a value
    // against itself.
    const request: Parameters<typeof readApprovalRecordFacts>[1] = {
      projectId: PROJECT_ID, runId: RUN_ID,
    };
    expect(Object.keys(request).sort()).toEqual(["projectId", "runId"]);
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
});

describe("the derived ref is the SAME notion the supersede fence compares against", () => {
  /**
   * The fence at `graph-supersede-approval-binding.ts:94` compares a record's
   * `applicablePolicyRef` against `readSupersessionPolicyDecision`'s `policyRef`. That function
   * cannot ANSWER for a plan approval — its subject filter
   * (`supersession-policy-decision.ts:57-62`) requires `action === "graph.supersede"` with one
   * matching successor ref, and a plan approval is never that — so an arm asserting the two
   * VALUES agree here is unsatisfiable by construction, not by fixture choice.
   *
   * What IS provable, and is the claim that actually matters, is that both read the SAME ROW
   * through the SAME strict reader and differ ONLY by that subject filter. The selector's
   * refusal distinguishes the two cases itself: `SUBJECT_MISMATCH` means it FOUND and
   * REPLAY-VERIFIED a decision and rejected it only on subject, whereas `ABSENT` would mean it
   * never verified one at all. Asserting the former pins that my derivation and the fence's are
   * looking at the same verified row.
   */
  it("selects the row the fence verifies, differing only by the supersede subject filter", () => {
    const store = reviewableStore();
    const mine = incompleteFacts(
      readApprovalRecordFacts(store, { projectId: PROJECT_ID, runId: RUN_ID }),
    );
    const fence = readSupersessionPolicyDecision(store, PROJECT_ID, "any-successor-revision");

    // I derived a ref from a verified row.
    expect(mine.derived.applicablePolicyRef).toBe(durablePolicyRef(store));
    // The fence verified a row too — and rejected it ONLY on subject, not for absence. Were it
    // ABSENT, the two would be reading different worlds and the "same notion" claim would fail.
    expect(fence.ok).toBe(false);
    expect(fence.ok ? "" : fence.code).toBe("SUPERSESSION_POLICY_DECISION_SUBJECT_MISMATCH");
    expect(fence.ok ? "" : fence.code).not.toBe("SUPERSESSION_POLICY_DECISION_ABSENT");
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
});
