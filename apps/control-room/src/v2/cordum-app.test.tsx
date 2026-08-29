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
import { BOARD_SUBJECT_ABSENT_NOTE, LiveWorkBoard } from "./goals/live-work-board.js";
import { CordumShell } from "./shell/cordum-shell.js";
import { NAV_IDS } from "./shell/shell-model.js";
import {
  CORDUM_ROUTE_KINDS, NAV_UNAVAILABLE_LABELS, NAV_UNAVAILABLE_REASONS, resolveNavDestinations,
} from "./shell/shell-routes.js";

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

// The literal header name, written out rather than imported from production, so a
// producer-side rename reds here instead of silently following it. No default
// value is baked in: only the pairing-request fixtures below spell it.
const OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel";
const OPERATOR_PRESENT: HeadersInit = { [OPERATOR_CHANNEL_HEADER]: "true" };

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return {
    headers: new Headers(headers),
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
  if (input === "/session/pair/request") {
    return Promise.resolve(jsonResponse(PAIRING, 200, OPERATOR_PRESENT));
  }
  if (input === "/session/pair/claim") return Promise.resolve(jsonResponse(CLAIMED));
  return Promise.reject(new Error(`unexpected handshake fetch to ${input}`));
}

async function attachedSetup(signal?: AbortSignal): Promise<LiveHandshakeResult> {
  const result = await resolveLiveSetupFromHandshake({
    fetchImpl: (input) => handshakeResponse(input),
    ...(signal === undefined ? {} : { signal }),
  });
  return "status" in result && result.status === "AWAITING_OPERATOR"
    ? result.claim() : result;
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
      }, 200, OPERATOR_PRESENT));
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
        }, 200, OPERATOR_PRESENT));
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
      return "status" in result && result.status === "AWAITING_OPERATOR"
        ? result.claim() : result;
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
        if (input === "/session/pair/request") {
          return Promise.resolve(jsonResponse(PAIRING, 200, OPERATOR_PRESENT));
        }
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
    // Keyed on the AFFORDANCE route, not on a global call counter: the goals home
    // also polls the durable goal catalog, so "the second fetch" is no longer the
    // second surface read. Counting the route this assertion is about keeps the
    // arm measuring feed loss instead of feed ordering.
    let lossReads = 0;
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      if (input !== "/affordances/read") return Promise.resolve(jsonResponse(SURFACE));
      lossReads += 1;
      if (lossReads === 2) return Promise.reject(new Error("transport lost"));
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

/**
 * The no-terminal state is DAEMON-STATED: it is reached only by driving the real
 * resolveLiveSetupFromHandshake over a pairing response whose
 * `x-moe-operator-channel` header is exactly `false`, never by handing CordumApp a
 * hand-built unavailable object. The response still carries a perfectly valid
 * label and request id, so the assertions below prove that identity is dropped
 * rather than merely absent from the fixture.
 */
const NO_TERMINAL_SENTENCE = "Moe was started without a terminal it can listen on. "
  + "Stop it and run pnpm start from a terminal window, then reload this page.";
const UNAVAILABLE_LABEL = "beef-cafe-d00d";
const UNAVAILABLE_REQUEST_ID = "fa".repeat(32);

describe("CordumApp renders the daemon-stated no-terminal truth", () => {
  it("states the restart instruction and offers no pairing action when the channel is false", async () => {
    const fetchMock = vi.fn((input: string, _init?: RequestInit): Promise<Response> => {
      if (input === "/bootstrap") return Promise.resolve(jsonResponse(BOOTSTRAP));
      if (input === "/session/pair/request") {
        return Promise.resolve(jsonResponse({
          confirmationLabel: UNAVAILABLE_LABEL, ok: true, requestId: UNAVAILABLE_REQUEST_ID,
        }, 200, { [OPERATOR_CHANNEL_HEADER]: "false" }));
      }
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CordumApp liveSetup={prepareLiveSetup()} search="" />);

    expect(await screen.findByText(NO_TERMINAL_SENTENCE)).toBeTruthy();
    // The daemon's response identity never reaches the rendered surface.
    expect(document.body.textContent).not.toContain(UNAVAILABLE_LABEL);
    expect(document.body.textContent).not.toContain(UNAVAILABLE_REQUEST_ID);
    // No pairing affordance is offered: there is no terminal to type the label in.
    expect(screen.queryByLabelText("Pairing confirmation label")).toBeNull();
    expect(screen.queryByRole("button", { name: "I entered this label" })).toBeNull();
    // Never miscast as an attached or refused READY surface.
    expect(screen.queryByText("NOT ATTACHED")).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      "/bootstrap", "/session/pair/request",
    ]);
  });
});

/**
 * NAVIGATION AND THE DURABLE BOARD SUBJECT (DoD-2, DoD-4).
 *
 * These render the shell and the live board directly rather than through
 * CordumApp: the CordumApp wiring is step 6 of this row's plan and is gated shut
 * behind sibling task-9bd8f529 (see comment-f536156e3614409695755c46b9eec6d8), so
 * the seam under test here is the shell's, not the entry's.
 *
 * Every expected identifier below is READ FROM THE FIXTURE OBJECT that supplied
 * it. An identifier written as a literal beside its assertion is a fixed point no
 * mutation can red, which is exactly what DoD-4's "no fixed goal/run ids" forbids.
 */

