/**
 * Canonical `GraphRevisionContent` identity — design lines 197 and 255. One public
 * codec that binds an immutable eight-field content record to a domain-separated
 * SHA-256 `graphContentHash`, so a durable graph revision can prove the stored
 * content is the one its approved hash names: the canonical node/edge set, the
 * node-authority section, repository base tree, parent revision, completion node,
 * policy revision, decomposition budget and author, all covered by that hash.
 *
 * NEVER THE STRUCTURAL IDENTITY. Decision dec-64b2391c resolved to full content
 * authority, so `graphContentHash` and the snapshot's structural identity are two
 * values that must never be equated: `snapshotIdentity` is answered beside it,
 * named for what it is, and is never a serialized field — a reader has one
 * identity on the wire and it is the content hash. Since v3 that identity also
 * authenticates every node's ADMITTED definition and its HARD dependency
 * contracts, so `{nodeKey, executionBearing}` rows cannot stand in for content.
 *
 * This module decides nothing about graphs and nothing about node bodies.
 * `validateGraphSnapshot` stays the single structural authority and
 * `deriveNodeAuthoritySet` the single node-authority one: their issues pass through
 * with their OWN codes and layers rather than restamped as codec failures. Policy
 * OVERRIDES are outside content identity because `graphIdentity` excludes them —
 * inherited, not re-decided — while design-named `policyRevision` is its own field.
 *
 * Persistence, lifecycle, transport and ingress are out of scope; the consumer that
 * stores these bytes is task-dd4ffa0c40834c59892f957fbf61fb23 and the root
 * publication of this v3 surface is task-210efa47.
 */
import {
  GRAPH_REVISION_CONTENT_KEYS, graphContentDigest, readContentFields,
} from "./graph-content-fields.js";
import {
  DECODE_POLICY, MAX_GRAPH_CONTENT_BYTES, SCHEMA_TAG, canonicalContentJson,
  canonicalGraphJson, projectContent, projectGraphSnapshot, readContentBytes,
  readContentEnvelope, sameBytes, snapshotIdentityHash,
} from "./graph-content-format.js";
import {
  GRAPH_CONTENT_ISSUE_CODES, GRAPH_CONTENT_LAYERS, authorityPassthrough,
  passthrough, refuse,
} from "./graph-content-issues.js";
import { deepFreeze } from "./node-authority/node-authority-contract.js";
import { deriveNodeAuthoritySet } from "./node-authority/node-authority-recursion.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { ContentFields, GraphRevisionContent } from "./graph-content-fields.js";
import type { GraphContentRefusal } from "./graph-content-issues.js";
import type { ValidatedGraph } from "./graph-model.js";

export { MAX_GRAPH_CONTENT_BYTES, GRAPH_REVISION_CONTENT_KEYS };
export { GRAPH_CONTENT_ISSUE_CODES, GRAPH_CONTENT_LAYERS };
export type { GraphRevisionContent };
export type {
  NodeAuthorityEntry, NodeAuthoritySection,
} from "./graph-content-fields.js";
export type {
  GraphContentIssue, GraphContentIssueCode, GraphContentLayer,
} from "./graph-content-issues.js";

export const GRAPH_CONTENT_SCHEMA_VERSION = 3 as const;

/**
 * A frozen envelope carrying COPIED bytes. Not "deeply frozen": freezing a
 * non-empty typed array throws, so detachment — a fresh buffer no caller holds —
 * stands in for immutability of `bytes`.
 */
export interface GraphContent {
  readonly schemaVersion: typeof GRAPH_CONTENT_SCHEMA_VERSION;
  /** Domain-separated SHA-256 over ALL EIGHT design-197/255 fields, as lowercase
   * 64-char hex — the spelling @moe/core's revision gate requires. */
  readonly graphContentHash: string;
  /** The STRUCTURE-ONLY identity of the same graph, answered beside the content
   * hash and never equal to it (dec-64b2391c): offered so a caller comparing two
   * revisions structurally has one place to get it, and named so it cannot be
   * mistaken for content authority. */
  readonly snapshotIdentity: string;
  readonly content: GraphRevisionContent;
  readonly bytes: Uint8Array;
}

export type GraphContentResult =
  | { readonly ok: true; readonly value: GraphContent }
  | GraphContentRefusal;

type AuthorityBinding =
  | { readonly ok: true; readonly fields: ContentFields }
  | GraphContentRefusal;

function accept(graph: ValidatedGraph, fields: ContentFields): GraphContentResult {
  const hash = graphContentDigest(graph, fields);
  const contentJson = canonicalContentJson(graph, fields);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      schemaVersion: GRAPH_CONTENT_SCHEMA_VERSION,
      graphContentHash: hash,
      snapshotIdentity: snapshotIdentityHash(graph),
      content: projectContent(projectGraphSnapshot(graph), fields),
      bytes: new TextEncoder().encode(canonicalGraphJson(hash, contentJson)),
    }),
  });
}

/**
 * The completion node is stated twice — by the author and by the graph the kernel
 * accepted — and reconciled here, the one place that sees both. The graph always
 * wins and a disagreement is refused rather than resolved: silently preferring
 * either would let a revision name a completion node its own graph lacks.
 */
function completionAgrees(graph: ValidatedGraph, fields: ContentFields): boolean {
  return fields.completionNode === graph.completionNodeKey;
}

/**
 * The ONE consumer edge to the NodeAuthority composer (task-39c4bccd), the single
 * semantic authority on this seam: the codec hands it the accepted snapshot and the
 * embedded bodies, then COMPARES the set it derives against the set the record
 * states. No node hash is computed here and no caller-stated hash gains authority —
 * the DERIVED set is embedded, hashed and handed back, the stated one discarded
 * once checked. Every reason a body, contract or closure is inadmissible keeps the
 * composer's own code and layer; only the DISAGREEMENT between the halves is this
 * codec's verdict, because no single foreign authority can see both.
 */
