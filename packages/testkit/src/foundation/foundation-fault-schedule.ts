/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY fault-schedule catalogue for the
 * foundation journeys, plus the assembled expected-outcome manifest.
 *
 * Covers the catalogue this task's definition of done names: stale version and
 * stale lease/epoch, cancel-start races, the crash boundaries around
 * transaction begin/write/commit and effect acknowledgement, the zero-work
 * false green, and honest UNKNOWN. Schedules that the landed surface can
 * actually execute declare PASS_EXPECTED; the rest declare
 * PRODUCTION_BEHAVIOR_ABSENT behind a falsifiable probe, or HONEST_UNKNOWN when
 * the missing thing is evidence rather than behaviour.
 *
 * An UNKNOWN here is a first-class result, never a soft pass: a schedule with
 * no evidence behind it must report HONEST_UNKNOWN and must never report green.
 */

import {
  FOUNDATION_INCIDENT_PROBES,
  FOUNDATION_INCIDENT_SCHEDULES,
} from "./foundation-incident-schedules.js";
import { FOUNDATION_FIXTURES } from "./foundation-journey-fixtures.js";
import {
  buildFoundationManifest,
  honestUnknown,
  passExpected,
  productionBehaviorAbsent,
} from "./foundation-outcomes-fixtures.js";
import type {
  FoundationAbsenceProbe,
  FoundationJourney,
  FoundationManifest,
  FoundationManifestEntry,
  FoundationOutcome,
  FoundationSchedule,
} from "./foundation-outcomes-fixtures.js";

const probe = (
  probeRef: string,
  packageName: string,
  absentExportNames: readonly string[],
  absentExportPattern: string,
): FoundationAbsenceProbe =>
  Object.freeze({
    absentExportNames: Object.freeze([...absentExportNames]),
    absentExportPattern,
    packageName,
    probeRef,
  });

/** Catalogue probes. Every pattern was checked against the live export sets. */
const CATALOGUE_PROBES: readonly FoundationAbsenceProbe[] = Object.freeze([
  probe(
    "probe:core-attempt-execution-reducer",
    "@moe/core",
    ["reduceAttempt", "ATTEMPT_TRANSITIONS", "ATTEMPT_COMMAND_KINDS"],
    "attempt",
  ),
  probe(
    "probe:core-store-dispatch-composition",
    "@moe/core",
    ["createDispatcher", "dispatchCommand", "createCommandDispatcher"],
    "dispatch",
  ),
  probe(
    "probe:store-outbox-acknowledgement",
    "@moe/store",
    ["acknowledgeOutbox", "ackOutboxMessage", "markOutboxDelivered"],
    "acknowledg|^ack",
  ),
  probe(
    "probe:scheduler-authority-lease",
    "@moe/scheduler",
    ["fenceAuthority", "markSuspect", "confirmRevoke", "restartReconstruct"],
    "lease|fence",
  ),
]);

export const FOUNDATION_ABSENCE_PROBES: readonly FoundationAbsenceProbe[] = Object.freeze([
  ...CATALOGUE_PROBES,
  ...FOUNDATION_INCIDENT_PROBES,
]);

const PASS = passExpected();
const ATTEMPT_SURFACE = "attempt/execution lifecycle reducer";

type ScheduleRow = readonly [
  scheduleId: string, journey: FoundationJourney, title: string, declared: FoundationOutcome,
];

