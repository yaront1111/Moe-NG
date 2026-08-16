/**
 * The plain-data shapes this harness projects, and the version seam that admits them.
 *
 * WHY THESE ARE DECLARED HERE RATHER THAN IMPORTED. The records projected by this
 * package are `ProviderRunRecord`s composed in `apps/daemon`. A package cannot import
 * from an app, so the type cannot be taken by reference. The records therefore arrive as
 * BOUNDED PLAIN DATA — already decoded, already sealed by the daemon's codec — and this
 * module declares the shape it is willing to read.
 *
 * THIS IS THE OPPOSITE OF THE DAEMON'S RULE, DELIBERATELY. The daemon's contract module
 * types every field from its producing package's public root, because the daemon WRITES
 * durable bytes and a silent producer drift there is uncorrectable after the fact. This
 * package only READS bytes that are already durable. A drift it failed to notice would
 * not corrupt anything; it would merely project a shape it no longer understands, which
 * is what `PROJECTED_RECORD_VERSION` exists to prevent.
 *
 * THE VERSION LITERAL IS THE SEAM. It is declared here as its own literal rather than
 * imported, and admission refuses every other value. When the record schema moves, this
 * package REDDENS instead of quietly projecting the old shape onto new bytes.
 *
 * CLOSED VOCABULARIES ARE TYPED AS `string` ON PURPOSE. `terminal`, `infrastructure`,
 * `coverage`, `truthClass` and the refusal codes are frozen enums owned by @moe/runner
 * and @moe/scheduler. Re-listing their members here would create a second vocabulary for
 * one condition, and this package would then be entitled to an opinion about which
 * members are valid — an opinion the daemon's codec already formed when it sealed the
 * record. The harness carries these through verbatim and adjudicates none of them.
 */

/** Pinned against the daemon's `PROVIDER_RUN_RECORD_VERSION`. Any other value is refused. */
export const PROJECTED_RECORD_VERSION = "moe-provider-run-record/1" as const;

/**
 * An unobserved fact, carrying the code and layer of whichever authority could not
 * observe it. Never collapsed to `null` and never rendered as a zero.
 */
export interface ProjectedFactUnknown {
  readonly known: false;
  readonly code: string;
  readonly layer: string;
}
export type ProjectedQuantity = { readonly known: true; readonly value: number } | ProjectedFactUnknown;
export type ProjectedText = { readonly known: true; readonly value: string } | ProjectedFactUnknown;

/** Run, effect and attempt identity, carried whole. Never three hand-rolled ids. */
export interface ProjectedRunRef {
  readonly provider: string;
  readonly runRef: string;
  readonly effectIntentId: string;
  readonly attemptRef: string;
  readonly epoch: number;
}

/**
 * The LAUNCHER's own facts: the runtime and profile digests that make a run
 * reproducible, plus its own wall stamps. `startedAt`/`completedAt` are the launcher's
 * clock and are never reconciled against the daemon's `ClockObservation` pair.
 */
