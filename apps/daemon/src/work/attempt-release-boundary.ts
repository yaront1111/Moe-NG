/**
 * THE SAFE BOUNDARY A RELEASE CARRIES, AND WHERE IT MAY COME FROM.
 *
 * `safeBoundaryObserved` is the one release fact that exists specifically so an
 * agent cannot declare its own boundary safe. While task-ded026d6's producer was
 * pending, `recordAttemptRelease` RELAYED the caller's flag straight into the
 * kernel; the producer has landed, so this module retires that relay and makes
 * the field unrepresentable on the request instead.
 *
 * TWO DECISIONS LIVE HERE AND NOTHING ELSE.
 *
 * 1. EXACT-RECORD ADMISSION. A request carrying a `safeBoundaryObserved` key is
 *    REFUSED — with any value, `undefined` included, and whether or not the value
 *    happens to agree with the durable one. Ignoring the key would be the same
 *    call from the caller's side as honouring it, and refusing only on MISMATCH
 *    would still leave an agreeing caller's flag reaching the kernel as
 *    authority. The refusal is this daemon's own decision, taken BEFORE any store
 *    read, so it carries `ATTEMPT_RELEASE_REQUEST_MALFORMED` under this module's
 *    layer.
 *
 * 2. DERIVATION BY COMPOSITION, AND IT ASKS BEFORE IT WRITES. The boundary is
 *    DECIDED by `recordSafeBoundaryObservation`, which reads the durable
 *    provider-run record the host committed and applies its own predicate —
 *    PROVEN truth, an EXITED or SIGNALLED exit, a classified terminal and a
 *    recorded end. That producer runs only on the FIRST observation of an
 *    attempt: a derivation looks the STANDING observation up first and returns it
 *    when one exists, so a re-release reads the answer the first one decided
 *    rather than asking for a second. NOTHING HERE RE-CHECKS AN EXIT FACT, and
 *    lookup-first does not weaken that — the lookup returns a durable row it did
 *    not compose, so exactly one place still DECIDES the boundary. A second
 *    opinion over the same evidence would drift from the producer's the first
 *    time either changed, and the whole point of the field is that it cannot.
 *
 * WHY THE WRITER AND NOT THE READER. `readSafeBoundaryObservation` is keyed by an
 * `observationRef`: a digest the producer derives, under a domain it does not
 * export, from the run record only it has read. A carrier that computed that ref
 * would be reimplementing the producer to ask the producer a question. The writer
 * takes attempt IDENTITY and decision metadata only, derives every boundary fact
 * itself, and is replay-idempotent on a ref-derived aggregate — so a release that
 * runs twice observes once and reads the same durable answer both times.
 *
 * FAIL CLOSED. An absent or unreadable run is a refusal, never a `false`: "the
 * host recorded no run" and "the host watched it fail to exit" demand opposite
 * repairs, and collapsing them would let a missing record drain a release that
 * should have been investigated. The producer's own code and layer are carried
 * verbatim; its `upstreamCode` rides along as the message so the ORIGINAL refuser
 * survives both hops.
 */

import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { carryBoundaryRefusal, refuse } from "./attempt-release-store.js";
import type { AttemptReleaseRefused } from "./attempt-release-store.js";
import { readCurrentSafeBoundaryObservation } from "./attempt-safe-boundary-lookup.js";
import type { SafeBoundaryLookupRefused } from "./attempt-safe-boundary-lookup.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { recordSafeBoundaryObservation } from "./safe-boundary-observation.js";

/** The retired key. Named once, so the admission and the header cannot drift. */
export const RETIRED_BOUNDARY_KEY = "safeBoundaryObserved";

const encoder = new TextEncoder();

export interface DerivedSafeBoundary {
  readonly ok: true;
  readonly safeBoundaryObserved: boolean;
}
export type SafeBoundaryDerivation = AttemptReleaseRefused | DerivedSafeBoundary;

/**
 * OWN-PROPERTY PRESENCE, not a truthiness or `undefined` test:
 * `{safeBoundaryObserved: undefined}` is a caller that tried to speak about the
 * boundary and must hear the same refusal as one that claimed `true`. `in` and
 * `Reflect.has` walk the prototype chain, so a hostile prototype could answer for
 * an honest request; `hasOwnProperty.call` cannot be answered from above.
 *
 * TOTAL over `unknown`. This is the first statement of the release path, and a
 * `null` request reaching a raw property read would CRASH — and a crash is not a
 * fail-closed refusal. A non-object is not a request, so it is refused too.
 */
