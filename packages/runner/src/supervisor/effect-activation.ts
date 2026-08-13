import { canonicalDigest, deepFreeze } from "../canonical.js";
import {
  withLeg,
  SUPERVISOR_ACTIVATION_VERSION,
  type ActivationGrant,
  type AttemptSlice,
  type DependencyWitness,
  type EffectClaim,
  type EffectIntent,
  type SupervisorErrorCode,
  type SupervisorFailure,
} from "./effect-kernel.js";
import {
  activationDigestInput,
  deriveGrantId,
  grantRefusal,
  initialGrantBinding,
  refuseRuntimeObservationDrift,
} from "./effect-grant.js";
import {
  parseAttemptSlice,
  parseDependencyWitness,
  parseEffectClaim,
  parseEffectIntent,
  parseEffectTombstone,
} from "./effect-parse.js";
import {
  exactRecord,
  isCount,
  isDigest,
  isRef,
  readList,
  MAX_SUPERVISOR_COUNT,
} from "./effect-shape.js";
import { fenceMirroredLease } from "./lease-mirror.js";

export {
  activationDigestInput,
  consumeActivationGrant,
  validateActivationCommit,
  type CommitCheck,
  type GrantOutcome,
} from "./effect-grant.js";

/**
 * `effect.activate` — the start-versus-cancel linearization point (design 779).
 *
 * The legs run integrity and identity first, then authority, then content, with
 * the runtime digest last; the first failing leg decides the code, so one
 * refused activation never reports two causes. A refusal carries no successor
 * fields at all, which is what makes "no external action was authorised"
 * structurally true rather than merely documented.
 *
 * The tombstone is an explicit INPUT. A pure function cannot refuse on a record
 * it is never handed, and the remaining half of that race — a tombstone that
 * commits between revalidation and write — is closed by the caller contract's
 * version-bump clause, not by anything this function can observe.
 */
export interface ActivationCommit {
  readonly activationVersion: typeof SUPERVISOR_ACTIVATION_VERSION;
  readonly intent: EffectIntent;
  readonly attempt: AttemptSlice;
  readonly grant: ActivationGrant;
  readonly activationDigest: string;
}

export type ActivationOutcome =
  | { readonly kind: "ACTIVATED"; readonly ok: true; readonly commit: ActivationCommit }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const REQUEST_KEYS = [
  "intent", "attempt", "claim", "tombstone", "leaseProof", "wrapperIdentity", "lockIdentity",
  "observedGraphEpoch", "desiredState", "dependencyWitnesses", "observedRuntimeDigest",
] as const;

const MAX_DEPENDENCY_WITNESSES = 128;

function refuse(code: SupervisorErrorCode, message: string, leg: string | null): ActivationOutcome {
  return grantRefusal(code, leg === null ? "KERNEL" : "ACTIVATION", message, leg);
}

interface ParsedRequest {
  readonly intent: EffectIntent;
  readonly attempt: AttemptSlice;
  readonly claim: EffectClaim;
  readonly tombstoned: boolean;
  readonly leaseProof: unknown;
  readonly wrapperIdentity: string;
  readonly lockIdentity: string;
  readonly observedGraphEpoch: number;
  readonly desiredState: string;
  readonly witnesses: readonly DependencyWitness[];
  readonly observedRuntimeDigest: string;
}

/**
 * The list is the caller's COMPLETE claim about this intent's dependencies. An
 * empty list asserts "this effect has no dependencies"; nothing here can tell
 * that apart from a caller that failed to load them, which is why the witness
 * set is bound to the intent by the store, not reconstructed here.
 */
function parseWitnessList(value: unknown): readonly DependencyWitness[] | null {
  const entries = readList(value, MAX_DEPENDENCY_WITNESSES);
  if (entries === null) {
    return null;
  }
  const witnesses: DependencyWitness[] = [];
  for (const entry of entries) {
    const witness = parseDependencyWitness(entry);
    if (witness === null) {
      return null;
    }
    witnesses.push(witness);
  }
  return witnesses;
}

/** Every refusal here is a shape refusal, so all of them name the kernel layer. */
function parseRequest(value: unknown): ParsedRequest | ActivationOutcome {
  const raw = exactRecord(value, REQUEST_KEYS);
  if (raw === null) {
    return refuse("EFFECT_COMMAND_MALFORMED", "activate request does not parse", null);
  }
  const intent = parseEffectIntent(raw["intent"]);
  if (intent === null) {
    return refuse("EFFECT_INTENT_MALFORMED", "effect intent does not parse", null);
  }
  const attempt = parseAttemptSlice(raw["attempt"]);
  if (attempt === null) {
    return refuse("EFFECT_ATTEMPT_MALFORMED", "attempt slice does not parse", null);
  }
  const claim = parseEffectClaim(raw["claim"]);
  if (claim === null) {
    return refuse("EFFECT_CLAIM_MALFORMED", "effect claim does not parse", null);
  }
  if (raw["tombstone"] !== null && parseEffectTombstone(raw["tombstone"]) === null) {
    return refuse("EFFECT_TOMBSTONE_MALFORMED", "effect tombstone does not parse", null);
  }
  const witnesses = parseWitnessList(raw["dependencyWitnesses"]);
  if (
    witnesses === null ||
    !isRef(raw["wrapperIdentity"]) ||
    !isRef(raw["lockIdentity"]) ||
    !isRef(raw["desiredState"]) ||
    !isCount(raw["observedGraphEpoch"]) ||
    !isDigest(raw["observedRuntimeDigest"])
  ) {
    return refuse("EFFECT_COMMAND_MALFORMED", "activate request does not parse", null);
  }
  return {
    intent,
    attempt,
    claim,
    tombstoned: raw["tombstone"] !== null,
    leaseProof: raw["leaseProof"],
    wrapperIdentity: raw["wrapperIdentity"],
    lockIdentity: raw["lockIdentity"],
    observedGraphEpoch: raw["observedGraphEpoch"],
    desiredState: raw["desiredState"],
    witnesses,
    observedRuntimeDigest: raw["observedRuntimeDigest"],
  };
}

