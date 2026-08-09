import { reserveForAdmission, reserveProviderSlot } from "@moe/scheduler";
import { applyEffectCommand } from "@moe/runner";

import {
  granted,
  refused,
  workFailure,
} from "./work-kernel.js";
import { fenceWorkLease, isRecord } from "./work-lease.js";
import { checkSlotCeiling } from "./work-slot-ceiling.js";
import type { ClaimSuccessors, WorkResult } from "./work-kernel.js";

/**
 * `work.claim`: four legs composed in fixed order, each gated on the previous.
 *
 * ATOMICITY WITHOUT A DATABASE — persistence is out of scope, so "together or
 * nothing" is a property of the returned value. Successors accumulate in locals
 * and the result is constructed only after all four legs succeed, so a
 * partially built result is unreachable rather than merely untested.
 *
 * This module holds NO mutable module-level state: the caller supplies the
 * current records and receives successors. That is what keeps it pure and
 * restart-safe, and it is why a refused claim can leave no residue anywhere.
 */

/** A claim requires a live lease; every other lease state is refused. */
const CLAIM_LEGAL_LEASE_STATES = Object.freeze(["ACTIVE"] as const);

function section(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return isRecord(value) ? value : null;
}

function malformed(leg: string, message: string): WorkResult {
  return refused(workFailure("WORK_PAYLOAD_MALFORMED", leg as never, "AUTHORITY", message));
}

export interface ClaimSections {
  readonly lease: Record<string, unknown>;
  readonly slot: Record<string, unknown>;
  readonly budget: Record<string, unknown>;
  readonly effect: Record<string, unknown>;
  readonly liveClaims: readonly unknown[];
}

/** Reads the payload's shape only; every value stays unvalidated for its own leg. */
export function readClaimSections(payload: unknown): ClaimSections | null {
  if (!isRecord(payload)) return null;
  const lease = section(payload, "lease");
  const slot = section(payload, "slot");
  const budget = section(payload, "budget");
  const effect = section(payload, "effect");
  const liveClaims = payload["liveClaims"];
  if (lease === null || slot === null || budget === null || effect === null) return null;
  if (!Array.isArray(liveClaims)) return null;
  return { budget, effect, lease, liveClaims, slot };
}

function claimLease(lease: Record<string, unknown>): WorkResult | { readonly value: unknown } {
  const gate = fenceWorkLease(lease, "work.claim", CLAIM_LEGAL_LEASE_STATES);
  return gate.ok ? { value: gate.lease } : gate.result;
}

function claimSlot(slot: Record<string, unknown>): WorkResult | { readonly value: unknown } {
  const outcome = reserveProviderSlot(slot["rows"], slot["slotRef"], slot["requestId"]);
  if (outcome.ok) return { value: outcome.value };
  const issue = outcome.issues[0];
  const upstream = issue?.code ?? null;
  const message = issue?.message ?? "provider slot was refused";
  const code = upstream === "AUTHORITY_MALFORMED_INPUT"
    ? "WORK_PAYLOAD_MALFORMED"
    : "WORK_SLOT_RESOURCE_INACTIVE";
  return refused(workFailure(code, "providerSlot", "AUTHORITY", message, upstream));
}

function claimBudget(budget: Record<string, unknown>): WorkResult | { readonly value: unknown } {
  const result = reserveForAdmission(
    budget["view"] as never,
    budget["admission"] as never,
    budget["gate"] as never,
  );
  if (result.ok) return { value: result.reservation };
  const issue = result.issues[0];
  const upstream = issue?.code ?? null;
  const message = issue?.message ?? "budget reservation was refused";
  return refused(
    workFailure("WORK_BUDGET_REFUSED", "budgetReservation", "AUTHORITY", message, upstream),
  );
}

function claimIntent(effect: Record<string, unknown>): WorkResult | { readonly value: unknown } {
  const outcome = applyEffectCommand(effect["intent"], effect["command"]);
  if (outcome.kind === "TRANSITIONED") return { value: outcome.intent };
  if (outcome.kind === "MUST_DRAIN") {
    return refused(
      workFailure(
        "WORK_STATE_CONFLICT",
        "effectIntent",
        "AUTHORITY",
        "effect intent requires a drain before it can be claimed",
        null,
      ),
    );
  }
  return refused(
    workFailure(
      "WORK_INTENT_REFUSED",
      "effectIntent",
      "AUTHORITY",
      outcome.failure.message,
      outcome.failure.code,
    ),
  );
}

function isRefusal(value: WorkResult | { readonly value: unknown }): value is WorkResult {
  return !("value" in value) || "outcome" in value;
}

/**
 * Composes the four legs. Returns one frozen result carrying ALL four
 * successors or NONE of them plus a single refusal naming the failing leg.
 */
export function claimWork(payload: unknown): WorkResult {
  const sections = readClaimSections(payload);
  if (sections === null) {
    return malformed("lease", "work.claim payload is not the expected section record");
  }

  const lease = claimLease(sections.lease);
  if (isRefusal(lease)) return lease;

  // Before the slot leg, so a scheduler-level accept cannot bypass the ceiling.
  const ceiling = checkSlotCeiling(sections.liveClaims);
  if (ceiling !== null) return ceiling;

  const slot = claimSlot(sections.slot);
  if (isRefusal(slot)) return slot;

  const budget = claimBudget(sections.budget);
  if (isRefusal(budget)) return budget;

  const intent = claimIntent(sections.effect);
  if (isRefusal(intent)) return intent;

  const successors: ClaimSuccessors = {
    budgetReservation: budget.value,
    effectIntent: intent.value,
    lease: lease.value,
    providerSlot: slot.value,
  };
  return granted("claim", "CLAIM_GRANTED", successors);
}
