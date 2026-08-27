import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, reject, resolve };
}

function liveAttempts(
  initial: Promise<LiveHandshakeResult>,
  retry: (signal: AbortSignal) => Promise<LiveHandshakeResult>,
) {
  return Object.assign(initial, { initial, retry: vi.fn(retry) });
}

const BOOTSTRAP = Object.freeze({
  csrfToken: "csrf-live",
  projectId: "project-live",
  protocolVersion: WIRE,
});
const PAIRING = Object.freeze({
  confirmationLabel: "abcd-ef01-2345",
  ok: true,
  requestId: "b".repeat(64),
});
const CLAIMED = Object.freeze({
  capabilities: ["affordance.read"],
  expiresAt: "2099-08-27T23:59:59.000Z",
  ok: true,
  projectId: "project-live",
  protocolVersion: WIRE,
  sessionCredential: "credential-live",
});
const SURFACE = Object.freeze({ nextAllowedCommands: [], outcome: "SURFACE", steps: [] });

const FEED_PROJECTION_CASES = Object.freeze([
  Object.freeze({
    answer: (): Promise<Response> => Promise.resolve(jsonResponse(SURFACE)),
    expected: "CONNECTED",
    name: "a valid surface",
  }),
  Object.freeze({
    answer: (): Promise<Response> => Promise.resolve(jsonResponse({
      code: "POLICY_REFUSED",
      layer: "CONTROL_ROOM_HTTP",
      outcome: "REFUSED",
    }, 403)),
    expected: "LAGGING",
    name: "a delivered refusal",
  }),
  Object.freeze({
    answer: (): Promise<Response> => Promise.resolve({
      json: () => Promise.reject(new Error("unparseable body")),
      ok: true,
      status: 200,
    } as Response),
    expected: "LAGGING",
    name: "an unreadable body",
  }),
  Object.freeze({
    answer: (): Promise<Response> => Promise.reject(new Error("transport lost")),
    expected: "DISCONNECTED",
    name: "an undelivered request",
  }),
] as const);

function handshakeResponse(input: string): Promise<Response> {
  if (input === "/bootstrap") return Promise.resolve(jsonResponse(BOOTSTRAP));
  if (input === "/session/pair/request") return Promise.resolve(jsonResponse(PAIRING));
  if (input === "/session/pair/claim") return Promise.resolve(jsonResponse(CLAIMED));
  return Promise.reject(new Error(`unexpected handshake fetch to ${input}`));
}

async function attachedSetup(signal?: AbortSignal): Promise<LiveHandshakeResult> {
  const result = await resolveLiveSetupFromHandshake({
    fetchImpl: (input) => handshakeResponse(input),
    ...(signal === undefined ? {} : { signal }),
  });
  return "status" in result ? result.claim() : result;
}

function refusedSetup(): Promise<LiveHandshakeResult> {
  return resolveLiveSetupFromHandshake({
    fetchImpl: () => Promise.reject(new Error("no daemon on this origin")),
  });
}

