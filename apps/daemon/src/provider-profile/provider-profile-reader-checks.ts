/**
 * Reading the durable records the current-profile answer is built from, and deciding whether
 * they still bind to each other.
 *
 * Split out of the resolver purely for the per-file line cap; the seam is deliberate about
 * WHERE it cuts. Everything here reads durable evidence or compares two durable values.
 * Nothing here decides the shape of the caller's request or assembles the answer — that stays
 * with the entry point, so this module can never grow into a second admission surface.
 */

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { ProjectConfigurationLimitKey, ProjectConfigurationManifest } from "@moe/contracts";

import type { ProjectConfigurationStore } from "../configuration/project-configuration-selection.js";
import {
  PROVIDER_PROFILE_LIMIT_BINDINGS,
  decodeProviderProfileBytes,
} from "./provider-profile-codec.js";
import type { ProviderProfileRevision } from "./provider-profile-codec.js";
import { canonicalJson, isRecord } from "./provider-profile-fields.js";

export const PROVIDER_PROFILE_READER_CODES = Object.freeze([
  "PROVIDER_PROFILE_ABSENT",
  "PROVIDER_PROFILE_UNREADABLE",
  "PROVIDER_PROFILE_BINDING_MISMATCH",
  "PROVIDER_PROFILE_TRUTH_UNVERIFIED",
] as const);

/**
 * Module-private on purpose. An exported column-zero `*_LAYER` constant is a declared
 * production boundary, which the security roster then demands a BEFORE/AFTER/RACE hostile trio
 * for; the layer travels as a closed TYPE instead. Same decision as the codec seam.
 */
const READER_LAYER = "PROVIDER_PROFILE_READER";

export type ProviderProfileReaderLayer = typeof READER_LAYER;
export type ProviderProfileReaderCode = (typeof PROVIDER_PROFILE_READER_CODES)[number];
export type ProviderProfileReaderUpstream = Readonly<{ code: string; layer: string }>;

export interface ProviderProfileReaderUnknown {
  readonly authority: "NONE";
  readonly code: ProviderProfileReaderCode;
  /** Names the severed binding or the side whose truth failed, so a caller can act on it. */
  readonly detail: string;
  readonly layer: ProviderProfileReaderLayer;
  readonly ok: false;
  readonly outcome: "UNKNOWN";
  readonly upstream: ProviderProfileReaderUpstream | null;
}

/** Strong truth is DAEMON_VERIFIED or HUMAN_APPROVED; the other three classes are not evidence. */
export const STRONG_TRUTH: readonly string[] = Object.freeze([
  "DAEMON_VERIFIED",
  "HUMAN_APPROVED",
]);

const SELECTION_KEYS: readonly string[] = Object.freeze([
  "modelRef", "profileRef", "providerRef", "reasoningEffortRef",
  "runtimeRef", "snapshotRef", "structuredOutputSchemaRef",
]);
const PAGE_LIMIT = 1_000;
const encoder = new TextEncoder();

