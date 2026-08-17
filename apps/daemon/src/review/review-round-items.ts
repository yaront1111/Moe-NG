import type { JsonValue } from "@moe/contracts";
import { REVIEW_PACKAGE_ITEM_KINDS } from "@moe/review";
import type { ReviewPackage, ReviewPackageBoundItem, ReviewPackageItemKind } from "@moe/review";

import { isPlainJsonObject } from "./review-contracts.js";

/**
 * The stored shape of a review round's package items.
 *
 * Split out of `review-read-model.ts` so that module stays near the per-file target and so both
 * directions of the storage shape — what a round writes and what a reader may trust — sit in one
 * place rather than drifting across two.
 *
 * ABSENT IS A STATUS, NOT AN EMPTY LIST, and that is the whole point of the union below. A round
 * recorded before items were persisted has no evidence to hand back; answering `[]` would present
 * it as a well-formed package binding zero evidence, indistinguishable downstream from a real one.
 * A caller must narrow on `status` to reach `items`, so `?? []` cannot apply (the field is never
 * nullish) and a spread does not typecheck. The disguise is unreachable rather than merely untaken.
 *
 * SHAPE ONLY. Whether an item set is a VALID package — one of each singleton kind, at least one
 * criterion, at least one receipt — belongs to `@moe/review`'s `buildReviewPackage` and is asked
 * by `review-package-restore.ts`. Deciding it here would be a second source of truth that drifts.
 * What is checked here is exactly what makes the values typeable as `ReviewPackageBoundItem`.
 */

export interface StoredPackageItemsPresent {
  readonly items: readonly ReviewPackageBoundItem[];
  readonly status: "PRESENT";
}

export interface StoredPackageItemsAbsent {
  readonly status: "ABSENT";
}

export type StoredPackageItems = StoredPackageItemsAbsent | StoredPackageItemsPresent;

export const ABSENT_PACKAGE_ITEMS: StoredPackageItemsAbsent = Object.freeze({
  status: "ABSENT" as const,
});

const ITEM_KEYS = Object.freeze(["digest", "kind", "locator"] as const);
const ITEM_KEY_SET: ReadonlySet<string> = new Set<string>(ITEM_KEYS);
const ITEM_KIND_SET: ReadonlySet<string> = new Set<string>(REVIEW_PACKAGE_ITEM_KINDS);
const HEX64 = /^[0-9a-f]{64}$/u;

function isItemKind(value: string): value is ReviewPackageItemKind {
  return ITEM_KIND_SET.has(value);
}

/**
 * Exact keys, not merely required ones: an item carrying a fourth key was written by something
 * other than this surface, and binding it would let unvalidated bytes ride along under a digest
 * that never covered them.
 */
function parseItem(value: JsonValue): ReviewPackageBoundItem | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== ITEM_KEYS.length) return undefined;
  if (!keys.every((key) => ITEM_KEY_SET.has(key))) return undefined;
  const digest = value["digest"];
  const kind = value["kind"];
  const locator = value["locator"];
  if (typeof digest !== "string" || !HEX64.test(digest)) return undefined;
  if (typeof kind !== "string" || !isItemKind(kind)) return undefined;
  if (typeof locator !== "string") return undefined;
  return Object.freeze({ digest, kind, locator });
}

/**
 * The set the kernel BOUND, read straight out of its own six binding slots.
 *
 * `buildReviewPackage` returns the binding, never a flat list, so recovering one is a read of the
 * kernel's own structure rather than a rebuild of it: every allow-listed kind lands in exactly one
 * slot, so the six concatenated are precisely the admitted items and nothing else. The caller's
 * raw parsed array is deliberately NOT what a caller of this function can reach — persisting
 * pre-validation bytes would durably record content the stored digest does not attest.
 */
export function boundPackageItems(built: ReviewPackage): readonly ReviewPackageBoundItem[] {
  const { criteria, hashes, receipts, rubric, submittedBytes, tree } = built.bound;
  return Object.freeze([...criteria, ...hashes, ...receipts, rubric, submittedBytes, tree]);
}

/**
 * Three answers, kept distinguishable: PRESENT with the items, ABSENT for a round recorded before
 * they were stored, and `undefined` for a key that is present and untrustworthy.
 *
 * `undefined` is the module's existing unreadable idiom (`parseLineage`, `parseRouting`), so a
 * malformed key makes the whole round unreadable rather than partly trusted. A stored JSON `null`
 * is malformed, NOT absent: the pre-change shape has no key at all, so an explicit null was
 * written by something this surface does not recognise.
 */
export function parseStoredPackageItems(
  value: JsonValue | undefined,
): StoredPackageItems | undefined {
  if (value === undefined) return ABSENT_PACKAGE_ITEMS;
  if (!Array.isArray(value)) return undefined;
  const items: ReviewPackageBoundItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return Object.freeze({ items: Object.freeze(items), status: "PRESENT" as const });
}
