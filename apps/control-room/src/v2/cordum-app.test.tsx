import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveLiveSetupFromHandshake } from "../live/live-handshake.js";
import type { LiveHandshakeResult } from "../live/live-handshake.js";
import { CordumApp } from "./cordum-app.js";

/**
 * The v2 entry's LIVE PATH wiring: it must acquire its credential at RUNTIME
 * through resolveLiveSetupFromHandshake (bootstrap, request, operator-approved claim),
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
  window.history.replaceState(null, "", "/");
});

const WIRE =
  `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}`;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function prepareLiveSetup(): ReturnType<typeof resolveLiveSetupFromHandshake> {
  return resolveLiveSetupFromHandshake({
    fetchImpl: (input, init) => fetch(input, init),
  });
}

describe("CordumApp live path uses the runtime handshake", () => {
  it("shows only the confirmation label and claims after the operator action", async () => {
    const claim = vi.fn(async () => ({
      code: "LIVE_PAIRING_REFUSED" as const, detail: "approval still required", ok: false as const,
    }));
    const pending: Promise<LiveHandshakeResult> = Promise.resolve({
      claim,
      confirmationLabel: "abcd-ef01-2345",
      status: "AWAITING_OPERATOR",
    });

    render(<CordumApp liveSetup={pending} search="" />);

    expect(await screen.findByText("abcd-ef01-2345")).toBeTruthy();
    expect(screen.getByText(/foreground terminal that launched this project/iu)).toBeTruthy();
    expect(document.body.textContent).not.toContain("requestId");
    expect(document.body.textContent).not.toContain("sessionCredential");
    await userEvent.setup().click(screen.getByRole("button", { name: "I entered this label" }));
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("shows CONNECTING, calls /bootstrap, then renders the refused surface when no daemon answers", async () => {
    const fetchMock = vi.fn(
      (_input: string, _init?: RequestInit) => Promise.reject(new Error("no daemon on this origin")),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp liveSetup={prepareLiveSetup()} search="" />);

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

  it("does not treat a stale pairing fragment as authority", async () => {
    window.history.replaceState(null, "", "/?v2=1#pair=ONE-TIME-SECRET");
    const fetchMock = vi.fn((input: string, _init?: RequestInit) => {
      if (input === "/bootstrap") return Promise.resolve(jsonResponse({
        csrfToken: "csrf-blue", projectId: "proj-blue", protocolVersion: WIRE,
      }));
      if (input === "/session/pair/request") return Promise.resolve(jsonResponse({
        confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "a".repeat(64),
      }));
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp liveSetup={prepareLiveSetup()} search="v2=1" />);

    expect(await screen.findByText("abcd-ef01-2345")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      "/bootstrap", "/session/pair/request",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe("{}");
    expect(document.body.textContent).not.toContain("ONE-TIME-SECRET");
  });
});
