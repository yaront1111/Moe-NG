import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCompatGate } from "@moe/control-room-client";
import type { ControlRoomTransport } from "@moe/control-room-client";
import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard } from "./live-board.js";
import { createBoardFeed, frameOfSurface } from "./live-board-feed.js";
import type { SurfaceFrame } from "./live-board-feed.js";

/**
 * The gate needs a matching report; build it from the gate's own refusal-free
 * admission path by reading the pins off the admitted surface — self-attested,
 * DEVELOPMENT-ONLY, exactly what the dev server does.
 */
function admittedClient() {
  const probe = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: "", errorRegistryVersion: "", queryEnvelopeVersion: "",
    },
    buildToolVersions: { test: "1" },
    contractSchemaHash: "",
  });
  expect(probe.ok).toBe(false);
  return null;
}

describe("frameOfSurface", () => {
  it("copies SURFACE steps and offers verbatim", () => {
    const frame = frameOfSurface({
      nextAllowedCommands: [{
        commandId: "afford-1", commandKind: "project.register", expectedVersion: 0,
        targetAggregateId: "proj",
      }],
      outcome: "SURFACE",
      planningGoalRef: "goal-daemon-offer-7",
      steps: [
        { aggregateId: "proj", kind: "project.register", missing: [], status: "READY", version: 0 },
        {
          aggregateId: null, kind: "goal.create",
          missing: ["project.activate"], status: "BLOCKED", version: null,
        },
      ],
    });
    expect(frame).toMatchObject({
      connection: "CONNECTED",
      offers: [{ commandId: "afford-1" }],
      outcome: "SURFACE",
      planningGoalRef: "goal-daemon-offer-7",
      steps: [
        { kind: "project.register", status: "READY" },
        { kind: "goal.create", missing: ["project.activate"], status: "BLOCKED" },
      ],
    });
    expect(frame.planningGoalRef).toBe("goal-daemon-offer-7");
  });

  it("carries an active claim verbatim, and a shape it cannot vouch for as null", () => {
    const frame = frameOfSurface({
      nextAllowedCommands: [],
      outcome: "SURFACE",
      steps: [
        {
          aggregateId: "node-code-1",
          claim: { claimedBy: "agent-7", expiresAt: "2026-08-22T12:00:00.000Z", version: 3 },
          kind: "node.deliver", missing: [], status: "READY", version: 0,
        },
        // Absent, null, and drifted shapes all carry as null — a half-claim is
        // worse than none, and one drifted field must not hide the whole chain.
        { aggregateId: "run-live-1", kind: "plan.propose", missing: [], status: "READY", version: 0 },
        {
          aggregateId: "goal-live-1", claim: null,
          kind: "goal.create", missing: [], status: "READY", version: 0,
        },
        {
          aggregateId: "proj", claim: { claimedBy: "", expiresAt: "soon" },
          kind: "project.register", missing: [], status: "READY", version: 0,
        },
      ],
    });
    expect(frame.outcome).toBe("SURFACE");
    expect(frame.steps.map((step) => step.claim)).toEqual([
      { claimedBy: "agent-7", expiresAt: "2026-08-22T12:00:00.000Z" },
      null,
      null,
      null,
    ]);
  });

  it("carries a daemon refusal as LAGGING with its exact code and refusing layer", () => {
    // Delivered: the transport worked and the daemon spoke. Calling that
    // CONNECTED hides that the board is showing nothing current, and calling it
    // DISCONNECTED sends the operator to debug a network that is fine.
    expect(frameOfSurface({
      code: "SESSION_LEDGER_UNREADABLE", layer: "DAEMON_READ_MODEL", outcome: "REFUSED",
    })).toEqual({
      connection: "LAGGING", detail: "SESSION_LEDGER_UNREADABLE @ DAEMON_READ_MODEL",
      offers: [], outcome: "REFUSED", planningGoalRef: null, steps: [],
    });
    // Layer absent: the code still carries alone rather than collapsing to generic.
    expect(frameOfSurface({ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" }))
      .toMatchObject({ connection: "LAGGING", detail: "SESSION_LEDGER_UNREADABLE" });
  });

  it("never echoes a hostile or unbounded refusal token into the frame detail", () => {
    const hostile: readonly unknown[] = [
      { code: "Bearer sk-live-9d2f-SECRET", layer: "DAEMON_READ_MODEL", outcome: "REFUSED" },
      { code: "session_ledger_unreadable", outcome: "REFUSED" },
      { code: `X${"Y".repeat(200)}`, outcome: "REFUSED" },
      { code: { toString: () => "SESSION_LEDGER_UNREADABLE" }, outcome: "REFUSED" },
      { code: "", layer: "DAEMON_READ_MODEL", outcome: "REFUSED" },
    ];
    expect(hostile.length).toBeGreaterThan(0);
    for (const response of hostile) {
      const projected = frameOfSurface(response);
      expect(projected.outcome).toBe("REFUSED");
      expect(projected.connection).toBe("LAGGING");
      expect(projected.detail).toBe("LIVE_SURFACE_UNREADABLE");
    }
    // An unsafe LAYER neither rides along nor suppresses a safe CODE.
    expect(frameOfSurface({
      code: "SESSION_LEDGER_UNREADABLE", layer: "trusted; token=abc", outcome: "REFUSED",
    }).detail).toBe("SESSION_LEDGER_UNREADABLE");
  });

  it("refuses an unreadable body with the stable code, as LAGGING not disconnected", () => {
    expect(frameOfSurface("nope"))
      .toMatchObject({ connection: "LAGGING", detail: "LIVE_SURFACE_UNREADABLE" });
  });

  it("reports CONNECTED only for a valid SURFACE and never invents a transport verdict", () => {
    const projections: readonly (readonly [unknown, SurfaceFrame["connection"]])[] = [
      [{ nextAllowedCommands: [], outcome: "SURFACE", steps: [] }, "CONNECTED"],
      [{ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" }, "LAGGING"],
      [{ nextAllowedCommands: [], outcome: "SOMETHING_NEW", steps: [] }, "LAGGING"],
      ["nope", "LAGGING"],
      [null, "LAGGING"],
    ];
    expect(projections.length).toBeGreaterThan(0);
    for (const [response, connection] of projections) {
      expect(frameOfSurface(response).connection).toBe(connection);
    }
    // Everything this reader sees was DELIVERED, so DISCONNECTED must never
    // come out of it; the transport verdict belongs to the poll loop alone.
    expect(projections.filter(([, connection]) => connection === "LAGGING")).toHaveLength(4);
  });

  it("refuses an incomplete or partially malformed surface instead of hiding records", () => {
    const malformed = [
      { outcome: "SURFACE", steps: [] },
      { nextAllowedCommands: [], outcome: "SURFACE", planningGoalRef: 7, steps: [] },
      { nextAllowedCommands: [], outcome: "SURFACE", steps: [{}] },
      {
        nextAllowedCommands: [], outcome: "SURFACE",
        steps: [{ aggregateId: "proj", kind: "project.register", missing: [1],
          status: "READY", version: 0 }],
      },
      { nextAllowedCommands: [null], outcome: "SURFACE", steps: [] },
    ];
    expect(malformed.length).toBeGreaterThan(0);
    for (const response of malformed) {
      expect(frameOfSurface(response)).toEqual({
        connection: "LAGGING", detail: "LIVE_SURFACE_UNREADABLE",
        offers: [], outcome: "UNREADABLE", planningGoalRef: null, steps: [],
      });
    }
  });
});

/** A delivered answer whose body reads back as `body`, with no transport of its own. */
function delivered(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as Response;
}

const SURFACE_BODY = Object.freeze({ nextAllowedCommands: [], outcome: "SURFACE", steps: [] });

/** One macrotask turn: every pending microtask chain settles before we assert. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe("createBoardFeed", () => {
  it("reports a DELIVERED answer whose body is not JSON as unreadable, not disconnected", async () => {
    // The daemon answered — the transport worked. Labelling a parse failure
    // DISCONNECTED/UNDELIVERED would send an operator to debug a network that
    // is fine instead of the answer that is malformed.
    const frames: SurfaceFrame[] = [];
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: () => Promise.resolve(new Response("<html>proxy error page</html>", { status: 200 })),
      schedule: () => () => undefined,
    });
    feed.start();
    await settle();
    feed.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      connection: "LAGGING", detail: "LIVE_SURFACE_UNREADABLE", outcome: "UNREADABLE",
    });
  });

  it("reports a delivered daemon refusal as LAGGING carrying its code and layer", async () => {
    const frames: SurfaceFrame[] = [];
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: () => Promise.resolve(delivered({
        code: "AFFORDANCE_READ_REFUSED", layer: "DAEMON_READ_MODEL", outcome: "REFUSED",
      })),
      schedule: () => () => undefined,
    });
    feed.start();
    await settle();
    feed.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      connection: "LAGGING", detail: "AFFORDANCE_READ_REFUSED @ DAEMON_READ_MODEL",
      outcome: "REFUSED",
    });
  });

  it("keeps DISCONNECTED for a request that never delivered", async () => {
    const frames: SurfaceFrame[] = [];
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: () => Promise.reject(new Error("ECONNREFUSED")),
      schedule: () => () => undefined,
    });
    feed.start();
    await settle();
    feed.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    });
  });

  it("re-arms as DISCONNECTED when the daemon accepts a poll and never answers", async () => {
    // The AMBIENT fetch path. A wedged-but-listening daemon rejects nothing on
    // its own, so without the poll's deadline signal reaching fetch the request
    // pends forever: no frame, no reschedule, the board frozen on its last
    // CONNECTED frame. The stub honours the abort contract exactly as a real
    // fetch does — reject with the signal's reason when it fires, never resolve.
    const frames: SurfaceFrame[] = [];
    const observed: AbortSignal[] = [];
    let scheduled = 0;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        // Not optional: the default post must hand fetch the poll's own signal.
        if (signal === null) { reject(new Error("DEFAULT_POST_CARRIED_NO_SIGNAL")); return; }
        observed.push(signal);
        signal.addEventListener("abort", () => { reject(signal.reason as Error); });
      }));
    try {
      const feed = createBoardFeed({
        headers: {},
        intervalMs: 60_000,
        onFrame: (frame) => frames.push(frame),
        requestTimeoutMs: 20,
        schedule: () => { scheduled += 1; return () => undefined; },
      });
      feed.start();
      await waitFor(() => { expect(frames).toHaveLength(1); });
      feed.stop();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(observed).toHaveLength(1);
    expect(observed[0]?.aborted).toBe(true);
    expect(frames[0]).toMatchObject({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    });
    // The hang converted to the already-handled rejection, so the loop re-armed.
    expect(scheduled).toBe(1);
  });

  it("bounds an INJECTED post that hangs and re-arms exactly once", async () => {
    // The deadline belongs to the poll, not to the default post: an injected
    // post that never settles must reach the same UNDELIVERED verdict.
    const frames: SurfaceFrame[] = [];
    const signals: AbortSignal[] = [];
    let aborts = 0;
    let scheduled = 0;
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: (_body, signal) => new Promise<Response>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => { aborts += 1; reject(signal.reason as Error); });
      }),
      requestTimeoutMs: 20,
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    feed.start();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => { expect(frames).toHaveLength(1); });
    feed.stop();
    expect(aborts).toBe(1);
    expect(frames[0]).toEqual({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED",
      offers: [], outcome: "UNDELIVERED", planningGoalRef: null, steps: [],
    });
    expect(scheduled).toBe(1);
  });

  it("bounds a DELIVERED response whose body never finishes reading", async () => {
    // Headers arrived, body stalls. Racing only the post leaves the loop parked
    // here forever: no frame, no reschedule, and no abort of the read.
    const frames: SurfaceFrame[] = [];
    let scheduled = 0;
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: () => Promise.resolve({
        json: () => new Promise<unknown>(() => undefined),
      } as Response),
      requestTimeoutMs: 20,
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    feed.start();
    await waitFor(() => { expect(frames).toHaveLength(1); });
    feed.stop();
    expect(frames[0]).toMatchObject({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    });
    expect(scheduled).toBe(1);
  });

  it("aborts the in-flight request on stop without emitting a frame or re-arming", async () => {
    const frames: SurfaceFrame[] = [];
    const signals: AbortSignal[] = [];
    let aborts = 0;
    let scheduled = 0;
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      post: (_body, signal) => new Promise<Response>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => { aborts += 1; reject(signal.reason as Error); });
      }),
      requestTimeoutMs: 60_000,
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    feed.start();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    // Idempotent: a second start must not open a second request on this generation.
    feed.start();
    expect(signals).toHaveLength(1);

    feed.stop();
    expect(aborts).toBe(1);
    expect(signals[0]?.aborted).toBe(true);

    // An unmount is a teardown, not a transport verdict: no DISCONNECTED frame
    // and no retry, and a second stop cannot abort a request already released.
    await settle();
    await settle();
    feed.stop();
    expect(aborts).toBe(1);
    expect(frames).toEqual([]);
    expect(scheduled).toBe(0);
  });

  it("falls back to the default deadline rather than firing on an unusable one", async () => {
    // 0 would abort on the next tick and re-arm forever; a value past
    // setTimeout's 32-bit ceiling silently clamps to ~1ms and does the same.
    for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const frames: SurfaceFrame[] = [];
      let scheduled = 0;
      const feed = createBoardFeed({
        headers: {},
        intervalMs: 60_000,
        onFrame: (frame) => frames.push(frame),
        post: () => new Promise<Response>(() => undefined),
        requestTimeoutMs,
        schedule: () => { scheduled += 1; return () => undefined; },
      });
      feed.start();
      await settle();
      await settle();
      expect(frames).toEqual([]);
      expect(scheduled).toBe(0);
      feed.stop();
    }
  });

  it("never offers a dispatchable command on a LAGGING frame", async () => {
    // LAGGING keeps actions enabled in the shell, so a frame that reached it
    // through a refusal or an unreadable body must carry nothing to dispatch.
    const bodies: readonly unknown[] = [
      { code: "AFFORDANCE_READ_REFUSED", layer: "DAEMON_READ_MODEL", outcome: "REFUSED" },
      { nextAllowedCommands: [], outcome: "SOMETHING_NEW", steps: [] },
      {
        nextAllowedCommands: [{
          commandId: "afford-1", commandKind: "project.register", expectedVersion: 0,
          targetAggregateId: "proj",
        }],
        outcome: "SURFACE",
        steps: [{}],
      },
    ];
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const frames: SurfaceFrame[] = [];
      const feed = createBoardFeed({
        headers: {},
        intervalMs: 60_000,
        onFrame: (frame) => frames.push(frame),
        post: () => Promise.resolve(delivered(body)),
        schedule: () => () => undefined,
      });
      feed.start();
      await settle();
      feed.stop();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.connection).toBe("LAGGING");
      expect(frames[0]?.offers).toEqual([]);
      expect(frames[0]?.steps).toEqual([]);
    }
  });

  it("consumes a response that arrives after its deadline instead of replaying it", async () => {
    const frames: SurfaceFrame[] = [];
    const answers: Array<(body: unknown) => void> = [];
    let scheduled = 0;
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 60_000,
      onFrame: (frame) => frames.push(frame),
      // Ignores the abort entirely, exactly as a misbehaving injected post can.
      post: () => new Promise<Response>((resolve) => {
        answers.push((body) => { resolve(delivered(body)); });
      }),
      requestTimeoutMs: 20,
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    feed.start();
    await waitFor(() => { expect(frames).toHaveLength(1); });
    expect(frames[0]?.connection).toBe("DISCONNECTED");
    expect(scheduled).toBe(1);

    // The deadline already spoke for this generation; the late answer is dead.
    answers[0]?.(SURFACE_BODY);
    await settle();
    expect(frames).toHaveLength(1);
    expect(scheduled).toBe(1);
    feed.stop();
  });

  it("gives a restart its own request, drops the stopped one, then reports loss honestly",
    async () => {
      const answers: Array<{ fail: (error: Error) => void; ok: (body: unknown) => void }> = [];
      const frames: SurfaceFrame[] = [];
      const rearms: Array<() => void> = [];
      const signals: AbortSignal[] = [];
      const feed = createBoardFeed({
        headers: {},
        intervalMs: 10_000,
        onFrame: (frame) => frames.push(frame),
        post: (_body, signal) => new Promise<Response>((resolve, reject) => {
          signals.push(signal);
          answers.push({
            fail: (error) => { reject(error); },
            ok: (body) => { resolve(delivered(body)); },
          });
        }),
        requestTimeoutMs: 60_000,
        schedule: (run) => { rearms.push(run); return () => undefined; },
      });

      // StrictMode's dev double-invoke: setup -> cleanup -> setup while poll A awaits.
      feed.start();
      feed.stop();
      feed.start();
      expect(answers).toHaveLength(2);
      expect(signals).toHaveLength(2);
      expect(signals[0]).not.toBe(signals[1]);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);

      // Poll A outlived its stop; it must neither deliver nor start a second loop.
      answers[0]?.ok(SURFACE_BODY);
      await settle();
      expect(frames).toEqual([]);
      expect(rearms).toHaveLength(0);

      // Poll B is the restart's own loop: exactly one frame, one reschedule.
      answers[1]?.ok(SURFACE_BODY);
      await settle();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.connection).toBe("CONNECTED");
      expect(rearms).toHaveLength(1);

      // The re-armed poll then loses the daemon: DISCONNECTED, nothing stale replayed.
      rearms[0]?.();
      await settle();
      expect(answers).toHaveLength(3);
      answers[2]?.fail(new Error("ECONNRESET"));
      await settle();
      expect(frames).toHaveLength(2);
      expect(frames[1]).toMatchObject({
        connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
      });
      feed.stop();
      expect(signals[2]?.aborted).toBe(false);
    });
});

describe("LiveBoard", () => {
  afterEach(cleanup);

  /**
   * `approval.decide` throughout as the representative kind; the per-kind
   * dispatch sweep lives in live-board-dispatch.test.tsx, so these arms only
   * need one card whose control certainly renders.
   */
  const READY_SURFACE = frameOfSurface({
    nextAllowedCommands: [{
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "afford-77",
      commandKind: "approval.decide", expectedVersion: 0,
      inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "approval-x",
    }],
    outcome: "SURFACE",
    steps: [
      {
        aggregateId: "approval-x", kind: "approval.decide", missing: [],
        status: "READY", version: 0,
      },
    ],
  });

  it("dispatches the daemon's affordance untouched through a real builder", async () => {
    // The generated builder validates the affordance itself, so a captured
    // envelope carrying the daemon-minted commandId proves the identity chain.
    admittedClient();
    const sent: RuntimeCommandEnvelope[] = [];
    const gate = { ok: true } as const;
    void gate;
    const client = {
      commands: {
        "approval.decide": (affordance: unknown, caller: unknown) => ({
          envelope: {
            ...(affordance as Record<string, unknown>),
            ...(caller as Record<string, unknown>),
          } as unknown as RuntimeCommandEnvelope,
          ok: true,
        }),
      },
    } as never;
    render(
      <LiveBoard
        client={client}
        frame={READY_SURFACE}
        sessionCredential="cred"
        transport={{
          sendCommand: (envelope) => {
            sent.push(envelope);
            return Promise.resolve({
              delivered: true as const,
              response: {
                decision: {
                  commandId: "afford-77", disposition: "DECIDED", effectId: null,
                  resultCode: "EFFECTS_COMMITTED",
                },
                httpStatus: 200, ok: true, outcome: "ACCEPTED",
              },
              status: 200,
            });
          },
        }}
      />,
    );
    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.approval.decide"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.liveboard.report.approval.decide@approval-x").textContent)
        .toContain("EFFECTS_COMMITTED");
    });
    const envelope = sent[0] as unknown as Record<string, unknown>;
    expect(envelope["commandId"]).toBe("afford-77");
    expect(envelope["expectedVersion"]).toBe(0);
  });

  it("admits only one in-flight dispatch for the same affordance", async () => {
    type SendResult = Awaited<ReturnType<ControlRoomTransport["sendCommand"]>>;
    let resolveSend: ((result: SendResult) => void) | undefined;
    const pending = new Promise<SendResult>((resolve) => { resolveSend = resolve; });
    let sends = 0;
    const client = {
      commands: {
        "approval.decide": (affordance: unknown, caller: unknown) => ({
          envelope: {
            ...(affordance as Record<string, unknown>),
            ...(caller as Record<string, unknown>),
          } as unknown as RuntimeCommandEnvelope,
          ok: true,
        }),
      },
    } as never;
    render(
      <LiveBoard
        client={client}
        frame={READY_SURFACE}
        sessionCredential="cred"
        transport={{ sendCommand: () => { sends += 1; return pending; } }}
      />,
    );
    const button = screen.getByTestId("cr.liveboard.dispatch.approval.decide");

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => { expect(sends).toBe(1); });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolveSend?.({
      delivered: true,
      response: {
        decision: {
          commandId: "afford-77", disposition: "DECIDED", effectId: null,
          resultCode: "EFFECTS_COMMITTED",
        },
        httpStatus: 200, ok: true, outcome: "ACCEPTED",
      },
      status: 200,
    });
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(false); });
  });

  /**
   * This used to be driven by dragging one of two same-kind cards onto Committed.
   * The drag surface is gone, but the claim underneath it is not: with two cards
   * of the SAME kind on the board, the control the operator used must dispatch
   * that card's affordance and not its neighbour's. It is now driven through the
   * target-specific accessible name, which is the only thing distinguishing the
   * two controls once the shared `data-testid` no longer can.
   */
  it("dispatches the exact target the operator used when command kinds repeat", async () => {
    const repeatedKindSurface = frameOfSurface({
      nextAllowedCommands: [
        {
          commandId: "afford-a", commandKind: "approval.decide", expectedVersion: 1,
          targetAggregateId: "approval-a",
        },
        {
          commandId: "afford-b", commandKind: "approval.decide", expectedVersion: 2,
          targetAggregateId: "approval-b",
        },
      ],
      outcome: "SURFACE",
      steps: [
        {
          aggregateId: "approval-a", kind: "approval.decide", missing: [],
          status: "READY", version: 1,
        },
        {
          aggregateId: "approval-b", kind: "approval.decide", missing: [],
          status: "READY", version: 2,
        },
      ],
    });
    const sent: RuntimeCommandEnvelope[] = [];
    const client = {
      commands: {
        "approval.decide": (affordance: unknown, caller: unknown) => ({
          envelope: {
            ...(affordance as Record<string, unknown>),
            ...(caller as Record<string, unknown>),
          } as unknown as RuntimeCommandEnvelope,
          ok: true,
        }),
      },
    } as never;
    render(
      <LiveBoard
        client={client}
        frame={repeatedKindSurface}
        sessionCredential="cred"
        transport={{
          sendCommand: (envelope) => {
            sent.push(envelope);
            return Promise.resolve({
              delivered: true as const,
              response: {
                decision: {
                  commandId: "afford-b", disposition: "DECIDED", effectId: null,
                  resultCode: "EFFECTS_COMMITTED",
                },
                httpStatus: 200, ok: true, outcome: "ACCEPTED",
              },
              status: 200,
            });
          },
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", {
      name: "Dispatch approval.decide for approval-b, version 2",
    }));

    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(sent[0]).toMatchObject({
      commandId: "afford-b",
      expectedVersion: 2,
      targetAggregateId: "approval-b",
    });
  });

  it("refuses a READY card whose offer does not bind its exact version", async () => {
    const mismatched = {
      connection: "CONNECTED" as const,
      detail: "",
      offers: [{
        commandId: "afford-old", commandKind: "approval.decide", expectedVersion: 1,
        targetAggregateId: "approval-x",
      }],
      outcome: "SURFACE",
      steps: [{
        aggregateId: "approval-x", claim: null, kind: "approval.decide", missing: [],
        status: "READY" as const, version: 2,
      }],
    };
    render(
      <LiveBoard
        client={{ commands: {} } as never}
        frame={mismatched}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.approval.decide"));

    expect(screen.getByTestId("cr.liveboard.report.approval.decide@approval-x").textContent)
      .toBe("the daemon offers no command for this move");
  });

  it("renders a daemon refusal verbatim on the card", async () => {
    const client = {
      commands: {
        "approval.decide": () => ({ envelope: {} as RuntimeCommandEnvelope, ok: true }),
      },
    } as never;
    render(
      <LiveBoard
        client={client}
        frame={READY_SURFACE}
        sessionCredential="cred"
        transport={{
          sendCommand: () => Promise.resolve({
            delivered: true as const,
            response: {
              httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
              refusal: {
                code: "BOOTSTRAP_PREREQUISITE_MISSING", detail: "",
                httpStatus: 422, layer: "BOOTSTRAP_SERVICE",
              },
              stage: "DISPATCH",
            },
            status: 422,
          }),
        }}
      />,
    );
    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.approval.decide"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.liveboard.report.approval.decide@approval-x").textContent)
        .toContain("BOOTSTRAP_PREREQUISITE_MISSING");
    });
  });

  it("shows the daemon refusal surface instead of a board", () => {
    render(
      <LiveBoard
        client={{ commands: {} } as never}
        frame={frameOfSurface({ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" })}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("unused")) }}
      />,
    );
    expect(screen.getByTestId("cr.liveboard.refused").textContent)
      .toContain("SESSION_LEDGER_UNREADABLE");
  });
});

/**
 * THE PLURAL PER-RUN BINDING (`planningGoalRefs`).
 *
 * The daemon answers a planning offer for EVERY durable goal it holds, so which goal a run
 * belongs to is a per-run fact, not a property of the surface. This reader copies that map
 * verbatim or refuses the frame; it never synthesises an entry, and specifically never widens
 * the singular seed binding into one, because a board that guessed a binding would dispatch a
 * plan under a goal the daemon never bound.
 */
const PLURAL_GOAL_A = "goal-sibling-a-3f11";
const PLURAL_GOAL_B = "goal-sibling-b-9c02";
const PLURAL_RUN_A = "run-sibling-a-3f11";
const PLURAL_RUN_B = "run-sibling-b-9c02";

/** The frame every arm below reads, with only `planningGoalRefs` varying. */
function surfaceWithRefs(refs: unknown, present = true): unknown {
  return {
    nextAllowedCommands: [],
    outcome: "SURFACE",
    planningGoalRef: PLURAL_GOAL_A,
    ...(present ? { planningGoalRefs: refs } : {}),
    steps: [],
  };
}

const UNREADABLE_FRAME = Object.freeze({
  connection: "LAGGING", detail: "LIVE_SURFACE_UNREADABLE",
  offers: [], outcome: "UNREADABLE", planningGoalRef: null, steps: [],
});

describe("the plural per-run planning binding", () => {
  it("carries a present map exactly and frozen, beside the singular seed binding", () => {
    const wire = { [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: PLURAL_GOAL_B };
    const frame = frameOfSurface(surfaceWithRefs(wire));

    expect(frame.outcome).toBe("SURFACE");
    expect(frame.planningGoalRef).toBe(PLURAL_GOAL_A);
    expect(frame.planningGoalRefs).toEqual({
      [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: PLURAL_GOAL_B,
    });
    expect(Object.isFrozen(frame.planningGoalRefs)).toBe(true);
    // A COPY, not the wire object: a later mutation of the answered body cannot
    // reach a frame the board is already rendering.
    wire[PLURAL_RUN_B] = "goal-swapped-after-the-read";
    expect(frame.planningGoalRefs?.[PLURAL_RUN_B]).toBe(PLURAL_GOAL_B);
  });

  it("accepts a null-prototype record, which is what a hardened producer sends", () => {
    const bare = Object.create(null) as Record<string, string>;
    bare[PLURAL_RUN_B] = PLURAL_GOAL_B;

    expect(frameOfSurface(surfaceWithRefs(bare)).planningGoalRefs)
      .toEqual({ [PLURAL_RUN_B]: PLURAL_GOAL_B });
  });

  it("leaves the map ABSENT when the daemon states none, never widening the singular into one", () => {
    for (const legacy of [surfaceWithRefs(null, false), surfaceWithRefs(null), surfaceWithRefs(undefined)]) {
      const frame = frameOfSurface(legacy);
      // The legacy frame still READS - it is only non-authoritative for planning.
      expect(frame.outcome).toBe("SURFACE");
      expect(frame.planningGoalRef).toBe(PLURAL_GOAL_A);
      expect(frame.planningGoalRefs).toBeUndefined();
      expect(Object.keys(frame)).not.toContain("planningGoalRefs");
    }
  });

  it("refuses a malformed PRESENT map whole rather than binding the half it could read", () => {
    const malformed: readonly unknown[] = [
      [],
      [[PLURAL_RUN_B, PLURAL_GOAL_B]],
      { "": PLURAL_GOAL_A },
      { [PLURAL_RUN_A]: "" },
      { [PLURAL_RUN_A]: 7 },
      { [PLURAL_RUN_A]: null },
      { [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: { goalId: PLURAL_GOAL_B } },
      "goal-as-a-string",
      7,
    ];

    // A swept set that produced nothing would pass vacuously.
    expect(malformed.length).toBeGreaterThan(5);
    for (const refs of malformed) {
      expect(frameOfSurface(surfaceWithRefs(refs)), JSON.stringify(refs) ?? "unprintable")
        .toEqual(UNREADABLE_FRAME);
    }
  });

  it("never invokes an accessor on the map, and refuses the frame that carried one", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, PLURAL_RUN_B, {
      configurable: true,
      enumerable: true,
      get: () => { getterCalls += 1; return PLURAL_GOAL_B; },
    });

    // Reading a getter is the daemon's answer computing itself against this board;
    // the frame is refused whole and the accessor is never called to decide that.
    expect(frameOfSurface(surfaceWithRefs(hostile))).toEqual(UNREADABLE_FRAME);
    expect(getterCalls).toBe(0);
  });
});
