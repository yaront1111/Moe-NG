/**
 * THE RELEASE EVIDENCE ANSWER: for one goal, the criterion rows a release decision rests on
 * and the receipt of the decision if one has been taken. `release-read.ts` is the HTTP edge in
 * front of this; the derivation lives here so both it and a test can reach it without a socket.
 *
 * WHY THIS DERIVES RATHER THAN SERVING THE STORED DOSSIER. `ReleaseDossierV1` keeps only the
 * rendered MARKDOWN, and the decide edge only records that document when the evidence is
 * COMPLETE — `release-production-wiring.ts` returns its facts without recording whenever
 * `releaseDossierGaps(...)` is non-empty. So the goals with unverified evidence, the ones whose
 * UNKNOWN count an operator most needs before approving, have no stored dossier at all. A read
 * that served stored documents would answer ABSENT for exactly those and PRESENT for the
 * uninteresting rest. It derives from `criterionRows` instead — the same function the markdown
 * and the RELEASE_EVIDENCE_INCOMPLETE detail come from, so the card, the PR body and the
 * refusal cannot disagree about what is missing.
 *
 * THE UNKNOWN DISTINCTION IS THE PRODUCT AND IT IS PRESERVED PER ROW. Each row carries its own
 * `gaps`, never a boolean and never a summed pair. A count computed here would be a second
 * authority the card could drift from, and a flattened row cannot say WHICH citation failed or
 * why — which is the whole reason the dossier renders UNKNOWN and LISTS it rather than dropping
 * the criterion.
 *
 * ABSENT IS NOT A REFUSAL, the same distinction `preview-read.ts` draws. A goal with nothing
 * published answers `ABSENT`; a receipt that will not decode answers `REFUSED` with its code.
 * A card that cannot tell them apart shows an error for the ordinary case.
 *
 * READ-ONLY. Nothing here commits, records or decides — in particular it never calls
 * `recordReleaseDossier`, which the decide edge does as a side effect of its own facts read.
 * A write from here would move the release aggregate under the `expectedVersion` a live
 * affordance offer is holding, and a write onto the goal id would drop the goal out of
 * `durableGoals` entirely with nothing thrown.
 */
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { decisionsOf } from "../decision-ledger-memo.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { criterionRows } from "../release/release-dossier.js";
import type { CriterionRow } from "../release/release-dossier.js";
import type {
  AncestryPredicate, DossierPreviewDecision, DossierReviewRound,
} from "../release/release-dossier-contracts.js";
import { readReleaseDossierInput } from "../release/release-durable-facts.js";
import { readReleaseReceipt } from "../release/release-receipt-ledger.js";
import {
  RELEASE_RECEIPT_COMMAND_KIND, RELEASE_RECEIPT_PRINCIPAL_ID,
} from "../release/release-receipt-contracts.js";
import type { ReleaseReceiptV1 } from "../release/release-receipt-contracts.js";
import { readRunGoalPublication } from "./run-goal-publication.js";

/** Module-private, and deliberately named `LAYER` rather than `RELEASE_READ_LAYER`: this is a
 *  route's own answer stamp, not a security-boundary constant, and the boundary roster's
 *  `[A-Z0-9_]+(?:LAYER|LAYERS|BOUNDARIES)` shape is reserved for the latter. Same spelling
 *  discipline as `preview-read.ts`, `design-read.ts` and `environments-read.ts`. */
const LAYER = "RELEASE_READ" as const;

/** Every refusal this route can answer. Closed, so a consumer can switch exhaustively. */
export const RELEASE_READ_CODES = Object.freeze([
  "RELEASE_READ_CAPABILITY_DENIED",
  "RELEASE_READ_RECEIPT_UNREADABLE",
] as const);

export type ReleaseReadCode = (typeof RELEASE_READ_CODES)[number];

/** The one page of the decision ledger this reader walks, matching `preview-read`'s. */
const RECEIPT_LEDGER_PAGE_SIZE = 512;

/** EXACTLY what a release card is told about a decision. `projectId` and `version` are withheld. */
export interface ReleaseReceiptProjection {
  /** sha256 of the dossier markdown that became the PR body; the operator's evidence anchor. */
  readonly dossierSha256: string;
  readonly outcome: ReleaseReceiptV1["outcome"];
  readonly prUrl: string | null;
  readonly receiptId: string;
  readonly refusalCode: ReleaseReceiptV1["refusalCode"];
  readonly sha: string;
}

