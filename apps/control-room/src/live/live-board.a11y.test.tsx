import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";

/**
 * The daemon's per-run planning authority, spelled with its exact seven keys
 * (apps/daemon/src/http/affordance-planning-authorities.ts). An `approval.decide` control only
 * renders for a run the surface bound to a goal AND handed material for, so these are the
 * VALID wire facts this file's surface now has to state — the expectations below are unchanged.
 */
function materialFor(runId: string, goalRef: string): Record<string, unknown> {
  const graphRevisionRef = `${runId}-graph-revision`;
  const graphContentHash = "7c".repeat(32);
  const graphBinding = { graphContentHash, graphRevisionRef };
  return {
    authority: {
      acceptanceContract: {
        applicability: { ...graphBinding, nodeIds: [`${runId}-node`], nodeKind: "LEAF" },
        authorRef: `${runId}-author`,
        contractId: `${runId}-contract`,
        criteriaDigest: "c1".repeat(32),
        obligations: [{ criterionId: `${goalRef}-criterion` }],
        version: "moe-acceptance-contract/1",
      },
      planRevision: {
        affectedCriterionIds: [`${goalRef}-criterion`],
        affectedNodeIds: [`${runId}-node`],
        approvalState: "PENDING_APPROVAL",
        authorRef: `${runId}-author`,
        graphBinding,
        parentRevisionId: null,
        planHash: "5e".repeat(32),
        rejectionRef: null,
        revisionId: `${runId}-revision`,
        version: "moe-plan-revision/1",
      },
    },
    goalRef,
    graphContentBytesBase64: "ZGV2LWdyYXBoLWJvZHk=",
    graphContentHash,
    graphRevisionRef,
    runId,
    submissionHash: "5e".repeat(32),
  };
}

const APPROVAL_REFS = Object.freeze({
  "approval-a": "goal-approval-a", "approval-b": "goal-approval-b",
});

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
    planningAuthorityByRun: {
      "approval-a": materialFor("approval-a", "goal-approval-a"),
      "approval-b": materialFor("approval-b", "goal-approval-b"),
    },
    planningGoalRefs: APPROVAL_REFS,
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
