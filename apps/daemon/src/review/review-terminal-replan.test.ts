import { afterEach, describe, expect, it } from "vitest";
import type { CommandDecisionRecord, EffectsCommittedDecision } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readReviewLedger } from "./review-read-model.js";
import type { ReviewLedger } from "./review-read-model.js";
import { readTerminalReplan } from "./review-terminal-replan.js";
import {
  PROJECT_ID, SUBJECT_REF, closeStores, commitRaw, deltaNode, driveRounds, envelope, escalationPayload, finding,
  openStore, replanPayload, send, submitPayload,
} from "./review-test-fixtures.js";

/**
 * The one proof both REPLAN readers share (planning/replan-context.ts and
 * repository/repository-replan-recovery-evidence.ts). Every store below is written through the
 * production review pipeline; a shape no handler writes is staged through `commitRaw` or the
 * store seam, and a tampered order or digest is a COPY of the read decisions, never a store edit.
 */

afterEach(closeStores);
type Store = ReturnType<typeof openStore>;

const ledgerOf = (store: Store): ReviewLedger => readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
const read = (store: Store, decisions: readonly CommandDecisionRecord[] = decisionsOf(store, 200), ledger = ledgerOf(store)) =>
  readTerminalReplan(decisions, PROJECT_ID, SUBJECT_REF, ledger);
const nodeRows = (store: Store) => decisionsOf(store, 200).filter((row): row is EffectsCommittedDecision =>
  row.effectDisposition === "EFFECTS_COMMITTED" && row.targetAggregateId === SUBJECT_REF);
const DELTA_RESULT = { classifications: [{ classification: "INVALIDATED", nodeRef: "node-1", reasonCodes: [], sourceHash: "", targetHash: "" }],
  successorPlanRef: "plan-revision-2" };

