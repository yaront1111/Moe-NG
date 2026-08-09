import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { BoardCardProjection, BoardJoinSummary } from "../board/board-contract.js";
import { BoardSurface } from "../board/board-surface.js";
import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { ActionBar, ShellFrame } from "../shell/frame.js";
import { auditTruthClassMonochrome } from "./surface-audit.js";
import { CORE_SURFACE_FIXTURES } from "./ui-wide-core-fixtures.js";
import type { SurfaceFixture } from "./ui-wide-core-fixtures.js";
import { OPS_SURFACE_FIXTURES } from "./ui-wide-ops-fixtures.js";

/**
 * Spec section 11.1 bullet 1, the NON-chip half: no colour-only encoding anywhere. The
 * truth-chip half is already covered by `auditTruthClassMonochrome`, which this file
 * CONSUMES rather than reimplements; what was uncovered until now is the board's own
 * overlays, badges and indicators, which are asserted here against real rendered
 * surfaces rather than fragments.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const SURFACES: readonly SurfaceFixture[] = [...CORE_SURFACE_FIXTURES, ...OPS_SURFACE_FIXTURES];

const INDICATOR_SELECTOR = [
  "[data-testid^='cr.board.']",
  "[data-testid^='cr.fact.']",
  "[data-testid^='cr.chip.']",
].join(", ");

/**
 * Loading placeholders are empty by design (`board-surface.tsx` renders
 * `<div data-testid="cr.board.skeleton" />`). They encode nothing at all, in colour or
 * otherwise, so sweeping them would make this guard red against correct production code.
 */
const PLACEHOLDER_SUFFIXES = Object.freeze([".skeleton", ".loading"]);

interface IndicatorViolation {
  readonly code: "INDICATOR_COLOUR_ONLY";
  readonly testId: string;
}

function lagging(commands: readonly NextAllowedCommand[]): FixtureAffordanceSnapshot {
  const base = CONTROL_ROOM_FIXTURES.affordances.find((item) => item.connection === "LAGGING");
  if (base === undefined) throw new Error("missing LAGGING acceptance fixture");
  return Object.freeze({
    ...base,
    nextAllowedCommands: Object.freeze([...base.nextAllowedCommands, ...commands]),
  });
}

function mountSurface(fixture: SurfaceFixture): HTMLElement {
  return render(
    <ShellFrame affordance={lagging(fixture.commands)}>
      <ActionBar />
      {fixture.render()}
    </ShellFrame>,
  ).container;
}

/** The five section 11.1 overlays the board card renders as text-labelled facts. */
const BOARD_OVERLAYS = Object.freeze([
  "criticalpath", "disposition", "held", "qualification", "suspect",
]);

function boardCard(nodeId: string): BoardCardProjection {
  const fact = Object.freeze({ truthClass: "OBSERVED", value: "supplied" } as const);
  return Object.freeze({
    actionTargetId: nodeId, activitySilence: fact, blockerOwner: fact,
    blockerReason: fact, blockerType: fact, budgetBasis: fact, budgetSpent: fact,
    criticalPath: fact, disposition: fact, held: fact, latestClaim: fact,
    leaseEpoch: fact, leaseExpiry: fact, leaseState: fact, nodeId, owner: fact,
    phase: fact, placement: "ready", progress: fact, qualification: fact,
    renewalSilence: fact, slack: fact, sourceAggregate: "goal-colour", suspect: fact,
    title: nodeId, waitOwner: fact, waitReason: fact, waitRecheck: fact,
  });
}

const JOIN: BoardJoinSummary = Object.freeze({
  inputs: Object.freeze({ truthClass: "OBSERVED", value: "2 of 3" } as const),
  joinId: "join-colour",
  summary: Object.freeze({ truthClass: "DAEMON_VERIFIED", value: "waiting" } as const),
});

function mountBoard(): HTMLElement {
  return render(
    <ShellFrame affordance={lagging([])}>
      <BoardSurface cards={[boardCard("colour-node")]} frontier={[]} joins={[JOIN]}
        loadedEmptyColumns={[]} showTerminated={false} />
    </ShellFrame>,
  ).container;
}

function testId(element: Element): string {
  return element.getAttribute("data-testid") ?? "";
}

function text(element: Element | null): string {
  return (element?.textContent ?? "").trim();
}

function label(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "").trim();
}

/**
 * `<label for>` is how the board names its checkbox and its column jump, so reading only
 * `aria-label`/`title` would report two correct controls as colour-only. An accessible
 * name is an accessible name however it is supplied.
 */
