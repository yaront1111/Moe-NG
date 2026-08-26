import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  FOUNDATION_VERIFICATION_COMMAND_KIND,
} from "../evidence/foundation-verification-contracts.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_FINALIZATION_CODES, ATTEMPT_FINALIZATION_LAYER, ATTEMPT_FINALIZATION_OUTCOMES,
  FINALIZATION_FORBIDDEN_KEYS, FINALIZATION_REQUEST_KEYS,
} from "./attempt-finalization-contracts.js";
import { finalizeVerifiedAttempt } from "./attempt-finalization-service.js";
import { deriveDispatchAggregateId } from "./foundation-attempt-codec.js";
import {
  ATTEMPT_RELEASE_EVENT_TYPE, deriveAttemptReleaseAggregateId, readAttemptRelease,
  recordAttemptRelease,
} from "./attempt-release-disposition.js";
import {
  FINAL_ACTIVATION_AGGREGATE, FINAL_ATTEMPT_REF, finalizationWorld, seedReceipt,
  seedSealedRecipe, withStoreOverride,
} from "./attempt-finalization-test-harness.js";
import {
  RELEASE_HANDOFF_BINDING_EVENT_TYPE, deriveReleaseHandoffAggregateId,
  readReleaseHandoffBinding,
} from "./release-handoff-binding.js";

/**
 * THE POST-VERIFICATION FINALIZATION PATH (task-48c79a29), over a REAL file-backed
 * SqliteEventStore, a REAL activation committed by the production ingress, and the
 * REAL `releaseWork` kernel.
 *
 * WHAT THIS ROW EXISTS TO PRODUCE, and what no arm here may fake: a RELEASED
 * attempt row and a core `{digest, ref}` handoff binding carrying a NON-NULL,
 * byte-verified receipt, CO-OCCURRING. Either one alone is the state the
 * pre-verification ordering already produced; the co-occurrence is the deliverable.
 *
 * THE ACCEPTED CONTROL TRAVERSES THE REGISTERED PRODUCTION HANDLER —
 * `createStoreDependencies(...).provide()` plus `handleAsyncCommandRequest` — so a
 * finalization unreachable from anything the daemon serves cannot pass it.
 */

const CREDENTIAL = "finalization-operator-credential";
const VERIFICATION_ID = "verification-finalize-1";
const RECIPE_AGGREGATE = "recipe-finalize-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";

const roots: string[] = [];

