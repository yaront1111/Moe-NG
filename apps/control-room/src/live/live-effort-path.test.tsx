import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LiveControlRoom } from "./live-app.js";
import type { LiveSetup } from "./live-config.js";
import { dispatchAffordance } from "./live-dispatch.js";
import type { DispatchReport } from "./live-dispatch.js";
import {
  liveEffortDecisions,
  liveEffortObservations,
  liveEffortRefusals,
} from "./live-effort-edge.js";
import { ClockProvider } from "../performance/command-latency.js";

/**
 * DoD 3 and DoD 5, and — as in `live-timing-path.test.tsx` — its SHAPE is the point.
 *
 * It does NOT call `createEffortCollector`, hand it a decision and assert the record
 * back. The effort-admission and effort-collector specs already do exactly that, they
 * passed for the entire time production had ZERO callers, and that is precisely why the
 * gap stayed invisible. Instead it drives `dispatchAffordance` — the production seam the
 * board's click handler calls — and reads the observation production recorded on the way
 * through. The APPROVE arms additionally render the live application and click the board's
 * own Dispatch button, which is what keeps the click-to-seam edge proven; the board is
 * driven through one representative click here; the per-kind dispatch sweep lives in live-board-dispatch.test.tsx.
 *
 * Nothing below hands the surface a record, a decision kind, a source or a reason code.
 * Every asserted value is one production produced from the command kind and the
 * daemon-minted command identity the board actually dispatched.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Card {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly kind: string;
}

/** Distinct command identities per test: the collector is the live session's, and shared. */
function card(kind: string, commandId: string, aggregateId: string): Card {
  return { aggregateId, commandId, kind };
}

/**
 * The daemon's per-run planning authority, with its exact seven keys
 * (apps/daemon/src/http/affordance-planning-authorities.ts). The board renders an
 * `approval.decide` control only for a run the surface bound to a goal AND handed material
 * for, so the surface this file answers with now states both — VALID wire facts, added
 * because the render fence moved; no expectation below is weakened for them.
 */
function materialFor(runId: string, goalRef: string): Record<string, unknown> {
  const graphRevisionRef = `${runId}-graph-revision`;
  const graphContentHash = "8d".repeat(32);
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
    graphContentBytesBase64: "ZWZmb3J0LWdyYXBo",
    graphContentHash,
    graphRevisionRef,
    runId,
    submissionHash: "5e".repeat(32),
  };
}

/** The kinds the daemon keys planning material by; `goal.close` targets the goal, not a run. */
const AUTHORITY_KINDS: readonly string[] = Object.freeze(["approval.decide", "plan.propose"]);

function planningFactsFor(cards: readonly Card[]): {
  authorities: Record<string, unknown>;
  refs: Record<string, string>;
} {
  const authorities: Record<string, unknown> = {};
  const refs: Record<string, string> = {};
  for (const entry of cards) {
    if (!AUTHORITY_KINDS.includes(entry.kind)) continue;
    const goalRef = `goal-${entry.aggregateId}`;
    refs[entry.aggregateId] = goalRef;
    authorities[entry.aggregateId] = materialFor(entry.aggregateId, goalRef);
  }
  return { authorities, refs };
}

function surfaceBody(cards: readonly Card[]): string {
  const { authorities, refs } = planningFactsFor(cards);
  return JSON.stringify({
    nextAllowedCommands: cards.map((entry) => ({
      commandId: entry.commandId,
      commandKind: entry.kind,
      expectedVersion: 0,
      targetAggregateId: entry.aggregateId,
    })),
    outcome: "SURFACE",
    planningAuthorityByRun: authorities,
    planningGoalRefs: refs,
    steps: cards.map((entry) => ({
      aggregateId: entry.aggregateId,
      kind: entry.kind,
      missing: [],
      status: "READY",
      version: 0,
    })),
  });
}

/** The daemon's affordance surface, answered through the board feed's own fetch seam. */
function stubSurfaceFetch(cards: readonly Card[]): void {
  vi.stubGlobal("fetch", async () => new Response(surfaceBody(cards), { status: 200 }));
}

function setupWith(cards: readonly Card[]): LiveSetup {
  const commands: Record<string, unknown> = {};
  for (const entry of cards) {
    commands[entry.kind] = (affordance: unknown, caller: unknown) => ({
      envelope: {
        ...(affordance as Record<string, unknown>),
        ...(caller as Record<string, unknown>),
      },
      ok: true,
    });
  }
  return {
    client: { commands },
    headers: Object.freeze({}),
    ok: true,
    projection: "moe.board",
    sessionCredential: "live-session",
    subscriberId: "control-room-1",
    transport: {
      readDocumentDossier: async () => ({
        code: "TRANSPORT_REQUEST_FAILED",
        delivered: false,
        layer: "CONTROL_ROOM_TRANSPORT",
      }),
      readEventPage: async () => new Promise(() => undefined),
      sendCommand: async (envelope: RuntimeCommandEnvelope) => ({
        delivered: true,
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
      }),
    },
  } as unknown as LiveSetup;
}

