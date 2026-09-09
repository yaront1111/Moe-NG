import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { describeConnection } from "./shell-model.js";
import { StatusStrip } from "./status-strip.js";

/**
 * truth-04: the footer said "EVENT RELAY" beside an animated heartbeat. What the
 * live build actually measures is the daemon's answer to the last board request -
 * v2 attaches no event feed at all, and the goal card on the same screen already
 * says so. The strip may report the link it has; it may not animate frames that
 * nothing is delivering, and it may not keep a flag that would let a caller
 * pretend otherwise.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  unloadSheets();
});

const CONNECTED = describeConnection("CONNECTED");
const OFFLINE = describeConnection(null);

// Spelled out here, never imported from the module under test: an expected value
// taken from the subject is a fixed point that a hardcoded-return mutant passes.
const DAEMON_SOURCE = "Connection state from the daemon's last answer.";
const OFFLINE_SOURCE = "Not attached to the daemon yet - nothing on this strip has been answered.";
const SIMULATED_SOURCE = "Simulated connection state - the SIMULATE buttons set it, not the daemon.";
const NO_STREAM = "No live event stream is attached to this surface.";

function linkTitle(): string {
  return screen.getByTestId("cr.shell.link.label").getAttribute("title") ?? "";
}

/**
 * jsdom evaluates no @media rule, but it does resolve the cascade - specificity
 * and order - of every top-level rule in a sheet installed as a <style> node. The
 * two sheets are installed in BOTH orders because the bundle's order is decided
 * by import statements in a file this strip does not own.
 */
const SHELL_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");
const STRIP_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-status-strip.css"), "utf8");
const ORDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["shell first", [SHELL_CSS, STRIP_CSS]],
  ["strip first", [STRIP_CSS, SHELL_CSS]],
];

function loadSheets(...sheets: readonly string[]): void {
  unloadSheets();
  for (const css of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-cascade", "");
    style.textContent = css;
    document.head.append(style);
  }
}

function unloadSheets(): void {
  for (const style of [...document.head.querySelectorAll("style[data-cascade]")]) style.remove();
}

function firstBar(): Element {
  const bar = screen.getByTestId("cr.shell.eventspine").querySelector("i");
  if (bar === null) throw new Error("the spine rendered no bars");
  return bar;
}

describe("truth-04: the status strip names what it measures", () => {
  it("labels the daemon link instead of claiming an event relay", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(screen.getByTestId("cr.shell.link.label").textContent).toBe("Daemon link");
    expect(screen.getByTestId("cr.shell.statusstrip").textContent).not.toContain("EVENT RELAY");
  });

  it("never calls the link a relay in any word of its own, SIMULATE titles included", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} onSimulate={() => undefined} simulatable />);
    const strip = screen.getByTestId("cr.shell.statusstrip");
    const titles = [...strip.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "");
    // The label's own title plus one per SIMULATE button: an empty sweep proves nothing.
    expect(titles.length).toBeGreaterThan(1);
    for (const words of [strip.textContent ?? "", ...titles]) expect(words).not.toMatch(/relay/iu);
  });

  it("holds the sparkline still, and says why: no stream is attached to this surface", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    const spine = screen.getByTestId("cr.shell.eventspine");
    // The connection-plus-clock fact the shell pins is untouched; only the
    // frames-are-arriving claim is withdrawn.
    expect(spine.getAttribute("data-live")).toBe("true");
    expect(spine.getAttribute("data-stream")).toBeNull();
    expect(linkTitle()).toContain("No live event stream");
  });

  it("has no flag that switches the frames-arriving motion on", () => {
    // The prop that once did was set by no caller in the product. A flag the
    // product does not honour is not honoured here either, however it arrives.
    const stray = { streamAttached: true } as Record<string, unknown>;
    render(<StatusStrip clockPresent descriptor={CONNECTED} {...stray} />);
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-stream")).toBeNull();
    expect(linkTitle()).toBe(`${DAEMON_SOURCE} ${NO_STREAM}`);
  });
});

describe("truth-04: the strip's stillness outranks the shell's heartbeat in either sheet order", () => {
  it.each(ORDERS)("resolves the lit bars to no animation - %s", (_, order) => {
    loadSheets(...order);
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(getComputedStyle(firstBar()).animation).toBe("none");
  });

  it("is correcting a real heartbeat: the shell alone animates the lit bars", () => {
    loadSheets(SHELL_CSS);
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(getComputedStyle(firstBar()).animation).toContain("cr2-spine");
  });
});

/**
 * The provenance half of that same tooltip was itself a fabrication: one sentence,
 * "Connection state from the daemon's last answer", was pinned to EVERY state -
 * including OFFLINE (nothing has answered at all: the owner's first screen) and
 * fixtures (the value comes from the SIMULATE buttons inches away). The strip may
 * only credit the source that actually set the state it is showing.
 *
 * Exact `toBe` on the whole title, not `toContain`: a substring guard tests one
 * spelling, and the reordered/reworded mutant walks straight through it.
 */
