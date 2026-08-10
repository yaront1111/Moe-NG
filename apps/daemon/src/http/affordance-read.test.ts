import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { runSessionCommand } from "../identity/session-services.js";
import { readAffordanceRequest } from "./affordance-contract.js";
import { DEFAULT_SESSION_SUBJECT, createAffordancePort } from "./affordance-read.js";

const PROJECT = "proj-affordance";
const directory = mkdtempSync(join(tmpdir(), "moe-affordance-"));
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);

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

function commitBootstrap(
  kind: string, payload: Record<string, unknown>, expectedVersion = 0,
): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-${kind}-${String(minted += 1)}`,
    correlationId: "corr-1",
    decidedAt: "2026-08-09T12:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: "operator-local",
    projectId: PROJECT,
    schemaVersion: "moe-bootstrap-command/1",
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS });
  if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
}

function surface() {
  const result = port.readSurface();
  if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
  return result;
}

function step(kind: string) {
  const found = surface().steps.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no step for ${kind}`);
  return found;
}

describe("createAffordancePort", () => {
  it("offers only the chain roots on a fresh ledger, blocking the rest by name", () => {
    expect(step("project.register")).toMatchObject({ status: "READY", version: 0 });
    expect(step("policy.install")).toMatchObject({ status: "READY" });
    expect(step("project.activate")).toMatchObject({
      missing: ["project.register", "project.bind_repository", "provider.probe"],
      status: "BLOCKED",
    });
    expect(step("goal.create")).toMatchObject({
      missing: ["project.activate"], status: "BLOCKED",
    });
    const offered = surface().nextAllowedCommands.map((command) => command.commandKind);
    expect(offered).toContain("project.register");
    expect(offered).not.toContain("goal.create");
  });

  it("moves a committed kind to COMMITTED and unblocks its dependents", () => {
    commitBootstrap("project.register", { owner: "operator-local" });
    expect(step("project.register")).toMatchObject({ status: "COMMITTED", version: 1 });
    expect(step("project.bind_repository")).toMatchObject({ status: "READY", version: 1 });
    const bind = surface().nextAllowedCommands
      .find((command) => command.commandKind === "project.bind_repository");
    // The offered identity is the daemon's: minted id, ledger-read version.
    expect(bind).toMatchObject({ expectedVersion: 1, targetAggregateId: PROJECT });
    expect(bind?.commandId).toMatch(/^afford-/u);
  });

  it("offers session.close and session.renew for a durably open session", () => {
    const outcome = runSessionCommand(store, encoder.encode(JSON.stringify({
      commandId: "cmd-session-affordance",
      correlationId: "corr-2",
      decidedAt: "2026-08-09T12:01:00.000Z",
      expectedVersion: 0,
      kind: "session.open",
      payload: {
        capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
        expiresAt: "2027-01-01T00:00:00.000Z", sessionId: DEFAULT_SESSION_SUBJECT,
      },
      principalId: "operator-local",
      projectId: PROJECT,
      schemaVersion: "moe-session-command/1",
    })));
    expect(outcome.ok).toBe(true);
    expect(step("session.open")).toMatchObject({ status: "COMMITTED" });
    const kinds = surface().nextAllowedCommands.map((command) => command.commandKind);
    expect(kinds).toContain("session.close");
    expect(kinds).toContain("session.renew");
  });
});

