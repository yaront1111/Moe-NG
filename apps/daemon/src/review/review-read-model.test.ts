import { afterEach, expect, it } from "vitest";

import { readReviewLedger, readReviewLedgers } from "./review-read-model.js";
import type { ReviewOutcome } from "./review-ledger.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  commitRaw,
  decisionRows,
  envelope,
  hex64,
  openStore,
  packageItems,
  send,
  submitPayload,
  tamperedRoundResult,
} from "./review-test-fixtures.js";
import {
  REPOSITORY_LANDING_INTENT_KIND, landingIntentKey,
} from "../repository/repository-landing-intent.js";
import { RECOVERY_FACT_PRINCIPAL } from "../repository/repository-recovery-facts.js";
import { recoveryEvidenceFixture } from "../repository/repository-recovery-test-fixtures.js";
import type { SqliteEventStore } from "@moe/store";

/**
 * The stored-shape half of the review read model, driven through the production
 * `readReviewLedger` rather than by calling the unexported `parseRound` directly.
 *
 * The package items a round was raised against are durable state now, so this suite exists to pin
 * the three answers a reader can get and to keep them DISTINGUISHABLE: present, explicitly absent,
 * and unreadable. Collapsing the middle one into an empty array is the defect this file is for —
 * a caller handed `[]` sees a well-formed package binding zero evidence and cannot tell it from a
 * real one, which is exactly how absent evidence gains authority.
 *
 * Rounds are staged with `commitRaw` deliberately: no handler will ever write a malformed or a
 * pre-change round, so bytes have to be put there directly for the read path to be asked the
 * question at all. The staged lineage's digest does not attest it, which is irrelevant here — this
 * module validates SHAPE and decides nothing; `@moe/review` re-checks the attestation when the
 * next round is recorded.
 */

/**
 * The seven items this suite stages, written out rather than derived from the fixture. Deriving
 * them would put one array on both sides of the comparison, and an eighth item appended to the
 * fixture would then appear on both sides and stay green.
 */
const STORED_ITEMS = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
] as const;

/**
 * Every way a stored `packageItems` key can be present and untrustworthy. A partially trusted
 * item set is worse than none: its digest would be recomputed over bytes nobody validated.
 */
const MALFORMED_CASES: readonly (readonly [string, unknown])[] = [
  ["an object rather than an array", { kind: "CRITERION" }],
  ["a bare string rather than an array", "packageItems"],
  ["an element that is not an object", ["CRITERION"]],
  ["an element missing its digest", [{ kind: "CRITERION", locator: "criterion-1" }]],
  ["an element missing its locator", [{ digest: hex64("c1"), kind: "CRITERION" }]],
  ["a digest that is not hex", [{ digest: "z".repeat(64), kind: "CRITERION", locator: "c-1" }]],
  ["a digest of the wrong length", [
    { digest: hex64("c1").slice(0, 63), kind: "CRITERION", locator: "c-1" },
  ]],
  ["a locator that is not a string", [{ digest: hex64("c1"), kind: "CRITERION", locator: 1 }]],
  ["a kind outside the frozen allow-list", [
    { digest: hex64("c1"), kind: "CRITERIA", locator: "c-1" },
  ]],
  ["a kind the package forbids", [
    { digest: hex64("c1"), kind: "WORKER_TRANSCRIPT", locator: "transcript-1" },
  ]],
  ["an element carrying an extra key", [
    { digest: hex64("c1"), kind: "CRITERION", locator: "c-1", trusted: true },
  ]],
];

afterEach(closeStores);

/** A shape-valid stored round, with whatever items key the case under test needs. */
function stageRound(store: SqliteEventStore, extra: Record<string, unknown> = {}): void {
  const staged = commitRaw(
    store,
    envelope("review.submit", 0, submitPayload(1), "cmd-staged-round"),
    { ...tamperedRoundResult(), ...extra },
  );
  if (!staged.ok) throw new Error(`staging failed: ${staged.code}`);
}

/** Drives a real command so the refusing LAYER and CODE are the production surface's, not ours. */
function submitAgainst(store: SqliteEventStore): ReviewOutcome {
  return send(store, envelope("review.submit", 1, submitPayload(2), "cmd-after-staged"));
}

it("hands back the exact package items a stored round carries, item by item", () => {
  const store = openStore();
  const submitted = packageItems();
  stageRound(store, { packageItems: submitted });

  const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];

  expect(round?.packageItems).toEqual({ items: STORED_ITEMS, status: "PRESENT" });
  // Bound to what actually went into the bytes, so a drifted fixture cannot leave the literal
  // above asserting a set nothing stores. One operand crossed the durable boundary.
  expect(round?.packageItems).toEqual({ items: submitted, status: "PRESENT" });
  expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).unreadable).toBe(false);
});

