/**
 * The durable commit adapter for one provider run's telemetry.
 *
 * ONE call to `commitExpectedVersionDecision`, and no SQLite object of this
 * daemon's own: the codec-sealed record IS the event payload, so there is no side
 * table to keep in step with it.
 *
 * THIS MODULE COMPOSES; IT MINTS ALMOST NOTHING. `normalizeProviderUsage` runs
 * upstream inside @moe/runner's `buildProviderRunRecord`, the codec MINTS
 * `recordDigest`, `deriveProviderRunAggregateId` owns identity.
 *
 * THE UNIQUENESS MECHANISMS ARE BORROWED, not invented:
 *
 *   replay      the command-decision key. Its replay identity does NOT cover the
 *               events array, so a replay is answered by reading the derived
 *               aggregate back (`answerReplayed`), never by echoing the caller;
 *               that read is this module's only other store call;
 *   conflict    the aggregate-head primary key with expectedVersion ALWAYS 0 — a
 *               distinct command targeting a run that already committed observes
 *               version 1 and the STORE rejects it.
 *
 * THE EVENT ID IS DERIVED, and the choice is load-bearing in both directions.
 * Never `randomUUID`: `domain_events.event_id` is UNIQUE store-wide and that
 * uniqueness is a refusal mechanism a random id forfeits. Never the
 * `recordDigest`: content-addressing collides two distinct runs with identical
 * bodies while a changed-byte resubmit of ONE run does not — exactly inverted.
 * `commitWithApply` and `commitExpectedVersionDecisionWithApply` are NOT used:
 * `CommitApply` hands the callback a raw `DatabaseSync` for callers that write
 * their own tables, which the no-new-schema rail forbids. The `ProviderRunStore`
 * port does not name them, so this module could not reach for one by accident.
 */

import { createHash } from "node:crypto";

import type { ProviderRunRef } from "@moe/runner";
import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionResponse,
  DurableStoreErrorCode,
  StoredEvent,
} from "@moe/store";

import { decodeProviderRunRecord, encodeProviderRunRecord } from "./provider-run-codec.js";
import {
  PROVIDER_RUN_COMMAND_KIND,
  PROVIDER_RUN_EVENT_TYPE,
  PROVIDER_RUN_RECORD_VERSION,
  deriveProviderRunAggregateId,
} from "./provider-run-contracts.js";
import type { ProviderRunRecord, ProviderRunStore } from "./provider-run-contracts.js";
import { providerRunRefusal, providerRunUnknown } from "./provider-run-refusals.js";
import type { ProviderRunCode, ProviderRunRefusal } from "./provider-run-refusals.js";

const LEDGER = "PROVIDER_RUN_LEDGER";
const READER = "PROVIDER_RUN_READER";
/** Every provider run is the FIRST event on its own derived aggregate. */
const EXPECTED_VERSION = 0;
const EVENT_NAMESPACE = `${PROVIDER_RUN_RECORD_VERSION}|event|sha256:`;
const EVENT_ID_DOMAIN = "moe.provider-run.event-id.v1";
const textEncoder = new TextEncoder();

export interface ProviderRunCommitInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly key: CommandDecisionKey;
  /** Unknown by design: the codec is the only authority on what is a record. */
  readonly record: unknown;
  readonly requestBytes: Uint8Array;
}

export interface ProviderRunCommitSuccess {
  readonly ok: true;
  readonly aggregateId: string;
  readonly digest: string;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly record: ProviderRunRecord;
}

export type ProviderRunCommitResult = ProviderRunCommitSuccess | ProviderRunRefusal;

/**
 * The event id for one provider run. Length-framed like the aggregate id and for
 * the same reason: a bare join maps runRef 'a'/effect 'bc' onto the same bytes as
 * runRef 'ab'/effect 'c', and a separator alone is insufficient because a
 * component may contain it. The domain differs from the aggregate id's, so the
 * two identifiers can never coincide for the same run.
 */
