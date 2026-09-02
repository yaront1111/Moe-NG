import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeCommandEnvelope } from "@moe/contracts";

import { LiveBoard, boardMayDispatch } from "./live-board.js";
import { frameOfSurface } from "./live-board-feed.js";
import type { SurfaceFrame, SurfaceStep } from "./live-board-feed.js";
import { DEV_PAYLOADS, dispatchAffordance, payloadFor } from "./live-dispatch.js";
import { PLANNING_AUTHORITY_KINDS, planningPayloadFor } from "./live-planning-authorities.js";

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

/**
 * The board's budget-commitment reader, stubbed. It must be attached wherever an
 * `approval.decide` control is exercised: `dispatchAffordance` fails CLOSED without one,
 * because `record.budgetRef` is the daemon's decide-time commitment and no browser can mint it.
 * The real one is built in `live-app.tsx` from the live setup's authenticated headers.
 */
const BOARD_COMMITMENT = "4d".repeat(32);
const readsCommitment = (): Promise<{ ref: string; status: "COMMITMENT" }> =>
  Promise.resolve({ ref: BOARD_COMMITMENT, status: "COMMITMENT" as const });

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

/**
 * ONE RUN'S PLANNING AUTHORITY, spelled as the daemon's own seven-key wire record
 * (apps/daemon/src/http/affordance-planning-authorities.ts). Every graph and plan operand a
 * proposal or an approval carries is read off this material for the OFFER's own run; the board
 * mints none of it, so a fixture is the only place these bytes can come from in a unit test.
 */
function materialFor(runId: string, goalRef: string): Record<string, unknown> {
  const graphRevisionRef = `${runId}-graph-revision`;
  const graphContentHash = `${runId.length % 10}f`.repeat(32).slice(0, 64);
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

function authoritiesFor(refs: Readonly<Record<string, string>>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const [runId, goalRef] of Object.entries(refs)) map[runId] = materialFor(runId, goalRef);
  return map;
}

/** One READY card per payload kind PLUS the agent's step, each with an offer. */
function everyKindReady(): SurfaceFrame {
  const kinds = [...PAYLOAD_KINDS, AGENT_KIND];
  const refs = refsFor(kinds);
  return frameOfSurface({
    nextAllowedCommands: kinds.map((kind, index) => ({
      commandId: `afford-${kind}`,
      commandKind: kind,
      expectedVersion: index,
      targetAggregateId: `target-${String(index)}`,
    })),
    outcome: "SURFACE",
    planningAuthorityByRun: authoritiesFor(refs),
    planningGoalRef: "goal-daemon-offer-7",
    planningGoalRefs: refs,
    steps: kinds.map((kind, index) => step(kind, "READY", index)),
  });
}

/**
 * THE PARSED OFFER, which is the ONLY thing the sidecar binds material to.
 *
 * `frameOfSurface` mints the frozen offer records and binds the daemon's material to those
 * exact objects. A structurally identical literal the caller built is a DIFFERENT object and
 * carries none: that is what makes caller-supplied authority unrepresentable rather than
 * merely discouraged, and `unboundOffer` below is the same shape with no binding at all.
 */
function boundOffer(
  kind: string, runId: string, goalRef: string, version: number,
  material: Readonly<Record<string, unknown>> | undefined = undefined,
): Record<string, unknown> {
  const refs = { [runId]: goalRef };
  const frame = frameOfSurface({
    nextAllowedCommands: [{
      commandId: `afford-${kind}-${runId}`, commandKind: kind,
      expectedVersion: version, targetAggregateId: runId,
    }],
    outcome: "SURFACE",
    planningAuthorityByRun: material ?? authoritiesFor(refs),
    planningGoalRefs: refs,
    steps: [],
  });
  const offer = frame.offers[0];
  if (offer === undefined) throw new Error(`no parsed offer for ${kind}@${runId}`);
  return offer;
}