/** One row per schedule. `declared` is the single outcome the fault tests must reproduce. */
const CATALOGUE_ROWS: readonly ScheduleRow[] = Object.freeze([
  // --- J1: the linear journey ---
  ["schedule:j1-linear-approval-path-executes", "J1",
    "register/activate then goal.create then graph approval drive landed reducers", PASS],
  ["schedule:j1-zero-work-false-green-refused", "J1",
    "a green-claiming trace with empty diff, no artifact and no receipt is refused", PASS],
  ["schedule:j1-agent-text-cannot-satisfy-gate", "J1",
    "an attempt whose only receipt is agent narration cannot close the gate", PASS],
  ["schedule:j1-acceptance-requires-proof", "J1",
    "acceptance with a null proof reference is refused", PASS],
  ["schedule:j1-cancel-start-race-aggregate-arbitration", "J1",
    "a start command after goal.cancel is refused ILLEGAL_TRANSITION by the reducer", PASS],
  ["schedule:j1-cancel-start-race-inflight-attempt", "J1",
    "cancel racing a started attempt must terminate the attempt, not orphan it",
    productionBehaviorAbsent(ATTEMPT_SURFACE, "probe:core-attempt-execution-reducer")],
  ["schedule:j1-execution-dispatch-composition", "J1",
    "an accepted command must be composed into a durable commit by one dispatch seam",
    productionBehaviorAbsent(
      "core-to-store dispatch composition", "probe:core-store-dispatch-composition")],
  ["schedule:j1-control-plane-overhead", "J1",
    "total control-plane overhead for one linear goal",
    honestUnknown("no measured control-plane overhead corpus exists at Foundation Preview")],

  // --- J3: crash recovery ---
  ["schedule:j3-commit-boundary-whole-or-none", "J3",
    "a commit is durable in whole or not at all across the transaction boundary", PASS],
  ["schedule:j3-duplicate-command-id-replays", "J3",
    "re-issuing a committed command id replays its decision instead of double-writing", PASS],
  ["schedule:j3-expected-version-conflict-refused", "J3",
    "a commit at a stale expected version is refused, not merged", PASS],
  ["schedule:j3-restart-record-classification", "J3",
    "each crash boundary classifies as adopted, suspect, quarantined or reconciliation", PASS],
  ["schedule:j3-healthy-continuation-single-safe-action", "J3",
    "healthy continuation is one safe action creating a binding, never edited history", PASS],
  ["schedule:j3-outbox-acknowledgement-boundary", "J3",
    "a crash between outbox delivery and acknowledgement must not lose or duplicate it",
    productionBehaviorAbsent(
      "durable outbox acknowledgement surface", "probe:store-outbox-acknowledgement")],
  ["schedule:j3-attempt-restart-adoption", "J3",
    "an attempt interrupted mid-run is adopted, quarantined or reconciled after restart",
    productionBehaviorAbsent(ATTEMPT_SURFACE, "probe:core-attempt-execution-reducer")],
  ["schedule:j3-total-storage-loss-rpo", "J3",
    "recovery point after total loss of authoritative storage",
    honestUnknown("no restore-generation corpus exists at Foundation Preview")],

  // --- J4: rejection, re-plan, and stale clients ---
  ["schedule:j4-delta-approval-round-accepted", "J4",
    "a round with evidence-linked findings and changed hashes is accepted", PASS],
  ["schedule:j4-invalidated-and-carried-conflict-refused", "J4",
    "a node claimed as both invalidated and carried forward is refused", PASS],
  ["schedule:j4-finding-without-evidence-refused", "J4",
    "a finding with no evidence link cannot drive a required change", PASS],
  ["schedule:j4-round-limit-requires-explicit-escalation", "J4",
    "passing the visible three-round counter without explicit escalation is refused", PASS],
  ["schedule:j4-stale-envelope-version-rejected", "J4",
    "a client on a superseded envelope schema version is rejected by the landed decoder", PASS],
  ["schedule:j4-stale-command-shape-rejected", "J4",
    "a malformed command id or request digest is rejected before schema inspection", PASS],
  ["schedule:j4-stale-lease-epoch-classification", "J4",
    "STALE_LEASE and STALE_EPOCH are registered fail-closed outcomes with epoch details", PASS],
  ["schedule:j4-expected-version-stale-client-refused", "J4",
    "a stale client's expected version is refused by the landed goal reducer", PASS],
  ["schedule:j4-stale-lease-enforcement", "J4",
    "a command carrying a superseded lease epoch must be refused by the authority surface",
    productionBehaviorAbsent(
      "exported lease/authority fencing surface", "probe:scheduler-authority-lease")],
  ["schedule:j4-review-round-corpus", "J4",
    "distribution of rejection rounds across real reviews",
    honestUnknown("no reviewer-calibration corpus is owned at Foundation Preview")],
]);

const CATALOGUE_SCHEDULES: readonly FoundationSchedule[] = Object.freeze(
  CATALOGUE_ROWS.map(([scheduleId, journey, title, declared]) =>
    Object.freeze({ declared, journey, scheduleId, title })),
);

export const FOUNDATION_SCHEDULES: readonly FoundationSchedule[] = Object.freeze([
  ...CATALOGUE_SCHEDULES,
  ...FOUNDATION_INCIDENT_SCHEDULES,
]);

export const FOUNDATION_MANIFEST: FoundationManifest = buildFoundationManifest(
  FOUNDATION_FIXTURES,
  FOUNDATION_SCHEDULES,
);

/** The entries one fault-test file owns. Together the three cover the manifest. */
export function foundationPartition(
  journey: FoundationJourney,
): readonly FoundationManifestEntry[] {
  return Object.freeze(
    FOUNDATION_MANIFEST.entries.filter((entry) => entry.journey === journey),
  );
}

/** Pinned sizes, so dropping a schedule from the catalogue cannot pass unnoticed. */
export const FOUNDATION_PARTITION_COUNTS: Readonly<Record<FoundationJourney, number>> =
  Object.freeze({ J1: 12, J3: 13, J4: 14 });

/**
 * Evidence, not behaviour, is what is missing for some schedules. An empty
 * bundle must yield HONEST_UNKNOWN — never a pass, and never a silent skip.
 */
export function resolveEvidenceOutcome(
  evidenceRefs: readonly string[],
  missingEvidence: string,
): FoundationOutcome {
  return evidenceRefs.length === 0 ? honestUnknown(missingEvidence) : passExpected();
}
