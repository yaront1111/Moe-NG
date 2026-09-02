import { createHash } from "node:crypto";

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
import { PLAN_APPROVAL_LAYER } from "./goals/plan-approval.js";
import {
  GATE1_V2_CURRENT_BODY,
  GATE1_V2_CURRENT_SLOT,
} from "./goals/gate1-v2-test-fixture.js";
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
  bootstrapPlane = "V1";
  commandHook = null;
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

/** The plane the stubbed daemon states; V2 arms flip it, afterEach resets it. */
let bootstrapPlane: "V1" | "V2" = "V1";
/** Answers the transport's POST /command in the wired-app arms; null = not stubbed. */
let commandHook: ((body: string) => unknown) | null = null;
const BOOTSTRAP = Object.freeze({
  commandAuthorityPlane: "V1",
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
  challenge: Object.freeze({
    keyEpochRef: "key-epoch-live", profileRevisionId: "profile-live",
    recoveryIncarnationRef: "recovery-live",
  }),
  expiresAt: "2099-08-27T23:59:59.000Z",
  ok: true,
  principalId: "principal-live",
  projectId: "project-live",
  protocolVersion: WIRE,
  sessionCredential: "credential-live",
});
const SURFACE = Object.freeze({ nextAllowedCommands: [], outcome: "SURFACE", steps: [] });
const OPEN_KEYS = Object.freeze([
  "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
  "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
]);
function posted(init?: RequestInit): Readonly<Record<string, unknown>> {
  if (typeof init?.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as Readonly<Record<string, unknown>>;
}
function inspectClaim(init?: RequestInit): void {
  const body = posted(init);
  const headers = new Headers(init?.headers);
  expect(headers.get("x-moe-csrf")).toBe(BOOTSTRAP.csrfToken);
  expect(headers.get("x-moe-protocol-version")).toBe(WIRE);
  expect(headers.get("x-moe-session-credential")).toBeNull();
  expect(Object.keys(body).toSorted()).toEqual(["publicKeySpkiHex", "requestId"]);
  expect(body["requestId"]).toBe(PAIRING.requestId);
  expect(body["publicKeySpkiHex"]).toMatch(/^[0-9a-f]{88}$/u);
}
function inspectOpen(init?: RequestInit): Readonly<Record<string, unknown>> {
  const body = posted(init);
  const headers = new Headers(init?.headers);
  expect(headers.get("x-moe-csrf")).toBe(BOOTSTRAP.csrfToken);
  expect(headers.get("x-moe-protocol-version")).toBe(WIRE);
  expect(headers.get("x-moe-session-credential")).toBeNull();
  expect(Object.keys(body).toSorted()).toEqual(OPEN_KEYS);
  const proof = body["proof"] as Readonly<Record<string, unknown>>;
  expect(Object.keys(proof).toSorted()).toEqual([
    "algorithm", "issuedAt", "nonce", "protocolVersion", "signatureHex",
  ]);
  expect(JSON.stringify(body)).not.toContain("privateKey");
  expect(JSON.stringify({ body, headers: [...headers.entries()] })).not.toContain("PRIVATE-KEY-SECRET");
  return body;
}

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

function handshakeResponse(input: string, init?: RequestInit): Promise<Response> {
  if (input === "/command" && commandHook !== null) {
    return Promise.resolve(jsonResponse(commandHook(String(init?.body ?? ""))));
  }
  if (input === "/bootstrap") {
    return Promise.resolve(jsonResponse({ ...BOOTSTRAP, commandAuthorityPlane: bootstrapPlane }));
  }
  if (input === "/session/pair/request") {
    return Promise.resolve(jsonResponse(PAIRING, 200, OPERATOR_PRESENT));
  }
  if (input === "/session/pair/claim") {
    inspectClaim(init);
    return Promise.resolve(jsonResponse(CLAIMED));
  }
  if (input === "/session/pair/open") {
    const body = inspectOpen(init);
    return Promise.resolve(jsonResponse({ ok: true, protocolVersion: WIRE,
      sessionId: body["sessionId"] }));
  }
  return Promise.reject(new Error(`unexpected handshake fetch to ${input}`));
}

async function attachedSetup(signal?: AbortSignal): Promise<LiveHandshakeResult> {
  const result = await resolveLiveSetupFromHandshake({
    fetchImpl: (input, init) => handshakeResponse(input, init),
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
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(true);

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
        commandAuthorityPlane: "V1", csrfToken: "csrf-blue", projectId: "proj-blue",
        protocolVersion: WIRE,
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
    const open = deferred<Response>();
    let deliverSurface: ((response: Response) => void) | undefined;
    const surface = new Promise<Response>((resolve) => { deliverSurface = resolve; });
    let surfaceReads = 0;
    const fetchMock = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
      if (input === "/bootstrap") {
        return Promise.resolve(jsonResponse({
          commandAuthorityPlane: "V1", csrfToken: "csrf-live", projectId: "project-live",
          protocolVersion: WIRE,
        }));
      }
      if (input === "/session/pair/request") {
        return Promise.resolve(jsonResponse({
          confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "b".repeat(64),
        }, 200, OPERATOR_PRESENT));
      }
      if (input === "/session/pair/claim") {
        inspectClaim(init);
        return Promise.resolve(jsonResponse(CLAIMED));
      }
      if (input === "/session/pair/open") {
        inspectOpen(init);
        return open.promise;
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
      expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/open")).toHaveLength(1);
    });
    expect(screen.getByTestId("cr.shell.connection").textContent).toBe("COMING ONLINE");
    expect(surfaceReads).toBe(0);
    expect(fetchMock.mock.calls.filter(([input]) => input === "/session/pair/claim")).toHaveLength(1);
    const openBody = posted(fetchMock.mock.calls.find(([input]) => input === "/session/pair/open")?.[1]);
    open.resolve(jsonResponse({ ok: true, protocolVersion: WIRE, sessionId: openBody["sessionId"] }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => input === "/affordances/read")).toBe(true);
    });

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
        fetchImpl: (input, init) => input === "/bootstrap"
          ? bootstrap.promise : handshakeResponse(input, init),
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
      "LIVE_PAIRING_REFUSED: session pairing claim refused",
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
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(false);
    observed.push(connection() ?? "MISSING");
    await waitFor(() => { expect(connection()).toBe("DISCONNECTED"); }, { timeout: 3_500 });
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(true);
    observed.push(connection() ?? "MISSING");
    await waitFor(() => { expect(connection()).toBe("CONNECTED"); }, { timeout: 3_500 });
    expect((screen.getByTestId("cr.goals.new") as HTMLButtonElement).disabled).toBe(false);
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
    expect(CORDUM_ROUTE_KINDS).toHaveLength(4);

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
    expect(reachable).toHaveLength(3);
    expect(unavailable).toHaveLength(NAV_IDS.length - 3);
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
 * The live work board's subject is DAEMON-STATED, and it is PER RUN. The daemon
 * binds every durable goal to its own planning run in `planningGoalRefs`; the board
 * repeats the binding for the run it was OPENED on, never the surface-wide singular
 * seed binding and never a subject derived by string-formatting something else.
 */
const BOARD_OPEN = Object.freeze({ goalId: "goal-durable-7c1f", runId: "run-durable-7c1f" });

const BOARD_SURFACE = Object.freeze({
  nextAllowedCommands: Object.freeze([]),
  outcome: "SURFACE",
  // The seed's compatibility binding, deliberately NOT this board's goal.
  planningGoalRef: "goal-seed-compat-0001",
  planningGoalRefs: Object.freeze({ [BOARD_OPEN.runId]: BOARD_OPEN.goalId }),
  steps: Object.freeze([]),
});

describe("the live work board states its durable subject", () => {
  it("repeats the goal the daemon bound to THIS run, not the singular seed binding", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(BOARD_SURFACE))));

    render(<LiveWorkBoard goalId={BOARD_OPEN.goalId} headers={{}} runId={BOARD_OPEN.runId} />);

    const subject = await screen.findByTestId("cr.board.subject");
    // Read from the fixture object, never spelled again beside the assertion.
    expect(subject.textContent).toContain(BOARD_OPEN.goalId);
    expect(subject.getAttribute("data-goal")).toBe(BOARD_OPEN.goalId);
    expect(subject.textContent).not.toContain(BOARD_SURFACE.planningGoalRef);
  });

  it("says plainly that the daemon bound no goal to this run rather than inventing one", async () => {
    const otherRunOnly = {
      ...BOARD_SURFACE,
      planningGoalRefs: { "run-somebody-elses": "goal-somebody-elses" },
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(otherRunOnly))));

    render(<LiveWorkBoard goalId={BOARD_OPEN.goalId} headers={{}} runId={BOARD_OPEN.runId} />);

    const subject = await screen.findByTestId("cr.board.subject");
    expect(subject.getAttribute("data-goal")).toBeNull();
    expect(subject.textContent).toBe(BOARD_SUBJECT_ABSENT_NOTE);
  });

  it("refuses a binding that contradicts the goal the operator opened", async () => {
    // The daemon bound this run to ANOTHER goal. Rendering the opened goal's title
    // over that run would state a binding the daemon just contradicted.
    const contradicted = {
      ...BOARD_SURFACE,
      planningGoalRefs: { [BOARD_OPEN.runId]: "goal-a-different-one" },
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(contradicted))));

    render(<LiveWorkBoard goalId={BOARD_OPEN.goalId} headers={{}} runId={BOARD_OPEN.runId} />);

    const subject = await screen.findByTestId("cr.board.subject");
    expect(subject.textContent).toBe(BOARD_SUBJECT_ABSENT_NOTE);
    expect(subject.getAttribute("data-goal")).toBeNull();
  });
});

