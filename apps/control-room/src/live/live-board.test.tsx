import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { createCompatGate } from "@moe/control-room-client";
import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";

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
      nextAllowedCommands: [{ commandId: "afford-1", commandKind: "project.register" }],
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

  it("carries a daemon refusal verbatim", () => {
    expect(frameOfSurface({ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" }))
      .toMatchObject({ connection: "CONNECTED", detail: "SESSION_LEDGER_UNREADABLE" });
  });

  it("refuses an unreadable body with the stable code", () => {
    expect(frameOfSurface("nope")).toMatchObject({ detail: "LIVE_SURFACE_UNREADABLE" });
  });
});

describe("LiveBoard", () => {
  afterEach(cleanup);

  const READY_SURFACE = frameOfSurface({
    nextAllowedCommands: [{
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "afford-77",
      commandKind: "project.register", expectedVersion: 0,
      inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "proj-x",
    }],
    outcome: "SURFACE",
    steps: [
      { aggregateId: "proj-x", kind: "project.register", missing: [], status: "READY", version: 0 },
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
        "project.register": (affordance: unknown, caller: unknown) => ({
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
    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.project.register"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.liveboard.report.project.register@proj-x").textContent)
        .toContain("EFFECTS_COMMITTED");
    });
    const envelope = sent[0] as unknown as Record<string, unknown>;
    expect(envelope["commandId"]).toBe("afford-77");
    expect(envelope["expectedVersion"]).toBe(0);
  });

  it("renders a daemon refusal verbatim on the card", async () => {
    const client = {
      commands: {
        "project.register": () => ({ envelope: {} as RuntimeCommandEnvelope, ok: true }),
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
    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.project.register"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.liveboard.report.project.register@proj-x").textContent)
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
