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
import { decideGovernanceEscalation } from "./governance-escalation-decider.js";
import {
  PROJECT_ID as REVIEW_PROJECT,
  SUBJECT_REF as REVIEW_SUBJECT,
  closeStores,
  driveRounds,
  openStore as openReviewStore,
} from "./review-test-fixtures.js";

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
  closeStores();
});

describe("a governance decision record", () => {
  it("keeps the decision so a later round can cite it instead of asking again", () => {
    const ledger = createGovernanceDecisionLedger(openStore(), PROJECT);

    expect(ledger.record(decided())).toBe(true);

    const [kept] = ledger.forSubject(NODE) ?? [];
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

    const [kept] = ledger.all() ?? [];
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

  it("says it cannot read rather than showing a short history when a row will not decode", () => {
    // Skipping an unreadable row would under-count the bound AND show the owner fewer decisions
    // than were actually taken. This arm used to pin an EMPTY LIST as the safe answer — but an
    // empty list is itself an under-count, and the maximal one: `fundedOn` read it as zero
    // funded attempts, so the bound was never reached and governance kept funding. NULL is the
    // honest answer, and the decider stops for the human on it.
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

    expect(ledger.all()).toBeNull();
    expect(ledger.fundedOn(NODE)).toBeNull();
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
    expect(all, "the governance ledger could not be read").not.toBeNull();
    expect(all).toHaveLength(2);
    expect(all?.[0]?.answer).toContain("SET");
    expect(all?.[1]?.supersedes).toBe(first);
  });
});

/**
 * The exact shape #51 wrote: twelve keys, no `findingSubject`, and the SAME version literal #52
 * kept when it added the thirteenth. Measured on UnAI 2026-09-18: three such rows sat first in
 * the aggregate, `read()` answered null on the first of them, `fundedOn` was null for every node,
 * and governance stopped for the human 302 times without once asking its advisor.
 */
const LEGACY_ROW = Object.freeze({
  answer: "shared.obligation.description is SET.",
  basis: "GOVERNANCE_DECIDED",
  citation: null,
  criterionId: "CRT-REG-03-A",
  decisionId: "4f1d0c2b9a8e7d6c5b4a39281706f5e4",
  findingId: "registry-review-obligation-description-cardinality",
  question: "Should shared.obligation.description be FUNCTIONAL or SET?",
  rationale: "Paraphrases from different sources would otherwise read as conflicting values.",
  reviewVersion: 3,
  subjectRef: NODE,
  supersedes: null,
  version: GOVERNANCE_DECISION_VERSION,
});

/** A row as the store holds it, bypassing `record` so a shape it would never write can be kept. */
function commitPayload(store: SqliteEventStore, projectId: string, payload: string): void {
  const aggregateId = governanceAggregateId(projectId);
  const version = store.getAggregateVersion(aggregateId);
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode("{}"),
    commandId: `gov-seeded-${String(version)}`,
    committedAt: new Date().toISOString(),
    events: [{
      eventId: `gov-seeded-${String(version)}-e1`,
      eventType: "GovernanceDecisionRecorded",
      payload: new TextEncoder().encode(payload),
    }],
    expectedVersion: version,
  });
}

const currentRow = (reviewVersion: number): string => {
  const input = decided({ reviewVersion });
  return JSON.stringify({
    ...input, decisionId: governanceDecisionId(input), version: GOVERNANCE_DECISION_VERSION,
  });
};

