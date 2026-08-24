import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { POLICY_SLICE, PROVIDER_OBSERVATION } from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
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

function commitBootstrap(
  kind: string, payload: Record<string, unknown>, expectedVersion = 0,
): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-${kind}-${String(minted += 1)}`,
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
  return { offered: result.nextAllowedCommands.filter((entry) => entry.commandKind === kind), step: found };
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
      budgetAccountRef: "budget-account-1", goalId: DEFAULT_GOAL_SUBJECT,
      planningRunRef: DEFAULT_RUN_SUBJECT,
      witness: { projectReadyRef: "ready-1", truthClass: "DAEMON_VERIFIED" },
    });
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
