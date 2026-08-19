import { DAEMON_LANE_OWNER } from "./journey-coverage.js";

/**
 * What the daemon-backed browser lane actually discharges, and what it does not.
 *
 * SEPARATE FROM `journey-coverage.ts` FOR A REASON. That file is the spec's
 * twenty-scenario matrix; this lane covers NONE of those twenty, so recording it
 * inside the matrix would invite exactly the reading this whole ledger exists to
 * prevent — that owning a lane and covering a scenario are the same thing. They
 * are not. The lane is the machinery; each scenario still needs its own seeded
 * setup on top of it.
 */

/**
 * The one journey the lane drives, recorded with its bar AND its limits.
 *
 * `journeyTitle` is checked against the spec file's own `test("...")` opener by
 * `daemon-lane-ledger.test.ts`, so this record cannot outlive the journey it
 * claims: delete or rename the test and the ledger goes RED instead of continuing
 * to advertise a lane nothing drives.
 */
export const DAEMON_LANE_RECORD = Object.freeze({
  doesNotProve:
    "No spec section-12 scenario. The journey drives the READ-ONLY board only: it "
    + "completes no human action, performs no state transition, kills nothing and "
    + "restarts nothing. All seventeen UNKNOWN rows in the matrix stay UNKNOWN.",
  journeyFile: "tests/e2e/control-room/daemon-board.spec.ts",
  journeyTitle: "the live board renders the daemon's own seeded step, and says so honestly",
  owner: DAEMON_LANE_OWNER,
  proves:
    "A real daemon-main.ts on an ephemeral port, seeded by the shipped demo-seed-main.ts, "
    + "served through the Vite dev proxy: the board renders the seeded node.deliver step "
    + "under its per-run aggregate id in the READY column, the ledger checkpoint renders "
    + "with an OBSERVED truth chip and equals what /events/read answers, the fixture marker "
    + "is absent (and PRESENT when ?fixtures=1 is asked for), an uncredentialed build "
    + "refuses with LIVE_CONFIG_MISSING, and teardown leaves no orphan processes.",
} as const);

/**
 * The remaining journeys, NAMED, and deferred to v0.2 — DoD 4's "explicitly
 * listed" half.
 *
 * Hand-written rather than derived from the matrix on purpose. A list computed by
 * filtering `unknownScenarios()` would agree with the matrix no matter what the
 * matrix said, so it could never notice a row flipping; this one has to be edited
 * by the same hand that flips a status, and the test compares the two. That
 * comparison is what makes a silent flip impossible.
 *
 * SEVENTEEN, not sixteen: three cases are COVERED by the static lane, and the
 * daemon-backed lane's one journey covers no spec section-12 scenario at all (see
 * `doesNotProve`). Recording the honest number is the point.
 */
export const V0_2_DEFERRED_SCENARIOS: readonly string[] = Object.freeze([
  "CR-J1-001", "CR-J2-001", "CR-J2-002", "CR-J2-003", "CR-J3-001", "CR-J3-002",
  "CR-J3-003", "CR-J4-001", "CR-J4-002", "CR-J5-001", "CR-J5-002", "CR-S9-001",
  "CR-S10-001", "CR-S11-001", "CR-A11Y-002", "CR-LAG-001", "CR-DOC-001",
]);
