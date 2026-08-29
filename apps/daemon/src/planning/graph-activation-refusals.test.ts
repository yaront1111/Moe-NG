/**
 * Every way the atomic active-graph transition REFUSES, by exact code, exact layer, and zero
 * durable residue (task-eacea969 DoD 2 and 4).
 *
 * TWO PROPERTIES ARE ASSERTED TOGETHER EVERYWHERE AND THAT IS DELIBERATE. "It refused" is one
 * added authority away from vacuous — a second layer can start answering first and the arm stays
 * green while no longer testing its subject — so every arm names the code AND the layer. And
 * "it refused" says nothing about what it left behind, so every arm also pins the event horizon
 * and the decision count across the refusal: the service composes the whole move before it
 * commits anything, and that is what makes a refusal residue-free by construction rather than by
 * a cleanup path nobody runs.
 */
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, decisionCount } from "../bootstrap/bootstrap-test-fixtures.js";
import { SERVICE_REFUSED_BY } from "../bootstrap/bootstrap-ledger.js";
import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { seedActivationGraph } from "../activation/activation-world-fixtures.js";
import {
  GRAPH_ACTIVATION_BINDING_CODES,
  GRAPH_ACTIVATION_CLAIM_KEYS,
} from "./graph-activation-binding.js";
import {
  budgetCommitmentDigest,
  budgetCommitmentMaterial,
} from "../budget/budget-commitment.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import type { GraphActivationInput } from "./graph-activation-service.js";
import {
  GRAPH_REVISION_REF,
  activationWitness,
  approvableStore,
  closeStores,
  contextFor,
  inputFor,
  requestFor,
} from "./graph-activation-test-fixtures.js";
import {
  GRAPH_REVISION_ACTIVATION_CODES,
  buildGraphRevisionActivationLeg,
} from "./graph-revision-activation-leg.js";

afterEach(() => {
  closeStores();
});

const REVISION_AGGREGATE = `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`;

/**
 * The claim roster, named as the immutable production constant rather than restated inline. An
 * exact count is the only assertion that survives a member being deleted: `length > 0` is
 * satisfied by a one-member roster, and a matrix built from the roster shrinks silently with it.
 */
const CLAIM_KEYS = GRAPH_ACTIVATION_CLAIM_KEYS;
const CLAIM_KEY_COUNT = 3;

/** A value that is a valid hash or version in SHAPE but is never the one the server derives. */
const WRONG_CLAIM: Readonly<Record<(typeof CLAIM_KEYS)[number], unknown>> = Object.freeze({
  graphHash: "a".repeat(64),
  policyHash: "b".repeat(64),
  qualityHash: "c".repeat(64),
});

const CLAIM_CODES: Readonly<Record<(typeof CLAIM_KEYS)[number], string>> = Object.freeze({
  graphHash: "ACTIVATION_BINDING_GRAPH_HASH_MISMATCH",
  policyHash: "ACTIVATION_BINDING_POLICY_HASH_MISMATCH",
  qualityHash: "ACTIVATION_BINDING_QUALITY_HASH_MISMATCH",
});

function refusalOf(outcome: ServiceOutcome): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, got an accepted decision");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

describe("the roster this matrix is built from is pinned (epic rail 7)", () => {
  it("carries EXACTLY the three comparable binding members, and neither delegated one", () => {
    expect(CLAIM_KEYS).toHaveLength(CLAIM_KEY_COUNT);
    expect([...CLAIM_KEYS]).toStrictEqual(["graphHash", "policyHash", "qualityHash"]);
    // Both absences are delegations with an owner, asserted by their own arms below:
    // `budgetHash` to the budget seam, `expectedGoalVersion` to the goal reducer.
    expect(CLAIM_KEYS).not.toContain("budgetHash");
    expect(CLAIM_KEYS).not.toContain("expectedGoalVersion");
    expect(Object.isFrozen(CLAIM_KEYS)).toBe(true);
  });

  it("pins both refusal vocabularies at their exact size", () => {
    expect(GRAPH_ACTIVATION_BINDING_CODES).toHaveLength(7);
    expect(GRAPH_REVISION_ACTIVATION_CODES).toHaveLength(3);
    // Every layer these two modules can surface must be a member of the roster `refuse` types
    // against, or a refusal could not travel at all.
    for (const layer of ["GRAPH_ACTIVATION_BINDING", "GRAPH_REVISION_ACTIVATION", "GRAPH_REVISION"]) {
      expect(SERVICE_REFUSED_BY, layer).toContain(layer);
    }
  });
});

