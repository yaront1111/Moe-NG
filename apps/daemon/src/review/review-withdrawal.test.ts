import { buildReviewPackage, recordReviewRound } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readReviewLedger, readReviewLedgers } from "./review-read-model.js";
import type { ReviewLedger } from "./review-read-model.js";
import { runReviewCommand } from "./review-services.js";
import {
  PROJECT_ID, SUBJECT_REF, closeStores, commitRaw, driveRounds, envelope, escalationPayload, finding, openStore,
  packageItems, seedVerifierReceipt, send, submitPayload,
} from "./review-test-fixtures.js";

/**
 * The withdrawal seam (UnAI 2026-09-19): accepted work that then failed to DELIVER left its node
 * accepted forever. One host-recorded failed round naming the accepted receipt takes the
 * acceptance back; the wire can never carry it, and any other shape fails closed.
 *
 * Every store below is written through the production review pipeline, except the two tampered
 * rounds no handler will write, which go through `commitRaw`.
 */

afterEach(closeStores);
type Store = ReturnType<typeof openStore>;

const ledgerOf = (store: Store): ReviewLedger => readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
const withdrawalFinding = () => finding({ ruleId: "delivery-withdrawn" });

/** The receipt over a clean round, then the acceptance that names it. Returns the receipt id. */
function accept(store: Store, commandId = "cmd-accept"): string {
  const receipt = seedVerifierReceipt(store);
  const accepted = send(store, envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: SUBJECT_REF }, commandId));
  if (!accepted.ok) throw new Error(`acceptance setup refused: ${accepted.code}`);
  return receipt.receiptId;
}

/** The host seam exactly as `recordNodeVerifierFailure` drives it; `withdraws` absent = a plain failure. */
function hostFailure(store: Store, withdraws?: string): ReturnType<typeof send> {
  const ledger = ledgerOf(store);
  const latest = ledger.rounds.at(-1)!;
  const request = envelope("review.submit", ledger.version,
    submitPayload(latest.round + 1, [withdrawalFinding()]), `delivery-withdrawn-${latest.decisionId}`);
  return runReviewCommand(store, new TextEncoder().encode(JSON.stringify(request)), undefined, undefined, {
    aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256,
    ...(withdraws === undefined ? {} : { withdraws }),
  });
}

function land(store: Store, verifierReceiptId: string, sha: string): void {
  expect(recordLandingReceipt(store, {
    commit: { branch: "moe/node-run-1", files: ["product.ts"], message: "Land product", parentSha: "b".repeat(40), sha },
    decidedAt: "2026-09-19T10:00:00.000Z", projectId: PROJECT_ID, refusal: null, subjectRef: SUBJECT_REF,
    verifierReceiptId, workspace: "/fixture-workspace",
  })).toMatchObject({ ok: true, replayed: false });
}

describe("an accepted ledger still refuses every round but the withdrawal", () => {
  it("on the wire path", () => {
    const store = openStore(); driveRounds(store, 1); accept(store);
    const before = ledgerOf(store);

    expect(send(store, envelope("review.submit", before.version, submitPayload(3))))
      .toMatchObject({ ok: false, code: "REVIEW_ALREADY_ACCEPTED" });
    expect(ledgerOf(store).version).toBe(before.version);
  });

  it("from a host source that withdraws nothing", () => {
    const store = openStore(); driveRounds(store, 1); accept(store);

    expect(hostFailure(store)).toMatchObject({ ok: false, code: "REVIEW_ALREADY_ACCEPTED" });
    expect(ledgerOf(store).accepted).toBeDefined();
  });

  it("from a host source whose withdrawal names another receipt", () => {
    const store = openStore(); driveRounds(store, 1); accept(store);

    expect(hostFailure(store, "verifier-receipt-of-another-node"))
      .toMatchObject({ ok: false, code: "REVIEW_ALREADY_ACCEPTED" });
    expect(ledgerOf(store).accepted).toBeDefined();
  });

  it("and a wire payload cannot carry the withdrawal key", () => {
    const store = openStore(); driveRounds(store, 1); const receiptId = accept(store);
    const before = ledgerOf(store);

    expect(send(store, envelope("review.submit", before.version,
      { ...submitPayload(3), withdrawsAcceptance: receiptId })))
      .toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_INVALID", refusedBy: "DAEMON_INGRESS" });
    expect(ledgerOf(store)).toMatchObject({ accepted: before.accepted, version: before.version });
  });
});

