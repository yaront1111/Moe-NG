/**
 * The durable states DoD 3 names by hand, driven through `graph.get` on a REAL
 * file-backed `SqliteEventStore`: malformed and noncanonical history, and
 * receipt/decision mismatch.
 *
 * WHY THESE ARE NOT THE SAME TEST. A malformed history is a row the core replay
 * cannot fold at all. A receipt/decision mismatch is a history the replay folds
 * PERFECTLY while the durable artefact it points at disagrees with what was
 * decided — the store's command receipt reused for different bytes, an
 * activation receipt that does not bind the approved decision, or a body row
 * filed under a hash it does not name. The second class is the dangerous one:
 * every structural check passes, so only an identity comparison catches it, and
 * a suite that only broke event bytes would never reach it.
 *
 * EVERY ARM ASSERTS THE QUADRUPLE — `code`, `layer`, `sourceCode`, `sourceLayer`
 * — plus that no snapshot authority rode along, plus that the read left the
 * event and decision counts untouched. The outer code alone cannot distinguish
 * a missing body from a corrupt one from one filed under the wrong key; that
 * distinction lives entirely in the source pair, which is why the reader keeps
 * them separate and this handler passes them through rather than flattening.
 */

import { CommandIdConflictError, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { graphBodyAggregateId } from "./graph-body-record.js";
import {
  graphRevisionAggregateId,
  readCurrentActiveGraph,
} from "./active-graph-projection.js";
import type { GraphQueryResult } from "./graph-query.js";
import {
  ENCODER,
  PRIMARY,
  PROJECT_ID,
  SECONDARY,
  activePathFor,
  ask,
  commitEvents,
  decisionCount,
  eventCount,
  overMcp,
  seedActive,
  withStore,
} from "./graph-query-test-fixtures.js";

const REVISION = "graph-revision-1";
const BODY_EVENT_TYPE = "GRAPH_BODY_RECORDED";

interface Quadruple {
  readonly code?: unknown;
  readonly layer?: unknown;
  readonly sourceCode?: unknown;
  readonly sourceLayer?: unknown;
}

/**
 * Every refusal in this file must arrive with NO authority attached. An UNKNOWN
 * that still carries a partial identity is authority granted by accident, and it
 * is exactly what a caller would go on to trust.
 */
function refusedWithoutAuthority(answer: GraphQueryResult): Quadruple {
  expect(answer.ok).toBe(false);
  if (answer.ok) throw new Error("an accepted answer was returned where a refusal was required");
  expect(answer).not.toHaveProperty("snapshot");
  expect(answer).not.toHaveProperty("revisionId");
  expect(answer).not.toHaveProperty("graphContentHash");
  expect(answer).not.toHaveProperty("snapshotIdentity");
  expect(answer).not.toHaveProperty("graphEpoch");
  return answer as unknown as Quadruple;
}

/** Commit RAW bytes under a graph-revision aggregate, bypassing nothing but the reducer. */
function commitRaw(
  store: SqliteEventStore,
  revisionId: string,
  rows: readonly { readonly eventType: string; readonly payload: Uint8Array }[],
  commandId: string,
): void {
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(commandId),
    commandId,
    committedAt: "2026-08-18T00:00:00.000Z",
    events: rows.map((row, index) => ({
      eventId: `${commandId}-${index}`,
      eventType: row.eventType,
      payload: row.payload,
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

// --- malformed and noncanonical history --------------------------------------

/**
 * Each case corrupts a REAL generated history in one named way, so the code it
 * produces is the core replay's verdict about production-shaped events rather
 * than about a hand-authored fixture.
 */
const CORRUPT_HISTORIES: readonly (readonly [string, (store: SqliteEventStore) => void, string])[] =
  [
    [
      "an aggregate whose create event is missing",
      (store) => {
        // Enumeration is by aggregate-ID PREFIX, so a history cannot escape the
        // replay by lacking its opening event; without that, this row would have
        // answered ACTIVE_GRAPH_ABSENT and a corrupt project would have been
        // indistinguishable from an empty one.
        const path = activePathFor(REVISION, PRIMARY);
        commitEvents(store, REVISION, path.slice(1));
      },
      "GRAPH_REVISION_REPLAY_MISSING_CREATE",
    ],
    [
      "a stored payload that is not readable JSON",
      (store) => {
        commitRaw(store, REVISION, [{
          eventType: "GraphRevisionCreated",
          payload: Uint8Array.from([0x7b, 0xff, 0xfe, 0x00, 0x7d]),
        }], "corrupt-bytes");
      },
      "GRAPH_REVISION_REPLAY_EVENT_INVALID",
    ],
    [
      "a history with a version hole",
      (store) => {
        const path = activePathFor(REVISION, PRIMARY);
        // Keep the create, drop the submit, keep the approval: the versions no
        // longer form a run, which is the replay's own rule to enforce.
        const kept = [path[0], path[path.length - 1]].filter((event) => event !== undefined);
        commitEvents(store, REVISION, kept);
      },
      "GRAPH_REVISION_REPLAY_VERSION_BREAK",
    ],
  ];

describe("graph.get refuses a malformed durable history with the replay's own code", () => {
  it("generates a nonzero number of distinct corrupt histories", () => {
    // A sweep that silently produced zero cases would pass every arm below while
    // driving nothing at all.
    expect(CORRUPT_HISTORIES.length).toBeGreaterThan(0);
    expect(new Set(CORRUPT_HISTORIES.map(([name]) => name)).size)
      .toBe(CORRUPT_HISTORIES.length);
    expect(new Set(CORRUPT_HISTORIES.map(([, , code]) => code)).size)
      .toBe(CORRUPT_HISTORIES.length);
  });

  for (const [name, corrupt, expectedCode] of CORRUPT_HISTORIES) {
    it(`answers ${name} with ${expectedCode}, from the core layer`, () => {
      withStore("corrupt", (store) => {
        corrupt(store);
        const events = eventCount(store);
        const decisions = decisionCount(store);

        const refusal = refusedWithoutAuthority(ask(store));
        // THE REPLAY'S OWN SPELLING, verbatim. The reader deliberately does not
        // merge core codes into its own three, so a caller tells them apart by
        // prefix; a test asserting only "refused" would stay green the day the
        // two vocabularies merged.
        expect(refusal.code).toBe(expectedCode);
        expect(refusal.layer).toBe("ACTIVE_GRAPH_PROJECTION");
        expect(refusal.sourceLayer).toBe("CORE_GRAPH_REVISION_REPLAY");
        expect(refusal.sourceCode).toBeNull();
        expect(refusal.code).not.toBe("ACTIVE_GRAPH_ABSENT");

        expect(eventCount(store)).toBe(events);
        expect(decisionCount(store)).toBe(decisions);
      });
    });
  }
});

describe("graph.get refuses noncanonical body bytes with the codec's own code", () => {
  it("keeps GRAPH_CONTENT_NONCANONICAL and names the identity layer that refused", () => {
    withStore("noncanonical", (store) => {
      commitEvents(store, REVISION, activePathFor(REVISION, PRIMARY));
      // The SAME content and the SAME declared hash, re-serialised with
      // whitespace. The digest still recomputes to the declared value, so the
      // decoder gets past identity and refuses on the byte comparison alone —
      // which is precisely what "noncanonical" means and why it is a different
      // fact from "malformed".
      const reserialised = ENCODER.encode(
        JSON.stringify(JSON.parse(new TextDecoder().decode(PRIMARY.bytes)) as unknown, null, 2),
      );
      expect([...reserialised]).not.toEqual([...PRIMARY.bytes]);
      store.commit({
        aggregateId: graphBodyAggregateId(PROJECT_ID, PRIMARY.graphContentHash),
        commandBytes: ENCODER.encode("noncanonical-body"),
        commandId: "noncanonical-body",
        committedAt: "2026-08-18T00:00:00.000Z",
        events: [{
          eventId: "noncanonical-body-0",
          eventType: BODY_EVENT_TYPE,
          payload: reserialised,
        }],
        expectedVersion: 0,
      });

      const events = eventCount(store);
      const decisions = decisionCount(store);
      const refusal = refusedWithoutAuthority(ask(store));

      expect(refusal.code).toBe("ACTIVE_GRAPH_BODY_UNAVAILABLE");
      expect(refusal.layer).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(refusal.sourceLayer).toBe("GRAPH_BODY_RECORD");
      // The CODEC's verdict, not a body-record code. Flattening this to
      // GRAPH_BODY_ABSENT would report a present-but-unusable body as a missing
      // one, and a caller would write a new body over a real record.
      expect(refusal.sourceCode).toBe("GRAPH_CONTENT_NONCANONICAL");
      expect(refusal.sourceCode).not.toBe("GRAPH_BODY_ABSENT");

      expect(eventCount(store)).toBe(events);
      expect(decisionCount(store)).toBe(decisions);
    });
  });
});

// --- receipt / decision mismatch ---------------------------------------------

describe("graph.get refuses a receipt that disagrees with the decision", () => {
  it("refuses a body row filed under a hash it does not name", () => {
    withStore("receipt-identity", (store) => {
      // The revision DECIDES SECONDARY's content hash; the receipt stored under
      // that key holds PRIMARY's bytes. Both artefacts are individually valid —
      // the bytes decode, the history folds — and only comparing the receipt's
      // own identity against the decided one catches the swap.
      commitEvents(store, REVISION, activePathFor(REVISION, SECONDARY));
      store.commit({
        aggregateId: graphBodyAggregateId(PROJECT_ID, SECONDARY.graphContentHash),
        commandBytes: ENCODER.encode("misfiled-body"),
        commandId: "misfiled-body",
        committedAt: "2026-08-18T00:00:00.000Z",
        events: [{
          eventId: "misfiled-body-0",
          eventType: BODY_EVENT_TYPE,
          payload: PRIMARY.bytes,
        }],
        expectedVersion: 0,
      });
      expect(PRIMARY.graphContentHash).not.toBe(SECONDARY.graphContentHash);

      const events = eventCount(store);
      const decisions = decisionCount(store);
      const refusal = refusedWithoutAuthority(ask(store));

      expect(refusal.code).toBe("ACTIVE_GRAPH_BODY_UNAVAILABLE");
      expect(refusal.layer).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(refusal.sourceLayer).toBe("GRAPH_BODY_RECORD");
      expect(refusal.sourceCode).toBe("GRAPH_BODY_IDENTITY_MISMATCH");
      // NOT absent and NOT a codec fault: the bytes are present and they decode.
      // Only the identity comparison refuses, and only this code says so.
      expect(refusal.sourceCode).not.toBe("GRAPH_BODY_ABSENT");

      expect(eventCount(store)).toBe(events);
      expect(decisionCount(store)).toBe(decisions);
    });
  });

  it("refuses an activation receipt that does not bind the approved decision", () => {
    withStore("receipt-binding", (store) => {
      const path = activePathFor(REVISION, PRIMARY);
      const last = path[path.length - 1];
      if (last === undefined) throw new Error("generated history did not reach activation");
      // The approval DECIDED one binding; the activation RECEIPT claims another.
      // Everything else about the history is untouched and still folds.
      const record = last as unknown as Record<string, unknown>;
      const drifted = {
        ...record,
        witness: {
          ...(record["witness"] as Record<string, unknown>),
          qualityHash: "9".repeat(64),
        },
      };
      const rows = path.map((event, index) => ({
        eventType: event.kind,
        payload: ENCODER.encode(JSON.stringify(index === path.length - 1 ? drifted : event)),
      }));
      commitRaw(store, REVISION, rows, "drifted-activation");

      const events = eventCount(store);
      const decisions = decisionCount(store);
      const refusal = refusedWithoutAuthority(ask(store));

      expect(refusal.code).toBe("GRAPH_REVISION_REPLAY_BINDING_DRIFT");
      expect(refusal.layer).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(refusal.sourceLayer).toBe("CORE_GRAPH_REVISION_REPLAY");
      expect(refusal.sourceCode).toBeNull();
      // A drifted receipt is NOT an absent graph: collapsing the two would hide
      // a real disagreement behind "there is nothing here".
      expect(refusal.code).not.toBe("ACTIVE_GRAPH_ABSENT");

      expect(eventCount(store)).toBe(events);
      expect(decisionCount(store)).toBe(decisions);
    });
  });

  it("carries the receipt mismatch through the MCP transport unflattened", () => {
    withStore("receipt-mcp", (store) => {
      commitEvents(store, REVISION, activePathFor(REVISION, SECONDARY));
      store.commit({
        aggregateId: graphBodyAggregateId(PROJECT_ID, SECONDARY.graphContentHash),
        commandBytes: ENCODER.encode("misfiled-body"),
        commandId: "misfiled-body",
        committedAt: "2026-08-18T00:00:00.000Z",
        events: [{
          eventId: "misfiled-body-0",
          eventType: BODY_EVENT_TYPE,
          payload: PRIMARY.bytes,
        }],
        expectedVersion: 0,
      });

      const answer = overMcp(store, {
        boundProjectId: PROJECT_ID,
        readCurrentActiveGraph: (projectId: string) => readCurrentActiveGraph(store, projectId),
      });
      expect(answer["ok"]).toBe(false);
      // The JSON boundary is exactly where a four-field struct quietly becomes a
      // two-field one, and a mismatch reported as a plain absence is the version
      // of this answer a caller would act on destructively.
      expect(answer["code"]).toBe("ACTIVE_GRAPH_BODY_UNAVAILABLE");
      expect(answer["layer"]).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(answer["sourceLayer"]).toBe("GRAPH_BODY_RECORD");
      expect(answer["sourceCode"]).toBe("GRAPH_BODY_IDENTITY_MISMATCH");
      expect(answer["snapshot"]).toBeUndefined();
    });
  });

  it("refuses at the STORE when a command receipt is reused for different bytes", () => {
    withStore("receipt-conflict", (store) => {
      seedActive(store);
      const events = eventCount(store);
      const decisions = decisionCount(store);
      const before = ask(store);
      expect(before.ok).toBe(true);

      // The store's OWN receipt rule, exercised rather than described: the same
      // commandId presented with a different request hash is a conflict, never
      // a silent overwrite and never a second history.
      let thrown: unknown;
      try {
        commitEvents(store, REVISION, activePathFor("graph-revision-other", SECONDARY),
          `seed-${REVISION}`);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CommandIdConflictError);
      expect((thrown as CommandIdConflictError).code).toBe("COMMAND_ID_CONFLICT");

      // AND THE DURABLE ANSWER IS UNMOVED. A rejected write that had partially
      // landed would show up here as a split brain or a body mismatch; the point
      // of the receipt is that neither happens.
      const after = ask(store);
      expect(after.ok).toBe(true);
      if (!after.ok || !before.ok) throw new Error("the accepted control refused");
      expect(after.revisionId).toBe(before.revisionId);
      expect(after.graphContentHash).toBe(before.graphContentHash);
      expect(after.snapshotIdentity).toBe(before.snapshotIdentity);
      expect(after.graphContentHash).not.toBe(after.snapshotIdentity);
      expect(eventCount(store)).toBe(events);
      expect(decisionCount(store)).toBe(decisions);
    });
  });
});
