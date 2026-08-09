import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CONTROL_ROOM_FIXTURES, MUTATION_BLOCK_ISOLATION } from "../fixtures.js";
import type {
  FixtureAffordanceSnapshot, FixtureConnectionState, FixtureFact, FixtureSurfaceId,
} from "../fixtures.js";
import { ActionBar, ShellFrame, actionTestId } from "./frame.js";
import { FactWithProvenance } from "./provenance-panel.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Indexed reads are checked, so a reordered fixture list fails loudly here. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture entry ${index} is missing`);
  return item;
}

function affordanceFor(connection: FixtureConnectionState): FixtureAffordanceSnapshot {
  const found = CONTROL_ROOM_FIXTURES.affordances.find(
    (snapshot) => snapshot.connection === connection,
  );
  if (found === undefined) throw new Error(`no ${connection} affordance fixture`);
  return found;
}

function factFor(surfaceId: FixtureSurfaceId, index: number): FixtureFact {
  const surface = CONTROL_ROOM_FIXTURES.surfaces.find((item) => item.surfaceId === surfaceId);
  if (surface === undefined) throw new Error(`no ${surfaceId} surface fixture`);
  return at(surface.facts, index);
}

const actionsIn = (): readonly HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid^='cr.action.']"));

const enabledActions = (): readonly HTMLButtonElement[] =>
  actionsIn().filter((action) => !action.disabled);

function renderFrame(affordance: FixtureAffordanceSnapshot): void {
  render(
    <ShellFrame affordance={affordance}>
      <ActionBar />
    </ShellFrame>,
  );
}

/** Every snapshot the shell can be handed, canonical states plus the isolation legs. */
const ALL_SNAPSHOTS: readonly FixtureAffordanceSnapshot[] = [
  ...CONTROL_ROOM_FIXTURES.affordances,
  ...MUTATION_BLOCK_ISOLATION,
];

describe("actions render only from supplied affordances", () => {
  it("renders one enabled control per supplied command when connected", () => {
    const connected = affordanceFor("CONNECTED");
    expect(connected.nextAllowedCommands.length).toBeGreaterThan(0);
    renderFrame(connected);
    expect(actionsIn().length).toBe(connected.nextAllowedCommands.length);
    for (const command of connected.nextAllowedCommands) {
      expect(screen.getByTestId(actionTestId(command)).getAttribute("disabled")).toBeNull();
    }
  });

  it("renders the spec-named approve control for approval.decide", () => {
    const connected = affordanceFor("CONNECTED");
    const approval = connected.nextAllowedCommands.find(
      (command) => command.commandKind === "approval.decide",
    );
    if (approval === undefined) throw new Error("fixture lost its approval.decide command");
    expect(actionTestId(approval)).toBe("cr.action.approval-decide.approve");
    renderFrame(connected);
    expect(screen.getByTestId("cr.action.approval-decide.approve")).toBeTruthy();
  });

  it("renders zero controls when connected with no supplied commands", () => {
    const empty = at(MUTATION_BLOCK_ISOLATION, 2);
    expect(empty.connection).toBe("CONNECTED");
    expect(empty.nextAllowedCommands.length).toBe(0);
    renderFrame(empty);
    expect(actionsIn().length).toBe(0);
  });
});

describe("disconnected disables rather than hides", () => {
  it("keeps every control present and disabled behind the banner", () => {
    // The canonical DISCONNECTED snapshot carries no commands, so it renders zero
    // controls and cannot tell "disabled" from "hidden". This leg is the only
    // fixture that drops the transport while still holding affordances.
    const dropped = at(MUTATION_BLOCK_ISOLATION, 0);
    expect(dropped.connection).toBe("DISCONNECTED");
    expect(dropped.nextAllowedCommands.length).toBeGreaterThan(0);
    renderFrame(dropped);
    const banner = screen.getByTestId("cr.banner.disconnected");
    expect(["status", "alert"]).toContain(banner.getAttribute("role"));
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("cr.shell.stalelabel")).toBeTruthy();
    expect(actionsIn().length).toBe(dropped.nextAllowedCommands.length);
    for (const action of actionsIn()) expect(action.disabled).toBe(true);
  });

  it("never lets the banner coexist with an enabled action, over every snapshot", () => {
    let bannersSeen = 0;
    for (const snapshot of ALL_SNAPSHOTS) {
      renderFrame(snapshot);
      if (screen.queryByTestId("cr.banner.disconnected") !== null) {
        bannersSeen += 1;
        expect(enabledActions().length).toBe(0);
      }
      cleanup();
    }
    // Without this the loop passes by never meeting a banner at all.
    expect(bannersSeen).toBeGreaterThan(0);
  });
});

