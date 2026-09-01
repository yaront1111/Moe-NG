/**
 * The node authority body's draft/create/admit/encode/decode surface — design
 * lines 199/255, minus the recursive predecessor hash, which is the next slice's.
 *
 * Creation admits the planning records through their own production surfaces and
 * derives the graph-independent plan and criterion identities from them; it
 * accepts no caller-stated digest, hash or revision id at all. The dependency
 * side is ruled on by this package's own validator and only its NORMALIZED
 * contract is persisted. Both foreign authorities keep their own stable codes
 * under a layer naming which of them answered.
 *
 * NOT PUBLISHED FROM THE PACKAGE ROOT YET; root publication is a later slice, and
 * the recursive-hash consumer imports this module by its package-internal path.
 */
import { types } from "node:util";

import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "../runtime-shape.js";
import {
  NODE_AUTHORITY_LIMITS, NODE_AUTHORITY_SCHEMA_TAG, NODE_AUTHORITY_SCHEMA_VERSION,
  NODE_DEFINITION_KEYS, canonicalEnvelopeJson, canonicalText, nodeBodyDigest, ok, refuse,
} from "./node-authority-contract.js";
import {
  admitPlanning, applicable, composeEdges, pick, project, readDerived, requirementsOf,
} from "./node-authority-compose.js";
import { forbiddenKeyRefusal, readDraftFields } from "./node-authority-fields.js";
import type {
  NodeAuthorityDraftResult, NodeAuthorityRefusal, NodeDefinition, Read,
} from "./node-authority-contract.js";

const CREATE_KEYS: readonly string[] =
  ["acceptanceContract", "draft", "planRevision", "predicateRegistry"];
const ENVELOPE_KEYS: readonly string[] = ["body", "digest", "schema"];
const HEX_64 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

/**
 * A frozen envelope carrying COPIED bytes. Not "deeply frozen": freezing a
 * non-empty typed array throws, so detachment — a buffer no caller holds — stands
 * in for immutability of `bytes`. `bodyContentDigest` covers this body ALONE and
 * is NOT `nodeAuthorityHash`, which is recursive over predecessors.
 */
export interface NodeAuthorityBody {
  readonly bodyContentDigest: string;
  readonly bytes: Uint8Array;
  readonly definition: NodeDefinition;
  readonly schemaVersion: typeof NODE_AUTHORITY_SCHEMA_VERSION;
}
export type NodeAuthorityResult =
  | { readonly ok: true; readonly value: NodeAuthorityBody } | NodeAuthorityRefusal;
export type NodeAuthorityBytesResult =
  | { readonly bytes: Uint8Array; readonly ok: true } | NodeAuthorityRefusal;

/**
 * The ceiling is enforced HERE, not only on decode. A body can be admissible
 * field by field and still serialize past the decode ceiling — the dependency
 * validator alone admits 128 witnesses and 128 invalidation facts per contract —
 * and minting bytes this codec would then refuse to read back is an incoherence,
 * not a safety property. The `catch` mirrors the graph-content sibling: an
 * unrepresentable leaf must refuse with a code, never escape as a throw.
 */
function accept(definition: NodeDefinition): NodeAuthorityResult {
  let bytes: Uint8Array;
  let digest: string;
  try {
    const bodyJson = canonicalText(definition);
    digest = nodeBodyDigest(bodyJson);
    bytes = encoder.encode(canonicalEnvelopeJson(digest, bodyJson));
  } catch {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_CODEC",
      "canonical encoding failed for an admitted body");
  }
  if (bytes.length > NODE_AUTHORITY_LIMITS.maxBytes) {
    return refuse("NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      "the canonical body exceeds the ceiling this codec can read back");
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      bodyContentDigest: digest, bytes, definition,
      schemaVersion: NODE_AUTHORITY_SCHEMA_VERSION,
    }),
  });
}

/** Caller-stated fields only. Derives nothing: a draft has no identity. */
export function draftNodeAuthority(value: unknown): NodeAuthorityDraftResult {
  return readDraftFields(value);
}

export function createNodeDefinition(input: unknown): NodeAuthorityResult {
  if (!isPlainRecord(input)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "creation input is not a plain record");
  }
  // Before the exact-key check, not after: the exact-key check would refuse a
  // stated digest as merely "unrecognised" and the specific code would be dead.
  const forbidden = forbiddenKeyRefusal(input);
  if (forbidden !== null) return forbidden;
  if (!hasOnlyOwnStringKeys(input, CREATE_KEYS)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "creation input is not an exact draft/planning/registry record");
  }
  const drafted = draftNodeAuthority(pick(input, "draft"));
  if (!drafted.ok) return drafted;
  const planning = admitPlanning(pick(input, "planRevision"), pick(input, "acceptanceContract"));
  if (!planning.ok) return planning;
  const mismatch = applicable(drafted.draft, planning.value);
  if (mismatch !== null) return mismatch;
  const edges = composeEdges(drafted.draft, pick(input, "predicateRegistry"));
  return edges.ok ? accept(project(drafted.draft, planning.value, edges.value)) : edges;
}

