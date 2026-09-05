/**
 * THE ACTIVE GRAPH READ: POST /graph/get with EXACTLY `{}`. CSRF, Origin and the
 * session credential are the same headers every other JSON read already sends
 * (checkHeaders runs for GRAPH_GET_PATH). Empty body is the documented normal
 * call (graph-query.ts: an empty body names no project). Capability is
 * planning.write, which the paired operator session already holds.
 *
 * READS ONLY. Exact-key snapshots at every level, same discipline as
 * live-repository-remote.ts. A snapshot member the daemon adds that this decoder
 * does not name is an ERROR, never a silently truncated graph.
 */

const LIVE_GRAPH_GET_LAYER = "CONTROL_ROOM_LIVE_GRAPH_GET";
const INVALID_RESPONSE_CODE = "GRAPH_GET_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const GRAPH_GET_PATH = "/graph/get";
const REQUEST_TIMEOUT_MS = 15_000;

export const GRAPH_GET_FRAME_KEYS = [
  "graphContentHash", "graphEpoch", "ok", "planHash", "provenance", "revisionId",
  "snapshot", "snapshotIdentity",
] as const;
export const GRAPH_GET_PROVENANCE_KEYS = ["aggregateId", "goalRef"] as const;
export const GRAPH_GET_SNAPSHOT_KEYS = ["completionNodeKey", "edges", "nodes"] as const;
const NODE_KEYS = ["executionBearing", "nodeKey"] as const;
const EDGE_KEYS = ["consumerNodeKey", "edgeKey", "kind", "producerNodeKey"] as const;

export interface GraphGetNodeView {
  readonly executionBearing: boolean;
  readonly nodeKey: string;
}
export interface GraphGetEdgeView {
  readonly consumerNodeKey: string;
  readonly edgeKey: string;
  readonly kind: "ADVISORY" | "HARD";
  readonly producerNodeKey: string;
}
export interface GraphGetSnapshotView {
  readonly completionNodeKey: string;
  readonly edges: readonly GraphGetEdgeView[];
  readonly nodes: readonly GraphGetNodeView[];
}
export interface GraphGetProvenanceView {
  readonly aggregateId: string;
  readonly goalRef: string;
}
export type GraphGetOutcome =
  | {
    readonly status: "GRAPH";
    readonly graphContentHash: string;
    readonly graphEpoch: number;
    readonly planHash: string;
    readonly provenance: GraphGetProvenanceView;
    readonly revisionId: string;
    readonly snapshot: GraphGetSnapshotView;
    readonly snapshotIdentity: string;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): GraphGetOutcome =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): GraphGetOutcome =>
  Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): GraphGetOutcome => errored(INVALID_RESPONSE_CODE, LIVE_GRAPH_GET_LAYER);

function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function refusalFrom(response: unknown): GraphGetOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const query = exactDataRecord(response, ["code", "httpStatus", "layer", "ok"]);
  if (query !== null && query.ok === false && typeof query.code === "string"
    && typeof query.layer === "string") {
    return refused(query.code, query.layer);
  }
  const projection = exactDataRecord(response, ["code", "layer", "ok", "sourceCode", "sourceLayer"]);
  if (projection !== null && projection.ok === false && typeof projection.code === "string"
    && typeof projection.layer === "string") {
    return refused(projection.code, projection.layer);
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED" || typeof http.stage !== "string") {
    return null;
  }
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function nodeOf(value: unknown): GraphGetNodeView | null {
  const record = exactDataRecord(value, NODE_KEYS);
  if (record === null || typeof record.executionBearing !== "boolean" || !nonEmptyString(record.nodeKey)) {
    return null;
  }
  return Object.freeze({ executionBearing: record.executionBearing, nodeKey: record.nodeKey });
}

function edgeOf(value: unknown): GraphGetEdgeView | null {
  const record = exactDataRecord(value, EDGE_KEYS);
  if (record === null || !nonEmptyString(record.consumerNodeKey) || !nonEmptyString(record.edgeKey)
    || !nonEmptyString(record.producerNodeKey)
    || (record.kind !== "HARD" && record.kind !== "ADVISORY")) {
    return null;
  }
  return Object.freeze({
    consumerNodeKey: record.consumerNodeKey, edgeKey: record.edgeKey,
    kind: record.kind, producerNodeKey: record.producerNodeKey,
  });
}

function listOf<T>(value: unknown, map: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const mapped = map(item);
    if (mapped === null) return null;
    items.push(mapped);
  }
  return Object.freeze(items);
}

function snapshotOf(value: unknown): GraphGetSnapshotView | null {
  const record = exactDataRecord(value, GRAPH_GET_SNAPSHOT_KEYS);
  if (record === null || !nonEmptyString(record.completionNodeKey)) return null;
  const nodes = listOf(record.nodes, nodeOf);
  const edges = listOf(record.edges, edgeOf);
  if (nodes === null || edges === null) return null;
  return Object.freeze({ completionNodeKey: record.completionNodeKey, edges, nodes });
}

function provenanceOf(value: unknown): GraphGetProvenanceView | null {
  const record = exactDataRecord(value, GRAPH_GET_PROVENANCE_KEYS);
  if (record === null || !nonEmptyString(record.aggregateId) || !nonEmptyString(record.goalRef)) {
    return null;
  }
  return Object.freeze({ aggregateId: record.aggregateId, goalRef: record.goalRef });
}

export function mapGraphGetAnswer(status: number, response: unknown): GraphGetOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, GRAPH_GET_FRAME_KEYS);
  if (record === null || record.ok !== true || typeof record.graphEpoch !== "number"
    || !nonEmptyString(record.graphContentHash) || !nonEmptyString(record.planHash)
    || !nonEmptyString(record.revisionId) || !nonEmptyString(record.snapshotIdentity)) {
    return invalidResponse();
  }
  const provenance = provenanceOf(record.provenance);
  const snapshot = snapshotOf(record.snapshot);
  if (provenance === null || snapshot === null) return invalidResponse();
  return Object.freeze({
    graphContentHash: record.graphContentHash, graphEpoch: record.graphEpoch,
    planHash: record.planHash, provenance, revisionId: record.revisionId, snapshot,
    snapshotIdentity: record.snapshotIdentity, status: "GRAPH" as const,
  });
}

export async function readGraphGet(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<GraphGetOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(GRAPH_GET_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send("{}");
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_GRAPH_GET_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapGraphGetAnswer(response.status, body);
}
