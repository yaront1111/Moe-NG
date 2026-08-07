import { createHash } from "node:crypto";

import { canonicalize } from "../canonical-json.js";

/** Manifest and identity versions are data, not behaviour: bump them when the shapes change. */
export const SCHEDULE_COVERAGE_MANIFEST_VERSION = "moe-schedule-coverage/1" as const;
export const SCHEDULE_CANONICAL_FORM_VERSION = "moe-schedule-identity/1" as const;
export const SCHEDULE_STRATUM_MINIMA_VERSION = "moe-schedule-strata/1" as const;

/** Release bar from design 20.4; recorded as an unasserted UNKNOWN field, never a gate. */
export const RELEASE_SCHEDULE_FLOOR = 10_000 as const;

/** Schedule labels are volatile, so identity carries a placeholder in their place. */
export const SCHEDULE_IDENTITY_PLACEHOLDER = "[schedule]" as const;

export const SCHEDULE_CODES = Object.freeze([
  "SCHEDULE_AGGREGATE_UNLANDED",
  "SCHEDULE_EVIDENCE_ABSENT",
  "SCHEDULE_FAULT_BOUNDARY_UNREGISTERED",
  "SCHEDULE_IDENTITY_DUPLICATE",
  "SCHEDULE_OBLIGATION_UNMAPPED",
  "SCHEDULE_STRATUM_MINIMUM_UNMET",
  "SCHEDULE_TRANSITION_UNREACHABLE",
  "SCHEDULE_UNIVERSE_UNCOVERED",
] as const);

export type ScheduleCode = (typeof SCHEDULE_CODES)[number];
export type ScheduleVerdict = "FAIL" | "PASS" | "UNKNOWN";
export type ScheduleStratum = "MULTI_EVENT" | "TWO_EVENT";
export type ScheduleObligationKind = "INVARIANT" | "SCENARIO";

export interface TransitionRef {
  readonly aggregate: string;
  readonly commandKind: string;
  readonly fromState: string;
  readonly toState: string;
}

/** Unordered two-command race legal in one aggregate state; identity sorts the pair. */
export interface RacePairRef {
  readonly aggregate: string;
  readonly commandKinds: readonly string[];
  readonly fromState: string;
}

export interface TransitionEdge {
  readonly commandKind: string;
  readonly fromState: string;
  readonly toState: string;
}

export interface AggregateTransitionTable {
  readonly aggregate: string;
  readonly edges: readonly TransitionEdge[];
}

/** Excluded from identity: random ids, wall timestamps, seed labels (design 20.4). */
export interface ScheduleVolatileLabels {
  readonly instanceIds?: readonly string[];
  readonly recordedAt?: string;
  readonly seedLabel?: string;
}

export interface ScheduleIdentityInput {
  readonly faultBoundaryRefs: readonly string[];
  readonly labels?: ScheduleVolatileLabels;
  readonly racePairRefs: readonly RacePairRef[];
  readonly scheduleId: string;
  readonly stratum: ScheduleStratum;
  readonly transitionRefs: readonly TransitionRef[];
}

export interface ScheduleDefinition extends ScheduleIdentityInput {
  readonly obligationRefs: readonly string[];
}

export interface CanonicalScheduleForm {
  readonly faultBoundaryRefs: readonly string[];
  readonly formVersion: typeof SCHEDULE_CANONICAL_FORM_VERSION;
  readonly racePairRefs: readonly RacePairRef[];
  readonly scheduleId: typeof SCHEDULE_IDENTITY_PLACEHOLDER;
  readonly stratum: ScheduleStratum;
  readonly transitionRefs: readonly TransitionRef[];
}

export interface ScheduleStratumMinimum {
  readonly applicability: "APPLICABLE_WHEN_DECLARED" | "MANDATORY";
  readonly minimumFaultBoundaryRefs: number;
  readonly minimumRacePairRefs: number;
  readonly minimumSchedules: number;
  readonly minimumTransitionRefs: number;
}

/** Frozen per-stratum minima (design 20.4): mandatory two-event, applicable partial orders. */
export const SCHEDULE_STRATUM_MINIMA: Readonly<Record<ScheduleStratum, ScheduleStratumMinimum>> =
  Object.freeze({
    MULTI_EVENT: Object.freeze({
      applicability: "APPLICABLE_WHEN_DECLARED" as const,
      minimumFaultBoundaryRefs: 1,
      minimumRacePairRefs: 1,
      minimumSchedules: 1,
      minimumTransitionRefs: 2,
    }),
    TWO_EVENT: Object.freeze({
      applicability: "MANDATORY" as const,
      minimumFaultBoundaryRefs: 1,
      minimumRacePairRefs: 1,
      minimumSchedules: 1,
      minimumTransitionRefs: 1,
    }),
  });

export interface ScheduleObligation {
  readonly applicableStrata: readonly ScheduleStratum[];
  readonly designAnchors: readonly string[];
  readonly kind: ScheduleObligationKind;
  readonly obligationId: string;
  readonly title: string;
}

