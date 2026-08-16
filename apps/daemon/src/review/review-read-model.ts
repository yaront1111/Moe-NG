import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import { EMPTY_REVIEW_LINEAGE } from "@moe/review";
import type { ReviewLineage, ReviewRouting } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { DELTA_CLASSIFICATIONS, isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";

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
  const round = result["round"];
  if (lineage === undefined || routing === undefined) return undefined;
  if (typeof round !== "number" || !isRef(result["reviewInputDigest"])) return undefined;
  return {
    ...storeFacts,
    lineage,
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
export function readReviewLedger(
  store: SqliteEventStore,
  projectId: string,
  subjectRef: string,
): ReviewLedger {
  const rounds: ReviewRoundRecord[] = [];
  let accepted: AcceptanceRecord | undefined;
  let decisionCount = 0;
  let delta: DeltaRecord | undefined;
  let escalated = false;
  let unreadable = false;
  let version = 0;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      decisionCount += 1;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      if (decision.targetAggregateId !== subjectRef) continue;
      version = decision.currentVersion;
      if (decision.commandKind === "escalation.decide") escalated = true;
      if (decision.commandKind === "integration.accept_output") {
        const parsed = parseAcceptance(decodeResult(decision.resultBytes));
        if (parsed === undefined) unreadable = true;
        else accepted = parsed;
        continue;
      }
      if (decision.commandKind === "qualification.replan") {
        const parsed = parseDelta(decodeResult(decision.resultBytes));
        if (parsed === undefined) unreadable = true;
        else delta = parsed;
        continue;
      }
      if (decision.commandKind !== "review.submit") continue;
      const round = parseRound(decodeResult(decision.resultBytes), {
        aggregateVersion: decision.currentVersion,
        decisionId: decision.decisionId,
        principalId: decision.key.principalId,
        resultSha256: decision.resultSha256,
      });
      if (round === undefined) unreadable = true;
      else rounds.push(round);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const latest = rounds[rounds.length - 1];
  return Object.freeze({
    accepted,
    decisionCount,
    delta,
    escalated,
    lineage: latest === undefined ? EMPTY_REVIEW_LINEAGE : latest.lineage,
    rounds: Object.freeze(rounds),
    unreadable,
    version,
  });
}
