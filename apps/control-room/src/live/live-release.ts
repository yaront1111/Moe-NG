import {
  effectCount, effectHash, effectList, effectRecord, effectRefusal, effectSha, effectText, readEffect,
} from "./live-effect-read.js";
import type { EffectReadFailure } from "./live-effect-read.js";

/**
 * THE RELEASE EVIDENCE READ in the browser: POST `/release/read` decoded by exact keys.
 *
 * EVERY CRITERION KEEPS ITS OWN `gaps`, and nothing here sums them. The daemon deliberately
 * refuses to compute a covered/UNKNOWN pair (release-evidence-read.ts: "A count computed here
 * would be a second authority the card could drift from"), so this decoder refuses to invent
 * one too. The card derives both numbers from the rows in one place, which is the only way
 * `covered` and `UNKNOWN` cannot disagree with the gap list printed underneath them.
 *
 * ABSENT IS NOT A REFUSAL. A goal with no approved scope answers ABSENT; a receipt ledger that
 * will not decode answers REFUSED with its code. A card that could not tell those apart would
 * show an operator an error for the ordinary case.
 */

const LAYER = "CONTROL_ROOM_RELEASE_READ";

/** Why one citation could not be re-measured. The code vocabulary is the daemon's; this
 *  carries it verbatim rather than restating a closed set the browser cannot own. */
export interface ReleaseGapView {
  readonly code: string;
  readonly criterionId: string;
  readonly detail: string;
}

/** One criterion's folded evidence chain. `gaps` empty means covered; non-empty means UNKNOWN. */
export interface ReleaseCriterionView {
  readonly command: string;
  readonly criterionId: string;
  readonly exitCode: string;
  readonly gaps: readonly ReleaseGapView[];
  readonly landing: string;
  readonly nodeKey: string;
  readonly receiptSha: string;
  readonly title: string;
}

export interface ReleasePreviewView {
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly outcome: string;
  readonly url: string | null;
}

export interface ReleaseReviewRoundView {
  readonly nodeKey: string;
  readonly outcome: "ACCEPTED" | "REFUSED";
  readonly refusalCode: string | null;
  readonly round: number;
}

/** The decision already taken, if one was. `refusalCode` is rendered VERBATIM by the card. */
export interface ReleaseReceiptView {
  readonly dossierSha256: string;
  readonly outcome: "RELEASED" | "REFUSED";
  readonly prUrl: string | null;
  readonly receiptId: string;
  readonly refusalCode: string | null;
  readonly sha: string;
}

export interface ReleaseEvidenceView {
  /** FALSE when no workspace could re-measure landings: every landing then reads UNKNOWN for a
   *  reason that is not the criterion's fault, and the card must say which it is. */
  readonly ancestryMeasured: boolean;
  readonly criteria: readonly ReleaseCriterionView[];
  readonly goalId: string;
  readonly goalTitle: string;
  readonly preview: ReleasePreviewView | null;
  readonly receipt: ReleaseReceiptView | null;
  readonly reviewRounds: readonly ReleaseReviewRoundView[];
  /** The published sha this evidence is measured at, or null when nothing is pushed yet. */
  readonly sha: string | null;
}

export type ReleaseOutcome =
  | EffectReadFailure
  | { readonly status: "ABSENT"; readonly goalId: string }
  | { readonly status: "PRESENT"; readonly evidence: ReleaseEvidenceView };

const nullableText = (value: unknown): value is string | null => value === null || effectText(value);
const invalid = (): EffectReadFailure => ({ status: "ERROR", code: "RELEASE_RESPONSE_INVALID", layer: LAYER });

function gapOf(value: unknown): ReleaseGapView | null {
  const row = effectRecord(value, ["code", "criterionId", "detail"]);
  if (row === null || !effectText(row.code) || !effectText(row.criterionId) || !effectText(row.detail)) return null;
  return { code: row.code, criterionId: row.criterionId, detail: row.detail };
}

function criterionOf(value: unknown): ReleaseCriterionView | null {
  const row = effectRecord(value,
    ["command", "criterionId", "exitCode", "gaps", "landing", "nodeKey", "receiptSha", "title"]);
  if (row === null || !effectText(row.command) || !effectText(row.criterionId) || !effectText(row.exitCode)
    || !effectText(row.landing) || !effectText(row.nodeKey) || !effectText(row.receiptSha)
    || !effectText(row.title)) return null;
  const gaps = effectList(row.gaps, gapOf, 64);
  if (gaps === null) return null;
  return { command: row.command, criterionId: row.criterionId, exitCode: row.exitCode, gaps,
    landing: row.landing, nodeKey: row.nodeKey, receiptSha: row.receiptSha, title: row.title };
}

