import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes,
} from "./foundation-attempt-codec.js";
import {
  FOUNDATION_ARTIFACT_MANIFEST_VERSION, canonicalArtifactRoster,
  deriveFoundationArtifactDigest, sealFoundationArtifactManifest,
} from "./foundation-artifact-manifest.js";

import type {
  FoundationArtifactLayer, FoundationArtifactManifest, FoundationArtifactManifestCode,
} from "./foundation-artifact-manifest.js";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

/**
 * THE DURABLE HOME of the Foundation attempt's artifact-roster manifest: one
 * append-only write on its own per-attempt aggregate, and one strict
 * project+attempt reader. Modelled on `release-handoff-binding.ts`, which solved
 * the same problem on this lane — read that file before changing this one.
 *
 * WHERE THE FOUNDATION LANE'S NONEMPTY FENCE LIVES, AND WHY IT IS HERE. The
 * runner pins `declaredArtifactRefs` empty at `foundation-workspace-capture.ts:221`
 * under an authored rationale: "a scanner that accepted refs from a caller would
 * be sealing a claim it never observed." That pin is the invariant this row
 * PRESERVES. The fence is repeated here as defence in depth for a rationale that
 * lives one package away — HERE rather than in the shared sealer because
 * `workspace-manifest.ts:214` legitimately accepts nonempty refs from OTHER
 * producers, and not in the manifest module either, which must stay total over a
 * bounded roster so its canonical ORDERING is reachable and therefore drillable.
 * THE DIRECTION MATTERS MORE THAN THE PRESENCE: this lane REFUSES a
 * caller-supplied nonempty roster, and a change making it WILLING to seal one
 * would be a defect even with every arm green.
 *
 * ABSENT IS THE NOT-ENUMERATED ARM and it carries its own code, distinct from
 * every other refusal here. An observed-empty seal can never answer ABSENT: it
 * wrote a row, so the reader finds one. That asymmetry is what makes
 * "sealed zero" and "nobody looked" different durable outcomes rather than two
 * readings of the same `[]`.
 */

const LAYER = "DAEMON_FOUNDATION_ARTIFACT_LEDGER";
/** MODULE-PRIVATE: only the TYPE escapes, matching the sibling modules. */
export type FoundationArtifactLedgerLayer = FoundationArtifactLayer | typeof LAYER;

export const FOUNDATION_ARTIFACT_LEDGER_CODES = Object.freeze([
  "FOUNDATION_ARTIFACT_LEDGER_ABSENT", "FOUNDATION_ARTIFACT_LEDGER_AMBIGUOUS",
  "FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH", "FOUNDATION_ARTIFACT_LEDGER_CONFLICT",
  "FOUNDATION_ARTIFACT_LEDGER_DRIFT", "FOUNDATION_ARTIFACT_LEDGER_HORIZON_MOVED",
  "FOUNDATION_ARTIFACT_LEDGER_IMMUTABLE",
  "FOUNDATION_ARTIFACT_LEDGER_PROJECT_MISMATCH",
  "FOUNDATION_ARTIFACT_LEDGER_ROSTER_UNAUTHORIZED",
  "FOUNDATION_ARTIFACT_LEDGER_UNREADABLE",
] as const);
export type FoundationArtifactLedgerCode =
  (typeof FOUNDATION_ARTIFACT_LEDGER_CODES)[number];

export const FOUNDATION_ARTIFACT_EVENT_TYPE = "FoundationArtifactManifestSealed";
const COMMAND_KIND = "foundation.artifact.seal";

export interface FoundationArtifactLedgerRefused {
  /** This module's own code, or the manifest layer's carried UNRESTAMPED. */
  readonly code: FoundationArtifactLedgerCode | FoundationArtifactManifestCode;
  readonly layer: FoundationArtifactLedgerLayer;
  readonly ok: false;
}
export interface FoundationArtifactLedgerAnswer {
  readonly manifest: FoundationArtifactManifest;
  readonly ok: true;
}
export type FoundationArtifactLedgerOutcome =
  FoundationArtifactLedgerAnswer | FoundationArtifactLedgerRefused;

