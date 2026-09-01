import { EVIDENCE_RECEIPT_VERSION } from "@moe/runner";
import type { EvidenceReceipt, VerifierCapture } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  decisionCount,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND,
  FOUNDATION_VERIFICATION_EVENT_TYPES,
  verificationReceiptBody,
} from "../evidence/foundation-verification-contracts.js";
import { deriveVerificationAggregateId } from "../evidence/foundation-verification-service.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import { encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "../work/foundation-attempt-store.js";
import {
  approveNodes,
  scanGlobalEvents,
  seedReviewAcceptance,
} from "./goal-closure-test-fixtures.js";
import { qualifyGoalClosure } from "./goal-qualification.js";

/**
 * The daemon prerequisite composer for `goal.close`, read straight out of durable bytes on a
 * store PRODUCTION CAN ACTUALLY REACH.
 *
 * WHAT CHANGED AND WHY. Every arm here used to start from `seedVerifiedNode`, which drove
 * `runEffectActivateCommand`, a real launcher grant and a real verifier child process. Production
 * cannot commit an activation from a test world any more — the ingress refuses — so those arms
 * were asserting against a state nothing can build, and the whole file died in setup. Governor
 * ruling comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 is applied: the world is not rebuilt
 * below the admission path, the SUBJECT is narrowed to what this store can honestly hold. What
 * survives is the RECEIPT READER — approval and review are seeded through production, and every
 * receipt row below is a hostile or negative READER INPUT.
 *
 * A PLANTED ROW IS NEVER EVIDENCE THAT A WRITER SUCCEEDED. Nothing below claims a Foundation
 * attempt was proven, a verification ran, or an activation was committed; the arms assert what
 * `qualifyGoalClosure` returns when it is handed those bytes. The retired positive arms
 * (successful witness derivation, the review-package and zero-authority halves) needed a real
 * PASSED receipt over a real proven attempt and have no owner until production can mint one.
 *
 * `qualifyGoalClosure` is a pure read: it commits nothing, ever. Each arm therefore snapshots the
 * store after seeding and re-reads it afterwards, because a composer that mutated and then
 * refused would sail through a return-value-only assertion.
 */

const PRINCIPAL_ID = "principal-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);
const DIGEST_C = "3".repeat(64);
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

const stream = Object.freeze({
  byteLength: 2, bytes: new Uint8Array([0x6f, 0x6b]), sha256: DIGEST_A, truncated: false,
});

/** The capture shape the production body builder consumes; only its digests reach the row. */
const CAPTURE: VerifierCapture = Object.freeze({
  completedAt: "2026-08-15T00:00:02.000Z", durationMs: 1_000, exitCode: 0, signal: null,
  startedAt: "2026-08-15T00:00:01.000Z", stderr: stream, stdout: stream,
});

/**
 * The runner's receipt, restated as a literal. Built by hand rather than by `buildEvidenceReceipt`
 * because that builder demands the manifests and execution of a real run — the very thing this
 * store cannot hold. Typing it as `EvidenceReceipt` is what keeps it honest: a bound field added
 * to the production receipt reddens this literal at typecheck instead of drifting silently.
 */
function evidenceReceipt(graphIdentity: string): EvidenceReceipt {
  return Object.freeze({
    argv: ["node", "-e", "process.exit(0)"],
    effectIdentity: `intent-${graphIdentity}`,
    graphIdentity,
    inputTreeSha256: DIGEST_A,
    leaseIdentity: `lease-${graphIdentity}`,
    obligations: [],
    outputs: [],
    receiptVersion: EVIDENCE_RECEIPT_VERSION,
    recipeSha256: DIGEST_B,
    resultTreeSha256: DIGEST_C,
    runtimeObservationSha256: DIGEST_B,
    sha256: DIGEST_C,
    timestamps: { completedAt: CAPTURE.completedAt, startedAt: CAPTURE.startedAt },
  });
}

interface PlantedReceipt {
  readonly attemptAggregateId?: string;
  readonly graphIdentity: string;
  readonly verdict: "FAILED" | "PASSED";
  readonly verificationId: string;
}

/**
 * A durable RECEIPTED row in exactly the FIELD SET the production writer emits — the body comes
 * from `verificationReceiptBody`, the same function `foundation-verification-service.ts` calls, so
 * a row here cannot be a shape the reader would never meet.
 */
