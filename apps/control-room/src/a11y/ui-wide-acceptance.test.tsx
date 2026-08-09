import type { NextAllowedCommand } from "@moe/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BoardCardProjection } from "../board/board-contract.js";
import { BoardSurface } from "../board/board-surface.js";
import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { GoalsJ1 } from "../goals/goals-j1.js";
import { ControlRoomScaffold } from "../kernel.js";
import { ActionBar, ShellFrame } from "../shell/frame.js";
import {
  auditActionLegality,
  auditActionParity,
  auditFactChips,
  auditKeyboardReachability,
  auditLiveRegions,
  auditTruthClassMonochrome,
} from "./surface-audit.js";
import { CORE_SURFACE_FIXTURES } from "./ui-wide-core-fixtures.js";
import type { SurfaceFixture } from "./ui-wide-core-fixtures.js";
import { OPS_SURFACE_FIXTURES } from "./ui-wide-ops-fixtures.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const EXPECTED_SURFACES = [
  "goals-home", "board-surface", "approval-inbox", "approval-detail-plan",
  "approval-detail-expansion", "approval-detail-acceptance", "approval-detail-confirmation",
  "doctor-console", "evidence-inspect", "timeline-list", "reconciliation-inventory",
  "recovery-status", "node-authority", "attempt-detail", "review-surface",
] as const;
const SURFACES: readonly SurfaceFixture[] = [...CORE_SURFACE_FIXTURES, ...OPS_SURFACE_FIXTURES];

const BAR_TWO = Object.freeze({
  applicable: false,
  reason: "GraphPlaceholder is the only graph projection in this slice; CR-J1-002 forbids cr.graph.* mounting.",
});

function lagging(commands: readonly NextAllowedCommand[]): FixtureAffordanceSnapshot {
  const base = CONTROL_ROOM_FIXTURES.affordances.find((item) => item.connection === "LAGGING");
  if (base === undefined) throw new Error("missing LAGGING acceptance fixture");
  return Object.freeze({
    ...base,
    nextAllowedCommands: Object.freeze([...base.nextAllowedCommands, ...commands]),
  });
}

function mountSurface(
  fixture: SurfaceFixture,
  width: number,
  surface = fixture.render(),
): HTMLElement {
  const rendered = render(
    <div data-acceptance-width={width} style={{ width: `${String(width)}px` }}>
      <ShellFrame affordance={lagging(fixture.commands)}>
        <ActionBar />
        {surface}
      </ShellFrame>
    </div>,
  );
  return rendered.container;
}

function expectCleanAudit(result: { readonly checked: number; readonly violations: readonly unknown[] }): void {
  expect(result.checked).toBeGreaterThan(0);
  expect(result.violations).toEqual([]);
}

function keyboardCard(
  nodeId: string,
  placement: BoardCardProjection["placement"],
): BoardCardProjection {
  const fact = Object.freeze({ truthClass: "OBSERVED", value: "supplied" } as const);
  return Object.freeze({
    actionTargetId: nodeId, activitySilence: fact, blockerOwner: fact,
    blockerReason: fact, blockerType: fact, budgetBasis: fact, budgetSpent: fact,
    criticalPath: fact, disposition: fact, held: fact, latestClaim: fact,
    leaseEpoch: fact, leaseExpiry: fact, leaseState: fact, nodeId, owner: fact,
    phase: fact, placement, progress: fact, qualification: fact, renewalSilence: fact,
    slack: fact, sourceAggregate: "goal-j1", suspect: fact, title: nodeId,
    waitOwner: fact, waitReason: fact, waitRecheck: fact,
  });
}

