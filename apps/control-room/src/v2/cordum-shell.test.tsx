import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ClockProvider } from "../performance/command-latency.js";
import { FactRow } from "./components/primitives.js";
import { CordumShell } from "./shell/cordum-shell.js";
import { ProviderPauseProvider } from "./shell/pause-context.js";
import { CORDUM_NAV_ITEMS } from "./shell/shell-model.js";
import type { NavDestination } from "./shell/shell-routes.js";
import { CORDUM_TRUTH_CLASSES, cordumTruthPresentation, sayWho } from "./truth-class.js";

/**
 * The shell frame (UI-2) as it paints, plus the truth-class mapping (UI-1) it is
 * built on. Renders the component directly rather than through the entry point,
 * because the shell is the unit under test.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("the Cordum shell renders its frame", () => {
  it("lists every navigation destination in the rail", () => {
    render(<CordumShell />);
    expect(screen.getByTestId("cr.shell.navrail")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.brand").textContent).toContain("Moe");
    for (const item of CORDUM_NAV_ITEMS) {
      const button = screen.getByTestId(`cr.nav.${item.id}`);
      expect(button.textContent, item.id).toContain(item.label);
    }
    // The six the design names, in order, and nothing else claimed as a destination.
    expect(CORDUM_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Goals", "Needs you", "Runs", "Resources", "Health", "Policy",
    ]);
  });

  it("marks exactly the active destination with aria-current", () => {
    render(<CordumShell activeNav="approvals" />);
    expect(screen.getByTestId("cr.nav.approvals").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("cr.nav.goals").getAttribute("aria-current")).toBeNull();
  });

  it("exposes an unavailable destination's exact reason without navigating", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const approvals: NavDestination = Object.freeze({
      id: "approvals", reason: "NAV_DESTINATION_NOT_BUILT", route: null,
    });
    render(<CordumShell navDestinations={[approvals]} onNavigate={onNavigate} />);

    const button = screen.getByRole("button", { name: /Needs you.*not available yet/iu });
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("data-unavailable-reason")).toBe("NAV_DESTINATION_NOT_BUILT");
    expect(button.getAttribute("title")).toBe("This destination is not built yet in this release.");
    const descriptionId = button.getAttribute("aria-describedby") ?? "";
    expect(descriptionId).not.toBe("");
    expect(document.getElementById(descriptionId)?.textContent)
      .toBe("This destination is not built yet in this release.");

    await user.click(button);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("shows the chip legend naming all five truth classes", () => {
    render(<CordumShell />);
    const legend = screen.getByTestId("cr.shell.legend");
    expect(legend.textContent).toContain("What these marks mean");
    // Folded by default: the legend explains chips, it is not the first thing a person needs.
    fireEvent.click(within(legend).getByRole("button"));
    for (const truthClass of CORDUM_TRUTH_CLASSES) {
      const row = within(legend).getByTestId(`cr.legend.${truthClass.toLowerCase()}`);
      const presentation = cordumTruthPresentation(truthClass);
      expect(within(row).getByTestId("cr.shortlabel").textContent).toBe(presentation.shortLabel);
      expect(within(row).getByTestId("cr.glyph").textContent).toBe(presentation.glyph);
      expect(row.textContent, truthClass).toContain(presentation.name);
    }
    // Five distinct short labels: OBS / AGT / VER / HUM / UNK.
    expect(within(legend).getAllByTestId("cr.shortlabel").map((node) => node.textContent))
      .toEqual(["OBS", "AGT", "VER", "HUM", "UNK"]);
  });

  it("carries the title and the proof toggle in the context bar, and no dead card-treatment switch", () => {
    render(<CordumShell title="Goals" />);
    expect(screen.getByTestId("cr.shell.context.title").textContent).toBe("Goals");
    expect(screen.queryByTestId("cr.shell.treatment.compact")).toBeNull();
    expect(screen.getByTestId("cr.shell.proof.toggle")).toBeTruthy();
  });
});

describe("the status strip reports the connection state", () => {
  it("renders a live CONNECTED relay with no banner", () => {
    render(<CordumShell initialConnection="CONNECTED" />);
    const strip = screen.getByTestId("cr.shell.statusstrip");
    expect(strip.getAttribute("data-connection")).toBe("CONNECTED");
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Connected");
    expect(screen.queryByTestId("cr.banner.connected")).toBeNull();
    expect(screen.queryByTestId("cr.shell.stale")).toBeNull();
  });

  it("renders DISCONNECTED with a stale marker and its banner", () => {
    render(<CordumShell initialConnection="DISCONNECTED" />);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Disconnected");
    expect(screen.getByTestId("cr.shell.stale").textContent).toBe("Showing stale data");
    expect(screen.getByTestId("cr.banner.disconnected").textContent)
      .toContain("Disconnected from the daemon");
  });

  it("renders a live build with no feed as an honest coming-online state", () => {
    render(<CordumShell />);
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-connection")).toBe("OFFLINE");
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Coming online");
    expect(screen.getByTestId("cr.banner.offline").textContent)
      .toContain("Connecting to the daemon");
  });

  it("tracks controlled connection changes delivered after the shell mounts", () => {
    const { rerender } = render(<CordumShell connection={null} />);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Coming online");

    rerender(<CordumShell connection="CONNECTED" />);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Connected");
    expect(screen.queryByTestId("cr.banner.connected")).toBeNull();

    rerender(<CordumShell connection="DISCONNECTED" />);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Disconnected");
    expect(screen.getByTestId("cr.shell.stale").textContent).toBe("Showing stale data");
  });

  it("shows SIMULATE only in fixtures mode, and cycles the relay state", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CordumShell initialConnection="CONNECTED" />);
    expect(screen.queryByTestId("cr.shell.simulate")).toBeNull();

    rerender(<CordumShell initialConnection="CONNECTED" simulatable />);
    expect(screen.getByTestId("cr.shell.simulate")).toBeTruthy();
    await user.click(screen.getByTestId("cr.shell.simulate.disconnected"));
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Disconnected");
    expect(screen.getByTestId("cr.banner.disconnected")).toBeTruthy();
  });

  it("reflects whether a time source is present without inventing a heartbeat", () => {
    const { unmount } = render(<CordumShell initialConnection="CONNECTED" />);
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-clock")).toBe("absent");
    // The relay only animates with a live state AND a clock, so no clock means no pulse.
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-live")).toBeNull();
    unmount();

    render(
      <ClockProvider clock={{ now: () => 0 }}>
        <CordumShell initialConnection="CONNECTED" />
      </ClockProvider>,
    );
    expect(screen.getByTestId("cr.shell.statusstrip").getAttribute("data-clock")).toBe("present");
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-live")).toBe("true");
  });
});

describe("the proof inspector reads a claim's receipt", () => {
  it("opens on its empty-state contract from the Proof toggle", async () => {
    const user = userEvent.setup();
    render(<CordumShell />);
    expect(screen.queryByTestId("cr.shell.inspector")).toBeNull();

    await user.click(screen.getByTestId("cr.shell.proof.toggle"));
    expect(screen.getByTestId("cr.shell.inspector.empty").textContent)
      .toContain("Nothing on this surface is shown without its class.");

    await user.click(screen.getByTestId("cr.shell.proof.toggle"));
    expect(screen.queryByTestId("cr.shell.inspector")).toBeNull();
  });

  it("opens on the claim when a fact's truth chip is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CordumShell>
        <FactRow factId="demo" label="Ready width" truthClass="DAEMON_VERIFIED" value="1 node" />
      </CordumShell>,
    );
    const fact = screen.getByTestId("cr.fact.demo");
    await user.click(within(fact).getByTestId("cr.chip.daemon_verified"));

    const claim = screen.getByTestId("cr.shell.inspector.claim");
    expect(claim.textContent).toContain("Ready width");
    expect(claim.textContent).toContain("1 node");
    expect(within(claim).getByTestId("cr.shell.inspector.open").textContent).toContain("receipt");
  });
});

describe("the keyboard map reaches the shell", () => {
  it("routes the g-g chord to focus the Goals destination", async () => {
    const user = userEvent.setup();
    render(<CordumShell />);
    await user.keyboard("gg");
    expect(document.activeElement).toBe(screen.getByTestId("cr.nav.goals"));
  });

  it("opens the shortcuts overlay on '?' and closes it again", async () => {
    const user = userEvent.setup();
    render(<CordumShell />);
    expect(screen.queryByTestId("cr.shell.help")).toBeNull();
    await user.keyboard("?");
    expect(screen.getByTestId("cr.shell.help")).toBeTruthy();
    await user.click(within(screen.getByTestId("cr.shell.help")).getByText("Close"));
    expect(screen.queryByTestId("cr.shell.help")).toBeNull();
  });
});

describe("SaysWho maps daemon truth classes to Cordum presentations (UI-1)", () => {
  it("gives each class a distinct glyph and short label", () => {
    const shown = CORDUM_TRUTH_CLASSES.map((truthClass) => cordumTruthPresentation(truthClass));
    expect(new Set(shown.map((s) => s.glyph)).size).toBe(CORDUM_TRUTH_CLASSES.length);
    expect(new Set(shown.map((s) => s.shortLabel)).size).toBe(CORDUM_TRUTH_CLASSES.length);
    // Each tone is a token reference, never a raw colour.
    for (const presentation of shown) expect(presentation.toneVar.startsWith("--cr-")).toBe(true);
  });

  it("resolves an absent class to UNKNOWN and a malformed one to a different note", () => {
    const absent = sayWho(undefined);
    expect([absent.truthClass, absent.origin]).toEqual(["UNKNOWN", "ABSENT"]);
    const invalid = sayWho("daemon_verified");
    expect([invalid.truthClass, invalid.origin]).toEqual(["UNKNOWN", "INVALID"]);
    expect(absent.provenanceNote).not.toBe(invalid.provenanceNote);
    // A valid token keeps its class.
    expect(sayWho("HUMAN_APPROVED").truthClass).toBe("HUMAN_APPROVED");
  });

  it("names UNKNOWN by the model's meaning, not a claim that no class was supplied", () => {
    // The origin axis already reports absence; a daemon-supplied UNKNOWN class must not
    // be described as if the payload had omitted it.
    const shown = sayWho("UNKNOWN");
    expect(shown.name).toBe("Unknown — evidence absent, corrupt, stale, or irreconcilable");
    expect(shown.name).not.toContain("no class supplied");
  });
});

/**
 * The shell HOST reads the one pause fact and hands it to the strip. It takes no
 * `paused` prop of its own: one fact, one source. Every screen renders inside this
 * frame, so wiring the banner here is what makes it shell-wide instead of a Health
 * screen ornament.
 */

