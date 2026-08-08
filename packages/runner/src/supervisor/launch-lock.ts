import { deepFreeze, isCanonicalUtcTimestamp } from "../canonical.js";
import {
  supervisorFailure,
  type EffectClaim,
  type SupervisorErrorCode,
  type SupervisorFailure,
  type SupervisorLayer,
} from "./effect-kernel.js";
import { parseEffectClaim } from "./effect-parse.js";
import { exactRecord, isDigest, isRef } from "./effect-shape.js";

/**
 * The launch-lock registration protocol of design 798.
 *
 * Nothing here touches the OS. The exclusive lock, the child process, and its
 * death are FACTS SOMEBODY ELSE OBSERVED and hands in as records; this module
 * only decides what those facts license. That is why `LAUNCH_LOCK_OBSERVED_STATES`
 * has an explicit `UNKNOWN` member instead of a boolean: "we could not tell" is a
 * third answer that must survive into the outcome, not collapse into "released".
 *
 * The bootstrap credential is one-time and is handled ONLY as a digest. It never
 * enters a message, a detail, or an outcome — a refusal that echoed the
 * credential it rejected would hand the caller the very secret the lock exists
 * to protect.
 */
export const LAUNCH_LOCK_OBSERVED_STATES = Object.freeze(["HELD", "RELEASED", "UNKNOWN"] as const);
export type LaunchLockObservedState = (typeof LAUNCH_LOCK_OBSERVED_STATES)[number];

export interface LaunchLockRegistration {
  readonly lockIdentity: string;
  readonly wrapperIdentity: string;
  readonly processIdentity: string;
  readonly bootstrapCredentialDigest: string;
  readonly registeredAt: string;
}

export type LaunchLockOutcome =
  | {
      readonly kind: "REGISTERED";
      readonly ok: true;
      readonly registration: LaunchLockRegistration;
    }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const REGISTRATION_KEYS = [
  "lockIdentity",
  "wrapperIdentity",
  "processIdentity",
  "bootstrapCredentialDigest",
  "registeredAt",
] as const;

/** Shared by every launch-lock-layer surface so one refusal shape serves them all. */
export function launchLockFailure(
  code: SupervisorErrorCode,
  layer: SupervisorLayer,
  message: string,
  command: string,
  state: string | null = null,
): SupervisorFailure {
  return supervisorFailure(code, layer, message, { state, command, leg: null });
}

export function parseLaunchLockRegistration(value: unknown): LaunchLockRegistration | null {
  const parsed = exactRecord(value, REGISTRATION_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["lockIdentity"]) || !isRef(parsed["wrapperIdentity"])) return null;
  if (!isRef(parsed["processIdentity"]) || !isDigest(parsed["bootstrapCredentialDigest"])) {
    return null;
  }
  if (!isCanonicalUtcTimestamp(parsed["registeredAt"])) return null;
  return parsed as unknown as LaunchLockRegistration;
}

/** True when the registration names the same wrapper and lock the claim bound. */
export function bindsClaim(registration: LaunchLockRegistration, claim: EffectClaim): boolean {
  return (
    registration.lockIdentity === claim.lockIdentity &&
    registration.wrapperIdentity === claim.wrapperIdentity
  );
}

/**
 * The one-time bootstrap credential registration of design 798.
 *
 * `prior` is the registration already durable for this lock, supplied by the
 * caller; a pure function has no memory of an earlier call, so re-presentation
 * is only visible when the caller hands over what it stored.
 */
export function registerLaunchLock(
  registrationValue: unknown,
  claimValue: unknown,
  priorValue: unknown,
): LaunchLockOutcome {
  const no = (
    code: SupervisorErrorCode,
    layer: SupervisorLayer,
    message: string,
  ): LaunchLockOutcome =>
    Object.freeze({
      kind: "REFUSED" as const,
      failure: launchLockFailure(code, layer, message, "launchLock.register"),
    });
  const registration = parseLaunchLockRegistration(registrationValue);
  if (registration === null) {
    return no("LAUNCH_LOCK_MALFORMED", "LAUNCH_LOCK", "launch-lock registration does not parse");
  }
  const claim = parseEffectClaim(claimValue);
  if (claim === null) {
    return no("EFFECT_CLAIM_MALFORMED", "KERNEL", "effect claim does not parse");
  }
  const prior = priorValue === null ? null : parseLaunchLockRegistration(priorValue);
  if (priorValue !== null && prior === null) {
    return no("LAUNCH_LOCK_MALFORMED", "LAUNCH_LOCK", "the stored registration does not parse");
  }
  if (!bindsClaim(registration, claim)) {
    return no(
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      "LAUNCH_LOCK",
      "the registration does not bind this wrapper and lock",
    );
  }
  if (prior !== null && prior.bootstrapCredentialDigest === registration.bootstrapCredentialDigest) {
    return no(
      "LAUNCH_LOCK_CREDENTIAL_REUSED",
      "LAUNCH_LOCK",
      "the bootstrap credential is one-time and has already been presented",
    );
  }
  if (prior !== null) {
    return no(
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      "LAUNCH_LOCK",
      "this lock already carries a registration",
    );
  }
  return deepFreeze({ kind: "REGISTERED" as const, ok: true as const, registration });
}
