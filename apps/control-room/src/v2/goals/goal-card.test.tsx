import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GoalCard } from "./goal-card.js";
import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { TriageStrips } from "./triage-strips.js";
import type { GoalCardModel } from "./goal-model.js";

/**
 * The goal card's own layout guards (goalshome-04 / -07 / -08).
 *
 * jsdom does not lay out, so a width cannot be measured here. What CAN be pinned
 * is the two things that actually decide the layout: which element the card puts
 * a chip in, and whether the shipped stylesheet carries a rule that really
 * selects that rendered element. Every CSS arm therefore parses goal-card.css and
 * asks the live DOM node `matches(selectorText)` - a renamed class, a dropped
 * rule, or a selector that is too weak to beat the peer sheet all turn it red.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Vitest runs with the package as cwd (see the package `test` script). */
const GOALS_DIRECTORY = join(process.cwd(), "src", "v2", "goals");
const CARD_CSS = readFileSync(join(GOALS_DIRECTORY, "goal-card.css"), "utf8");
const CARD_TSX = readFileSync(join(GOALS_DIRECTORY, "goal-card.tsx"), "utf8");
const TRIAGE_TSX = readFileSync(join(GOALS_DIRECTORY, "triage-strips.tsx"), "utf8");

interface CssRule {
  readonly selector: string;
  readonly declarations: string;
}

/** Every top-level rule in a flat stylesheet, comments stripped. */
function rulesOf(css: string): readonly CssRule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: CssRule[] = [];
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    rules.push({ selector: (match[1] ?? "").trim(), declarations: match[2] ?? "" });
  }
  return rules;
}

const CARD_RULES = rulesOf(CARD_CSS);
const NO_DURABLE_RUN_REASON = "No durable planning run is recorded for this goal.";

/** Class-count specificity: the peer sheet's rules are single-class, so >= 2 wins. */
function classCount(selector: string): number {
  return (selector.match(/\.[a-z0-9-]+/gu) ?? []).length;
}

function describeElement(element: Element): string {
  return `<${element.tagName.toLowerCase()} class="${element.className}">`;
}

/** The goal-card.css rules declaring `property: value` that select this element and outrank the peer sheet. */
function winningRules(element: Element, property: string, value: string): readonly CssRule[] {
  const pattern = new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`, "u");
  return CARD_RULES.filter((rule) =>
    pattern.test(rule.declarations) && classCount(rule.selector) >= 2 && element.matches(rule.selector));
}

/**
 * Asserts the shipped sheet declares `property: value` in a rule that selects
 * this very element and outranks a single-class rule in the peer stylesheet.
 */
function expectStyled(element: Element, property: string, value: string): void {
  expect(
    winningRules(element, property, value).map((rule) => rule.selector),
    `no goal-card.css rule sets ${property}:${value} on ${describeElement(element)}`,
  ).not.toHaveLength(0);
}

/**
 * The px number the one winning rule declares for `property`, parsed out so an
 * arm can bound the VALUE - a cap that caps nothing still "declares some px".
 */
function winningPx(element: Element, property: string): number {
  const winners = winningRules(element, property, "[0-9]+px");
  expect(
    winners.map((rule) => rule.selector),
    `expected exactly one goal-card.css rule setting ${property} in px on ${describeElement(element)}`,
  ).toHaveLength(1);
  const match = new RegExp(`${property}\\s*:\\s*([0-9]+)px`, "u").exec(winners[0]?.declarations ?? "");
  return Number(match?.[1]);
}

/** Every value goal-card.css declares for `property` in ANY rule that selects this element. */
function declaredValues(element: Element, property: string): readonly string[] {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]*?)\\s*(?:;|$)`, "gu");
  return CARD_RULES
    .filter((rule) => element.matches(rule.selector))
    .flatMap((rule) => [...rule.declarations.matchAll(pattern)].map((match) => match[1] ?? ""));
}

/** The `white-space` / `text-wrap` values under which a run of text may still break onto a new line. */
const WRAPPING_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "white-space": new Set(["normal", "pre-wrap", "pre-line", "break-spaces"]),
  "text-wrap": new Set(["wrap", "balance", "pretty", "stable"]),
});

function liveModel(overrides: Partial<GoalCardModel> = {}): GoalCardModel {
  const base = FIXTURE_GOALS_DATA.goals[0] as GoalCardModel;
  return {
    ...base,
    goalId: "goal-live-1",
    progress: { done: 7, total: 16, noun: "committed" },
    lastEventLabel: undefined,
    budgetLabel: undefined,
    budgetTruthClass: undefined,
    comingOnlineFacts: [{ label: "Supplied-facts bundle", reason: "A later route carries the bundle." }],
    ...overrides,
  };
}

