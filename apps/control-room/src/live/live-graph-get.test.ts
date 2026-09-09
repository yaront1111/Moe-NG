import { describe, expect, it } from "vitest";

import {
  GRAPH_GET_FRAME_KEYS, GRAPH_GET_PROVENANCE_KEYS, GRAPH_GET_SNAPSHOT_KEYS,
  mapGraphGetAnswer, readGraphGet,
} from "./live-graph-get.js";

/**
 * Envelope keys of POST /graph/get as GraphQueryAccepted states them
 * (graph-query.ts GraphQueryAccepted). Nested snapshot/provenance keys follow
 * GraphSnapshot and ActiveGraphProvenance. A fixture that adds a key must red.
 */
const NODE = Object.freeze({ executionBearing: true, nodeKey: "n1" });
const EDGE = Object.freeze({
  consumerNodeKey: "n2", edgeKey: "e1", kind: "HARD", producerNodeKey: "n1",
});
const SNAPSHOT = Object.freeze({
  completionNodeKey: "n2", edges: [EDGE], nodes: [NODE, { executionBearing: false, nodeKey: "n2" }],
});
const PROVENANCE = Object.freeze({ aggregateId: "agg-1", goalRef: "goal-1" });
const ACCEPTED = Object.freeze({
  graphContentHash: "aa".repeat(32), graphEpoch: 1, ok: true, planHash: "bb".repeat(32),
  provenance: PROVENANCE, revisionId: "graph-revision-1", snapshot: SNAPSHOT,
  snapshotIdentity: "cc".repeat(32),
});

const response = (status: number, body: unknown): Response =>
  ({ json: async () => body, status } as unknown as Response);

describe("mapGraphGetAnswer", () => {
  it("pins the daemon envelope so a shape drift cannot pass silently", () => {
    expect([...GRAPH_GET_FRAME_KEYS]).toStrictEqual([
      "graphContentHash", "graphEpoch", "ok", "planHash", "provenance", "revisionId",
      "snapshot", "snapshotIdentity",
    ]);
    expect(Object.keys(ACCEPTED).sort()).toStrictEqual([...GRAPH_GET_FRAME_KEYS].sort());
    expect([...GRAPH_GET_PROVENANCE_KEYS]).toStrictEqual(["aggregateId", "goalRef"]);
    expect([...GRAPH_GET_SNAPSHOT_KEYS]).toStrictEqual(["completionNodeKey", "edges", "nodes"]);
  });

  it("maps the accepted frame verbatim, including nested snapshot members", () => {
    expect(mapGraphGetAnswer(200, ACCEPTED)).toStrictEqual({
      graphContentHash: ACCEPTED.graphContentHash, graphEpoch: 1, planHash: ACCEPTED.planHash,
      provenance: PROVENANCE, revisionId: "graph-revision-1", snapshot: SNAPSHOT,
      snapshotIdentity: ACCEPTED.snapshotIdentity, status: "GRAPH",
    });
  });

  it("REFUSES a frame with an extra key or a missing key, at envelope and inside snapshot", () => {
    const extra = mapGraphGetAnswer(200, { ...ACCEPTED, credential: "secret" });
    expect(extra).toStrictEqual({
      code: "GRAPH_GET_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_GRAPH_GET", status: "ERROR",
    });
    const { planHash: _dropped, ...missing } = ACCEPTED;
    expect(mapGraphGetAnswer(200, missing).status).toBe("ERROR");
    expect(mapGraphGetAnswer(200, {
      ...ACCEPTED, snapshot: { ...SNAPSHOT, extra: true },
    }).status).toBe("ERROR");
    expect(mapGraphGetAnswer(200, { ...ACCEPTED, ok: false }).status).toBe("ERROR");
    expect(mapGraphGetAnswer(500, ACCEPTED).status).toBe("ERROR");
  });

  it("carries the daemon refusal code and layer through each refusal shape", () => {
    expect(mapGraphGetAnswer(200, {
      code: "GRAPH_QUERY_CAPABILITY_DENIED", httpStatus: 403, layer: "GRAPH_QUERY", ok: false,
    })).toStrictEqual({
      code: "GRAPH_QUERY_CAPABILITY_DENIED", layer: "GRAPH_QUERY", status: "REFUSED",
    });
    expect(mapGraphGetAnswer(200, {
      code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION", ok: false,
      sourceCode: null, sourceLayer: null,
    })).toStrictEqual({
      code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION", status: "REFUSED",
    });
    expect(mapGraphGetAnswer(400, {
      code: "LISTENER_GRAPH_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
    })).toStrictEqual({
      code: "LISTENER_GRAPH_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED",
    });
    expect(mapGraphGetAnswer(401, {
      error: { code: "AUTHENTICATION_FAILED" }, httpStatus: 401, ok: false, outcome: "REFUSED",
      stage: "AUTHENTICATE",
    })).toStrictEqual({ code: "AUTHENTICATION_FAILED", layer: "AUTHENTICATE", status: "REFUSED" });
  });
});

describe("readGraphGet", () => {
  it("POSTs exactly {} and maps the reply", async () => {
    const bodies: string[] = [];
    const outcome = await readGraphGet({ "x-moe-session": "s" }, async (body) => {
      bodies.push(body);
      return response(200, ACCEPTED);
    });
    expect(bodies).toStrictEqual(["{}"]);
    expect(outcome.status).toBe("GRAPH");
  });

  it("names TRANSPORT_REQUEST_FAILED when the request never reached the daemon", async () => {
    await expect(readGraphGet({}, async () => { throw new Error("offline"); })).resolves.toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_GRAPH_GET", status: "ERROR",
    });
  });
});
