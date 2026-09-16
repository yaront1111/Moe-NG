import type { SqliteEventStore } from "@moe/store";

import { createGovernanceDecisionLedger, governanceDecisionId } from "./governance-decision-ledger.js";
import type { GovernanceDecisionInput } from "./governance-decision-ledger.js";
import { GOVERNANCE_PRINCIPAL_ID, governanceOpen } from "./governance-policy-settings.js";
import type { GovernancePolicy } from "./governance-policy-settings.js";
import { REVIEW_SCHEMA_VERSION } from "./review-contracts.js";
import { reviewContinuationAvailable } from "./review-continuation.js";
import { readReviewLedger } from "./review-read-model.js";
import { runReviewCommand } from "./review-services.js";
import { reviewDecisionRequired } from "./review-stall.js";

/**
 * Governance answering an exhausted review in the human's place.
 *
 * WHAT IT REPLACES. A node whose review is exhausted parks until a human presses a button. The
 * node cannot press it for itself, and rightly so — `review-escalation-authority.test.ts` exists
 * to refuse exactly that. So the decision is taken HERE, by the daemon, from the reserved
 * `daemon:governor` seat that no minted session can authenticate as, and only while the owner's
 * policy is open. The node is still never its own judge; it simply no longer waits on a person.
 *
 * WHY IT DECIDES IN-PROCESS RATHER THAN OVER HTTP. The decision has to be a real durable
 * decision row — `readReviewImplementationGuidance` will only feed guidance to the next mission
 * when it finds an `escalation.decide` decision with EFFECTS_COMMITTED whose canonical bytes
 * re-derive. `runReviewCommand` takes the principal as an envelope field and commits through
 * that same seam, so governance produces a decision indistinguishable in authority from the
 * human's own press, without minting a credential for a reserved id.
 *
 * THE BOUND IS THE SAFETY, NOT THE JUDGEMENT. Governance may answer at most `maxDecisions`
 * questions per node. Past that it replans, and it replans whenever it cannot produce an answer
 * at all. Both arms exist so this can never do what it was built to stop: spend round after
 * round on a question nothing is resolving. A REPLAN is progress — the work is re-planned into
 * a successor carrying the findings — so the node is never left parked either way.
 *
 * THE PRD DECIDES FIRST. The advisor is asked to locate the answer in the approved product
 * record before choosing one; a located answer records as `PRD_CITED` and costs the bound
 * nothing. Only genuine silence in the record spends a decision.
 */

/** One open question, as the review's own finding stated it. */
export interface GovernanceQuestion {
  readonly criterionId: string | null;
  readonly detail: string;
  readonly findingId: string;
  readonly severity: string;
}

export interface GovernanceBrief {
  readonly questions: readonly GovernanceQuestion[];
  readonly reviewVersion: number;
  readonly subjectRef: string;
}

/**
 * What governance decided, as the advisor produced it. `guidance` is the text the node's next
 * mission carries; `decisions` is the same answer broken out per question for the record. An
 * advisor that cannot answer returns null, and the node is replanned rather than retried.
 */
export interface GovernanceAnswer {
  readonly decisions: readonly GovernanceDecisionInput[];
  readonly guidance: string;
}

export type GovernanceAdvisor = (brief: GovernanceBrief) => GovernanceAnswer | null;

