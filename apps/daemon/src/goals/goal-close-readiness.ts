/**
 * GOAL CLOSE READINESS — one derived fact, read fresh, never stored.
 *
 * A goal is ready to close only when every approved criterion of its Product Contract is
 * VERIFIED by criterion-specific evidence. A generic NODE_TEST_PASSED leaves criterion
 * coverage EVIDENCE_REQUIRED and cannot satisfy this gate. Both consumers read it here,
 * so the closure precondition
 * (`goal-services.ts`) and the `/affordances/read` offer ladder cannot drift apart and start
 * disagreeing about the same goal — the surface offering a close the command would refuse is
 * exactly the defect this module exists to make impossible.
 *
 * IT IS DERIVED, NEVER RECORDED. Nothing here writes; the answer is recomputed from the
 * coverage read on every request, so an acceptance that lands between two polls is visible on
 * the next one without any invalidation step.
 *
 * A CONTRACT-LESS GOAL IS `NO_CONTRACT`, NOT `NOT_READY`. The seed/Foundation journey has no
 * Product Contract at all — the coverage catalog does not bind its goal, so the read refuses
 * DOCUMENT_COVERAGE_READ_GOAL_UNBOUND — and this gate has nothing to say about it. Mapping that
 * refusal to NOT_READY would silently withdraw `goal.close` from every goal in the repository
 * that predates contracts, which is why it is its own kind rather than a falsy default.
 *
 * EVERY OTHER REFUSAL FAILS CLOSED as `UNREADABLE`. A coverage read that cannot answer is not
 * evidence that the work is done; callers withhold the offer and refuse the command on it.
 */
import type { SqliteEventStore } from "@moe/store";

import { coverageRefused } from "../http/document-coverage-contract.js";
import type {
  DocumentCoverageReadPort, DocumentCoverageReadResult,
} from "../http/document-coverage-contract.js";
import { createDocumentCoverageReadPort } from "../http/document-coverage-read.js";

/** The refusal the coverage catalog answers for a goal it does not bind to any document. */
const GOAL_UNBOUND = "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND";
/** The refusal a coverage read that cannot be completed answers under. */
const UNREADABLE = "DOCUMENT_COVERAGE_READ_UNREADABLE";

export type GoalCloseReadiness =
  /** No approved Product Contract binds criteria to this goal: this gate does not apply. */
  | { readonly kind: "NO_CONTRACT" }
  /** Every one of `criteria` approved criteria is verified. */
  | { readonly kind: "READY"; readonly criteria: number }
  /** `verified` of `criteria` approved criteria are verified; the rest are not. */
  | { readonly kind: "NOT_READY"; readonly criteria: number; readonly verified: number }
  /** The coverage read refused or threw: readiness is unknown, so it is withheld. */
  | { readonly code: string; readonly kind: "UNREADABLE"; readonly layer: string };

const NO_CONTRACT: GoalCloseReadiness = Object.freeze({ kind: "NO_CONTRACT" as const });

function unreadable(code: string, layer: string): GoalCloseReadiness {
  return Object.freeze({ code, kind: "UNREADABLE" as const, layer });
}

function readinessOf(answer: DocumentCoverageReadResult): GoalCloseReadiness {
  if (answer.outcome === "REFUSED") {
    // GOAL_UNBOUND is the contract-less answer, not a failure: it is the ONLY refusal that
    // means "this gate does not apply". Every other one withholds.
    return answer.code === GOAL_UNBOUND ? NO_CONTRACT : unreadable(answer.code, answer.layer);
  }
  const { criteria, verified } = answer.totals;
  // A bound goal whose contracts bind no criteria has nothing this gate can require. Both
  // conditions are checked because they are different states — no contract at all, and a
  // contract carrying an empty criteria set — and neither one has an unverified criterion.
  if (answer.contracts.length === 0 || criteria === 0) return NO_CONTRACT;
  return verified === criteria
    ? Object.freeze({ criteria, kind: "READY" as const })
    : Object.freeze({ criteria, kind: "NOT_READY" as const, verified });
}

/**
 * Readiness over an INJECTED coverage port — pure, and the seam every unit arm drives.
 *
 * The throw guard is not dead code by way of the production port's own try/catch: this function
 * accepts ANY `DocumentCoverageReadPort`, and a caller composing a different one must not be
 * able to turn a thrown read into an offered close.
 */
export function readGoalCloseReadiness(
  coverage: DocumentCoverageReadPort,
  goalId: string,
): GoalCloseReadiness {
  try {
    return readinessOf(coverage.readCoverage({ goalRef: goalId }));
  } catch {
    return unreadable(UNREADABLE, coverageRefused(UNREADABLE).layer);
  }
}

/**
 * The PRODUCTION composition both consumers call: the same coverage port `/documents/coverage`
 * serves, so the readiness the closure gate enforces and the number the coverage screen shows a
 * human are computed by one reader over one ledger walk.
 */
export function goalCloseReadinessFor(
  store: SqliteEventStore,
  projectId: string,
  goalId: string,
): GoalCloseReadiness {
  return readGoalCloseReadiness(createDocumentCoverageReadPort({ projectId, store }), goalId);
}
