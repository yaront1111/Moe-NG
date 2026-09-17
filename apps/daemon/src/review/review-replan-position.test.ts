import { afterEach, describe, expect, it } from "vitest";
import type { CommandDecisionRecord, EffectsCommittedDecision } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readReviewLedger } from "./review-read-model.js";
import type { ReviewLedger } from "./review-read-model.js";
import { replanSupersedesLatestRound } from "./review-replan-position.js";
import { recordVerifierReceipt } from "./verifier-receipt-ledger.js";
import {
  PROJECT_ID, SUBJECT_REF, calibration, closeStores, deltaNode, driveRounds, envelope, finding, hex64,
  openStore, packageItems, policyInput, replanPayload, seedVerifierReceipt, send, submitPayload,
} from "./review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./verifier-receipt-contracts.js";

/**
 * WHERE a re-plan sits, not whether one exists. `ledger.delta` is never cleared by the fold, so
 * the closure composer (goals/goal-qualification.ts) reads this instead of the flag.
 *
 * Every store below is written through the production review pipeline. A shape no command can
 * build is proved unreachable by the refusal that stops it, and the fail-closed arms tamper with
 * a COPY of the read decisions — this module is pure, so its input is the seam, never the store.
 */

afterEach(closeStores);
type Store = ReturnType<typeof openStore>;

const ledgerOf = (store: Store): ReviewLedger => readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
const read = (store: Store, decisions: readonly CommandDecisionRecord[] = decisionsOf(store, 200),
  ledger = ledgerOf(store)) => replanSupersedesLatestRound(decisions, PROJECT_ID, SUBJECT_REF, ledger);

function ok(outcome: ReturnType<typeof send>): void {
  if (!outcome.ok) throw new Error(`setup refused: ${outcome.code}`);
}
function agentReplan(store: Store, id: string): void {
  ok(send(store, envelope("qualification.replan", ledgerOf(store).version, replanPayload([deltaNode("node-1")]), id)));
}
function round(store: Store, number: number, clean = false): void {
  ok(send(store, envelope("review.submit", ledgerOf(store).version,
    submitPayload(number, clean ? [] : [finding({ ruleId: `rule-${String(number)}` })]), `cmd-round-${String(number)}`)));
}
/** The receipt over the latest clean round, then the acceptance that names it. */
function accept(store: Store): void {
  const receipt = seedVerifierReceipt(store);
  ok(send(store, envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: SUBJECT_REF }, "cmd-accept")));
}
/** A copy of the read decisions with one row replaced; the store itself is never touched. */
function withRow(store: Store, decisionId: string, change: (row: EffectsCommittedDecision) => object): CommandDecisionRecord[] {
  const rows = decisionsOf(store, 200);
  expect(rows.some((row) => row.decisionId === decisionId)).toBe(true);
  return rows.map((row) => row.decisionId === decisionId
    ? { ...row, ...change(row as EffectsCommittedDecision) } as unknown as CommandDecisionRecord : row);
}

describe("a re-plan the node answered with later rounds supersedes nothing", () => {
  it("with no re-plan recorded at all", () => {
    const store = openStore(); driveRounds(store, 1); round(store, 2, true); accept(store);
    expect(ledgerOf(store)).toMatchObject({ delta: undefined, unreadable: false });
    expect(read(store)).toBe(false);
  });

  it("when the re-plan precedes the round the acceptance attests", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store);
    const ledger = ledgerOf(store);
    expect(ledger.delta).toBeDefined();
    expect(ledger.accepted?.verifierReceiptId).toBeDefined();
    expect(read(store)).toBe(false);
  });

  it("when two later rounds answered it", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2); round(store, 3, true); accept(store);
    expect(ledgerOf(store).rounds).toHaveLength(3);
    expect(read(store)).toBe(false);
  });
});

