import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { act, cleanup, render, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { auditActionParity } from "../a11y/surface-audit.js";
import type { BoardCardProjection, BoardSurfaceProps } from "../board/board-contract.js";
import { BoardSurface } from "../board/board-surface.js";
import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { Fact } from "../kernel.js";
import { ActionBar, CONTROL_ROOM_NAV_ITEMS, ShellFrame } from "./frame.js";

const CSS_PATH = resolve(process.cwd(), "src", "shell", "shell-layout.css");
const CSS = existsSync(CSS_PATH) ? readFileSync(CSS_PATH, "utf8") : "";
const REDUCED_MOTION_MARKER = "@media (prefers-reduced-motion: reduce)";
const REDUCED_MOTION_CSS = CSS.includes(REDUCED_MOTION_MARKER)
  ? CSS.slice(CSS.indexOf(REDUCED_MOTION_MARKER))
  : "";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number): void {
  window.innerWidth = width;
}

afterEach(() => {
  cleanup();
  setWidth(ORIGINAL_WIDTH);
});

function lagging(): FixtureAffordanceSnapshot {
  const found = CONTROL_ROOM_FIXTURES.affordances.find((item) => item.connection === "LAGGING");
  if (found === undefined) throw new Error("missing LAGGING shell fixture");
  return found;
}

function boardCard(): BoardCardProjection {
  const fact = Object.freeze({ truthClass: "OBSERVED", value: "supplied" } as const);
  return Object.freeze({
    actionTargetId: "node-narrow", activitySilence: fact, blockerOwner: fact,
    blockerReason: fact, blockerType: fact, budgetBasis: fact, budgetSpent: fact,
    criticalPath: fact, disposition: fact, held: fact, latestClaim: fact,
    leaseEpoch: fact, leaseExpiry: fact, leaseState: fact, nodeId: "node-narrow",
    owner: fact, phase: fact, placement: "plan", progress: fact, qualification: fact,
    renewalSilence: fact, slack: fact, sourceAggregate: "goal-narrow", suspect: fact,
    title: "Narrow fixture", waitOwner: fact, waitReason: fact, waitRecheck: fact,
  });
}

const BOARD_PROPS: BoardSurfaceProps = {
  appliedCursorLabel: "cursor 4819",
  cards: [boardCard()],
  degraded: true,
  frontier: [],
  joins: [],
  loadedEmptyColumns: [],
  showTerminated: false,
};

function ShellFixture({ board = BOARD_PROPS }: {
  readonly board?: BoardSurfaceProps;
}): JSX.Element {
  return (
    <ShellFrame
      affordance={lagging()}
      inspector={(
        <>
          <p data-testid="cr.inspector.identity">inspector-42</p>
          <button data-testid="cr.inspector.focusable" type="button">Inspect receipt</button>
        </>
      )}
    >
      <ActionBar />
      <input aria-label="Fixture search" type="search" />
      <Fact factId="shell.identity" label="Identity" truthClass="OBSERVED" value="same" />
      <BoardSurface {...board} />
    </ShellFrame>
  );
}

function renderAt(width: number): ReturnType<typeof render> {
  setWidth(width);
  return render(<ShellFixture />);
}

function ids(root: ParentNode, selector: string): readonly string[] {
  return [...root.querySelectorAll(selector)]
    .map((element) => element.getAttribute("data-testid") ?? "")
    .sort();
}

