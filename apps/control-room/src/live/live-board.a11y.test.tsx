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
      name: "Dispatch approval.decide for approval-a, version 1",
    })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Dispatch approval.decide for approval-b, version 2",
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
      screen.getByTestId("cr.liveboard.report.approval.decide@approval-a"));
    expect(report.getAttribute("role")).toBe("status");
    expect(report.getAttribute("aria-live")).toBe("polite");
  });

  /**
   * The drag gesture that used to sit on READY cards was never keyboard-operable
   * and is now gone. What must NOT have gone with it is the keyboard path to the
   * one control that remains: removing a pointer-only affordance is only an
   * improvement if the surviving affordance is still reachable without a pointer.
   */
  it("leaves no drag affordance, and keeps the surviving control keyboard-reachable", async () => {
    const { container } = render(
      <LiveBoard
        client={client}
        frame={REPEATED_KIND_SURFACE}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("unused")) }}
      />,
    );

    expect(container.querySelectorAll("[draggable]")).toHaveLength(0);
    const first = screen.getByRole("button", {
      name: "Dispatch approval.decide for approval-a, version 1",
    });
    // Reached by Tab, not by a pointer, and not behind a positive tabindex.
    expect(first.getAttribute("tabindex")).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);
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
