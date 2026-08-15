import type { ResourceRow } from "@moe/scheduler";

import { exactDataRecord, isPlainArray } from "./recovery-inventory-contract.js";
import {
  DURABLE_INVENTORY_CURSOR_DIGITS,
  DURABLE_RECOVERY_INVENTORY_CLASSES,
  DURABLE_RESOURCE_FENCEABILITIES,
  DURABLE_RESOURCE_STATES,
  MAX_DURABLE_INVENTORY_COUNT,
  MAX_DURABLE_INVENTORY_TEXT_CHARS,
} from "./durable-recovery-inventory-contract.js";
import type {
  DurableIntegrationObservation,
  DurableInventoryBasis,
  DurableInventoryClassCoverage,
  DurableInventoryClassSeal,
  DurableInventoryObservation,
  DurableInventoryWindow,
  DurableRecoveryInventoryClass,
  DurableResourceObservation,
} from "./durable-recovery-inventory-contract.js";

/**
 * Hostile-input readers and the one scheduler projection, split out of
 * `./durable-recovery-inventory-contract.ts` so that module holds the shapes,
 * refusals and canonical bytes while this one holds "is this even an
 * observation, and does it belong to this window".
 *
 * Every reader goes through `exactDataRecord`, which asks proxy-ness FIRST and
 * reads own property DESCRIPTORS once: an accessor, a trap, an inherited key or
 * one extra key is refused outright rather than being read or silently dropped.
 */
const HEX64 = /^[0-9a-f]{64}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const CURSOR = new RegExp(`^[0-9]{${DURABLE_INVENTORY_CURSOR_DIGITS}}$`, "u");

export const isDurableDigest = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

export const isDurableText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 &&
  value.length <= MAX_DURABLE_INVENTORY_TEXT_CHARS &&
  !UNSAFE_TEXT.test(value) && value.normalize("NFC") === value;

/** Fixed width, so lexicographic cursor comparison IS numeric comparison. */
export const isDurableCursor = (value: unknown): value is string =>
  typeof value === "string" && CURSOR.test(value);

const isDurableCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= MAX_DURABLE_INVENTORY_COUNT && !Object.is(value, -0);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const SEAL_CLASS_KEYS = Object.freeze([
  "class", "itemCount", "negativeProofDigest", "rowDigests", "sourceProofDigest", "truth",
]);
const COVERAGE_KEYS = Object.freeze(["class", "negativeProofDigest", "sourceProofDigest"]);
const BASIS_KEYS = Object.freeze(["backupCursor", "backupGenerationDigest", "projectTag"]);
const WINDOW_KEYS = Object.freeze(["endInclusive", "startExclusive"]);
const RESOURCE_KEYS = Object.freeze([
  "capacityUnits", "class", "effectIntentRef", "epoch", "external", "fenceability",
  "observedPosition", "resourceId", "sourceProofDigest", "state",
]);
const INTEGRATION_KEYS = Object.freeze([
  "attemptRef", "class", "effectIntentRef", "intentDigest", "observedPosition",
  "sourceProofDigest", "targetRef",
]);

/**
 * The one projection of scheduler authority into a durable snapshot. Fenceable
 * becomes a CLOSED two-value vocabulary rather than a bare boolean, so a row
 * that cannot be fenced is NAMED as such in the durable record instead of being
 * one dropped negation away from reading as safe. No transition is recomputed:
 * every field is copied off the row scheduler already decided.
 */
export function durableResourceObservation(
  row: ResourceRow,
  sourceProofDigest: string,
  observedPosition: string,
): DurableResourceObservation {
  return Object.freeze({
    capacityUnits: row.capacityUnits,
    class: "RESOURCE" as const,
    effectIntentRef: row.effectIntentRef,
    epoch: row.epoch,
    external: row.external,
    fenceability: row.fenceable ? "FENCEABLE" as const : "NON_FENCEABLE" as const,
    observedPosition,
    resourceId: row.resourceId,
    sourceProofDigest,
    state: row.state,
  });
}

