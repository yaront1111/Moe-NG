/**
 * The strict CURRENT reader for one attempt's durable resource set.
 *
 * Split from the writer because that file crossed the 250-line target; admitting
 * a set through a reducer and replaying committed bytes are separable jobs.
 *
 * COMPLETENESS IS THE WHOLE POINT. Every bound member is returned exactly once or
 * the record is UNKNOWN. There is no path that answers with a SHORTER set: an
 * undecodable member, a member the fold cannot place, or a transition that adds
 * or drops one refuses under an exact code, because a resource that disappears
 * from this answer is a resource nobody will ever release.
 *
 * FAIL CLOSED, AND KEEP THE FOUR FAULTS APART. An empty stream (ABSENT), a store
 * that threw (UNREADABLE), bytes that no longer re-encode (MALFORMED) and two
 * bind events (AMBIGUOUS) name four different repairs. Every refusal carries
 * `authority: "NONE"` and grants nothing.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import {
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_RECORD_VERSION,
  ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, decodeAttemptResourceBody,
  deriveAttemptResourceAggregateId, refuseLocalResource,
} from "./attempt-resource-authority-contracts.js";
import type {
  AttemptResourceBody, AttemptResourceMember, AttemptResourceOutcome, AttemptResourceRefused,
} from "./attempt-resource-authority-contracts.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes,
} from "./foundation-attempt-codec.js";

const MALFORMED = "ATTEMPT_RESOURCE_RECORD_MALFORMED" as const;

/**
 * Shape and ORDER, before a single byte is decoded.
 *
 * The first event must be the bind at aggregateSequence 1; a second bind anywhere
 * is AMBIGUOUS and is never resolved by picking one. A sequence hole or an
 * out-of-order sequence is MALFORMED rather than silently folded, because the
 * fold's "the later transition wins" rule is only meaningful over a stream whose
 * order the store still vouches for.
 */
function frameRefusal(events: readonly StoredEvent[]): AttemptResourceRefused | null {
  for (const [index, event] of events.entries()) {
    if (event.aggregateSequence !== index + 1) return refuseLocalResource(MALFORMED);
    if (event.eventType === ATTEMPT_RESOURCE_BOUND_EVENT_TYPE) {
      if (index !== 0) return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_AMBIGUOUS");
      continue;
    }
    if (event.eventType !== ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE) {
      return refuseLocalResource(MALFORMED);
    }
    // A transition with no bind in front of it is evidence about no set at all.
    if (index === 0) return refuseLocalResource(MALFORMED);
  }
  return null;
}

/**
 * Canonical bytes need BOTH halves. Decoding proves the payload is JSON this
 * codec accepts; re-encoding and comparing proves it still CANONICALISES to the
 * exact bytes on disk, which a digest check alone does not — a record whose key
 * order or number form drifted decodes fine and would otherwise pass.
 */
function decodeEvent(event: StoredEvent): AttemptResourceBody | AttemptResourceRefused {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return refuseLocalResource(MALFORMED);
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return refuseLocalResource(MALFORMED);
  const body = decodeAttemptResourceBody(decoded.value);
  return body === null ? refuseLocalResource(MALFORMED) : body;
}

/** Only a refusal carries `ok`; a decoded body and an open fold both lack it. */
const isRefusal = <T extends object>(
  value: T | AttemptResourceRefused,
): value is AttemptResourceRefused =>
  "ok" in value && (value as { ok: unknown }).ok === false;

const sameIds = (left: readonly string[], right: ReadonlySet<string>): boolean =>
  left.length === right.size && left.every((id) => right.has(id));

interface Fold {
  readonly bind: AttemptResourceBody;
  readonly members: Map<string, AttemptResourceMember>;
  readonly order: readonly string[];
}

/** The bind establishes membership; nothing after it may change the id set. */
function openFold(bind: AttemptResourceBody): Fold | AttemptResourceRefused {
  const members = new Map<string, AttemptResourceMember>();
  for (const member of bind.members) {
    if (members.has(member.resourceId)) {
      return refuseLocalResource("ATTEMPT_RESOURCE_MEMBER_DUPLICATE");
    }
    members.set(member.resourceId, member);
  }
  return { bind, members, order: bind.members.map((member) => member.resourceId) };
}

/**
 * A transition REPLACES the state of members it names and nothing else. It may
 * not introduce a member, drop one, or speak for a different attempt: either
 * would make this record say something about a set that was never bound.
 */
function applyTransition(fold: Fold, body: AttemptResourceBody): AttemptResourceRefused | null {
  if (body.attemptRef !== fold.bind.attemptRef
    || body.effectIntentRef !== fold.bind.effectIntentRef) {
    return refuseLocalResource("ATTEMPT_RESOURCE_BINDING_MISMATCH");
  }
  const ids = new Set(body.members.map((member) => member.resourceId));
  if (ids.size !== body.members.length || !sameIds(fold.order, ids)) {
    return refuseLocalResource("ATTEMPT_RESOURCE_MEMBERSHIP_CHANGED");
  }
  for (const member of body.members) fold.members.set(member.resourceId, member);
  return null;
}

/** A fingerprint of the ANSWER, not of the last event, so a consumer comparing
 *  digests is comparing the folded set it was actually given. */
function answer(fold: Fold, members: readonly AttemptResourceMember[]): AttemptResourceOutcome {
  const sealed = encodeFoundationPayload({
    attemptRef: fold.bind.attemptRef, effectIntentRef: fold.bind.effectIntentRef,
    members, projectId: fold.bind.projectId, recordVersion: ATTEMPT_RESOURCE_RECORD_VERSION,
  });
  if (!sealed.ok) return refuseLocalResource(MALFORMED);
  return Object.freeze({
    attemptRef: fold.bind.attemptRef, authority: "DURABLE_RESOURCE_SET" as const,
    digest: sealed.digest, effectIntentRef: fold.bind.effectIntentRef,
    members: Object.freeze(members), ok: true as const, projectId: fold.bind.projectId,
  });
}

export function readAttemptResources(
  store: SqliteEventStore, activationAggregateId: string, expectedProjectId: string,
): AttemptResourceOutcome {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(deriveAttemptResourceAggregateId(activationAggregateId)); }
  catch { return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_UNREADABLE"); }
  if (events.length === 0) return refuseLocalResource("ATTEMPT_RESOURCE_RECORD_ABSENT");
  const framed = frameRefusal(events);
  if (framed !== null) return framed;
  let fold: Fold | null = null;
  for (const event of events) {
    const body = decodeEvent(event);
    if (isRefusal(body)) return body;
    if (body.projectId !== expectedProjectId) {
      return refuseLocalResource("ATTEMPT_RESOURCE_PROJECT_MISMATCH");
    }
    if (fold === null) {
      const opened = openFold(body);
      if (isRefusal(opened)) return opened;
      fold = opened;
      continue;
    }
    const conflict = applyTransition(fold, body);
    if (conflict !== null) return conflict;
  }
  if (fold === null) return refuseLocalResource(MALFORMED);
  const current = fold.order.map((id) => fold.members.get(id));
  // Never skip a member and never synthesise one: an id the fold cannot place
  // makes the whole record UNKNOWN, not a shorter list.
  return current.every((member) => member !== undefined)
    ? answer(fold, current as readonly AttemptResourceMember[])
    : refuseLocalResource(MALFORMED);
}
