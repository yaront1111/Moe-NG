import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
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

/** Class-count specificity: the peer sheet's rules are single-class, so >= 2 wins. */
function classCount(selector: string): number {
  return (selector.match(/\.[a-z0-9-]+/gu) ?? []).length;
}

/**
 * Asserts the shipped sheet declares `property: value` in a rule that selects
 * this very element and outranks a single-class rule in the peer stylesheet.
 */
function expectStyled(element: Element, property: string, value: string): void {
  const pattern = new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`, "u");
  const winners = CARD_RULES.filter((rule) =>
    pattern.test(rule.declarations) && classCount(rule.selector) >= 2 && element.matches(rule.selector));
  expect(
    winners.map((rule) => rule.selector),
    `no goal-card.css rule sets ${property}:${value} on <${element.tagName.toLowerCase()} class="${element.className}">`,
  ).not.toHaveLength(0);
}

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

function renderCard(overrides: Partial<GoalCardModel> = {}, expanded = false): HTMLElement {
  render(
    <GoalCard
      expanded={expanded}
      goal={liveModel(overrides)}
      onOpenBoard={vi.fn()}
      onToggleExpand={vi.fn()}
    />,
  );
  return screen.getByTestId("cr.goals.card.goal-live-1");
}

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
    const label = screen.getByTestId("cr.goals.card.goal-live-1.progress");
    expect(top).not.toBeNull();
    expect(budget).not.toBeNull();

    expectStyled(top as Element, "flex-wrap", "wrap");
    expectStyled(budget as Element, "flex-wrap", "wrap");
    expectStyled(label, "white-space", "nowrap");
    expect(CARD_TSX).toContain('import "./goal-card.css"');
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
    expectStyled(strip, "max-width", "[0-9]+px");
    expect(TRIAGE_TSX).toContain('import "./goal-card.css"');
  });
});
