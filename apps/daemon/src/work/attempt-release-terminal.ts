/**
 * THE TERMINALITY A RELEASE CARRIES, AND WHERE IT MAY COME FROM.
 *
 * `effectsTerminal` and `resourcesTerminal` are the two release facts that exist
 * specifically so an agent cannot declare its own effects and resources finished.
 * While task-6d400781's producer was pending, `recordAttemptRelease` RELAYED both
 * caller flags straight into the kernel; the producer has landed, so this module
 * retires that relay and makes the fields unrepresentable on the request instead.
 * It is the sibling of `./attempt-release-boundary.js`, which did the same for
 * `safeBoundaryObserved` against its own producer, and the shape is deliberately
 * the same one.
 *
 * TWO DECISIONS LIVE HERE AND NOTHING ELSE.
 *
 * 1. EXACT-RECORD ADMISSION. A request carrying EITHER key is REFUSED — with any
 *    value, `undefined` included, and whether or not the value happens to agree
 *    with the durable answer. Ignoring a key would be the same call from the
 *    caller's side as honouring it, and refusing only on MISMATCH would still
 *    leave an agreeing caller's flag reaching the kernel as authority. The
 *    refusal is this daemon's own decision, taken BEFORE any store read, so it
 *    carries `ATTEMPT_RELEASE_REQUEST_MALFORMED` under this module's layer.
 *
 * 2. DERIVATION BY COMPOSITION. Both flags come from
 *    `deriveReleaseTerminalEvidence`, which enumerates the attempt's effects from
 *    the terminal-effect ledger and its resources from the attempt-resource
 *    authority, and answers true for a family only when every enumerated item is
 *    terminal AND at least one was enumerated. NOTHING HERE RE-JUDGES AN ITEM. A
 *    second opinion over the same rows would drift from the producer's the first
 *    time either changed, and the whole point of the fields is that exactly one
 *    place decides them.
 *
 * THE PRODUCER'S RECORDED SEMANTICS ARE HONOURED, NOT REINTERPRETED. An empty
 * family answers FALSE — absence of proof is not proof — so an attempt that
 * legitimately bound no resources drains rather than releases. That was decided
 * where terminality is decided; a carrier that read it the other way would be a
 * second definition wearing a composition's clothes.
 *
 * FAIL CLOSED. An item whose state cannot be READ makes the whole answer UNKNOWN,
 * and an UNKNOWN is a refusal, never a `false`: "the ledger says this effect is
 * not terminal" and "nobody can tell what this effect is" demand opposite
 * repairs, and collapsing them would let an unreadable row drain a release that
 * should have been investigated — or, worse the other way, release one nothing
 * proved finished. The producer's own code and layer are carried verbatim; its
 * `upstream` code rides along as the message so the ORIGINAL refuser survives
 * both hops.
 */

import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { carryTerminalRefusal, refuse } from "./attempt-release-store.js";
import type { AttemptReleaseRefused } from "./attempt-release-store.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { deriveReleaseTerminalEvidence } from "./release-terminal-evidence.js";

/** The retired keys. Named once, so the admission and the header cannot drift. */
export const RETIRED_TERMINAL_KEYS: readonly string[] = Object.freeze([
  "effectsTerminal", "resourcesTerminal",
]);

/**
 * EXACTLY the two keys the kernel wants, and nothing else — `ok` is deliberately
 * NOT a member of this record. `releaseWork` parses an exact seven-key request,
 * so this value is SPREAD into that record and a third key here would refuse
 * every release as malformed.
 *
 * Keeping the pair in one frozen record is also what removes the per-key write
 * site at the kernel seam: with two loose booleans there is a place to transpose
 * them that neither the type system nor the kernel can see, because the kernel
 * ANDs the settle facts and the durable row records neither flag. With the pair
 * travelling together there is nowhere left to write the swap except here, where
 * a fixture with one flag false and the other true catches it.
 */
export interface ReleaseTerminalFlags {
  readonly effectsTerminal: boolean;
  readonly resourcesTerminal: boolean;
}

export interface DerivedReleaseTerminal {
  readonly flags: ReleaseTerminalFlags;
  readonly ok: true;
}
export type ReleaseTerminalDerivation = AttemptReleaseRefused | DerivedReleaseTerminal;

/**
 * OWN-PROPERTY PRESENCE over BOTH keys, not a truthiness or `undefined` test:
 * `{effectsTerminal: undefined}` is a caller that tried to speak about the
 * attempt's effects and must hear the same refusal as one that claimed `true`.
 * `in` and `Reflect.has` walk the prototype chain, so a hostile prototype could
 * answer for an honest request; `hasOwnProperty.call` cannot be answered from
 * above.
 *
 * NOT TOTAL OVER `unknown`, and that is deliberate rather than an oversight.
 * `carriesBoundaryClaim` is the FIRST statement of the release path and already
 * refuses every non-object under the same code, so a second total predicate here
 * would carry an arm no honest fixture could ever reach — and an unreachable arm
 * still reads as coverage. The parameter type is what records that ordering
 * requirement for the next editor.
 */
export function carriesTerminalClaim(request: object): boolean {
  return RETIRED_TERMINAL_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(request, key));
}

/**
 * The terminality for THIS attempt, derived from what the ledgers durably hold.
 *
 * The identity is composed from the DURABLE ACTIVATION and the bound project —
 * never from a caller — and the producer admits an exact `{attemptRef, projectId}`
 * record, so there is no channel here for a caller to name another attempt's
 * evidence or to smuggle a flag in beside the identity.
 */
export function deriveReleaseTerminal(
  store: SqliteEventStore, bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
): ReleaseTerminalDerivation {
  const evidence = deriveReleaseTerminalEvidence(store, {
    attemptRef: durable.attempt.attemptId, projectId: bound.projectId,
  });
  if (!evidence.ok) return carryTerminalRefusal(evidence);
  return Object.freeze({
    flags: Object.freeze({
      effectsTerminal: evidence.effectsTerminal,
      resourcesTerminal: evidence.resourcesTerminal,
    }),
    ok: true as const,
  });
}

/** The admission's refusal, kept beside the predicate so a reader sees the code
 *  and the rule that raises it together. */
export const refuseTerminalClaim = (): AttemptReleaseRefused =>
  refuse("ATTEMPT_RELEASE_REQUEST_MALFORMED");
