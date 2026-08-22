/**
 * The node-authority closure reader, driven against durably seeded graph bodies.
 *
 * Every world here is seeded through PRODUCTION WRITERS — `graph-query-test-fixtures`
 * drives the real `reduceGraphRevision` and the real `putGraphBody`, so no history and no
 * closure in this file was hand-authored. The happy arm's expected value is the store's own
 * READ-BACK of the seeded body (`readGraphBody(...).content.nodeAuthority`), never a
 * hand-built section: an expected side built here could only restate what the reader did.
 *
 * REFUSALS ARE ASSERTED THREE DEEP. `graph-body -> active-graph-projection -> this reader`
 * is a real three-layer stack, so a passthrough arm pins the reader's own layer, the
 * projection's code AND layer, and — where the projection was itself wrapping — the
 * graph-body source code and layer beside them. Asserting only "refused" would stay green
 * if the projection started answering for a different reason.
 */

import { describe, expect, it } from "vitest";

import { ACTIVE_GRAPH_PROJECTION_LAYER } from "./active-graph-projection.js";
import { GRAPH_BODY_RECORD_LAYER, readGraphBody } from "./graph-body-record.js";
import {
  PRIMARY,
  PROJECT_ID,
  SECONDARY,
  seedActive,
  seedActiveWithoutBody,
  withStore,
} from "./graph-query-test-fixtures.js";
import {
  NODE_CLOSURE_READER_CODES,
  nodeClosureOf,
  readCurrentNodeClosure,
} from "./node-closure-reader.js";
import type { NodeClosure } from "./node-closure-reader.js";

/** The seeded snapshot's completion node — the one carrying two HARD predecessors. */
const JOIN_NODE = "dev-c";
const SEEDED_NODE_KEYS = ["dev-a", "dev-b", "dev-c"] as const;

/** The durable read-back of the seeded body: the anti-tautology operand for arm 1. */
function storedSection(store: Parameters<typeof readGraphBody>[0]) {
  const body = readGraphBody(store, PROJECT_ID, PRIMARY.graphContentHash);
  if (!body.ok) throw new Error(`fixture body unreadable: ${body.code}`);
  return body.content.nodeAuthority;
}

