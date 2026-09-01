/**
 * THE PRODUCTION PRE-LAUNCH CONTEXT SEAL, and the strict readback its consumer reads.
 *
 * WHAT THIS MODULE IS NOT. It does not render, digest, encode, commit or read a context
 * manifest: `@moe/context` owns the first two, the codec the third, the ledger the fourth, the
 * reader the fifth, and `foundation-context-prelaunch` already composes all five in one fixed
 * order. Re-deriving any of them here would be a SECOND derivation of the same fact, drifting
 * from the canonicalisation the consumer verifies against. This is the seam between that
 * composition and the attempt dispatch.
 *
 * THE DIGEST IS NEVER COMPUTED HERE. `contextManifestDigest` is copied out of the DURABLE
 * record the ledger handed back — the digest `renderContext` sealed over the exact bytes it
 * emitted. Nothing in this file hashes argv, a ref, an identity or a re-render, because a
 * digest over anything but the delivered bytes attests to something that was never sent.
 *
 * FAIL CLOSED WHEN THE SERVER IS NOT BOUND: `unconfiguredFoundationContextSealPort` refuses
 * every seal rather than letting a provider launch with no recorded context. That refusal IS
 * the guarantee — no provider effect happens before the durable context decision.
 *
 * CONSUMER: task-af9454f4438242e5854208284e0086e2, which reads `contextManifestDigest` for the
 * release handoff and `readSealedFoundationContext` to reconstruct the record it names.
 */

import type { SqliteEventStore } from "@moe/store";

import type { ProjectConfigurationStore } from "../configuration/project-configuration-selection.js";
import type { NodeBriefDeps } from "../planning/node-mission-producer.js";
import { resolveCurrentProviderProfile }
  from "../provider-profile/provider-profile-resolver.js";
import { readCurrentRuntimeObservation }
  from "../provider-profile/provider-runtime-observation-reader.js";
import type { FoundationContextSlotIdentity }
  from "./foundation-context-manifest-identity.js";
import type { FoundationContextExpectedBinding }
  from "./foundation-context-manifest-proofs.js";
import { readFoundationContextManifest } from "./foundation-context-manifest-reader.js";
import type { FoundationContextReadPort, FoundationContextStrictResult }
  from "./foundation-context-manifest-reader.js";
import { prepareFoundationContextForLaunch } from "./foundation-context-prelaunch.js";
import type { FoundationPrelaunchServices } from "./foundation-context-prelaunch.js";
import { createFoundationContextAuthority } from "./foundation-context-selection.js";
import type { LaunchTemplateFields } from "./launch-template-producer.js";

export { FOUNDATION_CONTEXT_READER, FOUNDATION_CONTEXT_STRICT_CODES }
  from "./foundation-context-manifest-reader.js";
export type {
  FoundationContextReadPort, FoundationContextStrictCode, FoundationContextStrictResult,
} from "./foundation-context-manifest-reader.js";
export type { FoundationContextExpectedBinding }
  from "./foundation-context-manifest-proofs.js";

/** Module-private stamp, published as a closed type; the literal rides on every refusal. */
const LAYER = "FOUNDATION_CONTEXT_SEAL";
export const FOUNDATION_CONTEXT_SEAL_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_SEAL_CONFIGURATION_UNBOUND", "FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE",
  "FOUNDATION_CONTEXT_SEAL_REFUSED", "FOUNDATION_CONTEXT_SEAL_RUNTIME_UNOBSERVED",
  "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED",
] as const);
export type FoundationContextSealCode = (typeof FOUNDATION_CONTEXT_SEAL_CODES)[number];
export type FoundationContextSealLayer = typeof LAYER;
export type FoundationContextSealUpstream = Readonly<{ code: string; layer: string }>;
/** The four-key identity the selection authority admits, and nothing else. */
export interface FoundationContextSealIdentity {
  readonly attemptRef: string; readonly nodeKey: string;
  readonly projectId: string; readonly sessionId: string;
}

