import type { SqliteEventStore } from "@moe/store";
import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { exact, isObject, ref } from "../json-record-shape.js";
import { decodePublicationCandidate, samePublicationApproval, validPublicationSha } from "./publication-approval-contracts.js";
import type { PublicationEffectIntent } from "./publication-effect-contracts.js";
import type { RepositoryExecutionOwner } from "./repository-execution-contracts.js";
import { NODE_PUBLISHER_PRINCIPAL_ID, publishAggregateId } from "./publish-receipt-contracts.js";

const KIND = "internal.repository.publication_intent";
const VERSION = "moe-publication-intent/1";
const encoder = new TextEncoder();
const hash = (parts: readonly string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const intentId = (projectId: string, goalId: string, decisionId: string) => hash([VERSION, projectId, goalId, decisionId]);
export const publicationOwnerDigest = (owner: RepositoryExecutionOwner): string =>
  hash([owner.projectId, owner.nodeRef, owner.storeId, owner.ownershipToken]);
const sameIntent = (left: PublicationEffectIntent, right: PublicationEffectIntent): boolean =>
  left.version === right.version && left.projectId === right.projectId && left.goalId === right.goalId
  && left.decisionId === right.decisionId && left.ownerDigest === right.ownerDigest
  && left.controllerId === right.controllerId && left.reservationRevision === right.reservationRevision
  && left.intendedAt === right.intendedAt && samePublicationApproval(left.candidate.approval, right.candidate.approval)
  && left.candidate.identity.root === right.candidate.identity.root
  && left.candidate.identity.gitDirectory === right.candidate.identity.gitDirectory;

export function readPublicationIntent(store: SqliteEventStore, projectId: string, goalId: string, decisionId: string): PublicationEffectIntent | null {
  const record = store.getCommandDecision({ projectId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, commandId: intentId(projectId, goalId, decisionId) });
  if (record === null) return null;
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) throw new Error("PUBLISH_INTENT_INVALID");
  const value = decoded.value as Record<string, unknown>;
  const keys = ["candidate", "controllerId", "decisionId", "goalId", "intendedAt", "ownerDigest", "projectId", "reservationRevision", "version"];
  const candidate = decodePublicationCandidate(value["candidate"]);
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || record.commandKind !== KIND || record.effectDisposition !== "EFFECTS_COMMITTED"
    || record.targetAggregateId !== publishAggregateId(goalId) || value["version"] !== VERSION
    || value["projectId"] !== projectId || value["goalId"] !== goalId || value["decisionId"] !== decisionId
    || candidate === null || typeof value["ownerDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["ownerDigest"])
    || typeof value["controllerId"] !== "string" || value["controllerId"] === ""
    || typeof value["reservationRevision"] !== "number" || !Number.isSafeInteger(value["reservationRevision"]) || value["reservationRevision"] < 1
    || typeof value["intendedAt"] !== "string" || value["intendedAt"] !== record.decidedAt) throw new Error("PUBLISH_INTENT_INVALID");
  return Object.freeze({ version: VERSION, projectId, goalId, decisionId, candidate, ownerDigest: value["ownerDigest"],
    reservationRevision: value["reservationRevision"], controllerId: value["controllerId"], intendedAt: value["intendedAt"] });
}