/** The same wire shape with NO material bound to it: goal binding present, sidecar empty. */
function unboundOffer(
  kind: string, runId: string, goalRef: string, version: number,
): Record<string, unknown> {
  return boundOffer(kind, runId, goalRef, version, Object.freeze({}));
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
    // control through this exact function. The planning kinds additionally need the
    // daemon's material, which rides the parsed offer and nothing else.
    expect(boardMayDispatch({
      aggregateId: "target-0", claim: null, kind, missing: [], status: "READY", version: 0,
    }, { "target-0": "goal-daemon-offer-7" },
    boundOffer(kind, "target-0", "goal-daemon-offer-7", 0))).toBe(true);
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
  const OFFER = boundOffer("plan.propose", "run-live-1", "goal-daemon-offer-7", 0);
  const MATERIAL = materialFor("run-live-1", "goal-daemon-offer-7");

  const chainOf = (version: number | null): readonly Record<string, unknown>[] => {
    const payload = planningPayloadFor(
      "plan.propose", OFFER, version, "goal-daemon-offer-7",
    );
    if (payload === null) throw new Error("plan.propose has no payload");
    return payload["commands"] as readonly Record<string, unknown>[];
  };

  it("dispatches the sealing planning chain at version 0 and the finalize after it", () => {
    const planningPayload = planningPayloadFor(
      "plan.propose", OFFER, 0, "goal-daemon-offer-7",
    );
    if (planningPayload === null) throw new Error("bound plan.propose has no payload");
    const planning = planningPayload["commands"] as readonly Record<string, unknown>[];
    expect(planning.map((command) => command["kind"])).toEqual([
      "planning.create_draft", "planning.ready", "planning.claim", "plan.propose",
    ]);
    expect(planning[0]?.["goalRef"]).toBe("goal-daemon-offer-7");
    expect(planning[0]?.["goalRef"]).not.toBe("goal-live-1");
    expect(planningPayloadFor("plan.propose", OFFER, 0, null)).toBeNull();
    // The AUTHORITY-LESS half of the same rule: `payloadFor` holds no planning material at
    // all any more, so it authors neither of the two authority-bearing kinds.
    expect(payloadFor("plan.propose", "run-live-1", 0, "goal-daemon-offer-7")).toBeNull();
    expect(payloadFor("approval.decide", "run-live-1", 2)).toBeNull();
    // The propose terminal seals authority bodies; a bare proposal never reaches PLAN_REVIEW.
    const propose = planning[planning.length - 1];
    expect(propose?.["authority"]).toEqual(MATERIAL["authority"]);
    expect(propose?.["submissionHash"]).toBe(MATERIAL["submissionHash"]);
    expect(propose?.["graphContentBytesBase64"]).toBe(MATERIAL["graphContentBytesBase64"]);
    expect(chainOf(null)).toEqual(planning);

    const finalize = chainOf(1);
    expect(finalize.map((command) => command["kind"])).toEqual(["planning.finalize_submission"]);
    // The finalize is judged against the sealed plan's own hash, and approval against the same.
    const revision = finalize[0]?.["revision"] as Record<string, unknown>;
    expect(revision["planHash"]).toBe(propose?.["submissionHash"]);
    expect(revision["graphContentHash"]).toBe(MATERIAL["graphContentHash"]);
    expect(revision["graphRevisionRef"]).toBe(MATERIAL["graphRevisionRef"]);
    // The finalize carries the graph HASH and never the bytes: that key is in the daemon's
    // FORBIDDEN_BODY_KEYS and a finalize holding it is refused whole at DAEMON_INGRESS.
    expect(finalize[0]).not.toHaveProperty("graphContentBytesBase64");
    const approvalOffer = boundOffer(
      "approval.decide", "run-live-1", "goal-daemon-offer-7", 2,
    );
    const approval = planningPayloadFor(
      "approval.decide", approvalOffer, 2, "goal-daemon-offer-7",
    ) as Record<string, unknown>;
    expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"])
      .toBe(propose?.["submissionHash"]);
    expect(approval["graphRevisionRef"]).toBe(revision["graphRevisionRef"]);
    // Every approval identity DoD 4 names comes off the same snapshotted authority.
    const contract = (MATERIAL["authority"] as Record<string, unknown>)["acceptanceContract"];
    expect(approval["record"]).toMatchObject({
      actor: (contract as Record<string, unknown>)["authorRef"],
      approvedNodeScope: ["run-live-1-node"],
      criteriaRef: (contract as Record<string, unknown>)["criteriaDigest"],
    });
    expect((approval["activation"] as Record<string, unknown>)["graphHash"])
      .toBe(MATERIAL["graphContentHash"]);
  });

  it("keeps the card dispatchable at both versions, through the production predicate", () => {
    for (const version of [0, 1]) {
      expect(boardMayDispatch({
        aggregateId: "run-live-1", claim: null, kind: "plan.propose", missing: [],
        status: "READY", version,
      }, { "run-live-1": "goal-daemon-offer-7" },
      boundOffer("plan.propose", "run-live-1", "goal-daemon-offer-7", version)),
      `version ${String(version)}`).toBe(true);
    }
  });

  /**
   * RAIL 3, PINNED IN A TEST rather than only in prose. The daemon's producer carries NO
   * dependencyHash, qualityHash or policyHash — a journeyAuthority probe measured that — so
   * this row must NOT re-derive them or relabel an unrelated digest as one. Their existing,
   * internally consistent placeholders survive the move verbatim, and this arm reddens if a
   * later hand quietly binds one to producer material it was never given.
   */
  it("leaves the three non-producer digests exactly where they were", () => {
    const finalize = chainOf(1)[0] as Record<string, unknown>;
    const revision = finalize["revision"] as Record<string, unknown>;
    expect(revision["dependencyHash"]).toBe(`d1${"0".repeat(62)}`);
    expect(revision["qualityHash"]).toBe(`dd${"0".repeat(62)}`);
    // The producer's seven keys never held any of these three names.
    for (const absent of ["dependencyHash", "qualityHash", "policyHash"]) {
      expect(MATERIAL).not.toHaveProperty(absent);
    }
    const approval = planningPayloadFor(
      "approval.decide",
      boundOffer("approval.decide", "run-live-1", "goal-daemon-offer-7", 2),
      2, "goal-daemon-offer-7",
    ) as Record<string, unknown>;
    const activation = approval["activation"] as Record<string, unknown>;
    expect(activation["policyHash"]).toBe(`b1${"0".repeat(62)}`);
    expect(activation["qualityHash"]).toBe(`dd${"0".repeat(62)}`);
  });
});