describe("a caller may identify a target but may not supply the binding (DoD 2)", () => {
  it.each([...CLAIM_KEYS])("refuses a stated %s that contradicts the server's", (key) => {
    const store = approvableStore();
    const horizon = store.readEventHorizon();
    const decisions = decisionCount(store);

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor(`cmd-activate-${key}`)),
      inputFor(store, { activation: activationWitness({ [key]: WRONG_CLAIM[key] }) }),
    );

    expect(refusalOf(outcome)).toStrictEqual({
      code: CLAIM_CODES[key], refusedBy: "GRAPH_ACTIVATION_BINDING",
    });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(decisionCount(store)).toBe(decisions);
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
  });

  it("generated the whole matrix rather than silently sweeping zero cases", () => {
    // A sweep that produces no case passes while testing nothing; the count is the guard.
    expect(CLAIM_KEYS.filter((key) => key in WRONG_CLAIM && key in CLAIM_CODES))
      .toHaveLength(CLAIM_KEY_COUNT);
  });

  it("leaves a stated expectedGoalVersion to the GOAL REDUCER, which owns that comparison", () => {
    const store = approvableStore();
    const horizon = store.readEventHorizon();

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-goal-version")),
      inputFor(store, { activation: activationWitness({ expectedGoalVersion: 7 }) }),
    );

    // A binding-layer code here would be unfalsifiable: the goal command's `expectedVersion` IS
    // this field, so the kernel answers first and a duplicate guard could be deleted unnoticed.
    expect(refusalOf(outcome)).toStrictEqual({
      code: "EXPECTED_VERSION_CONFLICT", refusedBy: "CORE_REDUCER",
    });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
  });

  it("refuses a stated budgetHash under the BUDGET seam's own code, not the binding's", () => {
    const store = approvableStore();
    const horizon = store.readEventHorizon();

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-budget")),
      inputFor(store, { activation: activationWitness({ budgetHash: "d".repeat(64) }) }),
    );

    expect(refusalOf(outcome)).toStrictEqual({
      code: "BOOTSTRAP_BUDGET_HASH_MISMATCH", refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
  });

  it("refuses a run whose seal it cannot read, rather than binding around the gap", () => {
    const store = approvableStore();
    const horizon = store.readEventHorizon();

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-unsealed")),
      inputFor(store, { run: { state: {} } }),
    );

    expect(refusalOf(outcome)).toStrictEqual({
      code: "ACTIVATION_BINDING_RUN_UNSEALED", refusedBy: "GRAPH_ACTIVATION_BINDING",
    });
    expect(store.readEventHorizon()).toBe(horizon);
  });
});

describe("no second ACTIVE revision can be written, under any interleaving (DoD 0)", () => {
  it("refuses when the target revision already has a history at all", () => {
    const store = approvableStore();
    // The world's own hand-seeded ACTIVE revision occupies exactly this aggregate. An initial
    // activation IS an aggregate's whole history, so a non-empty one is not activatable.
    seedActivationGraph(store);
    expect(store.readEvents(REVISION_AGGREGATE).length).toBeGreaterThan(0);
    const horizon = store.readEventHorizon();

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-recorded")), inputFor(store),
    );

    expect(refusalOf(outcome)).toStrictEqual({
      code: "GRAPH_REVISION_ALREADY_RECORDED", refusedBy: "GRAPH_REVISION_ACTIVATION",
    });
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("refuses a FRESH revision while any sibling of the project is ACTIVE", () => {
    const store = approvableStore();
    seedActivationGraph(store);
    const successor = "graph-revision-2";
    expect(store.readEvents(`graph-revision:${PROJECT_ID}:${successor}`)).toHaveLength(0);
    const horizon = store.readEventHorizon();

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-sibling")),
      inputFor(store, { graphRevisionRef: successor }),
    );

    // The empty-aggregate check passed and the PROJECT-WIDE guard is what answered — the reducer
    // is pure and cannot see a sibling, so this refusal has no other possible source.
    expect(refusalOf(outcome)).toStrictEqual({
      code: "GRAPH_REVISION_PROJECT_HAS_ACTIVE", refusedBy: "GRAPH_REVISION_ACTIVATION",
    });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(store.readEvents(`graph-revision:${PROJECT_ID}:${successor}`)).toHaveLength(0);
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === "GoalExecutionEnabled"))
      .toHaveLength(0);
  });
});