export interface GovernanceDeciderDeps {
  readonly advisor: GovernanceAdvisor;
  readonly clock: () => string;
  readonly policy: GovernancePolicy | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export type GovernanceOutcome =
  /** The seat is closed: no policy stated, so the human's button is still the only way. */
  | { readonly kind: "CLOSED" }
  /** No decision is due on this node, or its review is already settled. */
  | { readonly kind: "NOT_DUE" }
  /** An attempt is already funded; nothing to decide. */
  | { readonly kind: "ALREADY_FUNDED" }
  /** Governance answered and funded one more attempt. */
  | { readonly kind: "ALLOWED"; readonly decisionIds: readonly string[] }
  /** Governance closed the node to rounds: the bound is spent, or it had no answer. */
  | { readonly kind: "REPLANNED"; readonly why: "BOUND_SPENT" | "NO_ANSWER" }
  /** The durable decision refused; the node stays exactly as it was. */
  | { readonly kind: "REFUSED"; readonly code: string };

/**
 * The envelope reaches `runReviewCommand` as BYTES, not as an object. Its decode runs through
 * `decodeBoundedJsonBytes`, and `isPlainJsonObject` then admits only a null-prototype value —
 * the marker that a payload came from that bounded decoder and nothing else. A plain object
 * handed in directly refuses `REVIEW_REQUEST_INVALID` at ingress, so governance would decide
 * nothing and every node would stay parked with no sign of why.
 */
const encoder = new TextEncoder();

const escalationRefOf = (subjectRef: string, version: number): string =>
  `gov-escalation-${subjectRef}-v${String(version)}`;

/**
 * The command id binds the subject, the version and the decision word, so a REPLAN after a
 * refused ALLOW is a new command rather than a spent id (`REVIEW_COMMAND_ID_SPENT`).
 */
const commandIdOf = (subjectRef: string, version: number, decision: string): string =>
  `gov-${governanceDecisionId({ findingId: decision, reviewVersion: version, subjectRef })}`;

function openQuestionsOf(
  ledger: ReturnType<typeof readReviewLedger>,
): readonly GovernanceQuestion[] {
  const latest = ledger.rounds.at(-1);
  if (latest === undefined) return [];
  // The node's OWN findings only: a finding attributed to another node is that node's to answer,
  // and counting it here would have governance ruling on work it cannot see.
  return Object.freeze(latest.lineage.records
    .filter((record) => record.round === latest.round && record.finding.attributedTo === undefined)
    .map((record) => Object.freeze({
      criterionId: record.finding.subject.kind === "CRITERION" ? record.finding.subject.locator : null,
      detail: record.finding.detail,
      findingId: record.finding.ruleId,
      severity: record.finding.severity,
    }))
    .filter((question) => question.findingId.length > 0 && question.detail.length > 0));
}

function decide(
  deps: GovernanceDeciderDeps,
  subjectRef: string,
  version: number,
  decision: "ALLOW_MORE_ATTEMPTS" | "REPLAN",
  guidance: string | null,
): { readonly code: string; readonly ok: boolean } {
  const outcome = runReviewCommand(deps.store, encoder.encode(JSON.stringify({
    commandId: commandIdOf(subjectRef, version, decision),
    correlationId: "governance",
    decidedAt: deps.clock(),
    expectedVersion: version,
    kind: "escalation.decide",
    payload: {
      decision,
      escalationRef: escalationRefOf(subjectRef, version),
      ...(guidance === null ? {} : { implementationGuidance: guidance }),
      subjectRef,
    },
    principalId: GOVERNANCE_PRINCIPAL_ID,
    projectId: deps.projectId,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  })));
  return outcome.ok ? { code: "COMMITTED", ok: true } : { code: outcome.code, ok: false };
}

/**
 * Answers the escalation on one node, or says why it did not. Every arm is terminal for this
 * pass: governance never leaves a node half-decided, and never retries inside one call.
 */
export function decideGovernanceEscalation(
  deps: GovernanceDeciderDeps,
  subjectRef: string,
): GovernanceOutcome {
  if (!governanceOpen(deps.policy)) return { kind: "CLOSED" };
  let ledger: ReturnType<typeof readReviewLedger>;
  try {
    ledger = readReviewLedger(deps.store, deps.projectId, subjectRef);
  } catch { return { kind: "NOT_DUE" }; }
  if (ledger.unreadable || ledger.replanned || ledger.accepted !== undefined) {
    return { kind: "NOT_DUE" };
  }
  if (reviewContinuationAvailable(ledger)) return { kind: "ALREADY_FUNDED" };
  if (!reviewDecisionRequired(ledger)) return { kind: "NOT_DUE" };
  // The daemon ALSO refuses an escalation whose latest round accepted, or which has no round at
  // all (review-acceptance.ts). Mirroring that here is not defensive duplication: the round
  // counter never goes down, so a node that failed its way past the limit and then passed still
  // reads as "due" for ever. Measured on UnAI 2026-09-16 — round 11 ACCEPT with 5 unsuccessful
  // rounds — governance re-decided it on every pass, spending a governor call each time and
  // having every commit refused REVIEW_ESCALATION_NOT_REACHED.
  const latest = ledger.rounds.at(-1);
  if (latest === undefined || latest.routing.route === "ACCEPT") return { kind: "NOT_DUE" };

  const records = createGovernanceDecisionLedger(deps.store, deps.projectId);
  const version = ledger.version;
  // The bound is checked BEFORE the advisor is asked: past it, no answer would be spent anyway,
  // and asking would cost a model call to reach a conclusion already fixed.
  if (records.spentOn(subjectRef) >= deps.policy.maxDecisions) {
    const replanned = decide(deps, subjectRef, version, "REPLAN", null);
    return replanned.ok
      ? { kind: "REPLANNED", why: "BOUND_SPENT" }
      : { code: replanned.code, kind: "REFUSED" };
  }

  const questions = openQuestionsOf(ledger);
  // Nothing of this node's own is open. Governance has no question to answer, and replanning a
  // node it cannot even name a finding for would retire work on no evidence — a far worse
  // outcome than leaving it to the human. Not the same case as an advisor that had questions
  // and could not answer them, which replans below.
  if (questions.length === 0) return { kind: "NOT_DUE" };
  let answer: GovernanceAnswer | null = null;
  // An advisor that throws is an advisor that did not answer. It must not leave the node parked.
  try {
    answer = deps.advisor({ questions, reviewVersion: version, subjectRef });
  } catch { answer = null; }
  if (answer === null || answer.guidance.trim().length === 0) {
    const replanned = decide(deps, subjectRef, version, "REPLAN", null);
    return replanned.ok
      ? { kind: "REPLANNED", why: "NO_ANSWER" }
      : { code: replanned.code, kind: "REFUSED" };
  }

  const allowed = decide(deps, subjectRef, version, "ALLOW_MORE_ATTEMPTS", answer.guidance);
  if (!allowed.ok) return { code: allowed.code, kind: "REFUSED" };
  // The record is written only after the attempt is actually funded: a decision in the list that
  // never reached the node would be a block the owner could read and the run never obeyed.
  const decisionIds: string[] = [];
  for (const input of answer.decisions) {
    const bound: GovernanceDecisionInput = { ...input, reviewVersion: version, subjectRef };
    if (records.record(bound)) decisionIds.push(governanceDecisionId(bound));
  }
  return { decisionIds: Object.freeze(decisionIds), kind: "ALLOWED" };
}
