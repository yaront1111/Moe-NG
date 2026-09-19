import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import {
  REVIEW_ROUND_ABSOLUTE_CEILING,
  buildReviewPackage,
  recordReviewRound,
} from "@moe/review";
import type { ReviewPackageItemInput } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { acceptOutput, decideEscalation } from "./review-acceptance.js";
import { decodeReviewRequestBytes } from "./review-contracts.js";
import type { ReviewRequest } from "./review-contracts.js";
import { classifyReplanDelta } from "./review-delta.js";
import { findingAttributionsValid } from "./review-finding-attribution.js";
import { reviewDecisionRequired } from "./review-stall.js";
import {
  commitAccepted,
  payloadArray,
  payloadRef,
  readReviewLedger,
  refuse,
  refuseFromKernel,
  refuseInvalidPayload,
  replayOf,
} from "./review-ledger.js";
import type { CommandHandler, HandlerContext, HandlerTable, ReviewOutcome } from "./review-ledger.js";
import {
  arrayDetail, firstDetail, parseFindings, parseItems, positiveIntegerDetail, refDetail,
  unexpectedKeysDetail,
} from "./review-payload-shape.js";
import { boundPackageItems } from "./review-round-items.js";
import type { PreparedReviewSubmission } from "./review-submission-package.js";
import { reviewContinuationForSubmission } from "./review-continuation.js";
import { verifierFailureSourceMatches } from "./review-verifier-failure.js";
import type { ReviewVerifierFailureSource } from "./review-verifier-failure.js";

/**
 * The review-flow services and the pipeline every review command runs through (journey J4).
 *
 * A service composes and never decides: it decodes, looks up a replay, reads the durable review
 * state for one subject, and hands the command to the `@moe/review` helper that owns it. Every
 * review rule — repeat detection by typed fingerprint, append-only lineage, the escalation cap,
 * acceptance eligibility — already exists upstream and is consumed whole. A condition here that
 * decided a review outcome would be a second source of truth and would drift.
 *
 * Refusals from the kernel carry ITS code and ITS layer, never a translation, so evidence always
 * shows which of the four layers answered.
 */

const encoder = new TextEncoder();

/** The exact keys a round may name; anything else refuses before a field is read. */
const SUBMIT_PAYLOAD_KEYS = Object.freeze(["findings", "packageItems", "round", "subjectRef"] as const);

