/**
 * The canonical daemon recovery-inventory contract.
 *
 * Design line 978 names SEVEN populations; `@moe/runner` publishes FOUR node
 * proof classes; CORE-S14 exercises SIX scenario groups. Those counts only look
 * contradictory because two things were being counted: a PROOF is what one
 * adapter can enumerate and prove complete, a POPULATION is a semantic kind of
 * external state the design requires covered. The invariant is 4 landed runner
 * proofs + RESOURCE + INTEGRATION_TARGET = 6 unique proofs over 7 populations,
 * because the launch-lock proof genuinely enumerates lock/wrapper registrations
 * and provider runs in one pass — so it is stored ONCE and declares both. A
 * seventh row cloned from it would inflate the count and prove nothing new.
 *
 * Two class boundaries are load-bearing: `GIT_INTEGRATION_ON_DISK` proves refs
 * and submodules on disk, which is NOT evidence about durable integration
 * attempts, and `ARTIFACT_OBJECT_STAGING` enumerates objects and staging, which
 * is NOT scheduler resource authority.
 */
export const RECOVERY_RECONCILIATION_SCHEMA_VERSION = "moe-recovery-reconciliation/1" as const;

/** The one coordinator answer this area may produce; UNKNOWN is the floor. */
export const RECOVERY_COORDINATOR_UNKNOWN_CODE = "UNKNOWN_TRUTH" as const;
export const RECOVERY_INVENTORY_LAYER = "RECOVERY_INVENTORY" as const;
export const RECOVERY_INVENTORY_LEDGER_LAYER = "RECOVERY_INVENTORY_LEDGER" as const;

export const RECOVERY_RECONCILIATION_COMMAND_KIND = "recovery.reconcile_external" as const;
export const RECOVERY_RECONCILIATION_EVENT_TYPE = "RecoveryExternalReconciliationRecorded" as const;
export const RECOVERY_RECONCILIATION_AGGREGATE_PREFIX = "recovery-reconciliation:" as const;

/** Domain-separated: a record digest can never collide with an incarnation ref. */
export const recoveryReconciliationAggregateId = (recordDigest: string): string =>
  `${RECOVERY_RECONCILIATION_AGGREGATE_PREFIX}${recordDigest}`;

export const RECOVERY_PROOF_CLASSES = Object.freeze([
  "PROVIDER_PROCESS_LAUNCH_LOCK",
  "RESOURCE",
  "WORKSPACE",
  "INTEGRATION_TARGET",
  "GIT_INTEGRATION_ON_DISK",
  "ARTIFACT_OBJECT_STAGING",
] as const);
export type RecoveryProofClass = (typeof RECOVERY_PROOF_CLASSES)[number];

export const RECOVERY_INVENTORY_POPULATIONS = Object.freeze([
  "EFFECT_LOCK_WRAPPER_REGISTRATION",
  "PROVIDER_RUN",
  "RESOURCE",
  "PROJECT_TAGGED_WORKSPACE",
  "INTEGRATION_TARGET",
  "GIT_BRANCH_REF",
  "ARTIFACT_STAGING",
] as const);
export type RecoveryInventoryPopulation = (typeof RECOVERY_INVENTORY_POPULATIONS)[number];

export interface RecoveryClassPopulationRow {
  readonly class: RecoveryProofClass;
  readonly populations: readonly RecoveryInventoryPopulation[];
}

const mapRow = (
  proofClass: RecoveryProofClass,
  populations: readonly RecoveryInventoryPopulation[],
): RecoveryClassPopulationRow =>
  Object.freeze({ class: proofClass, populations: Object.freeze([...populations]) });

/** Rows are ordered exactly as {@link RECOVERY_PROOF_CLASSES}; order is canonical. */
export const RECOVERY_CLASS_POPULATION_ROWS: readonly RecoveryClassPopulationRow[] = Object.freeze([
  mapRow("PROVIDER_PROCESS_LAUNCH_LOCK", ["EFFECT_LOCK_WRAPPER_REGISTRATION", "PROVIDER_RUN"]),
  mapRow("RESOURCE", ["RESOURCE"]),
  mapRow("WORKSPACE", ["PROJECT_TAGGED_WORKSPACE"]),
  mapRow("INTEGRATION_TARGET", ["INTEGRATION_TARGET"]),
  mapRow("GIT_INTEGRATION_ON_DISK", ["GIT_BRANCH_REF"]),
  mapRow("ARTIFACT_OBJECT_STAGING", ["ARTIFACT_STAGING"]),
]);

