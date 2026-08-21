import { refused, workFailure } from "./work-kernel.js";
import type { WorkResult } from "./work-kernel.js";

/**
 * The design-427 provider slot ceiling: at most four RESERVED|ACTIVE provider
 * slots project-wide in the default dimension.
 *
 * The counting lives HERE, in the daemon, and not in the scheduler.
 * `reserveProviderSlot` validates one slot's declared resources and returns
 * RESERVED; it does no counting, and no ceiling constant exists anywhere in
 * `packages/scheduler`. `work-claim.ts` therefore consults this module BEFORE
 * calling the scheduler, so a scheduler-level accept cannot bypass the ceiling.
 *
 * THIS KERNEL COUNTS WHATEVER TABLE IT IS HANDED and holds no store. Production
 * hands it the SERVER-DERIVED durable occupancy — `activation-slot-occupancy.ts`
 * via `activation-ingress.ts` stage B2 — never the request's own `liveClaims`
 * section, which stays admitted at the envelope and feeds nothing. A
 * caller-counted table was the design-427 bypass: an empty table admitted a
 * fifth slot, and a padded one manufactured exhaustion.
 */

const PROVIDER_SLOT_CEILING = 4;
const DEFAULT_SLOT_DIMENSION = "default";
const OCCUPYING_SLOT_STATES: readonly string[] = ["RESERVED", "ACTIVE"];
const LIVE_CLAIM_KEYS = ["dimension", "slotRef", "state"] as const;

function isExactClaim(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === LIVE_CLAIM_KEYS.length
    && keys.every((key) => typeof key === "string"
      && (LIVE_CLAIM_KEYS as readonly string[]).includes(key));
}

/**
 * Counts occupying slots in the default dimension, answering `null` for a
 * malformed table.
 *
 * Failing closed here is load-bearing, not defensive tidiness: treating an
 * unreadable entry as "not occupying" would silently undercount and hand out a
 * fifth slot. A mutation drill confirmed the difference is observable.
 */
export function countOccupyingSlots(liveClaims: readonly unknown[]): number | null {
  let held = 0;
  for (const claim of liveClaims) {
    if (!isExactClaim(claim)) return null;
    const dimension = claim["dimension"];
    const state = claim["state"];
    if (typeof dimension !== "string" || typeof state !== "string") return null;
    if (typeof claim["slotRef"] !== "string") return null;
    if (dimension === DEFAULT_SLOT_DIMENSION && OCCUPYING_SLOT_STATES.includes(state)) held += 1;
  }
  return held;
}

/**
 * Answers a refusal when the ceiling is reached, or `null` to proceed. A
 * refusal is final: it carries no queue, retry, or defer affordance, because
 * DoD 4 requires the fifth claim to be refused outright and never queued.
 */
export function checkSlotCeiling(liveClaims: readonly unknown[]): WorkResult | null {
  const held = countOccupyingSlots(liveClaims);
  if (held === null) {
    return refused(
      workFailure(
        "WORK_PAYLOAD_MALFORMED",
        "slotCeiling",
        "AUTHORITY",
        "live claim table entry does not carry a readable slot dimension, state, and ref",
      ),
    );
  }
  if (held >= PROVIDER_SLOT_CEILING) {
    return refused(
      workFailure(
        "WORK_SLOT_EXHAUSTED",
        "slotCeiling",
        "AUTHORITY",
        `the ${PROVIDER_SLOT_CEILING} provider slots in the ${DEFAULT_SLOT_DIMENSION} dimension are fully held`,
      ),
    );
  }
  return null;
}
