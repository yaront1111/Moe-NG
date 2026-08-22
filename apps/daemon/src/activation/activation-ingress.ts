import { activateEffect, applyEffectCommand } from "@moe/runner";
import type { EffectIntent, SupervisorFailure } from "@moe/runner";
import { activateProviderSlot } from "@moe/scheduler";
import type { ProviderSlotReservation } from "@moe/scheduler";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  admitClaimPrefix, finishClaim, isRefusal as isWorkRefusal,
} from "../work/work-claim.js";
import type { BudgetLeg, ClaimPrefix } from "../work/work-claim.js";
import type { ClaimSuccessors, WorkResult } from "../work/work-kernel.js";
import { runActivationBudgetStage } from "./activation-budget-stage.js";
import { readActivationEmbargo } from "./activation-embargo.js";
import {
  assembleActivationRecord, commitActivationStage,
} from "./activation-ingress-commit.js";
import type { ActivationStageResult } from "./activation-ingress-commit.js";
import { bindActivationResources } from "./activation-resource-binding.js";
import {
  ACTIVATION_INGRESS_LAYER,
  ACTIVATION_SECTION_KEYS,
  ACTIVATION_SLOT_LAYER,
  activationIngressRefusal,
  decodeActivationRequestBytes,
} from "./activation-ingress-contracts.js";
import type {
  ActivationIngressOutcome,
  ActivationIngressRefused,
  ActivationIngressRequest,
} from "./activation-ingress-contracts.js";
import { deriveSlotOccupancy } from "./activation-slot-occupancy.js";
import type { SlotOccupancyEntry } from "./activation-slot-occupancy.js";

/**
 * `effect.activate` — the daemon's production consumer of the four-leg execution
 * claim and the supervisor activation, fenced by the persisted recovery embargo.
 *
 * STAGE ORDER IS THE CONTRACT, not an implementation detail:
 *
 *   A  envelope decode        structural, and the ONLY stage above the embargo
 *   B  recovery embargo       nothing below runs until it clears
 *   B2 deriveSlotOccupancy    the design-427 table, derived from the durable store
 *   C1 admitClaimPrefix       lease + slot ceiling + slot
 *   C2 durable budget         DERIVED account/amounts/version, plus its ledger leg
 *   C3 finishClaim            the effect leg, and the whole successor closure
 *   D  arm                    CLAIMED -> ARMED, server-owned command
 *   E  activateEffect         ARMED -> ACTIVE, mints the attempt and grant
 *   F  activateProviderSlot   the sole RESERVED -> ACTIVE slot transition
 *   G/H one atomic commit     activation and budget legs together or neither
 *
 * A structurally broken envelope is refused before the embargo is consulted,
 * because a request that cannot be read names no project to fence. Every DOMAIN
 * judgement runs strictly after the embargo clears, so an embargoed request with
 * a broken payload is answered by the embargo — a fence that could be probed by
 * sending deliberate garbage is not a fence.
 *
 * EVERY AUTHORITY INPUT BELOW STAGE C IS SERVER-DERIVED, AND SO IS THE ONE
 * STAGE C COUNTS. The live-claim table the slot ceiling judges is (B2)'s
 * derivation from committed activations minus kernel-settled releases — the
 * caller's `liveClaims` key stays admitted at the envelope and feeds nothing,
 * because a caller-counted ceiling was the design-427 bypass (an empty table
 * admitted a fifth slot). The intent handed to `activateEffect` comes from (D),
 * never from the payload; the slot command is built from (C1)'s own successor
 * and (E)'s own attempt id. A caller can propose an activation; it cannot name
 * the records that authorise one.
 *
 * THE BUDGET IS DURABLE AND NO LONGER THE CALLER'S. (C2) derives the account,
 * the authorized amounts and the fenced version from project/goal/graph/node
 * facts and captures the ledger writer's own leg, which rides (G/H)'s single
 * decision. `payload["budget"]` is still ADMITTED at the envelope — dropping the
 * key would force every sender in the repository to change inside this commit —
 * but on this route only its `gate` is ever read, and that narrowing is enforced
 * by the section shape in `activation-budget-stage.ts`, not by a comment.
 *
 * NOTHING HERE CONSTRUCTS A SUCCESSOR. Each transition is performed by the
 * package that owns the aggregate, and this module only sequences them and
 * persists what they returned.
 */

/** Server-owned, never forwarded: the supervisor also admits CLAIMED -> CANCEL_REQUESTED. */
const ARM_COMMAND = Object.freeze({ kind: "arm" } as const);

const SECTION_KEY_SET: ReadonlySet<string> = new Set(ACTIVATION_SECTION_KEYS);