export function recordPublicationIntent(store: SqliteEventStore, input: PublicationEffectIntent): Readonly<{ intent: PublicationEffectIntent; replayed: boolean }> {
  const prior = readPublicationIntent(store, input.projectId, input.goalId, input.decisionId);
  if (prior !== null) {
    if (!sameIntent(prior, input)) throw new Error("PUBLISH_INTENT_CONFLICT");
    return { intent: prior, replayed: true };
  }
  const commandId = intentId(input.projectId, input.goalId, input.decisionId);
  const bytes = encoder.encode(JSON.stringify(input));
  const aggregateId = publishAggregateId(input.goalId);
  const written = store.commitExpectedVersionDecision({ commandKind: KIND, committedResultBytes: bytes,
    correlationId: "publication-intent", decidedAt: input.intendedAt,
    events: [{ eventId: `${commandId}-intended`, eventType: "RepositoryPublicationIntended", payload: encoder.encode(JSON.stringify({ decisionId: input.decisionId })) }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: bytes, targetAggregateId: aggregateId });
  if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("PUBLISH_INTENT_CONFLICT");
  const intent = readPublicationIntent(store, input.projectId, input.goalId, input.decisionId);
  if (intent === null) throw new Error("PUBLISH_INTENT_INVALID");
  if (!sameIntent(intent, input)) throw new Error("PUBLISH_INTENT_CONFLICT");
  return { intent, replayed: written.disposition === "REPLAYED" };
}

const TRANSMISSION_KIND = "internal.repository.publication_transmission";
const TRANSMISSION_VERSION = "moe-publication-transmission/1";
const TRANSMISSION_KEYS = ["decisionId", "goalId", "outcome", "projectId", "tipBefore", "transmittedAt", "version"];
const OUTCOMES = ["ACCEPTED", "REJECTED", "INDETERMINATE"] as const;
/** The remote tip could not be read before the push: a marker no observed tip can ever equal. */
export const PUBLICATION_TIP_UNREADABLE = "UNREADABLE";
export type PublicationPushOutcome = typeof OUTCOMES[number];
/**
 * The evidence of the ONE push under an intent, written once right after git answered: the remote
 * branch tip read before the push (a sha, null when the branch was absent, or UNREADABLE) and how
 * the push ended. It is its own event beside the intent, never new keys on moe-publication-intent/1,
 * so an intent recorded before this evidence existed still decodes, and simply has none.
 */
export interface PublicationTransmission {
  readonly projectId: string;
  readonly goalId: string;
  readonly decisionId: string;
  readonly tipBefore: string | null;
  readonly outcome: PublicationPushOutcome;
  readonly transmittedAt: string;
}
const transmissionId = (projectId: string, goalId: string, decisionId: string) => hash([TRANSMISSION_VERSION, projectId, goalId, decisionId]);
const knownOutcome = (value: unknown): value is PublicationPushOutcome => OUTCOMES.some((outcome) => outcome === value);

/** Absent, or malformed in any way, answers null: bad evidence must read exactly like no evidence. */
export function readPublicationTransmission(store: SqliteEventStore, projectId: string, goalId: string, decisionId: string): PublicationTransmission | null {
  const record = store.getCommandDecision({ projectId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, commandId: transmissionId(projectId, goalId, decisionId) });
  if (record === null || record.commandKind !== TRANSMISSION_KIND || record.effectDisposition !== "EFFECTS_COMMITTED"
    || record.targetAggregateId !== publishAggregateId(goalId)) return null;
  const decoded = decodeBoundedJsonBytes(record.resultBytes);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, TRANSMISSION_KEYS)) return null;
  const value = decoded.value; const tipBefore = value["tipBefore"]; const outcome = value["outcome"];
  if (value["version"] !== TRANSMISSION_VERSION || value["projectId"] !== projectId || value["goalId"] !== goalId
    || value["decisionId"] !== decisionId || value["transmittedAt"] !== record.decidedAt || !knownOutcome(outcome)
    || !(tipBefore === null || tipBefore === PUBLICATION_TIP_UNREADABLE || validPublicationSha(tipBefore))) return null;
  return Object.freeze({ projectId, goalId, decisionId, tipBefore, outcome, transmittedAt: record.decidedAt });
}

/** Written once per decision: the key is deterministic, so a second, different record throws. */
export function recordPublicationTransmission(store: SqliteEventStore, input: PublicationTransmission): void {
  const commandId = transmissionId(input.projectId, input.goalId, input.decisionId);
  const bytes = encoder.encode(JSON.stringify({ version: TRANSMISSION_VERSION, projectId: input.projectId, goalId: input.goalId,
    decisionId: input.decisionId, tipBefore: input.tipBefore, outcome: input.outcome, transmittedAt: input.transmittedAt }));
  const aggregateId = publishAggregateId(input.goalId);
  const written = store.commitExpectedVersionDecision({ commandKind: TRANSMISSION_KIND, committedResultBytes: bytes,
    correlationId: "publication-transmission", decidedAt: input.transmittedAt,
    events: [{ eventId: `${commandId}-transmitted`, eventType: "RepositoryPublicationTransmitted",
      payload: encoder.encode(JSON.stringify({ decisionId: input.decisionId, outcome: input.outcome })) }],
    expectedVersion: store.getAggregateVersion(aggregateId),
    key: { commandId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: bytes, targetAggregateId: aggregateId });
  if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("PUBLISH_TRANSMISSION_CONFLICT");
}

const OBSERVATION_KIND = "internal.repository.publication_observation";
const OBSERVATION_VERSION = "moe-publication-observation/1";
const OBSERVED_EVENT_TYPE = "RepositoryPublicationObserved";
const OBSERVATION_KEYS = ["decisionId", "expectedSha", "observedAt", "observedSha", "projectId", "reason", "version"];
/** No push evidence beside the intent: the push predates that record, or its write failed. */
export const PUBLICATION_PUSH_UNRECORDED = "UNRECORDED";
export type PublicationObservationReason = PublicationPushOutcome | typeof PUBLICATION_PUSH_UNRECORDED;
/**
 * The last observation of an UNRESOLVED publish: the remote tip read after the push (null when the
 * branch is absent there), the sha it should hold, and the push outcome from the transmission record
 * as the reason. Its own event beside the intent and the transmission, never new keys on either. It
 * is what the operator reads on the card, never authority to resolve anything.
 */
export interface PublicationObservation {
  readonly projectId: string;
  readonly goalId: string;
  readonly decisionId: string;
  readonly observedSha: string | null;
  readonly expectedSha: string;
  readonly reason: PublicationObservationReason;
  readonly observedAt: string;
}
const knownReason = (value: unknown): value is PublicationObservationReason => value === PUBLICATION_PUSH_UNRECORDED || knownOutcome(value);

/** Its OWN exact key set: a malformed observation is skipped, exactly like no observation. */
function decodeObservation(payload: Uint8Array, projectId: string, goalId: string): PublicationObservation | null {
  const decoded = decodeBoundedJsonBytes(payload);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, OBSERVATION_KEYS)) return null;
  const { decisionId, expectedSha, observedAt, observedSha, reason } = decoded.value;
  return decoded.value["version"] === OBSERVATION_VERSION && decoded.value["projectId"] === projectId && ref(decisionId) && ref(observedAt)
    && validPublicationSha(expectedSha) && (observedSha === null || validPublicationSha(observedSha)) && knownReason(reason)
    ? Object.freeze({ projectId, goalId, decisionId, observedSha, expectedSha, reason, observedAt }) : null;
}