describe("truth-04: the strip credits whatever actually set its state", () => {
  it("credits the daemon only where the daemon answered", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(linkTitle()).toBe(`${DAEMON_SOURCE} ${NO_STREAM}`);
  });

  it("claims no daemon answer on the not-yet-attached surface", () => {
    render(<StatusStrip clockPresent descriptor={OFFLINE} />);
    expect(linkTitle()).toBe(`${OFFLINE_SOURCE} ${NO_STREAM}`);
  });

  it("credits the SIMULATE control, not the daemon, when the state is simulatable", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} simulatable />);
    expect(linkTitle()).toBe(`${SIMULATED_SOURCE} ${NO_STREAM}`);
  });

  it("keeps the not-yet-attached sentence even where SIMULATE is offered", () => {
    // Nothing has set this state - not the daemon, not the buttons - so the
    // stronger absence claim outranks the simulator's.
    render(<StatusStrip clockPresent descriptor={OFFLINE} simulatable />);
    expect(linkTitle()).toBe(`${OFFLINE_SOURCE} ${NO_STREAM}`);
  });
});

/**
 * The shell-wide provider pause. The strip stays PURE - it renders the `paused`
 * prop it is handed and reads no context of its own; the shell host supplies it.
 *
 * A pause is a fleet-wide fact, so it belongs on the one surface every screen
 * carries. It is NOT a connection state: the link is healthy while the seats
 * wait, so the pause may not touch the chip, the banner or the sparkline.
 */

/** 3a's own five-key fixture, verbatim from live/live-ops.test.ts. */
const PAUSE = Object.freeze({
  lastLine: "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude",
  resetAt: "2026-09-02T20:30:00.000Z",
  since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
});

const DISCONNECTED = describeConnection("DISCONNECTED");

describe("the status strip says the fleet is waiting out a provider limit", () => {
  it("names the provider and the instant it resumes, in the viewer's own locale", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} paused={PAUSE} />);
    // Computed with the SAME call the strip makes, so the box's locale and time
    // zone never decide whether this arm passes.
    const resumes = new Date(PAUSE.resetAt).toLocaleString();
    expect(screen.getByTestId("cr.shell.paused").textContent)
      .toBe(`Agents paused: claude limit, resumes ${resumes}`);
    // A locale that rendered nothing would make the sentence above vacuous.
    expect(resumes.length).toBeGreaterThan(0);
  });

  it("carries the seat's last line as a title, so the raw cause stays one hover away", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} paused={PAUSE} />);
    expect(screen.getByTestId("cr.shell.paused").getAttribute("title"))
      .toBe(`Last line from the claude seat: ${PAUSE.lastLine}`);
  });

  it("shows an unreadable instant raw rather than as Invalid Date, and never hides the pause", () => {
    // resetAt passes the decoder on non-emptiness alone, so an instant this box
    // cannot parse still reaches the strip. Hiding a live pause behind a
    // formatting miss is the one thing this line must not do.
    const unreadable = { ...PAUSE, resetAt: "whenever the limit lifts" };
    render(<StatusStrip clockPresent descriptor={CONNECTED} paused={unreadable} />);
    const words = screen.getByTestId("cr.shell.paused").textContent ?? "";
    expect(words).toBe("Agents paused: claude limit, resumes whenever the limit lifts");
    expect(words).not.toContain("Invalid Date");
  });

  it("says nothing at all when no pause is known", () => {
    // Both absences: no prop (an unwired caller) and an explicit null (a poll
    // that answered calm, or refused). Neither may state a pause.
    const { rerender } = render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(screen.queryByTestId("cr.shell.paused")).toBeNull();

    rerender(<StatusStrip clockPresent descriptor={CONNECTED} paused={null} />);
    expect(screen.queryByTestId("cr.shell.paused")).toBeNull();
    expect(screen.getByTestId("cr.shell.statusstrip").textContent).not.toContain("Agents paused");
  });

  it("leaves the link's own claims untouched: no motion, no stream, no relay word", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} paused={PAUSE} />);
    const spine = screen.getByTestId("cr.shell.eventspine");
    // The pause is a seat fact, not a transport fact. It may not light the
    // sparkline, invent a stream, or change what the link says it measures.
    expect(spine.getAttribute("data-live")).toBe("true");
    expect(spine.getAttribute("data-stream")).toBeNull();
    expect(linkTitle()).toBe(`${DAEMON_SOURCE} ${NO_STREAM}`);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("Connected");
  });

  it("sits between the connection chip and the stale marker", () => {
    // DISCONNECTED is the descriptor that actually renders a stale marker;
    // CONNECTED carries an empty staleLabel and renders none.
    render(<StatusStrip clockPresent descriptor={DISCONNECTED} paused={PAUSE} />);
    const strip = screen.getByTestId("cr.shell.statusstrip");
    const order = [...strip.children].map((child) => child.getAttribute("data-testid"));
    expect(order).toContain("cr.shell.stale");
    expect(order.indexOf("cr.shell.paused"))
      .toBe(order.indexOf("cr.shell.connection") + 1);
    expect(order.indexOf("cr.shell.stale"))
      .toBe(order.indexOf("cr.shell.paused") + 1);
  });
});