/**
 * Narrow launch answer: durable digest/bytes and the exact prepared template, all forwarded
 * verbatim; no caller can substitute another authority field.
 */
export interface FoundationContextSealed {
  readonly bytes: readonly number[];
  readonly contextManifestDigest: string; readonly ok: true;
  readonly template: LaunchTemplateFields;
}

/** No bytes and no digest: partial authority is unrepresentable, not merely unset. */
export interface FoundationContextSealRefusal {
  readonly code: FoundationContextSealCode; readonly detail: string;
  readonly layer: FoundationContextSealLayer; readonly ok: false;
  /** The refusing authority when it was not this one, preserved rather than restamped. */
  readonly upstream: FoundationContextSealUpstream | null;
}

export type FoundationContextSealResult = FoundationContextSealed | FoundationContextSealRefusal;
/**
 * ONE METHOD, taking identity plus the durable stamp this dispatch was decided under. Context
 * bytes, a digest, a manifest, argv and a graph revision are unrepresentable here: a key that
 * cannot be spelled cannot be smuggled.
 */
export interface FoundationContextSealPort {
  sealFoundationContext(
    identity: FoundationContextSealIdentity, decidedAt: string,
  ): FoundationContextSealResult;
}

/** Exactly the prelaunch services minus its per-call stamp: a server binds these once. */
export type FoundationContextSealServices = Omit<FoundationPrelaunchServices, "decidedAt">;
export interface FoundationContextSealConfig {
  /** The node-brief authority's own dependencies, bound by the server exactly as elsewhere. */
  readonly brief: NodeBriefDeps;
  /** From a successful production `selectProjectConfiguration(...).manifest.settingsDigest`. */
  readonly expectedConfigurationDigest: string;
  /** The durable profile revision the runtime observation is read by identity under. */
  readonly profileRevisionId: string;
  readonly projectId: string; readonly store: SqliteEventStore;
}

const HEX64 = /^[0-9a-f]{64}$/u;
function refuse(
  code: FoundationContextSealCode, detail: string,
  upstream: FoundationContextSealUpstream | null = null,
): FoundationContextSealRefusal {
  return Object.freeze({ code, detail, layer: LAYER, ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }) });
}

/** The upstream verdict's own code and layer, copied field by field so nothing else travels. */
const carry = (source: { readonly code: string; readonly layer: string }):
FoundationContextSealUpstream => ({ code: source.code, layer: source.layer });

/**
 * Bind a server to its services ONCE. The composition, render, digest, commit and re-read all
 * happen inside `prepareFoundationContextForLaunch`; this narrows its answer and forwards its
 * refusal with the refusing layer intact.
 */
export function createFoundationContextSealPort(
  services: FoundationContextSealServices,
): FoundationContextSealPort {
  const bound = Object.freeze({ ...services });

  function seal(
    identity: FoundationContextSealIdentity, decidedAt: string,
  ): FoundationContextSealResult {
    // The identity is forwarded UNREAD to the authority's own four-key admission. A second
    // admission here would drift from it, and the second is where a fifth key gets ignored
    // rather than refused.
    const prepared = prepareFoundationContextForLaunch({ ...bound, decidedAt }, {
      attemptRef: identity.attemptRef, nodeKey: identity.nodeKey,
      projectId: identity.projectId, sessionId: identity.sessionId,
    });
    if (!prepared.ok) {
      return refuse("FOUNDATION_CONTEXT_SEAL_REFUSED", prepared.detail, carry(prepared));
    }
    // COPIED, NEVER COMPUTED OR REBUILT: durable digest/bytes and the prepared template.
    return Object.freeze({
      bytes: prepared.record.manifest.binding.exactBytes,
      contextManifestDigest: prepared.record.manifest.digest,
      ok: true as const,
      template: prepared.template,
    });
  }

  return Object.freeze({ sealFoundationContext: seal });
}

