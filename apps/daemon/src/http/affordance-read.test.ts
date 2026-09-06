import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { ASYNC_SERVED_BOOTSTRAP_KINDS, BOOTSTRAP_COMMAND_KINDS }
  from "../bootstrap/bootstrap-contracts.js";
import {
  humanReviewWitness, missingPrerequisites, readDurableLedger,
} from "../bootstrap/bootstrap-ledger.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import {
  CLASSIFYING_POLICY_SLICE,
  POLICY_SLICE,
  PROVIDER_OBSERVATION,
  fixtureBudgetCommitmentFor,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { FIXTURE_ACTIVATION_RECEIPTS } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  GOAL_ID as BOOTSTRAP_GOAL,
  PROJECT_ID as BOOTSTRAP_PROJECT,
  RUN_ID as BOOTSTRAP_RUN_ID,
  acceptancePayload,
  closeStores as closeBootstrapStores,
  driveThrough,
  openStore as openBootstrapStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readApprovedNodeScope } from "../goals/goal-close-prerequisite.js";
import { seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { runApprovalIntentCommand } from "../planning/approval-intent.js";
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
import {
  REVIEWER, finding, packageItems, seedVerifierReceipt,
} from "../review/review-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { affordanceProjectMismatch, readAffordanceRequest } from "./affordance-contract.js";
import type { NodeSpec } from "./affordance-contract.js";
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
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
  // `project.activate` MINTS its witness from measured receipts and refuses without them.
  FIXTURE_ACTIVATION_RECEIPTS);
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
    // The roster is COMPOSED: the admission table's three primaries, then the policy fact the
    // table deliberately does not carry (task-a5a6abcc). Kept a literal set-equality pin rather
    // than softened to toContain — the literal is what makes it a guard.
    expect(step("project.activate")).toMatchObject({
      missing: [
        "project.register", "project.bind_repository", "provider.probe", "policy.install",
      ],
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
    nodes: () => [{ dependsOn: [], nodeRef: "node-code-1", title: "Implement add()" }],
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
    commitBootstrap("project.activate", // NO WITNESS: the daemon mints it from its own measured receipts.
      {}, 2);
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
const SERVED_BOOTSTRAP_KINDS: readonly string[] = [
  ...Object.keys({ ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }),
  // The handler table is no longer the whole seam: a bootstrap kind whose effects are
  // asynchronous admits through this surface and is served by an async registry entry instead.
  // Read from production, never hand-typed, so a kind that stops being async-served reds here.
  ...ASYNC_SERVED_BOOTSTRAP_KINDS,
];

/**
 * Served, advertised — and NOT CARDED YET. The operator UI for `repository.bootstrap` is child 3
 * of task-5ef1a0a9; until it lands there is no step to offer, and inventing one here would card
 * a command with no surface behind it. Excluded BY NAME, so a kind that quietly stops being
 * carded still reds: the exemption is a list of one, not a predicate.
 */
const UNCARDED_SERVED_KINDS: readonly string[] = Object.freeze(["repository.bootstrap"]);

/**
 * These lifecycle kinds are carded only from their durable per-goal offers — the exact four the
 * chain-offer path withholds (affordance-read.ts's `kind !== ...` guard). `repository.publish`
 * belongs here for the same reason as the other three: the chain mints a READY STEP for it and
 * no offer, and the per-goal ladder decides separately whether to offer one — since
 * task-f6f33a39, only for a goal with a landed commit.
 */
const BOARD_PLANNING_KINDS: readonly string[] =
  Object.freeze(["approval.decide", "goal.close", "plan.propose", "repository.publish"]);

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

  it("cards the non-planning dispatch roster and offers exactly its READY tuples", () => {
    const read = surface();
    const carded = read.steps.map((entry) => entry.kind);
    const nonPlanningServed = SERVED_BOOTSTRAP_KINDS
      .filter((kind) => !BOARD_PLANNING_KINDS.includes(kind))
      .filter((kind) => !UNCARDED_SERVED_KINDS.includes(kind));
    const nonPlanningCarded = [...new Set(carded
      .filter((kind) => nonPlanningServed.includes(kind)))].sort();

    // BOTH DIRECTIONS, and the served side is read off the HANDLER SEAM rather than off
    // BOOTSTRAP_COMMAND_KINDS. An arm that iterated the roster could only ever prove
    // "advertised implies carded": delete a member and the iteration shrinks with it, staying
    // green while a served capability silently vanishes from the surface.
    expect([...SERVED_BOOTSTRAP_KINDS].sort()).toEqual([...BOOTSTRAP_COMMAND_KINDS].sort());
    // The exemption cannot grow silently: every uncarded kind must still be a SERVED one.
    expect(UNCARDED_SERVED_KINDS.filter((kind) => !SERVED_BOOTSTRAP_KINDS.includes(kind)))
      .toEqual([]);
    expect(nonPlanningServed.filter((kind) => !carded.includes(kind))).toEqual([]);
    expect(nonPlanningCarded).toEqual([...nonPlanningServed].sort());
    expect(BOARD_PLANNING_KINDS.length).toBeGreaterThan(0);
    // The roster is pinned against the SOURCE of the production guard it mirrors, not against a
    // hand-copy: affordance-read.ts withholds a chain offer for exactly these four kinds, and a
    // fifth added there without being added here would silently widen the exemption below.
    expect([...BOARD_PLANNING_KINDS].sort())
      .toEqual(["approval.decide", "goal.close", "plan.propose", "repository.publish"]);

    // And set-equality over the CHAIN OFFERS: every READY bootstrap step carries an offer, and
    // no offer exists for a kind no step called READY. The three planning kinds are covered
    // by exact target+version tuple assertions in affordance-read-planning.test.ts.
    const offered = read.nextAllowedCommands
      .filter((entry) => SERVED_BOOTSTRAP_KINDS.includes(entry.commandKind)
        && !BOARD_PLANNING_KINDS.includes(entry.commandKind))
      .map((entry) => entry.commandKind).sort();
    // policy.install is the one REPEATABLE chain kind: a COMMITTED install still offers the
    // next slice at the aggregate's current version, so it counts on the expected side too.
    const expected = read.steps
      .filter((entry) => SERVED_BOOTSTRAP_KINDS.includes(entry.kind)
        && (entry.status === "READY" || (entry.kind === "policy.install" && entry.status === "COMMITTED"))
        && !BOARD_PLANNING_KINDS.includes(entry.kind))
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

/**
 * task-ed89967f / R3-016 — the compatibility face of the new top-level authority map.
 *
 * This port is the UNCONFIGURED one: no principalId, no node roster. DoD 4 forbids any fallback,
 * so the only admissible answer here is an omission, and DoD 5 requires the addition to be purely
 * additive to the existing surface shape.
 */
describe("planningAuthorityByRun on an unconfigured port (task-ed89967f / R3-016)", () => {
  it("adds a frozen, empty map without disturbing the existing surface members", () => {
    const read = surface();

    expect(read.planningAuthorityByRun).toEqual({});
    expect(Object.isFrozen(read.planningAuthorityByRun)).toBe(true);
    // THE CONTROL: this world is not planning-free — it holds durable goals and their run
    // bindings — so {} is the unconfigured port failing closed, not an artifact of a bare ledger.
    expect(Object.keys(read.planningGoalRefs).length).toBeGreaterThan(0);
    // ADDITIVE ONLY: every member the surface published before this row is still published.
    expect(Object.keys(read).sort()).toEqual([
      "nextAllowedCommands", "outcome", "planningAuthorityByRun", "planningGoalRef",
      "planningGoalRefs", "steps",
    ]);
  });
});

describe("a node whose review is exhausted waits on a human escalation", () => {
  let escalationMinted = 0;
  const escalationPort = createAffordancePort({
    mintId: () => `afford-escalation-${String(escalationMinted += 1)}`,
    nodes: () => [{ dependsOn: [], nodeRef: "node-code-1", title: "Implement add()" }],
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
      payload: { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "ui-escalation-node-code-1", subjectRef: "node-code-1" },
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

describe("a REPLAN decision retires the node", () => {
  let replanMinted = 0;
  const replanPort = createAffordancePort({
    mintId: () => `afford-replan-${String(replanMinted += 1)}`,
    nodes: () => [{ dependsOn: [], nodeRef: "node-code-2", title: "Implement multiply()" }],
    projectId: PROJECT,
    store,
  });
  function surfaceOf() {
    const result = replanPort.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }
  function failRound(label: string): void {
    const ledger = readReviewLedger(store, PROJECT, "node-code-2");
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: `cmd-replan-fail-${label}`,
      correlationId: "corr-affordance-replan",
      decidedAt: "2026-09-03T12:30:00.000Z",
      expectedVersion: ledger.version,
      kind: "review.submit",
      payload: {
        findings: [finding({ ruleId: `rule-${label}`, subject: { kind: "NODE", locator: `locator-${label}` } })],
        packageItems: packageItems(), round: ledger.lineage.highestRound + 1, subjectRef: "node-code-2",
      },
      principalId: "sess-agent-affordance",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    if (!outcome.ok) throw new Error(`failing round ${label} refused: ${outcome.code}`);
  }

  it("blocks the node on replan and offers nothing for it once a human answers REPLAN", () => {
    failRound("a");
    failRound("b");
    failRound("c");
    const ledger = readReviewLedger(store, PROJECT, "node-code-2");
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: "cmd-affordance-replan",
      correlationId: "corr-affordance-replan",
      decidedAt: "2026-09-03T12:31:00.000Z",
      expectedVersion: ledger.version,
      kind: "escalation.decide",
      payload: { decision: "REPLAN", escalationRef: "ui-escalation-node-code-2", subjectRef: "node-code-2" },
      principalId: "operator-local",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    expect(outcome.ok).toBe(true);
    expect(readReviewLedger(store, PROJECT, "node-code-2")).toMatchObject({ escalated: true, replanned: true });
    const node = surfaceOf().steps.find((entry) => entry.aggregateId === "node-code-2");
    expect(node).toMatchObject({ kind: "node.deliver", missing: ["replan"], status: "BLOCKED" });
    expect(surfaceOf().nextAllowedCommands.filter((entry) => entry.targetAggregateId === "node-code-2")).toEqual([]);
  });
});

/**
 * A node.deliver step is READY only when every node it depends on is ACCEPTED.
 *
 * ACCEPTED is the review ledger's acceptance record — the SAME fact the loop
 * already uses to mark a node COMMITTED. There is deliberately no second notion
 * of doneness here (no landing receipt, no verifier receipt): a node is a
 * satisfied dependency exactly when the surface would call it COMMITTED, so the
 * board and the gate can never disagree about what "done" means.
 *
 * These arms share the suite store, which the arms above already drove to a
 * durably approved plan; the node keys are unique to this block so their review
 * ledgers are independent of the escalation and replan worlds.
 */
describe("a node waits on its hard dependencies", () => {
  const A = "node-dep-a";
  const B = "node-dep-b";
  const C = "node-dep-c";
  let dependsMinted = 0;

  /** One port per roster: the gate reads dependencies off the NodeSpec the
   *  compiled source produces, so each arm states the build order it is about. */
  function surfaceFor(nodes: readonly NodeSpec[]) {
    const result = createAffordancePort({
      mintId: () => `afford-depends-${String(dependsMinted += 1)}`,
      nodes: () => nodes,
      projectId: PROJECT,
      store,
    }).readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
    return result;
  }

  function stepFor(nodes: readonly NodeSpec[], nodeRef: string) {
    return surfaceFor(nodes).steps.find((entry) => entry.aggregateId === nodeRef);
  }

  function offeredKindsFor(nodes: readonly NodeSpec[], nodeRef: string): readonly string[] {
    return surfaceFor(nodes).nextAllowedCommands
      .filter((entry) => entry.targetAggregateId === nodeRef)
      .map((entry) => entry.commandKind);
  }

  /** A clean round with no findings: the daemon has not consumed its receipt, so
   *  the node is awaiting verification — the pre-existing BLOCKED reason. */
  function cleanRound(nodeRef: string): void {
    const ledger = readReviewLedger(store, PROJECT, nodeRef);
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: `cmd-depends-clean-${nodeRef}`,
      correlationId: "corr-affordance-depends",
      decidedAt: "2026-09-04T12:00:00.000Z",
      expectedVersion: ledger.version,
      kind: "review.submit",
      payload: {
        findings: [], packageItems: packageItems(),
        round: ledger.lineage.highestRound + 1, subjectRef: nodeRef,
      },
      principalId: "sess-agent-affordance",
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    if (!outcome.ok) throw new Error(`clean round for ${nodeRef} refused: ${outcome.code}`);
  }

  /** Drives the node to ACCEPTED through the shipped acceptance path — a real
   *  verifier receipt then `integration.accept_output` — never by writing the
   *  acceptance record the production reader is supposed to derive. */
  function accept(nodeRef: string): void {
    const receipt = seedVerifierReceipt(store, nodeRef, PROJECT);
    const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
      commandId: `cmd-depends-accept-${nodeRef}`,
      correlationId: "corr-affordance-depends",
      decidedAt: "2026-09-04T12:05:00.000Z",
      expectedVersion: receipt.currentVersion,
      kind: "integration.accept_output",
      payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
      principalId: REVIEWER,
      projectId: PROJECT,
      schemaVersion: "moe-review-command/1",
    })));
    if (!outcome.ok) throw new Error(`acceptance for ${nodeRef} refused: ${outcome.code}`);
    // The gate's whole premise: acceptance is what the surface calls COMMITTED.
    expect(readReviewLedger(store, PROJECT, nodeRef).accepted).toBeDefined();
  }

  const PAIR: readonly NodeSpec[] = Object.freeze([
    Object.freeze({ dependsOn: Object.freeze([]), nodeRef: A, title: "Build a" }),
    Object.freeze({ dependsOn: Object.freeze([A]), nodeRef: B, title: "Build b" }),
  ]);
  const CHAIN: readonly NodeSpec[] = Object.freeze([
    ...PAIR,
    Object.freeze({ dependsOn: Object.freeze([B]), nodeRef: C, title: "Build c" }),
  ]);

  it("blocks a dependent node on depends:<nodeKey> and offers it nothing to submit", () => {
    // THE CONTROL: the free node is READY and IS offered review.submit, so the
    // arm below measures the dependency gate and not a dead surface.
    expect(stepFor(PAIR, A)).toMatchObject({ missing: [], status: "READY" });
    expect(offeredKindsFor(PAIR, A)).toEqual(["review.submit"]);

    // The EXACT token, not merely a non-empty list: the browser reads this
    // string, so a rename that kept the list non-empty would still break it.
    expect(stepFor(PAIR, B)).toMatchObject({
      kind: "node.deliver", missing: [`depends:${A}`], status: "BLOCKED",
    });
    // A blocked node must not be staffable: the wrapper claims work from the
    // offers, so leaving review.submit here would staff b beside its parent.
    expect(offeredKindsFor(PAIR, B)).toEqual([]);
  });

  it("releases the dependent node the moment its dependency is ACCEPTED", () => {
    accept(A);
    expect(stepFor(PAIR, A)).toMatchObject({ status: "COMMITTED" });
    expect(stepFor(PAIR, B)).toMatchObject({ missing: [], status: "READY" });
    expect(offeredKindsFor(PAIR, B)).toEqual(["review.submit"]);
  });

  it("gates the WHOLE chain, not just the frontier's direct parents", () => {
    // a is accepted (previous arm), b and c are not. A gate that only resolved
    // the frontier's direct parents would call c READY here, because its own
    // parent b is listed — the transitive fact is that b is not ACCEPTED.
    expect(stepFor(CHAIN, A)).toMatchObject({ status: "COMMITTED" });
    expect(stepFor(CHAIN, B)).toMatchObject({ missing: [], status: "READY" });
    expect(stepFor(CHAIN, C)).toMatchObject({ missing: [`depends:${B}`], status: "BLOCKED" });
    expect(offeredKindsFor(CHAIN, B)).toEqual(["review.submit"]);
    expect(offeredKindsFor(CHAIN, C)).toEqual([]);
  });

  it("names EVERY unaccepted dependency, in the order the node lists them", () => {
    const fan: readonly NodeSpec[] = Object.freeze([
      ...CHAIN,
      Object.freeze({ dependsOn: Object.freeze([B, C]), nodeRef: "node-dep-fan", title: "Fan" }),
    ]);
    // b and c are both unaccepted, so BOTH are named. A gate that stopped at the
    // first unmet dependency would report one token and read as almost-right.
    expect(stepFor(fan, "node-dep-fan"))
      .toMatchObject({ missing: [`depends:${B}`, `depends:${C}`], status: "BLOCKED" });
  });

  it("leaves a node with no dependencies exactly as it was", () => {
    const solo: readonly NodeSpec[] = Object.freeze([
      Object.freeze({ dependsOn: Object.freeze([]), nodeRef: "node-dep-solo", title: "Solo" }),
    ]);
    expect(stepFor(solo, "node-dep-solo")).toMatchObject({ missing: [], status: "READY" });
    expect(offeredKindsFor(solo, "node-dep-solo")).toEqual(["review.submit"]);
  });

  it("does not treat a dependency outside the sealed roster as satisfied", () => {
    // Fail CLOSED. An unresolvable producer key is the one case where guessing
    // "satisfied" silently un-gates a node, so it stays blocked and says which
    // key it could not satisfy.
    const dangling: readonly NodeSpec[] = Object.freeze([
      Object.freeze({
        dependsOn: Object.freeze(["node-dep-never-sealed"]),
        nodeRef: "node-dep-orphan", title: "Orphan",
      }),
    ]);
    expect(stepFor(dangling, "node-dep-orphan")).toMatchObject({
      missing: ["depends:node-dep-never-sealed"], status: "BLOCKED",
    });
    expect(offeredKindsFor(dangling, "node-dep-orphan")).toEqual([]);
  });

  it("PRECEDENCE: reports dependencies AND verification together, dependencies first", () => {
    // This arm exists to pin an order the DoD leaves to the implementer, so the
    // wrapper's reading of `missing` cannot drift silently later. The node has a
    // clean round in (awaiting the daemon's verifier) AND an unaccepted parent.
    const gated: readonly NodeSpec[] = Object.freeze([
      ...CHAIN,
      Object.freeze({ dependsOn: Object.freeze([C]), nodeRef: "node-dep-both", title: "Both" }),
    ]);
    cleanRound("node-dep-both");
    // Both standing verifier slices were installed by the arms above, so the
    // verification side contributes exactly one token here.
    expect(stepFor(gated, "node-dep-both")).toMatchObject({
      missing: [`depends:${C}`, "verification"], status: "BLOCKED",
    });
    // The dependency block is the stronger one: a node that cannot start is not
    // offered a submission, even though a verification-only block still is.
    expect(offeredKindsFor(gated, "node-dep-both")).toEqual([]);
  });
});

/**
 * task-a5a6abcc: the offer surface withholds `project.activate` while no `policy.install`
 * is committed. The policy fact lives in the MEASURED RECEIPTS, not in the admission table,
 * so these arms drive the PRODUCTION surface rather than a re-derived roster.
 *
 * Each world opens its OWN store. The suite above shares one accumulating ledger that has
 * `policy.install` committed by its second describe, so a world that must observe "no policy
 * installed" cannot be a late arm on the shared store — it would depend on suite order.
 */
describe("project.activate is withheld until a policy is installed (task-a5a6abcc)", () => {
  const worlds: { close: () => void }[] = [];

  function policyWorld() {
    const root = mkdtempSync(join(tmpdir(), "moe-afford-policy-"));
    const worldStore = SqliteEventStore.openForProject(join(root, "store.db"), PROJECT);
    installTestRecoveryBinding(worldStore);
    let ids = 0;
    const worldPort = createAffordancePort({
      mintId: () => `afford-policy-${String(ids += 1)}`,
      projectId: PROJECT,
      store: worldStore,
    });
    const world = {
      close: () => {
        worldStore.close();
        rmSync(root, { force: true, recursive: true });
      },
      commit: (kind: string, payload: Record<string, unknown>, expectedVersion = 0): void => {
        const outcome = runBootstrapCommand(worldStore, encoder.encode(JSON.stringify({
          commandId: `cmd-${kind}-${String(ids += 1)}`,
          correlationId: "corr-policy-gate",
          decidedAt: "2026-09-05T12:00:00.000Z",
          expectedVersion,
          kind,
          payload,
          principalId: "operator-local",
          projectId: PROJECT,
          schemaVersion: "moe-bootstrap-command/1",
        })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
        FIXTURE_ACTIVATION_RECEIPTS);
        if (!outcome.ok) throw new Error(`${kind}: ${outcome.code} (${outcome.refusedBy})`);
      },
      offeredKinds: (): string[] => {
        const result = worldPort.readSurface();
        if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
        return result.nextAllowedCommands.map((command) => command.commandKind);
      },
      step: (kind: string) => {
        const result = worldPort.readSurface();
        if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
        const found = result.steps.find((entry) => entry.kind === kind);
        if (found === undefined) throw new Error(`no step for ${kind}`);
        return found;
      },
    };
    worlds.push(world);
    return world;
  }

  /** The three table prerequisites, in the order `COMMAND_PREREQUISITES` lists them. */
  function commitTablePrerequisites(world: ReturnType<typeof policyWorld>): void {
    world.commit("project.register", { owner: "operator-local" });
    world.commit("provider.probe", { observation: PROVIDER_OBSERVATION });
    world.commit("project.bind_repository", {
      observation: {
        baseRevisionHash: "b".repeat(64), repositoryRef: "repo-1",
        scopeRef: "scope-1", truthClass: "DAEMON_VERIFIED",
      },
    }, 1);
  }

  afterAll(() => {
    for (const world of worlds) world.close();
  });

  it("BLOCKS the step and WITHHOLDS the offer when every table prerequisite is met but no policy is", () => {
    const world = policyWorld();
    commitTablePrerequisites(world);

    // The defect this row owns: the admission table is satisfied, so the surface used to
    // advertise READY while `measurePolicy` would refuse ACTIVATION_POLICY_UNMEASURED at
    // DAEMON_ACTIVATION_RECEIPTS. Set equality, not toContain: a roster that later grew a
    // bogus member has to red here.
    expect(world.step("project.activate")).toMatchObject({
      missing: ["policy.install"], status: "BLOCKED",
    });
    // The step status and the offer roster are asserted on ONE frame. A BLOCKED step beside
    // a live offer is exactly the split this row closes, and two tests could never see it.
    expect(world.offeredKinds()).not.toContain("project.activate");
    // The gate is scoped to this one kind: every other kind still reads the table alone.
    expect(world.step("goal.create")).toMatchObject({
      missing: ["project.activate"], status: "BLOCKED",
    });

    // THE CONVERSE, so the gate is not simply always-off.
    world.commit("policy.install", { slice: POLICY_SLICE });
    expect(world.step("project.activate")).toMatchObject({ missing: [], status: "READY" });
    expect(world.offeredKinds()).toContain("project.activate");
  });

  it("COMPOSES with the table roster instead of replacing it: primaries first, policy last", () => {
    const world = policyWorld();
    world.commit("project.register", { owner: "operator-local" });

    // An operator part-way through the chain is told EVERYTHING that is outstanding, not
    // walked through one refusal at a time.
    expect(world.step("project.activate")).toMatchObject({
      missing: ["project.bind_repository", "provider.probe", "policy.install"],
      status: "BLOCKED",
    });
  });

  it("tests committed-ness, never position: a policy installed FIRST still reaches READY", () => {
    const world = policyWorld();
    // `COMMAND_PREREQUISITES["policy.install"]` is `[]`, so the install can land at any point
    // in the chain. A gate keyed on chain position rather than the committed fact reds here.
    world.commit("policy.install", { slice: POLICY_SLICE });
    commitTablePrerequisites(world);

    expect(world.step("project.activate")).toMatchObject({ missing: [], status: "READY" });
    expect(world.offeredKinds()).toContain("project.activate");
  });

  it("reads presence, not count: one installed slice is as good as three", () => {
    const world = policyWorld();
    commitTablePrerequisites(world);
    world.commit("policy.install", { slice: POLICY_SLICE });
    expect(world.step("project.activate")).toMatchObject({ missing: [], status: "READY" });

    // `policy.install` is REPEATABLE — a second slice lands on the same aggregate at version 1.
    // `ledger.kinds.has` is presence, so the verdict must not move.
    world.commit("policy.install", { slice: CLASSIFYING_POLICY_SLICE }, 1);
    expect(world.step("policy.install")).toMatchObject({ status: "COMMITTED" });
    expect(world.step("project.activate")).toMatchObject({ missing: [], status: "READY" });
    expect(world.offeredKinds()).toContain("project.activate");
  });
});


/**
 * THE TWO AUTHORITIES AGREE ON ONE FRAME (task-ebbcbdb4).
 *
 * THE DEFECT, measured live on UnAI: ONE `/affordances/read` frame carried BOTH
 * `steps[goal.close].status === "BLOCKED"` and a live `goal.close` entry in
 * `nextAllowedCommands`, for the same goal at the same instant. The step projection reads
 * `missingPrerequisites` (affordance-read.ts:206, :235) while the offer ladder reads
 * `closeReadiness` (affordance-planning-offers.ts:192), and the two disagreed by construction on
 * every project approved in the BROWSER — which is every project the browser can approve, since
 * `approval.decide_intent` is the only approval wire it has.
 *
 * The fix corrected the PREREQUISITE rather than withholding the offer (owner decision,
 * comment-5a8278d7). This arm is what proves the two agree afterwards, and it reads BOTH answers
 * off the SAME frame — two arms on two worlds could both be right about different worlds and
 * still let the split reopen.
 *
 * The world is the shipped bootstrap journey driven to its approval and then approved the way
 * the browser approves, through `runApprovalIntentCommand`. Nothing here re-derives ledger
 * state: the frame comes from the production port over a real store.
 */
describe("the offer roster and the step projection agree on a browser-approved goal (task-ebbcbdb4)", () => {
  let intentMints = 0;

  afterAll(closeBootstrapStores);

  /** The shipped journey up to its approval, then the BROWSER's approval and nothing else. */
  function browserApprovedStore(): SqliteEventStore {
    const worldStore = openBootstrapStore();
    driveThrough(worldStore, "approval.decide");
    const commandId = "cmd-intent-approve-affordance";
    const approved = runApprovalIntentCommand({
      commandId,
      correlationId: "corr-affordance-intent",
      decidedAt: "2026-09-05T12:00:00.000Z",
      expectedVersion: worldStore.getAggregateVersion(BOOTSTRAP_RUN_ID),
      humanReview: humanReviewWitness("principal-1", commandId),
      payload: {
        decision: "APPROVE",
        decisionReason: "the plan is sound",
        dependencyChanges: { additions: [], challenges: [], removals: [] },
        runId: BOOTSTRAP_RUN_ID,
      },
      principalId: "principal-1",
      projectId: BOOTSTRAP_PROJECT,
      store: worldStore,
      targetAggregateId: BOOTSTRAP_RUN_ID,
    });
    expect(approved.ok, approved.ok ? "" : `${approved.code}@${approved.refusedBy}`).toBe(true);

    const ledger = readDurableLedger(worldStore, BOOTSTRAP_PROJECT);
    // The divergence the arm rests on: the SEEDED approval kind is absent, so the frame below is
    // answering about a goal only the browser's wire ever approved.
    expect(ledger.kinds.has("approval.decide_intent")).toBe(true);
    expect(ledger.kinds.has("approval.decide")).toBe(false);
    return worldStore;
  }

  function frameOf(worldStore: SqliteEventStore) {
    const worldPort = createAffordancePort({
      mintId: (kind: string) => `afford-intent-${kind}-${String(intentMints += 1)}`,
      projectId: BOOTSTRAP_PROJECT,
      store: worldStore,
    });
    const result = worldPort.readSurface();
    if (result.outcome !== "SURFACE") throw new Error(`surface refused: ${result.code}`);
    return result;
  }

  it("offers goal.close on the same frame whose step projection calls it unblocked", () => {
    const worldStore = browserApprovedStore();

    const frame = frameOf(worldStore);
    const step = frame.steps.find((entry) => entry.kind === "goal.close");
    const offers = frame.nextAllowedCommands.filter(
      (command) => command.commandKind === "goal.close");

    // (a) THE OFFER IS STILL MADE. The fix does not withhold it — withholding would have left a
    // browser-approved goal advertising nothing an operator could ever do.
    expect(offers).toHaveLength(1);
    // (b) AND THE PROJECTION AGREES, on this same frame. `missing: []` is the load-bearing half:
    // BLOCKED with `missing: ["approval.decide"]` is exactly what the live frame carried.
    expect(step).toMatchObject({ missing: [], status: "READY" });
  });

  /**
   * `repository.publish` SHOWED THE IDENTICAL SPLIT and is corrected by the same table entry.
   *
   * Its step is asserted here rather than its dispatch: the publish OFFER is withheld on this
   * world for a different and correct reason — `affordance-planning-offers.ts:178` requires a
   * landed commit, and this fixture journey lands none — so there is no offer to dispatch from
   * the frame. That the widened prerequisite genuinely ACCEPTS a `repository.publish` after a
   * browser approval is proven where a real dispatch is reachable, at the durable level in
   * `bootstrap/bootstrap-durability.test.ts`. What this frame can prove, and what the live UnAI
   * frame got wrong, is that the STEP no longer says BLOCKED on an approval the browser cannot
   * perform.
   */
  it("stops calling the repository.publish step BLOCKED on an approval the browser cannot make", () => {
    const worldStore = browserApprovedStore();

    const frame = frameOf(worldStore);
    const step = frame.steps.find((entry) => entry.kind === "repository.publish");

    expect(step).toMatchObject({ missing: [], status: "READY" });
    // The publish offer is absent, and NOT because this row withheld it: no node of this goal is
    // landed as a commit, which is the landing gate's own answer.
    expect(frame.nextAllowedCommands.filter(
      (command) => command.commandKind === "repository.publish")).toEqual([]);
  });

  /**
   * `goal.close` DISPATCHED FROM ITS OWN OFFER — and it now CLOSES.
   *
   * THE ANSWER MOVED, AND HERE IS WHY (task-8bdd14af). This arm used to assert a REFUSAL: past
   * the sequence gate, but stopped by the goal's own closure fence, because
   * `approval-intent-sources.ts` minted an EMPTY `approvedNodeScope` for an initial-graph
   * approval while `goal-close-prerequisite.ts:87` reads an empty scope as "no approval names an
   * approved node scope". It was written that way on purpose, as a tripwire on a defect one fence
   * deeper than the one task-ebbcbdb4 fixed. The mint now names the sealed revision's
   * execution-bearing nodes, so the scope fence CLEARS — asserted below on the production reader
   * — and what answers is a later closure fence. The accepted close is graded on the
   * contract-bound world of `goals/goal-intent-approved-closure.test.ts`; see the note at the
   * refusal assertion for why this bootstrap world cannot reach it.
   *
   * WHAT THIS ARM IS FOR IS UNCHANGED: the OFFER and the COMMAND PATH must agree on ONE real
   * frame. Every ROUTING parameter below is still taken from the frame's own offer rather than
   * hand-built — kind, target, expected version, command id, schema version — because that is
   * what makes it an agreement test instead of two independent assertions. The PAYLOAD is the
   * operator's, as in production: an offer names what may be done, not the acceptance witnesses
   * the human supplies.
   *
   * AND THAT PAYLOAD IS WHY THE OLD ARM WAS WEAKER THAN IT READ. It sent `{ goalId }` alone and
   * asserted only that the code was not the sequence gate's; measured while updating it, that
   * dispatch was answered BOOTSTRAP_PAYLOAD_INVALID at DAEMON_INGRESS — so it never reached the
   * goal's authority at all, and its name was a claim its assertions could not support. The full
   * `acceptancePayload()` is what carries the dispatch past ingress to the fence being graded.
   */
  it("dispatches the goal.close offer past the sequence gate to the goal's own authority", () => {
    const worldStore = browserApprovedStore();
    // The one execution-bearing node of the sealed revision (bootstrap-test-fixtures.ts:149),
    // which is what the intent approval's `approvedNodeScope` now names.
    seedReviewAcceptance(worldStore, "node-a");
    const frame = frameOf(worldStore);
    const offered = frame.nextAllowedCommands.find(
      (command) => command.commandKind === "goal.close");
    if (offered === undefined) throw new Error("no goal.close offer on the frame");

    const dispatched = runBootstrapCommand(worldStore, encoder.encode(JSON.stringify({
      commandId: offered.commandId,
      correlationId: "corr-affordance-close",
      decidedAt: "2026-09-05T12:00:00.000Z",
      expectedVersion: offered.expectedVersion,
      kind: offered.commandKind,
      payload: acceptancePayload({ goalId: offered.targetAggregateId }),
      principalId: "operator-local",
      projectId: BOOTSTRAP_PROJECT,
      schemaVersion: offered.inputSchemaVersion,
    })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS }, undefined,
    FIXTURE_ACTIVATION_RECEIPTS);

    // THE GOAL'S OWN AUTHORITY ANSWERS — a closure-vocabulary refusal, not the sequence gate's
    // BOOTSTRAP_PREREQUISITE_MISSING. Which closure fence answers moved under this row: commit
    // 4b6d2bc2 landed `goal-approved-execution-scope.ts` and this bootstrap world's planning run
    // carries no compiled Product Contract binding, so its raw-key scope now qualifies only
    // through a Foundation verification receipt it does not hold. The close is graded where it is
    // reachable, on `goals/goal-intent-approved-closure.test.ts`'s contract-bound world.
    expect(dispatched.ok ? "closed" : `${dispatched.code}@${String(dispatched.refusedBy)}`)
      .toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED@DAEMON_PREREQUISITE");
    // NOT admitted by the sequence gate alone, and asserted on the production reader rather than
    // on the code — `publishRepository` proves two authorities can share one code and one layer.
    expect(missingPrerequisites(readDurableLedger(worldStore, BOOTSTRAP_PROJECT), "goal.close"))
      .toEqual([]);
    // The approved scope the closure walked, named rather than assumed: an accepted close against
    // a scope that named some other node would have walked receipts belonging to nobody.
    expect(readApprovedNodeScope(worldStore, BOOTSTRAP_GOAL))
      .toEqual({ approvalRef: `approval:${BOOTSTRAP_RUN_ID}`, scope: ["node-a"] });
  });
});
