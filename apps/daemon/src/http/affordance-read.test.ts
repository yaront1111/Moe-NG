import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { BOOTSTRAP_COMMAND_KINDS } from "../bootstrap/bootstrap-contracts.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE,
  POLICY_SLICE,
  PROVIDER_OBSERVATION,
  fixtureBudgetCommitmentFor,
} from "../bootstrap/bootstrap-test-fixtures.js";
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
import {
  reviewerCalibrationSlice, verifierPolicySlice,
} from "../orchestrator/demo-seed-policy.js";
import { runReviewCommand } from "../review/review-services.js";
import { finding, packageItems } from "../review/review-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { affordanceProjectMismatch, readAffordanceRequest } from "./affordance-contract.js";
import {
  DEFAULT_SESSION_SUBJECT, DEFAULT_SUBJECTS, createAffordancePort,
} from "./affordance-read.js";

// This suite drives an `approval.decide` through the production handler, which sources its
// policy from the daemon's approval settings and refuses when they state nothing. So the
// settings are stated here, delay included, rather than inherited from a default.
process.env[APPROVAL_MODE_ENV_KEY] ??= SPEED_APPROVAL_MODE;
process.env[SPEED_MODE_DELAY_ENV_KEY] ??= "0";

const PROJECT = "proj-affordance";
/** The two slice builders read only `projectId`; the rest of the seed input is irrelevant here. */
const SEED_INPUT = { projectId: PROJECT } as Parameters<typeof verifierPolicySlice>[0];
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

/** `commandId` is nameable because `goal.create` derives the goal it mints from it. */
function commitBootstrap(
  kind: string, payload: Record<string, unknown>, expectedVersion = 0, commandId?: string,
): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: commandId ?? `cmd-${kind}-${String(minted += 1)}`,
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
    commitBootstrap(
      "goal.create",
      { instructions: "Author the first durable goal.", title: "Node surface goal" },
      0,
      "n1",
    );
    // Goal creation is a project-scoped repeatable affordance. A prior goal must
    // not consume the only UI path for authoring the next durable goal.
    const createSurface = nodeSurface();
    const createStep = createSurface.steps.find((entry) => entry.kind === "goal.create");
    expect(createStep).toMatchObject({ status: "READY", version: 0 });
    expect(createStep?.aggregateId).toMatch(/^goal-afford-node-/u);
    const createOffer = createSurface.nextAllowedCommands
      .find((command) => command.commandKind === "goal.create");
    expect(createOffer).toMatchObject({ expectedVersion: 0 });
    expect(createOffer?.targetAggregateId).toBe(createStep?.aggregateId);
    expect(createOffer?.targetAggregateId).toMatch(/^goal-afford-node-/u);
    expect(createOffer?.targetAggregateId).not.toBe(PROJECT);
    expect(nodeSurface().nextAllowedCommands
      .find((command) => command.commandKind === "goal.create")?.targetAggregateId)
      .not.toBe(createOffer?.targetAggregateId);
    // ONE minted id, not two: `createGoal` derives the goal it lands from
    // `request.commandId` (goals/goal-services.ts:39-40), so an offer whose target is
    // not `goal-<its own commandId>` cards an aggregate the commit never creates.
    expect(createOffer?.targetAggregateId).toBe(`goal-${String(createOffer?.commandId)}`);
    commitBootstrap(
      "goal.create",
      { instructions: "Second durable goal.", title: "Second goal" },
      0,
      createOffer!.commandId,
    );
    expect(readDurableLedger(store, PROJECT)
      .aggregates.get(createOffer!.targetAggregateId)?.currentVersion).toBe(1);
    const thirdSurface = nodeSurface();
    expect(thirdSurface.steps.find((entry) => entry.kind === "goal.create"))
      .toMatchObject({ status: "READY", version: 0 });
    const thirdOffer = thirdSurface.nextAllowedCommands
      .find((command) => command.commandKind === "goal.create");
    expect(thirdOffer).toMatchObject({ expectedVersion: 0 });
    expect(thirdOffer?.targetAggregateId).not.toBe(createOffer?.targetAggregateId);
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
        // task-61a2e8ad: activation binds back to this value, so a placeholder is no longer an
        // approvable record. Read through the production builder for THIS world's binding.
        budgetRef: fixtureBudgetCommitmentFor(store, "goal-n1", "graph-revision-1", PROJECT),
        criteriaRef: "cc".padEnd(64, "0"),
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
    // This world installed the evaluation and classifying slices only, so the board names the
    // two standing verifier slices the daemon's verifier would refuse without.
    expect(node).toMatchObject({
      aggregateId: "node-code-1",
      missing: ["verification", "verifier-policy", "verifier-calibration"],
      status: "BLOCKED", version: 1,
    });
    const kinds = nodeSurface().nextAllowedCommands
      .filter((entry) => entry.targetAggregateId === "node-code-1")
      .map((entry) => entry.commandKind);
    expect(kinds).toEqual(["review.submit"]);
  });

  it("names only the daemon's verification once both standing verifier slices are installed", () => {
    commitBootstrap("policy.install", { slice: verifierPolicySlice(SEED_INPUT) }, 2);
    const stillMissing = nodeSurface().steps.find((entry) => entry.kind === "node.deliver");
    expect(stillMissing?.missing).toEqual(["verification", "verifier-calibration"]);

    commitBootstrap(
      "policy.install", { slice: reviewerCalibrationSlice(SEED_INPUT) }, 3,
    );
    const node = nodeSurface().steps.find((entry) => entry.kind === "node.deliver");
    expect(node).toMatchObject({
      aggregateId: "node-code-1", missing: ["verification"], status: "BLOCKED",
    });
  });
});