/** What an operator is shown before deciding. Rows keep their own gaps; nothing is summed. */
export interface ReleaseEvidenceProjection {
  /**
   * FALSE when the daemon has no bound workspace to re-measure landings against. Every row's
   * landing then reads UNKNOWN for a reason that is NOT the criterion's fault, and a card that
   * could not tell the two apart would tell an operator their evidence had failed when in
   * truth nothing measured it.
   */
  readonly ancestryMeasured: boolean;
  readonly criteria: readonly CriterionRow[];
  readonly goalId: string;
  readonly goalTitle: string;
  readonly preview: DossierPreviewDecision | null;
  readonly receipt: ReleaseReceiptProjection | null;
  readonly reviewRounds: readonly DossierReviewRound[];
  /**
   * The PUSHED publication sha this evidence is re-measured at, and the one a decide names —
   * or NULL when nothing has been published yet. Null is an ordinary state, not a fault: the
   * release offer appears as soon as a commit LANDS, which is earlier than publication, so a
   * card that could only render after a push would be blank exactly when the operator opens it
   * to ask what is missing. With no sha there is nothing to re-measure landings against, so
   * `ancestryMeasured` is false and every landing reads UNKNOWN while the RECEIPT evidence,
   * which does not depend on a sha, still reads true.
   *
   * ONE SHA AUTHORITY. It is `readRunGoalPublication`'s, the same one `goal-deployment-read`
   * uses and the same one the card puts in the `release.decide` payload. This module does NOT
   * invent a goal-level sha from node landings when the publication has none: a second
   * derivation is how a read and the command it feeds come to disagree about which release is
   * being decided.
   */
  readonly sha: string | null;
}

export type ReleaseReadAnswer =
  | Readonly<{ readonly goalId: string; readonly kind: "ABSENT" }>
  | Readonly<{ readonly evidence: ReleaseEvidenceProjection; readonly kind: "PRESENT" }>
  | Readonly<{
    readonly code: ReleaseReadCode;
    readonly kind: "REFUSED";
    readonly layer: typeof LAYER;
  }>;

export interface ReleaseReadInput {
  readonly goalId: string;
  readonly projectId: string;
}

/** Closed over a store by tests and by the composition sibling; this module opens none. */
export interface ReleaseReadPort {
  read(input: ReleaseReadInput): ReleaseReadAnswer;
}

/**
 * How a landing is re-measured against the release sha. A SEAM, not a git call: the daemon's
 * production predicate shells out to `git merge-base --is-ancestor` from the bound workspace,
 * and a null answer means there is no workspace or the sha names no commit. Held as a
 * parameter so this module stays pure and a test can drive every verdict without a repository.
 */
export type AncestryFactory = (sha: string) => AncestryPredicate | null;

/** Nothing measured: every landing is UNMEASURABLE, which is what UNKNOWN already means. */
const UNMEASURED: AncestryPredicate = () => "UNMEASURABLE";

/** Exported because the HTTP edge answers CAPABILITY_DENIED before it ever reaches the port. */
export const releaseReadRefusal = (code: ReleaseReadCode): ReleaseReadAnswer =>
  Object.freeze({ code, kind: "REFUSED" as const, layer: LAYER });

/** Named members only: a key the receipt grows later cannot leak through this projection. */
function projectionOf(receipt: ReleaseReceiptV1): ReleaseReceiptProjection {
  return Object.freeze({
    dossierSha256: receipt.dossierSha256,
    outcome: receipt.outcome,
    prUrl: receipt.prUrl,
    receiptId: receipt.receiptId,
    refusalCode: receipt.refusalCode,
    sha: receipt.sha,
  });
}