function previewOf(value: unknown): ReleasePreviewView | null {
  const row = effectRecord(value, ["decidedAt", "decisionId", "outcome", "url"]);
  if (row === null || !effectText(row.decidedAt) || !effectText(row.decisionId)
    || !effectText(row.outcome) || !nullableText(row.url)) return null;
  return { decidedAt: row.decidedAt, decisionId: row.decisionId, outcome: row.outcome, url: row.url };
}

function roundOf(value: unknown): ReleaseReviewRoundView | null {
  const row = effectRecord(value, ["nodeKey", "outcome", "refusalCode", "round"]);
  if (row === null || !effectText(row.nodeKey) || !effectCount(row.round) || !nullableText(row.refusalCode)
    || (row.outcome !== "ACCEPTED" && row.outcome !== "REFUSED")) return null;
  return { nodeKey: row.nodeKey, outcome: row.outcome, refusalCode: row.refusalCode, round: row.round };
}

function receiptOf(value: unknown): ReleaseReceiptView | null {
  const row = effectRecord(value,
    ["dossierSha256", "outcome", "prUrl", "receiptId", "refusalCode", "sha"]);
  if (row === null || !effectHash(row.dossierSha256) || !effectText(row.receiptId) || !effectSha(row.sha)
    || !nullableText(row.prUrl) || !nullableText(row.refusalCode)
    || (row.outcome !== "RELEASED" && row.outcome !== "REFUSED")) return null;
  // The daemon's decoder already enforces this split; re-checking it here stops a REFUSED
  // receipt that carries a prUrl, or a RELEASED one carrying a code, from reaching an operator.
  if (row.outcome === "RELEASED" ? row.refusalCode !== null : row.prUrl !== null) return null;
  return { dossierSha256: row.dossierSha256, outcome: row.outcome, prUrl: row.prUrl,
    receiptId: row.receiptId, refusalCode: row.refusalCode, sha: row.sha };
}

function evidenceOf(value: unknown): ReleaseEvidenceView | null {
  const row = effectRecord(value, ["ancestryMeasured", "criteria", "goalId", "goalTitle",
    "preview", "receipt", "reviewRounds", "sha"]);
  if (row === null || typeof row.ancestryMeasured !== "boolean" || !effectText(row.goalId)
    || !effectText(row.goalTitle) || !(row.sha === null || effectSha(row.sha))) return null;
  const criteria = effectList(row.criteria, criterionOf, 256);
  const reviewRounds = effectList(row.reviewRounds, roundOf, 256);
  if (criteria === null || reviewRounds === null) return null;
  const preview = row.preview === null ? null : previewOf(row.preview);
  const receipt = row.receipt === null ? null : receiptOf(row.receipt);
  if ((row.preview !== null && preview === null) || (row.receipt !== null && receipt === null)) return null;
  return { ancestryMeasured: row.ancestryMeasured, criteria, goalId: row.goalId,
    goalTitle: row.goalTitle, preview, receipt, reviewRounds, sha: row.sha as string | null };
}

export function mapReleaseAnswer(status: number, body: unknown): ReleaseOutcome {
  const refusal = effectRefusal(body);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalid();
  const refused = effectRecord(body, ["code", "kind", "layer"]);
  if (refused !== null && refused.kind === "REFUSED" && effectText(refused.code) && effectText(refused.layer)) {
    return { status: "REFUSED", code: refused.code, layer: refused.layer };
  }
  const absent = effectRecord(body, ["goalId", "kind"]);
  if (absent !== null && absent.kind === "ABSENT" && effectText(absent.goalId)) {
    return { status: "ABSENT", goalId: absent.goalId };
  }
  const present = effectRecord(body, ["evidence", "kind"]);
  if (present === null || present.kind !== "PRESENT") return invalid();
  const evidence = evidenceOf(present.evidence);
  return evidence === null ? invalid() : { status: "PRESENT", evidence };
}

export async function readRelease(
  headers: Readonly<Record<string, string>>, goalId: string,
): Promise<ReleaseOutcome> {
  const answer = await readEffect(headers, "/release/read", { goalId }, mapReleaseAnswer, LAYER);
  // The read is keyed by goal; an answer about a different goal is a wire fault, never data.
  if (answer.status === "PRESENT" && answer.evidence.goalId !== goalId) return invalid();
  return answer.status === "ABSENT" && answer.goalId !== goalId ? invalid() : answer;
}
