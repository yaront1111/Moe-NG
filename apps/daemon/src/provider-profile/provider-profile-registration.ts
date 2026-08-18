/**
 * Registration facts for `provider.probe`: what gets PERSISTED when a profile is admitted, and
 * the one content rule the durable stream enforces on its own history.
 *
 * These live beside the codec rather than inside the bootstrap service because they are facts
 * about the profile, not about the command envelope. The envelope's shape, its truth class and
 * its expected version remain the service's business and keep refusing at their own layer.
 */

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { encodeProviderProfileBytes } from "./provider-profile-codec.js";
import type {
  ProviderProfileRegistrationLayer,
  ProviderProfileRevision,
} from "./provider-profile-codec.js";

/**
 * The layer name is a closed TYPE from the codec rather than a bare string, so a rename there
 * becomes a compile error here instead of a refusal naming a layer nobody publishes. The same
 * literal is a member of `SERVICE_REFUSED_BY`, which is what lets it travel as `refusedBy`.
 */
export const PROFILE_REGISTRATION: ProviderProfileRegistrationLayer =
  "PROVIDER_PROFILE_REGISTRATION";

/**
 * The single event type this seam writes, and therefore the only one its history rule reads.
 *
 * The commit site and the history scan share this constant so the rule can never end up
 * reading a stream the probe does not write: changing the written type changes what is read,
 * in one edit, instead of leaving a scan that silently matches nothing.
 */
export const PROVIDER_PROBED_EVENT = "ProviderProbed";

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The persisted shape: the envelope's two facts, plus the CANONICAL profile and its digest.
 *
 * The profile value is parsed back from the production encoder's own output, so the durable
 * bytes are the canonical bytes rather than whatever key order the revision object happened to
 * be built in. An identical body therefore re-persists identically, which is what makes a
 * re-probe byte-stable instead of merely equal.
 */
export function providerProbePayload(
  providerMinimumProfileRef: string,
  truthClass: string,
  revision: ProviderProfileRevision,
): JsonValue {
  return {
    profile: JSON.parse(decoder.decode(encodeProviderProfileBytes(revision))) as JsonValue,
    profileDigest: revision.profileDigest,
    providerMinimumProfileRef,
    truthClass,
  };
}

function recordOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * Does ONE already-registered profile collide with the incoming revision?
 *
 * Deliberately module-private: a caller holding only the previous probe would enforce the rule
 * against an adjacent pair, and one interleaved probe under a different identity would then be
 * enough to rebind a revision id to new content. `conflictsWithProfileHistory` is the only
 * supported entry point, so that mistake cannot be made from outside this module.
 */
function conflictsWithPriorProfile(
  prior: JsonValue | undefined,
  revision: ProviderProfileRevision,
): boolean {
  const priorPayload = recordOf(prior);
  if (priorPayload === null) return false;
  const priorProfile = recordOf(priorPayload.profile);
  if (priorProfile === null) return false;
  if (priorProfile.profileRevisionId !== revision.profileRevisionId) return false;
  return priorProfile.profileDigest !== revision.profileDigest;
}

/**
 * Every profile this aggregate has ever registered, in commit order.
 *
 * The durable event stream is read rather than the decision ledger because the ledger keeps a
 * single row per aggregate and overwrites it on every commit — a rule read from it can only
 * ever see the immediately preceding probe. A payload that does not decode cannot claim an
 * identity, so it is skipped rather than treated as a match on one.
 */
function registeredProfiles(store: SqliteEventStore, aggregateId: string): readonly JsonValue[] {
  const profiles: JsonValue[] = [];
  for (const event of store.readEvents(aggregateId)) {
    if (event.eventType !== PROVIDER_PROBED_EVENT) continue;
    const decoded = decodeBoundedJsonBytes(event.payload);
    if (decoded.ok) profiles.push(decoded.value);
  }
  return profiles;
}

/**
 * A `profileRevisionId` is an identity, so the content behind it may never change — and that is
 * a claim about the WHOLE history, not about the previous probe.
 *
 * Re-probing the SAME content is idempotent at any distance: canonical encoding is
 * deterministic, so an identical body reproduces an identical digest and there is nothing to
 * conflict with. The same identity carrying different content is a conflict rather than an
 * update — silently accepting it would let an operator's earlier decision be rewritten under
 * its own name, and would hand every downstream resolver an ambiguous id -> content map.
 */
export function conflictsWithProfileHistory(
  store: SqliteEventStore,
  aggregateId: string,
  revision: ProviderProfileRevision,
): boolean {
  return registeredProfiles(store, aggregateId).some((prior) =>
    conflictsWithPriorProfile(prior, revision),
  );
}