export function deriveProviderRunEventId(ref: ProviderRunRef): string {
  const identity = [ref.provider, ref.runRef, ref.effectIntentId, ref.attemptRef, String(ref.epoch)];
  const hash = createHash("sha256").update(`${EVENT_ID_DOMAIN}\u0000`, "utf8");
  for (const component of identity) {
    const bytes = textEncoder.encode(component);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return `${EVENT_NAMESPACE}${hash.digest("hex")}`;
}

/**
 * Which of this family's codes each store condition becomes. Hand-written and
 * partial on purpose: an unlisted condition falls through to STORE_UNAVAILABLE
 * rather than being mapped by a rule nobody reviewed. STORE_INPUT_INVALID and
 * STORE_LIMIT_EXCEEDED are FIELD_INVALID because an input fault is OURS and
 * retrying one never succeeds; calling it unavailable says "retry forever", which
 * is what once masked a NUL byte inside a derived aggregate id.
 */
const THROWN_CODES: Readonly<Partial<Record<DurableStoreErrorCode, ProviderRunCode>>> =
  Object.freeze({
    COMMAND_ID_CONFLICT: "PROVIDER_RUN_IDEMPOTENCY_CONFLICT",
    DURABLE_ID_CONFLICT: "PROVIDER_RUN_IDEMPOTENCY_CONFLICT",
    EXPECTED_VERSION_CONFLICT: "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT",
    IDEMPOTENCY_CONFLICT: "PROVIDER_RUN_IDEMPOTENCY_CONFLICT",
    STORE_INPUT_INVALID: "PROVIDER_RUN_FIELD_INVALID",
    STORE_LIMIT_EXCEEDED: "PROVIDER_RUN_FIELD_INVALID",
  });

/**
 * Maps a thrown store error onto this family's vocabulary while preserving the
 * store's own code VERBATIM in `storeCode`. Flattening them would destroy a
 * distinction the tests assert separately: an expected-version conflict and a
 * reused event id are different facts, and a caller that cannot tell them apart
 * cannot decide whether retrying helps. A non-store throw carries no store code,
 * so `storeCode` stays null rather than being invented.
 */
function refuseThrown(error: unknown): ProviderRunRefusal {
  if (!(error instanceof DurableStoreError)) {
    return providerRunRefusal("REFUSED", "PROVIDER_RUN_STORE_UNAVAILABLE", LEDGER);
  }
  const code = THROWN_CODES[error.code] ?? "PROVIDER_RUN_STORE_UNAVAILABLE";
  return providerRunRefusal("REFUSED", code, LEDGER, error.code);
}

/**
 * An expected-version conflict is RETURNED, not thrown: the store writes a
 * NO_BUSINESS_EFFECT decision carrying `resultCode: "EXPECTED_VERSION_CONFLICT"`
 * and appends no domain event. Treating a returned decision as success because
 * the call did not throw is how a second run gets reported as committed while
 * nothing was written.
 */
function refuseDecided(response: CommandDecisionResponse): ProviderRunRefusal | null {
  if (response.decision.effectDisposition === "EFFECTS_COMMITTED") return null;
  const { resultCode } = response.decision;
  return providerRunRefusal("REFUSED", "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT", LEDGER, resultCode);
}

/**
 * Answers a REPLAYED disposition from the DURABLE bytes.
 *
 * The store's replay identity hashes the key, commandKind, targetAggregateId,
 * expectedVersion and requestBytes — not the `events` array. This adapter pins
 * commandKind and expectedVersion constant and derives the aggregate from the run
 * ref alone, so every other record field can drift while the store still,
 * correctly, reports a replay. Echoing the caller there would hand back authority
 * for a run nobody committed.
 * Unreadable evidence stays UNKNOWN and never becomes an ok result. Malformed,
 * truncated and digest-mismatched all collapse to RECORD_UNREADABLE at the READER
 * layer: the question is whether the durable bytes can be trusted, and they
 * cannot, in the same way.
 */
function answerReplayed(
  store: ProviderRunStore,
  aggregateId: string,
  candidateDigest: string,
): ProviderRunCommitResult {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch (error) {
    return refuseThrown(error);
  }
  // The filter is HERE rather than a relaxation of the exactly-one rule. This
  // aggregate may also carry unrelated events, and handing every one to the
  // decoder would read an ordinary foreign event as ambiguity. Zero provider-run
  // events still refuses, and two still refuse.
  const runs = events.filter((event) => event.eventType === PROVIDER_RUN_EVENT_TYPE);
  if (runs.length === 0) {
    // An empty aggregate and an aggregate holding only foreign events are
    // different facts, and a caller diagnosing a gap needs to know which.
    const absent = events.length === 0;
    return providerRunUnknown(
      absent ? "PROVIDER_RUN_EVIDENCE_ABSENT" : "PROVIDER_RUN_EVENT_TYPE_UNEXPECTED",
      READER,
    );
  }
  if (runs.length > 1) return providerRunUnknown("PROVIDER_RUN_EVIDENCE_AMBIGUOUS", READER);
  const durable = decodeProviderRunRecord(runs[0]?.payload);
  if (!durable.ok) return providerRunUnknown("PROVIDER_RUN_RECORD_UNREADABLE", READER);
  if (durable.digest !== candidateDigest) {
    // This ledger refusing, not the store: the store replayed correctly. So there
    // is no store code to preserve and `storeCode` stays null.
    return providerRunRefusal("REFUSED", "PROVIDER_RUN_REPLAY_DIVERGED", LEDGER);
  }
  return Object.freeze({
    aggregateId,
    digest: durable.digest,
    disposition: "REPLAYED" as const,
    ok: true as const,
    record: durable.record,
  });
}

export function commitProviderRunRecord(
  store: ProviderRunStore,
  input: ProviderRunCommitInput,
): ProviderRunCommitResult {
  // Returned UNCHANGED on refusal. Re-wrapping it into a ledger code would erase
  // which layer refused, and the codec's layer is the answer to that question.
  const encoded = encodeProviderRunRecord(input.record);
  if (!encoded.ok) return encoded;
  const { record } = encoded;
  const aggregateId = deriveProviderRunAggregateId(record.providerRunRef);
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: PROVIDER_RUN_COMMAND_KIND,
      committedResultBytes: encoded.bytes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      events: [
        {
          eventId: deriveProviderRunEventId(record.providerRunRef),
          eventType: PROVIDER_RUN_EVENT_TYPE,
          payload: encoded.bytes,
        },
      ],
      expectedVersion: EXPECTED_VERSION,
      key: input.key,
      requestBytes: input.requestBytes,
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return refuseThrown(error);
  }
  const refused = refuseDecided(response);
  if (refused !== null) return refused;
  if (response.disposition === "REPLAYED") {
    return answerReplayed(store, aggregateId, encoded.digest);
  }
  // COMMITTED: the store just wrote `encoded.bytes` verbatim, so the validated
  // record IS the durable record and re-reading it would prove nothing.
  return Object.freeze({
    aggregateId,
    digest: encoded.digest,
    disposition: "COMMITTED" as const,
    ok: true as const,
    record,
  });
}
