import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNextAllowedCommands } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { ActionBar, ShellFrame } from "../shell/frame.js";
import { CORE_SURFACE_FIXTURES } from "../a11y/ui-wide-core-fixtures.js";
import type { SurfaceFixture } from "../a11y/ui-wide-core-fixtures.js";
import { OPS_SURFACE_FIXTURES } from "../a11y/ui-wide-ops-fixtures.js";
import type { PresentedFact } from "../nodes/node-authority.js";
import { ResourcesSurface } from "../resources/resources-surface.js";
import type { ResourceProjection } from "../resources/resources-surface.js";
import { RunsSurface } from "../runs/runs-surface.js";
import { SUSPECT_SENTENCE } from "../runs/runs-contract.js";
import type { RunLeaseProjection } from "../runs/runs-contract.js";

/**
 * Spec section 4.16, "no column removed, only reflowed", in the one form this
 * harness can actually check.
 *
 * "Two-line rows" is a pixel property and jsdom measures every box at 0, so it
 * is not assertable here and is not asserted. What IS assertable is the
 * STRUCTURAL half: the set of test-ids a surface renders at narrow width equals
 * the set it renders wide. A field that vanished below 960px would break that
 * equality; a field that merely moved would not.
 *
 * The whole file is worthless if narrow mode never engages — it would compare a
 * tree against itself and pass. The second case below exists solely to prove it
 * engages, and every parity row asserts both id sets are NON-EMPTY before
 * comparing, because two empty sets are equal.
 *
 * WHY A CROSS-SURFACE SWEEP LIVES UNDER approvals/. It reads fixtures from
 * a11y/ but is owned by the section 4.16 reflow task, whose owned paths are
 * board/ and approvals/. board/ is listing-frozen by goals-board-ban.test.ts;
 * approvals/ is frozen by nothing, so this is the compliant home. Reading from
 * a11y/ is not editing it. Do not "tidy" this back into a11y/ — that directory
 * belongs to task-ab8c9489 and the move is what this task was rejected for.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Comfortable rung, and below the 960 rung: see shell/viewport.ts VIEWPORT_WIDTH_LADDER. */
const WIDE = 1_440;
const NARROW = 720;
const ORIGINAL_WIDTH = window.innerWidth;
afterAll(() => { setViewportWidth(ORIGINAL_WIDTH); });

/** The technique shell/viewport.test.ts:13 established in this harness. */
function setViewportWidth(width: number): void {
  window.innerWidth = width;
  window.dispatchEvent(new Event("resize"));
}

const SURFACES: readonly SurfaceFixture[] = [...CORE_SURFACE_FIXTURES, ...OPS_SURFACE_FIXTURES];

function lagging(commands: readonly NextAllowedCommand[]): FixtureAffordanceSnapshot {
  const base = CONTROL_ROOM_FIXTURES.affordances.find((item) => item.connection === "LAGGING");
  if (base === undefined) throw new Error("missing LAGGING acceptance fixture");
  return Object.freeze({
    ...base,
    nextAllowedCommands: Object.freeze([...base.nextAllowedCommands, ...commands]),
  });
}

/**
 * The surface is wrapped in a marker so the sweep reads the SURFACE subtree and
 * not the shell chrome around it. NavRail and InspectorSheet legitimately take a
 * `narrow` prop and may render differently; that is task-3e3275476's contract,
 * not a section 4.16 violation, and folding it in here would make this sweep
 * fail for the wrong reason.
 */
function mountAt(fixture: SurfaceFixture, width: number): HTMLElement {
  setViewportWidth(width);
  const rendered = render(
    <ShellFrame affordance={lagging(fixture.commands)}>
      <ActionBar />
      <div data-parity-surface="true">{fixture.render()}</div>
    </ShellFrame>,
  );
  return rendered.container;
}

