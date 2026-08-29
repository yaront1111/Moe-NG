import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard, boardMayDispatch } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";
import { DEV_PAYLOADS, dispatchAffordance, payloadFor } from "./live-dispatch.js";

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

/** The daemon's per-run bindings for the sweep's targets: every offered run is bound. */
function refsFor(kinds: readonly string[]): Readonly<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [index] of kinds.entries()) refs[`target-${String(index)}`] = "goal-daemon-offer-7";
  return refs;
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
    planningGoalRef: "goal-daemon-offer-7",
    planningGoalRefs: refsFor(kinds),
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

function answered(envelope: RuntimeCommandEnvelope) {
  return {
    delivered: true as const,
    response: {
      decision: {
        commandId: envelope.commandId, disposition: "DECIDED",
        effectId: "effect-answer-1", resultCode: "EFFECTS_COMMITTED",
      },
      httpStatus: 200,
      ok: true,
      outcome: "ACCEPTED",
    },
    status: 200,
  };
}

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
      "graphNodeRevisionRefs",
      "policyRevisionRef",
      "requiredFactIds",
      "scope",
    ]);
    for (const serverOwned of [
      "actor", "evaluatedAtEpochMs", "evaluatorVersion", "facts", "sliceChain", "waivers",
    ]) {
      expect(input).not.toHaveProperty(serverOwned);
    }
  });
});

describe("what the board may hand back", () => {
  it("authors a prose-only brief for goal.create; the daemon mints the target itself", () => {
    // The daemon's admitGoalBrief admits exactly { instructions, title } and derives the
    // goal aggregate from the commandId, so a caller-named goalId is refused
    // (GOAL_BRIEF_INPUT_INVALID). The offered target only gates the dispatch.
    const payload = payloadFor("goal.create", "goal-daemon-offer-7", 0);
    expect(payload).toEqual({
      instructions: "Land the live board's demo node.", title: "Live board goal",
    });
    expect(payload).not.toHaveProperty("goalId");
    expect(payloadFor("goal.create", null, 0)).toBeNull();
  });

  it.each(PAYLOAD_KINDS)("%s is dispatchable when the daemon says READY", (kind) => {
    // The production predicate, not a restatement of it: the board renders its
    // control through this exact function.
    expect(boardMayDispatch({
      aggregateId: "target-0", claim: null, kind, missing: [], status: "READY", version: 0,
    }, { "target-0": "goal-daemon-offer-7" })).toBe(true);
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
    const payload = payloadFor(
      "plan.propose", "run-live-1", version, "goal-daemon-offer-7",
    );
    if (payload === null) throw new Error("plan.propose has no payload");
    return payload["commands"] as readonly Record<string, unknown>[];
  };

  it("dispatches the sealing planning chain at version 0 and the finalize after it", () => {
    const planningPayload = payloadFor(
      "plan.propose", "run-live-1", 0, "goal-daemon-offer-7",
    );
    if (planningPayload === null) throw new Error("bound plan.propose has no payload");
    const planning = planningPayload["commands"] as readonly Record<string, unknown>[];
    expect(planning.map((command) => command["kind"])).toEqual([
      "planning.create_draft", "planning.ready", "planning.claim", "plan.propose",
    ]);
    expect(planning[0]?.["goalRef"]).toBe("goal-daemon-offer-7");
    expect(planning[0]?.["goalRef"]).not.toBe("goal-live-1");
    expect(payloadFor("plan.propose", "run-live-1", 0, null)).toBeNull();
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
      }, { "run-live-1": "goal-daemon-offer-7" }), `version ${String(version)}`).toBe(true);
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
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(answered(envelope)); },
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
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(answered(envelope)); },
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
          sendCommand: (envelope) => { sent.push(envelope); return Promise.resolve(answered(envelope)); },
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

/**
 * THE OFFER'S TARGET DECIDES THE PLANNING IDENTITY.
 *
 * The daemon now offers plan.propose / approval.decide / goal.close ONCE PER DURABLE GOAL, each
 * carrying its own `targetAggregateId`, and states the run -> goal bindings in `planningGoalRefs`.
 * So the identity a dispatch names is the OFFER'S, never the caller's aggregate, never the first
 * entry of the map, never the stale singular seed binding, and never a formatted id.
 *
 * THE DIVERGENCE THIS FIXTURE BUYS. The builder and the transport below accept EITHER identity
 * and only record what they were handed, so nothing downstream can refuse the wrong run on this
 * board's behalf: the selector under test is the only mechanism that can decide, and swapping it
 * for `input.aggregateId` reddens these arms rather than tripping an identical fence further on.
 */
