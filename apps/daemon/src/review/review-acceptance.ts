import type { JsonValue } from "@moe/contracts";
import { REVIEW_ESCALATION_ROUND_LIMIT, buildReviewPackage, qualifyReviewAcceptance } from "@moe/review";
import type { ReviewPackageItemInput } from "@moe/review";

import { commitAccepted, payloadArray, payloadObject, payloadRef, refuse, refuseFromKernel } from "./review-ledger.js";
import type { CommandHandler, ReviewOutcome } from "./review-ledger.js";

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

/** A package item list is required for acceptance: it is what binds the evidence being accepted. */
function acceptanceItems(values: readonly JsonValue[]): readonly ReviewPackageItemInput[] | undefined {
  const parsed: ReviewPackageItemInput[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, JsonValue>;
    const digest = item["digest"];
    const kind = item["kind"];
    const locator = item["locator"];
    if (typeof digest !== "string" || typeof kind !== "string" || typeof locator !== "string") {
      return undefined;
    }
    parsed.push({ digest, kind, locator });
  }
  return parsed;
}

/**
 * Records the explicit escalation decision. It refuses BELOW the limit rather than recording a
 * no-op, so an escalation in the durable log always means the blocker was genuinely reached.
 */
export const decideEscalation: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const escalationRef = payloadRef(request.payload, "escalationRef");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  if (escalationRef === null || subjectRef === null) {
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
    eventPayload: { escalationRef, unsuccessfulRounds: ledger.lineage.unsuccessfulRounds },
    eventType: "ReviewEscalated",
    expectedVersion: ledger.version,
    result: {
      escalationRef,
      unsuccessfulRounds: ledger.lineage.unsuccessfulRounds,
    } as unknown as JsonValue,
  });
};

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
  const calibration = payloadObject(request.payload, "calibration");
  const itemValues = payloadArray(request.payload, "packageItems");
  const policy = payloadObject(request.payload, "policy");
  const proof = payloadRef(request.payload, "proof");
  const reviewer = payloadObject(request.payload, "reviewer");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  if (calibration === null || itemValues === null || policy === null || proof === null
    || reviewer === null || subjectRef === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const items = acceptanceItems(itemValues);
  if (items === undefined) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const built = buildReviewPackage(items);
  if (!built.ok) return refuseFromKernel(request.kind, built.code, built.layer);
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const qualified = qualifyReviewAcceptance({
    calibration: calibration as never,
    lineage: ledger.lineage,
    policy: policy as never,
    proof: proof as never,
    reviewInputDigest: built.value.reviewInputDigest,
    reviewer: reviewer as never,
  });
  if (!qualified.ok) return refuseFromKernel(request.kind, qualified.code, qualified.layer);
  return commitAccepted(store, request, {
    aggregateId: subjectRef,
    eventPayload: {
      reviewInputDigest: built.value.reviewInputDigest,
      subjectRef,
    },
    eventType: "ReviewOutputAccepted",
    expectedVersion: ledger.version,
    result: qualified.value as unknown as JsonValue,
  });
};