function ok(outcome: ReturnType<typeof send>): void {
  if (!outcome.ok) throw new Error(`setup refused: ${outcome.code}`);
}
function decide(store: Store, decision: "REPLAN" | "ALLOW_MORE_ATTEMPTS", id: string): void {
  ok(send(store, envelope("escalation.decide", ledgerOf(store).version, escalationPayload({ decision }), id)));
}
function agentReplan(store: Store, id: string): void {
  ok(send(store, envelope("qualification.replan", ledgerOf(store).version, replanPayload([deltaNode("node-1")]), id)));
}
function round(store: Store, number: number): void {
  ok(send(store, envelope("review.submit", ledgerOf(store).version, submitPayload(number,
    [finding({ ruleId: `rule-${number}`, subject: { kind: "NODE", locator: `node-${number}` } })]), `cmd-round-${number}`)));
}
function rawDelta(store: Store, id: string): void {
  ok(commitRaw(store, envelope("qualification.replan", ledgerOf(store).version, replanPayload([deltaNode("node-1")]), id),
    DELTA_RESULT, "ReplanDeltaClassified"));
}
function rawReplan(store: Store, result: Record<string, unknown>, id: string): void {
  ok(commitRaw(store, envelope("escalation.decide", ledgerOf(store).version, escalationPayload({ decision: "REPLAN" }), id),
    result, "ReviewEscalated"));
}
function stage(store: Store, commandKind: string, id: string, targetAggregateId = SUBJECT_REF): void {
  const bytes = new TextEncoder().encode("{}");
  const staged = store.commitExpectedVersionDecision({ commandKind, targetAggregateId, expectedVersion: store.getAggregateVersion(targetAggregateId),
    committedResultBytes: bytes, requestBytes: bytes, key: { projectId: PROJECT_ID, principalId: "staged", commandId: id },
    correlationId: "terminal-replan-test", decidedAt: "2026-08-09T00:00:00.000Z",
    events: [{ eventId: `${id}-event`, eventType: "StagedDecision", payload: bytes }] });
  expect(staged.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}
/** A copy of the read decisions with one row replaced; the store itself is never touched. */
function withRow(store: Store, decisionId: string, change: (row: EffectsCommittedDecision) => object): CommandDecisionRecord[] {
  const rows = decisionsOf(store, 200);
  expect(rows.some((row) => row.decisionId === decisionId)).toBe(true);
  return rows.map((row) => row.decisionId === decisionId
    ? { ...row, ...change(row as EffectsCommittedDecision) } as unknown as CommandDecisionRecord : row);
}

describe("admits the human REPLAN that is the node's last decision and answers its latest round", () => {
  it("with nothing between the exhausted round and the REPLAN", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    const rows = nodeRows(store);
    expect(read(store)).toEqual({ answered: rows[2], replan: rows[3] });
    expect(read(store)?.answered.decisionId).toBe(ledgerOf(store).rounds.at(-1)?.decisionId);
  });

  it("when an agent re-planned before the later rounds", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta"); round(store, 2); round(store, 3);
    decide(store, "REPLAN", "replan");
    expect(ledgerOf(store)).toMatchObject({ replanned: true, unreadable: false, version: 5 });
    expect(ledgerOf(store).delta).toBeDefined();
    expect(read(store)).toMatchObject({ answered: { currentVersion: 4 }, replan: { previousVersion: 4, currentVersion: 5 } });
  });

  it("when an agent re-planned between the exhausted round and the REPLAN", () => {
    const store = openStore(); driveRounds(store, 3); agentReplan(store, "between-delta"); decide(store, "REPLAN", "replan");
    const rows = nodeRows(store);
    expect(read(store)).toEqual({ answered: rows[2], replan: rows[4] });
    expect(read(store)).toMatchObject({ answered: { currentVersion: 3 }, replan: { previousVersion: 4, currentVersion: 5 } });
  });

  it("replacing a grant a legacy re-plan stranded", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "ALLOW_MORE_ATTEMPTS", "allow");
    rawDelta(store, "legacy-delta"); decide(store, "REPLAN", "replan");
    expect(read(store)).toMatchObject({ answered: { currentVersion: 3 }, replan: { previousVersion: 5, currentVersion: 6 } });
  });

  it("replacing an unspent grant", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "ALLOW_MORE_ATTEMPTS", "allow"); decide(store, "REPLAN", "replan");
    expect(read(store)).toMatchObject({ answered: { currentVersion: 3 }, replan: { previousVersion: 4, currentVersion: 5 } });
  });

  it("ignoring rows on other projects, other aggregates and refused audit rows", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    const expected = read(store);
    stage(store, "internal.test.unrelated", "other-node", "other-node-ref");
    const rows = decisionsOf(store, 200); const last = nodeRows(store).at(-1)!;
    const foreign: CommandDecisionRecord[] = [...rows,
      { ...last, decisionId: "foreign-project-replan", key: { ...last.key, projectId: "foreign-project" } },
      { ...last, decisionId: "refused-on-node", effectDisposition: "NO_BUSINESS_EFFECT", commandKind: "qualification.replan" } as unknown as CommandDecisionRecord];
    expect(expected).not.toBeNull();
    expect(read(store, foreign)).toEqual(expected);
  });
});

