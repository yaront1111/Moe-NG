/**
 * Canonical `GraphRevisionContent` identity — design line 197.
 *
 * One public codec that binds an immutable seven-field content record to a
 * domain-separated SHA-256 `graphContentHash`, so a durable graph revision can
 * prove the stored content is the one its approved hash names. The seven fields
 * are the canonical node/edge set, repository base tree, parent revision,
 * completion node, policy revision, decomposition budget and author; the hash
 * covers ALL of them.
 *
 * NEVER THE STRUCTURAL IDENTITY. Decision dec-64b2391c resolved to full content
 * authority, so `graphContentHash` and the snapshot's structural identity are two
 * different values that must never be equated: `snapshotIdentity` is answered
 * beside it, named for what it is, and is not serialized — a reader has one
 * value on the wire and it is the content hash.
 *
 * This module decides nothing about graphs. `validateGraphSnapshot` remains the
 * single structural authority: its canonical node/edge order is the only order
 * serialized, and its issues are passed through with their OWN codes under the
 * `GRAPH_VALIDATION` layer rather than restamped as codec failures. Policy
 * OVERRIDES are excluded from content identity because `graphIdentity` excludes
 * them — inherited, not re-decided — while the design-named `policyRevision` is
 * carried as a field of its own.
 *
 * Persistence, graph lifecycle, transport and ingress are out of scope; the
 * consumer that stores these bytes is task-dd4ffa0c40834c59892f957fbf61fb23.
 */
import {
  GRAPH_REVISION_CONTENT_KEYS,
  canonicalContentJson,
  graphContentDigest,
  projectContent,
  readContentFields,
} from "./graph-content-fields.js";
import {
  DECODE_POLICY,
  MAX_GRAPH_CONTENT_BYTES,
  SCHEMA_TAG,
  canonicalGraphJson,
  projectGraphSnapshot,
  readContentBytes,
  readContentEnvelope,
  sameBytes,
  snapshotIdentityHash,
} from "./graph-content-format.js";
import {
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_CONTENT_LAYERS,
  passthrough,
  refuse,
} from "./graph-content-issues.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { ContentFields, GraphRevisionContent } from "./graph-content-fields.js";
import type { GraphContentRefusal } from "./graph-content-issues.js";
import type { ValidatedGraph } from "./graph-model.js";

export { MAX_GRAPH_CONTENT_BYTES, GRAPH_REVISION_CONTENT_KEYS };
export { GRAPH_CONTENT_ISSUE_CODES, GRAPH_CONTENT_LAYERS };
export type { GraphRevisionContent };
export type {
  GraphContentIssue,
  GraphContentIssueCode,
  GraphContentLayer,
} from "./graph-content-issues.js";

export const GRAPH_CONTENT_SCHEMA_VERSION = 2 as const;

/**
 * A frozen envelope carrying COPIED bytes. Not "deeply frozen": freezing a
 * non-empty typed array throws (`Cannot freeze array buffer views with
 * elements`), so detachment — a fresh buffer no caller holds — is what stands
 * in for immutability of `bytes`.
 */
export interface GraphContent {
  readonly schemaVersion: typeof GRAPH_CONTENT_SCHEMA_VERSION;
  /**
   * Domain-separated SHA-256 over ALL SEVEN design-197 fields, as lowercase
   * 64-char hex — the spelling @moe/core's revision gate requires.
   */
  readonly graphContentHash: string;
  /**
   * The STRUCTURE-ONLY identity of the same graph, answered beside the content
   * hash and never equal to it (dec-64b2391c). Offered so a caller that needs to
   * compare two revisions structurally has one place to get that, and named so it
   * can never be mistaken for content authority.
   */
  readonly snapshotIdentity: string;
  readonly content: GraphRevisionContent;
  readonly bytes: Uint8Array;
}

export type GraphContentResult =
  | { readonly ok: true; readonly value: GraphContent }
  | GraphContentRefusal;