function revalidate(request: ParsedRequest): ActivationOutcome | null {
  const { intent, attempt, claim } = request;
  if (intent.version >= MAX_SUPERVISOR_COUNT || attempt.version >= MAX_SUPERVISOR_COUNT) {
    return refuse("EFFECT_COUNTER_EXHAUSTED", "a version counter is exhausted", "counters");
  }
  if (intent.state !== "ARMED") {
    const message = `intent state ${intent.state} cannot activate`;
    return refuse("ACTIVATION_INTENT_NOT_ARMED", message, "intentState");
  }
  if (
    claim.intentId !== intent.intentId ||
    claim.wrapperIdentity !== request.wrapperIdentity ||
    claim.lockIdentity !== request.lockIdentity
  ) {
    const message = "claim does not bind this wrapper and lock";
    return refuse("ACTIVATION_LOCK_IDENTITY_MISMATCH", message, "lockIdentity");
  }
  if (request.tombstoned) {
    const message = "a terminal tombstone dominates this intent";
    return refuse("EFFECT_TOMBSTONED", message, "tombstoneWitness");
  }
  if (attempt.intentId !== intent.intentId || attempt.aggregateId !== intent.aggregateId) {
    const message = "attempt is not bound to this effect intent";
    return refuse("ATTEMPT_BINDING_MISMATCH", message, "attemptBinding");
  }
  if (attempt.state !== "LAUNCH_REQUESTED") {
    const message = `attempt state ${attempt.state} cannot launch`;
    return refuse("ATTEMPT_NOT_LAUNCH_REQUESTED", message, "attemptState");
  }
  if (request.observedGraphEpoch !== intent.expectedGraphEpoch) {
    const message = "graph epoch is not the expected one";
    return refuse("ACTIVATION_GRAPH_EPOCH_MISMATCH", message, "graphEpoch");
  }
  const fenced = fenceMirroredLease(intent.leaseBinding, request.leaseProof, "effect.activate", [
    "ACTIVE",
  ]);
  if (fenced.kind === "REFUSED") {
    const failure = withLeg(fenced.failure, "leaseFence");
    return Object.freeze({ kind: "REFUSED" as const, failure });
  }
  if (request.desiredState !== intent.desiredState) {
    const message = "desired state does not match the intent";
    return refuse("ACTIVATION_DESIRED_STATE_MISMATCH", message, "desiredState");
  }
  if (request.witnesses.some((witness) => witness.observedDigest !== witness.expectedDigest)) {
    const message = "a dependency witness is not current";
    return refuse("ACTIVATION_DEPENDENCY_WITNESS_STALE", message, "dependencyWitness");
  }
  // Digest strings only, and the SAME comparison the wrapper makes once it has
  // resolved the runtime closure: drift is one string inequality shared by both
  // sites, and the concrete digests never enter the refusal (design 798).
  return refuseRuntimeObservationDrift(
    intent.runtimeObservationDigest,
    request.observedRuntimeDigest,
  );
}

export function activateEffect(requestValue: unknown): ActivationOutcome {
  const parsed = parseRequest(requestValue);
  if ("kind" in parsed) {
    return parsed;
  }
  const refused = revalidate(parsed);
  if (refused !== null) {
    return refused;
  }
  const intent = { ...parsed.intent, state: "ACTIVE" as const, version: parsed.intent.version + 1 };
  const attempt = {
    ...parsed.attempt,
    state: "RUNNING" as const,
    version: parsed.attempt.version + 1,
  };
  const binding = initialGrantBinding(intent.intentId, parsed.wrapperIdentity);
  const activationDigest = canonicalDigest(activationDigestInput(intent, attempt, binding));
  const grant = {
    grantId: deriveGrantId(intent.intentId, activationDigest),
    intentId: intent.intentId,
    wrapperIdentity: parsed.wrapperIdentity,
    state: "UNUSED" as const,
    version: 0,
  };
  return deepFreeze({
    kind: "ACTIVATED" as const,
    ok: true as const,
    commit: {
      activationVersion: SUPERVISOR_ACTIVATION_VERSION,
      intent,
      attempt,
      grant,
      activationDigest,
    },
  });
}
