import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CordumApp } from "./cordum-app.js";

/**
 * The v2 entry's LIVE PATH wiring: it must acquire its credential at RUNTIME
 * through resolveLiveSetupFromHandshake (GET /bootstrap + POST /session/pair),
 * never from a build-time baked secret. These render CordumApp end to end and
 * assert the handshake is what drives the live surface. The resolver's own
 * fail-closed behaviour is covered in live-handshake.test.ts; here we prove the
 * component invokes it, shows an honest CONNECTING state first, and renders the
 * refused surface without crashing when no daemon answers.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CordumApp live path uses the runtime handshake", () => {
  it("shows CONNECTING, calls /bootstrap, then renders the refused surface when no daemon answers", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no daemon on this origin")));
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp search="" />);

    // Before the handshake resolves, the honest in-flight state is shown - never a
    // fabricated goal and never a baked-secret attach.
    expect(screen.getByText("CONNECTING")).toBeTruthy();

    // The refused surface renders once the handshake fails closed: NOT ATTACHED
    // with the bootstrap refusal code, and no crash.
    expect(await screen.findByText("NOT ATTACHED")).toBeTruthy();
    expect(screen.getByText(/LIVE_BOOTSTRAP_UNAVAILABLE/)).toBeTruthy();

    // The live path went through the runtime handshake: /bootstrap was fetched.
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/bootstrap");
  });

  it("does not run the handshake in fixtures mode", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("must not be called")));
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp search="fixtures=1" />);

    // Fixtures render the frozen design view and disable the handshake entirely.
    expect(screen.getByText("Ship the J1 vertical slice")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