const SIB_GOAL_A = "goal-sibling-a-3f11";
const SIB_GOAL_B = "goal-sibling-b-9c02";
const SIB_RUN_A = "run-sibling-a-3f11";
const SIB_RUN_B = "run-sibling-b-9c02";
const SIB_REFS: Readonly<Record<string, string>> =
  Object.freeze({ [SIB_RUN_A]: SIB_GOAL_A, [SIB_RUN_B]: SIB_GOAL_B });
const PLANNING_KINDS: readonly string[] =
  Object.freeze(["approval.decide", "goal.close", "plan.propose"]);

/** The offer the daemon minted for goal B, the one the operator clicked. */
function offerForB(kind: string, target: string, expectedVersion: number): Record<string, unknown> {
  return {
    commandId: `afford-${kind}-b`, commandKind: kind, expectedVersion, targetAggregateId: target,
  };
}

interface Recorder {
  readonly built: { affordance: unknown; payload: Record<string, unknown> }[];
  readonly client: unknown;
  readonly sent: RuntimeCommandEnvelope[];
  readonly transport: { sendCommand: (envelope: RuntimeCommandEnvelope) => Promise<unknown> };
}

/** Accepts any identity; records only. The selector is left as the sole decider. */
function recorder(): Recorder {
  const built: { affordance: unknown; payload: Record<string, unknown> }[] = [];
  const sent: RuntimeCommandEnvelope[] = [];
  const commands: Record<string, unknown> = {};
  for (const kind of PLANNING_KINDS) {
    commands[kind] = (affordance: unknown, caller: unknown) => {
      const half = caller as { payload: Record<string, unknown> };
      built.push({ affordance, payload: half.payload });
      return {
        envelope: {
          ...(affordance as Record<string, unknown>), ...(caller as Record<string, unknown>),
        } as unknown as RuntimeCommandEnvelope,
        ok: true,
      };
    };
  }
  return {
    built,
    client: { commands },
    sent,
    transport: {
      sendCommand: (envelope: RuntimeCommandEnvelope) => {
        sent.push(envelope);
        return Promise.resolve(answered(envelope));
      },
    },
  };
}

async function dispatchB(
  rec: Recorder, kind: string, target: string, version: number,
  refs: Readonly<Record<string, string>> | undefined = SIB_REFS,
) {
  return await dispatchAffordance({
    affordance: offerForB(kind, target, version),
    // THE SIBLING'S run, deliberately: the caller half must not decide the identity.
    aggregateId: SIB_RUN_A,
    client: rec.client as never,
    kind,
    planningGoalRefs: refs,
    sessionCredential: "cred",
    transport: rec.transport as never,
    version,
  });
}

