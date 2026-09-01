import {
  reserveForAdmission,
  reserveProviderSlot,
  type BudgetAvailableView,
  type LeaseRecord,
  type ProviderSlotReservation,
  type ReservationRecord,
} from "@moe/scheduler";
import { applyEffectCommand, type EffectIntent } from "@moe/runner";

import { mirror, mirrorDeep, mirrorList } from "./work-claim-shape.js";
import { granted, refused, workFailure } from "./work-kernel.js";
import { fenceWorkLease } from "./work-lease.js";
import { checkSlotCeiling } from "./work-slot-ceiling.js";
import type { ClaimSuccessors, WorkResult } from "./work-kernel.js";

/**
 * `work.claim`: four legs composed in fixed order, each gated on the previous.
 *
 * ATOMICITY WITHOUT A DATABASE — persistence is out of scope, so "together or
 * nothing" is a property of the returned value. Successors accumulate in locals
 * and the result is constructed only after all four legs succeed, so a
 * partially built result is unreachable rather than merely untested. The module
 * holds NO mutable module-level state: the caller supplies the current records
 * and receives successors, which is why a refused claim leaves no residue.
 */

/** A claim requires a live lease; every other lease state is refused. */
const CLAIM_LEGAL_LEASE_STATES = Object.freeze(["ACTIVE"] as const);

/**
 * The ONLY transition `work.claim` may cause. It is a server-owned literal, not
 * a forwarded caller value: the supervisor admits `PENDING -> CANCEL_REQUESTED`
 * too, so forwarding published a cancellation under a `CLAIM_GRANTED` label.
 */
const CLAIM_EFFECT_COMMAND = Object.freeze({ kind: "claim" } as const);

const OUTER_KEYS = ["budget", "effect", "lease", "liveClaims", "slot"] as const;
const LEASE_KEYS = ["proof", "record"] as const;
const SLOT_KEYS = ["dimension", "requestId", "rows", "slotRef"] as const;
/**
 * EXPORTED so the activation lane can read the caller's GATE — and nothing else — out of the
 * same section this module admits. The narrow return type is the fence: `mirrorDeep(section,
 * BUDGET_KEYS)` yields a record whose only reachable keys are these three, so no downstream
 * expression there can name `view` or `admission` even by accident. Restating the list at that
 * call site would let the two drift, and the drift would be silent.
 */
export const BUDGET_KEYS = ["admission", "gate", "view"] as const;
const EFFECT_KEYS = ["command", "intent"] as const;
const COMMAND_KEYS = ["kind"] as const;

export type Leg<T> = WorkResult | { readonly value: T };

function malformed(leg: string, message: string): WorkResult {
  return refused(workFailure("WORK_PAYLOAD_MALFORMED", leg as never, "AUTHORITY", message));
}

export interface ClaimSections {
  readonly lease: unknown;
  readonly slot: unknown;
  readonly budget: unknown;
  readonly effect: unknown;
  readonly liveClaims: readonly unknown[];
}

/** The pair `reserveForAdmission` returns from ONE call: the hold and the view it shifted. */
export interface BudgetLeg {
  readonly reservation: ReservationRecord;
  readonly view: BudgetAvailableView;
}

/**
 * Everything the first three legs produced, plus the sections the remaining legs still need.
 *
 * This exists so a caller can run the budget leg ITSELF at position four without reordering
 * anything. See `admitClaimPrefix` for why an extra parameter would not have worked.
 */
export interface ClaimPrefix {
  readonly lease: LeaseRecord;
  readonly providerSlot: ProviderSlotReservation;
  readonly sections: ClaimSections;
}

/**
 * Mirrors outer routing values only. Each section stays unread until its own
 * deep snapshot; liveClaims is deep-snapshotted here before the ceiling reads it.
 */
export function readClaimSections(payload: unknown): ClaimSections | null {
  const outer = mirror(payload, OUTER_KEYS, true);
  if (outer === null) return null;
  const liveClaims = mirrorList(outer["liveClaims"]);
  if (liveClaims === null) return null;
  const { budget, effect, lease, slot } = outer;
  return { budget, effect, lease, liveClaims, slot };
}

function claimLease(section: unknown): Leg<LeaseRecord> {
  const lease = mirrorDeep(section, LEASE_KEYS);
  if (lease === null) return malformed("lease", "the lease section is not an own-data record");
  const gate = fenceWorkLease(lease, "work.claim", CLAIM_LEGAL_LEASE_STATES);
  // `fenceAuthority` already parsed and returned a LeaseRecord; the lease gate
  // widens it to a plain record, so this narrows back to the parsed type.
  return gate.ok ? { value: gate.lease as unknown as LeaseRecord } : gate.result;
}

function claimSlot(section: unknown): Leg<ProviderSlotReservation> {
  const slot = mirrorDeep(section, SLOT_KEYS);
  if (slot === null) return malformed("providerSlot", "the slot section is not own data");
  // The dimension is read from the payload, never defaulted here: the ceiling
  // in `checkSlotCeiling` counts per dimension, so a default would silently
  // merge two ceilings and reserve a slot the count never saw.
  const outcome = reserveProviderSlot(
    slot["rows"], slot["dimension"], slot["slotRef"], slot["requestId"],
  );
  if (outcome.ok) return { value: outcome.value };
  const issue = outcome.issues[0];
  const upstream = issue?.code ?? null;
  const message = issue?.message ?? "provider slot was refused";
  const code = upstream === "AUTHORITY_MALFORMED_INPUT"
    ? "WORK_PAYLOAD_MALFORMED"
    : "WORK_SLOT_RESOURCE_INACTIVE";
  return refused(workFailure(code, "providerSlot", "AUTHORITY", message, upstream));
}

