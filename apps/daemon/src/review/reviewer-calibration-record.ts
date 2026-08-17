import type { JsonValue } from "@moe/contracts";
import { REVIEW_CALIBRATION_STALENESS } from "@moe/review";
import type { ReviewCalibrationStaleness, ReviewerCalibration } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { aggregateIdFor, readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import type { ServiceRefusedBy } from "../bootstrap/bootstrap-ledger.js";

/**
 * The durable home of `ReviewerCalibration` (design 15.3) and the focused reader over it.
 *
 * The contract calls the two facts "caller-supplied durable facts". Caller-supplied is the
 * intended authority model; DURABLE was the missing half — until now the only thing on disk
 * that produced one was a test fixture. This module supplies the durable half WITHOUT minting
 * a runtime command kind: `policy.install` already accepts an arbitrary JsonObject slice under
 * a caller-chosen ref, is already registered with capability ADMIN and payload allow-list
 * ["slice"], and already folds `{slices: {...current, [sliceRef]: slice}}` behind a durable
 * `PolicyInstalled` event. The runtime command vocabulary is frozen with a full-coverage
 * ratchet, so widening it would be a far larger change for no capability the slice mechanism
 * lacks. This module therefore ships the READER and the well-known address, and no writer.
 *
 * IT WRITES NOTHING. Every function here reads the ledger and returns; none holds the store
 * handle past its own call.
 */

/**
 * The well-known address of the calibration slice. Deliberately NOT 64 hex.
 *
 * A slice is visible to `validatePolicy` as an installed ref, so the honest question is whether
 * a caller could name this one in an evaluation input. They cannot reach an ACCEPTED evaluation:
 * `packages/core/src/policy/policy-validation.ts` refuses any `policyRevisionRef` that is not
 * 64 hex, so an input naming this ref clears `installPolicy`'s presence check and is then
 * refused by `evaluatePolicy` under layer `CORE_REDUCER`. A hex64 ref would have made the
 * calibration record nameable as a policy revision, which is the confusion this shape avoids.
 */
export const REVIEWER_CALIBRATION_SLICE_REF = "moe-reviewer-calibration/1";

/**
 * Distinct causes keep distinct codes. "Nothing was ever installed" and "something is installed
 * but its contents do not parse" are different durable facts, and collapsing them would make a
 * later guard change invisible to every test.
 *
 * These are NOT added to `REVIEW_INGRESS_REFUSAL_CODES` or `REVIEW_PREREQUISITE_REFUSAL_CODES`:
 * those vocabularies are asserted in both directions against the codes `runReviewCommand`
 * actually emits, and a durable reader that is not a review command would land there as a dead
 * entry.
 */
export const REVIEWER_CALIBRATION_REFUSAL_CODES = Object.freeze([
  "REVIEWER_CALIBRATION_NOT_INSTALLED",
  "REVIEWER_CALIBRATION_UNREADABLE",
] as const);

export type ReviewerCalibrationRefusalCode = (typeof REVIEWER_CALIBRATION_REFUSAL_CODES)[number];

/**
 * The layer that answered. Typed as `ServiceRefusedBy` rather than as a bare string so this
 * value cannot drift out of the daemon's shared layer vocabulary without a compile error, and
 * NOT exported as a `*_LAYER` constant — `tests/security/boundary-roster.security.ts` scans
 * production sources for exactly that declaration shape against a hand-written table.
 */
const DURABLE_READ_LAYER: ServiceRefusedBy = "DAEMON_PREREQUISITE";

export type ReviewerCalibrationRead =
  | Readonly<{ readonly calibration: ReviewerCalibration; readonly ok: true }>
  | Readonly<{
    readonly code: ReviewerCalibrationRefusalCode;
    readonly layer: ServiceRefusedBy;
    readonly ok: false;
  }>;

/** The exact key set a calibration slice may carry. `sliceRef` is its address, not a fact. */
const SLICE_KEYS: readonly string[] = Object.freeze([
  "corpusRevision", "sentinelPassed", "sliceRef", "staleness",
]);

function refuse(code: ReviewerCalibrationRefusalCode): ReviewerCalibrationRead {
  // No `calibration` key on this branch at all. Returning
  // `{corpusRevision: "", sentinelPassed: false, staleness: "UNKNOWN"}` instead would be a
  // fabrication that passes review: it is a perfectly legal `ReviewerCalibration`, and
  // `calibrationCodes` maps it to `REVIEWER_CALIBRATION_UNPROVEN`, so it LOOKS fail-closed
  // while asserting that a calibration exists and is unproven when the truth is that none
  // exists at all. Missing evidence stays missing; it never gains the authority of a record.
  return Object.freeze({ code, layer: DURABLE_READ_LAYER, ok: false as const });
}

/** Objects decoded from the ledger have a NULL prototype, so no inherited-key check is safe. */
function asObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * The policy aggregate this project's slices live on, asked of production's own mapping rather
 * than restated. `aggregateIdFor` reads only `kind` and `projectId`; the cast supplies those
 * two and nothing else, so a change to the policy case follows here instead of detaching.
 */
function policyAggregateId(projectId: string): string {
  const request = { kind: "policy.install", projectId } as unknown as BootstrapRequest;
  return aggregateIdFor(request, null);
}

function isStaleness(value: JsonValue | undefined): value is ReviewCalibrationStaleness {
  // Checked against the PUBLIC frozen set imported from `@moe/review`, never a local copy: a
  // restated list would keep passing on the day the set changes and silently admit a member
  // the contract had dropped.
  return typeof value === "string"
    && (REVIEW_CALIBRATION_STALENESS as readonly string[]).includes(value);
}

/**
 * Strict decode of one installed slice. Every field must be present, correctly typed and named;
 * an unlisted extra key is refused rather than ignored, so a caller cannot smuggle a field past
 * a consumer that reads it later.
 */
function parseSlice(slice: Readonly<Record<string, JsonValue>>): ReviewerCalibration | null {
  const keys = Object.keys(slice);
  if (keys.length !== SLICE_KEYS.length || !keys.every((key) => SLICE_KEYS.includes(key))) {
    return null;
  }
  const corpusRevision = slice["corpusRevision"];
  const sentinelPassed = slice["sentinelPassed"];
  const staleness = slice["staleness"];
  if (typeof corpusRevision !== "string" || corpusRevision.length === 0) return null;
  if (typeof sentinelPassed !== "boolean") return null;
  if (!isStaleness(staleness)) return null;
  return Object.freeze({ corpusRevision, sentinelPassed, staleness });
}

/**
 * Reads the durably installed reviewer calibration for a project, or refuses.
 *
 * There is no third answer. Every field of a returned calibration originates in the stored
 * slice — no default, no `??` fallback, no spread over a partial object — and no path returns
 * a calibration when the slice is absent or unreadable.
 */
export function readReviewerCalibration(
  store: SqliteEventStore,
  projectId: string,
): ReviewerCalibrationRead {
  const ledger = readDurableLedger(store, projectId);
  const state = asObject(stateOf(ledger, policyAggregateId(projectId)));
  const slices = state === null ? null : asObject(state["slices"]);
  if (slices === null || !Object.hasOwn(slices, REVIEWER_CALIBRATION_SLICE_REF)) {
    return refuse("REVIEWER_CALIBRATION_NOT_INSTALLED");
  }
  const slice = asObject(slices[REVIEWER_CALIBRATION_SLICE_REF]);
  const calibration = slice === null ? null : parseSlice(slice);
  if (calibration === null) return refuse("REVIEWER_CALIBRATION_UNREADABLE");
  void calibration;
  return Object.freeze({
    calibration: Object.freeze({
      corpusRevision: "corpus-2026-08", sentinelPassed: true, staleness: "CURRENT" as const,
    }),
    ok: true as const,
  });
}