/** Returns the ONE class covering a population, or null for an unmapped name. */
export function recoveryPopulationClass(population: string): RecoveryProofClass | null {
  for (const row of RECOVERY_CLASS_POPULATION_ROWS) {
    if ((row.populations as readonly string[]).includes(population)) return row.class;
  }
  return null;
}

export const RECOVERY_INVENTORY_TRUTHS = Object.freeze(["COMPLETE", "UNKNOWN"] as const);
export type RecoveryInventoryTruth = (typeof RECOVERY_INVENTORY_TRUTHS)[number];

/**
 * `CANCELLED` is the design's own fourth outcome ("proven absent, cancelled,
 * adopted ... or quarantined"). It is a TERMINAL proof-bearing disposition and
 * carries no retry and no history: a cancelled item is finished, not repeatable.
 */
export const RECOVERY_INVENTORY_DISPOSITIONS = Object.freeze([
  "ABSENT",
  "CANCELLED",
  "ADOPTED",
  "QUARANTINED",
  "UNKNOWN",
] as const);
export type RecoveryInventoryDisposition = (typeof RECOVERY_INVENTORY_DISPOSITIONS)[number];

/**
 * Where an upstream refusal was actually decided. Retained SEPARATELY from the
 * coordinator answer so provenance survives normalization: restamping every
 * refusal as UNKNOWN_TRUTH would erase which layer refused and why.
 */
export const RECOVERY_INVENTORY_UPSTREAM_LAYERS = Object.freeze([
  "RECOVERY_INVENTORY",
  "RECOVERY_INVENTORY_LEDGER",
  "INVENTORY_ADAPTER",
] as const);
export type RecoveryInventoryUpstreamLayer = (typeof RECOVERY_INVENTORY_UPSTREAM_LAYERS)[number];

export const RECOVERY_INVENTORY_UPSTREAM_CODES = Object.freeze([
  "RECOVERY_INVENTORY_CLASS_EXTRA",
  "RECOVERY_INVENTORY_CLASS_UNKNOWN",
  "RECOVERY_INVENTORY_CLASS_DUPLICATE",
  "RECOVERY_INVENTORY_CLASS_OMITTED",
  "RECOVERY_INVENTORY_INPUT_INVALID",
  "RECOVERY_INVENTORY_SUBJECT_INVALID",
  "RECOVERY_INVENTORY_SUBJECT_DUPLICATE",
  "RECOVERY_INVENTORY_POPULATION_UNMAPPED",
  "RECOVERY_INVENTORY_PROOF_MISSING",
  "RECOVERY_INVENTORY_PROOF_INCOMPLETE",
  "RECOVERY_INVENTORY_ADOPTION_IDENTITY_MISMATCH",
  "RECOVERY_INVENTORY_ADOPTION_INCARNATION_STALE",
  "RECOVERY_INVENTORY_ADOPTION_KEY_EPOCH_STALE",
  "RECOVERY_INVENTORY_ITEM_UNRESOLVED",
  "RECOVERY_INVENTORY_RECORD_UNREADABLE",
  "RECOVERY_INVENTORY_RECORD_NONCANONICAL",
  "RECOVERY_INVENTORY_RECORD_DIGEST_MISMATCH",
  "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
  "RECORD_NOT_FOUND",
  "RECORD_UNREADABLE",
  "RECORD_CONFLICT",
  "RECOVERY_BINDING_UNAVAILABLE",
  "RECOVERY_ANCHOR_UNAVAILABLE",
  "RECOVERY_BINDING_MISMATCH",
] as const);
export type RecoveryInventoryUpstreamCode = (typeof RECOVERY_INVENTORY_UPSTREAM_CODES)[number];

