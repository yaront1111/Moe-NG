/**
 * The reservation, activation, settlement and reconciliation writers, driven through a REAL
 * file-backed SqliteEventStore.
 *
 * ITS OWN SUITE, not a section of the movement suite. `budget-ledger-holds.ts` is production
 * authority over held money, and `runtime-entrypoint.test.ts` classifies a module as a published
 * runtime unit exactly when it carries its own `.test.ts` sibling — so folding these cases into a
 * neighbouring file would file the hold writers as test scaffolding.
 *
 * EVERY successor is compared against the PRODUCTION REDUCER'S OWN OUTPUT, and every refusal pins
 * the wrapper code plus the `sourceCode`/`sourceLayer` the reducer or the measurement authority
 * refused with. The reservation reducers take a `BudgetAvailableView` as an input and that view IS
 * spending authority, so these cases are also what proves the daemon derives it rather than
 * accepting one.
 */

import {
  activateReservation,
  normalizeUsageMeasurement,
  reconcileSettlement,
  reserveForAdmission,
  settleReservation,
} from "@moe/scheduler";
import type { BudgetAvailableView, NormalizedMeasurement, ReservationRecord, SettlementRecord } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { canonicalBudgetJson } from "./budget-ledger-codec.js";
import {
  activateBudgetReservation,
  reconcileBudgetSettlement,
  reserveBudgetForAdmission,
  settleBudgetReservation,
} from "./budget-ledger-holds.js";
import { authorizeBudgetRoot } from "./budget-ledger.js";
import { GOAL_ID, PROJECT_ID, rawCounts, seedDurableBindings, withBudgetStore } from "./budget-ledger-fixtures.js";
import {
  AGGREGATE,
  ADMISSION,
  ATTEMPT,
  CHILD,
  GATE,
  HOLD,
  accepted,
  authorizeInput,
  context,
  currentLedger,
  observation,
  refused,
  reserveInput,
  seedActivatedHold,
  seedFundedChild,
  unknownObservation,
} from "./budget-transition-fixtures.js";

function normalized(raw: unknown, prior: NormalizedMeasurement | null = null): NormalizedMeasurement {
  const result = normalizeUsageMeasurement(raw, prior);
  if (!result.ok) throw new Error(`fixture measurement refused: ${JSON.stringify(result.issues)}`);
  return result.record;
}

function currentReservation(store: SqliteEventStore): ReservationRecord {
  const [reservation] = currentLedger(store).reservations;
  if (reservation === undefined) throw new Error("no durable reservation");
  return reservation;
}

function currentSettlement(store: SqliteEventStore): SettlementRecord {
  const [settlement] = currentLedger(store).settlements;
  if (settlement === undefined) throw new Error("no durable settlement");
  return settlement;
}

function viewOf(store: SqliteEventStore, accountId: string): BudgetAvailableView {
  const view = currentLedger(store).views.find((entry) => entry.accountId === accountId);
  if (view === undefined) throw new Error(`no durable view for ${accountId}`);
  return view;
}

/** The child's view before any hold exists: the account record's own buckets, at its version. */
function derivedView(store: SqliteEventStore): BudgetAvailableView {
  const account = currentLedger(store).accounts.find((entry) => entry.accountId === CHILD);
  if (account === undefined) throw new Error("no child account");
  return { accountId: account.accountId, meters: account.meters, state: account.state, version: account.version };
}