/**
 * THE PLANNING-KIND ROSTER, ASSERTED IN BOTH DIRECTIONS.
 *
 * A test that iterates the advertised roster alone can only see one direction: deleting an
 * entry shrinks its own iteration and stays green while the capability silently vanishes. So
 * the SERVED set is enumerated from the implementation seams themselves — what `payloadFor`
 * authors and what `planningPayloadFor` authors — and compared for set equality.
 */
describe("the planning-kind roster is bidirectional", () => {
  const RUN = "run-roster-1";
  const GOAL = "goal-roster-1";
  const ALL_KINDS: readonly string[] = Object.freeze([
    ...PAYLOAD_KINDS, AGENT_KIND, "review.submit", "integration.accept_output",
  ]);

  it("serves exactly the kinds it advertises, and advertises exactly the kinds it serves", () => {
    expect(ALL_KINDS.length).toBeGreaterThan(PAYLOAD_KINDS.length);

    const servedByPlanning = ALL_KINDS.filter((kind) => planningPayloadFor(
      kind, boundOffer(kind, RUN, GOAL, 0), 0, GOAL,
    ) !== null).sort();
    // Direction 1: every ADVERTISED kind is actually served.
    for (const advertised of PLANNING_AUTHORITY_KINDS) {
      expect(servedByPlanning, `advertised ${advertised}`).toContain(advertised);
    }
    // Direction 2: every SERVED kind is advertised. Set equality, not a subset check.
    expect(servedByPlanning).toEqual([...PLANNING_AUTHORITY_KINDS].sort());
    expect(servedByPlanning.length).toBeGreaterThan(1);
  });

  it("splits the whole vocabulary between the two seams, with no kind served twice", () => {
    const byPayload = ALL_KINDS.filter((kind) => payloadFor(kind, RUN, 0, GOAL) !== null);
    const byPlanning = ALL_KINDS.filter((kind) => planningPayloadFor(
      kind, boundOffer(kind, RUN, GOAL, 0), 0, GOAL,
    ) !== null);

    // Disjoint: an authority-bearing kind is authored by the sidecar seam and NOWHERE else,
    // so a `payloadFor` that quietly regrew a static planning chain reddens here.
    expect(byPayload.filter((kind) => byPlanning.includes(kind))).toEqual([]);
    // And together they are the whole authorable vocabulary, minus the staffed agent's step.
    expect([...byPayload, ...byPlanning].sort())
      .toEqual(ALL_KINDS.filter((kind) => kind !== AGENT_KIND).sort());
  });
});