/**
 * Re-reads a complete body. The persisted proofs are the registry, so admission
 * needs no external input and a body whose proof was stripped is refused rather
 * than quietly demoted. Applicability is NOT re-decided here: the planning
 * records that could settle it are not present, and inventing a verdict without
 * them is exactly the fabricated authority this slice refuses to hold.
 */
export function admitNodeDefinition(value: unknown): NodeAuthorityResult {
  if (!isPlainRecord(value)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "body is not a plain record");
  }
  const forbidden = forbiddenKeyRefusal(value);
  if (forbidden !== null) return forbidden;
  if (!hasOnlyOwnStringKeys(value, NODE_DEFINITION_KEYS)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      "body carries an unrecognised field");
  }
  if (pick(value, "schemaVersion") !== NODE_AUTHORITY_SCHEMA_VERSION) {
    return refuse("NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA",
      "body schema version is not supported");
  }
  const stated: Record<string, unknown> = {};
  for (const key of NODE_DEFINITION_KEYS) stated[key] = pick(value, key);
  stated["directHardDependencies"] = requirementsOf(stated["directHardDependencies"]);
  const drafted = readDraftFields(stated, NODE_DEFINITION_KEYS);
  if (!drafted.ok) return drafted;
  const derived = readDerived(value);
  if (!derived.ok) return derived;
  const edges = composeEdges(drafted.draft, pick(value, "monotonicPredicateProofs"));
  return edges.ok ? accept(project(drafted.draft, derived.value, edges.value)) : edges;
}

export function encodeNodeDefinition(definition: unknown): NodeAuthorityBytesResult {
  const admitted = admitNodeDefinition(definition);
  return admitted.ok
    ? Object.freeze({ bytes: admitted.value.bytes, ok: true as const }) : admitted;
}

/** Accepts only a genuine Uint8Array and copies it at once: a caller still
 * writing into its own buffer must not change bytes already judged. */
function readBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    return types.isProxy(value) || !types.isUint8Array(value) ? null : new Uint8Array(value);
  } catch {
    return null;
  }
}

/** Key ORDER is not checked here: a reordered-but-complete envelope is a second
 * spelling of the same content, and the byte re-encode already rejects it. */
function readEnvelope(value: unknown): Read<{
  readonly body: unknown; readonly digest: string; readonly schema: string;
}> {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, ENVELOPE_KEYS)) {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_CODEC",
      "envelope is not an exact body/digest/schema record");
  }
  const body = readOwnDataProperty(value, "body");
  const digest = pick(value, "digest");
  const schema = pick(value, "schema");
  if (!body.ok || !body.present || typeof digest !== "string" || !HEX_64.test(digest)
    || typeof schema !== "string") {
    return refuse("NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_CODEC",
      "envelope fields are absent or malformed");
  }
  return ok({ body: body.value, digest, schema });
}

/**
 * Layer order is load-bearing: the digest is recomputed BEFORE the byte
 * comparison, so a swapped VALUE reports DIGEST_MISMATCH while an alternate
 * SPELLING of correct content — which recomputes the right digest — is caught
 * only by the re-encode. Neither guard subsumes the other.
 */
export function decodeNodeDefinitionBytes(input: unknown): NodeAuthorityResult {
  const bytes = readBytes(input);
  if (bytes === null) {
    return refuse("NODE_AUTHORITY_NOT_BYTES", "NODE_AUTHORITY_CODEC", "input is not a Uint8Array");
  }
  if (bytes.length > NODE_AUTHORITY_LIMITS.maxBytes) {
    return refuse("NODE_AUTHORITY_TOO_LARGE", "NODE_AUTHORITY_CODEC",
      "input exceeds the canonical node authority ceiling");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return refuse("NODE_AUTHORITY_UNREADABLE", "NODE_AUTHORITY_CODEC",
      "input is not fatal-decodable UTF-8 carrying one JSON document");
  }
  const envelope = readEnvelope(parsed);
  if (!envelope.ok) return envelope;
  if (envelope.value.schema !== NODE_AUTHORITY_SCHEMA_TAG) {
    return refuse("NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_CODEC",
      "envelope schema tag is not supported");
  }
  const admitted = admitNodeDefinition(envelope.value.body);
  if (!admitted.ok) return admitted;
  if (admitted.value.bodyContentDigest !== envelope.value.digest) {
    return refuse("NODE_AUTHORITY_DIGEST_MISMATCH", "NODE_AUTHORITY_IDENTITY",
      "declared digest does not match the body it claims");
  }
  return admitted.value.bytes.length === bytes.length
    && admitted.value.bytes.every((byte, index) => byte === bytes[index])
    ? admitted
    : refuse("NODE_AUTHORITY_NONCANONICAL", "NODE_AUTHORITY_IDENTITY",
      "input is an alternate encoding of canonical content");
}
