/**
 * THE RELEASE EVIDENCE READ, over a REAL store driven through the production planning journey.
 *
 * The world is the one `release-durable-facts.test.ts` uses — a bound project, a committed
 * Product Contract revision, Gate 1 approved, a decomposition submitted and the plan approved —
 * because that is what gives the goal APPROVED SCOPE, which is what `readReleaseDossierInput`
 * folds. The bootstrap seed world (`driveThrough`) has publish requests but no approved scope,
 * so it cannot exercise the evidence half at all; measured, not assumed.
 *
 * THE ARM THAT MATTERS IS THE MIXED ONE. A dossier where every criterion is clean, or every
 * criterion has a gap, cannot tell a reader whether the covered/UNKNOWN distinction survived
 * the wire — both counts move together and a projection that collapsed them would still pass.
 * The mixed world below lands and accepts evidence for ONE of two nodes, so the two counts are
 * non-zero AND different from each other.
 */
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit,
} from "../planning/plan-reject-test-fixtures.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import {
  REPOSITORY_PUBLISH_COMMAND_KIND, publishAggregateId,
} from "../repository/publish-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  calibration, envelope, packageItems, policyInput, submitPayload,
} from "../review/review-test-fixtures.js";
import { NODE_VERIFIER_PRINCIPAL_ID, recordVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { releaseDossierAggregateId } from "../release/release-dossier-contracts.js";
import { readReleaseReceipt, recordReleaseReceipt } from "../release/release-receipt-ledger.js";
import { releaseReceiptId } from "../release/release-receipt-contracts.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readReleaseForGoal } from "./release-evidence-read.js";
import type { AncestryFactory, ReleaseReadAnswer } from "./release-evidence-read.js";
import { handleReleaseReadRequest, releaseReadBodyOf } from "./release-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, Authenticator } from "./http-contract.js";

afterEach(closeStores);

const NOW = "2026-09-06T00:00:00.000Z";
const SOURCE_SHA = "a".repeat(40);
const LANDING_SHA = "b".repeat(40);
const RELEASE_SHA = "c".repeat(40);
/** A workspace that re-measures every cited landing as an ancestor of the release sha. */
const ANCESTOR: AncestryFactory = () => () => "ANCESTOR";
/** No bound workspace: the factory answers null and nothing is re-measured. */
const NO_WORKSPACE: AncestryFactory = () => null;
const REMOTE_URL = "https://github.com/example/product.git";
const OPERATOR = "operator-local";
const PR_URL = "https://github.com/example/product/pull/7";

/** Two execution-bearing nodes, one criterion each, so their evidence can differ. */
function twoNodeWorld(): { readonly store: SqliteEventStore; readonly apiRef: string } {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  expect(submit(store, ref, {
    structure: structureOf([
      nodeOf("node-api", ["crit-api"], [], "Land the record read."),
      nodeOf("node-ui", ["crit-ui"], ["node-api"], "Land the page."),
    ], "node-ui"),
  }).ok).toBe(true);
  approvePlan(store, RUN_ID);
  const goal = readCriterionGoal(store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(goal.code);
  return { apiRef: compiledExecutionRef(PROJECT_ID, goal.graph, "node-api"), store };
}

/** A real accepted verifier receipt for one node, through the review command path. */
function accept(store: SqliteEventStore, nodeRef: string): string {
  const review = (kind: string, version: number, payload: Record<string, unknown>): { ok: boolean } =>
    runReviewCommand(store, new TextEncoder().encode(JSON.stringify({
      ...envelope(kind, version, payload), projectId: PROJECT_ID,
    })));
  expect(review("review.submit", 0, submitPayload(1, [], { subjectRef: nodeRef })).ok).toBe(true);
  const source = readReviewLedger(store, PROJECT_ID, nodeRef).rounds.at(-1);
  if (source === undefined) throw new Error("no review round to attest");
  const verified = recordVerifierReceipt(store, {
    authority: {
      calibration: calibration(),
      packageItems: packageItems().filter((item) => item.kind !== "DAEMON_RECEIPT"),
      policy: policyInput({ actor: NODE_VERIFIER_PRINCIPAL_ID }),
    },
    decidedAt: NOW, execution: {
      byteCount: 2, outputSha256: "c".repeat(64), test: "pnpm test", workspace: "/fixture-workspace",
      workspaceBinding: {
        branchRef: "refs/heads/main", dirtySha256: "e".repeat(64), headSha: SOURCE_SHA,
        root: "/fixture-workspace", treeSha: "d".repeat(40), version: "moe-verified-workspace/1",
      },
    },
    projectId: PROJECT_ID, source, subjectRef: nodeRef,
  });
  if (!verified.ok) throw new Error(verified.code);
  expect(review("integration.accept_output", verified.decision.currentVersion, {
    receiptId: verified.receipt.receiptId, subjectRef: nodeRef,
  }).ok).toBe(true);
  return verified.receipt.receiptId;
}

function land(store: SqliteEventStore, nodeRef: string, verifierReceiptId: string): void {
  expect(recordLandingReceipt(store, {
    commit: {
      branch: "main", files: ["product.ts"], message: "Land product",
      parentSha: SOURCE_SHA, sha: LANDING_SHA,
    },
    decidedAt: NOW, projectId: PROJECT_ID, refusal: null, subjectRef: nodeRef,
    verifierReceiptId, workspace: "/fixture-workspace",
  }).ok).toBe(true);
}


/**
 * A PUSHED publication for the goal, written the way the ledger reads it: a committed
 * `repository.publish` decision (the REQUEST) and the publisher's receipt against it. Without a
 * publication there is no sha, and with no sha nothing can be re-measured — so this is what
 * makes the covered/UNKNOWN split observable at all.
 */
function publish(store: SqliteEventStore): string {
  const encoder = new TextEncoder();
  const target = publishAggregateId(GOAL_ID);
  const response = store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_PUBLISH_COMMAND_KIND,
    committedResultBytes: encoder.encode(JSON.stringify({
      candidate: null, goalId: GOAL_ID, remoteUrl: REMOTE_URL,
    })),
    correlationId: "release-read-publish",
    decidedAt: NOW,
    events: [{
      eventId: `${GOAL_ID}-PublishRequested`, eventType: "RepositoryPublishRequested",
      payload: encoder.encode(JSON.stringify({ goalId: GOAL_ID, remoteUrl: REMOTE_URL })),
    }],
    expectedVersion: store.getAggregateVersion(target),
    key: { commandId: "cmd-release-read-publish", principalId: OPERATOR, projectId: PROJECT_ID },
    requestBytes: encoder.encode(JSON.stringify({ goalId: GOAL_ID, remoteUrl: REMOTE_URL })),
    targetAggregateId: target,
  });
  expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
  const request = readPublishLedger(store, PROJECT_ID).get(GOAL_ID)?.requests.at(-1);
  if (request === undefined) throw new Error("the publish request did not reach the ledger");
  expect(recordPublishReceipt(store, {
    branch: "main", decidedAt: NOW, decisionId: request.decisionId, goalId: GOAL_ID,
    projectId: PROJECT_ID, refusal: null, remoteUrl: REMOTE_URL, sha: RELEASE_SHA, url: null,
  }).ok).toBe(true);
  return RELEASE_SHA;
}