describe("lag labels the display without blocking commands", () => {
  it("marks the status strip stale while every control stays enabled", () => {
    const lagging = affordanceFor("LAGGING");
    expect(lagging.nextAllowedCommands.length).toBeGreaterThan(0);
    renderFrame(lagging);
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("cr.banner.lag").textContent).toContain(lagging.statusLabel);
    expect(screen.queryByTestId("cr.banner.disconnected")).toBeNull();
    expect(actionsIn().length).toBe(lagging.nextAllowedCommands.length);
    for (const action of actionsIn()) expect(action.disabled).toBe(false);
  });
});

describe("a disabled control never invents a reason", () => {
  it("carries no reason code or unavailable phrasing in any snapshot", () => {
    let disabledSeen = 0;
    for (const snapshot of ALL_SNAPSHOTS) {
      renderFrame(snapshot);
      for (const action of actionsIn().filter((candidate) => candidate.disabled)) {
        disabledSeen += 1;
        expect(action.getAttribute("data-reason-code")).toBeNull();
        expect(action.textContent ?? "").not.toContain("Unavailable");
        expect(action.getAttribute("title")).toBeNull();
      }
      cleanup();
    }
    expect(disabledSeen).toBeGreaterThan(0);
  });

  it("has no reason-phrase literal to fall back on in the frame source", () => {
    // NextAllowedCommand carries no reason field and no fixture channel supplies
    // one, so the only way a reason could reach the DOM is a hard-coded string.
    // Resolved from the Vitest root, not import.meta.url: the React plugin rewrites
    // import.meta.url to an http URL inside .tsx, which is not a readable path.
    const source = readFileSync(resolve(process.cwd(), "src/shell/frame.tsx"), "utf8");
    // Proves the read landed on the real frame, so the two absence checks below
    // cannot pass by having read something empty or unrelated.
    expect(source).toContain("export function ShellFrame");
    expect(source).not.toContain("Unavailable");
    expect(source).not.toContain("REASON_CODE");
  });
});

