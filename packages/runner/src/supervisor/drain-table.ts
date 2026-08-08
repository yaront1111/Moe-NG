import { deepFreeze } from "../canonical.js";

/**
 * The design-786/787 attempt/effect cross-product and the design-348 drain
 * precedence, as HAND-TRANSCRIBED FROZEN DATA.
 *
 * Nothing in this file is derived from `drain-reconciliation.ts`. That is the
 * whole point: a table generated from the resolver it is meant to constrain
 * would stay green after a row was silently dropped, because the expectation and
 * the implementation would move together. Every row below was copied from the
 * pinned design file, and the `design` field carries the source sentence so a
 * reviewer can diff prose against data without opening the resolver.
 *
 * Design 784: "The provider-launch attempt/effect cross-product is generated
 * from this closed table; no reducer invents a missing edge."
 */

/** Design 348, verbatim ranks. A strict total order; no two reasons tie. */
export const DRAIN_REASONS = Object.freeze([
  "URGENT_REVOKE",
  "GRAPH_REMOVE_OR_SUPERSESSION",
  "GOAL_CANCEL",
  "WORK_CANCEL",
  "DEPENDENCY_INVALIDATED",
  "WORK_RELEASE_OR_PAUSE",
  "SUBMISSION_FINALIZE",
] as const);
export type DrainReason = (typeof DRAIN_REASONS)[number];

/** Design 348: the safe boundary maps the strongest reason onto one of these. */
export const DRAIN_TERMINAL_TARGETS = Object.freeze([
  "CANCELLED",
  "SUPERSEDED",
  "RELEASED",
  "SUCCEEDED",
] as const);
export type DrainTerminalTarget = (typeof DRAIN_TERMINAL_TARGETS)[number];

export interface DrainPrecedenceEntry {
  readonly reason: DrainReason;
  readonly rank: number;
  readonly terminalTarget: DrainTerminalTarget;
}

/**
 * Ranks are design 348 verbatim. The targets are transcribed from the sentences
 * that name them: `GRAPH_REMOVE_OR_SUPERSESSION` from design 568
 * ("commits `DRAINING -> CHECKPOINTED -> SUPERSEDED`"), `DEPENDENCY_INVALIDATED`
 * from design 382 ("reaches `CHECKPOINTED -> SUPERSEDED`"),
 * `WORK_RELEASE_OR_PAUSE` from design 765 ("only an unchanged strongest
 * `WORK_RELEASE_OR_PAUSE` result makes the run resumable"), and
 * `SUBMISSION_FINALIZE` from design 342 ("`SUCCEEDED` is available only to a
 * safely finalized immutable planning submission").
 */
export const DRAIN_PRECEDENCE: readonly DrainPrecedenceEntry[] = deepFreeze([
  { reason: "URGENT_REVOKE", rank: 70, terminalTarget: "CANCELLED" },
  { reason: "GRAPH_REMOVE_OR_SUPERSESSION", rank: 60, terminalTarget: "SUPERSEDED" },
  { reason: "GOAL_CANCEL", rank: 50, terminalTarget: "CANCELLED" },
  { reason: "WORK_CANCEL", rank: 40, terminalTarget: "CANCELLED" },
  { reason: "DEPENDENCY_INVALIDATED", rank: 30, terminalTarget: "SUPERSEDED" },
  { reason: "WORK_RELEASE_OR_PAUSE", rank: 20, terminalTarget: "RELEASED" },
  { reason: "SUBMISSION_FINALIZE", rank: 10, terminalTarget: "SUCCEEDED" },
] as const satisfies readonly DrainPrecedenceEntry[]);

/**
 * A caller-supplied classification of every confirmed external resource.
 * `UNKNOWN` is a first-class member and never collapses into `PROVEN_RELEASED`:
 * epic rail 4 keeps unverifiable evidence at UNKNOWN with no authority.
 */
export const RESOURCE_FACTS = Object.freeze(["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"] as const);
export type ResourceFact = (typeof RESOURCE_FACTS)[number];

/** Design 336's attempt machine, wider than the kernel's two-state launch slice. */
export const DRAIN_ATTEMPT_STATES = Object.freeze([
  "ABSENT",
  "LEASED",
  "LAUNCH_REQUESTED",
  "RUNNING",
  "DRAINING",
  "TERMINAL",
] as const);
export type DrainAttemptState = (typeof DRAIN_ATTEMPT_STATES)[number];

export const DRAIN_OUTCOME_KINDS = Object.freeze([
  "TOMBSTONED",
  "TERMINALIZED",
  "DRAINING",
  "ATOMIC_ACTIVATION",
  "RECONCILE_ONLY",
  "REFUSED",
] as const);
export type DrainOutcomeKind = (typeof DRAIN_OUTCOME_KINDS)[number];