afterEach(() => {
  cleanupRestoreHarnesses();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const who = Object.freeze({
  commandId: "cmd-finalize", correlationId: "corr-finalize", principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
});

const select = (
  verificationId = VERIFICATION_ID,
): Record<string, unknown> =>
  ({ attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId });

/** RAW rows, counted directly on the two aggregates: a state-only assertion
 *  cannot see a SECOND binding, and a second binding is exactly what "conflicting"
 *  means here. */
function rawCounts(store: SqliteEventStore): { bindings: number; releases: number } {
  const bindings = store
    .readEvents(deriveReleaseHandoffAggregateId(FINAL_ACTIVATION_AGGREGATE))
    .filter((event) => event.eventType === RELEASE_HANDOFF_BINDING_EVENT_TYPE).length;
  const releases = store
    .readEvents(deriveAttemptReleaseAggregateId(FINAL_ACTIVATION_AGGREGATE))
    .filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE).length;
  return { bindings, releases };
}

describe("attempt finalization (task-48c79a29) — the vocabulary is closed", () => {
  it("declares ten codes, four outcomes and one layer of its own", () => {
    expect([...ATTEMPT_FINALIZATION_CODES]).toHaveLength(10);
    expect(new Set(ATTEMPT_FINALIZATION_CODES).size).toBe(10);
    expect([...ATTEMPT_FINALIZATION_OUTCOMES]).toEqual([
      "BINDING_WRITTEN_RELEASE_REFUSED", "DRAINING", "NO_OP", "RELEASED",
    ]);
    expect(ATTEMPT_FINALIZATION_LAYER).toBe("DAEMON_ATTEMPT_FINALIZATION");
    expect([...FINALIZATION_REQUEST_KEYS]).toEqual(["attemptAggregateId", "verificationId"]);
    // Not one authority category shares a key with the allow-list.
    for (const forbidden of FINALIZATION_FORBIDDEN_KEYS) {
      expect(FINALIZATION_REQUEST_KEYS).not.toContain(forbidden);
    }
  });
});

describe("attempt finalization (task-48c79a29) — the caller may select identities only", () => {
  /**
   * SEVEN AUTHORITY CATEGORIES, refused STRUCTURALLY at the allow-list rather than
   * defended downstream, and each asserted to leave ZERO rows. A sweep that
   * generated no cases would pass while testing nothing, so the case count is
   * asserted against the roster's own length.
   */
  it("refuses every release, truth, terminal, receipt, observation, digest and handoff key", () => {
    const { store } = finalizationWorld("payload-authority");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    let swept = 0;
    for (const key of FINALIZATION_FORBIDDEN_KEYS) {
      swept += 1;
      const outcome = finalizeVerifiedAttempt(store, who, { ...select(), [key]: "anything" });
      expect(outcome.ok, key).toBe(false);
      if (outcome.ok) throw new Error(`a ${key} claim was admitted`);
      expect(outcome.code, key).toBe("ATTEMPT_FINALIZATION_REQUEST_MALFORMED");
      expect(outcome.layer, key).toBe(ATTEMPT_FINALIZATION_LAYER);
      // OUR OWN decision, taken before any store read, so nothing upstream is quoted.
      expect(outcome.source, key).toBeNull();
    }
    expect(swept).toBe(FINALIZATION_FORBIDDEN_KEYS.length);
    expect(swept).toBeGreaterThan(0);
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  /** `Object.keys` is blind to a non-enumerable own property; the admission uses
   *  `Reflect.ownKeys`, so a smuggled handoff is refused like a spelled one. */
  it("refuses a non-enumerable smuggled handoff key", () => {
    const { store } = finalizationWorld("payload-smuggled");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const hostile = Object.defineProperty({ ...select() }, "handoff", {
      enumerable: false, value: { truthClass: "DAEMON_VERIFIED" },
    });
    const outcome = finalizeVerifiedAttempt(store, who, hostile);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a smuggled handoff was admitted");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_REQUEST_MALFORMED");
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  it("refuses a null, an array and a missing identity without crashing", () => {
    const { store } = finalizationWorld("payload-total");
    for (const request of [null, undefined, [], "text", {},
      { attemptAggregateId: FINAL_ACTIVATION_AGGREGATE },
      { attemptAggregateId: "", verificationId: VERIFICATION_ID }]) {
      const outcome = finalizeVerifiedAttempt(store, who, request);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("a malformed request was admitted");
      expect(outcome.code).toBe("ATTEMPT_FINALIZATION_REQUEST_MALFORMED");
    }
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });
});

describe("attempt finalization (task-48c79a29) — the receipt gates the ordering", () => {
  /**
   * THE ORDERING ARM. With no durable receipt the path stops BEFORE any release
   * could be attempted, and leaves zero rows on BOTH aggregates. A build that
   * released first would land a row here — permanently, because `commitRelease`
   * pins `expectedVersion: 0` and a DRAINING row can never be upgraded.
   */
  it("writes no release and no binding when no receipt exists yet", () => {
    const { store } = finalizationWorld("no-receipt");
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an unverified attempt was finalized");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED");
    expect(outcome.layer).toBe(ATTEMPT_FINALIZATION_LAYER);
    expect(outcome.source).toEqual({
      code: "FOUNDATION_VERIFICATION_RECEIPT_ABSENT", layer: "DAEMON_VERIFICATION_RECEIPT",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
    const standing = readAttemptRelease(store, FINAL_ACTIVATION_AGGREGATE);
    expect(standing.ok).toBe(false);
    if (standing.ok) throw new Error("a release row was composed with no receipt");
    expect(standing.code).toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
  });

  it("refuses a receipt that names another attempt, under its own FOREIGN code", () => {
    const { store } = finalizationWorld("foreign-receipt");
    seedReceipt(store, {
      attemptAggregateId: "activation-belonging-to-someone-else",
      verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a foreign receipt was accepted");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_RECEIPT_FOREIGN");
    expect(outcome.source).toEqual({
      code: "FOUNDATION_VERIFICATION_RECEIPT_IDENTITY_MISMATCH",
      layer: "DAEMON_VERIFICATION_RECEIPT",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  /**
   * THE PAIRED SHA IS PART OF THE PROOF, NOT DECORATION. A receipt row whose
   * `receiptSha256` is empty byte-verifies perfectly well as a ROW — the reader
   * answers PROVEN_RECEIPT — and yet pins nothing a later drift check could
   * compare against. `verificationId` is adopted as the core receipt reference
   * only once that pair is present, so this row is refused rather than released
   * over.
   */
  it("refuses a byte-verified receipt row that pins no receiptSha256", () => {
    const { store } = finalizationWorld("unsealed-receipt");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, sha256: "",
      verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a receipt pinning no sha was accepted");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED");
    expect(outcome.source).toEqual({
      code: "FOUNDATION_VERIFICATION_RECEIPT_UNSEALED", layer: "DAEMON_VERIFICATION_RECEIPT",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  /** The receipt's bytes are what `readStoredReceipt` re-encodes and compares; a
   *  row whose stored bytes no longer round-trip is UNKNOWN, never a proof. */
  it("refuses a receipt whose durable bytes no longer byte-verify", () => {
    const { store } = finalizationWorld("drifted-receipt");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const hostile = withStoreOverride(store, {
      readEvents: (aggregateId: string): unknown => store.readEvents(aggregateId).map(
        (event) => event.eventType === "FoundationVerificationReceipted"
          ? { ...event, payload: new TextEncoder().encode("{\"receipt\":1}") }
          : event),
    });
    const outcome = finalizeVerifiedAttempt(hostile, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a drifted receipt was accepted");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED");
    expect(outcome.source).toEqual({
      code: "FOUNDATION_VERIFICATION_RECEIPT_UNREADABLE", layer: "DAEMON_VERIFICATION_RECEIPT",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });
});

describe("attempt finalization (task-48c79a29) — the four outcomes are distinct", () => {
  it("RELEASED: a release row and a receipt-bearing binding co-occur", () => {
    const { store } = finalizationWorld("outcome-released");
    const seeded = seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    if (!outcome.ok) throw new Error(`finalization refused: ${outcome.code}`);
    expect(outcome.outcome).toBe("RELEASED");
    expect(outcome.releaseRefusal).toBeNull();

    // THE RELEASE HALF, re-read from durable bytes rather than from the answer.
    const standing = readAttemptRelease(store, FINAL_ACTIVATION_AGGREGATE);
    if (!standing.ok) throw new Error(`release unreadable: ${standing.code}`);
    expect(standing.record["outcome"]).toBe("RELEASED");
    expect(standing.record["attemptState"]).toBe("RELEASED");
    expect(standing.record["reason"]).toBe("WORK_RELEASE_OR_PAUSE");

    // THE BINDING HALF, with a NON-NULL receipt — the fact the pre-verification
    // ordering could never produce.
    const binding = readReleaseHandoffBinding(
      store, { attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, projectId: PROJECT_ID });
    if (!binding.ok) throw new Error(`binding unreadable: ${binding.code}`);
    expect(binding.binding.receipt).not.toBeNull();
    // TWO FIELDS, TWO JOBS: the ref NAMES the verified verification, the sha stays
    // PINNED so a later drift is detectable. Collapsing them removes drift
    // detection while every other assertion here still passes.
    expect(binding.binding.receipt?.verificationId).toBe(VERIFICATION_ID);
    expect(binding.binding.receipt?.receiptSha256).toBe(seeded.receiptSha256);
    expect(binding.binding.receipt?.receiptSha256).not.toBe(binding.binding.receipt?.verificationId);
    expect(outcome.receiptRef).toBe(VERIFICATION_ID);
    expect(outcome.receiptSha256).toBe(seeded.receiptSha256);

    // CORE'S BINDING IS TWO KEYS. The scheduler's is nine; neither is the other.
    expect(Object.keys(binding.binding.handoff).sort()).toEqual(["digest", "ref"]);
    expect(binding.binding.handoff.ref).not.toBe(binding.binding.handoff.digest);
    expect(outcome.observationRef).toMatch(/^[0-9a-f]{64}$/u);
    expect(rawCounts(store)).toEqual({ bindings: 1, releases: 1 });
  });

  /** A FAILED verification still releases — as a cancel, not a resumable pause. */
  it("RELEASED under WORK_CANCEL when the durable verdict is FAILED", () => {
    const { store } = finalizationWorld("outcome-failed-verdict");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verdict: "FAILED",
      verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    if (!outcome.ok) throw new Error(`finalization refused: ${outcome.code}`);
    const standing = readAttemptRelease(store, FINAL_ACTIVATION_AGGREGATE);
    if (!standing.ok) throw new Error(`release unreadable: ${standing.code}`);
    expect(standing.record["reason"]).toBe("WORK_CANCEL");
    expect(standing.record["resumable"]).toBe(false);
  });

  /**
   * AN UNPROVEN ATTEMPT DEFERS, AND IT DEFERS EARLY. With the terminal ledgers
   * unwritten the resource set is still movable, so the server-built nine-key
   * checkpoint refuses BEFORE the release is invoked at all — zero rows on both
   * aggregates, and therefore nothing that a later `resource.reconcile` would be
   * unable to upgrade. That is the whole safety property rail 0 names.
   */
  it("defers with the handoff builder's own code while the resource set is movable", () => {
    const { store } = finalizationWorld("outcome-unobserved", {
      boundaryObserved: false, terminal: false,
    });
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an unproven attempt reached a release");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_HANDOFF_UNRESOLVED");
    expect(outcome.layer).toBe(ATTEMPT_FINALIZATION_LAYER);
    // THE SOURCE IS NOT THIS LAYER. A wrapper that restamped it would lose which
    // authority actually declined.
    expect(outcome.source).not.toBeNull();
    expect(outcome.source?.layer).not.toBe(ATTEMPT_FINALIZATION_LAYER);
    expect(outcome.source?.code).toBe("RELEASE_HANDOFF_SOURCE_STALE");
    // NO NEW RELEASE AUTHORITY ON A REFUSAL PATH — asserted as an absence.
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  it("NO_OP on a replay, without overwriting the first release or doubling the binding", () => {
    const { store } = finalizationWorld("outcome-replay");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const first = finalizeVerifiedAttempt(store, who, select());
    if (!first.ok) throw new Error(`first finalization refused: ${first.code}`);
    expect(first.outcome).toBe("RELEASED");
    const afterFirst = rawCounts(store);

    const second = finalizeVerifiedAttempt(store, who, select());
    if (!second.ok) throw new Error(`replay refused: ${second.code}`);
    expect(second.outcome).toBe("NO_OP");
    // The row the first release wrote stands untouched, and NO second binding was
    // composed: exact raw counts, not a state assertion that cannot see one.
    expect(rawCounts(store)).toEqual(afterFirst);
    expect(rawCounts(store)).toEqual({ bindings: 1, releases: 1 });
    expect(second.release?.["outcome"]).toBe("RELEASED");
    expect(second.receiptRef).toBe(first.receiptRef);
  });

  /**
   * DRAINING, AND IT IS A DIFFERENT ANSWER FROM A REFUSAL. An UNOBSERVED exit
   * cannot carry a terminal effect at all (`recordTerminalEffect` answers
   * EFFECT_TERMINAL_NOT_PROVEN, measured), so this world seeds the RESOURCE half
   * only: the fence passes, the checkpoint composes, and the KERNEL declines to
   * certify the boundary. A row IS written, and it records DRAINING rather than
   * RELEASED.
   */
  it("DRAINING when the host never saw the process cross its boundary", () => {
    const { store } = finalizationWorld("outcome-draining", {
      boundaryObserved: false, terminalEffects: false,
    });
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    if (!outcome.ok) throw new Error(`finalization refused: ${outcome.code}`);
    expect(outcome.outcome).toBe("DRAINING");
    expect(outcome.release?.["outcome"]).toBe("DRAINING");
    expect(outcome.release?.["resumable"]).toBe(false);
    // The four outcomes really are four: this is not RELEASED, not NO_OP, and not
    // the binding-only answer.
    expect(outcome.outcome).not.toBe("RELEASED");
    expect(outcome.releaseRefusal).toBeNull();
    expect(rawCounts(store)).toEqual({ bindings: 1, releases: 1 });
  });

  /**
   * A CONFLICTING RETRY. A second verification receipt naming the SAME attempt
   * makes "which receipt does this attempt's binding pin" unanswerable, and the
   * scan refuses AMBIGUOUS rather than choosing. Absent and ambiguous demand
   * opposite repairs, so they never share a code.
   */
  it("refuses a conflicting retry when two receipts name the same attempt", () => {
    const { store } = finalizationWorld("outcome-conflicting");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, sha256: "9".repeat(64),
      verificationId: "verification-finalize-2",
    });
    const outcome = finalizeVerifiedAttempt(store, who, select("verification-finalize-2"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a conflicting retry was finalized");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_RELEASE_REFUSED");
    expect(outcome.source).toEqual({
      code: "RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS", layer: "DAEMON_RELEASE_HANDOFF",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  /**
   * THE REAL PRODUCTION SEQUENCE, and the one the whole row exists to repair.
   *
   * The live dispatch path releases SYNCHRONOUSLY, before any receipt exists, so
   * it leaves a RELEASED row beside a binding whose `receipt` is NULL — a release
   * nothing verified. Finalizing afterwards must then REBIND rather than
   * re-release: the standing release row is untouched (NO_OP), and a SECOND
   * binding is appended carrying the receipt, which `readReleaseHandoffBinding`
   * answers as the CURRENT one. Append-only throughout; the first release is
   * never overwritten and history is never rewritten.
   *
   * This arm also pins the boundary ordering. The first release observed the safe
   * boundary under ITS OWN decision key, and `recordSafeBoundaryObservation` pins
   * `expectedVersion: 0` on a ref-derived aggregate — so a finalization that asked
   * the producer unconditionally would be refused SAFE_BOUNDARY_COMMIT_CONFLICT
   * on exactly this sequence. The lookup runs first for that reason.
   */
  it("rebinds a pre-receipt release: NO_OP, first row untouched, current binding receipted", () => {
    const world = finalizationWorld("outcome-rebind");
    const { store } = world;
    // The pre-verification release, through the SAME production writer the live
    // dispatch path uses, with no receipt anywhere in the store.
    const early = recordAttemptRelease(store, world.bound, world.record, {
      disposition: null, intentRefs: [world.record.effectIntent.intentId],
      reason: "WORK_RELEASE_OR_PAUSE",
    });
    if (!early.ok) throw new Error(`pre-receipt release refused: ${early.code}`);
    expect(early.outcome).toBe("RELEASED");
    const before = readReleaseHandoffBinding(
      store, { attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, projectId: PROJECT_ID });
    if (!before.ok) throw new Error(`no binding after the early release: ${before.code}`);
    // THE DEFECT THIS ROW REPAIRS, measured on the delivered tree: verified nothing.
    expect(before.binding.receipt).toBeNull();
    expect(rawCounts(store)).toEqual({ bindings: 1, releases: 1 });

    const seeded = seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    if (!outcome.ok) throw new Error(`finalization refused: ${outcome.code}`);
    expect(outcome.outcome).toBe("NO_OP");

    // THE FIRST RELEASE ROW STANDS, byte for byte the same single row.
    expect(rawCounts(store)).toEqual({ bindings: 2, releases: 1 });
    const standing = readAttemptRelease(store, FINAL_ACTIVATION_AGGREGATE);
    if (!standing.ok) throw new Error(`release unreadable: ${standing.code}`);
    expect(standing.record["outcome"]).toBe("RELEASED");
    expect(standing.digest).toBe(early.digest);

    // AND THE CURRENT BINDING NOW CARRIES THE VERIFIED RECEIPT.
    const after = readReleaseHandoffBinding(
      store, { attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, projectId: PROJECT_ID });
    if (!after.ok) throw new Error(`binding unreadable: ${after.code}`);
    expect(after.binding.receipt?.verificationId).toBe(VERIFICATION_ID);
    expect(after.binding.receipt?.receiptSha256).toBe(seeded.receiptSha256);
    expect(after.binding.handoff).toEqual(before.binding.handoff);
    expect(outcome.receiptRef).toBe(VERIFICATION_ID);

    // A SECOND finalization adds nothing: the re-derived bytes are identical, so
    // `recordReleaseHandoffBinding` answers from the row already standing.
    const replay = finalizeVerifiedAttempt(store, who, select());
    expect(replay.ok && replay.outcome).toBe("NO_OP");
    expect(rawCounts(store)).toEqual({ bindings: 2, releases: 1 });
  });

  /**
   * THE FOURTH OUTCOME, and the one this row exists to name. The core binding is
   * composed BEFORE the kernel is asked, so a release the kernel declines leaves
   * an inert binding standing with no release beside it. Here the journal exists
   * (so a binding is composable) while the lease has already been drained by the
   * first finalization — the kernel refuses, and the standing binding must be
   * REPORTED rather than folded into a generic refusal.
   */
  it("BINDING_WRITTEN_RELEASE_REFUSED is reported as itself, not as a refusal", () => {
    const { store } = finalizationWorld("outcome-binding-only");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    // A binding without a release: the release aggregate is made unwritable by a
    // store that refuses only THAT commit, so the binding lands and the kernel's
    // decision cannot be recorded.
    const releaseAggregate = deriveAttemptReleaseAggregateId(FINAL_ACTIVATION_AGGREGATE);
    const hostile = withStoreOverride(store, {
      commitExpectedVersionDecision: (input: { targetAggregateId: string }): unknown => {
        if (input.targetAggregateId === releaseAggregate) throw new Error("RELEASE_DENIED");
        return (store.commitExpectedVersionDecision as unknown as (i: unknown) => unknown)(input);
      },
    });
    const outcome = finalizeVerifiedAttempt(hostile, who, select());
    if (!outcome.ok) throw new Error(`expected the fourth outcome, got ${outcome.code}`);
    expect(outcome.outcome).toBe("BINDING_WRITTEN_RELEASE_REFUSED");
    expect(outcome.release).toBeNull();
    expect(outcome.binding).not.toBeNull();
    expect(outcome.binding?.receipt?.verificationId).toBe(VERIFICATION_ID);
    expect(outcome.releaseRefusal).toEqual({
      code: "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", layer: "DAEMON_ATTEMPT_RELEASE",
    });
    // A binding is a FACT, never authority: no release row exists beside it.
    expect(rawCounts(store)).toEqual({ bindings: 1, releases: 0 });
  });
});

describe("attempt finalization (task-48c79a29) — the strict re-reads", () => {
  it("refuses under the journal's own layer when the attempt journalled nothing", () => {
    const { store } = finalizationWorld("no-journal", { journal: false });
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an unjournalled attempt was finalized");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_JOURNAL_UNRESOLVED");
    expect(outcome.source).toEqual({
      code: "JOURNAL_RECORD_ABSENT", layer: "DAEMON_JOURNAL_APPEND",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  it("refuses under the boundary lookup's layer when the host recorded no run", () => {
    const { store } = finalizationWorld("no-run", { providerRun: false, terminal: false });
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an unobserved attempt was finalized");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_BOUNDARY_UNRESOLVED");
    // THE PRODUCER'S OWN CODE AND LAYER, carried verbatim: "the host recorded no
    // run" and "finalization declined" are different facts.
    expect(outcome.source).toEqual({
      code: "SAFE_BOUNDARY_RUN_UNREADABLE", layer: "DAEMON_SAFE_BOUNDARY_OBSERVATION",
    });
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });

  it("refuses an attempt whose durable record was never written", () => {
    const { store } = finalizationWorld("foreign-attempt", { attemptRecord: false });
    seedReceipt(store, {
      attemptAggregateId: "activation-never-committed", verificationId: VERIFICATION_ID,
    });
    const outcome = finalizeVerifiedAttempt(store, who, {
      attemptAggregateId: "activation-never-committed", verificationId: VERIFICATION_ID,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an absent attempt was finalized");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE");
    expect(outcome.source).toEqual({
      code: "FOUNDATION_ATTEMPT_RECORD_ABSENT", layer: "DAEMON_FOUNDATION_ATTEMPT",
    });
  });

  /** ONE HORIZON: a write onto the attempt's OWN activation aggregate between the
   *  capture and the re-check invalidates every source that was just read. */
  it("refuses HORIZON_MOVED when the attempt's own aggregate moves mid-read", () => {
    const { store } = finalizationWorld("horizon");
    seedReceipt(store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, verificationId: VERIFICATION_ID,
    });
    // ARMED BY THE SOURCE RE-READS THEMSELVES: the safe-boundary lookup is the
    // only caller of `readEventsByTypeAfter` on this path, so the injected row
    // appears strictly BETWEEN the horizon capture and the re-check — which is
    // exactly the window the guard exists for. Arming on a raw call count would
    // couple the arm to how many reads the implementation happens to make.
    let armed = false;
    const dispatchAggregate = deriveDispatchAggregateId(FINAL_ACTIVATION_AGGREGATE);
    const hostile = withStoreOverride(store, {
      readEventsByTypeAfter: (...args: never[]): unknown => {
        armed = true;
        return (store.readEventsByTypeAfter as unknown as (...a: never[]) => unknown)(...args);
      },
      // The injected row lands on the attempt's DISPATCH aggregate, which nothing
      // inside the source re-reads consults — so the arm measures the guard and
      // not some source's reaction to a duplicated activation event.
      readEvents: (aggregateId: string): unknown => {
        const events = store.readEvents(aggregateId);
        return armed && aggregateId === dispatchAggregate
          ? [...events, ...events.slice(0, 1)] : events;
      },
    });
    const outcome = finalizeVerifiedAttempt(hostile, who, select());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("a moved horizon was finalized over");
    expect(outcome.code).toBe("ATTEMPT_FINALIZATION_HORIZON_MOVED");
    expect(outcome.layer).toBe(ATTEMPT_FINALIZATION_LAYER);
    // The injection really fired: an unarmed run would refuse for another reason
    // and this arm would pass while measuring nothing.
    expect(armed).toBe(true);
    expect(rawCounts(store)).toEqual({ bindings: 0, releases: 0 });
  });
});

/**
 * THE PRODUCTION-HANDLER ACCEPTED CONTROL. The registered `foundation.verification`
 * entry, reached through `handleAsyncCommandRequest` over the SHIPPED
 * `createStoreDependencies` composition and an authenticated WORK principal.
 * Nothing here builds a handler by hand, so a finalization that is not wired into
 * anything the daemon serves cannot pass.
 */
describe("attempt finalization (task-48c79a29) — reached from the registered handler", () => {
  it("leaves a RELEASED row and a receipt-bearing binding after a served verification", async () => {
    // A candidate root the receipt can name; the store itself lives in the
    // harness's own tracked root.
    const directory = mkdtempSync(join(tmpdir(), "moe-finalize-served-"));
    roots.push(directory);

    // The world, built with the harness's own store handle, then CLOSED before the
    // shipped provider reopens the same file — Windows will not share the lock.
    const world = finalizationWorld("served");
    const recordDigest = world.recordDigest;
    const recipeSha256 = seedSealedRecipe(world.store, RECIPE_AGGREGATE);
    seedReceipt(world.store, {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, candidateRoot: directory,
      recipeAggregateId: RECIPE_AGGREGATE, recipeSha256, recordDigest,
      verificationId: VERIFICATION_ID,
    });
    installTestRecoveryBinding(world.store);
    const seededPath = world.storePath;
    world.store.close();

    const provider = createStoreDependencies({
      clock: (): string => DECIDED_AT, credential: CREDENTIAL, principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID, storePath: seededPath,
    });
    const deps = provider.provide();
    const entry = deps.registry.get(FOUNDATION_VERIFICATION_COMMAND_KIND);
    expect(entry?.asyncHandler).toBeDefined();

    const envelope: RuntimeCommandEnvelope = {
      commandId: "cmd-served-finalize", commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND,
      correlationId: "corr-served-finalize", expectedVersion: 0,
      payload: {
        attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, candidateRoot: directory,
        expectedRecordDigest: recordDigest, recipeAggregateId: RECIPE_AGGREGATE,
        verificationId: VERIFICATION_ID,
      } as RuntimeCommandEnvelope["payload"],
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL, targetAggregateId: FINAL_ACTIVATION_AGGREGATE,
    };
    let answered: Awaited<ReturnType<typeof handleAsyncCommandRequest>>;
    try {
      answered = await handleAsyncCommandRequest(deps, {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
      });
    } finally {
      provider.close();
    }
    // The SERVED answer, not a thrown one: the verification replayed its durable
    // receipt and the finalization tail ran behind it.
    expect(answered).toMatchObject({ httpStatus: 200, ok: true });

    // RE-READ FROM A FRESH HANDLE, closed again before the suite ends.
    const reader = SqliteEventStore.openForProject(seededPath, PROJECT_ID);
    try {
      const standing = readAttemptRelease(reader, FINAL_ACTIVATION_AGGREGATE);
      if (!standing.ok) throw new Error(`no release after a served verification: ${standing.code}`);
      expect(standing.record["outcome"]).toBe("RELEASED");
      expect(standing.record["attemptRef"]).toBe(FINAL_ATTEMPT_REF);
      const binding = readReleaseHandoffBinding(
        reader, { attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, projectId: PROJECT_ID });
      if (!binding.ok) throw new Error(`no binding after a served verification: ${binding.code}`);
      expect(binding.binding.receipt?.verificationId).toBe(VERIFICATION_ID);
      expect(binding.binding.receipt?.receiptSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(rawCounts(reader)).toEqual({ bindings: 1, releases: 1 });
    } finally {
      reader.close();
    }
  });
});
