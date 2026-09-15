import type { RepositoryExecutionPhase } from "../repository/repository-execution-contracts.js";

/** What the waiter is told about the node that holds its repository, and why it still holds it. */
export interface RepositoryHolderFacts {
  /** A human-approved attempt is available, so the holder will be staffed again on its own. */
  readonly continuation: boolean;
  /** The holder's review is exhausted or stalled and waits for a human decision. */
  readonly decisionDue: boolean;
  readonly nodeKey: string;
  readonly phase: RepositoryExecutionPhase;
  readonly replanned: boolean;
}

const PHASE_REASONS: Readonly<Partial<Record<RepositoryExecutionPhase, string>>> = Object.freeze({
  AWAITING_LANDING: "its accepted work is landing",
  BLOCKED: "it is blocked until an operator recovers the repository (moe recover-review)",
  CRITERION_VERIFYING: "criterion verification is running",
  EXECUTING: "a coding seat is running",
  LANDING: "its accepted work is landing",
  PUBLISHING: "a release is publishing",
  VERIFYING: "the daemon verifier is checking its submission",
});

/**
 * The waiting line an operator reads (addendum 2026-09-15). On UnAI a sibling waited on
 * "REPOSITORY_EXECUTION_BUSY (active 0)" 283 times with no hint that the holder was waiting for
 * the operator's own escalation decision; the holder and the action are now named.
 */
export function describeRepositoryHolder(facts: RepositoryHolderFacts): string {
  const reason = PHASE_REASONS[facts.phase]
    ?? (facts.replanned ? "it was replanned; run moe recover-replan to release it"
      : facts.decisionDue && !facts.continuation ? "it waits for your escalation decision in the control room"
        : "it keeps uncommitted work between review attempts");
  return `held by node ${facts.nodeKey}: ${reason}`;
}
