import { afterEach, expect, it } from "vitest";

import { readReviewLedger } from "./review-read-model.js";
import {
  REVIEW_PACKAGE_RESTORE_CODES,
  restoreReviewPackage,
} from "./review-package-restore.js";
import type { ReviewPackageRestoreResult } from "./review-package-restore.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  commitRaw,
  envelope,
  hex64,
  openStore,
  submit,
  submitPayload,
  tamperedRoundResult,
} from "./review-test-fixtures.js";
import type { SqliteEventStore } from "@moe/store";

/**
 * The integrity check: what turns "the items are present" into "the items are the right ones".
 *
 * Persistence alone proves nothing. A substituted item set is present, well-shaped, and answers
 * every structural question the read model can ask — only the digest recorded BESIDE it at submit
 * time can say it is the set the round was actually raised against. So the comparison here is
 * always recomputed-against-STORED, never recomputed-against-recomputed; two operands from one
 * source would agree unconditionally and the suite would be a tautology.
 *
 * The accepted control is deliberate and load-bearing. A refusal-only suite cannot see a wrong
 * ACCEPTED value: an implementation that refused everything would satisfy every negative below.
 */

/** The seven items in bind order, hand-written rather than derived from the fixture. */
const BOUND_ITEMS = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
] as const;

afterEach(closeStores);

/** One honestly submitted round, plus the digest the production handler stored beside it. */
function honestRound(store: SqliteEventStore): { digest: string; lineage: unknown; routing: unknown } {
  const outcome = submit(store, 1);
  if (!outcome.ok) throw new Error(`round 1 setup failed: ${outcome.code}`);
  const round = readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds[0];
  if (round === undefined) throw new Error("round 1 did not read back");
  return { digest: round.reviewInputDigest, lineage: round.lineage, routing: round.routing };
}

/**
 * Stages a SECOND round carrying the first round's REAL stored digest beside whatever items the
 * case under test needs. The digest is genuine production output; only the items are tampered
 * with, which is exactly the substitution the check has to catch.
 */
function stageAgainstHonestDigest(store: SqliteEventStore, items: unknown): void {
  const honest = honestRound(store);
  const staged = commitRaw(
    store,
    envelope("review.submit", 1, submitPayload(2), "cmd-staged-round-2"),
    {
      lineage: honest.lineage,
      packageItems: items,
      reviewInputDigest: honest.digest,
      round: 2,
      routing: honest.routing,
    },
  );
  if (!staged.ok) throw new Error(`staging failed: ${staged.code}`);
}

const codeOf = (result: ReviewPackageRestoreResult): string | null => result.ok ? null : result.code;
const layerOf = (result: ReviewPackageRestoreResult): string | null =>
  result.ok ? null : result.refusedBy;

it("accepts a round whose stored items reproduce the digest recorded beside them", () => {
  const store = openStore();
  const honest = honestRound(store);

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 1);

  expect(restored.ok, restored.ok ? "" : restored.code).toBe(true);
  if (!restored.ok) throw new Error("expected an accepted restore");
  expect(restored.items).toEqual(BOUND_ITEMS);
  expect(restored.reviewInputDigest).toBe(honest.digest);
  expect(restored.reviewInputDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(restored.round).toBe(1);
});

it("refuses when one stored item's digest was substituted after the fact", () => {
  const store = openStore();
  // A valid 64-hex digest on the RUBRIC item, so the set still binds cleanly. Only the
  // recomputed input digest can notice; nothing structural is wrong with these bytes.
  stageAgainstHonestDigest(store, BOUND_ITEMS.map((item) =>
    item.kind === "RUBRIC" ? { ...item, digest: hex64("ab") } : item));

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 2);

  expect(codeOf(restored)).toBe("REVIEW_PACKAGE_DIGEST_MISMATCH");
  expect(layerOf(restored)).toBe("DAEMON_PREREQUISITE");
  expect(restored.ok ? null : restored.kernelLayer).toBeNull();
});