/** The covered/UNKNOWN split a card computes, taken the way a card would take it. */
function counts(answer: ReleaseReadAnswer): { readonly covered: number; readonly unknown: number } {
  if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
  const rows = answer.evidence.criteria;
  return {
    covered: rows.filter((row) => row.gaps.length === 0).length,
    unknown: rows.filter((row) => row.gaps.length > 0).length,
  };
}

it("keeps covered and UNKNOWN criteria DISTINGUISHABLE, per row, without any markdown", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));
  publish(store);

  const answer = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
  // NON-VACUITY first: a fixture that silently produced no rows would satisfy every count below.
  expect(answer.evidence.criteria.length).toBe(2);

  // BOTH NON-ZERO AND DIFFERENT FROM EACH OTHER. An all-clean or all-gapped world would let a
  // projection that had collapsed the distinction pass this arm.
  const { covered, unknown } = counts(answer);
  expect(covered).toBe(1);
  expect(unknown).toBe(1);

  // The gap says WHICH criterion and WHY, not merely that something is missing: a count alone
  // cannot tell an operator what to go and fix.
  expect(answer.evidence.sha).toBe(RELEASE_SHA);
  expect(answer.evidence.ancestryMeasured).toBe(true);

  const gapped = answer.evidence.criteria.find((row) => row.gaps.length > 0);
  expect(gapped?.criterionId).toBe("crit-ui");
  expect(gapped?.gaps.map((gap) => gap.code)).toEqual(["RECEIPT_ABSENT", "LANDING_ABSENT"]);
  expect(gapped?.gaps.every((gap) => gap.criterionId === "crit-ui")).toBe(true);
  expect(gapped?.landing).toBe("UNKNOWN");

  const clean = answer.evidence.criteria.find((row) => row.gaps.length === 0);
  expect(clean?.criterionId).toBe("crit-api");
  expect(clean?.landing).toBe(LANDING_SHA);
});