/** 3a's own five-key fixture, verbatim from live/live-ops.test.ts. */
const PAUSE = Object.freeze({
  lastLine: "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude",
  resetAt: "2026-09-02T20:30:00.000Z",
  since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
});

function pausedWords(): string | null {
  return screen.queryByTestId("cr.shell.paused")?.textContent ?? null;
}

describe("the shell says the fleet is waiting out a provider limit, on every screen", () => {
  it("reads the pause from the context and states it on the strip", () => {
    render(
      <ProviderPauseProvider value={PAUSE}>
        <CordumShell initialConnection="CONNECTED" />
      </ProviderPauseProvider>,
    );
    expect(pausedWords())
      .toBe(`Agents paused: claude limit, resumes ${new Date(PAUSE.resetAt).toLocaleString()}`);
  });

  it("says nothing with no provider above it, so an unwrapped shell never invents a pause", () => {
    render(<CordumShell initialConnection="CONNECTED" />);
    expect(pausedWords()).toBeNull();
  });

  it("says nothing when the provider carries null", () => {
    render(
      <ProviderPauseProvider value={null}>
        <CordumShell initialConnection="CONNECTED" />
      </ProviderPauseProvider>,
    );
    expect(pausedWords()).toBeNull();
  });

  it("states it on an opened board too, which is the same frame with a breadcrumb", () => {
    // A board is not a nav destination - the app opens it INSIDE this frame by
    // setting onBack/backLabel/title, so the roster sweep below cannot reach it.
    render(
      <ProviderPauseProvider value={PAUSE}>
        <CordumShell backLabel="Goals" initialConnection="CONNECTED"
          onBack={() => undefined} title="Ship the J1 vertical slice"
        />
      </ProviderPauseProvider>,
    );
    expect(pausedWords())
      .toBe(`Agents paused: claude limit, resumes ${new Date(PAUSE.resetAt).toLocaleString()}`);
  });

  it("states it identically whichever view the shell is framing", () => {
    // The pause is a fleet fact, not a Health-screen detail. Every nav destination
    // in the roster gets the same sentence - an empty sweep would prove nothing.
    expect(CORDUM_NAV_ITEMS.length).toBeGreaterThan(1);
    const expected = `Agents paused: claude limit, resumes ${new Date(PAUSE.resetAt).toLocaleString()}`;
    for (const item of CORDUM_NAV_ITEMS) {
      const view = render(
        <ProviderPauseProvider value={PAUSE}>
          <CordumShell activeNav={item.id} initialConnection="CONNECTED" title={item.label} />
        </ProviderPauseProvider>,
      );
      expect(pausedWords(), item.id).toBe(expected);
      view.unmount();
    }
  });
});