it("refuses when a stored item's locator was substituted, digest untouched", () => {
  const store = openStore();
  stageAgainstHonestDigest(store, BOUND_ITEMS.map((item) =>
    item.kind === "CRITERION" ? { ...item, locator: "criterion-2" } : item));

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 2);

  expect(codeOf(restored)).toBe("REVIEW_PACKAGE_DIGEST_MISMATCH");
  expect(layerOf(restored)).toBe("DAEMON_PREREQUISITE");
});

it("surfaces the kernel's own code when the restored set is not a package at all", () => {
  const store = openStore();
  stageAgainstHonestDigest(store, BOUND_ITEMS.filter((item) => item.kind !== "DAEMON_RECEIPT"));

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 2);

  // The kernel decides package validity, not this module and not the read model.
  expect(codeOf(restored)).toBe("PACKAGE_BINDING_INCOMPLETE");
  expect(layerOf(restored)).toBe("REVIEW_KERNEL");
  expect(restored.ok ? null : restored.kernelLayer).toBe("PACKAGE");
});

it("refuses a round recorded before items were stored as ABSENT, not as an empty package", () => {
  const store = openStore();
  const staged = commitRaw(
    store,
    envelope("review.submit", 0, submitPayload(1), "cmd-pre-change-round"),
    tamperedRoundResult(),
  );
  expect(staged.ok).toBe(true);

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 1);

  expect(codeOf(restored)).toBe("REVIEW_PACKAGE_ITEMS_ABSENT");
  expect(layerOf(restored)).toBe("DAEMON_PREREQUISITE");
  // Absent evidence must never arrive as an accepted zero-evidence package.
  expect(restored.ok).toBe(false);
  expect(restored).not.toEqual({ items: [], ok: true, reviewInputDigest: hex64("a1"), round: 1 });
});

it("refuses a stored empty item set at the kernel, so PRESENT-and-empty is not authority", () => {
  const store = openStore();
  // No handler can write this — `buildReviewPackage` refuses an empty set at submit time — so it
  // is only reachable by tampering with the durable bytes. The read model calls it PRESENT
  // because it IS structurally present; the kernel is what denies it authority.
  stageAgainstHonestDigest(store, []);

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 2);

  expect(codeOf(restored)).toBe("PACKAGE_BINDING_INCOMPLETE");
  expect(layerOf(restored)).toBe("REVIEW_KERNEL");
  expect(restored.ok ? null : restored.kernelLayer).toBe("PACKAGE");
});

it("refuses a round number nothing was ever recorded under", () => {
  const store = openStore();
  honestRound(store);

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 7);

  expect(codeOf(restored)).toBe("REVIEW_PACKAGE_ROUND_NOT_FOUND");
  expect(layerOf(restored)).toBe("DAEMON_PREREQUISITE");
});

it("refuses every round of a subject holding one unreadable round", () => {
  const store = openStore();
  const staged = commitRaw(
    store,
    envelope("review.submit", 0, submitPayload(1), "cmd-unreadable-round"),
    { ...tamperedRoundResult(), packageItems: "not-an-array" },
  );
  expect(staged.ok).toBe(true);

  const restored = restoreReviewPackage(store, PROJECT_ID, SUBJECT_REF, 1);

  expect(codeOf(restored)).toBe("REVIEW_PACKAGE_ROUND_UNREADABLE");
  expect(layerOf(restored)).toBe("DAEMON_PREREQUISITE");
});

/**
 * Both directions, against a HAND-WRITTEN list. Deriving the expectation from the frozen
 * vocabulary would put the same array on both sides, and a fifth code appended to production
 * would appear on both and stay green.
 */
it("declares exactly the codes this surface emits and no dead one", () => {
  const expected = [
    "REVIEW_PACKAGE_DIGEST_MISMATCH",
    "REVIEW_PACKAGE_ITEMS_ABSENT",
    "REVIEW_PACKAGE_ROUND_NOT_FOUND",
    "REVIEW_PACKAGE_ROUND_UNREADABLE",
  ];

  expect(new Set<string>(REVIEW_PACKAGE_RESTORE_CODES)).toEqual(new Set(expected));
  expect(REVIEW_PACKAGE_RESTORE_CODES).toHaveLength(expected.length);
});
