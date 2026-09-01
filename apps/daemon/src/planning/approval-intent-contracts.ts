/**
 * The wire contract for `approval.decide_intent` — the daemon-owned approval seam (task-6646f888).
 *
 * A DEPENDENCY-FREE module on purpose, following the idiom every other non-bootstrap kind already
 * uses (`activation-ingress-contracts.ts`, `journal-contracts.ts`, `event-resume-command.ts`):
 * `daemon-command-vocabulary.ts` must read the kind and its exact payload roster without importing
 * the seam that enforces them, so the advertised roster and the enforced one stay one constant
 * rather than two copies that can drift apart while both look right.
 */

/** The FROZEN runtime vocabulary kind (`runtime-vocabulary.ts:86`), never a new one. */
export const APPROVAL_DECIDE_INTENT_COMMAND_KIND = "approval.decide_intent" as const;

/**
 * IDENTITY AND INTENT ONLY, and the exactness IS the guarantee this seam exists to provide.
 *
 * `activation`, `record`, `truthClass`, every hash, `stepUpAuthRef` and any principal or time are
 * UNREPRESENTABLE on this wire: the seam refuses an unlisted key rather than trimming it, because
 * trimming is how a caller-chosen authority gets in while every "it refused" arm stays green.
 * `dependencyChanges` is REQUIRED human-authored data; an explicit empty tuple is the human's
 * assertion that approval changes no dependencies, never a default the daemon may synthesize.
 * Sorted, because the seam compares against this list.
 */
export const APPROVAL_INTENT_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "decision", "decisionReason", "dependencyChanges", "runId",
]);
