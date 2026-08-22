/**
 * (C2) THE DURABLE BUDGET STAGE of the authenticated `effect.activate` route.
 *
 * WHAT MOVED. Until this module existed, the activation's budget leg was `claimBudget` reading
 * the CALLER's `payload.budget` — its own `view`, its own `admission` amounts, its own implied
 * coverage — and reserving against them in memory. Nothing durable was consulted and nothing
 * durable was written. Here the account, the amounts and the fenced version are DERIVED from
 * project/goal/graph/node facts, and the hold is committed by the ledger's own writer inside
 * the same decision as the activation.
 *
 * THE CALLER NOW SUPPLIES NOTHING. Until task-93e8aab3 this module read ONE caller input — the
 * admission GATE out of `payload.budget.gate` — because no durable producer of an
 * `AdmissionGate` witness existed. `resolveAdmissionGate` is that producer, so the gate is
 * derived from the policy decision or the approval record the node's OWN durable
 * `admissionGatePolicy` names, and this module does not read request payload bytes at all.
 *
 * TWO CODES WERE RETIRED WITH THAT READ, and the retirement is recorded rather than silent
 * (governor `comment-1369e736`, anchored to the DELIVERED tree by `comment-370ca397`):
 *   ACTIVATION_BUDGET_GATE_MALFORMED — "the caller's gate is not a record". Its world was a
 *     payload shape; no payload reaches the gate now, so no path can construct it.
 *   ACTIVATION_BUDGET_GATE_WITNESS_MISMATCH — "the caller's gate lacks the witness the node's
 *     policy names". The resolver BUILDS the witness the policy names, so a gate carrying the
 *     other kind is unrepresentable rather than refused.
 * Both are SUPERSEDED by `ADMISSION_GATE_WITNESS_ABSENT` / `ADMISSION_GATE_SCOPE_MISMATCH` at
 * the `DAEMON_ADMISSION_GATE` layer. Keeping them would leave unreachable arms in a closed enum.
 *
 * WHETHER THE WITNESS ALLOWS IS STILL NOT THIS MODULE'S QUESTION. `checkGate` in `@moe/scheduler`
 * owns it, and its refusal travels out through the reserve writer with its own code and layer.
 *
 * REPLAY, THE NON-OBVIOUS ONE. The hold rides the activation's decision as a SECONDARY leg, so
 * it has no decision row of its own to replay through. Reserving a second time would fold
 * against a head that ALREADY moved: a different view, a different record digest, and a
 * byte-identical retry refused as `ACTIVATION_LEDGER_REPLAY_DIVERGED`. A reservation already
 * standing under this `admissionRef` IS the answer, and it is REBUILT FROM THE DURABLE EVENT
 * that created it — pair and leg fence together, because the store folds every secondary leg's
 * fence into the decision's own request identity. Minting a distinct commandId to dodge this
 * would fabricate a second identity, and reusing the activation's own key as a BUDGET decision
 * key would meet `answerBudgetReplay`'s foreign-commandKind refusal; neither is a fix.
 */

import { decodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE, deriveBudgetAggregateId,
} from "../budget/budget-ledger-contracts.js";
import { reserveBudgetForAdmission } from "../budget/budget-ledger-holds.js";
import type { BudgetLeg } from "../work/work-claim.js";

import { captureBudgetLeg, deriveActivationBudget } from "./activation-budget-derivation.js";
import type { ActivationBudgetAuthority } from "./activation-budget-derivation.js";
import { ACTIVATION_INGRESS_LAYER } from "./activation-ingress-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";
import { resolveAdmissionGate } from "./admission-gate-resolver.js";

import type { BudgetLedgerRecord } from "../budget/budget-ledger-contracts.js";

import type { BudgetAvailableView, ReservationRecord } from "@moe/scheduler";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

/**
 * This stage's OWN faults. Everything else it can answer with belongs to the derivation, the
 * projection or the ledger writer and travels unrestamped.
 */
export const ACTIVATION_BUDGET_STAGE_CODES = Object.freeze([
  "ACTIVATION_BUDGET_LEG_ABSENT",
  "ACTIVATION_BUDGET_RESERVATION_ABSENT",
] as const);

export type ActivationBudgetStageCode = (typeof ACTIVATION_BUDGET_STAGE_CODES)[number];

export interface ActivationBudgetStageInput {
  /** DOOR 1 ONLY: the key `foundation.dispatch` already validated. Never a payload key. */
  readonly nodeKey?: string;
  readonly request: ActivationIngressRequest;
  readonly store: SqliteEventStore;
}

/**
 * `leg` is ALWAYS present, on the fresh path and the replay path alike — see `readStandingHold`
 * for why an absent leg would make a byte-identical retry unrecognisable to the store. On the
 * replay path it is the ORIGINAL event replayed back, so it moves no units even if it landed.
 */
export interface ActivationBudgetStageAccepted {
  readonly authority: ActivationBudgetAuthority;
  readonly budget: BudgetLeg;
  readonly leg: ExpectedVersionDecisionLeg;
  readonly ok: true;
}

export interface ActivationBudgetStageRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type ActivationBudgetStageResult =
  | ActivationBudgetStageAccepted
  | ActivationBudgetStageRefused;

const refuse = (code: ActivationBudgetStageCode): ActivationBudgetStageRefused =>
  Object.freeze({ code, layer: ACTIVATION_INGRESS_LAYER, ok: false as const });

/**
 * The admission identity, derived from the AUTHENTICATED request rather than from the payload.
 * `commandId` is already the decision key's own component, so two byte-identical retries name
 * the same hold and two distinct commands never can.
 */
export const activationAdmissionRef = (commandId: string): string => `activation:${commandId}`;

interface StandingHold {
  readonly budget: BudgetLeg;
  readonly leg: ExpectedVersionDecisionLeg;
}

