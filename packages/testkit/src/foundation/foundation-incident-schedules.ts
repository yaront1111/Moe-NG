/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY schedules for the six named legacy
 * incident fixtures design section 18.3 makes mandatory.
 *
 * Each incident is attempted through a PRESENCE-DETECTING PROBE rather than a
 * hardcoded "not built yet" constant. A probe declares which exported names of
 * a production package must still be missing for the incident to be
 * unreproducible; the fault tests evaluate it against the package's real export
 * set. The moment the surface lands, the probe goes red and forces the manifest
 * entry to be flipped from PRODUCTION_BEHAVIOR_ABSENT to a real outcome.
 *
 * That ratchet is the whole point. Design 18.3 makes these fixtures mandatory
 * complements to broad properties, 20.x requires a failing schedule to NAME the
 * missing behaviour, and Foundation Preview exit requires them to pass. An
 * unprobed constant would satisfy none of that: it would sit green-adjacent
 * forever and quietly become false evidence.
 */

import { productionBehaviorAbsent } from "./foundation-outcomes-fixtures.js";
import type {
  FoundationAbsenceProbe,
  FoundationSchedule,
} from "./foundation-outcomes-fixtures.js";

const probe = (
  probeRef: string,
  packageName: string,
  absentExportNames: readonly string[],
  absentExportPattern: string | null,
): FoundationAbsenceProbe =>
  Object.freeze({
    absentExportNames: Object.freeze([...absentExportNames]),
    absentExportPattern,
    packageName,
    probeRef,
  });

/**
 * Patterns were checked against the current export sets before being written:
 * none of them matches an already-exported runtime name, so every probe starts
 * absent for a real reason rather than because its pattern was chosen to miss.
 */
export const FOUNDATION_INCIDENT_PROBES: readonly FoundationAbsenceProbe[] = Object.freeze([
  probe(
    "probe:core-terminal-release",
    "@moe/core",
    ["reduceWorkRelease", "WORK_TRANSITIONS", "releaseTerminalWork"],
    "release",
  ),
  probe(
    "probe:core-release-handoff",
    "@moe/core",
    ["releaseWithHandoff", "reduceWorkHandoff", "HANDOFF_TRANSITIONS"],
    "handoff",
  ),
  probe(
    "probe:scheduler-hot-claim-admission",
    "@moe/scheduler",
    ["claimWorkItem", "admitClaim", "reduceClaim"],
    "claim",
  ),
  probe(
    "probe:scheduler-timer-reentrancy",
    "@moe/scheduler",
    ["reduceTimer", "scheduleTimerCallback", "reacquireTimerAuthority"],
    "timer",
  ),
  probe(
    "probe:core-review-assignment",
    "@moe/core",
    ["reduceReview", "assignReview", "REVIEW_TRANSITIONS"],
    "review",
  ),
  probe(
    "probe:contracts-distribution-handshake",
    "@moe/contracts",
    ["verifyDistributionManifest", "checkDistributionCompatibility"],
    "distribution",
  ),
]);

/**
 * The six mandatory incidents. `title` names the legacy commit the incident
 * came from so the schedule stays traceable to the regression it encodes.
 */
export const FOUNDATION_INCIDENT_SCHEDULES: readonly FoundationSchedule[] = Object.freeze([
  Object.freeze({
    declared: productionBehaviorAbsent(
      "terminal work release must not resurrect the released work item",
      "probe:core-terminal-release",
    ),
    journey: "J3" as const,
    scheduleId: "incident:terminal-release-cannot-resurrect",
    title: "legacy 53271ca — a terminal release cannot bring the item back",
  }),
  Object.freeze({
    declared: productionBehaviorAbsent(
      "release must atomically preserve resumable phase and handoff",
      "probe:core-release-handoff",
    ),
    journey: "J3" as const,
    scheduleId: "incident:release-handoff-atomicity",
    title: "legacy 3563791 + 28a6588 — release preserves resumable phase/handoff",
  }),
  Object.freeze({
    declared: productionBehaviorAbsent(
      "held or human-gated work must not be re-offered in a hot claim loop",
      "probe:scheduler-hot-claim-admission",
    ),
    journey: "J1" as const,
    scheduleId: "incident:hot-claim-loop-on-gated-work",
    title: "legacy 1aa1546 — human-gated work cannot enter a hot claim loop",
  }),
  Object.freeze({
    declared: productionBehaviorAbsent(
      "timer callbacks must reacquire transactional authority, never inherit it",
      "probe:scheduler-timer-reentrancy",
    ),
    journey: "J3" as const,
    scheduleId: "incident:timer-callback-reentrancy",
    title: "legacy 28a6588 — timer callbacks reacquire authority transactionally",
  }),
  Object.freeze({
    declared: productionBehaviorAbsent(
      "an assigned plan or work review must not be silently reassigned",
      "probe:core-review-assignment",
    ),
    journey: "J4" as const,
    scheduleId: "incident:silent-review-theft",
    title: "legacy 3d2cb16 + b30fb6f — review assignment is never silently stolen",
  }),
  Object.freeze({
    declared: productionBehaviorAbsent(
      "stale installed daemon/UI/MCP/IDE assets must refuse the distribution handshake",
      "probe:contracts-distribution-handshake",
    ),
    journey: "J4" as const,
    scheduleId: "incident:stale-assets-refuse-handshake",
    title: "design 18.3 — stale installed assets fail the distribution handshake",
  }),
]);
