import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";

import { BoardJ1 } from "./board-j1.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

it("renders truthful phase indices, counts, and stable card identity", () => {
  render(<BoardJ1 cards={[{
    column: "review",
    name: "Fix the stale-port crash",
    nodeId: "node-j1",
    phase: "WORK_REVIEW",
    truthClass: "OBSERVED",
  }]} facts={[]} />);

  const planning = screen.getByTestId("cr.board.column.plan");
  expect(planning.className).toContain("cr-board-lane--empty");
  expect(within(planning).getByTestId("cr.board.lane.index.plan").textContent).toBe("01");
  expect(within(planning).getByTestId("cr.board.lane.count.plan").textContent).toBe("00");
  expect(within(planning).getByTestId("cr.board.lane.count.plan").getAttribute("aria-label"))
    .toBe("0 cards");

  const review = screen.getByTestId("cr.board.column.review");
  expect(review.className).not.toContain("cr-board-lane--empty");
  expect(within(review).getByTestId("cr.board.lane.index.review").textContent).toBe("04");
  expect(within(review).getByTestId("cr.board.lane.count.review").textContent).toBe("01");
  expect(within(review).getByTestId("cr.board.lane.count.review").getAttribute("aria-label"))
    .toBe("1 card");

  const card = screen.getByTestId("cr.board.card.node-j1");
  expect(card.className).toContain("cr-board-card");
  expect(within(card).getByTestId("cr.board.card.id").textContent).toBe("node-j1");
});

it("scopes the card surface style to the article rather than its named children", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/preview-board.css"), "utf8");
  expect(css).toContain(".cr-board-card {");
  expect(css).toContain("border-block-start: 3px solid var(--cr-line-strong);");
  expect(css).not.toContain('[data-testid^="cr.board.card."] {');
  expect(css).not.toContain("border-block-start: 3px solid var(--cr-attention);");
});
