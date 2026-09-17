/**
 * The scenario ledger for the control-room journey gate.
 *
 * WHY THIS FILE EXISTS. Spec section 12 declares TWENTY Playwright-ready
 * scenarios. The production browser lane can honestly drive TWO of them. A gate
 * that quietly tested a subset and reported success would retire obligations it
 * never discharged, which project rail 4 Clause 2 calls
 * worse than no proof. So the matrix is enumerated here in full, every entry
 * carries its status, and `journey-coverage.test.ts` asserts the arithmetic —
 * a case deleted, a status flipped, or a missing input blanked all go RED.
 *
 * READ THE STATUSES AS WRITTEN. `COVERED` means a real browser drives the real
 * production bundle and asserts the scenario's bar. `UNKNOWN` means the gate does not
 * prove it and says exactly what is missing and who owns it. Nothing here is
 * mock-backed, and no component was created to give a scenario something to find.
 *
 * THE ROOT CAUSES ARE DELIBERATELY DISTINCT (see `UnknownCause`). Collapsing
 * them into one "not covered" bucket would hide which owner a gap needs: a surface
 * nobody has written, a component nothing mounts, and a lane nobody has seeded are
 * three different pieces of missing work, and each row names its own.
 */

/** Spec section 12 declares exactly this many scenarios. Hand-counted from the table. */
export const DECLARED_SCENARIO_COUNT = 20;

export type JourneyId = "J1" | "J2" | "J3" | "J4" | "J5" | "S9" | "S10" | "S11"
  | "A11Y" | "CMD" | "LAG" | "DOC";

/**
 * Why a scenario is not proven. These are NOT interchangeable:
 * - SURFACE_ABSENT: no production file renders the scenario's ids at all.
 * - SURFACE_NOT_COMPOSED: the component exists but nothing mounts it into the
 *   served application, so a browser can never reach it. A file check passes here.
 * - NO_DAEMON_BACKED_BROWSER_LANE: the surface renders, but the scenario needs
 *   daemon-side fixture setup, a kill/restart harness, or state transitions that the
 *   v2 fixture route (CordumApp under ?fixtures=1, frozen example data) cannot perform.
 * - REFERENCE_MACHINE_UNDEFINED: reserved for the latency obligation below.
 */
export type UnknownCause = "SURFACE_ABSENT" | "SURFACE_NOT_COMPOSED"
  | "NO_DAEMON_BACKED_BROWSER_LANE" | "REFERENCE_MACHINE_UNDEFINED";

/**
 * task-779d6804 owns every graph surface and is ARCHIVED — it was never built.
 * An archived task has no owner and is in no claim pool, so nothing on the board
 * will ever move it. DO NOT WAIT ON IT: it must be revived or re-created first.
 */
export const GRAPH_OWNER = "task-779d6804d4a44440ad4d48a832a351d6 (ARCHIVED — never built)";

/**
 * The daemon-backed browser lane EXISTS now, and this names who owns it.
 *
 * It used to read "UNOWNED": a real transport had landed (task-318379ea) and
 * main.tsx already mounted the live path by DEFAULT, but no browser lane STARTED a
 * daemon, seeded it and served the bundle against it. task-3767f2cd built exactly
 * that — see DAEMON_LANE_RECORD in `daemon-lane-ledger.ts` for what the one
 * journey does and does not prove. It is recorded THERE, not here, because it
 * covers none of the twenty scenarios in this matrix.
 *
 * OWNING THE LANE IS NOT COVERING THE SCENARIOS. Every row below whose cause is
 * NO_DAEMON_BACKED_BROWSER_LANE needs MORE than a lane: a seeded rejection, a
 * kill/restart harness, a relay-stall fixture, or a surface that renders no ids at
 * all today. None of them is discharged by the lane existing, so none flips to
 * COVERED here — and each says v0.2 explicitly rather than implying an imminent one.
 */
export const DAEMON_LANE_OWNER =
  "task-3767f2cd8ac94e4b9e9e82a3dc29af11 (OWNED — tests/e2e/control-room/daemon-board.spec.ts)";

export interface CoveredScenario {
  readonly id: string;
  readonly journey: JourneyId;
  readonly status: "COVERED";
  /** Must exist on disk AND be reachable in the browser; both are asserted. */
  readonly productionFiles: readonly string[];
  /** What the browser gate asserts. Non-empty for every covered scenario. */
  readonly bar: string;
  /** Present when the coverage is real but narrower than the spec's named setup. */
  readonly caveat?: string;
}