it("says when nothing measured the landings, so UNKNOWN is not read as failed evidence", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));

  const measured = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  // No publication, so there is no sha to re-measure against and the factory is never consulted.
  if (measured.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${measured.kind}`);
  expect(measured.evidence.sha).toBeNull();
  expect(measured.evidence.ancestryMeasured).toBe(false);
  // The RECEIPT half of the evidence does not depend on a sha, so it still reads true: the
  // landed node keeps its command and exit code while its landing reads UNKNOWN.
  const clean = measured.evidence.criteria.find((row) => row.criterionId === "crit-api");
  expect(clean?.command).toBe("pnpm test");
  expect(clean?.exitCode).toBe("0");

  const unmeasurable = readReleaseForGoal(
    store, { goalId: GOAL_ID, projectId: PROJECT_ID }, NO_WORKSPACE,
  );
  expect(unmeasurable.kind === "PRESENT" && unmeasurable.evidence.ancestryMeasured).toBe(false);
});

it("answers ABSENT for a goal with no approved scope, which is not a refusal", () => {
  const store = boundWorld();
  const answer = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  expect(answer).toEqual({ goalId: GOAL_ID, kind: "ABSENT" });
  expect(readReleaseForGoal(store, { goalId: "missing-goal", projectId: PROJECT_ID }, ANCESTOR))
    .toEqual({ goalId: "missing-goal", kind: "ABSENT" });
});

it("READS ONLY: neither the goal nor the release aggregate moves", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));
  // PUBLISHED FIRST, and that is load-bearing rather than setup: with no sha there is nothing
  // to re-measure and nothing to record, so an unpublished world cannot reach the write this
  // arm exists to forbid. Measured — the drill that injects a `recordReleaseDossier` call into
  // the read passes unnoticed against an unpublished fixture.
  publish(store);
  const releaseTarget = releaseDossierAggregateId(GOAL_ID);
  const goalBefore = store.getAggregateVersion(GOAL_ID);
  const releaseBefore = store.getAggregateVersion(releaseTarget);

  for (let call = 0; call < 3; call += 1) {
    expect(readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR).kind)
      .toBe("PRESENT");
  }

  // A read that recorded a dossier would move the RELEASE aggregate and invalidate the
  // expectedVersion a live affordance offer is carrying; one that wrote to the goal would drop
  // the goal out of `durableGoals` entirely, with nothing thrown.
  expect(store.getAggregateVersion(GOAL_ID)).toBe(goalBefore);
  expect(store.getAggregateVersion(releaseTarget)).toBe(releaseBefore);
});

it("admits EXACTLY {goalId} on the wire; the project comes from the principal", () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  expect(releaseReadBodyOf(encode({ goalId: GOAL_ID }))).toEqual({ goalId: GOAL_ID });
  expect(releaseReadBodyOf(encode({ goalId: GOAL_ID, projectId: PROJECT_ID }))).toBeNull();
  expect(releaseReadBodyOf(encode({ goalId: "" }))).toBeNull();
  expect(releaseReadBodyOf(encode([GOAL_ID]))).toBeNull();
  expect(releaseReadBodyOf(encode("goal"))).toBeNull();
});

it("refuses an unconfigured route at the LISTENER, and a capability-less caller at the route", () => {
  const authenticator = (capabilities: readonly string[]): Authenticator => ({
    authenticate: (credential: string | null): AuthenticationResult => credential === "cred"
      ? {
        principal: { capabilities, principalId: "prin-release", projectId: PROJECT_ID },
        verdict: "AUTHENTICATED",
      }
      : { verdict: "UNAUTHENTICATED" },
  });
  const call = (capabilities: readonly string[]): ReturnType<typeof handleReleaseReadRequest> =>
    handleReleaseReadRequest({ authenticator: authenticator(capabilities) }, {
      body: new TextEncoder().encode(JSON.stringify({ goalId: GOAL_ID })),
      credential: "cred", protocolVersion: WIRE_PROTOCOL_VERSION,
    });

  // A route the composition never wired refuses at the LISTENER rather than answering ABSENT:
  // "no release evidence" and "this daemon does not serve the read" are different facts.
  expect(call([CAPABILITIES.GOAL])).toEqual({
    code: "LISTENER_RELEASE_UNAVAILABLE", kind: "LISTENER_REFUSAL",
  });
  // The capability fence answers with its own code AND its layer, never a bare failure.
  expect(call([])).toEqual({
    body: { code: "RELEASE_READ_CAPABILITY_DENIED", kind: "REFUSED", layer: "RELEASE_READ" },
    httpStatus: 200, kind: "REPLY",
  });
});

it("reads a REFUSED release receipt, which the deployments read cannot see at all", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));
  const sha = publish(store);
  const refusal = recordReleaseReceipt(store, {
    decidedAt: NOW, dossierSha256: "d".repeat(64), goalId: GOAL_ID, outcome: "REFUSED",
    prUrl: null, projectId: PROJECT_ID, refusalCode: "RELEASE_EVIDENCE_INCOMPLETE", sha,
  });
  if (!refusal.ok) throw new Error(refusal.code);

  const answer = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
  // THE POINT OF THE LEDGER WALK. `releaseReceiptId` hashes the outcome AND the refusal code,
  // so `goal-deployment-read.ts`, which looks up (..., "RELEASED", null), can never find this
  // receipt however hard it tries. Asserted BY VALUE, including the code the operator reads.
  expect(answer.evidence.receipt).toEqual({
    dossierSha256: "d".repeat(64), outcome: "REFUSED", prUrl: null,
    receiptId: refusal.receipt.receiptId, refusalCode: "RELEASE_EVIDENCE_INCOMPLETE", sha,
  });
  // A positive control on the same store: the id-keyed lookup the deployments read performs
  // finds NOTHING for this goal, so the walk is doing work no existing reader could do.
  expect(readReleaseReceipt(store, PROJECT_ID,
    releaseReceiptId(PROJECT_ID, GOAL_ID, sha, "RELEASED", null)).ok).toBe(false);
});

it("reads a RELEASED receipt with the PR link an operator clicks", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));
  const sha = publish(store);
  const released = recordReleaseReceipt(store, {
    decidedAt: NOW, dossierSha256: "e".repeat(64), goalId: GOAL_ID, outcome: "RELEASED",
    prUrl: PR_URL, projectId: PROJECT_ID, refusalCode: null, sha,
  });
  if (!released.ok) throw new Error(released.code);

  const answer = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  if (answer.kind !== "PRESENT") throw new Error(`expected PRESENT, got ${answer.kind}`);
  expect(answer.evidence.receipt).toEqual({
    dossierSha256: "e".repeat(64), outcome: "RELEASED", prUrl: PR_URL,
    receiptId: released.receipt.receiptId, refusalCode: null, sha,
  });
  // NAMED MEMBERS ONLY: the projection carries these six and nothing the receipt grows later.
  expect(Object.keys(answer.evidence.receipt ?? {}).sort()).toEqual([
    "dossierSha256", "outcome", "prUrl", "receiptId", "refusalCode", "sha",
  ]);
});

it("has no receipt to answer before anything is published", () => {
  const { apiRef, store } = twoNodeWorld();
  land(store, apiRef, accept(store, apiRef));
  const answer = readReleaseForGoal(store, { goalId: GOAL_ID, projectId: PROJECT_ID }, ANCESTOR);
  // Null, not a fabricated pending receipt: the receipt is keyed by the sha, and there is none.
  expect(answer.kind === "PRESENT" && answer.evidence.receipt).toBeNull();
});
