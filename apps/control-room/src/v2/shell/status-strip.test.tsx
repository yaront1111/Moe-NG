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
 * nothing is delivering.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const CONNECTED = describeConnection("CONNECTED");
const DISCONNECTED = describeConnection("DISCONNECTED");
const OFFLINE = describeConnection(null);

// Spelled out here, never imported from the module under test: an expected value
// taken from the subject is a fixed point that a hardcoded-return mutant passes.
const DAEMON_SOURCE = "Connection state from the daemon's last answer.";
const OFFLINE_SOURCE = "Not attached to the daemon yet - nothing on this strip has been answered.";
const SIMULATED_SOURCE = "Simulated connection state - the SIMULATE buttons set it, not the daemon.";
const NO_STREAM = "No live event stream is attached to this surface.";
const STREAM_MOVING = "A live event stream is attached: the bars move with its frames.";
const STREAM_HELD = "A live event stream is attached; the bars hold still while the link is not live.";

function relayTitle(): string {
  return screen.getByTestId("cr.shell.relay.label").getAttribute("title") ?? "";
}

function readStyles(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/v2/styles", name), "utf8");
}

describe("truth-04: the status strip names what it measures", () => {
  it("labels the daemon link instead of claiming an event relay", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    expect(screen.getByTestId("cr.shell.relay.label").textContent).toBe("DAEMON LINK");
    expect(screen.getByTestId("cr.shell.statusstrip").textContent).not.toContain("EVENT RELAY");
  });

  it("holds the sparkline still, and says why, when no stream is attached", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} />);
    const spine = screen.getByTestId("cr.shell.eventspine");
    expect(spine.getAttribute("data-stream")).toBeNull();
    // The connection-plus-clock fact the shell pins is untouched; only the
    // frames-are-arriving claim is withdrawn.
    expect(spine.getAttribute("data-live")).toBe("true");
    expect(screen.getByTestId("cr.shell.relay.label").getAttribute("title"))
      .toContain("No live event stream");
  });

  it("pulses only when a caller states a stream is attached", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} streamAttached />);
    const spine = screen.getByTestId("cr.shell.eventspine");
    expect(spine.getAttribute("data-stream")).toBe("true");
    expect(screen.getByTestId("cr.shell.relay.label").getAttribute("title"))
      .not.toContain("No live event stream");
  });

  it("moves the heartbeat animation onto the attached-stream flag", () => {
    // jsdom applies no stylesheet, so the paint rule is asserted as text against
    // the component-scoped sheet the strip imports.
    const css = readStyles("cordum-status-strip.css");
    expect(css).toMatch(/\.cr2-spine\[data-live="true"\] i\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/\.cr2-spine\[data-stream="true"\] i\s*\{[^}]*animation:\s*cr2-spine/);
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
    expect(relayTitle()).toBe(`${DAEMON_SOURCE} ${NO_STREAM}`);
  });

  it("claims no daemon answer on the not-yet-attached surface", () => {
    render(<StatusStrip clockPresent descriptor={OFFLINE} />);
    expect(relayTitle()).toBe(`${OFFLINE_SOURCE} ${NO_STREAM}`);
  });

  it("credits the SIMULATE control, not the daemon, when the state is simulatable", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} simulatable />);
    expect(relayTitle()).toBe(`${SIMULATED_SOURCE} ${NO_STREAM}`);
  });

  it("keeps the not-yet-attached sentence even where SIMULATE is offered", () => {
    // Nothing has set this state - not the daemon, not the buttons - so the
    // stronger absence claim outranks the simulator's.
    render(<StatusStrip clockPresent descriptor={OFFLINE} simulatable />);
    expect(relayTitle()).toBe(`${OFFLINE_SOURCE} ${NO_STREAM}`);
  });

  it("names the moving bars only when the bars really move", () => {
    render(<StatusStrip clockPresent descriptor={CONNECTED} streamAttached />);
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-stream")).toBe("true");
    expect(relayTitle()).toBe(`${DAEMON_SOURCE} ${STREAM_MOVING}`);
  });

  it("never denies a stream the caller stated, even on a link that is not live", () => {
    render(<StatusStrip clockPresent descriptor={DISCONNECTED} streamAttached />);
    // The bars are genuinely still here, so the sentence may not promise motion -
    // but it may not deny the attachment the caller stated either.
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-stream")).toBeNull();
    expect(relayTitle()).toBe(`${DAEMON_SOURCE} ${STREAM_HELD}`);
  });

  it("holds the bars, and says so, when the clock is the missing half", () => {
    render(<StatusStrip clockPresent={false} descriptor={CONNECTED} streamAttached />);
    expect(screen.getByTestId("cr.shell.eventspine").getAttribute("data-stream")).toBeNull();
    expect(relayTitle()).toBe(`${DAEMON_SOURCE} ${STREAM_HELD}`);
  });
});