export interface DrainRow {
  readonly rowId: string;
  readonly designLine: number;
  readonly attemptStates: readonly DrainAttemptState[];
  readonly effectStates: readonly string[];
  readonly resourceFacts: readonly ResourceFact[];
  readonly activationRequested: boolean;
  readonly outcomeKind: DrainOutcomeKind;
  readonly releasesProviderSlot: boolean;
  readonly retainsCapacityHold: boolean;
  readonly requiresSafeHandoffForRelease: boolean;
  readonly design: string;
}

/** The six rows of the design-786/787 table, in design order. */
export const DRAIN_TABLE_ROWS: readonly DrainRow[] = deepFreeze([
  {
    rowId: "R1",
    designLine: 785,
    attemptStates: ["ABSENT"],
    effectStates: ["PENDING", "CLAIMED", "ARMED"],
    resourceFacts: ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"],
    activationRequested: false,
    outcomeKind: "TOMBSTONED",
    releasesProviderSlot: false,
    retainsCapacityHold: false,
    requiresSafeHandoffForRelease: false,
    design: "no attempt | pre-materialization intent | tombstone intent; no authority created",
  },
  {
    rowId: "R2",
    designLine: 786,
    attemptStates: ["LEASED", "LAUNCH_REQUESTED"],
    effectStates: ["PENDING", "CLAIMED", "ARMED"],
    resourceFacts: ["PROVEN_RELEASED"],
    activationRequested: false,
    outcomeKind: "TERMINALIZED",
    releasesProviderSlot: true,
    retainsCapacityHold: false,
    requiresSafeHandoffForRelease: true,
    design:
      "LEASED|LAUNCH_REQUESTED, all resources proven absent/released | PENDING|CLAIMED|ARMED | " +
      "atomically cancel/tombstone effect, fence/release leases/provider slot, settle budget, and " +
      "terminalize by strongest typed reason; RELEASED also requires an exact safe handoff",
  },
  {
    rowId: "R3",
    designLine: 787,
    attemptStates: ["LEASED", "LAUNCH_REQUESTED"],
    effectStates: ["PENDING", "CLAIMED", "ARMED"],
    resourceFacts: ["ACTIVE", "UNKNOWN"],
    activationRequested: false,
    outcomeKind: "DRAINING",
    releasesProviderSlot: true,
    retainsCapacityHold: true,
    requiresSafeHandoffForRelease: false,
    design:
      "LEASED|LAUNCH_REQUESTED, any resource active/unknown | PENDING|CLAIMED|ARMED | tombstone " +
      "provider effect and release provider slot, but enter attempt DRAINING; retain resource " +
      "capacity/NodeRun hold until adapter reconciliation, then use strongest disposition",
  },
  {
    rowId: "R4",
    designLine: 788,
    attemptStates: ["LAUNCH_REQUESTED"],
    effectStates: ["ARMED"],
    resourceFacts: ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"],
    activationRequested: true,
    outcomeKind: "ATOMIC_ACTIVATION",
    releasesProviderSlot: false,
    retainsCapacityHold: true,
    requiresSafeHandoffForRelease: false,
    design:
      "LAUNCH_REQUESTED | activation command | atomically become attempt RUNNING plus effect " +
      "ACTIVE, or neither",
  },
  {
    rowId: "R5",
    designLine: 789,
    attemptStates: ["RUNNING", "DRAINING"],
    effectStates: ["ACTIVE", "CANCEL_REQUESTED", "UNKNOWN"],
    resourceFacts: ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"],
    activationRequested: false,
    outcomeKind: "DRAINING",
    releasesProviderSlot: false,
    retainsCapacityHold: true,
    requiresSafeHandoffForRelease: true,
    design:
      "RUNNING|DRAINING | ACTIVE|CANCEL_REQUESTED|UNKNOWN | enter/remain DRAINING; every later " +
      "reason monotonically upgrades disposition; runner/adapter proof reconciles effect/resources " +
      "before CHECKPOINTED -> SUCCEEDED|RELEASED|SUPERSEDED|CANCELLED from the strongest current reason",
  },
  {
    rowId: "R6",
    designLine: 790,
    attemptStates: ["TERMINAL"],
    effectStates: ["PENDING", "CLAIMED", "ARMED", "ACTIVE", "CANCEL_REQUESTED", "UNKNOWN"],
    resourceFacts: ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"],
    activationRequested: false,
    outcomeKind: "RECONCILE_ONLY",
    releasesProviderSlot: false,
    retainsCapacityHold: false,
    requiresSafeHandoffForRelease: false,
    design:
      "terminal attempt | any nonterminal/unknown effect | no resurrection; late system " +
      "observation may only reconcile/quarantine the effect and budget",
  },
] as const satisfies readonly DrainRow[]);

export function drainRank(reason: DrainReason): number {
  const entry = DRAIN_PRECEDENCE.find((candidate) => candidate.reason === reason);
  return entry === undefined ? -1 : entry.rank;
}

export function drainTargetOf(reason: DrainReason): DrainTerminalTarget | null {
  return DRAIN_PRECEDENCE.find((candidate) => candidate.reason === reason)?.terminalTarget ?? null;
}
