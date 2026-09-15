import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import {
  REVIEW_ESCALATION_ROUND_LIMIT,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SUBJECT_KINDS,
  REVIEW_ROUND_ABSOLUTE_CEILING,
  buildReviewPackage,
  recordReviewRound,
} from "@moe/review";
import type { ReviewFinding, ReviewPackageItemInput } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { acceptOutput, decideEscalation } from "./review-acceptance.js";
import { decodeReviewRequestBytes, isPlainJsonObject } from "./review-contracts.js";
import type { ReviewRequest } from "./review-contracts.js";
import { classifyReplanDelta } from "./review-delta.js";
import { findingAttributionsValid } from "./review-finding-attribution.js";
import {
  commitAccepted,
  payloadArray,
  payloadRef,
  readReviewLedger,
  refuse,
  refuseFromKernel,
  replayOf,
} from "./review-ledger.js";
import type { CommandHandler, HandlerContext, HandlerTable, ReviewOutcome } from "./review-ledger.js";
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

const SEVERITIES: ReadonlySet<string> = new Set<string>(REVIEW_FINDING_SEVERITIES);
const SUBJECT_KINDS: ReadonlySet<string> = new Set<string>(REVIEW_FINDING_SUBJECT_KINDS);

const encoder = new TextEncoder();

/**
 * Shape only, against the KERNEL'S OWN vocabularies rather than a local copy of them. A finding
 * must name a typed subject with a non-empty locator, which is what makes it a link to a
 * required change rather than free prose.
 */
/**
 * An attribution names another node of the reporter's plan: exactly `nodeKey` and
 * `criterionIds`. Anything else is not an attribution, and silently dropping it would charge the
 * reporter for a finding it said it does not own - so the whole payload refuses instead.
 */
function parseAttribution(value: JsonValue): ReviewFinding["attributedTo"] | null {
  if (!isPlainJsonObject(value)) return null;
  const nodeKey = value["nodeKey"];
  const criterionIds = value["criterionIds"];
  if (Object.keys(value).length !== 2 || typeof nodeKey !== "string" || !Array.isArray(criterionIds)
    || !criterionIds.every((entry) => typeof entry === "string")) return null;
  return { criterionIds: criterionIds as string[], nodeKey };
}

function parseFinding(value: JsonValue): ReviewFinding | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const attribution = value["attributedTo"] === undefined ? undefined : parseAttribution(value["attributedTo"]);
  if (attribution === null) return undefined;
  const subject = value["subject"];
  const detail = value["detail"];
  const ruleId = value["ruleId"];
  const severity = value["severity"];
  if (!isPlainJsonObject(subject)) return undefined;
  const kind = subject["kind"];
  const locator = subject["locator"];
  if (typeof detail !== "string" || typeof ruleId !== "string" || ruleId.length === 0) {
    return undefined;
  }
  if (typeof severity !== "string" || !SEVERITIES.has(severity)) return undefined;
  if (typeof kind !== "string" || !SUBJECT_KINDS.has(kind)) return undefined;
  if (typeof locator !== "string" || locator.length === 0) return undefined;
  return {
    ...(attribution === undefined ? {} : { attributedTo: attribution }),
    detail,
    ruleId,
    severity,
    subject: { kind, locator },
  } as ReviewFinding;
}

function parseFindings(values: readonly JsonValue[]): readonly ReviewFinding[] | undefined {
  const parsed: ReviewFinding[] = [];
  for (const value of values) {
    const finding = parseFinding(value);
    if (finding === undefined) return undefined;
    parsed.push(finding);
  }
  return parsed;
}

function parseItems(values: readonly JsonValue[]): readonly ReviewPackageItemInput[] | undefined {
  const parsed: ReviewPackageItemInput[] = [];
  for (const value of values) {
    if (!isPlainJsonObject(value)) return undefined;
    const digest = value["digest"];
    const kind = value["kind"];
    const locator = value["locator"];
    if (typeof digest !== "string" || typeof kind !== "string" || typeof locator !== "string") {
      return undefined;
    }
    parsed.push({ digest, kind, locator });
  }
  return parsed;
}

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
 */
const submitRound: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const findingValues = payloadArray(request.payload, "findings");
  const itemValues = payloadArray(request.payload, "packageItems");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  const round = positiveInteger(request.payload["round"]);
  if (Object.keys(request.payload).some((key) => !["findings", "packageItems", "round", "subjectRef"].includes(key))) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (findingValues === null || itemValues === null || subjectRef === null || round === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const findings = parseFindings(findingValues);
  const prepared = itemValues.length === 0 ? context.preparedSubmission : undefined;
  const items = prepared?.items ?? parseItems(itemValues);
  if (findings === undefined || items === undefined) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  // Before package preparation, so the submission admission refuses without capturing Git.
  if (!findingAttributionsValid(store, request.projectId, subjectRef, findings)) {
    return refuse(request.kind, "REVIEW_FINDING_ATTRIBUTION_INVALID", "DAEMON_PREREQUISITE");
  }
  const built = buildReviewPackage(items);
  if (!built.ok) return refuseFromKernel(request.kind, built.code, built.layer);
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  if (ledger.replanned) return refuse(request.kind, "REVIEW_NODE_REPLANNED", "DAEMON_PREREQUISITE");
  if (ledger.accepted !== undefined) return refuse(request.kind, "REVIEW_ALREADY_ACCEPTED", "DAEMON_PREREQUISITE");
  // Design 15.2: reaching the limit creates a REVIEW_ESCALATION blocker, and a blocker blocks.
  // The kernel is stateless about what happens next — it would happily route a fourth round to
  // ESCALATE again — so the durable consequence is the composition's to enforce.
  const continuation = reviewContinuationForSubmission(ledger, request.projectId, subjectRef, round);
  const verifierFailure = findings.length > 0 && verifierFailureSourceMatches(context.verifierFailureSource, ledger);
  if (context.verifierFailureSource !== undefined && !verifierFailure) {
    return refuse(request.kind, "REVIEW_VERIFIER_RECEIPT_STALE", "DAEMON_PREREQUISITE");
  }
  // At the final allowed submission the host may append its one terminal diagnostic.
  // It is part of that submission, never authority for a 25th coding attempt.
  if (ledger.rounds.length >= REVIEW_ROUND_ABSOLUTE_CEILING
    && !(verifierFailure && ledger.rounds.length === REVIEW_ROUND_ABSOLUTE_CEILING)) {
    return refuse(request.kind, "REVIEW_ROUND_CEILING_REACHED", "DAEMON_PREREQUISITE");
  }
  if (ledger.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT && continuation === undefined && !verifierFailure) {
    return refuse(request.kind, "REVIEW_ESCALATION_REQUIRED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const recorded = recordReviewRound(ledger.lineage, { findings, round }, continuation);
  if (!recorded.ok) return refuseFromKernel(request.kind, recorded.code, recorded.layer);
  const { lineage, routing } = recorded.value;
  const result = {
    ...(verifierFailure ? { verifierFailureSource: context.verifierFailureSource } : {}),
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
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const ledger = readReviewLedger(store, request.projectId, subjectRef);
  const context: HandlerContext = { ledger, request, store,
    ...(verifierFailureSource === undefined ? {} : { verifierFailureSource }),
    ...(preparedSubmission === undefined ? {} : { preparedSubmission }) };
  return handler(context);
}