describe("the offer's target decides the planning identity", () => {
  it("proposes on the OFFERED run under ITS OWN goal, with no trace of the sibling", async () => {
    const rec = recorder();
    const report = await dispatchB(rec, "plan.propose", SIB_RUN_B, 0);

    expect(report.stage).toBe("ANSWERED");
    expect(rec.built).toHaveLength(1);
    const payload = rec.built[0]?.payload ?? {};
    expect(payload["runId"]).toBe(SIB_RUN_B);
    const commands = payload["commands"] as readonly Record<string, unknown>[];
    expect(commands.map((command) => command["kind"])).toEqual([
      "planning.create_draft", "planning.ready", "planning.claim", "plan.propose",
    ]);
    expect(commands[0]?.["goalRef"]).toBe(SIB_GOAL_B);
    expect(commands[0]?.["runId"]).toBe(SIB_RUN_B);
    // Every goal-bearing member of the sealed authority names B as well: the
    // contract, its obligations and the plan revision are rebound, not just the top.
    const authority = commands[commands.length - 1]?.["authority"] as Record<string, unknown>;
    const contract = authority["acceptanceContract"] as Record<string, unknown>;
    const revision = authority["planRevision"] as Record<string, unknown>;
    expect(contract["contractId"]).toBe(`${SIB_RUN_B}-contract`);
    expect(contract["obligations"]).toMatchObject([{ criterionId: `${SIB_GOAL_B}-criterion` }]);
    expect(revision["affectedCriterionIds"]).toEqual([`${SIB_GOAL_B}-criterion`]);
    expect(revision["revisionId"]).toBe(`${SIB_RUN_B}-revision`);
    // The whole payload, not a field roster this test happened to think of.
    const spelled = JSON.stringify(payload);
    expect(spelled).not.toContain(SIB_RUN_A);
    expect(spelled).not.toContain(SIB_GOAL_A);
  });

  it("finalizes and approves on the offered run, past version 0", async () => {
    const rec = recorder();
    expect((await dispatchB(rec, "plan.propose", SIB_RUN_B, 1)).stage).toBe("ANSWERED");
    expect((await dispatchB(rec, "approval.decide", SIB_RUN_B, 4)).stage).toBe("ANSWERED");

    const finalize = rec.built[0]?.payload ?? {};
    expect(finalize["runId"]).toBe(SIB_RUN_B);
    expect((finalize["commands"] as readonly Record<string, unknown>[]).map((c) => c["kind"]))
      .toEqual(["planning.finalize_submission"]);
    const approval = rec.built[1]?.payload ?? {};
    expect(approval["runId"]).toBe(SIB_RUN_B);
    expect(JSON.stringify(approval)).not.toContain(SIB_RUN_A);
  });

  it("closes the goal the CLOSE offer targets, never the run it was reached through", async () => {
    const rec = recorder();
    expect((await dispatchB(rec, "goal.close", SIB_GOAL_B, 1)).stage).toBe("ANSWERED");

    expect(rec.built[0]?.payload["goalId"]).toBe(SIB_GOAL_B);
    expect(JSON.stringify(rec.built[0]?.payload)).not.toContain(SIB_GOAL_A);
  });

  it("refuses an offer whose run the daemon bound to no goal, before builder or transport", async () => {
    const rec = recorder();
    // The map is PRESENT and readable; it simply does not bind this run. The board
    // has no goal to name, so it authors nothing rather than borrowing A's.
    const report = await dispatchB(rec, "plan.propose", SIB_RUN_B, 0, { [SIB_RUN_A]: SIB_GOAL_A });

    expect(report).toEqual({
      detail: "PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH",
      ok: false,
      stage: "BUILD_REFUSED",
    });
    expect(rec.built).toHaveLength(0);
    expect(rec.sent).toHaveLength(0);
  });

  it("refuses a legacy surface that states no map at all, rather than falling back", async () => {
    const rec = recorder();
    // The field is OMITTED, not passed as undefined: an explicit undefined would land on a
    // defaulted parameter somewhere and prove only that the default is the map.
    const report = await dispatchAffordance({
      affordance: offerForB("plan.propose", SIB_RUN_B, 0),
      aggregateId: SIB_RUN_A,
      client: rec.client as never,
      kind: "plan.propose",
      sessionCredential: "cred",
      transport: rec.transport as never,
      version: 0,
    });

    expect(report.stage).toBe("BUILD_REFUSED");
    expect(report.detail).toBe("PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    expect(rec.sent).toHaveLength(0);
    // And the control never renders in the first place on such a frame.
    expect(boardMayDispatch({
      aggregateId: SIB_RUN_B, claim: null, kind: "plan.propose", missing: [],
      status: "READY", version: 0,
    })).toBe(false);
  });

  it("refuses an offer that names no target instead of reading the caller's aggregate", async () => {
    const rec = recorder();
    const report = await dispatchAffordance({
      affordance: { commandId: "afford-no-target", commandKind: "plan.propose", expectedVersion: 0 },
      aggregateId: SIB_RUN_B,
      client: rec.client as never,
      kind: "plan.propose",
      planningGoalRefs: SIB_REFS,
      sessionCredential: "cred",
      transport: rec.transport as never,
      version: 0,
    });

    expect(report.stage).toBe("BUILD_REFUSED");
    expect(report.detail).toBe("PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    expect(rec.built).toHaveLength(0);
    expect(rec.sent).toHaveLength(0);
  });

  it("reads the offer's target as an own data property, never through an accessor", async () => {
    const rec = recorder();
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {
      commandId: "afford-hostile", commandKind: "plan.propose", expectedVersion: 0,
    };
    Object.defineProperty(hostile, "targetAggregateId", {
      configurable: true,
      enumerable: true,
      get: () => { getterCalls += 1; return SIB_RUN_B; },
    });

    const report = await dispatchAffordance({
      affordance: hostile,
      aggregateId: SIB_RUN_B,
      client: rec.client as never,
      kind: "plan.propose",
      planningGoalRefs: SIB_REFS,
      sessionCredential: "cred",
      transport: rec.transport as never,
      version: 0,
    });

    expect(report.stage).toBe("BUILD_REFUSED");
    expect(getterCalls).toBe(0);
    expect(rec.sent).toHaveLength(0);
  });
});
