import { describe, expect, it } from "vitest";

import { liveAffordance } from "./live-app.js";
import type { SurfaceFrame } from "./live-board-feed.js";
import type { LiveFrame } from "./live-event-feed.js";

const RELAY_UP = { connection: "CONNECTED" } as LiveFrame;

function surface(offers: number): SurfaceFrame {
  return Object.freeze({
    connection: "CONNECTED",
    detail: "",
    offers: Array.from({ length: offers }, (_, index) => ({ commandId: `afford-${String(index)}` })),
    outcome: "SURFACE",
    steps: [],
  });
}

/**
 * The shell banner is a statement about the daemon and must agree with the board
 * rendered under it. A banner claiming "no command affordances" over a board that
 * dispatches one is a truth defect, not a wording nit.
 */
describe("liveAffordance status label", () => {
  it("does not claim the daemon serves no affordances while the surface offers some", () => {
    const shell = liveAffordance(RELAY_UP, surface(3));
    expect(shell.connection).toBe("CONNECTED");
    expect(shell.statusLabel).not.toMatch(/serves no command affordances/u);
    expect(shell.statusLabel).toMatch(/3 command affordances? on the board/u);
  });

  it("says so only when the surface really is empty", () => {
    expect(liveAffordance(RELAY_UP, surface(0)).statusLabel)
      .toMatch(/serves no command affordances right now/u);
  });

  it("names the surface as unanswered rather than empty before it has answered", () => {
    expect(liveAffordance(RELAY_UP, null).statusLabel)
      .toMatch(/affordance surface has not answered yet/u);
    expect(liveAffordance(RELAY_UP, null).statusLabel).not.toMatch(/serves no/u);
  });

  it("keeps the shell's own actions disabled regardless of board offers", () => {
    // Board offers are dispatched BY THE BOARD; the shell surface has no wired
    // command set of its own, so nothing here may enable a shell action.
    const shell = liveAffordance(RELAY_UP, surface(3));
    expect(shell.mutationsEnabled).toBe(false);
    expect(shell.nextAllowedCommands).toEqual([]);
  });

  it("reports the relay as disconnected before the daemon answers", () => {
    expect(liveAffordance(null, surface(3)).connection).toBe("DISCONNECTED");
  });
});
