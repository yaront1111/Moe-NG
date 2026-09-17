import { encodeGraphContent } from "@moe/scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeStores, GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createScopedGoalWorld } from "../goals/goal-scoped-test-fixtures.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

/**
 * The execution ref is a pure function of (project, graph, node key) — and of the graph's HASH,
 * which is what made it expensive: every caller derives refs in a loop over the graph's nodes,
 * and each call re-encoded the whole graph to reproduce the same hash. Measured on UnAI
 * 2026-09-17: 51.5% of the live stack host's CPU under this one function, the control room's
 * affordance poll 3–4 s behind it. These pin that the encode happens once per graph object, that
 * memoising it changes no ref, and that a failed encode is never remembered as a success.
 */

vi.mock("@moe/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moe/scheduler")>();
  return { ...actual, encodeGraphContent: vi.fn(actual.encodeGraphContent) };
});

const KEYS = ["node-1", "node-2", "node-3"] as const;

/** The same bytes as the world's graph under a NEW object identity, so the memo starts cold. */
function freshGraph(graph: ActiveCompiledGraph): ActiveCompiledGraph {
  return { content: structuredClone(graph.content), goalRef: graph.goalRef,
    ...(graph.planningRunRef === undefined ? {} : { planningRunRef: graph.planningRunRef }) };
}

afterEach(() => { vi.clearAllMocks(); closeStores(); });

describe("compiledExecutionRef", () => {
  it("encodes the graph once however many node refs are derived from it", () => {
    const world = createScopedGoalWorld([...KEYS]);
    const graph = freshGraph(world.graph);
    vi.mocked(encodeGraphContent).mockClear();

    // Three rounds over three nodes: the shape every read route takes, per poll.
    const refs = [1, 2, 3].flatMap(() => KEYS.map((key) => compiledExecutionRef(PROJECT_ID, graph, key)));

    expect(vi.mocked(encodeGraphContent)).toHaveBeenCalledTimes(1);
    expect(refs).toHaveLength(9);
    // Memoising the hash changes no ref: each equals what the fixture derived without the memo.
    for (const key of KEYS) {
      expect(refs.filter((ref) => ref === world.nodeRef(key))).toHaveLength(3);
    }
  });

  it("keys on the content object, so equal bytes under a new identity encode once more and agree", () => {
    const world = createScopedGoalWorld([...KEYS]);
    const first = freshGraph(world.graph);
    const second = freshGraph(world.graph);
    vi.mocked(encodeGraphContent).mockClear();

    const fromFirst = KEYS.map((key) => compiledExecutionRef(PROJECT_ID, first, key));
    const fromSecond = KEYS.map((key) => compiledExecutionRef(PROJECT_ID, second, key));

    expect(vi.mocked(encodeGraphContent)).toHaveBeenCalledTimes(2);
    expect(fromSecond).toEqual(fromFirst);
    expect(fromFirst[0]).toMatch(/^node:v1:[0-9a-f]{64}$/u);
  });

  it("does not remember a graph it could not encode", () => {
    const unreadable = { content: {} as ActiveCompiledGraph["content"], goalRef: GOAL_ID };
    vi.mocked(encodeGraphContent).mockClear();

    expect(() => compiledExecutionRef(PROJECT_ID, unreadable, "node-1")).toThrow("COMPILED_NODE_IDENTITY_UNREADABLE");
    // A second attempt encodes again: a failure cached as a value would have thrown nothing.
    expect(() => compiledExecutionRef(PROJECT_ID, unreadable, "node-1")).toThrow("COMPILED_NODE_IDENTITY_UNREADABLE");
    expect(vi.mocked(encodeGraphContent)).toHaveBeenCalledTimes(2);
  });
});