/** The one payload-fault refusal, built once so four call sites cannot drift. */
const PAYLOAD_MALFORMED = activationIngressRefusal({
  code: "ACTIVATION_INGRESS_PAYLOAD_MALFORMED",
  refusedBy: ACTIVATION_INGRESS_LAYER,
});

function refuseWork(result: WorkResult): ActivationIngressRefused {
  if ("failure" in result) {
    // The work kernel's own code and layer, verbatim. Flattening them would
    // make a stale lease indistinguishable from an exhausted slot ceiling.
    return activationIngressRefusal({
      code: result.failure.code,
      refusedBy: result.failure.layer,
    });
  }
  return PAYLOAD_MALFORMED;
}

function refuseSupervisor(failure: SupervisorFailure): ActivationIngressRefused {
  return activationIngressRefusal({ code: failure.code, refusedBy: failure.layer });
}

/**
 * The exact activation-only key set. `intent` is not in it, so a caller cannot
 * smuggle the one record this ingress derives for itself — and the spread below
 * places the server intent LAST regardless, so even a hole in this fence could
 * not override it.
 */
function readActivationSection(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ACTIVATION_SECTION_KEYS.length) return null;
  if (!keys.every((key) => SECTION_KEY_SET.has(key))) return null;
  return value as Record<string, unknown>;
}

type Stage<T> = ActivationIngressRefused | { readonly value: T };

const isRefusal = <T>(stage: Stage<T>): stage is ActivationIngressRefused => !("value" in stage);

/** (C1) Lease, ceiling and slot — the three legs above the budget's position.
 *  A refusal publishes no successor at all. `held` is (B2)'s durable occupancy
 *  table, fed where the caller's `liveClaims` section once was; the section
 *  itself is inert for the decision. */
function claimPrefixStage(
  request: ActivationIngressRequest,
  held: readonly SlotOccupancyEntry[],
): Stage<ClaimPrefix> {
  const { payload } = request;
  const prefix = admitClaimPrefix({
    budget: payload["budget"],
    effect: payload["effect"],
    lease: payload["lease"],
    liveClaims: held,
    slot: payload["slot"],
  });
  if (isWorkRefusal(prefix)) return refuseWork(prefix);
  return { value: prefix.value };
}

/**
 * (C2) The DURABLE budget, at the position `claimBudget` used to occupy.
 *
 * The position is the point. Deriving this eagerly and passing it into the claim would run it
 * BEFORE the lease leg, so a request with a stale lease AND an unresolvable node would stop
 * answering `WORK_LEASE_NOT_CURRENT` — which is why `work-claim.ts` was split rather than
 * given a budget parameter.
 */
function durableBudgetStage(
  store: SqliteEventStore, request: ActivationIngressRequest, nodeKey: string | undefined,
): Stage<{ readonly budget: BudgetLeg; readonly leg: ExpectedVersionDecisionLeg }> {
  const outcome = runActivationBudgetStage(
    nodeKey === undefined ? { request, store } : { nodeKey, request, store },
  );
  // The derivation's, the projection's or the ledger writer's own code and layer, unrestamped.
  if (!outcome.ok) {
    return activationIngressRefusal({ code: outcome.code, refusedBy: outcome.layer });
  }
  return { value: { budget: outcome.budget, leg: outcome.leg } };
}

/** (C3) The effect leg, and the whole successor closure or none of it. */
function claimTailStage(prefix: ClaimPrefix, budget: BudgetLeg): Stage<ClaimSuccessors> {
  const claimed = finishClaim(prefix, budget);
  if (!claimed.ok) return refuseWork(claimed);
  if (claimed.outcome !== "WORK_GRANTED") return PAYLOAD_MALFORMED;
  return { value: claimed.successors };
}

/** (D) CLAIMED -> ARMED. Its version is the predecessor the activation succeeds. */
function armStage(intent: EffectIntent): Stage<EffectIntent> {
  const armed = applyEffectCommand(intent, ARM_COMMAND);
  if (armed.kind === "TRANSITIONED") return { value: armed.intent };
  if (armed.kind === "REFUSED") return refuseSupervisor(armed.failure);
  // MUST_DRAIN is unreachable here: stage C hands over a CLAIMED intent and the
  // arc table admits CLAIMED -arm-> ARMED. Kept so the function stays total, and
  // reported as a payload fault because that is the only way the effect section
  // could describe an intent this ingress cannot arm.
  return PAYLOAD_MALFORMED;
}

/**
 * The attempt version the request ACTUALLY carried, read as an own data
 * property — the same way `exactRecord` read it inside `activateEffect`.
 *
 * Deriving it as `commit.attempt.version - 1` instead would make the ledger
 * reader's `attempt.version === predecessor + 1` check true by construction,
 * which is a guard that can never fail: it would agree with any successor,
 * including one produced from a predecessor nobody observed.
 */
