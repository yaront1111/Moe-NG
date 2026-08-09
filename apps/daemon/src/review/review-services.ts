import type { JsonValue } from "@moe/contracts";
import {
  REVIEW_ESCALATION_ROUND_LIMIT,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SUBJECT_KINDS,
  buildReviewPackage,
  recordReviewRound,
} from "@moe/review";
import type { ReviewFinding, ReviewPackageItemInput } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { acceptOutput, decideEscalation } from "./review-acceptance.js";
import { decodeReviewRequestBytes, isPlainJsonObject } from "./review-contracts.js";
import type { ReviewRequest } from "./review-contracts.js";
import { classifyReplanDelta } from "./review-delta.js";
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

/**
 * Shape only, against the KERNEL'S OWN vocabularies rather than a local copy of them. A finding
 * must name a typed subject with a non-empty locator, which is what makes it a link to a
 * required change rather than free prose.
 */
function parseFinding(value: JsonValue): ReviewFinding | undefined {
  if (!isPlainJsonObject(value)) return undefined;
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
  if (findingValues === null || itemValues === null || subjectRef === null || round === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const findings = parseFindings(findingValues);
  const items = parseItems(itemValues);
  if (findings === undefined || items === undefined) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const built = buildReviewPackage(items);
  if (!built.ok) return refuseFromKernel(request.kind, built.code, built.layer);
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  // Design 15.2: reaching the limit creates a REVIEW_ESCALATION blocker, and a blocker blocks.
  // The kernel is stateless about what happens next — it would happily route a fourth round to
  // ESCALATE again — so the durable consequence is the composition's to enforce.
  if (ledger.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT && !ledger.escalated) {
    return refuse(request.kind, "REVIEW_ESCALATION_REQUIRED", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const recorded = recordReviewRound(ledger.lineage, { findings, round });
  if (!recorded.ok) return refuseFromKernel(request.kind, recorded.code, recorded.layer);
  const { lineage, routing } = recorded.value;
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
    result: {
      lineage,
      reviewInputDigest: built.value.reviewInputDigest,
      round,
      routing,
    } as unknown as JsonValue,
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
  const context: HandlerContext = { ledger, request, store };
  return handler(context);
}