describe("Cordum navigation drives one typed route source of truth", () => {
  it("pins the route roster and the nav destination roster to exact nonzero counts", () => {
    expect(Object.isFrozen(CORDUM_ROUTE_KINDS)).toBe(true);
    expect(CORDUM_ROUTE_KINDS.length).toBeGreaterThan(0);
    expect(CORDUM_ROUTE_KINDS).toHaveLength(2);

    const destinations = resolveNavDestinations();
    // One destination per nav id, in the rail's order, and nothing else claimed.
    expect(destinations.map((destination) => destination.id)).toEqual([...NAV_IDS]);
    expect(destinations.length).toBeGreaterThan(0);

    const reachable = destinations.filter((destination) => destination.reason === null);
    const unavailable = destinations.filter((destination) => destination.reason !== null);
    // Both partitions are NONZERO: a roster with nothing unavailable would make the
    // disabled arm below vacuous, and one with nothing reachable would make the
    // navigation arm vacuous.
    expect(reachable.length).toBeGreaterThan(0);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(reachable).toHaveLength(1);
    expect(unavailable).toHaveLength(NAV_IDS.length - 1);
    // A reachable destination carries a route; an unavailable one carries none and
    // states a reason drawn from the stable roster.
    for (const destination of reachable) expect(destination.route).not.toBeNull();
    for (const destination of unavailable) {
      expect(destination.route, destination.id).toBeNull();
      expect(NAV_UNAVAILABLE_REASONS, destination.id).toContain(destination.reason);
    }
  });

  it("keeps an unavailable destination disabled and naming its reason while a navigator is wired", async () => {
    const onNavigate = vi.fn();
    // The navigator IS supplied. Availability is a property of the ROUTE, not of
    // whether a handler happened to be passed: a rail that reads
    // `onNavigate === undefined` would enable every destination here.
    render(<CordumShell onNavigate={onNavigate} />);

    const unavailable = resolveNavDestinations().filter((d) => d.reason !== null);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const destination of unavailable) {
      const button = screen.getByTestId(`cr.nav.${destination.id}`);
      // DISABLED, not inert: an inert control satisfies "clicking does nothing"
      // while telling the operator nothing about why.
      expect((button as HTMLButtonElement).disabled, destination.id).toBe(true);
      const describedBy = button.getAttribute("aria-describedby");
      expect(describedBy, destination.id).not.toBeNull();
      const reasonNode = document.getElementById(describedBy ?? "");
      expect(reasonNode, destination.id).not.toBeNull();
      // The rendered sentence is the one this reason code maps to - the operator
      // reads the measured reason, not a generic "unavailable".
      expect(reasonNode?.textContent, destination.id)
        .toBe(NAV_UNAVAILABLE_LABELS[destination.reason ?? "NAV_DESTINATION_NOT_BUILT"]);
    }
    await userEvent.click(screen.getByTestId(`cr.nav.${unavailable[0]?.id ?? "approvals"}`));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("navigates the reachable destination with the route the source of truth supplies", async () => {
    const onNavigate = vi.fn();
    render(<CordumShell onNavigate={onNavigate} />);

    const reachable = resolveNavDestinations().find((d) => d.reason === null);
    expect(reachable).toBeDefined();
    const button = screen.getByTestId(`cr.nav.${reachable?.id ?? "goals"}`);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBeNull();

    await userEvent.click(button);
    // The emitted value is the ROUTE object the roster supplied, read from the
    // roster rather than rebuilt beside the assertion.
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(reachable?.route);
  });
});

/**
 * The live work board's subject is DAEMON-STATED. `planningGoalRef` is the
 * daemon's durable goal binding on the affordance frame; the board repeats it and
 * never derives one by string-formatting something else.
 */
const BOARD_SURFACE = Object.freeze({
  nextAllowedCommands: Object.freeze([]),
  outcome: "SURFACE",
  planningGoalRef: "goal-durable-7c1f",
  steps: Object.freeze([]),
});

describe("the live work board states its durable subject", () => {
  it("repeats the daemon-stated planning goal reference verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(BOARD_SURFACE))));

    render(<LiveWorkBoard headers={{}} />);

    const subject = await screen.findByTestId("cr.board.subject");
    // Read from the fixture object, never spelled again beside the assertion.
    expect(subject.textContent).toContain(BOARD_SURFACE.planningGoalRef);
    expect(subject.getAttribute("data-goal")).toBe(BOARD_SURFACE.planningGoalRef);
  });

  it("says plainly that the daemon stated no durable subject rather than inventing one", async () => {
    const withoutRef = { ...BOARD_SURFACE, planningGoalRef: null };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(withoutRef))));

    render(<LiveWorkBoard headers={{}} />);

    const subject = await screen.findByTestId("cr.board.subject");
    expect(subject.getAttribute("data-goal")).toBeNull();
    expect(subject.textContent).toBe(BOARD_SUBJECT_ABSENT_NOTE);
  });
});
