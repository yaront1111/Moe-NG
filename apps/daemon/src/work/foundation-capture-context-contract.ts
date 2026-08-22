/**
 * The versioned record connecting one PREPARED Foundation workspace to the
 * postlaunch capture of that same attempt.
 *
 * WHY IT EXISTS. A reservation stores the request digest and the attempt
 * identities; a context record stores the rendered `inputManifestDigest`. Neither
 * stores the physical facts a capture needs — which worktree was assigned, which
 * bytes were hydrated into it, which scope was declared, what the tree looked
 * like before the provider ran. Carrying those in a process-local map is what the
 * design forbids, so they are committed here BEFORE launch and reached afterwards
 * through one derived `captureRef`.
 *
 * THE SEALS ARE BOUND AND CROSS-CHECKED, NEVER RECOMPUTED. `canonicalDigest` is
 * private to `@moe/runner`: not re-exported from that barrel, no tsconfig
 * `paths`, no project references, and a deep relative import fails TS6059.
 * Reimplementing the formula would create a second hash that drifts from the
 * producer's and then becomes the one this record trusts. So this codec fences
 * that every digest field IS a digest (`UNSEALED`) and that independently
 * produced halves AGREE (`FIELD_MISMATCH`), and never claims to have recomputed
 * a producer's seal.
 *
 * THE OUTER DIGEST IS DERIVED, NEVER ACCEPTED. A caller must submit one, but it
 * is only ever compared against what this module derives.
 *
 * NINE CODES, DELIBERATELY DISTINCT: wrong shape, unknown version, too large,
 * not a digest, already-dirty tree, declared artifacts, halves describing
 * different attempts, a digest not covering its fields, and bytes that are not
 * this record's own encoding are nine operator problems, never one.
 */

import { SCOPE_OBSERVATION_VERSION, WORKSPACE_INPUT_MANIFEST_VERSION } from "@moe/runner";
import type { ScopeObservation, WorkspaceInputManifest } from "@moe/runner";

import type { FoundationRepositoryScopeAuthority } from "./foundation-repository-scope-contracts.js";

import {
  decodeFoundationPayload,
  encodeFoundationPayload,
  exactKeys,
  isRecord,
  sameBytes,
  snapshotFoundationValue,
} from "./foundation-attempt-codec.js";

export const FOUNDATION_CAPTURE_CONTEXT_VERSION = "moe-foundation-capture-context/1" as const;

/**
 * Names the layer that answered. Deliberately NOT suffixed `_LAYER`: the daemon
 * security scanner matches `^export const [A-Z_]+(LAYERS|LAYER|BOUNDARIES)` and
 * treats every hit as a public security boundary owing a roster row plus
 * BEFORE/AFTER/RACE coverage. This stamp types one codec's own refusals; the
 * sibling `DAEMON_FOUNDATION_ATTEMPT` is the precedent for keeping it out.
 */
export const DAEMON_FOUNDATION_CAPTURE = "DAEMON_FOUNDATION_CAPTURE" as const;

/** The one artifact declaration M1 admits. No caller list ever enters here. */
export const FOUNDATION_CAPTURE_ARTIFACT_DECLARATION = "NONE" as const;

export const FOUNDATION_CAPTURE_CONTEXT_CODES = Object.freeze([
  "FOUNDATION_CAPTURE_CONTEXT_MALFORMED",
  "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED",
  "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
  "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
  "FOUNDATION_CAPTURE_CONTEXT_OBSERVATION_UNCLEAN",
  "FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED",
  "FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH",
  "FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH",
  "FOUNDATION_CAPTURE_CONTEXT_NONCANONICAL",
] as const);
export type FoundationCaptureContextCode = (typeof FOUNDATION_CAPTURE_CONTEXT_CODES)[number];

export const FOUNDATION_CAPTURE_CONTEXT_KEYS = Object.freeze([
  "artifactDeclaration", "assignment", "attemptAggregateId", "attemptId", "baselineDigest",
  "catalogAuthority", "inputManifest", "nodeKey", "observation", "observedAt", "projectId",
  "recordDigest", "recordVersion", "requestDigest", "reservationDigest", "sessionId",
] as const);

/** Published so a consumer bounds itself by THESE numbers rather than a copy. */
export const FOUNDATION_CAPTURE_CONTEXT_LIMITS = Object.freeze({
  declaredPaths: 256, inputEntries: 256, observedEntries: 256,
});

