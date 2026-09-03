import { createHash } from "node:crypto";

import {
  canonicalizeLiveQuiesceSafeValue,
  snapshotLiveQuiesceSafeValue,
} from "./cutover-quiesce-evidence-safe-value.js";

export const LIVE_QUIESCE_EVIDENCE_LAYER = "live-quiesce-evidence";
export const LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES = Object.freeze([
  "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
  "LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH",
  "LIVE_QUIESCE_EVIDENCE_RUNMODE_MISSING",
  "LIVE_QUIESCE_EVIDENCE_AUTHORITY_MISSING",
  "LIVE_QUIESCE_EVIDENCE_MANIFEST_REFUSED",
  "LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING",
  "LIVE_QUIESCE_EVIDENCE_WRITE_FAILED",
] as const);

export type LiveQuiesceEvidenceRefusalCode =
  (typeof LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES)[number];

export interface LiveQuiesceEvidenceRefusal {
  readonly ok: false;
  readonly layer: typeof LIVE_QUIESCE_EVIDENCE_LAYER;
  readonly code: LiveQuiesceEvidenceRefusalCode;
  readonly detail: string;
}

export type LiveQuiesceItemKind =
  | "PROCESS" | "HANDLE" | "WATCHER" | "SCHEDULED_START" | "ACCESS_PATH";

export interface LiveQuiesceItem {
  readonly kind: LiveQuiesceItemKind;
  readonly id: string;
  readonly discoveredBy: string;
  readonly observedBefore: string;
}

export interface LiveQuiesceInventory {
  readonly runMode: "LIVE";
  readonly hostFingerprint: string;
  readonly itemCount: number;
  readonly items: readonly LiveQuiesceItem[];
  readonly undiscoverableKinds: readonly Readonly<{
    kind: LiveQuiesceItemKind; attemptedBy: string; refusedByLayer: string;
  }>[];
}

export type LiveQuiesceItemResult =
  | Readonly<{
    ok: true; item: LiveQuiesceItem; stopCommand: string;
    observedAfter: Readonly<{ live: boolean; detail: string }>; pollsUsed: number;
  }>
  | Readonly<{
    ok: false; layer: "live-quiesce-actor";
    code: "LIVE_QUIESCE_ITEM_STILL_LIVE" | "LIVE_QUIESCE_ITEM_UNDENIABLE" |
      "LIVE_QUIESCE_OBSERVATION_UNAVAILABLE";
    item: LiveQuiesceItem; refusedByLayer?: string; detail: string;
  }>;

export interface LiveQuiesceEvidence {
  readonly runMode: "LIVE";
  readonly hostFingerprint: string;
  readonly authority: Readonly<{ principal: string; moment: string; commentId: string }>;
  readonly inventory: LiveQuiesceInventory;
  readonly results: readonly LiveQuiesceItemResult[];
  readonly resolvedCount: number;
  readonly manifestComparison: Readonly<{
    ok: true;
    matched: boolean;
    differences: readonly Readonly<{
      path: string;
      kind:
        | "ADDED" | "REMOVED" | "CONTENT_CHANGED" | "LENGTH_CHANGED"
        | "LINK_TARGET_CHANGED" | "KIND_CHANGED";
    }>[];
    comparedEntryCount: number;
  }>;
  readonly stoppedAt: readonly Readonly<{ itemId: string; moment: string }>[];
  readonly outcome: "COMPLETE" | "PARTIAL" | "EMPTY";
  readonly citationKey: string;
  readonly citedBy: string;
}

export type LiveQuiesceEvidenceCanonicalResult =
  | LiveQuiesceEvidenceRefusal
  | Readonly<{ ok: true; canonicalJson: string }>;

export type LiveQuiesceEvidenceDigestResult =
  | LiveQuiesceEvidenceRefusal
  | Readonly<{ ok: true; quiesceRecordSha256: string }>;

