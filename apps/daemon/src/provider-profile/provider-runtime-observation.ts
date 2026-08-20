/**
 * The daemon-owned `moe-claude-runtime-observation/1` record: what a durable provider RUNTIME
 * observation is, and the only code that turns caller-shaped input into one.
 *
 * An observation is EVIDENCE about a host at a moment — never operator-configured authority and
 * never model identity. Two things follow by construction. Admission is EXACT-RECORD: an
 * unknown key refuses rather than being dropped, because a dropped key is a fact the observer
 * believes they reported. And `observationDigest` is RECOMPUTED here over the runner's own
 * exported preimage and refused when the caller's copy disagrees, so no probe can vouch for its
 * own closure, its own version or its own platform.
 *
 * The canonical form is sorted-key JSON, so an identical re-probe reproduces identical bytes
 * and the registration seam's immutability rule compares content rather than key order.
 */

import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { CLAUDE_RUNTIME_OBSERVATION_VERSION, observationDigestInput } from "@moe/runner";
import type { ProviderRuntimeObservation } from "@moe/runner";

import { canonicalJson, hasExactKeys, isRecord } from "./provider-profile-fields.js";
import {
  MAX_OBSERVATION_BYTES,
  OBSERVATION_BODY_KEYS,
  OBSERVATION_ENCODED_KEYS,
  admittedClosure,
  admittedFreshness,
  admittedHex64,
  admittedObservationTruth,
  admittedPinningMethod,
  admittedPlatform,
  admittedReportedVersion,
} from "./provider-runtime-observation-fields.js";

export type { ProviderRuntimeObservation } from "@moe/runner";

export const PROVIDER_RUNTIME_OBSERVATION_CODEC_CODES = Object.freeze([
  "PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID",
  "PROVIDER_RUNTIME_OBSERVATION_VERSION_UNSUPPORTED",
  "PROVIDER_RUNTIME_OBSERVATION_NONCANONICAL",
  "PROVIDER_RUNTIME_OBSERVATION_DIGEST_MISMATCH",
  "PROVIDER_RUNTIME_OBSERVATION_TOO_LARGE",
] as const);

/**
 * Module-private on purpose, exported only as a closed TYPE. An exported column-zero `*_LAYER`
 * constant is a declared production boundary the security roster then demands a
 * BEFORE/AFTER/RACE hostile trio for. Same decision as the profile codec seam beside it.
 */
const OBSERVATION_CODEC_LAYER = "PROVIDER_RUNTIME_OBSERVATION_CODEC";

export type ProviderRuntimeObservationCodecLayer = typeof OBSERVATION_CODEC_LAYER;
export type ProviderRuntimeObservationCodecCode =
  (typeof PROVIDER_RUNTIME_OBSERVATION_CODEC_CODES)[number];

export interface ProviderRuntimeObservationIssue {
  readonly code: ProviderRuntimeObservationCodecCode;
  readonly layer: ProviderRuntimeObservationCodecLayer;
  readonly message: string;
}

export type ProviderRuntimeObservationAdmission =
  | { readonly ok: true; readonly observation: ProviderRuntimeObservation }
  | { readonly ok: false; readonly issue: ProviderRuntimeObservationIssue };

/** The validated body, minus the one field only this module may stamp. */
export type ProviderRuntimeObservationBody = Omit<ProviderRuntimeObservation, "observationDigest">;

const encoder = new TextEncoder();
/** Fatal: mis-encoded bytes must refuse rather than become U+FFFD and admit as text. */
const decoder = new TextDecoder("utf-8", { fatal: true });

function refusal(
  code: ProviderRuntimeObservationCodecCode,
  message: string,
): ProviderRuntimeObservationAdmission {
  return Object.freeze({
    issue: Object.freeze({ code, layer: OBSERVATION_CODEC_LAYER, message }),
    ok: false as const,
  });
}