export function refuse(
  code: ProviderProfileReaderCode,
  detail: string,
  upstream: ProviderProfileReaderUpstream | null = null,
): ProviderProfileReaderUnknown {
  return Object.freeze({
    authority: "NONE" as const,
    code,
    detail,
    layer: READER_LAYER,
    ok: false as const,
    outcome: "UNKNOWN" as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/**
 * The latest committed event of one type on one aggregate, in a single forward pass.
 *
 * "UNREADABLE" is distinct from null: a stream whose current event does not decode is corrupt
 * evidence, which is a different answer from a stream that never carried the event at all.
 */
function latestPayload(
  store: ProjectConfigurationStore,
  aggregateId: string,
  eventType: string,
): Record<string, unknown> | "UNREADABLE" | null {
  let cursor = 0;
  let latest: Record<string, unknown> | "UNREADABLE" | null = null;
  for (;;) {
    const page = store.readAggregateEvents(aggregateId, cursor, PAGE_LIMIT);
    for (const event of page.items) {
      if (event.eventType !== eventType) continue;
      const decoded = decodeBoundedJsonBytes(event.payload);
      latest = decoded.ok && isRecord(decoded.value) ? decoded.value : "UNREADABLE";
    }
    if (!page.hasMore || page.nextCursor === null || page.nextCursor <= cursor) return latest;
    cursor = page.nextCursor;
  }
}

export interface ProbeRecord {
  /** The ref the PROBE ENVELOPE carried, kept distinct from the one inside the profile body. */
  readonly envelopeRef: string;
  readonly ok: true;
  readonly revision: ProviderProfileRevision;
  readonly truthClass: string;
}

export function readProbe(
  store: ProjectConfigurationStore,
  projectId: string,
): ProbeRecord | ProviderProfileReaderUnknown {
  const payload = latestPayload(store, `${projectId}-provider`, "ProviderProbed");
  if (payload === null) return refuse("PROVIDER_PROFILE_ABSENT", "no ProviderProbed record");
  if (payload === "UNREADABLE") {
    return refuse("PROVIDER_PROFILE_UNREADABLE", "ProviderProbed payload does not decode");
  }
  const { providerMinimumProfileRef, truthClass } = payload;
  if (typeof providerMinimumProfileRef !== "string" || typeof truthClass !== "string") {
    return refuse("PROVIDER_PROFILE_UNREADABLE", "ProviderProbed record lost its envelope facts");
  }
  // Re-canonicalised before decoding so the codec judges the operator's body, not a key order.
  const decoded = decodeProviderProfileBytes(encoder.encode(canonicalJson(payload.profile)));
  if (!decoded.ok) {
    return refuse("PROVIDER_PROFILE_UNREADABLE", "persisted profile does not decode", {
      code: decoded.issue.code,
      layer: decoded.issue.layer,
    });
  }
  return {
    envelopeRef: providerMinimumProfileRef,
    ok: true,
    revision: decoded.revision,
    truthClass,
  };
}

export interface WitnessRecord {
  readonly ok: true;
  readonly witness: Record<string, unknown>;
}

export function readWitness(
  store: ProjectConfigurationStore,
  projectId: string,
): WitnessRecord | ProviderProfileReaderUnknown {
  const payload = latestPayload(store, projectId, "ProjectActivated");
  if (payload === null) {
    return refuse("PROVIDER_PROFILE_ABSENT", "project is not durably activated");
  }
  if (payload === "UNREADABLE") {
    return refuse("PROVIDER_PROFILE_UNREADABLE", "ProjectActivated payload does not decode");
  }
  if (!isRecord(payload.witness)) {
    return refuse("PROVIDER_PROFILE_UNREADABLE", "ProjectActivated record carries no witness");
  }
  return { ok: true, witness: payload.witness };
}

/** Found BY KEY, never by position: the limit table is ordered, and an insertion would remap. */
function limitOf(
  manifest: ProjectConfigurationManifest,
  key: ProjectConfigurationLimitKey,
): number | null {
  const entry = manifest.settings.limits.find((candidate) => candidate.key === key);
  return entry === undefined ? null : entry.value;
}

/**
 * The first severed binding, in a fixed order, NAMED. Returning the name rather than a boolean
 * is what lets a caller — and a mutation drill — see which binding failed.
 */
export function severedBinding(
  probe: ProbeRecord,
  manifest: ProjectConfigurationManifest,
  witnessRef: unknown,
): string | null {
  const { revision } = probe;
  const selection = manifest.settings.selection as unknown as Record<string, string>;
  const configured = revision.selection as unknown as Record<string, string>;
  for (const key of SELECTION_KEYS) {
    if (configured[key] !== selection[key]) return `selection.${key}`;
  }
  if (revision.profileRevisionId !== selection.profileRef) return "profileRevisionId";
  // The minimum-ref TRIANGLE, all three legs. `provider.probe` makes the body-to-envelope leg
  // hold at write time, so only a corrupted or hand-written durable row can break it — which is
  // exactly the row this reader must not answer from.
  if (revision.providerMinimumProfileRef !== probe.envelopeRef) return "probeEnvelopeRef";
  if (revision.providerMinimumProfileRef !== witnessRef) return "providerMinimumProfileRef";
  const limits = revision.limits as unknown as Record<string, number>;
  for (const [field, limitKey] of Object.entries(PROVIDER_PROFILE_LIMIT_BINDINGS)) {
    const value = field === "concurrencyCeiling" ? revision.concurrencyCeiling : limits[field];
    const current = limitOf(manifest, limitKey);
    if (current === null || value !== current) {
      return field === "concurrencyCeiling" ? field : `limits.${field}`;
    }
  }
  return null;
}