it("marks a round stored before this change ABSENT, never as an empty package", () => {
  const store = openStore();
  stageRound(store);

  const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
  const round = ledger.rounds[0];

  expect(round?.packageItems).toEqual({ status: "ABSENT" });
  // The three shapes absent evidence disguises itself as. None may compare equal to the marker.
  expect(round?.packageItems).not.toEqual([]);
  expect(round?.packageItems).not.toEqual({ items: [], status: "PRESENT" });
  expect(round?.packageItems).not.toEqual({ items: [], status: "ABSENT" });
  // An old round is READABLE. Refusing it here would strand every round recorded before today.
  expect(ledger.unreadable).toBe(false);
  expect(round?.round).toBe(1);
});

it("reads a round with a malformed items key as unreadable rather than partly trusted", () => {
  // A sweep that generated nothing would satisfy every assertion below while testing nothing.
  expect(MALFORMED_CASES.length).toBeGreaterThan(0);
  expect(MALFORMED_CASES.length).toBe(11);

  for (const [label, value] of MALFORMED_CASES) {
    const store = openStore();
    stageRound(store, { packageItems: value });

    const ledger = readReviewLedger(store, PROJECT_ID, SUBJECT_REF);
    expect(ledger.unreadable, label).toBe(true);
    expect(ledger.rounds, label).toEqual([]);

    const outcome = submitAgainst(store);
    expect(outcome.ok, label).toBe(false);
    expect(outcome.ok ? null : outcome.code, label).toBe("REVIEW_LINEAGE_UNREADABLE");
    expect(outcome.ok ? null : outcome.refusedBy, label).toBe("DAEMON_PREREQUISITE");
  }
});

/**
 * THE JOURNALED LANDING INTENT the same walk now collects.
 *
 * A landing receipt carrying `NOTHING_TO_COMMIT` is ambiguous by code alone: a node that
 * legitimately produced no change and a retry whose already-journaled work was reverted commit
 * the SAME code, so crediting on the code credits lost work as landed. The discriminator is
 * whether an intent was journaled for that acceptance, which is what `landingIntents` answers.
 *
 * Intents here are written by the PRODUCTION writer (`recordRepositoryLandingIntent`, reached
 * through `recoveryEvidenceFixture`'s real LANDING-phase handle and real verifier receipt), so
 * the bytes the reader decodes are the bytes production commits. Only the undecodable case is
 * planted, because no writer will ever produce one — that is precisely why the branch needs a
 * boundary rather than a claim that it cannot happen.
 */
