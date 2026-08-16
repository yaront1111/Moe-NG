/**
 * Canonical graph-snapshot content identity.
 *
 * One public codec that binds immutable snapshot BYTES to a domain-separated
 * SHA-256 `graphContentHash`, so a durable graph revision can prove the stored
 * snapshot is the one its approved hash names.
 *
 * This module decides nothing about graphs. `validateGraphSnapshot` remains the
 * single structural authority: its canonical node/edge order is the only order
 * serialized, its `graphIdentity` is the only thing hashed, and its issues are
 * passed through with their OWN codes under the `GRAPH_VALIDATION` layer rather
 * than restamped as codec failures. Policy is excluded from content identity
 * because `graphIdentity` excludes it — inherited, not re-decided.
 *
 * Persistence, graph lifecycle, transport and ingress are out of scope; the
 * consumer that stores these bytes is task-dd4ffa0c40834c59892f957fbf61fb23.
 */
import {
  DECODE_POLICY,
  MAX_GRAPH_CONTENT_BYTES,
  SCHEMA_TAG,
  canonicalGraphJson,
  graphContentHash,
  projectGraphSnapshot,
  readContentBytes,
  readContentEnvelope,
  sameBytes,
} from "./graph-content-format.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type {
  GraphIssue,
  GraphIssueCode,
  GraphKey,
  GraphSnapshot,
  ValidatedGraph,
} from "./graph-model.js";

export { MAX_GRAPH_CONTENT_BYTES };

export const GRAPH_CONTENT_SCHEMA_VERSION = 1 as const;

/** Which layer refused. Closed and frozen. */
export const GRAPH_CONTENT_LAYERS = Object.freeze([
  "GRAPH_CONTENT_CODEC", "GRAPH_CONTENT_IDENTITY", "GRAPH_VALIDATION",
] as const);
export type GraphContentLayer = (typeof GRAPH_CONTENT_LAYERS)[number];

/**
 * Framing and identity codes owned by THIS module. A structural graph failure
 * never appears here — it keeps its own {@link GraphIssueCode}.
 */
export const GRAPH_CONTENT_ISSUE_CODES = Object.freeze([
  "GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_MALFORMED",
  "GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_NOT_BYTES",
  "GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_UNREADABLE",
  "GRAPH_CONTENT_UNSUPPORTED_SCHEMA",
] as const);
export type GraphContentIssueCode = (typeof GRAPH_CONTENT_ISSUE_CODES)[number];

export interface GraphContentIssue {
  readonly code: GraphContentIssueCode | GraphIssueCode;
  readonly layer: GraphContentLayer;
  readonly message: string;
  readonly nodeKeys: readonly GraphKey[];
  readonly edgeKeys: readonly GraphKey[];
}

/**
 * A frozen envelope carrying COPIED bytes. Not "deeply frozen": freezing a
 * non-empty typed array throws (`Cannot freeze array buffer views with
 * elements`), so detachment — a fresh buffer no caller holds — is what stands
 * in for immutability of `bytes`.
 */
export interface GraphContent {
  readonly schemaVersion: typeof GRAPH_CONTENT_SCHEMA_VERSION;
  /** Lowercase 64-char SHA-256 hex, the spelling @moe/core's revision gate requires. */
  readonly graphContentHash: string;
  readonly snapshot: GraphSnapshot;
  readonly bytes: Uint8Array;
}

export type GraphContentResult =
  | { readonly ok: true; readonly value: GraphContent }
  | { readonly ok: false; readonly issues: readonly GraphContentIssue[] };

function refuse(
  code: GraphContentIssueCode,
  layer: GraphContentLayer,
  message: string,
): GraphContentResult {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze([Object.freeze({
      code, layer, message,
      nodeKeys: Object.freeze([]), edgeKeys: Object.freeze([]),
    })]),
  });
}

/** Surface the validator's verdict unchanged; only the layer is added. */
function passthrough(issues: readonly GraphIssue[]): GraphContentResult {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code,
      layer: "GRAPH_VALIDATION" as const,
      message: issue.message,
      nodeKeys: issue.nodeKeys,
      edgeKeys: issue.edgeKeys,
    }))),
  });
}

function accept(graph: ValidatedGraph): GraphContentResult {
  const hash = graphContentHash(graph);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      schemaVersion: GRAPH_CONTENT_SCHEMA_VERSION,
      graphContentHash: hash,
      snapshot: projectGraphSnapshot(graph),
      bytes: new TextEncoder().encode(canonicalGraphJson(hash, graph)),
    }),
  });
}

/**
 * Validate, then canonicalize, then hash. A snapshot the kernel refuses never
 * reaches the digest, so no unvalidated shape can acquire a content identity.
 */
export function encodeGraphContent(
  snapshot: unknown,
  policyOverride?: unknown,
): GraphContentResult {
  let validated;
  try {
    validated = validateGraphSnapshot(snapshot, policyOverride);
  } catch {
    return refuse("GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC",
      "graph validation threw on the supplied snapshot");
  }
  if (!validated.ok) {
    return passthrough(validated.issues);
  }
  try {
    return accept(validated.graph);
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
      "envelope is not an exact schema/hash/snapshot record");
  }
  if (envelope.schema !== SCHEMA_TAG) {
    return refuse("GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "GRAPH_CONTENT_CODEC",
      "envelope schema tag is not supported");
  }

  const validated = validateGraphSnapshot(envelope.snapshot, DECODE_POLICY);
  if (!validated.ok) {
    return passthrough(validated.issues);
  }

  const hash = graphContentHash(validated.graph);
  if (hash !== envelope.hash) {
    return refuse("GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY",
      "declared hash does not match the content it claims");
  }
  const canonical = new TextEncoder()
    .encode(canonicalGraphJson(hash, validated.graph));
  if (!sameBytes(canonical, bytes)) {
    return refuse("GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_IDENTITY",
      "input is an alternate encoding of canonical content");
  }
  return accept(validated.graph);
}