function connection(): string | null {
  return screen.getByTestId("cr2.shell.root").getAttribute("data-connection");
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
    expect(screen.getAllByText(/LIVE_BOOTSTRAP_UNAVAILABLE/)).toHaveLength(2);
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("DISCONNECTED");

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

  it("stays coming online through pairing until the live board feed answers", async () => {
    let deliverSurface: ((response: Response) => void) | undefined;
    const surface = new Promise<Response>((resolve) => { deliverSurface = resolve; });
    let surfaceReads = 0;
    const fetchMock = vi.fn((input: string, _init?: RequestInit): Promise<Response> => {
      if (input === "/bootstrap") {
        return Promise.resolve(jsonResponse({
          csrfToken: "csrf-live", projectId: "project-live", protocolVersion: WIRE,
        }));
      }
      if (input === "/session/pair/request") {
        return Promise.resolve(jsonResponse({
          confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "b".repeat(64),
        }));
      }
      if (input === "/session/pair/claim") {
        return Promise.resolve(jsonResponse({
          capabilities: ["affordance.read"],
          expiresAt: "2026-08-25T23:59:59.000Z",
          ok: true,
          projectId: "project-live",
          protocolVersion: WIRE,
          sessionCredential: "credential-live",
        }));
      }
      if (input === "/affordances/read") {
        surfaceReads += 1;
        return surfaceReads === 1
          ? surface
          : Promise.reject(new Error("daemon connection lost"));
      }
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp liveSetup={prepareLiveSetup()} search="" />);

    expect(await screen.findByText("abcd-ef01-2345")).toBeTruthy();
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("COMING ONLINE");
    await userEvent.setup().click(screen.getByRole("button", { name: "I entered this label" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => input === "/affordances/read")).toBe(true);
    });
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("COMING ONLINE");

    deliverSurface?.(jsonResponse({ nextAllowedCommands: [], outcome: "SURFACE", steps: [] }));
    await waitFor(() => {
      expect(screen.getByTestId("cr.shell.connection").textContent).toBe("CONNECTED");
    });
    await waitFor(() => {
      expect(screen.getByTestId("cr.shell.connection").textContent).toBe("DISCONNECTED");
    }, { timeout: 3_500 });
    expect(surfaceReads).toBe(2);
  });
});