function reportOf(entry: Card): HTMLElement {
  return screen.getByTestId(`cr.liveboard.report.${entry.kind}@${entry.aggregateId}`);
}

/**
 * TWO DRIVERS, and the split is forced rather than chosen.
 *
 * The rendered application is clicked for `approval.decide` as the
 * representative kind. Every other kind is driven
 * through `dispatchAffordance` — the SAME production function the board's own
 * click handler calls, with the same affordance record the surface carries — so
 * no assertion below is weakened: what is lost is the click, not the production
 * path, and the arm that still clicks proves the click reaches that path.
 */

/** Renders the real application over the surface and clicks the board's own buttons. */
async function dispatchThroughBoard(
  cards: readonly Card[], clicks: readonly Card[],
): Promise<void> {
  stubSurfaceFetch(cards);
  render(
    <ClockProvider clock={{ now: () => 1_000 }}>
      <LiveControlRoom setup={setupWith(cards)} />
    </ClockProvider>,
  );
  for (const entry of clicks) {
    // This driver renders and clicks the approval card only; a caller asking
    // for another kind wants the seam driver below, and should hear so
    // rather than time out.
    expect(entry.kind, "this driver clicks only the approval card")
      .toBe("approval.decide");
    await userEvent.click(await screen.findByTestId(`cr.liveboard.dispatch.${entry.kind}`));
    await waitFor(() => {
      expect(reportOf(entry).textContent).not.toContain("dispatching");
    });
  }
}

/** The seam the board's click handler calls, driven directly for the un-clicked kinds. */
async function dispatchThroughSeam(
  cards: readonly Card[], dispatched: readonly Card[],
): Promise<readonly DispatchReport[]> {
  const setup = setupWith(cards);
  const reports: DispatchReport[] = [];
  for (const entry of dispatched) {
    reports.push(await dispatchAffordance({
      // Byte-for-byte the offer `surfaceBody` puts on the wire for this card,
      // which is what the board would have handed over.
      affordance: {
        commandId: entry.commandId, commandKind: entry.kind,
        expectedVersion: 0, targetAggregateId: entry.aggregateId,
      },
      aggregateId: entry.aggregateId,
      client: setup.client,
      kind: entry.kind,
      sessionCredential: setup.sessionCredential,
      transport: setup.transport,
    }));
  }
  return reports;
}

function decisionsFor(commandId: string): readonly { decisionKind: string }[] {
  return liveEffortDecisions().filter((decision) => decision.commandId === commandId);
}

function refusalsFor(commandId: string): readonly { refusal: { code: string; layer: string } }[] {
  return liveEffortRefusals().filter((entry) => entry.commandId === commandId);
}