function readAttemptVersion(section: Record<string, unknown>): number | null {
  const attempt = section["attempt"];
  if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(attempt, "version");
  if (descriptor === undefined || !("value" in descriptor)) return null;
  const version: unknown = descriptor.value;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0
    ? version
    : null;
}

/** (E) ARMED -> ACTIVE. The intent is (D)'s output; the caller's is never read. */
function activateStage(
  request: ActivationIngressRequest,
  armed: EffectIntent,
): Stage<ActivationStageResult> {
  const section = readActivationSection(request.payload["activation"]);
  if (section === null) return PAYLOAD_MALFORMED;
  const activated = activateEffect({ ...section, intent: armed });
  if (activated.kind !== "ACTIVATED") return refuseSupervisor(activated.failure);
  const predecessorAttemptVersion = readAttemptVersion(section);
  if (predecessorAttemptVersion === null) return PAYLOAD_MALFORMED;
  return { value: { commit: activated.commit, predecessorAttemptVersion } };
}

/** (F) The sole RESERVED -> ACTIVE slot transition; this module never spreads one. */
function slotStage(
  successors: ClaimSuccessors,
  attemptRef: string,
): Stage<ProviderSlotReservation> {
  const { providerSlot } = successors;
  const activated = activateProviderSlot(providerSlot, {
    attemptRef,
    dimension: providerSlot.dimension,
    requestId: providerSlot.requestId,
    slotRef: providerSlot.slotRef,
  });
  if (activated.ok) return { value: activated.value };
  return activationIngressRefusal({
    code: activated.issues[0]?.code ?? "AUTHORITY_MALFORMED_INPUT",
    refusedBy: ACTIVATION_SLOT_LAYER,
  });
}

export function runEffectActivateCommand(
  store: SqliteEventStore,
  input: unknown,
  nodeKey?: string,
): ActivationIngressOutcome {
  const decoded = decodeActivationRequestBytes(input);
  if (!decoded.ok) {
    return activationIngressRefusal({
      code: decoded.code,
      kind: null,
      refusedBy: ACTIVATION_INGRESS_LAYER,
    });
  }
  const { bytes, request } = decoded;
  const embargo = readActivationEmbargo(store, request.projectId);
  if (!embargo.ok) {
    return activationIngressRefusal({ code: embargo.code, embargo, refusedBy: embargo.layer });
  }
  // (B2) The durable occupancy table the ceiling will count. A refusal is
  // carried VERBATIM — its own code and layer — because flattening it would
  // make an unreadable ledger indistinguishable from a malformed payload, and
  // answering it as an empty table would reopen the design-427 bypass.
  const occupancy = deriveSlotOccupancy(store, request.projectId);
  if (!occupancy.ok) {
    return activationIngressRefusal({ code: occupancy.code, refusedBy: occupancy.layer });
  }
  const prefix = claimPrefixStage(request, occupancy.held);
  if (isRefusal(prefix)) return prefix;
  const budget = durableBudgetStage(store, request, nodeKey);
  if (isRefusal(budget)) return budget;
  const claim = claimTailStage(prefix.value, budget.value.budget);
  if (isRefusal(claim)) return claim;
  const arm = armStage(claim.value.effectIntent);
  if (isRefusal(arm)) return arm;
  const activation = activateStage(request, arm.value);
  if (isRefusal(activation)) return activation;
  const attemptRef = activation.value.commit.attempt.attemptId;
  const slot = slotStage(claim.value, attemptRef);
  if (isRefusal(slot)) return slot;
  const record = assembleActivationRecord({
    activation: activation.value,
    armed: arm.value,
    providerSlot: slot.value,
    successors: claim.value,
  });
  const committed = commitActivationStage(store, request, bytes, record, budget.value.leg);
  // (J) THE ORDER IS FORCED. The binder re-reads the COMMITTED activation for
  // attemptRef, the effect intent and the project fence, so it cannot run before
  // this commit exists — and it may not share the activation aggregate, whose
  // strict reader treats a foreign event type as a malformed activation.
  //
  // A BIND REFUSAL IS NOT AN ACTIVATION REFUSAL. The activation is already
  // durable here, so reporting it as refused would be a false claim about a
  // committed decision; nor is a failed bind reported as an accepted binding. The
  // observable is the resource reader answering ATTEMPT_RESOURCE_RECORD_ABSENT,
  // which grants no terminal authority and therefore BLOCKS a consumer's release
  // instead of permitting one. That is why the bind outcome is discarded, and the
  // full reasoning lives with the call in `activation-resource-binding.ts`.
  if (committed.ok) bindActivationResources(store, request, record);
  return committed;
}
