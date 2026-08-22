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
      steps: [
        { kind: "project.register", status: "READY" },
        { kind: "goal.create", missing: ["project.activate"], status: "BLOCKED" },
      ],
    });
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

  it("carries a daemon refusal verbatim", () => {
    expect(frameOfSurface({ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" }))
      .toMatchObject({ connection: "CONNECTED", detail: "SESSION_LEDGER_UNREADABLE" });
  });

  it("refuses an unreadable body with the stable code", () => {
    expect(frameOfSurface("nope")).toMatchObject({ detail: "LIVE_SURFACE_UNREADABLE" });
  });

  it("refuses an incomplete or partially malformed surface instead of hiding records", () => {
    const malformed = [
      { outcome: "SURFACE", steps: [] },
      { nextAllowedCommands: [], outcome: "SURFACE", steps: [{}] },
      {
        nextAllowedCommands: [], outcome: "SURFACE",
        steps: [{ aggregateId: "proj", kind: "project.register", missing: [1],
          status: "READY", version: 0 }],
      },
      { nextAllowedCommands: [null], outcome: "SURFACE", steps: [] },
    ];
    for (const response of malformed) {
      expect(frameOfSurface(response)).toEqual({
        connection: "CONNECTED", detail: "LIVE_SURFACE_UNREADABLE",
        offers: [], outcome: "UNREADABLE", steps: [],
      });
    }
  });
});

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
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    feed.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      connection: "CONNECTED", detail: "LIVE_SURFACE_UNREADABLE", outcome: "UNREADABLE",
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
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    feed.stop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    });
  });

  it("re-arms as DISCONNECTED when the daemon accepts a poll and never answers", async () => {
    // The DEFAULT post's deadline. A wedged-but-listening daemon rejects
    // nothing on its own, so without one the poll pends forever: no frame, no
    // reschedule, the board frozen on its last CONNECTED frame. The stub
    // honours the abort contract exactly as a real fetch does — reject with
    // the signal's reason when it fires, never resolve on its own.
    const frames: SurfaceFrame[] = [];
    let scheduled = 0;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { reject(init.signal?.reason as Error); });
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
    expect(frames[0]).toMatchObject({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    });
    // The hang converted to the already-handled rejection, so the loop re-armed.
    expect(scheduled).toBe(1);
  });

  it("suppresses an in-flight poll across stop and restart instead of reviving it", async () => {
    const answers: Array<(response: Response) => void> = [];
    const frames: SurfaceFrame[] = [];
    let scheduled = 0;
    const feed = createBoardFeed({
      headers: {},
      intervalMs: 10_000,
      onFrame: (frame) => frames.push(frame),
      post: () => new Promise<Response>((resolve) => { answers.push(resolve); }),
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    const surface = (): Response => ({
      json: () => Promise.resolve({ nextAllowedCommands: [], outcome: "SURFACE", steps: [] }),
    } as Response);

    // StrictMode's dev double-invoke: setup -> cleanup -> setup while poll A awaits.
    feed.start();
    feed.stop();
    feed.start();
    expect(answers).toHaveLength(2);

    // Poll A outlived its stop; it must neither deliver nor start a second loop.
    answers[0]?.(surface());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(0);
    expect(scheduled).toBe(0);

    // Poll B is the restart's own loop: exactly one frame, one reschedule.
    answers[1]?.(surface());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(1);
    expect(scheduled).toBe(1);
    feed.stop();
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
                decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
                ok: true,
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
        decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
        ok: true,
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
                decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
                ok: true,
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
              refusal: { code: "BOOTSTRAP_PREREQUISITE_MISSING" },
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
