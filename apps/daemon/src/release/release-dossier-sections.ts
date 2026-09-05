import type { DossierInput } from "./release-dossier-contracts.js";

/**
 * The markdown SECTION RENDERERS for the release dossier, and the vocabulary the
 * rows are folded into. Split out of release-dossier.ts to keep both files small;
 * the dependency runs one way (release-dossier.ts imports this, never the reverse).
 *
 * Every list here is sorted by a NAMED key rather than by Map or insertion order:
 * gaps by `criterionId` then `code`, review rounds by `nodeKey` then `round`. The
 * criteria rows arrive already sorted by `criterionId`. Two releases are meant to
 * be diffable, so an iteration-order change must not be able to reorder a dossier.
 */

export type DossierGapCode =
  | "CRITERION_UNCOVERED"
  | "LANDING_ABSENT"
  | "LANDING_NOT_ANCESTOR"
  | "LANDING_UNMEASURABLE"
  | "RECEIPT_ABSENT"
  | "RECEIPT_SHARED_NODE";

export interface DossierGap {
  readonly code: DossierGapCode;
  readonly criterionId: string;
  readonly detail: string;
}

/** One criterion's fully folded evidence chain, ready to render. */
export interface CriterionRow {
  readonly command: string;
  readonly criterionId: string;
  readonly exitCode: string;
  readonly gaps: readonly DossierGap[];
  readonly landing: string;
  readonly nodeKey: string;
  readonly receiptSha: string;
  readonly title: string;
}

/** The single word every unverifiable cell renders as; never a blank, never a drop. */
export const UNKNOWN = "UNKNOWN";

/** Why a citation could not be re-measured, in words, keyed by its stable code. */
export const GAP_SENTENCES: Readonly<Record<DossierGapCode, string>> = Object.freeze({
  CRITERION_UNCOVERED: "no verifying node carries this criterion",
  LANDING_ABSENT: "the verifying node recorded no landing commit",
  LANDING_NOT_ANCESTOR: "the cited landing commit is not an ancestor of this sha",
  LANDING_UNMEASURABLE:
    "git could not decide whether the cited landing commit is an ancestor of this sha",
  RECEIPT_ABSENT: "the verifying node recorded no verifier receipt",
  RECEIPT_SHARED_NODE:
    "the verifying node key is carried by more than one activated plan, so its review ledger is"
    + " shared and its evidence cannot be attributed to this goal",
});

/**
 * Collapse every line break to a space. Ledger text — a goal title, a criterion title,
 * a verifier command — is not trusted to be one line, and this document is EVIDENCE: a
 * value carrying `\n## Acceptance criteria\n...` would inject a forged section or a
 * forged "re-measured as an ancestor" sentence into a dossier a human reads to decide
 * whether to ship. Matches CR, LF and CRLF, not just `\r?\n`.
 */
export function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

/** A table cell can carry a command line; a raw `|` or newline would break the row. */
export function cell(value: string): string {
  return oneLine(value.replace(/\|/gu, "\\|"));
}

/**
 * Code-unit order, deliberately NOT `String.prototype.localeCompare`: a released
 * dossier must sort identically on every host, and ICU collation is locale-sensitive
 * (it orders `-`, `_` and case differently from code units, and differs between
 * locales). Two machines rendering the same facts in a different order would defeat
 * the diffing the stored bytes exist for.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function criteriaSection(rows: readonly CriterionRow[]): readonly string[] {
  if (rows.length === 0) return ["No approved acceptance criteria are recorded for this goal."];
  return [
    "| Criterion | Title | Node | Verifier command | Exit | Receipt sha | Landing sha |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${[
      row.criterionId, row.title, row.nodeKey, row.command, row.exitCode, row.receiptSha,
      row.landing,
    ].map(cell).join(" | ")} |`),
  ];
}

export function gapsSection(rows: readonly CriterionRow[]): readonly string[] {
  const gaps = [...rows.flatMap((row) => row.gaps)]
    .sort((a, b) => byCodeUnit(a.criterionId, b.criterionId) || byCodeUnit(a.code, b.code));
  if (gaps.length === 0) {
    return ["Every cited commit was re-measured as an ancestor of this sha."];
  }
  return [
    "Every citation below could not be re-measured at this sha. It is listed rather than dropped,"
    + " because an omitted row and a verified row are indistinguishable to a reader.",
    "",
    "| Criterion | Code | Why |",
    "| --- | --- | --- |",
    ...gaps.map((gap) => `| ${[gap.criterionId, gap.code, gap.detail].map(cell).join(" | ")} |`),
  ];
}

export function reviewSection(input: DossierInput): readonly string[] {
  const rounds = [...input.reviewRounds]
    .sort((a, b) => byCodeUnit(a.nodeKey, b.nodeKey) || a.round - b.round);
  if (rounds.length === 0) return ["No review rounds are recorded for this goal."];
  return [
    "| Node | Round | Outcome | Refusal code |",
    "| --- | --- | --- | --- |",
    ...rounds.map((round) => `| ${[
      round.nodeKey, String(round.round), round.outcome, round.refusalCode ?? "NONE",
    ].map(cell).join(" | ")} |`),
  ];
}

export function previewSection(input: DossierInput): readonly string[] {
  const preview = input.preview;
  if (preview === null) return ["There is no preview decision for this goal."];
  return [
    `- Decision: ${cell(preview.decisionId)}`,
    `- Outcome: ${cell(preview.outcome)}`,
    `- Decided at: ${cell(preview.decidedAt)}`,
    `- URL: ${preview.url === null ? "NONE" : cell(preview.url)}`,
  ];
}

export function policySection(input: DossierInput): readonly string[] {
  return input.policyRevision === null
    ? ["The daemon measured no installed policy revision."]
    : [`- Installed policy revision: ${cell(input.policyRevision)}`];
}
