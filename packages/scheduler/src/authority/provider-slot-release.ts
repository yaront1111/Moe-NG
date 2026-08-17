/**
 * The provider-slot release transition (design 427, and 222 for the vocabulary).
 *
 * `SLOT_STATES` has always declared `RELEASED`, but until this module existed no
 * code path in the repository could produce it: `reserveProviderSlot` yields
 * `RESERVED` and `activateProviderSlot` yields `ACTIVE`. This is the only
 * transition that reaches the terminal member.
 *
 * It lives beside `./lease-resource.ts` rather than inside it because that
 * module is already at its focused-file target; the slot family stays reachable
 * from one import through the re-export block there.
 *
 * Three-way honest, mirroring `releaseWork` (`./lease-drain.ts`): a settled slot
 * replays as an acceptance rather than an error, an unsettled one refuses, and
 * only an `ACTIVE` slot transitions. Pure: both inputs are re-parsed from own
 * data properties, the successor is a fresh frozen record, and neither caller
 * record is mutated, frozen, or returned by reference.
 */
import {
  accept,
  deepFreeze,
  exactRecord,
  isRef,
  malformed,
  type AuthorityOutcome,
} from "./authority-kernel.js";
import {
  parseProviderSlot,
  refuse,
  type ProviderSlotReservation,
  type SlotState,
} from "./resource-model.js";

const SLOT_RELEASE_KEYS = ["dimension", "slotRef", "requestId", "attemptRef"] as const;

/** The exact release fact set: the identity being released plus its bound attempt. */
export interface ProviderSlotReleaseCommand {
  readonly dimension: string;
  readonly slotRef: string;
  readonly requestId: string;
  readonly attemptRef: string;
}

/** What a release does to a slot already in each member of the frozen vocabulary. */
type Disposition = "REFUSED" | "RELEASE" | "NO_OP";

/**
 * Exhaustive over `SlotState`: a new member of `SLOT_STATES` cannot be silently
 * skipped here, because `tsc` demands an explicit disposition for it.
 */
const DISPOSITION: Readonly<Record<SlotState, Disposition>> = Object.freeze({
  RESERVED: "REFUSED",
  ACTIVE: "RELEASE",
  RELEASED: "NO_OP",
});

/**
 * Shaped on `parseProviderSlotActivation`: `attemptRef` is required and must be
 * a ref, because a release always names the attempt it is releasing.
 */
function parseRelease(value: unknown): ProviderSlotReleaseCommand | null {
  const parsed = exactRecord(value, SLOT_RELEASE_KEYS);
  if (parsed === null) return null;
  const { attemptRef, dimension, requestId, slotRef } = parsed;
  if (!isRef(dimension) || !isRef(slotRef) || !isRef(requestId)) return null;
  if (!isRef(attemptRef)) return null;
  return { attemptRef, dimension, requestId, slotRef };
}

/** Built field by field, never spread from a caller record. */
function successor(
  slot: ProviderSlotReservation,
  state: SlotState,
): ProviderSlotReservation {
  return deepFreeze({
    dimension: slot.dimension,
    slotRef: slot.slotRef,
    requestId: slot.requestId,
    state,
    // The binding is retained so a settled slot still names the attempt it was
    // released against, and so a replayed command reaches the no-op arm.
    attemptRef: slot.attemptRef,
  });
}

/**
 * Guards run shape -> identity -> attempt binding -> state, so a malformed
 * record can never reach the state check and be reported as a state problem.
 */
export function releaseProviderSlot(
  predecessor: unknown,
  command: unknown,
): AuthorityOutcome<ProviderSlotReservation> {
  const slot = parseProviderSlot(predecessor);
  const release = parseRelease(command);
  if (slot === null || release === null) {
    return malformed("releaseProviderSlot received a malformed slot record or command");
  }
  if (slot.dimension !== release.dimension || slot.slotRef !== release.slotRef) {
    return refuse("release identity does not match the reserved provider slot");
  }
  if (slot.requestId !== release.requestId) {
    return refuse("release names a different request than the reserved provider slot");
  }
  // `attemptRef` is `null` on a slot that was never activated. Null is not a
  // wildcard: releasing against an attempt the slot never carried would leak
  // authority across attempts.
  if (slot.attemptRef !== release.attemptRef) {
    return refuse("release names a different attempt than the provider slot binding");
  }
  // Written so the ONLY accepting arms are the two named dispositions: a state
  // carrying no disposition falls through to a refusal rather than to a
  // release, so a future `SLOT_STATES` member fails closed even before `tsc`
  // forces it into the table above.
  const disposition: Disposition | undefined = DISPOSITION[slot.state];
  if (disposition === "RELEASE") return accept(successor(slot, "RELEASED"));
  if (disposition === "NO_OP") return accept(successor(slot, slot.state));
  return refuse(`a provider slot in state ${slot.state} cannot be released`);
}
