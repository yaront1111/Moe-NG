/** The durable half: identities, the one commit port, and byte-checked reads. */

import type {
  VerificationRecipe, WorkspaceInputManifest, WorkspaceResultManifest,
} from "@moe/runner";
import { DurableStoreError } from "@moe/store";
import type { CommandDecisionResponse, SqliteEventStore, StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, isRecord, sameBytes,
} from "../work/foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "../work/foundation-attempt-store.js";
import {
  FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_EVENT_TYPES, carryAttemptRefusal,
  carryStoreRefusal, refuseVerification,
} from "./foundation-verification-contracts.js";
import type {
  FoundationVerificationOutcome, FoundationVerificationRefused, FoundationVerificationVerdict,
} from "./foundation-verification-contracts.js";

export const deriveRecipeAggregateId = (id: string): string => `foundation-verify-recipe:${id}`;
export const deriveVerificationAggregateId = (id: string): string => `foundation-verify:${id}`;

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function nestedRecord(
  value: Record<string, unknown>, key: string,
): Record<string, unknown> | null {
  const found = value[key];
  return isRecord(found) ? found : null;
}

export interface CommitIdentity {
  readonly principalId: string; readonly projectId: string;
}

export type PhaseTag = keyof typeof FOUNDATION_VERIFICATION_EVENT_TYPES;

/**
 * A thrown `DurableStoreError` is the store's OWN refusal and is carried as
 * such. Anything else is not a refusal at all: an unrecognised fault propagates
 * rather than being flattened into a durable claim, the same rule the command
 * seam's `refusalFor` applies one layer up.
 */
function refuseThrown(error: unknown): FoundationVerificationRefused {
  if (error instanceof DurableStoreError) return carryStoreRefusal(error);
  throw error;
}

/**
 * The three things a commit can come back as, kept apart because they license
 * opposite conclusions. COMMITTED: the store wrote the row. REJECTED: the store
 * RETURNED a NO_BUSINESS_EFFECT decision -- the aggregate was not at
 * `expectedVersion`, it appended nothing, and it says so; this is the only
 * disposition a caller may report as "zero rows written". FAILED: the codec or
 * the store REFUSED, and the refusal is the producer's own -- an OUTCOME_UNKNOWN
 * may have landed the row, so collapsing it into REJECTED would turn "the store
 * cannot tell" into "definitely not".
 */
export type PhaseCommit =
  | { readonly kind: "COMMITTED" }
  | { readonly kind: "REJECTED"; readonly observedVersion: number }
  | { readonly kind: "FAILED"; readonly refused: FoundationVerificationRefused };

/**
 * The ONE write port used here: `commitExpectedVersionDecision`, the narrow
 * expected-version port the dispatch slice established.
 *
 * The store's two apply-callback variants are deliberately NOT used and are not
 * named anywhere in this slice, so a grep for them over apps/daemon/src/evidence
 * returns nothing: they hand their callback a raw `DatabaseSync`, which the
 * no-new-schema rail forbids. This is the only way durable state changes here.
 */
export function commitPhase(
  store: SqliteEventStore, who: CommitIdentity, aggregateId: string, tag: PhaseTag,
  body: Record<string, unknown>, expectedVersion: number, suffix: string,
): PhaseCommit {
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) return { kind: "FAILED", refused: carryAttemptRefusal(encoded) };
  let written: CommandDecisionResponse;
  try {
    written = store.commitExpectedVersionDecision({
      commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND, committedResultBytes: encoded.bytes,
      correlationId: `${aggregateId}:${tag}`, decidedAt: new Date().toISOString(),
      events: [{
        eventId: `${aggregateId}:${suffix}`, eventType: FOUNDATION_VERIFICATION_EVENT_TYPES[tag],
        payload: encoded.bytes,
      }],
      expectedVersion,
      key: {
        commandId: `${aggregateId}:${suffix}`, principalId: who.principalId,
        projectId: who.projectId,
      },
      requestBytes: encoded.bytes, targetAggregateId: aggregateId,
    });
  } catch (error) {
    return { kind: "FAILED", refused: refuseThrown(error) };
  }
  return written.decision.effectDisposition === "EFFECTS_COMMITTED"
    ? { kind: "COMMITTED" }
    : { kind: "REJECTED", observedVersion: written.decision.observedVersion };
}

export type EventsRead =
  | { readonly events: readonly StoredEvent[]; readonly ok: true }
  | FoundationVerificationRefused;

/** A read the store refuses is carried, never answered as an empty aggregate:
 *  "no events" would go on to mean ABSENT, unresolved or UNPROVEN, each a
 *  positive durable claim the store never made. */
export function eventsOf(store: SqliteEventStore, aggregateId: string): EventsRead {
  try { return { events: store.readEvents(aggregateId), ok: true }; }
  catch (error) { return refuseThrown(error); }
}

export const typed = (
  events: readonly StoredEvent[], tag: PhaseTag,
): readonly StoredEvent[] =>
  events.filter((event) => event.eventType === FOUNDATION_VERIFICATION_EVENT_TYPES[tag]);

