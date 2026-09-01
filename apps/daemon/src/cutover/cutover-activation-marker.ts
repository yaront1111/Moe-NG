/**
 * Immutable v2 authority marker material. This module composes bytes only: it performs no
 * admission, authority decision, lifecycle transition, or store write.
 */
import { createHash } from "node:crypto";

import { RUNTIME_LIFECYCLES, createRuntimeError, decodeBoundedJsonBytes } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import type { CutoverState } from "@moe/core";

export const CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION =
  "moe-cutover-activation-marker/1" as const;

/** The durable event type the marker is written as, on its OWN aggregate. */
export const CUTOVER_ACTIVATION_MARKER_EVENT_TYPE = "CutoverActivationMarkerWritten" as const;

export const CUTOVER_ACTIVATION_MARKER_KEYS = Object.freeze([
  "activatedAtEpochMs",
  "generations",
  "schemaVersion",
  "sourceCommit",
] as const);

export const CUTOVER_ACTIVATION_MARKER_REFUSAL_CODES = Object.freeze([
  "INPUT_INVALID",
  "ILLEGAL_TRANSITION",
  "CUTOVER_STATE_INVALID",
] as const);

const CUTOVER_ACTIVATION_MARKER_LAYER = "CUTOVER_ACTIVATION_MARKER" as const;
const CUTOVER_STATE_SET: ReadonlySet<string> = new Set(RUNTIME_LIFECYCLES.CUTOVER);

export interface CutoverActivationGenerations {
  readonly backupGenerationDigest: string;
  readonly distributionManifestSha256: string;
  readonly importGenerationSha256: string;
  readonly quiesceRecordSha256: string;
}

export interface CutoverActivationMarkerInput {
  readonly activatedAtEpochMs: number;
  readonly generations: CutoverActivationGenerations;
  readonly sourceCommit: string;
  readonly sourceState: CutoverState;
}

export interface CutoverActivationMarker {
  readonly activatedAtEpochMs: number;
  readonly generations: CutoverActivationGenerations;
  readonly schemaVersion: typeof CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION;
  readonly sourceCommit: string;
}

export interface CutoverActivationMarkerAccepted {
  readonly marker: CutoverActivationMarker;
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

/** Snapshots already-admitted evidence into the marker written beside the ACTIVE transition. */
export function composeCutoverActivationMarker(
  input: CutoverActivationMarkerInput,
): CutoverActivationMarkerResult {
  const sourceState: unknown = input.sourceState;
  if (typeof sourceState !== "string" || !CUTOVER_STATE_SET.has(sourceState)) {
    return inputInvalid();
  }
  const lifecycle = sourceState as CutoverState;
  if (lifecycle !== "ACTIVATE_APPROVED") return illegal(lifecycle);
  if (!Number.isSafeInteger(input.activatedAtEpochMs) || input.activatedAtEpochMs < 0) {
    return stateInvalid(lifecycle);
  }
  const marker: CutoverActivationMarker = Object.freeze({
    activatedAtEpochMs: input.activatedAtEpochMs,
    generations: Object.freeze({
      backupGenerationDigest: input.generations.backupGenerationDigest,
      distributionManifestSha256: input.generations.distributionManifestSha256,
      importGenerationSha256: input.generations.importGenerationSha256,
      quiesceRecordSha256: input.generations.quiesceRecordSha256,
    }),
    schemaVersion: CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION,
    sourceCommit: input.sourceCommit,
  });
  return Object.freeze({ marker, ok: true as const });
}

const MARKER_AGGREGATE_NAMESPACE = "cutover-activation-marker.v1|aggregate|";
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;
const GENERATION_KEYS = [
  "backupGenerationDigest",
  "distributionManifestSha256",
  "importGenerationSha256",
  "quiesceRecordSha256",
] as const;

/**
 * The marker lives on its own aggregate, NOT on the attempt's: the attempt reader folds every
 * event on its aggregate through `reduceCutover` and refuses any foreign event type, so a
 * marker written beside the transition there would make the attempt unreadable. Server-derived
 * from the project alone, so no caller can nominate where its own marker lands.
 */
export function deriveCutoverActivationMarkerAggregateId(projectId: string): string {
  const legacy = `${MARKER_AGGREGATE_NAMESPACE}${projectId.length}:${projectId}`;
  if (Buffer.byteLength(legacy, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return legacy;
  const digest = createHash("sha256").update(legacy, "utf8").digest("hex");
  return `${MARKER_AGGREGATE_NAMESPACE}sha256:${digest}`;
}

/** Key order is fixed here rather than left to insertion order, so the bytes are stable. */
export function encodeCutoverActivationMarker(marker: CutoverActivationMarker): Uint8Array {
  const generations: Record<string, string> = {};
  for (const key of GENERATION_KEYS) generations[key] = marker.generations[key];
  return new TextEncoder().encode(JSON.stringify({
    activatedAtEpochMs: marker.activatedAtEpochMs,
    generations,
    schemaVersion: marker.schemaVersion,
    sourceCommit: marker.sourceCommit,
  }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Reads a marker back out of durable bytes. A malformed or foreign record refuses INPUT_INVALID
 * rather than yielding a partial marker: a half-read marker would answer "v2 is authoritative"
 * on evidence nobody wrote.
 */
export function decodeCutoverActivationMarker(bytes: unknown): CutoverActivationMarkerResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exactKeys(decoded.value, CUTOVER_ACTIVATION_MARKER_KEYS)) return inputInvalid();
  const value = decoded.value;
  const generations = value["generations"];
  if (value["schemaVersion"] !== CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION
    || typeof value["sourceCommit"] !== "string"
    || typeof value["activatedAtEpochMs"] !== "number"
    || !Number.isSafeInteger(value["activatedAtEpochMs"]) || value["activatedAtEpochMs"] < 0
    || !exactKeys(generations, GENERATION_KEYS)
    || !GENERATION_KEYS.every((key) => typeof generations[key] === "string")) {
    return inputInvalid();
  }
  return Object.freeze({
    marker: Object.freeze({
      activatedAtEpochMs: value["activatedAtEpochMs"],
      generations: Object.freeze({
        backupGenerationDigest: generations["backupGenerationDigest"] as string,
        distributionManifestSha256: generations["distributionManifestSha256"] as string,
        importGenerationSha256: generations["importGenerationSha256"] as string,
        quiesceRecordSha256: generations["quiesceRecordSha256"] as string,
      }),
      schemaVersion: CUTOVER_ACTIVATION_MARKER_SCHEMA_VERSION,
      sourceCommit: value["sourceCommit"],
    }),
    ok: true as const,
  });
}
