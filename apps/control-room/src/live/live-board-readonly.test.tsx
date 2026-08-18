import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { BOARD_DISPATCH_COMMAND_KIND, LiveBoard, boardMayDispatch } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";
import { DEV_PAYLOADS } from "./live-dispatch.js";

/**
 * The board is READ-ONLY except for the one command a human is the only
 * legitimate author of: `approval.decide`.
 *
 * Two things are asserted separately on purpose. The DOM sweep proves no OTHER
 * kind renders a control; the predicate sweep proves the production rule itself
 * says so, over every kind the dispatch module can even build a payload for. A
 * DOM-only assertion would stay green if a control were re-added behind a
 * condition this fixture happens not to hit.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Every kind `live-dispatch.ts` can build a payload for, read from production. */
const PAYLOAD_KINDS: readonly string[] = Object.freeze(Object.keys(DEV_PAYLOADS).sort());

function step(kind: string, status: SurfaceStep["status"], index: number): unknown {
  return {
    aggregateId: `target-${String(index)}`,
    kind,
    missing: status === "BLOCKED" ? ["something"] : [],
    status,
    version: index,
  };
}

/** One READY card per payload kind, each with a matching daemon offer. */
function everyKindReady(): SurfaceFrame {
  return frameOfSurface({
    nextAllowedCommands: PAYLOAD_KINDS.map((kind, index) => ({
      commandId: `afford-${kind}`,
      commandKind: kind,
      expectedVersion: index,
      targetAggregateId: `target-${String(index)}`,
    })),
    outcome: "SURFACE",
    steps: PAYLOAD_KINDS.map((kind, index) => step(kind, "READY", index)),
  });
}

function builderFor(kinds: readonly string[]): unknown {
  const commands: Record<string, unknown> = {};
  for (const kind of kinds) {
    commands[kind] = (affordance: unknown, caller: unknown) => ({
      envelope: {
        ...(affordance as Record<string, unknown>),
        ...(caller as Record<string, unknown>),
      } as unknown as RuntimeCommandEnvelope,
      ok: true,
    });
  }
  return { commands };
}