function bindAuthority(
  graph: ValidatedGraph, fields: ContentFields, policyOverride: unknown,
): AuthorityBinding {
  const stated = fields.nodeAuthority.authorities;
  const definitions = fields.nodeAuthority.definitions;
  const derived = deriveNodeAuthoritySet(
    projectGraphSnapshot(graph), definitions, policyOverride,
  );
  if (!derived.ok) {
    return authorityPassthrough(derived.issues);
  }
  const agrees = derived.value.length === stated.length
    && derived.value.every((entry, index) => entry.nodeKey === stated[index]?.nodeKey
      && entry.nodeAuthorityHash === stated[index]?.nodeAuthorityHash);
  if (!agrees) {
    return refuse("GRAPH_CONTENT_AUTHORITY_DISAGREEMENT",
      "stated node authority set is not the one derived from these definitions");
  }
  const nodeAuthority = deepFreeze({ authorities: derived.value, definitions: derived.definitions });
  return { ok: true, fields: { ...fields, nodeAuthority } };
}

/**
 * Read the fields, validate the graph, reconcile, bind the node authorities, then
 * canonicalize and hash. A record the field reader refuses, a snapshot the kernel
 * refuses and a body set the composer refuses all stop before the digest.
 */
export function encodeGraphContent(content: unknown, policyOverride?: unknown): GraphContentResult {
  const read = readContentFields(content);
  if (!read.ok) {
    return refuse("GRAPH_CONTENT_FIELD_INVALID",
      `content field "${read.field}" is absent, out of bounds, or not a data property`);
  }
  let validated;
  try {
    validated = validateGraphSnapshot(read.snapshot, policyOverride);
  } catch {
    return refuse("GRAPH_CONTENT_MALFORMED", "graph validation threw on the snapshot");
  }
  if (!validated.ok) {
    return passthrough(validated.issues);
  }
  if (!completionAgrees(validated.graph, read.fields)) {
    return refuse("GRAPH_CONTENT_COMPLETION_DRIFT",
      "declared completionNode is not the completion node of the accepted graph");
  }
  const bound = bindAuthority(validated.graph, read.fields, policyOverride);
  if (!bound.ok) {
    return bound;
  }
  try {
    return accept(validated.graph, bound.fields);
  } catch {
    return refuse("GRAPH_CONTENT_MALFORMED", "canonical encoding failed for a valid graph");
  }
}

/**
 * Layer order is load-bearing. The digest is recomputed BEFORE the byte comparison
 * so a swapped VALUE — whose bytes are still perfectly canonical — reports as
 * DIGEST_MISMATCH rather than the misleading NONCANONICAL, while an alternate
 * SPELLING of correct content, which recomputes the right digest, is caught only by
 * the re-encode. Neither guard subsumes the other.
 *
 * Completion reconciliation and the node-authority binding both run BEFORE the
 * digest: an attacker holding the bytes can also compute a correct digest over
 * drifted content, so a self-consistent forgery would sail past the digest and hit
 * those checks anyway — ordering them first only decides which code a TAMPERED-and-
 * incoherent input reports, and internal incoherence is the more specific answer.
 * The authority set is RE-DERIVED, never adopted: a length-preserving swap of two
 * node hashes is canonical, and only a decoder that re-runs the composer sees it.
 */
export function decodeGraphContent(input: unknown): GraphContentResult {
  const bytes = readContentBytes(input);
  if (bytes === null) {
    return refuse("GRAPH_CONTENT_NOT_BYTES", "input is not a Uint8Array");
  }
  if (bytes.length > MAX_GRAPH_CONTENT_BYTES) {
    return refuse("GRAPH_CONTENT_TOO_LARGE", "input exceeds the graph content ceiling");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return refuse("GRAPH_CONTENT_UNREADABLE",
      "input is not fatal-decodable UTF-8 carrying one JSON document");
  }

  const envelope = readContentEnvelope(parsed);
  if (envelope === null) {
    return refuse("GRAPH_CONTENT_MALFORMED", "envelope is not an exact schema/hash/content record");
  }
  if (envelope.schema !== SCHEMA_TAG) {
    return refuse("GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "envelope schema tag is not supported");
  }
  const read = readContentFields(envelope.content);
  if (!read.ok) {
    return refuse("GRAPH_CONTENT_FIELD_INVALID",
      `content field "${read.field}" is absent, out of bounds, or not a data property`);
  }

  const validated = validateGraphSnapshot(read.snapshot, DECODE_POLICY);
  if (!validated.ok) {
    return passthrough(validated.issues);
  }
  if (!completionAgrees(validated.graph, read.fields)) {
    return refuse("GRAPH_CONTENT_COMPLETION_DRIFT",
      "declared completionNode is not the completion node of the accepted graph");
  }
  const bound = bindAuthority(validated.graph, read.fields, DECODE_POLICY);
  if (!bound.ok) {
    return bound;
  }

  const hash = graphContentDigest(validated.graph, bound.fields);
  if (hash !== envelope.hash) {
    return refuse("GRAPH_CONTENT_DIGEST_MISMATCH", "declared hash does not match its content");
  }
  const canonical = new TextEncoder().encode(
    canonicalGraphJson(hash, canonicalContentJson(validated.graph, bound.fields)),
  );
  if (!sameBytes(canonical, bytes)) {
    return refuse("GRAPH_CONTENT_NONCANONICAL", "input is an alternate encoding of the content");
  }
  return accept(validated.graph, bound.fields);
}