function seedUndecodableIntent(store: SqliteEventStore, commandId: string): void {
  // Shaped exactly like a real recovery fact (`writeRecoveryFact`): same principal, same event
  // type, same aggregate family. Only the BODY is junk — well-formed JSON that is not an intent,
  // so the decision reaches `decodeRepositoryLandingIntent` and is refused THERE rather than
  // being thrown out earlier by the bounded JSON decoder.
  const bytes = new TextEncoder().encode(JSON.stringify({ version: "not-an-intent" }));
  const targetAggregateId = "repository-landing:planted";
  const response = store.commitExpectedVersionDecision({
    commandKind: REPOSITORY_LANDING_INTENT_KIND,
    committedResultBytes: bytes,
    correlationId: commandId,
    decidedAt: "2026-09-10T00:00:03.000Z",
    events: [{
      eventId: `${commandId}-recorded`,
      eventType: "RepositoryRecoveryEvidenceRecorded",
      payload: bytes,
    }],
    expectedVersion: store.getAggregateVersion(targetAggregateId),
    key: { commandId, principalId: RECOVERY_FACT_PRINCIPAL, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`intent seed failed: ${response.decision.effectDisposition}`);
  }
}

/** Counts the pages a reader asks the store for: one walk of a sub-page ledger is exactly one. */
function countingStore(store: SqliteEventStore): {
  readonly pages: () => number;
  readonly store: SqliteEventStore;
} {
  let pages = 0;
  const proxy = new Proxy(store, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "readCommandDecisionsAfter" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]): unknown => {
        pages += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { pages: (): number => pages, store: proxy };
}

it("collects a production-written landing intent under its exact (receipt, node) key", () => {
  const fixture = recoveryEvidenceFixture();
  const receiptId = fixture.verified.receipt.receiptId;
  fixture.completed(false);

  const { landingIntents } = readReviewLedgers(fixture.store, PROJECT_ID, new Set([SUBJECT_REF]));

  // KEY CONTENT, not set size: a size assertion is satisfied by entirely the wrong key. The
  // expected key is built from the fixture's own inputs, so the only operand that crossed the
  // durable boundary is the reader's.
  expect(landingIntents).toEqual(new Set([landingIntentKey(SUBJECT_REF, receiptId)]));
  // Spelled out once, independently of the helper, so a helper that lost the node half of the
  // pair could not agree with itself on both sides of the assertion above.
  expect([...landingIntents ?? []]).toEqual([`${receiptId}:${SUBJECT_REF}`]);
});

it("does not match an intent's key for a different receipt, or a different node", () => {
  const fixture = recoveryEvidenceFixture();
  const receiptId = fixture.verified.receipt.receiptId;
  fixture.completed(false);

  const intents = readReviewLedgers(fixture.store, PROJECT_ID, new Set([SUBJECT_REF]))
    .landingIntents;

  // The pair is EXACT in both coordinates. A parent crediting a landing asks about ONE
  // acceptance; an intent journaled for a different verification is not evidence for it.
  expect(intents?.has(landingIntentKey(SUBJECT_REF, receiptId))).toBe(true);
  expect(intents?.has(landingIntentKey(SUBJECT_REF, hex64("9f")))).toBe(false);
  expect(intents?.has(landingIntentKey("node-somewhere-else", receiptId))).toBe(false);
});

it("keys the pair so a nodeRef full of separators can never impersonate another pair", () => {
  // `ref()` lets a nodeRef hold colons; `hex()` does not. Putting the FIXED-WIDTH receipt id
  // first is what makes the key decodable — the split is always at index 64, whatever follows.
  const receiptId = hex64("ab");
  const key = landingIntentKey("node:with:colons", receiptId);

  expect(key.slice(0, 64)).toBe(receiptId);
  expect(key[64]).toBe(":");
  expect(key.slice(65)).toBe("node:with:colons");
  expect(landingIntentKey("a:b", receiptId)).not.toBe(landingIntentKey("a", receiptId));
});

it("answers NULL, not an empty set, when any journaled intent does not decode", () => {
  const fixture = recoveryEvidenceFixture();
  const receiptId = fixture.verified.receipt.receiptId;
  fixture.completed(false);
  seedUndecodableIntent(fixture.store, "planted-undecodable-intent");

  const ledgers = readReviewLedgers(fixture.store, PROJECT_ID, new Set([SUBJECT_REF]));

  // NULL is the answer, and it is a DIFFERENT answer from an empty set: empty says "walked the
  // ledger, found no intent" and lets a reader credit on the receipt code alone; null says
  // "unverifiable" and credits nothing. An assertion of merely "not the good key" passes for
  // both, so it would not be testing this at all.
  expect(ledgers.landingIntents).toBeNull();
  expect(ledgers.landingIntents).not.toEqual(new Set());
  // ONE GOOD INTENT DOES NOT RESCUE THE WALK. A fail-OPEN reader hands back the good key here
  // and looks entirely correct; this is the assertion that separates the two.
  expect(ledgers.landingIntents).not.toEqual(new Set([landingIntentKey(SUBJECT_REF, receiptId)]));
  // The rest of the walk still completed — an early return would have taken these with it.
  expect(ledgers.ledgers.get(SUBJECT_REF)?.unreadable).toBe(false);
  expect(ledgers.ledgers.get(SUBJECT_REF)?.decisionCount).toBeGreaterThan(0);
});

it("is EMPTY, never null, for a project that journaled no intent at all", () => {
  const fixture = recoveryEvidenceFixture();
  fixture.landed();

  const ledgers = readReviewLedgers(fixture.store, PROJECT_ID, new Set([SUBJECT_REF]));

  // The other half of the distinction. A reader that answered null here would refuse to credit
  // every legitimate landing in the product.
  expect(ledgers.landingIntents).toEqual(new Set());
  expect(ledgers.landingIntents).not.toBeNull();
  // And the members that existed before this change still answer exactly what they answered.
  expect(ledgers.landings.get(SUBJECT_REF)?.outcome).toBe("COMMITTED");
  expect(ledgers.ledgers.get(SUBJECT_REF)?.accepted?.verifierReceiptId)
    .toBe(fixture.verified.receipt.receiptId);
});

it("collects the intents in the SAME walk — one page read, not two", () => {
  const fixture = recoveryEvidenceFixture();
  fixture.completed(false);

  // The bound this arm's exactness rests on, measured rather than assumed: under one page of
  // `LEDGER_PAGE_SIZE` a complete walk is exactly one `readCommandDecisionsAfter` call, so a
  // second walk added anywhere in the reader shows up as 2.
  const rows = decisionRows(fixture.store).length;
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThan(200);

  const counted = countingStore(fixture.store);
  const ledgers = readReviewLedgers(counted.store, PROJECT_ID, new Set([SUBJECT_REF]));

  expect(counted.pages()).toBe(1);
  // Bound to a walk that actually collected something: a reader that read one page and dropped
  // every intent on the floor would satisfy the count above on its own.
  expect(ledgers.landingIntents?.size).toBe(1);
});