describe("a host source naming the accepted receipt withdraws the acceptance", () => {
  it("commits one failed round at the current version and un-accepts the node", () => {
    const store = openStore(); driveRounds(store, 1); const receiptId = accept(store);
    const before = ledgerOf(store);
    // The receipt and the acceptance each moved the aggregate past the round they attest.
    expect(before.version).toBe(before.rounds.at(-1)!.aggregateVersion + 2);

    const sent = hostFailure(store, receiptId);

    if (!sent.ok) throw new Error(sent.code);
    expect(sent.decision.currentVersion).toBe(before.version + 1);
    expect(store.readEvents(SUBJECT_REF).at(-1)?.eventType).toBe("ReviewRoundRecorded");
    const result = JSON.parse(new TextDecoder().decode(sent.decision.resultBytes)) as Record<string, unknown>;
    expect(result["withdrawsAcceptance"]).toBe(receiptId);
    const source = before.rounds.at(-1)!;
    // Exactly the 3-key triple: `withdraws` never reaches the stored source.
    expect(result["verifierFailureSource"]).toEqual({
      aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256,
    });

    const after = ledgerOf(store);
    expect(after).toMatchObject({ accepted: undefined, unreadable: false, version: before.version + 1 });
    expect(after.rounds).toHaveLength(before.rounds.length + 1);
    expect(after.lineage.unsuccessfulRounds).toBe(before.lineage.unsuccessfulRounds + 1);
    expect(readReviewLedgers(store, PROJECT_ID, new Set([SUBJECT_REF, "node-other"])).ledgers.get(SUBJECT_REF))
      .toEqual(after);
  });

  it("is stale on a ledger that is not accepted", () => {
    const store = openStore(); driveRounds(store, 1);
    const receipt = seedVerifierReceipt(store);

    expect(hostFailure(store, receipt.receiptId)).toMatchObject({ ok: false, code: "REVIEW_VERIFIER_RECEIPT_STALE" });
    expect(ledgerOf(store).version).toBe(receipt.currentVersion);
  });

  it("serves the SECOND acceptance and its landing after a full second cycle", () => {
    const store = openStore(); driveRounds(store, 1);
    const first = accept(store); land(store, first, "1".repeat(40));
    expect(hostFailure(store, first).ok).toBe(true);

    const second = accept(store, "cmd-accept-again"); land(store, second, "2".repeat(40));

    expect(second).not.toBe(first);
    expect(ledgerOf(store)).toMatchObject({ accepted: { verifierReceiptId: second }, unreadable: false });
    expect(readReviewLedgers(store, PROJECT_ID, new Set([SUBJECT_REF])).landings.get(SUBJECT_REF))
      .toMatchObject({ commit: { sha: "2".repeat(40) }, verifierReceiptId: second });
  });
});

describe("a stored withdrawal the fold cannot prove fails closed", () => {
  /** A real failed round over the accepted ledger, staged past the handlers with `extra` keys. */
  function stage(store: Store, extra: (source: Record<string, unknown>) => Record<string, unknown>): void {
    const ledger = ledgerOf(store);
    const latest = ledger.rounds.at(-1)!;
    const failed = recordReviewRound(ledger.lineage, { findings: [withdrawalFinding()] as never, round: latest.round + 1 });
    const built = buildReviewPackage(packageItems());
    if (!failed.ok || !built.ok) throw new Error("a real failed round and package must build");
    expect(commitRaw(store, envelope("review.submit", ledger.version, submitPayload(latest.round + 1), "cmd-staged"), {
      ...failed.value, packageItems: packageItems(), reviewInputDigest: built.value.reviewInputDigest,
      round: latest.round + 1, ...extra({
        aggregateVersion: latest.aggregateVersion, decisionId: latest.decisionId, resultSha256: latest.resultSha256,
      }),
    }).ok).toBe(true);
  }

  it("when it names another receipt id", () => {
    const store = openStore(); driveRounds(store, 1); const receiptId = accept(store);

    stage(store, (source) => ({ verifierFailureSource: source, withdrawsAcceptance: "verifier-receipt-of-another-node" }));

    expect(ledgerOf(store)).toMatchObject({ accepted: { verifierReceiptId: receiptId }, unreadable: true });
  });

  it("when it carries no failure source", () => {
    const store = openStore(); driveRounds(store, 1); const receiptId = accept(store);

    stage(store, () => ({ withdrawsAcceptance: receiptId }));

    expect(ledgerOf(store)).toMatchObject({ accepted: { verifierReceiptId: receiptId }, unreadable: true });
  });

  it("while the same round with both reads back clean (positive control)", () => {
    const store = openStore(); driveRounds(store, 1); const receiptId = accept(store);

    stage(store, (source) => ({ verifierFailureSource: source, withdrawsAcceptance: receiptId }));

    expect(ledgerOf(store)).toMatchObject({ accepted: undefined, unreadable: false });
  });
});

it("a withdrawal on a node accepted through a funded continuation escalates, and the human can fund the fix", () => {
  const store = openStore(); driveRounds(store, 3);
  const allow = (id: string) => send(store, envelope("escalation.decide", ledgerOf(store).version, escalationPayload(), id));
  expect(allow("cmd-allow-1").ok).toBe(true);
  const receiptId = accept(store);
  expect(ledgerOf(store).rounds.at(-1)).toMatchObject({ continuation: { round: 4 }, routing: { route: "ACCEPT" } });

  expect(hostFailure(store, receiptId).ok).toBe(true);

  expect(ledgerOf(store)).toMatchObject({ accepted: undefined, unreadable: false });
  expect(ledgerOf(store).rounds.at(-1)?.routing.route).toBe("ESCALATE");
  expect(allow("cmd-allow-2").ok).toBe(true);
  expect(send(store, envelope("review.submit", ledgerOf(store).version, submitPayload(6, []), "cmd-fix-round")).ok).toBe(true);
  expect(ledgerOf(store)).toMatchObject({ unreadable: false });
  expect(ledgerOf(store).rounds.at(-1)).toMatchObject({ continuation: { round: 6 }, routing: { route: "ACCEPT" } });
});
