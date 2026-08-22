import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { readCurrentBudgetCoverage } from "./budget-coverage-reader.js";
import type { BudgetCoverageResult } from "./budget-coverage-reader.js";
import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  rawCounts,
  seedDurableBindings,
  seedProjectAndGoal,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";
import { reserveBudgetForAdmission } from "./budget-ledger-holds.js";
import { authorizeBudgetRoot } from "./budget-ledger.js";
import {
  AGGREGATE,
  accepted,
  authorizeInput,
  reserveInput,
  seedFundedChild,
} from "./budget-transition-fixtures.js";

/**
 * THE BUDGETS/COVERAGE READER the Foundation context matrix names (task-c320c34a's DoD 1).
 *
 * Everything below is seeded through PRODUCTION writers — `authorizeBudgetRoot`,
 * `allocateBudgetToChild` (inside `seedFundedChild`) and `reserveBudgetForAdmission`. No raw
 * event planting, no `seedActivatedHold`, no settlement fixture: a reader certified against
 * state only a fixture can build proves the fixture, not the path.
 *
 * THE TWO SETTLEMENT-DEPENDENT WORLDS ARE ABSENT ON PURPOSE, NOT BY OVERSIGHT. `settleReservation`
 * and `reconcileSettlement` have ZERO production callers at this HEAD (measured, excluding tests,
 * fixtures and the defining module), so PARTIAL and measured-COMPLETE cannot be reached by any
 * production writer. They are named `it.todo` below with their gate, rather than seeded around.
 */

const read = (store: SqliteEventStore): BudgetCoverageResult =>
  readCurrentBudgetCoverage(store, PROJECT_ID, GOAL_ID);

