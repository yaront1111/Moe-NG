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
  // The marker's STATE could not be established — a store throw, a duplicated or misplaced
  // marker event, a payload that will not decode, or a readiness manifest that cannot be read.
  // Never NOT_ACTIVE: that code claims the installation was never activated, and an operator
  // reading it goes looking for a re-cutover that cannot help. The fence is identical; only the
  // name is honest. See the lockout this file already records under `markerBindsCurrentReadiness`.
  "CUTOVER_V2_STATUS_UNKNOWN",
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
export interface CutoverV2NotActiveRefusal {
  readonly code: "CUTOVER_V2_NOT_ACTIVE";
  readonly layer: typeof CUTOVER_V2_AUTHORITY_LAYER;
  readonly ok: false;
}
export interface CutoverV2StatusUnknownRefusal {
  readonly code: "CUTOVER_V2_STATUS_UNKNOWN";
  readonly layer: typeof CUTOVER_V2_AUTHORITY_LAYER;
  readonly ok: false;
}
export type CutoverV2ActivationResult =
  | Readonly<{ marker: CutoverActivationMarker; ok: true }>
  | CutoverV2NotActiveRefusal
  | CutoverV2StatusUnknownRefusal;

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

function notActive(): CutoverV2NotActiveRefusal {
  return Object.freeze({
    code: "CUTOVER_V2_NOT_ACTIVE", layer: CUTOVER_V2_AUTHORITY_LAYER, ok: false as const,
  });
}

/** Grants exactly as little as `notActive`, and sends the operator to the store instead. */
function statusUnknown(): CutoverV2StatusUnknownRefusal {
  return Object.freeze({
    code: "CUTOVER_V2_STATUS_UNKNOWN", layer: CUTOVER_V2_AUTHORITY_LAYER, ok: false as const,
  });
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

/**
 * RECORDED pins, deliberately: this is the post-activation read. The marker binds the
 * manifest's digest, source commit and four generations, and those are compared exactly; the
 * static build pins were held to the running build when the manifest was written and when the
 * marker was activated. Holding them again here meant a build pin bump un-bound every marker:
 * v2 answered "not active", v1 answered "status unknown", and the activated project was locked
 * out of both planes with no in-band re-cutover.
 */
function markerBindsCurrentReadiness(
  store: CutoverMarkerStore,
  projectId: string,
  marker: CutoverActivationMarker,
): boolean {
  return readinessBinding(store, projectId, marker) === "BOUND";
}

/**
 * The same comparison, with its THREE answers kept apart. A readiness manifest that cannot be
 * read is not a manifest that disagrees: flattening both to `false` sent an unreadable manifest
 * down the NOT_ACTIVE arm, which is the second route into the lockout described above.
 */
function readinessBinding(
  store: CutoverMarkerStore,
  projectId: string,
  marker: CutoverActivationMarker,
): "BOUND" | "DIVERGED" | "UNREADABLE" {
  const readiness = readV2ReadinessManifest(store, { pins: "RECORDED", projectId });
  // ONLY the unreadable code. The manifest's other four refusals — ABSENT, INVALID,
  // NONCANONICAL, STATIC_PIN_MISMATCH — are facts about CONTENT that was successfully read, and
  // each of them genuinely leaves the installation un-activated.
  if (!readiness.ok) {
    return readiness.code === "V2_READINESS_MANIFEST_UNREADABLE" ? "UNREADABLE" : "DIVERGED";
  }
  return cutoverMarkerBindsReadiness(marker, readiness) ? "BOUND" : "DIVERGED";
}

export function admitV2AuthoritativeCommand(
  store: CutoverMarkerStore,
  input: Readonly<{ commandKind: string; projectId: string }>,
): CutoverV2AuthorityResult {
  if (!COMMAND_KIND_SET.has(input.commandKind)) return refuse("CUTOVER_V2_COMMAND_UNKNOWN");
  const activation = admitV2ActiveInstallation(store, { projectId: input.projectId });
  if (!activation.ok) return activation;
  return Object.freeze({
    commandKind: input.commandKind as V2MutationCommandKind,
    marker: activation.marker,
    ok: true as const,
  });
}

/** Shared activation fact for `/2` reads and rostered mutations. */
export function admitV2ActiveInstallation(
  store: CutoverMarkerStore,
  input: Readonly<{ projectId: string }>,
): CutoverV2ActivationResult {
  // READ THE STATE, not the collapsed marker: `readCutoverActivationMarker` folds ABSENT and
  // UNKNOWN into one null, and those are opposite facts about whether a cutover ever happened.
  const state = readMarkerState(store, input);
  if (state.kind === "UNKNOWN") return statusUnknown();
  if (state.kind === "ABSENT") return notActive();
  const bound = readinessBinding(store, input.projectId, state.marker);
  if (bound === "UNREADABLE") return statusUnknown();
  if (bound === "DIVERGED") return notActive();
  return Object.freeze({ marker: state.marker, ok: true as const });
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
