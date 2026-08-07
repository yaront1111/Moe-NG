/**
 * Frozen authority vocabularies, result primitives, and hostile-input helpers.
 *
 * The scheduler package is dependency-free, so every vocabulary here is a
 * deliberate string-identical clone of the runtime contract registry. Each one
 * carries its source so a drift test can compare them by value.
 */
import {
  hasOnlyOwnStringKeys,
  isPlainArray,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";

/**
 * CONSOLIDATION NOTE: `deepFreeze`/`compareStrings` are cloned here for the
 * third time (see `../graph-internal.ts` and `../dependencies/`). A follow-up
 * consolidation task should hoist them into one internal module; reuse of
 * `graph-internal`'s issue helpers is impossible today because they are typed
 * against the closed `GraphIssueCode` union owned by another task.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** String-identical to `RUNTIME_LIFECYCLES.LEASE` (runtime-vocabulary.ts). */
export const LEASE_STATES = ["ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED"] as const;
/**
 * Design line 741 scopes the five-state machine to assignment and workspace
 * leases; line 568 extends privileged revocation to fenceable resource leases.
 * Provider slots are deliberately absent — see `SLOT_STATES` in
 * `./lease-resource.ts`.
 */
export const LEASE_KINDS = ["ASSIGNMENT", "WORKSPACE", "RESOURCE"] as const;
/** Frozen drain precedence, verbatim from design line 348 (strongest first). */
export const DRAIN_REASONS = [
  "URGENT_REVOKE", "GRAPH_REMOVE_OR_SUPERSESSION", "GOAL_CANCEL", "WORK_CANCEL",
  "DEPENDENCY_INVALIDATED", "WORK_RELEASE_OR_PAUSE", "SUBMISSION_FINALIZE",
] as const;
/** String-identical to the runtime `RuntimeTruthClass` union. */
export const TRUTH_CLASSES = [
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
] as const;

export type LeaseState = (typeof LEASE_STATES)[number];
export type LeaseKind = (typeof LEASE_KINDS)[number];
export type DrainReason = (typeof DRAIN_REASONS)[number];
export type TruthClass = (typeof TRUTH_CLASSES)[number];

export const DRAIN_REASON_RANKS: Readonly<Record<DrainReason, number>> = Object.freeze({
  URGENT_REVOKE: 70, GRAPH_REMOVE_OR_SUPERSESSION: 60, GOAL_CANCEL: 50, WORK_CANCEL: 40,
  DEPENDENCY_INVALIDATED: 30, WORK_RELEASE_OR_PAUSE: 20, SUBMISSION_FINALIZE: 10,
});

/** Design line 751: a 90-second renewal window renewed at one third of it. */
export const RENEWAL_WINDOW_SECONDS = 90;
/** One third of the window, written as an integer literal so no float divide exists. */
export const RENEW_AFTER_SECONDS = 30;
export const MAX_AUTHORITY_ITEMS = 128;
/**
 * Every accepted counter leaves headroom for the increments this kernel makes
 * (version +1, epoch +1, deadline +RENEWAL_WINDOW_SECONDS). Without it a record
 * supplied at `Number.MAX_SAFE_INTEGER` would parse, then produce a successor
 * whose arithmetic left the safe-integer range — and that successor would fail
 * every later parse, bricking the lease so it could never even be revoked.
 */
export const MAX_AUTHORITY_COUNT = Number.MAX_SAFE_INTEGER - 1_000_000;

export type AuthorityErrorCode =
  | "AUTHORITY_STALE_LEASE" | "AUTHORITY_STALE_EPOCH"
  | "AUTHORITY_SUPERSEDED_AUTHORITY" | "AUTHORITY_MALFORMED_INPUT";

export interface LeaseRecord {
  readonly leaseId: string;
  readonly kind: LeaseKind;
  /** Opaque session reference; no principal or credential generation is embedded. */
  readonly ownerSessionRef: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly state: LeaseState;
  readonly serverWallDeadline: number;
  readonly bootId: string;
  readonly monotonicObservation: number;
  readonly authorityHashRef: string;
  /** The record's optimistic-concurrency version, distinct from wire `attemptBindingVersion`. */
  readonly version: number;
}

export interface AuthorityProof {
  readonly leaseToken: string;
  readonly epoch: number;
  readonly authorityHashRef: string;
  readonly ownerSessionRef: string;
  readonly expectedVersion: number;
}

export interface ClockObservation {
  readonly serverWallSeconds: number;
  readonly bootId: string;
  readonly monotonicObservation: number;
}

export interface AuthorityIssue {
  readonly code: AuthorityErrorCode;
  readonly message: string;
}

/**
 * Redacted rejection-security record (design line 749). `leaseToken` is absent
 * by construction; the epoch pair is present because the runtime error registry
 * lists `expectedEpoch`/`observedEpoch` as required safe detail keys for the
 * stale-lease and stale-epoch families — blanket redaction would leave the
 * record unmappable.
 */
export interface RejectionSecurityRecord {
  readonly aggregateKind: "LEASE";
  readonly code: AuthorityErrorCode;
  readonly commandKind: string;
  readonly leaseId: string;
  readonly sourceState: LeaseState;
  readonly expectedEpoch: number;
  readonly observedEpoch: number;
}

export interface AuthorityRejection {
  readonly ok: false;
  readonly issues: readonly AuthorityIssue[];
  readonly securityRecord: RejectionSecurityRecord | null;
}
export type AuthorityOutcome<T> = { readonly ok: true; readonly value: T } | AuthorityRejection;

const HEX_64 = /^[0-9a-f]{64}$/u;

export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function isDigest(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && value <= MAX_AUTHORITY_COUNT && !Object.is(value, -0);
}
export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
/** Accepts only a plain record carrying exactly `keys` as own data properties. */
export function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, keys)) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}
export function stringList(value: unknown, maximum: number): readonly string[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length > maximum) return null;
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present || !isRef(read.value)) return null;
    output.push(read.value);
  }
  return output;
}
export function readList(value: unknown, maximum: number): readonly unknown[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length > maximum) return null;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) return null;
    output.push(read.value);
  }
  return output;
}

export function makeIssue(code: AuthorityErrorCode, message: string): AuthorityIssue {
  return deepFreeze({ code, message });
}
export function reject(
  issues: readonly AuthorityIssue[],
  securityRecord: RejectionSecurityRecord | null = null,
): AuthorityRejection {
  const sorted = [...issues].sort((left, right) =>
    compareStrings(JSON.stringify(left), JSON.stringify(right)));
  return deepFreeze({ ok: false, issues: sorted, securityRecord });
}
export function malformed(message: string): AuthorityRejection {
  return reject([makeIssue("AUTHORITY_MALFORMED_INPUT", message)]);
}
export function accept<T>(value: T): AuthorityOutcome<T> {
  return deepFreeze({ ok: true, value });
}