export interface ProjectedLaunchFacts {
  readonly kind: string;
  readonly truthClass: string;
  readonly reasonCode: string | null;
  readonly reasonLayer: string | null;
  readonly effectDigest: string | null;
  readonly activationDigest: string | null;
  readonly runtimeBindingDigest: string | null;
  readonly quotedRuntimeDigest: string | null;
  readonly freshRuntimeDigest: string | null;
  readonly pinnedClosureDigest: string | null;
  readonly observationDigest: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** What was ASKED FOR. The only place reasoning effort and profile revision exist. */
export interface ProjectedLaunchSelection {
  readonly provider: string;
  readonly selectedModelId: string;
  readonly modelSnapshotKind: string;
  readonly modelSnapshotEvidence: string;
  readonly reasoningEffort: string;
  readonly profileRevisionId: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly orchestrationDigest: string;
  readonly concurrencyCeiling: number;
}
export type ProjectedDeclaredSelection =
  | { readonly known: true; readonly selection: ProjectedLaunchSelection }
  | ProjectedFactUnknown;

/** What the provider's own bytes SAID. Never defaulted from `declared`. */
export interface ProjectedObservedModel {
  readonly modelId: ProjectedText;
  readonly snapshotKind: string;
  readonly snapshotEvidence: ProjectedText;
}

export interface ProjectedTokenObservations {
  readonly inputTokens: ProjectedQuantity;
  readonly outputTokens: ProjectedQuantity;
  readonly cacheCreationInputTokens: ProjectedQuantity;
  readonly cacheReadInputTokens: ProjectedQuantity;
  readonly coverage: string;
}
export interface ProjectedStepObservations {
  readonly turns: ProjectedQuantity;
  readonly coverage: string;
}
export interface ProjectedConcurrency {
  readonly fact: string;
  readonly declaredCeiling: ProjectedQuantity;
  readonly achieved: ProjectedQuantity;
}

/**
 * The DAEMON's own clock reading: wall seconds, boot identity and monotonic reading
 * bound together. A monotonic reading is comparable only against another from the same
 * boot, so a duration derived from a pair whose `bootId`s differ is unfalsifiable.
 */
export interface ProjectedClockObservation {
  readonly serverWallSeconds: number;
  readonly bootId: string;
  readonly monotonicObservation: number;
}

/** A derived price is meaningful only against the revision it was read from. */
export interface ProjectedPricebookBinding {
  readonly pricebookRevisionRef: string;
  readonly unitPriceMicros: number;
  readonly pricedAtRef: string;
}
export interface ProjectedMeasurementRecord {
  readonly meter: string;
  readonly quantity: number | null;
  readonly coverage: string;
  readonly source: string;
  readonly providerRunRef: string;
  readonly sourceParserVersion: number;
  readonly sequence: number;
  readonly rawReceiptDigest: string;
}
/** One accepted usage envelope, carrying its own cost BASIS — never a cost claim. */
export interface ProjectedUsageRow {
  readonly measurement: ProjectedMeasurementRecord;
  readonly pricebookBinding: ProjectedPricebookBinding | null;
  readonly truncated: boolean;
  readonly identity: string;
}

/** One layered issue, verbatim: which authority refused and under which code. */
export interface ProjectedLayeredIssue {
  readonly layer: string;
  readonly code: string;
  readonly message: string;
}
/** An envelope the SCHEDULER refused, kept rather than dropped. */
export interface ProjectedUsageRefusal {
  readonly providerSequence: number;
  readonly issues: readonly ProjectedLayeredIssue[];
}
/** The PROVIDER seam's refusal, disjoint from every scheduler issue above. */
export interface ProjectedUpstreamRefusal {
  readonly ok: false;
  readonly code: string;
  readonly layer: string;
  readonly message: string;
}

/**
 * One durable provider-run record as this harness reads it.
 *
 * `observedStart`/`observedEnd` are the daemon's readings and are DISTINCT from
 * `launch.startedAt`/`launch.completedAt`. Two observers, deliberately not reconciled:
 * reconciling them would mean overwriting one with the other, and the record would then
 * no longer say which clock was read. `null` is an unobserved reading, never a zero.
 */
export interface ProjectedRunRecord {
  readonly recordVersion: typeof PROJECTED_RECORD_VERSION;
  readonly providerRunRef: ProjectedRunRef;
  readonly launch: ProjectedLaunchFacts;
  readonly declared: ProjectedDeclaredSelection;
  readonly observedModel: ProjectedObservedModel;
  readonly terminal: string;
  readonly infrastructure: string;
  readonly tokens: ProjectedTokenObservations;
  readonly steps: ProjectedStepObservations;
  readonly sequence: ProjectedQuantity;
  readonly concurrency: ProjectedConcurrency;
  readonly observedStart: ProjectedClockObservation | null;
  readonly observedEnd: ProjectedClockObservation | null;
  readonly usage: readonly ProjectedUsageRow[];
  readonly usageRefusals: readonly ProjectedUsageRefusal[];
  readonly upstreamRefusal: ProjectedUpstreamRefusal | null;
  readonly stdoutReceiptDigest: ProjectedText;
  readonly stderrReceiptDigest: ProjectedText;
  readonly recordDigest: string;
}

/**
 * Every top-level key admission requires. Frozen and iterable so a sweep can drive one
 * absent key per case at runtime; a type could not be walked to generate them.
 */
export const PROJECTED_RECORD_KEYS = Object.freeze([
  "recordVersion", "providerRunRef", "launch", "declared", "observedModel", "terminal",
  "infrastructure", "tokens", "steps", "sequence", "concurrency", "observedStart",
  "observedEnd", "usage", "usageRefusals", "upstreamRefusal", "stdoutReceiptDigest",
  "stderrReceiptDigest", "recordDigest",
] as const);
export type ProjectedRecordKey = (typeof PROJECTED_RECORD_KEYS)[number];
