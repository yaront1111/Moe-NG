import { canonicalDigest, deepFreeze } from "../canonical.js";
import {
  supervisorFailure,
  type ActivationGrant,
  type AttemptSlice,
  type EffectIntent,
  type SupervisorErrorCode,
  type SupervisorFailure,
  type SupervisorLayer,
} from "./effect-kernel.js";
import { parseActivationGrant, parseAttemptSlice, parseEffectIntent } from "./effect-parse.js";
import { isRef } from "./effect-shape.js";

/**
 * The one-use activation grant and the partial-commit detector.
 *
 * The grant id is DERIVED from the activation it belongs to, never minted: a
 * replayed activation of the same records reproduces the same id, so the store's
 * uniqueness index can reject the duplicate. A random id would let every replay
 * look like a fresh, legitimate activation.
 *
 * What this module honestly cannot do is detect a replay by itself. Handed the
 * same stale `UNUSED` record twice it consumes it twice, because a pure function
 * has no memory of the first call. Replay is refused by the caller's
 * compare-and-set, by grant-id uniqueness in the store, and by the OS-exclusive
 * launch lock — the grant is the logical linearization token, not the backstop.
 */
export type GrantOutcome =
  | {
      readonly kind: "CONSUMED";
      readonly ok: true;
      readonly grant: ActivationGrant;
      readonly versionDelta: 1;
    }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

export type CommitCheck =
  | { readonly kind: "COHERENT"; readonly ok: true; readonly activationDigest: string }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

export function grantRefusal(
  code: SupervisorErrorCode,
  layer: SupervisorLayer,
  message: string,
  leg: string | null = null,
): { readonly kind: "REFUSED"; readonly failure: SupervisorFailure } {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: supervisorFailure(code, layer, message, { state: null, command: null, leg }),
  });
}

/**
 * The identity-free grant binding the activation digest covers. The grant id is
 * excluded because it is derived from that digest, and a digest that covered its
 * own output could not be computed at all.
 */
export function initialGrantBinding(
  intentId: string,
  wrapperIdentity: string,
): Record<string, unknown> {
  return { intentId, wrapperIdentity, state: "UNUSED", version: 0 };
}

/** Exported so a consumer can re-verify a stored commit without rebuilding the field list. */
export function activationDigestInput(
  intent: EffectIntent,
  attempt: AttemptSlice,
  grantBinding: Record<string, unknown>,
): Record<string, unknown> {
  return { intent, attempt, grant: grantBinding };
}

export function deriveGrantId(intentId: string, activationDigest: string): string {
  return canonicalDigest({ activationDigest, intentId });
}

export function consumeActivationGrant(
  grantValue: unknown,
  wrapperIdentity: unknown,
): GrantOutcome {
  const grant = parseActivationGrant(grantValue);
  if (grant === null) {
    return grantRefusal("EFFECT_GRANT_MALFORMED", "KERNEL", "activation grant does not parse");
  }
  if (!isRef(wrapperIdentity) || wrapperIdentity !== grant.wrapperIdentity) {
    return grantRefusal(
      "GRANT_WRAPPER_MISMATCH",
      "GRANT",
      "this grant is bound to a different wrapper",
    );
  }
  if (grant.state === "CONSUMED") {
    return grantRefusal("GRANT_ALREADY_CONSUMED", "GRANT", "this grant has already been used");
  }
  return deepFreeze({
    kind: "CONSUMED" as const,
    ok: true as const,
    grant: { ...grant, state: "CONSUMED" as const, version: grant.version + 1 },
    versionDelta: 1 as const,
  });
}

/**
 * Machine-checks the together-or-neither invariant on records read back after a
 * restart. A rehydrating caller cannot see the transaction that wrote them, so
 * it needs a way to ask whether what it found is a whole commit or half of one.
 */
export function validateActivationCommit(
  effectValue: unknown,
  attemptValue: unknown,
  grantValue: unknown,
): CommitCheck {
  const intent = parseEffectIntent(effectValue);
  if (intent === null) {
    return grantRefusal("EFFECT_INTENT_MALFORMED", "KERNEL", "effect intent does not parse");
  }
  const attempt = parseAttemptSlice(attemptValue);
  if (attempt === null) {
    return grantRefusal("EFFECT_ATTEMPT_MALFORMED", "KERNEL", "attempt slice does not parse");
  }
  const grant = parseActivationGrant(grantValue);
  if (grant === null) {
    return grantRefusal("EFFECT_GRANT_MALFORMED", "KERNEL", "activation grant does not parse");
  }
  const incoherent = (message: string): CommitCheck =>
    grantRefusal("ACTIVATION_COMMIT_INCOHERENT", "ACTIVATION", message);
  if (intent.state !== "ACTIVE" || attempt.state !== "RUNNING") {
    return incoherent("an activation commit pairs an ACTIVE effect with a RUNNING attempt");
  }
  if (attempt.intentId !== intent.intentId || attempt.aggregateId !== intent.aggregateId) {
    return incoherent("the attempt is not bound to this effect intent");
  }
  if (grant.intentId !== intent.intentId) {
    return incoherent("the grant is not bound to this effect intent");
  }
  const activationDigest = canonicalDigest(
    activationDigestInput(
      intent,
      attempt,
      initialGrantBinding(intent.intentId, grant.wrapperIdentity),
    ),
  );
  if (grant.grantId !== deriveGrantId(intent.intentId, activationDigest)) {
    return incoherent("the grant id does not derive from these successors");
  }
  return Object.freeze({ kind: "COHERENT" as const, ok: true as const, activationDigest });
}
