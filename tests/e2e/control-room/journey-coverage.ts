/**
 * The scenario ledger for the control-room journey gate.
 *
 * WHY THIS FILE EXISTS. Spec section 12 declares TWENTY Playwright-ready
 * scenarios. The browser lane in this repository can honestly drive THREE of
 * them. A gate that quietly tested three and reported success would retire
 * seventeen obligations it never discharged, which project rail 4 Clause 2 calls
 * worse than no proof. So the matrix is enumerated here in full, every entry
 * carries its status, and `journey-coverage.test.ts` asserts the arithmetic —
 * a case deleted, a status flipped, or a missing input blanked all go RED.
 *
 * READ THE STATUSES AS WRITTEN. `COVERED` means a real browser drives the real
 * built bundle and asserts the scenario's bar. `UNKNOWN` means the gate does not
 * prove it and says exactly what is missing and who owns it. Nothing here is
 * mock-backed, and no component was created to give a scenario something to find.
 *
 * THE THREE ROOT CAUSES ARE DELIBERATELY DISTINCT (see `UnknownCause`). Collapsing
 * them into one "not covered" bucket would hide the most surprising finding on this
 * task: two surfaces EXIST as files and are still unreachable in a browser, so a
 * file-existence check passes for them while a reachability check does not.
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
 *   daemon-side fixture setup, a kill/restart harness, or state transitions that a
 *   presentation-only fixture build cannot perform.
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
 * The honest answer for every daemon-backed scenario, and it is not the graph task.
 * A real transport landed (task-318379ea, DONE: apps/daemon http-listener +
 * packages/control-room-client client-transport), and apps/control-room/src/main.tsx
 * already has a `?live=1` path. What does not exist anywhere is a browser lane that
 * STARTS a daemon, seeds a scenario fixture and serves the bundle against it.
 * task-3f503779 used to hold that and was archived for duplicating this task, so this
 * cause currently has NO owner on the board.
 */
export const DAEMON_LANE_OWNER = "UNOWNED — no board task owns a daemon-backed browser lane";

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

const noLane = (
  id: string, journey: JourneyId, missingInput: string,
): UnknownScenario => Object.freeze({
  cause: "NO_DAEMON_BACKED_BROWSER_LANE", id, journey, missingInput,
  owner: DAEMON_LANE_OWNER, status: "UNKNOWN",
});

const uncomposed = (
  id: string, journey: JourneyId, missingInput: string,
): UnknownScenario => Object.freeze({
  cause: "SURFACE_NOT_COMPOSED", id, journey, missingInput,
  owner: DAEMON_LANE_OWNER, status: "UNKNOWN",
});

export const SCENARIO_MATRIX: readonly ScenarioRecord[] = Object.freeze([
  noLane("CR-J1-001", "J1",
    "cr.goals.form is not rendered by the fixture build and the preview performs no state "
    + "transitions, so the three-human-action journey cannot be completed end to end."),
  Object.freeze({
    bar: "cr.graph.canvas is never mounted; zero cr.graph.* ids render on any workspace.",
    id: "CR-J1-002", journey: "J1",
    productionFiles: ["apps/control-room/src/preview/control-room-preview.tsx"],
    status: "COVERED",
  } as const),
  absent("CR-J2-001", "J2", "cr.graph.ghost.* has zero production files; the graph tab is a placeholder."),
  noLane("CR-J2-002", "J2",
    "cr.board.joinstrip and cr.inspector.section.findings need a seeded decomposable goal "
    + "and an integrator-independence policy fixture; no daemon lane can seed either."),
  noLane("CR-J2-003", "J2",
    "cr.review.surface is not rendered by the fixture build; proving it excludes transcripts "
    + "requires the surface to exist in the DOM first."),
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
    "cr.board.card.silence.* does not render; the preview board card carries name and phase only."),
  uncomposed("CR-J5-002", "J5",
    "cr.runs.suspect lives in apps/control-room/src/runs/runs-surface.tsx, which EXISTS but is "
    + "imported by no production module — RunsSurface is never mounted, so a browser cannot "
    + "reach it. The served bundle renders a separate hand-written cr.surface.runs panel."),
  absent("CR-S9-001", "S9", "cr.graph.refusal.* has zero production files."),
  uncomposed("CR-S10-001", "S10",
    "cr.banner.circuitbreaker IS mounted via shell-chrome.tsx, but ControlRoomPreview supplies "
    + "no breaker fact and the component fails closed on an absent one, so it renders null. "
    + "It also needs a fault-injected correlated-failure fixture."),
  absent("CR-S11-001", "S11",
    "cr.banner.revision, cr.graph.disposition.* and cr.graph.revisiondiff have zero production files."),
  Object.freeze({
    bar: "All five truth classes render with pairwise-distinct glyph, short label and border "
      + "style, so they are distinguishable without colour; UNKNOWN alone is dashed.",
    id: "CR-A11Y-001", journey: "A11Y",
    productionFiles: ["apps/control-room/src/kernel.tsx"],
    status: "COVERED",
  } as const),
  noLane("CR-A11Y-002", "A11Y",
    "the bar is J1's three actions completed keyboard-only, and J1 cannot be completed at all "
    + "(see CR-J1-001). Keyboard operability of what DOES render is asserted separately as a "
    + "global invariant in journeys.spec.ts."),
  Object.freeze({
    bar: "Every rendered cr.action.* carries a command id drawn from the supplied "
      + "nextAllowedCommands set, one button per command, over a non-zero action count.",
    caveat: "The supplied set is a COMMITTED FIXTURE, not a live daemon query response. The "
      + "structural property — no action exists that the supplied set did not authorise — is "
      + "genuinely proven. 'Supplied by a live daemon' is not.",
    id: "CR-CMD-001", journey: "CMD",
    productionFiles: [
      "apps/control-room/src/goals/supplied-actions.tsx",
      "apps/control-room/src/shell/frame.tsx",
    ],
    status: "COVERED",
  } as const),
  noLane("CR-LAG-001", "LAG",
    "needs a relay-stall fixture where the view is stale but mutations stay ENABLED. The "
    + "fixture build boots DISCONNECTED, where actions are correctly disabled — a different "
    + "state, and asserting it here would certify the wrong thing."),
  noLane("CR-DOC-001", "DOC",
    "cr.health.doctor and the offline banner need the doctor harness with the daemon stopped."),
]);

