import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import {
  GOAL_ID as REJECT_GOAL,
  PROJECT_ID as REJECT_PROJECT,
  approveGate1,
  boundWorld,
  closeStores,
  committedRevision,
  rejectedWorld,
  submit,
} from "../planning/plan-reject-test-fixtures.js";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE,
  POLICY_SLICE,
  PROVIDER_OBSERVATION,
  fixtureBudgetCommitmentFor,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { FIXTURE_ACTIVATION_RECEIPTS } from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { finalizeChain, planningChain } from "../orchestrator/demo-seed-payloads.js";
import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { resolvePlanningAuthorities } from "./affordance-planning-authorities.js";
import type { PlanningAuthorityEntry } from "./affordance-planning-authorities.js";
import {
  DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT, createAffordancePort,
} from "./affordance-read.js";

/**
 * plan.propose is TWO commits on one card: the planning chain seals the plan, and a second
 * request carries the finalize terminal that moves the run to PLAN_REVIEW - the lifecycle
 * approval demands (task-2cc6c59d, APPROVAL_RUN_NOT_REVIEWABLE). The surface must say which
 * of the two the daemon is waiting for, or the board offers approval.decide against a run the
 * daemon will refuse. This suite drives the default subjects the live board addresses.
 */

const PROJECT = "proj-affordance-planning";
/** The goal that does NOT own the board's run: its derived run is `run-affordance-fresh`. */
const DECOY_GOAL_COMMAND = "affordance-fresh";
const DECOY_GOAL_SUBJECT = `goal-${DECOY_GOAL_COMMAND}`;
/** Command `live-1` mints `goal-live-1` and `run-live-1`, the pair the live board addresses. */
const BOARD_GOAL_COMMAND = "live-1";
const directory = mkdtempSync(join(tmpdir(), "moe-affordance-planning-"));
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
installTestRecoveryBinding(store);

let minted = 0;
const port = createAffordancePort({
  mintId: () => `afford-${String(minted += 1)}`,
  projectId: PROJECT,
  store,
});

