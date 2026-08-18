/**
 * Registration facts for `provider.probe`: what gets PERSISTED when a profile is admitted, and
 * the one content rule the durable stream enforces on its own history.
 *
 * These live beside the codec rather than inside the bootstrap service because they are facts
 * about the profile, not about the command envelope. The envelope's shape, its truth class and
 * its expected version remain the service's business and keep refusing at their own layer.
 */

import type { JsonValue } from "@moe/contracts";

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
 * A `profileRevisionId` is an identity, so the content behind it may never change.
 *
 * Re-probing the SAME content is idempotent: canonical encoding is deterministic, so an
 * identical body reproduces an identical digest and there is nothing to conflict with. The
 * same identity carrying different content is a conflict rather than an update — silently
 * accepting it would let an operator's earlier decision be rewritten under its own name.
 */
export function conflictsWithPriorProfile(
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
