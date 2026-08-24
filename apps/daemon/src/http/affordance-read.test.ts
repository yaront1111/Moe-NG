import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { POLICY_SLICE, PROVIDER_OBSERVATION } from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_APPROVAL_MODE,
  SPEED_MODE_DELAY_ENV_KEY,
} from "../planning/approval-policy-settings.js";
import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { runSessionCommand } from "../identity/session-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import { packageItems } from "../review/review-test-fixtures.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { affordanceProjectMismatch, readAffordanceRequest } from "./affordance-contract.js";
import { DEFAULT_SESSION_SUBJECT, createAffordancePort } from "./affordance-read.js";

// This suite drives an `approval.decide` through the production handler, which sources its
// policy from the daemon's approval settings and refuses when they state nothing. So the
// settings are stated here, delay included, rather than inherited from a default.
process.env[APPROVAL_MODE_ENV_KEY] ??= SPEED_APPROVAL_MODE;
process.env[SPEED_MODE_DELAY_ENV_KEY] ??= "0";

const PROJECT = "proj-affordance";
const directory = mkdtempSync(join(tmpdir(), "moe-affordance-"));
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

function commitWorkClaim(
  kind: "work.claim" | "work.release", principalId: string, workItemId: string,
  expectedVersion: number, decidedAt: string, expiresAt?: string,
): void {
  const outcome = runWorkClaimCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-${kind}-${String(minted += 1)}`,
    correlationId: "corr-work-claim",
    decidedAt,
    expectedVersion,
    kind,
    payload: kind === "work.release" ? { workItemId } : { expiresAt, workItemId },
    principalId,
    projectId: PROJECT,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
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

  it("exposes the current claim aggregate version when a claim is expired or released", () => {
    const workItemId = `policy.install@${PROJECT}-policy`;
    commitWorkClaim(
      "work.claim", "agent-expired", workItemId, 0,
      "2026-08-09T12:00:00.000Z", "2026-08-09T12:30:00.000Z",
    );
    expect(step("policy.install")).toMatchObject({
      claim: null, claimAggregateVersion: 1, status: "READY",
    });

    commitWorkClaim(
      "work.claim", "agent-release", workItemId, 1,
      "2026-08-09T12:31:00.000Z", "2027-08-09T12:31:00.000Z",
    );
    commitWorkClaim(
      "work.release", "agent-release", workItemId, 2,
      "2026-08-09T12:32:00.000Z",
    );
    expect(step("policy.install")).toMatchObject({
      claim: null, claimAggregateVersion: 3, status: "READY",
    });
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

  it("offers only agent-authored review submission for an approved, unaccepted node", () => {
    commitBootstrap("provider.probe", { observation: PROVIDER_OBSERVATION });
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
      slice: POLICY_SLICE,
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
    // The run must reach approval FINALIZED and SEALED, or `decideApproval` refuses
    // APPROVAL_RUN_NOT_REVIEWABLE / APPROVAL_AUTHORITY_UNSEALED before any affordance exists to
    // read (task-2cc6c59d). The bodies are minted by the shipped producer rather than spelled:
    // the submission hash IS the sealed plan's own `planHash`, and the daemon re-derives it.
    const sealed = journeyAuthority({
      authorRef: "architect-1",
      criterionIds: ["criterion-a"],
      graphRevisionRef: "graph-revision-1",
      idPrefix: "run-n1",
      nodeIds: ["node-code-1"],
      stepDescription: "Land the affordance node.",
    });
    const submissionHash = sealed.submissionHash;
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
          authority: sealed.authority,
          commandId: "n-propose",
          graphContentBytesBase64: sealed.graphContentBytesBase64,
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
    // The finalize terminal rides its OWN request: `classifyPlanningChain` refuses a chain
    // holding both terminals with PLANNING_FINALIZE_CHAIN_MIXED.
    commitBootstrap("plan.propose", {
      commands: [
        {
          commandId: "n-finalize", expectedVersion: 4,
          kind: "planning.finalize_submission",
          revision: {
            dependencyHash: "d1".padEnd(64, "0"),
            // BIN A: the world moved, the subject did not. This arm is about the code-node
            // affordance after a REVIEWABLE, SEALED run; the graph hash was only ever scenery,
            // and it now has to be the producer's or the envelope refuses the finalize.
            graphContentHash: sealed.graphContentHash,
            graphRevisionRef: "graph-revision-1", planHash: submissionHash,
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
      runId: "run-n1",
    });
    commitBootstrap("approval.decide", {
      activation: {
        // NO `budgetHash` (task-1de7b81a): the approve path derives it from the budget root it
        // establishes, and a caller's placeholder that disagrees is refused
        // BOOTSTRAP_BUDGET_HASH_MISMATCH. `policyHash` stays — task-eb6a1fa6 owns it.
        activationRef: "activation-1",
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
        actor: "operator-local", actorKind: "HUMAN", applicablePolicyRef: "aa".padEnd(64, "0"),
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
    expect(kinds).not.toContain("integration.accept_output");
  });

  it("blocks a clean submitted node on daemon verification", () => {
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: "cmd-affordance-clean-round",
      correlationId: "corr-affordance-review",
      decidedAt: "2026-08-09T12:10:00.000Z",
      expectedVersion: 0,
      kind: "review.submit",
      payload: {
        findings: [], packageItems: packageItems(), round: 1, subjectRef: "node-code-1",
      },
      principalId: "sess-agent-affordance",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    expect(outcome.ok).toBe(true);

    const node = nodeSurface().steps.find((entry) => entry.kind === "node.deliver");
    expect(node).toMatchObject({
      aggregateId: "node-code-1", missing: ["verification"], status: "BLOCKED", version: 1,
    });
    const kinds = nodeSurface().nextAllowedCommands
      .filter((entry) => entry.targetAggregateId === "node-code-1")
      .map((entry) => entry.commandKind);
    expect(kinds).toEqual(["review.submit"]);
  });
});

describe("affordanceProjectMismatch", () => {
  it("passes an absent or matching projectId and refuses a foreign one", () => {
    expect(affordanceProjectMismatch({}, "proj-A")).toBe(false);
    expect(affordanceProjectMismatch({ projectId: "proj-A" }, "proj-A")).toBe(false);
    expect(affordanceProjectMismatch({ projectId: "proj-B" }, "proj-A")).toBe(true);
  });

  it("the port names the project it answers for", () => {
    expect(port.boundProjectId).toBe(PROJECT);
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
