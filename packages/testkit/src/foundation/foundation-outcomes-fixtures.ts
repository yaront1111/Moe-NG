/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY foundation expected-outcome vocabulary,
 * falsifiable absence probes, fixture identity, and the versioned manifest
 * builder. The held-out fixture payloads live in `foundation-journey-fixtures`.
 *
 * This is a task-local artifact. It deliberately does NOT reuse the schedule
 * coverage manifest version or its `SCHEDULE_*` codes, and it claims no
 * coverage authority over that checker's source-derived universe: it only
 * records, for each fixture and schedule this task owns, the ONE outcome the
 * fault tests must reproduce.
 *
 * Imports are limited to `@moe/contracts` and the landed testkit hashing
 * helpers. Landed reducers, stores and schedulers arrive through ports the
 * fault tests inject, so no production dependency is created here.
 */

import { CANONICAL_JSON_VERSION } from "../canonical-json.js";
import { EVIDENCE_IDENTITY_VERSION, identifyCanonicalEvidence } from "../evidence-digest.js";
import type { CanonicalEvidenceIdentity } from "../evidence-digest.js";

export const FOUNDATION_EXPECTED_OUTCOME_VERSION = "moe-foundation-expected-outcome/1" as const;
export const FOUNDATION_FIXTURE_IDENTITY_VERSION = "moe-foundation-fixture-identity/1" as const;

export const FOUNDATION_LABELS = Object.freeze({
  confirmatory: "NOT_CONFIRMATORY",
  use: "DEVELOPMENT_ONLY",
} as const);

export const FOUNDATION_JOURNEYS = Object.freeze(["J1", "J3", "J4"] as const);
export type FoundationJourney = (typeof FOUNDATION_JOURNEYS)[number];

/** Closed and sorted. A fifth kind means a new artifact version, not an append. */
export const FOUNDATION_OUTCOME_KINDS = Object.freeze([
  "EXPECTED_RED",
  "HONEST_UNKNOWN",
  "PASS_EXPECTED",
  "PRODUCTION_BEHAVIOR_ABSENT",
] as const);

export type FoundationOutcomeKind = (typeof FOUNDATION_OUTCOME_KINDS)[number];

export type FoundationOutcome =
  | { readonly kind: "EXPECTED_RED"; readonly reason: string }
  | { readonly kind: "HONEST_UNKNOWN"; readonly missingEvidence: string }
  | { readonly kind: "PASS_EXPECTED" }
  | {
    readonly kind: "PRODUCTION_BEHAVIOR_ABSENT";
    readonly missingSurface: string;
    readonly probeRef: string;
  };

export const passExpected = (): FoundationOutcome =>
  Object.freeze({ kind: "PASS_EXPECTED" as const });
export const expectedRed = (reason: string): FoundationOutcome =>
  Object.freeze({ kind: "EXPECTED_RED" as const, reason });
export const honestUnknown = (missingEvidence: string): FoundationOutcome =>
  Object.freeze({ kind: "HONEST_UNKNOWN" as const, missingEvidence });
export const productionBehaviorAbsent = (
  missingSurface: string,
  probeRef: string,
): FoundationOutcome =>
  Object.freeze({ kind: "PRODUCTION_BEHAVIOR_ABSENT" as const, missingSurface, probeRef });

// --- Falsifiable absence probes ---

/**
 * A presence-detecting probe. It is evaluated against the REAL exported names
 * of `packageName`, which the fault tests supply; this module never imports the
 * package. The pattern exists so the probe still fires when the surface lands
 * under a name nobody guessed here — an exact-name-only probe rots quietly.
 */
export interface FoundationAbsenceProbe {
  readonly absentExportNames: readonly string[];
  /** RegExp source, matched case-insensitively, or null when too collision-prone. */
  readonly absentExportPattern: string | null;
  readonly packageName: string;
  readonly probeRef: string;
}

export type FoundationProbeResult =
  | { readonly absent: true }
  | { readonly absent: false; readonly presentExportNames: readonly string[] };