/**
 * The assigned worktree, fenced STRUCTURALLY rather than imported as
 * `WorktreeAssignment`: that type is not on `@moe/runner`'s bare specifier path.
 * A structural fence is also the right shape — a codec admits `unknown` and must
 * not need a producer's compile-time type to decide what it accepts.
 */
const ASSIGNMENT_KEYS = Object.freeze([
  "adopted", "assignmentVersion", "attemptId", "baseIdentity", "leaf", "projectId",
  "realSourceRepositoryRoot", "realWorktreeParent", "realWorktreePath", "worktreePath",
] as const);
const CATALOG_KEYS = Object.freeze([
  "baseRevisionHash", "catalogDigest", "declaredPaths", "projectId", "repositoryRef",
  "scopeRef", "sourceRepositoryRoot", "worktreeParent",
] as const);
const MANIFEST_KEYS = Object.freeze(["baseIdentity", "entries", "manifestVersion", "sha256"] as const);
const OBSERVATION_KEYS = Object.freeze([
  "baseIdentity", "canonicalEntries", "gitAttribution", "observationVersion", "observedAt",
  "observerVersion", "sha256", "worktreeIdentity",
] as const);
const GIT_KEYS = Object.freeze([
  "changedPaths", "dirtyPaths", "headCommit", "ignoredPaths", "stagedPaths", "unmergedPaths",
  "untrackedPaths",
] as const);
/** Every bound field except the binding itself. */
const BOUND_KEYS = Object.freeze(
  FOUNDATION_CAPTURE_CONTEXT_KEYS.filter((key) => key !== "recordDigest"),
);
const ROOT_TEXT_KEYS = Object.freeze([
  "attemptAggregateId", "attemptId", "nodeKey", "observedAt", "projectId", "recordDigest",
  "sessionId",
] as const);
/** Digest-shaped fields, checked as digests and answered under `UNSEALED`. */
const ROOT_DIGEST_KEYS = Object.freeze([
  "baselineDigest", "requestDigest", "reservationDigest",
] as const);
/** A prelaunch tree is clean when all four dirty classes are empty. */
const DIRTY_CLASSES = Object.freeze([
  "dirtyPaths", "stagedPaths", "unmergedPaths", "untrackedPaths",
] as const);
const MAX_TEXT = 8_192;
const HEX_64 = /^[0-9a-f]{64}$/u;

export interface FoundationCaptureContextAssignment {
  readonly adopted: boolean;
  readonly assignmentVersion: string;
  readonly attemptId: string;
  readonly baseIdentity: string;
  readonly leaf: string;
  readonly projectId: string;
  readonly realSourceRepositoryRoot: string;
  readonly realWorktreeParent: string;
  readonly realWorktreePath: string;
  readonly worktreePath: string;
}

/**
 * The resolved catalog authority, verbatim. Re-declaring its eight fields would
 * be a second copy that drifts from the resolver that produces it.
 */
export type FoundationCaptureContextCatalogAuthority = FoundationRepositoryScopeAuthority;

export interface FoundationCaptureContextRecord {
  readonly artifactDeclaration: typeof FOUNDATION_CAPTURE_ARTIFACT_DECLARATION;
  readonly assignment: FoundationCaptureContextAssignment;
  readonly attemptAggregateId: string;
  readonly attemptId: string;
  readonly baselineDigest: string;
  readonly catalogAuthority: FoundationCaptureContextCatalogAuthority;
  readonly inputManifest: WorkspaceInputManifest;
  readonly nodeKey: string;
  readonly observation: ScopeObservation;
  readonly observedAt: string;
  readonly projectId: string;
  readonly recordDigest: string;
  readonly recordVersion: typeof FOUNDATION_CAPTURE_CONTEXT_VERSION;
  readonly requestDigest: string;
  readonly reservationDigest: string;
  readonly sessionId: string;
}

export interface FoundationCaptureContextRefusal {
  readonly code: FoundationCaptureContextCode;
  readonly layer: typeof DAEMON_FOUNDATION_CAPTURE;
  readonly ok: false;
}

export type FoundationCaptureContextEncodeResult =
  | { readonly bytes: Uint8Array; readonly ok: true;
    readonly record: FoundationCaptureContextRecord }
  | FoundationCaptureContextRefusal;