function served(result: BudgetCoverageResult): Extract<BudgetCoverageResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected coverage, got ${result.code} at ${result.layer}`);
  return result;
}

function refused(result: BudgetCoverageResult): Extract<BudgetCoverageResult, { ok: false }> {
  if (result.ok) throw new Error("expected a refusal, got served coverage");
  return result;
}

const meterOf = (
  served: Extract<BudgetCoverageResult, { ok: true }>, meter: string,
): (typeof served.meters)[number] => {
  const found = served.meters.find((entry) => entry.meter === meter);
  if (found === undefined) throw new Error(`no ${meter} meter in the served coverage`);
  return found;
};

/** A store whose reads throw — the one fault no lower layer can turn into a verdict. */
function unreadableStore(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property): unknown {
      const held: unknown = Reflect.get(target, property, target);
      if (typeof held !== "function") return held;
      const method = held as (...args: unknown[]) => unknown;
      if (property !== "readEvents") return method.bind(target);
      return (): never => {
        throw new Error("sqlite: database disk image is malformed at /tmp/secret-path.sqlite");
      };
    },
  });
}

describe("the budgets/coverage reader serves the durable current standing", () => {
  it("serves the committed per-meter standing, versioned and bound, for a root-authorized ledger", () => {
    withBudgetStore("coverage-complete", (store) => {
      seedDurableBindings(store);
      accepted(authorizeBudgetRoot(store, authorizeInput()));

      const coverage = served(read(store));

      // IDENTITY AND VERSION COME FROM THE DURABLE READ, not from this suite: the aggregate is
      // the one the WRITER derived through the shared deriveBudgetAggregateId.
      expect(coverage.aggregateId).toBe(AGGREGATE);
      expect(coverage.headVersion).toBe(1);
      expect(coverage.binding.budgetAccountRef).toBe(BUDGET_ACCOUNT_REF);
      expect(coverage.binding.projectId).toBe(PROJECT_ID);
      expect(coverage.binding.goalRef).toBe(GOAL_ID);

      // No hold has ever existed on this ledger, so every meter is fully accounted for.
      const tokens = meterOf(coverage, "tokens");
      expect(tokens.coverage).toBe("COMPLETE");
      expect(tokens.openHoldCount).toBe(0);
      expect(tokens.refundable).toBe(tokens.buckets.available);
      expect(tokens.buckets.reserved).toBe(0);

      expect(Object.isFrozen(coverage)).toBe(true);
    });
  });

  it("serves a REAL open hold as UNKNOWN with its conserved buckets visible and refundable NULL", () => {
    withBudgetStore("coverage-open-hold", (store) => {
      seedFundedChild(store);
      // PRODUCTION WRITER, not seedActivatedHold: this is the reserve path an activation runs.
      accepted(reserveBudgetForAdmission(store, reserveInput("cmd-reserve")));

      const tokens = meterOf(served(read(store)), "tokens");

      expect(tokens.coverage).toBe("UNKNOWN");
      expect(tokens.openHoldCount).toBe(1);
      // UNKNOWN IS NOT ZERO AND NOT EMPTY. The units are held, not gone: the conserved position
      // stays visible, and the refundable CLAIM is withheld — `null`, never the number 0, which
      // would read as "nothing is returnable" rather than "nobody has measured".
      expect(tokens.refundable).toBeNull();
      expect(tokens.refundable).not.toBe(0);
      expect(tokens.buckets.reserved).toBeGreaterThan(0);
    });
  });

  it("appends nothing: a read is a read, on both the served and the refused path", () => {
    withBudgetStore("coverage-readonly", (store) => {
      seedFundedChild(store);
      const before = rawCounts(store, AGGREGATE);

      served(read(store));
      served(read(store));
      refused(readCurrentBudgetCoverage(store, PROJECT_ID, "goal-that-does-not-exist"));

      expect(rawCounts(store, AGGREGATE)).toStrictEqual(before);
    });
  });
});

describe("the budgets/coverage reader refuses without ever inventing a standing", () => {
  it("stays UNKNOWN with NO success fields when the bindings exist but no ledger was authorized", () => {
    withBudgetStore("coverage-absent", (store) => {
      seedDurableBindings(store);

      const result = refused(read(store));

      expect(result.outcome).toBe("UNKNOWN");
      expect(result.layer).toBe("BUDGET_COVERAGE_READER");
      expect(result.upstream).toStrictEqual({
        code: "BUDGET_PROJECTION_ABSENT",
        layer: "BUDGET_CURRENT_PROJECTION",
        sourceCode: null,
        sourceLayer: null,
      });
      // A REFUSAL CARRIES NO STANDING. An empty meters array would read as "measured, and there
      // is nothing", which is the exact claim this reader is forbidden to make.
      expect("meters" in result).toBe(false);
      expect("headVersion" in result).toBe(false);
      expect("binding" in result).toBe(false);
    });
  });

  it("keeps all THREE attribution levels distinct when the graph is unavailable", () => {
    withBudgetStore("coverage-no-graph", (store) => {
      // The goal exists through its production command path; no active graph was ever published.
      seedProjectAndGoal(store);

      const result = refused(read(store));

      // Level 1 — this reader's own wrapper. Level 2 — the projection's verdict. Level 3 — the
      // deeper source the projection itself forwarded. Collapsing any two would make a graph
      // fault indistinguishable from a budget fault.
      expect(result.layer).toBe("BUDGET_COVERAGE_READER");
      expect(result.upstream?.code).toBe("BUDGET_PROJECTION_GRAPH_UNAVAILABLE");
      expect(result.upstream?.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.upstream?.sourceCode).toBe("ACTIVE_GRAPH_ABSENT");
      expect(result.upstream?.sourceLayer).toBe("ACTIVE_GRAPH_PROJECTION");
    });
  });

  it("mints its OWN code for a thrown read, and leaks no exception text or path", () => {
    withBudgetStore("coverage-throws", (store) => {
      seedFundedChild(store);

      const result = refused(readCurrentBudgetCoverage(unreadableStore(store), PROJECT_ID, GOAL_ID));

      // NO LOWER LAYER RETURNED A VERDICT, so there is nothing to forward: `upstream` is null
      // rather than a fabricated projection refusal.
      expect(result.code).toBe("BUDGET_COVERAGE_STORE_UNAVAILABLE");
      expect(result.layer).toBe("BUDGET_COVERAGE_READER");
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.upstream).toBeNull();
      // The store's own message named a path and a corruption detail. Neither may reach a caller.
      expect(JSON.stringify(result)).not.toContain("secret-path");
      expect(JSON.stringify(result)).not.toContain("malformed");
    });
  });

  // GATED PENDING task-a91e9fe2 — settleBudgetReservation and reconcileBudgetSettlement have ZERO
  // production callers at this HEAD, so no production writer can reach a settled record. Seeding
  // these through budget-transition-fixtures would certify a path production cannot run.
  it.todo("GATED PENDING task-a91e9fe2: serves PARTIAL for a production-applied lower-bound receipt");
  it.todo("GATED PENDING task-a91e9fe2: serves measured-COMPLETE after a production-applied settlement");
});
