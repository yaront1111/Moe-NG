/**
 * Immutable cutover marker codecs. `/1` remains readable for forensic history, but only `/2`
 * carries the readiness binding required by the v2 authority gate.
 */
import { createHash } from "node:crypto";

import { RUNTIME_LIFECYCLES, createRuntimeError, decodeBoundedJsonBytes } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import type { CutoverState } from "@moe/core";

export const LEGACY_CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION =
  "moe-cutover-activation-marker/1" as const;
export const CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION =
  "moe-cutover-activation-marker/2" as const;

export const LEGACY_CUTOVER_ACTIVATION_MARKER_EVENT_TYPE =
  "CutoverActivationMarkerWritten" as const;
export const CUTOVER_ACTIVATION_MARKER_EVENT_TYPE =
  "CutoverActivationMarkerV2Written" as const;

export const CUTOVER_ACTIVATION_MARKER_KEYS = Object.freeze([
  "activatedAtEpochMs",
  "generations",
  "readinessManifestSha256",
  "readinessManifestVersion",
  "schemaVersion",
  "sourceCommit",
] as const);
export const LEGACY_CUTOVER_ACTIVATION_MARKER_KEYS = Object.freeze([
  "activatedAtEpochMs", "generations", "schemaVersion", "sourceCommit",
] as const);

export const CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES = Object.freeze([
  "INPUT_INVALID",
  "ILLEGAL_TRANSITION",
  "CUTOVER_STATE_INVALID",
] as const);

const CUTOVER_ACTIVATION_MARKER_LAYER = "CUTOVER_ACTIVATION_MARKER" as const;
const CUTOVER_STATE_SET: ReadonlySet<string> = new Set(RUNTIME_LIFECYCLES.CUTOVER);
const HEX64 = /^[0-9a-f]{64}$/u;
const COMMIT40 = /^[0-9a-f]{40}$/u;

export interface CutoverActivationGenerations {
  readonly backupGenerationDigest: string;
  readonly distributionManifestSha256: string;
  readonly importGenerationSha256: string;
  readonly quiesceRecordSha256: string;
}

export interface CutoverActivationMarkerInput {
  readonly activatedAtEpochMs: number;
  readonly generations: CutoverActivationGenerations;
  readonly readinessManifestSha256: string;
  readonly readinessManifestVersion: number;
  readonly sourceCommit: string;
  readonly sourceState: CutoverState;
}

export interface LegacyCutoverActivationMarker {
  readonly activatedAtEpochMs: number;
  readonly generations: CutoverActivationGenerations;
  readonly schemaVersion: typeof LEGACY_CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION;
  readonly sourceCommit: string;
}

export interface CutoverActivationMarker {
  readonly activatedAtEpochMs: number;
  readonly generations: CutoverActivationGenerations;
  readonly readinessManifestSha256: string;
  readonly readinessManifestVersion: number;
  readonly schemaVersion: typeof CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION;
  readonly sourceCommit: string;
}

export interface CutoverActivationMarkerAccepted {
  readonly marker: CutoverActivationMarker;
  readonly ok: true;
}

export interface LegacyCutoverActivationMarkerAccepted {
  readonly marker: LegacyCutoverActivationMarker;
  readonly ok: true;
}

export interface CutoverActivationMarkerRefused {
  readonly error: RuntimeError;
  readonly layer: typeof CUTOVER_ACTIVATION_MARKER_LAYER;
  readonly ok: false;
}

export type CutoverActivationMarkerResult =
  | CutoverActivationMarkerAccepted
  | CutoverActivationMarkerRefused;
export type LegacyCutoverActivationMarkerResult =
  | LegacyCutoverActivationMarkerAccepted
  | CutoverActivationMarkerRefused;

function refused(error: RuntimeError): CutoverActivationMarkerRefused {
  return Object.freeze({ error, layer: CUTOVER_ACTIVATION_MARKER_LAYER, ok: false as const });
}

function inputInvalid(): CutoverActivationMarkerRefused {
  return refused(createRuntimeError({ code: "INPUT_INVALID" }));
}

function illegal(sourceState: CutoverState): CutoverActivationMarkerRefused {
  return refused(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: {
      aggregateKind: "CUTOVER",
      commandKind: "cutover.activate",
      sourceState,
    },
    source: { aggregate: "CUTOVER", state: sourceState },
  }));
}

function stateInvalid(sourceState: CutoverState): CutoverActivationMarkerRefused {
  return refused(createRuntimeError({
    code: "CUTOVER_STATE_INVALID",
    details: { sourceState },
    source: { aggregate: "CUTOVER", state: sourceState },
  }));
}

const GENERATION_KEYS = Object.freeze([
  "backupGenerationDigest",
  "distributionManifestSha256",
  "importGenerationSha256",
  "quiesceRecordSha256",
] as const);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validGenerations(value: unknown): value is CutoverActivationGenerations {
  return exactKeys(value, GENERATION_KEYS)
    && GENERATION_KEYS.every((key) => typeof value[key] === "string" && HEX64.test(value[key]));
}

function freezeGenerations(value: CutoverActivationGenerations): CutoverActivationGenerations {
  return Object.freeze({
    backupGenerationDigest: value.backupGenerationDigest,
    distributionManifestSha256: value.distributionManifestSha256,
    importGenerationSha256: value.importGenerationSha256,
    quiesceRecordSha256: value.quiesceRecordSha256,
  });
}

