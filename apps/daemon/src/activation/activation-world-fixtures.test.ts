/**
 * POSITIVE CONTROLS ON THE SEED ITSELF.
 *
 * This row is a strict no-op under today's production code — nothing reads the durable ACTIVE
 * graph or the authorized budget root yet. That is exactly why "the daemon suite is still
 * green" cannot grade it: a seeder that plants an EMPTY graph, a graph with zero
 * execution-bearing nodes, a root in ledger meter vocabulary, or one that silently plants
 * NOTHING all produce the identical 185/4062 green. The value lands a row later and the gate
 * can only observe the present, so the seed's EFFECT gets its own witnesses here, read back
 * through COMMITTED production readers.
 *
 * Every assertion below is a promotion of something that was previously only prose.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NODE_ADMISSION_METERS } from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";

import { activationAdmissionRef, runActivationBudgetStage } from "./activation-budget-stage.js";
import {
  ACTIVATION_WORLD_AUTHORIZED_AMOUNT,
  ACTIVATION_WORLD_BEARING_NODE_COUNT,
  ACTIVATION_WORLD_GATE_POLICY,
  ACTIVATION_WORLD_METER,
  ACTIVATION_WORLD_NODE_KEY,
  ACTIVATION_WORLD_REVISION_ID,
  seedActivationGraph,
  seedActivationWorld,
  seedActivationWorldWithoutGoal,
  seedActivationWorldWithoutGraph,
} from "./activation-world-fixtures.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import type { ActivationIngressRequest } from "./activation-ingress-contracts.js";

/**
 * WINDOWS HANDLE DISCIPLINE: the store closes in a `finally` INSIDE the temp directory's own
 * `finally`. A handle held across `rmSync` throws EPERM and kills the vitest worker with no
 * output at all.
 */
