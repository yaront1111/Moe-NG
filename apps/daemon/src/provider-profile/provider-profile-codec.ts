/**
 * The daemon-owned `moe-provider-profile/1` body: what a Claude provider profile IS, and the
 * only code that turns caller bytes into one.
 *
 * A profile is operator-configured durable authority, never a runtime observation, so three
 * things are true here by construction. Admission is EXACT-RECORD: an unknown key refuses
 * rather than being dropped, because a dropped key is a field the operator believes they set.
 * `schemaVersion` and `profileDigest` are stamped by this module and refused when a caller
 * proposes them, so no request can name its own version or vouch for its own bytes. And the
 * canonical form is sorted-key JSON, so two callers holding the same body produce identical
 * bytes and an identical digest without coordinating.
 *
 * Bounds here are STRUCTURAL only: positive safe integers and bounded text. This module never
 * asserts that a limit is launch-admissible against a runner ceiling. That judgement belongs
 * to the public runner validator, and copying a ceiling into this file would create a second
 * copy of it that drifts silently.
 */

import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { ProjectConfigurationLimitKey, ProjectConfigurationSelection } from "@moe/contracts";
import { CLAUDE_MODEL_EVIDENCE_KINDS, CLAUDE_REASONING_EFFORTS } from "@moe/runner";
import type { ClaudeModelEvidenceKind, ClaudeReasoningEffort } from "@moe/runner";

import {
  PROFILE_HEX64,
  admittedLimits,
  admittedSelection,
  boundedText,
  canonicalJson,
  hasExactKeys,
  isRecord,
  member,
  positiveCount,
} from "./provider-profile-fields.js";
import type { ProviderProfileLimits } from "./provider-profile-fields.js";

export type { ProviderProfileLimits } from "./provider-profile-fields.js";

export const PROVIDER_PROFILE_SCHEMA_VERSION = "moe-provider-profile/1";

export const PROVIDER_PROFILE_CODEC_CODES = Object.freeze([
  "PROVIDER_PROFILE_INPUT_INVALID",
  "PROVIDER_PROFILE_VERSION_UNSUPPORTED",
  "PROVIDER_PROFILE_NONCANONICAL",
  "PROVIDER_PROFILE_DIGEST_MISMATCH",
] as const);

export const PROVIDER_PROFILE_REGISTRATION_CODES = Object.freeze([
  "PROVIDER_PROFILE_REF_MISMATCH",
  "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
] as const);

/**
 * Each profile limit names the project-configuration limit key it governs. `stdoutBytes` and
 * `stderrBytes` deliberately share `capturedOutputBytes`: the configuration surface meters one
 * captured-output budget, and pretending there were two would let a profile claim headroom the
 * limit table never granted.
 */
export const PROVIDER_PROFILE_LIMIT_BINDINGS: Readonly<
  Record<string, ProjectConfigurationLimitKey>
> = Object.freeze({
  concurrencyCeiling: "activeProviderSessions",
  stderrBytes: "capturedOutputBytes",
  stdoutBytes: "capturedOutputBytes",
  tailBytes: "uiTailBytes",
  timeoutMs: "runnerAuthorizedMsPerAttempt",
});

/**
 * Layer names stay module-private and travel as closed TYPES. An exported column-zero
 * `*_LAYER` constant is a declared production boundary, which the security roster then demands
 * a BEFORE/AFTER/RACE hostile trio for, and this slice does not own that roster delta.
 */
const CODEC_LAYER = "PROVIDER_PROFILE_CODEC";
const REGISTRATION_LAYER = "PROVIDER_PROFILE_REGISTRATION";

export type ProviderProfileCodecLayer = typeof CODEC_LAYER;
export type ProviderProfileRegistrationLayer = typeof REGISTRATION_LAYER;
export type ProviderProfileLayer = ProviderProfileCodecLayer | ProviderProfileRegistrationLayer;
export type ProviderProfileCodecCode = (typeof PROVIDER_PROFILE_CODEC_CODES)[number];
export type ProviderProfileRegistrationCode = (typeof PROVIDER_PROFILE_REGISTRATION_CODES)[number];
export type ProviderProfileCode = ProviderProfileCodecCode | ProviderProfileRegistrationCode;

export interface ProviderProfileIssue {
  readonly code: ProviderProfileCode;
  readonly layer: ProviderProfileLayer;
  readonly message: string;
}

export interface ProviderProfileRevision {
  readonly capabilitySchemaDigest: string;
  readonly concurrencyCeiling: number;
  readonly limits: ProviderProfileLimits;
  readonly modelSnapshotEvidence: string;
  readonly modelSnapshotKind: ClaudeModelEvidenceKind;
  /** Server-computed sha256 over the canonical body; a caller-supplied value never enters. */
  readonly profileDigest: string;
  readonly profileRevisionId: string;
  readonly provider: "claude";
  readonly providerMinimumProfileRef: string;
  readonly reasoningEffort: ClaudeReasoningEffort;
  readonly schemaVersion: typeof PROVIDER_PROFILE_SCHEMA_VERSION;
  readonly selectedModelId: string;
  readonly selection: ProjectConfigurationSelection;
}

export type ProviderProfileAdmission =
  | { readonly ok: true; readonly revision: ProviderProfileRevision }
  | { readonly ok: false; readonly issue: ProviderProfileIssue };

/** The validated body, minus the two fields only this module may stamp. */
export type ProviderProfileBody = Omit<ProviderProfileRevision, "profileDigest" | "schemaVersion">;