describe("UI-wide deterministic accessibility bars", () => {
  it("covers every declared canonical surface exactly once", () => {
    expect(SURFACES.length).toBeGreaterThan(0);
    const ids = SURFACES.map((fixture) => fixture.id);
    expect(ids).toEqual(EXPECTED_SURFACES);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SURFACES)("audits $id without a vacuous sweep", (fixture) => {
    const wide = mountSurface(fixture, 1280);
    expectCleanAudit(auditFactChips(wide));
    expectCleanAudit(auditActionLegality(wide, lagging(fixture.commands).nextAllowedCommands));
    expectCleanAudit(auditKeyboardReachability(wide));
    expectCleanAudit(auditLiveRegions(wide));

    const narrow = mountSurface(fixture, 640);
    expectCleanAudit(auditActionParity(wide, narrow));
  });

  it.each(SURFACES.filter((fixture) => fixture.renderDegraded !== undefined))(
    "$id keeps degraded truth stale and command-authorized",
    (fixture) => {
      const renderDegraded = fixture.renderDegraded;
      if (renderDegraded === undefined) throw new Error(`missing degraded renderer for ${fixture.id}`);
      const root = mountSurface(fixture, 1280, renderDegraded());
      expect(root.querySelector("[data-testid$='.asof']")).not.toBeNull();
      expectCleanAudit(auditActionLegality(root, lagging(fixture.commands).nextAllowedCommands));
    },
  );

  it.each(SURFACES.filter((fixture) => fixture.renderLoading !== undefined))(
    "$id keeps loading actions command-authorized",
    (fixture) => {
      const renderLoading = fixture.renderLoading;
      if (renderLoading === undefined) throw new Error(`missing loading renderer for ${fixture.id}`);
      const root = mountSurface(fixture, 1280, renderLoading());
      expect(root.querySelector("[data-testid$='.loading'], [data-testid$='.skeleton']"))
        .not.toBeNull();
      expectCleanAudit(auditActionLegality(root, lagging(fixture.commands).nextAllowedCommands));
    },
  );

  it("proves all five real truth chips remain distinct without colour", () => {
    const { container } = render(<ControlRoomScaffold />);
    const chips = [...container.querySelectorAll("[data-testid^='cr.chip.']")];
    expect(chips.length).toBeGreaterThan(0);
    const classes = new Set(chips.map((chip) => chip.getAttribute("data-truth-class")));
    const tuples = new Set(chips.map((chip) => JSON.stringify([
      chip.querySelector("[data-testid='cr.glyph']")?.textContent,
      chip.querySelector("[data-testid='cr.shortlabel']")?.textContent,
      chip.getAttribute("data-border"),
    ])));
    expect(classes.size).toBe(5);
    expect(tuples.size).toBe(5);
    expect(auditTruthClassMonochrome()).toEqual({ checked: 5, violations: [] });
  });

  it("records bar 2 as not applicable instead of passing an empty sweep", () => {
    expect(BAR_TWO).toEqual({ applicable: false, reason: expect.stringContaining("CR-J1-002") });
    const root = mountSurface(SURFACES[0] as SurfaceFixture, 1280);
    expect(root.querySelectorAll("[data-testid^='cr.graph.']")).toHaveLength(0);
  });

  it("completes CR-A11Y-002 with three keyboard-only human actions", async () => {
    const user = userEvent.setup();
    const completed: string[] = [];
    const affordance = lagging([]);
    render(
      <ShellFrame affordance={affordance}>
        <GoalsJ1 facts={[]} onCreate={() => completed.push("goal.create")} />
        <BoardSurface
          cards={[keyboardCard("plan-node", "plan"), keyboardCard("ready-node", "ready")]}
          frontier={[]} joins={[]} loadedEmptyColumns={[]} showTerminated={false}
        />
        <ActionBar kind="approval.decide" />
        <ActionBar kind="integration.accept_output" />
      </ShellFrame>,
    );

    const columns = screen.getByTestId("cr.board.columns");
    columns.focus();
    await user.keyboard("l");
    expect(document.activeElement).toBe(screen.getByTestId("cr.board.card.ready-node"));
    await user.keyboard("h");
    expect(document.activeElement).toBe(screen.getByTestId("cr.board.card.plan-node"));

    const goal = screen.getByTestId("cr.goals.create");
    goal.focus();
    await user.keyboard("{Enter}");
    for (const [testId, action] of [
      ["cr.action.approval-decide.approve", "approval.decide"],
      ["cr.action.integration-accept-output", "integration.accept_output"],
    ] as const) {
      const button = screen.getByTestId(testId);
      button.addEventListener("click", () => completed.push(action), { once: true });
      button.focus();
      await user.keyboard("{Enter}");
    }

    expect(completed).toEqual(["goal.create", "approval.decide", "integration.accept_output"]);
    expect(completed.length).toBeLessThanOrEqual(3);
  });
});