export function carriesBoundaryClaim(request: unknown): boolean {
  if (typeof request !== "object" || request === null) return true;
  return Object.prototype.hasOwnProperty.call(request, RETIRED_BOUNDARY_KEY);
}

/**
 * The attempt-keyed LOOKUP's refusal, carried out under ITS code and ITS layer and
 * never restamped with this module's — the rule `carryBoundaryRefusal` and
 * `carryTerminalRefusal` already follow, and `source` is the delegate that actually
 * refused (`null` when nothing upstream was consulted).
 *
 * IT LIVES HERE, not beside those two, because `deriveSafeBoundary` is its only
 * consumer — exactly as this module is `carryBoundaryRefusal`'s only importer and
 * `./attempt-release-terminal.js` is `carryTerminalRefusal`'s. Those are
 * single-consumer carriers that happen to be co-located, not a shared vocabulary.
 */
function carryLookupRefusal(refusal: SafeBoundaryLookupRefused): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code: refusal.code,
    message: refusal.source?.code ?? null, ok: false as const, refusedBy: refusal.layer,
  });
}

/**
 * The boundary for THIS attempt, derived from what the host durably recorded.
 *
 * The decision metadata is composed from the bound attempt and the durable
 * activation — never from a caller — and the command id is suffixed so the
 * observation cannot collide with the release decision the same command lands.
 *
 * ASK BEFORE WRITING, AND THIS ORDER IS LOAD-BEARING. The producer commits at
 * `expectedVersion: 0` on a ref-derived aggregate, so the FIRST decision key owns
 * that row: a re-observation under a DIFFERENT key is refused
 * `SAFE_BOUNDARY_COMMIT_CONFLICT` even though it derived byte-identical bytes. A
 * second release over one attempt NECESSARILY carries a different `commandId`, so
 * asking the producer unconditionally refuses exactly the sequence a re-release
 * exists to serve. Looking up first also keeps the common path READ-ONLY: only a
 * first-ever derivation writes.
 *
 * THE SIBLING'S IDENTICAL LOOKUP IS RETAINED, not deduplicated.
 * `attempt-finalization-sources.ts:155-175` fences the same way over the same
 * delegate, and deleting it so this guard becomes the only one would make a mutant
 * of this guard GREEN and read as "no guard needed". The redundancy is the cost of
 * being able to prove this guard refuses on its own.
 *
 * A NON-ABSENT lookup refusal travels out under the LOOKUP's layer rather than
 * falling through: "the standing observation cannot be READ" and "this attempt
 * observed nothing" demand opposite repairs, and letting the producer answer over
 * an unreadable row would overwrite the second with the first.
 */
export function deriveSafeBoundary(
  store: SqliteEventStore, bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
): SafeBoundaryDerivation {
  const { commandId, correlationId, principalId, projectId } = bound;
  const attemptRef = durable.attempt.attemptId;
  const standing = readCurrentSafeBoundaryObservation(store, { attemptRef, projectId });
  if (standing.ok) {
    return Object.freeze({
      ok: true as const, safeBoundaryObserved: standing.observation.safeBoundaryObserved,
    });
  }
  if (standing.code !== "SAFE_BOUNDARY_LOOKUP_ABSENT") return carryLookupRefusal(standing);
  const observed = recordSafeBoundaryObservation(store, {
    attemptRef, correlationId: `${correlationId}:SAFE_BOUNDARY`,
    key: { commandId: `${commandId}:SAFE_BOUNDARY`, principalId, projectId },
    projectId,
    // LENGTH-FRAMED rather than delimiter-joined: a bare separator would map one
    // identity triple onto another whose parts split differently.
    requestBytes: encoder.encode(JSON.stringify([projectId, attemptRef, bound.aggregateId])),
  });
  if (!observed.ok) return carryBoundaryRefusal(observed);
  return Object.freeze({
    ok: true as const, safeBoundaryObserved: observed.observation.safeBoundaryObserved,
  });
}

/** The admission's refusal, kept beside the predicate so a reader sees the code
 *  and the rule that raises it together. */
export const refuseBoundaryClaim = (): AttemptReleaseRefused =>
  refuse("ATTEMPT_RELEASE_REQUEST_MALFORMED");
