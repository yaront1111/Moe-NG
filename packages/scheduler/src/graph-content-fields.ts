/**
 * The seven `GraphRevisionContent` fields of design line 197, their bounds, their
 * canonical serialization, and the domain-separated digest that covers ALL of
 * them.
 *
 * Split out of `graph-content.ts`/`graph-content-format.ts` so neither crosses
 * the per-file line cap, and internal for the same reason those are: a consumer
 * able to call {@link graphContentDigest} directly could mint a content identity
 * for a snapshot the graph kernel never accepted. `encodeGraphContent` stays the
 * only route to a hash.
 *
 * WHY THIS EXISTS AT ALL. Before decision `dec-64b2391c` the package published a
 * `graphContentHash` computed over the graph's STRUCTURE alone — one of the seven
 * fields — under a name that claims authority over all of them. A durable
 * revision bound to that value would carry an identity omitting the repository
 * base tree, parent revision, policy revision, decomposition budget and author,
 * and would satisfy @moe/core's `validHex64` gate while doing it. The structural
 * value now has a structural name (`snapshotIdentity`) and this module owns the
 * only thing entitled to be called content.
 */
import { createHash } from "node:crypto";

import { isGraphKey } from "./graph-key.js";
import { ABSOLUTE_MAX_GRAPH_NODES } from "./graph-policy.js";
import { canonicalSnapshotJson } from "./graph-content-format.js";
import {
  hasOnlyOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
} from "./runtime-shape.js";
import type { GraphKey, GraphSnapshot, ValidatedGraph } from "./graph-model.js";

/**
 * Separate from the wire tag and from the snapshot-identity domain on purpose: a
 * digest domain that shares a string with either cannot be rotated on its own.
 * `/2` because the version-1 digest covered structure only.
 */
export const GRAPH_CONTENT_HASH_DOMAIN = "MOE-GRAPH-CONTENT-HASH/2";

/**
 * The declared field set, and the canonical serialization order — one list, so a
 * field cannot be declared without being serialized or hashed. Alphabetical
 * because it is the only order that needs no second definition to reproduce.
 */
export const GRAPH_REVISION_CONTENT_KEYS = Object.freeze([
  "author",
  "completionNode",
  "decompositionBudget",
  "parentRevision",
  "policyRevision",
  "repositoryBaseTree",
  "snapshot",
] as const);
export type GraphRevisionContentKey = (typeof GRAPH_REVISION_CONTENT_KEYS)[number];

/** A git tree id in either object format; the codec prefers neither. */
const HEX_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Design line 197's `GraphRevisionContent`. The canonical node/edge set arrives
 * as an unvalidated snapshot and is judged by `validateGraphSnapshot`, which
 * stays the single structural authority; `completionNode` is the author's
 * DECLARATION of the completion node and is reconciled against the graph the
 * kernel accepted, never trusted over it.
 */
export interface GraphRevisionContent {
  readonly author: string;
  readonly completionNode: GraphKey;
  readonly decompositionBudget: number;
  /** `null` for an initial revision — an explicit absence, not an empty ref. */
  readonly parentRevision: string | null;
  readonly policyRevision: string;
  readonly repositoryBaseTree: string;
  readonly snapshot: GraphSnapshot;
}

/** The six caller-stated fields, read once. `snapshot` travels separately. */
export interface ContentFields {
  readonly author: string;
  readonly completionNode: string;
  readonly decompositionBudget: number;
  readonly parentRevision: string | null;
  readonly policyRevision: string;
  readonly repositoryBaseTree: string;
}

export type ContentFieldsRead =
  | { readonly ok: true; readonly fields: ContentFields; readonly snapshot: unknown }
  | { readonly ok: false; readonly field: string };

function budgetOk(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= ABSOLUTE_MAX_GRAPH_NODES
  );
}

/**
 * Every field is read EXACTLY ONCE, through a data-property descriptor read that
 * refuses accessors outright: a getter answering differently between validation
 * and hashing would let hostile input be judged as one value and hashed as
 * another. The snapshot's VALUE is passed through unjudged — deciding it here
 * would take a verdict that belongs to the graph kernel.
 */