describe("CordumApp bounded live recovery", () => {
  it("redeems the prepared initial attempt once under StrictMode", async () => {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.reject(new Error("no daemon")));
    vi.stubGlobal("fetch", fetchMock);
    const attempts = liveAttempts(prepareLiveSetup(), () => refusedSetup());

    render(<StrictMode><CordumApp liveSetup={attempts} search="" /></StrictMode>);

    expect(await screen.findAllByText(/LIVE_BOOTSTRAP_UNAVAILABLE/u)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) => input === "/bootstrap")).toHaveLength(1);
    expect(attempts.retry).toHaveBeenCalledTimes(0);
  });

  it("retries a refused handshake within a fresh bounded attempt", async () => {
    const bootstrap = deferred<Response>();
    const feed = vi.fn(() => Promise.resolve(jsonResponse(SURFACE)));
    vi.stubGlobal("fetch", feed);
    const retry = async (signal: AbortSignal): Promise<LiveHandshakeResult> => {
      const result = await resolveLiveSetupFromHandshake({
        fetchImpl: (input) => input === "/bootstrap" ? bootstrap.promise : handshakeResponse(input),
        signal,
      });
      return "status" in result ? result.claim() : result;
    };
    const attempts = liveAttempts(refusedSetup(), retry);

    render(<CordumApp liveSetup={attempts} search="" />);
    expect((await screen.findAllByText(
      "LIVE_BOOTSTRAP_UNAVAILABLE: daemon bootstrap unavailable",
    )).length).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry connection" }));

    expect(connection()).toBe("OFFLINE");
    expect(screen.getByText("CONNECTING")).toBeTruthy();
    bootstrap.resolve(jsonResponse(BOOTSTRAP));
    await waitFor(() => { expect(connection()).toBe("CONNECTED"); });
    expect(attempts.retry).toHaveBeenCalledTimes(1);
    expect(attempts.retry.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("starts at most one retry while an attempt is active", async () => {
    const pending = deferred<LiveHandshakeResult>();
    const attempts = liveAttempts(refusedSetup(), () => pending.promise);
    render(<CordumApp liveSetup={attempts} search="" />);
    const retry = await screen.findByRole("button", { name: "Retry connection" });

    await act(async () => {
      retry.click();
      retry.click();
    });

    expect(attempts.retry).toHaveBeenCalledTimes(1);
    expect(connection()).toBe("OFFLINE");
  });

  it("ignores a late abort-resistant result from a superseded generation", async () => {
    const stale = deferred<LiveHandshakeResult>();
    const oldAttempts = liveAttempts(stale.promise, () => refusedSetup());
    const newerAttempts = liveAttempts(refusedSetup(), () => refusedSetup());
    const feed = vi.fn(() => Promise.reject(new Error("must not attach stale setup")));
    vi.stubGlobal("fetch", feed);
    const view = render(<CordumApp liveSetup={oldAttempts} search="" />);

    view.rerender(<CordumApp liveSetup={newerAttempts} search="" />);
    expect((await screen.findAllByText(
      "LIVE_BOOTSTRAP_UNAVAILABLE: daemon bootstrap unavailable",
    )).length).toBeGreaterThan(0);
    const valid = await attachedSetup();
    await act(async () => { stale.resolve(valid); });

    expect(screen.getAllByText(
      "LIVE_BOOTSTRAP_UNAVAILABLE: daemon bootstrap unavailable",
    ).length).toBeGreaterThan(0);
    expect(feed).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous timed-out pairing refusal disconnected", async () => {
    const initial = resolveLiveSetupFromHandshake({
      fetchImpl: (input) => {
        if (input === "/bootstrap") return Promise.resolve(jsonResponse(BOOTSTRAP));
        if (input === "/session/pair/request") return Promise.resolve(jsonResponse(PAIRING));
        return new Promise<Response>(() => undefined);
      },
      requestTimeoutMs: 5,
    });
    const attempts = liveAttempts(initial, () => refusedSetup());
    render(<CordumApp liveSetup={attempts} search="" />);

    expect(await screen.findByText(PAIRING.confirmationLabel)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "I entered this label" }));
    expect((await screen.findAllByText(
      "LIVE_PAIRING_REFUSED: session pairing refused",
    )).length).toBeGreaterThan(0);
    expect(connection()).toBe("DISCONNECTED");
  });

  it("aborts the active retry on unmount and ignores its late result", async () => {
    const late = deferred<LiveHandshakeResult>();
    let signal: AbortSignal | undefined;
    const attempts = liveAttempts(refusedSetup(), (nextSignal) => {
      signal = nextSignal;
      return late.promise;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lateRefusal = await refusedSetup();
    const view = render(<CordumApp liveSetup={attempts} search="" />);
    await userEvent.setup().click(
      await screen.findByRole("button", { name: "Retry connection" }),
    );

    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { late.resolve(lateRefusal); });
    expect(consoleError).toHaveBeenCalledTimes(0);
  });

  it("projects feed loss and later recovery from the controlled live source", async () => {
    const observed: string[] = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      reads += 1;
      if (reads === 2) return Promise.reject(new Error("transport lost"));
      return Promise.resolve(jsonResponse(SURFACE));
    }));
    const attempts = liveAttempts(attachedSetup(), () => attachedSetup());
    render(<CordumApp liveSetup={attempts} search="" />);

    observed.push(connection() ?? "MISSING");
    await waitFor(() => { expect(connection()).toBe("CONNECTED"); });
    observed.push(connection() ?? "MISSING");
    await waitFor(() => { expect(connection()).toBe("DISCONNECTED"); }, { timeout: 3_500 });
    observed.push(connection() ?? "MISSING");
    await waitFor(() => { expect(connection()).toBe("CONNECTED"); }, { timeout: 3_500 });
    observed.push(connection() ?? "MISSING");

    expect(observed).toEqual(["OFFLINE", "CONNECTED", "DISCONNECTED", "CONNECTED"]);
  }, 8_000);
});

describe("CordumApp feed projection roster", () => {
  it("pins the feed projection roster to exactly four cases", () => {
    expect(Object.isFrozen(FEED_PROJECTION_CASES)).toBe(true);
    expect(FEED_PROJECTION_CASES).toHaveLength(4);
  });

  it.each(FEED_PROJECTION_CASES)(
    "projects $name as $expected through the production feed",
    async ({ answer, expected }) => {
      vi.stubGlobal("fetch", vi.fn(answer));
      const attempts = liveAttempts(attachedSetup(), () => attachedSetup());

      render(<CordumApp liveSetup={attempts} search="" />);

      await waitFor(() => { expect(connection()).toBe(expected); });
    },
  );
});