describe("holds delegate to the reservation and settlement reducers", () => {
  it("commits reserveForAdmission's own reservation and view", () => {
    withBudgetStore("reserve", (store) => {
      seedFundedChild(store);
      const priorView = derivedView(store);

      const result = accepted(reserveBudgetForAdmission(store, reserveInput("cmd-reserve")));

      const reducer = reserveForAdmission(
        priorView, { admissionRef: ADMISSION, amounts: HOLD, expectedVersion: priorView.version }, GATE,
      );
      expect(reducer.ok).toBe(true);
      if (!reducer.ok) throw new Error("reducer refused");
      expect(canonicalBudgetJson(result.record.reservations[0])).toBe(canonicalBudgetJson(reducer.reservation));
      expect(canonicalBudgetJson(viewOf(store, CHILD))).toBe(canonicalBudgetJson(reducer.view));
      expect(result.record.transition).toBe("RESERVED");
    });
  });

  it("passes a reservation-reducer refusal through with its own code and layer", () => {
    withBudgetStore("reserve-gateless", (store) => {
      seedFundedChild(store);
      const before = rawCounts(store, AGGREGATE);

      const result = refused(reserveBudgetForAdmission(
        store, reserveInput("cmd-reserve-gateless", { allowance: null, approval: null }),
      ));

      expect(result.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
      expect(result.sourceCode).toBe("BUDGET_RESERVATION_GATE_ABSENT");
      expect(result.sourceLayer).toBe("BUDGET_RESERVATION");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("commits activateReservation's own successor and moves no units", () => {
    withBudgetStore("activate", (store) => {
      seedFundedChild(store);
      accepted(reserveBudgetForAdmission(store, reserveInput("cmd-reserve")));
      const priorReservation = currentReservation(store);
      const priorView = viewOf(store, CHILD);

      const result = accepted(activateBudgetReservation(store, {
        attemptRef: ATTEMPT, context: context("cmd-activate"), goalRef: GOAL_ID,
        projectId: PROJECT_ID, reservationId: priorReservation.reservationId,
      }));

      const reducer = activateReservation(priorView, priorReservation, {
        attemptRef: ATTEMPT, expectedVersion: priorReservation.version,
      });
      expect(reducer.ok).toBe(true);
      if (!reducer.ok) throw new Error("reducer refused");
      expect(canonicalBudgetJson(result.record.reservations[0])).toBe(canonicalBudgetJson(reducer.reservation));
      expect(canonicalBudgetJson(viewOf(store, CHILD))).toBe(canonicalBudgetJson(priorView));
      expect(result.record.transition).toBe("ACTIVATED");
    });
  });

  it("normalizes the receipt server-side and commits settleReservation's own successor", () => {
    withBudgetStore("settle", (store) => {
      seedActivatedHold(store);
      const priorReservation = currentReservation(store);
      const priorView = viewOf(store, CHILD);

      const result = accepted(settleBudgetReservation(store, {
        context: context("cmd-settle"), goalRef: GOAL_ID, observations: [observation()],
        projectId: PROJECT_ID, reservationId: priorReservation.reservationId,
      }));

      const reducer = settleReservation(
        priorView, priorReservation, { measurements: [normalized(observation())] },
        { expectedReservationVersion: priorReservation.version, expectedViewVersion: priorView.version, prior: null },
      );
      expect(reducer.ok).toBe(true);
      if (!reducer.ok) throw new Error("reducer refused");
      expect(canonicalBudgetJson(result.record.settlements[0])).toBe(canonicalBudgetJson(reducer.settlement));
      expect(canonicalBudgetJson(viewOf(store, CHILD))).toBe(canonicalBudgetJson(reducer.view));
      expect(result.record.transition).toBe("SETTLED");
    });
  });

  it("preserves the measurement layer's own code when a receipt cannot be normalized", () => {
    withBudgetStore("settle-bad-receipt", (store) => {
      seedActivatedHold(store);
      const before = rawCounts(store, AGGREGATE);

      const result = refused(settleBudgetReservation(store, {
        context: context("cmd-settle-bad"), goalRef: GOAL_ID,
        // PROVIDER_REPORTED_COMPLETE may not claim PARTIAL coverage.
        observations: [observation({ coverage: "PARTIAL" })],
        projectId: PROJECT_ID, reservationId: currentReservation(store).reservationId,
      }));

      expect(result.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
      expect(result.sourceCode).toBe("BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
      expect(result.sourceLayer).toBe("BUDGET_MEASUREMENT");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });

  it("commits reconcileSettlement's own successor over a quarantined hold", () => {
    withBudgetStore("reconcile", (store) => {
      seedActivatedHold(store);
      accepted(settleBudgetReservation(store, {
        context: context("cmd-settle-unknown"), goalRef: GOAL_ID, observations: [unknownObservation()],
        projectId: PROJECT_ID, reservationId: currentReservation(store).reservationId,
      }));
      const priorSettlement = currentSettlement(store);
      expect(priorSettlement.state).toBe("QUARANTINED");
      const priorView = viewOf(store, CHILD);

      const result = accepted(reconcileBudgetSettlement(store, {
        context: context("cmd-reconcile"), goalRef: GOAL_ID, neverStartedProofRef: null,
        observations: [observation({ sequence: 1 })], projectId: PROJECT_ID,
        reservationId: priorSettlement.reservationId,
      }));

      const reducer = reconcileSettlement(
        priorView, priorSettlement,
        { measurements: [normalized(observation({ sequence: 1 }))], neverStartedProofRef: null },
        { expectedSettlementVersion: priorSettlement.version, expectedViewVersion: priorView.version },
      );
      expect(reducer.ok).toBe(true);
      if (!reducer.ok) throw new Error("reducer refused");
      expect(canonicalBudgetJson(result.record.settlements[0])).toBe(canonicalBudgetJson(reducer.settlement));
      expect(canonicalBudgetJson(viewOf(store, CHILD))).toBe(canonicalBudgetJson(reducer.view));
      expect(result.record.transition).toBe("RECONCILED");
    });
  });
});


describe("a transition that names a durable record nobody committed", () => {
  it("refuses TARGET_ABSENT at this layer and appends nothing", () => {
    withBudgetStore("target-absent", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));
      const before = rawCounts(store, AGGREGATE);

      const result = refused(activateBudgetReservation(store, {
        attemptRef: ATTEMPT, context: context("cmd-activate-ghost"), goalRef: GOAL_ID,
        projectId: PROJECT_ID, reservationId: "reservation:0::never-reserved",
      }));

      expect(result.code).toBe("BUDGET_LEDGER_TARGET_ABSENT");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(result.sourceLayer).toBeNull();
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });
});

/**
 * The same shape gap, on the writers that hold money. `settle` ITERATES its observations inside
 * this daemon (`normalizeAll`), so a non-array one threw here rather than inside a reducer —
 * and a string is iterable, which is exactly the input that would have been measured CHARACTER
 * BY CHARACTER instead of refused.
 */
describe("a declared list field cannot reach a hold reducer as a non-array", () => {
  it("refuses every non-array list with one exact code, over a nonempty generated case set", () => {
    const hostileShapes: readonly unknown[] = [undefined, null, "nope", 0, true, {}, new Set([observation()])];
    const generated: string[] = [];
    withBudgetStore("hold-shape", (store) => {
      seedActivatedHold(store);
      const before = rawCounts(store, AGGREGATE);
      const reservationId = currentReservation(store).reservationId;

      for (const [index, list] of hostileShapes.entries()) {
        const held = refused(reserveBudgetForAdmission(store, {
          ...reserveInput(`cmd-shape-reserve-${index}`), amounts: list,
        } as Parameters<typeof reserveBudgetForAdmission>[1]));
        expect(held.code).toBe("BUDGET_LEDGER_INPUT_MALFORMED");
        expect(held.layer).toBe("BUDGET_LEDGER");
        expect(held.sourceLayer).toBeNull();
        generated.push(`reserve:${index}`);

        const settled = refused(settleBudgetReservation(store, {
          context: context(`cmd-shape-settle-${index}`), goalRef: GOAL_ID, observations: list,
          projectId: PROJECT_ID, reservationId,
        } as Parameters<typeof settleBudgetReservation>[1]));
        expect(settled.code).toBe("BUDGET_LEDGER_INPUT_MALFORMED");
        expect(settled.layer).toBe("BUDGET_LEDGER");
        expect(settled.sourceLayer).toBeNull();
        generated.push(`settle:${index}`);

        // Reconcile admits a NULL observations — a never-started proof settles a hold with
        // nothing measured — so `null` is skipped here and asserted as admitted below.
        if (list === null) continue;
        const reconciled = refused(reconcileBudgetSettlement(store, {
          context: context(`cmd-shape-reconcile-${index}`), goalRef: GOAL_ID,
          neverStartedProofRef: null, observations: list, projectId: PROJECT_ID, reservationId,
        } as Parameters<typeof reconcileBudgetSettlement>[1]));
        expect(reconciled.code).toBe("BUDGET_LEDGER_INPUT_MALFORMED");
        expect(reconciled.layer).toBe("BUDGET_LEDGER");
        expect(reconciled.sourceLayer).toBeNull();
        generated.push(`reconcile:${index}`);
      }

      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });

    expect(generated).toHaveLength(hostileShapes.length * 3 - 1);
    expect(generated.length).toBeGreaterThan(0);
  });

  it("admits reconcile's NULL observations and lets the transition itself answer", () => {
    // The negative control for the roster above: `reconcile` declares its observations nullable,
    // so admission must NOT be what refuses this. A shared "every list must be an array" rule
    // would have refused INPUT_MALFORMED here and silently removed the never-started path.
    withBudgetStore("hold-shape-null-control", (store) => {
      seedActivatedHold(store);
      const before = rawCounts(store, AGGREGATE);

      const result = refused(reconcileBudgetSettlement(store, {
        context: context("cmd-shape-null"), goalRef: GOAL_ID, neverStartedProofRef: "proof-never-started",
        observations: null, projectId: PROJECT_ID, reservationId: currentReservation(store).reservationId,
      }));

      expect(result.code).toBe("BUDGET_LEDGER_TARGET_ABSENT");
      expect(result.code).not.toBe("BUDGET_LEDGER_INPUT_MALFORMED");
      expect(result.layer).toBe("BUDGET_LEDGER");
      expect(rawCounts(store, AGGREGATE).events).toBe(before.events);
    });
  });
});