const DRAFT_KEYS: readonly string[] = Object.freeze([
  "capabilitySchemaDigest", "concurrencyCeiling", "limits", "modelSnapshotEvidence",
  "modelSnapshotKind", "profileRevisionId", "provider", "providerMinimumProfileRef",
  "reasoningEffort", "selectedModelId", "selection",
]);
const ENCODED_KEYS: readonly string[] = Object.freeze([
  ...DRAFT_KEYS, "profileDigest", "schemaVersion",
]);
const MAX_PROFILE_BYTES = 16_384;
const encoder = new TextEncoder();
/** Fatal: mis-encoded bytes must refuse rather than become U+FFFD and admit as text. */
const decoder = new TextDecoder("utf-8", { fatal: true });

function refusal(code: ProviderProfileCodecCode, message: string): ProviderProfileAdmission {
  return Object.freeze({
    issue: Object.freeze({ code, layer: CODEC_LAYER, message }),
    ok: false as const,
  });
}

export function admittedProfileBody(value: unknown): ProviderProfileBody | null {
  if (!hasExactKeys(value, DRAFT_KEYS)) return null;
  const capabilitySchemaDigest = boundedText(value.capabilitySchemaDigest);
  const concurrencyCeiling = positiveCount(value.concurrencyCeiling);
  const limits = admittedLimits(value.limits);
  const modelSnapshotEvidence = boundedText(value.modelSnapshotEvidence);
  const modelSnapshotKind = member(value.modelSnapshotKind, CLAUDE_MODEL_EVIDENCE_KINDS);
  const profileRevisionId = boundedText(value.profileRevisionId);
  const providerMinimumProfileRef = boundedText(value.providerMinimumProfileRef);
  const reasoningEffort = member(value.reasoningEffort, CLAUDE_REASONING_EFFORTS);
  const selectedModelId = boundedText(value.selectedModelId);
  const selection = admittedSelection(value.selection);
  if (capabilitySchemaDigest === null || !PROFILE_HEX64.test(capabilitySchemaDigest)) return null;
  if (concurrencyCeiling === null || limits === null || selection === null) return null;
  if (modelSnapshotEvidence === null || modelSnapshotKind === null) return null;
  if (profileRevisionId === null || providerMinimumProfileRef === null) return null;
  if (reasoningEffort === null || selectedModelId === null) return null;
  if (value.provider !== "claude") return null;
  return {
    capabilitySchemaDigest, concurrencyCeiling, limits, modelSnapshotEvidence, modelSnapshotKind,
    profileRevisionId, provider: "claude", providerMinimumProfileRef, reasoningEffort,
    selectedModelId, selection,
  };
}

/** The digest preimage is the versioned body WITHOUT the digest, never the digest's own bytes. */
function sealed(body: ProviderProfileBody): ProviderProfileRevision {
  const versioned = { ...body, schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION } as const;
  const profileDigest = createHash("sha256").update(canonicalJson(versioned), "utf8").digest("hex");
  const revision = { ...versioned, profileDigest };
  Object.freeze(revision.limits);
  Object.freeze(revision.selection);
  return Object.freeze(revision);
}

export function admitProviderProfile(value: unknown): ProviderProfileAdmission {
  const body = admittedProfileBody(value);
  if (body === null) {
    return refusal("PROVIDER_PROFILE_INPUT_INVALID", "profile body is not an admissible record");
  }
  return Object.freeze({ ok: true as const, revision: sealed(body) });
}

export function encodeProviderProfileBytes(revision: ProviderProfileRevision): Uint8Array {
  return encoder.encode(canonicalJson(revision));
}

/** The exact bytes as text, so canonicality is judged against what arrived, not a re-parse. */
function textOf(input: unknown): string | null {
  if (!(input instanceof Uint8Array)) return null;
  if (input.byteLength === 0 || input.byteLength > MAX_PROFILE_BYTES) return null;
  try {
    return decoder.decode(input);
  } catch {
    return null;
  }
}

function bodyOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) body[key] = parsed[key];
  return body;
}

export function decodeProviderProfileBytes(input: unknown): ProviderProfileAdmission {
  const text = textOf(input);
  const decoded = decodeBoundedJsonBytes(input);
  if (text === null || !decoded.ok || !isRecord(decoded.value)) {
    return refusal("PROVIDER_PROFILE_INPUT_INVALID", "bytes are not a bounded JSON record");
  }
  const parsed = decoded.value as Record<string, unknown>;
  const version = parsed.schemaVersion;
  if (typeof version !== "string" || !hasExactKeys(parsed, ENCODED_KEYS)) {
    return refusal("PROVIDER_PROFILE_INPUT_INVALID", "encoded profile is not an exact record");
  }
  if (version !== PROVIDER_PROFILE_SCHEMA_VERSION) {
    return refusal("PROVIDER_PROFILE_VERSION_UNSUPPORTED", `unsupported version ${version}`);
  }
  const profileDigest = boundedText(parsed.profileDigest);
  const body = admittedProfileBody(bodyOf(parsed));
  if (body === null || profileDigest === null || !PROFILE_HEX64.test(profileDigest)) {
    return refusal("PROVIDER_PROFILE_INPUT_INVALID", "encoded profile body is not admissible");
  }
  const restated = { ...body, profileDigest, schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION };
  if (canonicalJson(restated) !== text) {
    return refusal("PROVIDER_PROFILE_NONCANONICAL", "bytes are not the canonical encoding");
  }
  const resealed = sealed(body);
  if (resealed.profileDigest !== profileDigest) {
    return refusal("PROVIDER_PROFILE_DIGEST_MISMATCH", "embedded digest does not recompute");
  }
  return Object.freeze({ ok: true as const, revision: resealed });
}