export interface UnknownScenario {
  readonly id: string;
  readonly journey: JourneyId;
  readonly status: "UNKNOWN";
  readonly cause: Exclude<UnknownCause, "REFERENCE_MACHINE_UNDEFINED">;
  readonly missingInput: string;
  readonly owner: string;
}

export type ScenarioRecord = CoveredScenario | UnknownScenario;

const absent = (
  id: string, journey: JourneyId, missingInput: string,
): UnknownScenario => Object.freeze({
  cause: "SURFACE_ABSENT", id, journey, missingInput, owner: GRAPH_OWNER, status: "UNKNOWN",
});

/**
 * The v0.1 scope freeze in one sentence, APPENDED to every daemon-backed row
 * rather than written into each by hand. Composed here so a row cannot be added
 * without it: a per-row copy is a per-row chance to forget, and "the ledger says
 * nothing about when" is how an UNKNOWN quietly becomes permanent.
 */
const V0_2_DEFERRAL = " DEFERRED TO v0.2: the daemon-backed lane exists (see "
  + "DAEMON_LANE_RECORD in daemon-lane-ledger.ts) but this scenario needs its own "
  + "seeded setup on top of it, and the v0.1 scope freeze admits exactly one "
  + "daemon-backed journey.";

const noLane = (
  id: string, journey: JourneyId, missingInput: string,
): UnknownScenario => Object.freeze({
  cause: "NO_DAEMON_BACKED_BROWSER_LANE", id, journey,
  missingInput: `${missingInput}${V0_2_DEFERRAL}`,
  owner: DAEMON_LANE_OWNER, status: "UNKNOWN",
});

