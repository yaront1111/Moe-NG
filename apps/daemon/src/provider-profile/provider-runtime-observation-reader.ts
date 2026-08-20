/**
 * Reading the runtime observation CURRENTLY on record for a project, bound to the probe
 * identity the caller names.
 *
 * This reader answers ORIGIN and CURRENTNESS and nothing else. It never decides that an
 * observation is launchable: `truthClass` — both the probe envelope's and the observation's own
 * — is echoed VERBATIM off the durable row, never widened, narrowed or upgraded. The resolver's
 * strong-truth gate remains the only authority filter in this family, and a reader that
 * promoted weak evidence here would silently move that gate into a place nobody audits.
 *
 * A record is answered only when it survives a round trip: the durable section is
 * re-canonicalised, decoded through the codec, and the codec's own re-encoding is compared BYTE
 * FOR BYTE against the section AS STORED. Answering without that comparison would hand back
 * whatever was written, which is exactly what a hand-written row wants.
 */

import type { ProjectConfigurationStore } from "../configuration/project-configuration-selection.js";
import { canonicalJson, isRecord } from "./provider-profile-fields.js";
import {
  decodeProviderRuntimeObservationBytes,
  encodeProviderRuntimeObservationBytes,
} from "./provider-runtime-observation.js";
import type { ProviderRuntimeObservation } from "./provider-runtime-observation.js";

export const PROVIDER_RUNTIME_OBSERVATION_READER_CODES = Object.freeze([
  "PROVIDER_RUNTIME_OBSERVATION_ABSENT",
  "PROVIDER_RUNTIME_OBSERVATION_UNREADABLE",
  "PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH",
] as const);

/** Module-private, travelling as a closed TYPE. Same decision as every seam in this family. */
const OBSERVATION_READER_LAYER = "PROVIDER_RUNTIME_OBSERVATION_READER";

export type ProviderRuntimeObservationReaderLayer = typeof OBSERVATION_READER_LAYER;
export type ProviderRuntimeObservationReaderCode =
  (typeof PROVIDER_RUNTIME_OBSERVATION_READER_CODES)[number];
export type ProviderRuntimeObservationUpstream = Readonly<{ code: string; layer: string }>;

export interface ProviderRuntimeObservationUnknown {
  readonly authority: "NONE";
  readonly code: ProviderRuntimeObservationReaderCode;
  /** Names the identity asked for or the reason the row is unreadable, so a caller can act. */
  readonly detail: string;
  readonly layer: ProviderRuntimeObservationReaderLayer;
  readonly ok: false;
  readonly outcome: "UNKNOWN";
  readonly upstream: ProviderRuntimeObservationUpstream | null;
}

export interface ProviderRuntimeObservationRecord {
  readonly observation: ProviderRuntimeObservation;
  readonly ok: true;
  /** The PROBE ENVELOPE's truth class, verbatim; distinct from `observation.truthClass`. */
  readonly probeTruthClass: string;
  readonly profileRevisionId: string;
}

export type ReadRuntimeObservationResult =
  | ProviderRuntimeObservationRecord
  | ProviderRuntimeObservationUnknown;

const PAGE_LIMIT = 1_000;
const PROBED_EVENT = "ProviderProbed";
const encoder = new TextEncoder();

