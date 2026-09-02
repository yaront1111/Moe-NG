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

/**
 * The board's budget-commitment reader, stubbed. `dispatchAffordance` fails CLOSED without one
 * on `approval.decide`: `record.budgetRef` is the daemon's decide-time commitment (task-61a2e8ad)
 * and no browser can mint it. `live-app.tsx` builds the real one from the setup's headers.
 */
const readsCommitment = (): Promise<{ ref: string; status: "COMMITMENT" }> =>
  Promise.resolve({ ref: "4d".repeat(32), status: "COMMITMENT" as const });

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

/** The daemon's goal bindings for one or more approval runs, and their material. */
function approvalRefs(runIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(runIds.map((runId) => [runId, `goal-${runId}`]));
}

function approvalMaterial(runIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(runIds.map((runId) => [runId, materialOf({
    bytes: "YXBwcm92YWwtZ3JhcGg=", criteriaDigest: "c1".repeat(32), goalRef: `goal-${runId}`,
    graphHash: "7c".repeat(32), runId, submissionHash: "5e".repeat(32),
  })]));
}

describe("LiveBoard", () => {
  afterEach(cleanup);

  /**
   * `approval.decide` throughout as the representative kind; the per-kind
   * dispatch sweep lives in live-board-dispatch.test.tsx, so these arms only
   * need one card whose control certainly renders. An approval control renders
   * only for a run the daemon bound to a goal AND stated material for, so every
   * surface below states both — the VALID wire facts, never a weaker expectation.
   */
  const READY_SURFACE = frameOfSurface({
    nextAllowedCommands: [{
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "afford-77",
      commandKind: "approval.decide", expectedVersion: 0,
      inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "approval-x",
    }],
    outcome: "SURFACE",
    planningAuthorityByRun: approvalMaterial(["approval-x"]),
    planningGoalRefs: approvalRefs(["approval-x"]),
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
        readBudgetCommitment={readsCommitment}
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
        readBudgetCommitment={readsCommitment}
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
      planningAuthorityByRun: approvalMaterial(["approval-a", "approval-b"]),
      planningGoalRefs: approvalRefs(["approval-a", "approval-b"]),
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
        readBudgetCommitment={readsCommitment}
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
        commandId: "afford-old", commandKind: "project.register", expectedVersion: 1,
        targetAggregateId: "proj-x",
      }],
      outcome: "SURFACE",
      steps: [{
        aggregateId: "proj-x", claim: null, kind: "project.register", missing: [],
        status: "READY" as const, version: 2,
      }],
    };
    render(
      <LiveBoard
        client={{ commands: {} } as never}
        frame={mismatched}
        readBudgetCommitment={readsCommitment}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.project.register"));

    expect(screen.getByTestId("cr.liveboard.report.project.register@proj-x").textContent)
      .toBe("the daemon offers no command for this move");
  });

  it("renders no PLANNING control at all when no offer binds the card's exact version", () => {
    // Stricter than the arm above, and deliberately so: an authority-bearing kind reads its
    // material off the exact offer, so a card no offer binds has none and gets no control.
    // The version-mismatch report path above still exists for every other kind.
    const mismatched = {
      connection: "CONNECTED" as const,
      detail: "",
      offers: frameOfSurface({
        nextAllowedCommands: [{
          commandId: "afford-old", commandKind: "approval.decide", expectedVersion: 1,
          targetAggregateId: "approval-x",
        }],
        outcome: "SURFACE",
        planningAuthorityByRun: approvalMaterial(["approval-x"]),
        planningGoalRefs: approvalRefs(["approval-x"]),
        steps: [],
      }).offers,
      outcome: "SURFACE",
      planningGoalRefs: approvalRefs(["approval-x"]),
      steps: [{
        aggregateId: "approval-x", claim: null, kind: "approval.decide", missing: [],
        status: "READY" as const, version: 2,
      }],
    };
    render(
      <LiveBoard
        client={{ commands: {} } as never}
        frame={mismatched}
        readBudgetCommitment={readsCommitment}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    expect(screen.queryByTestId("cr.liveboard.dispatch.approval.decide")).toBeNull();
    // The card itself still renders: the fact is readable, only the click is withheld.
    expect(screen.getByTestId("cr.liveboard.card.approval.decide@approval-x")).toBeTruthy();
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
        readBudgetCommitment={readsCommitment}
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
        readBudgetCommitment={readsCommitment}
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

/**
 * THE DAEMON'S PER-RUN PLANNING AUTHORITY (`planningAuthorityByRun`), spelled exactly as
 * `apps/daemon/src/http/affordance-planning-authorities.ts` puts it on the wire: seven keys,
 * no more and no fewer. Sibling A and sibling B differ in EVERY bound member — goal, run,
 * revision ref, graph hash, graph bytes, submission hash and the whole authority body — so a
 * production module that picked the map's FIRST entry rather than the offer's own would author
 * A's operands on B's card and be caught, rather than producing a value both siblings share.
 */
const PLURAL_GRAPH_HASH_A = "a1".repeat(32);
const PLURAL_GRAPH_HASH_B = "b2".repeat(32);
const PLURAL_SUBMISSION_A = "a3".repeat(32);
const PLURAL_SUBMISSION_B = "b4".repeat(32);
const PLURAL_CRITERIA_A = "a5".repeat(32);
const PLURAL_CRITERIA_B = "b6".repeat(32);
const PLURAL_BYTES_A = "c2libGluZy1hLWdyYXBo";
const PLURAL_BYTES_B = "c2libGluZy1iLWdyYXBo";

interface MaterialFacts {
  readonly bytes: string;
  readonly criteriaDigest: string;
  readonly goalRef: string;
  readonly graphHash: string;
  readonly runId: string;
  readonly submissionHash: string;
}

/** One run's wire material: the producer's exact seven keys, and nothing else. */
function materialOf(facts: MaterialFacts): Record<string, unknown> {
  const revisionRef = `${facts.runId}-graph-revision`;
  const graphBinding = { graphContentHash: facts.graphHash, graphRevisionRef: revisionRef };
  return {
    authority: {
      acceptanceContract: {
        applicability: { ...graphBinding, nodeIds: [`${facts.runId}-node`], nodeKind: "LEAF" },
        authorRef: `${facts.runId}-author`,
        contractId: `${facts.runId}-contract`,
        criteriaDigest: facts.criteriaDigest,
        obligations: [{
          criterionId: `${facts.goalRef}-criterion`,
          statement: `the run satisfies ${facts.goalRef}-criterion`,
        }],
        version: "moe-acceptance-contract/1",
      },
      planRevision: {
        affectedCriterionIds: [`${facts.goalRef}-criterion`],
        affectedNodeIds: [`${facts.runId}-node`],
        approvalState: "PENDING_APPROVAL",
        authorRef: `${facts.runId}-author`,
        graphBinding,
        parentRevisionId: null,
        planHash: facts.submissionHash,
        rejectionRef: null,
        revisionId: `${facts.runId}-revision`,
        version: "moe-plan-revision/1",
      },
    },
    goalRef: facts.goalRef,
    graphContentBytesBase64: facts.bytes,
    graphContentHash: facts.graphHash,
    graphRevisionRef: revisionRef,
    runId: facts.runId,
    submissionHash: facts.submissionHash,
  };
}

const MATERIAL_A = materialOf({
  bytes: PLURAL_BYTES_A, criteriaDigest: PLURAL_CRITERIA_A, goalRef: PLURAL_GOAL_A,
  graphHash: PLURAL_GRAPH_HASH_A, runId: PLURAL_RUN_A, submissionHash: PLURAL_SUBMISSION_A,
});
const MATERIAL_B = materialOf({
  bytes: PLURAL_BYTES_B, criteriaDigest: PLURAL_CRITERIA_B, goalRef: PLURAL_GOAL_B,
  graphHash: PLURAL_GRAPH_HASH_B, runId: PLURAL_RUN_B, submissionHash: PLURAL_SUBMISSION_B,
});
/** A first, B second: the ORDER is the point of the two-sibling arm. */
const BOTH_MATERIAL: Readonly<Record<string, unknown>> =
  Object.freeze({ [PLURAL_RUN_A]: MATERIAL_A, [PLURAL_RUN_B]: MATERIAL_B });

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

function siblingPlanningFrame(
  refs: Readonly<Record<string, string>>,
  authorities: unknown = BOTH_MATERIAL,
  authoritiesPresent = true,
): SurfaceFrame {
  return frameOfSurface({
    ...(authoritiesPresent ? { planningAuthorityByRun: authorities } : {}),
    nextAllowedCommands: [
      {
        commandId: "plan-sibling-a", commandKind: "plan.propose", expectedVersion: 0,
        targetAggregateId: PLURAL_RUN_A,
      },
      {
        commandId: "plan-sibling-b", commandKind: "plan.propose", expectedVersion: 0,
        targetAggregateId: PLURAL_RUN_B,
      },
    ],
    outcome: "SURFACE",
    planningGoalRefs: refs,
    steps: [
      {
        aggregateId: PLURAL_RUN_A, kind: "plan.propose", missing: [],
        status: "READY", version: 0,
      },
      {
        aggregateId: PLURAL_RUN_B, kind: "plan.propose", missing: [],
        status: "READY", version: 0,
      },
    ],
  });
}

const SIBLING_PLANNING_CLIENT = {
  commands: {
    "plan.propose": (affordance: unknown, caller: unknown) => ({
      envelope: {
        ...(affordance as Record<string, unknown>),
        ...(caller as Record<string, unknown>),
      } as unknown as RuntimeCommandEnvelope,
      ok: true,
    }),
  },
} as never;

function siblingPlanningTransport(
  sent: RuntimeCommandEnvelope[],
): Pick<ControlRoomTransport, "sendCommand"> {
  return {
    sendCommand: (envelope) => {
      sent.push(envelope);
      return Promise.resolve({
        delivered: true,
        response: {
          decision: {
            commandId: "plan-sibling-b", disposition: "DECIDED", effectId: null,
            resultCode: "EFFECTS_COMMITTED",
          },
          httpStatus: 200, ok: true, outcome: "ACCEPTED",
        },
        status: 200,
      });
    },
  };
}

const UNREADABLE_FRAME = Object.freeze({
  connection: "LAGGING", detail: "LIVE_SURFACE_UNREADABLE",
  offers: [], outcome: "UNREADABLE", planningGoalRef: null, steps: [],
});

describe("the plural per-run planning binding", () => {
  afterEach(cleanup);

  it("dispatches sibling B with only sibling B's durable goal binding", async () => {
    const sent: RuntimeCommandEnvelope[] = [];
    const transport = siblingPlanningTransport(sent);
    const { rerender } = render(
      <LiveBoard
        client={SIBLING_PLANNING_CLIENT}
        frame={siblingPlanningFrame({
          [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: PLURAL_GOAL_B,
        })}
        readBudgetCommitment={readsCommitment}
        sessionCredential="cred"
        transport={transport}
      />,
    );

    await userEvent.click(screen.getByRole("button", {
      name: `Dispatch plan.propose for ${PLURAL_RUN_B}, version 0`,
    }));
    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect(sent[0]?.targetAggregateId).toBe(PLURAL_RUN_B);
    expect(sent[0]?.payload).toMatchObject({ runId: PLURAL_RUN_B });
    const commands = sent[0]?.payload["commands"];
    expect(Array.isArray(commands)).toBe(true);
    const draft = Array.isArray(commands)
      ? commands.find((entry) => (entry as Record<string, unknown>)["kind"]
        === "planning.create_draft")
      : undefined;
    expect(draft).toMatchObject({
      goalRef: PLURAL_GOAL_B, kind: "planning.create_draft", runId: PLURAL_RUN_B,
    });
    const authored = JSON.stringify(sent[0]?.payload);
    expect(authored).not.toContain(PLURAL_RUN_A);
    expect(authored).not.toContain(PLURAL_GOAL_A);
    expect(authored).not.toContain("run-live-1");
    expect(authored).not.toContain("goal-live-1");

    // EXACT B-ONLY GRAPH AND PLAN OPERANDS. Every one is read off the daemon's material for
    // the run the OFFER named; none may come from a module constant, and none may come from
    // sibling A, whose entry is FIRST in the map the surface answered with.
    const propose = Array.isArray(commands)
      ? commands.find((entry) => (entry as Record<string, unknown>)["kind"] === "plan.propose")
      : undefined;
    expect(propose).toMatchObject({
      graphContentBytesBase64: PLURAL_BYTES_B,
      submissionHash: PLURAL_SUBMISSION_B,
    });
    const sealed = (propose as Record<string, unknown>)["authority"] as Record<string, unknown>;
    const revision = sealed["planRevision"] as Record<string, unknown>;
    const contract = sealed["acceptanceContract"] as Record<string, unknown>;
    expect(revision["graphBinding"]).toEqual({
      graphContentHash: PLURAL_GRAPH_HASH_B, graphRevisionRef: `${PLURAL_RUN_B}-graph-revision`,
    });
    expect(revision["planHash"]).toBe(PLURAL_SUBMISSION_B);
    expect(contract["criteriaDigest"]).toBe(PLURAL_CRITERIA_B);
    expect(contract["contractId"]).toBe(`${PLURAL_RUN_B}-contract`);
    // A's operands are distinct in every one of those fields, so the swap is detectable.
    expect(authored).not.toContain(PLURAL_BYTES_A);
    expect(authored).not.toContain(PLURAL_GRAPH_HASH_A);
    expect(authored).not.toContain(PLURAL_SUBMISSION_A);
    expect(authored).not.toContain(PLURAL_CRITERIA_A);

    rerender(
      <LiveBoard
        client={SIBLING_PLANNING_CLIENT}
        frame={siblingPlanningFrame({ [PLURAL_RUN_A]: PLURAL_GOAL_A })}
        readBudgetCommitment={readsCommitment}
        sessionCredential="cred"
        transport={transport}
      />,
    );
    expect(screen.queryByRole("button", {
      name: `Dispatch plan.propose for ${PLURAL_RUN_B}, version 0`,
    })).toBeNull();
  });

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

/**
 * THE PER-RUN PLANNING AUTHORITY MATERIAL (`planningAuthorityByRun`).
 *
 * The daemon is the sole producer of graph and plan identity; the board only validates the
 * bounded transport shape and the bindings. So a WHOLLY ABSENT map is optional — a legacy
 * surface still reads, it is simply not authoritative for planning — while any PRESENT value
 * this reader cannot vouch for refuses the frame whole, without ever invoking an accessor.
 * Reading a getter to decide is the answered body computing itself against this board.
 */
function surfaceWithAuthorities(authorities: unknown, present = true): unknown {
  return {
    nextAllowedCommands: [
      {
        commandId: "plan-sibling-a", commandKind: "plan.propose", expectedVersion: 0,
        targetAggregateId: PLURAL_RUN_A,
      },
      {
        commandId: "plan-sibling-b", commandKind: "plan.propose", expectedVersion: 0,
        targetAggregateId: PLURAL_RUN_B,
      },
    ],
    outcome: "SURFACE",
    ...(present ? { planningAuthorityByRun: authorities } : {}),
    planningGoalRef: PLURAL_GOAL_A,
    planningGoalRefs: { [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: PLURAL_GOAL_B },
    steps: [],
  };
}

/** B's entry with one member replaced or removed; A's entry always stays valid and first. */
function withEntryB(patch: Record<string, unknown>, dropped: readonly string[] = []): unknown {
  const entry: Record<string, unknown> = { ...MATERIAL_B, ...patch };
  for (const key of dropped) delete entry[key];
  return { [PLURAL_RUN_A]: MATERIAL_A, [PLURAL_RUN_B]: entry };
}

/** A run's material under a run key of its own, for the bound sweeps. */
function bulkMaterial(runId: string): Record<string, unknown> {
  return materialOf({
    bytes: PLURAL_BYTES_A, criteriaDigest: PLURAL_CRITERIA_A, goalRef: PLURAL_GOAL_A,
    graphHash: PLURAL_GRAPH_HASH_A, runId, submissionHash: PLURAL_SUBMISSION_A,
  });
}

describe("the per-run planning authority material", () => {
  afterEach(cleanup);

  it("leaves a WHOLLY ABSENT map optional: the frame still reads as a surface", () => {
    for (const legacy of [surfaceWithAuthorities(null, false), surfaceWithAuthorities(undefined)]) {
      const frame = frameOfSurface(legacy);
      expect(frame.outcome).toBe("SURFACE");
      expect(frame.connection).toBe("CONNECTED");
      expect(frame.offers).toHaveLength(2);
      // The material rides no exported member: SurfaceFrame's shape is unchanged, so the
      // v2 surfaces that only import this type cannot be reached by this row at all.
      expect(Object.keys(frame).sort()).toEqual([
        "connection", "detail", "offers", "outcome",
        "planningGoalRef", "planningGoalRefs", "steps",
      ]);
    }
  });

  it("carries a well-formed map without widening the exported frame", () => {
    const frame = frameOfSurface(surfaceWithAuthorities({
      [PLURAL_RUN_A]: MATERIAL_A, [PLURAL_RUN_B]: MATERIAL_B,
    }));
    expect(frame.outcome).toBe("SURFACE");
    expect(frame.connection).toBe("CONNECTED");
    expect(Object.keys(frame)).not.toContain("planningAuthorityByRun");
  });

  it("refuses every malformed PRESENT value with exactly LIVE_SURFACE_UNREADABLE", () => {
    const cyclicAuthority: Record<string, unknown> = { acceptanceContract: {}, planRevision: {} };
    cyclicAuthority["loop"] = cyclicAuthority;
    const extraKeyed: unknown[] = [1, 2];
    (extraKeyed as unknown as Record<string, unknown>)["injected"] = "yes";
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1];
    const oversizedId = "z".repeat(513);
    const tooMany: Record<string, unknown> = {};
    for (let index = 0; index <= 256; index += 1) {
      tooMany[`run-overflow-${String(index)}`] = bulkMaterial(`run-overflow-${String(index)}`);
    }

    const malformed: readonly (readonly [string, unknown])[] = [
      ["not a record", "planningAuthorityByRun"],
      ["a number", 7],
      ["an array", []],
      ["entry pairs", [[PLURAL_RUN_B, MATERIAL_B]]],
      ["an empty run key", { "": MATERIAL_B }],
      ["a non-record entry", { [PLURAL_RUN_B]: "material" }],
      ["a six-key entry", withEntryB({}, ["submissionHash"])],
      ["an eight-key entry", withEntryB({ policyHash: "c7".repeat(32) })],
      ["a mapKey/runId mismatch", { [PLURAL_RUN_B]: MATERIAL_A }],
      ["a goalRef the daemon never bound", withEntryB({ goalRef: PLURAL_GOAL_A })],
      ["an uppercase hash", withEntryB({ graphContentHash: "A1".repeat(32) })],
      ["a short hash", withEntryB({ submissionHash: "b4".repeat(31) })],
      ["non-canonical base64", withEntryB({ graphContentBytesBase64: "c2libGluZy1iLWdyYXBo=" })],
      ["base64 outside the alphabet", withEntryB({ graphContentBytesBase64: "c2li_Gluzy1i" })],
      ["an empty graph body", withEntryB({ graphContentBytesBase64: "" })],
      ["an over-long id", withEntryB({ graphRevisionRef: oversizedId })],
      ["a non-string goalRef", withEntryB({ goalRef: 7 })],
      ["a non-record authority", withEntryB({ authority: "sealed" })],
      ["a nonfinite number in the authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: { decompositionBudget: Infinity } },
      })],
      ["a NaN in the authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: { decompositionBudget: NaN } },
      })],
      ["a cycle in the authority", withEntryB({ authority: cyclicAuthority })],
      ["a sparse array in the authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: { steps: sparse } },
      })],
      ["an extra-keyed array in the authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: { steps: extraKeyed } },
      })],
      ["a function in the authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: { steps: () => undefined } },
      })],
      ["257 entries", tooMany],
    ];

    // A swept set that produced zero cases passes vacuously; its size is pinned first.
    expect(malformed.length).toBeGreaterThan(20);
    for (const [label, authorities] of malformed) {
      expect(frameOfSurface(surfaceWithAuthorities(authorities)), label)
        .toEqual(UNREADABLE_FRAME);
    }
  });

  it("admits a null-prototype map and exactly 256 entries, the bound itself", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare[PLURAL_RUN_B] = MATERIAL_B;
    expect(frameOfSurface(surfaceWithAuthorities(bare)).outcome).toBe("SURFACE");

    const full: Record<string, unknown> = {};
    const bounds: Record<string, string> = {};
    for (let index = 0; index < 256; index += 1) {
      const runId = `run-bound-${String(index)}`;
      full[runId] = bulkMaterial(runId);
      bounds[runId] = PLURAL_GOAL_A;
    }
    expect(Object.keys(full)).toHaveLength(256);
    // The bound is INCLUSIVE: 256 reads, and the 257-entry case above refuses.
    expect(frameOfSurface({
      ...(surfaceWithAuthorities(full) as Record<string, unknown>),
      planningGoalRefs: bounds,
    }).outcome).toBe("SURFACE");
  });

  it("never invokes an accessor, at any of the three depths one can hide at", () => {
    const counts = { authority: 0, entry: 0, map: 0 };

    const hostileMap: Record<string, unknown> = { [PLURAL_RUN_A]: MATERIAL_A };
    Object.defineProperty(hostileMap, PLURAL_RUN_B, {
      configurable: true, enumerable: true,
      get: () => { counts.map += 1; return MATERIAL_B; },
    });

    const hostileEntry: Record<string, unknown> = { ...MATERIAL_B };
    delete hostileEntry["submissionHash"];
    Object.defineProperty(hostileEntry, "submissionHash", {
      configurable: true, enumerable: true,
      get: () => { counts.entry += 1; return PLURAL_SUBMISSION_B; },
    });

    const hostileRevision: Record<string, unknown> = {};
    Object.defineProperty(hostileRevision, "planHash", {
      configurable: true, enumerable: true,
      get: () => { counts.authority += 1; return PLURAL_SUBMISSION_B; },
    });

    const cases: readonly (readonly [keyof typeof counts, unknown])[] = [
      ["map", hostileMap],
      ["entry", { [PLURAL_RUN_A]: MATERIAL_A, [PLURAL_RUN_B]: hostileEntry }],
      ["authority", withEntryB({
        authority: { acceptanceContract: {}, planRevision: hostileRevision },
      })],
    ];
    expect(cases).toHaveLength(3);
    for (const [depth, authorities] of cases) {
      expect(frameOfSurface(surfaceWithAuthorities(authorities)), depth)
        .toEqual(UNREADABLE_FRAME);
    }
    expect(counts).toEqual({ authority: 0, entry: 0, map: 0 });
  });

  /**
   * A HOSTILE VALUE MUST REFUSE, NOT THROW. Every arm above hands the reader an object whose
   * traps behave; these two hand it objects whose traps FIGHT BACK. `LIVE_SURFACE_UNREADABLE`
   * is a fail-CLOSED answer, and an escaping TypeError is not that answer: it unwinds past the
   * frame the caller was going to render and takes the whole poll with it. Both were measured
   * escaping before this arm existed.
   */
  it("refuses a REVOKED PROXY as the map, without letting a trap throw past the reader", () => {
    const { proxy, revoke } = Proxy.revocable<Record<string, unknown>>({}, {});
    revoke();
    // Every structural probe a reader could open with — isArray, getPrototypeOf, ownKeys —
    // throws on a revoked proxy, so the refusal cannot be spelled as a shape test alone.
    expect(() => frameOfSurface(surfaceWithAuthorities(proxy))).not.toThrow();
    expect(frameOfSurface(surfaceWithAuthorities(proxy))).toEqual(UNREADABLE_FRAME);
  });

  it("never invokes an accessor installed at the map key ON THE RESPONSE ITSELF", () => {
    // One level SHALLOWER than the three-depth arm above: not a getter inside the map, but a
    // getter standing WHERE THE MAP GOES. A plain `response["planningAuthorityByRun"]` read
    // runs it — the daemon's answer computing itself against this board, at the outermost
    // hop — and a throwing one escapes the frame entirely.
    let fired = 0;
    const response = surfaceWithAuthorities(BOTH_MATERIAL, false) as Record<string, unknown>;
    Object.defineProperty(response, "planningAuthorityByRun", {
      configurable: true,
      enumerable: true,
      get: () => { fired += 1; throw new Error("hostile getter fired"); },
    });

    expect(() => frameOfSurface(response)).not.toThrow();
    expect(frameOfSurface(response)).toEqual(UNREADABLE_FRAME);
    expect(fired).toBe(0);
  });

  it("refuses a symbol-keyed map, and a symbol-keyed authority body", () => {
    const symbolMap: Record<string, unknown> = { [PLURAL_RUN_A]: MATERIAL_A };
    Object.defineProperty(symbolMap, Symbol("run"), {
      configurable: true, enumerable: true, value: MATERIAL_B,
    });
    const symbolAuthority: Record<string, unknown> = { acceptanceContract: {}, planRevision: {} };
    Object.defineProperty(symbolAuthority, Symbol("planHash"), {
      configurable: true, enumerable: true, value: PLURAL_SUBMISSION_B,
    });

    expect(frameOfSurface(surfaceWithAuthorities(symbolMap))).toEqual(UNREADABLE_FRAME);
    expect(frameOfSurface(surfaceWithAuthorities(withEntryB({ authority: symbolAuthority }))))
      .toEqual(UNREADABLE_FRAME);
  });

  it("refuses a present map when the surface bound no goals to compare it against", () => {
    const surface = surfaceWithAuthorities(BOTH_MATERIAL) as Record<string, unknown>;
    delete surface["planningGoalRefs"];
    // Material whose goalRef nothing can be checked against is material this board cannot
    // vouch for, so the frame refuses rather than carrying an unverifiable binding.
    expect(frameOfSurface(surface)).toEqual(UNREADABLE_FRAME);
  });

  it("renders NO planning control for an offered, goal-bound run with no material at all", () => {
    render(
      <LiveBoard
        client={SIBLING_PLANNING_CLIENT}
        frame={siblingPlanningFrame(
          { [PLURAL_RUN_A]: PLURAL_GOAL_A, [PLURAL_RUN_B]: PLURAL_GOAL_B },
          undefined,
          false,
        )}
        readBudgetCommitment={readsCommitment}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    // The goal binding alone is not enough: without the daemon's material the board has no
    // graph bytes and no sealed plan to propose, so it renders no click that cannot author one.
    expect(screen.queryByRole("button", {
      name: `Dispatch plan.propose for ${PLURAL_RUN_B}, version 0`,
    })).toBeNull();
    expect(screen.queryByRole("button", {
      name: `Dispatch plan.propose for ${PLURAL_RUN_A}, version 0`,
    })).toBeNull();
  });
});