export function readContentFields(value: unknown): ContentFieldsRead {
  if (!isPlainRecord(value)
    || !hasOnlyOwnStringKeys(value, GRAPH_REVISION_CONTENT_KEYS)) {
    return { ok: false, field: "content" };
  }
  const read = new Map<string, unknown>();
  for (const key of GRAPH_REVISION_CONTENT_KEYS) {
    const property = readOwnDataProperty(value, key);
    if (!property.ok || !property.present) {
      return { ok: false, field: key };
    }
    read.set(key, property.value);
  }
  const author = read.get("author");
  const completionNode = read.get("completionNode");
  const budget = read.get("decompositionBudget");
  const parent = read.get("parentRevision");
  const policyRevision = read.get("policyRevision");
  const tree = read.get("repositoryBaseTree");
  if (!isGraphKey(author)) return { ok: false, field: "author" };
  if (!isGraphKey(completionNode)) return { ok: false, field: "completionNode" };
  if (!budgetOk(budget)) return { ok: false, field: "decompositionBudget" };
  if (parent !== null && !isGraphKey(parent)) {
    return { ok: false, field: "parentRevision" };
  }
  if (!isGraphKey(policyRevision)) return { ok: false, field: "policyRevision" };
  if (typeof tree !== "string" || !HEX_TREE.test(tree)) {
    return { ok: false, field: "repositoryBaseTree" };
  }
  return {
    ok: true,
    snapshot: read.get("snapshot"),
    fields: {
      author,
      completionNode,
      decompositionBudget: budget,
      parentRevision: parent,
      policyRevision,
      repositoryBaseTree: tree,
    },
  };
}

/**
 * The digest preimage, one entry per declared field, in the declared order. Each
 * entry is `(name, type tag, payload)`; the type tag is what keeps an absent
 * `parentRevision` distinct from any present ref rather than relying on the empty
 * string, which is not a representable ref in the first place.
 */
function preimageParts(
  graph: ValidatedGraph,
  fields: ContentFields,
): readonly (readonly [GraphRevisionContentKey, string, string])[] {
  return [
    ["author", "s", fields.author],
    ["completionNode", "s", fields.completionNode],
    ["decompositionBudget", "i", String(fields.decompositionBudget)],
    fields.parentRevision === null
      ? (["parentRevision", "z", ""] as const)
      : (["parentRevision", "s", fields.parentRevision] as const),
    ["policyRevision", "s", fields.policyRevision],
    ["repositoryBaseTree", "s", fields.repositoryBaseTree],
    // Composed, never re-derived: the validator's canonical ordering is the only
    // ordering serialized, so order independence is inherited.
    ["snapshot", "g", canonicalSnapshotJson(graph)],
  ];
}

function frame(token: string): string {
  return `${token.length}:${token}`;
}

/**
 * Domain-separated and length-framed per field, so no value can shift across a
 * field boundary to forge a different content with the same digest.
 *
 * The digest is fed the domain first and every declared field after it, so a
 * field removed from {@link preimageParts} is removed from the identity — which
 * is exactly what the per-field sweep in `graph-content.test.ts` catches.
 */
export function graphContentDigest(
  graph: ValidatedGraph,
  fields: ContentFields,
): string {
  const hasher = createHash("sha256");
  hasher.update(`${GRAPH_CONTENT_HASH_DOMAIN}\n`, "utf8");
  for (const [name, tag, payload] of preimageParts(graph, fields)) {
    hasher.update(frame(name) + frame(tag) + frame(payload), "utf8");
  }
  return hasher.digest("hex");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Canonical content JSON: declared key order, no whitespace, absence explicit. */
export function canonicalContentJson(
  graph: ValidatedGraph,
  fields: ContentFields,
): string {
  const parent = fields.parentRevision === null
    ? "null"
    : quote(fields.parentRevision);
  return `{"author":${quote(fields.author)},"completionNode":`
    + `${quote(fields.completionNode)},"decompositionBudget":`
    + `${fields.decompositionBudget},"parentRevision":${parent},`
    + `"policyRevision":${quote(fields.policyRevision)},`
    + `"repositoryBaseTree":${quote(fields.repositoryBaseTree)},`
    + `"snapshot":${canonicalSnapshotJson(graph)}}`;
}

/** The frozen answer, assembled in declared key order for a stable `Object.keys`. */
export function projectContent(
  snapshot: GraphSnapshot,
  fields: ContentFields,
): GraphRevisionContent {
  return Object.freeze({
    author: fields.author,
    completionNode: fields.completionNode,
    decompositionBudget: fields.decompositionBudget,
    parentRevision: fields.parentRevision,
    policyRevision: fields.policyRevision,
    repositoryBaseTree: fields.repositoryBaseTree,
    snapshot,
  });
}
