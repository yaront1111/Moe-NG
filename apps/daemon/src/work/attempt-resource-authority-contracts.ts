/**
 * The vocabulary and strict decoders for the durable per-attempt resource set.
 *
 * WHY `state` IS A BARE STRING HERE, AND WHAT THAT DOES AND DOES NOT GUARANTEE.
 * `ACQUISITION_STATES` is not published on the `@moe/scheduler` root (measured:
 * zero hits in packages/scheduler/src/index.ts), so this module cannot pin the
 * vocabulary without re-declaring it — and a second declaration of a state
 * machine inside durable bytes is exactly the drift that makes a legitimately
 * QUARANTINED member start reading as something else. So the state is carried
 * VERBATIM. The property that makes it trustworthy is on the WRITE side and
 * nowhere else: the writer only ever persists rows an accepted public scheduler
 * reducer returned. The reader proves those bytes are canonical, complete and
 * self-consistent; it does NOT prove `state` is a scheduler vocabulary member,
 * and a planted event carrying an arbitrary token would be read back verbatim.
 * That is stated plainly rather than dressed up as an enum guarantee.
 *
 * TERMINALITY IS DELIBERATELY NOT DERIVED HERE. Consumers decide what a state
 * means; two definitions would drift silently.
 */

import { sha256Hex } from "./foundation-attempt-codec.js";

export const ATTEMPT_RESOURCE_RECORD_VERSION = "moe-attempt-resource-set/1" as const;
export const ATTEMPT_RESOURCE_BOUND_EVENT_TYPE = "AttemptResourcesBound" as const;
export const ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE = "AttemptResourceTransitioned" as const;
export const ATTEMPT_RESOURCE_BIND_COMMAND_KIND = "work.attempt_resources_bind" as const;
export const ATTEMPT_RESOURCE_APPLY_COMMAND_KIND = "work.attempt_resources_apply" as const;

/** This module's OWN layer. A refusal raised by the activation reader or by a
 *  scheduler reducer keeps ITS code, reported under the layer that made it. */
export const DAEMON_ATTEMPT_RESOURCE = "DAEMON_ATTEMPT_RESOURCE" as const;
/** The scheduler resource reducers' layer. Kept separate so a test cannot pass
 *  while a different layer starts answering first. Neither name ends in `_LAYER`,
 *  so the security-boundary roster does not scan them. */
export const SCHEDULER_RESOURCE_AUTHORITY = "SCHEDULER_RESOURCE_AUTHORITY" as const;

export type AttemptResourceLayer =
  | typeof DAEMON_ATTEMPT_RESOURCE
  | typeof SCHEDULER_RESOURCE_AUTHORITY;

/**
 * Closed, and every member names a DIFFERENT repair. ABSENT / UNREADABLE /
 * MALFORMED / AMBIGUOUS stay four codes and are never folded: an empty stream, a
 * store that threw, bytes that no longer re-encode, and two bind events are four
 * different faults with four different fixes.
 */
export const ATTEMPT_RESOURCE_CODES = Object.freeze([
  "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", "ATTEMPT_RESOURCE_SET_REFUSED",
  "ATTEMPT_RESOURCE_SET_NOT_ACTIVE", "ATTEMPT_RESOURCE_MEMBER_DUPLICATE",
  "ATTEMPT_RESOURCE_MEMBERSHIP_CHANGED", "ATTEMPT_RESOURCE_BINDING_MISMATCH",
  "ATTEMPT_RESOURCE_PROJECT_MISMATCH", "ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE",
  "ATTEMPT_RESOURCE_RECORD_ABSENT", "ATTEMPT_RESOURCE_RECORD_UNREADABLE",
  "ATTEMPT_RESOURCE_RECORD_MALFORMED", "ATTEMPT_RESOURCE_RECORD_AMBIGUOUS",
] as const);
export type AttemptResourceCode = (typeof ATTEMPT_RESOURCE_CODES)[number];

/** The exact seven fields of a scheduler `ResourceRow`, and no eighth. */
export const ATTEMPT_RESOURCE_MEMBER_KEYS = Object.freeze([
  "capacityUnits", "effectIntentRef", "epoch", "external", "fenceable", "resourceId", "state",
] as const);

export const ATTEMPT_RESOURCE_BODY_KEYS = Object.freeze([
  "attemptRef", "effectIntentRef", "memberCount", "members", "projectId", "recordVersion",
  "truthClass",
] as const);

export interface AttemptResourceMember {
  readonly capacityUnits: number;
  readonly effectIntentRef: string;
  readonly epoch: number;
  readonly external: boolean;
  readonly fenceable: boolean;
  readonly resourceId: string;
  /** Carried verbatim from the accepted reducer result; see the module note. */
  readonly state: string;
}

export interface AttemptResourceBody {
  readonly attemptRef: string;
  readonly effectIntentRef: string;
  readonly memberCount: number;
  readonly members: readonly AttemptResourceMember[];
  readonly projectId: string;
  readonly recordVersion: typeof ATTEMPT_RESOURCE_RECORD_VERSION;
  readonly truthClass: "DAEMON_VERIFIED";
}