/** Project tag plus backup cursor/generation ONLY: no refs, counters or items. */
export function readDurableInventoryBasis(value: unknown): DurableInventoryBasis | null {
  const raw = exactDataRecord(value, BASIS_KEYS);
  if (raw === null) return null;
  if (!isDurableCursor(raw["backupCursor"])) return null;
  if (!isDurableDigest(raw["backupGenerationDigest"])) return null;
  if (!isDurableText(raw["projectTag"])) return null;
  return Object.freeze({
    backupCursor: raw["backupCursor"],
    backupGenerationDigest: raw["backupGenerationDigest"],
    projectTag: raw["projectTag"],
  });
}

export function readDurableInventoryWindow(value: unknown): DurableInventoryWindow | null {
  const raw = exactDataRecord(value, WINDOW_KEYS);
  if (raw === null) return null;
  if (!isDurableCursor(raw["endInclusive"]) || !isDurableCursor(raw["startExclusive"])) return null;
  if (raw["endInclusive"] <= raw["startExclusive"]) return null;
  return Object.freeze({
    endInclusive: raw["endInclusive"],
    startExclusive: raw["startExclusive"],
  });
}

/** `(startExclusive, endInclusive]` — a start-cursor observation is OUTSIDE. */
export const isInDurableWindow = (
  observation: DurableInventoryObservation,
  window: DurableInventoryWindow,
): boolean =>
  observation.observedPosition > window.startExclusive &&
  observation.observedPosition <= window.endInclusive;

function readResource(raw: Readonly<Record<string, unknown>>): DurableResourceObservation | null {
  if (!isDurableCount(raw["capacityUnits"]) || !isDurableCount(raw["epoch"])) return null;
  if (typeof raw["external"] !== "boolean") return null;
  if (!oneOf(raw["fenceability"], DURABLE_RESOURCE_FENCEABILITIES)) return null;
  if (!oneOf(raw["state"], DURABLE_RESOURCE_STATES)) return null;
  if (!isDurableText(raw["effectIntentRef"]) || !isDurableText(raw["resourceId"])) return null;
  return Object.freeze({
    capacityUnits: raw["capacityUnits"],
    class: "RESOURCE" as const,
    effectIntentRef: raw["effectIntentRef"],
    epoch: raw["epoch"],
    external: raw["external"],
    fenceability: raw["fenceability"],
    observedPosition: raw["observedPosition"] as string,
    resourceId: raw["resourceId"],
    sourceProofDigest: raw["sourceProofDigest"] as string,
    state: raw["state"],
  });
}

function readIntegration(
  raw: Readonly<Record<string, unknown>>,
): DurableIntegrationObservation | null {
  if (!isDurableDigest(raw["intentDigest"])) return null;
  if (!isDurableText(raw["attemptRef"]) || !isDurableText(raw["targetRef"])) return null;
  if (!isDurableText(raw["effectIntentRef"])) return null;
  return Object.freeze({
    attemptRef: raw["attemptRef"],
    class: "INTEGRATION_TARGET" as const,
    effectIntentRef: raw["effectIntentRef"],
    intentDigest: raw["intentDigest"],
    observedPosition: raw["observedPosition"] as string,
    sourceProofDigest: raw["sourceProofDigest"] as string,
    targetRef: raw["targetRef"],
  });
}

/**
 * The key set decides which arm may answer, and the `class` discriminant must
 * agree with it. A resource-shaped body labelled `INTEGRATION_TARGET` is
 * refused rather than being read by the arm its label names.
 */
export function readDurableInventoryObservation(
  value: unknown,
): DurableInventoryObservation | null {
  const resourceRaw = exactDataRecord(value, RESOURCE_KEYS);
  const raw = resourceRaw ?? exactDataRecord(value, INTEGRATION_KEYS);
  if (raw === null) return null;
  if (!isDurableCursor(raw["observedPosition"])) return null;
  if (!isDurableDigest(raw["sourceProofDigest"])) return null;
  if (resourceRaw !== null) return raw["class"] === "RESOURCE" ? readResource(raw) : null;
  return raw["class"] === "INTEGRATION_TARGET" ? readIntegration(raw) : null;
}