/**
 * THE SHELL WIRING, end to end through the real entry (DoD-2, DoD-3, DoD-4).
 *
 * One durable goal, its own planning run, and the daemon's own approval offer
 * bound to that run. Every identifier is READ BACK FROM `DURABLE` below - the
 * plan-review request body is compared against the fixture's run reference, never
 * against a literal respelled beside the assertion, so hard-coding a run id in
 * production reddens this arm instead of matching it.
 */
const DURABLE = Object.freeze({
  goalRef: "goal-9d41c07a55e2",
  runRef: "run-2b8fe1c94a70",
  title: "Recover the ledger from genesis",
});

/**
 * THE SIBLING. A second durable goal with its own planning run, inserted FIRST
 * everywhere the surface is ordered (catalog, map, steps, offers) and named by the
 * surface's singular seed binding, so any production path that reaches for "the
 * first one" or "the surface's goal" lands on A while the operator opened B.
 */
const SIBLING = Object.freeze({
  goalRef: "goal-1a2b3c4d5e6f",
  runRef: "run-1a2b3c4d5e6f",
  title: "The sibling goal nobody opened",
});

const APPROVAL_OFFER = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  commandId: "cmd-approve-1",
  commandKind: "approval.decide_intent",
  expectedVersion: 4,
  inputSchemaVersion: "moe-bootstrap/1",
  targetAggregateId: DURABLE.runRef,
});