/**
 * DoD 5's byte discipline. The answer is RE-DECODED durable bytes that are then
 * RE-ENCODED and byte-compared against what the store actually holds — the same
 * discipline `readStoredFoundationAttempt` uses. Two objects can be deep-equal
 * while their canonical bytes differ, and it is the BYTES review and closure
 * will hash, so a decode alone would not be enough.
 */
function answerFromEvent(event: StoredEvent): FoundationVerificationOutcome {
  const unreadable = refuseVerification(
    "FOUNDATION_VERIFICATION_RECEIPT_UNREADABLE", "DAEMON_VERIFICATION_RECEIPT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return unreadable;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return unreadable;
  const receipt = nestedRecord(decoded.value, "receipt");
  const verdict = decoded.value["verdict"];
  if (receipt === null || (verdict !== "PASSED" && verdict !== "FAILED")) return unreadable;
  return Object.freeze({
    authority: "PROVEN_RECEIPT" as const, digest: again.digest, ok: true as const,
    row: Object.freeze(decoded.value), verdict: verdict as FoundationVerificationVerdict,
  });
}

/** An unreadable receipt is UNKNOWN; an ABSENT one is a different answer, because
 *  "no receipt" and "unreadable receipt" lead a reviewer to opposite conclusions.
 *  A store that will not read at all is a third: ITS refusal, not an absence. */
export function readStoredReceipt(
  store: SqliteEventStore, verificationId: string,
): FoundationVerificationOutcome {
  const read = eventsOf(store, deriveVerificationAggregateId(verificationId));
  if (!read.ok) return read;
  const found = typed(read.events, "RECEIPTED");
  if (found.length > 1) {
    return refuseVerification(
      "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS", "DAEMON_VERIFICATION_RECEIPT");
  }
  const event = found[0];
  return event === undefined
    ? refuseVerification("FOUNDATION_VERIFICATION_RECEIPT_ABSENT", "DAEMON_VERIFICATION_RECEIPT")
    : answerFromEvent(event);
}

export interface SealedRecipe {
  readonly recipe: VerificationRecipe;
  readonly runtime: unknown;
}

/** `null` is "no usable sealed recipe": absent, doubled, or not decoding. A
 *  store that refuses the read is carried instead, because "unresolved" would
 *  have the sealer write a first seal over an identity it could not see. */
export function storedRecipe(
  store: SqliteEventStore, recipeAggregateId: string,
): SealedRecipe | FoundationVerificationRefused | null {
  const read = eventsOf(store, deriveRecipeAggregateId(recipeAggregateId));
  if (!read.ok) return read;
  const found = typed(read.events, "RECIPE_SEALED");
  const event = found[0];
  if (found.length !== 1 || event === undefined) return null;
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return null;
  const recipe = nestedRecord(decoded.value, "recipe");
  const runtime = decoded.value["runtimeObservation"];
  return recipe === null || !isRecord(runtime)
    ? null
    : { recipe: recipe as unknown as VerificationRecipe, runtime };
}

export interface Loaded {
  readonly activation: ActivationLedgerRecord;
  readonly inputManifest: WorkspaceInputManifest;
  readonly record: Record<string, unknown>;
  readonly resultManifest: WorkspaceResultManifest;
}

/**
 * Every field comes from RE-DECODED durable bytes; nothing is taken from the
 * caller, which is why the request type has nowhere to put a substitute.
 */
export function loadDurable(
  store: SqliteEventStore, who: CommitIdentity, attemptAggregateId: string,
  expectedRecordDigest: string,
): Loaded | FoundationVerificationRefused {
  const stored = readFoundationAttemptRecord(store, attemptAggregateId);
  if (!stored.ok) return carryAttemptRefusal(stored);
  if (stored.digest !== expectedRecordDigest) {
    return refuseVerification(
      "FOUNDATION_VERIFICATION_CANDIDATE_STALE", "DAEMON_VERIFICATION_IDENTITY");
  }
  const { record } = stored;
  const inputManifest = nestedRecord(record, "inputManifest");
  const resultManifest = nestedRecord(record, "resultManifest");
  const ledger = eventsOf(store, attemptAggregateId);
  if (!ledger.ok) return ledger;
  const history = readFoundationActivationHistory(
    attemptAggregateId, ledger.events, who.projectId);
  // One condition, one code: "this attempt is not usable as proven ground",
  // whether that is a non-PROVEN truth class, a missing manifest, or an
  // activation ledger that no longer reads back. Splitting it would be two
  // vocabularies for one question. A ledger the STORE would not hand over is
  // not one of them: that is the store's refusal, carried above.
  if (record["truthClass"] !== "PROVEN" || inputManifest === null || resultManifest === null
    || !history.ok) {
    return refuseVerification(
      "FOUNDATION_VERIFICATION_ATTEMPT_UNPROVEN", "DAEMON_VERIFICATION_IDENTITY");
  }
  return {
    activation: history.history.record,
    inputManifest: inputManifest as unknown as WorkspaceInputManifest, record,
    resultManifest: resultManifest as unknown as WorkspaceResultManifest,
  };
}