/**
 * Nothing on the board owns composing a pending state into a served entry point.
 * This is NOT the daemon-lane owner: even once a daemon lane exists, some module
 * still has to pass the flag, and today none does on either path.
 */
export const LOADING_OWNER =
  "UNOWNED — no board task composes a pending state into either served entry point";

/**
 * DoD 2's LOADING invariant, recorded rather than proven — and it is recorded here
 * because the first pass of this gate ASSERTED FIVE OF SEVEN INVARIANTS AND SAID
 * NOTHING ABOUT THIS ONE. Silence read exactly like coverage, which is the failure
 * this whole task exists to prevent, so the record is the fix.
 *
 * THE COMPONENTS ARE REAL. `cr.board.skeleton` (board-surface.tsx:101),
 * `cr.goals.loading` (goals-home.tsx:231), `cr.health.loading` and
 * `cr.health.skeleton` (doctor-console.tsx:231/233) are all committed production,
 * and spec 11.3 specifies a loading state per primary surface. So this is
 * SURFACE_NOT_COMPOSED, never SURFACE_ABSENT — a file-existence check passes for
 * every one of them.
 *
 * IT IS UNREACHABLE ON BOTH SERVED PATHS, measured rather than assumed:
 *   main.tsx:40 -> ControlRoomScaffold -> kernel.tsx -> ControlRoomPreview, which
 *   contains no `loading` at all; and main.tsx's `?live=1` branch into
 *   live/live-app.tsx, which contains none either. The only production module that
 *   ever sets `loading: true` is a11y/ui-wide-core-fixtures.tsx, imported solely by
 *   tests and by another fixture module.
 *
 * NO BROWSER ASSERTION IS WRITTEN. Driving a loading state would require wiring the
 * flag into the served preview, and a surface created to give an assertion something
 * to find is fabricated evidence under Clause 2 — worse than no proof, because it
 * would retire the invariant while certifying nothing.
 */
export const LOADING_RECORD = Object.freeze({
  cause: "SURFACE_NOT_COMPOSED" as const,
  id: "CR-LOADING",
  missingInput:
    "No served entry point ever passes loading=true. ControlRoomPreview (the fixture path) "
    + "and live/live-app.tsx (the ?live=1 path) both contain zero references to `loading`, so "
    + "cr.board.skeleton, cr.goals.loading, cr.health.loading and cr.health.skeleton render in "
    + "no browser despite existing as committed production. Needs a served composition that "
    + "supplies a pending state; creating one from this gate would be fabricated evidence.",
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
]);

/**
 * The other half of the rot guard, for surfaces that EXIST but are unreachable.
 * `importedBySpecifier` is the module specifier a production module would have to
 * import for the surface to become mountable; the test asserts nothing does.
 */
export const UNCOMPOSED_SURFACES: readonly {
  readonly file: string;
  readonly importedBySpecifier: string;
  readonly scenario: string;
}[] = Object.freeze([
  Object.freeze({
    file: "apps/control-room/src/runs/runs-surface.tsx",
    importedBySpecifier: "runs-surface", scenario: "CR-J5-002",
  }),
  Object.freeze({
    file: "apps/control-room/src/resources/resources-surface.tsx",
    importedBySpecifier: "resources-surface", scenario: "CR-J5-002",
  }),
]);

export const isCovered = (record: ScenarioRecord): record is CoveredScenario =>
  record.status === "COVERED";

export const coveredScenarios = (): readonly CoveredScenario[] =>
  SCENARIO_MATRIX.filter(isCovered);

export const unknownScenarios = (): readonly UnknownScenario[] =>
  SCENARIO_MATRIX.filter((record): record is UnknownScenario => record.status === "UNKNOWN");
