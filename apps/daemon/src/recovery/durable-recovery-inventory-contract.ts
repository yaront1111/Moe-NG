import { createHash } from "node:crypto";

import type { AcquisitionState } from "@moe/scheduler";

import {
  RECOVERY_INVENTORY_UPSTREAM_CODES,
  recoveryInventoryRefusal,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryTruth,
  RecoveryInventoryUpstream,
} from "./recovery-inventory-contract.js";

/**
 * The durable half of the recovery inventory, for the two populations no node
 * adapter can enumerate. `@moe/runner` freezes its collector to four node
 * classes and cannot represent either of these, so this is the daemon-side
 * typed bridge the task allows instead of widening a closed vocabulary. Nothing
 * here decides adoption, quarantine, signing authority or `recovery.complete`;
 * every refusal reuses an already-admitted upstream code and stays
 * coordinator-UNKNOWN at `INVENTORY_ADAPTER`. Hostile-input readers live in
 * `./durable-recovery-inventory-shape.ts` to hold the per-file target.
 */
export const DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION = "moe-durable-recovery-inventory/1" as const;
export const DURABLE_INVENTORY_ADAPTER_LAYER = "INVENTORY_ADAPTER" as const;
export const DURABLE_INVENTORY_COMMAND_KIND = "recovery.record_durable_inventory" as const;
export const DURABLE_INVENTORY_ROW_EVENT_TYPE = "RecoveryDurableInventoryRowRecorded" as const;
export const DURABLE_INVENTORY_SEAL_EVENT_TYPE = "RecoveryDurableInventoryWindowSealed" as const;
export const DURABLE_INVENTORY_AGGREGATE_PREFIX = "recovery-durable-inventory:" as const;

/** Ordered exactly as the daemon's frozen proof classes order them. */
export const DURABLE_RECOVERY_INVENTORY_CLASSES = Object.freeze([
  "RESOURCE",
  "INTEGRATION_TARGET",
] as const);
export type DurableRecoveryInventoryClass = (typeof DURABLE_RECOVERY_INVENTORY_CLASSES)[number];

export const DURABLE_RESOURCE_FENCEABILITIES = Object.freeze([
  "FENCEABLE",
  "NON_FENCEABLE",
] as const);
export type DurableResourceFenceability = (typeof DURABLE_RESOURCE_FENCEABILITIES)[number];

/** Snapshotted, never re-derived: scheduler owns these transitions. */
export const DURABLE_RESOURCE_STATES = Object.freeze([
  "ACTIVE",
  "PENDING_ACQUIRE",
  "QUARANTINED",
  "RELEASED",
] as const);

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/**
 * Compile-time set equality against `@moe/scheduler`, both directions. A state
 * added or removed upstream turns this type `false` and reddens daemon
 * typecheck, instead of silently making a snapshot unrepresentable.
 */
export const DURABLE_RESOURCE_STATES_MATCH_SCHEDULER: Exact<
  AcquisitionState,
  (typeof DURABLE_RESOURCE_STATES)[number]
> = true;

export const DURABLE_INVENTORY_CURSOR_DIGITS = 21;
export const MAX_DURABLE_INVENTORY_ROWS = 4096;
export const MAX_DURABLE_INVENTORY_TEXT_CHARS = 400;
export const MAX_DURABLE_INVENTORY_BYTES = 1024 * 1024;
export const MAX_DURABLE_INVENTORY_COUNT = 2 ** 32;

export interface DurableInventoryBasis {
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly projectTag: string;
}

/** Start EXCLUDED, end INCLUDED: a window is `(backupCursor, endInclusive]`. */
export interface DurableInventoryWindow {
  readonly endInclusive: string;
  readonly startExclusive: string;
}

/** Read from the store and the anchor. Never accepted from a caller. */
export interface DurableInventorySelectedScope {
  readonly anchorBindingDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly projectId: string;
}

export interface DurableResourceObservation {
  readonly capacityUnits: number;
  readonly class: "RESOURCE";
  readonly effectIntentRef: string;
  readonly epoch: number;
  readonly external: boolean;
  readonly fenceability: DurableResourceFenceability;
  readonly observedPosition: string;
  readonly resourceId: string;
  readonly sourceProofDigest: string;
  readonly state: AcquisitionState;
}

export interface DurableIntegrationObservation {
  readonly attemptRef: string;
  readonly class: "INTEGRATION_TARGET";
  readonly effectIntentRef: string;
  readonly intentDigest: string;
  readonly observedPosition: string;
  readonly sourceProofDigest: string;
  readonly targetRef: string;
}

export type DurableInventoryObservation =
  | DurableResourceObservation
  | DurableIntegrationObservation;

export interface DurableInventoryClassCoverage {
  readonly class: DurableRecoveryInventoryClass;
  readonly negativeProofDigest: string | null;
  readonly sourceProofDigest: string;
}

export interface DurableInventoryClassSeal {
  readonly class: DurableRecoveryInventoryClass;
  readonly itemCount: number;
  readonly negativeProofDigest: string | null;
  readonly rowDigests: readonly string[];
  readonly sourceProofDigest: string;
  readonly truth: RecoveryInventoryTruth;
}

