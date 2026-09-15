import { parseAcceptance, parseDelta, parseRound } from "./review-read-parsers.js";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import { EMPTY_REVIEW_LINEAGE } from "@moe/review";
import type { ReviewLineage, ReviewRouting } from "@moe/review";
import type { ReviewContinuationApproval, ReviewContinuationUse } from "@moe/review";
import { readReviewContinuationApproval, readReviewContinuationUse } from "./review-continuation.js";
import { storedVerifierFailureSourceMatches } from "./review-verifier-failure.js";
import type { SqliteEventStore } from "@moe/store";

import { isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";
import type { StoredPackageItems } from "./review-round-items.js";
import { VERIFIER_RECEIPT_COMMAND_KIND, decodeVerifierReceiptBytes } from "./verifier-receipt-contracts.js";
import type { VerifierExecutionEvidence } from "./verifier-receipt-contracts.js";
import {
  LANDING_RECEIPT_COMMAND_KIND, decodeLandingReceiptBytes, landingAggregateId,
} from "../repository/landing-receipt-contracts.js";
import type { LandingReceiptV1 } from "../repository/landing-receipt-contracts.js";
import {
  REPOSITORY_LANDING_INTENT_KIND, decodeRepositoryLandingIntent, landingIntentKey,
} from "../repository/repository-landing-intent.js";
import { decisionsOf } from "../decision-ledger-memo.js";

/**
 * The read half of the review composition: every committed decision for one reviewed subject,
 * folded into its current review state.
 *
 * Split from `review-ledger.ts` to keep both near the per-file target. This module touches no
 * commit path and decides nothing — it validates the SHAPE of stored bytes and hands them back.
 * Whether a lineage tells the truth is `@moe/review`'s question: `recordReviewRound` recomputes
 * the digest and refuses `FINDING_LINEAGE_DIGEST_MISMATCH` on a hand-reset counter or a
 * truncated record list, so re-deciding it here would be a second source of truth.
 */

export interface ReviewRoundRecord {
  readonly continuation?: ReviewContinuationUse;
  readonly aggregateVersion: number;
  readonly decisionId: string;
  readonly lineage: ReviewLineage;
  /** PRESENT with the items the round was raised against, or ABSENT — never an empty list. */
  readonly packageItems: StoredPackageItems;
  readonly principalId: string;
  readonly reviewInputDigest: string;
  readonly resultSha256: string;
  readonly round: number;
  readonly routing: ReviewRouting;
}

export interface DeltaRecord {
  readonly classifications: readonly DeltaNodeClassification[];
  readonly successorPlanRef: string;
}

/** `@moe/review`'s acceptance qualification as it was recorded. */
export interface AcceptanceRecord {
  readonly policyDecision: string;
  readonly reviewInputDigest: string;
  readonly reviewerCalibrationDigest: string;
  readonly verifierReceiptId: string;
  readonly verifierReceiptSha256: string;
}

export interface ReviewLedger {
  /** One unconsumed human approval. Consumed authority remains on its exact review round. */
  readonly continuation?: ReviewContinuationApproval;
  /** The recorded acceptance, or undefined when none qualified. */
  readonly accepted: AcceptanceRecord | undefined;
  readonly decisionCount: number;
  /** The latest re-plan's classification, or undefined when no re-plan has been recorded. */
  readonly delta: DeltaRecord | undefined;
  readonly escalated: boolean;
  readonly lineage: ReviewLineage;
  /** True once a human answered the exhausted review with REPLAN: no further round is admissible. */
  readonly replanned: boolean;
  readonly rounds: readonly ReviewRoundRecord[];
  readonly unreadable: boolean;
  readonly version: number;
}

const LEDGER_PAGE_SIZE = 200;

function decodeResult(bytes: Uint8Array): JsonValue {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? decoded.value : null;
}

/**
 * Only `EFFECTS_COMMITTED` decisions fold into state: the store's `NO_BUSINESS_EFFECT` audit rows
 * record that a command was REFUSED, and treating one as prior state would let a refusal advance
 * the round counter. `decisionCount` deliberately counts BOTH, because "nothing was written" has
 * to be provable against audit rows too.
 */
interface Accumulator {
  continuation: ReviewContinuationApproval | undefined;
  accepted: AcceptanceRecord | undefined;
  delta: DeltaRecord | undefined;
  escalated: boolean;
  receipt: VerifierExecutionEvidence | undefined;
  replanned: boolean;
  readonly rounds: ReviewRoundRecord[];
  unreadable: boolean;
  version: number;
}

const freshAccumulator = (): Accumulator => ({
  continuation: undefined,
  accepted: undefined, delta: undefined, escalated: false, receipt: undefined, replanned: false,
  rounds: [], unreadable: false, version: 0,
});

/** One committed decision on the subject, folded exactly as the single-subject read folds it. */
function fold(
  acc: Accumulator,
  decision: Readonly<{
    commandKind: string; currentVersion: number; decisionId: string;
    key: Readonly<{ principalId: string; projectId: string }>; targetAggregateId: string;
    resultBytes: Uint8Array; resultSha256: string;
  }>,
): void {
  const priorVersion = acc.version;
  acc.version = decision.currentVersion;
  if (decision.commandKind === "escalation.decide") {
    // The decision travels in the committed result; REPLAN closes the node to further rounds.
    const result = decodeResult(decision.resultBytes);
    if (!isPlainJsonObject(result)
      || (result["decision"] !== "ALLOW_MORE_ATTEMPTS" && result["decision"] !== "REPLAN")) {
      acc.unreadable = true;
      return;
    }
    acc.escalated = true;
    if (result["decision"] === "REPLAN") acc.replanned = true;
    acc.continuation = undefined;
    if (result["decision"] === "ALLOW_MORE_ATTEMPTS" && result["continuationSource"] !== undefined) {
      const approval = readReviewContinuationApproval(result["continuationSource"], decision.key.projectId,
        decision.targetAggregateId, priorVersion, acc.rounds.at(-1), decision, acc.rounds.at(-2));
      if (approval === undefined || acc.replanned || acc.accepted !== undefined) acc.unreadable = true;
      else acc.continuation = approval;
    }
    return;
  }
  if (decision.commandKind === "integration.accept_output") {
    const parsed = parseAcceptance(decodeResult(decision.resultBytes));
    if (parsed === undefined) acc.unreadable = true;
    else acc.accepted = parsed;
    return;
  }
  if (decision.commandKind === "qualification.replan") {
    const parsed = parseDelta(decodeResult(decision.resultBytes));
    if (parsed === undefined) acc.unreadable = true;
    else acc.delta = parsed;
    return;
  }
  if (decision.commandKind === VERIFIER_RECEIPT_COMMAND_KIND) {
    // The daemon's own execution evidence for the node; a receipt that does not decode is
    // simply absent here (the acceptance that consumed it is the fact that counts).
    const decoded = decodeVerifierReceiptBytes(decision.resultBytes);
    if (decoded.ok) acc.receipt = decoded.receipt.execution;
    return;
  }
  if (decision.commandKind !== "review.submit") return;
  const result = decodeResult(decision.resultBytes);
  const round = parseRound(result, {
    aggregateVersion: decision.currentVersion,
    decisionId: decision.decisionId,
    principalId: decision.key.principalId,
    resultSha256: decision.resultSha256,
  });
  if (round === undefined) acc.unreadable = true;
  else {
    const failureSource = isPlainJsonObject(result) ? result["verifierFailureSource"] : undefined;
    if (failureSource !== undefined && (!storedVerifierFailureSourceMatches(failureSource, acc.rounds.at(-1))
      || round.aggregateVersion !== priorVersion + 1 || round.routing.route === "ACCEPT")) acc.unreadable = true;
    const raw = isPlainJsonObject(result) ? result["continuation"] : undefined;
    const use = raw === undefined ? undefined
      : readReviewContinuationUse(raw, acc.continuation, acc.rounds.at(-1), round);
    if ((raw !== undefined && use === undefined) || (acc.continuation !== undefined && use === undefined)) {
      acc.unreadable = true;
    }
    acc.rounds.push(use === undefined ? round : { ...round, continuation: use });
    acc.continuation = undefined;
  }
}

function ledgerOf(acc: Accumulator, decisionCount: number): ReviewLedger {
  const latest = acc.rounds[acc.rounds.length - 1];
  return Object.freeze({
    ...(acc.continuation === undefined ? {} : { continuation: acc.continuation }),
    accepted: acc.accepted,
    decisionCount,
    delta: acc.delta,
    escalated: acc.escalated,
    lineage: latest === undefined ? EMPTY_REVIEW_LINEAGE : latest.lineage,
    replanned: acc.replanned,
    rounds: Object.freeze(acc.rounds),
    unreadable: acc.unreadable,
    version: acc.version,
  });
}

export interface ReviewLedgers {
  /**
   * The `landingIntentKey` of every landing intent this project journaled, or NULL when any
   * intent decision in the walk did not decode.
   *
   * NULL IS NOT AN EMPTY SET and the difference is the whole point. Empty means "walked the
   * ledger, found no intent" — a reader may then credit a landing on its receipt code alone.
   * Null means "an intent was journaled and its bytes are unreadable", and unverifiable evidence
   * gains no authority: a reader holding null credits nothing. Collapsing the two would let lost
   * work be credited as landed, which is the defect this set exists to close.
   */
  readonly landingIntents: ReadonlySet<string> | null;
  /** The lander's receipt per subject (a commit, or a refusal with its code), where it decodes. */
  readonly landings: ReadonlyMap<string, LandingReceiptV1>;
  readonly ledgers: ReadonlyMap<string, ReviewLedger>;
  /** The verifier's execution evidence per subject, where its receipt decision decodes. */
  readonly receipts: ReadonlyMap<string, VerifierExecutionEvidence>;
}

/**
 * ONE walk of the decision ledger for MANY subjects: every subject named gets a ledger (an
 * empty one when nothing was decided on it), folded exactly as `readReviewLedger` folds one.
 * A board of N nodes reads its review facts in one pass instead of N.
 */
export function readReviewLedgers(
  store: SqliteEventStore,
  projectId: string,
  subjectRefs: ReadonlySet<string>,
): ReviewLedgers {
  const accumulators = new Map<string, Accumulator>();
  // Landings sit on a sibling aggregate (`landing:<subject>`), so the node's own version is
  // never moved by a commit; the same walk picks them up by that aggregate id.
  const landingSubjects = new Map<string, string>();
  for (const subjectRef of subjectRefs) {
    accumulators.set(subjectRef, freshAccumulator());
    landingSubjects.set(landingAggregateId(subjectRef), subjectRef);
  }
  const landings = new Map<string, LandingReceiptV1>();
  // EVERY project intent, never narrowed by `landingSubjects` the way the receipt branch is: the
  // key is the exact (nodeRef, receiptId) pair and the nodeRef is known only AFTER decoding, so a
  // subject filter would decode and then discard — all of the cost, none of the saving, and it
  // would silently drop an intent a later caller asks about.
  const landingIntents = new Set<string>();
  let intentUnreadable = false;
  let decisionCount = 0;
  for (const decision of decisionsOf(store, LEDGER_PAGE_SIZE)) {
    if (decision.key.projectId !== projectId) continue;
    decisionCount += 1;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
    const acc = accumulators.get(decision.targetAggregateId);
    if (acc !== undefined) fold(acc, decision);
    const landed = landingSubjects.get(decision.targetAggregateId);
    if (landed !== undefined && decision.commandKind === LANDING_RECEIPT_COMMAND_KIND) {
      const decoded = decodeLandingReceiptBytes(decision.resultBytes);
      if (decoded.ok && decoded.receipt.subjectRef === landed) landings.set(landed, decoded.receipt);
    }
    if (decision.commandKind === REPOSITORY_LANDING_INTENT_KIND) {
      // FLAG, NEVER RETURN. The walk feeds `landings`, `receipts` and the `decisionCount` every
      // subject's ledger carries, so leaving it early would corrupt the whole batch. Null the set
      // once the walk is done instead.
      const intent = decodeRepositoryLandingIntent(decodeResult(decision.resultBytes));
      if (intent === null) intentUnreadable = true;
      else landingIntents.add(landingIntentKey(intent.nodeRef, intent.verifierReceiptId));
    }
  }
  const ledgers = new Map<string, ReviewLedger>();
  const receipts = new Map<string, VerifierExecutionEvidence>();
  for (const [subjectRef, acc] of accumulators) {
    ledgers.set(subjectRef, ledgerOf(acc, decisionCount));
    if (acc.receipt !== undefined) receipts.set(subjectRef, acc.receipt);
  }
  return Object.freeze({
    landingIntents: intentUnreadable ? null : landingIntents, landings, ledgers, receipts,
  });
}

export function readReviewLedger(
  store: SqliteEventStore,
  projectId: string,
  subjectRef: string,
): ReviewLedger {
  const ledger = readReviewLedgers(store, projectId, new Set([subjectRef])).ledgers.get(subjectRef);
  if (ledger === undefined) throw new Error("unreachable: the named subject is always folded");
  return ledger;
}