describe("a re-plan the node has NOT answered supersedes the accepted package", () => {
  it("when it follows the acceptance", () => {
    const store = openStore(); driveRounds(store, 1); round(store, 2, true); accept(store);
    agentReplan(store, "late-delta");
    // Past acceptance a re-plan is a successor again, so this is the ordinary reachable shape.
    expect(ledgerOf(store)).toMatchObject({ unreadable: false });
    expect(read(store)).toBe(true);
  });

  it("when one re-plan precedes the accepted round and another follows the acceptance", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store); agentReplan(store, "late-delta");
    expect(read(store)).toBe(true);
  });

  /**
   * BETWEEN the attested round and its acceptance is UNREACHABLE, and the receipt path is what
   * refuses it: `recordVerifierReceipt` records only at V+1 of the round it attests, and a delta
   * commit takes that version slot. There is no other order — mint the receipt first and the
   * acceptance's own `loaded.decision.currentVersion !== ledger.version` fence refuses instead.
   */
  it("is a state no command can build between the accepted round and its acceptance", () => {
    const store = openStore(); driveRounds(store, 1); round(store, 2, true);
    const source = ledgerOf(store).rounds.at(-1)!;
    agentReplan(store, "delta-over-clean-round");

    const receipt = recordVerifierReceipt(store, {
      authority: { calibration: calibration(), packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
        policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }) },
      decidedAt: "2026-08-16T00:00:00.000Z",
      execution: { byteCount: 2, outputSha256: hex64("aa"), test: "pnpm test", workspace: "/fixture-workspace" },
      projectId: PROJECT_ID,
      source: { aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256 },
      subjectRef: SUBJECT_REF,
    });

    expect(receipt).toMatchObject({ code: "VERIFIER_RECEIPT_STALE", ok: false });
    expect(ledgerOf(store).accepted).toBeUndefined();
  });

  it("is refused from the other side too, when the receipt is minted before the re-plan", () => {
    const store = openStore(); driveRounds(store, 1); round(store, 2, true);
    const receipt = seedVerifierReceipt(store);
    agentReplan(store, "delta-over-receipt");

    const accepted = send(store, envelope("integration.accept_output", receipt.currentVersion,
      { receiptId: receipt.receiptId, subjectRef: SUBJECT_REF }, "cmd-accept"));

    expect(accepted).toMatchObject({ ok: false, code: "REVIEW_EXPECTED_VERSION_STALE" });
    const current = send(store, envelope("integration.accept_output", ledgerOf(store).version,
      { receiptId: receipt.receiptId, subjectRef: SUBJECT_REF }, "cmd-accept-current"));
    expect(current).toMatchObject({ ok: false, code: "REVIEW_VERIFIER_RECEIPT_STALE" });
  });
});

describe("a re-plan whose position cannot be read fails closed", () => {
  it("when the ledger carries a delta but no round to place it against", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    // No command builds this: `classifyReplanDelta` refuses REVIEW_REPLAN_WITHOUT_ROUND first.
    expect(send(store, envelope("qualification.replan", 0, replanPayload([deltaNode("node-1")]), "cmd-no-round")))
      .toMatchObject({ ok: false });
    expect(read(store, decisionsOf(store, 200), { ...ledgerOf(store), rounds: [] })).toBe(true);
  });

  it("when the delta the ledger proves is missing from the decisions read", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store);

    const without = decisionsOf(store, 200)
      .filter((row) => row.commandKind !== "qualification.replan");

    // The ledger still carries the delta, so a view that holds no re-plan row cannot place it.
    expect(read(store, without)).toBe(true);
  });

  it("when the latest round's own decision row is not in the decisions read", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store);
    const latest = ledgerOf(store).rounds.at(-1)!;

    const without = decisionsOf(store, 200).filter((row) => row.decisionId !== latest.decisionId);

    expect(read(store, without)).toBe(true);
  });

  it("when the row at the latest round's decision id does not carry that round's bytes", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store);
    const latest = ledgerOf(store).rounds.at(-1)!;

    expect(read(store, withRow(store, latest.decisionId, () => ({ resultSha256: hex64("ff") })))).toBe(true);
    expect(read(store, withRow(store, latest.decisionId, (row) => ({ currentVersion: row.currentVersion + 1 })))).toBe(true);
    expect(read(store, withRow(store, latest.decisionId, () => ({ commandKind: "qualification.replan" })))).toBe(true);
  });

  it("when the round row belongs to another project or another node", () => {
    const store = openStore(); driveRounds(store, 1); agentReplan(store, "early-delta");
    round(store, 2, true); accept(store);
    const rows = decisionsOf(store, 200);

    expect(replanSupersedesLatestRound(rows, "project-other", SUBJECT_REF, ledgerOf(store))).toBe(true);
    expect(replanSupersedesLatestRound(rows, PROJECT_ID, "node-other", ledgerOf(store))).toBe(true);
  });
});