export interface DurableInventorySeal {
  readonly classes: readonly DurableInventoryClassSeal[];
  readonly scopeDigest: string;
  readonly windowEndInclusive: string;
  readonly windowStartExclusive: string;
}

/** The fragment shape `recordRecoveryReconciliation` already accepts, exactly. */
export interface DurableInventoryProofFragment {
  readonly class: DurableRecoveryInventoryClass;
  readonly sourceProofDigest: string;
  readonly truth: RecoveryInventoryTruth;
  readonly upstream: RecoveryInventoryUpstream | null;
}

const adapter = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: DURABLE_INVENTORY_ADAPTER_LAYER });

/**
 * Every refusal this area can emit, all drawn from the already-admitted closed
 * vocabulary. No new code and no new authority: the coordinator answer stays
 * `UNKNOWN_TRUTH` and only the upstream tuple distinguishes the cases.
 */
export const DURABLE_INVENTORY_REFUSALS = Object.freeze({
  ANCHOR_UNAVAILABLE: recoveryInventoryRefusal(
    adapter("RECOVERY_ANCHOR_UNAVAILABLE"),
    "The selected recovery incarnation has no durable anchor in this project.",
  ),
  BINDING_MISMATCH: recoveryInventoryRefusal(
    adapter("RECOVERY_BINDING_MISMATCH"),
    "The selected recovery authority does not agree with the anchored incarnation.",
  ),
  BINDING_UNAVAILABLE: recoveryInventoryRefusal(
    adapter("RECOVERY_BINDING_UNAVAILABLE"),
    "No installer-selected recovery binding is readable from this project store.",
  ),
  CONFLICT: recoveryInventoryRefusal(
    adapter("RECORD_CONFLICT"),
    "The durable inventory for this window is not a single consistent sealed set.",
  ),
  DUPLICATE: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_SUBJECT_DUPLICATE"),
    "A different observation is already stored under this window identity.",
  ),
  INPUT_INVALID: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_INPUT_INVALID"),
    "The durable inventory request did not present the exact expected shape.",
  ),
  NOT_FOUND: recoveryInventoryRefusal(
    adapter("RECORD_NOT_FOUND"),
    "No sealed durable inventory is stored for this window.",
  ),
  OUT_OF_WINDOW: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_COVERAGE_UNKNOWN"),
    "The observation lies outside the backup cursor window it was offered for.",
  ),
  PROOF_MISSING: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_PROOF_MISSING"),
    "An empty class was offered as complete without a bound negative proof.",
  ),
  UNREADABLE: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_RECORD_UNREADABLE"),
    "The durable bytes stored for this window do not verify as inventory rows.",
  ),
  WINDOW_FULL: recoveryInventoryRefusal(
    adapter("RECOVERY_INVENTORY_COVERAGE_UNKNOWN"),
    "This window already holds its bounded row count and cannot cover another observation.",
  ),
});
export type DurableInventoryRefusal = RecoveryInventoryRefusal;

/**
 * Every code above must already exist in the daemon's closed vocabulary. A typo
 * or an invented code makes this false and takes its own test red, so this area
 * cannot quietly grow a reason nobody upstream can classify.
 */
export const DURABLE_INVENTORY_CODES_ARE_ADMITTED: boolean = Object.values(
  DURABLE_INVENTORY_REFUSALS,
).every((refusal) =>
  (RECOVERY_INVENTORY_UPSTREAM_CODES as readonly string[]).includes(refusal.upstream.code));

/**
 * Recursive code-point key ordering gives ONE byte string per body, so decoding
 * can re-encode and compare bytes: whitespace, key reordering, a duplicate key
 * and a trailing extension all stop being second spellings of one record.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

export function durableInventoryBytes(body: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonical(body)));
}

export function durableInventoryDigest(body: object): string {
  return createHash("sha256").update(durableInventoryBytes(body)).digest("hex");
}

/**
 * The address of one window: project, project tag, backup cursor AND
 * generation, anchored incarnation, key epoch and anchor binding digest. A
 * window sealed under one recovery identity is therefore unreachable from
 * another, rather than being re-answered with.
 */
export function durableInventoryScopeDigest(
  scope: DurableInventorySelectedScope,
  basis: DurableInventoryBasis,
  window: DurableInventoryWindow,
): string {
  return durableInventoryDigest({
    anchorBindingDigest: scope.anchorBindingDigest,
    backupCursor: basis.backupCursor,
    backupGenerationDigest: basis.backupGenerationDigest,
    incarnationRef: scope.incarnationRef,
    keyEpochRef: scope.keyEpochRef,
    projectId: scope.projectId,
    projectTag: basis.projectTag,
    schemaVersion: DURABLE_RECOVERY_INVENTORY_SCHEMA_VERSION,
    windowEndInclusive: window.endInclusive,
    windowStartExclusive: window.startExclusive,
  });
}

/** Domain-separated: a scope digest can never collide with an incarnation ref. */
export const durableInventoryAggregateId = (scopeDigest: string): string =>
  `${DURABLE_INVENTORY_AGGREGATE_PREFIX}${scopeDigest}`;