/**
 * The hold this admission identity ALREADY holds, rebuilt from the DURABLE EVENT that created
 * it — or null when none stands.
 *
 * BOTH HALVES MUST COME FROM THAT ORIGINAL EVENT, and neither may come from the current head.
 *
 *   THE PAIR, because a sibling activation reserving on the SAME account shifts that account's
 *   view, so the head's view is not the view the first activation committed. Answering a replay
 *   with the head's would change the activation record's digest and refuse a byte-identical
 *   retry as REPLAY_DIVERGED.
 *
 *   THE LEG, because `identifyDecisionRequest` folds `additionalLegFences` — every leg[1..]
 *   `{aggregateId, expectedVersion}` — INTO the decision's request identity. Presenting no
 *   budget leg, or one fenced at today's head, computes a different requestSha256 than the
 *   original two-leg commit and the store answers IDEMPOTENCY_CONFLICT instead of REPLAYED.
 *   The record's own `sequence` IS the fence its commit used (`commitHold` passes
 *   `expectedVersion: current.headVersion` and seals `sequence` from the same value), so the
 *   leg is reconstructed exactly, events and all, from bytes the writer already wrote.
 *
 * The FIRST matching RESERVED record is the one that created the hold: later records carry it
 * forward in their own `reservations`, and no earlier record could contain a reservation that
 * did not exist yet.
 */
function readStandingHold(
  store: SqliteEventStore, projectId: string,
  authority: ActivationBudgetAuthority, admissionRef: string,
): StandingHold | null {
  const aggregateId = deriveBudgetAggregateId(projectId, authority.accountId);
  for (const event of store.readEvents(aggregateId)) {
    if (event.eventType !== BUDGET_LEDGER_EVENT_TYPE) continue;
    const decoded = decodeBudgetLedgerRecord(event.payload);
    // An undecodable record is not evidence of anything; it is left to the projection to refuse.
    if (!decoded.ok) return null;
    if (decoded.record.transition !== "RESERVED") continue;
    const budget = pairOf(decoded.record, authority.accountId, admissionRef);
    if (budget === null) continue;
    return {
      budget,
      leg: {
        aggregateId,
        events: [{
          eventId: event.eventId, eventType: event.eventType, payload: event.payload,
        }],
        expectedVersion: decoded.record.sequence,
      },
    };
  }
  return null;
}

/**
 * The hold and the view it shifted, both taken from the ledger's OWN arrays.
 *
 * Rebuilding either from this module's inputs would be a second arithmetic over the same units,
 * and it would agree with itself no matter what the ledger actually wrote.
 */
function pairOf(
  held: Pick<BudgetLedgerRecord, "reservations" | "views">,
  accountId: string,
  admissionRef: string,
): BudgetLeg | null {
  const reservation = held.reservations.find(
    (entry: ReservationRecord) =>
      entry.admissionRef === admissionRef && entry.accountId === accountId,
  );
  if (reservation === undefined) return null;
  const view = held.views.find(
    (entry: BudgetAvailableView) => entry.accountId === accountId,
  );
  if (view === undefined) return null;
  return { reservation, view };
}

export function runActivationBudgetStage(
  input: ActivationBudgetStageInput,
): ActivationBudgetStageResult {
  const { nodeKey, request, store } = input;
  const derived = deriveActivationBudget(
    nodeKey === undefined
      ? { projectId: request.projectId, store }
      : { nodeKey, projectId: request.projectId, store },
  );
  // Upstream code AND layer, unchanged. A restamp here would make a missing goal, an
  // unavailable graph and an unknown meter indistinguishable at the ingress boundary.
  if (!derived.ok) return { code: derived.code, layer: derived.layer, ok: false as const };
  const authority = derived.value;
  const admissionRef = activationAdmissionRef(request.commandId);

  const standing = readStandingHold(store, request.projectId, authority, admissionRef);
  if (standing !== null) {
    return Object.freeze({
      authority, budget: standing.budget, leg: standing.leg, ok: true as const,
    });
  }

  // The witness the node's OWN durable policy names, built from durable records. Its refusals
  // carry the resolver's vocabulary and layer and travel out unrestamped, exactly like the
  // derivation's: "no durable witness exists" and "the witness does not allow" are different
  // faults answered by different authorities, and one may not wear the other's code.
  const resolved = resolveAdmissionGate({
    goalRef: authority.goalRef,
    nodeKey: authority.nodeKey,
    projectId: request.projectId,
    store,
    witnessField: authority.gateWitnessField,
  });
  if (!resolved.ok) return { code: resolved.code, layer: resolved.layer, ok: false as const };

  const captured = captureBudgetLeg((commit) =>
    reserveBudgetForAdmission(store, {
      accountId: authority.accountId,
      admissionRef,
      amounts: authority.amounts,
      context: {
        commandId: request.commandId,
        correlationId: request.correlationId,
        decidedAt: request.decidedAt,
        principalId: request.principalId,
      },
      // Validated by the producer's own `readGate`, never by a copy of it here.
      gate: resolved.gate,
      goalRef: authority.goalRef,
      projectId: request.projectId,
    }, commit));
  const { result } = captured;
  if (!result.ok) return { code: result.code, layer: result.layer, ok: false as const };
  // A writer that accepted without reaching the commit port answered from prior bytes. Reporting
  // that as a fresh hold would publish a receipt for a leg this decision never carries.
  if (!("leg" in captured)) return refuse("ACTIVATION_BUDGET_LEG_ABSENT");
  const budget = pairOf(result.record, authority.accountId, admissionRef);
  if (budget === null) return refuse("ACTIVATION_BUDGET_RESERVATION_ABSENT");
  return Object.freeze({ authority, budget, leg: captured.leg, ok: true as const });
}
