/**
 * The fail-closed v2 mutation gate. A command is v2-authoritative only when it belongs to the
 * exact Product Contract/compiler roster and a `/2` marker still binds the current durable
 * readiness manifest. `/1` markers are intentionally invisible here.
 */
import type { StoredEvent } from "@moe/store";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  decodeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
} from "./cutover-activation-marker.js";
import type { CutoverActivationMarker } from "./cutover-activation-marker.js";
import { readV2ReadinessManifest } from "./v2-readiness-manifest.js";
import type { V2ReadinessManifestPresent } from "./v2-readiness-manifest.js";
import {
  V2_MUTATION_COMMAND_KINDS,
} from "./v2-surface-manifest.js";
import type { V2MutationCommandKind } from "./v2-surface-manifest.js";

export const CUTOVER_V2_AUTHORITY_LAYER = "DAEMON_CUTOVER_V2_AUTHORITY" as const;

export const CUTOVER_V2_AUTHORITY_CODES = Object.freeze([
  "CUTOVER_V2_NOT_ACTIVE",
  "CUTOVER_V2_COMMAND_UNKNOWN",
] as const);

export type CutoverV2AuthorityCode = (typeof CUTOVER_V2_AUTHORITY_CODES)[number];

export interface CutoverV2AuthorityRefusal {
  readonly code: CutoverV2AuthorityCode;
  readonly layer: typeof CUTOVER_V2_AUTHORITY_LAYER;
  readonly ok: false;
}

export interface CutoverV2AuthorityAdmitted {
  readonly commandKind: V2MutationCommandKind;
  readonly marker: CutoverActivationMarker;
  readonly ok: true;
}

export type CutoverV2AuthorityResult = CutoverV2AuthorityAdmitted | CutoverV2AuthorityRefusal;

export const V1_AUTHORITY_RETIRED_CODE = "V1_AUTHORITY_RETIRED" as const;
export const V1_AUTHORITY_STATUS_UNKNOWN_CODE = "V1_AUTHORITY_STATUS_UNKNOWN" as const;
export type V1AuthorityResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      code: typeof V1_AUTHORITY_RETIRED_CODE | typeof V1_AUTHORITY_STATUS_UNKNOWN_CODE;
      layer: typeof CUTOVER_V2_AUTHORITY_LAYER;
      ok: false;
    }>;

export interface CutoverMarkerStore {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

const COMMAND_KIND_SET: ReadonlySet<string> = new Set(V2_MUTATION_COMMAND_KINDS);

type MarkerReadState =
  | Readonly<{ kind: "ABSENT" }>
  | Readonly<{ kind: "PRESENT"; marker: CutoverActivationMarker }>
  | Readonly<{ kind: "UNKNOWN" }>;

function readMarkerState(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): MarkerReadState {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(deriveCutoverActivationMarkerAggregateId(input.projectId));
  } catch {
    return Object.freeze({ kind: "UNKNOWN" as const });
  }
  if (events.length === 0) return Object.freeze({ kind: "ABSENT" as const });
  if (events.length !== 1) return Object.freeze({ kind: "UNKNOWN" as const });
  const event = events[0];
  if (event === undefined || event.eventType !== CUTOVER_ACTIVATION_MARKER_EVENT_TYPE
    || event.aggregateSequence !== 1) return Object.freeze({ kind: "UNKNOWN" as const });
  const decoded = decodeCutoverActivationMarker(event.payload);
  return decoded.ok
    ? Object.freeze({ kind: "PRESENT" as const, marker: decoded.marker })
    : Object.freeze({ kind: "UNKNOWN" as const });
}

function refuse(code: CutoverV2AuthorityCode): CutoverV2AuthorityRefusal {
  return Object.freeze({ code, layer: CUTOVER_V2_AUTHORITY_LAYER, ok: false as const });
}

/** Reads exactly one `/2` marker event. No `/1` namespace or decoder is reachable here. */
export function readCutoverActivationMarker(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): CutoverActivationMarker | null {
  const state = readMarkerState(store, input);
  return state.kind === "PRESENT" ? state.marker : null;
}

export function cutoverMarkerBindsReadiness(
  marker: CutoverActivationMarker,
  readiness: V2ReadinessManifestPresent,
): boolean {
  if (marker.readinessManifestSha256 !== readiness.digest
    || marker.readinessManifestVersion !== readiness.version
    || marker.sourceCommit !== readiness.manifest.sourceCommit) return false;
  const generations = marker.generations;
  const manifest = readiness.manifest;
  return generations.backupGenerationDigest === manifest.backupGenerationDigest
    && generations.distributionManifestSha256 === manifest.distributionManifestSha256
    && generations.importGenerationSha256 === manifest.importGenerationSha256
    && generations.quiesceRecordSha256 === manifest.quiesceRecordSha256;
}

function markerBindsCurrentReadiness(
  store: CutoverMarkerStore,
  projectId: string,
  marker: CutoverActivationMarker,
): boolean {
  const readiness = readV2ReadinessManifest(store, { projectId });
  return readiness.ok && cutoverMarkerBindsReadiness(marker, readiness);
}

export function admitV2AuthoritativeCommand(
  store: CutoverMarkerStore,
  input: Readonly<{ commandKind: string; projectId: string }>,
): CutoverV2AuthorityResult {
  if (!COMMAND_KIND_SET.has(input.commandKind)) return refuse("CUTOVER_V2_COMMAND_UNKNOWN");
  const marker = readCutoverActivationMarker(store, { projectId: input.projectId });
  if (marker === null || !markerBindsCurrentReadiness(store, input.projectId, marker)) {
    return refuse("CUTOVER_V2_NOT_ACTIVE");
  }
  return Object.freeze({
    commandKind: input.commandKind as V2MutationCommandKind,
    marker,
    ok: true as const,
  });
}

/**
 * The inverse fence for the forensic `/1` mutation plane. An absent, malformed,
 * stale, or readiness-divergent `/2` marker grants nothing and therefore leaves v1
 * active; only the exact current marker retires it.
 */
export function admitV1AuthoritativeCommand(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): V1AuthorityResult {
  const state = readMarkerState(store, input);
  if (state.kind === "ABSENT") return Object.freeze({ ok: true as const });
  if (state.kind === "UNKNOWN") return Object.freeze({
    code: V1_AUTHORITY_STATUS_UNKNOWN_CODE,
    layer: CUTOVER_V2_AUTHORITY_LAYER,
    ok: false as const,
  });
  let bound = false;
  try {
    bound = markerBindsCurrentReadiness(store, input.projectId, state.marker);
  } catch {
    bound = false;
  }
  if (!bound) return Object.freeze({
    code: V1_AUTHORITY_STATUS_UNKNOWN_CODE,
    layer: CUTOVER_V2_AUTHORITY_LAYER,
    ok: false as const,
  });
  return Object.freeze({
    code: V1_AUTHORITY_RETIRED_CODE,
    layer: CUTOVER_V2_AUTHORITY_LAYER,
    ok: false as const,
  });
}