describe("a decision recorded before findingSubject existed", () => {
  it("still counts toward the bound, so one old row cannot blind governance to every node", () => {
    const store = openStore();
    commitPayload(store, PROJECT, JSON.stringify(LEGACY_ROW));
    commitPayload(store, PROJECT, currentRow(4));
    const ledger = createGovernanceDecisionLedger(store, PROJECT);

    expect(Object.keys(LEGACY_ROW)).toHaveLength(12);
    expect(ledger.fundedOn(NODE)).toBe(2);
    // The attempt governance funds next is still recorded behind the old row, and still counted.
    expect(ledger.record(decided({ reviewVersion: 5 }))).toBe(true);
    expect(ledger.fundedOn(NODE)).toBe(3);
  });

  it("reads the old row back whole, stating that its subject was never recorded", () => {
    const store = openStore();
    commitPayload(store, PROJECT, currentRow(4));
    // LAST rather than first: where the old shape sits in the aggregate must not matter.
    commitPayload(store, PROJECT, JSON.stringify(LEGACY_ROW));

    const all = createGovernanceDecisionLedger(store, PROJECT).all();
    expect(all).toHaveLength(2);
    expect(all?.[0]?.findingSubject).toBe("CRITERION:CRT-REG-03-A");
    // All twelve stored fields come back unchanged; only the one never written is stated.
    expect(all?.[1]).toStrictEqual({ ...LEGACY_ROW, findingSubject: "LEGACY:unrecorded" });
  });

  it("still cannot read any other shape, so a corrupt row is never mistaken for an old one", () => {
    const { rationale: _rationale, ...noRationale } = JSON.parse(currentRow(4)) as
      Record<string, unknown>;
    const unreadable: readonly (readonly [string, string])[] = [
      [JSON.stringify({ ...JSON.parse(currentRow(4)) as object, status: "PENDING" }),
        "a key neither shape has"],
      [JSON.stringify({ ...LEGACY_ROW, status: "PENDING" }), "thirteen keys, one of them wrong"],
      // Twelve keys, like the old shape, but missing a key the old shape HAD: an upcast that
      // admitted any twelve-key object would read this as a decision with no rationale.
      [JSON.stringify(noRationale), "twelve keys, missing rationale rather than findingSubject"],
      [JSON.stringify({ ...LEGACY_ROW, version: "moe-governance-decision/0" }),
        "the old shape under another version"],
      ["not json", "unparsable JSON"],
    ];
    expect(unreadable.length).toBe(5);

    for (const [payload, why] of unreadable) {
      const store = openStore();
      // A readable row first, so the null below is the bad row's doing and nothing else's.
      commitPayload(store, PROJECT, currentRow(4));
      commitPayload(store, PROJECT, payload);
      const ledger = createGovernanceDecisionLedger(store, PROJECT);
      expect(ledger.all(), why).toBeNull();
      expect(ledger.fundedOn(NODE), why).toBeNull();
    }
  });

  it("stops the decider at the ledger gate, before its advisor, on a bad row", async () => {
    // LEDGER_UNREADABLE is one of four HUMAN_NEEDED exits, and a code alone does not say which
    // layer produced it. The advisor count does: ROUND_CEILING, LEDGER_UNREADABLE and BOUND_SPENT
    // all stop BEFORE asking, NO_ANSWER only after. So the control run — the same exhausted node
    // with the same old row and no bad one — must reach the advisor, or this arm tests nothing.
    async function decideOver(badRow: string | null) {
      const store = openReviewStore();
      driveRounds(store, 3);
      const legacy = { ...LEGACY_ROW, subjectRef: REVIEW_SUBJECT };
      commitPayload(store, REVIEW_PROJECT, JSON.stringify(legacy));
      if (badRow !== null) commitPayload(store, REVIEW_PROJECT, badRow);
      let asked = 0;
      const outcome = await decideGovernanceEscalation({
        advisor: () => { asked += 1; return Promise.resolve(null); },
        clock: () => "2026-09-18T00:00:00.000Z",
        policy: { kind: "AI_GOVERNOR", maxDecisions: 5 },
        projectId: REVIEW_PROJECT,
        store,
      }, REVIEW_SUBJECT);
      return { asked, outcome };
    }

    expect(await decideOver(null))
      .toEqual({ asked: 1, outcome: { kind: "HUMAN_NEEDED", why: "NO_ANSWER" } });
    expect(await decideOver(JSON.stringify({ ...LEGACY_ROW, status: "PENDING" })))
      .toEqual({ asked: 0, outcome: { kind: "HUMAN_NEEDED", why: "LEDGER_UNREADABLE" } });
  });
});