/** Exactly the two classes, in canonical order, each named exactly once. */
export function readDurableInventoryCoverage(
  value: unknown,
): readonly DurableInventoryClassCoverage[] | null {
  if (!isPlainArray(value) || value.length !== DURABLE_RECOVERY_INVENTORY_CLASSES.length) {
    return null;
  }
  const coverage: DurableInventoryClassCoverage[] = [];
  for (const [index, entry] of value.entries()) {
    const raw = exactDataRecord(entry, COVERAGE_KEYS);
    if (raw === null) return null;
    if (raw["class"] !== DURABLE_RECOVERY_INVENTORY_CLASSES[index]) return null;
    if (!isDurableDigest(raw["sourceProofDigest"])) return null;
    const negative = raw["negativeProofDigest"];
    if (negative !== null && !isDurableDigest(negative)) return null;
    coverage.push(Object.freeze({
      class: raw["class"] as DurableRecoveryInventoryClass,
      negativeProofDigest: negative,
      sourceProofDigest: raw["sourceProofDigest"],
    }));
  }
  return Object.freeze(coverage);
}

/**
 * JSON-array framing, so identity is injective: no separator byte can appear
 * unescaped inside a component and merge two genuinely distinct records.
 */
export function durableObservationIdentity(observation: DurableInventoryObservation): string {
  return observation.class === "RESOURCE"
    ? JSON.stringify(["RESOURCE", observation.resourceId, observation.effectIntentRef])
    : JSON.stringify([
      "INTEGRATION_TARGET", observation.attemptRef, observation.targetRef,
      observation.effectIntentRef,
    ]);
}

/**
 * The stored seal's own class table, re-derived rather than trusted. Digest
 * shape, the sorted commitment order and the negative-proof co-presence rule
 * are all re-checked here: a body re-hashed through the production digest
 * surface is canonical and correctly digested, so the digest alone certifies
 * none of them.
 */
export function readDurableSealClasses(value: unknown): readonly DurableInventoryClassSeal[] | null {
  if (!Array.isArray(value) || value.length !== DURABLE_RECOVERY_INVENTORY_CLASSES.length) {
    return null;
  }
  const classes: DurableInventoryClassSeal[] = [];
  for (const [index, entry] of value.entries()) {
    const raw = exactDataRecord(entry, SEAL_CLASS_KEYS);
    if (raw === null || raw["class"] !== DURABLE_RECOVERY_INVENTORY_CLASSES[index]) return null;
    if (raw["truth"] !== "COMPLETE" || !Array.isArray(raw["rowDigests"])) return null;
    const digests = raw["rowDigests"] as readonly unknown[];
    if (raw["itemCount"] !== digests.length) return null;
    // Re-derive what the sealer enforced, rather than trusting the stored
    // spelling: digest shape, the sorted commitment order, and the negative
    // proof's own co-presence rule. A body re-hashed through this same surface
    // is canonical and correctly digested, so the digest alone certifies
    // nothing about these fields.
    if (digests.some((digest) => !isDurableDigest(digest))) return null;
    const ordered = [...(digests as readonly string[])].sort();
    if ((digests as readonly string[]).some((digest, at) => digest !== ordered[at])) return null;
    if (!isDurableDigest(raw["sourceProofDigest"])) return null;
    const negative = raw["negativeProofDigest"];
    if (negative !== null && !isDurableDigest(negative)) return null;
    if ((digests.length === 0) !== (negative !== null)) return null;
    classes.push(Object.freeze({
      class: raw["class"] as DurableRecoveryInventoryClass,
      itemCount: raw["itemCount"] as number,
      negativeProofDigest: raw["negativeProofDigest"] as string | null,
      rowDigests: Object.freeze(digests as readonly string[]),
      sourceProofDigest: raw["sourceProofDigest"] as string,
      truth: "COMPLETE" as const,
    }));
  }
  return Object.freeze(classes);
}
