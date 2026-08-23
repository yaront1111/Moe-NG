import { afterEach, expect, it } from "vitest";

import {
  REVIEW_INGRESS_REFUSAL_CODES,
  REVIEW_PREREQUISITE_REFUSAL_CODES,
} from "./review-contracts.js";
import type { ReviewOutcome } from "./review-ledger.js";
import { runReviewCommand } from "./review-services.js";
import {
  closeStores,
  commitRaw,
  deltaNode,
  driveEscalatedRounds,
  driveRounds,
  envelope,
  escalationPayload,
  hex64,
  openStore,
  oversizeRoundEnvelope,
  packageItems,
  replanPayload,
  seedLineageNearReadBound,
  seedVerifierReceipt,
  send,
  submit,
  submitPayload,
} from "./review-test-fixtures.js";
import { readReviewLedger } from "./review-read-model.js";
import {
  NODE_VERIFIER_PRINCIPAL_ID,
  VERIFIER_RECEIPT_COMMAND_KIND,
  verifierReceiptId,
} from "./verifier-receipt-contracts.js";

/**
 * The daemon's own refusal vocabulary, driven through the PRODUCTION entry point.
 *
 * This case exists because of a defect it would have caught: `submitRound` emitted
 * `REVIEW_ESCALATION_REQUIRED` while `REVIEW_PREREQUISITE_REFUSAL_CODES` did not list it, and
 * nothing noticed. Every individual refusal case elsewhere pins its own code, so each was green;
 * what none of them could see is a code that exists in production and in NO vocabulary. The gap
 * was invisible precisely because it lives between the cases rather than inside one.
 *
 * Two directions are asserted, and one direction alone would be vacuous:
 * - every code the surface actually emits is in the frozen vocabulary (no invented code), and
 * - every code in the frozen vocabulary is actually emitted (no dead entry that has quietly
 *   detached from the production path it claims to describe).
 *
 * The expected list is HAND-WRITTEN rather than derived from the vocabularies. Deriving it would
 * put the same array on both sides of the comparison, and a thirteenth code appended to
 * production would then appear on both sides and stay green.
 */

const encoder = new TextEncoder();

const EXPECTED_DAEMON_CODES = [
  "REVIEW_ALREADY_ACCEPTED",
  "REVIEW_COMMAND_ID_REUSED",
  "REVIEW_COMMAND_UNKNOWN",
  "REVIEW_DELTA_NODES_EMPTY",
  "REVIEW_DELTA_NODE_DUPLICATED",
  "REVIEW_ESCALATION_NOT_REACHED",
  "REVIEW_ESCALATION_REQUIRED",
  "REVIEW_EXPECTED_VERSION_STALE",
  "REVIEW_INPUT_REJECTED",
  "REVIEW_LINEAGE_UNREADABLE",
  "REVIEW_PAYLOAD_INVALID",
  "REVIEW_REPLAN_WITHOUT_ROUND",
  "REVIEW_REQUEST_INVALID",
  "REVIEW_RESULT_TOO_LARGE",
  "REVIEW_ROUND_CEILING_REACHED",
  "REVIEW_VERIFIER_RECEIPT_INVALID",
  "REVIEW_VERIFIER_RECEIPT_NOT_FOUND",
  "REVIEW_VERIFIER_RECEIPT_STALE",
] as const;

afterEach(closeStores);

/** Fails loudly on a case that stopped refusing, rather than quietly contributing nothing. */
function daemonCode(label: string, outcome: ReviewOutcome): string {
  if (outcome.ok) throw new Error(`${label}: expected a refusal, got an accepted decision`);
  if (outcome.refusedBy !== "DAEMON_INGRESS" && outcome.refusedBy !== "DAEMON_PREREQUISITE") {
    throw new Error(`${label}: expected a daemon layer, got ${outcome.refusedBy}`);
  }
  return outcome.code;
}