function renderCard(
  overrides: Partial<GoalCardModel> = {},
  expanded = false,
  onOpenBoard = vi.fn(),
): HTMLElement {
  render(
    <GoalCard
      expanded={expanded}
      goal={liveModel(overrides)}
      onOpenBoard={onOpenBoard}
      onToggleExpand={vi.fn()}
    />,
  );
  return screen.getByTestId("cr.goals.card.goal-live-1");
}

describe("a goal without a durable planning run has no board-opening door", () => {
  it("renders a disabled Open control with the exact missing-run reason", () => {
    renderCard({ planningRunRef: undefined });

    const open = screen.getByTestId("cr.goals.card.goal-live-1.open-unavailable") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toBe(NO_DURABLE_RUN_REASON);
    expect(open.getAttribute("aria-label"))
      .toBe(`Open board unavailable for Ship the J1 vertical slice: ${NO_DURABLE_RUN_REASON}`);
  });

  it("does not invoke onOpenBoard when the disabled Open control is clicked", () => {
    const onOpenBoard = vi.fn();
    renderCard({ planningRunRef: undefined }, false, onOpenBoard);

    const open = screen.getByTestId("cr.goals.card.goal-live-1.open-unavailable") as HTMLButtonElement;
    fireEvent.click(open);
    // The MECHANISM, not merely the outcome. `not.toHaveBeenCalled()` alone cannot
    // tell a control that is inert because it is disabled from one that is enabled
    // and wired to a no-op - and a no-op handler is the same hole one refactor away
    // from being re-pointed at onOpenBoard. Pin what makes the click do nothing.
    expect(open.disabled).toBe(true);
    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  it("enables Open only for a non-empty planningRunRef", () => {
    const onOpenBoard = vi.fn();
    renderCard({ planningRunRef: "run-live-1" }, false, onOpenBoard);

    const open = screen.getByTestId("cr.goals.card.goal-live-1.open") as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    expect(onOpenBoard).toHaveBeenCalledTimes(1);

    cleanup();
    onOpenBoard.mockClear();
    renderCard({ planningRunRef: "" }, false, onOpenBoard);
    const unavailable = screen.getByTestId("cr.goals.card.goal-live-1.open-unavailable") as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  it("also disables the title button so it cannot open the board", () => {
    const onOpenBoard = vi.fn();
    renderCard({ planningRunRef: undefined }, false, onOpenBoard);

    const title = screen.getByTestId("cr.goals.card.goal-live-1.title") as HTMLButtonElement;
    fireEvent.click(title);
    expect(title.disabled).toBe(true);
    expect(title.title).toBe(NO_DURABLE_RUN_REASON);
    // `title` is announced inconsistently, so the reason must also reach the
    // accessible name - and without discarding the goal title the button carries.
    expect(title.getAttribute("aria-label"))
      .toBe(`Ship the J1 vertical slice: ${NO_DURABLE_RUN_REASON}`);
    expect(onOpenBoard).not.toHaveBeenCalled();
  });

  it("leaves the title button's own text as its accessible name once a run exists", () => {
    renderCard({ planningRunRef: "run-live-1" });

    const title = screen.getByTestId("cr.goals.card.goal-live-1.title") as HTMLButtonElement;
    expect(title.disabled).toBe(false);
    // No override in the reachable state: the name is the title text, and no stale
    // unavailability reason is left announcing itself on a card that can be opened.
    expect(title.getAttribute("aria-label")).toBeNull();
    expect(title.getAttribute("title")).toBeNull();
    expect(title.textContent).toBe("Ship the J1 vertical slice");
  });

  /**
   * The two states the Open control may ever render in. `unclassified` is not a
   * member: it is what `readOpenState` returns for anything else, so a third state
   * appearing lands OUTSIDE this set and the set-equality assertion reds.
   */
  const OPEN_STATES: readonly string[] = Object.freeze(["disabled-with-reason", "enabled-with-run"]);

  interface OpenStateCase {
    readonly caseId: string;
    readonly planningRunRef: string | undefined;
    readonly expected: string;
  }

  /** Frozen roster. Its exact size is asserted below - a silently shrunk matrix is the regression. */
  const OPEN_STATE_CASES: readonly OpenStateCase[] = Object.freeze([
    Object.freeze({ caseId: "absent", planningRunRef: undefined, expected: "disabled-with-reason" }),
    Object.freeze({ caseId: "empty", planningRunRef: "", expected: "disabled-with-reason" }),
    Object.freeze({ caseId: "blank", planningRunRef: "   ", expected: "disabled-with-reason" }),
    Object.freeze({ caseId: "run", planningRunRef: "run-live-1", expected: "enabled-with-run" }),
    Object.freeze({ caseId: "padded-run", planningRunRef: " run-live-2 ", expected: "enabled-with-run" }),
  ]);
  const EXPECTED_CASE_COUNT = 5;

  /**
   * Classifies the RENDERED control, never the model - the property has to be read
   * off the production surface, not recomputed by a helper that reimplements the rule.
   */
  function readOpenState(): string {
    const enabled = screen.queryByTestId("cr.goals.card.goal-live-1.open") as HTMLButtonElement | null;
    const unavailable = screen
      .queryByTestId("cr.goals.card.goal-live-1.open-unavailable") as HTMLButtonElement | null;
    if (enabled !== null && unavailable === null && !enabled.disabled) {
      return "enabled-with-run";
    }
    if (unavailable !== null && enabled === null
      && unavailable.disabled && unavailable.title === NO_DURABLE_RUN_REASON) {
      return "disabled-with-reason";
    }
    return `unclassified(open=${String(enabled !== null)},unavailable=${String(unavailable !== null)})`;
  }

  it("renders exactly the two Open states across the frozen case roster", () => {
    // The roster must be the size it claims: `length > 0` would survive a one-member matrix.
    expect(OPEN_STATE_CASES).toHaveLength(EXPECTED_CASE_COUNT);

    const observed: { caseId: string; state: string; titleDisabled: boolean }[] = [];
    for (const testCase of OPEN_STATE_CASES) {
      const onOpenBoard = vi.fn();
      renderCard({ planningRunRef: testCase.planningRunRef }, false, onOpenBoard);
      const title = screen.getByTestId("cr.goals.card.goal-live-1.title") as HTMLButtonElement;
      observed.push({ caseId: testCase.caseId, state: readOpenState(), titleDisabled: title.disabled });
      cleanup();
    }

    // The sweep actually generated cases: a zero-case loop passes every assertion below.
    expect(observed).toHaveLength(EXPECTED_CASE_COUNT);
    expect(observed.map((entry) => entry.caseId)).toEqual(OPEN_STATE_CASES.map((entry) => entry.caseId));

    // Each case renders the state it claims...
    expect(observed.map((entry) => `${entry.caseId}:${entry.state}`))
      .toEqual(OPEN_STATE_CASES.map((entry) => `${entry.caseId}:${entry.expected}`));
    // ...the second door tracks the same fact, so a disabled Open never sits beside a live title...
    expect(observed.map((entry) => `${entry.caseId}:${String(entry.titleDisabled)}`))
      .toEqual(OPEN_STATE_CASES.map((entry) => `${entry.caseId}:${String(entry.expected === "disabled-with-reason")}`));
    // ...and the rendered states are EXACTLY the two members, both directions.
    expect([...new Set(observed.map((entry) => entry.state))].sort()).toEqual([...OPEN_STATES].sort());
  });

  it("renders the exact absent-state control without a placeholder run identity", () => {
    renderCard({ planningRunRef: undefined });

    const open = screen.getByTestId("cr.goals.card.goal-live-1.open-unavailable");
    expect(open.getAttributeNames().sort()).toEqual([
      "aria-label", "class", "data-testid", "data-variant", "disabled", "title", "type",
    ]);
    expect(open.textContent).toBe("Open board \u2192");
    expect(open.getAttribute("data-testid")).toBe("cr.goals.card.goal-live-1.open-unavailable");
    expect(open.getAttribute("title")).toBe(NO_DURABLE_RUN_REASON);
  });
});

describe("goalshome-04: the last-event coming-online chip cannot overflow the progress row", () => {
  it("renders the chip under the bar, not beside the progress label", () => {
    const card = renderCard();
    const chip = screen.getByTestId("cr.goals.card.goal-live-1.lastevent.comingonline");
    expect(chip.textContent).toBe("LAST EVENT COMING ONLINE");
    expect(chip.closest(".cr2-goal-progress-top")).toBeNull();
    expect(chip.closest(".cr2-goal-budget")).not.toBeNull();

    const bar = card.querySelector(".cr2-goal-bar");
    expect(bar).not.toBeNull();
    // eslint-disable-next-line no-bitwise
    expect((bar as Element).compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const label = screen.getByTestId("cr.goals.card.goal-live-1.progress");
    expect(label.textContent).toBe("7 of 16 committed");
    expect(label.parentElement?.className).toBe("cr2-goal-progress-top");
    expect(label.parentElement?.children).toHaveLength(1);
    expect(screen.getByTestId("cr.goals.card.goal-live-1.budget.comingonline").textContent)
      .toBe("BUDGET COMING ONLINE");
  });

  it("keeps a supplied last-event label in the top row and renders no chip", () => {
    const card = renderCard({ lastEventLabel: "42S AGO" });
    expect(card.querySelector(".cr2-goal-progress-top .cr2-goal-lastevent")?.textContent).toBe("42S AGO");
    expect(screen.queryByTestId("cr.goals.card.goal-live-1.lastevent.comingonline")).toBeNull();
  });

  it("ships wrap rules that select the rendered rows, and imports the sheet", () => {
    const card = renderCard();
    const top = card.querySelector(".cr2-goal-progress-top");
    const budget = card.querySelector(".cr2-goal-budget");
    expect(top).not.toBeNull();
    expect(budget).not.toBeNull();

    expectStyled(top as Element, "flex-wrap", "wrap");
    expectStyled(budget as Element, "flex-wrap", "wrap");
    expect(CARD_TSX).toContain('import "./goal-card.css"');
  });

  it("lets a long progress noun wrap inside its column instead of running into Open board", () => {
    // The noun is a free string from the model ("acceptance criteria" passes the
    // column's 220px basis). The column has no overflow rule, so a label pinned to
    // one line would paint over the Open-board cell; nothing in this sheet may pin it.
    renderCard({ progress: { done: 7, total: 64, noun: "acceptance criteria" } });
    const label = screen.getByTestId("cr.goals.card.goal-live-1.progress");
    expect(label.textContent).toBe("7 of 64 acceptance criteria");
    for (const [property, wrapping] of Object.entries(WRAPPING_VALUES)) {
      const pinned = declaredValues(label, property).filter((value) => !wrapping.has(value));
      expect(pinned, `goal-card.css pins the progress label to one line via ${property}`).toEqual([]);
    }
  });
});

describe("goalshome-07: the expanded coming-online cell wraps instead of overflowing the card", () => {
  it("wraps the placeholder row and never lets its label run past the cell", () => {
    const card = renderCard({}, true);
    const row = screen.getByTestId("cr.goals.comingonline.suppliedfactsbundle");
    expect(row.textContent).toContain("Supplied-facts bundle");
    expect(row.textContent).toContain("COMING ONLINE");
    expect(row.closest(".cr2-goal-facts-cell")).not.toBeNull();
    expect(card.contains(row)).toBe(true);

    expectStyled(row, "flex-wrap", "wrap");
    const rowLabel = row.querySelector(".cr2-factrow-label");
    expect(rowLabel).not.toBeNull();
    expectStyled(rowLabel as Element, "overflow-wrap", "anywhere");
  });
});

describe("goalshome-08: a lone triage strip does not stretch the whole content width", () => {
  it("caps a rendered strip's width from the sheet the strips import", () => {
    render(
      <TriageStrips
        onSelect={vi.fn()}
        strips={[{ id: "ready", count: "9", label: "Ready to dispatch", sub: "no active claim", tone: "accent" }]}
      />,
    );
    const strip = screen.getByTestId("cr.goals.triage.ready");
    const cap = winningPx(strip, "max-width");
    // The designed strip is `flex: 1 1 240px` and three of them settle near 390px
    // each across the 1440px stage. A cap under the basis crushes a lone strip; one
    // past about half the content width caps nothing - the regression this rule exists
    // to prevent - so the value is bounded on both sides, not merely present.
    expect(cap).toBeGreaterThanOrEqual(240);
    expect(cap).toBeLessThanOrEqual(640);
    expect(TRIAGE_TSX).toContain('import "./goal-card.css"');
  });
});

describe("the progress label names the reason when the model carries one", () => {
  it("shows progressNote in place of the generic coming-online line", () => {
    const base = FIXTURE_GOALS_DATA.goals[0] as GoalCardModel;
    const goal: GoalCardModel = {
      ...base, goalId: "goal-note", progress: undefined, progressNote: "No PRD bound to this goal",
    };
    render(<GoalCard expanded={false} goal={goal} onOpenBoard={vi.fn()} onToggleExpand={vi.fn()} />);
    expect(screen.getByTestId("cr.goals.card.goal-note.progress").textContent).toBe("No PRD bound to this goal");
    cleanup();
    const plain: GoalCardModel = { ...base, goalId: "goal-plain", progress: undefined };
    render(<GoalCard expanded={false} goal={plain} onOpenBoard={vi.fn()} onToggleExpand={vi.fn()} />);
    expect(screen.getByTestId("cr.goals.card.goal-plain.progress").textContent).toBe("Progress coming online");
  });
});
