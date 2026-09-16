import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOVERNANCE_BASES,
  GOVERNANCE_DECISION_VERSION,
  createGovernanceDecisionLedger,
  governanceAggregateId,
  governanceDecisionId,
  validGovernanceDecision,
} from "./governance-decision-ledger.js";
import type { GovernanceDecisionInput } from "./governance-decision-ledger.js";

/**
 * The durable half of governance: what a decision has to carry to be citable, and what the list
 * of them has to guarantee to be worth showing anyone.
 *
 * The live case these are written against (UnAI 2026-09-16): a node reported the SAME finding on
 * rounds 1, 2, 4 and 5 — `registry-review-obligation-description-cardinality`, an unresolved
 * product question — and said in its own words "no registry review is recorded". Guidance that
 * lives only in a prompt cannot answer that. A record can.
 */

const PROJECT = "project-governance";
const NODE = "node:v1:registry-release";
const stores: SqliteEventStore[] = [];

function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  stores.push(store);
  return store;
}

const decided = (over: Partial<GovernanceDecisionInput> = {}): GovernanceDecisionInput => ({
  answer: "shared.obligation.description is SET.",
  basis: "GOVERNANCE_DECIDED",
  citation: null,
  criterionId: "CRT-REG-03-A",
  findingId: "registry-review-obligation-description-cardinality",
  findingSubject: "CRITERION:CRT-REG-03-A",
  question: "Should shared.obligation.description be FUNCTIONAL or SET?",
  rationale: "Paraphrases from different sources would otherwise read as conflicting values.",
  reviewVersion: 4,
  subjectRef: NODE,
  supersedes: null,
  ...over,
});

const cited = (over: Partial<GovernanceDecisionInput> = {}): GovernanceDecisionInput =>
  decided({ basis: "PRD_CITED", citation: "PRD 26.1", rationale: "", ...over });

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("a governance decision record", () => {
  it("keeps the decision so a later round can cite it instead of asking again", () => {
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);

    expect(ledger.record(decided())).toBe(true);

    const [kept] = ledger.forSubject(NODE);
    expect(kept).toMatchObject({
      answer: "shared.obligation.description is SET.",
      basis: "GOVERNANCE_DECIDED",
      criterionId: "CRT-REG-03-A",
      subjectRef: NODE,
      version: GOVERNANCE_DECISION_VERSION,
    });
    expect(kept?.decisionId).toBe(governanceDecisionId(decided()));
  });

  it("has no state a run could wait on", () => {
    // The owner's constraint, 2026-09-16: "but it will not stop and wait for answer". A record
    // with no status field is a record nothing can block on; this pins the key set so a later
    // change cannot quietly introduce one and turn governance back into a gate.
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);
    ledger.record(decided());

    const [kept] = ledger.all();
    expect(Object.keys(kept ?? {}).sort()).toEqual([
      "answer", "basis", "citation", "criterionId", "decisionId", "findingId", "findingSubject",
      "question", "rationale", "reviewVersion", "subjectRef", "supersedes", "version",
    ]);
    for (const key of ["status", "state", "pending", "approved", "awaiting"]) {
      expect(kept).not.toHaveProperty(key);
    }
  });

  it("is the same block when it is the same question, and a new one when the review moved", () => {
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);

    expect(ledger.record(decided())).toBe(true);
    // Re-recording the identical decision must not double the list the owner reads.
    expect(ledger.record(decided())).toBe(true);
    expect(ledger.all()).toHaveLength(1);

    expect(ledger.record(decided({ reviewVersion: 5 }))).toBe(true);
    expect(ledger.all()).toHaveLength(2);
    expect(governanceDecisionId(decided()))
      .not.toBe(governanceDecisionId(decided({ reviewVersion: 5 })));
  });

  it("counts the attempts it funded, not the opinions it authored", () => {
    // The bound exists to stop governance funding attempt after attempt, so it counts ATTEMPTS.
    // Counting `GOVERNANCE_DECIDED` rows instead let a governor that cited the PRD fund attempts
    // for free at `maxDecisions: 1` — free of new authority, but not of the tokens and repository
    // work every attempt spends, which is the whole thing the bound protects.
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);

    // One attempt answering two questions from the record is ONE attempt: not zero, not two.
    ledger.record(cited());
    ledger.record(cited({ findingId: "registry-release-tag-not-created" }));
    expect(ledger.fundedOn(NODE)).toBe(1);

    // The next attempt is a new review version, and that is the thing being counted.
    ledger.record(decided({ findingId: "a-question-the-prd-does-not-answer", reviewVersion: 5 }));
    expect(ledger.fundedOn(NODE)).toBe(2);
    expect(ledger.all()).toHaveLength(3);
  });

  it("is a different block for the same rule raised against a different subject", () => {
    // A rule id names the CHECK, not the thing checked. Two contracts failing one cardinality
    // rule are two questions with two answers; collapsing them into one block records a single
    // judgement and silently drops the one never made about the other subject.
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);
    const elsewhere = { findingSubject: "CRITERION:CRT-REG-09-B" };

    expect(ledger.record(decided())).toBe(true);
    expect(ledger.record(decided({
      answer: "billing.obligation.description is FUNCTIONAL.", ...elsewhere,
    }))).toBe(true);

    expect(ledger.all()).toHaveLength(2);
    expect(governanceDecisionId(decided()))
      .not.toBe(governanceDecisionId(decided(elsewhere)));
  });

  it("keeps one node's decisions out of another's", () => {
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);
    ledger.record(decided());
    ledger.record(decided({ subjectRef: "node:v1:other" }));

    expect(ledger.forSubject(NODE)).toHaveLength(1);
    expect(ledger.fundedOn("node:v1:other")).toBe(1);
  });

  it("shows nothing rather than a short history when a row cannot be read", () => {
    // Skipping an unreadable row would under-count the bound AND show the owner fewer
    // decisions than were actually taken. Both are worse than an empty list.
    const store = openStore();
    const ledger = createGovernanceDecisionLedger(store, PROJECT);
    ledger.record(decided());

    const aggregateId = governanceAggregateId(PROJECT);
    store.commit({
      aggregateId,
      commandBytes: new TextEncoder().encode("{}"),
      commandId: "gov-corrupt-1",
      committedAt: new Date().toISOString(),
      events: [{
        eventId: "gov-corrupt-1-e1",
        eventType: "GovernanceDecisionRecorded",
        payload: new TextEncoder().encode("not json"),
      }],
      expectedVersion: store.getAggregateVersion(aggregateId),
    });

    expect(ledger.all()).toEqual([]);
    expect(ledger.fundedOn(NODE)).toBe(0);
  });
});

