import { afterEach, expect, it } from "vitest";

import { readReviewLedger } from "./review-read-model.js";
import type { ReviewOutcome } from "./review-ledger.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  commitRaw,
  envelope,
  hex64,
  openStore,
  packageItems,
  send,
  submitPayload,
  tamperedRoundResult,
} from "./review-test-fixtures.js";
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