const DURABLE_CATALOG = Object.freeze({
  goals: Object.freeze([
    Object.freeze({
      brief: Object.freeze({ instructions: "Someone else's plan.", title: SIBLING.title }),
      goalId: SIBLING.goalRef,
      planningRunRef: SIBLING.runRef,
      truthClass: "DAEMON_VERIFIED",
    }),
    Object.freeze({
      brief: Object.freeze({ instructions: "Restore from a fresh genesis.", title: DURABLE.title }),
      goalId: DURABLE.goalRef,
      planningRunRef: DURABLE.runRef,
      truthClass: "DAEMON_VERIFIED",
    }),
  ]),
  nextCursor: null,
  outcome: "GOALS",
});

/** The daemon's planning offer per durable goal: the sibling's first. */
function planningOffer(target: string, expectedVersion: number): unknown {
  return Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: `cmd-plan-${target}`,
    commandKind: "plan.propose",
    expectedVersion,
    inputSchemaVersion: "moe-bootstrap/1",
    targetAggregateId: target,
  });
}

/**
 * The daemon's own steps. Its seed-compat planning rows name the SEED run (the
 * sibling here); the non-planning rows belong to no goal and must survive the
 * opened-board scoping untouched.
 */
const SURFACE_STEPS: readonly unknown[] = Object.freeze([
  Object.freeze({
    aggregateId: SIBLING.runRef, kind: "plan.propose", missing: [], status: "READY", version: 0,
  }),
  Object.freeze({
    aggregateId: SIBLING.goalRef, kind: "goal.close", missing: ["approval.decide"],
    status: "BLOCKED", version: 1,
  }),
  Object.freeze({
    aggregateId: "node-code-1", kind: "node.deliver", missing: [], status: "READY", version: 2,
  }),
]);

