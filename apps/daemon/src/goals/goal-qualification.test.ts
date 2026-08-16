import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  SUBMISSION_HASH,
  approvalRecord,
  closeStores,
  decisionCount,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND,
  FOUNDATION_VERIFICATION_EVENT_TYPES,
} from "../evidence/foundation-verification-contracts.js";
import { deriveVerificationAggregateId } from "../evidence/foundation-verification-service.js";
import {
  decodeFoundationPayload,
  encodeFoundationPayload,
} from "../work/foundation-attempt-codec.js";
import {
  FOUNDATION_DISPATCH_COMMAND_KIND,
  FOUNDATION_DISPATCH_EVENT_TYPES,
  deriveDispatchAggregateId,
} from "../work/foundation-attempt-contracts.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { readReviewLedger } from "../review/review-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { deltaNode, packageItems, replanPayload } from "../review/review-test-fixtures.js";
import {
  approveNodes,
  cleanupGoalClosureFixtures,
  seedProvenAttempt,
  seedReviewAcceptance,
  seedVerifiedNode,
} from "./goal-closure-test-fixtures.js";
import { GOAL_CLOSURE_WITNESS_VERSION, qualifyGoalClosure } from "./goal-qualification.js";

/**
 * The daemon prerequisite composer for `goal.close`, read straight out of durable bytes.
 *
 * EVERY ARM SEEDS EVERYTHING ELSE VALID. A refusal test whose seeded condition is also visible
 * to an earlier guard passes while testing nothing (`mem:refusal-test-answered-by-earlier-guard`),
 * and these guards sit behind one another in a single loop — so each case below leaves exactly
 * one durable fact wrong and pins the EXACT code, never merely "refused".
 *
 * `qualifyGoalClosure` is a pure read: it commits nothing, ever. Each arm therefore snapshots the
 * store after seeding and re-reads it afterwards, because a composer that mutated and then
 * refused would sail through a return-value-only assertion.
 */

const PRINCIPAL_ID = "principal-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const encoder = new TextEncoder();

interface StoreSnapshot {
  readonly decisions: number;
  readonly goal: unknown;
  readonly goalEvents: number;
}

function snapshot(store: SqliteEventStore): StoreSnapshot {
  return {
    decisions: decisionCount(store),
    goal: readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result,
    goalEvents: store.readEvents(GOAL_ID).length,
  };
}

function expectUnmoved(store: SqliteEventStore, before: StoreSnapshot): void {
  expect(decisionCount(store)).toBe(before.decisions);
  expect(readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result)
    .toEqual(before.goal);
  expect(store.readEvents(GOAL_ID)).toHaveLength(before.goalEvents);
}

/** Commits arbitrary bytes as a RECEIPTED row, so a drifted payload can be planted without
 *  going through the canonical encoder — the only way to reach the byte-compare branch. */