/**
 * THE THREE runtime facts the launch-template producer admits, projected out of the durable
 * observation, which carries more — freshness, pinning method, resolved closure. The producer's
 * exact-keys gate refuses those, so the projection is the contract, not a convenience.
 */
function runtimeFactsOf(config: FoundationContextSealConfig): unknown {
  const read = readCurrentRuntimeObservation(
    config.store as unknown as ProjectConfigurationStore, config.projectId,
    config.profileRevisionId);
  if (!read.ok) return null;
  const { observation } = read;
  return Object.freeze({
    adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
    platformIdentity: observation.platformIdentity,
    reportedVersion: observation.reportedVersion,
  });
}

/**
 * THE PRODUCTION DERIVATION. Every fact is read from the server's own durable world or bound at
 * construction; none is a request field, which is how a caller would otherwise choose the
 * context it is judged against. A server that cannot answer one REFUSES under that fact's own
 * code — never seals with a substitute.
 *
 * THE PROFILE AND THE OBSERVATION ARE READ PER SEAL, NOT AT CONSTRUCTION, for the same reason
 * `NodeBriefDeps.repositoryScope` is a thunk: a daemon that started before the provider probe
 * landed would otherwise hold a port that refuses FOREVER, long after the durable fact it
 * needed arrived. Read per call, that daemon refuses until the probe lands and then seals.
 */
export function createDurableFoundationContextSealPort(
  config: FoundationContextSealConfig,
): FoundationContextSealPort {
  const bound = Object.freeze({ ...config });

  function seal(
    identity: FoundationContextSealIdentity, decidedAt: string,
  ): FoundationContextSealResult {
    if (!HEX64.test(bound.expectedConfigurationDigest)) {
      return refuse("FOUNDATION_CONTEXT_SEAL_CONFIGURATION_UNBOUND",
        "the server is bound to no accepted configuration digest");
    }
    const profile = resolveCurrentProviderProfile(bound.store, {
      expectedConfigurationDigest: bound.expectedConfigurationDigest,
      projectId: bound.projectId,
    });
    if (!profile.ok) {
      return refuse("FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE",
        "no durable provider profile answers for this project", carry(profile));
    }
    const observation = runtimeFactsOf(bound);
    if (observation === null) {
      return refuse("FOUNDATION_CONTEXT_SEAL_RUNTIME_UNOBSERVED",
        "the installed runtime was never durably observed");
    }
    return createFoundationContextSealPort({
      brief: bound.brief, capabilities: (): unknown => profile,
      context: createFoundationContextAuthority({
        expectedConfigurationDigest: bound.expectedConfigurationDigest, store: bound.store,
      }),
      ledger: bound.store, observation: (): unknown => observation, readPort: bound.store,
    }).sealFoundationContext(identity, decidedAt);
  }

  return Object.freeze({ sealFoundationContext: seal });
}

/**
 * The port a daemon composes when it holds no seal authority at all. It REFUSES rather than
 * sealing: launching with no server-derived context recorded is the hole this seam closes.
 */
export function unconfiguredFoundationContextSealPort(): FoundationContextSealPort {
  return Object.freeze({
    sealFoundationContext: (): FoundationContextSealResult => refuse(
      "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED",
      "no context seal authority is composed for this daemon"),
  });
}

/**
 * THE STRICT READBACK, re-exported under this seam's own name so the consumer reads one
 * surface. Every member of the expected binding is compared INDEPENDENTLY: a record that
 * decodes cleanly but describes another attempt, session, graph epoch or configuration digest
 * is evidence about something else, and is refused rather than adopted. No UNKNOWN is ever
 * replaced by a computed stand-in — an unverifiable read answers with its code, its layer and
 * no record at all.
 */
export function readSealedFoundationContext(
  port: FoundationContextReadPort,
  identity: FoundationContextSlotIdentity,
  expectedBinding: FoundationContextExpectedBinding,
): FoundationContextStrictResult {
  return readFoundationContextManifest(port, identity, expectedBinding);
}
