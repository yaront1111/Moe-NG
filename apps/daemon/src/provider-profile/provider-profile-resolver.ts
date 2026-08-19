/**
 * Who is the provider profile CURRENTLY in force for a project, and is it still bound to the
 * configuration, probe and activation the project is actually running under?
 *
 * This reader answers ORIGIN and CURRENTNESS. It never answers "are these numbers launchable":
 * the profile's limits are checked only for equality against the project-configuration entries
 * that granted them, never against a runner ceiling. Declaring a limit launch-admissible is the
 * public `@moe/runner` validator's job, and copying a ceiling into this file would create a
 * second copy of it that drifts silently away from the one that governs.
 *
 * Every binding is checked against a DURABLE record written by a production writer. The three
 * digests handed back are echoed from those records rather than recomputed here — a digest this
 * module derived itself would authenticate nothing but this module.
 */

import type { ProjectConfigurationManifest } from "@moe/contracts";
import type { ClaudeModelEvidenceKind, ClaudeReasoningEffort } from "@moe/runner";

import { readCurrentProjectConfiguration } from "../configuration/project-configuration-selection.js";
import type { ProjectConfigurationStore } from "../configuration/project-configuration-selection.js";
import type { ProviderProfileLimits, ProviderProfileRevision } from "./provider-profile-codec.js";
import {
  STRONG_TRUTH,
  readProbe,
  readWitness,
  refuse,
  severedBinding,
} from "./provider-profile-reader-checks.js";
import type { ProviderProfileReaderUnknown } from "./provider-profile-reader-checks.js";
import { hasExactKeys } from "./provider-profile-fields.js";

export {
  PROVIDER_PROFILE_READER_CODES,
} from "./provider-profile-reader-checks.js";
export type {
  ProviderProfileReaderCode,
  ProviderProfileReaderLayer,
  ProviderProfileReaderUnknown,
  ProviderProfileReaderUpstream,
} from "./provider-profile-reader-checks.js";

export interface ProviderCapabilities {
  readonly authority: "DAEMON_VERIFIED";
  readonly capabilitySchemaDigest: string;
  readonly concurrencyCeiling: number;
  /** Echoed from the durable manifest, never recomputed here. */
  readonly configurationDigest: string;
  readonly evidence: "DURABLE";
  readonly limits: ProviderProfileLimits;
  readonly modelSnapshotEvidence: string;
  readonly modelSnapshotKind: ClaudeModelEvidenceKind;
  readonly ok: true;
  /** Echoed from the durable configuration's orchestration source. */
  readonly orchestrationDigest: string;
  readonly outcome: "CURRENT";
  /** Echoed from the durable activation witness. */
  readonly policyDigest: string;
  readonly profileDigest: string;
  readonly profileRevisionId: string;
  readonly provider: "claude";
  readonly providerMinimumProfileRef: string;
  readonly reasoningEffort: ClaudeReasoningEffort;
  readonly selectedModelId: string;
}

export type ResolveCurrentProviderProfileResult =
  | ProviderCapabilities
  | ProviderProfileReaderUnknown;

const REQUEST_KEYS: readonly string[] = Object.freeze([
  "expectedConfigurationDigest",
  "projectId",
]);
const HEX64 = /^[0-9a-f]{64}$/u;

interface ResolverRequest {
  readonly expectedConfigurationDigest: string;
  readonly projectId: string;
}

/**
 * Exactly two keys. An extra key refuses rather than being ignored, which is what keeps a
 * dispatch request from smuggling an override past a reader that only reads durable authority.
 */
function exactRequest(value: unknown): ResolverRequest | null {
  if (!hasExactKeys(value, REQUEST_KEYS)) return null;
  const { expectedConfigurationDigest, projectId } = value;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof expectedConfigurationDigest !== "string") return null;
  if (!HEX64.test(expectedConfigurationDigest)) return null;
  return { expectedConfigurationDigest, projectId };
}