describe("refuses anything else", () => {
  it("an agent's re-plan after the REPLAN", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    rawDelta(store, "late-delta");
    expect(ledgerOf(store)).toMatchObject({ replanned: true, unreadable: false });
    expect(read(store)).toBeNull();
  });

  it("a REPLAN that is not the node's last decision, even against the ledger as it stood at the REPLAN", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    const atReplan = ledgerOf(store);
    rawDelta(store, "late-delta");
    expect(read(store, decisionsOf(store, 200), atReplan)).toBeNull();
  });

  it("a ledger read at another version than the REPLAN's", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    expect(read(store, decisionsOf(store, 200), { ...ledgerOf(store), version: 5 })).toBeNull();
  });

  it.each(["internal.integration.verifier_receipt", "internal.test.unrelated"])("a %s between the round and the REPLAN", (kind) => {
    const store = openStore(); driveRounds(store, 3); stage(store, kind, "in-gap"); decide(store, "REPLAN", "replan");
    expect(ledgerOf(store)).toMatchObject({ replanned: true, unreadable: false, version: 5 });
    expect(read(store)).toBeNull();
  });

  it.each(["review.submit", "integration.accept_output", "internal.integration.verifier_receipt"])(
    "a gap row that reads as %s", (commandKind) => {
      const store = openStore(); driveRounds(store, 3); agentReplan(store, "between-delta"); decide(store, "REPLAN", "replan");
      expect(read(store, withRow(store, nodeRows(store)[3]!.decisionId, () => ({ commandKind })))).toBeNull();
    });

  it("a second REPLAN after the first", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    rawReplan(store, { decision: "REPLAN", escalationRef: "second", unsuccessfulRounds: 3 }, "second-replan");
    expect(ledgerOf(store)).toMatchObject({ replanned: true, unreadable: false, version: 5 });
    expect(read(store)).toBeNull();
  });

  it("a second REPLAN before the answered round", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    const rows = decisionsOf(store, 200); const replan = rows.at(-1)!;
    const answered = rows.findIndex((row) => row.decisionId === ledgerOf(store).rounds.at(-1)?.decisionId);
    const earlier = [...rows.slice(0, answered), { ...replan, decisionId: "earlier-replan" }, ...rows.slice(answered)];
    expect(read(store, earlier)).toBeNull();
  });

  it.each([
    ["an extra key", { decision: "REPLAN", escalationRef: "human", extra: true, unsuccessfulRounds: 3 }],
    ["a blank escalationRef", { decision: "REPLAN", escalationRef: "  ", unsuccessfulRounds: 3 }],
    ["a non-string escalationRef", { decision: "REPLAN", escalationRef: 7, unsuccessfulRounds: 3 }],
    ["mismatched unsuccessfulRounds", { decision: "REPLAN", escalationRef: "human", unsuccessfulRounds: 2 }],
  ])("a REPLAN result with %s", (_label, result) => {
    const store = openStore(); driveRounds(store, 3); rawReplan(store, result, "raw-replan");
    expect(ledgerOf(store)).toMatchObject({ replanned: true, unreadable: false, version: 4 });
    expect(read(store)).toBeNull();
  });

  it("no REPLAN, including against a ledger that claims one", () => {
    const store = openStore(); driveRounds(store, 3);
    expect(read(store)).toBeNull();
    expect(read(store, decisionsOf(store, 200), { ...ledgerOf(store), replanned: true })).toBeNull();
  });

  it.each([
    ["accepted", (ledger: ReviewLedger) => ({ ...ledger, accepted: {} as NonNullable<ReviewLedger["accepted"]> })],
    ["unreadable", (ledger: ReviewLedger) => ({ ...ledger, unreadable: true })],
    ["not replanned", (ledger: ReviewLedger) => ({ ...ledger, replanned: false })],
    ["holding a continuation", (ledger: ReviewLedger) => ({ ...ledger, continuation: {} as NonNullable<ReviewLedger["continuation"]> })],
    ["without a round", (ledger: ReviewLedger) => ({ ...ledger, rounds: [] })],
    ["whose latest round is clean", (ledger: ReviewLedger) => ({ ...ledger, rounds: ledger.rounds.map((entry, index) =>
      index === ledger.rounds.length - 1 ? { ...entry, routing: { ...entry.routing, route: "ACCEPT" as const } } : entry) })],
  ])("a ledger %s", (_label, change) => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    expect(read(store)).not.toBeNull();
    expect(read(store, decisionsOf(store, 200), change(ledgerOf(store)))).toBeNull();
  });

  it.each([
    ["resultSha256", () => ({ resultSha256: "f".repeat(64) })],
    ["commandKind", () => ({ commandKind: "qualification.replan" })],
    ["projectId", (row: EffectsCommittedDecision) => ({ key: { ...row.key, projectId: "foreign-project" } })],
  ])("an answered round whose %s differs", (_label, change) => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    expect(read(store, withRow(store, ledgerOf(store).rounds.at(-1)!.decisionId, change))).toBeNull();
  });

  it("a latest round recorded at another version than its row's", () => {
    const store = openStore(); driveRounds(store, 3); decide(store, "REPLAN", "replan");
    const ledger = ledgerOf(store);
    const rounds = ledger.rounds.map((entry, index) => index === ledger.rounds.length - 1 ? { ...entry, aggregateVersion: 9 } : entry);
    expect(read(store, decisionsOf(store, 200), { ...ledger, rounds })).toBeNull();
  });

  it.each(["gap row", "REPLAN"])("a hole in the version chain at the %s", (at) => {
    const store = openStore(); driveRounds(store, 3); agentReplan(store, "between-delta"); decide(store, "REPLAN", "replan");
    const rows = nodeRows(store);
    const target = at === "REPLAN" ? rows[4]! : rows[3]!;
    expect(read(store, withRow(store, target.decisionId, (row) => ({ previousVersion: row.previousVersion - 1 })))).toBeNull();
  });
});
