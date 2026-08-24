import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard, boardMayDispatch } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";
import { DEV_PAYLOADS, payloadFor } from "./live-dispatch.js";

/**
 * The board is the OPERATING SURFACE: every READY step the dispatch module can
 * build a payload for renders a control, so the whole bootstrap chain drives
 * from here — and the one kind it cannot author (`node.deliver`, whose author
 * is a staffed agent) still renders none.
 *
 * Two things are asserted separately on purpose. The DOM sweep proves what the
 * board actually renders across every kind at once; the predicate sweep proves
 * the production rule itself says so. A DOM-only assertion would stay green if
 * a control were added or dropped behind a condition this fixture happens not
 * to hit. The dead drag surface stays pinned dead: dispatch is a button and a
 * daemon answer, never a gesture that moves a card locally.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/** Every kind `live-dispatch.ts` can build a payload for, read from production. */
const PAYLOAD_KINDS: readonly string[] = Object.freeze(Object.keys(DEV_PAYLOADS).sort());

/** The staffed-agent step: on the surface, never authored from the board. */
const AGENT_KIND = "node.deliver";

function step(kind: string, status: SurfaceStep["status"], index: number): unknown {
  return {
    aggregateId: `target-${String(index)}`,
    kind,
    missing: status === "BLOCKED" ? ["something"] : [],
    status,
    version: index,
  };
}

/** One READY card per payload kind PLUS the agent's step, each with an offer. */
function everyKindReady(): SurfaceFrame {
  const kinds = [...PAYLOAD_KINDS, AGENT_KIND];
  return frameOfSurface({
    nextAllowedCommands: kinds.map((kind, index) => ({
      commandId: `afford-${kind}`,
      commandKind: kind,
      expectedVersion: index,
      targetAggregateId: `target-${String(index)}`,
    })),
    outcome: "SURFACE",
    steps: kinds.map((kind, index) => step(kind, "READY", index)),
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
    expect(PAYLOAD_KINDS).toContain("approval.decide");
    expect(PAYLOAD_KINDS.filter((kind) => kind !== "approval.decide").length)
      .toBeGreaterThan(4);
    // The exclusion below is about a kind that really is surface-visible.
    expect(PAYLOAD_KINDS).not.toContain(AGENT_KIND);
  });
});

describe("policy validation request authority", () => {
  it("sends only caller-owned policy input and never re-sends server facts", () => {
    const payload = payloadFor("policy.validate", "policy-live-1", 1);
    if (payload === null) throw new Error("policy.validate has no payload");
    const input = payload["input"] as Record<string, unknown>;

    expect(Object.keys(input).sort()).toEqual([
      "action",
      "callerRiskHint",
      "decisionDigest",
      "evaluatedAtEpochMs",
      "evaluatorVersion",
      "graphNodeRevisionRefs",
      "policyRevisionRef",
      "requiredFactIds",
      "scope",
    ]);
    for (const serverOwned of ["actor", "facts", "sliceChain", "waivers"]) {
      expect(input).not.toHaveProperty(serverOwned);
    }
  });
});

describe("what the board may hand back", () => {
  it.each(PAYLOAD_KINDS)("%s is dispatchable when the daemon says READY", (kind) => {
    // The production predicate, not a restatement of it: the board renders its
    // control through this exact function.
    expect(boardMayDispatch({
      aggregateId: "target-0", claim: null, kind, missing: [], status: "READY", version: 0,
    })).toBe(true);
  });

  it("never authors the staffed agent's step", () => {
    // Both halves of the exclusion: the payload source refuses the kind, and
    // the predicate the board renders through says no.
    expect(payloadFor(AGENT_KIND, "node-code-1")).toBeNull();
    expect(boardMayDispatch({
      aggregateId: "node-code-1", claim: null, kind: AGENT_KIND, missing: [], status: "READY", version: 0,
    })).toBe(false);
  });

  it.each(PAYLOAD_KINDS)("%s is a fact, not an offer, off the READY column", (kind) => {
    for (const status of ["BLOCKED", "COMMITTED"] as const) {
      expect(boardMayDispatch({
        aggregateId: "target-0", claim: null, kind, missing: [], status, version: 0,
      }), `${kind} ${status}`).toBe(false);
    }
  });
});

