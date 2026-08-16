/**
 * Canonical wire format for {@link ./graph-content.ts}: the exact bytes, the
 * domain-separated digest, and the strict reads that admit them.
 *
 * Split out of `graph-content.ts` purely to keep each production source inside
 * the per-file line cap. It is internal — the package root publishes the codec
 * boundary, never these mechanics, because a consumer able to call
 * `canonicalGraphJson` directly could mint bytes that never passed validation.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  MAX_GRAPH_KEY_CODE_UNITS,
  MIN_GATED_DESCENDANTS_FOR_REVIEW,
} from "./graph-policy.js";
import {
  hasOnlyOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
} from "./runtime-shape.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";

/** The exact tag serialized into the envelope. Never reworded silently. */
export const SCHEMA_TAG = "MOE-GRAPH-CONTENT/1";
/**
 * Separate from {@link SCHEMA_TAG} on purpose: a digest domain and a wire tag
 * that share one string cannot be rotated independently.
 */
const HASH_DOMAIN = "MOE-GRAPH-CONTENT-HASH/1";

const HEX_64 = /^[0-9a-f]{64}$/u;
const ENVELOPE_KEYS = Object.freeze(["schema", "hash", "snapshot"] as const);

/**
 * Derived from the kernel's own absolute ceilings rather than guessed, so
 * raising a graph bound cannot silently leave the codec unable to decode a
 * graph the validator would accept. Each allowance covers the fixed JSON
 * punctuation and field names around one key, with slack.
 */
const NODE_RECORD_ALLOWANCE = 48;
const EDGE_RECORD_ALLOWANCE = 96;
const ENVELOPE_ALLOWANCE = 1024;
export const MAX_GRAPH_CONTENT_BYTES =
  ENVELOPE_ALLOWANCE
  + ABSOLUTE_MAX_GRAPH_NODES * (MAX_GRAPH_KEY_CODE_UNITS + NODE_RECORD_ALLOWANCE)
  + ABSOLUTE_MAX_GRAPH_TOTAL_EDGES
    * (3 * MAX_GRAPH_KEY_CODE_UNITS + EDGE_RECORD_ALLOWANCE);

/**
 * The decoder validates against the kernel's IMMUTABLE parser ceilings, never
 * against the default policy.
 *
 * Content identity is policy-free, so which graphs are DECODABLE must be
 * policy-free too. Validating a decode under the default policy would mean
 * bytes encoded under a legally raised override could not be read back, and
 * worse, that lowering a default later would silently strand content already
 * stored — a durable record must not stop being readable because a limit moved.
 * These ceilings are the widest any legal override can reach (`resolveGraphPolicy`
 * refuses anything above them), so this admits exactly the graphs some legal
 * policy could have admitted, and not one more. Deciding whether a decoded graph
 * is acceptable under TODAY's policy stays with the caller.
 */
export const DECODE_POLICY = Object.freeze({
  maxNodes: ABSOLUTE_MAX_GRAPH_NODES,
  maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  minGatedDescendantsForReview: MIN_GATED_DESCENDANTS_FOR_REVIEW,
});

export interface GraphContentEnvelope {
  readonly schema: string;
  readonly hash: string;
  readonly snapshot: unknown;
}

/**
 * Every leaf reaching this serializer is already proven by
 * `validateGraphSnapshot` — a GraphKey is a bounded ASCII string, and
 * `executionBearing`/`kind` are closed — so nothing unrepresentable can slip in
 * and silently vanish from the bytes an identity digest is supposed to cover.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}

export function canonicalGraphJson(hash: string, graph: ValidatedGraph): string {
  const nodes = graph.nodes.map((node) =>
    `{"nodeKey":${quote(node.nodeKey)},"executionBearing":`
    + `${node.executionBearing ? "true" : "false"}}`);
  const edges = graph.edges.map((edge) =>
    `{"edgeKey":${quote(edge.edgeKey)},"producerNodeKey":`
    + `${quote(edge.producerNodeKey)},"consumerNodeKey":`
    + `${quote(edge.consumerNodeKey)},"kind":${quote(edge.kind)}}`);
  return `{"schema":${quote(SCHEMA_TAG)},"hash":${quote(hash)},"snapshot":`
    + `{"nodes":[${nodes.join(",")}],"edges":[${edges.join(",")}],`
    + `"completionNodeKey":${quote(graph.completionNodeKey)}}}`;
}

/**
 * Domain-separated and length-framed: the framing stops one `graphIdentity`
 * from colliding with a differently-domained payload sharing a suffix.
 */
export function graphContentHash(graph: ValidatedGraph): string {
  const identity = graph.graphIdentity;
  return createHash("sha256")
    .update(`${HASH_DOMAIN}\n${identity.length}:`, "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

export function projectGraphSnapshot(graph: ValidatedGraph): GraphSnapshot {
  return Object.freeze({
    nodes: Object.freeze(graph.nodes.map((node) => Object.freeze({
      nodeKey: node.nodeKey, executionBearing: node.executionBearing,
    }))),
    edges: Object.freeze(graph.edges.map((edge) => Object.freeze({
      edgeKey: edge.edgeKey,
      producerNodeKey: edge.producerNodeKey,
      consumerNodeKey: edge.consumerNodeKey,
      kind: edge.kind,
    }))),
    completionNodeKey: graph.completionNodeKey,
  });
}

/**
 * Accepts only a genuine Uint8Array (a Buffer qualifies) and copies it at once.
 * Copying first is what makes every later read safe: `Buffer.prototype.slice`
 * returns an aliasing view, and a caller still writing into its own buffer must
 * not be able to change bytes this decoder has already judged.
 */
export function readContentBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    if (types.isProxy(value) || !types.isUint8Array(value)) {
      return null;
    }
    return new Uint8Array(value);
  } catch {
    return null;
  }
}

/**
 * Key ORDER is deliberately not checked here. A reordered-but-complete envelope
 * is a second authoritative spelling of the same content, and the byte
 * re-encode comparison already rejects it — one mechanism, not two.
 */
export function readContentEnvelope(value: unknown): GraphContentEnvelope | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, ENVELOPE_KEYS)) {
    return null;
  }
  const schema = readOwnDataProperty(value, "schema");
  const hash = readOwnDataProperty(value, "hash");
  const snapshot = readOwnDataProperty(value, "snapshot");
  if (!schema.ok || !schema.present || typeof schema.value !== "string") {
    return null;
  }
  if (!hash.ok || !hash.present || typeof hash.value !== "string"
    || !HEX_64.test(hash.value)) {
    return null;
  }
  if (!snapshot.ok || !snapshot.present) {
    return null;
  }
  return { schema: schema.value, hash: hash.value, snapshot: snapshot.value };
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
