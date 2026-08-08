import { deepFreeze } from "../canonical.js";
import {
  drainRank,
  drainTargetOf,
  DRAIN_REASONS,
  DRAIN_TERMINAL_TARGETS,
  type DrainReason,
  type DrainTerminalTarget,
} from "./drain-table.js";
import { supervisorFailure, type SupervisorFailure } from "./effect-kernel.js";
import { exactRecord, oneOf, readList } from "./effect-shape.js";

/**
 * The monotonic `DrainDisposition` of design 348, enforced at ONE source.
 *
 * "Each request unions its reason into `DrainDisposition`; only a higher rank
 * changes the target, no request removes a reason." A weaker later reason is
 * therefore not an error — it joins the set and leaves the target alone. What IS
 * refused is a disposition that has ALREADY downgraded: one whose stored
 * strongest reason is not the strongest member of its own reason set, or whose
 * terminal target disagrees with that reason. A record this module cannot verify
 * as monotonic is refused rather than repaired, because silently recomputing the
 * strongest reason would erase the evidence that something downgraded it.
 */
export interface DrainDisposition {
  readonly reasons: readonly DrainReason[];
  readonly strongestReason: DrainReason;
  readonly terminalTarget: DrainTerminalTarget;
}

export type DispositionOutcome =
  | { readonly kind: "UPGRADED"; readonly ok: true; readonly disposition: DrainDisposition }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const DISPOSITION_KEYS = ["reasons", "strongestReason", "terminalTarget"] as const;

export function dispositionRefusal(message: string, command: string): SupervisorFailure {
  return supervisorFailure("DRAIN_DISPOSITION_NOT_MONOTONIC", "DRAIN", message, {
    state: null,
    command,
    leg: null,
  });
}

/** Shape only; coherence is a separate question with a separate answer. */
export function parseDrainDisposition(value: unknown): DrainDisposition | null {
  const parsed = exactRecord(value, DISPOSITION_KEYS);
  if (parsed === null) return null;
  const reasons = readList(parsed["reasons"], DRAIN_REASONS.length);
  if (reasons === null || reasons.length === 0) return null;
  if (!reasons.every((reason) => oneOf(reason, DRAIN_REASONS))) return null;
  if (!oneOf(parsed["strongestReason"], DRAIN_REASONS)) return null;
  if (!oneOf(parsed["terminalTarget"], DRAIN_TERMINAL_TARGETS)) return null;
  return parsed as unknown as DrainDisposition;
}

/**
 * A disposition is coherent when its stored strongest reason really is the
 * highest-ranked member of its own set and its target is that reason's target.
 * Both halves matter: a target edited on its own would retarget the safe
 * boundary while the reason set still looked untouched.
 */
export function isMonotonicDisposition(disposition: DrainDisposition): boolean {
  if (!disposition.reasons.includes(disposition.strongestReason)) return false;
  const highest = Math.max(...disposition.reasons.map((reason) => drainRank(reason)));
  if (drainRank(disposition.strongestReason) !== highest) return false;
  return disposition.terminalTarget === drainTargetOf(disposition.strongestReason);
}

/** Deterministic union: reasons are emitted in the frozen precedence order. */
function unionReasons(held: readonly DrainReason[], next: DrainReason): readonly DrainReason[] {
  const members = new Set<DrainReason>([...held, next]);
  return DRAIN_REASONS.filter((reason) => members.has(reason));
}

export function upgradeDisposition(
  dispositionValue: unknown,
  reasonValue: unknown,
): DispositionOutcome {
  const command = "drain.upgradeDisposition";
  const no = (message: string): DispositionOutcome =>
    Object.freeze({ kind: "REFUSED" as const, failure: dispositionRefusal(message, command) });
  const disposition = parseDrainDisposition(dispositionValue);
  if (disposition === null) {
    return no("the drain disposition cannot be verified as monotonic");
  }
  if (!isMonotonicDisposition(disposition)) {
    return no("the drain disposition is weaker than its own reason set");
  }
  if (!oneOf(reasonValue, DRAIN_REASONS)) {
    return no("the drain reason is not one the precedence order declares");
  }
  const reasons = unionReasons(disposition.reasons, reasonValue);
  const strongestReason =
    drainRank(disposition.strongestReason) >= drainRank(reasonValue)
      ? disposition.strongestReason
      : reasonValue;
  const terminalTarget = drainTargetOf(strongestReason);
  if (terminalTarget === null) {
    return no("the strongest reason maps to no declared terminal target");
  }
  return deepFreeze({
    kind: "UPGRADED" as const,
    ok: true as const,
    disposition: { reasons, strongestReason, terminalTarget },
  });
}