describe("plan.propose is two commits on one card", () => {
  const chainOf = (version: number | null): readonly Record<string, unknown>[] => {
    const payload = payloadFor("plan.propose", "run-live-1", version);
    if (payload === null) throw new Error("plan.propose has no payload");
    return payload["commands"] as readonly Record<string, unknown>[];
  };

  it("dispatches the sealing planning chain at version 0 and the finalize after it", () => {
    const planning = chainOf(0);
    expect(planning.map((command) => command["kind"])).toEqual([
      "planning.create_draft", "planning.ready", "planning.claim", "plan.propose",
    ]);
    // The propose terminal seals authority bodies; a bare proposal never reaches PLAN_REVIEW.
    const propose = planning[planning.length - 1];
    expect(propose?.["authority"]).toMatchObject({
      acceptanceContract: expect.anything(), planRevision: expect.anything(),
    });
    expect(chainOf(null)).toEqual(planning);

    const finalize = chainOf(1);
    expect(finalize.map((command) => command["kind"])).toEqual(["planning.finalize_submission"]);
    // The finalize is judged against the sealed plan's own hash, and approval against the same.
    const revision = finalize[0]?.["revision"] as Record<string, unknown>;
    expect(revision["planHash"]).toBe(propose?.["submissionHash"]);
    const approval = payloadFor("approval.decide", "run-live-1", 2) as Record<string, unknown>;
    expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"])
      .toBe(propose?.["submissionHash"]);
    expect(approval["graphRevisionRef"]).toBe(revision["graphRevisionRef"]);
  });

  it("keeps the card dispatchable at both versions, through the production predicate", () => {
    for (const version of [0, 1]) {
      expect(boardMayDispatch({
        aggregateId: "run-live-1", claim: null, kind: "plan.propose", missing: [],
        status: "READY", version,
      }), `version ${String(version)}`).toBe(true);
    }
  });
});

describe("the board renders one control per authorable READY step", () => {
  it("renders a dispatch control for every payload kind and none for the agent's step", () => {
    const { container } = render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    // Every kind painted a card, so the control census below is about controls.
    expect(container.querySelectorAll("[data-testid^='cr.liveboard.card.']"))
      .toHaveLength(PAYLOAD_KINDS.length + 1);
    const controls = [...container.querySelectorAll("[data-testid^='cr.liveboard.dispatch.']")]
      .map((element) => element.getAttribute("data-testid"))
      .sort();
    expect(controls).toEqual(PAYLOAD_KINDS.map((kind) => `cr.liveboard.dispatch.${kind}`));
    expect(container.querySelectorAll("button")).toHaveLength(PAYLOAD_KINDS.length);
    expect(screen.queryByTestId(`cr.liveboard.dispatch.${AGENT_KIND}`)).toBeNull();
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

  it("emits every payload kind exactly once when every rendered control is used", async () => {
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
    expect(buttons).toHaveLength(PAYLOAD_KINDS.length);
    for (const button of buttons) await userEvent.click(button);
    await waitFor(() => { expect(sent).toHaveLength(buttons.length); });

    const kinds = sent.map((envelope) =>
      (envelope as unknown as Record<string, unknown>)["commandKind"]);
    expect([...kinds].sort()).toEqual([...PAYLOAD_KINDS]);
  });
});

describe("an active claim renders as a fact beside the dispatch decision", () => {
  const CLAIMED_SURFACE = frameOfSurface({
    nextAllowedCommands: [{
      commandId: "afford-claimed-1", commandKind: "approval.decide", expectedVersion: 2,
      targetAggregateId: "run-claimed",
    }],
    outcome: "SURFACE",
    steps: [
      {
        aggregateId: "run-claimed",
        claim: { claimedBy: "agent-7", expiresAt: "2026-08-22T12:00:00.000Z", version: 3 },
        kind: "approval.decide", missing: [], status: "READY", version: 2,
      },
      { aggregateId: "goal-quiet", kind: "goal.create", missing: [], status: "READY", version: 0 },
    ],
  });

  it("names the holder and the expiry on the claimed card, and only there", () => {
    render(
      <LiveBoard
        client={builderFor(["approval.decide", "goal.create"]) as never}
        frame={CLAIMED_SURFACE}
        sessionCredential="cred"
        transport={{ sendCommand: () => Promise.reject(new Error("must not send")) }}
      />,
    );

    const claimLine = screen.getByTestId("cr.liveboard.claim.approval.decide@run-claimed");
    expect(claimLine.textContent).toContain("agent-7");
    expect(claimLine.textContent).toContain("2026-08-22T12:00:00.000Z");
    expect(screen.queryByTestId("cr.liveboard.claim.goal.create@goal-quiet")).toBeNull();
    // The claim informs the decision; it does not confiscate it. The control
    // stays, and the daemon's own fences answer whoever loses the race.
    expect(screen.getByTestId("cr.liveboard.dispatch.approval.decide")).toBeTruthy();
  });
});

describe("a dispatch is credentialed and carries the daemon's own affordance", () => {
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
