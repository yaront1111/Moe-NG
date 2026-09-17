import { REVIEW_ROUND_ABSOLUTE_CEILING } from "@moe/review";
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
 * questions per node. Past that, and whenever it cannot produce an answer at all, it STOPS and
 * hands the node back to the human. Both arms exist so this can never do what it was built to
 * stop: spend round after round on a question nothing is resolving.
 *
 * IT USED TO REPLAN THERE, AND THAT DESTROYED WORK. This module previously committed a REPLAN,
 * documented as "progress — the work is re-planned into a successor carrying the findings".
 * Half of that is untrue in the daemon: the REPLAN retires the node, but successor CREATION
 * lives in the control room's two-phase workflow and nothing daemon-side dispatches
 * `goal.create_with_source`. Measured on UnAI 2026-09-16: two nodes were retired 22 ms apart,
 * no successors appeared, and one of them held a node-tree reservation that `moe recover-replan`
 * cannot even see. Worse, the failure being replanned was environmental — the verifier could not
 * migrate ANY node — so each successor would have inherited the same wall and burned its own
 * bound. Parking a node is bad; retiring its work with no replacement is worse, and unlike
 * parking it cannot be undone by answering the question.
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
  /** What the finding was raised against, `KIND:locator`. Part of the question's identity. */
  readonly subject: string;
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

/**
 * Asynchronous because the only real implementation runs a model in a process. A synchronous
 * advisor blocked the wrapper's whole event loop for the length of that call; see the note in
 * `orchestrator/governor-seat.ts`. The type is what keeps a future advisor from doing it again.
 */
export type GovernanceAdvisor = (brief: GovernanceBrief) => Promise<GovernanceAnswer | null>;

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
  /** Governance stopped and left the node for the human. It commits NOTHING on this arm. */
  | {
    readonly kind: "HUMAN_NEEDED";
    readonly why: "BOUND_SPENT" | "LEDGER_UNREADABLE" | "NO_ANSWER" | "ROUND_CEILING";
  }
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
 * The command id binds the subject, the version and the decision word, so a later decision at
 * the same version is a new command rather than a spent id (`REVIEW_COMMAND_ID_SPENT`).
 */
const commandIdOf = (subjectRef: string, version: number, decision: string): string =>
  // The empty subject is deliberate and is not a finding's: this id names the ESCALATION
  // decision, which is about the node and its review version, not about any one finding.
  `gov-${governanceDecisionId({ findingId: decision, findingSubject: "", reviewVersion: version, subjectRef })}`;

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
      // Carried for EVERY subject kind, not just CRITERION: `criterionId` above is null for a
      // NODE or FILE subject, so without this the only thing distinguishing two findings of one
      // rule would be their prose detail, which is not part of a decision's identity.
      subject: `${record.finding.subject.kind}:${record.finding.subject.locator}`,
    }))
    .filter((question) => question.findingId.length > 0 && question.detail.length > 0));
}

function decide(
  deps: GovernanceDeciderDeps,
  subjectRef: string,
  version: number,
  decision: "ALLOW_MORE_ATTEMPTS",
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
export async function decideGovernanceEscalation(
  deps: GovernanceDeciderDeps,
  subjectRef: string,
): Promise<GovernanceOutcome> {
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

  // The daemon refuses ALLOW_MORE_ATTEMPTS outright once the lineage reaches the absolute round
  // ceiling (review-acceptance.ts, REVIEW_ROUND_CEILING_REACHED), and no decision taken here can
  // raise it. Mirrored for the same reason the ACCEPT case above is mirrored: without it,
  // governance spends a real model call per node per pass to produce an answer whose only
  // possible fate is REFUSED, for as long as the node exists.
  if (ledger.rounds.length >= REVIEW_ROUND_ABSOLUTE_CEILING) {
    return { kind: "HUMAN_NEEDED", why: "ROUND_CEILING" };
  }

  const records = createGovernanceDecisionLedger(deps.store, deps.projectId);
  const version = ledger.version;
  // The bound is checked BEFORE the advisor is asked: past it, no answer could be funded anyway,
  // and asking would cost a model call to reach a conclusion already fixed.
  //
  // It counts FUNDED ATTEMPTS, not decisions authored. Counting `GOVERNANCE_DECIDED` rows let a
  // governor that cited the PRD fund attempts for ever at `maxDecisions: 1`, because a citation
  // was free — free of new AUTHORITY, but not of the tokens and repository work an attempt costs,
  // which is the whole thing the bound protects.
  const funded = records.fundedOn(subjectRef);
  // AN UNPROVABLE BOUND IS A SPENT ONE. The ledger used to answer 0 for a store it could not
  // read, so the bound was never reached and governance funded attempt after attempt, each one
  // a real model call against a real repository — the exact runaway the bound exists to stop.
  // Funding is authority, and unverifiable evidence gains none, so this stops for the human.
  if (funded === null) return { kind: "HUMAN_NEEDED", why: "LEDGER_UNREADABLE" };
  if (funded >= deps.policy.maxDecisions) {
    return { kind: "HUMAN_NEEDED", why: "BOUND_SPENT" };
  }

  const questions = openQuestionsOf(ledger);
  // Nothing of this node's own is open, so governance has no question to answer. Not the same
  // case as an advisor that HAD questions and could not answer them, which stops below.
  if (questions.length === 0) return { kind: "NOT_DUE" };
  let answer: GovernanceAnswer | null = null;
  // An advisor that throws is an advisor that did not answer. It must not leave the node parked.
  try {
    answer = await deps.advisor({ questions, reviewVersion: version, subjectRef });
  } catch { answer = null; }
  if (answer === null || answer.guidance.trim().length === 0) {
    return { kind: "HUMAN_NEEDED", why: "NO_ANSWER" };
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