/** Throws when the goal's publish aggregate cannot be read: a writer must never dedupe against a blind read. */
function latestObservation(store: SqliteEventStore, projectId: string, goalId: string, decisionId: string): PublicationObservation | null {
  let latest: PublicationObservation | null = null;
  for (const event of store.readEvents(publishAggregateId(goalId))) {
    if (event.eventType !== OBSERVED_EVENT_TYPE) continue;
    const observation = decodeObservation(event.payload, projectId, goalId);
    if (observation?.decisionId === decisionId) latest = observation;
  }
  return latest;
}

/** The decision's latest observation; null when there is none, or when the aggregate cannot be read. */
export function readPublicationObservation(store: SqliteEventStore, projectId: string, goalId: string, decisionId: string): PublicationObservation | null {
  try { return latestObservation(store, projectId, goalId, decisionId); } catch { return null; }
}

/**
 * Writes the observation only when it CHANGES against the decision's latest one (tip, expected sha or
 * reason), so a publish that stays unresolved writes once, never once per wrapper pass. An observation
 * that would not decode is never written. The fenced aggregate version is part of the decision key, so
 * returning to an earlier observation is a new write, never a replay of the earlier one. Throws, writing
 * nothing, when the aggregate cannot be read.
 */
export function recordPublicationObservation(store: SqliteEventStore, input: PublicationObservation): void {
  const body = JSON.stringify({ version: OBSERVATION_VERSION, projectId: input.projectId, decisionId: input.decisionId,
    observedSha: input.observedSha, expectedSha: input.expectedSha, reason: input.reason, observedAt: input.observedAt });
  const payload = encoder.encode(body);
  if (decodeObservation(payload, input.projectId, input.goalId) === null) return;
  const prior = latestObservation(store, input.projectId, input.goalId, input.decisionId);
  if (prior !== null && prior.observedSha === input.observedSha && prior.expectedSha === input.expectedSha && prior.reason === input.reason) return;
  const aggregateId = publishAggregateId(input.goalId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = hash([OBSERVATION_KIND, input.goalId, body, String(expectedVersion)]);
  store.commitExpectedVersionDecision({ commandKind: OBSERVATION_KIND, committedResultBytes: payload,
    correlationId: "publication-observation", decidedAt: input.observedAt,
    events: [{ eventId: `${commandId}-observed`, eventType: OBSERVED_EVENT_TYPE, payload }], expectedVersion,
    key: { commandId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: payload, targetAggregateId: aggregateId });
}

/**
 * Records what an UNKNOWN pass saw, with the push outcome journaled beside the intent as its reason.
 * Every failure is swallowed: the observation is for the operator to read, and it can never change
 * the outcome of the pass that made it.
 */
export function notePublicationObservation(store: SqliteEventStore, seen: Omit<PublicationObservation, "reason">): void {
  try {
    const sent = readPublicationTransmission(store, seen.projectId, seen.goalId, seen.decisionId);
    recordPublicationObservation(store, { ...seen, reason: sent?.outcome ?? PUBLICATION_PUSH_UNRECORDED });
  } catch { /* the card keeps the last observation; the next UNKNOWN pass observes again */ }
}