function acceptedOrThrow(result: ReturnType<typeof readCurrentNodeClosure>): NodeClosure {
  if (!result.ok) throw new Error(`closure refused: ${result.code}@${result.layer}`);
  return result;
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

/**
 * Every refusal world this suite drives, and the codes each must produce. Hand-written —
 * an expected side derived from the reader's own output could not constrain it.
 */
const REFUSAL_CASES = [
  {
    code: "ACTIVE_GRAPH_ABSENT",
    name: "an unseeded project",
    seed: () => undefined,
    sourceCode: null,
    sourceLayer: null,
  },
  {
    code: "ACTIVE_GRAPH_SPLIT_BRAIN",
    name: "two ACTIVE revisions",
    seed: (store: Parameters<typeof readGraphBody>[0]) => {
      seedActive(store, "graph-revision-1", PRIMARY);
      seedActive(store, "graph-revision-9", SECONDARY);
    },
    sourceCode: null,
    sourceLayer: null,
  },
  {
    code: "ACTIVE_GRAPH_BODY_UNAVAILABLE",
    name: "a revision whose body record is absent",
    seed: (store: Parameters<typeof readGraphBody>[0]) => {
      seedActiveWithoutBody(store, "graph-revision-1");
    },
    sourceCode: "GRAPH_BODY_ABSENT",
    sourceLayer: GRAPH_BODY_RECORD_LAYER,
  },
] as const;

/** Filled by the swept arms; the sweep-executed control reads it. */
const observedRefusals: string[] = [];

describe("readCurrentNodeClosure", () => {
  it("answers the seeded body's own node-authority section, verbatim", () => {
    withStore("closure-happy", (store) => {
      seedActive(store);
      const read = acceptedOrThrow(readCurrentNodeClosure(store, PROJECT_ID));
      const stored = storedSection(store);

      expect(read.authorities).toEqual(stored.authorities);
      expect(read.definitions).toEqual(stored.definitions);
      expect(read.graphContentHash).toBe(PRIMARY.graphContentHash);
      expect(read.revisionId).toBe("graph-revision-1");
    });
  });

  it("keeps authorities and definitions index-aligned as the codec sealed them", () => {
    withStore("closure-aligned", (store) => {
      seedActive(store);
      const read = acceptedOrThrow(readCurrentNodeClosure(store, PROJECT_ID));

      expect(read.definitions).toHaveLength(SEEDED_NODE_KEYS.length);
      expect(read.authorities.map((entry) => entry.nodeKey)).toEqual([...SEEDED_NODE_KEYS]);
      expect(read.definitions.map((definition) => definition.nodeKey))
        .toEqual(read.authorities.map((entry) => entry.nodeKey));
    });
  });

  it("hands back a deeply frozen result", () => {
    withStore("closure-frozen", (store) => {
      seedActive(store);
      const read = acceptedOrThrow(readCurrentNodeClosure(store, PROJECT_ID));

      expect(Object.isFrozen(read)).toBe(true);
      expect(deeplyFrozen(read)).toBe(true);
    });
  });

  it.each(REFUSAL_CASES)(
    "refuses $name with $code, attributed to the layer that produced it",
    ({ code, seed, sourceCode, sourceLayer }) => {
      withStore(`closure-${code}`, (store) => {
        seed(store);
        const read = readCurrentNodeClosure(store, PROJECT_ID);

        expect(read.ok).toBe(false);
        if (read.ok) throw new Error("expected a refusal");
        observedRefusals.push(read.code);

        expect(read.code).toBe(code);
        expect(read.layer).toBe("NODE_CLOSURE_READER");
        expect(read.authority).toBe("NONE");
        expect(read.outcome).toBe("UNKNOWN");
        expect(read.upstream).toEqual({
          code, layer: ACTIVE_GRAPH_PROJECTION_LAYER, sourceCode, sourceLayer,
        });
        // UNKNOWN never becomes an empty closure.
        expect(read).not.toHaveProperty("authorities");
        expect(read).not.toHaveProperty("definitions");
      });
    },
  );

  it("drove every declared refusal world", () => {
    expect(REFUSAL_CASES).toHaveLength(3);
    expect(observedRefusals).toHaveLength(3);
    expect([...observedRefusals].sort()).toEqual([
      "ACTIVE_GRAPH_ABSENT",
      "ACTIVE_GRAPH_BODY_UNAVAILABLE",
      "ACTIVE_GRAPH_SPLIT_BRAIN",
    ]);
  });
});

describe("nodeClosureOf", () => {
  it("answers a seeded node's definition and authority hash verbatim", () => {
    withStore("closure-node", (store) => {
      seedActive(store);
      const read = acceptedOrThrow(readCurrentNodeClosure(store, PROJECT_ID));
      const stored = storedSection(store);
      const index = stored.definitions.findIndex((entry) => entry.nodeKey === JOIN_NODE);
      const definition = stored.definitions[index];
      const authority = stored.authorities[index];
      if (definition === undefined || authority === undefined) {
        throw new Error(`fixture lost ${JOIN_NODE}`);
      }

      const entry = nodeClosureOf(read, JOIN_NODE);
      expect(entry.ok).toBe(true);
      if (!entry.ok) throw new Error("expected the seeded node");

      expect(entry.definition).toEqual(definition);
      expect(entry.nodeAuthorityHash).toBe(authority.nodeAuthorityHash);
      expect(entry.definition.directHardDependencies)
        .toEqual(definition.directHardDependencies);
      expect(entry.definition.directHardDependencies.length).toBeGreaterThan(0);
      expect(entry.definition.monotonicPredicateProofs)
        .toEqual(definition.monotonicPredicateProofs);
      expect(entry.definition.monotonicPredicateProofs.length).toBeGreaterThan(0);
    });
  });

  it("refuses an unknown node key rather than answering an empty definition", () => {
    withStore("closure-unknown-node", (store) => {
      seedActive(store);
      const read = acceptedOrThrow(readCurrentNodeClosure(store, PROJECT_ID));

      const entry = nodeClosureOf(read, "dev-absent");
      expect(entry.ok).toBe(false);
      if (entry.ok) throw new Error("expected a refusal");

      expect(entry.code).toBe("NODE_CLOSURE_NODE_UNKNOWN");
      expect(entry.layer).toBe("NODE_CLOSURE_READER");
      expect(entry.authority).toBe("NONE");
      expect(entry.outcome).toBe("UNKNOWN");
      expect(entry.detail).toContain("dev-absent");
      // The reader minted this one; nothing upstream refused.
      expect(entry.upstream).toBeNull();
      expect(entry).not.toHaveProperty("definition");
      expect(entry).not.toHaveProperty("nodeAuthorityHash");
    });
  });

  it("mints exactly one code of its own; every other refusal is a passthrough", () => {
    expect(NODE_CLOSURE_READER_CODES).toEqual(["NODE_CLOSURE_NODE_UNKNOWN"]);
    expect(Object.isFrozen(NODE_CLOSURE_READER_CODES)).toBe(true);
  });
});
