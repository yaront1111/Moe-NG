import type { JsonValue } from "@moe/contracts";
import { REVIEW_ESCALATION_ROUND_LIMIT, qualifyReviewAcceptance } from "@moe/review";
import type { ReviewerIndependenceInput } from "@moe/review";

import { commitAccepted, payloadRef, refuse, refuseFromKernel } from "./review-ledger.js";
import type { CommandHandler, ReviewOutcome } from "./review-ledger.js";
import { NODE_VERIFIER_PRINCIPAL_ID, readVerifierReceipt } from "./verifier-receipt-ledger.js";

/**
 * Explicit escalation (DoD 4) and the acceptance gate (DoD 6).
 *
 * Neither handler decides a review outcome. The escalation THRESHOLD is
 * `REVIEW_ESCALATION_ROUND_LIMIT`, read from `@moe/review` rather than copied — a local
 * `MAX_ROUNDS = 3` would drift the day the kernel changed it, and both sides would stay
 * internally consistent while disagreeing with each other. The acceptance VERDICT is
 * `qualifyReviewAcceptance`'s, consumed whole, with its code and its layer surfaced unchanged.
 *
 * What the daemon does own is the durable consequence: design 15.2 says three unsuccessful
 * rounds create a REVIEW_ESCALATION blocker, and a blocker blocks. The kernel is stateless about
 * what happens next, so enforcing "no further round without a recorded escalation" is the
 * composition's job and refuses under the daemon's own layer.
 */

function reviewerFor(subjectRef: string, authors: readonly string[]): ReviewerIndependenceInput {
  return {
    authors,
    authorshipResolved: true,
    leaseHistory: [],
    leaseHistoryResolved: true,
    reviewer: NODE_VERIFIER_PRINCIPAL_ID,
    subjectRef,
  };
}

/**
 * Records the explicit escalation decision. It refuses BELOW the limit rather than recording a
 * no-op, so an escalation in the durable log always means the blocker was genuinely reached.
 */
export const decideEscalation: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const escalationRef = payloadRef(request.payload, "escalationRef");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  const decision = escalationDecisionOf(request.payload);
  if (escalationRef === null || subjectRef === null || decision === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (ledger.lineage.unsuccessfulRounds < REVIEW_ESCALATION_ROUND_LIMIT) {
    return refuse(request.kind, "REVIEW_ESCALATION_NOT_REACHED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  return commitAccepted(store, request, {
    aggregateId: subjectRef,
    eventPayload: { decision, escalationRef, unsuccessfulRounds: ledger.lineage.unsuccessfulRounds },
    eventType: "ReviewEscalated",
    expectedVersion: ledger.version,
    result: {
      decision,
      escalationRef,
      unsuccessfulRounds: ledger.lineage.unsuccessfulRounds,
    } as unknown as JsonValue,
  });
};

/**
 * The human's two answers to an exhausted review. ALLOW_MORE_ATTEMPTS admits the fix round the
 * kernel refuses without a decision; REPLAN closes the node to rounds for good: the work is
 * re-planned (a successor goal carrying the findings), never re-tried under the same node.
 */
export const ESCALATION_DECISIONS = Object.freeze(["ALLOW_MORE_ATTEMPTS", "REPLAN"] as const);
export type EscalationDecision = (typeof ESCALATION_DECISIONS)[number];

function escalationDecisionOf(payload: unknown): EscalationDecision | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>)["decision"];
  return (ESCALATION_DECISIONS as readonly string[]).includes(String(raw))
    ? raw as EscalationDecision : null;
}

/**
 * Accepts the reviewed output, if `@moe/review` qualifies it.
 *
 * The qualification runs against the lineage READ FROM THE STORE, never one supplied by the
 * caller, so a caller cannot present an empty history to duck the round cap. Nothing is
 * committed unless the kernel returns `ok`, which is what makes "the attempt commits NOTHING"
 * a property of this function rather than a claim about its return value.
 */
export const acceptOutput: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const payloadKeys = Object.keys(request.payload);
  const receiptId = payloadRef(request.payload, "receiptId");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  if (payloadKeys.length !== 2 || !payloadKeys.includes("receiptId")
    || !payloadKeys.includes("subjectRef") || receiptId === null || subjectRef === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (ledger.accepted !== undefined) {
    return refuse(request.kind, "REVIEW_ALREADY_ACCEPTED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const loaded = readVerifierReceipt(store, request.projectId, receiptId);
  if (!loaded.ok) {
    return refuse(
      request.kind,
      loaded.code === "VERIFIER_RECEIPT_NOT_FOUND"
        ? "REVIEW_VERIFIER_RECEIPT_NOT_FOUND"
        : "REVIEW_VERIFIER_RECEIPT_INVALID",
      "DAEMON_PREREQUISITE",
    );
  }
  const latest = ledger.rounds[ledger.rounds.length - 1];
  const authors = [...new Set(ledger.rounds.map((round) => round.principalId))].sort();
  if (loaded.receipt.subjectRef !== subjectRef || loaded.receipt.projectId !== request.projectId
    || loaded.decision.currentVersion !== ledger.version || latest === undefined
    || latest.routing.route !== "ACCEPT"
    || loaded.receipt.source.aggregateVersion !== latest.aggregateVersion
    || loaded.receipt.source.decisionId !== latest.decisionId
    || loaded.receipt.source.resultSha256 !== latest.resultSha256
    || loaded.receipt.source.authors.length !== authors.length
    || loaded.receipt.source.authors.some((author, index) => author !== authors[index])) {
    return refuse(request.kind, "REVIEW_VERIFIER_RECEIPT_STALE", "DAEMON_PREREQUISITE");
  }
  const qualified = qualifyReviewAcceptance({
    calibration: loaded.receipt.calibration,
    lineage: ledger.lineage,
    policy: loaded.receipt.policy,
    proof: loaded.receipt.proof,
    reviewInputDigest: loaded.receipt.reviewInputDigest,
    reviewer: reviewerFor(subjectRef, authors),
  });
  if (!qualified.ok) return refuseFromKernel(request.kind, qualified.code, qualified.layer);
  return commitAccepted(store, request, {
    aggregateId: subjectRef,
    eventPayload: {
      reviewInputDigest: loaded.receipt.reviewInputDigest,
      subjectRef,
      verifierReceiptId: receiptId,
      verifierReceiptSha256: loaded.receiptSha256,
    },
    eventType: "ReviewOutputAccepted",
    expectedVersion: ledger.version,
    result: {
      ...qualified.value,
      verifierReceiptId: receiptId,
      verifierReceiptSha256: loaded.receiptSha256,
    } as unknown as JsonValue,
  });
};