describe("code node steps", () => {
  const nodePort = createAffordancePort({
    mintId: () => `afford-node-${String(minted += 1)}`,
    nodes: () => [{ nodeRef: "node-code-1", title: "Implement add()" }],
    projectId: PROJECT,
    store,
  });

  function nodeSurface() {
    const result = nodePort.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }

  it("hides node steps until the plan approval is durably committed", () => {
    // The shared store has project.register committed but no approval.decide.
    expect(nodeSurface().steps.some((step) => step.kind === "node.deliver")).toBe(false);
  });

  it("offers the review pair for an approved, unaccepted node", () => {
    commitBootstrap("provider.probe", {
      observation: {
        providerMinimumProfileRef: "provider-profile-1", truthClass: "DAEMON_VERIFIED",
      },
    });
    // Reach approval.decide durably via the fixture-canonical chain remainder.
    // (bind + policy + activate + goal + plan + approve, exact payloads from
    // bootstrap-test-fixtures shapes.)
    commitBootstrap("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-1",
        scopeRef: "scope-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
    commitBootstrap("policy.install", {
      slice: { autoApprovalOptIns: [], rules: [], sliceRef: "a1b2c3".padEnd(64, "0") },
    });
    commitBootstrap("project.activate", {
      witness: {
        artifactPathRef: "artifact-1", backupPathRef: "backup-1",
        credentialRef: "credential-1", distributionManifestHash: "cafe".padEnd(64, "0"),
        policyRevisionHash: "face".padEnd(64, "0"),
        providerMinimumProfileRef: "provider-profile-1", signingKeyRef: "signing-1",
        storeDriverRef: "store-driver-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 2);
    commitBootstrap("goal.create", {
      budgetAccountRef: "budget-account-1", goalId: "goal-n1", planningRunRef: "run-n1",
      witness: { projectReadyRef: "ready-1", truthClass: "DAEMON_VERIFIED" },
    });
    const submissionHash = "dec0de".padEnd(64, "0");
    commitBootstrap("plan.propose", {
      commands: [
        {
          commandId: "n-create", expectedVersion: 0, goalRef: "goal-n1",
          kind: "planning.create_draft", runId: "run-n1", runKind: "INITIAL",
        },
        {
          commandId: "n-ready", expectedVersion: 1, kind: "planning.ready",
          witness: {
            acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
            planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          commandId: "n-claim", expectedVersion: 2, kind: "planning.claim",
          witness: {
            attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
            providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
          },
        },
        {
          commandId: "n-propose",
          effectTerminalProof: {
            effectTerminalRef: "effect-terminal-1",
            resourcesTerminalRef: "resources-terminal-1", truthClass: "DAEMON_VERIFIED",
          },
          expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
          submissionHash,
          witness: {
            attemptRef: "attempt-1", submissionRef: "submission-1",
            truthClass: "DAEMON_VERIFIED",
          },
        },
      ],
      runId: "run-n1",
    });
    commitBootstrap("approval.decide", {
      activation: {
        activationRef: "activation-1", budgetHash: "b0".padEnd(64, "0"),
        expectedGoalVersion: 1, goalDraftNoActiveRevision: true,
        graphHash: "6a".padEnd(64, "0"), policyHash: "b1".padEnd(64, "0"),
        qualityHash: "dd".padEnd(64, "0"), truthClass: "HUMAN_APPROVED",
      },
      command: {
        decision: "APPROVE", decisionReason: "reason-1", kind: "approval.decide",
        stepUpAuthRef: "stepup-1",
      },
      graphRevisionRef: "graph-revision-1",
      record: {
        actor: "human-1", actorKind: "HUMAN", applicablePolicyRef: "aa".padEnd(64, "0"),
        approvalRef: "approval-1", approvedNodeScope: ["node-code-1"],
        budgetRef: "bb".padEnd(64, "0"), criteriaRef: "cc".padEnd(64, "0"),
        decision: null, decisionReason: null,
        dependencyChanges: { additions: [], challenges: [], removals: [] },
        exactRevisionHash: submissionHash, lifecycle: "PENDING",
        planQualityAssessmentRef: "dd".padEnd(64, "0"), policyDecisionRef: null,
        riskTier: "R2", stepUpAuthRef: "stepup-1", truthClass: "HUMAN_APPROVED",
        validity: "CURRENT",
      },
      runId: "run-n1",
    });

    const surface = nodeSurface();
    const node = surface.steps.find((step) => step.kind === "node.deliver");
    expect(node).toMatchObject({
      aggregateId: "node-code-1", status: "READY", version: 0,
    });
    const kinds = surface.nextAllowedCommands
      .filter((entry) => entry.targetAggregateId === "node-code-1")
      .map((entry) => entry.commandKind);
    expect(kinds).toContain("review.submit");
    expect(kinds).toContain("integration.accept_output");
  });
});

describe("readAffordanceRequest", () => {
  it("admits an empty object and refuses a malformed body", () => {
    expect(readAffordanceRequest(encoder.encode("{}"))).toEqual({});
    expect(readAffordanceRequest(encoder.encode("[]"))).toBeNull();
    expect(readAffordanceRequest(encoder.encode("{"))).toBeNull();
    expect(readAffordanceRequest(encoder.encode('{"projectId":7}'))).toBeNull();
  });
});