/** THE DECISION KEY AND REQUEST BYTES ARE DERIVED HERE, not accepted: the key is
 *  `${commandId}:ARTIFACT` (the idiom `commitFoundationPhase` already uses) and
 *  the request identity IS the sealed bytes. Taking either from a caller would
 *  let two seals present one identity, or one seal present another's. */
export interface FoundationArtifactSealRequest {
  readonly attemptAggregateId: string; readonly attemptRef: string;
  readonly commandId: string; readonly correlationId: string;
  /** Forwarded from the capture answer. Nonempty is REFUSED on this lane. */
  readonly declaredArtifactRefs: unknown;
  readonly inputManifestSha256: string; readonly principalId: string;
  readonly projectId: string; readonly resultManifestSha256: string;
}

export interface FoundationArtifactQuery {
  readonly attemptAggregateId: string; readonly projectId: string;
}

const refuse = (
  code: FoundationArtifactLedgerRefused["code"],
  layer: FoundationArtifactLedgerLayer = LAYER,
): FoundationArtifactLedgerRefused => Object.freeze({ code, layer, ok: false as const });

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Per ATTEMPT and NOT content-addressed, so a re-seal APPENDS rather than
 * colliding. The PROJECT IS NOT IN THE KEY: keying by it would answer ABSENT —
 * "this attempt never sealed a roster" — where the truth is that the row belongs
 * to another project, which the body carries and the reader refuses on.
 */
export const deriveFoundationArtifactAggregateId = (
  attemptAggregateId: string,
): string => `foundation-artifact:${attemptAggregateId}`;

/** A durable instant off the attempt's own newest event, never a clock read: a
 *  wall-clock stamp would make a replay compose a second decision. `committedAt`
 *  is the store's own stamp on a row that already exists, so re-deriving this
 *  seal on the same attempt reproduces it. */
function durableInstant(store: SqliteEventStore, aggregateId: string): string | null {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); } catch { return null; }
  const newest = events[events.length - 1];
  return newest === undefined ? null : newest.committedAt;
}

/** The bytes this call would have written, already on the aggregate. */
function alreadySealed(store: SqliteEventStore, aggregateId: string, bytes: Uint8Array): boolean {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); } catch { return false; }
  return events.some((event) => event.eventType === FOUNDATION_ARTIFACT_EVENT_TYPE
    && sameBytes(event.payload, bytes));
}

/**
 * ARTIFACT IMMUTABILITY (task-e7b802bc, governor ruling comment-58e3481254b2 design (b)).
 *
 * One attempt gets ONE roster. A re-seal offering the SAME bytes replays clean and writes
 * nothing; a re-seal offering DIFFERENT bytes is REFUSED rather than appended. Before this,
 * `expectedVersion` was the row count, so a second seal committed and the reader's LATEST WINS
 * rule handed the newer body to a release that had already fenced the older one.
 *
 * IT DISCRIMINATES ON THE BODY, NOT ON THE ATTEMPT. A blanket second-seal ban would break the
 * replay path the store's own idempotence depends on, which is why the divergence between the
 * two branches below is asserted by a matched pair of arms rather than by one.
 *
 * IT DOES NOT CONSULT THE RELEASE BINDING, and that is deliberate and fail-closed. The ruling
 * scopes immutability to a RELEASE-BOUND attempt, but this module is handed only
 * `request.attemptAggregateId` — the DISPATCH id — while `readAttemptRelease` keys off the
 * ACTIVATION id, and `deriveDispatchAggregateId` is a one-way hash. Reaching the binding would
 * mean adding a field at the writer's call site, which the same ruling reserves
 * ("NOT this row's to change unilaterally"). The ruling also says: "Fail closed: on any doubt
 * about release-binding, refuse." So every differing re-seal refuses — a strict superset of
 * the ruled property, taken on that sentence's authority rather than by narrowing it.
 */
