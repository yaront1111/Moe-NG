import type { FairnessPriority } from "./fairness-model.js";

/**
 * Design §8.4 project-wide ceiling: the maximum number of simultaneous
 * continuously-dispatchable tickets per compatible dimension. Overridable per
 * state; there is no other magic number for this cap.
 */
export const DEFAULT_M_D = 10_000 as const;

/** Maximum events accepted by one in-memory reference reduction. */
export const MAX_FAIRNESS_EVENTS_PER_REDUCTION = 100_000 as const;

/** Maximum UTF-8 bytes in ticket, work-item, or dimension identities. */
export const MAX_FAIRNESS_ID_UTF8_BYTES = 256 as const;

/** Highest to lowest. Aging PROMOTES a ticket toward P0 (lower index). */
export const PRIORITY_LADDER: readonly FairnessPriority[] = Object.freeze([
  "P0",
  "P1",
  "P2",
  "P3",
]);

/** Bypasses required to advance one class (or to force from P0). */
export const BYPASSES_PER_LEVEL = 8 as const;

export function isFairnessPriority(value: unknown): value is FairnessPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

/**
 * Remaining eight-bypass promotion buckets to reach the forced cohort, counting
 * the current partial bucket as a whole one: P3=4, P2=3, P1=2, P0=1, forced=0.
 */
export function bucketsToForced(priority: FairnessPriority, forced: boolean): number {
  if (forced) {
    return 0;
  }
  switch (priority) {
    case "P0":
      return 1;
    case "P1":
      return 2;
    case "P2":
      return 3;
    case "P3":
      return 4;
  }
}

/** The next-higher class, or null when already at P0 (further aging forces). */
export function promotedPriority(priority: FairnessPriority): FairnessPriority | null {
  switch (priority) {
    case "P3":
      return "P2";
    case "P2":
      return "P1";
    case "P1":
      return "P0";
    case "P0":
      return null;
  }
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