afterAll(() => {
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();

/** `commandId` is nameable because `goal.create` derives the goal it mints from it. */
function commitBootstrap(
  kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-${kind}-${String(minted += 1)}`,
    correlationId: "corr-1",
    decidedAt: "2026-08-22T12:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: "operator-local",
    projectId: PROJECT,
    schemaVersion: "moe-bootstrap-command/1",
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
  if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
}

function step(kind: string) {
  const result = port.readSurface();
  if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
  const found = result.steps.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no step for ${kind}`);
  return {
    offered: result.nextAllowedCommands.filter((entry) =>
      entry.commandKind === kind && entry.targetAggregateId === found.aggregateId),
    step: found,
  };
}

const sealed = journeyAuthority({
  authorRef: "operator-local",
  criterionIds: [`${DEFAULT_GOAL_SUBJECT}-criterion`],
  graphRevisionRef: "graph-revision-1",
  idPrefix: DEFAULT_RUN_SUBJECT,
  nodeIds: ["node-code-1"],
  stepDescription: "Land the live board's demo node.",
});

describe("plan.propose on the surface", () => {
  it("stays READY at its advanced version after the planning chain alone, holding approval back", () => {
    commitBootstrap("project.register", { owner: "operator-local" });
    commitBootstrap("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-1",
        scopeRef: "scope-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commitBootstrap("provider.probe", { observation: PROVIDER_OBSERVATION });
    commitBootstrap("policy.install", {
      slice: POLICY_SLICE,
    });
    // The finalize terminal refuses a run no installed policy can tier (task-a888038d), so this
    // world installs the risk-classifying table too or its proposal never reaches PLAN_REVIEW.
    commitBootstrap("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    commitBootstrap("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
    // TWO goals, so the binding cannot be read as scan order or as a default name. Each goal
    // now OWNS its planning run - the writer derives `run-${subject}` from the goal it mints -
    // so only the goal minted by command `live-1` pairs with the run this board addresses.
    commitBootstrap(
      "goal.create",
      { instructions: "A goal on another planning run.", title: "Decoy goal" },
      0,
      DECOY_GOAL_COMMAND,
    );
    commitBootstrap(
      "goal.create",
      { instructions: "Carry the live board's planning run.", title: "Live board goal" },
      0,
      BOARD_GOAL_COMMAND,
    );
    const boundSurface = port.readSurface();
    if (boundSurface.outcome !== "SURFACE") throw new Error(`refused: ${boundSurface.code}`);
    expect(boundSurface.planningGoalRef).toBe(DEFAULT_GOAL_SUBJECT);
    expect(boundSurface.planningGoalRef).not.toBe(DECOY_GOAL_SUBJECT);
    expect(step("plan.propose").step).toMatchObject({
      aggregateId: DEFAULT_RUN_SUBJECT, status: "READY", version: 0,
    });

    commitBootstrap("plan.propose", {
      commands: [
        {
          commandId: "live-create", expectedVersion: 0, goalRef: DEFAULT_GOAL_SUBJECT,
          kind: "planning.create_draft", runId: DEFAULT_RUN_SUBJECT, runKind: "INITIAL",
        },
        {
          commandId: "live-ready", expectedVersion: 1, kind: "planning.ready",
          witness: {
            acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
            planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          commandId: "live-claim", expectedVersion: 2, kind: "planning.claim",
          witness: {
            attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
            providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          authority: sealed.authority,
          graphContentBytesBase64: sealed.graphContentBytesBase64,
          commandId: "live-propose",
          effectTerminalProof: {
            effectTerminalRef: "effect-terminal-1",
            resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED",
          },
          expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
          submissionHash: sealed.submissionHash,
          witness: {
            attemptRef: "attempt-1", submissionRef: "submission-1",
            truthClass: "DAEMON_VERIFIED",
          },
        },
      ],
      runId: DEFAULT_RUN_SUBJECT,
    });

    // Sealed, not reviewable: the card is still the operator's to finish, at the version the
    // finalize must be dispatched against, and approval.decide names it as what is missing.
    const proposed = step("plan.propose");
    expect(proposed.step).toMatchObject({
      aggregateId: DEFAULT_RUN_SUBJECT, missing: [], status: "READY", version: 1,
    });
    expect(proposed.offered).toHaveLength(1);
    expect(proposed.offered[0]).toMatchObject({
      expectedVersion: 1, targetAggregateId: DEFAULT_RUN_SUBJECT,
    });
    expect(step("approval.decide").step).toMatchObject({
      missing: ["plan.propose"], status: "BLOCKED",
    });
    expect(step("approval.decide").offered).toHaveLength(0);
  });

  it("commits once the finalize terminal lands, and only then offers approval.decide", () => {
    commitBootstrap("plan.propose", {
      commands: [
        {
          commandId: "live-finalize", expectedVersion: 4,
          kind: "planning.finalize_submission",
          revision: {
            dependencyHash: "d1".padEnd(64, "0"),
            // BIN A: the world moved, the subject did not. This suite is about the SURFACE
            // offering plan.propose then approval.decide; it never asserted on the graph hash.
            // The placeholder is retired because the envelope cross-checks this against the
            // sealed revision's own binding (PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH).
            graphContentHash: sealed.graphContentHash,
            graphRevisionRef: "graph-revision-1", planHash: sealed.submissionHash,
            qualityHash: "dd".padEnd(64, "0"),
          },
          witness: {
            attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
            nodeSummaries: [{ executionBearing: true, nodeKey: "node-code-1" }],
            providerSlotTerminalRef: "slot-terminal-1",
            resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED",
          },
        },
      ],
      runId: DEFAULT_RUN_SUBJECT,
    }, 1);

    expect(step("plan.propose").step).toMatchObject({
      aggregateId: DEFAULT_RUN_SUBJECT, status: "COMMITTED", version: 2,
    });
    expect(step("plan.propose").offered).toHaveLength(0);
    const approval = step("approval.decide");
    expect(approval.step).toMatchObject({
      aggregateId: DEFAULT_RUN_SUBJECT, missing: [], status: "READY", version: 2,
    });
    expect(approval.offered).toHaveLength(1);
  });
});

/**
 * DISCRIMINATES DERIVATION FROM HARDCODING - not a robustness arm, and not redundant with :124.
 * The arms at :124-125 sit on a FIXED POINT: this file imports DEFAULT_GOAL_SUBJECT from the
 * module under test, and `goal-${BOARD_GOAL_COMMAND}` is that same literal byte for byte, so a
 * producer that reads nothing and returns the constant passes both. This is the only arm here
 * that such a producer fails. Deleting it silently restores that producer's invisibility.
 */
describe("planningGoalRef when no goal owns the board's run", () => {
  const ABSENT_PROJECT = "proj-affordance-planning-absent";
  const absentDirectory = mkdtempSync(join(tmpdir(), "moe-affordance-planning-absent-"));
  const absentStore = SqliteEventStore.openForProject(
    join(absentDirectory, "store.db"), ABSENT_PROJECT);
  installTestRecoveryBinding(absentStore);

  let absentMinted = 0;
  const absentPort = createAffordancePort({
    mintId: () => `afford-absent-${String(absentMinted += 1)}`,
    projectId: ABSENT_PROJECT,
    store: absentStore,
  });

  afterAll(() => {
    absentStore.close();
    rmSync(absentDirectory, { force: true, recursive: true });
  });

  function commitAbsent(
    kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
  ): void {
    const outcome = runBootstrapCommand(absentStore, encoder.encode(JSON.stringify({
      commandId: commandId ?? `cmd-${kind}-${String(absentMinted += 1)}`,
      correlationId: "corr-1",
      decidedAt: "2026-08-22T12:00:00.000Z",
      expectedVersion,
      kind,
      payload,
      principalId: "operator-local",
      projectId: ABSENT_PROJECT,
      schemaVersion: "moe-bootstrap-command/1",
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
    if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
  }

  it("offers no planning identity when the project has zero durable goals", () => {
    const fresh = absentPort.readSurface();
    if (fresh.outcome !== "SURFACE") throw new Error(`refused: ${fresh.code}`);
    expect(fresh.planningGoalRefs).toEqual({});
    expect(fresh.planningGoalRef).toBeNull();
    expect(fresh.nextAllowedCommands.filter((offer) =>
      offer.commandKind === "plan.propose"
      || offer.commandKind === "approval.decide"
      || offer.commandKind === "goal.close")).toEqual([]);
  });

  it("binds nothing when the only goal owns another planning run", () => {
    commitAbsent("project.register", { owner: "operator-local" });
    commitAbsent("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-1",
        scopeRef: "scope-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commitAbsent("provider.probe", { observation: PROVIDER_OBSERVATION });
    commitAbsent("policy.install", { slice: POLICY_SLICE });
    commitAbsent("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    commitAbsent("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
    // ONLY the decoy. `goal.create` derives the run from the goal it mints, so this world holds
    // `goal-affordance-fresh` bound to `run-affordance-fresh` and NOTHING bound to
    // DEFAULT_RUN_SUBJECT. A deriving producer answers null; a hardcoding one answers
    // DEFAULT_GOAL_SUBJECT, and a producer that ignores the run match answers the decoy.
    commitAbsent(
      "goal.create",
      { instructions: "A goal on another planning run.", title: "Decoy goal" },
      0,
      DECOY_GOAL_COMMAND,
    );
    const surface = absentPort.readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(`refused: ${surface.code}`);
    expect(surface.planningGoalRef).toBeNull();
    const proposed = surface.steps.find((entry) => entry.kind === "plan.propose");
    const offered = surface.nextAllowedCommands.find((entry) =>
      entry.commandKind === "plan.propose");
    // The compatibility card must ride the one durable per-goal binding when there is
    // exactly one. A READY card on run-live-1 beside an offer on another run is inert:
    // the control room correctly refuses to author a payload without an exact binding.
    expect(proposed).toMatchObject({
      aggregateId: `run-${DECOY_GOAL_COMMAND}`, status: "READY", version: 0,
    });
    expect(offered?.targetAggregateId).toBe(proposed?.aggregateId);
  });
});

describe("planning offers are bound per durable goal (task-4451675e / R3-10)", () => {
  const projectId = "proj-affordance-planning-r3-10";
  const runId = `run-${DECOY_GOAL_COMMAND}`;
  const path = mkdtempSync(join(tmpdir(), "moe-affordance-planning-r3-10-"));
  const r3Store = SqliteEventStore.openForProject(join(path, "store.db"), projectId);
  installTestRecoveryBinding(r3Store);
  let r3Minted = 0;
  const r3Port = createAffordancePort({
    mintId: () => `r3-offer-${String(r3Minted += 1)}`,
    projectId,
    store: r3Store,
  });
  const decoyAuthority = journeyAuthority({
    authorRef: "operator-local",
    criterionIds: [`${DECOY_GOAL_SUBJECT}-criterion`],
    graphRevisionRef: "r3-graph-revision-1",
    idPrefix: runId,
    nodeIds: ["r3-node-code-1"],
    stepDescription: "Plan the second durable goal.",
  });

  afterAll(() => {
    r3Store.close();
    rmSync(path, { force: true, recursive: true });
  });

  function commitR3(
    kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
  ): void {
    const outcome = runBootstrapCommand(r3Store, encoder.encode(JSON.stringify({
      commandId: commandId ?? `r3-${kind}-${String(r3Minted += 1)}`,
      correlationId: "corr-r3-10",
      decidedAt: "2026-08-28T12:00:00.000Z",
      expectedVersion,
      kind,
      payload,
      principalId: "operator-local",
      projectId,
      schemaVersion: "moe-bootstrap-command/1",
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
    if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
  }

  function surface() {
    const result = r3Port.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }

  function offerTargets(kind: string): string[] {
    return surface().nextAllowedCommands
      .filter((offer) => offer.commandKind === kind)
      .map((offer) => offer.targetAggregateId)
      .sort();
  }

  function createTwoGoals(): void {
    commitR3("project.register", { owner: "operator-local" });
    commitR3("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-r3-10",
        scopeRef: "scope-r3-10", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commitR3("provider.probe", { observation: PROVIDER_OBSERVATION });
    commitR3("policy.install", { slice: POLICY_SLICE });
    commitR3("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    commitR3("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
    commitR3("goal.create", {
      instructions: "Carry the live board's planning run.", title: "Live board goal",
    }, 0, BOARD_GOAL_COMMAND);
    commitR3("goal.create", {
      instructions: "Plan a second durable goal.", title: "Second goal",
    }, 0, DECOY_GOAL_COMMAND);
  }

  function sealDecoyPlan(): void {
    commitR3("plan.propose", {
      commands: [
        {
          commandId: "r3-create", expectedVersion: 0, goalRef: DECOY_GOAL_SUBJECT,
          kind: "planning.create_draft", runId, runKind: "INITIAL",
        },
        {
          commandId: "r3-ready", expectedVersion: 1, kind: "planning.ready",
          witness: {
            acceptanceCriteriaRef: "criteria-r3", intentBaseRef: "intent-r3",
            planningBudgetRef: "budget-r3", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          commandId: "r3-claim", expectedVersion: 2, kind: "planning.claim",
          witness: {
            attemptRef: "attempt-r3", contextRef: "context-r3", leaseRef: "lease-r3",
            providerSlotRef: "slot-r3", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          authority: decoyAuthority.authority,
          commandId: "r3-propose",
          graphContentBytesBase64: decoyAuthority.graphContentBytesBase64,
          effectTerminalProof: {
            effectTerminalRef: "effect-terminal-r3",
            resourcesTerminalRef: "resources-terminal-r3", truthClass: "DAEMON_VERIFIED",
          },
          expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
          submissionHash: decoyAuthority.submissionHash,
          witness: {
            attemptRef: "attempt-r3", submissionRef: "submission-r3",
            truthClass: "DAEMON_VERIFIED",
          },
        },
      ],
      runId,
    });
    commitR3("plan.propose", {
      commands: [{
        commandId: "r3-finalize", expectedVersion: 4,
        kind: "planning.finalize_submission",
        revision: {
          dependencyHash: "d1".padEnd(64, "0"),
          graphContentHash: decoyAuthority.graphContentHash,
          graphRevisionRef: "r3-graph-revision-1",
          planHash: decoyAuthority.submissionHash,
          qualityHash: "dd".padEnd(64, "0"),
        },
        witness: {
          attemptTerminalRef: "attempt-terminal-r3", effectTerminalRef: "effect-terminal-r3",
          nodeSummaries: [{ executionBearing: true, nodeKey: "r3-node-code-1" }],
          providerSlotTerminalRef: "slot-terminal-r3",
          resourcesTerminalRef: "resources-terminal-r3", truthClass: "DAEMON_VERIFIED",
        },
      }],
      runId,
    }, 1);
  }

  it("offers plan.propose exactly once for each durable goal's run", () => {
    createTwoGoals();

    const offers = surface().nextAllowedCommands
      .filter((offer) => offer.commandKind === "plan.propose")
      .sort((left, right) => left.targetAggregateId.localeCompare(right.targetAggregateId));
    expect(offers.map((offer) => offer.targetAggregateId)).toEqual([
      runId, DEFAULT_RUN_SUBJECT,
    ].sort());
    expect(offers.map((offer) => [offer.targetAggregateId, offer.expectedVersion])).toEqual([
      [runId, 0], [DEFAULT_RUN_SUBJECT, 0],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))));
    expect(new Set(offers.map((offer) => offer.commandId)).size).toBe(2);
    expect(new Set(offers.map((offer) => offer.targetAggregateId)).size).toBe(offers.length);
  });

  it("answers the owning goal independently for every planning run", () => {
    expect(surface().planningGoalRefs).toEqual({
      [DEFAULT_RUN_SUBJECT]: DEFAULT_GOAL_SUBJECT,
      [runId]: DECOY_GOAL_SUBJECT,
    });
  });

  it("advances only the planned goal's run to approval", () => {
    sealDecoyPlan();

    expect(offerTargets("plan.propose")).toEqual([DEFAULT_RUN_SUBJECT]);
    expect(offerTargets("approval.decide")).toEqual([runId]);
  });

  it("offers goal.close only for the goal whose run was approved", () => {
    commitR3("approval.decide", {
      activation: {
        activationRef: "activation-r3", expectedGoalVersion: 1,
        goalDraftNoActiveRevision: true, graphHash: "6a".padEnd(64, "0"),
        policyHash: "b1".padEnd(64, "0"), qualityHash: "dd".padEnd(64, "0"),
        truthClass: "HUMAN_APPROVED",
      },
      command: {
        decision: "APPROVE", decisionReason: "approve the second goal",
        kind: "approval.decide", stepUpAuthRef: "stepup-r3",
      },
      graphRevisionRef: "r3-graph-revision-1",
      record: {
        actor: "operator-local", actorKind: "HUMAN",
        applicablePolicyRef: "aa".padEnd(64, "0"), approvalRef: "approval-r3",
        approvedNodeScope: ["r3-node-code-1"],
        // task-61a2e8ad: activation binds back to this value; read it for THIS world.
        budgetRef: fixtureBudgetCommitmentFor(
          r3Store, DECOY_GOAL_SUBJECT, "r3-graph-revision-1", projectId,
        ),
        criteriaRef: "cc".padEnd(64, "0"), decision: null, decisionReason: null,
        dependencyChanges: { additions: [], challenges: [], removals: [] },
        exactRevisionHash: decoyAuthority.submissionHash, lifecycle: "PENDING",
        planQualityAssessmentRef: "dd".padEnd(64, "0"), policyDecisionRef: null,
        riskTier: "R2", stepUpAuthRef: "stepup-r3", truthClass: "HUMAN_APPROVED",
        validity: "CURRENT",
      },
      runId,
    });

    expect(offerTargets("goal.close")).toEqual([DECOY_GOAL_SUBJECT]);
  });

  it("fails closed when a planning run durably names a different goal", () => {
    const mismatched = {
      correlationId: "corr-r3-mismatched-goal",
      decidedAt: "2026-08-28T12:00:00.000Z",
      // No approval is planned or driven here, so the honest commitment is "none held".
      budgetRef: null,
      goalId: DECOY_GOAL_SUBJECT,
      node: {
        instructions: "This run names the wrong durable goal.",
        nodeRef: "r3-mismatch-node-1",
        test: "pnpm test",
        title: "Mismatched goal",
        workspace: ".",
      },
      principalId: "operator-local",
      projectId,
      runId: DEFAULT_RUN_SUBJECT,
    };
    commitR3("plan.propose", {
      commands: planningChain(mismatched), runId: DEFAULT_RUN_SUBJECT,
    });
    commitR3("plan.propose", {
      commands: finalizeChain(mismatched), runId: DEFAULT_RUN_SUBJECT,
    }, 1);

    expect(surface().planningGoalRefs).toEqual({ [runId]: DECOY_GOAL_SUBJECT });
    expect(offerTargets("approval.decide")).toEqual([]);
  });
});

/**
 * task-ed89967f / R3-016 — the canonical per-run planning authority the surface carries so the
 * browser never ports a Node-only codec or rotates a static digest.
 *
 * THE MATERIAL IS journeyAuthority's, VERBATIM. This suite grades BINDING — which run, which
 * goal, which revision, which author — and never re-derives a hash. A test that recomputed
 * graphContentHash would be grading its own copy of the producer, which is the second-verifier
 * defect the whole carrier exists to avoid.
 */
describe("planningAuthorityByRun (task-ed89967f / R3-016)", () => {
  const projectId = "proj-affordance-authority";
  /** The daemon's CONFIGURED principal: rail 2's only admitted author. */
  const PRINCIPAL = "principal-configured-1";
  /**
   * The REGISTERED project owner, deliberately different from PRINCIPAL and from the command
   * issuer below. Every other world in this file spells all three "operator-local", where a
   * producer reaching for the owner and one reading the configured principal are literally
   * indistinguishable — so provenance could not be graded there at all.
   */
  const OWNER_DECOY = "project-owner-decoy";
  /** A THIRD identity: whoever issued the durable commands. Not an author either. */
  const COMMAND_ISSUER = "operator-local";
  const NODE = { dependsOn: [], nodeRef: "node-authority-1", title: "The single merged node" };
  const SECOND_NODE = { dependsOn: [], nodeRef: "node-authority-2", title: "A second merged node" };
  const ALPHA_COMMAND = "authority-alpha";
  const BETA_COMMAND = "authority-beta";
  const ALPHA_GOAL = `goal-${ALPHA_COMMAND}`;
  const ALPHA_RUN = `run-${ALPHA_COMMAND}`;
  const BETA_GOAL = `goal-${BETA_COMMAND}`;
  const BETA_RUN = `run-${BETA_COMMAND}`;
  /**
   * Spelled out here, NOT imported from the module under test. An imported roster moves with the
   * very mutation it exists to catch: delete a key from the production constant and both sides of
   * the set equality shrink together, leaving the arm green.
   */
  const AUTHORITY_KEYS: readonly string[] = [
    "authority", "goalRef", "graphContentBytesBase64", "graphContentHash",
    "graphRevisionRef", "runId", "submissionHash",
  ];
  /**
   * DoD 2's exact eligible pair. `goal.close` and the two compiler kinds are NOT here and target
   * the GOAL aggregate, which is what the withheld-lane arm below proves cannot become a key.
   * `approval.decide_intent` is omitted deliberately: it is always co-offered with
   * `approval.decide` against the SAME run, so including it could not change any key set.
   */
  const ELIGIBLE_KINDS: readonly string[] = ["approval.decide", "plan.propose"];

  const authorityDirectory = mkdtempSync(join(tmpdir(), "moe-affordance-authority-"));
  const authorityStore = SqliteEventStore.openForProject(
    join(authorityDirectory, "store.db"), projectId);
  installTestRecoveryBinding(authorityStore);

  afterAll(() => {
    authorityStore.close();
    rmSync(authorityDirectory, { force: true, recursive: true });
  });

  let authorityMinted = 0;
  const mintId = (): string => `authority-offer-${String(authorityMinted += 1)}`;

  /** The COMPOSED shape: configured principal plus the merged-node roster the composition root
   *  forwards. Every fail-closed port below differs from this one by exactly one input. */
  const port = createAffordancePort({
    mintId, nodes: () => [NODE], principalId: PRINCIPAL, projectId, store: authorityStore,
  });

  function commitAuthority(
    kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
  ): void {
    const outcome = runBootstrapCommand(authorityStore, encoder.encode(JSON.stringify({
      commandId: commandId ?? `authority-${kind}-${String(authorityMinted += 1)}`,
      correlationId: "corr-r3-016",
      decidedAt: "2026-09-02T12:00:00.000Z",
      expectedVersion,
      kind,
      payload,
      principalId: COMMAND_ISSUER,
      projectId,
      schemaVersion: "moe-bootstrap-command/1",
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
    if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
  }

  function read() {
    const result = port.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }

  /**
   * Derived from the OFFERS, never from the map. A set built by iterating the map can only ever
   * prove "every key is a key" — it sees ONE direction and stays green when a member is silently
   * dropped, which is exactly the mutation drill 3 performs.
   */
  function eligibleOfferedRuns(surface: {
    readonly nextAllowedCommands: readonly { readonly commandKind: string;
      readonly targetAggregateId: string }[];
  }): string[] {
    return [...new Set(surface.nextAllowedCommands
      .filter((entry) => ELIGIBLE_KINDS.includes(entry.commandKind))
      .map((entry) => entry.targetAggregateId))].sort();
  }

  function planRevisionOf(entry: PlanningAuthorityEntry): Record<string, unknown> {
    return entry.authority["planRevision"] as Record<string, unknown>;
  }

  function acceptanceContractOf(entry: PlanningAuthorityEntry): Record<string, unknown> {
    return entry.authority["acceptanceContract"] as Record<string, unknown>;
  }

  function createTwoLegacyGoals(): void {
    commitAuthority("project.register", { owner: OWNER_DECOY });
    commitAuthority("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-r3-016",
        scopeRef: "scope-r3-016", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commitAuthority("provider.probe", { observation: PROVIDER_OBSERVATION });
    commitAuthority("policy.install", { slice: POLICY_SLICE });
    commitAuthority("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    commitAuthority("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
    // TWO goals on the legacy lane, so both runs carry an eligible plan.propose offer and the
    // sibling-isolation arm has two entries that must differ in every bound field.
    commitAuthority("goal.create", {
      instructions: "Carry the first durable planning run.", title: "Alpha goal",
    }, 0, ALPHA_COMMAND);
    commitAuthority("goal.create", {
      instructions: "Carry the second durable planning run.", title: "Beta goal",
    }, 0, BETA_COMMAND);
  }

  it("carries exactly the seven-key authority roster on every entry", () => {
    createTwoLegacyGoals();
    const entries = Object.values(read().planningAuthorityByRun);

    // Non-vacuity: a producer returning {} would satisfy a bare for-loop silently.
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // Object.keys is OWN enumerable keys only, so a prototype-borrowed member cannot be
      // counted as carried material.
      expect(Object.keys(entry).sort()).toEqual([...AUTHORITY_KEYS].sort());
      expect(Object.keys(entry)).toHaveLength(7);
    }
  });

  it("keys the map on exactly the eligible offered runs, in both directions and nonzero", () => {
    const surface = read();
    const offered = eligibleOfferedRuns(surface);
    const keys = Object.keys(surface.planningAuthorityByRun).sort();

    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toEqual([ALPHA_RUN, BETA_RUN].sort());
    // Stated as two explicit directions so a drill's red names WHICH direction broke.
    expect(offered.filter((runId) => !(runId in surface.planningAuthorityByRun))).toEqual([]);
    expect(keys.filter((runId) => !offered.includes(runId))).toEqual([]);
    expect(keys).toEqual(offered);
  });

  it("binds every entry to its own run, goal, revision and configured author", () => {
    const surface = read();
    const bound = Object.entries(surface.planningAuthorityByRun);
    expect(bound).toHaveLength(2);

    for (const [runId, entry] of bound) {
      expect(entry.runId).toBe(runId);
      expect(surface.nextAllowedCommands.some((offer) =>
        offer.commandKind === "plan.propose" && offer.targetAggregateId === runId)).toBe(true);
      expect(entry.goalRef).toBe(surface.planningGoalRefs[runId]);
      expect(entry.graphRevisionRef).toBe(`${runId}-graph-revision`);

      const plan = planRevisionOf(entry);
      const contract = acceptanceContractOf(entry);
      expect(plan["authorRef"]).toBe(PRINCIPAL);
      expect(contract["authorRef"]).toBe(PRINCIPAL);
      expect(plan["revisionId"]).toBe(`${runId}-revision`);
      expect(contract["contractId"]).toBe(`${runId}-contract`);
      expect(plan["affectedCriterionIds"]).toEqual([`${entry.goalRef}-criterion`]);
      expect(plan["affectedNodeIds"]).toEqual([NODE.nodeRef]);
      expect((contract["obligations"] as readonly { criterionId: string }[])
        .map((obligation) => obligation.criterionId)).toEqual([`${entry.goalRef}-criterion`]);
      // The digests are CARRIED, not recomputed here: what is graded is that the entry's own
      // sibling fields name the same graph the sealed bodies bind to.
      expect(plan["graphBinding"]).toEqual({
        graphContentHash: entry.graphContentHash, graphRevisionRef: entry.graphRevisionRef,
      });
      expect(contract["applicability"]).toMatchObject({
        graphContentHash: entry.graphContentHash, graphRevisionRef: entry.graphRevisionRef,
        nodeIds: [NODE.nodeRef],
      });
      expect(plan["planHash"]).toBe(entry.submissionHash);
    }
  });

  it("gives two sibling runs distinct, correctly bound material", () => {
    const map = read().planningAuthorityByRun;
    const alpha = map[ALPHA_RUN];
    const beta = map[BETA_RUN];
    if (alpha === undefined || beta === undefined) throw new Error("both siblings must be keyed");

    expect([alpha.runId, alpha.goalRef]).toEqual([ALPHA_RUN, ALPHA_GOAL]);
    expect([beta.runId, beta.goalRef]).toEqual([BETA_RUN, BETA_GOAL]);
    // DISTINCT IN EVERY RUN-BOUND FIELD. A fixture where the siblings shared any of these could
    // not detect drill 2's goal swap — the swapped value would collide with the correct one.
    expect(alpha.runId).not.toBe(beta.runId);
    expect(alpha.goalRef).not.toBe(beta.goalRef);
    expect(alpha.graphRevisionRef).not.toBe(beta.graphRevisionRef);
    expect(alpha.submissionHash).not.toBe(beta.submissionHash);
    // AND SHARED IN THE CONTENT-ADDRESSED PAIR, pinned deliberately rather than left unstated.
    // The journey graph is a single execution-bearing node with the same author, and
    // `planExecutionContentDigest` folds only {affectedCriterionIds, affectedNodeIds, steps,
    // verificationRecipeRefs, version} — all fixed constants inside `nodePlanning`. So two runs
    // planning the same node seal byte-identical graph content, which is what content addressing
    // MEANS. Recorded here so a consumer never mistakes the graph pair for a run discriminator:
    // the run-discriminating members are runId, goalRef, graphRevisionRef and submissionHash.
    expect(alpha.graphContentHash).toBe(beta.graphContentHash);
    expect(alpha.graphContentBytesBase64).toBe(beta.graphContentBytesBase64);
    expect(planRevisionOf(alpha)["affectedCriterionIds"]).toEqual([`${ALPHA_GOAL}-criterion`]);
    expect(planRevisionOf(beta)["affectedCriterionIds"]).toEqual([`${BETA_GOAL}-criterion`]);
  });

  it("authors with the configured principal, not the project owner or the command issuer", () => {
    const entries = Object.values(read().planningAuthorityByRun);
    expect(entries).toHaveLength(2);
    // The decoy is a REAL, distinct durable fact, so the negatives below are not vacuous.
    expect(new Set([PRINCIPAL, OWNER_DECOY, COMMAND_ISSUER]).size).toBe(3);

    for (const entry of entries) {
      // POSITIVE FIRST: a negative-only check passes when the author field is absent entirely.
      expect(planRevisionOf(entry)["authorRef"]).toBe(PRINCIPAL);
      expect(acceptanceContractOf(entry)["authorRef"]).toBe(PRINCIPAL);
      // Supplementary only: a serialized negative tests ONE spelling, never a property.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(OWNER_DECOY);
      expect(serialized).not.toContain(COMMAND_ISSUER);
    }
  });

  it("freezes the map and every entry it carries", () => {
    const map = read().planningAuthorityByRun;
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.values(map)).toHaveLength(2);
    for (const entry of Object.values(map)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("omits every entry when no principal is configured", () => {
    const unconfigured = createAffordancePort({
      mintId, nodes: () => [NODE], projectId, store: authorityStore,
    });
    const surface = unconfigured.readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(`refused: ${surface.code}`);

    expect(surface.planningAuthorityByRun).toEqual({});
    // THE CONTROL that makes {} a refusal rather than an empty world: the same store still
    // offers both eligible runs and still binds both goals. Omission, never DEFAULT_*, the
    // project owner, the command issuer, or a caller-supplied identity.
    expect(eligibleOfferedRuns(surface)).toEqual([ALPHA_RUN, BETA_RUN].sort());
    expect(Object.keys(surface.planningGoalRefs).sort()).toEqual([ALPHA_RUN, BETA_RUN].sort());
  });

  it("omits every entry when the merged node roster is absent, empty or ambiguous", () => {
    const absent = createAffordancePort({
      mintId, principalId: PRINCIPAL, projectId, store: authorityStore,
    });
    const empty = createAffordancePort({
      mintId, nodes: () => [], principalId: PRINCIPAL, projectId, store: authorityStore,
    });
    // TWO nodes is the FIRST-NODE ban: an ambiguous roster omits rather than picking one.
    const ambiguous = createAffordancePort({
      mintId, nodes: () => [NODE, SECOND_NODE], principalId: PRINCIPAL,
      projectId, store: authorityStore,
    });

    for (const candidate of [absent, empty, ambiguous]) {
      const surface = candidate.readSurface();
      if (surface.outcome !== "SURFACE") throw new Error(`refused: ${surface.code}`);
      expect(surface.planningAuthorityByRun).toEqual({});
      expect(eligibleOfferedRuns(surface)).toEqual([ALPHA_RUN, BETA_RUN].sort());
    }
  });

  it("omits a source-bound run whose plan.propose is withheld, and never keys on a goal", () => {
    const sourceOffer = read().nextAllowedCommands
      .find((entry) => entry.commandKind === "goal.create_with_source");
    if (sourceOffer === undefined) throw new Error("no goal.create_with_source offer to drive");
    const compiledGoal = `goal-${sourceOffer.commandId}`;
    const compiledRun = `run-${sourceOffer.commandId}`;

    commitAuthority("goal.create_with_source", {
      instructions: "Compile this brief; do not hand-plan it.",
      source: {
        displayPath: "docs/r3-016-brief.md",
        mediaType: "text/markdown",
        text: `# ${sourceOffer.commandId}\n\nThe compiler ladder owns this goal.\n`,
      },
      title: "Source-bound goal",
    }, 0, sourceOffer.commandId);

    const after = read();
    // THE BINDING EXISTS — this is not a missing-goal world.
    expect(after.planningGoalRefs[compiledRun]).toBe(compiledGoal);
    // But the compiler ladder WITHHOLDS plan.propose and offers the writer against the GOAL.
    expect(after.nextAllowedCommands.some((entry) =>
      entry.commandKind === "product_contract.propose_revision"
      && entry.targetAggregateId === compiledGoal)).toBe(true);
    expect(after.nextAllowedCommands.some((entry) =>
      ELIGIBLE_KINDS.includes(entry.commandKind)
      && entry.targetAggregateId === compiledRun)).toBe(false);

    // So: no entry for that run, and a goal-targeted offer never becomes a key.
    expect(compiledRun in after.planningAuthorityByRun).toBe(false);
    expect(compiledGoal in after.planningAuthorityByRun).toBe(false);
    // TARGETED omission, not a whole-map collapse: the two legacy siblings are untouched.
    expect(Object.keys(after.planningAuthorityByRun).sort())
      .toEqual([ALPHA_RUN, BETA_RUN].sort());
  });

  it("omits a run that carries an eligible offer with no durable goal binding", () => {
    // Structurally unreachable from the surface today: resolvePlanningOffers records
    // planningGoalRefs[run] before it mints any offer for that goal, so an offer without a
    // binding cannot be observed end-to-end. Driven against the REAL production producer (not a
    // reimplementation) so the fail-closed branch is graded rather than assumed reachable.
    const offer = read().nextAllowedCommands
      .find((entry) => entry.commandKind === "plan.propose");
    if (offer === undefined) throw new Error("no plan.propose offer to drive");

    expect(resolvePlanningAuthorities({
      nodes: [NODE], offers: [offer], planningGoalRefs: {}, principalId: PRINCIPAL,
    })).toEqual({});
    // CONTROL: the same offer WITH its binding does produce an entry, so the {} above is the
    // missing binding and not a call shape the producer rejects wholesale.
    expect(Object.keys(resolvePlanningAuthorities({
      nodes: [NODE], offers: [offer], principalId: PRINCIPAL,
      planningGoalRefs: { [offer.targetAggregateId]: ALPHA_GOAL },
    }))).toEqual([offer.targetAggregateId]);
  });
});

/**
 * THE REJECT JOURNEY OVER A REAL STORE, driven end to end by production commands: a PRD-bound
 * goal, a committed revision, Gate 1 approved by a real paired session, the compiler's own
 * INITIAL chain to PLAN_REVIEW, then `approval.decide_intent` REJECT.
 *
 * Every assertion is SET-EQUALITY on the offer targets for a kind, never `toContain`: the defect
 * this closes is an offer that should have DISAPPEARED, and a subset assertion is blind to it.
 */
describe("after a REJECT the surface follows the goal's successor run", () => {
  // Each world is an ephemeral store registered by the fixture's own `openStore`; this releases
  // every one of them, and runs alongside this file's other afterAll rather than replacing it.
  afterAll(closeStores);

  function portOver(world: SqliteEventStore) {
    let issued = 0;
    const bound = createAffordancePort({
      mintId: () => `reject-${String(issued += 1)}`,
      projectId: REJECT_PROJECT,
      store: world,
    });
    return (kind: string): string[] => {
      const result = bound.readSurface();
      if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
      return result.nextAllowedCommands
        .filter((entry) => entry.commandKind === kind)
        .map((entry) => entry.targetAggregateId)
        .sort();
    };
  }

  /** Every offer on the surface as `commandKind@targetAggregateId`, sorted. */
  function offerPairsOver(world: SqliteEventStore): string[] {
    let issued = 0;
    const result = createAffordancePort({
      mintId: () => `reject-pairs-${String(issued += 1)}`,
      projectId: REJECT_PROJECT,
      store: world,
    }).readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result.nextAllowedCommands
      .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`)
      .sort();
  }

  function refsOver(world: SqliteEventStore): Readonly<Record<string, string>> {
    let issued = 0;
    const result = createAffordancePort({
      mintId: () => `reject-refs-${String(issued += 1)}`,
      projectId: REJECT_PROJECT,
      store: world,
    }).readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result.planningGoalRefs;
  }

  it("offers the approval kinds on the compiled run BEFORE the reject", () => {
    // The CONTROL for every arm below: without it, "no decide_intent after the reject" could be
    // green because this world never offered one at all.
    const world = boundWorld();
    const ref = committedRevision(world);
    approveGate1(world, ref);
    const sealed = submit(world, ref);
    if (!sealed.ok) throw new Error(`submit refused: ${sealed.code} @ ${sealed.layer}`);
    const targets = portOver(world);
    expect(targets("approval.decide_intent")).toEqual([sealed.runId]);
    expect(targets("approval.decide")).toEqual([sealed.runId]);
    expect(refsOver(world)).toEqual({ [sealed.runId]: REJECT_GOAL });
  });

  it("WITHHOLDS both approval kinds for the rejected run and offers the compiler instead", () => {
    const world = rejectedWorld("needs two nodes, not one");
    const targets = portOver(world.store);
    // The card the operator just acted on is GONE — not merely re-pointed, and not still there
    // beside a new one: a stale decide_intent is a dispatch the daemon would refuse.
    expect(targets("approval.decide_intent")).toEqual([]);
    expect(targets("approval.decide")).toEqual([]);
    expect(targets("planning.submit_decomposition")).toEqual([world.goalId]);
  });

  it("binds the SUCCESSOR run to the goal, and the rejected run to nothing", () => {
    const world = rejectedWorld("the second slice is missing");
    expect(world.successorRunId).not.toBe(world.originalRunId);
    // EXACT map. The rejected run's key must be absent, or the surface's authority map still
    // binds a run nobody may act on to this goal.
    expect(refsOver(world.store)).toEqual({ [world.successorRunId]: world.goalId });
  });

  it("moves both approval kinds onto the SUCCESSOR once the compiler runs, and re-offers the "
    + "rejected run under NO kind", () => {
    const world = rejectedWorld("the second slice is missing");
    const targets = portOver(world.store);
    // CONTROL, before the compile: the surface is offering the compiler, not an approval. Without
    // this line the assertions below could hold on a surface that had never moved at all.
    expect(targets("planning.submit_decomposition")).toEqual([world.goalId]);

    const compiled = submit(world.store, world.ref);
    if (!compiled.ok) throw new Error(`submit refused: ${compiled.code} @ ${compiled.layer}`);
    // FIRST. `compiled.runId` is what the dispatcher actually wrote to; if the compile had landed
    // back on the rejected run every assertion below would still be readable as "the surface
    // followed the successor" while the plan was sealed onto a run the operator already refused.
    expect(compiled.runId).toBe(world.successorRunId);

    expect(targets("approval.decide_intent")).toEqual([world.successorRunId]);
    expect(targets("approval.decide")).toEqual([world.successorRunId]);
    // The compiler card is spent: the successor is reviewable, so the ladder has moved past it.
    expect(targets("planning.submit_decomposition")).toEqual([]);
    expect(refsOver(world.store)).toEqual({ [world.successorRunId]: world.goalId });

    // SET-EQUALITY OVER THE WHOLE SURFACE, not one kind at a time: "the rejected run is never
    // re-offered" is a claim about EVERY offer, and a per-kind check only sees the kinds it
    // names. Asserting the empty list (rather than `not.toContain`) prints the offending
    // `commandKind@target` pairs verbatim when it fails.
    expect(offerPairsOver(world.store)
      .filter((pair) => pair.endsWith(`@${world.originalRunId}`))).toEqual([]);
  });
});
