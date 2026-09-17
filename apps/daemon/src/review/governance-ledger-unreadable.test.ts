import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { createGovernanceDecisionLedger } from "./governance-decision-ledger.js";

/**
 * AN UNREADABLE LEDGER MUST NOT READ AS "NOTHING HAS BEEN FUNDED".
 *
 * `fundedOn` counts the attempts governance has already paid for, and the policy bound is
 * checked against it BEFORE the advisor is asked. Both failure arms of the ledger's read
 * returned an EMPTY LIST — a store throw, and a row that would not decode — so an unreadable
 * ledger counted as ZERO funded attempts. The bound is then never reached, and governance funds
 * another attempt, and another, each one spending a real model call and real repository work.
 *
 * The module's own comment states the rule it broke: "a list that silently drops decisions would
 * under-count the bound and show the owner a shorter history than actually happened." Returning
 * `[]` under-counts it maximally.
 *
 * This is the repository's fail-closed rule applied to the one place it pays for itself:
 * funding an attempt IS authority, and unverifiable evidence gains none. An unreadable ledger
 * stops for the human rather than spending on a bound nobody can prove is unspent.
 */

const AGGREGATE_FAULT = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

function throwingStore(): SqliteEventStore {
  return {
    commit: () => { throw AGGREGATE_FAULT; },
    getAggregateVersion: () => 0,
    readEvents: (): never => { throw AGGREGATE_FAULT; },
  } as unknown as SqliteEventStore;
}

function emptyStore(): SqliteEventStore {
  return {
    commit: () => undefined,
    getAggregateVersion: () => 0,
    readEvents: () => [],
  } as unknown as SqliteEventStore;
}

describe("the governance decision ledger under an unreadable store", () => {
  it("answers null from fundedOn rather than zero", () => {
    const ledger = createGovernanceDecisionLedger(throwingStore(), "project-1");

    expect(ledger.fundedOn("node-1")).toBeNull();
  });

  it("still answers 0 for a store that genuinely holds no decisions", () => {
    const ledger = createGovernanceDecisionLedger(emptyStore(), "project-1");

    expect(ledger.fundedOn("node-1")).toBe(0);
  });

  it("refuses to record when it cannot read, so no duplicate block is written", () => {
    // `record` checks idempotence by reading the aggregate first. With an unreadable read that
    // check answered "not recorded" for everything, so a decision already on the aggregate was
    // written a second time.
    const ledger = createGovernanceDecisionLedger(throwingStore(), "project-1");

    expect(ledger.record({
      answer: "cite the PRD",
      basis: "PRD",
      citation: "docs/VISION.md",
      criterionId: "crit-1",
      findingId: "finding-1",
      findingSubject: "node-1",
      question: "which contract governs?",
      rationale: "the PRD names it",
      reviewVersion: 1,
      subjectRef: "node-1",
      supersedes: null,
    } as never)).toBe(false);
  });

  it("keeps all() and forSubject() honest by answering null when it cannot read", () => {
    const ledger = createGovernanceDecisionLedger(throwingStore(), "project-1");

    expect(ledger.all()).toBeNull();
    expect(ledger.forSubject("node-1")).toBeNull();
  });

  it("answers an empty list, not null, when the store is merely empty", () => {
    const ledger = createGovernanceDecisionLedger(emptyStore(), "project-1");

    expect(ledger.all()).toEqual([]);
    expect(ledger.forSubject("node-1")).toEqual([]);
  });
});
