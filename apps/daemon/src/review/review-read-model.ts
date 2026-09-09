import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import { EMPTY_REVIEW_LINEAGE } from "@moe/review";
import type { ReviewLineage, ReviewRouting } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { DELTA_CLASSIFICATIONS, isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";
import { parseStoredPackageItems } from "./review-round-items.js";
import type { StoredPackageItems } from "./review-round-items.js";
import { VERIFIER_RECEIPT_COMMAND_KIND, decodeVerifierReceiptBytes } from "./verifier-receipt-contracts.js";
import type { VerifierExecutionEvidence } from "./verifier-receipt-contracts.js";
import {
  LANDING_RECEIPT_COMMAND_KIND, decodeLandingReceiptBytes, landingAggregateId,
} from "../repository/landing-receipt-contracts.js";
import type { LandingReceiptV1 } from "../repository/landing-receipt-contracts.js";
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
const CLASSIFICATION_SET: ReadonlySet<string> = new Set<string>(DELTA_CLASSIFICATIONS);

function decodeResult(bytes: Uint8Array): JsonValue {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? decoded.value : null;
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validRecord(value: JsonValue): boolean {
  if (!isPlainJsonObject(value)) return false;
  const finding = value["finding"];
  if (!isPlainJsonObject(finding)) return false;
  const subject = finding["subject"];
  return (
    isRef(value["fingerprint"])
    && typeof value["round"] === "number"
    && isRef(finding["ruleId"])
    && typeof finding["detail"] === "string"
    && isRef(finding["severity"])
    && isPlainJsonObject(subject)
    && isRef(subject["kind"])
    && typeof subject["locator"] === "string"
  );
}

/**
 * Structural validation only, and it returns undefined rather than an empty lineage on failure.
 * Treating unparseable bytes as "no rounds yet" would silently reset `unsuccessfulRounds` and
 * lift the escalation cap, so the caller has to fail closed instead.
 */
function parseLineage(value: JsonValue | undefined): ReviewLineage | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const records = value["records"];
  if (!isRef(value["digest"]) || typeof value["unsuccessfulRounds"] !== "number") return undefined;
  // `highestRound` is required: a stored lineage without it predates the
  // append-only frontier and cannot be trusted to report it, so fail closed
  // rather than defaulting a value the digest never covered.
  if (typeof value["highestRound"] !== "number") return undefined;
  if (!Array.isArray(records) || !records.every(validRecord)) return undefined;
  return value as unknown as ReviewLineage;
}

function parseRouting(value: JsonValue | undefined): ReviewRouting | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  if (!isRef(value["layer"]) || !isRef(value["route"])) return undefined;
  if (!isStringArray(value["reasonCodes"]) || !isStringArray(value["repeatFingerprints"])) {
    return undefined;
  }
  return value as unknown as ReviewRouting;
}

function parseClassification(value: JsonValue): DeltaNodeClassification | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const classification = value["classification"];
  if (typeof classification !== "string" || !CLASSIFICATION_SET.has(classification)) {
    return undefined;
  }
  if (!isRef(value["nodeRef"]) || !isStringArray(value["reasonCodes"])) return undefined;
  if (typeof value["sourceHash"] !== "string" || typeof value["targetHash"] !== "string") {
    return undefined;
  }
  return value as unknown as DeltaNodeClassification;
}

function parseDelta(result: JsonValue): DeltaRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  const classifications = result["classifications"];
  if (!isRef(result["successorPlanRef"])) return undefined;
  if (!Array.isArray(classifications) || classifications.length === 0) return undefined;
  if (!classifications.every((entry) => parseClassification(entry) !== undefined)) return undefined;
  return result as unknown as DeltaRecord;
}

function parseAcceptance(result: JsonValue): AcceptanceRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  if (!isRef(result["policyDecision"]) || !isRef(result["reviewInputDigest"])) return undefined;
  if (!isRef(result["reviewerCalibrationDigest"])) return undefined;
  if (!isRef(result["verifierReceiptId"]) || !isRef(result["verifierReceiptSha256"])) {
    return undefined;
  }
  return result as unknown as AcceptanceRecord;
}

function parseRound(
  result: JsonValue,
  storeFacts: Readonly<{
    aggregateVersion: number;
    decisionId: string;
    principalId: string;
    resultSha256: string;
  }>,
): ReviewRoundRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  const lineage = parseLineage(result["lineage"]);
  const routing = parseRouting(result["routing"]);
  // A malformed items key makes the whole round unreadable rather than partly trusted: binding
  // an item set nobody validated would put bytes the stored digest never covered in front of a
  // caller that has no way left to tell.
  const packageItems = parseStoredPackageItems(result["packageItems"]);
  const round = result["round"];
  if (lineage === undefined || routing === undefined || packageItems === undefined) return undefined;
  if (typeof round !== "number" || !isRef(result["reviewInputDigest"])) return undefined;
  return {
    ...storeFacts,
    lineage,
    packageItems,
    reviewInputDigest: result["reviewInputDigest"],
    round,
    routing,
  };
}

/**
 * Only `EFFECTS_COMMITTED` decisions fold into state: the store's `NO_BUSINESS_EFFECT` audit rows
 * record that a command was REFUSED, and treating one as prior state would let a refusal advance
 * the round counter. `decisionCount` deliberately counts BOTH, because "nothing was written" has
 * to be provable against audit rows too.
 */
interface Accumulator {
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
  accepted: undefined, delta: undefined, escalated: false, receipt: undefined, replanned: false,
  rounds: [], unreadable: false, version: 0,
});

/** One committed decision on the subject, folded exactly as the single-subject read folds it. */
function fold(
  acc: Accumulator,
  decision: Readonly<{
    commandKind: string; currentVersion: number; decisionId: string;
    key: Readonly<{ principalId: string }>; resultBytes: Uint8Array; resultSha256: string;
  }>,
): void {
  acc.version = decision.currentVersion;
  if (decision.commandKind === "escalation.decide") {
    acc.escalated = true;
    // The decision travels in the committed result; REPLAN closes the node to further rounds.
    const result = decodeResult(decision.resultBytes);
    if (isPlainJsonObject(result) && result["decision"] === "REPLAN") acc.replanned = true;
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
  const round = parseRound(decodeResult(decision.resultBytes), {
    aggregateVersion: decision.currentVersion,
    decisionId: decision.decisionId,
    principalId: decision.key.principalId,
    resultSha256: decision.resultSha256,
  });
  if (round === undefined) acc.unreadable = true;
  else acc.rounds.push(round);
}

function ledgerOf(acc: Accumulator, decisionCount: number): ReviewLedger {
  const latest = acc.rounds[acc.rounds.length - 1];
  return Object.freeze({
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
  }
  const ledgers = new Map<string, ReviewLedger>();
  const receipts = new Map<string, VerifierExecutionEvidence>();
  for (const [subjectRef, acc] of accumulators) {
    ledgers.set(subjectRef, ledgerOf(acc, decisionCount));
    if (acc.receipt !== undefined) receipts.set(subjectRef, acc.receipt);
  }
  return Object.freeze({ landings, ledgers, receipts });
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