export type FoundationCaptureContextDecodeResult =
  | { readonly ok: true; readonly record: FoundationCaptureContextRecord }
  | FoundationCaptureContextRefusal;

function refuse(code: FoundationCaptureContextCode): FoundationCaptureContextRefusal {
  return Object.freeze({ code, layer: DAEMON_FOUNDATION_CAPTURE, ok: false as const });
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
const digest = (value: unknown): value is string =>
  typeof value === "string" && HEX_64.test(value);

/** Deep-freeze what we return; a shallow freeze leaves every nested array writable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/**
 * An own-data-descriptor array length, BEFORE the snapshot walk. The shared
 * snapshot refuses any array past its own generic ceiling, so a hostile
 * four-thousand-entry manifest would otherwise read MALFORMED and an operator
 * would never learn it was merely too large. The descriptor read never invokes
 * an accessor, and `Array.isArray` can throw on a revoked proxy.
 */
function ownLength(container: unknown, key: string): number | null {
  try {
    if (!isRecord(container)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    return Array.isArray(descriptor.value) ? descriptor.value.length : null;
  } catch { return null; }
}

function overLimit(source: Record<string, unknown>): boolean {
  const measured: readonly (readonly [number | null, number])[] = [
    [ownLength(source["catalogAuthority"], "declaredPaths"),
      FOUNDATION_CAPTURE_CONTEXT_LIMITS.declaredPaths],
    [ownLength(source["inputManifest"], "entries"),
      FOUNDATION_CAPTURE_CONTEXT_LIMITS.inputEntries],
    [ownLength(source["observation"], "canonicalEntries"),
      FOUNDATION_CAPTURE_CONTEXT_LIMITS.observedEntries],
  ];
  return measured.some(([length, limit]) => length !== null && length > limit);
}

/**
 * The outer digest, over the CANONICAL BYTES of the fifteen bound fields —
 * `String(object)` is `"[object Object]"` for every distinct record, so a
 * reference-based digest would collide across records differing in any field.
 */
export function deriveFoundationCaptureContextRecordDigest(fields: unknown): string {
  const source = isRecord(fields) ? fields : {};
  const bound: Record<string, unknown> = {};
  for (const key of BOUND_KEYS) bound[key] = source[key];
  const encoded = encodeFoundationPayload(bound);
  return encoded.ok ? encoded.digest : "";
}

/** The five nested containers, each already fenced to its exact key set. */
interface CaptureParts {
  readonly assignment: Record<string, unknown>;
  readonly catalogAuthority: Record<string, unknown>;
  readonly gitAttribution: Record<string, unknown>;
  readonly inputManifest: Record<string, unknown>;
  readonly observation: Record<string, unknown>;
}

/** Exact keys on all five nested containers, or null. */
function nested(snapshot: Record<string, unknown>): CaptureParts | null {
  const assignment = exactKeys(snapshot["assignment"], ASSIGNMENT_KEYS);
  const catalogAuthority = exactKeys(snapshot["catalogAuthority"], CATALOG_KEYS);
  const inputManifest = exactKeys(snapshot["inputManifest"], MANIFEST_KEYS);
  const observation = exactKeys(snapshot["observation"], OBSERVATION_KEYS);
  if (assignment === null || catalogAuthority === null || inputManifest === null
    || observation === null) return null;
  const gitAttribution = exactKeys(observation["gitAttribution"], GIT_KEYS);
  if (gitAttribution === null) return null;
  return { assignment, catalogAuthority, gitAttribution, inputManifest, observation };
}

function shapeOf(parts: CaptureParts): boolean {
  const { assignment, catalogAuthority, inputManifest, observation } = parts;
  return ASSIGNMENT_KEYS.every((key) => key === "adopted" ? typeof assignment[key] === "boolean"
    : text(assignment[key]))
    && CATALOG_KEYS.every((key) => key === "declaredPaths"
      ? Array.isArray(catalogAuthority[key]) && catalogAuthority[key].every(text)
      : text(catalogAuthority[key]))
    && Array.isArray(inputManifest["entries"]) && text(inputManifest["baseIdentity"])
    && Array.isArray(observation["canonicalEntries"]) && text(observation["baseIdentity"])
    && text(observation["observedAt"]) && text(observation["observerVersion"])
    && text(observation["worktreeIdentity"]);
}

/** The independently-produced halves have to describe ONE attempt. */
function agrees(snapshot: Record<string, unknown>, parts: CaptureParts): boolean {
  const { assignment, catalogAuthority, inputManifest, observation } = parts;
  return snapshot["baselineDigest"] === inputManifest["sha256"]
    && observation["baseIdentity"] === inputManifest["baseIdentity"]
    && assignment["realWorktreePath"] === observation["worktreeIdentity"]
    && snapshot["projectId"] === catalogAuthority["projectId"]
    && snapshot["projectId"] === assignment["projectId"]
    && snapshot["attemptId"] === assignment["attemptId"];
}

function admitRecord(
  input: unknown,
): FoundationCaptureContextRecord | FoundationCaptureContextRefusal {
  const outer = exactKeys(input, FOUNDATION_CAPTURE_CONTEXT_KEYS);
  if (outer === null) return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  if (overLimit(outer)) return refuse("FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED");
  const snapshot = snapshotFoundationValue(input);
  if (!isRecord(snapshot)) return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  const parts = nested(snapshot);
  if (parts === null) return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  if (!ROOT_TEXT_KEYS.every((key) => text(snapshot[key])) || !shapeOf(parts)) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  }
  if (snapshot["recordVersion"] !== FOUNDATION_CAPTURE_CONTEXT_VERSION
    || parts.inputManifest["manifestVersion"] !== WORKSPACE_INPUT_MANIFEST_VERSION
    || parts.observation["observationVersion"] !== SCOPE_OBSERVATION_VERSION) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED");
  }
  if (!ROOT_DIGEST_KEYS.every((key) => digest(snapshot[key]))
    || !digest(parts.inputManifest["sha256"]) || !digest(parts.observation["sha256"])) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_UNSEALED");
  }
  if (snapshot["artifactDeclaration"] !== FOUNDATION_CAPTURE_ARTIFACT_DECLARATION) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED");
  }
  if (!DIRTY_CLASSES.every((key) => {
    const paths = parts.gitAttribution[key];
    return Array.isArray(paths) && paths.length === 0;
  })) return refuse("FOUNDATION_CAPTURE_CONTEXT_OBSERVATION_UNCLEAN");
  if (!agrees(snapshot, parts)) return refuse("FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH");
  const admitted = snapshot as unknown as FoundationCaptureContextRecord;
  if (deriveFoundationCaptureContextRecordDigest(admitted) !== admitted.recordDigest) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH");
  }
  return deepFreeze(admitted);
}