const ANSWERED = {
  delivered: true as const,
  response: { decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" }, ok: true },
  status: 200,
};

describe("the corpus this file sweeps", () => {
  it("is non-empty, holds the approval kind, and holds many others", () => {
    // A sweep over an emptied roster generates zero cases and passes green.
    expect(PAYLOAD_KINDS.length).toBeGreaterThan(5);
    expect(PAYLOAD_KINDS).toContain(BOARD_DISPATCH_COMMAND_KIND);
    expect(PAYLOAD_KINDS.filter((kind) => kind !== BOARD_DISPATCH_COMMAND_KIND).length)
      .toBeGreaterThan(4);
  });
});

describe("the one command kind the board may hand back", () => {
  it("is approval.decide, and nothing else", () => {
    expect(BOARD_DISPATCH_COMMAND_KIND).toBe("approval.decide");
  });

  it.each(PAYLOAD_KINDS)("%s is dispatchable only if it is the approval decision", (kind) => {
    // The production predicate, not a restatement of it: the board renders its
    // control through this exact function.
    expect(boardMayDispatch({
      aggregateId: "target-0", kind, missing: [], status: "READY", version: 0,
    })).toBe(kind === BOARD_DISPATCH_COMMAND_KIND);
  });

  it("refuses the approval kind itself when the ledger has not made it READY", () => {
    for (const status of ["BLOCKED", "COMMITTED"] as const) {
      expect(boardMayDispatch({
        aggregateId: "target-0", kind: BOARD_DISPATCH_COMMAND_KIND,
        missing: [], status, version: 0,
      }), status).toBe(false);
    }
  });
});

describe("the board offers no mutation surface beyond the approval decision", () => {
  it("renders exactly one dispatch control across every READY kind the daemon offers", () => {
    const { container } = render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    // Every kind painted a card, so the absence of controls is about the controls.
    expect(container.querySelectorAll("[data-testid^='cr.liveboard.card.']"))
      .toHaveLength(PAYLOAD_KINDS.length);
    const controls = [...container.querySelectorAll("[data-testid^='cr.liveboard.dispatch.']")]
      .map((element) => element.getAttribute("data-testid"));
    expect(controls).toEqual([`cr.liveboard.dispatch.${BOARD_DISPATCH_COMMAND_KIND}`]);
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("makes no card draggable and offers no drop target", () => {
    const { container } = render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    expect(container.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(container.querySelectorAll("[draggable='true']")).toHaveLength(0);
    // The drop-refusal note was part of the drag surface; it is gone with it.
    expect(screen.queryByTestId("cr.liveboard.dropnote")).toBeNull();
  });

  it("sends nothing when a card is dragged onto Committed", async () => {
    const sent: RuntimeCommandEnvelope[] = [];
    render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        sessionCredential="cred"
        transport={{
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(ANSWERED); },
        }}
      />,
    );
    const entries = new Map<string, string>();
    const transfer = {
      getData: (format: string): string => entries.get(format) ?? "",
      setData: (format: string, value: string): void => { entries.set(format, value); },
    } as DataTransfer;

    const card = screen.getByTestId(`cr.liveboard.card.goal.create@target-${
      String(PAYLOAD_KINDS.indexOf("goal.create"))}`);
    fireEvent.dragStart(card, { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId("cr.liveboard.column.committed"), {
      dataTransfer: transfer,
    });
    await Promise.resolve();

    expect(sent).toEqual([]);
    expect(screen.queryByTestId("cr.liveboard.dropnote")).toBeNull();
  });

  it("emits ONLY approval.decide when every control the board rendered is used", async () => {
    const sent: RuntimeCommandEnvelope[] = [];
    render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        sessionCredential="cred"
        transport={{
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(ANSWERED); },
        }}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) await userEvent.click(button);
    await waitFor(() => { expect(sent).toHaveLength(buttons.length); });

    const kinds = sent.map((envelope) =>
      (envelope as unknown as Record<string, unknown>)["commandKind"]);
    expect([...new Set(kinds)]).toEqual([BOARD_DISPATCH_COMMAND_KIND]);
  });
});

describe("the approval decision still dispatches, credentialed, exactly as before", () => {
  const APPROVAL_SURFACE = frameOfSurface({
    nextAllowedCommands: [{
      commandId: "afford-approve-1", commandKind: "approval.decide", expectedVersion: 4,
      targetAggregateId: "approval-9",
    }],
    outcome: "SURFACE",
    steps: [{
      aggregateId: "approval-9", kind: "approval.decide", missing: [],
      status: "READY", version: 4,
    }],
  });

  it("carries the daemon's own affordance and the session credential", async () => {
    const sent: RuntimeCommandEnvelope[] = [];
    render(
      <LiveBoard
        client={builderFor(["approval.decide"]) as never}
        frame={APPROVAL_SURFACE}
        sessionCredential="session-credential-1"
        transport={{
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(ANSWERED); },
        }}
      />,
    );

    await userEvent.click(screen.getByTestId("cr.liveboard.dispatch.approval.decide"));
    await waitFor(() => { expect(sent).toHaveLength(1); });

    const envelope = sent[0] as unknown as Record<string, unknown>;
    // The daemon minted these two; the board changed neither.
    expect(envelope["commandId"]).toBe("afford-approve-1");
    expect(envelope["expectedVersion"]).toBe(4);
    // The credential is the caller half, and it is the session's, not a literal
    // the board could have invented.
    expect(envelope["sessionCredential"]).toBe("session-credential-1");
    expect(screen.getByTestId("cr.liveboard.report.approval.decide@approval-9").textContent)
      .toContain("EFFECTS_COMMITTED");
  });
});
