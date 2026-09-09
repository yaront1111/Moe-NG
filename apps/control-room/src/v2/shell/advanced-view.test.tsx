import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { LiveEventRow } from "../../live/live-event-feed.js";
import { mapGraphGetAnswer } from "../../live/live-graph-get.js";
import { AdvancedView } from "./advanced-view.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NODE = Object.freeze({ executionBearing: true, nodeKey: "n1" });
const ACCEPTED = Object.freeze({
  graphContentHash: "aa".repeat(32), graphEpoch: 4, ok: true, planHash: "bb".repeat(32),
  provenance: Object.freeze({ aggregateId: "agg-1", goalRef: "goal-1" }),
  revisionId: "graph-revision-1",
  snapshot: Object.freeze({
    completionNodeKey: "n1", edges: [], nodes: [NODE],
  }),
  snapshotIdentity: "cc".repeat(32),
});

const EVENT: LiveEventRow = Object.freeze({
  aggregateId: "goal-1", committedAt: "2026-09-05T12:00:00.000Z", eventId: "evt-1",
  eventType: "GoalCreated", identity: null, ledgerObservation: null, position: "7",
  seamObservation: null,
});

function decodedGraph() {
  const graph = mapGraphGetAnswer(200, ACCEPTED);
  if (graph.status !== "GRAPH") throw new Error(`fixture must decode, got ${graph.status}`);
  return graph;
}

describe("the Advanced forensic view", () => {
  it("keeps the panel unmounted until the toggle is opened", async () => {
    const user = userEvent.setup();
    render(<AdvancedView events={{ status: "EVENTS", rows: [EVENT] }} graph={decodedGraph()} />);
    expect(screen.queryByTestId("cr.advanced.panel")).toBeNull();
    expect(screen.queryByTestId("cr.advanced.graph.hash")).toBeNull();
    await user.click(screen.getByTestId("cr.advanced.toggle"));
    expect(screen.getByTestId("cr.advanced.panel")).toBeTruthy();
  });

  it("renders decoded graph and event frames by exact string, not by container presence", async () => {
    const user = userEvent.setup();
    render(<AdvancedView events={{ status: "EVENTS", rows: [EVENT] }} graph={decodedGraph()} />);
    await user.click(screen.getByTestId("cr.advanced.toggle"));
    expect(screen.getByTestId("cr.advanced.graph.hash").textContent).toBe("aa".repeat(32));
    expect(screen.getByTestId("cr.advanced.graph.revision").textContent).toBe("graph-revision-1");
    expect(screen.getByTestId("cr.advanced.graph.epoch").textContent).toBe("4");
    expect(screen.getByTestId("cr.advanced.graph.nodes").textContent).toBe("n1");
    expect(screen.getByTestId("cr.advanced.events.frame.evt-1").textContent).toContain("GoalCreated");
    expect(screen.getByTestId("cr.advanced.events.frame.evt-1").textContent).toContain("evt-1");
  });

  it("renders a refused raw read at its own code, verbatim", async () => {
    const user = userEvent.setup();
    render(<AdvancedView
      events={{ code: "EVENT_PAGE_CAPABILITY_DENIED", layer: "EVENT_STREAM", status: "REFUSED" }}
      graph={{ code: "GRAPH_QUERY_CAPABILITY_DENIED", layer: "GRAPH_QUERY", status: "REFUSED" }}
    />);
    await user.click(screen.getByTestId("cr.advanced.toggle"));
    expect(screen.getByTestId("cr.advanced.graph.refusal").textContent)
      .toContain("GRAPH_QUERY_CAPABILITY_DENIED");
    expect(screen.getByTestId("cr.advanced.graph.refusal").textContent).toContain("GRAPH_QUERY");
    expect(screen.getByTestId("cr.advanced.events.refusal").textContent)
      .toContain("EVENT_PAGE_CAPABILITY_DENIED");
    expect(screen.queryByTestId("cr.advanced.graph.hash")).toBeNull();
  });

  it("reds a drifted graph fixture at the production decoder, not on the panel", () => {
    const drifted = mapGraphGetAnswer(200, { ...ACCEPTED, extra: true });
    expect(drifted).toStrictEqual({
      code: "GRAPH_GET_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_GRAPH_GET", status: "ERROR",
    });
  });
});