function accessibleName(element: Element): string {
  const direct = label(element);
  if (direct !== "") return direct;
  const document_ = element.ownerDocument;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const named = labelledBy.split(/\s+/u)
      .map((id) => text(document_.getElementById(id)))
      .filter((value) => value !== "")
      .join(" ");
    if (named !== "") return named;
  }
  const id = element.getAttribute("id");
  const associated = id === null ? null : document_.querySelector(`label[for="${id}"]`);
  return associated === null ? text(element.closest("label")) : text(associated);
}

const CONTROL_TAGS = Object.freeze(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

/**
 * An element that renders NOTHING encodes nothing, in colour or otherwise, and so cannot
 * be a colour-only violation: `cr.board.joinstrip` is an empty live region until a join
 * arrives. Anything that renders — text, children, a control, a role, or a tone attribute
 * a stylesheet can colour — must carry its meaning textually.
 */
function encodesSomething(element: Element): boolean {
  if (text(element) !== "" || element.children.length > 0) return true;
  if (CONTROL_TAGS.includes(element.tagName)) return true;
  return ["data-tone", "data-truth-class", "role"].some(
    (attribute) => element.getAttribute(attribute) !== null,
  );
}

function child(element: Element, id: string): Element | null {
  return element.querySelector(`[data-testid='${id}']`);
}

/**
 * A fact must name WHAT it reports and WHAT it says. Value alone is meaningless without
 * its label, and a wrapper's own `textContent` would hide a blanked label behind its
 * siblings' text, so both channels are read separately.
 */
function factCarriesText(element: Element): boolean {
  return text(child(element, "cr.label")) !== "" && text(child(element, "cr.value")) !== "";
}

/** A chip's meaning is its accessible name plus a glyph or short label — never its tone. */
function chipCarriesText(element: Element): boolean {
  if (label(element) === "") return false;
  return text(child(element, "cr.glyph")) !== "" || text(child(element, "cr.shortlabel")) !== "";
}

function carriesMeaning(element: Element): boolean {
  const id = testId(element);
  if (id.startsWith("cr.fact.")) return factCarriesText(element);
  if (id.startsWith("cr.chip.")) return chipCarriesText(element);
  if (!encodesSomething(element)) return true;
  return text(element) !== "" || accessibleName(element) !== "";
}

function indicators(root: ParentNode): readonly Element[] {
  return [...root.querySelectorAll(INDICATOR_SELECTOR)].filter(
    (element) => !PLACEHOLDER_SUFFIXES.some((suffix) => testId(element).endsWith(suffix)),
  );
}

function auditColourIndependence(root: ParentNode): {
  readonly checked: number;
  readonly violations: readonly IndicatorViolation[];
} {
  const swept = indicators(root);
  const violations = swept
    .filter((element) => !carriesMeaning(element))
    .map((element) => Object.freeze<IndicatorViolation>({
      code: "INDICATOR_COLOUR_ONLY",
      testId: testId(element),
    }));
  return Object.freeze({ checked: swept.length, violations: Object.freeze(violations) });
}

describe("section 11.1 bullet 1 holds beyond the truth chips", () => {
  it("sweeps a non-empty canonical surface set", () => {
    expect(SURFACES.length).toBeGreaterThan(0);
  });

  it.each(SURFACES)("$id encodes every indicator in text or glyph, not colour", (fixture) => {
    const result = auditColourIndependence(mountSurface(fixture));
    // Epic rail 6: a sweep that silently matched nothing would pass the line below while
    // testing nothing, so the swept count is asserted first.
    expect(result.checked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("covers the board's own card overlays, which the shared fixture never renders", () => {
    // `ui-wide-core-fixtures.tsx` builds the board surface with `cards={[]}`, so every
    // card overlay is outside the fixture sweep above. This arm renders the production
    // BoardSurface with real cards and a real join so the overlays exist to be audited.
    const root = mountBoard();
    const swept = indicators(root).map(testId);
    for (const overlay of BOARD_OVERLAYS) {
      expect(swept.some((id) => id.endsWith(`.${overlay}`))).toBe(true);
    }
    const result = auditColourIndependence(root);
    expect(result.checked).toBeGreaterThan(BOARD_OVERLAYS.length);
    expect(result.violations).toEqual([]);
  });

  it("consumes the existing truth-chip audit instead of reimplementing it", () => {
    expect(auditTruthClassMonochrome()).toEqual({ checked: 5, violations: [] });
  });
});
