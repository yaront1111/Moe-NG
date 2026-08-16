import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
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
import { readFoundationAttemptRecord } from "../work/foundation-attempt-store.js";
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
  targetAggregateId?: string,
): void {
  const aggregateId = targetAggregateId ?? deriveVerificationAggregateId(verificationId);
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

function receiptOf(row: Record<string, unknown>): Record<string, unknown> {
  const receipt = row["receipt"];
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    throw new TypeError("the template row carries no receipt");
  }
  return receipt as Record<string, unknown>;
}

interface PlantedOverrides {
  readonly receipt?: Record<string, unknown>;
  readonly row?: Record<string, unknown>;
}

/**
 * A canonical RECEIPTED row, built from a REAL production-minted receipt with named fields
 * drifted and committed under its own verification id.
 *
 * Planting is the ONLY way to reach the guards that compare a receipt against the record and the
 * activation it names: a receipt the real chain mints agrees with both BY CONSTRUCTION, so every
 * such guard is unreachable from an honest seed and a suite built only on honest seeds leaves
 * them unguarded. The bytes still go through `encodeFoundationPayload`, so `readStoredReceipt`'s
 * decode/re-encode byte compare accepts the row and the refusal under test is the only one that
 * can answer.
 */
function plantReceipt(
  store: SqliteEventStore, template: Record<string, unknown>, verificationId: string,
  overrides: PlantedOverrides,
): void {
  const receipt = { ...receiptOf(template), ...overrides.receipt };
  const encoded = encodeFoundationPayload({
    ...template, ...overrides.row, receipt, verificationId,
  });
  if (!encoded.ok) throw new Error("the planted receipt could not be encoded");
  commitRawReceipt(store, verificationId, encoded.bytes);
}

