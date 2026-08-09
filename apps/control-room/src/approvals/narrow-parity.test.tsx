import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { ActionBar, ShellFrame } from "../shell/frame.js";
import { CORE_SURFACE_FIXTURES } from "../a11y/ui-wide-core-fixtures.js";
import type { SurfaceFixture } from "../a11y/ui-wide-core-fixtures.js";
import { OPS_SURFACE_FIXTURES } from "../a11y/ui-wide-ops-fixtures.js";

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
 * DoD 5's table clause is NOT-APPLICABLE, and this is its premise rather than a
 * claim about it: section 4.16's table wording targets the Runs/leases (4.11)
 * and Resources (4.12) surfaces, and neither exists. Written as a tripwire
 * instead of a sentence in a note, because task-ddb3bf77 is building exactly
 * those surfaces — the day it lands, this goes RED and whoever lands it is told
 * the clause has become applicable. A not-applicable recorded only in prose
 * would have gone silently stale.
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

it("records the table clause not-applicable, and fails when its premise expires", () => {
  // This file names both ids to describe the premise, so it would flag itself.
  // Excluded by path, and the exclusion is asserted to have removed exactly one
  // entry so a future rename cannot silently widen it.
  const scanned = sourceFiles(SOURCE_ROOT);
  const files = scanned.filter((file) => file !== THIS_FILE);
  expect(scanned.length - files.length).toBe(1);
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return source.includes("cr.runs") || source.includes("cr.resources");
  });
  expect(offenders.map((file) => file.slice(SOURCE_ROOT.length + 1))).toEqual([]);
});