function surfaceTestIds(container: HTMLElement): ReadonlySet<string> {
  const region = container.querySelector<HTMLElement>("[data-parity-surface]");
  if (region === null) throw new Error("the parity surface region did not render");
  const nodes = [...region.querySelectorAll<HTMLElement>("[data-testid]")];
  return new Set(nodes.map((node) => node.dataset["testid"] ?? ""));
}

function narrowMarker(container: HTMLElement): string | undefined {
  const root = container.querySelector<HTMLElement>("[data-testid=\"cr.shell.root\"]");
  if (root === null) throw new Error("cr.shell.root did not render");
  return root.dataset["narrow"];
}

const sorted = (ids: ReadonlySet<string>): readonly string[] => [...ids].sort();

describe("section 4.16 narrow parity", () => {
  it("sweeps a non-empty surface list, each surface exactly once", () => {
    // Rail: a generated case list must assert it generated cases. A sweep that
    // silently produced zero rows would pass every parity assertion below.
    expect(SURFACES.length).toBe(15);
    const ids = SURFACES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("actually enters narrow mode, so the sweep cannot compare a tree to itself", () => {
    // THE load-bearing case. Without it every parity row below passes trivially
    // whether or not narrow mode exists: a tree always equals itself. This
    // asserts the real substrate from task-3e3275476 is engaged, by reading the
    // marker frame.tsx puts on cr.shell.root.
    const fixture = SURFACES[0];
    if (fixture === undefined) throw new Error("no surface fixture to probe");

    expect(narrowMarker(mountAt(fixture, WIDE))).toBeUndefined();
    cleanup();
    expect(narrowMarker(mountAt(fixture, NARROW))).toBe("true");
  });

  it.each(SURFACES.map((fixture) => [fixture.id, fixture] as const))(
    "renders the same field set wide and narrow on %s",
    (_id, fixture) => {
      const wide = surfaceTestIds(mountAt(fixture, WIDE));
      cleanup();
      const narrow = surfaceTestIds(mountAt(fixture, NARROW));

      // Non-empty FIRST, on both sides: a surface that rendered nothing would
      // otherwise satisfy the equality below while proving nothing at all.
      expect(wide.size).toBeGreaterThan(0);
      expect(narrow.size).toBeGreaterThan(0);
      expect(sorted(narrow)).toEqual(sorted(wide));
    },
  );

  it("keeps board card content unchanged at narrow width", () => {
    // Spec 4.16 clause 3's remainder. board-layout.css already carries the
    // column reflow; the part CSS cannot promise is that no card field was
    // dropped on the way, which is a DOM fact.
    const board = SURFACES.find((fixture) => fixture.id === "board-surface");
    if (board === undefined) throw new Error("board-surface fixture is missing");
    const cards = (ids: ReadonlySet<string>): readonly string[] =>
      [...ids].filter((id) => id.startsWith("cr.board.card.") || id.startsWith("cr.fact.")).sort();

    const wide = cards(surfaceTestIds(mountAt(board, WIDE)));
    cleanup();
    const narrow = cards(surfaceTestIds(mountAt(board, NARROW)));

    expect(wide.length).toBeGreaterThan(0);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow).toEqual(wide);
  });
});

/**
 * Section 4.16's table clause, now that it has a subject.
 *
 * task-fdf3e6aa recorded that clause not-applicable because the two table-shaped
 * surfaces its wording targets — Runs (4.11) and Resources (4.12) — did not
 * exist. Commit 0fd712b landed both, so the exemption expired and these rows are
 * the parity assertion the clause always wanted, in the SAME SHAPE the sweep
 * above uses for every other surface: mountAt wide, mountAt narrow, both id sets
 * asserted NON-EMPTY, then compared. The source scan at the end of this file
 * records that the surfaces exist; it is not, and never was, this assertion.
 *
 * The fixtures are held in a SEPARATE list rather than pushed into
 * CORE_/OPS_SURFACE_FIXTURES: those arrays and the 15-count tripwire above
 * belong to the a11y task. The first case asserts the separation still holds.
 */
const obs = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const ver = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

const RUN_TARGET = "session-w-3";
const RESOURCE_TARGET = "resource-db-main";

/**
 * `lease.extend` and `resource.release` are real RUNTIME_COMMAND_KINDs. An invented kind
 * is dropped by the builder with no error, which would leave the fixture's action subtree
 * empty and shrink the compared id set without failing anything.
 */
function affordances(kind: string, targetAggregateId: string): readonly NextAllowedCommand[] {
  return buildNextAllowedCommands({ aggregate: "PROJECT", state: "QUIESCED" }, [{
    commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${kind}`,
    commandKind: kind, expectedVersion: 1,
    inputSchemaVersion: "moe-runtime-command-input/1", targetAggregateId,
  }]);
}

const RUN_COMMANDS = affordances("lease.extend", RUN_TARGET);
const RESOURCE_COMMANDS = affordances("resource.release", RESOURCE_TARGET);

function run(overrides: Partial<RunLeaseProjection> = {}): RunLeaseProjection {
  return {
    actionTargetId: RUN_TARGET, activitySilence: obs("quiet 41m"), epoch: ver("epoch 7"),
    expiry: ver("expires in 4m"), gracePolicy: ver("grace 5m"), leaseState: ver("ACTIVE"),
    node: obs("api-endpnt"), owner: obs("worker"), renewalSilence: obs("renewed 41s ago"),
    role: obs("worker"), sessionId: "w-3", suspectSentence: null, ...overrides,
  };
}

const RESOURCE_ROW: ResourceProjection = {
  actionTargetId: RESOURCE_TARGET, holder: obs("w-3"), holdingTask: obs("api-endpnt"),
  leaseExpiry: ver("expires in 12m"), resourceId: "db-main",
  waiters: [
    { priority: obs("P3"), waiterId: "w-7", waiting: obs("waiting 2m") },
    { priority: obs("P1"), waiterId: "w-4", waiting: obs("waiting 30s") },
  ],
};

/**
 * Section 4.16's table bullet, quoted whole from the pinned spec (SHA-256
 * C55AF8A9FC7386E6492FD57E34A4B8321ABAAE4E4E08FF38703544B58B0BEF1F, line 432):
 *
 *   "Tables drop to two-line rows; no column removed, only reflowed."
 *
 * One sentence, two obligations, and only one of them is checkable here:
 *
 * (a) "no column removed, only reflowed" is a FIELD-SET property. Mount at both
 *     breakpoints, compare the rendered id sets. THAT IS WHAT THIS BLOCK DOES.
 *
 * (b) "Tables drop to two-line rows" is a PIXEL property of rendered layout.
 *     jsdom evaluates no CSS and measures every box at 0, and Vitest stubs the
 *     CSS import so document.styleSheets is empty. There is no assertion this
 *     suite can make about (b) that would not be theatre. It needs a real
 *     browser harness, and until one exists (b) is recorded as an explicit
 *     not-applicable WITH its reason — never as a passing assertion over zero
 *     cases, which is the vacuity epic rail 6 forbids.
 *
 * Runs and Resources are held HERE rather than added to CORE_/OPS_SURFACE_FIXTURES
 * on purpose: those lists drive several sweeps beyond parity, and a table surface
 * joining them would silently opt into audits nobody evaluated for table
 * semantics. The exclusion is asserted below, so the two sweeps cannot overlap
 * and the 15-count neither moves nor needs to.
 */
const TABLE_SURFACES: readonly SurfaceFixture[] = [
  {
    commands: RUN_COMMANDS, id: "runs-surface",
    render: () => <RunsSurface rows={[run(), run({
      leaseState: ver("SUSPECT"), sessionId: "w-9",
      suspectSentence: ver(SUSPECT_SENTENCE),
    })]} />,
  },
  {
    commands: RESOURCE_COMMANDS, id: "resources-surface",
    render: () => <ResourcesSurface rows={[RESOURCE_ROW]} />,
  },
];

describe("section 4.16 table clause on Runs and Resources", () => {
  it("sweeps both table surfaces, each generated with its affordances intact", () => {
    expect(TABLE_SURFACES.length).toBe(2);
    expect(RUN_COMMANDS).toHaveLength(1);
    expect(RESOURCE_COMMANDS).toHaveLength(1);
    const swept = new Set(SURFACES.map((fixture) => fixture.id));
    expect(TABLE_SURFACES.filter((fixture) => swept.has(fixture.id))).toEqual([]);
  });

  it.each(TABLE_SURFACES.map((fixture) => [fixture.id, fixture] as const))(
    "renders the same field set wide and narrow on %s",
    (_id, fixture) => {
      const wide = surfaceTestIds(mountAt(fixture, WIDE));
      cleanup();
      const narrow = surfaceTestIds(mountAt(fixture, NARROW));

      // Non-empty FIRST, on both sides, for the same reason as the sweep above.
      expect(wide.size).toBeGreaterThan(0);
      expect(narrow.size).toBeGreaterThan(0);
      expect(sorted(narrow)).toEqual(sorted(wide));
    },
  );
});

/**
 * DoD 5's table clause WAS not-applicable, on the premise that section 4.16's
 * table wording targets the Runs/leases (4.11) and Resources (4.12) surfaces
 * and neither existed. task-fdf3e6aa wrote that premise as a tripwire instead
 * of a sentence in a note so it could not go silently stale, and it worked
 * exactly as designed: commit 0fd712b landed both surfaces and this went RED.
 *
 * The premise has expired, so the assertion is INVERTED rather than deleted. It
 * now holds the opposite fact — those surfaces exist — and so it still reddens
 * if they are removed or renamed.
 *
 * This scan is a ratchet on EXISTENCE and nothing more. It is not the table
 * clause's parity assertion and must never be read as one: it reads source text
 * and never mounts anything. The parity assertion is the TABLE_SURFACES block
 * above, which mounts both surfaces at 1440 and 720 and compares id sets. The
 * two are kept side by side because they fail for different reasons — delete the
 * surfaces and the scan reddens; drop a field below 960px and the parity rows
 * redden. The 15-surface sweep is untouched.
 *
 * The remaining half of section 4.16 — "Tables drop to two-line rows" — is NOT
 * owned by a pending task. It is a pixel property, jsdom evaluates no CSS, and
 * no assertion in this suite can reach it; see the quotation and the (a)/(b)
 * split above the TABLE_SURFACES block. It is recorded as an explicit
 * not-applicable with that reason, and certifying it would require a real
 * browser harness this package does not have. Do not convert this into a test.
 *
 * Each id is checked SEPARATELY. The absence form could collapse both into one
 * OR because any single hit failed it; the presence form cannot, or one surface
 * could vanish while the other alone kept this green.
 */
const THIS_FILE = fileURLToPath(import.meta.url);
const SOURCE_ROOT = join(dirname(THIS_FILE), "..");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

it("records the table clause now applicable, and fails if its subject disappears", () => {
  // This file names both ids to describe the clause, so it would satisfy itself.
  // Excluded by path, and the exclusion is asserted to have removed exactly one
  // entry so a future rename cannot silently widen it.
  const scanned = sourceFiles(SOURCE_ROOT);
  const files = scanned.filter((file) => file !== THIS_FILE);
  expect(scanned.length - files.length).toBe(1);
  expect(files.length).toBeGreaterThan(0);
  const bearers = (id: string): readonly string[] =>
    files
      .filter((file) => readFileSync(file, "utf8").includes(id))
      .map((file) => file.slice(SOURCE_ROOT.length + 1));
  const absent = ["cr.runs", "cr.resources"].filter((id) => bearers(id).length === 0);
  expect(absent).toEqual([]);
}, 20_000);
