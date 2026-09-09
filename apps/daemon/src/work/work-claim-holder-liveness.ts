import type { SqliteEventStore } from "@moe/store";

import { readSessionLedger } from "../identity/session-read-model.js";

/**
 * Does the principal holding a work claim still have a LIVE seat?
 *
 * This is the one fact the work-claim surface cannot answer for itself. A seat
 * claims under its OWN bearer (agent-wrapper.ts), so `claimedBy` is the seat's
 * session id and the secret that could release the claim lives only inside the
 * wrapper's child process. Kill the wrapper and nothing on the board can release
 * that item until the claim's own 30-minute expiry — the operator included.
 *
 * Session liveness is NOT process liveness and deliberately is not treated as
 * such here: the seat session's TTL is derived from the agent lifetime, so a
 * killed seat reads OPEN until someone CLOSES it. The wrapper's reclaim pass
 * closes the dead seat's session first and only then releases, so this predicate
 * stays a pure read over durable session facts with no probe of the host.
 *
 * Answers `null` — never `false` — when the ledger cannot be trusted. Corrupt or
 * unreadable bytes are not evidence that nobody is home, and the caller fails
 * closed on `null` exactly as it does on `true`.
 *
 * Lives beside the claim services rather than inside them so that file stays
 * under the per-file line cap; `identity/session-read-model.ts` imports nothing
 * from `work/`, so this edge introduces no cycle.
 */
export function holderHasLiveSession(
  store: SqliteEventStore,
  projectId: string,
  claimant: string,
  decidedAt: string,
): boolean | null {
  let ledger: ReturnType<typeof readSessionLedger>;
  try {
    ledger = readSessionLedger(store, projectId);
  } catch {
    return null;
  }
  if (ledger.unreadable) return null;
  for (const record of ledger.sessions.values()) {
    // A seat's working principal IS its session id (session-authenticator), but
    // an operator-held claim names the opener instead, so both keys are matched
    // — the same pairing `http/sessions-read.ts` uses to attribute holdings.
    if (record.sessionId !== claimant && record.principalId !== claimant) continue;
    if (record.status !== "OPEN") continue;
    // Both instants are canonical fixed-width ISO, so lexicographic order is
    // time order — the same comparison `activeClaim` makes. Expiry is exclusive.
    if (record.expiresAt > decidedAt) return true;
  }
  return false;
}