function receiptRow(parts: PlantedReceipt): Record<string, unknown> {
  return verificationReceiptBody({
    attemptAggregateId: parts.attemptAggregateId ?? `attempt-of-${parts.graphIdentity}`,
    candidateRoot: "fixture-candidate-root",
    capture: CAPTURE,
    receipt: evidenceReceipt(parts.graphIdentity),
    recipeAggregateId: `recipe-${parts.verificationId}`,
    recordDigest: DIGEST_A,
    verdict: parts.verdict,
    verificationId: parts.verificationId,
  });
}

/**
 * Commits arbitrary bytes as a RECEIPTED row.
 *
 * `targetAggregateId` defaults to the aggregate the row's own verification id derives, which is
 * where an honest writer would put it; a caller overrides it only to build the decoy arm, whose
 * whole subject is a row sitting somewhere its own bytes do not point.
 */
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
    // KEYED ON THE AGGREGATE, not on the verification id: the decoy arm deliberately commits a
    // DIFFERENT body under the same verification id, and a shared command id would be refused
    // IDEMPOTENCY_CONFLICT by the store before the reader ever saw the row.
    key: {
      commandId: `cmd-raw-${aggregateId}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: payload, targetAggregateId: aggregateId,
  });
  expect(written.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** Canonical bytes: the codec's own encoding, so `readStoredReceipt`'s byte compare accepts the
 *  row and the refusal under test is the only one that can answer. */
function plant(
  store: SqliteEventStore, parts: PlantedReceipt, targetAggregateId?: string,
): void {
  const encoded = encodeFoundationPayload(receiptRow(parts));
  if (!encoded.ok) throw new Error(`the planted receipt could not be encoded: ${encoded.code}`);
  commitRawReceipt(store, parts.verificationId, encoded.bytes, targetAggregateId);
}

function expectRefusedExactly(
  outcome: ReturnType<typeof qualifyGoalClosure>, code: string, message: string,
): void {
  expect(outcome).toMatchObject({ code, layer: "DAEMON_PREREQUISITE", message, ok: false });
}

/** The approved, reviewed world every arm shares: real approval, real review acceptance, and no
 *  committed activation anywhere — which is the only world production can currently reach. */
function approvedWorld(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  approveNodes(store, [...nodeRefs]);
  for (const nodeRef of nodeRefs) seedReviewAcceptance(store, nodeRef);
}

afterEach(closeStores);

describe("goal closure qualification — the reachable receipt reader", () => {
  it("holds no committed activation anywhere in the store, measured store-wide", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    plant(store, { graphIdentity: "node-1", verdict: "PASSED", verificationId: "verify-scan" });

    const scan = scanGlobalEvents(store);

    // The POSITIVE CONTROL: this world really was built, so a zero activation count is a
    // measurement rather than an empty store answering for one.
    expect(scan.total).toBeGreaterThan(0);
    expect(scan.exhausted).toBe(true);
    expect(scan.activationRows).toBe(0);
    // And the reachable answer on that world is the receipt-chain refusal, never a close.
    expectRefusedExactly(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID),
      "GOAL_CLOSE_RESULT_DIGEST_MISMATCH",
      "the verified result no longer reads back as the record its receipt names");
  });

  it("refuses RECEIPT_ABSENT for an approved node no verification receipt names", () => {
    const store = openStore();
    // Both nodes are fully reviewed and accepted, so the review guard cannot answer for either.
    approvedWorld(store, ["node-1", "node-2"]);
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
      "no durable verification receipt names this approved node");
    expectUnmoved(store, before);
  });

  /**
   * TWO GUARDS RAISE THIS CODE — two rows on one aggregate (`readStoredReceipt`'s own AMBIGUOUS)
   * and two rows naming one node — so the exact message is what says which one answered. This arm
   * is the second: two SEPARATE aggregates, each holding one canonical row for `node-1`.
   */
  it("refuses RECEIPT_AMBIGUOUS when two durable receipts name the same node", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    plant(store, { graphIdentity: "node-1", verdict: "PASSED", verificationId: "verify-first" });
    plant(store, { graphIdentity: "node-1", verdict: "PASSED", verificationId: "verify-second" });
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS",
      "two durable receipts name one node");
    expectUnmoved(store, before);
  });

  /**
   * THE SCANNED BYTES ARE NEVER THE ANSWER — the module's headline claim, made falsifiable.
   *
   * A decoy row is committed to its OWN aggregate while naming another verification's id, so the
   * scanned bytes claim `node-1` and the row those bytes point at is the out-of-scope `node-src`
   * one. Reading the SCANNED value would admit a receipt for a node nothing verified; reading the
   * STORED row skips it and leaves `node-1` with no evidence at all.
   */
  it("indexes the stored row a receipt points at, never the bytes that pointed at it", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    plant(store, { graphIdentity: "node-src", verdict: "PASSED", verificationId: "verify-src" });
    const decoy = encodeFoundationPayload(
      receiptRow({ graphIdentity: "node-1", verdict: "PASSED", verificationId: "verify-src" }));
    expect(decoy.ok).toBe(true);
    if (!decoy.ok) return;
    commitRawReceipt(store, "verify-src", decoy.bytes,
      deriveVerificationAggregateId("verify-decoy-aggregate"));
    // The precondition that makes ABSENT the only reachable answer: the id the decoy names DOES
    // read back, and the row it reads back as is out of scope.
    const pointedAt = readStoredReceipt(store, "verify-src");
    expect(pointedAt.ok).toBe(true);
    if (!pointedAt.ok) return;
    expect((pointedAt.row["receipt"] as Record<string, unknown>)["graphIdentity"])
      .toBe("node-src");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
      "no durable verification receipt names this approved node");
    expectUnmoved(store, before);
  });

  it("refuses RECEIPT_UNREADABLE when a durable receipt's bytes are not canonical", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    // The SAME row re-serialised non-canonically under its own verification id. It decodes to a
    // deep-equal row, so only the byte compare inside `readStoredReceipt` can catch it — an index
    // that trusted the scanned bytes would hand this back as evidence.
    const drifted = encoder.encode(JSON.stringify(
      receiptRow({ graphIdentity: "node-1", verdict: "PASSED", verificationId: "verify-drifted" }),
      null, 1));
    commitRawReceipt(store, "verify-drifted", drifted);
    // WHICH LAYER REFUSED, pinned upstream: the verification store rejects these bytes under its
    // own code, so this arm cannot be answered by an absent aggregate wearing the same message.
    const stored = readStoredReceipt(store, "verify-drifted");
    expect(stored.ok).toBe(false);
    if (stored.ok) return;
    expect(stored.code).toBe("FOUNDATION_VERIFICATION_RECEIPT_UNREADABLE");
    expect(stored.layer).toBe("DAEMON_VERIFICATION_RECEIPT");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE",
      "a durable receipt does not read back from its own aggregate");
    expectUnmoved(store, before);
  });

  it("refuses NOT_PASSED for a durable receipt read back with verdict FAILED", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    plant(store, { graphIdentity: "node-1", verdict: "FAILED", verificationId: "verify-failed" });
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    // The verdict guard sits ABOVE `verifiedResultHolds`, so this refuses on the verdict even
    // though the attempt record this row names does not exist either.
    expectRefusedExactly(outcome, "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      "the durable verification receipt did not pass");
    expectUnmoved(store, before);
  });

  it("refuses RESULT_DIGEST_MISMATCH when the verified result does not read back at all", () => {
    const store = openStore();
    approvedWorld(store, ["node-1"]);
    plant(store, {
      attemptAggregateId: "attempt-nothing-recorded", graphIdentity: "node-1",
      verdict: "PASSED", verificationId: "verify-passed",
    });
    // The precondition that makes this the ok-clause case and not the digest one: the attempt
    // record named by the receipt is ABSENT, under the attempt store's own code.
    const stored = readFoundationAttemptRecord(store, "attempt-nothing-recorded");
    expect(stored.ok).toBe(false);
    if (stored.ok) return;
    expect(stored.code).toBe("FOUNDATION_ATTEMPT_RECORD_ABSENT");
    const before = snapshot(store);

    const outcome = qualifyGoalClosure(store, PROJECT_ID, GOAL_ID);

    expectRefusedExactly(outcome, "GOAL_CLOSE_RESULT_DIGEST_MISMATCH",
      "the verified result no longer reads back as the record its receipt names");
    expectUnmoved(store, before);
  });
});