describe("what a decision has to carry", () => {
  it("names both bases and nothing else", () => {
    expect([...GOVERNANCE_BASES]).toEqual(["PRD_CITED", "GOVERNANCE_DECIDED"]);
  });

  it("refuses a citation that cites nothing and a decision that reasons nothing", () => {
    // The two arms carry different obligations, and each is the thing a reader of the
    // building-blocks list could never recover afterwards.
    expect(validGovernanceDecision(cited())).toBe(true);
    expect(validGovernanceDecision(cited({ citation: null }))).toBe(false);
    expect(validGovernanceDecision(cited({ citation: "   " }))).toBe(false);

    expect(validGovernanceDecision(decided())).toBe(true);
    expect(validGovernanceDecision(decided({ rationale: "" }))).toBe(false);
    expect(validGovernanceDecision(decided({ rationale: "  " }))).toBe(false);
    // Governance decided BECAUSE the product record is silent; it may not also cite one.
    expect(validGovernanceDecision(decided({ citation: "PRD 26.1" }))).toBe(false);
  });

  it("refuses a record whose subject, question or answer is missing", () => {
    const missing: readonly (readonly [Partial<GovernanceDecisionInput>, string])[] = [
      [{ answer: "" }, "no answer"],
      [{ question: " " }, "no question"],
      [{ subjectRef: "" }, "no subject"],
      [{ findingId: "" }, "no finding"],
      [{ findingSubject: "  " }, "no subject the finding was raised against"],
      [{ reviewVersion: -1 }, "review version negative"],
      [{ reviewVersion: 1.5 }, "review version non-integer"],
      [{ answer: "x".repeat(4001) }, "answer beyond the storable bound"],
      [{ basis: "SOMETHING_ELSE" as GovernanceDecisionInput["basis"] }, "unknown basis"],
    ];
    expect(missing.length).toBe(9);

    for (const [over, why] of missing) {
      expect(validGovernanceDecision(decided(over)), why).toBe(false);
    }
  });

  it("does not keep a malformed decision at all", () => {
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);

    expect(ledger.record(decided({ rationale: "" }))).toBe(false);
    expect(ledger.all()).toEqual([]);
  });

  it("carries a supersession forward instead of rewriting what was already decided", () => {
    // A human who disagrees later records over the top; the earlier decision stays readable,
    // because the rounds it already steered actually happened.
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);
    ledger.record(decided());
    const first = governanceDecisionId(decided());

    expect(ledger.record(decided({
      answer: "shared.obligation.description is FUNCTIONAL.",
      reviewVersion: 6,
      supersedes: first,
    }))).toBe(true);

    const all = ledger.all();
    expect(all).toHaveLength(2);
    expect(all[0]?.answer).toContain("SET");
    expect(all[1]?.supersedes).toBe(first);
  });
});