/**
 * THE GOAL'S RECEIPT, BY LEDGER WALK RATHER THAN BY ID — and the difference is the REFUSED
 * receipt. `releaseReceiptId` HASHES the outcome and the refusal code, so an id-keyed read has
 * to already know which of the three codes a refusal carried; `goal-deployment-read.ts` reads
 * only the RELEASED id for that reason, which is why a refused release is invisible to the
 * browser today. Each candidate is RE-READ through `readReleaseReceipt`, so a record written
 * under another principal, kind or project can never be answered as this goal's receipt.
 *
 * A later receipt wins. An UNREADABLE one refuses the whole read rather than degrading to
 * "no decision yet": those are different facts to an operator about to decide again.
 */
function receiptForGoal(
  store: SqliteEventStore, input: ReleaseReadInput, sha: string,
): ReleaseReceiptProjection | null | "UNREADABLE" {
  let latest: ReleaseReceiptV1 | null = null;
  let decisions: readonly CommandDecisionRecord[];
  try {
    decisions = decisionsOf(store, RECEIPT_LEDGER_PAGE_SIZE);
  } catch {
    return "UNREADABLE";
  }
  for (const decision of decisions) {
    if (decision.commandKind !== RELEASE_RECEIPT_COMMAND_KIND
      || decision.effectDisposition !== "EFFECTS_COMMITTED"
      || decision.key.projectId !== input.projectId
      || decision.key.principalId !== RELEASE_RECEIPT_PRINCIPAL_ID) continue;
    const read = readReleaseReceipt(store, input.projectId, decision.key.commandId);
    if (!read.ok) {
      if (read.code === "RELEASE_RECEIPT_INVALID") return "UNREADABLE";
      continue;
    }
    if (read.receipt.goalId === input.goalId && read.receipt.sha === sha) latest = read.receipt;
  }
  return latest === null ? null : projectionOf(latest);
}

/**
 * THE PRODUCTION READ, keyed by goal.
 *
 * ABSENT means the goal has no approved scope to show — `readReleaseDossierInput` answers null.
 * That function CONFLATES "no approved Product Contract scope yet" with "its facts could not be
 * read", so this module does NOT invent a distinction its source cannot make and answers the
 * ORDINARY one. REFUSED is reserved for what it can genuinely tell apart: a receipt ledger that
 * will not page, and a committed receipt whose bytes will not decode.
 *
 * AN UNPUBLISHED GOAL STILL ANSWERS PRESENT, with `sha: null`. The release offer is minted as
 * soon as a commit LANDS, which is earlier than publication, so refusing to show evidence
 * before a push would leave the card blank at exactly the moment an operator opens it to ask
 * what is still missing.
 */
export function readReleaseForGoal(
  store: SqliteEventStore, input: ReleaseReadInput, ancestryFor: AncestryFactory,
): ReleaseReadAnswer {
  const absent = Object.freeze({ goalId: input.goalId, kind: "ABSENT" as const });
  let sha: string | null;
  let facts: ReturnType<typeof readReleaseDossierInput>;
  try {
    const publication = readRunGoalPublication(
      store, input.projectId, readPublishLedger(store, input.projectId).get(input.goalId),
    );
    sha = publication?.outcome === "PUSHED" ? publication.sha : null;
    facts = readReleaseDossierInput(store, input.projectId, input.goalId);
  } catch {
    return absent;
  }
  if (facts === null) return absent;
  // The receipt is keyed by the sha, so an unpublished goal cannot have one to find.
  const receipt = sha === null ? null : receiptForGoal(store, input, sha);
  if (receipt === "UNREADABLE") return releaseReadRefusal("RELEASE_READ_RECEIPT_UNREADABLE");
  const ancestry = sha === null ? null : ancestryFor(sha);
  return Object.freeze({
    evidence: Object.freeze({
      ancestryMeasured: ancestry !== null,
      criteria: criterionRows(facts, ancestry ?? UNMEASURED),
      goalId: input.goalId,
      goalTitle: facts.goalTitle,
      preview: facts.preview,
      receipt,
      reviewRounds: facts.reviewRounds,
      sha,
    }),
    kind: "PRESENT" as const,
  });
}

/** The port the listener is composed with. One statement of the read, shared by both callers. */
export function createReleaseReadPort(
  store: SqliteEventStore, ancestryFor: AncestryFactory,
): ReleaseReadPort {
  return Object.freeze({
    read: (input: ReleaseReadInput): ReleaseReadAnswer =>
      readReleaseForGoal(store, input, ancestryFor),
  });
}