export function admittedObservationBody(value: unknown): ProviderRuntimeObservationBody | null {
  if (!hasExactKeys(value, OBSERVATION_BODY_KEYS)) return null;
  if (value.observationVersion !== CLAUDE_RUNTIME_OBSERVATION_VERSION) return null;
  if (value.providerId !== "claude") return null;
  const adapterCapabilitySchemaDigest = admittedHex64(value.adapterCapabilitySchemaDigest);
  const freshness = admittedFreshness(value.freshness);
  const pinningMethod = admittedPinningMethod(value.pinningMethod);
  const platformIdentity = admittedPlatform(value.platformIdentity);
  const resolvedRuntimeClosure = admittedClosure(value.resolvedRuntimeClosure);
  const truthClass = admittedObservationTruth(value.truthClass);
  const version = admittedReportedVersion(value.reportedVersion);
  if (adapterCapabilitySchemaDigest === null || freshness === null) return null;
  if (pinningMethod === null || platformIdentity === null) return null;
  if (resolvedRuntimeClosure === null || truthClass === null || version === null) return null;
  return {
    adapterCapabilitySchemaDigest,
    freshness,
    observationVersion: CLAUDE_RUNTIME_OBSERVATION_VERSION,
    pinningMethod,
    platformIdentity,
    providerId: "claude",
    reportedVersion: version.text,
    resolvedRuntimeClosure,
    truthClass,
  };
}

/**
 * The digest preimage is the RUNNER's exported `observationDigestInput`, not a field list
 * restated here: a preimage this module built itself would authenticate nothing but this
 * module, and would drift the moment the observation contract gained a field.
 */
function sealed(body: ProviderRuntimeObservationBody): ProviderRuntimeObservation {
  const observationDigest = createHash("sha256")
    .update(canonicalJson(observationDigestInput(body)), "utf8")
    .digest("hex");
  const observation = { ...body, observationDigest };
  Object.freeze(observation.freshness);
  Object.freeze(observation.platformIdentity);
  Object.freeze(observation.resolvedRuntimeClosure);
  return Object.freeze(observation);
}

function bodyOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of OBSERVATION_BODY_KEYS) body[key] = parsed[key];
  return body;
}

/**
 * Admission for an observation section that arrives inside a probe envelope, digest included.
 * The caller's `observationDigest` is COMPARED against the recomputation, never adopted.
 */
export function admitProviderRuntimeObservation(
  value: unknown,
): ProviderRuntimeObservationAdmission {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_ENCODED_KEYS)) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID", "not an exact observation record");
  }
  const version = value.observationVersion;
  if (typeof version === "string" && version !== CLAUDE_RUNTIME_OBSERVATION_VERSION) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_VERSION_UNSUPPORTED", `unsupported ${version}`);
  }
  const claimed = admittedHex64(value.observationDigest);
  const body = admittedObservationBody(bodyOf(value));
  if (body === null || claimed === null) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID", "observation is not admissible");
  }
  const resealed = sealed(body);
  if (resealed.observationDigest !== claimed) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_DIGEST_MISMATCH", "digest does not recompute");
  }
  const bytes = encodeProviderRuntimeObservationBytes(resealed).byteLength;
  if (bytes > MAX_OBSERVATION_BYTES) {
    return refusal(
      "PROVIDER_RUNTIME_OBSERVATION_TOO_LARGE",
      `canonical bytes ${bytes} exceed the durable bound ${MAX_OBSERVATION_BYTES}`,
    );
  }
  return Object.freeze({ observation: resealed, ok: true as const });
}

export function encodeProviderRuntimeObservationBytes(
  observation: ProviderRuntimeObservation,
): Uint8Array {
  return encoder.encode(canonicalJson(observation));
}

/**
 * The exact bytes as text, so canonicality is judged against what arrived, not a re-parse.
 *
 * The size ceiling is deliberately NOT re-stated here. It is enforced once, in admission, so the
 * write path and the read path cannot disagree about what fits: a section this daemon accepted is
 * a section this daemon can read back. A second copy of the bound here is how they drifted apart.
 * `decodeBoundedJsonBytes` below still bounds the parse itself.
 */
function textOf(input: unknown): string | null {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) return null;
  try {
    return decoder.decode(input);
  } catch {
    return null;
  }
}

/**
 * The durable read path. Canonicality is a SEPARATE answer from admissibility: a row that
 * decodes to the right facts but not to the canonical bytes is corrupt evidence, not a valid
 * observation with a formatting quirk.
 */
export function decodeProviderRuntimeObservationBytes(
  input: unknown,
): ProviderRuntimeObservationAdmission {
  const text = textOf(input);
  const decoded = decodeBoundedJsonBytes(input);
  if (text === null || !decoded.ok || !isRecord(decoded.value)) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID", "bytes are not a bounded record");
  }
  const admitted = admitProviderRuntimeObservation(decoded.value);
  if (!admitted.ok) return admitted;
  if (canonicalJson(admitted.observation) !== text) {
    return refusal("PROVIDER_RUNTIME_OBSERVATION_NONCANONICAL", "bytes are not canonical");
  }
  return admitted;
}
