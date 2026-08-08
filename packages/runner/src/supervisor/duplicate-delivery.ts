import { deepFreeze } from "../canonical.js";
import {
  EFFECT_STATES,
  type EffectClaim,
  type EffectState,
  type SupervisorErrorCode,
  type SupervisorFailure,
  type SupervisorLayer,
} from "./effect-kernel.js";
import { parseEffectClaim } from "./effect-parse.js";
import { exactRecord, oneOf } from "./effect-shape.js";
import {
  bindsClaim,
  launchLockFailure,
  parseLaunchLockRegistration,
  LAUNCH_LOCK_OBSERVED_STATES,
  type LaunchLockObservedState,
  type LaunchLockRegistration,
} from "./launch-lock.js";

/**
 * Design 798: "Duplicate delivery adopts the registered process or exits before
 * provider launch. An uncertain `ARMED`/lock state becomes `SUSPECT` and is
 * never auto-relaunched."
 *
 * There is deliberately no fourth, optimistic arm. Every uncertain reading lands
 * on `SUSPECT`, which is terminal for this decision: the code inside names WHY
 * it is uncertain, but no code turns it back into a launch.
 */
export const DUPLICATE_DELIVERY_KINDS = Object.freeze([
  "ADOPTED",
  "EXIT_BEFORE_LAUNCH",
  "SUSPECT",
] as const);
export type DuplicateDeliveryKind = (typeof DUPLICATE_DELIVERY_KINDS)[number];

/**
 * ADOPTED deliberately carries the three identities adoption needs and NOT the
 * registration record: that record holds the bootstrap credential digest, and an
 * outcome is the wrong place for it. The credential digest exists in exactly one
 * place — the registration the caller supplied and persists — and never travels
 * in a decision this module hands back.
 */
export type DuplicateDeliveryOutcome =
  | {
      readonly kind: "ADOPTED";
      readonly ok: true;
      readonly processIdentity: string;
      readonly lockIdentity: string;
      readonly wrapperIdentity: string;
    }
  | { readonly kind: "EXIT_BEFORE_LAUNCH"; readonly ok: true; readonly launched: false }
  | { readonly kind: "SUSPECT"; readonly failure: SupervisorFailure };

const DELIVERY_KEYS = ["claim", "registration", "lockState", "effectState"] as const;
const COMMAND = "launchLock.duplicateDelivery";

interface ParsedDelivery {
  readonly claim: EffectClaim;
  readonly registration: LaunchLockRegistration | null;
  readonly lockState: LaunchLockObservedState;
  readonly effectState: EffectState;
}

function suspect(
  code: SupervisorErrorCode,
  layer: SupervisorLayer,
  message: string,
  state: string | null = null,
): DuplicateDeliveryOutcome {
  return Object.freeze({
    kind: "SUSPECT" as const,
    failure: launchLockFailure(code, layer, message, COMMAND, state),
  });
}

function exitBeforeLaunch(): DuplicateDeliveryOutcome {
  return deepFreeze({ kind: "EXIT_BEFORE_LAUNCH" as const, ok: true as const, launched: false });
}

function parseDelivery(value: unknown): ParsedDelivery | DuplicateDeliveryOutcome {
  const malformed = (message: string): DuplicateDeliveryOutcome =>
    suspect("LAUNCH_LOCK_MALFORMED", "LAUNCH_LOCK", message);
  const raw = exactRecord(value, DELIVERY_KEYS);
  if (raw === null) {
    return malformed("duplicate-delivery input does not parse");
  }
  const claim = parseEffectClaim(raw["claim"]);
  if (claim === null) {
    return suspect("EFFECT_CLAIM_MALFORMED", "KERNEL", "effect claim does not parse");
  }
  if (!oneOf(raw["lockState"], LAUNCH_LOCK_OBSERVED_STATES)) {
    return malformed("the observed lock state is not a declared one");
  }
  if (!oneOf(raw["effectState"], EFFECT_STATES)) {
    return malformed("the observed effect state is not a declared one");
  }
  const registration =
    raw["registration"] === null ? null : parseLaunchLockRegistration(raw["registration"]);
  if (raw["registration"] !== null && registration === null) {
    return malformed("the stored registration does not parse");
  }
  return { claim, registration, lockState: raw["lockState"], effectState: raw["effectState"] };
}

export function resolveDuplicateDelivery(inputValue: unknown): DuplicateDeliveryOutcome {
  const parsed = parseDelivery(inputValue);
  if ("kind" in parsed) {
    return parsed;
  }
  const { claim, registration, lockState, effectState } = parsed;
  if (registration !== null && !bindsClaim(registration, claim)) {
    return suspect(
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      "LAUNCH_LOCK",
      "the registration on this lock belongs to another wrapper or lock",
      lockState,
    );
  }
  if (lockState === "UNKNOWN" || effectState === "UNKNOWN") {
    return suspect(
      "LAUNCH_LOCK_SUSPECT",
      "LAUNCH_LOCK",
      "an uncertain lock or effect state is never auto-relaunched",
      lockState,
    );
  }
  if (registration === null) {
    // A held lock with nothing registered is not an absence of a process; it is
    // an unidentified one, so it may not be read as "safe to exit and forget".
    return lockState === "HELD"
      ? suspect(
          "LAUNCH_LOCK_REGISTRATION_ABSENT",
          "LAUNCH_LOCK",
          "the lock is held but carries no registration",
          lockState,
        )
      : exitBeforeLaunch();
  }
  if (lockState === "HELD") {
    return deepFreeze({
      kind: "ADOPTED" as const,
      ok: true as const,
      processIdentity: registration.processIdentity,
      lockIdentity: registration.lockIdentity,
      wrapperIdentity: registration.wrapperIdentity,
    });
  }
  // Registered, but the lock is proven released: the registered process is gone.
  // The duplicate still does not launch — resurrecting it is reconciliation's
  // decision, made from durable records, not this delivery's.
  return exitBeforeLaunch();
}
