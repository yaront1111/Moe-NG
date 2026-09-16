import type { RepositoryExecutionPhase } from "../repository/repository-execution-contracts.js";

/** What the waiter is told about the node that holds its repository, and why it still holds it. */
export interface RepositoryHolderFacts {
  /** The holder's work was accepted, so a BLOCKED holder was stopped inside its landing. */
  readonly accepted: boolean;
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
  BLOCKED: "its seat's shutdown is unproven; Moe resumes it once the runtime that ran it has stopped (a restart does that)",
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
  // A BLOCKED holder resumes once its runtime is gone (owner decision 2026-09-16); only a landing
  // whose Git effect is unknown still needs a person.
  const reason = facts.phase === "BLOCKED" && facts.accepted
    ? "its landing was interrupted and its Git effect is unknown; an operator must reconcile it"
    : facts.replanned && facts.phase === "BLOCKED"
      ? "it was replanned while its seat's shutdown was unproven; Moe releases it once the runtime that ran it has stopped (a restart does that)"
      : PHASE_REASONS[facts.phase]
      ?? (facts.replanned ? "it was replanned; Moe releases it as soon as its seat has closed and its working tree is clean (commit or discard leftover changes)"
        : facts.decisionDue && !facts.continuation ? "it waits for your escalation decision in the control room"
          : "it keeps uncommitted work between review attempts");
  return `held by node ${facts.nodeKey}: ${reason}`;
}