function claimBudget(section: unknown): Leg<BudgetLeg> {
  const budget = mirrorDeep(section, BUDGET_KEYS);
  if (budget === null) return malformed("budgetReservation", "the budget section is not own data");
  const result = reserveForAdmission(
    budget["view"] as never, budget["admission"] as never, budget["gate"] as never,
  );
  // BOTH outputs of the ONE call. The shifted view is authoritative and is
  // retained verbatim; reserving again to obtain it would move the units twice.
  if (result.ok) return { value: { reservation: result.reservation, view: result.view } };
  const issue = result.issues[0];
  const upstream = issue?.code ?? null;
  const message = issue?.message ?? "budget reservation was refused";
  return refused(
    workFailure("WORK_BUDGET_REFUSED", "budgetReservation", "AUTHORITY", message, upstream),
  );
}

/** Refuses anything that is not the exact server-owned claim command. */
function checkClaimCommand(value: unknown): WorkResult | null {
  const exact = mirror(value, COMMAND_KEYS, true);
  if (exact !== null && exact["kind"] === "claim") return null;
  const kind = mirror(value, null, false)?.["kind"];
  if (typeof kind === "string" && kind !== "claim") {
    // Truncated: an unbounded caller kind would amplify the refusal message.
    return refused(workFailure(
      "WORK_INTENT_COMMAND_MISMATCH", "effectIntent", "AUTHORITY",
      `work.claim causes only the claim transition, never ${kind.slice(0, 32)}`,
    ));
  }
  return malformed("effectIntent", "the effect command is not the exact claim command");
}

function claimIntent(section: unknown): Leg<EffectIntent> {
  // Deep, like every other section: the runner carries the intent's lease
  // binding through onto the transitioned intent, so a one-level snapshot
  // publishes — and then deep-freezes — a record the caller still owns.
  const effect = mirrorDeep(section, EFFECT_KEYS);
  if (effect === null) return malformed("effectIntent", "the effect section is not own data");
  const mismatch = checkClaimCommand(effect["command"]);
  if (mismatch !== null) return mismatch;
  const outcome = applyEffectCommand(effect["intent"], CLAIM_EFFECT_COMMAND);
  if (outcome.kind === "TRANSITIONED") return { value: outcome.intent };
  if (outcome.kind === "MUST_DRAIN") {
    return refused(workFailure(
      "WORK_STATE_CONFLICT", "effectIntent", "AUTHORITY",
      "effect intent requires a drain before it can be claimed", null,
    ));
  }
  return refused(workFailure(
    "WORK_INTENT_REFUSED", "effectIntent", "AUTHORITY",
    outcome.failure.message, outcome.failure.code,
  ));
}

export function isRefusal<T>(value: Leg<T>): value is WorkResult {
  return !("value" in value) || "outcome" in value;
}

/**
 * LEGS ONE TO THREE: sections, lease, ceiling, slot. Stops at the budget leg's position.
 *
 * SPLIT RATHER THAN PARAMETERISED, AND THE REASON IS REFUSAL PRECEDENCE. The activation lane
 * needs its own durable budget at position FOUR; handing `claimWork` a ready-made budget
 * argument would compute that budget BEFORE this function runs, so a request carrying BOTH a
 * stale lease AND an unresolvable node would stop answering `WORK_LEASE_NOT_CURRENT` and start
 * answering the budget's code. Ordering here is a contract, not an implementation detail, and
 * an eagerly-evaluated argument silently inverts it.
 */
export function admitClaimPrefix(payload: unknown): Leg<ClaimPrefix> {
  const sections = readClaimSections(payload);
  if (sections === null) return malformed("lease", "work.claim payload is not a section record");

  const lease = claimLease(sections.lease);
  if (isRefusal(lease)) return lease;

  // Before the slot leg, so a scheduler-level accept cannot bypass the ceiling.
  const ceiling = checkSlotCeiling(sections.liveClaims);
  if (ceiling !== null) return ceiling;

  const slot = claimSlot(sections.slot);
  if (isRefusal(slot)) return slot;

  return { value: { lease: lease.value, providerSlot: slot.value, sections } };
}

/**
 * LEG FIVE and the assembly. Returns the WHOLE successor closure or NONE of it: the successors
 * are constructed only after the intent leg succeeds, so a partial result stays unreachable.
 */
export function finishClaim(prefix: ClaimPrefix, budget: BudgetLeg): WorkResult {
  const intent = claimIntent(prefix.sections.effect);
  if (isRefusal(intent)) return intent;

  const successors: ClaimSuccessors = {
    budgetReservation: budget.reservation,
    budgetView: budget.view,
    effectIntent: intent.value,
    lease: prefix.lease,
    providerSlot: prefix.providerSlot,
  };
  return granted("claim", "CLAIM_GRANTED", successors);
}

/**
 * Composes the four legs. Returns one frozen result carrying the WHOLE
 * successor closure or NONE of it plus a single refusal naming the failing leg.
 *
 * RECOMPOSED FROM THE THREE PIECES ABOVE and byte-identical in behaviour: same order, same
 * codes, same layer. `work.claim` is a different command from `effect.activate` and this row
 * does not touch it — the caller's budget section is still its authority.
 */
export function claimWork(payload: unknown): WorkResult {
  const prefix = admitClaimPrefix(payload);
  if (isRefusal(prefix)) return prefix;

  const budget = claimBudget(prefix.value.sections.budget);
  if (isRefusal(budget)) return budget;

  return finishClaim(prefix.value, budget.value);
}