function accept(graph: ValidatedGraph, fields: ContentFields): GraphContentResult {
  const hash = snapshotIdentityHash(graph);
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
 * The completion node is stated twice — once by the author, once by the graph the
 * kernel accepted — and reconciled here, in the one place that sees both. The
 * graph always wins: a disagreement is refused rather than resolved, because
 * silently preferring either would let a durable revision name a completion node
 * its own graph does not have.
 */
function completionAgrees(graph: ValidatedGraph, fields: ContentFields): boolean {
  return fields.completionNode === graph.completionNodeKey;
}

/**
 * Read the fields, validate the graph, reconcile, then canonicalize and hash. A
 * content record the field reader refuses and a snapshot the kernel refuses both
 * stop before the digest, so no unvalidated shape can acquire a content identity.
 */
export function encodeGraphContent(
  content: unknown,
  policyOverride?: unknown,
): GraphContentResult {
  const read = readContentFields(content);
  if (!read.ok) {
    return refuse("GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC",
      `content field "${read.field}" is absent, out of bounds, or not a data property`);
  }
  let validated;
  try {
    validated = validateGraphSnapshot(read.snapshot, policyOverride);
  } catch {
    return refuse("GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC",
      "graph validation threw on the supplied snapshot");
  }
  if (!validated.ok) {
    return passthrough(validated.issues);
  }
  if (!completionAgrees(validated.graph, read.fields)) {
    return refuse("GRAPH_CONTENT_COMPLETION_DRIFT", "GRAPH_CONTENT_IDENTITY",
      "declared completionNode is not the completion node of the accepted graph");
  }
  try {
    return accept(validated.graph, read.fields);
  } catch {
    return refuse("GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC",
      "canonical encoding failed for a validated graph");
  }
}

/**
 * Layer order is load-bearing. The digest is recomputed BEFORE the byte
 * comparison so a swapped VALUE — whose bytes are still perfectly canonical —
 * reports as DIGEST_MISMATCH rather than the misleading NONCANONICAL, while an
 * alternate SPELLING of correct content, which recomputes the right digest, is
 * caught only by the re-encode. Neither guard subsumes the other.
 *
 * The completion reconciliation runs BEFORE the digest, because an attacker who
 * controls the bytes can also compute a correct digest over drifted content: a
 * self-consistent forgery would sail past the digest and hit this check anyway,
 * so ordering it first only decides which code a TAMPERED-and-drifted input
 * reports, and internal incoherence is the more specific answer.
 */
export function decodeGraphContent(input: unknown): GraphContentResult {
  const bytes = readContentBytes(input);
  if (bytes === null) {
    return refuse("GRAPH_CONTENT_NOT_BYTES", "GRAPH_CONTENT_CODEC",
      "input is not a Uint8Array");
  }
  if (bytes.length > MAX_GRAPH_CONTENT_BYTES) {
    return refuse("GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_CODEC",
      "input exceeds the canonical graph content ceiling");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return refuse("GRAPH_CONTENT_UNREADABLE", "GRAPH_CONTENT_CODEC",
      "input is not fatal-decodable UTF-8 carrying one JSON document");
  }

  const envelope = readContentEnvelope(parsed);
  if (envelope === null) {
    return refuse("GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC",
      "envelope is not an exact schema/hash/content record");
  }
  if (envelope.schema !== SCHEMA_TAG) {
    return refuse("GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "GRAPH_CONTENT_CODEC",
      "envelope schema tag is not supported");
  }
  const read = readContentFields(envelope.content);
  if (!read.ok) {
    return refuse("GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC",
      `content field "${read.field}" is absent, out of bounds, or not a data property`);
  }

  const validated = validateGraphSnapshot(read.snapshot, DECODE_POLICY);
  if (!validated.ok) {
    return passthrough(validated.issues);
  }
  if (!completionAgrees(validated.graph, read.fields)) {
    return refuse("GRAPH_CONTENT_COMPLETION_DRIFT", "GRAPH_CONTENT_IDENTITY",
      "declared completionNode is not the completion node of the accepted graph");
  }

  const hash = graphContentDigest(validated.graph, read.fields);
  if (hash !== envelope.hash) {
    return refuse("GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY",
      "declared hash does not match the content it claims");
  }
  const canonical = new TextEncoder().encode(
    canonicalGraphJson(hash, canonicalContentJson(validated.graph, read.fields)),
  );
  if (!sameBytes(canonical, bytes)) {
    return refuse("GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_IDENTITY",
      "input is an alternate encoding of canonical content");
  }
  return accept(validated.graph, read.fields);
}