/**
 * BOTH CREATION KINDS ARE OFFERED AGAINST A GOAL, NEVER AGAINST THE PROJECT (task-e87cfddf).
 *
 * Both handlers derive the durable goal from request.commandId. Neither kind may carry a fixed
 * DEFAULT_SUBJECTS target: each surface read must mint `goal-<commandId>` so the offered target
 * is the aggregate the production writer will actually create.
 */
/** The served set, enumerated from the PRODUCTION DISPATCH TABLE — the same composition
 *  `commitBootstrap` above sends through — so the roster arm below has an independent witness. */
const SERVED_BOOTSTRAP_KINDS: readonly string[] = Object.keys(
  { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS },
);

/** Planning offers are emitted per durable goal further down the surface, not from the
 *  bootstrap chain (affordance-read.ts:186-188), so these three are carded but never offered. */
const DEFERRED_OFFER_KINDS: readonly string[] = ["approval.decide", "goal.close", "plan.propose"];

describe("goal.create_with_source is offered like a goal (task-e87cfddf)", () => {
  it("offers both creation kinds against fresh daemon-minted aggregates", () => {
    const offers = surface().nextAllowedCommands;
    const withSource = offers.find((entry) => entry.commandKind === "goal.create_with_source");
    const legacy = offers.find((entry) => entry.commandKind === "goal.create");

    expect("goal.create" in DEFAULT_SUBJECTS).toBe(false);
    expect("goal.create_with_source" in DEFAULT_SUBJECTS).toBe(false);
    expect(withSource).toBeDefined();
    expect(legacy).toBeDefined();
    expect(withSource?.targetAggregateId).toMatch(/^goal-afford-/u);
    expect(legacy?.targetAggregateId).toMatch(/^goal-afford-/u);
    expect(withSource?.targetAggregateId).toBe(`goal-${String(withSource?.commandId)}`);
    expect(legacy?.targetAggregateId).toBe(`goal-${String(legacy?.commandId)}`);
    expect(withSource?.targetAggregateId).not.toBe(legacy?.targetAggregateId);
    expect(withSource?.targetAggregateId).not.toBe(PROJECT);
    expect(legacy?.targetAggregateId).not.toBe(PROJECT);
    // A CREATE MUST BE OFFERED AT VERSION 0 OR IT CANNOT BE ACCEPTED. Both handlers derive the
    // goal from `request.commandId`, so each lands a FRESH aggregate; an offer carrying the
    // subject's advanced version would hand the browser an expectedVersion the reducer refuses.
    // This is the arm that would catch the dev goal subject picking up a version from elsewhere.
    expect(withSource?.expectedVersion).toBe(0);
    expect(legacy?.expectedVersion).toBe(0);
  });

  it("cards exactly the kinds the dispatch serves, and offers exactly its READY ones", () => {
    const read = surface();
    const carded = read.steps.map((entry) => entry.kind);

    // BOTH DIRECTIONS, and the served side is read off the HANDLER SEAM rather than off
    // BOOTSTRAP_COMMAND_KINDS. An arm that iterated the roster could only ever prove
    // "advertised implies carded": delete a member and the iteration shrinks with it, staying
    // green while a served capability silently vanishes from the surface.
    expect([...SERVED_BOOTSTRAP_KINDS].sort()).toEqual([...BOOTSTRAP_COMMAND_KINDS].sort());
    expect(SERVED_BOOTSTRAP_KINDS.filter((kind) => !carded.includes(kind))).toEqual([]);
    expect(carded.filter((kind) => SERVED_BOOTSTRAP_KINDS.includes(kind)).sort())
      .toEqual([...SERVED_BOOTSTRAP_KINDS].sort());

    // And set-equality over the CHAIN OFFERS: every READY bootstrap step carries an offer, and
    // no offer exists for a kind no step called READY. The three deferred kinds are excluded
    // from BOTH sides — `resolvePlanningOffers` emits them per durable goal from a different
    // path, so counting them here would compare the chain against the planning surface.
    const offered = read.nextAllowedCommands
      .filter((entry) => SERVED_BOOTSTRAP_KINDS.includes(entry.commandKind)
        && !DEFERRED_OFFER_KINDS.includes(entry.commandKind))
      .map((entry) => entry.commandKind).sort();
    // policy.install is the one REPEATABLE chain kind: a COMMITTED install still offers the
    // next slice at the aggregate's current version, so it counts on the expected side too.
    const expected = read.steps
      .filter((entry) => SERVED_BOOTSTRAP_KINDS.includes(entry.kind)
        && (entry.status === "READY" || (entry.kind === "policy.install" && entry.status === "COMMITTED"))
        && !DEFERRED_OFFER_KINDS.includes(entry.kind))
      .map((entry) => entry.kind).sort();
    expect(offered).toEqual(expected);
    expect(offered).toContain("goal.create_with_source");
  });

  it("keeps offering policy.install at the aggregate's current version after an install", () => {
    const read = surface();
    const installStep = read.steps.find((entry) => entry.kind === "policy.install");
    expect(installStep?.status).toBe("COMMITTED");
    const installOffer = read.nextAllowedCommands.find((entry) => entry.commandKind === "policy.install");
    expect(installOffer).toMatchObject({ expectedVersion: installStep?.version, targetAggregateId: installStep?.aggregateId });
  });

  it("keeps both creation kinds as fresh minted offers after a source create", () => {
    const first = surface().nextAllowedCommands
      .find((entry) => entry.commandKind === "goal.create_with_source");
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("source create offer missing before commit");

    const committedGoalId = `goal-${first.commandId}`;
    commitBootstrap("goal.create_with_source", {
      instructions: "Continue from the selected product brief.",
      source: {
        displayPath: "docs/repeatable-prd.md",
        mediaType: "text/markdown",
        text: `# ${first.commandId}\n\nRepeatability proof.\n`,
      },
      title: "Source-created repeatability",
    }, 0, first.commandId);
    expect(readDurableLedger(store, PROJECT)
      .aggregates.get(committedGoalId)?.currentVersion).toBe(1);

    const after = surface();
    const creationState = (kind: "goal.create" | "goal.create_with_source") => {
      const step = after.steps.find((entry) => entry.kind === kind);
      const offer = after.nextAllowedCommands.find((entry) => entry.commandKind === kind);
      return {
        expectedVersion: offer?.expectedVersion ?? null,
        offered: offer !== undefined,
        status: step?.status ?? null,
        targetMatchesCommand: offer?.targetAggregateId === `goal-${String(offer?.commandId)}`,
        version: step?.version ?? null,
      };
    };
    expect([
      creationState("goal.create"), creationState("goal.create_with_source"),
    ]).toStrictEqual([
      { expectedVersion: 0, offered: true, status: "READY",
        targetMatchesCommand: true, version: 0 },
      { expectedVersion: 0, offered: true, status: "READY",
        targetMatchesCommand: true, version: 0 },
    ]);
    const nextLegacy = after.nextAllowedCommands
      .find((entry) => entry.commandKind === "goal.create");
    const nextSource = after.nextAllowedCommands
      .find((entry) => entry.commandKind === "goal.create_with_source");
    expect(nextSource?.targetAggregateId).not.toBe(committedGoalId);
    expect(nextSource?.targetAggregateId).not.toBe(nextLegacy?.targetAggregateId);
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


describe("a node whose review is exhausted waits on a human escalation", () => {
  let escalationMinted = 0;
  const escalationPort = createAffordancePort({
    mintId: () => `afford-escalation-${String(escalationMinted += 1)}`,
    nodes: () => [{ nodeRef: "node-code-1", title: "Implement add()" }],
    projectId: PROJECT,
    store,
  });
  function nodeSurface() {
    const result = escalationPort.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }

  function submitFailingRound(label: string): void {
    const ledger = readReviewLedger(store, PROJECT, "node-code-1");
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: `cmd-affordance-fail-${label}`,
      correlationId: "corr-affordance-escalation",
      decidedAt: "2026-08-09T12:30:00.000Z",
      expectedVersion: ledger.version,
      kind: "review.submit",
      payload: {
        findings: [finding({ ruleId: `rule-${label}`, subject: { kind: "NODE", locator: `locator-${label}` } })],
        packageItems: packageItems(), round: ledger.lineage.highestRound + 1, subjectRef: "node-code-1",
      },
      principalId: "sess-agent-affordance",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    if (!outcome.ok) throw new Error(`failing round ${label} refused: ${outcome.code}`);
  }

  it("blocks the node on escalation and offers only escalation.decide after three failed rounds", () => {
    submitFailingRound("a");
    submitFailingRound("b");
    submitFailingRound("c");
    const node = nodeSurface().steps.find((entry) => entry.kind === "node.deliver");
    expect(node).toMatchObject({ aggregateId: "node-code-1", missing: ["escalation"], status: "BLOCKED" });
    const offered = nodeSurface().nextAllowedCommands.filter((entry) => entry.targetAggregateId === "node-code-1");
    expect(offered.map((entry) => entry.commandKind)).toEqual(["escalation.decide"]);
    expect(offered[0]?.expectedVersion).toBe(readReviewLedger(store, PROJECT, "node-code-1").version);
  });

  it("returns the node to READY with review.submit offered once a human escalates", () => {
    const ledger = readReviewLedger(store, PROJECT, "node-code-1");
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: "cmd-affordance-escalate",
      correlationId: "corr-affordance-escalation",
      decidedAt: "2026-08-09T12:31:00.000Z",
      expectedVersion: ledger.version,
      kind: "escalation.decide",
      payload: { escalationRef: "ui-escalation-node-code-1", subjectRef: "node-code-1" },
      principalId: "operator-local",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    expect(outcome.ok).toBe(true);
    const node = nodeSurface().steps.find((entry) => entry.kind === "node.deliver");
    expect(node).toMatchObject({ aggregateId: "node-code-1", missing: [], status: "READY" });
    expect(nodeSurface().nextAllowedCommands.filter((entry) => entry.targetAggregateId === "node-code-1")
      .map((entry) => entry.commandKind)).toEqual(["review.submit"]);
  });
});