function capabilities(
  revision: ProviderProfileRevision,
  manifest: ProjectConfigurationManifest,
  policyDigest: string,
): ProviderCapabilities {
  return Object.freeze({
    authority: "DAEMON_VERIFIED" as const,
    capabilitySchemaDigest: revision.capabilitySchemaDigest,
    concurrencyCeiling: revision.concurrencyCeiling,
    configurationDigest: manifest.settingsDigest,
    evidence: "DURABLE" as const,
    limits: Object.freeze({ ...revision.limits }),
    modelSnapshotEvidence: revision.modelSnapshotEvidence,
    modelSnapshotKind: revision.modelSnapshotKind,
    ok: true as const,
    orchestrationDigest: manifest.settings.orchestrationSource.sourceSha,
    outcome: "CURRENT" as const,
    policyDigest,
    profileDigest: revision.profileDigest,
    profileRevisionId: revision.profileRevisionId,
    provider: revision.provider,
    providerMinimumProfileRef: revision.providerMinimumProfileRef,
    reasoningEffort: revision.reasoningEffort,
    selectedModelId: revision.selectedModelId,
  });
}

/**
 * Reads only, and states its isolation honestly rather than overclaiming it.
 *
 * Each aggregate is walked ONCE, forward, and never re-read after a decision has been taken on
 * it, so no single aggregate can be seen in two states within one answer. The configuration,
 * probe and activation aggregates are nonetheless read in sequence and this port offers no
 * cross-aggregate snapshot, so a writer committing between two of those reads can still be
 * straddled. That is bounded by what the answer is FOR: every binding is an equality against a
 * durable record, so a straddle can only turn an accepted answer into a refusal on the next
 * call, never mint an acceptance out of records that never agreed.
 */
export function resolveCurrentProviderProfile(
  store: ProjectConfigurationStore,
  input: unknown,
): ResolveCurrentProviderProfileResult {
  try {
    const request = exactRequest(input);
    if (request === null) {
      return refuse("PROVIDER_PROFILE_UNREADABLE", "request is not an exact resolver record");
    }
    const configuration = readCurrentProjectConfiguration(store, {
      projectId: request.projectId,
      expectedSettingsDigest: request.expectedConfigurationDigest,
    });
    if (!configuration.ok) {
      const upstream = { code: configuration.code, layer: configuration.layer };
      return configuration.code === "PROJECT_CONFIGURATION_ABSENT"
        ? refuse("PROVIDER_PROFILE_ABSENT", "project has no current configuration", upstream)
        : refuse("PROVIDER_PROFILE_UNREADABLE", "current configuration is not readable", upstream);
    }
    const probe = readProbe(store, request.projectId);
    if (!probe.ok) return probe;
    const activation = readWitness(store, request.projectId);
    if (!activation.ok) return activation;
    const { witness } = activation;
    const severed = severedBinding(
      probe,
      configuration.manifest,
      witness.providerMinimumProfileRef,
    );
    if (severed !== null) {
      return refuse("PROVIDER_PROFILE_BINDING_MISMATCH", `current records do not bind ${severed}`);
    }
    if (!STRONG_TRUTH.includes(probe.truthClass)) {
      return refuse(
        "PROVIDER_PROFILE_TRUTH_UNVERIFIED",
        `probe truth ${probe.truthClass} is not strong`,
      );
    }
    const witnessTruth = witness.truthClass;
    if (typeof witnessTruth !== "string" || !STRONG_TRUTH.includes(witnessTruth)) {
      return refuse(
        "PROVIDER_PROFILE_TRUTH_UNVERIFIED",
        `activation witness truth ${String(witnessTruth)} is not strong`,
      );
    }
    const policyDigest = witness.policyRevisionHash;
    if (typeof policyDigest !== "string" || !HEX64.test(policyDigest)) {
      return refuse("PROVIDER_PROFILE_UNREADABLE", "activation witness carries no policy digest");
    }
    return capabilities(probe.revision, configuration.manifest, policyDigest);
  } catch (error) {
    return refuse(
      "PROVIDER_PROFILE_UNREADABLE",
      `durable read failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}