export function evaluateAbsenceProbe(
  probe: FoundationAbsenceProbe,
  exportNames: readonly string[],
): FoundationProbeResult {
  const named = new Set(probe.absentExportNames);
  const pattern = probe.absentExportPattern === null
    ? null
    : new RegExp(probe.absentExportPattern, "iu");
  const present = exportNames.filter((name) => named.has(name) || pattern?.test(name) === true);
  return present.length === 0
    ? Object.freeze({ absent: true as const })
    : Object.freeze({ absent: false as const, presentExportNames: Object.freeze([...present]) });
}

// --- Fixtures ---

export interface FoundationFixture {
  readonly fixtureId: string;
  readonly journey: FoundationJourney;
  readonly labels: typeof FOUNDATION_LABELS;
  readonly outcome: FoundationOutcome;
  /** sha256 of the canonical identity below, pinned so drift is loud. */
  readonly pinnedDigest: string;
  readonly payload: unknown;
}

/**
 * Identity covers exactly the meaning of a fixture. `pinnedDigest` is excluded
 * (it is the output) and so is any volatile label a caller attaches — random
 * ids, wall timestamps and seeds must not change a fixture's identity.
 */
export function identifyFoundationFixture(fixture: FoundationFixture): CanonicalEvidenceIdentity {
  return identifyCanonicalEvidence({
    fixtureId: fixture.fixtureId,
    identityVersion: FOUNDATION_FIXTURE_IDENTITY_VERSION,
    journey: fixture.journey,
    labels: { ...FOUNDATION_LABELS },
    outcome: { ...fixture.outcome },
    payload: fixture.payload,
  });
}

// --- Schedules and manifest ---

export interface FoundationSchedule {
  readonly declared: FoundationOutcome;
  readonly journey: FoundationJourney;
  readonly scheduleId: string;
  readonly title: string;
}

export interface FoundationManifestEntry {
  readonly digest: string;
  readonly entryId: string;
  readonly entryKind: "FIXTURE" | "SCHEDULE";
  readonly journey: FoundationJourney;
  readonly outcome: FoundationOutcome;
}

export interface FoundationManifest {
  readonly canonicalizerVersion: typeof CANONICAL_JSON_VERSION;
  readonly entries: readonly FoundationManifestEntry[];
  readonly identityVersion: typeof EVIDENCE_IDENTITY_VERSION;
  readonly manifestDigest: string;
  readonly version: typeof FOUNDATION_EXPECTED_OUTCOME_VERSION;
}

export function buildFoundationManifest(
  fixtures: readonly FoundationFixture[],
  schedules: readonly FoundationSchedule[],
): FoundationManifest {
  const entries: FoundationManifestEntry[] = [
    ...fixtures.map((fixture) => ({
      digest: fixture.pinnedDigest,
      entryId: fixture.fixtureId,
      entryKind: "FIXTURE" as const,
      journey: fixture.journey,
      outcome: { ...fixture.outcome },
    })),
    ...schedules.map((schedule) => ({
      digest: identifyCanonicalEvidence({
        declared: { ...schedule.declared },
        journey: schedule.journey,
        scheduleId: schedule.scheduleId,
        title: schedule.title,
      }).digest,
      entryId: schedule.scheduleId,
      entryKind: "SCHEDULE" as const,
      journey: schedule.journey,
      outcome: { ...schedule.declared },
    })),
  ].sort((left, right) => (left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0));

  const frozen = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  return Object.freeze({
    canonicalizerVersion: CANONICAL_JSON_VERSION,
    entries: frozen,
    identityVersion: EVIDENCE_IDENTITY_VERSION,
    manifestDigest: identifyCanonicalEvidence({
      entries: frozen.map((entry) => ({ ...entry, outcome: { ...entry.outcome } })),
      version: FOUNDATION_EXPECTED_OUTCOME_VERSION,
    }).digest,
    version: FOUNDATION_EXPECTED_OUTCOME_VERSION,
  });
}
