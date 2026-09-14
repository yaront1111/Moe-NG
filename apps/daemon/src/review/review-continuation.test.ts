import { afterEach, expect, it } from "vitest";
import { buildReviewPackage, recordReviewRound } from "@moe/review";
import { readReviewLedger } from "./review-read-model.js";
import { readReviewLedgers } from "./review-read-model.js";
import { PROJECT_ID, SUBJECT_REF, closeStores, commitRaw, driveRounds, envelope, escalationPayload,
  finding, openRestartableStore, openStore, packageItems, reopen, seedVerifierReceipt, send, submitPayload } from "./review-test-fixtures.js";

afterEach(closeStores);
function allow(store: ReturnType<typeof openStore>, id = "allow-1") {
  const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  return send(store, envelope("escalation.decide", ledger.version, escalationPayload(), id));
}
function next(store: ReturnType<typeof openStore>, clean = false) {
  const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  return send(store, envelope("review.submit", ledger.version, submitPayload(ledger.version + 1,
    clean ? [] : [finding({ ruleId: `missing-${ledger.version}` })]), `round-${ledger.version + 1}`));
}

it("spends one human decision, survives restart and requires another decision for another failed round", () => {
  const disk = openRestartableStore();
  driveRounds(disk.store, 3);
  expect(allow(disk.store).ok).toBe(true);
  const store = reopen(disk);
  expect(allow(store, "duplicate-allow")).toMatchObject({ ok: false, code: "REVIEW_CONTINUATION_ALREADY_AVAILABLE" });
  expect(next(store).ok).toBe(true);
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1)?.routing.route).toBe("ESCALATE");
  expect(next(store)).toMatchObject({ ok: false, code: "REVIEW_ESCALATION_REQUIRED" });
  expect(allow(store, "allow-2").ok).toBe(true);
  expect(next(store).ok).toBe(true);
  expect(next(store)).toMatchObject({ ok: false, code: "REVIEW_ESCALATION_REQUIRED" });
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).lineage.unsuccessfulRounds).toBe(5);
});

it("accepts the approved clean attempt only through a real independent verifier receipt", () => {
  const store = openStore(); driveRounds(store, 3);
  expect(allow(store).ok).toBe(true);
  expect(next(store, true).ok).toBe(true);
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF)).toMatchObject({ accepted: undefined,
    lineage: { unsuccessfulRounds: 3 }, rounds: expect.arrayContaining([expect.objectContaining({ routing: expect.objectContaining({ route: "ACCEPT" }) })]) });
  const receipt = seedVerifierReceipt(store);
  const accepted = send(store, envelope("integration.accept_output", receipt.currentVersion,
    { receiptId: receipt.receiptId, subjectRef: SUBJECT_REF }, "accept"));
  expect(accepted).toMatchObject({ ok: true });
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).accepted?.verifierReceiptId).toBe(receipt.receiptId);
});

it("does not turn a historical unbound approval into fresh continuation authority", () => {
  const store = openStore(); driveRounds(store, 3);
  expect(commitRaw(store, envelope("escalation.decide", 3, escalationPayload()), {
    decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "legacy", unsuccessfulRounds: 3,
  }, "ReviewEscalated").ok).toBe(true);
  expect(next(store)).toMatchObject({ ok: false, code: "REVIEW_ESCALATION_REQUIRED" });
  expect(allow(store, "new-allow").ok).toBe(true);
  expect(next(store).ok).toBe(true);
});

it.each(["continuation", "allowMoreAttempts", "verifierFailureSource"])("rejects caller-supplied %s without committing a round", (field) => {
  const store = openStore(); driveRounds(store, 3);
  expect(send(store, envelope("review.submit", 3, { ...submitPayload(4, []),
    [field]: { funded: true } }))).toMatchObject({ ok: false, code: "REVIEW_PAYLOAD_INVALID" });
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version).toBe(3);
});

it.each(["decisionId", "decisionResultSha256", "decisionVersion", "projectId", "subjectRef"])(
  "rejects a stored consumed permit whose %s differs from the real human decision", (field) => {
    const store = openStore(); driveRounds(store, 3); expect(allow(store).ok).toBe(true);
    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    const use = { projectId: PROJECT_ID, subjectRef: SUBJECT_REF, round: 5, approval: ledger.continuation! };
    const clean = recordReviewRound(ledger.lineage, { round: 5, findings: [] }, use);
    const built = buildReviewPackage(packageItems());
    if (!clean.ok || !built.ok) throw new Error("real prior approval and package must admit the clean round");
    const corrupt = { ...use, approval: { ...use.approval, [field]: field === "decisionVersion" ? 99 : "foreign" } };
    expect(commitRaw(store, envelope("review.submit", 4, submitPayload(5, [])), {
      ...clean.value, round: 5, packageItems: packageItems(), reviewInputDigest: built.value.reviewInputDigest,
      continuation: corrupt,
    }).ok).toBe(true);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF)).toMatchObject({ unreadable: true, accepted: undefined });
    expect(next(store)).toMatchObject({ ok: false, code: "REVIEW_LINEAGE_UNREADABLE" });
  });

it.each(["projectId", "subjectRef", "reviewVersion", "sourceDecisionId", "sourceResultSha256",
  "sourceAggregateVersion", "sourceLineageDigest", "sourceRound", "sourceReviewInputDigest", "unsuccessfulRounds", "extra"])(
  "withholds authority when persisted approval has a corrupt %s binding", (field) => {
    const store = openStore(); driveRounds(store, 3);
    const source = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1)!;
    const sourceBinding: Record<string, unknown> = { projectId: PROJECT_ID, subjectRef: SUBJECT_REF,
      reviewVersion: 3, sourceDecisionId: source.decisionId, sourceResultSha256: source.resultSha256,
      sourceAggregateVersion: source.aggregateVersion, sourceLineageDigest: source.lineage.digest,
      sourceRound: source.round, sourceReviewInputDigest: source.reviewInputDigest,
      unsuccessfulRounds: source.lineage.unsuccessfulRounds };
    sourceBinding[field] = typeof sourceBinding[field] === "number" ? 99 : "foreign-binding";
    expect(commitRaw(store, envelope("escalation.decide", 3, escalationPayload()), {
      decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "human", unsuccessfulRounds: 3,
      continuationSource: sourceBinding,
    }, "ReviewEscalated").ok).toBe(true);
    for (const ledger of [readReviewLedger(store, PROJECT_ID, SUBJECT_REF),
      readReviewLedgers(store, PROJECT_ID, new Set([SUBJECT_REF])).ledgers.get(SUBJECT_REF)!]) {
      expect(ledger).toMatchObject({ unreadable: true, accepted: undefined });
      expect(ledger.continuation).toBeUndefined();
    }
    expect(next(store, true)).toMatchObject({ ok: false, code: "REVIEW_LINEAGE_UNREADABLE" });
  });

it("allows a human to replace an unused continuation with REPLAN and never revives it", () => {
  const store = openStore(); driveRounds(store, 3); expect(allow(store).ok).toBe(true);
  expect(send(store, envelope("escalation.decide", 4, escalationPayload({ decision: "REPLAN" }), "replan")).ok).toBe(true);
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).continuation).toBeUndefined();
  expect(allow(store, "revive")).toMatchObject({ ok: false, code: "REVIEW_NODE_REPLANNED" });
  expect(next(store)).toMatchObject({ ok: false, code: "REVIEW_NODE_REPLANNED" });
});