export interface ScheduleHitEvidence {
  readonly evidenceRef: string;
  readonly scheduleIdentity: string;
}

export interface ScheduleFinding {
  readonly code: ScheduleCode;
  readonly detail: string;
  readonly obligationId: string | null;
  readonly verdict: "FAIL" | "UNKNOWN";
}

export interface ObligationCoverage {
  readonly evidenceRefs: readonly string[];
  readonly kind: ScheduleObligationKind;
  readonly obligationId: string;
  readonly reachableTransitionRefs: readonly TransitionRef[];
  readonly reasonCodes: readonly ScheduleCode[];
  readonly scheduleIdentities: readonly string[];
  readonly strata: readonly ScheduleStratum[];
  readonly verdict: ScheduleVerdict;
}

export interface ScheduleRecord {
  readonly identity: string;
  readonly obligationRefs: readonly string[];
  readonly scheduleId: string;
  readonly stratum: ScheduleStratum;
}

export interface DerivedScheduleUniverse {
  readonly faultBoundaries: readonly string[];
  readonly racePairs: readonly RacePairRef[];
  readonly transitions: readonly TransitionRef[];
}

export interface ScheduleCoverageInput {
  readonly faultBoundaries: readonly string[];
  readonly hitEvidence: readonly ScheduleHitEvidence[];
  readonly knownAggregates: readonly string[];
  readonly obligations: readonly ScheduleObligation[];
  readonly transitionTables: readonly AggregateTransitionTable[];
  readonly universe: readonly ScheduleDefinition[];
}

/** CORE is the engineering namespace and never mints confirmatory corpus identifiers. */
export interface ScheduleProvenance {
  readonly classification: "DEVELOPMENT_ONLY_ENGINEERING_EVIDENCE";
  readonly confirmatory: false;
}

export interface ScheduleReleaseBar {
  readonly floor: typeof RELEASE_SCHEDULE_FLOOR;
  readonly observedUniqueSchedules: number;
  readonly status: "UNKNOWN";
}

export interface ScheduleCoverageManifest {
  readonly canonicalFormVersion: typeof SCHEDULE_CANONICAL_FORM_VERSION;
  readonly digest: string;
  readonly findings: readonly ScheduleFinding[];
  readonly manifestVersion: typeof SCHEDULE_COVERAGE_MANIFEST_VERSION;
  readonly obligations: readonly ObligationCoverage[];
  readonly provenance: ScheduleProvenance;
  readonly releaseBar: ScheduleReleaseBar;
  readonly schedules: readonly ScheduleRecord[];
  readonly strataMinima: Readonly<Record<ScheduleStratum, ScheduleStratumMinimum>>;
  readonly strataMinimaVersion: typeof SCHEDULE_STRATUM_MINIMA_VERSION;
  readonly universe: DerivedScheduleUniverse;
  readonly verdict: ScheduleVerdict;
}

export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function transitionKey(ref: TransitionRef): string {
  return [ref.aggregate, ref.fromState, ref.commandKind, ref.toState].join("|");
}

export function racePairKey(ref: RacePairRef): string {
  return [ref.aggregate, ref.fromState, ...[...ref.commandKinds].sort(compareText)].join("|");
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function uniqueSortedBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    byKey.set(key(item), item);
  }
  return [...byKey.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([, item]) => item);
}

function canonicalTransition(ref: TransitionRef): TransitionRef {
  return {
    aggregate: ref.aggregate,
    commandKind: ref.commandKind,
    fromState: ref.fromState,
    toState: ref.toState,
  };
}

function canonicalRacePair(ref: RacePairRef): RacePairRef {
  return {
    aggregate: ref.aggregate,
    commandKinds: [...ref.commandKinds].sort(compareText),
    fromState: ref.fromState,
  };
}

/** Canonical form: sorted ref sets, placeholder id, no labels — identity ignores noise. */
export function canonicalScheduleForm(definition: ScheduleIdentityInput): CanonicalScheduleForm {
  return {
    faultBoundaryRefs: sortedUnique(definition.faultBoundaryRefs),
    formVersion: SCHEDULE_CANONICAL_FORM_VERSION,
    racePairRefs: uniqueSortedBy(definition.racePairRefs.map(canonicalRacePair), racePairKey),
    scheduleId: SCHEDULE_IDENTITY_PLACEHOLDER,
    stratum: definition.stratum,
    transitionRefs: uniqueSortedBy(definition.transitionRefs.map(canonicalTransition), transitionKey),
  };
}

export function canonicalScheduleText(definition: ScheduleIdentityInput): string {
  return canonicalize(canonicalScheduleForm(definition));
}

export function scheduleIdentity(definition: ScheduleIdentityInput): string {
  return createHash("sha256").update(canonicalScheduleText(definition), "utf8").digest("hex");
}