describe("ShellFrame narrow state", () => {
  it("exposes the proof toggle on desktop and releases the inspector grid track", async () => {
    const rendered = renderAt(1_280);
    const root = within(rendered.container).getByTestId("cr.shell.root");
    const inspector = within(rendered.container).getByTestId("cr.shell.inspector");
    const toggle = within(rendered.container).getByTestId("cr.shell.inspector.toggle");
    expect(root.getAttribute("data-inspector")).toBe("open");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(toggle);

    expect(root.getAttribute("data-inspector")).toBe("closed");
    expect(inspector.hasAttribute("hidden")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(CSS).toContain('[data-inspector="closed"]');
    expect(CSS).toContain("grid-template-columns: 4rem minmax(0, 1fr) 0;");
  });

  it("tracks the rendered narrow marker through resize events", () => {
    const rendered = renderAt(1_280);
    const root = within(rendered.container).getByTestId("cr.shell.root");
    const inspector = within(rendered.container).getByTestId("cr.shell.inspector");
    const inspectorControl = within(inspector).getByTestId("cr.inspector.focusable");
    expect(root.hasAttribute("data-narrow")).toBe(false);
    expect(inspector.hasAttribute("hidden")).toBe(false);
    inspectorControl.focus();
    expect(document.activeElement).toBe(inspectorControl);

    act(() => {
      setWidth(800);
      window.dispatchEvent(new Event("resize"));
    });
    expect(root.getAttribute("data-narrow")).toBe("true");
    expect(inspector.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(
      within(rendered.container).getByTestId("cr.shell.inspector.toggle"),
    );

    act(() => {
      setWidth(1_280);
      window.dispatchEvent(new Event("resize"));
    });
    expect(root.hasAttribute("data-narrow")).toBe(false);
  });

  it("preserves every nav accessible name and lists every label in help", async () => {
    const wide = renderAt(1_280);
    const wideNames = CONTROL_ROOM_NAV_ITEMS.filter((label) =>
      within(wide.container).queryByRole("button", { name: label }) !== null);
    expect(wideNames).toEqual(CONTROL_ROOM_NAV_ITEMS);

    const narrow = renderAt(800);
    const narrowNames = CONTROL_ROOM_NAV_ITEMS.filter((label) =>
      within(narrow.container).queryByRole("button", { name: label }) !== null);
    expect(narrowNames).toEqual(wideNames);

    await userEvent.keyboard("?");
    const help = within(narrow.container).getByTestId("cr.shell.help");
    const listed = CONTROL_ROOM_NAV_ITEMS.map((label) => within(help).getByText(label));
    expect(listed).toHaveLength(CONTROL_ROOM_NAV_ITEMS.length);
  });

  it("starts narrow with proof available on demand and closes it on Escape", async () => {
    const rendered = renderAt(800);
    const inspector = within(rendered.container).getByTestId("cr.shell.inspector");
    const toggle = within(rendered.container).getByTestId("cr.shell.inspector.toggle");
    expect(inspector.hasAttribute("hidden")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(toggle);
    expect(inspector.getAttribute("role")).toBe("dialog");
    expect(inspector.getAttribute("aria-modal")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const closeButton = within(inspector).getByRole("button", { name: "Close inspector" });
    expect(document.activeElement).toBe(closeButton);
    await userEvent.keyboard("a");
    expect(document.activeElement).toBe(closeButton);
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(closeButton);
    await userEvent.tab();
    expect(inspector.contains(document.activeElement)).toBe(true);
    const helpInvoker = within(inspector).getByTestId("cr.inspector.focusable");
    expect(document.activeElement).toBe(helpInvoker);

    await userEvent.keyboard("?");
    const help = within(rendered.container).getByTestId("cr.shell.help");
    expect(within(rendered.container).getAllByRole("dialog")).toEqual([help]);
    expect(inspector.hasAttribute("hidden")).toBe(true);
    await userEvent.keyboard("?");
    expect(document.activeElement).toBe(
      within(help).getByRole("button", { name: "Close keyboard help" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(within(rendered.container).queryByTestId("cr.shell.help")).toBeNull();
    expect(inspector.hasAttribute("hidden")).toBe(false);
    expect(inspector.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(helpInvoker);
    await userEvent.keyboard("{Escape}");

    const closed = within(rendered.container).getByTestId("cr.shell.inspector");
    expect(closed.hasAttribute("hidden")).toBe(true);
    expect(within(rendered.container).queryAllByRole("dialog")).toEqual([]);
    expect(within(closed).getByTestId("cr.inspector.identity").textContent).toBe("inspector-42");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      setWidth(1_280);
      window.dispatchEvent(new Event("resize"));
    });
    expect(closed.hasAttribute("hidden")).toBe(true);
    expect(closed.getAttribute("role")).toBeNull();

    act(() => {
      setWidth(800);
      window.dispatchEvent(new Event("resize"));
    });
    const reopenedToggle = within(rendered.container).getByTestId("cr.shell.inspector.toggle");
    await userEvent.click(reopenedToggle);
    await userEvent.click(within(inspector).getByRole("button", { name: "Close inspector" }));
    expect(inspector.hasAttribute("hidden")).toBe(true);
  });

  it("does not undo the operator's collapsed choice on resize", async () => {
    const rendered = renderAt(1_280);
    const inspector = within(rendered.container).getByTestId("cr.shell.inspector");
    await userEvent.keyboard("[BracketLeft]");
    expect(inspector.hasAttribute("hidden")).toBe(true);

    for (const width of [800, 1_280]) {
      act(() => {
        setWidth(width);
        window.dispatchEvent(new Event("resize"));
      });
      expect(inspector.hasAttribute("hidden")).toBe(true);
    }

    await userEvent.keyboard("[BracketRight]");
    expect(inspector.hasAttribute("hidden")).toBe(false);
  });
});

describe("wide and narrow shell parity", () => {
  it("keeps actions and every declared identity set non-empty and equal", () => {
    const wide = renderAt(1_280);
    const narrow = renderAt(800);
    const actionParity = auditActionParity(wide.container, narrow.container);
    expect(actionParity.checked).toBeGreaterThan(0);
    expect(actionParity.violations).toEqual([]);

    for (const selector of [
      "[data-testid^='cr.nav.']",
      "[data-testid^='cr.shell.tab.']",
      "[data-testid='cr.shell.skiplink']",
      "[data-testid^='cr.inspector.']",
      "[data-testid^='cr.fact.']",
      "[data-testid^='cr.board.card.']",
    ]) {
      const wideIds = ids(wide.container, selector);
      const narrowIds = ids(narrow.container, selector);
      expect(wideIds.length).toBeGreaterThan(0);
      expect(narrowIds.length).toBeGreaterThan(0);
      expect(narrowIds).toEqual(wideIds);
    }
  });

  it("retains loading, empty, degraded and lag truth at narrow width", () => {
    setWidth(800);
    const loading = render(<ShellFixture board={{ ...BOARD_PROPS, cards: [], loading: true }} />);
    expect(loading.container.querySelectorAll("[data-testid='cr.board.skeleton']").length)
      .toBeGreaterThan(0);
    expect(within(loading.container).getByTestId("cr.board.asof")).toBeDefined();
    expect(within(loading.container).getByTestId("cr.banner.lag")).toBeDefined();
    expect(within(loading.container).getByTestId("cr.shell.stalelabel")).toBeDefined();
    cleanup();

    const empty = render(<ShellFixture board={{ ...BOARD_PROPS, cards: [] }} />);
    expect(within(empty.container).getByText("Nothing executing")).toBeDefined();
    expect(within(empty.container).getByTestId("cr.banner.lag")).toBeDefined();
    expect(within(empty.container).getByTestId("cr.shell.stalelabel")).toBeDefined();
  });
});

describe("shell narrow stylesheet source-text pins", () => {
  it("reads the real non-trivial stylesheet before checking its rules", () => {
    expect(CSS_PATH.endsWith(join("src", "shell", "shell-layout.css"))).toBe(true);
    expect(CSS.length).toBeGreaterThan(500);
    expect(CSS).toContain('[data-testid="cr.shell.root"]');
  });

  it("pins the narrow and reduced-motion rules jsdom cannot evaluate", () => {
    expect(CSS).toContain("@media (max-width: 959px)");
    expect(CSS).toContain('[data-testid="cr.shell.navrail"]');
    expect(CSS).toContain('[data-testid="cr.shell.inspector"]');
    expect(CSS).toContain(".cr-shell-nav-label");
    expect(CSS).toContain(REDUCED_MOTION_MARKER);
    expect(CSS).toContain("animation: none");
    expect(CSS).toContain("transition: none");
    expect(CSS).toContain("scroll-behavior: auto");
  });

  it("pins the no-removal and no-scroll-snap-motion-guard rules", () => {
    for (const forbidden of [
      /display\s*:\s*none/iu,
      /visibility\s*:\s*hidden/iu,
      /overflow\s*:\s*hidden/iu,
      /text-overflow\s*:\s*ellipsis/iu,
    ]) {
      expect(CSS).not.toMatch(forbidden);
    }
    expect(REDUCED_MOTION_CSS.length).toBeGreaterThan(0);
    expect(REDUCED_MOTION_CSS).not.toContain("scroll-snap");
  });
});