export const SCENARIO_MATRIX: readonly ScenarioRecord[] = Object.freeze([
  noLane("CR-J1-001", "J1",
    "cr.goals.form is rendered by no v2 module, and the v2 fixture route (CordumApp under "
    + "?fixtures=1) serves frozen example data with no state transitions, so the "
    + "three-human-action journey cannot be completed end to end."),
  Object.freeze({
    bar: "Production Cordum v2 mounts its real shell and no cr.graph.* surface or canvas.",
    id: "CR-J1-002", journey: "J1",
    productionFiles: ["apps/control-room/src/v2/cordum-app.tsx"],
    status: "COVERED",
  } as const),
  absent("CR-J2-001", "J2", "cr.graph.ghost.* has zero production files; the graph tab is a placeholder."),
  noLane("CR-J2-002", "J2",
    "cr.board.joinstrip and cr.inspector.section.findings need a seeded decomposable goal "
    + "and an integrator-independence policy fixture; no daemon lane can seed either."),
  noLane("CR-J2-003", "J2",
    "cr.review.surface has zero production carriers: the v1 review surface went with the "
    + "legacy UI on 2026-09-17 and no v2 screen renders one. Proving it excludes transcripts "
    + "requires the surface to exist in the DOM first, on top of a seeded review."),
  noLane("CR-J3-001", "J3",
    "needs a daemon kill/restart harness; cr.timeline.row.restart and cr.health.outbox do not "
    + "render. NOTE: this scenario's bar — the disconnected banner never coexisting with an "
    + "ENABLED cr.action.* — IS asserted separately as a global invariant in journeys.spec.ts."),
  noLane("CR-J3-002", "J3",
    "cr.health.reconciliation.row.* needs a seeded corrupt import; only cr.health.status renders."),
  noLane("CR-J3-003", "J3",
    "cr.action.work-resume is not rendered; it needs a crash fixture with a healthy in-flight node."),
  noLane("CR-J4-001", "J4",
    "cr.banner.invalidated and cr.approvals.delta.unchanged need a seeded rejection and a "
    + "second plan revision; neither renders in the fixture build."),
  noLane("CR-J4-002", "J4",
    "cr.inspector.loopcounter and cr.approvals.item.escalation need three scripted rejections "
    + "against a live policy bound."),
  noLane("CR-J5-001", "J5",
    "cr.board.card.silence.* does not render; the v2 work-board card (v2/goals/work-board.tsx) "
    + "carries no silence marker, and one needs a seeded stalled node behind it."),
  Object.freeze({
    cause: "SURFACE_ABSENT",
    id: "CR-J5-002", journey: "J5",
    missingInput: "cr.runs.suspect has zero production files: the legacy v1 runs surface that "
      + "carried it was removed with the v1 UI on 2026-09-17, and the Cordum v2 runs screen "
      + "(apps/control-room/src/v2/runs/runs-screen.tsx) renders no suspect marker.",
    owner: "UNOWNED — no board task gives the v2 runs screen a suspect marker",
    status: "UNKNOWN",
  } as const),
  absent("CR-S9-001", "S9", "cr.graph.refusal.* has zero production files."),
  Object.freeze({
    cause: "SURFACE_ABSENT",
    id: "CR-S10-001", journey: "S10",
    missingInput: "cr.banner.circuitbreaker has zero production files: the v1 shell chrome that "
      + "mounted the breaker banner was removed with the v1 UI on 2026-09-17, and no Cordum v2 "
      + "module renders the id (measured at zero carriers across apps/*/src and packages/*/src). "
      + "It also needs a fault-injected correlated-failure fixture.",
    owner: "UNOWNED — no board task gives Cordum v2 a circuit-breaker banner",
    status: "UNKNOWN",
  } as const),
  absent("CR-S11-001", "S11",
    "cr.banner.revision, cr.graph.disposition.* and cr.graph.revisiondiff have zero production files."),
  Object.freeze({
    bar: "All five truth classes render with pairwise-distinct glyph, short label and border "
      + "style, so they are distinguishable without colour; UNKNOWN alone is dotted.",
    id: "CR-A11Y-001", journey: "A11Y",
    productionFiles: [
      "apps/control-room/src/v2/components/truth-chip.tsx",
      "apps/control-room/src/v2/shell/nav-rail.tsx",
    ],
    status: "COVERED",
  } as const),
  noLane("CR-A11Y-002", "A11Y",
    "the bar is J1's three actions completed keyboard-only, and J1 cannot be completed at all "
    + "(see CR-J1-001). Keyboard operability of what DOES render is asserted separately as a "
    + "global invariant in journeys.spec.ts."),
  Object.freeze({
    cause: "SURFACE_NOT_COMPOSED",
    id: "CR-CMD-001", journey: "CMD",
    missingInput: "The production build strips the legacy fixture shell that rendered cr.action.*. "
      + "Cordum v2 has no non-zero command-authored action set carrying daemon-supplied command ids, "
      + "so the old fixture assertion cannot be claimed as production evidence.",
    owner: "UNOWNED — Cordum v2 needs a command-authored action metadata surface",
    status: "UNKNOWN",
  } as const),
  noLane("CR-LAG-001", "LAG",
    "needs a relay-stall fixture where the view is stale but mutations stay ENABLED. Neither "
    + "served route reproduces it: the v2 fixture route (?fixtures=1) renders frozen example "
    + "data behind a simulated CONNECTED shell, and the live route with no daemon boots "
    + "DISCONNECTED (LIVE_BOOTSTRAP_UNAVAILABLE), where actions are correctly disabled — a "
    + "different state, and asserting it here would certify the wrong thing."),
  noLane("CR-DOC-001", "DOC",
    "cr.health.doctor and the offline banner need the doctor harness with the daemon stopped."),
]);

/**
 * Nothing on the board owns composing a pending state into a served entry point.
 * This is NOT the daemon-lane owner: even once a daemon lane exists, some module
 * still has to pass the flag, and today none does on either path.
 */
export const LOADING_OWNER =
  "UNOWNED — no board task composes a pending state into any served entry point";

