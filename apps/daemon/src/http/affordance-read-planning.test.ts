import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE,
  POLICY_SLICE,
  PROVIDER_OBSERVATION,
  fixtureBudgetCommitmentFor,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { finalizeChain, planningChain } from "../orchestrator/demo-seed-payloads.js";
import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
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
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS });
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
    commitBootstrap("project.activate", {
      witness: {
        artifactPathRef: "artifact-1", backupPathRef: "backup-1",
        credentialRef: "credential-1", distributionManifestHash: "cafe".padEnd(64, "0"),
        policyRevisionHash: "face".padEnd(64, "0"),
        providerMinimumProfileRef: "provider-profile-1", signingKeyRef: "signing-1",
        storeDriverRef: "store-driver-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 2);
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
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS });
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
    commitAbsent("project.activate", {
      witness: {
        artifactPathRef: "artifact-1", backupPathRef: "backup-1",
        credentialRef: "credential-1", distributionManifestHash: "cafe".padEnd(64, "0"),
        policyRevisionHash: "face".padEnd(64, "0"),
        providerMinimumProfileRef: "provider-profile-1", signingKeyRef: "signing-1",
        storeDriverRef: "store-driver-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 2);
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
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS });
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
    commitR3("project.activate", {
      witness: {
        artifactPathRef: "artifact-r3-10", backupPathRef: "backup-r3-10",
        credentialRef: "credential-r3-10", distributionManifestHash: "cafe".padEnd(64, "0"),
        policyRevisionHash: "face".padEnd(64, "0"),
        providerMinimumProfileRef: "provider-profile-r3-10", signingKeyRef: "signing-r3-10",
        storeDriverRef: "store-driver-r3-10", truthClass: "DAEMON_VERIFIED",
      },
    }, 2);
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