const EVIDENCE_KEYS = Object.freeze([
  "authority", "citationKey", "citedBy", "hostFingerprint", "inventory",
  "manifestComparison", "outcome", "resolvedCount", "results", "runMode", "stoppedAt",
] as const);
const AUTHORITY_KEYS = Object.freeze(["commentId", "moment", "principal"] as const);
const INVENTORY_KEYS = Object.freeze([
  "hostFingerprint", "itemCount", "items", "runMode", "undiscoverableKinds",
] as const);
const COMPARISON_KEYS = Object.freeze([
  "comparedEntryCount", "differences", "matched", "ok",
] as const);
const STOP_MOMENT_KEYS = Object.freeze(["itemId", "moment"] as const);
const ITEM_KEYS = Object.freeze(["discoveredBy", "id", "kind", "observedBefore"] as const);
const UNDISCOVERABLE_KEYS = Object.freeze(["attemptedBy", "kind", "refusedByLayer"] as const);
const STOPPED_KEYS = Object.freeze([
  "item", "observedAfter", "ok", "pollsUsed", "stopCommand",
] as const);
const REFUSED_KEYS = Object.freeze(["code", "detail", "item", "layer", "ok"] as const);
const REFUSED_WITH_LAYER_KEYS = Object.freeze([...REFUSED_KEYS, "refusedByLayer"].sort());
const OBSERVATION_KEYS = Object.freeze(["detail", "live"] as const);
const DIFFERENCE_KEYS = Object.freeze(["kind", "path"] as const);
const DIGEST_DOMAIN = "moe-live-quiesce-evidence/1";
const ENCODER = new TextEncoder();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};

const isNonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const ITEM_KINDS = new Set(["PROCESS", "HANDLE", "WATCHER", "SCHEDULED_START", "ACCESS_PATH"]);
const ITEM_REFUSALS = new Set([
  "LIVE_QUIESCE_ITEM_STILL_LIVE", "LIVE_QUIESCE_ITEM_UNDENIABLE",
  "LIVE_QUIESCE_OBSERVATION_UNAVAILABLE",
]);
const DIFFERENCE_KINDS = new Set([
  "ADDED", "REMOVED", "CONTENT_CHANGED", "LENGTH_CHANGED",
  "LINK_TARGET_CHANGED", "KIND_CHANGED",
]);

const isAuthority = (value: unknown): value is LiveQuiesceEvidence["authority"] =>
  isRecord(value) && hasExactKeys(value, AUTHORITY_KEYS) &&
  isNonBlank(value.principal) && isNonBlank(value.moment) && isNonBlank(value.commentId);

const isItem = (value: unknown): value is LiveQuiesceItem =>
  isRecord(value) && hasExactKeys(value, ITEM_KEYS) && ITEM_KINDS.has(value.kind as string) &&
  isNonBlank(value.id) && isNonBlank(value.discoveredBy) && isNonBlank(value.observedBefore);

const isUndiscoverable = (value: unknown): boolean =>
  isRecord(value) && hasExactKeys(value, UNDISCOVERABLE_KEYS) &&
  ITEM_KINDS.has(value.kind as string) && isNonBlank(value.attemptedBy) &&
  isNonBlank(value.refusedByLayer);

const isInventory = (value: unknown): value is LiveQuiesceEvidence["inventory"] =>
  isRecord(value) && hasExactKeys(value, INVENTORY_KEYS) && value.runMode === "LIVE" &&
  isNonBlank(value.hostFingerprint) && isCount(value.itemCount) &&
  Array.isArray(value.items) && value.items.every(isItem) &&
  Array.isArray(value.undiscoverableKinds) && value.undiscoverableKinds.every(isUndiscoverable);

function isItemResult(value: unknown): value is LiveQuiesceItemResult {
  if (!isRecord(value) || !isItem(value.item) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    const observed = value.observedAfter;
    return hasExactKeys(value, STOPPED_KEYS) && isNonBlank(value.stopCommand) &&
      isCount(value.pollsUsed) && isRecord(observed) && hasExactKeys(observed, OBSERVATION_KEYS) &&
      typeof observed.live === "boolean" && typeof observed.detail === "string";
  }
  const keys = "refusedByLayer" in value ? REFUSED_WITH_LAYER_KEYS : REFUSED_KEYS;
  return hasExactKeys(value, keys) && value.layer === "live-quiesce-actor" &&
    ITEM_REFUSALS.has(value.code as string) && typeof value.detail === "string" &&
    (!("refusedByLayer" in value) || isNonBlank(value.refusedByLayer));
}

const isComparison = (value: unknown): value is LiveQuiesceEvidence["manifestComparison"] =>
  isRecord(value) && hasExactKeys(value, COMPARISON_KEYS) && value.ok === true &&
  typeof value.matched === "boolean" && Array.isArray(value.differences) && value.differences.every(
    (entry: unknown) => isRecord(entry) && hasExactKeys(entry, DIFFERENCE_KEYS) &&
      isNonBlank(entry.path) && DIFFERENCE_KINDS.has(entry.kind as string),
  ) &&
  isCount(value.comparedEntryCount);

const isStopMoments = (value: unknown): value is LiveQuiesceEvidence["stoppedAt"] =>
  Array.isArray(value) && value.every((entry: unknown) =>
    isRecord(entry) && hasExactKeys(entry, STOP_MOMENT_KEYS) &&
    isNonBlank(entry.itemId) && isNonBlank(entry.moment));