function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-actworld-${name}-`));
  try {
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
    try {
      return run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

/** Bootstraps the project through the production pipeline, stopping BEFORE `goal.create` so the
 *  fixture's own `ensureSeededGoal` is the thing under test rather than a duplicate. */
const bootstrapped = (store: SqliteEventStore): void => driveThrough(store, "goal.create");

/** Reason code AND refusing layer, never merely "it failed" (global rail 1). */
const refusalOf = (result: { ok: boolean }): readonly [string, string] => {
  const refused = result as { code?: string; layer?: string };
  return [refused.code ?? "UNEXPECTEDLY_ADMITTED", refused.layer ?? "NO_LAYER"];
};

describe("activation world fixture — the seeded graph reads back through production", () => {
  it("uses a real HUMAN_APPROVAL witness and admits the generic activation", () => {
    withStore("human-approval", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);

      const active = readCurrentActiveGraph(store, PROJECT_ID);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(ACTIVATION_WORLD_GATE_POLICY).toBe("HUMAN_APPROVAL");
      expect(active.content.nodeAuthority.definitions).toHaveLength(1);
      expect(active.content.nodeAuthority.definitions[0]?.admissionGatePolicy)
        .toBe("HUMAN_APPROVAL");

      const activationEvents = store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalExecutionEnabled");
      expect(activationEvents).toHaveLength(1);

      const request: ActivationIngressRequest = {
        commandId: "cmd-activate-generic-human-world",
        correlationId: "corr-activate-generic-human-world",
        decidedAt: "2026-08-19T00:00:00.000Z",
        expectedVersion: 0,
        kind: EFFECT_ACTIVATE_COMMAND_KIND,
        payload: {},
        principalId: "principal-1",
        projectId: PROJECT_ID,
        schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
      };
      const result = runActivationBudgetStage({ request, store });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.authority.gateWitnessField).toBe("approval");
      expect(result.budget.reservation.admissionRef)
        .toBe(activationAdmissionRef(request.commandId));
    });
  });

  it("publishes exactly one ACTIVE revision at the expected id", () => {
    withStore("graph-active", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      const active = readCurrentActiveGraph(store, PROJECT_ID);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.revisionId).toBe(ACTIVATION_WORLD_REVISION_ID);
      expect(active.provenance.goalRef).toBe(GOAL_ID);
    });
  });

  it("carries the EXACT execution-bearing node count, so an empty graph cannot pass", () => {
    withStore("graph-bearing", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      const active = readCurrentActiveGraph(store, PROJECT_ID);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      const bearing = active.snapshot.nodes.filter((node) => node.executionBearing);
      // Exact, never `> 0`: a fixture that plants an empty graph satisfies `> 0` vacuously
      // only because there is nothing to count, and that is the defect this pins.
      expect(bearing).toHaveLength(ACTIVATION_WORLD_BEARING_NODE_COUNT);
      expect(bearing.map((node) => node.nodeKey)).toEqual([ACTIVATION_WORLD_NODE_KEY]);
    });
  });

  it("binds the graph body, so the projection is not reading a headless revision", () => {
    withStore("graph-body", (store) => {
      bootstrapped(store);
      const content = seedActivationGraph(store);
      const active = readCurrentActiveGraph(store, PROJECT_ID);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      // The projection refuses ACTIVE_GRAPH_BODY_UNAVAILABLE without a recorded body, so this
      // pins WHICH body: a revision pointing at someone else's content would still be ACTIVE.
      expect(active.graphContentHash).toBe(content.graphContentHash);
      expect(active.content.snapshot.completionNodeKey).toBe(ACTIVATION_WORLD_NODE_KEY);
    });
  });

  it("is IDEMPOTENT: a second seeding does not publish a split brain", () => {
    withStore("graph-idempotent", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      // The worlds this fixture enriches arrive in three different states, and one of them
      // already carries an ACTIVE `graph-revision-1` from the production planning chain.
      // Seeding twice must enrich nothing rather than refuse ACTIVE_GRAPH_SPLIT_BRAIN.
      seedActivationWorld(store);
      const active = readCurrentActiveGraph(store, PROJECT_ID);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.revisionId).toBe(ACTIVATION_WORLD_REVISION_ID);
      expect(store.readEvents(GOAL_ID)
        .filter((event) => event.eventType === "GoalExecutionEnabled"))
        .toHaveLength(1);
    });
  });
});

describe("activation world fixture — the budget root and the meter it must agree with", () => {
  it("authorizes a root the committed ledger projection can read back", () => {
    withStore("budget-root", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
      expect(ledger.ok).toBe(true);
      if (!ledger.ok) return;
      expect(ledger.authorization.amounts).toEqual([
        { meter: ACTIVATION_WORLD_METER, amount: ACTIVATION_WORLD_AUTHORIZED_AMOUNT },
      ]);
    });
  });

  it("funds the root in NODE_ADMISSION_METERS vocabulary, not ledger vocabulary", () => {
    withStore("budget-meter-membership", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
      expect(ledger.ok).toBe(true);
      if (!ledger.ok) return;
      // The ledger's meter is a bounded FREE STRING while the node-authority boundary closes
      // its own list, so `tokens`/`seconds` seed green here and refuse at reserve time. This
      // is the seam, asserted rather than described.
      for (const amount of ledger.authorization.amounts) {
        expect(NODE_ADMISSION_METERS).toContain(amount.meter);
      }
    });
  });

  it("funds the root on the SAME meter the seeded node's admissionAmounts spend", () => {
    withStore("budget-meter-equality", (store) => {
      bootstrapped(store);
      seedActivationWorld(store);
      const active = readCurrentActiveGraph(store, PROJECT_ID);
      const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
      expect(active.ok).toBe(true);
      expect(ledger.ok).toBe(true);
      if (!active.ok || !ledger.ok) return;
      // Membership alone is not enough: a root funded on `attempt.count` is a MEMBER and still
      // has no coverage for a node denominated in `runner.authorized_ms`. Both operands are
      // read back from durable records — neither is the literal the fixture wrote.
      const nodeMeters = new Set(
        active.content.nodeAuthority.definitions
          .flatMap((definition) => definition.admissionAmounts)
          .map((amount) => amount.meter),
      );
      const rootMeters = new Set(ledger.authorization.amounts.map((amount) => amount.meter));
      expect([...rootMeters]).toEqual([...nodeMeters]);
    });
  });
});

describe("activation world fixture — the deliberate negative worlds stay negative", () => {
  it("the no-graph world refuses ACTIVE_GRAPH_ABSENT at the projection layer", () => {
    withStore("negative-graph", (store) => {
      bootstrapped(store);
      seedActivationWorldWithoutGraph(store);
      expect(refusalOf(readCurrentActiveGraph(store, PROJECT_ID))).toEqual([
        "ACTIVE_GRAPH_ABSENT", "ACTIVE_GRAPH_PROJECTION",
      ]);
    });
  });

  it("the no-graph world keeps BUDGET_PROJECTION_GRAPH_UNAVAILABLE reachable", () => {
    withStore("negative-budget-graph", (store) => {
      bootstrapped(store);
      seedActivationWorldWithoutGraph(store);
      // 265 of the 413 failures in the measured flip were this code. A shared fixture that
      // granted EVERY world the happy precondition would leave it with no reachable world,
      // which is a guard that is green forever and killable by deleting the check.
      expect(refusalOf(readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID))).toEqual([
        "BUDGET_PROJECTION_GRAPH_UNAVAILABLE", "BUDGET_CURRENT_PROJECTION",
      ]);
    });
  });

  it("the no-goal world refuses BUDGET_PROJECTION_GOAL_ABSENT, a DIFFERENT branch", () => {
    withStore("negative-goal", (store) => {
      bootstrapped(store);
      seedActivationWorldWithoutGoal(store);
      // Distinct from the no-graph refusal: one cannot stand in for the other, and asserting
      // only "it refused" would let either branch answer for both.
      expect(refusalOf(readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID))).toEqual([
        "BUDGET_PROJECTION_GOAL_ABSENT", "BUDGET_CURRENT_PROJECTION",
      ]);
    });
  });
});