/** One store per case: a shared store would let an earlier refusal's state decide a later one. */
function driveDaemonRefusals(): readonly string[] {
  const staleStore = openStore();
  expect(submit(staleStore, 1).ok).toBe(true);
  const reuseStore = openStore();
  expect(submit(reuseStore, 1).ok).toBe(true);
  const cappedStore = openStore();
  driveRounds(cappedStore, 3);
  const corruptStore = openStore();
  expect(commitRaw(corruptStore, envelope("review.submit", 0, submitPayload(1), "cmd-staged"), {
    lineage: "not-a-lineage",
    reviewInputDigest: hex64("a1"),
    round: 1,
    routing: { layer: "FINDINGS", reasonCodes: [], repeatFingerprints: [], route: "ACCEPT" },
  }).ok).toBe(true);
  const oversizeStore = openStore();
  seedLineageNearReadBound(oversizeStore);
  const ceilingStore = openStore();
  driveEscalatedRounds(ceilingStore, 24);
  const missingReceiptStore = openStore();
  expect(send(missingReceiptStore, envelope(
    "review.submit", 0, submitPayload(1, []), "cmd-missing-receipt-source",
  )).ok).toBe(true);
  const acceptedStore = openStore();
  const acceptedReceipt = seedVerifierReceipt(acceptedStore);
  expect(send(acceptedStore, envelope(
    "integration.accept_output",
    acceptedReceipt.currentVersion,
    { receiptId: acceptedReceipt.receiptId, subjectRef: "node-run-1" },
    "cmd-accepted-first",
  )).ok).toBe(true);
  const staleReceiptStore = openStore();
  const staleReceipt = seedVerifierReceipt(staleReceiptStore);
  expect(send(staleReceiptStore, envelope(
    "review.submit",
    staleReceipt.currentVersion,
    submitPayload(2, []),
    "cmd-newer-clean-round",
  )).ok).toBe(true);
  const invalidReceiptStore = openStore();
  expect(send(invalidReceiptStore, envelope(
    "review.submit", 0, submitPayload(1, []), "cmd-invalid-receipt-source",
  )).ok).toBe(true);
  const invalidSource = readReviewLedger(
    invalidReceiptStore, "project-review-1", "node-run-1",
  ).rounds[0];
  if (invalidSource === undefined) throw new Error("invalid receipt setup has no source");
  const invalidReceiptId = verifierReceiptId(
    "project-review-1", "node-run-1", invalidSource.decisionId,
  );
  invalidReceiptStore.commitExpectedVersionDecision({
    commandKind: VERIFIER_RECEIPT_COMMAND_KIND,
    committedResultBytes: encoder.encode("{}"),
    correlationId: "invalid-receipt",
    decidedAt: "2026-08-16T00:00:00.000Z",
    events: [{
      eventId: `${invalidReceiptId}-bad`,
      eventType: "VerifierReceiptRecorded",
      payload: encoder.encode("{}"),
    }],
    expectedVersion: 1,
    key: {
      commandId: invalidReceiptId,
      principalId: NODE_VERIFIER_PRINCIPAL_ID,
      projectId: "project-review-1",
    },
    requestBytes: encoder.encode("{}"),
    targetAggregateId: "node-run-1",
  });

  return [
    daemonCode("undecodable bytes", runReviewCommand(openStore(), encoder.encode("{not json"))),
    daemonCode("wrong schema version", send(openStore(), {
      ...envelope("review.submit", 0, submitPayload(1)),
      schemaVersion: "other/1",
    })),
    daemonCode("kind outside this surface", send(openStore(), envelope("goal.close", 0, {
      subjectRef: "node-run-1",
    }))),
    daemonCode("payload with no findings", send(openStore(), envelope("review.submit", 0, {
      packageItems: packageItems(),
      round: 1,
      subjectRef: "node-run-1",
    }))),
    daemonCode("replan naming no nodes", send(openStore(), envelope(
      "qualification.replan", 0, replanPayload([]),
    ))),
    daemonCode("replan naming one node twice", send(openStore(), envelope(
      "qualification.replan", 0, replanPayload([deltaNode("node-1"), deltaNode("node-1")]),
    ))),
    daemonCode("replan with no round to succeed", send(openStore(), envelope(
      "qualification.replan", 0, replanPayload([deltaNode("node-1")]),
    ))),
    daemonCode("escalation below the limit", send(openStore(), envelope(
      "escalation.decide", 0, escalationPayload(),
    ))),
    daemonCode("stale expected version", send(staleStore, envelope(
      "review.submit", 99, submitPayload(2), "cmd-stale-version",
    ))),
    daemonCode("commandId reused under another kind", send(reuseStore, envelope(
      "escalation.decide", 1, escalationPayload(), "cmd-round-1",
    ))),
    daemonCode("fourth round with no recorded escalation", send(cappedStore, envelope(
      "review.submit", 3, submitPayload(4), "cmd-fourth-round",
    ))),
    daemonCode("stored round that does not parse", send(corruptStore, envelope(
      "review.submit", 1, submitPayload(2), "cmd-after-corrupt",
    ))),
    daemonCode(
      "round whose stored result would exceed the read bound",
      send(oversizeStore, oversizeRoundEnvelope()),
    ),
    daemonCode("round past the absolute ceiling", send(ceilingStore, envelope(
      "review.submit", 25, submitPayload(25), "cmd-round-past-ceiling",
    ))),
    daemonCode("accepting a second time", send(acceptedStore, envelope(
      "integration.accept_output",
      3,
      { receiptId: acceptedReceipt.receiptId, subjectRef: "node-run-1" },
      "cmd-accepted-second",
    ))),
    daemonCode("missing verifier receipt", send(missingReceiptStore, envelope(
      "integration.accept_output",
      1,
      { receiptId: "f".repeat(64), subjectRef: "node-run-1" },
      "cmd-missing-receipt",
    ))),
    daemonCode("stale verifier receipt", send(staleReceiptStore, envelope(
      "integration.accept_output",
      3,
      { receiptId: staleReceipt.receiptId, subjectRef: "node-run-1" },
      "cmd-stale-receipt",
    ))),
    daemonCode("malformed verifier receipt", send(invalidReceiptStore, envelope(
      "integration.accept_output",
      2,
      { receiptId: invalidReceiptId, subjectRef: "node-run-1" },
      "cmd-invalid-receipt",
    ))),
  ];
}

it("emits exactly the daemon refusal codes its frozen vocabularies declare", () => {
  const emitted = driveDaemonRefusals();

  // A sweep that produced nothing would satisfy a subset assertion while testing nothing.
  expect(emitted.length).toBe(EXPECTED_DAEMON_CODES.length);
  expect(emitted.length).toBeGreaterThan(0);
  expect(new Set(emitted)).toEqual(new Set(EXPECTED_DAEMON_CODES));
});

it("declares every emitted code in a frozen vocabulary and declares no dead one", () => {
  const declared = [...REVIEW_INGRESS_REFUSAL_CODES, ...REVIEW_PREREQUISITE_REFUSAL_CODES];

  expect(new Set(declared)).toEqual(new Set(EXPECTED_DAEMON_CODES));
  expect(declared).toHaveLength(EXPECTED_DAEMON_CODES.length);
});
