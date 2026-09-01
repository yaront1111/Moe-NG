/**
 * The clean review package (design 15.2).
 *
 * The exclusions DoD 2 names are enforced BY CONSTRUCTION, not by filtering. The builder admits
 * only the allow-listed kinds in `REVIEW_PACKAGE_ITEM_KINDS`, so a worker transcript, a
 * self-assessment, or a journal entry is never something the package strips out — it is something
 * that was never expressible. `REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS` exists purely so the nearest
 * legal attempt earns `PACKAGE_ITEM_KIND_FORBIDDEN` instead of the generic unknown-kind code;
 * removing that list would tighten nothing, it would only make the refusal less informative.
 *
 * Consequently this module imports NOTHING from a context journal, a transcript store, or a
 * self-assessment surface: you cannot import a thing in order to leave it out.
 *
 * Receipts are opaque content-addressed references validated for SHAPE ONLY (64-hex). The
 * evidence receipt pipeline owns their internals; modelling them here would create a seam that
 * later has to be undone.
 */
import { canonicalDigest, canonicalJson, deepFreeze, isHex64 } from "./canonical.js";
import {
  REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS,
  REVIEW_PACKAGE_ITEM_KINDS,
  REVIEW_PACKAGE_VERSION,
} from "./review-contract.js";
import type {
  ReviewPackage,
  ReviewPackageBoundItem,
  ReviewPackageItemInput,
  ReviewPackageItemKind,
  ReviewReasonCode,
  ReviewRefusal,
  ReviewResult,
} from "./review-contract.js";

const ALLOWED_KINDS: ReadonlySet<string> = new Set<string>(REVIEW_PACKAGE_ITEM_KINDS);
const FORBIDDEN_KINDS: ReadonlySet<string> =
  new Set<string>(REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS);

/** Design 15.2 binds ONE of each of these; a second is ambiguous, never a silent first-wins. */
const SINGLETON_KINDS = [
  "GRAPH_HASH", "INTEGRATED_TREE", "PLAN_HASH", "RUBRIC", "SUBMITTED_BYTES",
] as const;

function isAllowedKind(kind: string): kind is ReviewPackageItemKind {
  return ALLOWED_KINDS.has(kind);
}

function refuse(code: ReviewReasonCode): ReviewRefusal {
  return deepFreeze<ReviewRefusal>({ code, layer: "PACKAGE", ok: false });
}

/**
 * Total order over (kind, locator, digest). Sorting on the whole canonical record would order by
 * digest first, which would let an unrelated byte change reorder the bound lists.
 *
 * The key is a canonical JSON array rather than a delimiter-joined string: JSON quoting
 * makes the encoding injective, so no locator can impersonate a field boundary.
 */
function itemOrder(left: ReviewPackageBoundItem, right: ReviewPackageBoundItem): number {
  const leftKey = canonicalJson([left.kind, left.locator, left.digest]);
  const rightKey = canonicalJson([right.kind, right.locator, right.digest]);
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function admit(
  items: readonly ReviewPackageItemInput[],
): ReviewResult<readonly ReviewPackageBoundItem[]> {
  const accepted: ReviewPackageBoundItem[] = [];
  for (const item of items) {
    // Each field is read EXACTLY ONCE. Validating `item.digest` and then binding `item.digest`
    // would read an accessor twice, so a re-reading getter could bind bytes that were never
    // checked — the digest would attest a reference nobody validated.
    const kind = item.kind;
    const digest = item.digest;
    const locator = item.locator;
    if (FORBIDDEN_KINDS.has(kind)) return refuse("PACKAGE_ITEM_KIND_FORBIDDEN");
    if (!isAllowedKind(kind)) return refuse("PACKAGE_ITEM_KIND_UNKNOWN");
    if (!isHex64(digest)) return refuse("PACKAGE_ITEM_DIGEST_INVALID");
    // A non-string locator must refuse HERE: past admission it reaches the canonical sort
    // comparator, where `canonicalJson` throws an unstructured TypeError instead of naming a code.
    if (typeof locator !== "string") return refuse("PACKAGE_ITEM_LOCATOR_INVALID");
    accepted.push({ digest, kind, locator });
  }
  return { ok: true, value: accepted.sort(itemOrder) };
}

function pickSingleton(
  items: readonly ReviewPackageBoundItem[],
  kind: ReviewPackageItemKind,
): ReviewResult<ReviewPackageBoundItem> {
  const matches = items.filter((item) => item.kind === kind);
  const only = matches[0];
  if (only === undefined) return refuse("PACKAGE_BINDING_INCOMPLETE");
  if (matches.length > 1) return refuse("PACKAGE_BINDING_AMBIGUOUS");
  return { ok: true, value: only };
}

/** Every singleton binding, resolved together so one missing field cannot mask another. */
function pickSingletons(
  items: readonly ReviewPackageBoundItem[],
): ReviewResult<ReadonlyMap<ReviewPackageItemKind, ReviewPackageBoundItem>> {
  const resolved = new Map<ReviewPackageItemKind, ReviewPackageBoundItem>();
  for (const kind of SINGLETON_KINDS) {
    const picked = pickSingleton(items, kind);
    if (!picked.ok) return picked;
    resolved.set(kind, picked.value);
  }
  return { ok: true, value: resolved };
}

/**
 * Builds one clean package. Every refusal names its code and the `PACKAGE` layer, so a test can
 * pin which layer answered rather than merely that the build did not succeed.
 */
export function buildReviewPackage(
  items: readonly ReviewPackageItemInput[],
): ReviewResult<ReviewPackage> {
  const admitted = admit(items);
  if (!admitted.ok) return admitted;
  const singletons = pickSingletons(admitted.value);
  if (!singletons.ok) return singletons;
  const criteria = admitted.value.filter((item) => item.kind === "CRITERION");
  const receipts = admitted.value.filter((item) =>
    item.kind === "DAEMON_ARTIFACT" || item.kind === "DAEMON_RECEIPT");
  if (criteria.length === 0) return refuse("PACKAGE_BINDING_INCOMPLETE");
  if (!receipts.some((item) => item.kind === "DAEMON_RECEIPT")) {
    return refuse("PACKAGE_BINDING_INCOMPLETE");
  }
  const graphHash = singletons.value.get("GRAPH_HASH");
  const planHash = singletons.value.get("PLAN_HASH");
  const rubric = singletons.value.get("RUBRIC");
  const submittedBytes = singletons.value.get("SUBMITTED_BYTES");
  const tree = singletons.value.get("INTEGRATED_TREE");
  if (graphHash === undefined || planHash === undefined || rubric === undefined
    || submittedBytes === undefined || tree === undefined) {
    return refuse("PACKAGE_BINDING_INCOMPLETE");
  }
  const bound = { criteria, hashes: [graphHash, planHash], receipts, rubric, submittedBytes, tree };
  return deepFreeze<ReviewResult<ReviewPackage>>({
    ok: true,
    value: {
      bound,
      reviewInputDigest: canonicalDigest({ bound, version: REVIEW_PACKAGE_VERSION }),
      version: REVIEW_PACKAGE_VERSION,
    },
  });
}
