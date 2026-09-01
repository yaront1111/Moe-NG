/**
 * The full-PRD read the planning seam consumes. Every arm drives the PRODUCTION
 * writer (`createGoalWithSource` in an activated world) and reads back through the
 * port — nothing seeds hand-spelled bindings — so the answer proven here is the
 * one a spawned planning agent will receive over `documents.source_read`.
 */
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { createGoalSourceReadPort } from "./document-source-full-read.js";

const PRD = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";
const encoder = new TextEncoder();

afterEach(closeStores);

/** The PRODUCTION wire: goal.create_with_source through the bootstrap dispatch,
 *  so the GoalCreated event carries the real decision trace the catalog decoder
 *  (and therefore this port) admits bindings under. */
function boundWorld(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD and read it back whole.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Full-read journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

describe("createGoalSourceReadPort", () => {
  it("returns the FULL text the goal binds, every scalar re-derived from durable bytes", () => {
    const store = boundWorld();
    const port = createGoalSourceReadPort({ projectId: PROJECT_ID, store });
    const read = port.read(GOAL_ID);
    if (!read.ok) throw new Error(`read refused: ${read.code}`);
    expect(read.text).toBe(PRD);
    expect(read.byteLength).toBe(encoder.encode(PRD).length);
    expect(read.mediaType).toBe("text/markdown");
    expect(read.displayPath).toBe("docs/prd.md");
    expect(read.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    // NOT the excerpt: the dossier view truncates at 4KiB; this is the whole record.
    expect(read.text.length).toBe(PRD.length);
  });

  it("refuses malformed refs and unknown goals with their own codes", () => {
    const store = boundWorld();
    const port = createGoalSourceReadPort({ projectId: PROJECT_ID, store });
    for (const bad of [42, "", null, undefined, "x".repeat(600)]) {
      expect(port.read(bad)).toMatchObject({ code: "GOAL_SOURCE_READ_MALFORMED", ok: false });
    }
    expect(port.read("goal-that-never-was")).toMatchObject({
      code: "GOAL_SOURCE_UNBOUND", ok: false,
    });
  });

  it("answers UNBOUND for a goal created without a source", () => {
    const store = openStore();
    // driveThrough stops BEFORE goal.create, then the plain bootstrap journey's
    // goal.create runs as part of driving one kind further (no source leg).
    driveThrough(store, "plan.propose");
    const port = createGoalSourceReadPort({ projectId: PROJECT_ID, store });
    expect(port.read(GOAL_ID)).toMatchObject({ code: "GOAL_SOURCE_UNBOUND", ok: false });
  });

  it("fails closed when the stored source bytes disagree with the binding", () => {
    const store = boundWorld();
    // Same tamper idiom as the dossier read's suite: the store answers the goal
    // ledger honestly but rewrites the SOURCE aggregate's payload on read.
    const tampered = encoder.encode(JSON.stringify({
      byteLength: 7, contentSha256: "ab".repeat(32), displayPath: "docs/prd.md",
      mediaType: "text/markdown", schemaVersion: "moe-document-source/1", text: "tamper!",
    }));
    const tamperingStore = new Proxy(store, {
      get(target, property) {
        if (property === "readAggregateEvents") {
          return (aggregateId: string, after: number, limit: number) => {
            const page = target.readAggregateEvents(aggregateId, after, limit);
            // Only the SOURCE aggregate is rewritten: the goal's own event stays
            // honest, so the refusal below is the source-integrity fence, not the
            // goal admission.
            if (aggregateId === GOAL_ID) return page;
            return {
              ...page,
              items: page.items.map((event: object) => ({ ...event, payload: tampered })),
            };
          };
        }
        // Every other member is served BOUND TO THE REAL STORE, so class-private
        // state never sees the proxy as `this`.
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const port = createGoalSourceReadPort({
      projectId: PROJECT_ID,
      store: tamperingStore,
    });
    expect(port.read(GOAL_ID)).toMatchObject({ code: "GOAL_SOURCE_INVALID", ok: false });
  });
});