describe("a CORE rejection travels under the aggregate that produced it, not a daemon restatement",
  () => {
    it("forwards the reducer's own code under the GRAPH_REVISION layer", () => {
      const store = approvableStore();
      // Driven at the leg builder because every route through the service is answered earlier by
      // a daemon guard; the forwarding is the property under test, not the reachability.
      const built = buildGraphRevisionActivationLeg({
        actorKind: "HUMAN",
        approvalRef: "approval-1",
        binding: {
          budgetHash: "0".repeat(64),
          expectedGoalVersion: 1,
          // NOT 64-hex: `create` refuses the content identity before any lifecycle step.
          graphHash: "not-a-content-hash",
          policyHash: "0".repeat(64),
          qualityHash: "0".repeat(64),
        },
        commandId: "cmd-core-refusal",
        goalRef: GOAL_ID,
        planHash: "0".repeat(64),
        projectId: PROJECT_ID,
        revisionId: "graph-revision-core",
        store,
        submissionRef: "0".repeat(64),
      });

      expect(built.ok).toBe(false);
      if (built.ok) throw new Error("expected a core refusal");
      if (!("error" in built)) throw new Error("expected the core's own RuntimeError");
      expect(built.layer).toBe("GRAPH_REVISION");
      expect(built.error.code).toBe("UNKNOWN_ERROR");
      expect(store.readEvents(`graph-revision:${PROJECT_ID}:graph-revision-core`)).toHaveLength(0);
    });
  });

/**
 * THE SAME BIND-BACK ON THE OTHER ACTIVATION PATH (task-61a2e8ad, ruling comment-87ad84c1
 * condition 3). `graph-activation-service.ts` mints the budget root through the same
 * `resolveApprovalBudgetRoot`, so it must refuse a stale commitment the same way — a guard that
 * held on only one of the two activation seams would be a hole the other path walks through.
 *
 * DIVERGENCE, as epic rail 7(A) requires. The `budgetHash` arm above states
 * `activation.budgetHash` and no `budgetRef`; these arms state `record.budgetRef` and no
 * `budgetHash`. Neither fixture can trip the other's guard, so loosening either leaves the
 * other's arm red.
 */
describe("the approval's decide-time budget commitment is bound back here too", () => {
  function trueCommitment(store: SqliteEventStore, input: GraphActivationInput): string {
    const material = budgetCommitmentMaterial(store, {
      approvedRun: {
        runBinding: input.binding,
        verifiedGraphRevisionRef: input.graphRevisionRef,
      },
      goalRef: GOAL_ID,
      projectId: PROJECT_ID,
    });
    expect(material.ok, material.ok ? "" : `${material.code}@${material.layer}`).toBe(true);
    if (!material.ok) throw new Error(`${material.code}@${material.layer}`);
    return budgetCommitmentDigest(material.material);
  }

  const withBudgetRef = (
    input: GraphActivationInput, budgetRef: string,
  ): GraphActivationInput => ({ ...input, approval: { ...input.approval, budgetRef } });

  // ARM G' — a well-formed-but-wrong commitment refuses by exact code and layer, with a
  // completely unmoved event horizon.
  it("ARM G': refuses a budgetRef that is not this run's commitment, leaving no residue", () => {
    const store = approvableStore();
    const base = inputFor(store);
    const commitment = trueCommitment(store, base);
    const wrong = `${commitment.slice(0, -1)}${commitment.slice(-1) === "0" ? "1" : "0"}`;
    const horizon = store.readEventHorizon();
    const decisions = decisionCount(store);

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-commitment")),
      withBudgetRef(base, wrong),
    );

    expect(refusalOf(outcome)).toStrictEqual({
      code: "BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH", refusedBy: "DAEMON_PREREQUISITE",
    });
    expect(store.readEventHorizon()).toBe(horizon);
    expect(decisionCount(store)).toBe(decisions);
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
  });

  // ARM G', DIVERGENCE HALF: this input states no `budgetHash`, so the root fence is inert and
  // cannot be the mechanism that answered.
  it("ARM G': states no budgetHash, so the root fence is not what refused", () => {
    const store = approvableStore();
    const base = inputFor(store);
    expect(base.activation).not.toHaveProperty("budgetHash");

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-commitment-divergence")),
      withBudgetRef(base, "e".repeat(64)),
    );

    expect(refusalOf(outcome).code).not.toBe("BOOTSTRAP_BUDGET_HASH_MISMATCH");
    expect(refusalOf(outcome).code).toBe("BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH");
  });

  // ARM H' — the matching commitment activates exactly as today.
  it("ARM H': the true commitment activates and mints the root exactly as today", () => {
    const store = approvableStore();
    const base = inputFor(store);

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-commitment-ok")),
      withBudgetRef(base, trueCommitment(store, base)),
    );

    expect(outcome.ok, outcome.ok ? "" : `${outcome.code}@${outcome.refusedBy}`).toBe(true);
    expect(store.readEvents(REVISION_AGGREGATE).length).toBeGreaterThan(0);
  });
});