function commitRawReceipt(
  store: SqliteEventStore, verificationId: string, payload: Uint8Array,
): void {
  const aggregateId = deriveVerificationAggregateId(verificationId);
  const written = store.commitExpectedVersionDecision({
    commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND, committedResultBytes: payload,
    correlationId: `corr-raw-${verificationId}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `${aggregateId}:RAW`, eventType: FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED,
      payload,
    }],
    expectedVersion: store.readEvents(aggregateId).length,
    key: {
      commandId: `cmd-raw-${verificationId}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: payload, targetAggregateId: aggregateId,
  });
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** A SECOND RECORDED event on the dispatch aggregate: the shape a concurrent writer leaves
 *  when the verified result moves after the receipt was minted. */
function appendSecondAttemptRecord(store: SqliteEventStore, attemptAggregateId: string): void {
  const target = deriveDispatchAggregateId(attemptAggregateId);
  const encoded = encodeFoundationPayload({ duplicate: true, target });
  if (!encoded.ok) throw new Error("second record fixture could not be encoded");
  const written = store.commitExpectedVersionDecision({
    commandKind: FOUNDATION_DISPATCH_COMMAND_KIND, committedResultBytes: encoded.bytes,
    correlationId: `corr-second-${target}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `${target}:SECOND`, eventType: FOUNDATION_DISPATCH_EVENT_TYPES.RECORDED,
      payload: encoded.bytes,
    }],
    expectedVersion: store.readEvents(target).length,
    key: { commandId: `cmd-second-${target}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: encoded.bytes, targetAggregateId: target,
  });
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

function expectRefused(outcome: ReturnType<typeof qualifyGoalClosure>, code: string): void {
  expect(outcome).toMatchObject({ code, layer: "DAEMON_PREREQUISITE", ok: false });
}

/**
 * Two guards share GOAL_CLOSE_REVIEW_PACKAGE_STALE and two share GOAL_CLOSE_AUTHORITY_REMAINS,
 * so code plus layer cannot tell them apart and a fixture that never reached its guard would
 * still pass (`mem:gotcha-one-code-many-guards-needs-the-message-as-discriminator`). The exact
 * message is pinned instead. Deliberately brittle, and that is what makes it discriminating.
 */
function expectRefusedExactly(
  outcome: ReturnType<typeof qualifyGoalClosure>, code: string, message: string,
): void {
  expect(outcome).toMatchObject({ code, layer: "DAEMON_PREREQUISITE", message, ok: false });
}

/**
 * Replaces the durable acceptance with a shape-valid one. `readReviewLedger` folds acceptances
 * in decision order and the last one wins, so this is how a specific acceptance record is put
 * in front of the composer without any handler ever agreeing to write it.
 */
function stageAcceptance(
  store: SqliteEventStore, nodeRef: string, overrides: Record<string, string>,
): void {
  const result = encoder.encode(JSON.stringify({
    policyDecision: "ALLOW",
    reviewInputDigest: "b".repeat(64),
    reviewerCalibrationDigest: "c".repeat(64),
    verifierReceiptId: "verifier-receipt-that-does-not-exist",
    verifierReceiptSha256: "d".repeat(64),
    ...overrides,
  }));
  const written = store.commitExpectedVersionDecision({
    commandKind: "integration.accept_output", committedResultBytes: result,
    correlationId: "corr-stale-acceptance", decidedAt: DECIDED_AT,
    events: [{
      eventId: `cmd-stale-acceptance-${nodeRef}`, eventType: "ReviewOutputAccepted",
      payload: encoder.encode(JSON.stringify({ subjectRef: nodeRef })),
    }],
    expectedVersion: readReviewLedger(store, PROJECT_ID, nodeRef).version,
    key: {
      commandId: `cmd-stale-acceptance-${nodeRef}`, principalId: "reviewer-1",
      projectId: PROJECT_ID,
    },
    requestBytes: result, targetAggregateId: nodeRef,
  });
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** One more clean review round AFTER acceptance: the accepted verifier receipt attests a round
 *  that is no longer the latest, so the review package moved on underneath the acceptance. */
function submitLaterRound(store: SqliteEventStore, nodeRef: string): void {
  const ledger = readReviewLedger(store, PROJECT_ID, nodeRef);
  const round = ledger.lineage.highestRound + 1;
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-later-round-${nodeRef}-${String(round)}`,
    correlationId: "corr-later-round",
    decidedAt: DECIDED_AT,
    expectedVersion: ledger.version,
    kind: "review.submit",
    payload: { findings: [], packageItems: packageItems(), round, subjectRef: nodeRef },
    principalId: "author-1",
    projectId: PROJECT_ID,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`later round setup failed: ${outcome.code}`);
}

/** A real re-plan through the production handler: a durable successor plan for the node. */
function recordReplan(store: SqliteEventStore, nodeRef: string): void {
  const ledger = readReviewLedger(store, PROJECT_ID, nodeRef);
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-replan-${nodeRef}`,
    correlationId: "corr-replan",
    decidedAt: DECIDED_AT,
    expectedVersion: ledger.version,
    kind: "qualification.replan",
    payload: replanPayload([deltaNode(nodeRef)], { subjectRef: nodeRef }),
    principalId: "reviewer-1",
    projectId: PROJECT_ID,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`replan setup failed: ${outcome.code}`);
}

/** A FIFTH event on the activation aggregate, which carries the ledger row plus its exact
 *  three-transition tail. The history read can no longer say which events are the tail. */
function blurActivationHistory(store: SqliteEventStore, attemptAggregateId: string): void {
  const encoded = encodeFoundationPayload({ blurred: attemptAggregateId });
  if (!encoded.ok) throw new Error("blur fixture could not be encoded");
  const written = store.commitExpectedVersionDecision({
    commandKind: FOUNDATION_DISPATCH_COMMAND_KIND, committedResultBytes: encoded.bytes,
    correlationId: `corr-blur-${attemptAggregateId}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `${attemptAggregateId}:BLUR`, eventType: FOUNDATION_DISPATCH_EVENT_TYPES.RECORDED,
      payload: encoded.bytes,
    }],
    expectedVersion: store.readEvents(attemptAggregateId).length,
    key: {
      commandId: `cmd-blur-${attemptAggregateId}`, principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes, targetAggregateId: attemptAggregateId,
  });
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/**
 * The witness derivation, RESTATED BY HAND rather than imported. Calling the production helper
 * on the production inputs would compare a value with itself; only the version tag is shared,
 * and a constant is not a derivation.
 */
function expectedRef(tag: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${GOAL_CLOSURE_WITNESS_VERSION}|${tag}`);
  for (const part of parts) hash.update(`|${String(part.length)}:${part}`);
  return hash.digest("hex");
}

function acceptedOf(store: SqliteEventStore, nodeRef: string): Readonly<{
  readonly reviewInputDigest: string; readonly verifierReceiptSha256: string;
}> {
  const accepted = readReviewLedger(store, PROJECT_ID, nodeRef).accepted;
  if (accepted === undefined) throw new Error(`no durable acceptance for ${nodeRef}`);
  return accepted;
}

afterEach(closeStores);
afterEach(cleanupGoalClosureFixtures);

describe("goal closure qualification — the durable evidence half", () => {
  it("refuses RECEIPT_ABSENT for an approved node no verification receipt names", async () => {
    const store = openStore();
    approveNodes(store, ["node-1", "node-2"]);
    // Both nodes are fully reviewed and accepted, so the review guard cannot answer for either.
    seedReviewAcceptance(store, "node-1");
    seedReviewAcceptance(store, "node-2");
    await seedVerifiedNode(store, "node-1");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT");
    expectUnmoved(store, before);
  }, 60_000);

  it("refuses RECEIPT_AMBIGUOUS when two durable receipts name the same node", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    await seedVerifiedNode(store, "node-1");
    // A SECOND real verification of the SAME node: two rows, and picking either is a guess.
    await seedVerifiedNode(store, "node-1");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS");
    expectUnmoved(store, before);
  }, 60_000);

  it("refuses RECEIPT_UNREADABLE when a durable receipt's bytes are not canonical", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const seeded = await seedVerifiedNode(store, "node-1");
    // The SAME receipt object re-serialised non-canonically under its own verification id. It
    // decodes to a deep-equal row, so only the byte compare inside `readStoredReceipt` can
    // catch it — an index that trusted the scanned bytes would hand this back as evidence.
    const source = encodeFoundationPayload(seeded.row);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const decoded = decodeFoundationPayload(source.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const drifted = encoder.encode(
      JSON.stringify({ ...decoded.value, verificationId: "verify-drifted-copy" }, null, 1));
    commitRawReceipt(store, "verify-drifted-copy", drifted);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE");
    expectUnmoved(store, before);
  }, 60_000);

  it("refuses NOT_PASSED for a durable receipt read back with verdict FAILED", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    // A real run of a real verifier that answered no. That is evidence, and it is not a pass.
    const seeded = await seedVerifiedNode(store, "node-1", { failing: true });
    expect(seeded.row["verdict"]).toBe("FAILED");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_VERIFICATION_NOT_PASSED");
    expectUnmoved(store, before);
  }, 60_000);

  it("refuses RESULT_DIGEST_MISMATCH when the verified result moved after the receipt", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const seeded = await seedVerifiedNode(store, "node-1");
    // The receipt still says PASSED; the record it names no longer reads back as the one that
    // was verified, so the pass describes a result the store no longer holds.
    appendSecondAttemptRecord(store, seeded.attemptAggregateId);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_RESULT_DIGEST_MISMATCH");
    expectUnmoved(store, before);
  }, 60_000);
});

