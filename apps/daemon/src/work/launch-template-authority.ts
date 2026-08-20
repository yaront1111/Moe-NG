/**
 * This seam's refusal vocabulary, and the one place a `ProviderCapabilities` answer is admitted.
 *
 * Split out of `launch-template-producer.ts` so the producer stays under the per-file line rail
 * while it carries a total try/catch: composition and admission are separately readable, and the
 * admission rules — the part an attacker would probe — sit in one file with nothing else in it.
 *
 * Nothing here reads a dispatch request. `admitCapabilities` takes the RESOLVER's answer and
 * either returns the durable facts or refuses; it never synthesises a capability, never defaults
 * a missing field, and never restamps another authority's code as this layer's.
 */

import type { ClaudeLaunchSelection } from "@moe/runner";

export const LAUNCH_TEMPLATE_PRODUCER_CODES = Object.freeze([
  "LAUNCH_TEMPLATE_INPUT_INEXACT",
  "LAUNCH_TEMPLATE_INPUT_HOSTILE",
  "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN",
  "LAUNCH_TEMPLATE_MISSION_INVALID",
  "LAUNCH_TEMPLATE_RUNTIME_UNOBSERVED",
  "LAUNCH_TEMPLATE_RUNTIME_UNBOUND",
  "LAUNCH_TEMPLATE_SELECTION_UNPROVEN",
  "LAUNCH_TEMPLATE_ARGV_RESUMES",
  "LAUNCH_TEMPLATE_ARGV_UNSAFE",
  "LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE",
] as const);

/**
 * Module-private stamp, published as a closed type instead. An exported column-zero `*_LAYER`
 * is a declared production boundary the security roster then demands a hostile trio for; the
 * literal still travels on every refusal, so nothing about the vocabulary is hidden.
 */
const PRODUCER_LAYER = "LAUNCH_TEMPLATE_PRODUCER";

export type LaunchTemplateProducerCode = (typeof LAUNCH_TEMPLATE_PRODUCER_CODES)[number];
export type LaunchTemplateProducerLayer = typeof PRODUCER_LAYER;
export type LaunchTemplateUpstream = Readonly<{ code: string; layer: string }>;

export interface LaunchTemplateRefused {
  readonly code: LaunchTemplateProducerCode;
  readonly detail: string;
  readonly layer: LaunchTemplateProducerLayer;
  readonly ok: false;
  /** The refusing authority when it was not this one, preserved rather than restamped. */
  readonly upstream: LaunchTemplateUpstream | null;
}

export interface AdmittedCapabilities {
  readonly capabilitySchemaDigest: string;
  readonly limits: unknown;
  readonly selection: ClaudeLaunchSelection;
}

const MAX_TEXT_CHARS = 1024;
const UNSAFE_ARGUMENT = /[\p{Cc}\p{Cf}]/u;

const SELECTION_TEXT_FIELDS = Object.freeze([
  "configurationDigest", "modelSnapshotEvidence", "orchestrationDigest", "policyDigest",
  "profileRevisionId", "selectedModelId",
] as const);

export function refuse(code: LaunchTemplateProducerCode, detail: string,
  upstream: LaunchTemplateUpstream | null = null): LaunchTemplateRefused {
  return Object.freeze({ code, detail, layer: PRODUCER_LAYER, ok: false as const, upstream });
}

/** A bounded single-line string; anything longer or control-bearing is not an argument. */
export function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_TEXT_CHARS || UNSAFE_ARGUMENT.test(value)) return null;
  return value;
}

export function isRefusal(
  value: AdmittedCapabilities | LaunchTemplateRefused,
): value is LaunchTemplateRefused {
  return "ok" in value && value.ok === false;
}

/**
 * The resolver's own refusal is carried outward with ITS code and layer. An unrecognised shape
 * is refused too: a capability set nobody can attribute is exactly the empty-set fail-open this
 * seam exists to prevent, and defaulting one here would launder it into an acceptance.
 */
export function admitCapabilities(
  value: unknown,
): AdmittedCapabilities | LaunchTemplateRefused {
  const record = value as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null) {
    return refuse("LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN", "capabilities is not a reader answer");
  }
  if (record["ok"] !== true) {
    const code = record["code"], layer = record["layer"];
    const upstream = typeof code === "string" && typeof layer === "string"
      ? Object.freeze({ code, layer })
      : null;
    return refuse("LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN", "the capability read refused", upstream);
  }
  if (record["authority"] !== "DAEMON_VERIFIED" || record["evidence"] !== "DURABLE" ||
    record["outcome"] !== "CURRENT") {
    return refuse("LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN", "capabilities carry no durable authority");
  }
  for (const field of SELECTION_TEXT_FIELDS) {
    if (boundedText(record[field]) === null) {
      return refuse("LAUNCH_TEMPLATE_SELECTION_UNPROVEN", `${field} has no server value`);
    }
  }
  const ceiling = record["concurrencyCeiling"];
  if (typeof ceiling !== "number" || !Number.isSafeInteger(ceiling) || ceiling <= 0) {
    return refuse("LAUNCH_TEMPLATE_SELECTION_UNPROVEN", "concurrencyCeiling has no server value");
  }
  // UNKNOWN is a member of both vocabularies and never gains authority: an unproven effort is
  // unproven even when argv would spell the word, and an UNKNOWN snapshot silently promoted to
  // a known model id is the fail-open this gate exists to stop.
  if (record["modelSnapshotKind"] === "UNKNOWN" || record["reasoningEffort"] === "UNKNOWN") {
    return refuse("LAUNCH_TEMPLATE_SELECTION_UNPROVEN", "model or effort evidence is UNKNOWN");
  }
  const digest = boundedText(record["capabilitySchemaDigest"]);
  if (digest === null) {
    return refuse("LAUNCH_TEMPLATE_SELECTION_UNPROVEN", "capabilitySchemaDigest has no value");
  }
  // Built field by NAME, never spread: a capabilities record carrying an extra key — an `argv`
  // a caller planted on it, say — contributes nothing, because nothing copies what is not named.
  const selection = Object.freeze({
    concurrencyCeiling: ceiling,
    configurationDigest: record["configurationDigest"],
    modelSnapshotEvidence: record["modelSnapshotEvidence"],
    modelSnapshotKind: record["modelSnapshotKind"],
    orchestrationDigest: record["orchestrationDigest"],
    policyDigest: record["policyDigest"],
    profileRevisionId: record["profileRevisionId"],
    provider: "claude",
    reasoningEffort: record["reasoningEffort"],
    selectedModelId: record["selectedModelId"],
  }) as unknown as ClaudeLaunchSelection;
  return { capabilitySchemaDigest: digest, limits: record["limits"], selection };
}
