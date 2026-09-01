/**
 * Canonical wire format for {@link ./graph-content.ts}: the exact bytes, the
 * canonical serializers, the projections and the strict reads that admit them.
 * Split out to keep each production source inside the per-file line cap, and
 * internal — the root publishes the codec boundary, never these mechanics, because
 * a caller reaching `canonicalGraphJson` could mint never-validated bytes.
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
import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "./runtime-shape.js";
import { NODE_AUTHORITY_LIMITS, canonicalText } from "./node-authority/node-authority-contract.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import type {
  ContentFields, GraphRevisionContent, NodeAuthoritySection,
} from "./graph-content-fields.js";

/**
 * The exact tag serialized into the envelope. Never reworded silently. `/3`
 * (task-6ba1ff89393c4a2b91e11df06c31b873) because the envelope now authenticates
 * every node's ADMITTED definition and dependency contracts, not just the
 * `{nodeKey, executionBearing}` rows: v1 hashed structure alone under the name
 * `graphContentHash`, v2 covered the seven design-197 fields but authenticated no
 * body. Reinterpreting either under v3 rules is how a weaker identity survives
 * disguised as the stronger one, so the bump is load-bearing — v1/v2 bytes decode
 * to `GRAPH_CONTENT_UNSUPPORTED_SCHEMA` and nothing else.
 */
export const SCHEMA_TAG = "MOE-GRAPH-CONTENT/3";
/**
 * Separate from {@link SCHEMA_TAG} and the content-hash domain on purpose: strings
 * shared between a digest domain and a wire tag cannot rotate apart, and a
 * STRUCTURAL domain sharing the CONTENT domain's string could mint the one value
 * dec-64b2391c forbids — a structural identity indistinguishable from authority.
 */
export const SNAPSHOT_IDENTITY_DOMAIN = "MOE-GRAPH-SNAPSHOT-IDENTITY/1";

const HEX_64 = /^[0-9a-f]{64}$/u;
const ENVELOPE_KEYS = Object.freeze(["schema", "hash", "content"] as const);

/**
 * Derived from the kernel's absolute ceilings, not guessed, so raising a graph
 * bound cannot leave the codec unable to decode a graph the validator accepts.
 * Each allowance covers one key's JSON punctuation and field name, with slack; the
 * six scalar fields are each bounded by `isGraphKey`'s ceiling or shorter.
 */
const NODE_RECORD_ALLOWANCE = 48;
const EDGE_RECORD_ALLOWANCE = 96;
const ENVELOPE_ALLOWANCE = 1024;
const CONTENT_FIELD_COUNT = 6;
const CONTENT_FIELD_ALLOWANCE =
  CONTENT_FIELD_COUNT * (MAX_GRAPH_KEY_CODE_UNITS + 64);
/**
 * The v3 section, derived from the NODE codec's own ceiling: `createNodeDefinition`
 * refuses any body past `NODE_AUTHORITY_LIMITS.maxBytes` (1_048_576), and one node
 * carries at most one body plus one `{nodeAuthorityHash, nodeKey}` pair. Measured:
 * 64 * (1_048_576 + 256) = 67_125_248, total 74_880 + 67_125_248 = 67_200_128.
 * Deliberately an upper bound on what ENCODE can mint — a lower ceiling would let
 * this codec produce bytes it then refuses to read back, the incoherence
 * `node-authority-codec.ts` refuses for a single body.
 */
const AUTHORITY_RECORD_ALLOWANCE = MAX_GRAPH_KEY_CODE_UNITS + 128;
const NODE_AUTHORITY_SECTION_ALLOWANCE =
  ABSOLUTE_MAX_GRAPH_NODES
  * (NODE_AUTHORITY_LIMITS.maxBytes + AUTHORITY_RECORD_ALLOWANCE);
export const MAX_GRAPH_CONTENT_BYTES =
  ENVELOPE_ALLOWANCE
  + CONTENT_FIELD_ALLOWANCE
  + NODE_AUTHORITY_SECTION_ALLOWANCE
  + ABSOLUTE_MAX_GRAPH_NODES * (MAX_GRAPH_KEY_CODE_UNITS + NODE_RECORD_ALLOWANCE)
  + ABSOLUTE_MAX_GRAPH_TOTAL_EDGES
    * (3 * MAX_GRAPH_KEY_CODE_UNITS + EDGE_RECORD_ALLOWANCE);

/**
 * The kernel's IMMUTABLE parser ceilings, never the default policy: content identity
 * is policy-free, so DECODABILITY must be too. Judging a decode under today's default
 * would strand bytes encoded under a legally raised override and un-read stored
 * content whenever a default was lowered. These are the widest any legal override can
 * reach (`resolveGraphPolicy` refuses more), so this admits exactly the graphs some
 * legal policy could have admitted; whether one is acceptable TODAY is the caller's.
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
  readonly content: unknown;
}

/** Every leaf here is already proven by `validateGraphSnapshot`, so nothing
 * unrepresentable can vanish from the bytes an identity digest must cover. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** The canonical node/edge set alone, split out so the content digest can frame it
 * as ONE field with no second definition of structural canonicalisation. */
