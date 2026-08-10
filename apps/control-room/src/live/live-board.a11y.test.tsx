import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";

describe("LiveBoard accessibility", () => {
  afterEach(cleanup);

  const REPEATED_KIND_SURFACE = frameOfSurface({
    nextAllowedCommands: [
      {
        commandId: "afford-a", commandKind: "project.register", expectedVersion: 1,
        targetAggregateId: "proj-a",
      },
      {
        commandId: "afford-b", commandKind: "project.register", expectedVersion: 2,
        targetAggregateId: "proj-b",
      },
    ],
    outcome: "SURFACE",
    steps: [
      {
        aggregateId: "proj-a", kind: "project.register", missing: [],
        status: "READY", version: 1,
      },
      {
        aggregateId: "proj-b", kind: "project.register", missing: [],
        status: "READY", version: 2,
      },
    ],
  });

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

  it("gives repeated-kind dispatch controls target-specific accessible names", () => {
    render(
      <LiveBoard
        client={client}
        frame={REPEATED_KIND_SURFACE}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("unused")) }}
      />,
    );

    expect(screen.getByRole("button", {
      name: "Dispatch project.register for proj-a, version 1",
    })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Dispatch project.register for proj-b, version 2",
    })).toBeTruthy();
  });

  it("announces an asynchronous dispatch result", async () => {
    render(
      <LiveBoard
        client={client}
        frame={REPEATED_KIND_SURFACE}
        sessionCredential="cred"
        transport={{
          sendCommand: () => Promise.resolve({
            delivered: true as const,
            response: {
              decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
              ok: true,
            },
            status: 200,
          }),
        }}
      />,
    );
    await userEvent.click(screen.getAllByText("Dispatch")[0]!);

    const report = await waitFor(() =>
      screen.getByTestId("cr.liveboard.report.project.register@proj-a"));
    expect(report.getAttribute("role")).toBe("status");
    expect(report.getAttribute("aria-live")).toBe("polite");
  });

  it("announces a daemon refusal surface", () => {
    render(
      <LiveBoard
        client={{ commands: {} } as never}
        frame={frameOfSurface({ code: "SESSION_LEDGER_UNREADABLE", outcome: "REFUSED" })}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("unused")) }}
      />,
    );

    const refusal = screen.getByTestId("cr.liveboard.refused");
    expect(refusal.getAttribute("role")).toBe("status");
    expect(refusal.getAttribute("aria-live")).toBe("polite");
  });
});