describe("goal closure qualification — the review and authority halves", () => {
  it("refuses REVIEW_ACCEPTANCE_REQUIRED for a verified node with no durable acceptance",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      await seedVerifiedNode(store, "node-1");
      expect(readReviewLedger(store, PROJECT_ID, "node-1").accepted).toBeUndefined();
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefused(outcome, "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses REVIEW_PACKAGE_STALE when the accepted verifier receipt does not read back",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      stageAcceptance(store, "node-1", {});
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
        "the accepted verifier receipt does not read back");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses REVIEW_PACKAGE_STALE when the acceptance disagrees with the receipt it names",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      // The receipt id is the REAL one, so the read-back guard above cannot answer; only the
      // sha256 the acceptance claims for it is wrong.
      const real = readReviewLedger(store, PROJECT_ID, "node-1").accepted;
      if (real === undefined) throw new Error("the fixture recorded no acceptance");
      stageAcceptance(store, "node-1", {
        verifierReceiptId: real.verifierReceiptId, verifierReceiptSha256: "e".repeat(64),
      });
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
        "the accepted verifier receipt does not match the acceptance");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses REVIEW_PACKAGE_STALE when a durable re-plan supersedes the accepted package",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      // `noPendingDraftOrSupersession` is asserted true in the derived witness, so a recorded
      // successor plan has to refuse rather than be asserted away.
      recordReplan(store, "node-1");
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
        "a durable re-plan supersedes the accepted review package");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses REVIEW_PACKAGE_STALE when a later review round supersedes the accepted one",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      // The acceptance still reads back perfectly; what moved is the review package under it.
      submitLaterRound(store, "node-1");
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
        "the accepted verifier receipt no longer attests the latest review round");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses AUTHORITY_REMAINS for an in-scope activation no accepted receipt names",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      // A SECOND durable activation carrying the same nodeKey, verified by nothing. Design 278
      // demands proof that NO authority outlives the goal, and this one is unaccounted for.
      seedProvenAttempt(store, "node-1");
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
        "a durable activation is not named by its node's evidence receipt");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses AUTHORITY_REMAINS when the receipt's own activation does not read back",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      const seeded = await seedVerifiedNode(store, "node-1");
      // Unreadable authority is not zero authority. The aggregate is still the one the receipt
      // names, so only the read-back clause can answer.
      blurActivationHistory(store, seeded.attemptAggregateId);
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
        "a durable activation does not read back as its receipt's lease and effect");
      expectUnmoved(store, before);
    }, 60_000);
});

