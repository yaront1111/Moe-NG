/**
 * What a refused or failed daemon answer means, in a person's words. The sentence is the
 * glance; the code and layer stay behind Details (OutcomeNote). A code this table does not
 * know is never guessed.
 */

const CODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ACTIVITY_READ_FAILED: "The decisions could not be read",
  ACTIVITY_READ_GOAL_UNKNOWN: "The daemon does not know this goal",
  APPROVAL_AFFORDANCE_ABSENT: "The daemon is not offering approval for this plan",
  APPROVAL_DISPATCH_FAILED: "The approval never reached the daemon",
  APPROVAL_SURFACE_UNREAD: "The daemon has not said yet whether this can be approved",
  BOOTSTRAP_EXPECTED_VERSION_STALE: "Something changed since this page last read the daemon; it will refresh",
  DOCUMENT_COVERAGE_READ_FAILED: "The PRD coverage could not be read",
  DOCUMENT_COVERAGE_READ_GOAL_UNBOUND: "This goal was created without a PRD",
  GATE1_READ_FAILED: "The Product Contract could not be read",
  GOAL_SOURCE_INVALID: "The PRD bound to this goal did not read back cleanly",
  LISTENER_ACTIVITY_UNAVAILABLE: "The daemon is not serving the decisions ledger",
  LISTENER_POLICY_UNAVAILABLE: "The daemon is not serving the policy read",
  LISTENER_RUNS_UNAVAILABLE: "The daemon is not serving the runs read",
  READ_REFUSED: "The daemon refused the read",
  REVIEW_ESCALATION_NOT_REACHED: "This node has not used every review attempt yet",
  RUNS_READ_FAILED: "The nodes could not be read",
  RUNS_READ_GOAL_UNKNOWN: "The daemon does not know this goal",
  TRANSPORT_REQUEST_FAILED: "The daemon did not answer",
});

export interface RefusalLike {
  readonly code: string;
  readonly layer: string;
  readonly status?: string | undefined;
}

/** "The nodes could not be read" — never the code. */
export function refusalWords(refusal: RefusalLike): string {
  const words = CODE_WORDS[refusal.code];
  if (words !== undefined) return words;
  if (refusal.layer.startsWith("CONTROL_ROOM")) return "Not available from this page yet";
  if (refusal.status === "ERROR") return "This did not complete";
  return "The daemon refused this";
}

/** Provenance a person searches for, shown only behind Details. */
export function refusalProvenance(refusal: RefusalLike): string {
  return `${refusal.code} @ ${refusal.layer}`;
}

/** The tooltip behind a refusal line: the status when known, and the layer that answered. */
export function refusalTitle(refusal: RefusalLike): string {
  return refusal.status === undefined ? refusal.layer : `${refusal.status} at ${refusal.layer}`;
}