function positiveInteger(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

/**
 * Records one review round.
 *
 * The evidence package is built BEFORE the round is recorded, so a round whose findings have no
 * bindable evidence is refused by the kernel's PACKAGE layer and nothing is written. The built
 * package's `reviewInputDigest` is stored alongside the lineage, which is what makes each
 * recorded finding permanently attributable to the exact evidence it was raised against.
 *
 * Every shape refusal names its field and the JSON type it wanted (`review-payload-shape.ts`).
 * The typed reads below stay the authority — `"4"` is still not a round — the detail only
 * says so, because a bare code sent three seats bisecting the payload by trial (2026-09-18).
 */
const submitRound: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const findingValues = payloadArray(request.payload, "findings");
  const itemValues = payloadArray(request.payload, "packageItems");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  const round = positiveInteger(request.payload["round"]);
  const shape = firstDetail(
    unexpectedKeysDetail(request.payload, SUBMIT_PAYLOAD_KEYS),
    arrayDetail(request.payload, "findings"),
    arrayDetail(request.payload, "packageItems"),
    refDetail(request.payload, "subjectRef"),
    positiveIntegerDetail(request.payload, "round"),
  );
  if (shape !== null || findingValues === null || itemValues === null || subjectRef === null || round === null) {
    return refuseInvalidPayload(request.kind, shape ?? "payload shape invalid");
  }
  const parsedFindings = parseFindings(findingValues);
  if (!parsedFindings.ok) return refuseInvalidPayload(request.kind, parsedFindings.detail);
  const findings = parsedFindings.value;
  const prepared = itemValues.length === 0 ? context.preparedSubmission : undefined;
  const parsedItems = prepared === undefined
    ? parseItems(itemValues)
    : { ok: true as const, value: prepared.items };
  if (!parsedItems.ok) return refuseInvalidPayload(request.kind, parsedItems.detail);
  const items: readonly ReviewPackageItemInput[] = parsedItems.value;
  // Before package preparation, so the submission admission refuses without capturing Git.
  const attributions = findingAttributionsValid(store, request.projectId, subjectRef, findings);
  // A plan the store could not serve is a store fault, not an accusation about the findings.
  if (typeof attributions === "symbol") {
    return refuse(request.kind, "REVIEW_FINDING_ATTRIBUTION_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (!attributions) {
    return refuse(request.kind, "REVIEW_FINDING_ATTRIBUTION_INVALID", "DAEMON_PREREQUISITE");
  }
  const built = buildReviewPackage(items);
  if (!built.ok) return refuseFromKernel(request.kind, built.code, built.layer);
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (ledger.replanned) return refuse(request.kind, "REVIEW_NODE_REPLANNED", "DAEMON_PREREQUISITE");
  const source = context.verifierFailureSource;
  const verifierFailure = findings.length > 0 && verifierFailureSourceMatches(source, ledger);
  // An acceptance is final to every caller but one: the host's own failed round naming the exact
  // accepted receipt it withdraws. Before it, accepted work that then failed to deliver left its
  // node accepted forever, with nothing landed and no seat ever staffed again (UnAI 2026-09-19).
  // `withdraws` is host-only like the source that carries it; SUBMIT_PAYLOAD_KEYS keeps both off
  // the wire.
  if (ledger.accepted !== undefined && !(verifierFailure && source?.withdraws !== undefined)) {
    return refuse(request.kind, "REVIEW_ALREADY_ACCEPTED", "DAEMON_PREREQUISITE");
  }
  // Design 15.2: reaching the limit creates a REVIEW_ESCALATION blocker, and a blocker blocks.
  // The kernel is stateless about what happens next — it would happily route a fourth round to
  // ESCALATE again — so the durable consequence is the composition's to enforce.
  const continuation = reviewContinuationForSubmission(ledger, request.projectId, subjectRef, round);
  if (source !== undefined && !verifierFailure) {
    return refuse(request.kind, "REVIEW_VERIFIER_RECEIPT_STALE", "DAEMON_PREREQUISITE");
  }
  // At the final allowed submission the host may append its one terminal diagnostic.
  // It is part of that submission, never authority for a 25th coding attempt.
  if (ledger.rounds.length >= REVIEW_ROUND_ABSOLUTE_CEILING
    && !(verifierFailure && ledger.rounds.length === REVIEW_ROUND_ABSOLUTE_CEILING)) {
    return refuse(request.kind, "REVIEW_ROUND_CEILING_REACHED", "DAEMON_PREREQUISITE");
  }
  // A stalled review is due the same decision as an exhausted one (review-stall.ts).
  if (reviewDecisionRequired(ledger) && continuation === undefined && !verifierFailure) {
    return refuse(request.kind, "REVIEW_ESCALATION_REQUIRED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const recorded = recordReviewRound(ledger.lineage, { findings, round }, continuation);
  if (!recorded.ok) return refuseFromKernel(request.kind, recorded.code, recorded.layer);
  const { lineage, routing } = recorded.value;
  const result = {
    // The stored source stays the exact 3-key triple the fold matches; a withdrawal travels
    // beside it, and the fold (review-read-model.ts) is its only reader.
    ...(verifierFailure && source !== undefined ? {
      verifierFailureSource: {
        aggregateVersion: source.aggregateVersion, decisionId: source.decisionId, resultSha256: source.resultSha256,
      },
      ...(source.withdraws === undefined ? {} : { withdrawsAcceptance: source.withdraws }),
    } : {}),
    ...(continuation === undefined ? {} : { continuation }),
    ...(prepared === undefined ? {} : { submissionEvidence: prepared.evidence }),
    lineage,
    // The set the kernel BOUND, never `items` — the caller's raw parsed array would durably
    // record content the digest stored beside it does not attest. Retained on the RESULT and
    // not on the event: recoverability is this surface's concern, the event shape is shared.
    packageItems: boundPackageItems(built.value),
    reviewInputDigest: built.value.reviewInputDigest,
    round,
    routing,
  } as unknown as JsonValue;
  // The result embeds the FULL lineage every round, so it grows with history while the store
  // bounds only the blob. Its reader uses `decodeBoundedJsonBytes`, including per-string and
  // nesting bounds. Reuse that exact decoder on the bytes `commitAccepted` will store, so a
  // result cannot commit successfully yet make all later commands permanently unreadable;
  // the subject stays readable and a smaller round (or escalation) still proceeds.
  if (!decodeBoundedJsonBytes(encoder.encode(JSON.stringify(result))).ok) {
    return refuse(request.kind, "REVIEW_RESULT_TOO_LARGE", "DAEMON_PREREQUISITE");
  }
  return commitAccepted(store, request, {
    aggregateId: subjectRef,
    eventPayload: {
      reviewInputDigest: built.value.reviewInputDigest,
      round,
      route: routing.route,
      subjectRef,
    },
    eventType: "ReviewRoundRecorded",
    expectedVersion: ledger.version,
    result,
  });
};

export const REVIEW_HANDLERS: HandlerTable = Object.freeze({
  "escalation.decide": decideEscalation,
  "integration.accept_output": acceptOutput,
  "qualification.replan": classifyReplanDelta,
  "review.submit": submitRound,
});

/**
 * The pipeline.
 *
 * Replay lookup precedes every handler deliberately: `recordReviewRound` refuses a round that
 * does not advance past the last recorded one, so an identical second request would be refused
 * as append-only and could never be recognised as the replay it actually is.
 *
 * The subject reference is read before the handler because the durable read is scoped to it. A
 * command naming no subject cannot be given a review state to reduce against, so it refuses at
 * the ingress layer rather than being folded against an empty one.
 */
export function runReviewCommand(
  store: SqliteEventStore,
  input: unknown,
  handlers: HandlerTable = REVIEW_HANDLERS,
  preparedSubmission?: PreparedReviewSubmission,
  verifierFailureSource?: ReviewVerifierFailureSource,
): ReviewOutcome {
  const decoded = decodeReviewRequestBytes(input);
  if (!decoded.ok) return refuse(null, decoded.code, "DAEMON_INGRESS");

  const request: ReviewRequest = decoded.request;
  const replay = replayOf(store, request);
  if (replay !== null) return replay;

  const handler = handlers[request.kind];
  if (handler === undefined) {
    return refuse(request.kind, "REVIEW_COMMAND_UNKNOWN", "DAEMON_INGRESS");
  }

  const subjectRef = payloadRef(request.payload, "subjectRef");
  if (subjectRef === null) {
    return refuseInvalidPayload(
      request.kind, refDetail(request.payload, "subjectRef") ?? "subjectRef missing",
    );
  }

  const ledger = readReviewLedger(store, request.projectId, subjectRef);
  const context: HandlerContext = { ledger, request, store,
    ...(verifierFailureSource === undefined ? {} : { verifierFailureSource }),
    ...(preparedSubmission === undefined ? {} : { preparedSubmission }) };
  return handler(context);
}