/**
 * DoD 2's LOADING invariant, recorded rather than proven — and it is recorded here
 * because the first pass of this gate ASSERTED FIVE OF SEVEN INVARIANTS AND SAID
 * NOTHING ABOUT THIS ONE. Silence read exactly like coverage, which is the failure
 * this whole task exists to prevent, so the record is the fix.
 *
 * WHAT THE v1 REMOVAL CHANGED (2026-09-17). The v1 carriers of `cr.board.skeleton`,
 * `cr.goals.loading` and `cr.health.skeleton` went with the legacy UI, so those three
 * ids now resolve to zero production files. `cr.health.loading` survives in ONE v2
 * module: v2/ops/ops-screens.tsx renders it while the Health screen read is null.
 * Spec 11.3 still specifies a loading state per primary surface, and no v2 board or
 * goals surface renders one, so the invariant stays UNKNOWN.
 *
 * THE CAUSE IS KEPT AS SURFACE_NOT_COMPOSED, NOT RE-MEASURED. The sweep in
 * journey-coverage.test.ts only asserts that no served entry point passes a
 * `loading=` prop; it does not ask whether a v2 screen composes its own pending
 * state internally (ops-screens.tsx does, from a null read rather than a prop). The
 * LOADING invariant must be RE-MEASURED AGAINST v2 — which surfaces render a pending
 * state, and whether any served path can reach it — before this record is read as a
 * reachability finding rather than a v1-era one.
 *
 * NO BROWSER ASSERTION IS WRITTEN. Driving a loading state would require wiring a
 * pending state into a served route, and a surface created to give an assertion
 * something to find is fabricated evidence under Clause 2 — worse than no proof,
 * because it would retire the invariant while certifying nothing.
 */
export const LOADING_RECORD = Object.freeze({
  cause: "SURFACE_NOT_COMPOSED" as const,
  id: "CR-LOADING",
  missingInput:
    "No served entry point passes loading=true: main.tsx, v2/cordum-app.tsx, "
    + "v2/goals/live-goals.tsx and v2/projects/project-manager-app.tsx contain zero `loading=` "
    + "props. The v1 carriers of cr.board.skeleton, cr.goals.loading and cr.health.skeleton were "
    + "removed with the v1 UI on 2026-09-17; cr.health.loading is rendered by "
    + "v2/ops/ops-screens.tsx while its health read is null, and no v2 board or goals surface "
    + "renders a pending state. RE-MEASURE AGAINST v2 before relying on this record; creating a "
    + "pending state from this gate would be fabricated evidence.",
  owner: LOADING_OWNER,
  status: "UNKNOWN" as const,
});

/**
 * The inherited latency obligation, deferred here from task-ab8c9489 and recorded
 * rather than answered. NO absolute p95/p99 assertion is written anywhere in this
 * gate: no reference machine is named in the repository or in the pinned spec, and a
 * percentile bar without a named environment certifies nothing. This remains an OPEN
 * HUMAN DECISION. The test asserts the status stays UNKNOWN so it cannot be flipped
 * to a silent pass without someone noticing.
 */
export const LATENCY_RECORD = Object.freeze({
  cause: "REFERENCE_MACHINE_UNDEFINED" as const,
  id: "CR-PERF-10K",
  missingInput:
    "No reference machine is defined in the repository or in the pinned control-room spec. "
    + "A 10k-update p95/p99 bar measured on an unnamed machine certifies nothing, so no "
    + "absolute latency assertion was written. Open human decision.",
  owner: "HUMAN DECISION — pending, deferred here from task-ab8c9489 via comment-5dd36b5b",
  status: "UNKNOWN" as const,
});

/**
 * Ids that must STILL resolve to zero production files. This is what stops the
 * record rotting: the day someone ships one of these, the ledger test goes RED and
 * demands the matrix be updated, instead of the UNKNOWN quietly outliving its gap.
 */
export const ABSENT_PRODUCTION_IDS: readonly string[] = Object.freeze([
  "cr.graph.ghost", "cr.graph.refusal", "cr.graph.disposition", "cr.graph.revisiondiff",
  "cr.graph.canvas", "cr.banner.revision",
  // Measured at zero production carriers on 2026-09-17, once the v1 UI was removed: the
  // v1 runs surface, review surface and shell chrome that rendered these are gone, and no
  // v2 module renders them. Guarded here so CR-J5-002, CR-J2-003 and CR-S10-001 cannot
  // quietly outlive the gaps they describe.
  "cr.runs.suspect", "cr.review.surface", "cr.banner.circuitbreaker",
]);

export const isCovered = (record: ScenarioRecord): record is CoveredScenario =>
  record.status === "COVERED";

export const coveredScenarios = (): readonly CoveredScenario[] =>
  SCENARIO_MATRIX.filter(isCovered);

export const unknownScenarios = (): readonly UnknownScenario[] =>
  SCENARIO_MATRIX.filter((record): record is UnknownScenario => record.status === "UNKNOWN");
