/**
 * (C2) THE DURABLE BUDGET STAGE of the authenticated `effect.activate` route.
 *
 * This replaces `claimBudget` reading caller-supplied views and amounts. Account, amounts and
 * fence now derive from durable project/goal/graph/node facts, and the ledger writer commits the
 * hold inside the activation decision.
 *
 * THE CALLER NOW SUPPLIES NOTHING. Until task-93e8aab3 this module read ONE caller input — the
 * admission GATE out of `payload.budget.gate`. `resolveAdmissionGate` now derives it from the
 * policy decision or approval record named by the node; this module reads no payload bytes.
 *
 * The former caller-gate shape and witness-mismatch codes were retired with that read
 * (`comment-1369e736`, delivered at `comment-370ca397`). Their worlds are now unrepresentable;
 * durable resolver refusals at `DAEMON_ADMISSION_GATE` supersede them.
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
import { ACTIVATION_LEDGER_COMMAND_KIND } from "./activation-ledger-contracts.js";
import { resolveAdmissionGate } from "./admission-gate-resolver.js";
import {
  activationAdmissionRef, legacyActivationAdmissionRef,
} from "./activation-admission-identity.js";

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
  store: SqliteEventStore, request: ActivationIngressRequest,
  authority: ActivationBudgetAuthority, admissionRef: string,
): StandingHold | null {
  const aggregateId = deriveBudgetAggregateId(request.projectId, authority.accountId);
  for (const event of store.readEvents(aggregateId)) {
    if (event.eventType !== BUDGET_LEDGER_EVENT_TYPE) continue;
    const decoded = decodeBudgetLedgerRecord(event.payload);
    // An undecodable record is not evidence of anything; it is left to the projection to refuse.
    if (!decoded.ok) return null;
    if (decoded.record.transition !== "RESERVED") continue;
    let budget = pairOf(decoded.record, authority.accountId, admissionRef);
    if (budget === null) {
      budget = pairOf(
        decoded.record, authority.accountId,
        legacyActivationAdmissionRef(request.commandId),
      );
    }
    const trace = event.decisionTrace;
    if (budget === null || trace === undefined
      || trace.commandKind !== ACTIVATION_LEDGER_COMMAND_KIND
      || trace.commandId !== request.commandId
      || trace.principalId !== request.principalId
      || trace.projectId !== request.projectId) continue;
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
  const admissionRef = activationAdmissionRef(
    request.projectId, request.principalId, request.commandId,
  );

  const standing = readStandingHold(store, request, authority, admissionRef);
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
    graphRevisionRef: authority.graphRevisionRef,
    nodeKey: authority.nodeKey,
    policySliceHash: authority.policySliceHash,
    principalId: request.principalId,
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