/**
 * The positive arm, and it is load-bearing rather than a smoke test: a refusal-only suite is
 * blind to a WRONG accepted value (`mem:refusal-only-suite-cannot-see-a-wrong-accepted-value`).
 * Every derived ref is recomputed here from the bytes this test seeded.
 */
describe("goal closure qualification — the accepted value", () => {
  it("derives both witnesses from the durable bytes of every approved node", async () => {
    const store = openStore();
    const nodes = ["node-1", "node-2"] as const;
    approveNodes(store, [...nodes]);
    seedReviewAcceptance(store, "node-1");
    seedReviewAcceptance(store, "node-2");
    const first = await seedVerifiedNode(store, "node-1");
    const second = await seedVerifiedNode(store, "node-2");
    const seeded = [first, second];
    const before = snapshot(store);
    const approvalRef = String(approvalRecord(SUBMISSION_HASH)["approvalRef"]);
    const activations = store
      .readEventsByTypeAfter(ACTIVATION_LEDGER_EVENT_TYPE, 0n, 200).items.length;
    expect(activations).toBe(2);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.closureWitness).toEqual({
      acceptanceClosureRef: expectedRef("acceptance", [
        approvalRef,
        ...seeded.flatMap((entry) => {
          const accepted = acceptedOf(store, entry.nodeRef);
          return [
            entry.nodeRef, entry.receiptSha256, accepted.verifierReceiptSha256,
            accepted.reviewInputDigest,
          ];
        }),
      ]),
      completionNodeAcceptedRef: expectedRef("completion-nodes", [...nodes]),
      noCurrentPreparationGeneration: true,
      noPendingDraftOrSupersession: true,
      obligationsHoldRef: expectedRef("obligations", seeded.flatMap((entry) => {
        const receipt = entry.row["receipt"] as Record<string, unknown>;
        return [entry.nodeRef, JSON.stringify(receipt["obligations"])];
      })),
      truthClass: "DAEMON_VERIFIED",
    });
    expect(outcome.zeroAuthorityWitness).toEqual({
      truthClass: "DAEMON_VERIFIED",
      zeroAuthorityProofRef: expectedRef("zero-authority", [
        String(activations),
        ...seeded.flatMap((entry) => [entry.leaseIdentity, entry.effectIdentity]),
      ]),
    });
    // Qualification decides; it never writes.
    expectUnmoved(store, before);
  }, 90_000);
});
