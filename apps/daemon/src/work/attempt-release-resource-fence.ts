/**
 * THE PRE-RELEASE RESOURCE FENCE.
 *
 * THE SAFETY RULE, and it is the whole module: no release row and no core handoff
 * binding may be written while the attempt's CURRENT resource set is not
 * conclusively terminal. `commitRelease` pins `expectedVersion: 0`, so the first
 * row an attempt's release aggregate receives is the only row it can ever hold. A
 * release taken over a still-movable set therefore writes DRAINING permanently:
 * `resource.reconcile` can terminalise the set a second later and no later write
 * can upgrade that row. Deferring costs a retry; releasing early costs the
 * attempt.
 *
 * NOTHING HERE RE-DERIVES TERMINALITY. `deriveReleaseTerminal` has already asked
 * the producer, whose `provenTerminal` means nonzero AND wholly terminal, and
 * `release-terminal-evidence.ts` forbids a second opinion over the same rows —
 * that is exactly how a QUARANTINED member starts reading as something else. The
 * predicate below reads ONE derived boolean and nothing else.
 *
 * UNKNOWN IS NOT UNPROVEN, AND IT NEVER REACHES HERE. An unreadable resource row,
 * an unreadable horizon or a horizon that moved makes the producer REFUSE, and
 * `recordAttemptRelease` carries that refusal under the PRODUCER's code and layer
 * before this fence is consulted. One stable outcome means one outcome SHAPE; it
 * has never meant one code collapsing four layers.
 *
 * THE FENCE IS AGGREGATE-SCOPED, NOT GLOBAL. `readEventHorizon` moves on ANY
 * write anywhere in the store, so a global re-check before the commit would refuse
 * nearly every release on a busy daemon — a livelock, not a fence. The version
 * guard below watches the ATTEMPT'S OWN resource aggregate, which is the only
 * aggregate whose movement can invalidate the answer this fence just read. The
 * producer's own global-horizon arm stays where it is and is untouched.
 *
 * WHY THE REFUSAL IS THIS DAEMON'S OWN. Refusing to release yet is a precondition
 * decision taken here, in the same class as `refuseTerminalClaim` — not a kernel
 * verdict and not a producer's — so it carries `DAEMON_ATTEMPT_RELEASE`. Its code
 * rides the refusal union rather than joining `ATTEMPT_RELEASE_CODES`, whose
 * header forbids daemon-only additions.
 *
 * NOT OWNED HERE: the post-verification retry that turns a deferral into a release
 * (task-48c79a29) and the scheduler nine-key handoff builder (task-a20e8ef6).
 */

import type { SqliteEventStore } from "@moe/store";

import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { DAEMON_ATTEMPT_RELEASE } from "./attempt-release-store.js";
import type { AttemptReleaseRefused } from "./attempt-release-store.js";
import type { ReleaseTerminalFlags } from "./attempt-release-terminal.js";
import { deriveAttemptResourceAggregateId } from "./attempt-resource-authority-contracts.js";

/** ONE member. It is a vocabulary rather than a bare literal so a consumer can
 *  enumerate it, and so the union in `./attempt-release-store.js` names a type
 *  instead of repeating a string. */
export const ATTEMPT_RELEASE_RESOURCE_FENCE_CODES = Object.freeze([
  "ATTEMPT_RELEASE_RESOURCES_UNPROVEN",
] as const);
export type AttemptReleaseResourceFenceCode =
  (typeof ATTEMPT_RELEASE_RESOURCE_FENCE_CODES)[number];

/**
 * FIXED PROSE, never interpolated. `message` is the one free-text field a refusal
 * may carry, so a resource id, a member count or an aggregate id placed here would
 * leak a durable identifier to every caller that can see a refusal.
 */
export const ATTEMPT_RELEASE_RESOURCES_UNPROVEN_MESSAGE =
  "the attempt's durable resource set is not proven terminal";

/**
 * TRUE when the release must not proceed.
 *
 * It reads `resourcesTerminal` and NOTHING ELSE — not the member list, not the
 * count, not the effects family. The producer already folded "zero members",
 * "absent record", "still ACTIVE" and "QUARANTINED" into this single false, and a
 * second reading of those shapes here would be the drift the evidence module's
 * header forbids.
 */
export function resourcesUnproven(flags: ReleaseTerminalFlags): boolean {
  return !flags.resourcesTerminal;
}

/**
 * The fence's refusal, kept beside the predicate so a reader sees the code and the
 * rule that raises it together. HOISTED, like the store's own carriers: a
 * const-initialised export reached during another module's evaluation is a
 * temporal-dead-zone crash rather than a type error.
 */
export function refuseUnprovenResources(): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const,
    code: "ATTEMPT_RELEASE_RESOURCES_UNPROVEN" as AttemptReleaseResourceFenceCode,
    message: ATTEMPT_RELEASE_RESOURCES_UNPROVEN_MESSAGE, ok: false as const,
    refusedBy: DAEMON_ATTEMPT_RELEASE,
  });
}

/**
 * The head version of the ATTEMPT'S OWN resource aggregate, or `null` when it
 * cannot be read. `null` is not zero: an absent aggregate answers 0 and a store
 * that THREW answers nothing, and collapsing the two would let an unreadable head
 * authorise a release. A crash is not a fail-closed answer, so the throw is
 * converted here rather than escaping.
 *
 * THE AGGREGATE IS DERIVED FROM THE COMMITTED ACTIVATION, never from the caller's
 * `bound.aggregateId`, and by the SAME derivation the production binder uses
 * (`activation-resource-binding.ts`). Watching an aggregate the writer never
 * targets would make this guard a silent no-op that still read as coverage.
 */
export function readAttemptResourceVersion(
  store: SqliteEventStore, durable: ActivationLedgerRecord,
): number | null {
  try {
    return store.getAggregateVersion(deriveAttemptResourceAggregateId(
      deriveActivationAggregateId(
        durable.effectIntent.aggregateId, durable.effectIntent.idempotencyKey)));
  } catch { return null; }
}

/**
 * TRUE when the answer the fence just read can no longer be trusted.
 *
 * `recordAttemptRelease` is fully synchronous, so no in-process interleaving is
 * possible between the evidence read and `commitRelease`; the residual window
 * belongs to a SECOND CONNECTION on the file-backed store — another daemon, a
 * concurrent `resource.reconcile`, a replay. An unreadable head on either side
 * counts as moved, because an unreadable version is not a stable one.
 */
export function resourceVersionMoved(
  captured: number | null, current: number | null,
): boolean {
  return captured === null || current === null || captured !== current;
}