describe("the board renders one control per authorable READY step", () => {
  it("renders a dispatch control for every payload kind and none for the agent's step", () => {
    const { container } = render(
      <LiveBoard
        client={builderFor(PAYLOAD_KINDS) as never}
        frame={everyKindReady()}
        readBudgetCommitment={readsCommitment}
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
        readBudgetCommitment={readsCommitment}
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
        readBudgetCommitment={readsCommitment}
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
        readBudgetCommitment={readsCommitment}
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
    planningAuthorityByRun: authoritiesFor({ "run-claimed": "goal-claimed" }),
    planningGoalRefs: { "run-claimed": "goal-claimed" },
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
        readBudgetCommitment={readsCommitment}
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
    planningAuthorityByRun: authoritiesFor({ "approval-9": "goal-approve-9" }),
    planningGoalRefs: { "approval-9": "goal-approve-9" },
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
        readBudgetCommitment={readsCommitment}
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

/**
 * The offer the daemon minted for goal B, the one the operator clicked — PARSED through
 * `frameOfSurface`, because the sidecar binds material to the exact parsed record and to
 * nothing a caller could hand it.
 */
function offerForB(kind: string, target: string, expectedVersion: number): Record<string, unknown> {
  const goalRef = SIB_REFS[target] ?? SIB_GOAL_B;
  return boundOffer(kind, target, goalRef, expectedVersion);
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
    readBudgetCommitment: readsCommitment,
    sessionCredential: "cred",
    transport: rec.transport as never,
    version,
  });
}

/**
 * DoD 4's BROWSER HALF: the approval's `budgetRef` is READ off the daemon, not spelled.
 *
 * `DEV_PAYLOADS["approval.decide"].record` deliberately carries no `budgetRef` — it used to
 * carry `hex64("bb")`, and once task-61a2e8ad bound the field back at activation that literal
 * became a wrong answer the daemon refuses. `payloadFor` is synchronous and pure so it cannot
 * fetch one; `dispatchAffordance` does, and merges the daemon's answer in.
 *
 * The arms drive the PRODUCTION dispatch surface and read what actually reached the builder,
 * so a module that quietly restored a constant fails them.
 */
describe("the approval carries the commitment the daemon read back", () => {
  const COMMITMENT = "4d".repeat(32);

  it("never spells one in the base payload", () => {
    const record = (DEV_PAYLOADS["approval.decide"] as Record<string, unknown>)["record"];

    expect(record).not.toHaveProperty("budgetRef");
    const authored = planningPayloadFor(
      "approval.decide", offerForB("approval.decide", SIB_RUN_B, 2), 2, SIB_GOAL_B,
    ) as Record<string, unknown>;
    expect(authored["record"]).not.toHaveProperty("budgetRef");
  });

  it("merges the READ ref into the record it hands the builder, for the OFFERED run", async () => {
    const rec = recorder();
    const asked: string[] = [];

    const report = await dispatchAffordance({
      affordance: offerForB("approval.decide", SIB_RUN_B, 2),
      aggregateId: SIB_RUN_A,
      client: rec.client as never,
      kind: "approval.decide",
      planningGoalRefs: SIB_REFS,
      readBudgetCommitment: (runId) => {
        asked.push(runId);
        return Promise.resolve({ ref: COMMITMENT, status: "COMMITMENT" as const });
      },
      sessionCredential: "cred",
      transport: rec.transport as never,
      version: 2,
    });

    expect(report.stage).toBe("ANSWERED");
    // The OFFER's run, never the card the operator was looking at.
    expect(asked).toEqual([SIB_RUN_B]);
    const record = rec.built[0]?.payload["record"] as Record<string, unknown>;
    expect(record["budgetRef"]).toBe(COMMITMENT);
  });

  it("refuses at BUILD with the daemon's OWN code and layer when the read refuses", async () => {
    const rec = recorder();

    const report = await dispatchAffordance({
      affordance: offerForB("approval.decide", SIB_RUN_B, 2),
      aggregateId: SIB_RUN_A,
      client: rec.client as never,
      kind: "approval.decide",
      planningGoalRefs: SIB_REFS,
      readBudgetCommitment: () => Promise.resolve({
        code: "APPROVAL_AUTHORITY_UNSEALED", layer: "APPROVAL_RUN_BINDING",
        status: "REFUSED" as const,
      }),
      sessionCredential: "cred",
      transport: rec.transport as never,
      version: 2,
    });

    // Carried through, not restated: "this run is not sealed yet" is a different repair from
    // "the budget history is unreadable", and both are the daemon's to name.
    expect(report.stage).toBe("BUILD_REFUSED");
    expect(report.detail).toBe("APPROVAL_AUTHORITY_UNSEALED @ APPROVAL_RUN_BINDING");
    expect(rec.sent).toHaveLength(0);
  });

  it("refuses fail-closed when no reader is attached, rather than sending an unvouched ref",
    async () => {
      const rec = recorder();

      const report = await dispatchAffordance({
        affordance: offerForB("approval.decide", SIB_RUN_B, 2),
        aggregateId: SIB_RUN_A,
        client: rec.client as never,
        kind: "approval.decide",
        planningGoalRefs: SIB_REFS,
        sessionCredential: "cred",
        transport: rec.transport as never,
        version: 2,
      });

      expect(report.stage).toBe("BUILD_REFUSED");
      expect(report.detail).toBe("BUDGET_COMMITMENT_READER_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
      expect(rec.sent).toHaveLength(0);
    });

  it("leaves every OTHER kind untouched: no read is attempted and nothing is merged",
    async () => {
      const rec = recorder();
      let reads = 0;

      const report = await dispatchAffordance({
        affordance: offerForB("goal.close", SIB_RUN_B, 0),
        aggregateId: SIB_RUN_A,
        client: rec.client as never,
        kind: "goal.close",
        planningGoalRefs: SIB_REFS,
        readBudgetCommitment: () => {
          reads += 1;
          return Promise.resolve({ ref: COMMITMENT, status: "COMMITMENT" as const });
        },
        sessionCredential: "cred",
        transport: rec.transport as never,
        version: 0,
      });

      expect(report.stage).toBe("ANSWERED");
      expect(reads).toBe(0);
      expect(rec.built[0]?.payload).not.toHaveProperty("budgetRef");
    });
});

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

/**
 * THE TWO PLANNING REFUSALS ARE DISTINCT, AND EACH FIXTURE LEAVES ONLY ITS OWN GUARD ABLE
 * TO ANSWER.
 *
 * A missing GOAL BINDING and missing AUTHORITY MATERIAL are different repairs — "the daemon
 * bound this run to no goal" sends an operator somewhere else entirely from "the daemon
 * offered no sealed plan for it" — so they carry different codes at the same layer. Proving
 * that needs divergence, not merely a refusal: in the missing-goal arm the material IS bound,
 * so loosening the goal guard would let the dispatch through the authority guard and reach the
 * builder; in the missing-authority arm the goal IS bound, so loosening the authority guard
 * would reach the builder too. Every downstream seam accepts, and each arm pins ZERO calls to
 * the budget reader, the builder and the transport — the three things a refusal must precede.
 */
interface GuardProbe extends Recorder {
  readonly reads: string[];
}

function guardProbe(): GuardProbe {
  const base = recorder();
  return { ...base, reads: [] };
}

async function dispatchThrough(
  probe: GuardProbe, kind: string, offer: Record<string, unknown>,
  version: number, refs: Readonly<Record<string, string>> | undefined,
) {
  return await dispatchAffordance({
    affordance: offer,
    aggregateId: SIB_RUN_A,
    client: probe.client as never,
    kind,
    planningGoalRefs: refs,
    readBudgetCommitment: (runId) => {
      probe.reads.push(runId);
      return Promise.resolve({ ref: "4d".repeat(32), status: "COMMITMENT" as const });
    },
    sessionCredential: "cred",
    transport: probe.transport as never,
    version,
  });
}

describe("the two planning bindings refuse under their own names", () => {
  it("names the GOAL binding when the material is present but no goal is bound", async () => {
    const probe = guardProbe();
    // Material for B IS bound to this exact offer, so the authority guard would accept.
    // The map handed to the dispatch binds only sibling A, so only the goal guard can answer.
    const report = await dispatchThrough(
      probe, "plan.propose", offerForB("plan.propose", SIB_RUN_B, 0), 0,
      { [SIB_RUN_A]: SIB_GOAL_A },
    );

    expect(report).toEqual({
      detail: "PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH",
      ok: false,
      stage: "BUILD_REFUSED",
    });
    expect(probe.reads).toEqual([]);
    expect(probe.built).toHaveLength(0);
    expect(probe.sent).toHaveLength(0);
  });

  it("names the AUTHORITY binding when the goal is bound but no material was offered", async () => {
    const probe = guardProbe();
    // The goal binding IS present and readable, so the goal guard accepts; the surface simply
    // carried no material for this run, and only the authority guard can answer.
    const report = await dispatchThrough(
      probe, "plan.propose", unboundOffer("plan.propose", SIB_RUN_B, SIB_GOAL_B, 0), 0, SIB_REFS,
    );

    expect(report).toEqual({
      detail: "PLANNING_AUTHORITY_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH",
      ok: false,
      stage: "BUILD_REFUSED",
    });
    expect(probe.reads).toEqual([]);
    expect(probe.built).toHaveLength(0);
    expect(probe.sent).toHaveLength(0);
  });

  it("refuses an APPROVAL the same way, at the same layer, under both names", async () => {
    const missingGoal = guardProbe();
    expect((await dispatchThrough(
      missingGoal, "approval.decide", offerForB("approval.decide", SIB_RUN_B, 2), 2,
      { [SIB_RUN_A]: SIB_GOAL_A },
    )).detail).toBe("PLANNING_OFFER_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    expect(missingGoal.reads).toEqual([]);
    expect(missingGoal.built).toHaveLength(0);
    expect(missingGoal.sent).toHaveLength(0);

    const missingMaterial = guardProbe();
    expect((await dispatchThrough(
      missingMaterial, "approval.decide",
      unboundOffer("approval.decide", SIB_RUN_B, SIB_GOAL_B, 2), 2, SIB_REFS,
    )).detail).toBe("PLANNING_AUTHORITY_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    // The budget reader sits BEHIND both guards: an approval that cannot be authored must
    // never cost the daemon a commitment read.
    expect(missingMaterial.reads).toEqual([]);
    expect(missingMaterial.built).toHaveLength(0);
    expect(missingMaterial.sent).toHaveLength(0);
  });

  it("refuses a caller-minted twin of an offer that really does carry material", async () => {
    const genuine = offerForB("plan.propose", SIB_RUN_B, 0);
    // Byte-identical by structure, and a DIFFERENT object. The sidecar is keyed by the parsed
    // record itself, so no caller can hand the board authority it was never given.
    const forged = { ...genuine };
    expect(forged).toEqual(genuine);

    const probe = guardProbe();
    const report = await dispatchThrough(probe, "plan.propose", forged, 0, SIB_REFS);

    expect(report.detail).toBe("PLANNING_AUTHORITY_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    expect(probe.built).toHaveLength(0);
    expect(probe.sent).toHaveLength(0);

    // The genuine record still authors, so the arm above is about the BINDING and not about
    // some unrelated shape refusal both objects would have tripped.
    const accepted = guardProbe();
    expect((await dispatchThrough(accepted, "plan.propose", genuine, 0, SIB_REFS)).stage)
      .toBe("ANSWERED");
    expect(accepted.sent).toHaveLength(1);
  });

  it("keeps goal.close target-only: no goal binding, no material, and it still dispatches",
    async () => {
      const probe = guardProbe();
      const report = await dispatchThrough(
        probe, "goal.close", unboundOffer("goal.close", SIB_GOAL_B, SIB_GOAL_B, 1), 1, undefined,
      );

      // goal.close names the GOAL aggregate, which is why the daemon's own eligible-kind
      // roster omits it: keying it would put a goal id in a map whose keys are runs.
      expect(report.stage).toBe("ANSWERED");
      expect(probe.built[0]?.payload["goalId"]).toBe(SIB_GOAL_B);
      expect(probe.reads).toEqual([]);
    });
});