function immutabilityVerdict(
  store: SqliteEventStore, aggregateId: string, bytes: Uint8Array,
): FoundationArtifactLedgerRefused | "REPLAY" | "FIRST" {
  let events: readonly StoredEvent[];
  // NOT the swallow-to-false that `alreadySealed` can afford: a read this one cannot perform
  // is doubt about whether a roster exists, and doubt refuses.
  try { events = store.readEvents(aggregateId); }
  catch { return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE"); }
  const rows = events.filter((event) => event.eventType === FOUNDATION_ARTIFACT_EVENT_TYPE);
  if (rows.length === 0) return "FIRST";
  return rows.some((row) => sameBytes(row.payload, bytes))
    ? "REPLAY" : refuse("FOUNDATION_ARTIFACT_LEDGER_IMMUTABLE");
}

/**
 * Seal the roster and commit ONE event. The fence runs FIRST, before the
 * manifest is derived, so a caller-handed roster never even reaches a digest.
 */
export function sealFoundationArtifactRoster(
  store: SqliteEventStore, request: FoundationArtifactSealRequest,
): FoundationArtifactLedgerOutcome {
  const offered = request.declaredArtifactRefs;
  if (Array.isArray(offered) && offered.length > 0) {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_ROSTER_UNAUTHORIZED");
  }
  const sealed = sealFoundationArtifactManifest({
    attemptRef: request.attemptRef, declaredArtifactRefs: request.declaredArtifactRefs,
    inputManifestSha256: request.inputManifestSha256, projectId: request.projectId,
    resultManifestSha256: request.resultManifestSha256,
  });
  // THE MANIFEST LAYER'S CODE TRAVELS UNRESTAMPED. A binding this daemon could
  // not assemble and a roster the caller malformed demand opposite repairs.
  if (!sealed.ok) return refuse(sealed.code, sealed.layer);
  const encoded = encodeFoundationPayload(
    sealed.manifest as unknown as Record<string, unknown>);
  if (!encoded.ok) return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE");
  const decidedAt = durableInstant(store, request.attemptAggregateId);
  if (decidedAt === null) return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE");
  const aggregateId = deriveFoundationArtifactAggregateId(request.attemptAggregateId);
  // ORDERED AFTER `decidedAt` ON PURPOSE, so an attempt carrying no event still refuses
  // UNREADABLE exactly as it did before this guard existed.
  const verdict = immutabilityVerdict(store, aggregateId, encoded.bytes);
  if (verdict !== "FIRST" && verdict !== "REPLAY") return verdict;
  if (verdict === "REPLAY") return Object.freeze({ manifest: sealed.manifest, ok: true as const });
  const { commandId, principalId, projectId } = request;
  let committed = false;
  try {
    const response = store.commitExpectedVersionDecision({
      commandKind: COMMAND_KIND, committedResultBytes: encoded.bytes,
      correlationId: `${request.correlationId}:ARTIFACT`, decidedAt,
      events: [{
        eventId: `${encoded.digest}:ARTIFACT`,
        eventType: FOUNDATION_ARTIFACT_EVENT_TYPE, payload: encoded.bytes,
      }],
      expectedVersion: store.readEvents(aggregateId).length,
      key: { commandId: `${commandId}:ARTIFACT`, principalId, projectId },
      requestBytes: encoded.bytes, targetAggregateId: aggregateId,
    });
    committed = response.decision.effectDisposition === "EFFECTS_COMMITTED";
  } catch { committed = false; }
  // REPLAY-IDEMPOTENT ON IDENTICAL BYTES; a body that DIFFERS is a real conflict
  // and a second truth about one attempt's roster is never composed here.
  if (!committed && !alreadySealed(store, aggregateId, encoded.bytes)) {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_CONFLICT");
  }
  return Object.freeze({ manifest: sealed.manifest, ok: true as const });
}

const BODY_KEYS: readonly string[] = Object.freeze(["artifactDigest", "artifactRefCount",
  "artifactRefs", "attemptRef", "inputManifestSha256", "manifestVersion", "projectId",
  "resultManifestSha256"]);

/** Re-decoded AND re-encoded bytes, byte-compared: two objects can be
 *  deep-equal while their canonical bytes differ — a reordered or duplicated
 *  roster re-encodes to different bytes and is caught here rather than trusted. */
function decodeManifest(event: StoredEvent): FoundationArtifactManifest | null {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return null;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return null;
  const keys = Object.keys(decoded.value).sort();
  if (keys.length !== BODY_KEYS.length || !keys.every((key) => BODY_KEYS.includes(key))) {
    return null;
  }
  if (decoded.value["manifestVersion"] !== FOUNDATION_ARTIFACT_MANIFEST_VERSION) return null;
  const refs = decoded.value["artifactRefs"];
  const count = decoded.value["artifactRefCount"];
  if (!Array.isArray(refs) || typeof count !== "number") return null;
  // THE STATED COUNT IS RE-CHECKED AGAINST THE ROSTER IT CLAIMS TO DESCRIBE. A
  // row whose declared cardinality disagrees with its own refs is not evidence.
  if (count !== refs.length) return null;
  // AND THE DIGEST IS RE-DERIVED FROM THE ROSTER IT CLAIMS TO SEAL (DoD 3).
  // Canonical bytes prove the row was not re-serialized; they say NOTHING about
  // whether its digest belongs to its own refs, so a row carrying a foreign or
  // stale `artifactDigest` would otherwise read as evidence. This also re-runs
  // the ref validation, so a drifted roster cannot ride in on a well-formed body.
  const roster = canonicalArtifactRoster(refs);
  if (!roster.ok || roster.refs.length !== count) return null;
  const derived = deriveFoundationArtifactDigest(roster.refs);
  if (!derived.ok || derived.digest !== decoded.value["artifactDigest"]) return null;
  return Object.freeze(decoded.value as unknown as FoundationArtifactManifest);
}

/**
 * Strict project+attempt read. ABSENT is the not-enumerated answer; every other
 * arm names a durable inconsistency, and they demand different repairs.
 */
export function readFoundationArtifactManifest(
  store: SqliteEventStore, query: FoundationArtifactQuery,
): FoundationArtifactLedgerOutcome {
  if (!isText(query.attemptAggregateId) || !isText(query.projectId)) {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE");
  }
  const aggregateId = deriveFoundationArtifactAggregateId(query.attemptAggregateId);
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); } catch {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE");
  }
  const rows = events.filter((event) => event.eventType === FOUNDATION_ARTIFACT_EVENT_TYPE);
  if (rows.length === 0) return refuse("FOUNDATION_ARTIFACT_LEDGER_ABSENT");
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.aggregateSequence)) return refuse("FOUNDATION_ARTIFACT_LEDGER_AMBIGUOUS");
    seen.add(row.aggregateSequence);
  }
  // LATEST WINS: a re-seal after a further attempt event appends a second row.
  const manifest = decodeManifest(rows[rows.length - 1] as StoredEvent);
  if (manifest === null) return refuse("FOUNDATION_ARTIFACT_LEDGER_DRIFT");
  if (manifest.projectId !== query.projectId) {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_PROJECT_MISMATCH");
  }
  // AGGREGATE-SCOPED HORIZON, captured beside the decode and re-read here. A
  // GLOBAL horizon check would move on any unrelated write and refuse nearly
  // every read on a busy daemon; this one moves only if THIS roster moved.
  let after: readonly StoredEvent[];
  try { after = store.readEvents(aggregateId); } catch {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_UNREADABLE");
  }
  if (after.length !== events.length) {
    return refuse("FOUNDATION_ARTIFACT_LEDGER_HORIZON_MOVED");
  }
  return Object.freeze({ manifest, ok: true as const });
}

/** The attempt-binding check the consumer needs: a manifest sealed under
 *  attempt X is not evidence about attempt Y even inside the right project. */
export function readFoundationArtifactForAttempt(
  store: SqliteEventStore, query: FoundationArtifactQuery, attemptRef: string,
): FoundationArtifactLedgerOutcome {
  const answer = readFoundationArtifactManifest(store, query);
  if (!answer.ok) return answer;
  return answer.manifest.attemptRef === attemptRef
    ? answer : refuse("FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH");
}