/** Identity ONLY. No row list, no ref and no state: a caller says WHICH attempt,
 *  never WHAT its resources are. */
export interface AttemptResourceBinding {
  readonly activationAggregateId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** What the adapter said, never what the set becomes. The resulting states are
 *  the reducer's to decide, so no variant carries one. */
export type AttemptResourceReport =
  | { readonly kind: "CONFIRM"; readonly epoch: number; readonly resourceId: string }
  | {
      readonly kind: "FAIL"; readonly disposition: string; readonly epoch: number;
      readonly resourceId: string;
    }
  | { readonly kind: "GRANT"; readonly proofRef: string };

export interface AttemptResourceRefused {
  readonly authority: "NONE";
  readonly code: AttemptResourceCode;
  readonly ok: false;
  readonly refusedBy: AttemptResourceLayer;
  /** The upstream code verbatim, so a scheduler `AUTHORITY_*` refusal or an
   *  activation-reader `FOUNDATION_BINDING_*` refusal is never flattened. */
  readonly upstreamCode: string | null;
}

export interface AttemptResourceAnswer {
  readonly attemptRef: string;
  readonly authority: "DURABLE_RESOURCE_SET";
  readonly digest: string;
  readonly effectIntentRef: string;
  readonly members: readonly AttemptResourceMember[];
  readonly ok: true;
  readonly projectId: string;
}

export type AttemptResourceOutcome = AttemptResourceAnswer | AttemptResourceRefused;

export const refuseAttemptResource = (
  code: AttemptResourceCode, refusedBy: AttemptResourceLayer, upstreamCode: string | null = null,
): AttemptResourceRefused => Object.freeze({
  authority: "NONE" as const, code, ok: false as const, refusedBy, upstreamCode,
});

/** Every refusal from this module's own judgement. */
export const refuseLocalResource = (
  code: AttemptResourceCode, upstreamCode: string | null = null,
): AttemptResourceRefused =>
  refuseAttemptResource(code, DAEMON_ATTEMPT_RESOURCE, upstreamCode);

const encoder = new TextEncoder();

/**
 * Framed by this record version, as the sibling release aggregate is framed by
 * its own. The set may NOT share the activation aggregate: that stream is read
 * by a strict exactly-one-plus-ordered-tail reader, so an event of an unexpected
 * type there would make the ACTIVATION itself unreadable.
 */
export function deriveAttemptResourceAggregateId(activationAggregateId: string): string {
  const framed = `${ATTEMPT_RESOURCE_RECORD_VERSION}\n${activationAggregateId.length}\n`
    + activationAggregateId;
  return `attempt-resource-${sha256Hex(encoder.encode(framed))}`;
}

/** An exact-keyed REBUILD over own data properties. Never returns the input, so
 *  an accessor, a `__proto__` key or an extra field cannot ride through. */
function exactData(
  value: unknown, keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const own = Object.keys(value);
    if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch { return null; }
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const isCounted = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  && !Object.is(value, -0);

export function decodeAttemptResourceMember(value: unknown): AttemptResourceMember | null {
  const parsed = exactData(value, ATTEMPT_RESOURCE_MEMBER_KEYS);
  if (parsed === null) return null;
  if (!isText(parsed["resourceId"]) || !isText(parsed["effectIntentRef"])) return null;
  if (!isText(parsed["state"])) return null;
  if (!isCounted(parsed["capacityUnits"]) || !isCounted(parsed["epoch"])) return null;
  if (typeof parsed["external"] !== "boolean" || typeof parsed["fenceable"] !== "boolean") {
    return null;
  }
  return Object.freeze(parsed as unknown as AttemptResourceMember);
}

/**
 * `memberCount` is decoded and CROSS-CHECKED against the decoded array length
 * rather than trusted or recomputed. It exists so a record whose member array
 * was truncated in transit disagrees with itself instead of reading as a shorter
 * but well-formed set — the exact false-completeness this record prevents.
 */
export function decodeAttemptResourceBody(value: unknown): AttemptResourceBody | null {
  const parsed = exactData(value, ATTEMPT_RESOURCE_BODY_KEYS);
  if (parsed === null) return null;
  if (parsed["recordVersion"] !== ATTEMPT_RESOURCE_RECORD_VERSION) return null;
  if (parsed["truthClass"] !== "DAEMON_VERIFIED") return null;
  if (!isText(parsed["attemptRef"]) || !isText(parsed["effectIntentRef"])) return null;
  if (!isText(parsed["projectId"]) || !isCounted(parsed["memberCount"])) return null;
  const raw = parsed["members"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length !== parsed["memberCount"]) return null;
  const members: AttemptResourceMember[] = [];
  for (const item of raw) {
    const member = decodeAttemptResourceMember(item);
    if (member === null) return null;
    members.push(member);
  }
  parsed["members"] = Object.freeze(members);
  return Object.freeze(parsed as unknown as AttemptResourceBody);
}