function isEvidence(value: unknown): value is LiveQuiesceEvidence {
  if (!isRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) return false;
  if (value.runMode !== "LIVE" || !isNonBlank(value.hostFingerprint)) return false;
  if (!isAuthority(value.authority) || !isInventory(value.inventory)) return false;
  if (!Array.isArray(value.results) || !value.results.every(isItemResult) || !isCount(value.resolvedCount)) return false;
  if (!isComparison(value.manifestComparison) || !isStopMoments(value.stoppedAt)) return false;
  if (!["COMPLETE", "PARTIAL", "EMPTY"].includes(value.outcome as string)) return false;
  return isNonBlank(value.citationKey) && isNonBlank(value.citedBy);
}

const refusal = (
  code: LiveQuiesceEvidenceRefusalCode, detail: string,
): LiveQuiesceEvidenceRefusal => Object.freeze({
  ok: false, layer: LIVE_QUIESCE_EVIDENCE_LAYER, code, detail,
});

function semanticRefusal(evidence: LiveQuiesceEvidence): LiveQuiesceEvidenceRefusal | null {
  const { inventory, results, resolvedCount } = evidence;
  if (inventory.itemCount !== inventory.items.length || inventory.itemCount !== results.length ||
      resolvedCount !== results.length) {
    return refusal("LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH", "inventory and result counts differ");
  }
  if (inventory.hostFingerprint !== evidence.hostFingerprint) {
    return refusal("LIVE_QUIESCE_EVIDENCE_INCOMPLETE", "host evidence is internally inconsistent");
  }
  const inventoryIds = new Set(inventory.items.map((item) => item.id));
  const resultIds = new Set(results.map((result) => result.item.id));
  if (inventoryIds.size !== inventory.items.length || resultIds.size !== results.length ||
      [...inventoryIds].some((id) => !resultIds.has(id)) ||
      [...resultIds].some((id) => !inventoryIds.has(id))) {
    return refusal("LIVE_QUIESCE_EVIDENCE_INCOMPLETE", "inventory items are not resolved exactly once");
  }
  const timedIds = new Set(evidence.stoppedAt.map((entry) => entry.itemId));
  if (results.some((result) => result.ok && !timedIds.has(result.item.id))) {
    return refusal("LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING", "a stopped item has no stop moment");
  }
  const outcome = results.length === 0 ? "EMPTY" : results.every((result) => result.ok)
    ? "COMPLETE" : "PARTIAL";
  if (evidence.outcome !== outcome) {
    return refusal("LIVE_QUIESCE_EVIDENCE_INCOMPLETE", "the recorded sweep outcome is inconsistent");
  }
  return null;
}

const incomplete = (): LiveQuiesceEvidenceRefusal => refusal(
  "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
  "the durable live-quiesce evidence record is absent or has an incomplete shape",
);

/**
 * Canonical digest JSON; unlike the migration pretty-printer, this has no display whitespace.
 * The caller's value is snapshotted into a detached own-data graph BEFORE any property or
 * schema read, so none of their accessors, proxy traps or iterators ever run, deep/oversized
 * input is refused rather than thrown, and a later caller mutation cannot change the accepted
 * bytes. Every remaining hostile failure lands on the existing INCOMPLETE code and layer.
 */
export function serializeLiveQuiesceEvidenceCanonical(
  evidence: unknown,
): LiveQuiesceEvidenceCanonicalResult {
  try {
    const snapshot = snapshotLiveQuiesceSafeValue(evidence);
    if (!snapshot.ok) return incomplete();
    const safe = snapshot.value;
    const detached: unknown = safe;
    if (!isEvidence(detached)) return incomplete();
    const semantics = semanticRefusal(detached);
    if (semantics !== null) return semantics;
    const canonical = canonicalizeLiveQuiesceSafeValue(safe);
    if (!canonical.ok) return incomplete();
    return Object.freeze({ ok: true, canonicalJson: canonical.canonicalJson });
  } catch {
    return incomplete();
  }
}

export function deriveLiveQuiesceEvidenceDigest(
  evidence: unknown,
): LiveQuiesceEvidenceDigestResult {
  const serialized = serializeLiveQuiesceEvidenceCanonical(evidence);
  if (!serialized.ok) return serialized;
  const quiesceRecordSha256 = createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(ENCODER.encode(serialized.canonicalJson))
    .digest("hex");
  return Object.freeze({ ok: true, quiesceRecordSha256 });
}