export function canonicalSnapshotJson(graph: ValidatedGraph): string {
  const nodes = graph.nodes.map((node) =>
    `{"nodeKey":${quote(node.nodeKey)},"executionBearing":`
    + `${node.executionBearing ? "true" : "false"}}`);
  const edges = graph.edges.map((edge) =>
    `{"edgeKey":${quote(edge.edgeKey)},"producerNodeKey":`
    + `${quote(edge.producerNodeKey)},"consumerNodeKey":`
    + `${quote(edge.consumerNodeKey)},"kind":${quote(edge.kind)}}`);
  return `{"nodes":[${nodes.join(",")}],"edges":[${edges.join(",")}],`
    + `"completionNodeKey":${quote(graph.completionNodeKey)}}`;
}

/**
 * Canonicalized by the NODE authority layer's own serializer — composed, never
 * re-derived, since a second definition of a body's canonical text is a second
 * spelling free to drift. Key order inside is `canonicalText`'s (sorted); node ORDER
 * is fixed by the field reader, which admits only a strictly ascending `nodeKey`
 * sequence, so nothing here sorts and no reordering survives.
 */
export function canonicalNodeAuthorityJson(section: NodeAuthoritySection): string {
  return canonicalText({ authorities: section.authorities, definitions: section.definitions });
}

/** Canonical content JSON: declared key order, no whitespace, absence explicit. */
export function canonicalContentJson(
  graph: ValidatedGraph, fields: ContentFields,
): string {
  const parent = fields.parentRevision === null ? "null" : quote(fields.parentRevision);
  return `{"author":${quote(fields.author)},"completionNode":`
    + `${quote(fields.completionNode)},"decompositionBudget":`
    + `${fields.decompositionBudget},"nodeAuthority":`
    + `${canonicalNodeAuthorityJson(fields.nodeAuthority)},`
    + `"parentRevision":${parent},`
    + `"policyRevision":${quote(fields.policyRevision)},`
    + `"repositoryBaseTree":${quote(fields.repositoryBaseTree)},`
    + `"snapshot":${canonicalSnapshotJson(graph)}}`;
}

/** The wire envelope around an already-canonical content record. */
export function canonicalGraphJson(hash: string, contentJson: string): string {
  return `{"schema":${quote(SCHEMA_TAG)},"hash":${quote(hash)},`
    + `"content":${contentJson}}`;
}

/**
 * The graph's STRUCTURE only, as `graphIdentity` defines it — NOT content identity,
 * never handed to a consumer asking for `graphContentHash`, which covers seven
 * further fields this knows nothing about (dec-64b2391c). Domain-separated and
 * length-framed so it cannot collide with a differently-domained payload.
 */
export function snapshotIdentityHash(graph: ValidatedGraph): string {
  const identity = graph.graphIdentity;
  return createHash("sha256")
    .update(`${SNAPSHOT_IDENTITY_DOMAIN}\n${identity.length}:`, "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

/** The frozen answer, assembled in declared key order for a stable `Object.keys`. */
export function projectContent(
  snapshot: GraphSnapshot, fields: ContentFields,
): GraphRevisionContent {
  return Object.freeze({
    author: fields.author,
    completionNode: fields.completionNode,
    decompositionBudget: fields.decompositionBudget,
    nodeAuthority: fields.nodeAuthority,
    parentRevision: fields.parentRevision,
    policyRevision: fields.policyRevision,
    repositoryBaseTree: fields.repositoryBaseTree,
    snapshot,
  });
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

/** Accepts only a genuine Uint8Array (a Buffer qualifies) and copies it at once:
 * `Buffer.prototype.slice` returns an aliasing view, and a caller still writing
 * into its own buffer must not change bytes this decoder already judged. */
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

/** Key ORDER is deliberately unchecked: a reordered-but-complete envelope is a
 * second spelling of the same content, which the byte re-encode already rejects. */
export function readContentEnvelope(value: unknown): GraphContentEnvelope | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, ENVELOPE_KEYS)) {
    return null;
  }
  const schema = readOwnDataProperty(value, "schema");
  const hash = readOwnDataProperty(value, "hash");
  const content = readOwnDataProperty(value, "content");
  if (!schema.ok || !schema.present || typeof schema.value !== "string") {
    return null;
  }
  if (!hash.ok || !hash.present || typeof hash.value !== "string"
    || !HEX_64.test(hash.value)) {
    return null;
  }
  if (!content.ok || !content.present) {
    return null;
  }
  return { schema: schema.value, hash: hash.value, content: content.value };
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