describe("keyboard reachability and provenance drill-down", () => {
  it("makes the skip link the first tab stop and moves focus to main", async () => {
    const user = userEvent.setup();
    renderFrame(affordanceFor("CONNECTED"));
    await user.tab();
    const skipLink = screen.getByTestId("cr.shell.skiplink");
    expect(document.activeElement).toBe(skipLink);
    expect(skipLink.getAttribute("style")).toContain("2px");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByTestId("cr.shell.main"));
  });

  it("routes every global shell action to its declared shell target", async () => {
    const user = userEvent.setup();
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")} inspector={<p>Inspector body</p>}>
        <input aria-label="Global search" type="search" />
      </ShellFrame>,
    );
    await user.keyboard("gt");
    expect(screen.getByTestId("cr.shell.tab.timeline").getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByTestId("cr.shell.tab.board"));
    await user.keyboard("a");
    expect(document.activeElement).toBe(screen.getByTestId("cr.nav.approvals"));
    await user.keyboard("?");
    expect(screen.getByTestId("cr.shell.help").getAttribute("role")).toBe("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("cr.shell.help")).toBeNull();
    await user.keyboard("[BracketLeft]");
    expect(screen.getByTestId("cr.shell.inspector").hasAttribute("hidden")).toBe(true);
    await user.keyboard("[BracketRight]");
    expect(screen.getByTestId("cr.shell.inspector").hasAttribute("hidden")).toBe(false);
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("does not route global actions while a form field has focus", async () => {
    const user = userEvent.setup();
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")}>
        <input aria-label="Goal title" />
      </ShellFrame>,
    );
    const title = screen.getByLabelText<HTMLInputElement>("Goal title");
    title.focus();
    await user.keyboard("a");
    expect(title.value).toBe("a");
    expect(document.activeElement).toBe(title);
    expect(screen.queryByTestId("cr.shell.help")).toBeNull();
  });

  it("exposes the frame landmarks and a graph tab that mounts nothing", () => {
    renderFrame(affordanceFor("CONNECTED"));
    for (const id of ["cr.shell.navrail", "cr.shell.main", "cr.shell.inspector",
      "cr.shell.statusstrip", "cr.shell.tab.graph"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(document.querySelectorAll("[data-testid^='cr.graph.']").length).toBe(0);
  });

  it("uses an honest timeline placeholder when no timeline projection is supplied", async () => {
    const user = userEvent.setup();
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")}>
        <div data-testid="cr.test.boardprojection">Board projection</div>
      </ShellFrame>,
    );
    await user.click(screen.getByTestId("cr.shell.tab.timeline"));
    expect(screen.getByTestId("cr.shell.timelineplaceholder")).toBeTruthy();
    expect(screen.queryByTestId("cr.test.boardprojection")).toBeNull();
  });

  it("treats keyboard help as a modal and restores the invoking focus", async () => {
    const user = userEvent.setup();
    renderFrame(affordanceFor("CONNECTED"));
    const invoker = screen.getByTestId("cr.nav.goals");
    invoker.focus();
    await user.keyboard("?");
    const help = screen.getByTestId("cr.shell.help");
    expect(help.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(help).getByRole("button", { name: /close/iu }));
    await user.tab();
    expect(help.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("cr.shell.help")).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it("reaches every action by tabbing in DOM order", async () => {
    const user = userEvent.setup();
    const connected = affordanceFor("CONNECTED");
    renderFrame(connected);
    const expected = actionsIn();
    expect(expected.length).toBeGreaterThan(0);
    const reached: HTMLElement[] = [];
    for (let step = 0; step < 40 && reached.length < expected.length; step += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active instanceof HTMLElement && expected.includes(active as HTMLButtonElement)) {
        reached.push(active);
      }
    }
    expect(reached).toEqual([...expected]);
    for (const action of expected) expect(action.getAttribute("aria-label")).toBeTruthy();
  });

  it("opens provenance from a focused chip with Enter and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const fact = factFor("goals", 1);
    expect(fact.provenance.leaseEpoch).not.toBeNull();
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")}>
        <FactWithProvenance fact={fact} />
      </ShellFrame>,
    );
    const chip = within(screen.getByTestId(`cr.fact.${fact.factId}`)).getByRole("button");
    chip.focus();
    await user.keyboard("{Enter}");
    const panel = screen.getByTestId("cr.chip.provenance");
    const shown = panel.textContent ?? "";
    for (const field of [
      String(fact.provenance.eventSequence), fact.provenance.eventId, fact.provenance.actor,
      fact.provenance.sessionId, String(fact.provenance.leaseEpoch), fact.provenance.timestamp,
      fact.provenance.linkRef,
    ]) {
      expect(shown).toContain(field);
    }
    expect(within(panel).getByTestId("cr.timeline.jump")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("cr.chip.provenance")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("opens provenance from a focused chip with the p shortcut", async () => {
    const user = userEvent.setup();
    const fact = factFor("evidence", 0);
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")}>
        <FactWithProvenance fact={fact} />
      </ShellFrame>,
    );
    within(screen.getByTestId(`cr.fact.${fact.factId}`)).getByRole("button").focus();
    await user.keyboard("p");
    expect(screen.getByTestId("cr.chip.provenance").textContent).toContain(
      fact.provenance.eventId,
    );
  });

  it("reports an absent truth class as UNKNOWN with a dashed border", () => {
    const fact = factFor("board", 1);
    expect(fact.truthClass).toBeUndefined();
    render(
      <ShellFrame affordance={affordanceFor("CONNECTED")}>
        <FactWithProvenance fact={fact} />
      </ShellFrame>,
    );
    const chip = within(screen.getByTestId(`cr.fact.${fact.factId}`)).getByTestId("cr.chip.unknown");
    expect(chip.getAttribute("data-border")).toBe("dashed");
    expect(chip.getAttribute("aria-label") ?? "").toContain("class missing from payload");
  });
});