/** Admit, derive, and canonically encode. Nothing is returned on a refusal. */
export function encodeFoundationCaptureContext(
  input: unknown,
): FoundationCaptureContextEncodeResult {
  const record = admitRecord(input);
  if ("ok" in record) return record;
  const encoded = encodeFoundationPayload(record);
  if (!encoded.ok) return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  return Object.freeze({ bytes: encoded.bytes, ok: true as const, record });
}

/**
 * Rebuild parsed values on `Object.prototype`. The bounded JSON parser builds
 * every object with `Object.create(null)` and the shared snapshot refuses those,
 * so a decoded payload can never be re-admitted as-is. A prototype adapter over
 * bytes THIS module produced — no key, value or ordering change. A
 * null-prototype object from a CALLER is still refused: callers enter through
 * the encoder.
 */
function plainify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainify);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = plainify(source[key]);
  return out;
}

/**
 * Bounded decode, full re-admission, then RE-ENCODE and byte-compare before any
 * authority is returned. The re-encode separates "these bytes parse to a valid
 * record" from "these bytes ARE the record": an alternate encoding of the same
 * value parses identically and is refused here as NONCANONICAL.
 */
export function decodeFoundationCaptureContext(
  bytes: unknown,
): FoundationCaptureContextDecodeResult {
  const decoded = decodeFoundationPayload(bytes);
  if (!decoded.ok) return refuse("FOUNDATION_CAPTURE_CONTEXT_MALFORMED");
  const encoded = encodeFoundationCaptureContext(plainify(decoded.value));
  if (!encoded.ok) return encoded;
  if (!(bytes instanceof Uint8Array) || !sameBytes(encoded.bytes, bytes)) {
    return refuse("FOUNDATION_CAPTURE_CONTEXT_NONCANONICAL");
  }
  return Object.freeze({ ok: true as const, record: encoded.record });
}
