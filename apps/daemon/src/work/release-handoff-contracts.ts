/**
 * The vocabulary the server-owned `ReleaseHandoff` builder answers in (task-a20e8ef6).
 *
 * WHY A SEPARATE MODULE. The builder and its per-source readers both need these codes,
 * and a code roster that lives inside one of them makes the other import a module it
 * otherwise has no business depending on. It also keeps both production files under the
 * per-file cap without splitting a single responsibility across two.
 *
 * EIGHT REFUSAL CLASSES, EIGHT REPAIRS. Each names a DIFFERENT operator problem, so none
 * may collapse into another:
 *   ABSENT        the source was never written. Repair: run the producer.
 *   UNREADABLE    the store could not answer. Repair: the store.
 *   MALFORMED     the bytes decoded but disagree with their own contract.
 *   AMBIGUOUS     two rows answer for one fact and neither can be chosen.
 *   STALE         the source describes an earlier state of THIS attempt.
 *   FOREIGN       the source is internally valid but describes ANOTHER attempt.
 *   CONFLICTING   two sources disagree about the SAME attempt.
 *   HORIZON_MOVED a source aggregate grew while the handoff was being composed.
 * ABSENT and UNREADABLE in particular must not collapse: one says "nothing ran", the
 * other says "the store is broken", and an operator handed the wrong one repairs the
 * wrong thing.
 *
 * `RELEASE_HANDOFF_INEXACT` is not a source fault. It fires when this builder itself
 * would have returned a handoff whose key set is not exactly the scheduler's nine, and
 * it exists so that failure is attributable HERE rather than arriving downstream as
 * `exactRecord`'s generic `AUTHORITY_MALFORMED_INPUT`.
 */

/** This layer's stamp. A source refusal keeps ITS OWN code and layer in `upstream`. */
export const DAEMON_RELEASE_HANDOFF = "DAEMON_RELEASE_HANDOFF" as const;

export const RELEASE_HANDOFF_CODES = Object.freeze([
  "RELEASE_HANDOFF_INEXACT",
  "RELEASE_HANDOFF_REQUEST_INVALID",
  "RELEASE_HANDOFF_SOURCE_ABSENT",
  "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  "RELEASE_HANDOFF_SOURCE_CONFLICTING",
  "RELEASE_HANDOFF_SOURCE_FOREIGN",
  "RELEASE_HANDOFF_SOURCE_HORIZON_MOVED",
  "RELEASE_HANDOFF_SOURCE_MALFORMED",
  "RELEASE_HANDOFF_SOURCE_STALE",
  "RELEASE_HANDOFF_SOURCE_UNREADABLE",
] as const);

export type ReleaseHandoffCode = (typeof RELEASE_HANDOFF_CODES)[number];
export type ReleaseHandoffLayer = typeof DAEMON_RELEASE_HANDOFF;

/**
 * WHICH source answered badly. Named rather than free text so a test can pin the
 * attribution, and so a refusal that moves from one source to another is a visible
 * change rather than a reworded message.
 */
export const RELEASE_HANDOFF_SOURCES = Object.freeze([
  "artifact-manifest", "attempt-journal", "capture-context",
  "context-manifest", "step-record", "terminal-evidence",
] as const);

export type ReleaseHandoffSource = (typeof RELEASE_HANDOFF_SOURCES)[number];

/** The refusing authority when it was not this one, preserved rather than restamped. */
export interface ReleaseHandoffUpstream {
  readonly code: string;
  readonly layer: string;
}

/**
 * NO HANDOFF FIELD AND NO PARTIAL RECORD. A refusal carries the diagnosis and nothing
 * else: a shape that could hold eight of nine keys is a shape someone eventually reads
 * eight keys out of.
 */
export interface ReleaseHandoffRefused {
  readonly code: ReleaseHandoffCode;
  readonly layer: ReleaseHandoffLayer;
  readonly ok: false;
  readonly source: ReleaseHandoffSource | null;
  readonly upstream: ReleaseHandoffUpstream | null;
}

/**
 * The FOUR server facts the builder admits, and nothing else — the same four the context
 * seal port already takes on the live dispatch path (foundation-attempt-service.ts:328).
 *
 * `activationDigest` and the attempt aggregate id are DELIBERATELY ABSENT. Both are
 * resolved from the durable activation instead, which is what turns the session
 * cross-check into a comparison between two authorities rather than a caller agreeing
 * with itself. No digest, roster, next action or truth class can be spelled here, so none
 * can be smuggled.
 */
export interface ReleaseHandoffIdentity {
  readonly attemptRef: string;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export const RELEASE_HANDOFF_IDENTITY_KEYS: readonly string[] = Object.freeze([
  "attemptRef", "nodeKey", "projectId", "sessionId",
]);

/** The scheduler's roster, restated here ONLY so this module can assert it bidirectionally
 *  before returning. It is compared against the built object's own keys, never used to
 *  construct one, so a drift between the two rosters surfaces as a refusal rather than as
 *  a handoff quietly trimmed into shape. */
export const SCHEDULER_HANDOFF_KEYS: readonly string[] = Object.freeze([
  "activeProcessResourceFacts", "artifactDigest", "completedSteps", "contextDigest",
  "inputDigest", "journalDigest", "nextSafeAction", "truthClass", "worktreeDigest",
]);

/** The eight handoff facts the six durable sources produce. `truthClass` is absent: it is
 *  the builder's verdict on the READ, not a field any single source states. */
export interface ReleaseHandoffFacts {
  readonly artifactDigest: string;
  readonly completedSteps: readonly string[];
  readonly contextDigest: string;
  readonly inputDigest: string;
  readonly journalDigest: string;
  readonly nextSafeAction: string;
  readonly resourceFacts: readonly string[];
  readonly worktreeDigest: string;
}

export type ReleaseHandoffFactsResult = ReleaseHandoffFacts | ReleaseHandoffRefused;

export function refuseHandoff(
  code: ReleaseHandoffCode,
  source: ReleaseHandoffSource | null = null,
  upstream: ReleaseHandoffUpstream | null = null,
): ReleaseHandoffRefused {
  return Object.freeze({
    code, layer: DAEMON_RELEASE_HANDOFF, ok: false as const, source,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/** Bounded non-empty text; the identity admission's only shape rule. */
export const isHandoffText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8_192;

const HEX_64 = /^[0-9a-f]{64}$/u;

/** The scheduler parses all five digest fields with `isDigest`, which is exactly this.
 *  Checking it HERE means a source whose digest stopped being 64-hex is attributable to
 *  that source instead of arriving as one generic malformed-input. */
export const isHandoffDigest = (value: unknown): value is string =>
  typeof value === "string" && HEX_64.test(value);