const SEALED_RUN = Object.freeze({
  acceptance: null,
  authority: null,
  lifecycle: "PLAN_REVIEW",
  outcome: "RUN",
  plan: Object.freeze({
    affectedCriterionIds: Object.freeze([]),
    affectedNodeIds: Object.freeze([]),
    planHash: "plan-hash-durable",
    steps: Object.freeze([
      Object.freeze({ description: "Write the recovery contract", kind: "ANALYSIS", stepId: "step-1" }),
    ]),
  }),
  reviewable: true,
  approval: "ABSENT",
  runId: DURABLE.runRef,
  submissionHash: "submission-hash-durable",
});

/** The `/1` pending answer as the daemon's V1 read composes it (product-contract-pending-read.ts). */
const V1_PENDING_BODY = Object.freeze({
  approval: {
    affordance: Object.freeze({
      commandEnvelopeVersion: "moe-command-envelope/1",
      commandId: "gate1-cmd-1",
      commandKind: "product_contract.approve_gate_1",
      expectedVersion: 0,
      inputSchemaVersion: "moe-product-contract-gate-1/1",
      targetAggregateId: `product-contract-gate-1-${"a".repeat(64)}`,
    }),
    commandId: "gate1-cmd-1",
    requestDigest: "b".repeat(64),
  },
  outcome: "PENDING",
  ref: { contractId: "contract-1", revisionDigest: "c".repeat(64), revisionId: "rev-1" },
  revision: {
    contractId: "contract-1",
    criteria: [{ criterionId: "crit-1", requirementId: "req-1", statement: "It works." }],
    requirements: [{ requirementId: "req-1", statement: "Users can sign in." }],
    revisionId: "rev-1",
  },
});

interface WiredApp {
  readonly pendingReads: string[];
  readonly planningReads: string[];
}

/** Attaches the app over a daemon that offers approval for exactly this run. */
function renderWiredApp(
  offers: readonly unknown[] = [APPROVAL_OFFER],
  pendingBody: unknown = { outcome: "NONE" },
  plane: "V1" | "V2" = "V1",
  command?: (body: string) => unknown,
): WiredApp {
  bootstrapPlane = plane;
  commandHook = command ?? null;
  const pendingReads: string[] = [];
  const planningReads: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if (input === "/affordances/read") {
      return Promise.resolve(jsonResponse({
        nextAllowedCommands: [
          planningOffer(SIBLING.runRef, 0), planningOffer(DURABLE.runRef, 3), ...offers,
        ],
        outcome: "SURFACE",
        // The seed's compatibility binding names the SIBLING, never the opened goal.
        planningGoalRef: SIBLING.goalRef,
        planningGoalRefs: {
          [SIBLING.runRef]: SIBLING.goalRef, [DURABLE.runRef]: DURABLE.goalRef,
        },
        steps: SURFACE_STEPS,
      }));
    }
    if (input === "/goals/read") return Promise.resolve(jsonResponse(DURABLE_CATALOG));
    if (input === "/v2/product-contract/pending/read"
      || input === "/product-contract/pending/read") {
      pendingReads.push(`${input} ${String(init?.body ?? "")}`);
      return Promise.resolve(jsonResponse(pendingBody));
    }
    if (input === "/planning/run/read") {
      planningReads.push(String(init?.body ?? ""));
      return Promise.resolve(jsonResponse(SEALED_RUN));
    }
    return handshakeResponse(input, init);
  }));
  render(<CordumApp liveSetup={attachedSetup()} />);
  return { pendingReads, planningReads };
}

function currentBodyForProject(projectId: string): unknown {
  const { slotDigest: _slotDigest, ...source } = { ...GATE1_V2_CURRENT_SLOT, projectId };
  const canonicalText = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
    if (typeof value === "object") {
      const row = value as Readonly<Record<string, unknown>>;
      return `{${Object.keys(row).sort().map(
        (key) => `${JSON.stringify(key)}:${canonicalText(row[key])}`,
      ).join(",")}}`;
    }
    throw new TypeError("non-canonical current-slot test value");
  };
  return {
    ...GATE1_V2_CURRENT_BODY,
    slot: {
      ...source,
      slotDigest: createHash("sha256")
        .update("moe-product-contract-current-revision-slot-digest/2", "utf8")
        .update(Uint8Array.of(0))
        .update(new TextEncoder().encode(canonicalText(source)))
        .digest("hex"),
    },
  };
}

