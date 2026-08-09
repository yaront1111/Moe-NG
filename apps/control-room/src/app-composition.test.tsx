import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  APP_SECTION_IDS, AppComposition, resolveEntryAffordance,
} from "./app-composition.js";
import { CONTROL_ROOM_FIXTURES, MUTATION_BLOCK_ISOLATION } from "./fixtures.js";

const ALL_TRUTH_CLASSES = [
  "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "OBSERVED", "UNKNOWN",
] as const;

/** Every control the CONNECTED J1 snapshot can legitimise, by rendered test id. */
const J1_ACTION_TEST_IDS = [
  "cr.action.approval-decide.approve",
  "cr.action.goal-close",
  "cr.action.integration-accept-output",
] as const;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("entry affordance resolution", () => {
  it("resolves the CONNECTED snapshot from the fixture set", () => {
    const resolved = resolveEntryAffordance(CONTROL_ROOM_FIXTURES.affordances);
    expect(resolved.connection).toBe("CONNECTED");
    expect(resolved.mutationsEnabled).toBe(true);
    expect(resolved.nextAllowedCommands.length).toBe(3);
  });

  it("refuses with a stable code when no CONNECTED snapshot exists", () => {
    expect(() => resolveEntryAffordance([])).toThrow("APP_COMPOSITION_AFFORDANCE_MISSING");
    const degradedOnly = CONTROL_ROOM_FIXTURES.affordances
      .filter((snapshot) => snapshot.connection !== "CONNECTED");
    expect(degradedOnly.length).toBeGreaterThan(0);
    expect(() => resolveEntryAffordance(degradedOnly))
      .toThrow("APP_COMPOSITION_AFFORDANCE_MISSING");
  });
});

describe("the entry composition mounts the real shell", () => {
  it("renders the shell frame chrome around the composed surfaces", () => {
    render(<AppComposition />);
    expect(screen.getByTestId("cr.shell.root")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.navrail")).toBeTruthy();
    for (const tab of ["board", "graph", "timeline"] as const) {
      expect(screen.getByTestId(`cr.shell.tab.${tab}`)).toBeTruthy();
    }
    const strip = screen.getByTestId("cr.shell.statusstrip");
    expect(strip.getAttribute("data-connection")).toBe("CONNECTED");
    // The provenance hint travels in the inspector sheet even while it is collapsed.
    const inspector = screen.getByTestId("cr.shell.inspector");
    expect(within(inspector).getByTestId("cr.app.inspectorhint").textContent)
      .toContain("provenance");
  });

  it("composes every declared section exactly once, each with a heading", () => {
    render(<AppComposition />);
    for (const id of APP_SECTION_IDS) {
      const section = screen.getByTestId(`cr.app.section.${id}`);
      expect(section.querySelector("h2")).not.toBeNull();
    }
    expect(new Set(APP_SECTION_IDS).size).toBe(APP_SECTION_IDS.length);
  });

  it("mounts the real core surfaces, not the fixture placeholder panels", () => {
    render(<AppComposition />);
    expect(screen.getByTestId("cr.surface.goals")).toBeTruthy();
    expect(screen.getByTestId("cr.surface.board")).toBeTruthy();
    expect(screen.getByTestId("cr.approvals.pending")).toBeTruthy();
    expect(screen.getByTestId("cr.surface.health")).toBeTruthy();
    expect(screen.getByTestId("cr.evidence.inspect")).toBeTruthy();
    expect(screen.getByTestId("cr.timeline.list")).toBeTruthy();
    // The placeholder rendered one cr.surface.* panel per fixture surface; the real
    // composition must not resurrect its node panel id.
    expect(screen.queryByTestId("cr.surface.node")).toBeNull();
  });

  it("enables every daemon-supplied action under the CONNECTED snapshot", () => {
    render(<AppComposition />);
    for (const testId of J1_ACTION_TEST_IDS) {
      const buttons = screen.getAllByTestId(testId);
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      }
    }
    // The board card carries the integration affordance beside the command strip.
    const integration = screen.getAllByTestId("cr.action.integration-accept-output");
    expect(integration.length).toBe(2);
    for (const button of integration) {
      expect(button.getAttribute("data-command-id")).toBe("cmd-j1-accept-output");
    }
  });

  it("keeps controls visible and disabled when the transport drops holding affordances", () => {
    const dropped = MUTATION_BLOCK_ISOLATION[0];
    if (dropped === undefined) throw new Error("missing DISCONNECTED isolation fixture");
    expect(dropped.connection).toBe("DISCONNECTED");
    render(<AppComposition affordance={dropped} />);
    expect(screen.getByTestId("cr.banner.disconnected")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-connection"))
      .toBe("DISCONNECTED");
    for (const testId of J1_ACTION_TEST_IDS) {
      for (const button of screen.getAllByTestId(testId)) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  it("keeps all five truth classes on screen so chips stay distinguishable", () => {
    const { container } = render(<AppComposition />);
    const classes = new Set(
      [...container.querySelectorAll("[data-testid^='cr.chip.']")]
        .map((chip) => chip.getAttribute("data-truth-class")),
    );
    expect([...classes].sort()).toEqual([...ALL_TRUTH_CLASSES]);
  });

  it("keeps every chip nested in exactly one fact wrapper", () => {
    const { container } = render(<AppComposition />);
    const wrappers = container.querySelectorAll("[data-testid^='cr.fact.']");
    const chips = container.querySelectorAll("[data-testid^='cr.chip.']");
    expect(wrappers.length).toBeGreaterThanOrEqual(20);
    expect(chips.length).toBe(wrappers.length);
    for (const wrapper of wrappers) {
      expect(wrapper.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(1);
    }
  });
});
