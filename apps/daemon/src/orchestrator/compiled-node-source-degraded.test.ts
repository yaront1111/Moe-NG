import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import {
  COMPILED_NODE_SOURCE_UNREADABLE, createCompiledNodeSource,
} from "./compiled-node-source.js";

/**
 * AN UNREADABLE GRAPH IS NOT AN EMPTY ONE.
 *
 * `sealed()` catches every fault from the durable graph walk and answers `[]`, under the comment
 * "A degraded read lists nothing rather than throwing the surface down". Keeping the surface up
 * is right. Reporting the contents as EMPTY is not:
 *
 * - `nodes()` hands that empty roster to the affordance port, so every compiled node disappears
 *   from the operator's board in the same pass — as a fact, with no indication anything failed.
 * - `mission()` finds no node and answers null, and the wrapper turns null into
 *   NODE_BRIEF_MISSING for a node whose brief exists and is perfectly readable tomorrow.
 *
 * The wrapper already separates a mission that THROWS (AGENT_SETUP_FAILED:node.mission) from a
 * brief that is absent, so the degraded read has somewhere honest to go without changing how the
 * roster surface behaves.
 */

/**
 * A store that answers every read emptily. `sealed()` makes TWO durable reads — the graph walk
 * and the legacy-key sweep — and a fixture that starves the second would look degraded for a
 * reason the arm is not about.
 */
const readableStore = (): SqliteEventStore => ({
  getAggregateVersion: () => 0,
  readCommandDecisionCacheVersion: () => 1,
  readCommandDecisionsAfter: () => ({ items: [], nextCursor: null }),
  readEventHorizon: () => 0n,
  readEvents: () => [],
  readEventsAfter: () => ({ items: [], nextCursor: null }),
  readEventsByTypeAfter: () => ({ items: [], nextCursor: null }),
}) as unknown as SqliteEventStore;

const sourceWith = (readActive: () => never | readonly never[]): ReturnType<typeof createCompiledNodeSource> =>
  createCompiledNodeSource({
    projectId: "project-1",
    readActive: readActive as never,
    store: readableStore(),
    testCommand: "pnpm test",
    workspace: "D:\\projexts\\demo",
  });

describe("a compiled node source whose durable read fails", () => {
  it("keeps the roster surface up rather than throwing it down", () => {
    const source = sourceWith(() => { throw new Error("SQLITE_BUSY"); });

    expect(() => source.nodes()).not.toThrow();
    expect(source.nodes()).toEqual([]);
  });

  it("refuses a mission by name instead of reporting the brief as missing", () => {
    const source = sourceWith(() => { throw new Error("SQLITE_BUSY"); });

    expect(() => source.mission("node:v1:abc")).toThrow(COMPILED_NODE_SOURCE_UNREADABLE);
  });

  it("still answers null for a node that genuinely is not in a readable graph", () => {
    const source = sourceWith(() => []);

    expect(source.mission("node:v1:abc")).toBeNull();
  });

  it("still answers null when the host configured no workspace, whatever the store did", () => {
    const source = createCompiledNodeSource({
      projectId: "project-1",
      readActive: (() => { throw new Error("SQLITE_BUSY"); }) as never,
      store: readableStore(),
      testCommand: null,
      workspace: null,
    });

    // Absent host facts are a deliberate configuration, decided before any store is consulted.
    expect(source.mission("node:v1:abc")).toBeNull();
  });
});
