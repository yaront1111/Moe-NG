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

export interface CutoverMarkerStore {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

const COMMAND_KIND_SET: ReadonlySet<string> = new Set(V2_MUTATION_COMMAND_KINDS);

function refuse(code: CutoverV2AuthorityCode): CutoverV2AuthorityRefusal {
  return Object.freeze({ code, layer: CUTOVER_V2_AUTHORITY_LAYER, ok: false as const });
}

/** Reads exactly one `/2` marker event. No `/1` namespace or decoder is reachable here. */
export function readCutoverActivationMarker(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): CutoverActivationMarker | null {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(deriveCutoverActivationMarkerAggregateId(input.projectId));
  } catch {
    return null;
  }
  if (events.length !== 1) return null;
  const event = events[0];
  if (event === undefined || event.eventType !== CUTOVER_ACTIVATION_MARKER_EVENT_TYPE
    || event.aggregateSequence !== 1) return null;
  const decoded = decodeCutoverActivationMarker(event.payload);
  return decoded.ok ? decoded.marker : null;
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
