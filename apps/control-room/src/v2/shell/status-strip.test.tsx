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
    expect(screen.getByTestId("cr.shell.link.label").textContent).toBe("DAEMON LINK");
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