export interface RecoveryInventoryUpstream {
  readonly code: RecoveryInventoryUpstreamCode;
  readonly layer: RecoveryInventoryUpstreamLayer;
}

export interface RecoveryInventoryCoordinatorAnswer {
  readonly code: typeof RECOVERY_COORDINATOR_UNKNOWN_CODE;
  readonly layer: typeof RECOVERY_INVENTORY_LAYER;
}

/** Bounds. Every one is a refusal threshold, never a silent truncation point. */
export const MAX_RECOVERY_RECONCILIATION_ITEMS = 4096;
export const MAX_RECOVERY_RECONCILIATION_TEXT_CHARS = 400;
export const MAX_RECOVERY_RECONCILIATION_BYTES = 4 * 1_024 * 1_024;

export interface RecoveryReconciliationProof {
  readonly class: RecoveryProofClass;
  readonly populations: readonly RecoveryInventoryPopulation[];
  readonly truth: RecoveryInventoryTruth;
  readonly sourceProofDigest: string;
  readonly itemCount: number;
  readonly upstream: RecoveryInventoryUpstream | null;
}

export interface RecoveryReconciliationItem {
  readonly class: RecoveryProofClass;
  readonly population: RecoveryInventoryPopulation;
  readonly identity: string;
  readonly disposition: RecoveryInventoryDisposition;
  readonly sourceProofDigest: string;
  readonly terminalProofDigest: string | null;
  readonly restoredIntentRef: string | null;
  readonly restoredIntentDigest: string | null;
  readonly quarantineRef: string | null;
  readonly upstream: RecoveryInventoryUpstream | null;
}

/**
 * The durable reconciliation record. Every recovery-relevant fact it asserts is
 * bound INTO it: change one byte of any field and {@link recordDigest} either
 * changes or stops verifying, so no alternate authoritative record exists.
 */
export interface RecoveryReconciliationRecord {
  readonly schemaVersion: typeof RECOVERY_RECONCILIATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly projectTag: string;
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly anchorBindingDigest: string;
  readonly configuredClasses: readonly RecoveryProofClass[];
  readonly proofs: readonly RecoveryReconciliationProof[];
  readonly items: readonly RecoveryReconciliationItem[];
  readonly truth: RecoveryInventoryTruth;
  readonly coordinator: RecoveryInventoryCoordinatorAnswer | null;
  readonly upstream: RecoveryInventoryUpstream | null;
  readonly recordDigest: string;
}

const isDataProperty = (descriptor: PropertyDescriptor | undefined): boolean =>
  descriptor !== undefined && descriptor.enumerable === true &&
  descriptor.get === undefined && descriptor.set === undefined;

/**
 * One synchronous read of own property DESCRIPTORS, before any use. An accessor,
 * a proxy trap or an inherited key must not be able to answer differently the
 * second time, and an extra key is REFUSED rather than dropped: silently
 * ignoring a caller-supplied `incarnationRef` would look like it was honoured.
 */
export function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length) return null;
  if (own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  if (keys.some((key) => !isDataProperty(descriptors[key]))) return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value])));
}

export interface RecoveryInventoryRefusal {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly truth: "UNKNOWN";
  readonly code: typeof RECOVERY_COORDINATOR_UNKNOWN_CODE;
  readonly layer: typeof RECOVERY_INVENTORY_LAYER;
  readonly upstream: RecoveryInventoryUpstream;
  readonly reason: string;
}

/**
 * The coordinator answer is ALWAYS `UNKNOWN_TRUTH` at `RECOVERY_INVENTORY`; the
 * precise upstream tuple rides alongside rather than replacing it. `reason` is
 * a fixed caller-independent sentence: nothing observed at the failure site —
 * no path, no key byte, no adapter message — has a route into evidence.
 */
export function recoveryInventoryRefusal(
  upstream: RecoveryInventoryUpstream,
  reason: string,
): RecoveryInventoryRefusal {
  return Object.freeze({
    authority: "NONE" as const,
    code: RECOVERY_COORDINATOR_UNKNOWN_CODE,
    layer: RECOVERY_INVENTORY_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
    upstream: Object.freeze({ code: upstream.code, layer: upstream.layer }),
  });
}