function refuse(
  code: ProviderRuntimeObservationReaderCode,
  detail: string,
  upstream: ProviderRuntimeObservationUpstream | null = null,
): ProviderRuntimeObservationUnknown {
  return Object.freeze({
    authority: "NONE" as const,
    code,
    detail,
    layer: OBSERVATION_READER_LAYER,
    ok: false as const,
    outcome: "UNKNOWN" as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/**
 * The latest committed probe on one aggregate, in a single forward pass. "UNREADABLE" is
 * distinct from null: a stream whose current event does not decode is corrupt evidence, a
 * different answer from a stream that never carried the event at all.
 */
function latestProbe(
  store: ProjectConfigurationStore,
  aggregateId: string,
): Record<string, unknown> | "UNREADABLE" | null {
  let cursor = 0;
  let latest: Record<string, unknown> | "UNREADABLE" | null = null;
  for (;;) {
    const page = store.readAggregateEvents(aggregateId, cursor, PAGE_LIMIT);
    for (const event of page.items) {
      if (event.eventType !== PROBED_EVENT) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(event.payload));
      } catch {
        latest = "UNREADABLE";
        continue;
      }
      latest = isRecord(parsed) ? parsed : "UNREADABLE";
    }
    if (!page.hasMore || page.nextCursor === null || page.nextCursor <= cursor) return latest;
    cursor = page.nextCursor;
  }
}

/** The probe identity on record, taken from the profile section the probe seam wrote. */
function recordedIdentity(payload: Record<string, unknown>): string | null {
  const profile = payload.profile;
  if (!isRecord(profile)) return null;
  const revisionId = profile.profileRevisionId;
  return typeof revisionId === "string" && revisionId.length > 0 ? revisionId : null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function readCurrentRuntimeObservation(
  store: ProjectConfigurationStore,
  projectId: string,
  profileRevisionId: string,
): ReadRuntimeObservationResult {
  const payload = latestProbe(store, `${projectId}-provider`);
  if (payload === null) {
    return refuse("PROVIDER_RUNTIME_OBSERVATION_ABSENT", "no ProviderProbed record");
  }
  if (payload === "UNREADABLE") {
    return refuse("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE", "ProviderProbed does not decode");
  }
  const recorded = recordedIdentity(payload);
  if (recorded === null) {
    return refuse("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE", "probe carries no profile identity");
  }
  if (recorded !== profileRevisionId) {
    return refuse(
      "PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH",
      `probe on record is ${recorded}, not ${profileRevisionId}`,
    );
  }
  const probeTruthClass = payload.truthClass;
  if (typeof probeTruthClass !== "string" || probeTruthClass.length === 0) {
    return refuse("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE", "probe lost its envelope truth");
  }
  if (payload.runtime === undefined) {
    return refuse("PROVIDER_RUNTIME_OBSERVATION_ABSENT", "probe carries no runtime observation");
  }
  return decodedRecord(payload.runtime, probeTruthClass, recorded);
}

/**
 * Decoded from the RE-CANONICALISED section so the codec judges the observer's facts rather
 * than a key order, then compared as BYTES against the section AS STORED.
 *
 * Those are two different questions and both have to be asked. The codec's own canonicality
 * arm can only ever see the bytes this function handed it, so on its own it is satisfied by
 * construction here. What it cannot see is that the durable row was written in some other key
 * order — which the production writer never does, because it persists the encoder's own output.
 * A row that decodes to the right facts in the wrong order was hand-written, and answering from
 * it would let a row nobody wrote acquire the standing of one the probe seam produced.
 */
function decodedRecord(
  section: unknown,
  probeTruthClass: string,
  profileRevisionId: string,
): ReadRuntimeObservationResult {
  const decoded = decodeProviderRuntimeObservationBytes(encoder.encode(canonicalJson(section)));
  if (!decoded.ok) {
    return refuse(
      "PROVIDER_RUNTIME_OBSERVATION_UNREADABLE",
      "persisted observation does not decode",
      { code: decoded.issue.code, layer: decoded.issue.layer },
    );
  }
  const stored = encoder.encode(JSON.stringify(section));
  if (!bytesEqual(encodeProviderRuntimeObservationBytes(decoded.observation), stored)) {
    return refuse(
      "PROVIDER_RUNTIME_OBSERVATION_UNREADABLE",
      "persisted observation is not stored in its own canonical encoding",
    );
  }
  return Object.freeze({
    observation: decoded.observation,
    ok: true as const,
    probeTruthClass,
    profileRevisionId,
  });
}
