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
import { encodeProviderRuntimeObservationBytes } from "./provider-runtime-observation.js";
import type { ProviderRuntimeObservation } from "./provider-runtime-observation.js";

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
 * The persisted shape: the envelope's two facts, the CANONICAL profile and its digest, and —
 * when the probe carried one — the CANONICAL runtime observation as a second section.
 *
 * Both content sections are parsed back from their production encoders' own output, so the
 * durable bytes are the canonical bytes rather than whatever key order the object happened to
 * be built in. An identical body therefore re-persists identically, which is what makes a
 * re-probe byte-stable instead of merely equal.
 *
 * The observation is OPTIONAL and its absence adds no key at all. A probe that predates this
 * section is legal and reads back ABSENT; a probe that carries a section it cannot justify was
 * already refused upstream by the observation codec, so "absent" here never means "dropped".
 */
export function providerProbePayload(
  providerMinimumProfileRef: string,
  truthClass: string,
  revision: ProviderProfileRevision,
  observation: ProviderRuntimeObservation | null = null,
): JsonValue {
  const payload: Record<string, JsonValue> = {
    profile: JSON.parse(decoder.decode(encodeProviderProfileBytes(revision))) as JsonValue,
    profileDigest: revision.profileDigest,
    providerMinimumProfileRef,
    truthClass,
  };
  if (observation !== null) {
    payload.runtime = JSON.parse(
      decoder.decode(encodeProviderRuntimeObservationBytes(observation)),
    ) as JsonValue;
  }
  return payload;
}

function recordOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * The observation digest a persisted probe carries, or `null` when it carried no section.
 *
 * `null` is a CONTENT value here, not a "skip this comparison" sentinel: an identity that once
 * probed without an observation and comes back carrying one has changed what it says about
 * itself, and that is a rebind in exactly the sense this rule forbids.
 */
function observationDigestOf(payload: Readonly<Record<string, JsonValue>>): string | null {
  const runtime = recordOf(payload.runtime);
  if (runtime === null) return null;
  const digest = runtime.observationDigest;
  return typeof digest === "string" ? digest : null;
}

/**
 * Does ONE already-registered probe collide with the incoming content?
 *
 * Deliberately module-private: a caller holding only the previous probe would enforce the rule
 * against an adjacent pair, and one interleaved probe under a different identity would then be
 * enough to rebind a revision id to new content. `conflictsWithProfileHistory` is the only
 * supported entry point, so that mistake cannot be made from outside this module.
 *
 * Both sections are compared under the SAME identity. Comparing only the profile would let an
 * operator's `profileRevisionId` keep its meaning while the runtime evidence filed under it was
 * quietly replaced — the same laundering the whole-history sweep exists to stop, one field over.
 */
function conflictsWithPriorProfile(
  prior: JsonValue | undefined,
  revision: ProviderProfileRevision,
  observationDigest: string | null,
): boolean {
  const priorPayload = recordOf(prior);
  if (priorPayload === null) return false;
  const priorProfile = recordOf(priorPayload.profile);
  if (priorProfile === null) return false;
  if (priorProfile.profileRevisionId !== revision.profileRevisionId) return false;
  if (priorProfile.profileDigest !== revision.profileDigest) return true;
  return observationDigestOf(priorPayload) !== observationDigest;
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
  observation: ProviderRuntimeObservation | null = null,
): boolean {
  const observationDigest = observation === null ? null : observation.observationDigest;
  return registeredProfiles(store, aggregateId).some((prior) =>
    conflictsWithPriorProfile(prior, revision, observationDigest),
  );
}