async function openTheDurableBoard(): Promise<void> {
  const open = await screen.findByTestId(`cr.goals.card.${DURABLE.goalRef}.open`);
  expect((open as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(open);
}

describe("CordumApp wires the durable run and the daemon's approval grant", () => {
  it("binds CURRENT admission to the project attached by the runtime handshake", async () => {
    const app = renderWiredApp(
      [APPROVAL_OFFER], currentBodyForProject(BOOTSTRAP.projectId), "V2",
    );
    await openTheDurableBoard();

    expect((await screen.findByTestId("cr.gate1.current")).textContent)
      .toContain("reported current at the last read");
    expect(screen.getByTestId("cr.gate1.current-slot").textContent)
      .toContain(BOOTSTRAP.projectId);
    // The V2 plane reads the `/2` route, and only that route.
    expect(app.pendingReads).toEqual([
      `/v2/product-contract/pending/read ${JSON.stringify({ goalRef: DURABLE.goalRef })}`,
    ]);
  });

  it("reads the V1 pending contract and approves it on the plane the daemon states", async () => {
    const posted: Record<string, unknown>[] = [];
    const app = renderWiredApp([APPROVAL_OFFER], V1_PENDING_BODY, "V1", (body) => {
      posted.push(JSON.parse(body) as Record<string, unknown>);
      return { ok: true };
    });
    await openTheDurableBoard();

    // The V1 plane reads the `/1` route with the same goal ref, never `/v2/...`.
    expect((await screen.findByTestId("cr.gate1.requirement.req-1")).textContent)
      .toContain("Users can sign in.");
    expect(app.pendingReads).toEqual([
      `/product-contract/pending/read ${JSON.stringify({ goalRef: DURABLE.goalRef })}`,
    ]);
    const approve = await screen.findByTestId("cr.gate1.approve");
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(approve);

    // The approval left on the V1 command route, presenting the daemon-minted identity.
    await waitFor(() => { expect(posted).toHaveLength(1); });
    expect(posted[0]?.["commandKind"]).toBe("product_contract.approve_gate_1");
    expect(posted[0]?.["commandId"]).toBe(V1_PENDING_BODY.approval.commandId);
    expect(posted[0]?.["targetAggregateId"])
      .toBe(V1_PENDING_BODY.approval.affordance.targetAggregateId);
    expect(screen.queryByTestId("cr.gate1.dispatchrefusal")).toBeNull();
    // It re-read the SAME route after the accepted approval.
    await waitFor(() => { expect(app.pendingReads).toHaveLength(2); });
    expect(app.pendingReads[1]).toContain("/product-contract/pending/read ");
  });

  it("reads the plan for the run the CARD carried, never a build-time run subject", async () => {
    const app = renderWiredApp();
    await openTheDurableBoard();

    await waitFor(() => { expect(app.planningReads.length).toBeGreaterThan(0); });
    // The request body names the fixture's OWN run reference. A production module
    // that spells a run id of its own cannot satisfy this.
    for (const body of app.planningReads) {
      expect(JSON.parse(body)).toEqual({ runId: DURABLE.runRef });
    }
    expect(await screen.findByTestId("cr.approve.step.step-1")).toBeTruthy();
  });

  it("enables Approve only because the daemon OFFERED the intent for this run", async () => {
    renderWiredApp();
    await openTheDurableBoard();

    const button = await screen.findByTestId("cr.approve.button");
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(false); });
    // Granted, so there is no withheld reason to show.
    expect(screen.queryByTestId("cr.approve.reason")).toBeNull();
  });

  it("routes the nav rail through the shell's own route source of truth, back to goals", async () => {
    renderWiredApp();
    await openTheDurableBoard();
    expect(await screen.findByTestId("cr.approve.screen")).toBeTruthy();

    // The destination is read from the ROSTER, so the rail and the entry cannot
    // disagree about which nav id carries the goals route.
    const goals = resolveNavDestinations().find((entry) => entry.route?.kind === "goals");
    expect(goals).toBeDefined();
    const rail = screen.getByTestId(`cr.nav.${goals?.id ?? "goals"}`);
    expect((rail as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(rail);

    await waitFor(() => { expect(screen.queryByTestId("cr.approve.screen")).toBeNull(); });
    expect(await screen.findByTestId(`cr.goals.card.${DURABLE.goalRef}.open`)).toBeTruthy();
  });

  it("keeps Approve DISABLED naming the gate's code when the daemon offers no such grant", async () => {
    // Same surface, same run, only the OFFER removed: the single degree of freedom
    // is the daemon's grant, so a control that enabled here would be self-authorizing.
    renderWiredApp([]);
    await openTheDurableBoard();

    const button = await screen.findByTestId("cr.approve.button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = await screen.findByTestId("cr.approve.reason");
    expect(reason.textContent).toContain("APPROVAL_AFFORDANCE_ABSENT");
    expect(reason.textContent).toContain(PLAN_APPROVAL_LAYER);
  });
});

/**
 * THE OPENED GOAL'S BOARD SHOWS THAT GOAL'S OWN RUN, AND NOTHING OF ITS SIBLING.
 *
 * The free-agent evidence this row exists for was the opposite: opening a NEW goal's
 * board rendered the SEED goal's sealed plan. So every arm below opens B while A is
 * first in the catalog, first in the surface's step list, first in the plural map and
 * the sole subject of the singular seed binding — the four places a production path
 * could reach for "the first one" and be wrong.
 */
describe("the opened goal's board is scoped to that goal's own run", () => {
  it("reads the plan by the OPENED card's run, by exact body roster, and never the sibling's", async () => {
    const app = renderWiredApp();
    await openTheDurableBoard();

    await waitFor(() => { expect(app.planningReads.length).toBeGreaterThan(0); });
    for (const body of app.planningReads) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      // Exact roster AND exact value: a body that also carried the sibling's run,
      // or that named it instead, fails on the key list before the value compare.
      expect(Object.keys(parsed)).toEqual(["runId"]);
      expect(parsed).toEqual({ runId: DURABLE.runRef });
      expect(body).not.toContain(SIBLING.runRef);
    }
  });

  it("shows the planning card the daemon OFFERED for this run, and no card of the sibling's", async () => {
    renderWiredApp();
    await openTheDurableBoard();

    // The raw line is the card's own restatement of the frame: `kind @ aggregateId`.
    const raws = async (): Promise<readonly string[]> =>
      (await screen.findAllByTestId("cr.board.raw")).map((node) => node.textContent ?? "");
    await waitFor(async () => {
      expect(await raws()).toContain(`plan.propose @ ${DURABLE.runRef}`);
    });

    const rendered = await raws();
    // The daemon's seed-compat planning rows named the sibling's run and goal; they
    // are the rows that used to leak the seed's plan under every opened goal.
    for (const line of rendered) {
      expect(line).not.toContain(SIBLING.runRef);
      expect(line).not.toContain(SIBLING.goalRef);
    }
    // Non-planning work is untouched by the scoping: it belongs to no goal.
    expect(rendered).toContain("node.deliver @ node-code-1");
    // And nothing anywhere on the opened board names the sibling.
    expect(screen.getByTestId("cr.board.root").textContent ?? "")
      .not.toContain(SIBLING.runRef);
    expect(screen.queryByText(SIBLING.title)).toBeNull();
  });

  it("names the opened goal as the board's durable subject, not the seed binding", async () => {
    renderWiredApp();
    await openTheDurableBoard();

    const subject = await screen.findByTestId("cr.board.subject");
    expect(subject.getAttribute("data-goal")).toBe(DURABLE.goalRef);
    expect(subject.textContent).not.toContain(SIBLING.goalRef);
  });

  it("opens the SIBLING's board on its own run when that is the card clicked", async () => {
    // The same fixture, the other card: the scoping is a function of what was
    // opened, not a second hard-coded subject.
    const app = renderWiredApp();
    await userEvent.click(await screen.findByTestId(`cr.goals.card.${SIBLING.goalRef}.open`));

    await waitFor(() => { expect(app.planningReads.length).toBeGreaterThan(0); });
    for (const body of app.planningReads) {
      expect(JSON.parse(body)).toEqual({ runId: SIBLING.runRef });
    }
    const raws = (await screen.findAllByTestId("cr.board.raw")).map((n) => n.textContent ?? "");
    expect(raws).toContain(`plan.propose @ ${SIBLING.runRef}`);
    for (const line of raws) expect(line).not.toContain(DURABLE.runRef);
  });
});
