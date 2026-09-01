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

import { CONTEXT_MANIFEST_VERSION, digestContextManifest } from "@moe/context";
import type { ContextDigestBinding, RenderedContext } from "@moe/context";
import type { ClaudeLaunchSelection } from "@moe/runner";

import { hasExactKeys } from "../provider-profile/provider-profile-fields.js";

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
  "LAUNCH_TEMPLATE_CONTEXT_INVALID",
  "LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED",
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

const RENDERED_CONTEXT_KEYS: readonly string[] = Object.freeze(["bytes", "manifest"]);
const CONTEXT_MANIFEST_KEYS: readonly string[] = Object.freeze([
  "binding", "digest", "version",
]);
/** The renderer's seven bound fields, named here so a manifest missing one cannot admit. */
const CONTEXT_BINDING_KEYS: readonly string[] = Object.freeze([
  "exactBytes", "exclusions", "journalCountLimit", "journalTextLimit", "optionalSelection",
  "ordering", "rendererVersion",
]);

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
 * OWN property, never `in`. Every admission in this seam returns EITHER a refusal this module
 * built or the CALLER'S OWN OBJECT, and `in` walks the prototype chain: a caller that plants
 * `ok` on a prototype passes `hasExactKeys` untouched — `Object.keys` reports own enumerable
 * keys only — and then answers `"ok" in value` with true. The composer would read that as "this
 * is a refusal, return it", and hand the caller's object back as the RESULT: `ok: true` and an
 * `argv` of its choosing, with argv composition, limits validation and the durable selection
 * all skipped. That is precisely the caller-proposed field this producer exists to refuse, so
 * the discriminator has to be one a prototype cannot reach.
 */
export function isOwnRefusal(value: object): value is LaunchTemplateRefused {
  return Object.prototype.hasOwnProperty.call(value, "ok");
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

/** Element-wise: both sides are `readonly number[]`, and `===` would pass a substituted copy. */
function sameBytes(left: unknown, right: readonly number[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return right.every((byte, index) => left[index] === byte);
}

/**
 * The one place rendered Foundation context is admitted into a launch.
 *
 * WHY A DIGEST RECOMPUTE AND NOT A SHAPE CHECK. `digestContextManifest` is the package's own
 * sealing function, and it is the only thing that can put a matching digest on a binding. A
 * context record this daemon hand-built, re-derived, or edited after the fact cannot carry a
 * digest that recomputes, so "the bytes came from the renderer" stops being a promise the
 * caller makes and becomes a property this function checks. That is what DoD-3 asks for, and
 * it is why the recompute imports from the BARE `@moe/context` rather than reimplementing a
 * sha256 here: a local copy of the derivation would be this seam re-deriving the authority it
 * is supposed to be checking against, and would keep matching after the package changed.
 *
 * WHAT IT DOES NOT PROVE, stated so no caller reads more into an acceptance than is there. The
 * recompute proves the value passed through the package's sealer. It does NOT prove the
 * SELECTION behind it was the attempt's own — a caller holding `@moe/context` can render a
 * selection it invented and seal that honestly. Binding a launch to a selection the store
 * actually recorded needs a persisted context manifest, which is task-203a5ca7's deliverable
 * and does not exist yet. Until it does, this admission is a forgery check, not a provenance
 * one, and `LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED` names exactly that boundary.
 *
 * The bytes are compared against `binding.exactBytes` SEPARATELY from the recompute, because
 * the two catch different attacks and neither implies the other: editing the binding breaks
 * the digest, while swapping only `bytes` leaves the digest matching and is caught solely by
 * this comparison.
 *
 * AN EMPTY RENDER ADMITS, and that is a decision rather than an oversight. Emptiness is the
 * RENDERER's verdict: a selection with no mandatory and no optional items is still something
 * `renderContext` sealed, and its digest recomputes like any other. Refusing it here would
 * invent a policy `@moe/context` does not have and would fail a launch whose attempt honestly
 * has no context to send. A caller that needs non-empty context must assert that where the
 * selection is made, not here.
 */
export function admitRenderedContext(
  value: unknown,
): RenderedContext | LaunchTemplateRefused {
  if (!hasExactKeys(value, RENDERED_CONTEXT_KEYS)) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_INVALID", "renderedContext is not a rendered record");
  }
  if (!hasExactKeys(value["manifest"], CONTEXT_MANIFEST_KEYS)) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_INVALID", "the context manifest is not the exact record");
  }
  const manifest = value["manifest"] as Record<string, unknown>;
  if (!hasExactKeys(manifest["binding"], CONTEXT_BINDING_KEYS)) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_INVALID", "the context binding is not the bound fields");
  }
  // Checked before the digest, and separately, because `digestContextManifest` seals the
  // CONSTANT version rather than the manifest's own field: a bumped version still recomputes to
  // the stored digest, so the recompute can never answer for it.
  if (manifest["version"] !== CONTEXT_MANIFEST_VERSION) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_INVALID", "the context manifest names another version");
  }
  const binding = manifest["binding"] as unknown as ContextDigestBinding;
  if (typeof manifest["digest"] !== "string"
    || digestContextManifest(binding) !== manifest["digest"]) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED", "the context digest does not recompute");
  }
  if (!sameBytes(value["bytes"], binding.exactBytes)) {
    return refuse("LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED", "the context bytes are not the bound bytes");
  }
  return value as unknown as RenderedContext;
}