/** Snapshots already-admitted evidence and one already-read durable readiness identity. */
export function composeCutoverActivationMarker(
  input: CutoverActivationMarkerInput,
): CutoverActivationMarkerResult {
  const sourceState: unknown = input.sourceState;
  if (typeof sourceState !== "string" || !CUTOVER_STATE_SET.has(sourceState)) return inputInvalid();
  const lifecycle = sourceState as CutoverState;
  if (lifecycle !== "ACTIVATE_APPROVED") return illegal(lifecycle);
  if (!Number.isSafeInteger(input.activatedAtEpochMs) || input.activatedAtEpochMs < 0) {
    return stateInvalid(lifecycle);
  }
  if (!validGenerations(input.generations) || !COMMIT40.test(input.sourceCommit)
    || !HEX64.test(input.readinessManifestSha256)
    || !Number.isSafeInteger(input.readinessManifestVersion)
    || input.readinessManifestVersion <= 0) return inputInvalid();
  const marker: CutoverActivationMarker = Object.freeze({
    activatedAtEpochMs: input.activatedAtEpochMs,
    generations: freezeGenerations(input.generations),
    readinessManifestSha256: input.readinessManifestSha256,
    readinessManifestVersion: input.readinessManifestVersion,
    schemaVersion: CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION,
    sourceCommit: input.sourceCommit,
  });
  return Object.freeze({ marker, ok: true as const });
}

const LEGACY_MARKER_AGGREGATE_NAMESPACE = "cutover-activation-marker.v1|aggregate|";
const MARKER_AGGREGATE_NAMESPACE = "cutover-activation-marker.v2|aggregate|";
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;

function aggregateId(namespace: string, projectId: string): string {
  const direct = `${namespace}${projectId.length}:${projectId}`;
  if (Buffer.byteLength(direct, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return direct;
  const digest = createHash("sha256").update(direct, "utf8").digest("hex");
  return `${namespace}sha256:${digest}`;
}

export function deriveLegacyCutoverActivationMarkerAggregateId(projectId: string): string {
  return aggregateId(LEGACY_MARKER_AGGREGATE_NAMESPACE, projectId);
}

export function deriveCutoverActivationMarkerAggregateId(projectId: string): string {
  return aggregateId(MARKER_AGGREGATE_NAMESPACE, projectId);
}

function generationsForBytes(generations: CutoverActivationGenerations): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of GENERATION_KEYS) ordered[key] = generations[key];
  return ordered;
}

export function encodeCutoverActivationMarker(marker: CutoverActivationMarker): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    activatedAtEpochMs: marker.activatedAtEpochMs,
    generations: generationsForBytes(marker.generations),
    readinessManifestSha256: marker.readinessManifestSha256,
    readinessManifestVersion: marker.readinessManifestVersion,
    schemaVersion: marker.schemaVersion,
    sourceCommit: marker.sourceCommit,
  }));
}

export function encodeLegacyCutoverActivationMarker(marker: LegacyCutoverActivationMarker): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    activatedAtEpochMs: marker.activatedAtEpochMs,
    generations: generationsForBytes(marker.generations),
    schemaVersion: marker.schemaVersion,
    sourceCommit: marker.sourceCommit,
  }));
}

function validMoment(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validLegacyGenerations(value: unknown): value is CutoverActivationGenerations {
  return exactKeys(value, GENERATION_KEYS)
    && GENERATION_KEYS.every((key) => typeof value[key] === "string");
}

function validV2Common(value: Readonly<Record<string, unknown>>): boolean {
  return validMoment(value["activatedAtEpochMs"])
    && validGenerations(value["generations"])
    && typeof value["sourceCommit"] === "string" && COMMIT40.test(value["sourceCommit"]);
}

function validLegacyCommon(value: Readonly<Record<string, unknown>>): boolean {
  return validMoment(value["activatedAtEpochMs"])
    && validLegacyGenerations(value["generations"])
    && typeof value["sourceCommit"] === "string";
}

/** `/2` only. Feeding `/1` bytes here is an INPUT_INVALID refusal, never authority. */
export function decodeCutoverActivationMarker(bytes: unknown): CutoverActivationMarkerResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exactKeys(decoded.value, CUTOVER_ACTIVATION_MARKER_KEYS)) return inputInvalid();
  const value = decoded.value;
  if (!validV2Common(value) || value["schemaVersion"] !== CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION
    || typeof value["readinessManifestSha256"] !== "string"
    || !HEX64.test(value["readinessManifestSha256"])
    || typeof value["readinessManifestVersion"] !== "number"
    || !Number.isSafeInteger(value["readinessManifestVersion"])
    || value["readinessManifestVersion"] <= 0) return inputInvalid();
  return Object.freeze({
    marker: Object.freeze({
      activatedAtEpochMs: value["activatedAtEpochMs"] as number,
      generations: freezeGenerations(value["generations"] as unknown as CutoverActivationGenerations),
      readinessManifestSha256: value["readinessManifestSha256"],
      readinessManifestVersion: value["readinessManifestVersion"],
      schemaVersion: CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION,
      sourceCommit: value["sourceCommit"] as string,
    }),
    ok: true as const,
  });
}

/** Forensic compatibility only; no authority reader calls this function. */
export function decodeLegacyCutoverActivationMarker(
  bytes: unknown,
): LegacyCutoverActivationMarkerResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exactKeys(decoded.value, LEGACY_CUTOVER_ACTIVATION_MARKER_KEYS)) {
    return inputInvalid();
  }
  const value = decoded.value;
  if (!validLegacyCommon(value)
    || value["schemaVersion"] !== LEGACY_CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION) {
    return inputInvalid();
  }
  return Object.freeze({
    marker: Object.freeze({
      activatedAtEpochMs: value["activatedAtEpochMs"] as number,
      generations: freezeGenerations(value["generations"] as unknown as CutoverActivationGenerations),
      schemaVersion: LEGACY_CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION,
      sourceCommit: value["sourceCommit"] as string,
    }),
    ok: true as const,
  });
}
