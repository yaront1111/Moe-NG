/**
 * The eight `GraphRevisionContent` fields of design lines 197 and 255: their bounds,
 * the strict reader that admits them, and the domain-separated digest covering ALL
 * of them. Split out of `graph-content.ts`/`graph-content-format.ts` so neither
 * crosses the per-file line cap, and internal for the same reason those are: a
 * consumer able to call {@link graphContentDigest} directly could mint a content
 * identity for a snapshot the graph kernel never accepted.
 *
 * WHY THIS EXISTS AT ALL. Before decision `dec-64b2391c` the package published a
 * `graphContentHash` computed over the graph's STRUCTURE alone — one of these
 * fields — under a name claiming authority over all of them. A revision bound to
 * that value would carry an identity omitting the repository base tree, parent
 * revision, policy revision, decomposition budget, author and — since v3 — every
 * node's admitted definition, while still satisfying @moe/core's `validHex64` gate.
 * The structural value now has a structural name (`snapshotIdentity`) and this
 * module owns the only thing entitled to be called content.
 */
import { createHash } from "node:crypto";

import { isGraphKey } from "./graph-key.js";
import { ABSOLUTE_MAX_GRAPH_NODES } from "./graph-policy.js";
import { canonicalNodeAuthorityJson, canonicalSnapshotJson } from "./graph-content-format.js";
import { canonicalText } from "./node-authority/node-authority-contract.js";
import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "./runtime-shape.js";
import type { GraphKey, GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import type { NodeDefinition } from "./node-authority/node-authority-contract.js";

/**
 * Separate from the wire tag and the snapshot-identity domain on purpose: a digest
 * domain sharing a string with either cannot rotate on its own. `/3`
 * (task-6ba1ff89393c4a2b91e11df06c31b873) because the v1 digest covered structure
 * only and v2 authenticated no node body — no v2 preimage is reproducible under v3.
 */
export const GRAPH_CONTENT_HASH_DOMAIN = "MOE-GRAPH-CONTENT-HASH/3";

/**
 * The declared field set, and the canonical serialization order — one list, so a
 * field cannot be declared without being serialized or hashed. Alphabetical
 * because it is the only order that needs no second definition to reproduce.
 */
export const GRAPH_REVISION_CONTENT_KEYS = Object.freeze([
  "author", "completionNode", "decompositionBudget", "nodeAuthority",
  "parentRevision", "policyRevision", "repositoryBaseTree", "snapshot",
] as const);
export type GraphRevisionContentKey = (typeof GRAPH_REVISION_CONTENT_KEYS)[number];

/** A git tree id in either object format; the codec prefers neither. */
const HEX_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SECTION_KEYS = Object.freeze(["authorities", "definitions"] as const);
const ENTRY_KEYS = Object.freeze(["nodeAuthorityHash", "nodeKey"] as const);

/** One node's derived authority, PAIRED with its key — the composer's own shape. */
export interface NodeAuthorityEntry {
  readonly nodeAuthorityHash: string;
  readonly nodeKey: string;
}

/**
 * Design 255's authenticated half of the content: every snapshot node's admitted
 * definition, beside the authority the production composer derives from it. The
 * lists are index-aligned and strictly ascending by `nodeKey`, so canonical order
 * is fixed at READ time and no reordering can spell one section twice.
 */
export interface NodeAuthoritySection {
  readonly authorities: readonly NodeAuthorityEntry[];
  readonly definitions: readonly NodeDefinition[];
}

/**
 * Design line 197's `GraphRevisionContent`, extended by design 255. The snapshot
 * arrives unvalidated and is judged by `validateGraphSnapshot`, the single
 * structural authority; `completionNode` is the author's DECLARATION and is
 * reconciled against the graph the kernel accepted, never trusted over it.
 */
export interface GraphRevisionContent {
  readonly author: string;
  readonly completionNode: GraphKey;
  readonly decompositionBudget: number;
  /** Mandatory since v3: `{nodeKey, executionBearing}` rows are structure, not
   * authority, so the definitions behind them travel inside the identity. */
  readonly nodeAuthority: NodeAuthoritySection;
  /** `null` for an initial revision — an explicit absence, not an empty ref. */
  readonly parentRevision: string | null;
  readonly policyRevision: string;
  readonly repositoryBaseTree: string;
  readonly snapshot: GraphSnapshot;
}

/** The seven caller-stated fields, read once. `snapshot` travels separately. */
export interface ContentFields {
  readonly author: string;
  readonly completionNode: string;
  readonly decompositionBudget: number;
  readonly nodeAuthority: NodeAuthoritySection;
  readonly parentRevision: string | null;
  readonly policyRevision: string;
  readonly repositoryBaseTree: string;
}

export type ContentFieldsRead =
  | { readonly ok: true; readonly fields: ContentFields; readonly snapshot: unknown }
  | { readonly ok: false; readonly field: string };

function budgetOk(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && !Object.is(value, -0) && value >= 0 && value <= ABSOLUTE_MAX_GRAPH_NODES;
}

/**
 * Canonicalized ONCE, then judged: `canonicalText` reads every property a single
 * time and re-parsing detaches the result, so no accessor can answer one value to
 * this reader and another to the composer, and nothing the caller still holds is
 * reachable from the record this codec goes on to hash. Every property below is a
 * plain data property by construction — what {@link readOwnDataProperty} buys the
 * other fields. Only SHAPE is decided here: one strictly ascending, index-aligned
 * pair per node. Whether a body is ADMISSIBLE, whether its contracts close, and what
 * each authority hash IS belong to the NodeAuthority composer; deciding any of it
 * twice would be a second semantics free to drift from the first.
 */
function readAuthoritySection(value: unknown): NodeAuthoritySection | null {
  let section: unknown;
  try {
    section = JSON.parse(canonicalText(value)) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(section) || !hasOnlyOwnStringKeys(section, SECTION_KEYS)) return null;
  const authorities = section["authorities"];
  const definitions = section["definitions"];
  if (!Array.isArray(authorities) || !Array.isArray(definitions)) return null;
  if (authorities.length === 0 || authorities.length !== definitions.length) return null;
  let previous = "";
  for (const [index, entry] of authorities.entries()) {
    if (!isPlainRecord(entry) || !hasOnlyOwnStringKeys(entry, ENTRY_KEYS)) return null;
    const hash = entry["nodeAuthorityHash"];
    const nodeKey = entry["nodeKey"];
    if (typeof hash !== "string" || !HEX_64.test(hash)) return null;
    // Strictly ascending, so a duplicate node key is refused HERE rather than
    // reaching the composer under a canonical order this codec never fixed.
    if (!isGraphKey(nodeKey) || nodeKey <= previous) return null;
    previous = nodeKey;
    const body = definitions[index];
    if (!isPlainRecord(body) || body["nodeKey"] !== nodeKey) return null;
  }
  return section as unknown as NodeAuthoritySection;
}

/**
 * Every field is read EXACTLY ONCE, through a data-property descriptor read that
 * refuses accessors outright: a getter answering differently between validation and
 * hashing would let hostile input be judged as one value and hashed as another. The
 * snapshot's VALUE passes through unjudged — that verdict belongs to the kernel.
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
  const nodeAuthority = readAuthoritySection(read.get("nodeAuthority"));
  if (!isGraphKey(author)) return { ok: false, field: "author" };
  if (!isGraphKey(completionNode)) return { ok: false, field: "completionNode" };
  if (!budgetOk(budget)) return { ok: false, field: "decompositionBudget" };
  if (nodeAuthority === null) return { ok: false, field: "nodeAuthority" };
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
      author, completionNode, decompositionBudget: budget, nodeAuthority,
      parentRevision: parent, policyRevision, repositoryBaseTree: tree,
    },
  };
}

/**
 * The digest preimage, one entry per declared field, in the declared order. Each is
 * `(name, type tag, payload)`; the tag keeps an absent `parentRevision` distinct
 * from any present ref rather than relying on the empty string, which is not a
 * representable ref in the first place.
 */
function preimageParts(
  graph: ValidatedGraph, fields: ContentFields,
): readonly (readonly [GraphRevisionContentKey, string, string])[] {
  return [
    ["author", "s", fields.author],
    ["completionNode", "s", fields.completionNode],
    ["decompositionBudget", "i", String(fields.decompositionBudget)],
    // Composed, never re-derived: the node authority layer's own canonicalizer
    // decides what a body's canonical text is, so the two cannot drift apart.
    ["nodeAuthority", "a", canonicalNodeAuthorityJson(fields.nodeAuthority)],
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
 * field boundary to forge a different content with the same digest. The domain is
 * fed first and every declared field after it, so a field removed from
 * {@link preimageParts} is removed from the identity — which is exactly what the
 * per-field sweep in `graph-content.test.ts` catches.
 */
export function graphContentDigest(
  graph: ValidatedGraph, fields: ContentFields,
): string {
  const hasher = createHash("sha256");
  hasher.update(`${GRAPH_CONTENT_HASH_DOMAIN}\n`, "utf8");
  for (const [name, tag, payload] of preimageParts(graph, fields)) {
    hasher.update(frame(name) + frame(tag) + frame(payload), "utf8");
  }
  return hasher.digest("hex");
}