describe("the live board records the decision it demanded of the operator", () => {
  it("attributes the demanded CREATE to the daemon's own command identity", async () => {
    const goal = card("goal.create", "afford-create-1", "goal-a");
    const [report] = await dispatchThroughSeam([goal], [goal]);

    // The dispatch itself is unchanged: the daemon's answer comes back verbatim.
    expect(report?.stage).toBe("ANSWERED");
    expect(report?.detail).toContain("EFFECTS_COMMITTED");
    const recorded = liveEffortDecisions().filter((d) => d.commandId === "afford-create-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.decisionKind).toBe("CREATE");
    expect(recorded[0]?.demandedKind).toBe("CREATE");
    expect(recorded[0]?.source).toBe("CONTROL_ROOM_INPUT");
  });

  /**
   * DoD 5's cardinality clause. The sweep asserts the exact number of cases it produced
   * as well as their kinds, so a sweep that silently generated nothing cannot pass, and
   * the expected set is written out literally rather than read back from the production
   * array it is meant to pin.
   */
  it("produces every decision kind the vocabulary names, and exactly four cases", async () => {
    const create = card("goal.create", "afford-sweep-create", "goal-b");
    const approve = card("approval.decide", "afford-sweep-approve", "approval-b");
    const accept = card("integration.accept_output", "afford-sweep-accept", "node-b");
    const cards = [create, approve, accept];
    // APPROVE goes through the rendered board; the remaining kinds go through the
    // seam that board click calls. Same order the single-driver version used.
    await dispatchThroughSeam(cards, [create]);
    await dispatchThroughBoard(cards, [approve]);
    await dispatchThroughSeam(cards, [accept, create]);

    const swept = ["afford-sweep-create", "afford-sweep-approve", "afford-sweep-accept"]
      .flatMap((commandId) => decisionsFor(commandId).map((d) => d.decisionKind));
    expect(swept).toHaveLength(4);
    expect([...new Set(swept)].sort()).toEqual(["ACCEPT", "ADDITIONAL", "APPROVE", "CREATE"]);
  });

  it("derives ADDITIONAL for a second demand while keeping the kind demanded", async () => {
    const goal = card("goal.create", "afford-additional-1", "goal-c");
    await dispatchThroughSeam([goal], [goal, goal]);

    const recorded = liveEffortDecisions().filter((d) => d.commandId === "afford-additional-1");
    expect(recorded.map((d) => d.decisionKind)).toEqual(["CREATE", "ADDITIONAL"]);
    // The kind the surface demanded is kept verbatim on the additional arm too.
    expect(recorded.map((d) => d.demandedKind)).toEqual(["CREATE", "CREATE"]);
  });

  it("records a dispatch that demands no decision as a free interaction, never a decision", async () => {
    const close = card("session.close", "afford-free-1", "session/sess-live");
    await dispatchThroughSeam([close], [close]);

    const free = liveEffortObservations().filter(
      (observed) => observed.commandId === "afford-free-1"
        && observed.type === "FREE_INTERACTION",
    );
    expect(free).toHaveLength(1);
    // The interaction and its provenance are production's, not this test's.
    expect(free[0]).toMatchObject({
      interaction: "session.close",
      source: "CONTROL_ROOM_INPUT",
    });
    expect(decisionsFor("afford-free-1")).toHaveLength(0);
    expect(refusalsFor("afford-free-1")).toHaveLength(0);
  });

  it("records the attention switch between the two card surfaces it observed", async () => {
    const first = card("goal.create", "afford-switch-1", "goal-d");
    const second = card("approval.decide", "afford-switch-2", "approval-d");
    // The switch crosses drivers, which is exactly what makes it a switch: the
    // surface identity comes from the dispatch seam, not from the DOM element.
    await dispatchThroughSeam([first, second], [first]);
    await dispatchThroughBoard([first, second], [second]);

    const switched = liveEffortObservations().filter(
      (observed) => observed.type === "ATTENTION_SWITCH"
        && observed.commandId === "afford-switch-2",
    );
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({
      fromSurface: "goal.create@goal-d",
      source: "CONTROL_ROOM_DOM",
      toSurface: "approval.decide@approval-d",
    });
  });
});

/**
 * Both arms pin the EXACT code AND the layer that produced it. Two layers can refuse an
 * effort observation — CONTROL_ROOM_EFFORT_ADMISSION shapes the payload, and
 * CONTROL_ROOM_EFFORT_COLLECTOR refuses one that contradicts the sequence it holds — so
 * an assertion that only said "refused" would stay green the moment the other layer
 * started answering first, which is exactly what the step-6 drill checks.
 */
describe("each refusal on the live path names its exact code and layer", () => {
  it("refuses a demanded decision this vocabulary cannot name as UNPARSEABLE", async () => {
    const review = card("review.submit", "afford-unparseable-1", "node-e");
    await dispatchThroughSeam([review], [review]);

    const refused = refusalsFor("afford-unparseable-1");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.refusal.code).toBe("EFFORT_OBSERVATION_UNPARSEABLE");
    expect(refused[0]?.refusal.layer).toBe("CONTROL_ROOM_EFFORT_ADMISSION");
    // A refused observation is never stored as a weaker decision.
    expect(decisionsFor("afford-unparseable-1")).toHaveLength(0);
  });

  it("refuses a demand nobody observed as ABSENT, never as UNPARSEABLE", async () => {
    const bind = card("project.bind_repository", "afford-absent-1", "proj-e");
    await dispatchThroughSeam([bind], [bind]);

    const refused = refusalsFor("afford-absent-1");
    expect(refused).toHaveLength(1);
    // Zero-vs-absent precedence: nothing was stated here, so nothing was malformed.
    expect(refused[0]?.refusal.code).toBe("EFFORT_OBSERVATION_ABSENT");
    expect(refused[0]?.refusal.layer).toBe("CONTROL_ROOM_EFFORT_ADMISSION");
    expect(decisionsFor("afford-absent-1")).toHaveLength(0);
  });
});