/** The lease and effect identities a durable activation actually reads back as. */
function activationIdentities(
  store: SqliteEventStore, attemptAggregateId: string,
): Readonly<{ effectIdentity: string; leaseIdentity: string }> {
  const history = readFoundationActivationHistory(
    attemptAggregateId, store.readEvents(attemptAggregateId), PROJECT_ID);
  if (!history.ok) throw new Error("the seeded activation does not read back");
  return {
    effectIdentity: history.history.record.effectIntent.intentId,
    leaseIdentity: history.history.record.lease.leaseId,
  };
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

  /**
   * THE SCANNED BYTES ARE NEVER THE ANSWER — the module's headline claim, made falsifiable.
   *
   * A decoy row is committed to its OWN aggregate while naming another verification's id, so the
   * scanned bytes claim `node-1` and the row those bytes point at is the real, out-of-scope
   * `node-src` receipt. Reading the SCANNED value would admit a receipt for a node nothing
   * verified; reading the STORED row skips it and leaves node-1 with no evidence at all.
   */
  it("indexes the stored row a receipt points at, never the bytes that pointed at it", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const template = await seedVerifiedNode(store, "node-src");
    const decoy = encodeFoundationPayload({
      ...template.row, receipt: { ...receiptOf(template.row), graphIdentity: "node-1" },
      verificationId: template.verificationId,
    });
    expect(decoy.ok).toBe(true);
    if (!decoy.ok) return;
    commitRawReceipt(store, template.verificationId, decoy.bytes,
      deriveVerificationAggregateId("verify-decoy-aggregate"));
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT");
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

  /**
   * The UNREADABLE half of `verifiedResultHolds`: the record no longer reads back at all, so
   * `stored.ok` is what refuses. Stated exactly, because the digest comparison beside it is a
   * SEPARATE clause and this case never reaches it — the arm below is the one that does.
   */
  it("refuses RESULT_DIGEST_MISMATCH when the verified result no longer reads back", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const seeded = await seedVerifiedNode(store, "node-1");
    appendSecondAttemptRecord(store, seeded.attemptAggregateId);
    // The precondition that makes this the ok-clause case and not the digest one.
    expect(readFoundationAttemptRecord(store, seeded.attemptAggregateId).ok).toBe(false);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefused(outcome, "GOAL_CLOSE_RESULT_DIGEST_MISMATCH");
    expectUnmoved(store, before);
  }, 60_000);

  /**
   * The DIGEST half, which no honest seed can reach: a real chain mints a receipt whose
   * `recordDigest` is the record's own digest by construction. Here the record reads back
   * cleanly — `stored.ok` is asserted TRUE — and only the digest the receipt claims for it is
   * wrong, so the comparison is the sole guard that can answer.
   */
  it("refuses RESULT_DIGEST_MISMATCH when the receipt claims a digest the record does not hold",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      const ground = seedProvenAttempt(store, "node-1");
      // A real PASSED receipt for an OUT-OF-SCOPE node, used only as the template every planted
      // field is drifted from. Its own row stays out of scope and is never the answer here.
      const template = await seedVerifiedNode(store, "node-src");
      plantReceipt(store, template.row, "verify-planted-digest", {
        receipt: { ...activationIdentities(store, ground.attemptAggregateId),
          graphIdentity: "node-1" },
        row: { attemptAggregateId: ground.attemptAggregateId, recordDigest: "f".repeat(64) },
      });
      const stored = readFoundationAttemptRecord(store, ground.attemptAggregateId);
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(stored.digest).not.toBe("f".repeat(64));
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

  /**
   * ONE operand drifts per case. `stageAcceptance` supplies its own defaults, so overriding only
   * the sha256 would ALSO leave `reviewInputDigest` disagreeing and both clauses of the
   * cross-check would be wrong at once — either could be deleted and the suite would stay green.
   * Each case below therefore passes the real value through for the field it is not testing.
   */
  it("refuses REVIEW_PACKAGE_STALE when only the acceptance's receipt sha256 disagrees",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      const real = readReviewLedger(store, PROJECT_ID, "node-1").accepted;
      if (real === undefined) throw new Error("the fixture recorded no acceptance");
      stageAcceptance(store, "node-1", {
        reviewInputDigest: real.reviewInputDigest,
        verifierReceiptId: real.verifierReceiptId,
        verifierReceiptSha256: "e".repeat(64),
      });
      const staged = readReviewLedger(store, PROJECT_ID, "node-1").accepted;
      // The precondition that makes exactly one clause reachable.
      expect(staged?.reviewInputDigest).toBe(real.reviewInputDigest);
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
        "the accepted verifier receipt does not match the acceptance");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses REVIEW_PACKAGE_STALE when only the acceptance's review input digest disagrees",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      await seedVerifiedNode(store, "node-1");
      const real = readReviewLedger(store, PROJECT_ID, "node-1").accepted;
      if (real === undefined) throw new Error("the fixture recorded no acceptance");
      stageAcceptance(store, "node-1", {
        reviewInputDigest: "e".repeat(64),
        verifierReceiptId: real.verifierReceiptId,
        verifierReceiptSha256: real.verifierReceiptSha256,
      });
      const staged = readReviewLedger(store, PROJECT_ID, "node-1").accepted;
      expect(staged?.verifierReceiptSha256).toBe(real.verifierReceiptSha256);
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

  /**
   * THREE CLAUSES SHARE THIS MESSAGE — the activation not reading back AT ALL, and its lease and
   * effect identities each disagreeing with the receipt. This case reaches only the first: the
   * blur makes `readsBackAs` null, so the identity comparisons are never evaluated. The two
   * cases after it reach one identity clause each, with `readsBackAs` asserted NON-null.
   */
  it("refuses AUTHORITY_REMAINS when the receipt's own activation does not read back",
    async () => {
      const store = openStore();
      approveNodes(store, ["node-1"]);
      seedReviewAcceptance(store, "node-1");
      const seeded = await seedVerifiedNode(store, "node-1");
      blurActivationHistory(store, seeded.attemptAggregateId);
      const before = snapshot(store);

      const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

      expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
        "a durable activation does not read back as its receipt's lease and effect");
      expectUnmoved(store, before);
    }, 60_000);

  it("refuses AUTHORITY_REMAINS when the activation reads back as a different lease", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const ground = seedProvenAttempt(store, "node-1");
    const template = await seedVerifiedNode(store, "node-src");
    const live = activationIdentities(store, ground.attemptAggregateId);
    // Reads back perfectly, names the right aggregate, carries the right record digest — only
    // the lease the receipt claims is not the lease the activation still holds.
    plantReceipt(store, template.row, "verify-planted-lease", {
      receipt: {
        effectIdentity: live.effectIdentity, graphIdentity: "node-1",
        leaseIdentity: "lease-that-is-not-the-durable-one",
      },
      row: { attemptAggregateId: ground.attemptAggregateId, recordDigest: ground.recordDigest },
    });
    expect(live.leaseIdentity).not.toBe("lease-that-is-not-the-durable-one");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_AUTHORITY_REMAINS",
      "a durable activation does not read back as its receipt's lease and effect");
    expectUnmoved(store, before);
  }, 60_000);

  it("refuses AUTHORITY_REMAINS when the activation reads back as a different effect", async () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    const ground = seedProvenAttempt(store, "node-1");
    const template = await seedVerifiedNode(store, "node-src");
    const live = activationIdentities(store, ground.attemptAggregateId);
    plantReceipt(store, template.row, "verify-planted-effect", {
      receipt: {
        effectIdentity: "intent-that-is-not-the-durable-one", graphIdentity: "node-1",
        leaseIdentity: live.leaseIdentity,
      },
      row: { attemptAggregateId: ground.attemptAggregateId, recordDigest: ground.recordDigest },
    });
    expect(live.effectIdentity).not.toBe("intent-that-is-not-the-durable-one");
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
